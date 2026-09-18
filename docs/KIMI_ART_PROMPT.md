# MCA — Graphics v5 ("Painted Pass") — Brief for Kimi AI

You are the art director and production artist for **MCA — Middle East Combat Arena**, a
real-time strategy game played from a top-down camera at 0.16×–2.5× zoom. Your job:
replace the current sprite pack with a **painted, modern-RTS art set** — the quality bar is
*Age of Empires IV / They Are Billions*-tier top-down assets. **No pixel art. No flat vector
tokens. No visible quantization.** Full-color painterly sprites with soft baked shadows,
readable materials, and per-faction identity that survives being rendered at 48 px.

## Read first (source of truth)

1. **Contract + inventory:** `C:\KARIM\mca\artwork\units_v4\mca-assets-v2\manifest.json`
   — 163 units (incl. MCV, HARV), 35 structures, 7 effects, fx_loops, posters.
   Every `id` (EG-01 … IR-19, SH-01 … SH-35), `name`, `faction`, `class`, `domain`,
   `radius`, `canvas_px` there is **law**: ids and `radius` must not change.
2. **Unit identity reference:** `C:\KARIM\mca\artwork\units_v4\mca-assets-v2\preview_*.png`
   and the per-id PNGs — same silhouettes/planforms (an M1A1 reads as an M1A1, a TB2 as a
   TB2), but repainted in the new style.
3. **Real names/roles:** `C:\KARIM\mca\client\data\game.json` — `units[]` names and roles
   per id (e.g. EG-07 "M1A1 SA Ramses", cls MBT) and `structures[]`.
4. **Faction accent colors** (must match exactly — they tint rings/underlines in-game):
   Egypt `#c8a23a` · Saudi `#2e7d32` · UAE `#b03a2e` · Algeria `#616161` · Turkey `#d32f2f` ·
   Israel `#1565c0` · India `#ef6c00` · Pakistan `#00695c` · Iran `#6a1b9a`.
   All factions `#8a94a6`.

## Write to (delivery folder — create it)

`C:\KARIM\mca\artwork\units_v5\mca-assets-v2\` — **same folder layout as v4**:

```
manifest.json            ← copy v4's schema; same ids; update paths/sizes; add "style":"painted-v5"
sprites/units/{id}.png        (163, north-facing master — also frame 0 of the strip)
sprites/dirs/{id}.png         (163, 8-frame strips: N NE E SE S SW W NW left→right)
sprites/wrecks/{id}.png       (163 unit husks + 35 structure rubble = 198)
sprites/damaged/{id}.png      (35 structures, battle-worn ~50% state)
sprites/structures/{id}.png   (35)
sprites/effects/*.png         (explosion_strip 10 frames, explosion_0..3, muzzle_flash, smoke, oil_derrick, proj_shell/missile/rocket/cannon)
sprites/idle/SH-01.png        (ConYard crane loop, 8 frames)
sprites/fx/loop_*.png         (rotor, muzzle_smoke, radar, steam, flag, select, wake, pumpjack — 8 frames each)
icons/units/{id}.png          (163, 128×128 painted cameo plates)
icons/structures/{id}.png     (35)
preview_all_sprites.png, preview_battle_scene.png, preview_8dir.png, preview_structures.png
SHOWCASE.md                   ← what you made, per-group notes, any ids you changed style rationale for
```

## Hard technical contract (the engine reads these — breaking them breaks the game)

- **PNG-32, alpha transparency**, RGB or RGBA, no baked background.
- **Anchor: image center = entity position.** Content must be visually centered; keep a
  ~6% transparent margin.
- **Facing: north = up** on frame 0 of every strip; `sprites/units/{id}.png` = same image
  as strip frame 0.
- **Square frames.** `sprites/dirs/{id}.png` is exactly `8 × canvas_px` wide and
  `canvas_px` tall. Recommended `canvas_px`: **320 for vehicles/MBT/ships/MCV, 256 for
  infantry/AA/UAV, 384 for structures** (fp·64 at 2×). Record the real value in
  `manifest.json` per id (`canvas_px`, `strip: "sprites/dirs/{id}.png"`, `strip_frames: 8`,
  `wreck`, `damaged`, `icon`).
- **fx_loops**: keep the same 8 keys with `strip_frames: 8`, square frames; recommended
  `frame_w`: rotor 200, muzzle_smoke 120, radar 160, steam 120, flag 100, select 160,
  wake 160, pumpjack 200. `explosion_strip`: 10 square frames (256+).
- **Deterministic geometry**: silhouette identical across all 8 frames of a strip
  (rotate your painted master, relight consistently; do not redraw per frame).
- Icons: 128×128 with the same painted look on a dark plate (faction rail + class pip);
  not a raw downscale of the world sprite — repaint for portrait composition.

## Art direction (what "fancy" means here)

- **Lighting:** one global sun, from the **north-west at ~55–65° elevation**, soft warm
  desert light; painted cast shadow falls **south-east**, semi-transparent, soft-edged,
  baked into the sprite (the engine does not draw shadows).
- **Materials:** readable at a glance — brushed steel, rubber skirts, canvas tarps, dusty
  desert camo (tan/green variants per faction), glass canopies with sky reflection, rust
  and wear at edges. Vehicles get dust accumulation on lower hulls.
- **Painterly, not photographic:** visible confident brushwork, clean color separation,
  subtle gradients — never airbrush-muddy, never flat fills, never black outlines.
  Crisp edges where silhouettes matter (barrel, wing, prow), soft where light wraps.
- **Faction identity:** accent color appears on a **small stable landmark** — turret ring
  stripe, wing tip band, tail flash, hull pennant — never flood-filled. Plus 1–2 design
  motifs per faction (Egypt: pharaonic gold chevrons; Israel: blue-white star roundel;
  Iran: purple-black wave; Turkey: red crescent tail flash; Saudi: green palm crest;
  UAE: red-white-black fin flash; Algeria: grey-green star; India: orange-white-green band;
  Pakistan: teal crescent).
- **Scale discipline:** MBTs must feel heavy (low, wide), buggies light (narrow, tall
  suspension), jets sleek; infantry squads = 3–5 figures with gear readable (rifle/AT
  tube/SAM tube/engineer pack/NVG for SF).
- **Readability gate:** shrink each sprite to 48 px — if you can't tell what it is and
  which faction owns it, repaint. Run this gate yourself before delivery.
- **Wrecks:** same silhouette, flattened/burned, rust-multiplied, scorched center,
  optional thin smoke column baked in. Structures collapse into debris piles.
- **Damaged:** same building, holes in roofs, blackened walls, one corner collapsed —
  still clearly the same structure.

## Workflow (use your image-generation plugins; batches of ~20 ids)

1. Per unit: generate the **north-facing master** at the target `canvas_px` (or 2× and
   downscale with Lanczos). Reject any result with background artifacts, wrong facing, or
   non-centered anchor — regenerate.
2. Derive the 8-frame strip from the master (rotate per frame, relight consistently,
   re-render shadows SE). Keep the exact silhouette.
3. Derive wreck (deconstruct + burn) and icon (repaint portrait) from the same master so
   identity carries through.
4. Per structure: master + damaged + rubble + icon. SH-01 also gets the 8-frame crane
   idle strip.
5. After each batch: append to `preview_all_sprites.png` contact sheets; do the 48 px
   identity gate on every asset.
6. Terrain (bonus, same folder): painted `tiles/sand.png`, `tiles/rock.png` (64×64
   seamless, warm desert, subtle noise — NOT flat color), 4 `tiles/water_0..3.png`
   frames (gentle swell, consistent hue #2a5c8a), `tiles/decal_{dune,scrub,rock,foam}.png`.
   These replace the current flat tiles directly.
7. **Video plugin (optional garnish):** a 6–10 s seamless ambient clip for the main menu
   background (desert base at dusk, vehicles moving) — export as `menu_ambient.mp4`
   (1280×720, loopable). Also fine: derive the 4 water frames from a short generated
   water clip if that yields better motion.

## Manifest + delivery checklist (fail = reject the batch)

- [ ] All 163 unit ids, 35 structure ids present in every applicable folder
- [ ] `manifest.json` parses; ids/radius/names match v4 exactly; sizes match real PNGs
- [ ] Every strip is 8× square frames, north-up, center-anchored
- [ ] No PNG exceeds 2× its target canvas (no 4K bloat); no quantization banding visible
- [ ] 4 preview sheets + SHOWCASE.md delivered
- [ ] 48 px identity gate passed for all 198 assets
- [ ] Faction accent landmarks present and color-correct on all 163 units

## Integration promise (already done on our side — you change nothing in the game)

The build pipeline auto-detects `artwork/units_v5/`, inlines it **without 256-color
quantization** (no banding) at slightly higher resolution, and the engine renders it
with zero code changes — directional frames, wrecks, damaged states, cameos, idle loops
and terrain tiles all flow through the existing contract. Deliver the folder above and we
rebuild.
