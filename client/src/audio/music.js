// Adaptive score: track definitions (arrangements over the data in score.js),
// a step sequencer with look-ahead scheduling, cross-fading track players,
// intensity-gated layers and one-shot stingers.
//
// Timing model: a track advances in sixteenth-note steps on the AudioContext
// clock. MusicDirector.advance(now) is called from the engine heartbeat
// (~every 50 ms) and schedules every step that starts before now + lookahead
// (0.2 s), so note timing is sample-accurate and independent of timer
// jitter. Loops are not audio loops — the sequencer simply keeps counting
// bars — so a loop point is as continuous as any other bar line.
import { makeRng } from './dsp.js';
import {
  CHORDS, THEME, THEME_CHORDS, THEME_PARTS, THEME_COUNTER, INTRO_NEY, BRIDGE_NEY,
  BRIDGE_CHORDS, MENU_PHRASES, NEY_PHRASES, MENU_PROGS, COMBAT_PHRASES, COMBAT_NEY,
  COMBAT_A, COMBAT_A2, COMBAT_B, COMBAT_A3, COMBAT_B_BRASS, BRIEF_A, BRIEF_B, BRIEF_LINE,
  FANFARE, FANFARE_CHORDS, CALM_CHORDS, LAMENT, LAMENT_CHORDS, RHYTHM, midiOf,
} from './score.js';
import {
  PluckInst, BreathLead, PadInst, StacInst, BrassInst, Drone, DroneLoop, DrumKit,
} from './instruments.js';

// public track name -> arrangement id. 'ambient' and 'battle' are the same
// adaptive piece; 'battle' only raises the intensity floor.
const TRACK_OF = {
  title: 'title', menu: 'menu', briefing: 'briefing', ambient: 'combat', battle: 'combat',
  victory: 'victory', defeat: 'defeat',
};
const FLOOR = { battle: 0.62 };

export const TRACK_NAMES = ['title', 'menu', 'briefing', 'ambient', 'battle', 'victory', 'defeat'];
export const STINGER_NAMES = ['match_start', 'under_attack', 'superweapon_ready',
  'superweapon_launch', 'unit_lost', 'objective', 'countdown'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const REST = '................';
const IDLE = 30; // seconds without a note before an instrument is torn down
const HALL_SEND = 0.2;   // whole band, post-fader
const HALL_EXTRA = 0.28; // on top, for the instruments registered as "wet"

const DRUM_MAPS = {
  darbuka: { D: 'dum', T: 'tek', K: 'ka', S: 'slap' },
  frame: { D: 'frame', T: 'frame_tak' },
};

function accentOf(step) {
  if (step % 16 === 0) return 1;
  if (step % 8 === 0) return 0.94;
  if (step % 4 === 0) return 0.88;
  return step % 2 === 0 ? 0.82 : 0.76;
}

// ---- part interpreters ---------------------------------------------------------------
// Each part is { type, ...data }. Common optional fields:
//   layer   adaptive layer index (skipped while that layer is gated off)
//   min/max intensity window          bars: [from, to) section bars
//   when    (T, c) => bool            (variation by pass, etc.)

const PARTS = {
  // a notated melodic line on any instrument
  line(T, p, c) {
    const L = p.line;
    const evs = L.at((c.bar + (p.shift || 0)) % L.bars, c.step);
    if (!evs) return;
    for (const e of evs) T.playNote(p, e, c);
  },

  // generative: every `every` bars maybe pick a phrase from a pool
  phrases(T, p, c) {
    const st = T.stateOf(p);
    const every = p.every || 2;
    if (c.step === 0 && c.bar % every === 0) {
      st.line = null;
      const blocked = p.unless && T.flags[p.unless];
      if (!blocked && T.rng() < (p.prob === undefined ? 0.6 : p.prob)) {
        let i = 0;
        for (let k = 0; k < 4; k++) {
          i = Math.floor(T.rng() * p.pool.length);
          if (i !== st.last) break;
        }
        st.last = i;
        st.line = p.pool[i];
        st.bar0 = c.bar;
      }
      if (p.flag) T.flags[p.flag] = !!st.line;
    }
    if (!st.line) return;
    const b = c.bar - st.bar0;
    if (b < 0 || b >= st.line.bars) return;
    const evs = st.line.at(b, c.step);
    if (evs) for (const e of evs) T.playNote(p, e, c);
  },

  // sustained chords that follow the harmony; re-attacks only on a change
  chords(T, p, c) {
    if (c.step !== 0 && c.step !== 8) return;
    const slot = c.bar * 2 + (c.step >> 3);
    const ch = T.chordAt(slot);
    if (slot > 0 && T.chordAt(slot - 1) === ch) return;
    let n = 1;
    while (slot + n < c.sec.bars * 2 && T.chordAt(slot + n) === ch) n++;
    const dur = n * 8 * c.sd;
    const src = p.voicing === 'high' ? ch.high : ch.pad;
    const inst = T.get(p.inst);
    if (!inst) return;
    for (const m of src) inst.note(c.t, m + c.key, p.vel, dur, p.atk || 0.25, p.rel || 0.3);
    T.E.stats.musicEvents += src.length;
  },

  // chord root on a rhythm (plucked bass)
  bass(T, p, c) {
    const ch = p.pat[c.step];
    if (ch === '.') return;
    const vel = p.vel * (ch === 'X' ? 1 : 0.7) * (0.94 + T.rng() * 0.12);
    const inst = T.get(p.inst);
    if (inst) inst.note(c.t + T.human(0.004), c.chord.root + c.key + (p.oct || 0) * 12, vel, false);
    T.E.stats.musicEvents++;
  },

  // spiccato low strings pulsing on the chord root (two octaves)
  pulse(T, p, c) {
    const ch = p.pat[c.step];
    if (ch === '.') return;
    const vel = p.vel * (ch === 'X' ? 1 : 0.6) * (0.95 + T.rng() * 0.1);
    const inst = T.get(p.inst);
    if (!inst) return;
    const r = c.chord.root + c.key;
    inst.note(c.t, r, vel, c.sd * 0.8, 0.004, 0.045);
    inst.note(c.t, r + 12, vel * 0.8, c.sd * 0.8, 0.004, 0.045);
    T.E.stats.musicEvents += 2;
  },

  // pedal-tone ostinato on plucked strings: root / octave / fifth / colour tone
  ost(T, p, c) {
    const div = p.div || 2;
    if (c.step % div) return;
    const ch = c.chord;
    const r = ch.root + 12 + c.key + (p.oct || 0) * 12;
    const nb = ch.nb + c.key + (p.oct || 0) * 12;
    const k = (c.step / div) % 8;
    const tones = [r, r + 12, r + 7, r + 12, nb, r + 12, r + 7, r + 12];
    const acc = (c.step === 0 || c.step === 6 || c.step === 12) ? 1 : 0.7;
    const inst = T.get(p.inst);
    // sixteenths use the damped pluck so the figure stays crisp
    if (inst) inst.note(c.t + T.human(0.004), tones[k], p.vel * acc * (0.94 + T.rng() * 0.12), div === 1);
    T.E.stats.musicEvents++;
  },

  // generative qanun shimmer: an ascending arpeggio of the current chord
  arp(T, p, c) {
    const st = T.stateOf(p);
    if (c.step === 0 && c.bar % (p.every || 2) === 0) {
      st.on = !(p.unless && T.flags[p.unless]) && T.rng() < (p.prob || 0.25);
    }
    if (!st.on || c.bar % (p.every || 2) !== 0 || c.step % 2) return;
    const v = c.chord.pad;
    const i = c.step / 2;
    const m = v[i % v.length] + 12 * Math.floor(i / v.length) + 12 + c.key;
    const inst = T.get(p.inst);
    if (inst) inst.note(c.t + T.human(0.005), m, p.vel * (0.7 + 0.04 * i), false);
    T.E.stats.musicEvents++;
  },

  // tremolo (rapidly re-plucked notes) with a crescendo across each listed bar
  trem(T, p, c) {
    if (p.in.indexOf(c.bar) < 0) return;
    const inst = T.get(p.inst);
    if (!inst) return;
    const k = p.in.indexOf(c.bar) + c.step / 16;
    const vel = p.vel[0] + (p.vel[1] - p.vel[0]) * (k / p.in.length);
    for (let h = 0; h < 2; h++) {
      const m = midiOf(p.notes[(c.step * 2 + h) % p.notes.length]) + c.key;
      inst.note(c.t + h * c.sd / 2 + T.human(0.004), m, vel * (0.85 + T.rng() * 0.3), true);
    }
    T.E.stats.musicEvents += 2;
  },

  // percussion pattern(s). pat: string | string[] (one per bar, cycled)
  drums(T, p, c) {
    let pat = Array.isArray(p.pat) ? p.pat[c.bar % p.pat.length] : p.pat;
    if (p.fill && c.bar % p.fill.every === p.fill.every - 1) {
      pat = Array.isArray(p.fill.pat) ? p.fill.pat[(c.bar + T.pass) % p.fill.pat.length] : p.fill.pat;
    }
    const ch = pat[c.step];
    if (!ch || ch === '.') return;
    const up = ch.toUpperCase();
    const accent = ch === up;
    const map = DRUM_MAPS[p.map];
    const name = map ? map[up] : p.map;
    if (!name) return;
    let vel = p.vel * (accent ? 1 : 0.45) * (0.9 + T.rng() * 0.2) * T.gateOf(p);
    if (p.cresc) vel *= 0.35 + 0.65 * (c.step / 15);
    if (p.decresc) vel *= 1 - 0.6 * ((c.bar % 2) * 16 + c.step) / 31;
    let rate = 1 + (T.rng() - 0.5) * 0.03;
    if (name === 'timp') rate = Math.pow(2, (c.chord.root - 38 + c.key) / 12);
    const kit = T.get(p.kit || 'kit');
    if (!kit) return;
    const t = c.t + T.human(p.human === undefined ? 0.006 : p.human);
    // ensemble: accents use the two-drum buffer (a lower drum flams in)
    kit.hit(t, p.ens && accent && name === 'taiko' ? 'taiko_ens' : name, vel, rate);
    T.E.stats.musicEvents++;
  },

  shaker(T, p, c) {
    const ch = p.pat[c.step];
    if (ch === '.') return;
    const accent = ch === 'X';
    const kit = T.get(p.kit || 'kit');
    if (kit) kit.shake(c.t + T.human(0.005), p.vel * (accent ? 1 : 0.5) * (0.85 + T.rng() * 0.3) * T.gateOf(p), accent);
  },

  // brass hits on the current chord. pat chars: X short stab, L long, S swell
  stabs(T, p, c) {
    const pat = Array.isArray(p.pat) ? p.pat[c.bar % p.pat.length] : p.pat;
    const ch = pat[c.step];
    if (!ch || ch === '.') return;
    const r = c.chord.root + 12 + c.key + (p.oct || 0) * 12;
    const notes = [r, r + 7, r + 12];
    const inst = T.get(p.inst);
    if (!inst) return;
    const mode = ch === 'L' ? 'sus' : ch === 'S' ? 'swell' : 'stab';
    const dur = (ch === 'X' ? 1.6 : ch === 'L' ? 9 : 14) * c.sd;
    for (const m of notes) inst.note(c.t + T.human(0.003), m, p.vel, dur, mode);
    T.E.stats.musicEvents += 3;
  },

  // held brass chords at fixed points: at = [[bar, step, steps, vel, mode]]
  hold(T, p, c) {
    for (const a of p.at) {
      if (a[0] !== c.bar || a[1] !== c.step) continue;
      const ch = c.chord;
      const notes = p.voicing === 'high' ? ch.high : p.voicing === 'pad' ? ch.pad
        : [ch.root + 12, ch.root + 19, ch.root + 24];
      const inst = T.get(p.inst);
      if (!inst) return;
      for (const m of notes) inst.note(c.t, m + c.key, a[3], a[2] * c.sd, a[4] || 'sus');
      T.E.stats.musicEvents += notes.length;
    }
  },

  // single percussion hits: at = [[bar, step, vel, rate]]
  hits(T, p, c) {
    for (const a of p.at) {
      if (a[0] === c.bar && a[1] === c.step) {
        const kit = T.get(p.kit || 'kit');
        if (kit) kit.hit(c.t, p.name, a[2] * T.gateOf(p), a[3] || 1);
        T.E.stats.musicEvents++;
      }
    }
  },

  // noise swells: at = [[bar, step, steps, peak, tail]]
  swells(T, p, c) {
    for (const a of p.at) {
      if (a[0] === c.bar && a[1] === c.step) {
        const kit = T.get(p.kit || 'kit');
        if (kit) kit.swell(c.t, a[2] * c.sd, a[3] * T.gateOf(p));
      }
    }
  },

  // rapid ascending Hijaz run on a plucked instrument: at = [bar, step]
  gliss(T, p, c) {
    if (p.at[0] !== c.bar || p.at[1] !== c.step) return;
    const scale = [0, 1, 4, 5, 7, 8, 10];
    const n = p.count || 16;
    const span = (p.steps || 8) * c.sd;
    const inst = T.get(p.inst);
    if (!inst) return;
    for (let i = 0; i < n; i++) {
      const m = 62 + c.key + scale[i % 7] + 12 * Math.floor(i / 7);
      inst.note(c.t + (i / n) * span, m, p.vel * (0.55 + 0.45 * i / n), true);
    }
    T.E.stats.musicEvents += n;
  },
};

// ---- arrangements -----------------------------------------------------------------------
// def: { bpm, layers, loopFrom, build(T), form: [section] }
// section: { id, bars, bpm?, chords, parts, enter?(T, t, I), end? }

// The drone is a fixed graph, so it is baked once into a 16 s seamless loop
// and played as a single node. Until that buffer exists (first seconds of a
// session) the live graph plays and is cross-faded out when the loop lands.
const DRONE_SECONDS = 16;
function droneKey(o) { return 'drone:' + (o.air === undefined ? 1 : o.air); }
function droneGraph(o) {
  return (ctx, fe) => { new Drone(fe, { level: 1, air: o.air }).out.connect(ctx.destination); };
}
function mkDrone(T, o) {
  const E = T.E, key = droneKey(o);
  const buf = E.baker.graphs.get(key);
  if (buf) return new DroneLoop(E, { level: o.level, buffer: buf });
  if (!E.offline && E.baker.can()) E.baker.wantGraph(key, DRONE_SECONDS, droneGraph(o), () => T.swapDrone(key, o));
  return new Drone(E, o);
}

function stdKit(T, name, layer, level) {
  T.reg(name, () => new DrumKit(T.E, { level }), layer, 0);
}

// instrument levels, balanced from soloed-stem loudness measurements (lab:
// renderStems) so the lead sits ~3-5 LU above the pad and the percussion
const LVL = {
  drone: 0.11, strings: 0.125, stac: 0.26, oud: 1.25, qanun: 1.4, bass: 0.74,
  ney: 0.2, duduk: 0.3, brass: 0.24, kit: 0.68,
};

const TRACKS = {};

TRACKS.title = {
  bpm: 92,
  loopFrom: 0,
  build(T) {
    T.reg('drone', () => mkDrone(T, { level: LVL.drone }), 0, 0.1);
    T.reg('strings', () => new PadInst(T.E, { level: LVL.strings, wave: 'strings' }), 0, 0.35);
    T.reg('stac', () => new StacInst(T.E, { voices: 2, level: LVL.stac, wave: 'bright' }), 0, 0.2);
    T.reg('oud', () => new PluckInst(T.E, { kind: 'oud', level: LVL.oud, pan: -0.2 }), 0, 0.25);
    T.reg('qanun', () => new PluckInst(T.E, { kind: 'qanun', level: LVL.qanun, pan: 0.3 }), 0, 0.3);
    T.reg('bass', () => new PluckInst(T.E, { kind: 'bass', level: LVL.bass }), 0, 0.08);
    T.reg('ney', () => new BreathLead(T.E, { kind: 'ney', level: LVL.ney, pan: 0.15 }), 0, 0.45);
    T.reg('brass', () => new BrassInst(T.E, { level: LVL.brass }), 0, 0.35);
    stdKit(T, 'kit', 0, LVL.kit);
  },
  form: [
    {
      id: 'intro', bars: 4, chords: ['D5'],
      enter(T, t) { T.setKey(0, t); },
      parts: [
        { type: 'hits', name: 'boom', at: [[0, 0, 0.8]] },
        { type: 'hits', name: 'gong', at: [[0, 0, 0.3]] },
        { type: 'chords', inst: 'strings', vel: 0.3, atk: 0.6 },
        { type: 'line', inst: 'ney', line: INTRO_NEY, vel: 0.8 },
        { type: 'trem', inst: 'qanun', in: [2, 3], notes: ['A4', 'D5'], vel: [0.15, 0.45] },
        { type: 'drums', map: 'frame', pat: [REST, REST, RHYTHM.frameSoft, RHYTHM.frameMaq], vel: 0.5 },
        { type: 'swells', at: [[3, 0, 16, 0.22]] },
      ],
    },
    {
      id: 's1', bars: 8, chords: THEME_CHORDS,
      parts: [
        { type: 'line', inst: 'oud', line: THEME, vel: 0.9 },
        { type: 'line', inst: 'qanun', line: THEME, oct: 1, vel: 0.4, bars: [4, 8] },
        { type: 'chords', inst: 'strings', vel: 0.4 },
        { type: 'bass', inst: 'bass', pat: RHYTHM.bassA, vel: 0.7 },
        { type: 'drums', map: 'frame', pat: RHYTHM.frameMaq, vel: 0.55 },
        { type: 'shaker', pat: RHYTHM.riqOff, vel: 0.35 },
        { type: 'hits', name: 'boom', at: [[0, 0, 0.5]] },
      ],
    },
    {
      id: 's2', bars: 8, chords: THEME_CHORDS,
      parts: [
        { type: 'line', inst: 'brass', line: THEME, vel: 0.8 },
        { type: 'line', inst: 'oud', line: THEME, vel: 0.7 },
        { type: 'chords', inst: 'strings', vel: 0.5 },
        { type: 'pulse', inst: 'stac', pat: RHYTHM.pulse332, vel: 0.55 },
        { type: 'bass', inst: 'bass', pat: RHYTHM.bassDrive, vel: 0.7 },
        { type: 'drums', map: 'darbuka', pat: [RHYTHM.maqsum, RHYTHM.maqsum2], vel: 0.7,
          fill: { every: 4, pat: RHYTHM.fillA } },
        { type: 'drums', map: 'taiko', pat: RHYTHM.taiko1, vel: 0.7 },
        { type: 'shaker', pat: RHYTHM.riq8, vel: 0.4 },
        { type: 'hits', name: 'boom', at: [[0, 0, 0.9]] },
        { type: 'hits', name: 'cym', at: [[0, 0, 0.45]] },
      ],
    },
    {
      id: 'bridge', bars: 4, chords: BRIDGE_CHORDS,
      parts: [
        { type: 'line', inst: 'ney', line: BRIDGE_NEY, vel: 0.85 },
        { type: 'ost', inst: 'qanun', div: 1, vel: 0.45 },
        { type: 'chords', inst: 'strings', vel: 0.42 },
        { type: 'pulse', inst: 'stac', pat: RHYTHM.pulse332, vel: 0.5, bars: [2, 4] },
        { type: 'bass', inst: 'bass', pat: RHYTHM.bassHalf, vel: 0.7 },
        { type: 'drums', map: 'taiko', vel: 0.75,
          pat: ['X.......x.......', 'X.......x.......', RHYTHM.taikoBuild1, RHYTHM.taikoBuild2] },
        { type: 'drums', map: 'snare', pat: [REST, REST, REST, RHYTHM.snareRoll], vel: 0.55, cresc: true },
        { type: 'swells', at: [[2, 0, 32, 0.4]] },
        { type: 'hits', name: 'boom', at: [[0, 0, 0.7]] },
      ],
    },
    {
      id: 's3', bars: 8, chords: THEME_CHORDS,
      enter(T, t) { T.setKey(T.pass % 2 === 1 ? 2 : 0, t); }, // every other pass: up a tone
      parts: [
        { type: 'line', inst: 'brass', line: THEME, vel: 0.95, dbl: 12 },
        { type: 'line', inst: 'qanun', line: THEME, oct: 1, vel: 0.5 },
        { type: 'line', inst: 'strings', line: THEME_COUNTER, vel: 0.5 },
        { type: 'chords', inst: 'strings', vel: 0.45, voicing: 'high' },
        { type: 'pulse', inst: 'stac', pat: RHYTHM.pulse16, vel: 0.5 },
        { type: 'bass', inst: 'bass', pat: RHYTHM.bassDrive, vel: 0.8 },
        { type: 'drums', map: 'darbuka', vel: 0.8, fill: { every: 4, pat: [RHYTHM.fillB, RHYTHM.fillA] },
          pat: [RHYTHM.malfuf, RHYTHM.malfuf, RHYTHM.ayoub, RHYTHM.malfuf] },
        { type: 'drums', map: 'taiko', vel: 0.85, ens: true, fill: { every: 8, pat: RHYTHM.taikoFill },
          pat: [RHYTHM.taiko2, RHYTHM.taiko2, RHYTHM.taiko3, RHYTHM.taiko2] },
        { type: 'drums', map: 'snare', pat: RHYTHM.snareBack, vel: 0.5 },
        { type: 'shaker', pat: RHYTHM.riq16, vel: 0.45 },
        { type: 'hits', name: 'boom', at: [[0, 0, 1], [4, 0, 0.9]] },
        { type: 'hits', name: 'cym', at: [[0, 0, 0.6], [4, 0, 0.4]] },
      ],
    },
    {
      id: 'out', bars: 2, chords: ['D'],
      parts: [
        { type: 'hold', inst: 'brass', at: [[0, 0, 26, 0.75, 'sus']], voicing: 'pad' },
        { type: 'chords', inst: 'strings', vel: 0.5, voicing: 'high' },
        { type: 'drums', map: 'taiko', pat: ['X.x.x.x.x.x.x.x.', 'x.x.x.x.x...X...'], vel: 0.7, decresc: true },
        { type: 'hits', name: 'boom', at: [[0, 0, 0.95]] },
        { type: 'hits', name: 'cym', at: [[0, 0, 0.5]] },
        { type: 'hits', name: 'gong', at: [[0, 0, 0.35]] },
        { type: 'swells', at: [[1, 8, 8, 0.2]] },
      ],
    },
  ],
};

const notThemePass = (T) => T.pass % 4 !== 2;

TRACKS.menu = {
  bpm: 76,
  level: 1.75,
  loopFrom: 0,
  build(T) {
    T.reg('drone', () => mkDrone(T, { level: LVL.drone }), 0, 0.1);
    T.reg('strings', () => new PadInst(T.E, { level: LVL.strings, wave: 'strings' }), 0, 0.4);
    T.reg('oud', () => new PluckInst(T.E, { kind: 'oud', level: LVL.oud, pan: -0.2 }), 0, 0.3);
    T.reg('qanun', () => new PluckInst(T.E, { kind: 'qanun', level: LVL.qanun, pan: 0.3 }), 0, 0.35);
    T.reg('bass', () => new PluckInst(T.E, { kind: 'bass', level: LVL.bass }), 0, 0.08);
    T.reg('ney', () => new BreathLead(T.E, { kind: 'ney', level: LVL.ney, pan: 0.15 }), 0, 0.5);
    stdKit(T, 'kit', 0, LVL.kit);
  },
  form: [
    {
      id: 'cycle', bars: 8, chords: MENU_PROGS[0],
      enter(T) { T.chords = MENU_PROGS[T.pass % MENU_PROGS.length]; },
      parts: [
        { type: 'chords', inst: 'strings', vel: 0.42, atk: 0.5, rel: 0.6 },
        // every fourth cycle the oud states the whole theme
        { type: 'line', inst: 'oud', line: THEME, vel: 0.72, when: (T) => T.pass % 4 === 2 },
        { type: 'phrases', inst: 'oud', pool: MENU_PHRASES, every: 2, prob: 0.58, vel: 0.68,
          flag: 'oud', when: notThemePass },
        { type: 'phrases', inst: 'ney', pool: NEY_PHRASES, every: 2, prob: 0.75, vel: 0.7,
          unless: 'oud', flag: 'ney', when: notThemePass },
        { type: 'arp', inst: 'qanun', every: 2, prob: 0.3, vel: 0.35, unless: 'ney' },
        { type: 'bass', inst: 'bass', pat: RHYTHM.boom1, vel: 0.5 },
        { type: 'drums', map: 'frame', pat: RHYTHM.frameSoft, vel: 0.4, when: (T) => T.pass % 3 !== 0 },
        { type: 'shaker', pat: RHYTHM.riqOff, vel: 0.2, when: (T) => T.pass % 3 === 2 },
        { type: 'hits', name: 'gong', at: [[0, 0, 0.2]], when: (T) => T.pass % 4 === 0 },
      ],
    },
  ],
};

function briefParts(b) {
  const parts = [
    { type: 'chords', inst: 'strings', vel: 0.32 },
    { type: 'pulse', inst: 'stac', pat: RHYTHM.pulse332, vel: 0.6 },
    { type: 'drums', map: 'tick', pat: [RHYTHM.tick8, RHYTHM.tick8, RHYTHM.tick8, RHYTHM.tick16], vel: 0.5, human: 0.002 },
    { type: 'drums', map: 'timp', vel: 0.6,
      pat: [RHYTHM.timpA, REST, REST, REST, RHYTHM.timpA, REST, REST, RHYTHM.timpEnd] },
    { type: 'trem', inst: 'qanun', in: [2], notes: ['Eb4', 'G4'], vel: [0.2, 0.5] },
    { type: 'trem', inst: 'qanun', in: [6], notes: ['Eb4', 'G4'], vel: [0.2, 0.5] },
    { type: 'bass', inst: 'bass', pat: RHYTHM.bassHalf, vel: 0.5 },
    { type: 'hits', name: 'boom', at: [[0, 0, 0.5]] },
  ];
  if (b) {
    parts.push(
      { type: 'line', inst: 'oud', line: BRIEF_LINE, vel: 0.78 },
      { type: 'drums', map: 'darbuka', pat: RHYTHM.ticks, vel: 0.5 },
      { type: 'shaker', pat: RHYTHM.riqOff, vel: 0.25 },
      { type: 'hold', inst: 'brass', at: [[6, 0, 30, 0.5, 'swell']] },
      { type: 'swells', at: [[7, 0, 16, 0.2]] },
    );
  }
  return parts;
}

TRACKS.briefing = {
  bpm: 100,
  level: 1.4,
  loopFrom: 0,
  build(T) {
    T.reg('drone', () => mkDrone(T, { level: LVL.drone }), 0, 0.1);
    T.reg('strings', () => new PadInst(T.E, { level: LVL.strings, wave: 'strings' }), 0, 0.35);
    T.reg('stac', () => new StacInst(T.E, { voices: 2, level: LVL.stac, wave: 'bright' }), 0, 0.2);
    T.reg('oud', () => new PluckInst(T.E, { kind: 'oud', level: LVL.oud, pan: -0.2 }), 0, 0.25);
    T.reg('qanun', () => new PluckInst(T.E, { kind: 'qanun', level: LVL.qanun, pan: 0.3 }), 0, 0.3);
    T.reg('bass', () => new PluckInst(T.E, { kind: 'bass', level: LVL.bass }), 0, 0.08);
    T.reg('brass', () => new BrassInst(T.E, { level: LVL.brass }), 0, 0.35);
    stdKit(T, 'kit', 0, LVL.kit);
  },
  form: [
    { id: 'a', bars: 8, chords: BRIEF_A, parts: briefParts(false) },
    { id: 'b', bars: 8, chords: BRIEF_B, parts: briefParts(true) },
  ],
};

// In-match adaptive piece. Layers: 0 drone + sparse plucks, 1 ostinato + hand
// percussion, 2 low strings + taikos, 3 brass + full kit.
function combatParts(kind) {
  const dar = kind === 'b' ? [RHYTHM.baladi, RHYTHM.saidi]
    : kind === 'c' ? [RHYTHM.malfuf, RHYTHM.ayoub] : [RHYTHM.maqsum, RHYTHM.maqsum2];
  const tai = kind === 'a' ? RHYTHM.taiko1 : kind === 'b' ? RHYTHM.taiko2
    : [RHYTHM.taiko2, RHYTHM.taiko3];
  const parts = [
    // layer 0
    { type: 'phrases', inst: 'oud', pool: COMBAT_PHRASES, every: 2, prob: 0.75, vel: 0.9,
      layer: 0, max: 0.45, flag: 'oud' },
    { type: 'hits', name: 'boom', at: [[0, 0, 0.35]], layer: 0, max: 0.3 },
    // layer 1
    { type: 'ost', inst: 'qanun', div: 2, vel: 0.62, layer: 1, max: 0.62 },
    { type: 'ost', inst: 'qanun', div: 1, vel: 0.52, layer: 1, min: 0.62 },
    { type: 'drums', map: 'darbuka', pat: dar, vel: 0.8, layer: 1,
      fill: { every: 4, pat: [RHYTHM.fillA, RHYTHM.fillB] } },
    { type: 'shaker', pat: RHYTHM.riqOff, vel: 0.4, layer: 1, max: 0.5 },
    { type: 'shaker', pat: RHYTHM.riq8, vel: 0.4, layer: 1, min: 0.5, max: 0.8 },
    { type: 'shaker', pat: RHYTHM.riq16, vel: 0.42, layer: 1, min: 0.8 },
    // layer 2
    { type: 'pulse', inst: 'stac', pat: RHYTHM.pulse332, vel: 0.52, layer: 2, max: 0.8 },
    { type: 'pulse', inst: 'stac', pat: RHYTHM.pulse16, vel: 0.5, layer: 2, min: 0.8 },
    { type: 'chords', inst: 'strings', vel: 0.42, layer: 2 },
    { type: 'bass', inst: 'bass', pat: RHYTHM.bassA, vel: 0.68, layer: 2, max: 0.75 },
    { type: 'bass', inst: 'bass', pat: RHYTHM.bassDrive, vel: 0.68, layer: 2, min: 0.75 },
    { type: 'drums', map: 'taiko', pat: tai, vel: 0.8, ens: true, layer: 2,
      fill: { every: 8, pat: RHYTHM.taikoFill }, human: 0.003 },
    // layer 3
    { type: 'drums', map: 'snare', vel: 0.5, layer: 3,
      pat: [RHYTHM.snareBack, RHYTHM.snareBack, RHYTHM.snareBack, RHYTHM.snareMarch],
      fill: { every: 8, pat: RHYTHM.snareRoll } },
    { type: 'hits', name: 'boom', at: [[0, 0, 0.9]], layer: 3 },
    { type: 'hits', name: 'cym', at: [[0, 0, 0.5]], layer: 3 },
    { type: 'swells', at: [[7, 0, 16, 0.3]], layer: 3 },
  ];
  if (kind === 'b') {
    parts.push(
      { type: 'line', inst: 'brass', line: COMBAT_B_BRASS, vel: 0.75, mode: 'swell', dbl: 12, layer: 3 },
      { type: 'phrases', inst: 'ney', pool: COMBAT_NEY, every: 4, prob: 0.6, vel: 0.65,
        layer: 0, max: 0.4, unless: 'oud' },
    );
  } else if (kind === 'c') {
    parts.push(
      // the main theme: brass at full intensity, oud while the fight is building
      { type: 'line', inst: 'brass', line: THEME, vel: 0.95, dbl: 12, layer: 3 },
      { type: 'line', inst: 'oud', line: THEME, vel: 0.75, layer: 0, min: 0.25, max: 0.76 },
    );
  } else {
    parts.push({ type: 'stabs', inst: 'brass', pat: [RHYTHM.stab1, RHYTHM.stab2], vel: 0.8, layer: 3 });
  }
  return parts;
}

TRACKS.combat = {
  bpm: 108,
  layers: 4,
  loopFrom: 0,
  build(T) {
    T.reg('drone', () => mkDrone(T, { level: LVL.drone * 1.25 }), 0, 0.1);
    T.reg('oud', () => new PluckInst(T.E, { kind: 'oud', level: LVL.oud, pan: -0.2 }), 0, 0.28);
    T.reg('ney', () => new BreathLead(T.E, { kind: 'ney', level: LVL.ney, pan: 0.15 }), 0, 0.5);
    stdKit(T, 'kit', 0, LVL.kit);
    T.reg('qanun', () => new PluckInst(T.E, { kind: 'qanun', level: LVL.qanun, pan: 0.3 }), 1, 0.25);
    T.reg('stac', () => new StacInst(T.E, { voices: 2, level: LVL.stac, wave: 'bright' }), 2, 0.2);
    T.reg('strings', () => new PadInst(T.E, { level: LVL.strings, wave: 'strings' }), 2, 0.35);
    T.reg('bass', () => new PluckInst(T.E, { kind: 'bass', level: LVL.bass }), 2, 0.08);
    T.reg('brass', () => new BrassInst(T.E, { level: LVL.brass }), 3, 0.35);
  },
  form: [
    { id: 'a', bars: 8, chords: COMBAT_A, parts: combatParts('a'), enter(T, t) { T.setKey(0, t); } },
    { id: 'a2', bars: 8, chords: COMBAT_A2, parts: combatParts('a') },
    { id: 'b', bars: 8, chords: COMBAT_B, parts: combatParts('b') },
    { id: 'a3', bars: 8, chords: COMBAT_A3, parts: combatParts('a') },
    {
      id: 'c', bars: 8, chords: THEME_CHORDS, parts: combatParts('c'),
      // at full tilt every other pass lifts the theme a tone
      enter(T, t, I) { T.setKey(T.pass % 2 === 1 && I > 0.7 ? 2 : 0, t); },
    },
  ],
};

TRACKS.victory = {
  bpm: 96,
  loopFrom: 1,
  build(T) {
    T.reg('drone', () => mkDrone(T, { level: LVL.drone }), 0, 0.1);
    T.reg('strings', () => new PadInst(T.E, { level: LVL.strings, wave: 'strings' }), 0, 0.4);
    T.reg('brass', () => new BrassInst(T.E, { level: LVL.brass }), 0, 0.4);
    T.reg('oud', () => new PluckInst(T.E, { kind: 'oud', level: LVL.oud, pan: -0.2 }), 0, 0.3);
    T.reg('qanun', () => new PluckInst(T.E, { kind: 'qanun', level: LVL.qanun, pan: 0.3 }), 0, 0.3);
    T.reg('bass', () => new PluckInst(T.E, { kind: 'bass', level: LVL.bass }), 0, 0.08);
    T.reg('ney', () => new BreathLead(T.E, { kind: 'ney', level: LVL.ney, pan: 0.15 }), 0, 0.5);
    stdKit(T, 'kit', 0, LVL.kit);
  },
  form: [
    {
      id: 'fanfare', bars: 10, chords: FANFARE_CHORDS,
      parts: [
        { type: 'hits', name: 'boom', at: [[0, 0, 1], [4, 0, 0.8], [7, 0, 1]] },
        { type: 'hits', name: 'cym', at: [[0, 0, 0.6], [7, 0, 0.7]] },
        { type: 'hits', name: 'gong', at: [[7, 0, 0.4]] },
        { type: 'line', inst: 'brass', line: FANFARE, vel: 0.95, dbl: 12, bars: [0, 7] },
        { type: 'hold', inst: 'brass', at: [[7, 0, 40, 0.85, 'sus']], voicing: 'high' },
        { type: 'hold', inst: 'brass', at: [[7, 0, 40, 0.7, 'sus']] },
        { type: 'line', inst: 'qanun', line: FANFARE, oct: 1, vel: 0.45, bars: [0, 7] },
        { type: 'chords', inst: 'strings', vel: 0.5 },
        { type: 'chords', inst: 'strings', vel: 0.36, voicing: 'high', bars: [7, 10] },
        { type: 'bass', inst: 'bass', pat: RHYTHM.bassDrive, vel: 0.8, bars: [0, 7] },
        { type: 'bass', inst: 'bass', pat: RHYTHM.boom1, vel: 0.9, bars: [7, 10] },
        { type: 'drums', map: 'taiko', pat: RHYTHM.taiko2, vel: 0.85, ens: true, bars: [0, 7] },
        { type: 'drums', map: 'taiko', vel: 0.9, ens: true, bars: [7, 10],
          pat: [REST, REST, REST, REST, REST, REST, REST, 'X.......x.x.x.x.', 'X.......x.......', 'X...............'] },
        { type: 'drums', map: 'snare', vel: 0.5, bars: [0, 7],
          pat: [RHYTHM.snareMarch, RHYTHM.snareBack, RHYTHM.snareMarch, RHYTHM.snareBack,
            RHYTHM.snareMarch, RHYTHM.snareBack, RHYTHM.snareRoll] },
        { type: 'drums', map: 'timp', pat: 'XxxxxxxxxxxxxxxX', vel: 0.45, bars: [7, 9], decresc: true },
        { type: 'shaker', pat: RHYTHM.riq16, vel: 0.4, bars: [0, 7] },
        { type: 'gliss', inst: 'qanun', at: [6, 8], count: 18, steps: 8, vel: 0.5 },
        { type: 'swells', at: [[6, 0, 16, 0.35, 0.3]] },
      ],
    },
    {
      id: 'calm', bars: 8, bpm: 78, chords: CALM_CHORDS,
      parts: [
        { type: 'chords', inst: 'strings', vel: 0.36, atk: 0.5, rel: 0.6 },
        { type: 'phrases', inst: 'oud', pool: THEME_PARTS, every: 2, prob: 0.7, vel: 0.6, flag: 'oud' },
        { type: 'phrases', inst: 'ney', pool: NEY_PHRASES, every: 2, prob: 0.5, vel: 0.6, unless: 'oud' },
        { type: 'bass', inst: 'bass', pat: RHYTHM.boom1, vel: 0.45 },
      ],
    },
  ],
};

TRACKS.defeat = {
  bpm: 60,
  build(T) {
    T.reg('drone', () => mkDrone(T, { level: LVL.drone, air: 0.6 }), 0, 0.1);
    T.reg('strings', () => new PadInst(T.E, { level: LVL.strings, wave: 'dark' }), 0, 0.45);
    T.reg('duduk', () => new BreathLead(T.E, { kind: 'duduk', level: LVL.duduk }), 0, 0.5);
    stdKit(T, 'kit', 0, LVL.kit);
  },
  form: [
    {
      id: 'lament', bars: 6, chords: LAMENT_CHORDS, end: true,
      enter(T, t) {
        // after the four-bar lament the track sinks into the drone and out
        const bar = 4 * (60 / 60);
        T.fade(t + 4 * bar - 0.5, 2.6);
      },
      parts: [
        { type: 'hits', name: 'gong', at: [[0, 0, 0.4]] },
        { type: 'hits', name: 'boom', at: [[0, 0, 0.45]] },
        { type: 'line', inst: 'duduk', line: LAMENT, vel: 0.85, bars: [0, 4] },
        { type: 'chords', inst: 'strings', vel: 0.38, atk: 0.6, rel: 1.0 },
        { type: 'drums', map: 'frame', vel: 0.5, bars: [0, 4],
          pat: ['D.......D.......', 'D...............', 'D...............', REST] },
      ],
    },
  ],
};

// ---- one playing track ---------------------------------------------------------------------

class TrackPlayer {
  constructor(dir, id, t0, opts) {
    const E = dir.E;
    const o = opts || {};
    this.dir = dir;
    this.E = E;
    this.ctx = E.ctx;
    this.id = id;
    this.def = TRACKS[id];
    this.rng = dir.rng;
    this.inst = {};
    this.states = new Map();
    this.flags = {};
    this.done = false;
    this.key = 0;
    this.pass = 0;
    this.secIdx = 0;
    this.bar = 0;
    this.step = 0;
    this.absBar = 0;
    this.next = t0;
    this.t0 = t0;
    this.c = {};
    const ctx = this.ctx;
    // three nodes per track: the fader, a post-fader hall send for the whole
    // band, and an extra send for the instruments that live deeper in the hall
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(E.bus.music);
    const send = ctx.createGain();
    send.gain.value = HALL_SEND;
    this.gain.connect(send);
    send.connect(E.bus.hallSend);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.wet.connect(E.bus.hallSend);
    // adaptive layers are plain numbers: each instrument's output gain is
    // level x its layer's gate
    this.lg = [1, 0, 0, 0];
    this.adaptive = (this.def.layers || 1) > 1;
    E.count(3);
    this.regs = {};
    this.solo = o.solo || null;   // lab: mute everything else (stems)
    this.only = o.only || null;   // lab: build nothing else (cost ablation)
    this.sweptAt = 0;
    this.def.build(this);
    this.c.t = t0;
    if (this.regs.drone) this.get('drone'); // the bed is there from the first bar
    this.chords = this.def.form[0].chords;
    // start part-way in (lab / harness): fast-forward the counters
    let skip = (o.startBar || 0) * 16;
    while (skip-- > 0) this.advancePos(true);
    const lvl = (o.level === undefined ? 1 : o.level) * (this.def.level || 1);
    this.gain.gain.setTargetAtTime(lvl, t0 - 0.05, 0.08);
    this.wet.gain.setTargetAtTime(lvl * HALL_EXTRA, t0 - 0.05, 0.08);
  }

  // Instruments are registered as factories and only built when a part first
  // needs them; one that has not played for IDLE seconds is torn down again,
  // so quiet stretches (most of a match) cost almost nothing.
  // send >= 0.3 marks an instrument that also feeds the extra hall send
  reg(name, make, layer, send) {
    this.regs[name] = { make, layer: layer || 0, wet: send >= 0.3, inst: null, last: 0 };
  }

  get(name) {
    const r = this.regs[name];
    if (!r || (this.only && this.only.indexOf(name) < 0)) return null;
    if (!r.inst) {
      const inst = r.make();
      if (this.solo && this.solo.indexOf(name) < 0) inst.level = 0;
      const g = this.adaptive ? this.lg[r.layer] : 1;
      inst.gateV = g;
      inst.out.gain.value = inst.level * g;
      inst.out.connect(this.gain);
      if (r.wet) inst.out.connect(this.wet);
      if (inst.wide) inst.wide.connect(this.wet); // big drums
      r.inst = inst;
      this.inst[name] = inst;
    }
    r.last = this.c.t;
    return r.inst;
  }

  // the baked drone loop has arrived: cross-fade it in over the live graph
  swapDrone(key, o) {
    const r = this.regs.drone;
    const buf = this.E.baker.graphs.get(key);
    if (this.dead || !r || !r.inst || !buf || r.inst instanceof DroneLoop) return;
    const now = this.ctx.currentTime;
    const old = r.inst;
    const neu = new DroneLoop(this.E, { level: old.level, buffer: buf });
    neu.tune(now, 38 + this.key, 0.01);
    neu.out.gain.value = 0;
    neu.out.gain.setTargetAtTime(old.level * old.gateV, now, 0.5);
    neu.gateV = old.gateV;
    neu.out.connect(this.gain);
    if (r.wet) neu.out.connect(this.wet);
    old.out.gain.cancelScheduledValues(now);
    old.out.gain.setTargetAtTime(0, now, 0.5);
    this.E.after(now + 4, () => { try { old.dispose(); } catch (e) { /* ok */ } });
    r.inst = neu;
    this.inst.drone = neu;
  }

  // velocity scale for parts that share one instrument across layers (the kit)
  gateOf(p) {
    return (this.adaptive && p.layer !== undefined) ? this.lg[p.layer] : 1;
  }

  sweep(now) {
    if (now - this.sweptAt < 1) return;
    this.sweptAt = now;
    for (const k in this.regs) {
      const r = this.regs[k];
      if (!r.inst || k === 'drone' || now - r.last < IDLE) continue;
      try { r.inst.dispose(); } catch (e) { /* ok */ }
      r.inst = null;
      delete this.inst[k];
    }
  }

  stateOf(p) {
    let s = this.states.get(p);
    if (!s) { s = {}; this.states.set(p, s); }
    return s;
  }

  human(spread) {
    return spread ? this.rng() * spread : 0;
  }

  chordAt(slot) {
    const ch = this.chords;
    return CHORDS[ch[slot % ch.length]] || CHORDS.D;
  }

  setKey(k, t) {
    if (k === this.key) return;
    this.key = k;
    if (this.inst.drone) this.inst.drone.tune(t, 38 + k, 0.35);
  }

  stepDur() {
    const sec = this.def.form[this.secIdx];
    return 60 / (sec.bpm || this.def.bpm) / 4;
  }

  advancePos(silent) {
    const form = this.def.form;
    if (!silent) this.next += this.stepDur();
    this.step++;
    if (this.step < 16) return;
    this.step = 0;
    this.bar++;
    this.absBar++;
    if (this.bar < form[this.secIdx].bars) return;
    this.bar = 0;
    if (form[this.secIdx].end) { this.done = true; return; }
    this.secIdx++;
    if (this.secIdx >= form.length) {
      this.secIdx = this.def.loopFrom || 0;
      this.pass++;
    }
  }

  gates(I, now) {
    if (!this.adaptive) return;
    const lg = this.lg;
    lg[1] = sstep(0.15, 0.32, I); lg[2] = sstep(0.42, 0.58, I); lg[3] = sstep(0.68, 0.84, I);
    for (const k in this.regs) {
      const r = this.regs[k];
      if (r.inst) r.inst.gate(lg[r.layer], now);
    }
  }

  run(until, I) {
    const now = this.ctx.currentTime;
    let guard = 0;
    while (!this.done && this.next < until && guard++ < 512) {
      // a step that is already in the past (timer was throttled) is skipped,
      // never bunched up: the grid stays put
      if (this.next >= now + 0.004) this.doStep(this.next, I);
      this.advancePos(false);
    }
  }

  doStep(t, I) {
    const sec = this.def.form[this.secIdx];
    if (this.bar === 0 && this.step === 0) {
      this.chords = sec.chords;
      if (sec.enter) sec.enter(this, t, I);
    }
    const c = this.c;
    c.t = t; c.sd = this.stepDur(); c.bar = this.bar; c.step = this.step; c.sec = sec;
    c.I = I; c.key = this.key; c.absBar = this.absBar;
    c.chord = this.chordAt(this.bar * 2 + (this.step >> 3));
    const parts = sec.parts;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.layer !== undefined && this.adaptive && this.lg[p.layer] < 0.02) continue;
      if (p.min !== undefined && I < p.min) continue;
      if (p.max !== undefined && I >= p.max) continue;
      if (p.bars && (c.bar < p.bars[0] || c.bar >= p.bars[1])) continue;
      if (p.when && !p.when(this, c)) continue;
      try { PARTS[p.type](this, p, c); } catch (e) { /* one bad part never stops the band */ }
    }
  }

  playNote(p, e, c) {
    const inst = this.get(p.inst);
    if (!inst) return;
    const rng = this.rng;
    const midi = e.m + (p.oct || 0) * 12 + c.key;
    const dur = e.d * c.sd;
    const vel = (p.vel || 0.7) * (e.acc ? 1.1 : 1) * accentOf(c.step) * (0.95 + rng() * 0.1);
    this.E.stats.musicEvents++;
    if (inst instanceof PluckInst) {
      const t = c.t + this.human(0.006);
      if (e.trem && e.d >= 2) {
        const n = e.d * 2;
        for (let i = 0; i < n; i++) inst.note(t + i * c.sd / 2, midi, vel * (0.6 + 0.4 * i / n), true);
      } else {
        inst.note(t, midi, vel, e.stac);
      }
      if (p.dbl) inst.note(t + 0.006, midi + p.dbl, vel * 0.6, e.stac);
    } else if (inst instanceof BreathLead) {
      const grace = e.grace ? 150 : (!e.slur && e.d >= 4 && rng() < 0.3 ? 100 : 0);
      inst.note(c.t + 0.004, midi, vel, dur * (e.stac ? 0.5 : 0.96), { slur: e.slur, grace });
    } else if (inst instanceof BrassInst) {
      const mode = p.mode || (e.d >= 5 ? 'sus' : 'stab');
      const t = c.t + this.human(0.004);
      const len = dur * (mode === 'stab' ? 0.74 : 0.94);
      inst.note(t, midi, vel, len, mode);
      if (p.dbl) inst.note(t, midi + p.dbl, vel * 0.62, len, mode);
    } else if (inst instanceof PadInst || inst instanceof StacInst) {
      inst.note(c.t, midi, vel, dur * 0.98, p.atk || 0.07, p.rel || 0.14);
    }
  }

  fade(t, tau) {
    try {
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setTargetAtTime(0, t, tau);
      this.wet.gain.cancelScheduledValues(t);
      this.wet.gain.setTargetAtTime(0, t, tau);
    } catch (e) { /* ok */ }
    this.E.after(t + tau * 6 + 0.3, () => this.dispose());
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    this.done = true;
    for (const k in this.inst) { try { this.inst[k].dispose(); } catch (e) { /* ok */ } }
    try { this.gain.disconnect(); this.wet.disconnect(); } catch (e) { /* ok */ }
  }
}

// ---- stingers -------------------------------------------------------------------------------
// [time s, kind, ...]: drum name vel [rate] | brass [notes] dur vel mode |
// pluck inst note vel | swell dur peak | trem inst [notes] dur vel
const STINGERS = {
  // the head motif as a call to arms: D - A - D'
  match_start: { len: 3.4, duck: 4, ev: [
    [0, 'drum', 'boom', 0.9], [0, 'drum', 'taiko', 0.8],
    [0, 'brass', ['D3', 'D4'], 0.42, 0.75, 'sus'],
    [0.5, 'drum', 'taiko', 0.7], [0.5, 'brass', ['A3', 'A4'], 0.42, 0.8, 'sus'],
    [0.62, 'gliss', 'qanun', 0.36, 0.4],
    [1.0, 'drum', 'taiko', 1], [1.0, 'drum', 'cym', 0.5], [1.0, 'drum', 'boom', 0.6],
    [1.0, 'brass', ['D3', 'A3', 'D4', 'F#4', 'D5'], 1.7, 0.85, 'sus'],
  ] },
  // bII -> I, twice as urgent
  under_attack: { len: 1.5, duck: 3, ev: [
    [0, 'drum', 'taiko', 0.9], [0, 'drum', 'snare', 0.6],
    [0, 'brass', ['Eb3', 'Eb4'], 0.16, 0.85, 'stab'],
    [0.22, 'drum', 'taiko', 1], [0.22, 'brass', ['D3', 'A3', 'D4'], 0.6, 0.9, 'sus'],
  ] },
  superweapon_ready: { len: 3.6, duck: 4, ev: [
    [0, 'drum', 'gong', 0.6], [0, 'drum', 'boom', 0.7],
    [0, 'brass', ['D2', 'A2', 'D3'], 1.55, 0.7, 'swell'],
    [0, 'trem', 'qanun', ['Eb5', 'D5'], 1.6, 0.4],
    [1.6, 'drum', 'taiko', 0.9], [1.6, 'brass', ['Eb3', 'G3', 'Bb3'], 0.22, 0.85, 'stab'],
    [1.9, 'drum', 'taiko', 1], [1.9, 'drum', 'cym', 0.4],
    [1.9, 'brass', ['D3', 'A3', 'D4', 'F#4'], 1.3, 0.85, 'sus'],
  ] },
  superweapon_launch: { len: 4.4, duck: 6, ev: [
    [0, 'swell', 1.4, 0.5], [0, 'brass', ['D2', 'D3'], 1.35, 0.6, 'swell'],
    [0.4, 'roll', 'snare', 1.0, 0.6],
    [1.4, 'drum', 'boom', 1], [1.4, 'drum', 'taiko', 1], [1.4, 'drum', 'cym', 0.7], [1.4, 'drum', 'gong', 0.5],
    [1.4, 'brass', ['D2', 'A2', 'D3'], 2.4, 0.9, 'sus'], [1.4, 'brass', ['A4', 'D5'], 1.7, 0.8, 'sus'],
    [1.9, 'drum', 'taiko', 0.7], [2.4, 'drum', 'taiko', 0.5],
  ] },
  // a sigh: bII -> I on the low oud
  unit_lost: { len: 1.4, duck: 0, ev: [
    [0, 'pluck', 'oud', 'Eb3', 0.4], [0, 'drum', 'frame', 0.22],
    [0.28, 'pluck', 'oud', 'D3', 0.46], [0.28, 'pluck', 'bass', 'D2', 0.38],
  ] },
  objective: { len: 1.8, duck: 2, ev: [
    [0, 'pluck', 'bass', 'D2', 0.6], [0, 'drum', 'riq', 0.5],
    [0, 'pluck', 'qanun', 'D4', 0.5], [0.07, 'pluck', 'qanun', 'A4', 0.55],
    [0.14, 'pluck', 'qanun', 'D5', 0.6], [0.21, 'pluck', 'qanun', 'F#5', 0.65],
    [0.28, 'pluck', 'qanun', 'A5', 0.7], [0.36, 'pluck', 'qanun', 'D6', 0.8],
    [0.36, 'pluck', 'oud', 'D4', 0.6],
  ] },
  countdown: { len: 0.9, duck: 0, ev: [
    [0, 'drum', 'timp', 0.6], [0, 'drum', 'tick', 0.7], [0, 'pluck', 'qanun', 'D5', 0.5],
  ] },
};

class StingerRig {
  constructor(dir) {
    const E = dir.E, ctx = E.ctx;
    this.E = E;
    this.out = ctx.createGain();
    this.out.connect(E.bus.stinger);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.4;
    this.out.connect(this.wet);
    this.wet.connect(E.bus.hallSend);
    this.inst = {};
    this.until = 0;
  }

  get(name) {
    let i = this.inst[name];
    if (i) return i;
    const E = this.E;
    if (name === 'brass') i = new BrassInst(E, { level: LVL.brass });
    else if (name === 'kit') i = new DrumKit(E, { level: LVL.kit });
    else i = new PluckInst(E, { kind: name, level: LVL[name] });
    i.out.connect(this.out);
    this.inst[name] = i;
    return i;
  }

  dispose() {
    for (const k in this.inst) { try { this.inst[k].dispose(); } catch (e) { /* ok */ } }
    try { this.out.disconnect(); this.wet.disconnect(); } catch (e) { /* ok */ }
  }
}

// ---- director -------------------------------------------------------------------------------

export class MusicDirector {
  constructor(E, o) {
    this.E = E;
    this.rng = (o && o.seed !== undefined) ? makeRng(o.seed) : Math.random;
    this.cur = null;
    this.name = null;
    this.target = 0;
    this.value = 0;
    this.floor = 0;
    this.lastT = -1;
    this.heldAt = -1;  // context time of the last moment the target was >= the value
    this.rig = null;
  }

  // name: 'title' | 'menu' | 'briefing' | 'ambient' | 'battle' | 'victory' |
  // 'defeat' | null. opts (lab only): { startBar, solo, level }
  play(name, opts) {
    const E = this.E;
    const now = E.ctx.currentTime;
    const id = TRACK_OF[name] || null;
    if (!id) name = null;
    if (name === this.name) return;
    this.name = name;
    this.floor = FLOOR[name] || 0;
    if (!id) { this.drop(now, 0.4); return; }
    // ambient <-> battle: the same piece keeps playing, only the floor moved
    if (this.cur && this.cur.id === id && !this.cur.done) return;
    E.needHall();
    this.drop(now, 0.55);
    this.cur = new TrackPlayer(this, id, now + 0.12, opts);
    this.cur.gates(Math.max(this.value, this.floor), now);
  }

  drop(t, tau) {
    const T = this.cur;
    this.cur = null;
    if (!T || T.dead) return;
    T.done = true;
    T.fade(t, tau);
  }

  halt(tau) {
    this.name = null;
    this.drop(this.E.ctx.currentTime, tau || 0.3);
    if (this.rig) { this.rig.dispose(); this.rig = null; }
  }

  intensity(x) {
    this.target = clamp01(Number(x) || 0);
  }

  // jump straight to an intensity (lab / offline renders)
  snap(x) {
    this.target = clamp01(Number(x) || 0);
    this.value = Math.max(this.target, this.floor);
    this.heldAt = -10;
  }

  advance(now) {
    const dt = this.lastT < 0 ? 0 : Math.max(0, now - this.lastT);
    this.lastT = now;
    const tgt = Math.max(this.target, this.floor);
    // attack ~1 s (tau 0.33 s); release ~6 s: the band holds for 1.2 s after
    // the heat drops, then winds down with tau 1.6 s
    if (tgt >= this.value) {
      this.heldAt = now;
      this.value += (tgt - this.value) * (1 - Math.exp(-dt / 0.33));
    } else if (now - this.heldAt > 1.2) {
      this.value += (tgt - this.value) * (1 - Math.exp(-dt / 1.6));
    }
    const T = this.cur;
    if (T && !T.done) {
      T.gates(this.value, now);
      T.sweep(now);
      const hidden = typeof document !== 'undefined' && document.hidden && !this.E.offline;
      T.run(now + (hidden ? 1.3 : this.E.lookahead), this.value);
      if (T.done && !T.dead) this.E.after(now + 20, () => T.dispose());
    }
    if (this.rig && now > this.rig.until) { this.rig.dispose(); this.rig = null; }
  }

  // one-shot musical cue layered over whatever is playing
  stinger(name, when) {
    const S = STINGERS[name];
    if (!S) return false;
    const E = this.E;
    const now = E.ctx.currentTime;
    const t0 = Math.max(when === undefined ? now + 0.03 : when, now + 0.01);
    E.needHall();
    if (!this.rig) this.rig = new StingerRig(this);
    const rig = this.rig;
    rig.until = Math.max(rig.until, t0 + S.len + 4);
    if (S.duck) E.duck(S.duck, S.len * 0.7, 0.9, t0);
    for (const e of S.ev) {
      const t = t0 + e[0];
      switch (e[1]) {
        case 'drum':
          rig.get('kit').hit(t, e[2], e[3], e[4] || 1);
          break;
        case 'brass':
          for (const n of e[2]) rig.get('brass').note(t, midiOf(n), e[4], e[3], e[5]);
          break;
        case 'pluck':
          rig.get(e[2]).note(t, midiOf(e[3]), e[4], false);
          break;
        case 'swell':
          rig.get('kit').swell(t, e[2], e[3]);
          break;
        case 'roll': {
          const n = Math.floor(e[3] / 0.07);
          for (let i = 0; i < n; i++) {
            rig.get('kit').hit(t + i * 0.07, e[2], e[4] * (0.35 + 0.65 * i / n), 1);
          }
          break;
        }
        case 'trem': {
          const n = Math.floor(e[4] / 0.075);
          for (let i = 0; i < n; i++) {
            rig.get(e[2]).note(t + i * 0.075, midiOf(e[3][i % e[3].length]), e[5] * (0.4 + 0.6 * i / n), true);
          }
          break;
        }
        case 'gliss': {
          const scale = [0, 1, 4, 5, 7, 8, 10];
          for (let i = 0; i < 14; i++) {
            rig.get(e[2]).note(t + (i / 14) * e[3], 62 + scale[i % 7] + 12 * Math.floor(i / 7),
              e[4] * (0.5 + 0.5 * i / 14), true);
          }
          break;
        }
        default:
          break;
      }
    }
    return true;
  }

  // harness / loading screens: bake the drone loops up front
  async prebake() {
    for (const o of [{}, { air: 0.6 }]) await this.E.baker.bakeGraph(droneKey(o), DRONE_SECONDS, droneGraph(o));
  }

  // facts for the lab / harness: tempo, form and loop length of a track
  describe(name) {
    const def = TRACKS[TRACK_OF[name]];
    if (!def) return null;
    let t = 0, loopStart = 0, bars = 0;
    const sections = def.form.map((s, i) => {
      if (i === (def.loopFrom || 0)) loopStart = t;
      const barDur = 4 * 60 / (s.bpm || def.bpm);
      const r = { id: s.id, bars: s.bars, bpm: s.bpm || def.bpm, start: t };
      t += s.bars * barDur;
      bars += s.bars;
      return r;
    });
    const last = def.form[def.form.length - 1];
    return { bpm: def.bpm, bars, sections, loops: !last.end, loopStart, loopEnd: t, layers: def.layers || 1 };
  }
}
