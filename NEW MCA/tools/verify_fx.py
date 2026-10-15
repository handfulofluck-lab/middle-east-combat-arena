# Combat FX verification: force a battle near the enemy base, screenshot mid-fight.
import base64, json, subprocess, sys, time, urllib.request, socket
import websocket
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
s = socket.socket(); s.bind(("127.0.0.1",0)); cdp = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable,"-m","http.server","8641","--bind","127.0.0.1"],
    cwd=r"C:\KARIM\mca\NEW MCA\client", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
prof = r"C:\KARIM\mca\NEW MCA\tools\edgeprof-fx"
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
        if res.get("subtype")=="error": return "ERR: "+res.get("description","?")[:400]
        return res.get("value")
    def click_button(rootid,text):
        return js("""(function(){let f=null;(function w(el){if(!f&&el.tagName==='BUTTON'&&(el.textContent||'').indexOf(%s)>=0)f=el;for(const c of el.children||[])w(c);})(document.getElementById(%s));if(f){f.click();return true}return false;})()""" % (json.dumps(text), json.dumps(rootid)))
    def shot(name):
        d=send("Page.captureScreenshot",{"format":"png"})["data"]
        open(r"C:\KARIM\mca\NEW MCA\tools\shots\%s.png"%name,"wb").write(base64.b64decode(d))
        print("shot:",name)
    send("Runtime.enable"); send("Page.enable")
    send("Page.navigate",{"url":"http://127.0.0.1:8641/index.html?renderer=pixi"})
    time.sleep(3.5)
    click_button("menu","Skirmish"); time.sleep(0.6)
    click_button("menu","Start match"); time.sleep(2)
    # deploy MCV: click its real screen position
    print(js("""(async()=>{
      const m=await import('./src/main.js'); const g=m.getGame();
      const st=g.state;
      const mcv=Object.values(st.units).find(u=>u.owner===0&&u.defId==='MCV');
      if(!mcv) return 'NO MCV';
      const cam=g.camera;
      window.__mcvScreen={x:(mcv.x-cam.x)*cam.zoom, y:(mcv.y-cam.y)*cam.zoom};
      return 'mcv at '+Math.round(window.__mcvScreen.x)+','+Math.round(window.__mcvScreen.y);
    })()"""))
    pos = js("window.__mcvScreen")
    mx, my = int(pos["x"]), int(pos["y"])
    send("Input.dispatchMouseEvent",{"type":"mouseMoved","x":mx,"y":my})
    send("Input.dispatchMouseEvent",{"type":"mousePressed","x":mx,"y":my,"button":"left","buttons":1,"clickCount":1})
    send("Input.dispatchMouseEvent",{"type":"mouseReleased","x":mx,"y":my,"button":"left","buttons":0,"clickCount":1})
    time.sleep(0.5)
    print("deploy:", click_button("buildbar","DEPLOY"))
    time.sleep(1)
    print("conyard:", js("(async()=>{const m=await import('./src/main.js');const g=m.getGame();return Object.values(g.state.structures).some(s2=>s2.owner===0&&s2.defId==='SH-01');})()"))
    # bankroll + queue barracks through the real flow: queue -> ready -> place
    print(js("""(async()=>{
      const m=await import('./src/main.js'); const g=m.getGame();
      g.state.players[0].credits=30000;
      g.pendingCmds.push({player:0,type:'buildStructure',structId:'SH-04'});
      return 'barracks queued';
    })()"""))
    js("Array.from(document.querySelectorAll('#topbar button')).find(b=>b.textContent.trim()==='4x')?.click()")
    for _ in range(45):
        r = js("(async()=>{const m=await import('./src/main.js');const g=m.getGame();return g.state.players[0].ready.includes('SH-04');})()")
        if r is True: break
        time.sleep(1)
    print("barracks ready:", r)
    print(js("""(async()=>{
      const m=await import('./src/main.js'); const g=m.getGame();
      const cy=Object.values(g.state.structures).find(s=>s.owner===0&&s.defId==='SH-01');
      const offs=[[4,0],[0,4],[-4,0],[0,-4],[4,4],[-4,-4],[4,-4],[-4,4],[5,2],[2,5],[-5,2],[2,-5]];
      for (const [dx,dy] of offs) {
        g.pendingCmds.push({player:0,type:'placeStructure',structId:'SH-04',cx:cy.cx+dx,cy:cy.cy+dy});
        await new Promise(r2=>setTimeout(r2,500));
        if (Object.values(g.state.structures).some(s2=>s2.owner===0&&s2.defId==='SH-04')) return 'barracks up';
      }
      return 'BARRACKS FAILED';
    })()"""))
    print(js("""(async()=>{
      const m=await import('./src/main.js'); const g=m.getGame();
      for(let i=0;i<10;i++) g.pendingCmds.push({player:0,type:'trainUnit',unitId:'EG-01'});
      return 'army queued';
    })()"""))
    n=0
    for _ in range(45):
        n = js("(async()=>{const m=await import('./src/main.js');const g=m.getGame();return Object.values(g.state.units).filter(u=>u.owner===0&&u.defId==='EG-01').length;})()")
        if isinstance(n,int) and n>=8: break
        time.sleep(1)
    print('squads ready:', n)
    # rally the squads to the enemy spawn and attack-move there
    time.sleep(0.5)
    print(js("""(async()=>{
      const m=await import('./src/main.js'); const g=m.getGame();
      const st=g.state; const p=st.players[0];
      const ids=Object.keys(st.units).filter(id=>st.units[id].owner===0&&st.units[id].defId==='EG-01');
      const sp=st.map.spawns[1];
      g.pendingCmds.push({player:0,type:'attackMove',unitIds:ids,x:sp.x*64+32,y:sp.y*64+32});
      // camera follows the army through the real camera API (clamped)
      const u=st.units[ids[0]];
      const camMod=await import('./src/game/camera.js');
      camMod.centerCameraOn(g.camera,u.x,u.y);
      camMod.clampCameraToMap(g.camera,st.map.w*64,st.map.h*64);
      return 'attack with '+ids.length+' squads heading to '+sp.x+','+sp.y;
    })()"""))
    time.sleep(1)
    shot("fx-01-approach")
    # race at 4x until the lead squad is close to any enemy, then drop to 1x
    DIST = "(async()=>{const m=await import('./src/main.js');const g=m.getGame();const st=g.state;const own=Object.values(st.units).filter(u=>u.owner===0&&u.defId==='EG-01');if(!own.length)return -1;const foes=Object.values(st.units).filter(u=>u.owner!==0);if(!foes.length)return -1;let best=1e9;for(const a of own)for(const b of foes){const d=Math.hypot(a.x-b.x,a.y-b.y);if(d<best)best=d;}return Math.round(best);})()"
    dist=99999
    for _ in range(60):
        d=js(DIST)
        if not isinstance(d,int) or d<0: break
        dist=d
        if d<700: break
        time.sleep(1)
    print('distance to enemy:', dist)
    js("Array.from(document.querySelectorAll('#topbar button')).find(b=>b.textContent.trim()==='1x')?.click()")
    CENTER = """(async()=>{const m=await import('./src/main.js');const g=m.getGame();
          const u=Object.values(g.state.units).filter(x=>x.owner===0&&x.defId==='EG-01')
            .sort((a,b)=>b.x-a.x)[0];
          if(!u) return; const camMod=await import('./src/game/camera.js');
          camMod.centerCameraOn(g.camera,u.x,u.y);
          camMod.clampCameraToMap(g.camera,g.state.map.w*64,g.state.map.h*64);
          return u.order.type;})()"""
    for i in range(2,7):
        print('lead order:', js(CENTER))
        time.sleep(0.4)
        shot("fx-0%d-battle"%i)
        # once firing starts, particles should exist - check
        pc = js("(async()=>{const m=await import('./src/main.js');const g=m.getGame();return g.fx.parts.length;})()")
        print('parts:', pc)
        if isinstance(pc,int) and pc>0:
            time.sleep(0.5)
            js(CENTER)
            shot("fx-flash")
    print("squads:", js("""(async()=>{const m=await import('./src/main.js');const g=m.getGame();const st=g.state;
      const sq=Object.values(st.units).filter(u=>u.owner===0&&u.defId==='EG-01')
        .map(u=>({x:u.x,y:u.y,order:u.order.type,hp:u.hp}));
      const cam=g.camera;
      return {tick:st.tick, cam:{x:Math.round(cam.x),y:Math.round(cam.y)},
        screen:[Math.round((sq[0].x-cam.x)*cam.zoom),Math.round((sq[0].y-cam.y)*cam.zoom)],
        squads:sq.slice(0,3), parts:g.fx.parts.length,
        enemyNear:Object.values(st.units).filter(u=>u.owner!==0).map(u=>[u.defId,u.x,u.y]).slice(0,5)};
    })()"""))
finally:
    proc.terminate(); srv.terminate()
