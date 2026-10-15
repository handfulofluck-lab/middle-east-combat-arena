# MCA — DECISIONS LOG
Central decision record per the 2026 Master Plan. Any agent session resumes here.

## 2026-09-19

### D1 — Renderer strategy
Canvas 2D is the barrier, HTML is not. Keep the deterministic JS sim untouched;
replace the presentation layer with **PixiJS 8 (WebGL2/WebGPU)**, vendored UMD
(no npm on this machine; Node v24 exists). Canvas 2D stays as fallback + headless QA.

### D2 — Packaging
Single-file dropped as a requirement (owner decision). Ship target = installer
with auto-updates (Electron/WebView2 + NSIS). `dist/MCA.html` remains dev/QA build.

### D3 — Multi-agent division of labor
Kimi Code (this workspace) = master coder + source of truth. DeepSeek writes big
self-contained modules from paste-ready specs (no repo access). Grok Bot does
black-box playtesting vs acceptance checklists. Plugins generate assets
(image_generation / OpenArt / audio_generation).

### D4 — v0.5 bridge shipped (Phase 0 complete)
Art pack v1 integrated (atlas sprites, owner pads, display-name reservoir).
FX layer: muzzle/impact/death particles, explosions, smoke, command rings,
selection rings, screen shake (gated by Settings). Audio: WebAudio synth SFX
full event wiring + volume/mute prefs. Menu: animated title, How to Play,
Settings (volume/mute/shake/hints), service records (localStorage).
AAR: match time, units built/lost, structs lost, kills, credits.
Auto-select MCV at match start. OIL HALTED economy alert. Terrain: per-cell tone
jitter, rock/water shading, coast foam, derrick glyphs.
Harness: button matching by substring; perf budget load-calibrated.
**Tests: 283/283 QA · 69/69 smoke · 8/8 units.**

### D5 — Sim is sacred
No phase touches `src/sim/*`. QA gate enforces. FX/audio are render-layer and
diff state observation only.

### D6 — DeepSeek/Grok round integrated (2026-09-19)
- DeepSeek's `pixiview.js` (PixiJS 8 world renderer) integrated behind
  `?renderer=canvas|pixi`. Fixes applied during review: static FX wiring
  (builder rejects lazy module loading), flat-scope const collisions
  (CELL/TERRAIN_COLORS), unit/structure containers never parented to layers,
  and the boot-time 2D context grab bricking WebGL (renderer chosen before
  touching the canvas). Pixi view verified rendering terrain/fog/entities.
- Grok blockers fixed: menus vertically centered (flex+margin:auto),
  concede = DEFEAT banner + AAR + record (was: silent exit), combat FX
  particle sizes ~2.5x + flash discs, map renamed "North Coast", favicon
  injected at runtime. FX verified in forced battle (sparks/flash visible).
- Abandon flow change rippled to smoke harness (banner-first, then Menu).

### D7 — Phase 1 scaffold (2026-09-19)
`client/src/game/view.js` — GameView contract v1 (initView/renderWorld/
viewScreenToWorld/disposeView, pickRendererName). PixiJS 8.21.0 vendored at
`client/vendor/pixi.min.js`, inlined by build_singlefile.py (dist now 1.5 MB),
verified loading in headless Edge. Canvas2D remains default until PixiView lands.

## Open items
- [ ] Phase 1: DeepSeek spec #1 (pixiview.js) → integrate → wire renderer switch
- [ ] Phase 6 needs owner curation: real 2026-era systems per faction

### D8 — Stale-build forensics + build stamp (2026-09-19)
Grok's second report claimed all fixes missing; screenshot forensics proved they
ran the PRE-fix build (top-aligned menu, "Coast" label, no-record abandon are
old-build signatures; current dist greps positive for every fix). The dist was
verified end-to-end via file:// (menu centering, North Coast, abandon->DEFEAT
+AAR, records update, pixi renderer). Process fix: every build now carries a
visible stamp "MCA vX.Y.Z · built <ts>" on the title screen; testers must
report the stamp. QA Gates now include a dist-level browser verification
(verify_dist.py) so the SHIPPED artifact — not just the dev client — is proven.

### D9 — Phase 2 terrain art landed (2026-09-19, v0.5.3)
AI-painted 2K terrain set (desert/rock/water/dune) generated with the
image_generation plugin, flat-fielded offline (large-scale luminance removed),
runtime copies 1024px JPG (~250KB each) in client/assets/terrain/.
Pixi renderer now pre-renders the map with per-cell random crops + 0.30 flat
wash + coast shading (wet-sand rim / surf foam) and an animated additive water
shimmer masked to water cells. Verified continuous photoreal ground in-browser
(vs checkerboard before flat-fielding). Canvas2D keeps greybox fallback;
asset load failure falls back gracefully (headless QA unaffected, 283/283).
Known follow-ups: water shimmer visual check pending; decorative props
(rocks/scrub) next; per-map biome selection (dune-weight) later.

### D10 — Phase 2/3 art pipeline in full swing (2026-09-19 late, v0.5.3)
Structures: AI-painted iso sprites for SH-01/02/03/04/05/06/09/10 (8 core),
edge-decontaminated, 512px, loaded over atlas frames (fallback intact).
Units: painted infantry squad, attack helo, fighter (class tokens); tank-class
sprites blocked by image-gateway safety policy — atlas tokens remain for
vehicles pending alternative pipeline (OpenArt MCP has schema issues; revisit).
Props: pumpjack derrick on oil fields + scattered rock clusters / dry scrub.
All runtime assets ship beside dist/MCA.html (6.8MB total payload); every
painted layer falls back gracefully -> headless QA still 283/283, smoke 69/69.
Terrain flat-fielding lesson: AI textures carry large-scale luminance drift
that reads as blobs when tiled; divide-by-lowpass + 10% mean restore fixed it.
Perf harness floor raised to 30s absolute (machine load spikes false-fail).

### D11 — file:// black screen root-caused and fixed (2026-09-20)
User report: double-clicked dist/MCA.html -> black canvas, HUD/minimap alive.
Root cause: WebGL refuses texture uploads from file:// images (tainted-canvas
SecurityError thrown inside renderer.render, silently swallowed by the render
try/catch). HTTP clients unaffected, which is why all lab probes passed.
Fix: build_singlefile.py now inlines all painted art (terrain/props/
structures/units) as data: URIs in __INLINE_ART; pixiview art loaders prefer
inlined URIs over file paths. dist/MCA.html is now 8.9MB self-contained and
renders the painted world from a double-click. Verified via verify_dist.py
(file:// repro harness now part of the QA gate lesson: always verify the
shipped artifact under its real launch protocol).
