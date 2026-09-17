// Central audio module (v0.3.7): synthesized SFX, generative music loops,
// per-faction EVA voice lines, and a quiet always-on battlefield bed during
// matches. No assets — oscillators + one shared noise buffer +
// speechSynthesis, every public function guarded so headless test stubs (no
// AudioContext / speechSynthesis / localStorage) never throw and audio never
// blocks a frame. The UI only calls these functions; sim state is never
// touched here.

let __game = null;       // stored by initAudio (ambient bed watches .state)
let __ctx = null;        // shared AudioContext, created lazily on first gesture
let __noiseBuf = null;   // one shared 2KB (2048-sample) white-noise buffer
let __muted = false;     // persisted to localStorage 'mca_muted'
let __musicOn = false;   // persisted to 'mca_music' — OFF by default
let __musicTrack = null; // desired track: 'ambient' | 'battle' | null
let __musicNodes = null; // live node set of the running track
let __musicGain = null;  // master music gain (0.15 * masterVol, 0 while muted)

// ambient battlefield bed (independent of the music toggle)
let __ambNodes = null;      // live bed nodes (hum + mute gate)
let __ambGain = null;       // bed mute gate (0 while muted)
let __ambWanted = false;    // bed should run (set by initAudio, cleared on match end)
let __thunderAt = Infinity; // nowMs() when the next distant rumble fires
let __thunderCount = 0;     // deterministic 20-45s interval schedule

// SFX throttle: max 8 per 100ms window, drop overflow; shots max 12/s on top.
let __winStart = -Infinity, __winCount = 0;
let __shotStart = -Infinity, __shotCount = 0;

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

// master volume 0..1 from the HUD slider (localStorage 'mca_vol'); read per
// call so mid-match slider moves take effect immediately
function masterVol() {
  const v = lsGet('mca_vol');
  if (v === null || v === undefined || v === '') return 1;
  const n = Number(v);
  if (!isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function ensureCtx() {
  if (__ctx) return __ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null; // headless test stub: no audio, no throw
  try { __ctx = new AC(); } catch (e) { __ctx = null; }
  return __ctx;
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

// shared 2KB white-noise buffer for shot/boom (and the battle music ticks)
function noiseBuf(ctx) {
  if (__noiseBuf) return __noiseBuf;
  const len = 2048;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate || 44100);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  __noiseBuf = buf;
  return buf;
}

function throttled(name, now) {
  if (now - __winStart >= 100) { __winStart = now; __winCount = 0; }
  if (__winCount >= 8) return true;
  if (name === 'shot') {
    if (now - __shotStart >= 1000) { __shotStart = now; __shotCount = 0; }
    if (__shotCount >= 12) return true;
    __shotCount++;
  }
  __winCount++;
  return false;
}

// one enveloped oscillator tone; freq2 jumps at t0+at2 for two-tone effects
function tone(ctx, o) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.freq, o.t0);
  if (o.freq2 !== undefined) osc.frequency.setValueAtTime(o.freq2, o.t0 + (o.at2 || o.dur / 2));
  g.gain.setValueAtTime(o.gain, o.t0);
  g.gain.linearRampToValueAtTime(0.0001, o.t0 + o.dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(o.t0);
  osc.stop(o.t0 + o.dur + 0.02);
}

// enveloped slice of the shared noise buffer, optionally through a filter;
// ffreq2 sweeps the filter frequency over dur, dest overrides the output
// (the ambient bed routes through its mute gate instead of ctx.destination)
function noiseHit(ctx, t0, dur, ftype, ffreq, vol, ffreq2, dest) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf(ctx);
  src.loop = true;
  let node = src;
  if (ftype) {
    const f = ctx.createBiquadFilter();
    f.type = ftype;
    f.frequency.setValueAtTime(ffreq, t0);
    if (ffreq2 !== undefined) {
      f.frequency.exponentialRampToValueAtTime(Math.max(1, ffreq2), t0 + dur);
    }
    src.connect(f);
    node = f;
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  node.connect(g);
  g.connect(dest || ctx.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// ---- generative music ------------------------------------------------------------
// Static node graphs (oscillators + LFOs, one looping noise source for battle):
// nothing is scheduled or allocated per frame. Master gain 0.15 (0 when muted).

function stopMusic() {
  if (!__musicNodes) return;
  for (const n of __musicNodes) {
    try { if (typeof n.stop === 'function') n.stop(); } catch (e) { /* ok */ }
    try { if (typeof n.disconnect === 'function') n.disconnect(); } catch (e) { /* ok */ }
  }
  __musicNodes = null;
  __musicGain = null;
}

function startMusic(ctx) {
  stopMusic();
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(__muted ? 0 : 0.15 * masterVol(), t0);
  master.connect(ctx.destination);
  const nodes = [master];
  const mk = (type, freq) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.start(t0);
    nodes.push(o);
    return o;
  };
  // slow drone: two slightly detuned low sines, breathing via a slow LFO
  const droneGain = ctx.createGain();
  droneGain.gain.setValueAtTime(0.3, t0);
  droneGain.connect(master);
  mk('sine', 55).connect(droneGain);
  mk('sine', 55.6).connect(droneGain);
  const breathe = mk('sine', 0.08);
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(0.12, t0);
  breathe.connect(bg);
  bg.connect(droneGain.gain);
  nodes.push(droneGain, bg);
  // soft high pulse (faster in battle)
  const pulseGain = ctx.createGain();
  pulseGain.gain.setValueAtTime(0, t0);
  pulseGain.connect(master);
  mk('sine', 220).connect(pulseGain);
  const plfo = mk('sine', __musicTrack === 'battle' ? 0.6 : 0.2);
  const pg = ctx.createGain();
  pg.gain.setValueAtTime(0.05, t0);
  plfo.connect(pg);
  pg.connect(pulseGain.gain);
  nodes.push(pulseGain, pg);
  // battle: percussion-ish noise ticks (looped noise, bandpass, square LFO gate)
  if (__musicTrack === 'battle') {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf(ctx);
    src.loop = true;
    src.start(t0);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2000, t0);
    const tickGain = ctx.createGain();
    tickGain.gain.setValueAtTime(0, t0);
    src.connect(bp);
    bp.connect(tickGain);
    tickGain.connect(master);
    const tlfo = mk('square', 2);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.09, t0);
    tlfo.connect(tg);
    tg.connect(tickGain.gain);
    nodes.push(src, bp, tickGain, tg);
  }
  __musicNodes = nodes;
  __musicGain = master;
}

// ---- ambient battlefield bed ---------------------------------------------------
// Quiet always-on layer during matches: a ~58Hz hum plus an occasional
// distant filtered-noise rumble every 20-45s (deterministic schedule from an
// incrementing counter). Independent of the music toggle; gated to silence
// while muted. The bed is (re)started by initAudio and stopped by the next
// initAudio, by stopAmbient(), or by the playSfx poll once game.state is null
// — never two beds across a rematch.

function killAmbient() {
  if (!__ambNodes) return;
  for (const n of __ambNodes) {
    try { if (typeof n.stop === 'function') n.stop(); } catch (e) { /* ok */ }
    try { if (typeof n.disconnect === 'function') n.disconnect(); } catch (e) { /* ok */ }
  }
  __ambNodes = null;
  __ambGain = null;
}

// public match-exit hook: drop the bed and don't restart it until initAudio
export function stopAmbient() {
  try {
    __ambWanted = false;
    killAmbient();
  } catch (e) { /* never throws */ }
}

function thunderInterval() {
  return 20000 + (__thunderCount * 7 % 26) * 1000; // 20-45s, deterministic
}

function startAmbient(ctx) {
  killAmbient(); // rematch guard: the old bed dies first
  const t0 = ctx.currentTime;
  const gate = ctx.createGain();
  gate.gain.setValueAtTime(__muted ? 0 : 1, t0);
  gate.connect(ctx.destination);
  const hum = ctx.createOscillator();
  hum.type = 'sine';
  hum.frequency.setValueAtTime(58, t0);
  const humGain = ctx.createGain();
  humGain.gain.setValueAtTime(0.015 * masterVol(), t0);
  hum.connect(humGain);
  humGain.connect(gate);
  hum.start(t0);
  __ambNodes = [gate, hum, humGain];
  __ambGain = gate;
  __thunderAt = nowMs() + thunderInterval();
}

function ensureAmbient() {
  if (!__ambWanted || __ambNodes) return;
  const ctx = ensureCtx();
  if (!ctx) return;
  startAmbient(ctx);
}

// cheap poll from playSfx: drop the bed when the match is gone, start it if
// the context arrived late, and fire the scheduled distant rumble
function pollAmbient(ctx) {
  if (__game && __game.state === null) {
    __ambWanted = false;
    killAmbient();
    return;
  }
  ensureAmbient();
  if (!__ambNodes || !__ambGain) return;
  const now = nowMs();
  if (now < __thunderAt) return;
  __thunderCount++;
  __thunderAt = now + thunderInterval();
  // distant thunder: noise through a lowpass swept 200 -> 40Hz, 1.6s tail
  noiseHit(ctx, ctx.currentTime, 1.6, 'lowpass', 200, 0.06 * masterVol(), 40, __ambGain);
}

// ---- public API (contract: exact named exports) ------------------------------------

export function initAudio(game) {
  try {
    __game = game || null;
    resetAudioThrottles();
    const m = lsGet('mca_muted');
    if (m !== null && m !== undefined) __muted = m === '1' || m === 'true';
    const mu = lsGet('mca_music');
    __musicOn = mu === '1' || mu === 'true'; // music OFF by default
    stopAmbient();      // never leak the previous match's bed
    __ambWanted = true; // match start: run the battlefield bed
    ensureAmbient();
  } catch (e) { /* never throws */ }
}

// clear every module-level throttle (SFX window, shot cap, per-key voice
// cooldown): a rematch starting seconds after the last battle must not
// inherit the previous match's cooldowns. Called from initAudio and by the
// HUD on every new match.
export function resetAudioThrottles() {
  try {
    __winStart = -Infinity; __winCount = 0;
    __shotStart = -Infinity; __shotCount = 0;
    for (const k in __voiceAt) delete __voiceAt[k];
    __unitCount = 0;
    __attackVoiceAt = -Infinity;
  } catch (e) { /* never throws */ }
}

export function unlockAudio() {
  try {
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { ctx.resume(); } catch (e) { /* best-effort */ }
    }
    // a track requested before the first gesture starts now
    if (__musicOn && __musicTrack && !__musicNodes && ctx.state !== 'suspended') {
      startMusic(ctx);
    }
    ensureAmbient(); // context may have arrived after initAudio
  } catch (e) { /* never throws */ }
}

export function playSfx(game, name) {
  try {
    if (__muted) return;
    const now = nowMs();
    if (throttled(name, now)) return; // overflow dropped
    const ctx = ensureCtx();
    if (!ctx || ctx.state === 'suspended') return; // inaudible pre-gesture
    const mv = masterVol(); // HUD volume slider scales everything
    pollAmbient(ctx);
    if (mv <= 0) return;
    const t0 = ctx.currentTime;
    switch (name) {
      case 'move':
        tone(ctx, { type: 'sine', freq: 440, t0, dur: 0.06, gain: 0.08 * mv });
        break;
      case 'attack':
        tone(ctx, { type: 'square', freq: 220, t0, dur: 0.08, gain: 0.1 * mv });
        break;
      case 'select':
        tone(ctx, { type: 'sine', freq: 660, t0, dur: 0.04, gain: 0.06 * mv });
        break;
      case 'build':
        tone(ctx, { type: 'sine', freq: 330, freq2: 660, at2: 0.1, t0, dur: 0.2, gain: 0.09 * mv });
        break;
      case 'error':
        tone(ctx, { type: 'square', freq: 200, t0, dur: 0.12, gain: 0.1 * mv });
        break;
      case 'siren':
        // supersedes the inline hud.js siren (wiring agent reroutes)
        tone(ctx, { type: 'square', freq: 660, freq2: 880, at2: 0.2, t0, dur: 0.4, gain: 0.12 * mv });
        break;
      case 'victory': {
        // major triad arpeggio over 600ms
        const notes = [262, 330, 392, 523];
        for (let i = 0; i < notes.length; i++) {
          tone(ctx, { type: 'triangle', freq: notes[i], t0: t0 + i * 0.15, dur: 0.25, gain: 0.1 * mv });
        }
        break;
      }
      case 'defeat': {
        // minor triad, descending, over 600ms
        const notes = [330, 262, 220];
        for (let i = 0; i < notes.length; i++) {
          tone(ctx, { type: 'triangle', freq: notes[i], t0: t0 + i * 0.2, dur: 0.25, gain: 0.1 * mv });
        }
        break;
      }
      case 'shot': {
        // layered: 5kHz transient crack (5ms) + 500Hz body (30ms) + 120Hz
        // thump, staggered ~5ms, ±5% random pitch so bursts don't sound like
        // a printer (the 12/s shot cap in throttled() still applies)
        const p = 1 + (Math.random() * 0.1 - 0.05);
        noiseHit(ctx, t0, 0.005, 'highpass', 5000 * p, 0.13 * mv);
        tone(ctx, { type: 'triangle', freq: 500 * p, t0: t0 + 0.005, dur: 0.03, gain: 0.1 * mv });
        tone(ctx, { type: 'sine', freq: 120 * p, t0: t0 + 0.01, dur: 0.06, gain: 0.12 * mv });
        break;
      }
      case 'boom':
        // noise swept 800 -> 80Hz with a 300ms lowpass tail + 60Hz sine sub
        noiseHit(ctx, t0, 0.3, 'lowpass', 800, 0.16 * mv, 80);
        tone(ctx, { type: 'sine', freq: 60, t0, dur: 0.3, gain: 0.14 * mv });
        break;
      case 'click':
        tone(ctx, { type: 'square', freq: 1000, t0, dur: 0.02, gain: 0.05 * mv });
        break;
      default:
        break; // unknown name: silent no-op
    }
  } catch (e) { /* audio is best-effort */ }
}

export function playMusicTrack(game, name) {
  try {
    __musicTrack = (name === 'ambient' || name === 'battle') ? name : null;
    if (!__musicOn) { stopMusic(); return; } // remembered; starts on setMusicOn/unlock
    if (!__musicTrack) { stopMusic(); return; }
    const ctx = ensureCtx();
    if (!ctx || ctx.state === 'suspended') return; // unlockAudio will start it
    startMusic(ctx);
  } catch (e) { /* never throws */ }
}

export function setMusicOn(game, on) {
  try {
    __musicOn = !!on;
    lsSet('mca_music', __musicOn ? '1' : '0');
    if (!__musicOn) { stopMusic(); return; }
    const ctx = ensureCtx();
    if (ctx && ctx.state !== 'suspended' && __musicTrack) startMusic(ctx);
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
    const u = new Utterance(line);
    if (set.lang) u.lang = set.lang;
    u.rate = 1.05;
    u.volume = 0.9;
    synth.speak(u);
  } catch (e) { /* speechSynthesis missing or busy: never throws */ }
}

export function setMuted(game, muted) {
  try {
    __muted = !!muted;
    lsSet('mca_muted', __muted ? '1' : '0');
    if (__musicGain && __ctx) {
      try {
        __musicGain.gain.setValueAtTime(__muted ? 0 : 0.15 * masterVol(), __ctx.currentTime);
      } catch (e) { /* ok */ }
    }
    if (__ambGain && __ctx) {
      try { __ambGain.gain.setValueAtTime(__muted ? 0 : 1, __ctx.currentTime); } catch (e) { /* ok */ }
    }
  } catch (e) { /* never throws */ }
}

export function isMuted(game) {
  return __muted;
}

// persisted music preference (localStorage 'mca_music'), OFF by default —
// main.js initializes game.musicOn from this so the toggle starts truthful
export function getMusicOn() {
  try {
    const mu = lsGet('mca_music');
    __musicOn = mu === '1' || mu === 'true';
    return __musicOn;
  } catch (e) { /* never throws */ }
  return false;
}
