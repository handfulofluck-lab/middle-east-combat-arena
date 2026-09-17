# MCA v0.3 — “It fights back”

You are implementing the next milestone of **MCA — Middle East Combat Arena**, an offline greybox HTML RTS.

Work in the **source tree** (`client/src/…`, `tools/build_singlefile.py`, sheet data). Do **not** hand-edit the generated single-file `MCA.html` except to rebuild it at the end.

Current version in the bundle: `0.2.0`. Bump data/version to `0.3.0` when done.

---

## What this game already is (do not regress)

Deterministic 10 Hz sim. Commands apply after `CMD_DELAY`. UI never mutates sim state; it only pushes command objects onto `pendingCmds`. Seeded RNG (`src/sim/rng.js`). Integer / milli-progress economy. Fog, minimap, SC2-style build bar, placement snap + block reasons, control groups, rally (client-side), speed 1/2/4x, pause, MCV deploy hint.

Sim command types today: `move`, `attackMove`, `stop`, `attackTarget`, `deployMCV`, `buildStructure`, `placeStructure`, `trainUnit`, `useSuperweapon`, `useFactionAbility`.

Key files:

- `src/sim/state.js` — match factory, units/structures, fog, helpers
- `src/sim/orders.js` — validate + apply commands, `canPlace`, `passable` callers
- `src/sim/engine.js` — `tick`, `movementSystem`, `passable`, `eliminationSystem`
- `src/sim/combat.js` — `combatSystem`, `fireVolley`, `dealDamage`, SW / abilities
- `src/sim/economy.js` — power, queues, oil income
- `src/sim/ai.js` — AI issues the same commands as a player
- `src/game/input.js`, `hud.js`, `menu.js`, `render.js`, `placement.js`, `rally.js`, `main.js`

Data: `__INLINE_DATA` / `game.json` — `knobs`, `factions`, `units`, `structures`. Units have `wave`, `ability`, `dmg.{inf,light,armor,air,bldg}`, `cls`, `domain`. Structures have `type`: Core / Eco / Prod / Tech / Def / Unique / SW.

**Do not** add factions, art pipelines, multiplayer, campaigns, or 80 unit abilities. Implement the verbs below.

---

## Goal of 0.3

After this milestone a first session must include: deploy CY → eco → produce → **towers that shoot** → **units that cannot walk through buildings** → **readable fights** → **harvester you can raid** → **engineer that repairs** → **AI that defends its yard and takes a second oil**.

Ship these items. Nothing else unless a listed item requires it.

---

## 1. Defensive structures fire

**Problem:** `combatSystem` only iterates `state.units`. HMG nest, ATGM tower, AA gun, and faction SAM/Unique batteries (`SH-09`–`SH-11` plus faction `type === 'Def'` and SAM-like Unique) are inert HP blocks. Superweapon intercept already exists for some SAMs; ground fire does not.

**Do:**

- Add compact combat stats onto structure defs (prep at match start, same style as `prepUnitDef`):
  - `SH-09` HMG: short range, high `inf` / low armor, fast ROF
  - `SH-10` ATGM: long range, high `armor`, slow ROF
  - `SH-11` AA: medium range, high `air`, modest vs helo
  - Faction SAM / Dome / Patriot / S-400 / Bavar / Hisar / Siper / Arrow / Akash / HQ-9: long range, high `air`, poor vs tanks
- Reuse `fireVolley` / `dealDamage` / `dmgColumn`. Structures use owner player multipliers. No veterancy on buildings.
- Scan for enemies on a slower cadence than units (e.g. every 5–10 ticks) using structure center + `rangeWu`.
- Prefer domain-appropriate targets: AA/SAM skip Soft infantry if any Air is in range; ATGM prefers Heavy/Medium; HMG prefers Soft/Light.
- Visual: 1-frame tracer from structure center to target (see §3).

Do **not** make Eco/Prod/Core/SW auto-fire.

---

## 2. Ground movement blocked by buildings (and rocks already)

**Problem:** `passable()` in `src/sim/engine.js` only checks terrain. Land units walk through ConYards and each other.

**Do:**

- Ground (`domain === 'Land'`): cell must be terrain `0` **and** not inside any structure footprint.
- Sea: terrain `2` only; still blocked by naval-yard footprints if you occupy land cells.
- Air: unchanged (any in-bounds terrain).
- Keep the existing one-axis slide around blocked cells.
- Soft unit-unit separation is optional. If you add it, keep it cheap: skip if > N units, no physics solver.
- `canDeployAt` / `canPlace` already reject occupied footprints — do not break that.

---

## 3. Attack-move, idle acquire, readable shots

**Problem:** Idle units do not chase. Acquisition is sparse. Hitscan has no tracer, so fights are two blobs melting.

**Do:**

- `attackMove`: if `enemyId` set and target alive, close to `rangeWu` and fire; if target dies, clear `enemyId` and keep walking to the attack-move point while scanning.
- `idle`: scan; if target found within sight, set a short chase (do not wander the whole map). Drop chase if target leaves ~1.5× sight or dies; return to the position where idle began if you add a guard anchor — otherwise just stop.
- `attackTarget`: keep current hard lock.
- Every successful `fireVolley` (and structure shot) spawns a short-lived render-only tracer **or** a sim projectile with `ticksLeft: 1–2` and `dmg: 0` if you want it in checksum-safe state. Prefer a client-only list on `game` (e.g. `game.tracers[]`) populated by observing hp/cooldown changes **or** a tiny `kind: 'tracer'` projectile that deals no extra damage. Do not double-apply damage.
- Draw tracers in `render.js` as a 1–2 frame line, color by owner.

---

## 4. Apply sheet combat knobs that are currently dead

In `fireVolley` / structure fire, after `armorIncoming` and vet mult, apply:

- `AirVsArmor` when shooter `domain === 'Air'` (or cls Attack helo / Strike) and target armor is Medium/Heavy
- `ATGMVsArmor` when shooter `cls` contains `AT` or ability/role is ATGM, target Medium/Heavy
- `ArtyVsBuilding` when shooter cls is SPG/MLRS (or dmg.bldg is their identity) and target is a structure
- `DronePaint` (seconds or cells — pick one and document): Turkey `siha_mesh` already sets `aggroAirMult`. Also: if a friendly UAV of that owner has seen the target recently, add a small incoming-damage bonus or extra sight vs that target. Keep it one obvious rule.

Pakistan faction perk `econPerk.type === 'unit_build_speed'` + `unit_name` is **not applied** in `progressRate`. Apply it when the queued unit’s name/id matches.

Remove nothing from the sheet. Do not invent new knobs unless required.

---

## 5. Harvesters actually harvest

**Problem:** Oil income is “depot + living HARV token.” HARV never moves. `HarvesterCost` is unused.

**Do:**

- Each `SH-03` still spawns a HARV.
- HARV orders: move to nearest oil field world pos → dwell ~2s → move to own depot center → add a lump or keep the existing per-tick income **only while HARV is near its depot after a trip**. Simplest robust rule that still looks like harvesting:
  - Income tick requires HARV hp > 0 **and** HARV within ~3 cells of its depot **or** within ~3 cells of an oil field (either is fine if documented).
  - Better: `harvesting` flag set when in range of oil, cleared at depot; milli-credits granted on depot touch.
- If HARV dies, depot income stops until the player trains a replacement.
- Make `HARV` trainable from War Factory (or a “replace harvester” action on the selected depot) at `knobs.HarvesterCost`, no tech gate, owner faction `All`.
- AI: if a depot has no living HARV and credits ≥ cost, train HARV.

Do not implement a full resource-chunk carry model unless it stays tiny.

---

## 6. Engineer repairs (capture can wait)

**Problem:** Engineer `ability: Capture / repair` is flavor. `capture` is unused.

**Do this milestone:**

- Engineer (`cls === 'Engineer'`): if idle or attackMove near an allied damaged structure/unit, apply repair per tick (e.g. `max(1, maxHp * 0.01)` per 10 ticks) while in range `rangeWu`.
- Do not let engineers deal combat damage (sheet dmg is already 0).
- Optional stub only: if you have time, “capture” starts a progress bar on a hostile structure in range and flips `owner` after ~8s uninterrupted. If not done cleanly, **skip capture** rather than ship a buggy owner flip.

Show repair with a small green tick or `+` on the target in render when a nearby allied engineer is repairing it.

---

## 7. Queue cancel + camera + menu pause

**HUD / input**

- Right-click a queued build-bar tile, or a “Cancel” on the selected producer’s queue head, issues a new command `cancelProduction` that:
  - refunds **full** credits for the cancelled item
  - removes that queue entry (prefer tail-cancel on repeated right-click; also allow cancelling the active head)
  - works for both `player.buildQueue` (structures) and `structure.queue` (units)
- `Space`: center camera on current selection centroid (units + structures); if selection empty, center on own CY or MCV.
- `Home`: center on own CY / MCV.
- `WASD`: same pan as arrow keys (do not steal `A` from attack-move — use arrows + WASD only if `A` remains attack-move; so **do not bind A to pan**. Bind `W S` carefully: `S` is Stop. Therefore:
  - Pan: Arrow keys + edge scroll + middle-drag stay.
  - Add `Z`/`X` or `Q` is already build hotkey.
  - **Do not remap WASD** if it fights QWER / S / A. Instead add `Space` / `Home` and keep arrows.
  - If you add extra pan keys, use `J K` or hold `Shift`+arrows for faster pan — do not steal `A`/`S`/`D`.

**Menu**

- `Menu` button during a match **pauses** the sim (`game.paused = true`).
- Overlay: Resume · Restart · Abandon to main menu (Abandon must confirm).
- Opening the setup menu must not keep ticking the live match underneath.
- Offline only: set `CMD_DELAY` to `0` when there is no remote peer (always, in this build). Keep the constant and a comment so netcode can restore `3`.

**Control groups:** `Ctrl+digit` assigns (existing). `Shift+digit` **adds** current selection to that group.

**Hotkeys:** build grid is only `Q W E R T F G` (7). Add a second row `Z X C V B N M` for items 8–14 **or** `Tab` cycles pages inside the active tab. `B` already focuses the structures tab — keep that; if `B` is in the second row, keep `B` as tab-focus when the structures tab is not already using it as a tile hotkey. Prefer `Tab` paging over stealing `B`.

---

## 8. Gate faction identity on Unique buildings + show perks

**Problem:** `SH-12` Sa'ka Tent, `SH-33` Drone Workshop, `SH-29` Cruise Battery, etc. do nothing. Actives can fire with only a CY. Pakistan JF-17 perk is dead.

**Do:**

- `saka_insertion` (Egypt): `validateCommand` fails with `reason: 'no-unique'` unless a standing `SH-12` exists for that player.
- `shahed_rain` (Iran): require standing `SH-33`.
- `brahmos_lane` (India): require standing `SH-29` (Cruise Battery) if that is the intended gate; if `SH-29` is wrong, gate on India’s Unique/SW that matches the ability. Document the choice in a comment.
- Other actives (`rsaf_tasking`, `babur_window`): gate on that faction’s Unique or SW if one exists; otherwise leave as-is.
- Passives stay always-on (`edge_network`, `integrated_sky`, `siha_mesh`, `iron_layer`).
- Draw `brahmos_lane` as a telegraph line for ~10 ticks so the corridor is readable.
- Superweapons: keep intercept. Differentiate payload slightly using existing names — do not write 9 new systems:
  - default: current 6×400
  - Algeria Hellwind / Iran Raad: more projectiles, smaller radius
  - UAE / Saudi: fewer projectiles, tighter radius, higher dmg
  - Pakistan / India cruise flavour: already interceptable; keep that
- Faction picker in `menu.js`: under each name show perk + active in one line, e.g. `Egypt — −20% CY rebuild · Sa'ka drop (needs Tent)`.

Use `wave` **or** existing `cost >= 1400` tech gate — do not leave both unexplained. Preferred: `WAVE0` trainable without `SH-08`; `WAVE1`/`WAVE2` require `SH-08`. If a unit has no wave, fall back to cost gate.

---

## 9. AI: second oil, defend CY, replace power, replace HARV

`src/sim/ai.js` — still emit the same command objects. Private AI RNG stays.

**Add, in `think` order after place-ready / build-order:**

1. If no CY and an MCV exists → `deployMCV` (already).
2. If `lowPower` → insert `SH-02` (already partially there). Keep it.
3. If fewer than 2 owned `SH-03` (standing or queued or ready) and an unused oil field is placeable → queue/place another depot via `findDepotPlacement`.
4. If a depot’s `harvesterId` is dead → `trainUnit HARV` when affordable.
5. **Defend:** if any hostile unit is within 12 cells of own CY (or any Core/Prod), `attackMove` a subset of idle combat units (not HARV/MCV) to that point. Do this even off the wave timer.
6. Keep ~2 cheapest combat units home; do not send 100% of army on the timed wave.
7. Fortress: after factory, queue `SH-09`, `SH-10`, `SH-11` (or faction Def) at least once each and place them near CY.
8. Sky: must include `SH-06` and at least one AA unit or `SH-11`.
9. Still no CY-rebuild requirement this milestone (human perk exists; AI rebuild is optional). If easy, allow AI one `SH-01` rebuild when `cyRebuilt` is false.

Do not raise Marshal income further. Difficulty stays think-interval + this behavior.

---

## 10. Buildings get distinguishable shapes (same greybox language as units)

**Problem:** Units already map to canvas shapes in `src/game/sprites.js` (`shapeForUnit`: air = triangle, sea = diamond, infantry = circle, vehicles = square). Structures in `render.js` are **all axis-aligned rectangles** plus initials. HUD structure tiles use a generic square. At a glance a power plant, SAM battery, and ConYard are the same blob.

**Do:** add `shapeForStructure(def)` next to `shapeForUnit` and use it in the world renderer, placement ghost, build-bar glyphs, and selection-panel glyphs.

### Shape vocabulary (no spritesheets)

Map `def.type` first, then special-case ids:

| type / id | shape name | how to draw |
|---|---|---|
| `Core` (`SH-01`) | `octagon` | largest; regular octagon inscribed in the footprint so it cannot be mistaken for a factory |
| `Eco` power (`SH-02`) | `hexagon` | 6-sided “plant” |
| `Eco` oil (`SH-03`) | `barrel` | upright rounded-rect / capsule |
| `Prod` barracks (`SH-04`) | `chevron` | rectangle with a V-notch on the south edge |
| `Prod` factory (`SH-05`) | `rect` | plain square (the *building* square; vehicles stay the smaller unit square) |
| `Prod` airfield (`SH-06`) | `runway` | elongated diamond, or rectangle with a triangle nose pointing north |
| `Prod` naval (`SH-07`) | `dock` | diamond (same family as sea units) with one flat edge |
| `Tech` (`SH-08`) | `diamond` | tall kite / diamond |
| `Def` HMG (`SH-09`) | `bunker` | low trapezoid |
| `Def` ATGM (`SH-10`) | `spike` | triangle pointing north |
| `Def` AA / faction SAM (`SH-11` + other `type === 'Def'`) | `radar` | circle with one short radial tick (dish) |
| `Unique` | `star` | 4-point star (rotated square with inset) |
| `SW` | `star-sw` | larger 4-point star with an inner square; pulse the stroke when `swChargeTicks === 0` |

Rules:

- One helper: `traceStructShape(ctx, shape, x, y, half)` parallel to existing `traceShape` for units.
- World view: fill `ownerColorOf`, dark stroke, initials centered — only the silhouette changes.
- Sim footprint (`fp`) is unchanged. Draw the silhouette **inscribed in** the footprint square so placement and collision stay grid-aligned.
- Placement ghost uses the same silhouette (legal = green fill, blocked = red), not a plain rect.
- HUD `.bb-shape` for structures uses the new shape. CSS `clip-path` is enough for hex / octagon / diamond / star / circle. Add 2–3 extra classes for `runway`, `bunker`, `barrel`. Units keep `shape-circle | shape-triangle | shape-diamond | shape-square`.
- Selection glyph (18×18) uses the same shape — stop using a rounded square for every building.
- Minimap may stay as dots/squares. Optional cheap variant: square = Core/Prod, circle = Def, diamond = Eco.

Do not add bitmaps or per-faction building art. Silhouette + initials + owner color is the whole language.

---

## Render / HUD extras (keep greybox)

- Role tint or outline so infantry / armor / AA / air / arty parse at a glance (shape+initials stay).
- Buildings use `shapeForStructure` silhouettes from §10 — required, not optional polish.
- Selection panel for a single selected unit/structure: name, HP, armor or type, range, existing soft/hard counter line from the sheet.
- Left-click a **fog-visible hostile** inspects it in the selection panel (does not steal selection of your army unless you click empty space). Implementation: `game.inspectId` separate from `game.selection` is fine.
- Cursor: default crosshair; placement / targeting / attack-move each get a distinct `document.body` class you already pattern-match with `body.placing`.
- Minimap under-attack pings already exist for new buildings; ping when an owned structure takes damage (throttle 2s).

No audio required in 0.3. If trivial, one “under attack” is enough — skip if it needs an asset pipeline.

---

## Constraints

- Keep state serializable: integers, strings, plain objects, `Uint8Array` fog. No `Math.random`, no `Date` in sim.
- All new player/AI actions go through `validateCommand` / `applyCommand`.
- Do not break headless-pure HUD helpers (`trainButtonState`, `buildGridItems`, …).
- Do not edit generated single-file output by hand; rebuild with the existing packer.
- Small functions, same comment voice as the current modules.
- If a listed ability cannot be done cleanly in one function, stub the validate reason and leave a `// 0.4` comment rather than shipping a desync.

---

## Done when

A human can:

1. Deploy MCV, build power + 2 oil + barracks + HMG tower.
2. Watch the HMG kill incoming infantry.
3. See units walk **around** the CY, not through it.
4. See tracers when tanks fire.
5. Kill the enemy HARV and watch their income stall.
6. Repair the CY with an engineer.
7. Right-click a queued tank to refund it.
8. Hit Space to jump to the army.
9. Open Menu and see the match frozen.
10. Play Egypt and be told Sa'ka needs the Tent; after placing it the drop works.
11. Fight Recruit Front AI that takes a second oil and reacts when you raid the CY.
12. Distinguish CY / power / oil / barracks / factory / airfield / tower / unique / SW by silhouette alone, including on the build bar and the placement ghost.

Rebuild the single-file bundle and sanity-check boot (no `Boot error`).

---

## Implementation order

1. `passable` + structure fire + tracers (`engine.js`, `combat.js`, `render.js`)
1b. `shapeForStructure` + `traceStructShape` in world render, placement ghost, HUD tiles, selection glyphs (`sprites.js`, `render.js`, `hud.js`)
2. Combat knobs + Pakistan build-speed (`combat.js`, `economy.js`)
3. HARV loop + trainable HARV (`economy.js`, `orders.js`, `state.js`)
4. Engineer repair (`combat.js` or a tiny `abilities` path)
5. Commands: `cancelProduction`; HUD/input/menu (`orders.js`, `hud.js`, `input.js`, `menu.js`, `main.js`)
6. Unique gates + wave tech + menu perk lines
7. AI think extensions
8. Rebuild + smoke-check

Work through that order. After each step the game must still boot from the menu into a duel Egypt vs Algeria Recruit match.
