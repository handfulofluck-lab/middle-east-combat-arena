// Pure DSP helpers for the MCA audio engine. Nothing in here touches the Web
// Audio API: every function works on plain Float32Arrays, so the same code
// runs under AudioContext, OfflineAudioContext and plain Node (analysis).
//
// Contents: seeded PRNG, RBJ biquads, coloured noise (loop-seamless), debris
// crackle, procedural reverb impulse responses, extended Karplus-Strong
// plucked strings (oud / qanun / bass) and a synthesised percussion kit
// (darbuka dum/tek/ka, frame drum, riq, taiko, cinematic boom, timpani...).

export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function midiHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// ---- biquads (RBJ cookbook), direct form I, in place ---------------------------

export function biquadCoefs(type, f, q, sr, gainDb) {
  const w = 2 * Math.PI * Math.max(1, Math.min(f, sr * 0.49)) / sr;
  const cs = Math.cos(w), sn = Math.sin(w);
  const al = sn / (2 * Math.max(0.05, q));
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
  } else if (type === 'highpass') {
    b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
  } else if (type === 'bandpass') {
    b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
  } else if (type === 'peaking') {
    const A = Math.pow(10, (gainDb || 0) / 40);
    b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A;
    a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
  } else if (type === 'highshelf') {
    const A = Math.pow(10, (gainDb || 0) / 40);
    const k = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) + (A - 1) * cs + k);
    b1 = -2 * A * ((A - 1) + (A + 1) * cs);
    b2 = A * ((A + 1) + (A - 1) * cs - k);
    a0 = (A + 1) - (A - 1) * cs + k;
    a1 = 2 * ((A - 1) - (A + 1) * cs);
    a2 = (A + 1) - (A - 1) * cs - k;
  } else {
    return [1, 0, 0, 0, 0];
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

export function biquadInPlace(x, type, f, q, sr, gainDb) {
  const c = biquadCoefs(type, f, q, sr, gainDb);
  const b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

// ---- noise ----------------------------------------------------------------------

// Fills `out` with white / pink / brown noise. The buffer loops seamlessly:
// F extra samples are generated past the end and cross-faded into the head,
// so a looping AudioBufferSourceNode never clicks at the wrap point.
export function fillNoise(out, rng, color) {
  const n = out.length;
  const F = Math.min(2048, n >> 2);
  const gen = new Float32Array(n + F);
  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < gen.length; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      gen[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.12;
      b6 = w * 0.115926;
    }
  } else if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < gen.length; i++) {
      const w = rng() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      gen[i] = last * 3.2;
    }
  } else {
    for (let i = 0; i < gen.length; i++) gen[i] = (rng() * 2 - 1) * 0.7;
  }
  let mean = 0;
  for (let i = 0; i < gen.length; i++) mean += gen[i];
  mean /= gen.length;
  for (let i = 0; i < n; i++) out[i] = gen[i] - mean;
  for (let i = 0; i < F; i++) {
    const w = i / F;
    out[i] = (gen[i] - mean) * Math.sqrt(w) + (gen[n + i] - mean) * Math.sqrt(1 - w);
  }
  return out;
}

// Sparse random micro-bursts (debris, fire pops, tank-track clatter). Events
// never straddle the end, so the buffer can loop.
export function renderCrackle(sr, dur, rng, density) {
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  let t = 0;
  for (;;) {
    t += -Math.log(1 - rng() * 0.9999) / density;
    const idx = Math.floor(t * sr);
    if (idx >= n - 400) break;
    const amp = (0.08 + Math.pow(rng(), 2.2) * 0.92) * (rng() < 0.5 ? 1 : -1);
    const len = 10 + Math.floor(rng() * rng() * 260);
    const tone = 0.15 + rng() * 0.85;
    let lp = 0;
    for (let j = 0; j < len; j++) {
      lp += tone * ((rng() * 2 - 1) - lp);
      const a = j < 3 ? (j + 1) / 4 : Math.exp(-5 * j / len);
      out[idx + j] += amp * lp * a;
    }
  }
  return out;
}

// ---- reverb impulse responses ---------------------------------------------------

// Exponentially decaying stereo noise with time-varying damping (highs die
// first), optional discrete early reflections, a low cut so the tail never
// muddies the mix, and a faded end. o: { dur, t60, predelay, bright (0..1
// initial one-pole coefficient), dampTime (s), floor (final brightness),
// lowCut (Hz), early: [{ t, g, pan }] }
export function renderImpulse(sr, o, rng) {
  const n = Math.floor(sr * o.dur);
  const chans = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const d = chans[ch];
    const pre = Math.floor((o.predelay + ch * 0.0009) * sr);
    let lp = 0, env = 1, dk = o.bright - o.floor;
    const kEnv = Math.pow(10, -3 / (o.t60 * sr)), kDamp = Math.exp(-1 / (o.dampTime * sr));
    const build = Math.max(1, Math.floor(0.004 * sr));
    for (let i = pre; i < n; i++) {
      const k = Math.min(1, o.floor + dk);
      lp += k * ((rng() * 2 - 1) - lp);
      // short build-up so the tail does not start with a hard edge
      const j = i - pre;
      d[i] = lp * env * (j < build ? j / build : 1) / Math.sqrt(k);
      env *= kEnv; dk *= kDamp;
    }
    const early = o.early || [];
    for (let e = 0; e < early.length; e++) {
      const er = early[e];
      const g = er.g * (ch === 0 ? 1 - Math.max(0, er.pan) : 1 + Math.min(0, er.pan));
      const idx = Math.floor((er.t + ch * 0.0004 * (e + 1)) * sr);
      // each reflection is a tiny smeared burst, not a single-sample spike
      for (let j = 0; j < 24 && idx + j < n; j++) {
        d[idx + j] += g * (rng() * 2 - 1) * Math.exp(-j / 6) * 3;
      }
    }
    biquadInPlace(d, 'highpass', o.lowCut || 200, 0.707, sr);
    const fade = Math.floor(n * 0.12);
    for (let i = 0; i < fade; i++) d[n - 1 - i] *= i / fade;
  }
  return chans;
}

// ---- Karplus-Strong plucked strings --------------------------------------------

const PLUCK_PRESETS = {
  // oud: double courses, warm body, quick decay
  oud: {
    t60: [2.1, 1.0], damp: [0.30, 0.15], bright: 0.55, pick: 0.21, courses: 2,
    detune: 5, strike: 0.004, maxDur: 2.2, attack: 0.14,
    body: [[105, 3, 0.55], [215, 4, 0.4], [440, 5, 0.22]], lp: 5200,
  },
  // qanun: triple courses, bright, long ring
  qanun: {
    t60: [2.8, 1.5], damp: [0.14, 0.07], bright: 0.92, pick: 0.11, courses: 3,
    detune: 4, strike: 0.0025, maxDur: 2.8, attack: 0.09,
    body: [[310, 2, 0.25], [1250, 2, 0.2]], lp: 9000,
  },
  // low pizzicato / bass oud string for bass lines
  bass: {
    t60: [1.9, 1.1], damp: [0.44, 0.34], bright: 0.34, pick: 0.3, courses: 1,
    detune: 0, strike: 0, maxDur: 1.8, attack: 0.05,
    body: [[80, 2, 0.5], [160, 3, 0.3]], lp: 2400,
  },
};

function ksString(out, sr, f, p, rng, gain, offset, t60, damp) {
  const n = out.length;
  const period = sr / f;
  let N = Math.floor(period - damp - 0.08);
  if (N < 2) N = 2;
  const frac = period - damp - N; // 0.08 .. 1.08 — fractional delay via allpass
  const C = (1 - frac) / (1 + frac);
  const g = Math.pow(0.001, 1 / (f * t60));
  const line = new Float32Array(N);
  let lp = 0, mean = 0;
  for (let i = 0; i < N; i++) {
    lp += p.bright * ((rng() * 2 - 1) - lp);
    line[i] = lp;
    mean += lp;
  }
  mean /= N;
  for (let i = 0; i < N; i++) line[i] -= mean;
  // pick-position comb: notch the harmonics that have a node under the plectrum
  const pp = Math.max(1, Math.round(N * p.pick));
  const tmp = new Float32Array(N);
  for (let i = 0; i < N; i++) tmp[i] = line[i] - line[(i + pp) % N] * 0.9;
  line.set(tmp);
  let idx = 0, prev = 0, apX = 0, apY = 0;
  for (let i = offset; i < n; i++) {
    const x = line[idx];
    out[i] += x * gain;
    const l = (1 - damp) * x + damp * prev;
    prev = x;
    const ap = C * l + apX - C * apY;
    apX = l; apY = ap;
    line[idx] = ap * g;
    idx++;
    if (idx >= N) idx = 0;
  }
}

// kind: 'oud' | 'qanun' | 'bass'; short = damped (ostinato / staccato)
// variant. Returns a mono Float32Array, peak ~0.85, starting and ending at
// zero and cut off once the string has decayed below about -48 dB (every
// sounding buffer is a live node in the graph, so tails are kept honest).
export function renderPluck(sr, midi, kind, rng, short) {
  const p = PLUCK_PRESETS[kind] || PLUCK_PRESETS.oud;
  const f = midiHz(midi);
  const u = Math.max(0, Math.min(1, (midi - 38) / 48)); // D2 .. D6
  const t60 = (p.t60[0] + (p.t60[1] - p.t60[0]) * u) * (short ? 0.4 : 1);
  const damp = p.damp[0] + (p.damp[1] - p.damp[0]) * u;
  const dur = Math.min(p.maxDur, t60 * 0.9);
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  for (let c = 0; c < p.courses; c++) {
    const cents = p.courses === 1 ? 0 : (c - (p.courses - 1) / 2) * p.detune;
    const off = Math.floor(c * p.strike * sr * (0.6 + rng() * 0.8));
    ksString(out, sr, f * Math.pow(2, cents / 1200), p, rng, 1 / p.courses, off, t60, damp);
  }
  // plectrum (risha) noise: a few ms of band-limited click
  const an = Math.floor(sr * 0.012);
  const click = new Float32Array(an);
  for (let i = 0; i < an; i++) click[i] = (rng() * 2 - 1) * Math.exp(-i / (sr * 0.0025));
  biquadInPlace(click, 'bandpass', 2400, 0.8, sr);
  for (let i = 0; i < an; i++) out[i] += click[i] * p.attack;
  // body resonances (parallel band-passes mixed under the dry string)
  if (p.body) {
    const dry = out.slice();
    for (const b of p.body) {
      const band = biquadInPlace(dry.slice(), 'bandpass', b[0], b[1], sr);
      for (let i = 0; i < n; i++) out[i] += band[i] * b[2];
    }
  }
  biquadInPlace(out, 'lowpass', p.lp, 0.707, sr);
  biquadInPlace(out, 'highpass', 30, 0.707, sr);
  return finishShot(cutTail(out, sr, 0.004), sr, 0.85, 0.0006, 0.04);
}

// drop everything after the last sample above `floor` x peak (+ 40 ms)
function cutTail(out, sr, floor) {
  let mx = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > mx) mx = a; }
  const thr = mx * floor;
  let last = out.length - 1;
  while (last > 64 && Math.abs(out[last]) < thr) last--;
  const n = Math.min(out.length, last + Math.floor(sr * 0.04));
  return n < out.length ? out.subarray(0, n) : out;
}

// normalise + fade in/out so a one-shot always starts and ends at exactly 0
function finishShot(out, sr, peak, fadeIn, fadeOut) {
  const n = out.length;
  let mx = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(out[i]); if (a > mx) mx = a; }
  const k = mx > 1e-9 ? peak / mx : 0;
  const fi = Math.max(1, Math.floor(sr * fadeIn));
  const fo = Math.max(1, Math.floor(sr * fadeOut));
  for (let i = 0; i < n; i++) {
    let g = k;
    if (i < fi) g *= i / fi;
    if (i >= n - fo) g *= (n - 1 - i) / fo;
    out[i] *= g;
  }
  return out;
}

// ---- percussion kit ---------------------------------------------------------------

function addSweep(out, sr, o) {
  const i0 = Math.floor((o.at || 0) * sr);
  const atk = Math.max(1, Math.floor((o.attack || 0.0008) * sr));
  const ka = Math.exp(-1 / (sr * o.ta)), kf = Math.exp(-1 / (sr * o.tf));
  const w = 2 * Math.PI / sr;
  let ph = 0, a = o.amp, df = o.f0 - o.f1;
  for (let i = i0; i < out.length; i++) {
    if (a < 1e-5) break;
    ph += w * (o.f1 + df);
    const k = i - i0;
    out[i] += Math.sin(ph) * (k < atk ? a * k / atk : a);
    a *= ka; df *= kf;
  }
}

function addBurst(out, sr, rng, o) {
  const i0 = Math.floor((o.at || 0) * sr);
  const len = Math.min(out.length - i0, Math.floor(sr * o.tau * 9));
  if (len <= 0) return;
  const tmp = new Float32Array(len);
  const atk = o.attack || 0.0005;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    tmp[i] = (rng() * 2 - 1) * Math.exp(-t / o.tau) * Math.min(1, t / atk);
  }
  biquadInPlace(tmp, o.type, o.f, o.q || 0.707, sr);
  for (let i = 0; i < len; i++) out[i0 + i] += tmp[i] * o.amp;
}

// decaying sine partials as two-pole resonators (no per-sample sin/exp)
function addModes(out, sr, modes, scaleF, scaleT, rng) {
  for (const m of modes) {
    const f = m[0] * scaleF, tau = m[2] * scaleT;
    const w = 2 * Math.PI * f / sr;
    const r = Math.exp(-1 / (sr * tau));
    const c1 = 2 * r * Math.cos(w), c2 = -r * r;
    const ph0 = rng ? rng() * 0.5 : 0;
    const len = Math.min(out.length, Math.floor(sr * tau * 9));
    const atk = Math.max(2, Math.floor(sr * 0.0006));
    let y1 = Math.sin(ph0 - w) / r, y2 = Math.sin(ph0 - 2 * w) / (r * r);
    for (let i = 0; i < len; i++) {
      const y = c1 * y1 + c2 * y2;
      y2 = y1; y1 = y;
      out[i] += y * m[1] * (i < atk ? i / atk : 1);
    }
  }
}

function drive(out, k) {
  const norm = Math.tanh(k);
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * k) / norm;
}

const TEK_MODES = [[640, 0.25, 0.035], [1180, 0.5, 0.05], [1900, 0.35, 0.04],
  [2850, 0.3, 0.03], [4300, 0.2, 0.02]];

export const DRUM_NAMES = ['dum', 'tek', 'ka', 'slap', 'frame', 'frame_tak', 'riq',
  'taiko', 'clack', 'boom', 'timp', 'snare', 'tick', 'cym', 'gong', 'shaker', 'shaker_l', 'swell'];

// Returns a mono Float32Array one-shot, peak 0.9, zero at both ends.
export function renderDrum(sr, kind, rng) {
  let out;
  const mk = (sec) => { out = new Float32Array(Math.floor(sr * sec)); };
  switch (kind) {
    case 'dum':
      mk(0.6);
      addSweep(out, sr, { f0: 150, f1: 86, tf: 0.02, ta: 0.13, amp: 1 });
      addSweep(out, sr, { f0: 260, f1: 182, tf: 0.015, ta: 0.055, amp: 0.25 });
      addBurst(out, sr, rng, { type: 'lowpass', f: 900, tau: 0.006, amp: 0.55 });
      break;
    case 'tek':
      mk(0.24);
      addModes(out, sr, TEK_MODES, 1, 1, rng);
      addBurst(out, sr, rng, { type: 'highpass', f: 3000, tau: 0.008, amp: 0.6 });
      break;
    case 'ka':
      mk(0.18);
      addModes(out, sr, TEK_MODES, 0.88, 0.65, rng);
      addBurst(out, sr, rng, { type: 'bandpass', f: 2500, q: 0.9, tau: 0.006, amp: 0.7 });
      break;
    case 'slap':
      mk(0.16);
      addBurst(out, sr, rng, { type: 'bandpass', f: 1600, q: 0.8, tau: 0.012, amp: 1.2 });
      addModes(out, sr, [[420, 0.4, 0.02], [900, 0.3, 0.015]], 1, 1, rng);
      break;
    case 'frame':
      mk(0.95);
      addSweep(out, sr, { f0: 112, f1: 74, tf: 0.03, ta: 0.22, amp: 1 });
      addSweep(out, sr, { f0: 170, f1: 148, tf: 0.03, ta: 0.11, amp: 0.3 });
      addBurst(out, sr, rng, { type: 'bandpass', f: 700, q: 1, tau: 0.08, amp: 0.5 });
      addBurst(out, sr, rng, { type: 'lowpass', f: 1500, tau: 0.005, amp: 0.4 });
      break;
    case 'frame_tak':
      mk(0.26);
      addModes(out, sr, [[520, 0.5, 0.045], [830, 0.35, 0.035], [1500, 0.2, 0.02]], 1, 1, rng);
      addBurst(out, sr, rng, { type: 'highpass', f: 2000, tau: 0.007, amp: 0.4 });
      break;
    case 'riq':
      mk(0.3);
      addModes(out, sr, [[5200, 0.16, 0.06], [6700, 0.18, 0.055], [8100, 0.16, 0.05],
        [9800, 0.13, 0.045], [11500, 0.1, 0.04]], 1, 1, rng);
      addBurst(out, sr, rng, { type: 'highpass', f: 6500, tau: 0.045, amp: 0.5 });
      addBurst(out, sr, rng, { type: 'highpass', f: 6500, tau: 0.04, amp: 0.3, at: 0.024 });
      break;
    case 'taiko':
      mk(1.5);
      addSweep(out, sr, { f0: 135, f1: 58, tf: 0.035, ta: 0.3, amp: 1 });
      addSweep(out, sr, { f0: 180, f1: 88, tf: 0.03, ta: 0.2, amp: 0.45 });
      addSweep(out, sr, { f0: 240, f1: 133, tf: 0.02, ta: 0.15, amp: 0.2 });
      addBurst(out, sr, rng, { type: 'lowpass', f: 2800, tau: 0.007, amp: 0.9 });
      addBurst(out, sr, rng, { type: 'lowpass', f: 240, tau: 0.12, amp: 1.2 });
      drive(out, 1.4);
      break;
    case 'clack':
      mk(0.11);
      addModes(out, sr, [[1250, 0.6, 0.014], [2100, 0.5, 0.01], [3300, 0.3, 0.008]], 1, 1, rng);
      addBurst(out, sr, rng, { type: 'highpass', f: 2500, tau: 0.003, amp: 0.5 });
      break;
    case 'boom':
      mk(3.2);
      addSweep(out, sr, { f0: 78, f1: 33, tf: 0.08, ta: 1.0, amp: 1 });
      addSweep(out, sr, { f0: 120, f1: 49.5, tf: 0.08, ta: 0.5, amp: 0.3 });
      addBurst(out, sr, rng, { type: 'lowpass', f: 160, tau: 0.45, amp: 2.2, attack: 0.005 });
      addBurst(out, sr, rng, { type: 'lowpass', f: 1200, tau: 0.03, amp: 0.6 });
      drive(out, 1.6);
      break;
    case 'timp':
      mk(2.3); // tuned to D2 (73.42 Hz); repitch with playbackRate
      addSweep(out, sr, { f0: 75.5, f1: 73.42, tf: 0.04, ta: 0.9, amp: 1 });
      addSweep(out, sr, { f0: 112, f1: 110.1, tf: 0.04, ta: 0.6, amp: 0.55 });
      addSweep(out, sr, { f0: 148, f1: 146.3, tf: 0.04, ta: 0.4, amp: 0.35 });
      addSweep(out, sr, { f0: 181, f1: 179.2, tf: 0.04, ta: 0.28, amp: 0.2 });
      addSweep(out, sr, { f0: 215, f1: 213, tf: 0.04, ta: 0.2, amp: 0.12 });
      addBurst(out, sr, rng, { type: 'lowpass', f: 700, tau: 0.012, amp: 0.8 });
      break;
    case 'snare':
      mk(0.34);
      addSweep(out, sr, { f0: 215, f1: 176, tf: 0.02, ta: 0.06, amp: 0.5 });
      addSweep(out, sr, { f0: 345, f1: 330, tf: 0.02, ta: 0.04, amp: 0.3 });
      addBurst(out, sr, rng, { type: 'bandpass', f: 2400, q: 0.6, tau: 0.085, amp: 1.3 });
      addBurst(out, sr, rng, { type: 'highpass', f: 5000, tau: 0.05, amp: 0.4 });
      break;
    case 'tick':
      mk(0.07);
      addModes(out, sr, [[3100, 0.6, 0.008], [4700, 0.4, 0.006]], 1, 1, rng);
      addBurst(out, sr, rng, { type: 'bandpass', f: 6000, q: 2, tau: 0.004, amp: 1.2 });
      break;
    case 'cym': {
      mk(2.6);
      const modes = [];
      for (let i = 0; i < 44; i++) {
        modes.push([2400 + Math.pow(rng(), 1.3) * 9000, 0.05 + rng() * 0.06, 0.25 + rng() * 0.9]);
      }
      addModes(out, sr, modes, 1, 1, rng);
      addBurst(out, sr, rng, { type: 'highpass', f: 4200, tau: 0.5, amp: 0.35, attack: 0.002 });
      break;
    }
    case 'gong': {
      mk(4.2);
      const base = 110;
      const ratios = [1, 1.48, 2.09, 2.56, 3.17, 4.03, 5.1, 6.3, 7.9];
      for (let r = 0; r < ratios.length; r++) {
        const f = base * ratios[r];
        const w = 2 * Math.PI * f / sr;
        const tau = 2.4 / (1 + r * 0.35);
        const bloom = 0.01 + r * 0.035; // upper partials swell in late
        const amp = 0.5 / (1 + r * 0.45);
        const ph = rng() * 6.28;
        const rr = Math.exp(-1 / (sr * tau)), kb = Math.exp(-1 / (sr * bloom));
        const c1 = 2 * rr * Math.cos(w), c2 = -rr * rr;
        let y1 = Math.sin(ph - w) / rr, y2 = Math.sin(ph - 2 * w) / (rr * rr), bl = 1;
        for (let i = 0; i < out.length; i++) {
          const y = c1 * y1 + c2 * y2;
          y2 = y1; y1 = y;
          out[i] += y * amp * (1 - bl);
          bl *= kb;
        }
      }
      addBurst(out, sr, rng, { type: 'lowpass', f: 500, tau: 0.02, amp: 0.5 });
      break;
    }
    case 'shaker':
    case 'shaker_l': {
      // riq / shaker stroke: soft-edged burst of bright noise
      const tau = kind === 'shaker' ? 0.014 : 0.036;
      mk(tau * 8 + 0.02);
      addBurst(out, sr, rng, { type: 'highpass', f: 5200, q: 0.9, tau, amp: 1, attack: 0.004 });
      biquadInPlace(out, 'peaking', 8200, 2, sr, 6);
      break;
    }
    case 'swell': {
      // 3 s noise riser (cymbal-roll stand-in): exponential swell, then cut.
      // Played back faster or slower to fit the bar it leads into.
      mk(3.08);
      const n = Math.floor(sr * 3);
      for (let i = 0; i < out.length; i++) {
        const k = i < n ? Math.pow(10, -3 * (1 - i / n)) : Math.max(0, 1 - (i - n) / (sr * 0.07));
        out[i] = (rng() * 2 - 1) * k;
      }
      biquadInPlace(out, 'highpass', 2600, 0.7, sr);
      biquadInPlace(out, 'peaking', 6000, 0.8, sr, 5);
      return finishShot(out, sr, 0.9, 0.001, 0.01);
    }
    default:
      mk(0.05);
      break;
  }
  biquadInPlace(out, 'highpass', 24, 0.707, sr);
  return finishShot(cutTail(out, sr, 0.008), sr, 0.9, 0.0004, kind === 'tick' || kind === 'clack' ? 0.01 : 0.03);
}
