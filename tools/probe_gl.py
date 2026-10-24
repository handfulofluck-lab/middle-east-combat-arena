#!/usr/bin/env python
"""Headless CDP probe for MCA v0.11 3D.

Runs two cases sequentially in headless Edge/Chrome (fixed :9333):
  1. the standalone client/gl_preview.html demo (the original probe), and
  2. the real game at client/index.html, booted, forced to 3D, startMatch(),
     with a scripted battle injected through __mca.Sim.

Both verify window.__glErrors, scene meshes and canvas presence, then capture
tools/gl_preview.png and tools/gl_game.png. The static server on :8123 is
started if absent and stopped afterwards. Use tools/.venv/Scripts/python (has
websocket-client).
"""
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
PORT = 9333
HTTP_PORT = 8123
PREVIEW_URL = f"http://127.0.0.1:{HTTP_PORT}/client/gl_preview.html"
GAME_URL = f"http://127.0.0.1:{HTTP_PORT}/client/index.html"
PREVIEW_SHOT = TOOLS / "gl_preview.png"
GAME_SHOT = TOOLS / "gl_game.png"
MENU_SHOT = TOOLS / "gl_menu.png"
INTRO_SHOT = TOOLS / "gl_intro.png"
VICTORY_SHOT = TOOLS / "gl_victory.png"
PREVIEW_WAIT = float(os.environ.get("MCA_GL_WAIT", "15"))
GAME_WAIT = float(os.environ.get("MCA_GL_GAME_WAIT", "6"))

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

GAME_START_JS = r"""
(() => {
  const M = window.__mca;
  if (!M) return { error: 'no __mca' };
  const g = M.getGame();
  if (!g) return { error: 'no game' };
  const menu3d = !!(g.cinema && g.cinema.menu && g.cinema.menu.active);
  M.setGfx('3d');
  M.startMatch({ map: 'bab_el_mandeb', faction: 'Egypt', seed: 7,
    opponents: [{ faction: 'Algeria', personality: 'Auto', difficulty: 'recruit' }],
    ally: null });
  const cine = g.cinema;
  const title = document.getElementById('cine-title');
  return {
    gfx: g.gfx, state: !!g.state, gl: !!g.gl, menu3d,
    intro: !!(cine && cine.active && cine.kind === 'intro'),
    introTitle: title ? title.textContent : '',
  };
})()
"""

VICTORY_TRIGGER_JS = r"""
(() => {
  const g = window.__mca.getGame();
  if (!g || !g.state) return { error: 'no state' };
  const me = g.state.players[g.playerSlot];
  const foe = g.state.players.find((p) => p.team !== me.team && !p.eliminated);
  if (foe) foe.eliminated = true; // the next sim tick sets over/winner
  return { foe: foe ? foe.slot : null, eliminated: g.state.players.map((p) => !!p.eliminated) };
})()
"""

BATTLE_SETUP_JS = r"""
(() => {
  const M = window.__mca, g = M.getGame(), S = M.Sim, st = g.state;
  if (!st) return { error: 'no state' };
  const removed = [];
  for (const id of Object.keys(st.units)) {
    // Deploy only the local MCV; leave the opponent's MCV alive or the
    // elimination system ends the scripted battle too early.
    if (st.units[id].defId === 'MCV' && st.units[id].owner === g.playerSlot) {
      removed.push(id); delete st.units[id];
    }
  }
  const sp = st.map.spawns[g.playerSlot % st.map.spawns.length];
  const placed = {};
  const struct = (defId, dx, dy) => {
    const def = st.structDefs[defId];
    let spot = null;
    if (defId === 'SH-03') spot = S.findDepotPlacement(st, 0, def);
    if (!spot) spot = S.findPlacement(st, 0, def, sp.x + dx, sp.y + dy, 14);
    if (spot) { S.addStructure(st, defId, 0, spot.x, spot.y); placed[defId] = spot; }
    return spot;
  };
  struct('SH-01', 0, -6);
  struct('SH-02', 6, -6);
  struct('SH-04', -4, 3);
  struct('SH-05', 6, 2);
  struct('SH-06', 10, -3);
  struct('SH-09', 10, 4);
  struct('SH-03', 0, 0);

  const units = [];
  const spawn = (defId, owner, cx, cy) => {
    const def = st.unitDefs[defId];
    const c = S.findSpawnCell(st, owner, def, { x: cx * 64 + 32, y: cy * 64 + 32 });
    if (!c) return null;
    const u = S.addUnit(st, defId, owner, c.x, c.y);
    units.push(u.id);
    return u;
  };
  // Egypt spearhead
  const pT = [spawn('EG-07', 0, sp.x + 3, sp.y + 5), spawn('EG-07', 0, sp.x + 6, sp.y + 6),
    spawn('EG-07', 0, sp.x + 8, sp.y + 4)];
  const pI = [spawn('EG-01', 0, sp.x + 2, sp.y + 9), spawn('EG-01', 0, sp.x + 6, sp.y + 9),
    spawn('EG-01', 0, sp.x + 10, sp.y + 7)];
  const pH = spawn('EG-09', 0, sp.x + 7, sp.y + 2);
  const pJ = spawn('EG-10', 0, sp.x + 4, sp.y - 2);
  // Algeria opposition staged a short march away
  const eT = [spawn('DZ-07', 1, sp.x + 15, sp.y + 5), spawn('DZ-12', 1, sp.x + 17, sp.y + 3),
    spawn('DZ-01', 1, sp.x + 14, sp.y + 9), spawn('DZ-05', 1, sp.x + 13, sp.y + 11),
    spawn('DZ-09', 1, sp.x + 18, sp.y + 8)];
  const foeX = (sp.x + 14) * 64, foeY = (sp.y + 6) * 64;
  const homeX = sp.x * 64, homeY = sp.y * 64;
  const move = (u, x, y) => {
    if (!u) return;
    if (S.clearPath) S.clearPath(u);
    u.order = { type: 'attackMove', x: Math.round(x), y: Math.round(y), targetId: 0, enemyId: 0 };
  };
  for (const u of pT.concat(pI, [pH, pJ])) move(u, foeX, foeY);
  for (const u of eT) move(u, homeX, homeY);
  // pre-roll 24 ticks so the screenshot catches an engagement, not a march
  for (let i = 0; i < 24 && !st.over; i++) S.tick(st, []);
  M.focus(g, (sp.x + 8) * 64, (sp.y + 4) * 64, 55, 0.45, 0.60);
  return {
    base: { x: sp.x, y: sp.y }, placed: Object.keys(placed),
    units: units.length, tick: st.tick,
    pT: pT.filter(Boolean).length, eT: eT.filter(Boolean).length,
  };
})()
"""


MENU_EVAL_JS = r"""
(() => {
  const g = window.__mca ? window.__mca.getGame() : null;
  const c = g && g.cinema, m = c && c.menu;
  return {
    gfx: g ? g.gfx : null,
    menuActive: !!(m && m.active),
    menuCanvas: !!(m && m.canvas && m.canvas.style.display !== 'none'),
    bodyClass: !!(document.body && document.body.classList.contains('menu-3d')),
    menuShown: (() => { const el = document.getElementById('menu');
      return !!el && !el.classList.contains('hidden'); })(),
  };
})()
"""

INTRO_EVAL_JS = r"""
(() => {
  const g = window.__mca ? window.__mca.getGame() : null;
  const c = g && g.cinema;
  const t = document.getElementById('cine-title');
  const el = document.getElementById('cinematic');
  return {
    gfx: g ? g.gfx : null,
    active: !!(c && c.active), kind: c ? c.kind : null,
    title: t ? t.textContent : '',
    overlayShown: !!el && el.classList.contains('show'),
    camera: g && g.gl ? { dist: +g.gl.dist.toFixed(1), pitch: +g.gl.pitch.toFixed(2) } : null,
  };
})()
"""

BATTLE_EVAL_JS = r"""(() => {
  const g = window.__mca.getGame();
  const gl = g && g.gl;
  return {
    errors: window.__glErrors,
    meshes: gl && gl.scene ? gl.scene.children.length : 0,
    hasCanvas: !!document.querySelector('canvas'),
    gfx: g ? g.gfx : null,
    units: g && g.state ? Object.keys(g.state.units).length : 0,
    structures: g && g.state ? Object.keys(g.state.structures).length : 0
  };
})()"""

CINE_EVAL_JS = r"""
(() => {
  const g = window.__mca ? window.__mca.getGame() : null;
  const c = g && g.cinema;
  const el = document.getElementById('cinematic');
  const t = document.getElementById('cine-title');
  return {
    over: g && g.state ? !!g.state.over : null,
    winner: g && g.state ? g.state.winner : null,
    active: !!(c && c.active), kind: c ? c.kind : null,
    title: t ? t.textContent : '',
    overlayClass: el ? el.className : '',
    camera: g && g.gl ? { dist: +g.gl.dist.toFixed(1), pitch: +g.gl.pitch.toFixed(2) } : null,
    errors: window.__glErrors,
  };
})()
"""


def http_ok(url, timeout=1.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return 200 <= r.status < 400
    except Exception:
        return False


def ensure_server():
    if http_ok(GAME_URL, timeout=1.0):
        print(f"static server already running on :{HTTP_PORT}")
        return None
    print(f"starting python -m http.server {HTTP_PORT} in {REPO}")
    flags = 0x08000000 if sys.platform == "win32" else 0
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(HTTP_PORT), "--bind", "127.0.0.1"],
        cwd=str(REPO), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=flags,
    )
    for _ in range(40):
        if http_ok(GAME_URL, timeout=1.0):
            return proc
        time.sleep(0.25)
    proc.terminate()
    raise RuntimeError("static server did not come up on :8123")


def find_browser():
    for p in EDGE_CANDIDATES:
        if Path(p).exists():
            return p
    raise RuntimeError("no Edge/Chrome executable found")


def free_port(port):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def start_browser(browser_path, profile_dir):
    args = [
        browser_path,
        "--headless=new",
        f"--remote-debugging-port={PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={profile_dir}",
        "--window-size=1280,800",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
        "--ignore-gpu-blocklist",
        "--enable-webgl",
        "about:blank",
    ]
    flags = 0x08000000 if sys.platform == "win32" else 0
    return subprocess.Popen(args, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, creationflags=flags)


def wait_cdp(proc, timeout=30):
    # Edge's launcher exits 0 immediately while a detached child keeps the
    # browser alive; trust only the CDP endpoint.
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            tabs = json.loads(urllib.request.urlopen(
                f"http://127.0.0.1:{PORT}/json", timeout=2).read())
            pages = [t for t in tabs if t.get("type") == "page"]
            if pages:
                return pages[0]["webSocketDebuggerUrl"]
        except Exception as err:  # noqa: BLE001 - startup race
            last_err = err
        if proc.poll() is not None and time.time() > deadline - timeout + 10:
            raise RuntimeError(f"browser launcher exited ({proc.returncode}) "
                               f"and no CDP endpoint appeared ({last_err})")
        time.sleep(0.3)
    raise RuntimeError(f"no CDP endpoint on :{PORT} ({last_err})")


def kill_profile_processes(profile_dir):
    if sys.platform != "win32":
        return
    prof = str(profile_dir).replace("'", "''")
    script = (
        "$p = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
        "Where-Object { $_.CommandLine -like '*" + prof + "*' }; "
        "foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force "
        "-ErrorAction SilentlyContinue }"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", script],
                   capture_output=True)


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=120,
                                              suppress_origin=True)
        self.mid = 0
        self.events = []

    def send(self, method, params=None):
        self.mid += 1
        self.ws.send(json.dumps({"id": self.mid, "method": method,
                                 "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            if msg.get("method") in ("Runtime.exceptionThrown",
                                     "Runtime.consoleAPICalled",
                                     "Log.entryAdded"):
                self.events.append(msg)

    def eval(self, expression):
        return self.send("Runtime.evaluate", {
            "expression": expression, "returnByValue": True,
            "awaitPromise": True,
        })

    def value(self, expression):
        r = self.eval(expression)
        if "exceptionDetails" in r:
            return {"exception": r["exceptionDetails"].get("text", "evaluate failed"),
                    "description": str(r["exceptionDetails"])}
        return r.get("result", {}).get("value")

    def navigate(self, url):
        self.send("Page.enable")
        self.send("Runtime.enable")
        self.send("Log.enable")
        self.send("Network.enable")
        self.send("Network.setCacheDisabled", {"cacheDisabled": True})
        self.send("Emulation.setDeviceMetricsOverride", {
            "width": 1280, "height": 800, "deviceScaleFactor": 1, "mobile": False,
        })
        self.send("Page.navigate", {"url": url})

    def wait_value(self, expression, timeout):
        start = time.time()
        while time.time() - start < timeout:
            if self.value(expression) is True:
                return True, time.time() - start
            time.sleep(0.4)
        return False, time.time() - start

    def screenshot(self, path):
        send = self.send
        self.ws.settimeout(120)
        shot = send("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        data = shot.get("data")
        if not data:
            return False
        path.write_bytes(base64.b64decode(data))
        return path.exists() and path.stat().st_size > 1000

    def close(self):
        try:
            self.ws.send(json.dumps({"id": 999999, "method": "Browser.close"}))
        except Exception:
            pass
        try:
            self.ws.close()
        except Exception:
            pass


def run_case(browser_path, url, ready_expr, wait_after, shot_path, setup_js,
             eval_expr, pause_js, label, setup2_js=None):
    profile_dir = tempfile.mkdtemp(prefix="mca-glprobe-")
    proc = None
    cdp = None
    result = None
    detail = None
    setup = None
    shot_ok = False
    try:
        proc = start_browser(browser_path, profile_dir)
        cdp = CDP(wait_cdp(proc))
        cdp.navigate(url)
        ready, waited = cdp.wait_value(ready_expr, 40)
        print(f"[{label}] ready={ready} after {waited:.1f}s")
        if setup_js:
            setup = cdp.value(setup_js)
            print(f"[{label}] setup={json.dumps(setup)}")
            time.sleep(0.5)
        if setup2_js:
            setup2 = cdp.value(setup2_js)
            print(f"[{label}] battle={json.dumps(setup2)}")
            time.sleep(0.3)
        print(f"[{label}] waiting {wait_after:.0f}s ...")
        time.sleep(wait_after)
        if pause_js:
            cdp.value(pause_js)
            time.sleep(1.2)
        result = cdp.value(eval_expr)
        detail = cdp.value(r"""(() => {
          const g = window.__mca ? window.__mca.getGame() : window.__glDemo;
          if (!g) return null;
          const gl = g.gl;
          const r = gl && gl.renderer ? gl.renderer.info : null;
          return {
            gfx: g.gfx || null,
            tick: g.state ? g.state.tick : null,
            units: g.state ? Object.keys(g.state.units).length : null,
            structures: g.state ? Object.keys(g.state.structures).length : null,
            sceneChildren: gl && gl.scene ? gl.scene.children.length : null,
            over: g.state ? !!g.state.over : null,
            winner: g.state ? g.state.winner : null,
            eliminated: g.state && g.state.players
              ? g.state.players.map((p) => !!p.eliminated) : null,
            cinema: g.cinema ? { active: !!g.cinema.active, kind: g.cinema.kind } : null,
            menuHidden: (() => { const m = document.getElementById('menu');
              return m ? !!m.classList.contains('hidden') : null; })(),
            glUnits: gl && gl.units ? gl.units.size : null,
            stats: gl ? gl.stats : null,
            render: r ? { calls: r.render.calls, triangles: r.render.triangles,
              geometries: r.memory.geometries, textures: r.memory.textures } : null,
            errorCount: (window.__glErrors || []).length
          };
        })()""")
        shot_ok = cdp.screenshot(shot_path)
        print(f"[{label}] RESULT_JSON=" + json.dumps(result, indent=2))
        print(f"[{label}] DETAIL_JSON=" + json.dumps(detail, indent=2))
        print(f"[{label}] screenshot: {shot_path} "
              f"({shot_path.stat().st_size if shot_path.exists() else 0} bytes)")
        if cdp.events:
            print(f"[{label}] CDP events captured: {len(cdp.events)}")
            for ev in cdp.events[-6:]:
                m = ev.get("method")
                p = ev.get("params", {})
                if m == "Runtime.exceptionThrown":
                    print("  [exception]", p.get("exceptionDetails", {}).get("text", ""))
                elif m == "Runtime.consoleAPICalled":
                    args = " ".join(str(a.get("value", a.get("description", "")))
                                    for a in p.get("args", []))
                    print(f"  [console:{p.get('type')}] {args[:400]}")
                else:
                    print(f"  [{m}] {str(p)[:400]}")
        errors = result.get("errors") if isinstance(result, dict) else None
        ok = bool(shot_ok and isinstance(result, dict)
                  and result.get("meshes", 0) > 0
                  and result.get("hasCanvas") and not errors)
        return ok, result, detail, setup
    finally:
        if cdp:
            cdp.close()
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                pass
        kill_profile_processes(profile_dir)
        shutil.rmtree(profile_dir, ignore_errors=True)


def run_game_case(browser_path, wait_after):
    profile_dir = tempfile.mkdtemp(prefix="mca-glprobe-")
    proc = None
    cdp = None
    out = {}
    try:
        proc = start_browser(browser_path, profile_dir)
        cdp = CDP(wait_cdp(proc))
        cdp.navigate(GAME_URL)
        ready, waited = cdp.wait_value(
            "!!(window.__mca && window.__mca.getGame && window.__mca.getGame().hud"
            " && window.__mca.getGame().overlay === 'menu')", 40)
        print(f"[game] ready={ready} after {waited:.1f}s")
        time.sleep(1.0)
        out["menu"] = cdp.value(MENU_EVAL_JS)
        print(f"[game] menu={json.dumps(out['menu'])}")
        cdp.value("window.__glPaused = true; true")
        time.sleep(1.0)
        out["menu_shot"] = cdp.screenshot(MENU_SHOT)
        cdp.value("window.__glPaused = false; true")

        out["start"] = cdp.value(GAME_START_JS)
        print(f"[game] start={json.dumps(out['start'])}")
        # capture the descent, not the first top-down frame over map centre
        time.sleep(3.0)
        cdp.value("window.__glPaused = true; true")
        time.sleep(1.0)
        out["intro"] = cdp.value(INTRO_EVAL_JS)
        out["intro_shot"] = cdp.screenshot(INTRO_SHOT)
        print(f"[game] intro={json.dumps(out['intro'])}")
        cdp.value("window.__glPaused = false; true")
        cdp.value("if (window.__mca.skipCinematic) window.__mca.skipCinematic(); true")
        time.sleep(0.4)

        out["battle_setup"] = cdp.value(BATTLE_SETUP_JS)
        print(f"[game] battle={json.dumps(out['battle_setup'])}")
        print(f"[game] waiting {wait_after:.0f}s ...")
        time.sleep(wait_after)
        cdp.value("window.__glPaused = true; true")
        time.sleep(1.2)
        out["battle"] = cdp.value(BATTLE_EVAL_JS)
        out["battle_detail"] = cdp.value(r"""(() => {
          const g = window.__mca.getGame(); const gl = g && g.gl;
          const r = gl && gl.renderer ? gl.renderer.info : null;
          return {
            tick: g && g.state ? g.state.tick : null,
            over: g && g.state ? !!g.state.over : null,
            eliminated: g && g.state ? g.state.players.map((p) => !!p.eliminated) : null,
            sceneChildren: gl && gl.scene ? gl.scene.children.length : null,
            glUnits: gl && gl.units ? gl.units.size : null,
            stats: gl ? gl.stats : null,
            render: r ? { calls: r.render.calls, triangles: r.render.triangles,
              geometries: r.memory.geometries, textures: r.memory.textures } : null,
            menuHidden: (() => { const m = document.getElementById('menu');
              return m ? m.classList.contains('hidden') : null; })(),
            errorCount: (window.__glErrors || []).length,
          };
        })()""")
        out["battle_shot"] = cdp.screenshot(GAME_SHOT)
        print(f"[game] battle_result={json.dumps(out['battle'], indent=2)}")
        print(f"[game] battle_detail={json.dumps(out['battle_detail'], indent=2)}")
        print(f"[game] screenshot: {GAME_SHOT} "
              f"({GAME_SHOT.stat().st_size if GAME_SHOT.exists() else 0} bytes)")

        # Victory cinematic: eliminate the opposing team and let the next sim
        # tick raise state.over + playOutro. Poll for the outro, then freeze.
        cdp.value("window.__glPaused = false; true")
        out["victory_trigger"] = cdp.value(VICTORY_TRIGGER_JS)
        deadline = time.time() + 10
        seen_outro = False
        while time.time() < deadline:
            seen_outro = cdp.value(
                "!!(window.__mca.getGame().cinema"
                " && window.__mca.getGame().cinema.active"
                " && window.__mca.getGame().cinema.kind === 'outro')") is True
            if seen_outro:
                break
            time.sleep(0.4)
        cdp.value("window.__glPaused = true; true")
        time.sleep(1.0)
        out["victory"] = cdp.value(CINE_EVAL_JS)
        out["victory_shot"] = cdp.screenshot(VICTORY_SHOT)
        print(f"[game] victory={json.dumps(out['victory'])}")
        print(f"[game] screenshot: {VICTORY_SHOT} "
              f"({VICTORY_SHOT.stat().st_size if VICTORY_SHOT.exists() else 0} bytes)")

        if cdp.events:
            print(f"[game] CDP events captured: {len(cdp.events)}")
            for ev in cdp.events[-6:]:
                m = ev.get("method")
                p = ev.get("params", {})
                if m == "Runtime.exceptionThrown":
                    print("  [exception]", p.get("exceptionDetails", {}).get("text", ""))
                elif m == "Runtime.consoleAPICalled":
                    args = " ".join(str(a.get("value", a.get("description", "")))
                                    for a in p.get("args", []))
                    print(f"  [console:{p.get('type')}] {args[:400]}")
                else:
                    print(f"  [{m}] {str(p)[:400]}")
        return out
    finally:
        if cdp:
            cdp.close()
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                pass
        kill_profile_processes(profile_dir)
        shutil.rmtree(profile_dir, ignore_errors=True)


def main():
    if not free_port(PORT):
        print(f"WARNING: port {PORT} already in use; CDP may attach elsewhere")
    server_proc = ensure_server()
    browser = find_browser()
    ok_all = True
    try:
        ok1, r1, d1, _ = run_case(
            browser, PREVIEW_URL,
            "!!(window.__glDemo && window.__glDemo.scene)",
            PREVIEW_WAIT, PREVIEW_SHOT, None,
            "({errors: __glErrors, "
            "meshes: __glDemo.scene.children.length, "
            "hasCanvas: !!document.querySelector('canvas')})",
            "window.__glPaused = true; "
            "if (window.__glStopSim) window.__glStopSim(); true",
            "preview",
        )
        ok_all = ok1 and ok_all

        g = run_game_case(browser, GAME_WAIT)
        b = g.get("battle") if isinstance(g, dict) else None
        ok2 = bool(isinstance(b, dict) and b.get("gfx") == "3d"
                   and b.get("meshes", 0) > 0 and b.get("units", 0) > 0
                   and b.get("hasCanvas") and not b.get("errors"))
        ok2 = ok2 and bool(g.get("menu", {}).get("menuActive"))
        ok2 = ok2 and bool(g.get("intro", {}).get("active"))
        ok2 = ok2 and bool(g.get("victory", {}).get("active")
                           and g.get("victory", {}).get("kind") == "outro")
        ok_all = ok2 and ok_all
        print("\nSUMMARY=" + json.dumps({
            "preview": r1,
            "game": b,
            "menu_cinematic": g.get("menu"),
            "intro_cinematic": g.get("intro"),
            "victory_cinematic": g.get("victory"),
            "screenshots": [str(PREVIEW_SHOT), str(MENU_SHOT),
                            str(INTRO_SHOT), str(GAME_SHOT), str(VICTORY_SHOT)],
            "ok": bool(ok_all),
        }, indent=2))
        return 0 if ok_all else 1
    finally:
        if server_proc is not None:
            try:
                server_proc.terminate()
                server_proc.wait(timeout=5)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
