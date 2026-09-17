// Main menu, match setup, and end-of-match banner. Pure DOM overlay;
// calls back into main.js via the supplied callbacks.
const PERSONALITIES = ['Front', 'Sky', 'Raid', 'Fortress'];
const DIFFICULTIES = ['recruit', 'veteran', 'elite', 'marshal'];
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

function selectEl(options, value) {
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
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
  const box = h('div', 'menu-box');
  box.appendChild(h('h1', null, 'MCA — Middle East Combat Arena'));
  box.appendChild(h('p', null, 'Offline greybox skirmish RTS'));
  const start = h('button', 'menu-btn', 'Skirmish');
  start.addEventListener('click', () => showSetup(game, root, onStart));
  box.appendChild(start);
  root.appendChild(box);
  const banner = document.getElementById('banner');
  banner.classList.add('hidden');
}

function showSetup(game, root, onStart) {
  game.overlay = 'setup';
  root.innerHTML = '';
  const box = h('div', 'menu-box');
  box.appendChild(h('h1', null, 'Skirmish setup'));

  const cfg = {
    map: Object.keys(game.maps)[0],
    faction: 'Egypt',
    opponents: [{ faction: 'Algeria', personality: 'Front', difficulty: 'recruit' }],
    ally: null,
  };

  // map
  box.appendChild(h('h2', null, 'Map'));
  const mapRow = h('div', 'menu-row');
  const mapBtns = {};
  for (const m of Object.keys(game.maps)) {
    const md = game.maps[m];
    const desc = (md.name || m) + ' — ' + md.w + '×' + md.h
      + ', up to ' + md.spawns.length + ' players';
    const b = h('button', 'menu-btn' + (cfg.map === m ? ' sel' : ''), desc);
    b.addEventListener('click', () => {
      cfg.map = m;
      for (const k in mapBtns) mapBtns[k].classList.toggle('sel', k === m);
      refreshOpponents();
    });
    mapBtns[m] = b;
    mapRow.appendChild(b);
  }
  box.appendChild(mapRow);

  // your faction
  box.appendChild(h('h2', null, 'Your faction'));
  const facRow = h('div', 'menu-row');
  const facBtns = {};
  for (const fname of Object.keys(game.data.factions)) {
    const f = game.data.factions[fname];
    const b = h('button', 'menu-btn fac-btn' + (cfg.faction === fname ? ' sel' : ''));
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
    facRow.appendChild(b);
  }
  box.appendChild(facRow);

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
      ? { faction: 'Saudi', personality: 'Fortress', difficulty: 'recruit' }
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
    const pSel = selectEl(PERSONALITIES, entry.personality);
    pSel.addEventListener('change', () => { entry.personality = pSel.value; });
    const dSel = selectEl(DIFFICULTIES, entry.difficulty);
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
      cfg.opponents.push({ faction: 'Iran', personality: 'Front', difficulty: 'recruit' });
    }
    oppBox.innerHTML = '';
    const factions = Object.keys(game.data.factions);
    cfg.opponents.forEach((o) => oppBox.appendChild(aiRow(o, factions)));
    if (maxOpp >= 2) {
      const add = h('button', 'menu-btn', '+ Add opponent (' + cfg.opponents.length + '/' + maxOpp + ')');
      add.addEventListener('click', () => {
        if (cfg.opponents.length < maxOpp) {
          cfg.opponents.push({ faction: 'Turkey', personality: 'Sky', difficulty: 'recruit' });
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

// pause overlay during a live match (top-bar Menu button): Resume / Restart /
// Abandon (two-step confirm)
export function showPauseMenu(game, opts) {
  game.overlay = 'pause';
  if (document.body && document.body.classList) document.body.classList.add('in-menu');
  const root = document.getElementById('menu');
  root.classList.remove('hidden');
  root.innerHTML = '';
  const box = h('div', 'menu-box');
  box.appendChild(h('h1', null, 'Paused'));
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
  const restart = h('button', 'menu-btn', 'Restart');
  restart.addEventListener('click', () => {
    root.classList.add('hidden');
    opts.onRestart();
  });
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
  row.appendChild(resume); row.appendChild(restart); row.appendChild(abandon);
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
  const row = h('div', 'menu-row');
  const again = h('button', 'menu-btn start', 'Restart');
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
