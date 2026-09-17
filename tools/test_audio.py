# v0.3.7 audio module (audio+docs agent scope): inline ONLY client/src/game/
# audio.js (self-contained) into py_mini_racer.
# Phase A: no AudioContext / speechSynthesis / localStorage defined — every
#   export must be callable without throwing.
# Phase B: stubbed AudioContext / speechSynthesis / localStorage / performance —
#   SFX throttle drops overflow (8/100ms, shots 12/s), VOICES covers all
#   9 factions x 7 keys, mute/music persist to localStorage, voice cooldown 6s,
#   voice-availability fallback to English, layered shot/boom patches with
#   pitch variation, ambient bed single-instance, 'unit' voice spam guard,
#   getMusicOn persisted default.
import json
import re
import sys
from pathlib import Path

from py_mini_racer import MiniRacer

CLIENT = Path(__file__).resolve().parent.parent / "client"
MODULES = ["src/game/audio.js"]


def inline(path: Path) -> str:
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"import\s+[\s\S]*?\sfrom\s*'[^']*';", "", src)
    src = re.sub(r"export\s*\{[\s\S]*?\}\s*from\s*'[^']*';", "", src)
    src = re.sub(r"^export\s+(async function|function|const|let)", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[\s\S]*?\};", "", src, flags=re.M)
    return src


# Phase A: bare environment — nothing but the module. Every export called.
TEST_A_JS = r"""
function runPhaseA() {
  const out = [];
  const push = (name, pass, detail) => out.push({ name, pass: !!pass, detail: String(detail || '') });
  const game = {};
  const calls = [];
  const sfx = ['move', 'attack', 'select', 'build', 'error', 'siren',
    'victory', 'defeat', 'shot', 'boom', 'click'];
  try {
    initAudio(game);
    unlockAudio();
    for (const n of sfx) playSfx(game, n);
    playSfx(game, 'nonsense'); // unknown name: silent no-op
    playMusicTrack(game, 'ambient');
    playMusicTrack(game, 'battle');
    playMusicTrack(game, null);
    setMusicOn(game, true);
    setMusicOn(game, false);
    playVoice(game, 'Egypt', 'attack');
    playVoice(game, 'Atlantis', 'unit');
    playVoice(game, 'Egypt', 'bogus');
    stopAmbient();
    const gmo = getMusicOn();
    setMuted(game, true);
    calls.push('isMuted=' + isMuted(game));
    setMuted(game, false);
    calls.push('isMuted=' + isMuted(game));
    calls.push('getMusicOn=' + gmo);
    push('phase-a-no-audio-safe', true, calls.join(' '));
  } catch (e) {
    push('phase-a-no-audio-safe', false, String(e && e.stack || e));
  }
  push('phase-a-mute-toggle',
    calls.join(' ') === 'isMuted=true isMuted=false getMusicOn=false', calls.join(' '));
  return out;
}
"""

# Phase B: full stubs. __now.t is the controllable fake clock (performance.now).
# Nodes register in __allNodes with a start/stop live flag and an ordered
# record of AudioParam sets ([name, value]) so tests can inspect per-SFX
# layering, pitch, and the persistent ambient hum.
STUBS_JS = r"""
var __now = { t: 0 };
globalThis.performance = { now: function () { return __now.t; } };

var __store = {};
globalThis.localStorage = {
  getItem: function (k) {
    return Object.prototype.hasOwnProperty.call(__store, k) ? __store[k] : null;
  },
  setItem: function (k, v) { __store[k] = String(v); },
};

var __osc = 0, __src = 0, __flt = 0, __spoken = [], __allNodes = [];
function FakeParam(node, name) {
  return {
    value: 0,
    setValueAtTime: function (v) { this.value = v; node.sets.push([name, v]); },
    linearRampToValueAtTime: function () {},
    exponentialRampToValueAtTime: function (v) { node.sets.push([name + '~>', v]); },
  };
}
function FakeNode(kind) {
  var n = {
    kind: kind, type: '', buffer: null, loop: false, on: false, sets: [],
    connect: function () {}, disconnect: function () {},
    start: function () { n.on = true; }, stop: function () { n.on = false; },
  };
  n.frequency = FakeParam(n, 'freq');
  n.gain = FakeParam(n, 'gain');
  n.Q = FakeParam(n, 'Q');
  __allNodes.push(n);
  return n;
}
function FakeAudioContext() {
  this.state = 'running';
  this.currentTime = 0;
  this.sampleRate = 44100;
  this.destination = {};
  this.createOscillator = function () { __osc++; return FakeNode('osc'); };
  this.createGain = function () { return FakeNode('gain'); };
  this.createBiquadFilter = function () { __flt++; return FakeNode('flt'); };
  this.createBufferSource = function () { __src++; return FakeNode('src'); };
  this.createBuffer = function (ch, len, sr) {
    return { getChannelData: function () { return new Float32Array(len); } };
  };
  this.resume = function () { this.state = 'running'; };
}
globalThis.AudioContext = FakeAudioContext;

// voice list is reconfigurable per test; __fireVoicesChanged() simulates the
// browser's async voice load
var __VOICE_LANGS = ['ar-EG', 'ar-SA', 'ar-AE', 'fr-FR', 'tr-TR', 'he-IL',
  'fa-IR', 'hi-IN', 'ur-PK', 'en-US'];
var __voicesList = __VOICE_LANGS.map(function (l) { return { lang: l }; });
var __voiceListeners = [];
function __fireVoicesChanged() {
  __voiceListeners.forEach(function (f) { f(); });
}
globalThis.SpeechSynthesisUtterance = function (text) { this.text = text; };
globalThis.speechSynthesis = {
  speak: function (u) { __spoken.push(u); },
  getVoices: function () { return __voicesList; },
  addEventListener: function (t, f) { if (t === 'voiceschanged') __voiceListeners.push(f); },
};
"""

TEST_B_JS = r"""
function runPhaseB() {
  const out = [];
  const push = (name, pass, detail) => out.push({ name, pass: !!pass, detail: String(detail || '') });
  const game = {};

  // initAudio reads persisted state: pre-seed muted=1
  __store.mca_muted = '1';
  initAudio(game);
  push('init-reads-muted', isMuted(game) === true && __store.mca_muted === '1',
    'isMuted=' + isMuted(game));
  setMuted(game, false); // clear for the remaining tests

  // music OFF by default: requesting a track before setMusicOn creates no nodes
  const oscBefore = __osc;
  playMusicTrack(game, 'ambient');
  push('music-off-by-default', __osc === oscBefore,
    'osc ' + oscBefore + ' -> ' + __osc + ' (want unchanged)');

  // SFX throttle: 20 'move' in one 100ms window -> exactly 8 oscillators
  // (baseline: initAudio already created the ambient hum osc)
  const oscPre = __osc;
  __now.t = 1000;
  for (let i = 0; i < 20; i++) playSfx(game, 'move');
  const afterBurst = __osc - oscPre;
  __now.t = 1300; // next window
  playSfx(game, 'move');
  push('sfx-throttle-8-per-100ms', afterBurst === 8 && __osc - oscPre === 9,
    'burst=' + afterBurst + ' nextWindow=' + (__osc - oscPre) + ' (want 8 then 9)');

  // shot throttle: 20 shots spaced 40ms apart (global window passes all,
  // shot cap binds) -> exactly 12 buffer sources
  const srcBefore = __src;
  __now.t = 5000;
  for (let i = 0; i < 20; i++) { playSfx(game, 'shot'); __now.t += 40; }
  push('shot-throttle-12-per-s', __src - srcBefore === 12,
    'sources=' + (__src - srcBefore) + ' (want 12)');

  // every SFX name runs without throwing against the stub ctx
  __now.t = 100000;
  try {
    const names = ['move', 'attack', 'select', 'build', 'error', 'siren',
      'victory', 'defeat', 'shot', 'boom', 'click'];
    for (const n of names) { __now.t += 100; playSfx(game, n); }
    push('sfx-all-names-run', true, names.length + ' names');
  } catch (e) {
    push('sfx-all-names-run', false, String(e && e.stack || e));
  }

  // VOICES table: all 9 factions x 7 keys, correct langs, contract lines
  const factions = ['Egypt', 'Saudi', 'UAE', 'Algeria', 'Turkey', 'Israel', 'Iran', 'India', 'Pakistan'];
  const keys = ['online', 'built', 'unit', 'harv', 'attack', 'lost', 'structLost'];
  let missing = [];
  for (const f of factions) {
    const set = VOICES[f];
    if (!set || !set.lang) { missing.push(f + ':*'); continue; }
    for (const k of keys) {
      if (!set.lines || typeof set.lines[k] !== 'string' || !set.lines[k]) missing.push(f + ':' + k);
    }
  }
  const langs = factions.map((f) => VOICES[f].lang).join(',');
  push('voices-9x7', missing.length === 0,
    missing.length ? 'missing: ' + missing.join(',') : 'langs: ' + langs);
  push('voices-contract-lines',
    VOICES.Egypt.lines.attack === 'القاعدة بتتهجم يا جدعان'
      && VOICES.Egypt.lines.unit === 'الوحدة جاهزة يا معلم',
    'attack="' + VOICES.Egypt.lines.attack + '" unit="' + VOICES.Egypt.lines.unit + '"');
  push('voices-langs',
    VOICES.Egypt.lang === 'ar-EG' && VOICES.Saudi.lang === 'ar-SA'
      && VOICES.UAE.lang === 'ar-AE' && VOICES.Algeria.lang === 'fr-FR'
      && VOICES.Turkey.lang === 'tr-TR' && VOICES.Israel.lang === 'he-IL'
      && VOICES.Iran.lang === 'fa-IR' && VOICES.India.lang === 'hi-IN'
      && VOICES.Pakistan.lang === 'ur-PK',
    langs);

  // voice playback: lang/rate/volume set; 6s cooldown per key; unknown faction
  // falls back to default English
  __now.t = 200000;
  playVoice(game, 'Egypt', 'attack');
  playVoice(game, 'Egypt', 'attack'); // inside cooldown: dropped
  const v1 = __spoken[0];
  push('voice-speak-params',
    __spoken.length === 1 && v1.lang === 'ar-EG' && v1.rate === 1.05 && v1.volume === 0.9
      && v1.text === 'القاعدة بتتهجم يا جدعان',
    JSON.stringify({ n: __spoken.length, lang: v1 && v1.lang, rate: v1 && v1.rate, vol: v1 && v1.volume }));
  __now.t += 6001;
  playVoice(game, 'Egypt', 'attack'); // cooldown elapsed
  __now.t += 16000; // past the 15s post-'attack' quiet window for 'unit'
  playVoice(game, 'Atlantis', 'unit'); // unknown faction -> default
  push('voice-cooldown-and-fallback',
    __spoken.length === 3 && __spoken[2].lang === 'en-US' && __spoken[2].text === 'Unit ready',
    'spoken=' + __spoken.length + ' last=' + (__spoken[2] && __spoken[2].text));

  // mute: persisted, blocks SFX and voice
  const oscM = __osc;
  setMuted(game, true);
  playSfx(game, 'move');
  __now.t += 7000;
  playVoice(game, 'Saudi', 'attack');
  push('mute-persists-and-gates',
    __store.mca_muted === '1' && isMuted(game) === true
      && __osc === oscM && __spoken.length === 3,
    'store=' + __store.mca_muted + ' oscDelta=' + (__osc - oscM) + ' spoken=' + __spoken.length);
  setMuted(game, false);
  push('unmute-persists', __store.mca_muted === '0' && isMuted(game) === false,
    'store=' + __store.mca_muted);

  // music: setMusicOn persists and starts the track; battle adds a noise
  // source; null stops
  __now.t = 400000;
  setMusicOn(game, true);
  const oscA = __osc;
  playMusicTrack(game, 'ambient');
  const oscAmb = __osc - oscA;
  const srcAmb = __src;
  playMusicTrack(game, 'battle');
  const battleNodes = (__osc - (oscA + oscAmb)) + (__src - srcAmb);
  playMusicTrack(game, null);
  push('music-toggle-and-tracks',
    __store.mca_music === '1' && oscAmb >= 4 && battleNodes >= 5,
    'store=' + __store.mca_music + ' ambientOsc=' + oscAmb + ' battleNewNodes=' + battleNodes);
  setMusicOn(game, false);
  push('music-off-persists', __store.mca_music === '0', 'store=' + __store.mca_music);

  // v0.4.1 per-building voices: builtById > builtByType > faction built >
  // English default (6s/key cooldown: space the 'built' calls)
  __now.t = 500000;
  playVoice(game, 'Egypt', 'built', { id: 'SH-02', type: 'Eco' });
  __now.t += 6001;
  playVoice(game, 'Saudi', 'built', { id: 'SH-09', type: 'Def' });
  __now.t += 6001;
  playVoice(game, 'Saudi', 'built', { id: 'XX-99', type: 'Weird' });
  __now.t += 6001;
  playVoice(game, 'Atlantis', 'built', { id: 'XX-99', type: 'Weird' });
  const spB = __spoken.slice(-4);
  push('voice-built-resolution-order',
    spB.length === 4
      && spB[0].text === 'الكهربا اشتغلت' // Egypt builtById SH-02
      && spB[1].text === 'الدفاعات جاهزة' // Saudi builtByType Def
      && spB[2].text === 'اكتمل البناء' // Saudi generic built
      && spB[3].text === 'Construction complete', // English default
    spB.map((s) => s.text).join(' | '));

  // every structure Egypt can build (All-faction + Egypt) has its own line
  const gd = JSON.parse(__jsonGame);
  const missingBuilt = [];
  for (const sd of gd.structures) {
    if (sd.faction !== 'All' && sd.faction !== 'Egypt') continue;
    const ln = VOICES.Egypt.builtById && VOICES.Egypt.builtById[sd.id];
    if (typeof ln !== 'string' || !ln) missingBuilt.push(sd.id);
  }
  push('egypt-built-full-coverage', missingBuilt.length === 0,
    missingBuilt.join(',') || 'all buildable ids have a line');

  // the other 8 factions differentiate at least by structure type
  const typeMiss = [];
  for (const f of factions) {
    if (f === 'Egypt') continue;
    const bt = VOICES[f].builtByType;
    if (!bt || !bt.Core || !bt.Def || !bt.SW) typeMiss.push(f);
  }
  push('factions-built-by-type', typeMiss.length === 0,
    typeMiss.join(',') || 'Core/Def/SW everywhere');

  // ---- voice availability fallback -----------------------------------------
  // only an en-US voice installed: an Arabic faction must fall back to the
  // English line — Arabic text through an English engine is the garbage-robot
  // sound this guard exists to kill
  __now.t = 600000;
  const spPreFB = __spoken.length;
  __voicesList = [{ lang: 'en-US' }];
  __fireVoicesChanged(); // drop any cached answers from the full list
  playVoice(game, 'Egypt', 'attack');
  const fbLine = __spoken[__spoken.length - 1];
  push('voice-lang-fallback',
    __spoken.length === spPreFB + 1 && !!fbLine
      && fbLine.text === 'Our base is under attack' && fbLine.lang === 'en-US'
      && fbLine.text.indexOf('القاعدة') < 0,
    'text="' + (fbLine && fbLine.text) + '" lang=' + (fbLine && fbLine.lang));

  // voiceschanged with an Arabic voice now present: the negative cache entry
  // must clear and the native line returns
  __voicesList = __VOICE_LANGS.map(function (l) { return { lang: l }; });
  __fireVoicesChanged();
  __now.t += 6001;
  playVoice(game, 'Egypt', 'attack');
  const arLine = __spoken[__spoken.length - 1];
  push('voice-cache-refresh-on-voiceschanged',
    !!arLine && arLine.text === 'القاعدة بتتهجم يا جدعان' && arLine.lang === 'ar-EG',
    'text="' + (arLine && arLine.text) + '" lang=' + (arLine && arLine.lang));

  // ---- layered shot + pitch variation ----------------------------------------
  __now.t = 700000;
  playSfx(game, 'click'); // flush any pending scheduled thunder first
  function freqsSince(idx) {
    const fr = [];
    __allNodes.slice(idx).forEach(function (n) {
      n.sets.forEach(function (s) { if (s[0] === 'freq') fr.push(Math.round(s[1])); });
    });
    return fr;
  }
  let preShot = __allNodes.length;
  playSfx(game, 'shot');
  push('shot-layered-3plus-nodes', __allNodes.length - preShot >= 3,
    'nodes=' + (__allNodes.length - preShot));
  const shotSigs = [];
  for (let si = 0; si < 5; si++) {
    __now.t += 100;
    preShot = __allNodes.length;
    playSfx(game, 'shot');
    shotSigs.push(freqsSince(preShot).join(','));
  }
  const distinctSigs = {};
  shotSigs.forEach(function (s) { distinctSigs[s] = true; });
  push('shot-pitch-varies',
    shotSigs.every(function (s) { return s.length > 0; })
      && Object.keys(distinctSigs).length >= 2,
    shotSigs.join(' | '));

  // ---- ambient battlefield bed ----------------------------------------------
  function liveHum() {
    return __allNodes.filter(function (n) {
      return n.kind === 'osc' && n.on && n.sets.some(function (s) {
        return s[0] === 'freq' && s[1] >= 50 && s[1] <= 70;
      });
    }).length;
  }
  initAudio(game); // (re)start: the bed must already be running from phase start
  const humOnce = liveHum();
  initAudio(game); // rematch: old bed dies before the new one starts
  const humReinit = liveHum();
  push('ambient-single-bed', humOnce === 1 && humReinit === 1,
    'hum=' + humOnce + ' afterReinit=' + humReinit);
  stopAmbient();
  push('stop-ambient-clears', liveHum() === 0, 'hum=' + liveHum());
  initAudio(game); // bed running again...
  game.state = null; // ...then the match ends: the next playSfx poll drops it
  __now.t += 100;
  playSfx(game, 'click');
  push('ambient-stops-on-null-state', liveHum() === 0, 'hum=' + liveHum());
  delete game.state;

  // ---- 'unit' voice spam guard -------------------------------------------------
  __now.t = 800000;
  resetAudioThrottles();
  const unitSp0 = __spoken.length;
  for (let ui = 0; ui < 6; ui++) { playVoice(game, 'Egypt', 'unit'); __now.t += 6001; }
  push('voice-unit-every-3rd', __spoken.length - unitSp0 === 2,
    'spoken=' + (__spoken.length - unitSp0) + ' (want 2 of 6)');
  __now.t += 10000;
  playVoice(game, 'Egypt', 'attack'); // speaks; opens the 15s quiet window
  __now.t += 6001;
  const spSupp = __spoken.length;
  playVoice(game, 'Egypt', 'unit'); // within 15s of 'attack': suppressed
  const suppressed = __spoken.length === spSupp;
  __now.t += 16000;
  playVoice(game, 'Egypt', 'unit'); // window over: speaks again
  push('voice-unit-post-attack-suppressed',
    suppressed && __spoken.length === spSupp + 1
      && __spoken[spSupp].text === 'الوحدة جاهزة يا معلم',
    'suppressed=' + suppressed + ' then="' + (__spoken[spSupp] && __spoken[spSupp].text) + '"');

  // ---- getMusicOn ---------------------------------------------------------------
  delete __store.mca_music;
  push('get-music-on-default-false', getMusicOn() === false, 'store unset');
  __store.mca_music = '1';
  push('get-music-on-persisted', getMusicOn() === true, 'store=1');
  __store.mca_music = '0';
  push('get-music-on-off', getMusicOn() === false, 'store=0');

  return out;
}
"""


def run(ctx: MiniRacer, bundle: str, stubs: str, test: str, entry: str):
    if stubs:
        ctx.eval(stubs)
    ctx.eval(bundle)
    ctx.eval(test)
    return json.loads(ctx.eval(f"JSON.stringify({entry}())"))


def main() -> int:
    # console may be cp1252: voice-line details contain ar/he/fa/ur/hi text
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    bundle = "\n;\n".join(inline(CLIENT / m) for m in MODULES)
    results = run(MiniRacer(), bundle, "", TEST_A_JS, "runPhaseA")
    ctx_b = MiniRacer()
    payload = (CLIENT / "data/game.json").read_text(encoding="utf-8")
    ctx_b.eval(f"var __jsonGame = {json.dumps(payload)};")  # Egypt coverage check
    results += run(ctx_b, bundle, STUBS_JS, TEST_B_JS, "runPhaseB")
    passed = 0
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}")
        passed += 1 if r["pass"] else 0
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
