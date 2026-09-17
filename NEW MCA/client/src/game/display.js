// MCA display reservoir helpers (Art Pack v1). Pure lookups over the display
// JSON + sprite map. In the single-file build these arrive as the globals
// __INLINE_DISPLAY / __INLINE_SPRITE_MAP / __ATLAS_PNG_B64; the dev client
// fetches them and installs them via setDisplayData() before boot finishes.
// Never throws: any missing piece falls back to sheet names / greybox shapes.

let DISPLAY = null;
let SPRITE_MAP = null;

export function setDisplayData(display, spriteMap) {
  DISPLAY = display || null;
  SPRITE_MAP = spriteMap || null;
}

export function getDisplay() {
  if (DISPLAY) return DISPLAY;
  if (typeof __INLINE_DISPLAY !== 'undefined' && __INLINE_DISPLAY) return __INLINE_DISPLAY;
  return { structures: {}, unitClasses: {}, unitHudOverrides: {}, factions: {} };
}

export function getSpriteMap() {
  if (SPRITE_MAP) return SPRITE_MAP;
  if (typeof __INLINE_SPRITE_MAP !== 'undefined' && __INLINE_SPRITE_MAP) return __INLINE_SPRITE_MAP;
  return { frames: {} };
}

export function structureRecord(defId) {
  const d = getDisplay();
  return (d.structures && d.structures[defId]) || null;
}

// HUD / selection / build-tile label: faction alias -> default -> sheet name
export function structureLabel(defId, ownerFaction, sheetName) {
  const rec = structureRecord(defId);
  if (!rec) return sheetName || defId;
  if (ownerFaction && rec.aliasByFaction && rec.aliasByFaction[ownerFaction]) {
    return rec.aliasByFaction[ownerFaction];
  }
  return rec.defaultName || sheetName || defId;
}

export function structureHud(defId, sheetName) {
  const rec = structureRecord(defId);
  return (rec && rec.hud) || sheetName || defId;
}

export function structureFlavor(defId, ownerFaction) {
  const rec = structureRecord(defId);
  if (!rec || !rec.flavorByFaction) return '';
  return rec.flavorByFaction[ownerFaction] || '';
}

export function unitHud(unitId, sheetName) {
  const d = getDisplay();
  const o = d.unitHudOverrides || {};
  return o[unitId] || sheetName || unitId;
}

export function classToken(cls) {
  const map = (getSpriteMap().resolveUnit && getSpriteMap().resolveUnit.classTokenFromSheet) || {
    Infantry: 'infantry', 'AT infantry': 'at_inf', 'AA infantry': 'aa_inf',
    Engineer: 'engineer', SF: 'sf', IFV: 'ifv', APC: 'apc',
    'Light vehicle': 'light_veh', 'Light tank': 'light_tank', MBT: 'mbt',
    SPG: 'spg', MLRS: 'mlrs', 'Mobile AA': 'mobile_aa', Missile: 'missile',
    'Attack helo': 'attack_helo', 'Transport helo': 'transport_helo',
    Fighter: 'fighter', 'Strike jet': 'strike_jet', UAV: 'uav',
    Naval: 'naval', MCV: 'mcv', Harvester: 'harv', 'Tank escort': 'mbt',
  };
  return map[cls] || null;
}

export function frameForStructure(defId) {
  const frames = getSpriteMap().frames || {};
  return frames[defId] || null;
}

export function frameForUnit(unitId, cls) {
  const frames = getSpriteMap().frames || {};
  if (frames[unitId]) return frames[unitId];
  const tok = classToken(cls);
  return tok ? frames['cls-' + tok] || null : null;
}

export function frameForFaction(faction) {
  const frames = getSpriteMap().frames || {};
  if (!faction) return null;
  return frames['fac-' + String(faction).toLowerCase()] || null;
}

// boot-time atlas load; on failure the match still starts (greybox fallback)
export async function loadAtlas(game, b64) {
  if (!b64 || typeof Image === 'undefined') { game.atlas = null; return false; }
  try {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    game.atlas = (typeof createImageBitmap === 'function')
      ? await createImageBitmap(img)
      : img;
    return true;
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('MCA atlas load failed — greybox fallback', err);
    game.atlas = null;
    return false;
  }
}

export function drawFrame(ctx, atlas, frame, dx, dy, dw, dh) {
  if (!atlas || !frame) return false;
  ctx.drawImage(atlas, frame.sx, frame.sy, frame.sw, frame.sh, dx, dy, dw, dh);
  return true;
}
