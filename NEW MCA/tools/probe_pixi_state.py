import json, subprocess, sys, time, urllib.request, socket
import websocket
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
s = socket.socket(); s.bind(("127.0.0.1",0)); cdp = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable,"-m","http.server","8634","--bind","127.0.0.1"],
    cwd=r"C:\KARIM\mca\NEW MCA\client", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
prof = r"C:\KARIM\mca\NEW MCA\tools\edgeprof-pixi3"
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
    send("Runtime.enable"); send("Page.enable")
    send("Page.navigate",{"url":"http://127.0.0.1:8634/index.html?renderer=pixi"})
    time.sleep(4)
    js("""(function(){let f=null;(function w(el){if(!f&&el.tagName==='BUTTON'&&(el.textContent||'').indexOf('Skirmish')>=0)f=el;for(const c of el.children||[])w(c);})(document.getElementById('menu'));f&&f.click();})()""")
    time.sleep(0.6)
    js("""(function(){let f=null;(function w(el){if(!f&&el.tagName==='BUTTON'&&(el.textContent||'').indexOf('Start match')>=0)f=el;for(const c of el.children||[])w(c);})(document.getElementById('menu'));f&&f.click();})()""")
    time.sleep(3)
    print("view:", js("""(async()=>{const m=await import('./src/main.js');const g=m.getGame();
      const v=g.__pixiview;
      if(!v) return 'NO VIEW';
      return {ready:v.ready, hasRenderer:!!(v.app&&v.app.renderer),
        stageKids:v.app&&v.app.stage?v.app.stage.children.length:-1,
        worldKids:v.world?v.world.children.length:-1,
        terrainKids:v.terrain?v.terrain.children.length:-1,
        unitViews:v.unitViews.size, structViews:v.structViews.size,
        terraPos:v.terrain?{x:v.terrain.x,y:v.terrain.y,sx:v.terrain.scale.x}:null,
        worldScale:v.world?{x:v.world.scale.x,y:v.world.scale.y,px:v.world.pivot.x}:null,
        worldPos:v.world?{x:v.world.position.x,y:v.world.position.y}:null,
        cam:{x:g.camera.x,y:g.camera.y,z:g.camera.zoom},
        res:v.app&&v.app.renderer?{w:v.app.renderer.width,h:v.app.renderer.height}:null};
    })()"""))
    print("webgl2:", js("!!document.createElement('canvas').getContext('webgl2')"))
    print("units:", js("""(async()=>{const m=await import('./src/main.js');const g=m.getGame();
      const v=g.__pixiview; const out=[];
      for (const [id,uv] of v.unitViews){ out.push({id, x:uv.sprite?uv.sprite.x:null, y:uv.sprite?uv.sprite.y:null,
        alpha:uv.sprite?uv.sprite.alpha:null, visible:uv.sprite?uv.sprite.visible:null,
        inParent:uv.sprite&&uv.sprite.parent?uv.sprite.parent===v.unitLayer:null,
        texW:uv.sprite&&uv.sprite.texture&&uv.sprite.texture.source?uv.sprite.texture.source.width:null,
        texH:uv.sprite&&uv.sprite.texture&&uv.sprite.texture.source?uv.sprite.texture.source.height:null,
        renderable:uv.sprite?uv.sprite.renderable:null}); }
      return out; })()"""))
    print("layers:", js("""(async()=>{const m=await import('./src/main.js');const g=m.getGame();
      const v=g.__pixiview; return {unitLayerKids:v.unitLayer.children.length,
      structLayerKids:v.structLayer.children.length, unitLayerVisible:v.unitLayer.visible,
      unitLayerAlpha:v.unitLayer.alpha, unitLayerPos:{x:v.unitLayer.x,y:v.unitLayer.y}}; })()"""))
finally:
    proc.terminate(); srv.terminate()
