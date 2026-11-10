// Turns the sim's coarse terrain grid (0 land / 1 rock / 2 water per cell)
// into a smooth, good-looking heightfield. The sim never sees this: units
// simply ride on it. Signed distance fields give organic shorelines and
// mountain outlines instead of cell-aligned blocks.
import {
  S, CELL, WATER_Y, clamp, lerp, smoothstep, fbm, ridged, vnoise,
  signedField, boxBlur, sampleField,
} from './util.js';

export const APRON = 26;   // cells of non-playable terrain around the map
export const HR = 2;       // heightfield samples per cell

export function buildHeightfield(map, look) {
  const mw = map.w, mh = map.h;
  const W = mw + APRON * 2, H = mh + APRON * 2;
  const biome = look.biome;
  const n = W * H;

  // class grid with clamped lookup (the apron extends the edge classes)
  const isRock = new Uint8Array(n);
  const isWater = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    const cy = clamp(y - APRON, 0, mh - 1);
    for (let x = 0; x < W; x++) {
      const cx = clamp(x - APRON, 0, mw - 1);
      const t = map.terrain[cy * mw + cx];
      const i = y * W + x;
      // the far apron keeps water (open sea) but drops the straight streaks
      // of extended rock: distant relief comes from noise instead
      const out = Math.max(APRON - x, x - (W - 1 - APRON), APRON - y, y - (H - 1 - APRON), 0);
      isWater[i] = t === 2 ? 1 : 0;
      isRock[i] = (t === 1 && out < 5) ? 1 : 0;
    }
  }
  const sdRock = boxBlur(signedField(isRock, W, H), W, H, 1);
  const sdWater = boxBlur(signedField(isWater, W, H), W, H, 2);

  const GW = W * HR + 1, GH = H * HR + 1;
  const heights = new Float32Array(GW * GH);
  const splat = new Uint8Array(GW * GH * 4); // rock, wet, veg, ao
  const style = biome.rockStyle;
  const dAmp = biome.duneAmp, dScale = biome.duneScale;
  const halfW = W * S / 2, halfH = H * S / 2;

  for (let j = 0; j < GH; j++) {
    const py = j / HR;
    const z = py * S - halfH;
    for (let i = 0; i < GW; i++) {
      const px = i / HR;
      const x = px * S - halfW;
      const sw = sampleField(sdWater, W, H, px, py);
      const sr = sampleField(sdRock, W, H, px, py);
      const out = Math.max(APRON - px, px - (W - APRON), APRON - py, py - (H - APRON), 0);

      // shoreline profile: gentle beach up, shelving seabed down
      let h;
      if (sw <= 0) h = 0.46 * (1 - Math.exp(sw * 0.85));
      else h = -2.6 * (1 - Math.exp(-sw * 0.42)) - 0.04;

      // dunes: wind-aligned ridges with a gentle windward face and a steep
      // slip face, broken up by a regional mask so some areas stay flat
      const inland = smoothstep(0.6, 5.0, -sw);
      if (inland > 0) {
        const region = smoothstep(0.34, 0.62, fbm(x * 0.0052 + 3.1, z * 0.0052 - 1.7, 3, 21));
        const warp = fbm(x * 0.011 + 11.3, z * 0.011 - 4.1, 3, 5) * 2.6;
        const wl = 46 / dScale;
        const u1 = (x * 0.83 + z * 0.56) / wl + warp;
        const ph = u1 - Math.floor(u1);
        const prof = ph < 0.76 ? Math.pow(ph / 0.76, 1.25) : 1 - smoothstep(0, 1, (ph - 0.76) / 0.24);
        const amp = 0.45 + 0.9 * fbm(x * 0.017 - 8.0, z * 0.017 + 2.0, 2, 33);
        const small = fbm(x * 0.07, z * 0.11, 3, 9);
        const roll = fbm(x * 0.009 + 40.0, z * 0.009 + 17.0, 3, 15);   // broad rolling ground
        h += inland * (dAmp * (prof * amp * 2.4 * (0.25 + 0.75 * region) + small * 0.3) + (roll - 0.42) * 1.6 * (0.4 + 0.6 * dAmp));
        if (h < 0.12) h = 0.12 + (h - 0.12) * 0.15;                    // never dip to sea level inland
      }

      // rock massifs
      let rockW = 0;
      if (sr > -2.4) {
        const lowN = fbm(x * 0.012 + 3.3, z * 0.012 - 7.7, 3, 41);
        const det = fbm(x * 0.11, z * 0.11, 4, 43);
        let hr = 0;
        if (style === 'mesa') {
          const cliff = 2.1 + 2.0 * lowN;
          hr = cliff * smoothstep(-0.5, 0.5, sr);
          hr += (1.3 + lowN) * smoothstep(1.7, 2.7, sr);          // second tier
          hr += 0.9 * smoothstep(3.6, 4.8, sr);                    // summit cap
          hr += (det - 0.5) * 0.5 * smoothstep(-0.6, 0.6, sr);
        } else if (style === 'mountain') {
          const rg = ridged(x * 0.03, z * 0.03, 4, 47);
          hr = 1.4 * smoothstep(-0.9, 0.5, sr);
          hr += Math.pow(Math.max(0, sr + 0.4), 0.9) * 1.25 * (0.5 + 1.1 * rg);
          hr += (det - 0.5) * 0.7 * smoothstep(-0.8, 0.8, sr);
          hr += (ridged(x * 0.085 + 9.1, z * 0.085 - 3.3, 3, 49) - 0.35) * 1.5 * smoothstep(0.2, 2.2, sr);
          hr = Math.min(hr, 13);
        } else {
          hr = 1.5 * smoothstep(-0.7, 0.8, sr);
          hr += Math.min(3.6, Math.max(0, sr) * 0.75) * (0.45 + 1.0 * det);
          hr += (det - 0.5) * 0.4 * smoothstep(-0.8, 0.6, sr);
          hr += (ridged(x * 0.1 + 2.7, z * 0.1 + 6.1, 3, 51) - 0.35) * 0.9 * smoothstep(0.2, 1.8, sr);
        }
        hr += 0.22 * smoothstep(-2.4, -0.4, sr) * (0.4 + det); // scree apron
        h += hr;
        rockW = smoothstep(-0.55, 0.25, sr);
      }

      // distant relief so the horizon is never a flat line
      if (out > 0 && sw < 0) {
        const far = smoothstep(4, APRON - 2, out);
        const rg = ridged(x * 0.011 + 5.0, z * 0.011 - 3.0, 4, 61);
        const fh = far * (rg * 11 + fbm(x * 0.03, z * 0.03, 3, 63) * 2.5) * smoothstep(-1, -6, sw);
        h += fh;
        rockW = Math.max(rockW, smoothstep(2.5, 6.5, fh));
      }

      const k = j * GW + i;
      heights[k] = h;

      const wet = sw > 0 ? 1 : 1 - smoothstep(0, 1.5, -sw);
      const nearWater = 1 - smoothstep(1.0, 9.0, -sw);
      const vn = fbm(x * 0.02 + 91.7, z * 0.02 + 13.1, 3, 77);
      let veg = biome.veg * (0.35 + 1.6 * nearWater * (biome.veg > 0.2 ? 1 : 0.4))
        + (vn - 0.5) * 0.9 * Math.min(1, biome.veg * 3);
      veg *= smoothstep(0.3, 1.4, -sw) * (1 - rockW);
      splat[k * 4] = Math.round(clamp(rockW, 0, 1) * 255);
      splat[k * 4 + 1] = Math.round(clamp(wet, 0, 1) * 255);
      splat[k * 4 + 2] = Math.round(clamp(veg, 0, 1) * 255);
      splat[k * 4 + 3] = 255;
    }
  }

  // cheap baked occlusion from local concavity (valleys/cliff feet darker)
  for (let j = 2; j < GH - 2; j++) {
    for (let i = 2; i < GW - 2; i++) {
      const k = j * GW + i;
      const hc = heights[k];
      const avg = (heights[k - 2] + heights[k + 2] + heights[k - 2 * GW] + heights[k + 2 * GW]
        + heights[k - 2 - 2 * GW] + heights[k + 2 - 2 * GW]
        + heights[k - 2 + 2 * GW] + heights[k + 2 + 2 * GW]) / 8;
      const occ = clamp((avg - hc) * 0.55, 0, 0.55);
      splat[k * 4 + 3] = Math.round((1 - occ) * 255);
    }
  }

  const step = S / HR;
  const hf = {
    map, W, H, GW, GH, heights, splat, sdRock, sdWater,
    halfW, halfH, step,
    mapHalfX: mw * S / 2, mapHalfZ: mh * S / 2,
    // render-space height (bilinear)
    heightAt(x, z) {
      let gx = (x + halfW) / step, gz = (z + halfH) / step;
      if (gx < 0) gx = 0; else if (gx > GW - 1.001) gx = GW - 1.001;
      if (gz < 0) gz = 0; else if (gz > GH - 1.001) gz = GH - 1.001;
      const x0 = gx | 0, z0 = gz | 0;
      const fx = gx - x0, fz = gz - z0;
      const k = z0 * GW + x0;
      const a = heights[k], b = heights[k + 1], c = heights[k + GW], d = heights[k + GW + 1];
      return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
    },
    // sim world units -> ground height (never below the water surface)
    groundAtWu(wx, wy) {
      const x = (wx / CELL - mw / 2) * S, z = (wy / CELL - mh / 2) * S;
      return Math.max(WATER_Y, hf.heightAt(x, z));
    },
    normalAt(x, z, out) {
      const e = step;
      const hx = hf.heightAt(x + e, z) - hf.heightAt(x - e, z);
      const hz = hf.heightAt(x, z + e) - hf.heightAt(x, z - e);
      const nx = -hx, ny = 2 * e, nz = -hz;
      const l = Math.hypot(nx, ny, nz) || 1;
      out.x = nx / l; out.y = ny / l; out.z = nz / l;
      return out;
    },
    // signed distances in cells at a render position
    waterDist(x, z) { return sampleField(sdWater, W, H, (x + halfW) / S, (z + halfH) / S); },
    rockDist(x, z) { return sampleField(sdRock, W, H, (x + halfW) / S, (z + halfH) / S); },
    inMap(x, z) { return Math.abs(x) <= hf.mapHalfX && Math.abs(z) <= hf.mapHalfZ; },
  };
  return hf;
}

export { lerp, vnoise };
