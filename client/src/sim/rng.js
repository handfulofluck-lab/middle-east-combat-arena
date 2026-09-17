// splitmix32-style seeded RNG. All output derived from a single uint32 state,
// so a match is fully deterministic and serializable.
export function createRng(seed) {
  let s = (seed >>> 0) || 0x6d2b79f5;
  const rng = {
    // uint32 stream
    next() {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      z = (z ^ (z >>> 15)) >>> 0;
      return z;
    },
    // float in [0,1), derived from the integer stream
    float() {
      return rng.next() / 4294967296;
    },
    // integer in [0, n)
    int(n) {
      return rng.next() % n;
    },
    // bernoulli(p) via integer threshold; p in [0,1]
    chance(p) {
      const threshold = Math.floor(p * 4294967296);
      return rng.next() < threshold;
    },
    // serializable state
    get() {
      return s >>> 0;
    },
    set(v) {
      s = v >>> 0;
    },
  };
  return rng;
}
