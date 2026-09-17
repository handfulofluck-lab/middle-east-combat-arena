# MCA Graphics Tooling Plan — maps, terrain, units, buildings

Scope: what *tools* (not art direction in the abstract) would produce better, more
distinguishable, more attractive graphics for MCA v0.9.0, given the existing
single-file canvas-2D architecture. Every recommendation is anchored to the
current code and pack state. All recommendations use free tools unless a paid
option is explicitly flagged.

## Current state (evidence)

- Pack contract: per-id PNGs, `canvas_px = 2x drawn size`, anchor = center,
  north-facing masters, 8-frame dir strips `N NE E SE S SW W NW`, wrecks on the
  same canvas, damaged states at <=50% HP, 128px cameos, FX loops
  (`artwork/units_v4/mca-assets-v2/manifest.json` -> `conventions`).
  163 units, 35 structures (11 shared `All` + per-faction uniques: IL 4, IN 4,
  TR 3, IR 3, others 2), 12 effects, 8 ambient loops.
- Renderer: units blit dir-strip frames with **no rotation**
  (`client/src/game/render.js:1096-1104`); structures blit footprint-sized
  bitmaps (`render.js:970-985`); ownership for art units is only a 3px
  owner-color ground ellipse (`render.js:1081-1087`) and for structures a 3px
  underline bar (`render.js:984-985`). **No team-color pixel channel exists.**
- Terrain: one 64px base tile per cell stamped at bake time; bake resolution
  `TS = clamp(6144/max(w,h), 16..64)` -> 25-32 px/cell on the shipping
  192-240 cell maps (`render.js:58`, `client/src/sim/state.js:6` CELL=64);
  decals and foam are hash-scattered overlays (`render.js:94-123`); water
  animates as 4 cell-stamped frames at 2 fps (`render.js:918-933`). Zoom tops
  out at 2.5x (`client/src/game/camera.js:1-4`), so tiles are seen at up to
  ~160 px/cell.
- The v6 tiles are the visual ceiling: `sand.png` is a nearly flat tan square,
  `water_*.png` is a vertical stripe gradient, and `decal_foam.png` is 32x12 px
  stretched over an entire 64px cell on *every* water cell touching land
  (`render.js:121-123`). The structure set is flat grey rounded squares with a
  glyph (see `preview_structures.png`); no faction architecture language.
- Maps are **hand-tuned boolean coast functions** (polygons, varying-width
  polylines, discs — `tools/gen_real_maps.py:69-127`), rasterized with a
  center+quadrant rule and one majority smooth (`gen_real_maps.py:131-150`),
  then hard-validated. Not real geographic data.
- Bundle: `client/assets/unitart.json` ~3.6 MB (Pillow PNG -> data-URI,
  256-color FASTOCTREE quantize for strips/tiles —
  `tools/build_art.py:60-71,87-106,143-148`); atlases ship in the pack
  (`atlas/*.png+json`) but the client loads per-id data-URIs only
  (`client/src/main.js:36-58`). Procedural drawing is the guaranteed fallback
  when art is absent (`sprites.js:160-166`).

---

## 1. Maps — real geography sources -> game maps

**Goal:** keep the validated `{w, h, terrain[], oil[], spawns[]}` JSON contract
(`gen_real_maps.py:12-14`) but source coastlines/terrain from real data instead
of hand-drawn polygons.

**Sources (all free, offline-cacheable once downloaded):**

| Data | Source | Use |
|---|---|---|
| Coastlines, rivers, lakes, admin-0 boundaries | **Natural Earth** (public domain, 1:10m/1:50m vectors) | land/water raster, region framing |
| High-fidelity coastlines | **OSM coastlines-split** shapefile (`osmdata.openstreetmap.de`) | strait/island fidelity where 1:10m is too coarse |
| Elevation | **COP-DEM / SRTM 30m** (free) | hillshade -> rock scatter + dune orientation |
| Color reference | **Sentinel-2** 10m satellite (Copernicus, free) | palette matching for sand/rock/scrub; *reference only, never ship the imagery* |

**Pipeline (replace the geometry section of `gen_real_maps.py`, keep everything
below `rasterize`):**

1. **QGIS** (free desktop GIS) for exploration only: load Natural Earth +
   COP-DEM, pick the map bbox, measure real strait widths, export the chosen
   bbox layers to GeoJSON. No QGIS in the build path — it is a visual REPL.
   GDAL (bundled with QGIS, or standalone) can do the same headless via
   `ogr2ogr`.
2. **Python: geopandas + shapely + pyproj** (all free; fits the existing
   Pillow-based tool chain) in a new `tools/geo_to_map.py`:
   - reproject the region to a local equal-area CRS (UTM zone) so cell aspect
     stays square;
   - build a `land_fn(x, y)` from the coastline polygon(s) at cell coordinates —
     a direct replacement for the hand-tuned `poly/band/disc` functions
     (`gen_real_maps.py:95-118`);
   - reuse `rasterize()` (center + >=2-of-4 quadrants, `gen_real_maps.py:131-143`)
     and the single majority smooth so determinism and strait survival are
     unchanged;
   - hillshade from COP-DEM via `rasterio` -> threshold to place rock cells and
     to bias the scrub/rock decal hash (currently uniform, `render.js:94-109`)
     toward slopes;
   - feed the result into the existing spawn/oil placement + validation
     (`gen_real_maps.py:16-38`). Deliberate playability deviations (6-10 cell
     straits, island isthmuses) stay — they are documented and correct for the
     genre (`gen_real_maps.py:28-38`).
3. **Tiled** (free) is *not* needed for terrain (the map is a flat array), but
   is the right tool for authoring **object layers** — oil derrick clusters as
   named regions, spawn zones, and any future capturable locations — exported
   to CSV/JSON and merged by `geo_to_map.py`.

Cost: ~1-2 days to build `geo_to_map.py`; then each new real region is minutes
of bbox tuning instead of hand-drawing polylines. Quality gain: maps become
recognizably Sinai, Hormuz, Golan — today they are only approximations.

---

## 2. Terrain texture — tileable sand/rock/water + shore transitions

**Constraints from the renderer:** tiles are stamped one-per-cell at 16-64 px
(`render.js:58-93`), so masters must be **seamlessly tileable at 64px** and
read at 25px (typical 1x zoom on 192+ cell maps); decals are transparent
overlays (`render.js:94-109`); water needs >=4 interchangeable animation frames
(`render.js:918-933`); everything is quantized to 256 colors at pack time
(`build_art.py:65-68`) so 24-bit subtleties are wasted bytes.

**Generators ranked:**

| Tool | Cost | What it does here |
|---|---|---|
| **Python + numpy periodic value/Perlin noise** (own script, ~100 lines) | free, deterministic | sand grain: layered periodic noise, palette-mapped to `#b8a06a`-family tints (`render.js:9`); rock: ridged noise + crack lines; guaranteed tileable because the noise lattice wraps |
| **Material Maker** (free, open-source node tool, Substance-Designer-style) | free | if hand-tuning is wanted: node graph (noise->warp->palette) exports tileable PNG; visually richer than raw code without a Substance license |
| **GIMP / Krita tileable patterns** | free | manual painting of the master 128px tile, then downscale to 64 (supersampling hides strokes); good for dune ripple direction |
| **Blender shader nodes -> bake** | free | overkill for 64px tiles; only if shading detail is wanted at 2.5x zoom |

**Author at 128px, ship at 64px.** Zoom reaches 2.5x (`camera.js:4`), so a
128px master downsampled to 64 stays crisp where a 64px master goes mushy;
`build_art.py` already resamples with LANCZOS (`build_art.py:62-64`).

**Water:** generate 4 frames from the same noise field phase-shifted in time
(not 4 independent textures) so the 2 fps stamp loop (`render.js:921-931`)
reads as motion, not a slideshow. Break the current vertical-stripe look
(`preview_tiles.png`) with two octave scales of ripple + subtle specular dots.

**Foam/shore transitions — the biggest single win.** Today one 32x12 decal is
stretched over whole cells (`render.js:121-123`). Instead:

1. Author a **16-tile blob/autotile set** (4-bit N/E/S/W neighborhood mask ->
   tile index) per land-water pair: `shore_sand_N`, `shore_sand_NE`, ... plus
   corner variants, in LibreSprite/GIMP at 64px.
2. The bake already computes the 4-neighborhood for foam
   (`render.js:113-120`) — extend that block to compute the mask
   `m = (N?1:0)|(E?2:0)|(S?4:0)|(W?8:0)` and stamp `shore[m]` on water cells
   (and optionally `cliff[m]` on rock cells). Data-only pack change plus ~10
   lines in the bake; no per-frame cost.
3. Dune/rock/scrub decals stay as-is (they work), but must be **re-authored at
   64x64** so they stop being stretched 20x16 / 48x24 sprites.

**AI texture upscalers:** Real-ESRGAN (open-source; `xinntao/Real-ESRGAN`
Python or the Upscayl GUI) can denoise/upscale satellite-derived or
AI-generated texture *drafts* — useful on source images before palette-mapping,
pointless on final 64px tiles (nothing to upscale). Do not ESRGAN the shipped
tiles; the 256-color quantize would erase the gain anyway.

---

## 3. Units/weapons — four options ranked

Draw size today: 56-96 px at 1x (`sprites.js:37-64` radii 28-48). 163 units x
8 frames. The dir-strip contract (`sprites.js:202-216`) is sound and must not
change.

| Rank | Option | Cost | Quality ceiling | Verdict |
|---|---|---|---|---|
| 1 | **Aseprite pipeline** ($20; **LibreSprite** is the free fork) — per-class layered templates (hull, turret, tracks, faction-accent layer); rotate/offset layers for the 8 strip frames | ~2-4 h per *class template* (not per unit); 163 units mostly re-skin templates | Authentic RA2-class token readability; pixel control = best distinguishability per byte; quantizes to 256 colors losslessly (matches `build_art.py:65-68`) | **Best fit** for the RA2-style target; highest readability per hour |
| 2 | **Blender low-poly prerender** — one model per unit class, orthographic top-down camera rig scripted to render 8 azimuths, palette-limited flat shading | ~1-2 days per model + rig setup; needs strict style discipline (limited palette, no PBR) | RA3-lite: consistent lighting/shadows across all 163 units; wrecks = same model with a damage morph; best *attractiveness* ceiling | Use for **hero/unique units and aircraft** (jets/helos benefit most from baked shading); too heavy for all 163 |
| 3 | **Style-consistent AI generation** (the existing Grok method) with enforced discipline | lowest per-asset cost | the current pack *is* the ceiling: flat vector look, tiny textures, per-id style drift (see `preview_all_sprites.png`) | Keep for bulk/placeholders; enforce one prompt template + fixed palette hex list + a normalization post-pass |
| 4 | **Real-ESRGAN upscale of the current pack** | ~1 h (batch script) | raises resolution, not detail; upscaled flats stay flat | Cheap stopgap only — buys zoom crispness at 2.5x, nothing more |

**Recommended mix:** LibreSprite templates for the ~12 land class archetypes
(MBT, IFV, APC, SPG, MLRS, TEL, AA, infantry fireteam, engineer, helo, jet,
ship) x faction skins; Blender for the ~20 aircraft/naval/hero units; AI
generation only where volume beats fidelity. Whatever the source, a
**normalization post-pass** (Pillow, `tools/pack_units.py`): resize to
`canvas_px`, center on the manifest anchor, 1px dark silhouette stroke (the
pack README already names this as a readability rule), palette clamp, quantize
— so all sources land in the same visual system.

Faction identity today is a baked accent color + one word ("Scalpel /
precision", `manifest.json -> factions`). Units must stay readable in
**owner-neutral** form, because ownership comes from the ground ring
(`render.js:1081-1087`), not the sprite.

---

## 4. Buildings — silhouette-first, per-faction language, team-color masks

Current: 35 grey flat tiles (`preview_structures.png`), ownership = 3px
underline (`render.js:984-985`). Sizes: 128/192/256 px = 2x2/3x3/4x4 cells.

**Silhouette-first rules (tool-enforced):**

1. Sketch the building as a **black filled silhouette in Inkscape** (free
   vector tool). Test: export at 40x40 px — if the type is not guessable
   (power? barracks? AA tower?), redraw. The 40px test is the real readability
   bar at default zoom.
2. Only after the silhouette passes, add interior detail in Krita/GIMP
   (free). Keep interior contrast low (<=30% value range) so the silhouette
   dominates, per the existing structure-shape doctrine (`sprites.js:66-87`).
3. Every structure ships `sprite`, `damaged`, `wreck` on the same canvas and
   anchor — the contract is already enforced at consumption time
   (`render.js:970,975`, `sprites.js:218-223`).

**Per-faction architecture language.** The 24 faction-unique buildings already
carry faction tags (e.g. SH-23 Iron Dome/IL, SH-34 Bavar-373/IR) — the art
just ignores them. Palette + geometry, abstracted (no real insignia):

| Faction | Language |
|---|---|
| Egypt | sand-yellow concrete, shallow domes, berms |
| Israel | pale blue-white, angular slabs, sensor masts |
| Iran | deep green/purple, pointed arches, missile-gantry motifs |
| Turkey | red-grey, drone-pad hexagons |
| India | orange-brown, lattice masts |
| Pakistan / Algeria / Saudi / UAE | teal / grey / green / red accents on shared forms |

**Team-color mask contract the renderer needs** (today: none — underline
only):

- Pack ships per structure (and optionally per unit) a **grayscale `teamMask`
  PNG** on the same canvas; white = pixels tinted to owner color.
- Renderer change (~15 lines, mirrors existing patterns): tint once per
  `defId x owner` into an offscreen canvas (`source-in` composite of mask ->
  owner color), cached like `__unitSprites` (`render.js:322-355`), drawn under
  or over the main bitmap. Units can share the mechanism for the turret accent
  instead of the baked faction accent.
- `build_art.py` inlines masks exactly like sprites (greyscale, 16 levels
  suffices -> tiny).

This makes ownership readable on art *without* the ring/underline crutches and
is the single highest-value renderer-pack contract addition.

---

## 5. The v2 pack contract — what the renderer actually needs

Keep (works, evidence-backed): per-id data-URIs (`main.js:36-58`); center
anchor; `canvas_px = 2x` draw size; 8-frame strips with `fw`/`frames`
(`sprites.js:202-216`, `render.js:1096-1104`); wrecks/damaged/cameos;
`fxMeta` radii (`sprites.js:252-271`); loops with `fps` (`sprites.js:290-330`);
tile keys + deterministic hash scatter (`render.js:40-46`); 256-color quantize
(`build_art.py:65-68`); headless/procedural fallback (`sprites.js:160-166`) —
**every addition must degrade to the procedural path when absent**.

Add:

1. `teamMask` per id (see §4) — `unitart.json` group `teamMasks`, consumed by a
   new `teamTintBitmap(game, defId, color)` next to `sprites.js:220-223`.
2. **Transition tiles**: `tiles` group extended with `shore_{m}` (m = 0..15,
   4-bit mask), stamped in the bake's existing neighborhood block
   (`render.js:113-123`); the foam decal becomes a shore-tile detail, not a
   full-cell stamp.
3. **Manifest v2 fields** — all optional, all defaulted:
   - `anchor: {x, y}` (default center) — frees asymmetric structures from the
     center assumption (`render.js:970-985` centers by footprint);
   - `mip2: true` — build_art emits a 2x variant for zoom > 1.5 (zoom ceiling
     2.5, `camera.js:4`); today's single 0.5-scale inline (`build_art.py:88`)
     softens at 2.5x;
   - `transition: {set: "shore", masks: 16}`;
   - `palette` index for shared faction swatches (shared quantize tables ->
     smaller JSON);
   - explicit `tile_size: 64` + `tileable: true` asserted by the pack linter
     (see §6).
4. **Pack linter** (new, in `tools/`): every referenced PNG exists; dir-strip
   width = `frames x canvas_px`; strip order sanity (N frame == north single);
   mask sizes match sprites; tiles are 64x64 and edge-wrappable (numpy
   roll-diff check); byte-budget report per group (current budget: unitart.json
   3.6 MB).
5. **Atlases: use or delete.** `atlas/*.png+json` ship unused (`main.js:47-58`
   loads only per-id records). For a single-file offline build, per-id
   data-URIs in one JSON are fine; if JSON size ever hurts, add an atlas
   branch to `build_art.py` + a frame-rect loader in `sprites.js` — a size
   optimization, not a quality one. Recommend deleting the atlases from the
   pack to stop maintaining two layouts unless a mip/atlas rework lands.

---

## 6. Recommended pipeline (free tools only) — source asset -> inlined data-URI

Extending `tools/build_art.py`; every step headless-runnable on this machine
(Python venv + Pillow + numpy + geopandas; node already in `C:\KARIM\tools`).

1. **Geography -> map JSON** — new `tools/geo_to_map.py`:
   Natural Earth 1:10m land + lakes + rivers (download once to `artwork/geo/`)
   -> geopandas clip/reproject to UTM -> `land_fn` at cell scale -> reuse
   `rasterize` + smooth + spawn/oil/validation from `gen_real_maps.py`
   -> write `client/maps/<region>.json` (byte-deterministic; no RNG).
   COP-DEM hillshade biases rock placement and the scrub-decal hash.
2. **Terrain masters** — `tools/gen_tiles.py` (new, Pillow+numpy, periodic
   value noise, palette maps pinned to `TERRAIN_COLORS` `render.js:9`):
   128px sand/rock/water masters -> 4 phase-shifted water frames -> downscale
   to 64 -> **linter asserts tileability** (max edge diff) -> write
   `artwork/terrain/mca-assets-v2/tiles/`.
   Shore set: authored once in LibreSprite/GIMP as 16 mask tiles (or
   generated: base water + alpha-cut sand-colored shoreline arc per mask),
   same linter. Decals re-authored at 64x64.
3. **Units** — LibreSprite class templates (land) / Blender rigs (air, naval,
   heroes) -> export north master + 8 azimuths -> `tools/pack_units.py`
   normalization: canvas_px, center-on-anchor, 1px dark stroke, palette clamp,
   256-color quantize -> `sprites/dirs|units|wrecks/`.
4. **Buildings** — Inkscape silhouette (40px test) -> Krita paint with faction
   swatch sheets -> damaged (<=50% HP variant) + wreck + `teamMask` grayscale
   derived from the accent layers (exportable directly from the vector file's
   accent layer).
5. **Cameos/icons** — derive from the north master automatically (background
   plate + unit render at 96px + name strip); special-case only the ~10
   heroes.
6. **Pack + lint + build** — `python tools/build_art.py` (extended: teamMasks
   group, shore tiles, `mip2` variants, linter hooks, per-group KB report
   against a 5 MB budget) -> `python tools/build_singlefile.py` ->
   `tools/run_smoke.py` + `run_render.py` (existing harness) to confirm the
   procedural-fallback paths still fire headlessly.
7. **QA loop** — regenerate the `preview_*.png` plates (the pack's existing
   preview convention) and eyeball at 100% *and* at 0.5x zoom; the 0.5x check
   is the minimap-adjacent reality (`minimap.js:7` flat colors are fine and
   stay).

**Do NOT:** ship raw satellite imagery (license + scale mismatch), add runtime
asset fetching (breaks single-file/offline), or remove the procedural
fallbacks (headless tests depend on them — `sprites.js:165-166`).

---

### Bottom line

- Biggest wins for the least work: **real coastline data** (§1),
  **shore-transition tile set** (§2), and **team-color masks** (§4) — the first
  two are mostly pack+data work with ~10-line bake changes.
- Units: LibreSprite/Aseprite templates over the Grok bulk method; Blender only
  where baked shading pays (air/naval). Real-ESRGAN is a zoom stopgap, not a
  quality strategy.
- Buildings: enforce silhouette-at-40px before any painting; give factions a
  real architecture language — 24 faction-unique structures already exist in
  data and are drawn as identical grey tiles today.
