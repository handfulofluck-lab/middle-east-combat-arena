# MCA — 2026 Master Plan
### From greybox skirmish to a modern-era strategy game
**Owner:** KARIM · **Master coder / central hub:** Kimi Code (this workspace) · **Status:** v0.4-bridge in progress

---

## 1. Honest diagnosis — why it looks 1990s

The game you love is not old because of HTML. It is old because of one specific choice:
**the renderer is Canvas 2D drawing flat rectangles.**

| Layer | Current state | Verdict |
|---|---|---|
| **Sim** (economy, combat, pathing, AI, 9 factions, 161 units, 283 QA checks) | Deterministic, tested, fast | **Crown jewel — keep untouched** |
| **Data** (game.json balance sheet, 6 maps, display reservoir) | Clean separation of balance vs display | Keep |
| **Renderer** | Canvas 2D, flat `#b8a06a` fillRect terrain, 64px sprites | **The barrier. Replace, don't patch** |
| **FX** | Particles added (v0.4), no shaders, no lighting, no GPU | Replace with GPU systems |
| **Audio** | WebAudio synth blips (v0.4) | Placeholder until real SFX/music |
| **HUD/menus** | DOM, functional, austere | Fine — modern web games keep DOM HUD |
| **Distribution** | Single double-click HTML file | Keep as a target; add "deluxe" build later |

**Conclusion:** HTML is *not* the barrier. **Canvas 2D is.** The correct move is to keep
the entire JS sim + tooling + Kimi Code workflow, and swap the presentation layer for a
**WebGL renderer**. That is how we get 2026 graphics without throwing away the one thing
that already works like a commercial product (the simulation).

---

## 2. Stack decision — comparison and choice

| Option | Visual ceiling | Asset cost | Effort | Risk | Verdict |
|---|---|---|---|---|---|
| A. Canvas 2D + better bitmaps | HD StarCraft 1 | Low | Low | Ceiling too low | ❌ bridge only |
| B. **PixiJS 8 (WebGL2/WebGPU)** | Stunning 2.5D: shader terrain, dynamic light, GPU particles, normal-mapped sprites, per-biome art | Medium (sprites/textures AI-generated) | Medium | Low — JS, keeps sim, single-file possible | ✅ **CHOSEN** |
| C. Three.js full 3D (true RA3-style) | Real 3D, rotating camera, PBR | **Very high** — needs rigged 3D models, animations; image-gen makes textures, not game-ready models | High | High — asset pipeline is the bottleneck, not code | ⏳ Phase 8 stretch goal only |
| D. Godot / Unity export | Native 3D | High | High | Loses deterministic JS sim, test harness, Kimi Code centrality | ❌ contradicts your constraints |

**Decision: Option B — PixiJS 8, vendored UMD build, no bundler required.**
- Node v24 exists on this machine but **no npm** → we vendor `pixi.min.js` (828 KB) and keep the
  existing `build_singlefile.py` inliner architecture. (Optional later: install standalone
  Node+npm for Vite/TypeScript if the project outgrows it.)
- PixiJS v8 runs WebGL2 with WebGPU fallback — the same engine class browser RTS games use.
- Canvas 2D renderer stays as `fallback` for headless QA and low-end machines.

---

## 3. What "2026 graphics" concretely means for MCA

Not polygons-for-polygons'-sake — an **art-directed 2.5D look**:

1. **Terrain:** 2048px hand/AI-painted textures per biome (desert, coast, rubble, oil fields),
   blended tile edges, animated water with shore foam, scorch decals, real minimap re-render.
2. **Lighting & atmosphere:** dynamic time-of-day tint, muzzle-flash light pulses,
   superweapon bloom, heat-shimmer on desert maps, subtle vignette + film grade.
3. **Entities:** 256–512px sprites, 8-direction vehicle rotation, team-color masks,
   damage states (smoke/fire at low HP), soft blob shadows, rank insignia.
4. **Combat FX:** GPU particle explosions with debris, tracers, ATGM smoke trails,
   dust wakes behind vehicles, shockwaves, screen shake, cinematic SW strikes.
5. **Audio:** real recorded-style SFX library (engine loops, MG/rifle/ATGM/artillery distinct,
   explosions, UI), positional panning, layered music (calm ↔ combat intensity).
6. **UX chrome:** animated faction-emblem menu, in-engine tooltips, kill/loss ticker,
   after-action report, idle-worker alerts.

---

## 4. Multi-agent workflow — who does what (token economics)

You asked for a division of labor that keeps **Kimi Code central** and burns fewer tokens. Here it is:

### 4.1 Roles

| Agent | Role | What it touches | What it never touches |
|---|---|---|---|
| **Kimi Code (this workspace)** | **Master coder & single source of truth** | Repo, architecture, interface contracts, integration, build, QA harness, final review, commits | — |
| **DeepSeek (free)** | Bulk module writer | Writes big self-contained modules **from my specs** (renderer adapters, shaders, asset loaders, FX systems) — output pasted into `client/src/` | Integration, sim, build, QA — no repo access; it codes blind to the whole, by contract |
| **Grok Bot (desktop)** | Black-box playtester | Runs `dist/MCA.html`, screenshots, reports UX/graphics issues against my acceptance checklists | Code |
| **Kimi plugins** | Asset factory | `image_generation` (terrain/structure/unit art), `OpenArt` (image + **video** — menu cinematics), `audio_generation` (SFX, music) | Code |

### 4.2 The contract that makes DeepSeek safe to use

Every DeepSeek task is a **spec sheet** I write first (small, fixed context):

```
TASK SPEC — <module name>
Goal: one paragraph.
Interface: exact exported function signatures + types (I define these).
Inputs/Outputs: data shapes from game.json / sim state.
Constraints: ES module, no new deps, no sim mutation, must pass listed acceptance checks.
Acceptance: bullet list Grok can verify by playing.
```

DeepSeek returns code → I paste it in → `run_qa.py` + `run_smoke.py` + `playtest.py` decide if it
lives. **If it doesn't pass, it doesn't ship** — no arguing with the harness.

### 4.3 Token-saving tactics

- Specs are written once per module (~200 lines), reused across iterations.
- DeepSeek gets **only the contract, not the repo** — no giant context dumps.
- Grok verifies acceptance **before** I spend tokens reviewing — screenshots over prose.
- I keep a `DECISIONS.md` log so any agent session can be resumed cold without re-reading history.

---

## 5. Phase roadmap

> Every phase ends with: `run_qa.py` 283/283 · `run_smoke.py` 69/69 · Grok playtest sign-off · tagged build.

### Phase 0 — Finish the bridge ✅ DONE (v0.5, 2026-09-19)
Art pack sprites + display names · FX layer (particles/rings/shake) · synth audio +
settings · title menu + How to Play + Settings · service records (localStorage) ·
after-action report · auto-select MCV · OIL HALTED economy alert · terrain tone jitter +
derrick glyphs + coast foam · harness load-calibrated. 283/283 QA · 69/69 smoke · 8/8 units.

### Phase 1 — Renderer abstraction + PixiJS adapter (week 1–2)
- Define `GameView` interface: `initView(game)`, `renderFrame(dt)`, `screenToWorld()`, `pickAt()`.
- Move render.js behind it; keep Canvas2D as `CanvasView` (fallback + headless QA).
- Vendor PixiJS 8 UMD; build `PixiView` rendering the *same* sim state: terrain tiles,
  sprite entities, fog, selection, placement ghost.
- **DeepSeek task #1:** write `PixiView` entity+camera layer to my contract.
- **Deliverable:** `?renderer=canvas|pixi` switch, pixel-parity screenshots vs CanvasView.

### Phase 2 — The world looks alive (week 2–4)
- AI-generate 2K terrain texture sets per biome (`image_generation`); tile/blend in shader.
- Animated water, shore blending, oil derrick props, scorch decals.
- Fog of war as a shader (soft edges), cinematic color grade + vignette.
- **DeepSeek task #2:** terrain/water/fog shader module.
- **Asset tasks (plugins):** 6 biome texture sets, water normal map, props pack.

### Phase 3 — Entities & combat FX (week 4–7)
- AI-generate unit class sprites (8-dir vehicles, turrets), structure art with damage states,
  team-color masks; bump display.json → `assets/manifest.json`.
- GPU particles: explosions/debris/trails/dust; muzzle light; SW strike cinematic;
  shadows; smoke/fire at low HP.
- **DeepSeek task #3:** particle system + entity visual states.
- **Asset tasks:** ~40 unit sheets, ~35 structures, FX sprite sheets.

### Phase 4 — UI/UX chrome (week 7–8)
- Animated menu (OpenArt video background), in-game HUD skin, after-action report,
  kill/loss ticker, idle alerts, settings (volume/quality presets).
- **DeepSeek task #4:** menu/AAR screens (DOM, self-contained).

### Phase 5 — Audio production (week 8–9)
- `audio_generation` SFX library (per-weapon-class shots, engines, explosions, UI),
  ambient biome beds, 2-layer adaptive music. Positional panning via WebAudio.
- **Asset tasks:** ~30 SFX, 6 ambience loops, 2 music layers.

### Phase 6 — 2026 content pass (week 9–11) — *needs your input*
- Realistic current-era arsenal naming/art pass per faction (you curate which real systems
  per country), map geography pass, balance sheet v2.
- **You are the domain expert here** — I prepare the re-name/mapping sheets for approval.

### Phase 7 — Performance & packaging (week 11–12)
- Asset budget ≤ 150 MB, texture compression (basis/webp), loading screen with progress,
  quality presets. **Installer: Electron wrapper (or WebView2) with NSIS installer +
  delta auto-updater** — replaces the old single-file constraint. `dist/MCA.html` remains
  the dev/QA build; `dist/MCA-deluxe/` is the installed payload.

### Phase 8 (stretch) — True 3D
Only if Phase 2–7 land ahead of schedule and a 3D asset source materializes:
Three.js isometric 3D port behind the same `GameView` interface. The sim won't notice.

---

## 6. Risks & honest caveats

1. **AI-generated art consistency** is the #1 quality risk. Mitigation: strict style prompts,
   one reference sheet per faction, my art-direction review before integration, OpenArt project
   folders for continuity.
2. **Packaging (updated 2026-09-19): single-file is NO LONGER the requirement.** The ship
   target is an **installer package with auto-updates** (Electron + NSIS-style setup, or a
   lightweight WebView2 wrapper). We still keep `dist/MCA.html` as a zero-install dev/QA
   build, and add `dist/MCA-deluxe/` (full-res assets served locally) as the installer's payload.
3. **Perf on large maps:** PixiJS handles it, but we add a perf budget check to QA
   (6-player Hormuz match ≥ 55 fps at 1080p).
4. **DeepSeek drift:** contract + harness + my review keeps it contained; worst case we
   discard a module, never the repo.
5. **Your sim is sacred:** no phase touches `src/sim/*`. QA gate enforces it.

---

## 7. Immediate next actions (Kimi Code, this session's thread)

1. ✅ Art pack integrated · FX layer done · audio synth wired — *verify & tag v0.4 after Phase 0 polish*
2. ⬜ Phase 0 remainder: menu/settings/end-stats/terrain-noise (small, fast)
3. ⬜ Write `DECISIONS.md` + `GameView` interface contract
4. ⬜ Vendor PixiJS 8, scaffold `PixiView` stub behind renderer switch
5. ⬜ Write DeepSeek spec #1 (PixiView entity/camera layer)

*Plan version 1.0 — 2026-09-19. Amendments logged in DECISIONS.md.*
