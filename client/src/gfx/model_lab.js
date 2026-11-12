// MCA model lab — standalone viewer + contract check for the procedural model library.
//
// Query params:
//   view=units|structures|one|all|check     (default units)
//   faction=Egypt   cls=MBT   type=Def   id=EG-05[,EG-07,...]
//   team=0x3aa0ff   q=high|low   wreck=1   anim=1   static=1
//   az=35 el=48 zoom=1 fov=30 top=1   cols=6   gap=3.4   labels=0   hud=0   tf=Egypt (team faction)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createModelKit } from './models.js';

const Q = new URLSearchParams(location.search);
const lab = (window.__lab = { ready: false, errors: [], stats: {}, totals: null, check: null });
window.addEventListener('error', (e) => lab.errors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => lab.errors.push(String(e.reason && e.reason.stack || e.reason)));

const SYNTH = [
  { id: 'MCV', cls: 'MCV', domain: 'Land', name: 'MCV' },
  { id: 'HARV', cls: 'Harvester', domain: 'Land', name: 'Harvester' },
];

const num = (k, d) => (Q.has(k) ? Number(Q.get(k)) : d);
const view = Q.get('view') || 'units';
const teamColor = Q.has('team') ? Number(Q.get('team')) : 0x3aa0ff;
const quality = Q.get('q') === 'low' ? 'low' : 'high';

function countMeshes(root) {
  let meshes = 0, triangles = 0;
  root.traverse((o) => {
    if (o.isMesh) { meshes++; const g = o.geometry; triangles += (g.index ? g.index.count : g.attributes.position.count) / 3; }
  });
  return { meshes, triangles, drawCalls: meshes };
}

// ------------------------------------------------------------------ contract check

function runCheck(data) {
  const fails = [], warns = [];
  const out = { units: 0, structures: 0, fails, warns, tri: {}, meshes: {} };
  const KINDS = new Set(['infantry', 'vehicle', 'helo', 'jet', 'drone', 'ship']);
  const units = data.units.concat(SYNTH);
  const teams = [{ color: 0x3aa0ff, faction: 'Egypt' }, { color: 0x7a1010, faction: 'Turkey' }];
  for (const q of ['high', 'low']) {
    const kit = createModelKit({ quality: q });
    const triList = [], meshList = [], sTri = [], sMesh = [];
    for (const team of teams) {
      for (const def of units) {
        const tag = `${q}/${def.id}`;
        const F = (m) => fails.push(`${tag}: ${m}`);
        let u;
        try { u = kit.unit(def, team); } catch (e) { F('threw ' + (e.stack || e)); continue; }
        if (!u.root || !u.root.isObject3D) F('no root');
        if (!u.body || u.body.parent !== u.root) F('body not child of root');
        if (!KINDS.has(u.kind)) F('bad kind ' + u.kind);
        if (!(u.radius > 0.15 && u.radius < 4)) F('bad radius ' + u.radius);
        if (!(u.height > 0.2 && u.height < 4)) F('bad height ' + u.height);
        const hov = { helo: 3.2, jet: 6.5, drone: 4.8 }[u.kind] || 0;
        if (u.hover !== hov) F('hover ' + u.hover);
        for (const k of ['muzzles', 'rotors', 'wheels', 'figures', 'exhausts']) if (!Array.isArray(u[k])) F(k + ' not array');
        const armed = def.dmg && Object.values(def.dmg).some((v) => v > 0);
        if (armed && !u.muzzles.length) F('armed but no muzzles');
        const st = countMeshes(u.root);
        const budget = u.kind === 'infantry' ? 12 : 6;
        if (st.meshes > budget) F(`meshes ${st.meshes} > ${budget}`);
        if (st.meshes < 1) F('no meshes');
        if (team === teams[0]) { triList.push(st.triangles); meshList.push(st.meshes); out.tri[tag] = st.triangles; }
        const triMax = q === 'high' ? 4500 : 2600;
        if (st.triangles > triMax && team === teams[0]) warns.push(`${tag}: ${st.triangles} tris`);
        // geometry sanity
        u.root.updateMatrixWorld(true);
        const box = new THREE.Box3();
        u.root.traverse((o) => {
          if (!o.isMesh) return;
          const g = o.geometry;
          for (const an of ['position', 'normal', 'color']) {
            const a = g.attributes[an];
            if (!a) { F('missing attribute ' + an); continue; }
            const arr = a.array;
            for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) { F(`NaN in ${an} of ${o.name}`); break; }
          }
          if (!g.index || g.index.count === 0) F('empty index ' + o.name);
          if (o.material === kit.materials.paint || o.material === kit.materials.glass) {
            g.computeBoundingBox();
            box.union(g.boundingBox.clone().applyMatrix4(o.matrixWorld));
          }
          if (o.material !== kit.materials.rotorDisc && o.material !== kit.materials.emissive && !o.castShadow) F('mesh without castShadow ' + o.name);
        });
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.z);
        const lim = u.kind === 'ship' ? [1.6, 5.6] : u.kind === 'infantry' ? [0.3, 1.4] : u.kind === 'helo' ? [0.7, 3.9] : [0.7, 3.6];
        if (!(maxDim >= lim[0] && maxDim <= lim[1])) F(`size ${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)} outside ${lim}`);
        if (box.min.y < (u.kind === 'ship' ? -0.6 : -0.06)) F('below ground ' + box.min.y.toFixed(3));
        if (Math.abs(u.height - box.max.y) > 0.6) warns.push(`${tag}: height ${u.height.toFixed(2)} vs bbox ${box.max.y.toFixed(2)}`);
        // forward axis: muzzles ahead of the barrel pivot / hull centre
        const v = new THREE.Vector3();
        if (u.barrel) {
          const bp = u.barrel.getWorldPosition(new THREE.Vector3());
          let ok = false;
          for (const m of u.muzzles) { m.getWorldPosition(v); if (v.x > bp.x + 0.05) ok = true; }
          if (!ok) F('no muzzle ahead (+X) of barrel pivot');
        } else if (u.muzzles.length) {
          let mx = 0;
          for (const m of u.muzzles) { m.getWorldPosition(v); mx += v.x; }
          mx /= u.muzzles.length;
          if (mx < -size.x * 0.3) F('muzzles behind centre: ' + mx.toFixed(2));
        }
        if (u.turret && u.barrel) {
          let p = u.barrel.parent, found = false;
          while (p) { if (p === u.turret) found = true; p = p.parent; }
          if (!found) F('barrel not under turret');
        }
        if ((u.kind === 'helo' || u.kind === 'drone') && !u.rotors.length && !/jet|Kızılelma|Karrar/i.test(def.name + def.role)) F('no rotors');
        for (const r of u.rotors) if (!r.node || !'xyz'.includes(r.axis) || !(Math.abs(r.speed) > 0)) F('bad rotor');
        if (u.kind === 'infantry') {
          if (u.figures.length < 2 || u.figures.length > 5) F('figures ' + u.figures.length);
          for (const f of u.figures) if (!f.node || !f.legL || !f.legR || !f.armL || !f.armR || typeof f.phase !== 'number') F('bad figure');
        }
        if ((u.kind === 'jet' || u.kind === 'ship' || u.kind === 'vehicle') && !u.exhausts.length) warns.push(`${tag}: no exhausts`);
        // cache: second build shares geometry
        const u2 = kit.unit(def, team);
        let g1 = null, g2 = null;
        u.root.traverse((o) => { if (o.isMesh && !g1) g1 = o.geometry; });
        u2.root.traverse((o) => { if (o.isMesh && !g2) g2 = o.geometry; });
        if (g1 !== g2) F('geometry not cached');
        if (team === teams[0]) {
          try { const w = kit.wreck(def); if (!w || !w.isObject3D) F('wreck not Object3D'); } catch (e) { F('wreck threw ' + (e.stack || e)); }
        }
        out.units++;
      }
      for (const def of data.structures) {
        const tag = `${q}/${def.id}`;
        const F = (m) => fails.push(`${tag}: ${m}`);
        let s;
        try { s = kit.structure(def, team); } catch (e) { F('threw ' + (e.stack || e)); continue; }
        if (!s.root || !s.root.isObject3D) F('no root');
        if (s.kind !== def.type) F('kind');
        if (!(s.height > 0.5 && s.height < 7)) F('height ' + s.height);
        for (const k of ['muzzles', 'spinners', 'lights', 'stacks', 'doors']) if (!Array.isArray(s[k])) F(k + ' not array');
        const armed = def.dmg && Object.values(def.dmg).some((v) => v > 0);
        if (armed && !s.muzzles.length) F('armed but no muzzles');
        if (armed && !s.turret) F('Def without turret pivot');
        const st = countMeshes(s.root);
        if (st.meshes > 8) F(`meshes ${st.meshes} > 8`);
        if (team === teams[0]) { sTri.push(st.triangles); sMesh.push(st.meshes); out.tri[tag] = st.triangles; }
        if (st.triangles > (q === 'high' ? 6500 : 3800) && team === teams[0]) warns.push(`${tag}: ${st.triangles} tris`);
        s.root.updateMatrixWorld(true);
        const box = new THREE.Box3();
        s.root.traverse((o) => {
          if (!o.isMesh) return;
          const g = o.geometry;
          for (const an of ['position', 'normal', 'color']) {
            const arr = g.attributes[an].array;
            for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) { F(`NaN in ${an}`); break; }
          }
          g.computeBoundingBox();
          box.union(g.boundingBox.clone().applyMatrix4(o.matrixWorld));
        });
        const fp = (def.type === 'SW' ? 4 : def.type === 'Def' ? 2 : 3) * 2;
        const size = box.getSize(new THREE.Vector3());
        const ext = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) * 2;
        if (ext > fp * 1.02) F(`exceeds footprint: ${ext.toFixed(2)} > ${fp}`);
        if (Math.max(size.x, size.z) < fp * 0.7) F(`too small for footprint: ${size.x.toFixed(2)}x${size.z.toFixed(2)} vs ${fp}`);
        if (box.min.y < -0.05) F('below ground');
        if (!s.lights.length) warns.push(`${tag}: no lights`);
        out.structures++;
      }
    }
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
    const sum = (a) => ({ n: a.length, min: Math.min(...a), median: med(a), max: Math.max(...a), total: a.reduce((x, y) => x + y, 0) });
    out[q] = { unitTris: sum(triList), unitMeshes: sum(meshList), structTris: sum(sTri), structMeshes: sum(sMesh) };
    kit.dispose();
  }
  out.ok = fails.length === 0;
  return out;
}

// ------------------------------------------------------------------ viewer

function makeEnv(renderer) {
  const s = new THREE.Scene();
  const geo = new THREE.SphereGeometry(50, 32, 16);
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 50;
    let r, g, b;
    if (y > 0) { const t = Math.pow(y, 0.45); r = 1.25 - 0.85 * t; g = 1.2 - 0.6 * t; b = 1.15 - 0.1 * t; }
    else { const t = Math.min(1, -y * 3); r = 1.0 - 0.35 * t; g = 0.88 - 0.36 * t; b = 0.68 - 0.36 * t; }
    col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  s.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sun = new THREE.Mesh(new THREE.SphereGeometry(5, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(40, 34, 26) }));
  sun.position.set(-22, 36, 20);
  s.add(sun);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.03).texture;
  pm.dispose();
  return tex;
}

async function main() {
  const data = await (await fetch('./data/game.json')).json();
  const hud = document.getElementById('hud');
  if (Q.get('hud') === '0') hud.classList.add('hidden');

  if (view === 'check') {
    const t0 = performance.now();
    lab.check = runCheck(data);
    lab.check.ms = Math.round(performance.now() - t0);
    hud.textContent = `check: ${lab.check.ok ? 'OK' : 'FAIL'} — ${lab.check.fails.length} failures, ${lab.check.warns.length} warnings, ${lab.check.ms} ms`;
    lab.ready = true;
    return;
  }

  const kit = createModelKit({ quality });
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = num('exp', 1.0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(Q.get('bg') ? Number(Q.get('bg')) : 0xd8ccb0);
  scene.environment = makeEnv(renderer);
  scene.environmentIntensity = num('env', 0.45);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0xb89a68, num('hemi', 0.32)));
  const sun = new THREE.DirectionalLight(0xfff0d2, num('sun', 3.6));
  scene.add(sun, sun.target);

  // ---- choose defs
  let items = [];
  const ids = Q.get('id') ? Q.get('id').split(',') : null;
  const all = data.units.concat(SYNTH);
  const fFaction = Q.get('faction'), fCls = Q.get('cls'), fType = Q.get('type'), fDomain = Q.get('domain');
  if (view === 'one' || ids) {
    for (const id of ids || []) {
      const u = all.find((d) => d.id === id);
      const s = data.structures.find((d) => d.id === id);
      if (u) items.push({ def: u, isUnit: true });
      else if (s) items.push({ def: s, isUnit: false });
      else lab.errors.push('unknown id ' + id);
    }
  } else {
    if (view === 'units' || view === 'all') {
      for (const d of all) {
        if (fFaction && d.faction !== fFaction && !(d.id === 'MCV' || d.id === 'HARV')) continue;
        if (fCls && !fCls.split(',').includes(d.cls)) continue;
        if (fDomain && d.domain !== fDomain) continue;
        items.push({ def: d, isUnit: true });
      }
    }
    if (view === 'structures' || view === 'all') {
      for (const d of data.structures) {
        if (fFaction && d.faction !== fFaction && d.faction !== 'All') continue;
        if (fType && !fType.split(',').includes(d.type)) continue;
        items.push({ def: d, isUnit: false });
      }
    }
  }

  // ---- lay out
  const anyStruct = items.some((i) => !i.isUnit);
  const anyShip = items.some((i) => i.isUnit && i.def.domain === 'Sea');
  const gap = num('gap', anyStruct ? (items.some((i) => i.def.type === 'SW') ? 10 : 7.6) : anyShip ? 6 : 3.3);
  const cols = num('cols', Math.max(1, Math.ceil(Math.sqrt(items.length * 1.7))));
  const rows = Math.ceil(items.length / cols);
  const labels = document.getElementById('labels');
  const showLabels = Q.get('labels') !== '0';
  const entries = [];
  const tf = Q.get('tf');
  items.forEach((it, i) => {
    const cx = (i % cols) - (cols - 1) / 2, cz = Math.floor(i / cols) - (rows - 1) / 2;
    const faction = tf || (it.def.faction && it.def.faction !== 'All' ? it.def.faction : 'Egypt');
    const team = { color: teamColor, faction };
    let m;
    try {
      const t0 = performance.now();
      if (Q.get('wreck') === '1' && it.isUnit) m = { root: kit.wreck(it.def), rotors: [], figures: [], wheels: [], muzzles: [], hover: 0, height: 0.6 };
      else m = it.isUnit ? kit.unit(it.def, team) : kit.structure(it.def, team);
      m.buildMs = performance.now() - t0;
    } catch (e) {
      lab.errors.push(it.def.id + ': ' + (e.stack || e));
      return;
    }
    m.root.position.set(cx * gap, 0, cz * gap);
    if (Q.has('yaw')) m.root.rotation.y = (num('yaw', 0) * Math.PI) / 180;
    if (Q.get('fly') === '1' && m.hover) m.root.position.y = m.hover * 0.35;
    scene.add(m.root);
    lab.stats[it.def.id] = { ...countMeshes(m.root), buildMs: Math.round(m.buildMs * 10) / 10, height: m.height, radius: m.radius };
    const e = { it, m, x: cx * gap, z: cz * gap, el: null };
    if (showLabels) {
      const d = document.createElement('div');
      d.className = 'lbl';
      d.innerHTML = `<b>${it.def.id}</b> ${it.def.name}<br><i>${it.isUnit ? it.def.cls : it.def.type} · ${lab.stats[it.def.id].triangles | 0}t / ${lab.stats[it.def.id].meshes}m</i>`;
      labels.appendChild(d);
      e.el = d;
    }
    if (Q.get('markers') === '1') {
      const mk = (list, color) => list.forEach((o) => { const s = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color })); o.add(s); });
      mk(m.muzzles || [], 0xff2020); mk(m.exhausts || [], 0x20a0ff); mk(m.lights || [], 0xffff00); mk(m.stacks || [], 0xff00ff); mk(m.doors || [], 0x00ff60);
    }
    entries.push(e);
  });
  const st = Object.values(lab.stats);
  lab.totals = { models: st.length, meshes: st.reduce((a, b) => a + b.meshes, 0), triangles: st.reduce((a, b) => a + b.triangles, 0) };

  // ---- ground + light rig
  const spanX = cols * gap + 6, spanZ = rows * gap + 6;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ color: Q.get('ground') ? Number(Q.get('ground')) : 0xc7b186, roughness: 0.95, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  if (anyShip && Q.get('water') !== '0') ground.material.color.set(0x2c5f7a), (ground.material.roughness = 0.35);
  const sd = Math.max(spanX, spanZ) * 0.75 + 4;
  sun.position.set(0.5 * sd, 1.0 * sd, 0.6 * sd);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -sd, right: sd, top: sd, bottom: -sd, near: 0.1, far: sd * 4 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2.5;

  // ---- camera
  const fov = num('fov', 30);
  const camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.1, 4000);
  const az = (num('az', 22) * Math.PI) / 180;
  const el = (Q.get('top') === '1' ? 89.5 : num('el', 48)) * Math.PI / 180;
  const aspect = window.innerWidth / window.innerHeight;
  const tanH = Math.tan((fov * Math.PI) / 360);
  const needW = (cols * gap * 0.5 + 1.0) / (tanH * aspect);
  const needH = (rows * gap * 0.5 * Math.max(0.5, Math.sin(el)) + 2.2) / tanH;
  const dist = Math.max(needW, needH) * 1.12 / num('zoom', 1);
  const tgt = new THREE.Vector3(num('tx', 0), num('ty', anyStruct ? 0.8 : 0.3), num('tz', 0));
  camera.position.set(tgt.x + Math.sin(az) * Math.cos(el) * dist, tgt.y + Math.sin(el) * dist, tgt.z + Math.cos(az) * Math.cos(el) * dist);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(tgt);
  controls.update();

  hud.innerHTML = `<b>MCA model lab</b> — ${entries.length} models, ${lab.totals.meshes} meshes, ${Math.round(lab.totals.triangles)} tris · q=${quality} · team=#${teamColor.toString(16).padStart(6, '0')}`;

  const anim = Q.get('anim') === '1';
  const v = new THREE.Vector3();
  let last = performance.now();
  let frames = 0, t = num('t', 0);
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    for (const e of entries) {
      const m = e.m;
      if (Q.get('freeze') !== '1') for (const r of m.rotors || m.spinners || []) r.node.rotation[r.axis] += r.speed * dt;
      if (m.spinners && m.rotors === undefined && Q.get('freeze') === '1') { /* static */ }
      if (anim) {
        if (m.turret) m.turret.rotation.y = Math.sin(t * 0.8) * 0.9;
        if (m.barrel) { if (m.barrel.userData.x0 === undefined) m.barrel.userData.x0 = m.barrel.position.x; m.barrel.position.x = m.barrel.userData.x0 - Math.max(0, Math.sin(t * 5)) ** 8 * 0.18; }
        for (const w of m.wheels || []) w.rotation.z -= dt * 6;
        for (const f of m.figures || []) {
          const s = Math.sin(t * 9 + f.phase);
          f.legL.rotation.z = s * 0.6; f.legR.rotation.z = -s * 0.6;
          f.armL.rotation.z = -s * 0.5; f.armR.rotation.z = s * 0.5;
          if (f.node.userData.y0 === undefined) f.node.userData.y0 = f.node.position.y;
          f.node.position.y = f.node.userData.y0 + Math.abs(Math.cos(t * 9 + f.phase)) * 0.015;
        }
      }
    }
    if (Q.has('tyaw')) for (const e of entries) if (e.m.turret) e.m.turret.rotation.y = (num('tyaw', 0) * Math.PI) / 180;
    controls.update();
    renderer.render(scene, camera);
    if (showLabels) {
      for (const e of entries) {
        if (!e.el) continue;
        v.set(e.x, 0, e.z + gap * 0.36).project(camera);
        e.el.style.left = ((v.x * 0.5 + 0.5) * window.innerWidth).toFixed(1) + 'px';
        e.el.style.top = ((-v.y * 0.5 + 0.5) * window.innerHeight).toFixed(1) + 'px';
        e.el.style.display = v.z < 1 ? '' : 'none';
      }
    }
    frames++;
    if (frames === 2) { lab.ready = true; lab.drawCalls = renderer.info.render.calls; lab.renderTris = renderer.info.render.triangles; }
    if (Q.get('static') === '1' && frames >= 3) return;
    requestAnimationFrame(frame);
  }
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });
  lab.kit = kit; lab.scene = scene; lab.camera = camera; lab.entries = entries;
  frame();
}

main().catch((e) => { lab.errors.push(String(e && e.stack || e)); lab.ready = true; });
