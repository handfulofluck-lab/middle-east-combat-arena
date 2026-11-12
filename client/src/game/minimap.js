// Bottom-left tactical minimap: stylised terrain + oil + entity pips with fog
// applied, pings, the camera footprint, click / drag to jump.
//
// game.minimap = { canvas, ctx, terrain, pings, ... } — main.js resets
// `terrain` and `pings` between matches. A renderer with a perspective
// camera may publish its ground footprint as game.minimapView = [{x,y}×4]
// (world units, any winding); without it the box is derived from game.camera.
import { CELL, isInfantryCls } from '../sim/index.js';
import { centerCameraOn, clampCameraToMap } from './camera.js';
import { ownerColorOf } from './sprites.js';
import { terrainCanvas } from '../ui/mapart.js';
import { teamFog, isAllyOrSelf } from './teamfog.js';

const FOG_MS = 160; // fog mask refresh cadence (real time)

function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
}

export function initMinimap(game) {
  const root = document.getElementById('minimap');
  root.textContent = '';
  const head = h('div', 'mm-head');
  head.appendChild(h('span', 'micro', 'Tactical map'));
  const nameEl = h('span', 'mm-name', '');
  head.appendChild(nameEl);
  root.appendChild(head);
  const view = h('div', 'mm-view brackets');
  const canvas = document.createElement('canvas');
  // backing store follows the CSS box × DPR (see fitCanvas); 1:1 start value
  canvas.width = 244;
  canvas.height = 244;
  view.appendChild(canvas);
  root.appendChild(view);
  game.minimap = {
    canvas, ctx: canvas.getContext('2d'), terrain: null, pings: [],
    nameEl, fog: null, fogCtx: null, fogImg: null, fogAt: -1e9, fogFor: null,
    rect: { x: 0, y: 0, w: canvas.width, h: canvas.height }, camSig: '',
  };

  // screen point -> world point through the letterboxed map rect
  const jump = (e) => {
    const st = game.state;
    if (!st || !game.camera) return;
    const M = game.minimap;
    const r = canvas.getBoundingClientRect();
    const kx = canvas.width / Math.max(1, r.width), ky = canvas.height / Math.max(1, r.height);
    const px = (e.clientX - r.left) * kx, py = (e.clientY - r.top) * ky;
    const fx = Math.max(0, Math.min(1, (px - M.rect.x) / Math.max(1, M.rect.w)));
    const fy = Math.max(0, Math.min(1, (py - M.rect.y) / Math.max(1, M.rect.h)));
    centerCameraOn(game.camera, fx * st.map.w * CELL, fy * st.map.h * CELL);
    clampCameraToMap(game.camera, st.map.w * CELL, st.map.h * CELL);
    drawMinimap(game);
  };
  let mmDrag = false;
  canvas.addEventListener('mousedown', (e) => {
    if (!game.state || e.button !== 0) return;
    mmDrag = true; // drag-on-minimap pans continuously until release
    jump(e);
    e.preventDefault();
  });
  canvas.addEventListener('mousemove', (e) => {
    if (mmDrag && game.state) jump(e);
  });
  canvas.addEventListener('mouseup', () => { mmDrag = false; });
  canvas.addEventListener('mouseleave', () => { mmDrag = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // between sim ticks (or while paused) keep the camera box live
  if (typeof requestAnimationFrame === 'function' && !game._mmRaf) {
    game._mmRaf = true;
    const frame = () => {
      try {
        const M = game.minimap;
        if (M && game.state && game.camera) {
          const sig = camSig(game);
          if (sig !== M.camSig) drawMinimap(game);
        }
      } catch (e) { /* cosmetic only */ }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}

function camSig(game) {
  const cam = game.camera;
  const v = game.minimapView;
  let s = Math.round(cam.x) + ',' + Math.round(cam.y) + ',' + cam.zoom.toFixed(3) + ',' + cam.viewW + ',' + cam.viewH;
  if (v && v.length === 4) s += '|' + Math.round(v[0].x) + ',' + Math.round(v[0].y) + ',' + Math.round(v[2].x) + ',' + Math.round(v[2].y);
  return s;
}

// expanding-ring ping (world coords); fades over ~3s of sim time.
// kind 'alert' draws in the hostile colour.
export function addPing(game, wx, wy, kind) {
  if (!game.minimap) return;
  const until = (game.state ? game.state.tick : 0) + 30;
  game.minimap.pings.push({ x: wx, y: wy, until, kind: kind || '' });
  if (game.minimap.pings.length > 12) game.minimap.pings.shift();
}

function fitCanvas(M) {
  const cv = M.canvas;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (!cw || !ch) return; // HUD hidden: keep the last backing store
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
}

// fog mask at map resolution: unexplored = opaque ink, explored-but-dark = veil
function fogLayer(game, st) {
  const M = game.minimap;
  const fog = st.fog && teamFog(game, st);
  if (!fog || !fog.visible) return null;
  const w = st.map.w, hgt = st.map.h;
  if (!M.fog || M.fogFor !== st) {
    M.fog = document.createElement('canvas');
    M.fog.width = w; M.fog.height = hgt;
    M.fogCtx = M.fog.getContext('2d');
    M.fogImg = M.fogCtx.createImageData(w, hgt);
    M.fogFor = st;
    M.fogAt = -1e9;
  }
  const now = nowMs();
  if (now - M.fogAt < FOG_MS) return M.fog;
  M.fogAt = now;
  const px = M.fogImg.data;
  const vis = fog.visible, seen = fog.seen;
  for (let i = 0, o = 0; i < vis.length; i++, o += 4) {
    // rgb stays the ink colour; only alpha varies
    px[o] = 4; px[o + 1] = 6; px[o + 2] = 9;
    px[o + 3] = vis[i] ? 0 : (seen && seen[i]) ? 138 : 246;
  }
  M.fogCtx.putImageData(M.fogImg, 0, 0);
  return M.fog;
}

function pip(ctx, shape, x, y, r) {
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(x, y, r, 0, 7);
  else if (shape === 'diamond') {
    ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 1.25, y); ctx.lineTo(x, y + r * 1.25); ctx.lineTo(x - r * 1.25, y);
  } else if (shape === 'tri') {
    ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.1, y + r * 0.85); ctx.lineTo(x - r * 1.1, y + r * 0.85);
  } else ctx.rect(x - r, y - r, r * 2, r * 2);
  ctx.closePath();
}

export function updateMinimap(game) {
  if (!game.state || !game.minimap) return;
  drawMinimap(game);
}

function drawMinimap(game) {
  const st = game.state;
  const M = game.minimap;
  if (!st || !M) return;
  if (!M.terrain) {
    M.terrain = terrainCanvas(st.map, 'tac');
    if (M.nameEl) M.nameEl.textContent = st.map.name || '';
  }
  fitCanvas(M);
  const { canvas, ctx, terrain } = M;
  const W = canvas.width, H = canvas.height;
  const u = W / 220; // pip scale relative to the classic 220px map

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, W, H);
  // letterbox-fit (maps are square today; stay correct if one is not)
  const k = Math.min(W / st.map.w, H / st.map.h);
  const dw = st.map.w * k, dh = st.map.h * k;
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  M.rect.x = ox; M.rect.y = oy; M.rect.w = dw; M.rect.h = dh;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(terrain, ox, oy, dw, dh);

  const fx = dw / (st.map.w * CELL);
  const fy = dh / (st.map.h * CELL);
  const fog = teamFog(game, st); // own sight plus every ally's
  const outline = 'rgba(4,6,9,0.9)';

  // oil fields: small gold diamonds (terrain feature, drawn under the fog)
  ctx.fillStyle = '#e9c46a';
  ctx.strokeStyle = outline;
  ctx.lineWidth = Math.max(1, u * 0.8);
  for (const o of st.map.oil || []) {
    pip(ctx, 'diamond', ox + (o.x + 0.5) * CELL * fx, oy + (o.y + 0.5) * CELL * fy, 1.7 * u);
    ctx.stroke();
    ctx.fill();
  }

  // entity pips (hostiles only where currently visible)
  ctx.lineWidth = Math.max(1, u);
  for (const id in st.structures) {
    const s = st.structures[id];
    const own = isAllyOrSelf(st, game.playerSlot, s.owner);
    if (!own && !fog.visible[(s.cy + (s.fp >> 1)) * st.map.w + s.cx + (s.fp >> 1)]) continue;
    const type = st.structDefs[s.defId].type;
    const px = ox + (s.cx + (s.fp >> 1)) * CELL * fx;
    const py = oy + (s.cy + (s.fp >> 1)) * CELL * fy;
    // circle: defensive · diamond: economy · square: core / production / other
    pip(ctx, type === 'Def' ? 'circle' : type === 'Eco' ? 'diamond' : 'square', px, py, (type === 'Def' ? 2.3 : 2.2) * u);
    ctx.strokeStyle = outline;
    ctx.stroke();
    ctx.fillStyle = ownerColorOf(st, s.owner);
    ctx.fill();
  }
  for (const id in st.units) {
    const un = st.units[id];
    const own = isAllyOrSelf(st, game.playerSlot, un.owner);
    if (!own && !fog.visible[cellIdx(st, un.x, un.y)]) continue;
    const def = st.unitDefs[un.defId];
    const px = ox + un.x * fx, py = oy + un.y * fy;
    // class shapes: air = triangle, naval = diamond, infantry = dot, vehicles = square
    let shape = 'square', r = 1.25;
    if (def && def.domain === 'Air') { shape = 'tri'; r = 2; }
    else if (def && def.domain === 'Sea') { shape = 'diamond'; r = 1.9; }
    else if (def && isInfantryCls(def.cls)) { shape = 'circle'; r = 0.9; }
    pip(ctx, shape, px, py, r * u);
    ctx.strokeStyle = outline;
    ctx.stroke();
    ctx.fillStyle = ownerColorOf(st, un.owner);
    ctx.fill();
  }

  // fog: unexplored is truly dark on the minimap too, explored-not-visible
  // reads as a dimmed snapshot
  const fl = fogLayer(game, st);
  if (fl) ctx.drawImage(fl, ox, oy, dw, dh);
  else if (game.render && game.render.fog) ctx.drawImage(game.render.fog, ox, oy, dw, dh);

  // pings (expanding rings, newest on top)
  if (M.pings.length) {
    M.pings = M.pings.filter((p) => p.until > st.tick);
    for (const p of M.pings) {
      const t = (p.until - st.tick) / 30; // 1 -> 0
      const a = (0.25 + 0.75 * t).toFixed(2);
      ctx.strokeStyle = p.kind === 'alert' ? 'rgba(255,110,84,' + a + ')' : 'rgba(255,226,160,' + a + ')';
      ctx.lineWidth = 1.6 * u;
      ctx.beginPath();
      ctx.arc(ox + p.x * fx, oy + p.y * fy, (3 + (1 - t) * 12) * u, 0, 7);
      ctx.stroke();
    }
  }

  // camera footprint
  if (game.camera) {
    const cam = game.camera;
    M.camSig = camSig(game);
    ctx.lineWidth = Math.max(1, 1.2 * u);
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    const v = game.minimapView;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, dw, dh);
    ctx.clip();
    ctx.beginPath();
    if (v && v.length === 4) {
      ctx.moveTo(ox + v[0].x * fx, oy + v[0].y * fy);
      for (let i = 1; i < 4; i++) ctx.lineTo(ox + v[i].x * fx, oy + v[i].y * fy);
      ctx.closePath();
    } else {
      ctx.rect(Math.round(ox + cam.x * fx) + 0.5, Math.round(oy + cam.y * fy) + 0.5,
        cam.viewW / cam.zoom * fx, cam.viewH / cam.zoom * fy);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function cellIdx(st, wx, wy) {
  const cx = Math.max(0, Math.min(st.map.w - 1, Math.floor(wx / CELL)));
  const cy = Math.max(0, Math.min(st.map.h - 1, Math.floor(wy / CELL)));
  return cy * st.map.w + cx;
}
