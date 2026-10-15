// GameView — the renderer contract (Phase 1).
// The sim (src/sim/*) and the DOM HUD are renderer-agnostic; anything that
// paints the world implements this interface. CanvasView (render.js) is the
// reference implementation + headless-QA fallback; PixiView (PixiJS 8) is the
// 2026 visual target.
//
// CONTRACT (implementations must honor exactly):
//
//   initView(game)         — one-time setup for a match. Reads game.state,
//                            game.camera, game.render (may replace it), and
//                            precomputes anything per-map. Must be safe to
//                            call again for a new match on the same game
//                            (previous match's resources disposed).
//   renderWorld(game, dtMs)— paint one frame: terrain, fog, entities,
//                            projectiles, placement ghost, targeting preview,
//                            FX (via fx.js draw), box-select rect. Called
//                            inside the rAF loop after handleInputFrame and
//                            before updateHud side effects. dtMs is real
//                            frame time (clamped 0..250).
//   viewScreenToWorld(game, sx, sy) -> {x, y}   — inverse of the camera
//                            transform; used by input picking. Must match
//                            camera.js math for zoom/pan/shake.
//   disposeView(game)      — drop all GPU/DOM resources (match end / menu).
//
// Rules:
//  - NEVER mutate game.state or sim state. Read-only (+ render caches on
//    game.render / your own namespace on game).
//  - Must run headless-safe: guard DOM/image work like render.js does
//    (typeof document / typeof Image checks) so run_smoke.py keeps passing.
//  - Keep per-frame allocations near zero; pool/precache per match.
//  - Selection/hover visuals read game.selection / game.inspectId; input
//    modes read game.placement / game.targeting / game.attackMoveArmed.
//
// Selection between implementations: main.js picks via ?renderer=canvas|pixi
// (default pixi when WebGL2 is available, else canvas).

export const VIEW_CONTRACT_VERSION = 1;

export function pickRendererName() {
  if (typeof location !== 'undefined' && location.search) {
    const m = /[?&]renderer=(\w+)/.exec(location.search);
    if (m) return m[1];
  }
  if (typeof WebGL2RenderingContext !== 'undefined') {
    try {
      const c = document.createElement('canvas');
      if (c.getContext('webgl2')) return 'pixi';
    } catch (e) { /* fall through */ }
  }
  return 'canvas';
}
