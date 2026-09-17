// Main menu, match setup, and end-of-match banner. Pure DOM overlay;
// calls back into main.js via the supplied callbacks.
import { getSfxVolume, setSfxVolume, playClick, tutorialSeen } from './hud.js';
// v0.5.1: 'Auto' (adaptive doctrine) is the default personality; the other
// four pin a fixed doctrine. Values are the internal ids (saved in cfg).
const PERSONALITIES = ['Auto', 'Front', 'Sky', 'Raid', 'Fortress'];
// display labels (v0.5.1): internal ids stay in cfg; hover shows the id
const PERSONALITY_LABEL = {
  Auto: 'Auto (adaptive)', Front: 'Balanced Assault', Sky: 'Air Superiority',
  Raid: 'Hit & Run', Fortress: 'Fortress Defense',
};
const DIFFICULTIES = ['recruit', 'veteran', 'elite', 'marshal'];
// v0.3.6: genre-familiar labels over the existing tiers (values unchanged)
const DIFFICULTY_LABEL = { recruit: 'Easy', veteran: 'Normal', elite: 'Hard', marshal: 'Expert' };
// (smoke harness inlines all modules into one scope: no const shared with hud.js)
const MENU_PASSIVE_ABILITIES = ['edge_network', 'integrated_sky', 'siha_mesh', 'iron_layer'];
// active abilities gated behind a standing structure (mirrors sim ABILITY_STRUCT)
const ABILITY_GATE_TEXT = {
  saka_insertion: 'needs Sa\'ka Tent',
  shahed_rain: 'needs Drone Workshop',
  brahmos_lane: 'needs Cruise Battery',
  rsaf_tasking: 'needs Green Crescent',
  babur_window: 'needs Ghaznavi Rain',
};

// v0.4.4 artwork (Kimi keyart/poster pack, inlined by the single-file build
// as __INLINE_ART -> game.art; absent in dev/test — everything no-ops then).
// The build guard forbids the CSS url-function literal in sources; assemble it.
function bgUrl(uri) { return 'u' + 'rl(' + uri + ')'; }

function applyArtBg(game, el, key) {
  const uri = game.art && game.art[key];
  if (!uri || !el || !el.style) return;
  el.style.backgroundImage =
    'linear-gradient(rgba(8,10,13,0.62), rgba(8,10,13,0.78)), ' + bgUrl(uri);
  el.style.backgroundSize = 'cover';
  el.style.backgroundPosition = 'center';
}

// v0.9.0: the strip cards are the ORIGINAL portrait posters (art.factions)
// again — the landscape briefing plate is reserved for the match-briefing
// overlay (showBriefing). No pack / no poster for the faction -> no image.
function factionCardPoster(game, fname) {
  const arts = game.art && game.art.factions;
  const uri = arts && arts[fname];
  if (!uri) return null;
  const img = document.createElement('img');
  img.src = uri;
  img.className = 'fac-poster';
  img.alt = fname;
  img.draggable = false; // native img-drag would fight pointer drag-scroll
  return img;
}

// one-liner under a faction button: econ perk + ability
function perkLine(f) {
  const parts = [];
  const pk = f.econPerk;
  if (pk) {
    const pct = Math.round(Math.abs(pk.value) * 100);
    switch (pk.type) {
      case 'cheap_cy_rebuild': parts.push('−' + pct + '% CY rebuild'); break;
      case 'oil_income_mult': parts.push('+' + Math.round((pk.value - 1) * 100) + '% oil'); break;
      case 'early_build_speed':
        parts.push('+' + pct + '% build speed first ' + Math.round(pk.until_s / 60) + 'min');
        break;
      case 'war_factory_discount': parts.push('−' + pct + '% vehicle cost'); break;
      case 'unit_build_speed': parts.push('+' + pct + '% ' + pk.unit_name + ' build'); break;
      default: parts.push(pk.type.replace(/_/g, ' '));
    }
  }
  if (f.ability) {
    const ab = f.ability.replace(/_/g, ' ');
    parts.push(MENU_PASSIVE_ABILITIES.includes(f.ability) ? ab + ' (passive)'
      : ABILITY_GATE_TEXT[f.ability] ? ab + ' (' + ABILITY_GATE_TEXT[f.ability] + ')' : ab);
  }
  return parts.join(' · ');
}

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function selectEl(options, value, labels) {
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = labels && labels[o] ? labels[o] + ' (' + o + ')' : o;
    if (o === value) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

export function showMenu(game, onStart) {
  game.overlay = 'menu';
  game.resumePause = null;
  game.menuBack = null;
  if (document.body && document.body.classList) document.body.classList.add('in-menu');
  // hide any lingering in-match floaters
  const tt = document.getElementById('tooltip');
  if (tt) tt.style.display = 'none';
  const cl = document.getElementById('cursor-label');
  if (cl && cl.classList) cl.classList.remove('flash');
  const root = document.getElementById('menu');
  root.classList.remove('hidden');
  root.innerHTML = '';
  applyArtBg(game, root, 'keyart');
  const box = h('div', 'menu-box');
  box.appendChild(h('h1', null, 'MCA — Middle East Combat Arena'));
  box.appendChild(h('p', null, 'Offline greybox skirmish RTS'));
  const start = h('button', 'menu-btn', 'Skirmish');
  start.addEventListener('click', () => showSetup(game, root, onStart, false));
  box.appendChild(start);
  // v0.10.0: LAN/online multiplayer (lockstep over a dumb relay)
  const mp = h('button', 'menu-btn', 'Multiplayer');
  mp.addEventListener('click', () => { if (game.openMpSetup) game.openMpSetup(); });
  box.appendChild(mp);
  // v0.4.4: guided tutorial match (same sandbox, EVA step overlay on top)
  const tut = h('button', 'menu-btn', 'Tutorial');
  tut.addEventListener('click', () => showSetup(game, root, onStart, true));
  box.appendChild(tut);
  // master volume (v0.3.6; persisted in localStorage via hud.js, guarded)
  const volRow = h('div', 'menu-row');
  volRow.appendChild(h('span', null, 'Volume'));
  const vol = document.createElement('input');
  vol.type = 'range';
  vol.min = '0'; vol.max = '100';
  vol.value = String(Math.round(getSfxVolume() * 100));
  vol.addEventListener('change', () => {
    setSfxVolume(Number(vol.value) / 100);
    playClick(); // preview
  });
  volRow.appendChild(vol);
  box.appendChild(volRow);
  root.appendChild(box);
  const banner = document.getElementById('banner');
  banner.classList.add('hidden');
}

function showSetup(game, root, onStart, tutorialPath) {
  game.overlay = 'setup';
  root.innerHTML = '';
  applyArtBg(game, root, 'setup');
  const box = h('div', 'menu-box');
  box.appendChild(h('h1', null, 'Skirmish setup'));

  const cfg = {
    map: Object.keys(game.maps)[0],
    faction: 'Egypt',
    opponents: [{ faction: 'Algeria', personality: 'Auto', difficulty: 'recruit' }],
    ally: null,
    tutorial: false,
  };

  // map (v0.7.2: 220x180 thumbnails from the art pack — game.thumbArt; an
  // empty pack keeps the old text-only buttons. Scenario maps carry a
  // `briefing` string: small italic line + full text on hover)
  box.appendChild(h('h2', null, 'Map'));
  const mapRow = h('div', 'menu-row map-row');
  const mapBtns = {};
  const thumbs = game.thumbArt || {};
  for (const m of Object.keys(game.maps)) {
    const md = game.maps[m];
    const desc = (md.name || m) + ' — ' + md.w + '×' + md.h
      + ', up to ' + md.spawns.length + ' players';
    const b = h('button', 'menu-btn' + (cfg.map === m ? ' sel' : ''), desc);
    if (thumbs[m]) {
      const img = document.createElement('img');
      img.src = thumbs[m];
      img.className = 'map-thumb';
      img.alt = md.name || m;
      if (b.firstChild) b.insertBefore(img, b.firstChild);
      else b.appendChild(img);
    }
    if (md.briefing) {
      b.title = md.briefing;
      b.appendChild(h('span', 'map-brief', md.briefing));
    }
    b.addEventListener('click', () => {
      cfg.map = m;
      for (const k in mapBtns) mapBtns[k].classList.toggle('sel', k === m);
      refreshOpponents();
    });
    mapBtns[m] = b;
    mapRow.appendChild(b);
  }
  box.appendChild(mapRow);

  // your faction (v0.5.1): horizontal scroll-snap strip so the whole setup
  // fits one screen — ‹ › arrows scroll a page, the wheel scrolls sideways,
  // touch scrolls natively; arrows disable at the scroll ends
  box.appendChild(h('h2', null, 'Your faction'));
  const facWrap = h('div', 'fac-strip-wrap');
  const facPrev = h('button', 'fac-arrow', '‹');
  const facStrip = h('div', 'fac-strip');
  const facNext = h('button', 'fac-arrow', '›');
  facPrev.type = 'button'; facNext.type = 'button';
  const facBtns = {};
  for (const fname of Object.keys(game.data.factions)) {
    const f = game.data.factions[fname];
    const b = h('button', 'menu-btn fac-card' + (cfg.faction === fname ? ' sel' : ''));
    const poster = factionCardPoster(game, fname);
    if (poster) b.appendChild(poster);
    const sw = h('span', 'sw');
    sw.style.background = f.color;
    b.appendChild(sw);
    b.appendChild(document.createTextNode(fname));
    b.appendChild(h('span', 'ident', f.identity || ''));
    const pl = perkLine(f);
    if (pl) b.appendChild(h('span', 'perk', pl));
    b.addEventListener('click', () => {
      cfg.faction = fname;
      for (const k in facBtns) facBtns[k].classList.toggle('sel', k === fname);
    });
    facBtns[fname] = b;
    facStrip.appendChild(b);
  }
  const facPage = () => facStrip.clientWidth || 490;
  const scrollStrip = (dir) => {
    if (typeof facStrip.scrollBy === 'function') {
      facStrip.scrollBy({ left: dir * facPage(), behavior: 'smooth' });
    } else {
      facStrip.scrollLeft = (facStrip.scrollLeft || 0) + dir * facPage();
    }
  };
  facPrev.addEventListener('click', () => scrollStrip(-1));
  facNext.addEventListener('click', () => scrollStrip(1));
  const syncArrows = () => {
    const sl = facStrip.scrollLeft || 0;
    const max = (facStrip.scrollWidth || 0) - (facStrip.clientWidth || 0);
    facPrev.disabled = sl <= 0;
    facNext.disabled = max <= 0 || sl >= max - 1;
  };
  facStrip.addEventListener('scroll', syncArrows);
  facStrip.addEventListener('wheel', (e) => {
    if (e.preventDefault) e.preventDefault();
    facStrip.scrollLeft = (facStrip.scrollLeft || 0) + (e.deltaY || 0);
    syncArrows();
  }, { passive: false });
  // v0.9.0 smooth card scrolling: pointer drag-to-scroll with momentum. The
  // scroll velocity is sampled on pointermove; on release the strip keeps
  // gliding with exponential decay until it settles or hits an end. Snap and
  // smooth-behavior are suspended for the drag AND the glide (direct
  // scrollLeft writes must answer immediately), and a real drag swallows the
  // trailing click so the card under the pointer doesn't select on release.
  const menuNow = () => (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : 0;
  let facDrag = null;
  let facGlide = null;
  const applyStripScroll = (delta) => {
    const before = facStrip.scrollLeft || 0;
    facStrip.scrollLeft = before + delta;
    return (facStrip.scrollLeft || 0) !== before;
  };
  const glideTick = () => {
    const gl = facGlide;
    if (!gl) return;
    const now = menuNow();
    const dt = Math.min(64, Math.max(1, now - gl.t));
    gl.t = now;
    gl.v *= Math.exp(-dt / 180); // ~180ms time constant
    const step = gl.v * dt / 1000;
    if (Math.abs(gl.v) < 10 || Math.abs(step) < 0.5 || !applyStripScroll(step)) {
      facGlide = null;
      facStrip.classList.remove('dragging');
      return;
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(glideTick);
    else { facGlide = null; facStrip.classList.remove('dragging'); }
  };
  const onStripMove = (e) => {
    if (!facDrag || !e) return;
    const x = typeof e.clientX === 'number' ? e.clientX : facDrag.x;
    const now = menuNow();
    const dt = now - facDrag.t;
    if (dt > 0) {
      // scroll velocity (px/ms): pulling left (+scroll) drags clientX down
      const v = -(x - facDrag.x) / dt;
      facDrag.v = facDrag.v * 0.5 + v * 0.5;
    }
    facDrag.x = x;
    facDrag.t = now;
    const dx = x - facDrag.x0;
    if (Math.abs(dx) > 4) facDrag.moved = true;
    facStrip.scrollLeft = facDrag.sl0 - dx;
    if (facDrag.moved && e.preventDefault) e.preventDefault();
  };
  const onStripUp = (e) => {
    if (!facDrag) return;
    const d = facDrag;
    facDrag = null;
    if (typeof facStrip.releasePointerCapture === 'function' && d.pid !== undefined) {
      try { facStrip.releasePointerCapture(d.pid); } catch (eR) { /* no-op */ }
    }
    if (!d.moved) {
      facStrip.classList.remove('dragging');
      return; // a tap: the card's own click handler selects it
    }
    // swallow the click that follows the release (capture beats the card's
    // bubble handler in real browsers); drop the guard after this event
    const swallow = (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (ev && ev.preventDefault) ev.preventDefault();
    };
    facStrip.addEventListener('click', swallow, true);
    if (typeof setTimeout === 'function') {
      setTimeout(() => {
        if (facStrip.removeEventListener) {
          facStrip.removeEventListener('click', swallow, true);
        }
      }, 0);
    }
    if (Math.abs(d.v) > 0.05) { // flicked hard enough to glide (~50px/s)
      facGlide = { v: d.v * 1000, t: menuNow() }; // px/s
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(glideTick);
      else { facGlide = null; facStrip.classList.remove('dragging'); }
    } else {
      facStrip.classList.remove('dragging');
    }
  };
  facStrip.addEventListener('pointerdown', (e) => {
    if (!e || (e.button !== undefined && e.button !== 0)) return;
    if (e.preventDefault) e.preventDefault();
    facGlide = null; // a fresh grab cancels any glide in flight
    facDrag = {
      x0: e.clientX, x: e.clientX, t: menuNow(),
      sl0: facStrip.scrollLeft || 0, v: 0, moved: false, pid: e.pointerId,
    };
    facStrip.classList.add('dragging');
    if (typeof facStrip.setPointerCapture === 'function' && e.pointerId !== undefined) {
      try { facStrip.setPointerCapture(e.pointerId); } catch (eC) { /* no-op */ }
    }
  });
  facStrip.addEventListener('pointermove', onStripMove);
  facStrip.addEventListener('pointerup', onStripUp);
  facStrip.addEventListener('pointercancel', () => {
    facDrag = null;
    facGlide = null;
    facStrip.classList.remove('dragging');
  });
  syncArrows();
  facWrap.appendChild(facPrev);
  facWrap.appendChild(facStrip);
  facWrap.appendChild(facNext);
  box.appendChild(facWrap);

  // AI opponents
  box.appendChild(h('h2', null, 'AI opponents'));
  const oppBox = h('div');
  box.appendChild(oppBox);

  // ally
  box.appendChild(h('h2', null, 'AI ally (team 2v2)'));
  const allyCheck = document.createElement('input');
  allyCheck.type = 'checkbox';
  allyCheck.addEventListener('change', () => {
    cfg.ally = allyCheck.checked
      ? { faction: 'Saudi', personality: 'Auto', difficulty: 'recruit' }
      : null;
    refreshOpponents();
  });
  box.appendChild(allyCheck);
  const allyBox = h('div');
  box.appendChild(allyBox);

  function aiRow(entry, factions) {
    const row = h('div', 'menu-row');
    const fSel = selectEl(factions, entry.faction);
    fSel.addEventListener('change', () => { entry.faction = fSel.value; });
    // v0.5.1: display label + internal id on hover; the saved value stays
    // the internal id (PERSONALITIES entries)
    const pSel = document.createElement('select');
    for (const p of PERSONALITIES) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = PERSONALITY_LABEL[p];
      opt.title = 'internal: ' + p.toLowerCase();
      if (p === entry.personality) opt.selected = true;
      pSel.appendChild(opt);
    }
    pSel.addEventListener('change', () => { entry.personality = pSel.value; });
    const dSel = selectEl(DIFFICULTIES, entry.difficulty, DIFFICULTY_LABEL);
    dSel.addEventListener('change', () => { entry.difficulty = dSel.value; });
    row.appendChild(fSel); row.appendChild(pSel); row.appendChild(dSel);
    return row;
  }

  function refreshOpponents() {
    const spawns = game.maps[cfg.map].spawns.length;
    // free player count: you + 1..(spawns-1) AI, optional ally if room
    if (cfg.ally && spawns < 3) { cfg.ally = null; allyCheck.checked = false; }
    const maxOpp = spawns - 1 - (cfg.ally ? 1 : 0);
    while (cfg.opponents.length > maxOpp) cfg.opponents.pop();
    while (cfg.opponents.length < 1) {
      cfg.opponents.push({ faction: 'Iran', personality: 'Auto', difficulty: 'recruit' });
    }
    oppBox.innerHTML = '';
    const factions = Object.keys(game.data.factions);
    cfg.opponents.forEach((o) => oppBox.appendChild(aiRow(o, factions)));
    if (maxOpp >= 2) {
      const add = h('button', 'menu-btn', '+ Add opponent (' + cfg.opponents.length + '/' + maxOpp + ')');
      add.addEventListener('click', () => {
        if (cfg.opponents.length < maxOpp) {
          cfg.opponents.push({ faction: 'Turkey', personality: 'Auto', difficulty: 'recruit' });
          refreshOpponents();
        }
      });
      const rem = h('button', 'menu-btn', '− Remove');
      rem.addEventListener('click', () => {
        if (cfg.opponents.length > 1) {
          cfg.opponents.pop();
          refreshOpponents();
        }
      });
      oppBox.appendChild(add); oppBox.appendChild(rem);
    }
    allyCheck.disabled = spawns < 3;
    allyBox.innerHTML = '';
    if (cfg.ally) allyBox.appendChild(aiRow(cfg.ally, factions));
  }
  refreshOpponents();

  // start
  const row = h('div', 'menu-row');
  // v0.4.4: tutorial mode checkbox — default checked when arriving via the
  // Tutorial button, and always off once the tutorial has been seen/skipped
  const tutCheck = document.createElement('input');
  tutCheck.type = 'checkbox';
  tutCheck.className = 'tutor-check';
  tutCheck.checked = !!tutorialPath && !tutorialSeen();
  cfg.tutorial = tutCheck.checked;
  tutCheck.addEventListener('change', () => { cfg.tutorial = tutCheck.checked; });
  row.appendChild(tutCheck);
  row.appendChild(h('span', null, 'Tutorial mode'));
  const start = h('button', 'menu-btn start', 'Start match');
  start.addEventListener('click', () => {
    root.classList.add('hidden');
    onStart(cfg);
  });
  const back = h('button', 'menu-btn', 'Back');
  const goBack = () => showMenu(game, onStart);
  game.menuBack = goBack; // Esc on the setup screen goes Back
  back.addEventListener('click', goBack);
  row.appendChild(start); row.appendChild(back);
  box.appendChild(row);
  root.appendChild(box);
}

// v0.10.0 multiplayer (menu side): the MULTIPLAYER entry on the main menu,
// the host/join setup screen, and the host-authoritative lobby. Everything
// reads the net object off `game.net` (never an import) so headless harnesses
// can inject a fake; the actual socket work lives in net/net.js + main.js.
const SLOT_COLORS = ['#4da3ff', '#ff6b6b', '#69d781', '#ffd76a', '#c792ff', '#5ad4d4'];

function mpColorDot(slot) {
  const dot = h('span', 'mp-dot');
  dot.style.background = SLOT_COLORS[slot % SLOT_COLORS.length];
  return dot;
}

function mpErrorLine(box) {
  const el = h('div', 'mp-error');
  el.style.display = 'none';
  box.appendChild(el);
  return el;
}

export function showMpSetup(game, onStart) {
  game.overlay = 'menu';
  game.resumePause = null;
  game.menuBack = null;
  if (document.body && document.body.classList) document.body.classList.add('in-menu');
  const root = document.getElementById('menu');
  root.classList.remove('hidden');
  root.innerHTML = '';
  applyArtBg(game, root, 'setup');
  const box = h('div', 'menu-box');
  box.appendChild(h('h1', null, 'Multiplayer'));
  box.appendChild(h('p', null, 'Lockstep over a LAN/online relay — v0.10.0'));
  const err = mpErrorLine(box);

  box.appendChild(h('h2', null, 'Your name'));
  const name = document.createElement('input');
  name.value = 'Player';
  box.appendChild(name);

  box.appendChild(h('h2', null, 'Relay address'));
  const url = document.createElement('input');
  url.className = 'mp-url';
  url.value = (game.net && game.net.url) || 'ws://127.0.0.1:8790';
  box.appendChild(url);
  box.appendChild(h('div', 'mp-note',
    'Run the relay first: python tools/mca_relay.py --port 8790'
    + ' (same PC: --local-only; LAN: use the host PC IP)'));

  const run = (promise) => {
    promise.then((r) => {
      if (r && r.ok) showLobby(game);
      else {
        err.textContent = (r && r.error) || 'Could not connect.';
        err.style.display = 'block';
      }
    });
  };

  box.appendChild(h('h2', null, 'Host a room'));
  const hostBtn = h('button', 'menu-btn', 'Host — create room');
  hostBtn.addEventListener('click', () => {
    err.style.display = 'none';
    run(game.mpHost({ url: url.value.trim(), name: name.value.trim() || 'Player' }));
  });
  box.appendChild(hostBtn);

  box.appendChild(h('h2', null, 'Join a room'));
  const joinRow = h('div', 'menu-row');
  const code = document.createElement('input');
  code.className = 'mp-code';
  code.value = '';
  code.setAttribute && code.setAttribute('maxlength', '4');
  const joinBtn = h('button', 'menu-btn', 'Join');
  joinBtn.addEventListener('click', () => {
    err.style.display = 'none';
    run(game.mpJoin({
      url: url.value.trim(), code: code.value.trim().toUpperCase(),
      name: name.value.trim() || 'Player',
    }));
  });
  joinRow.appendChild(code);
  joinRow.appendChild(joinBtn);
  box.appendChild(joinRow);

  const back = h('button', 'menu-btn', 'Back');
  const goBack = () => showMenu(game, onStart);
  game.menuBack = goBack;
  back.addEventListener('click', goBack);
  box.appendChild(back);
  root.appendChild(box);
}

export function closeLobbyUi(game) {
  const root = document.getElementById('menu');
  if (root && root.classList) root.classList.add('hidden');
  if (document.body && document.body.classList) document.body.classList.remove('in-menu');
  game.overlay = null;
  game.menuBack = null;
}

// The host-authoritative lobby. Re-rendered on every onLobby/onCfg/membership
// hook while it is open. Peers edit only their own row (faction/team/ready);
// the host additionally picks map/seed/input-delay and fires START.
export function showLobby(game) {
  const net = game.net;
  if (!net) return;
  // preserve the in-progress chat line across re-renders (lobby refreshes on
  // every slot update)
  const prevInput = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('mp-chatinput') : null;
  const prevVal = prevInput ? prevInput.value : '';
  game.overlay = 'lobby';
  if (document.body && document.body.classList) document.body.classList.add('in-menu');
  const root = document.getElementById('menu');
  root.classList.remove('hidden');
  root.innerHTML = '';
  const box = h('div', 'menu-box mp-lobby');
  box.appendChild(h('h1', null, 'Multiplayer lobby'));
  if (net.isHost) {
    const codeLine = h('div', 'mp-code-line');
    codeLine.appendChild(h('span', null, 'Room code: '));
    const big = h('span', 'mp-code-big', net.code || '....');
    codeLine.appendChild(big);
    codeLine.appendChild(h('span', 'mp-note', ' — share it with your opponents'));
    box.appendChild(codeLine);
  } else {
    box.appendChild(h('p', null, 'Room ' + (net.code || '') + ' — waiting for the host'));
  }

  // slot list
  const slots = net.lobbySlots ? net.lobbySlots() : [];
  const list = h('div', 'mp-slots');
  const factions = Object.keys(game.data.factions);
  let allReady = slots.length > 0;
  for (const s of slots) {
    const isMe = s.slot === net.slot;
    const isHostSlot = s.slot === 0;
    if (!isHostSlot && !s.ready) allReady = false;
    const row = h('div', 'mp-slot-row');
    row.appendChild(mpColorDot(s.slot));
    const label = h('span', 'mp-slot-name',
      s.name + (isMe ? ' (you)' : '') + (isHostSlot ? ' ★' : ''));
    row.appendChild(label);
    if (isMe) {
      const fSel = selectEl(factions, s.faction);
      fSel.addEventListener('change', () => {
        if (game.mpSetSlot) game.mpSetSlot({ faction: fSel.value });
      });
      row.appendChild(fSel);
      const tSel = selectEl(['0', '1', '2', '3'], String(s.team || 0));
      tSel.addEventListener('change', () => {
        if (game.mpSetSlot) game.mpSetSlot({ team: Number(tSel.value) });
      });
      row.appendChild(tSel);
      if (!net.isHost) {
        const ready = document.createElement('input');
        ready.type = 'checkbox';
        ready.checked = !!s.ready;
        ready.addEventListener('change', () => {
          if (game.mpSetSlot) game.mpSetSlot({ ready: ready.checked });
        });
        row.appendChild(ready);
        row.appendChild(h('span', 'mp-note', 'ready'));
      }
    } else {
      row.appendChild(h('span', 'mp-note',
        (s.faction || '?') + ' · team ' + (s.team || 0)
          + (isHostSlot ? '' : (s.ready ? ' · ready ✓' : ' · not ready'))));
    }
    list.appendChild(row);
  }
  box.appendChild(list);

  // host setup / guest view of the cfg
  const lobby = game.lobby || (net.cfg ? { map: net.cfg.map, seed: net.cfg.seed, delay: net.cfg.delay } : null);
  if (net.isHost) {
    box.appendChild(h('h2', null, 'Map'));
    const mapRow = h('div', 'menu-row');
    const maps = Object.keys(game.maps);
    const cur = lobby && lobby.map ? lobby.map : maps[0];
    for (const m of maps) {
      const md = game.maps[m];
      const b = h('button', 'menu-btn' + (cur === m ? ' sel' : ''),
        (md.name || m) + ' — ' + md.spawns.length + 'p');
      b.addEventListener('click', () => { if (game.mpSetLobby) game.mpSetLobby({ map: m }); });
      mapRow.appendChild(b);
    }
    box.appendChild(mapRow);
    const optRow = h('div', 'menu-row');
    optRow.appendChild(h('span', null, 'Seed'));
    const seed = document.createElement('input');
    seed.className = 'mp-seed';
    seed.value = String(lobby && lobby.seed !== undefined ? lobby.seed : 1);
    seed.addEventListener('change', () => {
      const v = parseInt(seed.value, 10);
      if (game.mpSetLobby && isFinite(v)) game.mpSetLobby({ seed: v >>> 0 });
    });
    optRow.appendChild(seed);
    optRow.appendChild(h('span', null, 'Input delay'));
    const delay = selectEl(['2', '4'], String(lobby && lobby.delay ? lobby.delay : 2),
      { 2: '2 ticks (LAN)', 4: '4 ticks (online)' });
    delay.addEventListener('change', () => {
      if (game.mpSetLobby) game.mpSetLobby({ delay: Number(delay.value) });
    });
    optRow.appendChild(delay);
    box.appendChild(optRow);
    const start = h('button', 'menu-btn start', 'Start match');
    start.disabled = !allReady || slots.length < 2;
    start.addEventListener('click', () => { if (game.mpStart) game.mpStart(); });
    const startRow = h('div', 'menu-row');
    startRow.appendChild(start);
    box.appendChild(startRow);
  } else {
    const view = h('div', 'mp-note');
    view.textContent = lobby && lobby.map
      ? 'Map: ' + lobby.map + ' · seed ' + lobby.seed + ' · delay ' + (lobby.delay || 2)
        + ' — the host starts the match'
      : 'Waiting for the host to pick a map…';
    box.appendChild(view);
  }

  // chat
  box.appendChild(h('h2', null, 'Chat'));
  const logEl = h('div', 'mp-chatlog');
  logEl.id = 'mp-chatlog';
  for (const line of game.mpChatLog || []) {
    const div = h('div', 'mp-chatline', line.name + ': ' + line.text);
    logEl.appendChild(div);
  }
  box.appendChild(logEl);
  const chatRow = h('div', 'menu-row');
  const chatInput = document.createElement('input');
  chatInput.className = 'mp-chatinput';
  chatInput.id = 'mp-chatinput';
  if (prevVal) chatInput.value = prevVal;
  const sendChat = () => {
    const v = chatInput.value.trim();
    if (v && game.mpSendChat) game.mpSendChat(v);
    chatInput.value = '';
  };
  chatInput.addEventListener('keydown', (e) => {
    if (e && e.key === 'Enter') sendChat();
    if (e && e.stopPropagation) e.stopPropagation();
  });
  const chatBtn = h('button', 'menu-btn', 'Send');
  chatBtn.addEventListener('click', sendChat);
  chatRow.appendChild(chatInput);
  chatRow.appendChild(chatBtn);
  box.appendChild(chatRow);

  const leave = h('button', 'menu-btn', 'Leave');
  leave.addEventListener('click', () => { if (game.mpLeaveLobby) game.mpLeaveLobby(); });
  box.appendChild(leave);
  game.menuBack = () => { if (game.mpLeaveLobby) game.mpLeaveLobby(); };
  root.appendChild(box);
}

// v0.10.0 desync halt: freeze frame, name both checksums, offer the way out.
export function showDesyncOverlay(game, opts) {
  const banner = document.getElementById('banner');
  if (!banner) { if (opts && opts.onMenu) opts.onMenu(); return; }
  banner.classList.remove('hidden');
  banner.className = 'lost';
  banner.innerHTML = '';
  const box = h('div', 'menu-box');
  box.appendChild(h('h1', null, 'DESYNC DETECTED'));
  const info = game.mpDesync;
  box.appendChild(h('p', null, 'Match halted — sims diverged'
    + (info ? ' at tick ' + info.tick : '')
    + '. Both sums are in the console (F12).'));
  const row = h('div', 'menu-row');
  const menu = h('button', 'menu-btn start', 'Return to menu');
  menu.addEventListener('click', () => {
    banner.classList.add('hidden');
    if (opts && opts.onMenu) opts.onMenu();
  });
  row.appendChild(menu);
  box.appendChild(row);
  banner.appendChild(box);
}

// v0.7.1 match briefing: full-screen faction plate shown by startMatch before
// the sim starts ticking (game.briefing gates simStep in main.js). Dismisses
// on any click/keydown (Esc included, swallowed so it can't reach the pause
// path) or at the deadline checked by the frame loop. No pack / no plate for
// the faction -> never shows (headless/dev path stays clean).
export function showBriefing(game, faction) {
  const uri = game.briefings && game.briefings[faction];
  if (!uri) return false;
  const root = document.getElementById('briefing');
  if (!root || !root.classList) return false;
  root.innerHTML = '';
  root.classList.remove('hidden');
  const box = h('div', 'brief-box');
  const img = document.createElement('img');
  img.src = uri;
  img.className = 'brief-poster';
  img.alt = faction + ' briefing';
  box.appendChild(img);
  const deploy = h('button', 'menu-btn start brief-deploy', 'DEPLOY ▶');
  box.appendChild(deploy);
  box.appendChild(h('div', 'brief-hint', 'click anywhere to continue'));
  root.appendChild(box);
  const dismiss = () => {
    if (!game.briefing) return;
    game.briefing = null;
    root.classList.add('hidden');
    root.innerHTML = '';
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
  game.briefing = { deadline: now + 2500, dismiss };
  return true;
}

// pause overlay during a live match (top-bar Menu button): Resume / Restart /
// Abandon (two-step confirm). v0.10.0: in an MP match Restart is hidden — a
// shared lockstep match cannot be restarted locally — and Abandon also
// leaves the room.
export function showPauseMenu(game, opts) {
  game.overlay = 'pause';
  if (document.body && document.body.classList) document.body.classList.add('in-menu');
  const root = document.getElementById('menu');
  root.classList.remove('hidden');
  root.innerHTML = '';
  const box = h('div', 'menu-box');
  box.appendChild(h('h1', null, 'Paused'));
  if (game.mpPauseName) box.appendChild(h('p', null, 'Paused by ' + game.mpPauseName));
  const row = h('div', 'menu-row');
  const resume = h('button', 'menu-btn start', 'Resume');
  const doResume = () => {
    root.classList.add('hidden');
    if (document.body && document.body.classList) document.body.classList.remove('in-menu');
    game.resumePause = null;
    opts.onResume();
  };
  resume.addEventListener('click', doResume);
  game.resumePause = doResume; // Esc == Resume while this overlay is up
  row.appendChild(resume);
  if (!(game.net && game.net.active)) {
    const restart = h('button', 'menu-btn', 'Restart');
    restart.addEventListener('click', () => {
      root.classList.add('hidden');
      opts.onRestart();
    });
    row.appendChild(restart);
  }
  const abandon = h('button', 'menu-btn', 'Abandon match');
  let armed = false;
  abandon.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      abandon.textContent = 'Really abandon?';
      abandon.classList.add('sel');
      return;
    }
    root.classList.add('hidden');
    opts.onAbandon();
  });
  row.appendChild(abandon);
  box.appendChild(row);
  root.appendChild(box);
}

export function showEndBanner(game, opts) {
  const banner = document.getElementById('banner');
  banner.classList.remove('hidden');
  banner.className = opts.won ? 'won' : 'lost';
  banner.innerHTML = '';
  const box = h('div', 'menu-box');
  box.appendChild(h('h1', null, opts.won ? 'VICTORY' : 'DEFEAT'));
  // v0.3.6 score screen: per-player kills/losses/credits + match time
  const st = game.state;
  if (st) {
    const secs = Math.floor(st.tick / 10);
    box.appendChild(h('p', null,
      'Match time ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0')));
    const tbl = h('div', 'score-table');
    // v0.4.3: split losses into units vs structures when the sim tracks them.
    // Defensive: the fields may live flat on the player (like unitsKilled) or
    // under p.stats; older builds without them keep the single Lost column.
    const structLossOf = (p) => {
      if (p.structsLost !== undefined) return p.structsLost;
      if (p.stats && p.stats.structsLost !== undefined) return p.stats.structsLost;
      return undefined;
    };
    const splitLoss = st.players.some((p) => structLossOf(p) !== undefined);
    const cols = splitLoss
      ? ['Player', 'Killed', 'Units lost', 'Structs lost', 'Earned', 'Spent']
      : ['Player', 'Killed', 'Lost', 'Earned', 'Spent'];
    const head = h('div', 'score-row score-head' + (splitLoss ? ' six' : ''));
    for (const c of cols) head.appendChild(h('span', null, c));
    tbl.appendChild(head);
    for (const p of st.players) {
      const row = h('div', 'score-row' + (splitLoss ? ' six' : '') + (p.eliminated ? ' out' : ''));
      row.appendChild(h('span', null,
        p.faction + (p.ai ? ' (AI)' : '') + (p.eliminated ? ' — out' : '')));
      row.appendChild(h('span', null, String(p.unitsKilled)));
      row.appendChild(h('span', null, String(p.unitsLost)));
      if (splitLoss) row.appendChild(h('span', null, String(structLossOf(p) | 0)));
      row.appendChild(h('span', null, String(p.creditsEarned)));
      row.appendChild(h('span', null, String(p.creditsSpent)));
      tbl.appendChild(row);
    }
    box.appendChild(tbl);
  }
  const row = h('div', 'menu-row');
  const again = h('button', 'menu-btn start', 'Rematch');
  again.addEventListener('click', () => {
    banner.classList.add('hidden');
    opts.onRestart();
  });
  const menu = h('button', 'menu-btn', 'Menu');
  menu.addEventListener('click', () => {
    banner.classList.add('hidden');
    opts.onMenu();
  });
  row.appendChild(again); row.appendChild(menu);
  box.appendChild(row);
  banner.appendChild(box);
}
