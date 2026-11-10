// Lockstep scheduler: pure, DOM-free bookkeeping shared by the browser game
// (main.js) and the headless multi-peer tests (server/test). Transport-
// agnostic: the owner injects send(msg) / now() and feeds received protocol
// messages into ingest(). main.js owns rendering/HUD around this.
//
// Model
// -----
// Every human command is stamped for tick = localTick + DELAY and sent at
// once. A peer may still issue commands for tick T until it leaves tick
// T - DELAY; at that moment it broadcasts an END-OF-INPUT marker,
// {t:'eoi', tick:T}, meaning "you now hold every command I will ever send
// for ticks <= T". simStep(T) runs only when every human slot's marker
// covers T. Markers are cumulative, so a lost or late one is repaired by the
// next (and a waiting peer re-sends its latest as a keepalive).
//
// Why a marker (v1.0). Earlier versions treated "any command for T, or a
// stall for T" as that peer's complete input for T. Two failures followed:
//   - a player who issued two commands inside one tick (two frames, 16 ms
//     apart) could have the second arrive after a fast peer had already run
//     T on the strength of the first: applied locally, dropped as stale
//     remotely, desync;
//   - a stall for T was only sent on REACHING T, so peers were locked within
//     one tick of each other and every tick cost a network round trip: at
//     150 ms latency the whole match ran at ~6.7 ticks/s and the input delay
//     bought nothing. With markers sent DELAY ticks ahead, latency up to
//     DELAY x 100 ms is absorbed and the sim holds 10 Hz.
//
// A missing peer ALWAYS holds the gate: the match waits (for everyone) until
// it answers or the host declares it dropped. The old "force the tick after
// 1.5 s of silence" rule is gone from live play (a peer that froze briefly
// and then acted desynced the room); it survives as opts.forceOnSilence for
// offline tooling only.
//
// Drops are tick-aligned: {t:'drop', slot, at}. A dropped slot stops gating
// at once; its commands count for ticks below `at` and are ignored from `at`
// on. The host picks `at` with safeDropTick(), a tick no machine can already
// be past, so every peer makes the same decision whatever tick it had
// reached when the declaration arrived.
//
// Per-tick merge order: all human commands sorted by (slot, seq), then local
// deterministic extras, then the seeded AI (pure functions of shared state).
//
// Checksums: every CSUM_EVERY ticks each peer broadcasts its FNV-1a state
// checksum; a mismatch freezes the match (onDesync) rather than letting the
// sims drift apart silently.
import { tick, checksum } from '../sim/index.js';
import { aiCommands } from '../sim/index.js';

export const CSUM_EVERY = 25;          // checksum exchange cadence (ticks)
export const STALL_TIMEOUT_MS = 1500;  // forceOnSilence only (offline tooling)
export const KEEPALIVE_MS = 500;       // re-send my marker while I am waiting
export const MP_STEP_CAP = 30;         // per-frame catch-up cap (offline: 6)

// Online, time spent waiting for the room is not owed back. Nobody can be
// more than the input delay ahead of anybody else, so after a hold there is
// nothing to catch up to: replaying the wait at full speed only fast-forwards
// the match for everyone (and can trip the relay's rate limit). While the
// gate is closed a peer keeps one tick of backlog; otherwise a few, enough to
// absorb an ordinary hiccup.
export function shedBacklog(accMs, tickMs, waiting, delay) {
  const keep = waiting ? 1 : (delay | 0) + 2;
  return accMs > tickMs * keep ? tickMs * keep : accMs;
}

export function createLockstep(opts) {
  const {
    state, ai, playerSlot, humanSlots,
    send, now, onDesync, onPeerDrop, extraCmds, trace,
  } = opts;
  let delay = Math.max(1, opts.delay | 0 || 2);
  const forceOnSilence = !!opts.forceOnSilence;
  const hostSlot = opts.hostSlot === undefined ? 0 : opts.hostSlot; // the relay seats the host at 0
  const me = playerSlot;
  const peers = humanSlots.filter((s) => s !== me).sort((a, b) => a - b);

  let seq = 0;
  const outbox = new Map();     // tick -> [{slot, seq, cmd}] my stamped commands
  const incoming = new Map();   // tick -> {slot -> [{slot, seq, cmd}..]}
  const csumMine = new Map();   // tick -> sum
  const csumTheirs = new Map(); // tick -> {slot, sum}
  const cmdLog = new Map();     // tick -> [{slot, seq, cmd}] everything (host log)
  const lastHeard = {};         // slot -> now() of its latest message
  const eoiFrom = {};           // slot -> highest tick that peer declared complete
  const bornAt = now();
  let eoiSent = -1;             // my input is complete for every tick <= eoiSent
  let lastEoiAt = -Infinity;    // now() of my last marker (keepalive pacing)
  let gateWaitStart = -1;       // now() when the current gate first blocked
  let waitingOn = [];           // slots the gate is currently missing
  let desynced = false;
  const dropped = new Map();    // slot -> tick its drop takes effect
  // Drops I (the host) have declared but not yet seen come back from the
  // relay: slot -> line. Until one returns I do not know where it landed in
  // the room's message order, so I must not run its line or anything past
  // it -- the others will ignore that player's input from the line on.
  const pendingDrops = new Map();
  let catchupMode = false;      // replaying the host log (late join)
  const stats = { stallWaits: 0, forcedSteps: 0, desyncs: 0 };

  function logCmd(tickN, entry) {
    let arr = cmdLog.get(tickN);
    if (!arr) { arr = []; cmdLog.set(tickN, arr); }
    arr.push(entry);
  }

  // ---- outgoing --------------------------------------------------------------

  // Declare my input complete up to `upTo` (cumulative, monotonic). With
  // `again`, re-send the current marker even if nothing advanced.
  function declare(upTo, again) {
    if (upTo > eoiSent) eoiSent = upTo;
    else if (!again) return;
    if (eoiSent < 0) return;
    lastEoiAt = now();
    send({ t: 'eoi', tick: eoiSent });
  }

  // Stamp a local command for localTick + delay and broadcast it. Never
  // stamps a tick already declared complete.
  function issue(raw) {
    if (state.over || desynced || dropped.has(me)) return null;
    const t = Math.max(state.tick + delay, eoiSent + 1);
    const entry = { slot: me, seq: seq++, cmd: raw };
    outbox.set(t, (outbox.get(t) || []).concat([entry]));
    logCmd(t, entry);
    send({ t: 'cmd', tick: t, slot: me, seq: entry.seq, cmd: raw });
    return entry;
  }

  // Kept for callers of the old API: makes sure the room holds my marker for
  // everything I can no longer change.
  function maybeSendStall() {
    if (state.over || desynced) return;
    declare(state.tick + delay - 1);
  }

  function broadcastCsum() {
    const sum = checksum(state);
    csumMine.set(state.tick, sum);
    send({ t: 'csum', tick: state.tick, sum });
    // catch up on comparisons that arrived while we were behind
    for (const [t, rec] of csumTheirs) {
      if (!csumMine.has(t)) continue;
      csumTheirs.delete(t);
      if (rec.sum !== csumMine.get(t) && !desynced) {
        desynced = true;
        stats.desyncs++;
        if (onDesync) onDesync({ tick: t, mine: csumMine.get(t), theirs: rec.sum, slot: rec.slot });
      }
    }
  }

  // ---- incoming --------------------------------------------------------------

  function noteEoi(slot, t) {
    if (typeof t !== 'number' || !(t >= 0)) return;
    if (eoiFrom[slot] === undefined || t > eoiFrom[slot]) eoiFrom[slot] = t;
  }

  function ingest(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    // sender slot: the relay stamps `from` on every relayed message (cmd also
    // carries its own `slot`; accept either so test doubles stay simple)
    const slot = msg.from !== undefined ? msg.from : msg.slot;
    switch (msg.t) {
      case 'cmd': {
        if (slot === undefined || slot === me || dropped.has(slot)) break;
        lastHeard[slot] = now();
        // A command for a tick this peer already declared complete, or that
        // we already ran, breaks the protocol; it can only come from a
        // faulty or hostile client and must not be applied by some peers
        // and not others. Ignore it everywhere the same way.
        if (eoiFrom[slot] !== undefined && msg.tick <= eoiFrom[slot]) break;
        if (msg.tick < state.tick && !catchupMode) break;
        let per = incoming.get(msg.tick);
        if (!per) { per = {}; incoming.set(msg.tick, per); }
        const entry = { slot, seq: msg.seq, cmd: msg.cmd };
        (per[slot] || (per[slot] = [])).push(entry);
        logCmd(msg.tick, entry);
        break;
      }
      case 'eoi':
      case 'stall': // pre-1.0 name; a stall for T implied everything up to T
        if (slot === undefined || slot === me || dropped.has(slot)) break;
        lastHeard[slot] = now();
        noteEoi(slot, msg.tick);
        break;
      case 'csum': {
        if (slot === undefined || slot === me || dropped.has(slot)) break;
        lastHeard[slot] = now();
        if (csumMine.has(msg.tick)) {
          if (csumMine.get(msg.tick) !== msg.sum && !desynced) {
            desynced = true;
            stats.desyncs++;
            if (onDesync) onDesync({ tick: msg.tick, mine: csumMine.get(msg.tick), theirs: msg.sum, slot });
          }
        } else {
          csumTheirs.set(msg.tick, { slot, sum: msg.sum });
        }
        break;
      }
      case 'drop': {
        // only the host may declare a drop: a guest forging one could evict
        // any player (or, aimed at the host, close the room)
        if (slot !== undefined && slot !== hostSlot) break;
        if (typeof msg.slot !== 'number' || dropped.has(msg.slot)) break;
        pendingDrops.delete(msg.slot);
        const at = msg.at !== undefined ? msg.at : state.tick;
        dropped.set(msg.slot, at);
        if (onPeerDrop) onPeerDrop(Object.assign({}, msg, { at }));
        break;
      }
      case 'log': // host catch-up stream: authoritative command history
        if (Array.isArray(msg.cmds)) {
          for (const e of msg.cmds) logCmd(e.tick !== undefined ? e.tick : msg.tick, e);
        }
        break;
      default:
        break;
    }
  }

  // ---- gating + stepping -----------------------------------------------------

  function ready(t) {
    const missing = [];
    for (const s of peers) {
      if (dropped.has(s)) continue;
      if (eoiFrom[s] === undefined || eoiFrom[s] < t) missing.push(s);
    }
    return { ok: missing.length === 0, missing };
  }

  function mergedCommands(t) {
    const merged = [];
    if (!(dropped.has(me) && t >= dropped.get(me))) {
      const mine = outbox.get(t);
      if (mine) for (const e of mine) merged.push(e);
    }
    const per = incoming.get(t);
    if (per) {
      for (const s of peers) {
        // a dropped slot's commands count only below its drop tick
        if (dropped.has(s) && t >= dropped.get(s)) continue;
        const list = per[s];
        if (list) for (const e of list) merged.push(e);
      }
    }
    merged.sort((a, b) => (a.slot - b.slot) || (a.seq - b.seq));
    return merged;
  }

  // Execute one tick if the gate allows. Returns true when a tick ran. In
  // catch-up mode (late join) the gate is skipped: the host log is
  // authoritative and every logged tick is executed as-is.
  function advance() {
    if (state.over || desynced) return false;
    const t = state.tick;
    // while I sit on tick t, nothing I issue can be stamped below t + delay
    declare(t + delay - 1);
    if (!catchupMode) {
      // my own drop declaration is still on its way back: stop at its line
      let held = false;
      for (const at of pendingDrops.values()) if (t >= at) held = true;
      if (held) {
        if (trace) trace.push({ tick: t, gate: 'hold-drop-line' });
        return false;
      }
      const r = ready(t);
      if (!r.ok) {
        const nowT = now();
        if (gateWaitStart < 0) gateWaitStart = nowT;
        waitingOn = r.missing;
        const silent = forceOnSilence ? r.missing.filter((s) =>
          nowT - (lastHeard[s] !== undefined ? lastHeard[s] : bornAt) >= STALL_TIMEOUT_MS) : [];
        if (!silent.length) {
          // still here, still waiting: let the room know (and repair a
          // marker that never arrived)
          if (nowT - lastEoiAt >= KEEPALIVE_MS) declare(eoiSent, true);
          if (trace) trace.push({ tick: t, gate: 'hold', missing: r.missing.slice() });
          return false;
        }
        stats.stallWaits++;
        stats.forcedSteps++;
        if (trace) trace.push({ tick: t, gate: 'force', missing: r.missing.slice() });
      } else if (gateWaitStart >= 0) {
        gateWaitStart = -1;
        waitingOn = [];
      }
    }
    const merged = mergedCommands(t);
    // de-dupe safety: identical (slot,seq) can arrive via cmd + log
    const seen = new Set();
    const cmds = [];
    for (const e of merged) {
      const k = e.slot + ':' + e.seq;
      if (seen.has(k)) continue;
      seen.add(k);
      cmds.push(e.cmd);
    }
    // local extras (human auto-deploy etc.) and the seeded AI run identically
    // on every peer -- pure functions of the shared state
    if (extraCmds) for (const c of extraCmds(state)) cmds.push(c);
    for (const c of aiCommands(state, ai)) cmds.push(c);
    if (trace) trace.push({ tick: t, cmds: cmds.map((c) => JSON.stringify(c)) });
    tick(state, cmds);
    outbox.delete(t);
    incoming.delete(t);
    // I have left tick t: tick t + delay is now closed to my commands
    declare(state.tick + delay - 1);
    if ((state.tick % CSUM_EVERY) === 0) broadcastCsum();
    return true;
  }

  // Fast-forward 0->T from the host's command log (late join / catch-up).
  // Executes without gating; live gating resumes at the returned tick.
  function catchUp(targetTick) {
    catchupMode = true;
    let guard = targetTick + 10;
    while (state.tick < targetTick && !state.over && guard-- > 0) {
      const t = state.tick;
      const merged = (cmdLog.get(t) || []).slice()
        .sort((a, b) => (a.slot - b.slot) || (a.seq - b.seq));
      const cmds = merged.map((e) => e.cmd);
      if (extraCmds) for (const c of extraCmds(state)) cmds.push(c);
      for (const c of aiCommands(state, ai)) cmds.push(c);
      tick(state, cmds);
    }
    catchupMode = false;
    gateWaitStart = -1;
    return state.tick;
  }

  function logSnapshot(fromTick, toTick) {
    const out = [];
    for (let t = fromTick; t < toTick; t++) {
      const arr = cmdLog.get(t);
      if (arr) for (const e of arr) out.push({ tick: t, slot: e.slot, seq: e.seq, cmd: e.cmd });
    }
    return out;
  }

  return {
    issue, ingest, advance, catchUp, ready, logSnapshot, broadcastCsum,
    maybeSendStall,
    stats,
    isDesynced: () => desynced,
    isDropped: (s) => dropped.has(s),
    // After a room-wide pause nobody has spoken for as long as it lasted:
    // restart every silence clock so the pause itself is never read as a
    // peer having gone away.
    resume: () => {
      const t = now();
      for (const s of peers) if (lastHeard[s] !== undefined) lastHeard[s] = t;
      gateWaitStart = -1;
      waitingOn = [];
      lastEoiAt = -Infinity;
    },
    waitingOn: () => waitingOn.slice(),
    isWaiting: () => gateWaitStart >= 0,
    waitingSince: () => gateWaitStart,
    // The host calls this just before broadcasting {t:'drop', slot, at}: it
    // will then not run tick `at` or later until that declaration has come
    // back through the relay (or been applied locally as a fallback).
    expectDrop: (slot, at) => { if (!dropped.has(slot)) pendingDrops.set(slot, at); },
    // The earliest tick a drop of `slot` may take effect. No peer can run a
    // tick the host's own marker does not cover (host tick - 1 + delay), nor
    // one the dropped slot's marker does not cover, so a drop at or beyond
    // both is ahead of every machine in the room.
    safeDropTick: (slot) => Math.max(state.tick + delay,
      eoiFrom[slot] === undefined ? 0 : eoiFrom[slot] + 1),
    // Raising the delay is always safe; lowering it only takes effect for
    // ticks not yet declared complete (issue() never stamps below the marker).
    setDelay: (d) => { delay = Math.max(1, d | 0); },
    getDelay: () => delay,
    // diagnostics for tests/forensics
    debugState: () => ({
      lastHeard: Object.assign({}, lastHeard),
      eoiFrom: Object.assign({}, eoiFrom), eoiSent,
      gateWaitStart, waitingOn: waitingOn.slice(), bornAt,
      tick: state.tick,
    }),
  };
}
