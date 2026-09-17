// Engine: fixed 10 ticks/sec. tick() applies due commands, then runs the
// systems in a FIXED order: production, economy, movement, combat,
// projectiles, abilities/superweapons (charge), veterancy, elimination.
import { applyCommand, findSpawnCell, buildCost } from './orders.js';
import { productionSystem, economySystem } from './economy.js';
import { findPathCells } from './path.js';
import {
  combatSystem, structureCombatSystem, repairSystem, projectileSystem,
  veterancySystem,
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

// structure occupying a cell, if any (footprints are grid-aligned rects)
function structAtCell(state, cx, cy) {
  for (const id of sortedIds(state.structures)) {
    const s = state.structures[id];
    if (cx >= s.cx && cx < s.cx + s.fp && cy >= s.cy && cy < s.cy + s.fp) return s;
  }
  return null;
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
  const step = def.step;
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

export function movementSystem(state) {
  for (const id of sortedIds(state.units)) {
    const u = state.units[id];
    if (u.owner < 0) continue;
    const def = state.unitDefs[u.defId];
    if (def.step <= 0) continue;
    const o = u.order;
    if (o.type === 'move' || (o.type === 'attackMove' && !o.enemyId)) {
      if (pathMove(state, u, def, o)) {
        u.order = { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
        clearPath(u);
      }
    } else if (o.type === 'attackTarget' || (o.type === 'attackMove' && o.enemyId)) {
      // chase: direct steering, and drop any traverse path we were following
      if (u.path) clearPath(u);
      const t = findEntity(state, o.type === 'attackTarget' ? o.targetId : o.enemyId);
      // engineers may walk up to a hostile/neutral structure to capture it
      const captureTarget = def.cls === 'Engineer' && o.type === 'attackTarget'
        && t && t.cx !== undefined && t.owner !== u.owner
        && teamOf(state, t.owner) !== teamOf(state, u.owner);
      if (!t || (!isHostile(state, u.owner, t) && !captureTarget)) continue;
      const tp = entityPos(state, t);
      // v0.3.2: kamikaze air frames (rof_s 0, armed) close to point-blank so
      // their CELL*CELL blast check in maybeDetonate actually reaches the
      // target; everyone else keeps normal standoff range.
      const stopDist = (def.domain === 'Air' && def.rof_s === 0)
        ? CELL / 2 : def.rangeWu;
      moveTowards(state, u, def, tp.x, tp.y, stopDist);
    } else if (o.type === 'idle' && o.enemyId && isArmedDef(def)) {
      // short idle chase: pursue, but give up beyond ~1.5x sight
      if (u.path) clearPath(u);
      const t = findEntity(state, o.enemyId);
      const drop = Math.round(def.sightWu * 1.5);
      if (!t || !isHostile(state, u.owner, t)) { o.enemyId = 0; continue; }
      const tp = entityPos(state, t);
      if (dist2(u.x, u.y, tp.x, tp.y) > drop * drop) { o.enemyId = 0; continue; }
      moveTowards(state, u, def, tp.x, tp.y, def.rangeWu);
    } else if (o.type === 'idle' && u.defId === 'HARV') {
      harvShuttle(state, u, def);
    }
    // idle units otherwise hold position (they fire in range but never wander)
  }
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
      // inert scenery; structures remain attackable/capturable by everyone
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

export function checksum(state) {
  const parts = ['t' + state.tick];
  for (const p of state.players) {
    parts.push(`P${p.slot}:${p.credits}:${p.eliminated ? 1 : 0}`);
  }
  for (const id of sortedIds(state.units)) {
    const u = state.units[id];
    parts.push(`u${id}:${u.defId}:${u.owner},${u.x},${u.y},${u.hp},${u.cooldown},${u.kills},${u.rank}`
      + `,${u.capTicks},${u.capTargetId},${u.path ? u.path.length : -1},${u.pathI}`);
  }
  for (const id of sortedIds(state.structures)) {
    const s = state.structures[id];
    parts.push(`s${id}:${s.defId}:${s.owner},${s.cx},${s.cy},${s.hp}`);
  }
  for (const id of sortedIds(state.projectiles)) {
    const pr = state.projectiles[id];
    parts.push(`p${id}:${pr.owner},${pr.tx},${pr.ty},${pr.ticksLeft}`);
  }
  const str = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xffff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
