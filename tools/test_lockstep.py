# v0.10.0 lockstep verification (M6): TWO full sim contexts run the REAL
# lockstep scheduler (client/src/net/lockstep.js) against an in-process mock
# relay that shuffles messages with artificial 1-3 tick delays.
#   phase A: two peers + one local-AI slot, 600 ticks of scripted commands
#            from both human sides; checksums must match at every 25-tick
#            boundary and unit/structure counts must be identical
#   phase B: late join — peer2 fast-forwards 0->T by replaying the host's
#            command log (catch-up), then converges by T+1 under live gating
#   phase C: a relay-tampered command must trip checksum desync detection
# Usage: .venv/Scripts/python test_lockstep.py
import json
import re
import sys
from pathlib import Path

from py_mini_racer import MiniRacer

CLIENT = Path(__file__).resolve().parent.parent / "client"
MODULES = [
    "src/sim/rng.js",
    "src/sim/state.js",
    "src/sim/orders.js",
    "src/sim/path.js",
    "src/sim/combat.js",
    "src/sim/economy.js",
    "src/sim/engine.js",
    "src/sim/ai.js",
    "src/net/lockstep.js",
]

DRIVER = r"""
function runLockstepTests(__data, __sinai) {
  var results = [];
  function check(name, cond, detail) {
    results.push({ name: name, pass: !!cond, detail: String(detail || '') });
  }
  var data = JSON.parse(__data);
  var sinai = JSON.parse(__sinai);
  var PLAYER_CFGS = [
    { slot: 0, faction: 'Egypt', team: 0 },
    { slot: 1, faction: 'Algeria', team: 1 },
    { slot: 2, faction: 'Israel', team: 2, ai: { personality: 'Front', difficulty: 'recruit' } },
  ];
  var SEED = 20260917;

  // deterministic per-test RNG stream for scripts + relay jitter
  function mkRng(s) {
    var a = s >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- mock relay: delays every message 1-3 (seeded) virtual ticks --------
  function MockRelay(rng, tamper) {
    this.pending = [];
    this.vnow = 0;
    this.rng = rng;
    this.tamper = tamper || null;
    this.delivered = 0;
  }
  MockRelay.prototype.send = function (from, msg) {
    var m = JSON.parse(JSON.stringify(msg));
    m.from = from; // the real relay stamps the sender on every relayed message
    if (this.tamper) m = this.tamper(from, m) || m;
    var delay = 1 + Math.floor(this.rng() * 3); // 1..3 ticks
    this.pending.push({ at: this.vnow + delay * 100, to: 1 - from, msg: m });
  };
  MockRelay.prototype.pump = function (vnow) {
    this.vnow = vnow;
    var rest = [];
    var out = 0;
    for (var i = 0; i < this.pending.length; i++) {
      var p = this.pending[i];
      if (p.at <= vnow) {
        // delivered into the peer's lockstep (csum comparison happens inside);
        // a not-yet-joined guest slot simply drops them (the host log carries
        // the history for the late join)
        if (peers[p.to]) peers[p.to].ls.ingest(p.msg);
        out++;
      } else rest.push(p);
    }
    this.pending = rest;
    this.delivered += out;
    return out;
  };

  // ---- one peer: full sim context + lockstep scheduler ---------------------
  var peers = [];
  function makePeer(slot, rngSeed) {
    var state = createMatch({ data: data, map: sinai, players: PLAYER_CFGS, seed: SEED });
    var ai = createAI(PLAYER_CFGS, SEED);
    var rng = mkRng(rngSeed);
    var peer = {
      slot: slot, state: state, ai: ai, rng: rng,
      ls: null, desync: null, sent: [], script: {}, vnow: 0,
    };
    peer.ls = createLockstep({
      state: state, ai: ai, playerSlot: slot, humanSlots: [0, 1],
      delay: 2,
      send: function (m) { peer.sent.push(m); relay.send(slot === 0 ? 0 : 1, m); },
      now: function () { return peer.vnow; },
      onDesync: function (info) { peer.desync = info; },
    });
    return peer;
  }

  // deterministic per-tick command script for a human slot (identical menu
  // on both peers; keyed on SIM tick so a catching-up peer stays aligned)
  function runScript(peer) {
    var t = peer.state.tick;
    var S = peer.script;
    var myMcv = null;
    function findMcv() {
      for (var id in peer.state.units) {
        var u = peer.state.units[id];
        if (u.owner === peer.slot && u.defId === 'MCV') return u;
      }
      return null;
    }
    if (!S.moved && t === 20 + Math.floor(peer.rng() * 40)) {
      S.moved = true;
      var m0 = findMcv();
      if (m0) {
        var sp = peer.state.map.spawns[peer.slot % peer.state.map.spawns.length];
        peer.ls.issue({ player: peer.slot, type: 'move', unitIds: [m0.id],
          x: (sp.x + 2 + Math.floor(peer.rng() * 3)) * 64 + 32,
          y: (sp.y + 2 + Math.floor(peer.rng() * 3)) * 64 + 32 });
      }
    }
    if (!S.deployed && t >= 100) {
      S.deployed = true;
      var m1 = findMcv();
      if (m1) peer.ls.issue({ player: peer.slot, type: 'deployMCV', unitId: m1.id });
    }
    if (!S.built && t === 210 + Math.floor(peer.rng() * 30)) {
      S.built = true;
      peer.ls.issue({ player: peer.slot, type: 'buildStructure', structId: 'SH-02' });
    }
    // place the power plant the moment it is ready (same tick on both peers)
    var meP = peer.state.players[peer.slot];
    if (!S.placed && meP.ready.indexOf('SH-02') >= 0) {
      S.placed = true;
      var cy = null;
      for (var sid in peer.state.structures) {
        var so = peer.state.structures[sid];
        if (so.owner === peer.slot && so.defId === 'SH-01') cy = so;
      }
      if (cy) {
        var spot = findPlacement(peer.state, peer.slot, peer.state.structDefs['SH-02'],
          cy.cx, cy.cy, 10);
        if (spot) {
          peer.ls.issue({ player: peer.slot, type: 'placeStructure',
            structId: 'SH-02', cx: spot.x, cy: spot.y });
        }
      }
    }
    // periodic no-op-ish commands (exercise the validate path identically)
    if (t >= 300 && t % 37 === 0 && !S['nox' + t]) {
      S['nox' + t] = true;
      var ids = [];
      for (var uid in peer.state.units) {
        if (peer.state.units[uid].owner === peer.slot) { ids.push(Number(uid)); break; }
      }
      if (ids.length) {
        peer.ls.issue({ player: peer.slot, type: 'setStance', unitIds: ids,
          stance: Math.floor(peer.rng() * 4) });
      }
      peer.ls.issue({ player: peer.slot, type: 'trainUnit', unitId: 'EG-01' });
    }
  }

  function stepPeer(peer) {
    runScript(peer);
    return peer.ls.advance(); // one accumulator tick per 100 virtual ms
  }

  function counts(st) {
    var u = {}, s = {};
    for (var id in st.units) { var o = st.units[id].owner; u[o] = (u[o] || 0) + 1; }
    for (var id2 in st.structures) { var o2 = st.structures[id2].owner; s[o2] = (s[o2] || 0) + 1; }
    return { units: u, structs: s, tick: st.tick };
  }

  // checksum comparisons recorded from the wire (csum msgs the peers sent)
  var csumWire = {}; // tick -> {slot: sum}
  function watchCsums() {
    for (var i = 0; i < peers.length; i++) {
      var sent = peers[i].sent;
      for (var j = 0; j < sent.length; j++) {
        var m = sent[j];
        if (m.t === 'csum' && !m.__seen) {
          m.__seen = true;
          (csumWire[m.tick] = csumWire[m.tick] || {})[peers[i].slot] = m.sum;
        }
      }
    }
  }

  // ================= phase A: two peers, 600 ticks ==========================
  var relay = new MockRelay(mkRng(1));
  peers = [makePeer(0, 11), makePeer(1, 22)];
  var vnow = 0;
  // with 1-3 tick transit each way + delay 2, a tick costs ~3 loop steps —
  // budget 3x headroom over the 600-tick target
  for (var step = 0; step < 2600 && (peers[0].state.tick < 600 || peers[1].state.tick < 600); step++) {
    vnow += 100;
    peers[0].vnow = vnow; peers[1].vnow = vnow;
    relay.pump(vnow);
    stepPeer(peers[0]);
    stepPeer(peers[1]);
    watchCsums();
    if (peers[0].desync || peers[1].desync) break;
  }
  var A = peers[0], B = peers[1];
  check('a-reached-600', A.state.tick >= 600 && B.state.tick >= 600,
    'A=' + A.state.tick + ' B=' + B.state.tick + ' delivered=' + relay.delivered);
  check('a-peers-in-lockstep', Math.abs(A.state.tick - B.state.tick) <= 6,
    'A=' + A.state.tick + ' B=' + B.state.tick);
  var wireBad = [];
  for (var tick in csumWire) {
    var rec = csumWire[tick];
    if (rec[0] !== undefined && rec[1] !== undefined && rec[0] !== rec[1]) {
      wireBad.push(tick);
    }
  }
  check('a-checksums-match-25-boundaries', wireBad.length === 0 && !A.desync && !B.desync,
    'mismatchedTicks=' + wireBad.join(',') + ' wireCovers=' + Object.keys(csumWire).length
      + ' desyncA=' + JSON.stringify(A.desync) + ' desyncB=' + JSON.stringify(B.desync));
  var cA = counts(A.state), cB = counts(B.state);
  check('a-identical-entity-counts', JSON.stringify(cA) === JSON.stringify(cB),
    'A=' + JSON.stringify(cA) + ' B=' + JSON.stringify(cB));
  var liveAi = 0;
  for (var bid in A.state.structures) {
    if (A.state.structures[bid].owner === 2) liveAi++;
  }
  check('a-ai-slot-built', liveAi >= 1, 'aiStructs=' + liveAi);

  // ================= phase B: late join via command-log replay ==============
  // host runs alone (gate force-opens past the stall timeout), then peer2
  // fast-forwards 0->T from the host's log and converges under live gating.
  var relayB = new MockRelay(mkRng(2));
  relay = relayB;
  var host = makePeer(0, 33);
  peers = [host, null]; // relay addresses peer index 1 = guest (added below)
  vnow = 0;
  while (host.state.tick < 50) {
    vnow += 100;
    host.vnow = vnow;
    relay.pump(vnow);
    stepPeer(host);
  }
  check('b-host-limped-alone', host.state.tick >= 50 && host.ls.stats.stallWaits > 0,
    'tick=' + host.state.tick + ' stallWaits=' + host.ls.stats.stallWaits);
  var guest = makePeer(1, 44);
  peers = [host, guest];
  guest.vnow = vnow; host.vnow = vnow;
  guest.ls.ingest({ t: 'log', cmds: host.ls.logSnapshot(0, host.state.tick) });
  var caughtAt = guest.ls.catchUp(host.state.tick);
  check('b-catchup-reaches-t', caughtAt === host.state.tick,
    'guest=' + caughtAt + ' host=' + host.state.tick);
  var convAt = checksum(guest.state) === checksum(host.state);
  check('b-checksum-converges-by-t', convAt,
    'guest=0x' + checksum(guest.state).toString(16)
      + ' host=0x' + checksum(host.state).toString(16));
  // live gating from T onward: both must stay converged at the boundaries
  var relayB2 = new MockRelay(mkRng(3));
  relay = relayB2;
  var ok2 = true, badTick = -1;
  while (host.state.tick < 150) {
    vnow += 100;
    host.vnow = vnow; guest.vnow = vnow;
    relay.pump(vnow);
    stepPeer(host);
    stepPeer(guest);
    watchCsums();
    if (host.desync || guest.desync) { ok2 = false; badTick = host.state.tick; break; }
  }
  check('b-live-after-catchup', ok2 && checksum(guest.state) === checksum(host.state)
    && host.state.tick >= 150 && guest.state.tick >= 149,
    'host=' + host.state.tick + ' guest=' + guest.state.tick + ' badAt=' + badTick);

  // ================= phase C: relay tamper -> desync detection ==============
  var relayC = new MockRelay(mkRng(4), function (from, m) {
    if (m.t === 'cmd' && m.cmd && m.cmd.type === 'move' && !this._done) {
      this._done = true;
      m.cmd.x += 64; // corrupted in transit
    }
    return m;
  });
  relay = relayC;
  var pA = makePeer(0, 55), pB = makePeer(1, 66);
  peers = [pA, pB];
  vnow = 0;
  var guard = 4000;
  while (!pA.desync && !pB.desync && guard-- > 0) {
    vnow += 100;
    pA.vnow = vnow; pB.vnow = vnow;
    relay.pump(vnow);
    stepPeer(pA);
    stepPeer(pB);
  }
  check('c-tamper-triggers-desync', !!(pA.desync || pB.desync),
    'desyncA=' + JSON.stringify(pA.desync) + ' desyncB=' + JSON.stringify(pB.desync));

  return results;
}
"""


def inline(path: Path) -> str:
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"import\s+[\s\S]*?\sfrom\s*'[^']*';", "", src)
    src = re.sub(r"export\s*\{[\s\S]*?\}\s*from\s*'[^']*';", "", src)
    src = re.sub(r"^export\s+(async function|function|const|let)", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[\s\S]*?\};", "", src, flags=re.M)
    return src


def main() -> int:
    bundle = "\n;\n".join(inline(CLIENT / m) for m in MODULES)
    ctx = MiniRacer()
    data = (CLIENT / "data/game.json").read_text(encoding="utf-8")
    sinai = (CLIENT / "maps/sinai.json").read_text(encoding="utf-8")
    ctx.eval(f"var __data = {json.dumps(data)}; var __sinai = {json.dumps(sinai)};")
    ctx.eval(bundle)
    ctx.eval(DRIVER)
    results = json.loads(ctx.eval("JSON.stringify(runLockstepTests(__data, __sinai))"))
    passed = 0
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}")
        passed += 1 if r["pass"] else 0
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
