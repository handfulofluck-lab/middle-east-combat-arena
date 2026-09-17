// Bottom-left minimap: terrain + oil + entity dots with fog applied,
// camera rectangle, click to jump.
import { CELL } from '../sim/index.js';
import { centerCameraOn, clampCameraToMap } from './camera.js';
import { ownerColorOf } from './sprites.js';

const MM_TERRAIN = ['#8a7a50', '#3a3a3a', '#1d3a5e'];

export function initMinimap(game) {
  const root = document.getElementById('minimap');
  root.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 200;
  root.appendChild(canvas);
  game.minimap = { canvas, ctx: canvas.getContext('2d'), terrain: null, pings: [] };

  canvas.addEventListener('mousedown', (e) => {
    if (!game.state) return;
    const r = canvas.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    centerCameraOn(game.camera,
      fx * game.state.map.w * CELL, fy * game.state.map.h * CELL);
    clampCameraToMap(game.camera, game.state.map.w * CELL, game.state.map.h * CELL);
  });
}

// expanding-ring ping (world coords); fades over ~3s of sim time
export function addPing(game, wx, wy) {
  if (!game.minimap) return;
  const until = (game.state ? game.state.tick : 0) + 30;
  game.minimap.pings.push({ x: wx, y: wy, until });
  if (game.minimap.pings.length > 12) game.minimap.pings.shift();
}

function prerenderMinimapTerrain(game) {
  const map = game.state.map;
  const t = document.createElement('canvas');
  t.width = map.w;
  t.height = map.h;
  const c = t.getContext('2d');
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      c.fillStyle = MM_TERRAIN[map.terrain[y * map.w + x]];
      c.fillRect(x, y, 1, 1);
    }
  }
  c.fillStyle = '#e8c84a';
  for (const o of map.oil) c.fillRect(o.x - 1, o.y - 1, 2, 2);
  game.minimap.terrain = t;
}

export function updateMinimap(game) {
  const st = game.state;
  if (!st || !game.minimap) return;
  if (!game.minimap.terrain) prerenderMinimapTerrain(game);
  const { canvas, ctx, terrain } = game.minimap;
  const W = canvas.width, H = canvas.height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(terrain, 0, 0, W, H);

  const fx = W / (st.map.w * CELL);
  const fy = H / (st.map.h * CELL);
  const fog = st.fog[game.playerSlot];

  // entity dots (hostiles only where currently visible)
  for (const id in st.structures) {
    const s = st.structures[id];
    const own = s.owner === game.playerSlot;
    if (!own && !fog.visible[(s.cy + (s.fp >> 1)) * st.map.w + s.cx + (s.fp >> 1)]) continue;
    const type = st.structDefs[s.defId].type;
    const px = (s.cx + (s.fp >> 1)) * CELL * fx;
    const py = (s.cy + (s.fp >> 1)) * CELL * fy;
    ctx.fillStyle = ownerColorOf(st, s.owner);
    if (type === 'Def') {           // circle: defensive
      ctx.beginPath(); ctx.arc(px, py, 2.4, 0, 7); ctx.fill();
    } else if (type === 'Eco') {    // diamond: economy
      ctx.beginPath(); ctx.moveTo(px, py - 3); ctx.lineTo(px + 3, py);
      ctx.lineTo(px, py + 3); ctx.lineTo(px - 3, py); ctx.closePath(); ctx.fill();
    } else {                        // square: Core/Prod/other
      ctx.fillRect(px - 2, py - 2, 4, 4);
    }
  }
  for (const id in st.units) {
    const u = st.units[id];
    const own = u.owner === game.playerSlot;
    if (!own && !fog.visible[cellIdx(st, u.x, u.y)]) continue;
    ctx.fillStyle = ownerColorOf(st, u.owner);
    ctx.fillRect(u.x * fx - 1, u.y * fy - 1, 2, 2);
  }

  // fog dim
  if (game.render && game.render.fog) {
    ctx.globalAlpha = 0.6;
    ctx.drawImage(game.render.fog, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // pings (expanding rings, newest on top)
  if (game.minimap.pings.length) {
    game.minimap.pings = game.minimap.pings.filter((p) => p.until > st.tick);
    for (const p of game.minimap.pings) {
      const t = (p.until - st.tick) / 30; // 1 -> 0
      ctx.strokeStyle = 'rgba(255,235,150,' + (0.25 + 0.75 * t).toFixed(2) + ')';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x * fx, p.y * fy, 3 + (1 - t) * 12, 0, 7);
      ctx.stroke();
    }
  }

  // camera rect
  if (game.camera) {
    const cam = game.camera;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(cam.x * fx, cam.y * fy,
      cam.viewW / cam.zoom * fx, cam.viewH / cam.zoom * fy);
  }
}

function cellIdx(st, wx, wy) {
  const cx = Math.max(0, Math.min(st.map.w - 1, Math.floor(wx / CELL)));
  const cy = Math.max(0, Math.min(st.map.h - 1, Math.floor(wy / CELL)));
  return cy * st.map.w + cx;
}
