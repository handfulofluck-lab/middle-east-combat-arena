// Combat: targeting, per-volley damage, projectiles (SW/ability class),
// superweapons, faction abilities, veterancy. All rolls use state.rng.
import {
  CELL, addUnit, entityPos, findEntity, isHostile, sortedIds, dist2,
  structCenter, teamOf, cellOf,
} from './state.js';
import { passGridCached } from './path.js';

// sheet armor class -> dmg column
export function dmgColumn(armor) {
  switch (armor) {
    case 'Soft': return 'inf';
    case 'Light': return 'light';
    case 'Medium': case 'Heavy': case 'Naval': return 'armor';
    case 'Air': return 'air';
    default: return 'bldg'; // structures ('Building')
  }
}

function targetArmor(state, target) {
  if (target.defId && state.unitDefs[target.defId]) return state.unitDefs[target.defId].armor;
  return 'Building';
}

function hasAnyDmg(def) {
  return def.dmg.inf > 0 || def.dmg.light > 0 || def.dmg.armor > 0
    || def.dmg.air > 0 || def.dmg.bldg > 0;
}

function vetDmgMult(state, rank) {
  const k = state.data.knobs;
  let m = 1;
  if (rank >= 1) m *= 1 + k.VetDmgBonus;
  if (rank >= 3) m *= 1 + k.HeroicPerk;
  return m;
}

// Apply `dmg` (already-final integer) to an entity; handles death + kill credit.
export function dealDamage(state, target, dmg, attacker) {
  target.hp -= dmg;
  if (state.structures[target.id] === target) target.lastHitTick = state.tick;
  if (target.hp > 0) return false;
  const isUnit = state.units[target.id] === target;
  if (isUnit) {
    delete state.units[target.id];
    if (attacker && state.units[attacker.id] === attacker) attacker.kills++;
  } else if (state.structures[target.id] === target) {
    delete state.structures[target.id];
    state.structVersion++; // invalidates cached passability grids
    if (attacker && state.units[attacker.id] === attacker) attacker.kills++;
  }
  return true;
}

function idleOrder() {
  return { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
}

// render-only tracer: a no-damage projectile the renderer draws as a line
function spawnTracer(state, ownerSlot, from, to, ticks) {
  spawnProjectile(state, {
    owner: ownerSlot, kind: 'tracer', x: from.x, y: from.y, tx: to.x, ty: to.y,
    total: ticks, ticksLeft: ticks, dmg: 0, radiusWu: 0, interceptable: false,
  });
}

// DronePaint: a friendly UAV within sight of the target paints it -> +DronePaint%
function uavPaints(state, ownerSlot, target) {
  const k = state.data.knobs;
  if (!k.DronePaint) return false;
  const tp = entityPos(state, target);
  for (const id of sortedIds(state.units)) {
    const u = state.units[id];
    if (u.owner !== ownerSlot) continue;
    const def = state.unitDefs[u.defId];
    if (def.cls !== 'UAV') continue;
    const sight = def.sightWu + state.players[ownerSlot].sightBonus * CELL;
    if (dist2(u.x, u.y, tp.x, tp.y) <= sight * sight) return true;
  }
  return false;
}

function aliveHostile(state, slot, ent) {
  return ent && ent.hp > 0 && isHostile(state, slot, ent);
}

function scanForEnemy(state, u, def, owner) {
  const baseSight = def.sightWu + owner.sightBonus * CELL;
  let best = null, bestD = Infinity;
  const consider = (ent, armor) => {
    if (!aliveHostile(state, u.owner, ent)) return;
    const p = entityPos(state, ent);
    let limit = baseSight;
    if (armor === 'Air') limit = Math.round(limit * owner.aggroAirMult); // siha_mesh
    const d = dist2(u.x, u.y, p.x, p.y);
    if (d <= limit * limit && d < bestD) { bestD = d; best = ent; }
  };
  for (const id of sortedIds(state.units)) {
    const e = state.units[id];
    consider(e, state.unitDefs[e.defId].armor);
  }
  for (const id of sortedIds(state.structures)) {
    consider(state.structures[id], 'Building');
  }
  return best;
}

function fireVolley(state, u, def, target) {
  const armor = targetArmor(state, target);
  const base = def.dmg[dmgColumn(armor)];
  u.cooldown = def.cooldownTicks;
  if (base <= 0) return;
  const k = state.data.knobs;
  const owner = state.players[u.owner];
  const isStructTarget = state.structures[target.id] === target;
  const shooterCls = def.cls || def.name || ''; // structures carry stats on name
  const isAtgm = shooterCls.indexOf('AT') >= 0 || def.role === 'AT'
    || (def.name || '').indexOf('ATGM') >= 0;
  // iron_layer: Trophy APS eats the first incoming ATGM volley per TrophyCD
  const tDef = state.unitDefs[target.defId];
  if (tDef && tDef.ability && tDef.ability.indexOf('Trophy') >= 0
      && isAtgm && state.tick >= target.trophyTick) {
    target.trophyTick = state.tick + Math.round(k.TrophyCD * 10);
    return;
  }
  let mult = (state.data.armorIncoming[armor] || 1) * vetDmgMult(state, u.rank || 0);
  if (armor === 'Air') mult *= owner.dmgAirMult; // integrated_sky
  // v0.3 sheet knobs (previously dead)
  if (def.domain === 'Air' && (armor === 'Medium' || armor === 'Heavy')) {
    mult *= k.AirVsArmor;
  }
  if (isAtgm && (armor === 'Medium' || armor === 'Heavy')) mult *= k.ATGMVsArmor;
  if ((shooterCls === 'SPG' || shooterCls === 'MLRS') && isStructTarget) {
    mult *= k.ArtyVsBuilding;
  }
  if (uavPaints(state, u.owner, target)) mult *= 1 + k.DronePaint / 100;
  const dmg = Math.max(1, Math.round(base * mult));
  spawnTracer(state, u.owner, entityPos(state, u), entityPos(state, target), 2);
  dealDamage(state, target, dmg, u);
}

// kamikaze drones (rof_s 0, air, armed, e.g. Shahed-136): detonate on contact
function maybeDetonate(state, u, def) {
  let boom = false;
  if (u.order.type === 'attackMove' || u.order.type === 'move') {
    const d = dist2(u.x, u.y, u.order.x, u.order.y);
    if (d <= CELL * CELL) boom = true;
  } else if (u.order.type === 'attackTarget') {
    // v0.3.2 fix: manual attack orders were ignored, so targeted drones
    // never detonated. MovementSystem now closes to CELL/2 (see engine.js),
    // so the CELL*CELL splash check below correctly applies damage.
    const t = findEntity(state, u.order.targetId);
    if (t && isHostile(state, u.owner, t)) {
      const tp = entityPos(state, t);
      if (dist2(u.x, u.y, tp.x, tp.y) <= CELL * CELL) boom = true;
    }
  }
  if (!boom) {
    for (const id of sortedIds(state.units)) {
      const e = state.units[id];
      if (!aliveHostile(state, u.owner, e)) continue;
      if (dist2(u.x, u.y, e.x, e.y) <= def.rangeWu * def.rangeWu) { boom = true; break; }
    }
  }
  if (!boom) return;
  for (const id of sortedIds(state.units)) {
    const e = state.units[id];
    if (!aliveHostile(state, u.owner, e)) continue;
    if (dist2(u.x, u.y, e.x, e.y) > CELL * CELL) continue;
    const base = def.dmg[dmgColumn(state.unitDefs[e.defId].armor)];
    if (base <= 0) continue;
    const dmg = Math.max(1, Math.round(base * (state.data.armorIncoming[state.unitDefs[e.defId].armor] || 1)));
    dealDamage(state, e, dmg, null);
  }
  for (const id of sortedIds(state.structures)) {
    const e = state.structures[id];
    if (!aliveHostile(state, u.owner, e)) continue;
    const p = structCenter(e);
    if (dist2(u.x, u.y, p.x, p.y) > CELL * CELL) continue;
    const dmg = Math.max(1, Math.round(def.dmg.bldg));
    dealDamage(state, e, dmg, null);
  }
  delete state.units[u.id]; // drone spent
}

export function combatSystem(state) {
  for (const id of sortedIds(state.units)) {
    const u = state.units[id];
    if (!u || u.owner < 0) continue;
    const def = state.unitDefs[u.defId];
    if (u.cooldown > 0) u.cooldown--;
    const owner = state.players[u.owner];
    if (!owner || owner.eliminated) continue;

    // engineer capture channel (attackTarget on a hostile/neutral structure)
    if (def.cls === 'Engineer' && u.order.type === 'attackTarget') {
      if (captureTick(state, u, def)) continue;
    }

    if (def.cooldownTicks === 0) {
      if (def.domain === 'Air' && hasAnyDmg(def)) maybeDetonate(state, u, def);
      continue;
    }
    if (!hasAnyDmg(def)) continue;

    const o = u.order;
    let target = null;
    if (o.type === 'attackTarget') {
      target = findEntity(state, o.targetId);
      if (!aliveHostile(state, u.owner, target)) { u.order = idleOrder(); target = null; }
    } else if (o.enemyId) {
      target = findEntity(state, o.enemyId);
      if (!aliveHostile(state, u.owner, target)) { o.enemyId = 0; target = null; }
    }
    if (!target && (o.type === 'idle' || o.type === 'attackMove')
        && (state.tick + u.id) % 5 === 0) {
      target = scanForEnemy(state, u, def, owner);
      if (target) o.enemyId = target.id;
    }
    if (!target) continue;
    const tp = entityPos(state, target);
    if (dist2(u.x, u.y, tp.x, tp.y) <= def.rangeWu * def.rangeWu && u.cooldown <= 0) {
      fireVolley(state, u, def, target);
    }
  }
}

// engineer capture: channel CAPTURE_TICKS uninterrupted ticks in range of a
// hostile/neutral structure, then ownership flips to the engineer's player.
// Progress lives on the engineer (serializable ints) and resets when the
// engineer is out of range (moving), retargets, or the target dies.
// Returns true while the order is a live capture attempt.
export const CAPTURE_TICKS = 20;
function captureTick(state, u, def) {
  const t = state.structures[u.order.targetId];
  if (!t || t.owner === u.owner || teamOf(state, t.owner) === teamOf(state, u.owner)) {
    u.capTicks = 0;
    return false;
  }
  const c = structCenter(t);
  if (dist2(u.x, u.y, c.x, c.y) > def.rangeWu * def.rangeWu) {
    u.capTicks = 0; // out of range (still approaching, or pushed off)
    return true;    // movementSystem walks the engineer into range
  }
  if (u.capTargetId !== t.id) { u.capTicks = 0; u.capTargetId = t.id; }
  u.capTicks++;
  if (u.capTicks >= CAPTURE_TICKS) {
    t.owner = u.owner;
    t.queue = []; // a captured producer forgets its old queue
    t.harvesterId = 0; // v0.3.3: captured depot must re-bind a harvester
    u.capTicks = 0;
    u.capTargetId = 0;
    u.order = idleOrder();
  }
  return true;
}

// ---- structure weapons (Def towers) + engineer repair ----------------------

const STRUCT_SCAN = 6;   // ticks between tower target scans (slower than units)
const REPAIR_PERIOD = 10; // engineer repair tick cadence

// target preference by weapon identity: AA prefers Air (and ignores Soft while
// any Air is in range), ATGM prefers Heavy/Medium, HMG prefers Soft/Light
function towerCategory(def) {
  if (def.dmg.air >= 40) return 'aa';
  if (def.dmg.armor >= 40) return 'at';
  return 'hmg';
}

function pickTowerTarget(state, s, def, c) {
  const cat = towerCategory(def);
  const pref = cat === 'aa' ? ['Air'] : cat === 'at' ? ['Heavy', 'Medium'] : ['Soft', 'Light'];
  const r2 = def.rangeWu * def.rangeWu;
  let best = null, bestD = Infinity, bestPref = null, bestPrefD = Infinity, airInRange = false;
  const consider = (ent, armor, px, py) => {
    if (!aliveHostile(state, s.owner, ent)) return;
    const d = dist2(c.x, c.y, px, py);
    if (d > r2) return;
    if (armor === 'Air') airInRange = true;
    if (d < bestD) { bestD = d; best = ent; }
    if (pref.includes(armor) && d < bestPrefD) { bestPrefD = d; bestPref = ent; }
  };
  for (const id of sortedIds(state.units)) {
    const e = state.units[id];
    consider(e, state.unitDefs[e.defId].armor, e.x, e.y);
  }
  for (const id of sortedIds(state.structures)) {
    const e = state.structures[id];
    const ec = structCenter(e);
    consider(e, 'Building', ec.x, ec.y);
  }
  if (bestPref) return bestPref;
  if (cat === 'aa' && airInRange) return null; // hold fire vs Soft while air is up
  return best;
}

export function structureCombatSystem(state) {
  for (const id of sortedIds(state.structures)) {
    const s = state.structures[id];
    if (s.owner < 0) continue;
    const def = state.structDefs[s.defId];
    if (!def.dmg || !def.cooldownTicks) continue; // Eco/Prod/Core/SW stay inert
    if (s.cooldown > 0) s.cooldown--;
    if (s.cooldown > 0 || (state.tick + s.id) % STRUCT_SCAN !== 0) continue;
    const c = structCenter(s);
    const target = pickTowerTarget(state, s, def, c);
    if (target) fireVolley(state, s, def, target); // no veterancy (rank undefined)
  }
}

// engineers repair allied damaged units/structures while idle / attack-moving
export function repairSystem(state) {
  for (const id of sortedIds(state.units)) {
    const u = state.units[id];
    if (u.owner < 0 || (state.tick + u.id) % REPAIR_PERIOD !== 0) continue;
    const def = state.unitDefs[u.defId];
    if (def.cls !== 'Engineer') continue;
    if (u.order.type !== 'idle' && u.order.type !== 'attackMove') continue;
    const r2 = def.rangeWu * def.rangeWu;
    let best = null, bestD = Infinity;
    const consider = (ent, px, py) => {
      if (ent.owner !== u.owner || ent.hp >= ent.maxHp || ent.id === u.id) return;
      const d = dist2(u.x, u.y, px, py);
      if (d <= r2 && d < bestD) { bestD = d; best = ent; }
    };
    for (const sid of sortedIds(state.structures)) {
      const e = state.structures[sid];
      const c = structCenter(e);
      consider(e, c.x, c.y);
    }
    for (const uid of sortedIds(state.units)) {
      const e = state.units[uid];
      consider(e, e.x, e.y);
    }
    if (!best) continue;
    best.hp = Math.min(best.maxHp, best.hp + Math.max(1, Math.round(best.maxHp * 0.01)));
    best.lastRepairTick = state.tick;
  }
}

// ---- projectiles (superweapon / ability class only; unit fire is hitscan) --

export function spawnProjectile(state, opts) {
  const id = state.nextId++;
  state.projectiles[id] = Object.assign({ id, sx: opts.x, sy: opts.y }, opts);
  return state.projectiles[id];
}

function findInterceptor(state, ownerSlot, x, y) {
  // first alive enemy player (slot order) whose faction has an intercept knob
  // and a standing Def structure within 12 cells of the impact point
  for (const q of state.players) {
    if (q.eliminated || q.team === state.players[ownerSlot].team) continue;
    const knobName = state.data.factions[q.faction].superweaponIntercept;
    if (!knobName) continue;
    const r = 12 * CELL;
    const hasSam = Object.values(state.structures).some((s) => {
      if (s.owner !== q.slot || state.structDefs[s.defId].type !== 'Def') return false;
      const c = structCenter(s);
      return dist2(c.x, c.y, x, y) <= r * r;
    });
    if (hasSam) return { knobName, chance: state.data.knobs[knobName] };
  }
  return null;
}

function resolveProjectile(state, pr) {
  if (pr.interceptable) {
    const ic = findInterceptor(state, pr.owner, pr.tx, pr.ty);
    if (ic) {
      state.stats.interceptRolls++;
      if (state.rng.chance(ic.chance)) {
        state.stats.intercepted++;
        return; // negated
      }
    }
  }
  const r2 = pr.radiusWu * pr.radiusWu;
  for (const id of sortedIds(state.units)) {
    const e = state.units[id];
    if (!aliveHostile(state, pr.owner, e)) continue;
    if (dist2(e.x, e.y, pr.tx, pr.ty) > r2) continue;
    const armor = state.unitDefs[e.defId].armor;
    const dmg = Math.max(1, Math.round(pr.dmg * (state.data.armorIncoming[armor] || 1)));
    dealDamage(state, e, dmg, null);
  }
  for (const id of sortedIds(state.structures)) {
    const e = state.structures[id];
    if (!aliveHostile(state, pr.owner, e)) continue;
    const c = structCenter(e);
    if (dist2(c.x, c.y, pr.tx, pr.ty) > r2) continue;
    dealDamage(state, e, Math.round(pr.dmg), null);
  }
}

export function projectileSystem(state) {
  for (const id of sortedIds(state.projectiles)) {
    const pr = state.projectiles[id];
    pr.ticksLeft--;
    const done = pr.total - pr.ticksLeft;
    pr.x = Math.round(pr.sx + (pr.tx - pr.sx) * done / pr.total);
    pr.y = Math.round(pr.sy + (pr.ty - pr.sy) * done / pr.total);
    if (pr.ticksLeft <= 0) {
      if (pr.kind !== 'tracer' && pr.kind !== 'telegraph') resolveProjectile(state, pr);
      delete state.projectiles[id];
    }
  }
}

// ---- superweapons + faction abilities --------------------------------------

export function fireSuperweapon(state, p, x, y) {
  const src = Object.values(state.structures)
    .filter((s) => s.owner === p.slot && state.structDefs[s.defId].type === 'SW')[0];
  const from = src ? structCenter(src) : { x, y };
  // payload per SW structure: swarm of small warheads, few heavy, or default
  let count = 6, dmg = 400, radiusWu = 5 * CELL;
  if (src && (src.defId === 'SH-19' || src.defId === 'SH-35')) {
    count = 10; dmg = 250; radiusWu = 3 * CELL;
  } else if (src && (src.defId === 'SH-15' || src.defId === 'SH-17')) {
    count = 3; dmg = 700; radiusWu = 3 * CELL;
  }
  for (let i = 0; i < count; i++) {
    spawnProjectile(state, {
      owner: p.slot, kind: 'sw', x: from.x, y: from.y, tx: x, ty: y,
      total: 30, ticksLeft: 30, dmg, radiusWu, interceptable: true,
    });
  }
}

export function useFactionAbility(state, p, x, y) {
  const ability = state.data.factions[p.faction].ability;
  switch (ability) {
    case 'saka_insertion': {
      const squad = state.data.units
        .filter((d) => d.faction === p.faction && d.cls === 'Infantry')
        .sort((a, b) => a.cost - b.cost)[0];
      if (!squad) return;
      // v0.3.3: heli-drop is open-ground only. Nudge the target to the
      // nearest passable land cell within 6 cells; cancel if there is none.
      const g = passGridCached(state, 'Land');
      const openCell = (qx, qy) =>
        qx >= 0 && qy >= 0 && qx < state.map.w && qy < state.map.h
        && g[qy * state.map.w + qx] === 1;
      let cx = cellOf(x), cy = cellOf(y);
      if (!openCell(cx, cy)) {
        let found = null;
        for (let r = 1; r <= 6 && !found; r++) {
          for (let dy = -r; dy <= r && !found; dy++) {
            for (let dx = -r; dx <= r && !found; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              if (openCell(cx + dx, cy + dy)) found = { cx: cx + dx, cy: cy + dy };
            }
          }
        }
        if (!found) return; // nowhere legal in range — drop silently cancelled
        cx = found.cx; cy = found.cy;
        x = cx * CELL + CELL / 2;
        y = cy * CELL + CELL / 2;
      }
      const offs = [[0, 0], [1, 0], [0, 1], [1, 1]];
      for (const [dx, dy] of offs) {
        if (!openCell(cx + dx, cy + dy)) continue; // keep the 2x2 on land
        addUnit(state, squad.id, p.slot, x + dx * CELL, y + dy * CELL);
      }
      break;
    }
    case 'rsaf_tasking': {
      spawnProjectile(state, {
        owner: p.slot, kind: 'airstrike', x, y, tx: x, ty: y,
        total: 15, ticksLeft: 15, dmg: 500, radiusWu: 3 * CELL, interceptable: false,
      });
      break;
    }
    case 'brahmos_lane': {
      // 600 dmg along a 12-cell corridor starting at the target, extending
      // away from the owner's ConYard
      const cy = Object.values(state.structures)
        .filter((s) => s.owner === p.slot && s.defId === 'SH-01')[0];
      const from = cy ? structCenter(cy) : { x: 0, y: 0 };
      const dx = x - from.x, dy = y - from.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const stepX = Math.round(CELL * dx / len), stepY = Math.round(CELL * dy / len);
      // telegraph: gold lane marker for a second before the damage lands
      spawnProjectile(state, {
        owner: p.slot, kind: 'telegraph', x, y,
        tx: x + stepX * 11, ty: y + stepY * 11,
        total: 10, ticksLeft: 10, dmg: 0, radiusWu: 0, interceptable: false,
      });
      const hit = new Set();
      for (let i = 0; i < 12; i++) {
        const px = x + stepX * i, py = y + stepY * i;
        for (const id of sortedIds(state.units)) {
          const e = state.units[id];
          if (hit.has(id) || !aliveHostile(state, p.slot, e)) continue;
          if (dist2(e.x, e.y, px, py) > CELL * CELL) continue;
          hit.add(id);
          const armor = state.unitDefs[e.defId].armor;
          dealDamage(state, e, Math.round(600 * (state.data.armorIncoming[armor] || 1)), null);
        }
        for (const id of sortedIds(state.structures)) {
          const e = state.structures[id];
          if (hit.has(id) || !aliveHostile(state, p.slot, e)) continue;
          const c = structCenter(e);
          if (dist2(c.x, c.y, px, py) > CELL * CELL) continue;
          hit.add(id);
          dealDamage(state, e, 600, null);
        }
      }
      break;
    }
    case 'babur_window': {
      for (let i = 0; i < 2; i++) {
        spawnProjectile(state, {
          owner: p.slot, kind: 'cruise', x: x - 20 * CELL, y: y - 20 * CELL,
          tx: x, ty: y, total: 25, ticksLeft: 25, dmg: 350, radiusWu: 2 * CELL,
          interceptable: true,
        });
      }
      break;
    }
    case 'shahed_rain': {
      const hp = Math.round(state.data.knobs.SwarmHP);
      for (let i = 0; i < 5; i++) {
        const u = addUnit(state, 'IR-15', p.slot, x - (10 + i) * CELL, y - 10 * CELL);
        u.hp = hp; u.maxHp = hp;
        u.order = { type: 'attackMove', x, y, targetId: 0, enemyId: 0 };
      }
      break;
    }
    default:
      break; // passives handled elsewhere
  }
}

// ---- veterancy --------------------------------------------------------------

export function veterancySystem(state) {
  const k = state.data.knobs;
  for (const id of sortedIds(state.units)) {
    const u = state.units[id];
    const rank = u.kills >= 12 ? 3 : u.kills >= 7 ? 2 : u.kills >= 3 ? 1 : 0;
    if (rank <= u.rank) continue;
    if (rank >= 2) {
      const def = state.unitDefs[u.defId];
      const hpMult = (1 + k.EliteHPBonus) * (rank >= 3 ? 1 + k.HeroicPerk : 1);
      const newMax = Math.round(def.hp * hpMult);
      u.hp += newMax - u.maxHp; // heal the difference
      u.maxHp = newMax;
    }
    u.rank = rank;
  }
}
