// Stylised map art painted straight from a map's terrain array (0 sand,
// 1 rock, 2 water): shaded coastlines, wind-rippled sand, oil and spawn
// markers. Used by the map pickers (menu) and the in-match minimap so both
// share one cartographic language. Pure canvas, cached per map object.

const PALETTES = {
  // menu previews: warm satellite-style plate
  sat: {
    deep: [8, 26, 44], mid: [14, 52, 76], shallow: [30, 96, 116], foam: [96, 170, 176],
    beach: [226, 202, 154], sand: [190, 158, 106], sandLo: [146, 116, 76],
    rock: [84, 74, 66], rockHi: [118, 106, 94],
  },
  // minimap: darker tactical plate so unit pips stay the brightest thing on it
  tac: {
    deep: [7, 17, 26], mid: [10, 31, 44], shallow: [18, 54, 66], foam: [44, 98, 106],
    beach: [124, 110, 84], sand: [96, 84, 62], sandLo: [70, 61, 45],
    rock: [42, 38, 34], rockHi: [64, 58, 52],
  },
};

const cache = new WeakMap(); // map object -> { sat: canvas, tac: canvas }

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// smooth value noise, lattice period `p` cells
function vnoise(x, y, p) {
  const gx = x / p, gy = y / p;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0), b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1), d = hash2(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// city-block distance (capped) from every cell to the nearest cell where
// pred(terrain) holds — two-pass chamfer
function distanceField(map, pred, cap) {
  const w = map.w, hgt = map.h, t = map.terrain;
  const d = new Uint8Array(w * hgt);
  for (let i = 0; i < d.length; i++) d[i] = pred(t[i]) ? 0 : cap;
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      if (y > 0 && d[i - w] + 1 < v) v = d[i - w] + 1;
      d[i] = v;
    }
  }
  for (let y = hgt - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      if (y < hgt - 1 && d[i + w] + 1 < v) v = d[i + w] + 1;
      d[i] = v;
    }
  }
  return d;
}

function lerp3(a, b, t, out) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

// Paint the terrain at 2 px per cell. Returns a canvas (cached).
export function terrainCanvas(map, paletteName) {
  const key = PALETTES[paletteName] ? paletteName : 'sat';
  let entry = cache.get(map);
  if (!entry) { entry = {}; cache.set(map, entry); }
  if (entry[key]) return entry[key];

  const P = PALETTES[key];
  const w = map.w, hgt = map.h, t = map.terrain;
  const toWater = distanceField(map, (v) => v === 2, 12);  // land cells: distance to sea
  const toLand = distanceField(map, (v) => v !== 2, 12);   // water cells: distance to shore
  const S = 2;
  const cv = document.createElement('canvas');
  cv.width = w * S;
  cv.height = hgt * S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w * S, hgt * S);
  const px = img.data;
  const c = [0, 0, 0];
  for (let y = 0; y < hgt * S; y++) {
    const cy = y >> 1;
    for (let x = 0; x < w * S; x++) {
      const cx = x >> 1;
      const i = cy * w + cx;
      const tv = t[i];
      const fxp = x / S, fyp = y / S;
      if (tv === 2) {
        const dl = toLand[i];
        if (dl <= 1) lerp3(P.shallow, P.foam, 0.42, c);
        else if (dl <= 3) lerp3(P.shallow, P.mid, (dl - 1) / 3, c);
        else lerp3(P.mid, P.deep, Math.min(1, (dl - 3) / 7), c);
        // long, faint swell bands
        const sw = Math.sin(fyp * 0.55 + vnoise(fxp, fyp, 18) * 5) * 0.035;
        c[0] *= 1 + sw; c[1] *= 1 + sw; c[2] *= 1 + sw;
      } else if (tv === 1) {
        lerp3(P.rock, P.rockHi, hash2(cx * 3.1, cy * 1.7) * 0.9, c);
      } else {
        const dw = toWater[i];
        const n = vnoise(fxp, fyp, 14) * 0.65 + vnoise(fxp + 91, fyp + 37, 5) * 0.35;
        lerp3(P.sand, P.sandLo, n * 0.85, c);
        // wind ripples across the dune field
        const rip = Math.sin((fxp * 0.42 + fyp * 0.78) + n * 7) * 0.045;
        c[0] *= 1 + rip; c[1] *= 1 + rip; c[2] *= 1 + rip;
        if (dw <= 1) lerp3(c, P.beach, 0.72, c);
        else if (dw <= 3) lerp3(c, P.beach, 0.34 - (dw - 2) * 0.14, c);
        // rock outcrops throw a soft apron of darker ground
        if (cx > 0 && cx < w - 1 && cy > 0 && cy < hgt - 1
          && (t[i - 1] === 1 || t[i + 1] === 1 || t[i - w] === 1 || t[i + w] === 1)) {
          lerp3(c, P.rock, 0.35, c);
        }
      }
      const g = (hash2(x, y) - 0.5) * 7; // fine grain
      const o = (y * w * S + x) * 4;
      px[o] = Math.max(0, Math.min(255, c[0] + g));
      px[o + 1] = Math.max(0, Math.min(255, c[1] + g));
      px[o + 2] = Math.max(0, Math.min(255, c[2] + g));
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  entry[key] = cv;
  return cv;
}

const ROLE_STYLE = {
  you: { fill: '#5fe3d0', ink: '#04201c', ring: 'rgba(95,227,208,.55)' },
  ally: { fill: '#6aa8ff', ink: '#061630', ring: 'rgba(106,168,255,.5)' },
  enemy: { fill: '#ff5a3c', ink: '#2a0a04', ring: 'rgba(255,90,60,.5)' },
  open: { fill: 'rgba(238,242,246,.14)', ink: '#eef2f6', ring: 'rgba(238,242,246,.55)' },
};

// Draw a framed preview into `canvas` at its CSS box size (DPR-aware).
// opts: { roles: ['you'|'ally'|'enemy'|'open' per spawn], markers: bool,
//         oil: bool, grid: bool, palette: 'sat'|'tac', fit: 'contain'|'cover',
//         size: css px override }
export function drawMapPreview(canvas, map, opts) {
  const o = opts || {};
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const box = o.size || canvas.clientWidth || 200;
  const boxH = o.sizeH || canvas.clientHeight || box;
  const W = Math.max(16, Math.round(box * dpr));
  const H = Math.max(16, Math.round(boxH * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!map) return;
  const terr = terrainCanvas(map, o.palette || 'sat');
  // letterbox-fit the map (maps are square today; stay correct if not);
  // fit:'cover' crops to fill instead (thumbnails)
  const k = o.fit === 'cover' ? Math.max(W / map.w, H / map.h) : Math.min(W / map.w, H / map.h);
  const dw = map.w * k, dh = map.h * k;
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(terr, ox, oy, dw, dh);

  if (o.grid !== false && box >= 150) {
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 32; gx < map.w; gx += 32) {
      const x = Math.round(ox + gx * k) + 0.5;
      ctx.moveTo(x, oy); ctx.lineTo(x, oy + dh);
    }
    for (let gy = 32; gy < map.h; gy += 32) {
      const y = Math.round(oy + gy * k) + 0.5;
      ctx.moveTo(ox, y); ctx.lineTo(ox + dw, y);
    }
    ctx.stroke();
  }

  // soft vignette so plates sit into the glass
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  const big = box >= 150;
  if (o.oil !== false && map.oil) {
    const r = (big ? 3.4 : 1.8) * dpr;
    for (const f of map.oil) {
      const x = ox + (f.x + 0.5) * k, y = oy + (f.y + 0.5) * k;
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = '#ffd98a';
      ctx.strokeStyle = 'rgba(20,12,2,0.9)';
      ctx.lineWidth = Math.max(1, dpr * (big ? 1.2 : 0.8));
      ctx.fill();
      ctx.stroke();
    }
  }

  if (o.markers !== false && map.spawns) {
    const roles = o.roles || [];
    map.spawns.forEach((sp, idx) => {
      const st = ROLE_STYLE[roles[idx] || 'open'];
      const x = ox + (sp.x + 0.5) * k, y = oy + (sp.y + 0.5) * k;
      const r = (big ? 9 : 3.2) * dpr;
      if (big && roles[idx] && roles[idx] !== 'open') {
        ctx.beginPath();
        ctx.arc(x, y, r + 4 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = st.ring;
        ctx.lineWidth = 1.5 * dpr;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = roles[idx] && roles[idx] !== 'open' ? st.fill : 'rgba(8,11,16,0.72)';
      ctx.fill();
      ctx.strokeStyle = roles[idx] && roles[idx] !== 'open' ? 'rgba(5,7,10,0.9)' : st.ring;
      ctx.lineWidth = (big ? 1.5 : 1) * dpr;
      ctx.stroke();
      if (big) {
        ctx.fillStyle = roles[idx] && roles[idx] !== 'open' ? st.ink : st.ink;
        ctx.font = '700 ' + Math.round(11 * dpr) + 'px Rajdhani, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(idx + 1), x, y + 0.5 * dpr);
      }
    });
  }
}

// share of the map that is water, 0..1 (cached on the map object entry)
export function waterShare(map) {
  let entry = cache.get(map);
  if (!entry) { entry = {}; cache.set(map, entry); }
  if (entry.water === undefined) {
    let n = 0;
    for (let i = 0; i < map.terrain.length; i++) if (map.terrain[i] === 2) n++;
    entry.water = n / Math.max(1, map.terrain.length);
  }
  return entry.water;
}
