# Kimi Code — integrate MCA Art Pack v1 into MCA.html v0.3.4

You are editing the existing single-file greybox. **Do not change the sim.**
Art and names are data. If a sprite or alias is missing, fall back to the
current silhouette + `def.name`. Never throw.

## What this pack is

```
MCA_ArtPack_v1/
  data/display.json      ← name reservoir (like the unit sheet)
  data/sprite_map.json   ← atlas frame rects
  sprites/atlas.png      ← 8×9 cells, 64px, 22 KB
  sprites/atlas.webp     ← same frames (optional)
  sprites/cells/*.png    ← one file per key, if you prefer not to pack an atlas
  integration/display.js ← drop-in helpers (copy into src/game/display.js)
```

Inline both JSON blobs and the PNG (base64) next to `__INLINE_DATA`, e.g.

```js
const __INLINE_DISPLAY = { ...contents of data/display.json... };
const __INLINE_SPRITE_MAP = { ...contents of data/sprite_map.json... };
const __ATLAS_PNG_B64 = "..."; // sprites/atlas.png
```

Add them in `tools/build_singlefile.py` the same way units/structures are inlined.
Do **not** `fetch()` anything. The game stays a double-click HTML file.

## Names live in the reservoir — not in `structures[].name`

Keep sheet `name` as the design-doc name (ASH-SHARQ). HUD / selection / build
tiles resolve through `__INLINE_DISPLAY`:

```
structureLabel(defId, ownerFaction):
  rec = display.structures[defId]
  return rec.aliasByFaction[ownerFaction]
      || rec.defaultName
      || sheetName

structureHud(defId):
  return rec.hud || initials

unitHud(unitId, cls, sheetName):
  return display.unitHudOverrides[unitId] || sheetName
```

`initialsFor()` must read the **resolved label**, not the raw sheet name.

Editing a building name later = edit `display.json` (or the inlined copy) and
rebuild. No sim touch.

## Sprites

Boot, once:

```js
async function loadAtlas(game) {
  try {
    const img = new Image();
    img.src = 'data:image/png;base64,' + __ATLAS_PNG_B64;
    await img.decode();
    game.atlas = await createImageBitmap(img);
    game.spriteMap = __INLINE_SPRITE_MAP.frames;
  } catch (e) {
    console.warn('atlas failed, greybox fallback', e);
    game.atlas = null;
    game.spriteMap = {};
  }
}
```

Call `loadAtlas` from `boot()` **before** the first `renderFrame`. If it
fails, the match still starts.

Resolve a frame:

```
structure: spriteMap[defId]
unit:      spriteMap[unitId]           // none in v1
        || spriteMap['cls-' + token]   // token from sprite_map.resolveUnit.classTokenFromSheet[def.cls]
        || null
```

Draw:

- If frame + atlas: `ctx.drawImage(atlas, sx, sy, sw, sh, dx, dy, dw, dh)`
  then a 2px `ownerColorOf` stroke. Skip initials when camera.zoom < 0.7.
- If no frame: existing `shapeForUnit` / `shapeForStructure` path. Unchanged.
- HUD `.bb-glyph`: same frame at 26×26. If no frame, keep CSS `.bb-shape`.
- Do **not** allocate a canvas per entity per frame.
- Optional tint cache key = `frameKey + color`, max 128 entries.

Minimap stays dots. Fog, placement ghost, selection brackets stay.

## Files you may touch

- `src/game/display.js`   (new — copy integration/display.js)
- `src/game/sprites.js`   (resolve label + frame key only)
- `src/game/render.js`    (drawImage when frame exists)
- `src/game/hud.js`       (tiles + selection names via display.js)
- `src/game/menu.js`      (faction picker can show emblem `fac-<faction>`)
- `tools/build_singlefile.py`
- `src/main.js`           (await loadAtlas)

Do **not** touch `src/sim/**`. Checksum of an 80-tick Duel must match pre-change.

## Perf budget

- Atlas is 22 KB PNG. Base64 adds ~30 KB to the HTML. Acceptable.
- One `Image.decode` at boot. Zero decodes on the 10 Hz tick / rAF.
- No extra full-map scans.
- `frameErrors` must stay 0 after a 4x Coast match with ~80 units.

## Tests before you stop

1. Atlas present: CY, PP, barracks, rifle (`cls-infantry`), tank (`cls-mbt`),
   jet (`cls-fighter`) draw frames. Egypt CY selection title = **Nile Yard**.
2. `__ATLAS_PNG_B64 = null`: identical to v0.3.4 greybox, no throw.
3. Change `display.structures['SH-04'].aliasByFaction.Egypt` to `"Test Hall"`,
   rebuild, confirm HUD updates. Sim ids unchanged.
4. Fog, placement, pause chrome, checksum unchanged.
5. Unique buildings (SH-12…SH-35) use their own frames.

If unsure, ship fallback + names only. Do not invent a second renderer.
