import base64, json, subprocess, sys, time, urllib.request, socket
import websocket
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
s = socket.socket(); s.bind(("127.0.0.1",0)); cdp = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable,"-m","http.server","8622","--bind","127.0.0.1"],
    cwd=r"C:\KARIM\mca\NEW MCA\client", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
prof = r"C:\KARIM\mca\NEW MCA\tools\edgeprof-dbg3"
proc = subprocess.Popen([EDGE,"--headless=new","--disable-gpu","--remote-debugging-port="+str(cdp),
    "--remote-allow-origins=*","--user-data-dir="+prof,
    "--window-size=1600,900","about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    ws_url=None
    for _ in range(80):
        try:
            tabs=json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json"%cdp,timeout=2).read())
            pages=[t for t in tabs if t.get("type")=="page"]
            if pages: ws_url=pages[0]["webSocketDebuggerUrl"]; break
        except Exception: pass
        time.sleep(0.3)
    ws=websocket.create_connection(ws_url,timeout=60,suppress_origin=True)
    mid=[0]
    def send(m,p=None):
        mid[0]+=1; ws.send(json.dumps({"id":mid[0],"method":m,"params":p or {}}))
        while True:
            r=json.loads(ws.recv())
            if r.get("id")==mid[0]: return r.get("result",{})
    def js(e):
        r=send("Runtime.evaluate",{"expression":e,"returnByValue":True,"awaitPromise":True})
        res=r.get("result",{})
        if res.get("subtype")=="error": return "ERR: "+res.get("description","?")[:500]
        return res.get("value")
    send("Runtime.enable"); send("Page.enable")
    send("Page.navigate",{"url":"http://127.0.0.1:8622/index.html"})
    time.sleep(3)
    print("click:", js("""(function(){
      let f=null;
      (function w(el){ if(!f&&el.tagName==='BUTTON'&&(el.textContent||'').indexOf('Skirmish')>=0) f=el;
        for(const c of el.children||[]) w(c); })(document.getElementById('menu'));
      if(!f) return 'NOT FOUND';
      try { f.click(); return 'clicked'; } catch(e){ return 'THREW: '+(e&&e.stack||e); }
    })()"""))
    time.sleep(1)
    print("menu now:", js("document.getElementById('menu').innerText.slice(0,150)"))
    print("PIXI:", js("typeof PIXI!=='undefined' ? (PIXI.VERSION||'loaded') : 'missing'"))
    print("overlay:", js("(async()=>{const m=await import('./src/main.js');const g=m.getGame();return g&&g.overlay;})()"))
    # also surface any window error captured
    print("state null?", js("(async()=>{const m=await import('./src/main.js');const g=m.getGame();return !g||!g.state;})()"))
finally:
    proc.terminate(); srv.terminate()
