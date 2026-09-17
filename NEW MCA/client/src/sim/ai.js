// AI controller. Produces the exact same command objects a player would;
// decisions use a private RNG stream so the sim RNG stays replay-stable.
import { createRng } from './rng.js';
import {
  CELL, standingStructs, structCenter, sortedIds, isInfantryCls, isHostile,
  hasTech, mapHasWater,
} from './state.js';
import { findPlacement, findDepotPlacement, validateCommand, canPlace, trainCost, requiredProducer } from './orders.js';

const INTERVALS = { recruit: 90, veteran: 60, elite: 40, marshal: 25 }; // apm
const WAVE_BASE = 600;   // ~60s
const WAVE_SPREAD = 300; // up to ~90s
const WAVE_SIZE = { front: 6, sky: 4, raid: 3, fortress: 10 };

export function createAI(playerCfgs, seed) {
  const brains = [];
  playerCfgs.forEach((cfg, i) => {
    if (!cfg.ai) return;
    const slot = cfg.slot !== undefined ? cfg.slot : i;
    brains.push({
      slot,
      personality: (cfg.ai.personality || 'front').toLowerCase(),
      interval: INTERVALS[cfg.ai.difficulty || 'recruit'] || 90,
      nextThink: 10,
      waveNext: WAVE_BASE,
      rng: createRng(((seed >>> 0) ^ Math.imul(slot + 1, 0x9e3779b9)) >>> 0),
    });
  });
  return { brains };
}

export function aiCommands(state, ai) {
  const cmds = [];
  for (const b of ai.brains) {
    const p = state.players[b.slot];
    if (!p || p.eliminated || state.over) continue;
    if (state.tick < b.nextThink) continue;
    b.nextThink = state.tick + b.interval;
    think(state, b, p, cmds);
  }
  return cmds;
}

function think(state, b, p, cmds) {
  const data = state.data;
  const myStructs = standingStructs(state, p.slot);
  const hasOrQueued = (id) =>
    myStructs.some((s) => s.defId === id)
    || p.buildQueue.some((q) => q.structId === id)
    || p.ready.includes(id);

  // 1. deploy the starting MCV
  const mcv = Object.values(state.units)
    .find((u) => u.owner === p.slot && u.defId === 'MCV');
  if (mcv) {
    cmds.push({ player: p.slot, type: 'deployMCV', unitId: mcv.id });
    return;
  }
  const conyard = myStructs.find((s) => s.defId === 'SH-01');
  if (!conyard) {
    // ConYard lost: rebuild it through the same path humans use (no standing
    // CY, no living MCV, rebuild not yet used, credits for it). The rebuild
    // window in eliminationSystem keeps the AI alive for this.
    const hasMcv = Object.values(state.units)
      .some((u) => u.owner === p.slot && u.defId === 'MCV');
    if (!hasMcv && !p.cyRebuilt) {
      if (p.ready.includes('SH-01')) {
        // v0.3.3: two anchor cases.
        // 1) myStructs.length > 0: place near a Core/Prod anchor.
        // 2) myStructs.length === 0: rules permit a free placement
        //    (canPlace returns true with no anchors for SH-01), so place
        //    near the player's spawn instead of re-queuing a second SH-01.
        let spot = null;
        if (myStructs.length) {
          const anchorS = myStructs.find((s) => {
            const t = state.structDefs[s.defId].type;
            return t === 'Core' || t === 'Prod';
          }) || myStructs[0];
          const a0 = structCenter(anchorS);
          spot = findPlacement(state, p.slot, state.structDefs['SH-01'],
            Math.floor(a0.x / CELL), Math.floor(a0.y / CELL), 10);
        } else {
          const sp = state.map.spawns[p.slot % state.map.spawns.length];
          spot = findPlacement(state, p.slot, state.structDefs['SH-01'],
            sp.x, sp.y, 15);
        }
        if (spot) {
          cmds.push({ player: p.slot, type: 'placeStructure', structId: 'SH-01',
            cx: spot.x, cy: spot.y });
        }
      } else if (!p.buildQueue.some((q) => q.structId === 'SH-01')) {
        const cmd = { player: p.slot, type: 'buildStructure', structId: 'SH-01' };
        if (validateCommand(state, cmd).ok) cmds.push(cmd);
      }
    }
    return;
  }

  const anchor = structCenter(conyard);
  const anchorCell = { x: Math.floor(anchor.x / CELL), y: Math.floor(anchor.y / CELL) };

  // 2. place whatever is ready
  if (p.ready.length) {
    const id = p.ready[0];
    const def = state.structDefs[id];
    const spot = id === 'SH-03'
      ? (findDepotSpot(state, p.slot, def) || findDepotPlacement(state, p.slot, def))
      : findPlacement(state, p.slot, def, anchorCell.x, anchorCell.y, 10);
    if (spot) cmds.push({ player: p.slot, type: 'placeStructure', structId: id, cx: spot.x, cy: spot.y });
    return;
  }

  // 2b. defense: hostiles near the base get engaged off the wave timer
  const threat = Object.values(state.units).find((u) => {
    if (!isHostile(state, p.slot, u) || u.hp <= 0) return false;
    return myStructs.some((s) => {
      const t = state.structDefs[s.defId].type;
      if (t !== 'Core' && t !== 'Prod') return false;
      const c = structCenter(s);
      return Math.max(Math.abs(c.x - u.x), Math.abs(c.y - u.y)) <= 12 * CELL;
    });
  });
  if (threat) {
    const defenders = Object.values(state.units).filter((u) => {
      if (u.owner !== p.slot || u.defId === 'MCV' || u.defId === 'HARV') return false;
      if (u.order.type !== 'idle') return false;
      const d = state.unitDefs[u.defId];
      return d.dmg.inf + d.dmg.light + d.dmg.armor + d.dmg.air + d.dmg.bldg > 0;
    });
    if (defenders.length) {
      cmds.push({
        player: p.slot, type: 'attackMove',
        unitIds: defenders.map((u) => u.id), x: threat.x, y: threat.y,
      });
    }
  }

  // 3. next building in the build order
  if (!p.buildQueue.length) {
    const order = ['SH-02', 'SH-03', 'SH-04', 'SH-05'];
    if (b.personality === 'sky') order.push('SH-06', 'SH-11');
    order.push('SH-08');
    // naval on wet maps (v0.3.2): yard after tech, then ships from it
    if (mapHasWater(state)) order.push('SH-07');
    if (b.personality === 'fortress') {
      const def = data.structures.find((s) => s.type === 'Def' && s.faction === p.faction);
      const sw = data.structures.find((s) => s.type === 'SW' && s.faction === p.faction);
      if (def) order.push(def.id, def.id);
      order.push('SH-09', 'SH-10', 'SH-11');
      if (sw) order.push(sw.id);
    }
    order.push('SH-02'); // headroom
    let next = order.find((id) => !hasOrQueued(id));
    if (p.lowPower && !p.buildQueue.some((q) => q.structId === 'SH-02')
        && !p.ready.includes('SH-02')) {
      next = 'SH-02';
    }
    if (next === 'SH-07'
        && !findPlacement(state, p.slot, state.structDefs['SH-07'],
          anchorCell.x, anchorCell.y, 10)) {
      next = null; // no legal water-adjacent spot near the base — skip
    }
    if (next) {
      const cmd = { player: p.slot, type: 'buildStructure', structId: next };
      if (validateCommand(state, cmd).ok) { cmds.push(cmd); return; }
    }
    // 3b. expand to a second oil field once the order is underway
    const depots = myStructs.filter((s) => s.defId === 'SH-03').length
      + p.ready.filter((id) => id === 'SH-03').length;
    if (depots < 2) {
      const cmd = { player: p.slot, type: 'buildStructure', structId: 'SH-03' };
      if (validateCommand(state, cmd).ok
          && findDepotSpot(state, p.slot, state.structDefs['SH-03'])) {
        cmds.push(cmd);
        return;
      }
    }
  }

  // 3c. retrain a dead harvester (depot income stops without one)
  const deadDepot = myStructs.find((s) => s.defId === 'SH-03'
    && !(state.units[s.harvesterId] && state.units[s.harvesterId].hp > 0));
  if (deadDepot) {
    const hvDef = state.unitDefs.HARV;
    if (p.credits >= trainCost(state, p, hvDef, 'SH-05')) {
      const cmd = { player: p.slot, type: 'trainUnit', unitId: 'HARV' };
      if (validateCommand(state, cmd).ok) cmds.push(cmd);
    }
  }

  // 4. train units (one attempt per think per personality pick)
  if (p.credits >= 300) {
    const unitId = pickUnit(state, b, p);
    if (unitId) {
      const cmd = { player: p.slot, type: 'trainUnit', unitId };
      if (validateCommand(state, cmd).ok) cmds.push(cmd);
    }
  }

  // 5. attack waves every ~60-90s at the nearest enemy base; the two cheapest
  // combat units always stay home on guard
  if (state.tick >= b.waveNext) {
    b.waveNext = state.tick + WAVE_BASE + b.rng.int(WAVE_SPREAD + 1);
    const army = Object.values(state.units).filter((u) => {
      if (u.owner !== p.slot || u.defId === 'MCV' || u.defId === 'HARV') return false;
      const d = state.unitDefs[u.defId];
      return d.dmg.inf + d.dmg.light + d.dmg.armor + d.dmg.air + d.dmg.bldg > 0;
    }).sort((a, z) => state.unitDefs[a.defId].cost - state.unitDefs[z.defId].cost);
    const wave = army.slice(2);
    const need = WAVE_SIZE[b.personality] || 6;
    if (wave.length >= need) {
      const t = enemyBaseTarget(state, p, anchor);
      if (t) {
        cmds.push({
          player: p.slot, type: 'attackMove',
          unitIds: wave.map((u) => u.id), x: t.x, y: t.y,
        });
      }
    }
  }

  // 6. superweapon + targeted faction ability when available
  const t = enemyBaseTarget(state, p, anchor);
  if (t) {
    const sw = { player: p.slot, type: 'useSuperweapon', x: t.x, y: t.y };
    if (validateCommand(state, sw).ok) cmds.push(sw);
    const ab = { player: p.slot, type: 'useFactionAbility', x: t.x, y: t.y };
    if (validateCommand(state, ab).ok) cmds.push(ab);
  }
}

function pickUnit(state, b, p) {
  // explicit tech gate (v0.3.2): until SH-08 stands, only tech-0 units
  const t0only = !hasTech(state, p.slot);
  // v0.3.3: restrict to units whose required producer is currently standing,
  // so the AI never queues air with no airfield / armor with no war factory.
  // validateCommand used to silently drop those commands and starve the bot.
  const producers = new Set();
  for (const s of standingStructs(state, p.slot)) {
    if (state.structDefs[s.defId].type === 'Prod') producers.add(s.defId);
  }
  const mine = state.data.units.filter((u) => {
    if (u.faction !== p.faction) return false;
    if (t0only && !(u.tech !== undefined ? u.tech === 0 : u.cost < 1400)) return false;
    const rp = requiredProducer(u);
    if (rp === null) return false;
    return producers.has(rp);
  });
  const byCost = (a, z) => a.cost - z.cost;
  const inf = mine.filter((u) => u.cls === 'Infantry').sort(byCost);
  const veh = mine.filter((u) => u.domain === 'Land' && !isInfantryCls(u.cls) && u.cost < 1400).sort(byCost);
  const mbt = mine.filter((u) => u.cls === 'MBT').sort(byCost);
  const air = mine.filter((u) => u.domain === 'Air' && u.rof_s > 0).sort(byCost);
  const raider = mine.filter((u) => ['Light vehicle', 'IFV', 'APC'].includes(u.cls)).sort(byCost);
  const aa = mine.filter((u) => u.cls === 'Mobile AA').sort(byCost);
  const sea = mine.filter((u) => u.domain === 'Sea' && u.rof_s > 0).sort(byCost);
  const navalYard = standingStructs(state, p.slot, (s) => s.defId === 'SH-07').length > 0;
  const pick = (arr) => (arr.length ? arr[b.rng.int(arr.length)].id : null);
  // with a yard standing, every fourth pick goes naval (when the faction has ships)
  if (navalYard && sea.length && b.rng.int(4) === 0) return pick(sea);
  switch (b.personality) {
    case 'sky':
      if (b.rng.int(3) === 0) return pick(aa) || pick(air) || pick(veh) || pick(inf);
      return pick(air) || pick(veh) || pick(inf);
    case 'raid':
      return pick(raider) || pick(veh) || pick(inf);
    case 'fortress':
      return b.rng.int(2) ? pick(inf) : (pick(aa) || pick(inf));
    case 'front':
    default: {
      const r = b.rng.int(4);
      if (r === 0) return pick(mbt) || pick(veh) || pick(inf);
      if (r === 1) return pick(veh) || pick(inf);
      return pick(inf) || pick(veh);
    }
  }
}

// oil expansion: legal depot spot near a field we do not already serve
// (any own depot within 5 cells of the field counts as serving it)
function findDepotSpot(state, slot, def) {
  for (const o of Object.values(state.oilFields)) {
    const served = standingStructs(state, slot, (s) => s.defId === 'SH-03')
      .some((s) => {
        const c = structCenter(s);
        return Math.max(Math.abs(c.x - o.x), Math.abs(c.y - o.y)) <= 5 * CELL;
      });
    if (served) continue;
    const ox = Math.floor(o.x / CELL), oy = Math.floor(o.y / CELL);
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (canPlace(state, slot, def, ox + dx, oy + dy)) return { x: ox + dx, y: oy + dy };
      }
    }
  }
  return null;
}

function enemyBaseTarget(state, p, from) {
  let best = null, bestD = Infinity;
  for (const id of sortedIds(state.structures)) {
    const s = state.structures[id];
    if (!isHostile(state, p.slot, s)) continue;
    const c = structCenter(s);
    const d = (c.x - from.x) ** 2 + (c.y - from.y) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best) return best;
  // fallback: nearest enemy spawn point
  for (const q of state.players) {
    if (q.eliminated || q.team === p.team) continue;
    const sp = state.map.spawns[q.slot % state.map.spawns.length];
    const c = { x: sp.x * CELL + CELL / 2, y: sp.y * CELL + CELL / 2 };
    const d = (c.x - from.x) ** 2 + (c.y - from.y) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
