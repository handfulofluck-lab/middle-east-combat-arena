# Render-agent tests (v0.3.7): unit readability radii/silhouettes, persistent
# order markers (move / attack-move / waypoint queue / patrol / attack-target /
# stance rings), gold rim for upgraded units, and never-throw robustness with
# missing fields. Pass-3 pack: dirArt strip frame selection + fallback chain,
# wreckArt husks/rubble with fade. v4 pack: explosion_strip frames, damagedArt
# standing states, cls-mapped projectile sprites. v5 pack: idleArt SH-01 idle
# strips (damaged state wins <=50% hp), loopArt ambient overlays (rotor /
# radar / steam / flag / pumpjack / wake / select) and play-once muzzle smoke.
# v6 pack: tileArt terrain tiles (sand/rock/water_0 bake), deterministic decal
# scatter (dune/rock/scrub/foam — pure x,y hash), land-adjacent-only foam, the
# floor(tick*2/10)%4 water-frame overlay, and the empty-pack flat-color path.
# DOM-stub harness patterned on run_smoke.py: a recording
# FakeCtx logs both method calls AND style-property sets into one stream.
# Usage: .venv/Scripts/python test_render.py
import json
import re
import sys
from pathlib import Path

from py_mini_racer import MiniRacer

CLIENT = Path(__file__).resolve().parent.parent / "client"
MODULES = [
    "src/sim/rng.js",
    "src/sim/state.js",
    "src/sim/path.js",
    "src/sim/combat.js",
    "src/sim/orders.js",
    "src/game/sprites.js",
    "src/game/camera.js",
    "src/game/placement.js",
    "src/game/render.js",
    "src/game/minimap.js",
]

STUB_JS = r"""
var __ctxMethods = ['fillRect','clearRect','strokeRect','beginPath','closePath',
  'moveTo','lineTo','arc','ellipse','fill','stroke','fillText','drawImage','save','restore',
  'setTransform','translate','scale','rotate','rect','setLineDash','putImageData'];
var __ctxProps = ['fillStyle','strokeStyle','lineWidth','globalAlpha','font',
  'textAlign','textBaseline','imageSmoothingEnabled'];
function FakeCtx(canvas) {
  this.canvas = canvas;
  this.calls = 0;
  this.log = []; // [method, args] or ['$prop', value] — one ordered stream
  var self = this;
  __ctxMethods.forEach(function (m) {
    self[m] = function () {
      self.calls++;
      self.log.push([m, Array.prototype.slice.call(arguments)]);
    };
  });
  __ctxProps.forEach(function (p) {
    var v;
    Object.defineProperty(self, p, {
      get: function () { return v; },
      set: function (nv) { v = nv; self.log.push(['$' + p, nv]); },
    });
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
  };
  el.addEventListener = function (t, f) { (el.listeners[t] = el.listeners[t] || []).push(f); };
  el.removeEventListener = function () {};
  el.appendChild = function (c) { el.children.push(c); return c; };
  el.setAttribute = function () {};
  el.getContext = function () {
    if (!el.__ctx) el.__ctx = new FakeCtx(el);
    return el.__ctx;
  };
  el.getBoundingClientRect = function () {
    return { left: 0, top: 0, width: el.width || 800, height: el.height || 600 };
  };
  return el;
}

var __createdEls = [];
globalThis.document = {
  createElement: function (t) { var el = FakeEl(t); __createdEls.push(el); return el; },
  createTextNode: function (t) { return { text: t }; },
  getElementById: function () { return FakeEl('div'); },
  body: FakeEl('body'),
  addEventListener: function () {},
};
globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.addEventListener = function () {};
// minimal Image stub for the unitArt hook: decodes synchronously
globalThis.Image = function () {
  var self = this;
  self.width = 32; self.height = 32; self.complete = false;
  Object.defineProperty(self, 'src', {
    set: function (v) { self._src = v; self.complete = true; },
    get: function () { return self._src; },
  });
};
"""

TEST_JS = r"""
function runRenderTests(data, duel) {
  const out = [];
  const errors = [];
  const check = (name, cond, detail) =>
    out.push({ name, pass: !!cond, detail: String(detail === undefined ? '' : detail) });

  // ---- log scanning helpers ------------------------------------------------
  // walk the ordered stream, tracking current style props; true when a call
  // to `method` matches pred(args, currentProps)
  function findCall(log, method, pred) {
    const cur = {};
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      if (e[0].charAt(0) === '$') { cur[e[0].slice(1)] = e[1]; continue; }
      if (e[0] === method && pred(e[1], cur)) return true;
    }
    return false;
  }
  const at = (x, y) => (a) => a[0] === x && a[1] === y;
  const near = (a, b) => Math.abs(a - b) < 0.01;
  // like findCall but returns the stream index (for draw-order assertions)
  function findIdx(log, method, pred) {
    const cur = {};
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      if (e[0].charAt(0) === '$') { cur[e[0].slice(1)] = e[1]; continue; }
      if (e[0] === method && pred(e[1], cur)) return i;
    }
    return -1;
  }

  function mkGame() {
    const st = createMatch({ data, map: JSON.parse(JSON.stringify(duel)),
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 7 });
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 800;
    const g = {
      state: st, playerSlot: 0, canvas, ctx: canvas.getContext('2d'), dpr: 1,
      camera: createCamera(1280, 800),
      selection: [], mouse: { sx: 0, sy: 0, inside: false },
      placement: null, targeting: null, attackMoveArmed: false, drag: null,
    };
    initRenderer(g);
    return g;
  }
  function render(g) {
    try { renderFrame(g); return true; }
    catch (e) { errors.push('renderFrame threw: ' + (e && e.stack || e)); return false; }
  }
  const ownUnit = (g, defId, x, y) => addUnit(g.state, defId, 0, x, y);

  // ---- T1: radius table + silhouette coverage -------------------------------
  {
    const spec = [
      ['Infantry', 'Land', 28], ['SF', 'Land', 28], ['Engineer', 'Land', 28],
      ['AT infantry', 'Land', 28], ['AA infantry', 'Land', 28],
      ['APC', 'Land', 36], ['Light vehicle', 'Land', 36], ['Mobile AA', 'Land', 36],
      ['IFV', 'Land', 38], ['Tank escort', 'Land', 38],
      ['Light tank', 'Land', 38], ['SPG', 'Land', 40], ['MLRS', 'Land', 40],
      ['Missile', 'Land', 40],
      ['MBT', 'Land', 46], ['MCV', 'Land', 44], ['Harvester', 'Land', 44],
      ['Attack helo', 'Air', 38], ['Transport helo', 'Air', 38],
      ['Fighter', 'Air', 40], ['Strike jet', 'Air', 40], ['UAV', 'Air', 36],
      ['Naval', 'Sea', 48],
    ];
    const bad = [];
    for (const [cls, dom, want] of spec) {
      const got = unitRadius({ cls, domain: dom, id: 'X', name: 'X' });
      if (got !== want) bad.push(cls + '=' + got + ' want ' + want);
    }
    check('radius-table', bad.length === 0, bad.join('; ') || spec.length + ' classes ok');

    // every real unit def (incl. synth MCV/HARV) maps to a known silhouette
    // and a sane radius
    const g = mkGame();
    const shapes = { circle: 1, rrect: 1, tank: 1, helo: 1, jet: 1, ship: 1, uav: 1 };
    const badDef = [];
    for (const id in g.state.unitDefs) {
      const d = g.state.unitDefs[id];
      const s = silhouetteForUnit(d), r = unitRadius(d);
      if (!shapes[s] || r < 28 || r > 48) badDef.push(id + ':' + s + '@' + r);
    }
    check('silhouette-coverage-real-defs', badDef.length === 0,
      badDef.join('; ') || Object.keys(g.state.unitDefs).length + ' defs ok');
    check('silhouette-spot-checks',
      silhouetteForUnit({ cls: 'Infantry', domain: 'Land' }) === 'circle'
        && silhouetteForUnit({ cls: 'APC', domain: 'Land' }) === 'rrect'
        && silhouetteForUnit({ cls: 'MBT', domain: 'Land' }) === 'tank'
        && silhouetteForUnit({ cls: 'Attack helo', domain: 'Air' }) === 'helo'
        && silhouetteForUnit({ cls: 'Fighter', domain: 'Air' }) === 'jet'
        && silhouetteForUnit({ cls: 'Naval', domain: 'Sea' }) === 'ship'
        && silhouetteForUnit({ cls: 'UAV', domain: 'Air' }) === 'uav',
      'per-archetype mapping');
  }

  // ---- T2: move marker = white ring 6px at the destination -----------------
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-01', 672, 672);
    g.selection = [u.id];
    applyCommand(g.state, { player: 0, type: 'move', unitIds: [u.id], x: 1056, y: 672 });
    const okR = render(g);
    const log = g.ctx.log;
    check('marker-move-white-ring', okR && findCall(log, 'arc',
      (a, c) => a[0] === 1056 && a[1] === 672 && a[2] === 6 && c.strokeStyle === '#ffffff'),
      'arc(1056,672,6) #ffffff');
  }

  // ---- T3: attackMove marker = red ring 8px + cross -------------------------
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-01', 672, 672);
    g.selection = [u.id];
    applyCommand(g.state, { player: 0, type: 'attackMove', unitIds: [u.id], x: 1056, y: 672 });
    const okR = render(g);
    const log = g.ctx.log;
    const ring = findCall(log, 'arc',
      (a, c) => a[0] === 1056 && a[1] === 672 && a[2] === 8 && c.strokeStyle === '#e53935');
    const cross = findCall(log, 'moveTo',
      (a, c) => a[0] === 1044 && a[1] === 672 && c.strokeStyle === '#e53935')
      && findCall(log, 'lineTo',
        (a, c) => a[0] === 1068 && a[1] === 672 && c.strokeStyle === '#e53935');
    check('marker-attackmove-red-cross', okR && ring && cross, 'ring=' + ring + ' cross=' + cross);
  }

  // ---- T4: shift-queued waypoints = numbered flags + dotted connector -------
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-01', 672, 672);
    g.selection = [u.id];
    applyCommand(g.state, { player: 0, type: 'move', unitIds: [u.id], x: 928, y: 672 });
    applyCommand(g.state, { player: 0, type: 'move', unitIds: [u.id], x: 1248, y: 672, queue: true });
    applyCommand(g.state, { player: 0, type: 'move', unitIds: [u.id], x: 1248, y: 864, queue: true });
    const okR = render(g);
    const log = g.ctx.log;
    const wpOk = g.state.units[u.id].waypoints
      && g.state.units[u.id].waypoints.join(',') === '1248,672,1248,864';
    const flag1 = findCall(log, 'fillText', (a) => a[0] === '1' && a[1] === 1252 && a[2] === 663);
    const flag2 = findCall(log, 'fillText', (a) => a[0] === '2' && a[1] === 1252 && a[2] === 855);
    const dotted = findCall(log, 'setLineDash', (a) => a[0] && a[0][0] === 3 && a[0][1] === 4);
    check('marker-waypoint-flags', okR && wpOk && flag1 && flag2 && dotted,
      'wp=' + wpOk + ' f1=' + flag1 + ' f2=' + flag2 + ' dotted=' + dotted);
  }

  // ---- T5: patrol = dashed teal line between the endpoints ------------------
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-01', 672, 672);
    g.selection = [u.id];
    applyCommand(g.state, { player: 0, type: 'patrol', unitIds: [u.id], x: 1056, y: 672 });
    const okR = render(g);
    const log = g.ctx.log;
    const teal = findCall(log, 'lineTo',
      (a, c) => a[0] === 1056 && a[1] === 672 && c.strokeStyle === '#26c6da');
    const dashed = findCall(log, 'setLineDash', (a) => a[0] && a[0][0] === 6 && a[0][1] === 4);
    check('marker-patrol-teal-dash', okR && teal && dashed, 'teal=' + teal + ' dash=' + dashed);
  }

  // ---- T6: stance rings amber/blue/grey for stances 1/2/3 -------------------
  {
    const g = mkGame();
    const u1 = ownUnit(g, 'EG-01', 672, 672);
    const u2 = ownUnit(g, 'EG-01', 800, 672);
    const u3 = ownUnit(g, 'EG-01', 928, 672);
    g.selection = [u1.id, u2.id, u3.id];
    applyCommand(g.state, { player: 0, type: 'setStance', unitIds: [u1.id], stance: 1 });
    applyCommand(g.state, { player: 0, type: 'setStance', unitIds: [u2.id], stance: 2 });
    applyCommand(g.state, { player: 0, type: 'setStance', unitIds: [u3.id], stance: 3 });
    const okR = render(g);
    const log = g.ctx.log;
    // EG-01 infantry r=28 -> ring at r+5=33
    const amber = findCall(log, 'arc',
      (a, c) => a[0] === 672 && a[1] === 672 && a[2] === 33 && c.strokeStyle === '#ffb300');
    const blue = findCall(log, 'arc',
      (a, c) => a[0] === 800 && a[1] === 672 && a[2] === 33 && c.strokeStyle === '#4da3ff');
    const grey = findCall(log, 'arc',
      (a, c) => a[0] === 928 && a[1] === 672 && a[2] === 33 && c.strokeStyle === '#9e9e9e');
    check('stance-ring-colors', okR && amber && blue && grey,
      'amber=' + amber + ' blue=' + blue + ' grey=' + grey);
  }

  // ---- T7: upgraded unit -> gold rim baked into its sprite, never throws ----
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-07', 672, 672); // MBT: tank silhouette
    u.upgradeName = 'Mk-II';
    g.selection = [u.id];
    const before = __createdEls.length;
    const okR = render(g);
    // the gold rim is drawn into the unit sprite canvas built this frame
    let rim = false;
    for (let i = before; i < __createdEls.length && !rim; i++) {
      const el = __createdEls[i];
      if (el.__ctx) {
        rim = findCall(el.__ctx.log, 'stroke',
          (a, c) => c.strokeStyle === '#ffd54a' && c.lineWidth === 6);
      }
    }
    check('upgrade-gold-rim', okR && rim, 'rim=' + rim);
  }

  // ---- T8: missing fields + dead attack target + idle -> no throw, no ring --
  {
    const g = mkGame();
    const uA = ownUnit(g, 'EG-01', 672, 672);
    delete uA.stance; uA.waypoints = undefined; uA.patrol = undefined;
    const uB = ownUnit(g, 'EG-01', 800, 672);
    uB.order = { type: 'attackTarget', x: 0, y: 0, targetId: 9999, enemyId: 0 }; // dead target
    const uC = ownUnit(g, 'EG-01', 928, 672); // idle
    g.selection = [uA.id, uB.id, uC.id];
    const okR = render(g);
    const ring = findCall(g.ctx.log, 'arc',
      (a, c) => a[2] === 6 && c.strokeStyle === '#ffffff');
    check('missing-fields-no-throw', okR && !ring, 'threw=' + !okR + ' strayRing=' + ring);
  }

  // ---- T9: sprite draw order = silhouette fill, label, then owner stroke ----
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-07', 672, 672); // MBT: tank sprite keyed by label 'M6'
    const col = ownerColorOf(g.state, 0);
    const before = __createdEls.length;
    render(g);
    // the tank sprite built during this frame (tank trace uses 'rect')
    let spr = null;
    for (let i = before; i < __createdEls.length; i++) {
      const el = __createdEls[i];
      if (el.__ctx && findCall(el.__ctx.log, 'rect', () => true)) spr = el;
    }
    let orderOk = false, detail = 'no-sprite';
    if (spr) {
      const log = spr.__ctx.log;
      const cur = {};
      let iFill = -1, iText = -1, iStroke = -1;
      for (let i = 0; i < log.length; i++) {
        const e = log[i];
        if (e[0].charAt(0) === '$') { cur[e[0].slice(1)] = e[1]; continue; }
        if (e[0] === 'fill' && iFill < 0 && cur.fillStyle === col) iFill = i;
        if (e[0] === 'fillText' && iFill >= 0 && iText < 0) iText = i;
        if (e[0] === 'stroke' && iText >= 0
          && cur.strokeStyle === col && cur.lineWidth === 2) { iStroke = i; break; }
      }
      orderOk = iFill >= 0 && iText > iFill && iStroke > iText;
      detail = 'fill@' + iFill + ' text@' + iText + ' stroke@' + iStroke;
    }
    // and the main ctx blitted that sprite centered on the unit
    const blitted = !!spr && findCall(g.ctx.log, 'drawImage',
      (a) => a[0] === spr && a[1] === 672 - spr.width / 2 && a[2] === 672 - spr.height / 2);
    check('draw-order-fill-label-stroke', orderOk && blitted, detail + ' blit=' + blitted);
  }

  // ---- T10: markers culled to the viewport ----------------------------------
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-01', 672, 672);
    g.selection = [u.id];
    applyCommand(g.state, { player: 0, type: 'move', unitIds: [u.id], x: 5000, y: 5000 });
    const okR = render(g);
    const ring = findCall(g.ctx.log, 'arc',
      (a, c) => a[0] === 5000 && a[1] === 5000 && a[2] === 6 && c.strokeStyle === '#ffffff');
    check('marker-offscreen-culled', okR && !ring, 'ringDrawn=' + ring);
  }

  // ---- T11: attackTarget = red chevrons over the target entity --------------
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-06', 672, 672); // light tank
    const foe = addUnit(g.state, 'DZ-01', 1, 928, 672);
    g.selection = [u.id];
    applyCommand(g.state, { player: 0, type: 'attackTarget', unitIds: [u.id], targetId: foe.id });
    const okR = render(g);
    const log = g.ctx.log;
    const chev = findCall(log, 'lineTo',
      (a, c) => a[0] === 928 && a[1] === 653 && c.strokeStyle === '#e53935');
    check('marker-attacktarget-chevrons', okR && chev, 'chevron=' + chev);
  }

  // ---- T12: big silhouettes don't pop in at the viewport edge --------------
  // MBT r=46 -> sprite half 52; the cull margin (80) must cover it
  {
    const g = mkGame();
    g.camera.x = 200; g.camera.y = 200;
    const u = ownUnit(g, 'EG-07', 200 - 60, 400); // 60px left of the view edge
    const okR = render(g);
    const blit = findCall(g.ctx.log, 'drawImage',
      (a) => Math.round(a[1]) === Math.round(u.x - a[0].width / 2)
        && Math.round(a[2]) === Math.round(400 - a[0].height / 2));
    check('big-unit-no-edge-popin', okR && !!blit, 'blit=' + blit);
  }

  // ---- T13: team-color ring under the silhouette ----------------------------
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-01', 760, 700); // infantry, r=28 (off the 672,672 spawn)
    const col = ownerColorOf(g.state, 0);
    const okR = render(g);
    const log = g.ctx.log;
    // ellipse at (x, y + r*0.85) radius r*0.7, 3px owner color
    const ringIdx = findIdx(log, 'ellipse',
      (a, c) => near(a[0], 760) && near(a[1], 700 + 28 * 0.85)
        && near(a[2], 28 * 0.7) && c.strokeStyle === col && c.lineWidth === 3);
    // and it must be drawn BEFORE the silhouette blit for this unit
    const blitIdx = findIdx(log, 'drawImage',
      (a) => a[0] && a[0].width && near(a[1], 760 - a[0].width / 2)
        && near(a[2], 700 - a[0].height / 2));
    check('team-ring-under-silhouette', okR && ringIdx >= 0 && blitIdx > ringIdx,
      'ring@' + ringIdx + ' blit@' + blitIdx);
  }

  // ---- T14: death FX on vanish; MCV deploy excluded; bigger struct ring ----
  {
    const g = mkGame();
    const col = ownerColorOf(g.state, 0);
    const u = ownUnit(g, 'EG-07', 672, 672);  // MBT r=46
    const mcv = addUnit(g.state, 'MCV', 0, 928, 672);
    const s = addStructure(g.state, 'SH-02', 0, 6, 8); // power plant
    const spx = (s.cx + s.fp / 2) * 64, spy = (s.cy + s.fp / 2) * 64;
    const half = s.fp * 64 / 2 - 3;
    const okR1 = render(g); // snapshot prevUnits/prevStructs
    delete g.state.units[u.id];
    delete g.state.units[mcv.id]; // deploy-style deletion: legit, no FX
    delete g.state.structures[s.id];
    g.state.tick += 1; // v0.9.1: the FX diff runs once per sim tick
    const okR2 = render(g);
    const log = g.ctx.log;
    const unitRing = findCall(log, 'arc',
      (a, c) => near(a[0], 672) && near(a[1], 672) && a[2] >= 46
        && c.strokeStyle === col && c.lineWidth === 3);
    const wreck = findCall(log, 'moveTo',
      (a, c) => near(a[0], 672 - 46 * 0.55) && String(c.strokeStyle).indexOf('rgba(20,16,12') === 0);
    const mcvRing = findCall(log, 'arc',
      (a, c) => near(a[0], 928) && near(a[1], 672) && c.strokeStyle === col && c.lineWidth === 3);
    const structRing = findCall(log, 'arc',
      (a, c) => near(a[0], spx) && near(a[1], spy) && a[2] >= half
        && c.strokeStyle === col && c.lineWidth === 3);
    check('death-fx-unit-ring-wreck', okR1 && okR2 && unitRing && wreck,
      'ring=' + unitRing + ' wreck=' + wreck);
    check('death-fx-mcv-excluded', okR2 && !mcvRing, 'mcvRing=' + mcvRing);
    check('death-fx-structure-ring', okR2 && structRing,
      'ring@(' + spx + ',' + spy + ') half=' + half);
  }

  // ---- T15: damage numbers on hp drop, aggregated within 10 ticks ----------
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-01', 672, 672);
    const okR1 = render(g); // snapshot hp
    u.hp -= 50;
    g.state.tick += 1; // v0.9.1: hp drops are detected by the per-tick diff
    render(g);
    const n1 = findCall(g.ctx.log, 'fillText',
      (a, c) => a[0] === '-50' && a[1] === 672 && c.fillStyle === '#ffe9a0');
    u.hp -= 30; // next tick inside the 10-tick window -> aggregates
    g.state.tick += 1;
    render(g);
    const n2 = findCall(g.ctx.log, 'fillText',
      (a, c) => a[0] === '-80' && a[1] === 672 && c.fillStyle === '#ffe9a0');
    check('damage-number-spawn', okR1 && n1, 'n1=' + n1);
    check('damage-number-aggregates', n2, 'n2=' + n2);
  }

  // ---- T16: muzzle flash + impact spark + barrel recoil from a tracer ------
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-07', 800, 700); // MBT: tank barrel, r=46 (off spawn)
    const pid = g.state.nextId++;
    g.state.projectiles[pid] = { id: pid, owner: 0, kind: 'tracer',
      sx: u.x, sy: u.y, x: u.x, y: u.y, tx: u.x + 200, ty: u.y,
      total: 6, ticksLeft: 6 };
    const okR = render(g);
    const log = g.ctx.log;
    const flash = findCall(log, 'arc',
      (a, c) => near(a[0], 800) && near(a[1], 700) && a[2] === 6
        && String(c.fillStyle).indexOf('rgba(255,255,255') === 0);
    const spark = findCall(log, 'moveTo',
      (a, c) => near(a[0], 1000) && near(a[1], 700)
        && String(c.strokeStyle).indexOf('rgba(255,214,64') === 0);
    // idle order -> barrel points north; recoil len = 46*1.15*0.75 = 39.675
    const recoiled = findCall(log, 'lineTo',
      (a, c) => near(a[0], 800) && near(a[1], 700 - 39.675)
        && c.strokeStyle === 'rgba(0,0,0,0.55)');
    check('tracer-flash-spark', okR && flash && spark,
      'flash=' + flash + ' spark=' + spark);
    check('barrel-recoil-shortens', okR && recoiled, 'recoiled=' + recoiled);
    // 4 ticks later the recoil has expired -> full-length barrel (52.9)
    g.state.tick += 4;
    delete g.state.projectiles[pid];
    render(g);
    const restored = findCall(g.ctx.log, 'lineTo',
      (a, c) => near(a[0], 800) && near(a[1], 700 - 52.9)
        && c.strokeStyle === 'rgba(0,0,0,0.55)');
    check('barrel-recoil-restores', restored, 'restored=' + restored);
  }

  // ---- T17: minimap class shapes --------------------------------------------
  {
    const g = mkGame();
    initMinimap(g);
    const inf = ownUnit(g, 'EG-01', 640, 640);
    const veh = ownUnit(g, 'EG-07', 704, 640);
    let airDef = null, seaDef = null;
    for (const id in g.state.unitDefs) {
      const d = g.state.unitDefs[id];
      if (!airDef && d.domain === 'Air') airDef = d;
      if (!seaDef && d.domain === 'Sea') seaDef = d;
    }
    const air = addUnit(g.state, airDef.id, 0, 768, 640);
    const sea = addUnit(g.state, seaDef.id, 0, 832, 640);
    updateMinimap(g);
    const log = g.minimap.ctx.log;
    const fxr = 220 / (g.state.map.w * 64), fyr = 180 / (g.state.map.h * 64);
    const airOk = findCall(log, 'moveTo',
      (a) => near(a[0], air.x * fxr) && near(a[1], air.y * fyr - 2.6));
    const seaOk = findCall(log, 'moveTo',
      (a) => near(a[0], sea.x * fxr) && near(a[1], sea.y * fyr - 3));
    const infOk = findCall(log, 'fillRect',
      (a) => near(a[0], inf.x * fxr - 0.5) && near(a[1], inf.y * fyr - 0.5)
        && a[2] === 1 && a[3] === 1);
    const vehOk = findCall(log, 'fillRect',
      (a) => near(a[0], veh.x * fxr - 1) && near(a[1], veh.y * fyr - 1)
        && a[2] === 2 && a[3] === 2);
    check('minimap-class-shapes', airOk && seaOk && infOk && vehOk,
      'air=' + airOk + ' sea=' + seaOk + ' inf=' + infOk + ' veh=' + vehOk);
  }

  // ---- T18: unitArt data-URI hook replaces the silhouette -------------------
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-01', 672, 672);
    const uri = 'data:image/png;base64,AAAA';
    g.unitArt = { 'EG-01': uri };
    const okR = render(g);
    const log = g.ctx.log;
    const artBlit = findCall(log, 'drawImage', (a) => a[0] && a[0]._src === uri);
    const col = ownerColorOf(g.state, 0);
    const ring = findCall(log, 'ellipse',
      (a, c) => near(a[0], 672) && c.strokeStyle === col && c.lineWidth === 3);
    check('unitart-bitmap-blits', okR && artBlit && ring,
      'blit=' + artBlit + ' ring=' + ring);
    // hook off -> procedural sprite fallback
    g.unitArt = null;
    render(g);
    const proc = findCall(g.ctx.log, 'drawImage',
      (a) => a[0] && a[0].tagName === 'canvas' && a[0].width
        && near(a[1], 672 - a[0].width / 2) && near(a[2], 672 - a[0].height / 2));
    check('unitart-procedural-fallback', proc, 'proc=' + proc);
  }

  // ---- T19: fog seen-alpha is 90 (was 130) ----------------------------------
  // v0.9.1: the fog canvas is 4px/cell — a cell's alpha lives at the top-left
  // pixel of its 4x4 block
  {
    const g = mkGame();
    render(g);
    const fog = g.state.fog[0];
    let idx = -1;
    for (let i = 0; i < fog.seen.length; i++) {
      if (!fog.visible[i]) { idx = i; break; } // unexplored cell
    }
    fog.seen[idx] = 1; // explored-but-not-visible
    g.render.fogTick = -1; // force the fog canvas to repaint
    const okR = render(g);
    const S = g.render.fogScale, fw = g.state.map.w;
    const fcx = idx % fw, fcy = Math.floor(idx / fw);
    const alpha = g.render.fogImg.data[(fcy * S * fw * S + fcx * S) * 4 + 3];
    let bad = 0;
    const d = g.render.fogImg.data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] !== 0 && d[i] !== 90 && d[i] !== 255) bad++;
    }
    check('fog-seen-alpha-90', okR && alpha === 90 && bad === 0,
      'alpha=' + alpha + ' bad=' + bad);
  }

  // ---- T20: structArt bitmap at footprint size + owner bar + fallback ------
  {
    const g = mkGame();
    const uri = 'data:image/png;base64,ST02';
    g.structArt = { 'SH-02': uri };
    const s = addStructure(g.state, 'SH-02', 0, 6, 8);
    const px = (s.cx + s.fp / 2) * 64, py = (s.cy + s.fp / 2) * 64;
    const size = s.fp * 64, half = s.fp * 64 / 2 - 3;
    const col = ownerColorOf(g.state, 0);
    const okR = render(g);
    const log = g.ctx.log;
    const blit = findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === uri && near(a[1], px - size / 2)
        && near(a[2], py - size / 2) && near(a[3], size) && near(a[4], size));
    const bar = findCall(log, 'fillRect',
      (a, c) => near(a[0], px - half) && near(a[1], py + half + 2)
        && near(a[2], half * 2) && a[3] === 3 && c.fillStyle === col);
    check('structart-bitmap-blits', okR && blit && bar,
      'blit=' + blit + ' bar=' + bar);
    // def missing from the pack -> procedural silhouette + code label
    const s2 = addStructure(g.state, 'SH-01', 0, 14, 8);
    const px2 = (s2.cx + s2.fp / 2) * 64, py2 = (s2.cy + s2.fp / 2) * 64;
    render(g);
    const label = findCall(g.ctx.log, 'fillText',
      (a, c) => a[1] === px2 && a[2] === py2 && c.fillStyle === '#fff');
    const noBlit = !findCall(g.ctx.log, 'drawImage',
      (a) => a[0] && a[0]._src && near(a[1], px2 - s2.fp * 32) && near(a[2], py2 - s2.fp * 32));
    check('structart-procedural-fallback', label && noBlit,
      'label=' + label + ' noBlit=' + noBlit);
  }

  // ---- T21: dirArt strip frame from the order heading, last frame kept ---
  {
    const g = mkGame();
    const uri = 'data:image/png;base64,STRIP1';
    g.dirArt = { 'EG-01': { strip: uri, fw: 48, frames: 8 } };
    const u = ownUnit(g, 'EG-01', 760, 700); // infantry r=28, off the spawn
    const okR1 = render(g); // idle: heading north -> frame 0, no rotate
    const log1 = g.ctx.log;
    const blitN = findCall(log1, 'drawImage',
      (a) => a[0] && a[0]._src === uri && a.length === 9
        && a[1] === 0 && a[2] === 0 && a[3] === 48
        && near(a[5], 760 - 28) && near(a[6], 700 - 28)
        && near(a[7], 56) && near(a[8], 56));
    const noRot1 = !findCall(log1, 'rotate', () => true);
    check('dirart-idle-north-frame0', okR1 && blitN && noRot1,
      'blitN=' + blitN + ' noRotate=' + noRot1);
    // east-bound order: heading 0 -> frame 2 at sx = 2*fw; ring before blit
    const mark = g.ctx.log.length;
    applyCommand(g.state, { player: 0, type: 'move', unitIds: [u.id], x: 760 + 384, y: 700 });
    u.hp -= 10; // force the hp bar
    const okR2 = render(g);
    const log2 = g.ctx.log.slice(mark);
    const blitIdxE = findIdx(log2, 'drawImage',
      (a) => a[0] && a[0]._src === uri && a.length === 9
        && a[1] === 2 * 48 && a[2] === 0 && a[3] === 48
        && near(a[5], 760 - 28) && near(a[6], 700 - 28));
    const ringIdx = findIdx(log2, 'ellipse',
      (a, c) => near(a[0], 760) && c.lineWidth === 3);
    const barW = Math.max(26, Math.round(28 * 1.4));
    const barIdx = findIdx(log2, 'fillRect',
      (a) => near(a[0], 760 - barW / 2) && near(a[1], 700 - 28 - 8));
    const noRot2 = !findCall(log2, 'rotate', () => true);
    check('dirart-east-order-frame2',
      okR2 && blitIdxE > 0 && ringIdx >= 0 && ringIdx < blitIdxE
        && barIdx > blitIdxE && noRot2,
      'blit@' + blitIdxE + ' ring@' + ringIdx + ' bar@' + barIdx + ' noRotate=' + noRot2);
    // idle again -> keeps the last frame (still 2, no frame-0 blit this frame)
    u.order = { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
    const mark2 = g.ctx.log.length;
    render(g);
    const log3 = g.ctx.log.slice(mark2);
    const kept = findCall(log3, 'drawImage',
      (a) => a[0] && a[0]._src === uri && a.length === 9 && a[1] === 2 * 48);
    const reset = findCall(log3, 'drawImage',
      (a) => a[0] && a[0]._src === uri && a.length === 9 && a[1] === 0);
    check('dirart-idle-keeps-frame', kept && !reset, 'kept=' + kept + ' reset=' + reset);
  }

  // ---- T22: dirArt frame-index formula, all 8 headings --------------------
  {
    const fi = (h) => ((Math.round((h + Math.PI / 2) / (Math.PI / 4)) % 8) + 8) % 8;
    const cases = [
      ['N', -Math.PI / 2, 0], ['NE', -Math.PI / 4, 1], ['E', 0, 2],
      ['SE', Math.PI / 4, 3], ['S', Math.PI / 2, 4], ['SW', 3 * Math.PI / 4, 5],
      ['W', Math.PI, 6], ['NW', -3 * Math.PI / 4, 7],
    ];
    const bad = [];
    for (const [name, h, want] of cases) {
      const got = fi(h);
      if (got !== want) bad.push(name + '=' + got + ' want ' + want);
    }
    if (fi(-Math.PI) !== 6) bad.push('W(-pi)=' + fi(-Math.PI)); // wrap-around
    check('dirart-frame-index-8-headings', bad.length === 0,
      bad.join('; ') || 'N0 NE1 E2 SE3 S4 SW5 W6 NW7');
  }

  // ---- T23: art fallback chain: dirArt strip > unitArt rotate > procedural
  {
    const g = mkGame();
    const stripUri = 'data:image/png;base64,CHAIN1';
    const singleUri = 'data:image/png;base64,CHAIN2';
    g.dirArt = { 'EG-01': { strip: stripUri, fw: 40, frames: 8 } };
    g.unitArt = { 'EG-01': singleUri, 'EG-06': singleUri };
    ownUnit(g, 'EG-01', 700, 700); // both packs -> strip wins
    ownUnit(g, 'EG-06', 800, 700); // unitArt only -> legacy rotate path
    ownUnit(g, 'EG-07', 900, 700); // neither -> procedural sprite
    const okR = render(g);
    const log = g.ctx.log;
    const stripUsed = findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === stripUri && a.length === 9
        && near(a[5], 700 - 28) && near(a[6], 700 - 28));
    const rotateUsed = findCall(log, 'rotate', () => true);
    const singleUsed = findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === singleUri);
    const proc = findCall(log, 'drawImage',
      (a) => a[0] && a[0].tagName === 'canvas' && a[0].width
        && near(a[1], 900 - a[0].width / 2) && near(a[2], 700 - a[0].height / 2));
    check('art-fallback-chain', okR && stripUsed && singleUsed && rotateUsed && proc,
      'strip=' + stripUsed + ' single=' + singleUsed + ' rotate=' + rotateUsed
        + ' proc=' + proc);
    // strip path never falls back to the single bitmap for the same defId
    const wrongSrc = findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === singleUri && a.length === 9);
    check('art-fallback-strip-wins', !wrongSrc, 'wrongSrc=' + wrongSrc);
  }

  // ---- T24: wreckArt husk (2r) + rubble (fp*CELL), fade, boom on top ------
  {
    const g = mkGame();
    const wUriU = 'data:image/png;base64,WRECKU';
    const wUriS = 'data:image/png;base64,WRECKS';
    g.wreckArt = { 'EG-07': wUriU, 'SH-02': wUriS };
    const col = ownerColorOf(g.state, 0);
    const u = ownUnit(g, 'EG-07', 672, 672); // MBT r=46
    const s = addStructure(g.state, 'SH-02', 0, 6, 8); // fp 3 -> 192px rubble
    const px = (s.cx + s.fp / 2) * 64, py = (s.cy + s.fp / 2) * 64;
    const okR1 = render(g); // snapshot prevUnits/prevStructs
    delete g.state.units[u.id];
    delete g.state.structures[s.id];
    g.state.tick += 1; // v0.9.1: the FX diff runs once per sim tick
    const m1 = g.ctx.log.length;
    const okR2 = render(g);
    const log1 = g.ctx.log.slice(m1);
    const huskIdx = findIdx(log1, 'drawImage',
      (a) => a[0] && a[0]._src === wUriU && near(a[1], 672 - 46) && near(a[2], 672 - 46)
        && near(a[3], 92) && near(a[4], 92));
    const rubble = findCall(log1, 'drawImage',
      (a) => a[0] && a[0]._src === wUriS && near(a[1], px - 96) && near(a[2], py - 96)
        && near(a[3], 192) && near(a[4], 192));
    // explosion ring (no fxArt here) still plays ON TOP of the husk
    const ringIdx = findIdx(log1, 'arc',
      (a, c) => near(a[0], 672) && near(a[1], 672) && a[2] >= 46
        && c.strokeStyle === col && c.lineWidth === 3);
    const noHulkX = !findCall(log1, 'moveTo',
      (a, c) => near(a[0], 672 - 46 * 0.55)
        && String(c.strokeStyle).indexOf('rgba(20,16,12') === 0);
    check('wreckart-unit-husk-2r', okR1 && okR2 && huskIdx >= 0 && ringIdx > huskIdx && noHulkX,
      'husk@' + huskIdx + ' ring@' + ringIdx + ' noHulkX=' + noHulkX);
    check('wreckart-structure-rubble', rubble, 'rubble=' + rubble);
    // 10-tick fade-out: 40 ticks in -> 5 left -> alpha 0.5 on the husk blit
    g.state.tick += 40;
    const m2 = g.ctx.log.length;
    render(g);
    const faded = findCall(g.ctx.log.slice(m2), 'drawImage',
      (a, c) => a[0] && a[0]._src === wUriU && near(c.globalAlpha, 0.5));
    check('wreckart-fade-out', faded, 'faded=' + faded);
    // 45-tick persistence: gone 6 ticks later
    g.state.tick += 6;
    const m3 = g.ctx.log.length;
    render(g);
    const gone = !findCall(g.ctx.log.slice(m3), 'drawImage',
      (a) => a[0] && (a[0]._src === wUriU || a[0]._src === wUriS));
    check('wreckart-expires-45', gone, 'gone=' + gone);
  }

  // ---- T25: wreck procedural fallback when wreckArt has no entry ----------
  {
    const g = mkGame();
    g.wreckArt = { 'EG-01': 'data:image/png;base64,WRECKX' }; // not EG-07/SH-02
    const u = ownUnit(g, 'EG-07', 672, 672);
    const s = addStructure(g.state, 'SH-02', 0, 6, 8);
    const spx = (s.cx + s.fp / 2) * 64, spy = (s.cy + s.fp / 2) * 64;
    const shalf = s.fp * 64 / 2 - 3;
    const okR1 = render(g);
    delete g.state.units[u.id];
    delete g.state.structures[s.id];
    g.state.tick += 1; // v0.9.1: the FX diff runs once per sim tick
    const m1 = g.ctx.log.length;
    const okR2 = render(g);
    const hulk = findCall(g.ctx.log.slice(m1), 'moveTo',
      (a, c) => near(a[0], 672 - 46 * 0.55)
        && String(c.strokeStyle).indexOf('rgba(20,16,12') === 0);
    check('wreckart-procedural-fallback', okR1 && okR2 && hulk, 'hulk=' + hulk);
    // structures get NO procedural hulk (ring + smoke only, as before the pack)
    const structHulk = findCall(g.ctx.log.slice(m1), 'moveTo',
      (a, c) => near(a[0], spx - shalf * 0.55)
        && String(c.strokeStyle).indexOf('rgba(20,16,12') === 0);
    check('wreckart-no-procedural-rubble', !structHulk, 'structHulk=' + structHulk);
  }

  // ---- T26: explosion_strip 10 frames over 20 ticks, real bitmap dims -----
  {
    const g = mkGame();
    const stripUri = 'data:image/png;base64,EXPLSTRIP';
    g.fxArt = { explosion_strip: stripUri };
    g.fxMeta = { explosion_strip: { strip_frames: 10, frame_w: 256, canvas_px: 256 } };
    const u = ownUnit(g, 'EG-07', 800, 700); // MBT r=46 -> boom r = 115
    const okR1 = render(g); // snapshot
    delete g.state.units[u.id];
    g.state.tick += 1; // v0.9.1: the FX diff runs once per sim tick
    const m1 = g.ctx.log.length;
    const okR2 = render(g); // t=1 -> frame 0 at sx=0; stub bitmap is 32x32
    const log1 = g.ctx.log.slice(m1);
    const f0 = findCall(log1, 'drawImage',
      (a) => a[0] && a[0]._src === stripUri && a.length === 9
        && a[1] === 0 && a[2] === 0 && a[3] === 32 && a[4] === 32
        && near(a[5], 800 - 115) && near(a[6], 700 - 115)
        && near(a[7], 230) && near(a[8], 230));
    const noRing = !findCall(log1, 'arc',
      (a, c) => near(a[0], 800) && near(a[1], 700) && c.lineWidth === 3);
    check('explstrip-frame0-src-rect', okR1 && okR2 && f0 && noRing,
      'f0=' + f0 + ' noRing=' + noRing);
    g.state.tick += 19; // t=20, born=1 -> frame floor(19/2)=9 at sx = 9*32
    const m2 = g.ctx.log.length;
    render(g);
    const f9 = findCall(g.ctx.log.slice(m2), 'drawImage',
      (a) => a[0] && a[0]._src === stripUri && a.length === 9
        && a[1] === 9 * 32 && a[3] === 32);
    check('explstrip-frame9-at-t19', f9, 'f9=' + f9);
    g.state.tick += 1; // t=21, born=1 -> the 20-tick boom has expired
    const m3 = g.ctx.log.length;
    render(g);
    const gone = !findCall(g.ctx.log.slice(m3), 'drawImage',
      (a) => a[0] && a[0]._src === stripUri);
    check('explstrip-expires-20', gone, 'gone=' + gone);
  }

  // ---- T27: damaged-structure pick (structSpriteFor) + in-world blit ------
  {
    const g = mkGame();
    const norm = 'data:image/png;base64,STNORM';
    const dmg = 'data:image/png;base64,STDMG';
    g.structArt = { 'SH-02': norm };
    g.damagedArt = { 'SH-02': dmg };
    const pick = (id, f) => {
      const b = structSpriteFor(g, id, f);
      return b ? b._src : null;
    };
    check('damaged-pick-helper',
      pick('SH-02', 1.0) === norm && pick('SH-02', 0.5) === dmg
        && pick('SH-02', 0.49) === dmg && pick('SH-01', 0.4) === null,
      '1.0=normal 0.5=damaged 0.49=damaged missing=normal/null');
    // in the world: a 50% structure blits the damaged bitmap at fp*CELL,
    // owner underline + hp bar intact
    const s = addStructure(g.state, 'SH-02', 0, 6, 8);
    s.hp = Math.floor(s.maxHp / 2);
    const px = (s.cx + s.fp / 2) * 64, py = (s.cy + s.fp / 2) * 64;
    const size = s.fp * 64, half = s.fp * 64 / 2 - 3;
    const okR = render(g);
    const log = g.ctx.log;
    const blit = findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === dmg && near(a[1], px - size / 2)
        && near(a[2], py - size / 2) && near(a[3], size) && near(a[4], size));
    const col = ownerColorOf(g.state, 0);
    const bar = findCall(log, 'fillRect',
      (a, c) => near(a[0], px - half) && near(a[1], py + half + 2)
        && near(a[2], half * 2) && a[3] === 3 && c.fillStyle === col);
    const hpBar = findCall(log, 'fillRect',
      (a, c) => near(a[0], px - half) && near(a[1], py - half - 8)
        && c.fillStyle === '#111');
    check('damaged-bitmap-blits', okR && blit && bar && hpBar,
      'blit=' + blit + ' bar=' + bar + ' hpBar=' + hpBar);
  }

  // ---- T28: projectile sprite for mapped cls, line for unmapped -----------
  {
    const g = mkGame();
    const shellUri = 'data:image/png;base64,PROJCANNON';
    g.fxArt = { proj_cannon: shellUri };
    g.fxMeta = { proj_cannon: { radius: 7, canvas_px: 96 } };
    // spawnTracer roundtrip through the real sim helper: cls stored
    const pid = g.state.nextId;
    spawnTracer(g.state, 0, { x: 800, y: 700 }, { x: 1100, y: 700 }, 6, 'MBT');
    const tr = g.state.projectiles[pid];
    check('spawntracer-cls-roundtrip',
      !!tr && tr.kind === 'tracer' && tr.cls === 'MBT' && tr.sx === 800,
      'cls=' + (tr && tr.cls));
    tr.ticksLeft = 3; // progress 0.5 -> lerp pos (950,700), heading east
    // legacy tracer (no cls field) + unmapped cls -> keep the line. Both sit
    // inside the MBT's sight below so the fog cull lets them through.
    ownUnit(g, 'EG-07', 800, 700); // sight anchor (also the muzzle-flash src)
    const pid2 = g.state.nextId;
    spawnTracer(g.state, 0, { x: 800, y: 760 }, { x: 1100, y: 760 }, 6, 'Infantry');
    const pid3 = g.state.nextId++;
    g.state.projectiles[pid3] = { id: pid3, owner: 0, kind: 'tracer',
      sx: 800, sy: 820, x: 800, y: 820, tx: 1100, ty: 820, total: 6, ticksLeft: 6 };
    const col = ownerColorOf(g.state, 0);
    const okR = render(g);
    const log = g.ctx.log;
    // sprite: translate(950,700) + rotate(PI/2) + drawImage(-7,-7,14,14)
    const trIdx = findIdx(log, 'translate', (a) => near(a[0], 950) && near(a[1], 700));
    const rotIdx = findIdx(log, 'rotate', (a) => near(a[0], Math.PI / 2));
    const blitIdx = findIdx(log, 'drawImage',
      (a) => a[0] && a[0]._src === shellUri && a.length === 5
        && a[1] === -7 && a[2] === -7 && a[3] === 14 && a[4] === 14);
    const restIdx = findIdx(log, 'restore', () => true);
    const noTankLine = !findCall(log, 'lineTo',
      (a, c) => a[0] === 1100 && a[1] === 700 && c.strokeStyle === col);
    check('projart-sprite-rotated-lerp',
      okR && trIdx >= 0 && rotIdx > trIdx && blitIdx > rotIdx && restIdx > blitIdx
        && noTankLine,
      'tr@' + trIdx + ' rot@' + rotIdx + ' blit@' + blitIdx + ' rest@' + restIdx
        + ' noLine=' + noTankLine);
    // unmapped cls and legacy no-cls tracers still draw the plain line
    const rifleLine = findCall(log, 'lineTo',
      (a, c) => a[0] === 1100 && a[1] === 760 && c.strokeStyle === col);
    const legacyLine = findCall(log, 'lineTo',
      (a, c) => a[0] === 1100 && a[1] === 820 && c.strokeStyle === col);
    check('projart-line-kept-unmapped', rifleLine && legacyLine,
      'rifle=' + rifleLine + ' legacy=' + legacyLine);
  }

  // ---- T29: fxArt explosion frames / smoke / muzzle flash ------------------
  {
    const g = mkGame();
    const mk = (k) => 'data:image/png;base64,FX' + k;
    g.fxArt = {
      explosion_0: mk('E0'), explosion_1: mk('E1'),
      explosion_2: mk('E2'), explosion_3: mk('E3'),
      muzzle_flash: mk('MF'), smoke: mk('SM'),
    };
    const u = ownUnit(g, 'EG-07', 800, 700); // MBT r=46
    const s = addStructure(g.state, 'SH-02', 0, 6, 8);
    render(g); // snapshot
    delete g.state.units[u.id];
    delete g.state.structures[s.id];
    g.state.tick += 1; // v0.9.1: the FX diff runs once per sim tick
    const m1 = g.ctx.log.length;
    const okR = render(g);
    const log1 = g.ctx.log.slice(m1);
    const f0 = findCall(log1, 'drawImage', (a) => a[0] && a[0]._src === mk('E0'));
    const noRing = !findCall(log1, 'arc',
      (a, c) => near(a[0], 800) && near(a[1], 700) && c.lineWidth === 3);
    const smoke = findCall(log1, 'drawImage', (a) => a[0] && a[0]._src === mk('SM'));
    check('fxart-explosion-replaces-ring', okR && f0 && noRing,
      'f0=' + f0 + ' noRing=' + noRing);
    check('fxart-smoke-on-struct-death', smoke, 'smoke=' + smoke);
    g.state.tick += 4; // 4 ticks per frame -> frame 1
    const m2 = g.ctx.log.length;
    render(g);
    const f1 = findCall(g.ctx.log.slice(m2), 'drawImage',
      (a) => a[0] && a[0]._src === mk('E1'));
    check('fxart-explosion-frame-advances', f1, 'f1=' + f1);
    // muzzle flash art on a fresh tracer (fresh tick: the diff is tick-gated)
    const u2 = ownUnit(g, 'EG-07', 1000, 700);
    const pid = g.state.nextId++;
    g.state.projectiles[pid] = { id: pid, owner: 0, kind: 'tracer',
      sx: u2.x, sy: u2.y, x: u2.x, y: u2.y, tx: u2.x + 200, ty: u2.y,
      total: 6, ticksLeft: 6 };
    g.state.tick += 1;
    const m3 = g.ctx.log.length;
    render(g);
    const log3 = g.ctx.log.slice(m3);
    const flash = findCall(log3, 'drawImage',
      (a) => a[0] && a[0]._src === mk('MF') && near(a[1], 1000 - 9) && near(a[2], 700 - 9));
    const noCircle = !findCall(log3, 'arc',
      (a, c) => near(a[0], 1000) && near(a[1], 700) && a[2] === 6
        && String(c.fillStyle).indexOf('rgba(255,255,255') === 0);
    check('fxart-muzzle-flash', flash && noCircle, 'flash=' + flash + ' noCircle=' + noCircle);
  }

  // ---- T30: rally marker = two-tone dashed line + anchor + pennant ---------
  {
    const g = mkGame();
    const s = addStructure(g.state, 'SH-05', 0, 6, 8); // war factory (producer)
    const col = ownerColorOf(g.state, 0);
    const c = structCenter(s);
    const doorX = c.x, doorY = c.y + s.fp * 64 / 2;
    applyCommand(g.state, { player: 0, type: 'setRally', structId: s.id, x: 900, y: 700 });
    g.selection = [s.id];
    const okR = render(g);
    const log = g.ctx.log;
    // 3px dashed connector from the door edge: white pass + owner-color pass
    const dashOk = findCall(log, 'setLineDash', (a) => a[0] && a[0][0] === 8 && a[0][1] === 8);
    const whiteLine = findCall(log, 'lineTo',
      (a, cc) => a[0] === 900 && a[1] === 700 && cc.strokeStyle === '#ffffff' && cc.lineWidth === 3);
    const colLine = findCall(log, 'lineTo',
      (a, cc) => a[0] === 900 && a[1] === 700 && cc.strokeStyle === col && cc.lineWidth === 3);
    const doorStart = findCall(log, 'moveTo', (a) => a[0] === doorX && a[1] === doorY);
    // pulsing anchor circle (tick 0 -> pulse 1 -> r 11) + white center dot
    const ring = findCall(log, 'arc',
      (a, cc) => a[0] === 900 && a[1] === 700 && a[2] === 11 && cc.strokeStyle === col);
    const dot = findCall(log, 'arc',
      (a, cc) => a[0] === 900 && a[1] === 700 && a[2] === 2.5 && cc.fillStyle === '#ffffff');
    // pennant: dark pole up to (900,660) then owner-color triangle
    const pole = findCall(log, 'lineTo',
      (a, cc) => a[0] === 900 && a[1] === 660 && cc.strokeStyle === '#111111' && cc.lineWidth === 3);
    const flag = findCall(log, 'lineTo',
      (a, cc) => a[0] === 918 && a[1] === 673 && cc.fillStyle === col);
    check('rally-marker-visible', okR && dashOk && whiteLine && colLine && doorStart
        && ring && dot && pole && flag,
      'dash=' + dashOk + ' white=' + whiteLine + ' col=' + colLine + ' door=' + doorStart
        + ' ring=' + ring + ' dot=' + dot + ' pole=' + pole + ' flag=' + flag);
  }

  // ---- T31: rally marker zoom-compensated at min zoom (0.35 -> zs 2.5) ------
  {
    const g = mkGame();
    const s = addStructure(g.state, 'SH-05', 0, 6, 8);
    const col = ownerColorOf(g.state, 0);
    applyCommand(g.state, { player: 0, type: 'setRally', structId: s.id, x: 900, y: 700 });
    g.selection = [s.id];
    g.camera.zoom = 0.35; // min zoom
    const okR = render(g);
    const log = g.ctx.log;
    const wideLine = findCall(log, 'lineTo',
      (a, cc) => a[0] === 900 && a[1] === 700 && cc.strokeStyle === col && cc.lineWidth === 7.5);
    const tallPole = findCall(log, 'lineTo',
      (a, cc) => a[0] === 900 && a[1] === 700 - 100 && cc.strokeStyle === '#111111'
        && cc.lineWidth === 7.5);
    check('rally-marker-min-zoom', okR && wideLine && tallPole,
      'wideLine=' + wideLine + ' tallPole=' + tallPole);
  }

  // ---- T32: terrain prerender resolution cap (v0.6.0 big maps) --------------
  {
    // duel-144 -> pxPerCell 42 -> 6048px canvas, drawn scaled to world size
    const g = mkGame();
    const okSmall = g.render.terrain.width === 144 * 42 && g.render.terrain.height === 144 * 42;
    const okR1 = render(g);
    const scaled = findCall(g.ctx.log, 'drawImage',
      (a) => a[0] === g.render.terrain && a[1] === 0 && a[2] === 0
        && a[3] === 144 * 64 && a[4] === 144 * 64);
    // synthetic 240x240 map -> pxPerCell 25 -> 6000px canvas (the memory cap)
    const big = { name: 'Big', w: 240, h: 240, terrain: new Array(240 * 240).fill(0),
      oil: [], spawns: [{ x: 2, y: 2 }, { x: 237, y: 237 }] };
    const st2 = createMatch({ data, map: big,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 7 });
    const g2 = {
      state: st2, playerSlot: 0,
      canvas: document.createElement('canvas'), dpr: 1,
      camera: createCamera(1280, 800),
      selection: [], mouse: { sx: 0, sy: 0, inside: false },
      placement: null, targeting: null, attackMoveArmed: false, drag: null,
    };
    g2.ctx = g2.canvas.getContext('2d');
    initRenderer(g2);
    const okBig = g2.render.terrain.width === 240 * 25 && g2.render.terrain.height === 240 * 25;
    let okR2 = true;
    try { renderFrame(g2); } catch (e) { okR2 = false; errors.push('big-map renderFrame threw: ' + (e && e.stack || e)); }
    check('terrain-prerender-resolution-cap', okSmall && scaled && okBig && okR1 && okR2,
      'duel144=' + g.render.terrain.width + ' scaledBlit=' + scaled
        + ' big240=' + g2.render.terrain.width + ' render=' + okR2);
  }

  // ---- T33: v5 idleArt — SH-01 idle strip frame replaces the bitmap -------
  {
    const g = mkGame();
    const uri = 'data:image/png;base64,IDLE01';
    g.idleArt = { 'SH-01': { strip: uri, fw: 24, frames: 8, fps: 8 } };
    const s = addStructure(g.state, 'SH-01', 0, 6, 8);
    const px = (s.cx + s.fp / 2) * 64, py = (s.cy + s.fp / 2) * 64;
    const size = s.fp * 64;
    g.state.tick = 15; // fi = floor(15*8/10) % 8 = 4 -> src sx = 4*24 = 96
    const okR = render(g);
    const log = g.ctx.log;
    const blit = findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === uri && a.length === 9
        && a[1] === 96 && a[2] === 0 && a[3] === 24 && a[4] === 32
        && near(a[5], px - size / 2) && near(a[6], py - size / 2)
        && near(a[7], size) && near(a[8], size));
    check('idleart-sh01-frame-src-rect', okR && blit, 'blit=' + blit);
  }

  // ---- T34: damaged SH-01 at 40% hp draws damaged, not the idle strip -----
  {
    const g = mkGame();
    const idleUri = 'data:image/png;base64,IDLE02';
    const dmgUri = 'data:image/png;base64,DMG02';
    g.idleArt = { 'SH-01': { strip: idleUri, fw: 24, frames: 8, fps: 8 } };
    g.damagedArt = { 'SH-01': dmgUri };
    const s = addStructure(g.state, 'SH-01', 0, 6, 8);
    s.hp = Math.floor(s.maxHp * 0.4);
    const px = (s.cx + s.fp / 2) * 64, py = (s.cy + s.fp / 2) * 64;
    const size = s.fp * 64;
    const okR = render(g);
    const log = g.ctx.log;
    const dmgBlit = findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === dmgUri && near(a[1], px - size / 2)
        && near(a[2], py - size / 2) && near(a[3], size) && near(a[4], size));
    const idleBlit = findCall(log, 'drawImage', (a) => a[0] && a[0]._src === idleUri);
    check('idleart-damaged-wins-40hp', okR && dmgBlit && !idleBlit,
      'dmg=' + dmgBlit + ' idle=' + idleBlit);
  }

  // ---- T35: loop_rotor blit centered on an attack helo --------------------
  {
    const g = mkGame();
    const uri = 'data:image/png;base64,ROTOR1';
    g.loopArt = { loop_rotor: { strip: uri, fw: 16, frames: 4, fps: 8 } };
    ownUnit(g, 'EG-09', 760, 700); // Attack helo, r=38
    const okR = render(g);
    const log = g.ctx.log;
    const blit = findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === uri && a.length === 9
        && near(a[5], 760 - 38) && near(a[6], 700 - 38)
        && near(a[7], 76) && near(a[8], 76));
    // the procedural rotor cross is suppressed while the strip is decoded
    const procRotor = findCall(log, 'stroke', (a, c) => c.strokeStyle === 'rgba(0,0,0,0.5)');
    check('loopart-rotor-centered-helo', okR && blit && !procRotor,
      'blit=' + blit + ' procRotor=' + procRotor);
  }

  // ---- T36: loop_radar on SH-08 + AA Defs (dmg.air>=50), not HMG nest -----
  {
    const g = mkGame();
    const uri = 'data:image/png;base64,RADAR1';
    g.loopArt = { loop_radar: { strip: uri, fw: 16, frames: 4, fps: 8 } };
    const s1 = addStructure(g.state, 'SH-08', 0, 6, 8);   // Command/Tech
    const s2 = addStructure(g.state, 'SH-14', 0, 12, 8);  // Patriot dmg.air 90
    const s3 = addStructure(g.state, 'SH-09', 0, 18, 8);  // HMG nest dmg.air 0
    const okR = render(g);
    const log = g.ctx.log;
    const blitAt = (s) => {
      const px = (s.cx + s.fp / 2) * 64, py = (s.cy + s.fp / 2) * 64;
      const sz = (s.fp * 64 / 2 - 3) * 0.8;
      return findCall(log, 'drawImage',
        (a) => a[0] && a[0]._src === uri && a.length === 9
          && near(a[5], px - sz / 2) && near(a[6], py - sz / 2)
          && near(a[7], sz) && near(a[8], sz));
    };
    check('loopart-radar-sh08-patriot', okR && blitAt(s1) && blitAt(s2),
      'sh08=' + blitAt(s1) + ' patriot=' + blitAt(s2));
    check('loopart-radar-not-hmg', !blitAt(s3), 'hmg=' + blitAt(s3));
  }

  // ---- T37: loop_steam / loop_flag / loop_pumpjack anchors -----------------
  {
    const g = mkGame();
    const mk = (k) => 'data:image/png;base64,' + k;
    g.loopArt = {
      loop_steam: { strip: mk('STEAM'), fw: 16, frames: 4, fps: 8 },
      loop_flag: { strip: mk('FLAG'), fw: 16, frames: 4, fps: 8 },
      loop_pumpjack: { strip: mk('PUMP'), fw: 16, frames: 4, fps: 8 },
    };
    const s2 = addStructure(g.state, 'SH-02', 0, 6, 8);   // power plant
    const s4 = addStructure(g.state, 'SH-04', 0, 12, 8);  // barracks
    const s3 = addStructure(g.state, 'SH-03', 0, 18, 8);  // oil depot
    const okR = render(g);
    const log = g.ctx.log;
    const blitAt = (uri, s, sc) => {
      const px = (s.cx + s.fp / 2) * 64, py = (s.cy + s.fp / 2) * 64;
      const sz = (s.fp * 64 / 2 - 3) * sc;
      return findCall(log, 'drawImage',
        (a) => a[0] && a[0]._src === uri && a.length === 9
          && near(a[5], px - sz / 2) && near(a[6], py - sz / 2)
          && near(a[7], sz) && near(a[8], sz));
    };
    const steam = blitAt(mk('STEAM'), s2, 0.6);
    const flag = blitAt(mk('FLAG'), s4, 0.9);
    const pump = blitAt(mk('PUMP'), s3, 0.9);
    check('loopart-steam-flag-pumpjack-anchors', okR && steam && flag && pump,
      'steam=' + steam + ' flag=' + flag + ' pump=' + pump);
  }

  // ---- T38: loop_wake only while moving, placed at the stern --------------
  {
    const g = mkGame();
    const uri = 'data:image/png;base64,WAKE1';
    g.loopArt = { loop_wake: { strip: uri, fw: 16, frames: 4, fps: 8 } };
    const u = ownUnit(g, 'EG-18', 760, 700); // missile boat, Sea, r=48
    u.order = { type: 'move', x: 760 + 300, y: 700, targetId: 0 }; // east
    ownUnit(g, 'EG-19', 1000, 700); // idle ship: no wake
    const okR = render(g);
    const log = g.ctx.log;
    // stern = pos - headingVec * r = (712,700); blit size 2r = 96
    const wakeIdx = findIdx(log, 'drawImage',
      (a) => a[0] && a[0]._src === uri && a.length === 9
        && near(a[5], 712 - 48) && near(a[6], 700 - 48)
        && near(a[7], 96) && near(a[8], 96));
    let wakeCount = 0;
    for (const e of log) {
      if (e[0] === 'drawImage' && e[1][0] && e[1][0]._src === uri) wakeCount++;
    }
    // wake is drawn behind the unit: before its sprite blit
    const sprIdx = findIdx(log, 'drawImage',
      (a) => a[0] && a[0].tagName === 'canvas' && a[0].width
        && near(a[1], 760 - a[0].width / 2) && near(a[2], 700 - a[0].height / 2));
    check('loopart-wake-stern-moving-only', okR && wakeIdx >= 0 && wakeCount === 1
        && sprIdx > wakeIdx,
      'wake@' + wakeIdx + ' count=' + wakeCount + ' spr@' + sprIdx);
  }

  // ---- T39: loop_select pulse under the team ring, selected own only ------
  {
    const g = mkGame();
    const uri = 'data:image/png;base64,SELECT1';
    g.loopArt = { loop_select: { strip: uri, fw: 16, frames: 4, fps: 8 } };
    const u = ownUnit(g, 'EG-01', 760, 700); // infantry r=28
    ownUnit(g, 'EG-01', 1000, 700); // not selected: no pulse
    g.selection = [u.id];
    const col = ownerColorOf(g.state, 0);
    const okR = render(g);
    const log = g.ctx.log;
    const sz = 28 * 2.4;
    const selIdx = findIdx(log, 'drawImage',
      (a) => a[0] && a[0]._src === uri && a.length === 9
        && near(a[5], 760 - sz / 2) && near(a[6], 700 - sz / 2)
        && near(a[7], sz) && near(a[8], sz));
    const ringIdx = findIdx(log, 'ellipse',
      (a, c) => near(a[0], 760) && c.strokeStyle === col && c.lineWidth === 3);
    let pulseCount = 0;
    for (const e of log) {
      if (e[0] === 'drawImage' && e[1][0] && e[1][0]._src === uri) pulseCount++;
    }
    check('loopart-select-under-team-ring', okR && selIdx >= 0 && ringIdx > selIdx
        && pulseCount === 1,
      'sel@' + selIdx + ' ring@' + ringIdx + ' count=' + pulseCount);
  }

  // ---- T40: muzzle smoke on tank tracers only, play-once expiry -----------
  {
    const g = mkGame();
    const uri = 'data:image/png;base64,MSMOKE';
    g.loopArt = { loop_muzzle_smoke: { strip: uri, fw: 16, frames: 8, fps: 8 } };
    ownUnit(g, 'EG-07', 800, 700);  // MBT r=46
    ownUnit(g, 'EG-01', 1000, 700); // rifle infantry: no smoke
    const pid = g.state.nextId++;
    g.state.projectiles[pid] = { id: pid, owner: 0, kind: 'tracer',
      sx: 800, sy: 700, x: 800, y: 700, tx: 1100, ty: 700, total: 6, ticksLeft: 6 };
    const pid2 = g.state.nextId++;
    g.state.projectiles[pid2] = { id: pid2, owner: 0, kind: 'tracer',
      sx: 1000, sy: 700, x: 1000, y: 700, tx: 1200, ty: 700, total: 6, ticksLeft: 6 };
    const okR = render(g);
    const log = g.ctx.log;
    // barrel tip = pos + aimVec * r * 0.9 = (841.4,700); size 1.5r = 69
    const mx = 800 + 46 * 0.9, sz = 46 * 1.5;
    const spawn = findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === uri && a.length === 9
        && a[1] === 0 && near(a[5], mx - sz / 2) && near(a[6], 700 - sz / 2)
        && near(a[7], sz) && near(a[8], sz));
    let count = 0;
    for (const e of log) {
      if (e[0] === 'drawImage' && e[1][0] && e[1][0]._src === uri) count++;
    }
    check('muzzle-smoke-tank-tracer-only', okR && spawn && count === 1,
      'spawn=' + spawn + ' count=' + count);
    // play-once: tick+5 -> fi = floor(5*8/10) = 4 -> src sx 4*16 = 64
    g.state.tick += 5;
    const m2 = g.ctx.log.length;
    render(g);
    const f4 = findCall(g.ctx.log.slice(m2), 'drawImage',
      (a) => a[0] && a[0]._src === uri && a[1] === 64);
    check('muzzle-smoke-frame-advances', f4, 'f4=' + f4);
    // 8 frames over 8*(10/8) = 10 ticks: tick+10 from spawn -> expired
    g.state.tick += 5;
    const m3 = g.ctx.log.length;
    render(g);
    const gone = !findCall(g.ctx.log.slice(m3), 'drawImage',
      (a) => a[0] && a[0]._src === uri);
    check('muzzle-smoke-play-once-expires', gone, 'gone=' + gone);
  }

  // ---- T41: v6 tileArt — sand/rock/water_0 tiles stamp in the bake --------
  // 8x8 synthetic map: sand base, rock at (1,1)/(6,6)/(2,0), a 3x3 water pond
  // at (3..5,3..5) so (4,4) is water NOT adjacent to land (no foam) and the 8
  // ring cells are. Small map -> TS = min(64, 6144/8) = 64 px/cell.
  function tileTestMap() {
    const t = [];
    for (let i = 0; i < 64; i++) t.push(0);
    t[1 * 8 + 1] = 1; t[6 * 8 + 6] = 1; t[0 * 8 + 2] = 1;
    for (let wy = 3; wy <= 5; wy++) {
      for (let wx = 3; wx <= 5; wx++) t[wy * 8 + wx] = 2;
    }
    return { name: 'Tiles', w: 8, h: 8, terrain: t, oil: [],
      spawns: [{ x: 0, y: 0 }, { x: 7, y: 7 }] };
  }
  function mkTileGame(tileArt) {
    const st = createMatch({ data, map: tileTestMap(),
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }], seed: 7 });
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 800;
    const g = {
      state: st, playerSlot: 0, canvas, ctx: canvas.getContext('2d'), dpr: 1,
      camera: createCamera(1280, 800),
      selection: [], mouse: { sx: 0, sy: 0, inside: false },
      placement: null, targeting: null, attackMoveArmed: false, drag: null,
    };
    if (tileArt !== undefined) g.tileArt = tileArt;
    initRenderer(g);
    return g;
  }
  const TILE_PACK = {
    sand: 'data:image/png;base64,TSAND', rock: 'data:image/png;base64,TROCK',
    water_0: 'data:image/png;base64,TW0', water_1: 'data:image/png;base64,TW1',
    water_2: 'data:image/png;base64,TW2', water_3: 'data:image/png;base64,TW3',
    decal_dune: 'data:image/png;base64,TDUNE', decal_rock: 'data:image/png;base64,TDROCK',
    decal_scrub: 'data:image/png;base64,TSCRUB', decal_foam: 'data:image/png;base64,TFOAM',
  };
  {
    const g = mkTileGame(TILE_PACK);
    const log = g.render.terrain.__ctx.log;
    const blitAt = (uri, cx, cy) => findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === uri
        && a[1] === cx * 64 && a[2] === cy * 64 && a[3] === 64 && a[4] === 64);
    const sandOk = blitAt(TILE_PACK.sand, 0, 0);
    const rockOk = blitAt(TILE_PACK.rock, 1, 1) && blitAt(TILE_PACK.rock, 6, 6);
    const water0Ok = blitAt(TILE_PACK.water_0, 3, 3) && blitAt(TILE_PACK.water_0, 4, 4);
    // every terrain kind has a tile here -> no flat-color fillRect at all
    const flat = findCall(log, 'fillRect',
      (a, c) => c.fillStyle === '#b8a06a' || c.fillStyle === '#4c4c4c'
        || c.fillStyle === '#274b7a');
    check('tileart-sand-rock-bake', sandOk && rockOk && water0Ok && !flat,
      'sand=' + sandOk + ' rock=' + rockOk + ' water0=' + water0Ok + ' flat=' + flat);
  }

  // ---- T42: v6 tileArt — foam on land-adjacent water cells only ------------
  {
    const g = mkTileGame(TILE_PACK);
    const log = g.render.terrain.__ctx.log;
    let foamCount = 0, foamRing = false, foamCenter = false;
    for (const e of log) {
      if (e[0] === 'drawImage' && e[1][0] && e[1][0]._src === TILE_PACK.decal_foam) {
        foamCount++;
        if (e[1][1] === 3 * 64 && e[1][2] === 3 * 64) foamRing = true;
        if (e[1][1] === 4 * 64 && e[1][2] === 4 * 64) foamCenter = true;
      }
    }
    check('tileart-foam-land-adjacent-only', foamCount === 8 && foamRing && !foamCenter,
      'foam=' + foamCount + '/8 ring=' + foamRing + ' center=' + foamCenter);
  }

  // ---- T43: v6 tileArt — water overlay cycles floor(tick*2/10)%4 ----------
  {
    const g = mkTileGame(TILE_PACK);
    const w1 = TILE_PACK.water_1, w2 = TILE_PACK.water_2, w3 = TILE_PACK.water_3;
    const anyFrame = (log) => findCall(log, 'drawImage',
      (a) => a[0] && (a[0]._src === w1 || a[0]._src === w2 || a[0]._src === w3));
    const frameAt = (log, uri) => findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === uri && a.length === 5
        && a[1] === 3 * 64 && a[2] === 3 * 64 && a[3] === 64 && a[4] === 64);
    g.state.tick = 0; // frame 0 is baked into the terrain canvas: no overlay
    const ok0 = render(g);
    const none0 = !anyFrame(g.ctx.log);
    g.state.tick = 5; // floor(5*2/10)%4 = 1 -> water_1 over visible water cells
    const m1 = g.ctx.log.length;
    const ok1 = render(g);
    const f1 = frameAt(g.ctx.log.slice(m1), w1);
    g.state.tick = 35; // floor(35*2/10)%4 = 3 -> water_3
    const m2 = g.ctx.log.length;
    render(g);
    const f3 = frameAt(g.ctx.log.slice(m2), w3);
    g.state.tick = 40; // floor(40*2/10)%4 = 0 -> overlay silent again
    const m3 = g.ctx.log.length;
    render(g);
    const none40 = !anyFrame(g.ctx.log.slice(m3));
    check('tileart-water-frame-cycle', ok0 && none0 && ok1 && f1 && f3 && none40,
      'none0=' + none0 + ' f1=' + f1 + ' f3=' + f3 + ' none40=' + none40);
  }

  // ---- T44: v6 tileArt — decal scatter is deterministic (pure x,y hash) ----
  {
    const g1 = mkTileGame(TILE_PACK);
    const g2 = mkTileGame(TILE_PACK);
    const ser = (log) => JSON.stringify(log.map((e) => e[0] === 'drawImage'
      ? ['drawImage', e[1][0] && e[1][0]._src, e[1].slice(1)] : e));
    const same = ser(g1.render.terrain.__ctx.log) === ser(g2.render.terrain.__ctx.log);
    // and the deterministic scatter actually placed decals: dune on sand,
    // decal_rock on the (2,0) rock cell, scrub on sand-next-to-rock (6,5)
    const log = g1.render.terrain.__ctx.log;
    const blitAt = (uri, cx, cy) => findCall(log, 'drawImage',
      (a) => a[0] && a[0]._src === uri
        && a[1] === cx * 64 && a[2] === cy * 64 && a[3] === 64 && a[4] === 64);
    const dune = findCall(log, 'drawImage', (a) => a[0] && a[0]._src === TILE_PACK.decal_dune);
    const drock = blitAt(TILE_PACK.decal_rock, 2, 0);
    const scrub = blitAt(TILE_PACK.decal_scrub, 6, 5);
    check('tileart-deterministic-bake', same && dune && drock && scrub,
      'identical=' + same + ' dune=' + dune + ' rockDecal=' + drock + ' scrub=' + scrub);
  }

  // ---- T45: v6 tileArt — empty/missing pack = EXACT flat-color bake --------
  {
    const g = mkTileGame({}); // empty pack
    const gNo = mkTileGame(undefined); // no tileArt field at all
    const log = g.render.terrain.__ctx.log;
    const anyImg = findCall(log, 'drawImage', () => true);
    const sandFlat = findCall(log, 'fillRect',
      (a, c) => c.fillStyle === '#b8a06a' && a[0] === 0 && a[1] === 0 && a[2] === 64 && a[3] === 64);
    const rockFlat = findCall(log, 'fillRect',
      (a, c) => c.fillStyle === '#4c4c4c' && a[0] === 64 && a[1] === 64 && a[2] === 64 && a[3] === 64);
    const waterFlat = findCall(log, 'fillRect',
      (a, c) => c.fillStyle === '#274b7a' && a[0] === 3 * 64 && a[1] === 3 * 64
        && a[2] === 64 && a[3] === 64);
    const noFields = g.render.waterCells === undefined && g.render.waterFrames === undefined
      && gNo.render.waterCells === undefined && gNo.render.waterFrames === undefined;
    const noImg2 = !findCall(gNo.render.terrain.__ctx.log, 'drawImage', () => true);
    const okR = render(g) && render(gNo);
    check('tileart-empty-flat-color-path', !anyImg && noImg2 && sandFlat && rockFlat
        && waterFlat && noFields && okR,
      'img=' + anyImg + ' sand=' + sandFlat + ' rock=' + rockFlat + ' water=' + waterFlat
        + ' fields=' + noFields);
  }

  // ---- T46: v0.9.1 — enemy structure death OUT of fog spawns no FX ----------
  // (seen once -> snapshotted; currently not visible -> the death must not
  // telegraph itself with explosion/rubble/smoke; units already had this guard)
  {
    const g = mkGame();
    // with the fx pack decoded a structure death draws explosion frames +
    // smoke + rubble — every one is an out-of-fog information leak
    const uriBoom = 'data:image/png;base64,EXS0';
    const uriSmoke = 'data:image/png;base64,SMSMK';
    g.fxArt = { explosion_0: uriBoom, smoke: uriSmoke };
    const mkEnemyStruct = (cx, cy) => {
      const s = addStructure(g.state, 'SH-02', 1, cx, cy);
      // explored once but NOT currently visible (whole footprint)
      for (let dy = 0; dy < s.fp; dy++) {
        for (let dx = 0; dx < s.fp; dx++) {
          g.state.fog[0].seen[(s.cy + dy) * g.state.map.w + s.cx + dx] = 1;
        }
      }
      return s;
    };
    const anyLeak = (log, px, py) => findCall(log, 'drawImage',
      (a) => a[0] && (a[0]._src === uriBoom || a[0]._src === uriSmoke)
        && Math.abs(a[1] - (px - a[3] / 2)) < 80 && Math.abs(a[2] - (py - a[4] / 2)) < 80);
    // (a) unseen-at-death: no explosion/smoke at the structure site
    const sA = mkEnemyStruct(60, 60);
    const pxA = (sA.cx + sA.fp / 2) * 64, pyA = (sA.cy + sA.fp / 2) * 64;
    g.camera.x = pxA - 640; g.camera.y = pyA - 400; // center the view on it
    const okA1 = render(g); // snapshot prevStructs
    delete g.state.structures[sA.id];
    g.state.tick += 1;
    const mA = g.ctx.log.length;
    const okA2 = render(g);
    const leakA = anyLeak(g.ctx.log.slice(mA), pxA, pyA);
    check('struct-death-fog-guard', okA1 && okA2 && !leakA, 'leak=' + leakA);
    // (b) visible-at-death: the same deletion DOES produce the explosion
    const sB = mkEnemyStruct(60, 70);
    const pxB = (sB.cx + sB.fp / 2) * 64, pyB = (sB.cy + sB.fp / 2) * 64;
    g.camera.x = pxB - 640; g.camera.y = pyB - 400;
    for (let dy = 0; dy < sB.fp; dy++) {
      for (let dx = 0; dx < sB.fp; dx++) {
        g.state.fog[0].visible[(sB.cy + dy) * g.state.map.w + sB.cx + dx] = 1;
      }
    }
    // fresh tick: the diff is tick-gated and would skip a same-tick frame
    g.state.tick += 1;
    render(g); // snapshot
    delete g.state.structures[sB.id];
    g.state.tick += 1;
    const mB = g.ctx.log.length;
    render(g);
    const leakB = anyLeak(g.ctx.log.slice(mB), pxB, pyB);
    check('struct-death-visible-fx-ok', !!leakB, 'fx=' + leakB);
  }

  // ---- T47: v0.9.1 — water overlay restamps only when the frame changes -----
  {
    const g = mkTileGame(TILE_PACK);
    const wAny = (log) => {
      let n = 0;
      for (const e of log) {
        if (e[0] === 'drawImage' && e[1][0]
          && (e[1][0]._src === TILE_PACK.water_1 || e[1][0]._src === TILE_PACK.water_2
            || e[1][0]._src === TILE_PACK.water_3)) n++;
      }
      return n;
    };
    g.state.tick = 5; // fi = floor(10/10)%4 = 1 -> 9-cell restamp
    render(g);
    const stamped = wAny(g.ctx.log);
    const m1 = g.ctx.log.length;
    render(g); // same tick (a second rAF at 4x): fi unchanged -> zero restamps
    const again = wAny(g.ctx.log.slice(m1));
    g.state.tick = 6; // fi still 1 -> zero
    const m2 = g.ctx.log.length;
    render(g);
    const sameFi = wAny(g.ctx.log.slice(m2));
    g.state.tick = 10; // fi = floor(20/10)%4 = 2 -> one full restamp
    const m3 = g.ctx.log.length;
    render(g);
    const nextFi = wAny(g.ctx.log.slice(m3));
    check('water-overlay-restamp-cache', stamped === 9 && again === 0
        && sameFi === 0 && nextFi === 9,
      'stamped=' + stamped + ' again=' + again + ' sameFi=' + sameFi
        + ' nextFi=' + nextFi);
  }

  // ---- T48: v0.9.1 — fog canvas is 4px/cell, blit runs with smoothing -------
  {
    const g = mkGame();
    const S = g.render.fogScale;
    const dimOk = S === 4
      && g.render.fog.width === g.state.map.w * S
      && g.render.fog.height === g.state.map.h * S
      && g.render.fogImg.width === g.state.map.w * S
      && g.render.fogImg.height === g.state.map.h * S;
    render(g);
    // the fog blit must run with imageSmoothingEnabled = true (soft edges)…
    let smoothFog = false;
    const cur = {};
    for (let i = 0; i < g.ctx.log.length; i++) {
      const e = g.ctx.log[i];
      if (e[0].charAt(0) === '$') { cur[e[0].slice(1)] = e[1]; continue; }
      if (e[0] === 'drawImage' && e[1][0] === g.render.fog
        && cur.imageSmoothingEnabled === true) smoothFog = true;
    }
    check('fog-canvas-4px-per-cell', dimOk,
      'scale=' + S + ' fog=' + g.render.fog.width + 'x' + g.render.fog.height
        + ' map=' + g.state.map.w + 'x' + g.state.map.h);
    check('fog-blit-smoothing-enabled', smoothFog, 'smoothFog=' + smoothFog);
  }

  // ---- T49: v0.9.1 — updateFx diff is tick-gated, snapshot records reused ---
  {
    const g = mkGame();
    const u = ownUnit(g, 'EG-01', 672, 672);
    render(g);
    const rec1 = g.fx.prevUnits[u.id];
    render(g); // same tick: the diff is skipped, the snapshot record survives
    const gated = g.fx.lastTick === g.state.tick && g.fx.prevUnits[u.id] === rec1;
    g.state.tick += 1;
    u.x += 10; u.hp -= 5;
    render(g);
    const rec2 = g.fx.prevUnits[u.id];
    check('updatefx-tick-gate-and-record-reuse',
      gated && rec2 === rec1 && rec2.x === u.x && rec2.hp === u.hp,
      'gated=' + gated + ' sameRec=' + (rec2 === rec1)
        + ' x=' + (rec2 && rec2.x) + ' hp=' + (rec2 && rec2.hp));
  }

  // ---- T50: v0.9.1 — tracer srcUnitId fast path (no position scan) ----------
  {
    const g = mkGame();
    const uri = 'data:image/png;base64,MSMOKE2';
    g.loopArt = { loop_muzzle_smoke: { strip: uri, fw: 16, frames: 8, fps: 8 } };
    const u = ownUnit(g, 'EG-07', 800, 700); // MBT r=46
    const pid = g.state.nextId++;
    g.state.projectiles[pid] = { id: pid, owner: 0, kind: 'tracer', srcUnitId: u.id,
      sx: 800, sy: 700, x: 800, y: 700, tx: 1100, ty: 700, total: 6, ticksLeft: 6 };
    u.x = 900; // shooter moved off the spawn position: the scan would miss
    const okR = render(g);
    const mx = 900 + 46 * 0.9, sz = 46 * 1.5;
    const puff = findCall(g.ctx.log, 'drawImage',
      (a) => a[0] && a[0]._src === uri && near(a[5], mx - sz / 2) && near(a[6], 700 - sz / 2));
    check('tracer-srcunitid-fast-path', okR && puff, 'puff=' + puff);
  }

  check('renderFrame-never-throws', errors.length === 0, errors.join(' | '));
  return out;
}
"""


def inline(path: Path) -> str:
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"import\s+[\s\S]*?\sfrom\s*'[^']*';", "", src)
    src = re.sub(r"export\s*\{[\s\S]*?\}\s*from\s*'[^']*';", "", src)
    src = re.sub(r"^export\s+(async function|function|const|let)", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[\s\S]*?\};", "", src, flags=re.M)
    return src


def main() -> int:
    bundle = "\n;\n".join(inline(CLIENT / m) for m in MODULES)
    ctx = MiniRacer()
    for name, rel in (("__data", "data/game.json"), ("__duel", "maps/duel.json")):
        payload = (CLIENT / rel).read_text(encoding="utf-8")
        ctx.eval(f"var {name} = {json.dumps(payload)};")
    ctx.eval(STUB_JS)
    ctx.eval(bundle)
    ctx.eval(TEST_JS)
    results = json.loads(ctx.eval(
        "JSON.stringify(runRenderTests(JSON.parse(__data), JSON.parse(__duel)))"
    ))
    passed = 0
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}")
        passed += 1 if r["pass"] else 0
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
