# mapgen-v3 — competitive map pack tools

Deterministic generator, validator and preview renderer for the maps in
`client/maps/`. Pure Node ESM (Node 22), no dependencies.

```
node tools/mapgen/generate.mjs            # rewrite the 10 pack maps, manifest.json and legacy theme metadata
node tools/mapgen/generate.mjs --check    # regenerate in memory, exit 1 if anything on disk differs
node tools/mapgen/validate.mjs            # audit every manifest map against the real sim, exit 1 on FAIL
node tools/mapgen/preview.mjs             # write tools/mapgen/previews/<id>.png for every manifest map
```

Useful flags: `generate.mjs --only id,id --out DIR` (scratch output, no manifest or
legacy changes), `validate.mjs --only id,id | --all | --no-smoke | --strict | --json | --maps DIR`
(`--all` adds the map files that are on disk but not in the manifest),
`preview.mjs --only id,id --maps DIR --out DIR`.

From a test runner:

```js
import { validateAll } from './tools/mapgen/validate.mjs';
const { ok, problems, results } = validateAll();          // or { only: [...], smoke: false, strict: true }
```

## Layout

| Path | Role |
| --- | --- |
| `generate.mjs` | builds every design, writes map JSONs + `manifest.json`, appends theme metadata to legacy maps |
| `designs/*.mjs` | one file per map: metadata + a `build(b, S)` function that paints the terrain |
| `designs/index.mjs` | pack order (= menu order of the new maps) |
| `legacy_meta.mjs` | `theme` / `tagline` (and `briefing` where one was missing) for the 23 older maps |
| `lib/builder.mjs` | `MapBuilder`: symmetric painting, spawn/oil orbits, cleanup pipeline, sanity asserts |
| `lib/sdf.mjs` | signed-distance brushes (circle, ellipse, capsule, spline curve, ring…), combinators, deterministic `polar()` |
| `lib/noise.mjs`, `lib/prng.mjs` | seeded Perlin fbm, mulberry32, lattice hash |
| `lib/grid.mjs` | grid symmetries, majority smoothing, thin-feature removal, components, distance fields, sim-rule Dijkstra |
| `lib/png.mjs` | minimal indexed-colour PNG encoder (zlib only) |
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

`meta` exists only on generated maps. Legacy maps keep their original bytes: the
generator appends `tagline` and `theme` (and a `briefing` when the map had none)
as the last keys and never touches name, size, terrain, oil or spawns.

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
- On a map with any water, the AI build order waits at the Naval Yard (`SH-07`)
  until one can be placed within 10 cells of the Construction Yard; if that is
  never possible, everything after it in the order (the fortress doctrine's
  defences and superweapon, the spare power plant) is never built. Every wet
  pack map therefore gives each base a harbour, and the other maps have no
  water at all. The validator reports this on legacy maps as a `naval` warning.
- There are no naval transports. Bases cut off by water can only be attacked by
  air and sea, so every pack map keeps a land route between all spawns.
- Slot `i` starts on `spawns[i]`, and a skirmish ally is always slot 1. With the
  opposites-first spawn order an ally therefore starts on the far side of a
  four- or six-player map.

## Validator

Checks on every manifest map: schema and bounds; spawns and oil on land;
briefing, tagline and theme vocabulary; Construction Yard deployment at every
spawn through a real `deployMCV` command; land routes from each spawn to its two
nearest oil fields and to every other spawn; at least two oil fields with a
legal Oil Depot site from the fresh Construction Yard; a Naval Yard site per
spawn on maps with water; an all-AI smoke match of 600 ticks.

Extra checks on pack maps (`meta.generator === 'mapgen-v3'`): the `meta` block;
exact symmetry of terrain, spawns and oil; fairness (path distance per spawn to
the two nearest fields and to the centre); at least 80% open land in the 15x15
block around each spawn; no speckles, fins, pinches or tiny blobs; the widest
route between spawns never narrower than clearance 2.5; one connected sea
between all harbours on maps tagged `naval`; a 3000-tick smoke match in which
every AI builds an Oil Depot and a production building. A map tagged
`naval-separated` skips the spawn-to-spawn land-route and choke checks (no pack
map uses it).

Severity: integrity problems FAIL on any map. Design-rule misses FAIL on pack
maps and are reported as `warn` on legacy maps, whose terrain is frozen;
`--strict` turns those warnings into failures. Pack-level rules: at most two
dusk/night themes, unique map names.

Table columns: `deploy` yards deployed / spawns, `paths` spawn pairs linked by
land, `depot` minimum number of depot-capable fields per spawn, `naval` yard
sites, `fair` path distance (cells) to nearest field / second field / centre,
`room` open share of the base block, `choke` clearance of the widest route,
`smoke` ticks run, `AI dep` fewest depots any AI reached, `ms` time per map.

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
