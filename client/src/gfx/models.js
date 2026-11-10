// MCA procedural model library — public entry.
//
//   const kit = createModelKit({ quality: 'high' | 'low' });
//   const u = kit.unit(def, { color: 0x3aa0ff, faction: 'Egypt' });
//   const s = kit.structure(def, team);
//   const w = kit.wreck(def);
//
// Conventions: 1 map cell = 2.0 units, +X forward, +Y up, origin = ground contact at the
// model centre. Every rigid part is ONE merged BufferGeometry with per-vertex colours drawn
// with the shared `kit.materials.paint`; geometry is cached per (def.id, team, quality).

import * as THREE from 'three';
import { makeCtx } from './models/palette.js';
import { Model, instantiate } from './models/model.js';
import { hashStr } from './models/geo.js';
import { UNIT_BUILDERS, unitKind } from './models/units.js';
import { buildStructure, footprintOf } from './models/structures.js';

const HOVER = { helo: 3.2, jet: 6.5, drone: 4.8 };
const CTX_KIND = { infantry: 'inf', vehicle: 'ground', helo: 'helo', jet: 'air', drone: 'drone', ship: 'naval' };

function makeMaterials() {
  const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.1 });
  paint.name = 'mca-paint';
  const glass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.1, metalness: 0.85, envMapIntensity: 1.5 });
  glass.name = 'mca-glass';
  const emissive = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  emissive.name = 'mca-emissive';
  const rotorDisc = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  rotorDisc.name = 'mca-rotor-disc';
  const wreck = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x75614f, roughness: 0.96, metalness: 0.02 });
  wreck.name = 'mca-wreck';
  return { paint, glass, emissive, rotorDisc, wreck };
}

export function createModelKit(opts = {}) {
  const quality = opts.quality === 'low' ? 'low' : 'high';
  const materials = makeMaterials();
  const cache = new Map();
  let disposed = false;

  function teamOf(team) {
    const t = team || {};
    let c = t.color ?? 0x8a8a8a;
    if (c && c.isColor) c = c.getHex();
    else if (typeof c === 'string') c = new THREE.Color(c).getHex();
    return { color: c >>> 0, faction: t.faction || 'Egypt' };
  }

  function unitBlueprint(def, team) {
    const t = teamOf(team);
    const key = 'u|' + (def.id || def.name) + '|' + t.color + '|' + t.faction + '|' + quality;
    let bp = cache.get(key);
    if (bp) return bp;
    const kind = unitKind(def);
    const faction = def.faction && def.faction !== 'All' ? def.faction : t.faction;
    const ctx = makeCtx({ kind: CTX_KIND[kind], faction, teamColor: t.color, quality, seed: hashStr(def.id || def.name || 'x') });
    const M = new Model(ctx);
    const build = UNIT_BUILDERS[def.cls] || UNIT_BUILDERS['_' + kind];
    const meta = build(M, def) || {};
    bp = M.finish({ kind, ...meta });
    bp.defId = def.id;
    cache.set(key, bp);
    return bp;
  }

  function structureBlueprint(def, team) {
    const t = teamOf(team);
    const key = 's|' + (def.id || def.name) + '|' + t.color + '|' + t.faction + '|' + quality;
    let bp = cache.get(key);
    if (bp) return bp;
    const faction = def.faction && def.faction !== 'All' ? def.faction : t.faction;
    const ctx = makeCtx({ kind: 'struct', faction, teamColor: t.color, quality, seed: hashStr(def.id || def.name || 's') });
    const M = new Model(ctx);
    const meta = buildStructure(M, def) || {};
    bp = M.finish({ kind: def.type, ...meta });
    bp.defId = def.id;
    cache.set(key, bp);
    return bp;
  }

  function unit(def, team) {
    const bp = unitBlueprint(def, team);
    const { objs, empties } = instantiate(bp, materials);
    const root = new THREE.Group();
    root.name = 'unit:' + def.id;
    const body = objs[0];
    root.add(body);
    const kind = bp.meta.kind;
    return {
      root,
      body,
      turret: bp.turret >= 0 ? objs[bp.turret] : null,
      barrel: bp.barrel >= 0 ? objs[bp.barrel] : null,
      muzzles: empties(bp.marks.muzzles, 'muzzle'),
      rotors: bp.spins.map((s) => ({ node: objs[s.node], axis: s.axis, speed: s.speed })),
      wheels: bp.wheels.map((i) => objs[i]),
      figures: bp.figures.map((f) => ({
        node: objs[f.node], legL: objs[f.legL], legR: objs[f.legR],
        armL: f.armL >= 0 ? objs[f.armL] : new THREE.Object3D(), armR: f.armR >= 0 ? objs[f.armR] : new THREE.Object3D(),
        phase: f.phase,
      })),
      exhausts: empties(bp.marks.exhausts, 'exhaust'),
      kind,
      radius: bp.meta.radius ?? Math.max(0.3, bp.bounds.maxR * 0.9),
      height: bp.meta.height ?? bp.bounds.maxY,
      hover: HOVER[kind] || 0,
    };
  }

  function structure(def, team) {
    const bp = structureBlueprint(def, team);
    const { objs, empties } = instantiate(bp, materials);
    const root = new THREE.Group();
    root.name = 'structure:' + def.id;
    root.add(objs[0]);
    return {
      root,
      turret: bp.turret >= 0 ? objs[bp.turret] : null,
      barrel: bp.barrel >= 0 ? objs[bp.barrel] : null,
      muzzles: empties(bp.marks.muzzles, 'muzzle'),
      spinners: bp.spins.map((s) => ({ node: objs[s.node], axis: s.axis, speed: s.speed })),
      lights: empties(bp.marks.lights, 'light'),
      stacks: empties(bp.marks.stacks, 'stack'),
      doors: empties(bp.marks.doors, 'door'),
      height: bp.meta.height ?? bp.bounds.maxY,
      kind: def.type,
      footprint: footprintOf(def),
    };
  }

  /** Burnt-out husk: shares the unit's cached geometry, drawn charred with a broken pose. */
  function wreck(def) {
    let bp = null;
    const prefix = 'u|' + (def.id || def.name) + '|';
    for (const [k, v] of cache) if (k.startsWith(prefix) && k.endsWith('|' + quality)) { bp = v; break; }
    if (!bp) bp = unitBlueprint(def, { color: 0x6a6a6a, faction: def.faction });
    const { objs } = instantiate(bp, materials, materials.wreck);
    const root = new THREE.Group();
    root.name = 'wreck:' + def.id;
    const body = objs[0];
    root.add(body);
    const h = hashStr(def.id || 'w');
    const r = (i) => ((Math.imul(h ^ (i * 0x9e3779b1), 0x85ebca6b) >>> 8) & 0xffff) / 65535 - 0.5;
    const kind = bp.meta.kind;
    // glass is gone in a wreck
    body.traverse((o) => { if (o.isMesh && o.material === materials.glass) o.visible = false; });
    if (kind === 'vehicle') {
      body.rotation.set(r(1) * 0.12, 0, r(2) * 0.16);
      body.position.y = -0.03;
      if (bp.turret >= 0) {
        const t = objs[bp.turret];
        t.rotation.set(r(3) * 0.3, 0.6 + r(4) * 2.4, r(5) * 0.3);
        t.position.x += r(6) * 0.16; t.position.z += r(7) * 0.16; t.position.y += 0.02;
      }
      if (bp.barrel >= 0) objs[bp.barrel].rotation.z = -0.22 + r(8) * 0.1;
    } else if (kind === 'helo' || kind === 'jet' || kind === 'drone') {
      body.rotation.set(0.5 + r(1) * 0.5, 0, -0.16 + r(2) * 0.1);
      body.position.y = kind === 'helo' ? 0.1 : 0.12;
      for (const s of bp.spins) { const n = objs[s.node]; n.rotation.z += 0.3 + r(9) * 0.4; n.rotation.x += r(10) * 0.5; }
    } else if (kind === 'ship') {
      body.rotation.set(0.5 + r(1) * 0.3, 0, -0.14);
      body.position.y = -0.22;
    } else if (kind === 'infantry') {
      for (const f of bp.figures) {
        const n = objs[f.node];
        n.rotation.z = Math.PI / 2 * (r(f.node) > 0 ? 1 : -1);
        n.rotation.y = r(f.node + 3) * 3;
        n.position.y = 0.07;
      }
    }
    return root;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const bp of cache.values()) for (const n of bp.nodes) for (const m of n.meshes) m.geometry.dispose();
    cache.clear();
    for (const k in materials) materials[k].dispose();
  }

  /** Geometry statistics of everything built so far (debug / lab). */
  function stats() {
    let geometries = 0, triangles = 0;
    for (const bp of cache.values()) { triangles += bp.tris; for (const n of bp.nodes) geometries += n.meshes.length; }
    return { blueprints: cache.size, geometries, triangles };
  }

  return { unit, structure, wreck, materials, dispose, quality, stats, _blueprint: (def, team) => (def.type && !def.cls ? structureBlueprint(def, team) : unitBlueprint(def, team)) };
}

export default createModelKit;
