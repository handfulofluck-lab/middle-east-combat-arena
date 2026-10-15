# Paste-ready agent messages (per MCA 2026 Master Plan / DECISIONS.md)

## 1) PASTE TO GROK BOT — now (v0.5 black-box playtest)

```
You are black-box playtesting MCA v0.5, a browser RTS. The build is at:
C:\KARIM\mca\NEW MCA\dist\MCA.html  (double-click it, or serve the folder C:\KARIM\mca\NEW MCA\client with any static server and open index.html)

Play a full skirmish (pick Egypt vs 1-2 AI on "North Coast") and REPORT with screenshots:
1. First screen: does the title menu look polished (glowing title, buttons, records line)? Any layout breakage at 1920x1080 AND at 1366x768?
2. Skirmish setup: are all 9 factions shown with emblems + perk lines? Any text overflow?
3. Start of match: is the MCV auto-selected (selection ring visible, DEPLOY button present)? Press D — does the Construction Yard deploy with a sprite?
4. Build flow: queue a Power Plant, then an Oil Depot near the gold derrick glyph. Are hints + sounds firing? Is there an "OIL HALTED" button in the top bar if the harvester dies?
5. Combat: train 5-6 infantry, attack-move (press A then click) into the enemy. Do you see muzzle flashes, explosions, smoke, screen shake? Hear shots/explosions/alarm?
6. Press Esc mid-match: pause overlay works? Resume/Restart/Abandon all functional?
7. Lose or win a match (or abandon): VICTORY/DEFEAT screen shows a 6-cell stats grid? Back at the menu, does the service record line update (W/L + last match)?
8. Settings: volume slider changes loudness live? Mute works? Screen-shake toggle stops the shake?
9. Any console errors (F12)? Any frame stutter on the 4x speed button?
Reply as a numbered list PASS/FAIL + screenshot per item, plus a final "SHIP IT" or "BLOCKERS:" list. Do not suggest code changes — behavior only.
```

## 2) PASTE TO DEEPSEEK — when I say "dispatch spec #1" (Phase 1 kickoff)

```
You are writing ONE self-contained ES module for an existing browser RTS called MCA.
Do not ask for the repo. Code strictly to this contract. Output ONLY the module code in one javascript block.

CONTEXT
- The game has a deterministic sim producing game.state each tick; you must NEVER mutate it.
- World units: CELL = 64 world units per map cell. Map: {w, h, terrain: Uint8Array(w*h) 0=open/1=rock/2=water, oil: [{x,y} in cells], spawns}.
- Entities: state.units[id] = {id, defId, owner, x, y, hp, maxHp, order, kills, rank, cooldown, lastHitTick}; state.structures[id] = {id, defId, owner, cx, cy, fp (footprint cells), hp, maxHp}. Centers: structures at ((cx+fp/2)*CELL, (cy+fp/2)*CELL).
- Defs: state.unitDefs[defId] = {id, name, cls, domain ('Ground'|'Air'|'Sea'), speed, rangeWu, dmg, build_s, hp}; state.structDefs[defId] similar + {fp, power_out, power_use, type}.
- Faction colors: state.players[i].faction names; state.data.factions[name].color (hex string).
- Camera: game.camera = {x, y (world coords of view top-left), zoom, viewW, viewH (CSS px)}. Screen->world: wx = cam.x + sx / cam.zoom.
- Fog: state.fog[slot].visible / .seen are Uint8Array(w*h) flags.
- Sprites: game.atlas is an ImageBitmap (may be null); sprite frames: game.spriteMap[defId] = {sx, sy, sw, sh} for structures; class tokens for units: game.spriteMap['cls-'+token] where token comes from a fixed map {Infantry:'infantry', 'AT infantry':'at_inf', 'AA infantry':'aa_inf', Engineer:'engineer', MBT:'mbt', SPG:'spg', MLRS:'mlrs', Fighter:'fighter', 'Attack helo':'attack_helo', Naval:'naval', MCV:'mcv', Harvester:'harv'} (fallback: square+circle silhouettes by domain: Air=triangle, Sea=diamond, infantry=circle, else square).
- FX: a module ./fx.js exports drawFx(game, ctx) drawing particles/rings in WORLD coordinates on a Canvas2D ctx; call it every frame after entities.
- Health bars, selection brackets, capture bars exist in the reference renderer — replicate visually.

YOUR MODULE: client/src/game/pixiview.js
Export exactly: initView(game), renderWorld(game, dtMs), viewScreenToWorld(game, sx, sy), disposeView(game).
Use the global `PIXI` (v8 UMD, already loaded). A <canvas id="game"> exists; replace its rendering with a Pixi Application bound to that canvas (resizeTo window, background #000). Keep DOM HUD (other team owns it) — you only own the world canvas.

REQUIREMENTS
1. initView(game): build the Pixi stage for game.state — terrain tile layer (pre-render the terrain to a Pixi Texture per match from the map data; flat colors are fine for now: open #b8a06a, rock #4c4c4c, water #274b7a; 16px per cell like the canvas version), a container for structures, one for units, one for projectiles, one for FX overlay. Rebuild-safe: calling initView again for a new match must dispose the old stage children.
2. renderWorld(game, dtMs): update container transforms from game.camera (same math as above), sync sprites with state (create/remove/update positions, owner-color pads under sprites — a semi-transparent rounded rect of the faction color, alpha 0.35), fog overlay (a PIXI.Sprite from a per-tick-updated 1px-per-cell canvas — reuse the existing pattern: alpha 0 visible / 0.51 seen / 1.0 unexplored, black), then call a Canvas2D shim only if needed for FX: simplest accepted approach — keep an offscreen 2D canvas sized to the viewport, let FX draw there, and blit it as a texture each frame; if that's slow, a stub is acceptable for spec #1 (mark TODO).
3. Selection: game.selection is an array of entity ids — draw brackets or rings (your choice, must be visible); selected units with rangeWu>0 show a faint range circle. Placement ghost: when game.placement is set, tint cells buildable/not with green/red per-cell quads following the footprint at mouse (game.mouse.sx/sy + viewScreenToWorld). Targeting preview (game.targeting) and attack-move marker (game.attackMoveArmed): crosshair circle at cursor.
4. Performance: viewport culling (skip entities outside view ±80 units), object pooling or child reuse (no per-frame allocation churn), target 60fps at 200 entities.
5. Headless safety: guard all PIXI/DOM work so that if `typeof PIXI === 'undefined'` every export is a silent no-op returning sane defaults (viewScreenToWorld still works — pure math).
6. No external assets, no fetch, no new dependencies. ~400-600 lines, commented, ES module syntax (import/export). Never mutate game.state.

ACCEPTANCE (a human will verify)
- ?renderer=canvas keeps working unchanged; with pixi the same match state renders: terrain, structures with pads+sprites, units with discs, fog of war, selection visuals, placement tint.
- No console errors over a 5-minute AI match; tab stays responsive.
Output the module now.
```

## 3) BACK TO KIMI CODE (me) — paste my summary each round
When Grok or DeepSeek replies, paste their output here and say "integrate". I review, wire, run the harness (283 QA + 69 smoke + 8 units), and only then does it ship.

---

## 4) PASTE TO GROK BOT — v0.5.1 re-test (all previous blockers addressed)

```
Re-test MCA v0.5.1: same build path C:\KARIM\mca\NEW MCA\dist\MCA.html. Previous blockers were addressed:
- Menus should now center vertically+horizontally at 1920x1080 and 1366x768 (no more top-left collapse). Verify at BOTH sizes.
- The map is now literally named "North Coast".
- Combat FX were rebalanced (bigger sparks, muzzle flashes, explosion flash discs). Train ~6 Rifle Squads, attack-move into the enemy, and confirm you SEE muzzle flashes / explosions / smoke when units engage. Note: fog of war hides fights your units can't see - only judge FX you can actually see on screen.
- Abandoning a match (pause -> Abandon match -> Really abandon?) must now show a DEFEAT screen with a 6-cell stats grid (match time, units built/lost, structures lost, kills, credits), and returning to the menu must update the service record line (e.g. "0W / 1L").
- Console should show no errors (favicon 404 is gone).
Same reply format: numbered PASS/FAIL + screenshots, end with SHIP IT or BLOCKERS.
```

---

## 5) PASTE TO GROK BOT — v0.5.2 re-test (MANDATORY anti-stale protocol)

```
CRITICAL: your last run tested a STALE build. Evidence: your screenshots show the old top-aligned menu, the old "Coast" label, and "No matches on record" after abandon - all pre-fix signatures. The current build has every fix verified.

ANTI-STALE PROTOCOL (do all of these):
1. Copy C:\KARIM\mca\NEW MCA\dist\MCA.html to a NEW filename on your Desktop, e.g. MCA_v052.html
2. Open it in an INCOGNITO window (or hard-refresh with Ctrl+Shift+R)
3. The title screen bottom-right MUST read: "MCA v0.5.2 · built 2026-09-19 20:57" (or later). If the stamp is absent or older, STOP and tell me - you have a stale file.
4. Report the stamp line in your reply.

Then re-run the previous checklist (menu centering at 1920x1080 AND 1366x768, "North Coast" label in skirmish setup, combat FX visible on-screen during an engaged fight, abandon -> DEFEAT + 6-cell stats + service record update). Same numbered PASS/FAIL + screenshots + SHIP IT or BLOCKERS.
Note: fog of war hides fights outside your vision - only judge FX you can see.
```
