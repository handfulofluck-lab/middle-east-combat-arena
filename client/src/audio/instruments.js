// Synthesised instruments for the score.
//
// Design rule (measured, see the audio lab): in the browser every live node
// costs roughly the same per render quantum, whatever it computes, and an
// idle oscillator costs as much as a sounding one. So each instrument is
// built to keep the number of live nodes minimal:
//   - plucked strings and percussion play pre-rendered Karplus-Strong /
//     drum buffers through a few shared velocity buses: ONE node per note;
//   - pad and brass notes create their two oscillators for exactly as long
//     as the note sounds;
//   - fast repeated parts (spiccato strings, the breath lead, the drone) are
//     small persistent graphs driven purely by AudioParam automation.
// Envelopes are built from setTargetAtTime segments, which are continuous
// whatever came before — notes can overlap or be cut short without a step.
// Every instrument exposes `.out` (a GainNode: level x layer gate) and
// dispose().
import { midiHz } from './dsp.js';

function mkGain(E, v) {
  const g = E.ctx.createGain();
  g.gain.value = v;
  E.count(1);
  return g;
}

function mkFilter(E, type, f, q, gainDb) {
  const n = E.ctx.createBiquadFilter();
  n.type = type; n.frequency.value = f; n.Q.value = q || 0.707;
  if (gainDb !== undefined) n.gain.value = gainDb;
  E.count(1);
  return n;
}

// custom timbres are free: one oscillator instead of oscillator stacks + filters
const WAVES = {
  // sawtooth with a gentle roll-off: warm string section, no filter needed
  strings: (n) => (1 / n) / (1 + Math.pow(n / 12, 2)),
  bright: (n) => (1 / n) / (1 + Math.pow(n / 26, 2)),
  dark: (n) => (1 / n) / (1 + Math.pow(n / 5, 2)),
  ney: (n) => [0, 1, 0.3, 0.1, 0.035, 0.012][n] || 0,
  duduk: (n) => [0, 1, 0.14, 0.42, 0.07, 0.2, 0.04, 0.09, 0.02, 0.04][n] || 0,
};

function waveOf(E, name) {
  const cache = E.waves || (E.waves = {});
  if (cache[name]) return cache[name];
  const N = 40;
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let n = 1; n < N; n++) im[n] = WAVES[name](n);
  cache[name] = E.ctx.createPeriodicWave(re, im);
  return cache[name];
}

function mkOsc(E, wave, freq) {
  const o = E.ctx.createOscillator();
  if (WAVES[wave]) o.setPeriodicWave(waveOf(E, wave));
  else o.type = wave;
  o.frequency.value = freq;
  E.count(1);
  return o;
}

class Inst {
  // o: { level, pan }
  constructor(E, o) {
    this.E = E;
    this.ctx = E.ctx;
    this.level = o.level === undefined ? 1 : o.level;
    this.gateV = 1;
    this.out = mkGain(E, this.level);
    this.srcs = [];
    if (o.pan && typeof E.ctx.createStereoPanner === 'function') {
      this.pre = E.ctx.createStereoPanner();
      this.pre.pan.value = o.pan;
      this.pre.connect(this.out);
      E.count(1);
    } else {
      this.pre = this.out;
    }
  }

  // adaptive-layer gate 0..1, smoothed
  gate(g, t) {
    if (Math.abs(g - this.gateV) < 0.004) return;
    this.gateV = g;
    this.out.gain.setTargetAtTime(this.level * g, t, 0.12);
  }

  dispose() {
    try { this.out.disconnect(); } catch (e) { /* ok */ }
    for (const s of this.srcs) { try { s.stop(); s.disconnect(); } catch (e) { /* ok */ } }
    this.srcs.length = 0;
  }
}

// A handful of fixed gains shared by all the notes of an instrument: a note's
// velocity picks the nearest one, so a note is a single buffer-source node.
class VelBuses {
  constructor(E, dest, levels) {
    this.levels = levels;
    this.nodes = levels.map((l) => { const g = mkGain(E, l); g.connect(dest); return g; });
  }

  pick(vel) {
    const L = this.levels;
    let best = 0;
    for (let i = 1; i < L.length; i++) if (Math.abs(L[i] - vel) < Math.abs(L[best] - vel)) best = i;
    return this.nodes[best];
  }
}

function playBuffer(E, buf, dest, t, rate) {
  const s = E.ctx.createBufferSource();
  s.buffer = buf;
  if (rate && rate !== 1) s.playbackRate.value = rate;
  s.connect(dest);
  // a finished source must leave the graph now, not whenever GC gets to it
  s.onended = () => { try { s.disconnect(); } catch (e) { /* ok */ } };
  s.start(t);
  E.count(1);
  return s;
}

// ---- plucked strings: oud / qanun / bass ----------------------------------------

export class PluckInst extends Inst {
  // o: { kind: 'oud' | 'qanun' | 'bass', level, pan }
  constructor(E, o) {
    super(E, o);
    this.kind = o.kind;
    this.bus = new VelBuses(E, this.pre, [0.22, 0.32, 0.44, 0.58, 0.74, 0.9, 1.08]);
  }

  // short: the damped variant (ostinati, staccato)
  note(t, midi, vel, short) {
    const E = this.E;
    const dest = this.bus.pick(vel);
    const buf = E.assets.get('pluck:' + this.kind + ':' + midi + (short ? ':s' : ''), (b) => {
      if (t > this.ctx.currentTime + 0.008) playBuffer(E, b, dest, t);
    });
    if (buf) playBuffer(E, buf, dest, t);
  }
}

// ---- breathy lead: ney (flute) / duduk (reed) --------------------------------------
// One oscillator with a custom spectrum + a pitch-tracked band of breath
// noise, delayed vibrato, portamento. Monophonic and persistent.

export class BreathLead extends Inst {
  // o: { kind: 'ney' | 'duduk', level, pan }
  constructor(E, o) {
    super(E, o);
    const ctx = E.ctx;
    const ney = o.kind !== 'duduk';
    this.band = ney ? 1 : 2;
    this.osc = mkOsc(E, ney ? 'ney' : 'duduk', 440);
    try { this.osc.detune.automationRate = 'k-rate'; } catch (e) { /* ok */ }
    this.amp = mkGain(E, 0);
    this.osc.connect(this.amp);
    const nz = ctx.createBufferSource();
    nz.buffer = E.noise('pink');
    nz.loop = true;
    this.bp = mkFilter(E, 'bandpass', 440 * this.band, ney ? 3 : 2);
    this.breath = mkGain(E, 0);
    nz.connect(this.breath); this.breath.connect(this.bp);
    const bg = mkGain(E, ney ? 6 : 2.8);
    this.bp.connect(bg); bg.connect(this.amp);
    const lfo = mkOsc(E, 'sine', ney ? 5.2 : 4.6);
    this.vib = mkGain(E, 0);
    lfo.connect(this.vib); this.vib.connect(this.osc.detune);
    this.vibDepth = ney ? 22 : 16;
    const formant = mkFilter(E, 'peaking', ney ? 1600 : 750, ney ? 1.5 : 1.2, ney ? 3 : 5);
    this.amp.connect(formant); formant.connect(this.pre);
    this.osc.start(); lfo.start(); nz.start(0, E.rng() * 1.5);
    this.srcs.push(this.osc, lfo, nz);
    E.count(1);
    this.lastEnd = -1;
  }

  // opt: { slur, grace (cents above to fall from) }
  note(t, midi, vel, dur, opt) {
    const o = opt || {};
    const f = midiHz(midi);
    const a = this.amp.gain, b = this.breath.gain, vb = this.vib.gain;
    const of = this.osc.frequency, bf = this.bp.frequency;
    const legato = o.slur && this.lastEnd >= t - 0.03;
    if (legato) {
      a.cancelScheduledValues(t - 0.002);
      b.cancelScheduledValues(t - 0.002);
      of.setTargetAtTime(f, t, 0.028);
      bf.setTargetAtTime(f * this.band, t, 0.028);
      a.setTargetAtTime(vel, t, 0.06);
      b.setTargetAtTime(vel * 0.3, t, 0.05);
    } else {
      a.cancelScheduledValues(t);
      b.cancelScheduledValues(t);
      vb.cancelScheduledValues(t);
      if (o.grace) {
        of.setValueAtTime(f * Math.pow(2, o.grace / 1200), t);
        of.setTargetAtTime(f, t + 0.045, 0.012);
      } else {
        of.setValueAtTime(f, t);
      }
      bf.setValueAtTime(f * this.band, t);
      a.setTargetAtTime(vel, t, 0.04);
      // chiff: a burst of breath at the attack that settles under the tone
      b.setTargetAtTime(vel * 1.1, t, 0.008);
      b.setTargetAtTime(vel * 0.3, t + 0.05, 0.07);
      vb.setTargetAtTime(0, t, 0.02);
    }
    vb.setTargetAtTime(this.vibDepth, t + Math.min(0.24, dur * 0.4), 0.16);
    a.setTargetAtTime(0, t + dur, 0.075);
    b.setTargetAtTime(0, t + dur, 0.05);
    this.lastEnd = t + dur;
  }
}

// ---- strings ------------------------------------------------------------------------

// Sustained string pad: two detuned oscillators per note, one in each
// channel (a wide ensemble shimmer instead of a mono tremolo beat), alive
// only while the note and its release sound.
export class PadInst extends Inst {
  // o: { level, wave ('strings' | 'dark' | 'bright'), detune (cents) }
  constructor(E, o) {
    super(E, o);
    this.wave = o.wave || 'strings';
    this.det = o.detune || 5;
  }

  // atk / rel are time constants (seconds)
  note(t, midi, vel, dur, atk, rel) {
    const E = this.E, ctx = this.ctx;
    const f = midiHz(midi);
    const r = rel || 0.12;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(vel, t, atk || 0.05);
    g.gain.setTargetAtTime(0, t + dur, r);
    const end = t + dur + r * 7;
    const k = Math.pow(2, this.det / 1200);
    const a = mkOsc(E, this.wave, f / k), b = mkOsc(E, this.wave, f * k);
    const m = ctx.createChannelMerger(2);
    a.connect(m, 0, 0); b.connect(m, 0, 1); m.connect(g); g.connect(this.pre);
    a.start(t); b.start(t); a.stop(end); b.stop(end);
    b.onended = () => { try { g.disconnect(); } catch (e) { /* ok */ } };
    E.count(2);
  }

  chord(t, midis, vel, dur, atk, rel) {
    for (const m of midis) this.note(t, m, vel, dur, atk, rel);
  }
}

// Spiccato / pulsing strings: a few persistent voices re-pitched and
// re-enveloped by automation (right for fast repeated notes).
export class StacInst extends Inst {
  // o: { voices, level, wave, detune }
  constructor(E, o) {
    super(E, o);
    const k = Math.pow(2, (o.detune || 6) / 1200);
    this.k = k;
    this.voices = [];
    for (let i = 0; i < (o.voices || 2); i++) {
      const g = mkGain(E, 0);
      const a = mkOsc(E, o.wave || 'bright', 110 / k), b = mkOsc(E, o.wave || 'bright', 110 * k);
      a.connect(g); b.connect(g); g.connect(this.pre);
      a.start(); b.start();
      this.srcs.push(a, b);
      this.voices.push({ a: a.frequency, b: b.frequency, g: g.gain, free: -1 });
    }
  }

  note(t, midi, vel, dur, atk, rel) {
    let v = this.voices[0];
    for (const x of this.voices) if (x.free < v.free) v = x;
    const f = midiHz(midi);
    v.a.setValueAtTime(f / this.k, t);
    v.b.setValueAtTime(f * this.k, t);
    v.g.cancelScheduledValues(t);
    v.g.setTargetAtTime(vel, t, atk || 0.004);
    v.g.setTargetAtTime(0, t + dur, rel || 0.045);
    v.free = t + dur + (rel || 0.045) * 3;
  }
}

// ---- brass ---------------------------------------------------------------------------
// Two saws per note into a low-pass whose cutoff follows the dynamics (louder
// = brighter), with a small pitch scoop on the attack. Nodes live per note.

export class BrassInst extends Inst {
  constructor(E, o) {
    super(E, o);
    this.formant = mkFilter(E, 'peaking', 1100, 1, 3);
    this.formant.connect(this.pre);
  }

  // mode: 'stab' | 'sus' | 'swell'
  note(t, midi, vel, dur, mode) {
    const E = this.E, ctx = this.ctx;
    const hz = midiHz(midi);
    const bright = Math.min(6000, hz * (1.5 + vel * vel * 9));
    const g = ctx.createGain();
    g.gain.value = 0;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 0.9;
    f.frequency.value = 300;
    try { f.frequency.automationRate = 'k-rate'; } catch (e) { /* ok */ }
    const a = mkOsc(E, 'sawtooth', hz * 0.9983), b = mkOsc(E, 'sawtooth', hz * 1.0019);
    const fast = mode === 'stab';
    if (mode === 'swell') {
      g.gain.setTargetAtTime(vel, t, dur / 3.2);
      f.frequency.setTargetAtTime(bright, t, dur / 3);
    } else {
      for (const o of [a, b]) {
        try { o.detune.automationRate = 'k-rate'; } catch (e) { /* ok */ }
        o.detune.setValueAtTime(-35, t);
        o.detune.setTargetAtTime(0, t, 0.018);
      }
      g.gain.setTargetAtTime(vel, t, fast ? 0.008 : 0.028);
      f.frequency.setTargetAtTime(bright, t, fast ? 0.012 : 0.04);
      f.frequency.setTargetAtTime(bright * (fast ? 0.45 : 0.7), t + (fast ? 0.06 : 0.18), fast ? 0.08 : 0.3);
    }
    const rel = fast ? 0.05 : 0.09;
    g.gain.setTargetAtTime(0, t + dur, rel);
    f.frequency.setTargetAtTime(300, t + dur, rel);
    const end = t + dur + rel * 7;
    a.connect(g); b.connect(g); g.connect(f); f.connect(this.formant);
    a.start(t); b.start(t); a.stop(end); b.stop(end);
    b.onended = () => { try { f.disconnect(); } catch (e) { /* ok */ } };
    E.count(2);
  }
}

// ---- drone: sub + two slow-beating low strings + a wandering band of air -------------

export class Drone extends Inst {
  // o: { level, root (MIDI of the low strings, default D2 = 38), air }
  constructor(E, o) {
    super(E, o);
    const ctx = E.ctx;
    const f = midiHz(o.root || 38);
    this.sub = mkOsc(E, 'sine', f / 2);
    const sg = mkGain(E, 0.2);
    this.sub.connect(sg); sg.connect(this.pre);
    this.a = mkOsc(E, 'strings', f * 0.9991);
    this.b = mkOsc(E, 'strings', f * 1.0013);
    const tg = mkGain(E, 0.6);
    this.a.connect(tg); this.b.connect(tg); tg.connect(this.pre);
    // air: a slowly wandering resonant band of noise (desert wind in the hall)
    const nz = ctx.createBufferSource();
    nz.buffer = E.noise('pink');
    nz.loop = true;
    const bp = mkFilter(E, 'bandpass', 950, 5);
    try { bp.frequency.automationRate = 'k-rate'; } catch (e) { /* ok */ }
    const wander = mkOsc(E, 'sine', 0.05);
    const wg = mkGain(E, 420);
    wander.connect(wg); wg.connect(bp.frequency);
    const ag = mkGain(E, 1.7 * (o.air === undefined ? 1 : o.air));
    nz.connect(bp); bp.connect(ag); ag.connect(this.pre);
    this.sub.start(); this.a.start(); this.b.start(); wander.start(); nz.start(0, E.rng() * 1.5);
    this.srcs.push(this.sub, this.a, this.b, wander, nz);
    E.count(1);
  }

  // glide to a new root (key lifts)
  tune(t, midi, tau) {
    const f = midiHz(midi), k = tau || 0.4;
    this.sub.frequency.setTargetAtTime(f / 2, t, k);
    this.a.frequency.setTargetAtTime(f * 0.9991, t, k);
    this.b.frequency.setTargetAtTime(f * 1.0013, t, k);
  }
}

// ---- percussion ------------------------------------------------------------------------

const DRUM_GAIN = {
  dum: 1.0, tek: 0.85, ka: 0.65, slap: 0.75, frame: 0.8, frame_tak: 0.65, riq: 0.6,
  taiko: 0.8, taiko_ens: 0.6, clack: 0.6, boom: 0.5, timp: 0.7, snare: 0.8, tick: 0.5, cym: 0.6,
  gong: 0.55, shaker: 1.1, shaker_l: 1.1, swell: 1.0,
};
const BIG = { taiko: 1, taiko_ens: 1, boom: 1, timp: 1, gong: 1, cym: 1, swell: 1 };
const KIT_LEVELS = [0.1, 0.16, 0.24, 0.34, 0.46, 0.6, 0.76, 0.94, 1.15];

export class DrumKit extends Inst {
  // o: { level }. `.out` carries the whole kit; `.wide` carries only the big
  // drums so a track can send them deeper into the hall.
  constructor(E, o) {
    super(E, o);
    this.wide = mkGain(E, 1);
    const bigIn = mkGain(E, 1);
    bigIn.connect(this.out);
    bigIn.connect(this.wide);
    this.hand = new VelBuses(E, this.out, KIT_LEVELS);
    this.big = new VelBuses(E, bigIn, KIT_LEVELS);
  }

  hit(t, name, vel, rate) {
    const E = this.E;
    const dest = (BIG[name] ? this.big : this.hand).pick(vel * (DRUM_GAIN[name] || 0.5));
    const buf = E.assets.get('drum:' + name, (b) => {
      if (t > this.ctx.currentTime + 0.008) playBuffer(E, b, dest, t, rate);
    });
    if (buf) playBuffer(E, buf, dest, t, rate);
  }

  shake(t, vel, long) {
    this.hit(t, long ? 'shaker_l' : 'shaker', vel, 1);
  }

  // noise swell peaking at t + dur (the 3 s riser buffer, re-timed to fit)
  swell(t, dur, peak) {
    this.hit(t, 'swell', peak, 3 / Math.max(0.3, dur));
  }

  dispose() {
    try { this.wide.disconnect(); } catch (e) { /* ok */ }
    super.dispose();
  }
}
