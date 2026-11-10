// Faction structures: parametric SAM batteries, unique buildings and superweapon complexes.

import { DEG, TAU, mixC, mulC, lerp } from './geo.js';
import {
  lattice, dish, radarPanel, sandbagWall, flagPole, hazardStrip, canister, tubeBank, tubeBundle, missile,
} from './parts.js';
import {
  PADH, pad, house, door, windows, chimney, tankV, mast, radome, container, floodlight, pipeRun, wallRun, crates,
} from './site.js';
import { fuselage } from './air.js';

// ---------------------------------------------------------------- small props

function miniJet(g, x, y, z, ry, o = {}) {
  const { pal } = g.ctx;
  const c = o.c || mulC(pal.steelLt, 0.95), s = o.s || 1;
  g.at(x, y, z, () => {
    g.push().scale(s, s, s);
    fuselage(g, [{ x: 0.62, y: 0.14, w: 0.004, h: 0.004 }, { x: 0.4, y: 0.15, w: 0.05, h: 0.05 }, { x: 0.0, y: 0.16, w: 0.085, h: 0.07, e: 2.8 }, { x: -0.5, y: 0.16, w: 0.08, h: 0.06, e: 2.8 }, { x: -0.6, y: 0.16, w: 0.05, h: 0.045 }], { c, seg: 8, cap0: false });
    g.prismY([[0.12, 0], [-0.3, 0.36], [-0.44, 0.36], [-0.4, 0], [-0.44, -0.36], [-0.3, -0.36]], 0.13, 0.155, { c, b: 0.006 });
    g.prismY([[-0.36, 0], [-0.54, 0.2], [-0.62, 0.2], [-0.6, 0], [-0.62, -0.2], [-0.54, -0.2]], 0.14, 0.158, { c, b: 0 });
    for (const sgn of o.twin ? [1, -1] : [0]) g.at(0, 0.2, sgn * 0.07, () => g.prismZ([[-0.3, 0], [-0.5, 0.2], [-0.58, 0.2], [-0.56, 0]], -0.008, 0.008, { c: pal.team, b: 0, tone: false }), 0, 0, sgn * 0.35);
    g.box(0.24, 0.205, 0, 0.16, 0.03, 0.05, { c: pal.glassD, b: 0.008, tone: false });
    // landing gear stubs
    for (const [gx, gz] of [[0.3, 0], [-0.2, 0.1], [-0.2, -0.1]]) g.cylY(gx, 0, 0.1, gz, 0.012, { seg: 4, c: pal.gun });
    g.pop();
  }, ry);
}

function shahed(g, x, y, z, ry, rz, s = 1) {
  const { pal } = g.ctx;
  const c = mixC(pal.white, pal.sandbag, 0.45);
  g.at(x, y, z, () => {
    g.push().scale(s, s, s);
    g.lathe('x', [[0.3, 0.003], [0.2, 0.04], [-0.2, 0.04], [-0.26, 0.025]], { seg: 6, c, crease: 60 });
    g.prismY([[0.16, 0], [-0.22, 0.26], [-0.28, 0.26], [-0.24, 0], [-0.28, -0.26], [-0.22, -0.26]], -0.008, 0.008, { c, b: 0 });
    for (const sg of [1, -1]) g.box(-0.24, 0, sg * 0.26, 0.1, 0.1, 0.008, { c: pal.team, b: 0, tone: false });
    g.pop();
  }, ry, rz);
}

function bunker(M, g, em, x, z, sx, sz, o = {}) {
  const { pal } = g.ctx;
  const h = o.h ?? 0.7;
  g.tbox(x, PADH + h / 2, z, sx, h, sz, sx * 0.86, sz * 0.84, { c: pal.concrete, b: 0.04 });
  g.box(x, PADH + h + 0.03, z, sx * 0.8, 0.06, sz * 0.78, { c: pal.team, b: 0.014, tone: false });
  g.box(x, PADH + h + 0.065, z, sx * 0.5, 0.02, sz * 0.5, { c: pal.concreteDk, b: 0 });
  const face = o.face || '+x';
  const s = face[0] === '+' ? 1 : -1;
  if (face[1] === 'x') { g.box(x + s * sx * 0.47, PADH + h * 0.6, z, 0.05, 0.1, sz * 0.6, { c: pal.black, b: 0, tone: false }); if (em) em.box(x + s * (sx * 0.47 + 0.027), PADH + h * 0.6, z, 0.004, 0.04, sz * 0.5, { c: [1.0, 0.65, 0.25], b: 0 }); }
  else { g.box(x, PADH + h * 0.6, z + s * sz * 0.46, sx * 0.6, 0.1, 0.05, { c: pal.black, b: 0, tone: false }); if (em) em.box(x, PADH + h * 0.6, z + s * (sz * 0.46 + 0.027), sx * 0.5, 0.04, 0.004, { c: [1.0, 0.65, 0.25], b: 0 }); }
  g.box(x - sx * 0.2, PADH + 0.24, z - sz * 0.5 + 0.02, 0.3, 0.44, 0.06, { c: pal.gun, b: 0.01 });
  return PADH + h + 0.07;
}

function blastPad(g, x, z, r) {
  const { pal } = g.ctx;
  const y = PADH + 0.005;
  g.disc(x, y, z, r, { c: mixC(pal.concreteDk, pal.black, 0.45) });
  g.disc(x, y + 0.002, z, r * 0.55, { c: mixC(pal.concreteDk, pal.black, 0.75) });
  const n = 12;
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU; g.decal(x + Math.cos(a) * r * 0.93, y + 0.003, z + Math.sin(a) * r * 0.93, r * 0.24, r * 0.1, { c: i % 2 ? pal.hazK : pal.yellow, ry: -a + Math.PI / 2 }); }
}

function launchTable(g, x, z, r, h) {
  const { pal } = g.ctx;
  g.lathe('y', [[PADH + h - 0.08, r * 1.25], [PADH + h, r * 1.25], [PADH + h, r * 0.9], [PADH + h - 0.08, r * 0.9]], { at: [x, 0, z], seg: g.ctx.seg(10), c: pal.gun, crease: 40, cap0: false, cap1: false });
  for (let i = 0; i < 4; i++) { const a = i * TAU / 4 + 0.78; g.beam([x + Math.cos(a) * r * 1.9, PADH, z + Math.sin(a) * r * 1.9], [x + Math.cos(a) * r * 1.1, PADH + h - 0.04, z + Math.sin(a) * r * 1.1], 0.07, { c: pal.steel }); }
}

/** Vertical ballistic missile standing at (x, y0, z). */
function standMissile(M, g, x, y0, z, o) {
  g.at(x, y0, z, () => missile(g, 0, 0, 0, { seg: g.ctx.seg(12), fins: 4, finAt: [0.0], ...o }), 0, Math.PI / 2);
  M.muzzle(x, y0 + o.len, z);
}

function gantry(M, g, x, z, h, arms, o = {}) {
  const { pal, hi } = g.ctx;
  lattice(g, x, PADH, PADH + h, z, o.w ?? 0.5, { w1: o.w ?? 0.5, c: o.c || pal.red, n: hi ? Math.round(h / 0.5) : Math.round(h / 0.9) });
  g.box(x, PADH + h + 0.04, z, (o.w ?? 0.5) + 0.1, 0.08, (o.w ?? 0.5) + 0.1, { c: pal.gun, b: 0.012 });
  for (const a of arms) {
    // a: [y, dx, dz] swing arm reaching toward a missile
    g.beam([x, PADH + a[0], z], [x + a[1], PADH + a[0], z + a[2]], 0.07, { c: pal.steelLt });
    g.box(x + a[1], PADH + a[0], z + a[2], 0.12, 0.12, 0.12, { c: pal.gun, b: 0 });
  }
  g.cylY(x, PADH + h + 0.08, PADH + h + 0.5, z, 0.014, { seg: 4, c: pal.red });
  M.light(x, PADH + h + 0.52, z);
}

function lightPost(M, g, em, x, z, h = 1.5) {
  const { pal } = g.ctx;
  g.cylY(x, PADH, PADH + h, z, 0.03, { seg: 5, c: pal.steel });
  g.box(x, PADH + h + 0.04, z, 0.1, 0.08, 0.1, { c: pal.gun, b: 0 });
  if (em) em.box(x, PADH + h + 0.1, z, 0.06, 0.04, 0.06, { c: [1.0, 0.2, 0.1], b: 0 });
  M.light(x, PADH + h + 0.14, z);
}

// ---------------------------------------------------------------- SAM batteries

function samSpec(def) {
  const n = def.name || '';
  if (/THAAD/i.test(n)) return { L: 'box', nz: 4, ny: 2, cw: 0.2, ch: 0.21, len: 1.5, elev: 64, radar: 'big' };
  if (/Patriot/i.test(n)) return { L: 'box', nz: 2, ny: 2, cw: 0.36, ch: 0.3, len: 1.45, elev: 38, radar: 'panel' };
  if (/S-300|S-400/i.test(n)) return { L: 'tube', n: 4, r: 0.135, len: 1.95, elev: 90, radar: 'mast', second: true };
  if (/HQ-9|HQ-16/i.test(n)) return { L: 'tube', n: 4, r: 0.125, len: 1.8, elev: 90, radar: 'panel', second: true };
  if (/Hisar/i.test(n)) return { L: 'box', nz: 3, ny: 2, cw: 0.21, ch: 0.21, len: 1.1, elev: 90, radar: 'spin' };
  if (/Siper/i.test(n)) return { L: 'box', nz: 2, ny: 2, cw: 0.28, ch: 0.28, len: 1.85, elev: 80, radar: 'panel' };
  if (/Iron Dome/i.test(n)) return { L: 'cell', nz: 4, ny: 5, len: 0.95, w: 0.92, h: 1.1, elev: 60, radar: 'panel' };
  if (/David/i.test(n)) return { L: 'box', nz: 6, ny: 2, cw: 0.165, ch: 0.18, len: 1.5, elev: 82, radar: 'panel' };
  if (/Arrow/i.test(n)) return { L: 'tube', n: 6, r: 0.15, len: 1.75, elev: 90, radar: 'big' };
  if (/Akash|QRSAM/i.test(n)) return { L: 'rail', n: 3, len: 1.35, elev: 36, radar: 'spin' };
  if (/Bavar/i.test(n)) return { L: 'box', nz: 2, ny: 2, cw: 0.27, ch: 0.27, len: 1.7, elev: 86, radar: 'dish' };
  return { L: 'box', nz: 2, ny: 2, cw: 0.3, ch: 0.3, len: 1.4, elev: 45, radar: 'panel' };
}

export function buildSAM(M, def, half) {
  const { pal, hi } = M.ctx;
  const S = samSpec(def);
  const g = M.part('base'), em = M.part('base', { mat: 'emissive' });
  pad(g, half, { c: mixC(pal.concrete, pal.sandbag, 0.25) });
  // blast walls on three sides
  wallRun(g, [-1.66, -1.66], [1.0, -1.66], 0.4, { t: 0.12 });
  wallRun(g, [-1.66, 1.66], [1.0, 1.66], 0.4, { t: 0.12 });
  wallRun(g, [-1.66, -1.2], [-1.66, 1.2], 0.4, { t: 0.12 });
  // command cabin + generator + cables
  const cx = -1.0, cz = 1.02;
  g.box(cx, PADH + 0.36, cz, 0.95, 0.6, 0.6, { c: pal.base, b: 0.03, camo: 0 });
  g.box(cx, PADH + 0.04, cz, 0.8, 0.08, 0.5, { c: pal.gun, b: 0 });
  g.box(cx, PADH + 0.67, cz, 0.6, 0.016, 0.4, { c: pal.team, b: 0, tone: false });
  g.box(cx + 0.48, PADH + 0.34, cz, 0.012, 0.42, 0.24, { c: mulC(pal.base, 0.7), b: 0 });
  if (hi) { g.box(cx - 0.2, PADH + 0.72, cz - 0.1, 0.24, 0.1, 0.24, { c: pal.steelLt, b: 0.014 }); em.box(cx + 0.487, PADH + 0.5, cz + 0.2, 0.004, 0.04, 0.08, { c: [0.3, 1.0, 0.4], b: 0 }); }
  g.cylY(cx - 0.36, PADH + 0.66, PADH + 1.5, cz + 0.2, 0.012, { seg: 4, c: pal.black });
  M.light(cx - 0.36, PADH + 1.52, cz + 0.2);
  g.box(0.2, PADH + 0.2, 1.3, 0.5, 0.3, 0.34, { c: pal.missileG, b: 0.03 });
  g.box(-0.4, PADH + 0.012, 0.7, 0.03, 0.02, 0.7, { c: pal.black, b: 0, tone: false });
  g.box(-0.9, PADH + 0.012, -0.2, 0.03, 0.02, 1.6, { c: pal.black, b: 0, tone: false });
  // ---- radar
  const rx = -1.0, rz = -0.95;
  g.box(rx, PADH + 0.16, rz, 0.9, 0.2, 0.6, { c: pal.base, b: 0.03, camo: 0 });
  g.box(rx, PADH + 0.04, rz, 0.7, 0.08, 0.66, { c: pal.gun, b: 0 });
  const mastH = S.radar === 'mast' ? 1.5 : S.radar === 'spin' ? 0.9 : 0.34;
  if (S.radar === 'mast') lattice(g, rx, PADH + 0.26, PADH + 0.26 + mastH, rz, 0.3, { w1: 0.18, c: pal.steel });
  else g.cylY(rx, PADH + 0.26, PADH + 0.26 + mastH, rz, S.radar === 'spin' ? 0.04 : 0.12, { seg: 8, c: pal.gun, b: 0.01 });
  const ry = PADH + 0.26 + mastH;
  const R = M.part('radar', { at: [rx, ry, rz] });
  R.at(rx, ry, rz, () => {
    R.cylY(0, 0, 0.08, 0, 0.1, { seg: 8, c: pal.gun });
    if (S.radar === 'spin') { R.box(0, 0.16, 0, 0.1, 0.16, 0.9, { c: pal.steelLt, b: 0.016 }); R.box(0.054, 0.16, 0, 0.012, 0.11, 0.8, { c: mulC(pal.steel, 0.8), b: 0 }); }
    else if (S.radar === 'dish') { R.box(-0.06, 0.2, 0, 0.14, 0.3, 0.2, { c: pal.base, b: 0.02, camo: 0 }); dish(R, 0.1, 0.42, 0, 0.42, { c: pal.steelLt }); }
    else {
      const big = S.radar === 'big';
      const w = big ? 1.15 : 0.86, h = big ? 0.95 : 0.7;
      R.box(-0.1, 0.22, 0, 0.26, 0.36, w * 0.6, { c: pal.base, b: 0.03, camo: 0 });
      radarPanel(R, 0.08, 0.14 + h / 2, 0, w, h, { tilt: 0.3, frame: pal.base, c: mulC(pal.steel, 0.75) });
      R.box(0.02, 0.14 + h * 0.98, 0, 0.05, 0.03, w * 0.5, { c: pal.team, b: 0, tone: false, rot: [0, 0.3, 0] });
    }
  });
  M.spin('radar', 'y', S.radar === 'spin' ? 2.4 : 0.7);
  if (S.second) {
    // high-mast acquisition radar
    const sx = 0.9, sz = -1.3;
    lattice(g, sx, PADH, PADH + 2.1, sz, 0.26, { w1: 0.12, c: pal.steel });
    const R2 = M.part('radar2', { at: [sx, PADH + 2.1, sz] });
    R2.cylY(sx, PADH + 2.1, PADH + 2.2, sz, 0.04, { seg: 6, c: pal.gun });
    R2.box(sx, PADH + 2.3, sz, 0.08, 0.2, 0.7, { c: pal.steelLt, b: 0.016 });
    M.spin('radar2', 'y', 1.8);
    M.light(sx, PADH + 2.45, sz);
  }
  // ---- launcher on a rotating mount
  const lx = 0.5, lz = 0.0, ty = PADH + 0.02;
  g.cylY(lx, PADH, PADH + 0.1, lz, 0.82, { seg: M.ctx.seg(14), c: pal.concreteDk });
  hazardStrip(g, lx, PADH + 0.106, lz + 0.72, 0.9, 0.08);
  hazardStrip(g, lx, PADH + 0.106, lz - 0.72, 0.9, 0.08);
  const T = M.part('turret', { at: [lx, ty, lz] });
  M.turretNode = 'turret';
  T.push().translate(lx, ty, lz);
  T.cylY(0, 0.08, 0.2, 0, 0.5, { seg: M.ctx.seg(12), c: pal.gun, b: 0.02 });
  T.box(0, 0.26, 0, 1.3, 0.12, 0.7, { c: pal.base, b: 0.03, camo: 0 }); // turntable deck
  for (const s of [1, -1]) for (const k of [0.56, -0.56]) { T.box(k, 0.2, s * 0.44, 0.1, 0.1, 0.24, { c: pal.gun, b: 0 }); T.cylY(k, 0.08, 0.2, s * 0.56, 0.035, { seg: 5, c: pal.steelLt }); }
  const el = S.elev * DEG;
  const pivX = -0.5, pivY = 0.36;
  // elevating struts
  if (S.elev < 88) for (const s of [1, -1]) T.pipe([0.2, 0.32, s * 0.22], [pivX + Math.cos(el) * 0.7, pivY + Math.sin(el) * 0.7 - 0.02, s * 0.22], 0.04, { seg: 6, c: pal.steelLt });
  else for (const s of [1, -1]) T.beam([0.1, 0.32, s * 0.3], [pivX + 0.12, pivY + 0.8, s * 0.3], 0.05, { c: pal.gun });
  for (const s of [1, -1]) T.box(pivX, pivY - 0.02, s * 0.32, 0.2, 0.16, 0.06, { c: pal.gun, b: 0.014 });
  const tips = [];
  T.push().translate(pivX, pivY, 0).rotZ(el);
  if (S.L === 'box') {
    const W = S.nz * S.cw + (S.nz - 1) * 0.02, H = S.ny * S.ch + (S.ny - 1) * 0.02;
    T.box(S.len * 0.4, -0.04, 0, S.len * 0.8, 0.06, W * 0.5, { c: mulC(pal.base, 0.6), b: 0.012, camo: 0 });
    for (let i = 0; i < S.nz; i++) for (let j = 0; j < S.ny; j++) {
      const z = -W / 2 + S.cw / 2 + i * (S.cw + 0.02), y = S.ch / 2 + j * (S.ch + 0.02);
      T.box(S.len / 2, y, z, S.len, S.ch, S.cw, { c: pal.base, b: 0.016, camo: 1, toneAmt: 0.07 });
      T.box(S.len + 0.004, y, z, 0.008, S.ch * 0.82, S.cw * 0.82, { c: (i + j) % 2 ? pal.warhead : mulC(pal.warhead, 0.8), b: 0, tone: false });
      if (hi) for (const u of [0.25, 0.7]) T.box(S.len * u, y, z, 0.03, S.ch + 0.012, S.cw + 0.012, { c: mulC(pal.base, 0.72), b: 0 });
      if (j === S.ny - 1) tips.push([S.len, y, z]);
    }
    T.box(S.len * 0.45, H + 0.008, 0, S.len * 0.3, 0.012, W * 0.7, { c: pal.team, b: 0, tone: false });
  } else if (S.L === 'tube') {
    const cols = S.n > 4 ? 3 : 2, rows = S.n / cols;
    const pitch = S.r * 2.15;
    T.box(S.len * 0.4, -0.04, 0, S.len * 0.8, 0.06, pitch * cols * 0.5, { c: mulC(pal.base, 0.6), b: 0.012, camo: 0 });
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const z = (i - (cols - 1) / 2) * pitch, y = S.r + j * pitch;
      canister(T, 0, S.len, y, z, S.r, { c: (i + j) % 2 ? pal.base : mulC(pal.base, 0.92), ribs: 4, seg: M.ctx.seg(10), front: pal.warhead });
      if (j === rows - 1) tips.push([S.len, y, z]);
    }
    for (const u of [0.2, 0.75]) T.box(S.len * u, pitch * rows / 2, 0, 0.06, pitch * rows + 0.04, pitch * cols + 0.04, { c: pal.gun, b: 0.01 });
    T.box(S.len * 0.5, pitch * rows + 0.03, 0, 0.3, 0.012, pitch * cols * 0.7, { c: pal.team, b: 0, tone: false });
  } else if (S.L === 'cell') {
    tubeBank(T, S.len / 2, S.h / 2, 0, S.len, S.w, S.h, S.nz, S.ny, { c: pal.base, camo: 1, fill: 0.34, tip: pal.missileG, empty: 0.3, b: 0.02 });
    T.box(S.len * 0.4, S.h + 0.008, 0, S.len * 0.4, 0.012, S.w * 0.7, { c: pal.team, b: 0, tone: false });
    for (const s of [1, -1]) T.box(S.len * 0.5, S.h * 0.5, s * (S.w / 2 + 0.01), S.len * 0.8, S.h * 0.5, 0.02, { c: mulC(pal.base, 0.8), b: 0 });
    tips.push([S.len, S.h * 0.75, 0.2], [S.len, S.h * 0.75, -0.2]);
  } else {
    T.box(S.len * 0.42, 0.0, 0, S.len * 0.86, 0.1, 0.8, { c: pal.gun, b: 0.016 });
    for (let i = 0; i < S.n; i++) {
      const z = (i - (S.n - 1) / 2) * 0.3;
      T.box(S.len * 0.4, 0.08, z, S.len * 0.8, 0.05, 0.06, { c: pal.steel, b: 0 });
      missile(T, -0.1, 0.19, z, { len: S.len, r: 0.085, c: pal.missileW, tip: pal.missileG, band: pal.team, fins: 4, finAt: [0.0, 0.45], finLen: 0.2, finH: 0.1, seg: M.ctx.seg(8) });
      tips.push([S.len - 0.1, 0.19, z]);
    }
  }
  T.pop(); T.pop();
  const ce = Math.cos(el), se = Math.sin(el);
  for (const p of tips) M.muzzle(lx + pivX + p[0] * ce - p[1] * se, ty + pivY + p[0] * se + p[1] * ce, lz + p[2], 'turret');
  floodlight(M, g, em, 1.55, 1.5, 1.1, Math.PI * 1.2);
  return {};
}

// ---------------------------------------------------------------- unique buildings

function sakaTent(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), em = M.part('base', { mat: 'emissive' });
  pad(g, half, { c: mixC(pal.concrete, pal.sandbag, 0.6) });
  const canvas = mixC(pal.canvas, pal.base, 0.4);
  // command marquee
  const tx = -0.9, tz = -0.8, tl = 2.6, tw = 1.1;
  g.prismX([[tz - tw, PADH], [tz + tw, PADH], [tz + tw, PADH + 0.62], [tz, PADH + 1.3], [tz - tw, PADH + 0.62]], tx - tl / 2, tx + tl / 2, { c: canvas, b: 0.02 });
  for (const s of [1, -1]) for (const k of [-0.3, 0.3]) g.box(tx + k * tl, PADH + 0.96, tz + s * 0.56, 0.34, 0.014, 1.25, { c: pal.team, b: 0, tone: false, rot: [0, 0, s * 0.55] });
  g.box(tx + tl / 2 + 0.006, PADH + 0.38, tz, 0.012, 0.76, 0.7, { c: mulC(canvas, 0.35), b: 0 }); // open flap
  if (hi) for (const s of [1, -1]) for (let i = 0; i < 4; i++) g.beam([tx - 1.0 + i * 0.66, PADH + 0.6, tz + s * tw], [tx - 1.0 + i * 0.66, PADH, tz + s * (tw + 0.3)], 0.012, { c: pal.black });
  em.box(tx + tl / 2 + 0.012, PADH + 0.5, tz, 0.004, 0.3, 0.4, { c: [1.0, 0.6, 0.25], b: 0 });
  M.door(tx + tl / 2 + 0.5, 0, tz);
  // ridge tents
  for (const [x, z, r] of [[-1.7, 1.5, 0], [-0.6, 1.75, 0.2], [0.55, 1.6, -0.15]]) {
    g.at(x, PADH, z, () => { g.prismX([[-0.4, 0], [0.4, 0], [0, 0.5]], -0.5, 0.5, { c: canvas, b: 0.012 }); g.box(0.505, 0.16, 0, 0.006, 0.3, 0.22, { c: mulC(canvas, 0.4), b: 0 }); }, r);
  }
  // camo-net briefing area on poles
  const nx = 1.5, nz = -1.3;
  for (const [dx, dz] of [[-0.7, -0.6], [0.7, -0.6], [-0.7, 0.6], [0.7, 0.6]]) g.cylY(nx + dx, PADH, PADH + 0.9, nz + dz, 0.02, { seg: 4, c: pal.wood });
  g.prismY([[nx - 0.9, nz - 0.7], [nx + 0.1, nz - 0.86], [nx + 0.95, nz - 0.66], [nx + 0.8, nz + 0.75], [nx - 0.2, nz + 0.9], [nx - 0.95, nz + 0.7]], PADH + 0.9, PADH + 0.93, { c: (x, y, z) => ((Math.round(x * 5) + Math.round(z * 5)) % 2 ? pal.dark : mulC(pal.base, 0.8)), b: 0, tess: hi ? 0.3 : 0 });
  g.box(nx, PADH + 0.3, nz, 0.8, 0.05, 0.5, { c: pal.wood, b: 0.01 });
  g.box(nx, PADH + 0.33, nz, 0.6, 0.012, 0.36, { c: pal.white, b: 0, tone: false });
  for (const s of [1, -1]) g.box(nx + s * 0.3, PADH + 0.14, nz, 0.04, 0.28, 0.4, { c: pal.wood, b: 0 });
  // fast-rope training tower
  const fx = 1.9, fz = 1.5;
  lattice(g, fx, PADH, PADH + 2.3, fz, 0.6, { w1: 0.6, c: pal.wood, n: hi ? 5 : 3 });
  g.box(fx, PADH + 2.33, fz, 0.9, 0.06, 0.9, { c: pal.wood, b: 0.012 });
  g.box(fx, PADH + 2.72, fz, 1.0, 0.05, 1.0, { c: pal.team, b: 0.012, tone: false });
  for (const sx of [1, -1]) for (const sz of [1, -1]) g.cylY(fx + sx * 0.4, PADH + 2.36, PADH + 2.7, fz + sz * 0.4, 0.02, { seg: 4, c: pal.wood });
  g.beam([fx - 0.2, PADH + 2.6, fz], [fx - 0.9, PADH + 2.6, fz], 0.04, { c: pal.gun });
  g.cylY(fx - 0.86, PADH + 0.2, PADH + 2.6, fz, 0.012, { seg: 4, c: pal.black });
  M.light(fx, PADH + 2.78, fz);
  // insertion H-pad marking, sandbags, flag, mast
  g.disc(0.4, PADH + 0.006, 0.35, 0.62, { r0: 0.54, c: pal.team });
  for (const s of [1, -1]) g.decal(0.4 + s * 0.14, PADH + 0.007, 0.35, 0.07, 0.44, { c: pal.white });
  g.decal(0.4, PADH + 0.007, 0.35, 0.28, 0.07, { c: pal.white });
  sandbagWall(g, [2.5, PADH, -0.4], [2.5, PADH, 0.9], 3);
  sandbagWall(g, [1.2, PADH, -2.5], [2.5, PADH, -2.5], 2);
  flagPole(g, 0.9, PADH, -0.2, 1.8, { w: 0.56, h: 0.34 });
  mast(M, g, -2.3, -2.2, 1.9, { w: 0.2 });
  crates(g, -2.3, 0.4, 5);
  return {};
}

function cruiseBattery(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), em = M.part('base', { mat: 'emissive' });
  pad(g, half);
  const el = 42 * DEG;
  for (const z of [-1.35, 1.35]) {
    // plinth + blast deflector + triple-canister launcher
    g.tbox(0.4, PADH + 0.14, z, 2.4, 0.28, 1.6, 2.2, 1.4, { c: pal.concrete, b: 0.03 });
    g.box(-1.0, PADH + 0.6, z, 0.14, 1.0, 1.7, { c: pal.concreteDk, b: 0.02, rot: [0, -0.3, 0] });
    blastPad(g, -0.55, z, 0.6);
    for (const s of [1, -1]) { g.box(0.0, PADH + 0.44, z + s * 0.5, 0.6, 0.4, 0.12, { c: pal.gun, b: 0.02 }); g.pipe([0.7, PADH + 0.34, z + s * 0.36], [0.0 + Math.cos(el) * 0.9, PADH + 0.5 + Math.sin(el) * 0.9, z + s * 0.36], 0.05, { seg: 6, c: pal.steelLt }); }
    g.at(-0.2, PADH + 0.5, z, () => {
      g.box(1.0, -0.04, 0, 2.1, 0.08, 0.7, { c: pal.gun, b: 0.014 });
      for (const k of [-1, 0, 1]) canister(g, -0.1, 2.3, 0.14, k * 0.24, 0.11, { c: k ? pal.base : mulC(pal.base, 0.9), ribs: 4, front: pal.warhead, seg: M.ctx.seg(10) });
      for (const u of [0.3, 1.9]) g.box(u, 0.14, 0, 0.06, 0.26, 0.76, { c: pal.gun, b: 0.01 });
      g.box(1.1, 0.262, 0, 0.4, 0.012, 0.6, { c: pal.team, b: 0, tone: false });
    }, 0, el);
    for (const k of [-1, 0, 1]) M.muzzle(-0.2 + Math.cos(el) * 2.3 - Math.sin(el) * 0.14, PADH + 0.5 + Math.sin(el) * 2.3 + Math.cos(el) * 0.14, z + k * 0.24);
  }
  // command shelter, fire-control radar, power
  const bt = bunker(M, g, em, -1.9, 0, 1.2, 1.5, { h: 0.7 });
  lattice(g, -1.9, bt, bt + 1.2, 0.3, 0.24, { w1: 0.12, c: pal.steel });
  const R = M.part('radar', { at: [-1.9, bt + 1.2, 0.3] });
  R.cylY(-1.9, bt + 1.2, bt + 1.3, 0.3, 0.04, { seg: 6, c: pal.gun });
  radarPanel(R, -1.86, bt + 1.52, 0.3, 0.7, 0.4, { tilt: 0.2 });
  M.spin('radar', 'y', 1.4);
  M.light(-1.9, bt + 1.76, 0.3);
  pipeRun(g, [[-1.3, PADH + 0.06, 0], [-0.6, PADH + 0.06, 0], [-0.6, PADH + 0.06, 1.0]], 0.035, pal.black);
  pipeRun(g, [[-0.6, PADH + 0.06, 0], [-0.6, PADH + 0.06, -1.0]], 0.035, pal.black);
  for (const s of [1, -1]) lightPost(M, g, em, 2.4, s * 2.4, 1.2);
  g.box(-2.2, PADH + 0.22, -2.1, 0.6, 0.36, 0.5, { c: pal.missileG, b: 0.03 });
  flagPole(g, -2.3, PADH, 2.3, 1.6);
  hazardStrip(g, 1.9, PADH + 0.006, 0, 4.6, 0.1, { alongZ: true });
  M.door(2.2, 0, 0);
  return {};
}

function droneWorkshop(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), glass = M.part('base', { mat: 'glass' }), em = M.part('base', { mat: 'emissive' });
  pad(g, half);
  // quonset workshop open toward +X
  const wx = -1.1, wz = -1.0, wl = 2.7, ww = 2.6;
  const top = house(g, wx, wz, wl, ww, 0.3, { roof: 'archX', rise: 1.15, roofC: mulC(pal.base, 0.92), c: pal.wallDk, plinth: false });
  g.box(wx + wl / 2 + 0.01, PADH + 0.56, wz, 0.03, 1.1, ww * 0.74, { c: pal.black, b: 0, tone: false, warp: (p, s0, s1) => { if (s1 > 0) p[2] *= 0.7; } });
  em.box(wx + wl / 2 + 0.028, PADH + 1.0, wz, 0.004, 0.05, 1.0, { c: [1.0, 0.8, 0.45], b: 0 });
  for (const k of [-0.3, 0.3]) g.box(wx + k * wl, top + 0.004, wz, 0.3, 0.012, 0.7, { c: pal.team, b: 0, tone: false });
  shahed(g, wx + wl / 2 + 0.3, PADH + 0.32, wz, 0, 0, 1.5);
  g.box(wx + wl / 2 + 0.3, PADH + 0.14, wz, 0.5, 0.28, 0.3, { c: pal.steel, b: 0.02 }); // assembly trolley
  M.door(wx + wl / 2 + 0.9, 0, wz);
  windows(glass, wx, PADH + 0.5, wz + ww / 2 - 0.2, 2.0, 4, '+z', { em, lit: 0.5 });
  // five-cell launch rack on a truck bed
  const rx = 1.5, rz = 1.4;
  g.box(rx, PADH + 0.2, rz, 1.9, 0.16, 0.8, { c: pal.gun, b: 0.02 });
  for (const x of [rx - 0.6, rx - 0.2, rx + 0.6]) for (const s of [1, -1]) g.cylZ(x, PADH + 0.13, rz + s * 0.3, rz + s * 0.42, 0.13, { seg: 8, c: pal.tyre });
  g.box(rx + 0.75, PADH + 0.5, rz, 0.4, 0.44, 0.74, { c: pal.base, b: 0.03, camo: 0 });
  glass.box(rx + 0.955, PADH + 0.58, rz, 0.01, 0.16, 0.6, { c: pal.glassD, b: 0 });
  const el = 0.5;
  g.at(rx - 0.75, PADH + 0.3, rz, () => {
    g.box(0.6, 0.34, 0, 1.3, 0.72, 0.84, { c: mulC(pal.base, 0.85), b: 0.02, camo: 0 });
    for (let i = 0; i < 5; i++) {
      const yy = 0.06 + i * 0.14;
      g.box(1.254, yy + 0.02, 0, 0.008, 0.11, 0.74, { c: pal.black, b: 0, tone: false });
      shahed(g, 1.22, yy + 0.02, 0, 0, 0, 1.2);
    }
    g.box(0.6, 0.71, 0, 0.5, 0.012, 0.6, { c: pal.team, b: 0, tone: false });
  }, 0, el);
  for (let i = 0; i < 5; i++) M.muzzle(rx - 0.75 + Math.cos(el) * 1.26 - Math.sin(el) * (0.08 + i * 0.14), PADH + 0.3 + Math.sin(el) * 1.26 + Math.cos(el) * (0.08 + i * 0.14), rz);
  for (const s of [1, -1]) g.beam([rx - 0.2, PADH + 0.28, rz + s * 0.3], [rx - 0.75 + Math.cos(el) * 0.9, PADH + 0.3 + Math.sin(el) * 0.9, rz + s * 0.3], 0.05, { c: pal.steelLt });
  // single rail launcher with a drone ready
  g.at(1.3, PADH, -1.6, () => {
    g.box(0, 0.12, 0, 0.6, 0.24, 0.5, { c: pal.gun, b: 0.02 });
    g.at(-0.2, 0.26, 0, () => { g.box(0.6, 0, 0, 1.5, 0.06, 0.1, { c: pal.steel, b: 0.01 }); shahed(g, 0.9, 0.12, 0, 0, 0, 1.7); }, 0, 0.3);
    g.beam([0.2, 0.2, 0], [0.5, 0.42, 0], 0.04, { c: pal.steelLt });
  }, 0.25);
  // parts: wings on racks, engines, crates, antenna
  for (let i = 0; i < 3; i++) g.box(0.1, PADH + 0.3 + i * 0.03, 2.0 + i * 0.12, 0.7, 0.02, 0.5, { c: mixC(pal.white, pal.sandbag, 0.45), b: 0, rot: [0.2, 0, 0.9] });
  crates(g, -2.2, 1.6, 6);
  crates(g, -1.2, 2.0, 3);
  mast(M, g, -2.2, 2.3, 2.0, { w: 0.2 });
  g.at(-2.2, PADH + 1.3, 2.3, () => dish(g, 0.1, 0, 0, 0.18, { c: pal.white }), -0.6, 0.3);
  flagPole(g, 2.4, PADH, 0.0, 1.5);
  floodlight(M, g, em, 2.4, -2.4, 1.2, Math.PI * 0.8);
  return {};
}

export function buildUnique(M, def, half) {
  const n = def.name || '';
  if (/Sa.?ka|Tent|Camp/i.test(n)) return sakaTent(M, def, half);
  if (/Cruise|BrahMos|Battery/i.test(n)) return cruiseBattery(M, def, half);
  if (/Drone|Workshop|Shahed/i.test(n)) return droneWorkshop(M, def, half);
  return sakaTent(M, def, half);
}

// ---------------------------------------------------------------- superweapons

function swSite(M, g, em, half, o = {}) {
  const { pal } = g.ctx;
  pad(g, half, { c: mixC(pal.concrete, pal.concreteDk, 0.35) });
  const m = half - 0.08;
  // perimeter: low wall with gaps on +X (launch side) and a hazard border
  wallRun(g, [-m, -m], [m - 1.2, -m], 0.36, { t: 0.14 });
  wallRun(g, [-m, m], [m - 1.2, m], 0.36, { t: 0.14 });
  wallRun(g, [-m, -m + 0.8], [-m, m - 0.8], 0.36, { t: 0.14 });
  hazardStrip(g, m - 0.1, PADH + 0.006, 0, half * 2 - 0.5, 0.14, { alongZ: true });
  for (const sx of [1, -1]) for (const sz of [1, -1]) lightPost(M, g, em, sx * (m - 0.1), sz * (m - 0.1), 1.6);
  if (o.flag !== false) flagPole(g, -m + 0.3, PADH, -m + 0.4, 2.0, { w: 0.7, h: 0.42 });
}

function fuelFarm(g, x, z, n = 2) {
  const { pal } = g.ctx;
  for (let i = 0; i < n; i++) {
    const zz = z + i * 0.62;
    g.cylX(x - 0.6, x + 0.6, PADH + 0.34, zz, 0.24, { seg: g.ctx.seg(10), c: i % 2 ? pal.white : mixC(pal.white, pal.concrete, 0.3), b: 0.04 });
    g.lathe('x', [[x - 0.12, 0.245], [x + 0.12, 0.245]], { at: [0, PADH + 0.34, zz], seg: g.ctx.seg(10), c: pal.team, cap0: false, cap1: false, tone: false });
    for (const k of [-0.36, 0.36]) g.box(x + k, PADH + 0.07, zz, 0.1, 0.14, 0.4, { c: pal.concreteDk, b: 0 });
  }
}

function has(g, x, z, len, w, o = {}) {
  // hardened aircraft shelter, door toward +X
  const { pal } = g.ctx;
  const n = g.ctx.seg(8), pr = [];
  const rise = o.rise ?? 1.0;
  for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI; pr.push([z + Math.cos(a) * w / 2, PADH + Math.sin(a) * rise]); }
  g.prismX(pr, x - len / 2, x + len / 2, { c: o.c || mixC(pal.base, pal.concrete, 0.4), b: 0.03, crease: 40, camo: 1 });
  const pr2 = pr.map((p) => [z + (p[0] - z) * 0.74, PADH + (p[1] - PADH) * 0.78]);
  g.prismX(pr2, x + len / 2 - 0.02, x + len / 2 + 0.02, { c: pal.black, b: 0, tone: false });
  g.box(x + len / 2 + 0.03, PADH + rise * 0.86, z, 0.05, 0.12, w * 0.4, { c: pal.team, b: 0.01, tone: false });
  for (const k of [-0.25, 0.25]) g.box(x + k * len, PADH + rise + 0.004, z, 0.3, 0.012, w * 0.3, { c: pal.team, b: 0, tone: false });
  // earth berm skirts
  for (const s of [1, -1]) g.box(x, PADH + 0.16, z + s * (w / 2 + 0.02), len * 0.96, 0.34, 0.3, { c: pal.sandbag, b: 0.05, rot: [0, 0, s * 0.5] });
}

function runwayStrip(g, x0, x1, z, w) {
  const { pal } = g.ctx;
  const y = PADH + 0.005;
  g.decal((x0 + x1) / 2, y, z, x1 - x0, w, { c: pal.asphalt });
  const n = Math.floor((x1 - x0) / 0.8);
  for (let i = 0; i < n; i++) g.decal(x0 + 0.4 + i * 0.8, y + 0.002, z, 0.4, 0.05, { c: pal.white });
  for (const s of [1, -1]) g.decal((x0 + x1) / 2, y + 0.002, z + s * (w / 2 - 0.06), x1 - x0 - 0.2, 0.03, { c: pal.yellow });
}

function fixedLauncher(M, g, x, z, ry, el, kind, o = {}) {
  // heavy rocket / missile-pod launcher on a turntable (static pose)
  const { pal } = g.ctx;
  g.cylY(x, PADH, PADH + 0.12, z, 0.62, { seg: g.ctx.seg(12), c: pal.concreteDk });
  g.at(x, PADH + 0.12, z, () => {
    g.cylY(0, 0, 0.12, 0, 0.42, { seg: g.ctx.seg(10), c: pal.gun, b: 0.02 });
    for (const s of [1, -1]) g.prismZ([[-0.3, 0.12], [0.3, 0.12], [0.06, 0.6], [-0.2, 0.6]], s * 0.34 - 0.04, s * 0.34 + 0.04, { c: pal.base, b: 0.012, camo: 0 });
    g.at(-0.1, 0.52, 0, () => {
      if (kind === 'bundle') { const d = tubeBundle(g, 0.4, 0.2, 0, o.len ?? 1.5, o.r ?? 0.07, o.nz ?? 4, o.ny ?? 3, { c: pal.base }); g.box(0.4, 0.2 + d.H / 2 + 0.012, 0, 0.4, 0.012, d.W * 0.8, { c: pal.team, b: 0, tone: false }); }
      else { tubeBank(g, 0.4, 0.22, 0, o.len ?? 1.3, o.w ?? 0.62, o.h ?? 0.42, o.nz ?? 3, o.ny ?? 2, { c: pal.base, camo: 1, tip: o.tip, fill: o.fill, b: 0.02 }); g.box(0.3, 0.44, 0, 0.4, 0.012, (o.w ?? 0.62) * 0.7, { c: pal.team, b: 0, tone: false }); }
    }, 0, el);
  }, ry);
  const L = (o.len ?? (kind === 'bundle' ? 1.5 : 1.3)) / 2 + 0.4;
  const dx = Math.cos(el) * L - Math.sin(el) * 0.2 - 0.1, dy = 0.64 + Math.sin(el) * L + Math.cos(el) * 0.2;
  M.muzzle(x + Math.cos(ry) * dx, PADH + dy, z - Math.sin(ry) * dx);
}

function swOctober(M, g, em, half) {
  const { pal } = g.ctx;
  // two Scud-class missiles on launch tables sharing a service tower
  for (const z of [-1.35, 1.35]) {
    blastPad(g, 1.0, z, 1.05);
    launchTable(g, 1.0, z, 0.22, 0.4);
    standMissile(M, g, 1.0, PADH + 0.4, z, { len: 3.0, r: 0.19, c: mixC(pal.base, pal.sandbag, 0.3), tip: pal.gun, band: pal.team, finLen: 0.42, finH: 0.2, noseLen: 0.8 });
    g.box(1.0, PADH + 0.02, z, 2.6, 0.04, 0.3, { c: pal.concreteDk, b: 0 }); // flame trench cover
  }
  gantry(M, g, 0.1, 0, 3.4, [[1.2, 0.75, -1.2], [2.6, 0.75, -1.2], [1.2, 0.75, 1.2], [2.6, 0.75, 1.2]], { w: 0.56 });
  const bt = bunker(M, g, em, -2.3, 2.1, 1.6, 1.5);
  mast(M, g, -2.6, 2.4, 1.3, { y0: bt, w: 0.16 });
  // artillery rocket battery (the "October barrage")
  fixedLauncher(M, g, -1.6, -0.2, 0, 0.75, 'bundle', { nz: 5, ny: 3, r: 0.06, len: 1.3 });
  fixedLauncher(M, g, -1.6, -1.9, 0, 0.75, 'bundle', { nz: 5, ny: 3, r: 0.06, len: 1.3 });
  fuelFarm(g, -0.2, 2.3, 2);
  pipeRun(g, [[0.5, PADH + 0.2, 2.5], [1.0, PADH + 0.2, 2.5], [1.0, PADH + 0.2, 1.8]], 0.06, pal.steelLt);
  crates(g, 2.3, 2.9, 5);
}

function swCrescent(M, g, em, half) {
  const { pal, hi } = g.ctx;
  // one great silo with split doors slid open and an IRBM rising out of it
  const R = 1.25;
  blastPad(g, 0.3, 0, 2.3);
  g.lathe('y', [[PADH, R * 1.3], [PADH + 0.3, R * 1.18], [PADH + 0.42, R * 1.18], [PADH + 0.42, R * 0.82], [PADH + 0.1, R * 0.8]], { at: [0.3, 0, 0], seg: 8, colors: [pal.concrete, pal.concrete, pal.concreteLt, pal.concreteDk, pal.black], crease: 30, cap0: false, cap1: false, tone: false, phase: Math.PI / 8 });
  g.disc(0.3, PADH + 0.11, 0, R * 0.8, { c: pal.black, seg: 8 });
  for (const s of [1, -1]) {
    g.box(0.3, PADH + 0.5, s * (R * 0.6 + 1.0), R * 2.0, 0.16, R * 1.1, { c: pal.concreteLt, b: 0.03 });
    g.box(0.3, PADH + 0.59, s * (R * 0.6 + 1.0), R * 1.6, 0.012, R * 0.7, { c: pal.team, b: 0, tone: false });
    for (const k of [-0.9, 0.9]) g.box(0.3 + k * R, PADH + 0.38, s * 1.6, 0.12, 0.1, 2.2, { c: pal.gun, b: 0 }); // rails
    for (let i = 0; i < 6; i++) g.box(0.3 - R + 0.2 + i * 0.42, PADH + 0.586, s * (R * 0.6 + 0.47), 0.21, 0.012, 0.1, { c: i % 2 ? pal.hazK : pal.yellow, b: 0, tone: false });
  }
  standMissile(M, g, 0.3, PADH + 0.1, 0, { len: 4.1, r: 0.3, c: pal.missileW, tip: pal.green, band: pal.team, finLen: 0.5, finH: 0.2, noseLen: 1.1, finAt: [0.0] });
  g.lathe('y', [[PADH + 1.7, 0.305], [PADH + 1.9, 0.305]], { at: [0.3, 0, 0], seg: M.ctx.seg(12), c: pal.green, cap0: false, cap1: false, tone: false });
  gantry(M, g, -1.25, 0, 4.2, [[1.3, 1.25, 0], [2.4, 1.25, 0], [3.4, 1.3, 0]], { w: 0.6, c: pal.red });
  const bt = bunker(M, g, em, -2.5, -2.3, 1.6, 1.6);
  radome(g, -2.5, bt + 0.3, -2.3, 0.42);
  // propellant spheres + vent stacks
  for (const z of [2.1, 2.9]) { g.sphere(-2.4, PADH + 0.62, z, 0.42, { seg: M.ctx.seg(10), c: pal.white }); for (let i = 0; i < 4; i++) g.beam([-2.4 + Math.cos(i * 1.57 + 0.78) * 0.34, PADH, z + Math.sin(i * 1.57 + 0.78) * 0.34], [-2.4 + Math.cos(i * 1.57 + 0.78) * 0.3, PADH + 0.5, z + Math.sin(i * 1.57 + 0.78) * 0.3], 0.04, { c: pal.steel }); }
  pipeRun(g, [[-2.0, PADH + 0.3, 2.5], [-1.25, PADH + 0.3, 2.5], [-1.25, PADH + 0.3, 0.4]], 0.07, pal.steelLt);
  for (const z of [-0.9, 0.9]) { g.cylY(-2.9, PADH, PADH + 1.1, z, 0.1, { seg: 8, c: pal.steel, b: 0.01 }); M.stack(-2.9, PADH + 1.12, z); }
  if (hi) crates(g, 2.4, -2.9, 4);
}

function swFalcon(M, g, em, half) {
  const { pal } = g.ctx;
  // strike package: two hardened shelters with jets + twin precision-rocket launchers
  has(g, -2.1, -1.7, 2.2, 2.0);
  has(g, -2.1, 0.75, 2.2, 2.0);
  miniJet(g, -0.9, PADH, -1.7, 0, { s: 1.5, c: pal.steelLt });
  miniJet(g, 0.6, PADH, 0.75, 0, { s: 1.5, c: pal.steelLt });
  runwayStrip(g, -3.3, 3.3, 2.75, 1.1);
  g.decal(1.6, PADH + 0.005, -0.4, 3.2, 3.4, { c: mixC(pal.asphalt, pal.concrete, 0.3) });
  g.decal(1.9, PADH + 0.007, 1.5, 0.05, 1.6, { c: pal.yellow });
  fixedLauncher(M, g, 2.3, -1.2, 0.0, 0.85, 'bank', { nz: 3, ny: 2, w: 0.7, h: 0.5, len: 1.3 });
  fixedLauncher(M, g, 2.3, -2.7, 0.0, 0.85, 'bank', { nz: 3, ny: 2, w: 0.7, h: 0.5, len: 1.3 });
  // control tower
  const tx = 0.4, tz = -2.9;
  house(g, tx, tz, 0.8, 0.8, 0.5, { roof: 'flat', c: pal.wallLt });
  g.box(tx, PADH + 1.2, tz, 0.44, 1.5, 0.44, { c: pal.wallLt, b: 0.02 });
  const glass = M.part('base', { mat: 'glass' });
  glass.tbox(tx, PADH + 2.14, tz, 0.7, 0.34, 0.7, 0.9, 0.9, { c: pal.glassD, b: 0.008 });
  g.box(tx, PADH + 2.34, tz, 0.96, 0.06, 0.96, { c: pal.team, b: 0.014, tone: false });
  const R = M.part('radar', { at: [tx, PADH + 2.4, tz] });
  R.cylY(tx, PADH + 2.37, PADH + 2.52, tz, 0.03, { seg: 6, c: pal.gun });
  R.box(tx, PADH + 2.58, tz, 0.06, 0.14, 0.7, { c: pal.steelLt, b: 0.01 });
  M.spin('radar', 'y', 1.6);
  M.light(tx, PADH + 2.7, tz);
  // munitions on trolleys
  for (let i = 0; i < 3; i++) { g.box(1.0 + i * 0.5, PADH + 0.1, 0.0, 0.4, 0.06, 0.24, { c: pal.yellow, b: 0 }); missile(g, 0.82 + i * 0.5, PADH + 0.2, 0.0, { len: 0.4, r: 0.05, c: pal.missileG, tip: pal.missileG, band: pal.yellow, fins: 4, finAt: [0], finLen: 0.08, finH: 0.04, nose: 'round', seg: 6 }); }
}

function swHellwind(M, g, em, half) {
  const { pal } = g.ctx;
  // saturation battery: three heavy launchers fanned toward +X and a thermobaric box launcher
  const pos = [[1.2, -2.0, 0.35], [1.7, 0.0, 0.0], [1.2, 2.0, -0.35]];
  for (const [x, z, ry] of pos) {
    fixedLauncher(M, g, x, z, ry, 0.8, 'bundle', { nz: 4, ny: 3, r: 0.085, len: 1.7 });
    g.disc(x - 1.0, PADH + 0.005, z + Math.sin(ry) * 1.0, 0.5, { c: mixC(pal.concreteDk, pal.black, 0.6) });
  }
  for (const z of [-1.0, 1.0]) wallRun(g, [0.3, z], [2.3, z * 1.05], 0.5, { t: 0.16 });
  fixedLauncher(M, g, -0.9, 0.0, 0, 0.5, 'bank', { nz: 6, ny: 4, w: 1.0, h: 0.56, len: 1.0, fill: 0.4 });
  // earth-covered ammunition igloos
  for (const z of [-2.4, 2.4]) { has(g, -2.3, z, 1.7, 1.5, { rise: 0.7, c: pal.sandbag }); }
  const bt = bunker(M, g, em, -2.6, 0, 1.2, 1.7);
  mast(M, g, -2.6, 0.4, 1.6, { y0: bt, w: 0.18 });
  for (let i = 0; i < 6; i++) g.cylX(-0.9, 0.3, PADH + 0.09 + Math.floor(i / 3) * 0.17, 2.0 + (i % 3) * 0.18 + Math.floor(i / 3) * 0.09, 0.085, { seg: 7, c: pal.missileG, b: 0.01 });
  crates(g, -0.6, -2.2, 6);
}

function erectedBoxes(M, g, x, z, n, o) {
  // row of square canisters raised on a common erector frame
  const { pal } = g.ctx;
  const el = (o.elev ?? 80) * DEG, w = o.w, len = o.len;
  g.box(x, PADH + 0.14, z, 1.5, 0.2, n * (w + 0.06) + 0.5, { c: pal.gun, b: 0.03 });
  for (let i = 0; i < n; i++) {
    const zz = z + (i - (n - 1) / 2) * (w + 0.08);
    g.at(x - 0.4, PADH + 0.3, zz, () => {
      g.box(len / 2, w / 2, 0, len, w, w, { c: i % 2 ? pal.base : mulC(pal.base, 0.9), b: 0.02, camo: 0 });
      for (const u of [0.15, 0.5, 0.85]) g.box(len * u, w / 2, 0, 0.05, w + 0.02, w + 0.02, { c: mulC(pal.base, 0.7), b: 0 });
      g.box(len + 0.005, w / 2, 0, 0.01, w * 0.84, w * 0.84, { c: pal.warhead, b: 0, tone: false });
      g.box(len * 0.68, w + 0.006, 0, 0.3, 0.012, w * 0.7, { c: pal.team, b: 0, tone: false });
    }, 0, el);
    g.pipe([x + 0.5, PADH + 0.26, zz], [x - 0.4 + Math.cos(el) * len * 0.5 + 0.1, PADH + 0.3 + Math.sin(el) * len * 0.5, zz], 0.05, { seg: 6, c: pal.steelLt });
    M.muzzle(x - 0.4 + Math.cos(el) * len - Math.sin(el) * w / 2, PADH + 0.3 + Math.sin(el) * len + Math.cos(el) * w / 2, zz);
  }
}

function swTayfun(M, g, em, half) {
  const { pal } = g.ctx;
  blastPad(g, 1.0, -1.3, 1.5);
  erectedBoxes(M, g, 1.1, -1.3, 4, { w: 0.4, len: 2.9, elev: 80 });
  // drone launch strip + shelter
  runwayStrip(g, -3.3, 3.3, 2.5, 1.2);
  has(g, -2.3, 0.6, 1.9, 1.7, { rise: 0.85 });
  miniJet(g, -0.6, PADH, 2.5, 0, { s: 1.35, twin: true, c: mulC(pal.steelLt, 0.8) });
  miniJet(g, -1.2, PADH, 0.6, 0, { s: 1.2, twin: true, c: mulC(pal.steelLt, 0.8) });
  const bt = bunker(M, g, em, -2.4, -2.3, 1.7, 1.6);
  const R = M.part('radar', { at: [-2.4, bt + 0.5, -2.3] });
  g.cylY(-2.4, bt, bt + 0.5, -2.3, 0.07, { seg: 6, c: pal.steel });
  R.cylY(-2.4, bt + 0.5, bt + 0.6, -2.3, 0.05, { seg: 6, c: pal.gun });
  radarPanel(R, -2.36, bt + 0.9, -2.3, 0.9, 0.56, { tilt: 0.25 });
  M.spin('radar', 'y', 1.2);
  M.light(-2.4, bt + 1.24, -2.3);
  fuelFarm(g, -0.3, -2.9, 1);
  gantry(M, g, -0.3, -1.3, 3.0, [[1.4, 0.8, 0], [2.4, 0.8, 0]], { w: 0.46 });
}

function swAdir(M, g, em, half) {
  const { pal } = g.ctx;
  has(g, -2.1, -1.9, 2.3, 2.1);
  has(g, -2.1, 0.5, 2.3, 2.1);
  g.decal(1.2, PADH + 0.005, -0.7, 4.2, 4.6, { c: mixC(pal.asphalt, pal.concrete, 0.3) });
  runwayStrip(g, -3.3, 3.3, 2.75, 1.1);
  const stealth = mixC(pal.steel, pal.black, 0.2);
  miniJet(g, 0.5, PADH, -1.9, 0, { s: 1.7, twin: true, c: stealth });
  miniJet(g, -0.8, PADH, 0.5, 0, { s: 1.7, twin: true, c: stealth });
  miniJet(g, 2.0, PADH, 0.3, 0.5, { s: 1.75, twin: true, c: mulC(pal.steelLt, 0.9) });
  g.decal(1.2, PADH + 0.007, -0.7, 0.05, 4.2, { c: pal.yellow });
  // bunker-buster bombs on trolleys + bomb dump igloos
  for (let i = 0; i < 4; i++) { g.box(2.5, PADH + 0.1, -2.9 + i * 0.44, 0.9, 0.06, 0.26, { c: pal.yellow, b: 0 }); missile(g, 2.0, PADH + 0.24, -2.9 + i * 0.44, { len: 0.95, r: 0.085, c: pal.missileG, tip: pal.gun, band: pal.yellow, fins: 4, finAt: [0], finLen: 0.16, finH: 0.08, seg: 7 }); }
  M.muzzle(2.9, PADH + 0.3, -2.2);
  // tower with radome
  const tx = 2.7, tz = 1.5;
  house(g, tx, tz, 0.9, 0.9, 0.6, { roof: 'flat', c: pal.wallLt });
  g.box(tx, PADH + 1.3, tz, 0.46, 1.5, 0.46, { c: pal.wallLt, b: 0.02 });
  const glass = M.part('base', { mat: 'glass' });
  glass.tbox(tx, PADH + 2.2, tz, 0.72, 0.32, 0.72, 0.9, 0.9, { c: pal.glassD, b: 0.008 });
  g.box(tx, PADH + 2.39, tz, 0.96, 0.06, 0.96, { c: pal.team, b: 0.014, tone: false });
  radome(g, tx, PADH + 2.62, tz, 0.3);
  M.light(tx, PADH + 2.95, tz);
}

function swTrishul(M, g, em, half) {
  const { pal } = g.ctx;
  // trident: three erected cruise missiles on a raised octagonal platform
  const px = 0.7;
  g.lathe('y', [[PADH, 2.25], [PADH + 0.36, 2.0], [PADH + 0.36, 0]], { at: [px, 0, 0], seg: 8, colors: [pal.concrete, pal.concreteLt, pal.concreteLt], crease: 30, cap0: false, phase: Math.PI / 8, tone: false });
  const top = PADH + 0.36;
  g.disc(px, top + 0.004, 0, 1.9, { r0: 1.72, c: pal.team, seg: 8 });
  const ms = [[0, -1.15, 2.7], [0.25, 0, 3.4], [0, 1.15, 2.7]];
  for (const [dx, z, len] of ms) {
    g.disc(px + dx, top + 0.006, z, 0.5, { c: mixC(pal.concreteDk, pal.black, 0.7) });
    launchTable(g, px + dx, z, 0.19, 0.36 + 0.3);
    standMissile(M, g, px + dx, top + 0.3, z, { len, r: 0.17, c: pal.missileW, tip: pal.orange, band: pal.team, finLen: 0.36, finH: 0.16, noseLen: 0.7, finAt: [0.0, 0.3] });
    // flame trench toward +X
    g.box(px + dx + 1.2, top - 0.1, z, 1.6, 0.26, 0.34, { c: pal.black, b: 0, tone: false });
    hazardStrip(g, px + dx + 1.3, top + 0.006, z + 0.24, 1.2, 0.07);
  }
  gantry(M, g, px - 0.9, -0.58, 3.1, [[1.5, 0.75, -0.5], [2.4, 0.75, -0.5]], { w: 0.44, y0: top });
  gantry(M, g, px - 0.9, 0.58, 3.7, [[1.9, 1.0, -0.5], [3.0, 1.0, -0.5]], { w: 0.44 });
  const bt = bunker(M, g, em, -2.5, -2.3, 1.6, 1.6);
  const R = M.part('radar', { at: [-2.5, bt + 0.4, -2.3] });
  g.cylY(-2.5, bt, bt + 0.4, -2.3, 0.07, { seg: 6, c: pal.steel });
  R.cylY(-2.5, bt + 0.4, bt + 0.5, -2.3, 0.05, { seg: 6, c: pal.gun });
  R.box(-2.5, bt + 0.66, -2.3, 0.08, 0.3, 1.0, { c: pal.steelLt, b: 0.02 });
  M.spin('radar', 'y', 1.3);
  fuelFarm(g, -2.4, 1.9, 2);
  pipeRun(g, [[-1.8, PADH + 0.3, 2.2], [-1.0, PADH + 0.3, 2.2], [-1.0, PADH + 0.3, 0.9]], 0.06, pal.steelLt);
  // strike escort on the apron
  miniJet(g, -1.6, PADH, -0.4, 0.2, { s: 1.5, twin: true, c: mulC(pal.steelLt, 0.9) });
}

function swGhaznavi(M, g, em, half) {
  const { pal } = g.ctx;
  for (const z of [-1.5, 1.2]) {
    blastPad(g, 1.2, z, 1.0);
    // TEL-style erector: flat bed + vertical missile
    g.box(0.5, PADH + 0.22, z, 2.2, 0.2, 0.7, { c: pal.base, b: 0.03, camo: 1 });
    for (const x of [-0.3, 0.2, 1.0]) for (const s of [1, -1]) g.cylZ(x, PADH + 0.14, z + s * 0.26, z + s * 0.4, 0.14, { seg: 8, c: pal.tyre });
    g.box(-0.4, PADH + 0.5, z, 0.44, 0.4, 0.66, { c: pal.base, b: 0.03, camo: 1 });
    g.beam([0.5, PADH + 0.34, z], [1.2, PADH + 1.3, z], 0.08, { c: pal.steelLt });
    g.box(1.2, PADH + 0.34, z, 0.36, 0.08, 0.5, { c: pal.gun, b: 0 });
    standMissile(M, g, 1.2, PADH + 0.38, z, { len: 2.8, r: 0.18, c: pal.missileG, tip: pal.gun, band: pal.team, finLen: 0.36, finH: 0.17, noseLen: 0.8 });
    g.lathe('y', [[PADH + 1.6, 0.184], [PADH + 1.74, 0.184]], { at: [1.2, 0, z], seg: M.ctx.seg(12), c: pal.white, cap0: false, cap1: false, tone: false });
  }
  gantry(M, g, 0.2, -0.15, 3.2, [[1.6, 0.8, -1.1], [2.5, 0.8, -1.1], [1.6, 0.8, 1.1], [2.5, 0.8, 1.1]], { w: 0.5 });
  // cruise-missile box launcher
  g.box(-1.6, PADH + 0.16, 2.5, 1.6, 0.2, 0.9, { c: pal.gun, b: 0.03 });
  const el = 0.75;
  g.at(-2.1, PADH + 0.3, 2.5, () => {
    for (const k of [-1, 1]) for (const j of [0, 1]) { g.box(0.8, 0.14 + j * 0.24, k * 0.2, 1.7, 0.22, 0.36, { c: pal.base, b: 0.02, camo: 1 }); g.box(1.655, 0.14 + j * 0.24, k * 0.2, 0.01, 0.17, 0.3, { c: pal.warhead, b: 0, tone: false }); }
    g.box(0.9, 0.5, 0, 0.4, 0.012, 0.6, { c: pal.team, b: 0, tone: false });
  }, 0, el);
  M.muzzle(-2.1 + Math.cos(el) * 1.66, PADH + 0.3 + Math.sin(el) * 1.66, 2.5);
  for (const s of [1, -1]) g.pipe([-1.2, PADH + 0.26, 2.5 + s * 0.3], [-2.1 + Math.cos(el) * 1.0, PADH + 0.3 + Math.sin(el) * 1.0, 2.5 + s * 0.3], 0.05, { seg: 6, c: pal.steelLt });
  const bt = bunker(M, g, em, -2.5, -2.3, 1.6, 1.6);
  mast(M, g, -2.8, -2.6, 1.5, { y0: bt, w: 0.18 });
  fuelFarm(g, -2.4, -0.2, 2);
  crates(g, 2.5, 2.8, 5);
}

function swRaad(M, g, em, half) {
  const { pal, hi } = g.ctx;
  // "missile city": a rock massif with a tunnel portal, launch rails and drone racks
  const rock = mixC(pal.sandbag, pal.rust, 0.25), rockDk = mulC(rock, 0.78);
  const lump = (x, z, r, h, k1, k2, c, ph) => g.lathe('y', [[PADH, r], [PADH + h * 0.35, r * 0.9], [PADH + h * 0.7, r * 0.62], [PADH + h * 0.92, r * 0.3], [PADH + h, 0]], { at: [x, 0, z], seg: 7, c, crease: 28, cap0: false, k1, k2, phase: ph, toneAmt: 0.08 });
  lump(-1.7, -0.2, 1.7, 2.6, 1.6, 1.0, rock, 0.3);
  lump(-2.2, -1.9, 1.2, 1.9, 1.0, 1.0, rockDk, 1.1);
  lump(-2.0, 1.9, 1.3, 2.1, 1.1, 1.0, rockDk, 2.0);
  lump(-0.9, 2.4, 0.8, 1.1, 1.0, 1.2, rock, 0.7);
  // portal
  const n = 8, pr = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI; pr.push([-0.2 + Math.cos(a) * 0.8, PADH + Math.sin(a) * 1.05]); }
  g.prismX(pr, -1.4, -0.1, { c: pal.concrete, b: 0.04, crease: 40 });
  g.prismX(pr.map((p) => [-0.2 + (p[0] + 0.2) * 0.78, PADH + (p[1] - PADH) * 0.82]), -0.12, -0.06, { c: pal.black, b: 0, tone: false });
  g.box(-0.06, PADH + 1.0, -0.2, 0.06, 0.14, 0.9, { c: pal.team, b: 0.01, tone: false });
  em.box(-0.055, PADH + 0.84, -0.2, 0.004, 0.04, 0.5, { c: [1.0, 0.6, 0.2], b: 0 });
  // rails out to the launch apron
  for (const s of [1, -1]) g.box(1.0, PADH + 0.03, -0.2 + s * 0.24, 2.3, 0.05, 0.06, { c: pal.gun, b: 0 });
  if (hi) for (let i = 0; i < 8; i++) g.box(0.0 + i * 0.28, PADH + 0.015, -0.2, 0.08, 0.03, 0.7, { c: pal.wood, b: 0 });
  blastPad(g, 2.0, -0.2, 1.1);
  // rail launcher with a Fateh ready + a second missile emerging from the tunnel
  g.box(1.9, PADH + 0.16, -0.2, 1.3, 0.2, 0.66, { c: pal.gun, b: 0.03 });
  const el = 0.9;
  g.at(1.5, PADH + 0.3, -0.2, () => { g.box(0.9, 0, 0, 2.0, 0.1, 0.16, { c: pal.steel, b: 0.014 }); missile(g, 0.0, 0.2, 0, { len: 2.5, r: 0.15, c: pal.missileG, tip: pal.gun, band: pal.team, fins: 4, finAt: [0.0], finLen: 0.34, finH: 0.16, noseLen: 0.7, seg: M.ctx.seg(10) }); }, 0, el);
  for (const s of [1, -1]) g.pipe([2.4, PADH + 0.26, -0.2 + s * 0.2], [1.5 + Math.cos(el) * 1.1, PADH + 0.3 + Math.sin(el) * 1.1, -0.2 + s * 0.2], 0.05, { seg: 6, c: pal.steelLt });
  M.muzzle(1.5 + Math.cos(el) * 2.5 - Math.sin(el) * 0.2, PADH + 0.3 + Math.sin(el) * 2.5 + Math.cos(el) * 0.2, -0.2);
  g.box(0.2, PADH + 0.16, -0.2, 0.9, 0.14, 0.5, { c: pal.gun, b: 0.02 });
  missile(g, -0.9, PADH + 0.4, -0.2, { len: 1.8, r: 0.15, c: pal.missileG, tip: pal.gun, band: pal.team, fins: 0, noseLen: 0.6, seg: M.ctx.seg(10) });
  // Shahed racks (5 cells each)
  for (const z of [-2.6, 2.3]) {
    g.box(1.8, PADH + 0.14, z, 1.6, 0.2, 0.9, { c: pal.gun, b: 0.03 });
    g.at(1.2, PADH + 0.26, z, () => {
      g.box(0.6, 0.36, 0, 1.3, 0.74, 0.86, { c: mulC(pal.base, 0.85), b: 0.02, camo: 0 });
      for (let i = 0; i < 5; i++) { g.box(1.254, 0.08 + i * 0.14, 0, 0.008, 0.11, 0.76, { c: pal.black, b: 0, tone: false }); shahed(g, 1.22, 0.08 + i * 0.14, 0, 0, 0, 1.2); }
      g.box(0.6, 0.736, 0, 0.5, 0.012, 0.6, { c: pal.team, b: 0, tone: false });
    }, 0, 0.5);
    M.muzzle(1.2 + Math.cos(0.5) * 1.26 - Math.sin(0.5) * 0.36, PADH + 0.26 + Math.sin(0.5) * 1.26 + Math.cos(0.5) * 0.36, z);
  }
  // camo netting + lookout
  g.prismY([[0.2, 1.0], [1.4, 0.9], [1.5, 1.9], [0.3, 2.1]], PADH + 0.8, PADH + 0.83, { c: (x, y, z) => ((Math.round(x * 5) + Math.round(z * 5)) % 2 ? rockDk : pal.dark), b: 0, tess: hi ? 0.3 : 0 });
  for (const [x, z] of [[0.25, 1.05], [1.4, 0.95], [1.45, 1.85], [0.35, 2.05]]) g.cylY(x, PADH, PADH + 0.8, z, 0.02, { seg: 4, c: pal.wood });
  crates(g, 0.7, 1.4, 5);
  mast(M, g, -1.7, -0.2, 0.9, { y0: PADH + 2.5, w: 0.16 });
}

export function buildSuper(M, def, half) {
  const g = M.part('base'), em = M.part('base', { mat: 'emissive' });
  const n = (def.name || '') + ' ' + (def.faction || '') + ' ' + (def.unlocks || '');
  swSite(M, g, em, half);
  if (/October|Egypt/i.test(n)) swOctober(M, g, em, half);
  else if (/Crescent|Saudi/i.test(n)) swCrescent(M, g, em, half);
  else if (/Falcon|UAE/i.test(n)) swFalcon(M, g, em, half);
  else if (/Hellwind|Algeria/i.test(n)) swHellwind(M, g, em, half);
  else if (/Tayfun|Turkey/i.test(n)) swTayfun(M, g, em, half);
  else if (/Adir|Israel/i.test(n)) swAdir(M, g, em, half);
  else if (/Trishul|India/i.test(n)) swTrishul(M, g, em, half);
  else if (/Ghaznavi|Pakistan/i.test(n)) swGhaznavi(M, g, em, half);
  else if (/Raad|Fath|Iran/i.test(n)) swRaad(M, g, em, half);
  else swOctober(M, g, em, half);
  return {};
}
