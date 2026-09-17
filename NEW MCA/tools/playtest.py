# Real-UI playtest probe: serves client/, drives headless Edge over CDP,
# clicks through Menu -> Skirmish -> Start, deploys the MCV via the real
# button, takes screenshots, reports console errors + frame errors.
# Usage: .venv/Scripts/python playtest.py [url] [outdir]
import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
TOOLS = Path(__file__).resolve().parent
CLIENT = TOOLS.parent / "client"


def main() -> int:
    outdir = Path(sys.argv[2]) if len(sys.argv) > 2 else TOOLS / "shots"
    outdir.mkdir(parents=True, exist_ok=True)
    port = 8619
    srv = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=CLIENT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import socket
    s = socket.socket(); s.bind(("127.0.0.1", 0)); cdp_port = s.getsockname()[1]; s.close()
    prof = TOOLS / f"edgeprof-play-{int(time.time() * 1000)}"
    proc = subprocess.Popen([
        EDGE, "--headless=new", "--disable-gpu",
        f"--remote-debugging-port={cdp_port}",
        "--remote-allow-origins=*",
        f"--user-data-dir={prof}",
        "--window-size=1600,900", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws_url = None
        for _ in range(80):
            try:
                tabs = json.loads(urllib.request.urlopen(
                    f"http://127.0.0.1:{cdp_port}/json", timeout=2).read())
                pages = [t for t in tabs if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            time.sleep(0.3)
        if not ws_url:
            print("no CDP endpoint")
            return 1
        ws = websocket.create_connection(ws_url, timeout=120, suppress_origin=True)
        mid = [0]
        console = []

        def send(method, params=None):
            mid[0] += 1
            ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == mid[0]:
                    return msg.get("result", {})
                m = msg.get("method")
                if m == "Runtime.consoleAPICalled":
                    args = msg["params"].get("args", [])
                    text = " ".join(str(a.get("value", a.get("description", "")))
                                    for a in args)
                    console.append(f"{msg['params']['type']}: {text}")
                elif m == "Runtime.exceptionThrown":
                    d = msg["params"]["exceptionDetails"]
                    desc = (d.get("exception") or {}).get("description", d.get("text", ""))
                    console.append("EXCEPTION: " + desc)

        def drain(seconds):
            end = time.time() + seconds
            ws.settimeout(0.25)
            while time.time() < end:
                try:
                    msg = json.loads(ws.recv())
                    m = msg.get("method")
                    if m == "Runtime.consoleAPICalled":
                        args = msg["params"].get("args", [])
                        text = " ".join(str(a.get("value", a.get("description", "")))
                                        for a in args)
                        console.append(f"{msg['params']['type']}: {text}")
                    elif m == "Runtime.exceptionThrown":
                        d = msg["params"]["exceptionDetails"]
                        desc = (d.get("exception") or {}).get("description", d.get("text", ""))
                        console.append("EXCEPTION: " + desc)
                except Exception:
                    pass
            ws.settimeout(120)

        def shot(name):
            data = send("Page.captureScreenshot", {"format": "png"})["data"]
            (outdir / f"{name}.png").write_bytes(base64.b64decode(data))
            print("shot:", name)

        def js(expr):
            r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                          "awaitPromise": True})
            return r.get("result", {}).get("value")

        def click_button(rootid, text):
            return js(f"""(function(){{
              let found=null;
              (function walk(el){{
                if(!found && el.tagName==='BUTTON' && el.textContent.trim().startsWith({json.dumps(text)})) found=el;
                for(const c of el.children||[]) walk(c);
              }})(document.getElementById({json.dumps(rootid)}));
              if(found){{found.click();return true}} return false;
            }})()""")

        send("Runtime.enable")
        send("Page.enable")
        send("Page.navigate", {"url": f"http://127.0.0.1:{port}/index.html"})
        drain(3)
        shot("01-main-menu")
        print("menu buttons:", js("Array.from(document.querySelectorAll('#menu button')).map(b=>b.textContent)"))

        click_button("menu", "Skirmish")
        drain(1)
        shot("02-setup")
        # pick a 4-player map + 2 opponents to exercise UI
        js("Array.from(document.querySelectorAll('#menu button')).find(b=>b.textContent.includes('coast')).click()")
        drain(0.5)
        js("Array.from(document.querySelectorAll('#menu button')).find(b=>b.textContent.includes('Add opponent'))?.click()")
        drain(0.5)
        shot("03-setup-coast-4p")
        click_button("menu", "Start match")
        drain(3)
        shot("04-match-start")

        # deploy MCV via the real flow: click it on the canvas, then DEPLOY
        for _ in range(30):
            if js("!document.getElementById('menu') || document.getElementById('menu').classList.contains('hidden')"):
                break
            drain(1)
        drain(2)
        # left-click the MCV (camera spawns centered on it)
        send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 672, "y": 403})
        drain(0.3)
        send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": 672, "y": 403,
                                          "button": "left", "buttons": 1, "clickCount": 1})
        drain(0.2)
        send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": 672, "y": 403,
                                          "button": "left", "buttons": 0, "clickCount": 1})
        drain(1)
        shot("05-mcv-selected")
        ok = click_button("buildbar", "DEPLOY")
        print("deploy clicked:", ok)
        drain(2)
        shot("06-mcv-deploying")
        # speed up to 4x and let the sim run ~40s
        js("Array.from(document.querySelectorAll('#topbar button')).find(b=>b.textContent.trim()==='4x')?.click()")
        drain(40)
        shot("07-early-game")
        # open pause menu and resume (exercise overlay)
        js("Array.from(document.querySelectorAll('#topbar button')).find(b=>/menu/i.test(b.textContent))?.click()")
        drain(1)
        shot("08-pause")
        click_button("menu", "Resume")
        drain(2)
        shot("09-resumed")

        state = js("""(async function(){
          try {
            const m = await import('./src/main.js');
            const G = m.getGame();
            if (!G || !G.state) return {note:'no state yet'};
            return {tick:G.state.tick, structs:Object.keys(G.state.structures).length,
                    units:Object.keys(G.state.units).length,
                    frameErrors:G.frameErrors, over:G.state.over,
                    credits: G.state.players[0] ? G.state.players[0].credits : -1};
          } catch(e){ return {err:String(e)} }
        })()""")
        print("state:", json.dumps(state))
        print("--- console ---")
        for line in console[-60:]:
            print(line)
        return 0
    finally:
        proc.terminate()
        srv.terminate()


if __name__ == "__main__":
    sys.exit(main())
