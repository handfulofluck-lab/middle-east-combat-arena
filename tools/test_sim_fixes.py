# DeepSeek review sim-fix regression suite (v0.4.2; extended v0.9.1 hostile
# internal audit). Inline ES-module harness like test_deploy.py: covers
# neutral-unit hostility, attack-move leash, attackTarget friendly validation,
# repair command, placeStructure guard, spatial-scan equivalence,
# enemyBaseTarget neutral skip, harv boxed depot, oil-field build block,
# separation/doorway, PLUS the v0.9.1 fixes: AI unplaceable-ready stall,
# checksum format completion (self-identity + hole closure + field-order swap),
# tracer srcUnitId, shahed_rain off-map spawns, stance-3 explicit fire, and
# armor-viability acquisition (blank volleys).
# Usage: tools/.venv/Scripts/python tools/test_sim_fixes.py
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
]


def inline(path: Path) -> str:
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"import\s+[\s\S]*?\sfrom\s*'[^']*';", "", src)
    src = re.sub(r"export\s*\{[\s\S]*?\}\s*from\s*'[^']*';", "", src)
    src = re.sub(r"^export\s+(async function|function|const|let)", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[\s\S]*?\};", "", src, flags=re.M)
    return src


TEST_JS = r"""
function runSimFixTests(data, duel) {
  const out = [];
  const mk = (players, seed) => createMatch({
    data, map: JSON.parse(JSON.stringify(duel)), players, seed: seed || 7 });
  const cheapestInf = (f) => data.units
    .filter((u) => u.faction === f && u.cls === 'Infantry')
    .sort((a, b) => a.cost - b.cost)[0].id;
  const deploy = (st, slot) => {
    const mcv = Object.values(st.units).find((u) => u.owner === slot && u.defId === 'MCV');
    return applyCommand(st, { player: slot, type: 'deployMCV', unitId: mcv.id });
  };
  const openSpot = (st, fp, nx, ny) => {
    for (let r = 0; r <= 20; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = nx + dx, y = ny + dy;
          let ok = true;
          for (let ay = 0; ay < fp && ok; ay++) {
            for (let ax = 0; ax < fp && ok; ax++) {
              const qx = x + ax, qy = y + ay;
              if (qx < 0 || qy < 0 || qx >= st.map.w || qy >= st.map.h
                  || st.map.terrain[qy * st.map.w + qx] !== 0
                  || structAtCell(st, qx, qy)) ok = false;
            }
          }
          if (ok) return { x, y };
        }
      }
    }
    return null;
  };

  // T1: neutral (owner -1) units are hostile/targetable but stay passive
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 },
      { faction: 'Egypt', slot: 2 }], 5);
    deploy(st, 1);
    const rifle = addUnit(st, cheapestInf('Algeria'), 1, 40 * 64, 40 * 64);
    const cy = standingStructs(st, 1, (s) => s.defId === 'SH-01')[0];
    st.players[1].credits = 0; // no rebuild window
    dealDamage(st, cy, 999999, null);
    tick(st);
    const neutral = st.units[rifle.id];
    const hostile = !!neutral && neutral.owner === -1
      && st.players[1].eliminated && isHostile(st, 0, neutral);
    const x0 = neutral ? neutral.x : -1, y0 = neutral ? neutral.y : -1;
    for (let i = 0; i < 60; i++) tick(st);
    const passive = !!st.units[rifle.id]
      && st.units[rifle.id].x === x0 && st.units[rifle.id].y === y0;
    const atk = addUnit(st, cheapestInf('Egypt'), 0, x0 + 64, y0);
    const v = validateCommand(st, { player: 0, type: 'attackTarget',
      unitIds: [atk.id], targetId: rifle.id });
    applyCommand(st, { player: 0, type: 'attackTarget',
      unitIds: [atk.id], targetId: rifle.id });
    let dead = false;
    for (let i = 0; i < 900 && !dead; i++) { tick(st); if (!st.units[rifle.id]) dead = true; }
    out.push({ name: 'T1 neutral unit hostile + passive + attackable',
      pass: hostile && passive && v.ok && dead,
      detail: JSON.stringify({ hostile, passive, valid: v.ok, dead }) });
  }

  // T2: ai.js enemyBaseTarget skips owner -1 structures entirely
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 6);
    addStructure(st, 'SH-02', -1, 10, 10); // neutral ruin, closest
    const far = addStructure(st, 'SH-02', 1, 60, 60);
    const t = enemyBaseTarget(st, st.players[0], { x: 0, y: 0 });
    const fc = structCenter(far);
    const skips = !!t && t.x === fc.x && t.y === fc.y;
    const st2 = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 6);
    addStructure(st2, 'SH-02', -1, 10, 10); // neutrals only
    const t2 = enemyBaseTarget(st2, st2.players[0], { x: 0, y: 0 });
    const sp = st2.map.spawns[1];
    const fallback = !!t2 && t2.x === sp.x * 64 + 32 && t2.y === sp.y * 64 + 32;
    out.push({ name: 'T2 enemyBaseTarget skips neutrals',
      pass: skips && fallback,
      detail: JSON.stringify({ skips, spawnFallback: fallback, t2 }) });
  }

  // T3: attack-move leash drops a chase whose target is > 2*sight from the
  // destination; attackTarget keeps chasing (explicit intent)
  {
    const D = { x: 60 * 64, y: 10 * 64 };
    const fleeTo = { x: 6 * 64, y: 55 * 64 };
    const setup = (seed) => {
      const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], seed);
      const atk = addUnit(st, cheapestInf('Egypt'), 0, 10 * 64, 10 * 64);
      const foe = addUnit(st, 'DZ-07', 1, 12 * 64, 10 * 64); // T-90SA, tough
      applyCommand(st, { player: 1, type: 'move', unitIds: [foe.id], x: fleeTo.x, y: fleeTo.y });
      return { st, atk, foe };
    };
    // attackMove: target starts ~48 cells from D (2*sight is ~12-16) -> no chase
    const a = setup(11);
    applyCommand(a.st, { player: 0, type: 'attackMove', unitIds: [a.atk.id], x: D.x, y: D.y });
    for (let i = 0; i < 3000 && a.st.units[a.atk.id]
        && a.st.units[a.atk.id].order.type !== 'idle'; i++) tick(a.st);
    const am = a.st.units[a.atk.id];
    const arrived = !!am && am.order.type === 'idle'
      && dist2(am.x, am.y, D.x, D.y) <= (3 * 64) * (3 * 64);
    // attackTarget: same geometry, but the chase must stick. Assert at the
    // moment the fleeing target completes its move — after that it goes idle
    // and (correctly) kills the chaser, which is not what we are testing.
    const b = setup(11);
    applyCommand(b.st, { player: 0, type: 'attackTarget', unitIds: [b.atk.id], targetId: b.foe.id });
    for (let i = 0; i < 1500; i++) {
      tick(b.st);
      const f = b.st.units[b.foe.id];
      if (!f || f.order.type === 'idle') break;
    }
    const bt = b.st.units[b.atk.id];
    const bf = b.st.units[b.foe.id];
    const chased = !!bt && bt.order.type === 'attackTarget' && !!bf
      && dist2(bt.x, bt.y, bf.x, bf.y) < dist2(bt.x, bt.y, D.x, D.y);
    out.push({ name: 'T3 attack-move leash vs attackTarget chase',
      pass: arrived && chased,
      detail: JSON.stringify({ leashResume: arrived, targetChases: chased,
        amPos: am ? [am.x, am.y] : null, btPos: bt ? [bt.x, bt.y] : null,
        foePos: bf ? [bf.x, bf.y] : null }) });
  }

  // T4: attackTarget on a friendly unit is rejected; hostile + neutral pass
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 8);
    const a1 = addUnit(st, cheapestInf('Egypt'), 0, 20 * 64, 20 * 64);
    const a2 = addUnit(st, cheapestInf('Egypt'), 0, 21 * 64, 20 * 64);
    const en = addUnit(st, cheapestInf('Algeria'), 1, 22 * 64, 20 * 64);
    const ns = addStructure(st, 'SH-02', -1, 30, 30);
    const vf = validateCommand(st, { player: 0, type: 'attackTarget',
      unitIds: [a1.id], targetId: a2.id });
    const ve = validateCommand(st, { player: 0, type: 'attackTarget',
      unitIds: [a1.id], targetId: en.id });
    const vn = validateCommand(st, { player: 0, type: 'attackTarget',
      unitIds: [a1.id], targetId: ns.id });
    out.push({ name: 'T4 attackTarget friendly rejected',
      pass: !vf.ok && vf.reason === 'friendly-target' && ve.ok && vn.ok,
      detail: JSON.stringify({ friendly: vf, enemy: ve.ok, neutralStruct: vn.ok }) });
  }

  // T5: repair command — validate rules, apply sets the order, hp rises
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 9);
    deploy(st, 0);
    const cyS = standingStructs(st, 0, (s) => s.defId === 'SH-01')[0];
    const cc = structCenter(cyS);
    const spot = openSpot(st, 3, cellOf(cc.x) + 6, cellOf(cc.y));
    const rax = addStructure(st, 'SH-04', 0, spot.x, spot.y);
    rax.hp = rax.maxHp >> 1;
    const rc = structCenter(rax);
    const engDef = data.units.find((u) => u.faction === 'Egypt' && u.cls === 'Engineer');
    const eng = addUnit(st, engDef.id, 0, rc.x + 6 * 64, rc.y); // out of range
    const rifle = addUnit(st, cheapestInf('Egypt'), 0, rc.x + 6 * 64, rc.y + 64);
    const full = addStructure(st, 'SH-02', 0, spot.x, spot.y + 5);
    const espot = openSpot(st, 3, cellOf(cc.x) - 8, cellOf(cc.y));
    const foe = addStructure(st, 'SH-04', 1, espot.x, espot.y);
    foe.hp = foe.maxHp >> 1;
    const vOk = validateCommand(st, { player: 0, type: 'repair',
      unitIds: [eng.id], targetId: rax.id });
    const vNonEng = validateCommand(st, { player: 0, type: 'repair',
      unitIds: [rifle.id], targetId: rax.id });
    const vFull = validateCommand(st, { player: 0, type: 'repair',
      unitIds: [eng.id], targetId: full.id });
    const vFoe = validateCommand(st, { player: 0, type: 'repair',
      unitIds: [eng.id], targetId: foe.id });
    applyCommand(st, { player: 0, type: 'repair', unitIds: [eng.id], targetId: rax.id });
    const orderSet = eng.order.type === 'repair' && eng.order.targetId === rax.id;
    const hp0 = rax.hp;
    let rose = false;
    for (let i = 0; i < 600 && !rose; i++) { tick(st); if (rax.hp > hp0) rose = true; }
    out.push({ name: 'T5 repair command validate/apply/heal',
      pass: vOk.ok && !vNonEng.ok && vNonEng.reason === 'no-engineers'
        && !vFull.ok && vFull.reason === 'not-damaged'
        && !vFoe.ok && vFoe.reason === 'bad-target'
        && orderSet && rose,
      detail: JSON.stringify({ vOk: vOk.ok, vNonEng: vNonEng.reason,
        vFull: vFull.reason, vFoe: vFoe.reason, orderSet,
        hp: hp0 + '->' + rax.hp }) });
  }

  // T6: placeStructure never splices a non-ready id
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 10);
    deploy(st, 0);
    st.players[0].ready = ['SH-04'];
    const r = applyCommand(st, { player: 0, type: 'placeStructure',
      structId: 'SH-02', cx: 5, cy: 5 });
    const intact = st.players[0].ready.length === 1 && st.players[0].ready[0] === 'SH-04';
    out.push({ name: 'T6 placeStructure not-ready guard',
      pass: !r.ok && r.reason === 'not-ready' && intact,
      detail: JSON.stringify({ r, ready: st.players[0].ready }) });
  }

  // T7: spatial-hash scan agrees with the legacy full walk (both now skip
  // targets the shooter cannot damage — v0.9.1 hostile-audit fix)
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 12);
    const refScan = (u, def, owner) => { // post-fix semantics, verbatim
      const baseSight = def.sightWu + owner.sightBonus * 64;
      let best = null, bestD = Infinity;
      const consider = (ent, armor) => {
        if (!(ent && ent.hp > 0 && isHostile(st, u.owner, ent))) return;
        if (def.dmg[dmgColumn(armor)] <= 0) return; // v0.9.1: viability skip
        const p = entityPos(st, ent);
        let limit = baseSight;
        if (armor === 'Air') limit = Math.round(limit * owner.aggroAirMult);
        const d = dist2(u.x, u.y, p.x, p.y);
        if (d <= limit * limit && d < bestD) { bestD = d; best = ent; }
      };
      for (const id of sortedIds(st.units)) {
        const e = st.units[id];
        consider(e, st.unitDefs[e.defId].armor);
      }
      for (const id of sortedIds(st.structures)) consider(st.structures[id], 'Building');
      return best;
    };
    const algeriaUnits = data.units.filter((u) => u.faction === 'Algeria');
    for (let i = 0; i < 24; i++) {
      const d = algeriaUnits[i % algeriaUnits.length];
      addUnit(st, d.id, 1, (6 + (i * 7) % (st.map.w - 12)) * 64,
        (6 + (i * 11) % (st.map.h - 12)) * 64);
    }
    addStructure(st, 'SH-09', 1, 40, 20);
    const egyptUnits = data.units.filter((u) => u.faction === 'Egypt'
      && (u.dmg.inf + u.dmg.light + u.dmg.armor + u.dmg.air + u.dmg.bldg) > 0 && u.range > 0);
    const scanners = [];
    for (let i = 0; i < 6 && i < egyptUnits.length; i++) {
      const d = egyptUnits[(i * 3) % egyptUnits.length];
      scanners.push(addUnit(st, d.id, 0, (10 + i * 9) * 64, (12 + i * 7) * 64));
    }
    let mismatch = null;
    for (const s of scanners) {
      const def = st.unitDefs[s.defId];
      const owner = st.players[s.owner];
      const got = scanForEnemy(st, s, def, owner);
      const want = refScan(s, def, owner);
      if ((got ? got.id : 0) !== (want ? want.id : 0)) {
        mismatch = { scanner: s.defId, got: got ? got.id : null, want: want ? want.id : null };
        break;
      }
    }
    // at least one scanner must actually acquire something (non-trivial test)
    const anyAcquired = scanners.some((s) =>
      !!scanForEnemy(st, s, st.unitDefs[s.defId], st.players[s.owner]));
    out.push({ name: 'T7 spatial scan == full scan',
      pass: !mismatch && anyAcquired,
      detail: JSON.stringify({ mismatch, anyAcquired }) });
  }

  // T8: boxed-in depot — harvester idles with a retry cooldown (no thrash);
  // nearDepotCell finds a parking cell near an open depot
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 13);
    deploy(st, 0);
    const f = st.oilFields[1];
    const ox = cellOf(f.x), oy = cellOf(f.y);
    const dSpot = openSpot(st, 3, ox + 4, oy);
    const depot = addStructure(st, 'SH-03', 0, dSpot.x, dSpot.y);
    const hv = addUnit(st, 'HARV', 0, f.x, f.y);
    depot.harvesterId = hv.id;
    const dc = structCenter(depot);
    // entomb the depot: rock every cell within 13 of its center
    for (let dy = -13; dy <= 13; dy++) {
      for (let dx = -13; dx <= 13; dx++) {
        const qx = cellOf(dc.x) + dx, qy = cellOf(dc.y) + dy;
        if (qx >= 0 && qy >= 0 && qx < st.map.w && qy < st.map.h) {
          st.map.terrain[qy * st.map.w + qx] = 1;
        }
      }
    }
    let stayedIdle = true;
    for (let i = 0; i < 80; i++) {
      tick(st);
      if (st.units[hv.id].order.type !== 'idle') stayedIdle = false;
    }
    const cdSet = st.units[hv.id].harvCd > 0;
    // positive control: nearDepotCell parks next to an unboxed depot
    const st2 = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 13);
    const f2 = st2.oilFields[1];
    const d2 = openSpot(st2, 3, cellOf(f2.x) + 4, cellOf(f2.y));
    const depot2 = addStructure(st2, 'SH-03', 0, d2.x, d2.y);
    const dc2 = structCenter(depot2);
    const fb = nearDepotCell(st2, st2.unitDefs.HARV, dc2);
    const fbOk = !!fb && dist2(fb.x, fb.y, dc2.x, dc2.y) <= (3 * 64) * (3 * 64);
    out.push({ name: 'T8 harv boxed depot: idle + cooldown, fallback cell exists',
      pass: stayedIdle && cdSet && fbOk,
      detail: JSON.stringify({ stayedIdle, cdSet, fb }) });
  }
  // T9: oil-field no-build zone (v0.9.0): any footprint cell within
  // Chebyshev 1 of a field center is rejected with reason 'oil-field';
  // spots farther out stay legal (depots still placeable near their field)
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 14);
    deploy(st, 0);
    const f = st.oilFields[1];
    const ox = cellOf(f.x), oy = cellOf(f.y);
    addStructure(st, 'SH-02', 0, ox + 8, oy); // anchor so proximity passes
    const def = st.structDefs['SH-02'];
    // fp-3 footprint placed so its cells cover the field center cell
    const onField = canPlaceReason(st, 0, def, ox - 1, oy - 1);
    const canPlaceBool = canPlace(st, 0, def, ox - 1, oy - 1);
    // command path surfaces the reason
    st.players[0].ready = ['SH-02'];
    const v = validateCommand(st, { player: 0, type: 'placeStructure',
      structId: 'SH-02', cx: ox - 1, cy: oy - 1 });
    // a legal spot still exists within 6 cells of the field (outside zone 1)
    let legal = null;
    for (let r = 0; r <= 6 && !legal; r++) {
      for (let dy = -r; dy <= r && !legal; dy++) {
        for (let dx = -r; dx <= r && !legal; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (canPlace(st, 0, def, ox + dx, oy + dy)) legal = { x: ox + dx, y: oy + dy };
        }
      }
    }
    // and the depot (SH-03) can still sit next to its field (2+ cells out)
    let depotOk = false;
    for (let dy = -5; dy <= 5 && !depotOk; dy++) {
      for (let dx = -5; dx <= 5 && !depotOk; dx++) {
        if (canPlace(st, 0, st.structDefs['SH-03'], ox + dx, oy + dy)) depotOk = true;
      }
    }
    out.push({ name: 'T9 oil-field build block (reason oil-field)',
      pass: onField === 'oil-field' && !canPlaceBool && !v.ok && v.reason === 'oil-field'
        && !!legal && depotOk,
      detail: JSON.stringify({ onField, canPlace: canPlaceBool, reason: v.reason,
        legal, depotOk }) });
  }

  // T10: separation (v0.9.0 tuning) — a same-cell crowd of 8 infantry still
  // escapes within 300 ticks, and an idle unit in a producer's rally doorway
  // gets ejected past the 2-cell zone
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 15);
    const ids = [];
    for (let i = 0; i < 8; i++) {
      ids.push(addUnit(st, cheapestInf('Egypt'), 0, 60 * 64 + 32, 60 * 64 + 32).id);
    }
    let escapeTick = -1;
    for (let t = 0; t < 300 && escapeTick < 0; t++) {
      tick(st);
      let minD2 = Infinity;
      for (let i = 0; i < ids.length; i++) {
        const a = st.units[ids[i]];
        if (!a) continue;
        for (let j = i + 1; j < ids.length; j++) {
          const b = st.units[ids[j]];
          if (!b) continue;
          const d = dist2(a.x, a.y, b.x, b.y);
          if (d < minD2) minD2 = d;
        }
      }
      if (minD2 >= 16 * 16) escapeTick = st.tick;
    }
    // doorway: idle rifleman parked on a barracks rally cell
    const st2 = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 16);
    deploy(st2, 0);
    const cy2 = standingStructs(st2, 0, (s) => s.defId === 'SH-01')[0];
    const cc2 = structCenter(cy2);
    const spot = openSpot(st2, 3, cellOf(cc2.x) + 6, cellOf(cc2.y));
    const rax = addStructure(st2, 'SH-04', 0, spot.x, spot.y);
    const rally = defaultRallyCell(st2, rax);
    const door = addUnit(st2, cheapestInf('Egypt'), 0, rally.x, rally.y);
    let ejectD2 = -1;
    for (let t = 0; t < 120; t++) tick(st2);
    ejectD2 = dist2(door.x, door.y, rally.x, rally.y);
    const ejected = ejectD2 > (2 * 64 - 10) * (2 * 64 - 10);
    out.push({ name: 'T10 crowd escapes + doorway ejection',
      pass: escapeTick >= 0 && escapeTick <= 300 && ejected,
      detail: JSON.stringify({ escapeTick, ejectD2,
        ejected }) });
  }

  // T11: AI stall fix (v0.9.1 hostile audit P1) — an unplaceable ready
  // structure must not kill the brain: think() falls through and keeps
  // issuing build/train commands, and EVERY ready id is tried, not just
  // ready[0]. Duel has no water, so a ready Naval Yard is never placeable.
  {
    const cfgs = [
      { slot: 0, faction: 'Egypt', ai: { personality: 'front', difficulty: 'recruit' } },
      { slot: 1, faction: 'Algeria' },
    ];
    const mkAi = () => {
      const st = createMatch({
        data, map: JSON.parse(JSON.stringify(duel)), players: cfgs, seed: 17 });
      const ai = createAI(cfgs, 17);
      const mcv = Object.values(st.units).find((u) => u.owner === 0 && u.defId === 'MCV');
      applyCommand(st, { player: 0, type: 'deployMCV', unitId: mcv.id });
      st.players[0].credits = 100000;
      return { st, ai };
    };
    // A: ready=['SH-07'] (never placeable) — the brain still orders SH-02
    //    instead of returning forever; the ready entry is never dropped and
    //    no impossible placement command is issued.
    let sawBuild = false, badPlace = false, readyKept = false;
    {
      const { st, ai } = mkAi();
      st.players[0].ready = ['SH-07'];
      for (let t = 0; t < 20; t++) {
        const cmds = aiCommands(st, ai);
        for (const c of cmds) {
          if (c.type === 'buildStructure') sawBuild = true;
          if (c.type === 'placeStructure' && c.structId === 'SH-07') badPlace = true;
        }
        tick(st, cmds);
      }
      readyKept = st.players[0].ready.indexOf('SH-07') >= 0;
    }
    // B: ready=['SH-07','SH-04'] — SH-04 is placed even though SH-07 (first)
    //    has no legal spot.
    let placedSecond = false;
    {
      const { st, ai } = mkAi();
      st.players[0].ready = ['SH-07', 'SH-04'];
      for (let t = 0; t < 20 && !placedSecond; t++) {
        const cmds = aiCommands(st, ai);
        for (const c of cmds) {
          if (c.type === 'placeStructure' && c.structId === 'SH-04') placedSecond = true;
        }
        tick(st, cmds);
      }
    }
    out.push({ name: 'T11 AI unplaceable ready: brain keeps thinking, tries all ready ids',
      pass: sawBuild && !badPlace && readyKept && placedSecond,
      detail: JSON.stringify({ sawBuild, badPlace, readyKept, placedSecond }) });
  }

  // T12: checksum completion (v0.9.1 format bump, hostile audit P2).
  //  A) self-identity: a busy scripted run twice -> identical checksum stream
  //  B) hole closure: state pairs identical except ONE newly-covered field
  //     must checksum differently; an upgrade field-order swap must not.
  {
    const players = [{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }];
    const placeReady = (st, id, cx0, cy0) => {
      if (!st.players[0].ready.includes(id)) return false;
      for (let r = 0; r <= 30; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const cmd = { player: 0, type: 'placeStructure',
              structId: id, cx: cx0 + dx, cy: cy0 + dy };
            if (validateCommand(st, cmd).ok) { applyCommand(st, cmd); return true; }
          }
        }
      }
      return false;
    };
    const runOnce = () => {
      const st = createMatch({ data, map: JSON.parse(JSON.stringify(duel)),
        players, seed: 44 });
      deploy(st, 0);
      st.players[0].credits = 50000;
      const sums = [];
      // depot via the real build+place path (buildQueue/ready/harvesterId/oilAcc)
      applyCommand(st, { player: 0, type: 'buildStructure', structId: 'SH-03' });
      let guard = 0;
      while (!st.players[0].ready.includes('SH-03') && guard++ < 6000) tick(st);
      const dsp = findDepotPlacement(st, 0, st.structDefs['SH-03']);
      if (dsp) applyCommand(st, { player: 0, type: 'placeStructure',
        structId: 'SH-03', cx: dsp.x, cy: dsp.y });
      // barracks via the real path + training queue + rally point
      applyCommand(st, { player: 0, type: 'buildStructure', structId: 'SH-04' });
      guard = 0;
      while (!st.players[0].ready.includes('SH-04') && guard++ < 6000) tick(st);
      placeReady(st, 'SH-04', 30, 30);
      const rax = standingStructs(st, 0, (s) => s.defId === 'SH-04')[0];
      applyCommand(st, { player: 0, type: 'trainUnit', unitId: cheapestInf('Egypt') });
      if (rax) applyCommand(st, { player: 0, type: 'setRally',
        structId: rax.id, x: 40 * 64, y: 40 * 64 });
      // power drain (lowPower in the stream) + airfield + SW charge path
      addStructure(st, 'SH-05', 0, 66, 60);
      addStructure(st, 'SH-06', 0, 66, 66);
      applyCommand(st, { player: 0, type: 'buildStructure', structId: 'SH-13' });
      guard = 0;
      while (!st.players[0].ready.includes('SH-13') && guard++ < 6000) tick(st);
      placeReady(st, 'SH-13', 40, 60);
      // transport cargo via the real load path
      const apc = addUnit(st, 'EG-12', 0, 45 * 64 + 32, 45 * 64 + 32);
      const sq = addUnit(st, cheapestInf('Egypt'), 0, 46 * 64 + 32, 46 * 64 + 32);
      applyCommand(st, { player: 0, type: 'load', carrierId: apc.id, unitIds: [sq.id] });
      // rearm order + resume snapshot: a fighter burns its ammo on a tough dummy
      const jet = addUnit(st, 'EG-10', 0, 50 * 64 + 32, 45 * 64 + 32);
      const dummy = addUnit(st, 'DZ-07', 1, 53 * 64 + 32, 45 * 64 + 32);
      dummy.hp = 100000; dummy.maxHp = 100000;
      applyCommand(st, { player: 0, type: 'attackTarget',
        unitIds: [jet.id], targetId: dummy.id });
      // one superweapon volley (projectile kind/dmg/radiusWu in the stream)
      st.players[0].swChargeTicks = 0;
      applyCommand(st, { player: 0, type: 'useSuperweapon', x: 70 * 64, y: 70 * 64 });
      for (let t = 0; t < 900; t++) {
        tick(st);
        if ((t + 1) % 25 === 0) sums.push(checksum(st));
      }
      return sums.join('/');
    };
    const identity = runOnce() === runOnce();

    // hole-closure pairs: same fixture, same seed -> identical ids and state;
    // the single field difference must move the checksum (pre-v0.9.1 the
    // open holes below compared EQUAL).
    const buildPair = () => {
      const a = createMatch({ data, map: JSON.parse(JSON.stringify(duel)),
        players, seed: 55 });
      const b = createMatch({ data, map: JSON.parse(JSON.stringify(duel)),
        players, seed: 55 });
      for (const st of [a, b]) {
        deploy(st, 0);
        addStructure(st, 'SH-04', 0, 60, 60);
        addUnit(st, 'EG-10', 0, 40 * 64 + 32, 50 * 64 + 32);
        addUnit(st, 'EG-12', 0, 41 * 64 + 32, 50 * 64 + 32);
        addStructure(st, 'SH-03', 0, 30, 30);
      }
      return [a, b];
    };
    const jetOf = (st) => Object.values(st.units).find((u) => u.defId === 'EG-10');
    const apcOf = (st) => Object.values(st.units).find((u) => u.defId === 'EG-12');
    const raxOf = (st) => Object.values(st.structures).find((s) => s.defId === 'SH-04');
    const depOf = (st) => Object.values(st.structures).find((s) => s.defId === 'SH-03');
    const openHoles = [];
    const pair = (label, mutate) => {
      const pr = buildPair();
      mutate(pr[0], pr[1]);
      if (checksum(pr[0]) === checksum(pr[1])) openHoles.push(label);
    };
    pair('rally', (a) => { a.rally[raxOf(a).id] = { x: 100, y: 100 }; });
    pair('order type/x/y', (a) => {
      jetOf(a).order = { type: 'move', x: 500, y: 500, targetId: 0, enemyId: 0 };
    });
    pair('rearm resume snapshot', (a) => {
      jetOf(a).order = { type: 'rearm', x: 1, y: 2, targetId: raxOf(a).id,
        enemyId: 0, resume: { type: 'attackMove', x: 11, y: 22,
          targetId: 0, enemyId: 0 } };
    });
    pair('trophyTick', (a) => { jetOf(a).trophyTick = 777; });
    pair('structure cooldown', (a) => { raxOf(a).cooldown = 5; });
    pair('structure queue head', (a, b) => {
      raxOf(a).queue.push({ unitId: 'EG-01', progress: 5, total: 100 });
      raxOf(b).queue.push({ unitId: 'EG-01', progress: 6, total: 100 });
    });
    pair('structure harvesterId', (a) => { depOf(a).harvesterId = 7; });
    pair('player swChargeTicks', (a) => { a.players[0].swChargeTicks = 42; });
    pair('player abilityCdUntil', (a) => { a.players[0].abilityCdUntil = 500; });
    pair('player cyRebuilt', (a) => { a.players[0].cyRebuilt = true; });
    pair('player buildQueue', (a, b) => {
      a.players[0].buildQueue.push({ structId: 'SH-02', progress: 7, total: 100 });
      b.players[0].buildQueue.push({ structId: 'SH-02', progress: 8, total: 100 });
    });
    pair('player oilAcc', (a) => { a.players[0].oilAcc = 500; });
    pair('player power/lowPower', (a) => {
      a.players[0].powerOut = 1;
      a.players[0].powerUse = 2;
      a.players[0].lowPower = true;
    });
    pair('projectile kind/dmg/radiusWu', (a, b) => {
      spawnProjectile(a, { owner: 0, kind: 'sw', x: 0, y: 0, tx: 64, ty: 64,
        total: 30, ticksLeft: 30, dmg: 400, radiusWu: 320, interceptable: false });
      spawnProjectile(b, { owner: 0, kind: 'airstrike', x: 0, y: 0, tx: 64, ty: 64,
        total: 30, ticksLeft: 30, dmg: 500, radiusWu: 192, interceptable: false });
    });
    pair('transport cargo contents', (a, b) => {
      apcOf(a).cargo = [{ defId: cheapestInf('Egypt'), hp: 50, maxHp: 100, rank: 0 }];
      apcOf(b).cargo = [{ defId: cheapestInf('Egypt'), hp: 60, maxHp: 100, rank: 0 }];
    });
    // field-order swap: same upgrades assigned in reverse insertion order
    // must checksum identically (upgrades serialize sorted)
    let swapOk = true;
    {
      const pr = buildPair();
      const gids = Object.keys(pr[0].upgradeDefs);
      if (gids.length >= 2) {
        pr[0].players[0].upgrades[gids[0]] = true;
        pr[0].players[0].upgrades[gids[1]] = true;
        pr[1].players[0].upgrades[gids[1]] = true;
        pr[1].players[0].upgrades[gids[0]] = true;
        swapOk = checksum(pr[0]) === checksum(pr[1]);
      }
    }
    out.push({ name: 'T12 checksum v0.9.1: self-identity + holes closed',
      pass: identity && openHoles.length === 0 && swapOk,
      detail: JSON.stringify({ identity, openHoles, swapOk }) });
  }

  // T13: tracers stamp srcUnitId so render.js can drop its O(projectiles x
  // units) shooter scan; the field stays checksum-neutral (projectile record
  // covers owner/tx/ty/ticksLeft/kind/dmg/radiusWu only).
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 61);
    const kor = addUnit(st, 'EG-02', 0, 30 * 64 + 32, 60 * 64 + 32);
    const t90 = addUnit(st, 'DZ-07', 1, 30 * 64 + 32 + 4 * 64, 60 * 64 + 32);
    t90.hp = 100000; t90.maxHp = 100000;
    applyCommand(st, { player: 0, type: 'attackTarget',
      unitIds: [kor.id], targetId: t90.id });
    let stamped = null, neutral = null;
    for (let t = 0; t < 60 && neutral === null; t++) {
      tick(st);
      for (const id of sortedIds(st.projectiles)) {
        const pr = st.projectiles[id];
        if (pr.kind === 'tracer' && !stamped) {
          stamped = { src: pr.srcUnitId, owner: pr.owner };
          const before = checksum(st);
          pr.srcUnitId = 999; // tamper: the checksum must not move
          pr.cls = 'tampered';
          neutral = checksum(st) === before;
        }
      }
    }
    out.push({ name: 'T13 tracer carries srcUnitId (checksum-neutral)',
      pass: !!stamped && stamped.src === kor.id && stamped.owner === 0
        && neutral === true,
      detail: JSON.stringify({ stamped, neutral }) });
  }

  // T14: shahed_rain clamps spawn points into the map rect — at the west edge
  // x-(10+i)*CELL underflowed and drones spawned off-map: frozen, invisible,
  // unkillable forever.
  {
    const st = mk([{ faction: 'Iran', slot: 0 }, { faction: 'Algeria', slot: 1 }], 71);
    addStructure(st, 'SH-33', 0, 20, 20);
    const x = 6 * 64, y = 70 * 64;
    applyCommand(st, { player: 0, type: 'useFactionAbility', x, y });
    const maxX = st.map.w * 64 - 1, maxY = st.map.h * 64 - 1;
    const inRect = (u) => u.x >= 0 && u.y >= 0 && u.x <= maxX && u.y <= maxY;
    const spawnPos = Object.values(st.units).filter((u) => u.defId === 'IR-15')
      .map((u) => ({ id: u.id, x: u.x, y: u.y }));
    const inBounds = spawnPos.length === 5 && spawnPos.every(inRect);
    for (let t = 0; t < 200; t++) tick(st);
    const moved = spawnPos.every((p) => {
      const u = st.units[p.id];
      return !u || u.x !== p.x || u.y !== p.y; // detonated (gone) or flown
    });
    const stillIn = Object.values(st.units).filter((u) => u.defId === 'IR-15')
      .every(inRect);
    out.push({ name: 'T14 shahed_rain clamps spawns into the map (west edge)',
      pass: inBounds && moved && stillIn,
      detail: JSON.stringify({ inBounds, moved, stillIn, spawnPos }) });
  }

  // T15: hold fire (stance 3) suppresses auto-acquire ONLY — an explicit
  // attackTarget order still fires (pre-fix the unit walked in and died
  // without shooting).
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 81);
    const a = addUnit(st, cheapestInf('Egypt'), 0, 30 * 64 + 32, 60 * 64 + 32);
    const b = addUnit(st, cheapestInf('Algeria'), 1, 32 * 64 + 32, 60 * 64 + 32);
    a.hp = 5000; a.maxHp = 5000;
    b.hp = 5000; b.maxHp = 5000;
    applyCommand(st, { player: 0, type: 'setStance', unitIds: [a.id], stance: 3 });
    const hp0 = b.hp;
    for (let t = 0; t < 60; t++) tick(st);
    const heldFire = b.hp === hp0; // the stance-3 unit never auto-fires
    applyCommand(st, { player: 0, type: 'attackTarget',
      unitIds: [a.id], targetId: b.id });
    let fired = false;
    for (let t = 0; t < 120 && !fired; t++) { tick(st); if (b.hp < hp0) fired = true; }
    out.push({ name: 'T15 stance 3: auto-acquire suppressed, explicit attackTarget fires',
      pass: heldFire && fired,
      detail: JSON.stringify({ heldFire, fired }) });
  }

  // T16: acquisition skips targets the shooter cannot damage — an armor-only
  // submarine must ignore immune infantry and pick a valid armored target
  // (pre-fix it cycled blank volleys: cooldown burned every cycle, no damage).
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 82);
    const sub = addUnit(st, 'EG-20', 0, 60 * 64 + 32, 70 * 64 + 32); // torpedoes
    const inf = addUnit(st, cheapestInf('Algeria'), 1, 61 * 64 + 32, 70 * 64 + 32);
    const tank = addUnit(st, 'DZ-07', 1, 64 * 64 + 32, 70 * 64 + 32);
    inf.hp = 5000; inf.maxHp = 5000;
    tank.hp = 5000; tank.maxHp = 5000;
    const infHp0 = inf.hp, tankHp0 = tank.hp;
    let targetedInf = false;
    for (let t = 0; t < 400; t++) {
      tick(st);
      const s = st.units[sub.id];
      if (!s) break;
      if (s.order.enemyId === inf.id) targetedInf = true;
    }
    const infUntouched = !!st.units[inf.id] && st.units[inf.id].hp === infHp0;
    const tankHit = tank.hp < tankHp0;
    out.push({ name: 'T16 sub ignores immune infantry, engages valid target',
      pass: infUntouched && tankHit && !targetedInf,
      detail: JSON.stringify({ infUntouched, tankHit, targetedInf,
        subAlive: !!st.units[sub.id] }) });
  }
  return out;
}
"""


def main() -> int:
    bundle = "\n;\n".join(inline(CLIENT / m) for m in MODULES)
    ctx = MiniRacer()
    for name, rel in (("__data", "data/game.json"), ("__duel", "maps/duel.json")):
        payload = (CLIENT / rel).read_text(encoding="utf-8")
        ctx.eval(f"var {name} = {json.dumps(payload)};")
    ctx.eval(bundle)
    ctx.eval(TEST_JS)
    results = json.loads(ctx.eval(
        "JSON.stringify(runSimFixTests(JSON.parse(__data), JSON.parse(__duel)))"
    ))
    passed = 0
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}")
        passed += 1 if r["pass"] else 0
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
