// Synthesized audio: all SFX are generated with the WebAudio API — no asset
// files, so the single-file build stays self-contained. Import-safe headless:
// every entry point no-ops when AudioContext is unavailable. The context is
// created lazily on the first user gesture (browser autoplay policy).

let ctx = null;
let master = null;
let windGain = null;
let volume = 0.7;
let muted = false;
const lastPlay = {}; // name -> timestamp (rate limiting)

const STORE_KEY = 'mca.audio.v1';

export function loadAudioPrefs() {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (typeof p.volume === 'number') volume = Math.max(0, Math.min(1, p.volume));
    if (typeof p.muted === 'boolean') muted = p.muted;
  } catch (e) { /* prefs are best-effort */ }
}

function saveAudioPrefs() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORE_KEY, JSON.stringify({ volume, muted }));
  } catch (e) { /* ignore */ }
}

export function audioVolume() { return volume; }
export function audioMuted() { return muted; }
export function setAudioVolume(v) {
  volume = Math.max(0, Math.min(1, v));
  saveAudioPrefs();
  applyGain();
}
export function setAudioMuted(m) {
  muted = !!m;
  saveAudioPrefs();
  applyGain();
}

function applyGain() {
  if (master && typeof master.gain !== 'undefined') {
    master.gain.value = muted ? 0 : volume * 0.9;
  }
}

// call from any user gesture; safe to call repeatedly
export function unlockAudio() {
  if (ctx || typeof AudioContext === 'undefined') return;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    applyGain();
    master.connect(ctx.destination);
    startWind();
  } catch (e) { ctx = null; }
  if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
}

// ---- primitive builders -------------------------------------------------------

function tone(freq, durMs, opts) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = (opts && opts.type) || 'sine';
  o.frequency.setValueAtTime(freq, ctx.currentTime);
  if (opts && opts.slide) {
    o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slide), ctx.currentTime + durMs / 1000);
  }
  const peak = (opts && opts.gain) || 0.2;
  g.gain.setValueAtTime(peak, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durMs / 1000);
  o.connect(g);
  g.connect(master);
  o.start();
  o.stop(ctx.currentTime + durMs / 1000 + 0.02);
}

let noiseBuf = null;
function getNoise() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

function noise(durMs, opts) {
  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = (opts && opts.filter) || 'lowpass';
  f.frequency.setValueAtTime((opts && opts.freq) || 800, ctx.currentTime);
  if (opts && opts.freqEnd) {
    f.frequency.exponentialRampToValueAtTime(opts.freqEnd, ctx.currentTime + durMs / 1000);
  }
  const g = ctx.createGain();
  const peak = (opts && opts.gain) || 0.25;
  g.gain.setValueAtTime(peak, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durMs / 1000);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start();
  src.stop(ctx.currentTime + durMs / 1000 + 0.02);
}

function startWind() {
  // barely-there desert ambience: looping filtered noise
  try {
    const src = ctx.createBufferSource();
    src.buffer = getNoise();
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 240;
    windGain = ctx.createGain();
    windGain.gain.value = 0.05;
    src.connect(f);
    f.connect(windGain);
    windGain.connect(master);
    src.start();
  } catch (e) { /* ambience is optional */ }
}

// ---- named effects --------------------------------------------------------------

const LIMITS = {
  shot: 90, explosion: 120, hit: 90, alarm: 4200, ack: 120,
  ready: 250, tick: 60, capture: 300,
};

export function sfx(name) {
  if (!ctx || muted) return;
  const now = performance.now();
  const lim = LIMITS[name];
  if (lim && lastPlay[name] && now - lastPlay[name] < lim) return;
  lastPlay[name] = now;
  try {
    switch (name) {
      case 'ui': tone(660, 60, { type: 'triangle', gain: 0.08 }); break;
      case 'tick': tone(520, 40, { type: 'square', gain: 0.05 }); break;
      case 'ack': tone(440, 70, { type: 'triangle', gain: 0.07 }); break;
      case 'error': tone(180, 180, { type: 'sawtooth', gain: 0.1, slide: 120 }); break;
      case 'buildStart': noise(140, { freq: 500, gain: 0.14 }); tone(140, 120, { gain: 0.1, slide: 90 }); break;
      case 'ready': tone(523, 110, { type: 'triangle', gain: 0.1 }); setTimeout(() => ctx && tone(784, 160, { type: 'triangle', gain: 0.1 }), 90); break;
      case 'trainDone': tone(587, 120, { type: 'triangle', gain: 0.09 }); break;
      case 'place': noise(180, { freq: 320, gain: 0.2 }); tone(90, 160, { gain: 0.14, slide: 55 }); break;
      case 'deploy': noise(260, { freq: 260, gain: 0.22 }); tone(70, 240, { gain: 0.16, slide: 45 }); break;
      case 'shot': noise(90, { freq: 1800 + Math.random() * 600, freqEnd: 300, gain: 0.07 }); break;
      case 'hit': noise(70, { freq: 1200, freqEnd: 250, gain: 0.05 }); break;
      case 'explosion':
        noise(450, { freq: 900, freqEnd: 90, gain: 0.24 });
        tone(110, 380, { gain: 0.16, slide: 35 });
        break;
      case 'bigExplosion':
        noise(900, { freq: 1100, freqEnd: 60, gain: 0.32 });
        tone(80, 700, { gain: 0.22, slide: 28 });
        break;
      case 'alarm':
        tone(880, 200, { type: 'square', gain: 0.07 });
        setTimeout(() => ctx && tone(660, 200, { type: 'square', gain: 0.07 }), 220);
        break;
      case 'swReady': tone(392, 200, { type: 'triangle', gain: 0.1 }); setTimeout(() => ctx && tone(587, 260, { type: 'triangle', gain: 0.1 }), 180); break;
      case 'swLaunch': noise(1200, { freq: 400, freqEnd: 2400, gain: 0.2, filter: 'bandpass' }); break;
      case 'capture': tone(330, 140, { type: 'triangle', gain: 0.09 }); setTimeout(() => ctx && tone(494, 200, { type: 'triangle', gain: 0.09 }), 130); break;
      case 'victory':
        [523, 659, 784, 1046].forEach((fq, i) => setTimeout(() => ctx && tone(fq, 260, { type: 'triangle', gain: 0.12 }), i * 160));
        break;
      case 'defeat':
        [392, 330, 262, 196].forEach((fq, i) => setTimeout(() => ctx && tone(fq, 320, { type: 'triangle', gain: 0.11 }), i * 200));
        break;
      default: break;
    }
  } catch (e) { /* never let audio break the game loop */ }
}
