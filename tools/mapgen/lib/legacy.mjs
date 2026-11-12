// Legacy-map helpers shared by the generator and the repair solver.
// A repair record (see legacy_repairs.mjs) is pure data:
//   { tags, terrain?: [op], spawnMoves?: [[fx, fy, tx, ty]],
//     oilMoves?: [[fx, fy, tx, ty]], oilAdds?: [[x, y]] }
// applyRepair() is idempotent: applying it to an already repaired map changes
// nothing, so `generate.mjs` can run on originals and on repaired files alike.

// ---- terrain ops ---------------------------------------------------------------
// { op: 'land-disc', cx, cy, r }: every WATER cell whose centre lies within r
// of the point (cx, cy) becomes land. Rock is left alone.
export function applyTerrainOps(terrain, w, h, ops = []) {
  const t = terrain.slice();
  let changed = 0;
  for (const op of ops) {
    if (op.op !== 'land-disc') throw new Error('unknown terrain op ' + op.op);
    const r2 = op.r * op.r;
    for (let y = Math.max(0, Math.floor(op.cy - op.r)); y <= Math.min(h - 1, Math.ceil(op.cy + op.r)); y++) {
      for (let x = Math.max(0, Math.floor(op.cx - op.r)); x <= Math.min(w - 1, Math.ceil(op.cx + op.r)); x++) {
        const dx = x + 0.5 - op.cx, dy = y + 0.5 - op.cy;
        if (dx * dx + dy * dy <= r2 && t[y * w + x] === 2) { t[y * w + x] = 0; changed++; }
      }
    }
  }
  return { terrain: t, changed };
}

// move [fx, fy] -> [tx, ty] inside a point list, keeping the list index
function movePoints(list, moves, label) {
  const out = list.map((p) => ({ x: p.x, y: p.y }));
  for (const [fx, fy, tx, ty] of moves) {
    const i = out.findIndex((p) => p.x === fx && p.y === fy);
    if (i >= 0) { out[i] = { x: tx, y: ty }; continue; }
    if (!out.some((p) => p.x === tx && p.y === ty)) throw new Error(`${label} (${fx},${fy}) not found (and not already at (${tx},${ty}))`);
  }
  return out;
}

// repaired { terrain, oil, spawns } for a parsed map
export function applyRepair(map, repair) {
  const { w, h } = map;
  const { terrain } = applyTerrainOps(map.terrain, w, h, repair.terrain);
  const spawns = movePoints(map.spawns, repair.spawnMoves || [], 'spawn');
  const oil = movePoints(map.oil, repair.oilMoves || [], 'oil');
  for (const [x, y] of repair.oilAdds || []) {
    if (!oil.some((o) => o.x === x && o.y === y)) oil.push({ x, y });
  }
  return { terrain, oil, spawns };
}

// the oil list as it was before the recorded oil moves / adds (solver input)
export function originalOil(map, repair) {
  let oil = map.oil.map((o) => ({ x: o.x, y: o.y }));
  const adds = repair.oilAdds || [];
  oil = oil.filter((o) => !adds.some(([x, y]) => o.x === x && o.y === y));
  for (const [fx, fy, tx, ty] of repair.oilMoves || []) {
    const i = oil.findIndex((o) => o.x === tx && o.y === ty);
    if (i >= 0) oil[i] = { x: fx, y: fy };
  }
  return oil;
}

// ---- text-level edits (every untouched byte of the file is preserved) -------------
// replace the JSON array value of a top-level key ("terrain", "oil", "spawns")
export function replaceArrayField(text, key, value) {
  const tag = `"${key}":[`;
  const a = text.indexOf(tag);
  if (a < 0 || text.indexOf(tag, a + 1) >= 0) throw new Error(`cannot locate a unique "${key}" array`);
  const b = text.indexOf(']', a + tag.length); // these arrays never nest brackets
  return text.slice(0, a) + `"${key}":` + JSON.stringify(value) + text.slice(b + 1);
}
