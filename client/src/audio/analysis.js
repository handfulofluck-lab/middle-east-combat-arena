// Measurement helpers for the audio lab / verification harness. Pure maths
// on Float32Arrays: peak / RMS / DC, 4x-oversampled true peak, BS.1770-style
// gated loudness, octave-band balance, onset timing against a tempo grid,
// loop-seam continuity and a 16-bit WAV encoder.

const db = (x) => (x > 1e-12 ? 20 * Math.log10(x) : -240);

export function basicStats(ch) {
  let pk = 0, sum = 0, dc = 0, nan = 0;
  for (let i = 0; i < ch.length; i++) {
    const v = ch[i];
    if (!(v === v) || !isFinite(v)) { nan++; continue; }
    const a = v < 0 ? -v : v;
    if (a > pk) pk = a;
    sum += v * v;
    dc += v;
  }
  return { peak: pk, peakDb: db(pk), rms: Math.sqrt(sum / ch.length), rmsDb: db(Math.sqrt(sum / ch.length)),
    dc: dc / ch.length, nan };
}

export function mixdown(chs) {
  const n = chs[0].length;
  const out = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i] / chs.length;
  return out;
}

// inter-sample peak: 4x windowed-sinc interpolation around the largest samples
export function truePeakDb(chs) {
  const TAPS = 12;
  let best = 0;
  for (const ch of chs) {
    const n = ch.length;
    let pk = 0;
    for (let i = 0; i < n; i++) { const a = Math.abs(ch[i]); if (a > pk) pk = a; }
    if (pk > best) best = pk;
    const thr = pk * 0.9;
    for (let i = TAPS; i < n - TAPS - 1; i++) {
      if (Math.abs(ch[i]) < thr && Math.abs(ch[i + 1]) < thr) continue;
      for (let k = 1; k < 4; k++) {
        const frac = k / 4;
        let acc = 0;
        for (let j = -TAPS + 1; j <= TAPS; j++) {
          const x = j - frac;
          const w = 0.5 + 0.5 * Math.cos(Math.PI * x / TAPS);
          const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
          acc += ch[i + j] * sinc * w;
        }
        if (Math.abs(acc) > best) best = Math.abs(acc);
      }
    }
  }
  return db(best);
}

function kWeight(x, sr) {
  const y = new Float32Array(x.length);
  // stage 1: high shelf (+4 dB above ~1.7 kHz)
  let K = Math.tan(Math.PI * 1681.974450955533 / sr);
  const Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const Q1 = 0.7071752369554196;
  let a0 = 1 + K / Q1 + K * K;
  const b0 = (Vh + Vb * K / Q1 + K * K) / a0, b1 = 2 * (K * K - Vh) / a0, b2 = (Vh - Vb * K / Q1 + K * K) / a0;
  const a1 = 2 * (K * K - 1) / a0, a2 = (1 - K / Q1 + K * K) / a0;
  // stage 2: RLB high-pass
  K = Math.tan(Math.PI * 38.13547087602444 / sr);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const c1 = 2 * (K * K - 1) / a0, c2 = (1 - K / Q2 + K * K) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const s = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = s;
    const o = s - 2 * u1 + u2 - c1 * v1 - c2 * v2;
    u2 = u1; u1 = s; v2 = v1; v1 = o;
    y[i] = o;
  }
  return y;
}

// -> { integrated, momentaryMax } in LUFS (400 ms blocks, 75 % overlap, gated)
export function loudness(chs, sr) {
  const w = chs.map((c) => kWeight(c, sr));
  const n = w[0].length;
  const block = Math.floor(0.4 * sr), hop = Math.floor(0.1 * sr);
  const z = [];
  for (let s = 0; s + block <= n; s += hop) {
    let sum = 0;
    for (const c of w) {
      let e = 0;
      for (let i = s; i < s + block; i++) e += c[i] * c[i];
      sum += e / block;
    }
    z.push(sum);
  }
  if (!z.length) return { integrated: -240, momentaryMax: -240 };
  const L = (v) => -0.691 + 10 * Math.log10(Math.max(v, 1e-24));
  let mx = -240;
  for (const v of z) if (L(v) > mx) mx = L(v);
  const abs = z.filter((v) => L(v) > -70);
  if (!abs.length) return { integrated: -240, momentaryMax: mx };
  const mean1 = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rel = abs.filter((v) => L(v) > L(mean1) - 10);
  const mean2 = rel.reduce((a, b) => a + b, 0) / Math.max(1, rel.length);
  return { integrated: L(mean2), momentaryMax: mx };
}

// in-place radix-2 FFT
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export const OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// energy per octave band, in dB relative to the total (Welch average)
export function octaveBands(mono, sr) {
  const N = 8192, hop = 4096;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const psd = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  let frames = 0;
  for (let s = 0; s + N <= mono.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = mono[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) psd[i] += re[i] * re[i] + im[i] * im[i];
    frames++;
  }
  const hz = sr / N;
  let total = 0;
  const e = OCTAVES.map((fc) => {
    const lo = Math.max(1, Math.floor(fc / Math.SQRT2 / hz)), hi = Math.min(N / 2 - 1, Math.floor(fc * Math.SQRT2 / hz));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += psd[i];
    total += sum;
    return sum;
  });
  return e.map((v) => (frames && total > 0 ? 10 * Math.log10(Math.max(v / total, 1e-12)) : -120));
}

// onset times (s): sharp attacks only (>= 8 dB rise of the high-passed
// energy within ~4 ms, landing within 30 dB of the loudest attacks), so
// pads, breath noise and reverb do not register
export function onsets(mono, sr) {
  const hop = Math.round(sr / 1000);
  const n = Math.floor(mono.length / hop) - 1;
  const env = new Float32Array(n);
  let prev = 0;
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const d = mono[i] - prev; // first difference = crude high-pass
      prev = mono[i];
      e += d * d;
    }
    env[f] = Math.log10(1e-10 + e / hop);
  }
  const flux = new Float32Array(n);
  const lvl = new Float32Array(n);
  let top = -10;
  for (let f = 5; f < n; f++) {
    const a = (env[f] + env[f - 1]) / 2, b = (env[f - 3] + env[f - 4] + env[f - 5]) / 3;
    flux[f] = Math.max(0, a - b);
    lvl[f] = a;
    if (a > top) top = a;
  }
  const out = [];
  for (let f = 30; f < n - 30; f++) {
    const v = flux[f];
    if (v < 0.8 || lvl[f] < top - 3) continue;
    let isMax = true;
    for (let k = -25; k <= 25; k++) if (flux[f + k] > v) { isMax = false; break; }
    if (!isMax) continue;
    out.push((f - 1) * hop / sr);
    f += 25;
  }
  return out;
}

// how tightly onsets sit on a grid of `step` seconds starting at `origin`
export function gridFit(times, step, origin) {
  if (!times.length) return { n: 0, medianMs: 0, madMs: 0, within: 0 };
  const res = times.map((t) => {
    const x = (t - origin) / step;
    return (x - Math.round(x)) * step * 1000;
  });
  const sorted = res.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const dev = res.map((r) => Math.abs(r - med)).sort((a, b) => a - b);
  const mad = dev[Math.floor(dev.length / 2)];
  const within = dev.filter((d) => d <= 12).length / dev.length;
  return { n: times.length, medianMs: med, madMs: mad, within };
}

// continuity across a loop point at tSeam: sample steps and short-term level
// around the seam compared with the rest of the render
export function seamCheck(mono, sr, tSeam) {
  const i0 = Math.floor(tSeam * sr);
  if (i0 < sr || i0 > mono.length - sr) return null;
  let maxAll = 0;
  const deltas = [];
  for (let i = 1; i < mono.length; i += 7) deltas.push(Math.abs(mono[i] - mono[i - 1]));
  deltas.sort((a, b) => a - b);
  const p999 = deltas[Math.floor(deltas.length * 0.999)] || 1e-9;
  let seamJump = 0;
  const w = Math.floor(0.02 * sr);
  for (let i = i0 - w; i < i0 + w; i++) {
    const d = Math.abs(mono[i] - mono[i - 1]);
    if (d > seamJump) seamJump = d;
    if (d > maxAll) maxAll = d;
  }
  const rmsOf = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += mono[i] * mono[i]; return Math.sqrt(s / (b - a)); };
  const half = Math.floor(0.5 * sr);
  // quietest 50 ms window within +-0.5 s of the seam vs the 1 s before that
  let minW = Infinity;
  const ww = Math.floor(0.05 * sr);
  for (let s = i0 - half; s + ww <= i0 + half; s += ww >> 1) minW = Math.min(minW, rmsOf(s, s + ww));
  const ref = rmsOf(i0 - half - sr, i0 - half);
  return {
    jumpRatio: seamJump / p999,
    beforeDb: db(rmsOf(i0 - half, i0)), afterDb: db(rmsOf(i0, i0 + half)),
    minWindowDb: db(minW), refDb: db(ref),
  };
}

// seconds from the first to the last sample above `threshDb` (dBFS)
export function activeSpan(mono, sr, threshDb) {
  const thr = Math.pow(10, threshDb / 20);
  let first = -1, last = -1;
  for (let i = 0; i < mono.length; i++) {
    if (Math.abs(mono[i]) > thr) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return { start: 0, end: 0, dur: 0 };
  return { start: first / sr, end: last / sr, dur: (last - first) / sr };
}

export function wavBytes(chs, sr) {
  const n = chs[0].length, nc = chs.length;
  const buf = new ArrayBuffer(44 + n * nc * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * nc * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true);
  v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const s = Math.max(-1, Math.min(1, chs[c][i]));
      v.setInt16(o, Math.round(s * 32767), true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

export function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

export { db as toDb };
