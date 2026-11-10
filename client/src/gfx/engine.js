// MCA renderer core. One WebGL2 renderer + canvas lives for the whole
// session; setWorld() swaps the map/sim state it mirrors. The module exposes
// the same surface the rest of the client already talks to (initGl, glFrame,
// focusGl, glScreenToWorld, ...), so input, HUD, minimap and netcode did not
// have to change.
import * as THREE from 'three';
import {
  CELL, S, WU, WATER_Y, clamp, lerp, damp, angleDelta, hexToRgb,
} from './util.js';
import { resolveTheme } from './themes.js';
import { buildHeightfield } from './heightfield.js';
import {
  buildTerrain, buildWater, buildSky, buildLights, buildProps, buildOilField,
  updateSunShadow,
} from './world.js';
import { createPost } from './post.js';
import { createFx } from './fx.js';
import { createEntities } from './entities.js';
import { createPortraits } from './portraits.js';

export const QUALITY = {
  low: {
    name: 'low', pr: 1, msaa: 0, shadows: 1024, terrainShadows: false, bloom: false,
    props: 0.45, particles: 0.5, sharpen: 0, grain: 0, decals: 160, aniso: 2, tracks: false,
  },
  medium: {
    name: 'medium', pr: 1, msaa: 2, shadows: 2048, terrainShadows: true, bloom: true,
    props: 0.75, particles: 0.8, sharpen: 0.15, grain: 0.02, decals: 900, aniso: 4, tracks: true,
  },
  high: {
    name: 'high', pr: 1.5, msaa: 4, shadows: 2048, terrainShadows: true, bloom: true,
    props: 1, particles: 1, sharpen: 0.22, grain: 0.03, decals: 2000, aniso: 8, tracks: true,
  },
  ultra: {
    name: 'ultra', pr: 2, msaa: 4, shadows: 4096, terrainShadows: true, bloom: true,
    props: 1.3, particles: 1.4, sharpen: 0.25, grain: 0.03, decals: 3200, aniso: 16, tracks: true,
  },
};
const QUALITY_KEY = 'mca.quality';

export function readQualityPref() {
  try {
    const q = globalThis.location && /[?&]q=(low|medium|high|ultra)/.exec(globalThis.location.search);
    if (q) return q[1];
    const v = globalThis.localStorage && globalThis.localStorage.getItem(QUALITY_KEY);
    if (v && QUALITY[v]) return v;
  } catch (e) { /* private mode */ }
  return 'high';
}

const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
export function initGl(game, opts = {}) {
  if (!game) throw new Error('initGl: no game object');
  if (game.gl) {
    if (opts.state || game.state) setWorld(game.gl, opts.state || game.state, opts);
    return game.gl;
  }
  let canvas = document.getElementById('gl-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'gl-canvas';
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;'
      + 'z-index:2;touch-action:none;outline:none;';
    document.body.insertBefore(canvas, document.body.firstChild);
  }
  const qualityName = opts.quality || readQualityPref();
  const quality = QUALITY[qualityName] || QUALITY.high;
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
    stencil: false, depth: true,
    preserveDrawingBuffer: !!(globalThis.navigator && globalThis.navigator.webdriver),
  });
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = quality.shadows > 0;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x05070a, 1);
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 16 / 9, 1.5, 4200);

  const gl = {
    game, canvas, renderer, scene, camera, THREE,
    quality, qualityName,
    state: null, map: null, mapW: 0, mapH: 0, halfX: 0, halfZ: 0,
    localSlot: 0, reveal: false,
    look: null, hf: null, world: null, lights: null, post: null,
    fx: null, ents: null, portraits: null,
    time: 0, frame: 0,
    // camera rig (current + target for critically-damped smoothing)
    focus: new THREE.Vector3(), yaw: 0.62, pitch: 0.78, dist: 50,
    tFocus: new THREE.Vector3(), tYaw: 0.62, tPitch: 0.78, tDist: 50,
    camLock: false,       // cinematics drive the rig directly
    shake: 0, shakeT: 0,
    keys: new Set(), wasdPan: false, dragging: false, lastPointer: { x: 0, y: 0 },
    proxy: { x: null, y: null, zoom: 1, ready: false },
    fogTex: null, fogData: null, fogCur: null, fogTick: -1,
    stats: { fps: 60, ms: 16, calls: 0, tris: 0 },
    fpsAcc: 0, fpsN: 0, autoLowered: 0,
    ready: false, visible: true,
    onWorldBuilt: null,
  };
  game.gl = gl;
  gl.screenToWorld = (sx, sy) => glScreenToWorld(game, sx, sy);
  gl.onShake = (amount, x, z) => addShake(gl, amount, x, z);

  resizeGl(gl);
  gl.post = createPost(renderer, scene, camera, quality);
  resizeGl(gl);
  gl.portraits = createPortraits(gl);

  bindControls(gl);
  if (typeof ResizeObserver !== 'undefined') {
    gl.resizeObserver = new ResizeObserver(() => resizeGl(gl));
    gl.resizeObserver.observe(canvas);
  }
  globalThis.addEventListener('resize', () => resizeGl(gl));
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (globalThis.__glErrors) globalThis.__glErrors.push('webglcontextlost');
  });

  const st = opts.state || game.state;
  if (st) setWorld(gl, st, opts);
  return gl;
}

export function resizeGl(gl) {
  const w = gl.canvas.clientWidth || globalThis.innerWidth || 1280;
  const h = gl.canvas.clientHeight || globalThis.innerHeight || 720;
  if (!w || !h) return;
  const pr = Math.min(globalThis.devicePixelRatio || 1, gl.quality.pr) * (gl.resScale || 1);
  gl.renderer.setPixelRatio(pr);
  gl.renderer.setSize(w, h, false);
  gl.camera.aspect = w / h;
  gl.camera.updateProjectionMatrix();
  if (gl.post) gl.post.setSize(w, h, pr);
  gl.viewW = w; gl.viewH = h;
}

export function setQuality(game, name) {
  const gl = game && game.gl;
  if (!QUALITY[name]) return;
  try { globalThis.localStorage.setItem(QUALITY_KEY, name); } catch (e) { /* no-op */ }
  if (!gl || gl.qualityName === name) return;
  gl.quality = QUALITY[name];
  gl.qualityName = name;
  gl.renderer.shadowMap.enabled = gl.quality.shadows > 0;
  if (gl.post) gl.post.dispose();
  gl.post = createPost(gl.renderer, gl.scene, gl.camera, gl.quality);
  resizeGl(gl);
  if (gl.state) setWorld(gl, gl.state, { localSlot: gl.localSlot, reveal: gl.reveal, force: true });
}

export function getQuality(game) {
  return (game && game.gl) ? game.gl.qualityName : readQualityPref();
}

// ---------------------------------------------------------------------------
// world lifecycle
// ---------------------------------------------------------------------------
function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) if (!m.userData || !m.userData.shared) m.dispose();
  });
}

export function setWorld(gl, state, opts = {}) {
  const sameMap = gl.map === state.map && !opts.force;
  gl.state = state;
  gl.localSlot = opts.localSlot !== undefined ? opts.localSlot : (gl.game.playerSlot || 0);
  gl.reveal = !!opts.reveal;
  gl.fogTick = -1;
  if (gl.ents) gl.ents.reset(state);
  if (gl.fx) gl.fx.reset();
  if (sameMap && gl.world) {
    initFog(gl);
    return;
  }
  if (gl.world) {
    gl.scene.remove(gl.world.root);
    disposeObject(gl.world.root);
    if (gl.world.env) gl.world.env.dispose();
    if (gl.world.water.userData.dispose) gl.world.water.userData.dispose();
    if (gl.lights && gl.lights.sun.shadow) gl.lights.sun.shadow.dispose();
  }
  const map = state.map;
  gl.map = map;
  gl.mapW = map.w; gl.mapH = map.h;
  gl.halfX = map.w * S / 2; gl.halfZ = map.h * S / 2;
  const look = resolveTheme(map);
  gl.look = look;
  const hf = buildHeightfield(map, look);
  gl.hf = hf;

  const root = new THREE.Group();
  root.name = 'world';
  const terrain = buildTerrain(hf, look, gl.quality);
  const water = buildWater(hf, look);
  const sky = buildSky(look);
  const lights = buildLights(look, gl.quality);
  const props = buildProps(hf, look, gl.quality);
  root.add(terrain, water, sky, lights.group, props);
  sky.scale.setScalar(3600);

  const oil = [];
  for (const id in state.oilFields) {
    const f = state.oilFields[id];
    const g = buildOilField(hf, wuToX(gl, f.x), wuToZ(gl, f.y), Number(id) * 13 + 5);
    root.add(g);
    oil.push(g);
  }
  gl.scene.add(root);
  gl.lights = lights;
  gl.world = { root, terrain, water, sky, props, oil, env: null };

  // image-based lighting from the sky itself
  try {
    const pm = new THREE.PMREMGenerator(gl.renderer);
    const envScene = new THREE.Scene();
    const envSky = buildSky(look);
    envSky.scale.setScalar(100);
    envScene.add(envSky);
    const env = pm.fromScene(envScene, 0.02, 1, 1000);
    gl.scene.environment = env.texture;
    gl.scene.environmentIntensity = look.night ? 0.5 : 0.62;
    gl.world.env = env;
    envSky.material.dispose();
    envSky.geometry.dispose();
    pm.dispose();
  } catch (e) { /* IBL is optional */ }

  const wu = gl.post.world.material.uniforms;
  wu.uMapRect.value.set(-gl.halfX, -gl.halfZ, gl.halfX * 2, gl.halfZ * 2);
  wu.uFogColor.value.set(look.tod.fog);
  wu.uFogDensity.value = look.fogDensity * 0.3;
  wu.uSunDir.value.set(...look.sunDir);
  wu.uSunColor.value.set(look.tod.sun);
  wu.uCloudAmt.value = look.weather.clouds + 0.25;
  wu.uDust.value = look.weather.dust;
  const fu = gl.post.final.material.uniforms;
  fu.uExposure.value = look.tod.exposure;
  fu.uTint.value.set(...look.tod.tint);
  if (gl.post.bloom) gl.post.bloom.strength = look.night ? 0.62 : 0.42;

  initFog(gl);
  if (!gl.fx) gl.fx = createFx(gl);
  gl.fx.reset();
  if (!gl.ents) gl.ents = createEntities(gl);
  gl.ents.reset(state);

  const f = initialFocus(gl);
  gl.focus.set(f.x, 0, f.z);
  gl.tFocus.copy(gl.focus);
  updateCamera(gl, 0);
  gl.ready = true;
  if (gl.onWorldBuilt) gl.onWorldBuilt(gl);
}

function initialFocus(gl) {
  const st = gl.state;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner === gl.localSlot) return structCenter(gl, s);
  }
  for (const id in st.units) {
    const u = st.units[id];
    if (u.owner === gl.localSlot) return { x: wuToX(gl, u.x), z: wuToZ(gl, u.y) };
  }
  return { x: 0, z: 0 };
}

// ---------------------------------------------------------------------------
// coordinates
// ---------------------------------------------------------------------------
export function wuToX(gl, x) { return (x / CELL - gl.mapW / 2) * S; }
export function wuToZ(gl, y) { return (y / CELL - gl.mapH / 2) * S; }
export function xToWu(gl, x) { return (x / S + gl.mapW / 2) * CELL; }
export function zToWu(gl, z) { return (z / S + gl.mapH / 2) * CELL; }
export function structCenter(gl, s) {
  return {
    x: wuToX(gl, s.cx * CELL + s.fp * (CELL / 2)),
    z: wuToZ(gl, s.cy * CELL + s.fp * (CELL / 2)),
  };
}

// ---------------------------------------------------------------------------
// fog of war texture (R = visible now, G = explored), eased over time
// ---------------------------------------------------------------------------
function initFog(gl) {
  const n = gl.mapW * gl.mapH;
  if (gl.fogTex) gl.fogTex.dispose();
  gl.fogData = new Uint8Array(n * 2);
  gl.fogCur = new Float32Array(n * 2);
  gl.fogTex = new THREE.DataTexture(gl.fogData, gl.mapW, gl.mapH, THREE.RGFormat);
  gl.fogTex.magFilter = THREE.LinearFilter;
  gl.fogTex.minFilter = THREE.LinearFilter;
  gl.fogTex.wrapS = gl.fogTex.wrapT = THREE.ClampToEdgeWrapping;
  gl.fogTex.needsUpdate = true;
  gl.post.world.material.uniforms.uFogTex.value = gl.fogTex;
  gl.fogTick = -1;
  gl.fogSettled = false;
}

function updateFog(gl, dt) {
  const st = gl.state;
  const wu = gl.post.world.material.uniforms;
  wu.uReveal.value = damp(wu.uReveal.value, (gl.reveal || gl.cineReveal) ? 1 : 0, 3, dt);
  const fog = st.fog && st.fog[gl.localSlot];
  if (!fog) { wu.uReveal.value = 1; return; }
  const n = gl.mapW * gl.mapH;
  const cur = gl.fogCur, data = gl.fogData;
  const vis = fog.visible, seen = fog.seen;
  // team vision: allies share sight
  let allies = null;
  const me = st.players[gl.localSlot];
  if (me) {
    for (const p of st.players) {
      if (p.slot !== gl.localSlot && p.team === me.team && st.fog[p.slot]) {
        (allies || (allies = [])).push(st.fog[p.slot]);
      }
    }
  }
  const k = gl.fogSettled ? 1 - Math.exp(-dt * 7) : 1;
  let moving = false;
  for (let i = 0; i < n; i++) {
    let v = vis[i], s = seen[i];
    if (allies) for (const a of allies) { if (a.visible[i]) v = 1; if (a.seen[i]) s = 1; }
    const c0 = cur[i * 2], c1 = cur[i * 2 + 1];
    const n0 = c0 + (v - c0) * k, n1 = c1 + (s - c1) * k;
    if (Math.abs(n0 - c0) > 0.002 || Math.abs(n1 - c1) > 0.002) moving = true;
    cur[i * 2] = n0; cur[i * 2 + 1] = n1;
    data[i * 2] = n0 * 255; data[i * 2 + 1] = n1 * 255;
  }
  gl.fogSettled = true;
  if (moving || gl.fogTick !== st.tick) gl.fogTex.needsUpdate = true;
  gl.fogTick = st.tick;
}

export function fogVisibleAt(gl, wx, wy) {
  if (gl.reveal) return true;
  const st = gl.state;
  const fog = st.fog && st.fog[gl.localSlot];
  if (!fog) return true;
  const cx = Math.floor(wx / CELL), cy = Math.floor(wy / CELL);
  if (cx < 0 || cy < 0 || cx >= gl.mapW || cy >= gl.mapH) return false;
  const i = cy * gl.mapW + cx;
  if (fog.visible[i] === 1) return true;
  const me = st.players[gl.localSlot];
  if (me) {
    for (const p of st.players) {
      if (p.slot !== gl.localSlot && p.team === me.team && st.fog[p.slot]
        && st.fog[p.slot].visible[i] === 1) return true;
    }
  }
  return false;
}

export function fogSeenAt(gl, cx, cy) {
  if (gl.reveal) return true;
  const st = gl.state;
  const fog = st.fog && st.fog[gl.localSlot];
  if (!fog) return true;
  if (cx < 0 || cy < 0 || cx >= gl.mapW || cy >= gl.mapH) return false;
  return fog.seen[cy * gl.mapW + cx] === 1;
}

// the minimap still reads the legacy 2D fog canvas: keep it fed from the sim
export function syncLegacyFog(game) {
  const st = game.state;
  const R = game.render;
  if (!st || !R || !R.fogCtx || R.fogTick === st.tick) return;
  const fog = st.fog && st.fog[game.playerSlot || 0];
  if (!fog) return;
  R.fogTick = st.tick;
  const S2 = R.fogScale || 1;
  const w = st.map.w, h = st.map.h;
  const px32 = new Uint32Array(R.fogImg.data.buffer);
  const stride = w * S2;
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const i = cy * w + cx;
      const a = fog.visible[i] ? 0 : fog.seen[i] ? 90 : 255;
      const v = (a << 24) | 0;
      const o0 = cy * S2 * stride + cx * S2;
      for (let dy = 0; dy < S2; dy++) {
        const o = o0 + dy * stride;
        for (let dx = 0; dx < S2; dx++) px32[o + dx] = v;
      }
    }
  }
  R.fogCtx.putImageData(R.fogImg, 0, 0);
}

// ---------------------------------------------------------------------------
// camera
// ---------------------------------------------------------------------------
const MIN_DIST = 16, MAX_DIST = 210;

export function updateCamera(gl, dt) {
  const hf = gl.hf;
  if (!gl.camLock) {
    const mx = gl.halfX + 6, mz = gl.halfZ + 6;
    gl.tFocus.x = clamp(gl.tFocus.x, -mx, mx);
    gl.tFocus.z = clamp(gl.tFocus.z, -mz, mz);
    gl.tDist = clamp(gl.tDist, MIN_DIST, MAX_DIST);
    gl.tPitch = clamp(gl.tPitch, 0.32, 1.45);
  }
  if (dt > 0) {
    const r = gl.camLock ? 1e3 : 14;
    gl.focus.x = damp(gl.focus.x, gl.tFocus.x, r, dt);
    gl.focus.z = damp(gl.focus.z, gl.tFocus.z, r, dt);
    gl.dist = damp(gl.dist, gl.tDist, gl.camLock ? 1e3 : 10, dt);
    gl.yaw += angleDelta(gl.yaw, gl.tYaw) * (1 - Math.exp(-(gl.camLock ? 1e3 : 12) * dt));
    gl.pitch = damp(gl.pitch, gl.tPitch, gl.camLock ? 1e3 : 12, dt);
  } else {
    gl.focus.x = gl.tFocus.x; gl.focus.z = gl.tFocus.z;
    gl.dist = gl.tDist; gl.yaw = gl.tYaw; gl.pitch = gl.tPitch;
  }
  const gy = hf ? Math.max(WATER_Y, hf.heightAt(gl.focus.x, gl.focus.z)) : 0;
  gl.focus.y = dt > 0 ? damp(gl.focus.y, gy, 5, dt) : gy;
  const cp = Math.cos(gl.pitch);
  const cam = gl.camera;
  cam.position.set(
    gl.focus.x + Math.sin(gl.yaw) * cp * gl.dist,
    gl.focus.y + Math.sin(gl.pitch) * gl.dist,
    gl.focus.z + Math.cos(gl.yaw) * cp * gl.dist,
  );
  if (hf) {
    const floor = Math.max(WATER_Y, hf.heightAt(cam.position.x, cam.position.z)) + 2.2;
    if (cam.position.y < floor) cam.position.y = floor;
  }
  let lx = gl.focus.x, ly = gl.focus.y + (gl.lookLift || 0), lz = gl.focus.z;
  if (gl.shake > 0.001) {
    gl.shakeT += dt * 38;
    const a = gl.shake * 0.5;
    cam.position.x += Math.sin(gl.shakeT * 1.3) * a;
    cam.position.y += Math.sin(gl.shakeT * 1.7 + 1.1) * a * 0.7;
    lx += Math.sin(gl.shakeT * 1.1 + 2.0) * a * 0.6;
    lz += Math.cos(gl.shakeT * 0.9) * a * 0.6;
    gl.shake *= Math.exp(-dt * 5.5);
  }
  cam.lookAt(lx, ly, lz);
  cam.updateMatrixWorld();
  if (gl.world) gl.world.sky.position.copy(cam.position);
  if (gl.lights && gl.quality.shadows > 0) {
    // cover what the camera sees: wider when zoomed out or looking shallow
    const r = gl.dist * (0.62 + 0.5 * (1.2 - Math.min(1.2, gl.pitch)));
    updateSunShadow(gl.lights, gl.look, gl.focus, r);
  }
}

export function addShake(gl, amount, x, z) {
  if (x !== undefined) {
    const d = Math.hypot(x - gl.focus.x, z - gl.focus.z);
    amount *= clamp(1.3 - d / (gl.dist * 1.6 + 30), 0, 1);
  }
  gl.shake = Math.min(1.6, gl.shake + amount);
}

export function focusGl(game, wuX, wuY, dist, yaw, pitch, smooth) {
  const gl = game && game.gl;
  if (!gl) return;
  gl.tFocus.x = wuToX(gl, wuX);
  gl.tFocus.z = wuToZ(gl, wuY);
  if (dist !== undefined && dist !== null) gl.tDist = clamp(dist, 6, 400);
  if (yaw !== undefined && yaw !== null) gl.tYaw = yaw;
  if (pitch !== undefined && pitch !== null) gl.tPitch = clamp(pitch, 0.1, 1.5);
  if (!smooth) updateCamera(gl, 0);
}

function applyCameraProxy(gl) {
  const cam = gl.game.camera;
  if (!cam || !cam.viewW) return;
  if (!gl.proxy.ready) {
    gl.proxy.ready = true;
    gl.proxy.x = cam.x; gl.proxy.y = cam.y; gl.proxy.zoom = cam.zoom;
    return;
  }
  if (gl.proxy.x !== null
    && (Math.abs(cam.x - gl.proxy.x) > 0.75 || Math.abs(cam.y - gl.proxy.y) > 0.75)) {
    // HUD / minimap moved the logical camera: follow it
    const wx = cam.x + cam.viewW / (2 * cam.zoom);
    const wy = cam.y + cam.viewH / (2 * cam.zoom);
    gl.tFocus.x = wuToX(gl, wx);
    gl.tFocus.z = wuToZ(gl, wy);
  }
}

function writeCameraProxy(gl) {
  const cam = gl.game.camera;
  if (!cam || !cam.viewW) return;
  const vfov = gl.camera.fov * Math.PI / 180;
  const renderH = 2 * gl.dist * Math.tan(vfov / 2) / Math.max(0.35, Math.sin(gl.pitch));
  const renderW = 2 * gl.dist * Math.tan(vfov / 2) * gl.camera.aspect;
  const zoom = clamp(cam.viewW / Math.max(1, renderW * (CELL / S)), 0.05, 4);
  void renderH;
  const fx = xToWu(gl, gl.tFocus.x), fz = zToWu(gl, gl.tFocus.z);
  cam.zoom = zoom;
  cam.x = fx - cam.viewW / (2 * zoom);
  cam.y = fz - cam.viewH / (2 * zoom);
  gl.proxy.x = cam.x; gl.proxy.y = cam.y; gl.proxy.zoom = cam.zoom;
}

export function setGlVisible(game, on) {
  const gl = game && game.gl;
  if (!gl) return;
  gl.visible = !!on;
  gl.canvas.style.display = on ? 'block' : 'none';
  if (game.canvas && game.canvas !== gl.canvas) {
    game.canvas.style.visibility = on ? 'hidden' : 'visible';
  }
  if (on) resizeGl(gl);
}

// screen px -> ray -> terrain hit (march, then bisect). Falls back to sea level.
function screenRay(gl, sx, sy) {
  const cw = gl.canvas.clientWidth || 1, ch = gl.canvas.clientHeight || 1;
  _ndc.set((sx / cw) * 2 - 1, -(sy / ch) * 2 + 1);
  _ray.setFromCamera(_ndc, gl.camera);
  return _ray.ray;
}

function rayTerrain(gl, ray, out) {
  const hf = gl.hf;
  const o = ray.origin, d = ray.direction;
  if (!hf) {
    const t = d.y < -1e-5 ? -o.y / d.y : 0;
    return out.set(o.x + d.x * t, 0, o.z + d.z * t);
  }
  let t0 = 0, prev = 0;
  const maxT = 900;
  let stepT = 1.5;
  for (let t = 0; t < maxT; t += stepT) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    const h = Math.max(WATER_Y, hf.heightAt(x, z));
    if (y <= h) {
      let a = prev, b = t;
      for (let i = 0; i < 12; i++) {
        const m = (a + b) / 2;
        const mh = Math.max(WATER_Y, hf.heightAt(o.x + d.x * m, o.z + d.z * m));
        if (o.y + d.y * m <= mh) b = m; else a = m;
      }
      t0 = (a + b) / 2;
      return out.set(o.x + d.x * t0, o.y + d.y * t0, o.z + d.z * t0);
    }
    prev = t;
    stepT = Math.min(6, 1.2 + t * 0.02);
  }
  const t = d.y < -1e-5 ? -o.y / d.y : maxT;
  return out.set(o.x + d.x * t, 0, o.z + d.z * t);
}

export function glScreenToWorld(game, sx, sy) {
  const gl = game && game.gl;
  if (!gl || !gl.hf) return { x: 0, y: 0 };
  const p = rayTerrain(gl, screenRay(gl, sx, sy), _v3);
  return { x: xToWu(gl, p.x), y: zToWu(gl, p.z) };
}

export function glWorldToScreen(game, wx, wy, height) {
  const gl = game && game.gl;
  if (!gl || !gl.hf) return null;
  const x = wuToX(gl, wx), z = wuToZ(gl, wy);
  const y = Math.max(WATER_Y, gl.hf.heightAt(x, z)) + (height === undefined ? 0.5 : height);
  return projectPoint(gl, x, y, z);
}

export function projectPoint(gl, x, y, z, out) {
  const cam = gl.camera;
  _v3.set(x, y, z);
  _v3b.copy(_v3).applyMatrix4(cam.matrixWorldInverse);
  if (_v3b.z > -cam.near) return null;
  _v3.project(cam);
  const cw = gl.viewW || gl.canvas.clientWidth || 1, ch = gl.viewH || gl.canvas.clientHeight || 1;
  const o = out || {};
  o.x = (_v3.x * 0.5 + 0.5) * cw;
  o.y = (-_v3.y * 0.5 + 0.5) * ch;
  o.depth = -_v3b.z;
  return o;
}

// screen position of a unit as drawn (aircraft altitude, interpolation)
export function glUnitToScreen(game, u) {
  const gl = game && game.gl;
  if (!gl || !gl.ents) return null;
  const rec = gl.ents.units.get(u.id);
  if (!rec) return glWorldToScreen(game, u.x, u.y);
  const p = rec.root.position;
  return projectPoint(gl, p.x, p.y + rec.height * 0.4, p.z);
}

// the ground footprint of the view (4 corners, sim world units) for the minimap
export function glViewQuad(game) {
  const gl = game && game.gl;
  if (!gl || !gl.hf) return null;
  const w = gl.viewW || 1, h = gl.viewH || 1;
  const out = [];
  for (const [sx, sy] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const ray = screenRay(gl, sx, sy);
    const o = ray.origin, d = ray.direction;
    // intersect with the focus-height plane; clamp rays that miss the ground
    let t = d.y < -0.02 ? (gl.focus.y - o.y) / d.y : 900;
    t = Math.min(t, 900);
    out.push({ x: xToWu(gl, o.x + d.x * t), y: zToWu(gl, o.z + d.z * t) });
  }
  return out;
}

export function panGlBy(game, dxPx, dyPx) {
  const gl = game && game.gl;
  if (!gl || gl.camLock) return;
  const h = gl.canvas.clientHeight || 1;
  const wpp = 2 * gl.dist * Math.tan(gl.camera.fov * Math.PI / 360) / h;
  const rx = Math.cos(gl.yaw), rz = -Math.sin(gl.yaw);
  const fx = -Math.sin(gl.yaw), fz = -Math.cos(gl.yaw);
  const fwd = dyPx / Math.max(0.42, Math.sin(gl.pitch));
  gl.tFocus.x += (rx * dxPx - fx * fwd) * wpp;
  gl.tFocus.z += (rz * dxPx - fz * fwd) * wpp;
}

export function zoomGlBy(game, factor) {
  const gl = game && game.gl;
  if (!gl || gl.camLock) return;
  gl.tDist = clamp(gl.tDist / factor, MIN_DIST, MAX_DIST);
}

export function setCinematicReveal(game, on) {
  const gl = game && game.gl;
  if (gl) gl.cineReveal = !!on;
}

// pick the entity under the cursor in screen space (works for aircraft at
// altitude and units on slopes, unlike a ground-plane hit)
export function glPickEntity(game, sx, sy, filter) {
  const gl = game && game.gl;
  if (!gl || !gl.ents) return null;
  return gl.ents.pick(sx, sy, filter);
}

function bindControls(gl) {
  const canvas = gl.canvas;
  const key = (e) => (e.key || '').toLowerCase();
  const panKeys = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
  const blocked = () => {
    const g = gl.game;
    return !!(g && (g.overlay || g.paused || g.chatOpen || gl.camLock
      || (g.cinema && g.cinema.active)));
  };
  globalThis.addEventListener('keydown', (e) => {
    if (blocked()) return;
    const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select'
      || (e.target && e.target.isContentEditable)) return;
    const k = key(e);
    if (panKeys.includes(k) || (gl.wasdPan && 'wasd'.includes(k) && k.length === 1) || k === 'shift') {
      gl.keys.add(k);
      if (k !== 'shift' && e.preventDefault) e.preventDefault();
    }
  });
  globalThis.addEventListener('keyup', (e) => gl.keys.delete(key(e)));
  globalThis.addEventListener('blur', () => gl.keys.clear());

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 2 || blocked()) return;
    gl.dragging = true;
    gl.lastPointer.x = e.clientX; gl.lastPointer.y = e.clientY;
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* noop */ } }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!gl.dragging) return;
    const dx = e.clientX - gl.lastPointer.x, dy = e.clientY - gl.lastPointer.y;
    gl.lastPointer.x = e.clientX; gl.lastPointer.y = e.clientY;
    gl.tYaw -= dx * 0.0052;
    gl.tPitch = clamp(gl.tPitch + dy * 0.0036, 0.32, 1.45);
  });
  const endDrag = (e) => {
    gl.dragging = false;
    if (canvas.releasePointerCapture && e && e.pointerId !== undefined) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (blocked()) return;
    const before = gl.tDist;
    const next = clamp(before * Math.exp(clamp(e.deltaY, -240, 240) * 0.0014), MIN_DIST, MAX_DIST);
    if (next === before) return;
    // zoom toward the cursor: keep the ground point under it roughly fixed
    const r = canvas.getBoundingClientRect();
    const p = rayTerrain(gl, screenRay(gl, e.clientX - r.left, e.clientY - r.top), _v3);
    const k = 1 - next / before;
    if (next < before) {
      gl.tFocus.x += (p.x - gl.tFocus.x) * k;
      gl.tFocus.z += (p.z - gl.tFocus.z) * k;
    }
    gl.tDist = next;
    // closer = lower, more dramatic angle; farther = more top-down overview
    const t = (Math.log(next) - Math.log(MIN_DIST)) / (Math.log(MAX_DIST) - Math.log(MIN_DIST));
    if (!gl.userPitch) gl.tPitch = lerp(0.6, 1.02, clamp(t, 0, 1));
  }, { passive: false });
}

function updateControls(gl, dt) {
  const game = gl.game;
  if (game && (game.overlay || game.paused || gl.camLock || (game.cinema && game.cinema.active))) {
    gl.keys.clear();
    return;
  }
  let fx = 0, fz = 0;
  const K = gl.keys, w = gl.wasdPan;
  if (K.has('arrowup') || (w && K.has('w'))) { fx -= Math.sin(gl.yaw); fz -= Math.cos(gl.yaw); }
  if (K.has('arrowdown') || (w && K.has('s'))) { fx += Math.sin(gl.yaw); fz += Math.cos(gl.yaw); }
  if (K.has('arrowright') || (w && K.has('d'))) { fx += Math.cos(gl.yaw); fz -= Math.sin(gl.yaw); }
  if (K.has('arrowleft') || (w && K.has('a'))) { fx -= Math.cos(gl.yaw); fz += Math.sin(gl.yaw); }
  if (fx || fz) {
    const len = Math.hypot(fx, fz) || 1;
    const speed = gl.dist * 1.15 * dt * (K.has('shift') ? 2.2 : 1);
    gl.tFocus.x += fx / len * speed;
    gl.tFocus.z += fz / len * speed;
  }
  if (game && game.mouse && game.mouse.inside && !game.midDrag && !gl.dragging
    && game.state && !game.overlay && document.hasFocus && document.hasFocus()) {
    let ex = 0, ey = 0;
    const m = game.mouse;
    if (m.sx < 10) ex -= 1;
    if (m.sx > gl.canvas.clientWidth - 10) ex += 1;
    if (m.sy < 10) ey -= 1;
    if (m.sy > gl.canvas.clientHeight - 10) ey += 1;
    if (ex || ey) panGlBy(game, ex * 900 * dt, ey * 900 * dt);
  }
}

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------
export function glFrame(game, dtMs) {
  const gl = game && game.gl;
  if (!gl || !gl.ready || !gl.state || !gl.visible) return;
  const dt = Math.min(0.1, Math.max(0.0001, dtMs / 1000));
  gl.time += dt;
  gl.frame++;
  if (gl.game.camera && !gl.attract) applyCameraProxy(gl);
  updateControls(gl, dt);
  updateCamera(gl, dt);

  const t = gl.time;
  gl.world.water.material.uniforms.uTime.value = t;
  gl.world.sky.material.uniforms.uTime.value = t;
  gl.post.world.material.uniforms.uTime.value = t;
  gl.post.final.material.uniforms.uTime.value = t;
  for (const o of gl.world.oil) {
    o.userData.beam.rotation.z = Math.sin(t * 1.6 + o.userData.phase) * 0.24;
  }

  gl.ents.sync(dt);
  gl.fx.update(dt);
  updateFog(gl, dt);
  if (gl.portraits) gl.portraits.step();

  gl.renderer.info.reset();
  gl.post.render(dt);

  gl.ents.drawOverlay();
  if (gl.game.camera && !gl.attract) writeCameraProxy(gl);

  // rolling stats + automatic resolution scaling when the GPU cannot keep up
  gl.fpsAcc += dtMs; gl.fpsN++;
  if (gl.fpsAcc >= 1000) {
    const ms = gl.fpsAcc / gl.fpsN;
    gl.stats.ms = ms; gl.stats.fps = 1000 / ms;
    gl.stats.calls = gl.renderer.info.render.calls;
    gl.stats.tris = gl.renderer.info.render.triangles;
    gl.fpsAcc = 0; gl.fpsN = 0;
    if (!gl.noAutoScale && gl.time > 4) {
      const scale = gl.resScale || 1;
      if (ms > 30 && scale > 0.6) { gl.resScale = Math.max(0.6, scale - 0.1); resizeGl(gl); }
      else if (ms < 14 && scale < 1) { gl.resScale = Math.min(1, scale + 0.05); resizeGl(gl); }
    }
  }
}

export { CELL, S, WU, hexToRgb };
