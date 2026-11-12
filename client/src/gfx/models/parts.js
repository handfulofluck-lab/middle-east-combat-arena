// Shared sub-assemblies: running gear, guns, greebles, missiles, rotors, radar, masts...

import { TAU, DEG, mixC, mulC, hashInt, lerp } from './geo.js';

// ------------------------------------------------------------------ wheels

/** Road wheel / tyre about the Z axis. side = +1/-1 (which face is visible). */
export function wheel(g, x, y, z, r, w, o = {}) {
  const { pal, hi } = g.ctx;
  const seg = o.seg ?? (hi ? 10 : 7);
  const s = o.side || Math.sign(z) || 1;
  const z0 = z - w / 2, z1 = z + w / 2;
  const sh = Math.min(w * 0.22, r * 0.2);
  // only the outboard half of the tyre is modelled (the inboard side is never seen from above)
  const zo = s > 0 ? z1 : z0, zm = z - s * w * 0.12;
  g.lathe('z', [[zm, r], [zo - s * sh, r], [zo, r * 0.8]], {
    at: [x, y, 0], seg, c: o.tyre || pal.tyre, crease: 50, cap0: false, cap1: true, tone: false,
  });
  // rim + hub
  const d = s * 0.012;
  const rim = o.rim || mixC(mulC(pal.base, 0.95), pal.steelLt, 0.25);
  g.lathe('z', [[zo + d * 0.2, r * 0.6], [zo - d * 1.4, r * 0.52], [zo + d * 0.5, r * 0.18]], {
    at: [x, y, 0], seg: hi ? 8 : 6, colors: [rim, rim, mulC(rim, 0.7)], crease: 30, cap0: false, cap1: true, camo: 0,
  });
  void z0;
}

/** A wheel that is its own node-local geometry (centred on the axle) — for spinning axles. */
export function axlePair(g, x, y, halfTrack, r, w, o = {}) {
  wheel(g, x, y, halfTrack, r, w, { ...o, side: 1 });
  wheel(g, x, y, -halfTrack, r, w, { ...o, side: -1 });
  g.cylZ(x, y, -halfTrack, halfTrack, r * 0.16, { seg: 6, c: g.ctx.pal.gun, cap0: false, cap1: false });
}

// ------------------------------------------------------------------ tracks

/**
 * One track unit (belt + wheels) on the +z or -z side.
 * o: x0 (rear end), x1 (front end), zc (centre z), w (belt width), h (top of track),
 *    n (road wheels), r (road wheel radius), drive: 'rear' | 'front', slack (soviet sagging top run)
 */
export function trackUnit(g, o) {
  const { pal, hi } = g.ctx;
  const t = 0.034; // belt thickness
  const { x0, x1, zc, w, h, n } = o;
  const side = Math.sign(zc) || 1;
  const r = o.r ?? 0.085;
  const yb = t / 2 + 0.004;
  const rs = o.rs ?? 0.075; // sprocket / idler radius
  const yEnd = h - t / 2 - rs; // end wheel centre height
  const xr = x0 + rs + t / 2, xf = x1 - rs - t / 2;
  // centre-line path, clockwise seen from +z (bottom run rear->front, up the front, top run front->rear)
  const path = [];
  const firstX = xr + r * 0.9 + (o.rearGap ?? 0.07), lastX = xf - r * 0.9 - (o.frontGap ?? 0.07);
  path.push([firstX, yb]);
  const nb = 2;
  for (let i = 1; i <= nb; i++) path.push([lerp(firstX, lastX, i / nb), yb]);
  const arc = (cx, cy, a0, a1, k) => { for (let i = 0; i <= k; i++) { const a = (a0 + ((a1 - a0) * i) / k) * DEG; path.push([cx + Math.cos(a) * (rs + t / 2), cy + Math.sin(a) * (rs + t / 2)]); } };
  arc(xf, yEnd, -55, 90, hi ? 4 : 3);
  const nt = o.slack ? 4 : 2;
  const sag = o.slack ? 0.03 : 0.0;
  for (let i = 1; i < nt; i++) {
    const k = i / nt;
    path.push([lerp(xf, xr, k), h - t / 2 - sag * Math.sin(k * Math.PI)]);
  }
  arc(xr, yEnd, 90, 235, hi ? 4 : 3);
  const m = path.length;
  const rings = [];
  const z0 = zc - w / 2, z1 = zc + w / 2;
  for (let i = 0; i <= m; i++) {
    const p = path[i % m], a = path[(i + m - 1) % m], b = path[(i + 1) % m];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    // outward normal (path runs counter-clockwise seen from +z: bottom run goes +x)
    const nx = ty, ny = -tx;
    rings.push([
      [p[0] + nx * t / 2, p[1] + ny * t / 2, z0], [p[0] + nx * t / 2, p[1] + ny * t / 2, z1],
      [p[0] - nx * t / 2, p[1] - ny * t / 2, z1], [p[0] - nx * t / 2, p[1] - ny * t / 2, z0],
    ]);
  }
  // alternate link tones along the belt
  const colors = rings.map((_, i) => (i % 2 ? pal.track : pal.trackLt));
  g.loft(rings, { cap0: false, cap1: false, crease: 20, colors, camo: 0, tone: false });
  // guide teeth / cleats on the exposed front+rear arcs
  // road wheels
  const wr = pal.under, hub = mulC(mixC(pal.base, pal.black, 0.35), 0.9);
  const wy = yb + t / 2 + r;
  const zo = zc + side * (w / 2 - 0.012), zi = zc - side * (w / 2 - 0.03);
  const seg = hi ? 7 : 6;
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? (firstX + lastX) / 2 : lerp(firstX - r * 0.25, lastX + r * 0.25, i / (n - 1));
    roadWheel(g, x, wy, zi, zo, r, side, seg, wr, hub);
  }
  // sprocket + idler
  const sx = o.drive === 'front' ? xf : xr, ix = o.drive === 'front' ? xr : xf;
  roadWheel(g, sx, yEnd, zi, zo, rs, side, seg, pal.gun, mulC(pal.steel, 0.8), true);
  roadWheel(g, ix, yEnd, zi, zo, rs * 0.92, side, seg, wr, hub);
  // return rollers
  if (!o.slack && hi && o.rollers !== 0) {
    const k = o.rollers ?? 3;
    for (let i = 0; i < k; i++) {
      const x = lerp(xr, xf, (i + 1) / (k + 1));
      g.cylZ(x, h - t - 0.03, Math.min(zi, zo), Math.max(zi, zo), 0.028, { seg: 6, c: wr, camo: 0 });
    }
  }
  return { wy, firstX, lastX };
}

function roadWheel(g, x, y, zi, zo, r, side, seg, c, hub, sprocket) {
  const d = side * 0.014;
  const zb = zo - side * 0.07; // only the outer part of the wheel is ever visible
  const pts = sprocket
    ? [[zo - side * 0.05, r], [zo, r], [zo, r * 0.5], [zo + d * 0.4, r * 0.2]]
    : [[zo - side * 0.05, r], [zo, r * 0.84], [zo, r * 0.34]];
  const colors = sprocket ? [c, c, hub, hub] : [c, c, hub];
  g.lathe('z', pts, { at: [x, y, 0], seg, colors, crease: 35, cap0: false, cap1: true, camo: 0, tone: false });
}

// ------------------------------------------------------------------ guns

/**
 * Tank / howitzer barrel along +X starting at x0. Returns muzzle x.
 * o: len, r (bore radius), y, z, evac (0..1 position of bore evacuator, 0 = none), brake ('none'|'pepper'|'slot'),
 *    sleeve (thermal sleeve bands), c
 */
export function gunBarrel(g, x0, o) {
  const { pal, hi } = g.ctx;
  const len = o.len, r = o.r, y = o.y || 0, z = o.z || 0;
  const c = o.c || mixC(pal.base, pal.gun, 0.55);
  const pts = [];
  const add = (t, rr) => pts.push([x0 + t * len, rr]);
  add(0, r * 1.55); add(0.1, r * 1.5); add(0.11, r * 1.2);
  if (o.evac) {
    const e = o.evac, el = Math.min(0.09, 0.16 / len);
    add(e - el - 0.012, r * 1.12); add(e - el, r * 1.75); add(e + el, r * 1.75); add(e + el + 0.012, r * 1.08);
  }
  if (o.sleeve !== false && hi) { add(0.72, r * 1.05); add(0.725, r * 1.18); add(0.745, r * 1.18); add(0.75, r * 1.0); }
  const br = o.brake || 'none';
  if (br === 'none') { add(0.965, r); add(0.97, r * 1.22); add(1, r * 1.22); add(1, r * 0.6); add(0.97, r * 0.6); }
  else { add(1 - 0.16 / len * 1.0, r); }
  g.lathe('x', pts, { at: [0, y, z], seg: g.ctx.seg(8), c, crease: 40, camo: 0, cap0: false });
  if (br !== 'none') {
    const bl = Math.min(0.16, len * 0.2);
    const bx = x0 + len - bl;
    if (br === 'slot') {
      // double-baffle muzzle brake
      g.box(bx + bl * 0.22, y, z, bl * 0.3, r * 3.0, r * 4.2, { c: pal.gun, b: 0.006, camo: 0 });
      g.box(bx + bl * 0.75, y, z, bl * 0.3, r * 2.8, r * 3.8, { c: pal.gun, b: 0.006, camo: 0 });
      g.cylX(bx, x0 + len, y, z, r * 1.15, { c, seg: 8, camo: 0 });
    } else {
      g.lathe('x', [[bx, r * 1.0], [bx + 0.01, r * 1.7], [x0 + len - 0.01, r * 1.7], [x0 + len, r * 1.3], [x0 + len, r * 0.7], [x0 + len - 0.03, r * 0.7]], { at: [0, y, z], seg: g.ctx.seg(10), c: pal.gun, crease: 40, camo: 0, cap0: false });
    }
  }
  return x0 + len;
}

/** Thin autocannon / MG barrel along +X. */
export function thinBarrel(g, x0, len, y, z, r, o = {}) {
  const { pal } = g.ctx;
  const c = o.c || pal.gun;
  const pts = r < 0.0095
    ? [[x0, r * 1.6], [x0 + len * 0.3, r * 1.6], [x0 + len * 0.3, r], [x0 + len, r]]
    : [[x0, r * 1.6], [x0 + len * 0.28, r * 1.6], [x0 + len * 0.3, r], [x0 + len * 0.93, r], [x0 + len * 0.94, r * 1.5], [x0 + len, r * 1.5], [x0 + len, r * 0.5]];
  g.lathe('x', pts, { at: [0, y, z], seg: o.seg ?? 6, c, crease: 40, camo: 0, cap0: false, tone: false });
  return x0 + len;
}

/** Heavy machine gun on a pintle, pointing +X. Returns muzzle [x,y,z]. */
export function hmg(g, x, y, z, o = {}) {
  const { pal, hi } = g.ctx;
  const s = o.s || 1;
  g.cylY(x, y, y + 0.05 * s, z, 0.012 * s, { seg: 5, c: pal.gun });
  g.box(x + 0.01 * s, y + 0.07 * s, z, 0.13 * s, 0.035 * s, 0.03 * s, { c: pal.gun, b: 0.004, camo: 0 });
  thinBarrel(g, x + 0.07 * s, 0.17 * s, y + 0.072 * s, z, 0.007 * s, { seg: 5 });
  if (hi) g.box(x + 0.0, y + 0.06 * s, z + 0.035 * s, 0.06 * s, 0.05 * s, 0.03 * s, { c: mulC(pal.base, 0.6), b: 0.004, camo: 0 });
  if (o.shield) {
    g.box(x + 0.045 * s, y + 0.085 * s, z, 0.012, 0.11 * s, 0.17 * s, { c: pal.base, b: 0.004, rot: [0, 0.12, 0] });
  }
  return [x + 0.24 * s, y + 0.072 * s, z];
}

/** Smoke grenade discharger cluster. dir = +1 (left, +z) / -1. */
export function smokeRack(g, x, y, z, n, dir) {
  const { pal, hi } = g.ctx;
  g.box(x, y, z, 0.035 * n + 0.02, 0.03, 0.03, { c: pal.gun, b: 0.004, camo: 0 });
  if (!hi) return;
  for (let i = 0; i < n; i++) {
    const px = x - (0.035 * (n - 1)) / 2 + i * 0.035;
    g.pipe([px, y, z], [px + 0.05, y + 0.045, z + dir * 0.03], 0.013, { seg: 4, c: pal.gun, cap0: false });
  }
}

export function antenna(g, x, y, z, h, o = {}) {
  const { pal } = g.ctx;
  g.cylY(x, y, y + 0.03, z, 0.012, { seg: 5, c: pal.gun });
  g.beam([x, y + 0.02, z], [x - h * 0.08, y + h, z], 0.006, { c: pal.black, tone: false, nb: true });
  if (o.flag) {
    // pennant in team colour
    const fy = y + h * 0.8, fx = x - h * 0.065;
    g.box(fx - 0.06, fy, z, 0.11, 0.07, 0.006, { c: pal.team, b: 0, tone: false, ao: false, nb: true });
  }
}

export function hatch(g, x, y, z, r, o = {}) {
  const { pal } = g.ctx;
  g.lathe('y', [[y, r], [y + 0.014, r], [y + 0.02, r * 0.86], [y + 0.02, 0]], { at: [x, 0, z], seg: g.ctx.seg(8), c: o.c || mulC(pal.base, 0.9), crease: 40, cap0: false, camo: 1 });
}

/** Louvred engine grille on a horizontal surface. */
export function grille(g, cx, y, cz, sx, sz, n, o = {}) {
  const { pal, hi } = g.ctx;
  g.box(cx, y + 0.004, cz, sx, 0.008, sz, { c: pal.black, b: 0, tone: false });
  if (!hi) n = Math.ceil(n / 2);
  const alongX = o.alongX;
  for (let i = 0; i < n; i++) {
    const k = (i + 0.5) / n - 0.5;
    if (alongX) g.box(cx, y + 0.012, cz + k * sz, sx, 0.008, (sz / n) * 0.5, { c: mulC(pal.base, 0.7), b: 0, camo: 0 });
    else g.box(cx + k * sx, y + 0.012, cz, (sx / n) * 0.5, 0.008, sz, { c: mulC(pal.base, 0.7), b: 0, camo: 0 });
  }
}

/** Row of ERA tiles on a (roughly) planar area: origin, u/v step vectors, counts. */
export function eraGrid(g, p0, du, dv, nu, nv, size, o = {}) {
  const { pal, hi } = g.ctx;
  if (!hi) { nu = Math.max(1, Math.ceil(nu / 2)); du = [du[0] * 2, du[1] * 2, du[2] * 2]; size = [size[0] * 2, size[1], size[2]]; }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      g.box(p0[0] + du[0] * i + dv[0] * j, p0[1] + du[1] * i + dv[1] * j, p0[2] + du[2] * i + dv[2] * j, size[0], size[1], size[2], {
        c: o.c || pal.base, camo: 1, b: 0.006, rot: o.rot, toneAmt: 0.09,
      });
    }
  }
}

export function jerrycan(g, x, y, z, o = {}) {
  g.box(x, y + 0.045, z, 0.035, 0.09, 0.065, { c: o.c || mulC(g.ctx.pal.base, 0.75), b: 0.008, camo: 0, rot: o.rot });
}

export function headlight(g, x, y, z, r = 0.022) {
  const { pal } = g.ctx;
  g.lathe('x', [[x - 0.02, r], [x + 0.008, r], [x + 0.008, r * 0.8], [x + 0.012, 0]], { at: [0, y, z], seg: 6, colors: [pal.gun, pal.gun, pal.lamp, pal.lamp], cap0: false, tone: false, ao: false, camo: 0 });
}

// ------------------------------------------------------------------ missiles & tubes

/**
 * Missile along +X with its tail at x0. o: len, r, fins (count), finAt (0..1 list), nose ('ogive'|'cone'|'round'),
 * c (body), tip (nose colour), band (stripe colour)
 */
export function missile(g, x0, y, z, o) {
  const { pal, hi } = g.ctx;
  const len = o.len, r = o.r;
  const c = o.c || pal.missileW, tip = o.tip || pal.warhead;
  const nl = o.noseLen ?? Math.min(len * 0.3, r * 5);
  const seg = o.seg ?? g.ctx.seg(8);
  const xb = x0 + len - nl;
  const L = [[x0, r * 0.75, pal.gun], [x0 + r * 0.6, r, pal.gun], [x0 + r * 0.6, r, c]];
  if (o.band) {
    const b0 = xb - r * 2.6, b1 = xb - r * 1.1;
    L.push([b0, r, c], [b0, r * 1.03, o.band], [b1, r * 1.03, o.band], [b1, r, c]);
  }
  L.push([xb, r, c], [xb, r, tip]);
  if (o.nose === 'round') L.push([xb + nl * 0.5, r * 0.9, tip], [xb + nl * 0.85, r * 0.55, tip], [x0 + len, 0, tip]);
  else if (o.nose === 'cone') L.push([x0 + len, 0, tip]);
  else L.push([xb + nl * 0.45, r * 0.8, tip], [xb + nl * 0.8, r * 0.42, tip], [x0 + len, 0, tip]);
  g.lathe('x', L.map((q) => [q[0], q[1]]), { at: [0, y, z], seg, colors: L.map((q) => q[2]), crease: 45, camo: 0, tone: false });
  const fins = o.fins ?? 4;
  const fc = o.finC || mulC(c, 0.8);
  const finSets = o.finAt || [0.02];
  const fl = o.finLen ?? r * 3.2, fh = o.finH ?? r * 1.9;
  for (const fa of finSets) {
    const fx = x0 + fa * len;
    for (let i = 0; i < fins; i++) {
      const a = (i / fins) * TAU + (o.finPhase ?? Math.PI / 4);
      g.push().translate(0, y, z).rotX(a);
      // swept fin in the XY plane, thin in Z
      g.prismZ([[fx, r * 0.8], [fx + fl, r * 0.8], [fx + fl * 0.55, r + fh], [fx + fl * 0.12, r + fh]], -0.006, 0.006, { c: fc, b: 0, camo: 0 });
      g.pop();
    }
    if (!hi) break;
  }
  return x0 + len;
}

/** Round launch tube / canister along +X. */
export function canister(g, x0, x1, y, z, r, o = {}) {
  const { pal } = g.ctx;
  const c = o.c || pal.base;
  const cap = o.cap || mulC(c, 0.7);
  if (r < 0.045) {
    const fc0 = o.front || pal.black;
    g.lathe('x', [[x0, r], [x1, r], [x1, r * 0.74], [x1 - 0.015, r * 0.74], [x1 - 0.015, 0]], { at: [0, y, z], seg: 6, colors: [c, c, fc0, fc0, fc0], crease: 40, camo: 0, cap1: false });
    return;
  }
  const seg = o.seg ?? g.ctx.seg(8);
  const ribs = o.ribs ?? 2;
  const pts = [[x0, r * 0.9], [x0 + 0.01, r]];
  const cols = [cap, c];
  const L = x1 - x0;
  for (let i = 1; i <= ribs; i++) {
    const t = x0 + (L * i) / (ribs + 1);
    pts.push([t - 0.012, r], [t - 0.012, r * 1.07], [t + 0.012, r * 1.07], [t + 0.012, r]);
    cols.push(c, cap, cap, c);
  }
  pts.push([x1 - 0.012, r], [x1 - 0.012, r * 1.08], [x1, r * 1.08], [x1, r * 0.8], [x1 - 0.02, r * 0.8], [x1 - 0.02, 0]);
  const fc = o.front || pal.black;
  cols.push(c, cap, cap, fc, fc, fc);
  g.lathe('x', pts, { at: [0, y, z], seg, colors: cols, crease: 40, camo: 0, cap1: false });
}

/**
 * Box of launch tubes (MLRS pod): cells across z and y, opening toward +X.
 * Centre at (cx,cy,cz), length L, width W, height H.
 */
export function tubeBank(g, cx, cy, cz, L, W, H, nz, ny, o = {}) {
  const { pal, hi } = g.ctx;
  const c = o.c || pal.base;
  g.box(cx, cy, cz, L, H, W, { c, camo: o.camo ?? 1, b: o.b ?? 0.015 });
  // dark recessed tube mouths on the front face (and optionally rear)
  const fx = cx + L / 2 + 0.002;
  const cw = W / nz, chh = H / ny;
  const rr = Math.min(cw, chh) * (o.fill ?? 0.36);
  const seg = hi ? 8 : 5;
  const tip = o.tip; // visible warhead colour, or null for empty-looking tubes
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < ny; j++) {
      const z = cz - W / 2 + cw * (i + 0.5), y = cy - H / 2 + chh * (j + 0.5);
      const col = tip && hashInt(g.ctx.seed + i * 31 + j * 7) > (o.empty ?? 0.0) ? tip : pal.black;
      g.lathe('x', [[fx, rr], [fx + 0.004, rr * 0.9], [fx + 0.004, 0]], { at: [0, y, z], seg, c: col, cap0: false, tone: false, ao: false, camo: 0, crease: 30 });
      if (o.rear) g.lathe('x', [[cx - L / 2 - 0.004, 0], [cx - L / 2 - 0.004, rr * 0.9], [cx - L / 2 - 0.002, rr]], { at: [0, y, z], seg, c: pal.black, cap1: false, tone: false, ao: false, camo: 0, crease: 30 });
    }
  }
  return fx;
}

/** Bundle of exposed round rocket tubes (Grad / Smerch style) along +X centred at (cx,cy,cz). */
export function tubeBundle(g, cx, cy, cz, L, r, nz, ny, o = {}) {
  const { pal, hi } = g.ctx;
  const c = o.c || pal.base;
  const pitch = r * 2.12;
  const seg = hi ? 6 : 5;
  const W = pitch * nz, H = pitch * ny;
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < ny; j++) {
      const z = cz - W / 2 + pitch * (i + 0.5), y = cy - H / 2 + pitch * (j + 0.5);
      g.lathe('x', [[cx - L / 2, r], [cx + L / 2, r], [cx + L / 2, r * 0.72], [cx + L / 2 - 0.03, r * 0.72], [cx + L / 2 - 0.03, 0]], {
        at: [0, y, z], seg, colors: [c, c, pal.black, pal.black, pal.black], crease: 40, camo: 1, cap0: !!o.rear, cap1: false,
      });
    }
  }
  // clamping frames
  for (const k of [-0.3, 0.3]) g.box(cx + k * L, cy, cz, 0.03, H + 0.03, W + 0.03, { c: mulC(c, 0.72), b: 0.005, camo: 0 });
  return { W, H };
}

// ------------------------------------------------------------------ radar & masts

/** Parabolic dish facing +X at (x,y,z). */
export function dish(g, x, y, z, r, o = {}) {
  const { pal } = g.ctx;
  const c = o.c || pal.steelLt;
  const d = o.depth ?? r * 0.32;
  const pts = [];
  const k = 4;
  for (let i = 0; i <= k; i++) { const u = i / k; pts.push([x - d * (1 - u * u), u * r]); }
  pts.push([x + 0.008, r * 1.0]);
  for (let i = k; i >= 0; i--) { const u = i / k; pts.push([x - d * (1 - u * u) + 0.012, u * r * 0.97]); }
  g.lathe('x', pts, { at: [0, y, z], seg: g.ctx.seg(12), c, crease: 60, camo: 0, cap0: false, cap1: false });
  // feed horn
  g.pipe([x - d + 0.01, y, z], [x + d * 0.9, y, z], r * 0.035, { seg: 4, c: pal.gun });
  g.sphere(x + d * 0.9, y, z, r * 0.09, { seg: 6, c: pal.gun });
}

/** Flat phased-array panel facing +X, tilted back by `tilt` radians. */
export function radarPanel(g, x, y, z, w, h, o = {}) {
  const { pal } = g.ctx;
  g.at(x, y, z, () => {
    g.box(0, 0, 0, 0.05, h, w, { c: o.frame || pal.base, b: 0.01, camo: 0 });
    g.box(0.028, 0, 0, 0.012, h * 0.84, w * 0.86, { c: o.c || mulC(pal.steel, 0.8), b: 0.004, camo: 0 });
  }, o.ry || 0, o.tilt || 0);
}

/** Square lattice mast from y0 to y1 centred at (x,z). */
export function lattice(g, x, y0, y1, z, w, o = {}) {
  const { pal, hi } = g.ctx;
  const c = o.c || pal.steel;
  const w1 = o.w1 ?? w * 0.6;
  const n = o.n ?? Math.max(2, Math.round((y1 - y0) / (w * 1.5)));
  const t = o.t ?? Math.max(0.012, w * 0.07);
  const cor = (k, u) => { const ww = lerp(w, w1, u) / 2; return [[x - ww, z - ww], [x + ww, z - ww], [x + ww, z + ww], [x - ww, z + ww]][k]; };
  for (let k = 0; k < 4; k++) {
    const a = cor(k, 0), b = cor(k, 1);
    g.beam([a[0], y0, a[1]], [b[0], y1, b[1]], t, { c });
  }
  for (let i = 0; i <= n; i++) {
    const u = i / n, y = lerp(y0, y1, u);
    for (let k = 0; k < 4; k++) {
      const a = cor(k, u), b = cor((k + 1) % 4, u);
      if (i > 0 || o.base !== false) g.beam([a[0], y, a[1]], [b[0], y, b[1]], t * 0.7, { c });
      if (i < n && (hi || k % 2 === 0)) {
        const u2 = (i + 1) / n, d = cor((k + 1) % 4, u2);
        const e = (i + k) % 2 ? [a, d] : [b, cor(k, u2)];
        g.beam([e[0][0], y, e[0][1]], [e[1][0], lerp(y0, y1, u2), e[1][1]], t * 0.6, { c });
      }
    }
  }
}

// ------------------------------------------------------------------ rotors

/**
 * Rotor blades (lit, in `g`) about the Y axis centred at the node origin (x,y,z).
 * n blades, radius R, chord c.
 */
export function rotorBlades(g, x, y, z, R, n, o = {}) {
  const { pal } = g.ctx;
  const chord = o.chord ?? R * 0.075;
  const col = o.c || mulC(pal.gun, 0.9);
  const tipC = o.tip || pal.yellow;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (o.phase || 0);
    g.push().translate(x, y, z).rotY(a);
    // blade: slightly drooped, thin
    g.box(R * 0.52, 0, 0, R * 0.9, 0.012, chord, { c: col, b: 0.004, camo: 0, warp: (p, s0) => { if (s0 > 0) p[1] -= R * (o.droop ?? 0.035); } });
    g.box(R * 0.955, -R * (o.droop ?? 0.035), 0, R * 0.07, 0.013, chord, { c: tipC, b: 0.003, camo: 0, tone: false });
    // blade grip
    g.box(R * 0.09, 0, 0, R * 0.12, 0.022, chord * 0.55, { c: pal.steel, b: 0.004, camo: 0 });
    g.pop();
  }
  // hub
  g.cylY(x, y - 0.03, y + 0.03, z, R * 0.055, { seg: 8, c: pal.gun, b: 0.006 });
  g.cylY(x, y + 0.03, y + 0.05, z, R * 0.03, { seg: 6, c: pal.steel });
}

/**
 * Translucent motion-blur disc (rotorDisc material, RGBA vertex colours) about axis 'y' or 'z'.
 * Each blade drags a soft wedge of blur behind it.
 */
export function rotorDisc(g, x, y, z, R, n, o = {}) {
  const axis = o.axis || 'y';
  const seg = n * (g.ctx.hi ? 8 : 5);
  const r0 = R * 0.08;
  const P = [], N = [], F = [], A = [];
  const base = o.alpha ?? 0.1, peak = o.peak ?? 0.3;
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    const a = u * TAU + (o.phase || 0);
    // saw-tooth per blade: strongest right behind the blade, fading out
    const k = (u * n) % 1;
    const al = base + (peak - base) * Math.pow(1 - k, 2.2);
    const ca = Math.cos(a), sa = Math.sin(a);
    const put = (r, alpha) => {
      if (axis === 'y') { P.push(x + ca * r, y, z - sa * r); N.push(0, 1, 0); }
      else if (axis === 'z') { P.push(x + ca * r, y + sa * r, z); N.push(0, 0, 1); }
      else { P.push(x, y + ca * r, z + sa * r); N.push(1, 0, 0); }
      A.push(alpha);
    };
    put(r0, al * 0.6); put(R * 0.6, al); put(R, al * 0.55);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 3, b = (i + 1) * 3;
    F.push(a, b, b + 1, a, b + 1, a + 1, a + 1, b + 1, b + 2, a + 1, b + 2, a + 2);
  }
  const c = o.c || [0.03, 0.03, 0.035];
  g.emit(P, N, F, { c: (px, py, pz, i) => [c[0], c[1], c[2], A[i]], shade: false });
}

/** Small unlit rotor (blades + blur in one rotorDisc mesh) — tail rotors, propellers. */
export function flatRotor(g, x, y, z, R, n, o = {}) {
  const axis = o.axis || 'z';
  rotorDisc(g, x, y, z, R, n, { ...o, axis, alpha: 0.1, peak: 0.34 });
  const P = [], N = [], F = [];
  const w = o.chord ?? R * 0.14;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (o.phase || 0);
    const ca = Math.cos(a), sa = Math.sin(a);
    const v = P.length / 3;
    const pt = (r, t) => {
      const u = ca * r - sa * t, vv = sa * r + ca * t;
      if (axis === 'z') { P.push(x + u, y + vv, z); N.push(0, 0, 1); }
      else if (axis === 'x') { P.push(x, y + u, z + vv); N.push(1, 0, 0); }
      else { P.push(x + u, y, z - vv); N.push(0, 1, 0); }
    };
    pt(R * 0.05, -w / 2); pt(R * 0.98, -w * 0.4); pt(R * 0.98, w * 0.4); pt(R * 0.05, w / 2);
    F.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  g.emit(P, N, F, { c: [0.035, 0.035, 0.04, 0.92], shade: false });
}

// ------------------------------------------------------------------ misc

/** Hazard chevrons: alternating yellow/black strip of decals along X. */
export function hazardStrip(g, cx, y, cz, len, w, o = {}) {
  const { pal } = g.ctx;
  const n = Math.max(2, Math.round(len / (w * 1.1)));
  const alongZ = o.alongZ;
  for (let i = 0; i < n; i++) {
    const k = (i + 0.5) / n - 0.5;
    const c = i % 2 ? pal.hazK : pal.yellow;
    if (alongZ) g.decal(cx, y, cz + k * len, w, len / n, { c });
    else g.decal(cx + k * len, y, cz, len / n, w, { c });
  }
}

/** Stack of sandbags forming a wall segment between two points. */
export function sandbagWall(g, p0, p1, rows, o = {}) {
  const { pal, hi } = g.ctx;
  const dx = p1[0] - p0[0], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dz);
  const bl = o.bagLen ?? 0.2, bh = o.bagH ?? 0.085, bw = o.bagW ?? 0.13;
  const n = Math.max(1, Math.round(len / bl));
  const ang = Math.atan2(-dz, dx);
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? 0.5 : 0;
    const cnt = r % 2 ? n - 1 : n;
    for (let i = 0; i < cnt; i++) {
      const u = (i + 0.5 + off) / n;
      const h = hashInt(g.ctx.seed + r * 131 + i * 17 + Math.round(p0[0] * 97 + p0[2] * 31));
      g.box(p0[0] + dx * u, (p0[1] || 0) + bh * (r + 0.5), p0[2] + dz * u, (len / n) * 0.96, bh * 0.98, bw, {
        c: h > 0.5 ? pal.sandbag : pal.sandbagDk, b: hi ? 0.03 : 0, rot: [ang + (h - 0.5) * 0.08, 0, 0], toneAmt: 0.08,
      });
    }
  }
}

/** Simple flag on a pole (team colour). */
export function flagPole(g, x, y, z, h, o = {}) {
  const { pal } = g.ctx;
  g.cylY(x, y, y + h, z, 0.014, { seg: 5, c: pal.steelLt });
  g.sphere(x, y + h + 0.015, z, 0.022, { seg: 6, c: pal.brass });
  const fw = o.w ?? h * 0.42, fh = o.h ?? h * 0.26;
  // slightly waving flag: three segments
  const n = 3;
  for (let i = 0; i < n; i++) {
    const zo = Math.sin(i * 1.3 + 0.4) * 0.02;
    g.box(x + (fw / n) * (i + 0.5) + 0.01, y + h - fh / 2 - 0.02, z + zo, fw / n + 0.004, fh, 0.008, { c: i === 1 && o.stripe ? pal.teamLt : pal.team, b: 0, tone: false, ao: false, rot: [(-0.25 + i * 0.25) * 0.5, 0, 0] });
  }
}
