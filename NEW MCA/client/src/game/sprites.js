// Greybox visual mapping: unit class/domain -> canvas shape + short label.
import { isInfantryCls } from '../sim/index.js';

export function shapeForUnit(def) {
  if (def.domain === 'Air') return 'triangle';
  if (def.domain === 'Sea') return 'diamond';
  if (isInfantryCls(def.cls)) return 'circle';
  return 'square'; // vehicles, MCV, harvester
}

// structure silhouettes (v0.3): map by id first, then fall back to type.
// Same greybox language as units — silhouette + initials + owner color.
export function shapeForStructure(def) {
  switch (def.id) {
    case 'SH-01': return 'octagon';  // ConYard: biggest, unmistakable
    case 'SH-02': return 'hexagon';  // power plant
    case 'SH-03': return 'barrel';   // oil depot
    case 'SH-04': return 'chevron';  // barracks
    case 'SH-05': return 'rect';     // war factory
    case 'SH-06': return 'runway';   // airfield
    case 'SH-07': return 'dock';     // naval yard
    case 'SH-08': return 'diamond';  // tech
    case 'SH-09': return 'bunker';   // HMG nest
    case 'SH-10': return 'spike';    // ATGM tower
    case 'SH-11': return 'radar';    // AA gun
    default: break;
  }
  if (def.type === 'Def') return 'radar';    // faction SAM / ABM batteries
  if (def.type === 'Unique') return 'star';
  if (def.type === 'SW') return 'star-sw';
  return 'rect';
}

// up to 2 uppercase letters from the unit/structure name
export function initialsFor(name) {
  const words = String(name).replace(/[^A-Za-z0-9 -]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 0);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function factionColorOf(data, faction) {
  const f = data.factions[faction];
  return f ? f.color : '#888888';
}

export function ownerColorOf(state, owner) {
  if (owner < 0) return '#777777'; // neutral-inert
  const p = state.players[owner];
  return p ? factionColorOf(state.data, p.faction) : '#777777';
}
