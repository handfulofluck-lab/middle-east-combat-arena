// Greybox visual mapping: unit class/domain -> canvas shape + short label.
import { isInfantryCls } from '../sim/index.js';

export function shapeForUnit(def) {
  if (def.domain === 'Air') return 'triangle';
  if (def.domain === 'Sea') return 'diamond';
  if (isInfantryCls(def.cls)) return 'circle';
  return 'square'; // vehicles, MCV, harvester
}

// Canvas silhouette per class archetype (v0.3.7 readability pass). Kept
// separate from shapeForUnit above: that one feeds the HUD's CSS classes
// (shape-circle/triangle/diamond/square in index.html), this one drives the
// in-world renderer in render.js.
export function silhouetteForUnit(def) {
  if (!def) return 'circle';
  if (def.domain === 'Sea') return 'ship';
  switch (def.cls) {
    case 'Attack helo': case 'Transport helo': return 'helo';
    case 'Fighter': case 'Strike jet': return 'jet';
    case 'UAV': return 'uav';
    default: break;
  }
  if (isInfantryCls(def.cls)) return 'circle';
  switch (def.cls) {
    case 'MBT': case 'Light tank': case 'SPG': case 'MLRS':
    case 'Missile': case 'Tank escort':
      return 'tank'; // rect hull + barrel line
    default:
      return 'rrect'; // APC, IFV, light vehicle, Mobile AA, MCV, harvester
  }
}

// render radius (world px) per class, tuned against CELL=64 so units read at
// 1x zoom (v0.4.1: whole table ~1.3x up from v0.3.7 — users still couldn't
// tell an MBT from an IFV). Fallbacks by domain cover classes added later.
export function unitRadius(def) {
  if (!def) return 28;
  switch (def.cls) {
    case 'Infantry': case 'SF': case 'Engineer':
    case 'AT infantry': case 'AA infantry':
      return 28;
    case 'APC': case 'Light vehicle': case 'Mobile AA':
      return 36;
    case 'IFV': case 'Tank escort': case 'Light tank':
      return 38;
    case 'SPG': case 'MLRS': case 'Missile':
      return 40;
    case 'MBT':
      return 46;
    case 'MCV': case 'Harvester':
      return 44;
    case 'Attack helo': case 'Transport helo':
      return 38;
    case 'Fighter': case 'Strike jet':
      return 40;
    case 'UAV':
      return 36;
    case 'Naval':
      return 48;
    default:
      return def.domain === 'Air' ? 38 : def.domain === 'Sea' ? 48 : 30;
  }
}

// structure silhouettes (v0.3.5): every TYPE reads at a glance — Core is a
// large hexagon, Eco power a circle (+ bolt mark), the oil depot a drum,
// Prod a notched square (+ per-building glyph), Def a triangle (+ barrel
// line), Tech a diamond, SW a star (+ charge ring). Marks are drawn on top
// by drawStructMark in render.js; the short code label stays.
export function shapeForStructure(def) {
  switch (def.id) {
    case 'SH-01': return 'hexagon';  // ConYard: biggest, unmistakable
    case 'SH-02': return 'circle';   // power plant
    case 'SH-03': return 'barrel';   // oil depot
    case 'SH-04': return 'chevron';  // barracks: notched square + person glyph
    case 'SH-05': return 'chevron';  // war factory: + hatch glyph
    case 'SH-06': return 'chevron';  // airfield: + wings glyph
    case 'SH-07': return 'chevron';  // naval yard: + anchor glyph
    case 'SH-08': return 'diamond';  // tech
    default: break;
  }
  if (def.type === 'Def') return 'spike';    // tower triangle (+ barrel line)
  if (def.type === 'Unique') return 'star';
  if (def.type === 'SW') return 'star-sw';
  return 'rect';
}

// ---- class glyphs (v0.4.4 readability) --------------------------------------
// Small high-contrast geometric mark per class archetype, drawn on the unit
// silhouette above the code label. No assets; white-on-black double stroke so
// it reads over any owner color.
export function glyphKindFor(def) {
  if (!def) return null;
  if (def.domain === 'Sea') return 'anchor';
  if (def.domain === 'Air') {
    return (def.cls === 'Fighter' || def.cls === 'Strike jet') ? 'dart' : 'rotor';
  }
  if (isInfantryCls(def.cls)) return 'rifles';
  switch (def.cls) {
    case 'SPG': case 'MLRS': case 'Missile': return 'missile';
    case 'MCV': case 'Harvester': case 'Engineer': return 'gear';
    default: return 'turret'; // MBT, IFV, APC, light vehicles, escorts, AA
  }
}

function traceGlyph(ctx, kind, x, y, s) {
  ctx.beginPath();
  switch (kind) {
    case 'rifles': // crossed rifles
      ctx.moveTo(x - s, y + s * 0.6); ctx.lineTo(x + s, y - s * 0.6);
      ctx.moveTo(x - s, y - s * 0.6); ctx.lineTo(x + s, y + s * 0.6);
      break;
    case 'turret': // tank turret: box + barrel pointing up
      ctx.rect(x - s * 0.7, y - s * 0.4, s * 1.4, s * 0.8);
      ctx.moveTo(x, y - s * 0.4); ctx.lineTo(x, y - s * 1.2);
      break;
    case 'missile': // rocket: body + nose fin
      ctx.moveTo(x - s * 0.5, y + s * 0.7); ctx.lineTo(x + s * 0.5, y - s * 0.7);
      ctx.moveTo(x + s * 0.5, y - s * 0.7); ctx.lineTo(x + s * 0.95, y - s * 0.25);
      break;
    case 'rotor': // helo/UAV rotor cross
      ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
      break;
    case 'dart': // jet dart pointing up
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s * 0.6, y + s * 0.6);
      ctx.lineTo(x, y + s * 0.2);
      ctx.lineTo(x - s * 0.6, y + s * 0.6);
      ctx.closePath();
      break;
    case 'anchor': // naval anchor
      ctx.moveTo(x, y - s); ctx.lineTo(x, y + s * 0.6);
      ctx.moveTo(x - s * 0.6, y - s * 0.3); ctx.lineTo(x + s * 0.6, y - s * 0.3);
      ctx.moveTo(x - s * 0.7, y + s * 0.1);
      ctx.arc(x, y + s * 0.1, s * 0.7, 0, Math.PI);
      break;
    case 'gear': // MCV / harvester / engineer: circle + spokes
      ctx.arc(x, y, s * 0.55, 0, 7);
      ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
      break;
  }
}

export function drawClassGlyph(ctx, def, x, y, s) {
  const kind = glyphKindFor(def);
  if (!kind) return;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 3;
  traceGlyph(ctx, kind, x, y, s);
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.2;
  traceGlyph(ctx, kind, x, y, s);
  ctx.stroke();
}

// ---- art-pack hooks ---------------------------------------------------------
// game.unitArt / game.structArt / game.fxArt (or the globalThis equivalents)
// map a defId / FX key to a data-URI bitmap (Red Alert-style art pack). When
// present and decoded, bitmaps replace the procedural drawing; team ring, hp
// bar and stance ring stay. One decode cache shared by all three packs, keyed
// by URI. Returns null until the image decodes and in headless environments
// without Image — procedural drawing is always the fallback.
const __artCache = {};
function artBitmap(uri) {
  if (typeof uri !== 'string' || uri.slice(0, 5) !== 'data:') return null;
  let rec = __artCache[uri];
  if (rec === undefined) {
    rec = { img: null };
    if (typeof Image !== 'undefined') {
      const img = new Image();
      img.src = uri;
      rec.img = img;
    }
    __artCache[uri] = rec;
  }
  const img = rec.img;
  if (img && (img.complete || img.naturalWidth > 0 || img.width > 0)) return img;
  return null;
}

export function unitArtBitmap(game, defId) {
  const art = (game && game.unitArt) || globalThis.unitArt;
  return art ? artBitmap(art[defId]) : null;
}

// structure pack: footprint*CELL px, centered on structCenter, north-facing
export function structArtBitmap(game, defId) {
  const art = (game && game.structArt) || globalThis.structArt;
  return art ? artBitmap(art[defId]) : null;
}

// FX pack keys: oil_derrick, muzzle_flash, smoke, explosion_0..3
export function fxArtBitmap(game, key) {
  const art = (game && game.fxArt) || globalThis.fxArt;
  return art ? artBitmap(art[key]) : null;
}

// directional strips (pass-3 pack): game.dirArt[defId] =
// {strip: dataURI, fw: frameWidthPx, frames: 8} — frames ordered
// N NE E SE S SW W NW, square, north master at index 0. Shares the decode
// cache with the other packs. Returns {img, fw, frames} or null.
export function dirArtBitmap(game, defId) {
  const art = (game && game.dirArt) || globalThis.dirArt;
  const rec = art ? art[defId] : null;
  if (!rec || typeof rec.strip !== 'string') return null;
  const img = artBitmap(rec.strip);
  if (!img) return null;
  const fw = rec.fw > 0 ? rec.fw : 0;
  const frames = rec.frames > 0 ? rec.frames : 8;
  if (!fw) return null;
  return { img, fw, frames };
}

// wreck/rubble pack: unit husks + structure rubble by defId, same center
// anchor and draw size as the live sprite, north orientation (never rotated)
export function wreckArtBitmap(game, defId) {
  const art = (game && game.wreckArt) || globalThis.wreckArt;
  return art ? artBitmap(art[defId]) : null;
}

// ---- v4 delta pack ------------------------------------------------------------
function fxMetaOf(game, key) {
  const meta = (game && game.fxMeta) || globalThis.fxMeta;
  return meta ? meta[key] : null;
}

// FX strip (explosion_strip): a horizontal strip of square frames. fxMeta may
// carry {strip_frames, frame_w, canvas_px}, but the authoritative frame size
// is the decoded bitmap's own height (the pack is inlined at 0.5 scale) —
// never hardcode pixel counts. Returns {img, fw, frames} or null.
export function fxStripBitmap(game, key) {
  const img = fxArtBitmap(game, key);
  if (!img) return null;
  const fw = img.naturalHeight || img.height || 0;
  if (!fw) return null;
  const w = img.naturalWidth || img.width || fw;
  const m = fxMetaOf(game, key);
  const frames = m && m.strip_frames > 0 ? m.strip_frames
    : Math.max(1, Math.floor(w / fw));
  return { img, fw, frames };
}

// tracer weapon-class -> projectile sprite key (v4 pack). Direct-fire tank
// guns draw cannon shells; SPG artillery draws the shell; MLRS / Missile TELs
// draw rockets; AA/AT missiles and jet munitions draw the missile. Everything
// else (rifle infantry/SF, IFV/APC autocannons, helos, UAV, naval guns,
// towers — structures carry no cls) keeps the procedural hitscan line.
const PROJ_ART_BY_CLS = {
  MBT: 'proj_cannon', 'Light tank': 'proj_cannon', 'Tank escort': 'proj_cannon',
  SPG: 'proj_shell',
  MLRS: 'proj_rocket', Missile: 'proj_rocket',
  'Mobile AA': 'proj_missile', 'AT infantry': 'proj_missile',
  'AA infantry': 'proj_missile', Fighter: 'proj_missile', 'Strike jet': 'proj_missile',
};

// projectile sprite for a tracer cls: north-up bitmap + world-unit radius
// from fxMeta (draw at 2*radius). Null when unmapped / undecoded / no radius.
export function projArtForCls(game, cls) {
  const key = PROJ_ART_BY_CLS[cls];
  if (!key) return null;
  const img = fxArtBitmap(game, key);
  if (!img) return null;
  const m = fxMetaOf(game, key);
  const r = m && m.radius > 0 ? m.radius : 0;
  if (!r) return null;
  return { img, r };
}

// damaged-standing states: game.damagedArt[defId] replaces the normal
// structArt bitmap at <= 50% hp (same canvas/anchor as structArt)
export function damagedArtBitmap(game, defId) {
  const art = (game && game.damagedArt) || globalThis.damagedArt;
  return art ? artBitmap(art[defId]) : null;
}

// standing-structure sprite pick: damaged bitmap at <=50% hp when the pack
// has one, else the normal structArt bitmap, else null (procedural path)
export function structSpriteFor(game, defId, hpFrac) {
  if (hpFrac <= 0.5) {
    const d = damagedArtBitmap(game, defId);
    if (d) return d;
  }
  return structArtBitmap(game, defId);
}

// ---- v5 delta pack ------------------------------------------------------------
// Animated strips: idleArt[defId] (SH-01 ConYard crane — frames are the
// structure's full-footprint canvas, drawn exactly like the structArt
// bitmap, just frame-indexed) and loopArt[key] ambient overlays (rotor /
// radar / steam / flag / pumpjack / wake / select / muzzle_smoke). Records
// are {strip: dataURI, fw, frames, fps}, frames laid out left-to-right.
// Decoded through the shared artBitmap cache; null until decoded and in
// headless environments without Image (static look, zero errors).
// Tick-driven frame index, shared by every animated strip (10Hz sim):
// deterministic, pauses with the game, identical for all viewers.
export function loopFrameIndex(tick, strip) {
  return Math.floor(tick * strip.fps / 10) % strip.frames;
}

function fillStrip(out, rec) {
  if (!rec || typeof rec.strip !== 'string') return null;
  const img = artBitmap(rec.strip);
  if (!img) return null;
  const fw = rec.fw > 0 ? rec.fw : 0;
  if (!fw) return null;
  out.img = img;
  out.fw = fw;
  out.fh = img.naturalHeight || img.height || fw;
  out.frames = rec.frames > 0 ? rec.frames : 1;
  out.fps = rec.fps > 0 ? rec.fps : 8;
  return out;
}

// Accessors return a reused scratch record (no per-frame allocation in the
// hot path) — consume it before the next call to the same accessor.
const __idleOut = { img: null, fw: 0, fh: 0, frames: 0, fps: 0 };
export function idleArtBitmap(game, defId) {
  const art = (game && game.idleArt) || globalThis.idleArt;
  return fillStrip(__idleOut, art ? art[defId] : null);
}

const __loopOut = { img: null, fw: 0, fh: 0, frames: 0, fps: 0 };
export function loopArtBitmap(game, key) {
  const art = (game && game.loopArt) || globalThis.loopArt;
  return fillStrip(__loopOut, art ? art[key] : null);
}

// up to 2 uppercase letters from the unit/structure name
export function initialsFor(name) {
  const words = String(name).replace(/[^A-Za-z0-9 -]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 0);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function factionColorOf(data, faction) {
  const f = data.factions[faction];
  return f ? f.color : '#888888';
}

export function ownerColorOf(state, owner) {
  if (owner < 0) return '#777777'; // neutral-inert
  const p = state.players[owner];
  return p ? factionColorOf(state.data, p.faction) : '#777777';
}
