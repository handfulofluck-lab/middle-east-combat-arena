// MapBuilder: paint terrain with signed-distance brushes, replicate every
// brush through the map's symmetry group, then run the cleanup pipeline and
// emit the map JSON object. A design only describes ONE player's sector (plus
// shared central features); the builder makes the rest.
import { mulberry32, subSeed } from './prng.mjs';
import { makeFbm } from './noise.mjs';
import * as G from './grid.mjs';

const H3 = Math.sqrt(3) / 2;
// exact (cos, sin) of k * 60 degrees — no trig calls
const HEX = [[1, 0], [0.5, H3], [-0.5, H3], [-1, 0], [-0.5, -H3], [0.5, -H3]];

// spawn-list order per symmetry: index into the orbit. Slots 0 and 1 are
// always OPPOSITE each other (a 1v1 on a bigger map uses spawns[0] vs [1]),
// then the next opposite pair, and so on.
const ORBIT_ORDER = {
  none: [0],
  rot2: [0, 1],
  mirrorX: [0, 1],
  mirrorY: [0, 1],
  mirrorXY: [0, 3, 1, 2],   // gridOps order: id, mx, my, r2
  rot4: [0, 2, 1, 3],       // id, r90, r180, r270
  hex: [0, 3, 1, 4, 2, 5],  // k * 60 degrees
};

export class MapBuilder {
  constructor({ id, name, w, h, seed, symmetry }) {
    this.id = id;
    this.name = name;
    this.w = w;
    this.h = h;
    this.seed = seed >>> 0;
    this.symmetry = symmetry;
    this.cx = w / 2;
    this.cy = h / 2;
    this.t = new Uint8Array(w * h); // all land
    this.spawns = [];
    this.oil = [];
    this.pads = [];      // forced-land discs applied right before cleanup
    this.rng = mulberry32(subSeed(this.seed, 'design'));
    this._salt = 0;
  }

  // ---- symmetry ---------------------------------------------------------------
  // continuous images of a point under the symmetry group (identity first)
  images(x, y) {
    const { w, h, cx, cy } = this;
    switch (this.symmetry) {
      case 'none': return [[x, y]];
      case 'rot2': return [[x, y], [w - x, h - y]];
      case 'mirrorX': return [[x, y], [w - x, y]];
      case 'mirrorY': return [[x, y], [x, h - y]];
      case 'mirrorXY': return [[x, y], [w - x, y], [x, h - y], [w - x, h - y]];
      case 'rot4': return [[x, y], [w - y, x], [w - x, h - y], [y, h - x]];
      case 'hex': {
        const dx = x - cx, dy = y - cy;
        return HEX.map(([c, s]) => [cx + dx * c - dy * s, cy + dx * s + dy * c]);
      }
      default: throw new Error('unknown symmetry ' + this.symmetry);
    }
  }

  // symmetrised brush: union of the brush over every group image
  sym(f) {
    if (this.symmetry === 'none') return f;
    return (x, y) => {
      const im = this.images(x, y);
      let d = Infinity;
      for (let i = 0; i < im.length; i++) {
        const v = f(im[i][0], im[i][1]);
        if (v < d) d = v;
      }
      return d;
    };
  }

  // integer-cell orbit of a cell in spawn order (opposites first)
  orbit(x, y) {
    let pts;
    if (this.symmetry === 'hex') {
      // 60/120-degree images are rounded; the 180-degree partners are exact
      const { cx, cy, w, h } = this;
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const half = [0, 1, 2].map((k) => {
        const [c, s] = HEX[k];
        return [Math.floor(cx + dx * c - dy * s), Math.floor(cy + dx * s + dy * c)];
      });
      half[0] = [x, y];
      pts = half.concat(half.map(([px, py]) => [w - 1 - px, h - 1 - py]));
    } else {
      pts = G.gridOps(this.symmetry, this.w, this.h).map((op) => op(x, y));
    }
    return ORBIT_ORDER[this.symmetry].map((i) => pts[i]);
  }

  // ---- noise ------------------------------------------------------------------
  // independent fbm field (feature size in cells); each call gets its own salt
  fbm(cells, opts = {}) {
    const seed = subSeed(this.seed, 1000 + this._salt++);
    return makeFbm(seed, { cells, ...opts });
  }

  // fbm averaged over the group (exactly symmetric, same variance)
  symFbm(cells, opts = {}) {
    const f = this.fbm(cells, opts);
    const k = Math.sqrt(this.images(0, 0).length);
    return (x, y) => {
      const im = this.images(x, y);
      let s = 0;
      for (let i = 0; i < im.length; i++) s += f(im[i][0], im[i][1]);
      return s / k;
    };
  }

  // ---- painting ---------------------------------------------------------------
  // set `type` wherever the (symmetrised) brush is negative
  paint(type, f, { sym = true } = {}) {
    const g = sym ? this.sym(f) : f;
    const { w, h, t } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (g(x + 0.5, y + 0.5) < 0) t[y * w + x] = type;
      }
    }
    return this;
  }

  rock(f, o) { return this.paint(G.ROCK, f, o); }
  water(f, o) { return this.paint(G.WATER, f, o); }
  land(f, o) { return this.paint(G.LAND, f, o); }

  fill(type) { this.t.fill(type); return this; }

  // ---- gameplay objects ---------------------------------------------------------
  // one spawn per group image; pad = radius of guaranteed open land
  spawn(x, y, { pad = 10 } = {}) {
    for (const [px, py] of this.orbit(x, y)) {
      this.spawns.push({ x: px, y: py });
      if (pad > 0) this.pads.push([px + 0.5, py + 0.5, pad]);
    }
    return this;
  }

  // oil field + its images (role is informational: start / natural / contested)
  oilField(x, y, role = 'contested', { pad = 5 } = {}) {
    for (const [px, py] of this.orbit(x, y)) {
      if (this.oil.some((o) => o.x === px && o.y === py)) continue;
      this.oil.push({ x: px, y: py, role });
      if (pad > 0) this.pads.push([px + 0.5, py + 0.5, pad]);
    }
    return this;
  }

  // ---- finish -------------------------------------------------------------------
  finish({
    smooth = 2,          // majority-filter iterations
    minRock = 14,        // smaller rock blobs are removed
    minWater = 30,       // smaller ponds are removed
    minIsland = 60,      // smaller unreachable land pockets are filled in
    keepIslands = true,  // larger unreachable land (islands) may stay as scenery
  } = {}) {
    const { w, h, t, symmetry } = this;
    for (const [px, py, r] of this.pads) {
      const r2 = r * r;
      const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(w - 1, Math.ceil(px + r));
      const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(h - 1, Math.ceil(py + r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - px, dy = y + 0.5 - py;
          if (dx * dx + dy * dy <= r2) t[y * w + x] = G.LAND;
        }
      }
    }
    G.symmetrize(t, w, h, symmetry);
    G.majority(t, w, h, smooth);

    const spawnCells = this.spawns.map((s) => s.y * w + s.x);
    for (let round = 0; round < 8; round++) {
      let changed = 0;
      changed += G.declutter(t, w, h) > 0 ? 1 : 0;
      changed += G.removeSmall(t, w, h, G.ROCK, minRock);
      changed += G.removeSmall(t, w, h, G.WATER, minWater);
      // land pockets no spawn can reach: fill small ones, keep big islands
      const { label, sizes } = G.components(t, w, h, (v) => v === G.LAND);
      const reach = new Set(spawnCells.map((c) => label[c]));
      const border = sizes.map(() => [0, 0, 0]);
      const doomed = (id) => id >= 0 && !reach.has(id) && (sizes[id] < minIsland || !keepIslands);
      for (let i = 0; i < w * h; i++) {
        const id = label[i];
        if (!doomed(id)) continue;
        const x = i % w, y = (i / w) | 0;
        if (x > 0 && label[i - 1] !== id) border[id][t[i - 1]]++;
        if (x < w - 1 && label[i + 1] !== id) border[id][t[i + 1]]++;
        if (y > 0 && label[i - w] !== id) border[id][t[i - w]]++;
        if (y < h - 1 && label[i + w] !== id) border[id][t[i + w]]++;
      }
      for (let i = 0; i < w * h; i++) {
        const id = label[i];
        if (!doomed(id)) continue;
        t[i] = border[id][G.WATER] > border[id][G.ROCK] ? G.WATER : G.ROCK;
        changed++;
      }
      if (!changed) break;
    }
    G.symmetrize(t, w, h, symmetry);

    // ---- generator-side sanity (the full audit lives in validate.mjs) ----
    const err = (m) => { throw new Error(`[${this.id}] ${m}`); };
    const bad = G.asymmetry(t, w, h, symmetry);
    if (bad) err(`terrain not ${symmetry}-symmetric (${bad} cells)`);
    const thin = G.thinCells(t, w, h).length, pinch = G.diagonalPinches(t, w, h).length;
    if (thin || pinch) err(`cleanup left ${thin} thin cells / ${pinch} diagonal pinches`);
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : t[y * w + x]);
    const open = (x, y, r) => {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (at(x + dx, y + dy) !== G.LAND) return false;
      return true;
    };
    this.spawns.forEach((s, i) => { if (!open(s.x, s.y, 4)) err(`spawn ${i} (${s.x},${s.y}) lacks a 9x9 open pad`); });
    this.oil.forEach((o, i) => { if (!open(o.x, o.y, 2)) err(`oil ${i} (${o.x},${o.y}) lacks a 5x5 open pad`); });
    const { label } = G.components(t, w, h, (v) => v === G.LAND);
    for (const o of this.oil) {
      if (!this.spawns.some((s) => label[s.y * w + s.x] === label[o.y * w + o.x])) {
        err(`oil (${o.x},${o.y}) is not land-connected to any spawn`);
      }
    }
    return {
      w, h,
      terrain: Array.from(t),
      oil: this.oil.map((o) => ({ x: o.x, y: o.y })),
      spawns: this.spawns.map((s) => ({ x: s.x, y: s.y })),
    };
  }
}
