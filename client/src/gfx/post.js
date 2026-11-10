// Post pipeline: HDR scene (MSAA) -> world pass (cloud shadows, aerial
// perspective, fog of war — all reconstructed from depth so every material
// gets them for free) -> bloom -> filmic tone map + grade.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { getNoiseTexture } from './world.js';

const QUAD_VS = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

class WorldPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        uFogTex: { value: null }, uNoise: { value: getNoiseTexture() },
        uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
        uMapRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uFogColor: { value: new THREE.Color(0xd8c0a0) },
        uFogDensity: { value: 0.003 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xffffff) },
        uTime: { value: 0 }, uReveal: { value: 0 }, uCloudAmt: { value: 0.3 },
        uShroud: { value: new THREE.Color(0x05070b) },
        uDust: { value: 0 },
      },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse, tDepth, uFogTex, uNoise;
        uniform mat4 uProjInv, uCamWorld;
        uniform vec4 uMapRect;
        uniform vec3 uFogColor, uSunDir, uSunColor, uShroud;
        uniform float uFogDensity, uTime, uReveal, uCloudAmt, uDust;
        vec2 fogAt(vec2 uv) {
          vec2 inb = step(vec2(0.0), uv) * step(uv, vec2(1.0));
          vec2 f = texture2D(uFogTex, clamp(uv, 0.0, 1.0)).rg;
          return mix(vec2(0.0, 1.0), f, inb.x * inb.y);   // outside the map: explored-dim
        }
        void main() {
          vec4 src = texture2D(tDiffuse, vUv);
          float d = texture2D(tDepth, vUv).x;
          vec3 col = src.rgb;
          if (d < 0.99999) {
            vec4 ndc = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
            vec4 view = uProjInv * ndc;
            view /= view.w;
            vec3 wp = (uCamWorld * view).xyz;
            vec3 cam = uCamWorld[3].xyz;
            float dist = length(view.xyz);
            vec3 vdir = normalize(wp - cam);
            // drifting cloud shadows
            vec2 cuv = wp.xz * 0.0031 + uTime * vec2(0.0042, 0.0016);
            float cl = texture2D(uNoise, cuv).r * 0.62 + texture2D(uNoise, cuv * 2.3 + 0.37).g * 0.38;
            col *= 1.0 - smoothstep(0.5, 0.74, cl) * uCloudAmt * 0.34;
            // aerial perspective with height falloff + sun in-scatter
            float hf = exp(-max(wp.y, 0.0) * 0.045);
            float f = 1.0 - exp(-dist * uFogDensity * (0.35 + 0.65 * hf));
            float sd = max(dot(vdir, uSunDir), 0.0);
            vec3 fc = uFogColor + uSunColor * pow(sd, 6.0) * 0.22;
            col = mix(col, fc, clamp(f, 0.0, 1.0));
            // low blowing dust near the ground
            if (uDust > 0.0) {
              vec2 duv = wp.xz * 0.012 + uTime * vec2(0.05, 0.012);
              float dn = texture2D(uNoise, duv).g * texture2D(uNoise, duv * 0.37 + 0.2).r;
              col = mix(col, fc * 0.92, smoothstep(0.18, 0.5, dn) * uDust * 0.35 * hf);
            }
            // fog of war (5 taps -> soft frontier)
            vec2 fuv = (wp.xz - uMapRect.xy) / uMapRect.zw;
            vec2 px = 0.75 / uMapRect.zw * 2.0;
            vec2 fg = fogAt(fuv) * 0.4 + (fogAt(fuv + vec2(px.x, 0.0)) + fogAt(fuv - vec2(px.x, 0.0))
              + fogAt(fuv + vec2(0.0, px.y)) + fogAt(fuv - vec2(0.0, px.y))) * 0.15;
            fg = mix(fg, vec2(1.0), uReveal);
            float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
            vec3 dim = mix(vec3(luma), col, 0.3) * vec3(0.3, 0.36, 0.46);
            float sw = texture2D(uNoise, wp.xz * 0.02 + uTime * 0.006).r;
            vec3 shroud = uShroud * (0.7 + 0.8 * sw) + dim * 0.2;
            vec3 lit = mix(dim, col, smoothstep(0.02, 0.98, fg.r));
            col = mix(shroud, lit, smoothstep(0.05, 0.9, fg.g));
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(this.camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() { this.material.dispose(); this.quad.dispose(); }
}

class FinalPass extends Pass {
  constructor() {
    super();
    this.material = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: 1 }, uTime: { value: 0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uVignette: { value: 0.32 }, uGrain: { value: 0.035 },
        uSaturation: { value: 1.0 }, uContrast: { value: 1.07 },
        uAberration: { value: 0.00045 }, uLetterbox: { value: 0 },
        uFade: { value: 0 }, uFlash: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) }, uSharpen: { value: 0.25 },
      },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform float uExposure, uTime, uVignette, uGrain, uSaturation, uContrast;
        uniform float uAberration, uLetterbox, uFade, uFlash, uSharpen;
        uniform vec3 uTint;
        uniform vec2 uRes;
        vec3 aces(vec3 x) {
          // Stephen Hill's fitted ACES (RRT + ODT)
          const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
          const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
          vec3 v = inM * x;
          vec3 a = v * (v + 0.0245786) - 0.000090537;
          vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
          return clamp(outM * (a / b), 0.0, 1.0);
        }
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec2 c = vUv - 0.5;
          float r2 = dot(c, c);
          vec2 off = c * r2 * uAberration * 8.0;
          vec3 col;
          col.r = texture2D(tDiffuse, vUv + off).r;
          col.g = texture2D(tDiffuse, vUv).g;
          col.b = texture2D(tDiffuse, vUv - off).b;
          if (uSharpen > 0.0) {
            vec2 px = 1.0 / uRes;
            vec3 blur = (texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb
              + texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb) * 0.25;
            col += (col - blur) * uSharpen;
          }
          col = max(col, 0.0) * uExposure * uTint;
          col += uFlash * vec3(1.0, 0.92, 0.8);
          col = aces(col * 1.12);
          col = pow(col, vec3(1.0 / 2.2));
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(l), col, uSaturation);
          col = (col - 0.5) * uContrast + 0.5;
          // gentle split toning: cool shadows, warm highlights
          col += (vec3(-0.012, 0.0, 0.02) * (1.0 - l) + vec3(0.018, 0.006, -0.014) * l);
          col *= 1.0 - uVignette * smoothstep(0.12, 0.62, r2);
          col += (hash(vUv * uRes + fract(uTime) * 91.7) - 0.5) * uGrain;
          // cinematic bars + fade
          float bar = step(abs(c.y), 0.5 - uLetterbox * 0.115);
          col *= bar;
          col *= 1.0 - uFade;
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() { this.material.dispose(); this.quad.dispose(); }
}

export function createPost(renderer, scene, camera, quality) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // HDR targets need EXT_color_buffer_float; without it fall back to 8-bit
  const hdr = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  const makeTarget = (w, h) => {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
      samples: quality.msaa, depthBuffer: true, stencilBuffer: false,
    });
    rt.depthTexture = new THREE.DepthTexture(w, h);
    rt.depthTexture.type = THREE.UnsignedIntType;
    return rt;
  };
  const composer = new EffectComposer(renderer, makeTarget(size.x, size.y));
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const world = new WorldPass(camera);
  composer.addPass(world);
  let bloom = null;
  if (quality.bloom && hdr) {
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.42, 0.62, 0.92);
    composer.addPass(bloom);
  }
  const final = new FinalPass();
  final.material.uniforms.uSharpen.value = quality.sharpen;
  final.material.uniforms.uGrain.value = quality.grain;
  composer.addPass(final);

  return {
    composer, world, bloom, final,
    setSize(w, h, pr) {
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      final.material.uniforms.uRes.value.set(w * pr, h * pr);
    },
    render(dt) { composer.render(dt); },
    dispose() {
      composer.dispose(); world.dispose(); final.dispose();
      if (bloom && bloom.dispose) bloom.dispose();
      if (composer.renderTarget1.depthTexture) composer.renderTarget1.depthTexture.dispose();
      if (composer.renderTarget2.depthTexture) composer.renderTarget2.depthTexture.dispose();
    },
  };
}
