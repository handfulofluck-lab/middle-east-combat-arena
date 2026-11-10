// Asset generation shared by the main thread and the DSP worker: every
// procedural buffer the engine needs is addressed by a string key and built
// deterministically from it (the PRNG seed is a hash of the key), so the
// sound of an asset never depends on which thread built it or in what order.
//
//   noise:white | noise:pink | noise:brown   loop-seamless noise beds
//   crackle                                  sparse debris / fire pops
//   ir:desert | ir:hall                      stereo reverb impulse responses
//   drum:<name>                              percussion one-shots (dsp.js)
//   pluck:<oud|qanun|bass>:<midi>            Karplus-Strong plucked strings
import {
  makeRng, fillNoise, renderCrackle, renderImpulse, renderPluck, renderDrum,
} from './dsp.js';

// "Open desert": short bright tail with a few discrete slap-backs (dunes,
// far walls). Used by the SFX bus.
const IR_DESERT = {
  dur: 1.25, t60: 0.95, predelay: 0.012, bright: 0.85, floor: 0.16, dampTime: 0.5, lowCut: 260,
  early: [
    { t: 0.031, g: 0.5, pan: -0.5 }, { t: 0.058, g: 0.42, pan: 0.6 },
    { t: 0.097, g: 0.34, pan: -0.2 }, { t: 0.151, g: 0.3, pan: 0.4 },
    { t: 0.236, g: 0.22, pan: -0.7 }, { t: 0.342, g: 0.15, pan: 0.7 },
  ],
};
// Large dark hall for the score.
const IR_HALL = {
  dur: 2.0, t60: 2.2, predelay: 0.024, bright: 0.55, floor: 0.05, dampTime: 0.7, lowCut: 190,
  early: [
    { t: 0.019, g: 0.3, pan: -0.6 }, { t: 0.033, g: 0.28, pan: 0.5 },
    { t: 0.047, g: 0.22, pan: 0.1 }, { t: 0.071, g: 0.2, pan: -0.3 },
  ],
};

const DRUM_PAN = { tek: 0.3, ka: -0.3, frame_tak: 0.25, riq: 0.3, shaker: 0.35, shaker_l: 0.35,
  clack: -0.25, snare: 0.1 };

// Optional memo of generated channel data, shared by every engine in the
// page. Off in the game (the engine keeps its own AudioBuffers); the audio
// lab turns it on so repeated offline renders do not rebuild every asset.
let memo = null;
export function memoAssets(on) {
  memo = on ? (memo || new Map()) : null;
}
// the same memo also holds baked SFX / loop renders (engine.js)
export function assetMemo() {
  return memo;
}
export function hashKey(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Returns an array of Float32Array channels (1 = mono, 2 = stereo).
export function generateAsset(key, sr) {
  if (!memo) return buildAsset(key, sr);
  const k = key + '@' + sr;
  let chans = memo.get(k);
  if (!chans) { chans = buildAsset(key, sr); memo.set(k, chans); }
  return chans;
}

function buildAsset(key, sr) {
  const rng = makeRng(hashKey(key));
  const parts = key.split(':');
  switch (parts[0]) {
    case 'noise': {
      const secs = parts[1] === 'white' ? 1.5 : 3;
      return [fillNoise(new Float32Array(Math.floor(sr * secs)), rng, parts[1])];
    }
    case 'crackle':
      return [renderCrackle(sr, 3, rng, 55)];
    case 'ir':
      // the hall is true stereo; the desert tail is mono (widened in the graph)
      if (parts[1] === 'hall') return renderImpulse(sr, IR_HALL, rng);
      return [renderImpulse(sr, IR_DESERT, rng)[0]];
    case 'drum': {
      if (parts[1] === 'taiko_ens') {
        // two drums in one buffer: the main taiko plus a larger one (a third
        // lower, resampled) landing 11 ms later
        const a = renderDrum(sr, 'taiko', rng);
        const k = 0.8, off = Math.floor(sr * 0.011);
        const out = new Float32Array(Math.floor(a.length / k) + off);
        out.set(a);
        for (let i = 0; i + off < out.length; i++) {
          const x = i * k, j = Math.floor(x);
          if (j + 1 >= a.length) break;
          out[i + off] += (a[j] + (a[j + 1] - a[j]) * (x - j)) * 0.7;
        }
        return [out];
      }
      // hand-percussion strokes carry their stereo position in the buffer, so
      // a hit never needs a panner node of its own
      const mono = renderDrum(sr, parts[1], rng);
      const pan = DRUM_PAN[parts[1]];
      if (!pan) return [mono];
      const a = (pan + 1) * Math.PI / 4;
      const l = new Float32Array(mono.length), r = new Float32Array(mono.length);
      const gl = Math.cos(a) * Math.SQRT2, gr = Math.sin(a) * Math.SQRT2;
      for (let i = 0; i < mono.length; i++) { l[i] = mono[i] * gl; r[i] = mono[i] * gr; }
      return [l, r];
    }
    case 'pluck':
      return [renderPluck(sr, Number(parts[2]), parts[1], rng, parts[3] === 's')];
    default:
      return [new Float32Array(8)];
  }
}
