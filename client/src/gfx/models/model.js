// Model authoring container -> cached blueprint -> cheap instances.
//
// Builders author everything in MODEL space. A node has an origin (its pivot, also in model
// space); at finish() each node's geometry is re-based onto its pivot and the node is placed
// relative to its parent, so the engine can rotate turrets / rotors / legs about their pivots.

import * as THREE from 'three';
import { Geo } from './geo.js';

export class Model {
  constructor(ctx) {
    this.ctx = ctx;
    this.nodes = new Map();
    this.order = [];
    this.marks = { muzzles: [], exhausts: [], lights: [], stacks: [], doors: [] };
    this.spins = [];
    this.wheelNodes = [];
    this.figures = [];
    this.turretNode = null;
    this.barrelNode = null;
    this.node('body', [0, 0, 0], null);
  }

  node(name, at = [0, 0, 0], parent = 'body') {
    let n = this.nodes.get(name);
    if (!n) {
      n = { name, at, parent, sinks: [] };
      this.nodes.set(name, n);
      this.order.push(n);
    }
    return n;
  }

  /** Geometry sink for (node, material). Creates the node on first use. */
  part(name, o = {}) {
    const n = this.node(name, o.at, o.parent === undefined ? 'body' : o.parent);
    const mat = o.mat || 'paint';
    let s = n.sinks.find((k) => k.mat === mat);
    if (!s) {
      const plain = mat !== 'paint';
      s = { mat, geo: new Geo(this.ctx, { alpha: mat === 'rotorDisc', shade: !plain }) };
      n.sinks.push(s);
    }
    return s.geo;
  }

  mark(kind, x, y, z, node = 'body') { this.marks[kind].push({ node, p: [x, y, z] }); }
  muzzle(x, y, z, node = 'body') { this.mark('muzzles', x, y, z, node); }
  exhaust(x, y, z, node = 'body') { this.mark('exhausts', x, y, z, node); }
  light(x, y, z, node = 'body') { this.mark('lights', x, y, z, node); }
  stack(x, y, z, node = 'body') { this.mark('stacks', x, y, z, node); }
  door(x, y, z, node = 'body') { this.mark('doors', x, y, z, node); }
  spin(node, axis, speed) { this.spins.push({ node, axis, speed }); }

  finish(meta) {
    const index = new Map();
    const nodes = [];
    let tris = 0;
    let minY = Infinity, maxY = -Infinity, maxR = 0;
    for (const n of this.order) {
      const meshes = [];
      for (const s of n.sinks) {
        if (s.geo.empty) continue;
        if (s.mat !== 'rotorDisc') {
          if (s.geo.bMaxY > maxY) maxY = s.geo.bMaxY;
          if (s.geo.bMinY < minY) minY = s.geo.bMinY;
          if (s.geo.bMaxR > maxR) maxR = s.geo.bMaxR;
        }
        tris += s.geo.tris;
        meshes.push({ mat: s.mat, geometry: s.geo.build(n.at) });
      }
      const p = n.parent ? this.nodes.get(n.parent) : null;
      index.set(n.name, nodes.length);
      nodes.push({
        name: n.name,
        parent: p ? index.get(p.name) : -1,
        pos: p ? [n.at[0] - p.at[0], n.at[1] - p.at[1], n.at[2] - p.at[2]] : [0, 0, 0],
        meshes,
      });
    }
    const marks = {};
    for (const k in this.marks) {
      marks[k] = this.marks[k].map((m) => {
        const n = this.nodes.get(m.node) || this.nodes.get('body');
        return { node: index.get(n.name), pos: [m.p[0] - n.at[0], m.p[1] - n.at[1], m.p[2] - n.at[2]] };
      });
    }
    const ix = (name) => (name && index.has(name) ? index.get(name) : -1);
    return {
      nodes,
      marks,
      spins: this.spins.map((s) => ({ node: ix(s.node), axis: s.axis, speed: s.speed })).filter((s) => s.node >= 0),
      wheels: this.wheelNodes.map(ix).filter((i) => i >= 0),
      figures: this.figures.map((f) => ({ node: ix(f.node), legL: ix(f.legL), legR: ix(f.legR), armL: ix(f.armL), armR: ix(f.armR), phase: f.phase })),
      turret: ix(this.turretNode),
      barrel: ix(this.barrelNode),
      tris,
      bounds: { minY, maxY, maxR },
      meta: { ...meta },
    };
  }
}

const SHADOW = {
  paint: [true, true],
  glass: [true, false],
  emissive: [false, false],
  rotorDisc: [false, false],
};

/**
 * Create scene objects from a blueprint. `mats` maps material key -> THREE.Material.
 * `override` (optional) replaces every lit material (used by wrecks).
 */
export function instantiate(bp, mats, override) {
  const objs = new Array(bp.nodes.length);
  for (let i = 0; i < bp.nodes.length; i++) {
    const n = bp.nodes[i];
    let obj = null;
    const isBody = i === 0;
    for (const m of n.meshes) {
      if (override && (m.mat === 'rotorDisc' || m.mat === 'emissive')) continue;
      const mesh = new THREE.Mesh(m.geometry, override && m.mat !== 'glass' ? override : mats[m.mat]);
      const sh = SHADOW[m.mat] || SHADOW.paint;
      mesh.castShadow = sh[0];
      mesh.receiveShadow = sh[1];
      if (m.mat === 'rotorDisc') mesh.renderOrder = 2;
      if (!obj && !isBody) obj = mesh;
      else {
        if (!obj) obj = new THREE.Group();
        obj.add(mesh);
      }
    }
    if (!obj) obj = isBody ? new THREE.Group() : new THREE.Object3D();
    obj.name = n.name;
    obj.position.set(n.pos[0], n.pos[1], n.pos[2]);
    if (n.parent >= 0) objs[n.parent].add(obj);
    objs[i] = obj;
  }
  const empties = (list, tag) => list.map((m, k) => {
    const o = new THREE.Object3D();
    o.name = tag + k;
    o.position.set(m.pos[0], m.pos[1], m.pos[2]);
    objs[m.node].add(o);
    return o;
  });
  return { objs, empties };
}
