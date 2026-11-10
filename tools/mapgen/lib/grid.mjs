// Cell-grid utilities shared by the generator, validator and preview renderer:
// symmetry maps, cleanup passes (majority smoothing, thin-feature removal,
// small-component removal), connected components, distance fields.
// Terrain codes: 0 = land, 1 = rock, 2 = water.

export const LAND = 0, ROCK = 1, WATER = 2;

// ---- exact grid symmetries ---------------------------------------------------
// Each op maps a cell (x, y) to its image. 'hex' maps are only exactly
// symmetric under the 180-degree rotation (60-degree turns are not grid
// symmetries); the remaining 6-fold structure is approximate.
export function gridOps(symmetry, w, h) {
  const id = (x, y) => [x, y];
  const r2 = (x, y) => [w - 1 - x, h - 1 - y];
  const mx = (x, y) => [w - 1 - x, y];
  const my = (x, y) => [x, h - 1 - y];
  const r4 = (x, y) => [h - 1 - y, x];
  const r4c = (x, y) => [y, w - 1 - x];
  switch (symmetry) {
    case 'none': return [id];
    case 'rot2': case 'hex': return [id, r2];
    case 'mirrorX': return [id, mx];
    case 'mirrorY': return [id, my];
    case 'mirrorXY': return [id, mx, my, r2];
    case 'rot4':
      if (w !== h) throw new Error('rot4 needs a square map');
      return [id, r4, r2, r4c];
    default: throw new Error('unknown symmetry ' + symmetry);
  }
}

// number of cells that differ from their image under any op (0 = exact)
export function asymmetry(t, w, h, symmetry) {
  const ops = gridOps(symmetry, w, h);
  let bad = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = t[y * w + x];
      for (let k = 1; k < ops.length; k++) {
        const [ix, iy] = ops[k](x, y);
        if (t[iy * w + ix] !== v) { bad++; break; }
      }
    }
  }
  return bad;
}

// force exact symmetry: every orbit takes the value of its lowest-index cell
export function symmetrize(t, w, h, symmetry) {
  const ops = gridOps(symmetry, w, h);
  if (ops.length === 1) return t;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let lo = i;
      for (let k = 1; k < ops.length; k++) {
        const [ix, iy] = ops[k](x, y);
        const j = iy * w + ix;
        if (j < lo) lo = j;
      }
      if (lo !== i) t[i] = t[lo];
    }
  }
  return t;
}

// ---- cleanup passes ----------------------------------------------------------
// 3x3 mode filter: a cell flips to the neighbourhood majority when its own
// type holds fewer than `keep` of the 9 cells. Out-of-map counts as the cell's
// own type (edges are stable). Isotropic, so symmetric input stays symmetric.
export function majority(t, w, h, iterations = 1, keep = 4) {
  let cur = t;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = cur[y * w + x];
        const c = [0, 0, 0];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            c[(nx < 0 || ny < 0 || nx >= w || ny >= h) ? v : cur[ny * w + nx]]++;
          }
        }
        if (c[v] >= keep) continue;
        // strict winner only; ties keep the cell (deterministic + symmetric)
        let best = v, bc = c[v];
        for (let k = 0; k < 3; k++) if (c[k] > bc) { bc = c[k]; best = k; }
        out[y * w + x] = best;
      }
    }
    cur = out;
  }
  t.set(cur);
  return t;
}

// A cell is "thin" when its own type does not continue on either side along
// an axis (N+S both different, or E+W both different) — 1-cell fins, 1-cell
// corridors and lone speckles. Returns indices of thin cells.
export function thinCells(t, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, v = t[i];
      const n = y > 0 ? t[i - w] : v, s = y < h - 1 ? t[i + w] : v;
      const e = x < w - 1 ? t[i + 1] : v, wv = x > 0 ? t[i - 1] : v;
      if ((n !== v && s !== v) || (e !== v && wv !== v)) out.push(i);
    }
  }
  return out;
}

// 2x2 checkerboards: two same-type cells touching only at a corner while the
// other diagonal is another type — reads as a 1-cell diagonal gap/bridge.
export function diagonalPinches(t, w, h) {
  const out = [];
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const a = t[y * w + x], b = t[y * w + x + 1];
      const c = t[(y + 1) * w + x], d = t[(y + 1) * w + x + 1];
      if (a === d && b === c && a !== b) out.push(y * w + x);
    }
  }
  return out;
}

// Remove thin cells and diagonal pinches until stable. Thin cells take the
// majority type of their 8 neighbours (excluding their own type); pinch
// blocks are resolved toward LAND (opens a clean 2-wide gap) unless neither
// type is land, in which case toward WATER.
export function declutter(t, w, h, maxIter = 12) {
  for (let it = 0; it < maxIter; it++) {
    let changed = 0;
    const thin = thinCells(t, w, h);
    if (thin.length) {
      const snap = new Uint8Array(t);
      for (const i of thin) {
        const x = i % w, y = (i / w) | 0, v = snap[i];
        const c = [0, 0, 0];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            c[snap[ny * w + nx]]++;
          }
        }
        c[v] = -1;
        let best = 0;
        for (let k = 1; k < 3; k++) if (c[k] > c[best]) best = k;
        if (c[best] > 0 && best !== v) { t[i] = best; changed++; }
      }
    }
    const pinch = diagonalPinches(t, w, h);
    if (pinch.length) {
      const snap = new Uint8Array(t);
      for (const i of pinch) {
        const a = snap[i], b = snap[i + 1];
        const to = (a === LAND || b === LAND) ? LAND : WATER;
        for (const j of [i, i + 1, i + w, i + w + 1]) if (t[j] !== to) { t[j] = to; changed++; }
      }
    }
    if (!changed) return it;
  }
  return maxIter;
}

// 4-connected components of cells whose type satisfies pred(type).
// Returns { label: Int32Array (-1 outside), sizes: number[] }.
export function components(t, w, h, pred) {
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (label[s] !== -1 || !pred(t[s])) continue;
    const id = sizes.length;
    let n = 0;
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      n++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && label[i - 1] === -1 && pred(t[i - 1])) { label[i - 1] = id; stack.push(i - 1); }
      if (x < w - 1 && label[i + 1] === -1 && pred(t[i + 1])) { label[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && label[i - w] === -1 && pred(t[i - w])) { label[i - w] = id; stack.push(i - w); }
      if (y < h - 1 && label[i + w] === -1 && pred(t[i + w])) { label[i + w] = id; stack.push(i + w); }
    }
    sizes.push(n);
  }
  return { label, sizes };
}

// Replace components of `type` smaller than minSize with the type that
// dominates their border (isotropic -> symmetry-safe).
export function removeSmall(t, w, h, type, minSize) {
  const { label, sizes } = components(t, w, h, (v) => v === type);
  const border = sizes.map(() => [0, 0, 0]);
  for (let i = 0; i < w * h; i++) {
    const id = label[i];
    if (id < 0 || sizes[id] >= minSize) continue;
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && label[i - 1] !== id) border[id][t[i - 1]]++;
    if (x < w - 1 && label[i + 1] !== id) border[id][t[i + 1]]++;
    if (y > 0 && label[i - w] !== id) border[id][t[i - w]]++;
    if (y < h - 1 && label[i + w] !== id) border[id][t[i + w]]++;
  }
  let removed = 0;
  for (let i = 0; i < w * h; i++) {
    const id = label[i];
    if (id < 0 || sizes[id] >= minSize) continue;
    const b = border[id];
    let best = type === LAND ? ROCK : LAND;
    let bc = -1;
    for (let k = 0; k < 3; k++) if (k !== type && b[k] > bc) { bc = b[k]; best = k; }
    t[i] = best;
    removed++;
  }
  return removed;
}

// ---- distance fields -----------------------------------------------------------
// Two-pass chamfer (3-4) distance, in cells, to the nearest cell where
// pred(type) is true. Cells satisfying pred get 0.
export function distanceTo(t, w, h, pred) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = pred(t[i]) ? 0 : INF;
  const A = 1, B = 1.41421356;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + A);
      if (y > 0) {
        v = Math.min(v, d[i - w] + A);
        if (x > 0) v = Math.min(v, d[i - w - 1] + B);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + B);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + A);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + A);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + B);
        if (x > 0) v = Math.min(v, d[i + w - 1] + B);
      }
      d[i] = v;
    }
  }
  return d;
}

// Dijkstra over a pass grid (1 = enterable) with the sim's movement model:
// 8 directions, cost 10 / 14, no diagonal corner cutting. Returns Int32Array
// of costs (-1 = unreachable). `sources` is an array of cell indices.
export function pathCost(pass, w, h, sources) {
  const n = w * h;
  const dist = new Int32Array(n).fill(-1);
  // bucket queue (costs are small ints): simple binary heap of [cost, cell]
  const heap = [];
  const push = (c, i) => {
    heap.push([c, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      const tmp = heap[p]; heap[p] = heap[k]; heap[k] = tmp;
      k = p;
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
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === p) break;
        const tmp = heap[p]; heap[p] = heap[m]; heap[m] = tmp;
        p = m;
      }
    }
    return top;
  };
  const best = new Int32Array(n).fill(0x7fffffff);
  for (const s of sources) { best[s] = 0; push(0, s); }
  while (heap.length) {
    const [c, i] = pop();
    if (dist[i] !== -1) continue;
    dist[i] = c;
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!pass[j] || dist[j] !== -1) continue;
        if (dx && dy && (!pass[y * w + nx] || !pass[ny * w + x])) continue;
        const nc = c + (dx && dy ? 14 : 10);
        if (nc < best[j]) { best[j] = nc; push(nc, j); }
      }
    }
  }
  return dist;
}
