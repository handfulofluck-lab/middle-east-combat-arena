// In-match HUD.
//
//   top-left     resources: faction crest, credits (animated) + income, power meter
//   top-centre   mission clock; below it: tutorial card, hint banners, badges
//   top-right    system cluster: net status, zoom, speed, pause, audio, menu
//   right        command panel: production tabs, 3x2 cameo grid (Q W E / R T F),
//                research kits, queue strip — with ability + superweapon
//                widgets docked above it
//   bottom-left  army panel (branch fractions + control groups) over the minimap
//   bottom-mid   selection panel: portraits, health, veterancy, stances, orders
//
// The button enable/disable logic stays pure (trainButtonState /
// structureButtonState / buildGridItems / hotkeyMapFor / tooltipLines) so it
// can be exercised headlessly. DOM is rebuilt only when a structural
// signature changes; per-tick updates touch classes / text / widths only, so
// hover states and tooltips survive production ticks.
import {
  CELL, validateCommand, requiredProducer, trainCost, buildCost,
  standingStructs, structCenter, ABILITY_STRUCT,
  mapHasWater, isHostile, isInfantryCls, CAPTURE_TICKS,
} from '../sim/index.js';
import { screenToWorld, centerCameraOn, clampCameraToMap, zoomCameraAt } from './camera.js';
import { glScreenToWorld } from './gl.js';
import { factionColorOf, initialsFor } from './sprites.js';
import { addPing } from './minimap.js';
import * as Audio from './audio.js';
import { h, el, icon, clear, fmtInt, fmtClock, fmtSecs, titleCase, legible } from '../ui/dom.js';
import { crest } from '../ui/brand.js';
import { makeCameo, refreshCameos, hasIconArt } from '../ui/cameo.js';
import { abilityInfo, superweaponInfo } from '../ui/lore.js';
import * as Settings from '../ui/settings.js';

const TABS = [
  { id: 'structures', label: 'Structures', short: 'Build', prod: null },   // needs ConYard (SH-01)
  { id: 'infantry', label: 'Infantry', short: 'Inf', prod: 'SH-04' },
  { id: 'vehicles', label: 'Vehicles', short: 'Veh', prod: 'SH-05' },
  { id: 'air', label: 'Air', short: 'Air', prod: 'SH-06' },
  { id: 'naval', label: 'Naval', short: 'Navy', prod: 'SH-07' },
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
const RANK_NAMES = ['', 'Veteran', 'Elite', 'Heroic'];
const SW_CHARGE_TICKS = 3000;   // mirrors sim/orders.js (300s)
const ABILITY_CD_TICKS = 900;   // mirrors sim/orders.js (90s)

// heavy entity scans run at most every ~90ms real time (see updateHud) —
// 120 Hz displays tick at ~99.96ms at 1x, so 90 keeps 1x ungated
const HEAVY_SCAN_MS = 90;
const SEL_TILE_MAX = 24;

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

// the producer whose queue a tab focuses: the selected producer wins; else
// the first owned producer with a non-empty queue
function focusedProducer(state, player, tab, selection) {
  for (const id of (selection || [])) {
    const s = state.structures[id];
    if (s && s.owner === player.slot && s.defId === tab.prod) return { prod: s, focused: true };
  }
  for (const id in state.structures) {
    const s = state.structures[id];
    if (s.owner === player.slot && s.defId === tab.prod && s.queue && s.queue.length) {
      return { prod: s, focused: false };
    }
  }
  return { prod: null, focused: true };
}

// v0.3.7 build queue strip (DeepSeek T7): first 3 queue entries, oldest
// first, of the focused producer for a tab. The structures tab reads the
// player-level build queue (producerId 0 = cancel via structId).
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
  const prod = focusedProducer(state, player, tab, selection).prod;
  if (!prod || !prod.queue) return out;
  for (let i = 0; i < prod.queue.length && out.length < 3; i++) {
    const q = prod.queue[i];
    out.push({ kind: 'unit', id: q.unitId, producerId: prod.id,
      progress: q.progress, total: q.total });
  }
  return out;
}

// full length of the queue the strip is showing (for the "+N" overflow chip)
function queueTotal(state, player, tabId, selection) {
  if (tabId === 'structures') return (player.buildQueue || []).length;
  const tab = TABS.find((t) => t.id === tabId);
  if (!tab || !tab.prod) return 0;
  const prod = focusedProducer(state, player, tab, selection).prod;
  return prod && prod.queue ? prod.queue.length : 0;
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
  { id: 'air', label: 'Air', ico: 'air' },
  { id: 'armor', label: 'Armor', ico: 'vehicles' },
  { id: 'inf', label: 'Infantry', ico: 'infantry' },
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
// (the plain-text model; the on-screen card is richer, see buildItemTip)
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

// ---- small helpers ------------------------------------------------------------

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
}

function hudPushCmd(game, cmd) {
  cmd.player = game.playerSlot;
  game.pendingCmds.push(cmd);
}

// audio.js ships independently; every call is feature-tested and guarded —
// audio is always best-effort and never blocks a frame
function sfx(game, name) {
  try { if (typeof Audio.playSfx === 'function') Audio.playSfx(game, name); } catch (e) { /* no-op */ }
}
function music(game, track) {
  try { if (typeof Audio.playMusicTrack === 'function') Audio.playMusicTrack(game, track); } catch (e) { /* no-op */ }
}
function voice(game, faction, key, detail) {
  try { if (typeof Audio.playVoice === 'function') Audio.playVoice(game, faction, key, detail); } catch (e) { /* no-op */ }
}
// keep unlockAudio reachable through this module for existing callers
export function unlockAudio() {
  try { if (typeof Audio.unlockAudio === 'function') Audio.unlockAudio(); } catch (e) { /* no-op */ }
}

// master volume (legacy names; the Settings screen owns the full mixer)
export function getSfxVolume() { return Settings.getMasterVolume(); }
export function setSfxVolume(v) { Settings.setMasterVolume(v); }

let __shotAt = -Infinity;
let __boomAt = -Infinity;
let __clickAt = -Infinity;
// weapon crack for a fresh on-screen tracer, throttled to one per 120ms
function playShot(game) {
  const now = nowMs();
  if (now - __shotAt < 120) return;
  __shotAt = now;
  sfx(game, 'shot');
}
// explosion thump when the entity count drops; one per 250ms
function playBoom(game) {
  const now = nowMs();
  if (now - __boomAt < 250) return;
  __boomAt = now;
  sfx(game, 'boom');
}
// UI click blip
export function playClick() {
  const now = nowMs();
  if (now - __clickAt < 40) return;
  __clickAt = now;
  sfx(null, 'ui_click');
}

function worldUnderCursor(game) {
  if (game.gfx === '3d' && game.gl) {
    try { return glScreenToWorld(game, game.mouse.sx, game.mouse.sy); } catch (e) { /* fall through */ }
  }
  return screenToWorld(game.camera, game.mouse.sx, game.mouse.sy);
}

function iconBtn(ico, label, cls) {
  const b = el('button', { class: 'tb-btn tb-ico-btn' + (cls ? ' ' + cls : ''), type: 'button', 'aria-label': label });
  b.appendChild(icon(ico));
  return b;
}

// ---- init -----------------------------------------------------------------------

export function initHud(game) {
  Settings.applyGlassBlur();

  // ── top bar ──────────────────────────────────────────────────────────────
  const top = document.getElementById('topbar');
  clear(top);

  // left: resources
  const left = h('div', 'tb-cluster tb-left panel');
  const crestSlot = h('span', 'tb-crest');
  left.appendChild(crestSlot);
  const credWrap = h('div', 'tb-stat tb-credits-wrap');
  credWrap.appendChild(icon('credit'));
  const credCol = h('div', 'tb-col');
  credCol.appendChild(h('span', 'tb-label', 'Credits'));
  const creditsEl = h('span', 'tb-credits num', '0');
  credCol.appendChild(creditsEl);
  credWrap.appendChild(credCol);
  const incomeEl = h('span', 'tb-income num', '');
  credWrap.appendChild(incomeEl);
  left.appendChild(credWrap);
  left.appendChild(h('span', 'tb-sep'));
  const pw = h('div', 'tb-stat tb-power');
  pw.appendChild(icon('bolt'));
  const pwCol = h('div', 'tb-col');
  const pwTop = h('div', 'tb-power-top');
  pwTop.appendChild(h('span', 'tb-label', 'Power'));
  const powerDot = h('span', 'tb-power-dot ok');
  pwTop.appendChild(powerDot);
  const powerEl = h('span', 'tb-val num', '0 / 0');
  pwTop.appendChild(powerEl);
  pwCol.appendChild(pwTop);
  const pwMeter = h('div', 'tb-power-meter');
  const pwFill = h('span');
  pwMeter.appendChild(pwFill);
  pwCol.appendChild(pwMeter);
  pw.appendChild(pwCol);
  const pwWarn = el('span', { class: 'tb-power-warn' }, [icon('warn'), 'Low power']);
  pw.appendChild(pwWarn);
  left.appendChild(pw);
  top.appendChild(left);
  attachTooltip(game, credWrap, () => simpleTip('Credits',
    ['Earned by harvesters hauling oil to your depots.', 'The green figure is your income over the last 30 seconds.']), { side: 'below' });
  attachTooltip(game, pw, () => {
    const st = game.state;
    const p = st ? st.players[game.playerSlot] : null;
    const pen = st ? Math.round((st.data.knobs.LowPowerPenalty || 0) * 100) : 40;
    return simpleTip('Power', [
      p ? 'Using ' + p.powerUse + ' of ' + p.powerOut + ' produced.' : 'Used / produced.',
      'When demand exceeds supply, production slows by ' + pen + '%. Build Power Plants.',
    ]);
  }, { side: 'below' });

  // centre: mission clock
  const mid = h('div', 'tb-cluster tb-center panel');
  mid.appendChild(h('span', 'tb-label', 'Mission time'));
  const clockEl = h('span', 'tb-clock num', '0:00');
  mid.appendChild(clockEl);
  top.appendChild(mid);

  // right: system cluster
  const right = h('div', 'tb-cluster tb-right panel');

  // v0.10.0 multiplayer: connection dot + worst-peer RTT in the top bar
  const netSpan = h('span', 'tb-net');
  netSpan.id = 'net-status';
  const netDot = h('span', 'net-dot good');
  const netText = h('span', null, '');
  netSpan.appendChild(netDot);
  netSpan.appendChild(netText);
  netSpan.style.display = 'none';
  right.appendChild(netSpan);
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
    if (netText.textContent !== txt) netText.textContent = txt;
  }

  // v0.6.0 zoom control: [-] slider [+] for mouse users. The slider drives
  // zoomCameraAt centered on the screen middle; updateHud syncs it back from
  // camera.zoom wherever the zoom changed.
  const zoomAtCenter = (f) => {
    const cam = game.camera;
    if (!cam) return;
    zoomCameraAt(cam, f, cam.viewW / 2, cam.viewH / 2);
    if (game.state) {
      clampCameraToMap(cam, game.state.map.w * CELL, game.state.map.h * CELL);
    }
  };
  const zoomSpan = h('span', 'tb-zoom');
  const zoomOutBtn = iconBtn('minus', 'Zoom out', 'tb-zoom-btn');
  const zoomSlider = h('input', 'tb-zoom-slider slider');
  zoomSlider.type = 'range';
  zoomSlider.min = '0.16'; // camera.js minZoom (v0.9.0: whole-base view)
  zoomSlider.max = '2.5';  // camera.js maxZoom
  zoomSlider.step = '0.05';
  zoomSlider.value = '1';
  zoomSlider.disabled = true; // no camera until a match starts
  zoomSlider.setAttribute('aria-label', 'Zoom');
  const zoomInBtn = iconBtn('plus', 'Zoom in', 'tb-zoom-btn');
  const syncZoomFill = () => {
    const lo = Number(zoomSlider.min), hi = Number(zoomSlider.max);
    zoomSlider.style.setProperty('--v', Math.round(100 * (Number(zoomSlider.value) - lo) / (hi - lo)) + '%');
  };
  zoomOutBtn.addEventListener('click', () => { if (game.camera) zoomAtCenter(1 / 1.15); });
  zoomInBtn.addEventListener('click', () => { if (game.camera) zoomAtCenter(1.15); });
  zoomSlider.addEventListener('input', () => {
    const z = Number(zoomSlider.value);
    const cam = game.camera;
    syncZoomFill();
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
  right.appendChild(zoomSpan);
  attachTooltip(game, zoomSpan, () => simpleTip('Zoom', ['Also on the + and − keys.']), { side: 'below' });
  right.appendChild(h('span', 'tb-sep'));

  const speedWrap = h('div', 'tb-speed');
  const speedBtns = {};
  for (const s of [1, 2, 4]) {
    const b = el('button', { class: 'tb-btn tb-speed-btn' + (s === 1 ? ' active' : ''), type: 'button', 'aria-label': 'Game speed ' + s + 'x' }, [s + '×']);
    b.addEventListener('click', () => {
      if (game.overlay) return; // an overlay owns the UI right now
      if (game.net && game.net.active) return; // speed is locked to 1x in MP
      game.speed = s; game.paused = false;
      refreshSpeed();
    });
    speedBtns[s] = b;
    speedWrap.appendChild(b);
  }
  right.appendChild(speedWrap);
  attachTooltip(game, speedWrap, () => simpleTip('Game speed', ['Skirmish only — multiplayer always runs at 1×.']), { side: 'below' });
  const pauseBtn = iconBtn('pause', 'Pause');
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
  right.appendChild(pauseBtn);
  attachTooltip(game, pauseBtn, () => simpleTip(game.paused ? 'Resume' : 'Pause', []), { side: 'below' });
  right.appendChild(h('span', 'tb-sep'));
  // music on/off (v0.3.7): reflects game.musicOn; audio.js persists the choice
  const musicBtn = iconBtn('music', 'Music', game.musicOn !== false ? 'active' : '');
  musicBtn.addEventListener('click', () => {
    game.musicOn = game.musicOn === false;
    Settings.setMusic(game, game.musicOn);
    syncAudioBtns();
  });
  right.appendChild(musicBtn);
  attachTooltip(game, musicBtn, () => simpleTip('Music ' + (game.musicOn ? 'on' : 'off'), []), { side: 'below' });
  const muteBtn = iconBtn('volume', 'Mute effects');
  muteBtn.addEventListener('click', () => {
    Settings.setMutedPref(game, !Settings.getMuted(game));
    syncAudioBtns();
  });
  if (!Settings.muteAvailable()) muteBtn.style.display = 'none';
  right.appendChild(muteBtn);
  attachTooltip(game, muteBtn, () => simpleTip(Settings.getMuted(game) ? 'Unmute effects' : 'Mute effects', [], ['M']), { side: 'below' });
  function syncAudioBtns() {
    musicBtn.classList.toggle('active', !!game.musicOn);
    musicBtn.setAttribute('aria-pressed', game.musicOn ? 'true' : 'false');
    const m = Settings.getMuted(game);
    if (muteBtn.dataset.m !== String(m)) {
      muteBtn.dataset.m = String(m);
      clear(muteBtn);
      muteBtn.appendChild(icon(m ? 'mute' : 'volume'));
      muteBtn.classList.toggle('warn', m);
      muteBtn.setAttribute('aria-pressed', m ? 'true' : 'false');
    }
  }
  const menuBtn = el('button', { class: 'tb-btn tb-menu-btn', type: 'button', 'aria-label': 'Menu' }, [icon('menu'), h('span', null, 'Menu')]);
  menuBtn.addEventListener('click', () => { if (game.openMenu) game.openMenu(); });
  right.appendChild(menuBtn);
  attachTooltip(game, menuBtn, () => simpleTip('Pause menu', [], ['Esc']), { side: 'below' });
  top.appendChild(right);

  function refreshSpeed() {
    // v0.10.0: in MP the speed is locked to 1x (the lockstep gate paces every
    // peer) so the 1x/2x/4x buttons disappear; pause becomes host-only
    const mp = !!(game.net && game.net.active && game.state);
    if (mp && game.speed !== 1) game.speed = 1;
    for (const s of [1, 2, 4]) {
      speedBtns[s].classList.toggle('active', !game.paused && game.speed === s);
      speedBtns[s].style.display = mp ? 'none' : '';
    }
    speedWrap.style.display = mp ? 'none' : '';
    pauseBtn.classList.toggle('active', !!game.paused);
    if (pauseBtn.dataset.p !== String(!!game.paused)) {
      pauseBtn.dataset.p = String(!!game.paused);
      clear(pauseBtn);
      pauseBtn.appendChild(icon(game.paused ? 'play' : 'pause'));
    }
    pauseBtn.style.display = (mp && !(game.net && game.net.isHost)) ? 'none' : '';
    mid.classList.toggle('paused', !!game.paused);
    // spectating badge + 'Paused by X' banner
    const spec = document.getElementById('spec-badge');
    if (spec && spec.classList) {
      spec.classList.toggle('hidden', !(mp && game.spectating && !game.state.over));
    }
    const pb = document.getElementById('pause-banner');
    if (pb && pb.classList) {
      const show = mp && game.paused && !!game.mpPauseName;
      pb.classList.toggle('hidden', !show);
      if (show) pb.textContent = 'Paused by ' + game.mpPauseName;
    }
    syncAudioBtns();
    updateNetStatus();
  }
  game.hudSyncSpeed = refreshSpeed; // main.js syncs after overlay-driven changes

  // ── command panel ────────────────────────────────────────────────────────
  const bar = document.getElementById('buildbar');
  clear(bar);
  const powers = h('div', 'cmd-powers');
  bar.appendChild(powers);
  const panel = h('div', 'cmd-panel panel chamfer');
  const head = h('div', 'cmd-head');
  head.appendChild(h('span', 'micro', 'Command'));
  const cmdTitle = h('span', 'cmd-title', '');
  head.appendChild(cmdTitle);
  const pageLbl = h('span', 'bb-page num', '');
  head.appendChild(pageLbl);
  // the tile grid is one page of 6 (QWERTF), paged by Tab and by the ‹ ›
  // arrows whenever a tab holds more than 6 items
  const pagePrev = el('button', { class: 'bb-arrow bb-prev', type: 'button', 'aria-label': 'Previous build page' }, [icon('chevL')]);
  const pageNext = el('button', { class: 'bb-arrow bb-next', type: 'button', 'aria-label': 'Next build page' }, [icon('chevR')]);
  head.appendChild(pagePrev);
  head.appendChild(pageNext);
  panel.appendChild(head);
  const tabs = h('div', 'bb-tabs');
  tabs.setAttribute('role', 'tablist');
  panel.appendChild(tabs);
  const row = h('div', 'bb-row');
  const grid = h('div', 'bb-grid');
  const empty = h('div', 'bb-empty');
  row.appendChild(grid);
  row.appendChild(empty);
  panel.appendChild(row);
  const kitsEl = h('div', 'bb-kits');
  panel.appendChild(kitsEl);
  // v0.3.7: compact queue strip under the tile grid (focused producer)
  const queueStrip = h('div', 'bb-queue');
  queueStrip.style.display = 'none';
  panel.appendChild(queueStrip);
  bar.appendChild(panel);
  pagePrev.addEventListener('click', () => { if (game.hudPrevPage) game.hudPrevPage(); });
  pageNext.addEventListener('click', () => { if (game.hudNextPage) game.hudNextPage(); });
  attachTooltip(game, pageNext, () => simpleTip('Next page', [], ['Tab']), { dock: panel });

  // ── selection panel ──────────────────────────────────────────────────────
  const selRoot = document.getElementById('sel-panel');
  clear(selRoot);
  const selCard = h('div', 'sel-card panel chamfer');
  const selInfo = h('div', 'sel-info');
  const actions = h('div', 'sel-actions bb-actions');
  selCard.appendChild(selInfo);
  selCard.appendChild(actions);
  selRoot.appendChild(selCard);

  // ── army panel (v0.5.1): fraction selection per branch, docked above the
  // minimap; counts refresh on the heavy-scan cadence (signature-guarded)
  const apRoot = document.getElementById('army-panel');
  clear(apRoot);
  apRoot.classList.add('panel');
  const apHead = el('button', { class: 'ap-head', type: 'button', 'aria-expanded': 'true' }, [
    h('span', 'micro', 'Army'), h('span', 'ap-total num', ''), icon('chevD'),
  ]);
  const apBody = h('div', 'ap-body');
  apRoot.appendChild(apHead);
  apRoot.appendChild(apBody);
  const apRows = {};
  for (const br of ARMY_BRANCHES) {
    const r = h('div', 'ap-row');
    r.appendChild(icon(br.ico));
    r.appendChild(h('span', 'ap-name', br.label));
    const cnt = h('span', 'ap-count num', '×0');
    r.appendChild(cnt);
    const btns = [];
    for (const pct of [0.25, 0.5, 1]) {
      const b = h('button', 'ap-btn', Math.round(pct * 100) + '%');
      b.type = 'button';
      b.title = 'Select ' + Math.round(pct * 100) + '% of your ' + br.label.toLowerCase() + ' (Shift adds)';
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
        game.hudDirty = true;
        sfx(game, 'select');
      });
      r.appendChild(b);
      btns.push(b);
    }
    apBody.appendChild(r);
    apRows[br.id] = { count: cnt, btns };
  }
  // control groups (Ctrl+1..9 in input.js) surfaced as recall chips
  const apGroups = h('div', 'ap-groups');
  apBody.appendChild(apGroups);

  // ── hint banners (persistent MCV hint is the first child) ────────────────
  const hintRoot = document.getElementById('hint');
  clear(hintRoot);
  const hintMcv = h('div', 'hint-banner mcv',
    'Select your MCV — press D or double-click it to deploy the Construction Yard');
  hintMcv.style.display = 'none';
  hintRoot.appendChild(hintMcv);

  game.hud = {
    creditsEl, powerDot, powerEl, clockEl, tabs, grid, actions,
    incomeEl, pwFill, pwWarn, pwWrap: pw, crestSlot, clockWrap: mid,
    zoomSlider, syncZoomFill, // v0.6.0 top-bar zoom control (synced from camera.zoom)
    pagePrev, pageNext, pageLbl, cmdTitle, // one-page grid paging
    speedBtns, // v0.10.0 top-bar speed buttons (hidden in MP)
    panel, empty, kits: kitsEl, powers, selRoot, selCard, selInfo,
    activeTab: 'structures', tiles: {}, tabSig: '', gridSig: '', actSig: '',
    selSig: '', kitSig: '', powSig: '', emptySig: '',
    selRefs: null, powRefs: null,
    stateRef: null, knownStructs: {}, lastReadyCount: 0, lastFaction: null, hintMcv,
    page: 0, hitSeen: {}, hitPing: {}, hintMcvTxt: '',
    sirenEsc: {}, sirenAt: {}, // v0.9.0 per-location siren cadence
    idleSince: {}, idleWarnAt: -9999,   // idle-worker banner bookkeeping (v0.3.6)
    tracerSeen: {}, lastEntCount: -1,   // SFX hooks: new tracers / entity deaths
    queue: queueStrip, queueSig: '', queueEls: [], // build queue strip (v0.3.7)
    queueLbl: null, queueLblSig: '', queueMore: null,
    knownUnits: {}, battleTimer: null, endFired: false, // voices, battle-music timer, end stinger (v0.3.7)
    lastHeavyMs: -1e9, heavyScans: 0, // heavy-scan 10 Hz gate (v0.4.4, DeepSeek 3.2)
    army: { root: apRoot, rows: apRows, collapsed: false, sig: '', groups: apGroups, groupSig: '', total: apHead.querySelector('.ap-total') },
    credShown: 0, credTarget: 0, credText: '', incSamples: [], incText: '',
    syncAudioBtns,
  };
  apHead.addEventListener('click', () => {
    const A = game.hud.army;
    A.collapsed = !A.collapsed;
    apRoot.classList.toggle('closed', A.collapsed);
    apHead.setAttribute('aria-expanded', A.collapsed ? 'false' : 'true');
  });
  game.hudFocusBuild = () => {
    game.hud.activeTab = 'structures';
    game.hud.tabSig = '';
    updateHud(game);
  };
  const turnPage = (dir) => {
    const st2 = game.state;
    if (!st2) return;
    const p2 = st2.players[game.playerSlot];
    const count = buildGridItems(st2, p2, game.hud.activeTab).length;
    const pages = Math.max(1, Math.ceil(count / BUILD_HOTKEYS.length));
    game.hud.page = (game.hud.page + dir + pages) % pages;
    game.hud.tabSig = '';
    updateHud(game);
  };
  game.hudPrevPage = () => turnPage(-1);
  game.hudNextPage = () => turnPage(1);
  game.hudKeyPress = (key) => hudKeyPress(game, key);
  game.hint = hintRoot;
  game.hud.refreshNet = updateNetStatus; // v0.10.0: RTT refresh on the heavy cadence
  // renderers may call this after a batch of portraits lands in game.iconArt
  game.refreshIcons = () => refreshCameos();

  // ── chat: own-line echo + a transient feed while the box is closed ───────
  initChatFeed(game);

  // HUD buttons click softly unless they already speak (build / select)
  const hudRoot = document.getElementById('hud');
  if (hudRoot && !hudRoot.__sfxBound) {
    hudRoot.__sfxBound = true;
    hudRoot.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      // a mouse click must not leave the button focused: Space / Enter are
      // battlefield hotkeys and would re-press it (keyboard clicks have detail 0)
      if (e.detail > 0 && b.blur) b.blur();
      if (b.dataset.sfx === 'none' || b.classList.contains('bb-tile') || b.classList.contains('ap-btn')) return;
      sfx(game, b.classList.contains('disabled') || b.getAttribute('aria-disabled') === 'true' ? 'ui_deny' : 'ui_click');
    });
    // no browser context menu over HUD panels (right-click is cancel / order)
    hudRoot.addEventListener('contextmenu', (e) => {
      const tag = e.target && e.target.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault();
    });
  }
  // A drag that starts on the battlefield and is released over a HUD panel
  // never reaches the canvas: hand the release back so box-selects and
  // drag-moves always complete (input.js finishes them at the last map point).
  if (typeof window !== 'undefined' && window.addEventListener && !game._hudDragRelay) {
    game._hudDragRelay = true;
    window.addEventListener('mouseup', (e) => {
      const cv = game.inputCanvas;
      if (!game.state || !cv || e.target === cv) return;
      const pending = (e.button === 0 && (game.drag || game.dragMove)) || (e.button === 1 && game.midDrag);
      if (!pending) return;
      try {
        cv.dispatchEvent(new MouseEvent('mouseup', {
          button: e.button, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
          clientX: e.clientX, clientY: e.clientY, bubbles: false,
        }));
      } catch (err) { game.drag = null; game.dragMove = null; game.midDrag = null; }
    });
  }

  // audio.js boot + browser gesture gate: create/resume the shared
  // AudioContext on the first click/keypress
  try { if (typeof Audio.initAudio === 'function') Audio.initAudio(game); } catch (e) { /* no-op */ }
  if (typeof window !== 'undefined' && window.addEventListener && !game._hudAudioGate) {
    game._hudAudioGate = true;
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
  }

  // cosmetic frame loop: credit roll-up, instant selection feedback, cinematic fade
  if (typeof requestAnimationFrame === 'function' && !game._hudRaf) {
    game._hudRaf = true;
    const frame = () => {
      try { cosmeticFrame(game); } catch (e) { /* cosmetic only */ }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}

// per-animation-frame polish; never touches sim state
function cosmeticFrame(game) {
  const H = game.hud;
  const body = document.body;
  if (!H || !body) return;
  // a tooltip must not outlive its control (panel rebuilt, HUD hidden, …)
  if (__tipOwner && (!__tipOwner.isConnected || __tipOwner.offsetParent === null)) hideTooltip();
  // the HUD steps aside for in-engine cinematics (intro fly-in, verdict)
  const cine = !!(game.cinema && game.cinema.active);
  if (cine !== H._cine) { H._cine = cine; body.classList.toggle('cine-on', cine); }
  if (!game.state) return;
  // a match is live: the front-end backdrop must never sit over the world
  if (body.classList.contains('fe-idle')) body.classList.remove('fe-idle');
  // input.js flags selection changes between sim ticks
  if (game.hudDirty) {
    game.hudDirty = false;
    updateHud(game, true);
  }
  // credits roll toward the true balance
  if (H.credShown !== H.credTarget) {
    const d = H.credTarget - H.credShown;
    const step = Math.abs(d) < 3 ? d : d * 0.22;
    H.credShown = Math.abs(d) < 0.5 ? H.credTarget : H.credShown + step;
    const txt = fmtInt(Math.round(H.credShown));
    if (txt !== H.credText) { H.credText = txt; H.creditsEl.textContent = txt; }
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
    H.kitSig = ''; H.powSig = ''; H.emptySig = '';
    H.page = 0; H.hitSeen = {}; H.hitPing = {}; H.hintMcvTxt = '';
    H.sirenEsc = {}; H.sirenAt = {}; // v0.9.0 siren cadence is per match
    H.idleSince = {}; H.idleWarnAt = -9999;
    H.tracerSeen = {}; H.lastEntCount = -1;
    H.incSamples = []; H.incText = '';
    H.credShown = Math.floor(p.credits); H.credTarget = H.credShown; H.credText = '';
    H.army.sig = ''; H.army.groupSig = '';
    const alerts = document.getElementById('alerts');
    if (alerts) clear(alerts);
    // new match: module-level SFX/voice throttles must not carry over — a
    // rematch seconds after the last battle still gets fresh voice lines
    __shotAt = -Infinity; __boomAt = -Infinity; __clickAt = -Infinity;
    try { if (typeof Audio.resetAudioThrottles === 'function') Audio.resetAudioThrottles(); } catch (e) { /* no-op */ }
    // new-match audio: ambient track + faction 'command online' line
    music(game, 'ambient');
    voice(game, p.faction, 'online');
  }

  // end-of-match stinger: mirrors main.js's banner condition (team winner)
  if (!H.endFired && (st.over || p.eliminated)) {
    H.endFired = true;
    sfx(game, st.over && st.winner === p.team && !p.eliminated ? 'victory' : 'defeat');
  }

  // faction accent + crest once per match
  if (H.lastFaction !== p.faction) {
    H.lastFaction = p.faction;
    const col = factionColorOf(st.data, p.faction);
    const doc = document.documentElement;
    if (doc && doc.style && typeof doc.style.setProperty === 'function') {
      doc.style.setProperty('--accent', legible(col));
      doc.style.setProperty('--accent-dim', col + '59');
    }
    clear(H.crestSlot);
    H.crestSlot.appendChild(crest(st.data, p.faction, 'crest-md'));
    H.crestSlot.title = p.faction + ' — ' + (st.data.factions[p.faction].identity || '');
  }

  // ── top bar ──
  H.credTarget = Math.floor(p.credits);
  if (H.credText === '') {
    H.credShown = H.credTarget;
    H.credText = fmtInt(H.credTarget);
    H.creditsEl.textContent = H.credText;
  }
  const ratio = p.powerOut > 0 ? p.powerUse / p.powerOut : (p.powerUse > 0 ? 2 : 0);
  const pcls = p.lowPower ? 'low' : ratio > 0.8 ? 'amber' : 'ok';
  const psig = pcls + '|' + p.powerUse + '|' + p.powerOut;
  if (psig !== H._psig) {
    H._psig = psig;
    H.powerDot.className = 'tb-power-dot ' + pcls;
    H.powerEl.textContent = p.powerUse + ' / ' + p.powerOut;
    H.pwFill.style.width = Math.round(Math.min(1, ratio) * 100) + '%';
    H.pwWrap.className = 'tb-stat tb-power ' + pcls;
  }
  const ck = fmtClock(st.tick);
  if (ck !== H._ck) { H._ck = ck; H.clockEl.textContent = ck; }
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
        H.syncZoomFill();
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
    if (game.mouse && game.mouse.inside && game.camera && game.selection.some((id) => {
      const u = st.units[id];
      return u && u.owner === p.slot && st.unitDefs[u.defId].cls === 'Engineer';
    })) {
      const w = worldUnderCursor(game);
      const cx = Math.floor(w.x / CELL), cy = Math.floor(w.y / CELL);
      capCursor = Object.values(st.structures).some((s) => isHostile(st, p.slot, s)
        && cx >= s.cx && cx < s.cx + s.fp && cy >= s.cy && cy < s.cy + s.fp);
    }
    document.body.classList.toggle('capture', capCursor);
  }

  // persistent deploy hint until the first ConYard exists
  let hasCy = false, hasMcvUnit = false;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner === p.slot && s.defId === 'SH-01') hasCy = true;
  }
  for (const id in st.units) {
    const u = st.units[id];
    if (u.owner === p.slot && u.defId === 'MCV') hasMcvUnit = true;
  }
  H.hintMcv.style.display = (!hasCy && hasMcvUnit && !st.over) ? 'block' : 'none';
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
    showHint(game, st.structDefs[newId].name + ' ready — place it from the command panel');
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
    updateIncome(game, st, p);
  }

  updateTabs(game, p);
  updateGrid(game, p, hasCy, hasMcvUnit);
  updateKits(game, p);
  updateQueueStrip(game, p);
  updatePowers(game, p);
  updateActions(game, p);
  updateSelectionPanel(game, st);
}

// rolling 30s income readout (credits per minute), sampled once a second
function updateIncome(game, st, p) {
  const H = game.hud;
  const S = H.incSamples;
  const last = S.length ? S[S.length - 1] : null;
  if (!last || st.tick - last.t >= 10) {
    S.push({ t: st.tick, e: p.creditsEarned | 0 });
    if (S.length > 31) S.shift();
  }
  let perMin = 0;
  if (S.length >= 2) {
    const a = S[0], b = S[S.length - 1];
    if (b.t > a.t) perMin = Math.round((b.e - a.e) * 600 / (b.t - a.t));
  }
  const txt = '+' + fmtInt(perMin) + '/min';
  if (txt !== H.incText) {
    H.incText = txt;
    H.incomeEl.textContent = txt;
    H.incomeEl.classList.toggle('zero', perMin <= 0);
  }
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
      addPing(game, c.x, c.y, 'alert');
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
  H.idleNow = Object.keys(seenIdle).length;
  if ((idleCount >= 2 || longestIdle > 300) && st.tick - H.idleWarnAt >= 300) {
    H.idleWarnAt = st.tick;
    showHint(game, (idleCount === 1 ? '1 idle worker' : idleCount + ' idle workers')
      + ' — press . to jump to them');
  }

  // SFX hooks (v0.3.6): weapon crack for fresh tracers visible on screen,
  // explosion thump when the entity count drops.
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
      playShot(game);
    }
    // tracerSeen only grows between matches; bound it
    let nSeen = 0;
    for (const id in H.tracerSeen) nSeen++;
    if (nSeen > 400) H.tracerSeen = {};
  }
  let entCount = 0;
  for (const id in st.units) entCount++;
  for (const id in st.structures) entCount++;
  if (H.lastEntCount >= 0 && entCount < H.lastEntCount) playBoom(game);
  H.lastEntCount = entCount;
}

// army panel counts: refreshed on the heavy-scan cadence; the signature
// guard means the DOM is touched only when a branch count actually changes
function updateArmyPanel(game, st, p) {
  const A = game.hud.army;
  if (!A) return;
  let sig = '';
  let total = 0;
  const counts = {};
  for (const br of ARMY_BRANCHES) {
    counts[br.id] = armyBranchUnits(st, p.slot, br.id).length;
    total += counts[br.id];
    sig += counts[br.id] + ',';
  }
  if (sig !== A.sig) {
    A.sig = sig;
    for (const br of ARMY_BRANCHES) {
      const r = A.rows[br.id];
      const n = counts[br.id];
      r.count.textContent = '×' + n;
      r.count.classList.toggle('zero', n === 0);
      for (const b of r.btns) {
        b.disabled = n === 0;
        b.classList.toggle('disabled', n === 0);
      }
    }
    if (A.total) A.total.textContent = total ? String(total) : '';
  }
  // idle workers + control-group recall chips
  const idle = game.hud.idleNow | 0;
  let gsig = 'i' + idle + ';';
  const live = [];
  for (let d = 1; d <= 9; d++) {
    const ids = (game.groups && game.groups[d]) || [];
    let n = 0;
    for (const id of ids) if (st.units[id]) n++;
    if (n) { live.push([d, n]); gsig += d + ':' + n + ','; }
  }
  if (gsig !== A.groupSig) {
    A.groupSig = gsig;
    clear(A.groups);
    A.groups.style.display = (live.length || idle) ? '' : 'none';
    if (idle) {
      const ib = el('button', { class: 'ap-group ap-idle', type: 'button', title: idle + ' idle worker' + (idle === 1 ? '' : 's') + ' — jump to the next one' }, [
        icon('warn'), h('span', null, 'Idle'), h('span', 'num', String(idle)), h('span', 'kbd', '.'),
      ]);
      ib.addEventListener('click', () => {
        // same path as the '.' hotkey (input.js owns the cycling)
        try { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Period', key: '.', bubbles: true })); } catch (e) { /* no-op */ }
        try { window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Period', key: '.', bubbles: true })); } catch (e) { /* no-op */ }
      });
      A.groups.appendChild(ib);
    }
    for (const [d, n] of live) {
      const b = el('button', { class: 'ap-group', type: 'button', title: 'Control group ' + d + ' — ' + n + ' unit' + (n === 1 ? '' : 's') }, [
        h('span', 'kbd', String(d)), h('span', 'num', String(n)),
      ]);
      b.addEventListener('click', () => {
        const s2 = game.state;
        if (!s2 || s2.over) return;
        const grp = ((game.groups && game.groups[d]) || []).filter((id) => s2.units[id]);
        if (!grp.length) return;
        game.selection = grp.slice();
        game.hudDirty = true;
        sfx(game, 'select');
      });
      A.groups.appendChild(b);
    }
  }
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

// ---- command panel: tabs --------------------------------------------------------

function updateTabs(game, p) {
  const H = game.hud;
  const st = game.state;
  const avail = tabsFor(st, p.slot);
  if (!avail.some((t) => t.id === H.activeTab)) {
    H.activeTab = avail.length ? avail[0].id : 'structures';
    H.page = 0;
  }
  const count = buildGridItems(st, p, H.activeTab).length;
  const pages = Math.max(1, Math.ceil(count / BUILD_HOTKEYS.length));
  if (H.page >= pages) H.page = pages - 1;
  // the ‹ › arrows only make sense when there is something to page
  if (H.pagePrev) H.pagePrev.disabled = pages <= 1;
  if (H.pageNext) H.pageNext.disabled = pages <= 1;
  const water = mapHasWater(st);
  const sig = avail.map((t) => t.id).join(',') + '|' + H.activeTab
    + '|' + H.page + '|' + pages + '|' + (water ? 1 : 0);
  if (sig === H.tabSig) return;
  H.tabSig = sig;
  H.gridSig = '';
  hideTooltipIn(H.tabs);
  clear(H.tabs);
  for (const t of TABS) {
    if (t.id === 'naval' && !water) continue; // no shipyards on a landlocked map
    const open = avail.some((a) => a.id === t.id);
    const b = el('button', {
      class: 'bb-tab' + (t.id === H.activeTab && open ? ' active' : '') + (open ? '' : ' locked'),
      type: 'button', role: 'tab', 'aria-selected': t.id === H.activeTab && open ? 'true' : 'false',
      'aria-disabled': open ? null : 'true', 'aria-label': t.label,
    }, [icon(open ? t.id : 'lock'), h('span', null, t.short)]);
    if (open) {
      b.addEventListener('click', () => {
        H.activeTab = t.id;
        H.page = 0;
        H.tabSig = '';
        updateHud(game);
      });
    }
    const need = t.prod ? st.structDefs[t.prod].name.split(' / ')[0] : 'Construction Yard';
    attachTooltip(game, b, () => simpleTip(t.label, open ? [] : ['Locked — requires a ' + need + '.']), { dock: H.panel });
    H.tabs.appendChild(b);
  }
  const cur = TABS.find((t) => t.id === H.activeTab);
  H.cmdTitle.textContent = cur ? cur.label : '';
  H.pageLbl.textContent = pages > 1 ? (H.page + 1) + ' / ' + pages : '';
  H.pagePrev.style.visibility = pages > 1 ? '' : 'hidden';
  H.pageNext.style.visibility = pages > 1 ? '' : 'hidden';
}

// ---- command panel: cameo grid ------------------------------------------------------

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

function updateGrid(game, p, hasCy, hasMcvUnit) {
  const H = game.hud;
  const all = buildGridItems(game.state, p, H.activeTab);
  const items = all.slice(H.page * BUILD_HOTKEYS.length,
    (H.page + 1) * BUILD_HOTKEYS.length);
  const metas = items.map((it) => gridItemMeta(game, p, it));
  // structural signature: which tiles exist. Enabled / queued / ready / cost
  // are patched in place below so a hovered tile (and its tooltip) survives.
  let sig = H.activeTab + '|' + H.page + '|' + p.faction;
  for (const m of metas) sig += '|' + m.id;
  if (sig !== H.gridSig) {
    H.gridSig = sig;
    rebuildTiles(game, metas);
  }
  for (const m of metas) {
    const t = H.tiles[m.id];
    if (!t) continue;
    const poor = !m.enabled && !m.ready && !m.queued && m.reason === 'credits';
    const locked = !m.enabled && !m.ready && !m.queued && !poor;
    const ssig = (m.enabled ? 1 : 0) + ':' + m.reason + ':' + m.queued + ':' + (m.ready ? 1 : 0)
      + ':' + m.cost + ':' + (hasIconArt(game, m.id) ? 1 : 0);
    if (ssig !== t.sig) {
      t.sig = ssig;
      const c = t.el.classList;
      c.toggle('ready', m.ready);
      c.toggle('queued', !m.ready && m.queued > 0);
      c.toggle('disabled', !m.ready && !m.queued && !m.enabled);
      c.toggle('poor', poor);
      c.toggle('locked', locked);
      c.toggle('has-cameo', hasIconArt(game, m.id));
      t.cost.textContent = m.ready ? 'PLACE' : fmtInt(m.cost);
      t.badge.textContent = '×' + m.queued;
      t.badge.style.display = m.queued ? 'block' : 'none';
      t.el.setAttribute('aria-disabled', (!m.ready && !m.queued && !m.enabled) ? 'true' : 'false');
    }
    // cheap per-tick updates: production sweep + placement highlight
    t.el.classList.toggle('placing', !!(game.placement && game.placement.structId === m.id));
    if (m.progress >= 0) {
      const deg = Math.floor(m.progress * 360);
      if (t.deg !== deg) {
        t.deg = deg;
        t.prog.style.display = 'block';
        t.prog.style.background = 'conic-gradient(rgba(95,227,208,0) ' + deg
          + 'deg, rgba(4,6,9,0.6) ' + deg + 'deg)';
        t.bar.style.display = 'block';
        t.barFill.style.width = Math.round(m.progress * 100) + '%';
      }
    } else if (t.deg !== -1) {
      t.deg = -1;
      t.prog.style.display = 'none';
      t.bar.style.display = 'none';
    }
  }
  // empty state: nothing to build from yet
  const esig = metas.length ? '' : (hasCy ? 'cy' : hasMcvUnit ? 'mcv' : 'none') + H.activeTab;
  if (esig !== H.emptySig) {
    H.emptySig = esig;
    clear(H.empty);
    H.empty.style.display = metas.length ? 'none' : 'flex';
    H.grid.style.display = metas.length ? '' : 'none';
    if (!metas.length) {
      H.empty.appendChild(icon(hasMcvUnit && !hasCy ? 'deploy' : 'lock'));
      H.empty.appendChild(h('b', null, hasMcvUnit && !hasCy ? 'Deploy your MCV' : hasCy ? 'Nothing to build here' : 'No Construction Yard'));
      H.empty.appendChild(h('span', null, hasMcvUnit && !hasCy
        ? 'Select it and press D to raise a Construction Yard and unlock production.'
        : hasCy ? 'This tab has no blueprints for your faction.'
          : 'Production is offline until a Construction Yard stands.'));
    }
  }
}

function rebuildTiles(game, metas) {
  const H = game.hud;
  hideTooltipIn(H.grid); // kill any tooltip bound to a tile we're about to drop
  clear(H.grid);
  H.tiles = {};
  metas.forEach((m, i) => {
    const tile = el('button', { class: 'bb-tile', type: 'button', dataset: { id: m.id, sfx: 'none' }, 'aria-label': m.def.name });
    tile.appendChild(makeCameo(game, m.def, m.kind, { code: false }));
    // short designation, shown only while the portrait has not arrived
    tile.appendChild(h('span', 'bb-code', initialsFor(m.def.name)));
    if (i < BUILD_HOTKEYS.length) tile.appendChild(h('span', 'bb-hotkey', BUILD_HOTKEYS[i]));
    const badge = h('span', 'bb-badge num', '×0');
    badge.style.display = 'none';
    tile.appendChild(badge);
    // state glyph: lock (requirements) or coin (credits) — never colour alone
    const stateIco = h('span', 'bb-state');
    stateIco.appendChild(icon('lock', 'st-lock'));
    stateIco.appendChild(icon('credit', 'st-poor'));
    stateIco.appendChild(icon('target', 'st-place'));
    tile.appendChild(stateIco);
    const prog = h('span', 'bb-prog');
    prog.style.display = 'none';
    tile.appendChild(prog);
    const bar = h('span', 'bb-bar');
    const barFill = h('i');
    bar.appendChild(barFill);
    bar.style.display = 'none';
    tile.appendChild(bar);
    const cost = h('span', 'bb-cost num', '');
    tile.appendChild(cost);
    tile.addEventListener('click', () => {
      const pp = game.state.players[game.playerSlot];
      activateItem(game, gridItemMeta(game, pp, m));
      game.hudDirty = true;
    });
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const pp = game.state.players[game.playerSlot];
      cancelItem(game, gridItemMeta(game, pp, m));
      game.hudDirty = true;
    });
    attachTooltip(game, tile, () => {
      const pp = game.state.players[game.playerSlot];
      return buildItemTip(game, pp, gridItemMeta(game, pp, m), BUILD_HOTKEYS[i]);
    }, { dock: H.panel, live: true });
    H.grid.appendChild(tile);
    H.tiles[m.id] = { el: tile, prog, badge, bar, barFill, cost, sig: '', deg: -2 };
  });
  // keep the 3x2 footprint stable on short pages
  for (let i = metas.length; i < BUILD_HOTKEYS.length && metas.length; i++) {
    H.grid.appendChild(h('span', 'bb-tile empty'));
  }
}

function activateItem(game, m) {
  if (m.kind === 'struct') {
    if (m.ready) {
      game.placement = { structId: m.id };
      game.targeting = null;
      game.attackMoveArmed = false;
      sfx(game, 'ui_click');
    } else if (!m.queued && m.enabled) {
      hudPushCmd(game, { type: 'buildStructure', structId: m.id });
      sfx(game, 'build');
    } else if (!m.queued) {
      sfx(game, 'ui_deny');
    }
  } else if (m.enabled) {
    hudPushCmd(game, { type: 'trainUnit', unitId: m.id });
    sfx(game, 'build');
  } else {
    sfx(game, 'ui_deny');
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

// ---- command panel: research kits -------------------------------------------------

// research kits (v0.3.7): exactly one owned Core/Prod structure selected
function selectedKits(game, st, p) {
  if (game.selection.length !== 1) return null;
  const s = st.structures[game.selection[0]];
  if (!s || s.owner !== p.slot) return null;
  const sType = st.structDefs[s.defId].type;
  if (sType !== 'Prod' && sType !== 'Core') return null;
  const offered = researchKitsFor(st, p, s.defId);
  return offered.length ? offered : null;
}

function updateKits(game, p) {
  const H = game.hud;
  const st = game.state;
  const kits = selectedKits(game, st, p);
  const sig = kits ? kits.map((k) => k.id + ':' + (k.owned ? 1 : 0) + ':' + (k.affordable ? 1 : 0)).join(',') : '';
  if (sig === H.kitSig) return;
  H.kitSig = sig;
  hideTooltipIn(H.kits);
  clear(H.kits);
  H.kits.style.display = kits ? '' : 'none';
  if (!kits) return;
  H.kits.appendChild(h('span', 'micro', 'Research'));
  for (const k of kits) {
    const usable = !k.owned && k.affordable;
    const b = el('button', {
      class: 'bb-action bb-kit' + (usable ? '' : ' disabled') + (k.owned ? ' owned' : ''), type: 'button',
      'aria-disabled': usable ? 'false' : 'true',
    }, [
      icon(k.owned ? 'check' : 'cube'),
      h('span', 'bb-kit-name', k.owned ? k.label + ' — OWNED' : k.label),
      k.owned ? null : el('span', { class: 'bb-kit-cost num' }, [icon('credit'), fmtInt(k.cost)]),
    ]);
    if (usable) {
      b.addEventListener('click', () => {
        hudPushCmd(game, { type: 'researchUpgrade', upgradeId: k.id });
        sfx(game, 'build');
      });
    }
    const up = (st.data.upgrades || []).find((g) => g.id === k.id);
    attachTooltip(game, b, () => {
      const lines = [];
      if (up) {
        const names = (up.appliesTo || []).map((id) => (st.unitDefs[id] ? st.unitDefs[id].name : id));
        lines.push('+' + Math.round((up.hpMul - 1) * 100) + '% hit points and +' + Math.round((up.dmgMul - 1) * 100)
          + '% damage for ' + names.join(', ') + '.');
        lines.push('Applies to units already in the field and every one built after.');
      }
      const card = simpleTip(k.label, lines);
      if (k.owned) card.appendChild(tipStatus('check', 'Researched', 'ok'));
      else if (!k.affordable) card.appendChild(tipStatus('warn', 'Not enough credits — ' + fmtInt(k.cost) + ' needed', 'bad'));
      return card;
    }, { dock: H.panel });
    H.kits.appendChild(b);
  }
}

// ---- command panel: queue strip ------------------------------------------------------

// v0.4.4 (DeepSeek 3.5): label for the queue strip — the focused producer's
// name ('Airfield queue:'); when the model fell back to the first producer
// with a queue (nothing focused) the label is dimmed
function queueLabelInfo(state, player, tabId, selection) {
  if (tabId === 'structures') return { text: 'Build queue:', focused: true };
  const tab = TABS.find((t) => t.id === tabId);
  if (!tab || !tab.prod) return { text: '', focused: true };
  const name = state.structDefs[tab.prod].name.split(' / ')[0] + ' queue:';
  const f = focusedProducer(state, player, tab, selection);
  if (!f.prod) return { text: '', focused: true };
  return { text: name, focused: f.focused };
}

// The strip shows the focused producer's first 3 queue entries, oldest first.
// It rebuilds only when the entry identity signature changes; per-tick
// updates touch the progress bar width only.
function updateQueueStrip(game, p) {
  const H = game.hud;
  const strip = H.queue;
  const st = game.state;
  const model = queueStripModel(st, p, H.activeTab, game.selection);
  if (!model.length) {
    if (H.queueSig !== '') {
      H.queueSig = '';
      H.queueEls = [];
      hideTooltipIn(strip); // chips are gone — kill any tooltip bound to one
      clear(strip);
    }
    H.queueLblSig = '';
    strip.style.display = 'none';
    return;
  }
  strip.style.display = 'flex';
  const li = queueLabelInfo(st, p, H.activeTab, game.selection);
  if (!H.queueLbl) H.queueLbl = h('span', 'bb-queue-label');
  if (!H.queueMore) H.queueMore = h('span', 'bb-queue-more num');
  let sig = H.activeTab;
  for (const q of model) sig += '|' + q.kind + ':' + q.id + ':' + q.producerId;
  if (sig !== H.queueSig) {
    H.queueSig = sig;
    hideTooltipIn(strip);
    clear(strip);
    strip.appendChild(H.queueLbl); // label stays first, before the chips
    H.queueEls = [];
    model.forEach((q, i) => {
      const def = q.kind === 'unit' ? st.unitDefs[q.id] : st.structDefs[q.id];
      const chip = el('button', { class: 'bb-chip' + (i === 0 ? ' head' : ''), type: 'button', dataset: { sfx: 'none' }, 'aria-label': def.name + ' — right-click to cancel' });
      chip.appendChild(makeCameo(game, def, q.kind, { code: false }));
      const bar = h('span', 'bb-chip-bar');
      chip.appendChild(bar);
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        cancelQueueEntry(game, q);
        game.hudDirty = true;
      });
      attachTooltip(game, chip, () => {
        const card = simpleTip(def.name, [i === 0 ? 'In production.' : 'Queued — position ' + (i + 1) + '.']);
        card.appendChild(tipHint(['Right-click'], 'cancel · full refund'));
        return card;
      }, { dock: H.panel });
      strip.appendChild(chip);
      H.queueEls.push({ chip, bar });
    });
    strip.appendChild(H.queueMore);
  }
  // cheap per-tick update: label text/dim + overflow count + progress widths
  // (model order == chip order, the signature above covers any reordering)
  const more = Math.max(0, queueTotal(st, p, H.activeTab, game.selection) - model.length);
  const lsig = li.text + '|' + (li.focused ? 1 : 0) + '|' + more;
  if (lsig !== H.queueLblSig) {
    H.queueLblSig = lsig;
    H.queueLbl.textContent = li.text;
    H.queueLbl.classList.toggle('dim', !li.focused);
    H.queueMore.textContent = more ? '+' + more : '';
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
  // keyboard feedback on the cameo itself
  const t = game.hud.tiles[id];
  if (t && t.el.classList) {
    t.el.classList.remove('tap');
    void t.el.offsetWidth;
    t.el.classList.add('tap');
  }
  game.hudDirty = true;
  return true;
}

// ---- tooltip cards --------------------------------------------------------------------

let __tipOwner = null;
function attachTooltip(game, anchor, buildFn, opts) {
  let timer = null;
  const show = () => {
    let card;
    try { card = buildFn(); } catch (e) { card = null; }
    if (!card) return;
    __tipOwner = anchor;
    showTooltip(card, anchor, opts);
  };
  anchor.addEventListener('mouseenter', () => {
    if (typeof setTimeout !== 'function') return;
    timer = setTimeout(show, 160);
  });
  anchor.addEventListener('mouseleave', () => {
    if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer);
    timer = null;
    if (__tipOwner === anchor) hideTooltip();
  });
  if (opts && opts.live) {
    // a click changes the card's facts (queued, credits): refresh in place
    anchor.addEventListener('click', () => {
      if (__tipOwner !== anchor) return;
      setTimeout(() => { if (__tipOwner === anchor && anchor.isConnected) show(); }, 140);
    });
  }
}

function showTooltip(card, anchor, opts) {
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  clear(tip);
  tip.appendChild(card);
  tip.style.display = 'block';
  tip.style.left = '0px';
  tip.style.top = '0px';
  tip.style.bottom = 'auto';
  const r = anchor.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const gap = 10;
  let x, y;
  if (opts && opts.dock && opts.dock.getBoundingClientRect) {
    // sit beside the docked panel, level with the hovered control
    const d = opts.dock.getBoundingClientRect();
    x = d.left - tw - gap;
    if (x < 8) x = d.right + gap;
    y = r.top + r.height / 2 - th / 2;
  } else if (opts && opts.side === 'below') {
    x = r.left + r.width / 2 - tw / 2;
    y = r.bottom + gap;
  } else {
    x = r.left + r.width / 2 - tw / 2;
    y = r.top - th - gap;
    if (y < 8) y = r.bottom + gap;
  }
  x = Math.max(8, Math.min(vw - tw - 8, x));
  y = Math.max(8, Math.min(vh - th - 8, y));
  if (opts && opts.dock) {
    // never cover the selection card's orders: ride above it when they'd collide
    const card = document.querySelector('#sel-panel.show .sel-card');
    if (card) {
      const c = card.getBoundingClientRect();
      if (x < c.right && x + tw > c.left && y + th > c.top - 8) y = Math.max(8, c.top - th - 8);
    }
  }
  tip.style.left = Math.round(x) + 'px';
  tip.style.top = Math.round(y) + 'px';
}

function hideTooltip() {
  __tipOwner = null;
  const tip = document.getElementById('tooltip');
  if (tip) tip.style.display = 'none';
}

// a container is about to be rebuilt: drop the tooltip only if it belongs to
// one of its controls (a tile's card must survive the queue strip appearing)
function hideTooltipIn(container) {
  if (__tipOwner && container && container.contains(__tipOwner)) hideTooltip();
}

function simpleTip(title, lines, keys) {
  const card = h('div', 'tt-card tt-simple');
  const head = h('div', 'tt-head');
  head.appendChild(h('span', 'tt-name', title));
  if (keys && keys.length) {
    const k = h('span', 'tt-keys');
    for (const key of keys) k.appendChild(h('span', 'kbd', key));
    head.appendChild(k);
  }
  card.appendChild(head);
  for (const ln of lines || []) if (ln) card.appendChild(h('div', 'tt-line', ln));
  return card;
}

function tipStatus(ico, text, kind) {
  return el('div', { class: 'tt-status ' + (kind || '') }, [icon(ico), h('span', null, text)]);
}

function tipHint(keys, text) {
  const row = h('div', 'tt-hint');
  for (const k of keys) row.appendChild(h('span', 'kbd', k));
  row.appendChild(h('span', null, text));
  return row;
}

const TIP_DMG = [['inf', 'INF'], ['light', 'LIGHT'], ['armor', 'ARMOR'], ['air', 'AIR'], ['bldg', 'BLDG']];
let __dmgMax = 0;
function dmgMax(st) {
  if (__dmgMax) return __dmgMax;
  let m = 1;
  for (const u of st.data.units) for (const k in u.dmg) m = Math.max(m, u.dmg[k]);
  for (const s of st.data.structures) if (s.dmg) for (const k in s.dmg) m = Math.max(m, s.dmg[k]);
  __dmgMax = m;
  return m;
}

function dmgBars(st, dmg) {
  const box = h('div', 'tt-dmg');
  const mx = dmgMax(st);
  for (const [k, label] of TIP_DMG) {
    const v = dmg[k] || 0;
    const col = h('div', 'tt-dmg-col' + (v > 0 ? '' : ' nil'));
    const track = h('span', 'tt-dmg-track');
    const fill = h('i');
    fill.style.height = Math.max(v > 0 ? 8 : 0, Math.round(100 * Math.sqrt(v / mx))) + '%';
    track.appendChild(fill);
    col.appendChild(track);
    col.appendChild(h('span', 'tt-dmg-val num', v > 0 ? String(v) : '–'));
    col.appendChild(h('span', 'tt-dmg-label', label));
    box.appendChild(col);
  }
  return box;
}

// the rich build-grid card: identity, price, stats, damage profile, counters,
// current state and what the mouse buttons do
function buildItemTip(game, p, m, hotkey) {
  const st = game.state;
  const def = m.def;
  const card = h('div', 'tt-card');
  const head = h('div', 'tt-head');
  const port = h('span', 'tt-portrait');
  port.appendChild(makeCameo(game, def, m.kind, { code: false }));
  head.appendChild(port);
  const ht = h('div', 'tt-title');
  ht.appendChild(h('span', 'tt-name', def.name));
  ht.appendChild(h('span', 'tt-class', m.kind === 'unit'
    ? def.cls + (def.role ? ' · ' + def.role : '')
    : def.type + ' structure'));
  head.appendChild(ht);
  if (hotkey) head.appendChild(el('span', { class: 'tt-keys' }, [h('span', 'kbd', hotkey)]));
  card.appendChild(head);

  const stats = h('div', 'tt-stats');
  const stat = (ico, value, label, cls) => {
    const s = h('span', 'tt-stat' + (cls ? ' ' + cls : ''));
    s.appendChild(icon(ico));
    s.appendChild(h('b', 'num', value));
    s.appendChild(h('i', null, label));
    stats.appendChild(s);
  };
  stat('credit', fmtInt(m.cost), 'cost', p.credits < m.cost ? 'bad' : '');
  stat('clock', def.build_s + 's', 'build');
  stat('hp', fmtInt(def.hp), 'hp');
  if (m.kind === 'struct') {
    if (def.power_out > 0) stat('bolt', '+' + def.power_out, 'power', 'ok');
    else if (def.power_use > 0) stat('bolt', '−' + def.power_use, 'power', p.powerUse + def.power_use > p.powerOut ? 'bad' : '');
  } else if (def.range > 0) {
    stat('range', String(def.range), 'range');
  }
  card.appendChild(stats);

  if (def.dmg && Object.keys(def.dmg).some((k) => def.dmg[k] > 0)) {
    const sec = h('div', 'tt-sec');
    sec.appendChild(h('span', 'tt-sec-label', 'Damage vs' + (def.rof_s ? ' · every ' + def.rof_s + 's' : '')));
    sec.appendChild(dmgBars(st, def.dmg));
    card.appendChild(sec);
  }
  if (m.kind === 'struct') {
    if (def.unlocks) card.appendChild(h('div', 'tt-line', def.unlocks));
    if (def.type === 'SW') {
      const sw = superweaponInfo(st.data, def.faction);
      if (sw) card.appendChild(h('div', 'tt-line', sw.text));
    }
    if (m.id === 'SH-03') card.appendChild(h('div', 'tt-line', 'Must be placed on an oil field. Each depot fields one harvester.'));
  } else {
    if (def.ability && def.ability !== '—') card.appendChild(h('div', 'tt-line', def.ability));
    if (def.hardCounter) card.appendChild(el('div', { class: 'tt-counter hard' }, [icon('warn'), h('b', null, 'Beaten by'), h('span', null, def.hardCounter)]));
    if (def.softCounter) card.appendChild(el('div', { class: 'tt-counter soft' }, [icon('info'), h('b', null, 'Threatened by'), h('span', null, def.softCounter)]));
    if (def.cls === 'Engineer') card.appendChild(h('div', 'tt-line', 'Captures enemy structures — order it to attack one.'));
    if (def.cls === 'APC' || def.cls === 'IFV') card.appendChild(h('div', 'tt-line', 'Carries infantry — right-click it with infantry selected.'));
  }

  const r = reasonText(m);
  if (m.ready) card.appendChild(tipStatus('target', r, 'ok'));
  else if (r) card.appendChild(tipStatus(m.reason === 'credits' ? 'credit' : 'lock', r, 'bad'));
  else if (m.queued) card.appendChild(tipStatus('clock', m.progress >= 0
    ? 'Building — ' + Math.round(m.progress * 100) + '%' + (m.queued > 1 ? ' · ' + (m.queued - 1) + ' more queued' : '')
    : m.queued + ' queued', 'info'));
  if (m.queued) card.appendChild(tipHint(['Right-click'], 'cancel · full refund'));
  else if (m.enabled && !m.ready) card.appendChild(tipHint(['Click'], m.kind === 'unit' ? 'train · click again to queue more' : 'start construction'));
  return card;
}

// ---- under-attack alarm: siren + clickable alert stack -----------------------

// top-right alert card (max 4 stacked, auto-expires after 8s); clicking it
// zooms in, jumps the camera to the battle and pings the minimap
function pushAlert(game, text, wx, wy, title) {
  const root = document.getElementById('alerts');
  if (!root) return;
  while (root.children.length >= 4) root.removeChild(root.children[0]);
  const b = el('button', { class: 'alert-banner', type: 'button', dataset: { sfx: 'none' } }, [
    icon('warn'),
    el('span', { class: 'alert-text' }, [h('b', null, title || 'Under attack'), h('span', null, text)]),
    h('span', 'alert-go', 'Jump'),
    h('i', 'alert-timer'),
  ]);
  let removed = false;
  const drop = () => {
    if (removed) return;
    removed = true;
    // the 4-card cap may have already evicted this banner; only remove if attached
    if (b.parentNode) b.parentNode.removeChild(b);
  };
  b.addEventListener('click', () => {
    if (game.state && game.camera) {
      const cam = game.camera;
      cam.zoom = Math.min(1.35, cam.maxZoom || 2.5);
      centerCameraOn(cam, wx, wy);
      clampCameraToMap(cam, game.state.map.w * CELL, game.state.map.h * CELL);
      addPing(game, wx, wy, 'alert');
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
      sfx(game, 'siren');
    }
  }
  pushAlert(game, 'Under attack: ' + attacker + ' — ' + def.name, c.x, c.y,
    isUnit ? 'Unit under fire' : 'Base under attack');
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
  // while a menu owns the screen the HUD is hidden: surface the hint as a toast
  const inMenu = typeof document !== 'undefined' && document.body
    && document.body.classList && document.body.classList.contains('in-menu');
  if (inMenu) {
    const troot = document.getElementById('toasts');
    if (troot) {
      while (troot.children.length >= 3) troot.removeChild(troot.children[0]);
      const t = el('div', { class: 'toast' }, [icon('info'), h('span', null, text)]);
      troot.appendChild(t);
      if (typeof setTimeout === 'function') {
        setTimeout(() => t.classList.add('fade'), 4200);
        setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 4800);
      }
      return;
    }
  }
  const root = (game && game.hint) || document.getElementById('hint');
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
  const node = document.getElementById('cursor-label');
  if (!node) return;
  node.textContent = text;
  node.style.left = (game.mouse.sx + 16) + 'px';
  node.style.top = (game.mouse.sy - 14) + 'px';
  node.classList.remove('flash');
  void node.offsetWidth; // restart the CSS animation
  node.classList.add('flash');
}

// ---- ability + superweapon widgets ---------------------------------------------------

function powerWidget(kind, ico) {
  const b = el('button', { class: 'pw pw-' + kind, type: 'button' });
  const ring = h('span', 'pw-ring');
  ring.appendChild(icon(ico));
  b.appendChild(ring);
  const txt = h('span', 'pw-text');
  const name = h('span', 'pw-name', '');
  const status = h('span', 'pw-status num', '');
  txt.appendChild(name);
  txt.appendChild(status);
  b.appendChild(txt);
  return { el: b, ring, name, status };
}

function updatePowers(game, p) {
  const st = game.state;
  const H = game.hud;
  const ability = st.data.factions[p.faction].ability;
  const passive = !!ability && PASSIVE_ABILITIES.includes(ability);
  const showAb = !!ability && !passive;
  // gate actives on their Unique/SW structure (mirrors validateCommand), so the
  // widget never says READY when the sim would reject with 'no-unique'
  const abGateId = showAb ? ABILITY_STRUCT[ability] : null;
  const abGateOk = !abGateId
    || standingStructs(st, p.slot, (s) => s.defId === abGateId).length > 0;
  let hasSw = false;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner === p.slot && st.structDefs[s.defId].type === 'SW') { hasSw = true; break; }
  }
  const sig = [ability || '', passive ? 1 : 0, abGateOk ? 1 : 0, hasSw ? 1 : 0].join('|');
  if (sig !== H.powSig) {
    H.powSig = sig;
    hideTooltipIn(H.powers);
    clear(H.powers);
    const R = H.powRefs = { ab: null, sw: null };
    const info = ability ? abilityInfo(st.data, p.faction) : null;
    if (hasSw) {
      const swi = superweaponInfo(st.data, p.faction);
      const w = powerWidget('sw', 'warhead');
      w.name.textContent = swi ? swi.name : 'Superweapon';
      w.el.addEventListener('click', () => {
        const pp = game.state.players[game.playerSlot];
        if (pp.swChargeTicks === 0) { game.targeting = { kind: 'sw' }; game.placement = null; game.hudDirty = true; }
      });
      attachTooltip(game, w.el, () => {
        const pp = game.state.players[game.playerSlot];
        const card = simpleTip(swi ? swi.name : 'Superweapon', swi ? [swi.payloadName, swi.text] : []);
        if (pp.swChargeTicks === 0) card.appendChild(tipHint(['Click'], 'then click the target'));
        else card.appendChild(tipStatus('clock', 'Charging — ' + fmtSecs(Math.max(0, pp.swChargeTicks) / 10), 'info'));
        return card;
      }, { dock: H.powers });
      H.powers.appendChild(w.el);
      R.sw = w;
    }
    if (showAb) {
      const w = powerWidget('ab', 'bolt');
      w.name.textContent = info ? info.name : titleCase(ability);
      w.el.addEventListener('click', () => {
        const s2 = game.state;
        const pp = s2.players[game.playerSlot];
        const gid = ABILITY_STRUCT[ability];
        const ok = (!gid || standingStructs(s2, pp.slot, (s) => s.defId === gid).length > 0)
          && Math.max(0, pp.abilityCdUntil - s2.tick) === 0;
        if (ok) { game.targeting = { kind: 'ability' }; game.placement = null; game.hudDirty = true; }
      });
      attachTooltip(game, w.el, () => {
        const card = simpleTip(info ? info.name : titleCase(ability), info ? [info.text, '90 second cooldown.'] : []);
        if (!abGateOk && info && info.gateName) card.appendChild(tipStatus('lock', 'Requires ' + info.gateName, 'bad'));
        else card.appendChild(tipHint(['Click'], 'then click the target'));
        return card;
      }, { dock: H.powers });
      H.powers.appendChild(w.el);
      R.ab = w;
    } else if (passive) {
      const chip = el('div', { class: 'pw pw-passive' }, [
        el('span', { class: 'pw-ring' }, [icon('shield')]),
        el('span', { class: 'pw-text' }, [h('span', 'pw-name', info ? info.name : titleCase(ability)), h('span', 'pw-status', 'PASSIVE')]),
      ]);
      attachTooltip(game, chip, () => simpleTip(info ? info.name : titleCase(ability), info ? [info.text] : []), { dock: H.powers });
      H.powers.appendChild(chip);
    }
  }
  const R = H.powRefs;
  if (!R) return;
  if (R.sw) {
    const ready = p.swChargeTicks === 0;
    const armed = !!(game.targeting && game.targeting.kind === 'sw');
    const frac = ready ? 1 : 1 - Math.max(0, Math.min(1, p.swChargeTicks / SW_CHARGE_TICKS));
    const txt = armed ? 'SELECT TARGET' : ready ? 'READY' : fmtSecs(Math.max(0, p.swChargeTicks) / 10);
    patchPower(R.sw, frac, ready, armed, txt, !ready);
  }
  if (R.ab) {
    const cd = Math.max(0, p.abilityCdUntil - st.tick);
    const ready = cd === 0 && abGateOk;
    const armed = !!(game.targeting && game.targeting.kind === 'ability');
    const frac = !abGateOk ? 0 : 1 - Math.min(1, cd / ABILITY_CD_TICKS);
    const gateName = abGateId ? st.structDefs[abGateId].name : '';
    const txt = armed ? 'SELECT TARGET' : !abGateOk ? 'NEEDS ' + gateName.toUpperCase()
      : cd > 0 ? Math.ceil(cd / 10) + 's' : 'READY';
    patchPower(R.ab, frac, ready, armed, txt, !ready);
    R.ab.el.classList.toggle('gated', !abGateOk);
  }
}

function patchPower(w, frac, ready, armed, txt, disabled) {
  const f = Math.round(frac * 1000);
  if (w._f !== f) { w._f = f; w.ring.style.setProperty('--p', (frac * 100).toFixed(1) + '%'); }
  if (w._t !== txt) { w._t = txt; w.status.textContent = txt; }
  const s = (ready ? 1 : 0) + ':' + (armed ? 1 : 0) + ':' + (disabled ? 1 : 0);
  if (w._s !== s) {
    w._s = s;
    w.el.classList.toggle('ready', ready);
    w.el.classList.toggle('placing', armed);
    w.el.classList.toggle('disabled', disabled);
    w.el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }
}

// ---- selection actions (deploy / unload / stances) -----------------------------------

function updateActions(game, p) {
  const st = game.state;
  const H = game.hud;
  const mcvSel = game.selection.map((id) => st.units[id])
    .find((u) => u && u.owner === p.slot && u.defId === 'MCV');

  // stance buttons (v0.3.7): shown whenever the selection holds own units
  const selUnitIds = [];
  for (const id of game.selection) {
    const u = st.units[id];
    if (u && u.owner === p.slot) selUnitIds.push(id);
  }
  const firstSelUnit = selUnitIds.length ? st.units[selUnitIds[0]] : null;
  let mixed = false;
  if (firstSelUnit) {
    const s0 = firstSelUnit.stance | 0;
    for (const id of selUnitIds) if ((st.units[id].stance | 0) !== s0) { mixed = true; break; }
  }
  // v0.9.0 transports: a lone selected carrier with cargo gets an UNLOAD
  // button (right-clicking the carrier itself also unloads — input.js)
  let carrier = null;
  if (selUnitIds.length === 1) {
    const only = st.units[selUnitIds[0]];
    const onlyDef = only && st.unitDefs[only.defId];
    if (onlyDef && (onlyDef.cls === 'APC' || onlyDef.cls === 'IFV')
        && only.cargo && only.cargo.length) carrier = only;
  }

  const sig = [mcvSel ? mcvSel.id : 0, selUnitIds.join(','),
    firstSelUnit ? (mixed ? 'm' : firstSelUnit.stance | 0) : 'x',
    carrier ? carrier.id + ':' + carrier.cargo.length : 'x'].join('|');
  if (sig === H.actSig) return;
  H.actSig = sig;
  clear(H.actions);
  H.actions.style.display = (mcvSel || selUnitIds.length) ? '' : 'none';

  if (mcvSel) {
    const b = el('button', { class: 'bb-action bb-deploy', type: 'button' }, [icon('deploy'), h('span', null, 'DEPLOY'), h('span', 'kbd', 'D')]);
    b.title = 'Unpack the MCV into a Construction Yard';
    b.addEventListener('click', () => hudPushCmd(game, { type: 'deployMCV', unitId: mcvSel.id }));
    H.actions.appendChild(b);
  }

  if (carrier) {
    const b = el('button', { class: 'bb-action bb-unload ready', type: 'button' }, [icon('unload'), h('span', null, 'UNLOAD ×' + carrier.cargo.length)]);
    b.title = 'Disembark the carried infantry';
    b.addEventListener('click', () => hudPushCmd(game, { type: 'unload', carrierId: carrier.id }));
    H.actions.appendChild(b);
  }

  if (selUnitIds.length) {
    const wrap = h('div', 'bb-stance');
    wrap.appendChild(el('span', { class: 'micro' }, ['Stance ', h('span', 'kbd', 'G')]));
    const rowEl = h('div', 'bb-stance-row');
    const labels = ['AGG', 'DEF', 'HLD', 'HF'];
    const icons = ['aggressive', 'shield', 'hold', 'holdfire'];
    const keys = 'ADSF';
    const alts = 'ZXCV';
    for (let n = 0; n < labels.length; n++) {
      const cur = !mixed && (firstSelUnit.stance | 0) === n;
      const b = el('button', { class: 'bb-action bb-stance-btn' + (cur ? ' on' : ''), type: 'button', 'aria-pressed': cur ? 'true' : 'false' },
        [icon(icons[n]), h('span', null, labels[n]), h('span', 'kbd', alts[n])]);
      b.title = STANCE_NAMES[n] + ' [' + alts[n] + ' or Ctrl+Alt+' + keys[n] + ']';
      const stanceN = n;
      b.addEventListener('click', () => {
        hudPushCmd(game, { type: 'setStance', unitIds: selUnitIds.slice(), stance: stanceN });
        game.hudDirty = true;
      });
      rowEl.appendChild(b);
    }
    wrap.appendChild(rowEl);
    H.actions.appendChild(wrap);
  }
}

// ---- selection panel -------------------------------------------------------------

function hpClass(frac) { return frac > 0.6 ? 'ok' : frac > 0.3 ? 'mid' : 'low'; }

function rankPips(rank) {
  const r = rank | 0;
  if (!r) return null;
  const box = el('span', { class: 'sel-rank', title: RANK_NAMES[r] || 'Veteran' });
  for (let i = 0; i < r; i++) box.appendChild(h('i'));
  return box;
}

function updateSelectionPanel(game, st) {
  const H = game.hud;
  const sel = game.selection.filter((id) => st.units[id] || st.structures[id]);
  // inspected hostile (clicked in the fog-visible map) shows when nothing selected
  const insp = game.inspectId ? (st.units[game.inspectId] || st.structures[game.inspectId]) : null;
  const show = sel.length > 0 || !!insp;
  if (H._selShow !== show) { H._selShow = show; H.selRoot.classList.toggle('show', show); }

  // structural signature: rebuild when the set of entities or a non-HP fact
  // changes; hit points are patched in place below
  let sig = '';
  if (!sel.length && insp) sig = 'i' + game.inspectId;
  else if (sel.length === 1) {
    const ent = st.units[sel[0]] || st.structures[sel[0]];
    sig = 's' + sel[0] + ':' + (ent.stance !== undefined ? ent.stance | 0 : '') + ':' + (ent.cargo ? ent.cargo.length : '')
      + ':' + (ent.rank | 0) + ':' + (ent.capTicks | 0) + ':' + (ent.upgradeName || '') + ':' + ent.maxHp;
  } else if (sel.length > 1) {
    sig = 'm' + sel.length + ':';
    const lim = Math.min(sel.length, SEL_TILE_MAX);
    for (let i = 0; i < lim; i++) sig += sel[i] + '.' + ((st.units[sel[i]] || {}).rank | 0) + ',';
    const us = sel.map((id) => st.units[id]).filter(Boolean);
    if (us.length) {
      const s0 = us[0].stance | 0;
      sig += us.some((u) => (u.stance | 0) !== s0) ? '|m' : '|' + s0;
    }
  }
  if (sig !== H.selSig) {
    H.selSig = sig;
    clear(H.selInfo);
    H.selRefs = [];
    H.selCard.classList.toggle('hostile', !sel.length && !!insp);
    if (!sel.length && insp) buildSingle(game, st, insp, true);
    else if (sel.length === 1) buildSingle(game, st, st.units[sel[0]] || st.structures[sel[0]], false);
    else if (sel.length > 1) buildMulti(game, st, sel);
  }
  // in-place health
  for (const r of H.selRefs || []) {
    const ent = st.units[r.id] || st.structures[r.id];
    if (!ent) continue;
    if (r.hp === ent.hp) continue;
    r.hp = ent.hp;
    const frac = Math.max(0, Math.min(1, ent.hp / ent.maxHp));
    r.fill.style.width = Math.round(frac * 100) + '%';
    r.bar.className = r.barCls + ' ' + hpClass(frac);
    if (r.text) r.text.textContent = fmtInt(ent.hp) + ' / ' + fmtInt(ent.maxHp);
  }
}

// name/hp header + stat lines for one entity (selection of 1, or inspect)
function buildSingle(game, st, ent, isInspect) {
  const H = game.hud;
  const isUnit = !!st.unitDefs[ent.defId];
  const def = isUnit ? st.unitDefs[ent.defId] : st.structDefs[ent.defId];
  const box = h('div', 'sel-single');
  const port = h('div', 'sel-portrait brackets');
  port.appendChild(makeCameo(game, def, isUnit ? 'unit' : 'struct'));
  const pips = isUnit ? rankPips(ent.rank) : null;
  if (pips) port.appendChild(pips);
  box.appendChild(port);

  const main = h('div', 'sel-main');
  const title = h('div', 'sel-title');
  title.appendChild(h('span', 'sel-name', def.name));
  if (isInspect) title.appendChild(el('span', { class: 'chip chip-red' }, [icon('target'), 'Hostile']));
  title.appendChild(h('span', 'chip', isUnit ? def.cls : def.type + ' structure'));
  if (isUnit && (ent.rank | 0) > 0) title.appendChild(h('span', 'chip chip-gold', RANK_NAMES[ent.rank | 0]));
  main.appendChild(title);

  const hpRow = h('div', 'sel-hprow');
  const bar = h('span', 'sel-hpbar');
  const fill = h('span');
  bar.appendChild(fill);
  hpRow.appendChild(bar);
  const hpText = h('span', 'sel-hp num', '');
  hpRow.appendChild(hpText);
  main.appendChild(hpRow);
  H.selRefs.push({ id: ent.id, hp: -1, bar, fill, text: hpText, barCls: 'sel-hpbar' });

  const lines = [];
  if (isUnit) {
    if (ent.upgradeName) lines.push(['cube', 'Upgrade: ' + ent.upgradeName, 'gold']);
    const facts = [def.domain];
    if (def.range > 0) facts.push('Range ' + def.range, 'ROF ' + def.rof_s + 's');
    if (def.armor) facts.push(def.armor + ' armour');
    lines.push(['info', facts.join(' · ')]);
    if (def.hardCounter) lines.push(['warn', 'Beaten by (hard): ' + def.hardCounter, 'hard']);
    if (def.softCounter) lines.push(['info', 'Threatened by (soft): ' + def.softCounter, 'soft']);
    if (def.cls === 'Engineer' && !isInspect) {
      if (ent.capTicks > 0) lines.push(['flag', `Capturing… ${ent.capTicks}/${CAPTURE_TICKS}`, 'gold']);
      else lines.push(['flag', 'Attack a structure to capture it']);
    }
    if (!isInspect && ent.cargo && ent.cargo.length) lines.push(['users', 'Carrying ' + ent.cargo.length + ' infantry']);
    if (!isInspect) lines.push(['shield', 'Stance: ' + STANCE_NAMES[ent.stance | 0] + ' [G]']);
  } else {
    const facts = [];
    if (def.range > 0) facts.push('Range ' + def.range, 'ROF ' + def.rof_s + 's');
    if (def.power_out > 0) facts.push('Power +' + def.power_out);
    else if (def.power_use > 0) facts.push('Power -' + def.power_use);
    if (facts.length) lines.push(['bolt', facts.join(' · ')]);
    if (def.unlocks) lines.push(['info', def.unlocks]);
    if (!isInspect && ent.owner === game.playerSlot && def.type === 'Prod') {
      lines.push(['flag', 'Right-click the map to set a rally point']);
    }
  }
  const list = h('div', 'sel-lines');
  for (const [ico, text, cls] of lines) {
    list.appendChild(el('div', { class: 'sel-tip' + (cls ? ' ' + cls : '') }, [icon(ico), h('span', null, text)]));
  }
  main.appendChild(list);
  box.appendChild(main);
  H.selInfo.appendChild(box);
}

function buildMulti(game, st, sel) {
  const H = game.hud;
  const box = h('div', 'sel-multi');
  const head = h('div', 'sel-multi-head');
  head.appendChild(h('span', 'sel-count num', String(sel.length)));
  // short composition summary: "5 Infantry · 3 MBT · 2 IFV"
  const byCls = {};
  for (const id of sel) {
    const ent = st.units[id] || st.structures[id];
    const def = st.unitDefs[ent.defId] || st.structDefs[ent.defId];
    const k = def.cls || def.type || '?';
    byCls[k] = (byCls[k] || 0) + 1;
  }
  const parts = Object.keys(byCls).sort((a, b) => byCls[b] - byCls[a]).slice(0, 4).map((k) => byCls[k] + ' ' + k);
  head.appendChild(h('span', 'sel-summary', 'selected — ' + parts.join(' · ')));
  // v0.3.6: stance readout when units are selected ('G' cycles); v0.4.3: a
  // mixed selection shows a dash instead of the first unit's stance
  const selUnits = sel.map((id) => st.units[id]).filter((u) => u);
  if (selUnits.length) {
    const st0 = selUnits[0].stance | 0;
    const mixed = selUnits.some((u) => (u.stance | 0) !== st0);
    head.appendChild(h('span', 'sel-stance', 'Stance: ' + (mixed ? '—' : STANCE_NAMES[st0]) + ' [G]'));
  }
  box.appendChild(head);
  const gridEl = h('div', 'sel-units');
  const lim = Math.min(sel.length, SEL_TILE_MAX - (sel.length > SEL_TILE_MAX ? 1 : 0));
  for (let i = 0; i < lim; i++) {
    const id = sel[i];
    const ent = st.units[id] || st.structures[id];
    const isUnit = !!st.units[id];
    const def = isUnit ? st.unitDefs[ent.defId] : st.structDefs[ent.defId];
    const t = el('button', { class: 'sel-unit', type: 'button', title: def.name + ' — click to select only this, Shift-click to drop it' });
    t.appendChild(makeCameo(game, def, isUnit ? 'unit' : 'struct', { code: false }));
    const pips = isUnit ? rankPips(ent.rank) : null;
    if (pips) t.appendChild(pips);
    const bar = h('span', 'sel-unit-hp');
    const fill = h('span');
    bar.appendChild(fill);
    t.appendChild(bar);
    t.addEventListener('click', (e) => {
      if (e.shiftKey || e.ctrlKey) game.selection = game.selection.filter((x) => x !== id);
      else game.selection = [id];
      game.hudDirty = true;
      sfx(game, 'select');
    });
    gridEl.appendChild(t);
    H.selRefs.push({ id, hp: -1, bar, fill, text: null, barCls: 'sel-unit-hp' });
  }
  if (sel.length > lim) gridEl.appendChild(h('span', 'sel-unit more num', '+' + (sel.length - lim)));
  box.appendChild(gridEl);
  H.selInfo.appendChild(box);
}

// ---- chat feed ------------------------------------------------------------------------
// main.js appends every inbound line to #chatlog, which is only visible while
// the chat box is open. Mirror new lines into a transient feed, and echo the
// local player's own messages (the relay never sends them back).

function initChatFeed(game) {
  const log = document.getElementById('chatlog');
  const feed = document.getElementById('chat-feed');
  const bar = document.getElementById('chatbar');
  if (!log || !feed) return;
  const post = (text, mine) => {
    while (feed.children.length >= 5) feed.removeChild(feed.children[0]);
    const line = h('div', 'chat-feed-line' + (mine ? ' mine' : ''), text);
    feed.appendChild(line);
    setTimeout(() => line.classList.add('fade'), 7000);
    setTimeout(() => { if (line.parentNode) line.parentNode.removeChild(line); }, 7800);
  };
  if (typeof MutationObserver === 'function' && !log.__feedBound) {
    log.__feedBound = true;
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) post(n.textContent, n.classList.contains('mine'));
        }
      }
      log.scrollTop = log.scrollHeight;
    }).observe(log, { childList: true });
  }
  if (bar && !bar.__echoBound) {
    bar.__echoBound = true;
    // registered before main.js's own listener, so the value is still intact
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.code !== 'Enter') return;
      const text = String(bar.value || '').trim();
      if (!text || !(game.net && game.net.active)) return;
      const name = game.net.name || 'You';
      if (!game.mpChatLog) game.mpChatLog = [];
      game.mpChatLog.push({ name, text });
      if (game.mpChatLog.length > 50) game.mpChatLog.shift();
      log.appendChild(h('div', 'mp-chatline mine', name + ': ' + text));
      while (log.children.length > 50) log.removeChild(log.firstChild);
    });
  }
}

// ---- tutorial mode (v0.4.4) -----------------------------------------------------
// A guided sandbox, NOT a scripted demo: every system stays live. The step
// machine is pure UI — it only WATCHES game state each frame (never issues
// commands, never touches the sim) and advances when the watched condition
// holds. game.tutor = { step, pulseEl } is armed by main.js when cfg.tutorial
// is set; 'tutorial seen' persists in localStorage so the setup switch can
// tell first-timers from returning players.

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
  { text: 'Build a Power Plant from the command panel (Q).',
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
  const node = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('tutor') : null;
  if (node) {
    clear(node);
    if (node.classList) node.classList.add('hidden');
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
  const node = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('tutor') : null;
  if (!node) return;
  // advance at most one step per frame, and only after the current prompt has
  // been on screen for a frame (S1's MCV is auto-selected at match start —
  // without this guard it would chain to S2 before ever being visible)
  if (game._tutorSig === 'step' + T.step && T.step < TUTOR_STEPS.length - 1
    && TUTOR_STEPS[T.step].done(game, st, p)) {
    clearTutorPulse(game);
    T.step++;
    sfx(game, 'ui_confirm');
  }
  const sig = 'step' + T.step;
  if (sig !== game._tutorSig) {
    game._tutorSig = sig;
    clear(node);
    if (node.classList) node.classList.remove('hidden');
    const box = h('div', 'tutor-box panel chamfer');
    const head = h('div', 'tutor-head');
    head.appendChild(h('span', 'tutor-eva', 'EVA briefing — tutorial '
      + (T.step + 1) + '/' + TUTOR_STEPS.length));
    const pips = h('span', 'tutor-pips');
    for (let i = 0; i < TUTOR_STEPS.length; i++) {
      pips.appendChild(h('i', i < T.step ? 'done' : i === T.step ? 'cur' : ''));
    }
    head.appendChild(pips);
    box.appendChild(head);
    box.appendChild(h('div', 'tutor-text', TUTOR_STEPS[T.step].text));
    const row = h('div', 'tutor-row');
    const skip = el('button', { class: 'tutor-skip', type: 'button' }, ['Skip tutorial ', h('span', 'kbd', 'Esc')]);
    skip.addEventListener('click', () => skipTutorial(game));
    row.appendChild(skip);
    if (T.step === TUTOR_STEPS.length - 1) {
      const begin = el('button', { class: 'tutor-done btn btn-primary btn-sm', type: 'button' }, ['Begin']);
      begin.addEventListener('click', () => endTutorial(game, true));
      row.appendChild(begin);
    }
    box.appendChild(row);
    node.appendChild(box);
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
