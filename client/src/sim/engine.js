// Engine: fixed 10 ticks/sec. tick() applies due commands, then runs the
// systems in a FIXED order: production, economy, movement, separation,
// combat, projectiles, abilities/superweapons (charge), veterancy,
// elimination.
import { applyCommand, findSpawnCell, buildCost } from './orders.js';
import { productionSystem, economySystem } from './economy.js';
import { findPathCells, structGridCached, defaultRallyCell } from './path.js';
import {
  combatSystem, structureCombatSystem, repairSystem, projectileSystem,
  veterancySystem, REARM_TICKS,
} from './combat.js';
import {
  CELL, sortedIds, entityPos, findEntity, isHostile, recomputeFog, dist2,
  standingStructs, structCenter, cellOf, teamOf, clearPath,
} from './state.js';

export const CMD_DELAY = 0; // single-player: same-tick application (netcode would raise this)

export function tick(state, commands) {
  if (state.over) return;
  if (commands) {
    for (const cmd of commands) {
      state.queue.push({ due: state.tick + CMD_DELAY, cmd });
    }
  }
  // apply commands due this tick, FIFO
  const due = [];
  const rest = [];
  for (const q of state.queue) (q.due <= state.tick ? due : rest).push(q);
  state.queue = rest;
  for (const q of due) applyCommand(state, q.cmd);

  productionSystem(state);
  economySystem(state);
  movementSystem(state);
  separationSystem(state); // v0.3.6 soft anti-overlap push
  combatSystem(state);
  structureCombatSystem(state);
  repairSystem(state);
  projectileSystem(state);
  veterancySystem(state);
  eliminationSystem(state);
  if (state.tick % 5 === 0) recomputeFog(state);
  state.tick++;
}

// ---- movement ---------------------------------------------------------------

function terrainCellAt(state, cx, cy) {
  const { w, h, terrain } = state.map;
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return -1;
  return terrain[cy * w + cx];
}

// structure occupying a cell, if any (footprints are grid-aligned rects).
// O(1) via the structVersion-keyed occupancy grid (DeepSeek review MED-5).
function structAtCell(state, cx, cy) {
  const { w, h } = state.map;
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
  const id = structGridCached(state)[cy * w + cx];
  return id >= 0 ? state.structures[id] || null : null;
}

function passable(state, def, x, y, u) {
  const t = terrainCellAt(state, Math.floor(x / CELL), Math.floor(y / CELL));
  if (def.domain === 'Air') return t >= 0;
  if (def.domain === 'Sea') return t === 2; // yards sit on land, so no overlap
  if (t !== 0) return false;
  // land: building footprints are solid
  const s = structAtCell(state, Math.floor(x / CELL), Math.floor(y / CELL));
  if (!s) return true;
  // a unit already inside a footprint (placed over it) may always walk out
  if (u) {
    const cur = structAtCell(state, cellOf(u.x), cellOf(u.y));
    if (cur && cur.id === s.id) return true;
  }
  return false;
}

// step toward (tx,ty), stopping when within stopDist (world units).
// Axis-priority integer movement with one-axis slide around blocked cells.
function moveTowards(state, u, def, tx, ty, stopDist) {
  const dx = tx - u.x, dy = ty - u.y;
  if (dx * dx + dy * dy <= stopDist * stopDist) return true;
  // v0.9.0 transports: loaded APCs/IFVs haul weight — 5% per passenger up to
  // 6 (computed here, not on the shared def, so the def stays immutable)
  let step = def.step;
  if (u.cargo && u.cargo.length) {
    step = Math.max(1, Math.round(step * (1 - 0.05 * Math.min(u.cargo.length, 6))));
  }
  if (step <= 0) return true;
  let mx = Math.max(-step, Math.min(step, dx));
  let my = Math.max(-step, Math.min(step, dy));
  if (Math.abs(mx) + Math.abs(my) > step) {
    // axis priority: give x first claim on the step budget
    my = Math.max(-(step - Math.abs(mx)), Math.min(step - Math.abs(mx), dy));
  }
  const nx = u.x + mx, ny = u.y + my;
  if (passable(state, def, nx, ny, u)) { u.x = nx; u.y = ny; }
  else if (mx !== 0 && passable(state, def, nx, u.y, u)) { u.x = nx; }
  else if (my !== 0 && passable(state, def, u.x, ny, u)) { u.y = ny; }
  else {
    // head-on block (e.g. a building face): sidestep along the wall, target
    // side first, deterministic fallback by unit id
    const sy = Math.sign(dy) || (u.id % 2 ? 1 : -1);
    const sx = Math.sign(dx) || (u.id % 2 ? -1 : 1);
    if (passable(state, def, u.x, u.y + sy * step, u)) u.y += sy * step;
    else if (passable(state, def, u.x, u.y - sy * step, u)) u.y -= sy * step;
    else if (passable(state, def, u.x + sx * step, u.y, u)) u.x += sx * step;
    else if (passable(state, def, u.x - sx * step, u.y, u)) u.x -= sx * step;
  }
  return false;
}

// armed land/sea/air units only (MCV/HARV/engineers excluded by dmg check)
function isArmedDef(def) {
  return def.dmg.inf + def.dmg.light + def.dmg.armor + def.dmg.air + def.dmg.bldg > 0
    && def.range > 0;
}

// ---- CAP holding pattern (v0.9.0; v0.9.1 LUT) -------------------------------
// v0.9.1 determinism: the CAP circle was the LAST transcendental in the sim
// (Math.cos/sin). Replaced with hardcoded integer LUTs of
// Math.round(2*CELL*cos/sin(k*Math.PI/180)) for every k in [0,360), generated
// once with V8's own Math.cos/sin (see tools/_gen_cap_lut_tmp.py). All 360
// residues are required — the per-unit phase offset ((id*37)%360) is not
// 12-degree aligned, so a unit visits base+{0,12,...,348} mod 360 and across
// units every residue occurs. capTarget reduces the phase mod 360 before the
// lookup; the tests prove positions stay byte-identical to the cos/sin path.
const CAP_COS_LUT = [128,128,128,128,128,128,127,127,127,126,126,126,125,125,124,124,123,122,122,121,120,119,119,118,117,116,115,114,113,112,111,110,109,107,106,105,104,102,101,99,98,97,95,94,92,91,89,87,86,84,82,81,79,77,75,73,72,70,68,66,64,62,60,58,56,54,52,50,48,46,44,42,40,37,35,33,31,29,27,24,22,20,18,16,13,11,9,7,4,2,0,-2,-4,-7,-9,-11,-13,-16,-18,-20,-22,-24,-27,-29,-31,-33,-35,-37,-40,-42,-44,-46,-48,-50,-52,-54,-56,-58,-60,-62,-64,-66,-68,-70,-72,-73,-75,-77,-79,-81,-82,-84,-86,-87,-89,-91,-92,-94,-95,-97,-98,-99,-101,-102,-104,-105,-106,-107,-109,-110,-111,-112,-113,-114,-115,-116,-117,-118,-119,-119,-120,-121,-122,-122,-123,-124,-124,-125,-125,-126,-126,-126,-127,-127,-127,-128,-128,-128,-128,-128,-128,-128,-128,-128,-128,-128,-127,-127,-127,-126,-126,-126,-125,-125,-124,-124,-123,-122,-122,-121,-120,-119,-119,-118,-117,-116,-115,-114,-113,-112,-111,-110,-109,-107,-106,-105,-104,-102,-101,-99,-98,-97,-95,-94,-92,-91,-89,-87,-86,-84,-82,-81,-79,-77,-75,-73,-72,-70,-68,-66,-64,-62,-60,-58,-56,-54,-52,-50,-48,-46,-44,-42,-40,-37,-35,-33,-31,-29,-27,-24,-22,-20,-18,-16,-13,-11,-9,-7,-4,-2,0,2,4,7,9,11,13,16,18,20,22,24,27,29,31,33,35,37,40,42,44,46,48,50,52,54,56,58,60,62,64,66,68,70,72,73,75,77,79,81,82,84,86,87,89,91,92,94,95,97,98,99,101,102,104,105,106,107,109,110,111,112,113,114,115,116,117,118,119,119,120,121,122,122,123,124,124,125,125,126,126,126,127,127,127,128,128,128,128,128];
const CAP_SIN_LUT = [0,2,4,7,9,11,13,16,18,20,22,24,27,29,31,33,35,37,40,42,44,46,48,50,52,54,56,58,60,62,64,66,68,70,72,73,75,77,79,81,82,84,86,87,89,91,92,94,95,97,98,99,101,102,104,105,106,107,109,110,111,112,113,114,115,116,117,118,119,119,120,121,122,122,123,124,124,125,125,126,126,126,127,127,127,128,128,128,128,128,128,128,128,128,128,128,127,127,127,126,126,126,125,125,124,124,123,122,122,121,120,119,119,118,117,116,115,114,113,112,111,110,109,107,106,105,104,102,101,99,98,97,95,94,92,91,89,87,86,84,82,81,79,77,75,73,72,70,68,66,64,62,60,58,56,54,52,50,48,46,44,42,40,37,35,33,31,29,27,24,22,20,18,16,13,11,9,7,4,2,0,-2,-4,-7,-9,-11,-13,-16,-18,-20,-22,-24,-27,-29,-31,-33,-35,-37,-40,-42,-44,-46,-48,-50,-52,-54,-56,-58,-60,-62,-64,-66,-68,-70,-72,-73,-75,-77,-79,-81,-82,-84,-86,-87,-89,-91,-92,-94,-95,-97,-98,-99,-101,-102,-104,-105,-106,-107,-109,-110,-111,-112,-113,-114,-115,-116,-117,-118,-119,-119,-120,-121,-122,-122,-123,-124,-124,-125,-125,-126,-126,-126,-127,-127,-127,-128,-128,-128,-128,-128,-128,-128,-128,-128,-128,-128,-127,-127,-127,-126,-126,-126,-125,-125,-124,-124,-123,-122,-122,-121,-120,-119,-119,-118,-117,-116,-115,-114,-113,-112,-111,-110,-109,-107,-106,-105,-104,-102,-101,-99,-98,-97,-95,-94,-92,-91,-89,-87,-86,-84,-82,-81,-79,-77,-75,-73,-72,-70,-68,-66,-64,-62,-60,-58,-56,-54,-52,-50,-48,-46,-44,-42,-40,-37,-35,-33,-31,-29,-27,-24,-22,-20,-18,-16,-13,-11,-9,-7,-4,-2];

// CAP loiter target for an idle airframe: circle radius 2 cells, 12 deg/tick,
// per-unit phase — pure function of (id, capTick, tick), so determinism and
// checksums hold. Integer-only via the LUTs above.
export function capTarget(u, tick) {
  const phase = (((u.id * 37) % 360) + 360) % 360 + (tick - u.capTick) * 12;
  const k = ((phase % 360) + 360) % 360;
  return { x: u.guardX + CAP_COS_LUT[k], y: u.guardY + CAP_SIN_LUT[k] };
}

// ---- waypoint pathing (v0.3.1 WAVE-2) --------------------------------------
// Long traverse orders (move / attackMove, and the harvester's shuttle legs,
// which are plain move orders) follow an A* waypoint path on the cell grid
// instead of the bare axis slide. The legacy stepper still does the actual
// per-tick stepping (speeds/feel unchanged) and stays as the fallback when no
// path exists. Chases and final approaches use direct steering.

const PATH_MIN = 2 * CELL;        // closer than this: direct steering suffices
const WAYPOINT_ARRIVE = CELL / 4; // waypoint reach distance
const STUCK_TICKS = 15;           // immobile ticks before a forced repath
const MAX_REPATHS = 3;            // then give up on the grid (legacy slide)

function computePath(state, u, def, tx, ty) {
  u.path = findPathCells(state, def, cellOf(u.x), cellOf(u.y), cellOf(tx), cellOf(ty));
  u.pathI = 0;
}

function waypointCenter(state, c) {
  return {
    x: (c % state.map.w) * CELL + CELL / 2,
    y: ((c / state.map.w) | 0) * CELL + CELL / 2,
  };
}

// returns true when the order target is reached
function pathMove(state, u, def, o) {
  const dxT = o.x - u.x, dyT = o.y - u.y;
  const dist2T = dxT * dxT + dyT * dyT;
  if (dist2T <= (CELL / 2) * (CELL / 2)) return true;

  // stuck detection: no positional progress while trying to move
  if (u.x === u.lastPX && u.y === u.lastPY) u.stuck++;
  else { u.stuck = 0; u.repaths = 0; }
  u.lastPX = u.x; u.lastPY = u.y;

  const gridded = def.domain !== 'Air';
  if (gridded && !u.path && !u.pathTried && dist2T > PATH_MIN * PATH_MIN) {
    u.pathTried = true; // attempted once per order — never recompute per tick
    computePath(state, u, def, o.x, o.y);
  }
  if (gridded && u.stuck >= STUCK_TICKS) {
    u.stuck = 0;
    if (u.repaths < MAX_REPATHS) {
      u.repaths++;
      computePath(state, u, def, o.x, o.y); // repath from the current cell
    } else {
      u.path = null; // give up on the grid: legacy slide below
    }
  }

  if (u.path) {
    // advance past reached waypoints
    while (u.pathI < u.path.length) {
      const w = waypointCenter(state, u.path[u.pathI]);
      const dx = w.x - u.x, dy = w.y - u.y;
      if (dx * dx + dy * dy > WAYPOINT_ARRIVE * WAYPOINT_ARRIVE) break;
      u.pathI++;
    }
    if (u.pathI < u.path.length) {
      const w = waypointCenter(state, u.path[u.pathI]);
      if (passable(state, def, w.x, w.y, u)) {
        moveTowards(state, u, def, w.x, w.y, WAYPOINT_ARRIVE);
        return false;
      }
      // a cell on the path became impassable (new structure) -> repath once
      computePath(state, u, def, o.x, o.y);
      if (u.path) return false; // follow the fresh path next tick
    }
    u.path = null; // waypoints done (or unrecoverable): final approach below
  }
  // near the goal, air unit, or no usable path: straight steering + slide
  return moveTowards(state, u, def, o.x, o.y, CELL / 2);
}

// order finished (move/attackMove arrived): consume the next shift-queued
// waypoint, loop a patrol, or fall idle. The defensive guard anchor re-sets
// wherever the unit comes to rest. (v0.3.6)
function advanceOrder(state, u, type) {
  if (u.waypoints && u.waypoints.length >= 2) {
    u.order = { type, x: u.waypoints[0], y: u.waypoints[1], targetId: 0, enemyId: 0 };
    u.waypoints.splice(0, 2);
    if (!u.waypoints.length) u.waypoints = null;
    clearPath(u);
    return;
  }
  if (u.patrol) {
    const atB = u.order.x === u.patrol[2] && u.order.y === u.patrol[3];
    u.order = {
      type: 'move',
      x: atB ? u.patrol[0] : u.patrol[2], y: atB ? u.patrol[1] : u.patrol[3],
      targetId: 0, enemyId: 0,
    };
    clearPath(u);
    return;
  }
  u.order = { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
  u.guardX = u.x; u.guardY = u.y;
  clearPath(u);
}

export function movementSystem(state) {
  for (const id of sortedIds(state.units)) {
    const u = state.units[id];
    if (u.owner < 0) continue;
    const def = state.unitDefs[u.defId];
    if (def.step <= 0) continue;
    const o = u.order;
    if (o.type === 'move' || (o.type === 'attackMove' && !o.enemyId)) {
      if (pathMove(state, u, def, o)) advanceOrder(state, u, o.type);
    } else if (o.type === 'attackTarget' || (o.type === 'attackMove' && o.enemyId)) {
      // chase: direct steering, and drop any traverse path we were following
      if (u.path) clearPath(u);
      const t = findEntity(state, o.type === 'attackTarget' ? o.targetId : o.enemyId);
      // engineers may walk up to a hostile/neutral structure to capture it
      const captureTarget = def.cls === 'Engineer' && o.type === 'attackTarget'
        && t && t.cx !== undefined && t.owner !== u.owner
        && teamOf(state, t.owner) !== teamOf(state, u.owner);
      if (!t || (!isHostile(state, u.owner, t) && !captureTarget)) {
        if (o.type === 'attackMove') o.enemyId = 0; // resume the traverse
        continue;
      }
      // attack-move leash (DeepSeek review HIGH-2): give up the chase once
      // the TARGET is more than 2x sight from the attack-move destination,
      // then resume toward it. attackTarget (explicit player intent) keeps
      // chasing without a leash; idle auto-acquire keeps its 1.5x-sight drop.
      if (o.type === 'attackMove') {
        const lp = entityPos(state, t);
        const leash = 2 * def.sightWu;
        if (dist2(lp.x, lp.y, o.x, o.y) > leash * leash) { o.enemyId = 0; continue; }
      }
      const tp = entityPos(state, t);
      // v0.3.2: kamikaze air frames (rof_s 0, armed) close to point-blank so
      // their CELL*CELL blast check in maybeDetonate actually reaches the
      // target; everyone else keeps normal standoff range.
      const stopDist = (def.domain === 'Air' && def.rof_s === 0)
        ? CELL / 2 : def.rangeWu;
      moveTowards(state, u, def, tp.x, tp.y, stopDist);
    } else if (o.type === 'repair') {
      // explicit repair order (DeepSeek review UX-1): walk into range of the
      // damaged ally structure; repairSystem channels once in range. The
      // order completes (drops to idle) when the target is gone or full.
      const t = state.structures[o.targetId];
      if (!t || t.hp >= t.maxHp || t.owner < 0
          || teamOf(state, t.owner) !== teamOf(state, u.owner)) {
        u.order = { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
        clearPath(u);
        continue;
      }
      const c = structCenter(t);
      moveTowards(state, u, def, c.x, c.y, def.rangeWu);
    } else if (o.type === 'rearm') {
      // v0.9.0: ammo-dry airframe. Fly to the airfield center, park for
      // REARM_TICKS, refill, then take the snapshotted prior order back
      // (combat.js startRearm). Vulnerable the whole time — a normal unit.
      const afNow = state.structures[o.targetId];
      if (afNow && afNow.owner !== u.owner) {
        // v0.9.1: the airfield was CAPTURED mid-flight or mid-park — the
        // rearm is cut short: drop to idle, still dry (no enemy refill).
        // Without this a frame parked at an enemy-captured field completed
        // a full rearm (hostile audit P2, reproduced with an engineer flip).
        u.rearming = 0;
        u.order = { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
        clearPath(u);
        continue;
      }
      if (u.rearming > 0) {
        u.rearming--;
        if (u.rearming === 0) {
          u.ammo = def.ammo || 6;
          const r = o.resume;
          const t = r && r.targetId ? findEntity(state, r.targetId) : null;
          if (r && (r.type === 'move' || r.type === 'attackMove')) {
            u.order = { type: r.type, x: r.x, y: r.y, targetId: 0, enemyId: 0 };
          } else if (r && r.type === 'attackTarget' && t && t.hp > 0
              && isHostile(state, u.owner, t)) {
            u.order = { type: 'attackTarget', x: 0, y: 0, targetId: t.id, enemyId: 0 };
          } else {
            u.order = { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
          }
          clearPath(u);
        }
      } else {
        const af = state.structures[o.targetId];
        if (!af || af.hp <= 0) {
          // airfield died mid-flight: give up and loiter (still dry)
          u.order = { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
          clearPath(u);
        } else if (dist2(u.x, u.y, o.x, o.y) <= CELL * CELL) {
          u.rearming = REARM_TICKS; // on the pad — park and rearm
        } else {
          moveTowards(state, u, def, o.x, o.y, CELL);
        }
      }
    } else if (o.type === 'idle' && o.enemyId && isArmedDef(def) && u.stance <= 1) {
      // short idle chase (v0.3.6 stances): aggressive pursues, giving up
      // beyond ~1.5x sight; defensive chases only within a ~4-cell leash of
      // its guard point, then walks back. Hold ground / hold fire never chase.
      if (u.path) clearPath(u);
      const t = findEntity(state, o.enemyId);
      if (!t || !isHostile(state, u.owner, t)) { o.enemyId = 0; continue; }
      const tp = entityPos(state, t);
      if (u.stance === 1) {
        if (dist2(u.x, u.y, u.guardX, u.guardY) > (4 * CELL) * (4 * CELL)) {
          o.enemyId = 0;
          u.order = { type: 'move', x: u.guardX, y: u.guardY, targetId: 0, enemyId: 0 };
          clearPath(u);
          continue;
        }
      } else {
        const drop = Math.round(def.sightWu * 1.5);
        if (dist2(u.x, u.y, tp.x, tp.y) > drop * drop) { o.enemyId = 0; continue; }
      }
      moveTowards(state, u, def, tp.x, tp.y, def.rangeWu);
    } else if (o.type === 'idle' && o.enemyId && u.stance >= 2) {
      o.enemyId = 0; // hold ground: scan re-acquires in-range targets each tick
    } else if (o.type === 'idle' && def.domain === 'Air') {
      // v0.9.0 CAP holding pattern: idle airframes loiter a slow circle
      // instead of hovering on the spot. Anchor = the guard point, lazily
      // (re)set to the current position when the circle starts (capTick).
      // v0.9.1: the circle target comes from the integer CAP LUT (capTarget)
      // — byte-identical positions to the old Math.cos/sin path (tested).
      if (u.capTick < 0) {
        u.capTick = state.tick;
        u.guardX = u.x;
        u.guardY = u.y;
      }
      const t = capTarget(u, state.tick);
      moveTowards(state, u, def, t.x, t.y, 0);
    } else if (o.type === 'idle' && u.stance === 1 && !o.enemyId
        && dist2(u.x, u.y, u.guardX, u.guardY) > CELL * CELL) {
      // defensive unit displaced from its guard point: walk back
      u.order = { type: 'move', x: u.guardX, y: u.guardY, targetId: 0, enemyId: 0 };
      clearPath(u);
    } else if (o.type === 'idle' && u.defId === 'HARV') {
      harvShuttle(state, u, def);
    }
    // idle units otherwise hold position (they fire in range but never wander)
  }
}

// ---- unit separation (v0.3.6; v0.9.0 tuning) ---------------------------------
// Soft radial anti-overlap push between friendly same-domain units. Cell-
// bucket neighbor pass (bounded), deterministic iteration via sortedIds,
// integer positions, and passability-checked pushes so units never get
// shoved into buildings or off terrain.
// v0.9.0: base radius 24 -> 28 wu, and idle units lingering within 2 cells
// of a producer's rally cell get a stronger direct push out of the doorway
// (freshly produced units spawn into that cell — see findSpawnCell).

const SEP_RADIUS = 28;  // wu: closer pairs push apart
const SEP_STEP = 3;     // wu/tick max push per unit
const DOOR_STEP = 6;    // wu/tick doorway ejection (2x the base push)

export function separationSystem(state) {
  const w = state.map.w, h = state.map.h;
  const buckets = new Map(); // cell index -> unit list
  for (const id of sortedIds(state.units)) {
    const u = state.units[id];
    if (u.owner < 0) continue;
    const key = cellOf(u.y) * w + cellOf(u.x);
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(u);
  }
  for (const [key, arr] of buckets) {
    const cx = key % w, cy = (key / w) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nKey = ny * w + nx;
        const nArr = buckets.get(nKey);
        if (!nArr) continue;
        // each unordered pair processed exactly once: cross-bucket pairs only
        // when the neighbor bucket sorts later; within a bucket, j > i
        // (insertion follows sortedIds)
        if (nKey < key) continue;
        for (let i = 0; i < arr.length; i++) {
          const a = arr[i];
          const j0 = nKey === key ? i + 1 : 0;
          for (let j = j0; j < nArr.length; j++) {
            const b = nArr[j];
            if (teamOf(state, a.owner) !== teamOf(state, b.owner)) continue;
            const da = state.unitDefs[a.defId], db = state.unitDefs[b.defId];
            if (da.domain !== db.domain) continue;
            let dx = b.x - a.x, dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 >= SEP_RADIUS * SEP_RADIUS) continue;
            if (d2 === 0) { dx = (a.id % 2) ? 1 : -1; dy = 0; d2 = 1; }
            const d = Math.sqrt(d2);
            const push = Math.min(SEP_STEP, SEP_RADIUS - Math.floor(d));
            if (push <= 0) continue;
            const px = Math.round(push * dx / d), py = Math.round(push * dy / d);
            if (px === 0 && py === 0) continue;
            // symmetric push, only into passable cells
            if (passable(state, da, a.x - px, a.y - py, a)) { a.x -= px; a.y -= py; }
            if (passable(state, db, b.x + px, b.y + py, b)) { b.x += px; b.y += py; }
          }
        }
      }
    }
  }

  // producer-doorway ejection: an idle unit standing in a producer's rally
  // cell blocks freshly spawned units (findSpawnCell can even fail). Push it
  // straight out of the 2-cell doorway zone. Rally = explicit setRally point
  // or the default 3-cells-toward-center cell (airfields have none — their
  // frames loiter on the pad in a CAP circle instead).
  const rallyPts = [];
  for (const id of sortedIds(state.structures)) {
    const s = state.structures[id];
    if (s.owner < 0 || s.hp <= 0) continue;
    if (state.structDefs[s.defId].type !== 'Prod') continue;
    const r = state.rally[s.id] || defaultRallyCell(state, s);
    if (r) rallyPts.push(r);
  }
  if (rallyPts.length) {
    const doorR2 = (2 * CELL) * (2 * CELL);
    for (const id of sortedIds(state.units)) {
      const u = state.units[id];
      if (u.owner < 0 || u.order.type !== 'idle') continue;
      const def = state.unitDefs[u.defId];
      for (const rp of rallyPts) {
        let dx = u.x - rp.x, dy = u.y - rp.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > doorR2) continue;
        if (d2 === 0) { dx = (u.id % 2) ? 1 : -1; dy = 0; d2 = 1; }
        const d = Math.sqrt(d2);
        const px = Math.round(DOOR_STEP * dx / d), py = Math.round(DOOR_STEP * dy / d);
        if (px === 0 && py === 0) continue;
        if (passable(state, def, u.x + px, u.y + py, u)) { u.x += px; u.y += py; }
        else if (passable(state, def, u.x + px, u.y, u)) { u.x += px; }
        else if (passable(state, def, u.x, u.y + py, u)) { u.y += py; }
      }
    }
  }
}

// nearest passable land cell within 3*CELL of the depot center, or null.
// Fallback for harvShuttle when findSpawnCell comes up empty (DeepSeek
// review LOW-6): proximity to the depot is all the income rule needs.
function nearDepotCell(state, def, dc) {
  const maxD = 3 * CELL;
  const cx0 = cellOf(dc.x), cy0 = cellOf(dc.y);
  for (let r = 0; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cx = cx0 + dx, cy = cy0 + dy;
        if (terrainCellAt(state, cx, cy) !== 0) continue;
        if (structAtCell(state, cx, cy)) continue;
        const wx = cx * CELL + CELL / 2, wy = cy * CELL + CELL / 2;
        if (dist2(wx, wy, dc.x, dc.y) <= maxD * maxD) return { x: wx, y: wy };
      }
    }
  }
  return null;
}

// idle harvesters shuttle: near an oil field haul to the bound (or nearest own)
// depot; otherwise head to the nearest field. Issues real move orders, so the
// leg completes before the next one is chosen (no per-tick flip-flop).
function harvShuttle(state, u, def) {
  const nearR = 3 * CELL;
  const depots = standingStructs(state, u.owner, (s) => s.defId === 'SH-03');
  if (!depots.length) return;
  let depot = null;
  for (const d of depots) if (d.harvesterId === u.id) { depot = d; break; }
  if (!depot) {
    depot = depots[0];
    for (const d of depots) {
      const dc = structCenter(d);
      const bc = structCenter(depot);
      if (dist2(u.x, u.y, dc.x, dc.y) < dist2(u.x, u.y, bc.x, bc.y)) depot = d;
    }
  }
  const dc = structCenter(depot);
  let oil = null, oilD = Infinity;
  for (const f of Object.values(state.oilFields)) {
    const d2 = dist2(u.x, u.y, f.x, f.y);
    if (d2 < oilD) { oilD = d2; oil = f; }
  }
  if (oil && oilD <= nearR * nearR) {
    // target an open cell by the depot — the footprint itself is impassable
    const cell = findSpawnCell(state, u.owner, def, dc);
    if (cell) {
      u.order = { type: 'move', x: cell.x, y: cell.y, targetId: 0, enemyId: 0 };
      clearPath(u);
    } else if (state.tick >= u.harvCd) {
      // boxed-in depot (DeepSeek review LOW-6): park on any passable cell
      // within 3*CELL of the depot center (income only needs proximity);
      // if truly none, idle quietly and retry after a short cooldown
      // instead of re-issuing orders every idle tick.
      const fb = nearDepotCell(state, def, dc);
      if (fb) {
        u.order = { type: 'move', x: fb.x, y: fb.y, targetId: 0, enemyId: 0 };
        clearPath(u);
      } else {
        u.harvCd = state.tick + 50; // retry in ~5s
      }
    }
  } else if (oil) {
    u.order = { type: 'move', x: oil.x, y: oil.y, targetId: 0, enemyId: 0 };
    clearPath(u);
  }
}

// ---- elimination / victory ---------------------------------------------------

export function eliminationSystem(state) {
  for (const p of state.players) {
    if (p.eliminated) continue;
    const hasCore = Object.values(state.structures)
      .some((s) => s.owner === p.slot && s.defId === 'SH-01');
    const hasMcv = Object.values(state.units)
      .some((u) => u.owner === p.slot && u.defId === 'MCV');
    if (!hasCore) {
      // rebuild window (v0.3.2): while the one ConYard rebuild is still
      // possible in principle — any owned structure standing, an MCV alive,
      // or credits for the rebuild — the player survives. No credit snapshot
      // anymore: poverty alone doesn't kill, but it doesn't save either once
      // the rebuild is spent.
      const anchored = Object.values(state.structures).some((s) => s.owner === p.slot);
      const rebuildCost = buildCost(state, p, state.structDefs['SH-01']);
      if (!p.cyRebuilt && (anchored || hasMcv || p.credits >= rebuildCost)) continue;
      p.eliminated = true;
      p.alive = false;
      // surviving units AND structures go neutral (owner -1): units stay
      // passive (movement/combat skip owner < 0) but are attackable by
      // everyone; structures remain attackable/capturable as before
      for (const id of sortedIds(state.units)) {
        const u = state.units[id];
        if (u.owner === p.slot) {
          u.owner = -1;
          u.order = { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
        }
      }
      for (const id of sortedIds(state.structures)) {
        const s = state.structures[id];
        if (s.owner === p.slot) s.owner = -1;
      }
    }
  }
  const teams = new Set();
  for (const p of state.players) if (!p.eliminated) teams.add(p.team);
  if (teams.size <= 1) {
    state.over = true;
    state.winner = teams.size === 1 ? [...teams][0] : -1;
  }
}

// ---- checksum (FNV-1a over canonical serialization, for desync detection) ---
// Covers players, units (incl. path progress + engineer capture channel +
// rank), structures, projectiles. Fog stays excluded BY DESIGN for now — it
// is per-player UI state; revisit if/when lockstep netplay lands.
// FORMAT BUMP (v0.3.7, DEEPSEEK checksum completion): the unit record now
// also covers the v0.3.6 order-state fields (stance, guard anchor, queued
// waypoints as length + x,y entries in order, patrol loop endpoints) and the
// v0.3.7 research fields (upgradeName, dmgMul); the player record covers
// owned research kit ids. Baseline values from older versions do not compare.
// FORMAT BUMP (v0.4.2, DeepSeek review fix 6): the unit record now also
// covers harvCd (boxed-in depot retry tick) — it gates future orders, so it
// is persistent sim state. Baselines from older formats do not compare.
// FORMAT BUMP (v0.9.0): the unit record also covers the air-system fields
// (ammo, rearming, capTick) and the transport cargo count — they gate future
// orders/positions, so they are persistent sim state. Idle airframes now
// genuinely move (CAP circles), so unit positions diverge from older builds
// even before the format change. Baselines from older formats do not compare.
// FORMAT BUMP (v0.9.1, hostile-audit checksum completion): the unit record now
// covers the FULL order (type/x/y/targetId/enemyId, plus the rearm `resume`
// snapshot) and trophyTick — both gate future firing/positions. The structure
// record covers cooldown, the unit-queue head (unitId:progress) and
// harvesterId. The player record covers swChargeTicks, abilityCdUntil,
// cyRebuilt, the structure buildQueue (structId:progress entries), oilAcc,
// powerOut, powerUse and lowPower. state.rally points enter the stream sorted
// by structure id. The projectile record covers kind/dmg/radiusWu (render-only
// fields like tracer cls/srcUnitId stay excluded). Transport cargo serializes
// its CONTENTS (defId:hp per entry) instead of a bare count. Baselines from
// older formats do not compare.

export function checksum(state) {
  const parts = ['t' + state.tick];
  for (const p of state.players) {
    const upg = Object.keys(p.upgrades || {}).filter((k) => p.upgrades[k]).sort();
    const bq = p.buildQueue.map((q) => q.structId + ':' + q.progress).join('.');
    parts.push(`P${p.slot}:${p.credits}:${p.eliminated ? 1 : 0}:${upg.join('+')}`
      + `/${p.swChargeTicks},${p.abilityCdUntil},${p.cyRebuilt ? 1 : 0}`
      + `,${bq || '-'},${p.oilAcc},${p.powerOut},${p.powerUse},${p.lowPower ? 1 : 0}`);
  }
  for (const id of sortedIds(state.units)) {
    const u = state.units[id];
    const o = u.order;
    const resume = o.resume
      ? `,${o.resume.type},${o.resume.x},${o.resume.y},${o.resume.targetId}` : '';
    parts.push(`u${id}:${u.defId}:${u.owner},${u.x},${u.y},${u.hp},${u.cooldown},${u.kills},${u.rank}`
      + `,${u.capTicks},${u.capTargetId},${u.path ? u.path.length : -1},${u.pathI}`
      + `,${u.stance},${u.guardX},${u.guardY}`
      + `,${u.waypoints ? u.waypoints.length + ':' + u.waypoints.join('.') : -1}`
      + `,${u.patrol ? u.patrol.join('.') : -1}`
      + `,${u.dmgMul || 1},${u.upgradeName || ''},${u.harvCd || 0}`
      + `,${u.ammo || 0},${u.rearming || 0},${u.capTick === undefined ? -1 : u.capTick}`
      + `,${u.cargo ? u.cargo.map((c) => c.defId + ':' + c.hp).join('+') : ''}`
      + `,${u.trophyTick || 0}`
      + `,${o.type},${o.x},${o.y},${o.targetId},${o.enemyId}${resume}`);
  }
  for (const id of sortedIds(state.structures)) {
    const s = state.structures[id];
    const qHead = s.queue && s.queue.length
      ? s.queue[0].unitId + ':' + s.queue[0].progress : '-';
    parts.push(`s${id}:${s.defId}:${s.owner},${s.cx},${s.cy},${s.hp}`
      + `,${s.cooldown || 0},${qHead},${s.harvesterId || 0}`);
  }
  for (const sid of sortedIds(state.rally)) {
    const r = state.rally[sid];
    parts.push(`R${sid}:${r.x},${r.y}`);
  }
  for (const id of sortedIds(state.projectiles)) {
    const pr = state.projectiles[id];
    parts.push(`p${id}:${pr.owner},${pr.tx},${pr.ty},${pr.ticksLeft}`
      + `,${pr.kind},${pr.dmg},${pr.radiusWu}`);
  }
  const str = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xffff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
