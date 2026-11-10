// Player settings shared by the menu and the HUD: graphics quality, audio
// volumes, UI comfort toggles. Each control talks to the owning module
// through a feature-tested hook (the renderer / audio engineers ship those
// independently) and mirrors the choice into localStorage so it survives a
// reload even when the owning module does not persist it itself.
import * as Audio from '../game/audio.js';
import { lsGet, lsSet, clamp } from './dom.js';
import {
  UI_SCALE_OPTIONS, getUiScalePref, setUiScalePref, getUiScale, describeUiScale, applyUiScale,
} from './scale.js';

export const QUALITY_LEVELS = [
  { id: 'low', label: 'Low', text: 'Maximum frame rate. Flat lighting, no post effects.' },
  { id: 'medium', label: 'Medium', text: 'Shadows and basic effects for mid-range GPUs.' },
  { id: 'high', label: 'High', text: 'Full lighting, particles and post-processing.' },
  { id: 'ultra', label: 'Ultra', text: 'Everything on. For showcase captures.' },
];
const K_QUALITY = 'mca.quality';
const K_BLUR = 'mca.ui.blur';
const K_VOL = 'mca.vol.';
const K_MASTER_LEGACY = 'mca_vol'; // audio.js masterVol() reads this key

// ---- graphics ------------------------------------------------------------------------

export function qualityAvailable(game) {
  return !!game && typeof game.getQuality === 'function' && typeof game.setQuality === 'function';
}

export function getQuality(game) {
  try { if (qualityAvailable(game)) return game.getQuality(); } catch (e) { /* renderer not ready */ }
  return lsGet(K_QUALITY, 'high');
}

export function setQuality(game, q) {
  lsSet(K_QUALITY, q);
  try { if (qualityAvailable(game)) game.setQuality(q); } catch (e) { /* renderer not ready */ }
}

// frosted-glass panels cost a blur pass over the live scene; let players opt out
export function getGlassBlur() { return lsGet(K_BLUR, '1') !== '0'; }
export function setGlassBlur(on) {
  lsSet(K_BLUR, on ? '1' : '0');
  applyGlassBlur();
}
export function applyGlassBlur() {
  if (typeof document !== 'undefined' && document.body && document.body.classList) {
    document.body.classList.toggle('no-blur', !getGlassBlur());
  }
}

// screen-edge scrolling (the renderer reads the same key when it starts)
const K_EDGE = 'mca.edgePan';
export function getEdgeScroll() { return lsGet(K_EDGE, '1') !== '0'; }
export function setEdgeScroll(game, on) {
  lsSet(K_EDGE, on ? '1' : '0');
  if (game && game.gl) game.gl.edgePan = !!on;
}

// interface size (ui/scale.js owns the maths and applies itself on import)
export const UI_SIZES = UI_SCALE_OPTIONS.map((o) => ({ id: o.id, label: o.label }));
export function getUiSize() { return getUiScalePref(); }
export function setUiSize(id) { return setUiScalePref(id); }
export function uiSizeNote() { return describeUiScale(); }
export function uiScaleNow() { return getUiScale(); }

// ---- audio ----------------------------------------------------------------------------

export const VOLUME_KINDS = [
  { id: 'master', label: 'Master' },
  { id: 'music', label: 'Music' },
  { id: 'sfx', label: 'Effects' },
  { id: 'voice', label: 'Voice' },
];

let __master = 1;
{
  const lv = lsGet(K_MASTER_LEGACY, null);
  if (lv !== null && lv !== '') __master = clamp(Number(lv) || 0, 0, 1);
}

export function mixerAvailable() {
  return typeof Audio.getVolume === 'function' && typeof Audio.setVolume === 'function';
}

export function volumeSupported(kind) {
  return kind === 'master' || mixerAvailable();
}

export function getVolume(kind) {
  try {
    if (mixerAvailable()) {
      const v = Audio.getVolume(kind);
      if (typeof v === 'number' && isFinite(v)) return clamp(v, 0, 1);
    }
  } catch (e) { /* fall through */ }
  if (kind === 'master') return __master;
  const sv = lsGet(K_VOL + kind, null);
  return sv === null ? 1 : clamp(Number(sv) || 0, 0, 1);
}

export function setVolume(kind, v) {
  const val = clamp(Number(v) || 0, 0, 1);
  if (kind === 'master') {
    __master = val;
    lsSet(K_MASTER_LEGACY, String(val));
  }
  lsSet(K_VOL + kind, String(val));
  try { if (mixerAvailable()) Audio.setVolume(kind, val); } catch (e) { /* best-effort */ }
}

// legacy master-volume accessors (hud.js re-exports these under their old names)
export function getMasterVolume() { return getVolume('master'); }
export function setMasterVolume(v) { setVolume('master', v); }
export function masterGain() { return __master; }

export function musicAvailable() { return typeof Audio.setMusicOn === 'function'; }
export function getMusic(game) {
  if (game && typeof game.musicOn === 'boolean') return game.musicOn;
  try { if (typeof Audio.getMusicOn === 'function') return !!Audio.getMusicOn(); } catch (e) { /* no-op */ }
  return false;
}
export function setMusic(game, on) {
  if (game) game.musicOn = !!on;
  try { if (typeof Audio.setMusicOn === 'function') Audio.setMusicOn(game, !!on); } catch (e) { /* no-op */ }
}

export function muteAvailable() {
  return typeof Audio.setMuted === 'function' && typeof Audio.isMuted === 'function';
}
export function getMuted(game) {
  try { if (muteAvailable()) return !!Audio.isMuted(game); } catch (e) { /* no-op */ }
  return false;
}
export function setMutedPref(game, m) {
  try { if (muteAvailable()) Audio.setMuted(game, !!m); } catch (e) { /* no-op */ }
}

// ---- UI sound ---------------------------------------------------------------------------

let __hoverAt = 0;
export function uiSound(game, name) {
  try {
    if (name === 'ui_hover') {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      if (now - __hoverAt < 70) return;
      __hoverAt = now;
    }
    if (typeof Audio.playSfx === 'function') Audio.playSfx(game, name);
  } catch (e) { /* audio is best-effort */ }
}

export function unlockAudioSafe() {
  try { if (typeof Audio.unlockAudio === 'function') Audio.unlockAudio(); } catch (e) { /* no-op */ }
}

// ---- boot -----------------------------------------------------------------------------

// Re-apply saved choices to modules that came up after us (the renderer and
// the audio mixer initialise asynchronously). Safe to call repeatedly.
let __applied = { quality: false, volumes: false };
export function applySavedSettings(game) {
  applyGlassBlur();
  applyUiScale();
  if (!__applied.quality && qualityAvailable(game)) {
    __applied.quality = true;
    const q = lsGet(K_QUALITY, null);
    try { if (q && game.getQuality() !== q) game.setQuality(q); } catch (e) { /* no-op */ }
  }
  if (!__applied.volumes && mixerAvailable()) {
    __applied.volumes = true;
    for (const k of VOLUME_KINDS) {
      const sv = lsGet(K_VOL + k.id, null);
      if (sv === null) continue;
      try { Audio.setVolume(k.id, clamp(Number(sv) || 0, 0, 1)); } catch (e) { /* no-op */ }
    }
  }
  return __applied.quality && __applied.volumes;
}
