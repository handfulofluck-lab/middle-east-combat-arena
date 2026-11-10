// End-to-end: complete headless lockstep matches through the Node relay.
//
// Nothing is mocked. Each peer is the REAL client networking stack --
// client/src/net/net.js (on Node's built-in browser-compatible WebSocket),
// client/src/net/lockstep.js and the real simulation (client/src/sim) --
// talking to the real server over real sockets. The lobby handshake, cfg/start
// and the match itself follow the same sequence main.js runs in the browser.
// main.js itself cannot be imported headlessly, so its multiplayer logic is
// lifted out of the source text and RUN AS IT IS for every peer -- whatever
// those functions do today is what these tests exercise:
//   * hostDropWatch() and processPendingDrops();
//   * the hooks onGameMsg, onBye, onPause (Net.init) and onPeerDrop
//     (createLockstep).
// Only its frame loop is re-stated here (stepPeer/afterFrame/drive); a guard
// test at the end of this file fails when main.js stops matching it.
//
// The matches must stay bit-identical on every peer: per-tick state checksums
// are compared directly AND through the csum messages the peers exchange via
// the relay, and the lockstep scheduler must never report a desync or force a
// tick. Negative controls prove that a real divergence IS caught.
//
// Time: the scheduler and the host's drop timeouts run on a VIRTUAL clock that
// only the test driver advances. A frozen CI machine freezes the clock too, so
// none of those timeouts can fire because the hardware was slow. The one real
// timer in play is net.js's: it waits 2.5 s (wall clock) for the relay to echo
// a drop declaration before applying it locally. Here the echo is back within
// milliseconds; test D4 withholds it on purpose and waits those 2.5 s out.
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
// Servers for the choreographed matches: flat-out stepping and the relay
// barrier's pings are far above the 10 Hz traffic the default limiter is sized
// for (a kicked peer would look like a silent one). The real-time test near the
// end of the first suite runs on the stock limits.
const UNTHROTTLED = {
  RATE_MSGS_PER_SEC: '100000', RATE_BURST: '1000000',
  RATE_BYTES_PER_SEC: String(64 * 1024 * 1024), RATE_BYTES_BURST: String(512 * 1024 * 1024),
};
const clock = { t: 1 }; // virtual milliseconds (never 0: main.js treats a 0 timestamp as "not waiting")

// The source of a top-level function of main.js, or null.
function mainFunction(name) {
  const m = new RegExp('^function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?^\\}', 'm').exec(MAIN_SRC);
  return m ? m[0] : null;
}
// The source of an inline hook of main.js -- `name: (args) => { ... },` whose
// closing brace sits at the property's own indent -- as an arrow function, or null.
function mainHook(name) {
  const m = new RegExp('^( *)' + name + ': (\\([^)]*\\) => \\{\\n[\\s\\S]*?\\n\\1\\}),?$', 'm').exec(MAIN_SRC);
  return m ? m[2] : null;
}
const REAL_SOURCE = {
  hostDropWatch: mainFunction('hostDropWatch'),
  processPendingDrops: mainFunction('processPendingDrops'),
  onGameMsg: mainHook('onGameMsg'),
  onBye: mainHook('onBye'),
  onPause: mainHook('onPause'),
  onPeerDrop: mainHook('onPeerDrop'),
};
const IS_HOOK = { onGameMsg: true, onBye: true, onPause: true, onPeerDrop: true };

// Give a peer its own copies of those functions, closed over a `G` that maps
// main.js's game object onto the peer, the peer's Net, and the virtual clock.
function bindMainJs(peer) {
  const G = {
    get ls() { return peer.ls; },
    get state() { return peer.state; },
    get ai() { return peer.ai; },
    get playerSlot() { return peer.slot; },
    get paused() { return peer.paused; },
    set paused(on) { peer.paused = on; },
    worldPending: 0, cinema: null, overlay: null,
    mpDropped: {}, mpStallSince: 0, mpStallSlots: '', mpWaitNote: null, mpPendingDrops: [],
  };
  const scope = {
    G, Net: peer.Net, Sim, DROP_AFTER_MS, LOAD_GRACE_MS, TAKEOVER_DELAY_TICKS,
    showHint: () => {}, showLobby: () => {}, mpNameOf: (slot) => 'P' + (slot + 1),
    // leaving the match: this player is out of the shared simulation for good
    leaveMpToMenu: () => { peer.gone = true; peer.Net.leave(); },
    performance: { now: () => clock.t },
  };
  const compile = (name) => {
    if (!REAL_SOURCE[name]) {
      throw new Error('main.js no longer has ' + (IS_HOOK[name] ? 'a hook `' + name + ': (...) => {...}`' : 'a top-level `function ' + name + '(...) {...}`')
        + ': these tests run it as it is -- point REAL_SOURCE in server/test/lockstep.e2e.test.mjs at wherever that logic lives now');
    }
    const body = IS_HOOK[name] ? 'return ' + REAL_SOURCE[name] + ';' : REAL_SOURCE[name] + '\nreturn ' + name + ';';
    const fn = new Function(...Object.keys(scope), body)(...Object.values(scope));
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
  peer.real = {};
  for (const name of Object.keys(REAL_SOURCE)) peer.real[name] = compile(name);

  // observe (and, for rule-level tests, steer) what the host declares
  const sendDrop = peer.Net.sendDrop.bind(peer.Net);
  peer.Net.sendDrop = (slot, at) => {
    if (peer.opts.dropAt) {
      at = peer.opts.dropAt(peer, slot);
      if (peer.ls.expectDrop) peer.ls.expectDrop(slot, at); // (main.js announced its own line to the scheduler)
    }
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
    unechoedDrops: 0,     // own declarations applied by net.js's no-echo fallback (must stay 0 here)
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
    peer.heard.push({ t: m.t, from: m.from, tick: m.tick, slot: m.slot, seq: m.seq, at: m.at });
    peer.real.onGameMsg(m); // main.js: into the scheduler
  };
  Net.init(peer.game, {
    onLobby: () => { peer.lobbies++; },
    onStart: () => beginMatch(peer),
    onPause: fromNetwork((on, from) => peer.real.onPause(on, from)), // (guests: the host's own toggle is not echoed)
    onChat: fromNetwork((from, text) => peer.chat.push({ from, text })),
    onGameMsg: (m) => {
      // The host's own drop declaration comes back from the relay (`echo: true`)
      // and is network input like everybody else's copy. Only net.js's FALLBACK
      // -- no echo within 2.5 s of real time, i.e. a relay without echo -- hands
      // it over locally, without the flag; with this relay that must not happen.
      if (m && m.t === 'drop' && m.from === Net.slot && !m.echo) { peer.unechoedDrops++; deliver(m); }
      else if (peer.lose && peer.lose(m)) peer.lostMessages.push(m);
      else fromNetwork(deliver)(m);
    },
    // main.js onBye: the host turns a disconnect into a drop declaration
    onBye: fromNetwork((slot, reason) => {
      peer.byes.push({ slot, reason });
      peer.declaring = 'bye';
      peer.real.onBye(slot);
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
    // main.js onPeerDrop: a player the host gave up on leaves the match (an AI
    // commands its forces on every other machine); anyone else queues the takeover
    onPeerDrop: (m) => {
      peer.drops.push({ slot: m.slot, at: m.at, tick: state.tick });
      if (m.slot === peer.slot) { peer.selfDropped = true; peer.gone = true; } // (it stops taking part at once)
      peer.real.onPeerDrop(m);
    },
  });
  peer.sums.set(0, Sim.checksum(state));
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
  peer.real.hostDropWatch(clock.t);
  const pending = peer.G.mpPendingDrops.slice();
  const brains = peer.ai.brains.length;
  peer.real.processPendingDrops();
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
        + (p.closed ? ' SOCKET CLOSED' : '') + (p.hostLeft ? ' (host left)' : '')
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
async function threeHumans(t, peerOpts = {}, delay = 2) {
  const srv = await startServer(UNTHROTTLED);
  t.after(() => srv.close());
  const peers = await lobby(srv, [
    { name: 'Host', faction: 'Egypt' },
    { name: 'Bob', faction: 'Turkey' },
    { name: 'Carol', faction: 'Iran' },
  ], { map: pickMap(3, 'gulf'), peerOpts, delay });
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
    // The match runs flat out (hundreds of ticks per second): see UNTHROTTLED.
    // The real-time test below uses the default limits.
    const srv = await startServer(UNTHROTTLED);
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
    const srv = await startServer(UNTHROTTLED);
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
    const srv = await startServer(UNTHROTTLED);
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
// The v1.0 scheduler rules (client/src/net/lockstep.js, header):
//   * a tick runs only when every human slot's END-OF-INPUT MARKER covers it
//     ({t:'eoi', tick}); a command alone never completes a tick;
//   * a missing peer always holds the gate -- nothing is forced; a waiting peer
//     re-sends its marker every KEEPALIVE_MS;
//   * drops are tick-aligned ({t:'drop', slot, at}); the host declares them on a
//     disconnect (bye) or after DROP_AFTER_MS of silence (LOAD_GRACE_MS for a
//     peer that never spoke), at safeDropTick(slot) + TAKEOVER_DELAY_TICKS.
// Every scenario below is choreographed on the virtual clock, with the relay
// barrier (settle) deciding what has arrived where: no outcome depends on how
// fast this machine is.

// Carol's machine stops dead (no frames, nothing received is processed) while
// she stays connected; the others run until her last marker holds them.
async function carolFreezes(t, peerOpts, inputDelay) {
  const { peers } = await threeHumans(t, peerOpts, inputDelay);
  const [host, bob, carol] = peers;
  const delay = host.ls.getDelay();
  freeze(carol);
  const c = carol.state.tick;
  const m = marker(carol);
  assert.equal(m, c + delay - 1, 'sitting on tick c, a peer has closed its input up to c + delay - 1');
  await stepUntilHeld([host, bob], peers);
  for (const p of [host, bob]) {
    assert.equal(p.state.tick, m + 1, p.tag + ' ran every tick her marker covers and holds on the next');
    assert.equal(markerSeen(p, 2), m);
    assert.deepEqual(p.ls.waitingOn(), [2]);
  }
  return { peers, host, bob, carol, delay, c, m, held: m + 1, heardAt: host.ls.debugState().lastHeard[2] };
}

// one distinct order on every tick the peer sits on (issued once per tick, as
// main.js hands pending input to the scheduler when a tick is due)
function orderEveryTick(peer) {
  let n = 0;
  let last = -1;
  peer.script.eachTick = () => {
    if (peer.state.tick === last || !ownMcv(peer)) return;
    last = peer.state.tick;
    issue(peer, mcvMove(peer, n % 4, 3 + Math.floor(n / 4) % 6));
    n++;
  };
}

// Carol disconnects with orders in flight while Bob's link lags: the host sits
// `delay` ticks ahead of Bob when it declares the drop.
async function dropWithOrdersInFlight(t, peerOpts) {
  const { peers } = await threeHumans(t, peerOpts);
  const [host, bob, carol] = peers;
  const delay = host.ls.getDelay();
  orderEveryTick(carol);
  bob.inboundHeld = true; // Bob stops hearing the others (his own messages still go out)
  await stepUntilHeld(peers);
  const T = bob.state.tick;
  assert.equal(host.state.tick, T + delay, 'the host runs up to Bob\'s marker and holds `delay` ticks ahead of him');
  assert.equal(carol.state.tick, T + delay);
  const carolMarker = marker(carol);
  assert.equal(markerSeen(host, 2), carolMarker);
  const inFlight = carol.orders.filter((o) => o.tick >= host.state.tick);
  assert.deepEqual(inFlight.map((o) => o.tick), Array.from({ length: delay + 1 }, (_, i) => T + delay + i),
    'Carol has orders out for ticks nobody has run yet');
  assert.equal(new Set(carol.orders.map((o) => o.key)).size, carol.orders.length, 'every order is recognisable');

  const hostTick = host.state.tick;
  carol.gone = true;
  carol.Net.ws.close(); // no goodbye
  await until(() => host.byes.length > 0, 'the bye to reach the host');
  await settle([host, bob]);
  assert.equal(host.declared.length, 1);
  assert.equal(host.declared[0].why, 'bye');
  assert.equal(host.state.tick, hostTick, 'the host is still held by Bob');
  assert.ok(bob.inboundQueue.length > 0 && bob.state.tick === T, 'Bob has not heard any of it yet');
  const line = host.declared[0].at;

  releaseInbound(bob);
  await drive([host, bob], () => host.state.tick >= T + 60 && bob.state.tick >= T + 60);
  await settle([host, bob]);
  return { host, bob, carol, delay, T, hostTick, carolMarker, inFlight, line };
}

// what must hold for the two players left after a drop
function assertDropHeldTogether({ host, bob, carol, line }, minTicks) {
  for (const o of carol.orders) {
    const expected = o.tick < line ? [o.tick] : [];
    assert.deepEqual(appliedTicks(host, o.key), expected, `host: Carol's order for tick ${o.tick} (drop line ${line})`);
    assert.deepEqual(appliedTicks(bob, o.key), expected, `Bob: Carol's order for tick ${o.tick} (drop line ${line})`);
  }
  assert.deepEqual(bob.drops.map((d) => [d.slot, d.at]), [[2, line]]);
  assert.deepEqual(host.takeovers.map((x) => [x.slot, x.at]), [[2, line]]);
  assert.deepEqual(bob.takeovers, host.takeovers, 'the AI takes the slot over on the same tick, with the same first think');
  for (const p of [host, bob]) {
    assert.equal(p.desync, null, p.tag + ' reports no desync');
    assert.equal(forcedTicks(p), 0);
    assert.equal(p.state.players[2].aiTakeover, true);
    assert.equal(p.unechoedDrops, 0);
  }
  // the host's own declaration reached its scheduler through the relay, flagged as an echo
  assert.ok(host.heard.some((m) => m.t === 'drop' && m.from === 0 && m.slot === 2), 'the host heard its declaration back');
  assert.deepEqual(entityCounts(host.state), entityCounts(bob.state));
  return assertSameHistory(host, bob, minTicks);
}

// A match on the real 10 Hz schedule with `latencyMs` of one-way latency on
// every link (the relay hop itself is instant; see drive()).
async function latencyMatch(t, { delay, latencyMs, ticks, warm }) {
  const srv = await startServer(UNTHROTTLED); // (the barrier pings count as messages)
  t.after(() => srv.close());
  const peers = await lobby(srv, [
    { name: 'Host', faction: 'Egypt' },
    { name: 'Bob', faction: 'Turkey' },
    { name: 'Carol', faction: 'Iran' },
  ], { map: pickMap(3, 'gulf'), delay });
  t.after(() => { for (const p of peers) p.Net.leave(); });
  for (const p of peers) {
    p.latencyMs = latencyMs;
    p.script.quiet = true;
    let n = 0;
    p.script.eachTick = () => { // an order every 7th tick, staggered per player
      if (p.state.tick % 7 !== p.slot || p.state.tick === p.script.last || !ownMcv(p)) return;
      p.script.last = p.state.tick;
      issue(p, mcvMove(p, n % 4, 3 + Math.floor(n / 4) % 6));
      n++;
    };
  }
  const t0 = clock.t;
  let warmAt = 0;
  await drive(peers, () => peers.every((p) => p.state.tick >= ticks), {
    paced: true, instant: true, clockStep: 16, timeoutMs: 60000,
    each: () => { if (!warmAt && peers.every((p) => p.state.tick >= warm)) warmAt = clock.t; },
  });
  const doneAt = clock.t;
  await settle(peers);
  return {
    peers, warm, ticks,
    msPerTick: (doneAt - warmAt) / (ticks - warm), // after start-up
    startupMs: warmAt - t0,
    holdsAfterWarm: peers.map((p) => holds(p, warm)),
    lastHoldTick: Math.max(...peers.map((p) => p.trace.reduce((x, e) => (e.gate === 'hold' ? Math.max(x, e.tick) : x), -1))),
  };
}

function assertInSync(peers, minTicks) {
  for (const p of peers) {
    assert.equal(p.desync, null, p.tag + ' reports no desync');
    assert.equal(p.ls.isDesynced(), false);
    assert.equal(forcedTicks(p), 0, p.tag + ' never forced a tick');
    assert.deepEqual(p.errors, []);
    assert.equal(p.closed, false, p.tag + ' is still connected');
    assert.equal(p.unechoedDrops, 0, p.tag + ': a drop declaration took effect without the relay echo');
  }
  let compared = 0;
  for (const p of peers.slice(1)) compared = assertSameHistory(peers[0], p, minTicks);
  return compared;
}

// every order a peer gave ran on the tick it was stamped for, on every machine
function assertOrdersRanEverywhere(peers) {
  const horizon = Math.min(...peers.map((p) => p.state.tick)); // ticks every peer has run
  let n = 0;
  for (const p of peers) {
    for (const o of p.orders) {
      if (o.tick >= horizon) continue;
      for (const q of peers) assert.deepEqual(appliedTicks(q, o.key), [o.tick], `${p.tag}'s order for tick ${o.tick}, on ${q.tag}`);
      n++;
    }
  }
  return n;
}

describe('lockstep scheduler rules, end to end through the relay', () => {
  // ---- a missing peer holds the room ------------------------------------------

  test('A. a frozen peer holds the whole room -- no forced tick, no drop -- and the order it gives on returning runs on the same tick everywhere', async (t) => {
    const { peers, host, bob, carol, delay, c, held } = await carolFreezes(t);
    const WAIT = 4000;
    assert.ok(WAIT > STALL_TIMEOUT_MS && WAIT < DROP_AFTER_MS, 'longer than the old force timeout, shorter than the drop timeout');
    const sentBefore = new Map([host, bob].map((p) => [p, p.sent.length]));
    await elapse([host, bob], peers, WAIT);
    for (const p of [host, bob]) {
      assert.equal(p.state.tick, held, p.tag + ' is still holding');
      assert.equal(p.ls.isWaiting(), true);
      assert.deepEqual(p.ls.waitingOn(), [2]);
      assert.equal(forcedTicks(p), 0);
      // all a waiting peer says is its marker, again, every KEEPALIVE_MS
      const said = p.sent.slice(sentBefore.get(p));
      assert.ok(said.every((m) => m.t === 'eoi' && m.tick === held + delay - 1), p.tag + ' only repeats its marker: ' + JSON.stringify(said.slice(0, 3)));
      assert.ok(Math.abs(said.length - WAIT / KEEPALIVE_MS) <= 1, p.tag + ' sent ' + said.length + ' keepalives in ' + WAIT + ' ms');
    }
    assert.deepEqual(host.declared, [], 'four seconds of silence is not a drop');

    thaw(carol);
    const order = mcvMove(carol, 1);
    const stamped = issue(carol, order);
    assert.equal(stamped, held, 'her order is stamped for the very tick the room is holding on');
    await drive(peers, () => peers.every((p) => p.state.tick >= c + 60));
    await settle(peers);
    for (const p of peers) assert.deepEqual(appliedTicks(p, order), [stamped], p.tag + ' ran her order on tick ' + stamped);
    const compared = assertInSync(peers, c + 60);
    assert.deepEqual(host.declared, []);
    for (const p of peers) assert.deepEqual(p.drops, []);
    t.diagnostic(`Carol froze on tick ${c} for ${WAIT} virtual ms; host/Bob held on ${held}; her order ran on ${stamped} on all three; ${compared} checksums compared`);
  });

  test('A (old rule). with forceOnSilence -- "run the tick after 1.5 s of silence" -- the same scenario desyncs', async (t) => {
    const { peers, host, bob, carol, c, held } = await carolFreezes(t, { forceOnSilence: true });
    // one tick per frame keeps the forced run short
    await elapse([host, bob], peers, STALL_TIMEOUT_MS + 1500, { maxSteps: 1, each: () => forcedTicks(host) < 3 || forcedTicks(bob) < 3 });
    assert.ok(forcedTicks(host) >= 3 && forcedTicks(bob) >= 3, 'after 1.5 s the old rule runs the ticks without her');
    assert.ok(host.state.tick > held && bob.state.tick > held);
    assert.deepEqual(host.declared, []);

    thaw(carol);
    const order = mcvMove(carol, 1);
    const stamped = issue(carol, order);
    assert.equal(stamped, held);
    await drive(peers, () => peers.some((p) => p.desync) || peers.every((p) => p.state.tick >= c + 120), { maxSteps: 1 });
    await settle(peers);
    const info = host.desync || bob.desync || carol.desync;
    assert.ok(info, 'the room desyncs');
    assert.deepEqual(appliedTicks(carol, order), [stamped], 'she ran her order');
    assert.deepEqual(appliedTicks(host, order), [], 'the host had already run that tick without it');
    assert.deepEqual(appliedTicks(bob, order), []);
    assert.equal(firstDivergence(host, carol), stamped + 1, 'their worlds part on exactly that tick');
    assert.equal(info.tick, (Math.floor(stamped / CSUM_EVERY) + 1) * CSUM_EVERY, 'and the next checksum exchange catches it');
    assert.equal(firstDivergence(host, bob), -1, 'the two that forced together still agree with each other');
    t.diagnostic(`forceOnSilence: host/Bob forced ${forcedTicks(host)}/${forcedTicks(bob)} ticks past ${held}; Carol's order for ${stamped} ran only on her machine; desync reported at tick ${info.tick}`);
  });

  // ---- drops are tick-aligned ---------------------------------------------------

  test('B. a player disconnects with orders in flight while the others sit on different ticks: both apply exactly the same orders', async (t) => {
    const r = await dropWithOrdersInFlight(t);
    const { host, delay, T, hostTick, carolMarker, inFlight, line } = r;
    assert.equal(line, Math.max(hostTick + delay, carolMarker + 1) + TAKEOVER_DELAY_TICKS, 'safeDropTick(slot) + TAKEOVER_DELAY_TICKS');
    assert.ok(inFlight.every((o) => o.tick < line), 'the line lies beyond everything she had sent');
    const compared = assertDropHeldTogether(r, T + 60);
    assert.equal(host.declared.length, 1);
    t.diagnostic(`Bob on tick ${T}, host on ${hostTick}; Carol left with orders out for ticks ${inFlight.map((o) => o.tick).join(',')}; drop line ${line}; `
      + `all ${r.carol.orders.length} of her orders ran on the same ticks on both; ${compared} checksums compared`);
  });

  test('B (rule). a drop line that cuts through the orders in flight: below it they count, from it on they are void -- on both machines', async (t) => {
    // the host of this test declares the earliest line no machine has run yet
    const r = await dropWithOrdersInFlight(t, { dropAt: (peer) => peer.state.tick + 1 });
    const { delay, T, hostTick, inFlight, line } = r;
    assert.equal(line, hostTick + 1);
    assert.deepEqual(inFlight.map((o) => (o.tick < line ? 'counts' : 'void')), ['counts'].concat(Array(delay).fill('void')));
    const compared = assertDropHeldTogether(r, T + 60);
    t.diagnostic(`Bob on tick ${T}, host on ${hostTick}; drop line ${line} cuts her orders for ${inFlight.map((o) => o.tick).join(',')}: `
      + `${inFlight.filter((o) => o.tick < line).length} counted, ${inFlight.filter((o) => o.tick >= line).length} void on both; ${compared} checksums compared`);
  });

  test('C. a peer silent for DROP_AFTER_MS is dropped by the host (main.js hostDropWatch), on a line nobody has reached; waking up later, it leaves', async (t) => {
    const { peers, host, bob, carol, delay, c, m, held, heardAt } = await carolFreezes(t);
    await elapse([host, bob], peers, DROP_AFTER_MS - 500);
    assert.deepEqual(host.declared, [], 'not yet');
    assert.equal(host.state.tick, held);
    await elapse([host, bob], peers, 1500, { each: () => host.declared.length === 0 });
    assert.equal(host.declared.length, 1, 'the host gives up on her');
    const decl = host.declared[0];
    assert.deepEqual([decl.slot, decl.why, decl.tick], [2, 'timeout', held]);
    assert.ok(decl.clock - heardAt >= DROP_AFTER_MS && decl.clock - heardAt < DROP_AFTER_MS + 250,
      `declared after ${decl.clock - heardAt} ms of silence`);
    assert.equal(decl.at, Math.max(held + delay, m + 1) + TAKEOVER_DELAY_TICKS, 'safeDropTick(slot) + TAKEOVER_DELAY_TICKS');

    await drive([host, bob], () => host.state.tick >= decl.at + 60 && bob.state.tick >= decl.at + 60);
    await settle(peers);
    assert.deepEqual(bob.declared, [], 'only the host declares');
    assert.deepEqual(bob.drops.map((d) => [d.slot, d.at]), [[2, decl.at]]);
    assert.ok(bob.drops[0].tick < decl.at && host.drops[0].tick < decl.at, 'both learn of the drop before reaching its tick');
    assert.deepEqual(host.takeovers.map((x) => [x.slot, x.at]), [[2, decl.at]]);
    assert.deepEqual(bob.takeovers, host.takeovers);
    const compared = assertInSync([host, bob], decl.at + 60);
    assert.equal(host.declared.length, 1, 'and nobody else was dropped');

    // Carol's machine comes back: the first thing it learns is that it was dropped
    thaw(carol);
    assert.equal(carol.selfDropped, true);
    assert.equal(carol.state.tick, c, 'she runs nothing more');
    frame(carol);
    assert.equal(carol.state.tick, c);
    await until(() => host.byes.some((b) => b.slot === 2), 'Carol to leave the room');
    await settle([host, bob]);
    assert.equal(host.declared.length, 1, 'her leaving is not declared a second time');
    assert.equal(host.desync, null);
    assert.equal(bob.desync, null);
    t.diagnostic(`Carol silent from tick ${c}; dropped after ${decl.clock - heardAt} virtual ms on line ${decl.at} (host on ${held}); `
      + `host/Bob continued to ${host.state.tick}/${bob.state.tick}, ${compared} checksums compared`);
  });

  // The timeout race. The host decides on ITS view of the silent peer; if that
  // peer speaks again inside the host's network round trip, the relay has an
  // order of events the host has not seen yet. The declaration therefore takes
  // effect where the relay put it in the room's stream -- for the host too
  // (net.js sendDrop: `echo: true`): what the relay passed on before it counts
  // for everyone (below the drop line), what came after it counts for no one.

  test('D. timeout race, input relayed BEFORE the verdict: it counts on every machine, the host\'s included', async (t) => {
    const { peers, host, bob, carol, c, held } = await carolFreezes(t);
    await elapse([host, bob], peers, DROP_AFTER_MS - 300);
    assert.deepEqual(host.declared, []);

    // Carol's machine wakes up and she gives an order at once. Bob has her
    // messages first; the host, at the far end of its own link, declares her
    // dropped before they arrive.
    host.inboundHeld = true; // (on their way to the host)
    thaw(carol);
    const order = mcvMove(carol, 1);
    const stamped = issue(carol, order);
    assert.equal(stamped, held);
    frame(carol);
    await settle([bob, carol]);
    frame(bob); // Bob is a healthy peer: he runs what her fresh markers allow
    await settle([bob, carol]);
    assert.ok(bob.state.tick > stamped, 'Bob has already run her order');
    clock.t += 400; // the host's DROP_AFTER_MS are up
    frame(host);
    assert.deepEqual(host.declared.map((d) => [d.slot, d.why]), [[2, 'timeout']], 'the host declares her dropped');
    const line = host.declared[0].at;
    assert.equal(host.ls.isDropped(2), false, 'declaring is not yet dropping: the host waits to hear it back from the relay');
    releaseInbound(host); // now her messages arrive -- ahead of the host's own echoed verdict
    assert.equal(host.ls.isDropped(2), false);
    await settle(peers);
    assert.equal(host.ls.isDropped(2), true);
    await drive([host, bob], () => !!(host.desync || bob.desync) || (host.state.tick >= c + 80 && bob.state.tick >= c + 80));
    await settle(peers);

    const position = (peer, pred) => peer.heard.findIndex(pred);
    const isOrder = (m) => m.t === 'cmd' && m.from === 2 && m.tick === stamped;
    const isVerdict = (m) => m.t === 'drop' && m.slot === 2;
    for (const p of [host, bob]) {
      assert.ok(position(p, isOrder) >= 0 && position(p, isOrder) < position(p, isVerdict), p.tag + ' received her order before the verdict');
      assert.deepEqual(appliedTicks(p, order), [stamped], p.tag + ' ran her order on tick ' + stamped + ' (below the drop line ' + line + ')');
    }
    assert.equal(carol.selfDropped, true, 'Carol is told and leaves');
    assert.deepEqual(bob.drops.map((d) => [d.slot, d.at]), [[2, line]]);
    assert.deepEqual(host.drops.map((d) => [d.slot, d.at]), [[2, line]]);
    assert.deepEqual(bob.takeovers, host.takeovers);
    const compared = assertInSync([host, bob], c + 80);
    t.diagnostic(`Carol woke on tick ${c}; her order for ${stamped} was relayed before the verdict (drop line ${line}): ran on both; ${compared} checksums compared`);
  });

  test('D2. timeout race, input relayed AFTER the verdict: it counts on no machine', async (t) => {
    const { peers, host, bob, carol, c, held } = await carolFreezes(t);
    await elapse([host, bob], peers, DROP_AFTER_MS + 1000, { each: () => host.declared.length === 0 });
    assert.deepEqual(host.declared.map((d) => [d.slot, d.why]), [[2, 'timeout']]);
    const line = host.declared[0].at;
    assert.ok(host.ls.isDropped(2) && bob.ls.isDropped(2), 'the verdict has passed the relay and reached both');
    assert.deepEqual([host.state.tick, bob.state.tick], [held, held], 'neither has had a frame since');

    // Carol's machine wakes up; the verdict has not reached her yet (her link
    // is slow), so she plays on: an order for a tick below the drop line.
    carol.frozen = false;
    const order = mcvMove(carol, 1);
    const stamped = issue(carol, order);
    assert.ok(stamped === held && stamped < line, 'an order for tick ' + stamped + ', below the line ' + line);
    frame(carol);
    await settle(peers);
    for (const p of [host, bob]) assert.ok(p.heard.some((m) => m.t === 'cmd' && m.from === 2 && m.tick === stamped), p.tag + ' did receive it');
    releaseInbound(carol); // and now she learns she was dropped
    assert.equal(carol.selfDropped, true);

    await drive([host, bob], () => host.state.tick >= c + 80 && bob.state.tick >= c + 80);
    await settle(peers);
    for (const p of [host, bob]) assert.deepEqual(appliedTicks(p, order), [], p.tag + ' ignores what she sent after the verdict');
    assert.deepEqual(bob.takeovers, host.takeovers);
    const compared = assertInSync([host, bob], c + 80);
    t.diagnostic(`her order for tick ${stamped} (drop line ${line}) passed the relay after the verdict: void on both; ${compared} checksums compared`);
  });

  test('D3. timeout race on the "Online" input delay (4): the host stops at its own drop line until its verdict has come back', async (t) => {
    const { peers, host, bob, carol, delay, c, held } = await carolFreezes(t, {}, 4);
    await elapse([host, bob], peers, DROP_AFTER_MS - 300);
    assert.deepEqual(host.declared, []);
    host.inboundHeld = true; // (on their way to the host)
    // Carol's link comes back. She catches up as far as the others' markers
    // let her and gives an order on the last tick she can still reach.
    thaw(carol);
    frame(carol, held + delay - 1 - c);
    assert.equal(carol.state.tick, held + delay - 1);
    const order = mcvMove(carol, 1);
    const stamped = issue(carol, order);
    frame(carol);
    await settle([bob, carol]);
    frame(bob);
    await settle([bob, carol]);
    clock.t += 400; // the host's DROP_AFTER_MS are up
    frame(host);
    assert.deepEqual(host.declared.map((d) => [d.slot, d.why]), [[2, 'timeout']]);
    const line = host.declared[0].at;
    assert.equal(stamped, line, 'her order is for the very tick the host put the line on');
    assert.ok(markerSeen(bob, 2) >= line, 'and her markers cover it: with her still in the game, that tick could run');

    // Her burst and Bob's answer reach the host ahead of its own echoed verdict.
    // Until that is back the host still plays with her -- up to the line, no further:
    // everyone else will ignore her input from the line on.
    releaseInbound(host);
    host.inboundHeld = true; // (the echo is still on its way)
    framesAlone(host, 10);
    assert.equal(host.ls.isDropped(2), false);
    assert.equal(host.state.tick, line, 'the host ran every tick below the line and stopped on it');
    assert.ok(host.trace.some((e) => e.gate === 'hold-drop-line' && e.tick === line), 'held by its own pending declaration, not by a missing marker');
    await settle(peers);
    framesAlone(host, 10);
    assert.equal(host.state.tick, line, 'still there: the verdict has not come back');
    releaseInbound(host); // the echo arrives
    assert.equal(host.ls.isDropped(2), true);
    await drive([host, bob], () => !!(host.desync || bob.desync) || (host.state.tick >= c + 100 && bob.state.tick >= c + 100));
    await settle(peers);

    for (const p of [host, bob]) assert.deepEqual(appliedTicks(p, order), [], p.tag + ': her order for the line tick is void');
    assert.deepEqual(bob.takeovers, host.takeovers);
    assert.deepEqual(host.takeovers.map((x) => [x.slot, x.at]), [[2, line]]);
    const compared = assertInSync([host, bob], c + 100);
    t.diagnostic(`delay ${delay}: host held on ${held}, drop line ${line}; with Carol back the host ran to ${line} and waited there for its echo; `
      + `her order for ${stamped} is void on both; ${compared} checksums compared`);
  });

  test('D4. a relay that does not echo (the legacy one): the host applies its own declaration after net.js\'s grace, and play goes on in sync', async (t) => {
    const { peers } = await threeHumans(t);
    const [host, bob, carol] = peers;
    // what a relay without the extension does: it passes the declaration on and returns nothing
    const send = host.Net._send.bind(host.Net);
    host.Net._send = (m) => send(m && m.t === 'drop' ? { t: 'drop', slot: m.slot, at: m.at } : m);
    const from = host.state.tick;
    carol.gone = true;
    carol.Net.ws.close();
    await until(() => host.byes.length > 0 && bob.drops.length > 0, 'the bye and the host\'s declaration to arrive');
    assert.equal(host.declared.length, 1);
    const line = host.declared[0].at;
    await stepUntilHeld([host, bob], [host, bob]);
    assert.equal(host.ls.isDropped(2), false, 'nothing came back: the host has not applied its own declaration yet');
    assert.equal(bob.ls.isDropped(2), true);
    assert.ok(host.state.tick < line && bob.state.tick < line, 'so nobody gets to the line: ' + host.state.tick + '/' + bob.state.tick + ' < ' + line);
    // (real time: net.js waits 2.5 s for an echo before it falls back)
    await drive([host, bob], () => host.state.tick >= from + 60 && bob.state.tick >= from + 60, { paceMs: 50, timeoutMs: 20000 });
    await settle([host, bob]);
    assert.equal(host.unechoedDrops, 1, 'the declaration took effect through the local fallback');
    assert.deepEqual(host.drops.map((d) => [d.slot, d.at]), [[2, line]]);
    assert.deepEqual(bob.drops.map((d) => [d.slot, d.at]), [[2, line]]);
    assert.deepEqual(bob.takeovers, host.takeovers);
    for (const p of [host, bob]) { assert.equal(p.desync, null); assert.equal(forcedTicks(p), 0); }
    assertSameHistory(host, bob, from + 60);
  });

  test('F. a slow starter (silent for longer than DROP_AFTER_MS because it is still loading) is not dropped; once it has spoken, the same silence is', async (t) => {
    const srv = await startServer(UNTHROTTLED);
    t.after(() => srv.close());
    const peers = await lobby(srv, [
      { name: 'Host', faction: 'Egypt' },
      { name: 'Bob', faction: 'Turkey' },
      { name: 'Carol', faction: 'Iran' },
    ], { map: pickMap(3, 'gulf') });
    t.after(() => { for (const p of peers) p.Net.leave(); });
    const [host, bob, carol] = peers;
    const delay = host.ls.getDelay();
    for (const p of peers) p.script.quiet = true;

    freeze(carol); // still loading: no frame has run, she has not said a word
    const LOADING = DROP_AFTER_MS + 4000;
    assert.ok(LOADING < LOAD_GRACE_MS);
    await elapse([host, bob], peers, LOADING);
    assert.equal(host.state.tick, 0);
    assert.equal(bob.state.tick, 0);
    assert.deepEqual(host.ls.waitingOn(), [2]);
    assert.equal(host.ls.debugState().lastHeard[2], undefined, 'the host has never heard from her');
    assert.deepEqual(host.declared, [], 'a peer that never spoke is loading, not gone');

    thaw(carol);
    await drive(peers, () => peers.every((p) => p.state.tick >= 30));
    await settle(peers);
    assert.deepEqual(host.declared, []);
    assertInSync(peers, 30);

    // now she HAS spoken: going silent for DROP_AFTER_MS means she is gone
    freeze(carol);
    const c = carol.state.tick;
    await stepUntilHeld([host, bob], peers);
    const heardAt = host.ls.debugState().lastHeard[2];
    const held = host.state.tick;
    await elapse([host, bob], peers, DROP_AFTER_MS + 1000, { each: () => host.declared.length === 0 });
    assert.equal(host.declared.length, 1);
    const decl = host.declared[0];
    assert.deepEqual([decl.slot, decl.why], [2, 'timeout']);
    assert.ok(decl.clock - heardAt >= DROP_AFTER_MS && decl.clock - heardAt < DROP_AFTER_MS + 250, `dropped after ${decl.clock - heardAt} ms of silence`);
    assert.equal(decl.at, Math.max(held + delay, marker(carol) + 1) + TAKEOVER_DELAY_TICKS);
    await drive([host, bob], () => host.state.tick >= decl.at + 40 && bob.state.tick >= decl.at + 40);
    await settle(peers);
    assert.deepEqual(bob.takeovers, host.takeovers);
    assertInSync([host, bob], decl.at + 40);
    t.diagnostic(`loading for ${LOADING} virtual ms: kept; later silent from tick ${c}: dropped after ${decl.clock - heardAt} ms on line ${decl.at}`);
  });

  test('G. a peer that never starts at all is dropped after LOAD_GRACE_MS, and the others play on', async (t) => {
    const srv = await startServer(UNTHROTTLED);
    t.after(() => srv.close());
    const peers = await lobby(srv, [
      { name: 'Host', faction: 'Egypt' },
      { name: 'Bob', faction: 'Turkey' },
      { name: 'Carol', faction: 'Iran' },
    ], { map: pickMap(3, 'gulf') });
    t.after(() => { for (const p of peers) p.Net.leave(); });
    const [host, bob, carol] = peers;
    const delay = host.ls.getDelay();
    for (const p of peers) p.script.quiet = true;
    const t0 = clock.t;
    freeze(carol);
    await elapse([host, bob], peers, LOAD_GRACE_MS - 1000, { step: 250 });
    assert.deepEqual(host.declared, [], 'still inside the loading grace');
    assert.equal(host.state.tick, 0);
    await elapse([host, bob], peers, 2000, { step: 250, each: () => host.declared.length === 0 });
    assert.equal(host.declared.length, 1);
    const decl = host.declared[0];
    assert.deepEqual([decl.slot, decl.why, decl.tick], [2, 'timeout', 0]);
    assert.equal(decl.at, delay + TAKEOVER_DELAY_TICKS, 'nothing was ever heard from her: the line is the host\'s own safe tick');
    await drive([host, bob], () => host.state.tick >= 60 && bob.state.tick >= 60);
    await settle(peers);
    assert.deepEqual(host.takeovers.map((x) => [x.slot, x.at]), [[2, decl.at]]);
    assert.deepEqual(bob.takeovers, host.takeovers);
    assert.equal(host.declared.length, 1);
    const compared = assertInSync([host, bob], 60);
    t.diagnostic(`never heard from Carol: dropped ${decl.clock - t0} virtual ms into the match on line ${decl.at}; ${compared} checksums compared`);
  });

  // ---- silence is measured per peer; waiting quietly is not silence -------------

  test('H1. after a timeout drop the host does not turn on the bystander whose next marker is still on its way', async (t) => {
    const { peers, host, bob, held } = await carolFreezes(t);
    await elapse([host, bob], peers, DROP_AFTER_MS + 1000, { each: () => host.declared.length === 0 });
    assert.deepEqual(host.declared.map((d) => [d.slot, d.why]), [[2, 'timeout']]);
    // Bob waited just as long as the host did -- but he kept saying so
    const bobHeard = clock.t - host.ls.debugState().lastHeard[1];
    assert.ok(bobHeard <= KEEPALIVE_MS + 100, `the host heard from Bob ${bobHeard} ms ago`);
    // the host's next frames, before anything from Bob can have arrived
    framesAlone(host, 30);
    assert.ok(host.state.tick > held, 'the host runs on without Carol');
    assert.deepEqual(host.ls.waitingOn(), [1], '...until it needs Bob\'s next marker');
    assert.equal(host.declared.length, 1, 'waiting for Bob for half a second is not a reason to drop him');
    await drive([host, bob], () => host.state.tick >= held + 60 && bob.state.tick >= held + 60);
    await settle(peers);
    assert.equal(host.declared.length, 1);
    assert.equal(bob.selfDropped, false);
    assertInSync([host, bob], held + 60);
  });

  test('H2. a peer that returns just before the timeout: nobody is dropped, including the bystander who answers a few frames late', async (t) => {
    const { peers, host, bob, carol, c, held } = await carolFreezes(t);
    await elapse([host, bob], peers, DROP_AFTER_MS - 300);
    assert.deepEqual(host.declared, []);
    thaw(carol);
    frame(carol);
    await settle(peers); // her markers have reached the host and Bob; neither has had a frame since
    framesAlone(host, 40); // 640 ms: past the 8 s mark counted from when the wait began
    assert.ok(host.state.tick > held, 'the host moves again');
    assert.deepEqual(host.ls.waitingOn(), [1], 'and now waits for Bob');
    assert.deepEqual(host.declared, [], 'whom it heard from (his keepalive) well inside DROP_AFTER_MS');
    await drive(peers, () => peers.every((p) => p.state.tick >= c + 60));
    await settle(peers);
    assert.deepEqual(host.declared, []);
    for (const p of peers) assert.deepEqual(p.drops, []);
    assertInSync(peers, c + 60);
  });

  test('P1. the host pauses the room for longer than DROP_AFTER_MS: nobody moves, nobody is dropped, play resumes in sync', async (t) => {
    const { peers } = await threeHumans(t);
    const [host, bob, carol] = peers;
    const paced = { paced: true, instant: true, clockStep: 20 };
    const from = host.state.tick;
    await drive(peers, () => peers.every((p) => p.state.tick >= from + 10), paced);
    hostPause(host, true);
    await settle(peers);
    assert.ok(bob.paused && carol.paused, 'the pause reaches the guests');
    const ticks = peers.map((p) => p.state.tick);
    await elapse(peers, peers, DROP_AFTER_MS + 2000);
    assert.deepEqual(peers.map((p) => p.state.tick), ticks, 'nothing runs while paused');
    assert.deepEqual(host.declared, []);
    hostPause(host, false);
    await settle(peers);
    assert.ok(!bob.paused && !carol.paused);
    await drive(peers, () => peers.every((p) => p.state.tick >= from + 50), paced);
    await settle(peers);
    assert.deepEqual(host.declared, [], 'the pause itself is nobody\'s absence');
    for (const p of peers) assert.deepEqual(p.drops, []);
    assertInSync(peers, from + 50);
  });

  // (main.js hostDropWatch restarts every silence clock when a hold ends -- on
  // the host too, which is the peer that drops. Before that, the first guest the
  // host had to wait for after a long pause was dropped two frames later.)
  test('P2. after a pause longer than DROP_AFTER_MS, a guest that needs one second to get going again is not dropped', async (t) => {
    const { peers } = await threeHumans(t);
    const [host, bob, carol] = peers;
    const paced = { paced: true, instant: true, clockStep: 20 };
    const from = host.state.tick;
    await drive(peers, () => peers.every((p) => p.state.tick >= from + 10), paced);
    hostPause(host, true);
    await settle(peers);
    await elapse(peers, peers, DROP_AFTER_MS + 2000);
    hostPause(host, false);
    await settle(peers);
    assert.ok(!bob.paused && !carol.paused, 'the guests resume (and restart their silence clocks)');
    bob.frozen = true; // Bob's machine hiccups as play resumes (his connection is fine)
    const resumedAt = clock.t;
    await drive(peers, () => clock.t >= resumedAt + 1000 || host.declared.length > 0, paced);
    const verdict = host.declared[0] || null;
    await settle(peers);
    bob.frozen = false;
    const left = peers.filter((p) => !p.gone);
    await drive(left, () => left.every((p) => p.state.tick >= from + 50), paced);
    await settle(peers);
    assert.equal(verdict, null, 'the host gave up on Bob ' + (verdict ? verdict.clock - resumedAt : '-') + ' ms after resuming: '
      + 'the pause itself was counted as his silence');
    assert.deepEqual(left, peers);
    assert.deepEqual(host.declared, []);
    assertInSync(peers, from + 50);
  });

  test('P3. after a pause longer than DROP_AFTER_MS at 100 ms of latency, healthy guests whose next tick is due later than the host\'s are not dropped', async (t) => {
    const srv = await startServer(UNTHROTTLED);
    t.after(() => srv.close());
    const peers = await lobby(srv, [
      { name: 'Host', faction: 'Egypt' },
      { name: 'Bob', faction: 'Turkey' },
      { name: 'Carol', faction: 'Iran' },
    ], { map: pickMap(3, 'gulf'), delay: 2 });
    t.after(() => { for (const p of peers) p.Net.leave(); });
    const [host, bob, carol] = peers;
    for (const p of peers) { p.latencyMs = 100; p.script.quiet = true; }
    const paced = { paced: true, instant: true, clockStep: 16 };
    await drive(peers, () => peers.every((p) => p.state.tick >= 40), paced);
    assert.deepEqual(peers.map((p) => holds(p, 20)), [0, 0, 0], 'a healthy room: 100 ms is well inside what delay 2 absorbs');
    hostPause(host, true);
    const pausedAt = clock.t;
    await drive(peers, () => clock.t >= pausedAt + DROP_AFTER_MS + 2000, paced);
    assert.ok(bob.paused && carol.paused);
    assert.deepEqual(host.declared, []);
    // Where a machine stands inside its 100 ms tick when the pause ends is
    // arbitrary. Here: the host's next tick is due at once, the guests' a full
    // tick after the resume reaches them.
    host.acc = TICK_MS - 1;
    bob.acc = 0;
    carol.acc = 0;
    hostPause(host, false);
    const resumedAt = clock.t;
    await drive(peers, () => clock.t >= resumedAt + 3000, paced);
    await settle(peers);
    const verdicts = host.declared.map((d) => ({ slot: d.slot, msAfterResume: d.clock - resumedAt }));
    assert.deepEqual(verdicts, [], 'healthy guests dropped by the host on resuming');
    assert.ok(!bob.selfDropped && !carol.selfDropped);
    assert.ok(peers.every((p) => p.state.tick >= 65), 'and the match runs on: ' + peers.map((p) => p.state.tick).join('/'));
    assertInSync(peers, 65);
  });

  // ---- one tick, several orders --------------------------------------------------

  test('E. two orders for one tick, given a frame apart: nobody runs the tick on the strength of the first', async (t) => {
    const { peers } = await threeHumans(t);
    const [host, bob, carol] = peers;
    const delay = host.ls.getDelay();
    carol.frozen = true; // her frames run and read input, but her next tick is not due yet
    await stepUntilHeld([host, bob], peers);
    const c = carol.state.tick;
    const X = c + delay;
    assert.equal(host.state.tick, X);
    assert.equal(bob.state.tick, X);

    const first = mcvMove(carol, 0);
    const second = mcvMove(carol, 2, 4);
    assert.equal(issue(carol, first), X);
    await settle(peers);
    frame(host);
    frame(bob); // the others have a frame with her first order for X in hand
    await settle(peers);
    assert.deepEqual([host.state.tick, bob.state.tick], [X, X], 'one order does not complete her input for the tick');
    assert.equal(issue(carol, second), X, 'a frame later she is still on the same tick: same stamp');
    await settle(peers);
    frame(host);
    frame(bob);
    await settle(peers);
    assert.deepEqual([host.state.tick, bob.state.tick], [X, X], 'nor do two: only her marker does');

    carol.frozen = false;
    await drive(peers, () => peers.every((p) => p.state.tick >= c + 60));
    await settle(peers);
    for (const p of peers) {
      assert.deepEqual(appliedTicks(p, first), [X], p.tag + ' ran her first order on tick ' + X);
      assert.deepEqual(appliedTicks(p, second), [X], p.tag + ' ran her second order on tick ' + X);
    }
    const compared = assertInSync(peers, c + 60);
    t.diagnostic(`both orders ran on tick ${X} on all three; ${compared} checksums compared`);
  });

  test('E2. a backlogged receiver whose frames fall between two orders for the same tick waits for the marker behind them', async (t) => {
    const { peers } = await threeHumans(t);
    const [host, bob, carol] = peers;
    const delay = host.ls.getDelay();
    carol.frozen = true;
    await stepUntilHeld([host, bob], peers);
    const c = carol.state.tick;
    const X = c + delay;
    assert.equal(bob.state.tick, X, 'Bob is due to run X the moment he may');

    bob.inboundHeld = true; // a hiccup on Bob's link: what is sent now reaches him as one burst
    const first = mcvMove(carol, 0);
    const second = mcvMove(carol, 2, 4);
    assert.equal(issue(carol, first), X); // two clicks in one frame...
    assert.equal(issue(carol, second), X);
    carol.frozen = false;
    frame(carol); // ...and then her tick: the marker for X leaves after both orders
    assert.ok(marker(carol) >= X);
    await settle(peers);
    assert.ok(bob.inboundQueue.length >= 3);

    // the burst arrives, and Bob's frame loop gets a turn after every single message
    const seen = [];
    releaseStepwise(bob, () => {
      frame(bob);
      seen.push({ last: bob.heard[bob.heard.length - 1], tick: bob.state.tick, carolMarker: markerSeen(bob, 2) });
    });
    const afterOrders = seen.filter((s) => s.last.from === 2 && s.last.t === 'cmd');
    assert.equal(afterOrders.length, 2);
    for (const s of afterOrders) {
      assert.equal(s.tick, X, 'with an order for X but no marker for it, Bob holds');
      assert.ok(s.carolMarker < X);
    }
    const afterMarker = seen.find((s) => s.last.from === 2 && s.last.t === 'eoi' && s.last.tick >= X);
    assert.ok(afterMarker && afterMarker.tick > X, 'her marker for X opens the tick');
    assert.deepEqual(appliedTicks(bob, first), [X]);
    assert.deepEqual(appliedTicks(bob, second), [X]);

    await drive(peers, () => peers.every((p) => p.state.tick >= c + 60));
    await settle(peers);
    for (const p of peers) {
      assert.deepEqual(appliedTicks(p, first), [X], p.tag + ': first order');
      assert.deepEqual(appliedTicks(p, second), [X], p.tag + ': second order');
    }
    assertInSync(peers, c + 60);
  });

  // ---- a peer that breaks the protocol -------------------------------------------

  test('X. a command for a tick its sender already declared complete is ignored by every peer alike, wherever each of them is', async (t) => {
    const { peers } = await threeHumans(t);
    const [host, bob, carol] = peers;
    const delay = host.ls.getDelay();
    bob.inboundHeld = true; // Bob lags `delay` ticks behind the host
    await stepUntilHeld(peers);
    const T = bob.state.tick;
    assert.equal(host.state.tick, T + delay);
    const M = marker(carol);
    assert.equal(markerSeen(host, 2), M);
    assert.ok(T + 1 < host.state.tick && T + 1 <= M, 'tick T+1: the host has run it, Bob has not, Carol closed it long ago');

    // a faulty (or hostile) client: commands for ticks at or below its own marker
    const rogue = (tick, k) => {
      const cmd = mcvMove(carol, k, 6);
      carol.Net.sendGame({ t: 'cmd', tick, slot: carol.slot, seq: 900000 + k, cmd });
      return cmd;
    };
    const stale = rogue(T + 1, 0); // without the rule: void on the host (already run), applied by Bob
    const closed = rogue(M, 1);    // exactly on the marker
    const honest = mcvMove(carol, 3, 6);
    assert.equal(issue(carol, honest), M + 1, 'the first tick still open to her');
    await settle(peers);
    releaseInbound(bob);
    await drive(peers, () => peers.every((p) => p.state.tick >= T + 60));
    await settle(peers);
    for (const p of peers) {
      assert.deepEqual(appliedTicks(p, stale), [], p.tag + ' ignores the command for a tick long closed');
      assert.deepEqual(appliedTicks(p, closed), [], p.tag + ' ignores the command for the last closed tick');
      assert.deepEqual(appliedTicks(p, honest), [M + 1], p.tag + ' runs the legitimate order');
    }
    assert.ok(bob.heard.some((m) => m.t === 'cmd' && m.seq === 900000) && host.heard.some((m) => m.t === 'cmd' && m.seq === 900000), 'both did receive it');
    const compared = assertInSync(peers, T + 60);
    t.diagnostic(`rogue commands for ticks ${T + 1} (host on ${T + delay}, Bob on ${T}) and ${M} (= her marker): ignored by all; ${compared} checksums compared`);
  });

  test('X2. a drop declaration from anyone but the host is ignored by every peer: nobody is evicted, the room stays up', async (t) => {
    const { srv, peers } = await threeHumans(t);
    const [host, bob, carol] = peers;
    const from = host.state.tick;
    // Carol's client is modified: it "declares" Bob dropped, then the host --
    // once plainly, once claiming to be the host, once asking for the echo.
    // The relay stamps the true sender on all of them.
    carol.Net.sendGame({ t: 'drop', slot: 1, at: from + 5 });
    carol.Net.sendGame({ t: 'drop', slot: 0, at: from + 5 });
    carol.Net.sendGame({ t: 'drop', slot: 1, at: from + 5, from: 0 });
    carol.Net.sendGame({ t: 'drop', slot: 0, at: from + 5, from: 0, echo: true });
    await settle(peers);
    for (const p of peers) {
      const forged = p.heard.filter((m) => m.t === 'drop');
      assert.ok(forged.length >= (p === carol ? 1 : 4) && forged.every((m) => m.from === 2), p.tag + ' received them, stamped as Carol\'s');
      assert.equal(p.ls.isDropped(0), false, p.tag + ' does not take a guest\'s word that the host is gone');
      assert.equal(p.ls.isDropped(1), false, p.tag + ' does not take a guest\'s word that Bob is gone');
      assert.deepEqual(p.drops, []);
      assert.equal(p.selfDropped, false);
    }
    await drive(peers, () => peers.every((p) => p.state.tick >= from + 60));
    await settle(peers);
    assert.equal(host.hostLeft, null);
    assert.equal(bob.hostLeft, null, 'the room is still up');
    assert.deepEqual((await http(srv.origin + '/api/stats')).json, { online: 3, rooms: 1, publicRooms: 0, inMatch: 1, connections: 3 });
    assert.deepEqual(host.declared, []);
    for (const p of peers) assert.equal(p.state.players.some((pl) => pl.aiTakeover), false, 'no AI took anyone over');
    assertInSync(peers, from + 60);
  });

  // ---- lost markers ---------------------------------------------------------------

  test('M1. one end-of-input marker lost on the way: the next (cumulative) marker covers it', async (t) => {
    const { peers } = await threeHumans(t);
    const [host, bob, carol] = peers;
    const from = host.state.tick;
    host.lose = (m) => m.t === 'eoi' && m.from === 2 && host.lostMessages.length === 0;
    bob.lose = (m) => m.t === 'eoi' && m.from === 0 && bob.lostMessages.length === 0;
    await drive(peers, () => peers.every((p) => p.state.tick >= from + 60));
    await settle(peers);
    assert.equal(host.lostMessages.length, 1);
    assert.equal(bob.lostMessages.length, 1);
    assert.ok(markerSeen(host, 2) > host.lostMessages[0].tick, 'a later marker took its place');
    assert.deepEqual(host.declared, []);
    assertInSync(peers, from + 60);
  });

  test('M2. every marker from one peer lost until the whole room is stuck: nothing moves until that peer\'s keepalive repairs it', async (t) => {
    const { peers } = await threeHumans(t);
    const [host, bob, carol] = peers;
    host.lose = (m) => m.t === 'eoi' && m.from === 2; // Carol -> host is down for markers
    await stepUntilHeld(peers);
    const stuck = peers.map((p) => p.state.tick);
    assert.ok(host.lostMessages.length >= 1);
    const lostUpTo = Math.max(...host.lostMessages.map((m) => m.tick));
    assert.equal(marker(carol), lostUpTo, 'her latest marker is among the lost ones');
    assert.ok(markerSeen(host, 2) < host.state.tick);
    assert.deepEqual(host.ls.waitingOn(), [2]);
    assert.deepEqual(bob.ls.waitingOn(), [0], 'everyone else is stuck behind the host');
    assert.deepEqual(carol.ls.waitingOn(), [0]);

    host.lose = null; // the link is fine again -- but what was lost stays lost
    const carolSent = carol.sent.length;
    await stepUntilHeld(peers);
    assert.deepEqual(peers.map((p) => p.state.tick), stuck, 'nobody has anything new to say: the room stays stuck');
    assert.equal(carol.sent.length, carolSent);

    const healedAt = clock.t;
    let movedAt = 0;
    await elapse(peers, peers, KEEPALIVE_MS + 200, { step: 50, each: () => { if (!movedAt && host.state.tick > stuck[0]) movedAt = clock.t; } });
    assert.ok(movedAt > 0, 'the room moves again');
    assert.ok(movedAt - healedAt <= KEEPALIVE_MS + 50, `within KEEPALIVE_MS (took ${movedAt - healedAt} ms)`);
    const again = carol.sent[carolSent];
    assert.deepEqual(again, { t: 'eoi', tick: lostUpTo }, 'what repaired it is Carol re-sending the marker she already declared');
    for (let i = 0; i < peers.length; i++) assert.ok(peers[i].state.tick > stuck[i], peers[i].tag + ' runs again');

    const from = host.state.tick;
    await drive(peers, () => peers.every((p) => p.state.tick >= from + 40));
    await settle(peers);
    assert.deepEqual(host.declared, []);
    const compared = assertInSync(peers, from + 40);
    t.diagnostic(`${host.lostMessages.length} markers lost (up to tick ${lostUpTo}); room stuck on ${stuck.join('/')}; repaired by a keepalive after ${movedAt - healedAt} virtual ms; ${compared} checksums compared`);
  });

  // ---- latency --------------------------------------------------------------------

  test('L1. input delay 2 absorbs 150 ms of one-way latency: full 10 Hz, not a single gate wait after start-up', async (t) => {
    const r = await latencyMatch(t, { delay: 2, latencyMs: 150, ticks: 110, warm: 30 });
    assert.deepEqual(r.holdsAfterWarm, [0, 0, 0], 'gate waits after start-up (last wait was on tick ' + r.lastHoldTick + ')');
    assert.ok(Math.abs(r.msPerTick - TICK_MS) < 1, `the match runs at the full rate: ${r.msPerTick.toFixed(1)} ms per tick`);
    const orders = assertOrdersRanEverywhere(r.peers);
    assert.ok(orders >= 20);
    const compared = assertInSync(r.peers, r.ticks);
    t.diagnostic(`delay 2 @ 150 ms: ${r.msPerTick.toFixed(1)} ms/tick after tick ${r.warm}, last gate wait on tick ${r.lastHoldTick}, start-up ${r.startupMs} ms; ${orders} orders, ${compared} checksums compared`);
  });

  test('L2. input delay 4 absorbs 350 ms of one-way latency the same way', async (t) => {
    const r = await latencyMatch(t, { delay: 4, latencyMs: 350, ticks: 130, warm: 50 });
    assert.deepEqual(r.holdsAfterWarm, [0, 0, 0], 'gate waits after start-up (last wait was on tick ' + r.lastHoldTick + ')');
    assert.ok(Math.abs(r.msPerTick - TICK_MS) < 1, `the match runs at the full rate: ${r.msPerTick.toFixed(1)} ms per tick`);
    const orders = assertOrdersRanEverywhere(r.peers);
    assert.ok(orders >= 20);
    const compared = assertInSync(r.peers, r.ticks);
    t.diagnostic(`delay 4 @ 350 ms: ${r.msPerTick.toFixed(1)} ms/tick after tick ${r.warm}, last gate wait on tick ${r.lastHoldTick}, start-up ${r.startupMs} ms; ${orders} orders, ${compared} checksums compared`);
  });

  test('L3 (control). latency beyond the delay budget -- delay 2 at 250 ms -- is NOT absorbed: the room waits on every tick and slows down, in sync', async (t) => {
    const r = await latencyMatch(t, { delay: 2, latencyMs: 250, ticks: 80, warm: 30 });
    assert.ok(r.holdsAfterWarm.every((n) => n > 0), 'every peer keeps hitting the gate: ' + r.holdsAfterWarm);
    assert.ok(r.msPerTick > TICK_MS * 1.15, `slower than 10 Hz: ${r.msPerTick.toFixed(1)} ms per tick`);
    assertOrdersRanEverywhere(r.peers);
    assertInSync(r.peers, r.ticks);
    t.diagnostic(`delay 2 @ 250 ms: ${r.msPerTick.toFixed(1)} ms/tick, gate waits after tick ${r.warm}: ${r.holdsAfterWarm.join('/')}`);
  });
});

// main.js's frame loop is re-stated in this file (its drop functions and hooks
// are run as they are). If main.js stops matching what is re-stated, or the
// harness can no longer find what it runs, say so here rather than let the
// tests above pass or fail for the wrong reason.
describe('the harness mirrors the real client', () => {
  const NET_SRC = fs.readFileSync(path.join(CLIENT, 'src', 'net', 'net.js'), 'utf8');
  const mirrors = (src, file, re, what) => assert.ok(re.test(src),
    file + ' no longer matches what server/test/lockstep.e2e.test.mjs re-states (' + what + '): update the harness there');

  test('main.js: constants, the functions and hooks the harness runs, and the frame loop it re-states', () => {
    for (const [name, value] of Object.entries({ TICK_MS, DROP_AFTER_MS, LOAD_GRACE_MS, TAKEOVER_DELAY_TICKS })) {
      assert.ok(Number.isFinite(value) && value > 0, 'main.js no longer declares `const ' + name + ' = <number>;`');
    }
    assert.ok(DROP_AFTER_MS > STALL_TIMEOUT_MS && LOAD_GRACE_MS > DROP_AFTER_MS);
    mirrors(MAIN_SRC, 'main.js', /if \(!mpSimStep\(\)\) break;/, 'frame loop: a closed gate holds the accumulator');
    mirrors(MAIN_SRC, 'main.js', /hostDropWatch\(now\);[^\n]*\n\s*processPendingDrops\(\);/, 'frame loop: hostDropWatch(now), then processPendingDrops()');
    mirrors(MAIN_SRC, 'main.js', /G\.state && !G\.paused && /, 'frame loop: no ticks while paused');
    for (const name of Object.keys(REAL_SOURCE)) {
      assert.ok(REAL_SOURCE[name], 'main.js: `' + name + '` was not found where the harness lifts it from (see REAL_SOURCE)');
    }
    mirrors(MAIN_SRC, 'main.js', /if \(G\.pendingCmds\.length\) \{[\s\S]{0,400}?G\.ls\.issue\(c\);[\s\S]{0,200}?const advanced = G\.ls\.advance\(\);/, 'mpSimStep: pending input is issued, then one tick is attempted');
    assert.ok(!/forceOnSilence/.test(MAIN_SRC), 'live play must not run the scheduler with forceOnSilence');
  });

  test('net.js: a drop declaration is sent for echo, and only the no-echo fallback applies it locally (without the flag)', () => {
    mirrors(NET_SRC, 'net.js', /sendDrop\(slot, at\) \{[\s\S]{0,1200}?this\._send\(\{ t: 'drop', slot, at, echo: true \}\);/, 'sendDrop asks the relay to echo the declaration');
    const body = /sendDrop\(slot, at\) \{[\s\S]*?\n  \},/.exec(NET_SRC);
    assert.ok(body, 'net.js sendDrop() not found');
    const local = body[0].match(/this\._hook\('onGameMsg', \{[^}]*\}\)/g) || [];
    assert.ok(local.length >= 1 && local.every((call) => /t: 'drop'/.test(call) && /from: this\.slot/.test(call) && !/echo/.test(call)),
      'net.js sendDrop: the harness tells the local fallback from the relay echo by the missing `echo` flag: ' + local.join(' | '));
  });

  test('lockstep.js: the scheduler interface the tests drive and inspect', async (t) => {
    for (const [name, value] of Object.entries({ CSUM_EVERY, STALL_TIMEOUT_MS, KEEPALIVE_MS, MP_STEP_CAP })) {
      assert.ok(Number.isFinite(value) && value > 0, 'lockstep.js no longer exports ' + name);
    }
    assert.ok(KEEPALIVE_MS < DROP_AFTER_MS / 4, 'a waiting peer must be heard from many times inside DROP_AFTER_MS');
    const sent = [];
    const state = Sim.createMatch({
      data: JSON.parse(DATA_TEXT), map: JSON.parse(mapText(pickMap(2, 'duel'))), seed: 7,
      players: [{ slot: 0, faction: 'Egypt', team: 0 }, { slot: 1, faction: 'Turkey', team: 1 }],
    });
    const ls = createLockstep({ state, ai: Sim.createAI([], 7), playerSlot: 0, humanSlots: [0, 1], delay: 2, send: (m) => sent.push(m), now: () => 5 });
    for (const fn of ['issue', 'ingest', 'advance', 'logSnapshot', 'isDesynced', 'isDropped', 'waitingOn', 'isWaiting', 'safeDropTick', 'getDelay', 'debugState', 'resume']) {
      assert.equal(typeof ls[fn], 'function', 'the scheduler no longer has ' + fn + '()');
    }
    assert.deepEqual(Object.keys(ls.debugState()).sort(), ['bornAt', 'eoiFrom', 'eoiSent', 'gateWaitStart', 'lastHeard', 'tick', 'waitingOn']);
    assert.deepEqual(sent, [], 'nothing is sent before the first tick is attempted');
    assert.equal(ls.advance(), false, 'tick 0 waits for the other player');
    assert.deepEqual(sent, [{ t: 'eoi', tick: 1 }], 'on tick 0 with delay 2 a peer declares its input complete up to tick 1');
    assert.deepEqual(ls.waitingOn(), [1]);
    assert.equal(ls.safeDropTick(1), 2);
    ls.ingest({ t: 'eoi', tick: 0, from: 1 });
    assert.equal(ls.advance(), true, 'the other player\'s marker opens the tick');
    assert.deepEqual(sent[sent.length - 1], { t: 'eoi', tick: 2 });
    assert.ok(/forceOnSilence/.test(LOCKSTEP_SRC), 'the pre-1.0 rule is still available to the "old rule" control test');
  });
});
