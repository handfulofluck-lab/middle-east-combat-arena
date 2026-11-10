// Audio lab: preview page + verification harness for the MCA audio engine.
// Real-time controls drive the same public facade the game uses
// (../game/audio.js); the "offline" section renders the engine on an
// OfflineAudioContext and measures the result (peak, true peak, loudness,
// octave balance, onset timing, loop seams, voice counts, CPU estimate).
// Everything is also exposed as async functions on window.__audioLab so a
// headless harness can drive it.
import {
  unlockAudio, playSfx, playSfxAt, playMusicTrack, setMusicOn, setMusicIntensity, playStinger,
  startLoop, getLevels, getVolume, setVolume, setMuted, isMuted, playVoice, audioStats,
  audioInternals,
} from '../game/audio.js';
import { renderOffline, DEFAULT_VOLUMES } from './engine.js';
import { SFX, SFX_GROUPS } from './sfx.js';
import { LOOPS } from './loops.js';
import { TRACK_NAMES, STINGER_NAMES } from './music.js';
import { makeRng } from './dsp.js';
import { memoAssets } from './assetgen.js';
import {
  basicStats, mixdown, truePeakDb, loudness, octaveBands, OCTAVES, onsets, gridFit, seamCheck,
  activeSpan, wavBytes, toBase64, toDb,
} from './analysis.js';

memoAssets(true); // offline renders share generated buffers

const SR = 44100;
// Chrome's DynamicsCompressor fades in from zero gain during the first few
// tens of milliseconds of a context's life; one-shot measurements start
// after that so the numbers describe steady-state behaviour.
const T_FIRE = 0.5;
const UNITY = { master: 1, music: 1, sfx: 1, voice: 1 };
let last = null; // { chs, sr } of the most recent offline render

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

async function offline(seconds, engineOpts, setup, onTick) {
  const res = await renderOffline({ seconds, sampleRate: SR, engine: engineOpts, setup, onTick });
  const chs = [res.buffer.getChannelData(0), res.buffer.getChannelData(1)];
  last = { chs, sr: SR };
  return { chs, engine: res.engine, renderMs: res.renderMs, seconds };
}

// ---- offline: SFX ---------------------------------------------------------------------

async function renderSfx(name, o) {
  const opt = o || {};
  const seed = opt.seed === undefined ? 1234 : opt.seed;
  const pan = opt.pan || 0, dist = opt.dist || 0, gain = opt.gain === undefined ? 1 : opt.gain;
  const secs = opt.seconds || 7;
  let voiceEnd = 0;
  // pass 1: the live recipe, master chain bypassed -> click / DC / duration checks
  const dry = await offline(secs, { bypassMaster: true, noBake: true, volumes: UNITY, rng: makeRng(seed) },
    (E) => { const v = E.fire(name, pan, dist, gain, T_FIRE); voiceEnd = v ? v.end - T_FIRE : 0; });
  const dm = mixdown(dry.chs);
  const ds = basicStats(dm);
  const span = activeSpan(dm, SR, -60);
  let first = 0;
  for (let i = 0; i < dm.length; i++) { if (dm[i] !== 0) { first = Math.abs(dm[i]); break; } }
  let tail = 0;
  for (let i = dm.length - 441; i < dm.length; i++) tail = Math.max(tail, Math.abs(dm[i]));
  // pass 2: the baked buffer (what the game plays from the second shot on)
  // through the master chain at the default volumes -> level table
  let bakedLive = -1;
  const wet = await offline(secs, { volumes: DEFAULT_VOLUMES, rng: makeRng(seed) },
    async (E) => { await E.prebake({ sfx: [name] }); E.fire(name, pan, dist, gain, T_FIRE); bakedLive = E.stats.live; });
  const ws = [basicStats(wet.chs[0]), basicStats(wet.chs[1])];
  const loud = loudness(wet.chs, SR);
  const wm = mixdown(wet.chs);
  let rms50 = 0;
  const W = Math.floor(0.05 * SR);
  for (let st = 0; st + W <= wm.length; st += W >> 1) {
    let e = 0;
    for (let i = st; i < st + W; i++) e += wm[i] * wm[i];
    if (e > rms50) rms50 = e;
  }
  rms50 = Math.sqrt(rms50 / W);
  let wetTail = 0;
  for (let i = wm.length - 441; i < wm.length; i++) wetTail = Math.max(wetTail, Math.abs(wm[i]));
  const def = SFX[name] || {};
  return {
    name, cat: def.cat || '?', dur: r2(span.dur), voiceLen: r2(voiceEnd),
    dryPeakDb: r1(ds.peakDb), startRatio: ds.peak > 0 ? r2(first / ds.peak) : 0,
    tailDb: r1(toDb(tail)), dc: Number(ds.dc.toExponential(1)), nan: ds.nan + ws[0].nan + ws[1].nan,
    peakDb: r1(Math.max(ws[0].peakDb, ws[1].peakDb)), rms50Db: r1(toDb(rms50)), lufsM: r1(loud.momentaryMax),
    bakedTailDb: r1(toDb(wetTail)), baked: bakedLive === 0, silent: ds.peak < 0.003,
  };
}

async function renderAllSfx(o) {
  const names = [].concat(SFX_GROUPS.ui, SFX_GROUPS.weapons, SFX_GROUPS.impacts, SFX_GROUPS.world,
    SFX_GROUPS.legacy);
  const out = [];
  for (const n of names) out.push(await renderSfx(n, o));
  return out;
}

// distance model check: one SFX at several distances
async function renderDistance(name) {
  const out = [];
  for (const dist of [0, 0.25, 0.5, 0.75, 1]) {
    const r = await offline(5, { volumes: DEFAULT_VOLUMES, rng: makeRng(7) },
      async (E) => { await E.prebake({ sfx: [name] }); E.fire(name, 0, dist, 1, T_FIRE); });
    const m = mixdown(r.chs);
    const s = basicStats(m);
    const bands = octaveBands(m, SR);
    // early (direct) vs late (reverb) energy
    const cut = Math.floor((T_FIRE + 0.25) * SR);
    let early = 0, late = 0;
    for (let i = 0; i < m.length; i++) { if (i < cut) early += m[i] * m[i]; else late += m[i] * m[i]; }
    out.push({ dist, peakDb: r1(s.peakDb), highDb: r1(Math.max(bands[7], bands[8])),
      lateRatioDb: r1(10 * Math.log10((late + 1e-12) / (early + 1e-12))) });
  }
  return out;
}

// ---- offline: music ---------------------------------------------------------------------

function musicStats(res, info, o, t0, startBar) {
  const m = mixdown(res.chs);
  const sL = basicStats(res.chs[0]), sR = basicStats(res.chs[1]);
  const peakDb = Math.max(sL.peakDb, sR.peakDb);
  const sm = basicStats(m);
  const loud = loudness(res.chs, SR);
  const bands = octaveBands(m, SR);
  const out = {
    seconds: res.seconds, lufs: r1(loud.integrated), lufsM: r1(loud.momentaryMax), rmsDb: r1(sm.rmsDb),
    peakDb: r1(peakDb), truePeakDb: r1(truePeakDb(res.chs)), crestDb: r1(peakDb - sm.rmsDb),
    dc: Number(sm.dc.toExponential(1)), nan: sL.nan + sR.nan,
    bands: bands.map(r1),
    clipped: countClipped(res.chs),
    cpuPct: r2(res.renderMs / (res.seconds * 10)),
    nodesPerSec: r1(res.engine.stats.nodes / res.seconds),
    eventsPerSec: r1(res.engine.stats.musicEvents / res.seconds),
    tickMsPerSec: r2(res.engine.stats.tickMs / res.seconds),
  };
  const oneTempo = info && info.sections.every((s) => s.bpm === info.sections[0].bpm);
  if (info && (oneTempo || !startBar)) {
    // onsets against the sixteenth grid of the first section's tempo
    const first = info.sections[0];
    const sameTempo = oneTempo;
    const limit = sameTempo ? res.seconds : Math.min(res.seconds, info.sections[1].start + t0);
    const on = onsets(m.subarray(0, Math.floor(limit * SR)), SR);
    const fit = gridFit(on, 60 / first.bpm / 4, t0);
    out.onsets = fit.n; out.gridOffsetMs = r1(fit.medianMs); out.gridMadMs = r1(fit.madMs);
    out.gridWithin12 = r2(fit.within);
    if (o.seamAt !== undefined) {
      const sc = seamCheck(m, SR, o.seamAt);
      if (sc) {
        out.seam = { at: r2(o.seamAt), jumpRatio: r2(sc.jumpRatio), beforeDb: r1(sc.beforeDb),
          afterDb: r1(sc.afterDb), minWindowDb: r1(sc.minWindowDb), refDb: r1(sc.refDb) };
      }
    }
  }
  return out;
}

// timing only (the harness measures real CPU time around these calls)
function timing(res) {
  const st = res.engine.stats;
  return { seconds: res.seconds, renderMs: r1(res.renderMs), tickMs: r1(st.tickMs), assetMs: r1(res.engine.assets.genMs),
    nodes: st.nodes, musicEvents: st.musicEvents };
}

function countClipped(chs) {
  let n = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) if (c[i] >= 0.999 || c[i] <= -0.999) n++;
  return n;
}

// o: { seconds, intensity, startBar, solo, seed, volumes, seam (bool: start so
// the loop point falls mid-render) }
async function renderMusic(name, o) {
  const opt = Object.assign({ seconds: 40, intensity: 0, seed: 42 }, o || {});
  let info = null, seamAt;
  let startBar = opt.startBar || 0;
  const T0 = 0.12; // the director starts a track 120 ms after play()
  const res = await offline(opt.seconds,
    { volumes: opt.volumes || DEFAULT_VOLUMES, seed: opt.seed, rng: makeRng(opt.seed + 1) },
    (E) => {
      info = E.music.describe(name);
      if (opt.seam && info && info.loops) {
        // start `lead` seconds before the loop point
        const lead = opt.seconds / 2;
        let t = info.loopEnd, bars = info.bars, i = info.sections.length - 1;
        startBar = bars;
        while (i >= 0 && info.loopEnd - t < lead) {
          const s = info.sections[i];
          const barDur = 240 / s.bpm;
          let k = s.bars;
          while (k > 0 && info.loopEnd - t < lead) { t -= barDur; startBar--; k--; }
          i--;
        }
        seamAt = T0 + (info.loopEnd - t);
      }
      E.music.snap(opt.intensity);
      if (opt.noHall) E.hallAsked = true;
      if (opt.hallMono) {
        E.hallAsked = true;
        const ir = E.assets.get('ir:hall');
        const mono = E.ctx.createBuffer(1, ir.length, ir.sampleRate);
        mono.getChannelData(0).set(ir.getChannelData(0));
        E.hallConv.buffer = mono;
      }
      if (opt.hallCut) { E.needHall(); E.hallReturn.disconnect(); }
      E.music.play(name, { startBar, solo: opt.solo, only: opt.only });
    });
  if (opt.raw) return timing(res);
  const st = musicStats(res, info, opt, T0, startBar);
  if (seamAt !== undefined) {
    const sc = seamCheck(mixdown(res.chs), SR, seamAt);
    if (sc) {
      st.seam = { at: r2(seamAt), jumpRatio: r2(sc.jumpRatio), beforeDb: r1(sc.beforeDb),
        afterDb: r1(sc.afterDb), minWindowDb: r1(sc.minWindowDb), refDb: r1(sc.refDb) };
    }
  }
  st.name = name; st.intensity = opt.intensity; st.startBar = startBar;
  if (info) { st.bpm = info.bpm; st.formBars = info.bars; st.loopSec = r1(info.loopEnd - info.loopStart); }
  return st;
}

// intensity automation: 0 -> 1 at 10 s -> 0 at 25 s; reports the layer level over time
async function renderIntensitySweep() {
  const res = await offline(50, { volumes: DEFAULT_VOLUMES, seed: 3, rng: makeRng(4) },
    (E) => { E.music.snap(0); E.music.play('ambient'); },
    (E, t) => { E.music.intensity(t >= 10 && t < 25 ? 1 : 0); });
  const m = mixdown(res.chs);
  const win = SR; // 1 s RMS steps
  const curve = [];
  for (let s = 0; s + win <= m.length; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += m[i] * m[i];
    curve.push(r1(toDb(Math.sqrt(e / win))));
  }
  return { curve };
}

async function renderStinger(name) {
  const res = await offline(7, { volumes: DEFAULT_VOLUMES, seed: 5, rng: makeRng(6) },
    (E) => { E.music.stinger(name, T_FIRE); });
  const m = mixdown(res.chs);
  const s = basicStats(m);
  const loud = loudness(res.chs, SR);
  let tail = 0;
  for (let i = m.length - 441; i < m.length; i++) tail = Math.max(tail, Math.abs(m[i]));
  return { name, dur: r2(activeSpan(m, SR, -60).dur), peakDb: r1(s.peakDb), lufsM: r1(loud.momentaryMax),
    nan: s.nan, dc: Number(s.dc.toExponential(1)), tailDb: r1(toDb(tail)), silent: s.peak < 0.003 };
}

async function renderLoop(name) {
  let h = null;
  const res = await offline(8, { volumes: DEFAULT_VOLUMES, rng: makeRng(9) },
    async (E) => { await E.prebake({ loops: [name] }); h = E.loopStart(name); if (h) h.set(0, 0, 1); },
    (E, t) => { if (h && t >= 6 && !h.dead) h.stop(); });
  const m = mixdown(res.chs);
  const body = m.subarray(SR, 5 * SR);
  const s = basicStats(body);
  const bands = octaveBands(body, SR);
  let tail = 0;
  for (let i = m.length - 4410; i < m.length; i++) tail = Math.max(tail, Math.abs(m[i]));
  return { name, rmsDb: r1(s.rmsDb), peakDb: r1(s.peakDb), dc: Number(s.dc.toExponential(1)), nan: s.nan,
    bands: bands.map(r1), tailDb: r1(toDb(tail)), cpuPct: r2(res.renderMs / 80) };
}

// ---- stress test -----------------------------------------------------------------------

const STRESS_MIX = [
  // [name, events per second]
  ['rifle', 7], ['mg', 5], ['autocannon', 2.5], ['aa_gun', 1.5], ['cannon', 3.5], ['heavy_cannon', 0.6],
  ['atgm', 0.5], ['rocket', 0.7], ['mlrs', 0.15], ['sam', 0.2], ['naval_gun', 0.25], ['cruise', 0.08],
  ['bomb', 0.15], ['torpedo', 0.1],
  ['explosion_small', 3], ['explosion_medium', 2], ['explosion_large', 0.7], ['explosion_huge', 0.12],
  ['impact_metal', 4], ['impact_dirt', 4], ['water_splash', 0.4], ['building_collapse', 0.15],
  ['select_unit', 0.6], ['order_move', 0.5], ['order_attack', 0.4], ['ui_click', 0.8],
  ['unit_ready', 0.15], ['construction_done', 0.05], ['flyby', 0.12],
];

// a 200-unit battle: Poisson events per SFX at the rates above, random
// positions; returns [{ t, name, pan, dist, gain }] sorted by time
function stressEvents(seconds, rng) {
  const ev = [];
  for (const [name, rate] of STRESS_MIX) {
    let t = rng() / rate;
    while (t < seconds) {
      ev.push({ t, name, pan: rng() * 2 - 1, dist: Math.pow(rng(), 0.8), gain: 0.8 + rng() * 0.4 });
      t += -Math.log(1 - rng() * 0.9999) / rate;
    }
  }
  ev.sort((a, b) => a.t - b.t);
  return ev;
}

// o: { seconds, seed, volumes, maxVoices }
async function renderStress(o) {
  const opt = Object.assign({ seconds: 30, seed: 99 }, o || {});
  const rng = makeRng(opt.seed);
  const ev = stressEvents(opt.seconds - 1, rng);
  let idx = 0, maxVoices = 0, minComp = 0, minLim = 0, loops = [];
  const stingers = [[5, 'under_attack'], [14, 'unit_lost'], [20, 'superweapon_launch']];
  const res = await offline(opt.seconds,
    { volumes: opt.volumes || DEFAULT_VOLUMES, seed: opt.seed, rng: makeRng(opt.seed + 7), maxVoices: opt.maxVoices },
    async (E) => {
      await E.prebake({ sfx: STRESS_MIX.map((m) => m[0]), loops: ['engine', 'rotor', 'fire', 'wind'] });
      E.music.snap(1);
      E.music.play('battle');
      loops = ['engine', 'engine', 'rotor', 'fire', 'wind'].map((n) => E.loopStart(n));
      loops.forEach((h, i) => { if (h) h.set(i * 0.4 - 0.8, 0.2 + 0.15 * i, 0.9); });
    },
    (E, t) => {
      // fire everything that falls inside the next 50 ms, like live calls would
      while (idx < ev.length && ev[idx].t < t + 0.05) {
        const e = ev[idx++];
        E.fire(e.name, e.pan, e.dist, e.gain, Math.max(e.t, t));
      }
      while (stingers.length && stingers[0][0] <= t) E.music.stinger(stingers.shift()[1]);
      if (Math.floor(t * 20) % 160 === 0) E.duck(5, 2.5, 0.9); // a voice line every 8 s
      const v = E.activeVoices();
      if (v > maxVoices) maxVoices = v;
      if (E.comp.reduction < minComp) minComp = E.comp.reduction;
      if (E.lim.reduction < minLim) minLim = E.lim.reduction;
    });
  const E = res.engine;
  if (opt.raw) return Object.assign(timing(res), { fired: E.stats.fired, maxVoices });
  const st = musicStats(res, null, opt, 0);
  // share of samples in the soft-clipper's curved region (> its knee)
  const knee = 0.70 * Math.pow(opt.volumes ? opt.volumes.master : DEFAULT_VOLUMES.master, 2);
  let hot = 0;
  for (const c of res.chs) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) > knee) hot++;
  return Object.assign(st, {
    name: 'stress', events: ev.length, fired: E.stats.fired, dropped: E.stats.dropped, stolen: E.stats.stolen,
    maxVoices, peakVoices: E.stats.peakVoices, voiceCap: E.maxVoices, liveSynth: E.stats.live,
    compReductionDb: r1(minComp), limiterReductionDb: r1(minLim),
    clipperPct: Number((100 * hot / (res.chs[0].length * 2)).toFixed(4)),
    loops: loops.filter(Boolean).length,
  });
}

// master chain transfer curve: steady 440 Hz sine in (dBFS at the mix bus,
// all volumes at 1.0) -> peak out. Quiet material must pass at the fixed
// make-up gain; nothing may exceed the soft-clip ceiling (-1.38 dBFS).
async function renderCalibration() {
  const run = async (dbIn) => {
    const amp = Math.pow(10, dbIn / 20);
    const res = await offline(2, { volumes: UNITY },
      (E) => {
        const o = E.ctx.createOscillator(), g = E.ctx.createGain();
        o.frequency.value = 440; g.gain.value = amp;
        o.connect(g); g.connect(E.bus.mix); o.start(0);
      });
    const all = basicStats(res.chs[0]);
    const seg = res.chs[0].subarray(SR, 2 * SR);
    return { steady: r2(basicStats(seg).peakDb), overshoot: r2(all.peakDb) };
  };
  const out = { curve: {} };
  for (const d of [-40, -30, -20, -14, -10, -6, -3, 0, 6, 12, 20]) out.curve[d] = await run(d);
  out.quietGainDb = r2(out.curve[-40].steady + 40);
  out.ceilingDb = r2(Math.max(...Object.values(out.curve).map((c) => c.overshoot)));
  return out;
}

// Calibration aid: finds, for each SFX, the `lvl` trim that puts its output
// peak (baked path, default volumes, dist 0) on a target. targets:
// { name: peakDb }. Returns { name: lvl } to paste into sfx.js.
async function calibrateSfx(targets) {
  const out = {};
  for (const name of Object.keys(targets)) {
    const def = SFX[name];
    if (!def) continue;
    let peak = 0;
    for (let it = 0; it < 7; it++) {
      const r = await offline(2.8, { volumes: DEFAULT_VOLUMES, rng: makeRng(11) },
        async (E) => { await E.prebake({ sfx: [name] }); E.fire(name, 0, 0, 1, T_FIRE); });
      peak = Math.max(basicStats(r.chs[0]).peakDb, basicStats(r.chs[1]).peakDb);
      const err = targets[name] - peak;
      if (Math.abs(err) < 0.25) break;
      // above the compressor threshold a dB in is about half a dB out
      def.lvl *= Math.pow(10, Math.max(-12, Math.min(12, err * 1.35)) / 20);
    }
    out[name] = { lvl: Number(def.lvl.toPrecision(3)), peakDb: r1(peak) };
  }
  return out;
}

function lastWav() {
  if (!last) return null;
  return toBase64(wavBytes(last.chs, last.sr));
}

// ---- full verification -----------------------------------------------------------------

async function verifyAll(log) {
  const say = log || (() => {});
  const out = {};
  say('master calibration…');
  out.calibration = await renderCalibration();
  say('SFX…');
  out.sfx = await renderAllSfx();
  out.distance = await renderDistance('cannon');
  say('stingers / loops…');
  out.stingers = [];
  for (const n of STINGER_NAMES) out.stingers.push(await renderStinger(n));
  out.loops = [];
  for (const n of Object.keys(LOOPS)) out.loops.push(await renderLoop(n));
  say('music…');
  out.music = [];
  out.music.push(await renderMusic('title', { seconds: 60 }));
  out.music.push(await renderMusic('title', { seconds: 40, seam: true }));
  out.music.push(await renderMusic('menu', { seconds: 60 }));
  out.music.push(await renderMusic('menu', { seconds: 40, seam: true }));
  out.music.push(await renderMusic('briefing', { seconds: 45 }));
  out.music.push(await renderMusic('briefing', { seconds: 40, seam: true }));
  for (const I of [0, 0.5, 1]) out.music.push(await renderMusic('ambient', { seconds: 45, intensity: I }));
  out.music.push(await renderMusic('ambient', { seconds: 40, intensity: 1, seam: true }));
  out.music.push(await renderMusic('victory', { seconds: 45 }));
  out.music.push(await renderMusic('defeat', { seconds: 30 }));
  out.sweep = await renderIntensitySweep();
  say('stress…');
  out.stress = await renderStress({ seconds: 30 });
  out.stressLoud = await renderStress({ seconds: 30, volumes: UNITY });
  say('done');
  return out;
}

// ---- real-time side ---------------------------------------------------------------------

const rtLoops = {};

async function rtStress(seconds) {
  const secs = seconds || 30;
  unlockAudio();
  setMusicOn(null, true);
  playMusicTrack(null, 'battle');
  setMusicIntensity(1);
  const hs = ['engine', 'rotor', 'fire'].map((n) => startLoop(null, n));
  hs.forEach((h, i) => { if (h) h.set(i * 0.6 - 0.6, 0.3, 0.9); });
  const rng = Math.random;
  const ev = stressEvents(secs, rng);
  const t0 = performance.now();
  const s0 = audioStats();
  let idx = 0, maxVoices = 0, peak = 0, rmsSum = 0, n = 0, maxFrame = 0, lastFrame = performance.now();
  let raf = 0;
  const frame = () => {
    const now = performance.now();
    if (now - lastFrame > maxFrame) maxFrame = now - lastFrame;
    lastFrame = now;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      while (idx < ev.length && ev[idx].t <= t) {
        const e = ev[idx++];
        playSfxAt(null, e.name, e.pan, e.dist, e.gain);
      }
      const st = audioStats();
      if (st.voices > maxVoices) maxVoices = st.voices;
      const L = getLevels();
      if (L.peak > peak) peak = L.peak;
      rmsSum += L.rms; n++;
      if (t >= secs) { clearInterval(iv); resolve(); }
    }, 25);
  });
  cancelAnimationFrame(raf);
  hs.forEach((h) => { if (h) h.stop(); });
  const s1 = audioStats();
  const dt = (performance.now() - t0) / 1000;
  setMusicIntensity(0);
  return {
    seconds: r1(dt), state: s1.state, events: ev.length, fired: s1.fired - s0.fired,
    dropped: s1.dropped - s0.dropped, stolen: s1.stolen - s0.stolen, maxVoices,
    peakDb: r1(toDb(peak)), meanRms: r2(rmsSum / Math.max(1, n)),
    schedulerMsPerSec: r2((s1.tickMs - s0.tickMs) / dt), maxTickMs: r2(s1.maxTickMs),
    nodesPerSec: r1((s1.nodes - s0.nodes) / dt), maxFrameMs: r1(maxFrame), worker: s1.worker,
    assetMs: r1(s1.assetMs),
  };
}

// ---- page -------------------------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label, fn, cls) {
  const b = el('button', cls || '', label);
  b.addEventListener('click', () => { unlockAudio(); fn(); });
  return b;
}

function slider(label, min, max, value, fn) {
  const wrap = el('label', 'slider');
  const span = el('span', '', label + ' ' + value);
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = min; inp.max = max; inp.step = (max - min) / 100; inp.value = value;
  inp.addEventListener('input', () => { span.textContent = label + ' ' + Number(inp.value).toFixed(2); fn(Number(inp.value)); });
  wrap.appendChild(span); wrap.appendChild(inp);
  return wrap;
}

function table(rows, cols) {
  const t = el('table');
  const hr = el('tr');
  for (const c of cols) hr.appendChild(el('th', '', c));
  t.appendChild(hr);
  for (const r of rows) {
    const tr = el('tr');
    for (const c of cols) {
      const v = r[c];
      tr.appendChild(el('td', '', Array.isArray(v) ? v.join(' ') : (v && typeof v === 'object' ? JSON.stringify(v) : String(v === undefined ? '' : v))));
    }
    t.appendChild(tr);
  }
  return t;
}

function buildPage() {
  const root = document.getElementById('lab');
  if (!root) return;
  const pos = { pan: 0, dist: 0, gain: 1 };

  const top = el('section');
  top.appendChild(el('h2', '', 'Transport'));
  top.appendChild(button('Unlock audio', () => {}));
  const muteBtn = button('Mute', () => { setMuted(null, !isMuted()); muteBtn.textContent = isMuted() ? 'Unmute' : 'Mute'; });
  top.appendChild(muteBtn);
  for (const k of ['master', 'music', 'sfx', 'voice']) {
    top.appendChild(slider(k, 0, 1, getVolume(k), (v) => setVolume(k, v)));
  }
  root.appendChild(top);

  const mus = el('section');
  mus.appendChild(el('h2', '', 'Music'));
  for (const n of TRACK_NAMES) mus.appendChild(button(n, () => { setMusicOn(null, true); playMusicTrack(null, n); }));
  mus.appendChild(button('stop', () => playMusicTrack(null, null), 'warn'));
  mus.appendChild(slider('intensity', 0, 1, 0, (v) => setMusicIntensity(v)));
  mus.appendChild(el('h3', '', 'Stingers'));
  for (const n of STINGER_NAMES) mus.appendChild(button(n, () => playStinger(null, n)));
  mus.appendChild(el('h3', '', 'Voice (speechSynthesis)'));
  mus.appendChild(button('EVA: under attack', () => playVoice(null, 'Egypt', 'attack')));
  root.appendChild(mus);

  const sfx = el('section');
  sfx.appendChild(el('h2', '', 'SFX'));
  sfx.appendChild(slider('pan', -1, 1, 0, (v) => { pos.pan = v; }));
  sfx.appendChild(slider('dist', 0, 1, 0, (v) => { pos.dist = v; }));
  sfx.appendChild(slider('gain', 0, 2, 1, (v) => { pos.gain = v; }));
  for (const g of Object.keys(SFX_GROUPS)) {
    sfx.appendChild(el('h3', '', g));
    for (const n of SFX_GROUPS[g]) {
      sfx.appendChild(button(n, () => {
        if (pos.pan === 0 && pos.dist === 0 && pos.gain === 1) playSfx(null, n);
        else playSfxAt(null, n, pos.pan, pos.dist, pos.gain);
      }));
    }
  }
  sfx.appendChild(el('h3', '', 'Loops (toggle)'));
  for (const n of Object.keys(LOOPS)) {
    const b = button(n, () => {
      if (rtLoops[n]) { rtLoops[n].stop(); rtLoops[n] = null; b.classList.remove('on'); } else {
        rtLoops[n] = startLoop(null, n);
        if (rtLoops[n]) { rtLoops[n].set(pos.pan, pos.dist, pos.gain); b.classList.add('on'); }
      }
    });
    sfx.appendChild(b);
  }
  root.appendChild(sfx);

  const met = el('section');
  met.appendChild(el('h2', '', 'Meters'));
  const canvas = document.createElement('canvas');
  canvas.width = 520; canvas.height = 120;
  met.appendChild(canvas);
  const info = el('pre', 'info', '');
  met.appendChild(info);
  const out = el('div', 'out');
  met.appendChild(button('Stress test (30 s, real time)', async () => {
    info.dataset.busy = '1';
    const r = await rtStress(30);
    out.textContent = '';
    out.appendChild(table([r], Object.keys(r)));
    info.dataset.busy = '';
  }, 'warn'));
  root.appendChild(met);
  const g2 = canvas.getContext('2d');
  let hold = 0, prev = null, prevAt = 0;
  const draw = () => {
    const L = getLevels();
    hold = Math.max(L.peak || 0, hold * 0.985);
    g2.fillStyle = '#12151b'; g2.fillRect(0, 0, canvas.width, canvas.height);
    const bars = [['peak', hold], ['rms', L.rms], ['low', L.low], ['mid', L.mid], ['high', L.high]];
    bars.forEach((b, i) => {
      const y = 8 + i * 22;
      g2.fillStyle = '#2a303a'; g2.fillRect(60, y, 440, 14);
      g2.fillStyle = b[1] > 0.9 ? '#e0563f' : '#c8a23a'; g2.fillRect(60, y, 440 * Math.min(1, b[1]), 14);
      g2.fillStyle = '#cfd6e2'; g2.font = '11px monospace'; g2.fillText(b[0], 8, y + 11);
    });
    const now = performance.now();
    if (now - prevAt > 500) {
      const s = audioStats();
      let cpu = '';
      if (prev && s.ready) {
        const dt = (now - prevAt) / 1000;
        cpu = 'scheduler ' + ((s.tickMs - prev.tickMs) / dt).toFixed(2) + ' ms/s (' + ((s.tickMs - prev.tickMs) / dt / 10).toFixed(3)
          + ' % main thread) · nodes/s ' + ((s.nodes - prev.nodes) / dt).toFixed(0);
      }
      prev = s; prevAt = now;
      info.textContent = s.ready
        ? 'ctx ' + s.state + ' · track ' + s.track + ' · intensity ' + s.intensity.toFixed(2) + ' · voices ' + s.voices
          + ' (peak ' + s.peakVoices + ') · loops ' + s.loops + '\nfired ' + s.fired + ' dropped ' + s.dropped + ' stolen '
          + s.stolen + ' · peak ' + toDb(hold).toFixed(1) + ' dBFS · ' + cpu + '\nassets ' + s.assets + ' ('
          + (s.worker ? 'worker' : 'main thread ' + s.assetMs.toFixed(0) + ' ms') + ')'
        : 'audio locked — click anything';
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  const ver = el('section');
  ver.appendChild(el('h2', '', 'Offline verification'));
  const status = el('span', 'status', '');
  const res = el('div', 'out');
  ver.appendChild(button('Run full offline verification', async () => {
    const r = await verifyAll((m) => { status.textContent = ' ' + m; });
    res.textContent = '';
    res.appendChild(el('h3', '', 'Master chain'));
    res.appendChild(table(Object.keys(r.calibration.curve).map((k) => Object.assign({ inDb: k }, r.calibration.curve[k])),
      ['inDb', 'steady', 'overshoot']));
    res.appendChild(el('h3', '', 'Music (octave bands: ' + OCTAVES.join(' / ') + ' Hz, dB re total)'));
    res.appendChild(table(r.music, ['name', 'intensity', 'startBar', 'lufs', 'rmsDb', 'peakDb', 'truePeakDb', 'crestDb',
      'bands', 'onsets', 'gridOffsetMs', 'gridMadMs', 'gridWithin12', 'seam', 'cpuPct', 'nodesPerSec', 'nan']));
    res.appendChild(el('h3', '', 'Stress (default volumes / all volumes at 1.0)'));
    res.appendChild(table([r.stress, r.stressLoud], ['lufs', 'peakDb', 'truePeakDb', 'crestDb', 'clipped', 'bands',
      'events', 'fired', 'dropped', 'stolen', 'maxVoices', 'voiceCap', 'compReductionDb', 'limiterReductionDb',
      'clipperPct', 'cpuPct', 'nodesPerSec']));
    res.appendChild(el('h3', '', 'SFX'));
    res.appendChild(table(r.sfx, ['name', 'cat', 'dur', 'voiceLen', 'peakDb', 'rms50Db', 'dryPeakDb', 'startRatio',
      'tailDb', 'bakedTailDb', 'baked', 'dc', 'nan', 'silent']));
    res.appendChild(el('h3', '', 'Stingers'));
    res.appendChild(table(r.stingers, Object.keys(r.stingers[0])));
    res.appendChild(el('h3', '', 'Loops'));
    res.appendChild(table(r.loops, Object.keys(r.loops[0])));
    res.appendChild(el('h3', '', 'Distance model (cannon)'));
    res.appendChild(table(r.distance, Object.keys(r.distance[0])));
  }, 'warn'));
  ver.appendChild(status);
  ver.appendChild(res);
  root.appendChild(ver);
}

const api = {
  ready: true,
  list: () => ({ sfx: SFX_GROUPS, tracks: TRACK_NAMES, stingers: STINGER_NAMES, loops: Object.keys(LOOPS) }),
  renderSfx, renderAllSfx, renderDistance, renderMusic, renderIntensitySweep, renderStinger, renderLoop,
  renderStress, renderCalibration, verifyAll, lastWav, calibrateSfx,
  rt: {
    unlock: () => unlockAudio(),
    play: (n) => { setMusicOn(null, true); playMusicTrack(null, n); },
    intensity: (x) => setMusicIntensity(x),
    sfx: (n, pan, dist, gain) => (pan === undefined ? playSfx(null, n) : playSfxAt(null, n, pan, dist, gain)),
    stinger: (n) => playStinger(null, n),
    loop: (n) => startLoop(null, n),
    levels: () => Object.assign({}, getLevels()),
    stats: () => audioStats(),
    internals: () => audioInternals(),
    stress: rtStress,
  },
};
if (typeof window !== 'undefined') {
  window.__audioLab = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPage);
  else buildPage();
}
