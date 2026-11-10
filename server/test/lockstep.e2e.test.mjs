// End-to-end: complete headless lockstep matches through the Node relay.
//
// Nothing is mocked. Each peer is the REAL client networking stack --
// client/src/net/net.js (on Node's built-in browser-compatible WebSocket),
// client/src/net/lockstep.js and the real simulation (client/src/sim) --
// talking to the real server over real sockets. The lobby handshake, cfg/start
// and the match itself follow the same sequence main.js runs in the browser.
//
// The matches must stay bit-identical on every peer: per-tick state checksums
// are compared directly AND through the csum messages the peers exchange via
// the relay, and the lockstep scheduler must never report a desync or force a
// stalled tick. A negative control proves a real divergence IS caught.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import * as Sim from '../../client/src/sim/index.js';
import { createLockstep, CSUM_EVERY } from '../../client/src/net/lockstep.js';
import { http, sleep, startServer } from './helpers/harness.mjs';

const CLIENT = path.resolve(import.meta.dirname, '..', '..', 'client');
const NET_MODULE = new URL('../../client/src/net/net.js', import.meta.url).href;
const DATA_TEXT = fs.readFileSync(path.join(CLIENT, 'data', 'game.json'), 'utf8');
const mapText = (id) => fs.readFileSync(path.join(CLIENT, 'maps', id + '.json'), 'utf8');
const TAKEOVER_DELAY_TICKS = 3; // as in main.js
const SEED = 20260917;
const clock = { t: 0 };         // virtual milliseconds, see beginMatch()

let peerSeq = 0;

// small seeded RNG for the scripted "human" input (mulberry32)
function mkRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One player: its own Net singleton (a fresh module instance per peer, like a
// separate browser tab), wired with the same hooks main.js installs.
async function makePeer(tag, rngSeed) {
  const { Net } = await import(NET_MODULE + '?peer=' + (++peerSeq) + '-' + tag);
  const peer = {
    tag, Net, game: {}, rng: mkRng(rngSeed), script: {},
    state: null, ai: null, ls: null, slot: -1,
    desync: null, sent: [], sums: new Map(), chat: [], byes: [], errors: [],
    hostLeft: null, closed: false, lobbies: 0, dropped: 0, pendingDrops: [], issued: 0,
  };
  Net.init(peer.game, {
    onLobby: () => { peer.lobbies++; },
    onStart: () => beginMatch(peer),
    onChat: (from, text) => peer.chat.push({ from, text }),
    onGameMsg: (m) => {
      if (!peer.ls) { peer.dropped++; return; }
      if (m.t === 'needlog' && Net.isHost) {
        Net.sendLog(m.from, peer.ls.logSnapshot(m.fromTick || 0, peer.state.tick));
        return;
      }
      peer.ls.ingest(m);
    },
    onBye: (slot, reason) => {
      peer.byes.push({ slot, reason });
      // host declares the AI takeover on an absolute tick (main.js: hostDropWatch)
      if (peer.state && !peer.state.over && Net.isHost) Net.sendDrop(slot, peer.state.tick + TAKEOVER_DELAY_TICKS);
    },
    onHostLeft: (m) => { peer.hostLeft = m; },
    onError: (reason) => peer.errors.push(reason),
    onClose: () => { peer.closed = true; },
  });
  return peer;
}

// 'start' from the host: every peer builds the identical match from the
// host's cfg (main.js: beginMpMatch -> startMatch). Each peer parses its own
// copy of the data, exactly as separate browsers would.
function beginMatch(peer) {
  const cfg = peer.Net.cfg;
  const players = cfg.players;
  const state = Sim.createMatch({ data: JSON.parse(DATA_TEXT), map: JSON.parse(mapText(cfg.map)), players, seed: cfg.seed });
  peer.state = state;
  peer.ai = Sim.createAI(players, cfg.seed);
  peer.slot = peer.Net.slot;
  peer.ls = createLockstep({
    state,
    ai: peer.ai,
    playerSlot: peer.slot,
    humanSlots: players.filter((p) => !p.ai).map((p) => p.slot),
    delay: cfg.delay || 2,
    send: (m) => { peer.sent.push(m); peer.Net.sendGame(m); },
    // The scheduler's silence timeout (1.5 s without hearing a peer -> force
    // the tick) runs on a virtual clock: 1 ms per event-loop turn of the test
    // driver. A message needs a handful of turns to cross the loopback, so a
    // forced tick still means "the relay lost something", while a frozen CI
    // machine (which freezes the clock too) can never fake one.
    now: () => clock.t,
    onDesync: (info) => { peer.desync = info; },
    onPeerDrop: (m) => {
      peer.pendingDrops.push({ slot: m.slot, at: m.at !== undefined ? m.at : state.tick + TAKEOVER_DELAY_TICKS });
    },
  });
  peer.sums.set(0, Sim.checksum(state));
}

// main.js: processPendingDrops -- a declared drop installs a takeover brain
function processPendingDrops(peer) {
  if (!peer.pendingDrops.length) return;
  const remaining = [];
  for (const d of peer.pendingDrops) {
    if (peer.state.tick < d.at) { remaining.push(d); continue; }
    const p = peer.state.players[d.slot];
    if (p && !p.aiTakeover) {
      p.aiTakeover = true;
      p.ai = { personality: 'Front', difficulty: 'veteran' };
      const brain = Sim.makeBrain({ slot: d.slot, faction: p.faction, team: p.team, ai: p.ai }, peer.state.seed, d.slot);
      brain.nextThink = d.at + brain.interval;
      peer.ai.brains.push(brain);
    }
  }
  peer.pendingDrops = remaining;
}

// Deterministic per-tick "human" input, keyed on the SIM tick (the same menu
// as tools/test_lockstep.py): move the MCV, deploy it, queue + place a power
// plant, then periodic stance / production orders.
function runScript(peer) {
  const st = peer.state;
  const t = st.tick;
  const S = peer.script;
  if (S.quiet) return;
  const issue = (cmd) => { peer.issued++; peer.ls.issue(cmd); };
  const findMcv = () => Object.values(st.units).find((u) => u.owner === peer.slot && u.defId === 'MCV') || null;
  if (S.moveAt === undefined) S.moveAt = 20 + Math.floor(peer.rng() * 40);
  if (S.buildAt === undefined) S.buildAt = 210 + Math.floor(peer.rng() * 30);
  if (!S.moved && t === S.moveAt) {
    S.moved = true;
    const mcv = findMcv();
    if (mcv) {
      const sp = st.map.spawns[peer.slot % st.map.spawns.length];
      issue({
        player: peer.slot, type: 'move', unitIds: [mcv.id],
        x: (sp.x + 2 + Math.floor(peer.rng() * 3)) * 64 + 32,
        y: (sp.y + 2 + Math.floor(peer.rng() * 3)) * 64 + 32,
      });
    }
  }
  if (!S.deployed && t >= 100) {
    S.deployed = true;
    const mcv = findMcv();
    if (mcv) issue({ player: peer.slot, type: 'deployMCV', unitId: mcv.id });
  }
  if (!S.built && t === S.buildAt) {
    S.built = true;
    issue({ player: peer.slot, type: 'buildStructure', structId: 'SH-02' });
  }
  const me = st.players[peer.slot];
  if (!S.placed && me.ready.indexOf('SH-02') >= 0) {
    S.placed = true;
    const cy = Object.values(st.structures).find((s) => s.owner === peer.slot && s.defId === 'SH-01');
    if (cy) {
      const spot = Sim.findPlacement(st, peer.slot, st.structDefs['SH-02'], cy.cx, cy.cy, 10);
      if (spot) issue({ player: peer.slot, type: 'placeStructure', structId: 'SH-02', cx: spot.x, cy: spot.y });
    }
  }
  if (t >= 300 && t % 37 === 0 && !S['nox' + t]) {
    S['nox' + t] = true;
    const mine = Object.values(st.units).find((u) => u.owner === peer.slot);
    if (mine) issue({ player: peer.slot, type: 'setStance', unitIds: [mine.id], stance: Math.floor(peer.rng() * 4) });
    issue({ player: peer.slot, type: 'trainUnit', unitId: 'EG-01' });
  }
}

// One "frame" for one peer: issue scripted input and step while the lockstep
// gate is open (capped like MP_STEP_CAP), recording a checksum per tick.
function frame(peer, maxSteps) {
  let steps = 0;
  while (steps < maxSteps && !peer.state.over) {
    runScript(peer);
    processPendingDrops(peer);
    if (!peer.ls.advance()) break;
    peer.sums.set(peer.state.tick, Sim.checksum(peer.state));
    steps++;
  }
  return steps;
}

// Run all live peers until `done()`; throws (with a gate report) on a stall.
async function drive(peers, done, { timeoutMs = 60000, maxSteps = 30, paceMs = 0, each } = {}) {
  const started = performance.now();
  for (;;) {
    clock.t += 1;
    for (const p of peers) if (!p.gone) frame(p, maxSteps);
    if (each) each();
    if (done()) return;
    if (performance.now() - started > timeoutMs) {
      throw new Error('match stalled: ' + peers.map((p) => p.tag + '@' + p.state.tick
        + (p.gone ? '(gone)' : ' waiting on [' + p.ls.waitingOn() + ']')
        + (p.desync ? ' DESYNC ' + JSON.stringify(p.desync) : '')).join(' | '));
    }
    if (paceMs) await sleep(paceMs); else await new Promise((resolve) => setImmediate(resolve));
  }
}

async function until(cond, what, timeoutMs = 15000) {
  const started = performance.now();
  while (!cond()) {
    if (performance.now() - started > timeoutMs) throw new Error('timed out waiting for ' + what);
    await sleep(5);
  }
}

// Lobby handshake exactly as the menu drives it: host creates, guests join by
// code and publish their slot, host rebroadcasts the merged lobby, then cfg +
// start (main.js: G.mpHost / G.mpJoin / G.mpStart).
async function lobby(srv, specs, { map, aiPlayers = [], delay = 2 }) {
  const peers = [];
  for (let i = 0; i < specs.length; i++) peers.push(await makePeer(specs[i].name, 1000 + i * 11));
  const [host, ...guests] = peers;
  host.Net.name = specs[0].name;
  const created = await host.Net.host({ url: srv.wsUrl, name: specs[0].name });
  assert.deepEqual(created, { ok: true, slot: 0, host: true, code: host.Net.code });
  host.Net.my.faction = specs[0].faction;
  host.Net.my.team = 0;
  host.Net.broadcastLobby();

  for (let i = 0; i < guests.length; i++) {
    const g = guests[i];
    const spec = specs[i + 1];
    g.Net.name = spec.name;
    // even guests use the bare URL (the Python relay's form), odd ones /ws; codes are case-insensitive
    const joined = await g.Net.join(i % 2 === 0 ? srv.bareWsUrl : srv.wsUrl, host.Net.code.toLowerCase(), spec.name);
    assert.deepEqual(joined, { ok: true, slot: i + 1, host: false, code: host.Net.code });
    Object.assign(g.Net.my, { faction: spec.faction, team: i + 1, color: i + 1, ready: true });
    g.Net.sendSlot();
  }
  await until(() => guests.every((g, i) => host.Net.peers[i + 1] && host.Net.peers[i + 1].faction === specs[i + 1].faction
    && host.Net.peers[i + 1].ready === true), 'host to merge every slot');
  await until(() => guests.every((g) => Object.keys(g.Net.peers).length === peers.length - 1
    && g.Net.peers[0].faction === specs[0].faction), 'guests to receive the merged lobby');

  const slots = host.Net.lobbySlots();
  assert.deepEqual(slots.map((s) => s.slot), peers.map((_, i) => i));
  const players = slots.map((s) => ({ slot: s.slot, faction: s.faction, team: s.team })).concat(aiPlayers);
  host.Net.sendCfg({ map, seed: SEED, delay, players });
  host.Net.sendStart();
  beginMatch(host); // the relay does not echo to the sender -- the host starts itself
  await until(() => guests.every((g) => g.ls), 'guests to start the match');
  for (const g of guests) assert.deepEqual(g.Net.cfg, host.Net.cfg);
  return peers;
}

function entityCounts(st) {
  const units = {};
  const structs = {};
  for (const u of Object.values(st.units)) units[u.owner] = (units[u.owner] || 0) + 1;
  for (const s of Object.values(st.structures)) structs[s.owner] = (structs[s.owner] || 0) + 1;
  return { units, structs };
}

// Every tick both peers executed must have produced the same checksum.
function assertSameHistory(a, b, minTicks) {
  let compared = 0;
  for (const [tick, sum] of a.sums) {
    if (!b.sums.has(tick)) continue;
    compared++;
    assert.equal(b.sums.get(tick), sum, `checksum mismatch at tick ${tick}: ${a.tag}=0x${sum.toString(16)} ${b.tag}=0x${b.sums.get(tick).toString(16)}`);
  }
  assert.ok(compared >= minTicks, `only ${compared} common ticks between ${a.tag} and ${b.tag}`);
  return compared;
}

// The csum messages each peer sent through the relay, by tick.
function wireChecksums(peer) {
  const out = new Map();
  for (const m of peer.sent) if (m.t === 'csum') out.set(m.tick, m.sum);
  return out;
}

describe('headless lockstep matches through the Node relay', () => {
  test('2 humans + 1 AI on sinai: 600 ticks, identical checksums, zero desyncs, zero forced stalls', async (t) => {
    // The match runs flat out (hundreds of ticks per second), far above the
    // 10 Hz the per-connection limiter is sized for, so this server gets a
    // raised message budget. The real-time test below uses the defaults.
    const srv = await startServer({ RATE_MSGS_PER_SEC: '20000', RATE_BURST: '20000' });
    t.after(() => srv.close());
    const TARGET = 600;
    const [host, guest] = await lobby(srv, [
      { name: 'Host', faction: 'Egypt' },
      { name: 'Guest', faction: 'Algeria' },
    ], { map: 'sinai', aiPlayers: [{ slot: 2, faction: 'Israel', team: 2, ai: { personality: 'Front', difficulty: 'recruit' } }] });
    t.after(() => { host.Net.leave(); guest.Net.leave(); });
    assert.equal(host.Net.isHost, true);
    assert.equal(guest.Net.isHost, false);
    assert.equal(guest.Net.peers[0].name, 'Host');
    assert.equal(host.Net.peers[1].name, 'Guest');
    assert.deepEqual((await http(srv.origin + '/api/stats')).json, { online: 2, rooms: 1, publicRooms: 0, inMatch: 1, connections: 2 });

    // per-peer RTT probes (nping/npong, `to`-addressed) work through the relay
    host.Net._peerPingTimer = -1e9;
    guest.Net._peerPingTimer = -1e9;
    host.Net.netTick();
    guest.Net.netTick();

    let chatted = false;
    await drive([host, guest], () => host.state.tick >= TARGET && guest.state.tick >= TARGET, {
      each: () => {
        if (!chatted && host.state.tick >= 150) { chatted = true; host.Net.sendChat('gl hf'); guest.Net.sendChat('u2'); }
      },
    });

    // --- the match stayed in lockstep ---------------------------------------
    assert.ok(host.state.tick >= TARGET && guest.state.tick >= TARGET);
    assert.ok(Math.abs(host.state.tick - guest.state.tick) <= 3, `ticks drifted: ${host.state.tick} vs ${guest.state.tick}`);
    const compared = assertSameHistory(host, guest, TARGET);
    assert.equal(host.desync, null);
    assert.equal(guest.desync, null);
    for (const p of [host, guest]) {
      assert.equal(p.ls.isDesynced(), false);
      assert.deepEqual(p.ls.stats, { stallWaits: 0, forcedSteps: 0, desyncs: 0 }, p.tag + ' never had to force a tick');
      assert.equal(p.dropped, 0, p.tag + ' lost no game message before its scheduler existed');
      assert.deepEqual(p.errors, []);
      assert.equal(p.closed, false);
    }
    // the checksums the peers exchanged over the wire agree at every 25-tick boundary
    const wa = wireChecksums(host);
    const wb = wireChecksums(guest);
    let boundaries = 0;
    for (const [tick, sum] of wa) {
      if (!wb.has(tick)) continue;
      assert.equal(tick % CSUM_EVERY, 0);
      assert.equal(wb.get(tick), sum, 'wire checksum mismatch at tick ' + tick);
      boundaries++;
    }
    assert.ok(boundaries >= TARGET / CSUM_EVERY, 'only ' + boundaries + ' checksum boundaries crossed');

    // --- and it was a real match: AI + human commands shaped the world -------
    assert.deepEqual(entityCounts(host.state), entityCounts(guest.state));
    const counts = entityCounts(host.state);
    for (const slot of [0, 1]) {
      const yard = Object.values(host.state.structures).find((s) => s.owner === slot && s.defId === 'SH-01');
      assert.ok(yard, 'human slot ' + slot + ' deployed its construction yard (scripted command applied)');
    }
    assert.ok((counts.structs[2] || 0) >= 1, 'the AI slot built: ' + JSON.stringify(counts));
    assert.ok(host.issued >= 5 && guest.issued >= 5, `scripted commands issued: ${host.issued}/${guest.issued}`);
    assert.ok(host.sent.filter((m) => m.t === 'cmd').length === host.issued);
    assert.ok(host.sent.some((m) => m.t === 'stall'));
    assert.notEqual(host.sums.get(0), host.sums.get(TARGET), 'the world actually changed');

    // --- side channels through the same relay --------------------------------
    await until(() => guest.chat.length > 0 && host.chat.length > 0, 'chat to arrive');
    assert.deepEqual(guest.chat, [{ from: 0, text: 'gl hf' }]);
    assert.deepEqual(host.chat, [{ from: 1, text: 'u2' }]);
    await until(() => host.Net.peers[1].rtt !== undefined && guest.Net.peers[0].rtt !== undefined, 'RTT probes');
    assert.ok(host.Net.peers[1].rtt >= 0 && host.Net.peers[1].rtt < 1000);
    assert.notEqual(host.Net.status(), 'off');

    // --- server side: nothing was throttled, kicked or refused ----------------
    assert.equal(srv.logs.filter((l) => l.evt === 'conn.kick' || l.evt === 'conn.refused' || l.evt === 'conn.slow').length, 0);
    assert.ok(srv.app.relay.counters.messagesIn > 2 * TARGET);

    // --- host leaves: the guest is told and the room disappears ---------------
    host.Net.leave();
    await until(() => guest.hostLeft !== null, 'guest to learn the host left');
    assert.deepEqual(guest.hostLeft, { t: 'bye', slot: 0, reason: 'host-left' });
    guest.Net.leave();
    await until(() => srv.app.relay.stats().connections === 0, 'sockets to close');
    assert.deepEqual(srv.app.relay.stats(), { rooms: 0, peers: 0, connections: 0, publicRooms: 0, inMatch: 0 });
    t.diagnostic(`ticks=${host.state.tick}/${guest.state.tick} checksums compared=${compared} wire boundaries=${boundaries} `
      + `cmds=${host.issued}+${guest.issued} relayed in=${srv.app.relay.counters.messagesIn} out=${srv.app.relay.counters.messagesOut}`);
  });

  test('negative control: a real divergence IS detected through the relay', async (t) => {
    const srv = await startServer({ RATE_MSGS_PER_SEC: '20000', RATE_BURST: '20000' });
    t.after(() => srv.close());
    const [host, guest] = await lobby(srv, [
      { name: 'Host', faction: 'Egypt' },
      { name: 'Cheater', faction: 'Algeria' },
    ], { map: 'duel' });
    t.after(() => { host.Net.leave(); guest.Net.leave(); });
    let tampered = false;
    await drive([host, guest], () => !!(host.desync || guest.desync) || host.state.tick > 400, {
      each: () => {
        if (!tampered && guest.state.tick >= 60) { tampered = true; guest.state.players[1].credits += 1; } // one credit off
      },
    });
    assert.ok(tampered);
    const info = host.desync || guest.desync;
    assert.ok(info, 'the tampered state must trip the checksum comparison');
    assert.equal(info.tick, 75, 'caught at the first checksum boundary after the divergence');
    assert.notEqual(info.mine, info.theirs);
    await until(() => host.ls.isDesynced() && guest.ls.isDesynced(), 'both peers to freeze');
    assert.equal(host.sums.get(50), guest.sums.get(50), 'they agreed before the tampering');
    const frozen = host.state.tick;
    await sleep(50);
    frame(host, 30);
    assert.equal(host.state.tick, frozen, 'a desynced match is frozen, not allowed to drift on');
  });

  test('3 humans on gulf: one drops mid-match -> bye -> host declares AI takeover -> the rest stay in sync', async (t) => {
    const srv = await startServer({ RATE_MSGS_PER_SEC: '20000', RATE_BURST: '20000' });
    t.after(() => srv.close());
    const [host, bob, carol] = await lobby(srv, [
      { name: 'Host', faction: 'Egypt' },
      { name: 'Bob', faction: 'Turkey' },
      { name: 'Carol', faction: 'Iran' },
    ], { map: 'gulf' });
    t.after(() => { for (const p of [host, bob, carol]) p.Net.leave(); });

    await drive([host, bob, carol], () => [host, bob, carol].every((p) => p.state.tick >= 180));
    assertSameHistory(host, bob, 180);
    assertSameHistory(host, carol, 180);
    carol.script.quiet = true; // Carol stops giving orders, then her connection dies
    await drive([host, bob, carol], () => [host, bob, carol].every((p) => p.state.tick >= 200));
    const carolLast = carol.state.tick;
    carol.gone = true;
    carol.Net.ws.close(); // an abrupt disconnect, not a graceful leave message

    await until(() => host.byes.length > 0 && bob.byes.length > 0, 'bye to reach the others');
    assert.deepEqual(host.byes, [{ slot: 2, reason: 'disconnected' }]);
    assert.deepEqual(bob.byes, [{ slot: 2, reason: 'disconnected' }]);

    await drive([host, bob, carol], () => host.state.tick >= 450 && bob.state.tick >= 450);
    assert.ok(host.ls.isDropped(2) && bob.ls.isDropped(2), 'both peers processed the host’s drop declaration');
    assert.equal(host.state.players[2].aiTakeover, true);
    assert.equal(bob.state.players[2].aiTakeover, true);
    assert.equal(host.desync, null);
    assert.equal(bob.desync, null);
    const compared = assertSameHistory(host, bob, 450);
    assert.deepEqual(entityCounts(host.state), entityCounts(bob.state));
    for (const p of [host, bob]) assert.equal(p.ls.stats.desyncs, 0);
    assert.deepEqual((await http(srv.origin + '/api/stats')).json.online, 2);
    t.diagnostic(`carol dropped at tick ${carolLast}; host/bob continued to ${host.state.tick}/${bob.state.tick}, ${compared} checksums compared, `
      + `forced steps host=${host.ls.stats.forcedSteps} bob=${bob.ls.stats.forcedSteps}`);
  });

  test('6 humans at the real 10 Hz tick rate under DEFAULT limits: nobody is throttled', async (t) => {
    const srv = await startServer(); // stock configuration, as deployed
    t.after(() => srv.close());
    const factions = ['Egypt', 'Saudi', 'UAE', 'Algeria', 'Turkey', 'Israel'];
    const peers = await lobby(srv, factions.map((faction, i) => ({ name: 'P' + (i + 1), faction })), { map: 'gulf', delay: 2 });
    t.after(() => { for (const p of peers) p.Net.leave(); });
    assert.equal(peers.length, 6);
    for (const p of peers) { p.script.moveAt = 5 + p.slot; p.Net._peerPingTimer = -1e9; }

    // Real-time pacing, as in main.js's frame loop: every ~16 ms "frame" adds
    // the elapsed time to a per-peer accumulator; a tick runs when 100 ms are
    // due AND the lockstep gate is open (otherwise the accumulator holds).
    const TARGET = 30;
    const TICK_MS = 100;
    const started = performance.now();
    let last = started;
    for (const p of peers) p.acc = 0;
    await drive(peers, () => peers.every((p) => p.state.tick >= TARGET), {
      paceMs: 16,
      maxSteps: 0, // stepping happens in each(), on the accumulator's schedule
      each: () => {
        const now = performance.now();
        const dt = Math.min(250, now - last);
        last = now;
        for (const p of peers) {
          p.Net.netTick();
          p.acc += dt;
          let steps = 0;
          while (p.acc >= TICK_MS && steps < 30) {
            if (frame(p, 1) === 0) break; // gate closed -- hold the accumulator
            p.acc -= TICK_MS;
            steps++;
          }
        }
      },
      timeoutMs: 30000,
    });
    const elapsed = performance.now() - started;
    for (const p of peers.slice(1)) assertSameHistory(peers[0], p, TARGET);
    for (const p of peers) {
      assert.equal(p.desync, null);
      assert.equal(p.ls.stats.forcedSteps, 0);
      assert.equal(p.closed, false);
      assert.deepEqual(p.errors, []);
    }
    // then a catch-up burst: every peer steps as fast as the gate allows
    // (what MP_STEP_CAP permits after a hiccup) -- still inside the budget
    await drive(peers, () => peers.every((p) => p.state.tick >= TARGET + 40));
    for (const p of peers.slice(1)) assertSameHistory(peers[0], p, TARGET + 40);
    assert.equal(srv.logs.filter((l) => l.evt === 'conn.kick').length, 0, 'default rate limits must not touch real lockstep traffic');
    assert.deepEqual(srv.app.relay.stats(), { rooms: 1, peers: 6, connections: 6, publicRooms: 0, inMatch: 1 });
    const c = srv.app.relay.counters;
    assert.ok(elapsed < TARGET * TICK_MS * 4, `real-time match fell behind: ${TARGET} ticks took ${Math.round(elapsed)} ms`);
    t.diagnostic(`6 peers, ${TARGET} ticks in ${Math.round(elapsed)} ms real time + 40-tick burst: `
      + `${c.messagesIn} msgs in, ${c.messagesOut} out, 0 kicks`);
  });
});
