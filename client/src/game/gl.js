// MCA 3D renderer prototype (Three.js r128, loaded as a global UMD build).
//
// This module is additive: it does not replace render.js. initGl(game) creates
// a WebGL scene next to the existing 2D canvas (or on game.canvas when it is
// still untouched), builds the terrain from game.state.map, and glFrame()
// mirrors game.state.units / .structures into low-poly multi-primitive models.
//
// World scale: 1 map cell (CELL = 64 sim world units) is 2 render units, so a
// sim world unit is 1/32 render unit. RTS camera: right-drag orbit, wheel zoom,
// WASD / arrows pan.
import { canPlaceReason } from '../sim/index.js';

let THREE = null;

const CELL = 64;
const S = 2;                       // render units per map cell
const WU = S / CELL;               // render units per sim world unit
const WATER_Y = 0.035;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

function hash01(x, y, z) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)
    + Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function mixHex(base, other, amount) {
  const a = new THREE.Color(base);
  const b = new THREE.Color(other);
  return a.lerp(b, amount).getHex();
}

// ---------------------------------------------------------------------------
// materials / primitive helpers
// ---------------------------------------------------------------------------

function material(gl, color, opts = {}) {
  const rough = opts.rough === undefined ? 0.82 : opts.rough;
  const metal = opts.metal === undefined ? 0.05 : opts.metal;
  const side = opts.side || THREE.FrontSide;
  const flat = !!opts.flat;
  const opacity = opts.opacity === undefined ? 1 : opts.opacity;
  const emissive = opts.emissive || 0;
  const key = `${color}|${rough}|${metal}|${side}|${flat ? 1 : 0}|${opacity}|${emissive}`;
  let m = gl.matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color, roughness: rough, metalness: metal, side,
      flatShading: flat, transparent: opacity < 1, opacity,
      emissive: emissive ? new THREE.Color(emissive) : 0x000000,
      emissiveIntensity: emissive ? 1 : 0,
    });
    gl.matCache.set(key, m);
  }
  return m;
}

function addMesh(parent, geo, mat, x, y, z, opts = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x || 0, y || 0, z || 0);
  if (opts.rx) m.rotation.x = opts.rx;
  if (opts.ry) m.rotation.y = opts.ry;
  if (opts.rz) m.rotation.z = opts.rz;
  if (opts.sx || opts.sy || opts.sz) m.scale.set(opts.sx || 1, opts.sy || 1, opts.sz || 1);
  if (opts.cast) m.castShadow = true;
  if (opts.receive) m.receiveShadow = true;
  if (opts.name) m.name = opts.name;
  parent.add(m);
  return m;
}

function box(parent, w, h, d, mat, x, y, z, opts = {}) {
  return addMesh(parent, new THREE.BoxGeometry(w, h, d), mat, x, y, z, opts);
}

function cyl(parent, rt, rb, h, mat, x, y, z, opts = {}) {
  const seg = opts.seg || 10;
  return addMesh(parent, new THREE.CylinderGeometry(rt, rb, h, seg), mat, x, y, z, opts);
}

function sphere(parent, r, mat, x, y, z, opts = {}) {
  const seg = opts.seg || 10;
  return addMesh(parent, new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1)),
    mat, x, y, z, opts);
}

function cone(parent, r, h, mat, x, y, z, opts = {}) {
  return addMesh(parent, new THREE.ConeGeometry(r, h, opts.seg || 10), mat, x, y, z, opts);
}

function torus(parent, r, tube, mat, x, y, z, opts = {}) {
  return addMesh(parent, new THREE.TorusGeometry(r, tube, 6, 16), mat, x, y, z, opts);
}

// Beveled box extruded along +Y with the footprint centered on X/Z.
function bevelBoxGeo(w, d, h, bevel = 0.05) {
  const hw = w / 2, hd = d / 2;
  const r = Math.min(w, d) * 0.10;
  const sh = new THREE.Shape();
  sh.moveTo(-hw + r, -hd);
  sh.lineTo(hw - r, -hd);
  sh.quadraticCurveTo(hw, -hd, hw, -hd + r);
  sh.lineTo(hw, hd - r);
  sh.quadraticCurveTo(hw, hd, hw - r, hd);
  sh.lineTo(-hw + r, hd);
  sh.quadraticCurveTo(-hw, hd, -hw, hd - r);
  sh.lineTo(-hw, -hd + r);
  sh.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: h, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel,
    bevelSegments: 2, curveSegments: 4, steps: 1,
  });
  g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

function roundedPlaneGeo(w, d, bevel, h) {
  return bevelBoxGeo(w, d, h, bevel);
}

// Soft round particle texture (muzzle flashes, steam, explosions) generated
// locally so the prototype stays offline.
function softCircleTexture(gl, inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 2, 64, 64, 62);
  g.addColorStop(0, inner);
  g.addColorStop(0.45, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export function initGl(game) {
  if (!game) throw new Error('initGl: no game object');
  if (game.gl) return game.gl;
  THREE = globalThis.THREE;
  if (!THREE) throw new Error('initGl: THREE global missing (load vendor/three.min.js first)');

  const state = game.state;
  if (!state || !state.map) throw new Error('initGl: game.state.map missing');

  // If the game already owns a 2D context, that canvas cannot become a WebGL
  // canvas. Overlay a fresh one (existing file untouched) and leave the 2D
  // drawing underneath hidden.
  const existing = game.glCanvas || game.canvas || document.getElementById('game');
  let canvas = existing;
  let renderer = null;
  const pixelOwner2d = !!game.ctx || (existing && existing.getContext
    && game.glForceNewCanvas);
  if (!pixelOwner2d && existing) {
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: existing, antialias: true, alpha: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: !!globalThis.navigator.webdriver,
      });
    } catch (err) {
      renderer = null;
    }
  }
  if (!renderer) {
    const overlay = document.createElement('canvas');
    overlay.id = 'gl-canvas';
    overlay.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;'
      + 'display:block;z-index:2;touch-action:none;outline:none;';
    document.body.insertBefore(overlay, document.body.firstChild);
    if (existing && existing !== overlay) existing.style.visibility = 'hidden';
    canvas = overlay;
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: !!globalThis.navigator.webdriver,
    });
  }

  const map = state.map;
  const gl = {
    game, state, canvas, renderer, THREE,
    scene: new THREE.Scene(),
    camera: null,
    map,
    mapW: map.w, mapH: map.h,
    halfX: map.w * S / 2, halfZ: map.h * S / 2,
    localSlot: game.playerSlot || 0,
    matCache: new Map(),
    units: new Map(),
    structs: new Map(),
    effects: [],
    tracerLines: new Map(),
    seenTracers: new Set(),
    time: 0,
    yaw: 0.42,
    pitch: 0.82,
    dist: 82,
    focus: new THREE.Vector3(0, 0, 0),
    keys: new Set(),
    wasdPan: true, // standalone preview uses WASD; the real game has A/S/D hotkeys
    dragging: false,
    lastPointer: { x: 0, y: 0 },
    stats: { units: 0, structures: 0, meshes: 0, tick: 0 },
    waterUniform: { value: 0 },
    sun: null,
    steamTex: null,
    smokeTex: null,
    flashTex: null,
    glowTex: null,
    foamMat: null,
    fogTick: -1,
    fogSlot: -1,
    proxy: { x: null, y: null, zoom: 1, ready: false },
    ready: false,
  };
  game.gl = gl;

  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  const cw = canvas.clientWidth || globalThis.innerWidth || 1280;
  const ch = canvas.clientHeight || globalThis.innerHeight || 720;
  renderer.setSize(cw, ch, false);
  renderer.setClearColor(0xd8c7a0, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // r128 predates automatic color management: hex albedos are used as-is.
  // Keep the framebuffer in the same space (no double gamma) and skip ACES,
  // which was flattening the desert into white.
  renderer.outputEncoding = THREE.LinearEncoding;
  renderer.toneMapping = THREE.NoToneMapping;

  gl.scene.fog = new THREE.Fog(0xd8c7a0, 70, 320);

  gl.camera = new THREE.PerspectiveCamera(46, cw / Math.max(1, ch), 0.4, 2200);

  gl.steamTex = softCircleTexture(gl, 'rgba(255,255,255,0.95)', 'rgba(230,230,225,0.35)');
  gl.smokeTex = softCircleTexture(gl, 'rgba(70,66,58,0.85)', 'rgba(45,42,36,0.25)');
  gl.flashTex = softCircleTexture(gl, 'rgba(255,246,200,1)', 'rgba(255,170,60,0.55)');
  gl.glowTex = softCircleTexture(gl, 'rgba(255,255,255,0.9)', 'rgba(255,220,140,0.3)');

  buildSky(gl);
  buildLights(gl);
  gl.env = new THREE.Group();
  gl.scene.add(gl.env);
  buildEnvironment(gl);
  buildSelectionGroup(gl);
  buildGhost(gl);

  // Frame the first player's base, or the map center.
  const f = initialFocus(gl);
  gl.focus.set(f.x, 0, f.z);
  updateCamera(gl);

  bindControls(gl);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => resizeGl(gl));
    ro.observe(canvas);
    gl.resizeObserver = ro;
  }
  globalThis.addEventListener('resize', () => resizeGl(gl));

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (globalThis.__glErrors) globalThis.__glErrors.push('webglcontextlost');
  });

  gl.ready = true;
  return gl;
}

function resizeGl(gl) {
  const w = gl.canvas.clientWidth || globalThis.innerWidth || 1280;
  const h = gl.canvas.clientHeight || globalThis.innerHeight || 720;
  if (!w || !h) return;
  gl.renderer.setSize(w, h, false);
  gl.camera.aspect = w / h;
  gl.camera.updateProjectionMatrix();
}

function initialFocus(gl) {
  const st = gl.state;
  let sx = 0, sz = 0, n = 0;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner !== 0) continue;
    const c = structCenterWu(gl, s);
    sx += c.x; sz += c.z; n++;
  }
  if (n) return { x: sx / n, z: sz / n };
  for (const id in st.units) {
    const u = st.units[id];
    if (u.owner !== 0) continue;
    const p = unitWorld(gl, u);
    sx += p.x; sz += p.z; n++;
  }
  if (n) return { x: sx / n, z: sz / n };
  return { x: 0, z: 0 };
}

export function focusGl(game, wuX, wuY, dist, yaw, pitch) {
  const gl = game && game.gl;
  if (!gl) return;
  const x = wuToX(gl, wuX);
  const z = wuToZ(gl, wuY);
  gl.focus.x = x;
  gl.focus.z = z;
  if (dist !== undefined && dist !== null) gl.dist = clamp(dist, 6, 340);
  if (yaw !== undefined && yaw !== null) gl.yaw = yaw;
  if (pitch !== undefined && pitch !== null) gl.pitch = clamp(pitch, 0.18, 1.45);
  updateCamera(gl);
}

// ---------------------------------------------------------------------------
// world conversion / terrain height
// ---------------------------------------------------------------------------

function wuToX(gl, x) { return (x / CELL - gl.mapW / 2) * S; }
function wuToZ(gl, y) { return (y / CELL - gl.mapH / 2) * S; }
function cellToX(gl, cx) { return (cx - gl.mapW / 2) * S; }
function cellToZ(gl, cy) { return (cy - gl.mapH / 2) * S; }

function structCenterWu(gl, s) {
  return {
    x: wuToX(gl, s.cx * CELL + s.fp * (CELL / 2)),
    z: wuToZ(gl, s.cy * CELL + s.fp * (CELL / 2)),
  };
}

function unitWorld(gl, u) {
  return { x: wuToX(gl, u.x), z: wuToZ(gl, u.y) };
}

function terrainTypeAt(gl, cx, cy) {
  const m = gl.state.map;
  if (cx < 0 || cy < 0 || cx >= m.w || cy >= m.h) return -1;
  return m.terrain[cy * m.w + cx];
}

function cellNoise(cx, cy) {
  return hash01(cx * 17 + 3, cy * 31 + 7, 11);
}

// Smooth deterministic dune field (no Math.random anywhere). The same
// function positions terrain vertices and unit ground height, so vehicles sit
// on the visible sand instead of hovering.
function duneNoise(x, z) {
  return Math.sin(x * 0.075 + Math.sin(z * 0.052) * 1.8) * 0.5
    + Math.sin(z * 0.105 + x * 0.031) * 0.30
    + Math.sin((x + z) * 0.235 + 1.7) * 0.20;
}

function sandHeightAt(x, z) {
  return 0.02 + (duneNoise(x, z) + 1) * 0.5 * 0.30;
}

function rockHeightAt(cx, cy) {
  const n = hash01(cx, cy, 21);
  const step = Math.floor(n * 3);
  return 0.55 + step * 0.38 + hash01(cx, cy, 22) * 0.16;
}

function cellHeight(gl, cx, cy) {
  const t = terrainTypeAt(gl, cx, cy);
  if (t === 2) return -0.34;
  if (t === 1) return rockHeightAt(cx, cy);
  return sandHeightAt(cellToX(gl, cx + 0.5), cellToZ(gl, cy + 0.5));
}

function heightAtWu(gl, x, y, fallback = 0) {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  if (cx < 0 || cy < 0 || cx >= gl.mapW || cy >= gl.mapH) return fallback;
  const t = terrainTypeAt(gl, cx, cy);
  if (t === 2) return -0.34;
  if (t === 1) return rockHeightAt(cx, cy);
  return sandHeightAt(wuToX(gl, x), wuToZ(gl, y));
}

// ---------------------------------------------------------------------------
// sky, lights, terrain, water, scatter
// ---------------------------------------------------------------------------

function buildSky(gl) {
  const geo = new THREE.SphereGeometry(1500, 28, 14);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x4f7fa5) },
      horizon: { value: new THREE.Color(0xe4d3b0) },
      sunDir: { value: new THREE.Vector3(0.55, 0.55, 0.35).normalize() },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 c = mix(horizon, top, pow(h, 0.72));
        float s = pow(max(dot(d, normalize(sunDir)), 0.0), 220.0);
        c += vec3(1.0, 0.92, 0.72) * s * 0.55;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  gl.scene.add(sky);
  gl.sky = sky;
}

function buildLights(gl) {
  const hemi = new THREE.HemisphereLight(0xcfe2ee, 0x8d7a52, 0.38);
  hemi.position.set(0, 200, 0);
  gl.scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1cf, 1.15);
  sun.position.set(70, 110, 45);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera;
  // Wide enough that the shadow-map boundary sits inside the fog instead of
  // cutting a visible line across the desert.
  sc.left = -250; sc.right = 250; sc.top = 250; sc.bottom = -250;
  sc.near = 1; sc.far = 620;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.06;
  sun.shadow.radius = 3;
  gl.scene.add(sun);
  gl.scene.add(sun.target);
  gl.sun = sun;
}

function buildTerrain(gl) {
  const map = gl.state.map;
  const w = map.w, h = map.h;
  // Pad the visual terrain 48 cells outside the playable map so the camera
  // never sees the simulation boundary inside the fog.
  const PAD = 48;
  const gw = w + PAD * 2;
  const gh = h + PAD * 2;
  const geo = new THREE.PlaneGeometry(gw * S, gh * S, gw, gh);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const count = pos.count;
  const col = new Float32Array(count * 3);
  const sand = new THREE.Color('#b8a06a');
  const sandDark = new THREE.Color('#9c8654');
  const sandPale = new THREE.Color('#d4bd82');
  const rock = new THREE.Color('#6d6b64');
  const rockDark = new THREE.Color('#54534e');
  const water = new THREE.Color('#274b7a');
  const tmp = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const gx = Math.round(x / S + w / 2);
    const gy = Math.round(z / S + h / 2);
    const inside = gx >= 0 && gy >= 0 && gx < w && gy < h;
    const cx = Math.max(0, Math.min(w - 1, gx));
    const cy = Math.max(0, Math.min(h - 1, gy));
    const t = inside ? map.terrain[cy * w + cx] : 0;
    let y;
    if (inside && t === 2) y = -0.34;
    else if (inside && t === 1) y = rockHeightAt(cx, cy);
    else y = sandHeightAt(x, z) + (hash01(i, 5, 5) - 0.5) * 0.025;
    pos.setY(i, y);

    const n = hash01(i, 9, 9);
    if (inside && t === 2) {
      tmp.copy(water).multiplyScalar(0.78 + n * 0.16);
    } else if (inside && t === 1) {
      // Stepped mesa bands: each plateau tier gets its own grey value.
      const tier = Math.floor(hash01(cx, cy, 21) * 3) / 2;
      tmp.copy(rock).lerp(rockDark, tier * 0.55 + n * 0.18);
    } else {
      // Broad dune bands + fine grain keep the desert from reading as paper.
      const dune = (duneNoise(x, z) + 1) * 0.5;
      tmp.copy(sand).lerp(sandDark, 0.10 + dune * 0.22 + n * 0.22);
      if (dune > 0.62) tmp.lerp(sandPale, (dune - 0.62) * 0.55);
    }
    col[i * 3] = tmp.r;
    col[i * 3 + 1] = tmp.g;
    col[i * 3 + 2] = tmp.b;
  }
  pos.needsUpdate = true;
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0.0,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  gl.env.add(mesh);
  gl.terrain = mesh;

  // Heavy desert apron beyond the playable map so the border never shows void.
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(2600, 2600, 1, 1),
    material(gl, 0xc2ab78, { rough: 1 }),
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.035;
  apron.receiveShadow = true;
  gl.env.add(apron);
  gl.apron = apron;
}

function buildWater(gl) {
  const map = gl.state.map;
  const w = map.w, h = map.h;
  const waterCells = [];
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      if (map.terrain[cy * w + cx] === 2) waterCells.push(cx, cy);
    }
  }
  if (!waterCells.length) return;

  const count = waterCells.length / 2;
  const verts = new Float32Array(count * 4 * 3);
  const uv = new Float32Array(count * 4 * 2);
  const indexSize = count * 4 > 65535 ? Uint32Array : Uint16Array;
  const idx = new indexSize(count * 6);
  let vp = 0, up = 0, ip = 0;
  for (let k = 0; k < count; k++) {
    const cx = waterCells[k * 2], cy = waterCells[k * 2 + 1];
    const x0 = (cx - w / 2) * S, x1 = x0 + S;
    const z0 = (cy - h / 2) * S, z1 = z0 + S;
    const base = k * 4;
    const quad = [
      [x0, z0, 0, 0], [x1, z0, 1, 0], [x1, z1, 1, 1], [x0, z1, 0, 1],
    ];
    for (const [x, z, u, v] of quad) {
      verts[vp++] = x; verts[vp++] = WATER_Y; verts[vp++] = z;
      uv[up++] = u; uv[up++] = v;
    }
    idx[ip++] = base; idx[ip++] = base + 2; idx[ip++] = base + 1;
    idx[ip++] = base; idx[ip++] = base + 3; idx[ip++] = base + 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x2e6f9d, roughness: 0.13, metalness: 0.25,
    transparent: true, opacity: 0.82, side: THREE.DoubleSide,
    depthWrite: false,
  });
  // Vertex-displacement ripple + analytic normals, all in the vertex shader.
  // Amplitudes are deliberately readable at overview zoom (0.20 peak) and
  // the phases drift diagonally instead of standing still.
  const unif = gl.waterUniform;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = unif;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `
      float wvA = sin(position.x * 0.48 - uTime * 1.45 + position.z * 0.11);
      float wvB = sin(position.z * 0.66 + uTime * 1.05 - position.x * 0.07);
      float wvC = sin((position.x + position.z) * 1.65 + uTime * 2.1);
      float dyx = 0.105 * 0.48 * cos(position.x * 0.48 - uTime * 1.45 + position.z * 0.11)
                + 0.030 * 1.65 * cos((position.x + position.z) * 1.65 + uTime * 2.1);
      float dyz = 0.075 * 0.66 * cos(position.z * 0.66 + uTime * 1.05 - position.x * 0.07)
                + 0.030 * 1.65 * cos((position.x + position.z) * 1.65 + uTime * 2.1);
      vec3 objectNormal = normalize(vec3(-dyx, 1.0, -dyz));
      #ifdef USE_TANGENT
        vec3 objectTangent = vec3(tangent.xyz);
      #endif
      `,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      vec3 transformed = vec3(position);
      transformed.y += 0.105 * sin(position.x * 0.48 - uTime * 1.45 + position.z * 0.11)
                     + 0.075 * sin(position.z * 0.66 + uTime * 1.05 - position.x * 0.07)
                     + 0.030 * sin((position.x + position.z) * 1.65 + uTime * 2.1);
      `,
    );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  mesh.receiveShadow = false;
  gl.env.add(mesh);
  gl.water = mesh;
  gl.waterCells = waterCells;
  buildShore(gl, waterCells);
}

// Sandy shallow bank + foam line on every water cell edge that touches land.
// The bank blends sand→water over roughly one cell; the foam strip uses the
// existing local decal when it loads and stays a plain translucent strip
// otherwise (single-file/file:// safe).
function buildShore(gl, waterCells) {
  const map = gl.state.map;
  const w = map.w, h = map.h;
  const bankPos = [];
  const bankCol = [];
  const foamPos = [];
  const foamUV = [];
  const foamIdx = [];
  const sand = new THREE.Color(0xcbb37c);
  const deep = new THREE.Color(0x2e6f9d);

  const land = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return false;
    return map.terrain[cy * w + cx] !== 2;
  };
  // shoreline vertices (shade=1, sand) -> inner water vertices (shade=0, deep)
  const bankQuad = (ax, az, bx, bz, ix, iz, ix2, iz2) => {
    const pts = [[ax, az, 1], [bx, bz, 1], [ix, iz, 0], [ix2, iz2, 0]];
    for (const t of [0, 1, 2, 0, 2, 3]) {
      const p = pts[t];
      bankPos.push(p[0], WATER_Y + 0.075, p[1]);
      const k = (1 - p[2]) * 0.85;
      bankCol.push(lerp(sand.r, deep.r, k),
        lerp(sand.g, deep.g, k), lerp(sand.b, deep.b, k));
    }
  };
  const foamQuad = (ax, az, bx, bz, cx, cz, dx, dz) => {
    const base = foamPos.length / 3;
    foamPos.push(ax, WATER_Y + 0.115, az, bx, WATER_Y + 0.115, bz,
      cx, WATER_Y + 0.115, cz, dx, WATER_Y + 0.115, dz);
    foamUV.push(0, 0, 1, 0, 1, 1, 0, 1);
    foamIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (let k = 0; k < waterCells.length; k += 2) {
    const cx = waterCells[k], cy = waterCells[k + 1];
    const x0 = (cx - w / 2) * S, x1 = x0 + S;
    const z0 = (cy - h / 2) * S, z1 = z0 + S;
    const inner = S * 0.92;
    if (land(cx, cy - 1)) {
      bankQuad(x0, z0, x1, z0, x1, z0 + inner, x0, z0 + inner);
      foamQuad(x0, z0 - 0.03, x1, z0 - 0.03, x1, z0 + 0.13, x0, z0 + 0.13);
    }
    if (land(cx, cy + 1)) {
      bankQuad(x1, z1, x0, z1, x0, z1 - inner, x1, z1 - inner);
      foamQuad(x1, z1 + 0.03, x0, z1 + 0.03, x0, z1 - 0.13, x1, z1 - 0.13);
    }
    if (land(cx - 1, cy)) {
      bankQuad(x0, z1, x0, z0, x0 + inner, z0, x0 + inner, z1);
      foamQuad(x0 - 0.03, z1, x0 - 0.03, z0, x0 + 0.13, z0, x0 + 0.13, z1);
    }
    if (land(cx + 1, cy)) {
      bankQuad(x1, z0, x1, z1, x1 - inner, z1, x1 - inner, z0);
      foamQuad(x1 + 0.03, z0, x1 + 0.03, z1, x1 - 0.13, z1, x1 - 0.13, z0);
    }
  }

  if (bankPos.length) {
    const bankGeo = new THREE.BufferGeometry();
    bankGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bankPos), 3));
    bankGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(bankCol), 3));
    bankGeo.computeVertexNormals();
    const bankMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.40,
      depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    const bank = new THREE.Mesh(bankGeo, bankMat);
    bank.renderOrder = 3;
    gl.env.add(bank);
    gl.bank = bank;
  }

  if (foamPos.length) {
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(foamPos), 3));
    fgeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(foamUV), 2));
    const isz = foamPos.length / 3 > 65535 ? Uint32Array : Uint16Array;
    fgeo.setIndex(new THREE.BufferAttribute(new isz(foamIdx), 1));
    fgeo.computeVertexNormals();
    const fmat = new THREE.MeshBasicMaterial({
      color: 0xbcd8e6, transparent: true, opacity: 0.16,
      depthWrite: false, side: THREE.DoubleSide,
    });
    if (gl.foamTex) {
      fmat.map = gl.foamTex;
      fmat.color.setHex(0xffffff);
    }
    gl.foamMat = fmat;
    if (!gl.foamTexTried) {
      gl.foamTexTried = true;
      try {
        new THREE.TextureLoader().load(
          '/artwork/terrain/mca-assets-v2/tiles/decal_foam.png',
          (tex) => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.encoding = THREE.LinearEncoding;
            gl.foamTex = tex;
            fmat.map = tex;
            fmat.color.setHex(0xffffff);
            fmat.needsUpdate = true;
          },
          undefined,
          () => { /* local decal absent (single-file): plain strip remains */ },
        );
      } catch (e) { /* texture is decorative */ }
    }
    const foam = new THREE.Mesh(fgeo, fmat);
    foam.renderOrder = 4;
    gl.env.add(foam);
    gl.foam = foam;
  }
}

function buildScatter(gl) {
  const st = gl.state;
  const map = st.map;
  gl.scatterGroups = [];
  // Keep spawn / base neighborhoods clear.
  const clear = [];
  for (const sp of (map.spawns || [])) {
    clear.push({ x: sp.x, y: sp.y, r: 12 });
  }
  const free = (cx, cy) => {
    for (const c of clear) {
      const dx = cx - c.x, dy = cy - c.y;
      if (dx * dx + dy * dy < c.r * c.r) return false;
    }
    return true;
  };

  const rocks = [];
  const shrubs = [];
  const dunes = [];
  let guard = 0;
  while (rocks.length < 230 && guard++ < 9000) {
    const cx = 2 + Math.floor(hash01(guard, 5, 1) * (map.w - 4));
    const cy = 2 + Math.floor(hash01(guard, 9, 2) * (map.h - 4));
    const t = map.terrain[cy * map.w + cx];
    if (t !== 0 && t !== 1) continue;
    if (!free(cx, cy)) continue;
    const h = hash01(guard, 13, 3);
    const p = unitWorldFromCell(gl, cx, cy);
    if (h < 0.48) {
      rocks.push({
        x: p.x, z: p.z, s: 0.18 + h * 1.25, y: cellHeight(gl, cx, cy),
        rot: h * 7, stretch: 0.55 + hash01(guard, 14, 4) * 1.0, cx, cy,
      });
    } else {
      shrubs.push({ x: p.x, z: p.z, s: 0.55 + h * 0.75, y: cellHeight(gl, cx, cy), cx, cy });
    }
  }

  // Angular outcrops and a few low stone ridges (real shadows from the sun).
  for (let c = 0; c < 14; c++) {
    const cx = 3 + Math.floor(hash01(c, 31, 1) * (map.w - 6));
    const cy = 3 + Math.floor(hash01(c, 37, 2) * (map.h - 6));
    if (!free(cx, cy)) continue;
    const t = map.terrain[cy * map.w + cx];
    if (t === 2) continue;
    const p = unitWorldFromCell(gl, cx, cy);
    const n = 2 + (c % 4);
    for (let j = 0; j < n; j++) {
      const a = hash01(c, j, 41) * 6.28;
      const r = Math.max(0.5, hash01(c, j, 43) * 2.2);
      rocks.push({
        x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r,
        s: 0.55 + hash01(c, j, 47) * 1.05,
        y: cellHeight(gl, cx, cy) + 0.02,
        rot: hash01(c, j, 53) * 7,
        stretch: 0.6 + hash01(c, j, 59) * 0.7, cx, cy,
      });
    }
  }
  for (let c = 0; c < 8; c++) {
    const cx = 4 + Math.floor(hash01(c + 90, 11, 1) * (map.w - 8));
    const cy = 4 + Math.floor(hash01(c + 90, 17, 2) * (map.h - 8));
    if (!free(cx, cy)) continue;
    const p = unitWorldFromCell(gl, cx, cy);
    const ang = hash01(c + 90, 19, 3) * 6.28;
    const len = 3 + Math.floor(hash01(c + 90, 23, 4) * 5);
    for (let j = 0; j < len; j++) {
      rocks.push({
        x: p.x + Math.cos(ang) * j * 1.0 + (hash01(c, j, 71) - 0.5) * 0.5,
        z: p.z + Math.sin(ang) * j * 1.0 + (hash01(c, j, 73) - 0.5) * 0.5,
        s: 0.45 + hash01(c, j, 77) * 0.55,
        y: cellHeight(gl, cx, cy) + 0.02,
        rot: ang + hash01(c, j, 79),
        stretch: 0.6 + hash01(c, j, 83) * 0.4, cx, cy,
      });
    }
  }

  // Dune ridges: one instanced low-poly crest mesh with vertex-shaded slopes.
  for (let c = 0; c < 34; c++) {
    const cx = 3 + Math.floor(hash01(c + 200, 7, 1) * (map.w - 6));
    const cy = 3 + Math.floor(hash01(c + 200, 11, 2) * (map.h - 6));
    if (!free(cx, cy)) continue;
    if (map.terrain[cy * map.w + cx] !== 0) continue;
    const p = unitWorldFromCell(gl, cx, cy);
    dunes.push({
      x: p.x, z: p.z, y: cellHeight(gl, cx, cy),
      len: 5 + hash01(c, 13, 3) * 12,
      wid: 1.6 + hash01(c, 17, 4) * 3.2,
      h: 0.35 + hash01(c, 19, 5) * 0.7,
      rot: hash01(c, 23, 6) * 6.28, cx, cy,
    });
  }

  if (rocks.length) {
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const m = material(gl, 0x7a756a, { rough: 0.95, flat: true });
    const im = new THREE.InstancedMesh(geo, m, rocks.length);
    const o = new THREE.Object3D();
    rocks.forEach((r, i) => {
      o.position.set(r.x, r.y + r.s * r.stretch * 0.35, r.z);
      o.rotation.set((r.rot || 0) * 0.6, r.rot || 0, (r.rot || 0) * 0.3);
      o.scale.set(r.s, r.s * (r.stretch || 0.8), r.s * (0.8 + (i % 3) * 0.15));
      o.updateMatrix();
      im.setMatrixAt(i, o.matrix);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    im.instanceMatrix.needsUpdate = true;
    gl.env.add(im);
    recordScatter(gl, im, rocks.map((r) => [r.cx, r.cy]));
  }
  if (shrubs.length) {
    const geo = new THREE.ConeGeometry(0.20, 0.55, 5);
    const m = material(gl, 0x565f3c, { rough: 1, flat: true });
    const im = new THREE.InstancedMesh(geo, m, shrubs.length * 2);
    const o = new THREE.Object3D();
    const cells = [];
    let n = 0;
    shrubs.forEach((r, i) => {
      for (let j = 0; j < 2; j++) {
        const off = (j === 0 ? -0.22 : 0.28) * r.s;
        o.position.set(r.x + off, r.y + r.s * (0.15 + j * 0.08), r.z - off * 0.4);
        o.rotation.set(0, hash01(i, j, 5) * 6, 0);
        const sc = r.s * (j === 0 ? 1 : 0.72);
        o.scale.set(sc, sc, sc);
        o.updateMatrix();
        im.setMatrixAt(n++, o.matrix);
        cells.push([r.cx, r.cy]);
      }
    });
    im.castShadow = false;
    im.instanceMatrix.needsUpdate = true;
    gl.env.add(im);
    recordScatter(gl, im, cells);
  }
  if (dunes.length) {
    const ridge = makeDuneRidgeGeo();
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.98, metalness: 0,
      flatShading: true, side: THREE.DoubleSide,
    });
    const im = new THREE.InstancedMesh(ridge, m, dunes.length);
    const o = new THREE.Object3D();
    dunes.forEach((d, i) => {
      o.position.set(d.x, d.y - 0.02, d.z);
      o.rotation.set(0, d.rot, 0);
      o.scale.set(d.len, d.h, d.wid);
      o.updateMatrix();
      im.setMatrixAt(i, o.matrix);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    im.instanceMatrix.needsUpdate = true;
    gl.env.add(im);
    recordScatter(gl, im, dunes.map((d) => [d.cx, d.cy]));
  }
}

function recordScatter(gl, mesh, cells) {
  if (!mesh.setColorAt) return;
  gl.scatterGroups.push({ mesh, cells });
  const white = new THREE.Color(1, 1, 1);
  for (let i = 0; i < cells.length; i++) mesh.setColorAt(i, white);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function updateScatterFog(gl) {
  const st = gl.state;
  const fog = st.fog && st.fog[gl.localSlot || 0];
  if (!fog || !gl.scatterGroups) return;
  const w = st.map.w;
  const c = new THREE.Color();
  for (const group of gl.scatterGroups) {
    const mesh = group.mesh;
    if (!mesh.setColorAt) continue;
    for (let i = 0; i < group.cells.length; i++) {
      const cell = group.cells[i];
      if (!cell) continue;
      const idx = cell[1] * w + cell[0];
      const f = fog.visible[idx] ? 1 : fog.seen[idx] ? 0.42 : 0.12;
      c.setRGB(f, f, f);
      mesh.setColorAt(i, c);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

// Low-poly dune ridge: two shaded slopes meeting at a crest, open ends.
// Vertex colours make the crest catch light and the lee slope drop off.
function makeDuneRidgeGeo() {
  const pos = [];
  const col = [];
  const sandDark = new THREE.Color(0x9a8556);
  const sandPale = new THREE.Color(0xd9c389);
  const add = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const pts = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
    for (const p of pts) {
      pos.push(p[0], p[1], p[2]);
      const t = clamp(p[1], 0, 1);
      const c = sandDark.clone().lerp(sandPale, 0.25 + t * 0.7);
      col.push(c.r, c.g, c.b);
    }
  };
  // north slope (+Y up, crest along X at z=0)
  add(-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0);
  add(-0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0);
  // south slope
  add(-0.5, 1, 0, 0.5, 1, 0, 0.5, 0, 0.5);
  add(-0.5, 1, 0, 0.5, 0, 0.5, -0.5, 0, 0.5);
  // ends
  add(-0.5, 0, -0.5, -0.5, 1, 0, -0.5, 0, 0.5);
  add(0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// environment: terrain, shore, scatter, fog overlay
// ---------------------------------------------------------------------------

function buildEnvironment(gl) {
  buildTerrain(gl);
  buildWater(gl);
  buildScatter(gl);
  buildFog(gl);
}

function buildFog(gl) {
  const map = gl.state.map;
  const PAD = 48;
  const gw = map.w + PAD * 2;
  const gh = map.h + PAD * 2;
  const cv = document.createElement('canvas');
  cv.width = gw;
  cv.height = gh;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(gw, gh);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  gl.fogCanvas = cv;
  gl.fogCtx = ctx;
  gl.fogImg = img;
  gl.fogTex = tex;
  gl.fogWidth = gw;
  gl.fogHeight = gh;
  gl.fogPad = PAD;

  const fogMat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    fog: false, side: THREE.DoubleSide,
  });
  // Same geometry as the terrain: UVs already span the padded area.
  const tFog = new THREE.Mesh(gl.terrain.geometry, fogMat);
  tFog.renderOrder = 6;
  tFog.receiveShadow = false;
  tFog.castShadow = false;
  gl.env.add(tFog);
  gl.terrainFog = tFog;

  // Water fog: a cell-quad layer just above the water surface, UV-mapped
  // into the same per-cell fog texture.
  if (gl.waterCells && gl.waterCells.length) {
    const cells = gl.waterCells;
    const n = cells.length / 2;
    const pos = new Float32Array(n * 4 * 3);
    const uv = new Float32Array(n * 4 * 2);
    const isz = n * 4 > 65535 ? Uint32Array : Uint16Array;
    const idx = new isz(n * 6);
    let vp = 0, up = 0, ip = 0;
    for (let k = 0; k < n; k++) {
      const cx = cells[k * 2], cy = cells[k * 2 + 1];
      const x0 = (cx - map.w / 2) * S, x1 = x0 + S;
      const z0 = (cy - map.h / 2) * S, z1 = z0 + S;
      const u0 = (cx + PAD) / gw, u1 = (cx + PAD + 1) / gw;
      const v0 = (cy + PAD) / gh, v1 = (cy + PAD + 1) / gh;
      const base = k * 4;
      const corners = [
        [x0, z0, u0, v0], [x1, z0, u1, v0], [x1, z1, u1, v1], [x0, z1, u0, v1],
      ];
      for (const c of corners) {
        pos[vp++] = c[0]; pos[vp++] = WATER_Y + 0.10; pos[vp++] = c[1];
        uv[up++] = c[2]; uv[up++] = c[3];
      }
      idx[ip++] = base; idx[ip++] = base + 2; idx[ip++] = base + 1;
      idx[ip++] = base; idx[ip++] = base + 3; idx[ip++] = base + 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, fog: false,
    });
    const waterFog = new THREE.Mesh(g, m);
    waterFog.renderOrder = 7;
    gl.env.add(waterFog);
    gl.waterFog = waterFog;
  }
}

function updateFogTexture(gl) {
  const st = gl.state;
  const slot = gl.game.playerSlot || 0;
  gl.localSlot = slot;
  if (gl.revealTerrain) {
    gl.fogTick = st.tick;
    gl.fogSlot = slot;
    if (gl.terrainFog) gl.terrainFog.visible = false;
    if (gl.waterFog) gl.waterFog.visible = false;
    if (gl.foam) gl.foam.visible = false;
    const c = new THREE.Color(1, 1, 1);
    for (const group of (gl.scatterGroups || [])) {
      if (!group.mesh.setColorAt) continue;
      for (let i = 0; i < group.cells.length; i++) group.mesh.setColorAt(i, c);
      if (group.mesh.instanceColor) group.mesh.instanceColor.needsUpdate = true;
    }
    return;
  }
  if (gl.terrainFog) gl.terrainFog.visible = true;
  if (gl.waterFog) gl.waterFog.visible = true;
  if (gl.foam) gl.foam.visible = true;
  const fog = st.fog && st.fog[slot];
  if (!fog) return;
  if (gl.fogTick === st.tick && gl.fogSlot === slot) return;
  gl.fogTick = st.tick;
  gl.fogSlot = slot;
  const w = gl.mapW, h = gl.mapH;
  const PAD = gl.fogPad || 48;
  const gw = gl.fogWidth, gh = gl.fogHeight;
  const data = gl.fogImg.data;
  data.fill(0);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const i = cy * w + cx;
      const a = fog.visible[i] ? 0 : fog.seen[i] ? 88 : 195;
      if (a === 0) continue;
      const px = cx + PAD, py = cy + PAD;
      if (px < 0 || py < 0 || px >= gw || py >= gh) continue;
      const o = (py * gw + px) * 4;
      data[o] = 4;
      data[o + 1] = 6;
      data[o + 2] = 10;
      data[o + 3] = a;
    }
  }
  gl.fogCtx.putImageData(gl.fogImg, 0, 0);
  gl.fogTex.needsUpdate = true;
  updateScatterFog(gl);
}

// The minimap reads game.render.fog (built for the 2D renderer). In 3D we
// still update it from the same sim fog arrays so the minimap does not leak.
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
// selection rings + placement ghost
// ---------------------------------------------------------------------------

function buildSelectionGroup(gl) {
  gl.selGroup = new THREE.Group();
  gl.scene.add(gl.selGroup);
  gl.selMat = new THREE.MeshBasicMaterial({
    color: 0xf0d07a, transparent: true, opacity: 0.88,
    depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const geo = new THREE.RingGeometry(0.72, 1.0, 28);
  geo.rotateX(-Math.PI / 2);
  gl.selRings = [];
  for (let i = 0; i < 64; i++) {
    const m = new THREE.Mesh(geo, gl.selMat);
    m.visible = false;
    m.renderOrder = 8;
    gl.selGroup.add(m);
    gl.selRings.push(m);
  }
}

function updateSelection(gl) {
  const game = gl.game;
  const st = gl.state;
  for (const r of gl.selRings) r.visible = false;
  const sel = (game.selection || []).slice(0, gl.selRings.length);
  let ri = 0;
  for (const id of sel) {
    const ent = st.units[id] || st.structures[id];
    if (!ent) continue;
    const rec = gl.units.get(id) || gl.structs.get(id);
    if (!rec || !rec.root.visible) continue;
    const ring = gl.selRings[ri++];
    if (!ring) break;
    let radius = 1.3;
    let py;
    if (ent.cx !== undefined) {
      const def = st.structDefs[ent.defId];
      radius = Math.max(1.4, ent.fp * S * 0.55);
      py = rec.root.position.y + 0.08;
      void def;
    } else {
      const def = st.unitDefs[ent.defId];
      if (def.domain === 'Air') continue; // no ground ring under aircraft
      if (def.domain === 'Sea') radius = 2.1;
      else if (isInfantryCls(def.cls)) radius = 0.75;
      else radius = 1.45;
      py = heightAtWu(gl, ent.x, ent.y) + 0.09;
    }
    ring.visible = true;
    ring.position.set(rec.root.position.x, py, rec.root.position.z);
    ring.scale.setScalar(radius);
  }
}

function buildGhost(gl) {
  const g = new THREE.Group();
  gl.ghostGroup = g;
  gl.ghostMat = new THREE.MeshBasicMaterial({
    color: 0x6fe08a, transparent: true, opacity: 0.18,
    depthWrite: false, side: THREE.DoubleSide,
  });
  gl.ghostLineMat = new THREE.LineBasicMaterial({
    color: 0x9dffb6, transparent: true, opacity: 0.9,
  });
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const fill = new THREE.Mesh(boxGeo, gl.ghostMat);
  fill.position.y = 0.6;
  g.add(fill);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), gl.ghostLineMat);
  edges.position.y = 0.6;
  g.add(edges);
  const padGeo = new THREE.PlaneGeometry(1, 1);
  padGeo.rotateX(-Math.PI / 2);
  const pad = new THREE.Mesh(padGeo, gl.ghostMat);
  pad.position.y = 0.05;
  g.add(pad);
  g.visible = false;
  gl.scene.add(g);
}

function updateGhost(gl) {
  const game = gl.game;
  const st = gl.state;
  const g = gl.ghostGroup;
  if (!g) return;
  if (!game.placement || !game.mouse || !game.mouse.inside || !st
    || game.overlay || game.paused || (game.cinema && game.cinema.active)) {
    g.visible = false;
    return;
  }
  const def = st.structDefs[game.placement.structId];
  if (!def) { g.visible = false; return; }
  const w = screenToWorldInternal(gl, game.mouse.sx, game.mouse.sy);
  if (!w) { g.visible = false; return; }
  const cx = Math.floor(w.x / CELL) - (def.fp >> 1);
  const cy = Math.floor(w.y / CELL) - (def.fp >> 1);
  const reason = canPlaceReason(st, game.playerSlot || 0, def, cx, cy);
  const ok = !reason;
  const wx = cellToX(gl, cx + def.fp / 2);
  const wz = cellToZ(gl, cy + def.fp / 2);
  g.visible = true;
  g.position.set(wx, heightAtWu(gl, (cx + def.fp / 2) * CELL, (cy + def.fp / 2) * CELL), wz);
  const sx = def.fp * S * 0.92;
  g.scale.set(sx, ok ? 1.2 : 0.75, sx);
  gl.ghostMat.color.setHex(ok ? 0x6fe08a : 0xd9564a);
  gl.ghostMat.opacity = ok ? 0.18 : 0.24;
  gl.ghostLineMat.color.setHex(ok ? 0x9dffb6 : 0xff8a7a);
}

// ---------------------------------------------------------------------------
// camera proxy: HUD/minimap keep using game.camera in 3D
// ---------------------------------------------------------------------------

function applyCameraProxy(gl) {
  const cam = gl.game.camera;
  if (!cam || !cam.viewW) return;
  if (!gl.proxy.ready) {
    gl.proxy.ready = true;
    gl.proxy.x = cam.x;
    gl.proxy.y = cam.y;
    gl.proxy.zoom = cam.zoom;
    return;
  }
  if (Math.abs(cam.zoom - gl.proxy.zoom) > 0.006) {
    gl.dist = clamp(50 / Math.max(0.05, cam.zoom), 6, 340);
    gl.proxy.zoom = cam.zoom;
    updateCamera(gl);
  }
  if (gl.proxy.x !== null
    && (Math.abs(cam.x - gl.proxy.x) > 0.75 || Math.abs(cam.y - gl.proxy.y) > 0.75)) {
    const wx = cam.x + cam.viewW / (2 * cam.zoom);
    const wy = cam.y + cam.viewH / (2 * cam.zoom);
    gl.focus.x = (wx / CELL - gl.mapW / 2) * S;
    gl.focus.z = (wy / CELL - gl.mapH / 2) * S;
    updateCamera(gl);
  }
}

function writeCameraProxy(gl) {
  const cam = gl.game.camera;
  if (!cam || !cam.viewW) return;
  const vfov = gl.camera.fov * Math.PI / 180;
  const renderH = 2 * gl.dist * Math.tan(vfov / 2);
  const renderW = renderH * gl.camera.aspect;
  const zoom = clamp(cam.viewW / Math.max(1, renderW * (CELL / S)), 0.16, 2.5);
  const fx = (gl.focus.x / S + gl.mapW / 2) * CELL;
  const fz = (gl.focus.z / S + gl.mapH / 2) * CELL;
  cam.zoom = zoom;
  cam.x = fx - cam.viewW / (2 * zoom);
  cam.y = fz - cam.viewH / (2 * zoom);
  gl.proxy.x = cam.x;
  gl.proxy.y = cam.y;
  gl.proxy.zoom = cam.zoom;
}

// ---------------------------------------------------------------------------
// public camera / picking helpers
// ---------------------------------------------------------------------------

export function setGlVisible(game, on) {
  const gl = game && game.gl;
  if (!gl) return;
  gl.canvas.style.display = on ? 'block' : 'none';
  if (game.canvas && game.canvas !== gl.canvas) {
    game.canvas.style.visibility = on ? 'hidden' : 'visible';
  }
  if (on) resizeGl(gl);
}

// Screen px -> sim world units via a ray onto y=0. Used by input.js picking,
// orders, rally, placement and by the probe.
export function glScreenToWorld(game, sx, sy) {
  const gl = game && game.gl;
  if (!gl) return { x: 0, y: 0 };
  const w = screenToWorldInternal(gl, sx, sy);
  return w ? { x: w.x, y: w.y } : { x: 0, y: 0 };
}

// Sim world units -> CSS screen px via camera.project. Returns null behind
// the camera. Used for 3D box-select and drag-move lines.
export function glWorldToScreen(game, wx, wy, height) {
  const gl = game && game.gl;
  if (!gl) return null;
  const cam = gl.camera;
  const v = new THREE.Vector3(
    (wx / CELL - gl.mapW / 2) * S,
    height === undefined ? 0.6 : height,
    (wy / CELL - gl.mapH / 2) * S,
  );
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  const rel = v.clone().sub(cam.position);
  if (rel.dot(dir) <= 0) return null;
  v.project(cam);
  if (v.z < -1 || v.z > 1) return null;
  const cw = gl.canvas.clientWidth || gl.canvas.width || 1;
  const ch = gl.canvas.clientHeight || gl.canvas.height || 1;
  return { x: (v.x * 0.5 + 0.5) * cw, y: (-v.y * 0.5 + 0.5) * ch };
}

export function panGlBy(game, dxPx, dyPx) {
  const gl = game && game.gl;
  if (!gl) return;
  const h = gl.canvas.clientHeight || 1;
  const wpp = 2 * gl.dist * Math.tan(gl.camera.fov * Math.PI / 360) / h;
  const rx = Math.cos(gl.yaw), rz = -Math.sin(gl.yaw);
  const fx = -Math.sin(gl.yaw), fz = -Math.cos(gl.yaw);
  gl.focus.x += (rx * dxPx - fx * dyPx) * wpp;
  gl.focus.z += (rz * dxPx - fz * dyPx) * wpp;
  updateCamera(gl);
}

export function zoomGlBy(game, factor) {
  const gl = game && game.gl;
  if (!gl) return;
  gl.dist = clamp(gl.dist / factor, 6, 340);
  updateCamera(gl);
}

// Intro cinematics light the whole terrain (no fog overlay) while enemy
// entities stay hidden by the normal fog checks in syncUnits/syncStructures.
// This is terrain-only reveal, never a position leak.
export function setCinematicReveal(game, on) {
  const gl = game && game.gl;
  if (!gl) return;
  gl.revealTerrain = !!on;
  gl.fogTick = -1;
  if (gl.terrainFog) gl.terrainFog.visible = !on;
  if (gl.waterFog) gl.waterFog.visible = !on;
  // The foam decal tiles per shoreline cell and reads as polka dots from the
  // intro's high camera; keep the clean bank gradient for the flyover.
  if (gl.foam) gl.foam.visible = !on;
}

function screenToWorldInternal(gl, sx, sy) {
  const cam = gl.camera;
  if (!cam) return null;
  cam.updateMatrixWorld();
  const cw = gl.canvas.clientWidth || gl.canvas.width || 1;
  const ch = gl.canvas.clientHeight || gl.canvas.height || 1;
  const ndc = new THREE.Vector2((sx / cw) * 2 - 1, -(sy / ch) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, cam);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(plane, hit)) return null;
  return {
    x: (hit.x / S + gl.mapW / 2) * CELL,
    y: (hit.z / S + gl.mapH / 2) * CELL,
    wx: hit.x,
    wz: hit.z,
  };
}

function rebuildEnvironment(gl) {
  if (!gl.env) return;
  gl.env.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
  gl.scene.remove(gl.env);
  gl.env = new THREE.Group();
  gl.scene.add(gl.env);
  gl.fogTick = -1;
  gl.fogSlot = -1;
  buildEnvironment(gl);
}



function unitWorldFromCell(gl, cx, cy) {
  return { x: cellToX(gl, cx + 0.5), z: cellToZ(gl, cy + 0.5) };
}

// ---------------------------------------------------------------------------
// camera / controls
// ---------------------------------------------------------------------------

function updateCamera(gl) {
  const cp = Math.cos(gl.pitch);
  const d = gl.dist;
  gl.focus.x = clamp(gl.focus.x, -gl.halfX - 20, gl.halfX + 20);
  gl.focus.z = clamp(gl.focus.z, -gl.halfZ - 20, gl.halfZ + 20);
  gl.focus.y = 0.4;
  gl.camera.position.set(
    gl.focus.x + Math.sin(gl.yaw) * cp * d,
    gl.focus.y + Math.sin(gl.pitch) * d,
    gl.focus.z + Math.cos(gl.yaw) * cp * d,
  );
  gl.camera.lookAt(gl.focus.x, gl.focus.y, gl.focus.z);
  if (gl.sun) {
    gl.sun.position.set(gl.focus.x + 72, gl.focus.y + 112, gl.focus.z + 46);
    gl.sun.target.position.set(gl.focus.x, gl.focus.y, gl.focus.z);
    gl.sun.target.updateMatrixWorld();
  }
}

function bindControls(gl) {
  const canvas = gl.canvas;
  const key = (e) => (e.key || '').toLowerCase();
  const panKeys = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
  const wasdKeys = ['w', 'a', 's', 'd'];

  globalThis.addEventListener('keydown', (e) => {
    const game = gl.game;
    if (game && (game.overlay || game.paused || game.chatOpen
      || (game.cinema && game.cinema.active))) return;
    const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select'
      || (e.target && e.target.isContentEditable)) return;
    const k = key(e);
    const isPan = panKeys.includes(k) || (gl.wasdPan && wasdKeys.includes(k));
    if (isPan || k === 'shift') {
      gl.keys.add(k);
      if (e.preventDefault) e.preventDefault();
    }
  });
  globalThis.addEventListener('keyup', (e) => gl.keys.delete(key(e)));

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 2) return;
    gl.dragging = true;
    gl.lastPointer.x = e.clientX;
    gl.lastPointer.y = e.clientY;
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    // Do NOT preventDefault here: it suppresses the compatibility mouse
    // down/up events input.js needs for the right-click order vs orbit drag.
    // The canvas contextmenu handler still stops the native menu.
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!gl.dragging) return;
    const dx = e.clientX - gl.lastPointer.x;
    const dy = e.clientY - gl.lastPointer.y;
    gl.lastPointer.x = e.clientX;
    gl.lastPointer.y = e.clientY;
    gl.yaw -= dx * 0.0055;
    gl.pitch = clamp(gl.pitch + dy * 0.0038, 0.20, 1.42);
    updateCamera(gl);
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
    const game = gl.game;
    if (game && (game.overlay || game.paused)) return;
    gl.dist = clamp(gl.dist * Math.exp(clamp(e.deltaY, -240, 240) * 0.00125), 6, 340);
    updateCamera(gl);
  }, { passive: false });
}

function updateControls(gl, dt) {
  const game = gl.game;
  if (game && (game.overlay || game.paused || (game.cinema && game.cinema.active))) {
    gl.keys.clear();
    return;
  }
  let fx = 0, fz = 0;
  const wasd = gl.wasdPan !== false;
  if ((wasd && gl.keys.has('w')) || gl.keys.has('arrowup')) { fx -= Math.sin(gl.yaw); fz -= Math.cos(gl.yaw); }
  if ((wasd && gl.keys.has('s')) || gl.keys.has('arrowdown')) { fx += Math.sin(gl.yaw); fz += Math.cos(gl.yaw); }
  if ((wasd && gl.keys.has('d')) || gl.keys.has('arrowright')) { fx += Math.cos(gl.yaw); fz -= Math.sin(gl.yaw); }
  if ((wasd && gl.keys.has('a')) || gl.keys.has('arrowleft')) { fx -= Math.cos(gl.yaw); fz += Math.sin(gl.yaw); }
  if (fx || fz) {
    const len = Math.hypot(fx, fz) || 1;
    const speed = 58 * dt * (gl.keys.has('shift') ? 2.2 : 1);
    gl.focus.x += fx / len * speed;
    gl.focus.z += fz / len * speed;
    updateCamera(gl);
  }
  // Screen-edge pan (integrated game only; the standalone preview has no
  // game.mouse and keeps its keyboard-only camera).
  if (game && game.mouse && game.mouse.inside && !game.midDrag
    && !game.overlay && !game.paused) {
    let ex = 0, ey = 0;
    const m = game.mouse;
    if (m.sx < 12) ex -= 1;
    if (m.sx > gl.canvas.clientWidth - 12) ex += 1;
    if (m.sy < 12) ey -= 1;
    if (m.sy > gl.canvas.clientHeight - 12) ey += 1;
    if (ex || ey) {
      panGlBy(gl.game, ex * 600 * dt, ey * 600 * dt);
    }
  }
  if (gl.sky) gl.sky.position.set(gl.focus.x, 0, gl.focus.z);
}

// ---------------------------------------------------------------------------
// unit models
// ---------------------------------------------------------------------------

function accentFor(gl, owner) {
  const st = gl.state;
  const p = st.players && st.players[owner];
  const f = p && st.data && st.data.factions ? st.data.factions[p.faction] : null;
  return (f && f.color) || '#c8a23a';
}

function bodyFor(gl, accent) {
  return mixHex(0x847b59, accent, 0.14);
}

function buildTank(gl, def, accent) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const cBody = bodyFor(gl, accent);
  const mBody = material(gl, cBody, { rough: 0.74, metal: 0.22 });
  const mDeck = material(gl, mixHex(cBody, 0x3d4038, 0.35), { rough: 0.8, metal: 0.15 });
  const mTrack = material(gl, 0x1e201d, { rough: 0.96 });
  const mSteel = material(gl, 0x62645d, { rough: 0.42, metal: 0.62 });
  const mRubber = material(gl, 0x2a2b27, { rough: 0.95 });
  const mAccent = material(gl, accent, { rough: 0.5, metal: 0.2 });
  const mGlass = material(gl, 0x334b50, { rough: 0.15, metal: 0.7 });

  // Hull: extruded side profile gives a real angled glacis, not a cube.
  const sh = new THREE.Shape();
  sh.moveTo(-1.06, 0.10);
  sh.lineTo(1.02, 0.10);
  sh.lineTo(1.20, 0.24);
  sh.lineTo(0.60, 0.53);
  sh.lineTo(-1.16, 0.53);
  sh.lineTo(-1.16, 0.34);
  sh.closePath();
  const hullGeo = new THREE.ExtrudeGeometry(sh, {
    depth: 1.02, bevelEnabled: false, steps: 1,
  });
  hullGeo.translate(0, 0, -0.51);
  hullGeo.computeVertexNormals();
  addMesh(body, hullGeo, mBody, 0, 0, 0, { cast: true, receive: true });

  // Deck plate / engine deck.
  box(body, 1.42, 0.07, 0.86, mDeck, -0.25, 0.545, 0, { cast: true });
  box(body, 0.44, 0.06, 0.88, mBody, -0.98, 0.50, 0);
  for (let i = 0; i < 4; i++) {
    box(body, 0.05, 0.025, 0.64, mSteel, -1.02 + i * 0.1, 0.565, 0);
  }

  // Tracks + 7 road wheels per side + drive sprockets.
  const wheelGeo = new THREE.CylinderGeometry(0.155, 0.155, 0.075, 14);
  const hubGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.095, 10);
  for (const side of [-1, 1]) {
    box(body, 2.30, 0.34, 0.24, mTrack, 0, 0.255, side * 0.54, { cast: true });
    cyl(body, 0.175, 0.175, 0.24, mTrack, -1.16, 0.255, side * 0.54, { rx: Math.PI / 2, seg: 12 });
    cyl(body, 0.175, 0.175, 0.24, mTrack, 1.16, 0.255, side * 0.54, { rx: Math.PI / 2, seg: 12 });
    for (let k = 0; k < 7; k++) {
      const x = -0.96 + k * 0.32;
      addMesh(body, wheelGeo, mRubber, x, 0.205, side * 0.675);
      addMesh(body, hubGeo, mSteel, x, 0.205, side * 0.695);
    }
    // side skirt segments above the wheels, leaving the running gear visible
    box(body, 0.72, 0.20, 0.05, mBody, 0.72, 0.50, side * 0.70, { cast: true });
    box(body, 0.58, 0.20, 0.05, mBody, -0.42, 0.50, side * 0.70, { cast: true });
  }

  // Turret.
  const turret = new THREE.Group();
  turret.position.set(-0.06, 0.60, 0);
  body.add(turret);
  const tg = bevelBoxGeo(0.98, 0.82, 0.28, 0.055);
  addMesh(turret, tg, mBody, 0, 0, 0, { cast: true, receive: true });
  box(turret, 0.68, 0.10, 0.66, mDeck, -0.06, 0.32, 0);
  // Rotating cupola + hatch.
  cyl(turret, 0.16, 0.16, 0.10, mSteel, -0.26, 0.40, -0.16, { seg: 12, cast: true });
  cyl(turret, 0.10, 0.10, 0.05, mBody, -0.26, 0.47, -0.16, { seg: 10 });

  const barrelPivot = new THREE.Group();
  barrelPivot.position.set(0.30, 0.16, 0);
  turret.add(barrelPivot);
  // Mantlet.
  box(barrelPivot, 0.26, 0.26, 0.44, mBody, 0.02, 0, 0, { cast: true });
  const barrelGeo = new THREE.CylinderGeometry(0.058, 0.072, 1.16, 12);
  barrelGeo.rotateZ(-Math.PI / 2);
  addMesh(barrelPivot, barrelGeo, mSteel, 0.71, 0, 0, { cast: true });
  const sleeveGeo = new THREE.CylinderGeometry(0.085, 0.085, 0.32, 12);
  sleeveGeo.rotateZ(-Math.PI / 2);
  addMesh(barrelPivot, sleeveGeo, mSteel, 0.67, 0, 0);
  const brakeGeo = new THREE.CylinderGeometry(0.095, 0.095, 0.17, 12);
  brakeGeo.rotateZ(-Math.PI / 2);
  addMesh(barrelPivot, brakeGeo, mSteel, 1.33, 0, 0, { cast: true });
  box(barrelPivot, 0.20, 0.05, 0.19, mSteel, 1.33, 0, 0);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(1.44, 0, 0);
  barrelPivot.add(muzzle);

  // Coaxial MG + commander MG.
  box(turret, 0.32, 0.06, 0.06, mSteel, 0.08, 0.31, 0.20);
  const mgGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.34, 6);
  mgGeo.rotateZ(-Math.PI / 2);
  addMesh(turret, mgGeo, mSteel, 0.27, 0.36, 0.20);
  box(turret, 0.10, 0.08, 0.09, mSteel, -0.26, 0.44, 0.02);

  // Faction accents on both turret cheeks + rear plate.
  box(turret, 0.44, 0.065, 0.02, mAccent, -0.09, 0.06, 0.455);
  box(turret, 0.44, 0.065, 0.02, mAccent, -0.09, 0.06, -0.455);
  box(body, 0.30, 0.07, 0.02, mAccent, -1.05, 0.36, 0.52);

  // Headlights + vision blocks.
  box(body, 0.06, 0.09, 0.12, mGlass, 1.13, 0.37, 0.32);
  box(body, 0.06, 0.09, 0.12, mGlass, 1.13, 0.37, -0.32);
  box(turret, 0.02, 0.08, 0.50, mGlass, 0.22, 0.28, 0);
  // Antenna.
  cyl(body, 0.012, 0.018, 0.8, mRubber, -1.02, 0.95, -0.34, { seg: 5 });
  // Rear stowage boxes.
  box(body, 0.28, 0.22, 0.30, mDeck, -1.02, 0.68, 0.28);
  box(body, 0.28, 0.22, 0.30, mDeck, -1.02, 0.68, -0.28);

  return {
    root, body, turret, barrelPivot, muzzle,
    recoil: 0, aim: 0, hasTurret: true,
    kind: 'tank',
  };
}

// ---------------------------------------------------------------------------
// infantry squad
// ---------------------------------------------------------------------------

function isInfantryCls(cls) {
  return cls === 'Infantry' || cls === 'AT infantry' || cls === 'AA infantry'
    || cls === 'SF' || cls === 'Engineer';
}

function buildInfantry(gl, def, accent) {
  const root = new THREE.Group();
  const squad = new THREE.Group();
  root.add(squad);

  const cUniform = mixHex(0x6b6b4f, accent, 0.18);
  const mUniform = material(gl, cUniform, { rough: 0.9 });
  const mPants = material(gl, mixHex(cUniform, 0x33332a, 0.35), { rough: 0.95 });
  const mSkin = material(gl, 0xb08a63, { rough: 0.8 });
  const mHelmet = material(gl, mixHex(cUniform, 0x40413a, 0.5), { rough: 0.65, metal: 0.15 });
  const mAccent = material(gl, accent, { rough: 0.55 });
  const mRifle = material(gl, 0x252622, { rough: 0.55, metal: 0.45 });

  const offsets = [
    [0.0, 0.0, 0.0],
    [0.34, 0.26, 0.5],
    [-0.28, 0.24, -0.4],
    [0.08, -0.30, -0.9],
  ];
  const figures = [];

  offsets.forEach((off, idx) => {
    const fig = new THREE.Group();
    fig.position.set(off[0], 0, off[1]);
    fig.rotation.y = off[2];
    squad.add(fig);

    // Legs (pivot at the hip so they can swing).
    const legL = new THREE.Group();
    legL.position.set(0, 0.26, 0.065);
    fig.add(legL);
    cyl(legL, 0.042, 0.05, 0.23, mPants, 0, -0.115, 0, { seg: 6 });
    box(legL, 0.11, 0.055, 0.075, mRifle, 0.035, -0.235, 0);
    const legR = new THREE.Group();
    legR.position.set(0, 0.26, -0.065);
    fig.add(legR);
    cyl(legR, 0.042, 0.05, 0.23, mPants, 0, -0.115, 0, { seg: 6 });
    box(legR, 0.11, 0.055, 0.075, mRifle, 0.035, -0.235, 0);

    // Capsule-ish torso: cylinder + rounded ends.
    cyl(fig, 0.10, 0.115, 0.23, mUniform, 0, 0.365, 0, { seg: 8, cast: true });
    sphere(fig, 0.10, mUniform, 0, 0.48, 0, { seg: 8 });
    box(fig, 0.055, 0.10, 0.19, mAccent, 0.055, 0.41, 0, { cast: true });
    // Webbing.
    box(fig, 0.05, 0.17, 0.20, mPants, 0.015, 0.36, 0);

    // Arms + rifle.
    const armL = new THREE.Group();
    armL.position.set(0, 0.44, 0.115);
    fig.add(armL);
    cyl(armL, 0.032, 0.036, 0.20, mUniform, 0, -0.10, 0, { seg: 6, rz: 0.12 });
    const armR = new THREE.Group();
    armR.position.set(0, 0.44, -0.115);
    fig.add(armR);
    cyl(armR, 0.032, 0.036, 0.20, mUniform, 0, -0.10, 0, { seg: 6, rz: -0.35 });
    box(fig, 0.30, 0.045, 0.045, mRifle, 0.11, 0.33, 0.055, { ry: 0.1 });
    box(fig, 0.07, 0.08, 0.05, mRifle, 0.00, 0.33, 0.055);

    // Head + helmet.
    sphere(fig, 0.082, mSkin, 0.005, 0.575, 0, { seg: 8 });
    sphere(fig, 0.088, mHelmet, 0.0, 0.594, 0, { seg: 8, sy: 0.7 });

    figures.push({
      fig, legL, legR, armL, armR,
      phase: idx * 1.63 + 0.4,
      baseY: 0,
    });
  });

  return {
    root, body: squad, figures, kind: 'infantry',
    hasTurret: false, aim: 0,
  };
}

// ---------------------------------------------------------------------------
// attack helicopter
// ---------------------------------------------------------------------------

function buildHelo(gl, def, accent) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const cBody = mixHex(0x5f6754, accent, 0.13);
  const mBody = material(gl, cBody, { rough: 0.65, metal: 0.3 });
  const mDark = material(gl, 0x2b302c, { rough: 0.82, metal: 0.2 });
  const mSteel = material(gl, 0x585b55, { rough: 0.4, metal: 0.65 });
  const mGlass = material(gl, 0x324d52, { rough: 0.08, metal: 0.8, opacity: 0.9 });
  const mAccent = material(gl, accent, { rough: 0.5 });
  const mBlade = material(gl, 0x242620, { rough: 0.7, metal: 0.2, side: THREE.DoubleSide });

  // Fuselage + nose + tail boom.
  const fus = new THREE.CylinderGeometry(0.27, 0.31, 1.18, 12);
  fus.rotateZ(-Math.PI / 2);
  addMesh(body, fus, mBody, 0.05, 0.05, 0, { cast: true });
  sphere(body, 0.30, mBody, 0.64, 0.06, 0, { seg: 12, sx: 1.15, sy: 0.8, cast: true });
  cone(body, 0.30, 0.28, mBody, 0.90, 0.05, 0, { seg: 12, rz: -Math.PI / 2, cast: true });
  const boom = new THREE.CylinderGeometry(0.08, 0.14, 1.15, 8);
  boom.rotateZ(-Math.PI / 2);
  addMesh(body, boom, mBody, -1.05, 0.10, 0, { cast: true });
  cone(body, 0.10, 0.32, mDark, -1.62, 0.10, 0, { seg: 8, rz: Math.PI / 2 });

  // Canopy, nose sensor, chin gun.
  sphere(body, 0.22, mGlass, 0.55, 0.20, 0, { seg: 10, sx: 1.6, sy: 0.9, sz: 0.9, cast: true });
  sphere(body, 0.12, mDark, 0.86, -0.08, 0, { seg: 8 });
  const chin = new THREE.Group();
  chin.position.set(0.67, -0.17, 0);
  body.add(chin);
  cyl(chin, 0.12, 0.12, 0.10, mDark, 0, 0, 0, { seg: 8 });
  const gunGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.42, 6);
  gunGeo.rotateZ(-Math.PI / 2);
  addMesh(chin, gunGeo, mSteel, 0.20, 0, 0);

  // Stub wings + rocket pods.
  box(body, 0.55, 0.09, 1.45, mBody, 0.04, 0.02, 0, { cast: true });
  for (const side of [-1, 1]) {
    const podGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.46, 8);
    podGeo.rotateZ(-Math.PI / 2);
    addMesh(body, podGeo, mDark, 0.10, -0.03, side * 0.52, { cast: true });
    for (let k = 0; k < 3; k++) {
      const rg = new THREE.CylinderGeometry(0.022, 0.022, 0.03, 5);
      rg.rotateZ(-Math.PI / 2);
      addMesh(body, rg, mSteel, 0.35, -0.03, side * 0.52 + (k - 1) * 0.055);
    }
  }

  // Main rotor.
  const mast = cyl(body, 0.05, 0.07, 0.28, mSteel, -0.08, 0.36, 0, { seg: 8 });
  const rotor = new THREE.Group();
  rotor.position.set(-0.08, 0.51, 0);
  body.add(rotor);
  box(rotor, 2.55, 0.026, 0.085, mBlade, 0, 0, 0, { cast: true });
  box(rotor, 0.085, 0.026, 2.55, mBlade, 0, 0, 0, { cast: true });
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.28, 28),
    new THREE.MeshBasicMaterial({
      color: 0x2c2e28, transparent: true, opacity: 0.12,
      side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  disc.rotation.x = -Math.PI / 2;
  rotor.add(disc);

  // Tail rotor (vertical plane).
  const tailRotor = new THREE.Group();
  tailRotor.position.set(-1.58, 0.22, 0.09);
  body.add(tailRotor);
  box(tailRotor, 0.026, 0.52, 0.06, mBlade, 0, 0, 0, { cast: true });
  box(tailRotor, 0.026, 0.06, 0.52, mBlade, 0, 0, 0, { cast: true });
  box(body, 0.32, 0.36, 0.035, mBody, -1.55, 0.20, 0.04, { cast: true });

  // Skids + struts.
  for (const side of [-1, 1]) {
    const skidGeo = new THREE.CylinderGeometry(0.035, 0.035, 1.05, 6);
    skidGeo.rotateZ(-Math.PI / 2);
    addMesh(body, skidGeo, mSteel, 0.10, -0.39, side * 0.27, { cast: true });
    cyl(body, 0.025, 0.025, 0.32, mSteel, 0.38, -0.25, side * 0.25, { rz: 0.3, seg: 6 });
    cyl(body, 0.025, 0.025, 0.32, mSteel, -0.22, -0.25, side * 0.25, { rz: -0.3, seg: 6 });
    box(body, 1.00, 0.035, 0.035, mDark, 0.10, -0.20, side * 0.27);
  }

  // Faction stripe on the tail boom + engine housing.
  box(body, 0.26, 0.10, 0.02, mAccent, -0.95, 0.16, 0.13);
  box(body, 0.26, 0.10, 0.02, mAccent, -0.95, 0.16, -0.13);
  cyl(body, 0.18, 0.18, 0.38, mDark, -0.60, 0.24, 0, { seg: 8, rz: -Math.PI / 2 });
  box(body, 0.20, 0.12, 0.18, mSteel, -0.62, 0.26, 0.20);

  return {
    root, body, rotor, tailRotor, kind: 'helo',
    hasTurret: false, aim: 0,
  };
}

// ---------------------------------------------------------------------------
// jet
// ---------------------------------------------------------------------------

function buildJet(gl, def, accent) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const cBody = mixHex(0x7d8271, accent, 0.08);
  const mBody = material(gl, cBody, { rough: 0.48, metal: 0.5 });
  const mDark = material(gl, 0x30332f, { rough: 0.7, metal: 0.35 });
  const mSteel = material(gl, 0x70736c, { rough: 0.3, metal: 0.8 });
  const mGlass = material(gl, 0x2b4b56, { rough: 0.06, metal: 0.85, opacity: 0.92 });
  const mAccent = material(gl, accent, { rough: 0.45 });
  const mWing = material(gl, mixHex(cBody, 0x5e6255, 0.35), {
    rough: 0.55, metal: 0.4, side: THREE.DoubleSide,
  });

  const fus = new THREE.CylinderGeometry(0.16, 0.20, 2.25, 12);
  fus.rotateZ(-Math.PI / 2);
  addMesh(body, fus, mBody, 0.0, 0.02, 0, { cast: true });
  cone(body, 0.17, 0.70, mBody, 1.46, 0.02, 0, { seg: 12, rz: -Math.PI / 2, cast: true });
  const nozzle = new THREE.CylinderGeometry(0.15, 0.12, 0.42, 10);
  nozzle.rotateZ(-Math.PI / 2);
  addMesh(body, nozzle, mDark, -1.32, 0.02, 0, { cast: true });
  box(body, 0.12, 0.05, 0.05, mSteel, -1.15, 0.18, 0.16);
  box(body, 0.12, 0.05, 0.05, mSteel, -1.15, 0.18, -0.16);

  // Canopy.
  sphere(body, 0.20, mGlass, 0.52, 0.155, 0, {
    seg: 12, sx: 1.65, sy: 0.62, sz: 0.78, cast: true,
  });
  box(body, 0.30, 0.02, 0.12, mBody, 0.23, 0.20, 0);

  // Swept main wings from an extruded plan shape (thin, tapered, angled).
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0.56, 0.10);
  wingShape.lineTo(-0.16, 1.04);
  wingShape.lineTo(-0.58, 1.04);
  wingShape.lineTo(-0.62, 0.10);
  wingShape.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, {
    depth: 0.055, bevelEnabled: false, steps: 1,
  });
  wingGeo.rotateX(-Math.PI / 2);
  wingGeo.computeVertexNormals();
  const wingR = addMesh(body, wingGeo, mWing, 0, -0.02, 0, { cast: true });
  const wingL = new THREE.Mesh(wingGeo, mWing);
  wingL.position.set(0, -0.02, 0);
  wingL.scale.z = -1;
  wingL.castShadow = true;
  body.add(wingL);

  // Two tail fins (extruded diamonds, slightly canted).
  const finShape = new THREE.Shape();
  finShape.moveTo(-1.23, 0.0);
  finShape.lineTo(-0.54, 0.0);
  finShape.lineTo(-0.78, 0.62);
  finShape.lineTo(-1.12, 0.62);
  finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, {
    depth: 0.045, bevelEnabled: false, steps: 1,
  });
  for (const side of [-1, 1]) {
    const fin = addMesh(body, finGeo, mBody, 0, 0.10, side * 0.21, {
      rz: side * -0.08, cast: true,
    });
    if (side < 0) fin.scale.z = 1;
  }
  box(body, 0.38, 0.06, 0.56, mBody, -1.06, 0.14, 0, { cast: true });

  // Intakes under the wing roots.
  for (const side of [-1, 1]) {
    box(body, 0.72, 0.16, 0.18, mBody, 0.12, -0.11, side * 0.29, { cast: true });
    box(body, 0.05, 0.13, 0.15, mDark, 0.49, -0.11, side * 0.29);
  }

  // Faction stripe on the tail.
  box(body, 0.24, 0.11, 0.02, mAccent, -1.02, 0.30, 0.24);
  box(body, 0.24, 0.11, 0.02, mAccent, -1.02, 0.30, -0.24);

  // Fly-by-wire bumps / sensors.
  box(body, 0.26, 0.045, 0.10, mDark, 1.02, -0.03, 0);
  box(body, 0.18, 0.05, 0.30, mSteel, -0.55, 0.16, 0);

  return {
    root, body, wingL, wingR, kind: 'jet',
    hasTurret: false, aim: 0,
  };
}

// ---------------------------------------------------------------------------
// naval vessel
// ---------------------------------------------------------------------------

function buildShip(gl, def, accent) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  body.scale.setScalar(1.15);

  const mHull = material(gl, 0x5a6160, { rough: 0.62, metal: 0.32 });
  const mDeck = material(gl, 0x777a6d, { rough: 0.85 });
  const mDark = material(gl, 0x303633, { rough: 0.7, metal: 0.3 });
  const mSteel = material(gl, 0x858880, { rough: 0.35, metal: 0.7 });
  const mGlass = material(gl, 0x29444e, { rough: 0.1, metal: 0.8 });
  const mAccent = material(gl, accent, { rough: 0.5 });

  // Pointed hull: extruded plan shape (bow at +X).
  const hs = new THREE.Shape();
  hs.moveTo(-1.60, -0.46);
  hs.lineTo(1.08, -0.50);
  hs.lineTo(1.92, 0.0);
  hs.lineTo(1.08, 0.50);
  hs.lineTo(-1.60, 0.46);
  hs.closePath();
  const hullGeo = new THREE.ExtrudeGeometry(hs, {
    depth: 0.55, bevelEnabled: false, steps: 1,
  });
  hullGeo.rotateX(-Math.PI / 2);
  hullGeo.computeVertexNormals();
  addMesh(body, hullGeo, mHull, 0, -0.13, 0, { cast: true, receive: true });

  // Deck + bulwark rails.
  box(body, 3.10, 0.09, 0.86, mDeck, -0.20, 0.43, 0, { cast: true, receive: true });
  box(body, 0.70, 0.07, 0.62, mDeck, 1.22, 0.47, 0, { cast: true });
  for (const side of [-1, 1]) {
    box(body, 2.5, 0.05, 0.04, mSteel, -0.35, 0.51, side * 0.45);
  }

  // Superstructure + bridge windows.
  const ss = new THREE.Group();
  ss.position.set(-0.48, 0.0, 0);
  body.add(ss);
  box(ss, 1.05, 0.55, 0.76, mHull, 0, 0.74, 0, { cast: true });
  box(ss, 0.70, 0.30, 0.64, mHull, 0.02, 1.12, 0, { cast: true });
  box(ss, 0.62, 0.10, 0.66, mDark, 0.02, 1.31, 0);
  box(ss, 0.02, 0.10, 0.55, mGlass, 0.37, 1.13, 0);
  // Funnel with accent band.
  cyl(ss, 0.13, 0.17, 0.55, mDark, -0.30, 1.20, 0, { seg: 8, cast: true });
  cyl(ss, 0.135, 0.135, 0.10, mAccent, -0.30, 1.30, 0, { seg: 8 });
  // Radar mast + crossbar.
  cyl(ss, 0.022, 0.03, 0.78, mSteel, 0.10, 1.66, 0, { seg: 6 });
  box(ss, 0.42, 0.025, 0.025, mSteel, 0.10, 1.91, 0);
  sphere(ss, 0.055, mAccent, 0.10, 1.99, 0, { seg: 6 });

  // Two gun turrets.
  for (const gx of [0.75, -1.05]) {
    const g = new THREE.Group();
    g.position.set(gx, 0.48, 0);
    body.add(g);
    cyl(g, 0.20, 0.24, 0.20, mDeck, 0, 0.10, 0, { seg: 10, cast: true });
    box(g, 0.34, 0.20, 0.30, mHull, 0, 0.25, 0, { cast: true });
    const bg = new THREE.CylinderGeometry(0.025, 0.03, 0.58, 6);
    bg.rotateZ(-Math.PI / 2);
    addMesh(g, bg, mSteel, 0.32, 0.27, 0);
    addMesh(g, bg.clone(), mSteel, 0.32, 0.27, 0.09);
    addMesh(g, bg.clone(), mSteel, 0.32, 0.27, -0.09);
  }

  // Rear missile canisters.
  for (let i = 0; i < 3; i++) {
    const cg = new THREE.CylinderGeometry(0.055, 0.055, 0.60, 6);
    cg.rotateZ(-Math.PI / 2);
    addMesh(body, cg, mDark, -1.15 + i * 0.02, 0.62 + i * 0.10, -0.28, { rz: 0.28 });
  }
  // Life rafts / deck clutter.
  for (let i = 0; i < 3; i++) {
    box(body, 0.20, 0.10, 0.12, mDark, 0.25, 0.54, 0.31 - i * 0.04);
  }
  // Faction stripe on both bow flanks + stern.
  box(body, 0.55, 0.09, 0.02, mAccent, 0.30, 0.30, 0.50);
  box(body, 0.55, 0.09, 0.02, mAccent, 0.30, 0.30, -0.50);
  box(body, 0.02, 0.12, 0.50, mAccent, -1.61, 0.28, 0);

  return {
    root, body, kind: 'ship',
    hasTurret: false, aim: 0, bobPhase: (def.id.charCodeAt(0) % 17) * 0.4,
  };
}

// ---------------------------------------------------------------------------
// logistics / support vehicles
// ---------------------------------------------------------------------------

function buildTruck(gl, def, accent) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const cBody = bodyFor(gl, accent);
  const mBody = material(gl, cBody, { rough: 0.75, metal: 0.2 });
  const mDark = material(gl, 0x2a2c28, { rough: 0.9 });
  const mGlass = material(gl, 0x334b50, { rough: 0.2, metal: 0.6 });
  const mAccent = material(gl, accent, { rough: 0.55 });
  const mSteel = material(gl, 0x6a6c63, { rough: 0.45, metal: 0.55 });

  const wheelGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.14, 12);
  const mWheel = material(gl, 0x1f211e, { rough: 0.97 });
  for (const side of [-1, 1]) {
    for (const x of [-0.85, -0.28, 0.55]) {
      addMesh(body, wheelGeo, mWheel, x, 0.21, side * 0.49, { rx: Math.PI / 2 });
    }
  }
  box(body, 2.65, 0.10, 0.88, mDark, 0, 0.36, 0);
  box(body, 0.70, 0.48, 0.86, mBody, 0.78, 0.64, 0, { cast: true });
  box(body, 0.10, 0.26, 0.64, mGlass, 1.11, 0.72, 0);
  box(body, 1.30, 0.30, 0.88, mBody, -0.30, 0.55, 0);
  if (def.cls === 'Harvester') {
    box(body, 0.55, 0.48, 0.86, mBody, -1.20, 0.75, 0, { cast: true });
    box(body, 0.85, 0.10, 0.78, mSteel, -1.60, 0.42, 0, { rz: 0.25 });
    box(body, 0.20, 0.35, 0.82, mAccent, -0.98, 0.72, 0);
  } else {
    box(body, 1.60, 0.20, 0.84, mBody, -0.42, 0.76, 0, { cast: true });
    cyl(body, 0.09, 0.11, 1.4, mSteel, -0.55, 1.20, 0.22, { seg: 6 });
    box(body, 1.10, 0.09, 0.09, mSteel, -0.10, 1.86, 0.22);
    box(body, 0.25, 0.25, 0.30, mAccent, -0.55, 1.42, 0.22);
  }
  cyl(body, 0.05, 0.05, 0.30, mDark, 0.55, 0.58, 0.36, { seg: 6 });
  box(body, 0.45, 0.06, 0.02, mAccent, 0.40, 0.62, 0.455);

  return {
    root, body, kind: 'truck', hasTurret: false, aim: 0,
  };
}

// ---------------------------------------------------------------------------
// structures
// ---------------------------------------------------------------------------

function buildFlag(gl, parent, x, y, z, w, h, accent, phase) {
  const mPole = material(gl, 0x6d6a5c, { rough: 0.45, metal: 0.6 });
  const mFlag = material(gl, accent, {
    rough: 0.75, metal: 0.05, side: THREE.DoubleSide,
  });
  cyl(parent, 0.024, 0.035, h, mPole, x, y + h / 2, z, { seg: 6, cast: true });
  sphere(parent, 0.045, material(gl, accent, { rough: 0.4, metal: 0.5 }), x, y + h + 0.03, z, { seg: 6 });

  const geo = new THREE.PlaneGeometry(w, h * 0.22, 12, 4);
  const base = geo.attributes.position.array.slice();
  const flag = new THREE.Mesh(geo, mFlag);
  flag.position.set(x + w / 2 + 0.02, y + h - h * 0.14, z);
  flag.castShadow = true;
  parent.add(flag);

  const anim = (t) => {
    const pos = geo.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < arr.length; i += 3) {
      const bx = base[i];
      const bz = base[i + 2];
      const u = (bx + w / 2) / w;
      arr[i + 2] = bz + Math.sin(bx * 3.2 - t * 5.2 + phase) * 0.13 * u
        + Math.sin((bx + base[i + 1]) * 5.0 - t * 7.4 + phase) * 0.045 * u;
      arr[i + 1] = base[i + 1] + Math.cos(bx * 2.1 - t * 4.1 + phase) * 0.035 * u;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  };
  return { flag, anim };
}

function buildConyard(gl, def, accent) {
  const root = new THREE.Group();
  const size = def.fp * S;
  const concrete = material(gl, 0x9c927a, { rough: 0.9 });
  const concreteDark = material(gl, 0x6f695c, { rough: 0.88 });
  const mBody = material(gl, mixHex(0x8a8068, accent, 0.10), { rough: 0.72, metal: 0.18 });
  const mDark = material(gl, 0x3b3c36, { rough: 0.8 });
  const mSteel = material(gl, 0x6d6f66, { rough: 0.35, metal: 0.68 });
  const mGlass = material(gl, 0x2b4149, { rough: 0.15, metal: 0.65 });
  const mAccent = material(gl, accent, { rough: 0.5, metal: 0.2 });

  // Hexagonal apron + inner pad.
  const pad = cyl(root, size * 0.55, size * 0.60, 0.30, concrete, 0, 0.15, 0, {
    seg: 6, receive: true,
  });
  pad.rotation.y = Math.PI / 6;
  cyl(root, size * 0.42, size * 0.45, 0.16, concreteDark, 0, 0.36, 0, {
    seg: 6, receive: true,
  }).rotation.y = Math.PI / 6;
  // Spokes.
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    box(root, size * 0.46, 0.05, 0.22, concreteDark,
      Math.cos(a) * size * 0.25, 0.32, Math.sin(a) * size * 0.25,
      { ry: -a });
  }

  // Citadel.
  const citadel = new THREE.Group();
  citadel.position.set(-0.55, 0.34, -0.25);
  root.add(citadel);
  addMesh(citadel, bevelBoxGeo(3.5, 3.1, 2.35, 0.10), mBody, 0, 0, 0, {
    cast: true, receive: true,
  });
  box(citadel, 3.75, 0.16, 3.35, concreteDark, 0, 2.40, 0, { cast: true });
  box(citadel, 3.0, 0.30, 2.7, mDark, 0, 2.62, 0);
  // Window bands.
  for (const z of [-1.56, 1.56]) {
    box(citadel, 2.75, 0.24, 0.05, mGlass, 0, 1.55, z * 0.99);
    box(citadel, 2.75, 0.20, 0.05, mGlass, 0, 1.06, z * 0.99);
  }
  for (const x of [-1.76, 1.76]) {
    box(citadel, 0.05, 0.22, 2.30, mGlass, x, 1.55, 0);
  }
  // Doors, trim, accent stripe.
  box(citadel, 0.06, 1.20, 0.95, mDark, 1.78, 0.62, 0.25);
  box(citadel, 0.10, 0.12, 1.10, mAccent, 1.79, 1.28, 0.25);
  box(citadel, 0.08, 0.12, 2.9, mAccent, -1.78, 1.92, 0);
  // Rooftop vents.
  for (let i = 0; i < 3; i++) {
    box(citadel, 0.34, 0.18, 0.34, mSteel, -1.1 + i * 0.55, 2.80, -0.7);
  }
  // Landing lights.
  for (const [lx, lz] of [[1.65, 1.0], [1.65, -1.0], [-1.6, 0]]) {
    sphere(citadel, 0.05, material(gl, 0xffd58a, {
      rough: 0.4, emissive: 0x8a4a10,
    }), lx, 2.48, lz, { seg: 6 });
  }

  // Crane: lattice mast, boom, cable and hook.
  const crane = new THREE.Group();
  crane.position.set(2.75, 0.42, -2.15);
  root.add(crane);
  const mastH = 5.0;
  for (const [ox, oz] of [[-0.14, -0.14], [0.14, -0.14], [0.14, 0.14], [-0.14, 0.14]]) {
    box(crane, 0.055, mastH, 0.055, mSteel, ox, mastH / 2, oz, { cast: true });
  }
  for (let i = 1; i < 6; i++) {
    const y = i * mastH / 6;
    box(crane, 0.34, 0.035, 0.035, mSteel, 0, y, -0.14);
    box(crane, 0.34, 0.035, 0.035, mSteel, 0, y, 0.14);
    box(crane, 0.035, 0.035, 0.34, mSteel, -0.14, y, 0);
  }
  const boom = new THREE.Group();
  boom.position.set(0, mastH, 0);
  crane.add(boom);
  box(boom, 3.6, 0.13, 0.16, mSteel, 1.5, 0.10, 0, { cast: true });
  box(boom, 0.9, 0.10, 0.14, mDark, -0.35, 0.10, 0);
  box(boom, 0.30, 0.45, 0.40, concreteDark, -0.72, 0.02, 0);
  // Cable + hook.
  for (const hx of [2.6]) {
    cyl(root, 0.012, 0.012, 2.0, mDark, 2.75 + hx, 0.42 + mastH - 0.95, -2.15, { seg: 4 });
    const hook = new THREE.Group();
    hook.position.set(2.75 + hx, 0.42 + mastH - 2.0, -2.15);
    root.add(hook);
    torus(hook, 0.14, 0.035, mSteel, 0, 0, 0, { rx: Math.PI / 2 });
  }

  const flag = buildFlag(gl, root, -0.55, 2.95, -0.3, 1.35, 2.7, accent, 0.7);

  // Crane slow sweep + flag.
  const anim = (t) => {
    crane.rotation.y = Math.sin(t * 0.24) * 0.22;
    flag.anim(t);
  };

  return { root, anim, kind: 'conyard' };
}

function buildPower(gl, def, accent) {
  const root = new THREE.Group();
  const concrete = material(gl, 0x9a907a, { rough: 0.9 });
  const mBody = material(gl, mixHex(0x8c8168, accent, 0.10), { rough: 0.72, metal: 0.2 });
  const mDark = material(gl, 0x3a3b35, { rough: 0.8, metal: 0.25 });
  const mSteel = material(gl, 0x777970, { rough: 0.36, metal: 0.65 });
  const mAccent = material(gl, accent, { rough: 0.5 });
  const mStripe = material(gl, 0x2b2c28, { rough: 0.85 });

  box(root, 5.6, 0.24, 4.6, concrete, 0, 0.12, 0, { receive: true });
  box(root, 2.50, 1.90, 3.10, mBody, 1.15, 1.08, 0, { cast: true, receive: true });
  box(root, 2.70, 0.14, 3.30, concrete, 1.15, 2.10, 0, { cast: true });
  box(root, 0.08, 0.34, 2.40, mAccent, 2.42, 0.80, 0);
  // Transformer bank + insulators.
  box(root, 0.75, 0.75, 0.75, mDark, 2.10, 0.62, 1.55, { cast: true });
  for (let i = 0; i < 3; i++) {
    cyl(root, 0.04, 0.05, 0.30, mSteel, 1.85 + i * 0.24, 1.15, 1.55, { seg: 6 });
  }
  for (let i = 0; i < 3; i++) {
    box(root, 1.60, 0.06, 0.06, mSteel, 0.0, 1.55 + i * 0.22, 1.60);
  }

  const stacks = [];
  for (const z of [-1.02, 1.02]) {
    const baseY = 0.24;
    cyl(root, 0.58, 0.72, 3.9, mBody, -1.45, baseY + 1.95, z, { seg: 14, cast: true });
    cyl(root, 0.50, 0.56, 0.22, mDark, -1.45, baseY + 3.96, z, { seg: 14 });
    cyl(root, 0.60, 0.60, 0.16, mAccent, -1.45, baseY + 3.20, z, { seg: 14 });
    cyl(root, 0.62, 0.62, 0.08, mDark, -1.45, baseY + 2.30, z, { seg: 14 });
    for (let i = 0; i < 5; i++) {
      box(root, 0.06, 0.05, 0.42, mSteel, -1.45 + 0.55, baseY + 0.55 + i * 0.55, z + 0.005);
    }
    stacks.push({ x: -1.45, y: baseY + 4.05, z });
  }
  // Pipes between stacks and hall.
  for (const z of [-1.02, 1.02]) {
    const pg = new THREE.CylinderGeometry(0.10, 0.10, 2.3, 8);
    pg.rotateZ(Math.PI / 2);
    addMesh(root, pg, mSteel, 0.05, 0.55, z);
  }

  // Steam puffs (sprite animation).
  const steam = [];
  let n = 0;
  for (const s of stacks) {
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.SpriteMaterial({
        map: gl.steamTex, color: 0xf2f0e8, transparent: true,
        opacity: 0.0, depthWrite: false,
      });
      const spr = new THREE.Sprite(mat);
      spr.position.set(s.x, s.y, s.z);
      spr.scale.setScalar(0.8);
      root.add(spr);
      steam.push({ spr, mat, x: s.x, y: s.y, z: s.z, phase: (n++ % 4) / 4 });
    }
  }

  const anim = (t) => {
    for (const p of steam) {
      const age = (p.phase + t * 0.24) % 1;
      p.spr.position.set(p.x + Math.sin(age * 5 + p.phase * 7) * 0.28,
        p.y + age * 2.6, p.z + Math.cos(age * 4 + p.phase * 3) * 0.18);
      p.spr.scale.setScalar(0.5 + age * 2.1);
      p.mat.opacity = Math.sin(Math.min(1, age * 1.6) * Math.PI) * 0.28;
    }
  };
  return { root, anim, kind: 'power' };
}

function buildOil(gl, def, accent) {
  const root = new THREE.Group();
  const concrete = material(gl, 0x9c927a, { rough: 0.92 });
  const mBody = material(gl, mixHex(0x83795e, accent, 0.12), { rough: 0.78, metal: 0.16 });
  const mRust = material(gl, 0x7d5c3c, { rough: 0.88, metal: 0.15 });
  const mDark = material(gl, 0x35362f, { rough: 0.85 });
  const mSteel = material(gl, 0x71736a, { rough: 0.4, metal: 0.62 });
  const mAccent = material(gl, accent, { rough: 0.5 });

  box(root, 4.9, 0.22, 4.1, concrete, 0, 0.11, 0, { receive: true });
  // Storage tank.
  cyl(root, 1.02, 1.10, 1.55, mRust, -1.35, 1.02, -1.05, { seg: 16, cast: true });
  cyl(root, 1.06, 1.06, 0.14, mDark, -1.35, 1.82, -1.05, { seg: 16 });
  cyl(root, 1.06, 1.06, 0.10, mAccent, -1.35, 1.52, -1.05, { seg: 16 });
  for (let i = 0; i < 5; i++) {
    box(root, 0.06, 0.78, 0.05, mSteel, -0.38, 1.10, -1.05 - 0.45 + i * 0.22);
  }
  // Pumpjack A-frame.
  const px = 0.95, pz = 0.95;
  box(root, 0.18, 2.15, 0.18, mSteel, px - 0.55, 1.08, pz, { rz: -0.36, cast: true });
  box(root, 0.18, 2.15, 0.18, mSteel, px + 0.55, 1.08, pz, { rz: 0.36, cast: true });
  box(root, 0.18, 2.15, 0.18, mSteel, px - 0.55, 1.08, pz, { rz: -0.36 });
  box(root, 0.10, 0.10, 1.10, mSteel, px, 2.08, pz);
  box(root, 1.24, 0.10, 0.12, mSteel, px, 1.08, pz);

  const beam = new THREE.Group();
  beam.position.set(px, 2.14, pz);
  root.add(beam);
  box(beam, 3.2, 0.17, 0.24, mBody, 0.15, 0, 0, { cast: true });
  box(beam, 0.30, 0.46, 0.34, mDark, 1.72, -0.20, 0, { cast: true });
  box(beam, 1.10, 0.42, 0.46, mRust, -1.35, -0.05, 0, { cast: true });
  cyl(beam, 0.035, 0.035, 0.8, mSteel, 1.86, -0.55, 0, { seg: 5 });
  // Walking beam pivot.
  cyl(beam, 0.10, 0.10, 0.30, mDark, 0, 0, 0, { rx: Math.PI / 2, seg: 8 });
  // Motor + belt guard.
  box(root, 0.62, 0.42, 0.52, mDark, 0.30, 0.45, 0.55, { cast: true });
  cyl(root, 0.22, 0.22, 0.10, mSteel, 0.02, 0.48, 0.55, { rx: Math.PI / 2, seg: 10 });
  box(root, 0.10, 0.10, 0.75, mAccent, 0.95, 0.30, pz);

  const anim = (t) => {
    beam.rotation.z = Math.sin(t * 1.55 + 0.4) * 0.17;
  };
  return { root, anim, kind: 'oil' };
}

function buildBarracks(gl, def, accent) {
  const root = new THREE.Group();
  const concrete = material(gl, 0x9c927a, { rough: 0.92 });
  const mBody = material(gl, mixHex(0x8e8468, accent, 0.10), { rough: 0.82 });
  const mDark = material(gl, 0x3b3c35, { rough: 0.8 });
  const mGlass = material(gl, 0x2b4149, { rough: 0.15, metal: 0.6 });
  const mAccent = material(gl, accent, { rough: 0.5 });
  const mSand = material(gl, 0x9f9065, { rough: 1 });

  box(root, 4.8, 0.22, 3.8, concrete, 0, 0.11, 0, { receive: true });
  addMesh(root, bevelBoxGeo(4.3, 3.1, 1.95, 0.06), mBody, 0, 0.22, 0, {
    cast: true, receive: true,
  });
  box(root, 4.55, 0.16, 3.35, mDark, 0, 2.24, 0, { cast: true });
  // Roof AC units.
  box(root, 0.55, 0.28, 0.55, mDark, -1.2, 2.45, -0.3);
  box(root, 0.55, 0.22, 0.55, mDark, 0.7, 2.42, 0.45);
  // Front door + frame (front = +X).
  box(root, 0.08, 1.20, 1.05, mDark, 2.17, 0.82, 0.35);
  box(root, 0.12, 1.35, 0.12, mAccent, 2.19, 0.86, 0.92);
  box(root, 0.12, 1.35, 0.12, mAccent, 2.19, 0.86, -0.22);
  box(root, 0.20, 0.10, 1.25, mAccent, 2.20, 1.52, 0.35);
  // Windows.
  for (const z of [-1.0, 0.0, 1.0]) {
    box(root, 0.05, 0.35, 0.48, mGlass, 2.16, 1.15, z - 0.9);
    box(root, 0.05, 0.35, 0.48, mGlass, -2.16, 1.15, z - 0.2);
  }
  box(root, 0.05, 0.28, 3.2, mAccent, 2.17, 1.92, 0);
  // Sandbag ring at the entrance.
  for (let i = 0; i < 5; i++) {
    box(root, 0.42, 0.22, 0.30, mSand, 2.55, 0.11 + (i % 2) * 0.20, -0.55 + i * 0.32,
      { ry: (i - 2) * 0.12 });
  }
  // Flag.
  const flag = buildFlag(gl, root, 1.5, 0.22, -1.7, 1.05, 3.9, accent, 1.8);

  const anim = (t) => flag.anim(t);
  return { root, anim, kind: 'barracks' };
}

function buildFactory(gl, def, accent) {
  const root = new THREE.Group();
  const concrete = material(gl, 0x9c927a, { rough: 0.92 });
  const mBody = material(gl, mixHex(0x82785f, accent, 0.10), { rough: 0.75, metal: 0.22 });
  const mDark = material(gl, 0x35362f, { rough: 0.82 });
  const mSteel = material(gl, 0x74766d, { rough: 0.38, metal: 0.62 });
  const mAccent = material(gl, accent, { rough: 0.5 });
  const mGlass = material(gl, 0x2b4149, { rough: 0.15, metal: 0.6 });

  box(root, 7.2, 0.26, 5.8, concrete, 0, 0.13, 0, { receive: true });
  addMesh(root, bevelBoxGeo(5.9, 4.6, 2.55, 0.10), mBody, 0, 0.26, 0, {
    cast: true, receive: true,
  });
  box(root, 6.1, 0.18, 4.8, mDark, 0, 2.90, 0, { cast: true });
  box(root, 4.6, 0.35, 3.2, mBody, -0.2, 3.02, 0);
  // Big roll-up door on +X.
  box(root, 0.10, 1.85, 3.30, mDark, 2.98, 1.15, 0);
  box(root, 0.20, 0.16, 3.70, mAccent, 3.00, 2.16, 0);
  box(root, 0.20, 0.16, 0.18, mAccent, 3.00, 0.28, 1.85);
  box(root, 0.20, 0.16, 0.18, mAccent, 3.00, 0.28, -1.85);
  for (let i = 0; i < 7; i++) {
    box(root, 0.05, 0.06, 3.0, mSteel, 3.05, 0.42 + i * 0.24, 0);
  }
  // Windows / vents.
  for (let i = 0; i < 4; i++) {
    box(root, 0.05, 0.28, 0.55, mGlass, -2.96, 1.75, -1.5 + i * 1.0);
  }
  for (let i = 0; i < 3; i++) {
    box(root, 0.60, 0.16, 0.60, mSteel, -0.8 + i * 1.15, 3.25, -1.0);
  }
  // Chimney.
  cyl(root, 0.36, 0.48, 4.4, mBody, -2.15, 2.55, -1.55, { seg: 12, cast: true });
  cyl(root, 0.40, 0.40, 0.18, mAccent, -2.15, 3.65, -1.55, { seg: 12 });
  cyl(root, 0.44, 0.40, 0.20, mDark, -2.15, 4.78, -1.55, { seg: 12 });
  // Exterior ducting.
  const duct = new THREE.CylinderGeometry(0.16, 0.16, 2.4, 8);
  duct.rotateZ(Math.PI / 2);
  addMesh(root, duct, mSteel, 1.2, 2.45, -1.9);
  box(root, 0.5, 0.5, 0.5, mSteel, 0.1, 2.45, -1.9);

  return { root, anim: (t) => {}, kind: 'factory' };
}

function buildAirfield(gl, def, accent) {
  const root = new THREE.Group();
  const asphalt = material(gl, 0x4b4d49, { rough: 0.96 });
  const mBody = material(gl, mixHex(0x8a8167, accent, 0.10), { rough: 0.72, metal: 0.2 });
  const mDark = material(gl, 0x33352f, { rough: 0.8 });
  const mWhite = material(gl, 0xd9d6c6, { rough: 0.85 });
  const mSteel = material(gl, 0x73756c, { rough: 0.4, metal: 0.6 });
  const mGlass = material(gl, 0x2b4149, { rough: 0.12, metal: 0.7 });
  const mAccent = material(gl, accent, { rough: 0.5 });

  // Runway slab.
  box(root, 10.2, 0.14, 6.4, asphalt, 0, 0.07, 0, { receive: true });
  for (let i = 0; i < 8; i++) {
    box(root, 0.62, 0.012, 0.10, mWhite, -4.3 + i * 1.22, 0.15, 0);
  }
  for (const end of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      box(root, 0.10, 0.012, 0.55, mWhite, end * 4.75, 0.15, -1.0 + i * 0.66);
    }
    box(root, 0.9, 0.012, 0.08, mWhite, end * 3.9, 0.15, 2.25);
    box(root, 0.9, 0.012, 0.08, mWhite, end * 3.9, 0.15, -2.25);
  }
  // Helipad circle + H.
  torus(root, 1.05, 0.05, mWhite, 2.85, 0.16, 2.05, { rx: Math.PI / 2 });
  box(root, 0.12, 0.012, 0.95, mWhite, 2.55, 0.16, 2.05);
  box(root, 0.12, 0.012, 0.95, mWhite, 3.15, 0.16, 2.05);
  box(root, 0.72, 0.012, 0.10, mWhite, 2.85, 0.16, 2.05);

  // Two hangars (half-buried full cylinders read as Quonset huts).
  for (const z of [-1.75, 1.75]) {
    const shell = new THREE.CylinderGeometry(1.22, 1.22, 2.5, 14);
    shell.rotateZ(Math.PI / 2);
    addMesh(root, shell, mBody, -2.7, 0.55, z, { cast: true, receive: true });
    box(root, 0.10, 1.20, 1.55, mDark, -1.44, 0.66, z);
    box(root, 0.12, 0.16, 1.95, mAccent, -1.43, 1.33, z);
    box(root, 0.16, 0.10, 1.8, mSteel, -1.40, 1.48, z);
  }

  // Control tower.
  const tower = new THREE.Group();
  tower.position.set(3.25, 0.14, -2.05);
  root.add(tower);
  box(tower, 1.15, 2.35, 1.15, mBody, 0, 1.18, 0, { cast: true });
  box(tower, 1.42, 0.62, 1.42, mGlass, 0, 2.62, 0, { cast: true });
  box(tower, 1.55, 0.12, 1.55, mDark, 0, 2.98, 0);
  box(tower, 1.48, 0.08, 1.48, mAccent, 0, 2.32, 0);
  cyl(tower, 0.03, 0.04, 0.9, mSteel, 0, 3.48, 0, { seg: 5 });
  // Rotating radar bar.
  const radar = new THREE.Group();
  radar.position.set(-0.1, 3.95, 0);
  tower.add(radar);
  box(radar, 1.15, 0.06, 0.10, mSteel, 0, 0, 0);
  box(radar, 0.10, 0.20, 0.24, mDark, 0, -0.02, 0);

  // Windsock.
  cyl(root, 0.02, 0.03, 1.1, mSteel, 4.4, 0.55, -2.6, { seg: 5 });
  cone(root, 0.14, 0.45, mAccent, 4.55, 1.04, -2.6, { rz: -Math.PI / 2 });

  const anim = (t) => { radar.rotation.y = t * 0.8; };
  return { root, anim, kind: 'airfield' };
}

function buildDefense(gl, def, accent) {
  const root = new THREE.Group();
  const concrete = material(gl, 0xa0967e, { rough: 0.94 });
  const mBody = material(gl, mixHex(0x7d745c, accent, 0.14), { rough: 0.78, metal: 0.2 });
  const mDark = material(gl, 0x343630, { rough: 0.82 });
  const mSteel = material(gl, 0x6e7067, { rough: 0.4, metal: 0.65 });
  const mAccent = material(gl, accent, { rough: 0.5 });
  const mGlass = material(gl, 0x2b4149, { rough: 0.15, metal: 0.6 });

  cyl(root, 1.55, 1.75, 0.55, concrete, 0, 0.28, 0, { seg: 10, cast: true, receive: true });
  // Sandbag ring.
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    box(root, 0.42, 0.20, 0.30, material(gl, 0x9f9065, { rough: 1 }),
      Math.cos(a) * 1.25, 0.62, Math.sin(a) * 1.25, { ry: -a });
  }
  const head = new THREE.Group();
  head.position.set(0, 0.92, 0);
  root.add(head);
  cyl(head, 0.72, 0.88, 0.44, mBody, 0, 0.10, 0, { seg: 10, cast: true });
  addMesh(head, bevelBoxGeo(1.25, 1.20, 0.48, 0.055), mBody, 0, 0.36, 0, {
    cast: true, receive: true,
  });
  box(head, 0.05, 0.16, 0.70, mGlass, 0.64, 0.45, 0);
  const barrel = new THREE.Group();
  barrel.position.set(0.42, 0.52, 0);
  head.add(barrel);
  box(barrel, 0.34, 0.22, 0.26, mSteel, 0.06, 0, 0);
  const bgeo = new THREE.CylinderGeometry(0.035, 0.045, 1.3, 8);
  bgeo.rotateZ(-Math.PI / 2);
  addMesh(barrel, bgeo, mSteel, 0.72, 0, 0, { cast: true });
  box(head, 0.30, 0.10, 0.30, mDark, -0.46, 0.55, 0.38);
  box(head, 0.30, 0.06, 0.02, mAccent, 0.02, 0.30, 0.62);

  const anim = (t) => { head.rotation.y = Math.sin(t * 0.52 + def.id.length) * 0.75; };
  return { root, anim, kind: 'defense' };
}

function buildGenericBuilding(gl, def, accent) {
  const root = new THREE.Group();
  const size = def.fp * S;
  const concrete = material(gl, 0x9c927a, { rough: 0.92 });
  const mBody = material(gl, mixHex(0x8a7f62, accent, 0.10), { rough: 0.78 });
  const mDark = material(gl, 0x373831, { rough: 0.8 });
  const mAccent = material(gl, accent, { rough: 0.5 });
  const mGlass = material(gl, 0x2b4149, { rough: 0.15, metal: 0.6 });
  box(root, size * 0.82, 0.22, size * 0.72, concrete, 0, 0.11, 0, { receive: true });
  addMesh(root, bevelBoxGeo(size * 0.56, size * 0.48, 1.8, 0.06), mBody, 0, 0.22, 0, {
    cast: true, receive: true,
  });
  box(root, size * 0.60, 0.14, size * 0.52, mDark, 0, 2.1, 0, { cast: true });
  for (let i = 0; i < 3; i++) {
    box(root, 0.05, 0.30, 0.55, mGlass, size * 0.285, 1.25, -0.9 + i * 0.9);
  }
  box(root, 0.06, 0.10, size * 0.45, mAccent, size * 0.286, 1.80, 0);
  cyl(root, 0.02, 0.03, 1.1, mDark, -size * 0.2, 2.6, -size * 0.2, { seg: 4 });
  return { root, anim: (t) => {}, kind: 'generic' };
}

function buildStructure(gl, def, accent) {
  switch (def.id) {
    case 'SH-01': return buildConyard(gl, def, accent);
    case 'SH-02': return buildPower(gl, def, accent);
    case 'SH-03': return buildOil(gl, def, accent);
    case 'SH-04': return buildBarracks(gl, def, accent);
    case 'SH-05': return buildFactory(gl, def, accent);
    case 'SH-06': return buildAirfield(gl, def, accent);
    default:
      if (def.type === 'Def') return buildDefense(gl, def, accent);
      return buildGenericBuilding(gl, def, accent);
  }
}

// ---------------------------------------------------------------------------
// entity sync
// ---------------------------------------------------------------------------

function disposeGroup(gl, root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.isSprite && o.material) o.material.dispose();
  });
  gl.scene.remove(root);
}

function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function isHeloDef(def) {
  return /helo|uav/i.test(def.cls || '');
}

function buildUnitModel(gl, def, accent) {
  if (isInfantryCls(def.cls)) return buildInfantry(gl, def, accent);
  if (def.domain === 'Air') {
    return isHeloDef(def) ? buildHelo(gl, def, accent) : buildJet(gl, def, accent);
  }
  if (def.domain === 'Sea') return buildShip(gl, def, accent);
  if (def.cls === 'Harvester' || def.cls === 'MCV') return buildTruck(gl, def, accent);
  return buildTank(gl, def, accent);
}

function createUnitRecord(gl, u, def) {
  const accent = accentFor(gl, u.owner);
  const model = buildUnitModel(gl, def, accent);
  const rec = Object.assign(model, {
    unitId: u.id,
    defId: u.defId,
    def,
    owner: u.owner,
    phase: hash01(u.id, 7, 3) * 6.28,
    yaw: 0,
    speed: 0,
    turn: 0,
    aim: 0,
    recoil: 0,
    lastX: u.x,
    lastY: u.y,
    lastHp: u.hp,
    walkPhase: 0,
  });
  const wp = unitWorld(gl, u);
  rec.root.position.set(wp.x, def.domain === 'Air'
    ? (isHeloDef(def) ? 2.7 : 5.4)
    : (def.domain === 'Sea' ? 0.03 : heightAtWu(gl, u.x, u.y)), wp.z);
  gl.scene.add(rec.root);
  gl.units.set(u.id, rec);
  return rec;
}

function findTargetEnt(gl, u) {
  const st = gl.state;
  const o = u.order;
  if (!o) return null;
  const id = o.type === 'attackTarget' ? o.targetId : (o.enemyId || 0);
  if (!id) return null;
  const ent = st.units[id] || st.structures[id];
  if (!ent || ent.hp <= 0) return null;
  return ent;
}

function targetWorld(gl, ent) {
  if (ent.cx !== undefined) {
    return structCenterWu(gl, ent);
  }
  return unitWorld(gl, ent);
}

function updateUnit(gl, u, rec, dt, t) {
  const def = rec.def;
  const st = gl.state;
  const p = unitWorld(gl, u);
  const isAir = def.domain === 'Air';
  const helo = isAir && isHeloDef(def);
  const aiAlt = isAir ? (helo ? 2.7 : 5.4) : 0;

  const k = 1 - Math.exp(-dt * (isAir ? 26 : 15));
  rec.root.position.x += (p.x - rec.root.position.x) * k;
  rec.root.position.z += (p.z - rec.root.position.z) * k;

  let baseY;
  if (isAir) baseY = aiAlt + (helo ? Math.sin(t * 1.8 + rec.phase) * 0.11 : 0);
  else if (def.domain === 'Sea') baseY = 0.03 + Math.sin(t * 1.15 + rec.phase) * 0.045;
  else baseY = heightAtWu(gl, u.x, u.y);
  rec.root.position.y += (baseY - rec.root.position.y) * Math.min(1, dt * 9);

  // Movement heading + smoothed speed.
  const dx = u.x - rec.lastX;
  const dy = u.y - rec.lastY;
  const dist = Math.hypot(dx, dy);
  rec.lastX = u.x;
  rec.lastY = u.y;
  const instSpeed = dist * WU / Math.max(0.0001, dt);
  rec.speed = lerp(rec.speed, Math.min(instSpeed, 40), 1 - Math.exp(-dt * 5));

  const target = findTargetEnt(gl, u);
  let desiredYaw = rec.yaw;
  if (dist > 0.2) desiredYaw = Math.atan2(-dy, dx);

  const tp = target ? targetWorld(gl, target) : null;
  const distToTarget = tp ? Math.hypot(tp.x - p.x, tp.z - p.z) : Infinity;
  const engageRange = (def.rangeWu || 0) * WU * 1.35;
  if (tp && (def.domain === 'Air' || isInfantryCls(def.cls))) {
    if (distToTarget < engageRange || rec.speed < 1.2) {
      desiredYaw = Math.atan2(-(tp.z - p.z), tp.x - p.x);
    }
  }

  const turn = angleDelta(rec.yaw, desiredYaw);
  const turnRate = clamp(turn / Math.max(0.0001, dt), -6, 6);
  rec.turn = lerp(rec.turn, turnRate, 1 - Math.exp(-dt * 4));
  const yawK = 1 - Math.exp(-dt * (isAir ? 3.2 : 5.5));
  rec.yaw += angleDelta(rec.yaw, desiredYaw) * yawK;
  rec.root.rotation.y = rec.yaw;

  // Hull / body motion: drive tilt on ground vehicles, banking in the air.
  const body = rec.body;
  if (body) {
    if (isAir) {
      body.rotation.z = -clamp(rec.speed * 0.018, 0, 0.20) + (helo ? Math.sin(t * 2.6) * 0.012 : 0);
      body.rotation.x = clamp(-rec.turn * 0.20, -0.35, 0.35);
    } else if (def.domain === 'Sea') {
      body.rotation.z = Math.sin(t * 0.9 + rec.phase) * 0.015;
      body.rotation.x = Math.sin(t * 0.72 + rec.phase * 1.3) * 0.022
        - clamp(rec.turn * 0.03, -0.05, 0.05);
    } else if (rec.kind !== 'infantry') {
      body.rotation.z = -clamp(rec.speed * 0.006, 0, 0.045) - rec.recoil * 0.012;
      body.rotation.x = clamp(-rec.turn * 0.05, -0.09, 0.09);
    }
  }

  // Turret tracking.
  if (rec.turret && tp) {
    const worldAim = Math.atan2(-(tp.z - rec.root.position.z), tp.x - rec.root.position.x);
    const local = angleDelta(0, worldAim - rec.root.rotation.y);
    rec.aim += angleDelta(rec.aim, local) * (1 - Math.exp(-dt * 4.5));
    rec.turret.rotation.y = rec.aim;
  } else if (rec.turret) {
    rec.aim += angleDelta(rec.aim, 0) * (1 - Math.exp(-dt * 1.2));
    rec.turret.rotation.y = rec.aim;
  }
  if (rec.barrelPivot) {
    rec.recoil = Math.max(0, rec.recoil - dt * 6.5);
    rec.barrelPivot.position.x = 0.30 - rec.recoil * 0.17;
  }

  // Rotor spin.
  if (rec.rotor) rec.rotor.rotation.y += dt * 26;
  if (rec.tailRotor) rec.tailRotor.rotation.x += dt * 46;

  // Infantry walk cycle + idle bob.
  if (rec.figures) {
    const moving = rec.speed > 0.45;
    rec.walkPhase += dt * (moving ? 8.5 : 2.1);
    for (const fig of rec.figures) {
      const swing = moving
        ? Math.sin(rec.walkPhase + fig.phase * 1.5) * 0.52
        : Math.sin(t * 1.7 + fig.phase) * 0.035;
      fig.fig.position.y = fig.baseY + Math.sin(t * 2.1 + fig.phase) * 0.012
        + (moving ? Math.abs(Math.sin(rec.walkPhase + fig.phase * 1.5)) * 0.022 : 0);
      fig.legL.rotation.z = swing;
      fig.legR.rotation.z = -swing;
      fig.armL.rotation.z = -swing * 0.55;
      fig.armR.rotation.z = swing * 0.35;
      fig.fig.rotation.y = Math.sin(t * 0.8 + fig.phase) * 0.05;
    }
  }

  rec.lastHp = u.hp;
}

function fogCellVisible(gl, x, y) {
  const st = gl.state;
  const fog = st.fog && st.fog[gl.localSlot || 0];
  if (!fog) return true;
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  if (cx < 0 || cy < 0 || cx >= st.map.w || cy >= st.map.h) return false;
  return fog.visible[cy * st.map.w + cx] === 1;
}

function fogCellSeen(gl, cx, cy) {
  const st = gl.state;
  const fog = st.fog && st.fog[gl.localSlot || 0];
  if (!fog) return true;
  if (cx < 0 || cy < 0 || cx >= st.map.w || cy >= st.map.h) return false;
  return fog.seen[cy * st.map.w + cx] === 1;
}

function isHostileOwner(gl, owner) {
  const st = gl.state;
  if (owner < 0) return true;
  const me = st.players && st.players[gl.localSlot || 0];
  const p = st.players && st.players[owner];
  if (!me || !p) return false;
  return p.team !== me.team;
}

function syncUnits(gl, dt, t) {
  const st = gl.state;
  gl.localSlot = gl.game.playerSlot || 0;
  const alive = new Set();
  for (const id in st.units) {
    const u = st.units[id];
    alive.add(u.id);
    const def = st.unitDefs[u.defId];
    let rec = gl.units.get(u.id);
    if (!rec) rec = createUnitRecord(gl, u, def);
    updateUnit(gl, u, rec, dt, t);
    rec.root.visible = !isHostileOwner(gl, u.owner) || fogCellVisible(gl, u.x, u.y);
    rec.lastVisible = rec.root.visible;
  }
  for (const [id, rec] of gl.units) {
    if (!alive.has(id)) {
      if (rec.lastHp > 0 && rec.lastVisible !== false) {
        spawnExplosion(gl, rec.root.position, rec.kind === 'tank' ? 1.5 : 1.0);
      }
      disposeGroup(gl, rec.root);
      gl.units.delete(id);
    }
  }
}

function structGroundY(gl, s) {
  const cx = Math.floor(s.cx + s.fp / 2);
  const cy = Math.floor(s.cy + s.fp / 2);
  return cellHeight(gl, cx, cy);
}

function ensureStructDim(gl, rec, s) {
  if (rec.dim) return rec.dim;
  const size = s.fp * S;
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.42,
    depthWrite: false, fog: false,
  });
  const m = new THREE.Mesh(new THREE.BoxGeometry(size * 0.92, 2.3, size * 0.92), mat);
  m.position.y = 1.15;
  m.renderOrder = 9;
  rec.root.add(m);
  rec.dim = m;
  return m;
}

function createStructRecord(gl, s, def, accent) {
  const model = buildStructure(gl, def, accent);
  const rec = Object.assign(model, {
    structId: s.id,
    defId: s.defId,
    def,
    owner: s.owner,
    lastHp: s.hp,
    lastVisible: true,
  });
  const p = structCenterWu(gl, s);
  rec.root.position.set(p.x, structGroundY(gl, s), p.z);
  // Deterministic quarter-turn variety for warehouses / hangars.
  rec.root.rotation.y = def.id === 'SH-01' ? 0 : ((s.id * 37) % 5 - 2) * 0.035;
  gl.scene.add(rec.root);
  gl.structs.set(s.id, rec);
  return rec;
}

function syncStructures(gl, dt, t) {
  const st = gl.state;
  const alive = new Set();
  for (const id in st.structures) {
    const s = st.structures[id];
    alive.add(s.id);
    const def = st.structDefs[s.defId];
    const accent = accentFor(gl, s.owner);
    let rec = gl.structs.get(s.id);
    if (rec && (rec.defId !== s.defId || rec.owner !== s.owner)) {
      disposeGroup(gl, rec.root);
      gl.structs.delete(s.id);
      rec = null;
    }
    if (!rec) rec = createStructRecord(gl, s, def, accent);
    const p = structCenterWu(gl, s);
    rec.root.position.x = p.x;
    rec.root.position.z = p.z;
    rec.root.position.y = structGroundY(gl, s);
    if (rec.anim) rec.anim(t, dt);
    rec.lastHp = s.hp;
    if (isHostileOwner(gl, s.owner)) {
      const seen = fogCellSeen(gl, s.cx + (s.fp >> 1), s.cy + (s.fp >> 1));
      const vis = seen && fogCellVisible(gl,
        (s.cx + s.fp / 2) * CELL, (s.cy + s.fp / 2) * CELL);
      rec.root.visible = seen;
      const dim = ensureStructDim(gl, rec, s);
      dim.visible = seen && !vis;
      rec.lastVisible = seen;
    } else {
      rec.root.visible = true;
      if (rec.dim) rec.dim.visible = false;
      rec.lastVisible = true;
    }
  }
  for (const [id, rec] of gl.structs) {
    if (!alive.has(id)) {
      if (rec.lastHp > 0 && rec.def.type !== 'Core' && rec.lastVisible !== false) {
        spawnExplosion(gl, rec.root.position, 3.2);
      }
      disposeGroup(gl, rec.root);
      gl.structs.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// tracers, muzzle flashes, explosions
// ---------------------------------------------------------------------------

function sourceTracerHeight(gl, pr) {
  if (!pr.srcUnitId) return 1.25;
  const u = gl.state.units[pr.srcUnitId];
  if (!u) return 1.0;
  const def = gl.state.unitDefs[u.defId];
  if (!def) return 1.0;
  if (def.domain === 'Air') return (isHeloDef(def) ? 2.7 : 5.4) + 0.1;
  if (def.domain === 'Sea') return 0.72;
  if (isInfantryCls(def.cls)) return 0.42;
  return 1.0;
}

function makeTracer(gl, pr) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xffd58a, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  gl.scene.add(line);
  return { line, geo, mat };
}

function flashAtUnit(gl, pr) {
  const rec = gl.units.get(pr.srcUnitId);
  if (!rec) return;
  if (rec.barrelPivot) rec.recoil = 1;
  if (rec.muzzle) {
    const v = new THREE.Vector3();
    rec.muzzle.getWorldPosition(v);
    spawnFlash(gl, v, rec.kind === 'tank' ? 0.9 : 0.55);
  }
}

function syncTracers(gl, dt) {
  const st = gl.state;
  const alive = new Set();
  for (const id in st.projectiles) {
    const pr = st.projectiles[id];
    if (pr.kind !== 'tracer') continue;
    // Enemy fire in the fog must not reveal the shooter.
    if (isHostileOwner(gl, pr.owner)
      && !fogCellVisible(gl, pr.x, pr.y)
      && !fogCellVisible(gl, pr.sx, pr.sy)) {
      alive.add(pr.id);
      const hidden = gl.tracerLines.get(pr.id);
      if (hidden) {
        gl.scene.remove(hidden.line);
        hidden.geo.dispose();
        hidden.mat.dispose();
        gl.tracerLines.delete(pr.id);
      }
      continue;
    }
    alive.add(pr.id);
    let tr = gl.tracerLines.get(pr.id);
    if (!tr) {
      tr = makeTracer(gl, pr);
      gl.tracerLines.set(pr.id, tr);
      flashAtUnit(gl, pr);
    }
    const sx = wuToX(gl, pr.sx);
    const sz = wuToZ(gl, pr.sy);
    const hx = wuToX(gl, pr.x);
    const hz = wuToZ(gl, pr.y);
    const frac = clamp(1 - pr.ticksLeft / Math.max(1, pr.total), 0.06, 1);
    const tail = Math.max(0, frac - 0.42);
    const y0 = sourceTracerHeight(gl, pr);
    const y1 = 0.85;
    const pos = tr.geo.attributes.position;
    pos.array[0] = lerp(sx, hx, tail);
    pos.array[1] = lerp(y0, y1, tail);
    pos.array[2] = lerp(sz, hz, tail);
    pos.array[3] = hx;
    pos.array[4] = lerp(y0, y1, frac);
    pos.array[5] = hz;
    pos.needsUpdate = true;
  }
  for (const [id, tr] of gl.tracerLines) {
    if (alive.has(id)) continue;
    gl.scene.remove(tr.line);
    tr.geo.dispose();
    tr.mat.dispose();
    gl.tracerLines.delete(id);
  }
}

function spawnFlash(gl, pos, size) {
  const mat = new THREE.SpriteMaterial({
    map: gl.flashTex, color: 0xffe6a8, transparent: true,
    opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const s = new THREE.Sprite(mat);
  s.position.copy(pos);
  s.scale.setScalar(size * 0.8);
  gl.scene.add(s);
  gl.effects.push({
    sprite: s, mat, life: 0.13, max: 0.13,
    from: size * 0.8, to: size * 2.4, additive: true,
  });
  // A tiny warm point light only for the biggest muzzle flashes.
  if (size > 0.7) {
    const light = new THREE.PointLight(0xffb15a, 1.4, 8, 2);
    light.position.copy(pos);
    gl.scene.add(light);
    gl.effects.push({ light, life: 0.10, max: 0.10 });
  }
}

function spawnExplosion(gl, pos, size) {
  const flashMat = new THREE.SpriteMaterial({
    map: gl.flashTex, color: 0xffc36a, transparent: true,
    opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flash = new THREE.Sprite(flashMat);
  flash.position.copy(pos);
  flash.position.y += 0.5;
  flash.scale.setScalar(1.2 * size);
  gl.scene.add(flash);
  gl.effects.push({
    sprite: flash, mat: flashMat, life: 0.26, max: 0.26,
    from: 0.8 * size, to: 3.2 * size, additive: true, rise: 0.8,
  });

  for (let i = 0; i < 5; i++) {
    const mat = new THREE.SpriteMaterial({
      map: gl.smokeTex, color: i === 0 ? 0x5a5248 : 0x6c6458,
      transparent: true, opacity: 0.5, depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    const a = (i / 5) * Math.PI * 2 + hash01(i, 3, 5);
    const r = size * (0.35 + hash01(i, 4, 6) * 0.5);
    s.position.set(pos.x + Math.cos(a) * r, pos.y + 0.4 + hash01(i, 8, 2) * 0.7,
      pos.z + Math.sin(a) * r);
    s.scale.setScalar(size * 0.6);
    gl.scene.add(s);
    gl.effects.push({
      sprite: s, mat, life: 0.8 + hash01(i, 9, 4) * 0.7,
      max: 1.5, from: size * 0.55, to: size * (1.4 + hash01(i, 2, 8)),
      opacity: 0.45, rise: 1.2 + hash01(i, 6, 2) * 1.1,
      vx: Math.cos(a) * size * 0.4, vz: Math.sin(a) * size * 0.4,
    });
  }
}

function updateEffects(gl, dt) {
  for (let i = gl.effects.length - 1; i >= 0; i--) {
    const e = gl.effects[i];
    e.life -= dt;
    if (e.life <= 0) {
      if (e.sprite) {
        gl.scene.remove(e.sprite);
        e.mat.dispose();
      }
      if (e.light) gl.scene.remove(e.light);
      gl.effects.splice(i, 1);
      continue;
    }
    const k = 1 - e.life / e.max;
    if (e.sprite) {
      const sc = lerp(e.from, e.to, Math.sqrt(k));
      e.sprite.scale.setScalar(sc);
      e.sprite.position.y += (e.rise || 0) * dt;
      if (e.vx) e.sprite.position.x += e.vx * dt;
      if (e.vz) e.sprite.position.z += e.vz * dt;
      e.mat.opacity = (e.opacity === undefined ? 0.9 : e.opacity) * (1 - k);
    }
    if (e.light) e.light.intensity = 1.4 * (1 - k);
  }
}

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------

function countMeshes(scene) {
  let n = 0;
  scene.traverse((o) => {
    if (o.isMesh || o.isSprite || o.isInstancedMesh) n++;
  });
  return n;
}

export function glFrame(game, dtMs) {
  if (!game) return;
  const st = game.state;
  if (!st || !st.map) return;
  let gl = game.gl;
  if (!gl) {
    try {
      gl = initGl(game);
    } catch (err) {
      if (globalThis.__glErrors) globalThis.__glErrors.push('initGl: ' + err.message);
      return;
    }
  }

  if (gl.map !== st.map || gl.state !== st) {
    // New match (or a different map) on the same renderer. Entity records are
    // always dropped; the terrain/water/scatter are rebuilt only on map swap.
    for (const [, rec] of gl.units) disposeGroup(gl, rec.root);
    for (const [, rec] of gl.structs) disposeGroup(gl, rec.root);
    for (const [, tr] of gl.tracerLines) {
      gl.scene.remove(tr.line); tr.geo.dispose(); tr.mat.dispose();
    }
    for (const e of gl.effects) {
      if (e.sprite) { gl.scene.remove(e.sprite); if (e.mat) e.mat.dispose(); }
      if (e.light) gl.scene.remove(e.light);
    }
    gl.units.clear();
    gl.structs.clear();
    gl.tracerLines.clear();
    gl.effects.length = 0;
    gl.fogTick = -1;
    gl.fogSlot = -1;
    gl.proxy.ready = false;
    gl.localSlot = game.playerSlot || 0;
    if (gl.map !== st.map) {
      gl.map = st.map;
      gl.mapW = st.map.w;
      gl.mapH = st.map.h;
      gl.halfX = gl.mapW * S / 2;
      gl.halfZ = gl.mapH * S / 2;
      rebuildEnvironment(gl);
    }
    gl.state = st;
  }
  gl.state = st;
  gl.localSlot = game.playerSlot || 0;

  const dt = clamp((dtMs || 16.7) / 1000, 0.0004, 0.10);
  gl.time += dt;
  applyCameraProxy(gl);
  updateControls(gl, dt);
  // Keep the fog useful at every zoom level; the intro flyover starts at
  // dist ~340 and would otherwise be entirely hidden by the 320-unit fog.
  if (gl.scene.fog) {
    gl.scene.fog.near = Math.max(70, gl.dist * 0.9);
    gl.scene.fog.far = Math.max(320, gl.dist * 3.2);
  }
  gl.waterUniform.value = gl.time;
  if (gl.foamMat) {
    gl.foamMat.opacity = 0.10 + Math.sin(gl.time * 1.6) * 0.05;
  }

  updateFogTexture(gl);
  syncLegacyFog(game);
  syncStructures(gl, dt, gl.time);
  syncUnits(gl, dt, gl.time);
  syncTracers(gl, dt);
  updateEffects(gl, dt);
  updateSelection(gl);
  updateGhost(gl);

  if (gl.sky) gl.sky.position.set(gl.focus.x, 0, gl.focus.z);

  gl.renderer.render(gl.scene, gl.camera);
  writeCameraProxy(gl);

  // Cheap counters every frame; full mesh count twice a second.
  gl.statT = (gl.statT || 0) + dt;
  gl.stats.units = gl.units.size;
  gl.stats.structures = gl.structs.size;
  gl.stats.tick = st.tick;
  gl.stats.effects = gl.effects.length;
  gl.stats.frame = gl.frameNo || 0;
  if (gl.statT >= 0.5) {
    gl.statT = 0;
    gl.stats.meshes = countMeshes(gl.scene);
  }
  gl.frameNo = (gl.frameNo || 0) + 1;
}
