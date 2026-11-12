// 2D gradient (Perlin) noise + fbm, seeded through the lattice hash.
// Output of noise2 is roughly [-1, 1]; fbm is normalised to the same range.
import { hash2 } from './prng.mjs';

const S = Math.sqrt(0.5);
// 8 fixed gradient directions (no trig: only 1, 0 and sqrt(1/2))
const GRAD = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [S, S], [-S, S], [S, -S], [-S, -S],
];

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export function makeNoise(seed) {
  seed >>>= 0;
  const dot = (ix, iy, dx, dy) => {
    const g = GRAD[hash2(seed, ix, iy) & 7];
    return g[0] * dx + g[1] * dy;
  };
  return function noise2(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const u = fade(fx), v = fade(fy);
    const n00 = dot(x0, y0, fx, fy);
    const n10 = dot(x0 + 1, y0, fx - 1, fy);
    const n01 = dot(x0, y0 + 1, fx, fy - 1);
    const n11 = dot(x0 + 1, y0 + 1, fx - 1, fy - 1);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * 1.41421356;
  };
}

// Fractal sum. `cells` is the size (in map cells) of the largest feature.
export function makeFbm(seed, { cells = 32, octaves = 4, gain = 0.5, lacunarity = 2 } = {}) {
  const layers = [];
  let amp = 1, freq = 1 / cells, norm = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ n: makeNoise((seed + Math.imul(o + 1, 0x51ed270b)) >>> 0), amp, freq, ox: o * 17.31, oy: o * 9.73 });
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return function fbm(x, y) {
    let s = 0;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      s += L.amp * L.n(x * L.freq + L.ox, y * L.freq + L.oy);
    }
    return s / norm;
  };
}
