// Modern flat HUD: slim top bar (credits / power / clock / speed / menu),
// SC2-style bottom-center build bar (icon grid, hotkeys Q W E R T F,
// tooltips, queue badges, production sweep), bottom-left minimap + selection
// panel, fading hint banners top-center.
//
// The button enable/disable logic stays pure (trainButtonState /
// structureButtonState / buildGridItems / hotkeyMapFor / tooltipLines) so it
// can be exercised headlessly. DOM grids rebuild only when a signature of
// their meaningful state changes; per-tick updates touch style/text only.
import {
  CELL, validateCommand, requiredProducer, trainCost, buildCost,
  standingStructs, structCenter, ABILITY_STRUCT,
  mapHasWater, isHostile, isInfantryCls, CAPTURE_TICKS,
} from '../sim/index.js';
import { screenToWorld, centerCameraOn, clampCameraToMap, zoomCameraAt } from './camera.js';
import { shapeForUnit, shapeForStructure, initialsFor, factionColorOf } from './sprites.js';
import { addPing } from './minimap.js';
import {
  initAudio, unlockAudio, playSfx, playMusicTrack, setMusicOn, playVoice,
  resetAudioThrottles,
} from './audio.js';
// keep unlockAudio reachable through this module for existing callers
export { unlockAudio } from './audio.js';

const TABS = [
  { id: 'structures', label: 'Structures', prod: null },   // needs ConYard (SH-01)
  { id: 'infantry', label: 'Infantry', prod: 'SH-04' },
  { id: 'vehicles', label: 'Vehicles', prod: 'SH-05' },
  { id: 'air', label: 'Air', prod: 'SH-06' },
  { id: 'naval', label: 'Naval', prod: 'SH-07' },
];
const PASSIVE_ABILITIES = ['edge_network', 'integrated_sky', 'siha_mesh', 'iron_layer'];
// grid hotkeys; A/S/D stay reserved as order hotkeys, G cycles unit stance
// (v0.3.6 — G left the build grid when it became the stance key)
export const BUILD_HOTKEYS = ['Q', 'W', 'E', 'R', 'T', 'F'];
const PRODUCER_TAB = { 'SH-04': 'infantry', 'SH-05': 'vehicles', 'SH-06': 'air', 'SH-07': 'naval' };
// v0.3.5: the MCV auto-deploys (human players) this many ticks into a match
export const AUTO_DEPLOY_TICKS = 200; // 20s at 10 ticks/sec
// v0.3.6 unit stances (sim stores the int on the unit)
export const STANCE_NAMES = ['Aggressive', 'Defensive', 'Hold ground', 'Hold fire'];

// heavy entity scans run at most every ~90ms real time (see updateHud) —
// 120 Hz displays tick at ~99.96ms at 1x, so 90 keeps 1x ungated
const HEAVY_SCAN_MS = 90;

// ---- pure logic (unit-tested headlessly) ------------------------------------

export function trainButtonState(state, player, unitDefId) {
  const v = validateCommand(state, { player: player.slot, type: 'trainUnit', unitId: unitDefId });
  if (v.ok) return { enabled: true, reason: '' };
  return { enabled: false, reason: v.reason };
}

export function structureButtonState(state, player, structDefId) {
  // naval yard is pointless on a map without any water
  if (structDefId === 'SH-07' && !mapHasWater(state)) {
    return { enabled: false, reason: 'no-water' };
  }
  const v = validateCommand(state, { player: player.slot, type: 'buildStructure', structId: structDefId });
  if (v.ok) return { enabled: true, reason: '' };
  return { enabled: false, reason: v.reason };
}

// tabs available from standing structures
export function tabsFor(state, slot) {
  const has = (structId) => Object.values(state.structures)
    .some((s) => s.owner === slot && s.defId === structId);
  return TABS.filter((t) => (t.id === 'structures' ? has('SH-01') : has(t.prod)));
}

// items shown in a build-bar tab, in grid order
// v0.4.1 Structures-tab ordering: economy + production + base defenses lead
// (the SH-09/10/11 towers sat on page 2 behind Airfield/Naval/Tech and
// players never found them). Unlisted defs keep sheet order after these.
const STRUCT_PRIORITY = ['SH-01', 'SH-02', 'SH-03', 'SH-04', 'SH-05', 'SH-11', 'SH-09', 'SH-10'];
export function buildGridItems(state, player, tabId) {
  const items = [];
  if (tabId === 'structures') {
    const defs = [];
    for (const def of state.data.structures) {
      if (def.faction !== 'All' && def.faction !== player.faction) continue;
      // ConYard rebuild tile: only while the rebuild is actually legal —
      // no CY standing, no MCV alive, one-shot not yet spent
      if (def.id === 'SH-01'
        && (hasConyard(state, player.slot) || hasMcv(state, player.slot) || player.cyRebuilt)) continue;
      defs.push(def);
    }
    defs.sort((a, b) => {
      const pa = STRUCT_PRIORITY.indexOf(a.id), pb = STRUCT_PRIORITY.indexOf(b.id);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb); // stable: sheet order for the rest
    });
    for (const def of defs) items.push({ kind: 'struct', id: def.id });
  } else {
    const tab = TABS.find((t) => t.id === tabId);
    if (!tab) return items;
    for (const def of state.data.units) {
      if (def.faction !== player.faction) continue;
      if (requiredProducer(state.unitDefs[def.id]) !== tab.prod) continue;
      items.push({ kind: 'unit', id: def.id });
    }
    // the harvester is a synthetic def (not in the sheet) — offer it at the WF
    if (tab.prod === 'SH-05') items.push({ kind: 'unit', id: 'HARV' });
  }
  return items;
}

// hotkey -> defId for a grid's items (Q W E R T F, in grid order)
export function hotkeyMapFor(items) {
  const m = {};
  items.forEach((it, i) => {
    if (i < BUILD_HOTKEYS.length) m[BUILD_HOTKEYS[i]] = it.id;
  });
  return m;
}

// v0.3.7 build queue strip (DeepSeek T7): first 3 queue entries, oldest
// first, of the focused producer for a tab. The selected producer wins; else
// the first owned producer with a non-empty queue. The structures tab reads
// the player-level build queue (producerId 0 = cancel via structId).
export function queueStripModel(state, player, tabId, selection) {
  const out = [];
  if (!state || !player) return out;
  if (tabId === 'structures') {
    const bq = player.buildQueue || [];
    for (let i = 0; i < bq.length && out.length < 3; i++) {
      const q = bq[i];
      out.push({ kind: 'struct', id: q.structId, producerId: 0,
        progress: q.progress, total: q.total });
    }
    return out;
  }
  const tab = TABS.find((t) => t.id === tabId);
  if (!tab || !tab.prod) return out;
  let prod = null;
  for (const id of (selection || [])) {
    const s = state.structures[id];
    if (s && s.owner === player.slot && s.defId === tab.prod) { prod = s; break; }
  }
  if (!prod) {
    for (const id in state.structures) {
      const s = state.structures[id];
      if (s.owner === player.slot && s.defId === tab.prod && s.queue && s.queue.length) {
        prod = s;
        break;
      }
    }
  }
  if (!prod || !prod.queue) return out;
  for (let i = 0; i < prod.queue.length && out.length < 3; i++) {
    const q = prod.queue[i];
    out.push({ kind: 'unit', id: q.unitId, producerId: prod.id,
      progress: q.progress, total: q.total });
  }
  return out;
}

// v0.3.7 research kits (Grok slice 3): the kits a producer structure offers
// this faction. Defensive when the sheet predates the upgrades block.
export function researchKitsFor(state, player, producerDefId) {
  const ups = (state && state.data && state.data.upgrades) || [];
  const out = [];
  for (const g of ups) {
    if (g.faction !== player.faction || g.producer !== producerDefId) continue;
    out.push({
      id: g.id, label: g.label, cost: g.cost,
      owned: !!(player.upgrades && player.upgrades[g.id]),
      affordable: player.credits >= g.cost,
    });
  }
  return out;
}

// ---- army control panel (v0.5.1): one-click fraction selection per branch -----
// pure helpers (headless-testable); selection itself is UI-side only — the
// panel never issues commands or touches sim state
const ARMY_BRANCHES = [
  { id: 'air', label: 'Air force' },
  { id: 'armor', label: 'Armor' },
  { id: 'inf', label: 'Infantry' },
];

function armyBranchTest(state, u, branchId) {
  const d = state.unitDefs[u.defId];
  if (branchId === 'air') return d.domain === 'Air';
  if (branchId === 'armor') {
    return d.domain === 'Land' && !isInfantryCls(d.cls)
      && u.defId !== 'MCV' && u.defId !== 'HARV';
  }
  return isInfantryCls(d.cls);
}

// own units of a branch, sorted by unit id ascending (deterministic pick)
export function armyBranchUnits(state, slot, branchId) {
  const out = [];
  for (const id in state.units) {
    const u = state.units[id];
    if (u.owner !== slot) continue;
    if (armyBranchTest(state, u, branchId)) out.push(u);
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

// the ids a pct button would select: ceil(count × pct), lowest ids first
export function armyPick(state, slot, branchId, pct) {
  const units = armyBranchUnits(state, slot, branchId);
  return units.slice(0, Math.ceil(units.length * pct)).map((u) => u.id);
}

// tooltip content lines: name, cost/time/HP, role/counter or power/unlocks
export function tooltipLines(state, player, kind, defId) {
  if (kind === 'struct') {
    const def = state.structDefs[defId];
    const cost = buildCost(state, player, def);
    const lines = [def.name, 'Cost ' + cost + ' · Build ' + def.build_s + 's · ' + def.hp + ' HP'];
    if (def.power_out > 0) lines.push('Power +' + def.power_out);
    else if (def.power_use > 0) lines.push('Power -' + def.power_use);
    if (def.unlocks) lines.push(def.unlocks);
    return lines;
  }
  const def = state.unitDefs[defId];
  const cost = trainCost(state, player, def, requiredProducer(def) || 'SH-05');
  const lines = [def.name, 'Cost ' + cost + ' · Build ' + def.build_s + 's · ' + def.hp + ' HP'];
  lines.push(def.role + (def.hardCounter ? ' — beaten by (hard): ' + def.hardCounter : ''));
  if (def.softCounter) lines.push('Threatened by (soft): ' + def.softCounter);
  if (def.cls === 'Engineer') lines.push('Captures enemy structures — order it to attack one');
  return lines;
}

// ---- DOM --------------------------------------------------------------------

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

// pass-3 painted cameo plates (game.iconArt: defId -> 128px data-URI). One
// img element per URI per consumer (build grid / selection panel), reused
// across rebuilds so each plate decodes once; the CSS glyph stays underneath
// as the decode-failure fallback (a broken img hides itself on error).
// Headless stubs never fire the decode events, so this is all inert there.
const __cameoImgs = { grid: {}, sel: {} };
function iconArtUri(game, defId) {
  const art = game && game.iconArt;
  const uri = art ? art[defId] : null;
  return (typeof uri === 'string' && uri) ? uri : null;
}
function cameoImg(kind, uri) {
  const cache = __cameoImgs[kind];
  let img = cache[uri];
  if (!img) {
    img = document.createElement('img');
    img.className = 'bb-cameo' + (kind === 'sel' ? ' sel-cameo' : '');
    img.draggable = false;
    img.alt = '';
    img.addEventListener('error', () => { img.style.display = 'none'; });
    img.src = uri;
    cache[uri] = img;
  }
  return img;
}

function hudPushCmd(game, cmd) {
  cmd.player = game.playerSlot;
  game.pendingCmds.push(cmd);
}

// audio.js ships concurrently (v0.3.7); headless harnesses strip the import,
// so every call site is guarded — audio is always best-effort
function sfx(game, name) {
  try { if (typeof playSfx === 'function') playSfx(game, name); } catch (e) { /* no-op */ }
}
function music(game, track) {
  try { if (typeof playMusicTrack === 'function') playMusicTrack(game, track); } catch (e) { /* no-op */ }
}
function voice(game, faction, key, detail) {
  try { if (typeof playVoice === 'function') playVoice(game, faction, key, detail); } catch (e) { /* no-op */ }
}
function tryUnlockAudio() {
  try { if (typeof unlockAudio === 'function') unlockAudio(); } catch (e) { /* no-op */ }
}

export function initHud(game) {
  // top bar
  const top = document.getElementById('topbar');
  top.innerHTML = '';
  const creditsEl = h('span', 'tb-credits', '0');
  const powerDot = h('span', 'tb-power-dot ok');
  const powerEl = h('span', 'tb-val', '0 / 0');
  const clockEl = h('span', 'tb-val', '0:00');
  top.appendChild(h('span', 'tb-label', 'Credits'));
  top.appendChild(creditsEl);
  top.appendChild(h('span', 'tb-label', 'Power'));
  const pw = h('span', 'tb-power');
  pw.appendChild(powerDot);
  pw.appendChild(powerEl);
  top.appendChild(pw);
  top.appendChild(h('span', 'tb-label', 'Time'));
  top.appendChild(clockEl);
  top.appendChild(h('span', 'tb-spacer'));

  // v0.10.0 multiplayer: connection dot + worst-peer RTT in the top bar
  const netSpan = h('span', 'tb-net');
  netSpan.id = 'net-status';
  const netDot = h('span', 'net-dot good');
  const netText = h('span', null, '');
  netSpan.appendChild(netDot);
  netSpan.appendChild(netText);
  netSpan.style.display = 'none';
  top.appendChild(netSpan);
  function updateNetStatus() {
    const net = game.net;
    const on = !!(net && net.active && (game.state || game.overlay === 'lobby'));
    netSpan.style.display = on ? '' : 'none';
    if (!on) return;
    const s = typeof net.status === 'function' ? net.status() : 'off';
    netDot.className = 'net-dot ' + (s === 'good' ? 'good' : s === 'fair' ? 'fair'
      : s === 'poor' ? 'poor' : 'down');
    let txt = s === 'good' ? 'MP ok' : s === 'fair' ? 'MP fair'
      : s === 'poor' ? 'MP LAG' : 'MP offline';
    let worst;
    for (const sl of Object.keys(net.peers || {}).map(Number)) {
      const r = net.peers[sl].rtt;
      if (r !== undefined && (worst === undefined || r > worst)) worst = r;
    }
    if (worst !== undefined) txt += ' · ' + Math.round(worst) + 'ms';
    netText.textContent = txt;
  }

  // v0.6.0 zoom control: [-] slider [+] for mouse users — the wheel now pans
  // the map; ctrl+wheel (touchpad pinch) still zooms at the cursor. The
  // slider drives zoomCameraAt centered on the screen middle; updateHud
  // syncs it back from camera.zoom wherever the zoom changed.
  const zoomAtCenter = (f) => {
    const cam = game.camera;
    if (!cam) return;
    zoomCameraAt(cam, f, cam.viewW / 2, cam.viewH / 2);
    if (game.state) {
      clampCameraToMap(cam, game.state.map.w * CELL, game.state.map.h * CELL);
    }
  };
  const zoomSpan = h('span', 'tb-zoom');
  const zoomOutBtn = h('button', 'tb-btn tb-zoom-btn', '-');
  const zoomSlider = h('input', 'tb-zoom-slider');
  zoomSlider.type = 'range';
  zoomSlider.min = '0.16'; // camera.js minZoom (v0.9.0: whole-base view)
  zoomSlider.max = '2.5';  // camera.js maxZoom
  zoomSlider.step = '0.05';
  zoomSlider.value = '1';
  zoomSlider.disabled = true; // no camera until a match starts
  const zoomInBtn = h('button', 'tb-btn tb-zoom-btn', '+');
  zoomOutBtn.addEventListener('click', () => { if (game.camera) zoomAtCenter(1 / 1.15); });
  zoomInBtn.addEventListener('click', () => { if (game.camera) zoomAtCenter(1.15); });
  zoomSlider.addEventListener('input', () => {
    const z = Number(zoomSlider.value);
    const cam = game.camera;
    if (cam && isFinite(z) && z > 0) {
      zoomCameraAt(cam, z / cam.zoom, cam.viewW / 2, cam.viewH / 2);
      if (game.state) {
        clampCameraToMap(cam, game.state.map.w * CELL, game.state.map.h * CELL);
      }
    }
  });
  zoomSpan.appendChild(zoomOutBtn);
  zoomSpan.appendChild(zoomSlider);
  zoomSpan.appendChild(zoomInBtn);
  top.appendChild(zoomSpan);

  const speedBtns = {};
  for (const s of [1, 2, 4]) {
    const b = h('button', 'tb-btn' + (s === 1 ? ' active' : ''), s + 'x');
    b.addEventListener('click', () => {
      if (game.overlay) return; // an overlay owns the UI right now
      if (game.net && game.net.active) return; // speed is locked to 1x in MP
      game.speed = s; game.paused = false;
      refreshSpeed();
    });
    speedBtns[s] = b;
    top.appendChild(b);
  }
  const pauseBtn = h('button', 'tb-btn', 'Pause');
  pauseBtn.addEventListener('click', () => {
    if (game.overlay) return; // paused overlay owns the pause state
    if (game.net && game.net.active) {
      // v0.10.0: pause is host-authoritative — only the host may pause, and
      // the toggle rides a net message so every peer pauses together (the
      // relay does not echo, so the host applies its own toggle locally)
      if (!game.net.isHost) return;
      game.paused = !game.paused;
      game.mpPauseName = game.paused ? (game.net.name || 'Host') : '';
      game.net.sendPause(game.paused);
      refreshSpeed();
      return;
    }
    game.paused = !game.paused;
    refreshSpeed();
  });
  top.appendChild(pauseBtn);
  const menuBtn = h('button', 'tb-btn', 'Menu');
  menuBtn.addEventListener('click', () => { if (game.openMenu) game.openMenu(); });
  top.appendChild(menuBtn);
  // music on/off (v0.3.7): reflects game.musicOn; audio.js persists the choice
  const musicBtn = h('button', 'tb-btn' + (game.musicOn !== false ? ' active' : ''), 'Music');
  musicBtn.addEventListener('click', () => {
    game.musicOn = game.musicOn === false;
    try { if (typeof setMusicOn === 'function') setMusicOn(game, game.musicOn); } catch (e) { /* no-op */ }
    musicBtn.classList.toggle('active', game.musicOn);
  });
  top.appendChild(musicBtn);
  function refreshSpeed() {
    // v0.10.0: in MP the speed is locked to 1x (the lockstep gate paces every
    // peer) so the 1x/2x/4x buttons disappear; pause becomes host-only
    const mp = !!(game.net && game.net.active && game.state);
    if (mp && game.speed !== 1) game.speed = 1;
    for (const s of [1, 2, 4]) {
      speedBtns[s].classList.toggle('active', !game.paused && game.speed === s);
      speedBtns[s].style.display = mp ? 'none' : '';
    }
    pauseBtn.classList.toggle('active', game.paused);
    pauseBtn.style.display = (mp && !(game.net && game.net.isHost)) ? 'none' : '';
    // spectating badge + 'Paused by X' banner
    const spec = typeof document !== 'undefined' && document.getElementById
      ? document.getElementById('spec-badge') : null;
    if (spec && spec.classList) {
      spec.classList.toggle('hidden', !(mp && game.spectating && !game.state.over));
    }
    const pb = typeof document !== 'undefined' && document.getElementById
      ? document.getElementById('pause-banner') : null;
    if (pb && pb.classList) {
      const show = mp && game.paused && !!game.mpPauseName;
      pb.classList.toggle('hidden', !show);
      if (show) pb.textContent = 'Paused by ' + game.mpPauseName;
    }
    updateNetStatus();
  }
  game.hudSyncSpeed = refreshSpeed; // main.js syncs after overlay-driven changes

  // build bar
  const bar = document.getElementById('buildbar');
  bar.innerHTML = '';
  const tabs = h('div', 'bb-tabs');
  const row = h('div', 'bb-row');
  // v0.9.0: the tile grid is a single row of 6 (QWERTF), paged by Tab and by
  // the flanking ‹ › arrows whenever a tab holds more than 6 items
  const pagePrev = h('button', 'bb-arrow bb-prev', '‹');
  const pageNext = h('button', 'bb-arrow bb-next', '›');
  pagePrev.type = 'button';
  pageNext.type = 'button';
  pagePrev.title = 'Previous build page';
  pageNext.title = 'Next build page [Tab]';
  const grid = h('div', 'bb-grid');
  const actions = h('div', 'bb-actions');
  row.appendChild(pagePrev);
  row.appendChild(grid);
  row.appendChild(pageNext);
  row.appendChild(actions);
  bar.appendChild(tabs);
  bar.appendChild(row);
  pagePrev.addEventListener('click', () => { if (game.hudPrevPage) game.hudPrevPage(); });
  pageNext.addEventListener('click', () => { if (game.hudNextPage) game.hudNextPage(); });
  // v0.3.7: compact queue strip under the tile grid (focused producer)
  const queueStrip = h('div', 'bb-queue');
  queueStrip.style.display = 'none';
  bar.appendChild(queueStrip);

  // army control panel (v0.5.1): fraction selection per branch, docked above
  // the minimap; counts refresh on the heavy-scan cadence (signature-guarded)
  const apRoot = document.getElementById('army-panel');
  apRoot.innerHTML = '';
  const apHead = h('div', 'ap-head', 'ARMY');
  const apBody = h('div', 'ap-body');
  apRoot.appendChild(apHead);
  apRoot.appendChild(apBody);
  const apRows = {};
  for (const br of ARMY_BRANCHES) {
    const row = h('div', 'ap-row');
    row.appendChild(h('span', 'ap-name', br.label));
    const cnt = h('span', 'ap-count', '×0');
    row.appendChild(cnt);
    const btns = [];
    for (const pct of [0.25, 0.5, 1]) {
      const b = h('button', 'ap-btn', Math.round(pct * 100) + '%');
      b.disabled = true;
      b.classList.add('disabled');
      b.addEventListener('click', (e) => {
        const st2 = game.state;
        if (!st2 || st2.over) return;
        const ids = armyPick(st2, game.playerSlot, br.id, pct);
        if (!ids.length) return;
        if (e && e.shiftKey) {
          // Shift+click adds the fraction to the current selection
          for (const id of ids) {
            if (!game.selection.includes(id)) game.selection.push(id);
          }
        } else {
          game.selection = ids;
        }
        sfx(game, 'select');
      });
      row.appendChild(b);
      btns.push(b);
    }
    apBody.appendChild(row);
    apRows[br.id] = { count: cnt, btns };
  }

  // hint banners (persistent MCV hint is the first child)
  const hintRoot = document.getElementById('hint');
  hintRoot.innerHTML = '';
  const hintMcv = h('div', 'hint-banner mcv',
    'Select your MCV — press D or double-click it to deploy the Construction Yard');
  hintMcv.style.display = 'none';
  hintRoot.appendChild(hintMcv);

  game.hud = {
    creditsEl, powerDot, powerEl, clockEl, tabs, grid, actions,
    zoomSlider, // v0.6.0 top-bar zoom control (synced from camera.zoom)
    pagePrev, pageNext, // v0.9.0 one-row grid paging arrows (‹ ›)
    speedBtns, // v0.10.0 top-bar speed buttons (hidden in MP)
    activeTab: 'structures', tiles: {}, tabSig: '', gridSig: '', actSig: '',
    selSig: '', // v0.9.1 selection-panel rebuild guard
    stateRef: null, knownStructs: {}, lastReadyCount: 0, lastFaction: null, hintMcv,
    page: 0, hitSeen: {}, hitPing: {}, hintMcvTxt: '',
    sirenEsc: {}, sirenAt: {}, // v0.9.0 per-location siren cadence
    idleSince: {}, idleWarnAt: -9999,   // idle-worker banner bookkeeping (v0.3.6)
    tracerSeen: {}, lastEntCount: -1,   // SFX hooks: new tracers / entity deaths
    queue: queueStrip, queueSig: '', queueEls: [], // build queue strip (v0.3.7)
    queueLbl: null, queueLblSig: '',              // queue strip producer label (v0.4.4)
    knownUnits: {}, battleTimer: null, endFired: false, // voices, battle-music timer, end stinger (v0.3.7)
    lastHeavyMs: -1e9, heavyScans: 0, // heavy-scan 10 Hz gate (v0.4.4, DeepSeek 3.2)
    army: { root: apRoot, rows: apRows, collapsed: false, sig: '' }, // v0.5.1
  };
  apHead.addEventListener('click', () => {
    const A = game.hud.army;
    A.collapsed = !A.collapsed;
    apRoot.classList.toggle('closed', A.collapsed);
  });
  game.hudFocusBuild = () => {
    game.hud.activeTab = 'structures';
    game.hud.tabSig = '';
    updateHud(game);
  };
  game.hudPrevPage = () => {
    const st2 = game.state;
    if (!st2) return;
    const p2 = st2.players[game.playerSlot];
    const count = buildGridItems(st2, p2, game.hud.activeTab).length;
    const pages = Math.max(1, Math.ceil(count / BUILD_HOTKEYS.length));
    game.hud.page = (game.hud.page - 1 + pages) % pages;
    game.hud.tabSig = '';
    updateHud(game);
  };
  game.hudNextPage = () => {
    const st2 = game.state;
    if (!st2) return;
    const p2 = st2.players[game.playerSlot];
    const count = buildGridItems(st2, p2, game.hud.activeTab).length;
    const pages = Math.max(1, Math.ceil(count / BUILD_HOTKEYS.length));
    game.hud.page = (game.hud.page + 1) % pages;
    game.hud.tabSig = '';
    updateHud(game);
  };
  game.hudKeyPress = (key) => hudKeyPress(game, key);
  game.hint = hintRoot;
  game.hud.refreshNet = updateNetStatus; // v0.10.0: RTT refresh on the heavy cadence

  // audio.js boot + browser gesture gate: create/resume the shared
  // AudioContext on the first click/keypress (stub-safe: window may lack it)
  try { if (typeof initAudio === 'function') initAudio(game); } catch (e) { /* no-op */ }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pointerdown', tryUnlockAudio);
    window.addEventListener('keydown', tryUnlockAudio);
  }
}

export function updateHud(game, fromTick) {
  const st = game.state;
  if (!st || !game.hud) return;
  const p = st.players[game.playerSlot];
  const H = game.hud;
  // v0.4.4 (DeepSeek 3.2): the full-entity scans below (hit scan, struct/unit
  // bookkeeping, idle workers, tracers, entity count) are decoupled from the
  // sim tick — at 4x updateHud runs 40x/s, these run at most ~10x/s real
  // time. 90ms not 100 so 120 Hz displays (ticks ~99.96ms apart at 1x) never
  // gate. Calls from outside the sim loop (clicks, match start, tests) leave
  // fromTick unset and always force a heavy pass, so 1x behavior and direct
  // calls are unchanged.
  const heavy = fromTick !== true
    || nowMs() - H.lastHeavyMs >= HEAVY_SCAN_MS;
  if (heavy) {
    H.lastHeavyMs = nowMs();
    H.heavyScans++;
  }
  if (H.stateRef !== st) {
    H.stateRef = st;
    H.knownStructs = {};
    H.knownUnits = {};
    // seed the entity snapshots WITHOUT firing voices: whatever the player
    // already owns is the baseline — only later arrivals/losses get EVA lines.
    // Structure OWNERS are tracked (not just presence) so an engineer capture
    // reads as 'captured', not as a fresh 'built'
    for (const id in st.structures) {
      H.knownStructs[id] = st.structures[id].owner;
    }
    for (const id in st.units) {
      if (st.units[id].owner === p.slot) H.knownUnits[id] = st.units[id].defId;
    }
    H.endFired = false;
    if (H.battleTimer && typeof clearTimeout === 'function') clearTimeout(H.battleTimer);
    H.battleTimer = null;
    H.lastReadyCount = 0;
    H.lastFaction = null;
    H.tabSig = ''; H.gridSig = ''; H.actSig = ''; H.queueSig = ''; H.selSig = '';
    H.page = 0; H.hitSeen = {}; H.hitPing = {}; H.hintMcvTxt = '';
    H.sirenEsc = {}; H.sirenAt = {}; // v0.9.0 siren cadence is per match
    H.idleSince = {}; H.idleWarnAt = -9999;
    H.tracerSeen = {}; H.lastEntCount = -1;
    // new match: module-level SFX/voice throttles must not carry over — a
    // rematch seconds after the last battle still gets fresh voice lines
    __shotAt = -Infinity; __boomAt = -Infinity; __clickAt = -Infinity;
    try { if (typeof resetAudioThrottles === 'function') resetAudioThrottles(); } catch (e) { /* no-op */ }
    // new-match audio: ambient track + faction 'command online' line
    music(game, 'ambient');
    voice(game, p.faction, 'online');
  }

  // end-of-match stinger: mirrors main.js's banner condition (team winner)
  if (!H.endFired && (st.over || p.eliminated)) {
    H.endFired = true;
    sfx(game, st.over && st.winner === p.team && !p.eliminated ? 'victory' : 'defeat');
  }

  // faction accent once per match
  if (H.lastFaction !== p.faction) {
    H.lastFaction = p.faction;
    const col = factionColorOf(st.data, p.faction);
    const doc = document.documentElement;
    if (doc && doc.style && typeof doc.style.setProperty === 'function') {
      doc.style.setProperty('--accent', col);
      doc.style.setProperty('--accent-dim', col + '59');
    }
  }

  // top bar
  H.creditsEl.textContent = Math.floor(p.credits) + '';
  const ratio = p.powerOut > 0 ? p.powerUse / p.powerOut : 0;
  H.powerDot.className = 'tb-power-dot ' + (p.lowPower ? 'low' : ratio > 0.8 ? 'amber' : 'ok');
  H.powerEl.textContent = p.powerUse + ' / ' + p.powerOut;
  H.clockEl.textContent = fmtClock(st.tick);
  if (H.refreshNet) H.refreshNet(); // v0.10.0 live RTT readout

  // v0.6.0 zoom control sync: the slider follows camera.zoom wherever the
  // zoom changed (ctrl+wheel pinch, +/- keys); skipped while the user is
  // dragging the slider itself
  if (H.zoomSlider) {
    const cam = game.camera;
    H.zoomSlider.disabled = !cam;
    if (cam) {
      const sliderFocused = typeof document !== 'undefined'
        && document.activeElement === H.zoomSlider;
      const cur = Number(H.zoomSlider.value);
      if (!sliderFocused && Math.abs(cur - cam.zoom) > 0.005) {
        H.zoomSlider.value = String(Math.round(cam.zoom * 100) / 100);
      }
    }
  }

  // dim the chrome while placing / targeting / attack-moving
  if (document.body && document.body.classList) {
    document.body.classList.toggle('placing', !!game.placement);
    document.body.classList.toggle('targeting', !!game.targeting);
    document.body.classList.toggle('attackmove', !!game.attackMoveArmed);
    // capture cursor: engineer selected and hovering a hostile/neutral structure
    let capCursor = false;
    if (game.mouse && game.mouse.inside && game.selection.some((id) => {
      const u = st.units[id];
      return u && u.owner === p.slot && st.unitDefs[u.defId].cls === 'Engineer';
    })) {
      const w = screenToWorld(game.camera, game.mouse.sx, game.mouse.sy);
      const cx = Math.floor(w.x / CELL), cy = Math.floor(w.y / CELL);
      capCursor = Object.values(st.structures).some((s) => isHostile(st, p.slot, s)
        && cx >= s.cx && cx < s.cx + s.fp && cy >= s.cy && cy < s.cy + s.fp);
    }
    document.body.classList.toggle('capture', capCursor);
  }

  // persistent deploy hint until the first ConYard exists
  let hasCy = false, hasMcv = false;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner === p.slot && s.defId === 'SH-01') hasCy = true;
  }
  for (const id in st.units) {
    const u = st.units[id];
    if (u.owner === p.slot && u.defId === 'MCV') hasMcv = true;
  }
  H.hintMcv.style.display = (!hasCy && hasMcv && !st.over) ? 'block' : 'none';
  // v0.3.5: countdown to the auto-deploy inside the persistent hint
  if (H.hintMcv.style.display === 'block') {
    const left = Math.ceil((AUTO_DEPLOY_TICKS - st.tick) / 10);
    const txt = 'Select your MCV — press D or double-click to deploy ('
      + (left > 0 ? 'auto-deploy in ' + left + 's' : 'auto-deploying…') + ')';
    if (txt !== H.hintMcvTxt) { H.hintMcvTxt = txt; H.hintMcv.textContent = txt; }
  }

  // structure finished construction -> hint + minimap ping at the base
  if (p.ready.length > H.lastReadyCount) {
    const newId = p.ready[p.ready.length - 1];
    showHint(game, st.structDefs[newId].name + ' ready — place it from the build bar');
    const core = standingStructs(st, p.slot, (s) => st.structDefs[s.defId].type === 'Core')[0];
    if (core) {
      const c = structCenter(core);
      addPing(game, c.x, c.y);
    }
  }
  H.lastReadyCount = p.ready.length;

  // v0.3.4: brief toast when the player tried to deploy into a blocked spot
  if (p._deployFailTick && st.tick - p._deployFailTick <= 3) {
    p._deployFailTick = 0;
    showHint(game, 'No room to deploy — move the MCV a few cells and try again');
  }

  // heavy scans (struct/unit bookkeeping, hit scan, idle workers, tracers,
  // entity count) — decoupled from the sim tick, see updateHud's gate
  if (heavy) {
    heavyScans(game, st, p);
    updateArmyPanel(game, st, p);
  }

  updateTabs(game, p);
  updateGrid(game, p);
  updateQueueStrip(game, p);
  updateActions(game, p);
  updateSelectionPanel(game, st);
}

// the expensive full-entity scans, gated by updateHud to ~10 Hz real time
// (DeepSeek 3.2): structure/unit arrival-loss-capture bookkeeping, the
// under-attack hit scan, idle workers, tracer SFX, entity-count SFX
function heavyScans(game, st, p) {
  const H = game.hud;
  // newly placed structures -> minimap ping + 'built' voice; production
  // structures switch tab (rally points are sim-side: setRally / defaultRallyCell).
  // A structure that already existed under another owner and flipped TO the
  // local player is an engineer capture -> 'captured' voice instead of 'built'.
  for (const id in st.structures) {
    const s = st.structures[id];
    const prevOwner = H.knownStructs[id];
    if (prevOwner === undefined) {
      H.knownStructs[id] = s.owner;
      if (s.owner !== p.slot) continue; // track enemy/neutral structures silently
      voice(game, p.faction, 'built', { id: s.defId, type: st.structDefs[s.defId].type });
      const c = structCenter(s);
      addPing(game, c.x, c.y);
      const tabId = PRODUCER_TAB[s.defId];
      if (tabId) {
        H.activeTab = tabId;
        H.tabSig = '';
        showHint(game, st.structDefs[s.defId].name + ' online — ' + tabId + ' production available');
      }
    } else if (prevOwner !== s.owner) {
      H.knownStructs[id] = s.owner;
      if (s.owner === p.slot) {
        voice(game, p.faction, 'captured');
        const c = structCenter(s);
        addPing(game, c.x, c.y);
        showHint(game, st.structDefs[s.defId].name + ' captured');
      } else if (prevOwner === p.slot) {
        voice(game, p.faction, 'structLost'); // captured away from us
      }
    }
  }

  // symmetric unit/loss bookkeeping (v0.3.7): new owned unit -> 'unit' voice
  // ('harv' for the harvester); entities gone from the snapshots -> 'lost' /
  // 'structLost'. The MCV never gets a 'lost' line: deploying removes the unit.
  for (const id in st.units) {
    const u = st.units[id];
    if (u.owner !== p.slot || H.knownUnits[id]) continue;
    H.knownUnits[id] = u.defId;
    voice(game, p.faction, u.defId === 'HARV' ? 'harv' : 'unit');
  }
  for (const id in H.knownStructs) {
    if (st.structures[id]) continue;
    const wasOwn = H.knownStructs[id] === p.slot;
    delete H.knownStructs[id];
    if (wasOwn) voice(game, p.faction, 'structLost');
  }
  for (const id in H.knownUnits) {
    const u = st.units[id];
    if (!u || u.owner !== p.slot) {
      const defId = H.knownUnits[id];
      delete H.knownUnits[id];
      if (defId !== 'MCV') voice(game, p.faction, 'lost');
    }
  }

  // under-attack alarm: own unit/structure took a hit since last seen.
  // hitSeen bookkeeping fires each hit exactly once; a paused game keeps
  // st.tick frozen, so resuming never replays stale hits.
  const hitScan = (ent, isUnit) => {
    if (ent.owner !== p.slot || ent.lastHitTick < 0) return;
    if (H.hitSeen[ent.id] === ent.lastHitTick) return;
    H.hitSeen[ent.id] = ent.lastHitTick;
    const c = isUnit ? { x: ent.x, y: ent.y } : structCenter(ent);
    if (st.tick - (H.hitPing[ent.id] || -999) >= 20) {
      H.hitPing[ent.id] = st.tick;
      addPing(game, c.x, c.y);
    }
    // only genuinely fresh hits raise the alarm (guards HUD re-inits)
    if (st.tick - ent.lastHitTick <= 5) underAttackAlert(game, ent, isUnit, c);
  };
  for (const id in st.structures) hitScan(st.structures[id], false);
  for (const id in st.units) hitScan(st.units[id], true);

  // idle-worker banner (v0.3.6): >1 harvester/engineer idle for >10s nudges
  // the player (throttled to one banner per 30s); a single worker idle for
  // >30s also warns (v0.4.3); the '.' key jumps to them
  let idleCount = 0, longestIdle = 0;
  const seenIdle = {};
  for (const id in st.units) {
    const u = st.units[id];
    if (u.owner !== p.slot) continue;
    const isWorker = u.defId === 'HARV' || st.unitDefs[u.defId].cls === 'Engineer';
    if (!isWorker || u.order.type !== 'idle') continue;
    seenIdle[id] = 1;
    if (!H.idleSince[id]) H.idleSince[id] = st.tick;
    const idleTicks = st.tick - H.idleSince[id];
    if (idleTicks > 100) idleCount++;
    if (idleTicks > longestIdle) longestIdle = idleTicks;
  }
  for (const id in H.idleSince) if (!seenIdle[id]) delete H.idleSince[id];
  if ((idleCount >= 2 || longestIdle > 300) && st.tick - H.idleWarnAt >= 300) {
    H.idleWarnAt = st.tick;
    showHint(game, (idleCount === 1 ? '1 idle worker' : idleCount + ' idle workers')
      + ' — press . to jump to them');
  }

  // SFX hooks (v0.3.6): weapon crack for fresh tracers visible on screen,
  // explosion thump when the entity count drops. All no-op headless.
  if (game.camera) {
    const cam = game.camera;
    const fog = st.fog[game.playerSlot].visible;
    const mw = st.map.w;
    for (const id in st.projectiles) {
      const pr = st.projectiles[id];
      if (pr.kind !== 'tracer' || H.tracerSeen[id]) continue;
      H.tracerSeen[id] = 1;
      const cx = Math.floor(pr.tx / CELL), cy = Math.floor(pr.ty / CELL);
      if (cx < 0 || cy < 0 || cx >= mw || cy >= st.map.h) continue;
      if (!fog[cy * mw + cx]) continue;
      if (pr.tx < cam.x || pr.tx > cam.x + cam.viewW / cam.zoom
        || pr.ty < cam.y || pr.ty > cam.y + cam.viewH / cam.zoom) continue;
      playShot();
    }
    // tracerSeen only grows between matches; bound it
    let nSeen = 0;
    for (const id in H.tracerSeen) nSeen++;
    if (nSeen > 400) H.tracerSeen = {};
  }
  let entCount = 0;
  for (const id in st.units) entCount++;
  for (const id in st.structures) entCount++;
  if (H.lastEntCount >= 0 && entCount < H.lastEntCount) playBoom();
  H.lastEntCount = entCount;
}

// army panel counts: refreshed on the heavy-scan cadence; the signature
// guard means the DOM is touched only when a branch count actually changes
function updateArmyPanel(game, st, p) {
  const A = game.hud.army;
  if (!A) return;
  let sig = '';
  const counts = {};
  for (const br of ARMY_BRANCHES) {
    counts[br.id] = armyBranchUnits(st, p.slot, br.id).length;
    sig += counts[br.id] + ',';
  }
  if (sig === A.sig) return;
  A.sig = sig;
  for (const br of ARMY_BRANCHES) {
    const r = A.rows[br.id];
    const n = counts[br.id];
    r.count.textContent = '×' + n;
    for (const b of r.btns) {
      b.disabled = n === 0;
      b.classList.toggle('disabled', n === 0);
    }
  }
}

function fmtClock(tick) {
  const s = Math.floor(tick / 10);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function hasConyard(st, slot) {
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner === slot && s.defId === 'SH-01') return true;
  }
  return false;
}

function hasMcv(st, slot) {
  for (const id in st.units) {
    const u = st.units[id];
    if (u.owner === slot && u.defId === 'MCV') return true;
  }
  return false;
}

// ---- build bar ---------------------------------------------------------------

function updateTabs(game, p) {
  const H = game.hud;
  const avail = tabsFor(game.state, p.slot);
  if (!avail.some((t) => t.id === H.activeTab)) {
    H.activeTab = avail.length ? avail[0].id : 'structures';
    H.page = 0;
  }
  const count = buildGridItems(game.state, p, H.activeTab).length;
  const pages = Math.max(1, Math.ceil(count / BUILD_HOTKEYS.length));
  if (H.page >= pages) H.page = pages - 1;
  // v0.9.0: the ‹ › arrows only make sense when there is something to page
  if (H.pagePrev) H.pagePrev.disabled = pages <= 1;
  if (H.pageNext) H.pageNext.disabled = pages <= 1;
  const sig = avail.map((t) => t.id).join(',') + '|' + H.activeTab
    + '|' + H.page + '|' + pages;
  if (sig === H.tabSig) return;
  H.tabSig = sig;
  H.gridSig = '';
  H.tabs.innerHTML = '';
  for (const t of avail) {
    const b = h('button', 'bb-tab' + (t.id === H.activeTab ? ' active' : ''), t.label);
    b.addEventListener('click', () => {
      H.activeTab = t.id;
      H.page = 0;
      H.tabSig = '';
      updateHud(game);
    });
    H.tabs.appendChild(b);
  }
  if (pages > 1) {
    H.tabs.appendChild(h('span', 'bb-page', 'page ' + (H.page + 1) + '/' + pages + ' [Tab]'));
  }
}

// per-item display state, computed fresh each tick
function gridItemMeta(game, p, it) {
  const st = game.state;
  if (it.kind === 'struct') {
    const def = st.structDefs[it.id];
    const bs = structureButtonState(st, p, it.id);
    let queued = 0, progress = -1;
    p.buildQueue.forEach((q, i) => {
      if (q.structId !== it.id) return;
      queued++;
      if (i === 0) progress = q.progress / q.total;
    });
    return {
      kind: 'struct', id: it.id, def, cost: buildCost(st, p, def),
      enabled: bs.enabled, reason: bs.reason, queued,
      ready: p.ready.includes(it.id), progress,
    };
  }
  const tab = TABS.find((t) => t.id === game.hud.activeTab);
  const def = st.unitDefs[it.id];
  const bs = trainButtonState(st, p, it.id);
  let queued = 0, progress = -1;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner !== p.slot || !tab || s.defId !== tab.prod) continue;
    for (let i = 0; i < s.queue.length; i++) {
      const q = s.queue[i];
      if (q.unitId !== it.id) continue;
      queued++;
      if (i === 0) progress = q.progress / q.total;
    }
  }
  return {
    kind: 'unit', id: it.id, def, cost: trainCost(st, p, def, tab ? tab.prod : null),
    enabled: bs.enabled, reason: bs.reason, queued, ready: false, progress,
  };
}

function reasonText(m) {
  if (m.ready) return 'Ready — click, then click the map (Shift chains placement)';
  if (m.enabled) return '';
  switch (m.reason) {
    case 'credits': return 'Not enough credits';
    case 'tech-gate': return 'Requires Command / Tech (SH-08)';
    case 'no-producer': return 'Requires production structure';
    case 'no-conyard': return 'Requires Construction Yard';
    case 'no-unique': return 'Requires the faction unique / superweapon structure';
    case 'cy-exists': return 'Construction Yard already standing';
    case 'cy-rebuild-used': return 'ConYard rebuild already used';
    case 'mcv-alive': return 'Deploy or lose your MCV first';
    case 'no-water': return 'No water on this map';
    case 'oil-field': return 'Too close to an oil field';
    case 'unique-active': return 'One per match — already fielded';
    default: return m.reason || '';
  }
}

function updateGrid(game, p) {
  const H = game.hud;
  const all = buildGridItems(game.state, p, H.activeTab);
  const items = all.slice(H.page * BUILD_HOTKEYS.length,
    (H.page + 1) * BUILD_HOTKEYS.length);
  const metas = items.map((it) => gridItemMeta(game, p, it));
  let sig = H.activeTab + '|' + H.page + '|' + p.faction;
  for (const m of metas) {
    sig += '|' + m.id + ':' + (m.enabled ? 1 : 0) + ':' + m.reason + ':'
      + m.queued + ':' + (m.ready ? 1 : 0) + ':' + m.cost
      + ':' + (iconArtUri(game, m.id) ? 1 : 0); // late-arriving iconArt rebuilds
  }
  if (sig !== H.gridSig) {
    H.gridSig = sig;
    rebuildTiles(game, metas);
  }
  // cheap per-tick updates: production sweep + placement highlight. Placement
  // state deliberately stays OUT of the rebuild signature above — toggling
  // the class here avoids a full rebuild (which would kill a hover tooltip)
  for (const m of metas) {
    const t = H.tiles[m.id];
    if (!t) continue;
    t.el.classList.toggle('placing', !!(game.placement && game.placement.structId === m.id));
    if (m.progress >= 0) {
      const deg = Math.floor(m.progress * 360);
      t.prog.style.display = 'block';
      t.prog.style.background = 'conic-gradient(rgba(140,210,255,0.30) '
        + deg + 'deg, rgba(0,0,0,0.45) ' + deg + 'deg)';
    } else {
      t.prog.style.display = 'none';
    }
  }
}

function rebuildTiles(game, metas) {
  const H = game.hud;
  hideTooltip(); // v0.3.2: kill any pending tooltip bound to a tile we're about to drop
  H.grid.innerHTML = '';
  H.tiles = {};
  metas.forEach((m, i) => {
    const tile = h('button', 'bb-tile');
    if (i < BUILD_HOTKEYS.length) tile.appendChild(h('span', 'bb-hotkey', BUILD_HOTKEYS[i]));
    const glyph = h('span', 'bb-glyph');
    const shape = m.kind === 'unit' ? shapeForUnit(m.def) : shapeForStructure(m.def);
    glyph.appendChild(h('span', 'bb-shape shape-' + shape));
    glyph.appendChild(h('span', 'bb-initials', initialsFor(m.def.name)));
    tile.appendChild(glyph);
    // painted cameo plate over the icon area (pass-3 iconArt); the glyph
    // stays underneath as the decode-failure fallback, hotkey/cost get a
    // dark chip via .has-cameo so they stay readable over the art
    const cameoUri = iconArtUri(game, m.id);
    if (cameoUri) {
      tile.appendChild(cameoImg('grid', cameoUri));
      tile.classList.add('has-cameo');
    }
    tile.appendChild(h('span', 'bb-cost', m.ready ? 'PLACE' : String(m.cost)));
    const badge = h('span', 'bb-badge', '×' + m.queued);
    badge.style.display = m.queued ? 'block' : 'none';
    tile.appendChild(badge);
    const prog = h('div', 'bb-prog');
    prog.style.display = 'none';
    tile.appendChild(prog);
    if (m.ready) tile.classList.add('ready');
    else if (m.queued) tile.classList.add('queued');
    else if (!m.enabled) tile.classList.add('disabled');
    if (game.placement && game.placement.structId === m.id) tile.classList.add('placing');
    tile.addEventListener('click', () => activateItem(game, m));
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancelItem(game, m);
    });
    attachTooltip(game, tile, () => {
      const pp = game.state.players[game.playerSlot];
      const lines = tooltipLines(game.state, pp, m.kind, m.id);
      const mm = gridItemMeta(game, pp, m);
      const r = reasonText(mm);
      if (r) lines.push(r);
      if (mm.queued) lines.push('Right-click to cancel');
      return lines;
    });
    H.grid.appendChild(tile);
    H.tiles[m.id] = { el: tile, prog, badge };
  });
}

function activateItem(game, m) {
  if (m.kind === 'struct') {
    if (m.ready) {
      game.placement = { structId: m.id };
      game.targeting = null;
      game.attackMoveArmed = false;
    } else if (!m.queued && m.enabled) {
      hudPushCmd(game, { type: 'buildStructure', structId: m.id });
      sfx(game, 'build');
    }
  } else if (m.enabled) {
    hudPushCmd(game, { type: 'trainUnit', unitId: m.id });
    sfx(game, 'build');
  }
}

// right-click a tile: cancel the newest queued entry (full refund, sim-side)
function cancelItem(game, m) {
  const st = game.state;
  const p = st.players[game.playerSlot];
  if (m.kind === 'struct') {
    if (m.queued) {
      hudPushCmd(game, { type: 'cancelProduction', kind: 'struct', structId: m.id });
    }
    return;
  }
  const tab = TABS.find((t) => t.id === game.hud.activeTab);
  let best = null, bestI = -1;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner !== p.slot || !tab || s.defId !== tab.prod) continue;
    const i = s.queue.map((q) => q.unitId).lastIndexOf(m.id);
    if (i > bestI) { bestI = i; best = s; }
  }
  if (best) {
    hudPushCmd(game, { type: 'cancelProduction', kind: 'unit', producerId: best.id, unitId: m.id });
  }
}

// ---- build queue strip ----------------------------------------------------------

// v0.4.3: populate the .bb-queue strip under the tile grid with the focused
// producer's first 3 queue entries (queueStripModel, oldest first). The strip
// rebuilds only when the entry identity signature changes (same guard pattern
// as gridSig/actSig); per-tick updates touch the progress bar width only.
// v0.4.4 (DeepSeek 3.5): label for the .bb-queue strip — the focused
// producer's name ('Airfield queue:'); when the model fell back to the first
// producer with a queue (nothing focused) the label is dimmed
function queueLabelInfo(state, player, tabId, selection) {
  if (tabId === 'structures') return { text: 'Build queue:', focused: true };
  const tab = TABS.find((t) => t.id === tabId);
  if (!tab || !tab.prod) return { text: '', focused: true };
  const name = state.structDefs[tab.prod].name + ' queue:';
  for (const id of (selection || [])) {
    const s = state.structures[id];
    if (s && s.owner === player.slot && s.defId === tab.prod) return { text: name, focused: true };
  }
  for (const id in state.structures) {
    const s = state.structures[id];
    if (s.owner === player.slot && s.defId === tab.prod && s.queue && s.queue.length) {
      return { text: name, focused: false };
    }
  }
  return { text: '', focused: true };
}

function updateQueueStrip(game, p) {
  const H = game.hud;
  const strip = H.queue;
  const model = queueStripModel(game.state, p, H.activeTab, game.selection);
  if (!model.length) {
    if (H.queueSig !== '') {
      H.queueSig = '';
      H.queueEls = [];
      hideTooltip(); // chips are gone — kill any tooltip bound to one
      strip.innerHTML = '';
    }
    H.queueLblSig = '';
    strip.style.display = 'none';
    return;
  }
  strip.style.display = 'flex';
  const li = queueLabelInfo(game.state, p, H.activeTab, game.selection);
  if (!H.queueLbl) H.queueLbl = h('span', 'bb-queue-label');
  let sig = H.activeTab;
  for (const q of model) sig += '|' + q.kind + ':' + q.id + ':' + q.producerId;
  if (sig !== H.queueSig) {
    H.queueSig = sig;
    hideTooltip();
    strip.innerHTML = '';
    strip.appendChild(H.queueLbl); // label stays first, before the chips
    H.queueEls = [];
    model.forEach((q) => {
      const def = q.kind === 'unit' ? game.state.unitDefs[q.id] : game.state.structDefs[q.id];
      const chip = h('button', 'bb-chip');
      chip.appendChild(h('span', 'bb-chip-code', initialsFor(def.name)));
      const bar = h('span', 'bb-chip-bar');
      chip.appendChild(bar);
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        cancelQueueEntry(game, q);
      });
      attachTooltip(game, chip, () => {
        const pp = game.state.players[game.playerSlot];
        const lines = tooltipLines(game.state, pp, q.kind, q.id);
        lines.push('Right-click to cancel');
        return lines;
      });
      strip.appendChild(chip);
      H.queueEls.push({ chip, bar });
    });
  }
  // cheap per-tick update: label text/dim + progress bar widths (model order
  // == chip order, the signature above covers any reordering)
  const lsig = li.text + '|' + (li.focused ? 1 : 0);
  if (lsig !== H.queueLblSig) {
    H.queueLblSig = lsig;
    H.queueLbl.textContent = li.text;
    H.queueLbl.classList.toggle('dim', !li.focused);
  }
  for (let i = 0; i < model.length && i < H.queueEls.length; i++) {
    const q = model[i];
    const pct = q.total > 0 ? Math.floor(100 * q.progress / q.total) : 0;
    H.queueEls[i].bar.style.width = pct + '%';
  }
}

// right-click a queue-strip chip: the sim tail-cancels the newest matching
// entry (full refund) — same semantics as right-clicking the build tile
function cancelQueueEntry(game, q) {
  if (q.kind === 'struct') {
    hudPushCmd(game, { type: 'cancelProduction', kind: 'struct', structId: q.id });
  } else {
    hudPushCmd(game, { type: 'cancelProduction', kind: 'unit', producerId: q.producerId, unitId: q.id });
  }
}

function hudKeyPress(game, key) {
  const st = game.state;
  if (!st || !game.hud) return false;
  const p = st.players[game.playerSlot];
  const all = buildGridItems(st, p, game.hud.activeTab);
  const items = all.slice(game.hud.page * BUILD_HOTKEYS.length,
    (game.hud.page + 1) * BUILD_HOTKEYS.length);
  const id = hotkeyMapFor(items)[key];
  if (!id) return false;
  const it = items.find((x) => x.id === id);
  activateItem(game, gridItemMeta(game, p, it));
  return true;
}

// ---- tooltip ------------------------------------------------------------------

function attachTooltip(game, el, linesFn) {
  let timer = null;
  el.addEventListener('mouseenter', () => {
    if (typeof setTimeout !== 'function') { return; }
    timer = setTimeout(() => showTooltip(game, linesFn(), el), 200);
  });
  el.addEventListener('mouseleave', () => {
    if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer);
    timer = null;
    hideTooltip();
  });
}

function showTooltip(game, lines, anchor) {
  const el = document.getElementById('tooltip');
  if (!el) return;
  el.innerHTML = '';
  lines.forEach((ln, i) => el.appendChild(h('div', i === 0 ? 'tt-name' : 'tt-line', ln)));
  const r = anchor.getBoundingClientRect();
  // canvas.height is in device px (scaled by dpr); CSS layout uses CSS px
  const dpr = (game && game.dpr) || 1;
  const vh = game.canvas ? game.canvas.height / dpr : 800;
  el.style.left = Math.max(4, r.left) + 'px';
  el.style.bottom = (vh - r.top + 8) + 'px';
  el.style.display = 'block';
}

function hideTooltip() {
  const el = document.getElementById('tooltip');
  if (el) el.style.display = 'none';
}

// ---- under-attack alarm: siren + clickable alert stack -----------------------

let __audioCtx = null;    // shared, created lazily on the first user gesture
let __sfxVol = 1;          // master volume 0..1 (menu slider, localStorage)
try {
  const lv = globalThis.localStorage && globalThis.localStorage.getItem('mca_vol');
  if (lv !== null && lv !== undefined && lv !== '') {
    __sfxVol = Math.max(0, Math.min(1, Number(lv) || 0));
  }
} catch (e) { /* headless / privacy mode: keep default */ }

export function getSfxVolume() { return __sfxVol; }
export function setSfxVolume(v) {
  __sfxVol = Math.max(0, Math.min(1, v));
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem('mca_vol', String(__sfxVol));
  } catch (e) { /* best-effort */ }
}

function ensureAudio() {
  if (__audioCtx) return __audioCtx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null; // headless test stub: no audio, no throw
  try { __audioCtx = new AC(); } catch (e) { __audioCtx = null; }
  return __audioCtx;
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
}

let __noiseBuf = null;
function noiseBuffer(ctx) {
  if (__noiseBuf) return __noiseBuf;
  const len = Math.floor(ctx.sampleRate * 0.5);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  __noiseBuf = buf;
  return buf;
}

// two-tone square siren, ~0.4s at low gain. The fire cadence lives in
// underAttackAlert (per-location escalation, v0.9.0) — this just makes noise.
function playSiren() {
  if (__sfxVol <= 0) return;
  const ctx = ensureAudio();
  if (!ctx || ctx.state === 'suspended') return; // inaudible pre-gesture anyway
  try {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.setValueAtTime(880, t0 + 0.2);
    gain.gain.setValueAtTime(0.08 * __sfxVol, t0);
    gain.gain.linearRampToValueAtTime(0.0001, t0 + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  } catch (e) { /* audio is best-effort */ }
}

// v0.3.6 procedural SFX (no assets; every path guarded for headless stubs)

let __shotAt = -Infinity;
// weapon crack: short noise burst, throttled to one per 120ms
function playShot() {
  const now = nowMs();
  if (now - __shotAt < 120 || __sfxVol <= 0) return;
  const ctx = ensureAudio();
  if (!ctx || ctx.state === 'suspended') return;
  __shotAt = now;
  try {
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.05 * __sfxVol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + 0.1);
  } catch (e) { /* best-effort */ }
}

let __boomAt = -Infinity;
// explosion thump: noise through a lowpass, ~0.45s decay; one per 250ms
function playBoom() {
  const now = nowMs();
  if (now - __boomAt < 250 || __sfxVol <= 0) return;
  const ctx = ensureAudio();
  if (!ctx || ctx.state === 'suspended') return;
  __boomAt = now;
  try {
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(320, t0);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12 * __sfxVol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
    src.connect(lp);
    lp.connect(gain);
    gain.connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + 0.5);
  } catch (e) { /* best-effort */ }
}

let __clickAt = -Infinity;
// UI click: short square blip on button presses
export function playClick() {
  const now = nowMs();
  if (now - __clickAt < 40 || __sfxVol <= 0) return;
  const ctx = ensureAudio();
  if (!ctx || ctx.state === 'suspended') return;
  __clickAt = now;
  try {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t0);
    gain.gain.setValueAtTime(0.03 * __sfxVol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.035);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.04);
  } catch (e) { /* best-effort */ }
}

// top-right alert banner (max 4 stacked, auto-expires after 8s); clicking it
// zooms in, jumps the camera to the battle and pings the minimap
function pushAlert(game, text, wx, wy) {
  const root = document.getElementById('alerts');
  if (!root) return;
  while (root.children.length >= 4) root.removeChild(root.children[0]);
  const b = h('div', 'alert-banner', text);
  let removed = false;
  const drop = () => {
    if (removed) return;
    removed = true;
    // the 4-card cap may have already evicted this banner; only remove if attached
    if (b.parentNode) b.parentNode.removeChild(b);
    else if (root.children.indexOf(b) >= 0) root.removeChild(b);
  };
  b.addEventListener('click', () => {
    if (game.state && game.camera) {
      const cam = game.camera;
      cam.zoom = Math.min(1.35, cam.maxZoom || 2.5);
      centerCameraOn(cam, wx, wy);
      clampCameraToMap(cam, game.state.map.w * CELL, game.state.map.h * CELL);
      addPing(game, wx, wy);
    }
    drop();
  });
  root.appendChild(b);
  if (typeof setTimeout === 'function') {
    setTimeout(() => b.classList.add('fade'), 7200);
    setTimeout(drop, 8000);
  }
}

function underAttackAlert(game, ent, isUnit, c) {
  const st = game.state;
  const H = game.hud;
  const ap = ent.lastHitBy >= 0 ? st.players[ent.lastHitBy] : null;
  const attacker = ap ? ap.faction : 'enemy forces';
  const def = isUnit ? st.unitDefs[ent.defId] : st.structDefs[ent.defId];
  // v0.9.0 siren cadence: per alert LOCATION (the cell of the hit) the siren
  // escalates — the first wail at a spot is immediate, the next two re-arm
  // after >=3s, and every alert after that waits >=8s. The voice line and the
  // minimap ping keep their own throttles; only the siren cadence lives here.
  if (H) {
    const key = Math.floor(c.x / CELL) + ',' + Math.floor(c.y / CELL);
    const esc = H.sirenEsc[key] || 0;
    const lastAt = H.sirenAt[key];
    const gap = esc >= 3 ? 8000 : 3000;
    if (lastAt === undefined || nowMs() - lastAt >= gap) {
      H.sirenEsc[key] = esc + 1;
      H.sirenAt[key] = nowMs();
      playSiren();
    }
  }
  pushAlert(game, 'Under attack: ' + attacker + ' — ' + def.name, c.x, c.y);
  const p = st.players[game.playerSlot];
  voice(game, p.faction, 'attack');
  // battle music for 30s, then back to ambient; a fresh alert inside the
  // window re-arms the timer (stored on game.hud so match restarts clear it)
  music(game, 'battle');
  if (H) {
    if (H.battleTimer && typeof clearTimeout === 'function') clearTimeout(H.battleTimer);
    // v0.9.1: capture the match token — a stale 30s battle->ambient timer
    // from an abandoned match must not clobber the new match's music
    const matchRef = H.stateRef;
    H.battleTimer = typeof setTimeout === 'function'
      ? setTimeout(() => {
          if (H.stateRef !== matchRef) return; // stale match: no-op
          H.battleTimer = null;
          music(game, 'ambient');
        }, 30000)
      : null;
  }
}

// ---- hint banners + cursor flash ----------------------------------------------

export function showHint(game, text) {
  const root = game.hint || document.getElementById('hint');
  if (!root) return;
  // cap concurrent banners at 3 (drop the oldest); child 0 is the persistent
  // MCV hint and is never dropped
  while (root.children.length > 3) {
    const old = root.children[1];
    if (!old) break;
    if (old.__drop) old.__drop(); else root.removeChild(old);
  }
  const b = h('div', 'hint-banner', text);
  let removed = false;
  b.__drop = () => {
    if (removed) return;
    removed = true;
    try { root.removeChild(b); } catch (e) { /* already gone */ }
  };
  root.appendChild(b);
  if (typeof setTimeout === 'function') {
    setTimeout(() => { b.classList.add('fade'); }, 3600);
    setTimeout(b.__drop, 4400);
  }
}

// red reason label flashing at the cursor (failed placement)
export function flashAtCursor(game, text) {
  const el = document.getElementById('cursor-label');
  if (!el) return;
  el.textContent = text;
  el.style.left = (game.mouse.sx + 14) + 'px';
  el.style.top = (game.mouse.sy - 12) + 'px';
  el.classList.remove('flash');
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('flash');
}

// ---- actions (deploy / ability / superweapon) -----------------------------------

function updateActions(game, p) {
  const st = game.state;
  const H = game.hud;
  const mcvSel = game.selection.map((id) => st.units[id])
    .find((u) => u && u.owner === p.slot && u.defId === 'MCV');
  const ability = st.data.factions[p.faction].ability;
  const showAb = ability && !PASSIVE_ABILITIES.includes(ability);
  const abCd = showAb ? Math.ceil(Math.max(0, p.abilityCdUntil - st.tick) / 10) : -1;
  // gate actives on their Unique/SW structure (mirrors validateCommand), so the
  // button never says READY when the sim would reject with 'no-unique'
  const abGateId = showAb ? ABILITY_STRUCT[ability] : null;
  const abGateName = abGateId ? st.structDefs[abGateId].name : null;
  const abGateOk = !abGateId
    || standingStructs(st, p.slot, (s) => s.defId === abGateId).length > 0;
  let hasSw = false;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner === p.slot && st.structDefs[s.defId].type === 'SW') hasSw = true;
  }
  const swSec = hasSw ? Math.ceil(Math.max(0, p.swChargeTicks) / 10) : -1;

  // stance buttons (v0.3.7): shown whenever the selection holds own units
  const selUnitIds = [];
  for (const id of game.selection) {
    const u = st.units[id];
    if (u && u.owner === p.slot) selUnitIds.push(id);
  }
  const firstSelUnit = selUnitIds.length ? st.units[selUnitIds[0]] : null;

  // research kits (v0.3.7): exactly one owned Core/Prod structure selected
  let kits = null;
  if (game.selection.length === 1) {
    const s = st.structures[game.selection[0]];
    if (s && s.owner === p.slot) {
      const sType = st.structDefs[s.defId].type;
      if (sType === 'Prod' || sType === 'Core') {
        const offered = researchKitsFor(st, p, s.defId);
        if (offered.length) kits = offered;
      }
    }
  }

  const sig = [mcvSel ? mcvSel.id : 0, showAb ? abCd : 'x', showAb ? abGateOk : 'x', hasSw ? swSec : 'x',
    game.targeting ? game.targeting.kind : '',
    selUnitIds.join(','), firstSelUnit ? firstSelUnit.stance | 0 : 'x',
    kits ? kits.map((k) => k.id + ':' + (k.owned ? 1 : 0) + ':' + (k.affordable ? 1 : 0)).join(',')
      : 'x'].join('|');
  if (sig === H.actSig) return;
  H.actSig = sig;
  H.actions.innerHTML = '';

  if (mcvSel) {
    const b = h('button', 'bb-action bb-deploy', 'DEPLOY [D]');
    b.addEventListener('click', () => hudPushCmd(game, { type: 'deployMCV', unitId: mcvSel.id }));
    H.actions.appendChild(b);
  }

  // v0.9.0 transports: a lone selected carrier with cargo gets an UNLOAD
  // button (right-clicking the carrier itself also unloads — input.js)
  if (selUnitIds.length === 1) {
    const only = st.units[selUnitIds[0]];
    const onlyDef = only && st.unitDefs[only.defId];
    if (onlyDef && (onlyDef.cls === 'APC' || onlyDef.cls === 'IFV')
        && only.cargo && only.cargo.length) {
      const b = h('button', 'bb-action bb-unload ready',
        'UNLOAD ×' + only.cargo.length);
      b.title = 'Disembark the carried infantry';
      b.addEventListener('click', () => hudPushCmd(game, { type: 'unload', carrierId: only.id }));
      H.actions.appendChild(b);
    }
  }

  if (selUnitIds.length) {
    const row = h('div', 'bb-stance-row');
    const labels = ['AGG', 'DEF', 'HLD', 'HF'];
    const keys = 'ADSF';
    const alts = 'ZXCV';
    for (let n = 0; n < labels.length; n++) {
      const cur = (firstSelUnit.stance | 0) === n;
      const b = h('button', 'bb-action bb-stance' + (cur ? ' on' : ''), labels[n]);
      b.title = STANCE_NAMES[n] + ' [' + alts[n] + ' or Ctrl+Alt+' + keys[n] + ']';
      const stanceN = n;
      b.addEventListener('click', () => {
        hudPushCmd(game, { type: 'setStance', unitIds: selUnitIds.slice(), stance: stanceN });
      });
      row.appendChild(b);
    }
    H.actions.appendChild(row);
  }

  if (kits) {
    for (const k of kits) {
      const usable = !k.owned && k.affordable;
      const b = h('button', 'bb-action bb-kit' + (usable ? '' : ' disabled'),
        k.owned ? 'OWNED' : k.label + ' · ' + k.cost + 'cr');
      if (usable) {
        b.addEventListener('click', () => {
          hudPushCmd(game, { type: 'researchUpgrade', upgradeId: k.id });
        });
      }
      H.actions.appendChild(b);
    }
  }

  if (showAb) {
    const abUsable = abCd === 0 && abGateOk;
    const abLabel = ability.replace(/_/g, ' ')
      + (!abGateOk ? ' · NEEDS ' + abGateName.toUpperCase()
        : abCd > 0 ? ' · ' + abCd + 's' : ' · READY');
    const b = h('button', 'bb-action' + (abUsable ? ' ready' : ''), abLabel);
    if (!abUsable) b.classList.add('disabled');
    if (game.targeting && game.targeting.kind === 'ability') b.classList.add('placing');
    b.addEventListener('click', () => {
      if (abUsable) { game.targeting = { kind: 'ability' }; game.placement = null; }
    });
    H.actions.appendChild(b);
  }

  if (hasSw) {
    const readySw = p.swChargeTicks === 0;
    const b = h('button', 'bb-action' + (readySw ? ' ready' : ' disabled'),
      readySw ? 'SUPERWEAPON — READY' : 'Superweapon · ' + swSec + 's');
    if (game.targeting && game.targeting.kind === 'sw') b.classList.add('placing');
    b.addEventListener('click', () => {
      if (readySw) { game.targeting = { kind: 'sw' }; game.placement = null; }
    });
    H.actions.appendChild(b);
  }
}

// ---- selection panel -------------------------------------------------------------

function updateSelectionPanel(game, st) {
  const H = game.hud;
  const root = document.getElementById('sel-panel');
  const sel = game.selection.filter((id) => st.units[id] || st.structures[id]);
  // inspected hostile (clicked in the fog-visible map) shows when nothing selected
  const insp = game.inspectId ? (st.units[game.inspectId] || st.structures[game.inspectId]) : null;
  // v0.9.1 signature guard: this panel rebuilt its whole DOM every sim tick
  // (40 Hz at 4x) even when nothing visible changed. Rebuild only when the
  // selection ids, an hp, a stance, the inspected id or a cargo count changes.
  let sig = insp && !sel.length ? 'i' + game.inspectId + ':' + insp.hp : '';
  for (let i = 0; i < sel.length; i++) {
    const ent = st.units[sel[i]] || st.structures[sel[i]];
    sig += '|' + sel[i] + ':' + ent.hp
      + (ent.stance !== undefined ? ':' + (ent.stance | 0) : '')
      + (ent.cargo ? ':' + ent.cargo.length : '');
  }
  if (sig === H.selSig) return;
  H.selSig = sig;
  root.innerHTML = '';
  if (insp && !sel.length) {
    appendInfoRows(game, root, st, insp, true);
    return;
  }
  if (!sel.length) return;
  const max = 12;
  for (let i = 0; i < Math.min(sel.length, max); i++) {
    const ent = st.units[sel[i]] || st.structures[sel[i]];
    const def = st.unitDefs[ent.defId] || st.structDefs[ent.defId];
    const row = h('div', 'sel-row');
    const selShape = st.units[sel[i]] ? shapeForUnit(def) : shapeForStructure(def);
    // single selection with a painted plate (pass-3 iconArt): 48px cameo
    // next to the name replaces the small CSS glyph
    const selCameoUri = sel.length === 1 ? iconArtUri(game, ent.defId) : null;
    if (selCameoUri) row.appendChild(cameoImg('sel', selCameoUri));
    else row.appendChild(h('span', 'sel-glyph shape-' + selShape, initialsFor(def.name)));
    row.appendChild(h('span', 'sel-name', def.name));
    row.appendChild(h('span', 'sel-hp', ent.hp + '/' + ent.maxHp));
    const bar = h('span', 'sel-hpbar');
    const fill = h('span');
    fill.style.width = Math.floor(100 * ent.hp / ent.maxHp) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    root.appendChild(row);
  }
  if (sel.length > max) root.appendChild(h('div', 'sel-tip', '… +' + (sel.length - max) + ' more'));
  // v0.3.6: stance readout when units are selected ('G' cycles); v0.4.3: a
  // mixed selection shows a dash instead of the first unit's stance
  const selUnits = sel.map((id) => st.units[id]).filter((u) => u);
  if (selUnits.length) {
    const st0 = selUnits[0].stance | 0;
    const mixed = selUnits.some((u) => (u.stance | 0) !== st0);
    root.appendChild(h('div', 'sel-tip',
      'Stance: ' + (mixed ? '—' : STANCE_NAMES[st0]) + ' [G]'));
  }
  if (sel.length === 1) {
    const ent = st.units[sel[0]] || st.structures[sel[0]];
    appendInfoRows(game, root, st, ent, false);
    const s = st.structures[sel[0]];
    if (s && s.owner === game.playerSlot && st.structDefs[s.defId].type === 'Prod') {
      root.appendChild(h('div', 'sel-tip', 'Right-click the map to set a rally point'));
    }
  }
}

// name/hp header + stat lines for one entity (selection of 1, or inspect)
function appendInfoRows(game, root, st, ent, isInspect) {
  const isUnit = !!st.unitDefs[ent.defId];
  const def = isUnit ? st.unitDefs[ent.defId] : st.structDefs[ent.defId];
  if (isInspect) {
    const row = h('div', 'sel-row');
    const shape = isUnit ? shapeForUnit(def) : shapeForStructure(def);
    row.appendChild(h('span', 'sel-glyph shape-' + shape, initialsFor(def.name)));
    row.appendChild(h('span', 'sel-name', def.name));
    row.appendChild(h('span', 'sel-hp', ent.hp + '/' + ent.maxHp));
    root.appendChild(row);
  }
  const lines = [];
  if (isUnit) {
    if (ent.upgradeName) lines.push('Upgrade: ' + ent.upgradeName);
    lines.push(def.cls + ' · ' + def.domain);
    if (def.range > 0) lines.push('Range ' + def.range + ' · ROF ' + def.rof_s + 's');
    if (def.hardCounter) lines.push('Beaten by (hard): ' + def.hardCounter);
    if (def.softCounter) lines.push('Threatened by (soft): ' + def.softCounter);
    if (def.cls === 'Engineer' && !isInspect) {
      if (ent.capTicks > 0) lines.push(`Capturing… ${ent.capTicks}/${CAPTURE_TICKS}`);
      else lines.push('Attack a structure to capture it');
    }
  } else {
    lines.push(def.type + ' structure');
    if (def.range > 0) lines.push('Range ' + def.range + ' · ROF ' + def.rof_s + 's');
    if (def.power_out > 0) lines.push('Power +' + def.power_out);
    else if (def.power_use > 0) lines.push('Power -' + def.power_use);
  }
  for (const ln of lines) root.appendChild(h('div', 'sel-tip', ln));
}

// ---- tutorial mode (v0.4.4) -----------------------------------------------------
// A guided sandbox, NOT a scripted demo: every system stays live. The step
// machine is pure UI — it only WATCHES game state each frame (never issues
// commands, never touches the sim) and advances when the watched condition
// holds. game.tutor = { step, pulseEl } is armed by main.js when cfg.tutorial
// is set; 'tutorial seen' persists in localStorage so the setup checkbox
// defaults off afterwards.

const TUTOR_SEEN_KEY = 'mca_tutorial_seen';

export function tutorialSeen() {
  try {
    return !!(globalThis.localStorage && globalThis.localStorage.getItem(TUTOR_SEEN_KEY));
  } catch (e) { return false; }
}

function markTutorialSeen() {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(TUTOR_SEEN_KEY, '1');
  } catch (e) { /* best-effort */ }
}

// done(game, st, p) -> true when the step's goal holds; pulse = build-tile id
// to highlight while the step is up (null = no pulse)
const TUTOR_STEPS = [
  { text: 'This is your MCV — left-click it to select it.',
    pulse: null,
    done: (game, st, p) => game.selection.some((id) => {
      const u = st.units[id];
      return u && u.owner === p.slot && u.defId === 'MCV';
    }) },
  { text: 'Press D or double-click the MCV to deploy your Construction Yard. '
      + '(It auto-deploys at 20s if you wait.)',
    pulse: null,
    done: (game, st, p) => standingStructs(st, p.slot, (s) => s.defId === 'SH-01').length > 0 },
  { text: 'Build a Power Plant from the build bar (Q).',
    pulse: 'SH-02',
    done: (game, st, p) => standingStructs(st, p.slot, (s) => s.defId === 'SH-02').length > 0 },
  { text: 'Build an Oil Depot on a gold oil ring — credits flow from oil.',
    pulse: 'SH-03',
    done: (game, st, p) => standingStructs(st, p.slot, (s) => s.defId === 'SH-03').length > 0 },
  { text: 'Build a Barracks, then train a Rifle squad from it.',
    pulse: 'SH-04',
    done: (game, st, p) => Object.keys(st.units).some((id) => {
      const u = st.units[id];
      return u.owner === p.slot && isInfantryCls(st.unitDefs[u.defId].cls);
    }) },
  { text: 'Left-click the map to move your squad — or right-click. A = attack-move, G cycles stance.',
    pulse: null,
    done: (game, st, p) => Object.keys(st.units).some((id) => {
      const u = st.units[id];
      return u.owner === p.slot && (u.order.type === 'move' || u.order.type === 'attackMove');
    }) },
  { text: 'Watch the top bar: credits flow from oil. Good luck, commander!',
    pulse: null,
    done: () => false }, // dismisses on the Begin click
];

function clearTutorPulse(game) {
  const T = game.tutor;
  if (T && T.pulseEl && T.pulseEl.classList) T.pulseEl.classList.remove('tutor-pulse');
  if (T) T.pulseEl = null;
}

function hideTutorOverlay(game) {
  const el = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('tutor') : null;
  if (el) {
    el.innerHTML = '';
    if (el.classList) el.classList.add('hidden');
  }
  game._tutorSig = '';
}

function endTutorial(game, seen) {
  clearTutorPulse(game);
  game.tutor = null;
  hideTutorOverlay(game);
  if (seen) markTutorialSeen();
}

// Skip link / Esc: exits the overlay cleanly at any step (match keeps running)
export function skipTutorial(game) {
  endTutorial(game, true);
}

// match abandoned / menu exit mid-tutorial: close the overlay without
// counting the tutorial as seen
export function abortTutorial(game) {
  endTutorial(game, false);
}

// per-frame driver, called from the main loop (and once from startMatch)
export function updateTutorial(game) {
  const T = game.tutor;
  if (!T) return;
  const st = game.state;
  if (!st || st.over) { endTutorial(game, false); return; }
  const p = st.players[game.playerSlot];
  const el = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('tutor') : null;
  if (!el) return;
  // advance at most one step per frame, and only after the current prompt has
  // been on screen for a frame (S1's MCV is auto-selected at match start —
  // without this guard it would chain to S2 before ever being visible)
  if (game._tutorSig === 'step' + T.step && T.step < TUTOR_STEPS.length - 1
    && TUTOR_STEPS[T.step].done(game, st, p)) {
    clearTutorPulse(game);
    T.step++;
  }
  const sig = 'step' + T.step;
  if (sig !== game._tutorSig) {
    game._tutorSig = sig;
    el.innerHTML = '';
    if (el.classList) el.classList.remove('hidden');
    const box = h('div', 'tutor-box');
    box.appendChild(h('div', 'tutor-eva', 'EVA briefing — tutorial '
      + (T.step + 1) + '/' + TUTOR_STEPS.length));
    box.appendChild(h('div', 'tutor-text', TUTOR_STEPS[T.step].text));
    const row = h('div', 'tutor-row');
    if (T.step === TUTOR_STEPS.length - 1) {
      const begin = h('button', 'tutor-done', 'Begin');
      begin.addEventListener('click', () => endTutorial(game, true));
      row.appendChild(begin);
    }
    const skip = h('span', 'tutor-skip', 'Skip tutorial');
    skip.addEventListener('click', () => skipTutorial(game));
    row.appendChild(skip);
    box.appendChild(row);
    el.appendChild(box);
  }
  // keep the pulse on the current step's build tile (tiles rebuild on grid
  // signature changes, so re-assert the class every frame — it's idempotent)
  const pulseId = TUTOR_STEPS[T.step].pulse;
  if (pulseId && game.hud && game.hud.tiles[pulseId]) {
    const tile = game.hud.tiles[pulseId].el;
    if (T.pulseEl !== tile) {
      clearTutorPulse(game);
      T.pulseEl = tile;
    }
    if (tile.classList) tile.classList.add('tutor-pulse');
  }
}
