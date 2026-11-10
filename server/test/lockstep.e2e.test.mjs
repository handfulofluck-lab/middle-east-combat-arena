// End-to-end: complete headless lockstep matches through the Node relay.
//
// Nothing is mocked. Each peer is the REAL client networking stack --
// client/src/net/net.js (on Node's built-in browser-compatible WebSocket),
// client/src/net/lockstep.js and the real simulation (client/src/sim) --
// talking to the real server over real sockets. The lobby handshake, cfg/start
// and the match itself follow the same sequence main.js runs in the browser,
// and the parts of main.js that cannot be imported headlessly (the frame loop,
// the host's drop rules, the AI takeover) are emulated below; a guard test at
// the end of this file fails when main.js stops matching that emulation.
//
// The matches must stay bit-identical on every peer: per-tick state checksums
// are compared directly AND through the csum messages the peers exchange via
// the relay, and the lockstep scheduler must never report a desync or force a
// tick. Negative controls prove that a real divergence IS caught.
//
// Time: the scheduler and the host's drop timeouts run on a VIRTUAL clock that
// only the test driver advances. A frozen CI machine freezes the clock too, so
// no timeout here can fire because the hardware was slow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import * as Sim from '../../client/src/sim/index.js';
import { createLockstep, CSUM_EVERY, MP_STEP_CAP, STALL_TIMEOUT_MS } from '../../client/src/net/lockstep.js';
import { http, sleep, startServer } from './helpers/harness.mjs';

const CLIENT = path.resolve(import.meta.dirname, '..', '..', 'client');
const NET_MODULE = new URL('../../client/src/net/net.js', import.meta.url).href;
const DATA_TEXT = fs.readFileSync(path.join(CLIENT, 'data', 'game.json'), 'utf8');
const MAIN_SRC = fs.readFileSync(path.join(CLIENT, 'src', 'main.js'), 'utf8');
const LOCKSTEP_SRC = fs.readFileSync(path.join(CLIENT, 'src', 'net', 'lockstep.js'), 'utf8');
const mapText = (id) => fs.readFileSync(path.join(CLIENT, 'maps', id + '.json'), 'utf8');

// Maps come and go; pick from the shipped manifest by spawn count (keeping
// the classic names when they are still around).
const MAP_SPAWNS = new Map(JSON.parse(fs.readFileSync(path.join(CLIENT, 'maps', 'manifest.json'), 'utf8')).maps
  .filter((id) => fs.existsSync(path.join(CLIENT, 'maps', id + '.json')))
  .map((id) => [id, JSON.parse(mapText(id)).spawns.length]));
function pickMap(minSpawns, preferred) {
  if (MAP_SPAWNS.get(preferred) >= minSpawns) return preferred;
  const hit = [...MAP_SPAWNS].find(([, spawns]) => spawns >= minSpawns);
  assert.ok(hit, 'no shipped map has ' + minSpawns + '+ spawns');
  return hit[0];
}

// main.js's own numbers (read from its source so the emulation cannot drift)
const mainConst = (name) => {
  const m = new RegExp('^const ' + name + ' = (\\d+);', 'm').exec(MAIN_SRC);
  return m ? Number(m[1]) : NaN;
};
const TICK_MS = mainConst('TICK_MS');                           // 100
const DROP_AFTER_MS = mainConst('DROP_AFTER_MS');               // host gives up on a silent peer
const LOAD_GRACE_MS = mainConst('LOAD_GRACE_MS');               // ...or on one that never spoke (still loading)
const TAKEOVER_DELAY_TICKS = mainConst('TAKEOVER_DELAY_TICKS'); // drop line = safe tick + this
const SEED = 20260917;
const clock = { t: 1 }; // virtual milliseconds (never 0: main.js treats a 0 timestamp as "not waiting")

let peerSeq = 0;
let syncSeq = 0;

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

// ---- one player ---------------------------------------------------------------

// Its own Net singleton (a fresh module instance per peer, like a separate
// browser tab), wired with the same hooks main.js installs.
//   opts.forceOnSilence  run the scheduler with the pre-v1.0 "force after 1.5 s" rule
//   opts.dropAt          (host) override the drop line the host declares (rule-level tests)
async function makePeer(tag, rngSeed, opts = {}) {
  const { Net } = await import(NET_MODULE + '?peer=' + (++peerSeq) + '-' + tag);
  const peer = {
    tag, Net, opts, game: {}, rng: mkRng(rngSeed), script: {},
    state: null, ai: null, ls: null, slot: -1,
    desync: null, sent: [], sums: new Map(), trace: [], chat: [], byes: [], errors: [],
    hostLeft: null, closed: false, lobbies: 0, lost: 0, issued: 0, orders: [],
    // drops: what this peer was told / decided
    drops: [], pendingDrops: [], takeovers: [], declared: [], selfDropped: false,
    mpDropped: {}, stallSince: 0, stallSlots: '',
    // test controls
    gone: false,          // left the match (disconnected, or dropped by the host)
    frozen: false,        // its frame loop is not running
    inboundHeld: false,   // network input is queued instead of processed (frozen JS / a lagging link)
    inboundQueue: [], inboundCount: 0, pongWaiters: new Map(), acc: 0,
  };
  // what arrives from the network is processed now, or queued while "held"
  const fromNetwork = (fn) => (...args) => {
    if (peer.inboundHeld) peer.inboundQueue.push(() => fn(...args)); else fn(...args);
  };
  const deliver = (m) => {
    if (!peer.ls) { peer.lost++; return; }
    if (m.t === 'needlog' && Net.isHost) {
      Net.sendLog(m.from, peer.ls.logSnapshot(m.fromTick || 0, peer.state.tick));
      return;
    }
    peer.ls.ingest(m);
  };
  Net.init(peer.game, {
    onLobby: () => { peer.lobbies++; },
    onStart: () => beginMatch(peer),
    onChat: fromNetwork((from, text) => peer.chat.push({ from, text })),
    onGameMsg: (m) => {
      // Net.sendDrop echoes the host's own declaration into this hook: that is a
      // local call, not network input, and takes effect at once
      if (m && m.t === 'drop' && Net.isHost && m.from === Net.slot) deliver(m);
      else fromNetwork(deliver)(m);
    },
    // main.js onBye: the host turns a disconnect into a drop declaration
    onBye: fromNetwork((slot, reason) => {
      peer.byes.push({ slot, reason });
      if (peer.state && !peer.state.over && Net.isHost && peer.ls && !peer.mpDropped[slot]) declareDrop(peer, slot, 'bye');
    }),
    onHostLeft: fromNetwork((m) => { peer.hostLeft = m; }),
    onError: (reason) => peer.errors.push(reason),
    onClose: () => { peer.closed = true; },
  });
  return peer;
}

// main.js (onBye and hostDropWatch): the drop takes effect at a tick no peer
// can have reached yet -- ls.safeDropTick(slot) + TAKEOVER_DELAY_TICKS.
function declareDrop(peer, slot, why) {
  const at = peer.opts.dropAt ? peer.opts.dropAt(peer, slot) : peer.ls.safeDropTick(slot) + TAKEOVER_DELAY_TICKS;
  peer.mpDropped[slot] = true;
  peer.declared.push({ slot, at, why, tick: peer.state.tick, clock: clock.t });
  peer.Net.sendDrop(slot, at);
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
    forceOnSilence: !!peer.opts.forceOnSilence,
    send: (m) => { peer.sent.push(m); peer.Net.sendGame(m); },
    now: () => clock.t,
    trace: peer.trace, // which commands each executed tick handed to the sim
    onDesync: (info) => { peer.desync = info; },
    // main.js onPeerDrop
    onPeerDrop: (m) => {
      peer.drops.push({ slot: m.slot, at: m.at, tick: state.tick });
      if (m.slot === peer.slot) {
        // the host gave up on THIS player: an AI commands its forces on every
        // other machine now, so it stops taking part and leaves
        peer.selfDropped = true;
        peer.gone = true;
        setTimeout(() => { if (peer.ls) peer.Net.leave(); }, 0);
        return;
      }
      peer.pendingDrops.push({ slot: m.slot, at: m.at !== undefined ? m.at : state.tick + TAKEOVER_DELAY_TICKS });
    },
  });
  peer.sums.set(0, Sim.checksum(state));
}

// main.js hostDropWatch: a peer the host's gate has waited on for DROP_AFTER_MS
// is declared dropped (LOAD_GRACE_MS for one that has not sent anything yet).
function hostDropWatch(peer, now) {
  const { Net, ls } = peer;
  if (!Net.isHost || !ls || peer.state.over) return;
  if (!ls.isWaiting()) { peer.stallSince = 0; peer.stallSlots = ''; return; }
  const key = ls.waitingOn().join(',');
  if (key !== peer.stallSlots) {
    peer.stallSlots = key;
    peer.stallSince = now;
    return;
  }
  if (!peer.stallSince || now - peer.stallSince < DROP_AFTER_MS) return;
  const heard = ls.debugState().lastHeard;
  let dropped = false;
  for (const slot of ls.waitingOn()) {
    if (peer.mpDropped[slot] || slot === Net.slot) continue;
    if (heard[slot] === undefined && now - peer.stallSince < LOAD_GRACE_MS) continue; // still loading
    dropped = true;
    declareDrop(peer, slot, 'timeout');
  }
  if (dropped) peer.stallSince = 0;
}

// main.js processPendingDrops: a declared drop installs a takeover brain whose
// first think is an absolute tick, so every peer's AI acts on the same tick.
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
      peer.takeovers.push({ slot: d.slot, at: d.at, firstThink: brain.nextThink });
    }
  }
  peer.pendingDrops = remaining;
}

// ---- scripted input -----------------------------------------------------------

function ownMcv(peer) {
  return Object.values(peer.state.units).find((u) => u.owner === peer.slot && u.defId === 'MCV') || null;
}

// A move order for the player's own MCV; `k` (and `row`) pick one of several
// distinct destinations so individual orders can be recognised in the trace.
function mcvMove(peer, k, row = 3) {
  const mcv = ownMcv(peer);
  assert.ok(mcv, peer.tag + ' still has an undeployed MCV');
  const sp = peer.state.map.spawns[peer.slot % peer.state.map.spawns.length];
  return { player: peer.slot, type: 'move', unitIds: [mcv.id], x: (sp.x + 2 + k) * 64 + 32, y: (sp.y + row) * 64 + 32 };
}

function issue(peer, cmd) {
  const tick = peer.state.tick + peer.ls.getDelay();
  peer.issued++;
  peer.orders.push({ tick, cmd, key: JSON.stringify(cmd) });
  peer.ls.issue(cmd);
  return tick;
}

// Deterministic per-tick "human" input, keyed on the SIM tick (the same menu
// as tools/test_lockstep.py): move the MCV, deploy it, queue + place a power
// plant, then periodic stance / production orders.
function runScript(peer) {
  const st = peer.state;
  const t = st.tick;
  const S = peer.script;
  if (S.eachTick) S.eachTick(peer);
  if (S.quiet) return;
  const order = (cmd) => { peer.issued++; peer.ls.issue(cmd); };
  if (S.moveAt === undefined) S.moveAt = 20 + Math.floor(peer.rng() * 40);
  if (S.buildAt === undefined) S.buildAt = 210 + Math.floor(peer.rng() * 30);
  if (!S.moved && t === S.moveAt) {
    S.moved = true;
    const mcv = ownMcv(peer);
    if (mcv) {
      const sp = st.map.spawns[peer.slot % st.map.spawns.length];
      order({
        player: peer.slot, type: 'move', unitIds: [mcv.id],
        x: (sp.x + 2 + Math.floor(peer.rng() * 3)) * 64 + 32,
        y: (sp.y + 2 + Math.floor(peer.rng() * 3)) * 64 + 32,
      });
    }
  }
  if (!S.deployed && t >= 100) {
    S.deployed = true;
    const mcv = ownMcv(peer);
    if (mcv) order({ player: peer.slot, type: 'deployMCV', unitId: mcv.id });
  }
  if (!S.built && t === S.buildAt) {
    S.built = true;
    order({ player: peer.slot, type: 'buildStructure', structId: 'SH-02' });
  }
  const me = st.players[peer.slot];
  if (!S.placed && me.ready.indexOf('SH-02') >= 0) {
    S.placed = true;
    const cy = Object.values(st.structures).find((s) => s.owner === peer.slot && s.defId === 'SH-01');
    if (cy) {
      const spot = Sim.findPlacement(st, peer.slot, st.structDefs['SH-02'], cy.cx, cy.cy, 10);
      if (spot) order({ player: peer.slot, type: 'placeStructure', structId: 'SH-02', cx: spot.x, cy: spot.y });
    }
  }
  if (t >= 300 && t % 37 === 0 && !S['nox' + t]) {
    S['nox' + t] = true;
    const mine = Object.values(st.units).find((u) => u.owner === peer.slot);
    if (mine) order({ player: peer.slot, type: 'setStance', unitIds: [mine.id], stance: Math.floor(peer.rng() * 4) });
    order({ player: peer.slot, type: 'trainUnit', unitId: 'EG-01' });
  }
}

// ---- the frame loop (main.js) -------------------------------------------------

// mpSimStep: hand pending input to the scheduler, then run one tick if the
// gate is open. Records the checksum of every tick this peer executed.
function stepPeer(peer) {
  if (peer.gone || peer.frozen || peer.state.over) return false;
  runScript(peer);
  if (!peer.ls.advance()) return false;
  peer.sums.set(peer.state.tick, Sim.checksum(peer.state));
  return true;
}

// what the frame loop does after stepping
function afterFrame(peer) {
  if (peer.gone || peer.frozen) return;
  hostDropWatch(peer, clock.t);
  processPendingDrops(peer);
}

// one frame: step while the gate is open (capped like MP_STEP_CAP)
function frame(peer, maxSteps = MP_STEP_CAP) {
  let steps = 0;
  while (steps < maxSteps && stepPeer(peer)) steps++;
  afterFrame(peer);
  return steps;
}

// Run the given peers until `done()`; throws (with a gate report) on a stall.
//   default      flat out: every turn of the loop is a frame and 1 virtual ms
//   paced        like the browser: a tick is due every TICK_MS of virtual time;
//                a closed gate holds the accumulator (main.js frame loop)
async function drive(peers, done, { timeoutMs = 60000, maxSteps = MP_STEP_CAP, paceMs = 0, clockStep = 1, paced = false, each } = {}) {
  const started = performance.now();
  for (;;) {
    clock.t += clockStep;
    for (const p of peers) {
      if (p.gone || p.frozen) continue;
      if (!paced) { frame(p, maxSteps); continue; }
      p.acc += clockStep;
      let steps = 0;
      while (p.acc >= TICK_MS && steps < MP_STEP_CAP) {
        if (!stepPeer(p)) break; // gate closed -- the accumulator holds
        p.acc -= TICK_MS;
        steps++;
      }
      afterFrame(p);
    }
    if (each) each();
    if (done()) return;
    if (performance.now() - started > timeoutMs) {
      throw new Error('match stalled: ' + peers.map((p) => p.tag + '@' + p.state.tick
        + (p.gone ? '(gone)' : p.frozen ? '(frozen)' : ' waiting on [' + p.ls.waitingOn() + ']')
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

// ---- deterministic choreography ------------------------------------------------

// Watch a peer's socket (test instrumentation, below the client code): count
// what arrives and catch the relay's answers to our barrier pings.
function instrument(peer) {
  const ws = peer.Net.ws;
  const onmessage = ws.onmessage;
  const onclose = ws.onclose;
  ws.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { /* not ours */ }
    if (m && m.t === 'pong' && peer.pongWaiters.has(m.ts)) {
      const resolve = peer.pongWaiters.get(m.ts);
      peer.pongWaiters.delete(m.ts);
      resolve();
      return;
    }
    peer.inboundCount++;
    onmessage(ev);
  };
  ws.onclose = (ev) => {
    for (const resolve of peer.pongWaiters.values()) resolve();
    peer.pongWaiters.clear();
    if (onclose) onclose(ev);
  };
}

// A socket is ordered: once the relay's pong for this ping is back, everything
// the relay sent this peer earlier has arrived, and everything this peer sent
// earlier has been relayed.
function sync(peer) {
  const ws = peer.Net.ws;
  if (!ws || ws.readyState !== 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ts = 'e2e-sync-' + (++syncSeq);
    const timer = setTimeout(() => reject(new Error('relay barrier timed out for ' + peer.tag)), 10000);
    peer.pongWaiters.set(ts, () => { clearTimeout(timer); resolve(); });
    ws.send(JSON.stringify({ t: 'ping', ts }));
  });
}

// Wait until the network is quiet: every message sent so far (and every
// message those triggered) has been relayed and handed to its recipients.
// Virtual time does not pass.
async function settle(peers) {
  const total = () => peers.reduce((n, p) => n + p.inboundCount, 0);
  for (let round = 0; round < 100; round++) {
    const before = total();
    for (const p of peers) await sync(p);
    if (round >= 1 && total() === before) return;
  }
  throw new Error('relay traffic did not settle');
}

// Step the given peers as far as their gates allow, with the network settled
// between passes (so the result does not depend on message timing).
async function stepUntilHeld(peers, all = peers) {
  for (let pass = 0; pass < 200; pass++) {
    clock.t += 1;
    let moved = false;
    for (const p of peers) if (frame(p) > 0) moved = true;
    await settle(all);
    if (!moved) return;
  }
  throw new Error('peers never came to rest');
}

// The whole machine stops: no frames, and nothing that arrives is processed.
function freeze(peer) { peer.frozen = true; peer.inboundHeld = true; }

// Process everything that queued up while input was held, in arrival order.
function releaseInbound(peer) {
  peer.inboundHeld = false;
  const queue = peer.inboundQueue;
  peer.inboundQueue = [];
  for (const fn of queue) fn();
}

function thaw(peer) { releaseInbound(peer); peer.frozen = false; }

// ticks on which this peer's simulation was handed exactly this command
function appliedTicks(peer, cmd) {
  const key = typeof cmd === 'string' ? cmd : JSON.stringify(cmd);
  return peer.trace.filter((e) => e.cmds && e.cmds.includes(key)).map((e) => e.tick);
}

const forcedTicks = (peer) => peer.trace.filter((e) => e.gate === 'force').length;

// ---- lobby ---------------------------------------------------------------------

// Lobby handshake exactly as the menu drives it: host creates, guests join by
// code and publish their slot, host rebroadcasts the merged lobby, then cfg +
// start (main.js: G.mpHost / G.mpJoin / G.mpStart).
async function lobby(srv, specs, { map, aiPlayers = [], delay = 2, peerOpts = {} }) {
  const peers = [];
  for (let i = 0; i < specs.length; i++) peers.push(await makePeer(specs[i].name, 1000 + i * 11, peerOpts));
  const [host, ...guests] = peers;
  host.Net.name = specs[0].name;
  const created = await host.Net.host({ url: srv.wsUrl, name: specs[0].name });
  assert.deepEqual(created, { ok: true, slot: 0, host: true, code: host.Net.code });
  instrument(host);
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
    instrument(g);
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

// Three humans whose input is choreographed by the test (scripts start quiet).
async function threeHumans(t, peerOpts = {}) {
  const srv = await startServer({ RATE_MSGS_PER_SEC: '20000', RATE_BURST: '20000' });
  t.after(() => srv.close());
  const peers = await lobby(srv, [
    { name: 'Host', faction: 'Egypt' },
    { name: 'Bob', faction: 'Turkey' },
    { name: 'Carol', faction: 'Iran' },
  ], { map: pickMap(3, 'gulf'), peerOpts });
  t.after(() => { for (const p of peers) p.Net.leave(); });
  for (const p of peers) p.script.quiet = true;
  await drive(peers, () => peers.every((p) => p.state.tick >= 40));
  await settle(peers);
  return { srv, peers };
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

// first tick on which two peers' recorded checksums differ (or -1)
function firstDivergence(a, b) {
  const ticks = [...a.sums.keys()].filter((tk) => b.sums.has(tk)).sort((x, y) => x - y);
  for (const tk of ticks) if (a.sums.get(tk) !== b.sums.get(tk)) return tk;
  return -1;
}

// The csum messages each peer sent through the relay, by tick.
function wireChecksums(peer) {
  const out = new Map();
  for (const m of peer.sent) if (m.t === 'csum') out.set(m.tick, m.sum);
  return out;
}

describe('headless lockstep matches through the Node relay', () => {
  test('2 humans + 1 AI: 600 ticks, identical checksums, zero desyncs, zero forced ticks', async (t) => {
    // The match runs flat out (hundreds of ticks per second), far above the
    // 10 Hz the per-connection limiter is sized for, so this server gets a
    // raised message budget. The real-time test below uses the defaults.
    const srv = await startServer({ RATE_MSGS_PER_SEC: '20000', RATE_BURST: '20000' });
    t.after(() => srv.close());
    const TARGET = 600;
    const [host, guest] = await lobby(srv, [
      { name: 'Host', faction: 'Egypt' },
      { name: 'Guest', faction: 'Algeria' },
    ], { map: pickMap(3, 'sinai'), aiPlayers: [{ slot: 2, faction: 'Israel', team: 2, ai: { personality: 'Front', difficulty: 'recruit' } }] });
    t.after(() => { host.Net.leave(); guest.Net.leave(); });
    const mapId = host.Net.cfg.map;
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
      assert.deepEqual(p.ls.stats, { stallWaits: 0, forcedSteps: 0, desyncs: 0 }, p.tag + ' never forced a tick');
      assert.equal(p.lost, 0, p.tag + ' lost no game message before its scheduler existed');
      assert.deepEqual(p.errors, []);
      assert.deepEqual(p.drops, []);
      assert.equal(p.closed, false);
    }
    assert.deepEqual(host.declared, [], 'the host never gave up on anyone');
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
    t.diagnostic(`map=${mapId} ticks=${host.state.tick}/${guest.state.tick} checksums compared=${compared} wire boundaries=${boundaries} `
      + `cmds=${host.issued}+${guest.issued} relayed in=${srv.app.relay.counters.messagesIn} out=${srv.app.relay.counters.messagesOut}`);
  });

  test('negative control: a real divergence IS detected through the relay', async (t) => {
    const srv = await startServer({ RATE_MSGS_PER_SEC: '20000', RATE_BURST: '20000' });
    t.after(() => srv.close());
    const [host, guest] = await lobby(srv, [
      { name: 'Host', faction: 'Egypt' },
      { name: 'Cheater', faction: 'Algeria' },
    ], { map: pickMap(2, 'duel') });
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

  test('3 humans: one disconnects mid-match -> bye -> host declares the takeover -> the rest stay in sync', async (t) => {
    const srv = await startServer({ RATE_MSGS_PER_SEC: '20000', RATE_BURST: '20000' });
    t.after(() => srv.close());
    const [host, bob, carol] = await lobby(srv, [
      { name: 'Host', faction: 'Egypt' },
      { name: 'Bob', faction: 'Turkey' },
      { name: 'Carol', faction: 'Iran' },
    ], { map: pickMap(3, 'gulf') });
    t.after(() => { for (const p of [host, bob, carol]) p.Net.leave(); });

    await drive([host, bob, carol], () => [host, bob, carol].every((p) => p.state.tick >= 200));
    assertSameHistory(host, bob, 200);
    assertSameHistory(host, carol, 200);
    const carolLast = carol.state.tick;
    carol.gone = true;
    carol.Net.ws.close(); // the connection dies; no graceful leave message

    await until(() => host.byes.length > 0 && bob.byes.length > 0, 'bye to reach the others');
    assert.deepEqual(host.byes, [{ slot: 2, reason: 'disconnected' }]);
    assert.deepEqual(bob.byes, [{ slot: 2, reason: 'disconnected' }]);

    await drive([host, bob, carol], () => host.state.tick >= 450 && bob.state.tick >= 450);
    assert.equal(host.declared.length, 1);
    assert.equal(host.declared[0].why, 'bye');
    const at = host.declared[0].at;
    assert.ok(at >= carolLast + TAKEOVER_DELAY_TICKS, 'the drop line lies beyond anything Carol sent input for');
    assert.deepEqual(bob.drops.map((d) => [d.slot, d.at]), [[2, at]]);
    assert.ok(bob.drops[0].tick < at && host.drops[0].tick < at, 'both learned of the drop before reaching its tick');
    assert.ok(host.ls.isDropped(2) && bob.ls.isDropped(2));
    assert.deepEqual(host.takeovers, bob.takeovers, 'the AI takes over on the same tick everywhere');
    assert.deepEqual(host.takeovers.map((x) => [x.slot, x.at]), [[2, at]]);
    assert.equal(host.state.players[2].aiTakeover, true);
    assert.equal(bob.state.players[2].aiTakeover, true);
    assert.equal(host.desync, null);
    assert.equal(bob.desync, null);
    const compared = assertSameHistory(host, bob, 450);
    assert.deepEqual(entityCounts(host.state), entityCounts(bob.state));
    for (const p of [host, bob]) assert.deepEqual(p.ls.stats, { stallWaits: 0, forcedSteps: 0, desyncs: 0 });
    assert.deepEqual((await http(srv.origin + '/api/stats')).json.online, 2);
    t.diagnostic(`carol disconnected at tick ${carolLast}; drop line ${at}; host/bob continued to ${host.state.tick}/${bob.state.tick}, ${compared} checksums compared`);
  });

  test('6 humans at the real 10 Hz tick rate under DEFAULT limits: nobody is throttled', async (t) => {
    const srv = await startServer(); // stock configuration, as deployed
    t.after(() => srv.close());
    const factions = ['Egypt', 'Saudi', 'UAE', 'Algeria', 'Turkey', 'Israel'];
    const peers = await lobby(srv, factions.map((faction, i) => ({ name: 'P' + (i + 1), faction })), { map: pickMap(6, 'gulf'), delay: 2 });
    t.after(() => { for (const p of peers) p.Net.leave(); });
    assert.equal(peers.length, 6);
    for (const p of peers) { p.script.moveAt = 5 + p.slot; p.Net._peerPingTimer = -1e9; }

    // Real-time pacing, as in main.js's frame loop: every ~16 ms "frame" adds
    // the elapsed time to a per-peer accumulator; a tick runs when 100 ms are
    // due AND the lockstep gate is open (otherwise the accumulator holds).
    const TARGET = 30;
    const started = performance.now();
    let last = started;
    const real = new Map(peers.map((p) => [p, 0]));
    await drive(peers, () => peers.every((p) => p.state.tick >= TARGET), {
      paceMs: 16,
      maxSteps: 0, // stepping happens in each(), on the real-time accumulator
      each: () => {
        const now = performance.now();
        const dt = Math.min(250, now - last);
        last = now;
        for (const p of peers) {
          p.Net.netTick();
          let acc = real.get(p) + dt;
          let steps = 0;
          while (acc >= TICK_MS && steps < MP_STEP_CAP) {
            if (!stepPeer(p)) break; // gate closed -- hold the accumulator
            acc -= TICK_MS;
            steps++;
          }
          real.set(p, acc);
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
      assert.deepEqual(p.drops, []);
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

// ---------------------------------------------------------------------------------
// The v1.0 scheduler rules: the gate ALWAYS waits for a missing peer, and a
// drop takes effect on a host-chosen tick that no machine has reached.
// ---------------------------------------------------------------------------------

// Shared choreography for "Carol's machine freezes for 4 s, then she comes
// back and the first thing her frame does is issue an order".
async function freezeAndReturn(t, peerOpts) {
  const { peers } = await threeHumans(t, peerOpts);
  const [host, bob, carol] = peers;
  freeze(carol);
  await stepUntilHeld([host, bob], peers); // the others use up whatever input of hers they already hold
  const S = carol.state.tick;
  const rest = { host: host.state.tick, bob: bob.state.tick };
  assert.ok(rest.host <= S + 1 && rest.bob <= S + 1, 'nobody can get past the first tick Carol sent nothing for');

  // 4 s pass: far beyond the old 1.5 s "force the tick" rule, well short of the host's drop timeout
  const FREEZE_MS = 4000;
  assert.ok(FREEZE_MS > 2 * STALL_TIMEOUT_MS && FREEZE_MS < DROP_AFTER_MS);
  const thawAt = clock.t + FREEZE_MS;
  await drive([host, bob], () => clock.t >= thawAt, { paced: true, clockStep: 10 });
  const during = { host: host.state.tick, bob: bob.state.tick, forced: forcedTicks(host) + forcedTicks(bob) };

  // she is back: her frame hands her order to the scheduler before anything else happens
  const cmd = mcvMove(carol, 1);
  const stamped = issue(carol, cmd);
  thaw(carol);
  return { peers, host, bob, carol, S, rest, during, cmd, stamped };
}

describe('lockstep v1.0 rules: waiting and tick-aligned drops', () => {
  test('A. a frozen peer comes back and issues a command while catching up: everyone waited, nobody desyncs', async (t) => {
    const { peers, host, bob, carol, S, rest, during, cmd, stamped } = await freezeAndReturn(t, {});

    // while she was gone the others HELD: no tick ran, nothing was forced, nobody was dropped
    assert.deepEqual({ host: during.host, bob: during.bob }, rest, 'ticks did not advance during the freeze');
    assert.equal(during.forced, 0);
    for (const p of [host, bob]) {
      assert.equal(p.ls.stats.forcedSteps, 0);
      assert.ok(p.trace.some((e) => e.gate === 'hold' && e.missing.includes(2)), p.tag + ' was holding for Carol');
    }
    assert.deepEqual(host.declared, [], 'a 4 s freeze is not a drop');
    assert.equal(stamped, S + carol.ls.getDelay(), 'her order is stamped from the tick she froze on');
    assert.ok(stamped > rest.host && stamped > rest.bob, 'which nobody has run yet, because they waited');

    for (const p of peers) p.script.quiet = false; // from here on a normal scripted match
    const TARGET = S + 260;
    await drive(peers, () => peers.every((p) => p.state.tick >= TARGET));

    for (const p of peers) {
      assert.equal(p.desync, null, p.tag + ' reported a desync');
      assert.deepEqual(p.ls.stats, { stallWaits: 0, forcedSteps: 0, desyncs: 0 });
      assert.deepEqual(appliedTicks(p, cmd), [stamped], p.tag + ' applied her order on its stamped tick');
      assert.deepEqual(p.drops, []);
    }
    const ab = assertSameHistory(host, bob, TARGET);
    const ac = assertSameHistory(host, carol, TARGET - 5);
    assert.deepEqual(entityCounts(host.state), entityCounts(carol.state));
    t.diagnostic(`Carol froze at tick ${S} for 4000 virtual ms; others held at ${rest.host}/${rest.bob}; her order ran on tick ${stamped} everywhere; `
      + `${ab}+${ac} checksums compared up to tick ${TARGET}`);
  });

  test('A (old rule). the same scenario with forceOnSilence DOES desync -- the fix is what keeps test A green', async (t) => {
    const { peers, host, bob, carol, S, rest, during, cmd, stamped } = await freezeAndReturn(t, { forceOnSilence: true });

    // under the old rule the others forced ticks without her after 1.5 s of silence...
    assert.ok(during.forced > 0, 'ticks were forced');
    assert.ok(during.host >= rest.host + 15 && during.bob >= rest.bob + 15, `host/bob ran ahead: ${during.host}/${during.bob} from ${rest.host}/${rest.bob}`);
    assert.ok(stamped < during.host && stamped < during.bob, 'so her order is stamped for a tick they have already left behind');

    await drive(peers, () => peers.some((p) => p.desync) || peers.every((p) => p.state.tick >= S + 150));

    // ...she applied her own order, they threw it away as stale, and the checksums caught it
    assert.deepEqual(appliedTicks(carol, cmd), [stamped]);
    assert.deepEqual(appliedTicks(host, cmd), []);
    assert.deepEqual(appliedTicks(bob, cmd), []);
    const info = peers.map((p) => p.desync).find(Boolean);
    assert.ok(info, 'the divergence was detected');
    assert.equal(info.tick % CSUM_EVERY, 0);
    assert.ok(info.tick > stamped);
    assert.equal(firstDivergence(host, carol), stamped + 1, 'Carol and the host part ways on the tick her order ran');
    assert.equal(firstDivergence(host, bob), -1, 'host and Bob (who forced together) still agree with each other');
    t.diagnostic(`old rule: host/bob forced ${during.forced} ticks to ${during.host}/${during.bob}; Carol's order for tick ${stamped} was stale for them; `
      + `desync reported at checksum tick ${info.tick}`);
  });

  // Carol gives an order on every tick, each for a different spot, so that at
  // any moment she has orders "in flight" for the next ticks.
  function orderEveryTick(carol) {
    carol.script.eachTick = (p) => {
      if (p.script.lastOrderTick === p.state.tick) return;
      p.script.lastOrderTick = p.state.tick;
      issue(p, mcvMove(p, p.state.tick % 6));
    };
  }

  // Bring the room to: Bob one tick behind (his link lags: he has announced
  // tick T but not run it), host and Carol on T+1, Carol's orders for T+1,
  // T+2 and T+3 delivered to everyone and run by no one -- then Carol's
  // connection dies.
  async function dropWithOrdersInFlight(t, peerOpts) {
    const { peers } = await threeHumans(t, peerOpts);
    const [host, bob, carol] = peers;
    orderEveryTick(carol);
    await drive(peers, () => peers.every((p) => p.state.tick >= 50));
    await settle(peers);

    bob.inboundHeld = true; // from now on what the relay sends Bob reaches him late
    await stepUntilHeld(peers);
    const T = bob.state.tick;
    assert.equal(host.state.tick, T + 1);
    assert.equal(carol.state.tick, T + 1);
    const inFlight = carol.orders.filter((o) => o.tick > T);
    assert.deepEqual(inFlight.map((o) => o.tick), [T + 1, T + 2, T + 3]);
    assert.equal(new Set(inFlight.map((o) => o.key)).size, 3, 'three distinguishable orders');
    for (const p of [host, bob]) for (const o of inFlight) assert.deepEqual(appliedTicks(p, o.key).filter((tk) => tk > T), [], 'not run yet');

    carol.gone = true;
    carol.Net.ws.close(); // abrupt: no leave message, her last orders are all the room will ever get
    await until(() => host.byes.length > 0, 'the host to learn Carol is gone');
    await settle([host, bob]);

    // the host declared the drop on tick T+1; Bob will learn of it on tick T
    assert.equal(host.declared.length, 1);
    assert.equal(host.declared[0].why, 'bye');
    assert.equal(host.declared[0].tick, T + 1);
    assert.equal(host.state.tick, T + 1);
    assert.equal(bob.state.tick, T);
    assert.equal(bob.ls.isDropped(2), false, 'the declaration has not reached Bob yet');
    releaseInbound(bob);
    assert.deepEqual(bob.drops.map((d) => [d.slot, d.at, d.tick]), [[2, host.declared[0].at, T]]);
    assert.deepEqual(host.drops.map((d) => [d.slot, d.at, d.tick]), [[2, host.declared[0].at, T + 1]]);

    for (const p of [host, bob]) p.script.quiet = false;
    const at = host.declared[0].at;
    const TARGET = Math.max(at, T + 3) + 160;
    await drive([host, bob], () => host.state.tick >= TARGET && bob.state.tick >= TARGET);
    return { host, bob, carol, T, at, inFlight, TARGET };
  }

  test('B. a dropped player had commands in flight while the others were on DIFFERENT ticks: applied identically, takeover in sync', async (t) => {
    const { host, bob, carol, T, at, inFlight, TARGET } = await dropWithOrdersInFlight(t, {});

    // main.js rule: the line is beyond everything Carol ever sent input for
    assert.equal(at, T + 3 + 1 + TAKEOVER_DELAY_TICKS, 'safeDropTick = her highest stamped tick + 1');
    assert.ok(Math.max(...carol.orders.map((o) => o.tick)) < at, 'so none of her orders can sit at or beyond the line');
    // every in-flight order ran on its stamped tick on BOTH machines
    for (const o of inFlight) {
      for (const p of [host, bob]) assert.ok(appliedTicks(p, o.key).includes(o.tick), `${p.tag} ran Carol's order for tick ${o.tick}`);
    }
    // and nothing of hers ran from the line on (the AI's orders are different commands)
    const hers = new Set(carol.orders.map((o) => o.key));
    for (const p of [host, bob]) {
      assert.deepEqual(p.trace.filter((e) => e.cmds && e.tick >= at && e.cmds.some((c) => hers.has(c))), []);
    }
    assert.deepEqual(host.takeovers, bob.takeovers);
    assert.deepEqual(host.takeovers.map((x) => [x.slot, x.at, x.firstThink > at]), [[2, at, true]]);
    for (const p of [host, bob]) {
      assert.equal(p.desync, null);
      assert.deepEqual(p.ls.stats, { stallWaits: 0, forcedSteps: 0, desyncs: 0 });
      assert.equal(p.state.players[2].aiTakeover, true);
    }
    const compared = assertSameHistory(host, bob, TARGET);
    assert.deepEqual(entityCounts(host.state), entityCounts(bob.state));
    t.diagnostic(`Carol died with orders for ticks ${T + 1},${T + 2},${T + 3} in flight; host declared on tick ${T + 1}, Bob heard on tick ${T}; `
      + `line ${at}; all three orders ran on both; ${compared} checksums compared to tick ${TARGET}`);
  });

  test('B (rule level). a drop line that cuts THROUGH the in-flight commands: below it applied on both, at or above it on neither', async (t) => {
    // Not reachable through main.js (safeDropTick always puts the line past the
    // last order): the host is made to declare `its tick + 1` to exercise the
    // scheduler's "apply below the line, ignore from the line on" rule itself.
    const { host, bob, T, at, inFlight, TARGET } = await dropWithOrdersInFlight(t, { dropAt: (peer) => peer.state.tick + 1 });
    assert.equal(at, T + 2);
    const [below, onLine, above] = inFlight; // stamped T+1, T+2, T+3
    for (const p of [host, bob]) {
      assert.deepEqual(appliedTicks(p, below.key).filter((tk) => tk > T), [T + 1], `${p.tag}: the order below the line ran`);
      assert.deepEqual(appliedTicks(p, onLine.key).filter((tk) => tk > T), [], `${p.tag}: the order ON the line was ignored`);
      assert.deepEqual(appliedTicks(p, above.key).filter((tk) => tk > T), [], `${p.tag}: the order above the line was ignored`);
      assert.equal(p.desync, null);
      assert.equal(p.ls.stats.forcedSteps, 0);
    }
    assert.deepEqual(host.takeovers, bob.takeovers);
    assertSameHistory(host, bob, TARGET);
  });

  test('C. a peer freezes for good while still connected: the others hold, the host times it out, the AI takes over on one tick', async (t) => {
    const { peers } = await threeHumans(t, {});
    const [host, bob, carol] = peers;

    // one last order from Carol, delivered to everyone, then her machine locks up
    const cmd = mcvMove(carol, 2);
    const stamped = issue(carol, cmd);
    await settle(peers);
    const t0 = clock.t;
    freeze(carol);
    await stepUntilHeld([host, bob], peers);
    const rest = { host: host.state.tick, bob: bob.state.tick };
    assert.ok(stamped > rest.host && stamped > rest.bob, 'her last order is still in flight');

    // almost the whole timeout: still waiting, nothing forced, nobody dropped
    await drive([host, bob], () => clock.t >= t0 + DROP_AFTER_MS - 500, { paced: true, clockStep: 20 });
    assert.deepEqual({ host: host.state.tick, bob: bob.state.tick }, rest);
    assert.deepEqual(host.declared, []);
    assert.equal(forcedTicks(host) + forcedTicks(bob), 0);
    assert.deepEqual(host.ls.waitingOn(), [2]);

    // then the host gives up on her
    await drive([host, bob], () => host.declared.length > 0, { paced: true, clockStep: 20, timeoutMs: 20000 });
    const decl = host.declared[0];
    assert.equal(decl.why, 'timeout');
    assert.equal(decl.slot, 2);
    const waited = decl.clock - t0;
    assert.ok(waited >= DROP_AFTER_MS && waited <= DROP_AFTER_MS + 300, `declared after ${waited} virtual ms`);
    assert.equal(decl.tick, rest.host, 'no tick ran while waiting');
    assert.equal(decl.at, Math.max(rest.host, stamped + 1) + TAKEOVER_DELAY_TICKS, 'line = safe tick (past her last order) + takeover delay');
    await settle(peers);
    assert.deepEqual(bob.drops.map((d) => [d.slot, d.at]), [[2, decl.at]]);

    for (const p of [host, bob]) p.script.quiet = false;
    const TARGET = decl.at + 220;
    await drive([host, bob], () => host.state.tick >= TARGET && bob.state.tick >= TARGET);

    for (const p of [host, bob]) {
      assert.deepEqual(appliedTicks(p, cmd), [stamped], p.tag + ' still ran the order she gave before freezing (it is below the line)');
      assert.equal(p.desync, null);
      assert.deepEqual(p.ls.stats, { stallWaits: 0, forcedSteps: 0, desyncs: 0 });
      assert.equal(p.state.players[2].aiTakeover, true);
    }
    assert.deepEqual(host.takeovers, bob.takeovers, 'same takeover tick, same first AI think');
    assert.deepEqual(host.takeovers.map((x) => [x.slot, x.at]), [[2, decl.at]]);
    const compared = assertSameHistory(host, bob, TARGET);
    assert.deepEqual(entityCounts(host.state), entityCounts(bob.state));
    const aiActed = host.trace.some((e) => e.cmds && e.tick >= decl.at && e.cmds.some((c) => c.includes('"player":2')));
    assert.ok(aiActed, 'the takeover AI really commands slot 2 afterwards');

    // much later her machine wakes up: she learns she was dropped and stops taking part
    const carolTick = carol.state.tick;
    thaw(carol);
    assert.equal(carol.selfDropped, true);
    assert.equal(carol.gone, true);
    await until(() => !carol.Net.active, 'Carol to leave');
    await until(() => host.byes.length > 0, 'her departure to reach the host');
    await settle([host, bob]);
    assert.equal(host.declared.length, 1, 'her leaving does not produce a second declaration');
    await drive([host, bob], () => host.state.tick >= TARGET + 30 && bob.state.tick >= TARGET + 30);
    assert.equal(carol.state.tick, carolTick, 'she ran no further tick');
    assertSameHistory(host, bob, TARGET + 30);
    assert.equal(host.desync, null);
    t.diagnostic(`Carol froze at tick ${carolTick}; host waited ${waited} virtual ms, declared line ${decl.at} on tick ${decl.tick}; `
      + `${compared} checksums compared to tick ${TARGET}`);
  });

  test('D. timed-out peer wakes up inside the host\'s network round trip and issues a command', async (t) => {
    // The one ordering the v1.0 rules do not cover (see the subtest below).
    // Carol has been frozen for almost DROP_AFTER_MS. She wakes up and issues
    // an order a moment before the host's timeout fires; the order reaches the
    // relay -- and Bob -- BEFORE the host's declaration does, but reaches the
    // host only AFTER it has declared (any real link has that latency).
    const { peers } = await threeHumans(t, {});
    const [host, bob, carol] = peers;
    freeze(carol);
    await stepUntilHeld([host, bob], peers);
    const S = carol.state.tick;
    await drive([host, bob], () => host.stallSince > 0 && clock.t - host.stallSince >= DROP_AFTER_MS - 20, { paced: true, clockStep: 10 });
    assert.deepEqual(host.declared, []);
    assert.equal(host.state.tick, S + 1);
    assert.equal(bob.state.tick, S + 1);

    host.inboundHeld = true;           // the host's downlink: what the relay sends now arrives a moment later
    const cmd = mcvMove(carol, 1);
    const stamped = issue(carol, cmd); // Carol's first frame after waking up
    thaw(carol);
    await settle(peers);               // her order is at the relay, has reached Bob, is in transit to the host
    assert.equal(host.declared.length, 0);

    await drive([host], () => host.declared.length > 0, { paced: true, clockStep: 10, timeoutMs: 20000 });
    const decl = host.declared[0];     // the timeout fires on the host
    assert.equal(decl.why, 'timeout');
    await settle(peers);               // the declaration reaches Bob (after her order) and Carol
    releaseInbound(host);              // her order finally reaches the host, which has already dropped her
    assert.equal(carol.selfDropped, true);

    // the facts of the scenario, independent of how the scheduler resolves it
    assert.equal(decl.at, S + 1 + TAKEOVER_DELAY_TICKS, 'the host drew the line without knowing about her new order');
    assert.ok(stamped < decl.at, `her order (tick ${stamped}) sits BELOW the line (${decl.at})`);
    assert.deepEqual(bob.drops.map((d) => d.at), [decl.at]);

    for (const p of [host, bob]) p.script.quiet = false;
    await drive([host, bob], () => !!(host.desync || bob.desync) || (host.state.tick >= decl.at + 80 && bob.state.tick >= decl.at + 80));
    const onHost = appliedTicks(host, cmd);
    const onBob = appliedTicks(bob, cmd);
    const split = firstDivergence(host, bob);
    t.diagnostic(`Carol frozen at tick ${S}; her order stamped ${stamped}; host line ${decl.at}; `
      + `order ran on host at [${onHost}] and on Bob at [${onBob}]; first differing checksum at tick ${split}; `
      + `desync reported: ${JSON.stringify(host.desync || bob.desync)}`);

    await t.test('host and the remaining peer treat that order the same way and stay in sync', {
      todo: 'known race in the v1.0 drop rule: the host discards a dropped slot\'s messages on receipt, the other peers '
        + 'keep the ones they received before the declaration (below the line). Needs a cut-off every peer agrees on, '
        + 'e.g. the host\'s last-seen seq for that slot carried in the drop message.',
    }, () => {
      assert.deepEqual(onHost, onBob, 'the order must run on both or on neither');
      assert.equal(split, -1, 'checksums diverged at tick ' + split);
      assert.equal(host.desync, null);
      assert.equal(bob.desync, null);
    });
  });

  // ---- "the first command for a tick lets it run" -----------------------------
  // ready(t) treats ONE command from a peer for tick t as that peer's complete
  // input for t. But a peer can keep issuing commands for tick t for as long
  // as it sits on tick t - delay (main.js issues pending input on every frame,
  // also while its gate is closed). A peer that is running on a backlog (its
  // accumulator is never shed in multiplayer, so any earlier wait leaves one)
  // executes tick t the moment that first command arrives -- and discards
  // every later command for t as stale. This predates v1.0; "always wait"
  // makes backlogs routine.
  async function clickerAndBackloggedPeer(t) {
    const srv = await startServer({ RATE_MSGS_PER_SEC: '20000', RATE_BURST: '20000' });
    t.after(() => srv.close());
    const peers = await lobby(srv, [
      { name: 'Rita', faction: 'Egypt' },
      { name: 'Carl', faction: 'Algeria' },
    ], { map: pickMap(2, 'duel') });
    t.after(() => { for (const p of peers) p.Net.leave(); });
    const [rita, carl] = peers;
    for (const p of peers) p.script.quiet = true;
    orderEveryTick(carl); // Carl is clicking: one order per tick, each stamped tick + delay
    await drive(peers, () => peers.every((p) => p.state.tick >= 40));
    await settle(peers);
    return { peers, rita, carl };
  }

  async function reportStaleCommand(t, { peers, rita, carl, late, X }) {
    carl.script.eachTick = null;
    await drive(peers, () => peers.some((p) => p.desync) || peers.every((p) => p.state.tick >= X + 60));
    const onCarl = appliedTicks(carl, late);
    const onRita = appliedTicks(rita, late);
    const split = firstDivergence(rita, carl);
    assert.deepEqual(onCarl, [X], 'Carl ran his own order on its stamped tick');
    t.diagnostic(`Carl's extra order for tick ${X} ran on Carl at [${onCarl}] and on Rita at [${onRita}]; `
      + `first differing checksum at tick ${split}; desync reported: ${JSON.stringify(rita.desync || carl.desync)}`);
    await t.test('both peers run that order on the same tick and stay in sync', {
      todo: 'known hazard (older than v1.0): one command for tick t is taken as the sender\'s complete input for t, '
        + 'so a backlogged peer runs t and then drops the sender\'s later commands for t as stale. Needs an explicit '
        + 'per-tick end-of-input marker (sent when the sender leaves tick t - delay) that the gate waits for.',
    }, () => {
      assert.deepEqual(onRita, onCarl, 'the order must run on both');
      assert.equal(split, -1, 'checksums diverged at tick ' + split);
      assert.equal(rita.desync, null);
      assert.equal(carl.desync, null);
    });
  }

  test('E. a second command for the same tick, issued one frame later while the other peer\'s answer is in transit', async (t) => {
    const { peers, rita, carl } = await clickerAndBackloggedPeer(t);
    carl.inboundHeld = true;     // Carl's downlink: what Rita sends reaches him a moment later
    await stepUntilHeld(peers);  // both run as far as their inputs allow (a backlog: up to MP_STEP_CAP ticks per frame)
    const c = carl.state.tick;   // Carl waits here for Rita's input, which is in transit
    const X = c + carl.ls.getDelay();
    assert.deepEqual(carl.orders.filter((o) => o.tick > c).map((o) => o.tick), [c + 1, X], 'he has one order out for each of the next ticks');
    assert.equal(rita.state.tick, X + 1, 'Rita has already RUN tick X: his first order for it was all her gate asked for');

    const late = mcvMove(carl, 2, 5);
    assert.equal(issue(carl, late), X, 'his next frame, still on the same tick: another order, also stamped X');
    await settle(peers);         // it reaches Rita, who is past X
    releaseInbound(carl);
    await reportStaleCommand(t, { peers, rita, carl, late, X });
  });

  test('E2. two commands for one tick issued in the SAME frame, when the receiver\'s frame falls between the two messages', async (t) => {
    const { peers, rita, carl } = await clickerAndBackloggedPeer(t);
    rita.inboundHeld = true;     // look at Rita's incoming messages one at a time
    await stepUntilHeld(peers);
    assert.equal(rita.inboundQueue.length, 0);
    const c = carl.state.tick;
    const X = c + carl.ls.getDelay();
    // one frame on Carl: two orders, back to back, both stamped X
    const first = mcvMove(carl, 1, 5);
    const late = mcvMove(carl, 2, 5);
    carl.script.eachTick = null;
    assert.equal(issue(carl, first), X);
    assert.equal(issue(carl, late), X);
    await settle(peers);
    assert.ok(rita.inboundQueue.length >= 2, 'both messages are waiting at Rita');
    const before = rita.state.tick;
    while (rita.inboundQueue.length && appliedTicks(rita, first).length === 0) {
      rita.inboundQueue.shift()(); // one message is processed...
      frame(rita);                 // ...and a frame runs before the next one
    }
    assert.ok(before <= X && rita.state.tick === X + 1, 'Rita ran tick X as soon as the first of the two orders was in');
    releaseInbound(rita);
    await reportStaleCommand(t, { peers, rita, carl, late, X });
  });
});

describe('the harness mirrors the real client', () => {
  test('main.js still uses the rules emulated above (update this file when it changes)', () => {
    for (const [name, value] of Object.entries({ TICK_MS, DROP_AFTER_MS, LOAD_GRACE_MS, TAKEOVER_DELAY_TICKS })) {
      assert.ok(Number.isInteger(value) && value > 0, 'main.js no longer defines "const ' + name + ' = <number>;"');
    }
    assert.equal(TICK_MS, 100);
    assert.ok(DROP_AFTER_MS > 2 * STALL_TIMEOUT_MS, 'the freeze tests assume a drop timeout well above the old force timeout');
    // both declaration sites draw the line at safeDropTick + TAKEOVER_DELAY_TICKS
    const sites = MAIN_SRC.match(/Net\.sendDrop\(\s*slot\s*,\s*G\.ls\.safeDropTick\(slot\)\s*\+\s*TAKEOVER_DELAY_TICKS\s*\)/g) || [];
    assert.equal(sites.length, 2, 'expected the drop line rule in onBye and in hostDropWatch');
    assert.equal((MAIN_SRC.match(/Net\.sendDrop\(/g) || []).length, 2, 'a new drop declaration site appeared in main.js');
    assert.match(MAIN_SRC, /onBye:[\s\S]{0,200}Net\.isHost[\s\S]{0,80}!G\.mpDropped\[slot\]/, 'onBye: host only, once per slot');
    assert.match(MAIN_SRC, /now - G\.mpStallSince < DROP_AFTER_MS/, 'hostDropWatch timeout');
    assert.match(MAIN_SRC, /heard\[slot\] === undefined && now - G\.mpStallSince < LOAD_GRACE_MS/, 'hostDropWatch loading grace');
    assert.match(MAIN_SRC, /if \(m\.slot === G\.playerSlot\) \{[\s\S]{0,400}leaveMpToMenu\(\)/, 'a peer dropped by the host leaves');
    assert.match(MAIN_SRC, /brain\.nextThink = d\.at \+ brain\.interval/, 'takeover brain aligned on the drop tick');
    assert.ok(!/forceOnSilence/.test(MAIN_SRC), 'live play must not enable forceOnSilence');
    // the scheduler API the harness relies on
    for (const name of ['safeDropTick', 'isWaiting', 'waitingOn', 'debugState', 'isDropped', 'getDelay']) {
      assert.match(LOCKSTEP_SRC, new RegExp('\\b' + name + '\\b'), 'lockstep.js no longer exposes ' + name);
    }
    assert.match(LOCKSTEP_SRC, /const forceOnSilence = !!opts\.forceOnSilence/);
  });
});
