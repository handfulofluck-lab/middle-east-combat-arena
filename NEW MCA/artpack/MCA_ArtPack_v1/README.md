# MCA Art Pack v1 — for Kimi Code

Drop this folder next to `MCA.html` v0.3.4 and give Kimi **KIMI_PROMPT.md**.

## Why a separate reservoir

Units and structures already live in `__INLINE_DATA` (the ASH-SHARQ sheet).
That sheet is balance truth: ids, cost, HP, tech.

**Display names and sprites are not balance.** They change when you rename
“War Factory” to “Abu Zaabal Works” for Egypt. Those edits belong in
`data/display.json`, the same way weapons belong in the unit sheet.

Resolution order used by `integration/display.js`:

1. `aliasByFaction[ownerFaction]`  →  Egypt CY reads **Nile Yard**
2. `defaultName`                   →  Construction Yard
3. sheet `name`                    →  whatever ASH-SHARQ has

Sim ids (`SH-01`, `EG-07`) never change.

## Contents

| Path | What |
|---|---|
| `data/display.json` | All structure aliases, HUD shorts, flavor names, unit HUD overrides |
| `data/sprite_map.json` | Atlas coordinates for 66 frames |
| `sprites/atlas.png` | 512×576 sheet, 64px cells, 22 KB |
| `sprites/atlas.webp` | Same frames |
| `sprites/cells/*.png` | One 64×64 per key |
| `integration/display.js` | Lookups + `loadAtlas` + `drawFrame` |
| `KIMI_PROMPT.md` | Exact wiring instructions |
| `preview.html` | Open locally to see the atlas and name table |

## Sprite keys

- Structures: `SH-01` … `SH-35`
- Unit classes: `cls-infantry`, `cls-mbt`, `cls-fighter`, … (see sprite_map)
- Faction emblems: `fac-egypt`, `fac-saudi`, …

v1 does **not** ship a unique painting per unit id. At 24–32px on the map,
class tokens + owner color read better than 161 near-identical tanks.
Add `frames["EG-07"]` later if you paint a Ramses-specific cell.

## Size

Atlas PNG 22 KB. Inlined base64 ≈ 30 KB on top of the ~600 KB game file.
Safe for the single-file build.

## Edit names without Kimi

Open `data/display.json`, change an alias, rebuild (or paste the JSON into
`__INLINE_DISPLAY`). Example:

```json
"SH-01": {
  "aliasByFaction": {
    "Egypt": "Nile Yard"
  }
}
```
