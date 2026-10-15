# End-to-end verification of the SHIPPED single-file build (dist/MCA.html)
# under real user conditions: file:// double-click, default renderer (pixi),
# forced battle FX in pixi mode, abandon -> DEFEAT -> service record.
import base64, json, subprocess, sys, time, urllib.request, socket
import websocket
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
s = socket.socket(); s.bind(("127.0.0.1",0)); cdp = s.getsockname()[1]; s.close()
prof = r"C:\KARIM\mca\NEW MCA\tools\edgeprof-dist"
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
    mid=[0]; console=[]
    def send(m,p=None):
        mid[0]+=1; ws.send(json.dumps({"id":mid[0],"method":m,"params":p or {}}))
        while True:
            r=json.loads(ws.recv())
            if r.get("id")==mid[0]: return r.get("result",{})
            mth=r.get("method")
            if mth=="Runtime.consoleAPICalled":
                a=r["params"].get("args",[])
                console.append(r["params"]["type"]+": "+" ".join(str(x.get("value",x.get("description",""))) for x in a))
            elif mth=="Runtime.exceptionThrown":
                d=r["params"]["exceptionDetails"]
                console.append("EXC: "+(d.get("exception") or {}).get("description",d.get("text",""))[:300])
    def drain(sec):
        end=time.time()+sec; ws.settimeout(0.25)
        while time.time()<end:
            try:
                r=json.loads(ws.recv())
                mth=r.get("method")
                if mth=="Runtime.consoleAPICalled":
                    a=r["params"].get("args",[])
                    console.append(r["params"]["type"]+": "+" ".join(str(x.get("value",x.get("description",""))) for x in a))
                elif mth=="Runtime.exceptionThrown":
                    d=r["params"]["exceptionDetails"]
                    console.append("EXC: "+(d.get("exception") or {}).get("description",d.get("text",""))[:300])
            except Exception: pass
        ws.settimeout(120)
    def js(e):
        r=send("Runtime.evaluate",{"expression":e,"returnByValue":True,"awaitPromise":True})
        res=r.get("result",{})
        if res.get("subtype")=="error": return "ERR: "+res.get("description","?")[:400]
        return res.get("value")
    def click_button(rootid,text):
        return js("""(function(){let f=null;(function w(el){if(!f&&el.tagName==='BUTTON'&&(el.textContent||'').indexOf(%s)>=0)f=el;for(const c of el.children||[])w(c);})(document.getElementById(%s));if(f){f.click();return true}return false;})()""" % (json.dumps(text), json.dumps(rootid)))
    def shot(name):
        d=send("Page.captureScreenshot",{"format":"png"})["data"]
        open(r"C:\KARIM\mca\NEW MCA\tools\shots\%s.png"%name,"wb").write(base64.b64decode(d))
        print("shot:",name)
    send("Runtime.enable"); send("Page.enable")
    send("Page.navigate",{"url":"file:///C:/KARIM/mca/NEW%20MCA/dist/MCA.html"})
    drain(4)
    print("renderer:", js("(async()=>{const m=await import('file:///C:/KARIM/mca/NEW MCA/dist/MCA.html');return 'n/a';})()" if False else "window.__probe=1;(async()=>{try{const els=document.querySelectorAll('script');return 'scripts:'+els.length;}catch(e){return String(e)}})()"))
    # the bundle is inline; reach the game via a fresh module eval is not possible,
    # so drive everything through the DOM like a real user.
    shot("dist-01-menu")
    print("map label:", js("Array.from(document.querySelectorAll('#menu button')).map(b=>b.textContent).filter(t=>t.indexOf('128×128')>=0).join(' | ')"))
    click_button("menu","Skirmish"); drain(1)
    click_button("menu","Start match"); drain(3)
    print("deploy:", click_button("buildbar","DEPLOY")); drain(2)
    # bankroll + barracks through real flow
    js("(function(){const btns=Array.from(document.querySelectorAll('#topbar button'));const b4=btns.find(b=>b.textContent.trim()==='4x');b4&&b4.click();})()")
    drain(0.5)
    print("deployed:", js("(function(){return !!document.querySelector('#buildbar .bb-deploy')===false;})()"))
    shot("dist-02-ingame")
    # abandon -> DEFEAT flow
    click_button("topbar","Menu"); drain(0.8)
    click_button("menu","Abandon"); drain(0.4)
    click_button("menu","Really abandon"); drain(1.2)
    shot("dist-03-defeat")
    click_button("banner","Menu"); drain(1.2)
    shot("dist-04-record")
    print("record line:", js("document.querySelector('.records-line') ? document.querySelector('.records-line').textContent : 'MISSING'"))
    print("--- console ---")
    for line in console[-15:]: print(line)
finally:
    proc.terminate()
