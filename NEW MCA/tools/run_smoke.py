# M3 smoke harness: stubs a minimal DOM + Canvas 2D (recording calls), then
# boots main.js for real: menu -> startMatch -> 500 rendered frames, and
# checks the HUD build-button enable/disable logic.
# Usage: .venv/Scripts/python run_smoke.py
import json
import re
import sys
from pathlib import Path

from py_mini_racer import MiniRacer

CLIENT = Path(__file__).resolve().parent.parent / "client"
MODULES = [
    "src/sim/rng.js",
    "src/sim/state.js",
    "src/sim/orders.js",
    "src/sim/path.js",
    "src/sim/combat.js",
    "src/sim/economy.js",
    "src/sim/engine.js",
    "src/sim/ai.js",
    "src/game/sprites.js",
    "src/game/display.js",
    "src/game/fx.js",
    "src/game/camera.js",
    "src/game/placement.js",
    "src/game/rally.js",
    "src/game/input.js",
    "src/game/render.js",
    "src/game/hud.js",
    "src/game/minimap.js",
    "src/game/menu.js",
    "src/main.js",
]

STUB_JS = r"""
globalThis.__MCA_NO_AUTOBOOT = true;
var __now = 0;
var __rafCb = null;
globalThis.requestAnimationFrame = function (cb) { __rafCb = cb; return 1; };
globalThis.performance = { now: function () { return __now; } };

var __ctxMethods = ['fillRect','clearRect','strokeRect','beginPath','closePath',
  'moveTo','lineTo','arc','ellipse','fill','stroke','fillText','drawImage','save','restore',
  'setTransform','translate','scale','rect','setLineDash','putImageData'];
function FakeCtx(canvas) {
  this.canvas = canvas;
  this.calls = 0;
  this.log = []; // [method, args] call-order record for draw-order assertions
  var self = this;
  __ctxMethods.forEach(function (m) {
    self[m] = function () {
      self.calls++;
      self.log.push([m, Array.prototype.slice.call(arguments)]);
    };
  });
}
FakeCtx.prototype.createImageData = function (w, h) {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
};
FakeCtx.prototype.getImageData = function (x, y, w, h) {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
};

function FakeEl(tag) {
  var el = {
    tagName: tag, children: [], style: {}, dataset: {},
    listeners: {}, textContent: '', value: '', disabled: false,
    className: '', title: '', width: 300, height: 150, type: '',
    checked: false, selected: false,
  };
  var classes = {};
  el.classList = {
    add: function (c) { classes[c] = true; },
    remove: function (c) { delete classes[c]; },
    toggle: function (c, force) {
      var on = force === undefined ? !classes[c] : force;
      if (on) classes[c] = true; else delete classes[c];
    },
    contains: function (c) { return !!classes[c]; },
  };
  el.addEventListener = function (t, f) { (el.listeners[t] = el.listeners[t] || []).push(f); };
  el.removeEventListener = function () {};
  el.appendChild = function (c) { el.children.push(c); return c; };
  el.removeChild = function (c) {
    var i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1);
  };
  el.setAttribute = function () {};
  el.focus = function () {};
  el.click = function () { (el.listeners.click || []).forEach(function (f) { f({}); }); };
  el.getContext = function () {
    if (!el.__ctx) el.__ctx = new FakeCtx(el);
    return el.__ctx;
  };
  el.getBoundingClientRect = function () {
    return { left: 0, top: 0, width: el.width || 800, height: el.height || 600 };
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return ''; },
    set: function () { el.children = []; },
  });
  return el;
}

var __els = {};
globalThis.document = {
  createElement: function (t) { return FakeEl(t); },
  createTextNode: function (t) { return { text: t }; },
  getElementById: function (id) {
    if (!__els[id]) __els[id] = FakeEl('div#' + id);
    return __els[id];
  },
  body: FakeEl('body'),
  addEventListener: function () {},
};
globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.addEventListener = function () {};

globalThis.fetch = function (url) {
  var txt = null;
  if (url.indexOf('game.json') >= 0) txt = __jsonGame;
  else if (url.indexOf('maps/manifest.json') >= 0) txt = __jsonManifest;
  else if (url.indexOf('display.json') >= 0) txt = '{}';
  else if (url.indexOf('sprite_map.json') >= 0) txt = '{"frames":{}}';
  else {
    var mm = url.match(/maps\/([^\/]+)\.json/);
    if (mm && __jsonMaps[mm[1]]) txt = __jsonMaps[mm[1]];
  }
  return Promise.resolve({
    ok: !!txt, status: txt ? 200 : 404,
    json: function () { return Promise.resolve(JSON.parse(txt)); },
  });
};
globalThis.FileReader = function () { };
"""

DRIVER_BOOT = r"""
var __smoke = { errors: [], checks: [] };
function __check(name, cond, detail) {
  __smoke.checks.push({ name: name, pass: !!cond, detail: String(detail || '') });
}
try { boot(); } catch (e) { __smoke.errors.push('boot threw: ' + (e && e.stack || e)); }
"""

DRIVER_MAIN = r"""
(function () {
  try {
    var g = getGame();
    __check('boot-no-exception', __smoke.errors.length === 0 && !!g, __smoke.errors.join('; '));
    __check('menu-shown',
      document.getElementById('menu').children.length > 0 && !g.state,
      'menu children=' + document.getElementById('menu').children.length);

    // setup screen: all six maps listed; 6-player maps allow 1..5 opponents
    function walkAll(el, fn) {
      fn(el);
      for (var ci = 0; ci < (el.children || []).length; ci++) walkAll(el.children[ci], fn);
    }
    var skBtn = null;
    walkAll(document.getElementById('menu'), function (el) {
      if (el.tagName === 'button' && el.textContent === 'Skirmish') skBtn = el;
    });
    var mapBtnCount = 0, eqBtn = null;
    if (skBtn) {
      skBtn.click();
      walkAll(document.getElementById('menu'), function (el) {
        if (el.tagName === 'button' && /players$/.test(el.textContent || '')) {
          mapBtnCount++;
          if ((el.textContent || '').indexOf('Empty Quarter') === 0) eqBtn = el;
        }
      });
    }
    __check('menu-lists-6-maps', mapBtnCount === 6, 'map buttons=' + mapBtnCount);
    var addLbl = '';
    if (eqBtn) {
      eqBtn.click();
      walkAll(document.getElementById('menu'), function (el) {
        if (el.tagName === 'button' && (el.textContent || '').indexOf('+ Add opponent') === 0) {
          addLbl = el.textContent;
        }
      });
    }
    __check('menu-free-playercount', /1\/5/.test(addLbl), 'add label=' + addLbl);

    function findBtn(rootId, text) {
      var found = null;
      walkAll(document.getElementById(rootId), function (el) {
        if (!found && el.tagName === 'button' && el.textContent === text) found = el;
      });
      return found;
    }
    function runFrames(n) {
      for (var fi = 0; fi < n; fi++) {
        __now += 16.7; var cb = __rafCb; __rafCb = null;
        if (cb) cb(__now);
      }
    }
    function menuVisible() {
      return !document.getElementById('menu').classList.contains('hidden');
    }

    // journey A: start via the real setup UI (an earlier check selected Empty
    // Quarter — click Duel back first)
    var duelBtn = null;
    walkAll(document.getElementById('menu'), function (el) {
      if (el.tagName === 'button' && (el.textContent || '').indexOf('Duel') === 0) duelBtn = el;
    });
    if (duelBtn) duelBtn.click();
    var startBtn = findBtn('menu', 'Start match');
    if (startBtn) startBtn.click();
    __check('match-started', !!duelBtn && !!startBtn && !!g.state && !!g.camera
      && !menuVisible() && !document.body.classList.contains('in-menu'),
      'duelBtn=' + !!duelBtn + ' startBtn=' + !!startBtn);

    // journey 1: Menu pauses (frozen sim), HUD Pause inert under overlay, Resume resumes
    runFrames(100);
    var tickAtMenu = g.state.tick;
    var pauseBtnTop = findBtn('topbar', 'Pause');
    findBtn('topbar', 'Menu').click();
    var pausedOk = g.paused === true && g.overlay === 'pause' && menuVisible();
    pauseBtnTop.click(); // must be inert while the overlay owns pause state
    pausedOk = pausedOk && g.paused === true;
    runFrames(20);
    var frozenOk = g.state.tick === tickAtMenu;
    __check('ui-menu-pauses', pausedOk && frozenOk,
      'paused=' + g.paused + ' overlay=' + g.overlay + ' frozen=' + frozenOk);
    findBtn('menu', 'Resume').click();
    var tickResume = g.state.tick;
    runFrames(30);
    __check('ui-resume-resumes', g.paused === false && !menuVisible()
      && g.overlay === null && g.state.tick > tickResume
      && g.state.tick - tickResume <= 10, // no fast-forward backlog
      'paused=' + g.paused + ' ticks=' + tickResume + '->' + g.state.tick);

    var t0 = g.state.tick;
    var frames = 0;
    for (var i = 0; i < 500; i++) {
      __now += 16.7;
      var cb = __rafCb; __rafCb = null;
      if (!cb) { __smoke.errors.push('no rAF callback at frame ' + i); break; }
      cb(__now);
      frames++;
    }
    __check('menu-to-match-500-frames', frames === 500 && __smoke.errors.length === 0,
      'frames=' + frames + ' errors=' + __smoke.errors.join('; '));
    __check('sim-advanced', g.state.tick - t0 >= 50, 'ticks=' + (g.state.tick - t0));
    __check('canvas-drawn', g.ctx.calls > 500, 'ctx calls=' + g.ctx.calls);

    // journey 2: HUD pause survives a Menu -> Resume round-trip
    pauseBtnTop.click();
    var hudPaused = g.paused === true;
    findBtn('topbar', 'Menu').click();
    findBtn('menu', 'Resume').click();
    var stillPaused = g.paused === true && !menuVisible();
    pauseBtnTop.click();
    var tJ2 = g.state.tick;
    runFrames(30);
    __check('ui-hud-pause-restored', hudPaused && stillPaused
      && g.paused === false && g.state.tick > tJ2,
      'hud=' + hudPaused + ' still=' + stillPaused + ' paused=' + g.paused);

    // player command path: deploy the MCV through the sim command queue
    var mcv = null;
    for (var id in g.state.units) {
      if (g.state.units[id].owner === 0 && g.state.units[id].defId === 'MCV') mcv = g.state.units[id];
    }
    g.pendingCmds.push({ player: 0, type: 'deployMCV', unitId: mcv.id });
    for (var j = 0; j < 40; j++) {
      __now += 16.7;
      var cb2 = __rafCb; __rafCb = null;
      if (cb2) cb2(__now);
    }
    var cy = false;
    for (var id2 in g.state.structures) {
      var s2 = g.state.structures[id2];
      if (s2.owner === 0 && s2.defId === 'SH-01') cy = true;
    }
    __check('player-deploy-mcv', cy, '');

    // HUD build-button logic on a controlled state
    var st = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 7 });
    addStructure(st, 'SH-01', 0, 8, 8);
    addStructure(st, 'SH-04', 0, 12, 8);
    var p0 = st.players[0];

    var affordable = trainButtonState(st, p0, 'EG-01'); // 150cr rifle, Barracks standing
    __check('hud-affordable-enabled', affordable.enabled, affordable.reason);

    p0.credits = 0;
    var broke = trainButtonState(st, p0, 'EG-01');
    __check('hud-unaffordable-disabled', !broke.enabled && broke.reason === 'credits', broke.reason);
    p0.credits = 100000;

    var wrongProd = trainButtonState(st, p0, 'EG-06'); // M60A3 (tech 0) needs War Factory
    __check('hud-wrong-producer-disabled',
      !wrongProd.enabled && wrongProd.reason === 'no-producer', wrongProd.reason);

    addStructure(st, 'SH-05', 0, 16, 8);
    var gated = trainButtonState(st, p0, 'EG-13'); // WAVE1 T-90MS, no SH-08
    __check('hud-techgated-disabled', !gated.enabled && gated.reason === 'tech-gate', gated.reason);

    var structOk = structureButtonState(st, p0, 'SH-02');
    __check('hud-structure-enabled', structOk.enabled, structOk.reason);

    // (a) placement forgiveness: click inside the ConYard footprint (8,8 fp=3),
    // a legal spot must be found within 3 cells
    var ppDef = st.structDefs['SH-02'];
    var spot = resolvePlacement(st, 0, ppDef, 8, 8);
    __check('forgiveness-finds-spot',
      !!spot && spot.adjusted && canPlace(st, 0, ppDef, spot.cx, spot.cy)
        && Math.max(Math.abs(spot.cx - 8), Math.abs(spot.cy - 8)) <= 3,
      JSON.stringify(spot));
    var nowhere = resolvePlacement(st, 0, ppDef, 90, 90);
    __check('forgiveness-gives-up-far', nowhere === null, JSON.stringify(nowhere));
    var why = placementBlockReason(st, 0, ppDef, 90, 90);
    __check('block-reason-far-from-base', why === 'Too far from base', String(why));

    // (b) build-bar hotkey mapping: Q W E R T F G in grid order, A/S/D skipped
    var items = buildGridItems(st, p0, 'structures');
    var hkm = hotkeyMapFor(items);
    __check('hotkey-mapping',
      items.length >= 7 && hkm.Q === items[0].id && hkm.W === items[1].id
        && hkm.G === items[6].id
        && hkm.A === undefined && hkm.S === undefined && hkm.D === undefined,
      'first=' + (items[0] && items[0].id) + ' keys=' + Object.keys(hkm).join(''));

    // (c) tooltip builder: cost + role strings for units, power for structures
    var ttu = tooltipLines(st, p0, 'unit', 'EG-01').join(' | ');
    __check('tooltip-unit-cost-role',
      ttu.indexOf('150') >= 0 && ttu.indexOf('Line') >= 0, ttu);
    var tts = tooltipLines(st, p0, 'struct', 'SH-02').join(' | ');
    __check('tooltip-struct-power',
      tts.indexOf('800') >= 0 && tts.indexOf('Power +100') >= 0, tts);

    // (d) rally: right-click with a production structure selected -> setRally
    var wfId = null, cyId = null;
    for (var sid in st.structures) {
      var so = st.structures[sid];
      if (so.owner === 0 && so.defId === 'SH-05') wfId = so.id;
      if (so.owner === 0 && so.defId === 'SH-01') cyId = so.id;
    }
    var rc = rallyCommand(st, 0, [wfId], 500, 600);
    __check('rally-command-prod',
      !!rc && rc.type === 'setRally' && rc.structId === wfId && rc.x === 500 && rc.y === 600,
      JSON.stringify(rc));
    var rcNone = rallyCommand(st, 0, [cyId], 5, 6);
    __check('rally-command-nonprod-null', rcNone === null, JSON.stringify(rcNone));

    // ---- v0.3 "It fights back" checks -------------------------------------

    // (a) structure fire: an SH-09 HMG nest kills an adjacent rifle squad
    var stT = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 11 });
    addStructure(stT, 'SH-01', 0, 8, 8);
    var tower = addStructure(stT, 'SH-09', 0, 12, 8);
    var rifle = addUnit(stT, 'DZ-01', 1, 15 * 64, 9 * 64 + 32);
    var deadTick = -1;
    for (var iT = 0; iT < 300; iT++) {
      tick(stT);
      if (!stT.units[rifle.id]) { deadTick = stT.tick; break; }
    }
    __check('tower-kills-rifle', deadTick > 0 && !!stT.structures[tower.id],
      'rifle deadTick=' + deadTick
        + ' towerHp=' + (stT.structures[tower.id] ? stT.structures[tower.id].hp : 'dead'));

    // (b) building footprints are solid: a unit ordered through the ConYard
    // slides around it and never ends inside
    var stM = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 13 });
    addStructure(stM, 'SH-01', 0, 20, 20);
    var uM = addUnit(stM, 'EG-01', 0, 17 * 64, 21 * 64 + 32);
    tick(stM, [{ player: 0, type: 'move', unitIds: [uM.id], x: 26 * 64, y: 24 * 64 + 32 }]);
    for (var iM = 0; iM < 600 && stM.units[uM.id].order.type === 'move'; iM++) tick(stM);
    var fin = stM.units[uM.id];
    var fcX = Math.floor(fin.x / 64), fcY = Math.floor(fin.y / 64);
    var insideFp = fcX >= 20 && fcX < 23 && fcY >= 20 && fcY < 23;
    var arrived = Math.abs(fin.x - 26 * 64) <= 2 * 64
      && Math.abs(fin.y - (24 * 64 + 32)) <= 2 * 64;
    __check('unit-skirts-building', !insideFp && arrived, 'end=' + fcX + ',' + fcY);

    // (c) cancelProduction: tail-cancel a queued structure, full refund
    var stR = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 17 });
    addStructure(stR, 'SH-01', 0, 8, 8);
    var pR = stR.players[0];
    pR.credits = 5000;
    tick(stR, [{ player: 0, type: 'buildStructure', structId: 'SH-02' }]);
    tick(stR, [{ player: 0, type: 'cancelProduction', kind: 'struct', structId: 'SH-02' }]);
    __check('cancel-struct-refund', pR.credits === 5000 && pR.buildQueue.length === 0,
      'credits=' + pR.credits + ' queue=' + pR.buildQueue.length);

    // (d) faction ability gate: saka_insertion needs a standing SH-12
    var stA2 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 19 });
    addStructure(stA2, 'SH-01', 0, 8, 8);
    tick(stA2);
    var abNo = validateCommand(stA2, { player: 0, type: 'useFactionAbility', x: 10 * 64, y: 10 * 64 });
    var gateRejected = !abNo.ok && abNo.reason === 'no-unique';
    addStructure(stA2, 'SH-12', 0, 14, 8);
    tick(stA2);
    var abYes = validateCommand(stA2, { player: 0, type: 'useFactionAbility', x: 10 * 64, y: 10 * 64 });
    __check('ability-gate-unique', gateRejected && abYes.ok,
      'without=' + abNo.reason + ' with=' + (abYes.ok ? 'ok' : abYes.reason));

    // (e) data-driven tech field: every faction keeps a cheap (tech 0) roster
    // incl. infantry + engineer; a tech-1 unit is gated without SH-08
    var factionsOk = true, fDetail = [];
    for (var fname in g.data.factions) {
      var t0u = g.data.units.filter(function (u) { return u.faction === fname && u.tech === 0; });
      var infN = t0u.filter(function (u) { return isInfantryCls(u.cls) && u.cls !== 'Engineer'; }).length;
      var engN = t0u.filter(function (u) { return u.cls === 'Engineer'; }).length;
      if (t0u.length < 4 || infN < 1 || engN < 1) factionsOk = false;
      fDetail.push(fname + '=' + t0u.length + '/' + infN + '/' + engN);
    }
    var stG2 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 23 });
    addStructure(stG2, 'SH-01', 0, 8, 8);
    addStructure(stG2, 'SH-05', 0, 12, 8);
    stG2.players[0].credits = 100000;
    var noTech = validateCommand(stG2, { player: 0, type: 'trainUnit', unitId: 'EG-13' });
    var gateOk = !noTech.ok && noTech.reason === 'tech-gate';
    addStructure(stG2, 'SH-08', 0, 16, 8);
    var withTech = validateCommand(stG2, { player: 0, type: 'trainUnit', unitId: 'EG-13' });
    __check('tech-field-gate', factionsOk && gateOk && withTech.ok,
      fDetail.join(' ') + ' | without=' + noTech.reason + ' with=' + (withTech.ok ? 'ok' : withTech.reason));

    // (w1) spawn cells never land inside a structure footprint, even boxed in
    var stS3 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 41 });
    var wf3 = addStructure(stS3, 'SH-05', 0, 20, 20);
    addStructure(stS3, 'SH-02', 0, 17, 20); addStructure(stS3, 'SH-02', 0, 23, 20);
    addStructure(stS3, 'SH-02', 0, 20, 17); addStructure(stS3, 'SH-02', 0, 20, 23);
    addStructure(stS3, 'SH-02', 0, 17, 17); addStructure(stS3, 'SH-02', 0, 23, 17);
    addStructure(stS3, 'SH-02', 0, 17, 23); addStructure(stS3, 'SH-02', 0, 23, 23);
    var spawnOk = true, spawnDetail = '';
    for (var iS = 0; iS < 20 && spawnOk; iS++) {
      var cell = findSpawnCell(stS3, 0, stS3.unitDefs['EG-01'], structCenter(wf3));
      if (!cell) { spawnOk = false; spawnDetail = 'no cell at i=' + iS; break; }
      var nu = addUnit(stS3, 'EG-01', 0, cell.x, cell.y);
      var ncx = Math.floor(nu.x / 64), ncy = Math.floor(nu.y / 64);
      for (var idS in stS3.structures) {
        var ss = stS3.structures[idS];
        if (ncx >= ss.cx && ncx < ss.cx + ss.fp && ncy >= ss.cy && ncy < ss.cy + ss.fp) {
          spawnOk = false; spawnDetail = 'unit ' + iS + ' at ' + ncx + ',' + ncy + ' inside ' + ss.defId;
          break;
        }
      }
    }
    __check('spawn-not-in-footprint', spawnOk, spawnDetail);

    // (w2) own-unit pick radius covers ~0.6 cell (small units stay clickable)
    var pu = null;
    for (var idP in stS3.units) { if (stS3.units[idP].owner === 0) { pu = stS3.units[idP]; break; } }
    var pickG = { state: stS3, playerSlot: 0 };
    var hit = pu && pickOwnAt(pickG, pu.x + 32, pu.y); // 0.5 cell off center
    __check('pick-radius-06-cell', !!hit && !!stS3.units[hit.id],
      hit ? ('picked unit ' + hit.id) : 'null');

    // (w3) double-ConYard guard: deploy rejected with CY standing; rebuild
    // rejected while the MCV lives; legal only with neither + rebuild unused
    var stC3 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 43 });
    var mcv3 = null;
    for (var idC in stC3.units) {
      if (stC3.units[idC].owner === 0 && stC3.units[idC].defId === 'MCV') mcv3 = stC3.units[idC];
    }
    stC3.players[0].credits = 100000;
    var depOk0 = validateCommand(stC3, { player: 0, type: 'deployMCV', unitId: mcv3.id });
    addStructure(stC3, 'SH-01', 0, 8, 8);
    var depNo = validateCommand(stC3, { player: 0, type: 'deployMCV', unitId: mcv3.id });
    var rbNo = validateCommand(stC3, { player: 0, type: 'buildStructure', structId: 'SH-01' });
    for (var idC2 in stC3.structures) {
      if (stC3.structures[idC2].owner === 0 && stC3.structures[idC2].defId === 'SH-01') {
        delete stC3.structures[idC2];
      }
    }
    var rbMcv = validateCommand(stC3, { player: 0, type: 'buildStructure', structId: 'SH-01' });
    delete stC3.units[mcv3.id]; // MCV gone too -> rebuild legal (no tick, no elimination)
    var rbYes = validateCommand(stC3, { player: 0, type: 'buildStructure', structId: 'SH-01' });
    __check('double-cy-guard',
      depOk0.ok && !depNo.ok && depNo.reason === 'cy-exists'
        && !rbNo.ok && rbNo.reason === 'cy-exists'
        && !rbMcv.ok && rbMcv.reason === 'mcv-alive'
        && rbYes.ok,
      'dep0=' + depOk0.ok + ' depNo=' + depNo.reason + ' rbNo=' + rbNo.reason
        + ' rbMcv=' + rbMcv.reason + ' rbYes=' + (rbYes.ok ? 'ok' : rbYes.reason));

    // (w4) engineer capture: channel ~20 ticks in range -> ownership flips
    var stCap = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 47 });
    addStructure(stCap, 'SH-01', 0, 8, 8);
    var enemy = addStructure(stCap, 'SH-02', 1, 14, 14);
    var eng = addUnit(stCap, 'EG-04', 0, 15 * 64 + 32, 16 * 64 + 32);
    tick(stCap, [{ player: 0, type: 'attackTarget', unitIds: [eng.id], targetId: enemy.id }]);
    var capAt = -1;
    for (var iCap = 0; iCap < 80; iCap++) {
      tick(stCap);
      if (stCap.structures[enemy.id] && stCap.structures[enemy.id].owner === 0) {
        capAt = stCap.tick; break;
      }
    }
    __check('engineer-capture', capAt > 0, 'capturedAt=' + capAt);

    // (w5) naval yard disabled on a waterless map, available on a wet one
    var dryMap = JSON.parse(JSON.stringify(g.maps.duel));
    for (var iT2 = 0; iT2 < dryMap.terrain.length; iT2++) dryMap.terrain[iT2] = 0;
    var stDry = createMatch({ data: g.data, map: dryMap,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 53 });
    addStructure(stDry, 'SH-01', 0, 8, 8);
    stDry.players[0].credits = 100000;
    var navDry = structureButtonState(stDry, stDry.players[0], 'SH-07');
    var stWet = createMatch({ data: g.data, map: g.maps.coast,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 53 });
    addStructure(stWet, 'SH-01', 0, 8, 8);
    stWet.players[0].credits = 100000;
    var navWet = structureButtonState(stWet, stWet.players[0], 'SH-07');
    __check('dry-map-naval-disabled',
      !navDry.enabled && navDry.reason === 'no-water' && navWet.enabled,
      'dry=' + navDry.reason + ' wet=' + (navWet.enabled ? 'ok' : navWet.reason));

    // (w6) AI rebuilds a lost ConYard through the human rebuild path (kept
    // alive meanwhile by the elimination rebuild window)
    var aiCfg2 = [{ slot: 0, faction: 'Egypt' },
      { slot: 1, faction: 'Algeria', ai: { personality: 'Front', difficulty: 'recruit' } }];
    var stA3 = createMatch({ data: g.data, map: g.maps.duel, players: aiCfg2, seed: 59 });
    var aiH3 = createAI(aiCfg2, 59);
    for (var iA3 = 0; iA3 < 200 && !stA3.over; iA3++) tick(stA3, aiCommands(stA3, aiH3));
    addStructure(stA3, 'SH-05', 1, 30, 30); // Prod anchor: placement + rebuild window
    stA3.players[1].credits = 100000;
    for (var idA3 in stA3.structures) {
      if (stA3.structures[idA3].owner === 1 && stA3.structures[idA3].defId === 'SH-01') {
        delete stA3.structures[idA3];
      }
    }
    for (var idA4 in stA3.units) {
      if (stA3.units[idA4].owner === 1 && stA3.units[idA4].defId === 'MCV') delete stA3.units[idA4];
    }
    var rebuilt = false, elimEarly = false;
    for (var iA5 = 0; iA5 < 4000 && !stA3.over; iA5++) {
      tick(stA3, aiCommands(stA3, aiH3));
      if (stA3.players[1].eliminated) { elimEarly = true; break; }
      var hasCy3 = false;
      for (var idA6 in stA3.structures) {
        if (stA3.structures[idA6].owner === 1 && stA3.structures[idA6].defId === 'SH-01') hasCy3 = true;
      }
      if (hasCy3) { rebuilt = true; break; }
    }
    __check('ai-cy-rebuild', rebuilt && !elimEarly,
      'rebuilt=' + rebuilt + ' elimEarly=' + elimEarly + ' tick=' + stA3.tick);

    // ---- v0.3.1 WAVE-2: grid pathfinding ------------------------------------

    // (p1) path-around-building: ConYard directly between unit and destination
    // — unit arrives without ever entering the footprint, in bounded ticks
    var stP1 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 61 });
    addStructure(stP1, 'SH-01', 0, 14, 14); // fp 3: cells 14..16 x 14..16
    var uP1 = addUnit(stP1, 'EG-01', 0, 10 * 64 + 32, 15 * 64 + 32);
    tick(stP1, [{ player: 0, type: 'move', unitIds: [uP1.id], x: 20 * 64 + 32, y: 15 * 64 + 32 }]);
    var insideP1 = false;
    for (var iP1 = 0; iP1 < 600 && stP1.units[uP1.id].order.type === 'move'; iP1++) {
      tick(stP1);
      var qx1 = Math.floor(stP1.units[uP1.id].x / 64);
      var qy1 = Math.floor(stP1.units[uP1.id].y / 64);
      if (qx1 >= 14 && qx1 < 17 && qy1 >= 14 && qy1 < 17) insideP1 = true;
    }
    var fin1 = stP1.units[uP1.id];
    __check('path-around-building',
      fin1.order.type !== 'move' && !insideP1
        && Math.abs(fin1.x - (20 * 64 + 32)) <= 32 && Math.abs(fin1.y - (15 * 64 + 32)) <= 32,
      'ticks=' + stP1.tick + ' insideFp=' + insideP1 + ' end='
        + Math.floor(fin1.x / 64) + ',' + Math.floor(fin1.y / 64));

    // (p2) path-through-sinai-pass: across the mountain spine (rock rows 44-51,
    // passes at x 22-25 and 70-73) — waypoints all on open cells, unit crosses
    // the spine inside a pass and reaches the far side within a generous bound
    var stP2 = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 67 });
    var uP2 = addUnit(stP2, 'EG-01', 0, 12 * 64 + 32, 40 * 64 + 32);
    tick(stP2, [{ player: 0, type: 'move', unitIds: [uP2.id], x: 12 * 64 + 32, y: 56 * 64 + 32 }]);
    var wps = stP2.units[uP2.id].path;
    var pathBad = !wps || !wps.length;
    if (wps) {
      for (var iW = 0; iW < wps.length; iW++) {
        var wx2 = wps[iW] % stP2.map.w, wy2 = (wps[iW] / stP2.map.w) | 0;
        if (stP2.map.terrain[wy2 * stP2.map.w + wx2] !== 0) { pathBad = true; break; }
      }
    }
    var arrived2 = false, passOk = true;
    for (var iP2 = 0; iP2 < 3000; iP2++) {
      tick(stP2);
      var f2 = stP2.units[uP2.id];
      var qx2 = Math.floor(f2.x / 64), qy2 = Math.floor(f2.y / 64);
      if (qy2 >= 44 && qy2 <= 51
        && !((qx2 >= 22 && qx2 <= 25) || (qx2 >= 70 && qx2 <= 73))) passOk = false;
      if (f2.order.type !== 'move') {
        arrived2 = Math.abs(f2.x - (12 * 64 + 32)) <= 32 && Math.abs(f2.y - (56 * 64 + 32)) <= 32;
        break;
      }
    }
    __check('path-through-sinai-pass', !pathBad && arrived2 && passOk,
      'pathBad=' + pathBad + ' arrived=' + arrived2 + ' passOk=' + passOk
        + ' ticks=' + stP2.tick + ' waypoints=' + (wps ? wps.length : 'none'));

    // (p3) unstick: ringed by friendly units in a structure pocket, ordered
    // out — units are soft obstacles, so it must escape within a bound
    var stP3 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 71 });
    addStructure(stP3, 'SH-02', 0, 13, 13); // fp 3: 13..15
    addStructure(stP3, 'SH-02', 0, 17, 13); // fp 3: 17..19 — pocket at col 16
    var uP3 = addUnit(stP3, 'EG-01', 0, 16 * 64 + 32, 14 * 64 + 32);
    for (var iU = 0; iU < 8; iU++) {
      var ang = iU * Math.PI / 4;
      addUnit(stP3, 'EG-01', 0,
        16 * 64 + 32 + Math.round(40 * Math.cos(ang)),
        14 * 64 + 32 + Math.round(40 * Math.sin(ang)));
    }
    tick(stP3, [{ player: 0, type: 'move', unitIds: [uP3.id], x: 16 * 64 + 32, y: 20 * 64 + 32 }]);
    var out3 = false;
    for (var iP3 = 0; iP3 < 300; iP3++) {
      tick(stP3);
      var f3 = stP3.units[uP3.id];
      if (f3.order.type !== 'move') {
        out3 = Math.abs(f3.x - (16 * 64 + 32)) <= 32 && Math.abs(f3.y - (20 * 64 + 32)) <= 32;
        break;
      }
    }
    __check('unstick-crowd-escape', out3, 'escaped=' + out3 + ' ticks=' + stP3.tick);

    // (p4) perf + determinism: two identical 6000-tick veteran 2-AI matches —
    // identical checksums, and wall-clock stays bounded with a ~100-unit war.
    // (With working pathfinding waves actually connect: matches end by
    // elimination well before tick 6000, so ~90+ built is the populated
    // battlefield this check is for.)
    function aiMatchRun() {
      var cfg = [{ slot: 0, faction: 'Egypt', ai: { personality: 'Front', difficulty: 'veteran' } },
        { slot: 1, faction: 'Israel', ai: { personality: 'Fortress', difficulty: 'veteran' } }];
      var st = createMatch({ data: g.data, map: g.maps.duel, players: cfg, seed: 31337 });
      var ai = createAI(cfg, 31337);
      var t0 = Date.now();
      for (var i = 0; i < 6000 && !st.over; i++) tick(st, aiCommands(st, ai));
      return { st: st, ms: Date.now() - t0 };
    }
    var rA = aiMatchRun(), rB = aiMatchRun();
    var builtPf = rA.st.players[0].unitsBuilt + rA.st.players[1].unitsBuilt;
    __check('path-ai-determinism', checksum(rA.st) === checksum(rB.st),
      'A=' + checksum(rA.st) + ' B=' + checksum(rB.st));
    __check('pathfinding-perf-6000t',
      Math.max(rA.ms, rB.ms) < 20000 && builtPf >= 80 && rA.st.tick >= 4000,
      'ms=' + rA.ms + '/' + rB.ms + ' built=' + builtPf + ' tick=' + rA.st.tick);

    // ---- v0.3.2 WAVE-3 checks -------------------------------------------------

    // (w1) wet-map spawns have water within Chebyshev 8 (gen_maps guarantee)
    var waterOk = true, waterBad = [];
    ['coast', 'tigris', 'hormuz'].forEach(function (mn) {
      var mp = g.maps[mn];
      mp.spawns.forEach(function (sp) {
        var found = false;
        for (var dyw = -8; dyw <= 8 && !found; dyw++) {
          for (var dxw = -8; dxw <= 8 && !found; dxw++) {
            var cxw = sp.x + dxw, cyw = sp.y + dyw;
            if (cxw < 0 || cyw < 0 || cxw >= mp.w || cyw >= mp.h) continue;
            if (mp.terrain[cyw * mp.w + cxw] === 2) found = true;
          }
        }
        if (!found) { waterOk = false; waterBad.push(mn + '@' + sp.x + ',' + sp.y); }
      });
    });
    __check('water-near-spawn', waterOk, waterBad.join(';') || 'all spawns wet');

    // (w2) naval yard placeable near a coast spawn through the real rules
    // (water adjacency + build radius from an owned structure)
    var stW2 = createMatch({ data: g.data, map: g.maps.coast,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 91 });
    addStructure(stW2, 'SH-01', 0, 12, 12);
    var nySpot = findPlacement(stW2, 0, stW2.structDefs['SH-07'], 14, 14, 14);
    __check('ny-placeable-near-spawn', !!nySpot,
      nySpot ? ('spot=' + nySpot.x + ',' + nySpot.y) : 'no legal SH-07 spot near spawn');

    // (w3) rebuild window: an owned structure keeps the player alive at 0
    // credits; the one SH-01 rebuild validates, builds, places next to ANY
    // owned structure; a second CY loss with the rebuild spent = elimination
    var stW3 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 97 });
    for (var idm3 in stW3.units) { // player 0 has no MCV fallback
      if (stW3.units[idm3].owner === 0) delete stW3.units[idm3];
    }
    addStructure(stW3, 'SH-01', 0, 10, 10);
    addStructure(stW3, 'SH-04', 0, 20, 10); // the anchor that keeps p0 alive
    stW3.players[0].credits = 0;
    var cyW3 = null;
    for (var idc3 in stW3.structures) {
      if (stW3.structures[idc3].owner === 0 && stW3.structures[idc3].defId === 'SH-01') cyW3 = stW3.structures[idc3];
    }
    dealDamage(stW3, cyW3, 999999, null);
    tick(stW3);
    var survivedW3 = !stW3.players[0].eliminated;
    stW3.players[0].credits = 5000;
    var vRebuild = validateCommand(stW3, { player: 0, type: 'buildStructure', structId: 'SH-01' });
    var placedW3 = false;
    if (vRebuild.ok) {
      tick(stW3, [{ player: 0, type: 'buildStructure', structId: 'SH-01' }]);
      var q3 = stW3.players[0].buildQueue[0];
      if (q3) q3.progress = q3.total; // fast-forward the build
      tick(stW3);
      var spotW3 = findPlacement(stW3, 0, stW3.structDefs['SH-01'], 21, 11, 8);
      if (spotW3) {
        var vPlace3 = validateCommand(stW3, { player: 0, type: 'placeStructure',
          structId: 'SH-01', cx: spotW3.x, cy: spotW3.y });
        if (vPlace3.ok) {
          tick(stW3, [{ player: 0, type: 'placeStructure', structId: 'SH-01', cx: spotW3.x, cy: spotW3.y }]);
          placedW3 = stW3.players[0].cyRebuilt === true;
        }
      }
    }
    var elimW3 = false;
    if (placedW3) {
      stW3.players[0].credits = 0;
      var cyW3b = null;
      for (var idc4 in stW3.structures) {
        if (stW3.structures[idc4].owner === 0 && stW3.structures[idc4].defId === 'SH-01') cyW3b = stW3.structures[idc4];
      }
      dealDamage(stW3, cyW3b, 999999, null);
      tick(stW3);
      elimW3 = stW3.players[0].eliminated === true;
    }
    __check('rebuild-window', survivedW3 && vRebuild.ok && placedW3 && elimW3,
      'survived=' + survivedW3 + ' validate=' + (vRebuild.ok ? 'ok' : vRebuild.reason)
        + ' placed=' + placedW3 + ' elimAfterRebuild=' + elimW3);

    // (w4) eliminated players' structures go neutral: attackable by anyone,
    // capturable by an engineer (3 players so the match stays live)
    var stW4 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' },
        { slot: 2, faction: 'Israel' }], seed: 103 });
    for (var idm4 in stW4.units) {
      if (stW4.units[idm4].owner !== 2) delete stW4.units[idm4]; // only p2 keeps an MCV
    }
    addStructure(stW4, 'SH-01', 1, 30, 30);
    var raxW4 = addStructure(stW4, 'SH-04', 1, 40, 30);
    stW4.players[1].credits = 0;
    stW4.players[1].cyRebuilt = true; // rebuild spent: the barracks no longer saves them
    var cyW4 = null;
    for (var idc5 in stW4.structures) {
      if (stW4.structures[idc5].owner === 1 && stW4.structures[idc5].defId === 'SH-01') cyW4 = stW4.structures[idc5];
    }
    dealDamage(stW4, cyW4, 999999, null);
    tick(stW4);
    var neutralOk = stW4.players[1].eliminated && !stW4.over
      && stW4.structures[raxW4.id].owner === -1;
    var tankW4 = addUnit(stW4, 'EG-06', 0, 38 * 64 + 32, 34 * 64 + 32);
    tick(stW4, [{ player: 0, type: 'attackTarget', unitIds: [tankW4.id], targetId: raxW4.id }]);
    var hp0W4 = stW4.structures[raxW4.id].hp;
    for (var iA4 = 0; iA4 < 40; iA4++) tick(stW4);
    var hp1W4 = stW4.structures[raxW4.id] ? stW4.structures[raxW4.id].hp : 0;
    tick(stW4, [{ player: 0, type: 'stop', unitIds: [tankW4.id] }]); // scratch, don't kill
    var attackedOk = stW4.structures[raxW4.id] && hp1W4 < hp0W4;
    var engW4 = addUnit(stW4, 'EG-04', 0, 43 * 64 + 32, 34 * 64 + 32);
    tick(stW4, [{ player: 0, type: 'attackTarget', unitIds: [engW4.id], targetId: raxW4.id }]);
    for (var iC4 = 0; iC4 < 200 && stW4.structures[raxW4.id].owner !== 0; iC4++) tick(stW4);
    var capOk = stW4.structures[raxW4.id].owner === 0;
    __check('neutral-attack-capture', neutralOk && attackedOk && capOk,
      'neutral=' + neutralOk + ' hp=' + hp0W4 + '->' + hp1W4 + ' captured=' + capOk);

    // (w5) passGrid cache: one build per (tick, structVersion), hit returns the
    // same array, contents match a fresh grid, structure add invalidates
    var stW5 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 107 });
    var c5a = passGridCached(stW5, 'Land');
    var c5b = passGridCached(stW5, 'Land');
    var fresh5 = passGrid(stW5, 'Land');
    var sameContent5 = fresh5.length === c5a.length;
    for (var iG5 = 0; sameContent5 && iG5 < fresh5.length; iG5++) {
      if (fresh5[iG5] !== c5a[iG5]) sameContent5 = false;
    }
    var builds1 = stW5._gridCache.builds === 1 && c5a === c5b;
    addStructure(stW5, 'SH-09', 0, 30, 30); // bumps structVersion
    var c5c = passGridCached(stW5, 'Land');
    var rebuild5 = stW5._gridCache.builds === 2 && c5c !== c5a
      && c5c[30 * stW5.map.w + 30] === 0;
    __check('passgrid-cache', builds1 && sameContent5 && rebuild5,
      'builds=' + stW5._gridCache.builds + ' sameContent=' + sameContent5 + ' rebuild=' + rebuild5);

    // (w6) checksum covers the capture channel and path progress
    function fresh109() {
      var st = createMatch({ data: g.data, map: g.maps.duel,
        players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 109 });
      tick(st);
      return st;
    }
    var stW6a = fresh109(), stW6b = fresh109(), stW6c = fresh109();
    var firstU = function (st) {
      for (var id in st.units) return st.units[id];
      return null;
    };
    var ub6 = firstU(stW6b); ub6.capTicks = 5; ub6.capTargetId = 999;
    var uc6 = firstU(stW6c); uc6.path = [1, 2, 3]; uc6.pathI = 1;
    var capDiff = checksum(stW6a) !== checksum(stW6b);
    var pathDiff = checksum(stW6a) !== checksum(stW6c);
    __check('checksum-capture-path', capDiff && pathDiff,
      'capDiff=' + capDiff + ' pathDiff=' + pathDiff);

    // (w7) default rally with a producer boxed on two sides: the unit gets a
    // move order to a passable cell (or stays unrallied when truly boxed in)
    var stW7 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 113 });
    var rax7 = addStructure(stW7, 'SH-04', 0, 20, 20);
    addStructure(stW7, 'SH-09', 0, 18, 20); // west wall (fp 2)
    addStructure(stW7, 'SH-09', 0, 23, 20); // east wall
    rax7.queue.push({ unitId: 'EG-01', progress: 1, total: 1 });
    tick(stW7);
    var nu7 = null;
    for (var id7 in stW7.units) {
      var uu7 = stW7.units[id7];
      if (uu7.owner === 0 && uu7.defId === 'EG-01') nu7 = uu7;
    }
    var rallyOk7 = false, rallyInfo7 = 'no-unit-spawned';
    if (nu7) {
      if (nu7.order.type !== 'move') { rallyOk7 = true; rallyInfo7 = 'unrallied (none found)'; }
      else {
        var rcx7 = Math.floor(nu7.order.x / 64), rcy7 = Math.floor(nu7.order.y / 64);
        var terrOk7 = stW7.map.terrain[rcy7 * stW7.map.w + rcx7] === 0;
        var inFp7 = false;
        for (var ids7 in stW7.structures) {
          var so7 = stW7.structures[ids7];
          if (rcx7 >= so7.cx && rcx7 < so7.cx + so7.fp && rcy7 >= so7.cy && rcy7 < so7.cy + so7.fp) inFp7 = true;
        }
        rallyOk7 = terrOk7 && !inFp7;
        rallyInfo7 = 'rally=' + rcx7 + ',' + rcy7 + ' terrOk=' + terrOk7 + ' inFp=' + inFp7;
      }
    }
    __check('default-rally-boxed', rallyOk7, rallyInfo7);

    // (w8) AI on a wet map: builds the naval yard after tech and launches ships
    var cfgW8 = [{ slot: 0, faction: 'Egypt' },
      { slot: 1, faction: 'Algeria', ai: { personality: 'Front', difficulty: 'recruit' } }];
    var stW8 = createMatch({ data: g.data, map: g.maps.coast, players: cfgW8, seed: 127 });
    var aiW8 = createAI(cfgW8, 127);
    for (var iN8 = 0; iN8 < 9000 && !stW8.over; iN8++) tick(stW8, aiCommands(stW8, aiW8));
    var pW8 = stW8.players[1];
    var yardOk8 = pW8.ready.indexOf('SH-07') >= 0
      || pW8.buildQueue.some(function (q) { return q.structId === 'SH-07'; })
      || Object.values(stW8.structures).some(function (s) { return s.owner === 1 && s.defId === 'SH-07'; });
    var seaCount8 = 0;
    for (var idU8 in stW8.units) {
      var uU8 = stW8.units[idU8];
      if (uU8.owner === 1 && stW8.unitDefs[uU8.defId].domain === 'Sea') seaCount8++;
    }
    __check('ai-naval-wet', yardOk8 && seaCount8 >= 1,
      'yard=' + yardOk8 + ' seaUnits=' + seaCount8 + ' tick=' + stW8.tick + ' over=' + stW8.over);

    // (w9) dry-map control: the AI never queues the naval yard on duel
    var stW9 = createMatch({ data: g.data, map: g.maps.duel, players: cfgW8, seed: 131 });
    var aiW9 = createAI(cfgW8, 131);
    var yardSeen9 = false;
    for (var iD9 = 0; iD9 < 6000 && !stW9.over; iD9++) {
      tick(stW9, aiCommands(stW9, aiW9));
      if (!yardSeen9) {
        yardSeen9 = stW9.players[1].ready.indexOf('SH-07') >= 0
          || stW9.players[1].buildQueue.some(function (q) { return q.structId === 'SH-07'; })
          || Object.values(stW9.structures).some(function (s) { return s.owner === 1 && s.defId === 'SH-07'; });
      }
    }
    __check('ai-naval-dry-never', !yardSeen9, 'yardSeen=' + yardSeen9 + ' tick=' + stW9.tick);

    // (w10) next waypoint blocked by a brand-new structure -> immediate repath
    var stW10 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 137 });
    var uW10 = addUnit(stW10, 'EG-01', 0, 10 * 64 + 32, 10 * 64 + 32);
    tick(stW10, [{ player: 0, type: 'move', unitIds: [uW10.id], x: 40 * 64 + 32, y: 10 * 64 + 32 }]);
    var u10 = stW10.units[uW10.id];
    var oldPath10 = u10.path ? u10.path.slice() : [];
    var next10 = u10.path && u10.pathI < u10.path.length ? u10.path[u10.pathI] : null;
    var repathOk10 = false, repathInfo10 = 'no-path';
    if (next10 !== null && oldPath10.length) {
      var ncx10 = next10 % stW10.map.w, ncy10 = (next10 / stW10.map.w) | 0;
      addStructure(stW10, 'SH-09', 0, ncx10, ncy10); // fp 2 covers the waypoint cell
      tick(stW10);
      var newPath10 = stW10.units[uW10.id].path;
      var differs = !newPath10 || newPath10.length !== oldPath10.length;
      if (newPath10 && !differs) {
        for (var iP10 = 0; iP10 < newPath10.length; iP10++) {
          if (newPath10[iP10] !== oldPath10[iP10]) { differs = true; break; }
        }
      }
      repathOk10 = !!newPath10 && differs;
      repathInfo10 = 'old=' + oldPath10.length + ' new=' + (newPath10 ? newPath10.length : 'null')
        + ' differs=' + differs;
    }
    __check('next-waypoint-repath', repathOk10, repathInfo10);

    // (w11) UAE roster patch (export_data BALANCE_ADDITIONS): >= 8 tech-0 units
    // incl. an AA answer, so the explicit tech-0 gate can't starve them
    var uaeAll = g.data.units.filter(function (u) { return u.faction === 'UAE'; });
    var uaeT0 = uaeAll.filter(function (u) { return u.tech !== undefined ? u.tech === 0 : u.cost < 1400; });
    var uaeAA = uaeT0.filter(function (u) { return (u.dmg && u.dmg.air > 0) || u.cls === 'Mobile AA'; });
    __check('uae-roster', uaeT0.length >= 8 && uaeAA.length >= 1,
      'uae=' + uaeAll.length + ' t0=' + uaeT0.length + ' aa=' + uaeAA.length);

    // (f) harvester economy: kill the HARV -> depot income stops; retrain at
    // the War Factory -> income resumes
    var stH2 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 29 });
    addStructure(stH2, 'SH-01', 0, 8, 8);
    var pH = stH2.players[0];
    pH.credits = 20000;
    var depSpot = findDepotPlacement(stH2, 0, stH2.structDefs['SH-03']);
    tick(stH2, [{ player: 0, type: 'buildStructure', structId: 'SH-03' }]);
    for (var iB = 0; iB < 90; iB++) tick(stH2);
    tick(stH2, [{ player: 0, type: 'placeStructure', structId: 'SH-03', cx: depSpot.x, cy: depSpot.y }]);
    tick(stH2);
    var dep = null;
    for (var idH in stH2.structures) {
      if (stH2.structures[idH].owner === 0 && stH2.structures[idH].defId === 'SH-03') dep = stH2.structures[idH];
    }
    var hvAlive = dep && stH2.units[dep.harvesterId];
    var cA = pH.credits;
    for (var iW = 0; iW < 200; iW++) tick(stH2);
    var incAlive = pH.credits - cA;
    delete stH2.units[dep.harvesterId];
    var cD = pH.credits;
    for (var iW2 = 0; iW2 < 60; iW2++) tick(stH2);
    var incDead = pH.credits - cD;
    addStructure(stH2, 'SH-05', 0, 12, 8);
    tick(stH2, [{ player: 0, type: 'trainUnit', unitId: 'HARV' }]);
    var cR = pH.credits;
    for (var iW3 = 0; iW3 < 400; iW3++) tick(stH2);
    var incResumed = pH.credits - cR;
    __check('harv-income-stop-resume',
      !!hvAlive && incAlive > 0 && incDead === 0 && incResumed > 0,
      'alive=' + incAlive + ' dead=' + incDead + ' resumed=' + incResumed);

    // (g) engineer repair: idle engineer heals a damaged ConYard
    var stE2 = createMatch({ data: g.data, map: g.maps.duel,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 31 });
    var cyE = addStructure(stE2, 'SH-01', 0, 8, 8);
    cyE.hp = Math.floor(cyE.maxHp / 2);
    addUnit(stE2, 'EG-04', 0, 10 * 64 + 32, 10 * 64 + 32);
    var hp0 = cyE.hp;
    for (var iE = 0; iE < 100; iE++) tick(stE2);
    var cyAfter = stE2.structures[cyE.id];
    __check('engineer-repairs', !!cyAfter && cyAfter.hp > hp0,
      hp0 + ' -> ' + (cyAfter ? cyAfter.hp : 'destroyed'));

    // (h) AI expansion: recruit Front claims a second oil field by tick 6000
    var aiCfg = [{ slot: 0, faction: 'Egypt' },
      { slot: 1, faction: 'Algeria', ai: { personality: 'Front', difficulty: 'recruit' } }];
    var stAI = createMatch({ data: g.data, map: g.maps.duel, players: aiCfg, seed: 37 });
    var aiH = createAI(aiCfg, 37);
    for (var iAI = 0; iAI < 6000 && !stAI.over; iAI++) {
      tick(stAI, aiCommands(stAI, aiH));
    }
    var pAI = stAI.players[1];
    var depCount = pAI.buildQueue.filter(function (q) { return q.structId === 'SH-03'; }).length
      + pAI.ready.filter(function (r) { return r === 'SH-03'; }).length;
    for (var idAI in stAI.structures) {
      var sAI = stAI.structures[idAI];
      if (sAI.owner === 1 && sAI.defId === 'SH-03') depCount++;
    }
    __check('ai-second-oil', depCount >= 2, 'depots=' + depCount);

    // ---- map generalization checks -----------------------------------------

    // (i) all six maps load via the manifest, with expected spawn counts
    var expectSpawns = { duel: 2, sinai: 2, coast: 4, tigris: 4, hormuz: 6, rubalkhali: 6 };
    var mapIds = Object.keys(g.maps);
    var loadOk = mapIds.join(',') === 'duel,sinai,coast,tigris,hormuz,rubalkhali';
    var detailM = [];
    for (var mi = 0; mi < mapIds.length; mi++) {
      var md2 = g.maps[mapIds[mi]];
      var okM = md2 && expectSpawns[mapIds[mi]] === md2.spawns.length
        && md2.terrain.length === md2.w * md2.h;
      if (!okM) loadOk = false;
      detailM.push(mapIds[mi] + ':' + (md2 ? md2.spawns.length : '?'));
    }
    __check('maps-load-6', loadOk, detailM.join(' '));

    // (ii) every oil field on every map has a legal SH-03 placement within
    // 4 cells (temporary ConYard by the field satisfies the base-radius rule)
    function depotNear(st, o, def) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          if (canPlace(st, 0, def, o.x + dx, o.y + dy)) return true;
        }
      }
      return false;
    }
    var oilOk = true, oilDetail = '';
    for (var mi2 = 0; mi2 < mapIds.length; mi2++) {
      var md3 = g.maps[mapIds[mi2]];
      var stO = createMatch({ data: g.data, map: md3,
        players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 3 });
      var depotDef = stO.structDefs['SH-03'];
      for (var oi = 0; oi < md3.oil.length; oi++) {
        var oo = md3.oil[oi];
        var cyT = addStructure(stO, 'SH-01', 0,
          Math.max(0, Math.min(md3.w - 3, oo.x - 3)),
          Math.max(0, Math.min(md3.h - 3, oo.y - 3)));
        if (!depotNear(stO, oo, depotDef)) {
          oilOk = false;
          oilDetail = mapIds[mi2] + ' oil (' + oo.x + ',' + oo.y + ')';
        }
        delete stO.structures[cyT.id];
      }
    }
    __check('maps-oil-depot-spots', oilOk, oilDetail);

    // (iii) every spawn on every map can deploy its MCV (real command path)
    var spawnOk = true, spawnDetail = '';
    for (var mi3 = 0; mi3 < mapIds.length; mi3++) {
      var md4 = g.maps[mapIds[mi3]];
      var cfgs3 = md4.spawns.map(function (s, i2) {
        return { slot: i2, faction: i2 % 2 ? 'Algeria' : 'Egypt' };
      });
      var stS = createMatch({ data: g.data, map: md4, players: cfgs3, seed: 5 });
      for (var uid in stS.units) {
        var uu = stS.units[uid];
        if (uu.defId !== 'MCV') continue;
        var vv = applyCommand(stS, { player: uu.owner, type: 'deployMCV', unitId: uu.id });
        if (!vv.ok) {
          spawnOk = false;
          spawnDetail = mapIds[mi3] + ' slot ' + uu.owner + ': ' + vv.reason;
        }
      }
    }
    __check('maps-spawn-deploy', spawnOk, spawnDetail);

    // (iv) 2 players on the 6-player Empty Quarter: boots and runs 3000 ticks
    var cfgs4 = [{ slot: 0, faction: 'Egypt' },
      { slot: 1, faction: 'Algeria', ai: { personality: 'Front', difficulty: 'recruit' } }];
    var stBig = createMatch({ data: g.data, map: g.maps.rubalkhali, players: cfgs4, seed: 9 });
    var aiBig = createAI(cfgs4, 9);
    var mcvB = null;
    for (var ub in stBig.units) {
      if (stBig.units[ub].owner === 0 && stBig.units[ub].defId === 'MCV') mcvB = stBig.units[ub];
    }
    tick(stBig, [{ player: 0, type: 'deployMCV', unitId: mcvB.id }]);
    for (var iB2 = 0; iB2 < 3000 && !stBig.over; iB2++) {
      tick(stBig, aiCommands(stBig, aiBig));
    }
    var structsB = 0;
    for (var sb in stBig.structures) {
      if (stBig.structures[sb].owner === 1) structsB++;
    }
    __check('rubalkhali-2p-3000-ticks',
      (stBig.tick >= 3000 || stBig.over) && structsB >= 3 && !stBig.players[0].eliminated,
      'tick=' + stBig.tick + ' aiStructs=' + structsB + ' over=' + stBig.over);

    // journey 3: abandon (two-step) clears canvas + chrome; new match is clean
    runFrames(30);
    findBtn('topbar', 'Menu').click();
    findBtn('menu', 'Abandon match').click(); // arms the confirm
    var abBtn2 = findBtn('menu', 'Really abandon?');
    var callsBefore = g.ctx.calls;
    if (abBtn2) abBtn2.click();
    runFrames(10);
    var log = g.ctx.log, last = log.length ? log[log.length - 1] : null;
    var cleared = !!last && last[0] === 'fillRect' && last[1][0] === 0 && last[1][1] === 0
      && last[1][2] === g.canvas.width && last[1][3] === g.canvas.height;
    __check('ui-abandon-clears', !!abBtn2 && g.state === null && g.paused === false
      && g.render === null // old terrain/fog canvases dropped
      && menuVisible() && document.body.classList.contains('in-menu')
      && cleared && g.ctx.calls === callsBefore + 2, // setTransform + fillRect only
      'cleared=' + cleared + ' last=' + (last && last[0])
        + ' calls+=' + (g.ctx.calls - callsBefore));

    // new match on a different map via the setup UI
    findBtn('menu', 'Skirmish').click();
    var tigBtn = null;
    walkAll(document.getElementById('menu'), function (el) {
      if (el.tagName === 'button' && (el.textContent || '').indexOf('Tigris Crossing') === 0) {
        tigBtn = el;
      }
    });
    if (tigBtn) tigBtn.click();
    findBtn('menu', 'Start match').click();
    var cleanOk = !!g.state && g.state.map.name === 'Tigris Crossing' && g.state.tick === 0
      && g.selection.length === 0 && Object.keys(g.groups).length === 0
      && g.minimap.pings.length === 0 && Object.keys(g.state.rally).length === 0
      && !g.placement && !g.targeting && g.inspectId === 0 && g.paused === false
      && !menuVisible() && !document.body.classList.contains('in-menu');
    var errN = __smoke.errors.length;
    runFrames(200);
    __check('ui-abandon-new-match-clean', cleanOk && __smoke.errors.length === errN
      && g.state.tick > 10, 'tick=' + (g.state && g.state.tick) + ' clean=' + cleanOk);
    // render caches must be rebuilt for the NEW map (tigris 128x128), and the
    // main view must actually draw (terrain + fog drawImage every frame)
    var tail = g.ctx.log.slice(-3000);
    var draws = 0, fills = 0;
    for (var ti = 0; ti < tail.length; ti++) {
      if (tail[ti][0] === 'drawImage') draws++;
      if (tail[ti][0] === 'fillRect') fills++;
    }
    __check('ui-newmap-render-fresh',
      g.render && g.render.fog.width === 128 && g.render.fog.height === 128
        && g.render.terrain.width === 128 * 16 && g.render.fogImg.width === 128
        && draws >= 100 && fills >= 100 && g.frameErrors === 0,
      'fog=' + (g.render && g.render.fog.width)
        + ' terrain=' + (g.render && g.render.terrain.width)
        + ' draws=' + draws + ' fills=' + fills);

    // journey 4: elimination -> end banner -> Menu cleans up the same way
    // (v0.3.2 window: must strip credits AND structures, else the rebuild
    // window keeps the player alive)
    g.state.players[0].credits = 0;
    for (var idd in g.state.units) {
      if (g.state.units[idd].owner === 0) delete g.state.units[idd];
    }
    for (var ids4 in g.state.structures) {
      if (g.state.structures[ids4].owner === 0) delete g.state.structures[ids4];
    }
    g.state.structVersion++;
    runFrames(30); // eliminationSystem -> over -> banner in simStep
    var bannerEl = document.getElementById('banner');
    var bannerShown = !bannerEl.classList.contains('hidden');
    var bannerMenu = findBtn('banner', 'Menu');
    if (bannerMenu) bannerMenu.click();
    var log4 = g.ctx.log, last4 = log4[log4.length - 1];
    __check('ui-banner-menu-clears', bannerShown && g.state === null && menuVisible()
      && document.body.classList.contains('in-menu')
      && bannerEl.classList.contains('hidden')
      && last4 && last4[0] === 'fillRect' && last4[1][2] === g.canvas.width,
      'banner=' + bannerShown);

    // Esc on the setup screen = Back
    findBtn('menu', 'Skirmish').click();
    var atSetup = g.overlay === 'setup';
    handleKey(g, { code: 'Escape' }, true);
    __check('ui-esc-setup-back', atSetup && g.overlay === 'menu' && !!findBtn('menu', 'Skirmish'),
      'overlay=' + g.overlay);

    // journey 5: pause overlay -> Restart = fresh unpaused match; Esc = Resume;
    // placement cancel beats the Esc overlay handling
    findBtn('menu', 'Skirmish').click();
    findBtn('menu', 'Start match').click();
    runFrames(50);
    var oldState = g.state, oldTick = g.state.tick;
    findBtn('topbar', 'Menu').click();
    findBtn('menu', 'Restart').click();
    var freshOk = g.state !== oldState && g.state.tick === 0 && g.paused === false
      && !menuVisible() && g.overlay === null;
    runFrames(30);
    __check('ui-restart-fresh', freshOk && g.state.tick > 0,
      'oldTick=' + oldTick + ' newTick=' + g.state.tick);
    findBtn('topbar', 'Menu').click();
    handleKey(g, { code: 'Escape' }, true);
    var escResumed = g.paused === false && g.overlay === null && !menuVisible();
    g.placement = { structId: 'SH-02' };
    handleKey(g, { code: 'Escape' }, true);
    var escPlacement = g.placement === null;
    __check('ui-esc-resume-and-priority', escResumed && escPlacement,
      'escResumed=' + escResumed + ' escPlacement=' + escPlacement);

    // journey 6: zoom extremes + out-of-bounds pans never blow up the frame
    // (regression: zoom "hangs" — frame work must stay bounded)
    var zoomOk = true, zoomDetail = '';
    var zooms = [0.35, 2.5, 0.35, 2.5];
    for (var zi = 0; zi < zooms.length && zoomOk; zi++) {
      g.camera.zoom = zooms[zi];
      zoomCameraAt(g.camera, zi % 2 ? 1.1 : 0.9, 640, 400);
      g.camera.x = -600; g.camera.y = 99999; // deliberately out of bounds
      var callsZ = g.ctx.calls, tickZ = g.state.tick, errZ = __smoke.errors.length;
      runFrames(100);
      var perFrame = (g.ctx.calls - callsZ) / 100;
      if (__smoke.errors.length !== errZ || g.state.tick <= tickZ
          || perFrame > 4000 || !isFinite(g.camera.zoom) || g.frameErrors > 0) {
        zoomOk = false;
        zoomDetail = 'zoom=' + zooms[zi] + ' perFrame=' + perFrame
          + ' ticks=' + (g.state.tick - tickZ) + ' frameErr=' + g.frameErrors;
      }
    }
    __check('zoom-stress-bounded', zoomOk, zoomDetail);
    g.camera.zoom = 1;
    centerCameraOn(g.camera, 10 * 64, 10 * 64);
    clampCameraToMap(g.camera, g.state.map.w * 64, g.state.map.h * 64);

    // journey 7: pause-overlay Restart drops ALL per-match render caches
    // (regression: stale fog blob / camera from the previous match)
    var mcv7 = null;
    for (var id7 in g.state.units) {
      if (g.state.units[id7].owner === 0 && g.state.units[id7].defId === 'MCV') mcv7 = g.state.units[id7];
    }
    g.pendingCmds.push({ player: 0, type: 'move', unitIds: [mcv7.id], x: 70 * 64, y: 70 * 64 });
    runFrames(600); // roam: the seen/explored blob grows
    function seenCount(st) {
      var n2 = 0, sn = st.fog[0].seen;
      for (var si = 0; si < sn.length; si++) if (sn[si]) n2++;
      return n2;
    }
    var seenOld = seenCount(g.state);
    var oldRender = g.render, oldMmTerrain = g.minimap.terrain;
    g.openMenu();
    var restartBtn = findBtn('menu', 'Restart');
    if (restartBtn) restartBtn.click();
    runFrames(5);
    var st7 = g.state;
    var aVis = 0, aSeen = 0, aBlack = 0, px7 = g.render.fogImg.data;
    for (var pi = 3; pi < px7.length; pi += 4) {
      if (px7[pi] === 0) aVis++; else if (px7[pi] === 255) aBlack++; else aSeen++;
    }
    var sp7 = st7.map.spawns[0];
    var spx = sp7.x * 64 + 32, spy = sp7.y * 64 + 32;
    var inView = spx >= g.camera.x && spx <= g.camera.x + g.camera.viewW / g.camera.zoom
      && spy >= g.camera.y && spy <= g.camera.y + g.camera.viewH / g.camera.zoom;
    __check('fog-reset-on-restart',
      !!restartBtn && g.render !== oldRender
        && g.minimap.terrain !== oldMmTerrain && g.minimap.pings.length === 0
        && g.render.fog.width === st7.map.w && g.render.fogTick >= 0
        && seenCount(st7) < seenOld
        && aSeen === 0 && aVis > 0 && aVis + aBlack === st7.map.w * st7.map.h
        && inView && g.frameErrors === 0,
      'seenOld=' + seenOld + ' seenNew=' + seenCount(st7)
        + ' vis=' + aVis + ' seenA=' + aSeen + ' black=' + aBlack
        + ' inView=' + inView + ' pings=' + g.minimap.pings.length);

    // journey 8: two-depot economy performance (regression: 2 depots + HARV
    // shuttle must not degrade per-tick cost)
    function depotRun(nDepots) {
      var stP = createMatch({ data: g.data, map: g.maps.duel,
        players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }],
        seed: 41 });
      addStructure(stP, 'SH-01', 0, 8, 8);
      var pP = stP.players[0];
      pP.credits = 100000;
      for (var dp = 0; dp < nDepots; dp++) {
        var spotP = findDepotPlacement(stP, 0, stP.structDefs['SH-03']);
        tick(stP, [{ player: 0, type: 'buildStructure', structId: 'SH-03' }]);
        for (var bp = 0; bp < 90; bp++) tick(stP);
        tick(stP, [{ player: 0, type: 'placeStructure', structId: 'SH-03',
          cx: spotP.x, cy: spotP.y }]);
        tick(stP);
      }
      var cP0 = pP.credits, tP0 = Date.now();
      for (var tp = 0; tp < 3000; tp++) tick(stP);
      return { ms: Date.now() - tP0, income: pP.credits - cP0 };
    }
    var perf1 = depotRun(1);
    var perf2 = depotRun(2);
    __check('two-depot-perf',
      perf2.ms < 10000 && perf2.ms < Math.max(3000, perf1.ms * 4 + 1000)
        && perf2.income > perf1.income * 1.5,
      'one=' + perf1.ms + 'ms/$' + perf1.income
        + ' two=' + perf2.ms + 'ms/$' + perf2.income);
  } catch (e) {
    __smoke.errors.push('driver: ' + (e && e.stack || e));
  }
})();
JSON.stringify(__smoke);
"""


def inline(path: Path) -> str:
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"import\s+[\s\S]*?\sfrom\s*'[^']*';", "", src)
    src = re.sub(r"export\s*\{[\s\S]*?\}\s*from\s*'[^']*';", "", src)
    src = re.sub(r"^export\s+(async function|function|const|let)", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[\s\S]*?\};", "", src, flags=re.M)
    if path.name == "main.js":
        src = src.replace("Sim.", "")
    return src


def main() -> int:
    # static guard first: missing imports are masked by the inlined scope
    # (real modules throw ReferenceError — bricked the game loop once)
    from audit_imports import audit
    suspects = audit()
    for s in suspects:
        print("IMPORT-AUDIT:", s)

    bundle = "\n;\n".join(inline(CLIENT / m) for m in MODULES)
    ctx = MiniRacer()
    payload = (CLIENT / "data/game.json").read_text(encoding="utf-8")
    ctx.eval(f"var __jsonGame = {json.dumps(payload)};")
    manifest = json.loads((CLIENT / "maps/manifest.json").read_text(encoding="utf-8"))
    ctx.eval(f"var __jsonManifest = {json.dumps(json.dumps(manifest))};")
    maps_js = {mid: (CLIENT / "maps" / f"{mid}.json").read_text(encoding="utf-8")
               for mid in manifest["maps"]}
    ctx.eval(f"var __jsonMaps = {json.dumps(maps_js)};")
    ctx.eval(STUB_JS)
    ctx.eval(bundle)
    ctx.eval(DRIVER_BOOT)
    result = json.loads(ctx.eval(DRIVER_MAIN))
    passed = 0
    for c in result["checks"]:
        print(f"{'PASS' if c['pass'] else 'FAIL'}  {c['name']}  --  {c.get('detail', '')}")
        passed += 1 if c["pass"] else 0
    for e in result["errors"]:
        print("ERROR:", e)
    print(f"{passed}/{len(result['checks'])} passed")
    return 0 if passed == len(result["checks"]) and not result["errors"] and not suspects else 1


if __name__ == "__main__":
    sys.exit(main())
