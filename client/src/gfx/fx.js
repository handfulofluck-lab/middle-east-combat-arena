// Effects: one stateless GPU particle system (a single draw call for every
// spark, fireball, smoke puff and tracer in the scene), ground decals
// (scorch marks, shockwaves, order pings), a small pool of flash lights and a
// timeline for delayed effects. Particles are simulated in the vertex shader
// from their spawn parameters, so the CPU only writes a particle once.
import * as THREE from 'three';
import { clamp, WATER_Y } from './util.js';

const FRAMES = { glow: 0, smoke: 1, spark: 2, flare: 3, ring: 4, debris: 5, dust: 6, fire: 7 };

function makeAtlas() {
  const cell = 128, cols = 4, rows = 2;
  const cv = document.createElement('canvas');
  cv.width = cell * cols; cv.height = cell * rows;
  const g = cv.getContext('2d');
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const at = (i) => [(i % cols) * cell + cell / 2, Math.floor(i / cols) * cell + cell / 2];
  const blob = (cx, cy, r, a) => {
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    gr.addColorStop(0, `rgba(255,255,255,${a})`);
    gr.addColorStop(0.5, `rgba(255,255,255,${a * 0.45})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  };
  // 0 glow
  { const [x, y] = at(0); blob(x, y, 62, 1); blob(x, y, 30, 0.8); }
  // 1 smoke: lumpy puff
  { const [x, y] = at(1);
    for (let i = 0; i < 22; i++) {
      const a = rnd() * 6.28, d = rnd() * 26;
      blob(x + Math.cos(a) * d, y + Math.sin(a) * d, 16 + rnd() * 20, 0.34);
    } }
  // 2 spark: horizontal streak
  { const [x, y] = at(2);
    g.save(); g.translate(x, y); g.scale(1, 0.14); blob(0, 0, 60, 1); blob(0, 0, 40, 1); g.restore(); }
  // 3 flare: four-point star
  { const [x, y] = at(3); blob(x, y, 26, 1);
    g.save(); g.translate(x, y);
    for (let i = 0; i < 2; i++) { g.save(); g.rotate(i * Math.PI / 2); g.scale(1, 0.07); blob(0, 0, 62, 1); g.restore(); }
    g.restore(); }
  // 4 ring
  { const [x, y] = at(4);
    for (let i = 0; i < 12; i++) {
      g.strokeStyle = `rgba(255,255,255,${0.05 + (i / 12) * 0.12})`;
      g.lineWidth = 14 - i;
      g.beginPath(); g.arc(x, y, 48, 0, Math.PI * 2); g.stroke();
    } }
  // 5 debris: jagged chip
  { const [x, y] = at(5); g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath();
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * 6.28, r = 22 + rnd() * 26;
      if (i === 0) g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    g.closePath(); g.fill(); }
  // 6 dust: wide and wispy
  { const [x, y] = at(6);
    for (let i = 0; i < 30; i++) {
      const a = rnd() * 6.28, d = rnd() * 34;
      blob(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8, 12 + rnd() * 16, 0.2);
    } }
  // 7 fire: hot core with ragged edge
  { const [x, y] = at(7);
    for (let i = 0; i < 16; i++) {
      const a = rnd() * 6.28, d = rnd() * 22;
      blob(x + Math.cos(a) * d, y + Math.sin(a) * d, 14 + rnd() * 18, 0.5);
    }
    blob(x, y, 30, 1); }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

const ATLAS_GLSL = /* glsl */`
  vec2 atlasUv(vec2 uv, float frame) {
    float col = mod(frame, 4.0), row = floor(frame / 4.0);
    return vec2((col + uv.x) / 4.0, 1.0 - (row + 1.0 - uv.y) / 2.0);
  }`;

export function createFx(gl) {
  const scene = gl.scene;
  const atlas = makeAtlas();
  const MAX = Math.round(14000 * gl.quality.particles);
  const rate = gl.quality.particles;

  // ---- particles ----------------------------------------------------------
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  quad.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const mk = (n) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * n), n);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  const aPos = mk(3), aVel = mk(3), aTime = mk(2), aSize = mk(2);
  const aCol = mk(4), aCol2 = mk(4), aMisc = mk(4), aFrame = mk(3);
  quad.setAttribute('aPos', aPos); quad.setAttribute('aVel', aVel);
  quad.setAttribute('aTime', aTime); quad.setAttribute('aSize', aSize);
  quad.setAttribute('aCol', aCol); quad.setAttribute('aCol2', aCol2);
  quad.setAttribute('aMisc', aMisc); quad.setAttribute('aFrame', aFrame);
  quad.instanceCount = MAX;
  for (let i = 0; i < MAX; i++) aTime.array[i * 2] = -1e6, aTime.array[i * 2 + 1] = 1;

  const pMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uTime: { value: 0 }, uAtlas: { value: atlas },
      uLight: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: /* glsl */`
      attribute vec3 aPos, aVel, aFrame;
      attribute vec2 aTime, aSize;
      attribute vec4 aCol, aCol2, aMisc;
      uniform float uTime;
      varying vec2 vUv; varying vec4 vCol; varying float vFrame; varying float vAdd;
      void main() {
        float age = uTime - aTime.x;
        float t = age / aTime.y;
        if (t < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        float drag = aMisc.y;
        float k = drag > 0.001 ? (1.0 - exp(-drag * age)) / drag : age;
        vec3 p = aPos + aVel * k;
        p.y += aMisc.x * age * age * 0.5;
        float size = mix(aSize.x, aSize.y, 1.0 - (1.0 - t) * (1.0 - t));
        vec4 mv = viewMatrix * vec4(p, 1.0);
        vec2 c = position.xy;
        float stretch = aFrame.y;
        if (stretch > 0.0) {
          vec3 vel = aVel * exp(-drag * age) + vec3(0.0, aMisc.x * age, 0.0);
          vec2 dir = (viewMatrix * vec4(vel, 0.0)).xy;
          float l = length(dir);
          dir = l > 0.0001 ? dir / l : vec2(1.0, 0.0);
          vec2 nrm = vec2(-dir.y, dir.x);
          mv.xy += dir * c.x * size * stretch + nrm * c.y * size;
        } else {
          float a = aMisc.z + aMisc.w * age;
          float cs = cos(a), sn = sin(a);
          mv.xy += vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
        }
        gl_Position = projectionMatrix * mv;
        vUv = uv; vFrame = aFrame.x; vAdd = aFrame.z;
        vCol = mix(aCol, aCol2, t);
        float fadeIn = smoothstep(0.0, 0.06 + 0.1 * (1.0 - vAdd), t);
        float fadeOut = 1.0 - smoothstep(0.45, 1.0, t);
        vCol.a *= fadeIn * fadeOut;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D uAtlas; uniform vec3 uLight;
      varying vec2 vUv; varying vec4 vCol; varying float vFrame; varying float vAdd;
      ${ATLAS_GLSL}
      void main() {
        float m = texture2D(uAtlas, atlasUv(vUv, vFrame)).a;
        float a = m * vCol.a;
        if (a < 0.003) discard;
        vec3 rgb = vCol.rgb * mix(uLight, vec3(1.0), vAdd);
        gl_FragColor = vec4(rgb * a, a * (1.0 - vAdd));
      }`,
  });
  const points = new THREE.Mesh(quad, pMat);
  points.frustumCulled = false;
  points.renderOrder = 20;
  scene.add(points);

  let head = 0, dirtyLo = MAX, dirtyHi = -1, wrapped = false;
  let now = 0;
  // o: {x,y,z,vx,vy,vz,life,s0,s1,c:[r,g,b,a],c2,grav,drag,rot,spin,frame,stretch,add,delay}
  function emit(o) {
    const i = head;
    head = (head + 1) % MAX;
    if (head === 0) wrapped = true;
    if (i < dirtyLo) dirtyLo = i;
    if (i > dirtyHi) dirtyHi = i;
    aPos.array[i * 3] = o.x; aPos.array[i * 3 + 1] = o.y; aPos.array[i * 3 + 2] = o.z;
    aVel.array[i * 3] = o.vx || 0; aVel.array[i * 3 + 1] = o.vy || 0; aVel.array[i * 3 + 2] = o.vz || 0;
    aTime.array[i * 2] = now + (o.delay || 0); aTime.array[i * 2 + 1] = o.life;
    aSize.array[i * 2] = o.s0; aSize.array[i * 2 + 1] = o.s1 !== undefined ? o.s1 : o.s0;
    const c = o.c, c2 = o.c2 || o.c;
    aCol.array[i * 4] = c[0]; aCol.array[i * 4 + 1] = c[1]; aCol.array[i * 4 + 2] = c[2]; aCol.array[i * 4 + 3] = c[3];
    aCol2.array[i * 4] = c2[0]; aCol2.array[i * 4 + 1] = c2[1]; aCol2.array[i * 4 + 2] = c2[2]; aCol2.array[i * 4 + 3] = c2[3];
    aMisc.array[i * 4] = o.grav || 0; aMisc.array[i * 4 + 1] = o.drag || 0;
    aMisc.array[i * 4 + 2] = o.rot || 0; aMisc.array[i * 4 + 3] = o.spin || 0;
    aFrame.array[i * 3] = o.frame; aFrame.array[i * 3 + 1] = o.stretch || 0; aFrame.array[i * 3 + 2] = o.add ? 1 : 0;
  }
  function flush() {
    if (dirtyHi < 0) return;
    const attrs = [aPos, aVel, aTime, aSize, aCol, aCol2, aMisc, aFrame];
    for (const a of attrs) {
      a.clearUpdateRanges();
      if (!wrapped) a.addUpdateRange(dirtyLo * a.itemSize, (dirtyHi - dirtyLo + 1) * a.itemSize);
      a.needsUpdate = true;
    }
    dirtyLo = MAX; dirtyHi = -1; wrapped = false;
  }

  // ---- decals -------------------------------------------------------------
  const DMAX = gl.quality.decals;
  const dq = new THREE.InstancedBufferGeometry();
  dq.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]), 3));
  dq.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  dq.setIndex([0, 2, 1, 0, 3, 2]);
  const dk = (n) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(DMAX * n), n);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  const dPos = dk(4), dNrm = dk(3), dTime = dk(2), dSize = dk(2), dCol = dk(4), dFrame = dk(2);
  dq.setAttribute('aPos', dPos); dq.setAttribute('aNrm', dNrm); dq.setAttribute('aTime', dTime);
  dq.setAttribute('aSize', dSize); dq.setAttribute('aCol', dCol); dq.setAttribute('aFrame', dFrame);
  dq.instanceCount = DMAX;
  for (let i = 0; i < DMAX; i++) dTime.array[i * 2] = -1e6, dTime.array[i * 2 + 1] = 1;
  const dMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { uTime: { value: 0 }, uAtlas: { value: atlas } },
    vertexShader: /* glsl */`
      attribute vec4 aPos, aCol; attribute vec3 aNrm; attribute vec2 aTime, aSize, aFrame;
      uniform float uTime;
      varying vec2 vUv; varying vec4 vCol; varying float vFrame; varying float vAdd;
      void main() {
        float age = uTime - aTime.x;
        float t = age / aTime.y;
        if (t < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        float size = mix(aSize.x, aSize.y, 1.0 - (1.0 - t) * (1.0 - t));
        vec3 n = normalize(aNrm);
        vec3 tx = normalize(cross(vec3(0.0, 0.0, 1.0), n));
        vec3 tz = cross(n, tx);
        float cs = cos(aPos.w), sn = sin(aPos.w);
        vec2 q = vec2(position.x * cs - position.z * sn, position.x * sn + position.z * cs) * size;
        vec3 p = aPos.xyz + tx * q.x + tz * q.y + n * 0.04;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        vUv = uv; vFrame = aFrame.x; vAdd = aFrame.y;
        vCol = aCol;
        vCol.a *= smoothstep(0.0, 0.03, t) * (1.0 - smoothstep(0.6, 1.0, t));
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D uAtlas;
      varying vec2 vUv; varying vec4 vCol; varying float vFrame; varying float vAdd;
      ${ATLAS_GLSL}
      void main() {
        float m = texture2D(uAtlas, atlasUv(vUv, vFrame)).a;
        float a = clamp(m * vCol.a, 0.0, 1.0);
        if (a < 0.004) discard;
        gl_FragColor = vec4(vCol.rgb * a, a * (1.0 - vAdd));
      }`,
  });
  const decals = new THREE.Mesh(dq, dMat);
  decals.frustumCulled = false;
  decals.renderOrder = 5;
  scene.add(decals);
  let dHead = 0, dDirty = false;
  const _n = new THREE.Vector3();
  // o: {x,z,y?,rot,s0,s1,life,c:[r,g,b,a],frame,add,delay}
  function decal(o) {
    const i = dHead; dHead = (dHead + 1) % DMAX; dDirty = true;
    const hf = gl.hf;
    const y = o.y !== undefined ? o.y : Math.max(WATER_Y, hf.heightAt(o.x, o.z));
    hf.normalAt(o.x, o.z, _n);
    if (y <= WATER_Y + 0.001) _n.set(0, 1, 0);
    dPos.array[i * 4] = o.x; dPos.array[i * 4 + 1] = y; dPos.array[i * 4 + 2] = o.z; dPos.array[i * 4 + 3] = o.rot || 0;
    dNrm.array[i * 3] = _n.x; dNrm.array[i * 3 + 1] = _n.y; dNrm.array[i * 3 + 2] = _n.z;
    dTime.array[i * 2] = now + (o.delay || 0); dTime.array[i * 2 + 1] = o.life;
    dSize.array[i * 2] = o.s0; dSize.array[i * 2 + 1] = o.s1 !== undefined ? o.s1 : o.s0;
    dCol.array[i * 4] = o.c[0]; dCol.array[i * 4 + 1] = o.c[1]; dCol.array[i * 4 + 2] = o.c[2]; dCol.array[i * 4 + 3] = o.c[3];
    dFrame.array[i * 2] = o.frame; dFrame.array[i * 2 + 1] = o.add ? 1 : 0;
  }

  // ---- flash lights -------------------------------------------------------
  const lights = [];
  for (let i = 0; i < 4; i++) {
    const l = new THREE.PointLight(0xffb060, 0, 30, 2);
    l.userData = { life: 0, max: 1, peak: 0 };
    scene.add(l);
    lights.push(l);
  }
  function flash(x, y, z, color, intensity, dist, life) {
    let best = lights[0];
    for (const l of lights) if (l.userData.life < best.userData.life) best = l;
    best.position.set(x, y, z);
    best.color.set(color);
    best.distance = dist;
    best.userData.life = life; best.userData.max = life; best.userData.peak = intensity;
  }

  // ---- timeline -----------------------------------------------------------
  const timeline = [];
  function after(delay, fn) { timeline.push({ at: now + delay, fn }); }

  // ---- helpers ------------------------------------------------------------
  let rs = 987654321;
  const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
  const rr = (a, b) => a + (b - a) * rnd();
  const many = (n) => Math.max(1, Math.round(n * rate));

  const SMOKE_DARK = [0.09, 0.085, 0.08, 0.85], SMOKE_GREY = [0.34, 0.32, 0.3, 0.55];
  const DUST = () => {
    const b = gl.look ? gl.look.biome.sandA : 0xd9b27c;
    return [((b >> 16) & 255) / 255 * 0.9, ((b >> 8) & 255) / 255 * 0.86, (b & 255) / 255 * 0.8, 0.5];
  };

  function dust(x, y, z, amount, spread, up) {
    const c = DUST();
    const n = many(amount);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, sp = rr(0.2, 1) * (spread || 1);
      emit({
        x: x + Math.cos(a) * 0.2, y: y + 0.08, z: z + Math.sin(a) * 0.2,
        vx: Math.cos(a) * sp, vy: rr(0.15, 0.7) * (up || 1), vz: Math.sin(a) * sp,
        life: rr(0.9, 2.0), s0: rr(0.3, 0.6), s1: rr(1.3, 2.6),
        c: [c[0], c[1], c[2], rr(0.16, 0.34)], c2: [c[0], c[1], c[2], 0],
        drag: 1.6, grav: 0.1, rot: rnd() * 6.28, spin: rr(-0.5, 0.5), frame: FRAMES.dust,
      });
    }
  }

  function smokePuff(x, y, z, size, dark, life, vx, vy, vz) {
    const c = dark ? SMOKE_DARK : SMOKE_GREY;
    emit({
      x, y, z, vx: (vx || 0) + rr(-0.25, 0.25), vy: vy !== undefined ? vy : rr(0.6, 1.3), vz: (vz || 0) + rr(-0.25, 0.25),
      life: life || rr(1.6, 3.0), s0: size * rr(0.5, 0.8), s1: size * rr(1.8, 2.8),
      c: [c[0], c[1], c[2], c[3] * rr(0.6, 1)], c2: [c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0],
      drag: 0.7, grav: 0.25, rot: rnd() * 6.28, spin: rr(-0.6, 0.6), frame: FRAMES.smoke,
    });
  }

  function fire(x, y, z, size, life) {
    emit({
      x: x + rr(-0.1, 0.1) * size, y, z: z + rr(-0.1, 0.1) * size,
      vx: rr(-0.2, 0.2), vy: rr(0.8, 1.8) * size, vz: rr(-0.2, 0.2),
      life: life || rr(0.35, 0.7), s0: size * rr(0.55, 0.9), s1: size * 0.2,
      c: [3.6, 1.7, 0.45, 0.9], c2: [1.6, 0.25, 0.03, 0],
      drag: 0.5, rot: rnd() * 6.28, spin: rr(-2, 2), frame: FRAMES.fire, add: true,
    });
  }

  function sparks(x, y, z, n, speed, size, color) {
    const cnt = many(n);
    for (let i = 0; i < cnt; i++) {
      const a = rnd() * 6.283, el = rr(0.15, 1.35);
      const sp = speed * rr(0.35, 1);
      emit({
        x, y, z, vx: Math.cos(a) * Math.cos(el) * sp, vy: Math.sin(el) * sp, vz: Math.sin(a) * Math.cos(el) * sp,
        life: rr(0.3, 0.9), s0: size * rr(0.5, 1), s1: size * 0.3,
        c: color || [4.5, 2.6, 0.9, 1], c2: [2.0, 0.5, 0.05, 0],
        grav: -11, drag: 0.6, frame: FRAMES.spark, stretch: 4.5, add: true,
      });
    }
  }

  function debris(x, y, z, n, speed, size) {
    const cnt = many(n);
    for (let i = 0; i < cnt; i++) {
      const a = rnd() * 6.283, el = rr(0.5, 1.4), sp = speed * rr(0.4, 1);
      const g = rr(0.03, 0.14);
      emit({
        x, y, z, vx: Math.cos(a) * Math.cos(el) * sp, vy: Math.sin(el) * sp, vz: Math.sin(a) * Math.cos(el) * sp,
        life: rr(0.7, 1.5), s0: size * rr(0.5, 1.2), s1: size * 0.5,
        c: [g, g * 0.9, g * 0.8, 1], c2: [g, g, g, 0.6],
        grav: -13, drag: 0.25, rot: rnd() * 6.28, spin: rr(-14, 14), frame: FRAMES.debris,
      });
    }
  }

  // size ~ 1 small arms hit, 2 tank shell, 3.5 vehicle death, 6 building, 10+ superweapon
  function explosion(x, y, z, size, kind) {
    const onWater = kind === 'water' || (y <= WATER_Y + 0.05 && gl.hf && gl.hf.heightAt(x, z) < WATER_Y - 0.1);
    const air = kind === 'air';
    const s = size;
    // core flash
    emit({ x, y: y + 0.2 * s, z, life: 0.12 + 0.02 * s, s0: s * 1.6, s1: s * 3.4, c: [9, 6.5, 3.2, 1], c2: [5, 2, 0.4, 0], frame: FRAMES.glow, add: true });
    emit({ x, y: y + 0.2 * s, z, life: 0.2, s0: s * 2.2, s1: s * 3.2, c: [6, 4.4, 2.2, 0.9], c2: [3, 1, 0.2, 0], frame: FRAMES.flare, add: true, rot: rnd() * 3 });
    // fireball
    const nf = many(4 + s * 3);
    for (let i = 0; i < nf; i++) {
      const a = rnd() * 6.283, el = rr(0.1, 1.4), sp = rr(0.4, 1.6) * s;
      emit({
        x: x + Math.cos(a) * 0.15 * s, y: y + 0.15 * s, z: z + Math.sin(a) * 0.15 * s,
        vx: Math.cos(a) * Math.cos(el) * sp, vy: Math.sin(el) * sp * 1.1 + 0.6, vz: Math.sin(a) * Math.cos(el) * sp,
        life: rr(0.35, 0.75) + s * 0.03, s0: s * rr(0.5, 0.9), s1: s * rr(1.1, 1.8),
        c: [4.6, 2.2, 0.55, 0.95], c2: [0.9, 0.12, 0.02, 0],
        drag: 2.2, rot: rnd() * 6.28, spin: rr(-1.5, 1.5), frame: FRAMES.fire, add: true,
      });
    }
    // smoke
    const ns = many(3 + s * 2.2);
    for (let i = 0; i < ns; i++) {
      const a = rnd() * 6.283, sp = rr(0.2, 0.9) * s;
      emit({
        x: x + Math.cos(a) * 0.2 * s, y: y + rr(0.1, 0.5) * s, z: z + Math.sin(a) * 0.2 * s,
        vx: Math.cos(a) * sp, vy: rr(0.8, 2.2) * (0.6 + s * 0.25), vz: Math.sin(a) * sp,
        life: rr(1.6, 3.2) + s * 0.25, s0: s * rr(0.6, 1.0), s1: s * rr(2.2, 3.6),
        c: [0.1, 0.09, 0.085, rr(0.55, 0.85)], c2: [0.3, 0.28, 0.26, 0],
        drag: 1.1, grav: 0.3, rot: rnd() * 6.28, spin: rr(-0.5, 0.5), frame: FRAMES.smoke,
        delay: rr(0.02, 0.14),
      });
    }
    sparks(x, y + 0.2, z, 4 + s * 4, 5 + s * 2.2, 0.16 + s * 0.035);
    if (!air) {
      if (onWater) {
        // water column + spray
        const n = many(6 + s * 3);
        for (let i = 0; i < n; i++) {
          const a = rnd() * 6.283;
          emit({
            x, y: WATER_Y + 0.05, z, vx: Math.cos(a) * rr(0.2, 1.4) * s * 0.5, vy: rr(3, 7) * (0.6 + s * 0.2), vz: Math.sin(a) * rr(0.2, 1.4) * s * 0.5,
            life: rr(0.7, 1.3), s0: s * rr(0.4, 0.7), s1: s * rr(0.9, 1.5),
            c: [0.85, 0.93, 1.0, 0.7], c2: [0.9, 0.95, 1, 0], grav: -9, drag: 0.5,
            rot: rnd() * 6.28, frame: FRAMES.dust,
          });
        }
        decal({ x, z, y: WATER_Y, s0: s * 0.8, s1: s * 6, life: 1.6, c: [0.9, 0.96, 1, 0.5], frame: FRAMES.ring });
      } else {
        debris(x, y + 0.2, z, 3 + s * 2.2, 4 + s * 1.5, 0.1 + s * 0.035);
        dust(x, y, z, 4 + s * 3, 1.6 + s * 0.8, 0.8);
        decal({ x, z, s0: s * 1.9, s1: s * 2.1, life: 70 + s * 8, rot: rnd() * 6.28, c: [0.03, 0.025, 0.02, clamp(0.5 + s * 0.06, 0, 0.82)], frame: FRAMES.smoke });
        decal({ x, z, s0: s * 0.9, s1: s * (5 + s * 0.4), life: 0.4 + s * 0.05, c: [2.2, 1.6, 1.0, 0.5], frame: FRAMES.ring, add: true });
      }
    }
    flash(x, y + 0.8 + s * 0.25, z, 0xffa040, 12 + s * 16, 10 + s * 8, 0.22 + s * 0.035);
    if (gl.onShake) gl.onShake(0.035 * s * s * 0.55, x, z);
    if (gl.onBoom) gl.onBoom(x, z, s, onWater);
  }

  // superweapon impact: staged, large, long-lived
  function megaExplosion(x, y, z, size) {
    const s = size;
    explosion(x, y, z, s * 0.75, 'ground');
    emit({ x, y: y + 1, z, life: 0.5, s0: s * 4, s1: s * 9, c: [12, 9, 6, 1], c2: [6, 2, 0.5, 0], frame: FRAMES.glow, add: true });
    decal({ x, z, s0: s * 1.5, s1: s * 13, life: 1.1, c: [3.2, 2.2, 1.4, 0.7], frame: FRAMES.ring, add: true });
    decal({ x, z, s0: s * 1.0, s1: s * 8, life: 0.7, c: [3.0, 2.6, 2.2, 0.6], frame: FRAMES.ring, add: true, delay: 0.12 });
    for (let k = 0; k < 6; k++) {
      after(0.08 * k, () => {
        const a = rnd() * 6.283, d = rr(0.3, 1.2) * s;
        explosion(x + Math.cos(a) * d, y, z + Math.sin(a) * d, s * rr(0.3, 0.5), 'ground');
      });
    }
    // rising column
    for (let i = 0; i < many(26); i++) {
      const t = i / 26;
      emit({
        x: x + rr(-0.3, 0.3) * s, y: y + t * s * 1.5, z: z + rr(-0.3, 0.3) * s,
        vx: rr(-0.5, 0.5), vy: rr(2.5, 5.5), vz: rr(-0.5, 0.5),
        life: rr(3.5, 6.5), s0: s * rr(0.8, 1.2), s1: s * rr(2.6, 4.2),
        c: [0.12, 0.1, 0.09, 0.85], c2: [0.32, 0.3, 0.28, 0], drag: 0.6, grav: 0.4,
        rot: rnd() * 6.28, spin: rr(-0.3, 0.3), frame: FRAMES.smoke, delay: t * 0.5,
      });
    }
    flash(x, y + 3, z, 0xffc070, 260, 90, 0.9);
    if (gl.onShake) gl.onShake(1.3, x, z);
  }

  function muzzle(x, y, z, dx, dy, dz, size) {
    const s = size;
    emit({ x: x + dx * 0.25 * s, y: y + dy * 0.25 * s, z: z + dz * 0.25 * s, life: 0.07, s0: s * 0.9, s1: s * 1.6, c: [8, 5.5, 2.4, 1], c2: [5, 2, 0.4, 0], frame: FRAMES.flare, add: true, rot: rnd() * 3 });
    emit({ x: x + dx * 0.5 * s, y: y + dy * 0.5 * s, z: z + dz * 0.5 * s, vx: dx * 6 * s, vy: dy * 6 * s, vz: dz * 6 * s, life: 0.1, s0: s * 0.7, s1: s * 0.3, c: [7, 4, 1.4, 1], c2: [3, 1, 0.2, 0], frame: FRAMES.spark, stretch: 2.6, add: true, drag: 6 });
    if (s > 0.7) {
      const n = many(2 + s * 2);
      for (let i = 0; i < n; i++) {
        emit({
          x: x + dx * 0.3, y: y + dy * 0.3, z: z + dz * 0.3,
          vx: dx * rr(1.5, 4) * s + rr(-0.5, 0.5), vy: dy * rr(1.5, 4) * s + rr(0.1, 0.6), vz: dz * rr(1.5, 4) * s + rr(-0.5, 0.5),
          life: rr(0.7, 1.4), s0: s * 0.35, s1: s * rr(1.2, 2.0),
          c: [0.5, 0.47, 0.42, 0.34], c2: [0.6, 0.57, 0.52, 0], drag: 2.6, grav: 0.2,
          rot: rnd() * 6.28, frame: FRAMES.smoke,
        });
      }
      flash(x, y + 0.3, z, 0xffb060, 5 * s, 9 * s, 0.09);
    }
  }

  // a bullet/shell streak that flies on its own (no per-frame CPU)
  function streak(x0, y0, z0, x1, y1, z1, speed, size, color, delay) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const d = Math.hypot(dx, dy, dz) || 1;
    const life = d / speed;
    emit({
      x: x0, y: y0, z: z0, vx: dx / d * speed, vy: dy / d * speed, vz: dz / d * speed,
      life, s0: size, s1: size, c: color, c2: [color[0], color[1], color[2], color[3]],
      frame: FRAMES.spark, stretch: 9, add: true, delay: delay || 0,
    });
    return life + (delay || 0);
  }

  function ping(x, z, color, size) {
    decal({ x, z, s0: size * 2.4, s1: size * 0.7, life: 0.5, c: [color[0], color[1], color[2], 0.9], frame: FRAMES.ring, add: true });
    decal({ x, z, s0: size * 0.5, s1: size * 0.9, life: 0.7, c: [color[0], color[1], color[2], 0.7], frame: FRAMES.ring, add: true, delay: 0.05 });
  }

  function update(dt) {
    now += dt;
    pMat.uniforms.uTime.value = now;
    dMat.uniforms.uTime.value = now;
    if (gl.look) {
      const tod = gl.look.tod;
      const c = pMat.uniforms.uLight.value;
      c.set(tod.sun).multiplyScalar(0.55 * Math.min(1.4, tod.sunI / 3));
      c.r += 0.35; c.g += 0.37; c.b += 0.42;
      if (gl.look.night) c.multiplyScalar(0.55);
    }
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (timeline[i].at <= now) {
        const fn = timeline[i].fn;
        timeline.splice(i, 1);
        try { fn(); } catch (e) { /* fx must never break a frame */ }
      }
    }
    for (const l of lights) {
      const u = l.userData;
      if (u.life > 0) {
        u.life -= dt;
        const t = Math.max(0, u.life / u.max);
        l.intensity = u.peak * t * t;
      } else if (l.intensity !== 0) l.intensity = 0;
    }
    flush();
    if (dDirty) {
      for (const a of [dPos, dNrm, dTime, dSize, dCol, dFrame]) a.needsUpdate = true;
      dDirty = false;
    }
  }

  function reset() {
    for (let i = 0; i < MAX; i++) aTime.array[i * 2] = -1e6;
    for (let i = 0; i < DMAX; i++) dTime.array[i * 2] = -1e6;
    aTime.needsUpdate = true; dTime.needsUpdate = true;
    for (const a of [aPos, aVel, aTime, aSize, aCol, aCol2, aMisc, aFrame]) a.clearUpdateRanges();
    timeline.length = 0;
    for (const l of lights) { l.userData.life = 0; l.intensity = 0; }
    head = 0; dHead = 0; dirtyLo = MAX; dirtyHi = -1; wrapped = false;
  }

  return {
    FRAMES, emit, decal, flash, after, update, reset,
    dust, smokePuff, fire, sparks, debris, explosion, megaExplosion, muzzle, streak, ping,
    rnd, rr,
    get now() { return now; },
  };
}
