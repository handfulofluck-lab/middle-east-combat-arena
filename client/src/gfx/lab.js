// Renderer lab: boots the real sim with AI players and the new renderer,
// without menus or HUD. Query: ?map=sinai&ticks=1200&speed=2&kit=real&q=high
//   &cam=wx,wy,dist,yaw,pitch  &slot=0  &reveal=1  &players=2
import * as Sim from '../sim/index.js';
import { initGl, glFrame, focusGl } from './engine.js';

const q = new URLSearchParams(location.search);
const info = document.getElementById('info');
window.__lab = { ready: false, errors: [] };
window.__glErrors = window.__lab.errors;
window.addEventListener('error', (e) => window.__lab.errors.push(String(e.message) + ' @' + e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => window.__lab.errors.push('rejection: ' + (e.reason && e.reason.stack || e.reason)));

async function main() {
  const get = (u) => fetch(u).then((r) => r.json());
  const data = await get('data/game.json');
  const mapId = q.get('map') || 'sinai';
  const map = await get('maps/' + mapId + '.json');
  if (q.get('tod') || q.get('biome') || q.get('weather')) {
    map.theme = Object.assign({}, map.theme, q.get('tod') ? { tod: q.get('tod') } : {}, q.get('biome') ? { biome: q.get('biome') } : {}, q.get('weather') ? { weather: q.get('weather') } : {});
  }
  const factions = Object.keys(data.factions);
  const n = Math.min(Number(q.get('players') || 2), map.spawns.length);
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({ slot: i, faction: q.get('f' + i) || factions[(i * 5) % factions.length], team: i % 2, ai: { personality: q.get('ai') || 'Front', difficulty: 'elite' } });
  }
  const seed = Number(q.get('seed') || 7);
  const state = Sim.createMatch({ data, map, players, seed });
  const ai = Sim.createAI(players, seed);
  const pre = Number(q.get('ticks') || 0);
  const t0 = performance.now();
  for (let i = 0; i < pre && !state.over; i++) Sim.tick(state, Sim.aiCommands(state, ai));
  const simMs = performance.now() - t0;

  const ui = document.getElementById('ui-overlay');
  const game = {
    data, state, ai, playerSlot: Number(q.get('slot') || 0), selection: [], groups: {},
    mouse: { sx: 0, sy: 0, inside: false }, keys: new Set(), placement: null,
    uiCanvas: ui, uiCtx: ui.getContext('2d'), dpr: 1, iconArt: {}, camera: null,
  };
  const rs = () => { ui.width = innerWidth; ui.height = innerHeight; };
  rs(); addEventListener('resize', rs);
  const t1 = performance.now();
  const gl = initGl(game, { reveal: q.get('reveal') === '1', quality: q.get('q') || undefined });
  gl.wasdPan = true;
  gl.noAutoScale = true;
  const buildMs = performance.now() - t1;
  if (q.get('kit') === 'real') {
    try {
      const p = './models.js';
      const m = await import(/* @vite-ignore */ new URL(p, import.meta.url).href);
      gl.ents.setKit(m.createModelKit({ quality: gl.quality.name === 'low' ? 'low' : 'high' }));
    } catch (e) { window.__lab.errors.push('kit: ' + (e && e.stack || e)); }
  }
  if (q.get('portraits') === '1') gl.portraits.requestAll(state, game.playerSlot);
  if (q.get('cam')) {
    const c = q.get('cam').split(',').map(Number);
    focusGl(game, c[0], c[1], c[2], c[3], c[4]);
  }
  if (q.get('sel') === '1') {
    game.selection = Object.values(state.units).filter((u) => u.owner === game.playerSlot).slice(0, 30).map((u) => u.id);
  }
  const speed = Number(q.get('speed') || 1);
  let last = performance.now(), acc = 0, frames = 0;
  const frame = (now) => {
    if (window.__lab.freeze) { requestAnimationFrame(frame); return; }
    const dt = Math.min(250, now - last); last = now;
    if (!window.__lab.paused) {
      acc += dt * speed;
      let steps = 0;
      while (acc >= 100 && steps < 8 && !state.over) { Sim.tick(state, Sim.aiCommands(state, ai)); acc -= 100; steps++; }
    }
    const f0 = performance.now();
    try { glFrame(game, dt); } catch (e) { window.__lab.errors.push('frame: ' + (e && e.stack || e)); }
    window.__lab.frameMs = performance.now() - f0;
    frames++;
    if (frames % 20 === 0) {
      info.textContent = `${mapId} ${map.w}x${map.h} ${gl.look.biomeName}/${gl.look.todName} tick ${state.tick}\n`
        + `fps ${gl.stats.fps.toFixed(0)} calls ${gl.renderer.info.render.calls} tris ${gl.renderer.info.render.triangles}\n`
        + `units ${Object.keys(state.units).length} structs ${Object.keys(state.structures).length} build ${buildMs.toFixed(0)}ms sim ${simMs.toFixed(0)}ms`;
    }
    window.__lab.frames = frames;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__lab.army = () => {
    // densest knot of fighting units (for camera placement)
    const f = Object.values(state.units).filter((u) => u.order && (u.order.enemyId || u.order.type === 'attackTarget'));
    let best = null;
    for (const a of f) {
      let bx = 0, by = 0, n = 0;
      for (const u of f) { if (Math.abs(u.x - a.x) + Math.abs(u.y - a.y) < 64 * 14) { bx += u.x; by += u.y; n++; } }
      if (!best || n > best[2]) best = [bx / n, by / n, n];
    }
    return best;
  };
  Object.assign(window.__lab, { ready: true, game, gl, state, Sim, focus: (...a) => focusGl(game, ...a) });
}
main().catch((e) => { window.__lab.errors.push('boot: ' + (e && e.stack || e)); info.textContent = String(e && e.stack || e); });
