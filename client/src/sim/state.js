// GameState factory + shared helpers. Sim state is plain data only:
// integers, strings, plain objects/arrays and Uint8Array fog grids.
// No floats, no Math.random, no Date anywhere in state.
import { createRng } from './rng.js';

export const CELL = 64; // world units per map cell

// Synthetic unit defs (not present in game.json): the MCV every player starts
// with, and the harvester auto-spawned per oil depot.
function synthDefs(knobs) {
  return {
    MCV: {
      id: 'MCV', faction: 'All', name: 'MCV', cls: 'MCV', role: 'Core',
      domain: 'Land', cost: 0, build_s: 0, hp: 1000, armor: 'Heavy',
      speed: 30, sight: 6, dmg: { inf: 0, light: 0, armor: 0, air: 0, bldg: 0 },
      range: 0, rof_s: 0, ability: null,
    },
    HARV: {
      id: 'HARV', faction: 'All', name: 'Harvester', cls: 'Harvester',
      role: 'Eco', domain: 'Land', cost: 0, build_s: 0,
      hp: Math.round(knobs.HarvesterHP), armor: 'Light',
      speed: 40, sight: 5, dmg: { inf: 0, light: 0, armor: 0, air: 0, bldg: 0 },
      range: 0, rof_s: 0, ability: null,
    },
  };
}

// Precompute integer sim fields on a unit def (never mutates sheet data).
function prepUnitDef(def) {
  const air = def.domain === 'Air';
  const speedMult = air ? 2.5 : 1;
  return Object.assign({}, def, {
    step: Math.round(def.speed * 1.2 * speedMult / 10), // world units per tick
    rangeWu: Math.round(def.range * CELL),
    sightWu: Math.round(def.sight * CELL),
    sightCells: Math.round(def.sight),
    cooldownTicks: Math.round(def.rof_s * 10),
    buildTicks: Math.round(def.build_s * 10),
  });
}

export function structFootprint(def) {
  if (def.type === 'SW') return 4;
  if (def.type === 'Def') return 2;
  return 3;
}

export function isInfantryCls(cls) {
  return cls === 'Infantry' || cls === 'AT infantry' || cls === 'AA infantry'
    || cls === 'SF' || cls === 'Engineer';
}

// v0.3.6: per-difficulty eco cheat (was marshal-only 1.1). Think interval and
// wave period live in ai.js; all three together define Easy..Expert.
const AI_ECO_MULT = { recruit: 1, veteran: 1, elite: 1.1, marshal: 1.2 };

export function createMatch({ data, map, players, seed }) {
  const unitDefs = {};
  for (const u of data.units) unitDefs[u.id] = prepUnitDef(u);
  for (const d of Object.values(synthDefs(data.knobs))) unitDefs[d.id] = prepUnitDef(d);

  const structDefs = {};
  for (const s of data.structures) structDefs[s.id] = Object.assign({}, s, {
    fp: structFootprint(s),
    buildTicks: Math.round(s.build_s * 10),
    // combat stats exist only on Def structures (sheet v0.3); absent = inert
    rangeWu: Math.round((s.range || 0) * CELL),
    cooldownTicks: Math.round((s.rof_s || 0) * 10),
  });

  // research upgrade kits by id (Grok review slice 3, v0.3.7)
  const upgradeDefs = {};
  for (const g of (data.upgrades || [])) upgradeDefs[g.id] = g;

  const state = {
    tick: 0,
    seed: seed >>> 0,
    rng: createRng(seed),
    data,
    map,
    unitDefs,
    structDefs,
    nextId: 1,
    units: {},       // id -> unit
    structures: {},  // id -> structure
    projectiles: {}, // id -> projectile (SW / ability class only)
    oilFields: {},   // id -> {id, x, y} in world units
    upgradeDefs,     // upgrade id -> kit def (researchUpgrade command)
    players: [],
    queue: [],       // {due, cmd} command queue (CMD_DELAY applied by engine)
    rally: {},       // structure id -> {x, y} world units (setRally command)
    structVersion: 0, // bumped on structure add/remove (passGrid cache key)
    over: false,
    winner: -1,
    stats: { interceptRolls: 0, intercepted: 0 },
  };

  let oid = 1;
  for (const o of map.oil) {
    state.oilFields[oid] = { id: oid, x: o.x * CELL + CELL / 2, y: o.y * CELL + CELL / 2 };
    oid++;
  }

  players.forEach((cfg, i) => {
    const slot = cfg.slot !== undefined ? cfg.slot : i;
    const fdef = data.factions[cfg.faction];
    const ability = fdef.ability;
    const perk = fdef.econPerk || null;
    const p = {
      slot,
      team: cfg.team !== undefined ? cfg.team : slot,
      faction: cfg.faction,
      ai: cfg.ai || null,
      credits: Math.round(data.knobs.StartCredits),
      powerOut: 0,
      powerUse: 0,
      lowPower: false,
      alive: true,
      eliminated: false,
      abilityCdUntil: 0,
      swChargeTicks: -1, // -1 = never charged; counts down to 0 = ready
      ready: [],         // structure def ids ready to place
      buildQueue: [],    // {structId, progress, total} milli-progress
      oilAcc: 0,         // milli-credit accumulator (integer)
      cyRebuilt: false,
      unitsBuilt: 0,
      // v0.3.6 end-of-match score screen (render-side stats, not in checksum)
      // v0.4.2 DeepSeek fix 8: structures tracked separately from units
      unitsKilled: 0, unitsLost: 0, structsKilled: 0, structsLost: 0,
      creditsEarned: 0, creditsSpent: 0,
      // faction passives, resolved once at match start
      oilMult: perk && perk.type === 'oil_income_mult' ? perk.value : 1,
      cyDiscount: perk && perk.type === 'cheap_cy_rebuild' ? perk.value : 0,
      wfDiscount: perk && perk.type === 'war_factory_discount' ? perk.value : 0,
      earlyBuild: perk && perk.type === 'early_build_speed' ? perk : null,
      unitBuildSpeed: perk && perk.type === 'unit_build_speed' ? perk : null,
      sightBonus: ability === 'edge_network' ? 2 : 0,
      dmgAirMult: ability === 'integrated_sky' ? 1.2 : 1,
      aggroAirMult: ability === 'siha_mesh' ? 1.2 : 1,
      aiEcoMult: cfg.ai ? (AI_ECO_MULT[cfg.ai.difficulty] || 1) : 1, // AI cheat by tier
      upgrades: {},    // owned research kit ids -> true (Grok slice 3, v0.3.7)
    };
    state.players.push(p);

    // one MCV per player at their spawn
    const sp = map.spawns[slot % map.spawns.length];
    addUnit(state, 'MCV', slot, sp.x * CELL + CELL / 2, sp.y * CELL + CELL / 2);
  });

  // fog of war grids per player (indexed by slot)
  const n = map.w * map.h;
  state.fog = state.players.map(() => ({
    visible: new Uint8Array(n),
    seen: new Uint8Array(n),
  }));

  recomputeFog(state);
  return state;
}

export function addUnit(state, defId, owner, x, y, snapshot) {
  const def = state.unitDefs[defId];
  const id = state.nextId++;
  const u = {
    id, defId, owner,
    x: Math.round(x), y: Math.round(y),
    hp: def.hp, maxHp: def.hp,
    cooldown: 0, kills: 0, rank: 0,
    trophyTick: 0,
    // v0.9.0 air systems: armed air frames carry limited volleys (def.ammo ||
    // 6), then auto-return to an airfield; capTick is the tick the idle
    // holding circle started (-1 = not circling). Land/sea frames keep 0.
    ammo: def.domain === 'Air' && def.cooldownTicks > 0
      && (def.dmg.inf + def.dmg.light + def.dmg.armor + def.dmg.air + def.dmg.bldg) > 0
      ? (def.ammo || 6) : 0,
    rearming: 0,   // > 0: parked at an airfield, counts down to REARM_TICKS
    capTick: -1,   // CAP anchor set tick (see engine.js movementSystem)
    cargo: null,   // APC/IFV transport: [{defId, hp, maxHp, rank}, ...]
    order: { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 },
    capTicks: 0,    // engineer capture channel progress (serializable ints)
    capTargetId: 0,
    path: null,     // cell-index waypoints from path.js (traverse orders only)
    pathI: 0,       // next waypoint index into path
    pathTried: false, // A* already attempted for the current order (even if null)
    stuck: 0,       // consecutive immobile ticks with an active move order
    repaths: 0,     // repaths since the last actual progress
    lastPX: -1, lastPY: -1, // position last tick (stuck detection)
    lastHitTick: -1,  // under-attack alarm (v0.3.5; structures already had this)
    lastHitBy: -1,    // attacker owner slot, -1 = unknown (splash/ability)
    stance: 0,        // 0 aggressive, 1 defensive (leash), 2 hold ground, 3 hold fire (v0.3.6)
    guardX: Math.round(x), guardY: Math.round(y), // defensive leash anchor
    waypoints: null,  // shift-queued move targets, flat [x,y,...] ints (v0.3.6)
    patrol: null,     // [ax,ay,bx,by] ints: loop between both ends (v0.3.6)
    dmgMul: 1,        // research kit damage multiplier (v0.3.7)
    upgradeName: null, // label of the applied research kit (v0.3.7)
    harvCd: 0,        // HARV: boxed-in depot retry not-before tick (DeepSeek fix 6)
  };
  // owned research kits: freshly trained units inherit the buff (v0.3.7)
  const pl = state.players[owner];
  if (pl && pl.upgrades) {
    for (const gid in pl.upgrades) {
      const g = state.upgradeDefs[gid];
      if (!g || !pl.upgrades[gid] || g.appliesTo.indexOf(defId) < 0) continue;
      u.hp = Math.round(u.hp * g.hpMul);
      u.maxHp = Math.round(u.maxHp * g.hpMul);
      u.dmgMul = g.dmgMul;
      u.upgradeName = g.label;
    }
  }
  // v0.9.0 transport restore: cargo snapshots come back with their stored
  // hp/maxHp/rank (applied last so the fresh-train math above is overwritten)
  if (snapshot) {
    u.hp = Math.round(snapshot.hp);
    u.maxHp = Math.max(1, Math.round(snapshot.maxHp || snapshot.hp));
    u.rank = snapshot.rank || 0;
  }
  state.units[id] = u;
  return u;
}

// drop any waypoint state (new order, order completion, mode switch);
// also ends an air holding circle (engine.js re-anchors it on the next idle tick)
export function clearPath(u) {
  u.path = null;
  u.pathI = 0;
  u.pathTried = false;
  u.stuck = 0;
  u.repaths = 0;
  u.capTick = -1;
}

export function addStructure(state, defId, owner, cx, cy) {
  const def = state.structDefs[defId];
  const id = state.nextId++;
  const s = {
    id, defId, owner, cx, cy, fp: def.fp,
    hp: def.hp, maxHp: def.hp,
    cooldown: 0,      // structure weapons (Def)
    lastHitTick: -1,  // under-attack ping / repair sparkles
    lastHitBy: -1,    // attacker owner slot, -1 = unknown (v0.3.5)
    lastRepairTick: -1,
    queue: [],        // {unitId, progress, total} milli-progress
    harvesterId: 0,   // oil depots only
  };
  state.structures[id] = s;
  state.structVersion++; // invalidates cached passability grids
  return s;
}

export function structCenter(s) {
  return { x: s.cx * CELL + s.fp * (CELL / 2), y: s.cy * CELL + s.fp * (CELL / 2) };
}

export function entityPos(state, ent) {
  if (ent.cx !== undefined) return structCenter(ent);
  return { x: ent.x, y: ent.y };
}

// find any entity (unit or structure) by id
export function findEntity(state, id) {
  return state.units[id] || state.structures[id] || null;
}

export function sortedIds(obj) {
  return Object.keys(obj).map(Number).sort((a, b) => a - b);
}

export function cellOf(wu) {
  return Math.floor(wu / CELL);
}

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

export function teamOf(state, ownerSlot) {
  const p = state.players[ownerSlot];
  return p ? p.team : -1;
}

// hostile relative to `slot`: owned, alive, other team. Neutrals (owner -1 —
// units AND structures left behind by eliminated players) are attackable by
// everyone; structures are also capturable by engineers. Neutral units stay
// passive (movement/combat systems skip owner < 0) but are no longer
// invulnerable scenery (DeepSeek review, HIGH-1).
export function isHostile(state, slot, ent) {
  if (ent.owner === undefined) return false;
  if (ent.owner === -1) return true; // neutral unit or structure
  if (ent.owner < 0 || ent.owner === slot) return false;
  const a = state.players[ent.owner];
  if (!a || a.eliminated) return false;
  return teamOf(state, ent.owner) !== teamOf(state, slot);
}

// memoized on the state: does the map contain any water cell (terrain 2)?
export function mapHasWater(state) {
  if (state._hasWater === undefined) {
    state._hasWater = state.map.terrain.some((t) => t === 2);
  }
  return state._hasWater;
}

export function standingStructs(state, slot, pred) {
  const out = [];
  for (const id of sortedIds(state.structures)) {
    const s = state.structures[id];
    if (s.owner === slot && s.hp > 0 && (!pred || pred(s))) out.push(s);
  }
  return out;
}

export function hasStructType(state, slot, type) {
  return standingStructs(state, slot, (s) => state.structDefs[s.defId].type === type).length > 0;
}

export function hasTech(state, slot) {
  return standingStructs(state, slot, (s) => s.defId === 'SH-08').length > 0;
}

// per-player fog recompute (called every 5 ticks by the engine)
export function recomputeFog(state) {
  const { w, h } = state.map;
  for (const p of state.players) {
    const fog = state.fog[p.slot];
    fog.visible.fill(0);
    if (p.eliminated) continue;
    const mark = (cx, cy, rCells) => {
      for (let dy = -rCells; dy <= rCells; dy++) {
        for (let dx = -rCells; dx <= rCells; dx++) {
          if (dx * dx + dy * dy > rCells * rCells) continue;
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = y * w + x;
          fog.visible[i] = 1;
          fog.seen[i] = 1;
        }
      }
    };
    for (const id of sortedIds(state.units)) {
      const u = state.units[id];
      if (u.owner !== p.slot) continue;
      const def = state.unitDefs[u.defId];
      mark(cellOf(u.x), cellOf(u.y), def.sightCells + p.sightBonus);
    }
    for (const id of sortedIds(state.structures)) {
      const s = state.structures[id];
      if (s.owner !== p.slot) continue;
      mark(s.cx + Math.floor(s.fp / 2), s.cy + Math.floor(s.fp / 2), 8);
    }
  }
}
