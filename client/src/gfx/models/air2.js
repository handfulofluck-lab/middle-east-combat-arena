// Rotary wing (attack + transport helicopters) and unmanned aircraft.

import { DEG, TAU, mixC, mulC, lerp } from './geo.js';
import { missile, rotorBlades, rotorDisc, flatRotor, thinBarrel, wheel, canister } from './parts.js';
import { fuselage, wing, fin, nozzle } from './air.js';

// ---------------------------------------------------------------- helicopters

function mainRotor(M, name, x, y, z, R, n, speed, o = {}) {
  const g = M.part(name, { at: [x, y, z] });
  rotorBlades(g, x, y, z, R, n, o);
  const d = M.part(name, { mat: 'rotorDisc' });
  rotorDisc(d, x, y + 0.004, z, R, n, { axis: 'y', phase: o.phase || 0 });
  M.spin(name, 'y', speed);
}

function helo(def) {
  const n = def.name || '';
  if (/Ka-5/i.test(n)) return 'ka52';
  if (/Mi-28/i.test(n) && !/AH-1/i.test(n)) return 'mi28';
  if (/T129|ATAK|A129/i.test(n)) return 't129';
  if (/LCH|Prachand/i.test(n)) return 'lch';
  if (/Z-10/i.test(n)) return 'z10';
  if (/AH-1|Cobra/i.test(n)) return 'cobra';
  if (/Chinook|CH-47/i.test(n)) return 'ch47';
  if (/Black Hawk|UH-60|Mi-17|Mi-8/i.test(n)) return 'uh60';
  if (def.cls === 'Transport helo') return 'uh60';
  return 'apache';
}

const ATTACK = {
  apache: { bw: 0.13, k: 1.0, blades: 4, tailN: 4, tailSide: 1, eng: 0.075, wingSpan: 0.36, gear: 'wheels', nose: 'tads' },
  mi28: { bw: 0.135, k: 1.04, blades: 5, tailN: 4, tailSide: -1, eng: 0.085, wingSpan: 0.38, gear: 'wheels', nose: 'thimble', mast: 'ball' },
  t129: { bw: 0.105, k: 0.94, blades: 5, tailN: 2, tailSide: 1, eng: 0.06, wingSpan: 0.34, gear: 'wheels', nose: 'ball' },
  lch: { bw: 0.11, k: 0.96, blades: 4, tailN: 4, tailSide: -1, eng: 0.06, wingSpan: 0.32, gear: 'wheels', nose: 'ball', facet: true },
  z10: { bw: 0.105, k: 0.98, blades: 5, tailN: 4, tailSide: 1, eng: 0.06, wingSpan: 0.34, gear: 'wheels', nose: 'ball', facet: true },
  cobra: { bw: 0.09, k: 0.92, blades: 2, tailN: 2, tailSide: -1, eng: 0.07, wingSpan: 0.3, gear: 'skids', nose: 'ball', chord: 0.11 },
  ka52: { bw: 0.19, k: 1.02, blades: 3, coax: true, eng: 0.085, wingSpan: 0.4, gear: 'wheels', nose: 'ball', side: true },
};

function stores(M, g, x, y, z, s, kind, k) {
  const { pal } = g.ctx;
  g.box(x, y + 0.03, z, 0.14, 0.05, 0.016, { c: mulC(pal.base, 0.75), camo: 0, b: 0 });
  if (kind === 'rockets') {
    g.lathe('x', [[x - 0.2, 0.03], [x - 0.16, 0.048], [x + 0.14, 0.048], [x + 0.14, 0.04], [x + 0.13, 0.04], [x + 0.13, 0]], { at: [0, y - 0.04, z], seg: g.ctx.seg(8), colors: [pal.base, pal.base, pal.base, pal.black, pal.black, pal.black].map((c, i) => (i < 3 ? mulC(pal.base, 0.85) : c)), camo: 0, crease: 40 });
    M.muzzle((x + 0.15) * k, (y - 0.04) * k, z * k);
  } else {
    // 2x2 ATGM rack
    g.box(x, y - 0.035, z, 0.1, 0.1, 0.012, { c: pal.gun, camo: 0, b: 0 });
    for (const dy of [0, -0.07]) for (const dz of [0.03, -0.03]) missile(g, x - 0.16, y + dy, z + dz, { len: 0.34, r: 0.02, c: pal.missileG, tip: pal.black, fins: 4, finAt: [0.0], finLen: 0.05, finH: 0.022, nose: 'round', seg: 5 });
    M.muzzle((x + 0.2) * k, (y - 0.035) * k, z * k);
  }
  void s;
}

export function buildHelo(M, def) {
  const fam = helo(def);
  if (fam === 'ch47' || fam === 'uh60') return buildTransport(M, def, fam);
  const { pal, hi } = M.ctx;
  const S = ATTACK[fam];
  const k = S.k;
  const name = def.name || '';
  const g = M.part('hull').camo(1);
  const glass = M.part('hull', { mat: 'glass' });
  g.push().scale(k, k, k); glass.push().scale(k, k, k);
  const bw = S.bw;
  const e = S.facet ? 3.6 : 2.6;
  // ---- fuselage + tail boom
  const st = S.side
    ? [
      { x: 1.0, y: 0.34, w: 0.012, h: 0.012 }, { x: 0.86, y: 0.36, w: bw * 0.6, h: 0.09, e: 2.6 }, { x: 0.6, y: 0.42, w: bw, h: 0.17, e: 3 },
      { x: 0.2, y: 0.46, w: bw, h: 0.2, e: 3 }, { x: -0.3, y: 0.48, w: bw * 0.86, h: 0.18, e: 2.6 }, { x: -0.6, y: 0.5, w: 0.085, h: 0.11, e: 2.4 },
      { x: -1.12, y: 0.52, w: 0.05, h: 0.07 }, { x: -1.2, y: 0.52, w: 0.02, h: 0.03 },
    ]
    : [
      { x: 1.02, y: 0.3, w: 0.012, h: 0.012 }, { x: 0.9, y: 0.31, w: bw * 0.5, h: 0.065, e }, { x: 0.62, y: 0.35, w: bw * 0.86, h: 0.13, e },
      { x: 0.26, y: 0.4, w: bw, h: 0.18, e }, { x: -0.12, y: 0.43, w: bw * 1.05, h: 0.19, e }, { x: -0.46, y: 0.47, w: bw * 0.8, h: 0.13, e: 2.4 },
      { x: -0.62, y: 0.5, w: 0.055, h: 0.07 }, { x: -1.16, y: 0.53, w: 0.034, h: 0.042 }, { x: -1.22, y: 0.53, w: 0.012, h: 0.015 },
    ];
  fuselage(g, st, { camo: 2, cap0: false, cap1: false });
  // ---- canopy
  const tint = [0.04, 0.055, 0.065];
  if (S.side) {
    fuselage(glass, [{ x: 0.84, y: 0.47, w: bw * 0.55, h: 0.03, e: 3.4 }, { x: 0.66, y: 0.56, w: bw * 0.82, h: 0.07, e: 3.4 }, { x: 0.4, y: 0.6, w: bw * 0.84, h: 0.075, e: 3.4 }, { x: 0.24, y: 0.6, w: bw * 0.7, h: 0.05, e: 3.4 }], { c: tint, seg: 8, crease: 30 });
    if (hi) g.box(0.52, 0.64, 0, 0.36, 0.05, 0.016, { c: mulC(pal.base, 0.8), camo: 0, b: 0 });
  } else {
    // stepped tandem cockpit, flat panes
    fuselage(glass, [{ x: 0.84, y: 0.4, w: bw * 0.42, h: 0.02, e: 4 }, { x: 0.66, y: 0.475, w: bw * 0.62, h: 0.06, e: 4 }, { x: 0.47, y: 0.5, w: bw * 0.66, h: 0.07, e: 4 }], { c: tint, seg: 8, crease: 25 });
    fuselage(glass, [{ x: 0.46, y: 0.53, w: bw * 0.62, h: 0.05, e: 4 }, { x: 0.3, y: 0.6, w: bw * 0.7, h: 0.075, e: 4 }, { x: 0.08, y: 0.62, w: bw * 0.72, h: 0.07, e: 4 }, { x: -0.02, y: 0.6, w: bw * 0.6, h: 0.04, e: 4 }], { c: tint, seg: 8, crease: 25 });
    if (hi) { g.box(0.465, 0.52, 0, 0.02, 0.1, bw * 1.36, { c: mulC(pal.base, 0.8), camo: 0, b: 0 }); g.box(0.2, 0.69, 0, 0.3, 0.012, 0.03, { c: mulC(pal.base, 0.8), camo: 0, b: 0 }); }
  }
  // ---- engines + rotor mast fairing
  const ey = S.side ? 0.62 : 0.57, er = S.eng;
  g.mirror((sg) => {
    const ez = bw * (S.side ? 0.7 : 0.95) + er * 0.55;
    g.lathe('x', [[0.14, er * 0.55], [0.1, er], [-0.36, er], [-0.46, er * 0.8], [-0.46, er * 0.55], [-0.4, er * 0.5]], { at: [0, ey, ez], seg: M.ctx.seg(8), camo: 1, crease: 45 });
    g.lathe('x', [[0.142, er * 0.5], [0.13, 0]], { at: [0, ey, ez], seg: M.ctx.seg(8), c: pal.black, camo: 0, cap0: false, cap1: false, tone: false, flip: true });
    M.exhaust(-0.47 * k, ey * k, sg * ez * k);
  });
  const hubY = S.side ? 0.86 : 0.8;
  fuselage(g, [{ x: 0.2, y: ey + 0.04, w: 0.07, h: 0.06, e: 2.6 }, { x: -0.05, y: ey + 0.07, w: 0.09, h: 0.09, e: 2.6 }, { x: -0.4, y: ey + 0.02, w: 0.06, h: 0.05, e: 2.4 }], { camo: 2, seg: 8, tess: 0 });
  g.cylY(-0.02, ey + 0.1, hubY + (S.coax ? 0.2 : 0.0), 0, 0.028, { seg: 6, c: pal.gun, camo: 0 });
  // ---- tail
  const tx = -1.16;
  if (S.coax) {
    g.mirror(() => {
      wing(g, { x: tx + 0.2, y: 0.54, z0: 0.02, chord: 0.2, tip: 0.16, span: 0.3, sweep: 10, t: 0.024, camo: 1 });
      fin(g, { x: tx + 0.2, y: 0.42, z: 0.31, h: 0.3, chord: 0.2, tip: 0.13, sweep: 20, t: 0.022 });
    });
    fin(g, { x: tx + 0.3, y: 0.56, z: 0, h: 0.34, chord: 0.36, tip: 0.18, sweep: 35, t: 0.03 });
  } else {
    fin(g, { x: tx + 0.24, y: 0.55, z: 0, h: 0.42, chord: 0.3, tip: 0.15, sweep: 38, t: 0.035 });
    g.mirror(() => wing(g, { x: tx + 0.12, y: fam === 'apache' ? 0.5 : 0.62, z0: 0.02, chord: 0.17, tip: 0.13, span: 0.26, sweep: 8, t: 0.022, camo: 1, teamTip: 0.3 }));
    // tail rotor
    const tz = S.tailSide * 0.06, ty = 0.86, trx = tx - 0.06;
    g.cylZ(trx, ty, Math.min(0, tz), Math.max(0, tz), 0.02, { seg: 5, c: pal.gun, camo: 0 });
    const tr = M.part('tail', { at: [trx * k, ty * k, tz * k], mat: 'rotorDisc' });
    flatRotor(tr, trx * k, ty * k, tz * k, 0.22 * k, S.tailN, { axis: 'z', phase: fam === 'apache' ? 0.5 : 0 });
    M.spin('tail', 'z', 52);
  }
  // ---- stub wings + stores
  const wy = 0.36, ws = S.wingSpan;
  g.mirror(() => wing(g, { x: 0.1, y: wy, z0: bw * 0.8, chord: 0.24, tip: 0.16, span: ws, sweep: 6, t: 0.034, dih: -0.06, camo: 2, teamTip: 0.22 }));
  for (const s of [1, -1]) {
    const z1 = s * (bw * 0.8 + ws * 0.42), z2 = s * (bw * 0.8 + ws * 0.86);
    stores(M, g, 0.0, wy - 0.05, z1, s, 'atgm', k);
    stores(M, g, 0.0, wy - 0.06, z2, s, 'rockets', k);
  }
  // ---- nose sensors
  if (S.nose === 'tads') {
    g.cylX(0.96, 1.06, 0.3, 0, 0.065, { seg: M.ctx.seg(8), c: mulC(pal.base, 0.8), camo: 0, b: 0.012 });
    g.box(1.07, 0.3, 0.02, 0.012, 0.06, 0.05, { c: pal.glassD, camo: 0, b: 0, tone: false });
    g.box(1.0, 0.39, 0, 0.07, 0.07, 0.08, { c: mulC(pal.base, 0.8), camo: 0, b: 0.012 });
  } else if (S.nose === 'thimble') {
    g.sphere(1.03, 0.3, 0, 0.055, { seg: M.ctx.seg(8), c: mulC(pal.base, 0.7), camo: 0 });
    g.sphere(0.9, 0.2, 0, 0.06, { seg: M.ctx.seg(8), c: pal.gun, camo: 0 });
  } else {
    glass.sphere(0.94, 0.225, 0, 0.055, { seg: M.ctx.seg(8), c: [0.02, 0.03, 0.04] });
    g.cylY(0.94, 0.24, 0.3, 0, 0.03, { seg: 6, c: pal.gun, camo: 0 });
  }
  if (S.mast === 'ball' || (fam === 'apache' && /AH-64[DE]|Saraf|Apache$/i.test(name))) {
    const my = hubY + (S.coax ? 0.2 : 0.07);
    if (fam === 'apache') g.lathe('y', [[my, 0.03], [my + 0.03, 0.13], [my + 0.075, 0.13], [my + 0.11, 0.05], [my + 0.11, 0]], { at: [-0.02, 0, 0], seg: M.ctx.seg(10), c: mulC(pal.base, 0.7), camo: 0, crease: 50 });
    else g.sphere(-0.02, my + 0.06, 0, 0.075, { seg: M.ctx.seg(8), c: mulC(pal.base, 0.7), camo: 0 });
  }
  // ---- landing gear
  if (S.gear === 'skids') {
    g.mirror(() => {
      g.cylX(-0.3, 0.62, 0.035, 0.2, 0.016, { seg: 5, c: pal.gun, camo: 0 });
      g.beam([0.4, 0.035, 0.2], [0.36, 0.24, 0.08], 0.016, { c: pal.gun });
      g.beam([-0.12, 0.035, 0.2], [-0.12, 0.26, 0.08], 0.016, { c: pal.gun });
    });
  } else {
    g.mirror(() => {
      g.beam([0.42, 0.26, bw * 0.7], [0.5, 0.1, bw + 0.09], 0.024, { c: pal.gun });
      wheel(g, 0.5, 0.07, bw + 0.1, 0.07, 0.05, { side: 1, seg: 8 });
    });
    g.beam([-1.0, 0.5, 0], [-1.04, 0.09, 0], 0.016, { c: pal.gun });
    wheel(g, -1.04, 0.05, 0, 0.05, 0.04, { side: 1, seg: 6 });
  }
  // ---- team markings
  const b0 = st[S.side ? 5 : 6], b1 = st[S.side ? 6 : 7];
  const u0 = 0.25, u1 = 0.4;
  const bs = (u) => ({ x: lerp(b0.x, b1.x, u), y: lerp(b0.y, b1.y, u), w: lerp(b0.w, b1.w, u) * 1.05 + 0.002, h: lerp(b0.h, b1.h, u) * 1.05 + 0.002 });
  fuselage(g, [bs(u0), bs(u1)], { c: pal.team, camo: 0, cap0: false, cap1: false, tone: false, seg: 8 });
  g.pop(); glass.pop();
  // ---- chin gun (yaw pivot)
  const gx = (S.side ? 0.5 : 0.62) * k, gyy = (S.side ? 0.26 : 0.2) * k, gz = S.side ? -bw * k : 0;
  // (the coaxial type has no mesh budget left for a pivot: its cannon is fixed to the hull)
  const T = S.coax ? g : M.part('turret', { at: [gx, gyy, gz] });
  if (!S.coax) M.turretNode = 'turret';
  T.cylY(gx, gyy, gyy + 0.05, gz, 0.04, { seg: 6, c: pal.gun, camo: 0 });
  T.box(gx + 0.03, gyy - 0.01, gz, 0.14, 0.06, 0.07, { c: pal.gun, camo: 0, b: 0.01 });
  const mx = thinBarrel(T, gx + 0.08, 0.3, gyy - 0.015, gz, 0.011, { seg: 5 });
  M.muzzle(mx, gyy - 0.015, gz, S.coax ? 'body' : 'turret');
  // ---- main rotor(s)
  const R = 1.1 * k;
  if (S.coax) {
    mainRotor(M, 'rotor', -0.02 * k, hubY * k, 0, R * 0.92, 3, 22, { chord: 0.085 });
    mainRotor(M, 'rotor2', -0.02 * k, (hubY + 0.17) * k, 0, R * 0.92, 3, -22, { chord: 0.085, phase: 0.5 });
  } else mainRotor(M, 'rotor', -0.02 * k, hubY * k, 0, R, S.blades, 22, { chord: S.chord });
  return { kind: 'helo', radius: 0.95 * k, height: (hubY + 0.08) * k };
}

function buildTransport(M, def, fam) {
  const { pal, hi } = M.ctx;
  const g = M.part('hull').camo(1);
  const glass = M.part('hull', { mat: 'glass' });
  const tint = [0.04, 0.055, 0.065];
  if (fam === 'ch47') {
    const bw = 0.2;
    fuselage(g, [
      { x: 1.22, y: 0.36, w: 0.02, h: 0.02 }, { x: 1.12, y: 0.38, w: bw * 0.62, h: 0.11, e: 2.6 }, { x: 0.9, y: 0.42, w: bw * 0.95, h: 0.19, e: 3.4 },
      { x: 0.6, y: 0.43, w: bw, h: 0.21, e: 3.6 }, { x: -0.75, y: 0.43, w: bw, h: 0.21, e: 3.6 }, { x: -1.05, y: 0.5, w: bw * 0.9, h: 0.16, e: 3.2 }, { x: -1.24, y: 0.56, w: bw * 0.5, h: 0.08, e: 2.6 },
    ], { camo: 2, cap0: false });
    // cockpit glazing
    fuselage(glass, [{ x: 1.14, y: 0.45, w: bw * 0.6, h: 0.05, e: 3.4 }, { x: 1.0, y: 0.52, w: bw * 0.86, h: 0.085, e: 3.6 }, { x: 0.86, y: 0.545, w: bw * 0.9, h: 0.075, e: 3.6 }], { c: tint, seg: 8, crease: 25 });
    if (hi) for (const s of [1, -1]) for (let i = 0; i < 4; i++) glass.cylZ(0.4 - i * 0.3, 0.5, s * (bw + 0.001) - 0.004, s * (bw + 0.001) + 0.004, 0.04, { seg: 8, c: tint });
    // forward + aft rotor pylons
    fuselage(g, [{ x: 1.0, y: 0.66, w: 0.09, h: 0.04, e: 2.6 }, { x: 0.84, y: 0.72, w: 0.11, h: 0.1, e: 2.6 }, { x: 0.6, y: 0.68, w: 0.08, h: 0.05, e: 2.6 }], { camo: 2, seg: 8, tess: 0 });
    fuselage(g, [{ x: -0.52, y: 0.66, w: 0.07, h: 0.04, e: 2.6 }, { x: -0.8, y: 0.82, w: 0.1, h: 0.2, e: 2.8 }, { x: -1.06, y: 0.86, w: 0.07, h: 0.19, e: 2.6 }, { x: -1.22, y: 0.82, w: 0.03, h: 0.12, e: 2.4 }], { camo: 2, seg: 8 });
    // side fuel sponsons
    g.mirror(() => {
      fuselage(g, [{ x: 0.72, y: 0.28, z: bw + 0.02, w: 0.03, h: 0.05, e: 2.6 }, { x: 0.5, y: 0.27, z: bw + 0.04, w: 0.07, h: 0.085, e: 3 }, { x: -0.7, y: 0.27, z: bw + 0.04, w: 0.07, h: 0.085, e: 3 }, { x: -0.92, y: 0.29, z: bw + 0.02, w: 0.03, h: 0.05, e: 2.6 }], { camo: 2, seg: 8, tess: 0 });
      // engine pods on the aft pylon
      g.lathe('x', [[-0.56, 0.04], [-0.6, 0.07], [-0.96, 0.07], [-1.02, 0.05], [-1.02, 0.03]], { at: [0, 0.68, bw + 0.03], seg: M.ctx.seg(8), camo: 1, crease: 45 });
      g.lathe('x', [[-0.558, 0.035], [-0.57, 0]], { at: [0, 0.68, bw + 0.03], seg: 8, c: pal.black, camo: 0, cap0: false, cap1: false, flip: true, tone: false });
      for (const x of [0.62, -0.72]) { g.beam([x, 0.2, bw + 0.03], [x, 0.08, bw + 0.05], 0.024, { c: pal.gun }); wheel(g, x, 0.07, bw + 0.07, 0.07, 0.05, { side: 1, seg: 8 }); }
      g.box(0.0, 0.58, bw - 0.005, 0.3, 0.1, 0.012, { c: pal.team, camo: 0, b: 0.003, tone: false, rot: [0, 0, -0.12] });
    });
    for (const s of [1, -1]) M.exhaust(-1.03, 0.68, s * (bw + 0.03));
    g.box(-0.1, 0.646, 0, 0.5, 0.012, 0.2, { c: pal.team, camo: 0, b: 0.003, tone: false });
    // rear ramp outline
    g.box(-1.14, 0.42, 0, 0.012, 0.2, bw * 1.3, { c: mulC(pal.base, 0.75), camo: 0, b: 0, rot: [0, 0.5, 0] });
    g.cylY(0.84, 0.8, 0.9, 0, 0.03, { seg: 6, c: pal.gun, camo: 0 });
    g.cylY(-0.92, 1.0, 1.1, 0, 0.03, { seg: 6, c: pal.gun, camo: 0 });
    mainRotor(M, 'rotor', 0.84, 0.9, 0, 1.0, 3, 20, { chord: 0.1 });
    mainRotor(M, 'rotor2', -0.92, 1.1, 0, 1.0, 3, -20, { chord: 0.1, phase: 1.05 });
    M.muzzle(0.5, 0.42, bw + 0.02); M.muzzle(0.5, 0.42, -bw - 0.02);
    return { kind: 'helo', radius: 1.25, height: 1.16 };
  }
  // UH-60 style medium utility helicopter
  const bw = 0.17;
  fuselage(g, [
    { x: 1.08, y: 0.34, w: 0.015, h: 0.015 }, { x: 0.96, y: 0.35, w: bw * 0.6, h: 0.08, e: 2.6 }, { x: 0.72, y: 0.4, w: bw * 0.95, h: 0.15, e: 3 },
    { x: 0.4, y: 0.43, w: bw, h: 0.19, e: 3.4 }, { x: -0.3, y: 0.43, w: bw, h: 0.19, e: 3.4 }, { x: -0.56, y: 0.48, w: bw * 0.62, h: 0.12, e: 2.6 },
    { x: -0.8, y: 0.52, w: 0.06, h: 0.07 }, { x: -1.24, y: 0.58, w: 0.035, h: 0.045 }, { x: -1.3, y: 0.58, w: 0.012, h: 0.015 },
  ], { camo: 2, cap0: false, cap1: false });
  fuselage(glass, [{ x: 0.98, y: 0.42, w: bw * 0.56, h: 0.035, e: 3.4 }, { x: 0.84, y: 0.5, w: bw * 0.84, h: 0.075, e: 3.6 }, { x: 0.66, y: 0.54, w: bw * 0.9, h: 0.07, e: 3.6 }], { c: tint, seg: 8, crease: 25 });
  for (const s of [1, -1]) {
    glass.box(0.3, 0.5, s * (bw + 0.002), 0.16, 0.09, 0.006, { c: tint, b: 0 });
    glass.box(0.02, 0.5, s * (bw + 0.002), 0.16, 0.09, 0.006, { c: tint, b: 0 });
    g.box(0.16, 0.43, s * (bw + 0.004), 0.5, 0.3, 0.008, { c: mulC(pal.base, 0.92), camo: 1, b: 0 }); // sliding door
    g.box(-0.4, 0.5, s * (bw - 0.03), 0.22, 0.1, 0.012, { c: pal.team, camo: 0, b: 0.003, tone: false });
  }
  // engines + rotor head fairing
  g.mirror(() => {
    g.lathe('x', [[0.2, 0.04], [0.14, 0.07], [-0.34, 0.07], [-0.44, 0.05], [-0.44, 0.03]], { at: [0, 0.66, 0.1], seg: M.ctx.seg(8), camo: 1, crease: 45 });
    g.lathe('x', [[0.202, 0.035], [0.19, 0]], { at: [0, 0.66, 0.1], seg: 8, c: pal.black, camo: 0, cap0: false, cap1: false, flip: true, tone: false });
    g.beam([0.36, 0.3, bw * 0.9], [0.4, 0.1, bw + 0.1], 0.026, { c: pal.gun });
    wheel(g, 0.4, 0.075, bw + 0.11, 0.075, 0.055, { side: 1, seg: 8 });
    // stabilator
    wing(g, { x: -1.08, y: 0.56, z0: 0.02, chord: 0.2, tip: 0.15, span: 0.3, sweep: 6, t: 0.022, camo: 1, teamTip: 0.3 });
  });
  for (const s of [1, -1]) M.exhaust(-0.45, 0.66, s * 0.1);
  fuselage(g, [{ x: 0.3, y: 0.66, w: 0.09, h: 0.06, e: 2.6 }, { x: 0.0, y: 0.7, w: 0.1, h: 0.08, e: 2.6 }, { x: -0.5, y: 0.62, w: 0.06, h: 0.05, e: 2.4 }], { camo: 2, seg: 8, tess: 0 });
  g.box(0.1, 0.624, 0, 0.36, 0.012, 0.12, { c: pal.team, camo: 0, b: 0.003, tone: false, rot: [0, 0, 0] });
  fin(g, { x: -0.98, y: 0.58, z: 0, h: 0.42, chord: 0.3, tip: 0.16, sweep: 40, t: 0.035 });
  g.beam([-0.9, 0.5, 0], [-0.94, 0.09, 0], 0.018, { c: pal.gun });
  wheel(g, -0.94, 0.05, 0, 0.05, 0.04, { side: 1, seg: 6 });
  g.cylY(0.0, 0.76, 0.86, 0, 0.03, { seg: 6, c: pal.gun, camo: 0 });
  const tr = M.part('tail', { at: [-1.28, 0.92, -0.06], mat: 'rotorDisc' });
  flatRotor(tr, -1.28, 0.92, -0.06, 0.24, 4, { axis: 'z' });
  M.spin('tail', 'z', 52);
  // door guns
  for (const s of [1, -1]) { thinBarrel(g, 0.5, 0.2, 0.46, s * (bw + 0.02), 0.008, { seg: 5 }); M.muzzle(0.7, 0.46, s * (bw + 0.02)); }
  mainRotor(M, 'rotor', 0.0, 0.86, 0, 1.12, 4, 22, {});
  return { kind: 'helo', radius: 1.05, height: 0.94 };
}

// ---------------------------------------------------------------- UAVs

function droneFamily(def) {
  const n = def.name || '';
  if (/K[ıi]z[ıi]lelma/i.test(n)) return 'kizil';
  if (/Karrar/i.test(n)) return 'karrar';
  if (/Shahed-136|Geran|Harop|Harpy/i.test(n)) return 'shahed';
  if (/Ak[ıi]nc[ıi]/i.test(n)) return 'akinci';
  if (/Mohajer/i.test(n)) return 'mohajer';
  if (/Hermes|Heron|Wing Loong|Predator|Reaper|Shahed-129|Anka/i.test(n)) return 'hermes';
  return 'tb2';
}

function prop(M, x, y, z, R, n, speed, name = 'prop') {
  const p = M.part(name, { at: [x, y, z], mat: 'rotorDisc' });
  flatRotor(p, x, y, z, R, n, { axis: 'x', chord: R * 0.2 });
  M.spin(name, 'x', speed);
}

function eoBall(glass, g, x, y, z, r) {
  g.cylY(x, y, y + r * 1.2, z, r * 0.5, { seg: 6, c: g.ctx.pal.gun, camo: 0 });
  glass.sphere(x, y, z, r, { seg: g.ctx.seg(8), c: [0.02, 0.03, 0.04] });
}

function munition(M, g, x, y, z, len = 0.26, r = 0.018) {
  const { pal } = g.ctx;
  g.box(x + len * 0.4, y + r + 0.012, z, len * 0.4, 0.024, 0.01, { c: pal.gun, camo: 0, b: 0 });
  missile(g, x, y, z, { len, r, c: pal.missileW, tip: pal.gun, fins: 4, finAt: [0.0, 0.5], finLen: len * 0.16, finH: r * 1.5, nose: 'round', seg: 5 });
  M.muzzle(x + len, y, z);
}

export function buildDrone(M, def) {
  const { pal, hi } = M.ctx;
  const fam = droneFamily(def);
  const g = M.part('hull').camo(0);
  const glass = M.part('hull', { mat: 'glass' });
  const base = pal.base, dk = mulC(pal.base, 0.82);
  const CY = 0.24;
  const teamBand = (st, u0, u1) => {
    const bs = (u) => { const a = st[0], b = st[1]; return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), w: lerp(a.w, b.w, u) * 1.03 + 0.002, h: lerp(a.h, b.h, u) * 1.03 + 0.002, e: a.e }; };
    fuselage(g, [bs(u0), bs(u1)], { c: pal.team, cap0: false, cap1: false, tone: false, seg: 8 });
  };
  const gear = (xs, zh, y0) => {
    if (!hi) return;
    g.beam([xs[0], y0, 0], [xs[0] + 0.03, 0.05, 0], 0.012, { c: pal.gun });
    wheel(g, xs[0] + 0.03, 0.04, 0, 0.04, 0.03, { side: 1, seg: 6 });
    for (const s of [1, -1]) { g.beam([xs[1], y0, s * 0.03], [xs[1] - 0.02, 0.05, s * zh], 0.012, { c: pal.gun }); wheel(g, xs[1] - 0.02, 0.04, s * zh, 0.04, 0.03, { side: s, seg: 6 }); }
  };
  if (fam === 'kizil') {
    // jet UCAV: chined fuselage, canards, cropped delta, twin canted fins
    const k = 0.8;
    const E = M.part('hull', { mat: 'emissive' });
    g.push().scale(k, k, k); E.push().scale(k, k, k);
    const st = [{ x: 1.1, y: CY, w: 0.004, h: 0.004 }, { x: 0.8, y: CY + 0.01, w: 0.09, h: 0.05, e: 2.6 }, { x: 0.3, y: CY + 0.03, w: 0.17, h: 0.1, e: 3 }, { x: -0.4, y: CY + 0.03, w: 0.17, h: 0.11, e: 3 }, { x: -0.9, y: CY + 0.03, w: 0.11, h: 0.1, e: 2.4 }];
    fuselage(g, st, { c: dk, cap0: false });
    fuselage(g, [{ x: 0.5, y: CY + 0.1, w: 0.05, h: 0.03 }, { x: 0.2, y: CY + 0.14, w: 0.075, h: 0.045 }, { x: -0.5, y: CY + 0.1, w: 0.05, h: 0.03 }], { c: dk, seg: 8 }); // dorsal hump
    g.mirror(() => {
      wing(g, { x: 0.1, y: CY + 0.02, z0: 0.15, chord: 0.86, tip: 0.16, span: 0.52, sweep: 46, t: 0.03, c: dk, camo: 0, teamTip: 0.22, tipDx: 0.1 });
      wing(g, { x: 0.52, y: CY + 0.05, z0: 0.13, chord: 0.26, tip: 0.08, span: 0.26, sweep: 46, t: 0.02, c: dk, camo: 0, teamTip: 0.34 });
      fin(g, { x: -0.5, y: CY + 0.1, z: 0.13, h: 0.36, chord: 0.4, tip: 0.16, sweep: 42, cant: 0.45, c: dk });
      g.box(0.44, CY + 0.0, 0.19, 0.012, 0.09, 0.07, { c: pal.black, b: 0, tone: false, rot: [0.4, 0, 0] });
    });
    fuselage(g, [{ x: 0.12, y: CY + 0.03, w: 0.172, h: 0.102, e: 3 }, { x: 0.04, y: CY + 0.03, w: 0.172, h: 0.103, e: 3 }], { c: pal.team, cap0: false, cap1: false, tone: false });
    nozzle(M, g, E, -0.9, CY + 0.03, 0, 0.09, { scale: k });
    g.pop(); E.pop();
    for (const s of [1, -1]) M.muzzle(0.3 * k, (CY - 0.06) * k, s * 0.1 * k);
    return { kind: 'drone', radius: 0.75, height: 0.5 };
  }
  if (fam === 'karrar') {
    // jet-powered target-drone derivative: cigar body, mid swept wing, dorsal engine, twin fins
    const E = M.part('hull', { mat: 'emissive' });
    const st = [{ x: 0.72, y: CY, w: 0.004, h: 0.004 }, { x: 0.52, y: CY, w: 0.07, h: 0.07 }, { x: 0.2, y: CY, w: 0.095, h: 0.095 }, { x: -0.45, y: CY, w: 0.095, h: 0.095 }, { x: -0.7, y: CY, w: 0.05, h: 0.05 }];
    fuselage(g, st, { c: base, cap0: false });
    fuselage(g, [{ x: 0.72, y: CY, w: 0.004, h: 0.004 }, { x: 0.62, y: CY, w: 0.036, h: 0.036 }, { x: 0.52, y: CY, w: 0.071, h: 0.071 }], { c: pal.orange, cap0: false, cap1: false, tone: false });
    fuselage(g, [{ x: 0.0, y: CY + 0.13, w: 0.06, h: 0.06 }, { x: -0.5, y: CY + 0.14, w: 0.065, h: 0.065 }], { c: dk, seg: 8 });
    g.lathe('x', [[0.002, 0.045], [-0.01, 0]], { at: [0, CY + 0.13, 0], seg: 8, c: pal.black, cap0: false, cap1: false, flip: true, tone: false });
    nozzle(M, g, E, -0.5, CY + 0.14, 0, 0.055, {});
    g.mirror(() => {
      wing(g, { x: 0.12, y: CY - 0.02, z0: 0.08, chord: 0.42, tip: 0.16, span: 0.5, sweep: 36, t: 0.026, c: base, camo: 0, teamTip: 0.24 });
      wing(g, { x: -0.44, y: CY + 0.02, z0: 0.04, chord: 0.22, tip: 0.12, span: 0.26, sweep: 30, t: 0.02, c: base, camo: 0 });
      fin(g, { x: -0.5, y: CY + 0.02, z: 0.26, h: 0.2, chord: 0.2, tip: 0.1, sweep: 34, c: base, t: 0.02 });
    });
    missile(g, -0.1, CY - 0.14, 0, { len: 0.42, r: 0.04, c: pal.missileG, tip: pal.missileG, band: pal.yellow, fins: 4, finAt: [0], finLen: 0.08, finH: 0.035, nose: 'round', seg: 6 });
    M.muzzle(0.34, CY - 0.14, 0);
    return { kind: 'drone', radius: 0.65, height: 0.48 };
  }
  if (fam === 'shahed') {
    // loitering munition: cropped delta flying wing, tip fins, pusher prop
    const st = [{ x: 0.62, y: CY, w: 0.004, h: 0.004 }, { x: 0.5, y: CY, w: 0.05, h: 0.05 }, { x: 0.2, y: CY, w: 0.075, h: 0.075 }, { x: -0.36, y: CY, w: 0.07, h: 0.07 }, { x: -0.5, y: CY, w: 0.045, h: 0.045 }];
    fuselage(g, st, { c: base, cap0: false });
    fuselage(g, [{ x: 0.62, y: CY, w: 0.004, h: 0.004 }, { x: 0.56, y: CY, w: 0.028, h: 0.028 }, { x: 0.5, y: CY, w: 0.051, h: 0.051 }], { c: pal.gun, cap0: false, cap1: false, tone: false });
    g.mirror(() => {
      wing(g, { x: 0.34, y: CY - 0.01, z0: 0.03, chord: 0.8, tip: 0.24, span: 0.56, sweep: 46, t: 0.03, c: base, camo: 0, teamTip: 0.2, flap: true });
      g.prismZ([[-0.24, CY - 0.13], [-0.02, CY - 0.13], [-0.14, CY + 0.13], [-0.3, CY + 0.13]], 0.58, 0.6, { c: pal.team, b: 0.006, tone: false });
    });
    fuselage(g, [{ x: 0.12, y: CY, w: 0.077, h: 0.077 }, { x: 0.05, y: CY, w: 0.077, h: 0.077 }], { c: pal.team, cap0: false, cap1: false, tone: false });
    g.box(-0.5, CY, 0, 0.06, 0.07, 0.07, { c: pal.gun, b: 0.012 });
    prop(M, -0.545, CY, 0, 0.16, 2, 60);
    M.muzzle(0.62, CY, 0);
    M.exhaust(-0.55, CY, 0);
    return { kind: 'drone', radius: 0.6, height: 0.42 };
  }
  // ---- propeller MALE UAVs
  const big = fam === 'akinci';
  const span = big ? 0.98 : fam === 'hermes' ? 0.84 : fam === 'mohajer' ? 0.76 : 0.8;
  const st = fam === 'hermes'
    ? [{ x: 0.74, y: CY + 0.01, w: 0.004, h: 0.004 }, { x: 0.62, y: CY + 0.02, w: 0.07, h: 0.08 }, { x: 0.42, y: CY + 0.03, w: 0.085, h: 0.1 }, { x: 0.2, y: CY, w: 0.065, h: 0.07 }, { x: -0.5, y: CY, w: 0.06, h: 0.065 }, { x: -0.62, y: CY, w: 0.04, h: 0.045 }]
    : big
      ? [{ x: 0.82, y: CY, w: 0.004, h: 0.004 }, { x: 0.66, y: CY + 0.03, w: 0.085, h: 0.1 }, { x: 0.4, y: CY + 0.04, w: 0.1, h: 0.12 }, { x: 0.0, y: CY + 0.01, w: 0.095, h: 0.1, e: 2.6 }, { x: -0.5, y: CY + 0.01, w: 0.07, h: 0.075 }, { x: -0.72, y: CY + 0.02, w: 0.02, h: 0.03 }]
      : [{ x: 0.56, y: CY, w: 0.004, h: 0.004 }, { x: 0.44, y: CY + 0.01, w: 0.06, h: 0.07 }, { x: 0.24, y: CY + 0.015, w: 0.075, h: 0.085, e: 2.6 }, { x: -0.2, y: CY + 0.01, w: 0.075, h: 0.085, e: 2.6 }, { x: -0.36, y: CY + 0.01, w: 0.05, h: 0.06 }];
  fuselage(g, st, { c: base, cap0: false });
  teamBand([st[2], st[3]], 0.35, 0.6);
  eoBall(glass, g, st[1].x - 0.06, CY - 0.1, 0, 0.045);
  const wy = fam === 'mohajer' || fam === 'hermes' ? CY + 0.1 : CY + 0.06;
  if (fam === 'hermes') g.box(0.0, CY + 0.075, 0, 0.16, 0.06, 0.03, { c: dk, b: 0.008 }); // wing pylon
  if (fam === 'mohajer') g.box(0.0, CY + 0.09, 0, 0.3, 0.03, 0.12, { c: dk, b: 0.008 });
  g.mirror(() => {
    if (big) {
      // cranked wing: inboard dihedral, outboard flat; wing-mounted turboprops
      wing(g, { x: 0.12, y: wy, z0: 0.06, chord: 0.24, tip: 0.19, span: 0.36, sweep: 4, t: 0.028, c: base, camo: 0, dih: 0.2 });
      wing(g, { x: 0.095, y: wy + Math.sin(0.2) * 0.36, z0: 0.06 + 0.35, chord: 0.19, tip: 0.09, span: span - 0.36, sweep: 5, t: 0.024, c: base, camo: 0, teamTip: 0.22, flap: true });
      g.lathe('x', [[0.3, 0.012], [0.26, 0.04], [-0.06, 0.045], [-0.16, 0.02]], { at: [0, wy + 0.04, 0.3], seg: 8, c: dk, crease: 60 });
    } else {
      wing(g, { x: fam === 'mohajer' ? 0.1 : 0.08, y: wy, z0: 0.02, chord: fam === 'mohajer' ? 0.2 : 0.16, tip: fam === 'mohajer' ? 0.16 : 0.07, span, sweep: fam === 'tb2' ? 3 : 1, t: 0.024, c: base, camo: 0, teamTip: 0.16, flap: true });
    }
    if (fam === 'tb2' || fam === 'mohajer') {
      // tail booms
      const bz = fam === 'tb2' ? 0.2 : 0.17;
      g.cylX(-0.72, 0.02, wy - 0.01, bz, 0.016, { seg: 6, c: dk });
      if (fam === 'tb2') {
        // inverted-V tail joining the booms
        g.at(-0.62, wy - 0.01, bz, () => g.prismY([[0, 0], [-0.03, -0.26], [-0.16, -0.26], [-0.14, 0]], -0.01, 0.01, { c: base, b: 0.004 }), 0, 0, -0.95);
        g.box(-0.72, wy + 0.19, 0.045, 0.1, 0.02, 0.06, { c: pal.team, b: 0, tone: false, rot: [0, 0, 0.95] });
      } else {
        fin(g, { x: -0.56, y: wy - 0.03, z: bz, h: 0.2, chord: 0.18, tip: 0.1, sweep: 25, c: base, t: 0.018 });
      }
    } else {
      // V-tail on the fuselage
      const tx = big ? -0.5 : -0.42;
      g.at(tx, CY + 0.04, 0.02, () => g.prismY([[0, 0], [-0.1, 0.3], [-0.2, 0.3], [-0.16, 0]], -0.011, 0.011, { c: base, b: 0.004 }), 0, 0, -0.75);
      g.at(tx, CY + 0.04, 0.02, () => g.prismY([[-0.075, 0.225], [-0.1, 0.3], [-0.2, 0.3], [-0.19, 0.225]], -0.013, 0.013, { c: pal.team, b: 0.004, tone: false }), 0, 0, -0.75);
    }
    munition(M, g, -0.02, wy - 0.06, span * 0.36, big ? 0.3 : 0.24, big ? 0.022 : 0.017);
    if (big || fam === 'hermes') munition(M, g, -0.02, wy - 0.06, span * 0.6, 0.24, 0.017);
  });
  if (fam === 'mohajer') { g.box(-0.6, wy + 0.17, 0, 0.14, 0.014, 0.36, { c: base, b: 0.004 }); g.box(-0.6, wy + 0.178, 0, 0.14, 0.006, 0.12, { c: pal.team, b: 0, tone: false }); }
  if (big) {
    fin(g, { x: -0.5, y: CY - 0.02, z: 0, h: -0.14, chord: 0.18, tip: 0.1, sweep: -20, c: base, team: false, t: 0.016 });
    prop(M, 0.305, wy + 0.04, 0.3, 0.13, 3, 70, 'prop');
    prop(M, 0.305, wy + 0.04, -0.3, 0.13, 3, -70, 'prop2');
    M.exhaust(-0.16, wy + 0.04, 0.3); M.exhaust(-0.16, wy + 0.04, -0.3);
    gear([0.5, -0.05], 0.3, CY - 0.06);
  } else {
    const px = st[st.length - 1].x - 0.035;
    g.box(px + 0.04, CY + 0.01, 0, 0.05, 0.05, 0.05, { c: pal.gun, b: 0.01 });
    prop(M, px, CY + 0.01, 0, 0.14, fam === 'tb2' ? 2 : 3, 70);
    M.exhaust(px, CY + 0.01, 0);
    gear([0.34, -0.1], 0.14, CY - 0.05);
  }
  // satcom bulge / antenna
  if (hi) g.box(0.0, wy + 0.03, 0, 0.012, 0.06, 0.03, { c: pal.gun, b: 0 });
  return { kind: 'drone', radius: big ? 0.95 : 0.8, height: 0.5 };
}
