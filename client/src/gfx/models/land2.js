// Wheeled / light armour and support vehicles: IFV, APC, light vehicles, SPG, MLRS, mobile AA,
// missile TELs, MCV and harvester.

import { DEG, mixC, mulC, lerp } from './geo.js';
import {
  wheel, axlePair, gunBarrel, thinBarrel, hmg, smokeRack, antenna, hatch, grille, headlight, jerrycan,
  canister, tubeBank, tubeBundle, missile, dish, radarPanel, lattice,
} from './parts.js';
import { trackedChassis } from './land.js';

// ---------------------------------------------------------------- helpers

/** Wheels for a list of axle x-positions. Spins (own nodes) when the mesh budget allows. */
function wheels(M, hull, axles, r, w, half, spin) {
  const hi = M.ctx.hi;
  if (spin && hi) {
    axles.forEach((x, i) => {
      const g = M.part('axle' + i, { at: [x, r, 0] });
      axlePair(g, x, r, half, r, w);
      M.wheelNodes.push('axle' + i);
    });
  } else {
    for (const x of axles) for (const s of [1, -1]) wheel(hull, x, r, s * half, r, w, { side: s });
  }
  // wheel-arch shadow blocks keep the hull from floating over the tyres
  for (const x of axles) for (const s of [1, -1]) hull.box(x, r + 0.02, s * (half - w * 0.55), r * 1.5, r * 1.3, 0.03, { c: M.ctx.pal.black, camo: 0, b: 0, tone: false });
}

function glassPane(glass, x, y, z, len, h, t, ry = 0, rz = 0, rx = 0) {
  glass.at(x, y, z, () => glass.box(0, 0, 0, len, h, t, { c: glass.ctx.pal.glassD, b: 0 }), ry, rz, rx);
}

/** Team recognition panel lying on a roof. */
function roofPanel(g, x, y, z, sx, sz) {
  const { pal, hi } = g.ctx;
  g.box(x, y + 0.004, z, sx, 0.012, sz, { c: pal.team, camo: 0, b: 0.004, tone: false });
  if (hi) g.box(x, y + 0.011, z, sx * 0.26, 0.004, sz * 0.7, { c: pal.teamInk, camo: 0, b: 0, tone: false, ao: false });
}

/**
 * Small turret + gun. Coordinates are model space.
 * o: x,y,z (ring centre on the roof), kind 'drum'|'box'|'flat'|'rws', r, h, gun {len, r, y, z, twin, evac},
 *    atgm 'side'|'top'|'both'|'twin', panel (team roof panel), mg
 */
function miniTurret(M, o) {
  const { pal, hi } = M.ctx;
  const T = M.part('turret', { at: [o.x, o.y, o.z || 0] }).camo(1);
  M.turretNode = 'turret';
  const r = o.r, h = o.h, z0 = o.z || 0;
  T.push().translate(o.x, o.y, z0);
  if (o.kind === 'drum') {
    T.lathe('y', [[0, r], [h * 0.75, r * 0.9], [h, r * 0.72], [h, 0]], { seg: M.ctx.seg(10), camo: 2, crease: 40, cap0: false, tess: 0 });
  } else if (o.kind === 'flat') {
    T.lathe('y', [[0, r * 1.02], [h * 0.45, r], [h, r * 0.62], [h, 0]], { seg: M.ctx.seg(12), camo: 2, crease: 40, cap0: false, tess: 0 });
  } else if (o.kind === 'rws') {
    T.cylY(0, 0, 0.04, 0, r * 0.7, { seg: 8, c: pal.gun, camo: 0 });
    T.box(-0.02, 0.04 + h / 2, 0, r * 2.0, h, r * 1.3, { camo: 1, b: 0.014 });
    T.box(r * 0.3, 0.04 + h * 0.6, -r * 0.95, r * 0.9, h * 0.7, r * 0.5, { c: mulC(pal.base, 0.82), camo: 0, b: 0.01 });
    T.box(r * 0.8, 0.04 + h * 0.6, -r * 0.95, 0.01, h * 0.4, r * 0.3, { c: pal.glassD, camo: 0, b: 0, tone: false });
  } else {
    T.xloft([
      { x: -r * 1.15, y0: 0, y1: h, w0: r * 0.92, w1: r * 0.8 },
      { x: r * 0.5, y0: 0, y1: h, w0: r, w1: r * 0.84 },
      { x: r * 1.15, y0: 0, y1: h * 0.72, w0: r * 0.62, w1: r * 0.46 },
    ], { camo: 2, ch: 0.014, endBevel: 0.008, tess: 0 });
  }
  const topY = o.kind === 'rws' ? 0.04 + h : h;
  if (o.panel !== false) roofPanel(T, -r * 0.35, topY, 0, r * 0.7, r * 0.9);
  if (o.kind !== 'rws') hatch(T, -r * 0.1, topY, r * 0.42, Math.min(0.07, r * 0.36));
  if (hi && o.kind !== 'rws') T.box(r * 0.45, topY + 0.025, -r * 0.4, 0.07, 0.05, 0.07, { c: mulC(pal.base, 0.82), camo: 0, b: 0.008 });
  if (o.smoke !== false) for (const s of [1, -1]) smokeRack(T, r * 0.3, h * 0.55, s * (r * (o.kind === 'box' ? 1.0 : 0.95) + 0.02), 3, s);
  if (o.atgm === 'side' || o.atgm === 'both' || o.atgm === 'twin') {
    const sides = o.atgm === 'side' ? [1] : [1, -1];
    for (const s of sides) {
      T.box(-r * 0.1, h * 0.7, s * (r + 0.05), 0.3, 0.12, 0.09, { camo: 1, b: 0.012 });
      T.box(0.052 - r * 0.1 + 0.1, h * 0.7, s * (r + 0.05), 0.012, 0.09, 0.07, { c: pal.black, camo: 0, b: 0, tone: false });
      M.muzzle(o.x + 0.06, o.y + h * 0.7, z0 + s * (r + 0.05), 'turret');
    }
  }
  if (o.atgm === 'top') {
    canister(T, -r * 0.6, r * 0.5, topY + 0.07, r * 0.2, 0.035, { ribs: 1 });
    T.box(-r * 0.1, topY + 0.02, r * 0.2, 0.05, 0.04, 0.04, { c: pal.gun, camo: 0, b: 0 });
    M.muzzle(o.x + r * 0.5, o.y + topY + 0.07, z0 + r * 0.2, 'turret');
  }
  if (o.mg) hmg(T, 0, topY, -r * 0.5, { s: 0.85 });
  if (o.antenna !== false) antenna(T, -r * 0.85, topY - 0.01, -r * 0.5, 0.36, { flag: true });
  T.pop();
  // gun
  const G = o.gun;
  if (G) {
    const gy = o.y + (G.y ?? h * 0.5), gx = o.x + (G.x ?? r * (o.kind === 'box' ? 1.1 : 0.9));
    const B = M.part('barrel', { at: [gx, gy, z0 + (G.z || 0)], parent: 'turret' });
    M.barrelNode = 'barrel';
    B.box(gx - 0.02, gy, z0 + (G.z || 0), 0.1, G.r * 5.5, G.twin ? G.twin * 2 + G.r * 6 : G.r * 6, { c: mulC(pal.base, 0.8), camo: 0, b: 0.012 });
    const zs = G.twin ? [G.twin, -G.twin] : [0];
    for (const dz of zs) {
      const mx = G.r > 0.02
        ? gunBarrel(B, gx, { len: G.len, r: G.r, y: gy, z: z0 + (G.z || 0) + dz, evac: G.evac || 0, sleeve: false, brake: G.brake })
        : thinBarrel(B, gx, G.len, gy, z0 + (G.z || 0) + dz, G.r, { seg: 6 });
      M.muzzle(mx, gy, z0 + (G.z || 0) + dz, 'barrel');
    }
    if (G.coax) {
      const mx = thinBarrel(B, gx, G.coax.len, gy + (G.coax.y || 0), z0 + G.coax.z, G.coax.r, { seg: 6 });
      M.muzzle(mx, gy + (G.coax.y || 0), z0 + G.coax.z, 'barrel');
    }
  }
  return T;
}

// ---------------------------------------------------------------- IFV / APC

function ifvSpec(def) {
  const n = def.name || '';
  const apc = def.cls === 'APC';
  // defaults: tracked box
  const S = { tracked: true, L: 1.7, W: 0.9, top: 0.6, n: 6, r: 0.075, th: 0.29, drive: 'front', nose: 0.5, noseY: 0.36, roofW: 0.36, turret: null, tx: -0.05, skirt: false };
  if (/Bradley/i.test(n)) Object.assign(S, { L: 1.72, W: 0.94, top: 0.66, nose: 0.52, turret: 'bradley', tx: -0.02, skirt: true });
  else if (/BMP-3/i.test(n)) Object.assign(S, { L: 1.74, W: 0.92, top: 0.52, nose: 0.62, noseY: 0.34, turret: 'bmp3', tx: -0.08, drive: 'rear' });
  else if (/Rabdan/i.test(n)) Object.assign(S, { tracked: false, axles: 4, L: 1.84, W: 0.9, top: 0.64, turret: 'bmp3', tx: -0.3, boat: true });
  else if (/BMP-2/i.test(n)) Object.assign(S, { L: 1.68, W: 0.88, top: 0.5, nose: 0.66, noseY: 0.33, turret: 'bmp2', tx: -0.1, kornet: /Kornet/i.test(n), sarath: /Sarath/i.test(n) });
  else if (/Eitan/i.test(n)) Object.assign(S, { tracked: false, axles: 4, L: 1.9, W: 0.94, top: 0.7, turret: 'rws30', tx: -0.12 });
  else if (/YPR|BMP-1/i.test(n)) Object.assign(S, { L: 1.6, W: 0.86, top: 0.56, nose: 0.5, turret: 'drum25', tx: 0.02 });
  else if (/ACV|Pars/i.test(n)) Object.assign(S, { L: 1.62, W: 0.88, top: 0.58, nose: 0.46, turret: 'box25', tx: -0.02 });
  else if (/Namer/i.test(n)) Object.assign(S, { L: 1.94, W: 1.04, top: 0.58, n: 6, r: 0.088, th: 0.34, nose: 0.86, noseY: 0.4, roofW: 0.44, turret: 'rwsmg', tx: 0.1, skirt: 'heavy', heavy: true });
  else if (/Fahd/i.test(n)) Object.assign(S, { tracked: false, axles: 2, L: 1.5, W: 0.82, top: 0.72, turret: 'cupola', tx: -0.05, truckNose: true });
  else if (/Fuchs/i.test(n)) Object.assign(S, { tracked: false, axles: 3, L: 1.7, W: 0.86, top: 0.7, turret: 'cupola', tx: 0.05, boat: true });
  else if (/M113|Talha/i.test(n)) Object.assign(S, { L: 1.5, W: 0.86, top: 0.6, n: 5, nose: 0.3, noseY: 0.42, roofW: 0.4, turret: 'cupola', tx: 0.12 });
  else if (/Boragh/i.test(n)) Object.assign(S, { L: 1.58, W: 0.86, top: 0.54, n: 6, nose: 0.52, noseY: 0.34, turret: 'cupola', tx: 0.0 });
  else if (apc) Object.assign(S, { tracked: false, axles: 4, L: 1.7, W: 0.86, top: 0.66, turret: 'cupola' });
  else Object.assign(S, { turret: 'drum25' });
  return S;
}

export function buildAFV(M, def) {
  const { pal, hi } = M.ctx;
  const S = ifvSpec(def);
  const hull = M.part('hull').camo(1);
  const hl = S.L / 2, hw = S.W / 2, top = S.top;
  let yF;
  if (S.tracked) {
    ({ yF } = trackedChassis(hull, { L: S.L, W: S.W, tw: 0.17, th: S.th, n: S.n, r: S.r, drive: S.drive, rs: 0.065 }));
    // upper hull: fender line to roof, sloped glacis
    const rw = S.roofW;
    hull.xloft([
      { x: -hl, y0: yF, y1: top - 0.03, w0: hw, w1: rw },
      { x: -hl + 0.06, y0: yF, y1: top, w0: hw, w1: rw },
      { x: hl - S.nose, y0: yF, y1: top, w0: hw, w1: rw },
      { x: hl - 0.04, y0: yF, y1: S.noseY + 0.02, w0: hw, w1: hw - 0.04 },
      { x: hl, y0: yF, y1: S.noseY - 0.02, w0: hw - 0.01, w1: hw - 0.05 },
    ], { camo: 2, ch: 0.018 });
    if (S.skirt) {
      const heavy = S.skirt === 'heavy';
      const n = 5, x0 = -hl + 0.16, x1 = hl - 0.12, seg = (x1 - x0) / n;
      for (const s of [1, -1]) for (let i = 0; i < n; i++) {
        const team = i === 1;
        hull.box(x0 + seg * (i + 0.5), yF - 0.045, s * (hw + 0.008), seg - 0.012, heavy ? 0.17 : 0.13, heavy ? 0.035 : 0.02, { c: team ? pal.team : pal.base, camo: team ? 0 : 2, b: 0.006, tone: !team });
      }
    } else {
      for (const s of [1, -1]) hull.box(-hl * 0.4, yF + 0.03, s * (hw + 0.004), 0.3, 0.05, 0.012, { c: pal.team, camo: 0, b: 0.003, tone: false });
    }
    M.exhaust(hl - S.nose + 0.1, top, -hw + 0.12);
    if (S.drive === 'front') grille(hull, hl - S.nose - 0.1, top, -hw * 0.45, 0.22, 0.2, 5);
    else grille(hull, -hl + 0.2, top, 0, 0.22, hw * 1.2, 5);
  } else {
    // wheeled
    const na = S.axles;
    const wr = na === 2 ? 0.15 : 0.14, ww = 0.12;
    const ax = na === 4 ? [-0.58, -0.2, 0.22, 0.6].map((v) => v * (S.L / 1.84)) : na === 3 ? [-0.52, -0.02, 0.5] : [-0.42, 0.44];
    wheels(M, hull, ax, wr, ww, hw - ww / 2, na <= 2);
    const yb = 0.17, ys = wr * 2 + 0.045;
    yF = ys;
    const rw = hw - 0.1;
    const nose = S.truckNose ? 0.34 : 0.46;
    const st = [
      { x: -hl, y0: yb + 0.08, y1: top - 0.05, w0: hw - 0.19, ws: hw - 0.02, ys, w1: rw },
      { x: -hl + 0.08, y0: yb, y1: top, w0: hw - 0.17, ws: hw, ys, w1: rw },
      { x: hl - nose, y0: yb, y1: top, w0: hw - 0.17, ws: hw, ys, w1: rw },
    ];
    if (S.truckNose) {
      st.push({ x: hl - nose + 0.14, y0: yb, y1: top - 0.2, w0: hw - 0.17, ws: hw, ys, w1: rw });
      st.push({ x: hl - 0.03, y0: yb + 0.02, y1: top - 0.24, w0: hw - 0.17, ws: hw - 0.02, ys, w1: rw - 0.02 });
      st.push({ x: hl, y0: yb + 0.06, y1: ys + 0.03, w0: hw - 0.2, ws: hw - 0.04, ys: ys - 0.02, w1: rw - 0.04 });
    } else {
      st.push({ x: hl - 0.12, y0: yb + (S.boat ? 0.06 : 0.02), y1: ys + 0.1, w0: hw - 0.19, ws: hw - 0.03, ys: ys - 0.01, w1: rw - 0.04 });
      st.push({ x: hl, y0: ys - 0.08, y1: ys + 0.02, w0: hw - 0.24, ws: hw - 0.1, ys: ys - 0.03, w1: hw - 0.14 });
    }
    hull.xloft(st, { camo: 2, ch: 0.018 });
    for (const s of [1, -1]) hull.box(-hl * 0.35, ys + 0.09, s * (hw - 0.012), 0.34, 0.07, 0.012, { c: pal.team, camo: 0, b: 0.003, tone: false, rot: [0, 0, s * -0.3] });
    M.exhaust(-hl + 0.3, ys + 0.1, hw);
    hull.box(-hl + 0.3, ys + 0.1, hw - 0.01, 0.2, 0.05, 0.04, { c: pal.gun, camo: 0, b: 0.008 });
    if (S.truckNose) {
      const glass = M.part('hull', { mat: 'glass' });
      glassPane(glass, hl - nose + 0.075, top - 0.105, 0, 0.2, 0.006, (rw - 0.04) * 2, 0, -0.96);
      for (const s of [1, -1]) glassPane(glass, hl - nose - 0.12, top - 0.12, s * (rw + 0.012), 0.16, 0.1, 0.006, 0, 0, s * 0.25);
    } else if (hi) {
      // driver's vision blocks
      for (const s of [1, -1]) hull.box(hl - nose + 0.05, top - 0.03, s * 0.16, 0.02, 0.035, 0.12, { c: pal.glassD, camo: 0, b: 0, tone: false });
    }
  }
  // appliqué side armour panels + vision blocks on the sloped upper flanks
  {
    const rwTop = S.tracked ? S.roofW : hw - 0.1;
    const sideH = top - yF, slope = Math.atan2(hw - rwTop, sideH);
    const x1 = hl - (S.tracked ? S.nose : (S.truckNose ? 0.34 : 0.46)) - 0.04, x0 = -hl + 0.1;
    const n = 3, pl = (x1 - x0) / n;
    for (const s of [1, -1]) for (let i = 0; i < n; i++) {
      const cx = x0 + pl * (i + 0.5);
      hull.box(cx, yF + sideH * 0.5, s * ((hw + rwTop) / 2 + 0.006), pl - 0.03, sideH * 0.66, 0.02, { camo: 1, b: 0.006, rot: [0, 0, -s * slope], toneAmt: 0.09 });
      if (hi && i > 0) hull.box(cx, yF + sideH * 0.74, s * ((hw + rwTop) / 2 - (hw - rwTop) * 0.24 + 0.018), 0.09, 0.03, 0.012, { c: pal.glassD, camo: 0, b: 0, rot: [0, 0, -s * slope], tone: false });
    }
    if (hi) hull.beam([x0 + 0.1, yF + sideH * 0.2, hw - (hw - rwTop) * 0.2 + 0.02], [x0 + 0.5, yF + sideH * 0.2, hw - (hw - rwTop) * 0.2 + 0.02], 0.016, { c: pal.wood }); // pioneer tool
  }
  // common details
  for (const s of [1, -1]) headlight(hull, hl - 0.03, (S.tracked ? S.noseY : yF) + 0.035, s * (hw - 0.16));
  hull.box(-hl + 0.07, top + 0.004, 0, 0.07, 0.012, S.roofW ? S.roofW * 1.7 : (hw - 0.1) * 1.7, { c: pal.team, camo: 0, b: 0.003, tone: false });
  // rear ramp / door
  hull.box(-hl - 0.004, (yF + top) / 2 - 0.02, 0, 0.016, (top - yF) * 0.7, hw * 0.9, { c: mulC(pal.base, 0.84), camo: 0, b: 0.006 });
  // roof hatches (troop compartment)
  const roofHalf = S.tracked ? S.roofW : hw - 0.1;
  for (const s of [1, -1]) hull.box(-hl + 0.34, top + 0.006, s * roofHalf * 0.5, 0.3, 0.012, roofHalf * 0.7, { c: mulC(pal.base, 0.9), camo: 1, b: 0.005 });
  hatch(hull, hl - (S.tracked ? S.nose : 0.5) - 0.06, top, hw * 0.45, 0.075);
  if (hi) { jerrycan(hull, -hl + 0.05, yF + 0.02, hw * 0.75); hull.box(-0.1, top + 0.03, roofHalf - 0.06, 0.26, 0.05, 0.1, { c: pal.canvas, camo: 0, b: 0.02 }); }

  // turret
  const tx = S.tx, t = S.turret;
  if (t === 'bradley') {
    miniTurret(M, { x: tx, y: top, kind: 'box', r: 0.27, h: 0.2, atgm: 'side', gun: { len: 0.62, r: 0.013, y: 0.1, coax: { len: 0.2, r: 0.007, z: -0.07 } } });
  } else if (t === 'bmp3') {
    miniTurret(M, { x: tx, y: top, kind: 'flat', r: 0.3, h: 0.14, gun: { len: 0.72, r: 0.024, y: 0.07, coax: { len: 0.62, r: 0.011, z: -0.07 } } });
  } else if (t === 'bmp2') {
    miniTurret(M, { x: tx, y: top, kind: 'flat', r: 0.27, h: 0.13, atgm: S.kornet ? 'both' : 'top', gun: { len: 0.72, r: 0.012, y: 0.07 } });
  } else if (t === 'rws30') {
    miniTurret(M, { x: tx, y: top, kind: 'box', r: 0.24, h: 0.17, smoke: true, atgm: 'side', gun: { len: 0.66, r: 0.014, y: 0.09 } });
  } else if (t === 'drum25') {
    miniTurret(M, { x: tx, y: top, kind: 'drum', r: 0.2, h: 0.14, gun: { len: 0.5, r: 0.012, y: 0.08 } });
  } else if (t === 'box25') {
    miniTurret(M, { x: tx, y: top, kind: 'box', r: 0.2, h: 0.16, gun: { len: 0.55, r: 0.012, y: 0.09 } });
  } else if (t === 'rwsmg') {
    miniTurret(M, { x: tx, y: top, kind: 'rws', r: 0.11, h: 0.1, smoke: false, panel: false, gun: { len: 0.3, r: 0.009, y: 0.1, x: 0.1 } });
    roofPanel(hull, -0.3, top, 0, 0.3, 0.4);
  } else {
    // commander's cupola with shielded HMG
    const T = M.part('turret', { at: [tx, top, 0] }).camo(1);
    M.turretNode = 'turret';
    T.lathe('y', [[top, 0.13], [top + 0.045, 0.125], [top + 0.06, 0.1], [top + 0.06, 0]], { at: [tx, 0, 0], seg: M.ctx.seg(10), camo: 1, crease: 40, cap0: false });
    hatch(T, tx - 0.03, top + 0.06, 0, 0.07);
    T.box(tx + 0.1, top + 0.13, 0, 0.014, 0.13, 0.26, { camo: 1, b: 0.004, rot: [0, 0.14, 0] });
    for (const s of [1, -1]) T.box(tx + 0.03, top + 0.12, s * 0.135, 0.14, 0.11, 0.012, { camo: 1, b: 0.004 });
    const B = M.part('barrel', { at: [tx + 0.08, top + 0.13, 0], parent: 'turret' });
    M.barrelNode = 'barrel';
    B.box(tx + 0.07, top + 0.13, 0, 0.14, 0.04, 0.035, { c: pal.gun, camo: 0, b: 0.004 });
    const mx = thinBarrel(B, tx + 0.13, 0.22, top + 0.132, 0, 0.008, { seg: 5 });
    M.muzzle(mx, top + 0.132, 0, 'barrel');
    roofPanel(hull, -0.42, top, 0, 0.26, 0.34);
    antenna(hull, -hl + 0.14, top, -roofHalf + 0.05, 0.36, { flag: true });
  }
  return { kind: 'vehicle', radius: hl * 1.02 };
}

// ---------------------------------------------------------------- light vehicles

export function buildLightVehicle(M, def, o = {}) {
  const { pal, hi } = M.ctx;
  const n = def.name || '';
  const mrap = /M-ATV|Kirpi|MRAP/i.test(n);
  const kirpi = /Kirpi/i.test(n);
  const avenger = o.avenger;
  const L = kirpi ? 1.46 : mrap ? 1.36 : 1.3, W = kirpi ? 0.74 : 0.7;
  const wr = kirpi ? 0.16 : mrap ? 0.15 : 0.135, ww = 0.11;
  const hl = L / 2, hw = W / 2;
  const hull = M.part('hull').camo(1);
  const glass = M.part('hull', { mat: 'glass' });
  const ax = [-hl + 0.26, hl - 0.26];
  const meshBudgetSpin = !avenger;
  wheels(M, hull, ax, wr, ww, hw - ww / 2, meshBudgetSpin);
  const yb = wr + 0.04, ys = wr * 2 + 0.03;
  const top = kirpi ? 0.82 : mrap ? 0.76 : 0.64;
  const hood = ys + (mrap ? 0.14 : 0.1);
  const cabF = hl - (kirpi ? 0.5 : mrap ? 0.44 : 0.46); // windshield base x
  const cabR = avenger ? -0.02 : (mrap ? -hl + 0.04 : -hl + 0.34); // rear of the cab
  const rw = hw - 0.07;
  const st = [];
  if (!mrap || avenger) {
    // open cargo bed / shelter deck behind the cab
    st.push({ x: -hl, y0: yb + 0.05, y1: ys + 0.1, w0: hw - 0.17, ws: hw - 0.01, ys, w1: hw - 0.01 });
    st.push({ x: cabR - 0.005, y0: yb, y1: ys + 0.1, w0: hw - 0.17, ws: hw, ys, w1: hw - 0.01 });
    st.push({ x: cabR, y0: yb, y1: top, w0: hw - 0.17, ws: hw, ys, w1: rw });
  } else {
    st.push({ x: -hl, y0: yb + 0.08, y1: top - 0.06, w0: hw - 0.17, ws: hw - 0.01, ys, w1: rw });
    st.push({ x: -hl + 0.08, y0: yb, y1: top, w0: hw - 0.17, ws: hw, ys, w1: rw });
  }
  st.push({ x: cabF - 0.17, y0: yb, y1: top, w0: hw - 0.17, ws: hw, ys, w1: rw });
  st.push({ x: cabF, y0: yb, y1: hood + 0.02, w0: hw - 0.17, ws: hw, ys, w1: hw - 0.05 });
  st.push({ x: hl - 0.05, y0: yb, y1: hood - 0.03, w0: hw - 0.17, ws: hw - 0.01, ys, w1: hw - 0.08 });
  st.push({ x: hl, y0: yb + 0.04, y1: ys + 0.03, w0: hw - 0.19, ws: hw - 0.03, ys: ys - 0.02, w1: hw - 0.1 });
  hull.xloft(st, { camo: 2, ch: 0.018 });
  // windshield + side windows
  const wsLen = Math.hypot(0.17, top - hood - 0.02);
  const wsAng = Math.atan2(-(top - hood - 0.02), 0.17);
  glassPane(glass, cabF - 0.085 + 0.006, (top + hood + 0.02) / 2 + 0.004, 0, wsLen * 0.82, 0.006, (rw - 0.02) * 1.85, 0, wsAng);
  const sideLen = Math.min(0.34, cabF - 0.2 - cabR);
  for (const s of [1, -1]) {
    const zy = (hw + rw) / 2 + 0.014;
    glassPane(glass, cabF - 0.2 - sideLen / 2, top - 0.1, s * (rw + 0.02), sideLen, 0.09, 0.006, 0, 0, s * 0.2);
    void zy;
  }
  // grille, bumper, lights
  hull.box(hl + 0.004, ys + 0.03, 0, 0.012, 0.08, hw * 1.1, { c: pal.black, camo: 0, b: 0, tone: false });
  hull.box(hl + 0.02, yb + 0.03, 0, 0.05, 0.05, W * 0.92, { c: pal.gun, camo: 0, b: 0.01 });
  for (const s of [1, -1]) headlight(hull, hl + 0.004, ys + 0.03, s * (hw - 0.09), 0.024);
  hull.box(-hl - 0.015, yb + 0.03, 0, 0.04, 0.05, W * 0.9, { c: pal.gun, camo: 0, b: 0.008 });
  M.exhaust(-hl, yb + 0.02, hw * 0.6);
  // team markings: hood stripe + door panels
  hull.box(hl - 0.24, hood + 0.0, 0, 0.1, 0.012, hw * 1.5, { c: pal.team, camo: 0, b: 0.003, tone: false, rot: [0, -0.1, 0] });
  for (const s of [1, -1]) hull.box(cabF - 0.34, ys + 0.07, s * (hw - 0.004), 0.22, 0.09, 0.012, { c: pal.team, camo: 0, b: 0.003, tone: false });
  if (hi) {
    hull.cylZ(-hl - 0.04, ys + 0.06, -0.05, 0.05, wr * 0.8, { c: pal.tyre, seg: 10, b: 0.02, camo: 0 }); // spare
    jerrycan(hull, -hl + 0.06, ys + 0.1, hw - 0.05);
  }
  if (avenger) return { hull, glass, top, hl, hw, ys, cabR };
  // weapon station
  const tx = mrap ? -0.1 : -hl + 0.22, ty = mrap ? top : ys + 0.1;
  const T = M.part('turret', { at: [tx, ty, 0] }).camo(1);
  M.turretNode = 'turret';
  if (mrap) {
    // armoured gunner's turret ring
    T.lathe('y', [[ty, 0.15], [ty + 0.03, 0.15], [ty + 0.03, 0.12], [ty, 0.12]], { at: [tx, 0, 0], seg: M.ctx.seg(10), camo: 0, c: pal.gun, crease: 40, cap0: false, cap1: false });
    T.box(tx + 0.13, ty + 0.11, 0, 0.014, 0.16, 0.3, { camo: 1, b: 0.004, rot: [0, 0.16, 0] });
    for (const s of [1, -1]) T.box(tx + 0.0, ty + 0.1, s * 0.16, 0.26, 0.14, 0.012, { camo: 1, b: 0.004 });
    if (hi) for (const s of [1, -1]) T.box(tx + 0.02, ty + 0.13, s * 0.167, 0.1, 0.05, 0.004, { c: pal.glassD, camo: 0, b: 0, tone: false });
    T.box(tx - 0.13, ty + 0.1, 0, 0.012, 0.14, 0.3, { camo: 1, b: 0.004 });
    T.box(tx, ty + 0.18, 0, 0.14, 0.012, 0.2, { c: pal.team, camo: 0, b: 0.003, tone: false });
  } else {
    // pedestal mount in the bed, standing gunner shield
    T.cylY(tx, ty, ty + 0.2, 0, 0.022, { seg: 6, c: pal.gun, camo: 0 });
    T.box(tx + 0.08, ty + 0.25, 0, 0.012, 0.14, 0.22, { camo: 1, b: 0.004, rot: [0, 0.16, 0] });
    hull.box(-hl + 0.2, ys + 0.2, 0, 0.3, 0.012, hw * 1.7, { c: pal.gun, camo: 0, b: 0 }); // roll bar
    for (const s of [1, -1]) hull.cylY(-hl + 0.34, ys + 0.1, ys + 0.34, s * (hw - 0.05), 0.012, { seg: 5, c: pal.gun, camo: 0 });
    hull.box(-hl + 0.34, ys + 0.34, 0, 0.024, 0.024, W - 0.1, { c: pal.gun, camo: 0, b: 0 });
    roofPanel(hull, cabF - 0.32, top, 0, 0.24, hw * 1.2);
  }
  const by = ty + (mrap ? 0.12 : 0.26), bx = tx + 0.06;
  const B = M.part('barrel', { at: [bx, by, 0], parent: 'turret' });
  M.barrelNode = 'barrel';
  B.box(bx + 0.0, by, 0, 0.14, 0.04, 0.035, { c: pal.gun, camo: 0, b: 0.004 });
  B.box(bx - 0.02, by - 0.01, 0.04, 0.07, 0.055, 0.035, { c: mulC(pal.base, 0.6), camo: 0, b: 0 });
  const mx = thinBarrel(B, bx + 0.06, 0.24, by + 0.002, 0, 0.008, { seg: 5 });
  M.muzzle(mx, by, 0, 'barrel');
  if (mrap) { roofPanel(hull, cabF - 0.3, top, 0, 0.16, hw * 1.1); antenna(hull, -hl + 0.1, top - 0.01, -rw + 0.04, 0.4, { flag: true }); }
  else antenna(hull, cabR + 0.04, top - 0.01, -rw + 0.04, 0.4, { flag: true });
  return { kind: 'vehicle', radius: hl * 1.05 };
}

// ---------------------------------------------------------------- trucks

/**
 * Military truck: ladder frame, wheels and cab. Returns { deckY, cabRear, hl, hw }.
 * T: { L, W, axles[], wr, cab: 'cabover'|'bonnet'|'armored'|'twin', cabLen, cabH }
 */
function truck(M, hull, glass, T) {
  const { pal, hi } = M.ctx;
  const hl = T.L / 2, hw = T.W / 2, wr = T.wr, ww = 0.12;
  wheels(M, hull, T.axles, wr, ww, hw - ww / 2, false);
  const fy = wr + 0.07; // frame centre
  hull.box(-0.02, fy, 0, T.L - 0.1, 0.09, T.W * 0.44, { c: pal.under, camo: 0, b: 0.012 });
  const deckY = wr * 2 + 0.05;
  // mudguards
  for (const x of T.axles) for (const s of [1, -1]) hull.box(x, wr * 2 + 0.02, s * (hw - 0.07), wr * 2.3, 0.02, 0.14, { c: mulC(pal.base, 0.7), camo: 0, b: 0.006 });
  // fuel tank + toolbox between axle groups
  if (hi && T.axles.length >= 3) {
    const xm = (T.axles[0] + T.axles[1]) / 2;
    if (Math.abs(T.axles[0] - T.axles[1]) > wr * 3.2) {
      hull.cylX(xm - 0.12, xm + 0.12, wr + 0.03, hw - 0.12, 0.075, { c: mulC(pal.base, 0.75), seg: 8, b: 0.012, camo: 0 });
      hull.box(xm, wr + 0.03, -hw + 0.12, 0.22, 0.13, 0.13, { c: mulC(pal.base, 0.75), camo: 0, b: 0.012 });
    }
  }
  // cab
  const cl = T.cabLen ?? 0.5, ch = T.cabH ?? 0.42;
  const x1 = hl, x0 = hl - cl;
  const y0 = wr + 0.1, yt = deckY + ch;
  const cw = hw - 0.02;
  const style = T.cab || 'cabover';
  const pane = (x, y, z, len, h, t, ry, rz, rx) => glassPane(glass, x, y, z, len, h, t, ry, rz, rx);
  if (style === 'bonnet') {
    const hx = x1 - 0.36; // windshield base
    hull.xloft([
      { x: x0, y0, y1: yt, w0: cw, w1: cw - 0.03 },
      { x: hx - 0.14, y0, y1: yt, w0: cw, w1: cw - 0.03 },
      { x: hx, y0, y1: deckY + ch * 0.48, w0: cw, w1: cw - 0.07 },
      { x: x1 - 0.03, y0, y1: deckY + ch * 0.42, w0: cw - 0.07, w1: cw - 0.11 },
      { x: x1, y0: y0 + 0.03, y1: deckY + ch * 0.34, w0: cw - 0.08, w1: cw - 0.12 },
    ], { camo: 2, ch: 0.018 });
    const dy = yt - (deckY + ch * 0.48);
    pane(hx - 0.07 + 0.004, yt - dy / 2 + 0.004, 0, Math.hypot(0.14, dy) * 0.8, 0.006, (cw - 0.05) * 1.8, 0, Math.atan2(-dy, 0.14));
    for (const s of [1, -1]) pane(hx - 0.26, yt - 0.1, s * (cw - 0.012), 0.18, 0.1, 0.006);
    hull.box(x1 + 0.004, deckY + ch * 0.2, 0, 0.012, 0.13, cw * 1.2, { c: pal.black, camo: 0, b: 0, tone: false });
    for (const s of [1, -1]) headlight(hull, x1 - 0.02, deckY + ch * 0.2, s * (cw - 0.04), 0.026);
  } else if (style === 'twin') {
    // MAZ-style twin cabs flanking the load
    for (const s of [1, -1]) {
      hull.xloft([
        { x: x0, y0, y1: yt, w0: 0.14, w1: 0.12, z: s * (hw - 0.15) },
        { x: x1 - 0.14, y0, y1: yt, w0: 0.14, w1: 0.12, z: s * (hw - 0.15) },
        { x: x1 - 0.01, y0, y1: deckY + ch * 0.46, w0: 0.14, w1: 0.13, z: s * (hw - 0.15) },
        { x: x1, y0: y0 + 0.02, y1: deckY + ch * 0.4, w0: 0.135, w1: 0.125, z: s * (hw - 0.15) },
      ], { camo: 2, ch: 0.014 });
      const dy = yt - (deckY + ch * 0.46);
      pane(x1 - 0.075 + 0.004, yt - dy / 2 + 0.003, s * (hw - 0.15), Math.hypot(0.13, dy) * 0.78, 0.006, 0.22, 0, Math.atan2(-dy, 0.13));
      pane(x1 - 0.3, yt - 0.1, s * (hw - 0.012), 0.16, 0.09, 0.006);
      headlight(hull, x1, deckY + 0.02, s * (hw - 0.15), 0.026);
    }
    hull.box((x0 + x1) / 2, y0 + 0.06, 0, cl, 0.14, T.W - 0.5, { c: mulC(pal.base, 0.8), camo: 0, b: 0.012 });
    hull.box(x1 + 0.01, y0 + 0.0, 0, 0.04, 0.08, T.W * 0.96, { c: pal.gun, camo: 0, b: 0.01 });
  } else {
    const arm = style === 'armored';
    const slope = arm ? 0.2 : 0.11;
    hull.xloft([
      { x: x0, y0, y1: yt, w0: cw, w1: cw - (arm ? 0.06 : 0.02) },
      { x: x1 - slope, y0, y1: yt, w0: cw, w1: cw - (arm ? 0.06 : 0.02) },
      { x: x1 - 0.012, y0, y1: deckY + ch * (arm ? 0.44 : 0.5), w0: cw, w1: cw - 0.03 },
      { x: x1, y0: y0 + 0.02, y1: deckY + ch * (arm ? 0.38 : 0.46), w0: cw - 0.01, w1: cw - 0.04 },
    ], { camo: 2, ch: 0.018 });
    const dy = yt - (deckY + ch * (arm ? 0.44 : 0.5));
    const wl = Math.hypot(slope - 0.012, dy);
    if (arm) {
      for (const s of [1, -1]) pane(x1 - slope / 2 + 0.0, yt - dy / 2 + 0.004, s * cw * 0.46, wl * 0.62, 0.006, cw * 0.66, 0, Math.atan2(-dy, slope - 0.012));
      for (const s of [1, -1]) pane(x1 - slope - 0.12, yt - 0.1, s * (cw - 0.035), 0.13, 0.08, 0.006, 0, 0, s * 0.22);
    } else {
      pane(x1 - slope / 2 - 0.002, yt - dy / 2 + 0.004, 0, wl * 0.8, 0.006, (cw - 0.03) * 1.86, 0, Math.atan2(-dy, slope - 0.012));
      for (const s of [1, -1]) pane(x1 - slope - 0.13, yt - 0.1, s * (cw - 0.006), 0.17, 0.1, 0.006);
    }
    hull.box(x1 + 0.004, deckY + ch * 0.17, 0, 0.012, 0.11, cw * 1.3, { c: pal.black, camo: 0, b: 0, tone: false });
    for (const s of [1, -1]) headlight(hull, x1 - 0.0, deckY - 0.01, s * (cw - 0.08), 0.026);
    hull.box(x1 + 0.02, y0 + 0.0, 0, 0.05, 0.07, T.W * 0.96, { c: pal.gun, camo: 0, b: 0.01 });
  }
  // cab roof team panel + exhaust stack
  if (style !== 'twin') roofPanel(hull, x0 + cl * 0.42, yt, 0, cl * 0.42, cw * 1.2);
  else for (const s of [1, -1]) hull.box(x0 + cl * 0.45, yt + 0.004, s * (hw - 0.15), cl * 0.4, 0.012, 0.16, { c: pal.team, camo: 0, b: 0.003, tone: false });
  hull.cylY(x0 - 0.04, deckY, yt + 0.02, -hw + 0.09, 0.022, { seg: 6, c: pal.gun, camo: 0 });
  M.exhaust(x0 - 0.04, yt + 0.03, -hw + 0.09);
  return { deckY, cabRear: x0, hl, hw, yt };
}

/** Flat load bed / subframe from x0..x1 at deck height. */
function bed(hull, x0, x1, deckY, w, o = {}) {
  const { pal } = hull.ctx;
  hull.box((x0 + x1) / 2, deckY + 0.025, 0, x1 - x0, 0.05, w, { c: o.c || mulC(pal.base, 0.82), camo: 0, b: 0.01 });
}

function stabilisers(hull, xs, hw, y) {
  const { pal, hi } = hull.ctx;
  if (!hi) return;
  for (const x of xs) for (const s of [1, -1]) {
    hull.box(x, y, s * (hw - 0.02), 0.06, 0.06, 0.08, { c: pal.gun, camo: 0, b: 0.008 });
    hull.cylY(x, 0.05, y, s * (hw + 0.0), 0.018, { seg: 5, c: pal.steel, camo: 0 });
    hull.cylY(x, 0.0, 0.03, s * hw, 0.05, { seg: 6, c: pal.gun, camo: 0 });
  }
}

// ---------------------------------------------------------------- SPG

export function buildSPG(M, def) {
  const { pal, hi } = M.ctx;
  const n = def.name || '';
  const range = def.range || 14;
  const hull = M.part('hull').camo(1);
  const len = 0.5 + range * 0.055;
  const elev = 14 * DEG;
  if (/CAESAR|SH-15|Truck gun/i.test(n + ' ' + def.role)) {
    // truck-mounted 155 on an open rear platform
    const glass = M.part('hull', { mat: 'glass' });
    const t = truck(M, hull, glass, { L: 1.96, W: 0.76, axles: [0.62, -0.36, -0.68], wr: 0.145, cab: 'armored', cabLen: 0.56, cabH: 0.4 });
    bed(hull, -t.hl, t.cabRear - 0.04, t.deckY, 0.74);
    stabilisers(hull, [-t.hl + 0.04], t.hw, t.deckY - 0.02);
    // ammo racks behind the cab
    hull.box(t.cabRear - 0.2, t.deckY + 0.17, 0, 0.3, 0.24, 0.66, { camo: 1, b: 0.016 });
    if (hi) for (let i = 0; i < 4; i++) hull.cylY(t.cabRear - 0.2, t.deckY + 0.29, t.deckY + 0.33, -0.24 + i * 0.16, 0.04, { c: pal.missileG, seg: 6, camo: 0 });
    hull.box(-t.hl + 0.02, t.deckY + 0.02, 0, 0.1, 0.1, 0.5, { c: pal.gun, camo: 0, b: 0.012 }); // rear spade
    const tx = -0.55, ty = t.deckY + 0.05;
    const T = M.part('turret', { at: [tx, ty, 0] }).camo(1);
    M.turretNode = 'turret';
    T.cylY(tx, ty, ty + 0.06, 0, 0.17, { seg: M.ctx.seg(10), c: pal.gun, b: 0.01, camo: 0 });
    for (const s of [1, -1]) T.prismZ([[tx - 0.16, ty + 0.06], [tx + 0.14, ty + 0.06], [tx + 0.08, ty + 0.3], [tx - 0.08, ty + 0.3]], s * 0.1 - 0.02, s * 0.1 + 0.02, { camo: 1, b: 0.006 });
    T.box(tx - 0.12, ty + 0.22, -0.18, 0.12, 0.14, 0.06, { c: mulC(pal.base, 0.8), camo: 0, b: 0.01 });
    T.box(tx, ty + 0.064, 0, 0.2, 0.012, 0.22, { c: pal.team, camo: 0, b: 0.003, tone: false });
    const by = ty + 0.24, bx = tx;
    const B = M.part('barrel', { at: [bx, by, 0], parent: 'turret' });
    M.barrelNode = 'barrel';
    B.at(bx, by, 0, () => {
      B.box(0.02, 0, 0, 0.42, 0.11, 0.13, { c: mulC(pal.base, 0.85), camo: 0, b: 0.016 });
      for (const s of [1, -1]) B.cylX(0.1, 0.5, 0.075, s * 0.04, 0.02, { c: pal.steel, seg: 6, camo: 0 });
      gunBarrel(B, 0.2, { len: len + 0.25, r: 0.027, evac: 0, brake: 'slot', sleeve: false });
    }, 0, elev);
    const ml = 0.2 + len + 0.25;
    M.muzzle(bx + Math.cos(elev) * ml, by + Math.sin(elev) * ml, 0, 'barrel');
    antenna(hull, t.cabRear + 0.06, t.yt, 0.24, 0.4, { flag: true });
    return { kind: 'vehicle', radius: t.hl * 1.05 };
  }
  const wheeled = /G6|Rhino/i.test(n);
  const small = /2S1|Gvozdika|Raad|M-46/i.test(n);
  let top, hl, hw, yF;
  if (wheeled) {
    // G6: 6x6 armoured hull, turret at the rear
    const L = 2.0, W = 0.92;
    hl = L / 2; hw = W / 2;
    const wr = 0.17, ww = 0.14;
    wheels(M, hull, [0.52, -0.3, -0.7], wr, ww, hw - ww / 2, false);
    const yb = 0.2, ys = wr * 2 + 0.03;
    top = 0.62; yF = ys;
    hull.xloft([
      { x: -hl, y0: yb + 0.06, y1: top - 0.03, w0: hw - 0.2, ws: hw - 0.01, ys, w1: hw - 0.08 },
      { x: -hl + 0.08, y0: yb, y1: top, w0: hw - 0.2, ws: hw, ys, w1: hw - 0.08 },
      { x: 0.2, y0: yb, y1: top, w0: hw - 0.2, ws: hw, ys, w1: hw - 0.08 },
      { x: 0.42, y0: yb, y1: top - 0.02, w0: hw - 0.22, ws: hw - 0.08, ys, w1: hw - 0.2 },
      { x: hl - 0.1, y0: yb + 0.02, y1: ys + 0.14, w0: 0.16, ws: 0.22, ys: ys + 0.0, w1: 0.16 },
      { x: hl, y0: ys - 0.08, y1: ys + 0.04, w0: 0.1, ws: 0.16, ys: ys - 0.02, w1: 0.12 },
    ], { camo: 2, ch: 0.02 });
    const glass = M.part('hull', { mat: 'glass' });
    glassPane(glass, 0.56, top - 0.08, 0, 0.16, 0.006, 0.28, 0, -0.75);
    for (const s of [1, -1]) headlight(hull, hl - 0.06, ys + 0.1, s * 0.14);
    M.exhaust(0.1, top, hw - 0.1);
    grille(hull, 0.06, top, 0, 0.24, 0.4, 5);
  } else {
    const F = small ? { L: 1.74, W: 0.92, th: 0.28, n: 7, r: 0.07, drive: 'front', rs: 0.06 } : { L: 1.9, W: 1.0, th: 0.31, n: 6, r: 0.085, drive: 'front', rs: 0.07 };
    F.tw = 0.18;
    hl = F.L / 2; hw = F.W / 2;
    ({ yF } = trackedChassis(hull, F));
    top = small ? 0.46 : 0.52;
    hull.xloft([
      { x: -hl, y0: yF, y1: top - 0.02, w0: hw, w1: hw - 0.03 },
      { x: -hl + 0.05, y0: yF, y1: top, w0: hw, w1: hw - 0.03 },
      { x: hl - 0.62, y0: yF, y1: top, w0: hw, w1: hw - 0.03 },
      { x: hl - 0.04, y0: yF, y1: yF + 0.08, w0: hw, w1: hw - 0.03 },
      { x: hl, y0: yF, y1: yF + 0.05, w0: hw - 0.01, w1: hw - 0.04 },
    ], { camo: 2, ch: 0.02 });
    grille(hull, hl - 0.75, top, -hw * 0.4, 0.2, 0.3, 5);
    M.exhaust(hl - 0.75, top + 0.02, -hw + 0.08);
    hatch(hull, hl - 0.72, top, hw * 0.45, 0.08);
    for (const s of [1, -1]) headlight(hull, hl - 0.2, yF + 0.2, s * (hw - 0.14));
    for (const s of [1, -1]) hull.box(-hl * 0.3, yF + 0.03, s * (hw + 0.004), 0.32, 0.05, 0.012, { c: pal.team, camo: 0, b: 0.003, tone: false });
    // travel lock on the glacis
    if (hi) { for (const s of [1, -1]) hull.beam([hl - 0.3, yF + 0.22, s * 0.1], [hl - 0.24, top + 0.16, s * 0.03], 0.02, { c: pal.gun }); }
    // rear spade
    hull.box(-hl - 0.03, yF + 0.02, 0, 0.04, 0.12, hw * 1.5, { c: pal.gun, camo: 0, b: 0.01 });
  }
  hull.box(-hl + 0.05, top + 0.004, 0, 0.06, 0.012, (hw - 0.05) * 1.7, { c: pal.team, camo: 0, b: 0.003, tone: false });
  // big slab-sided turret toward the rear
  const tx = wheeled ? -0.42 : small ? -0.2 : -0.36, ty = top;
  const T = M.part('turret', { at: [tx, ty, 0] }).camo(1);
  M.turretNode = 'turret';
  const tl = small ? 0.4 : 0.52, tw = small ? 0.36 : hw - 0.07, thh = small ? 0.2 : 0.34;
  T.push().translate(tx, ty, 0);
  T.xloft([
    { x: -tl, y0: 0.0, y1: thh, w0: tw, w1: tw - 0.04 },
    { x: tl * 0.5, y0: 0.0, y1: thh, w0: tw, w1: tw - 0.04 },
    { x: tl, y0: 0.0, y1: thh * 0.8, w0: tw * 0.72, w1: tw * 0.6 },
  ], { camo: 2, ch: 0.022, endBevel: 0.012 });
  T.box(-tl * 0.3, thh + 0.004, 0, tl * 0.7, 0.012, tw * 1.0, { c: pal.team, camo: 0, b: 0.004, tone: false });
  if (hi) T.box(-tl * 0.3, thh + 0.011, 0, tl * 0.2, 0.004, tw * 0.7, { c: pal.teamInk, camo: 0, b: 0, tone: false, ao: false });
  T.lathe('y', [[thh - 0.005, 0.1], [thh + 0.04, 0.095], [thh + 0.05, 0.07], [thh + 0.05, 0]], { at: [0.1, 0, -tw * 0.5], seg: M.ctx.seg(8), camo: 1, crease: 40, cap0: false });
  hmg(T, 0.14, thh + 0.05, -tw * 0.5, { s: 0.9 });
  hatch(T, 0.1, thh, tw * 0.5, 0.075);
  if (!small) {
    T.box(-tl - 0.07, thh * 0.5, 0, 0.14, thh * 0.7, tw * 1.5, { c: mulC(pal.base, 0.85), camo: 1, b: 0.016 }); // bustle basket
    for (const s of [1, -1]) T.box(-tl * 0.3, thh * 0.55, s * (tw + 0.03), tl * 0.9, thh * 0.5, 0.05, { c: mulC(pal.base, 0.88), camo: 1, b: 0.012 });
  }
  T.box(tl + 0.0, thh * 0.45, 0, 0.12, thh * 0.62, 0.24, { c: mulC(pal.base, 0.82), camo: 0, b: 0.024 }); // mantlet
  antenna(T, -tl + 0.06, thh, tw - 0.08, 0.42, { flag: true });
  T.pop();
  const bx = tx + tl + 0.02, by = ty + thh * 0.47;
  const B = M.part('barrel', { at: [bx, by, 0], parent: 'turret' });
  M.barrelNode = 'barrel';
  const blen = len + (small ? -0.1 : 0.12);
  B.at(bx, by, 0, () => {
    gunBarrel(B, 0, { len: blen, r: small ? 0.023 : 0.03, evac: small ? 0.5 : 0.56, brake: 'slot', sleeve: false });
  }, 0, elev);
  M.muzzle(bx + Math.cos(elev) * blen, by + Math.sin(elev) * blen, 0, 'barrel');
  return { kind: 'vehicle', radius: hl * 1.05 };
}

// ---------------------------------------------------------------- MLRS

function mlrsSpec(def) {
  const n = def.name || '';
  if (/Grad/i.test(n)) return { chassis: '6x6', cab: 'bonnet', pod: 'bundle', nz: 10, ny: 4, r: 0.026, len: 0.86, elev: 22 };
  if (/M270/i.test(n)) return { chassis: 'tracked', pod: 'bank', pods: 2, nz: 3, ny: 2, w: 0.38, h: 0.3, len: 1.0, elev: 24 };
  if (/HIMARS/i.test(n)) return { chassis: '6x6', cab: 'armored', pod: 'bank', pods: 1, nz: 3, ny: 2, w: 0.52, h: 0.36, len: 1.0, elev: 26 };
  if (/TOS/i.test(n)) return { chassis: 'tank', pod: 'bank', pods: 1, nz: 8, ny: 3, w: 0.84, h: 0.34, len: 0.86, elev: 16, fill: 0.4 };
  if (/Smerch/i.test(n)) return { chassis: '8x8', cab: 'cabover', pod: 'bundle', nz: 4, ny: 3, r: 0.062, len: 1.25, elev: 20, rows: [4, 4, 4] };
  if (/Kas[ıi]rga/i.test(n)) return { chassis: '6x6', cab: 'cabover', pod: 'bundle', nz: 2, ny: 2, r: 0.085, len: 1.2, elev: 24 };
  if (/PULS|Menatetz/i.test(n)) return { chassis: '8x8', cab: 'armored', pod: 'bank', pods: 2, nz: 3, ny: 3, w: 0.36, h: 0.34, len: 0.9, elev: 26 };
  if (/Pinaka/i.test(n)) return { chassis: '8x8', cab: 'cabover', pod: 'bank', pods: 2, nz: 3, ny: 2, w: 0.38, h: 0.3, len: 1.05, elev: 24 };
  if (/Fatah|A-100/i.test(n)) return { chassis: '8x8', cab: 'cabover', pod: 'bundle', nz: 5, ny: 2, r: 0.06, len: 1.25, elev: 22 };
  if (/Fajr|Zelzal/i.test(n)) return { chassis: '6x6', cab: 'bonnet', pod: 'bundle', nz: 2, ny: 2, r: 0.085, len: 1.15, elev: 26 };
  return { chassis: '6x6', cab: 'cabover', pod: 'bank', pods: 2, nz: 3, ny: 2, w: 0.36, h: 0.3, len: 1.0, elev: 24 };
}

export function buildMLRS(M, def) {
  const { pal, hi } = M.ctx;
  const S = mlrsSpec(def);
  const hull = M.part('hull').camo(1);
  let deckY, px, hl, hw;
  if (S.chassis === 'tank' || S.chassis === 'tracked') {
    const tank = S.chassis === 'tank';
    const F = tank
      ? { L: 1.8, W: 0.96, tw: 0.2, th: 0.315, n: 6, r: 0.096, drive: 'rear', slack: true }
      : { L: 1.84, W: 0.94, tw: 0.18, th: 0.29, n: 6, r: 0.075, drive: 'front', rs: 0.065 };
    hl = F.L / 2; hw = F.W / 2;
    const { yF } = trackedChassis(hull, F);
    deckY = tank ? 0.43 : 0.44;
    if (tank) {
      hull.prismZ([[-hl, yF], [hl - 0.1, yF], [hl, yF + 0.035], [hl - 0.46, deckY], [-hl + 0.02, deckY], [-hl, deckY - 0.04]], -hw, hw, { camo: 2, b: 0.02, skipEdge: (i) => i === 0 });
      hatch(hull, hl - 0.42, deckY - 0.004, 0, 0.085);
      grille(hull, -hl + 0.2, deckY, 0, 0.16, F.W * 0.66, 4);
      M.exhaust(-hl + 0.4, yF + 0.07, hw + 0.05);
      px = -0.02;
    } else {
      // M270: armoured cab forward, flat bed behind
      hull.xloft([
        { x: -hl, y0: yF, y1: deckY, w0: hw, w1: hw - 0.02 },
        { x: 0.3, y0: yF, y1: deckY, w0: hw, w1: hw - 0.02 },
        { x: 0.32, y0: yF, y1: deckY + 0.3, w0: hw, w1: hw - 0.05 },
        { x: hl - 0.2, y0: yF, y1: deckY + 0.3, w0: hw, w1: hw - 0.05 },
        { x: hl - 0.01, y0: yF, y1: deckY + 0.06, w0: hw, w1: hw - 0.04 },
        { x: hl, y0: yF, y1: yF + 0.06, w0: hw - 0.01, w1: hw - 0.05 },
      ], { camo: 2, ch: 0.02 });
      const glass = M.part('hull', { mat: 'glass' });
      for (const k of [-1, 0, 1]) glassPane(glass, hl - 0.105, deckY + 0.185, k * 0.26, 0.2, 0.006, 0.2, 0, -0.9);
      if (hi) for (const k of [-1, 0, 1]) hull.box(hl - 0.2, deckY + 0.31, k * 0.26, 0.1, 0.012, 0.22, { c: mulC(pal.base, 0.8), camo: 0, b: 0 }); // louvre covers
      hull.box(0.56, deckY + 0.304, 0, 0.22, 0.012, 0.5, { c: pal.team, camo: 0, b: 0.003, tone: false });
      M.exhaust(0.36, deckY + 0.3, hw - 0.1);
      px = -0.34;
    }
    for (const s of [1, -1]) hull.box(-hl * 0.3, yF + 0.03, s * (hw + 0.004), 0.32, 0.05, 0.012, { c: pal.team, camo: 0, b: 0.003, tone: false });
  } else {
    const glass = M.part('hull', { mat: 'glass' });
    const eight = S.chassis === '8x8';
    const t = truck(M, hull, glass, eight
      ? { L: 2.3, W: 0.8, axles: [0.84, 0.5, -0.46, -0.8], wr: 0.15, cab: S.cab, cabLen: 0.52, cabH: 0.42 }
      : { L: 2.0, W: 0.76, axles: S.cab === 'bonnet' ? [0.7, -0.34, -0.66] : [0.64, -0.34, -0.66], wr: 0.145, cab: S.cab, cabLen: S.cab === 'bonnet' ? 0.72 : 0.5, cabH: 0.4 });
    hl = t.hl; hw = t.hw; deckY = t.deckY + 0.05;
    bed(hull, -hl, t.cabRear - 0.03, t.deckY, hw * 2 - 0.04);
    stabilisers(hull, [-hl + 0.06, t.cabRear - 0.1], hw, t.deckY - 0.02);
    px = (-hl + t.cabRear) / 2 - 0.08;
    antenna(hull, t.cabRear + 0.06, t.yt, hw - 0.1, 0.4, { flag: true });
    if (hi) hull.box(t.cabRear - 0.1, t.deckY + 0.13, 0, 0.12, 0.16, hw * 1.5, { c: mulC(pal.base, 0.8), camo: 1, b: 0.014 });
  }
  // launcher (turret = traverse, pod baked at firing elevation)
  const ty = deckY;
  const T = M.part('turret', { at: [px, ty, 0] }).camo(1);
  M.turretNode = 'turret';
  T.cylY(px, ty, ty + 0.05, 0, 0.2, { seg: M.ctx.seg(10), c: pal.gun, b: 0.01, camo: 0 });
  const elev = S.elev * DEG;
  const pivY = ty + 0.16;
  // cradle arms
  for (const s of [1, -1]) T.prismZ([[px - 0.2, ty + 0.05], [px + 0.16, ty + 0.05], [px + 0.04, pivY + 0.05], [px - 0.1, pivY + 0.05]], s * 0.2 - 0.025, s * 0.2 + 0.025, { c: mulC(pal.base, 0.8), camo: 0, b: 0.008 });
  const L = S.len;
  T.push().translate(px - 0.02, pivY, 0).rotZ(elev);
  const cx = L * 0.12; // pod centre ahead of the trunnion
  let podH, podW;
  const fronts = [];
  if (S.pod === 'bank') {
    const pods = S.pods, gapW = 0.03;
    podH = S.h; podW = pods * S.w + (pods - 1) * gapW;
    for (let p = 0; p < pods; p++) {
      const z = -podW / 2 + S.w / 2 + p * (S.w + gapW);
      tubeBank(T, cx, podH / 2 + 0.03, z, L, S.w, podH, S.nz, S.ny, { camo: 2, fill: S.fill, rear: hi, b: 0.016 });
      T.box(cx - L * 0.2, podH + 0.034, z, L * 0.36, 0.012, S.w * 0.74, { c: pal.team, camo: 0, b: 0.003, tone: false });
      fronts.push([cx + L / 2, podH / 2 + 0.03, z]);
    }
    T.box(cx, 0.0, 0, L * 0.9, 0.06, podW * 0.8, { c: mulC(pal.base, 0.75), camo: 0, b: 0.012 });
  } else {
    const d = tubeBundle(T, cx, 0.03 + S.r * 1.06 * S.ny, 0, L, S.r, S.nz, S.ny);
    podH = d.H; podW = d.W;
    T.box(cx, 0.0, 0, L * 0.86, 0.05, podW * 0.9, { c: mulC(pal.base, 0.75), camo: 0, b: 0.012 });
    T.box(cx - L * 0.1, 0.03 + podH + 0.012, 0, L * 0.3, 0.012, podW * 0.8, { c: pal.team, camo: 0, b: 0.003, tone: false });
    fronts.push([cx + L / 2, 0.03 + podH / 2, podW * 0.25], [cx + L / 2, 0.03 + podH / 2, -podW * 0.25]);
  }
  T.pop();
  const ce = Math.cos(elev), se = Math.sin(elev);
  for (const f of fronts) M.muzzle(px - 0.02 + f[0] * ce - f[1] * se, pivY + f[0] * se + f[1] * ce, f[2], 'turret');
  M.exhaust(px - 0.02 + (cx - L / 2) * ce, pivY + (cx - L / 2) * se, 0, 'turret');
  return { kind: 'vehicle', radius: hl * 1.03 };
}

// ---------------------------------------------------------------- mobile AA

export function buildMobileAA(M, def) {
  const { pal, hi } = M.ctx;
  const n = def.name || '';
  if (/Avenger/i.test(n)) {
    const v = buildLightVehicle(M, def, { avenger: true });
    const { hull, ys, hl } = v;
    const tx = -hl + 0.3, ty = ys + 0.1;
    const T = M.part('turret', { at: [tx, ty, 0] }).camo(1);
    M.turretNode = 'turret';
    T.cylY(tx, ty, ty + 0.05, 0, 0.17, { seg: M.ctx.seg(10), c: pal.gun, b: 0.01, camo: 0 });
    // gunner's cab between the two Stinger pods
    T.xloft([
      { x: tx - 0.16, y0: ty + 0.05, y1: ty + 0.36, w0: 0.11, w1: 0.09 },
      { x: tx + 0.08, y0: ty + 0.05, y1: ty + 0.36, w0: 0.11, w1: 0.09 },
      { x: tx + 0.17, y0: ty + 0.05, y1: ty + 0.2, w0: 0.11, w1: 0.1 },
    ], { camo: 2, ch: 0.014, tess: 0 });
    const glass = M.part('turret', { mat: 'glass' });
    glassPane(glass, tx + 0.13, ty + 0.285, 0, 0.17, 0.006, 0.16, 0, -1.06);
    T.box(tx - 0.04, ty + 0.364, 0, 0.16, 0.012, 0.14, { c: pal.team, camo: 0, b: 0.003, tone: false });
    for (const s of [1, -1]) {
      tubeBank(T, tx + 0.02, ty + 0.27, s * 0.22, 0.4, 0.16, 0.16, 2, 2, { camo: 1, tip: pal.missileG, b: 0.012 });
      T.box(tx, ty + 0.2, s * 0.14, 0.1, 0.06, 0.06, { c: pal.gun, camo: 0, b: 0.008 });
      M.muzzle(tx + 0.23, ty + 0.27, s * 0.22, 'turret');
    }
    hmg(T, tx + 0.02, ty + 0.12, -0.3, { s: 0.8 });
    antenna(hull, v.cabR + 0.04, v.top - 0.01, -v.hw + 0.11, 0.4, { flag: true });
    return { kind: 'vehicle', radius: hl * 1.05 };
  }
  const hull = M.part('hull').camo(1);
  let deckY, hl, hw, px;
  const tracked = /Korkut|Shilka|Tunguska|Gepard/i.test(n);
  if (tracked) {
    const F = { L: 1.72, W: 0.92, tw: 0.17, th: 0.29, n: 6, r: 0.075, drive: 'front', rs: 0.065 };
    hl = F.L / 2; hw = F.W / 2;
    const { yF } = trackedChassis(hull, F);
    deckY = 0.56;
    hull.xloft([
      { x: -hl, y0: yF, y1: deckY - 0.03, w0: hw, w1: hw - 0.08 },
      { x: -hl + 0.06, y0: yF, y1: deckY, w0: hw, w1: hw - 0.08 },
      { x: hl - 0.5, y0: yF, y1: deckY, w0: hw, w1: hw - 0.08 },
      { x: hl - 0.04, y0: yF, y1: yF + 0.08, w0: hw, w1: hw - 0.04 },
      { x: hl, y0: yF, y1: yF + 0.05, w0: hw - 0.01, w1: hw - 0.05 },
    ], { camo: 2, ch: 0.018 });
    for (const s of [1, -1]) hull.box(-hl * 0.3, yF + 0.03, s * (hw + 0.004), 0.32, 0.05, 0.012, { c: pal.team, camo: 0, b: 0.003, tone: false });
    for (const s of [1, -1]) headlight(hull, hl - 0.16, yF + 0.16, s * (hw - 0.14));
    grille(hull, hl - 0.62, deckY, -hw * 0.4, 0.2, 0.26, 5);
    M.exhaust(hl - 0.62, deckY, -hw + 0.1);
    px = -0.14;
  } else {
    const glass = M.part('hull', { mat: 'glass' });
    const eight = /Pantsir/i.test(n);
    const t = truck(M, hull, glass, eight
      ? { L: 2.2, W: 0.8, axles: [0.8, 0.46, -0.44, -0.78], wr: 0.15, cab: 'cabover', cabLen: 0.5, cabH: 0.42 }
      : { L: 2.0, W: 0.76, axles: [0.64, -0.34, -0.66], wr: 0.145, cab: /Khordad/i.test(n) ? 'cabover' : 'bonnet', cabLen: /Khordad/i.test(n) ? 0.5 : 0.7, cabH: 0.4 });
    hl = t.hl; hw = t.hw;
    bed(hull, -hl, t.cabRear - 0.03, t.deckY, hw * 2 - 0.04);
    // equipment shelter behind the cab
    hull.box(t.cabRear - 0.2, t.deckY + 0.2, 0, 0.3, 0.3, hw * 1.8, { camo: 1, b: 0.02 });
    if (hi) grille(hull, t.cabRear - 0.2, t.deckY + 0.35, 0, 0.2, 0.3, 4);
    stabilisers(hull, [-hl + 0.06, t.cabRear - 0.4], hw, t.deckY - 0.02);
    deckY = t.deckY + 0.05;
    px = (-hl + t.cabRear - 0.36) / 2;
    antenna(hull, t.cabRear + 0.06, t.yt, hw - 0.1, 0.4, { flag: true });
  }
  hull.box(-hl + 0.05, deckY + 0.004, 0, 0.06, 0.012, (hw - 0.08) * 1.7, { c: pal.team, camo: 0, b: 0.003, tone: false });
  const ty = deckY;
  const T = M.part('turret', { at: [px, ty, 0] }).camo(1);
  M.turretNode = 'turret';
  T.cylY(px, ty, ty + 0.05, 0, 0.24, { seg: M.ctx.seg(12), c: pal.gun, b: 0.01, camo: 0 });
  if (/Pantsir/i.test(n)) {
    T.xloft([
      { x: px - 0.3, y0: ty + 0.05, y1: ty + 0.34, w0: 0.2, w1: 0.16 },
      { x: px + 0.16, y0: ty + 0.05, y1: ty + 0.34, w0: 0.2, w1: 0.16 },
      { x: px + 0.28, y0: ty + 0.05, y1: ty + 0.2, w0: 0.16, w1: 0.12 },
    ], { camo: 2, ch: 0.016, tess: 0 });
    radarPanel(T, px + 0.25, ty + 0.36, 0, 0.26, 0.2, { tilt: 0.3 }); // tracking radar
    T.box(px - 0.06, ty + 0.344, 0, 0.2, 0.012, 0.22, { c: pal.team, camo: 0, b: 0.003, tone: false });
    for (const s of [1, -1]) {
      // 6 missile tubes per side, raised
      T.at(px - 0.02, ty + 0.3, s * 0.34, () => {
        for (let i = 0; i < 6; i++) canister(T, -0.36, 0.3, 0.07 * (i % 3) - 0.07, (i < 3 ? -0.04 : 0.04), 0.032, { ribs: 1, c: i % 2 ? pal.base : mulC(pal.base, 0.9) });
        T.box(-0.04, 0, 0, 0.3, 0.24, 0.04, { c: pal.gun, camo: 0, b: 0 });
      }, 0, 0.42);
      M.muzzle(px - 0.02 + 0.3 * Math.cos(0.42), ty + 0.3 + 0.3 * Math.sin(0.42), s * 0.34, 'turret');
      T.box(px + 0.06, ty + 0.16, s * 0.24, 0.3, 0.1, 0.08, { c: mulC(pal.base, 0.82), camo: 0, b: 0.012 });
    }
    const bx = px + 0.2, by = ty + 0.16;
    const B = M.part('barrel', { at: [bx, by, 0], parent: 'turret' });
    M.barrelNode = 'barrel';
    for (const s of [1, -1]) for (const k of [0, 1]) {
      const mx = thinBarrel(B, bx, 0.52, by + k * 0.035 - 0.017, s * 0.24, 0.01, { seg: 5 });
      if (k === 0) M.muzzle(mx, by, s * 0.24, 'barrel');
    }
    // search radar on a spinning mast
    const R = M.part('radar', { at: [px - 0.22, ty + 0.36, 0], parent: 'turret' });
    R.cylY(px - 0.22, ty + 0.34, ty + 0.44, 0, 0.025, { seg: 6, c: pal.gun, camo: 0 });
    R.box(px - 0.22, ty + 0.5, 0, 0.05, 0.13, 0.44, { c: mulC(pal.steel, 0.9), camo: 0, b: 0.012 });
    M.spin('radar', 'y', 2.4);
  } else if (tracked) {
    // Korkut: twin 35 mm in a slab turret with tracking radar
    T.xloft([
      { x: px - 0.36, y0: ty + 0.05, y1: ty + 0.3, w0: 0.3, w1: 0.26 },
      { x: px + 0.18, y0: ty + 0.05, y1: ty + 0.3, w0: 0.3, w1: 0.26 },
      { x: px + 0.34, y0: ty + 0.05, y1: ty + 0.2, w0: 0.2, w1: 0.16 },
    ], { camo: 2, ch: 0.018, tess: 0 });
    T.box(px - 0.1, ty + 0.304, 0, 0.24, 0.012, 0.36, { c: pal.team, camo: 0, b: 0.003, tone: false });
    T.cylY(px - 0.26, ty + 0.3, ty + 0.4, 0, 0.03, { seg: 6, c: pal.gun, camo: 0 });
    dish(T, px - 0.22, ty + 0.46, 0, 0.13);
    T.box(px + 0.12, ty + 0.35, -0.18, 0.1, 0.09, 0.1, { c: mulC(pal.base, 0.82), camo: 0, b: 0.012 });
    for (const s of [1, -1]) smokeRack(T, px - 0.1, ty + 0.2, s * 0.32, 3, s);
    const bx = px + 0.3, by = ty + 0.17;
    const B = M.part('barrel', { at: [bx, by, 0], parent: 'turret' });
    M.barrelNode = 'barrel';
    B.box(bx, by, 0, 0.14, 0.11, 0.3, { c: mulC(pal.base, 0.8), camo: 0, b: 0.014 });
    for (const s of [1, -1]) {
      B.cylX(bx, bx + 0.22, by, s * 0.09, 0.028, { c: mulC(pal.base, 0.8), seg: 6, camo: 0 });
      const mx = thinBarrel(B, bx + 0.1, 0.62, by, s * 0.09, 0.013, { seg: 6 });
      M.muzzle(mx, by, s * 0.09, 'barrel');
    }
  } else if (/Khordad/i.test(n)) {
    // 4 slanted box canisters + flat radar on a mast
    T.box(px, ty + 0.1, 0, 0.5, 0.1, 0.5, { c: mulC(pal.base, 0.8), camo: 0, b: 0.014 });
    const el = 0.62;
    T.at(px - 0.06, ty + 0.16, 0, () => {
      for (let i = 0; i < 4; i++) {
        const z = -0.2 + (i % 2) * 0.4 - (i % 2 ? 0.0 : 0.0), y = i < 2 ? 0.08 : 0.25;
        T.box(0.14, y, i % 2 ? 0.14 : -0.14, 0.86, 0.15, 0.25, { camo: 1, b: 0.014 });
        T.box(0.572, y, i % 2 ? 0.14 : -0.14, 0.008, 0.12, 0.2, { c: pal.black, camo: 0, b: 0, tone: false });
        void z;
      }
      T.box(0.0, 0.33, 0, 0.3, 0.012, 0.4, { c: pal.team, camo: 0, b: 0.003, tone: false });
    }, 0, el);
    for (const s of [1, -1]) M.muzzle(px - 0.06 + 0.57 * Math.cos(el) - 0.16 * Math.sin(el), ty + 0.16 + 0.57 * Math.sin(el) + 0.16 * Math.cos(el), s * 0.14, 'turret');
    const R = M.part('radar', { at: [hl - 0.75, deckY + 0.6, 0] });
    R.cylY(hl - 0.75, deckY + 0.3, deckY + 0.62, 0, 0.03, { seg: 6, c: pal.gun, camo: 0 });
    radarPanel(R, hl - 0.75, deckY + 0.74, 0, 0.4, 0.26, { tilt: 0.25 });
    M.spin('radar', 'y', 1.8);
  } else {
    // Herz-9 style: rotating launcher with two twin-rail arms + small radar
    T.box(px, ty + 0.17, 0, 0.26, 0.24, 0.22, { camo: 1, b: 0.016 });
    T.box(px, ty + 0.296, 0, 0.18, 0.012, 0.16, { c: pal.team, camo: 0, b: 0.003, tone: false });
    for (const s of [1, -1]) {
      T.at(px, ty + 0.2, s * 0.22, () => {
        T.box(0.05, 0, 0, 0.6, 0.05, 0.1, { c: pal.gun, camo: 0, b: 0.008 });
        for (const k of [1, -1]) missile(T, -0.2, k * 0.06, 0, { len: 0.62, r: 0.026, c: pal.missileG, tip: pal.white, fins: 4, finAt: [0.02, 0.5], seg: 6 });
      }, 0, 0.4);
      M.muzzle(px + 0.42 * Math.cos(0.4), ty + 0.2 + 0.42 * Math.sin(0.4), s * 0.22, 'turret');
    }
    const R = M.part('radar', { at: [px, ty + 0.3, 0], parent: 'turret' });
    R.cylY(px, ty + 0.29, ty + 0.4, 0, 0.022, { seg: 6, c: pal.gun, camo: 0 });
    dish(R, px + 0.03, ty + 0.46, 0, 0.11);
    M.spin('radar', 'y', 2.2);
  }
  return { kind: 'vehicle', radius: hl * 1.03 };
}

// ---------------------------------------------------------------- missile TEL

export function buildTEL(M, def) {
  const { pal, hi } = M.ctx;
  const n = def.name || '';
  const hull = M.part('hull').camo(1);
  const glass = M.part('hull', { mat: 'glass' });
  const brahmos = /BrahMos/i.test(n), babur = /Babur/i.test(n);
  const t = truck(M, hull, glass, brahmos
    ? { L: 2.6, W: 0.84, axles: [1.0, 0.68, 0.36, -0.42, -0.74, -1.06], wr: 0.14, cab: 'cabover', cabLen: 0.5, cabH: 0.44 }
    : babur
      ? { L: 2.5, W: 0.84, axles: [0.92, 0.56, -0.5, -0.86], wr: 0.16, cab: 'twin', cabLen: 0.5, cabH: 0.36 }
      : { L: 2.2, W: 0.78, axles: [0.72, -0.4, -0.74], wr: 0.15, cab: 'bonnet', cabLen: 0.72, cabH: 0.4 });
  const { hl, hw, deckY } = t;
  bed(hull, -hl, t.cabRear - 0.03, deckY, hw * 2 - 0.04);
  stabilisers(hull, [-hl + 0.08, t.cabRear - 0.14], hw, deckY - 0.02);
  // control cabin / generator behind the cab
  hull.box(t.cabRear - 0.19, deckY + 0.2, 0, 0.3, 0.3, hw * 1.7, { camo: 1, b: 0.02 });
  if (hi) { grille(hull, t.cabRear - 0.19, deckY + 0.35, 0.1, 0.18, 0.24, 4); hull.box(t.cabRear - 0.19, deckY + 0.22, hw * 0.86, 0.14, 0.2, 0.012, { c: mulC(pal.base, 0.75), camo: 0, b: 0 }); }
  antenna(hull, t.cabRear + 0.06, t.yt, hw - 0.1, 0.4, { flag: true });
  // erector: pivots at the tail, raised to launch attitude
  const pivX = -hl + 0.16, pivY = deckY + 0.1;
  const E = hull; // static: the truck itself aims
  const el = (brahmos ? 62 : babur ? 46 : 38) * DEG;
  // hydraulic rams
  const armLen = hl - 0.16 + t.cabRear - 0.4;
  for (const s of [1, -1]) hull.pipe([pivX + 0.5, deckY + 0.06, s * 0.2], [pivX + Math.cos(el) * 0.62, pivY + Math.sin(el) * 0.62, s * 0.2], 0.03, { seg: 6, c: pal.steelLt });
  for (const s of [1, -1]) hull.box(pivX, pivY - 0.02, s * 0.24, 0.16, 0.16, 0.06, { c: pal.gun, camo: 0, b: 0.014 });
  const L = brahmos ? 1.75 : babur ? 1.6 : 1.5;
  void armLen;
  E.push().translate(pivX, pivY, 0).rotZ(el);
  E.box(L * 0.42, 0.0, 0, L * 0.9, 0.06, 0.5, { c: mulC(pal.base, 0.78), camo: 0, b: 0.014 }); // erector beam
  const tips = [];
  if (brahmos) {
    for (const k of [-1, 0, 1]) {
      canister(E, -0.08, L, 0.14, k * 0.2, 0.09, { ribs: 4, c: k === 0 ? pal.base : mulC(pal.base, 0.94), front: pal.warhead });
      tips.push([L, 0.14, k * 0.2]);
    }
    E.box(L * 0.5, 0.245, 0, 0.3, 0.012, 0.5, { c: pal.team, camo: 0, b: 0.003, tone: false });
    for (const x of [0.25, L * 0.8]) E.box(x, 0.13, 0, 0.05, 0.22, 0.62, { c: pal.gun, camo: 0, b: 0.01 });
  } else if (babur) {
    for (const k of [-1, 1]) for (const j of [0, 1]) {
      E.box(L * 0.46, 0.13 + j * 0.2, k * 0.13, L, 0.19, 0.24, { camo: 1, b: 0.016 });
      E.box(L * 0.96 + 0.004, 0.13 + j * 0.2, k * 0.13, 0.008, 0.15, 0.2, { c: pal.warhead, camo: 0, b: 0, tone: false });
      if (hi) for (const x of [0.2, 0.6, 1.0]) E.box(x, 0.13 + j * 0.2, k * 0.13, 0.03, 0.2, 0.25, { c: mulC(pal.base, 0.7), camo: 0, b: 0 });
      tips.push([L * 0.96, 0.13 + j * 0.2, k * 0.13]);
    }
    E.box(L * 0.5, 0.43, 0, 0.36, 0.012, 0.4, { c: pal.team, camo: 0, b: 0.003, tone: false });
  } else {
    // rail-launched ballistic missile, exposed
    E.box(L * 0.45, 0.07, 0, L * 0.95, 0.06, 0.12, { c: pal.gun, camo: 0, b: 0.01 });
    missile(E, 0.0, 0.2, 0, { len: L, r: 0.095, c: pal.missileW, tip: pal.team, band: pal.team, fins: 4, finAt: [0.01], finLen: 0.26, finH: 0.13, noseLen: 0.46, seg: M.ctx.seg(10) });
    tips.push([L, 0.2, 0]);
  }
  E.pop();
  const ce = Math.cos(el), se = Math.sin(el);
  for (const p of tips) M.muzzle(pivX + p[0] * ce - p[1] * se, pivY + p[0] * se + p[1] * ce, p[2]);
  hull.box(-hl + 0.05, deckY + 0.056, 0, 0.06, 0.012, hw * 1.6, { c: pal.team, camo: 0, b: 0.003, tone: false });
  return { kind: 'vehicle', radius: hl * 0.98 };
}

// ---------------------------------------------------------------- MCV + harvester

export function buildMCV(M, def) {
  const { pal, hi } = M.ctx;
  const hull = M.part('hull').camo(1);
  const glass = M.part('hull', { mat: 'glass' });
  const t = truck(M, hull, glass, { L: 2.6, W: 0.92, axles: [1.0, 0.64, -0.5, -0.86], wr: 0.17, cab: 'cabover', cabLen: 0.56, cabH: 0.46 });
  const { hl, hw, deckY } = t;
  bed(hull, -hl, t.cabRear - 0.03, deckY, hw * 2 - 0.02);
  stabilisers(hull, [-hl + 0.1, t.cabRear - 0.16], hw, deckY - 0.02);
  // folded prefab: container-like core module with team roof
  const x0 = -hl + 0.06, x1 = t.cabRear - 0.1;
  const cx = (x0 + x1) / 2, cl = x1 - x0;
  hull.box(cx - 0.2, deckY + 0.3, 0, cl - 0.5, 0.5, hw * 1.8, { c: pal.wall, camo: 0, b: 0.02 });
  if (hi) for (let i = 0; i < 6; i++) hull.box(cx - 0.2 - (cl - 0.5) / 2 + 0.12 + i * ((cl - 0.74) / 5), deckY + 0.3, 0, 0.03, 0.46, hw * 1.8 + 0.02, { c: pal.wallDk, camo: 0, b: 0 });
  hull.box(cx - 0.2, deckY + 0.556, 0, cl - 0.56, 0.014, hw * 1.6, { c: pal.team, camo: 0, b: 0.004, tone: false });
  hull.box(cx - 0.2, deckY + 0.565, 0, (cl - 0.56) * 0.3, 0.006, hw * 1.2, { c: pal.teamInk, camo: 0, b: 0, tone: false, ao: false });
  // hazard chevrons along the bed edge
  for (const s of [1, -1]) for (let i = 0; i < 8; i++) hull.box(x0 + 0.1 + i * 0.19, deckY + 0.03, s * (hw - 0.012), 0.1, 0.045, 0.012, { c: i % 2 ? pal.yellow : pal.hazK, camo: 0, b: 0, tone: false });
  // folded lattice crane: tower base behind the cab, jib lying along the roof
  const bx = x1 - 0.14;
  hull.box(bx, deckY + 0.2, 0, 0.26, 0.3, 0.3, { c: pal.yellow, camo: 0, b: 0.02 });
  hull.cylY(bx, deckY + 0.35, deckY + 0.66, 0, 0.07, { seg: 8, c: pal.gun, camo: 0, b: 0.01 });
  hull.box(bx, deckY + 0.7, 0, 0.2, 0.1, 0.22, { c: pal.yellow, camo: 0, b: 0.016 });
  hull.at(bx, deckY + 0.72, 0, () => {
    // jib folded rearward
    const jl = cl - 0.4;
    for (const s of [1, -1]) {
      hull.beam([0, 0.0, s * 0.06], [-jl, 0.02, s * 0.04], 0.024, { c: pal.yellow });
      hull.beam([0, 0.1, s * 0.0], [-jl, 0.05, s * 0.0], 0.02, { c: pal.yellow });
    }
    const k = hi ? 8 : 4;
    for (let i = 0; i < k; i++) {
      const u0 = i / k, u1 = (i + 1) / k;
      for (const s of [1, -1]) hull.beam([-jl * u0, 0.0, s * lerp(0.06, 0.04, u0)], [-jl * u1, lerp(0.1, 0.05, u1), 0], 0.012, { c: pal.yellow });
    }
    hull.box(-jl - 0.03, 0.02, 0, 0.08, 0.1, 0.12, { c: pal.gun, camo: 0, b: 0.012 });
    hull.cylY(-jl - 0.03, -0.14, -0.02, 0, 0.008, { seg: 4, c: pal.black });
    hull.box(-jl - 0.03, -0.17, 0, 0.05, 0.06, 0.03, { c: pal.yellow, camo: 0, b: 0 });
  });
  // beacons
  hull.box(t.cabRear + 0.14, t.yt + 0.03, 0, 0.05, 0.035, 0.34, { c: pal.orange, camo: 0, b: 0.008, tone: false });
  antenna(hull, t.cabRear + 0.06, t.yt, hw - 0.1, 0.44, { flag: true });
  return { kind: 'vehicle', radius: hl * 0.98 };
}

export function buildHarvester(M, def) {
  const { pal, hi } = M.ctx;
  const hull = M.part('hull').camo(1);
  const glass = M.part('hull', { mat: 'glass' });
  const t = truck(M, hull, glass, { L: 2.1, W: 0.8, axles: [0.7, -0.34, -0.68], wr: 0.155, cab: 'bonnet', cabLen: 0.72, cabH: 0.42 });
  const { hl, hw, deckY } = t;
  bed(hull, -hl, t.cabRear - 0.03, deckY, hw * 2 - 0.04);
  // oil tank: ribbed cylinder with team bands
  const x0 = -hl + 0.06, x1 = t.cabRear - 0.1;
  const r = 0.3, cy = deckY + 0.07 + r;
  const seg = M.ctx.seg(14);
  const steel = mixC(pal.steelLt, pal.base, 0.35);
  const pts = [[x0, r * 0.5], [x0 + 0.05, r * 0.86], [x0 + 0.1, r]];
  const cols = [steel, steel, steel];
  const bands = [0.28, 0.72];
  for (const b of bands) {
    const bx = lerp(x0 + 0.1, x1 - 0.1, b);
    pts.push([bx - 0.09, r], [bx - 0.09, r * 1.02], [bx + 0.09, r * 1.02], [bx + 0.09, r]);
    cols.push(steel, pal.team, pal.team, steel);
  }
  pts.push([x1 - 0.1, r], [x1 - 0.05, r * 0.86], [x1, r * 0.5]);
  cols.push(steel, steel, steel);
  hull.lathe('x', pts, { at: [0, cy, 0], seg, colors: cols, crease: 40, camo: 0, k1: 1.0, k2: 1.12 });
  // cradles, catwalk, hatches, ladder
  for (const u of [0.15, 0.5, 0.85]) hull.box(lerp(x0, x1, u), deckY + 0.1, 0, 0.06, 0.14, 0.6, { c: pal.gun, camo: 0, b: 0.01 });
  hull.box((x0 + x1) / 2, cy + r + 0.012, 0, (x1 - x0) * 0.8, 0.016, 0.16, { c: pal.gun, camo: 0, b: 0 });
  for (const u of [0.3, 0.7]) hull.cylY(lerp(x0, x1, u), cy + r, cy + r + 0.06, 0, 0.07, { seg: 8, c: pal.steel, b: 0.01, camo: 0 });
  if (hi) {
    for (let i = 0; i < 5; i++) hull.box(x0 - 0.01, deckY + 0.1 + i * 0.1, 0.18, 0.02, 0.014, 0.14, { c: pal.gun, camo: 0, b: 0 });
    for (const s of [0.11, 0.25]) hull.box(x0 - 0.01, cy, s, 0.014, 0.5, 0.014, { c: pal.gun, camo: 0, b: 0 });
  }
  // suction boom + hose reel at the rear
  hull.box(x0 + 0.06, deckY + 0.1, -hw + 0.1, 0.16, 0.14, 0.16, { c: pal.yellow, camo: 0, b: 0.014 });
  hull.pipe([x0 + 0.06, deckY + 0.16, -hw + 0.1], [x0 - 0.12, deckY + 0.34, -hw + 0.06], 0.03, { seg: 6, c: pal.black });
  hull.pipe([x0 - 0.12, deckY + 0.34, -hw + 0.06], [x0 - 0.2, 0.1, -hw + 0.06], 0.03, { seg: 6, c: pal.black });
  hull.cylZ(x0 + 0.02, deckY + 0.14, hw - 0.2, hw - 0.04, 0.1, { seg: 10, c: pal.black, b: 0.01, camo: 0 });
  // hazard diamond + warning stripes at the rear
  for (let i = 0; i < 6; i++) hull.box(-hl + 0.0, deckY - 0.03, -hw + 0.07 + i * ((hw * 2 - 0.14) / 5), 0.012, 0.05, (hw * 2 - 0.14) / 6, { c: i % 2 ? pal.yellow : pal.hazK, camo: 0, b: 0, tone: false });
  hull.box(t.cabRear + 0.14, t.yt + 0.03, 0, 0.05, 0.035, 0.26, { c: pal.orange, camo: 0, b: 0.008, tone: false });
  return { kind: 'vehicle', radius: hl * 1.0 };
}
