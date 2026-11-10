// Shared site kit for structures: pads, buildings, tanks, stacks, masts, props.

import { DEG, TAU, mixC, mulC, lerp, hashInt } from './geo.js';
import { lattice } from './parts.js';

export const PADH = 0.07;

export function footprintOf(def) { return def.type === 'SW' ? 4 : def.type === 'Def' ? 2 : 3; }
export function halfOf(def) { return footprintOf(def) * 0.88; }

// ---------------------------------------------------------------- site kit

/** Concrete pad with joints and team corner markings. */
export function pad(g, half, o = {}) {
  const { pal, hi } = g.ctx;
  const h = o.h ?? PADH;
  g.box(0, h / 2, 0, half * 2, h, half * 2, { c: o.c || pal.concrete, b: 0.02, skip: 8, tone: false });
  const y = h + 0.004;
  if (hi) {
    const n = Math.round(half * 2 / 1.3);
    for (let i = 1; i < n; i++) {
      const p = -half + (i * half * 2) / n;
      g.decal(p, y, 0, 0.022, half * 2 - 0.08, { c: pal.concreteDk });
      g.decal(0, y, p, half * 2 - 0.08, 0.022, { c: pal.concreteDk });
    }
  }
  if (o.marks !== false) {
    const m = half - 0.1;
    for (const sx of [1, -1]) for (const sz of [1, -1]) {
      g.decal(sx * (m - 0.2), y + 0.002, sz * m, 0.5, 0.08, { c: pal.team });
      g.decal(sx * m, y + 0.002, sz * (m - 0.2), 0.08, 0.5, { c: pal.team });
    }
  }
}

/**
 * Box building. o: c (wall), roof 'flat'|'gableX'|'gableZ'|'archX'|'archZ'|'saw', roofC, trim, rise, y0
 * Returns roof top y.
 */
export function house(g, x, z, sx, sz, h, o = {}) {
  const { pal } = g.ctx;
  const y0 = o.y0 ?? PADH;
  const wall = o.c || pal.wall;
  g.box(x, y0 + h / 2, z, sx, h, sz, { c: wall, b: 0.022, skip: 8 });
  if (o.plinth !== false) g.box(x, y0 + 0.035, z, sx + 0.05, 0.07, sz + 0.05, { c: pal.concreteDk, b: 0.01, skip: 8 });
  const roof = o.roof || 'flat', rc = o.roofC || pal.roof, top = y0 + h;
  const ov = 0.05;
  if (roof === 'flat') {
    g.box(x, top + 0.03, z, sx + 0.06, 0.06, sz + 0.06, { c: o.trim || pal.wallDk, b: 0.012 });
    g.box(x, top + 0.064, z, sx - 0.1, 0.012, sz - 0.1, { c: rc, b: 0 });
    return top + 0.07;
  }
  const rise = o.rise ?? Math.min(sx, sz) * 0.24;
  if (roof === 'gableX') { // ridge along X
    g.prismX([[z - sz / 2 - ov, top - 0.01], [z + sz / 2 + ov, top - 0.01], [z + sz / 2 + ov, top + 0.03], [z, top + rise], [z - sz / 2 - ov, top + 0.03]], x - sx / 2 - ov, x + sx / 2 + ov, { c: rc, b: 0.012 });
  } else if (roof === 'gableZ') {
    g.prismZ([[x - sx / 2 - ov, top - 0.01], [x + sx / 2 + ov, top - 0.01], [x + sx / 2 + ov, top + 0.03], [x, top + rise], [x - sx / 2 - ov, top + 0.03]], z - sz / 2 - ov, z + sz / 2 + ov, { c: rc, b: 0.012 });
  } else if (roof === 'archX' || roof === 'archZ') {
    const along = roof === 'archX';
    const w = (along ? sz : sx) / 2 + ov, c0 = along ? z : x;
    const n = g.ctx.seg(8), pr = [];
    for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI; pr.push([c0 + Math.cos(a) * w, top - 0.01 + Math.sin(a) * rise]); }
    if (along) g.prismX(pr, x - sx / 2 - ov, x + sx / 2 + ov, { c: rc, b: 0.012, crease: 40 });
    else g.prismZ(pr, z - sz / 2 - ov, z + sz / 2 + ov, { c: rc, b: 0.012, crease: 40 });
  } else if (roof === 'saw') { // sawtooth factory roof, teeth along X
    const n = o.teeth || 3, tw = sx / n;
    for (let i = 0; i < n; i++) {
      const xa = x - sx / 2 + i * tw;
      g.prismZ([[xa, top - 0.01], [xa + tw, top - 0.01], [xa + tw * 0.22, top + rise]], z - sz / 2, z + sz / 2, { c: rc, b: 0.01 });
    }
  }
  return top + rise;
}

/** Recessed door on a wall face. face: '+x' | '-x' | '+z' | '-z'. */
export function door(g, x, z, w, h, face, o = {}) {
  const { pal } = g.ctx;
  const y0 = o.y0 ?? PADH;
  const alongZ = face === '+x' || face === '-x';
  const s = face[0] === '+' ? 1 : -1;
  const t = 0.03;
  const dims = (ww, hh, tt) => (alongZ ? [tt, hh, ww] : [ww, hh, tt]);
  const pos = (off) => (alongZ ? [x + s * off, z] : [x, z + s * off]);
  let p = pos(0.004);
  g.box(p[0], y0 + h / 2, p[1], ...dims(w, h, t), { c: o.c || pal.gun, b: 0, tone: false });
  // frame
  p = pos(0.012);
  g.box(p[0], y0 + h + 0.04, p[1], ...dims(w + 0.14, 0.08, t + 0.02), { c: o.frame || pal.team, b: 0.01, tone: false });
  if (o.slats) {
    const n = o.slats;
    p = pos(0.022);
    for (let i = 1; i < n; i++) g.box(p[0], y0 + (h * i) / n, p[1], ...dims(w, 0.016, 0.012), { c: mulC(o.c || pal.gun, 1.7), b: 0, tone: false });
  }
}

/** Row of windows (glass sink) on a wall face. */
export function windows(glass, x, y, z, len, n, face, o = {}) {
  const alongZ = face === '+x' || face === '-x';
  const s = face[0] === '+' ? 1 : -1;
  const wh = o.h ?? 0.16, ww = (len / n) * (o.fill ?? 0.62);
  const lit = o.lit, em = o.em;
  for (let i = 0; i < n; i++) {
    const k = (i + 0.5) / n - 0.5;
    const isLit = em && lit && hashInt(glass.ctx.seed + Math.round((x + z) * 97) + i * 31) < lit;
    const tgt = isLit ? em : glass;
    const c = isLit ? [1.0, 0.72, 0.36] : glass.ctx.pal.glassD;
    if (alongZ) tgt.box(x + s * 0.004, y, z + k * len, 0.012, wh, ww, { c, b: 0 });
    else tgt.box(x + k * len, y, z + s * 0.004, ww, wh, 0.012, { c, b: 0 });
  }
}

export function chimney(M, g, x, z, r, h, o = {}) {
  const { pal } = g.ctx;
  const y0 = o.y0 ?? PADH;
  const pts = [], cols = [];
  const bands = o.bands ?? 3;
  const body = o.c || pal.concreteLt;
  const add = (t, rr, c) => { pts.push([y0 + t * h, rr]); cols.push(c); };
  add(0, r * 1.25, body); add(0.06, r * 1.2, body); add(0.07, r * 1.08, body);
  const b0 = 1 - bands * 0.09;
  add(b0, r * 0.86, body);
  for (let i = 0; i < bands; i++) {
    const c = i % 2 ? pal.white : pal.red;
    const t0 = b0 + (i * (1 - b0)) / bands, t1 = b0 + ((i + 1) * (1 - b0)) / bands;
    add(t0, lerp(r * 0.86, r * 0.8, i / bands), c); add(t1, lerp(r * 0.86, r * 0.8, (i + 1) / bands), c);
  }
  add(1, r * 0.66, pal.black); add(0.96, r * 0.62, pal.black);
  g.lathe('y', pts, { at: [x, 0, z], seg: g.ctx.seg(10), colors: cols, crease: 30, cap0: false, cap1: true, tone: false });
  M.stack(x, y0 + h, z);
  if (o.light !== false) M.light(x, y0 + h + 0.04, z);
}

export function coolingTower(M, g, x, z, r, h, o = {}) {
  const { pal } = g.ctx;
  const y0 = o.y0 ?? PADH;
  const c = pal.concreteLt, tc = pal.team;
  const prof = [[0, 1.0], [0.12, 0.93], [0.3, 0.8], [0.5, 0.7], [0.68, 0.665], [0.8, 0.68]];
  const pts = prof.map(([t, k]) => [y0 + t * h, r * k]);
  const cols = prof.map(() => c);
  pts.push([y0 + 0.8 * h, r * 0.685], [y0 + 0.9 * h, r * 0.71], [y0 + 0.9 * h, r * 0.705], [y0 + h, r * 0.75], [y0 + h, r * 0.7], [y0 + h * 0.9, r * 0.62]);
  cols.push(tc, tc, c, c, pal.concreteDk, pal.black);
  g.lathe('y', pts, { at: [x, 0, z], seg: g.ctx.seg(14), colors: cols, crease: 50, cap0: false, cap1: true, tone: false });
  // legs / air inlet band
  g.cylY(x, y0, y0 + 0.1, z, r * 1.03, { seg: g.ctx.seg(14), c: pal.concreteDk, cap0: false });
  M.stack(x, y0 + h * 0.96, z);
}

/** Vertical storage tank with domed roof and a team band. */
export function tankV(g, x, z, r, h, o = {}) {
  const { pal, hi } = g.ctx;
  const y0 = o.y0 ?? PADH;
  const c = o.c || mixC(pal.white, pal.concrete, 0.35), band = o.band ?? pal.team;
  const pts = [[y0, r], [y0 + h * 0.56, r], [y0 + h * 0.56, r * 1.012], [y0 + h * 0.8, r * 1.012], [y0 + h * 0.8, r], [y0 + h, r], [y0 + h, r * 1.03], [y0 + h + 0.03, r * 1.03], [y0 + h + 0.03, r * 0.96], [y0 + h + r * 0.14, r * 0.5], [y0 + h + r * 0.2, 0]];
  const cols = [c, c, band, band, c, c, pal.steel, pal.steel, c, c, c];
  g.lathe('y', pts, { at: [x, 0, z], seg: g.ctx.seg(o.seg || 14), colors: cols, crease: 40, cap0: false, tone: false });
  if (hi && o.stairs !== false) {
    // spiral stair as a ramp of short beams
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * 1.9 + (o.stairA || 0), a1 = ((i + 1) / n) * 1.9 + (o.stairA || 0);
      g.beam([x + Math.cos(a0) * (r + 0.04), y0 + (h * i) / n, z + Math.sin(a0) * (r + 0.04)], [x + Math.cos(a1) * (r + 0.04), y0 + (h * (i + 1)) / n, z + Math.sin(a1) * (r + 0.04)], 0.03, { c: pal.steel, w2: 0.08 });
    }
  }
  return y0 + h + r * 0.2;
}

export function mast(M, g, x, z, h, o = {}) {
  const { pal } = g.ctx;
  const y0 = o.y0 ?? PADH;
  lattice(g, x, y0, y0 + h, z, o.w ?? 0.22, { w1: o.w1 ?? 0.08, c: o.c || pal.steel, n: o.n });
  g.cylY(x, y0 + h, y0 + h + 0.3, z, 0.012, { seg: 4, c: pal.red });
  M.light(x, y0 + h + 0.32, z);
}

export function radome(g, x, y, z, r, o = {}) {
  const { pal } = g.ctx;
  g.sphere(x, y, z, r, { seg: g.ctx.seg(12), y0: -0.25, c: o.c || pal.white, tone: false });
  g.cylY(x, y - r * 0.5, y - r * 0.22, z, r * 0.78, { seg: g.ctx.seg(12), c: pal.steel });
}

export function container(g, x, y, z, len, c, ry = 0) {
  const { pal, hi } = g.ctx;
  g.at(x, y, z, () => {
    g.box(0, 0.17, 0, len, 0.34, 0.32, { c, b: 0.012, toneAmt: 0.08 });
    if (hi) for (let i = 1; i < 4; i++) g.box(-len / 2 + (len * i) / 4, 0.17, 0, 0.02, 0.3, 0.33, { c: mulC(c, 0.8), b: 0 });
    g.box(len / 2 + 0.002, 0.17, 0, 0.006, 0.28, 0.26, { c: mulC(c, 0.7), b: 0 });
    void pal;
  }, ry);
}

export function floodlight(M, g, em, x, z, h, ry = 0) {
  const { pal } = g.ctx;
  g.cylY(x, PADH, PADH + h, z, 0.022, { seg: 5, c: pal.steel });
  g.at(x, PADH + h, z, () => {
    g.box(0.03, 0.03, 0, 0.06, 0.08, 0.22, { c: pal.gun, b: 0 });
    if (em) em.box(0.064, 0.03, 0, 0.006, 0.06, 0.18, { c: [1.0, 0.93, 0.7], b: 0 });
  }, ry, -0.35);
  M.light(x, PADH + h + 0.05, z);
}

export function pipeRun(g, pts, r, c) {
  const { pal } = g.ctx;
  for (let i = 0; i < pts.length - 1; i++) g.pipe(pts[i], pts[i + 1], r, { seg: 6, c: c || pal.steelLt, cap0: false, cap1: false });
  for (let i = 1; i < pts.length - 1; i++) g.sphere(pts[i][0], pts[i][1], pts[i][2], r * 1.25, { seg: 6, c: c || pal.steelLt });
}

export function wallRun(g, p0, p1, h, o = {}) {
  const { pal } = g.ctx;
  const dx = p1[0] - p0[0], dz = p1[1] - p0[1], len = Math.hypot(dx, dz);
  const ry = Math.atan2(-dz, dx);
  g.at((p0[0] + p1[0]) / 2, PADH, (p0[1] + p1[1]) / 2, () => {
    g.box(0, h / 2, 0, len, h, o.t ?? 0.1, { c: o.c || pal.concrete, b: 0.014, skip: 8 });
    if (o.stripe !== false) g.box(0, h - 0.05, 0, len * 0.96, 0.05, (o.t ?? 0.1) + 0.012, { c: pal.team, b: 0, tone: false });
  }, ry);
}

export function crates(g, x, z, n, o = {}) {
  const { pal } = g.ctx;
  for (let i = 0; i < n; i++) {
    const h = hashInt(g.ctx.seed + i * 71 + Math.round(x * 13 + z * 7));
    const s = 0.2 + h * 0.1;
    g.box(x + (i % 2) * 0.3 - 0.1, PADH + s / 2 + (i > 3 ? 0.26 : 0), z + Math.floor((i % 4) / 2) * 0.3, s * 1.2, s, s, { c: i % 3 ? mulC(pal.wood, 1.1) : pal.missileG, b: 0.012, rot: [h * 0.5, 0, 0], toneAmt: 0.1 });
  }
}

