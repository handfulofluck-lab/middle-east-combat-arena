// SFX recipes: every sound is layered synthesis on a short-lived voice the
// engine hands in (see AudioEngine.fire). A voice `v` offers:
//   v.t     start time on the context clock      v.in   dry input (GainNode)
//   v.wet   reverb-only input ("distant tail")    v.pan  StereoPanner or null
//   v.end   latest layer end (recipes extend it) v.E    engine (rng, noise)
// Layers always open from gain 0 and close to gain 0, so no voice can click.
// Small parameters are randomised per shot so repetition never machine-guns.
//
// Table entries: cat (throttle class), prio (voice stealing), lvl (calibrated
// trim), send (reverb send at dist 0), gap (min seconds between retriggers),
// duck: [dB, hold s, release s] of music ducking.

// score key: D (Hijaz). UI and notification tones stay on D / F# / A.
const D4 = 293.66, EB4 = 311.13, A4 = 440, D5 = 587.33, EB5 = 622.25, FS5 = 739.99,
  A5 = 880, D6 = 1174.66, FS6 = 1479.98, A6 = 1760, A3 = 220, G4 = 392.0, FS4 = 369.99;

function rr(v, a, b) { return a + (b - a) * v.E.rng(); }

// 0 -> pk over a, optional hold, exponential decay over d (-60 dB), then 0
function env(p, t, a, pk, d, h) {
  p.value = 0;
  if (!(pk > 1e-6)) return t;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(pk, t + a);
  let te = t + a;
  if (h > 0) { te += h; p.setValueAtTime(pk, te); }
  p.exponentialRampToValueAtTime(pk * 0.001, te + d);
  p.linearRampToValueAtTime(0, te + d + 0.004);
  return te + d + 0.004;
}

// piecewise-linear envelope: pts = [[dt, value], ...], must end at value 0
function envPts(p, t, pts, k) {
  p.value = 0;
  p.setValueAtTime(0, t);
  let last = 0;
  for (let i = 0; i < pts.length; i++) {
    p.linearRampToValueAtTime(pts[i][1] * k, t + pts[i][0]);
    last = pts[i][0];
  }
  return t + last;
}

// overlap-safe retriggerable pulse (setTargetAtTime is continuous by definition)
function pulse(p, t, a, pk, td) {
  p.setTargetAtTime(pk, t, a / 3);
  p.setTargetAtTime(0, t + a, td);
}

function shared(v, color) {
  let s = v.shared[color];
  if (s) return s;
  const E = v.E;
  s = v.ctx.createBufferSource();
  s.buffer = color === 'crackle' ? E.crackle() : E.noise(color);
  s.loop = true;
  const dur = s.buffer ? s.buffer.duration : 1;
  s.start(v.t, E.rng() * dur * 0.9);
  v.srcs.push(s);
  v.shared[color] = s;
  E.count(1);
  return s;
}

function sweep(param, t0, o, total) {
  param.setValueAtTime(o.f, t0);
  if (o.fp) {
    for (let i = 0; i < o.fp.length; i++) {
      param.exponentialRampToValueAtTime(o.fp[i][1], t0 + o.fp[i][0]);
    }
  } else if (o.f1) {
    param.exponentialRampToValueAtTime(o.f1, t0 + (o.tf || total));
  }
}

function shape(v, g, t0, o) {
  const end = o.env ? envPts(g.gain, t0, o.env, o.g)
    : env(g.gain, t0, o.a || 0.001, o.g, o.d, o.h || 0);
  if (end > v.end) v.end = end;
  return end;
}

// noise layer. o: { c colour, t, a, h, d, g | env, ft filter type, f, f1, tf,
// fp, q, wet }
// (the envelope gain comes first: once it closes, the filter sees silence and
// the browser stops processing it)
function N(v, o) {
  const ctx = v.ctx, t0 = v.t + (o.t || 0);
  const g = ctx.createGain();
  shape(v, g, t0, o);
  shared(v, o.c || 'white').connect(g);
  let node = g;
  if (o.ft) {
    const f = ctx.createBiquadFilter();
    f.type = o.ft;
    sweep(f.frequency, t0, o, (o.a || 0.001) + (o.h || 0) + (o.d || 0.2));
    f.Q.value = o.q || 0.707;
    g.connect(f);
    node = f;
  }
  node.connect(o.wet ? v.wet : v.in);
  v.E.count(o.ft ? 2 : 1);
  return node;
}

// oscillator layer. o: { w wave, f, f1, tf, fp, t, a, h, d, g | env, lp, wet }
function O(v, o) {
  const ctx = v.ctx, t0 = v.t + (o.t || 0);
  const osc = ctx.createOscillator();
  osc.type = o.w || 'sine';
  sweep(osc.frequency, t0, o, (o.a || 0.002) + (o.h || 0) + (o.d || 0.2));
  const g = ctx.createGain();
  if (!o.a && !o.env) o.a = 0.002;
  const end = shape(v, g, t0, o);
  osc.connect(g);
  let node = g;
  if (o.lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(o.lp, t0);
    if (o.lp1) f.frequency.exponentialRampToValueAtTime(o.lp1, t0 + (o.tf || o.d || 0.3));
    f.Q.value = o.q || 0.707;
    g.connect(f);
    node = f;
  }
  node.connect(o.wet ? v.wet : v.in);
  osc.start(t0);
  osc.stop(end + 0.02);
  v.own.push(osc);
  v.E.count(o.lp ? 3 : 2);
  return osc;
}

// two-operator FM "metal" partial. o: { f, ratio, idx, t, a, d, g }
function FM(v, o) {
  const ctx = v.ctx, t0 = v.t + (o.t || 0);
  const car = ctx.createOscillator(), mod = ctx.createOscillator();
  const mg = ctx.createGain(), g = ctx.createGain();
  car.frequency.value = o.f;
  mod.frequency.value = o.f * o.ratio;
  const dev = (o.idx || 1.5) * o.f * o.ratio;
  mg.gain.setValueAtTime(dev, t0);
  mg.gain.exponentialRampToValueAtTime(dev * 0.06, t0 + o.d);
  mod.connect(mg);
  mg.connect(car.frequency);
  const end = env(g.gain, t0, o.a || 0.001, o.g, o.d, 0);
  car.connect(g);
  g.connect(o.wet ? v.wet : v.in);
  car.start(t0); mod.start(t0);
  car.stop(end + 0.02); mod.stop(end + 0.02);
  v.own.push(car, mod);
  if (end > v.end) v.end = end;
  v.E.count(4);
}

// soft bell for UI / notifications
function bell(v, f, t, d, g) {
  FM(v, { f, ratio: 3.01, idx: 0.55, t, d, g, a: 0.0015 });
  O(v, { f: f * 2, t, a: 0.0015, d: d * 0.5, g: g * 0.25 });
}

function tick(v, t, g, f) {
  N(v, { c: 'white', ft: 'bandpass', f: f || 3600, q: 1.6, t, a: 0.0004, d: 0.009, g });
}

// pulsed noise through one filter: a burst of shots from a single source
function NB(v, o, times, peaks) {
  const ctx = v.ctx;
  const f = ctx.createBiquadFilter();
  f.type = o.ft; f.frequency.value = o.f; f.Q.value = o.q || 0.707;
  const g = ctx.createGain();
  g.gain.value = 0;
  shared(v, o.c || 'white').connect(g);
  g.connect(f);
  f.connect(v.in);
  for (let i = 0; i < times.length; i++) {
    pulse(g.gain, v.t + times[i], o.a || 0.0015, o.g * peaks[i], o.td);
  }
  const end = v.t + times[times.length - 1] + (o.a || 0.0015) + o.td * 7;
  if (end > v.end) v.end = end;
  v.E.count(2);
}

// pulsed pitch-dropping sine: the thump under each shot of a burst
function OB(v, o, times, peaks, pitches) {
  const ctx = v.ctx;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.value = 0;
  for (let i = 0; i < times.length; i++) {
    const ti = v.t + times[i];
    osc.frequency.setValueAtTime(o.f * pitches[i], ti);
    osc.frequency.exponentialRampToValueAtTime(o.f1 * pitches[i], ti + o.tf);
    pulse(g.gain, ti, 0.002, o.g * peaks[i], o.td);
  }
  osc.connect(g);
  g.connect(v.in);
  const end = v.t + times[times.length - 1] + o.td * 7;
  osc.start(v.t + times[0]);
  osc.stop(end + 0.02);
  v.own.push(osc);
  if (end > v.end) v.end = end;
  v.E.count(2);
}

function burstPlan(v, count, interval, jitter) {
  const times = [], peaks = [], pitches = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    times.push(t);
    peaks.push(rr(v, 0.8, 1.08));
    pitches.push(rr(v, 0.95, 1.05));
    t += interval + rr(v, -jitter, jitter);
  }
  return { times, peaks, pitches, len: times[count - 1] };
}

// pan automation hooks: run by the engine on the playing voice (never baked)
function panSweep(v, from, to, t, dur) {
  if (!v.pan || !v.pan.pan) return;
  const p = v.pan.pan;
  const clampPan = (x) => Math.max(-1, Math.min(1, x));
  p.setValueAtTime(clampPan(from), v.t + t);
  p.linearRampToValueAtTime(clampPan(to), v.t + t + dur);
}

function flybyPan(v) {
  const dir = v.E.rng() < 0.5 ? 1 : -1;
  const c = v.panPos || 0;
  panSweep(v, c - 0.85 * dir, c + 0.85 * dir, 0.2, 1.7);
}

function whooshPan(v) {
  const dir = v.E.rng() < 0.5 ? 1 : -1;
  panSweep(v, -0.6 * dir, 0.6 * dir, 0, 1.0);
}

// ---- weapons -----------------------------------------------------------------------

function rifle(v) {
  const p = rr(v, 0.93, 1.07);
  N(v, { c: 'white', ft: 'highpass', f: 2600 * p, a: 0.0004, d: 0.03, g: 0.5 });
  N(v, { c: 'pink', ft: 'bandpass', f: 1100 * p, f1: 600, q: 0.8, a: 0.001, d: 0.085, g: 1.3 });
  O(v, { f: 200 * p, f1: 80, a: 0.001, d: 0.06, g: 0.45 });
  N(v, { c: 'pink', ft: 'bandpass', f: 1300, f1: 450, q: 0.6, t: 0.01, a: 0.015, d: 0.3, g: 0.3, wet: true });
}

function mg(v) {
  const b = burstPlan(v, 3 + Math.floor(v.E.rng() * 3), rr(v, 0.078, 0.092), 0.006);
  NB(v, { c: 'white', ft: 'highpass', f: rr(v, 2200, 2700), g: 0.45, td: 0.008 }, b.times, b.peaks);
  NB(v, { c: 'pink', ft: 'bandpass', f: rr(v, 780, 920), q: 0.8, g: 1.3, td: 0.016 }, b.times, b.peaks);
  OB(v, { f: 170, f1: 70, tf: 0.05, g: 0.5, td: 0.014 }, b.times, b.peaks, b.pitches);
  N(v, { c: 'pink', ft: 'bandpass', f: 1200, f1: 500, q: 0.6, t: 0.01, a: 0.02, h: b.len, d: 0.3, g: 0.26, wet: true });
}

function autocannon(v) {
  const b = burstPlan(v, 3, rr(v, 0.12, 0.14), 0.006);
  NB(v, { c: 'white', ft: 'highpass', f: 1800, g: 0.5, td: 0.012 }, b.times, b.peaks);
  NB(v, { c: 'pink', ft: 'bandpass', f: rr(v, 540, 660), q: 0.7, g: 1.6, td: 0.028 }, b.times, b.peaks);
  OB(v, { f: 130, f1: 52, tf: 0.08, g: 0.75, td: 0.024 }, b.times, b.peaks, b.pitches);
  FM(v, { f: rr(v, 580, 700), ratio: 1.47, idx: 1.4, d: 0.09, g: 0.09 });
  N(v, { c: 'pink', ft: 'bandpass', f: 900, f1: 350, q: 0.5, t: 0.02, a: 0.03, h: b.len, d: 0.5, g: 0.3, wet: true });
}

function aaGun(v) {
  const b = burstPlan(v, 6 + Math.floor(v.E.rng() * 3), rr(v, 0.048, 0.056), 0.003);
  NB(v, { c: 'white', ft: 'highpass', f: 2400, g: 0.42, td: 0.006 }, b.times, b.peaks);
  NB(v, { c: 'pink', ft: 'bandpass', f: rr(v, 900, 1100), q: 0.8, g: 1.2, td: 0.01 }, b.times, b.peaks);
  OB(v, { f: 185, f1: 82, tf: 0.035, g: 0.42, td: 0.009 }, b.times, b.peaks, b.pitches);
  N(v, { c: 'pink', ft: 'bandpass', f: 1100, f1: 420, q: 0.5, t: 0.02, a: 0.03, h: b.len, d: 0.4, g: 0.3, wet: true });
}

function cannon(v) {
  const p = rr(v, 0.93, 1.07);
  N(v, { c: 'white', ft: 'highpass', f: 4000, a: 0.0003, d: 0.012, g: 0.5 });
  N(v, { c: 'white', ft: 'bandpass', f: 3800 * p, f1: 420, tf: 0.14, q: 0.7, a: 0.0008, d: 0.18, g: 0.9 });
  N(v, { c: 'pink', ft: 'lowpass', f: 1500 * p, f1: 160, tf: 0.3, a: 0.002, d: 0.42, g: 1.7 });
  O(v, { f: 92 * p, f1: 33, tf: 0.22, a: 0.002, d: 0.38, g: 1.0 });
  FM(v, { f: 540 * p, ratio: 1.38, idx: 1.8, d: 0.28, g: 0.1 });
  N(v, { c: 'pink', ft: 'bandpass', f: 700, f1: 260, q: 0.5, t: 0.07, a: 0.06, d: 1.2, g: 0.42, wet: true });
}

function heavyCannon(v) {
  const p = rr(v, 0.93, 1.07);
  N(v, { c: 'white', ft: 'highpass', f: 3500, a: 0.0003, d: 0.014, g: 0.5 });
  N(v, { c: 'white', ft: 'bandpass', f: 3000 * p, f1: 300, tf: 0.2, q: 0.6, a: 0.0008, d: 0.25, g: 0.9 });
  N(v, { c: 'pink', ft: 'lowpass', f: 1100 * p, f1: 110, tf: 0.5, a: 0.002, d: 0.7, g: 1.9 });
  N(v, { c: 'brown', ft: 'lowpass', f: 300, a: 0.03, d: 0.4, g: 1.2 });
  O(v, { f: 76 * p, f1: 27, tf: 0.35, a: 0.002, d: 0.65, g: 1.1 });
  O(v, { w: 'triangle', f: 50 * p, f1: 25, tf: 0.4, a: 0.004, d: 0.5, g: 0.3 });
  FM(v, { f: 380 * p, ratio: 1.33, idx: 1.6, d: 0.4, g: 0.08 });
  N(v, { c: 'pink', ft: 'bandpass', f: 500, f1: 200, q: 0.5, t: 0.09, a: 0.1, d: 2.0, g: 0.55, wet: true });
}

function navalGun(v) {
  const p = rr(v, 0.93, 1.07);
  const slap = rr(v, 0.15, 0.21);
  N(v, { c: 'white', ft: 'bandpass', f: 3200 * p, f1: 320, tf: 0.2, q: 0.6, a: 0.0008, d: 0.24, g: 0.9 });
  N(v, { c: 'pink', ft: 'lowpass', f: 1300 * p, f1: 120, tf: 0.5, a: 0.002, d: 0.65, g: 1.9 });
  O(v, { f: 80 * p, f1: 29, tf: 0.3, a: 0.002, d: 0.6, g: 1.1 });
  FM(v, { f: 262 * p, ratio: 1.41, idx: 1.5, d: 0.5, g: 0.09 });
  // slap-back off the water
  N(v, { c: 'pink', ft: 'lowpass', f: 900, f1: 200, t: slap, a: 0.004, d: 0.35, g: 0.6 });
  O(v, { f: 70, f1: 34, t: slap, a: 0.004, d: 0.3, g: 0.3 });
  N(v, { c: 'pink', ft: 'bandpass', f: 520, f1: 190, q: 0.5, t: 0.09, a: 0.12, d: 2.2, g: 0.6, wet: true });
}

function atgm(v) {
  const p = rr(v, 0.92, 1.08);
  N(v, { c: 'white', ft: 'bandpass', f: 2200 * p, q: 1, a: 0.0006, d: 0.05, g: 0.7 });
  O(v, { f: 150 * p, f1: 60, d: 0.07, g: 0.5 });
  N(v, { c: 'pink', ft: 'bandpass', f: 700 * p, f1: 2600 * p, tf: 0.5, q: 1.6, t: 0.02, a: 0.04, h: 0.15, d: 0.8, g: 1.1 });
  N(v, { c: 'white', ft: 'highpass', f: 5000, t: 0.02, a: 0.03, d: 0.6, g: 0.12 });
  O(v, { f: 420 * p, f1: 900 * p, tf: 0.6, t: 0.02, a: 0.05, d: 0.7, g: 0.045 });
  N(v, { c: 'pink', ft: 'bandpass', f: 1000, q: 0.6, t: 0.05, a: 0.1, d: 0.8, g: 0.2, wet: true });
}

function rocket(v) {
  const p = rr(v, 0.92, 1.08);
  N(v, { c: 'pink', ft: 'lowpass', f: 1800 * p, f1: 300, a: 0.001, d: 0.12, g: 1.5 });
  O(v, { f: 130 * p, f1: 50, d: 0.09, g: 0.6 });
  N(v, { c: 'white', ft: 'bandpass', f: 1100 * p, f1: 3200 * p, tf: 0.35, q: 1.2, t: 0.015, a: 0.02, d: 0.55, g: 0.5 });
  N(v, { c: 'crackle', ft: 'highpass', f: 2000, t: 0.02, a: 0.02, d: 0.4, g: 0.3 });
  N(v, { c: 'pink', ft: 'bandpass', f: 900, q: 0.6, t: 0.05, a: 0.08, d: 0.7, g: 0.22, wet: true });
}

function mlrs(v) {
  const n = 4 + Math.floor(v.E.rng() * 2);
  const b = burstPlan(v, n, rr(v, 0.15, 0.18), 0.015);
  // one band-passed stream re-swept for every rocket leaving the rail
  const ctx = v.ctx;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.Q.value = 1.3;
  const g = ctx.createGain();
  g.gain.value = 0;
  shared(v, 'pink').connect(g);
  g.connect(f);
  f.connect(v.in);
  for (let i = 0; i < n; i++) {
    const ti = v.t + b.times[i];
    f.frequency.setValueAtTime(520 * b.pitches[i], ti);
    f.frequency.exponentialRampToValueAtTime(2500 * b.pitches[i], ti + 0.13);
    pulse(g.gain, ti, 0.02, 1.1 * b.peaks[i], 0.08);
  }
  v.E.count(2);
  OB(v, { f: 125, f1: 50, tf: 0.07, g: 0.5, td: 0.022 }, b.times, b.peaks, b.pitches);
  NB(v, { c: 'white', ft: 'highpass', f: 4500, g: 0.13, td: 0.07, a: 0.01 }, b.times, b.peaks);
  N(v, { c: 'brown', ft: 'lowpass', f: 420, a: 0.1, h: b.len, d: 0.8, g: 0.9 });
  N(v, { c: 'pink', ft: 'bandpass', f: 800, f1: 300, q: 0.5, t: 0.05, a: 0.15, h: b.len, d: 1.3, g: 0.4, wet: true });
}

function sam(v) {
  const p = rr(v, 0.93, 1.07);
  N(v, { c: 'pink', ft: 'lowpass', f: 2200 * p, f1: 250, a: 0.001, d: 0.14, g: 1.7 });
  O(v, { f: 140 * p, f1: 45, d: 0.12, g: 0.7 });
  N(v, { c: 'pink', ft: 'bandpass', f: 500 * p, f1: 1900 * p, tf: 1.2, q: 1.1, t: 0.03, a: 0.05, h: 0.3, d: 1.4, g: 1.2 });
  N(v, { c: 'crackle', ft: 'highpass', f: 1800, t: 0.03, a: 0.05, d: 1.2, g: 0.35 });
  O(v, { f: 600 * p, f1: 1500 * p, tf: 1.0, t: 0.03, a: 0.1, d: 1.2, g: 0.035 });
  N(v, { c: 'pink', ft: 'bandpass', f: 800, q: 0.5, t: 0.06, a: 0.15, d: 1.5, g: 0.35, wet: true });
}

function bomb(v) {
  const p = rr(v, 0.92, 1.08);
  FM(v, { f: 260 * p, ratio: 1.9, idx: 1.2, d: 0.05, g: 0.2 });
  N(v, { c: 'white', ft: 'lowpass', f: 900, a: 0.001, d: 0.03, g: 0.3 });
  const shapeEnv = [[0.3, 0.25], [0.9, 1], [1.15, 0.5], [1.25, 0]];
  O(v, { f: 2300 * p, f1: 900 * p, tf: 1.2, t: 0.05, env: shapeEnv, g: 0.15 });
  O(v, { f: 2350 * p, f1: 925 * p, tf: 1.2, t: 0.05, env: shapeEnv, g: 0.08 });
  N(v, { c: 'white', ft: 'bandpass', f: 2300 * p, f1: 900 * p, tf: 1.2, q: 7, t: 0.05, env: shapeEnv, g: 0.6 });
}

function cruise(v) {
  const p = rr(v, 0.94, 1.06);
  N(v, { c: 'pink', ft: 'lowpass', f: 1800 * p, f1: 200, a: 0.001, d: 0.2, g: 1.9 });
  O(v, { f: 110 * p, f1: 38, d: 0.2, g: 0.8 });
  N(v, { c: 'brown', ft: 'lowpass', f: 600, t: 0.03, a: 0.08, h: 0.6, d: 1.6, g: 1.5 });
  N(v, { c: 'pink', ft: 'bandpass', f: 900 * p, f1: 1500 * p, tf: 1.6, q: 0.8, t: 0.03, a: 0.1, h: 0.6, d: 1.5, g: 0.9 });
  O(v, { w: 'sawtooth', f: 880 * p, f1: 1600 * p, tf: 1.5, lp: 2600, t: 0.05, a: 0.2, h: 0.5, d: 1.3, g: 0.02 });
  N(v, { c: 'crackle', ft: 'highpass', f: 1500, t: 0.03, a: 0.05, d: 1.4, g: 0.3 });
  N(v, { c: 'pink', ft: 'bandpass', f: 600, q: 0.5, t: 0.08, a: 0.2, d: 2.0, g: 0.45, wet: true });
}

function torpedo(v) {
  const p = rr(v, 0.93, 1.07);
  O(v, { f: 110 * p, f1: 55, d: 0.12, g: 0.7 });
  FM(v, { f: 180 * p, ratio: 1.6, idx: 1.3, d: 0.1, g: 0.14 });
  N(v, { c: 'white', ft: 'bandpass', f: 3000, f1: 1500, q: 0.7, a: 0.01, d: 0.28, g: 0.45 });
  N(v, { c: 'pink', ft: 'bandpass', f: 600, f1: 1800, tf: 0.2, q: 0.9, t: 0.12, a: 0.05, d: 0.4, g: 0.8 });
  N(v, { c: 'pink', ft: 'lowpass', f: 520, t: 0.15, a: 0.1, d: 0.9, g: 0.7 });
  O(v, { w: 'triangle', f: 95 * p, f1: 120 * p, tf: 1.0, t: 0.2, a: 0.2, d: 1.0, g: 0.12 });
  N(v, { c: 'pink', ft: 'bandpass', f: 700, q: 0.5, t: 0.1, a: 0.1, d: 1.0, g: 0.25, wet: true });
}

// ---- impacts -----------------------------------------------------------------------

const EXPLOSIONS = [
  { sub: [115, 42, 0.16, 0.26, 0.8], crack: [3200, 380, 0.1, 0.5], body: [2400, 170, 0.28, 1.5],
    debris: [0.35, 0.3], tail: [0.6, 0.34] },
  { sub: [95, 34, 0.25, 0.45, 1.0], crack: [2800, 300, 0.16, 0.6], body: [1900, 120, 0.5, 1.8],
    debris: [0.7, 0.36], tail: [1.1, 0.45] },
  { sub: [80, 28, 0.4, 0.8, 1.1], crack: [2400, 240, 0.22, 0.7], body: [1500, 90, 0.85, 2.0],
    debris: [1.2, 0.4], tail: [1.8, 0.55], rumble: [110, 1.2, 1.2] },
  { sub: [66, 22, 0.7, 1.5, 1.2], crack: [2000, 180, 0.3, 0.8], body: [1200, 60, 1.4, 2.2],
    debris: [2.0, 0.44], tail: [2.8, 0.65], rumble: [90, 2.4, 1.6], shock: true },
];

function explosion(v, S) {
  const p = rr(v, 0.9, 1.1);
  N(v, { c: 'white', ft: 'highpass', f: 5000, a: 0.0004, d: 0.012, g: 0.6 });
  N(v, { c: 'white', ft: 'bandpass', f: S.crack[0] * p, f1: S.crack[1] * p, q: 0.7, a: 0.0008, d: S.crack[2], g: S.crack[3] });
  N(v, { c: 'pink', ft: 'lowpass', f: S.body[0] * p, f1: S.body[1] * p, a: 0.002, d: S.body[2], g: S.body[3] });
  O(v, { f: S.sub[0] * p, f1: S.sub[1] * p, tf: S.sub[2], a: 0.002, d: S.sub[3], g: S.sub[4] });
  N(v, { c: 'crackle', ft: 'bandpass', f: 2600, f1: 900, q: 0.5, t: 0.06, a: 0.03, d: S.debris[0], g: S.debris[1] });
  N(v, { c: 'pink', ft: 'bandpass', f: 600, f1: 220, q: 0.5, t: 0.05, a: 0.05, d: S.tail[0], g: S.tail[1], wet: true });
  if (S.rumble) {
    N(v, { c: 'brown', ft: 'lowpass', f: S.rumble[0], t: 0.04, a: 0.08, d: S.rumble[1], g: S.rumble[2] });
  }
  if (S.shock) {
    // shock front arriving a beat later + a long sub drop
    N(v, { c: 'pink', ft: 'lowpass', f: 900, f1: 80, t: 0.11, a: 0.01, d: 1.1, g: 1.6 });
    N(v, { c: 'white', ft: 'bandpass', f: 500, f1: 3500, tf: 0.25, q: 0.8, t: 0.08, a: 0.12, d: 0.5, g: 0.2 });
    O(v, { f: 48, f1: 18, tf: 2.2, t: 0.1, a: 0.02, d: 2.4, g: 0.5 });
  }
}

function impactMetal(v) {
  const f1 = rr(v, 900, 1500);
  FM(v, { f: f1, ratio: 1.47, idx: 1.2, d: rr(v, 0.08, 0.18), g: 0.25 });
  FM(v, { f: f1 * 1.83, ratio: 2.1, idx: 1.0, d: 0.09, g: 0.15 });
  N(v, { c: 'white', ft: 'highpass', f: 4000, a: 0.0004, d: 0.012, g: 0.35 });
  O(v, { f: 220, f1: 120, d: 0.04, g: 0.2 });
  if (v.E.rng() < 0.25) {
    const a = rr(v, 2400, 3400);
    O(v, { f: a, f1: a * rr(v, 0.35, 0.5), tf: 0.22, t: 0.01, a: 0.005, d: 0.25, g: 0.07 });
  }
}

function impactDirt(v) {
  const p = rr(v, 0.88, 1.12);
  N(v, { c: 'pink', ft: 'lowpass', f: 700 * p, f1: 180, a: 0.001, d: 0.11, g: 1.4 });
  O(v, { f: 110 * p, f1: 55, d: 0.07, g: 0.4 });
  N(v, { c: 'crackle', ft: 'bandpass', f: 2200 * p, q: 0.8, t: 0.005, a: 0.005, d: 0.22, g: 0.5 });
}

function waterSplash(v) {
  const p = rr(v, 0.9, 1.1);
  O(v, { f: 140 * p, f1: 60, d: 0.1, g: 0.4 });
  N(v, { c: 'pink', ft: 'bandpass', f: 900 * p, f1: 2600 * p, tf: 0.12, q: 0.9, a: 0.012, d: 0.4, g: 1.2 });
  N(v, { c: 'white', ft: 'highpass', f: 3500, t: 0.02, a: 0.04, d: 0.55, g: 0.22 });
  N(v, { c: 'pink', ft: 'lowpass', f: 600, t: 0.03, a: 0.02, d: 0.5, g: 0.5 });
  N(v, { c: 'pink', ft: 'bandpass', f: 1500, q: 0.5, t: 0.05, a: 0.08, d: 0.6, g: 0.2, wet: true });
}

function buildingCollapse(v) {
  N(v, { c: 'white', ft: 'bandpass', f: 2600, f1: 300, tf: 0.15, q: 0.7, a: 0.001, d: 0.2, g: 0.6 });
  O(v, { f: 60, f1: 28, tf: 0.8, a: 0.01, d: 1.0, g: 0.7 });
  N(v, { c: 'brown', ft: 'lowpass', f: 140, a: 0.25, h: 1.0, d: 1.9, g: 2.2 });
  const n = 5 + Math.floor(v.E.rng() * 3);
  for (let i = 0; i < n; i++) {
    N(v, { c: 'pink', ft: 'bandpass', f: rr(v, 280, 1300), q: 0.7, t: rr(v, 0.05, 2.0),
      a: 0.004, d: rr(v, 0.12, 0.3), g: rr(v, 0.6, 1.2) });
  }
  N(v, { c: 'crackle', ft: 'bandpass', f: 1800, q: 0.5, t: 0.05, a: 0.1, h: 1.2, d: 1.6, g: 0.55 });
  N(v, { c: 'white', ft: 'highpass', f: 3000, t: 0.2, a: 0.5, h: 0.8, d: 1.6, g: 0.06 });
  N(v, { c: 'pink', ft: 'bandpass', f: 400, q: 0.5, t: 0.1, a: 0.3, h: 1.0, d: 2.2, g: 0.5, wet: true });
}

// ---- UI: tight, tactile, in key ------------------------------------------------------

function uiHover(v) {
  O(v, { f: A6, a: 0.002, d: 0.03, g: 0.05 });
  N(v, { c: 'white', ft: 'bandpass', f: 5200, q: 3, a: 0.0005, d: 0.008, g: 0.08 });
}

function uiClick(v) {
  O(v, { w: 'triangle', f: D6, f1: D6 * 0.96, a: 0.0008, d: 0.035, g: 0.14 });
  O(v, { f: 240, f1: 170, a: 0.0008, d: 0.03, g: 0.16 });
  N(v, { c: 'white', ft: 'highpass', f: 3500, a: 0.0003, d: 0.006, g: 0.12 });
}

function uiConfirm(v) {
  bell(v, A5, 0, 0.09, 0.12);
  bell(v, D6, 0.065, 0.18, 0.14);
  O(v, { f: 220, f1: 160, a: 0.0008, d: 0.03, g: 0.1 });
}

function uiBack(v) {
  bell(v, D6, 0, 0.07, 0.11);
  bell(v, A5, 0.06, 0.15, 0.12);
}

function uiDeny(v) {
  for (let i = 0; i < 2; i++) {
    O(v, { w: 'square', f: EB4, lp: 1100, t: i * 0.1, a: 0.003, h: 0.05, d: 0.03, g: 0.08 });
    O(v, { w: 'square', f: D4, lp: 1100, t: i * 0.1, a: 0.003, h: 0.05, d: 0.03, g: 0.08 });
  }
}

function uiTab(v) {
  O(v, { w: 'triangle', f: FS5, f1: A5, tf: 0.03, a: 0.001, d: 0.045, g: 0.12 });
  tick(v, 0, 0.08, 4200);
}

function uiOpen(v) {
  N(v, { c: 'pink', ft: 'bandpass', f: 600, f1: 3200, q: 1.4, a: 0.02, d: 0.12, g: 0.3 });
  bell(v, D5, 0, 0.1, 0.06);
  bell(v, A5, 0.05, 0.14, 0.08);
}

function uiClose(v) {
  N(v, { c: 'pink', ft: 'bandpass', f: 3200, f1: 600, q: 1.4, a: 0.01, d: 0.12, g: 0.3 });
  bell(v, A5, 0, 0.08, 0.07);
  bell(v, D5, 0.05, 0.12, 0.06);
}

// ---- world / command feedback ----------------------------------------------------------

function selectUnit(v) {
  const f = v.E.rng() < 0.3 ? A5 : D5;
  O(v, { f, a: 0.001, d: 0.045, g: 0.09 });
  tick(v, 0, 0.07, 2800);
}

function selectVehicle(v) {
  O(v, { f: A3, f1: 200, a: 0.001, d: 0.06, g: 0.14 });
  FM(v, { f: 880, ratio: 1.5, idx: 1, d: 0.04, g: 0.05 });
  N(v, { c: 'white', ft: 'lowpass', f: 1200, a: 0.0006, d: 0.02, g: 0.1 });
}

function selectAir(v) {
  N(v, { c: 'pink', ft: 'bandpass', f: 1500, f1: 4200, q: 2, a: 0.008, d: 0.07, g: 0.25 });
  O(v, { f: A5, f1: D6, tf: 0.05, a: 0.002, d: 0.06, g: 0.08 });
}

function orderMove(v) {
  O(v, { w: 'triangle', f: D5, a: 0.001, d: 0.04, g: 0.11 });
  O(v, { w: 'triangle', f: A5, t: 0.05, a: 0.001, d: 0.06, g: 0.12 });
  tick(v, 0, 0.05, 3200);
}

function orderAttack(v) {
  O(v, { w: 'sawtooth', f: EB5, lp: 2400, a: 0.001, d: 0.045, g: 0.08 });
  O(v, { w: 'sawtooth', f: D5, lp: 2400, t: 0.055, a: 0.001, d: 0.08, g: 0.09 });
  N(v, { c: 'white', ft: 'bandpass', f: 2000, q: 1, a: 0.0005, d: 0.02, g: 0.12 });
  O(v, { f: 160, f1: 90, a: 0.001, d: 0.05, g: 0.12 });
}

function placeStructure(v) {
  O(v, { f: 130, f1: 48, a: 0.002, d: 0.16, g: 0.5 });
  N(v, { c: 'pink', ft: 'lowpass', f: 600, f1: 150, a: 0.001, d: 0.14, g: 0.8 });
  FM(v, { f: rr(v, 680, 760), ratio: 1.71, idx: 1.3, d: 0.12, g: 0.1 });
  N(v, { c: 'pink', ft: 'bandpass', f: 1500, q: 0.6, t: 0.02, a: 0.03, d: 0.3, g: 0.14 });
}

function constructionDone(v) {
  bell(v, D5, 0, 0.14, 0.11);
  bell(v, FS5, 0.09, 0.14, 0.11);
  bell(v, A5, 0.18, 0.16, 0.12);
  bell(v, D6, 0.27, 0.45, 0.13);
  O(v, { f: 150, f1: 70, a: 0.002, d: 0.12, g: 0.25 });
  N(v, { c: 'white', ft: 'highpass', f: 6000, t: 0.27, a: 0.05, d: 0.3, g: 0.03 });
}

function unitReady(v) {
  N(v, { c: 'white', ft: 'bandpass', f: 2400, q: 1.2, a: 0.001, d: 0.03, g: 0.12 });
  O(v, { w: 'square', f: A4, lp: 1800, t: 0.03, a: 0.003, h: 0.04, d: 0.04, g: 0.07 });
  O(v, { w: 'square', f: D5, lp: 1800, t: 0.11, a: 0.003, h: 0.06, d: 0.08, g: 0.08 });
  tick(v, 0.27, 0.06, 2600);
}

function credits(v) {
  bell(v, FS6, 0, 0.05, 0.05);
  bell(v, A6, 0.03, 0.07, 0.04);
}

function lowPower(v) {
  O(v, { w: 'sawtooth', f: 240, f1: 60, tf: 0.7, lp: 900, lp1: 200, a: 0.01, h: 0.2, d: 0.6, g: 0.18 });
  O(v, { w: 'square', f: D4, lp: 1200, t: 0, a: 0.004, h: 0.07, d: 0.04, g: 0.07 });
  O(v, { w: 'square', f: D4, lp: 1200, t: 0.22, a: 0.004, h: 0.07, d: 0.04, g: 0.07 });
}

function sell(v) {
  bell(v, A6, 0, 0.06, 0.07);
  bell(v, FS6, 0.05, 0.06, 0.07);
  bell(v, D6, 0.1, 0.18, 0.08);
  N(v, { c: 'white', ft: 'highpass', f: 3000, a: 0.0005, d: 0.02, g: 0.12 });
  N(v, { c: 'pink', ft: 'bandpass', f: 2400, f1: 500, q: 1, t: 0.02, a: 0.01, d: 0.2, g: 0.2 });
}

function repair(v) {
  for (let i = 0; i < 3; i++) {
    FM(v, { f: rr(v, 1700, 2300), ratio: 1.6, idx: 1.2, t: i * 0.07, d: 0.03, g: 0.1 });
    N(v, { c: 'white', ft: 'highpass', f: 4000, t: i * 0.07, a: 0.0004, d: 0.008, g: 0.1 });
  }
  // welding fizz: noise chopped at mains rate
  const g = N(v, { c: 'white', ft: 'highpass', f: 3800, t: 0.2, a: 0.02, d: 0.25, g: 0.1 });
  const lfo = v.ctx.createOscillator(), lg = v.ctx.createGain(), am = v.ctx.createGain();
  lfo.type = 'square'; lfo.frequency.value = 60;
  lg.gain.value = 0.5; am.gain.value = 0.5;
  lfo.connect(lg); lg.connect(am.gain);
  g.disconnect(); g.connect(am); am.connect(v.in);
  lfo.start(v.t + 0.2); lfo.stop(v.t + 0.55);
  v.own.push(lfo);
  v.E.count(3);
}

function buildQueued(v) {
  bell(v, D5, 0, 0.07, 0.1);
  bell(v, A5, 0.06, 0.12, 0.11);
  FM(v, { f: 1900, ratio: 1.6, idx: 1.1, t: 0.01, d: 0.03, g: 0.05 });
}

function siren(v) {
  const t0 = v.t;
  const mk = (w, mult, g) => {
    const osc = O(v, { w, f: A4 * mult, lp: 1700, q: 2, env: [[0.03, 1], [0.92, 1], [1.05, 0]], g });
    const f = osc.frequency;
    f.cancelScheduledValues(t0);
    f.setValueAtTime(A4 * mult, t0);
    f.linearRampToValueAtTime(D5 * mult, t0 + 0.26);
    f.linearRampToValueAtTime(A4 * mult, t0 + 0.52);
    f.linearRampToValueAtTime(D5 * mult, t0 + 0.78);
    f.linearRampToValueAtTime(A4 * mult, t0 + 1.05);
  };
  mk('sawtooth', 1, 0.14);
  mk('square', 0.5, 0.05);
}

function victorySfx(v) {
  const note = (f, t, d, g) => {
    O(v, { w: 'sawtooth', f, lp: 900, lp1: 2600, tf: 0.05, q: 1, t, a: 0.012, h: d, d: 0.12, g });
    O(v, { w: 'sawtooth', f: f * 1.004, lp: 2200, t, a: 0.012, h: d, d: 0.12, g: g * 0.7 });
  };
  note(D4, 0, 0.1, 0.1);
  note(A4, 0.15, 0.1, 0.1);
  note(D5, 0.3, 0.6, 0.11);
  note(FS5, 0.3, 0.6, 0.08);
  note(A4, 0.3, 0.6, 0.07);
  O(v, { f: 110, f1: 45, t: 0.3, a: 0.002, d: 0.5, g: 0.4 });
  N(v, { c: 'white', ft: 'highpass', f: 5000, t: 0.3, a: 0.01, d: 0.8, g: 0.05 });
  N(v, { c: 'pink', ft: 'bandpass', f: 800, q: 0.5, t: 0.3, a: 0.05, d: 1.2, g: 0.2, wet: true });
}

function defeatSfx(v) {
  const note = (f, t, d, g) => {
    O(v, { w: 'sawtooth', f, lp: 950, q: 1, t, a: 0.03, h: d, d: 0.2, g });
    O(v, { w: 'sawtooth', f: f * 0.5, lp: 600, t, a: 0.03, h: d, d: 0.2, g: g * 0.8 });
  };
  note(G4, 0, 0.22, 0.1);
  note(FS4, 0.3, 0.22, 0.1);
  note(EB4, 0.6, 0.22, 0.1);
  note(D4, 0.9, 0.7, 0.11);
  O(v, { f: 70, f1: 35, t: 0.9, a: 0.004, d: 0.9, g: 0.4 });
  N(v, { c: 'pink', ft: 'bandpass', f: 500, q: 0.5, t: 0.9, a: 0.08, d: 1.4, g: 0.2, wet: true });
}

function flyby(v) {
  const p = rr(v, 0.9, 1.1);
  const bellEnv = [[0.45, 0.12], [0.85, 0.7], [1.0, 1], [1.2, 0.6], [1.7, 0.16], [2.2, 0]];
  // doppler: band and whine sit high on approach and drop through the pass
  const dop = (a, b) => [[0.8, a], [1.15, b], [2.2, b * 0.85]];
  N(v, { c: 'pink', ft: 'bandpass', f: 1700 * p, fp: dop(1600 * p, 620 * p), q: 0.8, env: bellEnv, g: 1.5 });
  N(v, { c: 'brown', ft: 'lowpass', f: 320, env: bellEnv, g: 1.3 });
  N(v, { c: 'white', ft: 'highpass', f: 4200, env: bellEnv, g: 0.14 });
  O(v, { w: 'sawtooth', f: 2700 * p, fp: dop(2600 * p, 1500 * p), lp: 3600, env: bellEnv, g: 0.025 });
  N(v, { c: 'pink', ft: 'bandpass', f: 700, q: 0.5, t: 0.6, a: 0.4, d: 1.6, g: 0.3, wet: true });
}

function cineWhoosh(v) {
  const e = [[0.35, 0.2], [0.55, 1], [0.75, 0.3], [1.1, 0]];
  N(v, { c: 'pink', ft: 'bandpass', f: 300, fp: [[0.55, 3800], [1.1, 700]], q: 1.2, env: e, g: 1.3 });
  N(v, { c: 'white', ft: 'highpass', f: 5000, env: e, g: 0.1 });
  O(v, { f: 60, f1: 95, tf: 0.55, env: e, g: 0.3 });
  N(v, { c: 'pink', ft: 'bandpass', f: 1200, q: 0.5, t: 0.3, a: 0.2, d: 0.9, g: 0.25, wet: true });
}

function cineHit(v) {
  O(v, { f: 62, f1: 27, tf: 0.5, a: 0.003, d: 1.9, g: 1.0 });
  N(v, { c: 'pink', ft: 'lowpass', f: 2600, f1: 150, tf: 0.35, a: 0.001, d: 0.5, g: 1.8 });
  N(v, { c: 'white', ft: 'highpass', f: 3000, a: 0.0004, d: 0.03, g: 0.5 });
  const brass = (f, g) => O(v, { w: 'sawtooth', f, lp: 950, lp1: 240, tf: 1.2, q: 1, a: 0.01, h: 0.25, d: 1.3, g });
  brass(73.42, 0.2); brass(146.83 * 1.003, 0.16); brass(110, 0.12);
  FM(v, { f: 196, ratio: 1.41, idx: 1.4, d: 1.2, g: 0.07 });
  N(v, { c: 'pink', ft: 'bandpass', f: 400, q: 0.5, t: 0.04, a: 0.05, d: 2.4, g: 0.8, wet: true });
}

function cineRiser(v) {
  const T = 2.5;
  const rise = [[T * 0.4, 0.08], [T * 0.75, 0.35], [T, 1], [T + 0.03, 0]];
  const g = N(v, { c: 'white', ft: 'bandpass', f: 400, f1: 7000, tf: T, q: 2.5, env: rise, g: 0.6 });
  // accelerating tremolo on the noise
  const ctx = v.ctx;
  const lfo = ctx.createOscillator(), lg = ctx.createGain(), am = ctx.createGain();
  lfo.frequency.setValueAtTime(6, v.t);
  lfo.frequency.exponentialRampToValueAtTime(19, v.t + T);
  lg.gain.value = 0.35; am.gain.value = 0.65;
  lfo.connect(lg); lg.connect(am.gain);
  g.disconnect(); g.connect(am); am.connect(v.in);
  lfo.start(v.t); lfo.stop(v.t + T + 0.1);
  v.own.push(lfo);
  v.E.count(3);
  const tone = (f, m, gn) => O(v, { w: 'sawtooth', f, f1: f * m, tf: T, lp: 600, lp1: 5200, env: rise, g: gn });
  tone(D4, 2, 0.05); tone(D4 * 1.01, 2.02, 0.05); tone(A4, 2, 0.04);
  O(v, { f: 40, f1: 82, tf: T, env: rise, g: 0.3 });
  N(v, { c: 'pink', ft: 'bandpass', f: 2000, q: 0.5, t: T * 0.5, a: T * 0.5, d: 0.6, g: 0.2, wet: true });
}

function ambRumble(v) {
  N(v, { c: 'brown', ft: 'lowpass', f: 260, f1: 70, tf: 1.4, a: 0.25, d: 1.8, g: 2.4 });
  O(v, { f: 52, f1: 30, tf: 1.2, a: 0.1, d: 1.4, g: 0.6 });
  N(v, { c: 'pink', ft: 'bandpass', f: 300, q: 0.5, t: 0.1, a: 0.3, d: 1.8, g: 0.6, wet: true });
}

// ---- table --------------------------------------------------------------------------

export const SFX = {};

// alias: bake / share buffers with another entry (legacy names)
function def(name, cat, prio, lvl, send, gap, fn, duck, alias) {
  SFX[name] = { cat, prio, lvl, send, gap, fn, duck: duck || null, alias: alias || null, pan: null };
}

// UI
def('ui_hover', 'ui', 9, 1, 0, 0.03, uiHover);
def('ui_click', 'ui', 9, 1, 0, 0.03, uiClick);
def('ui_confirm', 'ui', 9, 1, 0, 0.05, uiConfirm);
def('ui_back', 'ui', 9, 1, 0, 0.05, uiBack);
def('ui_deny', 'ui', 9, 1, 0, 0.12, uiDeny);
def('ui_tab', 'ui', 9, 1, 0, 0.04, uiTab);
def('ui_open', 'ui', 9, 1, 0, 0.08, uiOpen);
def('ui_close', 'ui', 9, 1, 0, 0.08, uiClose);
// weapons
def('rifle', 'light', 2, 1, 0.22, 0.03, rifle);
def('mg', 'light', 2, 1, 0.22, 0.12, mg);
def('autocannon', 'light', 3, 1, 0.24, 0.15, autocannon);
def('aa_gun', 'light', 3, 1, 0.24, 0.15, aaGun);
def('cannon', 'heavy', 4, 1, 0.3, 0.05, cannon);
def('heavy_cannon', 'heavy', 5, 1, 0.34, 0.08, heavyCannon, [2, 0.25, 0.5]);
def('atgm', 'heavy', 4, 1, 0.28, 0.06, atgm);
def('rocket', 'heavy', 4, 1, 0.28, 0.05, rocket);
def('mlrs', 'heavy', 5, 1, 0.3, 0.25, mlrs, [2, 0.6, 0.6]);
def('sam', 'heavy', 5, 1, 0.3, 0.1, sam);
def('bomb', 'heavy', 5, 1, 0.3, 0.1, bomb);
def('cruise', 'heavy', 5, 1, 0.32, 0.2, cruise, [2, 0.5, 0.6]);
def('naval_gun', 'heavy', 5, 1, 0.36, 0.08, navalGun, [2, 0.25, 0.5]);
def('torpedo', 'heavy', 4, 1, 0.3, 0.1, torpedo);
// impacts
def('explosion_small', 'impact', 3, 1, 0.26, 0.04, (v) => explosion(v, EXPLOSIONS[0]));
def('explosion_medium', 'impact', 4, 1, 0.3, 0.05, (v) => explosion(v, EXPLOSIONS[1]), [1.5, 0.2, 0.5]);
def('explosion_large', 'impact', 6, 1, 0.34, 0.08, (v) => explosion(v, EXPLOSIONS[2]), [3.5, 0.5, 0.8]);
def('explosion_huge', 'impact', 7, 1, 0.4, 0.15, (v) => explosion(v, EXPLOSIONS[3]), [6, 1.3, 1.4]);
def('impact_metal', 'impact', 1, 1, 0.2, 0.03, impactMetal);
def('impact_dirt', 'impact', 1, 1, 0.2, 0.03, impactDirt);
def('water_splash', 'impact', 2, 1, 0.26, 0.04, waterSplash);
def('building_collapse', 'impact', 7, 1, 0.36, 0.3, buildingCollapse, [4, 1.2, 1.2]);
// world / command feedback (dry-ish, centred when played through playSfx)
def('place_structure', 'world', 6, 1, 0.14, 0.08, placeStructure);
def('construction_done', 'world', 6, 1, 0.12, 0.2, constructionDone);
def('unit_ready', 'world', 6, 1, 0.08, 0.15, unitReady);
def('select_unit', 'ui', 8, 1, 0, 0.04, selectUnit);
def('select_vehicle', 'ui', 8, 1, 0, 0.04, selectVehicle);
def('select_air', 'ui', 8, 1, 0, 0.04, selectAir);
def('order_move', 'ui', 8, 1, 0, 0.04, orderMove);
def('order_attack', 'ui', 8, 1, 0, 0.04, orderAttack);
def('credits', 'ui', 7, 1, 0, 0.05, credits);
def('low_power', 'world', 6, 1, 0.1, 0.5, lowPower);
def('sell', 'world', 6, 1, 0.1, 0.1, sell);
def('repair', 'world', 5, 1, 0.12, 0.2, repair);
def('flyby', 'world', 5, 1, 0.3, 0.3, flyby);
def('cinematic_whoosh', 'cine', 8, 1, 0.3, 0.1, cineWhoosh);
def('cinematic_hit', 'cine', 8, 1, 0.45, 0.15, cineHit, [5, 0.8, 1.2]);
def('cinematic_riser', 'cine', 8, 1, 0.3, 0.3, cineRiser);
// legacy names (v0.3.7 API): same meaning, new sound
def('move', 'ui', 8, 1, 0, 0.04, orderMove, null, 'order_move');
def('attack', 'ui', 8, 1, 0, 0.04, orderAttack, null, 'order_attack');
def('select', 'ui', 8, 1, 0, 0.04, selectUnit, null, 'select_unit');
def('build', 'ui', 8, 1, 0, 0.05, buildQueued);
def('error', 'ui', 9, 1, 0, 0.12, uiDeny, null, 'ui_deny');
def('click', 'ui', 9, 1, 0, 0.03, uiClick, null, 'ui_click');
def('siren', 'world', 7, 1, 0.16, 0.5, siren, [2, 0.9, 0.6]);
def('victory', 'cine', 8, 1, 0.3, 0.5, victorySfx);
def('defeat', 'cine', 8, 1, 0.3, 0.5, defeatSfx);
def('shot', 'light', 2, 1, 0.22, 0.03, rifle, null, 'rifle');
def('boom', 'impact', 4, 1, 0.3, 0.05, (v) => explosion(v, EXPLOSIONS[1]), [1.5, 0.2, 0.5], 'explosion_medium');
// internal: far-off rumble for the ambience bed
def('amb_rumble', 'world', 1, 1, 0.5, 5, ambRumble);

SFX.flyby.pan = flybyPan;
SFX.cinematic_whoosh.pan = whooshPan;

export const SFX_GROUPS = {
  ui: ['ui_hover', 'ui_click', 'ui_confirm', 'ui_back', 'ui_deny', 'ui_tab', 'ui_open', 'ui_close'],
  weapons: ['rifle', 'mg', 'autocannon', 'cannon', 'heavy_cannon', 'atgm', 'rocket', 'mlrs',
    'sam', 'aa_gun', 'bomb', 'cruise', 'naval_gun', 'torpedo'],
  impacts: ['explosion_small', 'explosion_medium', 'explosion_large', 'explosion_huge',
    'impact_metal', 'impact_dirt', 'water_splash', 'building_collapse'],
  world: ['place_structure', 'construction_done', 'unit_ready', 'select_unit', 'select_vehicle',
    'select_air', 'order_move', 'order_attack', 'credits', 'low_power', 'sell', 'repair',
    'flyby', 'cinematic_whoosh', 'cinematic_hit', 'cinematic_riser'],
  legacy: ['move', 'attack', 'select', 'build', 'error', 'siren', 'victory', 'defeat', 'shot',
    'boom', 'click'],
};
