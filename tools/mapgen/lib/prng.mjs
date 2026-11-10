// Seeded randomness for the map generator. Everything here is integer /
// IEEE-754 basic arithmetic only (no Math.random, no Date, no trig), so the
// same seed produces byte-identical maps on any JS engine.

// mulberry32: tiny, fast, well-distributed 32-bit PRNG.
export function mulberry32(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
  return {
    u32: next,
    float: () => next() / 4294967296,            // [0, 1)
    range: (lo, hi) => lo + (hi - lo) * (next() / 4294967296),
    int: (n) => next() % n,                      // [0, n)
    pick: (arr) => arr[next() % arr.length],
  };
}

// Stateless lattice hash: (seed, ix, iy) -> uint32. Used by the noise so a
// sample never depends on evaluation order.
export function hash2(seed, ix, iy) {
  let h = (seed ^ Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

// Derive an independent sub-seed from a seed and a small integer / string salt.
export function subSeed(seed, salt) {
  let s = 0;
  if (typeof salt === 'string') {
    for (let i = 0; i < salt.length; i++) s = (Math.imul(s, 31) + salt.charCodeAt(i)) >>> 0;
  } else {
    s = salt >>> 0;
  }
  return hash2(seed >>> 0, s, 0x9e3779b9);
}
