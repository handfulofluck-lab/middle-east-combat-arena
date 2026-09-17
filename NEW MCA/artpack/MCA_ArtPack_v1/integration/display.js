// MCA display reservoir helpers. Pure lookups over __INLINE_DISPLAY +
// __INLINE_SPRITE_MAP. Safe to call with missing data.
// Copy into src/game/display.js. Does not touch sim state.

function getDisplay() {
  return (typeof __INLINE_DISPLAY !== 'undefined' && __INLINE_DISPLAY) || {
    structures: {}, unitClasses: {}, unitHudOverrides: {}, factions: {},
  };
}

function getSpriteMap() {
  return (typeof __INLINE_SPRITE_MAP !== 'undefined' && __INLINE_SPRITE_MAP) || { frames: {} };
}

function structureRecord(defId) {
  const d = getDisplay();
  return (d.structures && d.structures[defId]) || null;
}

function structureLabel(defId, ownerFaction, sheetName) {
  const rec = structureRecord(defId);
  if (!rec) return sheetName || defId;
  if (ownerFaction && rec.aliasByFaction && rec.aliasByFaction[ownerFaction]) {
    return rec.aliasByFaction[ownerFaction];
  }
  return rec.defaultName || sheetName || defId;
}

function structureHud(defId, sheetName) {
  const rec = structureRecord(defId);
  return (rec && rec.hud) || sheetName || defId;
}

function structureFlavor(defId, ownerFaction) {
  const rec = structureRecord(defId);
  if (!rec || !rec.flavorByFaction) return '';
  return rec.flavorByFaction[ownerFaction] || '';
}

function unitHud(unitId, sheetName) {
  const d = getDisplay();
  const o = d.unitHudOverrides || {};
  return o[unitId] || sheetName || unitId;
}

function classToken(cls) {
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

function frameForStructure(defId) {
  const frames = getSpriteMap().frames || {};
  return frames[defId] || null;
}

function frameForUnit(unitId, cls) {
  const frames = getSpriteMap().frames || {};
  if (frames[unitId]) return frames[unitId];
  const tok = classToken(cls);
  return tok ? frames['cls-' + tok] || null : null;
}

function frameForFaction(faction) {
  const frames = getSpriteMap().frames || {};
  if (!faction) return null;
  return frames['fac-' + String(faction).toLowerCase()] || null;
}

async function loadAtlas(game, b64) {
  if (!b64) { game.atlas = null; return false; }
  try {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    game.atlas = (typeof createImageBitmap === 'function')
      ? await createImageBitmap(img)
      : img;
    return true;
  } catch (err) {
    console.warn('MCA atlas load failed — greybox fallback', err);
    game.atlas = null;
    return false;
  }
}

function drawFrame(ctx, atlas, frame, dx, dy, dw, dh) {
  if (!atlas || !frame) return false;
  ctx.drawImage(atlas, frame.sx, frame.sy, frame.sw, frame.sh, dx, dy, dw, dh);
  return true;
}

exports.getDisplay = getDisplay;
exports.structureLabel = structureLabel;
exports.structureHud = structureHud;
exports.structureFlavor = structureFlavor;
exports.unitHud = unitHud;
exports.classToken = classToken;
exports.frameForStructure = frameForStructure;
exports.frameForUnit = frameForUnit;
exports.frameForFaction = frameForFaction;
exports.loadAtlas = loadAtlas;
exports.drawFrame = drawFrame;
