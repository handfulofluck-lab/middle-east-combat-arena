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
    "src/net/lockstep.js",   # v0.10.0 lockstep scheduler (pure sim side)
    "src/net/net.js",        # v0.10.0 dormant-by-default net client
    "src/game/sprites.js",
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
  // v0.9.1: record imageSmoothingEnabled like a call so the driver can assert
  // the fog blit upscales with smoothing (plain property otherwise)
  var smoothV;
  Object.defineProperty(self, 'imageSmoothingEnabled', {
    get: function () { return smoothV; },
    set: function (nv) { smoothV = nv; self.log.push(['$imageSmoothingEnabled', nv]); },
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
  el.removeEventListener = function (t, f) {
    var l = el.listeners[t];
    if (!l) return;
    var i = l.indexOf(f);
    if (i >= 0) l.splice(i, 1);
  };
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
  // main.js's exitToMenu pops hint banners via root.lastChild — the stub must
  // emulate it or that while-loop never terminates
  Object.defineProperty(el, 'lastChild', {
    get: function () { return el.children.length ? el.children[el.children.length - 1] : null; },
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
  // v0.7.1: record document-level listeners (briefing overlay keydown) so the
  // driver can fire synthetic key events at them
  listeners: {},
  addEventListener: function (t, f) {
    (this.listeners[t] = this.listeners[t] || []).push(f);
  },
  removeEventListener: function (t, f) {
    var l = this.listeners[t];
    if (!l) return;
    var i = l.indexOf(f);
    if (i >= 0) l.splice(i, 1);
  },
};
globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
// v0.9.0: record window-level listeners (the beforeunload leave-confirmation
// check calls the captured listener directly) — the old no-op dropped them
globalThis.windowListeners = {};
globalThis.addEventListener = function (t, f) {
  (globalThis.windowListeners[t] = globalThis.windowListeners[t] || []).push(f);
};

// minimal localStorage (tutorial-seen, volume, mute/music prefs)
var __lsStore = {};
globalThis.localStorage = {
  getItem: function (k) {
    return Object.prototype.hasOwnProperty.call(__lsStore, k) ? __lsStore[k] : null;
  },
  setItem: function (k, v) { __lsStore[k] = String(v); },
  removeItem: function (k) { delete __lsStore[k]; },
};

globalThis.fetch = function (url) {
  var txt = null;
  if (url.indexOf('game.json') >= 0) txt = __jsonGame;
  else if (url.indexOf('maps/manifest.json') >= 0) txt = __jsonManifest;
  else {
    var mm = url.match(/maps\/([^\/]+)\.json/);
    if (mm && __jsonMaps[mm[1]]) txt = __jsonMaps[mm[1]];
  }
  return Promise.resolve({
    ok: !!txt, status: txt ? 200 : 404,
    json: function () { return Promise.resolve(JSON.parse(txt)); },
  });
};
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

    // setup screen: all nine maps listed; 6-player maps allow 1..5 opponents
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
          // v0.9 maps: Arabia is a 6-spawn map (Arabian Gulf also starts with
          // 'Arabia' — match the exact 'Arabia —' prefix to disambiguate)
          if ((el.textContent || '').indexOf('Arabia —') === 0) eqBtn = el;
        }
      });
    }
    __check('menu-lists-maps', mapBtnCount === Object.keys(g.maps).length, 'map buttons=' + mapBtnCount);
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

    // v0.7.2 map-picker thumbnails: with an empty art pack (headless default)
    // the map buttons stay text-only — no .map-thumb imgs
    var thumbCount0 = 0;
    walkAll(document.getElementById('menu'), function (el) {
      if (el.tagName === 'img' && (el.className || '').indexOf('map-thumb') >= 0) thumbCount0++;
    });
    __check('map-thumbs-absent-empty-pack', thumbCount0 === 0, 'thumbs=' + thumbCount0);

    // inject the thumbnail pack and re-render the setup screen: 9 thumbs,
    // and the Levant scenario button carries its briefing (line + hover title)
    g.thumbArt = {};
    Object.keys(g.maps).forEach(function (mid) {
      g.thumbArt[mid] = 'data:image/png;base64,THUMB_' + mid;
    });
    findBtn('menu', 'Back').click();
    findBtn('menu', 'Skirmish').click();
    var thumbBtns = 0, suezBrief = '', suezTitle = '';
    walkAll(document.getElementById('menu'), function (el) {
      if (el.tagName === 'img' && (el.className || '').indexOf('map-thumb') >= 0) thumbBtns++;
      if (el.tagName === 'span' && el.className === 'map-brief'
          && (el.textContent || '').indexOf('Levant: the Mediterranean coastal plain') === 0) {
        suezBrief = el.textContent;
      }
      if (el.tagName === 'button' && (el.textContent || '').indexOf('Levant') === 0) {
        suezTitle = el.title || '';
      }
    });
    __check('map-thumbs-scenario-briefing', thumbBtns === Object.keys(g.maps).length && !!suezBrief
      && suezTitle === suezBrief,
      'thumbs=' + thumbBtns + ' brief=' + !!suezBrief
        + ' titleMatch=' + (suezTitle === suezBrief && suezTitle !== ''));

    // v6 desert-military chrome: the top bar wears a gold border (css text
    // injected from client/index.html by the harness; skip if unavailable)
    var cssTxt = (typeof __indexCss === 'string') ? __indexCss : '';
    var goldTop = /#topbar\s*\{[^}]*border-bottom:\s*2px solid #c8a23a/.test(cssTxt);
    __check('chrome-gold-topbar', !cssTxt || goldTop,
      cssTxt ? ('goldRule=' + goldTop) : 'skipped: no css text');

    // journey A: start via the real setup UI (an earlier check selected Arabia
    // — click Sinai Peninsula back first: the small 4-spawn default map)
    var duelBtn = null;
    walkAll(document.getElementById('menu'), function (el) {
      if (el.tagName === 'button' && (el.textContent || '').indexOf('Sinai Peninsula') === 0) duelBtn = el;
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

    // ---- v0.9.1: input while paused is inert (pause-scouting fix) ----------
    // top-bar Pause leaves the canvas live with NO overlay: orders, drag-move
    // arming and gameplay hotkeys must not reach the sim; only Esc (pause
    // menu) and the DOM top-bar buttons stay live.
    var ownP = null;
    for (var idP in g.state.units) {
      if (g.state.units[idP].owner === 0) { ownP = g.state.units[idP]; break; }
    }
    g.selection = ownP ? [ownP.id] : [];
    g.paused = true;
    var cmdsP0 = g.pendingCmds.length;
    var cvP = document.getElementById('game');
    var fireP = function (type, ev) {
      (cvP.listeners[type] || []).forEach(function (f) { f(ev); });
    };
    var mouseP = function (x, y) { fireP('mousemove', { clientX: x, clientY: y }); };
    var emptyPtP = null;
    for (var eyP = 100; eyP < 780 && !emptyPtP; eyP += 40) {
      for (var exP = 100; exP < 1200; exP += 40) {
        var wP = screenToWorld(g.camera, exP, eyP);
        if (!pickOwnAt(g, wP.x, wP.y)) { emptyPtP = { x: exP, y: eyP }; break; }
      }
    }
    // gameplay hotkeys: attack-move arm, stop, stance cycle, zoom — all inert
    var pk = function (code) {
      return { code: code, preventDefault: function () {} };
    };
    handleKey(g, pk('KeyA'), true);
    var pNoA = !g.attackMoveArmed;
    handleKey(g, pk('KeyS'), true);
    handleKey(g, pk('KeyG'), true);
    var zP0 = g.camera.zoom;
    handleKey(g, pk('Equal'), true);
    var pNoZoom = g.camera.zoom === zP0;
    // mouse: LMB move / RMB move on empty terrain queue nothing
    mouseP(emptyPtP.x, emptyPtP.y);
    fireP('mousedown', { button: 0, preventDefault: function () {} });
    fireP('mouseup', { button: 0 });
    var pNoLmb = g.pendingCmds.length === cmdsP0;
    fireP('mousedown', { button: 2, preventDefault: function () {} });
    fireP('mouseup', { button: 2 });
    var pNoRmb = g.pendingCmds.length === cmdsP0;
    // drag-move cannot even arm while paused
    var ownScr = worldToScreen(g.camera, ownP.x, ownP.y);
    mouseP(ownScr.x, ownScr.y);
    fireP('mousedown', { button: 0, preventDefault: function () {} });
    var pNoArm = !g.dragMove;
    mouseP(ownScr.x + 60, ownScr.y + 40);
    fireP('mouseup', { button: 0 });
    var pNoDrag = !g.dragMove && g.pendingCmds.length === cmdsP0;
    // Esc still opens the pause menu; Resume (DOM) closes it
    g.selection = [];
    handleKey(g, pk('Escape'), true);
    var pEsc = g.overlay === 'pause' && g.paused === true && menuVisible();
    findBtn('menu', 'Resume').click();
    var pResumed = g.overlay === null;
    // positive control: the same click queues an order once unpaused
    g.paused = false;
    g.selection = [ownP.id];
    mouseP(emptyPtP.x, emptyPtP.y);
    fireP('mousedown', { button: 0, preventDefault: function () {} });
    fireP('mouseup', { button: 0 });
    var pLive = g.pendingCmds.length === cmdsP0 + 1;
    g.pendingCmds.length = cmdsP0; // keep the journey state untouched
    g.selection = [];
    __check('input-while-paused-inert',
      pNoA && pNoZoom && pNoLmb && pNoRmb && pNoArm && pNoDrag && pEsc
        && pResumed && pLive && g.pendingCmds.length === cmdsP0,
      'noA=' + pNoA + ' noZoom=' + pNoZoom + ' noLmb=' + pNoLmb
        + ' noRmb=' + pNoRmb + ' noArm=' + pNoArm + ' noDrag=' + pNoDrag
        + ' esc=' + pEsc + ' resumed=' + pResumed + ' liveAgain=' + pLive);

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
    // v0.4.2: canvas must have an explicit CSS size — without it the element
    // displays at backing-store size (innerWidth*dpr) and every mouse coord
    // is off by the dpr factor on scaled displays
    var cv = document.getElementById('game');
    __check('canvas-css-size-set', cv.style && cv.style.width === '1280px'
      && cv.style.height === '800px',
      'style=' + (cv.style ? cv.style.width + 'x' + cv.style.height : 'none'));

    // v0.4.3: minimap canvas attributes match the CSS box (220x180) 1:1 — a
    // mismatched attribute/CSS aspect ratio distorts the map
    __check('minimap-aspect-matches-css',
      g.minimap.canvas.width === 220 && g.minimap.canvas.height === 180,
      'attr=' + g.minimap.canvas.width + 'x' + g.minimap.canvas.height + ' css=220x180');

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

    // v0.4.3: entering/leaving placement mode must NOT rebuild the build grid
    // (a rebuild kills a hover tooltip mid-hover) — only the .placing class
    // toggles on the affected tile; the rebuild signature stays unchanged
    runFrames(5);
    var gridSig0 = g.hud.gridSig, gridKids0 = g.hud.grid.children.length;
    g.placement = { structId: 'SH-02' };
    updateHud(g);
    var gridStable = g.hud.gridSig === gridSig0
      && g.hud.grid.children.length === gridKids0;
    var placingOn = !!(g.hud.tiles['SH-02']
      && g.hud.tiles['SH-02'].el.classList.contains('placing'));
    g.placement = null;
    updateHud(g);
    var placingOff = !!(g.hud.tiles['SH-02']
      && !g.hud.tiles['SH-02'].el.classList.contains('placing'));
    __check('grid-no-rebuild-on-placement',
      gridStable && placingOn && placingOff && g.hud.gridSig === gridSig0,
      'stable=' + gridStable + ' on=' + placingOn + ' off=' + placingOff);

    // v0.4.3: build queue strip — two riflemen queued at a Barracks show as
    // chips (oldest first) with a live progress bar; right-clicking the head
    // chip pushes the tail-cancel command for that entry
    var raxQ = addStructure(g.state, 'SH-04', 0, 40, 40);
    g.state.players[0].credits = 20000;
    g.pendingCmds.push({ player: 0, type: 'trainUnit', unitId: 'EG-01' });
    g.pendingCmds.push({ player: 0, type: 'trainUnit', unitId: 'EG-01' });
    runFrames(15); // commands applied; the head entry starts progressing
    g.hud.activeTab = 'infantry'; g.hud.tabSig = '';
    g.selection = [raxQ.id];
    updateHud(g);
    var stripQ = g.hud.queue;
    var chipsQ = [], barQ = false;
    walkAll(stripQ, function (el) {
      if (el.className === 'bb-chip') chipsQ.push(el);
      if (el.className === 'bb-chip-bar'
        && el.style && el.style.width && el.style.width !== '0%'
        && el.style.width !== '') barQ = true;
    });
    __check('queue-strip-chips',
      stripQ.style.display === 'flex' && chipsQ.length === 2 && barQ,
      'display=' + stripQ.style.display + ' chips=' + chipsQ.length + ' bar=' + barQ);
    var nQC = g.pendingCmds.length;
    var ctxEvs = chipsQ.length ? (chipsQ[0].listeners.contextmenu || []) : [];
    for (var liQ = 0; liQ < ctxEvs.length; liQ++) ctxEvs[liQ]({ preventDefault: function () {} });
    var cmdQC = g.pendingCmds[g.pendingCmds.length - 1];
    __check('queue-strip-chip-cancel',
      chipsQ.length === 2 && g.pendingCmds.length === nQC + 1
        && cmdQC.type === 'cancelProduction' && cmdQC.kind === 'unit'
        && cmdQC.unitId === 'EG-01' && cmdQC.producerId === raxQ.id,
      'cmd=' + JSON.stringify(cmdQC));
    g.pendingCmds.length = nQC; // keep the journey state untouched
    g.selection = [];
    g.hud.activeTab = 'structures'; g.hud.tabSig = '';
    updateHud(g);

    // ---- pass-3 cameo plates (game.iconArt: defId -> painted 128px data-URI) --
    // injected post-boot (in production the pack ships inlined in the bundle);
    // build tiles + the selection panel pick the plate up on the next rebuild
    var prevIconArt = g.iconArt;
    g.iconArt = { 'EG-01': 'data:image/png;base64,AAAA',
      'SH-02': 'data:image/png;base64,BBBB' };
    function tileCameo(el) {
      var r = { img: null, hotkey: false, glyph: false };
      if (el) walkAll(el, function (e2) {
        if (e2.tagName === 'img' && (e2.className || '').indexOf('bb-cameo') >= 0) r.img = e2;
        if ((e2.className || '').indexOf('bb-hotkey') >= 0) r.hotkey = true;
        if ((e2.className || '').indexOf('bb-glyph') >= 0) r.glyph = true;
      });
      return r;
    }
    g.hud.activeTab = 'infantry'; g.hud.tabSig = ''; g.hud.gridSig = '';
    updateHud(g);
    var egT = g.hud.tiles['EG-01'] && g.hud.tiles['EG-01'].el;
    var eg = tileCameo(egT);
    var eg2 = tileCameo(g.hud.tiles['EG-02'] && g.hud.tiles['EG-02'].el); // not in the pack
    __check('iconart-unit-tile-cameo',
      !!eg.img && eg.img.src === 'data:image/png;base64,AAAA'
        && eg.img.draggable === false && eg.hotkey && eg.glyph
        && egT.classList.contains('has-cameo') && !eg2.img && eg2.glyph,
      'cameo=' + (eg.img && eg.img.src) + ' hotkey=' + eg.hotkey
        + ' chip=' + (egT && egT.classList.contains('has-cameo'))
        + ' fallbackGlyph=' + (!eg2.img && eg2.glyph));
    g.hud.activeTab = 'structures'; g.hud.tabSig = ''; g.hud.gridSig = '';
    updateHud(g);
    var sh = tileCameo(g.hud.tiles['SH-02'] && g.hud.tiles['SH-02'].el);
    __check('iconart-struct-tile-cameo',
      !!sh.img && sh.img.src === 'data:image/png;base64,BBBB' && sh.hotkey,
      'cameo=' + (sh.img && sh.img.src) + ' hotkey=' + sh.hotkey);
    // single selection: the 48px plate shows next to the name in the panel
    var cameoU = addUnit(g.state, 'EG-01', 0, 24 * 64 + 32, 24 * 64 + 32);
    g.selection = [cameoU.id];
    updateHud(g);
    var selCameo = null;
    walkAll(document.getElementById('sel-panel'), function (e3) {
      if (e3.tagName === 'img' && (e3.className || '').indexOf('bb-cameo') >= 0) selCameo = e3;
    });
    __check('iconart-selection-cameo',
      !!selCameo && selCameo.src === 'data:image/png;base64,AAAA',
      'cameo=' + (selCameo && selCameo.src));
    // empty pack (dev/headless): exact pre-pack DOM — no img anywhere
    g.iconArt = {};
    g.hud.gridSig = '';
    updateHud(g);
    var clean = tileCameo(g.hud.tiles['SH-02'] && g.hud.tiles['SH-02'].el);
    g.selection = [];
    updateHud(g);
    var selClean = true;
    walkAll(document.getElementById('sel-panel'), function (e4) {
      if (e4.tagName === 'img') selClean = false;
    });
    __check('iconart-empty-pack-unchanged', !clean.img && clean.glyph && selClean,
      'tileImg=' + !!clean.img + ' tileGlyph=' + clean.glyph + ' selClean=' + selClean);
    // v0.9.1: the selection panel must NOT rebuild its DOM while nothing
    // meaningful changed (it rebuilt every sim tick, 40 Hz at 4x). Object
    // identity of the first row proves the skip; an hp change must rebuild.
    g.selection = [cameoU.id];
    updateHud(g);
    var selRoot = document.getElementById('sel-panel');
    var rowRef = selRoot.children[0];
    var hpTxt0 = '';
    walkAll(selRoot, function (el) { if (el.className === 'sel-hp') hpTxt0 = el.textContent; });
    for (var siT = 0; siT < 6; siT++) { g.state.tick++; updateHud(g); }
    var selStable = selRoot.children[0] === rowRef && hpTxt0 !== '';
    cameoU.hp -= 10;
    updateHud(g); // hp changed -> exactly one rebuild with the fresh value
    var hpTxt1 = '';
    walkAll(selRoot, function (el) { if (el.className === 'sel-hp') hpTxt1 = el.textContent; });
    var selRebuilt = selRoot.children[0] !== rowRef && hpTxt1 !== hpTxt0;
    __check('sel-panel-rebuild-guard', selStable && selRebuilt,
      'stable=' + selStable + ' rebuilt=' + selRebuilt + ' hp=' + hpTxt0 + '->' + hpTxt1);
    g.selection = [];
    updateHud(g);
    g.iconArt = prevIconArt;
    delete g.state.units[cameoU.id]; // scratch: keep the journey state untouched
    g.hud.activeTab = 'structures'; g.hud.tabSig = ''; g.hud.gridSig = '';
    updateHud(g);

    // HUD build-button logic on a controlled state
    var st = createMatch({ data: g.data, map: g.maps.sinai,
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

    // (b) build-bar hotkey mapping: Q W E R T F in grid order, A/S/D skipped
    // (v0.3.6: G left the grid — it now cycles unit stance)
    var items = buildGridItems(st, p0, 'structures');
    var hkm = hotkeyMapFor(items);
    __check('hotkey-mapping',
      items.length >= 6 && hkm.Q === items[0].id && hkm.W === items[1].id
        && hkm.F === items[5].id && hkm.G === undefined
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
    var stT = createMatch({ data: g.data, map: g.maps.sinai,
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
    var stM = createMatch({ data: g.data, map: g.maps.sinai,
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
    var stR = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 17 });
    addStructure(stR, 'SH-01', 0, 8, 8);
    var pR = stR.players[0];
    pR.credits = 5000;
    tick(stR, [{ player: 0, type: 'buildStructure', structId: 'SH-02' }]);
    tick(stR, [{ player: 0, type: 'cancelProduction', kind: 'struct', structId: 'SH-02' }]);
    __check('cancel-struct-refund', pR.credits === 5000 && pR.buildQueue.length === 0,
      'credits=' + pR.credits + ' queue=' + pR.buildQueue.length);

    // (d) faction ability gate: saka_insertion needs a standing SH-12
    var stA2 = createMatch({ data: g.data, map: g.maps.sinai,
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
    var stG2 = createMatch({ data: g.data, map: g.maps.sinai,
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
    var stS3 = createMatch({ data: g.data, map: g.maps.sinai,
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
    var stC3 = createMatch({ data: g.data, map: g.maps.sinai,
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
    var stCap = createMatch({ data: g.data, map: g.maps.sinai,
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
    var dryMap = JSON.parse(JSON.stringify(g.maps.sinai));
    for (var iT2 = 0; iT2 < dryMap.terrain.length; iT2++) dryMap.terrain[iT2] = 0;
    var stDry = createMatch({ data: g.data, map: dryMap,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 53 });
    addStructure(stDry, 'SH-01', 0, 8, 8);
    stDry.players[0].credits = 100000;
    var navDry = structureButtonState(stDry, stDry.players[0], 'SH-07');
    var stWet = createMatch({ data: g.data, map: g.maps.jerusalem,
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
    var stA3 = createMatch({ data: g.data, map: g.maps.sinai, players: aiCfg2, seed: 59 });
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
    var stP1 = createMatch({ data: g.data, map: g.maps.sinai,
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

    // (p2) path-through-spine-pass: across a mountain spine — waypoints all
    // on open cells, unit crosses the spine inside a pass and reaches the far
    // side. Spine rows and pass columns are DERIVED from the map's terrain
    // (no hardcoded geometry): the spine is the longest run of rows that are
    // >60% blocked; a pass column is open through every spine row.
    // v0.9: the map set no longer ships a blocked mountain spine (the new
    // maps are coastal), so this check synthesizes one — the pathfinding
    // semantics under test are unchanged.
    var spnMap = { name: 'Spine', w: 64, h: 64,
      terrain: new Array(64 * 64).fill(0), oil: [],
      spawns: [{ x: 4, y: 4 }, { x: 59, y: 59 }] };
    for (var sry2 = 28; sry2 <= 35; sry2++) {
      for (var srx2 = 0; srx2 < 64; srx2++) spnMap.terrain[sry2 * 64 + srx2] = 1;
    }
    [12, 22, 40, 55].forEach(function (pc) { // four passes through the spine
      for (var py = 28; py <= 35; py++) spnMap.terrain[py * 64 + pc] = 0;
    });
    var spineRun = [], curRun = [];
    for (var sry = 0; sry < spnMap.h; sry++) {
      var blk = 0;
      for (var srx = 0; srx < spnMap.w; srx++) {
        if (spnMap.terrain[sry * spnMap.w + srx] !== 0) blk++;
      }
      if (blk > spnMap.w * 0.6) curRun.push(sry);
      else { if (curRun.length > spineRun.length) spineRun = curRun; curRun = []; }
    }
    if (curRun.length > spineRun.length) spineRun = curRun;
    var sRow0 = spineRun[0], sRow1 = spineRun[spineRun.length - 1];
    var passCol = {};
    for (var pcx = 0; pcx < spnMap.w; pcx++) {
      var colOpen = true;
      for (var pry = sRow0; pry <= sRow1; pry++) {
        if (spnMap.terrain[pry * spnMap.w + pcx] !== 0) { colOpen = false; break; }
      }
      if (colOpen) passCol[pcx] = true;
    }
    var stP2 = createMatch({ data: g.data, map: spnMap,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 67 });
    var uP2 = addUnit(stP2, 'EG-01', 0, 12 * 64 + 32, (sRow0 - 4) * 64 + 32);
    tick(stP2, [{ player: 0, type: 'move', unitIds: [uP2.id],
      x: 12 * 64 + 32, y: (sRow1 + 4) * 64 + 32 }]);
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
      if (qy2 >= sRow0 && qy2 <= sRow1 && !passCol[qx2]) passOk = false;
      if (f2.order.type !== 'move') {
        arrived2 = Math.abs(f2.x - (12 * 64 + 32)) <= 32
          && Math.abs(f2.y - ((sRow1 + 4) * 64 + 32)) <= 32;
        break;
      }
    }
    __check('path-through-spine-pass', !pathBad && arrived2 && passOk
        && spineRun.length >= 4 && Object.keys(passCol).length >= 4,
      'pathBad=' + pathBad + ' arrived=' + arrived2 + ' passOk=' + passOk
        + ' spine=' + sRow0 + '-' + sRow1 + ' passCols=' + Object.keys(passCol).length
        + ' ticks=' + stP2.tick + ' waypoints=' + (wps ? wps.length : 'none'));

    // (p3) unstick: ringed by friendly units in a structure pocket, ordered
    // out — units are soft obstacles, so it must escape within a bound
    var stP3 = createMatch({ data: g.data, map: g.maps.sinai,
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
    // elimination well before tick 6000. v0.3.6: the 18 cr/s economy fields
    // smaller armies by design — built threshold 80 -> 60.)
    // v0.9: run on arabia — the coastal maps (sinai is half water) field
    // smaller land armies and can stall below the built threshold
    function aiMatchRun() {
      var cfg = [{ slot: 0, faction: 'Egypt', ai: { personality: 'Front', difficulty: 'veteran' } },
        { slot: 1, faction: 'Israel', ai: { personality: 'Fortress', difficulty: 'veteran' } }];
      var st = createMatch({ data: g.data, map: g.maps.arabia, players: cfg, seed: 31337 });
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
      Math.max(rA.ms, rB.ms) < 20000 && builtPf >= 60 && rA.st.tick >= 4000,
      'ms=' + rA.ms + '/' + rB.ms + ' built=' + builtPf + ' tick=' + rA.st.tick);

    // ---- v0.3.2 WAVE-3 checks -------------------------------------------------

    // (w1) the spawns the naval checks anchor on are coastal: water within
    // Chebyshev 8 of arabia's spawn[0] (human yard placement) and spawn[1]
    // (the AI's base in w8). (v0.9: the regenerated map set no longer
    // guarantees water near EVERY spawn — landlocked starts exist — so the
    // scope is the two naval-anchored spawns on the map the naval checks use)
    var waterOk = true, waterBad = [];
    var w1Map = g.maps.arabia;
    [0, 1].forEach(function (si) {
      var sp = w1Map.spawns[si];
      var found = false;
      for (var dyw = -8; dyw <= 8 && !found; dyw++) {
        for (var dxw = -8; dxw <= 8 && !found; dxw++) {
          var cxw = sp.x + dxw, cyw = sp.y + dyw;
          if (cxw < 0 || cyw < 0 || cxw >= w1Map.w || cyw >= w1Map.h) continue;
          if (w1Map.terrain[cyw * w1Map.w + cxw] === 2) found = true;
        }
      }
      if (!found) { waterOk = false; waterBad.push('arabia@' + sp.x + ',' + sp.y); }
    });
    __check('water-near-spawn', waterOk, waterBad.join(';') || 'anchor spawns wet');

    // (w2) naval yard placeable near a coast spawn through the real rules
    // (water adjacency + build radius from an owned structure). The anchor is
    // the map's actual spawn — no hardcoded spawn coordinates.
    var spW2 = g.maps.arabia.spawns[0];
    var stW2 = createMatch({ data: g.data, map: g.maps.arabia,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 91 });
    addStructure(stW2, 'SH-01', 0, spW2.x, spW2.y);
    var nySpot = findPlacement(stW2, 0, stW2.structDefs['SH-07'], spW2.x + 2, spW2.y + 2, 14);
    __check('ny-placeable-near-spawn', !!nySpot,
      nySpot ? ('spawn=' + spW2.x + ',' + spW2.y + ' spot=' + nySpot.x + ',' + nySpot.y)
        : 'no legal SH-07 spot near spawn ' + spW2.x + ',' + spW2.y);

    // (w3) rebuild window: an owned structure keeps the player alive at 0
    // credits; the one SH-01 rebuild validates, builds, places next to ANY
    // owned structure; a second CY loss with the rebuild spent = elimination
    var stW3 = createMatch({ data: g.data, map: g.maps.sinai,
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
    var stW4 = createMatch({ data: g.data, map: g.maps.sinai,
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
    var stW5 = createMatch({ data: g.data, map: g.maps.sinai,
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
      var st = createMatch({ data: g.data, map: g.maps.sinai,
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
    var stW7 = createMatch({ data: g.data, map: g.maps.sinai,
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
    // (v0.3.6: budget 9000 -> 16000 ticks — the 18 cr/s economy (was 35)
    // reaches the yard + first ship later; only the pacing moved)
    // v0.9: arabia — both spawn[0] and the AI's spawn[1] start coastal
    var cfgW8 = [{ slot: 0, faction: 'Egypt' },
      { slot: 1, faction: 'Algeria', ai: { personality: 'Front', difficulty: 'recruit' } }];
    var stW8 = createMatch({ data: g.data, map: g.maps.arabia, players: cfgW8, seed: 127 });
    var aiW8 = createAI(cfgW8, 127);
    for (var iN8 = 0; iN8 < 16000 && !stW8.over; iN8++) tick(stW8, aiCommands(stW8, aiW8));
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

    // (w9) dry-map control: the AI never queues the naval yard on a dry map
    // (sinai clone with the terrain zeroed — no water anywhere)
    var stW9 = createMatch({ data: g.data, map: g.maps.sinai, players: cfgW8, seed: 131 });
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
    var stW10 = createMatch({ data: g.data, map: g.maps.sinai,
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
    // the War Factory -> income resumes. The base anchor is the map's actual
    // spawn (findDepotPlacement needs a build-radius anchor near an oil field
    // — a stale anchor silently returns null), guarded so a null spot fails
    // the check instead of crashing the driver.
    var spH = g.maps.sinai.spawns[0];
    var stH2 = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 29 });
    for (var idH0 in stH2.units) { // no MCV parked in the fresh base
      if (stH2.units[idH0].owner === 0) delete stH2.units[idH0];
    }
    addStructure(stH2, 'SH-01', 0, spH.x, spH.y);
    var pH = stH2.players[0];
    pH.credits = 20000;
    var depSpot = findDepotPlacement(stH2, 0, stH2.structDefs['SH-03']);
    if (!depSpot) {
      __check('harv-income-stop-resume', false,
        'no depot spot from spawn ' + spH.x + ',' + spH.y);
    } else {
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
    addStructure(stH2, 'SH-05', 0, spH.x - 2, spH.y - 6);
    tick(stH2, [{ player: 0, type: 'trainUnit', unitId: 'HARV' }]);
    var cR = pH.credits;
    for (var iW3 = 0; iW3 < 400; iW3++) tick(stH2);
    var incResumed = pH.credits - cR;
    __check('harv-income-stop-resume',
      !!hvAlive && incAlive > 0 && incDead === 0 && incResumed > 0,
      'alive=' + incAlive + ' dead=' + incDead + ' resumed=' + incResumed
        + ' depot=' + depSpot.x + ',' + depSpot.y);
    }

    // (g) engineer repair: idle engineer heals a damaged ConYard
    var stE2 = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 31 });
    var cyE = addStructure(stE2, 'SH-01', 0, 8, 8);
    cyE.hp = Math.floor(cyE.maxHp / 2);
    var ppE2 = addStructure(stE2, 'SH-02', 0, 30, 30); // full hp: never a repair target
    addUnit(stE2, 'EG-04', 0, 10 * 64 + 32, 10 * 64 + 32);
    // (g2) repair-order pick (v0.4.3): the damaged own structure under the
    // cursor is found; full-hp and other-team structures are not
    var rtPick = repairTargetAt(stE2, 0, (cyE.cx + 1) * CELL, (cyE.cy + 1) * CELL);
    __check('repair-order-pick',
      !!rtPick && rtPick.id === cyE.id
        && repairTargetAt(stE2, 0, (ppE2.cx + 1) * CELL, (ppE2.cy + 1) * CELL) === null
        && repairTargetAt(stE2, 1, (cyE.cx + 1) * CELL, (cyE.cy + 1) * CELL) === null,
      'picked=' + (rtPick && rtPick.id));
    var hp0 = cyE.hp;
    for (var iE = 0; iE < 100; iE++) tick(stE2);
    var cyAfter = stE2.structures[cyE.id];
    __check('engineer-repairs', !!cyAfter && cyAfter.hp > hp0,
      hp0 + ' -> ' + (cyAfter ? cyAfter.hp : 'destroyed'));

    // (h) AI expansion: recruit Front claims a second oil field by tick 6000
    // (v0.9: arabia — the coastal maps' landlocked oil spread stalled the
    // expansion below two depots)
    var aiCfg = [{ slot: 0, faction: 'Egypt' },
      { slot: 1, faction: 'Algeria', ai: { personality: 'Front', difficulty: 'recruit' } }];
    var stAI = createMatch({ data: g.data, map: g.maps.arabia, players: aiCfg, seed: 37 });
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

    // (i) all maps load via the manifest, terrain length matches dims
    var mapIds = Object.keys(g.maps);
    var loadOk = mapIds.length >= 9;
    var detailM = [];
    for (var mi = 0; mi < mapIds.length; mi++) {
      var md2 = g.maps[mapIds[mi]];
      var okM = md2 && md2.spawns.length > 0
        && md2.terrain.length === md2.w * md2.h;
      if (!okM) loadOk = false;
      detailM.push(mapIds[mi] + ':' + (md2 ? md2.spawns.length : '?'));
    }
    __check('maps-load', loadOk, detailM.join(' '));

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

    // (iv) 2 players on the big 6-spawn Arabia: boots and runs 3000 ticks
    // (v0.9: gulf's AI spawn boxed in at 2 structures — arabia's base has
    // room to grow)
    var cfgs4 = [{ slot: 0, faction: 'Egypt' },
      { slot: 1, faction: 'Algeria', ai: { personality: 'Front', difficulty: 'recruit' } }];
    var stBig = createMatch({ data: g.data, map: g.maps.arabia, players: cfgs4, seed: 9 });
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
    __check('bigmap-2p-3000-ticks',
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
      if (el.tagName === 'button' && (el.textContent || '').indexOf('Levant') === 0) {
        tigBtn = el;
      }
    });
    if (tigBtn) tigBtn.click();
    findBtn('menu', 'Start match').click();
    // v0.3.5: a fresh match auto-selects the player's MCV (was: empty selection)
    var selMcv = g.selection.length === 1
      && !!g.state.units[g.selection[0]]
      && g.state.units[g.selection[0]].defId === 'MCV'
      && g.state.units[g.selection[0]].owner === 0;
    var cleanOk = !!g.state && g.state.map.name === 'Levant' && g.state.tick === 0
      && selMcv && Object.keys(g.groups).length === 0
      && g.minimap.pings.length === 0 && Object.keys(g.state.rally).length === 0
      && !g.placement && !g.targeting && g.inspectId === 0 && g.paused === false
      && !menuVisible() && !document.body.classList.contains('in-menu');
    var errN = __smoke.errors.length;
    runFrames(200);
    __check('ui-abandon-new-match-clean', cleanOk && __smoke.errors.length === errN
      && g.state.tick > 10, 'tick=' + (g.state && g.state.tick) + ' clean=' + cleanOk);
    // render caches must be rebuilt for the NEW map (levant), and the main
    // view must actually draw (terrain + fog drawImage every frame). Sizes are
    // derived from the map dims + the render contract (v0.9.1: fog 4px/cell so
    // the smoothed blit has edges to interpolate; terrain cell scale clamped
    // to [16,64] with the largest side capped at ~6144px) — no hardcoded map
    // dimensions.
    var tail = g.ctx.log.slice(-3000);
    var draws = 0, fills = 0, fogSmooth = false;
    var curS = {};
    for (var ti = 0; ti < tail.length; ti++) {
      if (tail[ti][0].charAt(0) === '$') { curS[tail[ti][0].slice(1)] = tail[ti][1]; continue; }
      if (tail[ti][0] === 'drawImage') {
        draws++;
        if (tail[ti][1][0] === g.render.fog && curS.imageSmoothingEnabled === true) {
          fogSmooth = true; // v0.9.1: the fog blit upscales with smoothing
        }
      }
      if (tail[ti][0] === 'fillRect') fills++;
    }
    var tMap = g.state.map;
    var tsExp = Math.max(16, Math.min(64, Math.floor(6144 / Math.max(tMap.w, tMap.h))));
    var fogS = g.render.fogScale; // 4 px/cell (v0.9.1 fog smoothing)
    __check('ui-newmap-render-fresh',
      g.render && g.render.fog.width === tMap.w * fogS && g.render.fog.height === tMap.h * fogS
        && g.render.terrain.width === tMap.w * tsExp && g.render.fogImg.width === tMap.w * fogS
        && draws >= 100 && fills >= 100 && fogSmooth && g.frameErrors === 0,
      'fog=' + (g.render && g.render.fog.width) + 'x' + (g.render && g.render.fog.height)
        + ' terrain=' + (g.render && g.render.terrain.width)
        + ' want=' + (tMap.w * fogS) + 'x' + (tMap.h * fogS) + '/' + (tMap.w * tsExp)
        + ' draws=' + draws + ' fills=' + fills + ' fogSmooth=' + fogSmooth);

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
    var fogS7 = g.render.fogScale; // 4 px/cell: every map cell is a 4x4 block
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
        && g.render.fog.width === st7.map.w * fogS7 && g.render.fogTick >= 0
        && seenCount(st7) < seenOld
        && aSeen === 0 && aVis > 0 && aVis + aBlack === st7.map.w * st7.map.h * fogS7 * fogS7
        && inView && g.frameErrors === 0,
      'seenOld=' + seenOld + ' seenNew=' + seenCount(st7)
        + ' vis=' + aVis + ' seenA=' + aSeen + ' black=' + aBlack
        + ' inView=' + inView + ' pings=' + g.minimap.pings.length);

    // journey 8: two-depot economy performance (regression: 2 depots + HARV
    // shuttle must not degrade per-tick cost)
    function depotRun(nDepots) {
      var stP = createMatch({ data: g.data, map: g.maps.sinai,
        players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }],
        seed: 41 });
      // anchor the base at the map's actual spawn (findDepotPlacement needs a
      // build-radius anchor near an oil field); a null spot fails, not crashes
      var spP2 = stP.map.spawns[0];
      addStructure(stP, 'SH-01', 0, spP2.x, spP2.y);
      var pP = stP.players[0];
      pP.credits = 100000;
      for (var dp = 0; dp < nDepots; dp++) {
        var spotP = findDepotPlacement(stP, 0, stP.structDefs['SH-03']);
        if (!spotP) return { ms: -1, income: -1 }; // no spot: check fails below
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

    // ---- v0.3.5 UX checks ------------------------------------------------------

    // (u1) human auto-deploy: never touch the MCV — at tick 200 the simStep
    // hook issues deployMCV through the normal command path and a ConYard
    // appears (deploy resolves the same tick; allow a small margin)
    startMatch({ map: 'sinai', faction: 'Egypt',
      opponents: [{ faction: 'Algeria', personality: 'Front', difficulty: 'recruit' }] });
    var adTick = -1;
    for (var fAd = 0; fAd < 1500 && adTick < 0; fAd++) {
      __now += 16.7; var cbAd = __rafCb; __rafCb = null;
      if (cbAd) cbAd(__now);
      for (var idAd in g.state.structures) {
        var sAd = g.state.structures[idAd];
        if (sAd.owner === 0 && sAd.defId === 'SH-01') adTick = g.state.tick;
      }
    }
    var mcvLeft = false;
    for (var idAd2 in g.state.units) {
      if (g.state.units[idAd2].owner === 0 && g.state.units[idAd2].defId === 'MCV') mcvLeft = true;
    }
    __check('auto-deploy-by-210', adTick > 0 && adTick <= 215 && !mcvLeft,
      'deployedAt=' + adTick + ' mcvLeft=' + mcvLeft);

    // (u2) wheel zoom keeps the world point under the cursor stationary
    var camZ = g.camera;
    camZ.zoom = 1; camZ.x = 200; camZ.y = 200;
    var wz0 = screenToWorld(camZ, 640, 400);
    zoomCameraAt(camZ, 1.15, 640, 400);
    var wz1 = screenToWorld(camZ, 640, 400);
    zoomCameraAt(camZ, 1 / 1.15, 640, 400);
    var wz2 = screenToWorld(camZ, 640, 400);
    __check('zoom-anchor-stable',
      Math.abs(wz1.x - wz0.x) < 1 && Math.abs(wz1.y - wz0.y) < 1
        && Math.abs(wz2.x - wz0.x) < 1 && Math.abs(wz2.y - wz0.y) < 1,
      'd1=' + (wz1.x - wz0.x).toFixed(2) + ',' + (wz1.y - wz0.y).toFixed(2)
        + ' d2=' + (wz2.x - wz0.x).toFixed(2) + ',' + (wz2.y - wz0.y).toFixed(2));

    // (u3) edge pan: pointer hugging the left window edge scrolls the camera
    centerCameraOn(g.camera, 40 * 64, 40 * 64);
    clampCameraToMap(g.camera, g.state.map.w * 64, g.state.map.h * 64);
    g.mouse.sx = 2; g.mouse.sy = 400; g.mouse.inside = true;
    var ex0 = g.camera.x;
    handleInputFrame(g, 100);
    var edgeOk = g.camera.x < ex0 - 1;
    g.mouse.sx = 640; g.mouse.inside = false;
    __check('edge-pan-moves-camera', edgeOk, 'x ' + ex0.toFixed(1) + ' -> ' + g.camera.x.toFixed(1));

    // (u4) own-unit hit -> clickable alert in the #alerts stack; the stub has
    // no AudioContext, so the siren path must silently no-op (never throw)
    var uA = addUnit(g.state, 'EG-01', 0, 20 * 64 + 32, 20 * 64 + 32);
    var alertsRoot = document.getElementById('alerts');
    var alertsBefore = alertsRoot.children.length;
    var alertThrew = false;
    try {
      dealDamage(g.state, uA, 10, null);
      updateHud(g);
    } catch (eA) { alertThrew = true; }
    var lastAlert = alertsRoot.children[alertsRoot.children.length - 1];
    __check('under-attack-alert-unit', !alertThrew
      && alertsRoot.children.length > alertsBefore
      && !!lastAlert && /Under attack/.test(lastAlert.textContent),
      'threw=' + alertThrew + ' children=' + alertsRoot.children.length
        + ' text=' + (lastAlert && lastAlert.textContent));

    // ---- v0.3.6 feature checks -------------------------------------------------

    // (v1) stances: hold fire never shoots, even with a target in range;
    // switching back to aggressive auto-acquires and fires. EG-06 (bldg 16)
    // parked by a hostile power plant that can't shoot back.
    var stSt = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 23 });
    var ppSt = addStructure(stSt, 'SH-02', 1, 12, 8);
    var tankSt = addUnit(stSt, 'EG-06', 0, 10 * 64 + 32, 9 * 64 + 32);
    tick(stSt, [{ player: 0, type: 'setStance', unitIds: [tankSt.id], stance: 3 }]);
    var hpSt0 = stSt.structures[ppSt.id].hp;
    for (var iSt = 0; iSt < 300; iSt++) tick(stSt);
    var hpHold = stSt.structures[ppSt.id].hp;
    tick(stSt, [{ player: 0, type: 'setStance', unitIds: [tankSt.id], stance: 0 }]);
    for (var iSt2 = 0; iSt2 < 400 && stSt.structures[ppSt.id]; iSt2++) tick(stSt);
    var hpAgg = stSt.structures[ppSt.id] ? stSt.structures[ppSt.id].hp : 0;
    __check('stance-holdfire-vs-aggressive', hpHold === hpSt0 && hpAgg < hpSt0,
      'hp ' + hpSt0 + ' -> ' + hpHold + ' (hold fire) -> ' + hpAgg + ' (aggressive)');

    // (v2) shift-queued waypoint: the unit finishes leg 1, then walks leg 2
    var stQ = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 29 });
    var uQ = addUnit(stQ, 'EG-01', 0, 10 * 64 + 32, 10 * 64 + 32);
    var leg1 = { x: 16 * 64 + 32, y: 10 * 64 + 32 };
    var leg2 = { x: 16 * 64 + 32, y: 18 * 64 + 32 };
    tick(stQ, [{ player: 0, type: 'move', unitIds: [uQ.id], x: leg1.x, y: leg1.y }]);
    tick(stQ, [{ player: 0, type: 'move', unitIds: [uQ.id], x: leg2.x, y: leg2.y, queue: true }]);
    var uQ0 = stQ.units[uQ.id];
    var queuedOk = !!uQ0.waypoints && uQ0.waypoints.length === 2
      && uQ0.order.type === 'move' && uQ0.order.x === leg1.x && uQ0.order.y === leg1.y;
    for (var iQ = 0; iQ < 2000 && stQ.units[uQ.id].order.type !== 'idle'; iQ++) tick(stQ);
    var fQ = stQ.units[uQ.id];
    __check('shift-queue-waypoints', queuedOk && fQ.waypoints === null
      && Math.abs(fQ.x - leg2.x) <= 64 && Math.abs(fQ.y - leg2.y) <= 64,
      'queued=' + queuedOk + ' end=' + fQ.x + ',' + fQ.y + ' wp=' + fQ.waypoints);

    // (v3) patrol: the unit loops between its start and the clicked point.
    // v0.9: find a guaranteed-land horizontal corridor on the (coastal) map —
    // the old hardcoded row can be water now, and a unit parked in water
    // never starts its patrol loop
    var stPt = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 31 });
    var patY = -1;
    for (var tryY = 2; tryY < stPt.map.h - 2 && patY < 0; tryY++) {
      var rowOk = true;
      for (var tryX = 10; tryX <= 20 && rowOk; tryX++) {
        if (stPt.map.terrain[tryY * stPt.map.w + tryX] !== 0) rowOk = false;
      }
      if (rowOk) patY = tryY;
    }
    var uPt = addUnit(stPt, 'EG-01', 0, 10 * 64 + 32, patY * 64 + 32);
    tick(stPt, [{ player: 0, type: 'patrol', unitIds: [uPt.id], x: 20 * 64 + 32, y: patY * 64 + 32 }]);
    var minX = 1e9, maxX = -1e9;
    for (var iPt = 0; iPt < 2500; iPt++) {
      tick(stPt);
      var uP2 = stPt.units[uPt.id];
      if (uP2.x < minX) minX = uP2.x;
      if (uP2.x > maxX) maxX = uP2.x;
    }
    __check('patrol-loops', patY > 0 && maxX - minX >= 8 * 64 && minX <= 11 * 64 && maxX >= 19 * 64,
      'patY=' + patY + ' minX=' + minX + ' maxX=' + maxX);

    // (v4) separation: two same-spot friendlies get pushed apart
    var stSep = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 37 });
    var sA = addUnit(stSep, 'EG-01', 0, 30 * 64 + 32, 30 * 64 + 32);
    var sB = addUnit(stSep, 'EG-01', 0, 30 * 64 + 32, 30 * 64 + 32);
    for (var iSep = 0; iSep < 60; iSep++) tick(stSep);
    var dSep = Math.abs(stSep.units[sA.id].x - stSep.units[sB.id].x)
      + Math.abs(stSep.units[sA.id].y - stSep.units[sB.id].y);
    __check('separation-pushes-apart', dSep >= 12, 'manhattan=' + dSep);

    // (v5) 'G' cycles stance through the real input path; '.' jumps the
    // camera to an idle worker and selects it. Two idle engineers also arm
    // the idle-worker hint banner (~100 idle ticks).
    var engA = addUnit(g.state, 'EG-04', 0, 30 * 64 + 32, 30 * 64 + 32);
    var engB = addUnit(g.state, 'EG-04', 0, 32 * 64 + 32, 30 * 64 + 32);
    var keyEv = function (code) {
      return { code: code, ctrlKey: false, altKey: false, shiftKey: false,
        preventDefault: function () {} };
    };
    g.selection = [engA.id];
    handleKey(g, keyEv('KeyG'), true);
    runFrames(15);
    handleKey(g, keyEv('KeyG'), true);
    runFrames(15);
    var stanceNow = g.state.units[engA.id] ? g.state.units[engA.id].stance : -1;
    g.selection = [];
    handleKey(g, keyEv('Period'), true);
    var jumped = g.selection.length === 1
      && (g.selection[0] === engA.id || g.selection[0] === engB.id);
    var ju = jumped ? g.state.units[g.selection[0]] : null;
    var camC = screenToWorld(g.camera, g.camera.viewW / 2, g.camera.viewH / 2);
    var onScreen = ju
      && Math.abs(camC.x - ju.x) <= g.camera.viewW / g.camera.zoom / 2 + 64
      && Math.abs(camC.y - ju.y) <= g.camera.viewH / g.camera.zoom / 2 + 64;
    __check('g-key-stance-and-idle-jump', stanceNow === 2 && jumped && onScreen,
      'stance=' + stanceNow + ' sel=' + g.selection
        + ' camC=' + Math.round(camC.x) + ',' + Math.round(camC.y)
        + (ju ? ' worker=' + Math.round(ju.x) + ',' + Math.round(ju.y) : ''));

    // v0.4.3: Z/X/C/V set stances directly without modifiers (AltGr-friendly
    // alternates to Ctrl+Alt+A/D/S/F) — X = defensive (1), V = hold fire (3)
    g.selection = [engA.id];
    var nZ = g.pendingCmds.length;
    handleKey(g, keyEv('KeyX'), true);
    handleKey(g, keyEv('KeyV'), true);
    var cmdZX = g.pendingCmds.slice(nZ);
    __check('zxcv-stance-alternates',
      cmdZX.length === 2
        && cmdZX[0].type === 'setStance' && cmdZX[0].stance === 1
        && cmdZX[1].type === 'setStance' && cmdZX[1].stance === 3
        && cmdZX[0].unitIds.indexOf(engA.id) >= 0,
      'cmds=' + JSON.stringify(cmdZX));
    g.pendingCmds.length = nZ; // don't actually apply: journey state untouched

    // v0.4.3: a mixed-stance selection shows 'Stance: —'; a uniform one shows
    // the stance name (engA stance 2 = Hold ground, engB stance 0)
    g.selection = [engA.id, engB.id];
    updateHud(g);
    var mixedDash = false;
    walkAll(document.getElementById('sel-panel'), function (el) {
      if ((el.textContent || '').indexOf('Stance: —') >= 0) mixedDash = true;
    });
    g.selection = [engA.id];
    updateHud(g);
    var uniformName = false;
    walkAll(document.getElementById('sel-panel'), function (el) {
      if ((el.textContent || '').indexOf('Stance: Hold ground') >= 0) uniformName = true;
    });
    g.selection = [];
    updateHud(g);
    __check('mixed-stance-dash', mixedDash && uniformName,
      'dash=' + mixedDash + ' uniform=' + uniformName);
    runFrames(700); // >100 idle ticks for both engineers
    var idleHint = false;
    walkAll(document.getElementById('hint'), function (el) {
      if (/idle workers/.test(el.textContent || '')) idleHint = true;
    });
    __check('idle-worker-banner', idleHint, 'hint children='
      + document.getElementById('hint').children.length);

    // v0.4.3: a single worker idle for >300 ticks also warns (throttled)
    var engC = addUnit(g.state, 'EG-04', 0, 34 * 64 + 32, 30 * 64 + 32);
    g.hud.idleSince = {}; g.hud.idleWarnAt = -9999;
    g.hud.idleSince[engC.id] = g.state.tick - 400;
    updateHud(g);
    var soloIdle = false;
    walkAll(document.getElementById('hint'), function (el) {
      if (/^1 idle worker/.test(el.textContent || '')) soloIdle = true;
    });
    __check('idle-worker-solo-300', soloIdle,
      'soloHint=' + soloIdle);

    // v0.4.3: hint banners cap at 3 concurrent (oldest dropped); the
    // persistent MCV hint (child 0) is never dropped
    for (var hc = 0; hc < 5; hc++) showHint(g, 'cap-test-' + hc);
    var hintKids = document.getElementById('hint').children;
    __check('hint-cap-3',
      hintKids.length === 4
        && hintKids[1].textContent === 'cap-test-2'
        && hintKids[3].textContent === 'cap-test-4',
      'children=' + hintKids.length + ' [1]=' + (hintKids[1] && hintKids[1].textContent));

    // (v6) difficulty tiers: think interval, wave cadence, eco cheat
    var aiT = createAI([
      { slot: 0, faction: 'Egypt', ai: { personality: 'front', difficulty: 'recruit' } },
      { slot: 1, faction: 'Algeria', ai: { personality: 'front', difficulty: 'marshal' } },
    ], 7);
    var stD = createMatch({ data: g.data, map: g.maps.sinai,
      players: [
        { slot: 0, faction: 'Egypt', ai: { personality: 'front', difficulty: 'recruit' } },
        { slot: 1, faction: 'Algeria', ai: { personality: 'front', difficulty: 'marshal' } },
      ], seed: 41 });
    __check('difficulty-tiers',
      aiT.brains[0].interval === 90 && aiT.brains[1].interval === 25
        && aiT.brains[0].waveMult === 1.5 && aiT.brains[1].waveMult === 0.65
        && stD.players[0].aiEcoMult === 1 && stD.players[1].aiEcoMult === 1.2,
      'interval=' + aiT.brains[0].interval + '/' + aiT.brains[1].interval
        + ' waveMult=' + aiT.brains[0].waveMult + '/' + aiT.brains[1].waveMult
        + ' eco=' + stD.players[0].aiEcoMult + '/' + stD.players[1].aiEcoMult);

    // (v7) score stats: kill credit / loss, and credits spent on a structure
    var stK = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 43 });
    addStructure(stK, 'SH-01', 0, 8, 8);
    var killer = addUnit(stK, 'EG-01', 0, 10 * 64, 10 * 64);
    var victim = addUnit(stK, 'DZ-01', 1, 12 * 64, 10 * 64);
    dealDamage(stK, victim, 99999, killer);
    var pK = stK.players[0];
    pK.credits = 5000;
    tick(stK, [{ player: 0, type: 'buildStructure', structId: 'SH-02' }]);
    __check('score-stats',
      stK.players[0].unitsKilled === 1 && stK.players[1].unitsLost === 1
        && pK.creditsSpent === 800 && pK.credits === 4200,
      'killed=' + stK.players[0].unitsKilled + ' lost=' + stK.players[1].unitsLost
        + ' spent=' + pK.creditsSpent + ' credits=' + pK.credits);

    // (v8) end-of-match score screen: wiping out the AI ends the match and
    // the banner carries the per-player score table + a Rematch button.
    // Last check — this ends the live match.
    // v0.4.3 contract probe: when the sim tracks structsLost, menu.js splits
    // the Lost column into units vs structures (injected here to test the
    // rendering path before the sim-side stats land)
    g.state.players[0].structsLost = 3;
    g.state.players[1].structsLost = 5;
    for (var idE in g.state.units) {
      if (g.state.units[idE].owner === 1) delete g.state.units[idE];
    }
    for (var idES in g.state.structures) {
      if (g.state.structures[idES].owner === 1) delete g.state.structures[idES];
    }
    g.state.players[1].credits = 0;
    runFrames(40);
    var bannerWon = false, rematchBtn = null;
    walkAll(document.getElementById('banner'), function (el) {
      if ((el.className || '').indexOf('score-table') >= 0) bannerWon = true;
      if (el.tagName === 'button' && el.textContent === 'Rematch') rematchBtn = el;
    });
    __check('score-screen-banner', g.state.over && bannerWon && !!rematchBtn,
      'over=' + g.state.over + ' table=' + bannerWon + ' rematch=' + !!rematchBtn);

    // v0.4.3: with structsLost present the score table splits losses
    var structSplit = false, structCell = false;
    walkAll(document.getElementById('banner'), function (el) {
      if ((el.textContent || '') === 'Structs lost') structSplit = true;
      if ((el.textContent || '') === '5') structCell = true;
    });
    __check('score-screen-struct-split', structSplit && structCell,
      'header=' + structSplit + ' cell=' + structCell);

    // v0.4.3: Esc on the end-of-match banner takes the Menu-button path
    // (exit to the main menu) instead of being a no-op
    handleKey(g, { code: 'Escape' }, true);
    var bannerHidden = document.getElementById('banner').classList.contains('hidden');
    __check('esc-on-over-opens-menu',
      g.state === null && g.overlay === 'menu' && menuVisible() && bannerHidden,
      'state=' + !!g.state + ' overlay=' + g.overlay + ' bannerHidden=' + bannerHidden);

    // ---- v0.4.4 checks (tutorial, musicOn, LMB-pan, gating, AI/neutral) ------

    // (t1) musicOn initialized as a real boolean at boot (DeepSeek 3.1) —
    // audio.js is absent in this harness, so the defensive default applies
    __check('musicon-init-boolean', typeof g.musicOn === 'boolean' && g.musicOn === false,
      'musicOn=' + g.musicOn + ' (' + typeof g.musicOn + ')');

    // (t2) setup checkbox defaults: Tutorial path checks it (unseen), the
    // Skirmish path leaves it off
    var chkOf = function () {
      var found = null;
      walkAll(document.getElementById('menu'), function (el) {
        if (el.className === 'tutor-check') found = el;
      });
      return found;
    };
    findBtn('menu', 'Tutorial').click();
    var tutDefaultOn = !!chkOf() && chkOf().checked === true;
    findBtn('menu', 'Back').click();
    findBtn('menu', 'Skirmish').click();
    var skirmDefaultOff = !!chkOf() && chkOf().checked === false;
    __check('tutorial-checkbox-defaults', tutDefaultOn && skirmDefaultOff,
      'tutorialPath=' + tutDefaultOn + ' skirmishPath=' + skirmDefaultOff);
    findBtn('menu', 'Back').click();

    // (t3) tutorial journey through the real menu: S1 overlay -> S2 -> deploy
    // -> S3 (+ build-tile pulse) -> Skip link dismisses and persists 'seen'
    findBtn('menu', 'Tutorial').click();
    findBtn('menu', 'Start match').click();
    var tutorEl = document.getElementById('tutor');
    var tutorHas = function (re) {
      var found = false;
      walkAll(tutorEl, function (el) { if (re.test(el.textContent || '')) found = true; });
      return found;
    };
    __check('tutorial-s1-overlay',
      !!g.tutor && g.tutor.step === 0 && !!g.state
        && !tutorEl.classList.contains('hidden') && tutorHas(/MCV — left-click/),
      'step=' + (g.tutor && g.tutor.step) + ' hidden='
        + tutorEl.classList.contains('hidden'));
    runFrames(2); // S1 auto-done (MCV auto-selected at start) -> S2 prompt
    __check('tutorial-s2-deploy-prompt',
      !!g.tutor && g.tutor.step === 1 && tutorHas(/deploy your Construction Yard/),
      'step=' + (g.tutor && g.tutor.step));
    var mcvT = null;
    for (var idT in g.state.units) {
      if (g.state.units[idT].owner === 0 && g.state.units[idT].defId === 'MCV') {
        mcvT = g.state.units[idT];
      }
    }
    g.pendingCmds.push({ player: 0, type: 'deployMCV', unitId: mcvT.id });
    runFrames(15); // a sim tick must pass for deployMCV to resolve
    var pulsed = !!(g.hud.tiles['SH-02']
      && g.hud.tiles['SH-02'].el.classList.contains('tutor-pulse'));
    __check('tutorial-s3-after-deploy',
      !!g.tutor && g.tutor.step === 2 && tutorHas(/Power Plant/) && pulsed,
      'step=' + (g.tutor && g.tutor.step) + ' pulse=' + pulsed);
    var skipEl = null;
    walkAll(tutorEl, function (el) {
      if ((el.textContent || '') === 'Skip tutorial') skipEl = el;
    });
    if (skipEl) skipEl.click();
    var seenStored = null;
    try { seenStored = globalThis.localStorage.getItem('mca_tutorial_seen'); } catch (eLS) {}
    __check('tutorial-skip-dismisses',
      !!skipEl && g.tutor === null && seenStored === '1'
        && tutorEl.classList.contains('hidden'),
      'skip=' + !!skipEl + ' tutor=' + !!g.tutor + ' seen=' + seenStored);

    // (t4) Esc exits the overlay cleanly at any step; with 'seen' persisted
    // the Tutorial-path checkbox defaults off; abandon drops the match cleanly
    startMatch({ map: 'sinai', faction: 'Egypt',
      opponents: [{ faction: 'Algeria', personality: 'Front', difficulty: 'recruit' }],
      tutorial: true });
    runFrames(1);
    handleKey(g, { code: 'Escape' }, true);
    __check('tutorial-esc-skips',
      g.tutor === null && tutorEl.classList.contains('hidden') && !!g.state,
      'tutor=' + !!g.tutor);
    g.openMenu();
    findBtn('menu', 'Abandon match').click();
    var reallyT = findBtn('menu', 'Really abandon?');
    if (reallyT) reallyT.click();
    findBtn('menu', 'Tutorial').click();
    var offAfterSeen = !!chkOf() && chkOf().checked === false;
    __check('tutorial-checkbox-off-after-seen', offAfterSeen && g.state === null,
      'checked=' + (chkOf() && chkOf().checked) + ' state=' + !!g.state);
    findBtn('menu', 'Back').click();

    // (t5) LMB-drag (v0.5.1 revert): a drag starting on EMPTY terrain is a
    // box-select again (the v0.4.4 LMB-pan experiment is gone) — 2 own units
    // inside the rect get selected and the camera does NOT pan; a drag
    // starting on an own unit box-selects; a stationary press still deselects
    document.getElementById('menu').classList.add('hidden');
    startMatch({ map: 'sinai', faction: 'Egypt',
      opponents: [{ faction: 'Algeria', personality: 'Front', difficulty: 'recruit' }] });
    var cv2 = document.getElementById('game');
    var fireEv = function (type, ev) {
      (cv2.listeners[type] || []).forEach(function (f) { f(ev); });
    };
    var mouseTo = function (x, y) { fireEv('mousemove', { clientX: x, clientY: y }); };
    var findEmptyPt = function () {
      for (var sy = 100; sy < 780; sy += 40) {
        for (var sx = 100; sx < 1200; sx += 40) {
          var ww = screenToWorld(g.camera, sx, sy);
          if (!pickOwnAt(g, ww.x, ww.y)) return { x: sx, y: sy };
        }
      }
      return null;
    };
    var bx1 = 30 * 64 + 32, by1 = 30 * 64 + 32;
    var bu1 = addUnit(g.state, 'EG-01', 0, bx1, by1);
    var bu2 = addUnit(g.state, 'EG-01', 0, bx1 + 3 * 64, by1 + 2 * 64);
    centerCameraOn(g.camera, bx1 + 96, by1 + 64);
    clampCameraToMap(g.camera, g.state.map.w * 64, g.state.map.h * 64);
    var s0 = worldToScreen(g.camera, bx1 - 64, by1 - 64);
    var s1 = worldToScreen(g.camera, bx1 + 4 * 64, by1 + 3 * 64);
    var wS = screenToWorld(g.camera, s0.x, s0.y);
    var startEmpty = !pickOwnAt(g, wS.x, wS.y); // drag starts on empty terrain
    var camX0 = g.camera.x, camY0 = g.camera.y;
    g.selection = [];
    mouseTo(s0.x, s0.y);
    fireEv('mousedown', { button: 0, preventDefault: function () {} });
    var boxArmed = !!g.drag;
    mouseTo(s1.x, s1.y);
    fireEv('mouseup', { button: 0 });
    var bothSel = g.selection.indexOf(bu1.id) >= 0 && g.selection.indexOf(bu2.id) >= 0;
    __check('lmb-drag-on-empty-box-selects',
      startEmpty && boxArmed && bothSel && !g.lmbPan
        && g.camera.x === camX0 && g.camera.y === camY0,
      'empty=' + startEmpty + ' armed=' + boxArmed + ' sel=' + g.selection
        + ' camMoved=' + (g.camera.x !== camX0 || g.camera.y !== camY0));
    var ownU = null;
    for (var idB2 in g.state.units) {
      if (g.state.units[idB2].owner === 0 && g.state.units[idB2].defId === 'MCV') {
        ownU = g.state.units[idB2]; break;
      }
    }
    centerCameraOn(g.camera, ownU.x, ownU.y);
    clampCameraToMap(g.camera, g.state.map.w * 64, g.state.map.h * 64);
    var sc2 = worldToScreen(g.camera, ownU.x, ownU.y);
    var camB0 = { x: g.camera.x, y: g.camera.y };
    g.selection = [];
    mouseTo(sc2.x, sc2.y);
    fireEv('mousedown', { button: 0, preventDefault: function () {} });
    var dragArmed = !!g.drag;
    mouseTo(sc2.x + 60, sc2.y + 60);
    fireEv('mouseup', { button: 0 });
    __check('lmb-drag-on-own-unit-box-selects',
      dragArmed && g.selection.indexOf(ownU.id) >= 0
        && g.camera.x === camB0.x && g.camera.y === camB0.y,
      'drag=' + dragArmed + ' sel=' + g.selection);
    g.selection = [ownU.id];
    var ep2 = findEmptyPt();
    var nLc0 = g.pendingCmds.length;
    mouseTo(ep2.x, ep2.y);
    fireEv('mousedown', { button: 0, preventDefault: function () {} });
    fireEv('mouseup', { button: 0 });
    // v0.6.0: left-click on open map WITH units selected = move order, and the
    // selection is KEPT (replaces the pre-v0.6.0 deselect-on-empty-click)
    var cmdLc = g.pendingCmds[g.pendingCmds.length - 1];
    __check('lmb-click-empty-move-keeps-selection',
      g.pendingCmds.length === nLc0 + 1 && cmdLc.type === 'move'
        && cmdLc.unitIds.indexOf(ownU.id) >= 0
        && g.selection.length === 1 && g.selection[0] === ownU.id,
      'cmds=' + (g.pendingCmds.length - nLc0) + ' sel=' + g.selection);
    g.pendingCmds.length = nLc0; // keep the journey state untouched

    // ---- v0.6.0 checks: wheel pan, zoom control, left-click orders, drag-move

    // (n1) left-click on open map with units selected: move order with
    // formation offsets, selection kept
    g.selection = [bu1.id, bu2.id];
    var nMv = g.pendingCmds.length;
    var ep3 = findEmptyPt();
    mouseTo(ep3.x, ep3.y);
    fireEv('mousedown', { button: 0, preventDefault: function () {} });
    fireEv('mouseup', { button: 0 });
    var cmdMv = g.pendingCmds[g.pendingCmds.length - 1];
    __check('lmb-click-move-two-units-formation',
      g.pendingCmds.length === nMv + 1 && cmdMv.type === 'move'
        && cmdMv.unitIds.indexOf(bu1.id) >= 0 && cmdMv.unitIds.indexOf(bu2.id) >= 0
        && !!cmdMv.offsets && cmdMv.offsets.length === 2
        && g.selection.length === 2,
      'cmds=' + (g.pendingCmds.length - nMv) + ' sel=' + g.selection);
    g.pendingCmds.length = nMv; // keep the journey state untouched

    // (n2) left-click on an ENEMY with units selected: attackTarget, kept
    g.selection = [bu1.id, bu2.id];
    var foeU = addUnit(g.state, 'DZ-01', 1, bx1 + 8 * 64, by1);
    var fcx = Math.floor(foeU.x / CELL), fcy = Math.floor(foeU.y / CELL);
    for (var fdY = -1; fdY <= 1; fdY++) {
      for (var fdX = -1; fdX <= 1; fdX++) {
        g.state.fog[0].visible[(fcy + fdY) * g.state.map.w + (fcx + fdX)] = 1;
      }
    }
    var nAtk = g.pendingCmds.length;
    var foeS = worldToScreen(g.camera, foeU.x, foeU.y);
    mouseTo(foeS.x, foeS.y);
    fireEv('mousedown', { button: 0, preventDefault: function () {} });
    fireEv('mouseup', { button: 0 });
    var cmdAtk = g.pendingCmds[g.pendingCmds.length - 1];
    __check('lmb-click-enemy-attacks',
      g.pendingCmds.length === nAtk + 1 && cmdAtk.type === 'attackTarget'
        && cmdAtk.targetId === foeU.id
        && cmdAtk.unitIds.indexOf(bu1.id) >= 0 && g.selection.length === 2,
      'cmd=' + JSON.stringify(cmdAtk) + ' sel=' + g.selection.length);
    g.pendingCmds.length = nAtk;
    delete g.state.units[foeU.id]; // scratch: don't leave a hostile by bu1/bu2

    // (n3) left-click with a producer structure selected sets its rally point
    // (mirrors what right-click does today via rallyCommand). raxQ from the
    // queue-strip check belongs to the PREVIOUS match — add a fresh producer
    var raxN = addStructure(g.state, 'SH-04', 0, 40, 40);
    g.selection = [raxN.id];
    var rp = findEmptyPt();
    var rw = screenToWorld(g.camera, rp.x, rp.y);
    var nRal = g.pendingCmds.length;
    mouseTo(rp.x, rp.y);
    fireEv('mousedown', { button: 0, preventDefault: function () {} });
    fireEv('mouseup', { button: 0 });
    var cmdRal = g.pendingCmds[g.pendingCmds.length - 1];
    __check('lmb-producer-rally',
      g.pendingCmds.length === nRal + 1 && cmdRal.type === 'setRally'
        && cmdRal.structId === raxN.id
        && cmdRal.x === Math.round(rw.x) && cmdRal.y === Math.round(rw.y)
        && g.selection.length === 1 && g.selection[0] === raxN.id
        && !pickHostileAt(g, rw.x, rw.y),
      'cmd=' + JSON.stringify(cmdRal));
    g.pendingCmds.length = nRal;

    // (n4) drag-move: press on a selected unit, drag past DRAG_MIN, release ->
    // move order to the release point; selection kept; NO box-select armed
    g.selection = [bu1.id, bu2.id];
    centerCameraOn(g.camera, bu1.x, bu1.y);
    clampCameraToMap(g.camera, g.state.map.w * 64, g.state.map.h * 64);
    var bs0 = worldToScreen(g.camera, bu1.x, bu1.y);
    g.selection = [bu1.id, bu2.id];
    var nDm = g.pendingCmds.length;
    mouseTo(bs0.x, bs0.y);
    fireEv('mousedown', { button: 0, preventDefault: function () {} });
    var dmArmed = !!g.dragMove && !g.drag;
    mouseTo(bs0.x + 90, bs0.y + 50);
    var dmMoved = !!g.dragMove;
    fireEv('mouseup', { button: 0 });
    var cmdDm = g.pendingCmds[g.pendingCmds.length - 1];
    var wDm = screenToWorld(g.camera, g.mouse.sx, g.mouse.sy);
    __check('drag-move-issues-move',
      dmArmed && dmMoved && g.pendingCmds.length === nDm + 1
        && cmdDm.type === 'move'
        && cmdDm.unitIds.indexOf(bu1.id) >= 0 && cmdDm.unitIds.indexOf(bu2.id) >= 0
        && cmdDm.x === Math.round(wDm.x) && cmdDm.y === Math.round(wDm.y)
        && g.selection.length === 2,
      'armed=' + dmArmed + ' cmd=' + JSON.stringify(cmdDm));
    g.pendingCmds.length = nDm;

    // (n5) drag-move order line renders (white dashed, patrol style) while the
    // drag is armed — drawn from main.js after renderFrame, so the LAST
    // setLineDash+stroke of the frame is ours
    g.selection = [bu1.id, bu2.id];
    centerCameraOn(g.camera, bu1.x, bu1.y);
    clampCameraToMap(g.camera, g.state.map.w * 64, g.state.map.h * 64);
    var bsL = worldToScreen(g.camera, bu1.x, bu1.y);
    g.selection = [bu1.id, bu2.id];
    mouseTo(bsL.x, bsL.y);
    fireEv('mousedown', { button: 0, preventDefault: function () {} });
    mouseTo(bsL.x + 90, bsL.y + 50);
    var logN = g.ctx.log.length;
    runFrames(1);
    var lastDash = null, lastStroke = -1;
    for (var li = logN; li < g.ctx.log.length; li++) {
      // last NON-EMPTY dash pattern (ours is followed by a setLineDash([])
      // clear; log entry args are [pattern], so test the pattern itself)
      if (g.ctx.log[li][0] === 'setLineDash' && g.ctx.log[li][1][0]
        && g.ctx.log[li][1][0].length) {
        lastDash = g.ctx.log[li][1][0];
      }
      if (g.ctx.log[li][0] === 'stroke') lastStroke = li;
    }
    var lineOk = lastStroke >= logN && lastDash && lastDash.length === 2
      && lastDash[0] === 6 && lastDash[1] === 4
      && g.ctx.strokeStyle === 'rgba(255,255,255,0.8)';
    fireEv('mouseup', { button: 0 });
    g.pendingCmds.length = 0; // the release's move command: scratch
    g.selection = [];
    __check('drag-move-order-line-rendered',
      lineOk && lastStroke >= logN && g.dragMove === null,
      'dash=' + JSON.stringify(lastDash) + ' stroke=' + g.ctx.strokeStyle
        + ' lastStroke=' + lastStroke + '/' + logN);

    // (n6) wheel = pan: camera.y moves ~120 CSS px per notch, zoom unchanged;
    // shift+wheel pans horizontally; ctrl+wheel (touchpad pinch path) zooms
    centerCameraOn(g.camera, g.state.map.w * 32, g.state.map.h * 32);
    clampCameraToMap(g.camera, g.state.map.w * 64, g.state.map.h * 64);
    g.camera.zoom = 1;
    var wy0 = g.camera.y, wz0b = g.camera.zoom;
    mouseTo(640, 400);
    fireEv('wheel', { deltaY: 120, deltaMode: 0, ctrlKey: false, shiftKey: false,
      preventDefault: function () {} });
    var wyDown = g.camera.y - wy0;
    var wy1 = g.camera.y;
    fireEv('wheel', { deltaY: -120, deltaMode: 0, ctrlKey: false, shiftKey: false,
      preventDefault: function () {} });
    var wyUp = g.camera.y - wy1;
    __check('wheel-pans-map-not-zoom',
      Math.abs(wyDown - 120) < 0.5 && Math.abs(wyUp + 120) < 0.5
        && g.camera.zoom === wz0b,
      'down=' + wyDown + ' up=' + wyUp + ' zoom=' + g.camera.zoom);
    // shift+wheel pans horizontally
    var wyS = g.camera.y; // y reference just before the shift+wheel
    var wx0 = g.camera.x;
    fireEv('wheel', { deltaY: 120, deltaMode: 0, ctrlKey: false, shiftKey: true,
      preventDefault: function () {} });
    var wxShift = g.camera.x - wx0; // captured before the ctrl+wheel below
    var wxPanned = Math.abs(wxShift - 120) < 0.5 && g.camera.y === wyS;
    // ctrl+wheel = pinch path: zooms at the cursor
    fireEv('wheel', { deltaY: -120, deltaMode: 0, ctrlKey: true, shiftKey: false,
      preventDefault: function () {} });
    var pinchZoom = g.camera.zoom > wz0b + 0.05;
    __check('wheel-shift-ctrl-zoom',
      wxPanned && pinchZoom && g.camera.zoom !== wz0b,
      'xShift=' + wxShift + ' zoom=' + g.camera.zoom);
    g.camera.zoom = 1;

    // (n7) top-bar zoom control: the slider sets camera.zoom centered on the
    // screen middle; the slider syncs back when the zoom changes elsewhere
    var zoomSliderEl = null;
    walkAll(document.getElementById('topbar'), function (el) {
      if (el.className === 'tb-zoom-slider') zoomSliderEl = el;
    });
    var zoomSliderOk = false, sliderSyncOk = false;
    if (zoomSliderEl) {
      zoomSliderEl.value = '1.5';
      (zoomSliderEl.listeners.input || []).forEach(function (f) { f({}); });
      zoomSliderOk = Math.abs(g.camera.zoom - 1.5) < 0.01;
      g.camera.zoom = 1.9; // zoom changed elsewhere -> the slider follows
      updateHud(g);
      sliderSyncOk = Math.abs(Number(zoomSliderEl.value) - 1.9) < 0.01;
    }
    __check('zoom-slider-sets-camera-zoom', !!zoomSliderEl && zoomSliderOk,
      'zoom=' + (g.camera && g.camera.zoom) + ' slider=' + !!zoomSliderEl);
    __check('zoom-slider-syncs-from-camera', sliderSyncOk,
      'value=' + (zoomSliderEl && zoomSliderEl.value));
    // (n7b) v0.9.1: exactly ONE zoom step per button click — the +/- handlers
    // were registered twice, so a single click zoomed 1.15^2 = 1.3225x
    var zInBtn = findBtn('topbar', '+');
    var zOutBtn = findBtn('topbar', '-');
    g.camera.zoom = 1;
    if (zInBtn) zInBtn.click();
    var zInOnce = Math.abs(g.camera.zoom - 1.15) < 0.001;
    if (zOutBtn) zOutBtn.click();
    var zOutOnce = Math.abs(g.camera.zoom - 1) < 0.001;
    __check('zoom-buttons-single-step', !!zInBtn && !!zOutBtn && zInOnce && zOutOnce,
      'zoom=' + (g.camera && g.camera.zoom) + ' inOnce=' + zInOnce
        + ' outOnce=' + zOutOnce);

    // (n8) Equal/Minus keyboard zoom at the screen middle
    var zk0 = g.camera.zoom;
    handleKey(g, keyEv('Equal'), true);
    var zkIn = g.camera.zoom;
    handleKey(g, keyEv('Minus'), true);
    handleKey(g, keyEv('Minus'), true);
    var zkOut = g.camera.zoom;
    __check('equal-minus-keys-zoom',
      zkIn > zk0 + 0.05 && zkOut < zkIn - 0.05,
      'z0=' + zk0 + ' in=' + zkIn + ' out=' + zkOut);
    g.camera.zoom = 1;

    // (n8b) v0.9.1: window blur clears held keys — alt-tab with an arrow key
    // down used to leave the camera panning forever (keyup lost to the other
    // window)
    g.keys.add('ArrowLeft'); g.keys.add('ArrowUp');
    var blurFired = (globalThis.windowListeners.blur || []).length > 0;
    (globalThis.windowListeners.blur || []).forEach(function (f) { f({}); });
    var blurOk = blurFired && g.keys.size === 0;
    g.keys.clear();
    __check('window-blur-clears-keys', blurOk, 'listeners=' + blurFired
      + ' keys=' + g.keys.size);

    // (n9) Esc clears the selection instead of opening the pause menu
    g.selection = [bu1.id, bu2.id];
    g.inspectId = 0;
    handleKey(g, { code: 'Escape' }, true);
    __check('esc-clears-selection',
      g.selection.length === 0 && g.overlay === null && g.paused === false,
      'sel=' + g.selection + ' overlay=' + g.overlay + ' paused=' + g.paused);

    // (t6) setStance anchor: re-anchors only for defensive (1) / hold (2)
    var stSa = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 139 });
    var uSa = addUnit(stSa, 'EG-01', 0, 10 * 64 + 32, 10 * 64 + 32);
    applyCommand(stSa, { player: 0, type: 'setStance', unitIds: [uSa.id], stance: 1 });
    var anchAx = uSa.guardX, anchAy = uSa.guardY;
    var defAnchored = anchAx === uSa.x && anchAy === uSa.y;
    stSa.units[uSa.id].x += 500; stSa.units[uSa.id].y += 500;
    applyCommand(stSa, { player: 0, type: 'setStance', unitIds: [uSa.id], stance: 0 });
    var aggKeeps = uSa.guardX === anchAx && uSa.guardY === anchAy;
    applyCommand(stSa, { player: 0, type: 'setStance', unitIds: [uSa.id], stance: 2 });
    var holdAnchored = uSa.guardX === uSa.x && uSa.guardY === uSa.y;
    var anchBx = uSa.guardX;
    stSa.units[uSa.id].x += 500;
    applyCommand(stSa, { player: 0, type: 'setStance', unitIds: [uSa.id], stance: 3 });
    var hfKeeps = uSa.guardX === anchBx;
    __check('stance-anchor-defensive-hold-only',
      defAnchored && aggKeeps && holdAnchored && hfKeeps,
      'def=' + defAnchored + ' aggKeeps=' + aggKeeps
        + ' hold=' + holdAnchored + ' hfKeeps=' + hfKeeps);

    // (t7) HUD heavy-scan gating (DeepSeek 3.2): 1x keeps one heavy scan per
    // sim tick; at 4x the scan counter follows ~10 Hz real time, not the tick
    runFrames(30);
    g.speed = 1; g.paused = false;
    var tk0 = g.state.tick, hs0 = g.hud.heavyScans;
    runFrames(60);
    var dTick1 = g.state.tick - tk0, dHeavy1 = g.hud.heavyScans - hs0;
    g.speed = 4;
    var tk1 = g.state.tick, hs1 = g.hud.heavyScans;
    runFrames(60); // ~40 sim ticks in ~1002 ms real -> at most ~12 scans
    var dTick4 = g.state.tick - tk1, dHeavy4 = g.hud.heavyScans - hs1;
    g.speed = 1;
    __check('hud-heavy-scan-gating',
      dHeavy1 >= dTick1 - 1 && dTick4 >= 30 && dHeavy4 >= 4 && dHeavy4 <= 13,
      '1x ticks=' + dTick1 + ' heavy=' + dHeavy1
        + ' | 4x ticks=' + dTick4 + ' heavy=' + dHeavy4);

    // (t10) army control panel (v0.5.1): live branch counts refresh on the
    // heavy cadence; 50% selects ceil(n/2) deterministic-lowest ids; Shift
    // adds instead of replacing; branches at 0 disable their buttons
    updateHud(g); // forced heavy pass: counts from the t5 units (2 infantry)
    var apRoot = document.getElementById('army-panel');
    var apRows = [];
    walkAll(apRoot, function (el) { if (el.className === 'ap-row') apRows.push(el); });
    var apBtns = function (row) {
      var bs = [];
      walkAll(row, function (el) {
        if ((el.className || '').indexOf('ap-btn') >= 0) bs.push(el);
      });
      return bs;
    };
    var apCnt = function (row) {
      var c = null;
      walkAll(row, function (el) { if (el.className === 'ap-count') c = el; });
      return c ? c.textContent : '';
    };
    var allDis = function (bs) {
      for (var di = 0; di < bs.length; di++) if (!bs[di].disabled) return false;
      return true;
    };
    var preDisabled = apRows.length === 3
      && allDis(apBtns(apRows[0])) && allDis(apBtns(apRows[1]))
      && !apBtns(apRows[2])[0].disabled; // infantry has the t5 pair
    for (var iAp = 0; iAp < 4; iAp++) {
      addUnit(g.state, 'EG-10', 0, 50 * 64 + iAp * 64, 50 * 64 + 32); // F-16C, Air
    }
    addUnit(g.state, 'EG-06', 0, 55 * 64 + 32, 55 * 64 + 32); // M60A3, Armor
    updateHud(g);
    var countsOk = apCnt(apRows[0]) === '×4' && apCnt(apRows[1]) === '×1'
      && apCnt(apRows[2]) === '×2';
    g.selection = [];
    apBtns(apRows[0])[1].click(); // air force 50%
    var halfOk = g.selection.length === 2 && g.selection.every(function (id) {
      var u = g.state.units[id];
      return u && g.state.unitDefs[u.defId].domain === 'Air';
    });
    var airIds = armyPick(g.state, 0, 'air', 1);
    var detOk = airIds.length === 4
      && g.selection[0] === airIds[0] && g.selection[1] === airIds[1];
    var infAll = apBtns(apRows[2])[2]; // infantry 100%, Shift held -> adds
    (infAll.listeners.click || []).forEach(function (f) { f({ shiftKey: true }); });
    var shiftOk = g.selection.length === 4
      && g.selection.indexOf(bu1.id) >= 0 && g.selection.indexOf(bu2.id) >= 0;
    __check('army-panel-fraction-select',
      preDisabled && countsOk && halfOk && detOk && shiftOk && g.hud.army.sig !== '',
      'pre=' + preDisabled + ' counts=' + apCnt(apRows[0]) + '/' + apCnt(apRows[1])
        + '/' + apCnt(apRows[2]) + ' half=' + halfOk + ' det=' + detOk
        + ' shift=' + g.selection.length);

    // (t8) AI defenders (step 2b) ignore neutral leftovers (owner -1) but
    // still engage a real hostile near the base
    var cfgAi2 = [{ slot: 0, faction: 'Egypt' },
      { slot: 1, faction: 'Algeria', ai: { personality: 'Front', difficulty: 'recruit' } }];
    var stAi2 = createMatch({ data: g.data, map: g.maps.sinai, players: cfgAi2, seed: 149 });
    var aiH2 = createAI(cfgAi2, 149);
    for (var iN2 = 0; iN2 < 120; iN2++) tick(stAi2, aiCommands(stAi2, aiH2));
    var cyN = null;
    for (var idN2 in stAi2.structures) {
      var sN2 = stAi2.structures[idN2];
      if (sN2.owner === 1 && sN2.defId === 'SH-01') cyN = sN2;
    }
    var ccN = cyN ? structCenter(cyN) : { x: 0, y: 0 };
    var defN1 = addUnit(stAi2, 'DZ-01', 1, ccN.x + 3 * 64, ccN.y);
    addUnit(stAi2, 'DZ-01', 1, ccN.x - 3 * 64, ccN.y);
    var neutN = addUnit(stAi2, 'EG-01', 0, ccN.x + 64, ccN.y);
    neutN.owner = -1; // dead player's leftover
    aiH2.brains[0].nextThink = 0;
    var cmdsN2 = aiCommands(stAi2, aiH2);
    var chasedNeutral = cmdsN2.some(function (c) { return c.type === 'attackMove'; });
    addUnit(stAi2, 'EG-01', 0, ccN.x + 2 * 64, ccN.y); // real hostile, same range
    aiH2.brains[0].nextThink = 0;
    var cmdsF2 = aiCommands(stAi2, aiH2);
    var engagedFoe = cmdsF2.some(function (c) {
      return c.type === 'attackMove' && c.unitIds.indexOf(defN1.id) >= 0;
    });
    __check('ai-defenders-ignore-neutral', !!cyN && !chasedNeutral && engagedFoe,
      'cy=' + !!cyN + ' chasedNeutral=' + chasedNeutral + ' engaged=' + engagedFoe);

    // (t11) 'auto' personality (v0.5.1): the brain re-evaluates doctrine every
    // think — 8 enemy air units with no AA cover flips it to 'sky'; an
    // overwhelming enemy army flips it to 'fortress'. b.personality itself is
    // never overwritten.
    var mkAuto = function (seed) {
      var cfgs = [{ slot: 0, faction: 'Egypt' },
        { slot: 1, faction: 'Algeria', ai: { personality: 'Auto', difficulty: 'recruit' } }];
      var st = createMatch({ data: g.data, map: g.maps.sinai, players: cfgs, seed: seed });
      var ai = createAI(cfgs, seed);
      for (var iMk = 0; iMk < 120; iMk++) tick(st, aiCommands(st, ai)); // deploy CY
      return { st: st, ai: ai };
    };
    var sAu = mkAuto(157);
    for (var iAu = 0; iAu < 8; iAu++) {
      addUnit(sAu.st, 'EG-10', 0, 40 * 64 + iAu * 64, 40 * 64 + 32);
    }
    sAu.ai.brains[0].nextThink = 0;
    aiCommands(sAu.st, sAu.ai);
    var docSky = sAu.ai.brains[0].doctrine;
    var sBu = mkAuto(163);
    for (var iBu = 0; iBu < 20; iBu++) {
      addUnit(sBu.st, 'EG-01', 0, 40 * 64 + iBu * 64, 44 * 64 + 32);
    }
    sBu.ai.brains[0].nextThink = 0;
    aiCommands(sBu.st, sBu.ai);
    var docFort = sBu.ai.brains[0].doctrine;
    __check('ai-auto-doctrine-flips',
      docSky === 'sky' && docFort === 'fortress'
        && sAu.ai.brains[0].personality === 'auto'
        && sBu.ai.brains[0].personality === 'auto',
      'sky=' + docSky + ' fortress=' + docFort);

    // (t9) queue strip label (DeepSeek 3.5): focused producer's name prefixes
    // the strip; the first-with-queue fallback dims it. Last: initHud here
    // reuses the shared stub elements the live match's HUD still references.
    var stL2 = createMatch({ data: g.data, map: g.maps.sinai,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 151 });
    addStructure(stL2, 'SH-01', 0, 8, 8);
    var raxL2 = addStructure(stL2, 'SH-04', 0, 40, 40);
    raxL2.queue.push({ unitId: 'EG-01', progress: 5, total: 10 });
    var gL2 = {
      state: stL2, playerSlot: 0, selection: [raxL2.id], pendingCmds: [],
      camera: null, placement: null, targeting: null, attackMoveArmed: false,
      patrolArmed: false, mouse: { sx: 0, sy: 0, inside: false },
      keys: new Set(), groups: {}, musicOn: false, minimap: null, dpr: 1,
      inspectId: 0, speed: 1, paused: false,
    };
    initHud(gL2);
    gL2.hud.activeTab = 'infantry'; gL2.hud.tabSig = '';
    updateHud(gL2);
    var lblEl = null;
    walkAll(gL2.hud.queue, function (el) {
      if ((el.className || '').indexOf('bb-queue-label') >= 0) lblEl = el;
    });
    var lblFocusedOk = !!lblEl && lblEl.textContent === 'Barracks queue:'
      && !lblEl.classList.contains('dim');
    gL2.selection = [];
    updateHud(gL2); // no focused producer -> first-with-queue fallback, dimmed
    var lblDimOk = !!lblEl && lblEl.textContent === 'Barracks queue:'
      && lblEl.classList.contains('dim');
    __check('queue-strip-producer-label', lblFocusedOk && lblDimOk,
      'focused=' + lblFocusedOk + ' dim=' + lblDimOk
        + ' text=' + (lblEl && lblEl.textContent));

    // (t12) setup screen (v0.5.1): the faction picker renders 9 cards inside
    // a .fac-strip scroller; 'Auto (adaptive)' is the default opponent
    // personality (display label, internal id 'Auto' stays in cfg)
    g.openMenu();
    findBtn('menu', 'Abandon match').click();
    var reallyS = findBtn('menu', 'Really abandon?');
    if (reallyS) reallyS.click();
    findBtn('menu', 'Skirmish').click();
    var stripEl = null, cardN = 0, autoOpt = null;
    walkAll(document.getElementById('menu'), function (el) {
      if (el.className === 'fac-strip') stripEl = el;
      if ((el.className || '').indexOf('fac-card') >= 0) cardN++;
      if (el.tagName === 'option' && el.textContent === 'Auto (adaptive)' && el.selected) {
        autoOpt = el;
      }
    });
    var stripKids = stripEl ? stripEl.children.length : 0;
    __check('faction-strip-9-cards-auto-default',
      !!stripEl && cardN === 9 && stripKids === 9 && !!autoOpt
        && autoOpt.value === 'Auto',
      'strip=' + !!stripEl + ' cards=' + cardN + ' kids=' + stripKids
        + ' autoDefault=' + (autoOpt && autoOpt.value));

    // ---- v0.7.1 match briefing overlay checks ---------------------------------

    // (b1) strip-card art (v0.9.0): portrait posters (art.factions) only —
    // the landscape briefing plate is reserved for the match briefing
    // overlay. The setup screen was left open by t12 — rebuild it after
    // injecting the packs so cards re-render.
    g.briefings = { Egypt: 'data:image/png;base64,BRF1' };
    g.art = { factions: { Egypt: 'data:image/png;base64,EGY1',
      Algeria: 'data:image/png;base64,OLD1' } };
    findBtn('menu', 'Back').click();
    findBtn('menu', 'Skirmish').click();
    var briefImgs = [], posterImgs = [], cardN2 = 0;
    walkAll(document.getElementById('menu'), function (el) {
      if ((el.className || '').indexOf('fac-card') >= 0) cardN2++;
      if (el.tagName === 'img' && (el.className || '').indexOf('fac-brief') >= 0) briefImgs.push(el);
      if (el.tagName === 'img' && (el.className || '').indexOf('fac-poster') >= 0) posterImgs.push(el);
    });
    __check('briefing-strip-card-art',
      cardN2 === 9 && briefImgs.length === 0 && posterImgs.length === 2
        && posterImgs[0].src === 'data:image/png;base64,EGY1'
        && posterImgs[1].src === 'data:image/png;base64,OLD1',
      'cards=' + cardN2 + ' brief=' + briefImgs.length
        + ' poster=' + posterImgs.length + '/' + (posterImgs[0] && posterImgs[0].src));

    // (b2) startMatch shows the overlay for the local faction (poster + DEPLOY
    // + hint) and gates the sim: no ticks while it is up
    findBtn('menu', 'Start match').click();
    var brEl = document.getElementById('briefing');
    var brImg = null, brDeploy = null, brHint = false;
    walkAll(brEl, function (el) {
      if (el.tagName === 'img' && (el.className || '').indexOf('brief-poster') >= 0) brImg = el;
      if (el.tagName === 'button' && el.textContent === 'DEPLOY ▶') brDeploy = el;
      if ((el.textContent || '') === 'click anywhere to continue') brHint = true;
    });
    var brShown = !brEl.classList.contains('hidden') && !!g.briefing
      && !!brImg && brImg.src === 'data:image/png;base64,BRF1' && !!brDeploy && brHint;
    runFrames(30); // ~500ms < 2.5s deadline: must still be up
    var brFrozen = g.state.tick === 0;
    __check('briefing-overlay-gates-sim', brShown && brFrozen,
      'shown=' + brShown + ' img=' + (brImg && brImg.src) + ' tick=' + g.state.tick);

    // (b3) click dismisses (the DEPLOY button path); ticking resumes
    if (brDeploy) brDeploy.click();
    var brGone = !g.briefing && brEl.classList.contains('hidden')
      && brEl.children.length === 0;
    runFrames(30);
    __check('briefing-click-dismiss-resumes', brGone && g.state.tick > 0,
      'gone=' + brGone + ' tick=' + g.state.tick);
    // (b3b) v0.9.1: dismiss removes BOTH listeners — the root click listener
    // used to leak (one permanent closure per match)
    var brClickLeft = (brEl.listeners.click || []).length;
    var brKeyLeft = (document.listeners.keydown || []).length;
    __check('briefing-dismiss-removes-listeners',
      brGone && brClickLeft === 0 && brKeyLeft === 0,
      'click=' + brClickLeft + ' keydown=' + brKeyLeft);

    // (b4) Esc dismisses through the document keydown listener and the
    // keypress is swallowed (stopImmediatePropagation) — no pause menu
    startMatch({ map: 'sinai', faction: 'Egypt',
      opponents: [{ faction: 'Algeria', personality: 'Front', difficulty: 'recruit' }] });
    var escStopped = false;
    var escEv = { code: 'Escape', preventDefault: function () {},
      stopImmediatePropagation: function () { escStopped = true; } };
    (document.listeners.keydown || []).forEach(function (f) { f(escEv); });
    runFrames(5);
    __check('briefing-esc-dismiss-no-pause',
      escStopped && !g.briefing && brEl.classList.contains('hidden')
        && g.paused === false && g.overlay === null && !menuVisible()
        && g.state.tick > 0,
      'stopped=' + escStopped + ' paused=' + g.paused + ' overlay=' + g.overlay
        + ' tick=' + g.state.tick);

    // (b5) auto-dismiss at the 2.5s deadline (headless clock via runFrames)
    startMatch({ map: 'sinai', faction: 'Egypt',
      opponents: [{ faction: 'Algeria', personality: 'Front', difficulty: 'recruit' }] });
    runFrames(100); // ~1670ms: still up, sim still gated
    var stillUp = !!g.briefing && g.state.tick === 0;
    runFrames(100); // ~3340ms total: past the deadline
    __check('briefing-auto-dismiss', stillUp && !g.briefing
      && brEl.classList.contains('hidden') && g.state.tick > 0,
      'up@1.7s=' + stillUp + ' tick=' + g.state.tick);

    // (b6) faction missing from the pack -> no overlay, immediate ticking
    startMatch({ map: 'sinai', faction: 'Algeria',
      opponents: [{ faction: 'Egypt', personality: 'Front', difficulty: 'recruit' }] });
    var noBrF = !g.briefing && brEl.classList.contains('hidden');
    runFrames(10);
    var tickF = g.state.tick;
    // (b7) empty pack (headless/dev default) -> same clean skip
    g.briefings = {};
    startMatch({ map: 'sinai', faction: 'Egypt',
      opponents: [{ faction: 'Algeria', personality: 'Front', difficulty: 'recruit' }] });
    var noBrE = !g.briefing && brEl.classList.contains('hidden')
      && brEl.children.length === 0;
    runFrames(10);
    __check('briefing-absent-skips-cleanly', noBrF && tickF > 0 && noBrE
      && g.state.tick > 0,
      'missingFaction=' + noBrF + '/' + tickF + ' emptyPack=' + noBrE
        + '/' + g.state.tick);
    g.art = {};

    // ================= v0.9.0 UX checks =================

    // (z1) zoom out more: the top-bar slider's min matches the new camera
    // floor and zoomCameraAt clamps to it (max stays 2.5)
    var zSl = null;
    walkAll(document.getElementById('topbar'), function (el) {
      if (el.className === 'tb-zoom-slider') zSl = el;
    });
    var zoomFloorOk = false;
    if (g.camera) {
      g.camera.zoom = 1;
      zoomCameraAt(g.camera, 0.01, 640, 400);
      var zMinOk = Math.abs(g.camera.zoom - 0.16) < 1e-9;
      zoomCameraAt(g.camera, 1000, 640, 400);
      zoomFloorOk = zMinOk && Math.abs(g.camera.zoom - 2.5) < 1e-9;
      g.camera.zoom = 1;
    }
    __check('zoom-min-016-slider-and-floor',
      !!zSl && String(zSl.min) === '0.16' && zoomFloorOk,
      'sliderMin=' + (zSl && zSl.min) + ' floorOk=' + zoomFloorOk);

    // (z2) right-click deselect: rmb on an own unit IN the selection removes
    // just it (no order issued); emptying the selection clears inspectId;
    // rmb on open map keeps the classic move order
    var mcvZ = null;
    for (var idZ in g.state.units) {
      if (g.state.units[idZ].owner === 0 && g.state.units[idZ].defId === 'MCV') mcvZ = g.state.units[idZ];
    }
    var mateZ = addUnit(g.state, 'EG-01', 0, mcvZ.x + 96, mcvZ.y);
    centerCameraOn(g.camera, mcvZ.x + 48, mcvZ.y);
    clampCameraToMap(g.camera, g.state.map.w * 64, g.state.map.h * 64);
    var cvZ = document.getElementById('game');
    var fireZ = function (type, ev) {
      (cvZ.listeners[type] || []).forEach(function (f) { f(ev); });
    };
    g.selection = [mcvZ.id, mateZ.id];
    g.inspectId = 0;
    var msZ = worldToScreen(g.camera, mateZ.x, mateZ.y);
    fireZ('mousemove', { clientX: msZ.x, clientY: msZ.y });
    var nCmdZ = g.pendingCmds.length;
    fireZ('mousedown', { button: 2, preventDefault: function () {} });
    fireZ('mouseup', { button: 2 });
    var deselOne = g.selection.length === 1 && g.selection[0] === mcvZ.id
      && g.pendingCmds.length === nCmdZ;
    g.inspectId = 4242;
    var msZ2 = worldToScreen(g.camera, mcvZ.x, mcvZ.y);
    fireZ('mousemove', { clientX: msZ2.x, clientY: msZ2.y });
    fireZ('mousedown', { button: 2, preventDefault: function () {} });
    fireZ('mouseup', { button: 2 });
    var deselTwo = g.selection.length === 0 && g.inspectId === 0
      && g.pendingCmds.length === nCmdZ;
    // rmb on open map with a selection still issues the move order
    var epZ = null;
    for (var syZ = 100; syZ < 780 && !epZ; syZ += 40) {
      for (var sxZ = 100; sxZ < 1200 && !epZ; sxZ += 40) {
        var wwZ = screenToWorld(g.camera, sxZ, syZ);
        if (!pickOwnAt(g, wwZ.x, wwZ.y)) epZ = { x: sxZ, y: syZ };
      }
    }
    g.selection = [mcvZ.id, mateZ.id];
    fireZ('mousemove', { clientX: epZ.x, clientY: epZ.y });
    fireZ('mousedown', { button: 2, preventDefault: function () {} });
    fireZ('mouseup', { button: 2 });
    var cmdZ2 = g.pendingCmds[g.pendingCmds.length - 1];
    var rmbMoveOk = epZ !== null && g.pendingCmds.length === nCmdZ + 1
      && cmdZ2.type === 'move' && cmdZ2.unitIds.indexOf(mcvZ.id) >= 0
      && g.selection.length === 2;
    g.pendingCmds.length = nCmdZ;
    delete g.state.units[mateZ.id];
    __check('rmb-deselect-own-unit', deselOne && deselTwo && rmbMoveOk,
      'one=' + deselOne + ' two=' + deselTwo + ' move=' + rmbMoveOk);

    // (z3) build bar: ONE row of 6 tiles (QWERTF) with flanking ‹ › arrows;
    // the arrows page tabs with >6 items (wrapping, like Tab) and disable
    // when everything fits a single page. NB: an earlier check re-inited the
    // HUD on the shared stub DOM (t9), so the arrows clicked here are g's own
    // (g.hud.pagePrev/Next); DOM presence is asserted by the walk below.
    addStructure(g.state, 'SH-01', 0, 8, 8);
    g.hud.activeTab = 'structures'; g.hud.tabSig = ''; g.hud.gridSig = '';
    updateHud(g);
    var bbPrev = g.hud.pagePrev, bbNext = g.hud.pageNext;
    var arrowsInDom = 0;
    walkAll(document.getElementById('buildbar'), function (el) {
      if ((el.className || '').indexOf('bb-arrow') === 0) arrowsInDom++;
    });
    var itemsZ = buildGridItems(g.state, g.state.players[0], 'structures');
    var pagesZ = Math.max(1, Math.ceil(itemsZ.length / 6));
    var nowrapCss = /\.bb-grid\s*\{[^}]*flex-wrap:\s*nowrap/.test(cssTxt);
    var gridOneRow = itemsZ.length > 6 && g.hud.grid.children.length === 6;
    var arrowsThere = !!bbPrev && !!bbNext && arrowsInDom >= 2
      && bbNext.disabled === false && pagesZ >= 2;
    if (bbNext) bbNext.click(); // -> page 1
    var pageFwd = g.hud.page === 1
      && g.hud.grid.children.length === Math.min(6, itemsZ.length - 6);
    if (bbNext) bbNext.click(); // wraps back to page 0
    var pageWrap = g.hud.page === 0;
    if (bbPrev) bbPrev.click(); // wraps to the last page
    var pageBack = g.hud.page === pagesZ - 1;
    if (bbPrev) bbPrev.click(); // back to page 0
    var tabPg0 = g.hud.page;
    if (g.hudNextPage) g.hudNextPage(); // Tab path still pages
    var tabOk = g.hud.page === (tabPg0 + 1) % pagesZ;
    if (bbPrev) bbPrev.click(); // restore page 0
    // a tab whose items all fit: arrows disable
    var realData = g.state.data;
    g.state.data = { structures: realData.structures.slice(0, 5),
      units: realData.units, factions: realData.factions };
    g.hud.tabSig = '';
    updateHud(g);
    var arrowsDisabled = !!bbPrev && bbPrev.disabled === true && bbNext.disabled === true
      && g.hud.page === 0;
    g.state.data = realData;
    g.hud.tabSig = '';
    updateHud(g);
    __check('buildgrid-one-row-arrows-page',
      nowrapCss && gridOneRow && arrowsThere && pageFwd && pageWrap && pageBack
        && tabOk && arrowsDisabled,
      'items=' + itemsZ.length + ' pages=' + pagesZ + ' row6=' + gridOneRow
        + ' nowrap=' + nowrapCss + ' dom=' + arrowsInDom + ' fwd=' + pageFwd
        + ' wrap=' + pageWrap + ' back=' + pageBack + ' tab=' + tabOk
        + ' dis=' + arrowsDisabled);

    // (z4) leave confirmation: beforeunload blocks ONLY during a live match
    // (menu / match over = no-op). The listener is called directly.
    var buLs = globalThis.windowListeners ? globalThis.windowListeners.beforeunload : null;
    var buInMatch = false, buInMenu = false, buAfterOver = false;
    if (buLs && buLs.length && g.state) {
      var evB1 = { preventDefault: function () { this.__pd = true; }, returnValue: 'unset' };
      buLs[buLs.length - 1](evB1);
      buInMatch = evB1.__pd === true && evB1.returnValue === '';
      var savedSt = g.state;
      g.state = null;
      var evB2 = { preventDefault: function () { this.__pd = true; }, returnValue: 'unset' };
      buLs[buLs.length - 1](evB2);
      buInMenu = evB2.__pd !== true && evB2.returnValue === 'unset';
      g.state = savedSt;
      var savedOver = g.state.over;
      g.state.over = true;
      var evB3 = { preventDefault: function () { this.__pd = true; }, returnValue: 'unset' };
      buLs[buLs.length - 1](evB3);
      buAfterOver = evB3.__pd !== true && evB3.returnValue === 'unset';
      g.state.over = savedOver;
    }
    __check('beforeunload-only-in-live-match', buInMatch && buInMenu && buAfterOver,
      'inMatch=' + buInMatch + ' menu=' + buInMenu + ' over=' + buAfterOver);

    // (z5) siren cadence per alert LOCATION: first wail immediate, the next
    // two re-arm after >=3s, everything after waits >=8s; a different cell is
    // independent. Drives real updateHud ticks against synthetic hits.
    var H5 = g.hud;
    H5.sirenEsc = {}; H5.sirenAt = {};
    var t5 = __now;
    var escOf = function () { return H5.sirenEsc['20,20'] || 0; };
    var hitZ = [];
    for (var i5 = 0; i5 < 6; i5++) hitZ.push(addUnit(g.state, 'EG-01', 0, 20 * 64 + 32, 20 * 64 + 32));
    __now = t5;       dealDamage(g.state, hitZ[0], 10, null); updateHud(g); var e1 = escOf() === 1;
    __now = t5 + 2000; dealDamage(g.state, hitZ[1], 10, null); updateHud(g); var e2 = escOf() === 1;
    __now = t5 + 3100; dealDamage(g.state, hitZ[2], 10, null); updateHud(g); var e3 = escOf() === 2;
    __now = t5 + 6100; dealDamage(g.state, hitZ[3], 10, null); updateHud(g); var e4 = escOf() === 3;
    __now = t5 + 9100; dealDamage(g.state, hitZ[4], 10, null); updateHud(g); var e5 = escOf() === 3;
    __now = t5 + 14200; dealDamage(g.state, hitZ[5], 10, null); updateHud(g); var e6 = escOf() === 4;
    // a fresh location fires immediately, even 100ms after the last siren
    var farZ = addUnit(g.state, 'EG-01', 0, 30 * 64 + 32, 30 * 64 + 32);
    __now = t5 + 14300; dealDamage(g.state, farZ, 10, null); updateHud(g);
    var e7 = (H5.sirenEsc['30,30'] || 0) === 1;
    __check('siren-cadence-0-3-3-8-per-location', e1 && e2 && e3 && e4 && e5 && e6 && e7,
      'esc=' + e1 + e2 + e3 + e4 + e5 + e6 + ' far=' + e7
        + ' n20=' + (H5.sirenEsc['20,20'] || 0));

    // (z6) faction strip: pointer drag-to-scroll with momentum + the classic
    // ‹ › arrows still wired. LAST check: the glide parks on the harness rAF
    // slot, so nothing that needs the game loop may run afterwards.
    g.openMenu();
    findBtn('menu', 'Abandon match').click();
    var reallyZ = findBtn('menu', 'Really abandon?');
    if (reallyZ) reallyZ.click();
    findBtn('menu', 'Skirmish').click();
    var stripZ = null, facPrevZ = null, facNextZ = null;
    walkAll(document.getElementById('menu'), function (el) {
      if (el.className === 'fac-strip') stripZ = el;
      if (el.className === 'fac-arrow' && el.textContent === '‹') facPrevZ = el;
      if (el.className === 'fac-arrow' && el.textContent === '›') facNextZ = el;
    });
    var tapOk = false, dragOk = false, momentumOk = false, settleOk = false, arrowOk = false;
    if (stripZ) {
      var fireS = function (type, ev) {
        (stripZ.listeners[type] || []).forEach(function (f) { f(ev); });
      };
      // a tap (press+release without movement) scrolls nothing
      stripZ.scrollLeft = 0;
      fireS('pointerdown', { clientX: 500, button: 0, pointerId: 1,
        preventDefault: function () {}, stopPropagation: function () {} });
      fireS('pointerup', { clientX: 500, pointerId: 1, preventDefault: function () {} });
      tapOk = stripZ.scrollLeft === 0 && !stripZ.classList.contains('dragging');
      // a real drag: scrollLeft follows the pointer ...
      fireS('pointerdown', { clientX: 400, button: 0, pointerId: 2,
        preventDefault: function () {}, stopPropagation: function () {} });
      __now += 16;
      fireS('pointermove', { clientX: 340, pointerId: 2, preventDefault: function () {} });
      __now += 16;
      fireS('pointermove', { clientX: 280, pointerId: 2, preventDefault: function () {} });
      dragOk = stripZ.scrollLeft === 120;
      // ... and releasing after a flick glides on (momentum), then settles
      fireS('pointerup', { clientX: 280, pointerId: 2, preventDefault: function () {} });
      var slUp = stripZ.scrollLeft;
      runFrames(4);
      momentumOk = stripZ.scrollLeft > slUp + 5;
      runFrames(90); // glide decays to rest
      var slRest = stripZ.scrollLeft;
      runFrames(10);
      settleOk = Math.abs(stripZ.scrollLeft - slRest) < 1;
      if (facPrevZ) {
        facPrevZ.click(); // scrollStrip(-1): stub falls back to scrollLeft
        arrowOk = stripZ.scrollLeft < slRest;
      }
    }
    __check('faction-strip-drag-momentum-arrows',
      !!stripZ && !!facPrevZ && !!facNextZ && tapOk && dragOk && momentumOk
        && settleOk && arrowOk,
      'strip=' + !!stripZ + ' tap=' + tapOk + ' drag=' + dragOk
        + ' momentum=' + momentumOk + ' settle=' + settleOk + ' arrow=' + arrowOk);

    // ---- v0.10.0 multiplayer chrome checks (offline stays untouched) --------
    // (m1) the main menu advertises MULTIPLAYER next to Skirmish. The last
    // journey left a finished/abandoned match state — force the plain menu.
    g.state = null;
    showMenu(g, function (c) { startMatch(c); });
    var mpBtn = findBtn('menu', 'Multiplayer');
    __check('mp-menu-button', !!mpBtn, 'button=' + !!mpBtn);

    // (m2) the lobby renders from an injected fake Net (no socket involved):
    // room code, both slot rows, the host's faction/team/delay selects, the
    // chat log, and an enabled START (guest slot is ready)
    var realNet = g.net;
    g.net = {
      active: true, isHost: true, code: 'TEST', slot: 0, url: 'ws://127.0.0.1:8790',
      name: 'Host', my: { faction: 'Egypt', team: 0, color: 0, ready: false },
      peers: { 1: { name: 'P2', faction: 'Algeria', team: 1, color: 1, ready: true } },
      cfg: { map: 'sinai', seed: 7, delay: 2 },
      lobbySlots: function () {
        return [{ slot: 0, name: 'Host', faction: 'Egypt', team: 0, color: 0, ready: false },
          { slot: 1, name: 'P2', faction: 'Algeria', team: 1, color: 1, ready: true }];
      },
      status: function () { return 'good'; },
    };
    g.lobby = { map: 'sinai', seed: 7, delay: 2 };
    g.mpChatLog = [{ name: 'P2', text: 'hi' }];
    showLobby(g);
    var lobbyStart = findBtn('menu', 'Start match');
    var lobbyCode = '', lobbyRows = 0, lobbyChat = false, lobbySelects = 0;
    walkAll(document.getElementById('menu'), function (el) {
      if (el.className === 'mp-code-big') lobbyCode = el.textContent;
      if (el.className === 'mp-slot-row') lobbyRows++;
      if (el.className === 'mp-chatline' && (el.textContent || '').indexOf('P2: hi') === 0) lobbyChat = true;
      if (el.tagName === 'select') lobbySelects++;
    });
    __check('mp-lobby-renders-fake-net',
      g.overlay === 'lobby' && lobbyCode === 'TEST' && lobbyRows === 2
        && lobbyChat === true && lobbySelects >= 3 // faction + team + delay
        && !!lobbyStart && lobbyStart.disabled === false,
      'code=' + lobbyCode + ' rows=' + lobbyRows + ' chat=' + lobbyChat
        + ' selects=' + lobbySelects + ' startDisabled=' + (lobbyStart && lobbyStart.disabled));

    // (m3) with a live MP match the speed buttons hide (locked 1x), the net
    // status shows, and restoring the offline net brings the buttons back
    startMatch({ mp: true, map: 'sinai', seed: 7, delay: 2, slot: 0,
      players: [{ slot: 0, faction: 'Egypt', team: 0 },
        { slot: 1, faction: 'Algeria', team: 1 }] });
    var mpSpeedsHidden = g.hud.speedBtns[1].style.display === 'none'
      && g.hud.speedBtns[2].style.display === 'none'
      && g.hud.speedBtns[4].style.display === 'none';
    var mpSpeedLocked = g.speed === 1;
    var mpNetShown = document.getElementById('net-status').style.display !== 'none';
    var mpLsLive = !!g.ls;
    g.net = realNet; // restore: back offline
    g.hudSyncSpeed();
    var spBack = g.hud.speedBtns[2].style.display !== 'none';
    __check('mp-hides-speed-shows-netstatus',
      mpSpeedsHidden && mpSpeedLocked && mpNetShown && spBack && mpLsLive,
      'hidden=' + mpSpeedsHidden + ' locked=' + mpSpeedLocked
        + ' netShown=' + mpNetShown + ' restored=' + spBack + ' ls=' + mpLsLive);
  } catch (e) {
    __smoke.errors.push('driver: ' + (e && e.stack || e));
  }
})();
JSON.stringify(__smoke);
"""

# v0.4.3: audio.js cannot join the big inline bundle (hud.js declares the same
# module-level names), so the throttle-reset check runs in its own context
# with a fake clock + speechSynthesis stub — same pattern as test_audio.py.
DRIVER_AUDIO_RESET = r"""
var __ar = { errors: [], checks: [] };
function __checkAr(name, cond, detail) {
  __ar.checks.push({ name: name, pass: !!cond, detail: String(detail || '') });
}
try {
  var __nowA = { t: 1000 };
  globalThis.performance = { now: function () { return __nowA.t; } };
  var __spokenA = [];
  globalThis.SpeechSynthesisUtterance = function (text) { this.text = text; };
  globalThis.speechSynthesis = { speak: function (u) { __spokenA.push(u); } };
  playVoice({}, 'Egypt', 'attack');
  playVoice({}, 'Egypt', 'attack');  // inside the 6s/key cooldown: dropped
  resetAudioThrottles();             // new match: cooldowns must clear
  playVoice({}, 'Egypt', 'attack');  // fires again immediately
  __checkAr('audio-throttle-reset', __spokenA.length === 2,
    'spoken=' + __spokenA.length);
} catch (e) { __ar.errors.push('audio-reset: ' + (e && e.stack || e)); }
JSON.stringify(__ar);
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
    # v0.7.2: chrome-skin checks assert against the real index.html <style>
    index_html = (CLIENT / "index.html").read_text(encoding="utf-8")
    m_css = re.search(r"<style>([\s\S]*?)</style>", index_html)
    ctx.eval(f"var __indexCss = {json.dumps(m_css.group(1) if m_css else '')};")
    ctx.eval(STUB_JS)
    ctx.eval(bundle)
    ctx.eval(DRIVER_BOOT)
    result = json.loads(ctx.eval(DRIVER_MAIN))
    ctx_audio = MiniRacer()
    ctx_audio.eval(inline(CLIENT / "src/game/audio.js"))
    result_audio = json.loads(ctx_audio.eval(DRIVER_AUDIO_RESET))
    result["checks"] += result_audio["checks"]
    result["errors"] += result_audio["errors"]
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
