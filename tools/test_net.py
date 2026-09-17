# v0.10.0 net.js protocol test: drives the REAL client/src/net/net.js in V8
# against a fake WebSocket (records sent frames, feeds synthetic inbound
# frames as if a relay + a second peer were on the line). Covers the wire
# envelopes the real relay (tools/mca_relay.py, tested by test_relay.py)
# speaks: create/join, slot->host->lobby2 merge, cfg/start, pause/chat,
# nping/npong RTT, drop echo, error paths, leave/reset.
# Usage: .venv/Scripts/python test_net.py
import json
import re
import sys
from pathlib import Path

from py_mini_racer import MiniRacer

CLIENT = Path(__file__).resolve().parent.parent / "client"

DRIVER = r"""
var results = [];
function check(name, cond, detail) {
  results.push({ name: name, pass: !!cond, detail: String(detail || '') });
}
function netPart1() {

  // ---- fake WebSocket layer -------------------------------------------------
  var sockets = [];      // every constructed FakeSocket
  var inbound = [];      // frames the test injects as received from the relay
  function FakeSocket(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    sockets.push(this);
    var self = this;
    this.__doOpen = function () { self.readyState = 1; if (self.onopen) self.onopen(); };
    this.send = function (raw) { self.sent.push(JSON.parse(raw)); };
    this.close = function () { self.readyState = 3; if (self.onclose) self.onclose(); };
  }
  globalThis.WebSocket = FakeSocket;
  // frames the relay would deliver, in order; {data: <json string>}
  function deliver() {
    var s = sockets[sockets.length - 1];
    for (var i = 0; i < inbound.length; i++) {
      if (s.onmessage) s.onmessage({ data: inbound[i] });
    }
    inbound = [];
  }
  function lastSent() { var s = sockets[sockets.length - 1]; return s.sent[s.sent.length - 1]; }

  var game = {};
  var events = [];
  function hook(n) {
    return function (a, b) { events.push({ h: n, a: a, b: b }); };
  }
  Net.init(game, {
    onLobby: hook('onLobby'), onMembers: hook('onMembers'), onCfg: hook('onCfg'),
    onStart: hook('onStart'),
    onPause: hook('onPause'), onChat: hook('onChat'), onBye: hook('onBye'),
    onGameMsg: hook('onGameMsg'), onHostLeft: hook('onHostLeft'),
    onError: hook('onError'), onClose: hook('onClose'), onRoom: hook('onRoom'),
  });

  // ---- host flow --------------------------------------------------------------
  Net.host({ url: 'ws://127.0.0.1:8790', name: 'Host' }).then(function (r) { globalThis.__hostDone = r; });
  sockets[0].__doOpen(); // the create frame goes out on open
  check('host-sends-create', lastSent().t === 'create' && lastSent().name === 'Host',
    JSON.stringify(lastSent()));
  inbound = [JSON.stringify({ t: 'room', code: 'AB12', slot: 0, host: true }),
             JSON.stringify({ t: 'lobby', slots: [{ slot: 0, name: 'Host' }] })];
  deliver();
  check('host-room-state', Net.isHost && Net.slot === 0 && Net.active
    && Net.code === 'AB12', 'slot=' + Net.slot + ' code=' + Net.code);
  check('host-lobby-hook', events.some(function (e) { return e.h === 'onMembers'; }), '');

  // a peer joins; relay forwards its slot update to us (from stamped)
  inbound = [JSON.stringify({ t: 'lobby', slots: [{ slot: 0, name: 'Host' }, { slot: 1, name: 'P2' }] }),
             JSON.stringify({ t: 'slot', from: 1, name: 'P2', faction: 'Algeria', team: 1, ready: true })];
  deliver();
  check('host-merges-slot', Net.peers[1] && Net.peers[1].faction === 'Algeria'
    && Net.peers[1].ready === true, JSON.stringify(Net.peers[1] || null));
  var lob = lastSent();
  check('host-rebroadcasts-lobby2', lob.t === 'lobby2'
    && lob.slots.length === 2 && lob.slots[1].name === 'P2'
    && lob.slots[1].faction === 'Algeria', JSON.stringify(lob).slice(0, 160));

  // START: cfg + epoch message, local begin (relay does not echo to sender)
  Net.sendCfg({ map: 'sinai', seed: 7, delay: 2, players: [{ slot: 0, faction: 'Egypt', team: 0 }] });
  Net.sendStart();
  check('host-start-envelope', Net.sentCountOk = (function () {
    var cfg = null, st = null;
    for (var i = 0; i < sockets[0].sent.length; i++) {
      if (sockets[0].sent[i].t === 'cfg') cfg = sockets[0].sent[i];
      if (sockets[0].sent[i].t === 'start') st = sockets[0].sent[i];
    }
    return cfg && cfg.cfg.map === 'sinai' && cfg.cfg.delay === 2 && st && typeof st.epoch === 'number';
  })(), '');

  // game channel + drop echo + npong RTT
  Net.sendGame({ t: 'cmd', tick: 10, slot: 0, seq: 0, cmd: { type: 'move' } });
  check('host-sendgame', lastSent().t === 'cmd' && lastSent().tick === 10, JSON.stringify(lastSent()));
  Net.sendDrop(1, 99);
  check('host-drop-echo', events.some(function (e) {
      return e.h === 'onGameMsg' && e.a.t === 'drop' && e.a.slot === 1 && e.a.at === 99;
    }), '');
  var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  inbound = [JSON.stringify({ t: 'npong', from: 1, ts: 4242 })];
  Net._pingTimes['n1_4242'] = t0 - 37; // simulate an outstanding probe
  deliver();
  check('npong-sets-rtt', Net.peers[1].rtt !== undefined, 'rtt=' + (Net.peers[1] && Net.peers[1].rtt));

  // chat from a peer + pause from host slot 0 (from-stamped)
  inbound = [JSON.stringify({ t: 'chat', from: 1, msg: 'gl hf' }),
             JSON.stringify({ t: 'pause', from: 0, on: true })];
  deliver();
  check('chat-pause-hooks', events.some(function (e) { return e.h === 'onChat' && e.a === 1 && e.b === 'gl hf'; })
    && events.some(function (e) { return e.h === 'onPause' && e.a === true; }), '');

  // host leave resets everything
  Net.leave();
  check('leave-resets', !Net.active && Net.slot === -1 && Net.code === ''
    && Object.keys(Net.peers).length === 0, '');

  // ---- join flow ---------------------------------------------------------------
  sockets = []; events = [];
  Net.join('ws://127.0.0.1:8790', 'ab12', 'P2').then(function (r) { globalThis.__joinDone = r; });
  sockets[0].__doOpen(); // the join frame goes out on open
  check('join-sends-code-uppercased', lastSent().t === 'join' && lastSent().code === 'AB12',
    JSON.stringify(lastSent()));
  inbound = [JSON.stringify({ t: 'room', code: 'AB12', slot: 1, host: false }),
             JSON.stringify({ t: 'lobby2', from: 0, slots: [
               { slot: 0, name: 'Host', faction: 'Egypt', team: 0, color: 0, ready: false },
               { slot: 1, name: 'P2', faction: 'Algeria', team: 1, color: 1, ready: false }] }),
             JSON.stringify({ t: 'cfg', from: 0, cfg: { map: 'gulf', seed: 9, delay: 4 } }),
             JSON.stringify({ t: 'start', from: 0, epoch: 12345 })];
  deliver();
  check('join-room-state', !Net.isHost && Net.slot === 1 && Net.active,
    'slot=' + Net.slot + ' isHost=' + Net.isHost);
  check('join-lobby2-merge', Net.peers[0] && Net.peers[0].name === 'Host'
    && Net.peers[0].faction === 'Egypt' && Net.peers[1] === undefined, JSON.stringify(Net.peers).slice(0, 120));
  check('join-cfg-start-hooks', Net.cfg && Net.cfg.map === 'gulf' && Net.cfg.delay === 4
    && Net.epoch === 12345
    && events.some(function (e) { return e.h === 'onCfg'; })
    && events.some(function (e) { return e.h === 'onStart'; }), 'epoch=' + Net.epoch);

  // guest edits own slot -> goes to host (to:0); ready flows back via lobby2
  Net.my.ready = true;
  Net.sendSlot();
  check('guest-slot-to-host', lastSent().t === 'slot' && lastSent().to === 0
    && lastSent().ready === true, JSON.stringify(lastSent()).slice(0, 120));
  inbound = [JSON.stringify({ t: 'lobby2', from: 0, slots: [
    { slot: 0, name: 'Host', faction: 'Egypt', team: 0, color: 0, ready: false },
    { slot: 1, name: 'P2', faction: 'Algeria', team: 1, color: 1, ready: true }] })];
  deliver();
  var gs = Net.lobbySlots();
  check('guest-ready-roundtrip', gs.length === 2 && gs[0].slot === 1 && gs[0].ready === true,
    JSON.stringify(gs).slice(0, 140));

  // bye for a peer + host-left + relay error + status
  inbound = [JSON.stringify({ t: 'bye', slot: 2, reason: 'disconnected' })];
  deliver();
  check('guest-bye-hook', events.some(function (e) { return e.h === 'onBye' && e.a === 2; }), '');
  inbound = [JSON.stringify({ t: 'bye', slot: 0, reason: 'host-left' })];
  deliver();
  check('guest-host-left-hook', events.some(function (e) { return e.h === 'onHostLeft'; }), '');
  Net._reset(); sockets = []; events = [];
  globalThis.__failDone = null;
  Net.host({ url: 'ws://127.0.0.1:8790', name: 'X' }).then(function (r) { globalThis.__failDone = r; });
  sockets[0].__doOpen();
  inbound = [JSON.stringify({ t: 'error', reason: 'no-such-room', code: 'ZZZZ' })];
  deliver();
  check('relay-error-state', !Net.active && events.some(function (e) { return e.h === 'onError'; }), '');

  // unreachable relay -> friendly failure, game unbroken (no exceptions);
  // the resolution value is asserted in part2 (after microtasks flush)
  globalThis.__errDone = null;
  Net.host({ url: 'ws://127.0.0.1:9', name: 'X' }).then(function (r) { globalThis.__errDone = r; });
  if (sockets.length) { var s = sockets[sockets.length - 1]; s.onerror(); }

  // status() ladder from peer RTTs
  Net._reset(); Net.active = true;
  Net.ws = { readyState: 1 }; // status() also checks the socket is open
  Net.peers = { 1: { rtt: 40 }, 2: { rtt: 500 } };
  check('status-poor', Net.status() === 'poor', Net.status());
  Net.peers = { 1: { rtt: 40 }, 2: { rtt: 200 } };
  check('status-fair', Net.status() === 'fair', Net.status());
  Net.peers = { 1: { rtt: 40 } };
  check('status-good', Net.status() === 'good', Net.status());

}

// promise .then callbacks only run once microtasks flush -- split the run so
// the Python harness can eval part1, then part2 (microtasks flush between)
function runPart1() { results = []; netPart1(); }
function runPart2() {
  check('relay-error-surfaces', globalThis.__failDone && !globalThis.__failDone.ok
    && /No room with code ZZZZ/.test(globalThis.__failDone.error),
    JSON.stringify(globalThis.__failDone));
  check('unreachable-relay-friendly', globalThis.__errDone && !globalThis.__errDone.ok
    && /reach relay/.test(globalThis.__errDone.error), JSON.stringify(globalThis.__errDone));
}
"""


def inline(path: Path) -> str:
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"import\s+[\s\S]*?\sfrom\s*'[^']*';", "", src)
    src = re.sub(r"^export\s+(async function|function|const|let)", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[\s\S]*?\};", "", src, flags=re.M)
    return src


def main() -> int:
    ctx = MiniRacer()
    ctx.eval(inline(CLIENT / "src/net/net.js"))
    ctx.eval(DRIVER)
    ctx.eval("runPart1();")
    ctx.eval("runPart2();")  # microtasks flushed -> promise results available
    results = json.loads(ctx.eval("JSON.stringify(results)"))
    passed = 0
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}")
        passed += 1 if r["pass"] else 0
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
