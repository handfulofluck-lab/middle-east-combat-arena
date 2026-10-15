# Inspect Argon's HTML game via CDP: dump menu text + start a match and screenshot it.
import json
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9333


def main() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    proc = subprocess.Popen([
        EDGE, "--headless=new", "--disable-gpu",
        f"--remote-debugging-port={port}",
        "--remote-allow-origins=*",
        f"--user-data-dir={Path(__file__).resolve().parent / f"edgeprof-arg-{int(time.time()*1000)}"}",
        "--window-size=1440,900", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws_url = None
        for _ in range(60):
            try:
                tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2).read())
                pages = [t for t in tabs if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            time.sleep(0.4)
        if not ws_url:
            print("no CDP endpoint")
            return 1
        ws = websocket.create_connection(ws_url, timeout=90, suppress_origin=True)
        mid = [0]

        def send(method, params=None):
            mid[0] += 1
            ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == mid[0]:
                    return msg.get("result", {})

        send("Page.enable")
        send("Runtime.enable")
        send("Network.enable", {"cacheDisabled": True})
        send("Page.navigate", {"url": "http://127.0.0.1:8123/dist/MCA-Argon.html"})
        time.sleep(12)
        out = send("Runtime.evaluate", {"expression": "document.body.innerText"})
        print("PAGE TEXT (menu/setup):")
        print(out.get("result", {}).get("value", "")[:5000])
        ws.close()
    finally:
        proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
