# Drive headless Edge over CDP: load the repro page in REAL time, wait for the
# scenario to finish (report div ends with DONE), dump the report + screenshot.
# Usage: .venv/Scripts/python browser_probe.py <scenario> [waitSeconds]
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
TOOLS = Path(__file__).resolve().parent
PORT = 9222


def main() -> int:
    scenario = sys.argv[1] if len(sys.argv) > 1 else "twodepot"
    wait_s = float(sys.argv[2]) if len(sys.argv) > 2 else 25
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    prof = TOOLS / f"edgeprof-cdp-{int(time.time() * 1000)}"
    proc = subprocess.Popen([
        EDGE, "--headless=new", "--disable-gpu",
        f"--remote-debugging-port={port}",
        "--remote-allow-origins=*",
        f"--user-data-dir={prof}",
        "--window-size=1280,800", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws_url = None
        for _ in range(80):
            try:
                tabs = json.loads(urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/json", timeout=2).read())
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
        ws = websocket.create_connection(ws_url, timeout=120,
                                         suppress_origin=True)
        mid = [0]

        def send(method, params=None):
            mid[0] += 1
            ws.send(json.dumps({"id": mid[0], "method": method,
                                "params": params or {}}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == mid[0]:
                    return msg.get("result", {})

        send("Page.enable")
        send("Runtime.enable")
        send("Network.enable")
        send("Network.setCacheDisabled", {"cacheDisabled": True})
        url = (f"http://127.0.0.1:8123/client/test_repro.html?scenario={scenario}"
               f"&v={int(time.time() * 1000)}")
        send("Page.navigate", {"url": url})

        # poll the report div until DONE or timeout
        deadline = time.time() + wait_s
        text = ""
        while time.time() < deadline:
            r = send("Runtime.evaluate", {"expression":
                "document.getElementById('report') ?"
                " document.getElementById('report').textContent : ''",
                "returnByValue": True})
            text = r.get("result", {}).get("value", "")
            if "DONE" in text or "ONERROR" in text:
                break
            time.sleep(1.0)
        print(text)
        shot = send("Page.captureScreenshot", {"format": "png"})
        if "data" in shot:
            import base64
            out = TOOLS / f"shot_{scenario}.png"
            out.write_bytes(base64.b64decode(shot["data"]))
            print("screenshot:", out)
        ws.close()
        return 0 if "DONE" in text else 1
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True)


if __name__ == "__main__":
    sys.exit(main())
