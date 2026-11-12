// Palettes + per-build shading context (camo, baked AO, tone jitter).

import { hex, mixC, mulC, noise3, smooth, lerp, lum } from './geo.js';

// Ground-forces camouflage: base / secondary / dark, plus pattern parameters.
//  f  = blotch frequency (per render unit), t1/t2 = noise thresholds for secondary / dark
//  (higher threshold = less coverage), soft = edge softness.
const GROUND = {
  Egypt: { base: 0xc2a36a, sec: 0x9c7a48, dark: 0x6f5a3c, f: 2.3, t1: 0.56, t2: 0.7, soft: 0.035 },
  Saudi: { base: 0xd2bd90, sec: 0xb19a68, dark: 0x94805a, f: 2.0, t1: 0.58, t2: 0.78, soft: 0.05 },
  UAE: { base: 0xc6bca4, sec: 0xa9a089, dark: 0x8d8573, f: 2.6, t1: 0.57, t2: 0.74, soft: 0.03 },
  Algeria: { base: 0x6d7248, sec: 0x8c7b5b, dark: 0x3e4330, f: 2.2, t1: 0.54, t2: 0.68, soft: 0.03 },
  Turkey: { base: 0x5c6a42, sec: 0x62492f, dark: 0x23291f, f: 2.1, t1: 0.55, t2: 0.66, soft: 0.025 },
  Israel: { base: 0x87826c, sec: 0x7a7561, dark: 0x66624f, f: 1.8, t1: 0.6, t2: 0.8, soft: 0.08 },
  India: { base: 0x57613b, sec: 0x7d6645, dark: 0x343b26, f: 2.0, t1: 0.52, t2: 0.7, soft: 0.03 },
  Pakistan: { base: 0x5f7545, sec: 0xb29a69, dark: 0x384630, f: 2.2, t1: 0.57, t2: 0.72, soft: 0.03 },
  Iran: { base: 0xa9956a, sec: 0x7a5d3e, dark: 0x574430, f: 2.4, t1: 0.55, t2: 0.72, soft: 0.03 },
};

// Aircraft: air-superiority greys with faction tint; a few signature desert schemes.
const AIR = {
  Egypt: { base: 0x8f959a, sec: 0x6e767d, dark: 0x596168, f: 1.5, t1: 0.52, t2: 0.9, soft: 0.05 },
  Saudi: { base: 0x9ca2a6, sec: 0x838a8f, dark: 0x6d747a, f: 1.3, t1: 0.56, t2: 0.9, soft: 0.06 },
  UAE: { base: 0x8d9398, sec: 0x71787e, dark: 0x5c6369, f: 1.4, t1: 0.5, t2: 0.9, soft: 0.05 },
  Algeria: { base: 0x7f8c98, sec: 0x5d6b7a, dark: 0x4b5764, f: 1.6, t1: 0.5, t2: 0.9, soft: 0.04 },
  Turkey: { base: 0x868d92, sec: 0x6b7278, dark: 0x565d63, f: 1.4, t1: 0.54, t2: 0.9, soft: 0.05 },
  Israel: { base: 0xb39c72, sec: 0x86684a, dark: 0x717a5a, f: 1.5, t1: 0.52, t2: 0.62, soft: 0.03 },
  India: { base: 0x8a96a2, sec: 0x67737f, dark: 0x525d68, f: 1.6, t1: 0.5, t2: 0.9, soft: 0.04 },
  Pakistan: { base: 0x8b9196, sec: 0x6f767b, dark: 0x5a6166, f: 1.4, t1: 0.54, t2: 0.9, soft: 0.05 },
  Iran: { base: 0xb09d7a, sec: 0x7f6a50, dark: 0x6f7f8a, f: 1.5, t1: 0.52, t2: 0.66, soft: 0.03 },
};

const FALLBACK = 'Egypt';

/** Shared, faction-independent colours (sRGB hex, converted once to linear). */
const C = {
  black: hex(0x141516), gun: hex(0x2c2f33), steel: hex(0x5a6066), steelLt: hex(0x8a9096),
  tyre: hex(0x1d1d1f), track: hex(0x2a2725), trackLt: hex(0x3d3935), rubber: hex(0x26262a),
  wood: hex(0x7b5a36), canvas: hex(0x7c7556), sandbag: hex(0xa7966e), sandbagDk: hex(0x8d7c58),
  glassD: hex(0x121c24), lamp: hex(0xfff0c2), red: hex(0xb1241c), white: hex(0xe6e3da),
  yellow: hex(0xd8a416), orange: hex(0xd66a1a), green: hex(0x2f7a3a), blue: hex(0x2b5fa8),
  concrete: hex(0xb3aa98), concreteDk: hex(0x8d8676), concreteLt: hex(0xc9c1b0), asphalt: hex(0x3b3c3e),
  rust: hex(0x7a4a2c), skin: hex(0xb8875f), skinDk: hex(0x8a5f3f), boot: hex(0x1f1b17),
  roof: hex(0x6f757b), roofDk: hex(0x4f555b), wallMetal: hex(0x9aa0a3), hazK: hex(0x1b1b1c),
  navy: hex(0x8a939a), navyDk: hex(0x687178), deck: hex(0x464b50), hullRed: hex(0x6b2a24),
  missileW: hex(0xd8d6cf), missileG: hex(0x6d7a5a), warhead: hex(0xb5361f), brass: hex(0xa8873a),
  flame: hex(0xff8a2a), cyan: hex(0x55d8ff),
};

/**
 * kind: 'ground' | 'air' | 'helo' | 'drone' | 'naval' | 'inf' | 'struct'
 */
export function makeCtx({ kind, faction, teamColor, quality, seed }) {
  const hi = quality !== 'low';
  const gp = GROUND[faction] || GROUND[FALLBACK];
  const ap = AIR[faction] || AIR[FALLBACK];
  let src = gp, contrast = 1;
  if (kind === 'air') src = ap;
  let base = hex(src.base), sec = hex(src.sec), dark = hex(src.dark);
  if (kind === 'helo') {
    // army aviation: ground scheme, slightly greyer and darker
    const g = lum(base);
    base = mulC(mixC(base, [g, g, g], 0.18), 0.86);
    sec = mulC(mixC(sec, [g, g, g], 0.1), 0.88);
    dark = mulC(dark, 0.95);
  } else if (kind === 'drone') {
    const lg = hex(0xb4b9bd);
    base = mixC(lg, hex(gp.base), 0.22);
    sec = mulC(base, 0.86); dark = mulC(base, 0.7); contrast = 0.0;
  } else if (kind === 'naval') {
    base = C.navy; sec = C.navyDk; dark = C.deck; contrast = 0.0;
  } else if (kind === 'struct') {
    contrast = 0.0;
  }
  const team = hex(teamColor);
  const tl = lum(team);
  const pal = {
    ...C,
    base, sec, dark,
    baseDk: mulC(base, 0.72), baseLt: mixC(base, C.white, 0.22),
    under: mulC(mixC(base, C.black, 0.55), 0.9), // running gear / chassis shadow tone
    belly: mixC(base, hex(0xb8bec3), 0.6), // aircraft underside
    team, teamDk: mulC(team, 0.62), teamLt: mixC(team, C.white, 0.4),
    teamInk: tl > 0.35 ? C.black : C.white, // contrasting marking colour on team panels
    // structures
    wall: mixC(hex(0xc4b99f), hex(gp.base), 0.22),
    wallDk: mulC(mixC(hex(0xc4b99f), hex(gp.base), 0.22), 0.78),
    wallLt: mixC(mixC(hex(0xc4b99f), hex(gp.base), 0.22), C.white, 0.25),
    uniform: hex(gp.base), uniformDk: mulC(hex(gp.base), 0.7), uniformSec: hex(gp.sec),
  };
  const r1 = [sec[0] / base[0], sec[1] / base[1], sec[2] / base[2]];
  const r2 = [dark[0] / base[0], dark[1] / base[1], dark[2] / base[2]];
  const f = src.f, t1 = src.t1, t2 = src.t2, soft = src.soft;
  const s1 = seed | 0, s2 = (seed + 977) | 0;
  const camoOn = contrast > 0;
  const air = kind === 'air' || kind === 'helo' || kind === 'drone';
  const ctx = {
    kind, faction, quality, hi, seed: seed | 0, pal, camoOn,
    toneAmt: kind === 'struct' ? 0.045 : 0.04,
    seg: (n) => (hi ? n : Math.max(5, Math.round(n * 0.6))),
    camoMax: 0.8, camoMin: 0.25,
    /** Scalar signature of the camo pattern (drives adaptive tessellation). */
    camoW(x, y, z) {
      const n1 = noise3(x * f + 3.7, y * f * 1.5 + 1.3, z * f + 9.1, s1) * 0.7 + noise3(x * f * 2.6, y * f * 2.6, z * f * 2.6, s1 + 5) * 0.3;
      const n2 = noise3(x * f * 1.25 + 21.4, y * f * 1.6 + 7.7, z * f * 1.25 + 2.2, s2) * 0.7 + noise3(x * f * 3.1, y * f * 3.1, z * f * 3.1, s2 + 5) * 0.3;
      return smooth(t1 - soft, t1 + soft, n1) + 2 * smooth(t2 - soft, t2 + soft, n2);
    },
    camoAt(c, x, y, z, hard) {
      const n1 = noise3(x * f + 3.7, y * f * 1.5 + 1.3, z * f + 9.1, s1) * 0.7 + noise3(x * f * 2.6, y * f * 2.6, z * f * 2.6, s1 + 5) * 0.3;
      const n2 = noise3(x * f * 1.25 + 21.4, y * f * 1.6 + 7.7, z * f * 1.25 + 2.2, s2) * 0.7 + noise3(x * f * 3.1, y * f * 3.1, z * f * 3.1, s2 + 5) * 0.3;
      const sf = hard ? 0.004 : soft;
      const w1 = smooth(t1 - sf, t1 + sf, n1), w2 = smooth(t2 - sf, t2 + sf, n2);
      let r = lerp(1, r1[0], w1), g = lerp(1, r1[1], w1), b = lerp(1, r1[2], w1);
      r = lerp(r, r2[0], w2); g = lerp(g, r2[1], w2); b = lerp(b, r2[2], w2);
      return [c[0] * r, c[1] * g, c[2] * b];
    },
    aoAt: air
      ? (y, ny) => (ny < -0.35 ? 0.88 : ny > 0.6 ? 1.04 : 1)
      : kind === 'naval'
        ? (y, ny) => (y < 0.0 ? 0.8 : 1) * (ny < -0.4 ? 0.75 : ny > 0.6 ? 1.04 : 1)
        : kind === 'struct'
          ? (y, ny) => (0.8 + 0.2 * smooth(0, 0.55, y)) * (ny < -0.4 ? 0.72 : ny > 0.6 ? 1.05 : 1)
          : (y, ny) => (0.74 + 0.26 * smooth(0.02, 0.36, y)) * (ny < -0.4 ? 0.7 : ny > 0.6 ? 1.06 : 1),
  };
  return ctx;
}

export const COMMON = C;
