# MCA — FULL GRAPHICS OVERHAUL (v5 "Cinematic Painted Pass") — Production Brief

You are the lead environment artist, vehicle artist, and VFX director for **MCA — Middle East Combat Arena**, a top-down real-time strategy game. Testers describe the current look as "1990s bitmap graphics". Your mission: deliver a **complete, cinematic, painted asset set** — every map terrain, every unit, every structure, every effect — at a quality bar where a zoomed-in MBT shows brushed armor, dust, and a glinting barrel, and a zoomed-out base reads like a concept-art establishing shot. Reference tier: *Age of Empires IV* terrain and unit readability, *They Are Billions* atmosphere, *Company of Heroes* vehicle materiality. **Hard bans: no pixel art, no flat-color vector tokens, no visible 256-color banding, no black outlines, no visible tiling repetition.**

---

## ATTACHMENTS (read all before generating anything)

1. **`manifest.json`** — the contract. 163 units (EG-01…IR-19 + MCV + HARV), 35 structures (SH-01…SH-35), effects, fx loops. **Every `id` and `radius` is law** — never rename, never renumber.
2. **`UNITS_CATALOG.md`** — id → faction/class/domain/name/role for all 198 assets. Generate per identity here (an M1A1 SA Ramses is an Abrams; a Shahed-136 is a delta-wing loitering munition; the INS Vikrant is a carrier).
3. **`preview_all_sprites.png` + `preview_8dir.png` + `preview_structures.png`** — the current pack: keep every silhouette/planform identity, repaint the surface.
4. **`preview_tiles.png`** — current terrain tiles (flat sand/rock/water — the #1 "1990s" tell; see TERRAIN below).
5. **`preview_battle_scene.png`** — how sprites sit on the map today.
6. **`01-keyart-mca.png`** + the 9 faction posters (`02`–`10`) — current marketing art tone; match its warm desert-dusk palette.
7. **`preview_pass2_identity.png`** — per-airframe/per-army differentiation reference (keep this discrimination, elevate the craft).

---

## DELIVER TO

`C:\KARIM\mca\artwork\units_v5\mca-assets-v2\` — create it, same layout as the current pack:

```
manifest.json                  ← same schema; ids/radius/names identical; update sizes; "style":"painted-v5"
sprites/units/{id}.png            163 masters, north-facing
sprites/dirs/{id}.png             163 × 8-frame strips  (N NE E SE S SW W NW, left→right)
sprites/wrecks/{id}.png           163 husks + 35 rubble piles
sprites/damaged/{id}.png          35 battle-worn structures
sprites/structures/{id}.png       35
sprites/effects/                  explosion_strip (10 frames) + explosion_0..3 + muzzle_flash + smoke + oil_derrick + proj_shell/missile/rocket/cannon
sprites/idle/SH-01.png            ConYard crane loop, 8 frames
sprites/fx/loop_{rotor,muzzle_smoke,radar,steam,flag,select,wake,pumpjack}.png   8 frames each
tiles/sand.png tiles/rock.png tiles/water_0..3.png tiles/decal_{dune,scrub,rock,foam}.png
icons/units/{id}.png 163 + icons/structures/{id}.png 35     (128×128 painted cameo plates)
posters/{Egypt,Saudi,UAE,Algeria,Turkey,Israel,India,Pakistan,Iran}.png   (720×400, repaint to new style)
keyart.png                        (1920×1080 menu hero, same scene language as 01-keyart)
menu_ambient.mp4                  (see VIDEO section)
preview_all_sprites.png preview_8dir.png preview_structures.png preview_tiles.png preview_battle_scene.png
SHOWCASE.md
```

---

## HARD TECHNICAL CONTRACT (violations = engine breaks; we will reject the batch)

- **PNG-32, RGBA**, transparent background, no baked ground plane.
- **Anchor: exact image center = entity position.** ~6% transparent margin all around.
- **Facing: north = up**; `sprites/units/{id}.png` is pixel-identical to strip frame 0.
- **Square frames**: every strip is exactly `frames × canvas_px` wide and `canvas_px` tall, all frames same silhouette (rotate + relight the master; never redraw per direction).
- **Resolution targets** (2× the 1.5-era sizes — this is the "not 90s" jump):
  - MBT / Light tank / Tank escort / SPG / MLRS / MCV / Harvester / Naval: **canvas_px 384**
  - IFV / APC / Light vehicle / Mobile AA / Helo / Fighter / Strike jet / Transport helo: **canvas_px 320**
  - Infantry squads / AT / AA / Engineer / SF / UAV / Missile TELs: **canvas_px 256**
  - Structures: **fp·64·2** (Def 256, normal 384, SW 512)
  - Record the real value per id in `manifest.json` (`canvas_px`, `strip`, `strip_frames: 8`, `wreck`, `damaged`, `icon`).
- **fx_loops**: 8 frames, square: rotor 240, muzzle_smoke 144, radar 192, steam 144, flag 120, select 192, wake 192, pumpjack 240. `explosion_strip`: 10 frames ≥320². Projectiles: ≥144², north-up.
- **File discipline**: no 4K monsters (cap masters at 2× target); clean alpha edges (no halo).

---

## ART DIRECTION — what "shiny moving armor" means

1. **Light:** one global sun, NW at ~60°, warm late-afternoon desert light (keyart palette). Painted cast shadows to the **SE**, soft, ~35% opacity, baked in. Add a **specular discipline**: armor gets one tight warm highlight edge (sun side) and cool sky reflection on glass/flat panels — this is what reads as "shiny" at RTS zoom.
2. **Materials:** brushed RHA steel with subtle plate seams and weld lines; rubber skirts; dusty tan/green camo per faction table below; canvas tarps with weave; periscope glass with sky gradient; accumulated dust on lower hulls and wheels; light edge wear (paint chips at hatches). Naval: weathered grey with rust streaks. Aircraft: panel lines, intakes, canopy glare stripe.
3. **Faction identity** — accent landmark in the EXACT hex, small and stable (turret ring stripe / wing tip band / tail flash / pennant), plus one motif:
   Egypt `#c8a23a` pharaonic gold chevrons · Saudi `#2e7d32` palm crest · UAE `#b03a2e` red-white-black fin flash · Algeria `#616161` grey-green star · Turkey `#d32f2f` red crescent tail flash · Israel `#1565c0` blue Star-of-David roundel · India `#ef6c00` orange-white-green band · Pakistan `#00695c` teal crescent · Iran `#6a1b9a` purple-black wave. Structures carry the accent on door frames/roof trim.
4. **Motion feel baked into stills:** suggest power — tanks slightly squat with visible suspension travel, helicopters with drooped rotors, jets with heat shimmer behind exhausts (subtle painted streak).
5. **Terrain (the biggest visual leap):**
   - `sand.png` 64² seamless painted desert: warm `#b8a06a` base, gentle wind-streak noise, subtle pebble speckle, NO visible tiling at 4×4 repeat (make it near-constant luminance, variation in hue ±4%).
   - `rock.png` 64²: layered sedimentary warm grey-brown with cracks.
   - `water_0..3.png` 64² ×4 frames: deep `#2a5c8a`, painted gentle swell with moving specular streaks, consistent landmarks so the loop doesn't slide.
   - `decal_dune.png` 96×48 soft dune ridge · `decal_scrub.png` 48² dry bush cluster · `decal_rock.png` 48² outcrop · `decal_foam.png` 96×24 white surf edge (translucent).
6. **Wrecks:** same silhouette collapsed/burned, rust-multiplied, scorched center, thin baked smoke wisp. `damaged`: battle-worn building — roof holes, blackened walls, still unmistakably the same structure.
7. **Icons:** 128² painted cameo plates — dark bronze plate, faction rail, class pip, 3/4 portrait repaint (NOT a downscale).
8. **Posters + keyart:** repaint the 9 faction briefing posters and the 1920×1080 keyart in the new style (same layouts/composition as current).

## WORKFLOW (batches of ~15–20 ids; self-QA each batch)

1. North master at target size (generate at 2× then Lanczos down) → reject backgrounds/wrong facing/off-center → regenerate.
2. Derive 8-frame strip (rotate + relight + SE shadow), wreck, icon from the SAME master so identity carries.
3. Append to `preview_all_sprites.png`; run the **48-px gate**: shrink to 48 px — if unit class AND faction aren't instantly readable, repaint.
4. Terrain first (it frames everything), then vehicles, then aircraft, then infantry, then structures, then FX/loops, then posters/keyart, then video.

## VIDEO (use your video-generation plugin)

- **`menu_ambient.mp4`**: 8–10 s **seamless loop**, 1280×720: cinematic slow push over a desert base at dusk — idle tanks with heat shimmer, a flag moving, distant rotor shimmer; match keyart palette. No text, no logos. We use it as the main-menu background.
- Optional: generate a 2 s straight-down water clip and export its frames as the 4 `water_*.png` frames (only if it beats painting them by hand for motion coherence).

## DELIVERY CHECKLIST (we verify mechanically — a missing id fails the whole batch)

- [ ] `manifest.json` parses; ids/radius/names identical to the attached v4 manifest
- [ ] 163 units + 35 structures present in every applicable folder; strips are 8× square frames, north-up
- [ ] All frame counts/sizes match manifest; no PNG over 2× target canvas
- [ ] 5 preview sheets + SHOWCASE.md + posters + keyart + menu_ambient.mp4
- [ ] 48-px identity gate passed on all 198 assets (document the result in SHOWCASE.md)
- [ ] No visible quantization banding anywhere (full-color gradients preserved)

## INTEGRATION (already handled — you touch no game code)

Our build detects `artwork/units_v5/` automatically and inlines it **without palette quantization** at full color — directional frames, wrecks, damaged states, cameos, terrain tiles, loops, posters, and the menu video hook are all already wired. Deliver the folder and we rebuild.
