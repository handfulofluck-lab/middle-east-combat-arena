// The static world: terrain chunks with a procedural PBR material, animated
// sea, sky dome, sun/ambient lighting and instanced scatter props. Built
// once per match from the heightfield + theme.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  S, WATER_Y, clamp, smoothstep, hash2, mulberry32, fbm,
} from './util.js';
import { HR } from './heightfield.js';

// ---------------------------------------------------------------------------
// tileable noise texture (R,G: fbm two seeds, B: fine grain, A: ridged)
// ---------------------------------------------------------------------------
let noiseTexCache = null;
export function getNoiseTexture() {
  if (noiseTexCache) return noiseTexCache;
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  // periodic gradient (Perlin) noise: organic, no lattice-aligned blocks
  const grad = (ix, iy, period, seed) => {
    const a = hash2(((ix % period) + period) % period, ((iy % period) + period) % period, seed) * 6.2831853;
    return [Math.cos(a), Math.sin(a)];
  };
  const perlin = (px, py, period, seed) => {
    const xi = Math.floor(px), yi = Math.floor(py);
    const xf = px - xi, yf = py - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const g00 = grad(xi, yi, period, seed), g10 = grad(xi + 1, yi, period, seed);
    const g01 = grad(xi, yi + 1, period, seed), g11 = grad(xi + 1, yi + 1, period, seed);
    const a = g00[0] * xf + g00[1] * yf, b = g10[0] * (xf - 1) + g10[1] * yf;
    const c = g01[0] * xf + g01[1] * (yf - 1), d = g11[0] * (xf - 1) + g11[1] * (yf - 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; // ~ -0.7..0.7
  };
  const tfbm = (x, y, base, oct, seed) => {
    let amp = 0.5, sum = 0, norm = 0, p = base;
    for (let o = 0; o < oct; o++) {
      sum += amp * perlin(x * p / N, y * p / N, p, seed + o * 13);
      norm += amp; amp *= 0.5; p *= 2;
    }
    return clamp(0.5 + (sum / norm) * 0.95, 0, 1);
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      data[i] = Math.round(tfbm(x, y, 4, 6, 1) * 255);
      data[i + 1] = Math.round(tfbm(x, y, 6, 5, 101) * 255);
      data[i + 2] = Math.round(hash2(x, y, 7) * 255 * 0.5 + tfbm(x, y, 48, 3, 201) * 255 * 0.5);
      const r = 1 - Math.abs(tfbm(x, y, 6, 5, 301) * 2 - 1);
      data[i + 3] = Math.round(clamp(r * r * 1.2, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  noiseTexCache = tex;
  return tex;
}

const C = (hex) => new THREE.Color(hex);

// ---------------------------------------------------------------------------
// terrain
// ---------------------------------------------------------------------------
export function buildTerrain(hf, look, quality) {
  const group = new THREE.Group();
  group.name = 'terrain';
  const { GW, GH, heights, splat, step, halfW, halfH } = hf;
  const biome = look.biome;

  // normals for the whole grid (central differences), packed per vertex
  const nrm = new Float32Array(GW * GH * 3);
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const k = j * GW + i;
      const hl = heights[j * GW + Math.max(0, i - 1)], hr = heights[j * GW + Math.min(GW - 1, i + 1)];
      const hu = heights[Math.max(0, j - 1) * GW + i], hd = heights[Math.min(GH - 1, j + 1) * GW + i];
      const nx = hl - hr, ny = 2 * step, nz = hu - hd;
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm[k * 3] = nx / l; nrm[k * 3 + 1] = ny / l; nrm[k * 3 + 2] = nz / l;
    }
  }

  const uniforms = {
    uNoise: { value: getNoiseTexture() },
    uSandA: { value: C(biome.sandA) }, uSandB: { value: C(biome.sandB) },
    uSandC: { value: C(biome.sandC) }, uRockA: { value: C(biome.rockA) },
    uRockB: { value: C(biome.rockB) }, uScrub: { value: C(biome.scrub) },
    uWet: { value: C(biome.wet) },
    uSalt: { value: look.biomeName === 'saltflat' ? 1 : 0 },
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.93, metalness: 0.0, vertexColors: true,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWNrm; varying vec4 vSplat;`)
      .replace('#include <color_vertex>', `vSplat = color;
        #if defined( USE_COLOR_ALPHA )
          vColor = vec4(1.0);
        #elif defined( USE_COLOR )
          vColor = vec3(1.0);
        #endif`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNrm = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWNrm; varying vec4 vSplat;
        uniform sampler2D uNoise;
        uniform vec3 uSandA, uSandB, uSandC, uRockA, uRockB, uScrub, uWet;
        uniform float uSalt;
        float gBump; float gRough;
        vec3 mcaPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
          vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
          vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
          vec3 vN = surf_norm;
          vec3 R1 = cross(vSigmaY, vN);
          vec3 R2 = cross(vN, vSigmaX);
          float fDet = dot(vSigmaX, R1) * faceDir;
          vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
          return normalize(abs(fDet) * surf_norm - vGrad);
        }`)
      .replace('#include <color_fragment>', `
        vec2 wp = vWPos.xz;
        vec4 n1 = texture2D(uNoise, wp * 0.0067);
        vec4 n2 = texture2D(uNoise, wp * 0.041 + n1.rg * 0.35);
        vec4 n3 = texture2D(uNoise, wp * 0.27);
        vec3 wn = normalize(vWNrm);
        float slope = 1.0 - wn.y;
        vec3 sand = mix(uSandA, uSandB, smoothstep(0.32, 0.68, n1.r));
        sand = mix(sand, uSandC, smoothstep(0.5, 0.82, n2.g) * 0.5);
        float rip = sin((wp.x * 0.9 + wp.y * 0.38) * 7.5 + n2.r * 10.0 + n1.g * 6.0) * 0.5 + 0.5;
        float ripAmt = (1.0 - smoothstep(0.02, 0.2, slope)) * smoothstep(0.35, 0.6, n1.b);
        sand *= 0.93 + 0.1 * rip * ripAmt;
        sand *= 0.9 + 0.2 * n3.b;
        // cracked salt pan
        float crack = smoothstep(0.9, 0.97, texture2D(uNoise, wp * 0.09 + n1.rg * 0.6).a) * uSalt;
        sand = mix(sand, sand * 0.8, crack * 0.6);
        float strata = sin(vWPos.y * 4.2 + n2.r * 7.0 + n1.g * 11.0 + n3.g * 1.5) * 0.5 + 0.5;
        strata = mix(strata, smoothstep(0.3, 0.7, strata), 0.5);
        // bands read on cliff faces, fade out on gentle slopes
        float strataAmt = 0.1 + 0.26 * smoothstep(0.08, 0.4, slope);
        vec3 rock = mix(uRockA, uRockB, smoothstep(0.25, 0.75, n2.a * 0.6 + n1.b * 0.4));
        rock *= 1.0 - strataAmt + strataAmt * 2.0 * strata;
        rock *= 0.82 + 0.36 * n3.r;
        rock *= 0.9 + 0.2 * n1.r;
        float rockW = max(vSplat.r, smoothstep(0.2, 0.42, slope));
        rockW = smoothstep(0.3, 0.7, rockW + (n2.b - 0.5) * 0.4);
        // wind-blown sand settles on flat rock tops
        rock = mix(rock, sand * 0.92, smoothstep(0.03, 0.0, slope) * 0.6 * smoothstep(0.3, 0.7, n2.r));
        vec3 col = mix(sand, rock, rockW);
        float veg = smoothstep(0.42, 0.75, vSplat.b + (n2.g - 0.5) * 0.55) * (1.0 - rockW);
        vec3 scrub = uScrub * (0.6 + 0.7 * n3.g) * (0.8 + 0.4 * n2.r);
        col = mix(col, scrub, veg * (0.5 + 0.4 * n3.b));
        float wet = vSplat.g;
        col = mix(col, uWet * (0.55 + 0.2 * n2.r), wet * 0.85);
        col *= mix(0.6, 1.0, vSplat.a);
        diffuseColor.rgb = col;
        gRough = mix(mix(0.96, 0.84, rockW), 0.32, wet * wet);
        gBump = mix(n2.r * 0.55 + n3.b * 0.3 + rip * ripAmt * 0.35, n2.a * 0.9 + strata * 0.5 + n3.r * 0.4, rockW)
          * mix(1.0, 0.25, wet);
      `)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = gRough;`)
      .replace('#include <normal_fragment_maps>', `
        vec2 dH = vec2(dFdx(gBump), dFdy(gBump)) * 0.55;
        float bumpFade = 1.0 - smoothstep(60.0, 220.0, length(vViewPosition));
        normal = mcaPerturb(-vViewPosition, normal, dH * bumpFade, faceDirection);
      `);
  };
  mat.customProgramCacheKey = () => 'mca-terrain-v1';

  // chunked meshes for frustum culling
  const CHUNK = 48 * HR; // quads per chunk side
  for (let cj = 0; cj < GH - 1; cj += CHUNK) {
    for (let ci = 0; ci < GW - 1; ci += CHUNK) {
      const nx = Math.min(CHUNK, GW - 1 - ci), nz = Math.min(CHUNK, GH - 1 - cj);
      const vw = nx + 1, vh = nz + 1;
      const pos = new Float32Array(vw * vh * 3);
      const nor = new Float32Array(vw * vh * 3);
      const col = new Uint8Array(vw * vh * 4);
      let minY = Infinity, maxY = -Infinity;
      for (let j = 0; j < vh; j++) {
        for (let i = 0; i < vw; i++) {
          const gk = (cj + j) * GW + (ci + i);
          const k = j * vw + i;
          const h = heights[gk];
          pos[k * 3] = (ci + i) * step - halfW;
          pos[k * 3 + 1] = h;
          pos[k * 3 + 2] = (cj + j) * step - halfH;
          nor[k * 3] = nrm[gk * 3]; nor[k * 3 + 1] = nrm[gk * 3 + 1]; nor[k * 3 + 2] = nrm[gk * 3 + 2];
          col[k * 4] = splat[gk * 4]; col[k * 4 + 1] = splat[gk * 4 + 1];
          col[k * 4 + 2] = splat[gk * 4 + 2]; col[k * 4 + 3] = splat[gk * 4 + 3];
          if (h < minY) minY = h;
          if (h > maxY) maxY = h;
        }
      }
      // skip chunks that are entirely deep sea floor far below the surface
      const idx = new Uint32Array(nx * nz * 6);
      let q = 0;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const a = j * vw + i, b = a + 1, c = a + vw, d = c + 1;
          // alternate the diagonal for a less directional look
          if ((i + j) & 1) { idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }
          else { idx[q++] = a; idx[q++] = c; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = b; }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4, true));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = quality.terrainShadows && (maxY - minY) > 1.2;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }

  // far ground skirt out to the horizon so the world never ends
  const skirtGeo = new THREE.RingGeometry(Math.min(halfW, halfH) * 0.98, 3200, 48, 1);
  skirtGeo.rotateX(-Math.PI / 2);
  const skirt = new THREE.Mesh(skirtGeo, new THREE.MeshStandardMaterial({
    color: C(biome.sandB).multiplyScalar(0.92), roughness: 1, metalness: 0,
  }));
  skirt.position.y = -0.6;
  skirt.receiveShadow = false;
  group.add(skirt);

  group.userData.material = mat;
  return group;
}

// ---------------------------------------------------------------------------
// sea
// ---------------------------------------------------------------------------
export function buildWater(hf, look) {
  const { GW, GH, heights, halfW, halfH } = hf;
  // half floats: linearly filterable on every WebGL2 device (full floats are not)
  const bed = new Uint16Array(GW * GH);
  for (let i = 0; i < bed.length; i++) bed[i] = THREE.DataUtils.toHalfFloat(heights[i]);
  const bedTex = new THREE.DataTexture(bed, GW, GH, THREE.RedFormat, THREE.HalfFloatType);
  bedTex.magFilter = THREE.LinearFilter;
  bedTex.minFilter = THREE.LinearFilter;
  bedTex.wrapS = bedTex.wrapT = THREE.ClampToEdgeWrapping;
  bedTex.needsUpdate = true;

  const tod = look.tod;
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    uniforms: {
      uTime: { value: 0 },
      uBed: { value: bedTex },
      uNoise: { value: getNoiseTexture() },
      uField: { value: new THREE.Vector4(-halfW, -halfH, halfW * 2, halfH * 2) },
      uShallow: { value: C(tod.water) },
      uDeep: { value: C(tod.waterDeep) },
      uSky: { value: C(tod.sky) },
      uHorizon: { value: C(tod.horizon) },
      uSunDir: { value: new THREE.Vector3(...look.sunDir) },
      uSunColor: { value: C(tod.sun).multiplyScalar(tod.sunI) },
      uFoam: { value: look.night ? 0.6 : 1.0 },
      uGlint: { value: look.night ? 0.3 : 1.0 },
      uFoamCol: { value: look.night ? new THREE.Color(0.2, 0.26, 0.4) : look.todName === 'dusk' ? new THREE.Color(0.85, 0.66, 0.6) : new THREE.Color(1, 1, 1) },
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vW;
      uniform float uTime, uFoam, uGlint;
      uniform vec3 uFoamCol;
      uniform sampler2D uBed, uNoise;
      uniform vec4 uField;
      uniform vec3 uShallow, uDeep, uSky, uHorizon, uSunDir, uSunColor;
      float hgt(vec2 p) {
        float t = uTime;
        float a = texture2D(uNoise, p * 0.021 + vec2(t * 0.011, t * 0.006)).r;
        float b = texture2D(uNoise, p * 0.057 - vec2(t * 0.017, -t * 0.012)).g;
        float c = texture2D(uNoise, p * 0.19 + vec2(-t * 0.03, t * 0.021)).r;
        return a * 0.55 + b * 0.3 + c * 0.15;
      }
      void main() {
        vec2 uv = (vW.xz - uField.xy) / uField.zw;
        float bed = texture2D(uBed, clamp(uv, 0.0, 1.0)).r;
        float depth = ${WATER_Y.toFixed(1)} - bed;
        if (depth < -0.03) discard;
        vec2 p = vW.xz;
        float e = 0.35;
        float h0 = hgt(p);
        float hx = hgt(p + vec2(e, 0.0));
        float hz = hgt(p + vec2(0.0, e));
        float calm = smoothstep(0.0, 1.2, depth);
        vec3 N = normalize(vec3(-(hx - h0) * 2.4 * calm, 1.0, -(hz - h0) * 2.4 * calm));
        vec3 V = normalize(cameraPosition - vW);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        vec3 sky = mix(uHorizon, uSky, pow(clamp(R.y, 0.0, 1.0), 0.32));
        float sd = max(dot(R, uSunDir), 0.0);
        vec3 glint = uSunColor * (pow(sd, 420.0) * 6.0 + pow(sd, 48.0) * 0.22) * uGlint;
        float dk = 1.0 - exp(-max(depth, 0.0) * 0.85);
        vec3 body = mix(uShallow, uDeep, dk);
        float ndl = clamp(dot(N, uSunDir), 0.0, 1.0);
        body *= 0.62 + 0.5 * ndl;
        body += uShallow * 0.42 * (1.0 - dk);           // sub-surface glow in the shallows
        vec3 col = mix(body, sky, fres * 0.62) + glint;
        // shoreline foam: animated swash lines + broken edge
        float fn = texture2D(uNoise, p * 0.11 + vec2(uTime * 0.02, 0.0)).b;
        float band = smoothstep(0.55, 0.0, depth);
        float lines = smoothstep(0.55, 0.95, sin(depth * 16.0 - uTime * 1.35 + fn * 5.0) * 0.5 + 0.5);
        float foam = band * (lines * 0.7 + smoothstep(0.16, 0.0, depth)) * smoothstep(0.25, 0.6, fn + band * 0.4);
        // open-water whitecaps
        foam += smoothstep(0.71, 0.8, h0) * 0.35 * calm;
        col = mix(col, uFoamCol * (0.75 + 0.5 * ndl), clamp(foam, 0.0, 1.0) * uFoam);
        float alpha = mix(0.5, 0.97, 1.0 - exp(-max(depth, 0.0) * 1.7));
        alpha = max(alpha, clamp(foam, 0.0, 1.0));
        alpha *= smoothstep(-0.03, 0.02, depth);
        gl_FragColor = vec4(col, alpha);
      }`,
  });
  const geo = new THREE.PlaneGeometry(7000, 7000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = WATER_Y;
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  mesh.name = 'water';
  mesh.userData.dispose = () => bedTex.dispose();
  return mesh;
}

// ---------------------------------------------------------------------------
// sky dome
// ---------------------------------------------------------------------------
export function buildSky(look) {
  const tod = look.tod;
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    uniforms: {
      uZenith: { value: C(tod.sky) },
      uHorizon: { value: C(tod.horizon) },
      uFog: { value: C(tod.fog) },
      uSunDir: { value: new THREE.Vector3(...look.sunDir) },
      uSunColor: { value: C(tod.sun) },
      uNoise: { value: getNoiseTexture() },
      uTime: { value: 0 },
      uClouds: { value: look.weather.clouds },
      uStars: { value: tod.stars },
      uHaze: { value: look.weather.haze },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uZenith, uHorizon, uFog, uSunDir, uSunColor;
      uniform sampler2D uNoise;
      uniform float uTime, uClouds, uStars, uHaze;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 col = mix(uHorizon, uZenith, pow(h, 0.42));
        col = mix(col, uHorizon * 1.08, pow(1.0 - h, 9.0) * (0.55 + 0.4 * uHaze));
        float sd = max(dot(d, uSunDir), 0.0);
        // warm forward-scatter around the sun, stronger near the horizon
        col += uSunColor * (pow(sd, 6.0) * 0.16 + pow(sd, 40.0) * 0.5) * (0.6 + 0.8 * pow(1.0 - h, 3.0));
        // high cirrus
        vec2 cuv = d.xz / (d.y + 0.16) * 0.11 + vec2(uTime * 0.0016, uTime * 0.0006);
        float c = texture2D(uNoise, cuv).r * 0.65 + texture2D(uNoise, cuv * 2.7 + 0.31).g * 0.35;
        float cm = smoothstep(0.5, 0.78, c) * smoothstep(0.02, 0.3, d.y) * uClouds;
        vec3 cloudCol = mix(uHorizon, vec3(1.0), 0.55) + uSunColor * (0.35 + 0.6 * pow(sd, 3.0));
        col = mix(col, cloudCol, cm * 0.75);
        // sun disc (HDR so bloom picks it up)
        col += uSunColor * (smoothstep(0.9994, 0.9998, sd) * 24.0 + pow(sd, 800.0) * 3.0);
        // stars
        if (uStars > 0.0) {
          vec2 suv = d.xz / (abs(d.y) + 0.35) * 3.2;
          float s = texture2D(uNoise, suv).b;
          float s2 = texture2D(uNoise, suv * 2.3 + 0.5).b;
          float star = smoothstep(0.86, 0.93, s) * smoothstep(0.55, 0.8, s2);
          col += vec3(0.85, 0.92, 1.0) * star * uStars * 1.6 * smoothstep(0.0, 0.25, d.y) * (1.0 - cm);
        }
        // below the horizon: distance haze so the ground skirt blends away
        col = mix(col, uFog, smoothstep(0.0, -0.08, d.y));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.name = 'sky';
  return mesh;
}

// ---------------------------------------------------------------------------
// lights
// ---------------------------------------------------------------------------
export function buildLights(look, quality) {
  const tod = look.tod;
  const group = new THREE.Group();
  const sun = new THREE.DirectionalLight(tod.sun, tod.sunI);
  sun.castShadow = quality.shadows > 0;
  if (sun.castShadow) {
    sun.shadow.mapSize.set(quality.shadows, quality.shadows);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.06;
    sun.shadow.radius = 2.2;
    sun.shadow.intensity = tod.shadow + 0.3;
  }
  group.add(sun);
  group.add(sun.target);
  const hemi = new THREE.HemisphereLight(tod.sky, tod.ground, tod.hemiI);
  group.add(hemi);
  // soft bounce from the opposite side to open up shadowed faces
  const fill = new THREE.DirectionalLight(tod.horizon, tod.sunI * 0.12);
  fill.position.set(-look.sunDir[0], 0.4, -look.sunDir[2]);
  group.add(fill);
  return { group, sun, hemi, fill };
}

// fit the shadow frustum around the visible ground, snapped to texels
const _v = new THREE.Vector3();
export function updateSunShadow(lights, look, focus, radius) {
  const sun = lights.sun;
  const r = clamp(radius, 26, 150);
  const dir = _v.set(look.sunDir[0], look.sunDir[1], look.sunDir[2]);
  const cam = sun.shadow.camera;
  const texel = (r * 2) / sun.shadow.mapSize.x;
  // snap the focus in light space to avoid shimmering while panning
  const fx = Math.round(focus.x / texel) * texel;
  const fz = Math.round(focus.z / texel) * texel;
  sun.target.position.set(fx, 0, fz);
  sun.position.set(fx + dir.x * 260, dir.y * 260, fz + dir.z * 260);
  if (cam.right !== r) {
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 20; cam.far = 620;
    cam.updateProjectionMatrix();
  }
  sun.target.updateMatrixWorld();
}

// ---------------------------------------------------------------------------
// scatter props (instanced, vertex coloured)
// ---------------------------------------------------------------------------
function colorGeo(geo, fn) {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    fn(c, pos.getX(i), pos.getY(i), pos.getZ(i), i);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function rockGeo(seed, biome) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.attributes.position;
  const rnd = mulberry32(seed);
  const sx = 0.8 + rnd() * 0.6, sy = 0.45 + rnd() * 0.5, sz = 0.8 + rnd() * 0.6;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = fbm(x * 1.7 + seed, y * 1.7 + z * 1.3, 3, seed);
    const k = 0.72 + n * 0.6;
    pos.setXYZ(i, x * k * sx, Math.max(-0.25, y * k * sy), z * k * sz);
  }
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  const a = new THREE.Color(biome.rockA), b = new THREE.Color(biome.rockB);
  return colorGeo(flat, (c, x, y, z, i) => {
    const t = hash2(Math.floor(i / 3), seed, 3);
    c.copy(a).lerp(b, t * 0.8).multiplyScalar(0.8 + 0.3 * smoothstep(-0.2, 0.7, y));
  });
}

function shrubGeo(seed, biome) {
  const parts = [];
  const rnd = mulberry32(seed);
  const n = 5 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const g = new THREE.IcosahedronGeometry(0.16 + rnd() * 0.16, 0);
    g.scale(1, 0.7 + rnd() * 0.5, 1);
    g.translate((rnd() - 0.5) * 0.5, 0.12 + rnd() * 0.16, (rnd() - 0.5) * 0.5);
    parts.push(g);
  }
  const m = mergeGeometries(parts).toNonIndexed();
  m.computeVertexNormals();
  const base = new THREE.Color(biome.scrub);
  return colorGeo(m, (c, x, y, z, i) => {
    const t = hash2(Math.floor(i / 3), seed, 9);
    c.copy(base).multiplyScalar(0.55 + t * 0.6 + y * 0.6);
  });
}

function palmGeo(seed) {
  const parts = [];
  const rnd = mulberry32(seed);
  const hgt = 1.9 + rnd() * 0.9;
  const lean = (rnd() - 0.5) * 0.5;
  const segs = 6;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const r0 = 0.085 - t0 * 0.035, r1 = 0.085 - t1 * 0.035;
    const g = new THREE.CylinderGeometry(r1, r0, hgt / segs, 6, 1);
    g.translate(lean * t0 * t0 * hgt * 0.5 + lean * 0.04, hgt * (t0 + 0.5 / segs), 0);
    parts.push(g);
  }
  const trunk = mergeGeometries(parts);
  colorGeo(trunk, (c, x, y) => { c.setHex(0x6b5338).multiplyScalar(0.75 + 0.35 * Math.sin(y * 22) * 0.5 + 0.2); });
  const fronds = [];
  const topX = lean * hgt * 0.5 + lean * 0.04;
  const nf = 9;
  for (let i = 0; i < nf; i++) {
    const g = new THREE.PlaneGeometry(1.25, 0.34, 5, 1);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const x = p.getX(v) + 0.625; // 0..1.25 along the frond
      const t = x / 1.25;
      const droop = -t * t * (0.75 + rnd() * 0.08);
      const taper = 1 - t * 0.85;
      p.setXYZ(v, x, droop + 0.12 * Math.sin(t * 3.1), p.getY(v) * taper);
    }
    g.rotateZ(0.42 - (i % 3) * 0.2);
    g.rotateY((i / nf) * Math.PI * 2 + rnd() * 0.3);
    g.translate(topX, hgt, 0);
    fronds.push(g);
  }
  const crown = mergeGeometries(fronds);
  crown.computeVertexNormals();
  colorGeo(crown, (c, x, y, z, i) => {
    c.setHex(0x4f7a34).multiplyScalar(0.7 + hash2(i, seed, 5) * 0.5);
  });
  const out = mergeGeometries([trunk.toNonIndexed(), crown.toNonIndexed()]);
  out.computeVertexNormals();
  return out;
}

function acaciaGeo(seed) {
  const rnd = mulberry32(seed);
  const parts = [];
  const hgt = 1.1 + rnd() * 0.5;
  const trunk = new THREE.CylinderGeometry(0.05, 0.09, hgt, 5);
  trunk.translate(0, hgt / 2, 0);
  colorGeo(trunk, (c) => c.setHex(0x54402c));
  parts.push(trunk.toNonIndexed());
  for (let i = 0; i < 4; i++) {
    const g = new THREE.IcosahedronGeometry(0.5 + rnd() * 0.25, 0);
    g.scale(1.3, 0.3, 1.3);
    g.translate((rnd() - 0.5) * 0.7, hgt + (rnd() - 0.3) * 0.2, (rnd() - 0.5) * 0.7);
    colorGeo(g, (c, x, y, z, k) => c.setHex(0x5d7036).multiplyScalar(0.7 + hash2(k, seed, i) * 0.5));
    parts.push(g.toNonIndexed());
  }
  const out = mergeGeometries(parts);
  out.computeVertexNormals();
  return out;
}

export function buildProps(hf, look, quality) {
  const group = new THREE.Group();
  group.name = 'props';
  const biome = look.biome;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true });
  const leafMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
  });
  const kinds = {
    rock: { geos: [rockGeo(11, biome), rockGeo(23, biome), rockGeo(37, biome)], mat, list: [[], [], []] },
    shrub: { geos: [shrubGeo(5, biome), shrubGeo(8, biome)], mat, list: [[], []] },
    palm: { geos: [palmGeo(3), palmGeo(14), palmGeo(29)], mat: leafMat, list: [[], [], []] },
    tree: { geos: [acaciaGeo(2), acaciaGeo(19)], mat, list: [[], []] },
  };
  const map = hf.map;
  const dens = quality.props;
  const rnd = mulberry32((map.w * 7919 + map.h * 104729) >>> 0);
  const tries = Math.round(map.w * map.h * 0.42 * dens);
  const p = biome.props;
  const cellIndex = new Map(); // cell key -> [{kind, variant, index}]
  for (let t = 0; t < tries; t++) {
    const cx = rnd() * map.w, cy = rnd() * map.h;
    const x = (cx - map.w / 2) * S, z = (cy - map.h / 2) * S;
    const sw = hf.waterDist(x, z), sr = hf.rockDist(x, z);
    if (sw > -0.9) continue;                 // not in water / on the swash
    const r = rnd();
    let kind = null;
    const cluster = fbm(x * 0.03 + 7.1, z * 0.03 - 2.2, 2, 5);
    if (sr > -1.9 && sr < 0.5 && r < 0.3 * p.rocks) kind = 'rock';
    else if (sr < -1.2) {
      const nearWater = sw > -7;
      if (nearWater && cluster > 0.45 && r < 0.16 * p.palms) kind = 'palm';
      else if (cluster > 0.56 && r < 0.11 * p.shrubs) kind = 'shrub';
      else if (cluster > 0.6 && r < 0.13 * p.shrubs + 0.02 * p.trees && rnd() < p.trees) kind = 'tree';
      else if (r < 0.012 * p.rocks) kind = 'rock';
      else if (r < 0.02 * p.shrubs) kind = 'shrub';
    }
    if (!kind) continue;
    const K = kinds[kind];
    const variant = Math.floor(rnd() * K.geos.length);
    const y = hf.heightAt(x, z);
    let s = 1;
    if (kind === 'rock') s = 0.35 + rnd() * rnd() * 1.5 + (sr > -0.6 ? 0.5 : 0);
    else if (kind === 'shrub') s = 0.7 + rnd() * 0.9;
    else if (kind === 'palm') s = 0.8 + rnd() * 0.5;
    else s = 0.9 + rnd() * 0.6;
    const entry = { x, y: y - (kind === 'rock' ? 0.12 * s : 0.02), z, s, rot: rnd() * Math.PI * 2 };
    K.list[variant].push(entry);
    const key = Math.floor(cy) * map.w + Math.floor(cx);
    let arr = cellIndex.get(key);
    if (!arr) { arr = []; cellIndex.set(key, arr); }
    arr.push({ kind, variant, index: K.list[variant].length - 1 });
  }
  const dummy = new THREE.Object3D();
  const meshes = {};
  for (const name in kinds) {
    const K = kinds[name];
    meshes[name] = [];
    K.geos.forEach((geo, v) => {
      const list = K.list[v];
      if (!list.length) { meshes[name].push(null); return; }
      const im = new THREE.InstancedMesh(geo, K.mat, list.length);
      list.forEach((e, i) => {
        dummy.position.set(e.x, e.y, e.z);
        dummy.rotation.set(0, e.rot, 0);
        dummy.scale.setScalar(e.s);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      im.castShadow = quality.shadows > 0;
      im.receiveShadow = true;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      group.add(im);
      meshes[name].push(im);
    });
  }
  // structures flatten whatever stood on their footprint
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  group.userData.clearCells = (cx0, cy0, fp) => {
    for (let cy = cy0 - 0; cy < cy0 + fp; cy++) {
      for (let cx = cx0 - 0; cx < cx0 + fp; cx++) {
        const arr = cellIndex.get(cy * map.w + cx);
        if (!arr) continue;
        for (const e of arr) {
          const im = meshes[e.kind][e.variant];
          if (!im) continue;
          im.setMatrixAt(e.index, zero);
          im.instanceMatrix.needsUpdate = true;
        }
        cellIndex.delete(cy * map.w + cx);
      }
    }
  };
  return group;
}

// ---------------------------------------------------------------------------
// oil fields: crude seep + nodding pumpjack
// ---------------------------------------------------------------------------
export function buildOilField(hf, x, z, seed) {
  const g = new THREE.Group();
  const y = Math.max(hf.heightAt(x, z), WATER_Y + 0.02);
  g.position.set(x, y, z);
  // irregular crude pool
  const shape = new THREE.Shape();
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 1.15 + fbm(Math.cos(a) * 1.3 + seed, Math.sin(a) * 1.3, 2, seed) * 0.9;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const poolGeo = new THREE.ShapeGeometry(shape);
  poolGeo.rotateX(-Math.PI / 2);
  const pool = new THREE.Mesh(poolGeo, new THREE.MeshStandardMaterial({
    color: 0x0a0806, roughness: 0.08, metalness: 0.6, envMapIntensity: 1.6,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  pool.position.y = 0.05;
  pool.receiveShadow = true;
  g.add(pool);
  // stain around it
  const stain = new THREE.Mesh(new THREE.CircleGeometry(2.6, 20).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x1a120a, transparent: true, opacity: 0.38, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
  stain.position.y = 0.035;
  g.add(stain);
  // pumpjack
  const steel = new THREE.MeshStandardMaterial({ color: 0x8c2f24, roughness: 0.55, metalness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6, metalness: 0.6 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 0.5), dark);
  base.position.set(0.1, 0.07, 0);
  g.add(base);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.11, 0.95, 6), steel);
  post.position.set(0.05, 0.55, 0);
  g.add(post);
  const beam = new THREE.Group();
  beam.position.set(0.05, 1.03, 0);
  const walking = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.09, 0.09), steel);
  beam.add(walking);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.1, 10, 1, false, -0.9, 1.8).rotateX(Math.PI / 2), steel);
  head.position.set(-0.75, -0.06, 0);
  beam.add(head);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.16), dark);
  counter.position.set(0.72, -0.12, 0);
  beam.add(counter);
  g.add(beam);
  const motor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.3), dark);
  motor.position.set(0.72, 0.27, 0);
  g.add(motor);
  for (const m of [base, post, walking, head, counter, motor]) { m.castShadow = true; m.receiveShadow = true; }
  g.rotation.y = hash2(seed, 3, 1) * Math.PI * 2;
  g.userData.beam = beam;
  g.userData.phase = hash2(seed, 5, 2) * 6.28;
  return g;
}
