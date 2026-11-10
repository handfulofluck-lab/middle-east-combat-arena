#!/usr/bin/env node
// Preview renderer: one stylised PNG per map (<= 512 px) into
// tools/mapgen/previews/. Pure Node — PNG encoding lives in lib/png.mjs.
//
//   node tools/mapgen/preview.mjs                 every map in the manifest
//   node tools/mapgen/preview.mjs --only a,b      just these ids
//   node tools/mapgen/preview.mjs --maps DIR --out DIR   (scratch iteration)
//
// Look: fake hillshade from the rock distance field (rock rises toward the
// interior of a massif, so ranges get ridgelines and mesas get flat tops),
// dune shading on land, depth-shaded water with a foam line, oil markers and
// numbered spawn discs. Palette follows the map's `theme` when present.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeIndexedPng } from './lib/png.mjs';
import { distanceTo, LAND, ROCK, WATER } from './lib/grid.mjs';
import { makeFbm } from './lib/noise.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAPS_DIR = path.resolve(HERE, '../../client/maps');
const OUT_DIR = path.join(HERE, 'previews');
const MAX_PX = 512;

// [shadow, lit] colour pairs per biome
const BIOMES = {
  dunes:    { land: [[188, 146, 92], [247, 221, 164]], rock: [[70, 46, 34], [222, 172, 118]], wet: [[205, 176, 124], [250, 236, 196]] },
  coast:    { land: [[176, 152, 104], [240, 224, 176]], rock: [[62, 56, 52], [200, 184, 160]], wet: [[214, 198, 150], [252, 244, 212]] },
  highland: { land: [[140, 128, 92], [214, 200, 150]], rock: [[52, 50, 54], [206, 200, 196]], wet: [[170, 160, 120], [228, 220, 180]] },
  oasis:    { land: [[178, 150, 96], [240, 218, 160]], rock: [[74, 54, 40], [214, 176, 128]], wet: [[110, 142, 76], [176, 204, 116]] },
  steppe:   { land: [[136, 132, 84], [208, 204, 140]], rock: [[66, 60, 52], [196, 184, 160]], wet: [[120, 140, 84], [190, 206, 136]] },
  saltflat: { land: [[196, 190, 176], [250, 246, 236]], rock: [[84, 70, 62], [214, 190, 168]], wet: [[214, 222, 220], [255, 255, 250]] },
  redrock:  { land: [[188, 128, 84], [242, 196, 140]], rock: [[78, 34, 26], [226, 124, 82]], wet: [[200, 150, 104], [246, 214, 164]] },
  delta:    { land: [[150, 142, 88], [224, 212, 148]], rock: [[70, 60, 48], [196, 178, 146]], wet: [[104, 138, 78], [170, 198, 118]] },
};
const WATER_RAMP = { default: [[112, 196, 196], [22, 74, 112]], saltflat: [[150, 214, 206], [44, 122, 140]], delta: [[104, 170, 150], [28, 84, 96]], oasis: [[96, 190, 184], [20, 92, 110]] };
const TOD = {
  dawn: { mul: [1.0, 0.96, 0.95], add: [8, 2, 4] },
  day: { mul: [1, 1, 1], add: [0, 0, 0] },
  golden: { mul: [1.05, 0.98, 0.86], add: [6, 2, 0] },
  dusk: { mul: [0.94, 0.8, 0.86], add: [12, 2, 12] },
  night: { mul: [0.7, 0.68, 0.74], add: [2, 6, 22] },
};
const WEATHER = { clear: null, haze: { to: [226, 224, 214], k: 0.12 }, dust: { to: [214, 178, 130], k: 0.16 } };
const PLAYER_COLORS = [[214, 54, 54], [46, 110, 224], [44, 168, 84], [236, 190, 40], [156, 80, 204], [240, 130, 40]];
const DIGITS = {
  1: ['010', '110', '010', '010', '111'], 2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'], 4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'], 6: ['111', '100', '111', '101', '111'],
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function buildPalette(theme) {
  const biome = BIOMES[theme && theme.biome] || BIOMES.dunes;
  const waterRamp = WATER_RAMP[theme && theme.biome] || WATER_RAMP.default;
  const tod = TOD[theme && theme.tod] || TOD.day;
  const wx = WEATHER[theme && theme.weather] || null;
  const grade = (c) => {
    let o = c.map((v, k) => v * tod.mul[k] + tod.add[k]);
    if (wx) o = o.map((v, k) => v + (wx.to[k] * tod.mul[k] - v) * wx.k);
    return o.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  };
  const palette = [];
  const ramp = (pair, n) => {
    const start = palette.length;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      palette.push(grade(pair[0].map((v, k) => v + (pair[1][k] - v) * t)));
    }
    return { start, n };
  };
  const P = {
    land: ramp(biome.land, 56),
    rock: ramp(biome.rock, 72),
    wet: ramp(biome.wet, 16),
    water: ramp(waterRamp, 48),
  };
  const fixed = (c) => { palette.push(c); return palette.length - 1; };
  P.foam = fixed(grade([236, 248, 244]));
  P.black = fixed([16, 14, 12]);
  P.white = fixed([255, 255, 255]);
  P.amber = fixed([255, 186, 40]);
  P.frame = fixed([28, 24, 22]);
  P.players = PLAYER_COLORS.map(fixed);
  return { palette, P };
}

// bilinear sample of a per-cell Float32Array at continuous cell coords
function sampler(arr, w, h) {
  return (u, v) => {
    u = Math.max(0, Math.min(w - 1, u));
    v = Math.max(0, Math.min(h - 1, v));
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = u - x0, fy = v - y0;
    const a = arr[y0 * w + x0] + (arr[y0 * w + x1] - arr[y0 * w + x0]) * fx;
    const b = arr[y1 * w + x0] + (arr[y1 * w + x1] - arr[y1 * w + x0]) * fx;
    return a + (b - a) * fy;
  };
}

function blur(arr, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          s += arr[ny * w + nx]; n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

export function renderPreview(map, { maxPx = MAX_PX, markers = true } = {}) {
  const { w, h, terrain: t } = map;
  const s = Math.max(1, Math.floor(maxPx / Math.max(w, h)));
  const W = w * s, H = h * s;
  const { palette, P } = buildPalette(map.theme);

  const rockIn = distanceTo(t, w, h, (v) => v !== ROCK);   // depth inside rock
  const waterIn = distanceTo(t, w, h, (v) => v !== WATER); // depth inside water
  const toRock = distanceTo(t, w, h, (v) => v === ROCK);
  const toWater = distanceTo(t, w, h, (v) => v === WATER);
  const rockM = new Float32Array(w * h), waterM = new Float32Array(w * h);
  const detail = makeFbm(0x51a7e, { cells: 9, octaves: 3 });
  const dunes = makeFbm(0xd00e5, { cells: 14, octaves: 3 });
  let height = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      rockM[i] = t[i] === ROCK ? 1 : 0;
      waterM[i] = t[i] === WATER ? 1 : 0;
      if (t[i] === ROCK) {
        height[i] = 0.3 + 0.085 * Math.min(rockIn[i], 11) + 0.16 * detail(x, y) * Math.min(1, rockIn[i] / 2.5);
      } else if (t[i] === LAND) {
        height[i] = 0.05 * dunes(x, y) + 0.1 * Math.exp(-toRock[i] / 2.5);
      } else {
        height[i] = -0.04;
      }
    }
  }
  height = blur(height, w, h);
  const sH = sampler(height, w, h), sR = sampler(rockM, w, h), sW = sampler(waterM, w, h);
  const sDepth = sampler(waterIn, w, h), sShore = sampler(toWater, w, h);

  const hp = new Float32Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) hp[py * W + px] = sH((px + 0.5) / s - 0.5, (py + 0.5) / s - 0.5);
  }
  const px8 = new Uint8Array(W * H);
  const Lx = -0.58, Ly = -0.58, Lz = 0.57; // light from the north-west
  const zs = 5.5 * s;                       // relief exaggeration
  const ripple = makeFbm(0x77a7e4, { cells: 5, octaves: 2 });
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      const u = (px + 0.5) / s - 0.5, v = (py + 0.5) / s - 0.5;
      const gx = (hp[py * W + Math.min(W - 1, px + 1)] - hp[py * W + Math.max(0, px - 1)]) * 0.5 * zs;
      const gy = (hp[Math.min(H - 1, py + 1) * W + px] - hp[Math.max(0, py - 1) * W + px]) * 0.5 * zs;
      const lambert = (-gx * Lx - gy * Ly + Lz) / Math.sqrt(gx * gx + gy * gy + 1);
      const rel = lambert - Lz; // 0 on flat ground
      const wm = sW(u, v), rm = sR(u, v);
      if (wm > 0.5) {
        const d = sDepth(u, v);
        if (d < 0.75) { px8[i] = P.foam; continue; }
        const k = clamp01((d - 0.75) / 9 + 0.05 * ripple(u, v));
        px8[i] = P.water.start + Math.round(k * (P.water.n - 1));
      } else if (rm > 0.5) {
        const k = clamp01(0.52 + rel * 1.25 + 0.2 * (hp[i] - 0.7));
        px8[i] = P.rock.start + Math.round(k * (P.rock.n - 1));
      } else {
        const k = clamp01(0.56 + rel * 1.3 + 0.16 * dunes(u * 1.7 + 40, v * 1.7 + 11));
        const shore = sShore(u, v);
        if (shore < 1.8) px8[i] = P.wet.start + Math.round(k * (P.wet.n - 1));
        else px8[i] = P.land.start + Math.round(k * (P.land.n - 1));
      }
    }
  }

  if (markers) {
    const disc = (cx, cy, r, idx) => {
      const r2 = r * r;
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= r2) px8[y * W + x] = idx;
        }
      }
    };
    const oilR = Math.max(3.2, s * 1.2);
    for (const o of map.oil) {
      const cx = (o.x + 0.5) * s, cy = (o.y + 0.5) * s;
      disc(cx, cy, oilR + 1.6, P.amber);
      disc(cx, cy, oilR, P.black);
    }
    const spR = Math.max(8, s * 3.2);
    map.spawns.forEach((sp, n) => {
      const cx = (sp.x + 0.5) * s, cy = (sp.y + 0.5) * s;
      disc(cx, cy, spR + 2, P.white);
      disc(cx, cy, spR, P.players[n % P.players.length]);
      const glyph = DIGITS[n + 1];
      if (!glyph) return;
      const k = Math.max(2, Math.floor(spR / 4));
      const gx0 = Math.round(cx - 1.5 * k), gy0 = Math.round(cy - 2.5 * k);
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 3; c++) {
          if (glyph[r][c] !== '1') continue;
          for (let yy = 0; yy < k; yy++) {
            for (let xx = 0; xx < k; xx++) {
              const x = gx0 + c * k + xx, y = gy0 + r * k + yy;
              if (x >= 0 && y >= 0 && x < W && y < H) px8[y * W + x] = P.white;
            }
          }
        }
      }
    });
  }
  for (let x = 0; x < W; x++) { px8[x] = P.frame; px8[(H - 1) * W + x] = P.frame; }
  for (let y = 0; y < H; y++) { px8[y * W] = P.frame; px8[y * W + W - 1] = P.frame; }
  return { width: W, height: H, png: encodeIndexedPng(W, H, px8, palette) };
}

export function renderAll({ mapsDir = MAPS_DIR, outDir = OUT_DIR, only = null, log = () => {} } = {}) {
  let ids;
  const manifestPath = path.join(mapsDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) ids = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).maps;
  else ids = fs.readdirSync(mapsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  if (only) ids = only;
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const id of ids) {
    const map = JSON.parse(fs.readFileSync(path.join(mapsDir, id + '.json'), 'utf8'));
    const img = renderPreview(map);
    const file = path.join(outDir, id + '.png');
    fs.writeFileSync(file, img.png);
    out.push({ id, file, width: img.width, height: img.height, bytes: img.png.length });
    log(`${id.padEnd(22)} ${img.width}x${img.height}  ${(img.png.length / 1024).toFixed(1)} KB`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const only = opt('--only');
  renderAll({
    mapsDir: opt('--maps') ? path.resolve(opt('--maps')) : MAPS_DIR,
    outDir: opt('--out') ? path.resolve(opt('--out')) : OUT_DIR,
    only: only ? only.split(',') : null,
    log: (m) => console.log(m),
  });
}
