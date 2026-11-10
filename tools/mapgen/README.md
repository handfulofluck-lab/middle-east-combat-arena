# mapgen-v3 — competitive map pack tools

Deterministic generator, validator and preview renderer for the maps in
`client/maps/`. Pure Node ESM (Node 22), no dependencies.

```
node tools/mapgen/generate.mjs            # rewrite the 10 pack maps, manifest.json, legacy metadata and legacy repairs
node tools/mapgen/generate.mjs --check    # regenerate in memory, exit 1 if anything on disk differs
node tools/mapgen/validate.mjs --ci       # CI gate: every manifest map against the real sim, 600-tick smoke (5 to 10 s)
node tools/mapgen/validate.mjs            # full audit: 3000-tick smoke matches (about 40 s, up to a minute under load)
node tools/mapgen/preview.mjs             # write tools/mapgen/previews/<id>.png for every manifest map
node tools/mapgen/repair_legacy.mjs       # re-derive the legacy oil repairs and compare with the frozen data
```

`validate.mjs` exits 0 only when no map FAILs and no pack-level rule is broken.

Useful flags: `generate.mjs --only id,id --out DIR` (scratch output, no manifest or
legacy changes), `validate.mjs --only id,id | --all | --ci | --no-smoke | --notes | --strict | --json | --maps DIR`
(`--all` adds the map files that are on disk but not in the manifest, `--notes`
prints informational notes), `preview.mjs --only id,id --maps DIR --out DIR`.

From a test runner:

```js
import { validateAll } from './tools/mapgen/validate.mjs';
const { ok, problems, results } = validateAll({ ci: true });   // also: only: [...], smoke: false, strict: true
```

## Layout

| Path | Role |
| --- | --- |
| `generate.mjs` | builds every design, writes map JSONs + `manifest.json`, applies theme metadata and repairs to legacy maps |
| `designs/*.mjs` | one file per map: metadata + a `build(b, S)` function that paints the terrain |
| `designs/index.mjs` | pack order (= menu order of the new maps) |
| `legacy_meta.mjs` | `theme` / `tagline` (and `briefing` where one was missing) for the 23 older maps |
| `legacy_repairs.mjs` | frozen economy repairs (oil moves / additions, tags) for the 15 legacy manifest maps |
| `repair_legacy.mjs` | the solver that derives those repairs from the sim's placement rules |
| `lib/builder.mjs` | `MapBuilder`: symmetric painting, spawn/oil orbits, cleanup pipeline, sanity asserts |
| `lib/sdf.mjs` | signed-distance brushes (circle, ellipse, capsule, spline curve, ring…), combinators, deterministic `polar()` |
| `lib/noise.mjs`, `lib/prng.mjs` | seeded Perlin fbm, mulberry32, lattice hash |
| `lib/grid.mjs` | grid symmetries, majority smoothing, thin-feature removal, components, distance fields, sim-rule Dijkstra |
| `lib/png.mjs` | minimal indexed-colour PNG encoder (zlib only) |
| `lib/legacy.mjs` | applying a repair record; byte-preserving edits of legacy JSON text |
| `lib/simrules.mjs` | the AI's Oil Depot rules replayed through `Sim.canPlace` (shared by validator and solver) |
| `validate.mjs` | the validator (`validateAll`, `validateMap`) |
| `preview.mjs` | the preview renderer (`renderPreview`, `renderAll`) |
| `previews/` | committed PNGs, at most 512 px |

## Map JSON

```
{ name, w, h,
  terrain: number[w*h],          // row-major; 0 land, 1 rock, 2 water
  oil: [{x,y}], spawns: [{x,y}], // cell coordinates; one MCV per spawn
  briefing, tagline,             // 1-2 sentences / at most 60 characters
  theme: { biome, tod, weather },
  meta: { players, size: 'S'|'M'|'L', symmetry, tags: string[], seed, generator: 'mapgen-v3' } }
```

Pack maps carry the full `meta`. The 15 legacy maps in the manifest carry
`meta: { players, size, tags, generator: 'legacy-repaired' }`; the 8 older files
that are not in the manifest have no `meta`.

Legacy files are edited at text level so every untouched byte survives: the
generator appends `tagline`, `theme` (a `briefing` when the map had none) and
`meta` as the last keys, and replaces the `oil` array of a repaired map (see
"Legacy repairs"). Name, size and terrain are never touched, with one recorded
exception (`cyprus_levant`). Tags used on legacy maps: `4p` / `6p`,
`real-geography` or `scenario`, and `naval-separated` when at least one spawn
has no land route to the others.

`manifest.json`: the ten pack ids come first, then the previously listed ids in
their old order. Existing keys are kept; `mapgen_v3_maps` lists the pack ids.

Spawn order matters, because slot `i` always starts on `spawns[i]`: `spawns[0]`
and `spawns[1]` are opposite each other on every pack map (so a two-player game
on a four- or six-player map is a fair mirror), then the next opposite pair.

### Theme vocabulary

| Field | Values | Meaning for the renderer |
| --- | --- | --- |
| `biome` | `dunes` | soft yellow sand sea, sparse rock |
| | `coast` | pale sand, grey rock, clear sea, surf line |
| | `highland` | dry grass and scree, grey granite |
| | `oasis` | sand with green margins around water, palms |
| | `steppe` | olive grassland, low weathered hills |
| | `saltflat` | white crust, dark rock, pale shallow water |
| | `redrock` | red sandstone mesas and canyon walls |
| | `delta` | silt and reed green, murky channels |
| `tod` | `dawn` `day` `golden` `dusk` `night` | sun height / colour grade. Only two maps in the whole pack are `dusk` / `night`; the validator enforces that limit |
| `weather` | `clear` `haze` `dust` | distance fog amount and tint |

The 3D renderer resolves these names in `client/src/gfx/themes.js` (palette, rock
style, props, sun, fog); the table above is a summary, that file is the source
of truth. `preview.mjs` uses the same vocabulary for its palettes, so the PNGs
are a rough guide to the intended look.

## The pack

| # | id | Name | Size | Players | Symmetry | Oil | Theme (biome / tod / weather) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `bab_al_rih` | Bab al-Rih | 144 | 2 | rot2 | 12 | highland / golden / clear |
| 2 | `serpent_siq` | Serpent's Siq | 152 | 2 | rot2 | 12 | redrock / day / dust |
| 3 | `corsair_coast` | Corsair Coast | 160 | 2 | mirrorY | 12 | coast / day / clear |
| 4 | `scorpion_flats` | Scorpion Flats | 128 | 2 | rot2 | 10 | saltflat / dawn / haze |
| 5 | `qalat_nusur` | Qal'at Nusur | 192 | 4 | rot4 | 20 | highland / dusk / clear |
| 6 | `reedwater` | Reedwater Delta | 192 | 4 | mirrorXY | 20 | delta / dawn / haze |
| 7 | `lantern_strait` | Strait of Lanterns | 208 | 4 | rot4 | 20 | coast / night / clear |
| 8 | `kurgan_line` | Kurgan Line | 200 | 4 | mirrorXY | 20 | steppe / day / clear |
| 9 | `crown_of_salt` | Crown of Salt | 224 | 6 | hex | 24 | saltflat / day / haze |
| 10 | `sea_of_dunes` | Sea of Dunes | 240 | 6 | hex | 24 | dunes / golden / dust |

Every spawn has two start fields within depot reach of the Construction Yard,
one or two natural fields a couple of build hops away, and a share in contested
fields in the centre or on the flanks.

**Bab al-Rih (mountain pass, 1v1).** A granite range runs north to south between
the bases, which sit diagonally. There are three ways through. The central gate
is the shortest road: two doors about eight cells wide lead into a bowl inside
the range that holds two oil fields, equidistant from both players. The two long
passes sit near the ends of the range; because of the diagonal start, each
player has a home pass covered by their own natural expansion and an away pass
that opens onto the enemy's natural, with a forward third field at its mouth.
Hogback foothills make a covered north-south lane along each side of the range.

**Serpent's Siq (canyon maze, 1v1).** Solid sandstone with a hand-laid network of
slot canyons six to eight cells wide. An outer loop runs round the whole map
(through each natural on one side, through a long back door on the other), two
routes converge on a central hub with the contested oil, and side galleries tie
loop and hub together. A cross-canyon joins each player's far gallery to the
enemy's side gallery, so the loop can be cut short in several places. There is
no open ground anywhere, so scouting and holding junctions matter more than
army size.

**Corsair Coast (coastal invasion, 1v1).** The western 42% of the map is open
sea and both bases keep a harbour cove on it. On land a rocky spine separates a
coast road (short, wide, inside naval gun range for its whole length) from a
sheltered inland valley; a cross-pass on the centre line joins them. Each player
has an exposed coast natural and a safe inland one. The contested oil is split
between the headland, which only a fleet can hold, and the inland wells at the
cross-pass, which no ship can reach.

**Scorpion Flats (small open map, 1v1).** A 128-cell salt pan for quick games.
Two curved mesas, the claws, wrap the central wells so that they open only
toward the two neutral corners; neither base can drive straight in. A second
contested field sits in each neutral corner, the same distance from both
players. Rush distance is short and cover is minimal.

**Qal'at Nusur (fortress plateau, king of the hill, 4 players).** A ring-walled
citadel in the centre holds four oil fields around a keep. It has one gate on
each compass point, so every gate lies between two bases and belongs to neither.
A broken outer rampart, open on the diagonals toward each base, turns the ground
between rampart and wall into a ring road that every attack on a gate must use.
Each base has a natural on the outer lane and shares a mid-edge field with each
neighbour, all away from the citadel, so ignoring the middle is a real option.

**Reedwater Delta (rivers and fords, 4 players).** Two pairs of meandering
channels cut the plain into nine islands: four home corners, four neutral
islands (the north and south ones carry two oil fields each) and the large
centre island with four. Each home island has a natural beside one of its fords. Every
crossing is a ford, a lens of dry sandbar eight to twelve cells wide, and there
are twelve of them. Each home island has a backwater beside the base for a naval
yard; gunboats cannot leave their reach of river (the fords block them) but one
reach covers the two home fords and the nearest centre fords.

**Strait of Lanterns (naval, 4 players).** A cross-shaped inland sea separates
four home islands. The only land links are the isthmuses at the four ends of the
cross, each about fourteen cells deep with an oil field on it, so a neighbour is a
long march away along a causeway that ships can shell from end to end. Every
harbour bay opens on the same sea (the validator checks sea-route connectivity
with the sim's own pathfinder). Each island has a sheltered corner natural and a
lighthouse point reaching toward the Lantern rock in the middle of the sea,
whose oil field can only be defended from the water.

**Kurgan Line (three lanes, 4 players).** Two belts of low hills divide open
steppe into a north lane, a centre lane and a south lane. Each base anchors the
end of an outer lane; the centre lane, with the great kurgan and four oil fields
around it, belongs to nobody. Each belt has a wide gap in the middle (about eleven
cells) and two narrow ones (five or six), so columns can change lanes but can also be cut off between them.
A ridge in each backfield separates the two bases that share a map edge.

**Crown of Salt (ring layout, 6 players).** A spiked salt dome fills the centre
and nothing crosses it, so all movement is around the ring. Six bays hold six
bases; rock teeth separate neighbours, leaving exactly two doors between any two
bays: a wide inner gate beside the dome with a contested oil field in it, and a
narrow outer gate under the rim. Reaching the far side means passing through
other players' bays.

**Sea of Dunes (open desert, 6 players).** A sand sea with about one cell in ten
blocked: a shield mesa in front of each base, a mesa on each neighbour-to-neighbour
line, two rings of barchan-shaped ridges and a lone rock in the middle. Six wells
ring the open centre, each exactly between two bases. No chokepoints at all; this
is the map for massed armour and air.

## Design rules taken from the sim

These come from reading `client/src/sim` and are what the validator enforces.

- **Build radius.** A structure must have its centre within 10 cells (Chebyshev)
  of an owned Core or Prod structure (`BUILD_RADIUS`). Anything further needs a
  chain of production buildings, so naturals sit 20 to 35 cells from the spawn.
- **Oil depots.** A depot centre must be within 5.5 cells of a field and no part
  of it may touch the 3x3 block around the field. The AI only tries top-left
  cells within 4 of the field, so start fields are kept within about 12 cells of
  the spawn and at least 9 cells apart (a depot within 5 cells of a field makes
  the AI treat that field as served).
- **Pads.** `MapBuilder` forces open land in a disc around every spawn (radius 8
  to 11) and every oil field (radius 5) before cleanup.
- **Symmetry.** Brushes are replicated through the map's symmetry group, the grid
  is then forced exactly symmetric, and the generator refuses to write a map
  that is not. `hex` maps are built from 60-degree rotations; a square grid
  cannot hold those exactly, so they are exact under 180 degrees and within a
  cell or two under the rest (fairness tolerance 4 cells, against 1 for the
  exact groups).
- **Clean outlines.** Two passes of 3x3 majority smoothing, then removal of every
  one-cell fin, corridor, diagonal pinch, rock blob under 12 to 14 cells, pond
  under 30 to 40 cells and unreachable land pocket under 40 to 60 cells.
- **Pathfinder cap.** Unit A* gives up after 40,000 expansions. The validator
  runs the sim's own `findPathCells` both ways between every pair of spawns, so a
  map that exceeds the cap fails.

## Sim and AI limits that shaped the maps

- The AI builds at most two Oil Depots and only inside the build radius of its
  first base. Naturals and contested fields matter to human players only.
- The AI only builds a Naval Yard when one can be placed within 10 cells of its
  Construction Yard (since the v1.0 AI this no longer blocks the rest of its
  build order). Wet pack maps give every base a harbour; on legacy maps the
  validator lists spawns without a yard site as a note.
- The AI treats an oil field as already served when one of its depots stands
  within 5 cells of it. Two start fields 5 cells apart therefore yield one AI
  depot, not two. Pack maps keep start fields 9 or more cells apart; the legacy
  repair spreads the affected pairs.
- There are no naval transports. Bases cut off by water can only be attacked by
  air and sea, so every pack map keeps a land route between all spawns.
- Slot `i` starts on `spawns[i]`, and a skirmish ally is always slot 1. With the
  opposites-first spawn order an ally therefore starts on the far side of a
  four- or six-player map.

## Validator

Maps come in three kinds, told apart by `meta.generator`: `v3` (pack maps),
`repaired` (legacy manifest maps, `legacy-repaired`) and `legacy` (no `meta`;
only seen with `--all`).

Checks on every map: schema and bounds; spawns and oil on land; briefing,
tagline and theme vocabulary; Construction Yard deployment at every spawn
through a real `deployMCV` command; land routes from each spawn to its two
nearest oil fields and to every other spawn (the latter is skipped on maps
tagged `naval-separated`); at least two oil fields with a legal Oil Depot site
from the fresh Construction Yard, inside the AI's search window; a replay of the
AI's standard opening that must end with two depots; an all-AI smoke match in
which every AI builds an Oil Depot and a production building.

Extra checks on `v3` maps: exact symmetry of terrain, spawns and oil; fairness
(path distance per spawn to the two nearest fields and to the centre); at least
80% open land in the 15x15 block around each spawn; no speckles, fins, pinches
or tiny blobs; the widest route between spawns never narrower than clearance
2.5; a Naval Yard site per spawn on maps tagged `naval` or `riverine`, and one
connected sea between all harbours on `naval` maps.

Severity: on `v3` and `repaired` maps every rule above is a FAIL. On plain
`legacy` maps integrity problems FAIL and the economy and route rules only
`warn` (`--strict` turns warnings into failures). Notes are informational and
never change a result; today the only note lists spawns with no Naval Yard site
on a wet map. Pack-level rules: at most two dusk/night themes, unique map names.

Smoke length: 3000 ticks on `v3` and `repaired` maps and 600 on plain `legacy`
maps; `--ci` uses 600 everywhere, which is enough for the depot and production
requirement and brings the whole run to between 5 and 10 seconds.

Table columns: `deploy` yards deployed / spawns; `paths` spawn pairs linked by
land (`sep` marks a `naval-separated` map); `depot` fewest depot-capable fields
per spawn / fewest depots in the AI opening replay; `naval` yard sites; `fair`
path distance (cells) to nearest field / second field / centre; `room` open
share of the base block; `choke` clearance of the widest route; `smoke` ticks
run; `built` fewest depots any AI actually built in the smoke match (depends on
doctrine and match length, informational); `ms` time per map.

## Legacy repairs

The 15 older maps in the manifest were audited with the same rules and failed
them in three ways: spawns with no oil field in depot reach of the Construction
Yard, bases whose one field sat a cell or two outside the AI's search window,
and bases whose two fields were 5 cells apart, which the AI counts as one. The
repair makes every spawn satisfy two rules: two oil fields with a legal depot
site from the fresh Construction Yard, and two depots at the end of the AI's
standard opening.

`repair_legacy.mjs` derives the changes with the sim's own placement code
(`lib/simrules.mjs`), preferring the smallest move of an existing field and
adding fields only where a base had none to move. Its output is frozen in
`legacy_repairs.mjs`; `generate.mjs` applies it, so the map files do not shift
when the sim changes. Run `node tools/mapgen/repair_legacy.mjs` to re-derive the
proposal: it exits 1 if it no longer matches the frozen data.

Moved fields keep their index in the `oil` array; added fields are appended.
New fields sit 8 to 11 cells from their spawn on open ground, on the side away
from the middle of the map where there is room.

| Map | Oil fields | Moved (from→to) | Added | Other |
| --- | --- | --- | --- | --- |
| `sinai` | 8 → 8 | (45,76)→(45,74), (44,12)→(44,13), (91,153)→(95,153), (147,30)→(147,31) | — | — |
| `jerusalem` | 8 → 8 | (43,10)→(47,10), (37,145)→(41,145), (137,124)→(137,125) | — | — |
| `arabia` | 12 → 14 | (43,117)→(47,117), (32,185)→(32,186) | (143,204), (134,205) | — |
| `gulf` | 12 → 16 | — | (107,7), (98,6), (21,201), (30,202) | — |
| `redsea` | 12 → 14 | (152,119)→(152,120), (152,179)→(152,180) | (20,130), (20,121) | — |
| `maghreb` | 12 → 16 | (96,6)→(95,6) | (19,5), (5,19), (127,220), (136,220) | — |
| `anatolia` | 12 → 16 | (39,58)→(43,58) | (117,77), (126,76), (127,160), (118,160) | — |
| `indus` | 12 → 16 | — | (31,123), (31,132), (193,5), (194,14) | — |
| `gulfstates` | 12 → 16 | — | (47,5), (46,14), (209,218), (210,209) | — |
| `bab_el_mandeb` | 6 → 9 | — | (60,113), (131,78), (13,48) | — |
| `nile_delta` | 6 → 10 | (46,144)→(43,144), (146,48)→(147,48), (140,142)→(141,142) | (20,165), (171,29), (96,119), (165,165) | tagged `naval-separated` |
| `cyprus_levant` | 6 → 12 | — | (5,174), (17,186), (128,4), (127,13), (186,186), (177,186) | spawn 0 (1,189)→(8,183); 429 sea cells in the south-west corner become land; tagged `naval-separated` |
| `zagros_pass` | 5 → 9 | (48,146)→(45,146), (144,46)→(145,45), (54,54)→(53,53) | (23,169), (170,22), (30,30), (161,161) | — |
| `kyzylkum_steppe` | 5 → 9 | (48,144)→(47,144), (144,48)→(144,47), (112,100)→(109,100) | (25,167), (168,24), (163,163), (163,154) | — |
| `arabian_sea_convoy` | 5 → 9 | (46,48)→(45,48) | (17,173), (176,18), (86,86), (23,30) | tagged `naval-separated` |

Why each kind of change was needed:

- **Additions on the six-player real-geography maps** (`arabia`, `gulf`,
  `redsea`, `maghreb`, `anatolia`, `indus`, `gulfstates`): two spawns per map
  (one on `arabia` and `redsea`) had no field nearer than 50 cells. Each got
  two. The other spawns keep the two or three they had.
- **1 to 4 cell moves on `sinai`, `jerusalem`, `arabia`, `redsea`, `maghreb`,
  `anatolia`**: bases with exactly two fields 5 cells apart. One field of each
  pair moves just far enough for the AI to place its second depot. `oil[0]` is
  unchanged on all six.
- **Scenario maps** (`bab_el_mandeb`, `nile_delta`, `zagros_pass`,
  `kyzylkum_steppe`, `arabian_sea_convoy`): one field per base, on four of them
  14 to 16 cells out, just beyond the AI's window. Those move 1 to 3 cells in
  and every base gets a second field.
- **`cyprus_levant`**: spawn 0 stood on a 22-cell sliver of land in the
  south-west corner, cut off from everything by the round sea. This is the only
  terrain edit in the repair: a quarter-disc of radius 24 around that corner
  becomes land (429 cells), giving a small island base, and the spawn moves 7
  cells in from the corner. Spawns 1 and 3 had no field within 45 cells and got
  two each.

`nile_delta` (spawn 0 on the west bank), `cyprus_levant` (spawn 0 on its island)
and `arabian_sea_convoy` (every spawn on its own island) have spawns with no
land route to the others. Their land layout is otherwise untouched and they are
tagged `naval-separated`, which the validator accepts in place of spawn-to-spawn
land routes.

## Adding a map

1. Copy a file in `designs/`, give it a new `id`, `seed`, size and `symmetry`
   (`rot2`, `rot4`, `mirrorX`, `mirrorY`, `mirrorXY`, `hex`).
2. In `build(b, S)` paint ONE player's sector with `b.rock(f)`, `b.water(f)`,
   `b.land(f)`, where `f` is a brush from `lib/sdf.mjs`. Later calls paint over
   earlier ones. Use `b.fbm(cells)` noise with `S.rough` / `S.warp` for organic
   outlines; pass `{ sym: false }` for a brush that is already symmetric.
3. Place `b.spawn(x, y, { pad })` and `b.oilField(x, y, role)` once; the builder
   adds the symmetric copies in fair spawn order.
4. Register the design in `designs/index.mjs`, then run `generate.mjs --only id
   --out /some/scratch`, `preview.mjs --maps /some/scratch --out /some/scratch`
   and `validate.mjs --maps /some/scratch`, and look at the PNG.

No `Math.random`, `Date` or trigonometric built-ins are used in the generator:
noise is hash-based, angles go through a Taylor-series `sinCosDeg`, so the same
seed gives byte-identical files on any engine.
