// Boot + game loop. Renders every animation frame; the sim advances on its
// own fixed 10 Hz schedule via an accumulator (scaled by game speed).
// v0.10.0: multiplayer — lockstep over a dumb WebSocket relay (net/net.js +
// net/lockstep.js). Offline play is untouched: no socket is ever opened and
// every code path below branches on G.net && G.net.active.
import * as Sim from './sim/index.js';
import { createCamera, centerCameraOn, clampCameraToMap, worldToScreen } from './game/camera.js';
import { initInput, handleInputFrame } from './game/input.js';
import { initRenderer, renderFrame } from './game/render.js';
import { initHud, updateHud, showHint, AUTO_DEPLOY_TICKS,
  updateTutorial, abortTutorial } from './game/hud.js';
import { initMinimap, updateMinimap } from './game/minimap.js';
import { showMenu, showPauseMenu, showEndBanner, showBriefing, showLobby,
  showMpSetup, showDesyncOverlay, closeLobbyUi } from './game/menu.js';
import { Net } from './net/net.js';
import { createLockstep, MP_STEP_CAP } from './net/lockstep.js';
// v0.4.4 (DeepSeek 3.1): audio.js ships concurrently; the export will exist,
// but headless harnesses strip imports — every use is typeof-guarded
import { getMusicOn } from './game/audio.js';

const TICK_MS = 100; // 10 ticks/sec
// v0.10.0: a peer gone this many gated ticks (host-observed) -> AI takeover
const DROP_AFTER_MS = 6000;
const TAKEOVER_DELAY_TICKS = 3; // drop -> AI active tick alignment
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
  // artwork is optional (tools/build_art.py -> client/assets/art.json)
  const art = await get('assets/art.json').catch(() => ({}));
  // RA-style sprite pack is optional too (client/assets/unitart.json)
  const unitart = await get('assets/unitart.json').catch(() => ({}));
  return { data, maps, art, unitart };
  // BUILD-INLINE-DATA-END
}

export async function boot() {
  const { data, maps, art, unitart } = await loadData();
  const canvas = document.getElementById('game');
  G = {
    data, maps, canvas, ctx: canvas.getContext('2d'),
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
  G.openMenu = () => {
    if (G.overlay) return; // an overlay is already up — ignore
    if (G.state && !G.state.over && !G.endShown) {
      // live match -> pause overlay (resume restores the pre-overlay pause state)
      G.pausedBeforeMenu = G.paused;
      G.paused = true;
      const mpOn = !!(G.net && G.net.active);
      showPauseMenu(G, {
        onResume: () => {
          G.overlay = null;
          G.paused = G.pausedBeforeMenu;
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
      if (G.state && !G.state.over && Net.isHost) Net.sendDrop(slot);
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
      if (G.tutor) updateTutorial(G); // guided-sandbox step machine (UI-only)
      // v0.7.1: the briefing overlay auto-dismisses at its deadline; while it
      // is up the accumulator stays frozen so the sim can't fast-forward on
      // dismissal (simStep itself also guards on G.briefing)
      if (G.briefing && now >= G.briefing.deadline) G.briefing.dismiss();
      const mp = isMp();
      if (G.state && !G.paused && !G.briefing) {
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
      if (G.state) renderFrame(G);
      if (G.dragMove) drawDragMoveLine(G); // v0.6.0 drag-move order line
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
  }
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
  initRenderer(G);
  updateHud(G);
  updateMinimap(G);
  if (G.tutor) updateTutorial(G); // show the first briefing prompt immediately
  // v0.7.1: faction briefing plate gates the first sim ticks (Rematch/Restart
  // land here too); no-op when the pack or the faction's plate is missing.
  // v0.10.0: never shown in MP — the briefing overlay must not gate the sim
  // while peers are already ticking (peers share no local UI state).
  if (!mp) showBriefing(G, cfg.faction);
}

// clean exit from any match state back to the main menu: drops all match
// state and repaints the canvas with the theme background so no stale frame
// (or HUD chrome) lingers under the menu
function exitToMenu() {
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
}

function simStep() {
  if (G.briefing) return; // v0.7.1: briefing overlay up — sim holds until dismissal
  const cmds = Sim.aiCommands(G.state, G.ai);
  autoDeployMcv(G, cmds);
  for (const c of G.pendingCmds) cmds.push(c);
  G.pendingCmds.length = 0;
  Sim.tick(G.state, cmds);
  updateHud(G, true); // per-tick: heavy scans gated to ~10 Hz real time
  updateMinimap(G);
  const me = G.state.players[G.playerSlot];
  if (!G.endShown && (G.state.over || me.eliminated)) {
    G.endShown = true;
    const won = G.state.over && G.state.winner === me.team && !me.eliminated;
    showEndBanner(G, {
      won,
      onRestart: () => startMatch(G.lastCfg),
      onMenu: () => exitToMenu(),
    });
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

// Host-side: a peer the gate has been waiting on for > DROP_AFTER_MS is
// declared dropped (AI takeover). The 1.5s stall timeout keeps the match
// limping in the meantime.
function hostDropWatch(now) {
  if (!Net.isHost || !G.ls || G.state.over) return;
  if (!G.ls.isWaiting()) { G.mpStallSince = 0; G.mpStallSlots = ''; return; }
  const key = G.ls.waitingOn().join(',');
  if (key !== G.mpStallSlots) {
    G.mpStallSlots = key;
    G.mpStallSince = now;
    return;
  }
  if (!G.mpStallSince || now - G.mpStallSince < DROP_AFTER_MS) return;
  G.mpStallSince = 0;
  for (const slot of G.ls.waitingOn()) {
    if (G.mpDropped[slot] || slot === Net.slot) continue;
    G.mpDropped[slot] = true;
    Net.sendDrop(slot, G.state.tick + TAKEOVER_DELAY_TICKS);
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
