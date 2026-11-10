// MCA audio engine core. One AudioEngine wraps one BaseAudioContext — a live
// AudioContext in the game, an OfflineAudioContext in the verification
// harness — and owns the whole graph:
//
//   sfx voices ─┐                          ┌─ desert reverb (convolver) ─┐
//   ui voices  ─┼─ sfx volume ─┐           │                             │
//   loops      ─┘              │           └──────── sfx volume ◄────────┘
//   music ─ duck ─ music vol ──┼─ 24 Hz HP ─ bus compressor ─ limiter ─ soft
//   stingers ──── music vol ───┤      clipper ─ master volume / mute ─ output
//   voice clips ─ voice vol ───┘                               └─ analyser tap
//
// Voice clips (announcer + unit acknowledgements) are the one thing that is
// not synthesised here: they are pre-rendered files played by ./voice.js.
//
// Everything audible is scheduled on the context clock. tick() is the single
// heartbeat (setInterval in real time, OfflineAudioContext.suspend() pumps in
// the harness): it runs the music look-ahead scheduler, retires finished
// voices and fires deferred callbacks.
//
// CPU model (measured in the lab): the browser's cost is, to a first
// approximation, proportional to the number of live nodes. So SFX and loops
// are "baked": the first time a sound is needed its layered recipe is
// rendered once on a background OfflineAudioContext into a few buffer
// variants, and from then on a shot is a buffer source plus a three-node
// chain instead of twenty oscillators and filters.
import { generateAsset, assetMemo, hashKey } from './assetgen.js';
import { makeRng } from './dsp.js';
import { SFX } from './sfx.js';
import { LOOPS, LOOP_LEN, buildLoop } from './loops.js';
import { MusicDirector } from './music.js';
import { VoiceBox } from './voice.js';

export const DEFAULT_VOLUMES = { master: 0.9, music: 0.55, sfx: 0.8, voice: 0.9 };

// bus compressor / limiter settings. The Web Audio DynamicsCompressorNode
// applies an automatic make-up gain of (1 / curve(1.0)) ^ 0.6; the trims
// cancel it (verified by the lab's master-chain calibration check).
const COMP = { threshold: -14, knee: 0, ratio: 2, attack: 0.015, release: 0.2 };
const LIM = { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.09 };
const MAKEUP_DB = 5;      // fixed post-compressor make-up (quiet material passes at +5 dB)
function makeupOf(c) {
  const tl = Math.pow(10, c.threshold / 20);
  const full = Math.pow(tl, 1 - 1 / c.ratio); // compression curve evaluated at 1.0
  return Math.pow(1 / full, 0.6);
}
const CLIP_KNEE = 0.70;   // linear below this
const CLIP_CEIL = 0.86;   // asymptote; curve(1.0) = 0.853 (-1.38 dBFS)

// rate limits per category (voices started per second) on the context clock;
// together with the per-100-ms window they keep a 200-unit battle readable
const CAT_CAP = { light: 8, heavy: 6, impact: 8, world: 6, cine: 4 };
const WINDOW_CAP = 6;     // new world voices per 100 ms

// shared reverb-send / wet-tail buses: a voice picks the nearest level
// instead of owning a gain node
const SEND_LEVELS = [0.12, 0.24, 0.45, 0.8, 1.4];
const WET_LEVELS = [0.05, 0.11, 0.22, 0.42, 0.8, 1.5];
// ... and the nearest of seven fixed stereo positions instead of a panner
const PAN_LEVELS = [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9];

// overall trim of the score: puts the full tracks at about -17 LUFS and the
// in-match piece between -22 (quiet) and -15.5 LUFS (full combat) at the
// default volumes
const MUSIC_TRIM = 1.12;
// trim of the voice bus: the clips are rendered to -16 LUFS (tools/voicegen)
const VOICE_TRIM = 1;

const taper = (v) => v * v;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function perfNow() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function offlineClass() {
  return globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext || null;
}

// run `fn` when the main thread has a moment (never inside a caller's frame)
function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => fn(), { timeout: 400 });
  else if (typeof setTimeout === 'function') setTimeout(fn, 20);
  else fn();
}

function nearest(levels, v) {
  let best = 0;
  for (let i = 1; i < levels.length; i++) if (Math.abs(levels[i] - v) < Math.abs(levels[best] - v)) best = i;
  return best;
}

// ---- procedural asset bank -------------------------------------------------------
// Buffers are built in a module worker when one is available (never blocks a
// frame); with `sync` (offline rendering) or without Worker support they are
// built on demand on the calling thread.
class AssetBank {
  constructor(ctx, sync) {
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.sync = !!sync;
    this.buf = new Map();
    this.waiting = new Map();
    this.queue = [];
    this.worker = null;
    this.nextId = 1;
    this.genMs = 0;
    this.maxGenMs = 0;
    this.maxStoreMs = 0;
    this.built = 0;
    if (!this.sync) this.spawn();
  }

  spawn() {
    try {
      if (typeof Worker !== 'function') return;
      const w = new Worker(new URL('./dsp_worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.chans) this.store(m.key, m.chans);
        else this.fallback(m.key);
      };
      w.onerror = () => { this.worker = null; this.drainSoon(); };
      this.worker = w;
    } catch (e) {
      this.worker = null;
    }
  }

  store(key, chans) {
    let b = this.buf.get(key);
    if (!b) {
      const t0 = perfNow();
      b = this.ctx.createBuffer(chans.length, chans[0].length, this.sr);
      for (let c = 0; c < chans.length; c++) b.getChannelData(c).set(chans[c]);
      this.buf.set(key, b);
      this.built++;
      const ms = perfNow() - t0;
      if (ms > this.maxStoreMs) this.maxStoreMs = ms;
    }
    const cbs = this.waiting.get(key);
    if (cbs) {
      this.waiting.delete(key);
      for (const cb of cbs) { try { cb(b); } catch (e) { /* best-effort */ } }
    }
    return b;
  }

  genNow(key) {
    const t0 = perfNow();
    const b = this.store(key, generateAsset(key, this.sr));
    const ms = perfNow() - t0;
    this.genMs += ms;
    if (ms > this.maxGenMs) this.maxGenMs = ms;
    return b;
  }

  fallback(key) {
    if (!this.buf.has(key)) { this.queue.push(key); this.drainSoon(); }
  }

  // no worker: build one queued asset per timer task so no frame eats two
  drainSoon() {
    if (this.draining || typeof setTimeout !== 'function') return;
    for (const k of this.waiting.keys()) if (this.queue.indexOf(k) < 0) this.queue.push(k);
    if (!this.queue.length) return;
    this.draining = true;
    const step = () => {
      const k = this.queue.shift();
      if (k !== undefined && !this.buf.has(k)) { try { this.genNow(k); } catch (e) { /* skip */ } }
      if (this.queue.length) setTimeout(step, 24);
      else this.draining = false;
    };
    setTimeout(step, 0);
  }

  // Returns the AudioBuffer, or null while a worker build is in flight (cb
  // fires when it lands).
  get(key, cb) {
    const b = this.buf.get(key);
    if (b) return b;
    if (this.sync || !this.worker) return this.genNow(key);
    let cbs = this.waiting.get(key);
    if (!cbs) {
      cbs = [];
      this.waiting.set(key, cbs);
      try {
        this.worker.postMessage({ id: this.nextId++, key, sr: this.sr });
      } catch (e) {
        this.worker = null;
        this.waiting.delete(key);
        return this.genNow(key);
      }
    }
    if (cb) cbs.push(cb);
    return null;
  }

  has(key) {
    return this.buf.has(key);
  }

  prewarm(keys) {
    if (this.sync) return;
    if (this.worker) { for (const k of keys) this.get(k); return; }
    for (const k of keys) if (!this.buf.has(k) && this.queue.indexOf(k) < 0) this.queue.push(k);
    this.drainSoon();
  }

  dispose() {
    try { if (this.worker) this.worker.terminate(); } catch (e) { /* ok */ }
    this.worker = null;
    this.buf.clear();
    this.waiting.clear();
    this.queue.length = 0;
  }
}

// ---- baking: recipes -> buffers on a background OfflineAudioContext ----------------

function trimTail(x, sr) {
  let last = x.length - 1;
  while (last > 0 && Math.abs(x[last]) < 2e-5) last--;
  if (last < 32) return null; // nothing there
  const n = Math.min(x.length, last + 1 + Math.floor(sr * 0.003));
  const out = x.slice(0, n);
  const fade = Math.min(n, Math.floor(sr * 0.003));
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return out;
}

class Baker {
  constructor(E) {
    this.E = E;
    this.sfx = new Map();    // name -> [{ dry, wet, len }]
    this.loops = new Map();  // name -> AudioBuffer
    this.graphs = new Map(); // key -> AudioBuffer (seamless loop of an arbitrary graph)
    this.inflight = new Map();
    this.queue = [];
    this.later = [];
    this.running = false;
    this.count = 0;
    this.maxSliceMs = 0; // longest synchronous stretch spent setting up a bake
  }

  slice(t0) {
    const ms = perfNow() - t0;
    if (ms > this.maxSliceMs) this.maxSliceMs = ms;
  }

  can() {
    return !!offlineClass() && !this.E.noBake;
  }

  // the recipes draw on the coloured-noise beds; never bake before they exist
  ready() {
    const a = this.E.assets;
    return a.has('noise:white') && a.has('noise:pink') && a.has('noise:brown') && a.has('crackle');
  }

  // stand-in engine for building a graph on an offline context
  fake(ctx, seed) {
    const E = this.E;
    return {
      ctx, rng: makeRng(seed), noise: (c) => E.noise(c), crackle: () => E.crackle(), count() {},
      assets: { has: () => true, get: (k) => E.assets.get(k) },
    };
  }

  // renders `build(ctx, fakeEngine)` (anything connected to ctx.destination)
  // into a seamless mono loop of `seconds`
  async bakeGraph(key, seconds, build) {
    if (this.graphs.has(key)) return;
    const E = this.E, sr = E.sr, OAC = offlineClass();
    if (!OAC) return;
    const memo = assetMemo();
    const mk = 'bake:graph:' + key + '@' + sr;
    let out = memo ? memo.get(mk) : null;
    if (!out) {
      const X = 0.5;
      let t0 = perfNow();
      const ctx = new OAC(1, Math.ceil((seconds + X) * sr), sr);
      build(ctx, this.fake(ctx, hashKey(key)));
      const pending = ctx.startRendering();
      this.slice(t0);
      const d = (await pending).getChannelData(0);
      t0 = perfNow();
      const n = Math.floor(seconds * sr), xf = Math.floor(X * sr);
      out = d.slice(0, n);
      for (let i = 0; i < xf; i++) {
        const w = i / xf;
        out[i] = d[i] * Math.sqrt(w) + d[n + i] * Math.sqrt(1 - w);
      }
      this.slice(t0);
      if (memo) memo.set(mk, out);
    }
    const b = E.ctx.createBuffer(1, out.length, sr);
    b.getChannelData(0).set(out);
    this.graphs.set(key, b);
    this.count++;
  }

  wantGraph(key, seconds, build, cb) {
    const k = 'graph:' + key;
    let cbs = this.inflight.get(k);
    if (cbs) { if (cb) cbs.push(cb); return; }
    this.inflight.set(k, cb ? [cb] : []);
    this.queue.push({ kind: 'graph', name: key, key: k, seconds, build });
    this.pump();
  }

  // builds one take of a recipe at time t0 on `ctx` (dry -> left channel,
  // reverb-only tail -> right channel); returns its length in seconds
  recipe(ctx, def, name, seed, t0) {
    const m = ctx.createChannelMerger(2);
    m.connect(ctx.destination);
    const vin = ctx.createGain(), vwet = ctx.createGain();
    vin.connect(m, 0, 0);
    vwet.connect(m, 0, 1);
    const v = {
      name, t: t0, end: t0, E: this.fake(ctx, seed), ctx, srcs: [], own: [], shared: {},
      dist: 0, panPos: 0, in: vin, wet: vwet, pan: null,
    };
    def.fn(v);
    for (const s of v.srcs) { try { s.stop(v.end + 0.03); } catch (e) { /* ok */ } }
    return v.end - t0;
  }

  async bakeSfx(name) {
    if (this.sfx.has(name)) return;
    const E = this.E, sr = E.sr, OAC = offlineClass();
    const def = SFX[name];
    if (!def || !OAC) return;
    const memo = assetMemo();
    const mk = 'bake:sfx:' + name + '@' + sr;
    let raw = memo ? memo.get(mk) : null;
    if (!raw) {
      raw = [];
      let t0 = perfNow();
      // dry runs on a throw-away context give each take's exact length (same
      // seed -> same random choices); short sounds get more takes
      const probe = new OAC(2, 128, sr);
      const seeds = [], lens = [], starts = [];
      let n = 1, total = 0;
      for (let i = 0; i < n; i++) {
        seeds.push(hashKey(name) + i * 7919 + 1);
        lens.push(this.recipe(probe, def, name, seeds[i], 0));
        if (i === 0) n = lens[0] < 0.7 ? 3 : lens[0] < 1.8 ? 2 : 1;
        starts.push(total);
        total += lens[i] + 0.08;
      }
      if (!E.offline) {
        // two short slices instead of one long one
        this.slice(t0);
        await new Promise((r) => whenIdle(r));
        t0 = perfNow();
      }
      // all takes laid end to end in one offline context: one render per sound
      const ctx = new OAC(2, Math.ceil(total * sr), sr);
      for (let i = 0; i < n; i++) this.recipe(ctx, def, name, seeds[i], starts[i]);
      const pending = ctx.startRendering();
      this.slice(t0);
      const buf = await pending;
      const t2 = perfNow();
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (let i = 0; i < n; i++) {
        const a = Math.floor(starts[i] * sr), b = Math.min(L.length, Math.floor((starts[i] + lens[i] + 0.04) * sr));
        const dry = trimTail(L.subarray(a, b), sr);
        if (dry) raw.push({ dry, wet: trimTail(R.subarray(a, b), sr) });
      }
      // takes differ in character, not in level: bring each to the set's
      // mean peak (within +-4 dB) so the calibrated trim holds for all of them
      const peaks = raw.map((r) => { let m = 1e-6; for (let i = 0; i < r.dry.length; i++) { const v = Math.abs(r.dry[i]); if (v > m) m = v; } return m; });
      const ref = Math.exp(peaks.reduce((acc, v) => acc + Math.log(v), 0) / Math.max(1, peaks.length));
      raw.forEach((r, i) => {
        const k = Math.max(0.63, Math.min(1.6, ref / peaks[i]));
        for (let j = 0; j < r.dry.length; j++) r.dry[j] *= k;
        if (r.wet) for (let j = 0; j < r.wet.length; j++) r.wet[j] *= k;
      });
      this.slice(t2);
      if (memo) memo.set(mk, raw);
    }
    const t1 = perfNow();
    const mkBuf = (x) => { const b = E.ctx.createBuffer(1, x.length, sr); b.getChannelData(0).set(x); return b; };
    const vars = raw.map((r) => ({
      dry: mkBuf(r.dry), wet: r.wet ? mkBuf(r.wet) : null,
      len: Math.max(r.dry.length, r.wet ? r.wet.length : 0) / sr,
    }));
    if (vars.length) { this.sfx.set(name, vars); this.count++; }
    this.slice(t1);
  }

  async bakeLoop(name) {
    if (this.loops.has(name)) return;
    const E = this.E, sr = E.sr, OAC = offlineClass();
    if (!LOOPS[name] || !OAC) return;
    const memo = assetMemo();
    const mk = 'bake:loop:' + name + '@' + sr;
    let out = memo ? memo.get(mk) : null;
    if (!out) {
      const len = LOOP_LEN[name], X = 0.5;
      let t0 = perfNow();
      const ctx = new OAC(1, Math.ceil((len + X) * sr), sr);
      const L = { name, E: this.fake(ctx, hashKey('loop:' + name)), ctx, t: 0, srcs: [], shared: {}, rates: [] };
      L.mix = ctx.createGain();
      L.mix.connect(ctx.destination);
      LOOPS[name](L);
      const pending = ctx.startRendering();
      this.slice(t0);
      const d = (await pending).getChannelData(0);
      t0 = perfNow();
      // seamless: the extra half second is cross-faded into the head
      const n = Math.floor(len * sr), xf = Math.floor(X * sr);
      out = d.slice(0, n);
      for (let i = 0; i < xf; i++) {
        const w = i / xf;
        out[i] = d[i] * Math.sqrt(w) + d[n + i] * Math.sqrt(1 - w);
      }
      this.slice(t0);
      if (memo) memo.set(mk, out);
    }
    const t1 = perfNow();
    const b = E.ctx.createBuffer(1, out.length, sr);
    b.getChannelData(0).set(out);
    this.loops.set(name, b);
    this.count++;
    this.slice(t1);
  }

  // background bake (real time): one at a time, never before the noise is in
  want(kind, name, cb) {
    const key = kind + ':' + name;
    let cbs = this.inflight.get(key);
    if (cbs) { if (cb) cbs.push(cb); return; }
    cbs = cb ? [cb] : [];
    this.inflight.set(key, cbs);
    this.queue.push({ kind, name, key });
    this.pump();
  }

  // everything else, in the background, one sound every ~150 ms: after the
  // first half minute no shot ever needs live synthesis again
  wantAll() {
    for (const name in SFX) {
      const b = SFX[name].alias || name;
      if (!this.sfx.has(b) && !this.inflight.has('sfx:' + b) && this.later.indexOf(b) < 0) this.later.push(b);
    }
    this.pump();
  }

  pump() {
    if (this.running || !this.ready()) return;
    if (!this.queue.length) {
      const next = this.later.shift();
      if (next === undefined) return;
      if (this.sfx.has(next) || this.inflight.has('sfx:' + next)) { this.pump(); return; }
      this.inflight.set('sfx:' + next, []);
      this.queue.push({ kind: 'sfx', name: next, key: 'sfx:' + next, slow: true });
    }
    this.running = true;
    const job = this.queue.shift();
    const done = () => {
      const cbs = this.inflight.get(job.key) || [];
      this.inflight.delete(job.key);
      for (const cb of cbs) { try { cb(); } catch (e) { /* ok */ } }
      const next = () => { this.running = false; this.pump(); };
      if (job.slow && !this.queue.length && typeof setTimeout === 'function') setTimeout(next, 150);
      else next();
    };
    // the set-up of a bake (building the recipe graph on a fresh offline
    // context) costs a few ms of main thread: do it in idle time
    whenIdle(() => {
      const run = job.kind === 'loop' ? this.bakeLoop(job.name)
        : job.kind === 'graph' ? this.bakeGraph(job.name, job.seconds, job.build) : this.bakeSfx(job.name);
      run.then(done, done);
    });
  }
}

// ---- engine ---------------------------------------------------------------------

export class AudioEngine {
  // opts: { offline, rng, seed, volumes, maxVoices, bypassMaster, noBake }
  constructor(ctx, opts) {
    const o = opts || {};
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.offline = !!o.offline;
    this.noBake = !!o.noBake;
    this.rng = o.rng || Math.random;
    this.vols = Object.assign({}, DEFAULT_VOLUMES, o.volumes || {});
    this.muted = false;
    this.maxVoices = o.maxVoices || 18;
    this.maxUi = 6;
    this.maxLoops = 14;
    this.voices = [];
    this.uiVoices = [];
    this.loops = [];
    this.timers = [];
    this.lastFire = {};
    this.th = { winStart: -1e9, winCount: 0, cat: {} };
    this.duckState = { gain: 1, until: -1 };
    this.stats = {
      fired: 0, dropped: 0, stolen: 0, peakVoices: 0, nodes: 0, tickMs: 0, ticks: 0,
      maxTickMs: 0, slowTicks: 0, musicEvents: 0, live: 0, maxFireMs: 0, initMs: 0,
    };
    this.everySecond = null; // optional host callback from the heartbeat
    const born = perfNow();
    this.lvl = { rms: 0, low: 0, mid: 0, high: 0, peak: 0 };
    this.lvlAt = -1;
    this.lookahead = 0.2;
    this.interval = null;
    this.bed = null;
    this.rumbleAt = Infinity;
    this.assets = new AssetBank(ctx, this.offline);
    if (this.offline) {
      this.assets.genNow('noise:white');
    } else {
      // every recipe may need noise immediately: a 93 ms stand-in is built on
      // the spot, the real beds arrive from the worker a moment later
      const ph = ctx.createBuffer(1, 4096, this.sr);
      const d = ph.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.7;
      this.placeholder = ph;
      this.assets.get('noise:white');
    }
    this.baker = new Baker(this);
    this.wire(o);
    this.music = new MusicDirector(this, o);
    // pre-rendered voice clips: live contexts only; the manifest is fetched in
    // idle time, the clips on first need
    this.voice = null;
    if (!this.offline && typeof VoiceBox === 'function') {
      try {
        this.voice = new VoiceBox(this);
        whenIdle(() => { try { this.voice.load(); } catch (e) { /* ok */ } });
      } catch (e) { this.voice = null; }
    }
    if (!this.offline) {
      this.assets.prewarm(['noise:pink', 'noise:brown', 'crackle']);
      // assigning a ConvolverNode's buffer builds its FFT kernel on the main
      // thread (~8-14 ms once): always done in idle time, never in a caller
      this.assets.get('ir:desert', (b) => whenIdle(() => { try { this.desertConv.buffer = b; } catch (e) { /* ok */ } }));
      // first use of an oscillator type builds its wavetables (~1 ms each)
      whenIdle(() => {
        try {
          for (const type of ['sine', 'triangle', 'square', 'sawtooth']) ctx.createOscillator().type = type;
        } catch (e) { /* ok */ }
      });
      // the sounds every session needs within seconds
      for (const n of ['ui_click', 'ui_hover', 'select_unit', 'order_move', 'rifle', 'explosion_small']) {
        this.baker.want('sfx', n);
      }
      this.baker.wantAll();
    } else {
      this.assets.get('noise:pink'); this.assets.get('noise:brown'); this.assets.get('crackle');
      this.desertConv.buffer = this.assets.get('ir:desert');
    }
    this.stats.initMs = perfNow() - born;
  }

  count(n) { this.stats.nodes += n; }

  // noise bed of a given colour; white stands in until the worker delivers
  noise(color) {
    return this.assets.get('noise:' + color) || this.assets.buf.get('noise:white') || this.placeholder;
  }

  crackle() {
    return this.assets.get('crackle') || this.assets.buf.get('noise:white') || this.placeholder;
  }

  panner(pan) {
    const ctx = this.ctx;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan || 0));
      return p;
    }
    return ctx.createGain();
  }

  wire(o) {
    const ctx = this.ctx;
    const bus = {};
    const G = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    // master chain
    bus.mix = G(1);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 24; hp.Q.value = 0.707;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = COMP.threshold; comp.knee.value = COMP.knee;
    comp.ratio.value = COMP.ratio; comp.attack.value = COMP.attack; comp.release.value = COMP.release;
    const compTrim = G(Math.pow(10, MAKEUP_DB / 20) / makeupOf(COMP));
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = LIM.threshold; lim.knee.value = LIM.knee;
    lim.ratio.value = LIM.ratio; lim.attack.value = LIM.attack; lim.release.value = LIM.release;
    const limTrim = G(1 / makeupOf(LIM));
    const clip = ctx.createWaveShaper();
    const N = 4097, curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1, a = Math.abs(x);
      const y = a <= CLIP_KNEE ? a
        : CLIP_KNEE + (CLIP_CEIL - CLIP_KNEE) * Math.tanh((a - CLIP_KNEE) / (CLIP_CEIL - CLIP_KNEE));
      curve[i] = x < 0 ? -y : y;
    }
    clip.curve = curve;
    bus.master = G(taper(this.vols.master));
    this.comp = comp; this.lim = lim;
    if (o.bypassMaster) {
      bus.mix.connect(bus.master);
    } else {
      bus.mix.connect(hp); hp.connect(comp); comp.connect(compTrim); compTrim.connect(lim);
      lim.connect(limTrim); limTrim.connect(clip); clip.connect(bus.master);
    }
    bus.master.connect(ctx.destination);
    if (typeof ctx.createAnalyser === 'function') {
      // the analysis tap is only wired in while somebody is reading it
      const an = ctx.createAnalyser();
      an.fftSize = 2048; an.smoothingTimeConstant = 0.55;
      an.minDecibels = -72; an.maxDecibels = -12;
      this.analyser = an;
      this.tapped = false;
      this.td = new Float32Array(an.fftSize);
      this.fd = new Uint8Array(an.frequencyBinCount);
    }
    // sfx side: voices, UI and loops all sum straight into the volume node
    bus.sfxVol = G(taper(this.vols.sfx));
    bus.sfxVol.connect(bus.mix);
    bus.sfx = bus.sfxVol; bus.ui = bus.sfxVol; bus.loop = bus.sfxVol;
    bus.desertSend = G(1);
    bus.desertSend.channelCount = 1; bus.desertSend.channelCountMode = 'explicit';
    // Both reverbs convolve with a MONO impulse response (a stereo one costs
    // twice as much and the convolver is the most expensive node there is);
    // the return is then widened by complementary comb taps:
    //   L = wet + a*wet(t-d1) - b*wet(t-d2),  R = wet - a*wet(t-d1) + b*wet(t-d2)
    // which decorrelates the channels and still sums to the plain mono tail.
    const widen = (src, dest, d1, d2) => {
      const merge = ctx.createChannelMerger(2);
      src.connect(merge, 0, 0); src.connect(merge, 0, 1);
      const taps = [[d1, 0.5], [d2, -0.35]];
      for (const [d, k] of taps) {
        const dly = ctx.createDelay(0.06);
        dly.delayTime.value = d;
        const pos = G(k), neg = G(-k);
        src.connect(dly); dly.connect(pos); dly.connect(neg);
        pos.connect(merge, 0, 0); neg.connect(merge, 0, 1);
      }
      merge.connect(dest);
    };
    this.desertConv = ctx.createConvolver();
    const dRet = G(0.5);
    bus.desertSend.connect(this.desertConv); this.desertConv.connect(dRet);
    widen(dRet, bus.sfxVol, 0.0127, 0.0193);
    this.sendBus = SEND_LEVELS.map((l) => { const g = G(l); g.connect(bus.desertSend); return g; });
    this.wetBus = WET_LEVELS.map((l) => { const g = G(l); g.connect(bus.desertSend); return g; });
    this.panBus = PAN_LEVELS.map((x) => { const p = this.panner(x); p.connect(bus.sfxVol); return p; });
    bus.loopSend = G(0.1);
    bus.loopSend.connect(bus.desertSend);
    // music side
    bus.musicVol = G(taper(this.vols.music) * MUSIC_TRIM);
    bus.musicVol.connect(bus.mix);
    bus.music = G(1); // also the ducking gain
    bus.music.connect(bus.musicVol);
    bus.stinger = bus.musicVol;
    // voice side: dry and centred, straight into the mix
    bus.voice = G(taper(this.vols.voice) * VOICE_TRIM);
    bus.voice.connect(bus.mix);
    bus.hallSend = G(1);
    bus.hallSend.channelCount = 1; bus.hallSend.channelCountMode = 'explicit';
    this.hallConv = ctx.createConvolver();
    const hRet = G(0.55);
    bus.hallSend.connect(this.hallConv); this.hallConv.connect(hRet);
    widen(hRet, bus.music, 0.0171, 0.0263);
    this.hallReturn = hRet;
    this.bus = bus;
    this.count(63);
  }

  // the hall is only needed once music or a stinger plays
  needHall() {
    if (this.hallAsked) return;
    this.hallAsked = true;
    const set = (buf) => { try { this.hallConv.buffer = buf; } catch (e) { /* ok */ } };
    const b = this.assets.get('ir:hall', (buf) => whenIdle(() => set(buf)));
    if (b) { if (this.offline) set(b); else whenIdle(() => set(b)); }
  }

  // Harness / loading screens: bake a list of sounds up front.
  // list: { sfx: [names], loops: [names] }
  async prebake(list) {
    if (!this.baker.can()) return;
    const seen = {};
    for (const n of (list.sfx || [])) {
      const def = SFX[n];
      const b = def ? (def.alias || n) : null;
      if (b && !seen[b]) { seen[b] = 1; await this.baker.bakeSfx(b); }
    }
    for (const n of (list.loops || [])) await this.baker.bakeLoop(n);
  }

  // ---- volumes / mute --------------------------------------------------------

  volume(kind, v) {
    if (!(kind in this.vols)) return;
    const val = clamp01(Number(v) || 0);
    this.vols[kind] = val;
    const t = this.ctx.currentTime;
    const g = taper(val);
    if (kind === 'master') this.ramp(this.bus.master.gain, this.muted ? 0 : g, t);
    else if (kind === 'sfx') this.ramp(this.bus.sfxVol.gain, g, t);
    else if (kind === 'music') this.ramp(this.bus.musicVol.gain, g * MUSIC_TRIM, t);
    else if (kind === 'voice') this.ramp(this.bus.voice.gain, g * VOICE_TRIM, t);
  }

  ramp(param, v, t) {
    try {
      param.cancelScheduledValues(t);
      param.setTargetAtTime(v, t, 0.03);
    } catch (e) {
      param.value = v;
    }
  }

  mute(on) {
    this.muted = !!on;
    this.ramp(this.bus.master.gain, this.muted ? 0 : taper(this.vols.master), this.ctx.currentTime);
    if (this.muted && this.voice) this.voice.stopAll();
  }

  // ---- music ducking (sidechain-style, driven by events not by a detector) ---

  duck(db, hold, release, when) {
    if (!(db > 0.2)) return;
    const now = this.ctx.currentTime;
    const t = Math.max(when === undefined ? now : when, now);
    let g = Math.pow(10, -Math.min(db, 12) / 20);
    const d = this.duckState;
    let until = t + (hold || 0.3);
    if (t < d.until) { g = Math.min(g, d.gain); until = Math.max(until, d.until); }
    const p = this.bus.music.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(g, t, 0.02);
    p.setTargetAtTime(1, until, (release || 0.6) / 3);
    d.gain = g; d.until = until;
  }

  unduck() {
    const now = this.ctx.currentTime;
    const p = this.bus.music.gain;
    p.cancelScheduledValues(now);
    p.setTargetAtTime(1, now, 0.25);
    this.duckState.until = now;
  }

  // ---- one-shot SFX voices ------------------------------------------------------

  // Schedules SFX `name`. pan -1..1, dist 0..1 (0 = at the camera focus),
  // gain 0..2, when = context time (default: now). Returns the voice or null
  // (unknown name, throttled, or no voice free at this priority).
  fire(name, pan, dist, gain, when) {
    const t0 = perfNow();
    const v = this.voice(name, pan, dist, gain, when);
    const ms = perfNow() - t0;
    if (ms > this.stats.maxFireMs) this.stats.maxFireMs = ms;
    return v;
  }

  voice(name, pan, dist, gain, when) {
    const def = SFX[name];
    if (!def) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t = Math.max(when === undefined || when === null ? now + 0.004 : when, now);
    pan = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
    dist = Number.isFinite(dist) ? clamp01(dist) : 0;
    gain = Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1;
    if (gain <= 0.0005) return null;
    const last = this.lastFire[name];
    if (last !== undefined && t - last < def.gap && t >= last) { this.stats.dropped++; return null; }
    const ui = def.cat === 'ui';
    const list = ui ? this.uiVoices : this.voices;
    const cap = ui ? this.maxUi : this.maxVoices;
    const prio = def.prio - dist * 1.5;
    if (!ui && this.throttled(def.cat, t, prio)) { this.stats.dropped++; return null; }
    let active = 0, victim = null;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.end <= t || v.stolen) continue;
      active++;
      if (!victim || v.prio < victim.prio || (v.prio === victim.prio && v.t < victim.t)) victim = v;
    }
    if (active >= cap) {
      if (!victim || victim.prio > prio) { this.stats.dropped++; return null; }
      this.steal(victim, t);
      active--;
    }
    this.lastFire[name] = t;
    const fall = 1 / (1 + 9 * dist * dist);
    const dens = ui ? 1 : 1 / (1 + 0.035 * active);
    const v = {
      name, t, end: t, prio, E: this, ctx, srcs: [], own: [], shared: {}, dist, panPos: pan,
      in: null, out: ctx.createGain(), wet: null, pan: null, send: null,
    };
    v.out.gain.value = def.lvl * gain * fall * dens;
    let head = v.out;
    let n = 1;
    if (!ui && dist > 0.25) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 650 + 19000 * Math.pow(1 - dist, 2.6);
      lp.Q.value = 0.5;
      lp.connect(v.out);
      head = lp;
      n++;
    }
    const sendAmt = Math.min(1.4, def.send * (1 + 3.2 * dist));
    const wetAmt = def.lvl * gain * dens * Math.sqrt(fall);
    if (ui) {
      v.out.connect(this.bus.ui);
    } else {
      if (def.pan) {
        // the sound moves across the field: it needs a panner of its own
        v.pan = this.panner(pan * 0.9);
        v.out.connect(v.pan);
        v.pan.connect(this.bus.sfx);
        n++;
      } else {
        v.out.connect(this.panBus[nearest(PAN_LEVELS, pan * 0.9)]);
      }
      v.out.connect(this.sendBus[nearest(SEND_LEVELS, sendAmt)]);
    }
    const bakeName = def.alias || name;
    const vars = this.noBake ? null : this.baker.sfx.get(bakeName);
    if (vars) {
      // baked: one buffer source (plus one for the reverb-only tail)
      const vr = vars[Math.floor(this.rng() * vars.length) % vars.length];
      const rate = vr.len < 2.2 ? 1 + (this.rng() - 0.5) * 0.07 : 1;
      const s = ctx.createBufferSource();
      s.buffer = vr.dry;
      s.playbackRate.value = rate;
      s.connect(head);
      s.start(t);
      v.srcs.push(s);
      n++;
      if (vr.wet && !ui) {
        const w = ctx.createBufferSource();
        w.buffer = vr.wet;
        w.playbackRate.value = rate;
        w.connect(this.wetBus[nearest(WET_LEVELS, wetAmt)]);
        w.start(t);
        v.srcs.push(w);
        n++;
      }
      v.end = t + vr.len / rate;
    } else {
      // live synthesis (first use of a sound, or baking unavailable)
      v.in = head;
      if (ui) {
        v.wet = head;
      } else {
        v.wet = ctx.createGain();
        v.wet.gain.value = wetAmt;
        v.wet.connect(this.bus.desertSend);
        v.send = v.wet;
        n++;
      }
      try {
        def.fn(v);
      } catch (e) {
        v.end = t; // a recipe must never take the engine down
      }
      for (let i = 0; i < v.srcs.length; i++) {
        try { v.srcs[i].stop(v.end + 0.03); } catch (e) { /* already stopped */ }
      }
      this.stats.live++;
      if (!this.offline && this.baker.can()) this.baker.want('sfx', bakeName);
    }
    if (def.pan && v.pan) { try { def.pan(v); } catch (e) { /* ok */ } }
    v.end += 0.05;
    this.count(n);
    list.push(v);
    this.stats.fired++;
    if (active + 1 > this.stats.peakVoices && !ui) this.stats.peakVoices = active + 1;
    if (def.duck) this.duck(def.duck[0] * gain * (1 - 0.75 * dist), def.duck[1], def.duck[2], t);
    return v;
  }

  // rate limiting: at most 6 new world voices per 100 ms and a per-category
  // cap per second; sounds that matter (prio >= 6) are never rate-limited
  throttled(cat, t, prio) {
    const th = this.th;
    if (t - th.winStart >= 0.1 || t < th.winStart) { th.winStart = t; th.winCount = 0; }
    let c = th.cat[cat];
    if (!c) c = th.cat[cat] = { start: -1e9, n: 0 };
    if (t - c.start >= 1 || t < c.start) { c.start = t; c.n = 0; }
    if (prio < 6 && (th.winCount >= WINDOW_CAP || c.n >= (CAT_CAP[cat] || 6))) return true;
    th.winCount++;
    c.n++;
    return false;
  }

  unthrottle() {
    this.th = { winStart: -1e9, winCount: 0, cat: {} };
    this.lastFire = {};
  }

  steal(v, t) {
    this.stats.stolen++;
    v.stolen = true; // fading out over the next 50 ms; no longer counts as a voice
    try {
      v.out.gain.cancelScheduledValues(t);
      v.out.gain.setTargetAtTime(0, t, 0.008);
      if (v.send) {
        v.send.gain.cancelScheduledValues(t);
        v.send.gain.setTargetAtTime(0, t, 0.008);
      }
      for (let i = 0; i < v.srcs.length; i++) {
        try { v.srcs[i].stop(t + 0.06); } catch (e) { /* ok */ }
      }
      for (let i = 0; i < v.own.length; i++) {
        try { v.own[i].stop(t + 0.06); } catch (e) { /* ok */ }
      }
    } catch (e) { /* ok */ }
    v.end = t + 0.05;
  }

  retire(list, now) {
    for (let i = list.length - 1; i >= 0; i--) {
      const v = list[i];
      if (v.end + 0.1 > now) continue;
      try {
        v.out.disconnect();
        if (v.pan) v.pan.disconnect();
        if (v.send) v.send.disconnect();
        for (let k = 0; k < v.srcs.length; k++) v.srcs[k].disconnect();
      } catch (e) { /* ok */ }
      list[i] = list[list.length - 1];
      list.pop();
    }
  }

  activeVoices() {
    const t = this.ctx.currentTime;
    let n = 0;
    for (let i = 0; i < this.voices.length; i++) if (this.voices[i].end > t && !this.voices[i].stolen) n++;
    return n;
  }

  // ---- loops --------------------------------------------------------------------

  loopStart(name) {
    if (!LOOPS[name]) return null;
    if (this.loops.length >= this.maxLoops) return null;
    let lp;
    try { lp = buildLoop(this, name); } catch (e) { return null; }
    this.loops.push(lp);
    return lp;
  }

  loopGone(lp) {
    const i = this.loops.indexOf(lp);
    if (i >= 0) this.loops.splice(i, 1);
  }

  // quiet desert ambience during matches: a soft wind bed
  ambience(on) {
    if (on) {
      if (this.bed) return;
      this.bed = this.loopStart('wind');
      if (this.bed) this.bed.set(0, 0.5, 0.3);
      // no far-off rumble: play-testers heard distant battle with no battle in
      // sight. The bed is wind only; combat is heard where it is seen.
      this.rumbleAt = Infinity;
    } else {
      if (this.bed) { try { this.bed.stop(); } catch (e) { /* ok */ } }
      this.bed = null;
      this.rumbleAt = Infinity;
    }
  }

  // ---- deferred callbacks on the context clock ------------------------------------

  after(time, fn) {
    this.timers.push({ time, fn });
  }

  // ---- analysis tap ---------------------------------------------------------------

  levels() {
    const L = this.lvl;
    const an = this.analyser;
    if (!an) return L;
    const nowMs = perfNow();
    if (nowMs - this.lvlAt < 10) return L;
    this.lvlAt = nowMs;
    if (!this.tapped) {
      this.tapped = true;
      try { this.bus.master.connect(an); } catch (e) { /* ok */ }
      return L; // first frame after (re)connecting has nothing to show yet
    }
    const td = this.td, fd = this.fd;
    an.getFloatTimeDomainData(td);
    let sum = 0, pk = 0;
    for (let i = 0; i < td.length; i++) {
      const s = td[i];
      sum += s * s;
      const a = s < 0 ? -s : s;
      if (a > pk) pk = a;
    }
    L.rms = clamp01(Math.sqrt(sum / td.length) * 3.2);
    L.peak = clamp01(pk);
    an.getByteFrequencyData(fd);
    const hz = this.sr / an.fftSize;
    const band = (f0, f1) => {
      const a = Math.max(1, Math.floor(f0 / hz)), b = Math.min(fd.length - 1, Math.ceil(f1 / hz));
      let s = 0;
      for (let i = a; i <= b; i++) s += fd[i];
      return clamp01(s / ((b - a + 1) * 255));
    };
    L.low = band(30, 250);
    L.mid = band(250, 2500);
    L.high = band(2500, 12000);
    return L;
  }

  // ---- heartbeat ------------------------------------------------------------------

  tick() {
    const t0 = perfNow();
    const now = this.ctx.currentTime;
    try {
      if (this.timers.length) {
        for (let i = this.timers.length - 1; i >= 0; i--) {
          const tm = this.timers[i];
          if (tm.time > now) continue;
          this.timers.splice(i, 1);
          try { tm.fn(now); } catch (e) { /* best-effort */ }
        }
      }
      this.music.advance(now);
      this.retire(this.voices, now);
      this.retire(this.uiVoices, now);
      if (this.baker.queue.length || this.baker.later.length) this.baker.pump();
      if (now >= this.rumbleAt && this.bed) {
        this.rumbleAt = now + 20 + this.rng() * 25;
        this.fire('amb_rumble', this.rng() * 1.6 - 0.8, 0.85, 1);
      }
      if (this.stats.ticks % 20 === 0) {
        if (this.everySecond) this.everySecond();
        // nobody has read the levels for 10 s: unhook the analyser again
        if (this.tapped && perfNow() - this.lvlAt > 10000) {
          this.tapped = false;
          try { this.bus.master.disconnect(this.analyser); } catch (e) { /* ok */ }
          const z = this.lvl;
          z.rms = z.low = z.mid = z.high = z.peak = 0;
        }
      }
    } catch (e) { /* the heartbeat must survive anything */ }
    const ms = perfNow() - t0;
    this.stats.tickMs += ms;
    this.stats.ticks++;
    if (ms > this.stats.maxTickMs) this.stats.maxTickMs = ms;
    if (ms > 8) this.stats.slowTicks++;
  }

  run() {
    if (this.offline || this.interval || typeof setInterval !== 'function') return;
    this.interval = setInterval(() => this.tick(), 50);
  }

  halt() {
    if (this.interval && typeof clearInterval === 'function') clearInterval(this.interval);
    this.interval = null;
  }

  dispose() {
    this.halt();
    try { this.music.halt(0); } catch (e) { /* ok */ }
    try { if (this.voice) this.voice.dispose(); } catch (e) { /* ok */ }
    for (const lp of this.loops.slice()) { try { lp.stop(); } catch (e) { /* ok */ } }
    try { this.bus.master.disconnect(); } catch (e) { /* ok */ }
    this.assets.dispose();
  }
}

// Renders `seconds` of audio through a fresh engine on an OfflineAudioContext.
// setup(engine) schedules the initial material (it may be async, e.g. to
// prebake); onTick(engine, t) is called every `step` seconds of rendered time
// (the same cadence as the real-time heartbeat) so look-ahead scheduling,
// voice retirement and scripted events behave exactly as they do live.
// Resolves to { buffer, engine, renderMs }.
export async function renderOffline(o) {
  const sr = o.sampleRate || 44100;
  const seconds = o.seconds;
  const OAC = offlineClass();
  const ctx = new OAC(2, Math.ceil(seconds * sr), sr);
  const engine = new AudioEngine(ctx, Object.assign({ offline: true }, o.engine || {}));
  if (o.setup) await o.setup(engine);
  const step = o.step || 0.05;
  engine.tick();
  const pump = (t) => {
    if (t >= seconds - 0.001) return;
    ctx.suspend(t).then(() => {
      engine.tick();
      if (o.onTick) { try { o.onTick(engine, ctx.currentTime); } catch (e) { /* ok */ } }
      pump(t + step);
      ctx.resume();
    }, () => { /* context finished */ });
  };
  pump(step);
  const t0 = perfNow();
  const buffer = await ctx.startRendering();
  const renderMs = perfNow() - t0;
  return { buffer, engine, renderMs };
}
