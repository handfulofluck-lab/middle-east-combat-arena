// Command validation + application. Every command a player (or the AI) can
// issue flows through applyCommand; invalid commands are dropped with a reason.
import {
  CELL, addUnit, addStructure, structCenter, isInfantryCls, hasTech,
  standingStructs, sortedIds, cellOf, clearPath,
} from './state.js';
import { fireSuperweapon, useFactionAbility } from './combat.js';

// ---- costs ---------------------------------------------------------------

export function trainCost(state, player, unitDef, producerDefId) {
  let cost = unitDef.cost;
  if (unitDef.id === 'HARV') cost = state.data.knobs.HarvesterCost;
  if (player.wfDiscount && producerDefId === 'SH-05') {
    cost = Math.round(cost * (1 - player.wfDiscount));
  }
  return cost;
}

export function buildCost(state, player, structDef) {
  if (structDef.id === 'SH-01') return Math.round(3500 * (1 - player.cyDiscount));
  return structDef.cost;
}

// ---- tech gates ----------------------------------------------------------

// producer structure id required to train this unit, or null if not trainable
export function requiredProducer(unitDef) {
  if (unitDef.id === 'MCV') return null;
  if (unitDef.id === 'HARV') return 'SH-05'; // retrainable from the War Factory
  if (unitDef.domain === 'Air') return 'SH-06';
  if (unitDef.domain === 'Sea') return 'SH-07';
  return isInfantryCls(unitDef.cls) ? 'SH-04' : 'SH-05';
}

export function trainGate(state, player, unitDef) {
  if (unitDef.faction !== 'All' && unitDef.faction !== player.faction) {
    return { ok: false, reason: 'wrong-faction' };
  }
  // tech gate: units flagged tech=1 (cost >= 1400, see export_data.py) need a
  // standing SH-08; the harvester stays exempt so economy recovery is always
  // possible. (wave is ship-batch metadata, not a gate — v0.3.1)
  const gated = unitDef.id !== 'HARV'
    && (unitDef.tech !== undefined ? unitDef.tech === 1 : unitDef.cost >= 1400);
  if (gated && !hasTech(state, player.slot)) {
    return { ok: false, reason: 'tech-gate' };
  }
  const prodId = requiredProducer(unitDef);
  if (!prodId) return { ok: false, reason: 'not-trainable' };
  const producer = standingStructs(state, player.slot, (s) => s.defId === prodId)
    .sort((a, b) => a.queue.length - b.queue.length)[0];
  if (!producer) return { ok: false, reason: 'no-producer', producer: null };
  return { ok: true, producer };
}

// ---- placement -----------------------------------------------------------

// max center distance (cells) from an owned Core/Prod structure for placement
export const BUILD_RADIUS = 10;

function terrainAt(state, cx, cy) {
  const { w, h, terrain } = state.map;
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return -1;
  return terrain[cy * w + cx];
}

function footprintFree(state, cx, cy, fp) {
  for (const id of sortedIds(state.structures)) {
    const s = state.structures[id];
    if (cx < s.cx + s.fp && cx + fp > s.cx && cy < s.cy + s.fp && cy + fp > s.cy) {
      return false;
    }
  }
  return true;
}

export function canPlace(state, slot, structDef, cx, cy) {
  const fp = structDef.fp;
  // terrain: all footprint cells open
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      if (terrainAt(state, cx + dx, cy + dy) !== 0) return false;
    }
  }
  if (!footprintFree(state, cx, cy, fp)) return false;
  // naval yard needs adjacent water
  if (structDef.id === 'SH-07') {
    let water = false;
    for (let dy = -1; dy <= fp && !water; dy++) {
      for (let dx = -1; dx <= fp && !water; dx++) {
        if (terrainAt(state, cx + dx, cy + dy) === 2) water = true;
      }
    }
    if (!water) return false;
  }
  // within BUILD_RADIUS cells of an owned structure (center distance).
  // Core/Prod anchors normally; a ConYard rebuild (SH-01) accepts ANY owned
  // structure — and with none standing at all, skips proximity entirely
  // (deploy rules: open terrain is enough), so the rebuild window's
  // credits clause is actually usable.
  const anchors = standingStructs(state, slot, (s) => {
    if (structDef.id === 'SH-01') return true;
    const t = state.structDefs[s.defId].type;
    return t === 'Core' || t === 'Prod';
  });
  if (structDef.id === 'SH-01' && !anchors.length) return true;
  const near = anchors.some((s) => {
    const a = structCenter({ cx, cy, fp });
    const b = structCenter(s);
    const dx = Math.abs(a.x - b.x) / CELL;
    const dy = Math.abs(a.y - b.y) / CELL;
    return Math.max(dx, dy) <= BUILD_RADIUS;
  });
  if (!near) return false;
  // oil depot must sit within 4 cells of an oil field
  if (structDef.id === 'SH-03') {
    const c = structCenter({ cx, cy, fp });
    const ok = Object.values(state.oilFields).some((o) => {
      const dx = Math.abs(o.x - c.x) / CELL;
      const dy = Math.abs(o.y - c.y) / CELL;
      return Math.max(dx, dy) <= 4 + fp / 2;
    });
    if (!ok) return false;
  }
  return true;
}

// spiral search for a legal placement near (cx, cy); used by AI and tests
export function findPlacement(state, slot, structDef, cx, cy, maxR) {
  for (let r = 0; r <= (maxR || 10); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (canPlace(state, slot, structDef, cx + dx, cy + dy)) {
          return { x: cx + dx, y: cy + dy };
        }
      }
    }
  }
  return null;
}

// depot placement: legal cell within 4 cells of any oil field
export function findDepotPlacement(state, slot, structDef) {
  for (const o of Object.values(state.oilFields)) {
    const ox = cellOf(o.x), oy = cellOf(o.y);
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (canPlace(state, slot, structDef, ox + dx, oy + dy)) {
          return { x: ox + dx, y: oy + dy };
        }
      }
    }
  }
  return null;
}

// open spawn cell for a freshly produced unit. Ring search around the
// producer, center-facing side first (the far side still gets searched when
// the ring runs into the map border). Cells must be truly enterable: right
// terrain and outside every structure footprint (v0.3.1 — used to check
// terrain only, spawning units inside buildings / on the rim).
export function findSpawnCell(state, slot, unitDef, nearWu) {
  const cx0 = cellOf(nearWu.x), cy0 = cellOf(nearWu.y);
  const want = unitDef.domain === 'Sea' ? 2 : 0;
  const air = unitDef.domain === 'Air';
  const dirX = state.map.w / 2 >= cx0 ? 1 : -1; // toward map center
  const dirY = state.map.h / 2 >= cy0 ? 1 : -1;
  // v0.3.3: start at r=1 so a sea unit can spawn in the water cell adjacent
  // to the naval yard (footprintFree already rejects in-structure cells).
  for (let r = 1; r <= 12; r++) {
    const ring = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        ring.push([dx, dy]);
      }
    }
    // deterministic: center-facing cells first, then by position
    ring.sort((a, b) => (b[0] * dirX + b[1] * dirY) - (a[0] * dirX + a[1] * dirY)
      || a[1] - b[1] || a[0] - b[0]);
    for (const [dx, dy] of ring) {
      const cx = cx0 + dx, cy = cy0 + dy;
      const t = terrainAt(state, cx, cy);
      if (air ? t < 0 : t !== want) continue;
      if (!footprintFree(state, cx, cy, 1)) continue;
      return { x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 };
    }
  }
  return null;
}

// ---- validation + application ---------------------------------------------

// faction abilities that require a standing Unique/SW structure (greybox gate)
export const ABILITY_STRUCT = {
  saka_insertion: 'SH-12',   // Egypt: Sa'ka Tent
  shahed_rain: 'SH-33',      // Iran: Shahed SW
  brahmos_lane: 'SH-29',     // India: BrahMos SW
  rsaf_tasking: 'SH-15',     // Saudi: RSAF SW
  babur_window: 'SH-32',     // Pakistan: Babur SW
};

export function validateCommand(state, cmd) {
  const p = state.players[cmd.player];
  if (!p || p.eliminated || state.over) return { ok: false, reason: 'player-inactive' };
  switch (cmd.type) {
    case 'move':
    case 'attackMove':
    case 'stop':
    case 'attackTarget': {
      const units = (cmd.unitIds || []).map((id) => state.units[id])
        .filter((u) => u && u.owner === p.slot);
      if (!units.length) return { ok: false, reason: 'no-units' };
      if (cmd.type === 'attackTarget') {
        const t = state.units[cmd.targetId] || state.structures[cmd.targetId];
        if (!t) return { ok: false, reason: 'bad-target' };
      }
      return { ok: true };
    }
    case 'setRally': {
      const s = state.structures[cmd.structId];
      if (!s || s.owner !== p.slot) return { ok: false, reason: 'not-owned' };
      if (state.structDefs[s.defId].type !== 'Prod') return { ok: false, reason: 'not-producer' };
      return { ok: true };
    }
    case 'deployMCV': {
      const u = state.units[cmd.unitId];
      if (!u || u.owner !== p.slot || u.defId !== 'MCV') return { ok: false, reason: 'no-mcv' };
      // one ConYard per player: with one standing, the MCV stays a unit
      if (standingStructs(state, p.slot, (s) => s.defId === 'SH-01').length) {
        return { ok: false, reason: 'cy-exists' };
      }
      return { ok: true };
    }
    case 'buildStructure': {
      const def = state.structDefs[cmd.structId];
      if (!def) return { ok: false, reason: 'bad-structure' };
      if (def.faction !== 'All' && def.faction !== p.faction) return { ok: false, reason: 'wrong-faction' };
      if (def.id === 'SH-01') {
        // ConYard rebuild: only with none standing, no living MCV, once
        if (standingStructs(state, p.slot, (s) => s.defId === 'SH-01').length) {
          return { ok: false, reason: 'cy-exists' };
        }
        const hasMcv = Object.values(state.units)
          .some((u) => u.owner === p.slot && u.defId === 'MCV');
        if (hasMcv) return { ok: false, reason: 'mcv-alive' };
        if (p.cyRebuilt) return { ok: false, reason: 'cy-rebuild-used' };
      } else if (!standingStructs(state, p.slot, (s) => s.defId === 'SH-01').length) {
        return { ok: false, reason: 'no-conyard' };
      }
      const cost = buildCost(state, p, def);
      if (p.credits < cost) return { ok: false, reason: 'credits' };
      return { ok: true };
    }
    case 'placeStructure': {
      const def = state.structDefs[cmd.structId];
      if (!def) return { ok: false, reason: 'bad-structure' };
      if (!p.ready.includes(cmd.structId)) return { ok: false, reason: 'not-ready' };
      if (!canPlace(state, p.slot, def, cmd.cx, cmd.cy)) return { ok: false, reason: 'illegal-placement' };
      return { ok: true };
    }
    case 'trainUnit': {
      const def = state.unitDefs[cmd.unitId];
      if (!def) return { ok: false, reason: 'bad-unit' };
      const gate = trainGate(state, p, def);
      if (!gate.ok) return gate;
      const cost = trainCost(state, p, def, gate.producer.defId);
      if (p.credits < cost) return { ok: false, reason: 'credits' };
      return { ok: true };
    }
    case 'cancelProduction': {
      if (cmd.kind === 'struct') {
        const i = p.buildQueue.map((q) => q.structId).lastIndexOf(cmd.structId);
        if (i < 0) return { ok: false, reason: 'not-queued' };
        return { ok: true };
      }
      if (cmd.kind === 'unit') {
        const s = state.structures[cmd.producerId];
        if (!s || s.owner !== p.slot) return { ok: false, reason: 'no-producer' };
        const i = s.queue.map((q) => q.unitId).lastIndexOf(cmd.unitId);
        if (i < 0) return { ok: false, reason: 'not-queued' };
        return { ok: true };
      }
      return { ok: false, reason: 'bad-kind' };
    }
    case 'useSuperweapon': {
      const sw = standingStructs(state, p.slot, (s) => state.structDefs[s.defId].type === 'SW');
      if (!sw.length) return { ok: false, reason: 'no-sw' };
      if (p.swChargeTicks !== 0) return { ok: false, reason: 'sw-charging' };
      return { ok: true };
    }
    case 'useFactionAbility': {
      const ability = state.data.factions[p.faction].ability;
      const passive = ['edge_network', 'integrated_sky', 'siha_mesh', 'iron_layer'];
      if (passive.includes(ability)) return { ok: false, reason: 'passive' };
      if (state.tick < p.abilityCdUntil) return { ok: false, reason: 'cooldown' };
      const gateId = ABILITY_STRUCT[ability];
      if (gateId && !standingStructs(state, p.slot, (s) => s.defId === gateId).length) {
        return { ok: false, reason: 'no-unique' };
      }
      if (ability === 'saka_insertion') {
        const i = cellOf(cmd.y) * state.map.w + cellOf(cmd.x);
        if (!state.fog[p.slot].visible[i]) return { ok: false, reason: 'not-visible' };
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unknown-command' };
  }
}

export function applyCommand(state, cmd) {
  const v = validateCommand(state, cmd);
  if (!v.ok) return v;
  const p = state.players[cmd.player];
  switch (cmd.type) {
    case 'move':
    case 'attackMove': {
      for (const id of cmd.unitIds) {
        const u = state.units[id];
        if (!u || u.owner !== p.slot) continue;
        u.order = { type: cmd.type, x: Math.round(cmd.x), y: Math.round(cmd.y), targetId: 0, enemyId: 0 };
        clearPath(u); // new destination -> fresh path next tick
      }
      return { ok: true };
    }
    case 'stop': {
      for (const id of cmd.unitIds) {
        const u = state.units[id];
        if (!u || u.owner !== p.slot) continue;
        u.order = { type: 'idle', x: 0, y: 0, targetId: 0, enemyId: 0 };
        clearPath(u);
      }
      return { ok: true };
    }
    case 'attackTarget': {
      for (const id of cmd.unitIds) {
        const u = state.units[id];
        if (!u || u.owner !== p.slot) continue;
        u.order = { type: 'attackTarget', x: 0, y: 0, targetId: cmd.targetId, enemyId: 0 };
        clearPath(u);
      }
      return { ok: true };
    }
    case 'setRally': {
      const s = state.structures[cmd.structId];
      if (!s || s.owner !== p.slot) return { ok: false, reason: 'not-owned' };
      const maxX = state.map.w * CELL - 1, maxY = state.map.h * CELL - 1;
      state.rally[s.id] = {
        x: Math.max(0, Math.min(maxX, Math.round(cmd.x))),
        y: Math.max(0, Math.min(maxY, Math.round(cmd.y))),
      };
      return { ok: true };
    }
    case 'deployMCV': {
      const u = state.units[cmd.unitId];
      const def = state.structDefs['SH-01'];
      const cx = cellOf(u.x) - 1, cy = cellOf(u.y) - 1;
      // v0.3.4: exact spot first, then spiral-search nearby cells so a rock
      // or water tile under the MCV no longer silently blocks the deploy.
      let spot = null;
      if (canDeployAt(state, def, cx, cy)) {
        spot = { x: cx, y: cy };
      } else {
        for (let r = 1; r <= 5 && !spot; r++) {
          for (let dy = -r; dy <= r && !spot; dy++) {
            for (let dx = -r; dx <= r && !spot; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              if (canDeployAt(state, def, cx + dx, cy + dy)) {
                spot = { x: cx + dx, y: cy + dy };
              }
            }
          }
        }
      }
      if (!spot) {
        // nudge the HUD so the player learns something went wrong
        p._deployFailTick = state.tick;
        return { ok: false, reason: 'illegal-placement' };
      }
      delete state.units[u.id];
      addStructure(state, 'SH-01', p.slot, spot.x, spot.y);
      return { ok: true };
    }
    case 'buildStructure': {
      const def = state.structDefs[cmd.structId];
      p.credits -= buildCost(state, p, def);
      p.buildQueue.push({ structId: def.id, progress: 0, total: def.buildTicks * 1000 });
      return { ok: true };
    }
    case 'placeStructure': {
      const def = state.structDefs[cmd.structId];
      p.ready.splice(p.ready.indexOf(cmd.structId), 1);
      const s = addStructure(state, cmd.structId, p.slot, cmd.cx, cmd.cy);
      if (def.id === 'SH-01') p.cyRebuilt = true;
      if (def.type === 'SW' && p.swChargeTicks < 0) p.swChargeTicks = 3000; // 300s charge
      if (def.id === 'SH-03') {
        // greybox: harvester bundled with the depot
        const c = structCenter(s);
        const cell = findSpawnCell(state, p.slot, state.unitDefs.HARV, c);
        if (cell) {
          const hv = addUnit(state, 'HARV', p.slot, cell.x, cell.y);
          s.harvesterId = hv.id;
        }
      }
      return { ok: true };
    }
    case 'trainUnit': {
      const def = state.unitDefs[cmd.unitId];
      const gate = trainGate(state, p, def);
      p.credits -= trainCost(state, p, def, gate.producer.defId);
      gate.producer.queue.push({ unitId: def.id, progress: 0, total: def.buildTicks * 1000 });
      return { ok: true };
    }
    case 'cancelProduction': {
      // tail-cancel (newest matching entry), full refund
      if (cmd.kind === 'struct') {
        const i = p.buildQueue.map((q) => q.structId).lastIndexOf(cmd.structId);
        const def = state.structDefs[cmd.structId];
        p.buildQueue.splice(i, 1);
        p.credits += buildCost(state, p, def);
        return { ok: true };
      }
      const s = state.structures[cmd.producerId];
      const i = s.queue.map((q) => q.unitId).lastIndexOf(cmd.unitId);
      const def = state.unitDefs[cmd.unitId];
      s.queue.splice(i, 1);
      p.credits += trainCost(state, p, def, s.defId);
      return { ok: true };
    }
    case 'useSuperweapon': {
      p.swChargeTicks = 3000;
      fireSuperweapon(state, p, Math.round(cmd.x), Math.round(cmd.y));
      return { ok: true };
    }
    case 'useFactionAbility': {
      p.abilityCdUntil = state.tick + 900; // 90s
      useFactionAbility(state, p, Math.round(cmd.x), Math.round(cmd.y));
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unknown-command' };
  }
}

// MCV deploy: footprint must be open and free, no proximity requirement
function canDeployAt(state, def, cx, cy) {
  const fp = def.fp;
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      if (terrainAt(state, cx + dx, cy + dy) !== 0) return false;
    }
  }
  return footprintFree(state, cx, cy, fp);
}
