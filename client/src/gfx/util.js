// Shared math + procedural helpers for the renderer. Everything here is
// deterministic (no Math.random) so two machines build the identical world.

export const CELL = 64;            // sim world units per map cell
export const S = 2;                // render units per map cell
export const WU = S / CELL;        // render units per sim world unit
export const WATER_Y = 0;          // sea level in render units

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export function smoothstep(a, b, x) {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
export function damp(cur, target, rate, dt) {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

// ---- hashing / seeded RNG -------------------------------------------------

export function hash2(x, y, seed = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)
    + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---- value noise ----------------------------------------------------------

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export function vnoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x, y, oct = 4, seed = 0, lac = 2.03, gain = 0.5) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, seed + i * 17);
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return sum / norm;
}

// ridged multifractal in 0..1 (sharp crests)
export function ridged(x, y, oct = 4, seed = 0) {
  let amp = 0.5, f = 1, sum = 0, norm = 0, prev = 1;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(vnoise(x * f, y * f, seed + i * 31) * 2 - 1);
    n *= n;
    sum += n * amp * prev;
    norm += amp;
    prev = clamp(n * 1.6, 0, 1);
    amp *= 0.5;
    f *= 2.07;
  }
  return sum / norm;
}

// ---- distance transform (chamfer 3-4) on a W×H mask -----------------------
// Returns Float32Array: distance (in cells) from each cell to the nearest
// cell where mask == 0. Cells with mask == 0 get 0.
export function distanceField(mask, W, H) {
  const INF = 1e6;
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = mask[i] ? INF : 0;
  const A = 1, B = 1.41421356;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + A);
      if (y > 0) {
        v = Math.min(v, d[i - W] + A);
        if (x > 0) v = Math.min(v, d[i - W - 1] + B);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + B);
      }
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < W - 1) v = Math.min(v, d[i + 1] + A);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + A);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + B);
        if (x > 0) v = Math.min(v, d[i + W - 1] + B);
      }
      d[i] = v;
    }
  }
  return d;
}

// signed distance: positive inside the class, negative outside, ~0 on the edge
export function signedField(isClass, W, H) {
  const inside = new Uint8Array(W * H);
  const outside = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    inside[i] = isClass[i] ? 1 : 0;
    outside[i] = isClass[i] ? 0 : 1;
  }
  const din = distanceField(inside, W, H);   // >0 inside
  const dout = distanceField(outside, W, H); // >0 outside
  const sd = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) sd[i] = isClass[i] ? din[i] - 0.5 : -(dout[i] - 0.5);
  return sd;
}

export function boxBlur(src, W, H, passes = 1) {
  let a = src, b = new Float32Array(W * H);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const w = (dx === 0 && dy === 0) ? 4 : (dx === 0 || dy === 0) ? 2 : 1;
            s += a[yy * W + xx] * w;
            n += w;
          }
        }
        b[y * W + x] = s / n;
      }
    }
    const t = a; a = b; b = (t === src) ? new Float32Array(W * H) : t;
  }
  return a;
}

// bilinear sample of a cell-centred field (value at cell centre cx+0.5)
export function sampleField(f, W, H, px, py) {
  let x = px - 0.5, y = py - 0.5;
  if (x < 0) x = 0; else if (x > W - 1) x = W - 1;
  if (y < 0) y = 0; else if (y > H - 1) y = H - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = f[y0 * W + x0], b = f[y0 * W + x1];
  const c = f[y1 * W + x0], d = f[y1 * W + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function hexToRgb(hex) {
  if (typeof hex === 'string') hex = parseInt(hex.replace('#', ''), 16);
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
