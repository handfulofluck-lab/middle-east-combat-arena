// Economy repairs for the 15 pre-mapgen maps that are listed in manifest.json.
//
// Bar: from the freshly deployed Construction Yard, every spawn must have at
// least two oil fields on which an Oil Depot can legally be placed inside the
// AI's own search window (the rule validate.mjs mirrors).
//
// oilMoves / oilAdds are the FROZEN output of `node tools/mapgen/repair_legacy.mjs`
// (deterministic solver, real sim placement rules). generate.mjs applies them;
// running the solver again prints the proposal and exits 1 if it no longer
// matches this file. tags, terrain ops and spawn moves are hand-written inputs.
//
//   oilMoves:   [fromX, fromY, toX, toY]   an existing field moved (keeps its index)
//   oilAdds:    [x, y]                     a new field, appended to the list
//   spawnMoves: [fromX, fromY, toX, toY]
//   terrain:    { op: 'land-disc', cx, cy, r }   water within r of a point becomes land
//
// Every listed map also receives
//   meta: { players, size, tags, generator: 'legacy-repaired' }.
// `naval-separated`: at least one spawn has no land route to the others.
export const LEGACY_REPAIRS = {
  // two fields per base already, but 5 cells apart: spread so the AI uses both
  sinai: {
    tags: ['4p', 'real-geography'],
    oilMoves: [[45, 76, 45, 74], [44, 12, 44, 13], [91, 153, 95, 153], [147, 30, 147, 31]],
    oilAdds: [],
  },
  jerusalem: {
    tags: ['4p', 'real-geography'],
    oilMoves: [[43, 10, 47, 10], [37, 145, 41, 145], [137, 124, 137, 125]],
    oilAdds: [],
  },

  // real-geography six-player maps: four spawns had three fields, the rest none
  arabia: { tags: ['6p', 'real-geography'], oilMoves: [[43, 117, 47, 117], [32, 185, 32, 186]], oilAdds: [[143, 204], [134, 205]] },
  gulf: { tags: ['6p', 'real-geography'], oilMoves: [], oilAdds: [[107, 7], [98, 6], [21, 201], [30, 202]] },
  redsea: { tags: ['6p', 'real-geography'], oilMoves: [[152, 119, 152, 120], [152, 179, 152, 180]], oilAdds: [[20, 130], [20, 121]] },
  maghreb: { tags: ['6p', 'real-geography'], oilMoves: [[96, 6, 95, 6]], oilAdds: [[19, 5], [5, 19], [127, 220], [136, 220]] },
  anatolia: { tags: ['6p', 'real-geography'], oilMoves: [[39, 58, 43, 58]], oilAdds: [[117, 77], [126, 76], [127, 160], [118, 160]] },
  indus: { tags: ['6p', 'real-geography'], oilMoves: [], oilAdds: [[31, 123], [31, 132], [193, 5], [194, 14]] },
  gulfstates: { tags: ['6p', 'real-geography'], oilMoves: [], oilAdds: [[47, 5], [46, 14], [209, 218], [210, 209]] },

  // scenario maps: one field per base (often just out of the AI's reach)
  bab_el_mandeb: { tags: ['4p', 'scenario'], oilMoves: [], oilAdds: [[60, 113], [131, 78], [13, 48]] },
  nile_delta: {
    tags: ['4p', 'scenario', 'naval-separated'],
    oilMoves: [[46, 144, 43, 144], [146, 48, 147, 48], [140, 142, 141, 142]],
    oilAdds: [[20, 165], [171, 29], [96, 119], [165, 165]],
  },
  cyprus_levant: {
    tags: ['4p', 'scenario', 'naval-separated'],
    // Spawn 0 stood on a 22-cell sliver of land in the south-west corner, cut
    // off by the round sea: no room for a base, let alone oil. The sliver is
    // grown into a quarter-disc islet (429 cells of sea become land) and the
    // spawn steps 7 cells in from the corner. Nothing else on the map moves.
    terrain: [{ op: 'land-disc', cx: 0, cy: 192, r: 24 }],
    spawnMoves: [[1, 189, 8, 183]],
    oilMoves: [],
    oilAdds: [[5, 174], [17, 186], [128, 4], [127, 13], [186, 186], [177, 186]],
  },
  zagros_pass: {
    tags: ['4p', 'scenario'],
    oilMoves: [[48, 146, 45, 146], [144, 46, 145, 45], [54, 54, 53, 53]],
    oilAdds: [[23, 169], [170, 22], [30, 30], [161, 161]],
  },
  kyzylkum_steppe: {
    tags: ['4p', 'scenario'],
    oilMoves: [[48, 144, 47, 144], [144, 48, 144, 47], [112, 100, 109, 100]],
    oilAdds: [[25, 167], [168, 24], [163, 163], [163, 154]],
  },
  arabian_sea_convoy: {
    tags: ['4p', 'scenario', 'naval-separated'],
    oilMoves: [[46, 48, 45, 48]],
    oilAdds: [[17, 173], [176, 18], [86, 86], [23, 30]],
  },
};
