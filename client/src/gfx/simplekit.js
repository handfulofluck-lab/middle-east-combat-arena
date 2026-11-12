// Minimal stand-in model kit (plain boxes) with the same interface as the
// real procedural library in models.js. Used as a safety net if the full
// kit fails to build a model, and by the renderer lab.
import * as THREE from 'three';

const INF = new Set(['Infantry', 'AT infantry', 'AA infantry', 'SF', 'Engineer']);

export function createSimpleKit() {
  const mats = new Map();
  const geos = new Map();
  const mat = (hex) => {
    let m = mats.get(hex);
    if (!m) { m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.7, metalness: 0.2 }); mats.set(hex, m); }
    return m;
  };
  const box = (parent, w, h, d, hex, x, y, z) => {
    const key = w + '|' + h + '|' + d;
    let geo = geos.get(key);
    if (!geo) { geo = new THREE.BoxGeometry(w, h, d); geo.userData.shared = true; geos.set(key, geo); }
    const m = new THREE.Mesh(geo, mat(hex));
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const node = (parent, x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };

  function unit(def, team) {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const out = {
      root, body, turret: null, barrel: null, muzzles: [], rotors: [], wheels: [], figures: null,
      exhausts: [], kind: 'vehicle', radius: 1, height: 0.8, hover: 0,
    };
    const camo = 0x8d8468;
    if (INF.has(def.cls)) {
      out.kind = 'infantry'; out.radius = 0.5; out.height = 0.55; out.figures = [];
      for (let i = 0; i < 3; i++) {
        const fig = new THREE.Group();
        fig.position.set((i - 1) * 0.22, 0, (i % 2) * 0.2 - 0.1);
        body.add(fig);
        box(fig, 0.12, 0.26, 0.16, camo, 0, 0.36, 0);
        box(fig, 0.1, 0.1, 0.1, team.color, 0, 0.55, 0);
        const legL = new THREE.Group(); legL.position.set(0, 0.24, 0.04); fig.add(legL);
        const legR = new THREE.Group(); legR.position.set(0, 0.24, -0.04); fig.add(legR);
        box(legL, 0.07, 0.24, 0.06, 0x4a4636, 0, -0.12, 0);
        box(legR, 0.07, 0.24, 0.06, 0x4a4636, 0, -0.12, 0);
        const armL = new THREE.Group(), armR = new THREE.Group(); fig.add(armL, armR);
        out.figures.push({ node: fig, legL, legR, armL, armR, phase: i * 2.1 });
      }
      out.muzzles.push(node(body, 0.3, 0.42, 0));
    } else if (def.domain === 'Air') {
      const helo = /helo/i.test(def.cls);
      out.kind = helo ? 'helo' : (def.cls === 'UAV' ? 'drone' : 'jet');
      out.hover = helo ? 3.2 : out.kind === 'drone' ? 4.8 : 6.5;
      out.radius = 1.1; out.height = 0.6;
      box(body, 2.0, 0.3, 0.34, 0x8a9098, 0, 0, 0);
      box(body, 0.6, 0.06, 1.7, 0x7b8088, -0.1, 0, 0);
      box(body, 0.3, 0.3, 0.06, team.color, -0.85, 0.2, 0);
      if (helo) {
        const r = new THREE.Group(); r.position.set(0, 0.25, 0); body.add(r);
        box(r, 2.2, 0.02, 0.12, 0x222222, 0, 0, 0);
        out.rotors.push({ node: r, axis: 'y', speed: 30 });
      }
      out.muzzles.push(node(body, 1.0, -0.05, 0));
      out.exhausts.push(node(body, -1.0, 0, 0));
    } else if (def.domain === 'Sea') {
      out.kind = 'ship'; out.radius = 2.0; out.height = 1.2;
      box(body, 4.0, 0.5, 1.0, 0x80868e, 0, 0.2, 0);
      box(body, 1.2, 0.5, 0.7, 0x9aa0a8, -0.3, 0.7, 0);
      box(body, 0.4, 0.2, 0.4, team.color, 0.2, 1.05, 0);
      const t = new THREE.Group(); t.position.set(1.2, 0.5, 0); body.add(t);
      box(t, 0.4, 0.2, 0.4, 0x6a7078, 0, 0.1, 0);
      const b = new THREE.Group(); t.add(b);
      box(b, 0.7, 0.07, 0.07, 0x33373c, 0.5, 0.12, 0);
      out.turret = t; out.barrel = b;
      out.muzzles.push(node(b, 0.9, 0.12, 0));
      out.exhausts.push(node(body, -2.0, 0.02, 0));
    } else {
      out.radius = 1.05; out.height = 0.85;
      box(body, 1.8, 0.36, 0.95, camo, 0, 0.32, 0);
      box(body, 1.9, 0.22, 0.22, 0x2b2b2b, 0, 0.14, 0.42);
      box(body, 1.9, 0.22, 0.22, 0x2b2b2b, 0, 0.14, -0.42);
      box(body, 0.5, 0.05, 0.7, team.color, -0.5, 0.52, 0);
      const t = new THREE.Group(); t.position.set(0.05, 0.5, 0); body.add(t);
      box(t, 0.8, 0.24, 0.62, camo, 0, 0.12, 0);
      const b = new THREE.Group(); t.add(b);
      box(b, 1.0, 0.08, 0.08, 0x33352f, 0.85, 0.14, 0);
      out.turret = t; out.barrel = b;
      out.muzzles.push(node(b, 1.38, 0.14, 0));
      out.exhausts.push(node(body, -0.95, 0.3, 0));
    }
    return out;
  }

  function structure(def, team) {
    const root = new THREE.Group();
    const fp = def.fp || (def.type === 'SW' ? 4 : def.type === 'Def' ? 2 : 3);
    const s = fp * 2 * 0.86;
    const out = {
      root, turret: null, barrel: null, muzzles: [], spinners: [], lights: [], stacks: [], doors: [],
      height: 1.6, kind: def.type,
    };
    box(root, s, 0.12, s, 0x6f6a60, 0, 0.06, 0);
    box(root, s * 0.7, 1.3, s * 0.6, 0xa39a84, 0, 0.75, 0);
    box(root, s * 0.72, 0.08, s * 0.62, team.color, 0, 1.44, 0);
    if (def.type === 'Def') {
      const t = new THREE.Group(); t.position.set(0, 1.5, 0); root.add(t);
      box(t, 0.7, 0.3, 0.5, 0x555a50, 0, 0.15, 0);
      const b = new THREE.Group(); t.add(b);
      box(b, 1.1, 0.1, 0.1, 0x2c2e2a, 0.7, 0.2, 0);
      out.turret = t; out.barrel = b;
      out.muzzles.push(node(b, 1.25, 0.2, 0));
      out.height = 2.0;
    }
    out.stacks.push(node(root, s * 0.2, 1.5, s * 0.15));
    out.lights.push(node(root, -s * 0.3, 1.6, -s * 0.25));
    return out;
  }

  function wreck(def) {
    const g = new THREE.Group();
    const m = box(g, 1.5, 0.3, 0.8, 0x1a1816, 0, 0.18, 0);
    m.rotation.set(0.1, 0.4, 0.06);
    void def;
    return g;
  }

  return { unit, structure, wreck, materials: {}, dispose() {} };
}
