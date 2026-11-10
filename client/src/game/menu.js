// Front-end + overlays: main menu, skirmish setup, Arsenal, Settings,
// multiplayer host/join + lobby, mission briefing, pause menu, end-of-match
// debrief and the desync halt. Pure DOM over the live 3D scene; every screen
// calls back into main.js through the hooks it was handed (onStart, opts.*)
// or the game.mp* entry points — the protocol itself lives in net/.
//
// Screens render into #menu inside a shared shell (scrim + content). The
// config object passed to onStart is unchanged from v0.11:
//   { map, faction, opponents:[{faction, personality, difficulty}], ally, tutorial }
import { tutorialSeen } from './hud.js';
import { requiredProducer } from '../sim/index.js';
import {
  h, el, icon, clear, fmtInt, fmtClock, lsGet, lsSet, lsGetJson,
  rovingFocus, gridCols, legible,
} from '../ui/dom.js';
import { brandLockup, crest, factionColor } from '../ui/brand.js';
import {
  factionLore, perkText, abilityInfo, superweaponInfo, interceptInfo, signatureUnits,
  PERSONALITY_INFO, DIFFICULTY_INFO, TIPS, CONTROLS,
} from '../ui/lore.js';
import { makeCameo } from '../ui/cameo.js';
import { drawMapPreview, waterShare } from '../ui/mapart.js';
import * as Settings from '../ui/settings.js';

// v0.5.1: 'Auto' (adaptive doctrine) is the default personality; the other
// four pin a fixed doctrine. Values are the internal ids (saved in cfg).
const PERSONALITIES = ['Auto', 'Front', 'Sky', 'Raid', 'Fortress'];
const DIFFICULTIES = ['recruit', 'veteran', 'elite', 'marshal'];
const SLOT_COLORS = ['#4da3ff', '#ff6b6b', '#69d781', '#ffd76a', '#c792ff', '#5ad4d4'];
const K_SETUP = 'mca.ui.skirmish';
const K_MP_NAME = 'mca.mp.name';
const K_MP_RELAY = 'mca.mp.relay';
const K_ARSENAL = 'mca.ui.arsenal';

// ---- shell ------------------------------------------------------------------------

let __onStart = null;        // main.js start callback, remembered for sub-screens
let __cleanup = [];          // teardown callbacks of the mounted screen
let __shellReady = false;
let __lastPauseOpts = null;

function menuRoot() { return document.getElementById('menu'); }

function runCleanup() {
  const list = __cleanup;
  __cleanup = [];
  for (const fn of list) { try { fn(); } catch (e) { /* teardown is best-effort */ } }
}

function onCleanup(fn) { __cleanup.push(fn); }

function syncIdle(game) {
  const root = menuRoot();
  const up = !!root && !root.classList.contains('hidden');
  document.body.classList.toggle('fe-idle', up && !game.state);
}

// one-time wiring: UI sounds, backdrop bookkeeping, late settings re-apply
function ensureShell(game) {
  if (__shellReady) return;
  __shellReady = true;
  document.body.classList.remove('booting');
  Settings.applySavedSettings(game);
  let tries = 0;
  const retry = setInterval(() => {
    if (Settings.applySavedSettings(game) || ++tries > 40) clearInterval(retry);
  }, 750);

  // main.js hides #menu by class when a match starts: drop the idle backdrop
  const root = menuRoot();
  if (root && typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      syncIdle(game);
      if (root.classList.contains('hidden')) { // screen closed (possibly by main.js)
        runCleanup();
        clear(root);
      }
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
  }

  // hover / click feedback for every menu-layer control
  const interactive = 'button, select, summary, .seg-opt, .switch, [role="button"]';
  let lastHover = null;
  const inUi = (t) => t && t.closest && t.closest('#menu, #banner, #briefing');
  document.addEventListener('pointerover', (e) => {
    const t = e.target && e.target.closest ? e.target.closest(interactive) : null;
    if (!t || t === lastHover || !inUi(t)) { if (!t) lastHover = null; return; }
    lastHover = t;
    if (!t.disabled) Settings.uiSound(game, 'ui_hover');
  }, true);
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest(interactive) : null;
    if (!t || !inUi(t)) return;
    Settings.unlockAudioSafe();
    const kind = t.dataset ? t.dataset.sfx : null;
    if (kind === 'none') return;
    if (t.classList.contains('disabled') || t.getAttribute('aria-disabled') === 'true') {
      Settings.uiSound(game, 'ui_deny');
    } else {
      Settings.uiSound(game, kind === 'confirm' ? 'ui_confirm' : kind === 'back' ? 'ui_back' : 'ui_click');
    }
  }, true);
}

// Every show* function starts here: tear the previous screen down first so
// the timers / listeners it registers through onCleanup belong to itself.
function beginScreen() { runCleanup(); }

// Mount a screen into #menu. `screen` names the layout (CSS hooks on
// data-screen); `node` is the screen element.
function mount(game, screen, node) {
  ensureShell(game);
  const root = menuRoot();
  root.classList.remove('hidden');
  root.dataset.screen = screen;
  clear(root);
  root.appendChild(h('div', 'fe-scrim'));
  root.appendChild(h('div', 'fe-fx'));
  root.appendChild(node);
  document.body.classList.add('in-menu');
  syncIdle(game);
  const tt = document.getElementById('tooltip');
  if (tt) tt.style.display = 'none';
  const af = node.querySelector('[data-autofocus]');
  if (af && af.focus) { try { af.focus({ preventScroll: true }); } catch (e) { /* no-op */ } }
  return node;
}

function subHeader(title, kicker, onBack, backLabel) {
  const head = h('header', 'sub-head');
  const back = el('button', { class: 'btn btn-back', type: 'button', dataset: { sfx: 'back' }, onclick: onBack }, [
    icon('back'), h('span', null, backLabel || 'Back'), h('span', 'kbd', 'Esc'),
  ]);
  head.appendChild(back);
  const t = h('div', 'sub-title');
  t.appendChild(h('span', 'sub-kicker', kicker || ''));
  t.appendChild(h('h1', null, title));
  head.appendChild(t);
  const b = brandLockup('sm');
  b.classList.add('sub-brand');
  head.appendChild(b);
  return head;
}

function selectEl(options, value, labelOf, onChange, title) {
  const wrap = h('span', 'select');
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = labelOf ? labelOf(o) : o;
    if (String(o) === String(value)) opt.selected = true;
    sel.appendChild(opt);
  }
  if (title) sel.title = title;
  if (onChange) sel.addEventListener('change', () => onChange(sel.value));
  wrap.appendChild(sel);
  wrap.appendChild(icon('chevD'));
  wrap.select = sel;
  return wrap;
}

let __segSeq = 0;
function segmented(options, value, onChange, cls) {
  const name = 'seg' + (++__segSeq);
  const wrap = h('div', 'seg' + (cls ? ' ' + cls : ''));
  wrap.setAttribute('role', 'radiogroup');
  for (const o of options) {
    const lab = h('label', 'seg-opt');
    const inp = document.createElement('input');
    inp.type = 'radio';
    inp.name = name;
    inp.value = o.value;
    inp.checked = String(o.value) === String(value);
    if (o.disabled) inp.disabled = true;
    inp.addEventListener('change', () => { if (inp.checked) onChange(o.value); });
    lab.appendChild(inp);
    const sp = h('span', null, o.label);
    if (o.title) lab.title = o.title;
    lab.appendChild(sp);
    wrap.appendChild(lab);
  }
  return wrap;
}

function switchEl(checked, onChange, label) {
  const lab = h('label', 'switch');
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.checked = !!checked;
  const state = h('span', 'switch-state', inp.checked ? 'On' : 'Off');
  inp.addEventListener('change', () => {
    state.textContent = inp.checked ? 'On' : 'Off';
    onChange(inp.checked);
  });
  lab.appendChild(inp);
  lab.appendChild(h('span', 'switch-track'));
  lab.appendChild(state);
  if (label) lab.appendChild(h('span', 'switch-label', label));
  lab.input = inp;
  lab.sync = () => { state.textContent = inp.checked ? 'On' : 'Off'; };
  return lab;
}

// Popover crest picker. Returns the trigger button; `onPick(faction)`.
function factionPicker(game, current, onPick, compact) {
  const data = game.data;
  const btn = el('button', { class: 'fac-pick' + (compact ? ' compact' : ''), type: 'button', 'aria-haspopup': 'listbox' });
  const paint = (f) => {
    clear(btn);
    btn.appendChild(crest(data, f, 'crest-sm'));
    btn.appendChild(h('span', 'fac-pick-name', f));
    btn.appendChild(icon('chevD'));
    btn.style.setProperty('--fc', legible(factionColor(data, f)));
  };
  paint(current);
  let pop = null;
  const close = () => {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    btn.setAttribute('aria-expanded', 'false');
  };
  const onDoc = (e) => { if (pop && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); btn.focus(); }
  };
  btn.addEventListener('click', () => {
    if (pop) { close(); return; }
    pop = h('div', 'fac-pop panel');
    pop.setAttribute('role', 'listbox');
    for (const f of Object.keys(data.factions)) {
      const b = el('button', { class: 'fac-pop-opt' + (f === current ? ' sel' : ''), type: 'button', role: 'option', title: data.factions[f].identity || '' }, [
        crest(data, f, 'crest-md'), h('span', null, f),
      ]);
      b.addEventListener('click', () => { current = f; paint(f); close(); btn.focus(); onPick(f); });
      pop.appendChild(b);
    }
    rovingFocus(pop, '.fac-pop-opt', 3);
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let x = Math.min(window.innerWidth - pw - 8, Math.max(8, r.left));
    let y = r.bottom + 6;
    if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    const selOpt = pop.querySelector('.sel') || pop.firstChild;
    if (selOpt) selOpt.focus();
  });
  onCleanup(close);
  return btn;
}

// Ask the 3D renderer (when one is up behind the menu) to render portraits
// for a faction now instead of waiting for the first match. Purely optional:
// cameos upgrade themselves whenever game.iconArt fills in.
function requestPortraits(game, faction) {
  try {
    const gl = game.gl;
    if (!gl || !gl.ents || !gl.portraits || typeof gl.portraits.requestAll !== 'function') return;
    if (!game._defIndex) {
      const structDefs = {}, unitDefs = {};
      for (const s of game.data.structures) structDefs[s.id] = s;
      for (const u of game.data.units) unitDefs[u.id] = u;
      game._defIndex = { structDefs, unitDefs };
    }
    gl.portraits.requestAll({
      players: [{ faction }], data: game.data,
      structDefs: game._defIndex.structDefs, unitDefs: game._defIndex.unitDefs,
    }, 0);
  } catch (e) { /* renderer not ready: the fallback glyphs stay */ }
}

// ---- main menu ----------------------------------------------------------------------

export function showMenu(game, onStart) {
  beginScreen();
  __onStart = onStart || __onStart;
  game.overlay = 'menu';
  game.resumePause = null;
  game.menuBack = null;
  if (document.body && document.body.classList) document.body.classList.add('in-menu');
  // hide any lingering in-match floaters
  const tt = document.getElementById('tooltip');
  if (tt) tt.style.display = 'none';
  const cl = document.getElementById('cursor-label');
  if (cl && cl.classList) cl.classList.remove('flash');
  const banner = document.getElementById('banner');
  if (banner) banner.classList.add('hidden');

  const maps = Object.keys(game.maps || {});
  const nFactions = Object.keys(game.data.factions).length;
  const screen = h('div', 'fe-screen fe-main');

  const brandWrap = h('header', 'main-brand');
  brandWrap.appendChild(brandLockup('lg'));
  screen.appendChild(brandWrap);

  const nav = h('nav', 'main-nav');
  nav.setAttribute('aria-label', 'Main menu');
  const entries = [
    { id: 'skirmish', label: 'Skirmish', desc: 'Command against AI generals across ' + maps.length + ' theatres',
      run: () => showSetup(game, __onStart, false) },
    { id: 'multiplayer', label: 'Multiplayer', desc: 'Host or join a room — up to 6 commanders, lockstep netcode',
      run: () => { if (game.openMpSetup) game.openMpSetup(); else showMpSetup(game, __onStart); } },
    { id: 'training', label: 'Training', desc: 'A guided first battle: deploy, build, fight',
      run: () => showSetup(game, __onStart, true) },
    { id: 'arsenal', label: 'Arsenal', desc: nFactions + ' factions · ' + game.data.units.length + ' units · '
      + game.data.structures.length + ' structures',
      run: () => showArsenal(game) },
    { id: 'settings', label: 'Settings', desc: 'Graphics, audio and the controls reference',
      run: () => showSettings(game, {}) },
    { id: 'support', label: 'Support', tag: 'Founder\'s Pass', desc: 'Back the project and unlock supporter perks',
      run: () => { if (game.openStore) game.openStore(); } },
  ];
  const items = [];
  let active = 0;
  const setActive = (i, focus) => {
    active = i;
    items.forEach((b, k) => b.classList.toggle('is-active', k === i));
    if (focus && items[i]) { try { items[i].focus({ preventScroll: true }); } catch (e) { /* no-op */ } }
  };
  entries.forEach((en, i) => {
    const b = el('button', { class: 'nav-item', type: 'button', dataset: { nav: en.id, sfx: 'confirm' } });
    b.appendChild(h('span', 'nav-idx', String(i + 1).padStart(2, '0')));
    const txt = h('span', 'nav-text');
    const lab = h('span', 'nav-label', en.label);
    if (en.tag) lab.appendChild(h('span', 'nav-tag', en.tag));
    txt.appendChild(lab);
    txt.appendChild(h('span', 'nav-desc', en.desc));
    b.appendChild(txt);
    b.appendChild(h('span', 'nav-arrow'));
    b.addEventListener('click', en.run);
    b.addEventListener('mouseenter', () => setActive(items.indexOf(b), false));
    b.addEventListener('focus', () => setActive(items.indexOf(b), false));
    if (en.id === 'support') b.classList.add('nav-support');
    items.push(b);
    nav.appendChild(b);
  });
  screen.appendChild(nav);

  // SUPPORT appears only when the store module has registered itself
  const support = items[items.length - 1];
  const syncStore = () => {
    const on = typeof game.openStore === 'function';
    support.classList.toggle('hidden', !on);
    support.disabled = !on;
  };
  syncStore();
  const storePoll = setInterval(syncStore, 600);
  onCleanup(() => clearInterval(storePoll));

  // footer: intel ticker + build tag
  const foot = h('footer', 'main-foot');
  const ticker = h('div', 'ticker');
  ticker.appendChild(h('span', 'ticker-tag', 'Intel'));
  const tickText = h('span', 'ticker-text', '');
  ticker.appendChild(tickText);
  foot.appendChild(ticker);
  const ver = (game.data && game.data.version) ? 'v' + game.data.version : '';
  const cfg = globalThis.MCA_CONFIG || {};
  foot.appendChild(h('div', 'build-tag', [ver, cfg.build ? 'build ' + cfg.build : 'browser build']
    .filter(Boolean).join('  ·  ')));
  screen.appendChild(foot);
  let tip = Math.floor(Math.random() * TIPS.length);
  const nextTip = () => {
    tip = (tip + 1) % TIPS.length;
    tickText.classList.remove('in');
    void tickText.offsetWidth;
    tickText.textContent = TIPS[tip];
    tickText.classList.add('in');
  };
  nextTip();
  const tipTimer = setInterval(nextTip, 7000);
  onCleanup(() => clearInterval(tipTimer));

  const hints = h('div', 'main-hints');
  hints.appendChild(h('span', 'kbd', '↑'));
  hints.appendChild(h('span', 'kbd', '↓'));
  hints.appendChild(h('span', null, 'Navigate'));
  hints.appendChild(h('span', 'kbd', 'Enter'));
  hints.appendChild(h('span', null, 'Select'));
  screen.appendChild(hints);

  // arrows / enter work from anywhere on the main menu, not just inside the nav
  const visible = () => items.filter((b) => !b.classList.contains('hidden'));
  const onKey = (e) => {
    if (game.overlay !== 'menu' || menuRoot().dataset.screen !== 'main') return;
    if (document.querySelector('.store-root:not(.store-hidden)')) return; // the store modal owns the keyboard
    const vis = visible();
    const cur = vis.indexOf(items[active]);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = (cur + (e.key === 'ArrowDown' ? 1 : -1) + vis.length) % vis.length;
      setActive(items.indexOf(vis[n]), true);
      Settings.uiSound(game, 'ui_hover');
      e.preventDefault();
    } else if (e.key === 'Home' || e.key === 'End') {
      setActive(items.indexOf(vis[e.key === 'Home' ? 0 : vis.length - 1]), true);
      e.preventDefault();
    } else if (e.key === 'Enter' && document.activeElement && !document.activeElement.closest('.nav-item')) {
      if (items[active]) items[active].click();
      e.preventDefault();
    }
  };
  document.addEventListener('keydown', onKey);
  onCleanup(() => document.removeEventListener('keydown', onKey));

  mount(game, 'main', screen);
  setActive(0, true);
}

// ---- skirmish setup -----------------------------------------------------------------

function loadSetup(game, tutorialPath) {
  const maps = Object.keys(game.maps);
  const factions = Object.keys(game.data.factions);
  const pick = (f, fallback) => (factions.includes(f) ? f : fallback);
  const cfg = {
    map: maps[0],
    faction: pick('Egypt', factions[0]),
    opponents: [{ faction: pick('Algeria', factions[factions.length > 1 ? 1 : 0]), personality: 'Auto', difficulty: 'recruit' }],
    ally: null,
    tutorial: false,
  };
  const saved = lsGetJson(K_SETUP, null);
  const cleanAi = (o, fallback) => ({
    faction: pick(o && o.faction, fallback),
    personality: PERSONALITIES.includes(o && o.personality) ? o.personality : 'Auto',
    difficulty: DIFFICULTIES.includes(o && o.difficulty) ? o.difficulty : 'recruit',
  });
  if (saved && typeof saved === 'object') {
    if (game.maps[saved.map]) cfg.map = saved.map;
    cfg.faction = pick(saved.faction, cfg.faction);
    if (Array.isArray(saved.opponents) && saved.opponents.length) {
      cfg.opponents = saved.opponents.slice(0, 5).map((o) => cleanAi(o, cfg.opponents[0].faction));
    }
    if (saved.ally) cfg.ally = cleanAi(saved.ally, pick('Saudi', factions[0]));
  }
  cfg.tutorial = !!tutorialPath;
  return cfg;
}

function saveSetup(cfg) {
  lsSet(K_SETUP, JSON.stringify({ map: cfg.map, faction: cfg.faction, opponents: cfg.opponents, ally: cfg.ally }));
}

function mapChips(md) {
  const chips = [];
  chips.push({ text: md.w + ' × ' + md.h, ico: 'grid' });
  chips.push({ text: md.spawns.length + ' players', ico: 'users' });
  chips.push({ text: (md.oil ? md.oil.length : 0) + ' oil fields', ico: 'oil' });
  const ws = waterShare(md);
  chips.push({ text: ws > 0.5 ? 'Naval theatre' : ws > 0.12 ? 'Littoral' : ws > 0 ? 'Mostly land' : 'Landlocked', ico: 'naval' });
  const th = md.theme;
  if (th && typeof th === 'object') {
    for (const k of ['biome', 'tod', 'weather']) {
      if (th[k]) chips.push({ text: String(th[k]).replace(/[_-]/g, ' '), cls: 'chip-gold' });
    }
  }
  return chips;
}

function chipRow(chips) {
  const row = h('div', 'chip-row');
  for (const c of chips) {
    const ch = h('span', 'chip' + (c.cls ? ' ' + c.cls : ''));
    if (c.ico) ch.appendChild(icon(c.ico));
    ch.appendChild(document.createTextNode(c.text));
    row.appendChild(ch);
  }
  return row;
}

function buildDossier(game, fname) {
  const data = game.data;
  const f = data.factions[fname];
  const lore = factionLore(fname);
  const box = h('div', 'dossier');
  box.style.setProperty('--fc', legible(f.color));
  const head = h('div', 'dossier-head');
  head.appendChild(crest(data, fname, 'crest-lg'));
  const ht = h('div', 'dossier-title');
  ht.appendChild(h('h2', null, fname));
  ht.appendChild(h('div', 'dossier-doctrine', f.identity || lore.doctrine));
  head.appendChild(ht);
  const count = data.units.filter((u) => u.faction === fname).length;
  head.appendChild(el('span', { class: 'chip' }, [icon('users'), count + ' units']));
  box.appendChild(head);
  if (lore.blurb) box.appendChild(h('p', 'dossier-blurb', lore.blurb));

  const facts = h('dl', 'dossier-facts');
  const fact = (ico, label, title, text, note, chip) => {
    const row = h('div', 'fact');
    const dt = h('dt');
    dt.appendChild(icon(ico));
    dt.appendChild(h('span', null, label));
    row.appendChild(dt);
    const dd = h('dd');
    const t = h('div', 'fact-title', title);
    if (chip) t.appendChild(h('span', 'chip ' + (chip.cls || ''), chip.text));
    dd.appendChild(t);
    if (text) dd.appendChild(h('div', 'fact-text', text));
    if (note) dd.appendChild(el('div', { class: 'fact-note' }, [icon('lock'), note]));
    row.appendChild(dd);
    facts.appendChild(row);
  };
  const perk = perkText(f);
  fact('credit', 'Economy', perk || 'Standard economy', perk ? '' : 'No economic modifier — this faction wins on doctrine.');
  const ab = abilityInfo(data, fname);
  if (ab) {
    fact('bolt', 'Ability', ab.name, ab.text, ab.gateName ? 'Requires ' + ab.gateName : '',
      ab.passive ? { text: 'Passive', cls: 'chip-cyan' } : { text: 'Active · ' + ab.cooldownS + 's', cls: 'chip-gold' });
  }
  const sw = superweaponInfo(data, fname);
  if (sw) fact('warhead', 'Superweapon', sw.name, (sw.payloadName ? sw.payloadName + '. ' : '') + sw.text);
  const ic = interceptInfo(data, fname);
  fact('shield', 'Interception', ic.name, ic.text, '', ic.has ? { text: ic.chance + '%', cls: 'chip-cyan' } : { text: 'None', cls: 'chip-red' });
  box.appendChild(facts);

  const roster = h('div', 'dossier-roster');
  roster.appendChild(h('div', 'micro', 'Signature units'));
  const strip = h('div', 'roster-strip');
  for (const u of signatureUnits(data, fname, 6)) {
    const c = h('div', 'roster-cell');
    c.title = u.name + ' — ' + u.cls;
    c.appendChild(makeCameo(game, u, 'unit', { code: true }));
    strip.appendChild(c);
  }
  roster.appendChild(strip);
  box.appendChild(roster);
  return box;
}

function showSetup(game, onStart, tutorialPath) {
  beginScreen();
  __onStart = onStart || __onStart;
  game.overlay = 'setup';
  const data = game.data;
  const factions = Object.keys(data.factions);
  const cfg = loadSetup(game, tutorialPath);
  if (tutorialPath) {
    // training: one easy opponent, no ally, the smallest sensible stage
    cfg.opponents = [{ faction: cfg.opponents[0].faction, personality: 'Auto', difficulty: 'recruit' }];
    cfg.ally = null;
  }

  const goBack = () => showMenu(game, __onStart);
  game.menuBack = goBack; // Esc on the setup screen goes Back

  const screen = h('div', 'fe-screen fe-sub fe-setup');
  screen.appendChild(subHeader(tutorialPath ? 'Training' : 'Skirmish',
    tutorialPath ? 'Guided first battle' : 'Operation setup', goBack));
  const grid = h('div', 'setup-grid');
  screen.appendChild(grid);

  // -- 01 faction ------------------------------------------------------------
  const colF = h('section', 'panel setup-col setup-faction');
  const headF = h('div', 'panel-head');
  headF.appendChild(h('span', 'step', '01'));
  headF.appendChild(h('span', 'micro', 'Choose your faction'));
  colF.appendChild(headF);
  const facGrid = h('div', 'fac-grid');
  facGrid.setAttribute('role', 'radiogroup');
  const facBtns = {};
  const dossierBox = h('div', 'dossier-wrap');
  const pickFaction = (fname) => {
    cfg.faction = fname;
    for (const k in facBtns) {
      facBtns[k].classList.toggle('sel', k === fname);
      facBtns[k].setAttribute('aria-checked', k === fname ? 'true' : 'false');
    }
    clear(dossierBox);
    dossierBox.appendChild(buildDossier(game, fname));
    requestPortraits(game, fname);
    renderForces();
    saveSetup(cfg);
  };
  for (const fname of factions) {
    const f = data.factions[fname];
    const b = el('button', { class: 'fac-tile', type: 'button', role: 'radio', title: f.identity || '' });
    b.style.setProperty('--fc', legible(f.color));
    b.appendChild(crest(data, fname, 'crest-md'));
    b.appendChild(h('span', 'fac-name', fname));
    b.appendChild(h('span', 'fac-ident', f.identity || ''));
    b.addEventListener('click', () => pickFaction(fname));
    facBtns[fname] = b;
    facGrid.appendChild(b);
  }
  rovingFocus(facGrid, '.fac-tile', () => gridCols(facGrid));
  colF.appendChild(facGrid);
  colF.appendChild(dossierBox);
  grid.appendChild(colF);

  // -- 02 map ----------------------------------------------------------------
  const colM = h('section', 'panel setup-col setup-map');
  const headM = h('div', 'panel-head');
  headM.appendChild(h('span', 'step', '02'));
  headM.appendChild(h('span', 'micro', 'Theatre of operations'));
  colM.appendChild(headM);
  const hero = h('div', 'map-hero');
  const plateCol = h('div', 'map-plate-col');
  const plate = h('div', 'map-plate brackets');
  const heroCanvas = document.createElement('canvas');
  plate.appendChild(heroCanvas);
  plateCol.appendChild(plate);
  const legend = h('div', 'map-legend');
  for (const [cls, label] of [['you', 'You'], ['ally', 'Ally'], ['enemy', 'Hostile'], ['open', 'Open'], ['oil', 'Oil']]) {
    const li = h('span', 'legend-item');
    li.appendChild(h('i', 'lg lg-' + cls));
    li.appendChild(document.createTextNode(label));
    legend.appendChild(li);
  }
  plateCol.appendChild(legend);
  hero.appendChild(plateCol);
  const mapInfo = h('div', 'map-info');
  hero.appendChild(mapInfo);
  colM.appendChild(hero);
  const listHead = h('div', 'map-list-head');
  listHead.appendChild(h('span', 'micro', Object.keys(game.maps).length + ' theatres'));
  colM.appendChild(listHead);
  const mapList = h('div', 'map-list');
  mapList.setAttribute('role', 'radiogroup');
  const mapBtns = {};
  const thumbCanvases = {};
  for (const m of Object.keys(game.maps)) {
    const md = game.maps[m];
    const b = el('button', { class: 'map-tile', type: 'button', role: 'radio', title: md.briefing || md.name || m });
    const th = h('span', 'map-thumb');
    const art = game.thumbArt && game.thumbArt[m];
    if (art) {
      const img = document.createElement('img');
      img.src = art; img.alt = ''; img.draggable = false;
      th.appendChild(img);
    } else {
      const cv = document.createElement('canvas');
      thumbCanvases[m] = cv;
      th.appendChild(cv);
    }
    th.appendChild(el('span', { class: 'map-tile-meta num' }, [icon('users'), String(md.spawns.length)]));
    b.appendChild(th);
    b.appendChild(h('span', 'map-tile-name', md.name || m));
    b.addEventListener('click', () => pickMap(m));
    mapBtns[m] = b;
    mapList.appendChild(b);
  }
  rovingFocus(mapList, '.map-tile', () => gridCols(mapList));
  colM.appendChild(mapList);
  grid.appendChild(colM);

  const spawnRoles = () => {
    const n = game.maps[cfg.map].spawns.length;
    const roles = [];
    let slot = 0;
    roles[slot++ % n] = 'you';
    if (cfg.ally) roles[slot++ % n] = 'ally';
    for (let i = 0; i < cfg.opponents.length; i++) roles[slot++ % n] = 'enemy';
    for (let i = 0; i < n; i++) if (!roles[i]) roles[i] = 'open';
    return roles;
  };
  const paintHero = () => {
    drawMapPreview(heroCanvas, game.maps[cfg.map], { roles: spawnRoles() });
  };
  const pickMap = (m) => {
    cfg.map = m;
    for (const k in mapBtns) {
      mapBtns[k].classList.toggle('sel', k === m);
      mapBtns[k].setAttribute('aria-checked', k === m ? 'true' : 'false');
    }
    const md = game.maps[m];
    clear(mapInfo);
    mapInfo.appendChild(h('div', 'micro', 'Selected theatre'));
    mapInfo.appendChild(h('h2', 'map-name', md.name || m));
    if (md.tagline) mapInfo.appendChild(h('div', 'map-tagline', md.tagline));
    mapInfo.appendChild(chipRow(mapChips(md)));
    mapInfo.appendChild(h('p', 'map-brief', md.briefing
      || 'Uncharted ground. Scout early, secure the oil fields and deny the enemy a second base.'));
    renderForces();
    saveSetup(cfg);
  };

  // -- 03 forces -------------------------------------------------------------
  const colO = h('section', 'panel setup-col setup-forces');
  const headO = h('div', 'panel-head');
  headO.appendChild(h('span', 'step', '03'));
  headO.appendChild(h('span', 'micro', 'Order of battle'));
  colO.appendChild(headO);
  const forces = h('div', 'forces-body');
  colO.appendChild(forces);
  const foot = h('div', 'forces-foot');
  const tutSwitch = switchEl(cfg.tutorial, (on) => { cfg.tutorial = on; }, 'Guided training');
  tutSwitch.classList.add('tutor-switch');
  tutSwitch.input.classList.add('tutor-check');
  tutSwitch.title = tutorialSeen()
    ? 'Replay the on-screen briefings that walk you through a first base'
    : 'On-screen briefings walk you through your first base';
  foot.appendChild(tutSwitch);
  const deploy = el('button', { class: 'btn btn-primary btn-lg btn-deploy', type: 'button', dataset: { sfx: 'confirm', autofocus: '1' } }, [
    h('span', null, 'Deploy'), icon('chevR'),
  ]);
  deploy.addEventListener('click', () => {
    saveSetup(cfg);
    menuRoot().classList.add('hidden');
    runCleanup();
    onStart({
      map: cfg.map,
      faction: cfg.faction,
      opponents: cfg.opponents.map((o) => ({ faction: o.faction, personality: o.personality, difficulty: o.difficulty })),
      ally: cfg.ally ? { faction: cfg.ally.faction, personality: cfg.ally.personality, difficulty: cfg.ally.difficulty } : null,
      tutorial: !!cfg.tutorial,
    });
  });
  foot.appendChild(deploy);
  colO.appendChild(foot);
  grid.appendChild(colO);

  function aiRow(entry, kind, onRemove) {
    const row = h('div', 'force-row ' + kind);
    const top = h('div', 'force-line');
    top.appendChild(factionPicker(game, entry.faction, (f) => { entry.faction = f; saveSetup(cfg); }));
    if (onRemove) {
      const rm = el('button', { class: 'btn btn-icon btn-sm btn-ghost force-remove', type: 'button', title: 'Remove', 'aria-label': 'Remove opponent' }, [icon('x')]);
      rm.addEventListener('click', onRemove);
      top.appendChild(rm);
    }
    row.appendChild(top);
    const bot = h('div', 'force-line');
    // display label + internal id on hover; the saved value stays the internal id
    const pSel = selectEl(PERSONALITIES, entry.personality, (p) => PERSONALITY_INFO[p].label,
      (v) => { entry.personality = v; pSel.select.title = PERSONALITY_INFO[v].text; saveSetup(cfg); },
      PERSONALITY_INFO[entry.personality].text);
    pSel.classList.add('grow');
    const dSel = selectEl(DIFFICULTIES, entry.difficulty, (d) => DIFFICULTY_INFO[d].label,
      (v) => { entry.difficulty = v; dSel.select.title = DIFFICULTY_INFO[v].text; saveSetup(cfg); },
      DIFFICULTY_INFO[entry.difficulty].text);
    pSel.select.setAttribute('aria-label', 'AI doctrine');
    dSel.select.setAttribute('aria-label', 'AI difficulty');
    bot.appendChild(pSel);
    bot.appendChild(dSel);
    row.appendChild(bot);
    return row;
  }

  function renderForces() {
    const spawns = game.maps[cfg.map].spawns.length;
    // free player count: you + 1..(spawns-1) AI, optional ally if room
    if (cfg.ally && spawns < 3) cfg.ally = null;
    const maxOpp = spawns - 1 - (cfg.ally ? 1 : 0);
    while (cfg.opponents.length > maxOpp) cfg.opponents.pop();
    while (cfg.opponents.length < 1) {
      cfg.opponents.push({ faction: factions.includes('Iran') ? 'Iran' : factions[0], personality: 'Auto', difficulty: 'recruit' });
    }
    clear(forces);

    const t1 = h('div', 'team team-own');
    const t1h = h('div', 'team-head');
    t1h.appendChild(h('span', 'team-name', 'Team 1'));
    t1h.appendChild(h('span', 'chip chip-cyan', 'Allied'));
    t1.appendChild(t1h);
    const you = h('div', 'force-row you');
    const yl = h('div', 'force-line');
    yl.appendChild(crest(data, cfg.faction, 'crest-sm'));
    yl.appendChild(h('span', 'force-name', cfg.faction));
    yl.appendChild(h('span', 'chip chip-cyan', 'You'));
    you.appendChild(yl);
    t1.appendChild(you);
    const allySw = switchEl(!!cfg.ally, (on) => {
      cfg.ally = on
        ? { faction: factions.includes('Saudi') ? 'Saudi' : factions[0], personality: 'Auto', difficulty: 'recruit' }
        : null;
      renderForces();
      saveSetup(cfg);
    }, 'AI ally (2 v n)');
    allySw.classList.add('ally-switch');
    allySw.input.disabled = spawns < 3;
    if (spawns < 3) allySw.title = 'This theatre only has room for two commanders';
    t1.appendChild(allySw);
    if (cfg.ally) t1.appendChild(aiRow(cfg.ally, 'ally', null));
    forces.appendChild(t1);

    const t2 = h('div', 'team team-foe');
    const t2h = h('div', 'team-head');
    t2h.appendChild(h('span', 'team-name', 'Team 2'));
    t2h.appendChild(h('span', 'chip chip-red', 'Hostile'));
    t2h.appendChild(h('span', 'team-count num', cfg.opponents.length + ' / ' + maxOpp));
    t2.appendChild(t2h);
    cfg.opponents.forEach((o, i) => {
      t2.appendChild(aiRow(o, 'enemy', cfg.opponents.length > 1 ? () => {
        cfg.opponents.splice(i, 1);
        renderForces();
        saveSetup(cfg);
      } : null));
    });
    const add = el('button', { class: 'btn btn-sm btn-block force-add', type: 'button' }, [icon('plus'), 'Add opponent']);
    add.disabled = cfg.opponents.length >= maxOpp;
    if (add.disabled) add.title = 'Every start position on this theatre is taken';
    add.addEventListener('click', () => {
      if (cfg.opponents.length < maxOpp) {
        cfg.opponents.push({ faction: factions.includes('Turkey') ? 'Turkey' : factions[0], personality: 'Auto', difficulty: 'recruit' });
        renderForces();
        saveSetup(cfg);
      }
    });
    t2.appendChild(add);
    forces.appendChild(t2);

    // rules of engagement: the facts every match shares
    const roe = h('div', 'roe');
    roe.appendChild(h('div', 'micro', 'Rules of engagement'));
    const sides = (1 + (cfg.ally ? 1 : 0)) + ' v ' + cfg.opponents.length;
    const k = data.knobs || {};
    for (const [ico, label, value] of [
      ['users', 'Engagement', sides],
      ['credit', 'Starting credits', fmtInt(k.StartCredits || 0)],
      ['target', 'Victory', 'Destroy every enemy Construction Yard'],
      ['eye', 'Fog of war', 'On — scout to reveal'],
    ]) {
      roe.appendChild(el('div', { class: 'roe-row' }, [icon(ico), h('span', 'roe-label', label), h('span', 'roe-val', value)]));
    }
    forces.appendChild(roe);
    paintHero();
  }

  mount(game, 'setup', screen);
  pickFaction(cfg.faction);
  pickMap(cfg.map);
  // thumbnails paint after layout so the canvases know their CSS size
  const paintThumbs = () => {
    for (const m in thumbCanvases) {
      drawMapPreview(thumbCanvases[m], game.maps[m], { grid: false, oil: false, fit: 'cover' });
    }
    paintHero();
  };
  paintThumbs();
  const sel = mapBtns[cfg.map];
  if (sel && sel.scrollIntoView) { try { sel.scrollIntoView({ block: 'nearest' }); } catch (e) { /* no-op */ } }
  let rz = 0;
  const onResize = () => { clearTimeout(rz); rz = setTimeout(paintThumbs, 120); };
  window.addEventListener('resize', onResize);
  onCleanup(() => window.removeEventListener('resize', onResize));
  // the display face may land after first paint: repaint the marker labels
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (heroCanvas.isConnected) paintHero(); });
}

// ---- arsenal ------------------------------------------------------------------------

const ARSENAL_CATS = [
  { id: 'all', label: 'All', ico: 'grid' },
  { id: 'infantry', label: 'Infantry', ico: 'infantry', prod: 'SH-04' },
  { id: 'vehicles', label: 'Vehicles', ico: 'vehicles', prod: 'SH-05' },
  { id: 'air', label: 'Air', ico: 'air', prod: 'SH-06' },
  { id: 'naval', label: 'Naval', ico: 'naval', prod: 'SH-07' },
  { id: 'structures', label: 'Structures', ico: 'structures' },
];
const DMG_COLS = [
  ['inf', 'Infantry'], ['light', 'Light vehicles'], ['armor', 'Armour'], ['air', 'Aircraft'], ['bldg', 'Structures'],
];
const STRUCT_TYPE = {
  Core: 'Command', Eco: 'Economy', Prod: 'Production', Tech: 'Technology',
  Def: 'Defence', Unique: 'Faction special', SW: 'Superweapon',
};

function statMax(data) {
  const mx = { hp: 1, speed: 1, range: 1, sight: 1, cost: 1, dmg: 1, shp: 1 };
  for (const u of data.units) {
    mx.hp = Math.max(mx.hp, u.hp); mx.speed = Math.max(mx.speed, u.speed);
    mx.range = Math.max(mx.range, u.range); mx.sight = Math.max(mx.sight, u.sight);
    mx.cost = Math.max(mx.cost, u.cost);
    for (const k in u.dmg) mx.dmg = Math.max(mx.dmg, u.dmg[k]);
  }
  for (const s of data.structures) {
    mx.shp = Math.max(mx.shp, s.hp);
    if (s.dmg) for (const k in s.dmg) mx.dmg = Math.max(mx.dmg, s.dmg[k]);
    if (s.range) mx.range = Math.max(mx.range, s.range);
  }
  return mx;
}

// curve 'sqrt' spreads small values out (damage tables span 1..120)
function statBar(label, value, max, text, cls, curve) {
  const row = h('div', 'stat-row' + (cls ? ' ' + cls : ''));
  row.appendChild(h('span', 'stat-label', label));
  const m = h('span', 'meter meter-seg');
  const fill = h('span');
  let frac = Math.max(0, Math.min(1, value / Math.max(1, max)));
  if (curve === 'sqrt') frac = Math.sqrt(frac);
  fill.style.width = Math.round(100 * frac) + '%';
  m.appendChild(fill);
  row.appendChild(m);
  row.appendChild(h('span', 'stat-val num', text !== undefined ? text : String(value)));
  return row;
}

function showArsenal(game) {
  beginScreen();
  game.overlay = 'setup';
  const data = game.data;
  const factions = Object.keys(data.factions);
  const saved = lsGetJson(K_ARSENAL, {}) || {};
  const state = {
    faction: factions.includes(saved.faction) ? saved.faction : factions[0],
    cat: ARSENAL_CATS.some((c) => c.id === saved.cat) ? saved.cat : 'all',
    sel: null,
  };
  const mx = statMax(data);
  const structById = {};
  for (const s of data.structures) structById[s.id] = s;

  const goBack = () => showMenu(game, __onStart);
  game.menuBack = goBack;

  const screen = h('div', 'fe-screen fe-sub fe-arsenal');
  screen.appendChild(subHeader('Arsenal', 'Order of battle — every unit and structure', goBack));
  const body = h('div', 'arsenal-grid');
  screen.appendChild(body);

  // faction rail
  const rail = h('nav', 'panel arsenal-rail');
  rail.setAttribute('aria-label', 'Factions');
  const railBtns = {};
  for (const f of factions) {
    const b = el('button', { class: 'rail-item', type: 'button', title: f + ' — ' + (data.factions[f].identity || '') });
    b.style.setProperty('--fc', legible(data.factions[f].color));
    b.appendChild(crest(data, f, 'crest-md'));
    const t = h('span', 'rail-text');
    t.appendChild(h('span', 'rail-name', f));
    t.appendChild(h('span', 'rail-ident', data.factions[f].identity || ''));
    b.appendChild(t);
    b.addEventListener('click', () => { state.faction = f; state.sel = null; render(); });
    railBtns[f] = b;
    rail.appendChild(b);
  }
  rovingFocus(rail, '.rail-item', 0);
  body.appendChild(rail);

  // centre: filters + cards
  const centre = h('section', 'panel arsenal-main');
  const filt = h('div', 'arsenal-filters');
  const catBtns = {};
  for (const c of ARSENAL_CATS) {
    const b = el('button', { class: 'tab', type: 'button' }, [icon(c.ico), h('span', null, c.label), h('span', 'tab-count num', '')]);
    b.addEventListener('click', () => { state.cat = c.id; state.sel = null; render(); });
    catBtns[c.id] = b;
    filt.appendChild(b);
  }
  centre.appendChild(filt);
  const cards = h('div', 'arsenal-cards');
  centre.appendChild(cards);
  body.appendChild(centre);

  // detail
  const detail = h('aside', 'panel arsenal-detail');
  body.appendChild(detail);

  const entriesFor = (f) => {
    const units = data.units.filter((u) => u.faction === f).map((u) => ({ kind: 'unit', def: u, cat: catOfUnit(u) }));
    const structs = data.structures.filter((s) => s.faction === f || s.faction === 'All')
      .sort((a, b) => (a.faction === 'All' ? 1 : 0) - (b.faction === 'All' ? 1 : 0))
      .map((s) => ({ kind: 'struct', def: s, cat: 'structures' }));
    const order = (e) => ARSENAL_CATS.findIndex((c) => c.id === e.cat);
    // stable: sheet order inside each branch
    return units.concat(structs).map((e, i) => [e, i])
      .sort((a, b) => (order(a[0]) - order(b[0])) || (a[1] - b[1])).map((x) => x[0]);
  };
  function catOfUnit(u) {
    const p = requiredProducer(u);
    return p === 'SH-04' ? 'infantry' : p === 'SH-06' ? 'air' : p === 'SH-07' ? 'naval' : 'vehicles';
  }

  function renderDetail(en) {
    clear(detail);
    if (!en) return;
    const d = en.def;
    detail.style.setProperty('--fc', legible(factionColor(data, state.faction)));
    const top = h('div', 'detail-top');
    const port = h('div', 'detail-portrait brackets');
    port.appendChild(makeCameo(game, d, en.kind));
    top.appendChild(port);
    const tt = h('div', 'detail-title');
    tt.appendChild(h('div', 'micro', en.kind === 'unit' ? d.id + ' · ' + d.domain : d.id + ' · Structure'));
    tt.appendChild(h('h2', null, d.name));
    const chips = [];
    if (en.kind === 'unit') {
      chips.push({ text: d.cls });
      if (d.role) chips.push({ text: d.role });
      if (d.tech === 1) chips.push({ text: 'Tech tier', cls: 'chip-gold' });
      if (d.unique) chips.push({ text: 'Unique', cls: 'chip-cyan' });
    } else {
      chips.push({ text: STRUCT_TYPE[d.type] || d.type, cls: d.type === 'SW' ? 'chip-red' : '' });
      chips.push({ text: d.faction === 'All' ? 'All factions' : d.faction, cls: d.faction === 'All' ? '' : 'chip-gold' });
    }
    tt.appendChild(chipRow(chips));
    top.appendChild(tt);
    detail.appendChild(top);

    const tiles = h('div', 'detail-tiles');
    const tile = (ico, label, value) => {
      const t = h('div', 'dtile');
      t.appendChild(icon(ico));
      t.appendChild(h('span', 'dtile-val num', value));
      t.appendChild(h('span', 'dtile-label', label));
      tiles.appendChild(t);
    };
    tile('credit', 'Cost', fmtInt(d.cost));
    tile('clock', 'Build', d.build_s ? d.build_s + 's' : '—');
    if (en.kind === 'unit') {
      const p = structById[requiredProducer(d)];
      tile('structures', 'Built at', p ? p.name.split(' / ')[0] : '—');
    } else {
      tile('bolt', 'Power', d.power_out > 0 ? '+' + d.power_out : d.power_use > 0 ? '−' + d.power_use : '0');
    }
    detail.appendChild(tiles);

    const stats = h('div', 'detail-stats');
    if (en.kind === 'unit') {
      stats.appendChild(statBar('Hit points', d.hp, mx.hp, fmtInt(d.hp)));
      stats.appendChild(statBar('Speed', d.speed, mx.speed));
      stats.appendChild(statBar('Weapon range', d.range, mx.range, d.range > 0 ? String(d.range) : '—'));
      stats.appendChild(statBar('Sight', d.sight, mx.sight));
    } else {
      stats.appendChild(statBar('Hit points', d.hp, mx.shp, fmtInt(d.hp)));
      if (d.range) stats.appendChild(statBar('Weapon range', d.range, mx.range));
    }
    detail.appendChild(stats);

    if (en.kind === 'unit') {
      const inc = data.armorIncoming && data.armorIncoming[d.armor];
      const arm = h('div', 'detail-line');
      arm.appendChild(h('span', 'micro', 'Armour'));
      arm.appendChild(h('span', 'chip', d.armor));
      if (inc !== undefined && inc !== 1) {
        arm.appendChild(h('span', 'detail-note', inc < 1
          ? 'takes ' + Math.round((1 - inc) * 100) + '% less damage'
          : 'takes ' + Math.round((inc - 1) * 100) + '% more damage'));
      }
      detail.appendChild(arm);
    }

    if (d.dmg && Object.keys(d.dmg).some((k) => d.dmg[k] > 0)) {
      const sec = h('div', 'detail-sec');
      const sh = h('div', 'detail-sec-head');
      sh.appendChild(h('span', 'micro', 'Damage per volley'));
      if (d.rof_s) sh.appendChild(h('span', 'detail-note', 'fires every ' + d.rof_s + 's'));
      sec.appendChild(sh);
      for (const [k, label] of DMG_COLS) {
        const v = d.dmg[k] || 0;
        sec.appendChild(statBar(label, v, mx.dmg, v > 0 ? String(v) : '—', v > 0 ? 'dmg' : 'dmg nil', 'sqrt'));
      }
      detail.appendChild(sec);
    }

    const para = (label, text, cls) => {
      if (!text || text === '—') return;
      const sec = h('div', 'detail-sec' + (cls ? ' ' + cls : ''));
      sec.appendChild(h('div', 'micro', label));
      sec.appendChild(h('p', null, text));
      detail.appendChild(sec);
    };
    if (en.kind === 'unit') {
      para('Ability', d.ability);
      if (d.hardCounter || d.softCounter) {
        const sec = h('div', 'detail-sec');
        sec.appendChild(h('div', 'micro', 'Counters'));
        if (d.hardCounter) {
          sec.appendChild(el('div', { class: 'counter hard' }, [icon('warn'), h('b', null, 'Beaten by'), h('span', null, d.hardCounter)]));
        }
        if (d.softCounter) {
          sec.appendChild(el('div', { class: 'counter soft' }, [icon('info'), h('b', null, 'Threatened by'), h('span', null, d.softCounter)]));
        }
        detail.appendChild(sec);
      }
      const kits = (data.upgrades || []).filter((g) => g.appliesTo && g.appliesTo.includes(d.id));
      if (kits.length) {
        const sec = h('div', 'detail-sec');
        sec.appendChild(h('div', 'micro', 'Research'));
        for (const g of kits) {
          const p = structById[g.producer];
          sec.appendChild(el('div', { class: 'kit-line' }, [
            h('b', null, g.label),
            h('span', 'num', fmtInt(g.cost) + ' cr'),
            h('span', 'detail-note', '+' + Math.round((g.hpMul - 1) * 100) + '% HP · +'
              + Math.round((g.dmgMul - 1) * 100) + '% damage' + (p ? ' · ' + p.name.split(' / ')[0] : '')),
          ]));
        }
        detail.appendChild(sec);
      }
    } else {
      para('Unlocks', d.unlocks);
      if (d.type === 'SW') {
        const sw = superweaponInfo(data, d.faction);
        if (sw) para('Payload', sw.text);
        para('Counterplay', 'Enemy factions fielding an interceptor can stop warheads that fall near their defensive structures.');
      }
      if (d.type === 'Unique' || d.type === 'SW') {
        const ab = abilityInfo(data, d.faction);
        if (ab && ab.gateId === d.id) para('Enables ' + ab.name, ab.text);
      }
    }
  }

  function render() {
    lsSet(K_ARSENAL, JSON.stringify({ faction: state.faction, cat: state.cat }));
    requestPortraits(game, state.faction);
    for (const f in railBtns) railBtns[f].classList.toggle('sel', f === state.faction);
    const all = entriesFor(state.faction);
    for (const c of ARSENAL_CATS) {
      const n = c.id === 'all' ? all.length : all.filter((e) => e.cat === c.id).length;
      catBtns[c.id].classList.toggle('sel', c.id === state.cat);
      catBtns[c.id].querySelector('.tab-count').textContent = String(n);
      catBtns[c.id].disabled = n === 0;
    }
    const list = state.cat === 'all' ? all : all.filter((e) => e.cat === state.cat);
    clear(cards);
    cards.style.setProperty('--fc', legible(factionColor(data, state.faction)));
    if (!state.sel || !list.some((e) => e.def.id === state.sel)) state.sel = list.length ? list[0].def.id : null;
    const cardEls = {};
    let lastCat = null;
    for (const en of list) {
      if (state.cat === 'all' && en.cat !== lastCat) {
        lastCat = en.cat;
        const c = ARSENAL_CATS.find((x) => x.id === en.cat);
        cards.appendChild(el('div', { class: 'cards-divider' }, [icon(c.ico), h('span', 'micro', c.label)]));
      }
      const b = el('button', { class: 'acard', type: 'button', title: en.def.name });
      b.appendChild(makeCameo(game, en.def, en.kind));
      const meta = h('span', 'acard-meta');
      meta.appendChild(h('span', 'acard-name', en.def.name));
      meta.appendChild(el('span', { class: 'acard-cost num' }, [icon('credit'), fmtInt(en.def.cost)]));
      b.appendChild(meta);
      if (en.kind === 'unit' && en.def.tech === 1) b.appendChild(h('span', 'acard-tier', 'T2'));
      b.addEventListener('click', () => select(en.def.id));
      b.addEventListener('focus', () => select(en.def.id));
      cardEls[en.def.id] = b;
      cards.appendChild(b);
    }
    function select(id) {
      if (state.sel === id && detail.dataset.shown === id) return;
      state.sel = id;
      for (const k in cardEls) cardEls[k].classList.toggle('sel', k === id);
      detail.dataset.shown = id;
      renderDetail(list.find((e) => e.def.id === id));
    }
    detail.dataset.shown = '';
    if (state.sel) select(state.sel); else clear(detail);
    cards.scrollTop = 0;
  }
  rovingFocus(cards, '.acard', () => {
    const first = cards.querySelector('.acard');
    return first ? Math.max(1, Math.floor(cards.clientWidth / Math.max(1, first.offsetWidth))) : 1;
  });

  mount(game, 'arsenal', screen);
  render();
}

// ---- settings -----------------------------------------------------------------------

function sliderRow(label, value, onInput, note) {
  const row = h('div', 'set-row');
  const lab = h('div', 'set-label');
  lab.appendChild(h('span', 'set-name', label));
  if (note) lab.appendChild(h('span', 'set-note', note));
  row.appendChild(lab);
  const ctl = h('div', 'set-ctl');
  const inp = document.createElement('input');
  inp.type = 'range';
  inp.className = 'slider';
  inp.min = '0'; inp.max = '100'; inp.step = '1';
  inp.value = String(Math.round(value * 100));
  inp.setAttribute('aria-label', label);
  const val = h('span', 'set-val num', inp.value);
  const sync = () => {
    inp.style.setProperty('--v', inp.value + '%');
    val.textContent = inp.value;
  };
  sync();
  inp.addEventListener('input', () => { sync(); onInput(Number(inp.value) / 100, false); });
  inp.addEventListener('change', () => onInput(Number(inp.value) / 100, true));
  ctl.appendChild(inp);
  ctl.appendChild(val);
  row.appendChild(ctl);
  return row;
}

function settingRow(label, note, control) {
  const row = h('div', 'set-row');
  const lab = h('div', 'set-label');
  lab.appendChild(h('span', 'set-name', label));
  if (note) lab.appendChild(h('span', 'set-note', note));
  row.appendChild(lab);
  const ctl = h('div', 'set-ctl');
  ctl.appendChild(control);
  row.appendChild(ctl);
  return row;
}

// opts.from === 'pause' returns to the pause menu instead of the main menu
function showSettings(game, opts) {
  beginScreen();
  const fromPause = !!(opts && opts.from === 'pause');
  const goBack = () => {
    if (fromPause && __lastPauseOpts) showPauseMenu(game, __lastPauseOpts);
    else showMenu(game, __onStart);
  };
  if (fromPause) { game.overlay = 'pause'; game.resumePause = goBack; }
  else { game.overlay = 'setup'; game.menuBack = goBack; }

  let tab = (opts && opts.tab) || lsGet('mca.ui.settingsTab', 'graphics');
  const screen = h('div', 'fe-screen fe-sub fe-settings');
  screen.appendChild(subHeader('Settings', fromPause ? 'Mission paused' : 'System configuration', goBack));
  const wrap = h('div', 'panel settings-panel');
  const tabs = h('div', 'settings-tabs');
  const body = h('div', 'settings-body');
  const TABS = [
    { id: 'graphics', label: 'Graphics', ico: 'monitor' },
    { id: 'audio', label: 'Audio', ico: 'volume' },
    { id: 'controls', label: 'Controls', ico: 'keyboard' },
  ];
  const tabBtns = {};
  for (const t of TABS) {
    const b = el('button', { class: 'tab', type: 'button', role: 'tab' }, [icon(t.ico), h('span', null, t.label)]);
    b.addEventListener('click', () => { tab = t.id; lsSet('mca.ui.settingsTab', tab); render(); });
    tabBtns[t.id] = b;
    tabs.appendChild(b);
  }
  rovingFocus(tabs, '.tab', 0);
  wrap.appendChild(tabs);
  wrap.appendChild(body);
  screen.appendChild(wrap);

  function renderGraphics() {
    const sec = h('div', 'set-sec');
    sec.appendChild(h('h3', null, 'Rendering'));
    if (Settings.qualityAvailable(game)) {
      const cur = Settings.getQuality(game);
      const note = h('span', 'set-note');
      const describe = (q) => { const d = Settings.QUALITY_LEVELS.find((x) => x.id === q); note.textContent = d ? d.text : ''; };
      const seg = segmented(Settings.QUALITY_LEVELS.map((q) => ({ value: q.id, label: q.label })), cur,
        (v) => { Settings.setQuality(game, v); describe(v); });
      const row = settingRow('Quality preset', '', seg);
      row.querySelector('.set-label').appendChild(note);
      describe(cur);
      sec.appendChild(row);
    } else {
      sec.appendChild(el('div', { class: 'set-empty' }, [icon('info'),
        'Quality presets appear here once the 3D renderer is running on this device.']));
    }
    // legacy renderer switch (main.js owns #gfx3d; we drive it by proxy)
    const legacy = document.getElementById('gfx3d');
    if (legacy && typeof game.gfxSupported === 'boolean') {
      const sw = switchEl(game.gfx === '3d', (on) => {
        legacy.checked = on;
        legacy.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => { sw.input.checked = game.gfx === '3d'; sw.sync(); }, 0);
      });
      sw.input.disabled = !game.gfxSupported;
      sec.appendChild(settingRow('3D battlefield',
        game.gfxSupported ? 'Turn off to fall back to the classic top-down view. Applies to the next match.'
          : 'WebGL is unavailable on this device — the classic top-down view is in use.', sw));
    }
    body.appendChild(sec);

    const sec2 = h('div', 'set-sec');
    sec2.appendChild(h('h3', null, 'Interface'));
    sec2.appendChild(settingRow('Frosted glass panels',
      'Blurs the battlefield behind HUD panels. Turn off to save GPU time on integrated graphics.',
      switchEl(Settings.getGlassBlur(), (on) => Settings.setGlassBlur(on))));
    body.appendChild(sec2);
  }

  function renderAudio() {
    const sec = h('div', 'set-sec');
    sec.appendChild(h('h3', null, 'Mix'));
    for (const k of Settings.VOLUME_KINDS) {
      if (!Settings.volumeSupported(k.id)) continue;
      sec.appendChild(sliderRow(k.label, Settings.getVolume(k.id), (v, done) => {
        Settings.setVolume(k.id, v);
        if (done && k.id !== 'music') Settings.uiSound(game, 'ui_click');
      }));
    }
    if (!Settings.mixerAvailable()) {
      sec.appendChild(el('div', { class: 'set-empty' }, [icon('info'),
        'Separate music, effects and voice levels unlock with the new audio mixer.']));
    }
    body.appendChild(sec);
    const sec2 = h('div', 'set-sec');
    sec2.appendChild(h('h3', null, 'Channels'));
    if (Settings.musicAvailable()) {
      sec2.appendChild(settingRow('Music', 'Adaptive score — calm between fights, driving under fire.',
        switchEl(Settings.getMusic(game), (on) => {
          Settings.unlockAudioSafe();
          Settings.setMusic(game, on);
          if (game.hud && game.hud.syncAudioBtns) game.hud.syncAudioBtns();
        })));
    }
    if (Settings.muteAvailable()) {
      sec2.appendChild(settingRow('Mute effects and voice', 'Also toggled in a match with M.',
        switchEl(Settings.getMuted(game), (on) => {
          Settings.setMutedPref(game, on);
          if (game.hud && game.hud.syncAudioBtns) game.hud.syncAudioBtns();
        })));
    }
    body.appendChild(sec2);
  }

  function renderControls() {
    const gridEl = h('div', 'controls-grid');
    for (const group of CONTROLS) {
      const g = h('div', 'ctl-group');
      g.appendChild(h('h3', null, group.title));
      for (const row of group.rows) {
        const r = h('div', 'ctl-row');
        const keys = h('span', 'ctl-keys');
        row.slice(0, -1).forEach((k) => keys.appendChild(h('span', 'kbd', k[0])));
        r.appendChild(keys);
        r.appendChild(h('span', 'ctl-desc', row[row.length - 1]));
        g.appendChild(r);
      }
      gridEl.appendChild(g);
    }
    body.appendChild(gridEl);
  }

  function render() {
    for (const k in tabBtns) {
      tabBtns[k].classList.toggle('sel', k === tab);
      tabBtns[k].setAttribute('aria-selected', k === tab ? 'true' : 'false');
    }
    clear(body);
    body.dataset.tab = tab;
    if (tab === 'audio') renderAudio();
    else if (tab === 'controls') renderControls();
    else renderGraphics();
    body.scrollTop = 0;
  }
  mount(game, fromPause ? 'settings-pause' : 'settings', screen);
  render();
}

// ---- multiplayer --------------------------------------------------------------------
// The MULTIPLAYER entry, the host/join screen and the host-authoritative
// lobby. Everything reads the net object off `game.net` (never an import) so
// headless harnesses can inject a fake; the socket work lives in net/net.js.

// Relay URL preference: a manual override the player typed > MCA_CONFIG.relayUrl
// > same-origin /ws on a deployed http(s) origin > Net's built-in default.
function defaultRelayUrl(game) {
  const cfg = globalThis.MCA_CONFIG || {};
  if (cfg.relayUrl) return String(cfg.relayUrl);
  let dev = false;
  try { dev = !!(import.meta.env && import.meta.env.DEV); } catch (e) { dev = false; }
  try {
    const loc = globalThis.location;
    if (!dev && loc && (loc.protocol === 'https:' || loc.protocol === 'http:') && loc.host) {
      return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws';
    }
  } catch (e) { /* no location */ }
  return (game.net && game.net.url) || 'ws://127.0.0.1:8790';
}

function friendlyNetError(raw, url) {
  const s = String(raw || '');
  if (/No room with code/i.test(s)) return { title: s, detail: 'Check the code with your host — codes are four characters and expire when the host leaves.' };
  if (/room is full/i.test(s)) return { title: 'That room is full.', detail: 'Ask the host to open a new room, or pick a larger theatre.' };
  if (/WebSocket is not available/i.test(s)) return { title: 'This browser cannot open a multiplayer connection.', detail: s };
  if (/Could not reach|Could not open/i.test(s) || !s) {
    return {
      title: 'Could not reach the multiplayer relay.',
      detail: 'Nothing answered at ' + url + '. Check your connection, or set a different relay address under Advanced.',
    };
  }
  return { title: 'Could not connect.', detail: s };
}

export function showMpSetup(game, onStart) {
  beginScreen();
  __onStart = onStart || __onStart;
  game.overlay = 'setup';
  game.resumePause = null;
  if (document.body && document.body.classList) document.body.classList.add('in-menu');
  const goBack = () => showMenu(game, __onStart);
  game.menuBack = goBack;

  const screen = h('div', 'fe-screen fe-sub fe-mp');
  screen.appendChild(subHeader('Multiplayer', 'Lockstep battles for 2–6 commanders', goBack));
  const wrap = h('div', 'mp-wrap');
  screen.appendChild(wrap);

  // identity strip
  const ident = h('div', 'panel mp-ident');
  const nameField = h('label', 'field');
  nameField.appendChild(h('span', 'micro', 'Callsign'));
  const name = el('input', { class: 'input', type: 'text', maxlength: '16', spellcheck: 'false', autocomplete: 'off' });
  name.value = lsGet(K_MP_NAME, 'Commander');
  name.addEventListener('change', () => lsSet(K_MP_NAME, name.value.trim() || 'Commander'));
  nameField.appendChild(name);
  ident.appendChild(nameField);
  const pref = lsGetJson(K_SETUP, null);
  const factions = Object.keys(game.data.factions);
  let myFaction = pref && factions.includes(pref.faction) ? pref.faction : (factions.includes('Egypt') ? 'Egypt' : factions[0]);
  const facField = h('div', 'field');
  facField.appendChild(h('span', 'micro', 'Faction'));
  facField.appendChild(factionPicker(game, myFaction, (f) => { myFaction = f; }));
  ident.appendChild(facField);
  wrap.appendChild(ident);

  const err = h('div', 'mp-error hidden');
  err.setAttribute('role', 'alert');
  wrap.appendChild(err);

  const url = el('input', { class: 'input mp-url', type: 'text', spellcheck: 'false', autocomplete: 'off' });
  const defUrl = defaultRelayUrl(game);
  url.value = lsGet(K_MP_RELAY, '') || defUrl;
  url.addEventListener('change', () => {
    const v = url.value.trim();
    lsSet(K_MP_RELAY, v && v !== defUrl ? v : '');
  });

  let busy = false;
  const cards = h('div', 'mp-cards');
  const setBusy = (on, btn) => {
    busy = on;
    cards.classList.toggle('busy', on);
    for (const b of cards.querySelectorAll('button')) b.disabled = on;
    if (btn) btn.classList.toggle('loading', on);
  };
  const run = (promise, btn) => {
    err.classList.add('hidden');
    setBusy(true, btn);
    const used = url.value.trim();
    Promise.resolve(promise).then((r) => {
      setBusy(false, btn);
      if (r && r.ok) { showLobby(game); return; }
      const fe = friendlyNetError(r && r.error, used);
      clear(err);
      err.appendChild(icon('warn'));
      const box = h('div');
      box.appendChild(h('b', null, fe.title));
      box.appendChild(h('span', null, fe.detail));
      err.appendChild(box);
      err.classList.remove('hidden');
      Settings.uiSound(game, 'ui_deny');
    }).catch((e) => {
      setBusy(false, btn);
      clear(err);
      err.appendChild(icon('warn'));
      err.appendChild(el('div', null, [h('b', null, 'Could not connect.'), h('span', null, String(e && e.message || e))]));
      err.classList.remove('hidden');
    });
  };
  const myName = () => {
    const v = name.value.trim() || 'Commander';
    lsSet(K_MP_NAME, v);
    return v;
  };

  // host
  const hostCard = h('section', 'panel chamfer mp-card');
  hostCard.appendChild(el('div', { class: 'mp-card-ico' }, [icon('crown')]));
  hostCard.appendChild(h('h2', null, 'Host a room'));
  hostCard.appendChild(h('p', null, 'Open a lobby, pick the theatre and share a four-letter code with your opponents.'));
  const hostBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', dataset: { sfx: 'confirm', autofocus: '1' } }, ['Create room']);
  hostBtn.addEventListener('click', () => {
    if (busy) return;
    const maps = Object.keys(game.maps);
    run(game.mpHost({
      url: url.value.trim(), name: myName(), faction: myFaction,
      map: pref && game.maps[pref.map] ? pref.map : maps[0],
      seed: (Math.floor(Math.random() * 0x7fffffff) >>> 0) || 1,
    }), hostBtn);
  });
  hostCard.appendChild(hostBtn);
  cards.appendChild(hostCard);

  // join
  const joinCard = h('section', 'panel chamfer mp-card');
  joinCard.appendChild(el('div', { class: 'mp-card-ico' }, [icon('users')]));
  joinCard.appendChild(h('h2', null, 'Join a room'));
  joinCard.appendChild(h('p', null, 'Enter the room code your host shared.'));
  const code = el('input', { class: 'input mp-code', type: 'text', maxlength: '4', spellcheck: 'false', autocomplete: 'off', placeholder: '····', 'aria-label': 'Room code' });
  code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  const joinBtn = el('button', { class: 'btn btn-lg btn-block', type: 'button', dataset: { sfx: 'confirm' } }, ['Join room']);
  const doJoin = () => {
    if (busy) return;
    const c = code.value.trim().toUpperCase();
    if (!c) { code.focus(); Settings.uiSound(game, 'ui_deny'); return; }
    run(game.mpJoin({ url: url.value.trim(), code: c, name: myName(), faction: myFaction }), joinBtn);
  };
  joinBtn.addEventListener('click', doJoin);
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  joinCard.appendChild(code);
  joinCard.appendChild(joinBtn);
  cards.appendChild(joinCard);
  wrap.appendChild(cards);

  // advanced: manual relay address
  const adv = document.createElement('details');
  adv.className = 'mp-adv';
  const sum = document.createElement('summary');
  sum.appendChild(icon('chevR'));
  sum.appendChild(h('span', null, 'Advanced'));
  adv.appendChild(sum);
  const advBody = h('div', 'panel mp-adv-body');
  const urlField = h('label', 'field');
  urlField.appendChild(h('span', 'micro', 'Relay address'));
  urlField.appendChild(url);
  advBody.appendChild(urlField);
  const reset = el('button', { class: 'btn btn-sm', type: 'button' }, ['Use default']);
  reset.addEventListener('click', () => { url.value = defUrl; lsSet(K_MP_RELAY, ''); });
  advBody.appendChild(reset);
  advBody.appendChild(h('p', 'mp-note',
    'Matches run peer-to-peer in lockstep through a lightweight relay. Self-hosting on a LAN? Run '
    + 'tools/mca_relay.py --port 8790 on the host PC and enter ws://<host-ip>:8790 here.'));
  adv.appendChild(advBody);
  if (lsGet(K_MP_RELAY, '')) adv.open = true;
  wrap.appendChild(adv);

  mount(game, 'mp', screen);
}

export function closeLobbyUi(game) {
  runCleanup();
  const root = menuRoot();
  if (root && root.classList) root.classList.add('hidden');
  // drop the lobby DOM: main.js routes chat to #mp-chatlog while it exists,
  // and in a match the lines belong in the HUD's #chatlog
  if (root) clear(root);
  if (document.body && document.body.classList) {
    document.body.classList.remove('in-menu');
    document.body.classList.remove('fe-idle');
  }
  game.overlay = null;
  game.menuBack = null;
}

function pingEl(rtt) {
  const wrap = h('span', 'ping');
  const lvl = rtt === undefined ? 0 : rtt <= 80 ? 4 : rtt <= 150 ? 3 : rtt <= 400 ? 2 : 1;
  wrap.dataset.lvl = String(lvl);
  const bars = h('span', 'ping-bars');
  for (let i = 1; i <= 4; i++) bars.appendChild(h('i', i <= lvl ? 'on' : ''));
  wrap.appendChild(bars);
  wrap.appendChild(h('span', 'ping-ms num', rtt === undefined ? '—' : Math.round(rtt) + ' ms'));
  return wrap;
}

// The host-authoritative lobby. Re-rendered on every onLobby/onCfg/membership
// hook while it is open. Peers edit only their own row (faction/team/ready);
// the host additionally picks map/seed/input-delay and fires START.
export function showLobby(game) {
  const net = game.net;
  if (!net) return;
  // preserve the in-progress chat line + scroll positions across re-renders
  // (the lobby refreshes on every slot update)
  const prevInput = document.getElementById('mp-chatinput');
  const prevVal = prevInput ? prevInput.value : '';
  const hadFocus = !!prevInput && document.activeElement === prevInput;
  const prevCaret = prevInput && hadFocus ? prevInput.selectionStart : null;
  const prevMaps = document.querySelector('#menu .lobby-maps');
  const prevMapScroll = prevMaps ? prevMaps.scrollTop : 0;
  beginScreen();
  game.overlay = 'lobby';
  if (document.body && document.body.classList) document.body.classList.add('in-menu');
  const data = game.data;
  const leave = () => { if (game.mpLeaveLobby) game.mpLeaveLobby(); };
  game.menuBack = leave;

  const screen = h('div', 'fe-screen fe-sub fe-lobby');
  screen.appendChild(subHeader('Lobby', net.isHost ? 'You are hosting' : 'Waiting for the host', leave, 'Leave'));
  const grid = h('div', 'lobby-grid');
  screen.appendChild(grid);

  const slots = net.lobbySlots ? net.lobbySlots() : [];
  const lobby = game.lobby || (net.cfg ? { map: net.cfg.map, seed: net.cfg.seed, delay: net.cfg.delay } : null);
  const maps = Object.keys(game.maps);
  const curMap = lobby && lobby.map && game.maps[lobby.map] ? lobby.map : (net.isHost ? maps[0] : null);
  const md = curMap ? game.maps[curMap] : null;

  // -- left: room code + roster ----------------------------------------------
  const left = h('section', 'panel lobby-col lobby-roster');
  const codeBox = h('div', 'room-code');
  codeBox.appendChild(h('span', 'micro', 'Room code'));
  const codeRow = h('div', 'room-code-row');
  const codeVal = h('span', 'room-code-val', net.code || '····');
  codeRow.appendChild(codeVal);
  const copy = el('button', { class: 'btn btn-sm room-copy', type: 'button', title: 'Copy the room code' }, [icon('copy'), h('span', null, 'Copy')]);
  copy.addEventListener('click', () => {
    const done = (ok) => {
      copy.lastChild.textContent = ok ? 'Copied' : 'Select + copy';
      copy.classList.toggle('active', ok);
      setTimeout(() => { if (copy.isConnected) { copy.lastChild.textContent = 'Copy'; copy.classList.remove('active'); } }, 1600);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(net.code || '')).then(() => done(true), () => done(false));
      } else done(false);
    } catch (e) { done(false); }
  });
  codeRow.appendChild(copy);
  codeBox.appendChild(codeRow);
  codeBox.appendChild(h('span', 'room-code-note', net.isHost
    ? 'Share this code — commanders join from Multiplayer › Join a room.'
    : 'Connected. The host picks the theatre and starts the match.'));
  left.appendChild(codeBox);

  const list = h('div', 'slot-list');
  const maxSlots = md ? md.spawns.length : Math.max(slots.length, 2);
  let allReady = slots.length > 0;
  const pingEls = {};
  for (const s of slots) {
    const isMe = s.slot === net.slot;
    const isHostSlot = s.slot === 0;
    if (!isHostSlot && !s.ready) allReady = false;
    const row = h('div', 'slot-row' + (isMe ? ' me' : '') + (s.ready || isHostSlot ? ' ready' : ''));
    row.style.setProperty('--sc', SLOT_COLORS[s.slot % SLOT_COLORS.length]);
    row.appendChild(h('span', 'slot-color mp-dot'));
    row.appendChild(crest(data, s.faction, 'crest-md'));
    const idc = h('div', 'slot-id');
    const nm = h('div', 'slot-name mp-slot-name', s.name || ('P' + (s.slot + 1)));
    idc.appendChild(nm);
    const tags = h('div', 'slot-tags');
    if (isHostSlot) tags.appendChild(el('span', { class: 'chip chip-gold' }, [icon('crown'), 'Host']));
    if (isMe) tags.appendChild(h('span', 'chip chip-cyan', 'You'));
    idc.appendChild(tags);
    row.appendChild(idc);

    const ctl = h('div', 'slot-ctl');
    if (isMe) {
      ctl.appendChild(factionPicker(game, s.faction, (f) => { if (game.mpSetSlot) game.mpSetSlot({ faction: f }); }));
      const teamSeg = segmented(['0', '1', '2', '3'].map((t) => ({ value: t, label: String(Number(t) + 1), title: 'Team ' + (Number(t) + 1) })),
        String(s.team || 0), (v) => { if (game.mpSetSlot) game.mpSetSlot({ team: Number(v) }); }, 'seg-sm team-seg');
      const tw = h('div', 'slot-team');
      tw.appendChild(h('span', 'micro', 'Team'));
      tw.appendChild(teamSeg);
      ctl.appendChild(tw);
      if (!net.isHost) {
        const rb = el('button', { class: 'btn btn-sm ready-btn' + (s.ready ? ' active' : ''), type: 'button', 'aria-pressed': s.ready ? 'true' : 'false', dataset: { sfx: 'confirm' } },
          [icon(s.ready ? 'check' : 'flag'), h('span', null, s.ready ? 'Ready' : 'Ready up')]);
        rb.addEventListener('click', () => { if (game.mpSetSlot) game.mpSetSlot({ ready: !s.ready }); });
        ctl.appendChild(rb);
      }
    } else {
      ctl.appendChild(h('span', 'slot-faction', s.faction || '?'));
      ctl.appendChild(h('span', 'chip', 'Team ' + ((s.team || 0) + 1)));
      if (!isHostSlot) {
        ctl.appendChild(el('span', { class: 'chip ' + (s.ready ? 'chip-cyan' : 'chip-amber') },
          [icon(s.ready ? 'check' : 'clock'), s.ready ? 'Ready' : 'Not ready']));
      }
    }
    row.appendChild(ctl);
    const peer = net.peers ? net.peers[s.slot] : null;
    const pe = isMe ? h('span', 'ping ping-self', '') : pingEl(peer ? peer.rtt : undefined);
    if (!isMe) pingEls[s.slot] = pe;
    row.appendChild(pe);
    list.appendChild(row);
  }
  for (let i = slots.length; i < maxSlots; i++) {
    const row = h('div', 'slot-row open');
    row.appendChild(h('span', 'slot-color'));
    row.appendChild(el('span', { class: 'slot-open-ico' }, [icon('plus')]));
    row.appendChild(h('div', 'slot-id', 'Open slot'));
    row.appendChild(h('span', 'slot-open-note', 'Waiting for a commander'));
    list.appendChild(row);
  }
  left.appendChild(list);
  grid.appendChild(left);

  // -- right: theatre + match settings + chat ----------------------------------
  const right = h('div', 'lobby-side');
  const mapPanel = h('section', 'panel lobby-col lobby-map');
  const mh = h('div', 'panel-head');
  mh.appendChild(h('span', 'micro', 'Theatre'));
  mapPanel.appendChild(mh);
  const mapBody = h('div', 'lobby-map-body');
  const plate = h('div', 'map-plate brackets');
  const cv = document.createElement('canvas');
  plate.appendChild(cv);
  mapBody.appendChild(plate);
  const info = h('div', 'map-info');
  if (md) {
    info.appendChild(h('h2', 'map-name', md.name || curMap));
    info.appendChild(chipRow(mapChips(md).slice(0, 3)));
  } else {
    info.appendChild(h('h2', 'map-name', 'Awaiting orders'));
    info.appendChild(h('p', 'map-brief', 'Waiting for the host to pick a theatre…'));
  }
  if (net.isHost) {
    const row = h('div', 'lobby-opts');
    const seedF = h('label', 'field');
    seedF.appendChild(h('span', 'micro', 'Seed'));
    const seed = el('input', { class: 'input mp-seed num', type: 'text', inputmode: 'numeric', spellcheck: 'false' });
    seed.value = String(lobby && lobby.seed !== undefined ? lobby.seed : 1);
    seed.addEventListener('change', () => {
      const v = parseInt(seed.value, 10);
      if (game.mpSetLobby && isFinite(v)) game.mpSetLobby({ seed: v >>> 0 });
    });
    seed.addEventListener('keydown', (e) => e.stopPropagation());
    seedF.appendChild(seed);
    row.appendChild(seedF);
    const dF = h('div', 'field');
    dF.appendChild(h('span', 'micro', 'Input delay'));
    dF.appendChild(segmented([{ value: '2', label: 'LAN', title: '2 ticks — same network' }, { value: '4', label: 'Online', title: '4 ticks — internet play' }],
      String(lobby && lobby.delay ? lobby.delay : 2),
      (v) => { if (game.mpSetLobby) game.mpSetLobby({ delay: Number(v) }); }, 'seg-sm'));
    row.appendChild(dF);
    info.appendChild(row);
  } else if (lobby && lobby.map) {
    info.appendChild(h('div', 'mp-note', 'Seed ' + lobby.seed + ' · input delay ' + (lobby.delay || 2)
      + ' ticks — the host starts the match'));
  }
  mapBody.appendChild(info);
  mapPanel.appendChild(mapBody);
  if (net.isHost) {
    const ml = h('div', 'lobby-maps');
    for (const m of maps) {
      const d = game.maps[m];
      const b = el('button', { class: 'map-row' + (curMap === m ? ' sel' : ''), type: 'button' }, [
        h('span', 'map-row-name', d.name || m),
        el('span', { class: 'map-row-meta num' }, [icon('users'), String(d.spawns.length)]),
      ]);
      b.addEventListener('click', () => { if (game.mpSetLobby) game.mpSetLobby({ map: m }); });
      ml.appendChild(b);
    }
    rovingFocus(ml, '.map-row', 0);
    mapPanel.appendChild(ml);
  }
  right.appendChild(mapPanel);

  // chat
  const chat = h('section', 'panel lobby-col lobby-chat');
  const ch = h('div', 'panel-head');
  ch.appendChild(h('span', 'micro', 'Comms'));
  chat.appendChild(ch);
  const logEl = h('div', 'mp-chatlog');
  logEl.id = 'mp-chatlog';
  for (const line of game.mpChatLog || []) logEl.appendChild(h('div', 'mp-chatline', line.name + ': ' + line.text));
  if (!(game.mpChatLog || []).length) logEl.appendChild(h('div', 'mp-chat-empty', 'No messages yet. Say hello.'));
  chat.appendChild(logEl);
  const chatRow = h('div', 'chat-row');
  const chatInput = el('input', { class: 'input mp-chatinput', id: 'mp-chatinput', type: 'text', maxlength: '140', placeholder: 'Message the room', autocomplete: 'off' });
  if (prevVal) chatInput.value = prevVal;
  const sendChat = () => {
    const v = chatInput.value.trim();
    if (v && game.mpSendChat) game.mpSendChat(v);
    chatInput.value = '';
    const empty = logEl.querySelector('.mp-chat-empty');
    if (empty) empty.remove();
    if (v) {
      // the relay does not echo to the sender: show our own line locally
      if (!game.mpChatLog) game.mpChatLog = [];
      game.mpChatLog.push({ name: net.name || 'You', text: v });
      if (game.mpChatLog.length > 50) game.mpChatLog.shift();
      logEl.appendChild(h('div', 'mp-chatline mine', (net.name || 'You') + ': ' + v));
      logEl.scrollTop = logEl.scrollHeight;
    }
  };
  chatInput.addEventListener('keydown', (e) => {
    if (e && e.key === 'Enter') sendChat();
    if (e && e.key !== 'Escape' && e.stopPropagation) e.stopPropagation();
  });
  const chatBtn = el('button', { class: 'btn btn-icon', type: 'button', title: 'Send', 'aria-label': 'Send message' }, [icon('send')]);
  chatBtn.addEventListener('click', sendChat);
  chatRow.appendChild(chatInput);
  chatRow.appendChild(chatBtn);
  chat.appendChild(chatRow);
  right.appendChild(chat);
  grid.appendChild(right);

  // -- footer: start ------------------------------------------------------------
  const foot = h('footer', 'lobby-foot');
  if (net.isHost) {
    // everyone on one team would end the match on its first tick
    const opposed = new Set(slots.map((s) => s.team || 0)).size >= 2;
    const can = allReady && slots.length >= 2 && opposed;
    foot.appendChild(el('span', { class: 'lobby-status' + (can ? ' ok' : '') }, [icon(can ? 'check' : 'clock'),
      slots.length < 2 ? 'Waiting for at least one more commander'
        : !opposed ? 'Every commander is on the same team — pick opposing teams'
          : !allReady ? 'Waiting for every commander to ready up' : 'All commanders ready']));
    const start = el('button', { class: 'btn btn-primary btn-lg', type: 'button', dataset: { sfx: 'confirm' } }, [h('span', null, 'Start match'), icon('chevR')]);
    start.disabled = !can;
    start.addEventListener('click', () => { if (game.mpStart) game.mpStart(); });
    foot.appendChild(start);
  } else {
    const me = slots.find((s) => s.slot === net.slot);
    foot.appendChild(el('span', { class: 'lobby-status' + (me && me.ready ? ' ok' : '') }, [icon(me && me.ready ? 'check' : 'info'),
      me && me.ready ? 'You are ready — waiting for the host to start' : 'Pick a faction and team, then ready up']));
  }
  screen.appendChild(foot);

  mount(game, 'lobby', screen);
  drawMapPreview(cv, md, { roles: md ? md.spawns.map((_, i) => (i < slots.length ? (slots[i].slot === net.slot ? 'you' : 'enemy') : 'open')) : [] });
  logEl.scrollTop = logEl.scrollHeight;
  const newMaps = screen.querySelector('.lobby-maps');
  if (newMaps) newMaps.scrollTop = prevMapScroll;
  if (hadFocus) {
    try {
      chatInput.focus({ preventScroll: true });
      if (prevCaret !== null) chatInput.setSelectionRange(prevCaret, prevCaret);
    } catch (e) { /* no-op */ }
  }

  // first time in this room: seat each commander on their own team (the wire
  // default puts everyone on team 0, which is an instant shared victory)
  const seatKey = (net.code || '') + ':' + net.slot;
  if (game._mpSeatKey !== seatKey && net.slot >= 0 && game.mpSetSlot) {
    game._mpSeatKey = seatKey;
    const want = net.slot % 4;
    const mine = slots.find((s) => s.slot === net.slot);
    if (mine && (mine.team || 0) !== want) {
      setTimeout(() => { if (game.overlay === 'lobby' && game.net && game.net.active) game.mpSetSlot({ team: want }); }, 0);
    }
  }

  // live ping refresh without re-rendering the lobby
  const pt = setInterval(() => {
    for (const sl in pingEls) {
      const p = net.peers ? net.peers[sl] : null;
      const fresh = pingEl(p ? p.rtt : undefined);
      pingEls[sl].replaceWith(fresh);
      pingEls[sl] = fresh;
    }
  }, 1000);
  onCleanup(() => clearInterval(pt));

  // host: make sure guests always hold the current map/seed/delay — a guest
  // who joined after the last change would otherwise see no theatre at all
  if (net.isHost && game.mpSetLobby) {
    const key = slots.map((s) => s.slot).join(',') + '|' + (lobby && lobby.map ? 1 : 0);
    if (game._lobbySyncKey !== key) {
      game._lobbySyncKey = key;
      const patch = lobby && lobby.map && game.maps[lobby.map] ? {} : { map: maps[0] };
      setTimeout(() => {
        if (game.overlay === 'lobby' && game.net && game.net.isHost) game.mpSetLobby(patch);
      }, 0);
    }
  }
}

// ---- desync halt ----------------------------------------------------------------------

// v0.10.0 desync halt: freeze frame, name both checksums, offer the way out.
export function showDesyncOverlay(game, opts) {
  const banner = document.getElementById('banner');
  if (!banner) { if (opts && opts.onMenu) opts.onMenu(); return; }
  watchBanner(banner);
  banner.classList.remove('hidden');
  banner.className = 'lost desync';
  clear(banner);
  const info = game.mpDesync;
  const box = h('div', 'modal panel chamfer desync-box');
  box.appendChild(el('div', { class: 'modal-kicker danger' }, [icon('warn'), 'Synchronisation lost']));
  box.appendChild(h('h1', null, 'Desync detected'));
  box.appendChild(h('p', null, 'The match was halted because the simulations diverged'
    + (info ? ' at tick ' + info.tick : '') + '. Nothing you did caused this.'));
  if (info) {
    const hex = (v) => '0x' + ((v >>> 0).toString(16)).padStart(8, '0');
    const dl = h('div', 'desync-sums');
    dl.appendChild(el('div', null, [h('span', 'micro', 'Your checksum'), h('code', null, hex(info.mine))]));
    dl.appendChild(el('div', null, [h('span', 'micro', 'Slot ' + info.slot + ' checksum'), h('code', null, hex(info.theirs))]));
    box.appendChild(dl);
  }
  box.appendChild(h('p', 'modal-note', 'Both checksums are also in the browser console (F12) for a bug report.'));
  const menu = el('button', { class: 'btn btn-primary btn-lg', type: 'button', dataset: { autofocus: '1' } }, ['Return to menu']);
  menu.addEventListener('click', () => {
    banner.classList.add('hidden');
    if (opts && opts.onMenu) opts.onMenu();
  });
  box.appendChild(menu);
  banner.appendChild(box);
  try { menu.focus({ preventScroll: true }); } catch (e) { /* no-op */ }
}

// ---- mission briefing --------------------------------------------------------------------

// Briefing plate shown by startMatch before the sim starts ticking
// (game.briefing gates simStep in main.js). Dismisses on any click/keydown
// (Esc included, swallowed so it can't reach the pause path) or at the
// deadline checked by the frame loop. With an art pack the faction poster
// leads the plate; without one the crest dossier stands on its own.
const BRIEF_MS = 4200;
export function showBriefing(game, faction) {
  const root = document.getElementById('briefing');
  if (!root || !root.classList) return false;
  const data = game.data;
  if (!data || !data.factions || !data.factions[faction]) return false;
  const uri = game.briefings && game.briefings[faction];
  const lore = factionLore(faction);
  const st = game.state;
  const map = st && st.map ? st.map : (game.lastCfg ? game.maps[game.lastCfg.map] : null);
  clear(root);
  root.classList.remove('hidden');
  document.body.classList.add('briefing-on'); // HUD waits behind the plate
  const box = h('div', 'brief-box panel chamfer');
  box.style.setProperty('--fc', legible(data.factions[faction].color));
  if (uri) {
    const img = document.createElement('img');
    img.src = uri;
    img.className = 'brief-poster';
    img.alt = faction + ' briefing';
    box.appendChild(img);
  }
  const body = h('div', 'brief-body');
  const left = h('div', 'brief-main');
  left.appendChild(el('div', { class: 'modal-kicker' }, [icon('flag'), 'Operation briefing']));
  const idRow = h('div', 'brief-id');
  idRow.appendChild(crest(data, faction, 'crest-xl'));
  const idt = h('div');
  idt.appendChild(h('h1', null, faction));
  idt.appendChild(h('div', 'brief-doctrine', data.factions[faction].identity || lore.doctrine));
  idRow.appendChild(idt);
  left.appendChild(idRow);
  if (lore.blurb) left.appendChild(h('p', 'brief-blurb', lore.blurb));
  const obj = h('ul', 'brief-objectives');
  for (const [k, t] of [['D', 'Deploy your MCV into a Construction Yard'], ['$', 'Claim oil fields — depots fund everything'],
    ['×', 'Destroy every enemy Construction Yard']]) {
    obj.appendChild(el('li', null, [h('span', 'kbd', k), h('span', null, t)]));
  }
  left.appendChild(obj);
  body.appendChild(left);

  const right = h('div', 'brief-side');
  const plate = h('div', 'map-plate brackets');
  const cv = document.createElement('canvas');
  plate.appendChild(cv);
  right.appendChild(plate);
  right.appendChild(h('div', 'brief-map', map && map.name ? map.name : ''));
  if (st && st.players) {
    const me = st.players[game.playerSlot];
    const foes = h('div', 'brief-foes');
    for (const p of st.players) {
      if (!me || p.slot === me.slot) continue;
      const hostile = p.team !== me.team;
      foes.appendChild(el('span', { class: 'brief-foe ' + (hostile ? 'hostile' : 'allied'), title: p.faction }, [
        crest(data, p.faction, 'crest-sm'), h('span', null, p.faction),
        h('span', 'chip ' + (hostile ? 'chip-red' : 'chip-blue'), hostile ? 'Hostile' : 'Ally'),
      ]));
    }
    right.appendChild(foes);
  }
  body.appendChild(right);
  box.appendChild(body);

  const foot = h('div', 'brief-foot');
  foot.appendChild(h('div', 'brief-hint', 'Press any key or click to deploy'));
  const deploy = el('button', { class: 'btn btn-primary btn-lg brief-deploy', type: 'button' }, [h('span', null, 'Deploy'), icon('chevR')]);
  foot.appendChild(deploy);
  box.appendChild(foot);
  const timer = h('div', 'brief-timer');
  const tfill = h('span');
  tfill.style.animationDuration = BRIEF_MS + 'ms';
  timer.appendChild(tfill);
  box.appendChild(timer);
  root.appendChild(box);

  if (map) {
    const roles = [];
    if (st && st.players) {
      const me = st.players[game.playerSlot];
      const n = map.spawns.length;
      for (const p of st.players) {
        roles[p.slot % n] = me && p.slot === me.slot ? 'you' : me && p.team === me.team ? 'ally' : 'enemy';
      }
      for (let i = 0; i < n; i++) if (!roles[i]) roles[i] = 'open';
    }
    drawMapPreview(cv, map, { roles });
  }

  const dismiss = () => {
    if (!game.briefing) return;
    game.briefing = null;
    root.classList.add('hidden');
    document.body.classList.remove('briefing-on');
    clear(root);
    if (document.removeEventListener) document.removeEventListener('keydown', onKey);
    // v0.9.1: the root click listener outlived the overlay (one permanent
    // closure per match) — remove it with the keydown one
    if (root.removeEventListener) root.removeEventListener('click', dismiss);
  };
  const onKey = (e) => {
    if (!game.briefing) return;
    if (e && e.preventDefault) e.preventDefault();
    // stop the keypress here (document bubble fires before input.js's window
    // listener) so e.g. Esc dismisses without also opening the pause menu
    if (e && e.stopImmediatePropagation) e.stopImmediatePropagation();
    dismiss();
  };
  root.addEventListener('click', dismiss);
  deploy.addEventListener('click', dismiss);
  if (document.addEventListener) document.addEventListener('keydown', onKey);
  const now = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : 0;
  game.briefing = { deadline: now + BRIEF_MS, dismiss };
  return true;
}

// ---- pause menu -------------------------------------------------------------------------

// pause overlay during a live match (top-bar Menu button): Resume / Restart /
// Settings / Abandon (two-step confirm). v0.10.0: in an MP match Restart is
// hidden — a shared lockstep match cannot be restarted locally — and Abandon
// also leaves the room.
export function showPauseMenu(game, opts) {
  beginScreen();
  __lastPauseOpts = opts;
  game.overlay = 'pause';
  if (document.body && document.body.classList) document.body.classList.add('in-menu');
  const root = menuRoot();
  const screen = h('div', 'fe-screen fe-modal fe-pause');
  const box = h('div', 'modal panel chamfer pause-box');
  const st = game.state;
  const me = st ? st.players[game.playerSlot] : null;
  const top = h('div', 'pause-top');
  if (me) top.appendChild(crest(game.data, me.faction, 'crest-md'));
  const tt = h('div');
  tt.appendChild(el('div', { class: 'modal-kicker' }, [icon('pause'), game.mpPauseName ? 'Paused by ' + game.mpPauseName : 'Mission paused']));
  tt.appendChild(h('h1', null, 'Paused'));
  top.appendChild(tt);
  if (st) {
    const ck = h('div', 'pause-clock');
    ck.appendChild(h('span', 'micro', 'Mission time'));
    ck.appendChild(h('span', 'num', fmtClock(st.tick)));
    top.appendChild(ck);
  }
  box.appendChild(top);

  const col = h('div', 'modal-actions');
  const doResume = () => {
    runCleanup();
    root.classList.add('hidden');
    if (document.body && document.body.classList) document.body.classList.remove('in-menu');
    game.resumePause = null;
    opts.onResume();
  };
  const resume = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', dataset: { sfx: 'confirm', autofocus: '1' } },
    [icon('play'), h('span', null, 'Resume'), h('span', 'kbd', 'Esc')]);
  resume.addEventListener('click', doResume);
  game.resumePause = doResume; // Esc == Resume while this overlay is up
  col.appendChild(resume);
  if (!(game.net && game.net.active)) {
    const restart = el('button', { class: 'btn btn-block', type: 'button' }, [icon('restart'), h('span', null, 'Restart mission')]);
    restart.addEventListener('click', () => {
      runCleanup();
      root.classList.add('hidden');
      opts.onRestart();
    });
    col.appendChild(restart);
  }
  const settings = el('button', { class: 'btn btn-block', type: 'button' }, [icon('sliders'), h('span', null, 'Settings')]);
  settings.addEventListener('click', () => showSettings(game, { from: 'pause' }));
  col.appendChild(settings);
  const controls = el('button', { class: 'btn btn-block', type: 'button' }, [icon('keyboard'), h('span', null, 'Controls')]);
  controls.addEventListener('click', () => showSettings(game, { from: 'pause', tab: 'controls' }));
  col.appendChild(controls);
  const abandon = el('button', { class: 'btn btn-block btn-danger', type: 'button', dataset: { sfx: 'back' } },
    [icon('exit'), h('span', null, game.net && game.net.active ? 'Leave match' : 'Abandon match')]);
  let armed = false;
  let disarm = 0;
  abandon.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      abandon.querySelector('span').textContent = 'Really abandon? Click again';
      abandon.classList.add('armed', 'sel');
      disarm = setTimeout(() => {
        armed = false;
        if (!abandon.isConnected) return;
        abandon.classList.remove('armed', 'sel');
        abandon.querySelector('span').textContent = game.net && game.net.active ? 'Leave match' : 'Abandon match';
      }, 4000);
      return;
    }
    clearTimeout(disarm);
    runCleanup();
    root.classList.add('hidden');
    opts.onAbandon();
  });
  col.appendChild(abandon);
  rovingFocus(col, '.btn', 0);
  box.appendChild(col);
  screen.appendChild(box);
  mount(game, 'pause', screen);
}

// ---- end of match -------------------------------------------------------------------------

function playerLabel(game, p) {
  const net = game.net;
  if (net && net.active && !p.ai) {
    if (p.slot === game.playerSlot) return net.name || 'You';
    const peer = net.peers ? net.peers[p.slot] : null;
    if (peer && peer.name) return peer.name;
  }
  return p.slot === game.playerSlot ? 'You' : p.ai ? 'AI Commander' : 'Commander ' + (p.slot + 1);
}

// main.js / input.js close #banner by adding .hidden: mirror that onto a body
// class so the HUD can step aside while a debrief or halt plate is up
function watchBanner(banner) {
  if (banner.__watched || typeof MutationObserver !== 'function') return;
  banner.__watched = true;
  const sync = () => document.body.classList.toggle('end-on', !banner.classList.contains('hidden'));
  new MutationObserver(sync).observe(banner, { attributes: true, attributeFilter: ['class'] });
  sync();
}

export function showEndBanner(game, opts) {
  const banner = document.getElementById('banner');
  watchBanner(banner);
  banner.classList.remove('hidden');
  banner.className = opts.won ? 'won' : 'lost';
  clear(banner);
  const st = game.state;
  const data = game.data;
  const me = st ? st.players[game.playerSlot] : null;
  const box = h('div', 'end-box');

  const hero = h('div', 'end-hero');
  if (me) hero.appendChild(crest(data, me.faction, 'crest-xl'));
  const ht = h('div', 'end-title');
  ht.appendChild(h('div', 'end-kicker', opts.won ? 'Mission accomplished' : 'Mission failed'));
  ht.appendChild(h('h1', null, opts.won ? 'VICTORY' : 'DEFEAT'));
  if (st) {
    const mapName = (st.map && st.map.name) || (game.lastCfg && game.maps[game.lastCfg.map] && game.maps[game.lastCfg.map].name) || '';
    const sub = h('div', 'end-sub');
    if (me) sub.appendChild(h('span', null, me.faction));
    if (mapName) sub.appendChild(h('span', null, mapName));
    // v0.3.6 score screen: per-player kills/losses/credits + match time
    sub.appendChild(el('span', { class: 'num' }, [icon('clock'), 'Match time ' + fmtClock(st.tick)]));
    ht.appendChild(sub);
  }
  hero.appendChild(ht);
  box.appendChild(hero);

  if (st) {
    // v0.4.3: split losses into units vs structures when the sim tracks them.
    // Defensive: the fields may live flat on the player (like unitsKilled) or
    // under p.stats; older builds without them keep the single Lost column.
    const stat = (p, k) => {
      if (p[k] !== undefined) return p[k];
      if (p.stats && p.stats[k] !== undefined) return p.stats[k];
      return undefined;
    };
    const splitLoss = st.players.some((p) => stat(p, 'structsLost') !== undefined);
    const hasRazed = st.players.some((p) => stat(p, 'structsKilled') !== undefined);

    if (me) {
      const tiles = h('div', 'end-tiles');
      const tile = (label, value, ico) => {
        const t = h('div', 'end-tile panel');
        t.appendChild(icon(ico));
        t.appendChild(h('span', 'end-tile-val num', fmtInt(value)));
        t.appendChild(h('span', 'micro', label));
        tiles.appendChild(t);
      };
      tile('Units destroyed', stat(me, 'unitsKilled') | 0, 'target');
      if (hasRazed) tile('Structures razed', stat(me, 'structsKilled') | 0, 'structures');
      tile('Units lost', stat(me, 'unitsLost') | 0, 'warn');
      if (splitLoss) tile('Structures lost', stat(me, 'structsLost') | 0, 'shield');
      tile('Credits earned', stat(me, 'creditsEarned') | 0, 'credit');
      tile('Credits spent', stat(me, 'creditsSpent') | 0, 'cube');
      box.appendChild(tiles);
    }

    const cols = [{ k: 'unitsKilled', label: 'Killed' }];
    if (hasRazed) cols.push({ k: 'structsKilled', label: 'Razed' });
    cols.push({ k: 'unitsLost', label: splitLoss ? 'Units lost' : 'Lost' });
    if (splitLoss) cols.push({ k: 'structsLost', label: 'Structs lost' });
    cols.push({ k: 'creditsEarned', label: 'Earned' }, { k: 'creditsSpent', label: 'Spent' });
    const maxOf = {};
    for (const c of cols) maxOf[c.k] = Math.max(1, ...st.players.map((p) => stat(p, c.k) | 0));

    const tbl = h('div', 'score-table panel');
    tbl.style.setProperty('--cols', String(cols.length));
    const head = h('div', 'score-row score-head');
    head.appendChild(h('span', null, 'Commander'));
    for (const c of cols) head.appendChild(h('span', null, c.label));
    tbl.appendChild(head);
    const order = st.players.slice().sort((a, b) => (a.team - b.team) || (a.slot - b.slot));
    for (const p of order) {
      const mine = me && p.slot === me.slot;
      const friend = me && p.team === me.team;
      const row = h('div', 'score-row' + (p.eliminated ? ' out' : '') + (mine ? ' mine' : '') + (friend ? ' friend' : ' foe'));
      const who = h('span', 'score-who');
      who.appendChild(crest(data, p.faction, 'crest-sm'));
      const wt = h('span', 'score-who-text');
      wt.appendChild(h('b', null, p.faction + (p.ai ? ' (AI)' : '')));
      wt.appendChild(h('i', null, playerLabel(game, p) + ' · Team ' + (p.team + 1) + (p.eliminated ? ' — out' : '')));
      who.appendChild(wt);
      if (st.over && st.winner === p.team && !p.eliminated) who.appendChild(el('span', { class: 'chip chip-gold' }, [icon('star'), 'Winner']));
      else if (p.eliminated) who.appendChild(h('span', 'chip chip-red', 'Eliminated'));
      row.appendChild(who);
      for (const c of cols) {
        const v = stat(p, c.k) | 0;
        const cell = h('span', 'score-cell num');
        cell.appendChild(document.createTextNode(fmtInt(v)));
        const bar = h('i');
        bar.style.width = Math.round(100 * v / maxOf[c.k]) + '%';
        cell.appendChild(bar);
        row.appendChild(cell);
      }
      tbl.appendChild(row);
    }
    box.appendChild(tbl);
  }

  const row = h('div', 'end-actions menu-row');
  const mp = !!(game.net && game.net.active);
  const again = el('button', { class: 'btn btn-primary btn-lg', type: 'button', dataset: { sfx: 'confirm' } },
    [icon(mp ? 'back' : 'restart'), h('span', null, mp ? 'Leave match' : 'Rematch')]);
  again.addEventListener('click', () => {
    banner.classList.add('hidden');
    opts.onRestart();
  });
  const menu = el('button', { class: 'btn btn-lg', type: 'button', dataset: { sfx: 'back' } }, [h('span', null, 'Main menu'), h('span', 'kbd', 'Esc')]);
  menu.addEventListener('click', () => {
    banner.classList.add('hidden');
    opts.onMenu();
  });
  row.appendChild(again);
  if (!mp) row.appendChild(menu);
  box.appendChild(row);
  banner.appendChild(box);
  try { again.focus({ preventScroll: true }); } catch (e) { /* no-op */ }
}
