#!/usr/bin/env node
// Repair solver for the legacy manifest maps: works out, with the real sim's
// placement rules, the smallest set of oil-field moves / additions that gives
// every spawn two oil fields an Oil Depot can be placed on from the freshly
// deployed Construction Yard (inside the AI's own search window).
//
//   node tools/mapgen/repair_legacy.mjs            print the proposal per map and
//                                                  compare it with legacy_repairs.mjs
//                                                  (exit 1 if the frozen data differs)
//   node tools/mapgen/repair_legacy.mjs --js       print the oil data as JS to paste
//   node tools/mapgen/repair_legacy.mjs --markdown print the README table
//
// The solver is deterministic. Its output is FROZEN in legacy_repairs.mjs and
// applied by generate.mjs, so map files do not change when the sim changes;
// validate.mjs is what tells you a frozen repair no longer meets the rules.
//
// Rules, per spawn:
//  1. MOVE (fewer than two depot-capable fields): a field whose nearest spawn
//     (by land path) is this one, at most MOVE_REACH cells away, and that no
//     spawn can currently use, is moved the shortest distance that makes it
//     usable.
//  2. ADD (still short): a new field is placed 8-11 cells from the spawn, on
//     the most open ground, preferring the side away from the middle of the
//     map.
//  3. SPREAD (two usable fields, but the AI would stop at one depot): ai.js
//     treats a field as "served" when an own depot stands within 5 cells of
//     it, and the old maps put a base's fields 5 cells apart. One of the two
//     fields is moved the shortest distance that lets the AI place a second
//     depot (the higher list index moves, so oil[0..] stay put where possible).
// A new or moved field must sit on a 5x5 block of land, on the spawn's own
// landmass, at least 7 cells from its spawn, 12 from any other spawn and 3
// from the map edge; moved/added fields of steps 1-2 also keep 8 cells from
// every other field (9 from the spawn's other field), step 3 keeps 5.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Sim from '../../client/src/sim/index.js';
import * as G from './lib/grid.mjs';
import { applyRepair, originalOil } from './lib/legacy.mjs';
import { LEGACY_REPAIRS } from './legacy_repairs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(HERE, '../../client');
const MOVE_REACH = 26;   // path cells: "this field belongs to that base"
const MIN_SEP = 8;       // Chebyshev cells between any two fields
const MIN_SEP_OWN = 9;   // between the two fields of one spawn (AI "served" radius)
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export function solve(id, diskMap, repair, data) {
  // solver input = manual pre-patches applied, oil as originally shipped
  const pre = applyRepair(diskMap, { terrain: repair.terrain, spawnMoves: repair.spawnMoves });
  const map = { ...diskMap, terrain: pre.terrain, spawns: pre.spawns, oil: originalOil(diskMap, repair) };
  const { w, h } = map;
  const players = map.spawns.map((_, i) => ({ slot: i, team: i, faction: Object.keys(data.factions)[0] }));
  const st = Sim.createMatch({ data, map, players, seed: 1 });
  const pass = Sim.passGrid(st, 'Land');
  Sim.tick(st, Object.values(st.units).filter((u) => u.defId === 'MCV').map((u) => ({ player: u.owner, type: 'deployMCV', unitId: u.id })));
  const depot = st.structDefs['SH-03'];
  const t8 = Uint8Array.from(map.terrain);
  const { label } = G.components(t8, w, h, (v) => v === 0);
  const clear = G.distanceTo(t8, w, h, (v) => v !== 0);
  // the map edge counts as an obstacle too, so new fields do not hug it
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) clear[y * w + x] = Math.min(clear[y * w + x], x + 1, y + 1, w - x, h - y);
  const dist = map.spawns.map((sp) => G.pathCost(pass, w, h, [sp.y * w + sp.x]));
  const oil = map.oil.map((o) => ({ x: o.x, y: o.y }));
  const sync = () => {
    st.oilFields = {};
    oil.forEach((o, i) => { st.oilFields[i + 1] = { id: i + 1, x: o.x * Sim.CELL + Sim.CELL / 2, y: o.y * Sim.CELL + Sim.CELL / 2 }; });
  };
  const capable = (slot, o) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (Sim.canPlace(st, slot, depot, o.x + dx, o.y + dy)) return true;
    return false;
  };
  const count = (slot) => oil.filter((o) => capable(slot, o)).length;
  // ai.js findDepotSpot, replayed from the ConYard alone: fields in list order,
  // skip a field with an own depot within 5 cells, first legal cell in the
  // +-4 window. Returns how many depots the AI would end up placing.
  const aiDepots = (slot) => {
    const placed = [];
    for (let guard = 0; guard < 4; guard++) {
      let spot = null;
      for (const o of oil) {
        const served = placed.some((d) => {
          const c = Sim.structCenter(d);
          return Math.max(Math.abs(c.x - (o.x * Sim.CELL + Sim.CELL / 2)), Math.abs(c.y - (o.y * Sim.CELL + Sim.CELL / 2))) <= 5 * Sim.CELL;
        });
        if (served) continue;
        for (let dy = -4; dy <= 4 && !spot; dy++) for (let dx = -4; dx <= 4 && !spot; dx++) if (Sim.canPlace(st, slot, depot, o.x + dx, o.y + dy)) spot = { x: o.x + dx, y: o.y + dy };
        if (spot) break;
      }
      if (!spot) break;
      placed.push(Sim.addStructure(st, 'SH-03', slot, spot.x, spot.y));
    }
    for (const d of placed) delete st.structures[d.id];
    st.structVersion++;
    return placed.length;
  };
  const landBlock = (x, y) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || map.terrain[ny * w + nx] !== 0) return false;
    }
    return true;
  };
  // can field #idx (or a new field when idx < 0) sit at (x, y) and serve `slot`?
  // sep = fixed minimum spacing to every other field (step 3), else 8 / 9
  const fits = (slot, idx, x, y, sep = 0) => {
    const sp = map.spawns[slot];
    if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3 || !landBlock(x, y)) return false;
    if (label[y * w + x] !== label[sp.y * w + sp.x]) return false;
    if (map.spawns.some((s, i) => cheb(s, { x, y }) < (i === slot ? 7 : 12))) return false;
    for (let i = 0; i < oil.length; i++) {
      if (i === idx) continue;
      const min = sep || (capable(slot, oil[i]) ? MIN_SEP_OWN : MIN_SEP);
      if (cheb(oil[i], { x, y }) < min) return false;
    }
    const saved = idx >= 0 ? { ...oil[idx] } : null;
    if (idx >= 0) oil[idx] = { x, y }; else oil.push({ x, y });
    sync();
    const ok = capable(slot, { x, y });
    if (idx >= 0) oil[idx] = saved; else oil.pop();
    sync();
    return ok;
  };

  sync();
  const orig = oil.map((o) => ({ x: o.x, y: o.y }));
  const before = map.spawns.map((_, s) => count(s));
  const aiBefore = map.spawns.map((_, s) => aiDepots(s));
  map.spawns.forEach((sp, slot) => {
    let need = 2 - count(slot);
    if (need <= 0) return;
    // 1. move fields that belong to this base but are just out of reach
    const mine = oil.map((o, i) => ({ i, d: dist[slot][o.y * w + o.x] }))
      .filter((e) => e.d >= 0 && e.d <= MOVE_REACH * 10)
      .filter((e) => dist.every((dm, s2) => s2 === slot || dm[oil[e.i].y * w + oil[e.i].x] < 0 || dm[oil[e.i].y * w + oil[e.i].x] >= e.d))
      .filter((e) => !map.spawns.some((_, s2) => capable(s2, oil[e.i])))
      .sort((a, b) => a.d - b.d || a.i - b.i);
    for (const e of mine) {
      if (need <= 0) break;
      const f = oil[e.i];
      let best = null;
      for (let dy = -14; dy <= 14; dy++) {
        for (let dx = -14; dx <= 14; dx++) {
          const d2 = dx * dx + dy * dy;
          if (best && d2 >= best.d2) continue;
          if (fits(slot, e.i, f.x + dx, f.y + dy)) best = { d2, x: f.x + dx, y: f.y + dy };
        }
      }
      if (!best) continue;
      oil[e.i] = { x: best.x, y: best.y };
      sync();
      need = 2 - count(slot);
    }
    // 2. add fields
    const cx = w / 2, cy = h / 2;
    const ol = Math.hypot(sp.x - cx, sp.y - cy) || 1;
    const ax = (sp.x - cx) / ol, ay = (sp.y - cy) / ol; // unit vector away from the map centre
    if (need > 0) {
      // every legal cell on the 8..11 ring, best first (ties: lowest row, then column)
      const ring = [];
      for (let dy = -11; dy <= 11; dy++) {
        for (let dx = -11; dx <= 11; dx++) {
          const c = Math.max(Math.abs(dx), Math.abs(dy));
          if (c < 8) continue;
          const x = sp.x + dx, y = sp.y + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (!fits(slot, -1, x, y)) continue;
          const l = Math.hypot(dx, dy);
          ring.push({ x, y, score: 3 * Math.min(clear[y * w + x], 6) + 4 * ((dx * ax + dy * ay) / l) - Math.abs(c - 9.5) });
        }
      }
      ring.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
      const fail = () => { throw new Error(`[${id}] no room for ${need} oil field(s) at spawn ${slot} (${sp.x},${sp.y})`); };
      if (!ring.length) fail();
      const place = (c) => { oil.push({ x: c.x, y: c.y }); sync(); };
      if (need === 1) place(ring[0]);
      else {
        // the first pick must leave room for the second, 9+ cells away
        let pair = null;
        for (const c1 of ring) {
          oil.push({ x: c1.x, y: c1.y });
          sync();
          const c2 = ring.find((c) => cheb(c, c1) >= MIN_SEP_OWN && fits(slot, -1, c.x, c.y));
          oil.pop();
          sync();
          if (c2) { pair = [c1, c2]; break; }
        }
        if (!pair) fail();
        place(pair[0]);
        place(pair[1]);
      }
    }
  });
  // 3. spread: two usable fields, but the AI's "served" rule stops it at one depot
  map.spawns.forEach((sp, slot) => {
    if (aiDepots(slot) >= 2) return;
    let best = null;
    for (let i = oil.length - 1; i >= 0; i--) {
      if (!capable(slot, oil[i])) continue;
      const f = { ...oil[i] };
      for (let dy = -9; dy <= 9; dy++) {
        for (let dx = -9; dx <= 9; dx++) {
          const d2 = dx * dx + dy * dy;
          if (!d2 || (best && d2 >= best.d2)) continue;
          if (!fits(slot, i, f.x + dx, f.y + dy, 5)) continue;
          oil[i] = { x: f.x + dx, y: f.y + dy };
          sync();
          const ok = aiDepots(slot) >= 2 && count(slot) >= 2;
          oil[i] = f;
          sync();
          if (ok) best = { d2, i, x: f.x + dx, y: f.y + dy };
        }
      }
    }
    if (!best) throw new Error(`[${id}] cannot spread the fields of spawn ${slot} (${sp.x},${sp.y}) for a second AI depot`);
    oil[best.i] = { x: best.x, y: best.y };
    sync();
  });
  const after = map.spawns.map((_, s) => count(s));
  const aiAfter = map.spawns.map((_, s) => aiDepots(s));
  after.forEach((n, s) => {
    if (n < 2) throw new Error(`[${id}] spawn ${s} still has ${n} depot-capable field(s)`);
    if (n < before[s]) throw new Error(`[${id}] repair reduced spawn ${s} from ${before[s]} to ${n} fields`);
    if (aiAfter[s] < 2) throw new Error(`[${id}] the AI at spawn ${s} would still place only ${aiAfter[s]} depot(s)`);
  });
  const moves = [], adds = [];
  orig.forEach((o, i) => { if (o.x !== oil[i].x || o.y !== oil[i].y) moves.push([o.x, o.y, oil[i].x, oil[i].y]); });
  for (let i = orig.length; i < oil.length; i++) adds.push([oil[i].x, oil[i].y]);
  return { moves, adds, before, after, aiBefore, aiAfter, oilBefore: map.oil.length, oilAfter: oil.length, spawns: map.spawns };
}

const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const data = JSON.parse(fs.readFileSync(path.join(CLIENT, 'data', 'game.json'), 'utf8'));
  let drift = 0;
  for (const [id, repair] of Object.entries(LEGACY_REPAIRS)) {
    const disk = JSON.parse(fs.readFileSync(path.join(CLIENT, 'maps', id + '.json'), 'utf8'));
    const r = solve(id, disk, repair, data);
    const frozen = same(r.moves, repair.oilMoves) && same(r.adds, repair.oilAdds);
    if (!frozen) drift++;
    if (args.includes('--js')) {
      console.log(`  ${id}: oilMoves: ${JSON.stringify(r.moves)}, oilAdds: ${JSON.stringify(r.adds)},`);
    } else if (args.includes('--markdown')) {
      const mv = r.moves.map(([fx, fy, tx, ty]) => `(${fx},${fy})→(${tx},${ty})`).join(', ') || '—';
      const ad = r.adds.map(([x, y]) => `(${x},${y})`).join(', ') || '—';
      const other = [
        ...(repair.spawnMoves || []).map(([fx, fy, tx, ty]) => `spawn (${fx},${fy})→(${tx},${ty})`),
        ...(repair.terrain || []).map((op) => `terrain: ${op.op} r=${op.r} at (${op.cx},${op.cy})`),
      ].join('; ') || '—';
      console.log(`| \`${id}\` | ${r.oilBefore} → ${r.oilAfter} | ${mv} | ${ad} | ${other} |`);
    } else {
      console.log(`${id.padEnd(19)} oil ${String(r.oilBefore).padStart(2)} -> ${String(r.oilAfter).padEnd(2)} depot fields ${r.before.join(',')} -> ${r.after.join(',')}`
        + `  AI depots ${r.aiBefore.join(',')} -> ${r.aiAfter.join(',')}`
        + `  moves ${r.moves.length} adds ${r.adds.length}  ${frozen ? 'matches legacy_repairs.mjs' : 'DIFFERS from legacy_repairs.mjs'}`);
      for (const [fx, fy, tx, ty] of r.moves) console.log(`    move (${fx},${fy}) -> (${tx},${ty})  [${Math.hypot(tx - fx, ty - fy).toFixed(1)} cells]`);
      for (const [x, y] of r.adds) console.log(`    add  (${x},${y})`);
    }
  }
  if (drift && !args.includes('--js')) process.exit(1);
}
