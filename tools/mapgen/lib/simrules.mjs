// The sim's Oil Depot rules as the AI applies them, shared by the validator
// and the legacy repair solver so both judge a map exactly the same way.
// Everything goes through Sim.canPlace on a real match state.
import * as Sim from '../../../client/src/sim/index.js';

export { Sim };

// fresh match with every MCV deployed (one player per spawn)
export function deployedState(map, data, players) {
  const st = Sim.createMatch({ data, map, players, seed: 7 });
  const cmds = [];
  for (const u of Object.values(st.units)) {
    if (u.defId === 'MCV') cmds.push({ player: u.owner, type: 'deployMCV', unitId: u.id });
  }
  Sim.tick(st, cmds);
  for (let i = 0; i < 6; i++) Sim.tick(st);
  return st;
}

// Can `slot` place an Oil Depot for the field at cell (ox, oy)? Same window
// the AI scans (ai.js findDepotSpot): top-left cells within 4 of the field.
export function depotSpot(st, slot, ox, oy) {
  const def = st.structDefs['SH-03'];
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      if (Sim.canPlace(st, slot, def, ox + dx, oy + dy)) return { x: ox + dx, y: oy + dy };
    }
  }
  return null;
}

// Replay the AI's standard opening (ai.js think(), 'front' doctrine, no
// combat) on a state whose ConYards are deployed, and return how many Oil
// Depots it ends up with:
//   Power Plant, Oil Depot, Barracks, War Factory, Tech, [Naval Yard when a
//   site exists], then the "second oil field" expansion.
// Ordinary buildings go where findPlacement puts them (spiral from the
// ConYard); depots follow findDepotSpot: fields in id order, a field with an
// own depot within 5 cells counts as served, first legal cell of the +-4
// window. The state is restored before returning.
export function aiDepotCount(st, slot) {
  const cy = Object.values(st.structures).find((s) => s.owner === slot && s.defId === 'SH-01');
  if (!cy) return 0;
  const c = Sim.structCenter(cy);
  const ax = Sim.cellOf(c.x), ay = Sim.cellOf(c.y);
  const fields = Object.values(st.oilFields).sort((a, b) => a.id - b.id);
  const placed = [];
  const depots = [];
  const put = (defId, spot) => { const s = Sim.addStructure(st, defId, slot, spot.x, spot.y); placed.push(s); return s; };
  const depot = () => {
    for (const o of fields) {
      const served = depots.some((d) => {
        const dc = Sim.structCenter(d);
        return Math.max(Math.abs(dc.x - o.x), Math.abs(dc.y - o.y)) <= 5 * Sim.CELL;
      });
      if (served) continue;
      const spot = depotSpot(st, slot, Sim.cellOf(o.x), Sim.cellOf(o.y));
      if (spot) { depots.push(put('SH-03', spot)); return; }
    }
  };
  const order = ['SH-02', 'SH-03', 'SH-04', 'SH-05', 'SH-08'];
  if (Object.prototype.hasOwnProperty.call(st.structDefs, 'SH-07') && st.map.terrain.includes(2)) order.push('SH-07');
  order.push('SH-03');
  for (const id of order) {
    if (id === 'SH-03') { depot(); continue; }
    const spot = Sim.findPlacement(st, slot, st.structDefs[id], ax, ay, 10);
    if (spot) put(id, spot);
  }
  for (const s of placed) delete st.structures[s.id];
  if (placed.length) st.structVersion++;
  return depots.length;
}
