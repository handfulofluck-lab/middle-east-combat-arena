// Central audio module — public facade over the synthesis engine in
// ../audio/ (v1.0 audio rebuild). Everything is synthesised at runtime with
// the Web Audio API: layered SFX, an adaptive orchestral-hybrid score,
// positional one-shots, renderer-owned loops, per-faction EVA voice lines
// (speechSynthesis) and a quiet desert ambience bed during matches.
//
// Contract:
//  - every public function is guarded: with no AudioContext, speechSynthesis
//    or localStorage (headless harnesses, privacy mode) calls are silent
//    no-ops and never throw;
//  - the AudioContext is created lazily on the first user gesture
//    (unlockAudio; this module also listens for the first pointer / key
//    event itself so menu music can start before the HUD exists);
//  - nothing here touches sim state, and nothing blocks a frame: asset
//    generation runs in a worker and all scheduling is on the audio clock.
//
// Persisted preferences (localStorage): mca_muted, mca_music ('0' = off;
// music is ON by default), mca.vol.master / .music / .sfx / .voice.
import { AudioEngine } from '../audio/engine.js';
import { SFX } from '../audio/sfx.js';

let __game = null;       // stored by initAudio (the ambience bed watches .state)
let __ctx = null;        // AudioContext, created by unlockAudio on a gesture
let __eng = null;        // AudioEngine bound to __ctx
let __dead = false;      // engine construction failed once: stay silent
let __muted = false;     // persisted to localStorage 'mca_muted'
let __musicOn = true;    // persisted to 'mca_music' — ON unless the user turned it off
let __track = null;      // requested music track (remembered while audio is locked)
let __intensity = 0;     // requested adaptive intensity 0..1
let __ambWanted = false; // ambience bed should run (set by initAudio)
let __suspendTimer = null;

const VOLUME_DEFAULTS = { master: 0.9, music: 0.55, sfx: 0.8, voice: 0.9 };
const __vol = { master: 0.9, music: 0.55, sfx: 0.8, voice: 0.9 };
let __volLoaded = false;
let __legacyVol = null;   // last seen value of the legacy 'mca_vol' slider key
let __legacyAt = -Infinity;

const MUSIC_TRACKS = { title: 1, menu: 1, briefing: 1, ambient: 1, battle: 1, victory: 1, defeat: 1 };
const LOOP_KINDS = { rotor: 1, jet: 1, engine: 1, fire: 1, wind: 1, waves: 1 };
// minimum seconds between two stingers of the same name
const STINGER_GAP = {
  match_start: 4, under_attack: 6, superweapon_ready: 4, superweapon_launch: 4,
  unit_lost: 2.5, objective: 1.5, countdown: 0.4,
};
const __stingerAt = {};
const __handles = [];     // live startLoop handles (bound to the engine once it exists)
const ZERO_LEVELS = { rms: 0, low: 0, mid: 0, high: 0, peak: 0 };

// voice cooldown: at most one line per key per 6s; 'unit' additionally speaks
// only every 3rd eligible trigger and never within 15s of an 'attack' alert
const __voiceAt = {};
let __unitCount = 0;
let __attackVoiceAt = -Infinity;

// speechSynthesis voice availability: lang prefix -> bool; negatives are
// cached only once the voice list is non-empty, and the whole cache drops on
// voiceschanged (voices often load after the first getVoices() call)
let __voiceCache = {};
let __voiceWatched = false;

// ---- EVA voice lines (Grok review slice 4) -----------------------------------
// byFaction: BCP-47 lang + short RTS-EVA lines per key.
const VOICE_KEYS = ['online', 'built', 'unit', 'harv', 'attack', 'lost', 'structLost',
  'captured'];
const VOICES = {
  Egypt: {
    lang: 'ar-EG',
    lines: {
      online: 'القيادة شغالة يا باشا',
      built: 'المبنى خلص يا باشا',
      unit: 'الوحدة جاهزة يا معلم',
      harv: 'الحصادة نزلت تشتغل في البترول',
      attack: 'القاعدة بتتهجم يا جدعان',
      lost: 'ضيعنا الوحدة',
      structLost: 'المبنى اتهدّم',
      captured: 'المبنى بقى بتاعنا',
    },
    // v0.4.1: per-building Egyptian-dialect lines for everything Egypt can
    // build (All-faction SH-01..SH-11 + Sa'ka Tent + October Battery)
    builtById: {
      'SH-01': 'القاعدة جاهزة يا باشا',
      'SH-02': 'الكهربا اشتغلت',
      'SH-03': 'البترول بيضخ',
      'SH-04': 'الثكنة جهزت',
      'SH-05': 'مصنع المدرعات شغال',
      'SH-06': 'المطار جاهز',
      'SH-07': 'الميناء جاهز',
      'SH-08': 'مركز القيادة اتفتح',
      'SH-09': 'الدفاعات اتنصبت',
      'SH-10': 'الدفاعات اتنصبت',
      'SH-11': 'الدفاعات اتنصبت',
      'SH-12': 'خيمة الصاعقة جهزت',
      'SH-13': 'السلاح الثقيل جاهز',
    },
  },
  Saudi: {
    lang: 'ar-SA',
    lines: {
      online: 'غرفة القيادة جاهزة',
      built: 'اكتمل البناء',
      unit: 'الوحدة جاهزة',
      harv: 'الحاصدة تشتغل',
      attack: 'قاعدتنا تحت الهجوم',
      lost: 'فقدنا الوحدة',
      structLost: 'فقدنا المبنى',
      captured: 'المبنى صار لنا',
    },
    builtByType: {
      Core: 'المقر الرئيسي اكتمل',
      Eco: 'الطاقة والموارد شغالة',
      Prod: 'مبنى الإنتاج جاهز',
      Def: 'الدفاعات جاهزة',
      Tech: 'مركز التقنية اكتمل',
      SW: 'السلاح الاستراتيجي جاهز',
    },
  },
  UAE: {
    lang: 'ar-AE',
    lines: {
      online: 'القيادة متصلة',
      built: 'البناء اكتمل',
      unit: 'الوحدة جاهزة',
      harv: 'الحصاد جاري',
      attack: 'القاعدة تتعرض لهجوم',
      lost: 'خسرنا وحدة',
      structLost: 'خسرنا مبنى',
      captured: 'المبنى صار تحت سيطرتنا',
    },
    builtByType: {
      Core: 'القاعدة الأم جاهزة',
      Eco: 'الطاقة شغالة',
      Prod: 'مبنى الإنتاج جاهز',
      Def: 'الدفاعات منصوبة',
      Tech: 'مركز القيادة التقني جاهز',
      SW: 'السلاح الثقيل جاهز',
    },
  },
  Algeria: {
    lang: 'fr-FR',
    lines: {
      online: 'Systèmes en ligne',
      built: 'Construction terminée',
      unit: 'Unité prête',
      harv: 'Récolte en cours',
      attack: 'Notre base est attaquée',
      lost: 'Unité perdue',
      structLost: 'Bâtiment détruit',
      captured: 'Bâtiment capturé',
    },
    builtByType: {
      Core: 'Base principale opérationnelle',
      Eco: 'Économie en marche',
      Prod: 'Site de production prêt',
      Def: 'Défenses en place',
      Tech: 'Centre technique opérationnel',
      SW: 'Arme lourde prête',
    },
  },
  Turkey: {
    lang: 'tr-TR',
    lines: {
      online: 'Komuta çevrimiçi',
      built: 'İnşaat tamamlandı',
      unit: 'Birim hazır',
      harv: 'Hasat sürüyor',
      attack: 'Üssümüz saldırı altında',
      lost: 'Birim kaybedildi',
      structLost: 'Bina yıkıldı',
      captured: 'Bina ele geçirildi',
    },
    builtByType: {
      Core: 'Ana üs hazır',
      Eco: 'Enerji ve ekonomi aktif',
      Prod: 'Üretim binası hazır',
      Def: 'Savunmalar kuruldu',
      Tech: 'Teknoloji merkezi açıldı',
      SW: 'Ağır silah hazır',
    },
  },
  Israel: {
    lang: 'he-IL',
    lines: {
      online: 'המערכות מקוונות',
      built: 'הבנייה הושלמה',
      unit: 'היחידה מוכנה',
      harv: 'הקציר פעיל',
      attack: 'הבסיס תחת מתקפה',
      lost: 'איבדנו יחידה',
      structLost: 'איבדנו מבנה',
      captured: 'המבנה נכבש',
    },
    builtByType: {
      Core: 'הבסיס הראשי מוכן',
      Eco: 'אנרגיה ומשאבים פעילים',
      Prod: 'מבנה הייצור מוכן',
      Def: 'ההגנות הוצבו',
      Tech: 'מרכז הטכנולוגיה נפתח',
      SW: 'הנשק הכבד מוכן',
    },
  },
  Iran: {
    lang: 'fa-IR',
    lines: {
      online: 'فرماندهی آنلاین شد',
      built: 'ساخت و ساز کامل شد',
      unit: 'یگان آماده است',
      harv: 'برداشت در جریان است',
      attack: 'پایگاه تحت حمله است',
      lost: 'یگان را از دست دادیم',
      structLost: 'ساختمان را از دست دادیم',
      captured: 'ساختمان به تصرف ما درآمد',
    },
    builtByType: {
      Core: 'پایگاه اصلی آماده است',
      Eco: 'انرژی و اقتصاد فعال شد',
      Prod: 'ساختمان تولید آماده است',
      Def: 'دفاع‌ها نصب شد',
      Tech: 'مرکز فناوری باز شد',
      SW: 'سلاح سنگین آماده است',
    },
  },
  India: {
    lang: 'hi-IN',
    lines: {
      online: 'कमान ऑनलाइन है',
      built: 'निर्माण पूरा हुआ',
      unit: 'यूनिट तैयार है',
      harv: 'कटाई जारी है',
      attack: 'बेस पर हमला हो रहा है',
      lost: 'यूनिट खो गई',
      structLost: 'इमारत नष्ट हो गई',
      captured: 'इमारत हमारे कब्ज़े में है',
    },
    builtByType: {
      Core: 'मुख्य बेस तैयार है',
      Eco: 'ऊर्जा और अर्थव्यवस्था चालू',
      Prod: 'उत्पादन भवन तैयार',
      Def: 'रक्षा स्थापित',
      Tech: 'तकनीकी केंद्र खुला',
      SW: 'भारी हथियार तैयार',
    },
  },
  Pakistan: {
    lang: 'ur-PK',
    lines: {
      online: 'کمانڈ آن لائن ہے',
      built: 'تعمیر مکمل ہو گئی',
      unit: 'یونٹ تیار ہے',
      harv: 'کٹائی جاری ہے',
      attack: 'ہمارے اڈے پر حملہ ہو رہا ہے',
      lost: 'ہم نے یونٹ کھو دیا',
      structLost: 'عمارت تباہ ہو گئی',
      captured: 'عمارت ہمارے قبضے میں ہے',
    },
    builtByType: {
      Core: 'مرکزی اڈہ تیار ہے',
      Eco: 'توانائی اور معیشت فعال',
      Prod: 'پیداواری عمارت تیار',
      Def: 'دفاع نصب ہو گئے',
      Tech: 'ٹیکنالوجی سینٹر کھل گیا',
      SW: 'بھاری ہتھیار تیار',
    },
  },
  default: {
    lang: 'en-US',
    lines: {
      online: 'Command online',
      built: 'Construction complete',
      unit: 'Unit ready',
      harv: 'Harvesting underway',
      attack: 'Our base is under attack',
      lost: 'Unit lost',
      structLost: 'Structure lost',
      captured: 'Structure captured',
    },
  },
};

// ---- tiny guarded helpers ------------------------------------------------------

function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
}

function lsGet(k) {
  try {
    if (globalThis.localStorage) return globalThis.localStorage.getItem(k);
  } catch (e) { /* privacy mode / headless: keep default */ }
  return null;
}

function lsSet(k, v) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(k, v);
  } catch (e) { /* best-effort */ }
}

function clamp01(v) {
  const n = Number(v);
  if (!(n === n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// the engine modules are absent when a harness inlines this file on its own
function engineClass() {
  return (typeof AudioEngine === 'function') ? AudioEngine : null;
}

function sfxTable() {
  return (typeof SFX === 'object' && SFX) ? SFX : null;
}

function contextClass() {
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

function musicPref() {
  const mu = lsGet('mca_music');
  return !(mu === '0' || mu === 'false'); // ON by default
}

// ---- volumes -------------------------------------------------------------------

function loadVolumes() {
  if (__volLoaded) return;
  __volLoaded = true;
  for (const k in VOLUME_DEFAULTS) {
    const s = lsGet('mca.vol.' + k);
    if (s !== null && s !== undefined && s !== '' && isFinite(Number(s))) __vol[k] = clamp01(s);
  }
  // the pre-1.0 menu slider wrote a single master volume to 'mca_vol':
  // honour it until the player sets a master volume through the new API
  __legacyVol = lsGet('mca_vol');
  if (lsGet('mca.vol.master') === null && __legacyVol !== null && __legacyVol !== ''
      && isFinite(Number(__legacyVol))) {
    __vol.master = clamp01(__legacyVol);
  }
}

// the legacy slider keeps working live: when its key changes, adopt it
function pollLegacyVolume(now) {
  if (now - __legacyAt < 400) return;
  __legacyAt = now;
  const s = lsGet('mca_vol');
  if (s === __legacyVol) return;
  __legacyVol = s;
  if (s !== null && s !== '' && isFinite(Number(s))) setVolume('master', Number(s));
}

function voiceVolume() {
  loadVolumes();
  return clamp01(__vol.voice * Math.min(1, __vol.master / 0.9));
}

// ---- engine lifecycle ------------------------------------------------------------

function syncMusic() {
  if (!__eng) return;
  __eng.music.play(__musicOn ? __track : null);
}

function syncAmbient() {
  if (!__eng) return;
  if (__game && __game.state === null) __ambWanted = false; // match is gone
  __eng.ambience(__ambWanted);
}

function bindLoop(h) {
  if (!__eng || h.real || h.dead) return;
  h.real = __eng.loopStart(h.name);
  if (h.real) h.real.set(h.pan, h.dist, h.gain, h.pitch);
}

function applyMuteState() {
  if (!__eng || !__ctx) return;
  __eng.mute(__muted);
  if (__suspendTimer !== null && typeof clearTimeout === 'function') clearTimeout(__suspendTimer);
  __suspendTimer = null;
  if (__muted) {
    // let the fade finish, then stop the audio thread altogether (zero CPU)
    const stop = () => {
      __suspendTimer = null;
      try {
        if (__muted && __ctx && __ctx.state === 'running' && typeof __ctx.suspend === 'function') {
          const p = __ctx.suspend();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (e) { /* ok */ }
    };
    if (typeof setTimeout === 'function') __suspendTimer = setTimeout(stop, 200);
  } else {
    resumeContext();
  }
}

function resumeContext() {
  try {
    if (__ctx && __ctx.state !== 'running' && !__muted && typeof __ctx.resume === 'function') {
      const p = __ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (e) { /* best-effort */ }
}

// ---- speechSynthesis voice availability ---------------------------------------
// Never speak Arabic/Hebrew/Farsi/etc text through an English engine: before
// using a faction's native lines, require an installed voice whose lang
// starts with the set's language prefix ('ar' for ar-EG); otherwise fall back
// to the English default lines.

function watchVoices(synth) {
  if (__voiceWatched) return;
  __voiceWatched = true;
  try {
    const clear = () => { __voiceCache = {}; };
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', clear);
    } else {
      synth.onvoiceschanged = clear;
    }
  } catch (e) { /* best-effort */ }
}

function hasVoiceFor(synth, lang) {
  const prefix = String(lang || '').split('-')[0].toLowerCase();
  if (!prefix) return false;
  if (__voiceCache[prefix] !== undefined) return __voiceCache[prefix];
  try {
    const vs = typeof synth.getVoices === 'function' ? synth.getVoices() : null;
    if (!vs || !vs.length) return false; // not loaded yet: re-check next call
    let ok = false;
    for (const v of vs) {
      const vl = String(v && v.lang || '').toLowerCase();
      if (vl.indexOf(prefix) === 0) { ok = true; break; }
    }
    __voiceCache[prefix] = ok;
    return ok;
  } catch (e) {
    return false;
  }
}

// ---- public API ------------------------------------------------------------------

export function initAudio(game) {
  try {
    __game = game || null;
    resetAudioThrottles();
    const m = lsGet('mca_muted');
    if (m !== null && m !== undefined) __muted = m === '1' || m === 'true';
    __musicOn = musicPref();
    loadVolumes();
    stopAmbient();      // never leak the previous match's bed
    __ambWanted = true; // match start: run the ambience bed
    syncAmbient();
    applyMuteState();
  } catch (e) { /* never throws */ }
}

// clear every throttle (SFX rate limits, stinger and per-key voice
// cooldowns): a rematch starting seconds after the last battle must not
// inherit the previous match's cooldowns. Called from initAudio and by the
// HUD on every new match.
export function resetAudioThrottles() {
  try {
    for (const k in __voiceAt) delete __voiceAt[k];
    for (const k in __stingerAt) delete __stingerAt[k];
    __unitCount = 0;
    __attackVoiceAt = -Infinity;
    if (__eng) __eng.unthrottle();
  } catch (e) { /* never throws */ }
}

// Call from a user gesture (any pointer / key event). The first call creates
// the AudioContext and the engine; later calls only resume a suspended
// context, so it is cheap enough to hang on every input event.
export function unlockAudio() {
  try {
    if (__eng) { resumeContext(); return; }
    if (__dead) return;
    const EC = engineClass(), AC = contextClass();
    if (!EC || !AC) return; // headless harness / unsupported browser: stay silent
    loadVolumes();
    const m = lsGet('mca_muted');
    if (m !== null && m !== undefined) __muted = m === '1' || m === 'true';
    __musicOn = musicPref();
    try {
      __ctx = new AC({ latencyHint: 'interactive' });
      __eng = new EC(__ctx, { volumes: __vol });
    } catch (e) {
      __dead = true;
      try { if (__ctx && typeof __ctx.close === 'function') __ctx.close(); } catch (e2) { /* ok */ }
      __ctx = null; __eng = null;
      return;
    }
    __eng.music.intensity(__intensity);
    __eng.run();
    applyMuteState();
    resumeContext();
    syncMusic();
    syncAmbient();
    for (let i = 0; i < __handles.length; i++) bindLoop(__handles[i]);
  } catch (e) { /* never throws */ }
}

function emit(name, pan, dist, gain, positional) {
  try {
    if (__muted) return;
    const eng = __eng;
    if (eng && __game && __game.state === null && __ambWanted) syncAmbient();
    const table = sfxTable();
    const def = table ? table[name] : null;
    if (!def) return; // unknown name: silent no-op
    if (!eng || !__ctx || __ctx.state !== 'running') return; // inaudible pre-gesture
    pollLegacyVolume(nowMs());
    if (!positional && (def.cat === 'light' || def.cat === 'heavy' || def.cat === 'impact')) {
      // battlefield sounds without a position still sit in the world, not in the ear
      pan = Math.random() * 0.7 - 0.35;
      dist = 0.15 + Math.random() * 0.15;
    }
    eng.fire(name, pan, dist, gain);
  } catch (e) { /* audio is best-effort */ }
}

// One-shot, non-positional. Unknown names are ignored.
export function playSfx(game, name) {
  emit(name, 0, 0, 1, false);
}

// Positional one-shot from the 3D world. pan -1..1 (screen x), dist 0..1
// (0 = at the camera focus, 1 = far / off-screen: quieter, darker, wetter),
// gain 0..2 (default 1).
export function playSfxAt(game, name, pan, dist, gain) {
  emit(name, Number(pan) || 0, Number(dist) || 0, gain === undefined ? 1 : Number(gain), true);
}

// name: 'title' | 'menu' | 'briefing' | 'ambient' | 'battle' | 'victory' |
// 'defeat' | null (stop). Cross-fades; asking for the track that is already
// playing is a no-op. 'ambient' and 'battle' are one adaptive piece ('battle'
// holds its intensity at >= 0.62); drive it with setMusicIntensity.
export function playMusicTrack(game, name) {
  try {
    __track = (typeof name === 'string' && MUSIC_TRACKS[name] === 1) ? name : null;
    syncMusic(); // remembered until the first gesture / setMusicOn otherwise
  } catch (e) { /* never throws */ }
}

export function setMusicOn(game, on) {
  try {
    __musicOn = !!on;
    lsSet('mca_music', __musicOn ? '1' : '0');
    syncMusic();
  } catch (e) { /* never throws */ }
}

// 0 = sparse / tense exploration layer ... 1 = full combat percussion + brass.
// Smoothed inside the engine (attack ~1 s, release ~6 s).
export function setMusicIntensity(x) {
  try {
    __intensity = clamp01(x);
    if (__eng) __eng.music.intensity(__intensity);
  } catch (e) { /* never throws */ }
}

// Musical cue over the current track: 'match_start' | 'under_attack' |
// 'superweapon_ready' | 'superweapon_launch' | 'unit_lost' | 'objective' |
// 'countdown'. Follows the music on/off preference and the music volume.
export function playStinger(game, name) {
  try {
    if (__muted || !__musicOn) return;
    const gap = STINGER_GAP[name];
    if (gap === undefined) return;
    if (!__eng || !__ctx || __ctx.state !== 'running') return;
    const now = __ctx.currentTime;
    if (__stingerAt[name] !== undefined && now - __stingerAt[name] < gap) return;
    __stingerAt[name] = now;
    __eng.music.stinger(name);
  } catch (e) { /* never throws */ }
}

// Continuous loop owned by the caller: 'rotor' | 'jet' | 'engine' | 'fire' |
// 'wind' | 'waves'. Returns { set(pan, dist, gain[, pitch]), stop() } or null
// (unknown name, no Web Audio, or too many loops). A handle obtained before
// the first user gesture starts sounding once audio unlocks.
export function startLoop(game, name) {
  try {
    if (LOOP_KINDS[name] !== 1 || __dead) return null;
    if (!engineClass() || !contextClass()) return null;
    if (__handles.length >= 14) return null;
    const h = {
      name, real: null, dead: false, pan: 0, dist: 0.25, gain: 0.8, pitch: 1,
      set(pan, dist, gain, pitch) {
        try {
          if (h.dead) return;
          if (pan === pan && pan !== undefined) h.pan = Number(pan) || 0;
          if (dist === dist && dist !== undefined) h.dist = Number(dist) || 0;
          if (gain === gain && gain !== undefined) h.gain = Number(gain) || 0;
          if (pitch === pitch && pitch !== undefined) h.pitch = Number(pitch) || 1;
          if (h.real) h.real.set(h.pan, h.dist, h.gain, h.pitch);
        } catch (e) { /* best-effort */ }
      },
      stop() {
        try {
          if (h.dead) return;
          h.dead = true;
          const i = __handles.indexOf(h);
          if (i >= 0) __handles.splice(i, 1);
          if (h.real) h.real.stop();
          h.real = null;
        } catch (e) { /* best-effort */ }
      },
    };
    __handles.push(h);
    bindLoop(h);
    return h;
  } catch (e) {
    return null;
  }
}

// Analysis tap for audio-reactive visuals: { rms, low, mid, high } in 0..1
// (plus peak). Cheap — reads one AnalyserNode, at most once per ~10 ms — and
// returns the same object every call, so do not hold on to old values.
export function getLevels() {
  try {
    if (__eng && !__muted) return __eng.levels();
  } catch (e) { /* never throws */ }
  return ZERO_LEVELS;
}

// kind: 'master' | 'music' | 'sfx' | 'voice'; values 0..1, persisted.
export function getVolume(kind) {
  try {
    loadVolumes();
    return (kind in VOLUME_DEFAULTS) ? __vol[kind] : 0;
  } catch (e) { /* never throws */ }
  return 0;
}

export function setVolume(kind, v) {
  try {
    if (!(kind in VOLUME_DEFAULTS)) return;
    loadVolumes();
    __vol[kind] = clamp01(v);
    lsSet('mca.vol.' + kind, String(__vol[kind]));
    if (__eng) __eng.volume(kind, __vol[kind]);
  } catch (e) { /* never throws */ }
}

export function playVoice(game, faction, key, detail) {
  try {
    if (__muted) return;
    const synth = globalThis.speechSynthesis;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    if (!synth || typeof synth.speak !== 'function' || typeof Utterance !== 'function') return;
    if (VOICE_KEYS.indexOf(key) < 0) return;
    const now = nowMs();
    if (__voiceAt[key] !== undefined && now - __voiceAt[key] < 6000) return; // 6s/key
    // 'unit' spam guard: at most every 3rd eligible trigger, and never while
    // an 'attack' alert spoke within the last 15s ('harv' unchanged)
    if (key === 'unit') {
      if (now - __attackVoiceAt < 15000) return;
      __unitCount++;
      if (__unitCount % 3 !== 1) return;
    }
    watchVoices(synth);
    let set = VOICES[faction] || VOICES.default;
    // never speak Arabic/Hebrew/Farsi/etc through an English engine: without
    // a matching installed voice, fall back to the English default lines
    if (set !== VOICES.default && set.lang && !hasVoiceFor(synth, set.lang)) {
      set = VOICES.default;
    }
    // v0.4.1 per-building lines: for 'built', detail = { id, type } from the
    // HUD; resolution: exact defId -> structure type -> faction generic ->
    // English default
    let line = null;
    if (key === 'built' && detail) {
      if (detail.id && set.builtById && set.builtById[detail.id]) {
        line = set.builtById[detail.id];
      }
      if (!line && detail.type && set.builtByType && set.builtByType[detail.type]) {
        line = set.builtByType[detail.type];
      }
    }
    if (!line) line = set && set.lines ? set.lines[key] : null;
    if (!line && set !== VOICES.default) line = VOICES.default.lines[key];
    if (!line) return;
    __voiceAt[key] = now;
    if (key === 'attack') __attackVoiceAt = now;
    pollLegacyVolume(now);
    const vol = voiceVolume();
    if (vol <= 0) return;
    const u = new Utterance(line);
    if (set.lang) u.lang = set.lang;
    u.rate = 1.05;
    u.volume = vol; // 0.9 at the default voice / master volumes
    // duck the score under the line; released when the utterance ends (the
    // duck also times out on its own if the browser never reports the end)
    const eng = __eng;
    if (eng && __ctx && __ctx.state === 'running') {
      eng.duck(5, 3.5, 0.9);
      const release = () => { try { eng.unduck(); } catch (e) { /* ok */ } };
      u.onend = release;
      u.onerror = release;
    }
    synth.speak(u);
  } catch (e) { /* speechSynthesis missing or busy: never throws */ }
}

export function setMuted(game, muted) {
  try {
    __muted = !!muted;
    lsSet('mca_muted', __muted ? '1' : '0');
    applyMuteState();
  } catch (e) { /* never throws */ }
}

export function isMuted(game) {
  return __muted;
}

// public match-exit hook: drop the ambience bed and don't restart it until
// the next initAudio
export function stopAmbient() {
  try {
    __ambWanted = false;
    if (__eng) __eng.ambience(false);
  } catch (e) { /* never throws */ }
}

// persisted music preference (localStorage 'mca_music'); music is ON unless
// the player turned it off — main.js initializes game.musicOn from this so
// the toggle starts truthful
export function getMusicOn() {
  try {
    __musicOn = musicPref();
    return __musicOn;
  } catch (e) { /* never throws */ }
  return true;
}

// ---- diagnostics (audio lab / perf overlays; not part of the game contract) ----

export function audioStats() {
  try {
    if (!__eng) return { ready: false, state: __ctx ? __ctx.state : 'none' };
    const s = __eng.stats;
    return {
      ready: true, state: __ctx.state, track: __eng.music.name, intensity: __eng.music.value,
      voices: __eng.activeVoices(), peakVoices: s.peakVoices, loops: __eng.loops.length,
      fired: s.fired, dropped: s.dropped, stolen: s.stolen, nodes: s.nodes,
      tickMs: s.tickMs, ticks: s.ticks, maxTickMs: s.maxTickMs, musicEvents: s.musicEvents,
      assets: __eng.assets.built, assetMs: __eng.assets.genMs, worker: !!__eng.assets.worker,
      baked: __eng.baker.count, live: s.live,
      // longest synchronous main-thread slices (ms): engine construction, one
      // scheduler tick, one playSfx call, one bake set-up, one asset hand-over
      initMs: s.initMs, maxFireMs: s.maxFireMs, maxBakeMs: __eng.baker.maxSliceMs,
      maxStoreMs: __eng.assets.maxStoreMs,
    };
  } catch (e) { /* never throws */ }
  return { ready: false, state: 'error' };
}

export function audioInternals() {
  return { engine: __eng, ctx: __ctx };
}

// first-gesture unlock independent of the HUD (title / menu music)
try {
  if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    const kick = () => { unlockAudio(); };
    window.addEventListener('pointerdown', kick, true);
    window.addEventListener('keydown', kick, true);
    window.addEventListener('touchend', kick, true);
  }
} catch (e) { /* headless: nothing to hook */ }
