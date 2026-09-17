# Comprehensive QA harness: inlines the sim ES modules (same pattern as
# run_tests.py / test_deploy.py) and runs a full enumeration suite in V8:
#   - all 6 maps: integrity + MCV deploy at every spawn
#   - all 35 structures: build -> ready -> place, power, producer/def/tech/SW extras
#   - all 161 units x 9 factions: producer gate, spawn legality, movement, combat
#     (engineer repair/capture, kamikaze detonation, harvester income)
#   - all 9 faction abilities (active effects + cooldown + passives)
#   - 54 faction x map combo sanity runs vs a Recruit AI
#   - full AI-vs-AI matches (duel 2p, coast 4p, hormuz 6p) + determinism,
#     elimination/rebuild-window, data integrity
# Usage: .venv/Scripts/python run_qa.py
import json
import re
import sys
import time
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
]
MAPS = ["duel", "sinai", "coast", "tigris", "hormuz", "rubalkhali"]


def inline(path: Path) -> str:
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"import\s+[\s\S]*?\sfrom\s*'[^']*';", "", src)
    src = re.sub(r"export\s*\{[\s\S]*?\}\s*from\s*'[^']*';", "", src)
    src = re.sub(r"^export\s+(async function|function|const|let)", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[\s\S]*?\};", "", src, flags=re.M)
    return src


TEST_JS = r"""
// NOTE: the sim modules are inlined flat into this scope, so internal helpers
// (terrainAt, footprintFree, structAtCell, ...) are directly callable.
var MAP_ORDER = ['duel', 'sinai', 'coast', 'tigris', 'hormuz', 'rubalkhali'];
var MAP_EXPECT = {
  duel: { spawns: 2, water: false }, sinai: { spawns: 2, water: false },
  coast: { spawns: 4, water: true }, tigris: { spawns: 4, water: true },
  hormuz: { spawns: 6, water: true }, rubalkhali: { spawns: 6, water: false },
};

// ---------- shared helpers ----------
function qaMk(out) {
  return function (name, pass, detail) {
    out.push({ name: name, pass: !!pass, detail: String(detail === undefined ? '' : detail) });
  };
}
function qaFindMcv(st, slot) {
  var ids = Object.keys(st.units);
  for (var i = 0; i < ids.length; i++) {
    var u = st.units[ids[i]];
    if (u.owner === slot && u.defId === 'MCV') return u;
  }
  return null;
}
function qaDeploy(st, slot) {
  var mcv = qaFindMcv(st, slot);
  if (!mcv) return { ok: false, reason: 'no-mcv-found' };
  return applyCommand(st, { player: slot, type: 'deployMCV', unitId: mcv.id });
}
function qaCy(st, slot) {
  return standingStructs(st, slot, function (s) { return s.defId === 'SH-01'; })[0] || null;
}
// ring search around (cx,cy) for a cell satisfying pred(x,y)
function qaFindCell(st, cx, cy, pred, maxR) {
  for (var r = 0; r <= maxR; r++) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        var x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= st.map.w || y >= st.map.h) continue;
        if (pred(x, y)) return { x: x, y: y };
      }
    }
  }
  return null;
}
// all fp*fp cells open terrain and clear of structure footprints
function qaOpenPred(st, fp) {
  return function (x, y) {
    for (var dy = 0; dy < fp; dy++) {
      for (var dx = 0; dx < fp; dx++) {
        if (terrainAt(st, x + dx, y + dy) !== 0) return false;
      }
    }
    return footprintFree(st, x, y, fp);
  };
}
// open fp*fp area with at least one water cell on the surrounding ring
function qaNavalPred(st, fp) {
  var open = qaOpenPred(st, fp);
  return function (x, y) {
    if (!open(x, y)) return false;
    for (var dy = -1; dy <= fp; dy++) {
      for (var dx = -1; dx <= fp; dx++) {
        if (terrainAt(st, x + dx, y + dy) === 2) return true;
      }
    }
    return false;
  };
}
function qaCheapestInf(data, faction) {
  var c = data.units
    .filter(function (u) { return u.faction === faction && u.cls === 'Infantry'; })
    .sort(function (a, b) { return a.cost - b.cost; });
  return c.length ? c[0].id : null;
}
function qaHasDmg(def) {
  return def.dmg.inf + def.dmg.light + def.dmg.armor + def.dmg.air + def.dmg.bldg > 0;
}
// weakest (least total dmg) unit def matching pred — used as a passive dummy
function qaDummyDef(st, pred) {
  var best = null, bestD = Infinity;
  for (var i = 0; i < st.data.units.length; i++) {
    var u = st.data.units[i];
    if (!pred(u)) continue;
    var d = u.dmg.inf + u.dmg.light + u.dmg.armor + u.dmg.air + u.dmg.bldg;
    if (d < bestD) { bestD = d; best = u; }
  }
  return best;
}

// ---------- phase 1: maps ----------
function qaPhaseMaps(data, maps) {
  var out = [];
  var check = qaMk(out);
  for (var mi = 0; mi < MAP_ORDER.length; mi++) {
    var id = MAP_ORDER[mi];
    var m = maps[id];
    var exp = MAP_EXPECT[id];
    try {
      var lenOk = m.terrain.length === m.w * m.h;
      var valsOk = true;
      var hasWater = false;
      for (var i = 0; i < m.terrain.length; i++) {
        var t = m.terrain[i];
        if (t !== 0 && t !== 1 && t !== 2) { valsOk = false; break; }
        if (t === 2) hasWater = true;
      }
      var spawnOk = m.spawns.length === exp.spawns;
      var spawnTerrain = m.spawns.every(function (sp) {
        return sp.x >= 0 && sp.y >= 0 && sp.x < m.w && sp.y < m.h
          && m.terrain[sp.y * m.w + sp.x] === 0;
      });
      var oilTerrain = m.oil.every(function (o) {
        return o.x >= 0 && o.y >= 0 && o.x < m.w && o.y < m.h
          && m.terrain[o.y * m.w + o.x] === 0;
      });
      var st = createMatch({ data: data, map: m,
        players: [{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], seed: 1 });
      var waterOk = mapHasWater(st) === exp.water && hasWater === exp.water;
      check('map ' + id + ' integrity',
        lenOk && valsOk && spawnOk && spawnTerrain && oilTerrain && waterOk,
        JSON.stringify({ w: m.w, h: m.h, lenOk: lenOk, valsOk: valsOk,
          spawns: m.spawns.length, spawnTerrain: spawnTerrain, oil: m.oil.length,
          oilTerrain: oilTerrain, water: hasWater, waterOk: waterOk }));
    } catch (e) {
      check('map ' + id + ' integrity', false, 'exception: ' + (e && e.stack || e));
    }
  }
  // MCV deploy at every spawn of every map
  for (var mi2 = 0; mi2 < MAP_ORDER.length; mi2++) {
    var id2 = MAP_ORDER[mi2];
    var mp = maps[id2];
    try {
      var players = mp.spawns.map(function (sp, i) { return { faction: 'Egypt', slot: i }; });
      var st2 = createMatch({ data: data, map: mp, players: players, seed: 5 });
      var ok = true, fails = [];
      for (var s = 0; s < mp.spawns.length; s++) {
        var mcv = qaFindMcv(st2, s);
        var r = applyCommand(st2, { player: s, type: 'deployMCV', unitId: mcv.id });
        var cy = qaCy(st2, s);
        var near = cy && Math.max(Math.abs(cy.cx + 1 - mp.spawns[s].x),
          Math.abs(cy.cy + 1 - mp.spawns[s].y)) <= 5;
        if (!(r.ok && cy && !st2.units[mcv.id] && near)) {
          ok = false;
          fails.push('slot' + s + ':' + (r.ok ? 'placed-but-far/mcv-kept' : r.reason));
        }
      }
      check('deploy ' + id2 + ' all ' + mp.spawns.length + ' spawns', ok,
        fails.join(';') || 'all ConYards within 5 cells of spawn, MCVs consumed');
    } catch (e) {
      check('deploy ' + id2 + ' all spawns', false, 'exception: ' + (e && e.stack || e));
    }
  }
  return out;
}

// ---------- phase 2: structures ----------
function qaStructOne(data, maps, sdef) {
  // returns {pass, detail}
  var sid = sdef.id;
  var faction = sdef.faction === 'All' ? (sid === 'SH-07' ? 'Iran' : 'Egypt') : sdef.faction;
  var map = sid === 'SH-07' ? maps.coast : maps.duel;
  var enemy = faction === 'Egypt' ? 'Algeria' : 'Egypt';
  var st = createMatch({ data: data, map: map,
    players: [{ faction: faction, slot: 0 }, { faction: enemy, slot: 1 }], seed: 100 });
  var p = st.players[0];
  p.credits = 1000000;

  if (sid === 'SH-01') {
    // ConYard rebuild path: no deploy — a live MCV must block the rebuild,
    // then with the MCV gone the rebuild validates, builds and places.
    var v0 = validateCommand(st, { player: 0, type: 'buildStructure', structId: 'SH-01' });
    if (v0.ok || v0.reason !== 'mcv-alive') {
      return { pass: false, detail: 'expected mcv-alive rejection, got ' + JSON.stringify(v0) };
    }
    var mcv0 = qaFindMcv(st, 0);
    delete st.units[mcv0.id];
    var v1 = validateCommand(st, { player: 0, type: 'buildStructure', structId: 'SH-01' });
    if (!v1.ok) return { pass: false, detail: 'rebuild validate: ' + v1.reason };
    applyCommand(st, { player: 0, type: 'buildStructure', structId: 'SH-01' });
    var g0 = 0;
    while (!p.ready.includes('SH-01') && g0++ < 100) tick(st);
    if (!p.ready.includes('SH-01')) return { pass: false, detail: 'rebuild never ready' };
    var sp0 = map.spawns[0];
    var spot0 = findPlacement(st, 0, st.structDefs['SH-01'], sp0.x, sp0.y, 15);
    if (!spot0) return { pass: false, detail: 'no rebuild spot near spawn' };
    var vp0 = validateCommand(st, { player: 0, type: 'placeStructure',
      structId: 'SH-01', cx: spot0.x, cy: spot0.y });
    if (!vp0.ok) return { pass: false, detail: 'rebuild place validate: ' + vp0.reason };
    applyCommand(st, { player: 0, type: 'placeStructure', structId: 'SH-01', cx: spot0.x, cy: spot0.y });
    var cyN = qaCy(st, 0);
    tick(st);
    var powOk = p.powerOut === 50 && p.powerUse === 0;
    return { pass: !!cyN && p.cyRebuilt && powOk,
      detail: JSON.stringify({ standing: !!cyN, cyRebuilt: p.cyRebuilt,
        powerOut: p.powerOut, powerUse: p.powerUse, rejectedWithMcv: v0.reason }) };
  }

  var rd = qaDeploy(st, 0);
  if (!rd.ok) return { pass: false, detail: 'deploy: ' + rd.reason };
  var cy = qaCy(st, 0);
  var cc = structCenter(cy);
  var acx = cellOf(cc.x), acy = cellOf(cc.y);

  var vb = validateCommand(st, { player: 0, type: 'buildStructure', structId: sid });
  if (!vb.ok) return { pass: false, detail: 'build validate: ' + vb.reason };
  applyCommand(st, { player: 0, type: 'buildStructure', structId: sid });
  var maxT = Math.round(sdef.build_s * 10 * 2) + 300;
  var g = 0;
  while (!p.ready.includes(sid) && g++ < maxT) tick(st);
  if (!p.ready.includes(sid)) return { pass: false, detail: 'never ready after ' + g + ' ticks' };

  var sdefI = st.structDefs[sid];
  var spot;
  if (sid === 'SH-03') {
    spot = findDepotPlacement(st, 0, sdefI);
    if (!spot) {
      // CY too far from oil: drop a barracks anchor next to a field, retry
      var oil0 = map.oil[0];
      var anc = qaFindCell(st, oil0.x, oil0.y, qaOpenPred(st, 3), 8);
      if (anc) {
        addStructure(st, 'SH-04', 0, anc.x, anc.y);
        spot = findDepotPlacement(st, 0, sdefI);
      }
    }
  } else {
    spot = findPlacement(st, 0, sdefI, acx, acy, 10);
    if (!spot && sid === 'SH-07') {
      // no water in build radius of the CY: anchor a barracks at the shore
      var shore = qaFindCell(st, acx, acy, qaNavalPred(st, 3), 60);
      if (shore) {
        addStructure(st, 'SH-04', 0, shore.x, shore.y);
        spot = findPlacement(st, 0, sdefI, shore.x, shore.y, 10);
      }
    }
  }
  if (!spot) return { pass: false, detail: 'no legal placement found' };
  var vp = validateCommand(st, { player: 0, type: 'placeStructure', structId: sid, cx: spot.x, cy: spot.y });
  if (!vp.ok) return { pass: false, detail: 'place validate: ' + vp.reason };
  applyCommand(st, { player: 0, type: 'placeStructure', structId: sid, cx: spot.x, cy: spot.y });
  var placed = standingStructs(st, 0, function (x) { return x.defId === sid; })[0];
  if (!placed) return { pass: false, detail: 'not standing after place' };
  var swAfterPlace = p.swChargeTicks; // read before any tick decrements the charge
  tick(st);

  // power accounting
  var eo = 0, eu = 0;
  for (var id in st.structures) {
    var sx = st.structures[id];
    if (sx.owner !== 0) continue;
    var dx2 = st.structDefs[sx.defId];
    eo += dx2.power_out; eu += dx2.power_use;
  }
  if (p.powerOut !== eo || p.powerUse !== eu) {
    return { pass: false, detail: 'power mismatch: got ' + p.powerOut + '/' + p.powerUse
      + ' expected ' + eo + '/' + eu };
  }

  var extras = [];
  // producer: a mapped unit becomes trainable
  if (sdef.type === 'Prod') {
    if (!hasTech(st, 0)) {
      var tsp = qaFindCell(st, acx, acy, qaOpenPred(st, 3), 20);
      if (tsp) addStructure(st, 'SH-08', 0, tsp.x, tsp.y);
    }
    var cand = data.units.filter(function (u) {
      return u.faction === faction && requiredProducer(st.unitDefs[u.id]) === sid;
    });
    if (!cand.length) return { pass: false, detail: 'no ' + faction + ' unit maps to ' + sid };
    var vt = validateCommand(st, { player: 0, type: 'trainUnit', unitId: cand[0].id });
    if (!vt.ok) return { pass: false, detail: 'train ' + cand[0].id + ' validate: ' + vt.reason };
    extras.push('produces ' + cand[0].id);
  }
  // tech structure unlocks a tech-1 unit (negative then positive gate)
  if (sid === 'SH-08') {
    var wsp = qaFindCell(st, acx, acy, qaOpenPred(st, 3), 20);
    addStructure(st, 'SH-05', 0, wsp.x, wsp.y);
    var t1 = data.units.filter(function (u) {
      return u.faction === faction && u.tech === 1
        && requiredProducer(st.unitDefs[u.id]) === 'SH-05';
    })[0] || data.units.filter(function (u) {
      return u.faction === faction && u.tech === 1;
    })[0];
    if (!t1) return { pass: false, detail: 'no tech-1 unit for ' + faction };
    var vg = validateCommand(st, { player: 0, type: 'trainUnit', unitId: t1.id });
    if (!vg.ok || !hasTech(st, 0)) {
      return { pass: false, detail: 'tech-1 ' + t1.id + ' still gated: ' + vg.reason };
    }
    extras.push('unlocks ' + t1.id);
  }
  // defensive structure acquires and damages a hostile in range
  if (sdef.type === 'Def') {
    var sd = st.structDefs[sid];
    var cols = ['inf', 'light', 'armor', 'air', 'bldg'];
    var bestCol = cols[0];
    for (var ci = 0; ci < cols.length; ci++) {
      if ((sd.dmg[cols[ci]] || 0) > (sd.dmg[bestCol] || 0)) bestCol = cols[ci];
    }
    var pc = structCenter(placed);
    var pcx = cellOf(pc.x), pcy = cellOf(pc.y);
    var rLim = sd.rangeWu * 0.8;
    var dummy = null, dMax = 0;
    var near = function (x, y) {
      var wx = x * CELL + CELL / 2, wy = y * CELL + CELL / 2;
      return dist2(wx, wy, pc.x, pc.y) <= rLim * rLim;
    };
    if (bestCol === 'air') {
      var ad = qaDummyDef(st, function (u) { return u.domain === 'Air' && u.rof_s > 0; });
      var ac = qaFindCell(st, pcx, pcy, function (x, y) { return near(x, y); }, Math.ceil(sd.range));
      if (ac) { dummy = addUnit(st, ad.id, 1, ac.x * CELL + 32, ac.y * CELL + 32); dMax = dummy.maxHp; }
    } else if (bestCol === 'armor') {
      var hd = qaDummyDef(st, function (u) {
        return u.armor === 'Heavy' && u.domain === 'Land'
          && (!u.ability || u.ability.indexOf('Trophy') < 0);
      });
      var hc = qaFindCell(st, pcx, pcy, function (x, y) {
        return near(x, y) && terrainAt(st, x, y) === 0 && !structAtCell(st, x, y);
      }, Math.ceil(sd.range));
      if (hc) { dummy = addUnit(st, hd.id, 1, hc.x * CELL + 32, hc.y * CELL + 32); dMax = dummy.maxHp; }
    } else if (bestCol === 'light') {
      var lc = qaFindCell(st, pcx, pcy, function (x, y) {
        return near(x, y) && terrainAt(st, x, y) === 0 && !structAtCell(st, x, y);
      }, Math.ceil(sd.range));
      if (lc) { dummy = addUnit(st, 'HARV', 1, lc.x * CELL + 32, lc.y * CELL + 32); dMax = dummy.maxHp; }
    } else if (bestCol === 'inf') {
      var idf = qaDummyDef(st, function (u) { return u.armor === 'Soft'; });
      var ic = qaFindCell(st, pcx, pcy, function (x, y) {
        return near(x, y) && terrainAt(st, x, y) === 0 && !structAtCell(st, x, y);
      }, Math.ceil(sd.range));
      if (ic) { dummy = addUnit(st, idf.id, 1, ic.x * CELL + 32, ic.y * CELL + 32); dMax = dummy.maxHp; }
    } else {
      var bc = qaFindCell(st, pcx, pcy, function (x, y) {
        return near(x, y) && qaOpenPred(st, 2)(x, y);
      }, Math.ceil(sd.range));
      if (bc) { dummy = addStructure(st, 'SH-09', 1, bc.x, bc.y); dMax = dummy.maxHp; }
    }
    if (!dummy) return { pass: false, detail: 'no legal dummy spot in range (col ' + bestCol + ')' };
    var hurt = false;
    for (var bt = 0; bt < 60 && !hurt; bt++) {
      tick(st);
      var cur = st.units[dummy.id] || st.structures[dummy.id];
      if (!cur || cur.hp < dMax) hurt = true;
    }
    if (!hurt) return { pass: false, detail: 'did not damage dummy in 60 ticks (col ' + bestCol + ')' };
    extras.push('fired on ' + (dummy.defId || '?'));
  }
  // oil depot: bundled harvester + income
  if (sid === 'SH-03') {
    var hv = st.units[placed.harvesterId];
    if (!hv) return { pass: false, detail: 'no harvester bundled with depot' };
    var cBefore = p.credits;
    for (var et = 0; et < 100; et++) tick(st);
    if (p.credits <= cBefore) return { pass: false, detail: 'no oil income over 100 ticks' };
    extras.push('income +' + (p.credits - cBefore) + '/100t');
  }
  // superweapon: charge starts
  if (sdef.type === 'SW') {
    if (swAfterPlace !== 3000) {
      return { pass: false, detail: 'swChargeTicks=' + swAfterPlace + ' (expect 3000)' };
    }
    extras.push('charging');
  }
  // unique structures gate their faction ability
  if (sid === 'SH-12' || sid === 'SH-29' || sid === 'SH-33') {
    var va = validateCommand(st, { player: 0, type: 'useFactionAbility', x: cc.x, y: cc.y });
    if (!va.ok) return { pass: false, detail: 'ability still gated: ' + va.reason };
    extras.push('ability ungated');
  }
  return { pass: true, detail: extras.join('; ') || 'build+place+power ok' };
}

function qaPhaseStructures(data, maps) {
  var out = [];
  var check = qaMk(out);
  for (var i = 0; i < data.structures.length; i++) {
    var sdef = data.structures[i];
    try {
      var r = qaStructOne(data, maps, sdef);
      check('struct ' + sdef.id + ' ' + sdef.name, r.pass, r.detail);
    } catch (e) {
      check('struct ' + sdef.id + ' ' + sdef.name, false, 'exception: ' + (e && e.stack || e));
    }
  }
  return out;
}

// ---------- phase 3: units ----------
function qaUnitAttack(st, u, def, enemySlot) {
  // returns {pass, detail}; assumes u is alive and stationary
  if (def.cls === 'Engineer') {
    // repair: damage an own structure, idle engineer next to it
    var own = standingStructs(st, u.owner, function (s) { return s.defId === 'SH-04'; })[0]
      || standingStructs(st, u.owner)[0];
    if (!own) return { pass: false, detail: 'no own structure to repair' };
    own.hp = Math.max(1, own.maxHp >> 1);
    var oc = structCenter(own);
    var eSpot = qaFindCell(st, cellOf(oc.x), cellOf(oc.y), function (x, y) {
      var wx = x * CELL + 32, wy = y * CELL + 32;
      return terrainAt(st, x, y) === 0 && !structAtCell(st, x, y)
        && dist2(wx, wy, oc.x, oc.y) <= def.rangeWu * def.rangeWu;
    }, 8);
    if (!eSpot) return { pass: false, detail: 'no repair spot' };
    u.x = eSpot.x * CELL + 32; u.y = eSpot.y * CELL + 32;
    u.order = { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
    var hp0 = own.hp;
    for (var rt = 0; rt < 60 && own.hp === hp0; rt++) tick(st);
    var repaired = own.hp > hp0;
    // capture: neutral structure in range, attackTarget channel
    var nSpot = qaFindCell(st, cellOf(u.x), cellOf(u.y), qaOpenPred(st, 2), 8);
    if (!nSpot) return { pass: false, detail: 'repaired=' + repaired + '; no capture spot' };
    var neutral = addStructure(st, 'SH-02', -1, nSpot.x, nSpot.y);
    var nc = structCenter(neutral);
    var wSpot = qaFindCell(st, cellOf(nc.x), cellOf(nc.y), function (x, y) {
      var wx = x * CELL + 32, wy = y * CELL + 32;
      return terrainAt(st, x, y) === 0 && !structAtCell(st, x, y)
        && dist2(wx, wy, nc.x, nc.y) <= def.rangeWu * def.rangeWu;
    }, 8);
    if (!wSpot) return { pass: false, detail: 'repaired=' + repaired + '; no capture approach cell' };
    u.x = wSpot.x * CELL + 32; u.y = wSpot.y * CELL + 32;
    applyCommand(st, { player: u.owner, type: 'attackTarget', unitIds: [u.id], targetId: neutral.id });
    var capped = false;
    for (var ct = 0; ct < 300 && !capped; ct++) {
      tick(st);
      if (st.structures[neutral.id] && st.structures[neutral.id].owner === u.owner) capped = true;
    }
    return { pass: repaired && capped,
      detail: 'repair ' + hp0 + '->' + own.hp + ', capture=' + capped };
  }

  // kamikaze air (rof_s 0, armed): detonate on a targeted structure
  if (def.domain === 'Air' && def.rof_s === 0) {
    var kSpot = qaFindCell(st, cellOf(u.x), cellOf(u.y), function (x, y) {
      var wx = x * CELL + CELL, wy = y * CELL + CELL; // SH-09 center (fp 2)
      return qaOpenPred(st, 2)(x, y) && dist2(wx, wy, u.x, u.y) <= (3 * CELL) * (3 * CELL);
    }, 6);
    if (!kSpot) return { pass: false, detail: 'no kamikaze target spot' };
    var tgt = addStructure(st, 'SH-09', enemySlot, kSpot.x, kSpot.y);
    var tMax = tgt.maxHp;
    applyCommand(st, { player: u.owner, type: 'attackTarget', unitIds: [u.id], targetId: tgt.id });
    var gone = false, hit = false;
    for (var kt = 0; kt < 300 && !gone; kt++) {
      tick(st);
      if (!st.units[u.id]) gone = true;
      var curT = st.structures[tgt.id];
      if (!curT || curT.hp < tMax) hit = true;
    }
    return { pass: gone && hit, detail: 'detonated=' + gone + ' targetHit=' + hit };
  }

  // normal armed unit: attackTarget a dummy weak to its best damage column
  var cols = ['air', 'armor', 'light', 'inf', 'bldg'];
  var bestCol = cols[0];
  for (var ci = 0; ci < cols.length; ci++) {
    if ((def.dmg[cols[ci]] || 0) > (def.dmg[bestCol] || 0)) bestCol = cols[ci];
  }
  var sea = def.domain === 'Sea';
  var rLim = def.rangeWu * 0.8;
  var ux = u.x, uy = u.y;
  var near = function (x, y, off) {
    var wx = x * CELL + (off || CELL / 2), wy = y * CELL + (off || CELL / 2);
    return dist2(wx, wy, ux, uy) <= rLim * rLim;
  };
  var maxR = Math.ceil(def.range) + 2;
  var dummy = null, dMax = 0;
  if (bestCol === 'air') {
    var ad = qaDummyDef(st, function (q) { return q.domain === 'Air' && q.rof_s > 0; });
    var ac = qaFindCell(st, cellOf(ux), cellOf(uy), function (x, y) { return near(x, y); }, maxR);
    if (ac) { dummy = addUnit(st, ad.id, enemySlot, ac.x * CELL + 32, ac.y * CELL + 32); dMax = dummy.maxHp; }
  } else if (bestCol === 'armor' && sea) {
    var nd = qaDummyDef(st, function (q) { return q.armor === 'Naval'; });
    var ncc = qaFindCell(st, cellOf(ux), cellOf(uy), function (x, y) {
      return near(x, y) && terrainAt(st, x, y) === 2;
    }, maxR);
    if (ncc) { dummy = addUnit(st, nd.id, enemySlot, ncc.x * CELL + 32, ncc.y * CELL + 32); dMax = dummy.maxHp; }
  } else if (bestCol === 'armor' || bestCol === 'light' || bestCol === 'inf') {
    var dd = bestCol === 'light'
      ? { id: 'HARV' }
      : qaDummyDef(st, bestCol === 'inf'
        ? function (q) { return q.armor === 'Soft'; }
        : function (q) {
            // Heavy/Medium land dummy; Trophy APS carriers excluded — they eat
            // the first ATGM volley per TrophyCD and skew the hp check
            return (q.armor === 'Heavy' || q.armor === 'Medium') && q.domain === 'Land'
              && (!q.ability || q.ability.indexOf('Trophy') < 0);
          });
    var gc = qaFindCell(st, cellOf(ux), cellOf(uy), function (x, y) {
      return near(x, y) && terrainAt(st, x, y) === 0 && !structAtCell(st, x, y);
    }, maxR);
    if (gc) { dummy = addUnit(st, dd.id, enemySlot, gc.x * CELL + 32, gc.y * CELL + 32); dMax = dummy.maxHp; }
  } else { // bldg
    var bc = qaFindCell(st, cellOf(ux), cellOf(uy), function (x, y) {
      return near(x, y, CELL) && qaOpenPred(st, 2)(x, y);
    }, maxR);
    if (bc) { dummy = addStructure(st, 'SH-09', enemySlot, bc.x, bc.y); dMax = dummy.maxHp; }
  }
  if (!dummy) return { pass: false, detail: 'no dummy spot in range (col ' + bestCol + ')' };
  applyCommand(st, { player: u.owner, type: 'attackTarget', unitIds: [u.id], targetId: dummy.id });
  var budget = Math.max(80, def.cooldownTicks + 60);
  var hurt = false;
  for (var at = 0; at < budget && !hurt; at++) {
    tick(st);
    var cur = st.units[dummy.id] || st.structures[dummy.id];
    if (!cur || cur.hp < dMax) hurt = true;
    if (!st.units[u.id]) break; // attacker died (return fire) — result stands on dummy state
  }
  return { pass: hurt, detail: 'col=' + bestCol + ' dummy=' + dummy.defId + ' hurt=' + hurt };
}

function qaFactionUnits(data, maps, faction) {
  var out = [];
  var check = qaMk(out);
  var enemy = faction === 'Egypt' ? 'Algeria' : 'Egypt';
  var map = maps.coast; // wet map so Land/Air/Sea all testable
  var st = createMatch({ data: data, map: map,
    players: [{ faction: faction, slot: 0 }, { faction: enemy, slot: 1 }], seed: 555 });
  var p = st.players[0];
  p.credits = 100000000;
  var rd = qaDeploy(st, 0);
  if (!rd.ok) {
    check('units ' + faction + ' setup', false, 'deploy failed: ' + rd.reason);
    return out;
  }
  var cy = qaCy(st, 0);
  var cc = structCenter(cy);
  var bcx = cellOf(cc.x), bcy = cellOf(cc.y);
  function put(sid) {
    var spot = qaFindCell(st, bcx, bcy, qaOpenPred(st, st.structDefs[sid].fp), 25);
    if (!spot) return null;
    return addStructure(st, sid, 0, spot.x, spot.y);
  }
  put('SH-02'); put('SH-02'); put('SH-02');
  put('SH-04'); put('SH-05'); put('SH-06'); put('SH-08');
  var nySpot = qaFindCell(st, bcx, bcy, qaNavalPred(st, 3), 60);
  var yard = nySpot ? addStructure(st, 'SH-07', 0, nySpot.x, nySpot.y) : null;

  var units = data.units.filter(function (u) { return u.faction === faction; })
    .sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  var results = {}; // unitId -> {spawn, spawnDetail, move, attack, attackDetail}
  var queued = [];
  for (var i = 0; i < units.length; i++) {
    var def = units[i];
    var res = { def: def, spawned: null, spawnOk: false, spawnDetail: '',
      moveOk: false, attackOk: null, attackDetail: '' };
    results[def.id] = res;
    // producer gate sanity
    var prodId = requiredProducer(st.unitDefs[def.id]);
    var prodDef = prodId && st.structDefs[prodId];
    if (!prodDef || prodDef.type !== 'Prod') {
      res.spawnDetail = 'requiredProducer=' + prodId + ' not a Prod structure';
      continue;
    }
    if (def.domain === 'Sea' && !yard) {
      res.spawnDetail = 'no water-adjacent naval yard spot on coast';
      continue;
    }
    var v = validateCommand(st, { player: 0, type: 'trainUnit', unitId: def.id });
    if (!v.ok) {
      res.spawnDetail = 'train validate: ' + v.reason;
      continue;
    }
    applyCommand(st, { player: 0, type: 'trainUnit', unitId: def.id });
    queued.push(def.id);
  }

  // spawn phase: tick until every queued unit appears
  var pending = {};
  queued.forEach(function (id) { pending[id] = true; });
  var totalBuild = queued.reduce(function (n, id) {
    return n + st.unitDefs[id].buildTicks;
  }, 0);
  var guard = 0;
  var seen = {};
  while (Object.keys(pending).length && guard++ < totalBuild + 3000) {
    tick(st);
    var ids = Object.keys(st.units);
    for (var k = 0; k < ids.length; k++) {
      var uu = st.units[ids[k]];
      if (uu.owner !== 0 || uu.defId === 'MCV' || uu.defId === 'HARV' || seen[uu.id]) continue;
      seen[uu.id] = true;
      var rr = results[uu.defId];
      if (!rr || rr.spawned) continue;
      rr.spawned = uu;
      delete pending[uu.defId];
      var ucx = cellOf(uu.x), ucy = cellOf(uu.y);
      var tt = terrainAt(st, ucx, ucy);
      var inFp = !!structAtCell(st, ucx, ucy);
      var dom = rr.def.domain;
      rr.spawnOk = dom === 'Air' ? (tt >= 0) : dom === 'Sea' ? (tt === 2)
        : (tt === 0 && !inFp);
      rr.spawnDetail = 'cell(' + ucx + ',' + ucy + ') terrain=' + tt + ' inFootprint=' + inFp;
    }
  }
  for (var pid in pending) {
    results[pid].spawnDetail = (results[pid].spawnDetail ? results[pid].spawnDetail + '; ' : '')
      + 'never spawned (guard ' + guard + ')';
  }

  // move phase: stop everyone, order toward map center, batch-run
  var starts = {};
  var movePending = [];
  for (var mid in results) {
    var mr = results[mid];
    if (!mr.spawned || !st.units[mr.spawned.id]) continue;
    var mu = st.units[mr.spawned.id];
    applyCommand(st, { player: 0, type: 'stop', unitIds: [mu.id] });
    var mcx = cellOf(mu.x), mcy = cellOf(mu.y);
    var dirX = st.map.w / 2 >= mcx ? 1 : -1;
    var dirY = st.map.h / 2 >= mcy ? 1 : -1;
    var want = mr.def.domain === 'Sea' ? 2 : 0;
    var tgtCell = qaFindCell(st, mcx + dirX * 7, mcy + dirY * 7, function (x, y) {
      if (mr.def.domain === 'Air') return true;
      if (terrainAt(st, x, y) !== want) return false;
      return mr.def.domain === 'Sea' || !structAtCell(st, x, y);
    }, 6);
    if (!tgtCell) {
      tgtCell = qaFindCell(st, mcx, mcy, function (x, y) {
        var d = Math.max(Math.abs(x - mcx), Math.abs(y - mcy));
        if (d < 5 || d > 10) return false;
        if (mr.def.domain === 'Air') return true;
        if (terrainAt(st, x, y) !== want) return false;
        return mr.def.domain === 'Sea' || !structAtCell(st, x, y);
      }, 10);
    }
    if (!tgtCell) { mr.moveOk = false; mr.moveDetail = 'no target cell'; continue; }
    starts[mu.id] = { x: mu.x, y: mu.y };
    applyCommand(st, { player: 0, type: 'move', unitIds: [mu.id],
      x: tgtCell.x * CELL + 32, y: tgtCell.y * CELL + 32 });
    movePending.push(mu.id);
  }
  var mg = 0;
  while (movePending.length && mg++ < 500) {
    tick(st);
    movePending = movePending.filter(function (uid) {
      var u2 = st.units[uid];
      if (!u2) return false;
      var s0 = starts[uid];
      if (dist2(u2.x, u2.y, s0.x, s0.y) > (2 * CELL) * (2 * CELL)) {
        var rr2 = null;
        for (var q in results) {
          if (results[q].spawned && results[q].spawned.id === uid) rr2 = results[q];
        }
        if (rr2) rr2.moveOk = true;
        return false;
      }
      return true;
    });
  }

  // combat phase: engineers first (they teleport around), then kamikaze
  // (parked Shaheds auto-detonate near hostiles — spend them before other
  // tests place dummies), then everyone else.
  var order = units.slice().sort(function (a, b) {
    function rank(d) {
      if (d.cls === 'Engineer') return 0;
      if (d.domain === 'Air' && d.rof_s === 0) return 1;
      return 2;
    }
    return rank(a) - rank(b);
  });
  for (var oi = 0; oi < order.length; oi++) {
    var od = order[oi];
    var or_ = results[od.id];
    if (!or_.spawned || !st.units[or_.spawned.id]) { or_.attackOk = null; continue; }
    if (!qaHasDmg(od) || od.range <= 0) {
      if (od.cls !== 'Engineer') { or_.attackOk = null; or_.attackDetail = 'unarmed-skip'; continue; }
    }
    var ou = st.units[or_.spawned.id];
    var ar = qaUnitAttack(st, ou, st.unitDefs[od.id], 1);
    or_.attackOk = ar.pass;
    or_.attackDetail = ar.detail;
  }

  // emit one result per unit
  for (var ei = 0; ei < units.length; ei++) {
    var ed = units[ei];
    var er = results[ed.id];
    var pass = er.spawnOk && er.moveOk && (er.attackOk === null || er.attackOk);
    check('unit ' + ed.id + ' ' + ed.name, pass, JSON.stringify({
      spawn: er.spawnOk, spawnInfo: er.spawnDetail,
      move: er.moveOk,
      attack: er.attackOk === null ? 'n/a' : er.attackOk, attackInfo: er.attackDetail,
    }));
  }
  return out;
}

function qaPhaseUnits(data, maps) {
  var out = [];
  var factions = Object.keys(data.factions);
  for (var i = 0; i < factions.length; i++) {
    try {
      var sub = qaFactionUnits(data, maps, factions[i]);
      for (var j = 0; j < sub.length; j++) out.push(sub[j]);
    } catch (e) {
      out.push({ name: 'units ' + factions[i], pass: false,
        detail: 'exception: ' + (e && e.stack || e) });
    }
  }
  // harvester economy (synthetic HARV def, shared by all factions — test once)
  try {
    var check = qaMk(out);
    var map = maps.duel;
    var st = createMatch({ data: data, map: map,
      players: [{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], seed: 77 });
    qaDeploy(st, 0);
    var p = st.players[0];
    p.credits = 100000;
    var o = map.oil[0];
    var dSpot = qaFindCell(st, o.x, o.y, function (x, y) {
      if (!qaOpenPred(st, 3)(x, y)) return false;
      var wx = x * CELL + 3 * CELL / 2, wy = y * CELL + 3 * CELL / 2;
      return Math.max(Math.abs(wx - (o.x * CELL + 32)), Math.abs(wy - (o.y * CELL + 32))) <= 2 * CELL;
    }, 6);
    if (!dSpot) {
      check('harvester oil income', false, 'no depot spot adjacent to oil field');
    } else {
      var depot = addStructure(st, 'SH-03', 0, dSpot.x, dSpot.y);
      var hv = addUnit(st, 'HARV', 0, o.x * CELL + 32, o.y * CELL + 32);
      depot.harvesterId = hv.id;
      var before = p.credits;
      for (var t = 0; t < 100; t++) tick(st);
      var delta = p.credits - before;
      var expect = data.knobs.OilIncomePerField * 10; // 35 cr/s over 10s
      check('harvester oil income', Math.abs(delta - expect) <= 60,
        'delta=' + delta + ' over 100 ticks (expect ~' + expect + ')');
    }
  } catch (e) {
    out.push({ name: 'harvester oil income', pass: false, detail: 'exception: ' + (e && e.stack || e) });
  }
  return out;
}

// ---------- phase 4: faction abilities ----------
function qaPhaseAbilities(data, maps) {
  var out = [];
  var check = qaMk(out);
  var GATE = { Egypt: 'SH-12', Saudi: 'SH-15', India: 'SH-29', Pakistan: 'SH-32', Iran: 'SH-33' };
  var PASSIVE = { UAE: 'edge_network', Algeria: 'integrated_sky',
    Turkey: 'siha_mesh', Israel: 'iron_layer' };
  var factions = Object.keys(data.factions);
  for (var fi = 0; fi < factions.length; fi++) {
    var f = factions[fi];
    try {
      var enemy = f === 'Egypt' ? 'Algeria' : 'Egypt';
      var st = createMatch({ data: data, map: maps.duel,
        players: [{ faction: f, slot: 0 }, { faction: enemy, slot: 1 }], seed: 31 });
      var p = st.players[0];
      var ability = data.factions[f].ability;
      var cmd = { player: 0, type: 'useFactionAbility', x: 48 * CELL, y: 48 * CELL };
      if (PASSIVE[f]) {
        var vp = validateCommand(st, cmd);
        var fieldOk = true, field = '';
        if (ability === 'edge_network') { fieldOk = p.sightBonus === 2; field = 'sightBonus=' + p.sightBonus; }
        if (ability === 'integrated_sky') { fieldOk = p.dmgAirMult === 1.2; field = 'dmgAirMult=' + p.dmgAirMult; }
        if (ability === 'siha_mesh') { fieldOk = p.aggroAirMult === 1.2; field = 'aggroAirMult=' + p.aggroAirMult; }
        if (ability === 'iron_layer') {
          fieldOk = data.units.some(function (u) {
            return u.faction === f && u.ability && u.ability.indexOf('Trophy') >= 0;
          });
          field = 'trophy-unit=' + fieldOk;
        }
        check('ability ' + f + ' (' + ability + ')',
          !vp.ok && vp.reason === 'passive' && fieldOk,
          'validate=' + vp.reason + ' ' + field);
        continue;
      }
      // active ability: gate negative, then ungated effect + cooldown
      qaDeploy(st, 0);
      p.credits = 1000000;
      var cy = qaCy(st, 0);
      var cc = structCenter(cy);
      if (ability === 'saka_insertion') { cmd.x = cc.x; cmd.y = cc.y; } // needs fog visibility
      var vNo = validateCommand(st, cmd);
      if (vNo.ok || vNo.reason !== 'no-unique') {
        check('ability ' + f + ' (' + ability + ')', false,
          'expected no-unique gate, got ' + JSON.stringify(vNo));
        continue;
      }
      var gSpot = qaFindCell(st, cellOf(cc.x), cellOf(cc.y), qaOpenPred(st, st.structDefs[GATE[f]].fp), 15);
      addStructure(st, GATE[f], 0, gSpot.x, gSpot.y);
      var uBefore = Object.keys(st.units).length;
      var prBefore = Object.keys(st.projectiles).length;
      var v = validateCommand(st, cmd);
      if (!v.ok) {
        check('ability ' + f + ' (' + ability + ')', false, 'validate with gate: ' + v.reason);
        continue;
      }
      applyCommand(st, cmd);
      var cdOk = p.abilityCdUntil === st.tick + 900;
      var effect = false, eDetail = '';
      if (ability === 'saka_insertion') {
        var added = Object.keys(st.units).length - uBefore;
        effect = added >= 1;
        eDetail = 'infantry dropped=' + added;
      } else if (ability === 'shahed_rain') {
        var drones = Object.keys(st.units).filter(function (id) {
          return st.units[id].defId === 'IR-15' && st.units[id].owner === 0;
        }).length;
        effect = drones === 5;
        eDetail = 'drones=' + drones;
      } else {
        var kinds = Object.keys(st.projectiles).map(function (id) { return st.projectiles[id].kind; });
        var want = ability === 'rsaf_tasking' ? 'airstrike'
          : ability === 'brahmos_lane' ? 'telegraph' : 'cruise';
        var n = kinds.filter(function (k) { return k === want; }).length;
        effect = n >= (want === 'cruise' ? 2 : 1);
        eDetail = want + ' projectiles=' + n;
      }
      var v2 = validateCommand(st, cmd);
      var cdBlock = !v2.ok && v2.reason === 'cooldown';
      check('ability ' + f + ' (' + ability + ')', cdOk && effect && cdBlock,
        'cd=' + cdOk + ' ' + eDetail + ' recast-blocked=' + cdBlock);
    } catch (e) {
      check('ability ' + f, false, 'exception: ' + (e && e.stack || e));
    }
  }
  return out;
}

// ---------- phase 5: faction x map matrix ----------
function qaCombo(data, maps, faction, mapId, seed) {
  var map = maps[mapId];
  var cfgs = [
    { slot: 0, faction: faction },
    { slot: 1, faction: 'Egypt', ai: { personality: 'front', difficulty: 'recruit' } },
  ];
  var st = createMatch({ data: data, map: map, players: cfgs, seed: seed });
  var ai = createAI(cfgs, seed);
  var inf = qaCheapestInf(data, faction);
  var done = {};
  for (var t = 0; t < 600; t++) {
    var cmds = [];
    var p = st.players[0];
    var mcv = qaFindMcv(st, 0);
    if (mcv && !done.dep) { done.dep = 1; cmds.push({ player: 0, type: 'deployMCV', unitId: mcv.id }); }
    var cy = qaCy(st, 0);
    if (cy) {
      var cc = structCenter(cy);
      if (!done.b2) { done.b2 = 1; cmds.push({ player: 0, type: 'buildStructure', structId: 'SH-02' }); }
      if (!done.p2 && p.ready.indexOf('SH-02') >= 0) {
        var s2 = findPlacement(st, 0, st.structDefs['SH-02'], cellOf(cc.x), cellOf(cc.y), 10);
        if (s2) { done.p2 = 1; cmds.push({ player: 0, type: 'placeStructure', structId: 'SH-02', cx: s2.x, cy: s2.y }); }
      }
      if (done.p2 && !done.b4) { done.b4 = 1; cmds.push({ player: 0, type: 'buildStructure', structId: 'SH-04' }); }
      if (!done.p4 && p.ready.indexOf('SH-04') >= 0) {
        var s4 = findPlacement(st, 0, st.structDefs['SH-04'], cellOf(cc.x), cellOf(cc.y), 10);
        if (s4) { done.p4 = 1; cmds.push({ player: 0, type: 'placeStructure', structId: 'SH-04', cx: s4.x, cy: s4.y }); }
      }
      if (done.p4 && !done.tr && inf) {
        done.tr = 1;
        cmds.push({ player: 0, type: 'trainUnit', unitId: inf });
      }
    }
    tick(st, cmds.concat(aiCommands(st, ai)));
  }
  var p0 = st.players[0];
  var cyOk = !!qaCy(st, 0);
  var ppOk = standingStructs(st, 0, function (s) { return s.defId === 'SH-02'; }).length > 0;
  var raxOk = standingStructs(st, 0, function (s) { return s.defId === 'SH-04'; }).length > 0;
  var ok = st.tick === 600 && cyOk && ppOk && raxOk && p0.unitsBuilt >= 1;
  return { pass: ok, detail: JSON.stringify({ tick: st.tick, cy: cyOk, pp: ppOk,
    rax: raxOk, built: p0.unitsBuilt, steps: Object.keys(done).join(',') }) };
}

function qaPhaseCombos(data, maps) {
  var out = [];
  var check = qaMk(out);
  var factions = Object.keys(data.factions);
  for (var fi = 0; fi < factions.length; fi++) {
    for (var mi = 0; mi < MAP_ORDER.length; mi++) {
      var f = factions[fi], m = MAP_ORDER[mi];
      try {
        var r = qaCombo(data, maps, f, m, 9000 + fi * 100 + mi);
        check('combo ' + f + ' @ ' + m, r.pass, r.detail);
      } catch (e) {
        check('combo ' + f + ' @ ' + m, false, 'exception: ' + (e && e.stack || e));
      }
    }
  }
  return out;
}

// ---------- phase 6: AI-vs-AI matches + determinism ----------
function qaAiMatch(data, maps, mapId, factions, seed, cap) {
  var pers = ['front', 'fortress', 'sky', 'raid'];
  var cfgs = factions.map(function (f, i) {
    return { slot: i, faction: f,
      ai: { personality: pers[i % 4], difficulty: 'veteran' } };
  });
  var st = createMatch({ data: data, map: maps[mapId], players: cfgs, seed: seed });
  var ai = createAI(cfgs, seed);
  for (var t = 0; t < cap && !st.over; t++) tick(st, aiCommands(st, ai));
  var elim = st.players.filter(function (p) { return p.eliminated; }).length;
  var built = st.players.reduce(function (n, p) { return n + p.unitsBuilt; }, 0);
  return { over: st.over, winner: st.winner, tick: st.tick, elim: elim, built: built,
    units: Object.keys(st.units).length, structs: Object.keys(st.structures).length };
}

function qaDetRun(data, maps, seed) {
  var st = createMatch({ data: data, map: maps.duel,
    players: [{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], seed: seed });
  var done = {};
  var sums = {};
  for (var t = 0; t <= 2500; t++) {
    var cmds = [];
    for (var slot = 0; slot < 2; slot++) {
      var p = st.players[slot];
      var mcv = qaFindMcv(st, slot);
      if (mcv && !done['dep' + slot]) {
        done['dep' + slot] = 1;
        cmds.push({ player: slot, type: 'deployMCV', unitId: mcv.id });
      }
      var cy = qaCy(st, slot);
      if (cy && t >= 20 && !done['pp' + slot]) {
        done['pp' + slot] = 1;
        cmds.push({ player: slot, type: 'buildStructure', structId: 'SH-02' });
      }
      if (cy && t >= 150 && !done['rax' + slot]) {
        done['rax' + slot] = 1;
        cmds.push({ player: slot, type: 'buildStructure', structId: 'SH-04' });
      }
      if (p.ready.length) {
        var sid = p.ready[0];
        var key = 'place' + slot + sid;
        if (!done[key]) {
          var cc = structCenter(cy);
          var spot = findPlacement(st, slot, st.structDefs[sid], cellOf(cc.x), cellOf(cc.y), 10);
          if (spot) {
            done[key] = 1;
            cmds.push({ player: slot, type: 'placeStructure', structId: sid, cx: spot.x, cy: spot.y });
          }
        }
      }
      var rax = standingStructs(st, slot, function (s) { return s.defId === 'SH-04'; })[0];
      if (rax && !done['train' + slot]) {
        done['train' + slot] = 1;
        var inf = qaCheapestInf(data, p.faction);
        for (var k = 0; k < 3; k++) cmds.push({ player: slot, type: 'trainUnit', unitId: inf });
      }
      var army = Object.keys(st.units).map(function (id) { return st.units[id]; })
        .filter(function (u) { return u.owner === slot && u.defId !== 'MCV' && u.defId !== 'HARV'; });
      if (army.length >= 3 && !done['wave' + slot]) {
        done['wave' + slot] = 1;
        cmds.push({ player: slot, type: 'attackMove',
          unitIds: army.map(function (u) { return u.id; }), x: 48 * CELL, y: 48 * CELL });
      }
    }
    tick(st, cmds);
    if (t === 500 || t === 1500 || t === 2500) sums[t] = checksum(st);
  }
  return sums;
}

function qaPhaseMatches(data, maps) {
  var out = [];
  var check = qaMk(out);
  // determinism: same seed + script twice -> identical checksums
  try {
    var a = qaDetRun(data, maps, 4242);
    var b = qaDetRun(data, maps, 4242);
    var same = a[500] === b[500] && a[1500] === b[1500] && a[2500] === b[2500];
    check('determinism same-seed checksums', same,
      '@500/1500/2500 = ' + a[500] + '/' + a[1500] + '/' + a[2500]
      + (same ? '' : ' vs ' + b[500] + '/' + b[1500] + '/' + b[2500]));
  } catch (e) {
    check('determinism same-seed checksums', false, 'exception: ' + (e && e.stack || e));
  }
  // elimination: all structures + MCV lost, broke -> eliminated, match over
  try {
    var s1 = createMatch({ data: data, map: maps.duel,
      players: [{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], seed: 5 });
    qaDeploy(s1, 0);
    qaDeploy(s1, 1);
    s1.players[1].credits = 0;
    var cy1 = qaCy(s1, 1);
    dealDamage(s1, cy1, 999999, null);
    tick(s1);
    check('elimination conyard-kill',
      s1.players[1].eliminated && s1.over && s1.winner === s1.players[0].team,
      JSON.stringify({ eliminated: s1.players[1].eliminated, over: s1.over, winner: s1.winner }));
  } catch (e) {
    check('elimination conyard-kill', false, 'exception: ' + (e && e.stack || e));
  }
  // rebuild window: anchored player survives CY loss, rebuilds SH-01 once
  try {
    var s2 = createMatch({ data: data, map: maps.duel,
      players: [{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], seed: 6 });
    qaDeploy(s2, 0);
    qaDeploy(s2, 1);
    var p0 = s2.players[0];
    var cyA = qaCy(s2, 0);
    var ccA = structCenter(cyA);
    var raxSpot = qaFindCell(s2, cellOf(ccA.x), cellOf(ccA.y), qaOpenPred(s2, 3), 12);
    var rax2 = addStructure(s2, 'SH-04', 0, raxSpot.x, raxSpot.y); // anchor survives
    dealDamage(s2, cyA, 999999, null);
    tick(s2);
    var survived = !p0.eliminated;
    var vRe = validateCommand(s2, { player: 0, type: 'buildStructure', structId: 'SH-01' });
    var rebuilt = false, replaced = false;
    if (vRe.ok) {
      applyCommand(s2, { player: 0, type: 'buildStructure', structId: 'SH-01' });
      var g2 = 0;
      while (!p0.ready.includes('SH-01') && g2++ < 200) tick(s2);
      var rc = structCenter(rax2);
      var reSpot = findPlacement(s2, 0, s2.structDefs['SH-01'], cellOf(rc.x), cellOf(rc.y), 10);
      if (reSpot) {
        var vpl = validateCommand(s2, { player: 0, type: 'placeStructure',
          structId: 'SH-01', cx: reSpot.x, cy: reSpot.y });
        if (vpl.ok) {
          applyCommand(s2, { player: 0, type: 'placeStructure',
            structId: 'SH-01', cx: reSpot.x, cy: reSpot.y });
          replaced = !!qaCy(s2, 0) && p0.cyRebuilt;
        }
      }
      rebuilt = true;
    }
    // now lose everything, broke -> eliminated (rebuild already spent)
    var ids2 = Object.keys(s2.structures);
    for (var di = 0; di < ids2.length; di++) {
      if (s2.structures[ids2[di]].owner === 0) delete s2.structures[ids2[di]];
    }
    p0.credits = 0;
    tick(s2);
    check('elimination rebuild-window',
      survived && rebuilt && replaced && p0.eliminated && s2.over,
      JSON.stringify({ survived: survived, rebuilt: rebuilt, replaced: replaced,
        eliminated: p0.eliminated, over: s2.over }));
  } catch (e) {
    check('elimination rebuild-window', false, 'exception: ' + (e && e.stack || e));
  }
  // full AI-vs-AI matches to completion
  var matches = [
    ['ai-full duel 2p', 'duel', ['Egypt', 'Israel'], 31337, 40000],
    ['ai-full coast 4p', 'coast', ['Egypt', 'Iran', 'Turkey', 'India'], 777, 60000],
    ['ai-full hormuz 6p', 'hormuz',
      ['Egypt', 'Saudi', 'Turkey', 'Israel', 'Iran', 'Pakistan'], 2024, 60000],
  ];
  for (var mi = 0; mi < matches.length; mi++) {
    var mm = matches[mi];
    try {
      var r = qaAiMatch(data, maps, mm[1], mm[2], mm[3], mm[4]);
      check(mm[0], r.over, JSON.stringify(r));
    } catch (e) {
      check(mm[0], false, 'exception: ' + (e && e.stack || e));
    }
  }
  return out;
}

// ---------- phase 7: data integrity ----------
function qaPhaseData(data) {
  var out = [];
  var check = qaMk(out);
  var factionKeys = Object.keys(data.factions);
  var DMG_COLS = ['inf', 'light', 'armor', 'air', 'bldg'];
  var ARMORS = ['Soft', 'Light', 'Medium', 'Heavy', 'Naval', 'Air'];
  var STYPES = ['Core', 'Eco', 'Prod', 'Def', 'Tech', 'SW', 'Unique'];

  var badFaction = data.units.filter(function (u) { return factionKeys.indexOf(u.faction) < 0; });
  check('data unit factions known', badFaction.length === 0,
    badFaction.length ? badFaction.map(function (u) { return u.id + ':' + u.faction; }).join(',') : 'all 161 units map to the 9 factions');

  var badFields = [];
  var seenIds = {};
  for (var i = 0; i < data.units.length; i++) {
    var u = data.units[i];
    if (seenIds[u.id]) badFields.push(u.id + ':duplicate-id');
    seenIds[u.id] = true;
    if (!(u.cost > 0)) badFields.push(u.id + ':cost');
    if (!(u.build_s > 0)) badFields.push(u.id + ':build_s');
    if (!(u.hp > 0)) badFields.push(u.id + ':hp');
    if (!(u.speed > 0)) badFields.push(u.id + ':speed');
    if (!(u.sight > 0)) badFields.push(u.id + ':sight');
    if (!(u.range >= 0)) badFields.push(u.id + ':range');
    if (ARMORS.indexOf(u.armor) < 0) badFields.push(u.id + ':armor=' + u.armor);
    if (u.tech !== 0 && u.tech !== 1) badFields.push(u.id + ':tech=' + u.tech);
    if (['Land', 'Air', 'Sea'].indexOf(u.domain) < 0) badFields.push(u.id + ':domain=' + u.domain);
    for (var k in u.dmg) {
      if (DMG_COLS.indexOf(k) < 0) badFields.push(u.id + ':dmg.' + k);
    }
    if (!(data.armorIncoming[u.armor] > 0)) badFields.push(u.id + ':armorIncoming[' + u.armor + ']');
  }
  check('data unit fields valid', badFields.length === 0,
    badFields.slice(0, 12).join(',') || 'cost/build/hp/speed/sight/armor/tech/dmg-cols all valid');

  var kitBad = [];
  for (var fi = 0; fi < factionKeys.length; fi++) {
    var f = factionKeys[fi];
    var mine = data.units.filter(function (u) { return u.faction === f; });
    var t0inf = mine.some(function (u) { return u.cls === 'Infantry' && u.tech === 0; });
    var t0armed = mine.some(function (u) {
      return u.tech === 0
        && u.dmg.inf + u.dmg.light + u.dmg.armor + u.dmg.air + u.dmg.bldg > 0 && u.range > 0;
    });
    var eng = mine.some(function (u) { return u.cls === 'Engineer'; });
    var cnt = data.factions[f].unitCount === mine.length;
    if (!(t0inf && t0armed && eng && cnt)) {
      kitBad.push(f + '(t0inf=' + t0inf + ',t0armed=' + t0armed + ',eng=' + eng
        + ',count=' + cnt + ' ' + data.factions[f].unitCount + 'vs' + mine.length + ')');
    }
  }
  check('data faction T0 kits', kitBad.length === 0,
    kitBad.join(';') || 'each faction: tech-0 infantry + tech-0 armed + engineer + unitCount matches');

  var badS = [];
  var seenS = {};
  for (var si = 0; si < data.structures.length; si++) {
    var s = data.structures[si];
    if (seenS[s.id]) badS.push(s.id + ':duplicate-id');
    seenS[s.id] = true;
    if (STYPES.indexOf(s.type) < 0) badS.push(s.id + ':type=' + s.type);
    if (s.faction !== 'All' && factionKeys.indexOf(s.faction) < 0) badS.push(s.id + ':faction=' + s.faction);
    if (!(s.cost > 0)) badS.push(s.id + ':cost');
    if (s.id !== 'SH-01' && !(s.build_s > 0)) badS.push(s.id + ':build_s');
    if (!(s.hp > 0)) badS.push(s.id + ':hp');
    if (s.type === 'Def' && !(s.dmg && s.range > 0 && s.rof_s > 0)) badS.push(s.id + ':def-no-weapon');
  }
  check('data structure fields valid', badS.length === 0,
    badS.slice(0, 12).join(',') || 'types/costs/build times/Def weapons all valid');
  return out;
}
"""


def main() -> int:
    # console-safe output: unit names carry non-cp1252 chars (e.g. Turkish ı)
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    bundle = "\n;\n".join(inline(CLIENT / m) for m in MODULES)
    ctx = MiniRacer()
    payload = (CLIENT / "data/game.json").read_text(encoding="utf-8")
    ctx.eval(f"var __data = {json.dumps(payload)};")
    for m in MAPS:
        mp = (CLIENT / f"maps/{m}.json").read_text(encoding="utf-8")
        ctx.eval(f"var __map_{m} = {json.dumps(mp)};")
    ctx.eval(bundle)
    ctx.eval(TEST_JS)
    ctx.eval(
        "var DATA = JSON.parse(__data);"
        "var MAPS = {"
        + ",".join(f"{m}: JSON.parse(__map_{m})" for m in MAPS)
        + "};"
    )

    phases = [
        ("maps", "JSON.stringify(qaPhaseMaps(DATA, MAPS))"),
        ("structures", "JSON.stringify(qaPhaseStructures(DATA, MAPS))"),
        ("units", "JSON.stringify(qaPhaseUnits(DATA, MAPS))"),
        ("abilities", "JSON.stringify(qaPhaseAbilities(DATA, MAPS))"),
        ("combos", "JSON.stringify(qaPhaseCombos(DATA, MAPS))"),
        ("matches", "JSON.stringify(qaPhaseMatches(DATA, MAPS))"),
        ("data", "JSON.stringify(qaPhaseData(DATA))"),
    ]

    all_results = []
    for label, expr in phases:
        t0 = time.perf_counter()
        results = json.loads(ctx.eval(expr))
        dt = time.perf_counter() - t0
        passed = sum(1 for r in results if r["pass"])
        print(f"--- phase {label}: {passed}/{len(results)} passed ({dt:.1f}s) ---")
        for r in results:
            line = f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}"
            print(line if not r["pass"] else line[:200])
        all_results.extend(results)

    # timed 3000-tick AI-vs-AI match on hormuz (perf budget check)
    t0 = time.perf_counter()
    timed = json.loads(ctx.eval(
        "JSON.stringify((function () {"
        "  try {"
        "    var r = qaAiMatch(DATA, MAPS, 'hormuz',"
        "      ['Egypt', 'Saudi', 'Turkey', 'Israel', 'Iran', 'Pakistan'], 60606, 3000);"
        "    return { err: null, r: r };"
        "  } catch (e) { return { err: String(e && e.stack || e), r: null }; }"
        "})())"
    ))
    dt_ms = int((time.perf_counter() - t0) * 1000)
    perf_ok = timed["err"] is None and dt_ms < 120000
    perf = {
        "name": "perf hormuz 6p 3000-tick AI match",
        "pass": perf_ok,
        "detail": (f"{dt_ms}ms " + (json.dumps(timed["r"]) if timed["r"] else timed["err"])),
    }
    print(f"{'PASS' if perf['pass'] else 'FAIL'}  {perf['name']}  --  {perf['detail']}")
    all_results.append(perf)

    passed = sum(1 for r in all_results if r["pass"])
    print(f"\n{passed}/{len(all_results)} passed")
    report = Path(__file__).resolve().parent / "qa_report.json"
    report.write_text(json.dumps(all_results, indent=1), encoding="utf-8")
    print(f"full report written to {report}")
    return 0 if passed == len(all_results) else 1


if __name__ == "__main__":
    sys.exit(main())
