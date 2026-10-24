# MCA — Middle East Combat Arena

An offline-first, browser-based real-time strategy game. Single-file HTML distribution, 9 playable factions, 161 units, 35 structures, 15 maps, deterministic simulation, 2D and 3D (WebGL) rendering, LAN/online lockstep multiplayer, and a full offline skirmish/tutorial mode.

## Play

Open `dist/MCA.html` in any modern browser. It is fully self-contained (no server needed for offline play).

For the 3D WebGL variant of Argon's build, open `dist/MCA-Argon.html` (requires internet for the three.js/tailwind CDN).

Serve the folder locally with `python -m http.server 8123` and browse to `http://127.0.0.1:8123/dist/MCA.html`.

## Features

- 9 factions (Egypt, Saudi Arabia, UAE, Algeria, Turkey, Israel, India, Pakistan, Iran), each with unique roster, economic perk, faction ability, superweapon, and interception doctrine
- 161 units with class/counter matrix, veterancy ranks, transports (APC/IFV embark/disembark), air ammo and return-to-rearm, CAP circling, engineer capture/repair
- 35 structures incl. power, oil, production, tech, defensive towers, superweapons, research upgrade kits
- 15 maps: 9 real-geography regions (Sinai, Levant, Arabia, Gulf, Red Sea, Maghreb, Anatolia, Indus, Gulf States) + 6 Argon scenario maps (Bab el-Mandeb, Nile Delta, Cyprus Levant, Zagros Pass, Kyzylkum Steppe, Arabian Sea Convoy)
- 3D WebGL renderer with procedural low-poly models, dynamic terrain/water, fog of war, and in-engine cinematics (battle intro flyover, menu flyby, victory orbit) — toggle with the "3D graphics" menu checkbox or `?gfx=2d`
- LAN/online multiplayer via lockstep over a small Python WebSocket relay (`tools/mca_relay.py`), with input delay, desync detection, host-authoritative lobby and AI takeover on drop
- Deterministic integer 10 Hz sim with seeded RNG and FNV checksums (replays/desync diagnosis supported)
- Faction-localized voice lines (Egyptian Arabic, Gulf Arabic, Farsi, Hebrew, Turkish, Hindi, Urdu, French, English fallback), procedural SFX, ambient bed
- Full offline tutorial and skirmish setup with AI personalities (Balanced Assault, Air Superiority, Hit & Run, Fortress Defense, Auto adaptive) and difficulty tiers

## Repo layout

- `client/` — game source (`src/sim` deterministic simulation, `src/game` UI/render, `src/net` lockstep client, `index.html`, `data/game.json`, `maps/`, `vendor/three.min.js`)
- `dist/` — built single-file distribution (`MCA.html`, `MCA-Argon.html`, `README.html` player guide)
- `tools/` — build/test/export/map/art/relay scripts (`build_singlefile.py`, `export_data.py`, `build_art.py`, `paint_v5_pack.py`, `gen_real_maps.py`, `mca_relay.py`, plus test harnesses)
- `docs/` — design/review/art briefs and catalogs
- `artwork/` — source art packs (not tracked in git)

## Build

```
python tools/export_data.py
python tools/build_singlefile.py
```

## Test

Requires `tools/.venv` with `py_mini_racer`, `openpyxl`, `Pillow`, `numpy`, `websocket-client`.

```
tools/.venv/Scripts/python tools/run_tests.py
tools/.venv/Scripts/python tools/run_smoke.py
tools/.venv/Scripts/python tools/run_qa.py
tools/.venv/Scripts/python tools/run_singlefile_test.py
```

## Multiplayer (LAN)

Run `python tools/mca_relay.py --port 8790` on one machine, then in-game choose MULTIPLAYER → Host on one player, Join with the room code on others. Same code works online with delay 4.

## Documentation

- `dist/README.html` — player guide and hotkeys
- `docs/GRAPHICS_TOOLING.md` — art pipeline
- `docs/KIMI_ART_PROMPT*.md` — art-generation briefs
- `docs/UNITS_CATALOG.md` — unit/structure catalog
- `docs/REVIEW_BRIEF_v090.md` — review handoff
- `docs/ARGON_BRANCH_README.md` — Argon branch notes
