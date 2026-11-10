// End-to-end: complete headless lockstep matches through the Node relay.
//
// Nothing is mocked. Each peer is the REAL client networking stack --
// client/src/net/net.js (on Node's built-in browser-compatible WebSocket),
// client/src/net/lockstep.js and the real simulation (client/src/sim) --
// talking to the real server over real sockets. The lobby handshake, cfg/start
// and the match itself follow the same sequence main.js runs in the browser.
// main.js itself cannot be imported headlessly, so:
//   * its drop logic -- hostDropWatch() and processPendingDrops() -- is lifted
//     out of the source text and RUN AS IT IS for every peer (whatever those
//     functions do today is what these tests exercise);
//   * its frame loop and its small inline hooks (onBye, onPeerDrop) are
//     re-stated below, and a guard test at the end of this file fails when
//     main.js stops matching them.
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
import { createLockstep, CSUM_EVERY, KEEPALIVE_MS, MP_STEP_CAP, STALL_TIMEOUT_MS } from '../../client/src/net/lockstep.js';
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

// The source of a top-level function of main.js, or null.
function mainFunction(name) {
  const m = new RegExp('^function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?^\\}', 'm').exec(MAIN_SRC);
  return m ? m[0] : null;
}
const REAL_SOURCE = {
  hostDropWatch: mainFunction('hostDropWatch'),
  processPendingDrops: mainFunction('processPendingDrops'),
};

// Give a peer its own copies of those functions, closed over a `G` that maps
// main.js's game object onto the peer, the peer's Net, and the virtual clock.
function bindMainJs(peer) {
  const G = {
    get ls() { return peer.ls; },
    get state() { return peer.state; },
    get ai() { return peer.ai; },
    get playerSlot() { return peer.slot; },
    get paused() { return peer.paused; },
    worldPending: 0, cinema: null,
    mpDropped: {}, mpStallSince: 0, mpStallSlots: '', mpWaitNote: null, mpPendingDrops: [],
  };
  const scope = {
    G, Net: peer.Net, Sim, DROP_AFTER_MS, LOAD_GRACE_MS, TAKEOVER_DELAY_TICKS,
    showHint: () => {}, mpNameOf: (slot) => 'P' + (slot + 1),
    performance: { now: () => clock.t },
  };
  const compile = (name) => {
    if (!REAL_SOURCE[name]) return null;
    const fn = new Function(...Object.keys(scope), REAL_SOURCE[name] + '\nreturn ' + name + ';')(...Object.values(scope));
    return (...args) => {
      try { return fn(...args); } catch (e) {
        if (e instanceof ReferenceError) {
          throw new Error('main.js ' + name + '() now uses something this harness does not provide (' + e.message
            + '): extend bindMainJs() in server/test/lockstep.e2e.test.mjs');
        }
        throw e;
      }
    };
  };
  peer.G = G;
  peer.real = { hostDropWatch: compile('hostDropWatch'), processPendingDrops: compile('processPendingDrops') };

  // observe (and, for rule-level tests, steer) what the host declares
  const sendDrop = peer.Net.sendDrop.bind(peer.Net);
  peer.Net.sendDrop = (slot, at) => {
    if (peer.opts.dropAt) at = peer.opts.dropAt(peer, slot);
    peer.declared.push({ slot, at, why: peer.declaring, tick: peer.state.tick, clock: clock.t });
    sendDrop(slot, at);
  };
}

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
    heard: [],            // every game message handed to this peer's scheduler, in order
    // drops: what this peer was told / decided
    drops: [], takeovers: [], declared: [], declaring: '', selfDropped: false,
    G: null, real: null, // main.js's game object and its real drop functions (bindMainJs)
    // test controls
    gone: false,          // left the match (disconnected, or dropped by the host)
    frozen: false,        // its frame loop is not running
    inboundHeld: false,   // network input is queued instead of processed (frozen JS / a lagging link)
    paused: false,        // G.paused: frames keep running, the sim is not stepped
    latencyMs: 0,         // one-way network latency towards this peer, in virtual ms
    lose: null,           // (msg) => true to lose that incoming game message on the way
    lostMessages: [],
    inTransit: [], inboundQueue: [], inboundCount: 0, pongWaiters: new Map(), acc: 0,
  };
  // What arrives from the network spends `latencyMs` in transit (delivered by
  // the driver when the virtual clock gets there), then is processed -- or
  // queued while the peer's input is "held".
  const land = (fn, args) => {
    if (peer.inboundHeld) peer.inboundQueue.push(() => fn(...args)); else fn(...args);
  };
  const fromNetwork = (fn) => (...args) => {
    if (peer.latencyMs > 0) peer.inTransit.push({ at: clock.t + peer.latencyMs, run: () => land(fn, args) });
    else land(fn, args);
  };
  const deliver = (m) => {
    if (!peer.ls) { peer.lost++; return; }
    if (m.t === 'needlog' && Net.isHost) {
      Net.sendLog(m.from, peer.ls.logSnapshot(m.fromTick || 0, peer.state.tick));
      return;
    }
    peer.heard.push({ t: m.t, from: m.from, tick: m.tick, slot: m.slot, seq: m.seq, at: m.at });
    peer.ls.ingest(m);
  };
  Net.init(peer.game, {
    onLobby: () => { peer.lobbies++; },
    onStart: () => beginMatch(peer),
    // main.js onPause (guests; the relay does not echo the host's own toggle)
    onPause: fromNetwork((on) => {
      const G = peer.G;
      if (!G.state || G.state.over) return;
      peer.paused = on;
      if (!on && G.ls && G.ls.resume) { G.ls.resume(); G.mpStallSince = 0; G.mpStallSlots = ''; }
    }),
    onChat: fromNetwork((from, text) => peer.chat.push({ from, text })),
    onGameMsg: (m) => {
      // Net.sendDrop echoes the host's own declaration into this hook: that is a
      // local call, not network input, and takes effect at once
      if (m && m.t === 'drop' && Net.isHost && m.from === Net.slot) deliver(m);
      else if (peer.lose && peer.lose(m)) peer.lostMessages.push(m);
      else fromNetwork(deliver)(m);
    },
    // main.js onBye: the host turns a disconnect into a drop declaration whose
    // line no peer can have reached -- ls.safeDropTick(slot) + TAKEOVER_DELAY_TICKS
    onBye: fromNetwork((slot, reason) => {
      peer.byes.push({ slot, reason });
      const G = peer.G;
      if (G.state && !G.state.over && Net.isHost && G.ls && !G.mpDropped[slot]) {
        G.mpDropped[slot] = true;
        peer.declaring = 'bye';
        Net.sendDrop(slot, G.ls.safeDropTick(slot) + TAKEOVER_DELAY_TICKS);
      }
    }),
    onHostLeft: fromNetwork((m) => { peer.hostLeft = m; }),
    onError: (reason) => peer.errors.push(reason),
    onClose: () => { peer.closed = true; },
  });
  bindMainJs(peer);
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
      peer.G.mpPendingDrops.push({ slot: m.slot, at: m.at !== undefined ? m.at : state.tick + TAKEOVER_DELAY_TICKS });
    },
  });
  peer.sums.set(0, Sim.checksum(state));
}

// Stand-ins, used ONLY if main.js no longer has functions of these names (the
// guard test then fails and says so): the rules as they were when this file
// was last touched.
function fallbackHostDropWatch(peer, now) {
  const { Net, ls, G } = peer;
  if (!Net.isHost || !ls || peer.state.over) return;
  if (!ls.isWaiting()) { G.mpStallSince = 0; G.mpStallSlots = ''; return; }
  const key = ls.waitingOn().join(',');
  if (key !== G.mpStallSlots || !G.mpStallSince) {
    G.mpStallSlots = key;
    G.mpStallSince = now;
    return;
  }
  const heard = ls.debugState().lastHeard;
  for (const slot of ls.waitingOn()) {
    if (G.mpDropped[slot] || slot === Net.slot) continue;
    const silentFor = heard[slot] === undefined ? -1 : now - heard[slot];
    const loading = heard[slot] === undefined && now - G.mpStallSince < LOAD_GRACE_MS;
    if (loading || (silentFor >= 0 && silentFor < DROP_AFTER_MS)) continue;
    G.mpDropped[slot] = true;
    Net.sendDrop(slot, ls.safeDropTick(slot) + TAKEOVER_DELAY_TICKS);
  }
}

function fallbackProcessPendingDrops(peer) {
  const G = peer.G;
  if (!G.mpPendingDrops.length) return;
  const remaining = [];
  for (const d of G.mpPendingDrops) {
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
  G.mpPendingDrops = remaining;
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

// Give an order; returns the tick the scheduler stamped it for.
function issue(peer, cmd) {
  const entry = peer.ls.issue(cmd);
  assert.ok(entry, peer.tag + ' may give orders');
  const wire = peer.sent[peer.sent.length - 1];
  assert.ok(wire.t === 'cmd' && wire.seq === entry.seq, 'the order went out on the wire');
  peer.issued++;
  peer.orders.push({ tick: wire.tick, seq: wire.seq, cmd, key: JSON.stringify(cmd), issuedAt: peer.state.tick });
  return wire.tick;
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
  if (peer.gone || peer.frozen || peer.paused || peer.state.over) return false; // (main.js steps only while !G.paused)
  runScript(peer);
  if (!peer.ls.advance()) return false;
  peer.sums.set(peer.state.tick, Sim.checksum(peer.state));
  return true;
}

// what main.js's frame loop does after stepping: hostDropWatch(now), then
// processPendingDrops() -- the real functions, on the virtual clock
function afterFrame(peer) {
  if (peer.gone || peer.frozen) return;
  peer.declaring = 'timeout';
  if (peer.real.hostDropWatch) peer.real.hostDropWatch(clock.t); else fallbackHostDropWatch(peer, clock.t);
  const pending = peer.G.mpPendingDrops.slice();
  const brains = peer.ai.brains.length;
  if (peer.real.processPendingDrops) peer.real.processPendingDrops(); else fallbackProcessPendingDrops(peer);
  for (const brain of peer.ai.brains.slice(brains)) { // an AI just took a slot over
    const d = pending.find((x) => x.slot === brain.slot);
    peer.takeovers.push({ slot: brain.slot, at: d ? d.at : -1, firstThink: brain.nextThink });
  }
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
//   instant      the relay hop itself takes no virtual time: everything sent in
//                a frame has reached its recipients' sockets before the clock
//                moves on (their `latencyMs` then decides when it is processed)
async function drive(peers, done, { timeoutMs = 30000, maxSteps = MP_STEP_CAP, paceMs = 0, clockStep = 1, paced = false, instant = false, each } = {}) {
  const started = performance.now();
  for (;;) {
    clock.t += clockStep;
    for (const p of peers) arrive(p);
    for (const p of peers) {
      if (p.gone || p.frozen) continue;
      if (!paced) { frame(p, maxSteps); continue; }
      if (!p.paused) p.acc += clockStep; // (main.js: the accumulator only runs while unpaused)
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
        + (p.desync ? ' DESYNC ' + JSON.stringify(p.desync) : '')
        + (p.declared.length ? ' declared ' + JSON.stringify(p.declared) : '')).join(' | '));
    }
    if (instant) await settle(peers);
    else if (paceMs) await sleep(paceMs);
    else await new Promise((resolve) => setImmediate(resolve));
  }
}

// hand a peer everything whose time in transit is over
function arrive(peer) {
  while (peer.inTransit.length && peer.inTransit[0].at <= clock.t) peer.inTransit.shift().run();
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

// The same, one queued message at a time, with `between()` after each (a peer
// whose frames run in between two messages that left their sender together).
function releaseStepwise(peer, between) {
  peer.inboundHeld = false;
  const queue = peer.inboundQueue;
  peer.inboundQueue = [];
  for (const fn of queue) { fn(); between(); }
  return queue.length;
}

// Let `ms` of virtual time pass: every `step` ms the `running` peers get a
// frame and the network settles (peers not listed stay exactly as they are).
// `each()` returning false stops the clock there.
async function elapse(running, all, ms, { step = 100, maxSteps = MP_STEP_CAP, each } = {}) {
  const end = clock.t + ms;
  while (clock.t < end) {
    clock.t += Math.min(step, end - clock.t);
    for (const p of all) arrive(p);
    for (const p of running) frame(p, maxSteps);
    await settle(all);
    if (each && each() === false) return;
  }
}

// Frames of ONE peer with nothing arriving in between (no network turn): what
// that peer does while everybody else's answer is still on its way.
function framesAlone(peer, frames, stepMs = 16) {
  for (let i = 0; i < frames; i++) { clock.t += stepMs; frame(peer); }
}

// hud.js, pause button (host only): the host flips its own flag and tells the room
function hostPause(host, on) {
  assert.ok(host.Net.isHost);
  host.paused = on;
  host.Net.sendPause(on);
}

// the end-of-input marker a peer has declared, and the one another peer holds for it
const marker = (peer) => peer.ls.debugState().eoiSent;
const markerSeen = (peer, slot) => peer.ls.debugState().eoiFrom[slot];
const holds = (peer, fromTick = 0) => peer.trace.filter((e) => e.gate === 'hold' && e.tick >= fromTick).length;

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
    assert.ok(host.sent.some((m) => m.t === 'eoi'), 'end-of-input markers flow');
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

