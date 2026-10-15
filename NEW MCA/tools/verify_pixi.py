# Verify the PixiJS renderer in headless Edge: boot with ?renderer=pixi,
# start a skirmish via the UI, deploy the MCV, screenshot, report errors.
import base64, json, subprocess, sys, time, urllib.request, socket
import websocket
_s = socket.socket(); _s.bind(("127.0.0.1",0)); PORT = _s.getsockname()[1]; _s.close()

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
s = socket.socket(); s.bind(("127.0.0.1",0)); cdp = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],
    cwd=r"C:\KARIM\mca\NEW MCA\client", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
prof = r"C:\KARIM\mca\NEW MCA\tools\edgeprof-pixi"
proc = subprocess.Popen([EDGE,"--headless=new","--enable-unsafe-swiftshader","--remote-debugging-port="+str(cdp),
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
                console.append("EXC: "+(d.get("exception") or {}).get("description",d.get("text",""))[:400])
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
                    console.append("EXC: "+(d.get("exception") or {}).get("description",d.get("text",""))[:400])
            except Exception: pass
        ws.settimeout(120)
    def js(e):
        r=send("Runtime.evaluate",{"expression":e,"returnByValue":True,"awaitPromise":True})
        res=r.get("result",{})
        if res.get("subtype")=="error": return "ERR: "+res.get("description","?")[:300]
        return res.get("value")
    def click_button(rootid,text):
        return js("""(function(){
          let f=null;
          (function w(el){ if(!f&&el.tagName==='BUTTON'&&(el.textContent||'').indexOf(%s)>=0) f=el;
            for(const c of el.children||[]) w(c); })(document.getElementById(%s));
          if(f){f.click();return true} return false;
        })()""" % (json.dumps(text), json.dumps(rootid)))
    def shot(name):
        d=send("Page.captureScreenshot",{"format":"png"})["data"]
        open(r"C:\KARIM\mca\NEW MCA\tools\shots\%s.png"%name,"wb").write(base64.b64decode(d))
        print("shot:",name)
    def wait_js(expr, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            v = js(expr)
            if v: return v
            drain(0.5)
        return None
    send("Runtime.enable"); send("Page.enable")
    send("Page.navigate",{"url":"http://127.0.0.1:%d/" % PORT + "index.html?renderer=pixi"})
    wait_js("Array.from(document.querySelectorAll('#menu button')).length >= 3", 90)
    drain(1)
    print("renderer:", js("(async()=>{const m=await import('./src/main.js');const g=m.getGame();return g&&g.rendererName;})()"))
    print("PIXI:", js("typeof PIXI!=='undefined' ? PIXI.VERSION : 'missing'"))
    print("skirmish click:", click_button("menu","Skirmish"))
    wait_js("Array.from(document.querySelectorAll('#menu button')).some(b=>(b.textContent||'').indexOf('128×128')>=0)", 30)
    js("Array.from(document.querySelectorAll('#menu button')).find(b=>(b.textContent||'').indexOf('North Coast')>=0)?.click();"); drain(0.5)
    click_button("menu","Start match")
    wait_js("(async()=>{const m=await import('./src/main.js');const g=m.getGame();return g&&g.state&&g.state.tick>=0;})()", 60)
    drain(2)
    print("state:", js("(async()=>{const m=await import('./src/main.js');const g=m.getGame();return g&&g.state?{tick:g.state.tick,units:Object.keys(g.state.units).length,frameErrors:g.frameErrors}:null;})()"))
    # select the MCV at its real screen position, then DEPLOY
    pos = js("""(async()=>{const m=await import('./src/main.js');const g=m.getGame();
      const st=g.state; const mcv=Object.values(st.units).find(u=>u.owner===0&&u.defId==='MCV');
      if(!mcv) return null; const cam=g.camera;
      return {x:(mcv.x-cam.x)*cam.zoom, y:(mcv.y-cam.y)*cam.zoom};})()""")
    if pos:
        mx, my = int(pos["x"]), int(pos["y"])
        send("Input.dispatchMouseEvent",{"type":"mouseMoved","x":mx,"y":my})
        send("Input.dispatchMouseEvent",{"type":"mousePressed","x":mx,"y":my,"button":"left","buttons":1,"clickCount":1})
        send("Input.dispatchMouseEvent",{"type":"mouseReleased","x":mx,"y":my,"button":"left","buttons":0,"clickCount":1})
        drain(0.6)
        print("deploy:", click_button("buildbar","DEPLOY"))
        drain(2)
    shot("pixi-01-deployed")
    # jump the camera to the shoreline (water runs along the map borders)
    js("""(async()=>{const m=await import('./src/main.js');const g=m.getGame();
      const camMod=await import('./src/game/camera.js');
      const st=g.state;
      // find a water cell on the border half
      let wx=8*64, wy=8*64;
      outer: for (let y=4;y<st.map.h/2;y++) for (let x=4;x<st.map.w-4;x++){
        if ((st.map.terrain[y*st.map.w+x]|0)===2){ wx=x*64; wy=y*64; break outer; } }
      camMod.centerCameraOn(g.camera,wx,wy);
      camMod.clampCameraToMap(g.camera,st.map.w*64,st.map.h*64);
      return 'cam at '+wx+','+wy;})()""")
    drain(1)
    shot("pixi-02-shoreline")
    # visual QA only: hide fog for one art-check shot, then restore
    print("hide fog:", js("""(async()=>{const m=await import('./src/main.js');const g=m.getGame();
      const v=g.__pixiview; if(!v) return 'NO VIEW'; if(!v.fogSprite) return 'NO FOGSPRITE kids='+v.world.children.length;
      v.fogSprite.visible=false; return 'fog hidden';})()"""))
    drain(0.6)
    shot("pixi-02b-nofog")
    js("""(async()=>{const m=await import('./src/main.js');const g=m.getGame();
      const v=g.__pixiview; if(v&&v.fogSprite){v.fogSprite.visible=true;} return 'fog restored';})()""")
    js("Array.from(document.querySelectorAll('#topbar button')).find(b=>b.textContent.trim()==='4x')?.click()")
    drain(15)
    shot("pixi-03-midgame")
    print("state:", js("(async()=>{const m=await import('./src/main.js');const g=m.getGame();return g&&g.state?{tick:g.state.tick,structs:Object.keys(g.state.structures).length,units:Object.keys(g.state.units).length,frameErrors:g.frameErrors}:null;})()"))
    print("--- console ---")
    for line in console[-25:]: print(line)
finally:
    proc.terminate(); srv.terminate()
