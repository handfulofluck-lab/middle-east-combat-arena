// Pure placement UX helpers: click forgiveness (snap to a nearby legal spot),
// human-readable block reasons, per-cell legality for the ghost tint, and
// base-proximity lookups for the build-radius circle. No sim semantics here —
// everything is derived from canPlace / findPlacement.
import {
  CELL, canPlace, findPlacement, standingStructs, structCenter, BUILD_RADIUS,
} from '../sim/index.js';

// how far (cells) a click is allowed to miss and still snap to a legal spot
export const FORGIVE_RADIUS = 3;

// clicked cell -> legal spot (exact or snapped), or null if none nearby
export function resolvePlacement(state, slot, structDef, cx, cy) {
  if (canPlace(state, slot, structDef, cx, cy)) return { cx, cy, adjusted: false };
  const f = findPlacement(state, slot, structDef, cx, cy, FORGIVE_RADIUS);
  if (f) return { cx: f.x, cy: f.y, adjusted: true };
  return null;
}

function plcTerrainAt(state, cx, cy) {
  const { w, h, terrain } = state.map;
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return -1;
  return terrain[cy * w + cx];
}

// single-cell legality for the ghost's per-cell tint (terrain + occupancy only)
export function cellBuildable(state, cx, cy) {
  if (plcTerrainAt(state, cx, cy) !== 0) return false;
  for (const id in state.structures) {
    const s = state.structures[id];
    if (cx >= s.cx && cx < s.cx + s.fp && cy >= s.cy && cy < s.cy + s.fp) return false;
  }
  return true;
}

function isCoreOrProd(state, s) {
  const t = state.structDefs[s.defId].type;
  return t === 'Core' || t === 'Prod';
}

// nearest owned Core/Prod structure to a world point (for the radius circle)
export function nearestBaseStruct(state, slot, wx, wy) {
  let best = null, bestD = Infinity;
  for (const s of standingStructs(state, slot, (x) => isCoreOrProd(state, x))) {
    const c = structCenter(s);
    const dx = c.x - wx, dy = c.y - wy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

function withinBuildRadius(state, slot, structDef, cx, cy) {
  const a = structCenter({ cx, cy, fp: structDef.fp });
  return standingStructs(state, slot, (s) => isCoreOrProd(state, s)).some((s) => {
    const b = structCenter(s);
    return Math.max(Math.abs(a.x - b.x) / CELL, Math.abs(a.y - b.y) / CELL) <= BUILD_RADIUS;
  });
}

function hasAdjacentWater(state, cx, cy, fp) {
  for (let dy = -1; dy <= fp; dy++) {
    for (let dx = -1; dx <= fp; dx++) {
      if (plcTerrainAt(state, cx + dx, cy + dy) === 2) return true;
    }
  }
  return false;
}

function nearOilField(state, structDef, cx, cy) {
  const fp = structDef.fp;
  const c = structCenter({ cx, cy, fp });
  return Object.values(state.oilFields).some((o) => {
    const dx = Math.abs(o.x - c.x) / CELL;
    const dy = Math.abs(o.y - c.y) / CELL;
    return Math.max(dx, dy) <= 4 + fp / 2;
  });
}

// why canPlace fails at (cx, cy), phrased for the cursor flash label;
// null when the spot is actually legal
export function placementBlockReason(state, slot, structDef, cx, cy) {
  if (canPlace(state, slot, structDef, cx, cy)) return null;
  if (!withinBuildRadius(state, slot, structDef, cx, cy)) return 'Too far from base';
  let open = true;
  for (let dy = 0; dy < structDef.fp && open; dy++) {
    for (let dx = 0; dx < structDef.fp && open; dx++) {
      if (!cellBuildable(state, cx + dx, cy + dy)) open = false;
    }
  }
  if (structDef.id === 'SH-07' && !hasAdjacentWater(state, cx, cy, structDef.fp)) {
    return 'Needs water';
  }
  if (structDef.id === 'SH-03' && !nearOilField(state, structDef, cx, cy)) {
    return 'Needs oil field';
  }
  if (!open) return 'Blocked';
  return 'Blocked';
}
