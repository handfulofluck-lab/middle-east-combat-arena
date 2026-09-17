# MCA v0.9.0 — External Review Brief (DeepSeek / Grok)

**Project:** MCA — Middle East Combat Arena, v0.9.0 (2026-09-16 build)
**Reviewers:** DeepSeek (chat.deepseek.com), Grok — adversarial quality review
**Prepared:** 2026-09-17 · internal audit round 2 (an independent internal audit runs in parallel; scopes are disjoint)

How to use this brief: paste it into the chat **together with the attachments listed in §2**, then answer the question list in §3 in the output format of §4. Do not report anything listed in §5 (already-reviewed changes) or §6 (known, tracked issues).

---

## 1. What MCA is

MCA is an **offline, single-player skirmish RTS** set in a near-future Middle East conflict, written in vanilla JS + Canvas 2D + WebAudio with **zero dependencies**. You start with one MCV; deploy it into a Construction Yard, build power and oil income, raise a combined-arms force from your faction's real-world order of battle, and destroy the enemy's Construction Yard and MCV. Skirmish vs 1+ AI opponents with an optional AI ally (2v2). No downloads, no accounts, no network, no saves — a match runs 15–40 minutes. It runs by double-clicking `dist/MCA.html` from disk (`file://`).

**Key stats**

| Fact | Value | Where it lives |
|---|---|---|
| Units | **161** across 9 factions | `client/data/game.json` (`units`) |
| Structures | **35** | `client/data/game.json` (`structures`) |
| Factions | **9** — Egypt, Saudi, UAE, Algeria, Turkey, Israel, India, Pakistan, Iran | `client/data/game.json` (`factions`) |
| Research kits | **27** (3 per faction, ~+20% HP / +20–25% dmg, once per match) | `client/data/game.json` (`upgrades`) |
| Counter matrix | 11 classes + armor knobs | `client/data/game.json:5219` |
| Shipped maps | **9 real-geography maps**, 192²–240² tiles, 4–6 spawns each | `client/maps/manifest.json` |
| Sim | **deterministic fixed-step 10 Hz integer sim** (`TICK_MS = 100`) | `client/src/main.js:15` |
| Desync detection | FNV-1a checksum over full canonical state every tick | `client/src/sim/engine.js:583` |
| Economy | StartCredits **6000**, OilIncomePerField **18 cr/s** per field | `client/data/game.json:21-22` |
| Single-file build | **`dist/MCA.html` — 6,988,523 bytes (~7 MB), 10,240 lines** | `tools/build_singlefile.py` |
| Win condition | Destroy enemy CY **and** MCV (one CY rebuild allowed) | `client/src/sim/engine.js` elimination pass |
| AI | 5 personalities incl. adaptive AUTO; 4 difficulties (Easy/Normal/Hard/Expert) | `client/src/sim/ai.js:25-28` |
| Superweapons | 5-minute charge, build-bar button | `client/src/game/hud.js` |

---

## 2. How to review it

**Attachments to load into the chat:**
1. `dist/MCA.html` — the entire game (code + data + base64 art/audio in one file). The script is **not minified**: each module is inlined under `__modules["src/sim/engine.js"]`-style markers, so a repo path cited in a finding is locatable in the bundle by searching for that marker.
2. `dist/README.html` — controls, systems, factions, tips. (Note: its *Maps* section is stale, see §6 — the shipped map set is the 9 real-geo maps of `client/maps/manifest.json`.)

**If you are given repository access, review `client/src/` and `client/data/` directly instead of the bundle** — same content, real line numbers, no 7 MB attachment. Layout:

| Path | Role |
|---|---|
| `client/src/main.js` | boot, asset load, fixed-step accumulator loop (`:159`), briefing gate (`:315`), leave-confirmation (`:122`) |
| `client/src/sim/engine.js` | movement, separation, transports, rearm, CAP, win check, **checksum** (`:565-615`) |
| `client/src/sim/combat.js` | targeting, volleys, **air ammo** (`:209-213`), `REARM_TICKS = 50` (`:11`), dry-aircraft hold-fire (`:332`) |
| `client/src/sim/{state,orders,path,economy,rng,ai}.js` | world state, orders/placement rules, A*, income, seeded RNG, AI |
| `client/src/sim/index.js` | sim facade used by tests |
| `client/src/game/*` | render, HUD, input, menu, camera, minimap, placement, rally, sprites, audio |
| `client/data/game.json` | **all** stats/knobs/matrix/upgrades in one 5,000+ line JSON |
| `client/maps/*.json` + `manifest.json` | terrain (flat `w*h`; 0=open, 1=rock, 2=water), oil fields, spawns, briefing |
| `tools/*.py` | QA/build harnesses (see below) |

**Harnesses you can run (Python 3, `tools/.venv`):**
- `tools/run_qa.py` — the big QA sweep (smoke + balance + determinism).
- `tools/test_airsystems.py`, `tools/test_transports.py` — headless MiniRacer tests that execute the **real sim modules** (v0.9.0 systems; good models for writing your own repro).
- `tools/run_smoke.py` — in-browser smoke via the single-file build.
- `tools/gen_real_maps.py` — the real-geo map generator, with its validity invariants documented at `:12-26`.
- `tools/run_tests.py` / `client/test/sim.test.js` — unit suite.

**Method rules:** trace every claim to code or data — balance claims must show the arithmetic from `client/data/game.json` (dmg × counterMatrix × armor knob ÷ cost); behavior claims must name the code path. Do not review the base64 art/audio payloads, `artwork/`, `NEW MCA/` (a stale v0.3 snapshot), `review_v035/`, or doc prose polish. Single-player only: `CMD_DELAY = 0` (`client/src/sim/engine.js:17`); there is deliberately no netcode, no save/load, no fog-of-war.

---

## 3. Prioritized question list

Answer what you can, in this order. Each item names the evidence path to start from.

### P0 — Combat balance sanity
1. **Economy pacing.** With StartCredits 6000 / OilIncomePerField 18 (`game.json:21-22`), is a tier-2 unit (~1500 cr) ~60–90 s of one field's income? Is the opening a real choice? Any degenerate all-in the AI or player can exploit in the first 3 minutes? Sanity-check harvester travel time (income accrues near the depot or any oil field — `client/src/sim/economy.js:111-122`) for the *effective* rate.
2. **Counter chain.** The v0.3.5 audit fixed AT-infantry→MBT from 1.8→1.45 (`game.json:11` `ATGMVsArmor 1.45`; matrix at `game.json:5219`). Re-run cost-equal Lanchester thought-experiments for the classic triangle (tank / AT-infantry / IFV, helo / AA / tank, air / AA / ground). Flag any cost-equal matchup that is a 0-loss blowout, and any class with no counter in a faction roster.
3. **Knobs audit.** Read the `knobs` block (`game.json`, lines 1–~60) and every reference to it. Any knob that is dead, doubled, or whose name lies about its effect?
4. **Upgrades & abilities.** 27 kits at ~+20% HP / +20–25% dmg (`game.json` `upgrades`) + faction abilities + superweapons (5-min charge). Any multiplicative stacking that breaks a unit class? Any kit that's strictly dominant or worthless?

### P1 — The nine real-geography maps (`client/maps/manifest.json`)
Shipped set: **sinai, jerusalem, arabia, gulf, redsea, maghreb, anatolia, indus, gulfstates**. **All nine are wet** (water = terrain 2; measured share 25–51% of cells). Our own measurements (Chebyshev distance in cells):

| map | size | spawns | spawn→water dist (per spawn, manifest order) | oil fields | oil→water min/med/max |
|---|---|---|---|---|---|
| sinai | 192² | 4 | 18, 5, 15, 5 | 8 | 2 / 8 / 24 |
| jerusalem | 192² | 4 | 5, 5, 18, 9 | 8 | 1 / 8 / 24 |
| arabia | 224² | 6 | 5, 5, 5, 30, 13, **52** | 12 | 1 / 7 / 24 |
| gulf | 240² | 6 | 9, **60**, 15, 14, 9, **38** | 12 | 3 / 8 / 24 |
| redsea | 224² | 6 | 18, 23, **55**, 20, 17, 5 | 12 | 11 / 15 / 24 |
| maghreb | 240² | 6 | **47**, 6, 5, **64**, 5, 5 | 12 | 1 / 6 / 14 |
| anatolia | 224² | 6 | 5, 18, **45**, 5, 5, **42** | 12 | 1 / 9 / 15 |
| indus | 240² | 6 | 8, **37**, 5, 26, 14, **40** | 12 | 12 / 19 / 24 |
| gulfstates | 224² | 6 | **44**, 26, 14, 5, 12, **60** | 12 | 2 / 16 / 24 |

5. **Oil equity — our top map concern.** **Every one of the 100 oil fields sits ≤24 cells from water** (median ≤19) while **12 of 50 spawns are >35 cells from water** (bold above). Oil-depot income requires a depot within 4 cells of a field (`client/src/sim/orders.js:129-163`), and navy requires a coastal yard. Are inland spawns structurally disadvantaged (longer, more exposed expo lines; no navy answer to a coastal player's fleet)? Is that acceptable asymmetry or a defect? Suggest the cheapest fix (inland oil fields, tighter spawn placement, or a generator invariant).
6. **Strait / lane widths.** On the wet maps (gulf, redsea, maghreb, anatolia, indus, gulfstates), verify the navigable channels: minimum channel width vs. naval unit radius (sea-lane passability), any 1-cell choke that `client/src/sim/path.js` mishandles, and whether any spawn's only sea access can be body-blocked. Check the generator's wet-map invariant at `tools/gen_real_maps.py:24-25` — is "≥half the spawns within 70 of water" the right bar?
7. **Spawn playability.** For each spawn: enough contiguous buildable land inside the base build radius for a full base, no rock pocket spawns, fair travel time to the nearest oil field (we did NOT measure this — please do), and at least two land attack routes so one choke can't be walled.
8. **Generator invariants.** `tools/gen_real_maps.py:12-26` asserts terrain length/values, land fraction 45–75%, one connected land mass, spawn/oil reachability. What invariant is missing that would have caught your findings from Q5–Q7?

### P2 — v0.9.0 systems: transports / air ammo / rearm / CAP
9. **Transports** — APC/IFV embark/disembark (`client/src/sim/engine.js:85-89` loaded slowdown; `client/src/game/input.js:374-397`; tests: `tools/test_transports.py`). Edge cases: carrier destroyed with cargo (cargo should die), unload ring fully blocked, unloading under fire, mixed-selection load orders, passengers counting for victory/elimination.
10. **Air ammo & rearm** — every volley spends one round (`client/src/sim/combat.js:209-213`); at zero, fly to the **nearest** airfield, park `REARM_TICKS = 50` (`client/src/sim/combat.js:11`; `client/src/sim/engine.js:271-298`), then resume the snapshotted order; dry aircraft hold fire (`combat.js:332`). Can strike aircraft be permastalled (rearm longer than sortie value)? Is nearest-airfield ever wrong (enemy-owned? contested?) and does the no-airfield fallback loop or softlock?
11. **CAP holding pattern** — idle airframes loiter a slow circle (`client/src/sim/engine.js:326-340`). Gameplay only (the float-determinism angle is a known issue, §6): does CAP wander aircraft into enemy AA/vision, block airfield pads, fight acquisition/leash, or behave sensibly when the anchor is on water?
12. **Whole-sim determinism** — movement rounds to integers everywhere; the seeded RNG is `client/src/sim/rng.js`. Any new float or wall-clock leak in the v0.9.0 paths that the per-tick checksum (`engine.js:583-615`) would NOT catch (note what the format covers at `engine.js:565-581`)?

### P3 — AI (`client/src/sim/ai.js`)
13. **Doctrines & AUTO.** Personalities: `auto`, `front` (Balanced Assault), `sky` (Air Superiority), `raid` (Hit & Run), `fortress` (Fortress Defense) (`ai.js:25-28`). AUTO re-picks doctrine every think from battle heuristics (`ai.js:113`, `autoDoctrine` at `:275-327`). Does AUTO flip-flop wastefully (e.g. air↔ground build thrash)? Are its thresholds sane on wet maps where navy exists? Any division-by-zero / stale-scan crash path?
14. **AI vs. the new systems.** Does the AI build transports ever (should it?), handle its own rearming aircraft without suiciding dry airframes, and use/answer navy on wet maps? 2v2 ally coordination and the four difficulty multipliers — does Expert actually differ from Easy in observable build/attack cadence (`WAVE_SIZE` at `ai.js:236`)?

### P4 — UI/UX flow
15. **Match flow:** setup → briefing plate (`client/src/game/menu.js:450`; sim held at `client/src/main.js:315`) → match → pause → end banner → rematch/menu. Leave-confirmation on tab close (`main.js:122`). Any dead end, double-fire, or focus trap?
16. **Input semantics:** RMB on an own selected unit now **removes it from the selection** instead of moving (`input.js:397`) — does this conflict with any move-order habit or the transports path (`input.js:374`)? One-row build bar paged by Tab/‹› (`client/src/game/hud.js:387-462`), QWERTF grid, Shift+wheel, MMB drag, zoom down to 0.16×, ARMY panel (25/50/100% air/armor/infantry select), stance keys G / Ctrl+Alt+A-D-S-F / Z-X-C-V alternates, P patrol, `.` idle-worker jump. Any unreachable button at small windows, hotkey collision, or selection-order surprise?
17. **Feedback:** under-attack siren cadence per location (`hud.js:1386-1397`), minimap ping, alert stack, oil-field no-build red label (`client/src/game/hud.js:941`), placement snap + reasons (`client/src/game/placement.js`). Anything that lies to the player or spams?

### P5 — Performance on the 240² maps (gulf, maghreb, indus)
18. At 4× speed on a 240×240 map with two 50-unit armies: per-frame allocations in the render loop, target-acquisition scans (the structAtCell O(1) grid noted near the end of the bundle), the ~10 Hz heavy-scan gate (`client/src/game/hud.js:525`), terrain bake + water animation overlays (`client/src/game/render.js:73-146`). Frame-time estimate or profiling evidence beats vibes. Any obvious O(n²) that a 240² + 6-spawn FFA trips?

### P6 — Anything that looks broken
19. Open hunt: harvester box-in / `harvCd` retry, pathing deadlocks around the new separation push (`engine.js:354-359` radius 28 wu), engineer capture channel edge cases, power-stall rounding, one-CY-rebuild accounting, superweapon targeting, alert/rematch state leaks between matches (`main.js:245` FX reset is known-good). Crash, softlock, or desync-with-self (checksum change mid-match with no player input) = CRITICAL by definition.

---

## 4. Acceptance asks (output contract)

Deliver **numbered findings `F1…Fn` (max ~25, severity-ordered)** in exactly this shape:

```
F<n> [<CRITICAL|HIGH|MEDIUM|LOW>] <area>
  claim: one sentence
  evidence: file:line (repo path, or __modules["src/..."] marker in the bundle) + quoted code/data
  repro: concrete steps — map, factions, orders/ticks, expected vs actual
  fix sketch (optional): minimal literal find/replace; NO refactors, NO style edits,
     NO re-emission of entire files — we apply all edits ourselves
  acceptance: what you'd re-run/re-measure to confirm the fix
```

- Severity scale: **CRITICAL** = crash / softlock / determinism break / unplayable spawn / trivial auto-win exploit · **HIGH** = balance-breaking or a major system misbehaving in common play · **MEDIUM** = edge-case bug / minor imbalance · **LOW** = UX papercut.
- Balance findings **must** show the arithmetic (effective DPS = dmg × counter × armor × fire rate ÷ cost, with the `game.json` numbers).
- If you ran the game or a harness, say exactly what you clicked/ran.
- **Do not report anything in §5 or §6.** Do not propose architecture changes; data edits and ≤5-line code edits only.

---

## 5. Changelog v0.7.0 → v0.9.0 — already reviewed, do NOT re-report

These shipped across v0.7.x–v0.9.0 and have been internally reviewed. Treat them as intended behavior; only flag them if you find a *bug inside* the feature, not the feature itself:

- **Transports** (v0.9.0): APC/IFV embark/disembark, loaded slowdown 5%/passenger, cargo snapshot, carrier-death kills cargo — `client/src/sim/engine.js:85-89`, `client/src/game/input.js:374-397`, `tools/test_transports.py`.
- **Air ammo / rearm** (v0.9.0): per-volley ammo, auto-fly to nearest airfield, 50-tick park, order resume, dry hold-fire — `client/src/sim/combat.js:9-11,209-213,332`, `client/src/sim/engine.js:271-298`, `tools/test_airsystems.py`.
- **CAP holding pattern** (v0.9.0): idle airframes loiter an anchor circle — `client/src/sim/engine.js:326-340`.
- **Real-geo map set**: the 9 maps in §P1 replaced the old Duel/Coast/Tigris/Hormuz/Empty-Quarter/Suez/Golan/Blockade set — `client/maps/manifest.json`, `tools/gen_real_maps.py`. (`dist/README.html` still lists the old set — doc staleness is tracked, §6.)
- **Tileset & art pipeline**: sand/rock tiles + 4-frame water animation, atlas art packs — `client/src/game/render.js:9-146`, `client/src/game/sprites.js`.
- **Map thumbnails** (v0.7.2): 220×180 thumbs on setup buttons — `client/src/game/menu.js:156`.
- **Desert-military chrome**: gold-framed panels, inset top bar — `client/src/game/hud.js`.
- **Match briefing** (v0.7.1): faction plate gates first sim ticks — `client/src/main.js:67,267,315`, `client/src/game/menu.js:450`.
- **RMB deselect** (v0.9.0): right-click an own selected unit removes just it — `client/src/game/input.js:397`.
- **Zoom to 0.16×** with top-bar slider, +/- keys, Ctrl+wheel/pinch.
- **One-row build bar** (v0.9.0): single row of 6 tiles (QWERTF), paged by Tab and ‹› arrows — `client/src/game/hud.js:387-462`.
- **Leave-confirmation**: `beforeunload` prompt mid-match (no saves by design) — `client/src/main.js:122`.
- **Siren cadence** (v0.9.0): per-alert-location two-tone siren with escape throttle — `client/src/game/hud.js:466,1217,1386-1397`.
- **Drag-scroll faction strip** on the setup screen — `client/src/game/menu.js:51`.
- **ARMY panel**: 25/50/100% air/armor/infantry selection above the minimap.
- **Oil-field build block** (v0.9.0): no building within Chebyshev 1 of an oil field center — `client/src/sim/orders.js:80-83`, label at `client/src/game/hud.js:941`.
- **Separation tuning** (v0.9.0): base radius 24→28 wu, idle 2-cell lingering handled — `client/src/sim/engine.js:354-359`.
- Checksum format bump covering ammo/rearming/capTick/cargo — `client/src/sim/engine.js:577-581`.

---

## 6. Known issues we already found ourselves — do NOT report

Focus your effort elsewhere; these are tracked:

1. **CAP uses `Math.cos`/`Math.sin`** (`client/src/sim/engine.js:337-340`) — floats inside an integer-determinism sim. We are evaluating an integer LUT/orbit-table replacement; gameplay review of CAP is still wanted (§3 Q11).
2. **Checksum gaps** — fog of war is excluded by design (`engine.js:567-568`); v0.9.0 format bump invalidates old baselines (`engine.js:577-581`). An audit for *further* uncovered persistent fields is welcome; the known exclusions are tracked.
3. **Water re-stamp cost** — `client/src/game/render.js:140-146` animates water by overlaying frames 1–3 over the baked frame-0 strip every frame; the per-frame cost on 240² maps is known and on the perf list (§3 Q18 context only).
4. **Decode storm on load** — `client/src/game/sprites.js:163-165` shared decode cache means sprite frames can be undecoded for the first frames; procedural fallbacks exist (`client/src/game/render.js:700`). Cosmetic and known.
5. **Stale doc** — `dist/README.html` "Maps" section lists the pre-v0.9 map roster; the shipped set is §P1. Fix queued with the next rebuild.

---

*End of brief. Questions back to the MCA team; edits are applied internally only.*
