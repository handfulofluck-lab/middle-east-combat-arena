// Boot + game loop. Renders every animation frame; the sim advances on its
// own fixed 10 Hz schedule via an accumulator (scaled by game speed).
import * as Sim from './sim/index.js';
import { createCamera, centerCameraOn, clampCameraToMap } from './game/camera.js';
import { initInput, handleInputFrame } from './game/input.js';
import { initRenderer, renderFrame } from './game/render.js';
import { initFx, clearFx, fxObserveTick, updateFx } from './game/fx.js';
import { initHud, updateHud, showHint } from './game/hud.js';
import { initMinimap, updateMinimap } from './game/minimap.js';
import { showMenu, showPauseMenu, showEndBanner } from './game/menu.js';
import { setDisplayData, loadAtlas } from './game/display.js';
import { unlockAudio, loadAudioPrefs, sfx } from './game/audio.js';

const TICK_MS = 100; // 10 ticks/sec
let G = null;

export function getGame() {
  return G;
}

async function loadData() {
  // BUILD-INLINE-DATA-BEGIN (tools/build_singlefile.py replaces this block)
  const get = (u) => fetch(u).then((r) => {
    if (!r.ok) throw new Error('fetch ' + u + ': ' + r.status);
    return r.json();
  });
  const data = await get('data/game.json');
  const manifest = await get('maps/manifest.json');
  const payloads = await Promise.all(manifest.maps.map((id) => get('maps/' + id + '.json')));
  const maps = {};
  manifest.maps.forEach((id, i) => { maps[id] = payloads[i]; });
  // display reservoir + sprite map + atlas are optional presentation data:
  // the match must boot fine without them (greybox fallback)
  const getSoft = (u, fb) => fetch(u).then((r) => (r.ok ? r.json() : fb)).catch(() => fb);
  const display = await getSoft('data/display.json', null);
  const spriteMap = await getSoft('data/sprite_map.json', null);
  let atlasB64 = null;
  try {
    const r = await fetch('sprites/atlas.png');
    if (r.ok && typeof r.blob === 'function') {
      const blob = await r.blob();
      const url = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      const m = /^data:image\/png;base64,(.*)$/.exec(url || '');
      atlasB64 = m ? m[1] : null;
    }
  } catch (e) { atlasB64 = null; }
  return { data, maps, display, spriteMap, atlasB64 };
  // BUILD-INLINE-DATA-END
}

export async function boot() {
  loadAudioPrefs();
  const { data, maps, display, spriteMap, atlasB64 } = await loadData();
  setDisplayData(display, spriteMap);
  const canvas = document.getElementById('game');
  G = {
    data, maps, canvas, ctx: canvas.getContext('2d'),
    state: null, ai: null, camera: null, playerSlot: 0,
    selection: [], groups: {}, pendingCmds: [],
    placement: null, targeting: null, attackMoveArmed: false,
    inspectId: 0,
    speed: 1, paused: false, endShown: false, lastCfg: null,
    overlay: null,            // null | 'menu' | 'setup' | 'pause'
    pausedBeforeMenu: false,  // HUD-pause state to restore after the pause overlay
    resumePause: null,        // Esc hook while the pause overlay is up
    menuBack: null,           // Esc hook on the setup screen
    mouse: { sx: 0, sy: 0, inside: false },
    keys: new Set(),
    drag: null, midDrag: null,
    frameErrors: 0, // frames that threw (loop survives; surfaced as a hint)
    dpr: 1,         // devicePixelRatio at last resize (canvas backing-store scale)
    render: null, minimap: null, hud: null,
  };
  G.openMenu = () => {
    if (G.overlay) return; // an overlay is already up — ignore
    if (G.state && !G.state.over && !G.endShown) {
      // live match -> pause overlay (resume restores the pre-overlay pause state)
      G.pausedBeforeMenu = G.paused;
      G.paused = true;
      showPauseMenu(G, {
        onResume: () => {
          G.overlay = null;
          G.paused = G.pausedBeforeMenu;
          if (G.hudSyncSpeed) G.hudSyncSpeed();
        },
        onRestart: () => { G.overlay = null; startMatch(G.lastCfg); },
        onAbandon: () => exitToMenu(),
      });
    } else if (G.state) {
      // match finished (banner up or just over): never leave it rendered
      exitToMenu();
    } else {
      showMenu(G, (c) => startMatch(c));
    }
  };
  const resize = () => {
    // backing store in device px for crisp rendering; camera math stays in CSS px
    const dpr = globalThis.devicePixelRatio || 1;
    G.dpr = dpr;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    if (G.camera) { G.camera.viewW = window.innerWidth; G.camera.viewH = window.innerHeight; }
  };
  window.addEventListener('resize', resize);
  const unlock = () => { unlockAudio(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  resize();

  initInput(G, canvas);
  initHud(G);
  initMinimap(G);
  initFx(G);
  await loadAtlas(G, atlasB64); // sprite atlas; match boots greybox if it fails
  showMenu(G, (cfg) => startMatch(cfg));

  let last = performance.now();
  let acc = 0;
  const frame = (now) => {
    // a bad frame must never kill the loop (v0.3.1: a missing import once
    // bricked rendering mid-match and made every later menu flow look broken)
    try {
      const dt = Math.min(250, now - last);
      last = now;
      handleInputFrame(G, dt);
      updateFx(G, dt);
      if (G.state && !G.paused) {
        acc += dt * G.speed;
        let steps = 0;
        while (acc >= TICK_MS && !G.state.over && steps < 6) {
          simStep();
          acc -= TICK_MS;
          steps++;
        }
        if (steps === 6) acc = 0; // shed backlog instead of death-spiralling
        if (G.state.over) acc = 0;
      }
      if (G.state) renderFrame(G);
    } catch (err) {
      G.frameErrors++;
      if (typeof console !== 'undefined') console.error(err);
      if (G.frameErrors === 1) {
        showHint(G, 'Render/sim error — ' + (err && err.message || err));
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export function startMatch(cfg) {
  G.lastCfg = cfg;
  const map = G.maps[cfg.map];
  const players = [{ slot: 0, faction: cfg.faction, team: 0 }];
  let slot = 1;
  if (cfg.ally) {
    players.push({
      slot: slot, faction: cfg.ally.faction, team: 0,
      ai: { personality: cfg.ally.personality, difficulty: cfg.ally.difficulty },
    });
    slot++;
  }
  for (const o of cfg.opponents) {
    players.push({
      slot: slot, faction: o.faction, team: 1,
      ai: { personality: o.personality, difficulty: o.difficulty },
    });
    slot++;
  }
  const seed = (cfg.seed !== undefined ? cfg.seed : (Date.now() & 0x7fffffff)) >>> 0;
  G.state = Sim.createMatch({ data: G.data, map, players, seed });
  G.ai = Sim.createAI(players, seed);
  G.camera = createCamera(G.canvas.width / (G.dpr || 1), G.canvas.height / (G.dpr || 1));
  const sp = map.spawns[0];
  centerCameraOn(G.camera, sp.x * Sim.CELL + Sim.CELL / 2, sp.y * Sim.CELL + Sim.CELL / 2);
  clampCameraToMap(G.camera, map.w * Sim.CELL, map.h * Sim.CELL);
  G.selection = [];
  G.groups = {};
  G.pendingCmds = [];
  G.placement = null;
  G.targeting = null;
  G.attackMoveArmed = false;
  G.inspectId = 0;
  G.paused = false;
  G.endShown = false;
  G.overlay = null;
  G.resumePause = null;
  G.menuBack = null;
  G.frameErrors = 0;
  clearFx(G);
  // minimap caches are per-match too: force a terrain re-render and drop pings
  if (G.minimap) { G.minimap.pings = []; G.minimap.terrain = null; }
  if (document.body) document.body.classList.remove('in-menu');
  if (G.hudSyncSpeed) G.hudSyncSpeed();
  initRenderer(G);
  updateHud(G);
  updateMinimap(G);
}

// clean exit from any match state back to the main menu: drops all match
// state and repaints the canvas with the theme background so no stale frame
// (or HUD chrome) lingers under the menu
function exitToMenu() {
  G.state = null;
  G.ai = null;
  G.camera = null;
  G.selection = [];
  G.groups = {};
  G.pendingCmds = [];
  G.placement = null;
  G.targeting = null;
  G.attackMoveArmed = false;
  G.inspectId = 0;
  G.paused = false;
  G.endShown = false;
  G.drag = null;
  G.midDrag = null;
  G.resumePause = null;
  G.menuBack = null;
  G.render = null; // drop the old match's terrain/fog canvases
  clearFx(G);
  if (G.minimap) { G.minimap.pings = []; G.minimap.terrain = null; }
  if (G.hud) { G.hud.stateRef = null; G.hud.hintMcv.style.display = 'none'; }
  // v0.3.2: clear any still-fading hint banners so they don't bleed into the
  // next match (the persistent MCV hint is child 0 and is kept).
  const hintRoot = document.getElementById('hint');
  if (hintRoot) {
    while (hintRoot.children.length > 1) hintRoot.removeChild(hintRoot.lastChild);
  }
  const c = G.ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#0c0e12';
  c.fillRect(0, 0, G.canvas.width, G.canvas.height);
  if (G.hudSyncSpeed) G.hudSyncSpeed();
  showMenu(G, (c2) => startMatch(c2));
}

function simStep() {
  const cmds = Sim.aiCommands(G.state, G.ai);
  for (const c of G.pendingCmds) cmds.push(c);
  G.pendingCmds.length = 0;
  Sim.tick(G.state, cmds);
  fxObserveTick(G);
  updateHud(G);
  updateMinimap(G);
  const me = G.state.players[G.playerSlot];
  if (!G.endShown && (G.state.over || me.eliminated)) {
    G.endShown = true;
    const won = G.state.over && G.state.winner === me.team && !me.eliminated;
    sfx(won ? 'victory' : 'defeat');
    showEndBanner(G, {
      won,
      onRestart: () => startMatch(G.lastCfg),
      onMenu: () => exitToMenu(),
    });
  }
}

if (typeof document !== 'undefined' && !globalThis.__MCA_NO_AUTOBOOT) {
  boot().catch((e) => {
    const el = document.getElementById('hint');
    if (el) {
      el.style.display = 'block';
      el.textContent = 'Boot error: ' + (e && e.message || e);
    }
    if (typeof console !== 'undefined') console.error(e);
  });
}
