// Pathfinding (v0.3.1 WAVE-2): 8-direction A* on the map cell grid.
// Chosen over a flow field: orders here are individual / small-group with
// distinct destinations, so per-unit A* with early exit is cheaper and far
// simpler to keep deterministic than maintaining per-target flow caches.
// Deterministic by construction: integer costs (orthogonal 10, diagonal 14),
// octile integer heuristic, fixed neighbor order, heap ties broken by cell
// index. No floats, no Math.random; paths are plain int arrays on the unit.
// The grid mirrors the real passable() rules: terrain + structure footprints,
// per domain (land/sea). Air units fly straight and never use the grid.
// Units are soft obstacles — never marked; crowding is unresolved overlap,
// same as before.
import { CELL, cellOf, sortedIds, structCenter } from './state.js';

const ORTHO = 10;
const DIAG = 14;
const MAX_EXPAND = 8192; // worst-case cap; A* with octile heuristic rarely nears it
// fixed neighbor order: orthogonals first, then diagonals
const NB = [
  [0, -1, ORTHO], [0, 1, ORTHO], [-1, 0, ORTHO], [1, 0, ORTHO],
  [-1, -1, DIAG], [1, -1, DIAG], [-1, 1, DIAG], [1, 1, DIAG],
];

// passability grid for a domain (1 = enterable). Structures block land units;
// sea units keep to water (yards sit on land, so footprints can't overlap).
export function passGrid(state, domain) {
  const { w, h, terrain } = state.map;
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const t = terrain[i];
    g[i] = domain === 'Sea' ? (t === 2 ? 1 : 0) : (t === 0 ? 1 : 0);
  }
  if (domain !== 'Sea') {
    for (const id of sortedIds(state.structures)) {
      const s = state.structures[id];
      for (let dy = 0; dy < s.fp; dy++) {
        for (let dx = 0; dx < s.fp; dx++) {
          const cx = s.cx + dx, cy = s.cy + dy;
          if (cx >= 0 && cy >= 0 && cx < w && cy < h) g[cy * w + cx] = 0;
        }
      }
    }
  }
  return g;
}

// Cached grids (v0.3.2): rebuilt at most once per tick per domain, and
// invalidated immediately when structures change (structVersion). All A*
// calls in a tick share the grid. `builds` is a test-instrumentation counter.
export function passGridCached(state, domain) {
  let c = state._gridCache;
  if (!c) {
    c = state._gridCache = { tick: -1, version: -1, builds: 0, Land: null, Sea: null };
  }
  if (c.tick !== state.tick || c.version !== state.structVersion) {
    c.tick = state.tick;
    c.version = state.structVersion;
    c.Land = null;
    c.Sea = null;
  }
  if (!c[domain]) {
    c[domain] = passGrid(state, domain);
    c.builds++;
  }
  return c[domain];
}

// v0.3.3: pick the pass grid that matches what a producer actually outputs,
// so a naval yard rallies to water and a war factory to land. Air units fly
// over everything and simply get no default rally (their order stays idle
// until the player or AI moves them).
function domainForProducer(state, s) {
  switch (s.defId) {
    case 'SH-07': return 'Sea';
    case 'SH-06': return 'Air';
    default: return 'Land';
  }
}

// default rally for a fresh producer (v0.3.2, sim-side so humans and AI share
// it): 3 cells toward the map center on a passable cell; if blocked, spiral
// outward for the legal cell CLOSEST to map center; null when truly none.
export function defaultRallyCell(state, s) {
  const { w, h } = state.map;
  const domain = domainForProducer(state, s);
  if (domain === 'Air') return null;
  const g = passGridCached(state, domain);
  const open = (cx, cy) => cx >= 0 && cy >= 0 && cx < w && cy < h && g[cy * w + cx] === 1;
  const c = structCenter(s);
  const pcx = cellOf(c.x), pcy = cellOf(c.y);
  const sx = Math.sign((w >> 1) - pcx), sy = Math.sign((h >> 1) - pcy);
  for (let d = 3; d >= 1; d--) {
    if (open(pcx + sx * d, pcy + sy * d)) {
      return { x: (pcx + sx * d) * CELL + CELL / 2, y: (pcy + sy * d) * CELL + CELL / 2 };
    }
  }
  let best = null, bestScore = Infinity;
  for (let r = 1; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!open(pcx + dx, pcy + dy)) continue;
        const qx = pcx + dx - (w >> 1), qy = pcy + dy - (h >> 1);
        const sc = qx * qx + qy * qy;
        if (sc < bestScore) { bestScore = sc; best = { dx, dy }; }
      }
    }
    if (best) break;
  }
  if (best) {
    return { x: (pcx + best.dx) * CELL + CELL / 2, y: (pcy + best.dy) * CELL + CELL / 2 };
  }
  return null;
}

// nearest enterable cell to (cx,cy), ring search in fixed order, or -1
function nearestOpen(g, w, h, cx, cy) {
  for (let r = 1; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (g[y * w + x]) return y * w + x;
      }
    }
  }
  return -1;
}

// A* from cell (sx,sy) to cell (tx,ty). Returns cell-index waypoints
// (excluding the start cell, ending at the goal) or null when unreachable
// within the expansion cap. The start cell always counts as enterable, so a
// unit placed inside a footprint can still path out.
export function findPathCells(state, def, sx, sy, tx, ty) {
  const { w, h } = state.map;
  if (def.domain === 'Air') return null;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  tx = Math.max(0, Math.min(w - 1, tx));
  ty = Math.max(0, Math.min(h - 1, ty));
  const g = passGridCached(state, def.domain);
  const start = sy * w + sx;
  let goal = ty * w + tx;
  if (!g[goal]) goal = nearestOpen(g, w, h, tx, ty);
  if (goal < 0 || goal === start) return null;

  const n = w * h;
  const gScore = new Int32Array(n).fill(-1);
  const fScore = new Int32Array(n);
  const hScore = new Int32Array(n);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const gx = goal % w, gy = (goal / w) | 0;
  // octile distance, integer-scaled
  const heur = (i) => {
    const dx = Math.abs((i % w) - gx), dy = Math.abs(((i / w) | 0) - gy);
    return ORTHO * Math.max(dx, dy) + (DIAG - ORTHO) * Math.min(dx, dy);
  };

  // binary min-heap of cell indices, ordered by (f, h, index)
  const heap = [];
  const less = (a, b) => (fScore[a] !== fScore[b] ? fScore[a] < fScore[b]
    : hScore[a] !== hScore[b] ? hScore[a] < hScore[b] : a < b);
  const push = (i) => {
    heap.push(i);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!less(heap[c], heap[p])) break;
      const t = heap[c]; heap[c] = heap[p]; heap[p] = t;
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === p) break;
        const t = heap[p]; heap[p] = heap[m]; heap[m] = t;
        p = m;
      }
    }
    return top;
  };

  gScore[start] = 0;
  hScore[start] = heur(start);
  fScore[start] = hScore[start];
  push(start);
  let expanded = 0;
  while (heap.length && expanded < MAX_EXPAND) {
    const cur = pop();
    if (closed[cur]) continue; // stale heap entry
    closed[cur] = 1;
    expanded++;
    if (cur === goal) {
      const path = [];
      for (let i = goal; i !== start; i = cameFrom[i]) path.push(i);
      path.reverse();
      return path;
    }
    const cx = cur % w, cy = (cur / w) | 0;
    for (let k = 0; k < NB.length; k++) {
      const dx = NB[k][0], dy = NB[k][1], cost = NB[k][2];
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (closed[ni] || !g[ni]) continue;
      if (cost === DIAG) {
        // no corner cutting: both orthogonal neighbors must be enterable
        if (!g[cy * w + nx] || !g[ny * w + cx]) continue;
      }
      const ng = gScore[cur] + cost;
      if (gScore[ni] >= 0 && ng >= gScore[ni]) continue;
      gScore[ni] = ng;
      cameFrom[ni] = cur;
      hScore[ni] = heur(ni);
      fScore[ni] = ng + hScore[ni];
      push(ni);
    }
  }
  return null;
}
