// Structures: the eleven common buildings (SH-01..SH-11) + dispatch.
// Footprint (map cells): SW 4x4, Def 2x2, everything else 3x3; 1 cell = 2 units; models fill ~88%.

import { DEG, TAU, mixC, mulC, lerp, hashInt } from './geo.js';
import {
  lattice, dish, radarPanel, sandbagWall, flagPole, hazardStrip, thinBarrel, gunBarrel, canister, hmg, missile,
} from './parts.js';
import {
  PADH, footprintOf, halfOf, pad, house, door, windows, chimney, coolingTower, tankV, mast, radome, container,
  floodlight, pipeRun, wallRun, crates,
} from './site.js';
import { buildSAM, buildUnique, buildSuper } from './structures2.js';

export { footprintOf };

// ---------------------------------------------------------------- SH-01 construction yard

function conyard(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), glass = M.part('base', { mat: 'glass' }), em = M.part('base', { mat: 'emissive' });
  pad(g, half);
  // assembly hall (back-left) with sawtooth roof and a big door facing +X
  const hx = -0.95, hz = -0.9;
  const top = house(g, hx, hz, 2.9, 2.7, 1.25, { roof: 'saw', teeth: 4, rise: 0.36, roofC: pal.roof });
  for (let i = 0; i < 4; i++) glass.box(hx - 1.45 + i * 0.725 + 0.085, PADH + 1.25 + 0.18, hz, 0.012, 0.26, 2.5, { c: pal.glassD, b: 0, rot: [0, 0.2, 0] });
  door(g, hx + 1.45, hz, 1.5, 0.95, '+x', { slats: 5 });
  hazardStrip(g, hx + 1.6, PADH + 0.006, hz, 1.7, 0.1, { alongZ: true });
  M.door(hx + 1.8, 0, hz);
  g.box(hx, PADH + 1.0, hz + 1.356, 2.6, 0.2, 0.012, { c: pal.team, b: 0, tone: false });
  windows(glass, hx, PADH + 0.62, hz + 1.35, 2.5, 6, '+z', { em, lit: 0.3 });
  // office block (front-left corner)
  const ox = -1.75, oz = 1.55;
  const ot = house(g, ox, oz, 1.5, 1.7, 1.7, { roof: 'flat', trim: pal.team, c: pal.wallLt });
  for (const y of [0.55, 1.05, 1.5]) { windows(glass, ox + 0.75, PADH + y - 0.1, oz, 1.5, 4, '+x', { em, lit: 0.3 }); windows(glass, ox, PADH + y - 0.1, oz + 0.85, 1.3, 3, '+z', { em, lit: 0.25 }); }
  g.box(ox - 0.3, ot + 0.1, oz - 0.3, 0.4, 0.2, 0.5, { c: pal.steelLt, b: 0.02 }); // rooftop HVAC
  mast(M, g, ox + 0.4, oz + 0.5, 0.9, { y0: ot, w: 0.14 });
  flagPole(g, ox + 0.95, ot - 0.02 - 1.7, oz + 1.0, 1.4);
  // cement silo + hopper
  const sx = 0.2, sz = 2.0;
  g.lathe('y', [[PADH + 0.5, 0.06], [PADH + 0.85, 0.34], [PADH + 1.9, 0.34], [PADH + 2.0, 0.2], [PADH + 2.0, 0]], { at: [sx, 0, sz], seg: M.ctx.seg(10), colors: [pal.steelLt, pal.steelLt, pal.steelLt, pal.steel, pal.steel], crease: 40, cap0: true });
  for (let i = 0; i < 4; i++) { const a = i * TAU / 4 + 0.78; g.beam([sx + Math.cos(a) * 0.3, PADH, sz + Math.sin(a) * 0.3], [sx + Math.cos(a) * 0.3, PADH + 1.0, sz + Math.sin(a) * 0.3], 0.05, { c: pal.steel }); }
  g.lathe('y', [[PADH + 1.3, 0.345], [PADH + 1.5, 0.345]], { at: [sx, 0, sz], seg: M.ctx.seg(10), c: pal.team, cap0: false, cap1: false, tone: false });
  // prefab yard: container stack, concrete panels, pipes
  container(g, 1.7, PADH, 1.9, 0.9, pal.team, 0.0);
  container(g, 1.75, PADH, 1.5, 0.9, pal.yellow, 0.04);
  container(g, 1.72, PADH + 0.34, 1.72, 0.9, mulC(pal.steelLt, 0.9), -0.05);
  for (let i = 0; i < 4; i++) g.box(0.9, PADH + 0.04 + i * 0.07, 0.9, 0.9, 0.06, 0.6, { c: i % 2 ? pal.concreteLt : pal.concrete, b: 0.006, rot: [0.3 + i * 0.02, 0, 0] });
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2 - (i > 1 ? 1 : 0); j++) g.cylX(1.3, 2.3, PADH + 0.09 + i * 0.15, -0.3 - j * 0.18 - i * 0.09, 0.085, { seg: 7, c: i % 2 ? pal.steelLt : pal.steel });
  // tower crane (rotating jib)
  const cx = 1.75, cz = -1.6, ch = 3.5;
  g.box(cx, PADH + 0.1, cz, 0.7, 0.2, 0.7, { c: pal.concreteDk, b: 0.02 });
  lattice(g, cx, PADH + 0.2, PADH + ch, cz, 0.3, { w1: 0.3, c: pal.yellow, n: hi ? 8 : 5 });
  const J = M.part('crane', { at: [cx, PADH + ch, cz] });
  J.at(cx, PADH + ch, cz, () => {
    J.cylY(0, 0, 0.12, 0, 0.16, { seg: 8, c: pal.gun });
    J.box(0.05, 0.24, 0.16, 0.3, 0.24, 0.22, { c: pal.wallLt, b: 0.02 }); // operator cab
    J.box(0.2, 0.26, 0.16, 0.012, 0.14, 0.18, { c: pal.glassD, b: 0, tone: false });
    // jib (toward -x so it sweeps over the yard) + counter-jib
    const jl = 2.5, kl = 0.9;
    for (const s of [1, -1]) { J.beam([kl, 0.16, s * 0.1], [-jl, 0.16, s * 0.07], 0.035, { c: pal.yellow }); }
    J.beam([0, 0.46, 0], [-jl, 0.2, 0], 0.03, { c: pal.yellow });
    J.beam([0, 0.46, 0], [kl, 0.2, 0], 0.03, { c: pal.yellow });
    const n = hi ? 9 : 5;
    for (let i = 0; i < n; i++) { const u = (i + 0.5) / n; for (const s of [1, -1]) J.beam([-jl * u, 0.16, s * 0.09], [-jl * (u + 0.5 / n), lerp(0.46, 0.2, u + 0.5 / n), 0], 0.018, { c: pal.yellow }); }
    J.cylY(0, 0.12, 0.62, 0, 0.05, { seg: 6, c: pal.yellow });
    J.box(kl - 0.14, 0.06, 0, 0.3, 0.2, 0.26, { c: pal.concreteDk, b: 0.02 }); // counterweight
    // trolley, cable and a prefab panel on the hook
    J.box(-1.5, 0.11, 0, 0.16, 0.06, 0.2, { c: pal.gun, b: 0 });
    J.cylY(-1.5, -1.3, 0.1, 0, 0.008, { seg: 4, c: pal.black });
    J.box(-1.5, -1.42, 0, 0.5, 0.24, 0.05, { c: pal.team, b: 0.01, tone: false });
    J.box(-jl, 0.19, 0, 0.1, 0.1, 0.14, { c: pal.red, b: 0, tone: false });
  }, 0.5);
  M.spin('crane', 'y', 0.12);
  M.light(cx, PADH + ch + 0.66, cz);
  floodlight(M, g, em, 2.3, 0.4, 1.3, Math.PI * 0.9);
  M.stack(hx - 0.9, top, hz - 0.8);
  g.cylY(hx - 0.9, PADH + 1.25, top + 0.0, hz - 0.8, 0.09, { seg: 7, c: pal.steel });
  return {};
}

// ---------------------------------------------------------------- SH-02 power plant

function powerPlant(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), glass = M.part('base', { mat: 'glass' }), em = M.part('base', { mat: 'emissive' });
  pad(g, half);
  // turbine hall
  const tx = 0.75, tz = 0.95;
  const top = house(g, tx, tz, 3.3, 1.7, 1.15, { roof: 'archX', rise: 0.42, roofC: pal.roof });
  windows(glass, tx, PADH + 0.78, tz + 0.85, 3.0, 7, '+z', { h: 0.24, em, lit: 0.45 });
  g.box(tx, PADH + 0.34, tz + 0.856, 3.2, 0.14, 0.012, { c: pal.team, b: 0, tone: false });
  door(g, tx + 1.65, tz, 0.7, 0.75, '+x', { slats: 4 });
  for (let i = 0; i < 3; i++) g.box(tx - 1.1 + i * 1.1, top - 0.02, tz, 0.3, 0.12, 0.36, { c: pal.steelLt, b: 0.02 });
  // roof ventilator fan
  const F = M.part('fan', { at: [tx, top + 0.1, tz] });
  F.cylY(tx, top + 0.04, top + 0.1, tz, 0.05, { seg: 6, c: pal.gun });
  for (let i = 0; i < 4; i++) F.at(tx, top + 0.1, tz, () => F.box(0.13, 0, 0, 0.2, 0.012, 0.08, { c: pal.steelLt, b: 0, rot: [0, 0, 0.3] }), i * TAU / 4);
  g.lathe('y', [[top - 0.04, 0.3], [top + 0.06, 0.3], [top + 0.06, 0.26]], { at: [tx, 0, tz], seg: M.ctx.seg(10), c: pal.steel, cap0: false, cap1: false });
  M.spin('fan', 'y', 5);
  // cooling towers
  coolingTower(M, g, -1.45, -1.25, 1.02, 2.5);
  coolingTower(M, g, 0.55, -1.5, 0.9, 2.2);
  // stack
  chimney(M, g, -2.05, 1.9, 0.2, 3.5, { bands: 4 });
  // boiler house between
  const bt = house(g, -1.65, 0.75, 1.3, 1.3, 1.6, { roof: 'flat', c: pal.wallDk, trim: pal.steel });
  pipeRun(g, [[-1.65, bt + 0.1, 0.75], [-1.65, bt + 0.3, 0.75], [-2.05, bt + 0.3, 1.5], [-2.05, bt + 0.3, 1.82]], 0.09);
  pipeRun(g, [[-1.0, PADH + 0.9, 0.5], [-0.4, PADH + 0.9, 0.5], [-0.4, PADH + 0.9, -0.3], [-0.9, PADH + 0.9, -0.6]], 0.07, pal.team);
  pipeRun(g, [[0.6, PADH + 0.8, 0.12], [0.6, PADH + 0.8, -0.6]], 0.07, pal.steelLt);
  // transformer yard + pylon
  for (let i = 0; i < 3; i++) {
    const x = 1.35 + i * 0.5, z = -0.75;
    g.box(x, PADH + 0.2, z, 0.34, 0.4, 0.3, { c: pal.steel, b: 0.02 });
    if (hi) for (const k of [-0.09, 0.09]) g.cylY(x + k, PADH + 0.4, PADH + 0.58, z, 0.022, { seg: 5, c: pal.white });
    g.box(x, PADH + 0.2, z + 0.17, 0.26, 0.3, 0.03, { c: pal.gun, b: 0 });
  }
  lattice(g, 2.2, PADH, PADH + 1.7, -1.9, 0.3, { w1: 0.12, c: pal.steel });
  g.box(2.2, PADH + 1.5, -1.9, 0.05, 0.04, 1.0, { c: pal.steel, b: 0 });
  g.box(2.2, PADH + 1.15, -1.9, 0.05, 0.04, 0.8, { c: pal.steel, b: 0 });
  M.light(2.2, PADH + 1.74, -1.9);
  for (let i = 0; i < 6; i++) g.box(1.1 + i * 0.26, PADH + 0.25, -0.3, 0.02, 0.5, 0.02, { c: pal.steel, b: 0 });
  g.box(1.75, PADH + 0.5, -0.3, 1.4, 0.02, 0.02, { c: pal.steel, b: 0 });
  hazardStrip(g, 1.85, PADH + 0.006, -0.3, 1.5, 0.08);
  M.door(tx + 1.9, 0, tz);
  // energy glow strip on the hall
  em.box(tx, PADH + 1.1, tz + 0.858, 2.6, 0.03, 0.006, { c: [0.3, 0.9, 1.0], b: 0 });
  return {};
}

// ---------------------------------------------------------------- SH-03 oil depot

function oilDepot(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), em = M.part('base', { mat: 'emissive' });
  pad(g, half);
  // tank farm inside a bund wall
  tankV(g, -1.5, -1.35, 0.95, 1.15, { stairA: 0.5 });
  tankV(g, 0.55, -1.55, 0.8, 1.0, { stairA: 2.0 });
  tankV(g, -1.7, 0.75, 0.6, 0.8, { c: mixC(pal.steelLt, pal.concrete, 0.4), stairs: false });
  for (const [a, b] of [[[-2.56, -2.56], [1.5, -2.56]], [[-2.56, -2.56], [-2.56, 1.5]], [[1.5, -2.56], [1.5, -0.55]]]) wallRun(g, a, b, 0.22, { t: 0.08, stripe: false, c: pal.concreteDk });
  // manifold pipework
  pipeRun(g, [[-0.55, PADH + 0.2, -1.35], [-0.2, PADH + 0.2, -1.35], [-0.2, PADH + 0.2, -0.3], [1.4, PADH + 0.2, -0.3]], 0.07, pal.steelLt);
  pipeRun(g, [[0.55, PADH + 0.2, -0.75], [0.55, PADH + 0.2, -0.3]], 0.07, pal.steelLt);
  pipeRun(g, [[-1.7, PADH + 0.2, 0.15], [-1.7, PADH + 0.2, -0.3], [-0.2, PADH + 0.2, -0.3]], 0.06, pal.team);
  for (const [x, z] of [[-0.2, -0.8], [0.9, -0.3], [-0.9, -0.3]]) { g.cylY(x, PADH + 0.2, PADH + 0.42, z, 0.02, { seg: 5, c: pal.gun }); g.cylY(x, PADH + 0.42, PADH + 0.44, z, 0.08, { seg: 8, c: pal.red, tone: false }); }
  // pumpjack with rotating crank
  const px = 1.55, pz = 1.55;
  g.box(px, PADH + 0.05, pz, 1.6, 0.1, 0.5, { c: pal.concreteDk, b: 0.014 });
  for (const s of [1, -1]) g.beam([px + 0.25, PADH + 0.1, pz + s * 0.16], [px + 0.05, PADH + 1.05, pz], 0.06, { c: pal.yellow });
  g.beam([px - 0.2, PADH + 0.1, pz], [px + 0.05, PADH + 1.05, pz], 0.05, { c: pal.yellow });
  g.at(px + 0.05, PADH + 1.08, pz, () => {
    g.box(0, 0, 0, 1.5, 0.1, 0.1, { c: pal.team, b: 0.014, tone: false }); // walking beam
    g.prismZ([[0.72, 0.16], [0.9, 0.06], [0.9, -0.26], [0.72, -0.16]], -0.07, 0.07, { c: pal.team, b: 0.012, tone: false }); // horse head
  }, 0, -0.14);
  g.cylY(px + 0.88, PADH + 0.1, PADH + 0.92, pz, 0.014, { seg: 4, c: pal.steelLt });
  g.cylY(px + 0.88, PADH + 0.05, PADH + 0.3, pz, 0.07, { seg: 7, c: pal.gun });
  g.box(px - 0.5, PADH + 0.3, pz, 0.34, 0.4, 0.3, { c: pal.steel, b: 0.02 }); // gearbox + motor
  g.beam([px - 0.64, PADH + 0.92 + 0.26, pz], [px - 0.5, PADH + 0.55, pz + 0.19], 0.03, { c: pal.steel });
  const C = M.part('crank', { at: [px - 0.5, PADH + 0.42, pz + 0.19] });
  C.at(px - 0.5, PADH + 0.42, pz + 0.19, () => {
    C.box(0.12, 0, 0, 0.36, 0.09, 0.05, { c: pal.yellow, b: 0.01 });
    C.cylZ(0.26, 0, -0.03, 0.06, 0.13, { seg: 8, c: pal.gun });
    C.cylZ(0, 0, -0.04, 0.05, 0.05, { seg: 6, c: pal.steelLt });
  });
  M.spin('crank', 'z', 2.2);
  // loading bay canopy (harvester drop-off) facing +X
  const lx = 1.75, lz = -0.3 + 0.75;
  for (const [x, z] of [[lx - 0.55, lz - 0.4], [lx + 0.55, lz - 0.4], [lx - 0.55, lz + 0.4], [lx + 0.55, lz + 0.4]]) g.cylY(x, PADH, PADH + 0.95, z, 0.04, { seg: 5, c: pal.steel });
  g.box(lx, PADH + 1.0, lz, 1.4, 0.08, 1.1, { c: pal.team, b: 0.02, tone: false });
  g.box(lx, PADH + 1.045, lz, 1.2, 0.012, 0.9, { c: pal.roof, b: 0 });
  pipeRun(g, [[1.4, PADH + 0.2, -0.3], [1.4, PADH + 0.85, -0.3], [1.4, PADH + 0.85, lz], [1.4, PADH + 0.5, lz]], 0.05, pal.steelLt);
  hazardStrip(g, lx, PADH + 0.006, lz, 1.3, 0.1);
  M.door(lx + 0.6, 0, lz);
  // flare stack
  lattice(g, -0.35, PADH, PADH + 2.3, 2.0, 0.26, { w1: 0.1, c: pal.steel });
  g.cylY(-0.35, PADH, PADH + 2.6, 2.0, 0.035, { seg: 6, c: pal.gun });
  em.lathe('y', [[PADH + 2.6, 0.04], [PADH + 2.72, 0.07], [PADH + 2.95, 0.0]], { at: [-0.35, 0, 2.0], seg: 6, colors: [[1.6, 1.1, 0.4], pal.flame, [1.0, 0.25, 0.03]], cap0: false, cap1: false });
  M.stack(-0.35, PADH + 2.9, 2.0);
  M.light(-0.35, PADH + 2.62, 2.0);
  if (hi) for (let i = 0; i < 5; i++) g.cylY(-1.0 + i * 0.2, PADH, PADH + 0.26, 1.9 + (i % 2) * 0.16, 0.085, { seg: 7, c: i % 2 ? pal.team : pal.blue, b: 0.01 });
  return {};
}

// ---------------------------------------------------------------- SH-04 barracks

function barracks(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), glass = M.part('base', { mat: 'glass' }), em = M.part('base', { mat: 'emissive' });
  pad(g, half, { c: mixC(pal.concrete, pal.sandbag, 0.35) });
  // two long dormitory blocks with gable roofs
  for (const [z, len] of [[-1.75, 3.9], [-0.35, 3.0]]) {
    const x = -2.5 + len / 2;
    const top = house(g, x, z, len, 1.05, 0.72, { roof: 'gableX', rise: 0.34, roofC: mulC(pal.dark, 1.1) });
    windows(glass, x, PADH + 0.44, z + 0.525, len - 0.3, Math.round(len / 0.5), '+z', { em, lit: 0.3 });
    // team stripes on both roof slopes
    for (const s of [1, -1]) for (const k of [-0.3, 0.3]) g.box(x + k * len, PADH + 0.72 + 0.2, z + s * 0.29, 0.26, 0.012, 0.6, { c: pal.team, b: 0, tone: false, rot: [0, 0, s * 0.55] });
    door(g, x + len / 2, z, 0.3, 0.5, '+x', { c: pal.wood });
    void top;
  }
  // HQ hut + mess
  const ht = house(g, -1.7, 1.75, 1.6, 1.3, 0.85, { roof: 'flat', trim: pal.team, c: pal.wallLt });
  windows(glass, -1.7, PADH + 0.5, 1.75 - 0.65, 1.3, 3, '-z', { em, lit: 0.4 });
  door(g, -0.9, 1.75, 0.3, 0.55, '+x', { c: pal.wood });
  mast(M, g, -2.2, 2.1, 1.1, { y0: ht, w: 0.14 });
  // guard tower (front-right corner)
  const tx = 2.05, tz = 2.05, th = 1.7;
  for (const sx of [1, -1]) for (const sz of [1, -1]) g.beam([tx + sx * 0.3, PADH, tz + sz * 0.3], [tx + sx * 0.22, PADH + th, tz + sz * 0.22], 0.05, { c: pal.wood });
  if (hi) for (const s of [1, -1]) { g.beam([tx + 0.3, PADH + 0.1, tz + s * 0.3], [tx - 0.24, PADH + th * 0.9, tz + s * 0.24], 0.03, { c: pal.wood }); g.beam([tx + s * 0.3, PADH + 0.1, tz - 0.3], [tx + s * 0.24, PADH + th * 0.9, tz + 0.24], 0.03, { c: pal.wood }); }
  g.box(tx, PADH + th, tz, 0.66, 0.05, 0.66, { c: pal.wood, b: 0.01 });
  for (const [dx, dz, sx, sz] of [[0.31, 0, 0.04, 0.66], [-0.31, 0, 0.04, 0.66], [0, 0.31, 0.66, 0.04], [0, -0.31, 0.66, 0.04]]) g.box(tx + dx, PADH + th + 0.16, tz + dz, sx, 0.28, sz, { c: pal.sandbag, b: 0.014 });
  for (const sx of [1, -1]) for (const sz of [1, -1]) g.beam([tx + sx * 0.3, PADH + th + 0.3, tz + sz * 0.3], [tx + sx * 0.3, PADH + th + 0.62, tz + sz * 0.3], 0.03, { c: pal.wood });
  g.box(tx, PADH + th + 0.66, tz, 0.84, 0.05, 0.84, { c: pal.team, b: 0.012, tone: false });
  M.light(tx, PADH + th + 0.72, tz);
  em.box(tx - 0.3, PADH + th + 0.54, tz - 0.3, 0.07, 0.06, 0.07, { c: [1.0, 0.93, 0.7], b: 0 });
  // parade ground with flag
  const y = PADH + 0.005;
  g.decal(0.95, y, 1.25, 2.0, 1.5, { c: mixC(pal.concrete, pal.asphalt, 0.45) });
  for (const s of [1, -1]) { g.decal(0.95, y + 0.002, 1.25 + s * 0.72, 2.0, 0.04, { c: pal.white }); g.decal(0.95 + s * 0.98, y + 0.002, 1.25, 0.04, 1.5, { c: pal.white }); }
  g.disc(0.95, y + 0.003, 1.25, 0.3, { r0: 0.24, c: pal.team });
  flagPole(g, 0.95, PADH, 1.25, 1.9, { w: 0.6, h: 0.36 });
  g.cylY(0.95, PADH, PADH + 0.08, 1.25, 0.12, { seg: 8, c: pal.concreteDk });
  // gate (facing +X) with sandbag checkpoint + barrier
  wallRun(g, [2.56, -2.56], [2.56, 0.45], 0.42);
  wallRun(g, [2.56, 1.25], [2.56, 1.65], 0.42);
  sandbagWall(g, [2.25, 0, 0.35], [2.25, 0, -0.35], 3);
  g.cylY(2.5, PADH, PADH + 0.4, 0.5, 0.04, { seg: 6, c: pal.gun });
  g.at(2.5, PADH + 0.38, 0.5, () => { for (let i = 0; i < 5; i++) g.box(0.08 + i * 0.16, 0, 0, 0.16, 0.05, 0.05, { c: i % 2 ? pal.white : pal.red, b: 0, tone: false }); }, -Math.PI / 2 - 0.0, 0.5);
  M.door(2.4, 0, 0.85);
  // tents + training
  for (const [x, z] of [[1.3, -1.9], [2.0, -1.2]]) {
    g.prismX([[z - 0.34, PADH], [z + 0.34, PADH], [z, PADH + 0.42]], x - 0.4, x + 0.4, { c: pal.canvas, b: 0.01 });
    g.box(x + 0.405, PADH + 0.14, z, 0.006, 0.26, 0.2, { c: mulC(pal.canvas, 0.5), b: 0 });
  }
  crates(g, 0.3, -1.1, 5);
  if (hi) for (let i = 0; i < 4; i++) g.box(0.6 + i * 0.28, PADH + 0.16, 0.25, 0.04, 0.32, 0.5, { c: pal.wood, b: 0 }); // obstacle walls
  return {};
}

// ---------------------------------------------------------------- SH-05 war factory

function warFactory(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), glass = M.part('base', { mat: 'glass' }), em = M.part('base', { mat: 'emissive' });
  pad(g, half);
  // main assembly hall: huge roller door on +X
  const hx = -0.5, hz = -0.35, sx = 3.9, sz = 3.5, h = 1.5;
  const top = house(g, hx, hz, sx, sz, h, { roof: 'archX', rise: 0.5, roofC: pal.roof, c: pal.wall });
  // heavy portal frame + door
  const fx = hx + sx / 2;
  door(g, fx, hz, 2.3, 1.15, '+x', { slats: 8, c: mulC(pal.gun, 0.8) });
  for (const s of [1, -1]) g.box(fx + 0.06, PADH + 0.68, hz + s * 1.3, 0.2, 1.36, 0.22, { c: pal.concreteDk, b: 0.02 });
  for (const s of [1, -1]) for (let i = 0; i < 5; i++) g.box(fx + 0.166, PADH + 0.12 + i * 0.22, hz + s * 1.3, 0.008, 0.11, 0.22, { c: i % 2 ? pal.hazK : pal.yellow, b: 0, tone: false });
  g.box(fx + 0.08, PADH + 1.36 + 0.0, hz, 0.14, 0.14, 2.82, { c: pal.team, b: 0.02, tone: false });
  em.box(fx + 0.155, PADH + 1.36, hz, 0.006, 0.05, 1.2, { c: [1.0, 0.75, 0.2], b: 0 });
  // ramp + guide stripes
  g.box(fx + 0.5, PADH + 0.02, hz, 1.0, 0.04, 2.3, { c: pal.asphalt, b: 0, warp: (p, s0, s1) => { if (s0 > 0 && s1 > 0) p[1] -= 0.035; } });
  for (const s of [1, -1]) hazardStrip(g, fx + 0.55, PADH + 0.05, hz + s * 1.1, 1.0, 0.09);
  M.door(fx + 1.0, 0, hz);
  // roof: team stripes over the arch, skylight strip, exhaust fans
  for (const k of [-0.34, 0.0, 0.34]) g.box(hx + k * sx, top + 0.006, hz, 0.34, 0.012, 0.7, { c: pal.team, b: 0, tone: false });
  glass.box(hx, top - 0.01, hz - 0.62, sx * 0.84, 0.012, 0.22, { c: pal.glassD, b: 0, rot: [0, 0, -0.42] });
  glass.box(hx, top - 0.01, hz + 0.62, sx * 0.84, 0.012, 0.22, { c: pal.glassD, b: 0, rot: [0, 0, 0.42] });
  const F = M.part('fan', { at: [hx - 1.2, top + 0.14, hz] });
  g.lathe('y', [[top - 0.04, 0.3], [top + 0.1, 0.3], [top + 0.1, 0.26]], { at: [hx - 1.2, 0, hz], seg: M.ctx.seg(10), c: pal.steel, cap0: false, cap1: false });
  F.cylY(hx - 1.2, top + 0.06, top + 0.14, hz, 0.05, { seg: 6, c: pal.gun });
  for (let i = 0; i < 5; i++) F.at(hx - 1.2, top + 0.13, hz, () => F.box(0.14, 0, 0, 0.22, 0.012, 0.09, { c: pal.steelLt, b: 0, rot: [0, 0, 0.3] }), i * TAU / 5);
  M.spin('fan', 'y', 6);
  // side windows + annex with stacks
  windows(glass, hx, PADH + 1.0, hz + sz / 2, sx - 0.4, 8, '+z', { h: 0.22, em, lit: 0.4 });
  g.box(hx, PADH + 0.4, hz + sz / 2 + 0.006, sx - 0.2, 0.12, 0.012, { c: pal.team, b: 0, tone: false });
  const at = house(g, -1.2, 2.05, 2.2, 0.95, 0.95, { roof: 'flat', c: pal.wallDk, trim: pal.steel });
  for (const x of [-1.9, -1.4]) { g.cylY(x, at, at + 0.95, 2.05, 0.1, { seg: 8, c: pal.steel, b: 0.01 }); g.cylY(x, at + 0.95, at + 1.0, 2.05, 0.12, { seg: 8, c: pal.gun }); M.stack(x, at + 1.02, 2.05); }
  g.box(-0.55, at + 0.12, 2.05, 0.5, 0.24, 0.5, { c: pal.steelLt, b: 0.02 });
  // overhead gantry crane rails poking out of the door
  for (const s of [1, -1]) g.box(fx + 0.5, PADH + 1.3, hz + s * 0.9, 1.1, 0.07, 0.07, { c: pal.yellow, b: 0 });
  for (const s of [1, -1]) g.cylY(fx + 1.0, PADH, PADH + 1.3, hz + s * 0.9, 0.04, { seg: 5, c: pal.yellow });
  g.box(fx + 0.7, PADH + 1.3, hz, 0.12, 0.1, 1.9, { c: pal.yellow, b: 0.01 });
  g.box(fx + 0.7, PADH + 1.2, hz + 0.3, 0.16, 0.12, 0.2, { c: pal.gun, b: 0 });
  // yard: spare turret, track stacks, fuel drums, containers
  g.lathe('y', [[PADH, 0.3], [PADH + 0.12, 0.3], [PADH + 0.2, 0.2], [PADH + 0.2, 0]], { at: [2.0, 0, 1.9], seg: M.ctx.seg(10), c: pal.base, crease: 50, cap0: false, k2: 1.2 });
  g.cylX(2.2, 2.9 - 0.4, PADH + 0.12, 1.9, 0.03, { seg: 6, c: pal.gun });
  container(g, 0.9, PADH, 2.25, 0.9, pal.team, 0.02);
  container(g, 0.92, PADH + 0.34, 2.25, 0.9, mulC(pal.steelLt, 0.85), -0.03);
  if (hi) for (let i = 0; i < 5; i++) g.cylY(2.2 + (i % 3) * 0.19, PADH, PADH + 0.26, -2.3 + Math.floor(i / 3) * 0.19, 0.085, { seg: 7, c: i % 2 ? pal.red : pal.blue, b: 0.01 });
  floodlight(M, g, em, 2.4, 0.9, 1.4, Math.PI);
  floodlight(M, g, em, 2.4, -1.7, 1.4, Math.PI);
  M.light(hx, top + 0.02, hz - 1.0);
  return {};
}

// ---------------------------------------------------------------- SH-06 airfield / helipad

function airfield(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), glass = M.part('base', { mat: 'glass' }), em = M.part('base', { mat: 'emissive' });
  pad(g, half, { marks: false });
  const y = PADH + 0.004;
  // runway strip along X on the front half
  const rz = 1.45, rw = 1.5;
  g.decal(0, y, rz, half * 2 - 0.06, rw, { c: pal.asphalt });
  for (let i = 0; i < 6; i++) g.decal(-1.95 + i * 0.78, y + 0.002, rz, 0.4, 0.05, { c: pal.white });
  for (const s of [1, -1]) g.decal(0, y + 0.002, rz + s * (rw / 2 - 0.06), half * 2 - 0.3, 0.03, { c: pal.white });
  for (const s of [1, -1]) for (let i = 0; i < 5; i++) g.decal(s * 2.35, y + 0.002, rz - 0.5 + i * 0.25, 0.3, 0.09, { c: pal.white }); // threshold bars
  for (const s of [1, -1]) g.decal(s * 1.75, y + 0.002, rz, 0.16, 0.6, { c: pal.team });
  // helipad
  const hx = 1.55, hz = -1.35;
  g.disc(hx, y, hz, 0.95, { c: mixC(pal.asphalt, pal.concrete, 0.2) });
  g.disc(hx, y + 0.002, hz, 0.86, { r0: 0.76, c: pal.team });
  for (const s of [1, -1]) g.decal(hx + s * 0.2, y + 0.003, hz, 0.1, 0.62, { c: pal.white });
  g.decal(hx, y + 0.003, hz, 0.4, 0.1, { c: pal.white });
  // taxi link
  g.decal(hx, y, 0.2, 0.5, 1.2, { c: pal.asphalt });
  g.decal(hx, y + 0.002, 0.2, 0.03, 1.1, { c: pal.yellow });
  // arched hangar (open toward +X)
  const ax = -1.2, az = -1.35, alen = 2.5, aw = 2.3;
  const top = house(g, ax, az, alen, aw, 0.35, { roof: 'archX', rise: 1.0, roofC: mulC(pal.base, 0.95), c: pal.wallDk, plinth: false });
  g.box(ax + alen / 2 + 0.01, PADH + 0.5, az, 0.03, 1.0, aw * 0.72, { c: pal.black, b: 0, tone: false, warp: (p, s0, s1) => { if (s1 > 0) p[2] *= 0.72; } });
  g.box(ax + alen / 2 + 0.03, PADH + 1.2, az, 0.05, 0.12, 0.9, { c: pal.team, b: 0.01, tone: false });
  for (const k of [-0.3, 0.3]) g.box(ax + k * alen, top + 0.004, az, 0.3, 0.012, 0.7, { c: pal.team, b: 0, tone: false });
  M.door(ax + alen / 2 + 0.5, 0, az);
  // parked jet nose peeking out
  g.lathe('x', [[0.9, 0.002], [0.6, 0.07], [0.0, 0.1]], { at: [ax + alen / 2 - 0.3, PADH + 0.3, az], seg: 8, c: pal.steelLt, cap1: true });
  // control tower
  const tx = -2.0, tz = 0.25;
  house(g, tx, tz, 0.8, 0.8, 0.5, { roof: 'flat', c: pal.wallLt });
  g.box(tx, PADH + 1.25, tz, 0.44, 1.6, 0.44, { c: pal.wallLt, b: 0.02 });
  g.tbox(tx, PADH + 2.12, tz, 0.5, 0.14, 0.5, 0.8, 0.8, { c: pal.wallDk, b: 0.014 });
  glass.tbox(tx, PADH + 2.36, tz, 0.76, 0.34, 0.76, 0.92, 0.92, { c: pal.glassD, b: 0.008 });
  g.box(tx, PADH + 2.56, tz, 0.98, 0.06, 0.98, { c: pal.team, b: 0.014, tone: false });
  const R = M.part('radar', { at: [tx, PADH + 2.7, tz] });
  R.cylY(tx, PADH + 2.59, PADH + 2.74, tz, 0.03, { seg: 6, c: pal.gun });
  R.box(tx, PADH + 2.8, tz, 0.06, 0.14, 0.62, { c: pal.steelLt, b: 0.01 });
  R.box(tx + 0.034, PADH + 2.8, tz, 0.01, 0.1, 0.56, { c: pal.red, b: 0, tone: false });
  M.spin('radar', 'y', 1.6);
  M.light(tx, PADH + 2.92, tz);
  if (hi) for (let i = 0; i < 4; i++) glass.box(tx + (i % 2 ? 0.225 : -0.225) * (i < 2 ? 1 : 0), PADH + 1.3, tz + (i < 2 ? 0 : (i % 2 ? 0.225 : -0.225)), i < 2 ? 0.01 : 0.14, 0.9, i < 2 ? 0.14 : 0.01, { c: pal.glassD, b: 0 });
  // fuel bowser, windsock, runway lights
  g.cylX(-0.45, 0.25, PADH + 0.22, 0.25, 0.15, { seg: 8, c: pal.steelLt, b: 0.02 });
  g.box(0.42, PADH + 0.2, 0.25, 0.22, 0.28, 0.3, { c: pal.yellow, b: 0.02 });
  g.cylY(0.9, PADH, PADH + 0.9, 0.42, 0.015, { seg: 4, c: pal.steel });
  g.lathe('x', [[0, 0.06], [0.34, 0.025]], { at: [0.9, PADH + 0.88, 0.42], seg: 6, colors: [pal.orange, pal.white], cap0: false, cap1: false, tone: false });
  for (let i = 0; i < 7; i++) for (const s of [1, -1]) em.box(-2.3 + i * 0.77, PADH + 0.02, rz + s * (rw / 2 + 0.04), 0.04, 0.03, 0.04, { c: s > 0 ? [0.4, 0.9, 1.0] : [1.0, 0.85, 0.4], b: 0 });
  M.light(hx, PADH + 0.05, hz);
  M.door(2.2, 0, rz);
  return {};
}

// ---------------------------------------------------------------- SH-07 naval yard

function navalYard(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), glass = M.part('base', { mat: 'glass' }), em = M.part('base', { mat: 'emissive' });
  // U-shaped quay around a dry dock that opens toward +X
  const qh = 0.22, dw = 1.25; // dock half-width
  const quay = pal.concrete;
  g.box(-1.9, qh / 2, 0, 1.48, qh, half * 2, { c: quay, b: 0.02, skip: 8, tone: false }); // back
  for (const s of [1, -1]) g.box(0.74, qh / 2, s * (dw + (half - dw) / 2), 3.8, qh, half - dw, { c: quay, b: 0.02, skip: 8, tone: false });
  // dock floor (sunken) + keel blocks + water at the mouth
  g.box(0.74, 0.02, 0, 3.8, 0.04, dw * 2, { c: pal.concreteDk, b: 0, tone: false });
  g.decal(1.9, 0.045, 0, 1.4, dw * 2 - 0.04, { c: mixC(pal.blue, pal.black, 0.55) });
  if (hi) for (let i = 0; i < 6; i++) g.box(-0.9 + i * 0.36, 0.08, 0, 0.14, 0.08, 0.5, { c: pal.wood, b: 0 });
  for (const s of [1, -1]) hazardStrip(g, 0.74, qh + 0.005, s * (dw + 0.08), 3.6, 0.1);
  for (const sx of [1, -1]) for (const sz of [1, -1]) { g.decal(sx * 2.3, qh + 0.005, sz * 2.52, 0.5, 0.08, { c: pal.team }); g.decal(sx * 2.52, qh + 0.005, sz * 2.3, 0.08, 0.5, { c: pal.team }); }
  // hull under construction on the blocks
  g.xloft([
    { x: -1.05, y0: 0.14, y1: 0.62, w0: 0.26, w1: 0.44 }, { x: 0.3, y0: 0.14, y1: 0.62, w0: 0.3, w1: 0.48 }, { x: 1.0, y0: 0.16, y1: 0.64, w0: 0.16, w1: 0.34 }, { x: 1.5, y0: 0.3, y1: 0.68, w0: 0.01, w1: 0.03 },
  ], { c: (x, y) => (y < 0.3 ? pal.hullRed : pal.navy), ch: 0 });
  g.box(-0.3, 0.72, 0, 0.8, 0.22, 0.6, { c: pal.navy, b: 0.02 });
  if (hi) for (let i = 0; i < 5; i++) for (const s of [1, -1]) g.beam([-0.9 + i * 0.5, 0.05, s * 0.8], [-0.9 + i * 0.5, 0.5, s * 0.45], 0.03, { c: pal.yellow }); // shores
  // gantry crane straddling the dock
  const gx = 0.2, gh = 2.2;
  for (const s of [1, -1]) {
    for (const k of [-0.3, 0.3]) g.beam([gx + k, qh, s * (dw + 0.38)], [gx + k * 0.4, qh + gh, s * (dw + 0.3)], 0.09, { c: pal.yellow });
    g.box(gx, qh + 0.06, s * (dw + 0.38), 0.9, 0.12, 0.16, { c: pal.gun, b: 0.02 });
    if (hi) g.beam([gx - 0.3, qh + 0.1, s * (dw + 0.38)], [gx + 0.12, qh + gh, s * (dw + 0.3)], 0.04, { c: pal.yellow });
  }
  g.box(gx, qh + gh + 0.1, 0, 0.4, 0.26, (dw + 0.5) * 2, { c: pal.yellow, b: 0.03 });
  g.box(gx, qh + gh + 0.1, 0, 0.42, 0.1, 1.0, { c: pal.team, b: 0, tone: false });
  g.box(gx, qh + gh - 0.1, 0.4, 0.3, 0.16, 0.34, { c: pal.gun, b: 0.02 }); // trolley
  g.cylY(gx, qh + 1.3, qh + gh - 0.1, 0.4, 0.01, { seg: 4, c: pal.black });
  g.box(gx, qh + 1.24, 0.4, 0.1, 0.12, 0.06, { c: pal.yellow, b: 0 });
  M.light(gx, qh + gh + 0.26, dw + 0.4); M.light(gx, qh + gh + 0.26, -dw - 0.4);
  // workshop + office on the back quay
  const top = house(g, -1.95, -1.2, 1.2, 2.3, 1.0, { roof: 'archZ', rise: 0.36, y0: qh, roofC: pal.roof });
  windows(glass, -1.95 + 0.6, qh + 0.62, -1.2, 2.0, 5, '+x', { em, lit: 0.4 });
  g.box(-1.95, top + 0.004, -1.2, 0.5, 0.012, 0.6, { c: pal.team, b: 0, tone: false });
  const ot = house(g, -2.0, 1.55, 1.0, 1.4, 1.4, { roof: 'flat', y0: qh, c: pal.wallLt, trim: pal.team });
  for (const yy of [0.5, 1.0]) windows(glass, -1.5, qh + yy, 1.55, 1.2, 3, '+x', { em, lit: 0.4 });
  mast(M, g, -2.2, 1.9, 0.9, { y0: ot, w: 0.14 });
  // level-luffing harbour crane on the +z pier (rotates)
  const cx = 1.5, cz = 2.0;
  for (const sx of [1, -1]) for (const sz of [1, -1]) g.beam([cx + sx * 0.3, qh, cz + sz * 0.3], [cx + sx * 0.12, qh + 0.9, cz + sz * 0.12], 0.06, { c: pal.steel });
  g.cylY(cx, qh + 0.9, qh + 1.0, cz, 0.2, { seg: 8, c: pal.gun });
  const C = M.part('crane', { at: [cx, qh + 1.0, cz] });
  C.at(cx, qh + 1.0, cz, () => {
    C.box(-0.05, 0.2, 0, 0.5, 0.36, 0.4, { c: pal.team, b: 0.03, tone: false });
    C.box(0.2, 0.26, 0, 0.012, 0.16, 0.3, { c: pal.glassD, b: 0, tone: false });
    for (const s of [1, -1]) C.beam([0.1, 0.36, s * 0.12], [1.5, 1.3, s * 0.04], 0.05, { c: pal.yellow });
    C.beam([-0.2, 0.9, 0], [1.5, 1.3, 0], 0.03, { c: pal.yellow });
    C.beam([-0.2, 0.38, 0], [-0.2, 0.9, 0], 0.05, { c: pal.yellow });
    C.box(-0.36, 0.2, 0, 0.16, 0.3, 0.36, { c: pal.concreteDk, b: 0.02 });
    C.cylY(1.5, 0.4, 1.3, 0, 0.008, { seg: 4, c: pal.black });
    C.box(1.5, 0.36, 0, 0.3, 0.2, 0.2, { c: pal.wood, b: 0.012 });
  }, 2.2);
  M.spin('crane', 'y', 0.2);
  M.light(cx, qh + 2.4, cz);
  // containers + bollards
  container(g, 0.6, qh, -2.1, 0.9, pal.team, 0);
  container(g, 1.6, qh, -2.1, 0.9, pal.orange, 0);
  container(g, 1.1, qh + 0.34, -2.1, 0.9, pal.steelLt, 0.03);
  for (let i = 0; i < 4; i++) for (const s of [1, -1]) g.cylY(-0.6 + i * 1.0, qh, qh + 0.1, s * (dw + 0.02) + s * 0.0, 0.05, { seg: 6, c: pal.gun });
  floodlight(M, g, em, 2.4, -1.5, 1.3, Math.PI * 0.6);
  M.door(2.7, 0, 0);
  return {};
}

// ---------------------------------------------------------------- SH-08 command / tech centre

function techCentre(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base'), glass = M.part('base', { mat: 'glass' }), em = M.part('base', { mat: 'emissive' });
  pad(g, half);
  // tiered hardened HQ
  g.tbox(-0.3, PADH + 0.5, -0.2, 3.9, 1.0, 3.5, 3.6, 3.2, { c: pal.wall, b: 0.03 });
  g.box(-0.3, PADH + 1.02, -0.2, 3.66, 0.06, 3.26, { c: pal.team, b: 0.014, tone: false });
  g.box(-0.3, PADH + 1.045, -0.2, 3.5, 0.03, 3.1, { c: pal.roof, b: 0 });
  const t2 = PADH + 1.05;
  g.tbox(-0.7, t2 + 0.4, -0.5, 2.4, 0.8, 2.1, 2.2, 1.9, { c: pal.wallLt, b: 0.03 });
  g.box(-0.7, t2 + 0.83, -0.5, 2.26, 0.06, 1.96, { c: pal.wallDk, b: 0.014 });
  // glazed operations room cantilevered toward +X
  const ox = 0.85, oy = t2 + 0.34;
  g.box(ox, oy - 0.2, -0.5, 0.8, 0.1, 1.5, { c: pal.wallDk, b: 0.014 });
  glass.tbox(ox, oy + 0.06, -0.5, 0.74, 0.42, 1.44, 0.9, 1.56, { c: pal.glassD, b: 0.01, ox: 0.08 });
  g.box(ox + 0.04, oy + 0.3, -0.5, 0.98, 0.07, 1.64, { c: pal.team, b: 0.014, tone: false });
  em.box(ox + 0.42, oy - 0.02, -0.5, 0.006, 0.05, 1.2, { c: [0.3, 0.9, 1.0], b: 0 });
  // lower windows + entrance with stairs
  windows(glass, -0.3 + 1.93, PADH + 0.56, 0.9, 1.0, 3, '+x', { em, lit: 0.5 });
  windows(glass, -0.3, PADH + 0.56, -0.2 + 1.73, 3.2, 8, '+z', { em, lit: 0.45 });
  door(g, -0.3 + 1.9, -1.3, 0.5, 0.6, '+x', { c: pal.gun });
  for (let i = 0; i < 3; i++) g.box(1.75 + i * 0.1, PADH + 0.1 - i * 0.03, -1.3, 0.12, 0.06, 0.7, { c: pal.concreteDk, b: 0 });
  M.door(2.2, 0, -1.3);
  // radome + antenna farm on the roof
  const rt = t2 + 0.86;
  radome(g, -1.3, rt + 0.5, -1.0, 0.62);
  mast(M, g, -0.1, 0.1, 1.9, { y0: rt, w: 0.26, w1: 0.08 });
  if (hi) { dish(g, -0.02, rt + 1.0, 0.1, 0.16, { c: pal.white }); g.at(-0.18, rt + 1.4, 0.1, () => dish(g, 0, 0, 0, 0.12, { c: pal.white }), Math.PI); }
  mast(M, g, -1.5, 0.3, 1.2, { y0: rt, w: 0.16 });
  // big rotating search radar on the lower roof corner
  const rx = -1.75, rz = 1.15;
  g.cylY(rx, t2, t2 + 0.5, rz, 0.12, { seg: 8, c: pal.steel, b: 0.014 });
  const R = M.part('radar', { at: [rx, t2 + 0.5, rz] });
  R.at(rx, t2 + 0.5, rz, () => {
    R.cylY(0, 0, 0.1, 0, 0.09, { seg: 8, c: pal.gun });
    R.box(0, 0.42, 0, 0.1, 0.6, 1.3, { c: pal.steelLt, b: 0.02, warp: (p, s0, s1, s2) => { if (s1 > 0) p[2] *= 0.8; } });
    R.box(0.056, 0.42, 0, 0.012, 0.5, 1.0, { c: mulC(pal.steel, 0.8), b: 0 });
    R.box(-0.12, 0.3, 0, 0.16, 0.3, 0.3, { c: pal.gun, b: 0.02 });
  });
  M.spin('radar', 'y', 1.1);
  // satellite dishes pointing skyward on the front terrace
  for (const [x, z, r] of [[1.2, 1.1, 0.34], [0.5, 1.2, 0.24]]) {
    g.cylY(x, t2, t2 + 0.22, z, 0.05, { seg: 6, c: pal.steel });
    g.at(x, t2 + 0.3, z, () => dish(g, 0, 0, 0, r, { c: pal.white }), -0.6, 0.9);
  }
  // generator + cooling units at ground level, flag
  for (let i = 0; i < 3; i++) g.box(1.3 + i * 0.42, PADH + 0.17, 2.2, 0.34, 0.34, 0.5, { c: pal.steelLt, b: 0.02 });
  g.box(-2.3, PADH + 0.25, 2.2, 0.5, 0.5, 0.6, { c: pal.missileG, b: 0.03 });
  flagPole(g, 2.3, PADH, -2.3, 1.7);
  floodlight(M, g, em, 2.35, 2.3, 1.2, Math.PI * 1.25);
  return {};
}

// ---------------------------------------------------------------- SH-09..11 base defences

function revetment(g, r, o = {}) {
  // ring of sandbags with a gap at the back (-x)
  const n = o.n ?? 10;
  const gap = o.gap ?? 1;
  for (let i = 0; i < n; i++) {
    if (i >= n / 2 - gap / 2 && i < n / 2 + gap / 2) continue;
    const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
    sandbagWall(g, [Math.cos(a0) * r, PADH, Math.sin(a0) * r], [Math.cos(a1) * r, PADH, Math.sin(a1) * r], o.rows ?? 3, { bagLen: 0.26, bagH: 0.1, bagW: 0.17 });
  }
}

function defPad(g, half) {
  const { pal } = g.ctx;
  pad(g, half, { c: mixC(pal.concrete, pal.sandbag, 0.3) });
}

function hmgBunker(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base');
  defPad(g, half);
  // low concrete pillbox with firing slits and an open gun pit on top
  g.tbox(0, PADH + 0.3, 0, 2.3, 0.6, 2.3, 1.9, 1.9, { c: pal.concrete, b: 0.04 });
  for (let i = 0; i < 4; i++) g.at(0, PADH + 0.38, 0, () => g.box(1.0, 0, 0, 0.06, 0.09, 0.7, { c: pal.black, b: 0, tone: false }), i * TAU / 4);
  g.cylY(0, PADH + 0.6, PADH + 0.66, 0, 0.62, { seg: M.ctx.seg(12), c: pal.concreteDk });
  revetment(g, 0.84, { n: 10, rows: 2, gap: 2 });
  // earth berm bags around the base
  for (const [a, b] of [[[1.55, 0, -1.4], [1.55, 0, 1.4]], [[-1.4, 0, 1.55], [1.4, 0, 1.55]], [[-1.4, 0, -1.55], [1.4, 0, -1.55]]]) sandbagWall(g, a, b, 2, { bagLen: 0.3, bagH: 0.11, bagW: 0.2 });
  g.box(-1.2, PADH + 0.3, 0, 0.08, 0.5, 0.5, { c: pal.gun, b: 0.01 }); // steel door
  g.box(0, PADH + 0.606, 0.0, 0.5, 0.012, 0.16, { c: pal.team, b: 0, tone: false, rot: [0.78, 0, 0] });
  flagPole(g, -1.45, PADH, -1.45, 1.3);
  crates(g, -1.3, 1.0, 3);
  M.light(-1.45, PADH + 1.36, -1.45);
  // turret: pintle-mounted twin HMG with gun shield
  const ty = PADH + 0.66;
  const T = M.part('turret', { at: [0, ty, 0] });
  M.turretNode = 'turret';
  T.cylY(0, ty, ty + 0.3, 0, 0.07, { seg: 8, c: pal.gun, b: 0.01 });
  T.box(0.02, ty + 0.36, 0, 0.3, 0.14, 0.34, { c: pal.gun, b: 0.02 });
  T.box(0.22, ty + 0.44, 0, 0.03, 0.42, 0.86, { c: pal.base, b: 0.012, rot: [0, 0.14, 0], warp: (p, s0, s1) => { if (s1 > 0) p[2] *= 0.74; } });
  T.box(0.245, ty + 0.5, 0, 0.012, 0.16, 0.5, { c: pal.team, b: 0, tone: false, rot: [0, 0.14, 0] });
  for (const s of [1, -1]) T.box(-0.02, ty + 0.36, s * 0.24, 0.2, 0.16, 0.12, { c: pal.missileG, b: 0.016 }); // ammo cans
  // gunner
  T.box(-0.3, ty + 0.3, 0, 0.16, 0.3, 0.26, { c: pal.uniform, b: 0.03 });
  T.sphere(-0.3, ty + 0.54, 0, 0.09, { seg: 8, c: pal.team, y0: -0.2 });
  const bx = 0.14, by = ty + 0.42;
  const B = M.part('barrel', { at: [bx, by, 0], parent: 'turret' });
  M.barrelNode = 'barrel';
  for (const s of [1, -1]) {
    B.box(bx, by, s * 0.085, 0.3, 0.08, 0.07, { c: pal.gun, b: 0.01 });
    const mx = thinBarrel(B, bx + 0.12, 0.6, by + 0.005, s * 0.085, 0.017, { seg: 6 });
    M.muzzle(mx, by, s * 0.085, 'barrel');
  }
  return {};
}

function atgmTower(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base');
  defPad(g, half);
  // concrete tower with a flared fighting platform
  const h = 1.9;
  g.tbox(0, PADH + 0.2, 0, 1.5, 0.4, 1.5, 1.1, 1.1, { c: pal.concreteDk, b: 0.03 });
  g.tbox(0, PADH + 0.4 + (h - 0.4) / 2, 0, 0.9, h - 0.4, 0.9, 0.7, 0.7, { c: pal.concrete, b: 0.03 });
  g.tbox(0, PADH + h + 0.1, 0, 0.72, 0.2, 0.72, 1.3, 1.3, { c: pal.concreteDk, b: 0.02 });
  const py = PADH + h + 0.2;
  for (let i = 0; i < 4; i++) g.at(0, py + 0.14, 0, () => g.box(0.63, 0, 0, 0.06, 0.28, 1.32, { c: pal.concrete, b: 0.012 }), i * TAU / 4);
  for (let i = 0; i < 4; i++) g.at(0, py + 0.29, 0, () => g.box(0.635, 0, 0, 0.075, 0.05, 1.0, { c: pal.team, b: 0, tone: false }), i * TAU / 4);
  // slit windows + ladder + door
  for (let i = 0; i < 4; i++) g.at(0, PADH + 1.25, 0, () => g.box(0.4, 0, 0, 0.03, 0.26, 0.1, { c: pal.black, b: 0, tone: false }), i * TAU / 4);
  g.box(-0.46, PADH + 0.34, 0, 0.03, 0.5, 0.3, { c: pal.gun, b: 0 });
  if (hi) { for (const s of [1, -1]) g.beam([0.1 + s * 0.09, PADH + 0.4, 0.47], [0.1 + s * 0.09, py, 0.4], 0.02, { c: pal.steel }); for (let i = 0; i < 8; i++) g.box(0.1, PADH + 0.5 + i * 0.19, 0.465 - i * 0.008, 0.18, 0.016, 0.016, { c: pal.steel, b: 0 }); }
  sandbagWall(g, [1.2, PADH, -1.3], [1.2, PADH, 1.3], 2, { bagLen: 0.3, bagH: 0.11, bagW: 0.2 });
  sandbagWall(g, [-0.8, PADH, 1.35], [1.1, PADH, 1.35], 2, { bagLen: 0.3, bagH: 0.11, bagW: 0.2 });
  crates(g, -1.3, -1.2, 4);
  mast(M, g, -1.35, 1.2, 1.6, { w: 0.16 });
  // launcher turret
  const T = M.part('turret', { at: [0, py, 0] });
  M.turretNode = 'turret';
  T.cylY(0, py, py + 0.24, 0, 0.09, { seg: 8, c: pal.gun, b: 0.01 });
  T.box(0, py + 0.34, 0, 0.3, 0.24, 0.3, { c: pal.base, b: 0.03 });
  T.box(0.16, py + 0.36, 0, 0.012, 0.12, 0.16, { c: pal.glassD, b: 0, tone: false }); // sight
  T.box(0, py + 0.47, 0, 0.2, 0.012, 0.2, { c: pal.team, b: 0, tone: false });
  const B = M.part('barrel', { at: [0, py + 0.36, 0], parent: 'turret' });
  M.barrelNode = 'barrel';
  for (const s of [1, -1]) {
    B.box(0, py + 0.36, s * 0.24, 0.3, 0.26, 0.05, { c: pal.gun, b: 0.01 });
    for (const k of [0, 1]) {
      canister(B, -0.36, 0.5, py + 0.29 + k * 0.15, s * 0.33, 0.065, { c: k ? pal.base : mulC(pal.base, 0.9), ribs: 2, front: pal.warhead });
      if (k === 1) M.muzzle(0.5, py + 0.36, s * 0.33, 'barrel');
    }
  }
  return {};
}

function aaGun(M, def, half) {
  const { pal, hi } = M.ctx;
  const g = M.part('base');
  defPad(g, half);
  // octagonal concrete emplacement
  const n = 8, R = 1.5;
  for (let i = 0; i < n; i++) {
    if (i === 4) continue;
    const a = (i / n) * TAU;
    g.at(Math.cos(a) * R, PADH, -Math.sin(a) * R, () => {
      g.tbox(0, 0.22, 0, 0.3, 0.44, 1.26, 0.14, 1.26, { c: pal.concrete, b: 0.02 });
      g.box(-0.02, 0.44, 0, 0.16, 0.03, 1.2, { c: pal.team, b: 0, tone: false });
    }, a);
  }
  g.cylY(0, PADH, PADH + 0.1, 0, 0.9, { seg: M.ctx.seg(12), c: pal.concreteDk });
  crates(g, -0.9, 0.7, 4);
  for (let i = 0; i < 3; i++) g.box(0.5 + i * 0.05, PADH + 0.1, -1.0 + i * 0.02, 0.5, 0.2, 0.26, { c: pal.missileG, b: 0.02, rot: [0.3 + i * 0.2, 0, 0] });
  // fire-control radar on a tripod (spins)
  const rx = -1.25, rz = -1.25;
  for (let i = 0; i < 3; i++) g.beam([rx + Math.cos(i * 2.09) * 0.25, PADH, rz + Math.sin(i * 2.09) * 0.25], [rx, PADH + 0.8, rz], 0.03, { c: pal.steel });
  const Rr = M.part('radar', { at: [rx, PADH + 0.8, rz] });
  Rr.cylY(rx, PADH + 0.78, PADH + 0.9, rz, 0.04, { seg: 6, c: pal.gun });
  dish(Rr, rx + 0.06, PADH + 1.06, rz, 0.22, { c: pal.steelLt });
  M.spin('radar', 'y', 2.4);
  M.light(-1.6, PADH + 0.5, 1.6);
  flagPole(g, -1.6, PADH, 1.6, 1.2);
  // twin 35 mm mount
  const ty = PADH + 0.1;
  const T = M.part('turret', { at: [0, ty, 0] });
  M.turretNode = 'turret';
  T.cylY(0, ty, ty + 0.16, 0, 0.5, { seg: M.ctx.seg(12), c: pal.gun, b: 0.02 });
  T.xloft([{ x: -0.5, y0: ty + 0.16, y1: ty + 0.72, w0: 0.3, w1: 0.24 }, { x: 0.2, y0: ty + 0.16, y1: ty + 0.72, w0: 0.3, w1: 0.24 }, { x: 0.4, y0: ty + 0.16, y1: ty + 0.5, w0: 0.26, w1: 0.2 }], { c: pal.base, camo: 2, ch: 0.02 });
  T.box(-0.14, ty + 0.726, 0, 0.4, 0.012, 0.3, { c: pal.team, b: 0, tone: false });
  for (const s of [1, -1]) T.box(-0.1, ty + 0.44, s * 0.42, 0.5, 0.4, 0.2, { c: mulC(pal.base, 0.85), b: 0.03 }); // ammo feed boxes
  T.box(-0.3, ty + 0.82, 0, 0.16, 0.16, 0.2, { c: pal.gun, b: 0.02 });
  const bx = 0.1, by = ty + 0.5;
  const B = M.part('barrel', { at: [bx, by, 0], parent: 'turret' });
  M.barrelNode = 'barrel';
  const el = 0.6;
  for (const s of [1, -1]) {
    B.at(bx, by, s * 0.42, () => {
      B.box(0.1, 0, 0, 0.5, 0.16, 0.14, { c: pal.gun, b: 0.02 });
      thinBarrel(B, 0.3, 1.15, 0, 0, 0.028, { seg: 7 });
      B.lathe('x', [[1.3, 0.03], [1.32, 0.05], [1.45, 0.045], [1.45, 0.02]], { seg: 7, c: pal.gun, cap0: false });
    }, 0, el);
    M.muzzle(bx + Math.cos(el) * 1.45, by + Math.sin(el) * 1.45, s * 0.42, 'barrel');
  }
  return {};
}

// ---------------------------------------------------------------- dispatch

const COMMON = {
  'SH-01': conyard, 'SH-02': powerPlant, 'SH-03': oilDepot, 'SH-04': barracks, 'SH-05': warFactory,
  'SH-06': airfield, 'SH-07': navalYard, 'SH-08': techCentre, 'SH-09': hmgBunker, 'SH-10': atgmTower, 'SH-11': aaGun,
};

function byName(def) {
  const n = def.name || '';
  if (/Construction Yard|MCV/i.test(n)) return conyard;
  if (/Power/i.test(n)) return powerPlant;
  if (/Oil|Refinery/i.test(n)) return oilDepot;
  if (/Barracks/i.test(n)) return barracks;
  if (/Factory/i.test(n)) return warFactory;
  if (/Airfield|Helipad/i.test(n)) return airfield;
  if (/Naval|Shipyard/i.test(n)) return navalYard;
  if (/Command|Tech/i.test(n)) return techCentre;
  if (/HMG|bunker|nest/i.test(n)) return hmgBunker;
  if (/ATGM/i.test(n)) return atgmTower;
  if (/AA gun/i.test(n)) return aaGun;
  return null;
}

export function buildStructure(M, def) {
  const half = halfOf(def);
  const fn = COMMON[def.id] || byName(def);
  if (fn) return fn(M, def, half);
  if (def.type === 'SW') return buildSuper(M, def, half);
  if (def.type === 'Def') return buildSAM(M, def, half);
  return buildUnique(M, def, half);
}
