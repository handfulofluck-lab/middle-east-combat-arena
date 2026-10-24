// In-engine cinematics (v0.11.0). No video files: the menu flyby has its own
// small Three scene/canvas; the match intro and victory/defeat sequences drive
// the real 3D camera and add temporary scene effects. Render-side only.
import { focusGl, setCinematicReveal } from './gl.js';

const CELL = 64;
const S = 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const nowMs = () => (globalThis.performance && globalThis.performance.now)
  ? globalThis.performance.now() : Date.now();

function h01(n) {
  let x = Math.imul(n | 0, 374761393) + 668265263;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function mat(color, opts = {}) {
  const T = globalThis.THREE;
  return new T.MeshStandardMaterial({
    color, roughness: opts.rough === undefined ? 0.82 : opts.rough,
    metalness: opts.metal === undefined ? 0.08 : opts.metal,
    flatShading: !!opts.flat, transparent: !!opts.transparent,
    opacity: opts.opacity === undefined ? 1 : opts.opacity,
    side: opts.side || T.FrontSide,
  });
}

function mesh(parent, geo, material, x, y, z) {
  const T = globalThis.THREE;
  const m = new T.Mesh(geo, material);
  m.position.set(x || 0, y || 0, z || 0);
  parent.add(m);
  return m;
}

function box(parent, w, h, d, material, x, y, z) {
  const T = globalThis.THREE;
  return mesh(parent, new T.BoxGeometry(w, h, d), material, x, y, z);
}

// ---------------------------------------------------------------------------
// init + overlay plumbing
// ---------------------------------------------------------------------------

export function initCinematics(game) {
  if (game.cinema && game.cinema._installed) return game.cinema;
  const cinema = game.cinema || {};
  cinema._installed = true;
  cinema.active = false;
  cinema.kind = null;
  cinema.menu = null;
  cinema.skip = () => skipCinematic(game);
  game.cinema = cinema;

  const overlay = document.getElementById('cinematic');
  if (overlay && overlay.addEventListener) {
    overlay.addEventListener('pointerdown', (e) => {
      if (!cinema.active) return;
      if (e.preventDefault) e.preventDefault();
      skipCinematic(game);
    });
  }
  if (globalThis.addEventListener) {
    globalThis.addEventListener('keydown', (e) => {
      if (!cinema.active) return;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      skipCinematic(game);
    }, true);
  }
  return cinema;
}

function overlayEls() {
  return {
    root: document.getElementById('cinematic'),
    kicker: document.getElementById('cine-kicker'),
    title: document.getElementById('cine-title'),
    sub: document.getElementById('cine-sub'),
    vs: document.getElementById('cine-vs'),
    skip: document.getElementById('cine-skip'),
  };
}

function showOverlay(kind, info) {
  const e = overlayEls();
  if (!e.root) return;
  if (document.body && document.body.classList) document.body.classList.add('cinematic');
  e.root.className = 'show ' + kind;
  if (e.kicker) e.kicker.textContent = info.kicker || '';
  if (e.title) e.title.textContent = info.title || '';
  if (e.sub) e.sub.textContent = info.sub || '';
  if (e.vs) e.vs.textContent = info.vs || '';
  if (e.skip) {
    e.skip.textContent = info.skipText || 'Click or press any key to skip';
    e.skip.className = 'cine-skip';
  }
}

function hideOverlay() {
  const e = overlayEls();
  if (e.root) e.root.className = '';
  if (document.body && document.body.classList) document.body.classList.remove('cinematic');
}

// ---------------------------------------------------------------------------
// camera helpers
// ---------------------------------------------------------------------------

function saveCamera(gl) {
  return {
    fx: gl.focus.x, fz: gl.focus.z,
    yaw: gl.yaw, pitch: gl.pitch, dist: gl.dist,
  };
}

function setCamera(game, fx, fz, dist, yaw, pitch) {
  const gl = game.gl;
  if (!gl) return;
  const wx = (fx / S + gl.mapW / 2) * CELL;
  const wy = (fz / S + gl.mapH / 2) * CELL;
  focusGl(game, wx, wy, dist, yaw, pitch);
}

function restoreCamera(game, cam) {
  if (!cam) return;
  setCamera(game, cam.fx, cam.fz, cam.dist, cam.yaw, cam.pitch);
}

function baseFocus(game) {
  const st = game.state;
  const gl = game.gl;
  const slot = game.playerSlot || 0;
  if (st) {
    for (const id in st.structures) {
      const s = st.structures[id];
      if (s.owner === slot && s.defId === 'SH-01') {
        const cx = s.cx + s.fp / 2;
        const cy = s.cy + s.fp / 2;
        return { fx: (cx - st.map.w / 2) * S, fz: (cy - st.map.h / 2) * S };
      }
    }
    const sp = st.map.spawns[slot % st.map.spawns.length];
    if (sp) {
      return {
        fx: (sp.x + 0.5 - st.map.w / 2) * S,
        fz: (sp.y + 0.5 - st.map.h / 2) * S,
      };
    }
  }
  if (gl) return { fx: gl.focus.x, fz: gl.focus.z };
  return { fx: 0, fz: 0 };
}

function disposeGroup(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material && !o.material.__shared) o.material.dispose();
  });
  if (root.parent) root.parent.remove(root);
}

// ---------------------------------------------------------------------------
// battle intro flyover (4s, skippable)
// ---------------------------------------------------------------------------

export function playIntro(game, info, onDone) {
  const gl = game.gl;
  if (!gl) { if (onDone) onDone(); return; }
  const c = initCinematics(game);
  if (c.active) finishActive(game, true);
  c.active = true;
  c.kind = 'intro';
  c.t = 0;
  c.duration = 4.0; // rendered seconds (main caps dt at 250 ms/frame)
  c.onDone = onDone || null;
  c.normal = saveCamera(gl);
  const span = Math.max(gl.mapW, gl.mapH) * S;
  c.start = {
    fx: 0, fz: 0, dist: Math.min(360, span * 1.05),
    yaw: c.normal.yaw + 2.25, pitch: 1.30,
  };
  c.mid = {
    fx: c.normal.fx + 7, fz: c.normal.fz + 8, dist: 92,
    yaw: c.normal.yaw + 0.85, pitch: 0.92,
  };
  if (typeof setCinematicReveal === 'function') setCinematicReveal(game, true);
  showOverlay('intro', {
    kicker: 'Operation ' + (info.mapName || 'Desert'),
    title: info.faction || 'MCA',
    sub: 'Deployment — ' + (info.mapName || 'Desert'),
    vs: info.vs || '',
    skipText: 'Click or press any key to skip',
  });
  setCamera(game, c.start.fx, c.start.fz, c.start.dist, c.start.yaw, c.start.pitch);
}

function updateIntro(game, dt) {
  const c = game.cinema;
  if (!c || c.kind !== 'intro') return;
  c.t += clamp(dt, 0, 0.5);
  const u = clamp(c.t / c.duration, 0, 1);
  let a, b, k;
  if (u < 0.62) {
    a = c.start; b = c.mid; k = smooth(u / 0.62);
  } else {
    a = c.mid; b = c.normal; k = smooth((u - 0.62) / 0.38);
  }
  setCamera(game,
    lerp(a.fx, b.fx, k), lerp(a.fz, b.fz, k),
    lerp(a.dist, b.dist, k),
    lerp(a.yaw, b.yaw, k), lerp(a.pitch, b.pitch, k));
  if (u >= 1) finishActive(game, false);
}

// ---------------------------------------------------------------------------
// victory / defeat (3s)
// ---------------------------------------------------------------------------

export function playOutro(game, info, onDone) {
  const gl = game.gl;
  if (!gl) { if (onDone) onDone(); return; }
  const c = initCinematics(game);
  if (c.active) finishActive(game, true);
  c.active = true;
  c.kind = 'outro';
  c.t = 0;
  c.duration = 3.0;
  c.onDone = onDone || null;
  c.normal = saveCamera(gl);
  const b = baseFocus(game);
  c.base = b;
  c.won = !!info.won;
  const T = globalThis.THREE;
  const group = new T.Group();
  gl.scene.add(group);
  c.group = group;
  let light;
  if (c.won) {
    light = new T.PointLight(0xffc75a, 2.4, 34, 2);
    light.position.set(b.fx, 4.5, b.fz);
    gl.scene.add(light);
    c.light = light;
    // confetti: one instanced draw call
    const n = 90;
    const geo = new T.BoxGeometry(0.14, 0.34, 0.05);
    const m = new T.MeshBasicMaterial({ color: 0xffffff });
    const im = new T.InstancedMesh(geo, m, n);
    const colors = [new T.Color(0xffd76a), new T.Color(0xfff2c4),
      new T.Color(0xd9a63a), new T.Color(0xffffff)];
    const pieces = [];
    for (let i = 0; i < n; i++) {
      const a = h01(i * 3 + 1) * Math.PI * 2;
      const r = 1 + h01(i * 3 + 2) * 8;
      pieces.push({
        x: b.fx + Math.cos(a) * r, y: 2 + h01(i * 3 + 3) * 8,
        z: b.fz + Math.sin(a) * r,
        vx: (h01(i * 7 + 1) - 0.5) * 2.4,
        vy: 1.0 + h01(i * 7 + 2) * 2.4,
        vz: (h01(i * 7 + 3) - 0.5) * 2.4,
        rot: h01(i * 11 + 1) * 6.28,
        spin: (h01(i * 11 + 2) - 0.5) * 8,
      });
      im.setColorAt(i, colors[i % colors.length]);
    }
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    group.add(im);
    c.confetti = { mesh: im, pieces };
    // expanding gold ring
    const ring = new T.Mesh(
      new T.RingGeometry(4.2, 4.55, 48),
      new T.MeshBasicMaterial({
        color: 0xffe19a, transparent: true, opacity: 0.8,
        side: T.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(b.fx, 0.12, b.fz);
    group.add(ring);
    c.ring = ring;
  } else {
    light = new T.PointLight(0xff4b32, 2.0, 30, 2);
    light.position.set(b.fx, 4, b.fz);
    gl.scene.add(light);
    c.light = light;
    // collapsed ConYard wreck
    const wreck = new T.Group();
    wreck.position.set(b.fx, 0, b.fz);
    group.add(wreck);
    const dark = mat(0x2c2a25, { rough: 0.95 });
    const char = mat(0x171614, { rough: 1 });
    const rubble = mat(0x4a463d, { rough: 1, flat: true });
    box(wreck, 6.4, 0.7, 6.4, char, 0, 0.35, 0);
    const slab = box(wreck, 4.2, 1.0, 3.4, dark, -0.4, 0.9, 0.3);
    slab.rotation.z = 0.22;
    const slab2 = box(wreck, 3.2, 1.2, 3.2, dark, 1.0, 0.8, -0.6);
    slab2.rotation.x = -0.25;
    for (let i = 0; i < 9; i++) {
      const r = mesh(wreck, new T.DodecahedronGeometry(0.45, 0), rubble,
        (h01(i + 40) - 0.5) * 7, 0.3 + h01(i + 41) * 0.5,
        (h01(i + 42) - 0.5) * 7);
      r.scale.set(0.7 + h01(i + 43), 0.5 + h01(i + 44), 0.7 + h01(i + 45));
    }
    c.smoke = [];
    if (gl.smokeTex) {
      for (let i = 0; i < 8; i++) {
        const sm = new T.SpriteMaterial({
          map: gl.smokeTex, color: 0x2e2b27, transparent: true,
          opacity: 0.45, depthWrite: false,
        });
        const spr = new T.Sprite(sm);
        spr.position.set((h01(i + 60) - 0.5) * 5, 1 + h01(i + 61) * 2.5,
          (h01(i + 62) - 0.5) * 5);
        spr.scale.setScalar(1 + h01(i + 63) * 2);
        wreck.add(spr);
        c.smoke.push({ spr, mat: sm, phase: h01(i + 64) });
      }
    }
    // dark red ground wash
    const wash = new T.Mesh(
      new T.CircleGeometry(7, 24),
      new T.MeshBasicMaterial({
        color: 0x4a0d08, transparent: true, opacity: 0.35, depthWrite: false,
      }),
    );
    wash.rotation.x = -Math.PI / 2;
    wash.position.set(b.fx, 0.08, b.fz);
    group.add(wash);
  }
  showOverlay(c.won ? 'victory' : 'defeat', {
    kicker: 'Operation ' + (info.mapName || 'Desert'),
    title: c.won ? 'Victory' : 'Defeat',
    sub: c.won ? (info.faction || '') + ' holds the field'
      : (info.faction || '') + ' command collapsed',
    vs: '',
    skipText: 'Click or press any key to continue',
  });
  setCamera(game, b.fx, b.fz, 38, c.normal.yaw, 0.52);
}

function updateOutro(game, dt) {
  const c = game.cinema;
  if (!c || c.kind !== 'outro') return;
  c.t += clamp(dt, 0, 0.5);
  const u = clamp(c.t / c.duration, 0, 1);
  const yaw = c.normal.yaw + u * 2.6;
  const dist = c.won ? lerp(40, 30, u) : lerp(38, 28, u);
  setCamera(game, c.base.fx, c.base.fz, dist, yaw, 0.52);
  if (c.light) {
    c.light.intensity = (c.won ? 2.0 : 1.6) + Math.sin(c.t * 7) * (c.won ? 0.8 : 0.5);
  }
  if (c.confetti) {
    const T = globalThis.THREE;
    const o = new T.Object3D();
    const pieces = c.confetti.pieces;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vy -= 2.6 * dt;
      p.rot += p.spin * dt;
      if (p.y < 0.15) { p.y = 0.15; p.vy *= -0.25; }
      o.position.set(p.x, p.y, p.z);
      o.rotation.set(p.rot, p.rot * 0.7, p.rot * 0.3);
      o.scale.setScalar(1 - u * 0.25);
      o.updateMatrix();
      c.confetti.mesh.setMatrixAt(i, o.matrix);
    }
    c.confetti.mesh.instanceMatrix.needsUpdate = true;
  }
  if (c.ring) {
    const s = 1 + u * 2.2;
    c.ring.scale.setScalar(s);
    c.ring.material.opacity = 0.8 * (1 - u);
  }
  if (c.smoke) {
    for (const s of c.smoke) {
      s.spr.position.y += dt * 0.7;
      s.spr.scale.setScalar(1.4 + u * 2.2 + s.phase);
      s.mat.opacity = 0.40 * (1 - u);
    }
  }
  if (u >= 1) finishActive(game, false);
}

function finishActive(game, silent) {
  const c = game.cinema;
  if (!c || !c.active) return;
  const done = c.onDone;
  if (typeof setCinematicReveal === 'function') setCinematicReveal(game, false);
  restoreCamera(game, c.normal);
  if (c.group) disposeGroup(c.group);
  if (c.light && c.light.parent) c.light.parent.remove(c.light);
  c.group = null;
  c.light = null;
  c.confetti = null;
  c.ring = null;
  c.smoke = null;
  c.active = false;
  c.kind = null;
  c.onDone = null;
  hideOverlay();
  if (!silent && done) done();
}

export function skipCinematic(game) {
  if (game && game.cinema && game.cinema.active) finishActive(game, false);
}

// Drop a running intro/outro without firing its completion callback (used when
// a match is restarted/abandoned before the sequence ends).
export function cancelCinematics(game) {
  if (game && game.cinema && game.cinema.active) finishActive(game, true);
}

export function isCinematicActive(game) {
  return !!(game && game.cinema && game.cinema.active);
}

// ---------------------------------------------------------------------------
// menu flyby (separate small scene/canvas behind the menu)
// ---------------------------------------------------------------------------

function menuMat(color, opts) { return mat(color, opts); }

function buildMenuTank(accentHex) {
  const T = globalThis.THREE;
  const g = new T.Group();
  const body = menuMat(0x7f7757, { rough: 0.8, metal: 0.2 });
  const dark = menuMat(0x24251f, { rough: 0.95 });
  const steel = menuMat(0x60625a, { rough: 0.45, metal: 0.6 });
  const accent = menuMat(accentHex, { rough: 0.5 });
  const shadow = new T.Mesh(
    new T.CircleGeometry(2.35, 18),
    new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28,
      depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.035;
  g.add(shadow);
  box(g, 3.1, 0.55, 1.7, body, 0, 0.55, 0);
  box(g, 2.9, 0.22, 0.28, dark, 0, 0.28, 0.78);
  box(g, 2.9, 0.22, 0.28, dark, 0, 0.28, -0.78);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const w = mesh(g, new T.CylinderGeometry(0.22, 0.22, 0.10, 10), dark,
        -1.05 + i * 0.42, 0.28, side * 0.92);
      w.rotation.x = Math.PI / 2;
    }
  }
  const turret = new T.Group();
  turret.position.set(-0.05, 0.85, 0);
  g.add(turret);
  box(turret, 1.25, 0.36, 1.0, body, 0, 0.12, 0);
  box(turret, 0.55, 0.12, 0.22, accent, 0, 0.10, 0.52);
  box(turret, 0.55, 0.12, 0.22, accent, 0, 0.10, -0.52);
  const barrel = mesh(turret, new T.CylinderGeometry(0.075, 0.09, 1.7, 8), steel, 1.2, 0.15, 0);
  barrel.rotation.z = -Math.PI / 2;
  box(turret, 0.22, 0.16, 0.18, steel, -0.65, 0.30, 0.20);
  return g;
}

function buildMenuJet() {
  const T = globalThis.THREE;
  const g = new T.Group();
  const body = menuMat(0x7c8272, { rough: 0.5, metal: 0.5 });
  const dark = menuMat(0x30332e, { rough: 0.6 });
  const glass = menuMat(0x2c4b55, { rough: 0.1, metal: 0.8 });
  const fus = mesh(g, new T.CylinderGeometry(0.28, 0.34, 3.6, 10), body, 0, 0, 0);
  fus.rotation.z = Math.PI / 2;
  const nose = mesh(g, new T.ConeGeometry(0.30, 1.2, 10), body, 2.25, 0, 0);
  nose.rotation.z = -Math.PI / 2;
  const canopy = mesh(g, new T.SphereGeometry(0.31, 10, 6), glass, 0.85, 0.26, 0);
  canopy.scale.set(1.7, 0.75, 0.75);
  for (const side of [-1, 1]) {
    const wing = box(g, 2.1, 0.08, 1.45, body, -0.25, 0, side * 1.1);
    wing.rotation.y = side * 0.42;
    box(g, 0.95, 0.07, 0.90, body, -1.55, 0.42, side * 0.55);
    box(g, 0.9, 0.24, 0.3, dark, 0.35, -0.24, side * 0.42);
  }
  box(g, 0.7, 0.55, 0.08, dark, -2.0, 0.35, 0);
  return g;
}

function createMenuScene(game) {
  const T = globalThis.THREE;
  if (!T) return null;
  const canvas = document.getElementById('menu-3d');
  if (!canvas) return null;
  let renderer;
  try {
    renderer = new T.WebGLRenderer({
      canvas, antialias: true, alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: !!globalThis.navigator.webdriver,
    });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
  renderer.setSize(globalThis.innerWidth || 1280, globalThis.innerHeight || 720, false);
  renderer.outputEncoding = T.LinearEncoding;
  renderer.toneMapping = T.NoToneMapping;

  const scene = new T.Scene();
  scene.background = new T.Color(0xaebfc2);
  scene.fog = new T.Fog(0xd8c7a0, 45, 170);
  const camera = new T.PerspectiveCamera(48,
    (globalThis.innerWidth || 1280) / (globalThis.innerHeight || 720), 0.1, 700);

  scene.add(new T.HemisphereLight(0xe6eef2, 0x9a8252, 0.72));
  const sun = new T.DirectionalLight(0xffe8c2, 1.7);
  sun.position.set(30, 60, 20);
  scene.add(sun);
  const sky = new T.Mesh(
    new T.SphereGeometry(420, 24, 12),
    new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new T.Color(0x3b6484) },
        horizon: { value: new T.Color(0xe7cd9a) },
        sunDir: { value: new T.Vector3(0.45, 0.35, 0.25).normalize() },
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
          vec3 c = mix(horizon, top, pow(clamp(d.y, 0.0, 1.0), 0.66));
          float s = pow(max(dot(d, normalize(sunDir)), 0.0), 160.0);
          c += vec3(1.0, 0.88, 0.62) * s * 0.6;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    }),
  );
  scene.add(sky);

  // dunes
  const geo = new T.PlaneGeometry(260, 260, 36, 36);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const sand = new T.Color(0xc2a86c);
  const dark = new T.Color(0x8a7248);
  const pale = new T.Color(0xe2ca8f);
  const c = new T.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = Math.sin(x * 0.05 + Math.sin(z * 0.04) * 2) * 0.9
      + Math.sin(z * 0.08) * 0.45 + Math.sin((x + z) * 0.17) * 0.25;
    pos.setY(i, h);
    const d = clamp((h + 1.6) / 3.2, 0, 1);
    c.copy(dark).lerp(sand, 0.35 + d * 0.4).lerp(pale, Math.max(0, d - 0.7) * 0.8);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new T.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const ground = new T.Mesh(geo, new T.MeshStandardMaterial({
    vertexColors: true, roughness: 0.98, metalness: 0,
  }));
  scene.add(ground);

  // rock outcrops
  const rockGeo = new T.DodecahedronGeometry(1, 0);
  const rockMat = menuMat(0x746f63, { rough: 0.95, flat: true });
  const rocks = new T.InstancedMesh(rockGeo, rockMat, 42);
  const o = new T.Object3D();
  for (let i = 0; i < 42; i++) {
    const a = h01(i + 1) * 6.28;
    const r = 18 + h01(i + 2) * 80;
    o.position.set(Math.cos(a) * r, 0.2 + h01(i + 3) * 0.4, Math.sin(a) * r);
    o.rotation.set(h01(i + 4) * 2, h01(i + 5) * 6, h01(i + 6) * 2);
    o.scale.set(0.6 + h01(i + 7) * 2.2, 0.5 + h01(i + 8) * 1.8, 0.6 + h01(i + 9) * 2.2);
    o.updateMatrix();
    rocks.setMatrixAt(i, o.matrix);
  }
  rocks.castShadow = false;
  scene.add(rocks);

  // two tanks circling the arena, plus a jet flyover
  const tanks = [];
  for (const [accent, phase] of [[0xc8a23a, 0], [0x8a8f7e, 2.6]]) {
    const g = buildMenuTank(accent);
    g.scale.setScalar(1.6);
    scene.add(g);
    tanks.push({ g, phase });
  }
  const jet = buildMenuJet();
  jet.scale.setScalar(1.8);
  scene.add(jet);

  return {
    canvas, renderer, scene, camera, t: 0, active: false,
    tanks, jet, failed: false, w: 0, h: 0,
  };
}

export function startMenuCinematic(game) {
  if (!game || game.gfx !== '3d') return false;
  const c = initCinematics(game);
  if (!c.menu) c.menu = createMenuScene(game);
  const m = c.menu;
  if (!m || m.failed) return false;
  m.active = true;
  m.canvas.style.display = 'block';
  if (document.body && document.body.classList) document.body.classList.add('menu-3d');
  resizeMenu(m, globalThis.innerWidth || 1280, globalThis.innerHeight || 720);
  return true;
}

export function stopMenuCinematic(game) {
  const c = game && game.cinema;
  if (!c || !c.menu) return;
  c.menu.active = false;
  if (c.menu.canvas) c.menu.canvas.style.display = 'none';
  if (document.body && document.body.classList) document.body.classList.remove('menu-3d');
}

function resizeMenu(m, w, h) {
  if (!m || !m.renderer) return;
  if (m.w === w && m.h === h) return;
  m.w = w; m.h = h;
  m.renderer.setSize(w, h, false);
  m.camera.aspect = w / Math.max(1, h);
  m.camera.updateProjectionMatrix();
}

function updateMenu(game, dt) {
  const c = game.cinema;
  const m = c && c.menu;
  if (!m || !m.active) return;
  const w = globalThis.innerWidth || 1280;
  const h = globalThis.innerHeight || 720;
  resizeMenu(m, w, h);
  const dtS = clamp(dt, 0, 100) / 1000;
  m.t += dtS;
  const t = m.t;
  m.camera.position.set(Math.sin(t * 0.055) * 38, 12.5 + Math.sin(t * 0.09) * 2.2,
    Math.cos(t * 0.055) * 38);
  m.camera.lookAt(0, 2.0, 0);
  for (const tk of m.tanks) {
    const a = t * 0.11 + tk.phase;
    const x = Math.cos(a) * 16;
    const z = Math.sin(a) * 16;
    const h = Math.sin(x * 0.05 + Math.sin(z * 0.04) * 2) * 0.9
      + Math.sin(z * 0.08) * 0.45 + Math.sin((x + z) * 0.17) * 0.25;
    tk.g.position.set(x, h + 0.04, z);
    tk.g.rotation.y = Math.atan2(-Math.cos(a), -Math.sin(a));
  }
  const jp = ((t + 4.0) % 11) / 11;
  m.jet.visible = jp > 0.03 && jp < 0.97;
  m.jet.position.set(-60 + jp * 120, 7.5 + Math.sin(t * 0.8) * 0.8, -10);
  m.jet.rotation.z = Math.sin(t * 0.8) * 0.04;
  m.renderer.render(m.scene, m.camera);
}

// ---------------------------------------------------------------------------
// frame driver
// ---------------------------------------------------------------------------

export function updateCinematics(game, dtMs) {
  const c = game && game.cinema;
  if (!c) return;
  if (c.menu && c.menu.active) updateMenu(game, dtMs);
  if (!c.active) return;
  if (c.kind === 'intro') updateIntro(game, dtMs / 1000);
  else if (c.kind === 'outro') updateOutro(game, dtMs / 1000);
}
