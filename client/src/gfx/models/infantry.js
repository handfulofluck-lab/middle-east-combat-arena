// Infantry squads: 2–4 chunky figures, each = torso mesh (+head, arms, weapon, pack) and two
// leg meshes pivoting at the hip. Engineers also get separately swinging arms.

import { DEG, mixC, mulC, hashInt } from './geo.js';

const HIP = 0.215, SHOULDER = 0.375, HEAD = 0.43;

function leg(g, x, z, o) {
  const { pal } = g.ctx;
  // thigh + shin as one tapered block, boot at the bottom (pivot = hip at model (x, HIP, z))
  g.box(x, HIP * 0.56, z, 0.058, HIP * 0.92, 0.058, { c: o.trousers, camo: 1, b: 0.012, warp: (p, s0, s1) => { if (s1 < 0) { p[0] *= 0.8; p[2] *= 0.85; } } });
  g.box(x + 0.012, 0.022, z, 0.088, 0.044, 0.06, { c: pal.boot, camo: 0, b: 0.012, tone: false });
  if (o.kneePad) g.box(x + 0.028, HIP * 0.5, z, 0.014, 0.04, 0.05, { c: o.gear, camo: 0, b: 0 });
}

function limb(g, a, b, r, c) {
  g.pipe(a, b, r, { seg: 5, c, camo: 1 });
}

/**
 * One soldier. o: { x, z, role, uniform, gear, helmet, skin, weapon, ... }
 * Returns the muzzle position (model space) or null.
 */
function figure(M, i, o) {
  const { pal, hi } = M.ctx;
  const { x, z } = o;
  const name = 'fig' + i;
  const g = M.part(name, { at: [x, 0, z] });
  const T = (px, py, pz) => [x + px, py, z + pz];
  const uni = o.uniform, gear = o.gear;
  // pelvis + torso + vest
  g.box(x, HIP + 0.02, z, 0.085, 0.05, 0.13, { c: o.trousers, camo: 1, b: 0.012 });
  g.box(x + 0.004, 0.315, z, 0.092, 0.15, 0.15, { c: uni, camo: 1, b: 0.02, warp: (p, s0, s1) => { if (s1 > 0) p[2] *= 1.1; else p[2] *= 0.88; } });
  if (o.vest !== false) {
    g.box(x + 0.012, 0.318, z, 0.1, 0.12, 0.135, { c: gear, camo: 0, b: 0.016 });
    if (hi) for (const k of [-1, 0, 1]) g.box(x + 0.066, 0.285, z + k * 0.042, 0.022, 0.05, 0.034, { c: mulC(gear, 0.85), camo: 0, b: 0 }); // mag pouches
  }
  // shoulders: team-colour pads
  for (const s of [1, -1]) g.box(x, SHOULDER + 0.006, z + s * 0.082, 0.06, 0.03, 0.04, { c: s > 0 ? pal.team : gear, camo: 0, b: 0.008, tone: false });
  // backpack with team flap
  if (o.pack !== false) {
    const ph = o.pack === 'big' ? 0.15 : 0.11;
    g.box(x - 0.075, 0.3 + ph / 2 - 0.03, z, 0.06, ph, 0.12, { c: mulC(gear, 0.9), camo: 0, b: 0.016 });
    g.box(x - 0.075, 0.3 + ph - 0.027, z, 0.064, 0.014, 0.1, { c: pal.team, camo: 0, b: 0.004, tone: false });
    g.box(x - 0.108, 0.3 + ph / 2 - 0.02, z, 0.008, ph * 0.55, 0.08, { c: pal.team, camo: 0, b: 0, tone: false });
  }
  if (o.radio) g.beam(T(-0.08, 0.4, -0.04), T(-0.1, 0.62, -0.04), 0.005, { c: pal.black, tone: false, nb: true });
  // head
  g.sphere(x + 0.006, HEAD, z, 0.036, { seg: M.ctx.seg(8), c: o.skin, camo: 0, s: [1, 1.08, 0.95] });
  if (o.head === 'beret') {
    g.sphere(x + 0.0, HEAD + 0.03, z + 0.008, 0.042, { seg: M.ctx.seg(8), c: o.helmet, camo: 0, s: [1.05, 0.42, 1.15], tone: false });
  } else if (o.head === 'boonie') {
    g.cylY(x, HEAD + 0.018, HEAD + 0.026, z, 0.062, { seg: M.ctx.seg(8), c: o.helmet, camo: 0 });
    g.sphere(x, HEAD + 0.024, z, 0.038, { seg: M.ctx.seg(8), c: o.helmet, camo: 0, y0: 0, s: [1, 0.9, 1] });
  } else {
    g.sphere(x, HEAD + 0.012, z, 0.047, { seg: M.ctx.seg(8), c: o.helmet, camo: 0, y0: -0.12, s: [1.08, 0.92, 1.0], tone: false });
    if (o.band) g.cylY(x, HEAD + 0.004, HEAD + 0.018, z, 0.0495, { seg: M.ctx.seg(8), c: o.band, camo: 0, tone: false, cap0: false, cap1: false, k2: 1.08 });
    if (o.nvg && hi) g.box(x + 0.045, HEAD + 0.035, z, 0.025, 0.02, 0.035, { c: pal.black, camo: 0, b: 0, tone: false });
  }
  // legs
  const lo = { trousers: o.trousers, gear, kneePad: o.kneePad && hi };
  const gl = M.part(name + 'L', { at: [x, HIP, z + 0.036], parent: name });
  leg(gl, x, z + 0.036, lo);
  const gr = M.part(name + 'R', { at: [x, HIP, z - 0.036], parent: name });
  leg(gr, x, z - 0.036, lo);
  const fig = { node: name, legL: name + 'L', legR: name + 'R', armL: null, armR: null, phase: hashInt(M.ctx.seed + i * 53) * Math.PI * 2 };
  M.figures.push(fig);

  // arms + weapon
  const shL = T(0.0, SHOULDER - 0.01, 0.088), shR = T(0.0, SHOULDER - 0.01, -0.088);
  const w = o.weapon;
  let mz = null;
  const sleeve = uni, hand = o.glove || o.skin;
  if (w === 'tool') {
    // free-swinging arms (own nodes) — engineer
    for (const [tag, sh, s] of [['AL', shL, 1], ['AR', shR, -1]]) {
      const ga = M.part(name + tag, { at: sh, parent: name });
      limb(ga, sh, [sh[0] + 0.01, sh[1] - 0.085, sh[2] + s * 0.012], 0.021, sleeve);
      limb(ga, [sh[0] + 0.01, sh[1] - 0.085, sh[2] + s * 0.012], [sh[0] + 0.03, sh[1] - 0.16, sh[2] + s * 0.006], 0.018, sleeve);
      ga.sphere(sh[0] + 0.032, sh[1] - 0.17, sh[2] + s * 0.006, 0.02, { seg: 5, c: hand, camo: 0 });
      if (s < 0 && o.tool === 'box') {
        ga.box(sh[0] + 0.035, sh[1] - 0.225, sh[2] - 0.006, 0.13, 0.07, 0.055, { c: pal.red, camo: 0, b: 0.01, tone: false });
        ga.box(sh[0] + 0.035, sh[1] - 0.185, sh[2] - 0.006, 0.06, 0.012, 0.012, { c: pal.gun, camo: 0, b: 0 });
      } else if (s < 0 && o.tool === 'detector') {
        ga.beam([sh[0] + 0.03, sh[1] - 0.17, sh[2] - 0.006], [sh[0] + 0.2, sh[1] - 0.33, sh[2] - 0.006], 0.012, { c: pal.gun });
        ga.cylY(sh[0] + 0.21, sh[1] - 0.345, sh[1] - 0.33, sh[2] - 0.006, 0.05, { seg: 8, c: pal.yellow, camo: 0, tone: false });
      } else if (s > 0 && o.tool === 'box') {
        // wrench
        ga.beam([sh[0] + 0.032, sh[1] - 0.17, sh[2] + 0.006], [sh[0] + 0.09, sh[1] - 0.25, sh[2] + 0.006], 0.012, { c: pal.steelLt });
      }
      if (s > 0) fig.armL = name + 'AL'; else fig.armR = name + 'AR';
    }
    mz = T(0.12, 0.3, 0);
    return mz;
  }
  // both hands on the weapon
  const wy = w === 'launcher' || w === 'manpads' ? SHOULDER + 0.035 : 0.325;
  const gripR = w === 'launcher' || w === 'manpads' ? T(0.06, wy - 0.03, -0.075) : T(0.05, wy - 0.012, -0.03);
  const gripL = w === 'launcher' || w === 'manpads' ? T(0.14, wy - 0.035, -0.06) : T(0.15, wy - 0.005, 0.012);
  const elbR = [x - 0.02, SHOULDER - 0.085, z - 0.11], elbL = [x + 0.06, SHOULDER - 0.08, z + 0.09];
  limb(g, shR, elbR, 0.021, sleeve); limb(g, elbR, gripR, 0.018, sleeve);
  limb(g, shL, elbL, 0.021, sleeve); limb(g, elbL, gripL, 0.018, sleeve);
  if (hi) { g.sphere(gripR[0], gripR[1], gripR[2], 0.019, { seg: 5, c: hand, camo: 0 }); g.sphere(gripL[0], gripL[1], gripL[2], 0.019, { seg: 5, c: hand, camo: 0 }); }
  const gun = pal.gun;
  if (w === 'rifle' || w === 'carbine' || w === 'lmg' || w === 'sniper') {
    const len = w === 'lmg' ? 0.34 : w === 'sniper' ? 0.4 : w === 'carbine' ? 0.25 : 0.29;
    const wz = z - 0.012;
    g.at(x - 0.04, wy, wz, () => {
      g.box(0.07, 0, 0, 0.16, 0.034, 0.022, { c: gun, camo: 0, b: 0.005, tone: false }); // receiver
      g.box(-0.035, -0.008, 0, 0.07, 0.03, 0.018, { c: o.stock || gun, camo: 0, b: 0, tone: false }); // stock
      g.box(0.085, -0.034, 0, 0.022, 0.05, 0.016, { c: gun, camo: 0, b: 0, tone: false, rot: [0, 0.25, 0] }); // magazine
      g.cylX(0.14, len, 0.004, 0, 0.0075, { seg: 5, c: gun, camo: 0, tone: false });
      if (w === 'carbine') g.cylX(len - 0.07, len + 0.03, 0.004, 0, 0.013, { seg: 5, c: pal.black, camo: 0, tone: false }); // suppressor
      if (w === 'lmg') { g.box(0.07, -0.045, 0.0, 0.06, 0.05, 0.05, { c: mulC(pal.uniform, 0.6), camo: 0, b: 0 }); g.beam([len - 0.04, 0, 0], [len - 0.02, -0.07, 0.03], 0.006, { c: gun }); g.beam([len - 0.04, 0, 0], [len - 0.02, -0.07, -0.03], 0.006, { c: gun }); }
      if (w === 'sniper' || o.optic) g.cylX(0.03, 0.12, 0.03, 0, 0.011, { seg: 5, c: pal.black, camo: 0, tone: false });
    }, 0, o.aim ?? 0.06);
    const a = o.aim ?? 0.06;
    mz = [x - 0.04 + Math.cos(a) * (len + 0.01), wy + Math.sin(a) * (len + 0.01), wz];
  } else if (w === 'launcher' || w === 'manpads') {
    const mp = w === 'manpads';
    const len = mp ? 0.44 : (o.tubeLen || 0.36), r = mp ? 0.02 : (o.tubeR || 0.03);
    const a = mp ? 0.38 : 0.1;
    const wz = z - 0.085;
    g.at(x - 0.14, wy + 0.01, wz, () => {
      const tc = o.tubeC || mulC(pal.uniform, 0.62);
      g.lathe('x', [[0, r * 1.25], [0.03, r * 1.25], [0.03, r], [len - 0.03, r], [len - 0.03, r * 1.25], [len, r * 1.25], [len, r * 0.75], [len - 0.02, r * 0.75], [len - 0.02, 0]], { seg: M.ctx.seg(7), c: tc, camo: 0, crease: 40, cap1: false });
      g.box(0.22, -r - 0.022, 0, 0.05, 0.045, 0.024, { c: gun, camo: 0, b: 0, tone: false }); // grip
      if (mp) { g.box(0.3, -r - 0.02, 0, 0.04, 0.035, 0.03, { c: gun, camo: 0, b: 0 }); g.box(0.26, r + 0.02, 0.0, 0.07, 0.04, 0.012, { c: gun, camo: 0, b: 0 }); }
      else if (o.clu) g.box(0.2, 0.0, 0.05, 0.1, 0.07, 0.05, { c: mulC(pal.uniform, 0.5), camo: 0, b: 0.01 }); // command launch unit
      else g.box(0.2, r + 0.022, 0, 0.08, 0.035, 0.03, { c: gun, camo: 0, b: 0 }); // sight
    }, 0, a);
    mz = [x - 0.14 + Math.cos(a) * len, wy + 0.01 + Math.sin(a) * len, wz];
  }
  if (o.spare) {
    // spare missile tube strapped across the pack
    g.cylY(x - 0.115, 0.26, 0.56, z + 0.02, 0.028, { seg: M.ctx.seg(6), c: o.tubeC || mulC(pal.uniform, 0.62), camo: 0, b: 0.006 });
  }
  return mz;
}

const LAYOUT = {
  4: [[0.24, 0.13], [0.06, -0.24], [-0.16, 0.26], [-0.28, -0.08]],
  3: [[0.2, 0.0], [-0.14, 0.22], [-0.18, -0.2]],
  2: [[0.1, 0.16], [-0.1, -0.16]],
};

export function buildInfantry(M, def) {
  const { pal } = M.ctx;
  const cls = def.cls, n = def.name || '';
  const uniform = pal.uniform;
  const base = {
    uniform, trousers: mulC(uniform, 0.92), gear: mulC(mixC(uniform, pal.black, 0.45), 1.0),
    helmet: mixC(pal.team, uniform, 0.12), skin: pal.skin, kneePad: true,
  };
  let figs;
  if (cls === 'Engineer') {
    const e = { ...base, helmet: pal.yellow, band: pal.team, gear: mixC(pal.orange, pal.yellow, 0.3), weapon: 'tool', kneePad: false };
    figs = [{ ...e, tool: 'box' }, { ...e, tool: 'detector', pack: 'big' }];
  } else if (cls === 'SF') {
    const dark = mulC(mixC(uniform, pal.black, 0.5), 0.9);
    const s = { ...base, uniform: mulC(mixC(uniform, pal.black, 0.3), 0.95), trousers: mulC(mixC(uniform, pal.black, 0.25), 0.95), gear: dark, head: 'beret', helmet: pal.team, weapon: 'carbine', optic: true, glove: pal.black, pack: 'small' };
    const pair = /pair/i.test(n);
    figs = pair
      ? [{ ...s }, { ...s, weapon: 'sniper', head: 'boonie', helmet: mulC(uniform, 0.8) }]
      : [{ ...s, radio: true }, { ...s, head: 'helmet', helmet: mixC(pal.team, pal.black, 0.25), nvg: true }, { ...s, weapon: 'sniper', head: 'boonie', helmet: mulC(uniform, 0.8) }];
  } else if (cls === 'AT infantry') {
    const jav = /Javelin|Spike/i.test(n), tow = /TOW|Kornet|Baktar|Toophan|Nag/i.test(n);
    const t = { tubeLen: jav ? 0.34 : 0.4, tubeR: jav ? 0.034 : tow ? 0.03 : 0.026, clu: jav, tubeC: /Kornet|Toophan/i.test(n) ? mulC(pal.uniform, 0.55) : mixC(pal.uniform, pal.black, 0.5) };
    figs = [{ ...base, weapon: 'launcher', ...t, pack: false }, { ...base, weapon: 'rifle', spare: true, pack: 'big', ...t }, { ...base, weapon: 'rifle', radio: true }];
  } else if (cls === 'AA infantry') {
    figs = [{ ...base, weapon: 'manpads', pack: false, tubeC: mulC(pal.uniform, 0.5) }, { ...base, weapon: 'rifle', spare: true, pack: 'big', tubeC: mulC(pal.uniform, 0.5) }, { ...base, weapon: 'rifle', radio: true }];
  } else {
    const elite = /Guard|Tzanhanim|Golani|SANG/i.test(n);
    const b = { ...base, nvg: elite, optic: elite };
    figs = [{ ...b, weapon: 'rifle', radio: true }, { ...b, weapon: 'lmg' }, { ...b, weapon: 'rifle' }, { ...b, weapon: 'rifle', pack: 'big' }];
  }
  const lay = LAYOUT[figs.length];
  figs.forEach((f, i) => {
    const mz = figure(M, i, { ...f, x: lay[i][0], z: lay[i][1] });
    if (mz) M.muzzle(mz[0], mz[1], mz[2], 'fig' + i);
  });
  return { kind: 'infantry', radius: 0.46, height: 0.52 };
}
