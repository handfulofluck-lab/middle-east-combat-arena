// Canvas 2D renderer. Terrain + fog are pre-rendered to offscreen canvases
// (terrain once per match, fog on sim ticks) so the per-frame hot loop only
// iterates entities and culls to the viewport.
import { CELL, cellOf, structCenter, BUILD_RADIUS, CAPTURE_TICKS } from '../sim/index.js';
import { silhouetteForUnit, unitRadius, shapeForStructure, initialsFor, ownerColorOf, drawClassGlyph, unitArtBitmap, structArtBitmap, fxArtBitmap, dirArtBitmap, wreckArtBitmap, fxStripBitmap, projArtForCls, structSpriteFor, idleArtBitmap, loopArtBitmap, loopFrameIndex } from './sprites.js';
import { screenToWorld } from './camera.js';
import { resolvePlacement, cellBuildable, nearestBaseStruct } from './placement.js';

const TERRAIN_COLORS = ['#b8a06a', '#4c4c4c', '#274b7a']; // open / rock / water
const FOG_SEEN_ALPHA = 90;

// ---- v6 terrain tile pack ---------------------------------------------------
// game.tileArt (data-URIs): sand/rock base tiles, water_0..3 animation frames
// and small transparent decals (decal_dune / decal_rock / decal_scrub /
// decal_foam). Decoded through a URI-keyed cache mirroring the shared art
// cache in sprites.js (that one is module-private, so the same decode
// semantics live here): null until the image decodes and in headless
// environments without Image. With no tiles decoded the bake below is EXACTLY
// the pre-pack flat-color path.
const __tileCache = {};
function tileBitmap(game, key) {
  const art = (game && game.tileArt) || globalThis.tileArt;
  const uri = art ? art[key] : null;
  if (typeof uri !== 'string' || uri.slice(0, 5) !== 'data:') return null;
  let rec = __tileCache[uri];
  if (rec === undefined) {
    rec = { img: null };
    if (typeof Image !== 'undefined') {
      const img = new Image();
      img.src = uri;
      rec.img = img;
    }
    __tileCache[uri] = rec;
  }
  const img = rec.img;
  if (img && (img.complete || img.naturalWidth > 0 || img.width > 0)) return img;
  return null;
}

// pure hash of the cell coords -> [0,1): decal scatter is deterministic (the
// same map bakes identically every run — no Math.random in the bake)
function cellHash01(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// 4-neighborhood terrain lookup, -1 off-map
function cellTerrain(map, x, y) {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return -1;
  return map.terrain[y * map.w + x];
}

export function initRenderer(game) {
  const map = game.state.map;
  // v0.6.0: cap the terrain offscreen's largest side at ~6144px (<=144MB RGBA)
  // so big maps can't blow canvas memory; drawn back scaled to world size.
  const TS = Math.max(16, Math.min(64, Math.floor(6144 / Math.max(map.w, map.h))));
  const terrain = document.createElement('canvas');
  terrain.width = map.w * TS;
  terrain.height = map.h * TS;
  const tc = terrain.getContext('2d');
  const tiles = {
    sand: tileBitmap(game, 'sand'),
    rock: tileBitmap(game, 'rock'),
    water: [tileBitmap(game, 'water_0'), tileBitmap(game, 'water_1'),
      tileBitmap(game, 'water_2'), tileBitmap(game, 'water_3')],
    dune: tileBitmap(game, 'decal_dune'),
    rockDecal: tileBitmap(game, 'decal_rock'),
    scrub: tileBitmap(game, 'decal_scrub'),
    foam: tileBitmap(game, 'decal_foam'),
  };
  const useTiles = !!(tiles.sand || tiles.rock || tiles.water[0]
    || tiles.dune || tiles.rockDecal || tiles.scrub || tiles.foam);
  let waterCells = null;
  if (!useTiles) {
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        tc.fillStyle = TERRAIN_COLORS[map.terrain[y * map.w + x]];
        tc.fillRect(x * TS, y * TS, TS, TS);
      }
    }
  } else {
    waterCells = [];
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const t = map.terrain[y * map.w + x];
        const base = t === 0 ? tiles.sand : t === 1 ? tiles.rock : tiles.water[0];
        if (base) tc.drawImage(base, x * TS, y * TS, TS, TS);
        else { // this terrain kind has no tile in the pack: flat fallback
          tc.fillStyle = TERRAIN_COLORS[t];
          tc.fillRect(x * TS, y * TS, TS, TS);
        }
        // decals: deterministic pseudo-random per cell (hash of x,y)
        const h = cellHash01(x, y);
        if (t === 0) {
          const nearRock = cellTerrain(map, x + 1, y) === 1
            || cellTerrain(map, x - 1, y) === 1
            || cellTerrain(map, x, y + 1) === 1
            || cellTerrain(map, x, y - 1) === 1;
          if (nearRock && tiles.scrub && h < 0.12) {
            tc.drawImage(tiles.scrub, x * TS, y * TS, TS, TS);
          } else if (tiles.dune && h < 0.2) {
            tc.drawImage(tiles.dune, x * TS, y * TS, TS, TS);
          }
        } else if (t === 1) {
          if (tiles.rockDecal && h < 0.35) {
            tc.drawImage(tiles.rockDecal, x * TS, y * TS, TS, TS);
          }
        } else {
          waterCells.push(x, y);
          // foam on EVERY water cell touching land (4-neighborhood)
          const nearLand = cellTerrain(map, x + 1, y) === 0
            || cellTerrain(map, x - 1, y) === 0
            || cellTerrain(map, x, y + 1) === 0
            || cellTerrain(map, x, y - 1) === 0
            || cellTerrain(map, x + 1, y) === 1
            || cellTerrain(map, x - 1, y) === 1
            || cellTerrain(map, x, y + 1) === 1
            || cellTerrain(map, x, y - 1) === 1;
          if (nearLand && tiles.foam) {
            tc.drawImage(tiles.foam, x * TS, y * TS, TS, TS);
          }
        }
      }
    }
  }
  tc.fillStyle = '#1a1a1a';
  for (const o of map.oil) {
    tc.beginPath();
    tc.arc(o.x * TS + TS / 2, o.y * TS + TS / 2, TS * 0.7, 0, 7);
    tc.fill();
  }
  const fog = document.createElement('canvas');
  // v0.9.1: 4px/cell so the upscaled blit can smooth the fog edges — at 1px/cell
  // nearest-neighbor upscaling drew chunky CELL-sized blocks. Still tiny: a
  // 240^2-cell map is a 960^2 RGBA canvas (~3.5 MB).
  const FOG_PX_PER_CELL = 4;
  fog.width = map.w * FOG_PX_PER_CELL;
  fog.height = map.h * FOG_PX_PER_CELL;
  const fogCtx = fog.getContext('2d');
  const fogImg = fogCtx.createImageData(fog.width, fog.height);
  game.render = { terrain, fog, fogCtx, fogImg, fogTick: -1,
    fogScale: FOG_PX_PER_CELL };
  // water animation: frame 0 is what the bake stamped; frames 1-3 overlay the
  // visible water cells per frame (renderFrame). Kept as a cell list instead
  // of full-size per-frame overlay canvases — three extra map-sized RGBA
  // canvases would defeat the 6144px memory cap above on big maps.
  if (waterCells && waterCells.length
    && (tiles.water[1] || tiles.water[2] || tiles.water[3])) {
    game.render.waterCells = waterCells;
    game.render.waterFrames = tiles.water;
  }
}

function updateFogCanvas(game) {
  const R = game.render;
  const st = game.state;
  if (R.fogTick === st.tick) return;
  R.fogTick = st.tick;
  const fog = st.fog[game.playerSlot];
  const S = R.fogScale || 1; // fog-canvas px per cell (v0.9.1: 4, smoothed blit)
  const w = st.map.w, h = st.map.h;
  // 32-bit fast path: rgb stays 0, alpha is per-cell, so each pixel is one
  // uint32 (little-endian A<<24|B<<16|G<<8|R) and each cell is an SxS solid
  // block. One pass, no per-byte branching.
  const px32 = new Uint32Array(R.fogImg.data.buffer);
  const stride = w * S;
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const i = cy * w + cx;
      const a = fog.visible[i] ? 0 : fog.seen[i] ? FOG_SEEN_ALPHA : 255;
      const v = (a << 24) | 0;
      const o0 = cy * S * stride + cx * S;
      for (let dy = 0; dy < S; dy++) {
        const o = o0 + dy * stride;
        for (let dx = 0; dx < S; dx++) px32[o + dx] = v;
      }
    }
  }
  R.fogCtx.putImageData(R.fogImg, 0, 0);
}

function visibleCell(game, wx, wy) {
  const st = game.state;
  const cx = cellOf(wx), cy = cellOf(wy);
  if (cx < 0 || cy < 0 || cx >= st.map.w || cy >= st.map.h) return false;
  return st.fog[game.playerSlot].visible[cy * st.map.w + cx] === 1;
}

function seenCell(game, cx, cy) {
  const st = game.state;
  return st.fog[game.playerSlot].seen[cy * st.map.w + cx] === 1;
}

function drawHealthBar(ctx, x, y, w, hp, maxHp) {
  ctx.fillStyle = '#111';
  ctx.fillRect(x - w / 2, y, w, 4);
  const f = hp / maxHp;
  ctx.fillStyle = f > 0.5 ? '#5c5' : f > 0.25 ? '#dc5' : '#e54';
  ctx.fillRect(x - w / 2, y, w * f, 4);
}

// small green '+' while an engineer is repairing this entity
function drawRepairMark(ctx, x, y, half) {
  ctx.strokeStyle = '#4caf50';
  ctx.lineWidth = 2;
  const ry = y - half - 14;
  ctx.beginPath();
  ctx.moveTo(x - 4, ry); ctx.lineTo(x + 4, ry);
  ctx.moveTo(x, ry - 4); ctx.lineTo(x, ry + 4);
  ctx.stroke();
}

function drawBrackets(ctx, x, y, hw, hh) {
  const L = 6;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - hw, y - hh + L); ctx.lineTo(x - hw, y - hh); ctx.lineTo(x - hw + L, y - hh);
  ctx.moveTo(x + hw - L, y - hh); ctx.lineTo(x + hw, y - hh); ctx.lineTo(x + hw, y - hh + L);
  ctx.moveTo(x + hw, y + hh - L); ctx.lineTo(x + hw, y + hh); ctx.lineTo(x + hw - L, y + hh);
  ctx.moveTo(x - hw + L, y + hh); ctx.lineTo(x - hw, y + hh); ctx.lineTo(x - hw, y + hh - L);
  ctx.stroke();
}

// unit silhouettes (v0.3.7): one path per class archetype at radius r.
// Only canvas methods the headless test stub records are used (no arcTo /
// quadraticCurveTo).
function traceUnitShape(ctx, shape, x, y, r) {
  ctx.beginPath();
  switch (shape) {
    case 'rrect': { // vehicles: rounded rect, wider than tall
      const hw = r, hh = r * 0.7, c = Math.min(hw, hh) * 0.7;
      ctx.moveTo(x - hw + c, y - hh);
      ctx.lineTo(x + hw - c, y - hh);
      ctx.arc(x + hw - c, y - hh + c, c, -Math.PI / 2, 0);
      ctx.lineTo(x + hw, y + hh - c);
      ctx.arc(x + hw - c, y + hh - c, c, 0, Math.PI / 2);
      ctx.lineTo(x - hw + c, y + hh);
      ctx.arc(x - hw + c, y + hh - c, c, Math.PI / 2, Math.PI);
      ctx.lineTo(x - hw, y - hh + c);
      ctx.arc(x - hw + c, y - hh + c, c, Math.PI, Math.PI * 1.5);
      ctx.closePath();
      break;
    }
    case 'tank': // rect hull; barrel line drawn separately (drawBarrel)
      ctx.rect(x - r, y - r * 0.62, r * 2, r * 1.24);
      break;
    case 'helo': // fuselage circle; rotor cross drawn separately (drawRotor)
      ctx.arc(x, y, r * 0.68, 0, 7);
      break;
    case 'jet': // dart pointing north
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.85, y + r * 0.7);
      ctx.lineTo(x, y + r * 0.3);
      ctx.lineTo(x - r * 0.85, y + r * 0.7);
      ctx.closePath();
      break;
    case 'ship': // elongated hull
      ctx.ellipse(x, y, r * 0.45, r, 0, 0, 7);
      break;
    case 'uav': // small diamond
      ctx.moveTo(x, y - r * 0.8);
      ctx.lineTo(x + r * 0.8, y);
      ctx.lineTo(x, y + r * 0.8);
      ctx.lineTo(x - r * 0.8, y);
      ctx.closePath();
      break;
    default: // infantry: circle
      ctx.arc(x, y, r, 0, 7);
  }
}

// aim heuristic shared by the barrel line and unit-bitmap rotation: toward
// the current order destination / attack target, null when idle or already
// on the spot (callers decide the no-aim fallback)
function unitAimAngle(st, u) {
  const o = u.order;
  if (o && (o.type === 'move' || o.type === 'attackMove')) {
    if (o.x !== u.x || o.y !== u.y) return Math.atan2(o.y - u.y, o.x - u.x);
  } else if (o && o.type === 'attackTarget' && o.targetId) {
    const t = st.units[o.targetId] || st.structures[o.targetId];
    if (t) {
      const p = t.cx !== undefined ? structCenter(t) : t;
      if (p.x !== u.x || p.y !== u.y) return Math.atan2(p.y - u.y, p.x - u.x);
    }
  }
  return null;
}

// tank barrel: dark line from the hull center toward the current order
// destination / target (north when stationary). Render-only, never throws.
// `recoil` shortens the barrel 25% for a few ticks after the unit fires.
function drawBarrel(ctx, st, u, r, recoil) {
  const aim = unitAimAngle(st, u);
  const a = aim === null ? -Math.PI / 2 : aim;
  const len = r * 1.15 * (recoil ? 0.75 : 1);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(u.x + Math.cos(a) * r * 0.45, u.y + Math.sin(a) * r * 0.45);
  ctx.lineTo(u.x + Math.cos(a) * len, u.y + Math.sin(a) * len);
  ctx.stroke();
}

// helo rotor cross, slowly turning with the sim tick (render-only flair)
function drawRotor(ctx, x, y, r, tick) {
  const a = tick * 0.35;
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const b of [a, a + Math.PI / 2]) {
    ctx.moveTo(x - Math.cos(b) * r * 0.95, y - Math.sin(b) * r * 0.95);
    ctx.lineTo(x + Math.cos(b) * r * 0.95, y + Math.sin(b) * r * 0.95);
  }
  ctx.stroke();
}

// blit one frame of a left-to-right v5 strip (idleArt / loopArt), centered
// at (x,y), scaled to size px square. Source rect is pure arithmetic on the
// cached strip record — no allocation. Only called with a decoded strip.
function drawStripFrame(ctx, strip, fi, x, y, size) {
  ctx.drawImage(strip.img, fi * strip.fw, 0, strip.fw, strip.fh,
    x - size / 2, y - size / 2, size, size);
}

// tank-class guns puff a play-once muzzle-smoke strip (v5 loopArt) at the
// barrel tip when they emit a tracer
const SMOKE_PUFF_CLS = { MBT: 1, 'Light tank': 1, 'Tank escort': 1, SPG: 1, MLRS: 1 };

// Unit sprites (v0.3.7): the silhouette — filled owner color, gold rim when
// upgraded, white code label, 2px owner-color stroke — never changes per
// frame, so it is rendered once into an offscreen canvas and blitted. Keeps
// the hot loop cheap despite the much larger radii. Render-only cache; keyed
// by everything drawn into the sprite.
const __unitSprites = {};
function unitSprite(def, r, shape, col, gold) {
  const label = def.id === 'MCV' ? 'MCV' : initialsFor(def.name);
  const key = def.id + '|' + shape + '|' + r + '|' + col + '|' + label + (gold ? '|g' : '');
  let cv = __unitSprites[key];
  if (cv) return cv;
  const pad = 6; // stroke + gold rim overhang
  const sz = Math.ceil((r + pad) * 2);
  cv = document.createElement('canvas');
  cv.width = sz; cv.height = sz;
  const c = cv.getContext('2d');
  const x = sz / 2, y = sz / 2;
  c.fillStyle = col;
  traceUnitShape(c, shape, x, y, r);
  if (gold) { // outer rim: wide gold stroke first, fill covers its inner half
    c.strokeStyle = '#ffd54a';
    c.lineWidth = 6;
    c.stroke();
  }
  c.fill();
  // high-contrast class glyph above the code label (v0.4.4 readability)
  drawClassGlyph(c, def, x, y - r * 0.42, r * 0.3);
  c.fillStyle = '#fff';
  c.font = (def.id === 'MCV' ? 'bold 12px' : '10px') + ' monospace';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(label, x, y + r * 0.25);
  c.strokeStyle = col;
  c.lineWidth = 2;
  traceUnitShape(c, shape, x, y, r);
  c.stroke();
  __unitSprites[key] = cv;
  return cv;
}

// structure silhouettes, inscribed in the footprint square (half = half-size)
function traceStructShape(ctx, shape, x, y, h) {
  ctx.beginPath();
  switch (shape) {
    case 'circle': // power plant
      ctx.arc(x, y, h * 0.85, 0, 7);
      break;
    case 'octagon': {
      const k = h * 0.414; // regular octagon inset
      ctx.moveTo(x - h + k, y - h); ctx.lineTo(x + h - k, y - h);
      ctx.lineTo(x + h, y - h + k); ctx.lineTo(x + h, y + h - k);
      ctx.lineTo(x + h - k, y + h); ctx.lineTo(x - h + k, y + h);
      ctx.lineTo(x - h, y + h - k); ctx.lineTo(x - h, y - h + k);
      ctx.closePath();
      break;
    }
    case 'hexagon':
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + i * Math.PI / 3;
        const px = x + h * Math.cos(a), py = y + h * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    case 'barrel': // upright capsule
      ctx.ellipse(x, y, h * 0.6, h * 0.9, 0, 0, 7);
      break;
    case 'chevron': // rectangle with a V-notch on the south edge
      ctx.moveTo(x - h, y - h); ctx.lineTo(x + h, y - h);
      ctx.lineTo(x + h, y + h); ctx.lineTo(x, y + h * 0.35);
      ctx.lineTo(x - h, y + h);
      ctx.closePath();
      break;
    case 'runway': // tower block with a triangle nose pointing north
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h * 0.7, y - h * 0.25); ctx.lineTo(x + h * 0.7, y + h);
      ctx.lineTo(x - h * 0.7, y + h); ctx.lineTo(x - h * 0.7, y - h * 0.25);
      ctx.closePath();
      break;
    case 'dock': // diamond with a flat south edge
      ctx.moveTo(x, y - h); ctx.lineTo(x + h, y);
      ctx.lineTo(x + h * 0.55, y + h * 0.6); ctx.lineTo(x - h * 0.55, y + h * 0.6);
      ctx.lineTo(x - h, y);
      ctx.closePath();
      break;
    case 'diamond': // tall kite (tech)
      ctx.moveTo(x, y - h); ctx.lineTo(x + h * 0.65, y);
      ctx.lineTo(x, y + h); ctx.lineTo(x - h * 0.65, y);
      ctx.closePath();
      break;
    case 'bunker': // low trapezoid
      ctx.moveTo(x - h, y + h * 0.55); ctx.lineTo(x + h, y + h * 0.55);
      ctx.lineTo(x + h * 0.6, y - h * 0.55); ctx.lineTo(x - h * 0.6, y - h * 0.55);
      ctx.closePath();
      break;
    case 'spike': // triangle pointing north
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h * 0.8, y + h * 0.7); ctx.lineTo(x - h * 0.8, y + h * 0.7);
      ctx.closePath();
      break;
    case 'radar': // dish: circle + one radial tick
      ctx.arc(x, y, h * 0.75, 0, 7);
      ctx.moveTo(x, y); ctx.lineTo(x, y - h * 0.75);
      break;
    case 'star': case 'star-sw': { // 4-point star
      for (let i = 0; i < 8; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 4;
        const rr = i % 2 === 0 ? h : h * 0.42;
        const px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    default: // rect
      ctx.rect(x - h, y - h, h * 2, h * 2);
  }
}

// stance ring tints (v0.3.6 stances, render side): 1 defensive, 2 hold
// ground, 3 hold fire. Index 0 (aggressive) draws nothing.
const STANCE_RING = ['', '#ffb300', '#4da3ff', '#9e9e9e'];

function markerInView(x, y, vx0, vy0, vx1, vy1) {
  return x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;
}

// ---- render-side combat FX (v0.4.4 readability) -----------------------------
// All state lives on game.fx and is derived from sim state every frame; it
// never feeds back into the sim (UI issues commands only). Lifetimes are in
// sim ticks so the FX pace follows game speed.
function fxState(game) {
  if (!game.fx) {
    game.fx = {
      seenTracers: {}, // projectile id -> true, pruned as tracers expire
      recoil: {},      // unit id -> tick the barrel recoil ends
      lastAng: {},     // unit id -> last aim angle (bitmap rotation persists)
      flashes: [],     // {x, y, until} 2-tick muzzle flashes
      puffs: [],       // {x, y, size, born, frames, fps} play-once muzzle smoke
      sparks: [],      // {x, y, until} 3-tick impact sparks
      deaths: [],      // rings {x,y,r,col,until,total} or {boom,born} explosions
      wrecks: [],      // {x, y, r, defId, size, until} 45-tick husk/rubble marks
      smoke: [],       // {x, y, r, until} 20-tick structure-death smoke
      numbers: [],     // {unitId, x, y, r, amount, born, until} damage floats
      prevUnits: {},   // id -> {x, y, defId, owner, r, hp} of drawn units
      prevStructs: {}, // id -> {x, y, owner, half} of drawn structures
    };
  }
  return game.fx;
}

// diff the sim state against last frame's snapshot; spawn FX. Runs before the
// draw loops with the same cull rules (viewport + fog), so FX never leak
// information about things the player cannot see.
function updateFx(game, fx, vx0, vy0, vx1, vy1) {
  const st = game.state;
  const t = st.tick;

  // new tracers -> muzzle flash at the source, spark burst at the impact
  // point, barrel recoil on the originating unit. The shooter is matched by
  // the sim-stamped srcUnitId when present (v0.9.1 — no scan); hand-built or
  // older states fall back to owner + exact spawn position.
  const live = {};
  for (const id in st.projectiles) {
    const pr = st.projectiles[id];
    if (pr.kind !== 'tracer') continue;
    live[id] = true;
    if (fx.seenTracers[id]) continue;
    fx.seenTracers[id] = true;
    const ownShot = pr.owner === game.playerSlot;
    if (ownShot || visibleCell(game, pr.sx, pr.sy)) {
      fx.flashes.push({ x: pr.sx, y: pr.sy, until: t + 2 });
    }
    if (ownShot || visibleCell(game, pr.tx, pr.ty)) {
      fx.sparks.push({ x: pr.tx, y: pr.ty, until: t + 3 });
    }
    let shooter = null;
    if (pr.srcUnitId !== undefined && pr.srcUnitId !== null) {
      const su = st.units[pr.srcUnitId];
      if (su && su.owner === pr.owner) shooter = su;
    }
    if (!shooter) {
      for (const uid in st.units) {
        const u = st.units[uid];
        if (u.owner === pr.owner && u.x === pr.sx && u.y === pr.sy) {
          shooter = u;
          break;
        }
      }
    }
    if (!shooter) continue;
    fx.recoil[shooter.id] = t + 3;
    // v5: tank-class guns also puff a play-once smoke strip at the
    // barrel tip (pos + aimVec * r * 0.9), frames*(10/fps) ticks long
    const ud = st.unitDefs[shooter.defId];
    if (ud && SMOKE_PUFF_CLS[ud.cls]
      && (ownShot || visibleCell(game, pr.sx, pr.sy))) {
      const ms = loopArtBitmap(game, 'loop_muzzle_smoke');
      if (ms) {
        const ur = unitRadius(ud);
        const aa = Math.atan2(pr.ty - pr.sy, pr.tx - pr.sx);
        fx.puffs.push({ x: shooter.x + Math.cos(aa) * ur * 0.9,
          y: shooter.y + Math.sin(aa) * ur * 0.9, size: ur * 1.5,
          born: t, frames: ms.frames, fps: ms.fps });
      }
    }
  }
  for (const id in fx.seenTracers) if (!live[id]) delete fx.seenTracers[id];
  for (const id in fx.recoil) if (fx.recoil[id] <= t) delete fx.recoil[id];

  // vanished units/structures -> death FX at the last drawn position. Own
  // units always count; enemies only while their last cell is still visible
  // (walking out of the fog is not a death). MCV deploy deletes the unit
  // legitimately — excluded by defId. With fxArt.explosion_strip the ring is
  // replaced by the 10-frame strip sequence (20 ticks), else by the legacy
  // 4-frame explosion_0..3 sequence (16 ticks); structure deaths
  // additionally linger smoke. Wreck mark (husk/rubble) persists 45 ticks
  // either way.
  const boomStrip = fxStripBitmap(game, 'explosion_strip');
  const boom = !!boomStrip || !!fxArtBitmap(game, 'explosion_0');
  // v4 strip: 10 frames over 20 ticks (2/frame); legacy 4-frame pack: 16
  const boomTicks = boomStrip ? 20 : 16;
  for (const id in fx.prevUnits) {
    if (st.units[id]) continue;
    const pv = fx.prevUnits[id];
    if (pv.defId === 'MCV') continue;
    if (pv.owner !== game.playerSlot && !visibleCell(game, pv.x, pv.y)) continue;
    const col = ownerColorOf(st, pv.owner);
    if (boom) {
      fx.deaths.push({ x: pv.x, y: pv.y, r: pv.r * 2.5, col,
        boom: true, born: t, until: t + boomTicks, total: boomTicks });
    } else {
      fx.deaths.push({ x: pv.x, y: pv.y, r: pv.r, col, until: t + 15, total: 15 });
    }
    fx.wrecks.push({ x: pv.x, y: pv.y, r: pv.r, defId: pv.defId,
      size: pv.r * 2, until: t + 45 });
  }
  const smokeArt = fxArtBitmap(game, 'smoke');
  for (const id in fx.prevStructs) {
    if (st.structures[id]) continue;
    const pv = fx.prevStructs[id];
    // v0.9.1: same fog rule as unit deaths — an enemy structure destroyed out
    // of sight must not telegraph its loss with explosion/rubble/smoke
    if (pv.owner !== game.playerSlot && !visibleCell(game, pv.x, pv.y)) continue;
    const col = ownerColorOf(st, pv.owner);
    if (boom) {
      fx.deaths.push({ x: pv.x, y: pv.y, r: pv.half * 3, col,
        boom: true, born: t, until: t + boomTicks, total: boomTicks });
    } else {
      fx.deaths.push({ x: pv.x, y: pv.y, r: pv.half, col, until: t + 20, total: 20 });
    }
    if (smokeArt) fx.smoke.push({ x: pv.x, y: pv.y, r: pv.half, until: t + 20 });
    // structure rubble: wreckArt has defId keys for structures too; drawn at
    // fp*CELL (half = fp*CELL/2 - 3), same 45-tick persistence as unit husks
    fx.wrecks.push({ x: pv.x, y: pv.y, r: pv.half, defId: pv.defId,
      size: (pv.half + 3) * 2, struct: true, until: t + 45 });
  }

  // hp drops on drawn units -> floating damage numbers; hits within 10 ticks
  // aggregate into one number; capped at 40 concurrent
  const newPrev = {};
  for (const id in st.units) {
    const u = st.units[id];
    if (u.x < vx0 || u.x > vx1 || u.y < vy0 || u.y > vy1) continue;
    const own = u.owner === game.playerSlot;
    if (!own && !visibleCell(game, u.x, u.y)) continue;
    const def = st.unitDefs[u.defId];
    const r = unitRadius(def);
    let pv = fx.prevUnits[id];
    if (pv && u.hp < pv.hp) {
      const dmg = pv.hp - u.hp;
      let num = null;
      for (const n of fx.numbers) {
        if (n.unitId === u.id && t - n.born <= 10) { num = n; break; }
      }
      if (num) {
        num.amount += dmg; num.x = u.x; num.y = u.y;
      } else if (fx.numbers.length < 40) {
        fx.numbers.push({ unitId: u.id, x: u.x, y: u.y, r,
          amount: dmg, born: t, until: t + 30 });
      }
    }
    // v0.9.1: reuse the previous record (mutate in place) instead of
    // reallocating one object per visible unit per tick (~18k objects/s at
    // 300 units). defId/owner/r are constant for a unit's lifetime.
    if (pv) {
      pv.x = u.x; pv.y = u.y; pv.hp = u.hp;
    } else {
      pv = { x: u.x, y: u.y, defId: u.defId, owner: u.owner, r, hp: u.hp };
    }
    newPrev[id] = pv;
  }
  const newPrevS = {};
  for (const id in st.structures) {
    const s = st.structures[id];
    const px = (s.cx + s.fp / 2) * CELL;
    const py = (s.cy + s.fp / 2) * CELL;
    if (px < vx0 || px > vx1 || py < vy0 || py > vy1) continue;
    const own = s.owner === game.playerSlot;
    if (!own && !seenCell(game, s.cx, s.cy)) continue;
    const pv = fx.prevStructs[id];
    if (pv) {
      pv.owner = s.owner; // captures can flip ownership; geometry is static
      newPrevS[id] = pv;
    } else {
      newPrevS[id] = { x: px, y: py, owner: s.owner,
        half: s.fp * CELL / 2 - 3, defId: s.defId };
    }
  }
  fx.prevUnits = newPrev;
  fx.prevStructs = newPrevS;
  for (const id in fx.lastAng) if (!st.units[id]) delete fx.lastAng[id];
}

// draw the live FX (before the fog overlay: everything spawned was visible)
function drawFx(ctx, game, fx, vx0, vy0, vx1, vy1) {
  const t = game.state.tick;

  fx.flashes = fx.flashes.filter((f) => f.until > t);
  const flashArt = fx.flashes.length ? fxArtBitmap(game, 'muzzle_flash') : null;
  for (const f of fx.flashes) {
    if (!markerInView(f.x, f.y, vx0, vy0, vx1, vy1)) continue;
    if (flashArt) {
      ctx.globalAlpha = (f.until - t) / 2;
      ctx.drawImage(flashArt, f.x - 9, f.y - 9, 18, 18);
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.fillStyle = 'rgba(255,255,255,' + ((f.until - t) / 2).toFixed(2) + ')';
    ctx.beginPath();
    ctx.arc(f.x, f.y, 6, 0, 7);
    ctx.fill();
  }

  // muzzle-smoke puffs (v5): play-once strip — the frame index runs off the
  // end of the strip (no wrap), then the puff expires
  fx.puffs = fx.puffs.filter((p) => Math.floor((t - p.born) * p.fps / 10) < p.frames);
  if (fx.puffs.length) {
    const msStrip = loopArtBitmap(game, 'loop_muzzle_smoke');
    if (msStrip) {
      for (const p of fx.puffs) {
        if (!markerInView(p.x, p.y, vx0, vy0, vx1, vy1)) continue;
        drawStripFrame(ctx, msStrip, Math.floor((t - p.born) * p.fps / 10),
          p.x, p.y, p.size);
      }
    }
  }

  fx.sparks = fx.sparks.filter((s) => s.until > t);
  for (const s of fx.sparks) {
    if (!markerInView(s.x, s.y, vx0, vy0, vx1, vy1)) continue;
    ctx.strokeStyle = 'rgba(255,214,64,' + ((s.until - t) / 3).toFixed(2) + ')';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2;
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + Math.cos(a) * 7, s.y + Math.sin(a) * 7);
    }
    ctx.stroke();
  }

  // wrecks first: the explosion frames (deaths) play on top of the hulk for
  // their first 16 ticks. 45-tick persistence with a 10-tick fade-out; with
  // wreckArt[defId] the painted husk/rubble replaces the procedural crossed
  // hulk (unit size 2r, structure rubble fp*CELL, north orientation — never
  // rotated). Structure rubble only comes from the pack: without art the
  // structure death already has its ring + smoke, no procedural hulk.
  fx.wrecks = fx.wrecks.filter((w) => w.until > t);
  for (const w of fx.wrecks) {
    if (!markerInView(w.x, w.y, vx0, vy0, vx1, vy1)) continue;
    const left = w.until - t; // 45 -> 0
    const fade = left < 10 ? left / 10 : 1;
    const art = w.defId ? wreckArtBitmap(game, w.defId) : null;
    if (art) {
      if (fade < 1) ctx.globalAlpha = fade;
      ctx.drawImage(art, w.x - w.size / 2, w.y - w.size / 2, w.size, w.size);
      if (fade < 1) ctx.globalAlpha = 1;
      continue;
    }
    if (w.struct) continue;
    if (fade < 1) ctx.globalAlpha = fade;
    ctx.strokeStyle = 'rgba(20,16,12,' + (left / 45 * 0.6).toFixed(2) + ')';
    ctx.lineWidth = 3;
    const k = w.r * 0.55;
    ctx.beginPath();
    ctx.moveTo(w.x - k, w.y - k * 0.6); ctx.lineTo(w.x + k, w.y + k * 0.6);
    ctx.moveTo(w.x + k, w.y - k * 0.6); ctx.lineTo(w.x - k, w.y + k * 0.6);
    ctx.stroke();
    if (fade < 1) ctx.globalAlpha = 1;
  }

  fx.deaths = fx.deaths.filter((d) => d.until > t);
  for (const d of fx.deaths) {
    if (!markerInView(d.x, d.y, vx0, vy0, vx1, vy1)) continue;
    if (d.boom) {
      // v4 strip: 10 frames, 2 ticks per frame; frame size from the bitmap
      const strip = fxStripBitmap(game, 'explosion_strip');
      if (strip) {
        const fs = Math.min(strip.frames - 1, Math.floor((t - d.born) / 2));
        ctx.drawImage(strip.img, fs * strip.fw, 0, strip.fw, strip.fw,
          d.x - d.r, d.y - d.r, d.r * 2, d.r * 2);
        continue;
      }
      // legacy 4-frame explosion sequence, ~4 ticks per frame
      const f = Math.min(3, Math.floor((t - d.born) / 4));
      const img = fxArtBitmap(game, 'explosion_' + f) || fxArtBitmap(game, 'explosion_0');
      if (img) {
        ctx.drawImage(img, d.x - d.r, d.y - d.r, d.r * 2, d.r * 2);
        continue;
      }
      // frame missing (decode race): fall through to the procedural ring
    }
    const p = 1 - (d.until - t) / d.total; // 0 -> 1 over the lifetime
    ctx.strokeStyle = d.col;
    ctx.globalAlpha = 1 - p;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r + p * d.r * 1.6, 0, 7);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // structure-death smoke: 20-tick lingering plume, gently rising/growing
  fx.smoke = fx.smoke.filter((s) => s.until > t);
  for (const s of fx.smoke) {
    if (!markerInView(s.x, s.y, vx0, vy0, vx1, vy1)) continue;
    const img = fxArtBitmap(game, 'smoke');
    if (!img) continue;
    const left = (s.until - t) / 20; // 1 -> 0
    const sz = s.r * 2 * (1.3 - left * 0.3);
    ctx.globalAlpha = left * 0.8;
    ctx.drawImage(img, s.x - sz / 2, s.y - sz / 2 - (1 - left) * 10, sz, sz);
    ctx.globalAlpha = 1;
  }

  fx.numbers = fx.numbers.filter((n) => n.until > t);
  if (fx.numbers.length) {
    ctx.font = 'bold 12px monospace';
    for (const n of fx.numbers) {
      const age = t - n.born;
      ctx.globalAlpha = Math.max(0, 1 - age / 30);
      ctx.fillStyle = '#ffe9a0';
      ctx.fillText('-' + n.amount, n.x, n.y - n.r - 12 - (age / 30) * 20);
      ctx.globalAlpha = 1;
    }
  }
}

// persistent order markers for one selected own unit (render-only; reads the
// v0.3.6 sim fields: u.order, u.waypoints flat [x,y,...], u.patrol [ax,ay,bx,by]).
// Fields may be absent on hand-built states — everything is guarded.
function drawOrderMarkers(ctx, game, u, vx0, vy0, vx1, vy1) {
  const st = game.state;
  const o = u.order || { type: 'idle', x: 0, y: 0, targetId: 0 };

  // patrol loop: dashed teal line between both endpoints
  const pat = u.patrol;
  if (pat && pat.length === 4
    && (markerInView(pat[0], pat[1], vx0, vy0, vx1, vy1)
      || markerInView(pat[2], pat[3], vx0, vy0, vx1, vy1))) {
    ctx.strokeStyle = '#26c6da';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pat[0], pat[1]);
    ctx.lineTo(pat[2], pat[3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // thin dotted connector in queue order: unit -> destination -> waypoints
  const pts = [[u.x, u.y]];
  const hasDest = o.type === 'move' || o.type === 'attackMove';
  if (hasDest) pts.push([o.x, o.y]);
  const wps = u.waypoints;
  if (wps && wps.length >= 2) {
    for (let i = 0; i + 1 < wps.length; i += 2) pts.push([wps[i], wps[i + 1]]);
  }
  if (pts.length >= 2) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (!markerInView(a[0], a[1], vx0, vy0, vx1, vy1)
        && !markerInView(b[0], b[1], vx0, vy0, vx1, vy1)) continue;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // destination marker: white ring for move, red ring + cross for attack-move
  if (hasDest && markerInView(o.x, o.y, vx0, vy0, vx1, vy1)) {
    if (o.type === 'attackMove') {
      ctx.strokeStyle = '#e53935';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(o.x, o.y, 8, 0, 7);
      ctx.moveTo(o.x - 12, o.y); ctx.lineTo(o.x + 12, o.y);
      ctx.moveTo(o.x, o.y - 12); ctx.lineTo(o.x, o.y + 12);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(o.x, o.y, 6, 0, 7);
      ctx.stroke();
    }
  }

  // attack-target: small red chevrons stacked over the target entity
  if (o.type === 'attackTarget' && o.targetId) {
    const t = st.units[o.targetId] || st.structures[o.targetId];
    if (t) {
      const p = t.cx !== undefined ? structCenter(t) : t;
      if (markerInView(p.x, p.y, vx0, vy0, vx1, vy1)) {
        ctx.strokeStyle = '#e53935';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = 0; k < 2; k++) {
          const cyk = p.y - 26 - k * 10;
          ctx.moveTo(p.x - 8, cyk);
          ctx.lineTo(p.x, cyk + 7);
          ctx.lineTo(p.x + 8, cyk);
        }
        ctx.stroke();
      }
    }
  }

  // numbered waypoint flags (filled triangle + queue index) at each queued
  // destination
  if (wps && wps.length >= 2) {
    ctx.font = 'bold 9px monospace';
    for (let i = 0; i + 1 < wps.length; i += 2) {
      const wx = wps[i], wy = wps[i + 1];
      if (!markerInView(wx, wy, vx0, vy0, vx1, vy1)) continue;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.lineTo(wx, wy - 14);
      ctx.lineTo(wx + 9, wy - 10);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#111111';
      ctx.fillText(String(i / 2 + 1), wx + 4, wy - 9);
    }
  }
}

// small dark type-glyph inside the silhouette (v0.3.5): bolt for power, band
// for the oil drum, person/hatch/wings/anchor for the four producers, barrel
// line for Def towers. Drawn before the white code label.
function drawStructMark(ctx, def, x, y, h) {
  const k = h * 0.45;
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2;
  ctx.beginPath();
  switch (def.id) {
    case 'SH-02': // power: lightning tick
      ctx.moveTo(x + k * 0.3, y - k);
      ctx.lineTo(x - k * 0.45, y + k * 0.15);
      ctx.lineTo(x + k * 0.1, y + k * 0.15);
      ctx.lineTo(x - k * 0.3, y + k);
      break;
    case 'SH-03': // oil depot: drum band
      ctx.moveTo(x - h * 0.58, y);
      ctx.lineTo(x + h * 0.58, y);
      break;
    case 'SH-04': // barracks: person (head + body)
      ctx.moveTo(x, y - k * 0.1);
      ctx.lineTo(x, y + k * 0.8);
      ctx.moveTo(x + k * 0.4, y - k * 0.45);
      ctx.arc(x, y - k * 0.45, k * 0.4, 0, 7);
      break;
    case 'SH-05': // war factory: tank hatch
      ctx.rect(x - k * 0.7, y - k * 0.45, k * 1.4, k * 0.9);
      break;
    case 'SH-06': // airfield: wings
      ctx.moveTo(x - k, y + k * 0.45);
      ctx.lineTo(x, y - k * 0.45);
      ctx.lineTo(x + k, y + k * 0.45);
      break;
    case 'SH-07': // naval yard: anchor
      ctx.moveTo(x, y - k);
      ctx.lineTo(x, y + k * 0.5);
      ctx.moveTo(x - k * 0.55, y - k * 0.1);
      ctx.lineTo(x + k * 0.55, y - k * 0.1);
      ctx.moveTo(x - k * 0.6, y + k * 0.15);
      ctx.arc(x, y + k * 0.15, k * 0.6, 0, Math.PI);
      break;
    default:
      if (def.type === 'Def') { // tower barrel, pointing up
        ctx.moveTo(x, y + k * 0.3);
        ctx.lineTo(x, y - h * 0.8);
      }
      break;
  }
  ctx.stroke();
}

export function renderFrame(game) {
  const st = game.state;
  const cam = game.camera;
  const ctx = game.ctx;
  if (!st || !game.render) return;
  const dpr = game.dpr || 1;
  // cam.viewW/viewH are owned by resize() in main.js — never reassigned here
  updateFogCanvas(game);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cam.viewW, cam.viewH);
  ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr,
    -cam.x * cam.zoom * dpr, -cam.y * cam.zoom * dpr);

  const worldW = st.map.w * CELL;
  const worldH = st.map.h * CELL;
  ctx.drawImage(game.render.terrain, 0, 0, worldW, worldH);

  // viewport cull rect in world coords
  const vx0 = cam.x - 80, vy0 = cam.y - 80;
  const vx1 = cam.x + cam.viewW / cam.zoom + 80;
  const vy1 = cam.y + cam.viewH / cam.zoom + 80;

  // v6 water animation: the bake stamped water_0; frames 1-3 stamp over the
  // visible water cells here, 2 fps off the sim tick (tick-driven, pauses
  // with the game). Frame 0 needs no overlay — it is already in the bake.
  const wf = game.render.waterFrames;
  if (wf) {
    const fi = Math.floor(st.tick * 2 / 10) % 4;
    // v0.9.1: fi only changes every 5 sim ticks — restamping every visible
    // water cell each rAF was ~2,100 redundant drawImages/frame at min zoom on
    // a 240 map (~93% of far-zoom draw calls). Skip the loop while fi is
    // unchanged; lastWaterFi lives on game.render, so a new match starts cold.
    if (fi !== game.render.lastWaterFi) {
      game.render.lastWaterFi = fi;
      const wimg = wf[fi];
      if (wimg && fi !== 0) {
        const wc = game.render.waterCells;
        for (let wi = 0; wi < wc.length; wi += 2) {
          const wx = wc[wi] * CELL, wy = wc[wi + 1] * CELL;
          if (wx + CELL < vx0 || wx > vx1 || wy + CELL < vy0 || wy > vy1) continue;
          ctx.drawImage(wimg, wx, wy, CELL, CELL);
        }
      }
    }
  }

  const fx = fxState(game);
  // v0.9.1: the FX state diff is tick-driven — every spawn condition is "X
  // changed since the last sim tick" and units can't move between ticks. At
  // speed 4x, renderFrame runs ~4x per tick; rerunning the diff per rAF just
  // rewalked every entity for zero new FX. Run it once per tick; drawFx still
  // runs every frame (its culling follows the live camera).
  if (fx.lastTick !== st.tick) {
    fx.lastTick = st.tick;
    updateFx(game, fx, vx0, vy0, vx1, vy1);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const selected = game.selection;

  // engineers channeling a capture: structure id -> progress fraction
  const capBars = {};
  for (const id in st.units) {
    const u = st.units[id];
    if (u.capTicks > 0 && u.capTargetId) {
      capBars[u.capTargetId] = u.capTicks / CAPTURE_TICKS;
    }
  }

  // structures
  for (const id in st.structures) {
    const s = st.structures[id];
    const px = (s.cx + s.fp / 2) * CELL;
    const py = (s.cy + s.fp / 2) * CELL;
    if (px < vx0 || px > vx1 || py < vy0 || py > vy1) continue;
    const own = s.owner === game.playerSlot;
    if (!own && !seenCell(game, s.cx, s.cy)) continue;
    const dim = !own && !visibleCell(game, px, py);
    ctx.globalAlpha = dim ? 0.45 : 1;
    const def = st.structDefs[s.defId];
    const half = s.fp * CELL / 2 - 3;
    // art pack (game.structArt data-URI): footprint-sized bitmap centered on
    // structCenter replaces silhouette + interior glyph + code label; the
    // 3px owner-color underline keeps ownership unambiguous. At <=50% hp the
    // v4 damagedArt standing state replaces the normal bitmap (same anchor).
    // Placement ghost (below) stays procedural — bitmaps are for standing
    // structures only.
    const sArt = structSpriteFor(game, s.defId, s.hp / s.maxHp);
    // v5: the animated idle strip (SH-01 ConYard crane) replaces the
    // structArt bitmap while the structure is healthy — frames are the same
    // full-footprint canvas at the same anchor. The damaged standing state
    // still wins at <=50% hp (draw damaged, not idle).
    const idle = s.hp / s.maxHp > 0.5 ? idleArtBitmap(game, s.defId) : null;
    if (idle) {
      const size = s.fp * CELL;
      drawStripFrame(ctx, idle, loopFrameIndex(st.tick, idle), px, py, size);
      ctx.fillStyle = ownerColorOf(st, s.owner);
      ctx.fillRect(px - half, py + half + 2, half * 2, 3);
    } else if (sArt) {
      const size = s.fp * CELL;
      ctx.drawImage(sArt, px - size / 2, py - size / 2, size, size);
      ctx.fillStyle = ownerColorOf(st, s.owner);
      ctx.fillRect(px - half, py + half + 2, half * 2, 3);
    } else {
      const shape = shapeForStructure(def);
      ctx.fillStyle = ownerColorOf(st, s.owner);
      traceStructShape(ctx, shape, px, py, half);
      ctx.fill();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 2;
      ctx.stroke();
      drawStructMark(ctx, def, px, py, half);
      ctx.fillStyle = '#fff';
      ctx.font = '11px monospace';
      ctx.fillText(initialsFor(def.name), px, py);
    }
    // v5 ambient overlay loops, centered on the structure and scaled to its
    // half-size (decoded pack only; free-running on the shared tick formula)
    const loopKey = s.defId === 'SH-02' ? 'loop_steam'
      : s.defId === 'SH-03' ? 'loop_pumpjack'
      : s.defId === 'SH-04' ? 'loop_flag'
      : s.defId === 'SH-08'
        || (def.type === 'Def' && def.dmg && def.dmg.air >= 50) ? 'loop_radar'
      : null;
    if (loopKey) {
      const lp = loopArtBitmap(game, loopKey);
      if (lp) {
        const lsc = loopKey === 'loop_radar' ? 0.8 : loopKey === 'loop_steam' ? 0.6 : 0.9;
        drawStripFrame(ctx, lp, loopFrameIndex(st.tick, lp), px, py, half * lsc);
      }
    }
    if (def.type === 'SW') {
      // charge ring; pulses while the superweapon is charged
      const p = st.players[s.owner];
      const ready = p && p.swChargeTicks === 0;
      ctx.strokeStyle = ready ? '#ffe9a0' : '#111';
      ctx.lineWidth = ready ? 1.5 + Math.sin(st.tick * 0.7) : 1.5;
      ctx.beginPath();
      ctx.arc(px, py, half * 0.45, 0, 7);
      ctx.stroke();
    }
    if (s.hp < s.maxHp) drawHealthBar(ctx, px, py - half - 8, half * 2, s.hp, s.maxHp);
    if (capBars[s.id] !== undefined) {
      // thin gold capture-progress bar above the health bar
      const frac = capBars[s.id];
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(px - half, py - half - 14, half * 2, 4);
      ctx.fillStyle = '#ffd76a';
      ctx.fillRect(px - half, py - half - 14, half * 2 * frac, 4);
    }
    if (own && st.tick - (s.lastRepairTick || -99) <= 10) drawRepairMark(ctx, px, py, half);
    if (selected.includes(s.id)) drawBrackets(ctx, px, py, half + 4, half + 4);
    ctx.globalAlpha = 1;
  }

  // units: filled owner-color silhouette first, glyph/label on top, then a
  // 2px owner-color stroke (v0.3.7 readability: per-class radii vs CELL=64)
  for (const id in st.units) {
    const u = st.units[id];
    if (u.x < vx0 || u.x > vx1 || u.y < vy0 || u.y > vy1) continue;
    const own = u.owner === game.playerSlot;
    if (!own && !visibleCell(game, u.x, u.y)) continue;
    const def = st.unitDefs[u.defId];
    const isMcv = u.defId === 'MCV';
    const r = unitRadius(def);
    const shape = silhouetteForUnit(def);
    const col = ownerColorOf(st, u.owner);
    const sel = selected.includes(u.id);
    // v5 ambient loops (decoded pack only). The wake trails a moving ship at
    // its stern — behind the unit, opposite the movement heading; the
    // selection pulse sits under the team ring (selected own units only).
    const uo = u.order;
    if (def.domain === 'Sea' && uo && (uo.type === 'move' || uo.type === 'attackMove')) {
      const wa = unitAimAngle(st, u);
      if (wa !== null) {
        const wk = loopArtBitmap(game, 'loop_wake');
        if (wk) {
          drawStripFrame(ctx, wk, loopFrameIndex(st.tick, wk),
            u.x - Math.cos(wa) * r, u.y - Math.sin(wa) * r, r * 2);
        }
      }
    }
    if (sel && own) {
      const sl = loopArtBitmap(game, 'loop_select');
      if (sl) drawStripFrame(ctx, sl, loopFrameIndex(st.tick, sl), u.x, u.y, r * 2.4);
    }
    // v5: a decoded rotor strip replaces the procedural rotor cross (helos)
    const rotor = String(def.cls).toLowerCase().indexOf('helo') >= 0
      ? loopArtBitmap(game, 'loop_rotor') : null;
    // tinted stance ring under the silhouette (selected own units only)
    const stance = u.stance || 0;
    if (sel && own && stance >= 1 && stance <= 3) {
      ctx.strokeStyle = STANCE_RING[stance];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(u.x, u.y, r + 5, 0, 7);
      ctx.stroke();
    }
    // team-color ground ring under every unit (v0.4.4 readability): a 3px
    // owner-color ellipse at the unit's feet, drawn before the silhouette
    ctx.strokeStyle = col;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(u.x, u.y + r * 0.85, r * 0.7, r * 0.7 * 0.35, 0, 0, 7);
    ctx.stroke();
    // art packs replace the procedural silhouette; team ring / hp bar /
    // stance ring stay either way. Heading (shared with the barrel-line
    // heuristic): aim at the order destination/target; idle units keep their
    // last angle (fx.lastAng), defaulting to north.
    // 1) pass-3 directional strips (game.dirArt): 8 baked frames
    //    N NE E SE S SW W NW, blitted straight from the strip — no rotation
    //    (per-frame SE shadows are baked by the pack).
    // 2) legacy single bitmaps (game.unitArt): north-facing, ctx.rotate path.
    const dir = dirArtBitmap(game, u.defId);
    if (dir) {
      const aim = unitAimAngle(st, u);
      if (aim !== null) fx.lastAng[u.id] = aim;
      const heading = fx.lastAng[u.id] !== undefined ? fx.lastAng[u.id] : -Math.PI / 2;
      const fi = ((Math.round((heading + Math.PI / 2) / (Math.PI / 4)) % 8) + 8) % 8;
      const fh = dir.img.naturalHeight || dir.img.height || dir.fw;
      ctx.drawImage(dir.img, fi * dir.fw, 0, dir.fw, fh,
        u.x - r, u.y - r, r * 2, r * 2);
    } else {
      const art = unitArtBitmap(game, u.defId);
      if (art) {
        const aim = unitAimAngle(st, u);
        if (aim !== null) fx.lastAng[u.id] = aim;
        const facing = fx.lastAng[u.id] !== undefined ? fx.lastAng[u.id] : -Math.PI / 2;
        const aw = art.naturalWidth || art.width || r * 2;
        const ah = art.naturalHeight || art.height || aw;
        const sc = (r * 2) / Math.max(aw, ah);
        ctx.save();
        ctx.translate(u.x, u.y);
        ctx.rotate(facing + Math.PI / 2); // bitmap north = -PI/2 world
        ctx.drawImage(art, -aw * sc / 2, -ah * sc / 2, aw * sc, ah * sc);
        ctx.restore();
      } else {
        // pre-rendered silhouette: owner fill + glyph + label + owner stroke
        const spr = unitSprite(def, r, shape, col, !!u.upgradeName); // field may be absent
        ctx.drawImage(spr, u.x - spr.width / 2, u.y - spr.height / 2);
        if (shape === 'tank') {
          drawBarrel(ctx, st, u, r, fx.recoil[u.id] !== undefined);
        } else if (shape === 'helo' && !rotor) drawRotor(ctx, u.x, u.y, r, st.tick);
      }
    }
    // painted rotor overlay, centered on the helo (rotors spin on the pad too)
    if (rotor) drawStripFrame(ctx, rotor, loopFrameIndex(st.tick, rotor), u.x, u.y, r * 2);
    if (isMcv) {
      // pulsing ring while undeployed (an MCV on the map is always undeployed)
      ctx.strokeStyle = '#ffd76a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(u.x, u.y, r + 6 + Math.sin(st.tick * 0.25) * 2, 0, 7);
      ctx.stroke();
    }
    if (u.rank > 0) {
      ctx.fillStyle = '#ffd76a';
      ctx.fillText('*'.repeat(u.rank), u.x, u.y - r - 14);
    }
    if (u.hp < u.maxHp) {
      drawHealthBar(ctx, u.x, u.y - r - 8, Math.max(26, Math.round(r * 1.4)), u.hp, u.maxHp);
    }
    if (own && st.tick - (u.lastRepairTick || -99) <= 10) drawRepairMark(ctx, u.x, u.y, r);
    if (sel) {
      drawBrackets(ctx, u.x, u.y, r + 4, r + 4);
      if (def.rangeWu > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(u.x, u.y, def.rangeWu, 0, 7);
        ctx.stroke();
      }
    }
  }

  // projectiles (SW / ability class) + hitscan tracers (render-only lines,
  // or v4 projectile sprites for weapon classes mapped in sprites.js)
  for (const id in st.projectiles) {
    const pr = st.projectiles[id];
    if (pr.x < vx0 || pr.x > vx1 || pr.y < vy0 || pr.y > vy1) continue;
    if (!visibleCell(game, pr.x, pr.y) && !visibleCell(game, pr.tx, pr.ty)) continue;
    if (pr.kind === 'tracer') {
      // sprite path: north-up bitmap at lerp(from,to,progress), rotated to
      // the shot heading (same convention as unit bitmaps: north = -PI/2),
      // sized 2x the fxMeta world-unit radius. Unmapped cls / undecoded /
      // missing fxMeta radius -> the line below, unchanged.
      const proj = pr.cls ? projArtForCls(game, pr.cls) : null;
      if (proj) {
        const prog = 1 - pr.ticksLeft / pr.total;
        const pwx = pr.sx + (pr.tx - pr.sx) * prog;
        const pwy = pr.sy + (pr.ty - pr.sy) * prog;
        const heading = Math.atan2(pr.ty - pr.sy, pr.tx - pr.sx);
        ctx.save();
        ctx.translate(pwx, pwy);
        ctx.rotate(heading + Math.PI / 2);
        ctx.drawImage(proj.img, -proj.r, -proj.r, proj.r * 2, proj.r * 2);
        ctx.restore();
        continue;
      }
    }
    if (pr.kind === 'tracer' || pr.kind === 'telegraph') {
      const a = Math.max(0.2, pr.ticksLeft / pr.total);
      ctx.strokeStyle = pr.kind === 'telegraph' ? 'rgba(255,215,106,' + a + ')'
        : ownerColorOf(st, pr.owner);
      ctx.globalAlpha = a;
      ctx.lineWidth = pr.kind === 'telegraph' ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(pr.sx, pr.sy);
      ctx.lineTo(pr.tx, pr.ty);
      ctx.stroke();
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.fillStyle = '#ffe9a0';
    ctx.beginPath();
    ctx.arc(pr.x, pr.y, 4, 0, 7);
    ctx.fill();
  }

  // combat FX: muzzle flashes, impact sparks, death rings/wrecks, damage
  // numbers (render-side; spawned from state diffs in updateFx)
  drawFx(ctx, game, fx, vx0, vy0, vx1, vy1);

  // placement ghost: per-cell legality tint, build-radius circle, oil rings
  if (game.placement && game.mouse.inside) {
    const def = st.structDefs[game.placement.structId];
    const w = screenToWorld(cam, game.mouse.sx, game.mouse.sy);
    const rawCx = Math.floor(w.x / CELL) - (def.fp >> 1);
    const rawCy = Math.floor(w.y / CELL) - (def.fp >> 1);
    const spot = resolvePlacement(st, game.playerSlot, def, rawCx, rawCy);
    const gx = spot ? spot.cx : rawCx;
    const gy = spot ? spot.cy : rawCy;

    // build-radius circle from the nearest friendly Core/Prod structure
    const base = nearestBaseStruct(st, game.playerSlot, w.x, w.y);
    if (base) {
      const c = structCenter(base);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, BUILD_RADIUS * CELL, 0, 7);
      ctx.stroke();
    }

    // oil depot: ring every oil field
    if (def.id === 'SH-03') {
      ctx.strokeStyle = 'rgba(232,200,74,0.8)';
      ctx.lineWidth = 2;
      for (const oid in st.oilFields) {
        const o = st.oilFields[oid];
        ctx.beginPath();
        ctx.arc(o.x, o.y, (4 + def.fp / 2) * CELL, 0, 7);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(o.x, o.y, 8, 0, 7);
        ctx.stroke();
      }
    }

    // per-cell tint across the footprint
    for (let dy = 0; dy < def.fp; dy++) {
      for (let dx = 0; dx < def.fp; dx++) {
        const ok = cellBuildable(st, gx + dx, gy + dy);
        ctx.fillStyle = ok ? 'rgba(76,175,80,0.38)' : 'rgba(229,57,53,0.45)';
        ctx.fillRect((gx + dx) * CELL + 1, (gy + dy) * CELL + 1, CELL - 2, CELL - 2);
      }
    }
    // outline: silhouette of the building, green when the spot is legal
    const gpx = (gx + def.fp / 2) * CELL;
    const gpy = (gy + def.fp / 2) * CELL;
    const ghalf = def.fp * CELL / 2 - 3;
    ctx.globalAlpha = 0.9;
    traceStructShape(ctx, shapeForStructure(def), gpx, gpy, ghalf);
    ctx.fillStyle = spot ? 'rgba(76,175,80,0.25)' : 'rgba(229,57,53,0.25)';
    ctx.fill();
    ctx.strokeStyle = spot ? '#4caf50' : '#e53935';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // snapped away from the cursor? mark the raw clicked cell
    if (spot && spot.adjusted) {
      ctx.strokeStyle = 'rgba(229,57,53,0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(rawCx * CELL + 4, rawCy * CELL + 4,
        def.fp * CELL - 8, def.fp * CELL - 8);
      ctx.beginPath();
      ctx.moveTo((rawCx + def.fp / 2) * CELL, (rawCy + def.fp / 2) * CELL);
      ctx.lineTo((gx + def.fp / 2) * CELL, (gy + def.fp / 2) * CELL);
      ctx.stroke();
    }
  }

  // SW / ability target preview
  if (game.targeting && game.mouse.inside) {
    const w = screenToWorld(cam, game.mouse.sx, game.mouse.sy);
    const radius = (game.targeting.kind === 'sw' ? 5 : 3) * CELL;
    ctx.strokeStyle = '#ffd76a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w.x, w.y, radius, 0, 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w.x - 10, w.y); ctx.lineTo(w.x + 10, w.y);
    ctx.moveTo(w.x, w.y - 10); ctx.lineTo(w.x, w.y + 10);
    ctx.stroke();
  }

  // attack-move cursor marker
  if (game.attackMoveArmed && game.mouse.inside) {
    const w = screenToWorld(cam, game.mouse.sx, game.mouse.sy);
    ctx.strokeStyle = '#e53935';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w.x - 10, w.y); ctx.lineTo(w.x + 10, w.y);
    ctx.moveTo(w.x, w.y - 10); ctx.lineTo(w.x, w.y + 10);
    ctx.stroke();
  }

  // fog overlay: the 4px/cell canvas upscales to world size WITH smoothing
  // (soft fog edges). Everything else keeps the caller's smoothing state.
  const smoothPrev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(game.render.fog, 0, 0, worldW, worldH);
  ctx.imageSmoothingEnabled = smoothPrev;

  // rally lines/flags for selected production structures (sim-side rally).
  // v0.6.0 visibility rework: a tall owner-color pennant on a dark pole, a
  // pulsing circle at the exact anchor, and a thick two-tone dashed line
  // from the producer's door edge. Sizes are zoom-compensated (capped) so
  // the marker stays readable at min zoom. Drawn over the fog overlay (same
  // rule as order markers): an own rally is always fully visible.
  if (st.rally) {
    const zs = Math.min(2.5, Math.max(1, 1 / cam.zoom));
    for (const id of game.selection) {
      const s = st.structures[id];
      const r = s && st.rally[s.id];
      if (!r) continue;
      const col = ownerColorOf(st, s.owner);
      const c = structCenter(s);
      const doorX = c.x, doorY = c.y + s.fp * CELL / 2; // south (door) edge
      // 3px dashed connector, alternating faction color / white
      ctx.lineWidth = 3 * zs;
      ctx.setLineDash([8 * zs, 8 * zs]);
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(doorX, doorY);
      ctx.lineTo(r.x, r.y);
      ctx.stroke();
      ctx.strokeStyle = col;
      ctx.lineDashOffset = -8 * zs;
      ctx.beginPath();
      ctx.moveTo(doorX, doorY);
      ctx.lineTo(r.x, r.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      // pulsing circle at the exact anchor point
      const pulse = 1 + Math.sin(st.tick * 0.3) * 0.25;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5 * zs;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 11 * zs * pulse, 0, 7);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(r.x, r.y, 2.5 * zs, 0, 7);
      ctx.fill();
      // tall pennant: dark pole to the ground point, owner-color triangle
      const poleH = 40 * zs, flagH = 26 * zs, flagW = 18 * zs;
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 3 * zs;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x, r.y - poleH);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y - poleH);
      ctx.lineTo(r.x + flagW, r.y - poleH + flagH / 2);
      ctx.lineTo(r.x, r.y - poleH + flagH);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 1.5 * zs;
      ctx.stroke();
    }
  }

  // persistent order markers for selected own units (over fog: the player
  // always knows their own orders; fades naturally as orders go idle)
  for (const selId of selected) {
    const su = st.units[selId];
    if (!su || su.owner !== game.playerSlot) continue;
    drawOrderMarkers(ctx, game, su, vx0, vy0, vx1, vy1);
  }

  // box-select rect (screen space)
  if (game.drag && !game.placement && !game.targeting && !game.attackMoveArmed) {
    const d = game.drag;
    if (Math.max(Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)) >= 6) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // drag coords are CSS px
      ctx.strokeStyle = '#7c7';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1),
        Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
  }
}
