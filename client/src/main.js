// Boot + game loop. Renders every animation frame; the sim advances on its
// own fixed 10 Hz schedule via an accumulator (scaled by game speed).
// v0.10.0: multiplayer — lockstep over a dumb WebSocket relay (net/net.js +
// net/lockstep.js). Offline play is untouched: no socket is ever opened and
// every code path below branches on G.net && G.net.active.
import * as Sim from './sim/index.js';
import { createCamera, centerCameraOn, clampCameraToMap, worldToScreen } from './game/camera.js';
import { initInput, handleInputFrame } from './game/input.js';
import { initRenderer, renderFrame } from './game/render.js';
import { initGl, glFrame, focusGl, setGlVisible, syncLegacyFog,
  glWorldToScreen, glViewQuad, setQuality, getQuality } from './game/gl.js';
import { initCinematics, updateCinematics, startMenuCinematic,
  stopMenuCinematic, playIntro, playOutro, playTitle, skipCinematic,
  cancelCinematics, isCinematicActive } from './game/cinematics.js';
import * as AudioApi from './game/audio.js';
import { initStore } from './game/store.js';
import { initHud, updateHud, showHint, AUTO_DEPLOY_TICKS,
  updateTutorial, abortTutorial } from './game/hud.js';
import { initMinimap, updateMinimap } from './game/minimap.js';
import { dirArtBitmap, unitArtBitmap, structArtBitmap } from './game/sprites.js';
import { showMenu, showPauseMenu, showEndBanner, showBriefing, showLobby,
  showMpSetup, showDesyncOverlay, closeLobbyUi } from './game/menu.js';
import { Net } from './net/net.js';
import { createLockstep, MP_STEP_CAP } from './net/lockstep.js';
// v0.4.4 (DeepSeek 3.1): audio.js ships concurrently; the export will exist,
// but headless harnesses strip imports — every use is typeof-guarded
import { getMusicOn } from './game/audio.js';

const TICK_MS = 100; // 10 ticks/sec
// v0.10.0: a peer gone this many gated ticks (host-observed) -> AI takeover
const DROP_AFTER_MS = 8000;
// a peer that has not sent anything yet this match is still loading its
// battlefield: give it much longer before the host gives up on it
const LOAD_GRACE_MS = 45000;
const TAKEOVER_DELAY_TICKS = 3; // drop -> AI active tick alignment
let G = null;

const GFX_KEY = 'mca.gfx3d';

function installErrorProbe() {
  if (!globalThis.__glErrors) globalThis.__glErrors = [];
  if (globalThis.__mcaErrHooks) return;
  globalThis.__mcaErrHooks = true;
  const push = (msg) => {
    try { globalThis.__glErrors.push(String(msg)); } catch (e) { /* no-op */ }
  };
  if (globalThis.addEventListener) {
    globalThis.addEventListener('error', (e) => {
      const where = e && e.filename ? ' @ ' + e.filename + ':' + e.lineno : '';
      push(String(e && e.message || e) + where);
    });
    globalThis.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      push('unhandled rejection: ' + (r && r.stack ? r.stack : String(r)));
    });
  }
}

// WebGL detection must not trust a stubbed canvas: the smoke/single-file
// harness FakeCtx answers getContext('webgl') too, so require the real
// WebGLRenderingContext constructor as well.
function webglAvailable() {
  try {
    if (typeof globalThis.WebGL2RenderingContext === 'undefined') return false;
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2');
    return !!(gl && typeof gl.getParameter === 'function'
      && typeof gl.createShader === 'function');
  } catch (e) {
    return false;
  }
}

function readGfxPref() {
  let on = true;
  try {
    const v = globalThis.localStorage && globalThis.localStorage.getItem(GFX_KEY);
    if (v === '0' || v === 'false') on = false;
    if (v === '1' || v === 'true') on = true;
  } catch (e) { /* default on */ }
  try {
    const q = globalThis.location && globalThis.location.search;
    if (q) {
      const m = /(?:^|[?&])gfx=(2d|3d)(?:&|$)/.exec(q);
      if (m) on = m[1] === '3d';
    }
  } catch (e) { /* no location in harness */ }
  return on;
}

function saveGfxPref(mode) {
  try {
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(GFX_KEY, mode === '3d' ? '1' : '0');
    }
  } catch (e) { /* private mode */ }
}

function syncGfxUi() {
  if (!G) return;
  const box = document.getElementById('gfx-toggle');
  if (!box) return;
  const cb = document.getElementById('gfx3d');
  const note = document.getElementById('gfx-note');
  const show = !G.state && (G.overlay === 'menu' || G.overlay === 'setup');
  box.style.display = show ? 'flex' : 'none';
  if (cb) {
    cb.checked = G.gfx === '3d';
    cb.disabled = !G.gfxSupported;
  }
  if (note) {
    note.textContent = G.gfxSupported ? '' : 'WebGL unavailable';
  }
}

function syncMenuCinematic() {
  if (!G) return;
  const want = G.gfx === '3d' && G.gfxSupported && !G.state && G.dataReady
    && typeof startMenuCinematic === 'function';
  if (want) {
    if (!G.cinema) { try { initCinematics(G); } catch (e) { /* 2D fallback */ } }
    if (G.cinema && !G.cinema.menuFailed) {
      if (!G.cinema.menu || !G.cinema.menu.active) {
        let ok = false;
        try {
          ok = startMenuCinematic(G);
          if (ok) { wireGfx(); setGlVisible(G, true); }
        } catch (e) {
          ok = false;
          if (globalThis.__glErrors) globalThis.__glErrors.push('attract: ' + (e && e.stack || e));
          if (typeof console !== 'undefined') console.error(e);
        }
        if (!ok) G.cinema.menuFailed = true;
      }
    }
  } else if (typeof stopMenuCinematic === 'function') {
    try { stopMenuCinematic(G); } catch (e) { /* no-op */ }
  }
}

function setGfxMode(mode, fromUser) {
  if (!G) return;
  if (mode === '3d' && !G.gfxSupported) mode = '2d';
  const changed = G.gfx !== mode;
  G.gfx = mode;
  if (document.body && document.body.classList) {
    document.body.classList.toggle('gfx-3d', mode === '3d');
  }
  if (changed && fromUser) saveGfxPref(mode);
  if (mode !== '3d') {
    if (typeof stopMenuCinematic === 'function') {
      try { stopMenuCinematic(G); } catch (e) { /* no-op */ }
    }
  }
  syncMenuCinematic();
  syncGfxUi();
  if (fromUser) {
    if (G.state) {
      showHint(G, 'Graphics setting applies to the next match.');
    } else if (mode === '3d') {
      showHint(G, '3D graphics enabled (WebGL).');
    } else {
      showHint(G, '2D fallback enabled.');
    }
  }
}

function draw3dOverlays(game) {
  const ctx = game.uiCtx;
  if (!ctx) return;
  const dpr = game.dpr || 1;
  const w = game.camera ? game.camera.viewW : (globalThis.innerWidth || 1280);
  const h = game.camera ? game.camera.viewH : (globalThis.innerHeight || 720);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  void w; void h;
  const d = game.drag;
  if (d && !game.placement && !game.targeting && !game.attackMoveArmed) {
    const bx = Math.min(d.x0, d.x1) + 0.5, by = Math.min(d.y0, d.y1) + 0.5;
    const bw = Math.abs(d.x1 - d.x0), bh = Math.abs(d.y1 - d.y0);
    ctx.fillStyle = 'rgba(95,227,208,0.10)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(143,245,228,0.95)';
    ctx.lineWidth = 1.25;
    ctx.strokeRect(bx, by, bw, bh);
  }
  const dm = game.dragMove;
  if (dm) {
    const a = glWorldToScreen(game, dm.ux, dm.uy);
    if (a) {
      ctx.strokeStyle = 'rgba(255,255,255,0.82)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(dm.x1, dm.y1);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

export function getGame() {
  return G;
}

async function loadData() {
  // BUILD-INLINE-DATA-BEGIN (tools/build_singlefile.py replaces this block)
  let done = 0, total = 2;
  const get = (u) => fetch(u).then((r) => {
    if (!r.ok) throw new Error('fetch ' + u + ': ' + r.status);
    return r.json();
  }).then((j) => { done++; bootProgress(done / total, 'LOADING THEATRE DATA'); return j; });
  const data = await get('data/game.json');
  const manifest = await get('maps/manifest.json');
  total = 2 + manifest.maps.length;
  const payloads = await Promise.all(manifest.maps.map((id) => get('maps/' + id + '.json')));
  const maps = {};
  manifest.maps.forEach((id, i) => { maps[id] = payloads[i]; });
  // artwork is optional (tools/build_art.py -> client/assets/art.json)
  const art = await get('assets/art.json').catch(() => ({}));
  // RA-style sprite pack is optional too (client/assets/unitart.json)
  const unitart = await get('assets/unitart.json').catch(() => ({}));
  return { data, maps, art, unitart };
  // BUILD-INLINE-DATA-END
}

// ---- boot screen + battlefield veil ----------------------------------------
function bootScreen() {
  if (typeof document === 'undefined' || !document.body || document.getElementById('boot')) return;
  const b = document.createElement('div');
  b.id = 'boot';
  b.innerHTML = '<div class="boot-logo">MCA</div>'
    + '<div class="boot-sub">MIDDLE EAST COMBAT ARENA</div>'
    + '<div class="boot-bar"><i></i></div>'
    + '<div class="boot-status">INITIALISING</div>'
    + '<button class="boot-start" type="button">ENTER</button>'
    + '<div class="boot-foot">Best with headphones &nbsp;·&nbsp; Runs entirely in your browser</div>';
  document.body.appendChild(b);
  const v = document.createElement('div');
  v.id = 'veil';
  v.innerHTML = '<div class="veil-k">DEPLOYING TO</div><div class="veil-h"></div>'
    + '<div class="veil-s"></div><div class="veil-bar"><i></i></div>';
  document.body.appendChild(v);
}

function bootProgress(frac, label) {
  if (typeof document === 'undefined') return;
  const b = document.getElementById('boot');
  if (!b) return;
  const bar = b.querySelector('.boot-bar i');
  if (bar) bar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, frac)) + ')';
  const st = b.querySelector('.boot-status');
  if (st && label) st.textContent = label;
}

function veil(on, title, sub) {
  if (typeof document === 'undefined') return;
  const v = document.getElementById('veil');
  if (!v) return;
  if (on) {
    v.querySelector('.veil-h').textContent = title || '';
    v.querySelector('.veil-s').textContent = sub || '';
  }
  v.classList.toggle('on', !!on);
}

// ---- renderer <-> audio / camera feel wiring (once per renderer) -------------
const SHOT_SFX = {
  rifle: 'rifle', mg: 'mg', autocannon: 'autocannon', flak: 'aa_gun', cannon: 'cannon',
  howitzer: 'heavy_cannon', naval: 'naval_gun', mlrs: 'mlrs', rockets: 'rocket', bomb: 'bomb',
  bigmissile: 'cruise', atgm: 'atgm', sam: 'sam', sam_small: 'sam', aam: 'sam',
};
const EVENT_SFX = { place: 'place_structure', collapse: 'building_collapse', superweapon_launch: 'cruise', superweapon_hit: 'explosion_huge' };

function wireGfx() {
  const gl = G && G.gl;
  if (!gl || gl._wired) return;
  gl._wired = true;
  let heat = 0;
  const at = (name, x, z, gain) => {
    if (!name || typeof AudioApi.playSfxAt !== 'function') return;
    const dx = x - gl.focus.x, dz = z - gl.focus.z;
    const d = Math.hypot(dx, dz);
    const dist = Math.min(1, d / (gl.dist * 1.7 + 30));
    // pan from the camera's right vector
    const pan = Math.max(-1, Math.min(1, (dx * Math.cos(gl.yaw) - dz * Math.sin(gl.yaw)) / (gl.dist * 0.9 + 10)));
    try { AudioApi.playSfxAt(G, name, pan, dist, (gain || 1) * (gl.attract ? 0.32 : 1)); } catch (e) { /* optional */ }
    heat = Math.min(1.5, heat + (1 - dist) * 0.06);
  };
  gl.audio = {
    shot: (weapon, x, z) => at(SHOT_SFX[weapon], x, z, 1),
    event: (name, x, z) => at(EVENT_SFX[name], x, z, 1),
  };
  gl.onBoom = (x, z, size, water) => at(water ? 'water_splash'
    : size > 5 ? 'explosion_huge' : size > 3 ? 'explosion_large'
      : size > 1.4 ? 'explosion_medium' : 'explosion_small', x, z, 1);
  // combat heat drives the adaptive score
  gl.musicHeat = () => { heat *= 0.985; return Math.min(1, heat); };
  // order feedback: a ping on the ground where the order landed
  const S2 = 2 / Sim.CELL;
  G.onCmd = (cmd) => {
    if (!gl.fx || !gl.state || gl.attract) return;
    let x = cmd.x, y = cmd.y, hostile = false;
    if (cmd.type === 'attackTarget' || cmd.type === 'load' || cmd.type === 'repair') {
      const e = gl.state.units[cmd.targetId] || gl.state.structures[cmd.targetId];
      if (!e) return;
      if (e.fp !== undefined && e.cx !== undefined) { x = (e.cx + e.fp / 2) * Sim.CELL; y = (e.cy + e.fp / 2) * Sim.CELL; }
      else { x = e.x; y = e.y; }
      hostile = cmd.type === 'attackTarget';
    } else if (cmd.type === 'attackMove') hostile = true;
    else if (cmd.type !== 'move' && cmd.type !== 'patrol' && cmd.type !== 'setRally') return;
    if (x === undefined || y === undefined) return;
    const rx = (x / Sim.CELL - gl.mapW / 2) * 2, rz = (y / Sim.CELL - gl.mapH / 2) * 2;
    void S2;
    gl.fx.ping(rx, rz, hostile ? [3.2, 0.7, 0.4] : [0.6, 2.6, 2.3], 1.5);
  };
}

export async function boot() {
  installErrorProbe();
  bootScreen();
  if (document.body && document.body.classList) document.body.classList.add('in-menu');
  const { data, maps, art, unitart } = await loadData();
  bootProgress(1, 'PREPARING BATTLEFIELD');
  const canvas = document.getElementById('game');
  const supports3d = webglAvailable();
  const want3d = readGfxPref();
  G = {
    data, maps, canvas, ctx: canvas.getContext('2d'),
    gfx: (supports3d && want3d) ? '3d' : '2d',
    gfxSupported: supports3d,
    gl: null, uiCanvas: null, uiCtx: null, cinema: null,
    art: art || {}, // menu keyart / setup backdrop / faction posters (data-URIs)
    unitArt: unitart.units || {},     // RA-style unit sprites by defId (data-URIs)
    structArt: unitart.structures || {}, // structure sprites by defId
    fxArt: unitart.effects || {},     // explosion/smoke/muzzle flash frames
    dirArt: unitart.dirs || {},       // 8-frame directional strips {strip,fw,frames}
    wreckArt: unitart.wrecks || {},   // unit husks + structure rubble by defId
    iconArt: unitart.icons || {},     // painted 128px build-bar cameos by defId
    damagedArt: unitart.damaged || {}, // ~50% HP standing states by struct defId
    fxMeta: unitart.fxMeta || {},     // strip frame counts / projectile radii
    idleArt: unitart.idle || {},      // animated idle strips (SH-01 ConYard crane)
    loopArt: unitart.loops || {},     // ambient loops {strip,fw,frames,fps} by key
    briefings: art.briefings || {},   // faction briefing posters (landscape plates)
    tileArt: unitart.tiles || {},     // terrain tiles + decals (sand/rock/water/…)
    thumbArt: art.thumbs || {},       // map thumbnails for the setup screen
    menuVideo: art.menuVideo || null, // menu ambient video loop (painted v5 pack)
    state: null, ai: null, camera: null, playerSlot: 0,
    selection: [], groups: {}, pendingCmds: [],
    placement: null, targeting: null, attackMoveArmed: false,
    patrolArmed: false,
    inspectId: 0,
    speed: 1, paused: false, endShown: false, lastCfg: null,
    overlay: null,            // null | 'menu' | 'setup' | 'pause' | 'lobby'
    briefing: null,           // v0.7.1: {deadline, dismiss} while the match briefing is up
    pausedBeforeMenu: false,  // HUD-pause state to restore after the pause overlay
    resumePause: null,        // Esc hook while the pause overlay is up
    menuBack: null,           // Esc hook on the setup screen
    autoDeployAt: 0,          // last tick the MCV auto-deploy was issued
    // v0.10.0 multiplayer: net is the live Net object (set by Net.init); the
    // rest are per-match MP state, all null/empty in offline play
    net: null, ls: null, mpCfg: null, spectating: false,
    mpDesync: null,           // {tick, mine, theirs, slot} once a desync fired
    mpPendingDrops: [],       // [{slot, at}] AI takeovers scheduled by tick
    mpStallSince: 0, mpStallSlots: '', mpDropped: {},
    mpPauseName: '', chatOpen: false, mpChatLog: [],
    lobby: null,              // host lobby draft {map, seed, delay}
    mouse: { sx: 0, sy: 0, inside: false },
    keys: new Set(),
    drag: null, midDrag: null, dragMove: null,
    tutor: null,          // tutorial step machine (cfg.tutorial), hud.js-driven
    frameErrors: 0, // frames that threw (loop survives; surfaced as a hint)
    dpr: 1,         // devicePixelRatio at last resize (canvas backing-store scale)
    render: null, minimap: null, hud: null,
  };
  G.dataReady = true;
  G.setQuality = (q) => { try { setQuality(G, q); } catch (e) { /* optional */ } };
  G.getQuality = () => getQuality(G);
  G.uiCanvas = document.getElementById('ui-overlay');
  if (G.uiCanvas && G.uiCanvas.getContext) G.uiCtx = G.uiCanvas.getContext('2d');
  if (document.body && document.body.classList) {
    document.body.classList.toggle('gfx-3d', G.gfx === '3d');
  }
  const gfxCb = document.getElementById('gfx3d');
  if (gfxCb && gfxCb.addEventListener) {
    gfxCb.addEventListener('change', () => {
      setGfxMode(gfxCb.checked ? '3d' : '2d', true);
    });
  }
  syncGfxUi();
  if (G.gfx === '3d' && typeof initCinematics === 'function') {
    try { initCinematics(G); } catch (e) { /* cinematics are optional */ }
  }
  G.openMenu = () => {
    if (G.overlay) return; // an overlay is already up — ignore
    if (G.state && !G.state.over && !G.endShown) {
      // live match -> pause overlay (resume restores the pre-overlay pause state)
      const mpOn = !!(G.net && G.net.active);
      G.pausedBeforeMenu = G.paused;
      // Offline the menu pauses the match. Online it must not: one player
      // opening a menu would stall every other player's simulation (the
      // shared pause is the host's Pause button, which tells the room).
      if (!mpOn) G.paused = true;
      showPauseMenu(G, {
        onResume: () => {
          G.overlay = null;
          if (!mpOn) G.paused = G.pausedBeforeMenu;
          if (G.hudSyncSpeed) G.hudSyncSpeed();
        },
        // v0.10.0: an MP match cannot be restarted locally (the peers share
        // it) — menu.js hides the button; abandoning leaves the room too
        onRestart: () => { G.overlay = null; startMatch(G.lastCfg); },
        onAbandon: () => { if (mpOn) leaveMpToMenu(); else exitToMenu(); },
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
    // v0.4.2: without an explicit CSS size the canvas displays at its
    // backing-store size (innerWidth*dpr), so on scaled displays (dpr>1) the
    // whole game rendered dpr-times too large and every click/box-select /
    // rally / placement landed dpr-times away from the cursor.
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    if (G.uiCanvas) {
      G.uiCanvas.width = Math.round(window.innerWidth * dpr);
      G.uiCanvas.height = Math.round(window.innerHeight * dpr);
      G.uiCanvas.style.width = window.innerWidth + 'px';
      G.uiCanvas.style.height = window.innerHeight + 'px';
    }
    if (G.camera) { G.camera.viewW = window.innerWidth; G.camera.viewH = window.innerHeight; }
  };
  window.addEventListener('resize', resize);
  // v0.9.0 leave confirmation: browser Back / close / reload during a LIVE
  // match asks to confirm (the match lives in memory only and would be lost
  // outright). No-op in the menus and after the match is over. Stub-safe:
  // only attaches when a real window + addEventListener exist.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', (e) => {
      if (G && G.state && !G.state.over) {
        if (e && e.preventDefault) e.preventDefault();
        if (e) e.returnValue = '';
      }
    });
  }
  resize();

  // v0.4.4 (DeepSeek 3.1): the HUD Music button renders from game.musicOn —
  // initialize it from audio.js's persisted preference (default off) so the
  // button stops lying about the audio state
  G.musicOn = false;
  try { if (typeof getMusicOn === 'function') G.musicOn = !!getMusicOn(); } catch (e) { /* no-op */ }

  // v0.10.0: multiplayer wiring. Net stays dormant until the MULTIPLAYER
  // menu opens a room; hooks bridge protocol events into the lobby UI and,
  // in-match, into the lockstep scheduler.
  Net.init(G, {
    onError: (reason) => showHint(G, 'Network: ' + reason),
    onLobby: () => { if (G.overlay === 'lobby') showLobby(G); },
    onMembers: () => { if (G.overlay === 'lobby') showLobby(G); },
    onCfg: (cfg) => { G.mpCfg = cfg; if (G.overlay === 'lobby') showLobby(G); },
    onStart: () => beginMpMatch(),
    onPause: (on, from) => {
      if (!G.state || G.state.over) return;
      G.paused = on;
      // a pause silences the whole room; it must not count as anyone's absence
      if (!on && G.ls && G.ls.resume) { G.ls.resume(); G.mpStallSince = 0; G.mpStallSlots = ''; }
      G.mpPauseName = mpNameOf(from);
      if (G.hudSyncSpeed) G.hudSyncSpeed();
      showHint(G, on ? 'Paused by ' + G.mpPauseName : 'Resumed');
    },
    onChat: (from, text) => mpChatLine(mpNameOf(from), text),
    onGameMsg: (m) => {
      if (G.ls) {
        if (m.t === 'needlog' && Net.isHost) {
          Net.sendLog(m.from, G.ls.logSnapshot(m.fromTick || 0, G.state.tick));
          return;
        }
        G.ls.ingest(m);
      }
    },
    onBye: (slot) => {
      if (G.state && !G.state.over && Net.isHost && G.ls && !G.mpDropped[slot]) {
        G.mpDropped[slot] = true;
        Net.sendDrop(slot, G.ls.safeDropTick(slot) + TAKEOVER_DELAY_TICKS);
      }
      if (G.overlay === 'lobby') showLobby(G);
    },
    onHostLeft: () => {
      showHint(G, 'Host left — the room was closed.');
      leaveMpToMenu();
    },
    onClose: () => {
      if (G.state && !G.state.over && !G.mpDesync) {
        showHint(G, 'Connection to relay lost.');
      }
    },
  });

  initInput(G, canvas);
  initHud(G);
  initMinimap(G);
  installMpUi();
  // supporter store / licence keys (inert unless the server enables it)
  try { initStore(G); } catch (e) { /* the game never depends on the store */ }
  syncGfxUi();
  syncMenuCinematic();   // builds the live backdrop battle behind the boot screen

  // First run: a click gate (browsers need a gesture before audio), then the
  // title sequence over the live battle, then the main menu. Automation and
  // ?intro=0 go straight to the menu.
  const bootEl = document.getElementById('boot');
  let q = '';
  try { q = globalThis.location.search || ''; } catch (e) { /* harness */ }
  const automated = !!(globalThis.navigator && globalThis.navigator.webdriver);
  const wantTitle = /[?&]intro=1/.test(q) || (!automated && !/[?&]intro=0/.test(q));
  const openMenu = () => {
    showMenu(G, (cfg) => startMatch(cfg));
    try { if (typeof AudioApi.playMusicTrack === 'function') AudioApi.playMusicTrack(G, 'menu'); } catch (e) { /* optional */ }
  };
  const enter = () => {
    if (G.entered) return;
    G.entered = true;
    try { if (typeof AudioApi.unlockAudio === 'function') AudioApi.unlockAudio(); } catch (e) { /* optional */ }
    if (bootEl) bootEl.classList.add('gone');
    if (wantTitle && G.gfx === '3d' && G.gl && typeof playTitle === 'function') {
      try { playTitle(G, openMenu); } catch (e) { openMenu(); }
    } else openMenu();
  };
  if (bootEl && wantTitle) {
    bootEl.classList.add('ready');
    const btn = bootEl.querySelector('.boot-start');
    if (btn) btn.addEventListener('click', enter);
    window.addEventListener('keydown', function once(e) {
      if (G.entered) { window.removeEventListener('keydown', once, true); return; }
      if (e.key === 'Enter' || e.key === ' ') { window.removeEventListener('keydown', once, true); enter(); }
    }, true);
  } else enter();

  // v0.10.1: prewarm the sprite caches during menu idle so bitmaps decode
  // before the first match instead of janking the deploy click (the caches
  // in sprites.js decode lazily on first draw otherwise). Best-effort, chunked.
  if (typeof requestIdleCallback === 'function') {
    const warmList = [];
    for (const id in G.data.units) warmList.push(['d', id]);
    for (const id in G.data.structures) warmList.push(['s', id]);
    let wi = 0;
    const warmStep = () => {
      const end = Math.min(wi + 20, warmList.length);
      for (; wi < end; wi++) {
        try {
          if (warmList[wi][0] === 'd') {
            dirArtBitmap(G, warmList[wi][1]);
            unitArtBitmap(G, warmList[wi][1]);
          } else {
            structArtBitmap(G, warmList[wi][1]);
          }
        } catch (e) { /* decode is best-effort */ }
      }
      if (wi < warmList.length) requestIdleCallback(warmStep);
    };
    requestIdleCallback(warmStep);
  }

  let last = performance.now();
  let acc = 0;
  const frame = (now) => {
    // probe capture: freeze every layer (renderer + sim + menus) on request
    if (globalThis.__glPaused) {
      requestAnimationFrame(frame);
      return;
    }
    // a bad frame must never kill the loop (v0.3.1: a missing import once
    // bricked rendering mid-match and made every later menu flow look broken)
    try {
      // rAF timestamps can predate `last` after a long synchronous build
      const dt = Math.max(0, Math.min(250, now - last));
      last = now;
      syncMenuCinematic();
      handleInputFrame(G, dt);
      if (G.cinema && typeof updateCinematics === 'function') updateCinematics(G, dt);
      if (G.tutor) updateTutorial(G); // guided-sandbox step machine (UI-only)
      // v0.7.1: the briefing overlay auto-dismisses at its deadline; while it
      // is up the accumulator stays frozen so the sim can't fast-forward on
      // dismissal (simStep itself also guards on G.briefing)
      if (G.briefing && now >= G.briefing.deadline) G.briefing.dismiss();
      const mp = isMp();
      // a freshly started match builds its battlefield one frame after the
      // deployment veil is on screen, so the veil paints before the work
      if (G.worldPending > 0) {
        G.worldPending--;
        if (G.worldPending === 0) buildBattlefield();
        requestAnimationFrame(frame);
        return;
      }
      const cineHold = !!(G.cinema && G.cinema.holdSim);
      if (G.state && !G.paused && !G.briefing && !cineHold) {
        acc += dt * G.speed;
        let steps = 0;
        // v0.10.0: MP raises the per-frame step cap so a peer behind the
        // 10 Hz schedule can catch up once the gate opens; the offline
        // acc-shed stays offline-only
        const cap = mp ? MP_STEP_CAP : 6;
        while (acc >= TICK_MS && !G.state.over && steps < cap) {
          if (mp) {
            if (!mpSimStep()) break; // lockstep gate closed — hold the acc
          } else {
            simStep();
          }
          acc -= TICK_MS;
          steps++;
        }
        if (!mp && steps === 6) acc = 0; // shed backlog instead of death-spiralling
        if (G.state.over) acc = 0;
      }
      if (mp) {
        hostDropWatch(now);                 // host: stalled peer -> AI takeover
        processPendingDrops();
      }
      if (G.net && G.net.active) Net.netTick(); // peer RTT probes (lobby + match)
      if (G.state || G.attract) {
        if (G.gfx === '3d' && G.gl && typeof glFrame === 'function') {
          if (G.gl.musicHeat && typeof AudioApi.setMusicIntensity === 'function' && G.state) {
            try { AudioApi.setMusicIntensity(G.gl.musicHeat()); } catch (e) { /* optional */ }
          }
          glFrame(G, dt);
          if (G.state) {
            draw3dOverlays(G);
            // the minimap draws the camera's true ground footprint
            G.minimapView = glViewQuad(G);
          }
        } else if (G.state) {
          renderFrame(G);
          if (G.dragMove) drawDragMoveLine(G); // 2D drag-move order line
        }
      }
      syncGfxUi();
    } catch (err) {
      G.frameErrors++;
      if (globalThis.__glErrors) globalThis.__glErrors.push(String(err && err.stack || err));
      if (typeof console !== 'undefined') console.error(err);
      if (G.frameErrors === 1) {
        showHint(G, 'Render/sim error — ' + (err && err.message || err));
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// v0.6.0 drag-move order line: input.js owns the drag state (game.dragMove);
// drawn here after renderFrame so render.js stays untouched. Patrol-line
// style: thin, white, dashed — from the pressed unit to the cursor.
const DRAG_LINE_MIN = 6; // mirrors DRAG_MIN in input.js
function drawDragMoveLine(G) {
  const dm = G.dragMove;
  if (!dm || !G.camera || !G.ctx) return;
  const dist = Math.max(Math.abs(dm.x1 - dm.x0), Math.abs(dm.y1 - dm.y0));
  if (dist < DRAG_LINE_MIN) return;
  const a = worldToScreen(G.camera, dm.ux, dm.uy);
  const c = G.ctx;
  const dpr = G.dpr || 1;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.strokeStyle = 'rgba(255,255,255,0.8)';
  c.lineWidth = 1.5;
  c.setLineDash([6, 4]);
  c.beginPath();
  c.moveTo(a.x, a.y);
  c.lineTo(dm.x1, dm.y1);
  c.stroke();
  c.setLineDash([]);
}

export function startMatch(cfg) {
  G.lastCfg = cfg;
  const menuRoot = typeof document !== 'undefined' ? document.getElementById('menu') : null;
  if (menuRoot && menuRoot.classList) menuRoot.classList.add('hidden');
  const bannerRoot = typeof document !== 'undefined' ? document.getElementById('banner') : null;
  if (bannerRoot && bannerRoot.classList) bannerRoot.classList.add('hidden');
  if (document.body && document.body.classList) document.body.classList.remove('in-menu');
  if (G.briefing && G.briefing.dismiss) G.briefing.dismiss(); // stale overlay
  G.briefing = null;
  const map = G.maps[cfg.map];
  // v0.10.0: an MP cfg carries the explicit players array from the host's
  // lobby (human slots, no ai field) plus this peer's slot and the seed —
  // identical on every peer. Offline keeps the skirmish builder below.
  const mp = !!cfg.mp;
  let players;
  let slot = 0;
  if (mp) {
    players = cfg.players;
    slot = cfg.slot || 0;
  } else {
    players = [{ slot: 0, faction: cfg.faction, team: 0 }];
    slot = 1;
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
    slot = 0;
  }
  const seed = (cfg.seed !== undefined ? cfg.seed : (Date.now() & 0x7fffffff)) >>> 0;
  G.playerSlot = slot;
  G.state = Sim.createMatch({ data: G.data, map, players, seed });
  G.ai = Sim.createAI(players, seed);
  G.mpPendingDrops = [];
  G.mpDesync = null;
  G.spectating = false;
  G.mpPauseName = '';
  G.ls = null;
  if (mp) {
    // the lockstep scheduler: human commands are stamped localTick+delay and
    // the gate waits for every human slot (or the 1.5s stall timeout); AI
    // slots run the seeded AI locally on every peer (deterministic — the
    // brain state lives in G.ai and is a pure function of the shared sim)
    G.ls = createLockstep({
      state: G.state,
      ai: G.ai,
      playerSlot: G.playerSlot,
      humanSlots: players.map((p) => p.slot),
      delay: cfg.delay || 2,
      send: (m) => Net.sendGame(m),
      now: () => (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now(),
      onDesync: (info) => onMpDesync(info),
      onPeerDrop: (m) => {
        // The host gave up waiting for THIS player (frozen or unreachable for
        // too long): an AI now commands those forces on every other peer, so
        // this client can no longer take part in the shared simulation.
        if (m.slot === G.playerSlot) {
          showHint(G, 'You were out of contact for too long — an AI commander has taken over your forces.');
          setTimeout(() => { if (G.ls) leaveMpToMenu(); }, 0);
          return;
        }
        G.mpPendingDrops.push({
          slot: m.slot,
          at: m.at !== undefined ? m.at : G.state.tick + TAKEOVER_DELAY_TICKS,
        });
      },
      extraCmds: (st) => {
        const cmds = [];
        autoDeployMcv(G, cmds); // reads G.state/G.playerSlot; counter is per-match
        return cmds;
      },
    });
    startBgPump();
  } else stopBgPump();
  G.camera = createCamera(G.canvas.width / (G.dpr || 1), G.canvas.height / (G.dpr || 1));
  // v0.10.0: the camera centers on THIS player's spawn (slot from the lobby in
  // MP; offline playerSlot is 0 so behavior is unchanged)
  const sp = map.spawns[G.playerSlot % map.spawns.length];
  centerCameraOn(G.camera, sp.x * Sim.CELL + Sim.CELL / 2, sp.y * Sim.CELL + Sim.CELL / 2);
  clampCameraToMap(G.camera, map.w * Sim.CELL, map.h * Sim.CELL);
  // v0.3.5: start with the MCV selected (the camera already centers the spawn)
  G.selection = [];
  for (const id in G.state.units) {
    const u = G.state.units[id];
    if (u.owner === G.playerSlot && u.defId === 'MCV') { G.selection = [u.id]; break; }
  }
  G.groups = {};
  G.pendingCmds = [];
  G.placement = null;
  G.targeting = null;
  G.attackMoveArmed = false;
  G.patrolArmed = false;
  G.dragMove = null; // v0.6.0 drag-move state (armed in input.js)
  G.fx = null; // v0.7.0: drop last match's render FX (wrecks/explosions/tracers)
  G.inspectId = 0;
  G.paused = false;
  G.endShown = false;
  G.overlay = null;
  G.resumePause = null;
  G.menuBack = null;
  G.frameErrors = 0;
  G.autoDeployAt = 0;
  // tutorial mode (v0.4.4): arm the step machine when the cfg asks for it;
  // lastCfg carries the flag, so a same-cfg restart keeps the tutorial on
  G.tutor = null;
  abortTutorial(G); // close any leftover overlay + reset the render signature
  if (cfg.tutorial) G.tutor = { step: 0, pulseEl: null };
  // minimap caches are per-match too: force a terrain re-render and drop pings
  if (G.minimap) { G.minimap.pings = []; G.minimap.terrain = null; }
  if (document.body) document.body.classList.remove('in-menu');
  if (G.hudSyncSpeed) G.hudSyncSpeed();
  if (typeof cancelCinematics === 'function' && G.cinema) {
    try { cancelCinematics(G); } catch (e) { /* optional */ }
  }
  if (typeof stopMenuCinematic === 'function') {
    try { stopMenuCinematic(G); } catch (e) { /* optional */ }
  }
  if (G.gl && typeof setGlVisible === 'function') setGlVisible(G, false);
  // 2D fallback renderer is always built: the minimap consumes its fog canvas,
  // and it must be ready if 3D initialization fails on this machine.
  initRenderer(G);
  updateHud(G);
  updateMinimap(G);
  if (G.tutor) updateTutorial(G); // show the first briefing prompt immediately

  const use3d = G.gfx === '3d' && G.gfxSupported;
  if (use3d) {
    // the battlefield is built by the frame loop right after the veil paints
    veil(true, map.name || cfg.map, map.briefing || map.tagline || '');
    G.worldPending = 2;
    G.pendingIntro = { cfg, players, mp };
  } else {
    G.worldPending = 0;
    if (G.uiCanvas) G.uiCanvas.style.display = 'none';
    if (G.gl && typeof setGlVisible === 'function') setGlVisible(G, false);
    if (!mp) showBriefing(G, cfg.faction);
  }
  syncGfxUi();
}

function buildBattlefield() {
  const pend = G.pendingIntro || {};
  G.pendingIntro = null;
  if (!G.state) { veil(false); return; }
  const map = G.state.map;
  let ok = true;
  try {
    initGl(G, { state: G.state, localSlot: G.playerSlot, reveal: false });
    wireGfx();
    G.gl.attract = false;
    G.gl.camLock = false;
    G.gl.lookLift = 0;
    setGlVisible(G, true);
    G.gl.wasdPan = false; // A/S/D are game orders, not camera pan
    if (G.uiCanvas) G.uiCanvas.style.display = 'block';
    if (G.gl.canvas && !G._input3dBound) {
      initInput(G, G.gl.canvas);
      G._input3dBound = true;
    }
    const spw = map.spawns[G.playerSlot % map.spawns.length];
    focusGl(G, spw.x * Sim.CELL + Sim.CELL / 2, spw.y * Sim.CELL + Sim.CELL / 2, 50, 0.62, 0.78);
    if (G.gl.proxy) G.gl.proxy.ready = false;
    if (G.gl.portraits) G.gl.portraits.requestAll(G.state, G.playerSlot);
    if (G.gl.ents && G.gl.ents.prewarm) G.gl.ents.prewarm(G.state);
    // Render one frame now, behind the veil: this is where the GPU compiles
    // every shader, and it must happen before this peer starts talking in a
    // multiplayer match (a silent peer makes everyone wait).
    try { glFrame(G, 16); } catch (e) { /* the frame loop reports real errors */ }
    if (document.body && document.body.classList) document.body.classList.add('gfx-3d');
  } catch (err) {
    ok = false;
    G.gfx = '2d';
    if (globalThis.__glErrors) globalThis.__glErrors.push('initGl: ' + (err && err.stack || err));
    if (typeof console !== 'undefined') console.error(err);
    if (G.uiCanvas) G.uiCanvas.style.display = 'none';
    if (G.gl && typeof setGlVisible === 'function') setGlVisible(G, false);
    if (document.body && document.body.classList) document.body.classList.remove('gfx-3d');
    showHint(G, '3D unavailable — using the 2D renderer.');
    if (!pend.mp) showBriefing(G, pend.cfg && pend.cfg.faction);
  }
  veil(false);
  if (ok && !pend.mp && pend.cfg && !pend.cfg.tutorial && typeof playIntro === 'function') {
    const me = G.state.players[G.playerSlot];
    const mine = me ? me.faction : (pend.cfg.faction || 'MCA');
    const myTeam = me ? me.team : 0;
    const foes = [];
    for (const p of G.state.players) {
      if (!p || p.team === myTeam) continue;
      if (p.faction && foes.indexOf(p.faction) < 0) foes.push(p.faction);
    }
    try {
      playIntro(G, {
        faction: mine,
        mapName: map.name || pend.cfg.map,
        vs: foes.length ? mine + '  vs  ' + foes.join(' / ') : '',
      }, null);
    } catch (e) { /* intro is optional */ }
  }
  syncGfxUi();
}

// clean exit from any match state back to the main menu: drops all match
// state and repaints the canvas with the theme background so no stale frame
// (or HUD chrome) lingers under the menu
function exitToMenu() {
  if (typeof cancelCinematics === 'function' && G.cinema) {
    try { cancelCinematics(G); } catch (e) { /* optional */ }
  }
  if (typeof stopMenuCinematic === 'function') {
    try { stopMenuCinematic(G); } catch (e) { /* optional */ }
  }
  if (G.uiCtx && G.uiCanvas) G.uiCtx.clearRect(0, 0, G.uiCanvas.width, G.uiCanvas.height);
  G.worldPending = 0;
  G.pendingIntro = null;
  veil(false);
  if (G.briefing && G.briefing.dismiss) G.briefing.dismiss();
  G.briefing = null;
  // v0.10.0: leaving to the menu ends any MP session (room leave is a no-op
  // when offline — Net stays dormant)
  if (Net.active) Net.leave();
  G.ls = null;
  G.mpCfg = null;
  G.spectating = false;
  G.mpPendingDrops = [];
  G.mpDesync = null;
  G.mpPauseName = '';
  closeChat();
  G.state = null;
  G.ai = null;
  G.camera = null;
  G.selection = [];
  G.groups = {};
  G.pendingCmds = [];
  G.placement = null;
  G.targeting = null;
  G.attackMoveArmed = false;
  G.patrolArmed = false;
  G.inspectId = 0;
  G.paused = false;
  G.endShown = false;
  G.drag = null;
  G.midDrag = null;
  G.dragMove = null;
  abortTutorial(G); // close the tutorial overlay without marking it seen
  G.resumePause = null;
  G.menuBack = null;
  G.render = null; // drop the old match's terrain/fog canvases
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
  try { if (typeof AudioApi.playMusicTrack === 'function') AudioApi.playMusicTrack(G, 'menu'); } catch (e) { /* optional */ }
  syncGfxUi();
  syncMenuCinematic();
}

function simStep() {
  if (G.briefing) return; // v0.7.1: briefing overlay up — sim holds until dismissal
  const cmds = Sim.aiCommands(G.state, G.ai);
  autoDeployMcv(G, cmds);
  for (const c of G.pendingCmds) cmds.push(c);
  G.pendingCmds.length = 0;
  Sim.tick(G.state, cmds);
  if (G.gfx === '3d' && G.gl && typeof syncLegacyFog === 'function') syncLegacyFog(G);
  updateHud(G, true); // per-tick: heavy scans gated to ~10 Hz real time
  updateMinimap(G);
  const me = G.state.players[G.playerSlot];
  if (!G.endShown && (G.state.over || me.eliminated)) {
    G.endShown = true;
    const won = G.state.over && G.state.winner === me.team && !me.eliminated;
    const banner = () => showEndBanner(G, {
      won,
      onRestart: () => startMatch(G.lastCfg),
      onMenu: () => exitToMenu(),
    });
    if (G.gfx === '3d' && G.gl && typeof playOutro === 'function') {
      const mapName = (G.state.map && G.state.map.name) || (G.lastCfg && G.lastCfg.map) || '';
      try {
        playOutro(G, { won, faction: me.faction, mapName }, banner);
      } catch (e) {
        banner();
      }
    } else {
      banner();
    }
  }
}

const AUTO_DEPLOY_RETRY = 50; // ticks between retries when the spot was blocked

// v0.3.5: human auto-deploy — if the local player's MCV is still parked
// AUTO_DEPLOY_TICKS (20s) into the match, issue deployMCV through the normal
// command path (validateCommand/applyCommand + spiral search), exactly like
// the AI does in ai.js. Humans only: the AI deploys itself on tick 0.
// Tick-based, so pausing the game pauses the countdown too.
function autoDeployMcv(game, cmds) {
  const st = game.state;
  if (st.over || st.tick < AUTO_DEPLOY_TICKS) return;
  if (st.tick - game.autoDeployAt < AUTO_DEPLOY_RETRY) return;
  const me = st.players[game.playerSlot];
  if (!me || me.ai || me.eliminated) return;
  let mcv = null;
  for (const id in st.units) {
    const u = st.units[id];
    if (u.owner === me.slot && u.defId === 'MCV') { mcv = u; break; }
  }
  if (!mcv) return;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner === me.slot && s.defId === 'SH-01') return; // CY up: MCV stays a unit
  }
  game.autoDeployAt = st.tick;
  cmds.push({ player: me.slot, type: 'deployMCV', unitId: mcv.id });
}

// ---- multiplayer (v0.10.0) ----------------------------------------------------
// Lockstep over the dumb relay: the scheduler (net/lockstep.js) gates each
// tick on every human slot's commands-or-stall; AI slots run the seeded AI
// locally on every peer. Offline code never touches any of this (isMp() is
// the single guard).

function isMp() {
  return !!(G.net && G.net.active && G.ls && G.state);
}

function mpNameOf(slot) {
  if (slot === G.playerSlot) return Net.name || ('P' + (slot + 1));
  const p = Net.peers[slot];
  return (p && p.name) || ('P' + (slot + 1));
}

// One lockstep tick, driven by the frame loop's accumulator. Returns false
// when the gate is closed (accumulator holds, no tick consumed).
function mpSimStep() {
  if (!G.ls) return false;
  // local player input -> stamped (localTick + delay) and broadcast; the
  // command is applied when the gate for its tick opens, never before.
  // Spectators and desynced matches push nothing.
  if (G.pendingCmds.length) {
    if (!G.spectating && !G.mpDesync) {
      for (const c of G.pendingCmds) {
        if (c.player === undefined) c.player = G.playerSlot;
        G.ls.issue(c);
      }
    }
    G.pendingCmds.length = 0;
  }
  const advanced = G.ls.advance();
  if (!advanced) return false;
  updateHud(G, true); // per-tick: heavy scans gated to ~10 Hz real time
  updateMinimap(G);
  const me = G.state.players[G.playerSlot];
  // defeat -> spectator (camera/minimap stay live, no command push) instead
  // of the end banner; the banner waits for the actual match end
  if (!G.endShown && me.eliminated && !G.spectating && !G.state.over) {
    G.spectating = true;
    G.selection = [];
    showHint(G, 'You are out — spectating until the match ends.');
    if (G.hudSyncSpeed) G.hudSyncSpeed();
  }
  if (!G.endShown && G.state.over) {
    G.endShown = true;
    const won = G.state.winner === me.team && !me.eliminated;
    showEndBanner(G, {
      won,
      onRestart: () => leaveMpToMenu(),
      onMenu: () => leaveMpToMenu(),
    });
  }
  return true;
}

// Background pump: browsers stop requestAnimationFrame in a hidden tab,
// which would freeze this player's simulation and, in lockstep, everyone
// else's with it. A tiny worker keeps ticking while the tab is hidden so a
// player who alt-tabs neither stalls the room nor gets dropped.
let bgWorker = null;
let bgLast = 0, bgAcc = 0;
function mpBackgroundPump() {
  if (!G || typeof document === 'undefined' || !document.hidden || !isMp()) return;
  if (G.paused || G.worldPending > 0 || !G.state || G.state.over) return;
  const now = performance.now();
  if (!bgLast || now - bgLast > 1000) bgLast = now - TICK_MS;
  bgAcc += now - bgLast;
  bgLast = now;
  let steps = 0;
  while (bgAcc >= TICK_MS && !G.state.over && steps < MP_STEP_CAP) {
    if (!mpSimStep()) break;
    bgAcc -= TICK_MS;
    steps++;
  }
  if (bgAcc > TICK_MS * MP_STEP_CAP) bgAcc = TICK_MS;
  hostDropWatch(now);
  processPendingDrops();
  if (G.net && G.net.active) Net.netTick();
}
function startBgPump() {
  if (bgWorker || typeof Worker === 'undefined' || typeof Blob === 'undefined') return;
  try {
    const src = 'setInterval(function(){postMessage(0)},100);';
    bgWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    bgWorker.onmessage = () => { try { mpBackgroundPump(); } catch (e) { /* never break the page */ } };
    bgLast = 0; bgAcc = 0;
  } catch (e) { bgWorker = null; }
}
function stopBgPump() {
  if (bgWorker) { try { bgWorker.terminate(); } catch (e) { /* no-op */ } bgWorker = null; }
}

// Host-side: a peer the gate has been waiting on for > DROP_AFTER_MS is
// declared dropped (AI takeover). Until then the match waits for it.
function hostDropWatch(now) {
  // nobody ticks while the room is paused (or while this peer's own intro
  // or load holds its sim): silence then says nothing about a peer's health
  if (G.paused || G.worldPending > 0 || (G.cinema && G.cinema.holdSim)) {
    G.mpStallSince = 0; G.mpStallSlots = ''; G.mpWaitNote = null;
    return;
  }
  // everyone else: say who the room is waiting for (once per wait)
  if (G.ls && !G.state.over && G.ls.isWaiting()) {
    const key = G.ls.waitingOn().join(',');
    if (!G.mpWaitNote || G.mpWaitNote.key !== key) G.mpWaitNote = { key, since: now, told: false };
    else if (!G.mpWaitNote.told && now - G.mpWaitNote.since > 2000) {
      G.mpWaitNote.told = true;
      showHint(G, 'Waiting for ' + G.ls.waitingOn().map(mpNameOf).join(', ') + '…');
    }
  } else G.mpWaitNote = null;
  if (!Net.isHost || !G.ls || G.state.over) return;
  if (!G.ls.isWaiting()) { G.mpStallSince = 0; G.mpStallSlots = ''; return; }
  const key = G.ls.waitingOn().join(',');
  if (key !== G.mpStallSlots || !G.mpStallSince) {
    G.mpStallSlots = key;
    G.mpStallSince = now;
    return;
  }
  // Drop on SILENCE, not on waiting: a slow peer that keeps answering is
  // merely slow (the room runs at its pace); one that has said nothing for
  // DROP_AFTER_MS is gone. A peer never heard from is still loading.
  const heard = G.ls.debugState().lastHeard;
  const clock = (typeof performance !== 'undefined' && performance.now) ? performance.now() : now;
  for (const slot of G.ls.waitingOn()) {
    if (G.mpDropped[slot] || slot === Net.slot) continue;
    const silentFor = heard[slot] === undefined ? -1 : clock - heard[slot];
    const loading = heard[slot] === undefined && now - G.mpStallSince < LOAD_GRACE_MS;
    if (loading || (silentFor >= 0 && silentFor < DROP_AFTER_MS)) continue;
    G.mpDropped[slot] = true;
    Net.sendDrop(slot, G.ls.safeDropTick(slot) + TAKEOVER_DELAY_TICKS);
    showHint(G, mpNameOf(slot) + ' dropped — AI is taking over.');
  }
}

// A declared drop installs a takeover brain for that slot. Installation is
// not itself sim-affecting: the brain's first think is an absolute tick
// (at + interval), so every peer emits the takeover AI's first command on
// the same tick regardless of when the drop message arrived.
function processPendingDrops() {
  if (!G.mpPendingDrops.length || !G.state) return;
  const remaining = [];
  for (const d of G.mpPendingDrops) {
    if (G.state.tick < d.at) { remaining.push(d); continue; }
    const p = G.state.players[d.slot];
    if (p && !p.aiTakeover) {
      p.aiTakeover = true;
      p.ai = { personality: 'Front', difficulty: 'veteran' };
      const brain = Sim.makeBrain({
        slot: d.slot, faction: p.faction, team: p.team,
        ai: p.ai,
      }, G.state.seed, d.slot);
      brain.nextThink = d.at + brain.interval; // absolute, aligned everywhere
      G.ai.brains.push(brain);
    }
  }
  G.mpPendingDrops = remaining;
}

function onMpDesync(info) {
  G.mpDesync = info;
  if (typeof console !== 'undefined') {
    console.error('DESYNC at tick ' + info.tick + ': mine=0x'
      + (info.mine >>> 0).toString(16) + ' theirs(slot ' + info.slot + ')=0x'
      + (info.theirs >>> 0).toString(16));
  }
  showDesyncOverlay(G, {
    onMenu: () => leaveMpToMenu(),
  });
}

function mpChatLine(name, text) {
  G.mpChatLog.push({ name, text });
  if (G.mpChatLog.length > 50) G.mpChatLog.shift();
  if (typeof document === 'undefined' || !document.getElementById) return;
  // lobby log has priority when the lobby is up; otherwise the in-match
  // chat overlay log gets the line
  const log = document.getElementById('mp-chatlog') || document.getElementById('chatlog');
  if (log && log.appendChild) appendChatLine(log, name, text);
  else if (G.overlay === 'lobby') showLobby(G); // lobby renders its own log
}

function appendChatLine(logEl, name, text) {
  const div = document.createElement('div');
  div.className = 'mp-chatline';
  div.textContent = name + ': ' + text;
  logEl.appendChild(div);
  while (logEl.children.length > 50) logEl.removeChild(logEl.firstChild);
}

// 'start' from the host: every peer builds the identical match from the
// host's cfg; the lockstep gate absorbs any load-time skew.
function beginMpMatch() {
  const cfg = Net.cfg;
  if (!cfg) return;
  closeLobbyUi(G);
  startMatch({
    mp: true, map: cfg.map, seed: cfg.seed, players: cfg.players,
    delay: cfg.delay || 2, slot: Net.slot,
  });
}

function leaveMpToMenu() {
  stopBgPump();
  Net.leave();
  G.ls = null;
  G.mpCfg = null;
  G.spectating = false;
  G.mpPendingDrops = [];
  G.mpDropped = {};
  G.mpStallSince = 0;
  G.mpStallSlots = '';
  G.mpDesync = null;
  if (typeof document !== 'undefined' && document.getElementById) {
    const b = document.getElementById('banner');
    if (b && b.classList) b.classList.add('hidden');
  }
  exitToMenu();
}

// in-match chat overlay (Enter opens it; the input owns the keyboard while
// it is open — input.js routes around it via game.chatOpen)
function openChat() {
  if (!isMp() || G.chatOpen || G.spectating) return;
  const root = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('chat-overlay') : null;
  if (!root) return;
  G.chatOpen = true;
  root.classList.remove('hidden');
  const input = document.getElementById('chatbar');
  if (input && input.focus) { try { input.focus(); } catch (e) { /* no-op */ } }
}

function closeChat() {
  G.chatOpen = false;
  const root = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('chat-overlay') : null;
  if (!root) return;
  root.classList.add('hidden');
  const input = document.getElementById('chatbar');
  if (input) input.value = '';
}

function submitChat() {
  const input = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('chatbar') : null;
  const text = input ? String(input.value || '').trim() : '';
  if (text) Net.sendChat(text);
  closeChat();
}

// lobby/menu entry points (wired onto G for menu.js; the smoke harness can
// stub them together with a fake G.net)
function installMpUi() {
  G.openChat = openChat;
  G.closeChat = closeChat;
  G.openMpSetup = () => showMpSetup(G, (c) => startMatch(c));
  G.mpHost = async (opts) => {
    Net.name = opts.name;
    const r = await Net.host(opts);
    if (!r.ok) return r;
    Net.my.faction = opts.faction || 'Egypt';
    G.lobby = { map: opts.map, seed: opts.seed, delay: 2 };
    Net.broadcastLobby();
    return r;
  };
  G.mpJoin = async (opts) => {
    Net.name = opts.name;
    const r = await Net.join(opts.url, opts.code, opts.name);
    if (!r.ok) return r;
    Net.my.faction = opts.faction || 'Egypt';
    Net.sendSlot();
    return r;
  };
  G.mpLeaveLobby = () => {
    Net.leave();
    G.lobby = null;
    G.overlay = null;
    showMenu(G, (c) => startMatch(c));
  };
  G.mpSetSlot = (patch) => {
    Object.assign(Net.my, patch);
    Net.sendSlot();
    if (Net.isHost) Net.broadcastLobby();
  };
  G.mpSetLobby = (patch) => {
    if (!G.lobby) G.lobby = { map: Object.keys(G.maps)[0], seed: 1, delay: 2 };
    Object.assign(G.lobby, patch);
    if (Net.isHost) {
      Net.broadcastLobby();
      // keep the guests' read-only map/seed/delay view in sync pre-start
      Net.sendCfg({ map: G.lobby.map, seed: G.lobby.seed >>> 0, delay: G.lobby.delay });
    }
  };
  G.mpStart = () => {
    if (!Net.isHost || !G.lobby) return;
    const slots = Net.lobbySlots();
    const players = slots.map((s) => ({ slot: s.slot, faction: s.faction, team: s.team }));
    const cfg = { map: G.lobby.map, seed: G.lobby.seed >>> 0, delay: G.lobby.delay, players };
    Net.sendCfg(cfg);
    Net.sendStart();
    beginMpMatch(); // the relay does not echo to the sender — the host starts itself
  };
  G.mpSendChat = (text) => {
    if (text) Net.sendChat(text);
  };
  // the in-match chat overlay owns its keyboard while open
  const chatbar = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('chatbar') : null;
  if (chatbar && chatbar.addEventListener) {
    chatbar.addEventListener('keydown', (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      if (!e) return;
      if (e.key === 'Enter' || e.code === 'Enter') submitChat();
      else if (e.key === 'Escape' || e.code === 'Escape') closeChat();
    });
  }
}

// v0.11.0 probe/debug surface. The headless probe boots the real game and
// calls startMatch directly; everything here is render/UI only.
if (typeof globalThis !== 'undefined') {
  // The inline 2D harness rewrites `Sim.` call sites and does not provide a
  // namespace object; keep the probe surface null there instead of throwing.
  const SimNS = (typeof Sim !== 'undefined') ? Sim : null;
  globalThis.__mca = {
    boot,
    getGame,
    startMatch,
    Sim: SimNS,
    focus: (game, wx, wy, dist, yaw, pitch) =>
      (typeof focusGl === 'function' ? focusGl(game, wx, wy, dist, yaw, pitch) : null),
    skipCinematic: (game) => {
      if (typeof skipCinematic === 'function') skipCinematic(game || getGame());
    },
    setGfx: (mode) => setGfxMode(mode, true),
    gfx: () => (G ? G.gfx : null),
  };
}

if (typeof document !== 'undefined' && !globalThis.__MCA_NO_AUTOBOOT) {
  boot().catch((e) => {
    installErrorProbe();
    if (globalThis.__glErrors) globalThis.__glErrors.push('boot: ' + (e && e.stack || e));
    const el = document.getElementById('hint');
    if (el) {
      el.style.display = 'block';
      el.textContent = 'Boot error: ' + (e && e.message || e);
    }
    if (typeof console !== 'undefined') console.error(e);
  });
}
