// Renders every unit and structure model to a small studio portrait and
// hands the HUD a data-URI per definition (game.iconArt[defId]). Work is
// spread across frames so it never stalls the game.
import * as THREE from 'three';

const SIZE = 192;

export function createPortraits(gl) {
  const renderer = gl.renderer;
  const rt = new THREE.WebGLRenderTarget(SIZE, SIZE, { samples: 4, depthBuffer: true });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(24, 1, 0.1, 200);
  const key = new THREE.DirectionalLight(0xfff0dc, 3.0);
  key.position.set(4, 7, 5);
  const rim = new THREE.DirectionalLight(0x9fd0ff, 1.6);
  rim.position.set(-5, 3, -6);
  const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x6b5a48, 1.15);
  scene.add(key, rim, hemi);
  const holder = new THREE.Group();
  scene.add(holder);

  const buf = new Uint8Array(SIZE * SIZE * 4);
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const box = new THREE.Box3();
  const sphere = new THREE.Sphere();
  const queue = [];
  const done = new Set();
  let tick = 0;

  function renderOne(job) {
    const ents = gl.ents;
    if (!ents) return false;
    let model;
    try {
      model = job.kind === 'unit' ? ents.kit.unit(job.def, job.team) : ents.kit.structure(job.def, job.team);
    } catch (e) { return true; }
    const root = model.root;
    root.position.set(0, 0, 0);
    root.rotation.y = 0;
    holder.add(root);
    root.updateMatrixWorld(true);
    box.setFromObject(root);
    box.getBoundingSphere(sphere);
    const r = Math.max(0.3, sphere.radius);
    const dist = r / Math.sin((cam.fov * Math.PI / 180) / 2) * 1.02;
    const yaw = job.kind === 'unit' ? -0.72 : -0.6;
    const pitch = job.kind === 'unit' ? 0.5 : 0.62;
    cam.position.set(
      sphere.center.x + Math.cos(yaw) * Math.cos(pitch) * dist,
      sphere.center.y + Math.sin(pitch) * dist,
      sphere.center.z - Math.sin(yaw) * Math.cos(pitch) * dist,
    );
    cam.lookAt(sphere.center);
    cam.near = Math.max(0.05, dist - r * 2); cam.far = dist + r * 3;
    cam.updateProjectionMatrix();
    scene.environment = gl.scene.environment;
    scene.environmentIntensity = 0.7;

    const prevTarget = renderer.getRenderTarget();
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, buf);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadow;
    holder.remove(root);

    // flip rows (GL origin is bottom-left)
    const row = SIZE * 4;
    for (let y = 0; y < SIZE; y++) {
      img.data.set(buf.subarray((SIZE - 1 - y) * row, (SIZE - y) * row), y * row);
    }
    ctx.putImageData(img, 0, 0);
    const game = gl.game;
    if (!game.iconArt) game.iconArt = {};
    game.iconArt[job.def.id] = cv.toDataURL('image/png');
    game.iconArtVersion = (game.iconArtVersion || 0) + 1;
    if (game.hud) game.hudDirty = true;
    return true;
  }

  function step() {
    if (!queue.length) return;
    tick++;
    if (tick % 2) return;
    const job = queue.shift();
    renderOne(job);
    if (!queue.length && gl.game.onPortraitsReady) gl.game.onPortraitsReady();
  }

  // priorityFaction's roster first, then shared structures, then everything else
  function requestAll(state, slot) {
    const p = state.players[slot] || state.players[0];
    const myFaction = p ? p.faction : null;
    const teamFor = (faction) => {
      const f = state.data.factions[faction];
      if (f) return { color: parseInt(String(f.color).replace('#', ''), 16), faction };
      return gl.ents.teamOf(slot);
    };
    const jobs = [];
    const add = (kind, def, pri) => {
      const k = kind + ':' + def.id + ':' + (def.faction === 'All' ? myFaction : '');
      if (done.has(k)) return;
      done.add(k);
      jobs.push({ kind, def, team: teamFor(def.faction === 'All' ? myFaction : def.faction), pri });
    };
    for (const id in state.structDefs) {
      const d = state.structDefs[id];
      add('struct', d, (d.faction === 'All' || d.faction === myFaction) ? 0 : 3);
    }
    for (const id in state.unitDefs) {
      const d = state.unitDefs[id];
      add('unit', d, (d.faction === myFaction || d.faction === 'All') ? 1 : 2);
    }
    jobs.sort((a, b) => a.pri - b.pri);
    for (const j of jobs) queue.push(j);
    queue.sort((a, b) => a.pri - b.pri);
  }

  function invalidate() { done.clear(); queue.length = 0; }

  return { step, requestAll, invalidate, get pending() { return queue.length; } };
}
