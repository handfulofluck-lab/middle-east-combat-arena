// Mirrors the sim's units, structures and projectiles into the scene:
// tick-interpolated movement, terrain-aligned hulls, turret tracking, recoil,
// rotor/wheel/walk animation, weapon effects, death and damage states,
// selection markers, placement ghost and the 2D status overlay.
import * as THREE from 'three';
import {
  CELL, S, WU, WATER_Y, clamp, lerp, damp, angleDelta, hash2,
} from './util.js';
import {
  wuToX, wuToZ, structCenter, fogVisibleAt, fogSeenAt, projectPoint,
} from './engine.js';
import { canPlaceReason } from '../sim/index.js';
import { createSimpleKit } from './simplekit.js';
import { createModelKit } from './models.js';

const INF_CLS = new Set(['Infantry', 'AT infantry', 'AA infantry', 'SF', 'Engineer']);
const SLOT_COLORS = [0x3d9bff, 0xff5a4d, 0x56d364, 0xf2cc60, 0xbc8cff, 0xff9d4d];
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = { x: 0, y: 0, depth: 0 };

// how each shooter class looks when it fires
function weaponFor(cls, def) {
  switch (cls) {
    case 'Infantry': case 'SF': case 'Engineer': return 'rifle';
    case 'AT infantry': return 'atgm';
    case 'AA infantry': return 'sam_small';
    case 'MBT': case 'Light tank': return 'cannon';
    case 'SPG': return 'howitzer';
    case 'Naval': return 'naval';
    case 'IFV': case 'APC': case 'Light vehicle': case 'Tank escort': return 'autocannon';
    case 'Mobile AA': return 'flak';
    case 'MLRS': return 'mlrs';
    case 'Missile': return 'bigmissile';
    case 'Fighter': return 'aam';
    case 'Strike jet': return 'bomb';
    case 'UAV': return 'atgm';
    case 'Attack helo': return 'rockets';
    case 'Transport helo': return 'rifle';
    default: break;
  }
  if (def) {
    const n = (def.name || '').toLowerCase();
    if (/hmg|bunker/.test(n)) return 'mg';
    if (/atgm/.test(n)) return 'atgm';
    if (/aa gun/.test(n)) return 'flak';
    return 'sam';
  }
  return 'rifle';
}

export function createEntities(gl) {
  const scene = gl.scene;
  const fx = gl.fx;
  const root = new THREE.Group();
  root.name = 'entities';
  scene.add(root);

  // the procedural model library; the box kit stays as a per-model safety net
  const fallbackKit = createSimpleKit();
  let kit = fallbackKit;
  try {
    kit = createModelKit({ quality: gl.quality.name === 'low' ? 'low' : 'high' });
  } catch (e) {
    if (globalThis.__glErrors) globalThis.__glErrors.push('model kit: ' + (e && e.message));
  }
  const units = new Map();    // unit id -> record
  const structs = new Map();  // structure id -> record
  const shots = new Map();    // projectile id -> record
  const missiles = [];        // self-driven visual missiles
  const wrecks = [];
  let state = null;
  let lastTick = -1, tickTime = 0, tickDur = 0.1, newTick = false;
  let lost = [];              // per-player {units, structs} counters last seen
  let frameNo = 0;
  const structBySrc = new Map(); // "x,y" (wu centre) -> structure record

  // ---- team colours -------------------------------------------------------
  const teamCache = new Map();
  function teamOf(owner) {
    let t = teamCache.get(owner);
    if (t) return t;
    const p = state.players[owner];
    let color = 0x9a9a9a, faction = 'All';
    if (p) {
      faction = p.faction;
      const f = state.data.factions[p.faction];
      color = f ? parseInt(String(f.color).replace('#', ''), 16) : SLOT_COLORS[owner % 6];
      // two players on the same faction: keep them tellable apart
      for (const q of state.players) {
        if (q.slot < p.slot && q.faction === p.faction) { color = SLOT_COLORS[owner % 6]; break; }
      }
    }
    t = { color, faction };
    teamCache.set(owner, t);
    return t;
  }

  function isHostile(owner) {
    if (owner < 0) return true;
    const me = state.players[gl.localSlot], p = state.players[owner];
    if (!me || !p) return false;
    return p.team !== me.team;
  }

  // ---- model kit ----------------------------------------------------------
  function safeUnit(def, team) {
    try { return kit.unit(def, team); } catch (e) {
      if (globalThis.__glErrors) globalThis.__glErrors.push('kit.unit ' + def.id + ': ' + (e && e.message));
      return fallbackKit.unit(def, team);
    }
  }
  function safeStruct(def, team) {
    try { return kit.structure(def, team); } catch (e) {
      if (globalThis.__glErrors) globalThis.__glErrors.push('kit.structure ' + def.id + ': ' + (e && e.message));
      return fallbackKit.structure(def, team);
    }
  }
  function setKit(k) {
    kit = k;
    for (const [, r] of units) root.remove(r.root);
    for (const [, r] of structs) root.remove(r.root);
    units.clear(); structs.clear();
    ghostCache.clear();
  }

  // ---- selection markers --------------------------------------------------
  const ringGeo = new THREE.RingGeometry(0.9, 1.0, 40).rotateX(-Math.PI / 2);
  const frameGeo = (() => {
    // square bracket frame: four corner Ls
    const parts = [];
    const L = 0.34, T = 0.045;
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = new THREE.PlaneGeometry(L, T).rotateX(-Math.PI / 2);
      a.translate(sx * (1 - L / 2), 0, sz * (1 - T / 2));
      const b = new THREE.PlaneGeometry(T, L).rotateX(-Math.PI / 2);
      b.translate(sx * (1 - T / 2), 0, sz * (1 - L / 2));
      parts.push(a, b);
    }
    const pos = [], idx = [];
    let base = 0;
    for (const g of parts) {
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
      for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + base);
      base += p.count;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  })();
  const selMat = (hex) => new THREE.MeshBasicMaterial({
    color: hex, transparent: true, opacity: 0.95, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, toneMapped: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  });
  const selOwn = selMat(0x8ff5e4), selFoe = selMat(0xff6a4d), selAlly = selMat(0x8fc4ff);
  selOwn.color.multiplyScalar(1.6);
  const selPool = [];
  const selGroup = new THREE.Group();
  selGroup.renderOrder = 6;
  scene.add(selGroup);
  function selMesh(i, geo) {
    let m = selPool[i];
    if (!m) {
      m = new THREE.Mesh(geo, selOwn);
      m.renderOrder = 6;
      m.matrixAutoUpdate = true;
      selGroup.add(m);
      selPool[i] = m;
    }
    if (m.geometry !== geo) m.geometry = geo;
    return m;
  }

  // ---- placement ghost ----------------------------------------------------
  const ghostCache = new Map();
  const ghostOk = new THREE.MeshBasicMaterial({ color: 0x5fe3d0, transparent: true, opacity: 0.42, depthWrite: false, toneMapped: false });
  const ghostBad = new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.42, depthWrite: false, toneMapped: false });
  const padGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const ghostPad = new THREE.Mesh(padGeo, new THREE.MeshBasicMaterial({
    color: 0x5fe3d0, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  const ghostFrame = new THREE.Mesh(frameGeo, selMat(0x8ff5e4));
  const rangeRing = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0.55, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide,
  }));
  const ghost = new THREE.Group();
  ghost.add(ghostPad, ghostFrame);
  ghost.visible = false;
  rangeRing.visible = false;
  scene.add(ghost, rangeRing);
  let ghostModel = null, ghostId = null;

  function updateGhost() {
    const game = gl.game;
    const pl = game.placement;
    if (!pl || !game.mouse || !game.mouse.inside || game.overlay || gl.camLock || !state || gl.attract) {
      ghost.visible = false; rangeRing.visible = false;
      return;
    }
    const def = state.structDefs[pl.structId];
    if (!def) { ghost.visible = false; return; }
    const w = gl.screenToWorld(game.mouse.sx, game.mouse.sy);
    const cx = Math.floor(w.x / CELL) - (def.fp >> 1);
    const cy = Math.floor(w.y / CELL) - (def.fp >> 1);
    const ok = !canPlaceReason(state, game.playerSlot || 0, def, cx, cy);
    const x = (cx + def.fp / 2 - gl.mapW / 2) * S, z = (cy + def.fp / 2 - gl.mapH / 2) * S;
    const y = Math.max(WATER_Y, gl.hf.heightAt(x, z));
    if (ghostId !== def.id) {
      if (ghostModel) ghost.remove(ghostModel);
      let m = ghostCache.get(def.id);
      if (!m) {
        m = safeStruct(def, teamOf(game.playerSlot || 0)).root;
        m.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
        ghostCache.set(def.id, m);
      }
      ghostModel = m; ghostId = def.id;
      ghost.add(m);
    }
    const mat = ok ? ghostOk : ghostBad;
    ghostModel.traverse((o) => { if (o.isMesh) o.material = mat; });
    ghost.visible = true;
    ghost.position.set(x, y, z);
    const side = def.fp * S;
    ghostPad.scale.set(side, 1, side);
    ghostPad.position.y = 0.06;
    ghostPad.material.color.setHex(ok ? 0x5fe3d0 : 0xff5a3c);
    ghostFrame.scale.set(side / 2, 1, side / 2);
    ghostFrame.position.y = 0.08;
    ghostFrame.material = ok ? selOwn : selFoe;
    if (def.rangeWu) {
      rangeRing.visible = true;
      rangeRing.position.set(x, y + 0.25, z);
      rangeRing.scale.setScalar(def.rangeWu * WU);
    } else rangeRing.visible = false;
  }

  // ---- units --------------------------------------------------------------
  function createUnit(u, def) {
    const team = teamOf(u.owner);
    const m = safeUnit(def, team);
    const rec = Object.assign({}, m, {
      id: u.id, defId: u.defId, def, owner: u.owner, isUnit: true,
      rx: u.x, ry: u.y, px: u.x, py: u.y, cx: u.x, cy: u.y,
      yaw: (hash2(u.id, 3, 1) - 0.5) * 6.28, speed: 0, turn: 0, aim: 0, recoil: 0,
      pitch: 0, roll: 0, alt: 0, walk: 0, phase: hash2(u.id, 7, 3) * 6.28,
      lastHp: u.hp, lastVisible: false, muzzleI: 0, emitAcc: 0, smokeAcc: 0,
      weapon: weaponFor(def.cls, null), barrelX: m.barrel ? m.barrel.position.x : 0,
      inf: INF_CLS.has(def.cls), air: def.domain === 'Air', sea: def.domain === 'Sea',
      born: gl.time,
    });
    // face the map centre on spawn so fresh units do not all point east
    const mx = state.map.w * CELL / 2 - u.x, my = state.map.h * CELL / 2 - u.y;
    if (Math.abs(mx) + Math.abs(my) > 1) rec.yaw = Math.atan2(-my, mx);
    // infantry are drawn larger than life so squads read at RTS distance
    if (rec.inf) { rec.root.scale.setScalar(1.4); rec.radius *= 1.4; rec.height *= 1.4; }
    rec.root.position.set(wuToX(gl, u.x), 0, wuToZ(gl, u.y));
    rec.root.rotation.y = rec.yaw;
    root.add(rec.root);
    units.set(u.id, rec);
    return rec;
  }

  function targetOf(u) {
    const o = u.order;
    if (!o) return null;
    const id = o.type === 'attackTarget' ? o.targetId : (o.enemyId || 0);
    if (!id) return null;
    const e = state.units[id] || state.structures[id];
    return (e && e.hp > 0) ? e : null;
  }

  function entityPoint(e, out) {
    if (e.cx !== undefined && e.fp !== undefined) {
      const c = structCenter(gl, e);
      const r = structs.get(e.id);
      return out.set(c.x, (r ? r.root.position.y + r.height * 0.5 : 1), c.z);
    }
    const r = units.get(e.id);
    if (r) return out.set(r.root.position.x, r.root.position.y + r.height * 0.5, r.root.position.z);
    const x = wuToX(gl, e.x), z = wuToZ(gl, e.y);
    return out.set(x, Math.max(WATER_Y, gl.hf.heightAt(x, z)) + 0.4, z);
  }

  function updateUnit(u, rec, dt, alpha, t) {
    const hf = gl.hf;
    if (newTick) {
      const jump = Math.abs(u.x - rec.cx) + Math.abs(u.y - rec.cy);
      if (jump > CELL * 5) { rec.rx = u.x; rec.ry = u.y; }
      rec.px = rec.rx; rec.py = rec.ry;
      rec.vx = u.x - rec.cx; rec.vy = u.y - rec.cy;
      rec.cx = u.x; rec.cy = u.y;
    }
    rec.rx = lerp(rec.px, rec.cx, alpha);
    rec.ry = lerp(rec.py, rec.cy, alpha);
    const x = wuToX(gl, rec.rx), z = wuToZ(gl, rec.ry);
    const moving = (rec.vx || 0) !== 0 || (rec.vy || 0) !== 0;
    const sp = Math.hypot(rec.vx || 0, rec.vy || 0) * WU / tickDur;
    rec.speed = damp(rec.speed, moving ? Math.min(sp, 60) : 0, 6, dt);

    // heading
    let want = rec.yaw;
    if (moving && Math.hypot(rec.vx, rec.vy) > 0.5) want = Math.atan2(-rec.vy, rec.vx);
    const tgt = targetOf(u);
    let tp = null;
    if (tgt) {
      tp = entityPoint(tgt, _v2);
      if (!rec.turret && (rec.air || rec.inf || !moving)) {
        const d = Math.hypot(tp.x - x, tp.z - z);
        if (d < (rec.def.rangeWu || 0) * WU * 1.4 || !moving) want = Math.atan2(-(tp.z - z), tp.x - x);
      }
    }
    const dy = angleDelta(rec.yaw, want);
    const rate = rec.inf ? 12 : rec.air ? (rec.kind === 'helo' ? 3.2 : 2.4) : rec.sea ? 1.6 : 4.2;
    const step = clamp(dy, -rate * dt, rate * dt);
    rec.yaw += step;
    rec.turn = damp(rec.turn, step / Math.max(dt, 1e-4), 5, dt);
    rec.root.rotation.y = rec.yaw;

    // vertical placement + hull attitude
    let y, pitch = 0, roll = 0;
    const gh = Math.max(WATER_Y, hf.heightAt(x, z));
    if (rec.air) {
      const parked = u.rearming > 0;
      const cruise = Math.max(rec.hover, gh + rec.hover * 0.72);
      rec.alt = damp(rec.alt || cruise, parked ? gh + 0.25 : cruise, parked ? 2.2 : 1.6, dt);
      y = rec.alt + (rec.kind === 'helo' && !parked ? Math.sin(t * 1.7 + rec.phase) * 0.09 : 0);
      roll = clamp(-rec.turn * (rec.kind === 'helo' ? 0.16 : 0.42), -0.75, 0.75);
      pitch = rec.kind === 'helo' ? -clamp(rec.speed * 0.014, 0, 0.24) : clamp(rec.turn * 0.02, -0.1, 0.1);
    } else if (rec.sea) {
      y = WATER_Y + Math.sin(t * 1.1 + rec.phase) * 0.045 - 0.02;
      pitch = Math.sin(t * 0.8 + rec.phase) * 0.018 + clamp(rec.speed * 0.004, 0, 0.04);
      roll = Math.sin(t * 0.63 + rec.phase * 1.7) * 0.03 - clamp(rec.turn * 0.05, -0.08, 0.08);
    } else {
      y = gh;
      if (!rec.inf) {
        const L = rec.radius * 0.7, Wd = rec.radius * 0.45;
        const c = Math.cos(rec.yaw), s = Math.sin(rec.yaw);
        const hF = Math.max(WATER_Y, hf.heightAt(x + c * L, z - s * L)) - Math.max(WATER_Y, hf.heightAt(x - c * L, z + s * L));
        const hR = Math.max(WATER_Y, hf.heightAt(x + s * Wd, z + c * Wd)) - Math.max(WATER_Y, hf.heightAt(x - s * Wd, z - c * Wd));
        pitch = Math.atan2(hF, 2 * L) - rec.recoil * 0.035;
        roll = -Math.atan2(hR, 2 * Wd);
      }
    }
    rec.root.position.set(x, y, z);
    rec.pitch = damp(rec.pitch, pitch, 9, dt);
    rec.roll = damp(rec.roll, roll, 9, dt);
    rec.body.rotation.z = rec.pitch;
    rec.body.rotation.x = rec.roll;

    // turret + recoil
    if (rec.turret) {
      let local = 0;
      if (tp) local = angleDelta(0, Math.atan2(-(tp.z - z), tp.x - x) - rec.yaw);
      rec.aim += clamp(angleDelta(rec.aim, local), -5 * dt, 5 * dt);
      rec.turret.rotation.y = rec.aim;
    }
    if (rec.recoil > 0) rec.recoil = Math.max(0, rec.recoil - dt * 5.5);
    if (rec.barrel) rec.barrel.position.x = rec.barrelX - rec.recoil * 0.18;

    // spinning parts
    for (const r of rec.rotors) r.node.rotation[r.axis] += r.speed * dt * (u.rearming > 0 ? 0.25 : 1);
    if (rec.wheels && rec.wheels.length && rec.speed > 0.05) {
      const w = rec.speed * dt * 3.2;
      for (const wn of rec.wheels) wn.rotation.z -= w;
    }
    // infantry walk cycle
    if (rec.figures) {
      const mv = rec.speed > 0.3;
      rec.walk += dt * (mv ? 9.5 : 1.8);
      for (const f of rec.figures) {
        const sw = mv ? Math.sin(rec.walk + f.phase) * 0.6 : Math.sin(t * 1.6 + f.phase) * 0.03;
        if (f.legL) f.legL.rotation.z = sw;
        if (f.legR) f.legR.rotation.z = -sw;
        if (f.armL) f.armL.rotation.z = -sw * 0.5;
        if (f.armR) f.armR.rotation.z = sw * 0.3;
        if (f.baseY === undefined) f.baseY = f.node.position.y;
        f.node.position.y = f.baseY + (mv ? Math.abs(Math.sin(rec.walk + f.phase)) * 0.025 : 0);
      }
    }
  }

  function unitAmbientFx(u, rec, dt, visible) {
    if (!visible) return;
    const pos = rec.root.position;
    const dark = gl.look && (gl.look.night || gl.look.todName === 'dusk');
    // tyre / track marks pressed into the sand
    if (gl.quality.tracks && rec.kind === 'vehicle' && rec.speed > 0.6) {
      rec.trackAcc = (rec.trackAcc || 0) + rec.speed * dt;
      if (rec.trackAcc > 0.9) {
        rec.trackAcc = 0;
        if (gl.hf.waterDist(pos.x, pos.z) < -0.4 && gl.hf.rockDist(pos.x, pos.z) < -0.2) {
          const c = Math.cos(rec.yaw), sn = Math.sin(rec.yaw);
          const w = rec.radius * 0.36;
          for (const side of [-1, 1]) {
            fx.decal({
              x: pos.x + sn * w * side - c * rec.radius * 0.5, z: pos.z + c * w * side + sn * rec.radius * 0.5,
              rot: -rec.yaw, s0: 1.5, s1: 1.5, life: 14, c: [0.16, 0.12, 0.08, 0.3], frame: fx.FRAMES.spark,
            });
          }
        }
      }
    }
    // headlights after dark
    if (dark && rec.kind === 'vehicle' && gl.time >= (rec.nextHead || 0)) {
      rec.nextHead = gl.time + 0.06;
      const c = Math.cos(rec.yaw), sn = Math.sin(rec.yaw);
      const hx = pos.x + c * rec.radius * 0.95, hz = pos.z - sn * rec.radius * 0.95;
      fx.emit({ x: hx, y: pos.y + rec.height * 0.45, z: hz, life: 0.12, s0: 0.34, s1: 0.3, c: [3.4, 3.0, 2.2, 0.9], c2: [3, 2.6, 2, 0], frame: fx.FRAMES.glow, add: true });
      fx.decal({ x: pos.x + c * (rec.radius + 2.2), z: pos.z - sn * (rec.radius + 2.2), s0: 5.5, s1: 5.5, life: 0.16, c: [0.9, 0.8, 0.55, 0.42], frame: fx.FRAMES.glow, add: true });
    }
    // movement dust / wake
    if (rec.speed > 1.2 && !rec.air) {
      rec.emitAcc += dt * rec.speed * (rec.inf ? 0.25 : rec.sea ? 1.6 : 0.85);
      if (rec.emitAcc > 1) {
        rec.emitAcc = 0;
        const c = Math.cos(rec.yaw), s = Math.sin(rec.yaw);
        const bx = pos.x - c * rec.radius * 0.7, bz = pos.z + s * rec.radius * 0.7;
        if (rec.sea) {
          fx.emit({ x: bx, y: WATER_Y + 0.05, z: bz, vx: fx.rr(-0.3, 0.3), vy: 0.15, vz: fx.rr(-0.3, 0.3), life: fx.rr(1.2, 2.2), s0: 0.5, s1: fx.rr(1.6, 2.6), c: [0.92, 0.97, 1, 0.5], c2: [0.9, 0.96, 1, 0], drag: 1.5, rot: fx.rnd() * 6, frame: fx.FRAMES.dust });
        } else if (gl.hf.waterDist(bx, bz) < -0.3) {
          fx.dust(bx, pos.y, bz, rec.inf ? 1 : 2, 0.5, 0.6);
        }
      }
    }
    // rotor wash when a helicopter is low
    if (rec.kind === 'helo' && (frameNo + rec.id) % 9 === 0) {
      const gy = Math.max(WATER_Y, gl.hf.heightAt(pos.x, pos.z));
      if (pos.y - gy < 4.5 && gl.hf.waterDist(pos.x, pos.z) < -0.5) {
        const a = fx.rnd() * 6.283;
        fx.dust(pos.x + Math.cos(a) * 1.2, gy, pos.z + Math.sin(a) * 1.2, 1, 2.2, 0.3);
      }
    }
    // jet exhaust glow
    if (rec.kind === 'jet' && rec.exhausts.length && (frameNo & 1) === 0) {
      for (const e of rec.exhausts) {
        e.getWorldPosition(_v);
        fx.emit({ x: _v.x, y: _v.y, z: _v.z, life: 0.1, s0: 0.42, s1: 0.2, c: [5, 2.6, 0.9, 0.9], c2: [2, 0.6, 0.2, 0], frame: fx.FRAMES.glow, add: true });
      }
    }
    // damage smoke
    if (!rec.inf && u.hp < u.maxHp * 0.4) {
      rec.smokeAcc += dt * (u.hp < u.maxHp * 0.2 ? 9 : 4);
      if (rec.smokeAcc > 1) {
        rec.smokeAcc = 0;
        fx.smokePuff(pos.x, pos.y + rec.height * 0.7, pos.z, 0.5, true, fx.rr(1, 1.8));
        if (u.hp < u.maxHp * 0.2 && fx.rnd() < 0.5) fx.fire(pos.x, pos.y + rec.height * 0.6, pos.z, 0.4);
      }
    }
  }

  function unitDeath(rec) {
    const p = rec.root.position;
    const def = rec.def;
    if (rec.inf) {
      fx.dust(p.x, p.y, p.z, 5, 1.2, 1);
      fx.sparks(p.x, p.y + 0.3, p.z, 4, 3, 0.1);
      fx.decal({ x: p.x, z: p.z, s0: 0.9, s1: 1, life: 40, rot: fx.rnd() * 6, c: [0.04, 0.03, 0.03, 0.4], frame: fx.FRAMES.smoke });
      return;
    }
    const size = rec.sea ? 4.2 : rec.air ? 2.6 : (def.cls === 'MBT' || def.cls === 'MCV' || def.cls === 'SPG' || def.cls === 'Missile') ? 3.4 : 2.6;
    fx.explosion(p.x, p.y + (rec.air ? 0 : 0.3), p.z, size, rec.air ? 'air' : rec.sea ? 'water' : 'ground');
    // wreck
    let w = null;
    try { w = kit.wreck ? kit.wreck(def) : null; } catch (e) { w = null; }
    if (!w) return;
    w.position.copy(p);
    w.rotation.y = rec.yaw;
    root.add(w);
    const item = { obj: w, life: rec.sea ? 9 : 55, max: rec.sea ? 9 : 55, sea: rec.sea, air: rec.air, vy: 0, spin: (fx.rnd() - 0.5) * 3, smoke: 0 };
    if (rec.air) { item.vx = Math.cos(rec.yaw) * rec.speed * 0.6; item.vz = -Math.sin(rec.yaw) * rec.speed * 0.6; }
    wrecks.push(item);
  }

  function updateWrecks(dt) {
    for (let i = wrecks.length - 1; i >= 0; i--) {
      const w = wrecks[i];
      w.life -= dt;
      const o = w.obj;
      if (w.air && !w.landed) {
        w.vy -= 16 * dt;
        o.position.x += (w.vx || 0) * dt; o.position.z += (w.vz || 0) * dt;
        o.position.y += w.vy * dt;
        o.rotation.z += w.spin * dt; o.rotation.x += w.spin * 0.6 * dt;
        w.smoke += dt * 30;
        if (w.smoke > 1) { w.smoke = 0; fx.smokePuff(o.position.x, o.position.y, o.position.z, 0.7, true, 1.4, 0, 0.3, 0); fx.fire(o.position.x, o.position.y, o.position.z, 0.5); }
        const gy = Math.max(WATER_Y, gl.hf.heightAt(o.position.x, o.position.z));
        if (o.position.y <= gy + 0.1) {
          o.position.y = gy; w.landed = true;
          fx.explosion(o.position.x, gy + 0.2, o.position.z, 2.4, gy <= WATER_Y + 0.01 ? 'water' : 'ground');
          if (gy <= WATER_Y + 0.01) w.sea = true, w.life = Math.min(w.life, 6);
        }
      } else if (w.sea) {
        o.position.y -= dt * 0.16;
        o.rotation.z += dt * 0.05;
      } else {
        if (w.life > w.max - 14) {
          w.smoke += dt * 5;
          if (w.smoke > 1) {
            w.smoke = 0;
            fx.smokePuff(o.position.x, o.position.y + 0.5, o.position.z, 0.6, true, fx.rr(1.6, 2.6));
            if (w.life > w.max - 6) fx.fire(o.position.x + fx.rr(-0.3, 0.3), o.position.y + 0.35, o.position.z + fx.rr(-0.3, 0.3), 0.45);
          }
        }
        if (w.life < 4) o.position.y -= dt * 0.22;
      }
      if (w.life <= 0) {
        root.remove(o);   // geometry belongs to the kit's cache
        wrecks.splice(i, 1);
      }
    }
  }

  // ---- structures ---------------------------------------------------------
  const plinthGeo = new THREE.BoxGeometry(1, 2.4, 1).translate(0, -1.17, 0);
  plinthGeo.userData.shared = true;
  const plinthMat = new THREE.MeshStandardMaterial({ color: 0x77726a, roughness: 0.95, metalness: 0 });
  plinthMat.userData.shared = true;
  function createStruct(s, def) {
    const team = teamOf(s.owner);
    const m = safeStruct(def, team);
    const rec = Object.assign({}, m, {
      id: s.id, defId: s.defId, def, owner: s.owner, isUnit: false,
      lastHp: s.hp, lastVisible: false, aim: 0, recoil: 0, muzzleI: 0,
      born: gl.time, smokeAcc: 0, blink: hash2(s.id, 1, 9) * 6,
      weapon: weaponFor('', def), barrelX: m.barrel ? m.barrel.position.x : 0,
      radius: s.fp * S * 0.5,
    });
    const c = structCenter(gl, s);
    // sit on the mean ground height of the footprint
    let h = 0, n = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        h += Math.max(WATER_Y, gl.hf.heightAt(c.x + dx * s.fp * 0.6, c.z + dz * s.fp * 0.6)); n++;
      }
    }
    rec.groundY = h / n;
    rec.root.position.set(c.x, rec.groundY, c.z);
    // a concrete plinth hides the gap between a level building and sloped ground
    const plinth = new THREE.Mesh(plinthGeo, plinthMat);
    plinth.scale.set(s.fp * S * 0.93, 1, s.fp * S * 0.93);
    plinth.receiveShadow = true;
    rec.root.add(plinth);
    if (def.type !== 'Core' && def.type !== 'SW') rec.root.rotation.y = ((s.id * 37) % 4) * (Math.PI / 2);
    root.add(rec.root);
    structs.set(s.id, rec);
    structBySrc.set(Math.round(s.cx * CELL + s.fp * (CELL / 2)) + ',' + Math.round(s.cy * CELL + s.fp * (CELL / 2)), rec);
    if (gl.world && gl.world.props.userData.clearCells) gl.world.props.userData.clearCells(s.cx, s.cy, s.fp);
    // beacon glow sprites
    rec.beacons = [];
    return rec;
  }

  function structDeath(rec, s) {
    const p = rec.root.position;
    const r = rec.radius;
    fx.explosion(p.x, p.y + 0.5, p.z, 4.5 + r * 0.6, 'ground');
    for (let k = 0; k < 5; k++) {
      fx.after(0.1 + k * 0.13, () => {
        fx.explosion(p.x + fx.rr(-r, r) * 0.7, p.y + fx.rr(0.3, 1.5), p.z + fx.rr(-r, r) * 0.7, fx.rr(1.6, 3.2), 'ground');
      });
    }
    fx.decal({ x: p.x, z: p.z, s0: r * 3.2, s1: r * 3.4, life: 140, rot: fx.rnd() * 6, c: [0.02, 0.018, 0.015, 0.8], frame: fx.FRAMES.smoke });
    void s;
  }

  // ---- weapons ------------------------------------------------------------
  function muzzlePoint(rec, out) {
    if (rec.muzzles && rec.muzzles.length) {
      const m = rec.muzzles[rec.muzzleI++ % rec.muzzles.length];
      m.getWorldPosition(out);
      return out;
    }
    return out.set(rec.root.position.x, rec.root.position.y + rec.height * 0.6, rec.root.position.z);
  }

  function launchMissile(o) {
    missiles.push(Object.assign({ t: 0, acc: 0 }, o));
  }

  function updateMissiles(dt) {
    for (let i = missiles.length - 1; i >= 0; i--) {
      const m = missiles[i];
      if (m.delay > 0) { m.delay -= dt; continue; }
      m.t += dt / m.dur;
      const t = Math.min(1, m.t);
      const e = m.ease ? t * t * (3 - 2 * t) : t;
      const x = lerp(m.x0, m.x1, e), z = lerp(m.z0, m.z1, e);
      const y = lerp(m.y0, m.y1, e) + m.arc * 4 * t * (1 - t);
      const s = m.size;
      fx.emit({ x, y, z, life: 0.09, s0: s * 0.9, s1: s * 0.5, c: m.glow || [7, 3.6, 1.2, 1], c2: [3, 1, 0.2, 0], frame: fx.FRAMES.glow, add: true });
      m.acc += dt * (m.trail || 60);
      while (m.acc > 1) {
        m.acc -= 1;
        fx.emit({
          x: x + fx.rr(-0.04, 0.04), y: y + fx.rr(-0.04, 0.04), z: z + fx.rr(-0.04, 0.04),
          vx: fx.rr(-0.15, 0.15), vy: fx.rr(0.05, 0.3), vz: fx.rr(-0.15, 0.15),
          life: fx.rr(0.7, 1.5) * (m.smokeLife || 1), s0: s * 0.35, s1: s * fx.rr(0.9, 1.5),
          c: [0.82, 0.8, 0.78, 0.42], c2: [0.6, 0.6, 0.6, 0], drag: 1, rot: fx.rnd() * 6, frame: fx.FRAMES.smoke,
        });
      }
      if (m.t >= 1) {
        if (m.onHit) m.onHit(m.x1, m.y1, m.z1);
        missiles.splice(i, 1);
      }
    }
  }

  // a new render-only tracer appeared in the sim: stage the matching effect
  function fire(pr) {
    const srcRec = pr.srcUnitId ? units.get(pr.srcUnitId) : structBySrc.get(pr.sx + ',' + pr.sy);
    const srcVisible = fogVisibleAt(gl, pr.sx, pr.sy) || !isHostile(pr.owner);
    const dstVisible = fogVisibleAt(gl, pr.tx, pr.ty);
    if (!srcVisible && !dstVisible) return;
    const weapon = srcRec ? srcRec.weapon : 'rifle';
    // origin
    const from = _v;
    if (srcRec && srcRec.root.visible) muzzlePoint(srcRec, from);
    else { const x = wuToX(gl, pr.sx), z = wuToZ(gl, pr.sy); from.set(x, Math.max(WATER_Y, gl.hf.heightAt(x, z)) + 0.6, z); }
    // destination: the shooter's current target if known, else the ground point
    let tx = wuToX(gl, pr.tx), tz = wuToZ(gl, pr.ty);
    let ty = Math.max(WATER_Y, gl.hf.heightAt(tx, tz)) + 0.35;
    let airTarget = false;
    const su = pr.srcUnitId ? state.units[pr.srcUnitId] : null;
    const tgt = su ? targetOf(su) : null;
    if (tgt) {
      const tr = units.get(tgt.id) || structs.get(tgt.id);
      if (tr) { ty = tr.root.position.y + tr.height * 0.45; airTarget = !!tr.air; }
    } else if (!su) {
      // structure fire: find the nearest unit record to the impact point
      let best = null, bd = 2.2 * 2.2;
      for (const [, r] of units) {
        const d = (r.root.position.x - tx) ** 2 + (r.root.position.z - tz) ** 2;
        if (d < bd) { bd = d; best = r; }
      }
      if (best) { ty = best.root.position.y + best.height * 0.45; airTarget = !!best.air; }
    }
    const fx0 = from.x, fy0 = from.y, fz0 = from.z;
    const dx = tx - fx0, dyv = ty - fy0, dz = tz - fz0;
    const dist = Math.hypot(dx, dyv, dz) || 1;
    const ux = dx / dist, uy = dyv / dist, uz = dz / dist;
    if (srcRec) {
      srcRec.recoil = 1;
      // structure turrets snap toward what they shoot
      if (!srcRec.isUnit && srcRec.turret) srcRec.aimWant = Math.atan2(-dz, dx) - srcRec.root.rotation.y;
    }
    const hitKind = airTarget ? 'air' : 'ground';
    const jx = () => fx.rr(-0.25, 0.25);
    const audio = gl.audio;
    if (audio && srcVisible) audio.shot(weapon, fx0, fz0);
    switch (weapon) {
      case 'rifle': case 'mg': {
        const n = weapon === 'mg' ? 5 : 3;
        for (let i = 0; i < n; i++) {
          const d = i * 0.07;
          if (srcVisible) fx.after(d, () => fx.muzzle(fx0, fy0, fz0, ux, uy, uz, 0.32));
          const life = fx.streak(fx0, fy0, fz0, tx + jx(), ty + jx() * 0.5, tz + jx(), 95, 0.09, [5, 3.8, 1.6, 1], d);
          if (dstVisible) fx.after(life, () => { fx.sparks(tx + jx(), ty, tz + jx(), 2, 2.5, 0.08); if (!airTarget && fx.rnd() < 0.5) fx.dust(tx + jx(), ty - 0.3, tz + jx(), 1, 0.5, 0.6); });
        }
        break;
      }
      case 'autocannon': case 'flak': {
        for (let i = 0; i < 4; i++) {
          const d = i * 0.09;
          if (srcVisible) fx.after(d, () => fx.muzzle(fx0, fy0, fz0, ux, uy, uz, 0.6));
          const hx = tx + jx() * 1.6, hy = ty + jx(), hz = tz + jx() * 1.6;
          const life = fx.streak(fx0, fy0, fz0, hx, hy, hz, 110, 0.13, [6, 3.4, 1.0, 1], d);
          if (dstVisible) fx.after(life, () => fx.explosion(hx, hy, hz, weapon === 'flak' ? 0.9 : 0.7, hitKind));
        }
        break;
      }
      case 'cannon': case 'naval': case 'howitzer': {
        const big = weapon === 'cannon' ? 1.25 : 1.6;
        if (srcVisible) {
          fx.muzzle(fx0, fy0, fz0, ux, uy, uz, big);
          if (srcRec && srcRec.isUnit && !srcRec.sea) fx.dust(srcRec.root.position.x, srcRec.root.position.y, srcRec.root.position.z, 5, 2.2, 0.5);
        }
        if (weapon === 'howitzer') {
          launchMissile({ x0: fx0, y0: fy0, z0: fz0, x1: tx, y1: ty, z1: tz, dur: 0.75, arc: 5 + dist * 0.12, size: 0.3, trail: 0, glow: [6, 4, 2, 1], onHit: (x, y, z) => { if (dstVisible) fx.explosion(x, y, z, 2.4, hitKind); } });
        } else {
          const life = fx.streak(fx0, fy0, fz0, tx, ty, tz, 150, 0.2, [8, 5, 2, 1], 0);
          if (dstVisible) fx.after(life, () => fx.explosion(tx, ty, tz, weapon === 'naval' ? 2.3 : 1.9, hitKind));
        }
        break;
      }
      case 'mlrs': case 'rockets': {
        const n = weapon === 'mlrs' ? 6 : 4;
        for (let i = 0; i < n; i++) {
          const hx = tx + jx() * 5, hz = tz + jx() * 5;
          const hy = airTarget ? ty + jx() : Math.max(WATER_Y, gl.hf.heightAt(hx, hz)) + 0.2;
          launchMissile({
            delay: i * 0.1, x0: fx0, y0: fy0, z0: fz0, x1: hx, y1: hy, z1: hz,
            dur: weapon === 'mlrs' ? 0.9 : 0.5, arc: weapon === 'mlrs' ? 4 + dist * 0.14 : dist * 0.02, size: 0.34, trail: 70,
            onHit: (x, y, z) => { if (dstVisible) fx.explosion(x, y, z, weapon === 'mlrs' ? 1.9 : 1.4, hitKind); },
          });
          if (srcVisible) fx.after(i * 0.1, () => { fx.muzzle(fx0, fy0, fz0, ux, 0.4, uz, 0.8); fx.smokePuff(fx0 - ux * 0.6, fy0, fz0 - uz * 0.6, 0.7, false, 1.2, -ux * 2, 0.5, -uz * 2); });
        }
        break;
      }
      case 'bomb': {
        launchMissile({ x0: fx0, y0: fy0, z0: fz0, x1: tx, y1: ty, z1: tz, dur: 0.6, arc: 0, size: 0.28, trail: 14, onHit: (x, y, z) => { if (dstVisible) fx.explosion(x, y, z, 3.0, hitKind); } });
        break;
      }
      case 'bigmissile': {
        if (srcVisible) { fx.muzzle(fx0, fy0, fz0, 0, 1, 0, 1.6); fx.dust(fx0, fy0 - 0.8, fz0, 8, 3, 0.6); }
        launchMissile({ x0: fx0, y0: fy0, z0: fz0, x1: tx, y1: ty, z1: tz, dur: 1.0, arc: 8 + dist * 0.18, size: 0.6, trail: 90, smokeLife: 1.6, onHit: (x, y, z) => { if (dstVisible) fx.explosion(x, y, z, 3.6, hitKind); } });
        break;
      }
      default: { // atgm, aam, sam, sam_small
        const fast = weapon === 'sam' || weapon === 'aam';
        if (srcVisible) { fx.muzzle(fx0, fy0, fz0, ux, uy, uz, 0.8); fx.smokePuff(fx0 - ux * 0.5, fy0, fz0 - uz * 0.5, 0.6, false, 1.1, -ux * 1.5, 0.4, -uz * 1.5); }
        launchMissile({
          x0: fx0, y0: fy0, z0: fz0, x1: tx, y1: ty, z1: tz, dur: fast ? 0.5 : 0.62, ease: false,
          arc: airTarget ? dist * 0.04 : dist * 0.05, size: weapon === 'sam' ? 0.5 : 0.34, trail: 80,
          onHit: (x, y, z) => { if (dstVisible) fx.explosion(x, y, z, weapon === 'sam' ? 2.0 : 1.6, hitKind); },
        });
        break;
      }
    }
  }

  // superweapon / ability projectiles follow the sim's own clock
  function strategicShot(pr) {
    const rec = { pr, kind: pr.kind, total: pr.total, last: pr.ticksLeft, acc: 0, jit: hash2(pr.id, 5, 3), started: false };
    const x1 = wuToX(gl, pr.tx), z1 = wuToZ(gl, pr.ty);
    rec.x1 = x1; rec.z1 = z1;
    rec.y1 = Math.max(WATER_Y, gl.hf.heightAt(x1, z1));
    rec.x0 = wuToX(gl, pr.sx); rec.z0 = wuToZ(gl, pr.sy);
    rec.y0 = Math.max(WATER_Y, gl.hf.heightAt(rec.x0, rec.z0)) + 2.5;
    if (pr.kind === 'sw') {
      const a = rec.jit * 6.283, r = hash2(pr.id, 9, 1) * (pr.radiusWu || 200) * WU * 0.55;
      rec.x1 += Math.cos(a) * r; rec.z1 += Math.sin(a) * r;
      rec.arc = 34 + rec.jit * 16;
      fx.muzzle(rec.x0, rec.y0, rec.z0, 0, 1, 0, 2.4);
      fx.dust(rec.x0, rec.y0 - 2.4, rec.z0, 14, 4, 0.7);
      if (gl.audio) gl.audio.event('superweapon_launch', rec.x0, rec.z0);
    } else if (pr.kind === 'cruise') {
      rec.arc = 3; rec.y0 = 7;
    } else if (pr.kind === 'airstrike') {
      // bombs fall in from high above along the sun-facing side
      rec.x0 = x1 - 26; rec.z0 = z1 - 8; rec.y0 = 42; rec.arc = 0;
    } else if (pr.kind === 'telegraph') {
      const n = 12;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        fx.decal({ x: lerp(rec.x0, x1, t), z: lerp(rec.z0, z1, t), s0: 2.6, s1: 3.2, life: 1.1, c: [3.2, 2.2, 0.6, 0.8], frame: fx.FRAMES.ring, add: true, delay: t * 0.25 });
      }
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const ex = lerp(rec.x0, x1, t), ez = lerp(rec.z0, z1, t);
        fx.after(0.95 + t * 0.35, () => fx.explosion(ex, Math.max(WATER_Y, gl.hf.heightAt(ex, ez)) + 0.3, ez, 3.0, 'ground'));
      }
    }
    rec.update = (p, alpha) => {
      if (rec.kind === 'telegraph') return;
      const done = clamp((p.total - p.ticksLeft + alpha) / p.total, 0, 1);
      const x = lerp(rec.x0, rec.x1, done), z = lerp(rec.z0, rec.z1, done);
      const y = lerp(rec.y0, rec.y1, done) + rec.arc * 4 * done * (1 - done);
      rec.x = x; rec.y = y; rec.z = z;
      const big = rec.kind === 'sw' ? 1.5 : 0.8;
      fx.emit({ x, y, z, life: 0.1, s0: big * 1.5, s1: big * 0.8, c: [9, 4.6, 1.6, 1], c2: [3, 1, 0.2, 0], frame: fx.FRAMES.glow, add: true });
      fx.emit({ x, y, z, life: 0.1, s0: big * 2.6, s1: big * 2, c: [5, 3, 1.4, 0.6], c2: [3, 1, 0.2, 0], frame: fx.FRAMES.flare, add: true });
      rec.acc += gl.dt * 70;
      while (rec.acc > 1) {
        rec.acc -= 1;
        fx.emit({ x: x + fx.rr(-0.1, 0.1), y: y + fx.rr(-0.1, 0.1), z: z + fx.rr(-0.1, 0.1), vx: fx.rr(-0.3, 0.3), vy: fx.rr(0, 0.4), vz: fx.rr(-0.3, 0.3), life: fx.rr(1.6, 3.2), s0: big * 0.6, s1: big * fx.rr(1.8, 3), c: [0.9, 0.88, 0.85, 0.5], c2: [0.65, 0.65, 0.65, 0], drag: 0.8, rot: fx.rnd() * 6, frame: fx.FRAMES.smoke });
      }
      rec.last = p.ticksLeft;
    };
    rec.end = () => {
      if (rec.kind === 'telegraph') return;
      const intercepted = rec.last > 2;
      if (intercepted) {
        fx.explosion(rec.x || rec.x1, rec.y || 8, rec.z || rec.z1, 3.2, 'air');
      } else if (rec.kind === 'sw') {
        fx.megaExplosion(rec.x1, rec.y1, rec.z1, 4.2);
        if (gl.audio) gl.audio.event('superweapon_hit', rec.x1, rec.z1);
      } else {
        fx.explosion(rec.x1, rec.y1 + 0.3, rec.z1, rec.kind === 'airstrike' ? 5.2 : 4.0, 'ground');
        gl.onShake && gl.onShake(0.5, rec.x1, rec.z1);
      }
    };
    return rec;
  }

  function syncShots(alpha) {
    for (const id in state.projectiles) {
      const pr = state.projectiles[id];
      let rec = shots.get(pr.id);
      if (!rec) {
        if (pr.kind === 'tracer') { fire(pr); rec = { seen: 0 }; }
        else rec = strategicShot(pr);
        shots.set(pr.id, rec);
      }
      rec.seen = frameNo;
      if (rec.update) rec.update(pr, alpha);
    }
    for (const [id, rec] of shots) {
      if (rec.seen !== frameNo) {
        if (rec.end) rec.end();
        shots.delete(id);
      }
    }
  }

  // ---- model prewarm ------------------------------------------------------
  // Building a model the first time merges its geometry (a few ms). Doing
  // that for every roster in play, a little per frame while the intro runs,
  // keeps the first big engagement free of hitches.
  let warmQueue = [];
  function prewarm(st) {
    warmQueue = [];
    const seen = new Set();
    for (const p of st.players) {
      const team = teamOf(p.slot);
      const add = (kind, def) => {
        const k = kind + def.id + ':' + team.color;
        if (seen.has(k)) return;
        seen.add(k);
        warmQueue.push({ kind, def, team });
      };
      for (const id in st.structDefs) {
        const d = st.structDefs[id];
        if (d.faction === 'All' || d.faction === p.faction) add('s', d);
      }
      for (const id in st.unitDefs) {
        const d = st.unitDefs[id];
        if (d.faction === 'All' || d.faction === p.faction) add('u', d);
      }
    }
  }
  function warmStep() {
    if (!warmQueue.length) return;
    const t0 = performance.now();
    while (warmQueue.length && performance.now() - t0 < 5) {
      const j = warmQueue.pop();
      try { if (j.kind === 'u') kit.unit(j.def, j.team); else kit.structure(j.def, j.team); } catch (e) { /* fallback covers it */ }
    }
  }

  // ---- main sync ----------------------------------------------------------
  function sync(dt) {
    if (!state) return;
    frameNo++;
    warmStep();
    gl.dt = dt;
    const t = gl.time;
    newTick = state.tick !== lastTick;
    if (newTick) {
      if (lastTick >= 0 && state.tick > lastTick) {
        const d = clamp((t - tickTime) / (state.tick - lastTick), 0.015, 0.25);
        tickDur = lerp(tickDur, d, 0.25);
      }
      tickTime = t; lastTick = state.tick;
    }
    const alpha = clamp((t - tickTime) / tickDur, 0, 1);

    // deaths this tick, per owner (so deploys/embarks do not explode)
    const died = [];
    for (const p of state.players) {
      const prev = lost[p.slot] || { u: p.unitsLost, s: p.structsLost };
      died[p.slot] = { u: p.unitsLost - prev.u, s: p.structsLost - prev.s };
      lost[p.slot] = { u: p.unitsLost, s: p.structsLost };
    }

    // structures first (units reference them for turret aim / parking)
    for (const id in state.structures) {
      const s = state.structures[id];
      const def = state.structDefs[s.defId];
      let rec = structs.get(s.id);
      if (rec && (rec.defId !== s.defId || rec.owner !== s.owner)) {
        root.remove(rec.root); structs.delete(s.id); rec = null;
      }
      if (!rec) rec = createStruct(s, def);
      rec.seenFrame = frameNo;
      const hostile = isHostile(s.owner);
      const cxm = s.cx + (s.fp >> 1), cym = s.cy + (s.fp >> 1);
      const vis = !hostile || fogSeenAt(gl, cxm, cym);
      rec.root.visible = vis;
      rec.lastVisible = vis;
      rec.liveVisible = !hostile || fogVisibleAt(gl, (s.cx + s.fp / 2) * CELL, (s.cy + s.fp / 2) * CELL);
      if (!vis) { rec.lastHp = s.hp; continue; }
      // rise out of the ground when first placed
      const age = t - rec.born;
      if (age < 0.9 && state.tick > 20) {
        const k = age / 0.9;
        rec.root.scale.set(1, 0.08 + 0.92 * k * k * (3 - 2 * k), 1);
        if (!rec.dusted) { rec.dusted = true; fx.dust(rec.root.position.x, rec.groundY, rec.root.position.z, 16, rec.radius * 1.4, 0.7); if (gl.audio && rec.liveVisible) gl.audio.event('place', rec.root.position.x, rec.root.position.z); }
      } else if (rec.root.scale.y !== 1) rec.root.scale.set(1, 1, 1);
      for (const sp of rec.spinners || []) sp.node.rotation[sp.axis] += sp.speed * dt;
      if (rec.turret) {
        if (rec.aimWant !== undefined) rec.aim += clamp(angleDelta(rec.aim, rec.aimWant), -6 * dt, 6 * dt);
        rec.turret.rotation.y = rec.aim;
      }
      if (rec.recoil > 0) rec.recoil = Math.max(0, rec.recoil - dt * 5);
      if (rec.barrel) rec.barrel.position.x = rec.barrelX - rec.recoil * 0.16;
      // damage states + chimney smoke
      if (rec.liveVisible) {
        const hpf = s.hp / (s.maxHp || def.hp || 1);
        const p = rec.root.position;
        if (hpf < 0.6) {
          rec.smokeAcc += dt * (hpf < 0.3 ? 7 : 2.5);
          if (rec.smokeAcc > 1) {
            rec.smokeAcc = 0;
            const ox = fx.rr(-0.5, 0.5) * rec.radius, oz = fx.rr(-0.5, 0.5) * rec.radius;
            fx.smokePuff(p.x + ox, p.y + rec.height * 0.7, p.z + oz, 0.9, true, fx.rr(2, 3.4));
            if (hpf < 0.3) fx.fire(p.x + ox, p.y + rec.height * 0.55, p.z + oz, 0.7);
          }
        } else if (rec.stacks && rec.stacks.length && (frameNo + s.id) % 14 === 0) {
          const st = rec.stacks[(frameNo >> 4) % rec.stacks.length];
          st.getWorldPosition(_v);
          fx.emit({ x: _v.x, y: _v.y, z: _v.z, vx: 0.25, vy: fx.rr(0.5, 0.9), vz: 0.1, life: fx.rr(2.4, 4), s0: 0.3, s1: fx.rr(1.2, 1.9), c: [0.86, 0.86, 0.86, 0.26], c2: [0.9, 0.9, 0.9, 0], drag: 0.3, rot: fx.rnd() * 6, frame: fx.FRAMES.smoke });
        }
        // after dark every building throws a warm pool of light on the ground
        if ((gl.look.night || gl.look.todName === 'dusk') && t >= (rec.nextGlow || 0)) {
          rec.nextGlow = t + 1.5;
          fx.decal({ x: p.x, z: p.z, y: rec.groundY, s0: rec.radius * 4.6, s1: rec.radius * 4.6, life: 3.4, c: [1.0, 0.72, 0.38, gl.look.night ? 0.3 : 0.16], frame: fx.FRAMES.glow, add: true });
        }
        // beacon lights
        if (rec.lights && rec.lights.length && Math.sin(t * 3.2 + rec.blink) > 0.86 && (frameNo & 3) === 0) {
          for (const l of rec.lights) {
            l.getWorldPosition(_v);
            fx.emit({ x: _v.x, y: _v.y, z: _v.z, life: 0.16, s0: 0.5, s1: 0.3, c: [5, 0.6, 0.3, 1], c2: [3, 0.2, 0.1, 0], frame: fx.FRAMES.glow, add: true });
          }
        }
      }
      rec.lastHp = s.hp;
    }
    for (const [id, rec] of structs) {
      if (rec.seenFrame === frameNo) continue;
      const d = died[rec.owner];
      if (d && d.s > 0 && rec.lastVisible) { d.s--; structDeath(rec); if (gl.audio) gl.audio.event('collapse', rec.root.position.x, rec.root.position.z); }
      else if (rec.lastVisible) fx.dust(rec.root.position.x, rec.groundY, rec.root.position.z, 14, rec.radius * 1.2, 0.8);
      root.remove(rec.root);
      structs.delete(id);
      for (const [k, v] of structBySrc) if (v === rec) structBySrc.delete(k);
    }

    // units
    for (const id in state.units) {
      const u = state.units[id];
      const def = state.unitDefs[u.defId];
      let rec = units.get(u.id);
      if (rec && rec.owner !== u.owner) { root.remove(rec.root); units.delete(u.id); rec = null; }
      if (!rec) rec = createUnit(u, def);
      rec.seenFrame = frameNo;
      updateUnit(u, rec, dt, alpha, t);
      const vis = !isHostile(u.owner) || fogVisibleAt(gl, u.x, u.y);
      rec.root.visible = vis;
      rec.lastVisible = vis;
      rec.lastHp = u.hp;
      unitAmbientFx(u, rec, dt, vis);
    }
    for (const [id, rec] of units) {
      if (rec.seenFrame === frameNo) continue;
      const d = died[rec.owner];
      if (d && d.u > 0) { d.u--; if (rec.lastVisible) unitDeath(rec); }
      root.remove(rec.root);
      units.delete(id);
    }

    syncShots(alpha);
    updateMissiles(dt);
    updateWrecks(dt);
    updateSelection(t);
    updateGhost();
  }

  // ---- selection ----------------------------------------------------------
  function updateSelection(t) {
    const game = gl.game;
    let n = 0;
    const sel = gl.attract ? [] : (game.selection || []);
    const pulse = 1 + Math.sin(t * 5) * 0.02;
    const add = (id, matOverride) => {
      const u = state.units[id], s = u ? null : state.structures[id];
      const rec = u ? units.get(id) : structs.get(id);
      if (!rec || !rec.root.visible) return;
      const own = rec.owner === gl.localSlot;
      const mat = matOverride || (own ? selOwn : isHostile(rec.owner) ? selFoe : selAlly);
      if (u) {
        const m = selMesh(n++, ringGeo);
        m.material = mat;
        const p = rec.root.position;
        const gy = rec.sea ? WATER_Y : Math.max(WATER_Y, gl.hf.heightAt(p.x, p.z));
        m.position.set(p.x, gy + 0.07, p.z);
        gl.hf.normalAt(p.x, p.z, _n);
        if (rec.sea || rec.air) _n.set(0, 1, 0);
        m.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, _n);
        m.scale.setScalar(rec.radius * 1.12 * pulse);
        m.visible = true;
      } else if (s) {
        const m = selMesh(n++, frameGeo);
        m.material = mat;
        m.position.set(rec.root.position.x, rec.groundY + 0.1, rec.root.position.z);
        m.quaternion.identity();
        m.scale.set(s.fp * S * 0.52 * pulse, 1, s.fp * S * 0.52 * pulse);
        m.visible = true;
      }
    };
    for (let i = 0; i < sel.length && n < 160; i++) add(sel[i]);
    if (game.inspectId && !sel.includes(game.inspectId)) add(game.inspectId, selFoe);
    for (let i = n; i < selPool.length; i++) selPool[i].visible = false;
  }

  // ---- 2D overlay: health bars, veterancy, group numbers, rally lines ------
  function drawOverlay() {
    const game = gl.game;
    const ctx = game.uiCtx;
    if (!ctx || !state) return;
    const dpr = game.dpr || 1;
    const W = gl.viewW, H = gl.viewH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (gl.attract || gl.camLock) return;
    const sel = new Set(game.selection || []);
    const showAll = game.keys && (game.keys.has('alt') || game.keys.has('Alt'));
    const groupOf = new Map();
    if (game.groups) for (const k in game.groups) for (const id of game.groups[k] || []) groupOf.set(id, k);
    const bar = (x, y, w, f, own, big) => {
      const h = big ? 5 : 4;
      const x0 = Math.round(x - w / 2), y0 = Math.round(y);
      ctx.fillStyle = 'rgba(6,9,13,0.78)';
      ctx.fillRect(x0 - 1, y0 - 1, w + 2, h + 2);
      ctx.fillStyle = f > 0.6 ? (own ? '#7ee081' : '#ff8a5c') : f > 0.3 ? '#ffb347' : '#ff5a3c';
      ctx.fillRect(x0, y0, Math.max(1, Math.round(w * f)), h);
      ctx.fillStyle = 'rgba(6,9,13,0.55)';
      const seg = big ? 10 : 6;
      for (let sx = seg; sx < w; sx += seg) ctx.fillRect(x0 + sx, y0, 1, h);
    };
    ctx.font = '600 11px Rajdhani, system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const [id, rec] of units) {
      if (!rec.root.visible) continue;
      const u = state.units[id];
      if (!u) continue;
      const selected = sel.has(id);
      const hurt = u.hp < u.maxHp;
      if (!selected && !showAll && !hurt) continue;
      const p = rec.root.position;
      const sp = projectPoint(gl, p.x, p.y + rec.height + 0.35, p.z, _p);
      if (!sp || sp.x < -40 || sp.y < -40 || sp.x > W + 40 || sp.y > H + 40) continue;
      const ppu = H / (2 * sp.depth * Math.tan(gl.camera.fov * Math.PI / 360));
      const w = clamp(Math.round(rec.radius * 1.9 * ppu), 18, 64);
      if (!selected && !showAll && sp.depth > 150) continue;
      const own = !isHostile(rec.owner);
      bar(sp.x, sp.y - 6, w, clamp(u.hp / u.maxHp, 0, 1), own, false);
      if (u.rank > 0) {
        ctx.fillStyle = '#ffdca6';
        for (let r = 0; r < u.rank; r++) {
          const cx = sp.x - w / 2 - 7 - r * 0, cy = sp.y - 7 + 4 - r * 4;
          ctx.beginPath(); ctx.moveTo(cx - 4, cy + 3); ctx.lineTo(cx, cy); ctx.lineTo(cx + 4, cy + 3);
          ctx.lineTo(cx + 4, cy + 5); ctx.lineTo(cx, cy + 2); ctx.lineTo(cx - 4, cy + 5); ctx.closePath(); ctx.fill();
        }
      }
      if (selected && groupOf.has(id)) {
        ctx.fillStyle = 'rgba(6,9,13,0.8)';
        ctx.fillRect(sp.x + w / 2 + 3, sp.y - 9, 11, 11);
        ctx.fillStyle = '#5fe3d0';
        ctx.fillText(String(groupOf.get(id)), sp.x + w / 2 + 8.5, sp.y);
      }
      if (u.cargo && u.cargo.length && selected) {
        ctx.fillStyle = '#5fe3d0';
        for (let c = 0; c < Math.min(8, u.cargo.length); c++) ctx.fillRect(sp.x - w / 2 + c * 5, sp.y + 1, 4, 3);
      }
    }
    for (const [id, rec] of structs) {
      if (!rec.root.visible) continue;
      const s = state.structures[id];
      if (!s) continue;
      const maxHp = s.maxHp || rec.def.hp || 1;
      const selected = sel.has(id) || game.inspectId === id;
      if (!selected && !showAll && s.hp >= maxHp) continue;
      const p = rec.root.position;
      const sp = projectPoint(gl, p.x, p.y + rec.height + 0.6, p.z, _p);
      if (!sp || sp.x < -60 || sp.y < -40 || sp.x > W + 60 || sp.y > H + 40) continue;
      const ppu = H / (2 * sp.depth * Math.tan(gl.camera.fov * Math.PI / 360));
      const w = clamp(Math.round(rec.radius * 1.6 * ppu), 34, 120);
      bar(sp.x, sp.y - 8, w, clamp(s.hp / maxHp, 0, 1), !isHostile(rec.owner), true);
    }
    // rally line for the selected producer
    if (state.rally) {
      for (const id of sel) {
        const r = state.rally[id];
        const rec = structs.get(id);
        if (!r || !rec) continue;
        const a = projectPoint(gl, rec.root.position.x, rec.groundY + 0.3, rec.root.position.z, {});
        const rx = wuToX(gl, r.x), rz = wuToZ(gl, r.y);
        const b = projectPoint(gl, rx, Math.max(WATER_Y, gl.hf.heightAt(rx, rz)) + 0.3, rz, {});
        if (!a || !b) continue;
        ctx.strokeStyle = 'rgba(95,227,208,0.85)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([7, 5]);
        ctx.lineDashOffset = -gl.time * 22;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#5fe3d0';
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x, b.y - 16); ctx.lineTo(b.x + 11, b.y - 12); ctx.lineTo(b.x, b.y - 8); ctx.closePath(); ctx.fill();
      }
    }
  }

  // ---- screen-space picking -----------------------------------------------
  function pick(sx, sy, filter) {
    let best = null, bestScore = Infinity;
    const H = gl.viewH;
    const tanf = Math.tan(gl.camera.fov * Math.PI / 360);
    for (const [id, rec] of units) {
      if (!rec.root.visible) continue;
      const u = state.units[id];
      if (!u || (filter && !filter(u, true))) continue;
      const p = rec.root.position;
      const sp = projectPoint(gl, p.x, p.y + rec.height * 0.45, p.z, _p);
      if (!sp) continue;
      const ppu = H / (2 * sp.depth * tanf);
      const r = Math.max(13, rec.radius * ppu * 0.95);
      const d = Math.hypot(sp.x - sx, sp.y - sy);
      if (d < r && d / r < bestScore) { bestScore = d / r; best = u; }
    }
    if (best) return best;
    // structures: project the footprint centre, accept within its screen radius
    for (const [id, rec] of structs) {
      if (!rec.root.visible) continue;
      const s = state.structures[id];
      if (!s || (filter && !filter(s, false))) continue;
      const p = rec.root.position;
      const sp = projectPoint(gl, p.x, p.y + rec.height * 0.4, p.z, _p);
      if (!sp) continue;
      const ppu = H / (2 * sp.depth * tanf);
      const r = rec.radius * ppu * 1.05;
      const d = Math.hypot(sp.x - sx, sp.y - sy);
      if (d < r && d / r < bestScore) { bestScore = d / r; best = s; }
    }
    return best;
  }

  function reset(st) {
    state = st;
    for (const [, r] of units) root.remove(r.root);
    for (const [, r] of structs) root.remove(r.root);
    for (const w of wrecks) root.remove(w.obj);
    units.clear(); structs.clear(); shots.clear(); structBySrc.clear();
    wrecks.length = 0; missiles.length = 0;
    teamCache.clear(); ghostCache.clear();
    ghostId = null;
    if (ghostModel) { ghost.remove(ghostModel); ghostModel = null; }
    lastTick = -1; tickDur = 0.1; lost = [];
    if (st) {
      for (const p of st.players) lost[p.slot] = { u: p.unitsLost, s: p.structsLost };
      // projectiles already in flight when we attach are not re-fired
      for (const id in st.projectiles) shots.set(st.projectiles[id].id, { seen: 0 });
    }
  }

  return {
    sync, reset, drawOverlay, pick, setKit, teamOf, prewarm,
    units, structs,
    get kit() { return kit; },
  };
}
