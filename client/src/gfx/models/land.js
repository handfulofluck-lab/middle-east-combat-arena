// Tracked armour: MBTs, light/reserve tanks, tank escort (BMPT).

import { DEG, TAU, mixC, mulC, lerp, hashInt } from './geo.js';
import {
  trackUnit, gunBarrel, thinBarrel, hmg, smokeRack, antenna, hatch, grille, eraGrid, jerrycan,
  headlight, canister,
} from './parts.js';

// ---------------------------------------------------------------- families

export function tankFamily(name) {
  const n = name || '';
  if (/M1A|Abrams/i.test(n)) return 'abrams';
  if (/Leclerc/i.test(n)) return 'leclerc';
  if (/Leopard/i.test(n)) return 'leo';
  if (/Altay/i.test(n)) return 'altay';
  if (/Merkava/i.test(n)) return 'merkava';
  if (/Arjun|Challenger/i.test(n)) return 'arjun';
  if (/T-90MS|Karrar/i.test(n)) return 't90ms';
  if (/Khalid|VT-4|Haider|Type.?9\d/i.test(n)) return 'chinese';
  if (/Sabra/i.test(n)) return 'sabra';
  if (/M60|M48|Zulfiqar/i.test(n)) return 'm60';
  if (/T-90|T-80/i.test(n)) return 't90';
  if (/T-72|T-6\d|T-5\d|Zarrar|BMPT/i.test(n)) return 't72';
  return 'leo';
}

const FAM = {
  abrams: { L: 1.96, W: 1.04, n: 7, r: 0.078, th: 0.33, top: 0.465, drive: 'rear', skirt: 'plate', tx: -0.04, evac: 0.42, deck: 'turbine', gun: 0.031 },
  leo: { L: 1.9, W: 1.0, n: 7, r: 0.078, th: 0.33, top: 0.46, drive: 'rear', skirt: 'plate', tx: 0.0, evac: 0.5, deck: 'diesel', gun: 0.03 },
  arjun: { L: 1.98, W: 1.04, n: 7, r: 0.078, th: 0.34, top: 0.48, drive: 'rear', skirt: 'plate', tx: 0.0, evac: 0.52, deck: 'diesel', gun: 0.031 },
  altay: { L: 1.96, W: 1.02, n: 7, r: 0.078, th: 0.33, top: 0.465, drive: 'rear', skirt: 'plate', tx: -0.02, evac: 0.5, deck: 'diesel', gun: 0.031 },
  leclerc: { L: 1.86, W: 0.98, n: 6, r: 0.084, th: 0.32, top: 0.44, drive: 'rear', skirt: 'plate', tx: 0.0, evac: 0, deck: 'diesel', gun: 0.03 },
  merkava: { L: 1.98, W: 1.04, n: 6, r: 0.088, th: 0.34, top: 0.47, drive: 'front', skirt: 'heavy', tx: -0.2, evac: 0.46, deck: 'merkava', gun: 0.031 },
  t72: { L: 1.8, W: 0.96, n: 6, r: 0.096, th: 0.315, top: 0.415, drive: 'rear', slack: true, skirt: 'rubber', tx: 0.08, evac: 0.36, deck: 'soviet', gun: 0.029 },
  t90: { L: 1.82, W: 0.96, n: 6, r: 0.096, th: 0.315, top: 0.415, drive: 'rear', slack: true, skirt: 'rubberEra', tx: 0.08, evac: 0.36, deck: 'soviet', gun: 0.029 },
  t90ms: { L: 1.84, W: 0.98, n: 6, r: 0.096, th: 0.315, top: 0.42, drive: 'rear', slack: true, skirt: 'era', tx: 0.06, evac: 0.36, deck: 'soviet', gun: 0.03 },
  chinese: { L: 1.88, W: 0.98, n: 6, r: 0.088, th: 0.32, top: 0.43, drive: 'rear', skirt: 'era', tx: 0.02, evac: 0.5, deck: 'diesel', gun: 0.03 },
  m60: { L: 1.84, W: 0.98, n: 6, r: 0.094, th: 0.34, top: 0.5, drive: 'rear', skirt: 'none', tx: 0.06, evac: 0.4, deck: 'm60', gun: 0.028 },
  sabra: { L: 1.84, W: 0.98, n: 6, r: 0.094, th: 0.34, top: 0.5, drive: 'rear', skirt: 'plate', tx: 0.06, evac: 0.45, deck: 'm60', gun: 0.03 },
};

// ---------------------------------------------------------------- shared tracked chassis

/**
 * Tracks + dark lower tub. Returns { hl, yF } (half length, fender line).
 */
export function trackedChassis(hull, F) {
  const { pal } = hull.ctx;
  const hl = F.L / 2, tw = F.tw ?? 0.2, th = F.th;
  for (const s of [1, -1]) {
    trackUnit(hull, {
      x0: -hl + 0.015, x1: hl - 0.02, zc: s * (F.W / 2 - tw / 2), w: tw, h: th, n: F.n, r: F.r,
      drive: F.drive, slack: F.slack, rs: F.rs, rollers: F.skirt && F.skirt !== 'none' ? 0 : undefined,
    });
  }
  const zi = F.W / 2 - tw - 0.004;
  hull.prismZ([[-hl + 0.07, 0.22], [-hl + 0.13, 0.115], [hl - 0.34, 0.115], [hl - 0.1, 0.25], [hl - 0.1, th], [-hl + 0.07, th]], -zi, zi, { c: pal.under, camo: 0, b: 0.012 });
  return { hl, yF: th + 0.004, tw };
}

function skirts(hull, F, kind, yF) {
  const { pal, hi } = hull.ctx;
  if (kind === 'none') return;
  const hl = F.L / 2, zo = F.W / 2 + 0.006;
  const x0 = -hl + 0.2, x1 = hl - 0.14;
  const n = kind === 'heavy' ? 6 : 5;
  const seg = (x1 - x0) / n;
  for (const s of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const cx = x0 + seg * (i + 0.5);
      let h = 0.165, t = 0.022, c = pal.base, camo = 2;
      if (kind === 'heavy') { h = i % 2 ? 0.2 : 0.185; t = 0.04; }
      if (kind === 'rubber' || kind === 'rubberEra') { h = 0.1; t = 0.014; c = mulC(pal.base, 0.55); camo = 0; }
      // team identification plate (second plate from the rear)
      const isTeam = i === 1 && kind !== 'rubber' && kind !== 'rubberEra';
      if (isTeam) { c = pal.team; camo = 0; }
      hull.box(cx, yF + 0.03 - h / 2, s * zo, seg - 0.012, h, t, { c, camo, b: 0.006, tone: !isTeam });
      if (isTeam) hull.box(cx, yF + 0.03 - h / 2, s * (zo + t / 2 + 0.001), seg * 0.4, h * 0.34, 0.004, { c: pal.teamInk, b: 0, camo: 0, tone: false });
      if (kind === 'era' && !isTeam) {
        eraGrid(hull, [cx - seg * 0.25, yF - 0.05, s * (zo + 0.02)], [seg * 0.5, 0, 0], [0, -0.075, 0], 2, 1, [seg * 0.44, 0.12, 0.03]);
      }
      if (kind === 'rubberEra' && i >= 2) {
        eraGrid(hull, [cx - seg * 0.25, yF - 0.005, s * (zo + 0.02)], [seg * 0.5, 0, 0], [0, -0.07, 0], 2, 1, [seg * 0.44, 0.075, 0.035]);
      }
    }
    if ((kind === 'rubber' || kind === 'rubberEra')) {
      // team stripe along the fender edge
      hull.box(-hl * 0.45, yF + 0.012, s * (zo + 0.004), 0.3, 0.05, 0.012, { c: pal.team, camo: 0, b: 0.003, tone: false });
    }
    // mud flaps
    hull.box(hl - 0.07, yF - 0.035, s * (F.W / 2 - 0.1), 0.012, 0.09, 0.19, { c: pal.rubber, camo: 0, b: 0, rot: [0, -0.5, 0] });
    hull.box(-hl + 0.03, yF - 0.05, s * (F.W / 2 - 0.1), 0.012, 0.1, 0.19, { c: pal.rubber, camo: 0, b: 0 });
  }
}

// ---------------------------------------------------------------- tank

export function buildTank(M, def) {
  const { pal, hi } = M.ctx;
  const name = def.name || '';
  const fam = tankFamily(name);
  const F = FAM[fam];
  const light = def.cls === 'Light tank';
  const hull = M.part('hull').camo(1);
  const { hl, yF } = trackedChassis(hull, F);
  const W = F.W, top = F.top, hw = W / 2;
  const soviet = F.deck === 'soviet';

  // ---- upper hull
  let prof;
  if (fam === 'merkava') {
    // engine-forward hull: long shallow glacis rising to the turret ring
    prof = [[-hl, yF], [hl - 0.12, yF], [hl, yF + 0.05], [hl - 0.03, yF + 0.085], [hl - 0.82, top + 0.01], [-hl + 0.05, top], [-hl, top - 0.05]];
  } else if (soviet) {
    prof = [[-hl, yF], [hl - 0.1, yF], [hl, yF + 0.035], [hl - 0.46, top], [-hl + 0.02, top], [-hl, top - 0.04]];
  } else if (F.deck === 'm60') {
    prof = [[-hl, yF], [hl - 0.14, yF - 0.03], [hl, yF + 0.05], [hl - 0.1, yF + 0.11], [hl - 0.42, top], [-hl + 0.3, top], [-hl, top - 0.07]];
  } else {
    prof = [[-hl, yF], [hl - 0.14, yF], [hl, yF + 0.045], [hl - 0.03, yF + 0.075], [hl - 0.56, top], [-hl + 0.04, top], [-hl, top - 0.04]];
  }
  hull.prismZ(prof, -hw, hw, { camo: 2, b: 0.02, skipEdge: (i) => i === 0 });

  skirts(hull, F, F.skirt, yF);

  // ---- glacis / bow details
  const gx = fam === 'merkava' ? hl - 0.3 : hl - 0.28;
  const gy = (x) => { // glacis surface height at x (linear between glacis points)
    const a = fam === 'merkava' ? [hl - 0.82, top + 0.01] : soviet ? [hl - 0.46, top] : F.deck === 'm60' ? [hl - 0.42, top] : [hl - 0.56, top];
    const b = fam === 'merkava' ? [hl - 0.03, yF + 0.085] : soviet ? [hl, yF + 0.035] : F.deck === 'm60' ? [hl - 0.1, yF + 0.11] : [hl - 0.03, yF + 0.075];
    return lerp(a[1], b[1], (x - a[0]) / (b[0] - a[0]));
  };
  for (const s of [1, -1]) headlight(hull, gx + 0.1, gy(gx + 0.1) + 0.035, s * (hw - 0.2));
  if (hi) for (const s of [1, -1]) hull.box(hl - 0.01, yF + 0.02, s * 0.2, 0.05, 0.035, 0.03, { c: pal.gun, camo: 0, b: 0.006 }); // tow lugs
  // driver's hatch
  const dz = fam === 'leo' || fam === 'arjun' || fam === 'altay' ? 0.2 : fam === 'merkava' ? -0.24 : 0;
  const dx = fam === 'merkava' ? hl - 0.72 : soviet ? hl - 0.42 : hl - 0.5;
  hatch(hull, dx, Math.min(top, gy(dx)) - 0.004, dz, 0.085);
  if (hi) hull.box(dx + 0.1, Math.min(top, gy(dx + 0.1)) + 0.012, dz, 0.03, 0.025, 0.11, { c: pal.glassD, camo: 0, b: 0.004, tone: false });
  if (soviet) {
    // splash board + spare track links on the glacis
    hull.box(hl - 0.3, gy(hl - 0.3) + 0.02, 0, 0.02, 0.04, W * 0.62, { c: mulC(pal.base, 0.8), camo: 0, b: 0.004, rot: [0, 0, 0] });
    if (hi) for (let i = 0; i < 4; i++) hull.box(hl - 0.16, gy(hl - 0.16) + 0.012, -0.14 + i * 0.09, 0.07, 0.02, 0.07, { c: pal.track, camo: 0, b: 0.004, rot: [0, -0.38, 0] });
    if (fam !== 't72') eraGrid(hull, [hl - 0.4, gy(hl - 0.4) + 0.02, -0.3], [0.11, -0.042, 0], [0, 0, 0.12], 2, 6, [0.1, 0.03, 0.105], { rot: [0, -0.36, 0] });
  }
  if (fam === 'merkava') {
    // engine access plates + exhaust louvre on the right flank
    hull.box(hl - 0.5, gy(hl - 0.5) + 0.006, 0.1, 0.34, 0.012, 0.4, { c: mulC(pal.base, 0.93), camo: 1, b: 0.004, rot: [0, -0.115, 0] });
    grille(hull, hl - 0.62, top + 0.0, 0.4, 0.26, 0.14, 6);
    M.exhaust(hl - 0.62, top + 0.02, 0.5);
  }

  // ---- engine deck / rear
  const rx = -hl;
  if (F.deck === 'turbine') {
    grille(hull, rx + 0.2, top, 0, 0.3, W * 0.7, 6);
    hull.box(rx - 0.004, yF + 0.05, 0, 0.02, 0.11, W * 0.56, { c: pal.black, camo: 0, b: 0.004, tone: false });
    if (hi) for (let i = 0; i < 5; i++) hull.box(rx - 0.016, yF + 0.012 + i * 0.02, 0, 0.012, 0.008, W * 0.54, { c: mulC(pal.base, 0.6), camo: 0, b: 0 });
    M.exhaust(rx - 0.03, yF + 0.06, 0);
  } else if (F.deck === 'diesel' || F.deck === 'm60') {
    for (const s of [1, -1]) {
      grille(hull, rx + 0.24, top, s * 0.24, 0.3, 0.26, 5);
      hull.cylX(rx - 0.02, rx + 0.03, yF + 0.07, s * (hw - 0.2), 0.04, { c: pal.black, camo: 0, seg: 8 });
      M.exhaust(rx - 0.03, yF + 0.07, s * (hw - 0.2));
    }
    hull.cylY(rx + 0.24, top, top + 0.012, 0, 0.11, { c: mulC(pal.base, 0.8), seg: 10, camo: 0 });
    if (F.deck === 'm60' && hi) hull.box(rx - 0.01, yF + 0.09, 0, 0.02, 0.14, W * 0.5, { c: mulC(pal.base, 0.7), camo: 0, b: 0.005 });
  } else if (soviet) {
    grille(hull, rx + 0.2, top, 0, 0.16, W * 0.66, 4);
    grille(hull, rx + 0.42, top, 0.12, 0.14, 0.34, 4, { alongX: true });
    // side exhaust
    hull.box(rx + 0.42, yF + 0.07, hw + 0.01, 0.16, 0.07, 0.05, { c: pal.gun, camo: 0, b: 0.01 });
    M.exhaust(rx + 0.4, yF + 0.07, hw + 0.05);
    // external fuel drums + unditching beam
    for (const s of [1, -1]) {
      hull.cylZ(rx - 0.09, top - 0.045, s * 0.04, s * 0.42, 0.085, { c: mulC(pal.base, 0.95), b: 0.012, camo: 1, seg: 8 });
      if (hi) for (const k of [0.14, 0.32]) hull.cylZ(rx - 0.09, top - 0.045, s * k - 0.008, s * k + 0.008, 0.09, { c: pal.gun, seg: 8, camo: 0, cap0: false, cap1: false });
    }
    hull.cylZ(rx - 0.03, yF + 0.03, -hw * 0.75, hw * 0.75, 0.04, { c: pal.wood, camo: 0, seg: 7 });
  } else if (F.deck === 'merkava') {
    // rear crew door + stowage baskets
    hull.box(rx - 0.006, yF + 0.04, 0, 0.02, 0.17, 0.24, { c: mulC(pal.base, 0.85), camo: 0, b: 0.006 });
    for (const s of [1, -1]) hull.box(rx - 0.05, yF + 0.07, s * 0.32, 0.1, 0.13, 0.26, { c: mulC(pal.base, 0.82), camo: 1, b: 0.012 });
  }
  // team stripe across the rear deck edge
  hull.box(rx + 0.06, top + 0.004, 0, 0.07, 0.012, W * 0.86, { c: pal.team, camo: 0, b: 0.003, tone: false });
  if (hi && !soviet) {
    // stowage on the fenders
    hull.box(-0.3, top + 0.03, hw - 0.1, 0.34, 0.06, 0.14, { c: mulC(pal.base, 0.86), camo: 1, b: 0.012 });
    hull.box(-0.2, top + 0.03, -hw + 0.1, 0.26, 0.06, 0.14, { c: mulC(pal.base, 0.86), camo: 1, b: 0.012 });
  }
  if (hi && soviet) {
    // fender stowage / fuel cells along the right fender
    for (let i = 0; i < 3; i++) hull.box(-0.5 + i * 0.3, top + 0.028, -hw + 0.09, 0.26, 0.055, 0.15, { c: mulC(pal.base, 0.9), camo: 1, b: 0.012 });
    hull.box(-0.3, top + 0.028, hw - 0.09, 0.5, 0.055, 0.15, { c: mulC(pal.base, 0.9), camo: 1, b: 0.012 });
  }

  // ---- turret
  const tx = F.tx, ty = top;
  const T = M.part('turret', { at: [tx, ty, 0] }).camo(1);
  M.turretNode = 'turret';
  let gunX = 0.4, gunY = 0.115; // mantlet face (turret-local)
  let roofY = 0.235;
  T.push().translate(tx, ty, 0);
  const idPanel = (x, z, sx, sz, y) => {
    T.box(x, y + 0.004, z, sx, 0.012, sz, { c: pal.team, camo: 0, b: 0.004, tone: false });
    if (hi) T.box(x, y + 0.011, z, sx * 0.28, 0.004, sz * 0.7, { c: pal.teamInk, camo: 0, b: 0, tone: false, ao: false });
  };
  const cupola = (x, z, r, mg, o = {}) => {
    T.lathe('y', [[roofY - 0.01, r * 1.1], [roofY + 0.035, r * 1.05], [roofY + 0.05, r * 0.85], [roofY + 0.05, 0]], { at: [x, 0, z], seg: M.ctx.seg(10), camo: 1, crease: 40, cap0: false });
    hatch(T, x - r * 0.15, roofY + 0.05, z, r * 0.62);
    if (hi) for (let i = 0; i < 5; i++) { const a = (-60 + i * 30) * DEG; T.box(x + Math.cos(a) * r * 0.9, roofY + 0.03, z + Math.sin(a) * r * 0.9, 0.012, 0.018, 0.04, { c: pal.glassD, camo: 0, b: 0, rot: [-a, 0, 0], tone: false }); }
    if (mg) return hmg(T, x + r * 0.7, roofY + 0.05, z + (o.mz || 0), { s: 1.0, shield: o.shield });
    return null;
  };
  const sideBox = (x, y, z, sx, sy, sz) => T.box(x, y, z, sx, sy, sz, { c: mulC(pal.base, 0.9), camo: 1, b: 0.012 });

  if (fam === 'abrams') {
    T.xloft([
      { x: -0.62, y0: 0.07, y1: 0.235, w0: 0.33, w1: 0.31 },
      { x: -0.3, y0: 0.07, y1: 0.235, w0: 0.41, w1: 0.38 },
      { x: -0.28, y0: 0.0, y1: 0.235, w0: 0.41, w1: 0.38 },
      { x: 0.12, y0: 0.0, y1: 0.235, w0: 0.43, w1: 0.39 },
      { x: 0.4, y0: 0.0, y1: 0.2, w0: 0.27, w1: 0.22 },
    ], { camo: 2, ch: 0.022, endBevel: 0.012 });
    gunX = 0.4; gunY = 0.11;
    T.box(0.42, 0.11, 0, 0.09, 0.14, 0.3, { c: mulC(pal.base, 0.82), camo: 0, b: 0.02 });
    idPanel(-0.46, 0, 0.26, 0.42, roofY);
    cupola(-0.02, -0.2, 0.1, true);
    hatch(T, -0.04, roofY, 0.19, 0.085);
    if (hi) hmg(T, 0.04, roofY, 0.19, { s: 0.8 });
    T.box(0.2, roofY + 0.035, -0.24, 0.13, 0.07, 0.1, { c: mulC(pal.base, 0.88), camo: 1, b: 0.012 }); // gunner's primary sight
    if (/M1A2|SEP/i.test(name)) T.cylY(0.16, roofY, roofY + 0.1, 0.2, 0.05, { c: mulC(pal.base, 0.85), seg: 8, b: 0.01, camo: 0 }); // CITV
    for (const s of [1, -1]) {
      sideBox(-0.08, 0.13, s * 0.445, 0.34, 0.11, 0.07);
      smokeRack(T, 0.2, 0.14, s * 0.43, 3, s);
      // bustle rack
      T.box(-0.72, 0.1, s * 0.3, 0.2, 0.014, 0.014, { c: pal.gun, b: 0, camo: 0 });
      T.box(-0.72, 0.19, s * 0.3, 0.2, 0.014, 0.014, { c: pal.gun, b: 0, camo: 0 });
    }
    T.box(-0.82, 0.145, 0, 0.014, 0.1, 0.62, { c: pal.gun, b: 0, camo: 0 });
    T.box(-0.72, 0.14, 0, 0.16, 0.1, 0.5, { c: pal.canvas, b: 0.025, camo: 0 });
    antenna(T, -0.56, roofY, 0.28, 0.42, { flag: true });
    antenna(T, -0.56, roofY, -0.28, 0.36);
  } else if (fam === 'leo' || fam === 'arjun') {
    const k = fam === 'arjun' ? 1.06 : 1;
    T.xloft([
      { x: -0.58 * k, y0: 0.05, y1: 0.24, w0: 0.37 * k, w1: 0.36 * k },
      { x: -0.3, y0: 0.05, y1: 0.24, w0: 0.39 * k, w1: 0.38 * k },
      { x: -0.28, y0: 0.0, y1: 0.24, w0: 0.39 * k, w1: 0.38 * k },
      { x: 0.3 * k, y0: 0.0, y1: 0.24, w0: 0.39 * k, w1: 0.38 * k },
      { x: 0.4 * k, y0: 0.0, y1: 0.235, w0: 0.31 * k, w1: 0.3 * k },
    ], { camo: 2, ch: 0.018, endBevel: 0.012 });
    gunX = 0.4 * k; gunY = 0.115;
    T.box(gunX + 0.03, gunY, 0, 0.1, 0.16, 0.26, { c: mulC(pal.base, 0.84), camo: 0, b: 0.022 });
    // EMES sight notch (dark window) on the right front
    T.box(0.36 * k, 0.2, -0.2 * k, 0.05, 0.06, 0.12, { c: pal.glassD, camo: 0, b: 0.006, tone: false });
    idPanel(-0.4, 0, 0.26, 0.4, roofY);
    cupola(-0.05, -0.17, 0.095, fam === 'arjun');
    hatch(T, -0.05, roofY, 0.18, 0.09);
    if (fam === 'leo' && hi) hmg(T, 0.02, roofY, 0.18, { s: 0.8 });
    T.box(0.12, roofY + 0.03, -0.17, 0.09, 0.07, 0.09, { c: mulC(pal.base, 0.85), camo: 0, b: 0.012 }); // PERI
    for (const s of [1, -1]) {
      sideBox(-0.46 * k, 0.15, s * 0.4 * k, 0.24, 0.14, 0.06);
      smokeRack(T, -0.18, 0.15, s * (0.4 * k + 0.02), 4, s);
    }
    if (fam === 'arjun') {
      T.box(-0.68, 0.14, 0, 0.16, 0.14, 0.6, { c: mulC(pal.base, 0.85), camo: 1, b: 0.015 });
      T.box(0.2, roofY + 0.04, 0.2, 0.12, 0.08, 0.12, { c: mulC(pal.base, 0.85), camo: 0, b: 0.012 });
    }
    antenna(T, -0.52, roofY, 0.3, 0.42, { flag: true });
    antenna(T, -0.52, roofY, -0.3, 0.34);
  } else if (fam === 'altay' || fam === 'leclerc' || fam === 'chinese' || fam === 't90ms') {
    // arrowhead / welded turret with wedge front
    const lc = fam === 'leclerc', cn = fam === 'chinese', ms = fam === 't90ms';
    const hh = lc ? 0.205 : ms ? 0.2 : cn ? 0.205 : 0.235;
    roofY = hh;
    const rw = lc ? 0.36 : ms ? 0.35 : cn ? 0.36 : 0.38;
    const tipX = lc ? 0.52 : ms ? 0.42 : cn ? 0.44 : 0.5;
    const rearX = lc ? -0.66 : ms ? -0.6 : cn ? -0.6 : -0.6;
    T.xloft([
      { x: rearX, y0: 0.06, y1: hh, w0: rw - 0.03, w1: rw - 0.05 },
      { x: -0.3, y0: 0.06, y1: hh, w0: rw + 0.02, w1: rw - 0.01 },
      { x: -0.28, y0: 0.0, y1: hh, w0: rw + 0.02, w1: rw - 0.01 },
      { x: 0.08, y0: 0.0, y1: hh, w0: rw + 0.04, w1: rw },
      { x: tipX, y0: 0.0, y1: hh - 0.05, w0: lc ? 0.2 : 0.16, w1: lc ? 0.17 : 0.12 },
    ], { camo: 2, ch: 0.02, endBevel: 0.012 });
    gunX = tipX; gunY = 0.105;
    T.box(tipX + 0.02, gunY, 0, 0.1, 0.13, 0.2, { c: mulC(pal.base, 0.82), camo: 0, b: 0.02 });
    idPanel(-0.42, 0, 0.26, 0.4, roofY);
    cupola(-0.06, -0.17, 0.09, !lc, { shield: ms });
    hatch(T, -0.06, roofY, 0.17, 0.085);
    // commander's panoramic sight
    T.cylY(0.1, roofY, roofY + 0.11, -0.16, 0.045, { c: mulC(pal.base, 0.84), seg: 8, b: 0.01, camo: 0 });
    T.box(0.2, roofY + 0.03, 0.18, 0.11, 0.06, 0.1, { c: mulC(pal.base, 0.86), camo: 0, b: 0.012 });
    if (cn || ms) {
      // wedge ERA on the cheeks
      for (const s of [1, -1]) {
        for (let i = 0; i < 3; i++) {
          const u = (i + 0.5) / 3;
          const x = lerp(0.1, tipX - 0.02, u), z = s * lerp(rw + 0.05, 0.2, u);
          T.box(x, 0.1, z, 0.13, 0.15, 0.06, { camo: 1, b: 0, rot: [s * -0.62, 0, 0], toneAmt: 0.09 });
        }
      }
      // bustle basket
      T.box(rearX - 0.1, 0.13, 0, 0.18, 0.12, (rw - 0.04) * 2, { c: mulC(pal.base, 0.8), camo: 1, b: 0.012 });
      if (hi) for (let i = 0; i < 5; i++) T.box(rearX - 0.195, 0.13, -0.26 + i * 0.13, 0.012, 0.13, 0.012, { c: pal.gun, camo: 0, b: 0 });
    }
    if (lc) {
      // modular side boxes + autoloader bustle
      for (const s of [1, -1]) for (let i = 0; i < 3; i++) sideBox(-0.5 + i * 0.24, 0.12, s * (rw + 0.045), 0.22, 0.13, 0.07);
      T.box(-0.72, 0.13, 0, 0.14, 0.13, 0.5, { c: mulC(pal.base, 0.86), camo: 1, b: 0.014 });
    }
    if (fam === 'altay') {
      for (const s of [1, -1]) sideBox(-0.44, 0.14, s * (rw + 0.04), 0.3, 0.14, 0.06);
      T.box(-0.7, 0.13, 0, 0.18, 0.12, 0.62, { c: mulC(pal.base, 0.82), camo: 1, b: 0.014 });
      // remote weapon station
      T.box(-0.3, roofY + 0.05, 0.02, 0.1, 0.07, 0.09, { c: mulC(pal.base, 0.8), camo: 0, b: 0.012 });
    }
    for (const s of [1, -1]) smokeRack(T, -0.14, 0.15, s * (rw + (lc ? 0.09 : 0.05)), 4, s);
    antenna(T, rearX + 0.08, roofY, 0.26, 0.42, { flag: true });
    antenna(T, rearX + 0.08, roofY, -0.26, 0.34);
  } else if (fam === 'merkava') {
    roofY = 0.22;
    const mk4 = /IV|4/.test(name);
    T.xloft([
      { x: -0.56, y0: 0.05, y1: 0.2, w0: 0.3, w1: 0.26 },
      { x: -0.3, y0: 0.05, y1: 0.22, w0: 0.42, w1: 0.34 },
      { x: -0.28, y0: 0.0, y1: 0.22, w0: 0.43, w1: 0.34 },
      { x: 0.0, y0: 0.0, y1: 0.22, w0: 0.46, w1: 0.34 },
      { x: 0.34, y0: 0.0, y1: 0.165, w0: 0.34, w1: 0.2 },
      { x: 0.66, y0: 0.02, y1: 0.09, w0: 0.11, w1: 0.07 },
    ], { camo: 2, ch: 0.016, endBevel: 0.01 });
    gunX = 0.6; gunY = 0.085;
    T.box(0.62, gunY, 0, 0.1, 0.09, 0.15, { c: mulC(pal.base, 0.82), camo: 0, b: 0.016 });
    idPanel(-0.3, 0.02, 0.24, 0.36, roofY);
    cupola(-0.04, -0.17, 0.085, true);
    hatch(T, -0.05, roofY, 0.16, 0.08);
    T.box(0.16, roofY + 0.02, -0.14, 0.1, 0.07, 0.1, { c: mulC(pal.base, 0.85), camo: 0, b: 0.012 });
    // 60 mm mortar hatch + rear basket with ball-and-chain curtain
    T.box(-0.68, 0.11, 0, 0.2, 0.11, 0.5, { c: mulC(pal.base, 0.82), camo: 1, b: 0.014 });
    if (hi) for (let i = 0; i < 9; i++) T.cylY(-0.78, 0.0, 0.07, -0.24 + i * 0.06, 0.007, { seg: 4, c: pal.gun, camo: 0 });
    if (mk4) {
      // Trophy APS: radar panels + launchers
      for (const s of [1, -1]) {
        T.box(0.12, 0.17, s * 0.42, 0.14, 0.09, 0.03, { c: mulC(pal.steel, 0.9), camo: 0, b: 0.008, rot: [s * -0.25, 0, s * 0.3] });
        T.box(-0.16, 0.17, s * 0.44, 0.14, 0.09, 0.03, { c: mulC(pal.steel, 0.9), camo: 0, b: 0.008, rot: [s * 0.2, 0, s * 0.3] });
        T.box(-0.02, roofY + 0.03, s * 0.34, 0.1, 0.06, 0.07, { c: pal.gun, camo: 0, b: 0.01 });
      }
    }
    for (const s of [1, -1]) smokeRack(T, 0.3, 0.13, s * 0.36, 3, s);
    antenna(T, -0.5, roofY - 0.01, 0.2, 0.42, { flag: true });
    antenna(T, -0.5, roofY - 0.01, -0.2, 0.34);
  } else {
    // cast dome turrets: T-72 / T-90 / T-80 / M60 / Sabra
    const m60 = fam === 'm60' || fam === 'sabra';
    const R = m60 ? 0.37 : 0.385;
    const hh = m60 ? 0.27 : 0.2;
    roofY = hh;
    const kx = m60 ? 1.28 : 1.08, kz = m60 ? 0.95 : 1.0;
    const ox = m60 ? -0.06 : 0;
    T.lathe('y', [[0, R * 0.96], [hh * 0.3, R], [hh * 0.62, R * 0.88], [hh * 0.88, R * 0.62], [hh, R * 0.34], [hh, 0]], {
      at: [ox, 0, 0], seg: M.ctx.seg(16), k1: kz, k2: kx, camo: 2, crease: 60, cap0: false, tess: hi ? 0.16 : 0,
    });
    gunX = (m60 ? 0.42 : 0.37); gunY = m60 ? 0.13 : 0.1;
    T.box(gunX - 0.02, gunY, 0, 0.14, m60 ? 0.17 : 0.12, m60 ? 0.3 : 0.2, { c: mulC(pal.base, 0.84), camo: 0, b: 0.03 });
    idPanel(m60 ? -0.24 : -0.1, 0.0, 0.2, 0.22, roofY);
    if (m60) {
      // tall M19 commander's cupola with its own MG
      T.lathe('y', [[roofY - 0.04, 0.115], [roofY + 0.06, 0.11], [roofY + 0.1, 0.07], [roofY + 0.1, 0]], { at: [-0.04, 0, -0.17], seg: M.ctx.seg(10), camo: 1, crease: 40, cap0: false });
      thinBarrel(T, 0.04, 0.2, roofY + 0.05, -0.17, 0.008);
      hatch(T, -0.06, roofY - 0.01, 0.17, 0.085);
      // rear bustle rack
      T.box(-0.6, 0.13, 0, 0.16, 0.12, 0.52, { c: mulC(pal.base, 0.8), camo: 1, b: 0.014 });
      if (fam === 'm60') T.box(gunX + 0.08, gunY + 0.15, 0, 0.1, 0.1, 0.14, { c: pal.gun, camo: 0, b: 0.02 }); // searchlight
      if (fam === 'sabra') {
        // angular add-on armour wedges
        for (const s of [1, -1]) {
          T.box(0.24, 0.13, s * 0.26, 0.34, 0.2, 0.12, { camo: 1, b: 0.016, rot: [s * -0.5, 0, 0] });
          T.box(-0.14, 0.13, s * 0.39, 0.4, 0.2, 0.08, { camo: 1, b: 0.014 });
        }
      }
      for (const s of [1, -1]) smokeRack(T, 0.1, 0.19, s * (fam === 'sabra' ? 0.45 : 0.36), 3, s);
      antenna(T, -0.42, roofY - 0.04, 0.2, 0.42, { flag: true });
    } else {
      // soviet: low commander cupola w/ NSVT, IR lamp, snorkel, stowage boxes
      const mz = cupola(-0.04, -0.17, 0.085, true);
      hatch(T, -0.04, roofY - 0.012, 0.17, 0.08);
      T.box(0.27, 0.19, -0.2, 0.09, 0.08, 0.1, { c: pal.gun, camo: 0, b: 0.02 }); // Luna IR searchlight
      T.cylZ(-0.4, 0.14, -0.26, 0.26, 0.045, { c: mulC(pal.base, 0.85), camo: 1, seg: 8, b: 0.008 }); // snorkel
      for (const s of [1, -1]) sideBox(-0.26, 0.11, s * 0.36, 0.2, 0.1, 0.08);
      const era = fam !== 't72' || /Ajeya|T-72S|Zarrar/i.test(name);
      if (era) {
        const n = 7;
        for (let i = 0; i < n; i++) {
          const a = (-66 + (132 * i) / (n - 1)) * DEG;
          if (Math.abs(a) < 12 * DEG) continue;
          T.box(Math.cos(a) * R * kx * 0.98, 0.1, Math.sin(a) * R * 0.99, 0.07, 0.13, 0.11, { camo: 1, b: 0, rot: [-a, 0.3, 0], toneAmt: 0.09 });
        }
        if (fam === 't90' && hi) for (const s of [1, -1]) T.box(0.33, 0.13, s * 0.17, 0.07, 0.08, 0.1, { c: pal.gun, camo: 0, b: 0.015 }); // Shtora dazzlers
      }
      for (const s of [1, -1]) smokeRack(T, 0.14, 0.15, s * 0.39, 4, s);
      antenna(T, -0.26, roofY - 0.04, 0.16, 0.42, { flag: true });
      if (mz) M._aux = mz;
    }
  }
  T.pop();

  // ---- main gun
  const bx = tx + gunX + 0.04, by = ty + gunY;
  const B = M.part('barrel', { at: [bx, by, 0], parent: 'turret' });
  M.barrelNode = 'barrel';
  const len = (light ? 0.5 : 0.52) + (def.range || 8) * 0.068;
  const mx = gunBarrel(B, bx, { len, r: F.gun, y: by, evac: F.evac, sleeve: true });
  // team kill-ring on the barrel
  B.cylX(bx + len * 0.14, bx + len * 0.19, by, 0, F.gun * 1.3, { c: pal.team, seg: M.ctx.seg(10), camo: 0, tone: false });
  M.muzzle(mx, by, 0, 'barrel');

  return { kind: 'vehicle', radius: Math.max(hl, hw) * 1.02 };
}

// ---------------------------------------------------------------- tank escort (BMPT)

export function buildEscort(M, def) {
  const { pal, hi } = M.ctx;
  const F = FAM.t72;
  const hull = M.part('hull').camo(1);
  const { hl, yF } = trackedChassis(hull, F);
  const W = F.W, top = F.top + 0.02, hw = W / 2;
  hull.prismZ([[-hl, yF], [hl - 0.1, yF], [hl, yF + 0.035], [hl - 0.46, top], [-hl + 0.02, top], [-hl, top - 0.04]], -hw, hw, { camo: 2, b: 0.02 });
  skirts(hull, F, 'era', yF);
  const gy = (x) => lerp(top, yF + 0.035, (x - (hl - 0.46)) / 0.46);
  eraGrid(hull, [hl - 0.4, gy(hl - 0.4) + 0.02, -0.3], [0.11, -0.042, 0], [0, 0, 0.12], 3, 6, [0.1, 0.03, 0.105], { rot: [0, -0.36, 0] });
  for (const s of [1, -1]) headlight(hull, hl - 0.1, gy(hl - 0.1) + 0.04, s * (hw - 0.16));
  grille(hull, -hl + 0.2, top, 0, 0.16, W * 0.66, 4);
  hull.box(-hl + 0.42, yF + 0.07, hw + 0.01, 0.16, 0.07, 0.05, { c: pal.gun, camo: 0, b: 0.01 });
  M.exhaust(-hl + 0.4, yF + 0.07, hw + 0.05);
  hull.box(-hl + 0.06, top + 0.004, 0, 0.07, 0.012, W * 0.86, { c: pal.team, camo: 0, b: 0.003, tone: false });
  // bow grenade-launcher sponsons
  for (const s of [1, -1]) {
    hull.box(hl - 0.52, top + 0.03, s * (hw - 0.1), 0.3, 0.06, 0.16, { camo: 1, b: 0.012 });
    thinBarrel(hull, hl - 0.4, 0.14, top + 0.03, s * (hw - 0.1), 0.012);
  }
  // low-profile unmanned turret
  const tx = 0.02, ty = top;
  const T = M.part('turret', { at: [tx, ty, 0] }).camo(1);
  M.turretNode = 'turret';
  T.push().translate(tx, ty, 0);
  T.xloft([
    { x: -0.4, y0: 0, y1: 0.12, w0: 0.34, w1: 0.3 },
    { x: 0.2, y0: 0, y1: 0.12, w0: 0.36, w1: 0.3 },
    { x: 0.38, y0: 0, y1: 0.09, w0: 0.22, w1: 0.16 },
  ], { camo: 2, ch: 0.016, endBevel: 0.01 });
  T.box(-0.2, 0.125, 0, 0.22, 0.012, 0.3, { c: pal.team, camo: 0, b: 0.004, tone: false });
  // raised weapon pedestal with the twin 30 mm cradle
  T.box(0.0, 0.2, 0, 0.3, 0.16, 0.2, { camo: 1, b: 0.02 });
  T.box(0.12, 0.3, 0, 0.26, 0.07, 0.3, { c: mulC(pal.base, 0.82), camo: 0, b: 0.014 });
  // ATGM tube pairs on each side
  for (const s of [1, -1]) {
    T.box(0.0, 0.22, s * 0.26, 0.2, 0.05, 0.12, { c: mulC(pal.base, 0.8), camo: 0, b: 0.01 });
    for (const k of [0, 1]) canister(T, -0.22, 0.26, 0.19 + k * 0.085, s * 0.33, 0.038, { c: mulC(pal.base, 0.9), ribs: 1 });
    M.muzzle(tx + 0.27, ty + 0.23, s * 0.33, 'turret');
  }
  // sights
  T.box(-0.16, 0.32, 0.0, 0.1, 0.09, 0.1, { c: mulC(pal.base, 0.85), camo: 0, b: 0.012 });
  T.box(-0.1, 0.33, 0.0, 0.01, 0.05, 0.07, { c: pal.glassD, camo: 0, b: 0, tone: false });
  for (const s of [1, -1]) smokeRack(T, -0.3, 0.1, s * 0.35, 4, s);
  antenna(T, -0.34, 0.12, 0.22, 0.42, { flag: true });
  T.pop();
  const bx = tx + 0.25, by = ty + 0.3;
  const B = M.part('barrel', { at: [bx, by, 0], parent: 'turret' });
  M.barrelNode = 'barrel';
  for (const s of [1, -1]) {
    const mx = thinBarrel(B, bx, 0.62, by, s * 0.075, 0.014, { seg: 6 });
    B.cylX(bx, bx + 0.2, by, s * 0.075, 0.026, { c: mulC(pal.base, 0.75), seg: 6, camo: 0 });
    M.muzzle(mx, by, s * 0.075, 'barrel');
  }
  return { kind: 'vehicle', radius: hl * 1.02 };
}
