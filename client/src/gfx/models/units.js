// Unit class -> builder registry.

import { buildTank, buildEscort } from './land.js';
import { buildAFV, buildLightVehicle, buildSPG, buildMLRS, buildMobileAA, buildTEL, buildMCV, buildHarvester } from './land2.js';

import { buildInfantry } from './infantry.js';

import { buildJet } from './air.js';

import { buildHelo, buildDrone } from './air2.js';

import { buildShip } from './naval.js';

const INF = new Set(['Infantry', 'AT infantry', 'AA infantry', 'SF', 'Engineer']);

export function unitKind(def) {
  const c = def.cls || '';
  if (INF.has(c)) return 'infantry';
  if (c === 'Fighter' || c === 'Strike jet') return 'jet';
  if (c === 'UAV') return 'drone';
  if (c === 'Attack helo' || c === 'Transport helo') return 'helo';
  if (c === 'Naval') return 'ship';
  if (def.domain === 'Air') return /helo|heli/i.test(c + ' ' + (def.name || '')) ? 'helo' : 'jet';
  if (def.domain === 'Sea') return 'ship';
  return 'vehicle';
}

function placeholder(M, def) {
  const g = M.part('hull');
  g.box(0, 0.3, 0, 1.2, 0.5, 0.7, { camo: 2 });
  g.box(0.3, 0.6, 0, 0.3, 0.1, 0.5, { c: M.ctx.pal.team });
  M.muzzle(0.7, 0.4, 0);
  return {};
}

export const UNIT_BUILDERS = {
  MBT: buildTank,
  'Light tank': buildTank,
  'Tank escort': buildEscort,
  IFV: buildAFV, APC: buildAFV, 'Light vehicle': buildLightVehicle, SPG: buildSPG, MLRS: buildMLRS,
  'Mobile AA': buildMobileAA, Missile: buildTEL, MCV: buildMCV, Harvester: buildHarvester,
  Infantry: buildInfantry, 'AT infantry': buildInfantry, 'AA infantry': buildInfantry, SF: buildInfantry, Engineer: buildInfantry,
  _vehicle: buildAFV, _infantry: buildInfantry, Fighter: buildJet, 'Strike jet': buildJet, _jet: buildJet, 'Attack helo': buildHelo, 'Transport helo': buildHelo, UAV: buildDrone, _helo: buildHelo, _drone: buildDrone, Naval: buildShip, _ship: buildShip,
};
