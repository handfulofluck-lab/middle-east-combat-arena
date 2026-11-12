// Procedural geometry toolkit for the MCA model library.
//
// A `Geo` accumulates many primitives into ONE indexed BufferGeometry with
// per-vertex colours. Every primitive is emitted through `emit()`, which
// applies the current transform, bakes camo / tone / ambient-occlusion shading
// into the vertex colours and fixes triangle winding from the vertex normals
// (so primitives never have to care about winding or mirrored transforms).
//
// Hard-surface primitives use "weighted normals": chamfer faces borrow the
// normals of the big faces they connect, so a 44-triangle box reads as a
// machined part with a rounded, highlight-catching edge.

import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

// ---------- deterministic hashing / noise (never Math.random) ----------

export function hashInt(n) {
  n |= 0;
  n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
  n = Math.imul(n ^ (n >>> 15), 0x735a2d97);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function lat(ix, iy, iz, seed) {
  return hashInt(Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 1274126177) ^ seed);
}

export function noise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = lat(ix, iy, iz, seed), b = lat(ix + 1, iy, iz, seed);
  const c = lat(ix, iy + 1, iz, seed), d = lat(ix + 1, iy + 1, iz, seed);
  const e = lat(ix, iy, iz + 1, seed), f = lat(ix + 1, iy, iz + 1, seed);
  const g = lat(ix, iy + 1, iz + 1, seed), h = lat(ix + 1, iy + 1, iz + 1, seed);
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx, ef = e + (f - e) * fx, gh = g + (h - g) * fx;
  const abcd = ab + (cd - ab) * fy, efgh = ef + (gh - ef) * fy;
  return abcd + (efgh - abcd) * fz;
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------- colour helpers (all colours are linear-space [r,g,b]) ----------

const _c = new THREE.Color();
export function hex(h) { _c.setHex(h); return [_c.r, _c.g, _c.b]; }
export const mixC = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const mulC = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------- mesh refinement (conforming edge split, no T-junctions) ----------
// An edge is split when it is longer than maxE, or (adaptive mode) when the scalar field `w`
// changes along it and it is still longer than minE. The decision depends only on the edge's
// end positions, so neighbouring triangles always agree and the mesh stays watertight.

function refine(P, N, F, C, opt) {
  P = P.slice(); N = N.slice();
  if (C) C = C.slice();
  const maxE2 = opt.maxE * opt.maxE;
  const minE2 = opt.minE ? opt.minE * opt.minE : Infinity;
  const w = opt.w;
  const W = w ? [] : null; // cached field values per vertex
  const wAt = (i) => { let v = W[i]; if (v === undefined) v = W[i] = w(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); return v; };
  for (let pass = 0; pass < 6; pass++) {
    const mid = new Map();
    let any = false;
    const F2 = [];
    const m = (a, b) => {
      const key = a < b ? a * 262144 + b : b * 262144 + a;
      let v = mid.get(key);
      if (v === undefined) {
        const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
        const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
        const d2 = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
        let split = d2 > maxE2;
        let wm;
        if (!split && w && d2 > minE2) {
          const wa = wAt(a), wb = wAt(b);
          wm = w((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
          split = Math.abs(wa - wb) > 0.12 || Math.abs(wm - (wa + wb) / 2) > 0.1;
        }
        if (split) {
          v = P.length / 3;
          P.push((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
          const nx = N[a * 3] + N[b * 3], ny = N[a * 3 + 1] + N[b * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2];
          const l = Math.hypot(nx, ny, nz) || 1;
          N.push(nx / l, ny / l, nz / l);
          if (C) for (let k = 0; k < 4; k++) C.push((C[a * 4 + k] + C[b * 4 + k]) / 2);
          if (W && wm !== undefined) W[v] = wm;
          any = true;
        } else v = -1;
        mid.set(key, v);
      }
      return v;
    };
    for (let i = 0; i < F.length; i += 3) {
      const a = F[i], b = F[i + 1], c = F[i + 2];
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      const n = (ab >= 0) + (bc >= 0) + (ca >= 0);
      if (n === 0) F2.push(a, b, c);
      else if (n === 3) F2.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
      else if (n === 1) {
        if (ab >= 0) F2.push(a, ab, c, ab, b, c);
        else if (bc >= 0) F2.push(a, b, bc, a, bc, c);
        else F2.push(a, b, ca, ca, b, c);
      } else if (ab < 0) F2.push(c, ca, bc, a, b, bc, a, bc, ca);
      else if (bc < 0) F2.push(a, ab, ca, ab, b, c, ab, c, ca);
      else F2.push(b, bc, ab, a, ab, bc, a, bc, c);
    }
    F = F2;
    if (!any) break;
  }
  return { P, N, F, C };
}

// ---------- small 2D helpers ----------

function area2(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) { const q = p[(i + 1) % n]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
  return a / 2;
}

function inset2(p, b) {
  if (!(b > 0)) return p.map((q) => [q[0], q[1]]);
  const n = p.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], c = p[i], d = p[(i + 1) % n];
    let e0x = c[0] - a[0], e0y = c[1] - a[1], e1x = d[0] - c[0], e1y = d[1] - c[1];
    const l0 = Math.hypot(e0x, e0y) || 1, l1 = Math.hypot(e1x, e1y) || 1;
    e0x /= l0; e0y /= l0; e1x /= l1; e1y /= l1;
    // inward normals for a CCW polygon
    const n0x = -e0y, n0y = e0x, n1x = -e1y, n1y = e1x;
    const k = Math.max(0.35, 1 + n0x * n1x + n0y * n1y);
    out.push([c[0] + (b * (n0x + n1x)) / k, c[1] + (b * (n0y + n1y)) / k]);
  }
  return out;
}

const _t = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
const _q = new THREE.Quaternion();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);

const HEX_FACES = [[1, 3, 7, 5], [0, 4, 6, 2], [2, 6, 7, 3], [0, 1, 5, 4], [4, 5, 7, 6], [0, 2, 3, 1]];

export class Geo {
  constructor(ctx, o = {}) {
    this.ctx = ctx;
    this.P = []; this.N = []; this.C = []; this.I = [];
    this.nv = 0;
    this.alpha = !!o.alpha;
    this.cs = this.alpha ? 4 : 3;
    this.shade = o.shade !== false;
    this.M = new THREE.Matrix4();
    this.stack = [];
    this.col = ctx.pal.base;
    this.camoMode = 0;
    this.prim = 0;
    this.bMaxY = -Infinity; this.bMinY = Infinity; this.bMaxR = 0; // bounds of 'solid' prims (o.nb excluded)
  }

  get tris() { return this.I.length / 3; }
  get empty() { return this.I.length === 0; }

  // ----- state -----
  c(col) { this.col = col; return this; }
  camo(m) { this.camoMode = m; return this; }
  push() { this.stack.push(this.M.clone()); return this; }
  pop() { this.M.copy(this.stack.pop()); return this; }
  translate(x, y, z) { this.M.multiply(_t.makeTranslation(x, y, z)); return this; }
  rotX(a) { this.M.multiply(_t.makeRotationX(a)); return this; }
  rotY(a) { this.M.multiply(_t.makeRotationY(a)); return this; }
  rotZ(a) { this.M.multiply(_t.makeRotationZ(a)); return this; }
  scale(x, y, z) { this.M.multiply(_t.makeScale(x, y, z)); return this; }
  /** Run fn inside a local frame: translate, then yaw (Y), pitch (Z, +raises +X), roll (X). */
  at(x, y, z, fn, ry = 0, rz = 0, rx = 0) {
    this.push().translate(x, y, z);
    if (ry) this.rotY(ry);
    if (rz) this.rotZ(rz);
    if (rx) this.rotX(rx);
    fn(this);
    return this.pop();
  }
  /** Run fn(+1) as authored and fn(-1) mirrored across the XY plane (z -> -z). */
  mirror(fn) {
    fn(1);
    this.push().scale(1, 1, -1);
    fn(-1);
    return this.pop();
  }

  // ----- core emit -----
  emit(P, N, F, o = {}) {
    const ctx = this.ctx;
    let camo = ctx.camoOn ? (o.camo ?? this.camoMode) : 0;
    if (camo === 2 && !ctx.hi) camo = 1;
    const e = this.M.elements;
    _m3.getNormalMatrix(this.M);
    const n = _m3.elements;
    let nv = P.length / 3;
    const col = o.c ?? this.col;
    const fn = typeof col === 'function';
    const a = o.a ?? 1;
    const k = this.prim++;
    const shade = this.shade && o.shade !== false;
    let tone = 1;
    if (shade && o.tone !== false) tone = 1 + (hashInt(ctx.seed + k * 7919) - 0.5) * 2 * (o.toneAmt ?? ctx.toneAmt);
    // to model space
    let W = new Array(nv * 3), WN = new Array(nv * 3), CA = fn ? new Array(nv * 4) : null;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < nv; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      W[i * 3] = wx; W[i * 3 + 1] = wy; W[i * 3 + 2] = wz;
      cx += wx; cy += wy; cz += wz;
      const lx = N[i * 3], ly = N[i * 3 + 1], lz = N[i * 3 + 2];
      const nx = n[0] * lx + n[3] * ly + n[6] * lz;
      const ny = n[1] * lx + n[4] * ly + n[7] * lz;
      const nz = n[2] * lx + n[5] * ly + n[8] * lz;
      const l = Math.hypot(nx, ny, nz) || 1;
      WN[i * 3] = nx / l; WN[i * 3 + 1] = ny / l; WN[i * 3 + 2] = nz / l;
      if (fn) { const c = col(x, y, z, i); CA[i * 4] = c[0]; CA[i * 4 + 1] = c[1]; CA[i * 4 + 2] = c[2]; CA[i * 4 + 3] = c.length > 3 ? c[3] : a; }
    }
    if (o.tess > 0) { const r = refine(W, WN, F, CA, { maxE: o.tess }); W = r.P; WN = r.N; F = r.F; CA = r.C; }
    else if (camo === 2 && o.tess !== 0) { const r = refine(W, WN, F, CA, { maxE: ctx.camoMax, minE: ctx.camoMin, w: ctx.camoW }); W = r.P; WN = r.N; F = r.F; CA = r.C; }
    let cc = col;
    if (camo === 1 && !fn) cc = ctx.camoAt(col, cx / nv, cy / nv, cz / nv, true);
    nv = W.length / 3;
    if (!o.nb) {
      for (let i = 0; i < nv; i++) {
        const y = W[i * 3 + 1];
        if (y > this.bMaxY) this.bMaxY = y;
        if (y < this.bMinY) this.bMinY = y;
        const r = Math.hypot(W[i * 3], W[i * 3 + 2]);
        if (r > this.bMaxR) this.bMaxR = r;
      }
    }
    const base = this.nv;
    const Pw = this.P, Nw = this.N, Cw = this.C;
    const p0 = Pw.length;
    const alpha = this.alpha;
    const noAo = o.ao === false;
    for (let i = 0; i < nv; i++) {
      const wx = W[i * 3], wy = W[i * 3 + 1], wz = W[i * 3 + 2];
      let r, g, b, al = a;
      if (fn) { r = CA[i * 4]; g = CA[i * 4 + 1]; b = CA[i * 4 + 2]; al = CA[i * 4 + 3]; }
      else { r = cc[0]; g = cc[1]; b = cc[2]; }
      if (camo === 2) { const c = ctx.camoAt([r, g, b], wx, wy, wz, false); r = c[0]; g = c[1]; b = c[2]; }
      const kk = shade ? tone * (noAo ? 1 : ctx.aoAt(wy, WN[i * 3 + 1])) : 1;
      Pw.push(wx, wy, wz);
      Nw.push(WN[i * 3], WN[i * 3 + 1], WN[i * 3 + 2]);
      if (alpha) Cw.push(r * kk, g * kk, b * kk, al);
      else Cw.push(r * kk, g * kk, b * kk);
    }
    const I = this.I;
    for (let i = 0; i < F.length; i += 3) {
      const ia = F[i], ib = F[i + 1], ic = F[i + 2];
      const A = p0 + ia * 3, B = p0 + ib * 3, C = p0 + ic * 3;
      const ux = Pw[B] - Pw[A], uy = Pw[B + 1] - Pw[A + 1], uz = Pw[B + 2] - Pw[A + 2];
      const vx = Pw[C] - Pw[A], vy = Pw[C + 1] - Pw[A + 1], vz = Pw[C + 2] - Pw[A + 2];
      const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      if (gx * gx + gy * gy + gz * gz < 1e-18) continue; // degenerate
      const sx = Nw[A] + Nw[B] + Nw[C], sy = Nw[A + 1] + Nw[B + 1] + Nw[C + 1], sz = Nw[A + 2] + Nw[B + 2] + Nw[C + 2];
      if (gx * sx + gy * sy + gz * sz >= 0) I.push(base + ia, base + ib, base + ic);
      else I.push(base + ia, base + ic, base + ib);
    }
    this.nv += nv;
    return this;
  }

  // ----- hexahedron with weighted-normal chamfers -----
  // c: 8 corners, index bits = (x>0) | (y>0)<<1 | (z>0)<<2
  hexa(c, b = 0, o = {}) {
    const P = [], N = [], F = [];
    let minE = Infinity;
    const fn = [];
    for (let f = 0; f < 6; f++) {
      const q = HEX_FACES[f];
      const p0 = c[q[0]], p1 = c[q[1]], p2 = c[q[2]], p3 = c[q[3]];
      const ax = p2[0] - p0[0], ay = p2[1] - p0[1], az = p2[2] - p0[2];
      const bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;
      fn.push([nx / l, ny / l, nz / l]);
      for (let j = 0; j < 4; j++) {
        const a = c[q[j]], d = c[q[(j + 1) & 3]];
        const len = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
        if (len > 1e-6 && len < minE) minE = len;
      }
    }
    if (b > minE * 0.42) b = minE * 0.42;
    if (!(b > 0.0005)) b = 0;
    const skip = o.skip || 0; // bitmask of faces to omit (1<<faceIndex): +X,-X,+Y,-Y,+Z,-Z
    for (let f = 0; f < 6; f++) {
      const q = HEX_FACES[f], n = fn[f];
      for (let j = 0; j < 4; j++) {
        const k = c[q[j]], nx = c[q[(j + 1) & 3]], pv = c[q[(j + 3) & 3]];
        let px = k[0], py = k[1], pz = k[2];
        if (b) {
          let ax = nx[0] - px, ay = nx[1] - py, az = nx[2] - pz;
          let l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
          let bx = pv[0] - px, by = pv[1] - py, bz = pv[2] - pz;
          l = Math.hypot(bx, by, bz) || 1; bx /= l; by /= l; bz /= l;
          px += b * (ax + bx); py += b * (ay + by); pz += b * (az + bz);
        }
        P.push(px, py, pz); N.push(n[0], n[1], n[2]);
      }
      if (!(skip & (1 << f))) F.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
    }
    if (b) {
      const seen = new Map();
      const vmap = new Int32Array(48).fill(-1);
      for (let f = 0; f < 6; f++) {
        const q = HEX_FACES[f];
        for (let j = 0; j < 4; j++) vmap[f * 8 + q[j]] = f * 4 + j;
      }
      for (let f = 0; f < 6; f++) {
        const q = HEX_FACES[f];
        for (let j = 0; j < 4; j++) {
          const k1 = q[j], k2 = q[(j + 1) & 3];
          const key = k1 < k2 ? k1 * 8 + k2 : k2 * 8 + k1;
          const g = seen.get(key);
          if (g === undefined) seen.set(key, f);
          else {
            const a1 = vmap[f * 8 + k1], a2 = vmap[f * 8 + k2], b1 = vmap[g * 8 + k1], b2 = vmap[g * 8 + k2];
            F.push(a2, a1, b1, a2, b1, b2);
          }
        }
      }
      for (let k = 0; k < 8; k++) {
        const t = [];
        for (let f = 0; f < 6; f++) if (vmap[f * 8 + k] >= 0) t.push(vmap[f * 8 + k]);
        if (t.length === 3) F.push(t[0], t[1], t[2]);
      }
    }
    return this.emit(P, N, F, o);
  }

  /**
   * Chamfered box centred at (cx,cy,cz). opts: b (bevel), c (colour), rot [ry,rz,rx],
   * warp(p, sx, sy, sz) to move corners (p is the corner relative to the centre), skip (face mask).
   */
  box(cx, cy, cz, sx, sy, sz, o = {}) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const md = Math.min(sx, sy, sz);
    const mx = Math.max(sx, sy, sz);
    let b = o.b ?? clamp(md * 0.14, 0.005, 0.028);
    // tiny parts never get chamfers (invisible at RTS scale, 44 vs 12 triangles)
    if (this.ctx.hi ? (mx < 0.14 || md < 0.035) : (mx < 0.45 || md < 0.1)) b = 0;
    const c = [];
    for (let i = 0; i < 8; i++) {
      const s0 = i & 1 ? 1 : -1, s1 = i & 2 ? 1 : -1, s2 = i & 4 ? 1 : -1;
      const p = [s0 * hx, s1 * hy, s2 * hz];
      if (o.warp) o.warp(p, s0, s1, s2);
      c.push(p);
    }
    if (o.rot) {
      this.push().translate(cx, cy, cz);
      if (o.rot[0]) this.rotY(o.rot[0]);
      if (o.rot[1]) this.rotZ(o.rot[1]);
      if (o.rot[2]) this.rotX(o.rot[2]);
      this.hexa(c, b, o);
      return this.pop();
    }
    for (const p of c) { p[0] += cx; p[1] += cy; p[2] += cz; }
    return this.hexa(c, b, o);
  }

  /** Tapered box: bottom face sx*sz, top face tx*tz shifted by (ox,oz). */
  tbox(cx, cy, cz, sx, sy, sz, tx, tz, o = {}) {
    const ox = o.ox || 0, oz = o.oz || 0;
    const kx = tx / sx, kz = tz / sz;
    return this.box(cx, cy, cz, sx, sy, sz, {
      ...o,
      warp: (p, s0, s1) => { if (s1 > 0) { p[0] = p[0] * kx + ox; p[2] = p[2] * kz + oz; } },
    });
  }

  // ----- bevelled prism (extruded 2D profile) -----
  // axis 'z': profile [x,y] extruded along z.   axis 'y': profile [x,z] extruded along y.
  // axis 'x': profile [z,y] extruded along x.
  // opts: b / b0 / b1 bevel, s0/s1 [su,sv] end scales about `pivot`, o0/o1 end offsets,
  //       crease (deg, smooth the profile), cap0/cap1 (false to omit)
  prism(axis, profile, w0, w1, o = {}) {
    let pr = profile;
    if (area2(pr) < 0) pr = pr.slice().reverse();
    const n = pr.length;
    if (w1 < w0) { const t = w0; w0 = w1; w1 = t; }
    let minE = Infinity;
    for (let i = 0; i < n; i++) { const q = pr[(i + 1) % n]; const l = Math.hypot(q[0] - pr[i][0], q[1] - pr[i][1]); if (l > 1e-5 && l < minE) minE = l; }
    const hi = this.ctx.hi;
    let bb = o.b ?? clamp(Math.min(minE, w1 - w0) * 0.14, 0.005, 0.028);
    if (!hi && o.b === undefined) bb = 0;
    let b0 = o.b0 ?? bb, b1 = o.b1 ?? bb;
    const lim = Math.min(minE * 0.4, (w1 - w0) * 0.4);
    b0 = Math.min(b0, lim); b1 = Math.min(b1, lim);
    let pv = o.pivot;
    if (!pv) {
      let ax = 0, ay = 0;
      for (const q of pr) { ax += q[0]; ay += q[1]; }
      pv = [ax / n, ay / n];
    }
    const xf = (s, off) => pr.map((q) => [pv[0] + (q[0] - pv[0]) * (s ? s[0] : 1) + (off ? off[0] : 0), pv[1] + (q[1] - pv[1]) * (s ? s[1] : 1) + (off ? off[1] : 0)]);
    const A0 = xf(o.s0, o.o0), A1 = xf(o.s1, o.o1);
    const I0 = inset2(A0, b0), I1 = inset2(A1, b1);
    const P = [], N = [], F = [];
    // caps
    for (let i = 0; i < n; i++) { P.push(I0[i][0], I0[i][1], w0); N.push(0, 0, -1); }
    for (let i = 0; i < n; i++) { P.push(I1[i][0], I1[i][1], w1); N.push(0, 0, 1); }
    const tri = THREE.ShapeUtils.triangulateShape(pr.map((q) => new THREE.Vector2(q[0], q[1])), []);
    if (o.cap0 !== false) for (const t of tri) F.push(t[0], t[1], t[2]);
    if (o.cap1 !== false) for (const t of tri) F.push(n + t[0], n + t[1], n + t[2]);
    // side normals
    const sn = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a0 = A0[i], c0 = A0[j], a1 = A1[i], c1 = A1[j];
      // diagonals of quad (a0,c0,c1,a1)
      const d1x = c1[0] - a0[0], d1y = c1[1] - a0[1], d1z = (w1 - b1) - (w0 + b0);
      const d2x = a1[0] - c0[0], d2y = a1[1] - c0[1], d2z = d1z;
      let nx = d1y * d2z - d1z * d2y, ny = d1z * d2x - d1x * d2z, nz = d1x * d2y - d1y * d2x;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const ex = pr[j][0] - pr[i][0], ey = pr[j][1] - pr[i][1];
      if (nx * ey - ny * ex < 0) { nx = -nx; ny = -ny; nz = -nz; }
      sn.push([nx, ny, nz]);
    }
    const cosC = Math.cos((o.crease ?? 0) * DEG);
    const useCrease = (o.crease ?? 0) > 0;
    const vn = (i, edge) => {
      // normal at profile vertex i as seen from edge `edge` (i or i-1)
      if (!useCrease) return sn[edge];
      const p = (i + n - 1) % n;
      const a = sn[p], b = sn[i];
      if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] >= cosC) {
        const x = a[0] + b[0], y = a[1] + b[1], z = a[2] + b[2], l = Math.hypot(x, y, z) || 1;
        return [x / l, y / l, z / l];
      }
      return sn[edge];
    };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const na = vn(i, i), nb = vn(j, i);
      const v = P.length / 3;
      P.push(A0[i][0], A0[i][1], w0 + b0); N.push(na[0], na[1], na[2]);
      P.push(A0[j][0], A0[j][1], w0 + b0); N.push(nb[0], nb[1], nb[2]);
      P.push(A1[j][0], A1[j][1], w1 - b1); N.push(nb[0], nb[1], nb[2]);
      P.push(A1[i][0], A1[i][1], w1 - b1); N.push(na[0], na[1], na[2]);
      if (!(o.skipEdge && o.skipEdge(i))) F.push(v, v + 1, v + 2, v, v + 2, v + 3);
      if (b0 > 0 && o.cap0 !== false) F.push(i, j, v + 1, i, v + 1, v);
      if (b1 > 0 && o.cap1 !== false) F.push(n + i, n + j, v + 2, n + i, v + 2, v + 3);
    }
    // map (u,v,w) -> xyz
    if (axis === 'y') {
      for (let i = 0; i < P.length; i += 3) {
        const v = P[i + 1], w = P[i + 2]; P[i + 1] = w; P[i + 2] = v;
        const nv = N[i + 1], nw = N[i + 2]; N[i + 1] = nw; N[i + 2] = nv;
      }
    } else if (axis === 'x') {
      for (let i = 0; i < P.length; i += 3) {
        const u = P[i], w = P[i + 2]; P[i] = w; P[i + 2] = u;
        const nu = N[i], nw = N[i + 2]; N[i] = nw; N[i + 2] = nu;
      }
    }
    return this.emit(P, N, F, o);
  }
  prismZ(profileXY, z0, z1, o) { return this.prism('z', profileXY, z0, z1, o); }
  prismY(profileXZ, y0, y1, o) { return this.prism('y', profileXZ, y0, y1, o); }
  prismX(profileZY, x0, x1, o) { return this.prism('x', profileZY, x0, x1, o); }

  // ----- general loft through rings of equal vertex count -----
  // rings: [[ [x,y,z], ... ], ...].  opts: crease (deg), cap0, cap1, closed, colors (per-ring colour array)
  loft(rings, o = {}) {
    const m = rings.length, n = rings[0].length;
    const closed = o.closed !== false;
    const ni = closed ? n : n - 1;
    const cosC = Math.cos((o.crease ?? 35) * DEG);
    // ring centroids
    const cen = rings.map((r) => {
      let x = 0, y = 0, z = 0;
      for (const p of r) { x += p[0]; y += p[1]; z += p[2]; }
      return [x / n, y / n, z / n];
    });
    const fnrm = new Array((m - 1) * n).fill(null);
    // Quad normals come out consistently oriented (all outward or all inward) from the ring
    // winding; a single global sign, voted by area against the ring centroids, fixes them.
    let vote = 0;
    for (let j = 0; j < m - 1; j++) {
      const r0 = rings[j], r1 = rings[j + 1];
      const mx = (cen[j][0] + cen[j + 1][0]) / 2, my = (cen[j][1] + cen[j + 1][1]) / 2, mz = (cen[j][2] + cen[j + 1][2]) / 2;
      for (let i = 0; i < ni; i++) {
        const i2 = (i + 1) % n;
        const a = r0[i], b = r0[i2], c = r1[i2], d = r1[i];
        const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2];
        const vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-10) continue;
        const fx = (a[0] + b[0] + c[0] + d[0]) / 4 - mx, fy = (a[1] + b[1] + c[1] + d[1]) / 4 - my, fz = (a[2] + b[2] + c[2] + d[2]) / 4 - mz;
        vote += nx * fx + ny * fy + nz * fz;
        fnrm[j * n + i] = [nx / l, ny / l, nz / l];
      }
    }
    if ((vote < 0) !== !!o.flip) for (const f of fnrm) if (f) { f[0] = -f[0]; f[1] = -f[1]; f[2] = -f[2]; }
    const P = [], N = [], F = [], CI = [];
    const dd = new Map();
    const colors = o.colors;
    const corner = (j, i, fj, fi) => {
      const me = fnrm[fj * n + fi];
      let nx = 0, ny = 0, nz = 0;
      for (let dj = -1; dj <= 0; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= m - 1) continue;
        for (let di = -1; di <= 0; di++) {
          let ii = i + di;
          if (ii < 0) { if (!closed) continue; ii += n; }
          if (ii >= ni) { if (!closed) continue; ii -= n; }
          const f = fnrm[jj * n + ii];
          if (!f) continue;
          if (f[0] * me[0] + f[1] * me[1] + f[2] * me[2] >= cosC) { nx += f[0]; ny += f[1]; nz += f[2]; }
        }
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const key = j + '_' + i + '_' + Math.round(nx * 50) + '_' + Math.round(ny * 50) + '_' + Math.round(nz * 50);
      let v = dd.get(key);
      if (v === undefined) {
        v = P.length / 3;
        const p = rings[j][i];
        P.push(p[0], p[1], p[2]); N.push(nx, ny, nz);
        if (colors) CI.push(j);
        dd.set(key, v);
      }
      return v;
    };
    for (let j = 0; j < m - 1; j++) {
      for (let i = 0; i < ni; i++) {
        if (!fnrm[j * n + i]) continue;
        const i2 = (i + 1) % n;
        const a = corner(j, i, j, i), b = corner(j, i2, j, i), c = corner(j + 1, i2, j, i), d = corner(j + 1, i, j, i);
        F.push(a, b, c, a, c, d);
      }
    }
    const cap = (j, other) => {
      const r = rings[j];
      // skip degenerate rings
      let ext = 0;
      for (const p of r) ext = Math.max(ext, Math.hypot(p[0] - cen[j][0], p[1] - cen[j][1], p[2] - cen[j][2]));
      if (ext < 1e-6) return;
      // Newell normal
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < n; i++) {
        const p = r[i], q = r[(i + 1) % n];
        nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]);
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const ox = cen[j][0] - cen[other][0], oy = cen[j][1] - cen[other][1], oz = cen[j][2] - cen[other][2];
      if (nx * ox + ny * oy + nz * oz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const v0 = P.length / 3;
      P.push(cen[j][0], cen[j][1], cen[j][2]); N.push(nx, ny, nz);
      if (colors) CI.push(j);
      for (let i = 0; i < n; i++) { P.push(r[i][0], r[i][1], r[i][2]); N.push(nx, ny, nz); if (colors) CI.push(j); }
      for (let i = 0; i < n; i++) F.push(v0, v0 + 1 + i, v0 + 1 + ((i + 1) % n));
    };
    if (o.cap0 !== false && closed) cap(0, 1);
    if (o.cap1 !== false && closed) cap(m - 1, m - 2);
    if (colors) return this.emit(P, N, F, { ...o, c: (x, y, z, i) => colors[CI[i]] });
    return this.emit(P, N, F, o);
  }

  /**
   * Surface of revolution. pts: [[t, r], ...] along `axis` through `at`.
   * opts: seg, crease, ry/rz (elliptical scale of the two radial axes), cap0/cap1, arc [a0,a1]
   */
  lathe(axis, pts, o = {}) {
    const seg = o.seg ?? this.ctx.seg(10);
    const at = o.at || [0, 0, 0];
    const k1 = o.k1 ?? 1, k2 = o.k2 ?? 1;
    const rings = pts.map(([t, r]) => {
      const ring = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * TAU + (o.phase || 0);
        const u = Math.cos(a) * r * k1, v = Math.sin(a) * r * k2;
        if (axis === 'x') ring.push([at[0] + t, at[1] + u, at[2] + v]);
        else if (axis === 'y') ring.push([at[0] + v, at[1] + t, at[2] + u]);
        else ring.push([at[0] + u, at[1] + v, at[2] + t]);
      }
      return ring;
    });
    return this.loft(rings, { crease: 50, ...o });
  }

  /** Cylinder along X from x0 to x1. opts: r2 (end radius), b (rim bevel), seg */
  cylX(x0, x1, y, z, r, o = {}) { return this._cyl('x', x0, x1, [0, y, z], r, o); }
  cylY(x, y0, y1, z, r, o = {}) { return this._cyl('y', y0, y1, [x, 0, z], r, o); }
  cylZ(x, y, z0, z1, r, o = {}) { return this._cyl('z', z0, z1, [x, y, 0], r, o); }
  _cyl(axis, t0, t1, at, r, o) {
    const r2 = o.r2 ?? r;
    let b = o.b ?? 0;
    if (!this.ctx.hi && Math.min(r, r2) < 0.12) b = 0;
    b = Math.min(b, Math.min(r, r2) * 0.5, Math.abs(t1 - t0) * 0.4);
    const pts = b > 0
      ? [[t0, r - b], [t0 + b, r], [t1 - b, r2], [t1, r2 - b]]
      : [[t0, r], [t1, r2]];
    return this.lathe(axis, pts, { ...o, at, crease: o.crease ?? 60 });
  }

  /** Cylinder between two arbitrary points. */
  pipe(p0, p1, r, o = {}) {
    _v1.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const len = _v1.length();
    if (len < 1e-6) return this;
    _q.setFromUnitVectors(_X, _v1.normalize());
    this.push();
    this.M.multiply(_t.compose(_v2.set(p0[0], p0[1], p0[2]), _q, _v1.set(1, 1, 1)));
    this.cylX(0, len, 0, 0, r, { seg: this.ctx.seg(6), ...o });
    return this.pop();
  }

  /** Box-section beam between two points (cheap strut for lattices). */
  beam(p0, p1, w, o = {}) {
    _v1.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const len = _v1.length();
    if (len < 1e-6) return this;
    _q.setFromUnitVectors(_X, _v1.normalize());
    this.push();
    this.M.multiply(_t.compose(_v2.set(p0[0], p0[1], p0[2]), _q, _v1.set(1, 1, 1)));
    this.box(len / 2, 0, 0, len, w, o.w2 ?? w, { b: 0, ...o });
    return this.pop();
  }

  /** Ellipsoid. opts: s [sx,sy,sz] radii scale, seg, rings, y0/y1 latitude clip in [-1,1] (dome = y0:0) */
  sphere(cx, cy, cz, r, o = {}) {
    const seg = o.seg ?? this.ctx.seg(10);
    const nr = o.rings ?? Math.max(3, Math.round(seg / 2));
    const s = o.s || [1, 1, 1];
    const y0 = o.y0 ?? -1, y1 = o.y1 ?? 1;
    const a0 = Math.asin(y0), a1 = Math.asin(y1);
    const pts = [];
    for (let i = 0; i <= nr; i++) {
      const a = a0 + ((a1 - a0) * i) / nr;
      pts.push([Math.sin(a) * r, Math.max(0, Math.cos(a) * r)]);
    }
    this.push().translate(cx, cy, cz).scale(s[0], s[1], s[2]);
    this.lathe(o.axis || 'y', pts, { seg, crease: 80, ...o, at: [0, 0, 0] });
    return this.pop();
  }

  torus(cx, cy, cz, R, r, o = {}) {
    const g = new THREE.TorusGeometry(R, r, o.tube ?? this.ctx.seg(5), o.seg ?? this.ctx.seg(12), o.arc ?? TAU);
    this.push().translate(cx, cy, cz);
    if (o.axis === 'y' || !o.axis) this.rotX(Math.PI / 2);
    else if (o.axis === 'x') this.rotY(Math.PI / 2);
    this.addGeometry(g, o);
    g.dispose();
    return this.pop();
  }

  addGeometry(g, o = {}) {
    const P = Array.from(g.attributes.position.array);
    const N = Array.from(g.attributes.normal.array);
    let F;
    if (g.index) F = Array.from(g.index.array);
    else { F = []; for (let i = 0; i < P.length / 3; i++) F.push(i); }
    return this.emit(P, N, F, o);
  }

  /** Flat polygon (fan) with explicit normal n (defaults to +Y). */
  poly(pts, o = {}) {
    const n = o.n || [0, 1, 0];
    const P = [], N = [], F = [];
    for (const p of pts) { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); }
    for (let i = 1; i < pts.length - 1; i++) F.push(0, i, i + 1);
    return this.emit(P, N, F, { ao: false, tone: false, ...o });
  }

  /** Horizontal rectangle marking at height y (yaw ry). */
  decal(cx, y, cz, sx, sz, o = {}) {
    const hx = sx / 2, hz = sz / 2;
    if (o.ry) {
      this.push().translate(cx, y, cz).rotY(o.ry);
      this.poly([[-hx, 0, -hz], [-hx, 0, hz], [hx, 0, hz], [hx, 0, -hz]], o);
      return this.pop();
    }
    return this.poly([[cx - hx, y, cz - hz], [cx - hx, y, cz + hz], [cx + hx, y, cz + hz], [cx + hx, y, cz - hz]], o);
  }

  /** Flat disc / ring marking facing +Y. */
  disc(cx, y, cz, r, o = {}) {
    const seg = o.seg ?? this.ctx.seg(16);
    const r0 = o.r0 || 0;
    const P = [], N = [], F = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU;
      P.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r); N.push(0, 1, 0);
      P.push(cx + Math.cos(a) * r0, y, cz + Math.sin(a) * r0); N.push(0, 1, 0);
    }
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      F.push(i * 2, j * 2, j * 2 + 1);
      if (r0 > 0) F.push(i * 2, j * 2 + 1, i * 2 + 1);
    }
    return this.emit(P, N, F, { ao: false, tone: false, ...o });
  }

  /**
   * Faceted body lofted along X through trapezoid-ish stations.
   * station: { x, y0, y1, w0 (bottom half width), w1 (top half width), ws/ys (optional shoulder
   * half-width and height), z (lateral centre), ch (top chamfer) }
   */
  xloft(st, o = {}) {
    const rings = [];
    const ch0 = o.ch ?? 0.02;
    const eb = o.endBevel ?? 0;
    const mk = (s, shrink, dx) => {
      const z = s.z || 0;
      const w0 = Math.max(0.001, s.w0 - shrink), w1 = Math.max(0.001, s.w1 - shrink);
      const y0 = s.y0 + shrink * 0.6, y1 = s.y1 - shrink * 0.6;
      const ch = Math.min(s.ch ?? ch0, w1 * 0.6, (y1 - y0) * 0.4);
      const r = [];
      const hasS = s.ws !== undefined;
      const ws = hasS ? Math.max(0.001, s.ws - shrink) : 0, ys = hasS ? s.ys : 0;
      // CCW seen from +X: start bottom-right(+z), up the +z side, across the top, down -z side
      r.push([s.x + dx, y0, z + w0]);
      if (hasS) r.push([s.x + dx, ys, z + ws]);
      if (ch > 0) {
        const sx = hasS ? ws : w0, sy = hasS ? ys : y0;
        // direction up the side
        const dy = y1 - sy, dz = w1 - sx, l = Math.hypot(dy, dz) || 1;
        r.push([s.x + dx, y1 - (ch * dy) / l, z + w1 - (ch * dz) / l]);
        r.push([s.x + dx, y1, z + w1 - ch]);
        r.push([s.x + dx, y1, z - w1 + ch]);
        r.push([s.x + dx, y1 - (ch * dy) / l, z - w1 + (ch * dz) / l]);
      } else {
        r.push([s.x + dx, y1, z + w1]);
        r.push([s.x + dx, y1, z - w1]);
      }
      if (hasS) r.push([s.x + dx, ys, z - ws]);
      r.push([s.x + dx, y0, z - w0]);
      return r;
    };
    const n = st.length;
    if (eb > 0) rings.push(mk(st[0], eb, 0));
    for (let i = 0; i < n; i++) {
      let dx = 0;
      if (eb > 0 && i === 0) dx = st[0].x < st[n - 1].x ? eb : -eb;
      if (eb > 0 && i === n - 1) dx = st[0].x < st[n - 1].x ? -eb : eb;
      rings.push(mk(st[i], 0, dx));
    }
    if (eb > 0) rings.push(mk(st[n - 1], eb, 0));
    return this.loft(rings, { crease: 28, ...o });
  }

  // ----- finalize -----
  build(origin) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(this.P);
    if (origin && (origin[0] || origin[1] || origin[2])) {
      for (let i = 0; i < pos.length; i += 3) { pos[i] -= origin[0]; pos[i + 1] -= origin[1]; pos[i + 2] -= origin[2]; }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.N), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.C), this.cs));
    g.setIndex(new THREE.BufferAttribute(this.nv > 65535 ? new Uint32Array(this.I) : new Uint16Array(this.I), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}
