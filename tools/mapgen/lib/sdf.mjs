// Signed-distance brushes, in map-cell units. Convention: NEGATIVE inside the
// shape, positive outside, magnitude ~ distance in cells. Every brush is a
// plain function (x, y) -> number evaluated at cell centres (i + 0.5, j + 0.5).
// Only + - * / and Math.sqrt are used (bit-stable on any IEEE-754 engine).

const len = (x, y) => Math.sqrt(x * x + y * y);

export const circle = (cx, cy, r) => (x, y) => len(x - cx, y - cy) - r;

// axis-aligned ellipse (approximate distance — fine for terrain brushes)
export const ellipse = (cx, cy, rx, ry) => (x, y) => {
  const k = len((x - cx) / rx, (y - cy) / ry);
  return (k - 1) * Math.min(rx, ry);
};

// ellipse with its major axis along the unit direction (ux, uy)
export const ellipseDir = (cx, cy, rAlong, rAcross, ux, uy) => {
  const l = len(ux, uy) || 1;
  ux /= l; uy /= l;
  return (x, y) => {
    const dx = x - cx, dy = y - cy;
    const a = dx * ux + dy * uy, b = -dx * uy + dy * ux;
    const k = len(a / rAlong, b / rAcross);
    return (k - 1) * Math.min(rAlong, rAcross);
  };
};

export const box = (cx, cy, hx, hy, round = 0) => (x, y) => {
  const qx = Math.abs(x - cx) - (hx - round), qy = Math.abs(y - cy) - (hy - round);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return len(ox, oy) + Math.min(Math.max(qx, qy), 0) - round;
};

// segment a->b with radius ra at a tapering to rb at b
export const capsule = (ax, ay, bx, by, ra, rb = ra) => {
  const ex = bx - ax, ey = by - ay;
  const ee = ex * ex + ey * ey || 1e-9;
  return (x, y) => {
    let t = ((x - ax) * ex + (y - ay) * ey) / ee;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return len(x - (ax + ex * t), y - (ay + ey * t)) - (ra + (rb - ra) * t);
  };
};

// chain of capsules through [[x, y, r], ...] (r optional after the first)
export const polyline = (pts, r0) => {
  const segs = [];
  let pr = pts[0][2] !== undefined ? pts[0][2] : r0;
  for (let i = 1; i < pts.length; i++) {
    const r = pts[i][2] !== undefined ? pts[i][2] : pr;
    segs.push(capsule(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], pr, r));
    pr = r;
  }
  return (x, y) => {
    let d = Infinity;
    for (let i = 0; i < segs.length; i++) {
      const v = segs[i](x, y);
      if (v < d) d = v;
    }
    return d;
  };
};

// Catmull-Rom resample of control points [[x, y, r?], ...] into a smooth
// polyline (r is interpolated too) — for rivers, ridgelines and canyons.
export function spline(ctrl, perSeg = 8, r0 = 1) {
  const P = ctrl.map((p) => [p[0], p[1], p[2] !== undefined ? p[2] : r0]);
  const out = [];
  const at = (i) => P[Math.max(0, Math.min(P.length - 1, i))];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg, t2 = t * t, t3 = t2 * t;
      const c = (k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t
        + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
        + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push([c(0), c(1), Math.max(0.5, c(2))]);
    }
  }
  out.push(P[P.length - 1].slice());
  return out;
}

export const curve = (ctrl, r0, perSeg = 8) => polyline(spline(ctrl, perSeg, r0), r0);

// annulus: |dist - r| < halfWidth
export const ring = (cx, cy, r, halfWidth) => (x, y) => Math.abs(len(x - cx, y - cy) - r) - halfWidth;

// half-plane through (px, py); inside is the side the normal (nx, ny) points AWAY from
export const halfPlane = (px, py, nx, ny) => {
  const l = len(nx, ny) || 1;
  nx /= l; ny /= l;
  return (x, y) => (x - px) * nx + (y - py) * ny;
};

// ---- combinators -----------------------------------------------------------
export const union = (...fs) => (x, y) => {
  let d = Infinity;
  for (let i = 0; i < fs.length; i++) { const v = fs[i](x, y); if (v < d) d = v; }
  return d;
};

// polynomial smooth-min union: shapes blend over ~k cells (organic joins)
export const smoothUnion = (k, ...fs) => (x, y) => {
  let d = fs[0](x, y);
  for (let i = 1; i < fs.length; i++) {
    const v = fs[i](x, y);
    const h = Math.max(k - Math.abs(d - v), 0) / k;
    d = Math.min(d, v) - h * h * k * 0.25;
  }
  return d;
};

export const intersect = (...fs) => (x, y) => {
  let d = -Infinity;
  for (let i = 0; i < fs.length; i++) { const v = fs[i](x, y); if (v > d) d = v; }
  return d;
};

export const subtract = (a, ...bs) => (x, y) => {
  let d = a(x, y);
  for (let i = 0; i < bs.length; i++) { const v = -bs[i](x, y); if (v > d) d = v; }
  return d;
};

export const grow = (f, by) => (x, y) => f(x, y) - by;

// displace the boundary by amp * n(x, y) cells (n ~ [-1, 1])
export const rough = (f, n, amp) => (x, y) => f(x, y) + amp * n(x, y);

// domain warp: sample f at a displaced position (nx, ny ~ [-1, 1] noises)
export const warp = (f, nx, ny, amp) => (x, y) => f(x + amp * nx(x, y), y + amp * ny(x, y));

// ---- deterministic polar helpers ---------------------------------------------
// sin/cos from a Taylor series on [-45, 45] degrees + quadrant rotation: only
// basic arithmetic, so results are bit-identical on every engine (Math.sin /
// Math.cos are implementation-defined in the spec).
export function sinCosDeg(deg) {
  const a = ((deg % 360) + 360) % 360;
  const q = Math.round(a / 90);
  const r = (a - q * 90) * 0.017453292519943295;
  const r2 = r * r;
  const s = r * (1 - r2 / 6 * (1 - r2 / 20 * (1 - r2 / 42 * (1 - r2 / 72 * (1 - r2 / 110)))));
  const c = 1 - r2 / 2 * (1 - r2 / 12 * (1 - r2 / 30 * (1 - r2 / 56 * (1 - r2 / 90))));
  switch (q & 3) {
    case 0: return [s, c];
    case 1: return [c, -s];
    case 2: return [-s, -c];
    default: return [-c, s];
  }
}

// point at radius r, angle deg (0 = east, 90 = south: y grows downward)
export function polar(cx, cy, r, deg) {
  const [s, c] = sinCosDeg(deg);
  return [cx + r * c, cy + r * s];
}
