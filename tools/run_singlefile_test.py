# Single-file build check: extracts the inlined <script> bundle from
# dist/MCA.html and runs it in py_mini_racer with the same DOM/canvas stubs as
# run_smoke.py. fetch() is rigged to throw — any fetch call means the bundle
# is not truly self-contained. Boot -> menu -> startMatch -> 200 frames.
# Usage: .venv/Scripts/python run_singlefile_test.py
import json
import re
import sys
from pathlib import Path

from py_mini_racer import MiniRacer

from run_smoke import STUB_JS  # same DOM/canvas/rAF stubs as the smoke harness

DIST = Path(__file__).resolve().parent.parent / "dist"

DRIVER_BOOT = r"""
var __smoke = { errors: [], checks: [] };
function __check(name, cond, detail) {
  __smoke.checks.push({ name: name, pass: !!cond, detail: String(detail || '') });
}
try {
  var Main = __require('src/main.js');
  __check('registry-exposes-main', !!Main && typeof Main.boot === 'function', '');
  Main.boot(); // async — microtasks flush before DRIVER_MAIN evals
} catch (e) { __smoke.errors.push('boot threw: ' + (e && e.stack || e)); }
"""

DRIVER_MAIN = r"""
(function () {
  try {
    var Main = __require('src/main.js');
    var g = Main.getGame();
    __check('boot-no-exception', !!g && __smoke.errors.length === 0,
      __smoke.errors.join('; '));
    __check('menu-shown',
      document.getElementById('menu').children.length > 0 && !g.state, '');

    Main.startMatch({ map: 'sinai', faction: 'Egypt', seed: 1234,
      opponents: [{ faction: 'Algeria', personality: 'Front', difficulty: 'recruit' }],
      ally: null });
    __check('match-started', !!g.state && !!g.camera, '');

    // v0.7.2: the bundle carries briefing posters — the briefing overlay gates
    // the sim until dismissed. Verify it showed, then dismiss it like a player.
    __check('briefing-shown', !!g.briefing, '');
    if (g.briefing && g.briefing.dismiss) g.briefing.dismiss();
    __check('briefing-dismissed', !g.briefing, '');

    var t0 = g.state.tick;
    var frames = 0;
    for (var i = 0; i < 200; i++) {
      __now += 16.7;
      var cb = __rafCb; __rafCb = null;
      if (!cb) { __smoke.errors.push('no rAF callback at frame ' + i); break; }
      cb(__now);
      frames++;
    }
    __check('200-frames-no-errors', frames === 200 && __smoke.errors.length === 0,
      'frames=' + frames + ' errors=' + __smoke.errors.join('; '));
    __check('sim-advanced', g.state.tick - t0 >= 20, 'ticks=' + (g.state.tick - t0));
    __check('canvas-drawn', g.ctx.calls > 500, 'ctx calls=' + g.ctx.calls);
    var ids = g.maps ? Object.keys(g.maps) : [];
    __check('maps-inlined', ids.length === 9
      && !!g.maps.sinai && g.maps.sinai.w === 192
      && !!g.maps.maghreb && g.maps.maghreb.w === 240
      && !!g.maps.gulf && !!g.maps.jerusalem && !!g.maps.gulfstates,
      'maps=' + ids.join(','));

    // restart drops per-match render caches: new fog canvas, fresh minimap
    // terrain, camera back on the spawn
    var oldRender = g.render, oldMmT = g.minimap.terrain;
    g.openMenu();
    findBtn('menu', 'Restart').click();
    for (var ri = 0; ri < 5; ri++) {
      __now += 16.7; var rcb = __rafCb; __rafCb = null;
      if (rcb) rcb(__now);
    }
    var stR = g.state;
    var aSeenR = 0, pxR = g.render.fogImg.data;
    for (var pi = 3; pi < pxR.length; pi += 4) if (pxR[pi] === 130) aSeenR++;
    var spR = stR.map.spawns[0];
    var inViewR = (spR.x * 64 + 32) >= g.camera.x
      && (spR.x * 64 + 32) <= g.camera.x + g.camera.viewW / g.camera.zoom
      && (spR.y * 64 + 32) >= g.camera.y
      && (spR.y * 64 + 32) <= g.camera.y + g.camera.viewH / g.camera.zoom;
    __check('sf-restart-fresh-render', g.render !== oldRender
      && g.minimap.terrain !== oldMmT && g.minimap.pings.length === 0
      // v0.9.1: the fog canvas is 4px/cell (smoothed blit) — same contract as
      // the smoke harness's fog-reset-on-restart check
      && g.render.fog.width === stR.map.w * g.render.fogScale && stR.tick < 10
      && aSeenR === 0 && inViewR && g.frameErrors === 0,
      'tick=' + stR.tick + ' seenA=' + aSeenR + ' inView=' + inViewR
        + ' fogW=' + (g.render && g.render.fog.width));

    // abandon (two-step) clears the canvas and the HUD chrome
    function findBtn(rootId, text) {
      var found = null;
      (function walk(el) {
        if (!found && el.tagName === 'button' && el.textContent === text) found = el;
        for (var ci = 0; ci < (el.children || []).length; ci++) walk(el.children[ci]);
      })(document.getElementById(rootId));
      return found;
    }
    g.openMenu();
    var overlayOk = g.overlay === 'pause' && g.paused === true;
    findBtn('menu', 'Abandon match').click(); // arms the confirm
    var abBtn2 = findBtn('menu', 'Really abandon?');
    var callsBefore = g.ctx.calls;
    if (abBtn2) abBtn2.click();
    var log = g.ctx.log, last = log.length ? log[log.length - 1] : null;
    var cleared = !!last && last[0] === 'fillRect' && last[1][0] === 0 && last[1][1] === 0
      && last[1][2] === g.canvas.width && last[1][3] === g.canvas.height;
    __check('sf-abandon-clears', overlayOk && !!abBtn2 && g.state === null
      && g.paused === false && document.body.classList.contains('in-menu')
      && cleared && g.ctx.calls === callsBefore + 2, // setTransform + fillRect only
      'cleared=' + cleared + ' calls+=' + (g.ctx.calls - callsBefore));
  } catch (e) {
    __smoke.errors.push('driver: ' + (e && e.stack || e));
  }
  return JSON.stringify(__smoke);
})();
"""

def extract_bundle(html: str) -> str:
    # the bundle is the only inline <script> in the built file
    scripts = re.findall(r"<script>([\s\S]*?)</script>", html)
    if len(scripts) != 1:
        print(f"BUILD ERROR: expected exactly 1 inline <script>, found {len(scripts)}")
        sys.exit(1)
    return scripts[0]


def main() -> int:
    f = DIST / "MCA.html"
    if not f.is_file():
        print("BUILD ERROR: dist/MCA.html missing — run build_singlefile.py first")
        return 1
    html = f.read_text(encoding="utf-8")
    bundle = extract_bundle(html)

    # static guarantees: no ES imports, no fetch for game data
    static_fail = []
    if re.search(r"from '\.[^']*'", bundle):
        static_fail.append("relative import specifier remains")
    if re.search(r"\bfetch\s*\(", bundle):
        static_fail.append("fetch() remains")
    for probe in ("Shahed", "Merkava"):
        if probe not in html:
            static_fail.append(f"data probe {probe!r} missing")

    ctx = MiniRacer()
    ctx.eval(STUB_JS)
    ctx.eval("globalThis.fetch = function () { throw new Error('fetch called — bundle not self-contained'); };")
    ctx.eval(bundle)
    ctx.eval(DRIVER_BOOT)
    result = json.loads(ctx.eval(DRIVER_MAIN))
    passed = 0
    for c in result["checks"]:
        print(f"{'PASS' if c['pass'] else 'FAIL'}  {c['name']}  --  {c.get('detail', '')}")
        passed += 1 if c["pass"] else 0
    for e in result["errors"]:
        print("ERROR:", e)
    for e in static_fail:
        print("STATIC-FAIL:", e)
    ok = passed == len(result["checks"]) and not result["errors"] and not static_fail
    print(f"{passed}/{len(result['checks'])} passed, {len(static_fail)} static failures")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
