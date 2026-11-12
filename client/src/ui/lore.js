// Presentation copy: faction dossiers, ability / superweapon / interception
// descriptions, menu tips and the controls reference. Numbers are derived
// from game.json wherever the sheet carries them so the text cannot drift
// from the simulation; only the flavour sentences are authored here.
import { titleCase } from './dom.js';

export const PASSIVE_ABILITIES = ['edge_network', 'integrated_sky', 'siha_mesh', 'iron_layer'];
// active abilities gated behind a standing structure (mirrors sim ABILITY_STRUCT)
export const ABILITY_GATE = {
  saka_insertion: 'SH-12',
  shahed_rain: 'SH-33',
  brahmos_lane: 'SH-29',
  rsaf_tasking: 'SH-15',
  babur_window: 'SH-32',
};

const FACTION_LORE = {
  Egypt: {
    doctrine: 'Combined-arms depth',
    blurb: 'A broad, balanced order of battle with an answer for every threat — and commandos who arrive where the enemy is thinnest.',
  },
  Saudi: {
    doctrine: 'Altitude and quality',
    blurb: 'Fewer units, better units. Oil wealth buys premium airframes and stand-off strikes that never ask permission.',
  },
  UAE: {
    doctrine: 'Scalpel precision',
    blurb: 'A compact, networked force that sees first, builds fast and spends exactly one shot per target.',
  },
  Algeria: {
    doctrine: 'Weight under a bubble',
    blurb: 'Cheap heavy armour grinding forward beneath one of the densest air-defence umbrellas in the arena.',
  },
  Turkey: {
    doctrine: 'The drone mesh',
    blurb: 'Unmanned eyes over every ridge. Loitering aircraft knit the battlefield into a single kill web.',
  },
  Israel: {
    doctrine: 'Shield and knife',
    blurb: 'Layered missile defence over a small, razor-sharp strike force. Expensive to hit, worse to be hit by.',
  },
  India: {
    doctrine: 'Scale and reach',
    blurb: 'Mass on the ground, supersonic cruise missiles overhead. Build wide, then cut a lane straight through.',
  },
  Pakistan: {
    doctrine: 'First strike',
    blurb: 'Fast-built fighters and cruise salvos open a window early. Win the first exchange and never give it back.',
  },
  Iran: {
    doctrine: 'Swarm and rain',
    blurb: 'Quantity is the strategy. Loitering munitions and ballistic volleys arrive faster than any shield can count.',
  },
};

const ABILITY_TEXT = {
  saka_insertion: { name: 'Sa\'ka Insertion', text: 'Helicopter-drops four rifle squads onto open ground at the target point.' },
  rsaf_tasking: { name: 'RSAF Tasking', text: 'Calls a precision air strike on the target. Cannot be intercepted.' },
  brahmos_lane: { name: 'BrahMos Lane', text: 'Carves a 12-cell corridor of heavy damage, starting at the target and running away from your base.' },
  babur_window: { name: 'Babur Window', text: 'Two cruise missiles converge on the target. Enemy interceptors may stop them.' },
  shahed_rain: { name: 'Shahed Rain', text: 'Launches five loitering drones that hunt toward the target point.' },
  edge_network: { name: 'Edge Network', text: 'Every unit sees two cells further. Always on.' },
  integrated_sky: { name: 'Integrated Sky', text: 'All of your weapons deal 20% more damage to aircraft. Always on.' },
  siha_mesh: { name: 'SİHA Mesh', text: 'Your forces acquire airborne targets 20% further out. Always on.' },
  iron_layer: { name: 'Iron Layer', text: 'Trophy-equipped armour negates the first anti-tank missile volley it takes, then recharges.' },
};

const INTERCEPT_NAME = {
  InterceptDome: 'Iron Dome layer',
  InterceptS400: 'S-400 umbrella',
  InterceptPatriot: 'Patriot umbrella',
  InterceptSiper: 'Siper umbrella',
  InterceptBavar: 'Bavar-373 umbrella',
};

export function factionLore(fname) {
  return FACTION_LORE[fname] || { doctrine: '', blurb: '' };
}

// Economic perk as a short phrase ('' when the faction has none).
export function perkText(f) {
  const pk = f && f.econPerk;
  if (!pk) return '';
  const pct = Math.round(Math.abs(pk.value) * 100);
  switch (pk.type) {
    case 'cheap_cy_rebuild': return '−' + pct + '% Construction Yard rebuild cost';
    case 'oil_income_mult': return '+' + Math.round((pk.value - 1) * 100) + '% oil income';
    case 'early_build_speed':
      return '+' + pct + '% build speed for the first ' + Math.round(pk.until_s / 60) + ' minutes';
    case 'war_factory_discount': return '−' + pct + '% vehicle cost';
    case 'unit_build_speed': return '+' + pct + '% ' + pk.unit_name + ' build speed';
    default: return titleCase(pk.type);
  }
}

function structByIdOf(data, id) {
  for (const s of data.structures) if (s.id === id) return s;
  return null;
}

export function abilityInfo(data, fname) {
  const f = data.factions[fname];
  if (!f || !f.ability) return null;
  const id = f.ability;
  const t = ABILITY_TEXT[id] || { name: titleCase(id), text: '' };
  const passive = PASSIVE_ABILITIES.includes(id);
  const gateId = ABILITY_GATE[id] || null;
  const gate = gateId ? structByIdOf(data, gateId) : null;
  return {
    id, name: t.name, text: t.text, passive,
    gateId, gateName: gate ? gate.name : null,
    cooldownS: passive ? 0 : 90,
  };
}

// payload mirrors sim/combat.js fireSuperweapon
function swPayload(structId) {
  if (structId === 'SH-19' || structId === 'SH-35') return { count: 10, dmg: 250, radius: 3, style: 'Saturation barrage' };
  if (structId === 'SH-15' || structId === 'SH-17') return { count: 3, dmg: 700, radius: 3, style: 'Precision package' };
  return { count: 6, dmg: 400, radius: 5, style: 'Heavy strike' };
}

export function superweaponInfo(data, fname) {
  let def = null;
  for (const s of data.structures) {
    if (s.type === 'SW' && s.faction === fname) { def = s; break; }
  }
  if (!def) return null;
  const p = swPayload(def.id);
  return {
    id: def.id, name: def.name, payloadName: def.unlocks || '', cost: def.cost,
    count: p.count, dmg: p.dmg, radius: p.radius, style: p.style, chargeS: 300,
    text: p.style + ': ' + p.count + ' warheads, ' + p.dmg + ' damage each across a '
      + p.radius + '-cell blast. 5:00 charge.',
  };
}

export function interceptInfo(data, fname) {
  const f = data.factions[fname];
  const knob = f ? f.superweaponIntercept : null;
  if (!knob) {
    return { has: false, name: 'No strategic interceptor',
      text: 'Incoming superweapons always land. Disperse, harden and strike first.' };
  }
  const chance = Math.round((data.knobs[knob] || 0) * 100);
  return {
    has: true, chance, name: INTERCEPT_NAME[knob] || titleCase(knob.replace('Intercept', '')),
    text: chance + '% chance to stop each incoming superweapon warhead that lands within 12 cells of one of your defensive structures.',
  };
}

// the handful of units that sell a faction on its picker card
export function signatureUnits(data, fname, n) {
  const list = data.units.filter((u) => u.faction === fname);
  const uniq = list.filter((u) => u.unique);
  const rest = list.filter((u) => !u.unique).sort((a, b) => b.cost - a.cost);
  const out = [];
  const seenCls = {};
  for (const u of uniq.concat(rest)) {
    if (out.length >= n) break;
    if (seenCls[u.cls] && !u.unique) continue;
    seenCls[u.cls] = 1;
    out.push(u);
  }
  for (const u of rest) {
    if (out.length >= n) break;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

// ---- AI opponent copy ---------------------------------------------------------------

export const PERSONALITY_INFO = {
  Auto: { label: 'Adaptive', text: 'Reads the match and switches doctrine.' },
  Front: { label: 'Balanced Assault', text: 'Combined arms on a broad front.' },
  Sky: { label: 'Air Superiority', text: 'Leans on aircraft and strikes.' },
  Raid: { label: 'Hit & Run', text: 'Fast raids on your economy.' },
  Fortress: { label: 'Fortress Defence', text: 'Turtles up, then pushes late.' },
};

export const DIFFICULTY_INFO = {
  recruit: { label: 'Easy', text: 'Slow to react, gentle attack waves.' },
  veteran: { label: 'Normal', text: 'A fair fight.' },
  elite: { label: 'Hard', text: 'Faster decisions, a small economy edge.' },
  marshal: { label: 'Expert', text: 'Relentless tempo and a larger economy edge.' },
};

// ---- menu ticker ----------------------------------------------------------------------

export const TIPS = [
  'Oil is everything. Every Oil Depot on a field adds a harvester and steady income.',
  'Low power slows production. Keep the meter in the green before you queue a push.',
  'Q W E R T F build from the command panel. Tab turns the page.',
  'Press A then click to attack-move — units engage everything on the way.',
  'Ctrl + 1–9 assigns a control group. Double-tap the number to jump to it.',
  'Engineers capture enemy structures. Order one to attack a building.',
  'Right-click a cameo or a queue chip to cancel it for a full refund.',
  'Units earn veterancy from kills. Veterans hit harder; elites are tougher too.',
  'Hold Shift while placing to chain structures. Shift-click the map to queue waypoints.',
  'Factions with an interceptor can stop superweapon warheads that land near their defensive structures.',
  'Stances matter: Z aggressive, X defensive, C hold ground, V hold fire.',
  'Infantry right-click an APC or IFV to mount up. Right-click the carrier to dismount.',
  'Press . to jump to an idle harvester or engineer.',
  'Lose your Construction Yard and you may rebuild it exactly once. Defend it.',
];

// ---- controls reference (source: input.js + hud.js) ------------------------------------

export const CONTROLS = [
  {
    title: 'Camera',
    rows: [
      [['Arrows'], 'Pan the camera'],
      [['Screen edge'], 'Pan the camera'],
      [['Wheel'], 'Scroll / zoom the view'],
      [['Middle-drag'], 'Grab and drag the map'],
      [['+'], ['−'], 'Zoom in / out'],
      [['Space'], 'Centre on the selection, or home base'],
      [['Home'], 'Jump to your Construction Yard'],
      [['Minimap'], 'Click or drag to move the camera'],
    ],
  },
  {
    title: 'Selection',
    rows: [
      [['Click'], 'Select a unit or structure'],
      [['Drag'], 'Box-select units'],
      [['Shift'], ['Click'], 'Add to the selection'],
      [['Double-click'], 'Select every unit of that type on screen'],
      [['Right-click'], 'On a selected unit: remove it from the selection'],
      [['Ctrl'], ['1–9'], 'Assign a control group'],
      [['1–9'], 'Recall a group · double-tap to centre on it'],
      [['Shift'], ['1–9'], 'Add the selection to a group'],
      [['.'], 'Cycle idle harvesters and engineers'],
      [['Esc'], 'Clear the selection'],
    ],
  },
  {
    title: 'Orders',
    rows: [
      [['Click'], 'Move · or attack the enemy under the cursor'],
      [['Right-click'], 'Context order: move, attack, repair, load'],
      [['Shift'], ['Click'], 'Queue a waypoint'],
      [['Drag'], 'From a selected unit: move to the release point'],
      [['A'], 'Attack-move (then click the destination)'],
      [['S'], 'Stop'],
      [['P'], 'Patrol (then right-click the far end)'],
      [['D'], 'Deploy the MCV · double-click also deploys'],
      [['G'], 'Cycle stance'],
      [['Z'], ['X'], ['C'], ['V'], 'Aggressive / Defensive / Hold ground / Hold fire'],
    ],
  },
  {
    title: 'Production',
    rows: [
      [['Q'], ['W'], ['E'], ['R'], ['T'], ['F'], 'Build or train the matching cameo'],
      [['Tab'], 'Next page of the command panel'],
      [['B'], 'Jump to the Structures tab'],
      [['Right-click'], 'On a cameo or queue chip: cancel, full refund'],
      [['Shift'], ['Click'], 'While placing: chain another structure'],
      [['Right-click'], 'With a factory selected: set its rally point'],
    ],
  },
  {
    title: 'Specialists',
    rows: [
      [['Engineer'], 'Attack an enemy structure to capture it'],
      [['Engineer'], 'Right-click a damaged friendly structure to repair'],
      [['Infantry'], 'Right-click an APC / IFV to board'],
      [['Carrier'], 'Right-click itself, or press Unload, to dismount'],
    ],
  },
  {
    title: 'System',
    rows: [
      [['Esc'], 'Cancel mode · deselect · pause menu'],
      [['M'], 'Mute sound effects and voice'],
      [['Enter'], 'Open chat (multiplayer)'],
    ],
  },
];
