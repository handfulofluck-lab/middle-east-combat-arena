// Naval units: fast attack craft, corvettes, frigates, an aircraft carrier and submarines.
// Waterline is y = 0; hulls extend a little below it so they sit IN the water plane.

import { DEG, TAU, mixC, mulC, lerp } from './geo.js';
import { gunBarrel, thinBarrel, lattice, radarPanel, dish, flagPole, missile } from './parts.js';
import { fuselage, wing, fin } from './air.js';

/**
 * Displacement hull. st: [{ x, b (deck half-beam), w (waterline half-beam), d (deck height), k (keel depth), xd (deck x shift) }]
 * from stern to bow.
 */
function shipHull(g, st, o = {}) {
  const { pal } = g.ctx;
  const rings = st.map((s) => {
    const xd = s.x + (s.xd || 0), k = -(s.k ?? 0.14);
    return [
      [s.x - (s.xd || 0) * 0.6, k, 0], [s.x - (s.xd || 0) * 0.3, k * 0.45, s.w * 0.78], [s.x, 0.0, s.w], [xd, s.d, s.b],
      [xd, s.d, -s.b], [s.x, 0.0, -s.w], [s.x - (s.xd || 0) * 0.3, k * 0.45, -s.w * 0.78],
    ];
  });
  const side = o.c || pal.base;
  g.loft(rings, { crease: 40, camo: 0, c: (x, y) => (y < -0.004 ? pal.hullRed : y < 0.012 ? pal.black : side), tess: g.ctx.hi ? 0.5 : 0 });
  // deck plating
  const out = [];
  for (const s of st) out.push([s.x + (s.xd || 0), s.b - 0.022]);
  for (let i = st.length - 1; i >= 0; i--) out.push([st[i].x + (st[i].xd || 0), -(st[i].b - 0.022)]);
  const d = st[0].d;
  if (o.deck !== false) g.prismY(out.filter((p, i, a) => i === 0 || Math.abs(p[0] - a[i - 1][0]) + Math.abs(p[1] - a[i - 1][1]) > 1e-4), d - 0.01, d + 0.006, { c: o.deckC || pal.deck, b: 0, camo: 0, cap0: false });
}

function deckGun(M, x, y, o = {}) {
  const { pal } = M.ctx;
  const s = o.s || 1;
  const T = M.part('turret', { at: [x, y, 0] });
  M.turretNode = 'turret';
  T.cylY(x, y, y + 0.03, 0, 0.12 * s, { seg: M.ctx.seg(10), c: pal.navyDk, camo: 0 });
  if (o.stealth) {
    T.xloft([{ x: x - 0.14 * s, y0: y + 0.03, y1: y + 0.2 * s, w0: 0.12 * s, w1: 0.06 * s }, { x: x + 0.04 * s, y0: y + 0.03, y1: y + 0.2 * s, w0: 0.12 * s, w1: 0.06 * s }, { x: x + 0.16 * s, y0: y + 0.03, y1: y + 0.12 * s, w0: 0.08 * s, w1: 0.04 * s }], { c: pal.base, camo: 0, ch: 0.012 });
  } else {
    T.sphere(x, y + 0.03, 0, 0.13 * s, { seg: M.ctx.seg(10), y0: 0, c: pal.base, camo: 0, s: [1.1, 1.15, 1] });
  }
  const bx = x + 0.1 * s, by = y + 0.11 * s;
  const B = M.part('barrel', { at: [bx, by, 0], parent: 'turret' });
  M.barrelNode = 'barrel';
  const len = 0.36 * s;
  B.at(bx, by, 0, () => gunBarrel(B, 0, { len, r: 0.016 * s, evac: 0, sleeve: false, c: pal.navyDk }), 0, 0.12);
  M.muzzle(bx + Math.cos(0.12) * len, by + Math.sin(0.12) * len, 0, 'barrel');
}

function ciws(g, x, y, z) {
  const { pal } = g.ctx;
  g.cylY(x, y, y + 0.05, z, 0.05, { seg: 8, c: pal.navyDk, camo: 0 });
  g.sphere(x, y + 0.13, z, 0.045, { seg: 8, c: pal.white, camo: 0, s: [1, 1.6, 1] });
  thinBarrel(g, x + 0.03, 0.12, y + 0.08, z, 0.008, { seg: 5 });
}

function canisters(M, g, x, y, z, n, ang, s) {
  const { pal } = g.ctx;
  // angled anti-ship missile tubes firing outboard-forward
  g.at(x, y, z, () => {
    g.box(0, 0.03, 0, 0.3, 0.06, 0.07 * n + 0.04, { c: pal.navyDk, camo: 0, b: 0.01 });
    for (let i = 0; i < n; i++) {
      const zz = (i - (n - 1) / 2) * 0.075;
      g.at(-0.04, 0.09, zz, () => {
        g.lathe('x', [[-0.18, 0.03], [-0.17, 0.034], [0.26, 0.034], [0.26, 0.027], [0.25, 0.027], [0.25, 0]], { seg: g.ctx.seg(7), colors: [pal.base, pal.base, pal.base, pal.warhead, pal.warhead, pal.warhead], camo: 0, crease: 40 });
      }, 0, ang);
    }
  }, -s * 0.5);
  const ry = -s * 0.5;
  M.muzzle(x + Math.cos(ry) * 0.22 * Math.cos(ang), y + 0.09 + Math.sin(ang) * 0.26, z - Math.sin(ry) * 0.22);
}

function vls(g, x, y, z, nx, nz, cell = 0.07) {
  const { pal, hi } = g.ctx;
  g.box(x, y + 0.012, z, nx * cell + 0.04, 0.024, nz * cell + 0.04, { c: pal.navyDk, camo: 0, b: 0.006 });
  if (!hi) return;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) g.decal(x + (i - (nx - 1) / 2) * cell, y + 0.026, z + (j - (nz - 1) / 2) * cell, cell * 0.76, cell * 0.76, { c: (i + j) % 2 ? pal.base : mulC(pal.base, 0.9) });
}

function heloDeck(g, x, y, r) {
  const { pal } = g.ctx;
  g.disc(x, y + 0.008, 0, r, { r0: r * 0.86, c: pal.team });
  g.decal(x, y + 0.009, 0, r * 0.14, r * 0.9, { c: pal.white });
  g.decal(x - r * 0.3, y + 0.009, 0, r * 0.14, r * 0.9, { c: pal.white });
  g.decal(x - r * 0.15, y + 0.009, 0, r * 0.3, r * 0.14, { c: pal.white });
}

function bridgeGlass(glass, x, y, hw, len) {
  // wrap-around bridge windows: front + sides
  glass.box(x + len / 2 + 0.003, y, 0, 0.006, 0.05, hw * 1.7, { c: glass.ctx.pal.glassD, b: 0 });
  for (const s of [1, -1]) glass.box(x + len * 0.15, y, s * (hw + 0.003), len * 0.6, 0.05, 0.006, { c: glass.ctx.pal.glassD, b: 0 });
}

function shipSpec(def) {
  const n = def.name || '', r = def.role || '';
  if (/carrier|Vikrant/i.test(n + r)) return { type: 'carrier' };
  if (/sub|Kilo|Kalvari|Hangor|Ghadir|Type-209/i.test(n + ' ' + r)) {
    const mini = /Ghadir|mini/i.test(n);
    return { type: 'sub', L: mini ? 2.3 : /Kilo|Hangor/i.test(n) ? 3.6 : 3.4, fat: /Kilo/i.test(n) ? 1.15 : mini ? 0.8 : 1, sailPlanes: /Kalvari|Hangor/i.test(n), xtail: /Hangor|Type-209/i.test(n) };
  }
  if (/FAC|Missile boat/i.test(n + ' ' + r)) return { type: 'fac', L: 3.2, B: 0.6 };
  if (/frigate|FREMM|destroyer/i.test(n + ' ' + r)) return { type: 'frigate', L: 4.4, B: 0.84, stealth: true, vls: [4, 4] };
  if (/Sa'ar/i.test(n)) return { type: 'frigate', L: 4.0, B: 0.8, stealth: true, vls: [3, 4], saar: true };
  if (/M[İI]LGEM/i.test(n)) return { type: 'corvette', L: 3.9, B: 0.76, stealth: true };
  return { type: 'corvette', L: 3.8, B: 0.74, stealth: false };
}

export function buildShip(M, def) {
  const S = shipSpec(def);
  if (S.type === 'sub') return buildSub(M, def, S);
  if (S.type === 'carrier') return buildCarrier(M, def);
  const { pal, hi } = M.ctx;
  const g = M.part('hull');
  const glass = M.part('hull', { mat: 'glass' });
  const L = S.L, hl = L / 2, hb = S.B / 2;
  const fac = S.type === 'fac', frig = S.type === 'frigate';
  const D = fac ? 0.2 : 0.26; // main deck
  shipHull(g, [
    { x: -hl, b: hb * 0.82, w: hb * 0.74, d: D, k: 0.1 },
    { x: -hl * 0.5, b: hb, w: hb * 0.9, d: D, k: 0.15 },
    { x: hl * 0.2, b: hb, w: hb * 0.86, d: D, k: 0.15 },
    { x: hl * 0.62, b: hb * 0.72, w: hb * 0.5, d: D + 0.02, k: 0.13, xd: 0.03 },
    { x: hl * 0.88, b: hb * 0.34, w: hb * 0.14, d: D + 0.05, k: 0.1, xd: 0.07 },
    { x: hl * 0.96, b: 0.02, w: 0.012, d: D + 0.07, k: 0.06, xd: 0.1 },
  ]);
  M.exhaust(-hl - 0.02, 0.0, 0);
  // hull number / team stripe on the bow flanks + stern
  for (const s of [1, -1]) g.box(hl * 0.5, D * 0.62, s * (hb * 0.8 + 0.004), 0.3, 0.07, 0.012, { c: pal.team, b: 0, tone: false, rot: [s * -0.2, 0, s * 0.12] });
  g.box(-hl - 0.003, D * 0.6, 0, 0.01, 0.07, hb, { c: pal.team, b: 0, tone: false });
  // ---- main gun on the forecastle
  deckGun(M, hl * 0.58, D + 0.026, { s: fac ? 0.9 : 1.05, stealth: S.stealth });
  if (S.vls) vls(g, hl * 0.36, D + 0.006, 0, S.vls[0], S.vls[1]);
  // ---- superstructure
  const sx1 = fac ? hl * 0.34 : hl * 0.2, sx0 = fac ? -hl * 0.12 : -hl * 0.34;
  const sw = hb * (S.stealth ? 0.92 : 0.8), sh = fac ? 0.2 : 0.26;
  const tum = S.stealth ? 0.74 : 0.92; // tumblehome
  g.xloft([
    { x: sx0, y0: D, y1: D + sh, w0: sw, w1: sw * tum },
    { x: sx1 - 0.08, y0: D, y1: D + sh, w0: sw, w1: sw * tum },
    { x: sx1, y0: D, y1: D + sh * 0.9, w0: sw * 0.8, w1: sw * tum * 0.76 },
  ], { c: pal.base, camo: 0, ch: 0.014 });
  // bridge
  const bh = fac ? 0.14 : 0.16, bx = sx1 - 0.34, bw = sw * tum * 0.86;
  g.xloft([
    { x: bx - 0.2, y0: D + sh, y1: D + sh + bh, w0: bw, w1: bw * 0.9 },
    { x: bx + 0.14, y0: D + sh, y1: D + sh + bh, w0: bw, w1: bw * 0.9 },
    { x: bx + 0.2, y0: D + sh, y1: D + sh + bh * 0.86, w0: bw * 0.86, w1: bw * 0.76 },
  ], { c: pal.base, camo: 0, ch: 0.012 });
  bridgeGlass(glass, bx, D + sh + bh * 0.62, bw * 0.9, 0.36);
  g.box(bx - 0.03, D + sh + bh + 0.004, 0, 0.26, 0.012, bw * 1.5, { c: pal.team, b: 0.003, tone: false });
  // ---- mast + radar
  const mx = bx - 0.1, my = D + sh + bh;
  const R = M.part('radar', { at: [mx, my + (fac ? 0.62 : 0.74), 0] });
  if (S.saar) {
    // tall integrated mast with four fixed AESA faces
    g.xloft([{ x: mx - 0.13, y0: my, y1: my + 0.62, w0: 0.14, w1: 0.07 }, { x: mx + 0.13, y0: my, y1: my + 0.62, w0: 0.14, w1: 0.07 }], { c: pal.base, camo: 0, ch: 0.01 });
    for (let i = 0; i < 4; i++) radarPanel(g, mx + Math.cos(i * TAU / 4 + TAU / 8) * 0.105, my + 0.4, Math.sin(i * TAU / 4 + TAU / 8) * -0.105, 0.14, 0.16, { ry: i * TAU / 4 + TAU / 8, tilt: 0.14, frame: pal.navyDk, c: pal.white });
    R.cylY(mx, my + 0.62, my + 0.74, 0, 0.02, { seg: 6, c: pal.navyDk });
    R.box(mx, my + 0.76, 0, 0.05, 0.05, 0.26, { c: pal.navyDk, b: 0.008 });
  } else if (S.stealth) {
    g.xloft([{ x: mx - 0.11, y0: my, y1: my + 0.5, w0: 0.12, w1: 0.05 }, { x: mx + 0.11, y0: my, y1: my + 0.5, w0: 0.12, w1: 0.05 }], { c: pal.base, camo: 0, ch: 0.01 });
    g.sphere(mx, my + 0.56, 0, 0.07, { seg: 8, c: pal.white, s: [1, 1.1, 1] });
    R.cylY(mx, my + 0.6, my + 0.74, 0, 0.018, { seg: 6, c: pal.navyDk });
    R.box(mx, my + 0.76, 0, 0.05, 0.07, 0.34, { c: pal.navyDk, b: 0.008 });
    R.box(mx + 0.028, my + 0.76, 0, 0.01, 0.05, 0.3, { c: pal.steelLt, b: 0 });
  } else {
    lattice(g, mx, my, my + (fac ? 0.5 : 0.6), 0, 0.16, { w1: 0.06, c: pal.navyDk });
    R.cylY(mx, my + (fac ? 0.5 : 0.6), my + (fac ? 0.62 : 0.74), 0, 0.016, { seg: 6, c: pal.navyDk });
    R.box(mx, my + (fac ? 0.63 : 0.76), 0, 0.045, 0.05, 0.3, { c: pal.navyDk, b: 0.008 });
    g.box(mx, my + (fac ? 0.3 : 0.36), 0, 0.02, 0.014, 0.4, { c: pal.navyDk, b: 0 }); // yardarm
  }
  M.spin('radar', 'y', 1.6);
  // fire-control director above the bridge
  g.cylY(bx + 0.08, my, my + 0.07, 0, 0.022, { seg: 6, c: pal.navyDk });
  dish(g, bx + 0.1, my + 0.12, 0, 0.065, { c: pal.white });
  // ---- funnel
  const fx = sx0 + (fac ? 0.2 : 0.3);
  g.xloft([
    { x: fx - 0.18, y0: D + sh, y1: D + sh + 0.24, w0: sw * tum * 0.5, w1: sw * tum * 0.36 },
    { x: fx + 0.12, y0: D + sh, y1: D + sh + 0.26, w0: sw * tum * 0.5, w1: sw * tum * 0.36 },
  ], { c: pal.base, camo: 0, ch: 0.012 });
  g.box(fx - 0.03, D + sh + 0.265, 0, 0.26, 0.03, sw * tum * 0.66, { c: pal.black, b: 0.006, tone: false });
  g.box(fx - 0.03, D + sh + 0.16, 0, 0.31, 0.05, sw * tum * 0.94, { c: pal.team, b: 0.004, tone: false });
  M.exhaust(fx - 0.03, D + sh + 0.3, 0);
  // ---- weapons amidships / aft
  const ax = sx0 - 0.24;
  if (fac) {
    for (const s of [1, -1]) { canisters(M, g, ax, D + 0.01, s * hb * 0.36, 2, 0.3, s); canisters(M, g, ax - 0.46, D + 0.01, s * hb * 0.34, 2, 0.3, s); }
    ciws(g, -hl + 0.24, D + 0.01, 0);
  } else {
    for (const s of [1, -1]) canisters(M, g, sx0 + 0.02 - 0.2, D + sh + 0.0 - sh, s * hb * 0.5, frig ? 4 : 2, 0.32, s);
    // hangar + helo deck
    const hx1 = ax - 0.26, hx0 = -hl * 0.52;
    g.xloft([{ x: hx0, y0: D, y1: D + sh * 0.92, w0: sw * 0.94, w1: sw * tum }, { x: hx1, y0: D, y1: D + sh * 0.92, w0: sw * 0.94, w1: sw * tum }], { c: pal.base, camo: 0, ch: 0.014 });
    g.box(hx0 - 0.003, D + sh * 0.42, 0, 0.01, sh * 0.7, sw * 1.1, { c: pal.navyDk, b: 0 }); // hangar door
    ciws(g, (hx0 + hx1) / 2, D + sh * 0.92, 0);
    heloDeck(g, (-hl + hx0) / 2 - 0.02, D, hb * 0.62);
    if (hi) for (const s of [1, -1]) { g.box(-hl * 0.2, D + 0.05, s * hb * 0.86, 0.26, 0.06, 0.09, { c: pal.orange, b: 0.02 }); } // RHIBs
  }
  // railings as thin strips, anchor, flag
  flagPole(g, -hl + 0.05, D, 0, 0.3);
  if (hi) for (const s of [1, -1]) g.box(-hl * 0.4, D + 0.035, s * (hb - 0.012), L * 0.3, 0.006, 0.006, { c: pal.navyDk, b: 0 });
  return { kind: 'ship', radius: hl * 0.86, height: D + sh + bh + 0.5 };
}

function buildCarrier(M, def) {
  const { pal, hi } = M.ctx;
  const g = M.part('hull');
  const glass = M.part('hull', { mat: 'glass' });
  const L = 5.0, hl = L / 2, hb = 0.5;
  const D = 0.42;
  shipHull(g, [
    { x: -hl, b: hb * 0.8, w: hb * 0.7, d: D, k: 0.14 },
    { x: -hl * 0.5, b: hb, w: hb * 0.9, d: D, k: 0.2 },
    { x: hl * 0.3, b: hb, w: hb * 0.86, d: D, k: 0.2 },
    { x: hl * 0.7, b: hb * 0.7, w: hb * 0.46, d: D, k: 0.17, xd: 0.04 },
    { x: hl * 0.94, b: 0.04, w: 0.02, d: D, k: 0.08, xd: 0.1 },
  ], { deck: false });
  M.exhaust(-hl - 0.02, 0, 0);
  // flight deck: wide slab with angled-deck overhang to port (-z) and a ski-jump bow
  const fd = D + 0.02, ft = 0.05;
  const deck = [[-hl - 0.04, 0.58], [hl * 0.5, 0.58], [hl * 0.74, 0.42], [hl + 0.04, 0.34], [hl + 0.04, -0.34], [hl * 0.66, -0.44], [hl * 0.3, -0.72], [-hl * 0.5, -0.72], [-hl * 0.72, -0.58], [-hl - 0.04, -0.52]];
  g.prismY(deck, fd, fd + ft, { c: pal.deck, camo: 0, b: 0.012 });
  for (const s of [1, -1]) g.box(0, fd - 0.05, s * 0.5, L * 0.84, 0.1, 0.1, { c: pal.navyDk, b: 0, rot: [0, 0, s * 0.5] }); // sponson fairings
  const dy = fd + ft;
  // ski jump
  g.prismZ([[hl * 0.6, dy - 0.01], [hl + 0.04, dy - 0.01], [hl + 0.04, dy + 0.15], [hl * 0.86, dy + 0.07]], -0.33, 0.33, { c: pal.deck, camo: 0, b: 0.01 });
  // deck markings
  const mk = (x, z, sx, sz, c, ry) => g.decal(x, dy + 0.006, z, sx, sz, { c, ry });
  for (let i = 0; i < 9; i++) mk(-hl + 0.3 + i * 0.36, 0.0, 0.2, 0.025, pal.white);
  mk(-0.2, 0.3, L * 0.8, 0.02, pal.yellow); mk(-0.2, -0.3, L * 0.8, 0.02, pal.yellow);
  for (let i = 0; i < 7; i++) mk(-hl + 0.5 + i * 0.4, -0.5 + i * 0.045, 0.22, 0.025, pal.white, 0.11); // angled deck centreline
  mk(-hl + 0.12, 0, 0.1, 0.9, pal.team); mk(hl * 0.46, 0, 0.08, 0.6, pal.team);
  g.prismZ([[hl * 0.62, dy + 0.004], [hl + 0.03, dy + 0.004], [hl + 0.03, dy + 0.156], [hl * 0.86, dy + 0.076]], -0.05, 0.05, { c: pal.team, camo: 0, b: 0, tone: false });
  // lifts
  mk(hl * 0.1, 0.66, 0.5, 0.2, mulC(pal.deck, 1.5)); mk(-hl * 0.5, 0.66, 0.5, 0.2, mulC(pal.deck, 1.5));
  // ---- island (starboard, +z)
  const ix = 0.2, iz = 0.42;
  g.xloft([{ x: ix - 0.5, y0: dy, y1: dy + 0.3, w0: 0.13, w1: 0.11, z: iz }, { x: ix + 0.4, y0: dy, y1: dy + 0.3, w0: 0.13, w1: 0.11, z: iz }, { x: ix + 0.48, y0: dy, y1: dy + 0.26, w0: 0.1, w1: 0.08, z: iz }], { c: pal.base, camo: 0, ch: 0.012 });
  g.xloft([{ x: ix - 0.1, y0: dy + 0.3, y1: dy + 0.46, w0: 0.12, w1: 0.11, z: iz }, { x: ix + 0.36, y0: dy + 0.3, y1: dy + 0.46, w0: 0.12, w1: 0.11, z: iz }], { c: pal.base, camo: 0, ch: 0.01 });
  glass.box(ix + 0.363, dy + 0.4, iz, 0.006, 0.05, 0.2, { c: pal.glassD, b: 0 });
  for (const s of [1, -1]) glass.box(ix + 0.14, dy + 0.4, iz + s * 0.118, 0.4, 0.05, 0.006, { c: pal.glassD, b: 0 });
  g.box(ix + 0.12, dy + 0.466, iz, 0.36, 0.012, 0.18, { c: pal.team, b: 0.003, tone: false });
  // funnel + masts
  g.xloft([{ x: ix - 0.44, y0: dy + 0.3, y1: dy + 0.52, w0: 0.1, w1: 0.07, z: iz }, { x: ix - 0.2, y0: dy + 0.3, y1: dy + 0.54, w0: 0.1, w1: 0.07, z: iz }], { c: pal.base, camo: 0, ch: 0.01 });
  g.box(ix - 0.32, dy + 0.545, iz, 0.2, 0.03, 0.13, { c: pal.black, b: 0.006, tone: false });
  g.box(ix - 0.32, dy + 0.44, iz, 0.25, 0.05, 0.19, { c: pal.team, b: 0.004, tone: false });
  M.exhaust(ix - 0.32, dy + 0.58, iz);
  lattice(g, ix + 0.1, dy + 0.46, dy + 0.86, iz, 0.12, { w1: 0.05, c: pal.navyDk });
  g.sphere(ix + 0.3, dy + 0.52, iz, 0.06, { seg: 8, c: pal.white });
  const R = M.part('radar', { at: [ix + 0.1, dy + 0.9, iz] });
  R.cylY(ix + 0.1, dy + 0.86, dy + 0.94, iz, 0.016, { seg: 6, c: pal.navyDk });
  R.box(ix + 0.1, dy + 0.96, iz, 0.05, 0.08, 0.36, { c: pal.navyDk, b: 0.008 });
  M.spin('radar', 'y', 1.4);
  // ---- parked air wing (tiny deltas)
  const jet = (x, z, ry) => g.at(x, dy + 0.035, z, () => {
    const c = mulC(pal.steelLt, 0.95);
    fuselage(g, [{ x: 0.2, y: 0.02, w: 0.003, h: 0.003 }, { x: 0.1, y: 0.025, w: 0.022, h: 0.022 }, { x: -0.12, y: 0.025, w: 0.028, h: 0.025 }, { x: -0.18, y: 0.025, w: 0.018, h: 0.018 }], { c, seg: 6, cap0: false });
    g.prismY([[0.06, 0], [-0.12, 0.13], [-0.16, 0.13], [-0.14, 0], [-0.16, -0.13], [-0.12, -0.13]], 0.016, 0.026, { c, b: 0 });
    g.prismZ([[-0.08, 0.04], [-0.15, 0.11], [-0.18, 0.11], [-0.16, 0.04]], -0.004, 0.004, { c: pal.team, b: 0, tone: false });
    g.box(0.06, 0.045, 0, 0.06, 0.016, 0.02, { c: pal.glassD, b: 0, tone: false });
  }, ry);
  const park = hi ? [[-1.5, 0.42, 0.5], [-1.15, 0.44, 0.5], [-0.8, 0.44, 0.5], [0.9, 0.36, 0.3], [-1.9, -0.5, -0.4], [0.3, -0.52, -0.5]] : [[-1.3, 0.42, 0.5], [0.9, 0.36, 0.3]];
  for (const p of park) jet(p[0], p[1], p[2]);
  jet(1.2, 0, 0); // one on the launch run
  // CIWS sponsons + flag
  for (const [x, z] of [[hl * 0.6, -0.4], [-hl * 0.86, 0.5], [-hl * 0.9, -0.46]]) { g.cylY(x, dy, dy + 0.04, z, 0.04, { seg: 6, c: pal.navyDk }); g.sphere(x, dy + 0.1, z, 0.035, { seg: 6, c: pal.white, s: [1, 1.6, 1] }); }
  flagPole(g, -hl + 0.02, dy, 0.5, 0.3);
  M.muzzle(hl + 0.04, dy + 0.18, 0);
  M.muzzle(hl * 0.6, dy + 0.1, -0.4);
  return { kind: 'ship', radius: hl * 0.84, height: dy + 0.9 };
}

function buildSub(M, def, S) {
  const { pal, hi } = M.ctx;
  const g = M.part('hull');
  const L = S.L, hl = L / 2, f = S.fat;
  const r = 0.19 * f, cy = -0.035;
  const hullC = mixC(pal.black, pal.navyDk, 0.22), casing = mixC(pal.black, pal.navyDk, 0.36);
  // pressure hull: blunt bow, long parallel body, tapered stern
  fuselage(g, [
    { x: hl, y: cy, w: 0.01, h: 0.01 }, { x: hl - 0.07, y: cy, w: r * 0.6, h: r * 0.6 }, { x: hl - 0.24, y: cy, w: r * 0.92, h: r * 0.92 }, { x: hl - 0.5, y: cy, w: r, h: r },
    { x: -hl * 0.3, y: cy, w: r, h: r }, { x: -hl * 0.72, y: cy, w: r * 0.6, h: r * 0.6 }, { x: -hl, y: cy, w: r * 0.1, h: r * 0.1 },
  ], { c: (x, y) => (y < -0.01 ? mulC(hullC, 0.8) : hullC), seg: M.ctx.seg(12), cap0: false, tess: hi ? 0.4 : 0 });
  // flat casing along the top
  const ct = cy + r + 0.012;
  g.prismY([[hl - 0.3, 0.06 * f], [hl - 0.12, 0.0], [hl - 0.3, -0.06 * f], [-hl * 0.5, -0.07 * f], [-hl * 0.74, 0], [-hl * 0.5, 0.07 * f]], ct - 0.05, ct, { c: casing, b: 0.01 });
  g.box(hl * 0.1, ct + 0.003, 0, L * 0.3, 0.006, 0.05 * f, { c: pal.team, b: 0, tone: false });
  // sail
  const sx = hl * 0.22, sh = S.L < 3 ? 0.2 : 0.3, sl = S.L < 3 ? 0.36 : 0.56;
  g.prismY([[sx + sl / 2, 0], [sx + sl * 0.2, 0.065 * f], [sx - sl * 0.4, 0.05 * f], [sx - sl / 2, 0], [sx - sl * 0.4, -0.05 * f], [sx + sl * 0.2, -0.065 * f]], ct - 0.01, ct + sh, { c: casing, b: 0.012, s1: [0.94, 0.86] });
  // team band around the sail top
  g.prismY([[sx + sl / 2, 0], [sx + sl * 0.2, 0.065 * f], [sx - sl * 0.4, 0.05 * f], [sx - sl / 2, 0], [sx - sl * 0.4, -0.05 * f], [sx + sl * 0.2, -0.065 * f]], ct + sh * 0.62, ct + sh * 0.8, { c: pal.team, b: 0, s0: [0.975, 0.93], s1: [0.965, 0.9], tone: false, cap0: false, cap1: false });
  // masts: periscope, snorkel, radar
  g.cylY(sx + 0.06, ct + sh, ct + sh + 0.2, 0.01, 0.008, { seg: 5, c: pal.gun });
  g.cylY(sx - 0.04, ct + sh, ct + sh + 0.14, -0.012, 0.014, { seg: 5, c: pal.gun });
  g.box(sx - 0.12, ct + sh + 0.04, 0, 0.03, 0.08, 0.02, { c: pal.gun, b: 0 });
  if (S.sailPlanes) g.mirror(() => wing(g, { x: sx + 0.08, y: ct + sh * 0.5, z0: 0.05, chord: 0.14, tip: 0.1, span: 0.16, sweep: 10, t: 0.016, c: casing, camo: 0 }));
  else g.mirror(() => wing(g, { x: hl - 0.36, y: cy + r * 0.5, z0: r * 0.8, chord: 0.12, tip: 0.08, span: 0.13, sweep: 12, t: 0.016, c: casing, camo: 0 }));
  // stern control surfaces (upper rudder breaks the surface)
  const tx = -hl * 0.8;
  if (S.xtail) {
    for (const a of [0.78, -0.78]) g.at(tx, cy, 0, () => fin(g, { x: 0.08, y: 0, z: 0, h: 0.26, chord: 0.16, tip: 0.09, sweep: 15, c: casing, team: false, t: 0.016 }), 0, 0, a);
  } else {
    fin(g, { x: tx + 0.08, y: cy, z: 0, h: 0.26, chord: 0.18, tip: 0.1, sweep: 15, c: casing, team: false, t: 0.018 });
    g.mirror(() => wing(g, { x: tx + 0.08, y: cy, z0: 0.02, chord: 0.16, tip: 0.09, span: 0.2, sweep: 12, t: 0.016, c: casing, camo: 0 }));
  }
  // sonar dome line + hatches
  if (hi) { g.cylY(hl * 0.55, ct - 0.004, ct + 0.006, 0, 0.035, { seg: 8, c: mulC(casing, 1.3) }); g.cylY(-hl * 0.2, ct - 0.004, ct + 0.006, 0, 0.035, { seg: 8, c: mulC(casing, 1.3) }); }
  M.muzzle(hl, cy, 0.05); M.muzzle(hl, cy, -0.05);
  M.exhaust(-hl, 0, 0);
  return { kind: 'ship', radius: hl * 0.82, height: ct + sh + 0.08 };
}
