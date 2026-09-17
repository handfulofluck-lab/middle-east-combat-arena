// Rally points: right-click with a production structure selected issues a
// setRally sim command (state.rally). The sim applies rallies when a producer
// completes a unit (economy.js), with a shared 3-cells-toward-center default
// (path.js defaultRallyCell) — humans and AI get identical behavior.
import { CELL, structCenter } from '../sim/index.js';

// pure: right-click world point + current selection -> rally command or null
export function rallyCommand(state, slot, selection, x, y) {
  for (const id of selection) {
    const s = state.structures[id];
    if (s && s.owner === slot && state.structDefs[s.defId].type === 'Prod') {
      return { type: 'setRally', structId: s.id, x: Math.round(x), y: Math.round(y) };
    }
  }
  return null;
}
