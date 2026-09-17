// Economy: power, oil income, production queues (structures + units),
// superweapon charge. Progress is integer milli-progress so low-power
// slowdowns stay exact without floats in state.
// Note (v0.3.1): StartCredits / oil income knobs are intentionally left
// as-is per Grok's balance review — greybox-acceptable for now.
import { CELL, sortedIds, structCenter, addUnit, standingStructs } from './state.js';
import { findSpawnCell } from './orders.js';
import { defaultRallyCell } from './path.js';

function recomputePower(state) {
  for (const p of state.players) {
    if (p.eliminated) { p.powerOut = 0; p.powerUse = 0; p.lowPower = false; continue; }
    let out = 0, use = 0;
    for (const id of sortedIds(state.structures)) {
      const s = state.structures[id];
      if (s.owner !== p.slot) continue;
      const def = state.structDefs[s.defId];
      out += def.power_out;
      use += def.power_use;
    }
    p.powerOut = out;
    p.powerUse = use;
    p.lowPower = use > out;
  }
}

// per-tick progress in milli (1000 = one tick of work)
function progressRate(state, p) {
  let rate = p.lowPower ? Math.round(1000 * (1 - state.data.knobs.LowPowerPenalty)) : 1000;
  if (p.earlyBuild && state.tick < Math.round(p.earlyBuild.until_s * 10)) {
    rate += Math.round(rate * p.earlyBuild.value);
  }
  return rate;
}

export function productionSystem(state) {
  recomputePower(state);
  for (const p of state.players) {
    if (p.eliminated) continue;
    const rate = progressRate(state, p);

    // structure build queue (ConYard) — v0.3.2: pause the queue head while no
    // Construction Yard stands, so a dead CY actually stops production.
    // Progress is retained; rebuilding the CY resumes the same item.
    // Exception: the SH-01 rebuild item itself must progress without a CY,
    // otherwise a dead yard could never be rebuilt (self-deadlock).
    const hasCy = standingStructs(state, p.slot, (s) => s.defId === 'SH-01').length > 0;
    const head = p.buildQueue[0];
    if (head && (hasCy || head.structId === 'SH-01')) {
      head.progress += rate;
      if (head.progress >= head.total) {
        p.buildQueue.shift();
        p.ready.push(head.structId);
      }
    }

    // superweapon charge: ticks down only while a SW structure stands
    if (p.swChargeTicks > 0) {
      const hasSw = Object.values(state.structures)
        .some((s) => s.owner === p.slot && state.structDefs[s.defId].type === 'SW');
      if (hasSw) p.swChargeTicks--;
    }
  }

  // unit production queues (per producer structure)
  for (const id of sortedIds(state.structures)) {
    const s = state.structures[id];
    const p = state.players[s.owner];
    if (!p || p.eliminated || !s.queue.length) continue;
    const item = s.queue[0];
    if (item.progress < item.total) {
      let rate = progressRate(state, p);
      // Pakistan perk: named unit (e.g. JF-17) builds faster
      if (p.unitBuildSpeed
        && state.unitDefs[item.unitId].name.includes(p.unitBuildSpeed.unit_name)) {
        rate += Math.round(rate * p.unitBuildSpeed.value);
      }
      item.progress += rate;
      if (item.progress < item.total) continue;
    }
    // complete: spawn near the producer; retry next tick if blocked
    const def = state.unitDefs[item.unitId];
    const cell = findSpawnCell(state, s.owner, def, structCenter(s));
    if (cell) {
      const nu = addUnit(state, item.unitId, s.owner, cell.x, cell.y);
      p.unitsBuilt++;
      s.queue.shift();
      // rally (v0.3.2, sim-side so humans and AI share it): explicit rally
      // point from setRally, else the default 3-cells-toward-center rule
      const rally = state.rally[s.id] || defaultRallyCell(state, s);
      if (rally) {
        nu.order = { type: 'move', x: rally.x, y: rally.y, targetId: 0, enemyId: 0 };
      }
      // a retrained harvester binds to the first own depot that lost its one
      if (nu.defId === 'HARV') {
        const depots = standingStructs(state, p.slot, (d) => d.defId === 'SH-03'
          && !(state.units[d.harvesterId] && state.units[d.harvesterId].hp > 0));
        if (depots.length) depots[0].harvesterId = nu.id;
      }
    }
  }
}

export function economySystem(state) {
  const k = state.data.knobs;
  for (const p of state.players) {
    if (p.eliminated) continue;
    // oil: each depot whose bound harvester is alive and working the route
    // (near the depot or any oil field) yields OilIncomePerField cr/s
    let milli = 0;
    const nearR = 3 * CELL;
    for (const id of sortedIds(state.structures)) {
      const s = state.structures[id];
      if (s.owner !== p.slot || s.defId !== 'SH-03') continue;
      const hv = state.units[s.harvesterId];
      if (!hv || hv.hp <= 0) continue;
      const c = structCenter(s);
      let working = Math.abs(hv.x - c.x) <= nearR && Math.abs(hv.y - c.y) <= nearR;
      if (!working) {
        for (const o of Object.values(state.oilFields)) {
          if (Math.abs(hv.x - o.x) <= nearR && Math.abs(hv.y - o.y) <= nearR) {
            working = true;
            break;
          }
        }
      }
      if (!working) continue;
      milli += Math.round(k.OilIncomePerField * p.oilMult * p.aiEcoMult * 100);
    }
    if (milli > 0) {
      p.oilAcc += milli;
      p.credits += Math.floor(p.oilAcc / 1000);
      p.oilAcc %= 1000;
    }
  }
}
