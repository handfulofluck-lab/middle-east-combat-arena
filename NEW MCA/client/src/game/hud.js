// Modern flat HUD: slim top bar (credits / power / clock / speed / menu),
// SC2-style bottom-center build bar (icon grid, hotkeys Q W E R T F G,
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
  mapHasWater, isHostile, CAPTURE_TICKS,
} from '../sim/index.js';
import { screenToWorld } from './camera.js';
import { shapeForUnit, shapeForStructure, initialsFor, factionColorOf } from './sprites.js';
import { structureLabel, structureHud, unitHud } from './display.js';
import { addPing } from './minimap.js';
import { sfx } from './audio.js';

const TABS = [
  { id: 'structures', label: 'Structures', prod: null },   // needs ConYard (SH-01)
  { id: 'infantry', label: 'Infantry', prod: 'SH-04' },
  { id: 'vehicles', label: 'Vehicles', prod: 'SH-05' },
  { id: 'air', label: 'Air', prod: 'SH-06' },
  { id: 'naval', label: 'Naval', prod: 'SH-07' },
];
const PASSIVE_ABILITIES = ['edge_network', 'integrated_sky', 'siha_mesh', 'iron_layer'];
// grid hotkeys; A/S/D stay reserved as order hotkeys
export const BUILD_HOTKEYS = ['Q', 'W', 'E', 'R', 'T', 'F', 'G'];
const PRODUCER_TAB = { 'SH-04': 'infantry', 'SH-05': 'vehicles', 'SH-06': 'air', 'SH-07': 'naval' };

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
export function buildGridItems(state, player, tabId) {
  const items = [];
  if (tabId === 'structures') {
    for (const def of state.data.structures) {
      if (def.faction !== 'All' && def.faction !== player.faction) continue;
      // ConYard rebuild tile: only while the rebuild is actually legal —
      // no CY standing, no MCV alive, one-shot not yet spent
      if (def.id === 'SH-01'
        && (hasConyard(state, player.slot) || hasMcv(state, player.slot) || player.cyRebuilt)) continue;
      items.push({ kind: 'struct', id: def.id });
    }
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

// hotkey -> defId for a grid's items (Q W E R T F G, in grid order)
export function hotkeyMapFor(items) {
  const m = {};
  items.forEach((it, i) => {
    if (i < BUILD_HOTKEYS.length) m[BUILD_HOTKEYS[i]] = it.id;
  });
  return m;
}

// tooltip content lines: name, cost/time/HP, role/counter or power/unlocks
export function tooltipLines(state, player, kind, defId) {
  if (kind === 'struct') {
    const def = state.structDefs[defId];
    const cost = buildCost(state, player, def);
    const lines = [structureLabel(defId, player.faction, def.name),
      'Cost ' + cost + ' · Build ' + def.build_s + 's · ' + def.hp + ' HP'];
    if (def.power_out > 0) lines.push('Power +' + def.power_out);
    else if (def.power_use > 0) lines.push('Power -' + def.power_use);
    if (def.unlocks) lines.push(def.unlocks);
    return lines;
  }
  const def = state.unitDefs[defId];
  const cost = trainCost(state, player, def, requiredProducer(def) || 'SH-05');
  const lines = [unitHud(defId, def.name),
    'Cost ' + cost + ' · Build ' + def.build_s + 's · ' + def.hp + ' HP'];
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

function hudPushCmd(game, cmd) {
  cmd.player = game.playerSlot;
  game.pendingCmds.push(cmd);
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

  const speedBtns = {};
  for (const s of [1, 2, 4]) {
    const b = h('button', 'tb-btn' + (s === 1 ? ' active' : ''), s + 'x');
    b.addEventListener('click', () => {
      if (game.overlay) return; // an overlay owns the UI right now
      game.speed = s; game.paused = false;
      refreshSpeed();
    });
    speedBtns[s] = b;
    top.appendChild(b);
  }
  const pauseBtn = h('button', 'tb-btn', 'Pause');
  pauseBtn.addEventListener('click', () => {
    if (game.overlay) return; // paused overlay owns the pause state
    game.paused = !game.paused;
    refreshSpeed();
  });
  top.appendChild(pauseBtn);
  const menuBtn = h('button', 'tb-btn', 'Menu');
  menuBtn.addEventListener('click', () => { if (game.openMenu) game.openMenu(); });
  top.appendChild(menuBtn);
  function refreshSpeed() {
    for (const s of [1, 2, 4]) {
      speedBtns[s].classList.toggle('active', !game.paused && game.speed === s);
    }
    pauseBtn.classList.toggle('active', game.paused);
  }
  game.hudSyncSpeed = refreshSpeed; // main.js syncs after overlay-driven changes

  // build bar
  const bar = document.getElementById('buildbar');
  bar.innerHTML = '';
  const tabs = h('div', 'bb-tabs');
  const row = h('div', 'bb-row');
  const grid = h('div', 'bb-grid');
  const actions = h('div', 'bb-actions');
  row.appendChild(grid);
  row.appendChild(actions);
  bar.appendChild(tabs);
  bar.appendChild(row);

  // hint banners (persistent MCV hint is the first child)
  const hintRoot = document.getElementById('hint');
  hintRoot.innerHTML = '';
  const hintMcv = h('div', 'hint-banner mcv',
    'Select your MCV — press D or double-click it to deploy the Construction Yard');
  hintMcv.style.display = 'none';
  hintRoot.appendChild(hintMcv);

  game.hud = {
    creditsEl, powerDot, powerEl, clockEl, tabs, grid, actions,
    activeTab: 'structures', tiles: {}, tabSig: '', gridSig: '', actSig: '',
    stateRef: null, knownStructs: {}, lastReadyCount: 0, lastFaction: null, hintMcv,
    page: 0, hitSeen: {}, hitPing: {},
  };
  game.hudFocusBuild = () => {
    game.hud.activeTab = 'structures';
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
}

export function updateHud(game) {
  const st = game.state;
  if (!st || !game.hud) return;
  const p = st.players[game.playerSlot];
  const H = game.hud;
  if (H.stateRef !== st) {
    H.stateRef = st;
    H.knownStructs = {};
    H.lastReadyCount = 0;
    H.lastUnitsBuilt = p.unitsBuilt || 0;
    H.lastSwReady = null;
    H.lastFaction = null;
    H.tabSig = ''; H.gridSig = ''; H.actSig = '';
    H.page = 0; H.hitSeen = {}; H.hitPing = {};
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

  // structure finished construction -> hint + minimap ping at the base
  if (p.ready.length > H.lastReadyCount) {
    const newId = p.ready[p.ready.length - 1];
    showHint(game, structureLabel(newId, p.faction, st.structDefs[newId].name)
      + ' ready — place it from the build bar');
    sfx('ready');
    const core = standingStructs(st, p.slot, (s) => st.structDefs[s.defId].type === 'Core')[0];
    if (core) {
      const c = structCenter(core);
      addPing(game, c.x, c.y);
    }
  }
  H.lastReadyCount = p.ready.length;

  // unit rolled off a production line
  if ((p.unitsBuilt || 0) > (H.lastUnitsBuilt || 0)) sfx('trainDone');
  H.lastUnitsBuilt = p.unitsBuilt || 0;

  // v0.3.4: brief toast when the player tried to deploy into a blocked spot
  if (p._deployFailTick && st.tick - p._deployFailTick <= 3) {
    p._deployFailTick = 0;
    showHint(game, 'No room to deploy — move the MCV a few cells and try again');
  }

  // newly placed structures -> minimap ping; production structures switch tab
  // (rally points are sim-side now: setRally command or defaultRallyCell)
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner !== p.slot || H.knownStructs[id]) continue;
    H.knownStructs[id] = 1;
    const c = structCenter(s);
    addPing(game, c.x, c.y);
    const tabId = PRODUCER_TAB[s.defId];
    if (tabId) {
      H.activeTab = tabId;
      H.tabSig = '';
      showHint(game, structureLabel(s.defId, p.faction, st.structDefs[s.defId].name)
        + ' online — ' + tabId + ' production available');
      sfx('place');
    }
  }

  // under-attack ping: own structure took a hit since last seen (throttled)
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner !== p.slot || s.lastHitTick < 0) continue;
    if (H.hitSeen[id] === s.lastHitTick) continue;
    H.hitSeen[id] = s.lastHitTick;
    if (st.tick - (H.hitPing[id] || -999) >= 20) {
      H.hitPing[id] = st.tick;
      const c = structCenter(s);
      addPing(game, c.x, c.y);
    }
  }

  updateTabs(game, p);
  updateGrid(game, p);
  updateActions(game, p);
  updateSelectionPanel(game, st);
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
    default: return m.reason || '';
  }
}

function updateGrid(game, p) {
  const H = game.hud;
  const all = buildGridItems(game.state, p, H.activeTab);
  const items = all.slice(H.page * BUILD_HOTKEYS.length,
    (H.page + 1) * BUILD_HOTKEYS.length);
  const metas = items.map((it) => gridItemMeta(game, p, it));
  let sig = H.activeTab + '|' + H.page + '|' + p.faction
    + (game.placement ? '|pl:' + game.placement.structId : '');
  for (const m of metas) {
    sig += '|' + m.id + ':' + (m.enabled ? 1 : 0) + ':' + m.reason + ':'
      + m.queued + ':' + (m.ready ? 1 : 0) + ':' + m.cost;
  }
  if (sig !== H.gridSig) {
    H.gridSig = sig;
    rebuildTiles(game, metas);
  }
  // cheap per-tick updates: production sweep only
  for (const m of metas) {
    const t = H.tiles[m.id];
    if (!t) continue;
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
    const label = m.kind === 'unit'
      ? unitHud(m.id, m.def.name) : structureHud(m.id, m.def.name);
    glyph.appendChild(h('span', 'bb-initials', initialsFor(label)));
    tile.appendChild(glyph);
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
      const r = reasonText(gridItemMeta(game, pp, m));
      if (r) lines.push(r);
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
      sfx('ui');
    } else if (!m.queued && m.enabled) {
      hudPushCmd(game, { type: 'buildStructure', structId: m.id });
      sfx('buildStart');
    } else if (!m.enabled) {
      sfx('error');
    }
  } else if (m.enabled) {
    hudPushCmd(game, { type: 'trainUnit', unitId: m.id });
    sfx('ui');
  } else {
    sfx('error');
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

// ---- hint banners + cursor flash ----------------------------------------------

export function showHint(game, text) {
  const root = game.hint || document.getElementById('hint');
  if (!root) return;
  const b = h('div', 'hint-banner', text);
  root.appendChild(b);
  if (typeof setTimeout === 'function') {
    setTimeout(() => { b.classList.add('fade'); }, 3600);
    setTimeout(() => { root.removeChild(b); }, 4400);
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
  const abGateName = abGateId
    ? structureLabel(abGateId, p.faction, st.structDefs[abGateId].name) : null;
  const abGateOk = !abGateId
    || standingStructs(st, p.slot, (s) => s.defId === abGateId).length > 0;
  let hasSw = false;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner === p.slot && st.structDefs[s.defId].type === 'SW') hasSw = true;
  }
  const swSec = hasSw ? Math.ceil(Math.max(0, p.swChargeTicks) / 10) : -1;
  const sig = [mcvSel ? mcvSel.id : 0, showAb ? abCd : 'x', showAb ? abGateOk : 'x', hasSw ? swSec : 'x',
    game.targeting ? game.targeting.kind : ''].join('|');
  if (sig === H.actSig) return;
  H.actSig = sig;
  H.actions.innerHTML = '';

  if (mcvSel) {
    const b = h('button', 'bb-action bb-deploy', 'DEPLOY [D]');
    b.addEventListener('click', () => {
      hudPushCmd(game, { type: 'deployMCV', unitId: mcvSel.id });
      sfx('deploy');
    });
    H.actions.appendChild(b);
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
    if (readySw && H.lastSwReady === false) sfx('swReady');
    H.lastSwReady = readySw;
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
  const root = document.getElementById('sel-panel');
  root.innerHTML = '';
  const sel = game.selection.filter((id) => st.units[id] || st.structures[id]);
  // inspected hostile (clicked in the fog-visible map) shows when nothing selected
  const insp = game.inspectId ? (st.units[game.inspectId] || st.structures[game.inspectId]) : null;
  if (insp && !sel.length) {
    appendInfoRows(game, root, st, insp, true);
    return;
  }
  if (!sel.length) return;
  const max = 12;
  for (let i = 0; i < Math.min(sel.length, max); i++) {
    const ent = st.units[sel[i]] || st.structures[sel[i]];
    const isU = !!st.units[sel[i]];
    const def = st.unitDefs[ent.defId] || st.structDefs[ent.defId];
    const ownerFac = ent.owner >= 0 ? st.players[ent.owner].faction : null;
    const label = isU ? unitHud(def.id, def.name)
      : structureLabel(def.id, ownerFac, def.name);
    const row = h('div', 'sel-row');
    const selShape = isU ? shapeForUnit(def) : shapeForStructure(def);
    row.appendChild(h('span', 'sel-glyph shape-' + selShape, initialsFor(label)));
    row.appendChild(h('span', 'sel-name', label));
    row.appendChild(h('span', 'sel-hp', ent.hp + '/' + ent.maxHp));
    const bar = h('span', 'sel-hpbar');
    const fill = h('span');
    fill.style.width = Math.floor(100 * ent.hp / ent.maxHp) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    root.appendChild(row);
  }
  if (sel.length > max) root.appendChild(h('div', 'sel-tip', '… +' + (sel.length - max) + ' more'));
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
    const ownerFac = ent.owner >= 0 ? st.players[ent.owner].faction : null;
    const label = isUnit ? unitHud(def.id, def.name)
      : structureLabel(def.id, ownerFac, def.name);
    const row = h('div', 'sel-row');
    const shape = isUnit ? shapeForUnit(def) : shapeForStructure(def);
    row.appendChild(h('span', 'sel-glyph shape-' + shape, initialsFor(label)));
    row.appendChild(h('span', 'sel-name', label));
    row.appendChild(h('span', 'sel-hp', ent.hp + '/' + ent.maxHp));
    root.appendChild(row);
  }
  const lines = [];
  if (isUnit) {
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
