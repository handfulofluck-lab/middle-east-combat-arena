// Fixed-wing combat aircraft: fighters and strike jets, parametric by airframe family.

import { DEG, TAU, mixC, mulC, lerp } from './geo.js';
import { missile } from './parts.js';

// ---------------------------------------------------------------- shared aero helpers

/** Superellipse fuselage loft. st: [{ x, y, w, h, e, hb }] (w/h are half extents, hb = belly flatten). */
export function fuselage(g, st, o = {}) {
  const seg = o.seg ?? g.ctx.seg(12);
  const rings = st.map((s) => {
    const ring = [];
    const e = 2 / (s.e || 2);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU + Math.PI / seg;
      const c = Math.cos(a), sn = Math.sin(a);
      const z = (s.z || 0) + s.w * Math.sign(c) * Math.pow(Math.abs(c), e);
      const y = s.y + s.h * Math.sign(sn) * Math.pow(Math.abs(sn), e) * (sn < 0 ? (s.hb ?? 1) : (s.ht ?? 1));
      ring.push([s.x, y, z]);
    }
    return ring;
  });
  return g.loft(rings, { crease: 64, ...o });
}

/**
 * Lifting surface on the +z side (call inside g.mirror for both).
 * o: x (root leading edge), z0 (root z), y, chord, tip, span, sweep (deg), t, dih (rad, + = tips up),
 *    teamTip (fraction of span painted team colour), c, tipDx (extra trailing-edge shift at tip)
 */
export function wing(g, o) {
  const { pal } = g.ctx;
  const dx = Math.tan(o.sweep * DEG) * o.span;
  const t = o.t ?? 0.03;
  const LE = (u) => [o.x - dx * u, o.span * u];
  const TE = (u) => [lerp(o.x - o.chord, o.x - dx - o.tip + (o.tipDx || 0), u), o.span * u];
  const cut = o.teamTip ? 1 - o.teamTip : 1;
  g.at(0, o.y, o.z0, () => {
    g.prismY([LE(0), LE(cut), TE(cut), TE(0)], -t / 2, t / 2, { c: o.c, camo: o.camo ?? 2, b: t * 0.42 });
    if (cut < 1) g.prismY([LE(cut), LE(1), TE(1), TE(cut)], -t / 2, t / 2, { c: pal.team, camo: 0, b: t * 0.42, tone: false });
    if (o.flap && g.ctx.hi) {
      // control-surface strip along the trailing edge
      const f = (u) => { const a = LE(u), b = TE(u); return [lerp(b[0], a[0], 0.22), b[1]]; };
      g.prismY([f(0.08), f(cut * 0.94), TE(cut * 0.94), TE(0.08)], t / 2 - 0.002, t / 2 + 0.004, { c: mulC(o.c || pal.base, 0.82), camo: 0, b: 0 });
    }
  }, 0, 0, -(o.dih || 0));
}

/** Vertical fin; cant (rad) leans the tip outward (+z). o: x (root LE), y, z, h, chord, tip, sweep, t */
export function fin(g, o) {
  const { pal } = g.ctx;
  const dx = Math.tan(o.sweep * DEG) * o.h;
  const t = o.t ?? 0.028;
  const LE = (u) => [o.x - dx * u, o.h * u];
  const TE = (u) => [lerp(o.x - o.chord, o.x - dx - o.tip + (o.tipDx || 0), u), o.h * u];
  const cut = o.team === false ? 1 : 0.66;
  g.at(0, o.y, o.z || 0, () => {
    g.prismZ([LE(0), LE(cut), TE(cut), TE(0)], -t / 2, t / 2, { c: o.c, camo: 2, b: t * 0.42 });
    if (cut < 1) g.prismZ([LE(cut), LE(1), TE(1), TE(cut)], -t / 2, t / 2, { c: pal.team, camo: 0, b: t * 0.42, tone: false });
  }, 0, 0, o.cant || 0);
}

/** Jet nozzle at the tail (axis -X), with a glowing core in the emissive sink E. */
export function nozzle(M, g, E, x, y, z, r, o = {}) {
  const { pal } = g.ctx;
  const len = o.len ?? r * 1.5;
  const metal = mulC(pal.gun, 1.1), dark = mulC(pal.black, 0.9);
  g.lathe('x', [[x - len, r * 0.8], [x - len * 0.5, r * 0.95], [x, r * 1.02], [x + 0.02, r * 1.04]], { at: [0, y, z], seg: g.ctx.seg(10), colors: [metal, metal, mulC(metal, 1.3), mulC(metal, 1.3)], crease: 50, camo: 0, cap0: false, cap1: false });
  // dark inner cone (faces rearward / inward)
  g.lathe('x', [[x - len, r * 0.76], [x - len * 0.35, r * 0.6], [x - len * 0.35, 0]], { at: [0, y, z], seg: g.ctx.seg(10), c: dark, crease: 50, camo: 0, cap0: false, cap1: false, flip: true, tone: false, ao: false });
  if (E) E.lathe('x', [[x - len * 0.42, r * 0.5], [x - len * 0.4, 0]], { at: [0, y, z], seg: g.ctx.seg(8), colors: [pal.flame, [1.6, 1.2, 0.75]], cap0: false, cap1: false, flip: true });
  const s = o.scale || 1;
  M.exhaust((x - len) * s, y * s, z * s);
}

// ---------------------------------------------------------------- airframe families

export function jetFamily(def) {
  const n = def.name || '';
  const strike = def.cls === 'Strike jet';
  if (/F-35|Kaan|J-20|J-31/i.test(n)) return 'f35';
  if (/F-15/i.test(n)) return 'f15';
  if (/Su-34/i.test(n)) return 'su34';
  if (/Su-3\d|Su-27|J-11/i.test(n)) return 'su30';
  if (/Su-24|Tornado/i.test(n)) return /Tornado/i.test(n) ? 'tornado' : 'su24';
  if (/MiG-29/i.test(n)) return strike ? 'su24' : 'mig29';
  if (/Rafale/i.test(n)) return 'rafale';
  if (/Typhoon|Eurofighter/i.test(n)) return 'typhoon';
  if (/Mirage 2000/i.test(n)) return 'mirage';
  if (/Mirage/i.test(n)) return 'mirage3';
  if (/Tejas/i.test(n)) return 'tejas';
  if (/J-10/i.test(n)) return 'j10';
  if (/JF-17/i.test(n)) return 'jf17';
  if (/F-4/i.test(n)) return 'f4';
  if (/Jaguar/i.test(n)) return 'jaguar';
  if (/Kowsar|Saeqeh|F-5|F-14/i.test(n)) return 'f5';
  if (/F-16/i.test(n)) return 'f16';
  return strike ? 'jaguar' : 'f16';
}

// Each family: s (overall scale), eng (1|2), sep (engine half-spacing), bw/bh (body half width/height),
// intake, wing, lerx, canard, tail (tailplane), fin, seats, nose
const JETS = {
  f16: { s: 0.95, eng: 1, bw: 0.13, bh: 0.14, intake: 'chin', wing: { x: 0.2, chord: 0.72, tip: 0.2, span: 0.6, sweep: 40, y: 0 }, lerx: 0.5, tail: { x: -0.72, chord: 0.4, tip: 0.14, span: 0.36, sweep: 40, dih: -0.14 }, fin: { n: 1, x: -0.5, h: 0.5, chord: 0.56, tip: 0.18, sweep: 46 }, ventral: true, tipMsl: true },
  jf17: { s: 0.9, eng: 1, bw: 0.125, bh: 0.135, intake: 'side', wing: { x: 0.14, chord: 0.62, tip: 0.2, span: 0.56, sweep: 42, y: 0 }, lerx: 0.42, tail: { x: -0.74, chord: 0.36, tip: 0.14, span: 0.34, sweep: 42 }, fin: { n: 1, x: -0.52, h: 0.48, chord: 0.52, tip: 0.2, sweep: 46 }, ventral: true, tipMsl: true },
  rafale: { s: 0.98, eng: 2, sep: 0.075, bw: 0.15, bh: 0.14, intake: 'side', wing: { x: 0.3, chord: 1.02, tip: 0.1, span: 0.66, sweep: 48, y: -0.01 }, canard: { x: 0.52, chord: 0.3, tip: 0.06, span: 0.3, sweep: 50, y: 0.06 }, fin: { n: 1, x: -0.42, h: 0.56, chord: 0.66, tip: 0.16, sweep: 50 }, tipMsl: true },
  typhoon: { s: 1.0, eng: 2, sep: 0.08, bw: 0.15, bh: 0.145, intake: 'chinbox', wing: { x: 0.28, chord: 1.08, tip: 0.1, span: 0.7, sweep: 53, y: -0.03 }, canard: { x: 0.86, chord: 0.24, tip: 0.05, span: 0.26, sweep: 52, y: 0.02, dih: -0.2 }, fin: { n: 1, x: -0.4, h: 0.62, chord: 0.7, tip: 0.18, sweep: 52 }, tipPods: true },
  mirage: { s: 0.92, eng: 1, bw: 0.125, bh: 0.135, intake: 'cone', wing: { x: 0.42, chord: 1.2, tip: 0.06, span: 0.62, sweep: 58, y: -0.05 }, fin: { n: 1, x: -0.42, h: 0.56, chord: 0.72, tip: 0.14, sweep: 54 } },
  mirage3: { s: 0.9, eng: 1, bw: 0.115, bh: 0.125, intake: 'cone', wing: { x: 0.34, chord: 1.16, tip: 0.05, span: 0.58, sweep: 60, y: -0.06 }, fin: { n: 1, x: -0.46, h: 0.52, chord: 0.74, tip: 0.12, sweep: 58 }, nose: 1.12 },
  tejas: { s: 0.82, eng: 1, bw: 0.13, bh: 0.14, intake: 'side', wing: { x: 0.36, chord: 1.08, tip: 0.08, span: 0.6, sweep: 55, y: 0.02 }, fin: { n: 1, x: -0.44, h: 0.54, chord: 0.68, tip: 0.16, sweep: 50 }, tipMsl: false },
  j10: { s: 0.98, eng: 1, bw: 0.13, bh: 0.145, intake: 'chinbox', wing: { x: 0.2, chord: 0.98, tip: 0.1, span: 0.66, sweep: 52, y: -0.04 }, canard: { x: 0.6, chord: 0.3, tip: 0.07, span: 0.3, sweep: 50, y: 0.07, dih: 0.1 }, fin: { n: 1, x: -0.44, h: 0.6, chord: 0.66, tip: 0.2, sweep: 50 }, ventral: true },
  mig29: { s: 1.0, eng: 2, sep: 0.15, wide: true, bw: 0.1, bh: 0.115, intake: 'under2', wing: { x: 0.14, chord: 0.72, tip: 0.2, span: 0.6, sweep: 42, y: 0 }, lerx: 0.62, tail: { x: -0.72, chord: 0.42, tip: 0.16, span: 0.38, sweep: 45 }, fin: { n: 2, z: 0.21, cant: 0.1, x: -0.52, h: 0.5, chord: 0.5, tip: 0.2, sweep: 44 } },
  su30: { s: 1.12, eng: 2, sep: 0.17, wide: true, bw: 0.1, bh: 0.12, intake: 'under2', wing: { x: 0.2, chord: 0.8, tip: 0.2, span: 0.72, sweep: 42, y: 0 }, lerx: 0.66, canard: { x: 0.46, chord: 0.2, tip: 0.06, span: 0.2, sweep: 48, y: 0.01, z0: 0.14 }, tail: { x: -0.76, chord: 0.44, tip: 0.16, span: 0.4, sweep: 45 }, fin: { n: 2, z: 0.25, cant: 0.0, x: -0.56, h: 0.6, chord: 0.5, tip: 0.2, sweep: 40 }, stinger: true, seats: 2, tipMsl: true },
  su34: { s: 1.16, eng: 2, sep: 0.17, wide: true, bw: 0.17, bh: 0.12, intake: 'under2', wing: { x: 0.2, chord: 0.8, tip: 0.2, span: 0.72, sweep: 42, y: 0 }, lerx: 0.66, canard: { x: 0.48, chord: 0.2, tip: 0.06, span: 0.2, sweep: 48, y: 0.01, z0: 0.16 }, tail: { x: -0.76, chord: 0.44, tip: 0.16, span: 0.4, sweep: 45 }, fin: { n: 2, z: 0.25, cant: 0.0, x: -0.56, h: 0.56, chord: 0.5, tip: 0.2, sweep: 40 }, stinger: 1.25, seats: 'side', platypus: true, tipMsl: true },
  f15: { s: 1.1, eng: 2, sep: 0.105, bw: 0.19, bh: 0.14, boxy: true, intake: 'sidebox', wing: { x: 0.26, chord: 0.86, tip: 0.24, span: 0.66, sweep: 45, y: 0.07 }, tail: { x: -0.7, chord: 0.46, tip: 0.2, span: 0.4, sweep: 48 }, fin: { n: 2, z: 0.19, cant: 0.0, x: -0.5, h: 0.56, chord: 0.5, tip: 0.2, sweep: 38 }, cft: true },
  f35: { s: 0.95, eng: 1, bw: 0.2, bh: 0.15, boxy: true, intake: 'side', wing: { x: 0.14, chord: 0.8, tip: 0.2, span: 0.58, sweep: 34, y: 0.0, tipDx: 0.12 }, tail: { x: -0.66, chord: 0.5, tip: 0.2, span: 0.42, sweep: 34, tipDx: 0.1 }, fin: { n: 2, z: 0.18, cant: 0.38, x: -0.48, h: 0.46, chord: 0.52, tip: 0.2, sweep: 40 }, stealth: true, internal: true },
  f5: { s: 0.86, eng: 2, sep: 0.06, bw: 0.105, bh: 0.115, intake: 'side', wing: { x: 0.02, chord: 0.52, tip: 0.18, span: 0.46, sweep: 28, y: -0.05 }, lerx: 0.3, tail: { x: -0.82, chord: 0.3, tip: 0.12, span: 0.3, sweep: 30 }, fin: { n: 2, z: 0.07, cant: 0.3, x: -0.6, h: 0.44, chord: 0.44, tip: 0.16, sweep: 36 }, tipMsl: true, nose: 1.1 },
  tornado: { s: 1.0, eng: 2, sep: 0.085, bw: 0.17, bh: 0.15, boxy: true, intake: 'sidebox', wing: { x: 0.22, chord: 0.46, tip: 0.18, span: 0.66, sweep: 44, y: 0.09 }, glove: true, tail: { x: -0.62, chord: 0.54, tip: 0.16, span: 0.44, sweep: 48 }, fin: { n: 1, x: -0.36, h: 0.7, chord: 0.78, tip: 0.24, sweep: 50 }, seats: 2 },
  su24: { s: 1.1, eng: 2, sep: 0.09, bw: 0.19, bh: 0.145, boxy: true, intake: 'sidebox', wing: { x: 0.2, chord: 0.44, tip: 0.16, span: 0.66, sweep: 46, y: 0.09 }, glove: true, tail: { x: -0.66, chord: 0.5, tip: 0.16, span: 0.42, sweep: 50 }, fin: { n: 1, x: -0.4, h: 0.62, chord: 0.74, tip: 0.24, sweep: 52 }, seats: 'side', ventral: true },
  f4: { s: 1.05, eng: 2, sep: 0.08, bw: 0.16, bh: 0.15, intake: 'sidebox', wing: { x: 0.18, chord: 0.84, tip: 0.2, span: 0.6, sweep: 46, y: -0.07 }, tipUp: true, tail: { x: -0.82, chord: 0.36, tip: 0.12, span: 0.34, sweep: 40, dih: -0.4, y: 0.1 }, fin: { n: 1, x: -0.56, h: 0.44, chord: 0.7, tip: 0.18, sweep: 58 }, seats: 2, nose: 1.08 },
  jaguar: { s: 0.94, eng: 2, sep: 0.07, bw: 0.135, bh: 0.14, boxy: true, intake: 'sidebox', wing: { x: 0.06, chord: 0.52, tip: 0.18, span: 0.5, sweep: 40, y: 0.1, dih: -0.06 }, tail: { x: -0.82, chord: 0.34, tip: 0.12, span: 0.32, sweep: 40, dih: -0.18 }, fin: { n: 1, x: -0.6, h: 0.5, chord: 0.56, tip: 0.2, sweep: 44 }, nose: 1.12, overwing: true },
};

export function buildJet(M, def) {
  const { pal, hi } = M.ctx;
  const fam = jetFamily(def);
  const S = JETS[fam];
  const k = S.s;
  const name = def.name || '';
  const g = M.part('hull').camo(1);
  const glass = M.part('hull', { mat: 'glass' });
  const E = M.part('hull', { mat: 'emissive' });
  const strike = def.cls === 'Strike jet';
  const CY = 0.27; // centreline
  g.push().scale(k, k, k);
  glass.push().scale(k, k, k);
  E.push().scale(k, k, k);
  const bw = S.bw, bh = S.bh;
  const sep = S.sep || 0;
  const nl = S.nose || 1;
  const noseX = 1.2 * nl;
  const radC = S.stealth ? mulC(pal.base, 0.9) : mixC(mulC(pal.base, 0.62), pal.gun, 0.3);

  // ---- fuselage
  const e = S.boxy ? 3.4 : 2.3;
  const aftW = S.eng === 2 ? (S.wide ? bw * 0.9 : sep + 0.105) : bw * 0.82;
  const tailX = S.wide ? -0.5 : -0.96;
  const st = [];
  if (S.platypus) {
    st.push({ x: noseX - 0.34, y: CY - 0.01, w: 0.085, h: 0.05, e: 2.6 });
    st.push({ x: 0.72, y: CY + 0.005, w: bw * 0.86, h: bh * 0.8, e: 2.8 });
  } else {
    st.push({ x: noseX - 0.3, y: CY - 0.012, w: bw * 0.52, h: bh * 0.52, e: 2 });
    st.push({ x: 0.74, y: CY, w: bw * 0.74, h: bh * 0.8, e: 2.2 });
  }
  st.push({ x: 0.5, y: CY + 0.01, w: bw * 0.92, h: bh * 0.98, e });
  st.push({ x: 0.2, y: CY + 0.01, w: bw, h: bh, e });
  if (S.wide) {
    st.push({ x: -0.1, y: CY + 0.01, w: bw, h: bh * 0.92, e });
    st.push({ x: tailX, y: CY + 0.0, w: bw * 0.7, h: bh * 0.6, e });
    st.push({ x: tailX - 0.3, y: CY - 0.01, w: bw * 0.3, h: bh * 0.3, e: 2 });
  } else {
    st.push({ x: -0.3, y: CY + 0.005, w: Math.max(bw, aftW), h: bh * 0.98, e: S.eng === 2 ? 3.4 : e });
    st.push({ x: -0.7, y: CY, w: aftW, h: bh * 0.86, e: S.eng === 2 ? 3.4 : 2.2 });
    st.push({ x: tailX, y: CY, w: aftW * 0.9, h: bh * 0.72, e: S.eng === 2 ? 3.4 : 2 });
  }
  fuselage(g, st, { camo: 2, cap0: false });
  // interpolated fuselage section at x
  const fat = (x) => {
    for (let i = 0; i < st.length - 1; i++) {
      const a = st[i], b = st[i + 1];
      if (x <= a.x && x >= b.x) { const u = (a.x - x) / (a.x - b.x); return { x, y: lerp(a.y, b.y, u), w: lerp(a.w, b.w, u), h: lerp(a.h, b.h, u), e: lerp(a.e || 2, b.e || 2, u) }; }
    }
    return { ...st[st.length - 1], x };
  };
  // radome
  if (S.platypus) {
    fuselage(g, [{ x: noseX, y: CY - 0.02, w: 0.004, h: 0.003 }, { x: noseX - 0.12, y: CY - 0.015, w: 0.05, h: 0.028, e: 2.4 }, { x: noseX - 0.34, y: CY - 0.01, w: 0.085, h: 0.05, e: 2.6 }], { c: radC, camo: 0, cap0: false, cap1: false });
  } else {
    fuselage(g, [{ x: noseX, y: CY - 0.02, w: 0.003, h: 0.003 }, { x: noseX - 0.1, y: CY - 0.017, w: bw * 0.24, h: bh * 0.24 }, { x: noseX - 0.3, y: CY - 0.012, w: bw * 0.52, h: bh * 0.52 }], { c: radC, camo: 0, cap0: false, cap1: false });
    if (hi) g.cylX(noseX - 0.01, noseX + 0.08, CY - 0.02, 0, 0.005, { seg: 4, c: pal.black, camo: 0, tone: false }); // pitot
  }
  // dorsal spine
  if (!S.wide) {
    fuselage(g, [{ x: 0.2, y: CY + bh * 0.82, w: 0.05, h: 0.045 }, { x: -0.3, y: CY + bh * 0.84, w: 0.055, h: 0.05 }, { x: -0.72, y: CY + bh * 0.72, w: 0.035, h: 0.03 }], { camo: 2, seg: 8, tess: 0 });
  }
  if (/F-16I|Sufa/i.test(name)) fuselage(g, [{ x: 0.34, y: CY + bh * 0.98, w: 0.05, h: 0.05 }, { x: -0.2, y: CY + bh * 1.02, w: 0.06, h: 0.055 }, { x: -0.56, y: CY + bh * 0.9, w: 0.035, h: 0.03 }], { camo: 2, seg: 8, tess: 0 });
  if (S.cft || /F-16I|Sufa|Block 60|F-16E|Blk70/i.test(name)) {
    // conformal fuel tanks hugging the upper fuselage sides
    g.mirror(() => fuselage(g, [{ x: 0.3, y: CY + bh * 0.42, z: bw * 0.86, w: 0.035, h: 0.045 }, { x: 0.0, y: CY + bh * 0.46, z: bw * 0.96, w: 0.06, h: 0.07 }, { x: -0.4, y: CY + bh * 0.42, z: bw * 0.9, w: 0.035, h: 0.05 }], { camo: 2, seg: 8, tess: 0 }));
  }

  // ---- engines
  const nozR = S.eng === 2 ? (S.wide ? 0.088 : 0.082) : 0.105;
  const nozX = S.wide ? -1.02 : -0.96;
  const engY = S.wide ? CY - 0.045 : CY - 0.005;
  if (S.wide) {
    // separate nacelles under a blended centre body
    g.mirror(() => {
      fuselage(g, [
        { x: 0.3, y: CY - 0.085, z: sep, w: 0.085, h: 0.07, e: 3.2 },
        { x: 0.0, y: CY - 0.06, z: sep, w: 0.092, h: 0.092, e: 3 },
        { x: -0.6, y: CY - 0.045, z: sep, w: 0.092, h: 0.095, e: 2.2 },
        { x: nozX, y: engY, z: sep, w: nozR * 0.98, h: nozR * 0.98 },
      ], { camo: 1, cap1: false, seg: g.ctx.seg(10) });
      // raked intake lip (dark mouth)
      g.box(0.305, CY - 0.085, sep, 0.012, 0.12, 0.15, { c: pal.black, camo: 0, b: 0, tone: false, rot: [0, -0.3, 0] });
    });
    // flat centre body between the nacelles
    g.prismY([[0.62, 0.0], [0.3, sep + 0.1], [-0.84, sep + 0.1], [-0.84, -(sep + 0.1)], [0.3, -(sep + 0.1)]], CY - 0.01, CY + 0.045, { camo: 2, b: 0.016 });
    const sl = typeof S.stinger === 'number' ? S.stinger : 1;
    if (S.stinger) g.lathe('x', [[-0.84, 0.05], [-1.0 - 0.14 * sl, 0.035], [-1.06 - 0.16 * sl, 0.012]], { at: [0, CY + 0.02, 0], seg: 8, camo: 1, crease: 60, cap0: false });
  }
  const engZ = S.eng === 2 ? [sep, -sep] : [0];
  for (const z of engZ) nozzle(M, g, E, nozX, engY, z, nozR, { scale: k });

  // ---- intakes
  const IN = S.intake;
  if (IN === 'chin') {
    fuselage(g, [{ x: 0.52, y: CY - bh * 1.02, w: 0.085, h: 0.05, e: 2.6 }, { x: 0.2, y: CY - bh * 0.98, w: 0.1, h: 0.06, e: 2.6 }, { x: -0.3, y: CY - bh * 0.7, w: 0.08, h: 0.04, e: 2.4 }], { camo: 2, seg: 8, tess: 0, cap0: false });
    fuselage(g, [{ x: 0.522, y: CY - bh * 1.02, w: 0.07, h: 0.038, e: 2.6 }, { x: 0.5, y: CY - bh * 1.02, w: 0.06, h: 0.03, e: 2.6 }], { c: pal.black, camo: 0, seg: 8, tone: false, cap0: true, cap1: false });
  } else if (IN === 'chinbox') {
    g.box(0.3, CY - bh * 1.0, 0, 0.56, 0.11, bw * 1.5, { camo: 2, b: 0.02, warp: (p, s0, s1) => { if (s0 < 0) { p[1] += 0.03 * (s1 < 0 ? 1 : 0); p[2] *= 0.8; } } });
    g.box(0.585, CY - bh * 1.0, 0, 0.012, 0.075, bw * 1.25, { c: pal.black, camo: 0, b: 0, tone: false });
  } else if (IN === 'side' || IN === 'sidebox' || IN === 'cone') {
    const box = IN === 'sidebox';
    const ix = S.stealth ? 0.46 : box ? 0.5 : 0.42;
    const iw = box ? 0.075 : 0.055, ih = box ? 0.1 : 0.075;
    g.mirror(() => {
      const z = bw * (box ? 0.95 : 0.9) + iw * 0.7;
      fuselage(g, [
        { x: ix, y: CY - 0.015, z, w: iw, h: ih, e: box ? 4 : 2.6 },
        { x: ix - 0.4, y: CY - 0.01, z: z - 0.01, w: iw * 1.05, h: ih * 1.05, e: box ? 4 : 2.6 },
        { x: ix - 1.0, y: CY, z: Math.max(aftW * 0.7, z - 0.07), w: iw * 0.6, h: ih * 0.8, e: 2.4 },
      ], { camo: 2, seg: 8, tess: 0, cap0: false });
      fuselage(g, [{ x: ix + 0.004, y: CY - 0.015, z, w: iw * 0.86, h: ih * 0.86, e: box ? 4 : 2.6 }, { x: ix - 0.03, y: CY - 0.015, z, w: iw * 0.7, h: ih * 0.7, e: box ? 4 : 2.6 }], { c: pal.black, camo: 0, seg: 8, tone: false, cap0: true, cap1: false });
      if (IN === 'cone') g.lathe('x', [[ix + 0.09, 0.002], [ix - 0.02, iw * 0.55]], { at: [0, CY - 0.015, z - iw * 0.5], seg: 6, c: mulC(pal.base, 0.9), camo: 0, cap1: false });
    });
  }

  // ---- canopy
  const seats = S.seats || (/F-15I|F-15SA|F-16I|Sufa|Su-30/i.test(name) ? 2 : 1);
  const side = seats === 'side';
  const cl = side ? 0.34 : seats === 2 ? 0.62 : 0.42;
  const cx = side ? 0.64 : seats === 2 ? 0.42 : 0.5;
  const cw = side ? bw * 0.72 : Math.min(0.085, bw * 0.62), chh = side ? 0.075 : 0.105;
  const tint = S.stealth || /F-16/i.test(name) ? [0.16, 0.11, 0.035] : [0.035, 0.05, 0.065];
  glass.sphere(cx, CY + bh * 0.8, 0, 1, { seg: M.ctx.seg(10), rings: 4, y0: 0.02, s: [cl / 2, chh, cw], c: tint });
  // frame bow + sill
  if (hi) {
    g.box(cx + cl * 0.2, CY + bh * 0.8 + chh * 0.62, 0, 0.014, chh * 0.85, cw * 1.66, { c: mulC(pal.base, 0.75), camo: 0, b: 0, warp: (p, s0, s1) => { if (s1 > 0) p[2] *= 0.56; } });
    if (seats === 2) g.box(cx - cl * 0.08, CY + bh * 0.8 + chh * 0.66, 0, 0.014, chh * 0.82, cw * 1.7, { c: mulC(pal.base, 0.75), camo: 0, b: 0, warp: (p, s0, s1) => { if (s1 > 0) p[2] *= 0.56; } });
  }

  // ---- wings
  const W = S.wing;
  const wy = CY + W.y;
  const wz0 = S.wide ? sep + 0.085 : Math.max(bw, IN === 'sidebox' ? bw + 0.1 : bw) * 0.92;
  const wopt = { ...W, y: wy, z0: wz0, t: 0.032, teamTip: 0.2, flap: true };
  g.mirror(() => {
    if (S.tipUp) {
      // F-4: outer panels cranked up
      wing(g, { ...wopt, span: W.span * 0.62, tip: lerp(W.chord, W.tip, 0.62) * 0.92, teamTip: 0, sweep: W.sweep });
      const dx = Math.tan(W.sweep * DEG) * W.span * 0.62;
      wing(g, { x: W.x - dx, y: wy, z0: wz0 + W.span * 0.62, chord: lerp(W.chord, W.tip, 0.62) * 0.92 * 1.0 + dx * 0 + 0.0, tip: W.tip, span: W.span * 0.38, sweep: W.sweep, t: 0.03, dih: 0.22, teamTip: 0.5 });
    } else wing(g, wopt);
    if (S.lerx) g.prismY([[W.x + S.lerx, bw * 0.55 - wz0 + wz0], [W.x - 0.02, wz0 + 0.14], [W.x - 0.3, wz0 + 0.02], [W.x - 0.3, bw * 0.5]], wy - 0.014, wy + 0.014, { camo: 2, b: 0.01 });
    if (S.glove) g.prismY([[W.x + 0.34, wz0 - 0.03], [W.x - 0.02, wz0 + 0.17], [W.x - 0.5, wz0 + 0.12], [W.x - 0.5, wz0 - 0.03]], wy - 0.022, wy + 0.022, { camo: 2, b: 0.014 });
    if (S.canard) { const C = S.canard; wing(g, { ...C, y: CY + C.y, z0: C.z0 ?? bw * 0.8, t: 0.022, teamTip: 0.34 }); }
    if (S.tail) { const T = S.tail; wing(g, { ...T, y: CY + (T.y || 0) - (S.wide ? 0.02 : 0), z0: S.wide ? sep + 0.07 : aftW * 0.92, t: 0.026, teamTip: 0.26 }); }
    const F = S.fin;
    if (F.n === 2) fin(g, { ...F, y: CY + (S.wide ? 0.03 : bh * 0.6), z: F.z, cant: F.cant });
    if (S.ventral) fin(g, { x: -0.6, y: CY - bh * 0.6, z: S.wide ? sep : Math.max(0.05, aftW * 0.6), h: -0.16, chord: 0.3, tip: 0.16, sweep: -30, cant: -0.3, team: false, t: 0.02 });
  });
  if (S.fin.n === 1) fin(g, { ...S.fin, y: CY + bh * 0.72, z: 0 });
  if (S.fin.n === 1 && hi) g.box(S.fin.x - S.fin.chord * 0.5, CY + bh * 0.84, 0, S.fin.chord * 0.9, 0.05, 0.05, { camo: 1, b: 0.016 }); // fin root fairing

  // ---- stores
  const mslC = pal.missileW;
  const tipX = W.x - Math.tan(W.sweep * DEG) * W.span;
  const railY = wy - 0.045;
  const stations = S.internal ? [] : [0.42, 0.7];
  let nm = 0;
  for (const s of [1, -1]) {
    if (S.tipMsl) {
      const z = s * (wz0 + W.span + 0.012), x0 = tipX - W.tip - 0.04;
      missile(g, x0, wy, z, { len: 0.44, r: 0.014, c: mslC, tip: pal.gun, fins: 4, finAt: [0.0, 0.62], finLen: 0.06, finH: 0.03, seg: 5 });
      M.muzzle((x0 + 0.44) * k, wy * k, z * k); nm++;
    }
    if (S.tipPods) g.lathe('x', [[tipX - W.tip - 0.06, 0.006], [tipX - W.tip + 0.02, 0.022], [tipX + 0.04, 0.022], [tipX + 0.1, 0.004]], { at: [0, wy, s * (wz0 + W.span + 0.01)], seg: 6, c: mulC(pal.base, 0.8), camo: 0 });
    stations.forEach((u, i) => {
      const z = s * (wz0 + W.span * u);
      const xl = W.x - Math.tan(W.sweep * DEG) * W.span * u;
      const ch = lerp(W.chord, W.tip, u);
      const px = xl - ch * 0.45;
      g.box(px, railY + 0.012, z, 0.22, 0.04, 0.014, { c: mulC(pal.base, 0.8), camo: 0, b: 0 }); // pylon
      if (S.overwing && i === 1) {
        missile(g, px - 0.14, wy + 0.05, z, { len: 0.4, r: 0.014, c: mslC, tip: pal.gun, fins: 4, finAt: [0, 0.6], finLen: 0.06, finH: 0.03, seg: 5 });
        g.box(px, wy + 0.03, z, 0.14, 0.03, 0.012, { c: mulC(pal.base, 0.8), camo: 0, b: 0 });
        M.muzzle((px + 0.26) * k, (wy + 0.05) * k, z * k); nm++;
      } else if (strike && i === 0) {
        // bombs / guided munitions inboard
        missile(g, px - 0.2, railY - 0.035, z, { len: 0.46, r: 0.034, c: pal.missileG, tip: pal.missileG, band: pal.yellow, fins: 4, finAt: [0.0], finLen: 0.09, finH: 0.035, nose: 'round', seg: 6 });
        M.muzzle((px + 0.2) * k, (railY - 0.035) * k, z * k); nm++;
      } else if (i === 0 && !strike) {
        // BVR missile
        missile(g, px - 0.24, railY - 0.03, z, { len: 0.56, r: 0.018, c: mslC, tip: mslC, band: pal.gun, fins: 4, finAt: [0.0, 0.45], finLen: 0.07, finH: 0.032, seg: 5 });
        M.muzzle((px + 0.32) * k, (railY - 0.03) * k, z * k); nm++;
      } else {
        missile(g, px - 0.18, railY - 0.025, z, { len: 0.42, r: 0.014, c: mslC, tip: pal.gun, fins: 4, finAt: [0, 0.62], finLen: 0.06, finH: 0.03, seg: 5 });
        if (!S.tipMsl) { M.muzzle((px + 0.24) * k, (railY - 0.025) * k, z * k); nm++; }
      }
    });
  }
  if (!nm) { // internal bays: fire from under the fuselage
    for (const s of [1, -1]) M.muzzle(0.3 * k, (CY - bh) * k, s * bw * 0.7 * k);
  }
  // centreline tank / targeting pod
  if (!S.internal && !S.wide) {
    const ty = CY - bh - (IN === 'chin' || IN === 'chinbox' ? 0.1 : 0.05);
    g.lathe('x', [[0.34, 0.004], [0.2, 0.045], [-0.2, 0.05], [-0.42, 0.006]], { at: [0, ty, 0], seg: 8, c: mulC(pal.base, 0.9), camo: 1, crease: 70 });
  }
  // fuselage ID band behind the cockpit
  if (!S.wide) {
    const fa = fat(0.12), fb = fat(0.03);
    fuselage(g, [{ ...fa, w: fa.w * 1.015 + 0.002, h: fa.h * 1.015 + 0.002 }, { ...fb, w: fb.w * 1.015 + 0.002, h: fb.h * 1.015 + 0.002 }], { c: pal.team, camo: 0, cap0: false, cap1: false, tone: false, crease: 64 });
  } else g.box(-0.3, CY + 0.05, 0, 0.12, 0.012, (sep + 0.08) * 2, { c: pal.team, camo: 0, b: 0.003, tone: false });
  g.pop(); glass.pop(); E.pop();
  return { kind: 'jet', radius: 1.0 * k, height: (CY + bh + 0.5) * k * 0.8 };
}
