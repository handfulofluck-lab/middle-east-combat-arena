import base64, json, subprocess, sys, time, urllib.request, socket
import websocket
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
s = socket.socket(); s.bind(("127.0.0.1",0)); cdp = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable,"-m","http.server","8651","--bind","127.0.0.1"],
    cwd=r"C:\KARIM\mca\NEW MCA\client", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
prof = r"C:\KARIM\mca\NEW MCA\tools\edgeprof-final"
proc = subprocess.Popen([EDGE,"--headless=new","--enable-unsafe-swiftshader","--remote-debugging-port="+str(cdp),
    "--remote-allow-origins=*","--user-data-dir="+prof,
    "--window-size=1920,1080","about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    ws_url=None
    for _ in range(80):
        try:
            tabs=json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json"%cdp,timeout=2).read())
            pages=[t for t in tabs if t.get("type")=="page"]
            if pages: ws_url=pages[0]["webSocketDebuggerUrl"]; break
        except Exception: pass
        time.sleep(0.3)
    ws=websocket.create_connection(ws_url,timeout=120,suppress_origin=True)
    mid=[0]
    def send(m,p=None):
        mid[0]+=1; ws.send(json.dumps({"id":mid[0],"method":m,"params":p or {}}))
        while True:
            r=json.loads(ws.recv())
            if r.get("id")==mid[0]: return r.get("result",{})
    def js(e):
        r=send("Runtime.evaluate",{"expression":e,"returnByValue":True,"awaitPromise":True})
        res=r.get("result",{})
        if res.get("subtype")=="error": return "ERR: "+res.get("description","?")[:300]
        return res.get("value")
    def click_button(rootid,text):
        return js("""(function(){let f=null;(function w(el){if(!f&&el.tagName==='BUTTON'&&(el.textContent||'').indexOf(%s)>=0)f=el;for(const c of el.children||[])w(c);})(document.getElementById(%s));if(f){f.click();return true}return false;})()""" % (json.dumps(text), json.dumps(rootid)))
    def shot(name):
        d=send("Page.captureScreenshot",{"format":"png"})["data"]
        open(r"C:\KARIM\mca\NEW MCA\tools\shots\%s.png"%name,"wb").write(base64.b64decode(d))
        print("shot:",name)
    send("Runtime.enable"); send("Page.enable")
    send("Page.navigate",{"url":"http://127.0.0.1:8651/index.html"})
    time.sleep(3.5)
    shot("final-01-menu-1080")
    click_button("menu","Skirmish"); time.sleep(0.6)
    click_button("menu","Start match"); time.sleep(2.5)
    # abandon via pause menu -> should be DEFEAT banner with stats
    click_button("topbar","Menu"); time.sleep(0.6)
    click_button("menu","Abandon"); time.sleep(0.4)
    click_button("menu","Really abandon"); time.sleep(1)
    shot("final-02-defeat")
    # back to menu: record line should show the loss
    click_button("banner","Menu"); time.sleep(1)
    shot("final-03-record")
finally:
    proc.terminate(); srv.terminate()
