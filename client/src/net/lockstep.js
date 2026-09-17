// Lockstep scheduler (v0.10.0): pure, DOM-free bookkeeping shared by the
// browser game (main.js) and the headless two-peer test (tools/test_lockstep.py).
// Transport-agnostic: the owner injects send(msg) / now() and feeds received
// protocol messages into ingest(). main.js owns rendering/HUD around this.
//
// Model: every human command is stamped for tick = localTick + DELAY and sent
// immediately. simStep(T) runs only once the ready-set for T holds every human
// slot's commands-or-stall. A missing-but-responsive peer holds the gate (its
// inputs are still in flight -- the sim slows down instead of desyncing); a
// peer silent for STALL_TIMEOUT_MS is force-stalled so the match can limp on
// until the host declares a drop (AI takeover). Per-tick merge order: all
// human commands sorted by (slot, seq), after the locally-run seeded AI
// commands (aiCommands is deterministic -- private seeded RNG, tick-gated
// thinks, no wall clock).
//
// Checksums: every CSUM_EVERY ticks each peer broadcasts its FNV-1a state
// checksum; a mismatch freezes the match (onDesync) rather than letting the
// sims drift apart silently.
import { tick, checksum } from '../sim/index.js';
import { aiCommands } from '../sim/index.js';

export const CSUM_EVERY = 25;          // checksum exchange cadence (ticks)
export const STALL_TIMEOUT_MS = 1500;  // real-time grace before forcing the gate
export const MP_STEP_CAP = 30;         // per-frame catch-up cap (offline: 6)

export function createLockstep(opts) {
  const {
    state, ai, playerSlot, humanSlots, delay,
    send, now, onDesync, onPeerDrop, extraCmds, trace,
  } = opts;
  const me = playerSlot;
  const peers = humanSlots.filter((s) => s !== me).sort((a, b) => a - b);
  const all = humanSlots.slice().sort((a, b) => a - b);

  let seq = 0;
  const outbox = new Map();   // tick -> [{slot, seq, cmd}] my stamped commands
  const incoming = new Map(); // tick -> {slot -> {cmds:[{slot,seq,cmd}..], stall:bool}}
  const csumMine = new Map(); // tick -> sum
  const csumTheirs = new Map(); // tick -> {slot, sum}
  const cmdLog = new Map();   // tick -> [{slot, seq, cmd}] everything (host log)
  const lastHeard = {};       // slot -> virtual/real time of its latest message
  const bornAt = now();       // a peer silent since creation forces this long
  let gateWaitStart = -1;     // now() when the current gate first blocked
  let waitingOn = [];         // slots the gate is currently missing
  let desynced = false;
  let dropped = new Set();    // slots the host declared dropped -> ignore
  let catchupMode = false;    // replaying the host log (late join)
  let lastStallSent = -1;
  const stats = { stallWaits: 0, forcedSteps: 0, desyncs: 0 };

  function logCmd(tickN, entry) {
    let arr = cmdLog.get(tickN);
    if (!arr) { arr = []; cmdLog.set(tickN, arr); }
    arr.push(entry);
  }

  // ---- outgoing --------------------------------------------------------------

  // Stamp a local command for localTick + delay and broadcast it.
  function issue(raw) {
    if (state.over || desynced) return null;
    const t = state.tick + delay;
    const entry = { slot: me, seq: seq++, cmd: raw };
    outbox.set(t, (outbox.get(t) || []).concat([entry]));
    logCmd(t, entry);
    send({ t: 'cmd', tick: t, slot: me, seq: entry.seq, cmd: raw });
    maybeSendStall();
    return entry;
  }

  // Keepalive: once the next tick is gated on my input and I have none, tell
  // the room so the gate can close. Idempotent per tick.
  function maybeSendStall() {
    const t = state.tick;
    if (lastStallSent >= t) return;
    if (outbox.has(t)) return;
    lastStallSent = t;
    send({ t: 'stall', tick: t });
  }

  function broadcastCsum() {
    const sum = checksum(state);
    csumMine.set(state.tick, sum);
    send({ t: 'csum', tick: state.tick, sum });
    // catch up on comparisons that arrived while we were behind
    for (const [t, rec] of csumTheirs) {
      if (csumMine.has(t) && rec.sum !== csumMine.get(t)) {
        desynced = true;
        stats.desyncs++;
        if (onDesync) onDesync({ tick: t, mine: csumMine.get(t), theirs: rec.sum, slot: rec.slot });
      }
    }
  }

  // ---- incoming --------------------------------------------------------------

  function ingest(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    // sender slot: the relay stamps `from` on every relayed message (cmd also
    // carries its own `slot`; accept either so test doubles stay simple)
    const slot = msg.from !== undefined ? msg.from : msg.slot;
    switch (msg.t) {
      case 'cmd': {
        if (slot === undefined || dropped.has(slot)) break;
        lastHeard[slot] = now();
        if (msg.tick < state.tick && !catchupMode) break; // stale (forced past)
        let per = incoming.get(msg.tick);
        if (!per) { per = {}; incoming.set(msg.tick, per); }
        let rec = per[slot];
        if (!rec) { rec = { cmds: [], stall: false }; per[slot] = rec; }
        rec.cmds.push({ slot, seq: msg.seq, cmd: msg.cmd });
        logCmd(msg.tick, rec.cmds[rec.cmds.length - 1]);
        break;
      }
      case 'stall':
        if (slot === undefined || dropped.has(slot)) break;
        lastHeard[slot] = now();
        maybeSendStall();
        if (slot === me) break;
        if (msg.tick < state.tick) break; // stale; the gate already passed it
        {
          let per = incoming.get(msg.tick);
          if (!per) { per = {}; incoming.set(msg.tick, per); }
          let rec = per[slot];
          if (!rec) { rec = { cmds: [], stall: false }; per[slot] = rec; }
          rec.stall = true;
        }
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
      case 'drop':
        dropped.add(msg.slot);
        if (onPeerDrop) onPeerDrop(msg);
        break;
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
    const per = incoming.get(t) || {};
    const missing = [];
    for (const s of peers) {
      if (dropped.has(s)) continue;
      const rec = per[s];
      if (!rec || (rec.cmds.length === 0 && !rec.stall)) missing.push(s);
    }
    return { ok: missing.length === 0, missing };
  }

  function mergedCommands(t) {
    const merged = [];
    const mine = outbox.get(t);
    if (mine) for (const e of mine) merged.push(e);
    const per = incoming.get(t);
    if (per) {
      for (const s of peers) {
        if (dropped.has(s)) continue; // stray in-flight cmds from a dropped slot
        const rec = per[s];
        if (rec) for (const e of rec.cmds) merged.push(e);
      }
    }
    merged.sort((a, b) => (a.slot - b.slot) || (a.seq - b.seq));
    return merged;
  }

  // Execute one tick if the gate allows. Returns true when a tick ran.
  // In catch-up mode (late join) the gate is skipped -- the host log is
  // authoritative and every logged tick is executed as-is.
  //
  // Gate rule: a missing peer blocks ONLY while it is still talking. A live
  // peer always sends its inputs before it can execute the tick itself, so
  // its commands/stalls eventually arrive -- the sim just runs slower than
  // real time while a peer lags (correct lockstep behavior). The 1.5s
  // STALL_TIMEOUT is a SILENCE timeout: it fires only when the peer has sent
  // nothing at all for that long, letting the match limp on until the host
  // declares a drop (AI takeover).
  function advance() {
    if (state.over || desynced) return false;
    const t = state.tick;
    maybeSendStall();
    if (!catchupMode) {
      const r = ready(t);
      if (!r.ok) {
        const nowT = now();
        if (gateWaitStart < 0) { gateWaitStart = nowT; waitingOn = r.missing; }
        const silent = r.missing.filter((s) =>
          nowT - (lastHeard[s] !== undefined ? lastHeard[s] : bornAt) >= STALL_TIMEOUT_MS);
        if (!silent.length) {
          if (trace) trace.push({ tick: t, gate: 'hold', missing: r.missing.slice() });
          return false; // peers alive but behind -- hold
        }
        stats.stallWaits++;
        stats.forcedSteps++;
        waitingOn = r.missing;
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
    waitingOn: () => waitingOn.slice(),
    isWaiting: () => gateWaitStart >= 0,
    setDelay: (d) => { delay = d; },
    getDelay: () => delay,
    // diagnostics for tests/forensics: last-heard times + gate bookkeeping
    debugState: () => ({
      lastHeard: Object.assign({}, lastHeard),
      gateWaitStart, waitingOn: waitingOn.slice(), bornAt,
      tick: state.tick,
    }),
  };
}
