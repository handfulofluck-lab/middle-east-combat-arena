#!/usr/bin/env node
// Map validator: audits EVERY map in client/maps/manifest.json against the
// real simulation (client/src/sim) and prints a table.
//
//   node tools/mapgen/validate.mjs              all manifest maps; exit 0 only when nothing FAILs
//   node tools/mapgen/validate.mjs --only a,b   just these ids
//   node tools/mapgen/validate.mjs --all        also the map files that are not in the manifest
//   node tools/mapgen/validate.mjs --ci         fast gate: same checks, 600-tick smoke on every map
//   node tools/mapgen/validate.mjs --no-smoke   skip the AI-vs-AI smoke matches
//   node tools/mapgen/validate.mjs --notes      also print informational notes
//   node tools/mapgen/validate.mjs --strict     legacy-map warnings fail too
//   node tools/mapgen/validate.mjs --maps DIR   validate map JSONs in DIR
//   node tools/mapgen/validate.mjs --json       machine-readable result on stdout
//
//   import { validateAll } from './tools/mapgen/validate.mjs'   (test runners)
//
// Three kinds of map, told apart by meta.generator:
//   v3        'mapgen-v3'        generated pack maps: every rule below is a FAIL
//   repaired  'legacy-repaired'  legacy manifest maps after the economy repair
//                                (legacy_repairs.mjs): integrity + economy rules
//                                are a FAIL
//   legacy    no meta            older files outside the manifest (--all):
//                                integrity FAILs, design-rule misses only warn
//
// Checks on every map:
//   schema + bounds, spawns/oil on land, briefing/tagline/theme vocabulary,
//   ConYard deploy at every spawn (real deployMCV command through Sim.tick),
//   land paths spawn -> two nearest oil fields and spawn <-> spawn through the
//   sim's own A* (so the 40k expansion cap is exercised; spawn <-> spawn is
//   skipped on maps tagged naval-separated), >= 2 oil fields with a legal Oil
//   Depot site per spawn (Sim.canPlace on the deployed base, AI search window),
//   and an all-AI smoke match (>= 600 ticks) in which every AI must build an
//   Oil Depot and a production building.
// Extra checks on v3 maps:
//   exact grid symmetry of terrain / spawns / oil, fairness (per-spawn path
//   distance to the two nearest oil fields and to the centre), base room, no
//   1-cell speckles / fins / diagonal pinches, route clearance, a Naval Yard
//   site per spawn and one connected sea on maps tagged naval (yard site also
//   on riverine), and a >= 3000-tick smoke match (600 with --ci).
// Notes (--notes) are informational and never affect the result: e.g. spawns
// with no Naval Yard site in reach on a wet map (that AI simply builds no navy).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Sim from '../../client/src/sim/index.js';
import * as G from './lib/grid.mjs';
import {
  GENERATOR, LEGACY_GENERATOR, BIOMES, TODS, WEATHERS, SYMMETRIES, TAGLINE_MAX, MAX_PLAYERS, sizeClass,
} from './lib/vocab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(HERE, '../../client');
const MAPS_DIR = path.join(CLIENT, 'maps');

export const SMOKE_TICKS_NEW = 3000;
export const SMOKE_TICKS_LEGACY = 600;
export const SMOKE_TICKS_CI = 600;
const PROD_IDS = ['SH-04', 'SH-05', 'SH-06', 'SH-07'];
const PERSONALITIES = ['auto', 'front', 'sky', 'raid', 'fortress', 'auto'];

const isInt = (v) => Number.isInteger(v);
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

function playersFor(map, id, data) {
  const factions = Object.keys(data.factions);
  const off = strHash(id) % factions.length;
  return map.spawns.map((_, i) => ({
    slot: i,
    team: i, // free-for-all
    faction: factions[(i + off) % factions.length],
    ai: { personality: PERSONALITIES[(i + off) % PERSONALITIES.length], difficulty: 'veteran' },
  }));
}

// ---- individual checks -------------------------------------------------------

function checkSchema(map, isNew, R) {
  const { err } = R;
  if (typeof map.name !== 'string' || !map.name.trim()) err('schema: missing name');
  if (!isInt(map.w) || !isInt(map.h) || map.w < 32 || map.h < 32 || map.w > 256 || map.h > 256) {
    err(`schema: bad size ${map.w}x${map.h} (32..256)`);
    return false;
  }
  if (!Array.isArray(map.terrain) || map.terrain.length !== map.w * map.h) {
    err(`schema: terrain length ${map.terrain && map.terrain.length} != w*h ${map.w * map.h}`);
    return false;
  }
  for (let i = 0; i < map.terrain.length; i++) {
    const t = map.terrain[i];
    if (t !== 0 && t !== 1 && t !== 2) { err(`schema: terrain[${i}] = ${t}`); return false; }
  }
  const inMap = (p) => p && isInt(p.x) && isInt(p.y) && p.x >= 0 && p.y >= 0 && p.x < map.w && p.y < map.h;
  if (!Array.isArray(map.spawns) || map.spawns.length < 1 || map.spawns.length > MAX_PLAYERS) {
    err(`schema: spawns must hold 1..${MAX_PLAYERS} entries`);
    return false;
  }
  if (!Array.isArray(map.oil)) { err('schema: oil must be an array'); return false; }
  let ok = true;
  map.spawns.forEach((s, i) => { if (!inMap(s)) { err(`schema: spawn ${i} out of bounds`); ok = false; } });
  map.oil.forEach((o, i) => { if (!inMap(o)) { err(`schema: oil ${i} out of bounds`); ok = false; } });
  if (!ok) return false;
  const key = (p) => p.x + ',' + p.y;
  if (new Set(map.spawns.map(key)).size !== map.spawns.length) err('schema: duplicate spawn cells');
  if (new Set(map.oil.map(key)).size !== map.oil.length) err('schema: duplicate oil cells');
  const at = (p) => map.terrain[p.y * map.w + p.x];
  map.spawns.forEach((s, i) => { if (at(s) !== 0) { err(`spawn ${i} (${s.x},${s.y}) is not on land`); ok = false; } });
  map.oil.forEach((o, i) => { if (at(o) !== 0) { err(`oil ${i} (${o.x},${o.y}) is not on land`); ok = false; } });

  // presentation metadata (required on every map)
  if (typeof map.briefing !== 'string' || map.briefing.trim().length < 20) err('meta: missing briefing');
  if (typeof map.tagline !== 'string' || !map.tagline.trim()) err('meta: missing tagline');
  else if (map.tagline.length > TAGLINE_MAX) err(`meta: tagline is ${map.tagline.length} chars (max ${TAGLINE_MAX})`);
  const th = map.theme;
  if (!th || typeof th !== 'object') err('meta: missing theme');
  else {
    if (!BIOMES.includes(th.biome)) err(`meta: theme.biome '${th.biome}' not in vocabulary`);
    if (!TODS.includes(th.tod)) err(`meta: theme.tod '${th.tod}' not in vocabulary`);
    if (!WEATHERS.includes(th.weather)) err(`meta: theme.weather '${th.weather}' not in vocabulary`);
  }
  if (map.meta !== undefined) {
    const m = map.meta;
    if (!m || typeof m !== 'object') err('meta must be an object');
    else {
      if (m.generator !== GENERATOR && m.generator !== LEGACY_GENERATOR) err(`meta.generator '${m.generator}' unknown`);
      if (m.players !== map.spawns.length) err(`meta.players ${m.players} != spawns ${map.spawns.length}`);
      if (m.size !== sizeClass(map.w, map.h)) err(`meta.size '${m.size}' does not match ${map.w}x${map.h}`);
      if (!Array.isArray(m.tags) || !m.tags.length || m.tags.some((t) => typeof t !== 'string')) err('meta.tags must be a non-empty string array');
      if (isNew) {
        if (!SYMMETRIES.includes(m.symmetry)) err(`meta.symmetry '${m.symmetry}' unknown`);
        if (!isInt(m.seed)) err('meta.seed must be an integer');
      }
    }
  }
  return ok;
}

// exact grid symmetry of terrain, spawns and oil (mapgen-v3 maps)
function checkSymmetry(map, R) {
  const { w, h } = map;
  const sym = map.meta.symmetry;
  if (!SYMMETRIES.includes(sym)) return;
  const bad = G.asymmetry(Uint8Array.from(map.terrain), w, h, sym);
  if (bad) R.err(`symmetry: ${bad} terrain cells break ${sym}`);
  const ops = G.gridOps(sym, w, h);
  for (const [label, list] of [['spawn', map.spawns], ['oil', map.oil]]) {
    const set = new Set(list.map((p) => p.x + ',' + p.y));
    for (const p of list) {
      for (const op of ops) {
        const [x, y] = op(p.x, p.y);
        if (!set.has(x + ',' + y)) { R.err(`symmetry: ${label} (${p.x},${p.y}) has no ${sym} partner`); break; }
      }
    }
  }
  R.metrics.symmetry = sym === 'hex' ? 'hex (rot2 exact)' : sym + ' exact';
}

// no speckles, 1-cell fins/corridors, diagonal pinches or tiny blobs
function checkSpeckles(map, R) {
  const { w, h } = map;
  const t = Uint8Array.from(map.terrain);
  const thin = G.thinCells(t, w, h).length;
  const pinch = G.diagonalPinches(t, w, h).length;
  if (thin) R.err(`speckle: ${thin} one-cell-wide cells (fins / corridors / lone cells)`);
  if (pinch) R.err(`speckle: ${pinch} diagonal one-cell pinches`);
  const small = (type, min, name) => {
    const { sizes } = G.components(t, w, h, (v) => v === type);
    const n = sizes.filter((s) => s < min).length;
    if (n) R.err(`speckle: ${n} ${name} blob(s) under ${min} cells`);
  };
  small(G.ROCK, 8, 'rock');
  small(G.WATER, 12, 'water');
  const { label, sizes } = G.components(t, w, h, (v) => v === G.LAND);
  const reach = new Set(map.spawns.map((s) => label[s.y * w + s.x]));
  const stray = sizes.filter((s, id) => !reach.has(id) && s < 30).length;
  if (stray) R.err(`speckle: ${stray} unreachable land pocket(s) under 30 cells`);
  R.metrics.islands = sizes.filter((s, id) => !reach.has(id)).length;
  R.metrics.speckles = thin + pinch;
}

// deploy every MCV through the real command pipeline
function checkDeploy(map, id, data, hard, R) {
  const players = playersFor(map, id, data);
  const st = Sim.createMatch({ data, map, players, seed: 7 });
  const cmds = [];
  for (const u of Object.values(st.units)) {
    if (u.defId === 'MCV') cmds.push({ player: u.owner, type: 'deployMCV', unitId: u.id });
  }
  Sim.tick(st, cmds);
  for (let i = 0; i < 6; i++) Sim.tick(st);
  const yards = [];
  let ok = true;
  map.spawns.forEach((sp, slot) => {
    const cy = Object.values(st.structures).find((s) => s.owner === slot && s.defId === 'SH-01');
    yards[slot] = cy || null;
    if (!cy) { R.err(`deploy: no Construction Yard (SH-01) after deployMCV at spawn ${slot} (${sp.x},${sp.y})`); ok = false; return; }
    if (cy.cx !== sp.x - 1 || cy.cy !== sp.y - 1) {
      (hard ? R.err : R.warn)(`deploy: spawn ${slot} ConYard shifted to (${cy.cx},${cy.cy}) - spawn cell is cramped`);
    }
  });
  R.metrics.deploy = ok ? `${map.spawns.length}/${map.spawns.length}` : 'FAIL';
  return { st, yards };
}

// land connectivity through the sim's pathfinder
function checkPaths(map, id, data, hard, R) {
  const { w, h } = map;
  const st = Sim.createMatch({ data, map, players: playersFor(map, id, data), seed: 7 });
  const land = st.unitDefs.MCV;
  const pass = Sim.passGrid(st, 'Land');
  const tags = (map.meta && map.meta.tags) || [];
  const separated = tags.includes('naval-separated');
  const soft = hard ? R.err : R.warn;
  const cell = (p) => p.y * w + p.x;
  const perSpawn = [];
  // centre reference: the land cells closest to the middle of the map
  let dmin = Infinity;
  const cdist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2);
      cdist[y * w + x] = d;
      if (pass[y * w + x] && d < dmin) dmin = d;
    }
  }
  const centreCells = [];
  for (let i = 0; i < w * h; i++) if (pass[i] && cdist[i] <= dmin + 1.5) centreCells.push(i);
  const toCentre = G.pathCost(pass, w, h, centreCells);

  const fewOil = [], cut = [];
  map.spawns.forEach((sp, slot) => {
    const dist = G.pathCost(pass, w, h, [cell(sp)]);
    const oils = map.oil.map((o, i) => ({ i, o, d: dist[cell(o)] })).filter((e) => e.d >= 0).sort((a, b) => a.d - b.d);
    const near = oils.slice(0, 2);
    if (near.length < 2) fewOil.push(`${slot} (${near.length})`);
    for (const e of near) {
      // real A* (with its expansion cap) must agree with the flood fill
      if (!Sim.findPathCells(st, land, sp.x, sp.y, e.o.x, e.o.y)) soft(`paths: sim A* finds no route spawn ${slot} -> oil ${e.i}`);
    }
    perSpawn.push({ oil1: near[0] ? near[0].d / 10 : -1, oil2: near[1] ? near[1].d / 10 : -1, centre: toCentre[cell(sp)] / 10, dist });
  });
  let pairs = 0, linked = 0, longest = 0;
  for (let a = 0; a < map.spawns.length; a++) {
    for (let b2 = a + 1; b2 < map.spawns.length; b2++) {
      pairs++;
      const A = map.spawns[a], B = map.spawns[b2];
      const flood = perSpawn[a].dist[cell(B)];
      const p = flood >= 0 ? Sim.findPathCells(st, land, A.x, A.y, B.x, B.y) : null;
      const q = flood >= 0 ? Sim.findPathCells(st, land, B.x, B.y, A.x, A.y) : null;
      if (p && q) { linked++; longest = Math.max(longest, flood / 10); continue; }
      if (flood < 0) {
        if (!separated) cut.push(`${a}-${b2}`);
      } else {
        soft(`paths: spawns ${a} and ${b2} are connected (${(flood / 10).toFixed(0)} cells) but the sim A* gives up (expansion cap)`);
      }
    }
  }
  if (fewOil.length) soft(`paths: spawn(s) ${fewOil.join(', ')} reach fewer than 2 oil fields by land (count in brackets)`);
  if (cut.length) soft(`paths: no land route between spawn pairs ${cut.join(', ')} (map is not tagged naval-separated)`);
  R.metrics.paths = `${linked}/${pairs}${separated && linked < pairs ? ' sep' : ''}`;
  R.metrics.longestRoute = Math.round(longest);
  return perSpawn;
}

// >= 2 oil fields with a legal depot site from the freshly deployed ConYard
function checkDepots(map, deployed, hard, R) {
  const { st, yards } = deployed;
  const def = st.structDefs['SH-03'];
  const soft = hard ? R.err : R.warn;
  let min = Infinity;
  const poor = [];
  map.spawns.forEach((sp, slot) => {
    if (!yards[slot]) return;
    let n = 0;
    for (const o of map.oil) {
      let found = false;
      for (let dy = -4; dy <= 4 && !found; dy++) {
        for (let dx = -4; dx <= 4 && !found; dx++) {
          if (Sim.canPlace(st, slot, def, o.x + dx, o.y + dy)) found = true;
        }
      }
      if (found) n++;
    }
    min = Math.min(min, n);
    if (n < 2) poor.push(`${slot} (${n})`);
  });
  if (poor.length) soft(`depots: spawn(s) ${poor.join(', ')} have fewer than 2 oil fields with a legal Oil Depot site from the ConYard (count in brackets)`);
  R.metrics.depotFields = min === Infinity ? 0 : min;
}

// Wet maps: which spawns have a Naval Yard site within the AI's reach. Since
// the v1.0 AI only queues a yard when it can place one, a spawn without a
// site is not broken - that AI just never builds a navy - so this is a NOTE.
// It is a FAIL only on v3 maps whose design depends on harbours (tags naval /
// riverine).
function checkNaval(map, deployed, isNew, R) {
  const { w, h } = map;
  if (!map.terrain.includes(2)) { R.metrics.naval = 'dry'; return; }
  const { st, yards } = deployed;
  const def = st.structDefs['SH-07'];
  const tags = (map.meta && map.meta.tags) || [];
  const needsHarbours = isNew && (tags.includes('naval') || tags.includes('riverine'));
  const { label, sizes } = G.components(Uint8Array.from(map.terrain), w, h, (v) => v === G.WATER);
  const harbour = [];
  const dryDock = [];
  let sites = 0;
  map.spawns.forEach((sp, slot) => {
    const cy = yards[slot];
    if (!cy) return;
    const c = Sim.structCenter(cy);
    const spot = Sim.findPlacement(st, slot, def, Sim.cellOf(c.x), Sim.cellOf(c.y), 10);
    if (!spot) { dryDock.push(slot); return; }
    sites++;
    // water body the yard would launch into: largest one touching the footprint
    let best = -1;
    for (let dy = -1; dy <= def.fp; dy++) {
      for (let dx = -1; dx <= def.fp; dx++) {
        const x = spot.x + dx, y = spot.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const l = label[y * w + x];
        if (l >= 0 && (best < 0 || sizes[l] > sizes[best])) best = l;
      }
    }
    harbour[slot] = { comp: best, spot };
  });
  if (dryDock.length) {
    (needsHarbours ? R.err : R.note)(`naval: spawn(s) ${dryDock.join(', ')} have no Naval Yard site within 10 cells of the ConYard (an AI there builds no navy)`);
  }
  R.metrics.naval = `yards ${sites}/${map.spawns.length}`;
  if (isNew && tags.includes('naval') && sites === map.spawns.length) {
    const comps = new Set(harbour.map((hb) => hb.comp));
    if (comps.size !== 1) R.err(`naval: harbours open onto ${comps.size} separate water bodies`);
    else {
      // ships must actually be able to sail harbour -> harbour (sim sea A*)
      const sea = Object.values(st.unitDefs).find((d) => d.domain === 'Sea');
      const water = (hb) => {
        for (let dy = -1; dy <= def.fp; dy++) {
          for (let dx = -1; dx <= def.fp; dx++) {
            const x = hb.spot.x + dx, y = hb.spot.y + dy;
            if (x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === hb.comp) return { x, y };
          }
        }
        return null;
      };
      const a = water(harbour[0]);
      for (let s = 1; s < harbour.length; s++) {
        const b2 = water(harbour[s]);
        if (!a || !b2 || !Sim.findPathCells(st, sea, a.x, a.y, b2.x, b2.y)) R.err(`naval: no sea route from harbour 0 to harbour ${s}`);
      }
      R.metrics.naval += ', one sea';
      R.metrics.seaCells = sizes[[...comps][0]];
    }
  }
}

// fairness: every spawn should see the same distances (mapgen-v3 maps)
function checkFairness(map, perSpawn, R) {
  const hex = map.meta.symmetry === 'hex';
  const out = {};
  for (const k of ['oil1', 'oil2', 'centre']) {
    const v = perSpawn.map((p) => p[k]);
    const lo = Math.min(...v), hi = Math.max(...v);
    const mean = v.reduce((a, c) => a + c, 0) / v.length;
    const tol = hex ? Math.max(4, mean * 0.05) : Math.max(1, mean * 0.01);
    out[k] = { lo, hi };
    if (lo < 0) R.err(`fairness: a spawn cannot reach ${k}`);
    else if (hi - lo > tol) R.err(`fairness: ${k} path distance ranges ${lo.toFixed(1)}..${hi.toFixed(1)} cells (tolerance ${tol.toFixed(1)})`);
  }
  const f = (e) => (e.hi - e.lo < 0.05 ? e.lo.toFixed(0) : `${e.lo.toFixed(0)}-${e.hi.toFixed(0)}`);
  R.metrics.fairness = `${f(out.oil1)}/${f(out.oil2)}/${f(out.centre)}`;
  // base room: the 15x15 block around a spawn must be mostly open land
  let minOpen = 1;
  map.spawns.forEach((sp, slot) => {
    let open = 0, n = 0;
    for (let dy = -7; dy <= 7; dy++) {
      for (let dx = -7; dx <= 7; dx++) {
        n++;
        const x = sp.x + dx, y = sp.y + dy;
        if (x >= 0 && y >= 0 && x < map.w && y < map.h && map.terrain[y * map.w + x] === 0) open++;
      }
    }
    minOpen = Math.min(minOpen, open / n);
    if (open / n < 0.8) R.err(`base room: only ${(open * 100 / n).toFixed(0)}% of the 15x15 block around spawn ${slot} is open land`);
  });
  R.metrics.baseRoom = Math.round(minOpen * 100) + '%';
}

// Narrowest point of the WIDEST land route between every pair of spawns: the
// largest clearance r (cells to the nearest rock/water/map edge) such that a
// route exists using only cells with clearance >= r. A healthy map keeps this
// >= 2.5 (a corridor about five cells wide) so no key route is a 1-2 cell slot.
function checkChokes(map, R) {
  const { w, h } = map;
  const t = Uint8Array.from(map.terrain);
  const clear = G.distanceTo(t, w, h, (v) => v !== G.LAND);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y) + 1;
      if (clear[y * w + x] > edge) clear[y * w + x] = edge;
    }
  }
  // are all spawns in one component of { land cells with clearance >= r } ?
  const linkedAt = (r) => {
    const seen = new Uint8Array(w * h);
    const start = map.spawns[0].y * w + map.spawns[0].x;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || seen[j] || t[j] !== G.LAND || clear[j] < r) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    return map.spawns.every((sp) => seen[sp.y * w + sp.x]);
  };
  let lo = 0;
  for (let r = 1; r <= 12; r += 0.5) { if (linkedAt(r)) lo = r; else break; }
  R.metrics.choke = lo;
  if (lo < 2.5) R.err(`chokes: the widest route between some spawns narrows to clearance ${lo} (< 2.5 cells)`);
}

// full AI-vs-AI match: all spawns filled, mixed factions, fixed seed
function smokeMatch(map, id, data, hard, ticks, R) {
  const players = playersFor(map, id, data);
  const seed = (0xc0ffee ^ strHash(id)) >>> 0;
  const st = Sim.createMatch({ data, map, players, seed });
  const ai = Sim.createAI(players, seed);
  const built = players.map(() => new Set());
  const maxDepots = players.map(() => 0);
  const t0 = performance.now();
  let t = 0;
  try {
    for (; t < ticks && !st.over; t++) {
      Sim.tick(st, Sim.aiCommands(st, ai));
      if (t % 20 === 0 || t === ticks - 1) {
        const depots = players.map(() => 0);
        for (const s of Object.values(st.structures)) {
          if (s.owner < 0) continue;
          built[s.owner].add(s.defId);
          if (s.defId === 'SH-03') depots[s.owner]++;
        }
        depots.forEach((d, i) => { if (d > maxDepots[i]) maxDepots[i] = d; });
      }
    }
  } catch (e) {
    R.err(`smoke: threw at tick ${t}: ${e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e}`);
  }
  const ms = performance.now() - t0;
  if (t < ticks && !st.over && !R.errors.some((m) => m.startsWith('smoke:'))) R.err(`smoke: stopped at tick ${t}`);
  const noDepot = [], noProd = [];
  players.forEach((p, i) => {
    if (!built[i].has('SH-03')) noDepot.push(i);
    if (!PROD_IDS.some((pid) => built[i].has(pid))) noProd.push(i);
  });
  const soft = hard ? R.err : R.warn;
  if (noDepot.length) soft(`smoke: AI slot(s) ${noDepot.join(',')} never built an Oil Depot`);
  if (noProd.length) soft(`smoke: AI slot(s) ${noProd.join(',')} never built a production building`);
  R.metrics.smoke = {
    ticks: t,
    over: st.over,
    ms: Math.round(ms),
    minDepots: Math.min(...maxDepots),
    navalYards: built.filter((b) => b.has('SH-07')).length,
    units: Object.keys(st.units).length,
    checksum: Sim.checksum(st),
  };
}

// ---- driver ---------------------------------------------------------------------

export function validateMap(id, map, data, { smoke = true, strict = false, ci = false } = {}) {
  const t0 = performance.now();
  const R = { id, errors: [], warnings: [], notes: [], metrics: {} };
  R.err = (m) => R.errors.push(m);
  R.warn = (m) => R.warnings.push(m);
  R.note = (m) => R.notes.push(m);
  const gen = map && map.meta && map.meta.generator;
  const kind = gen === GENERATOR ? 'v3' : gen === LEGACY_GENERATOR ? 'repaired' : 'legacy';
  const isNew = kind === 'v3';
  const hard = kind !== 'legacy'; // economy / route / deploy rules are FAILs
  R.kind = kind;
  R.isNew = isNew;
  R.players = map && Array.isArray(map.spawns) ? map.spawns.length : 0;
  R.size = map ? `${map.w}x${map.h}` : '?';
  try {
    if (checkSchema(map, isNew, R)) {
      if (isNew) { checkSymmetry(map, R); checkSpeckles(map, R); }
      const deployed = checkDeploy(map, id, data, hard, R);
      const perSpawn = checkPaths(map, id, data, hard, R);
      checkDepots(map, deployed, hard, R);
      checkNaval(map, deployed, isNew, R);
      if (isNew) { checkFairness(map, perSpawn, R); if (!((map.meta.tags || []).includes('naval-separated'))) checkChokes(map, R); }
      if (smoke) smokeMatch(map, id, data, hard, ci ? SMOKE_TICKS_CI : isNew ? SMOKE_TICKS_NEW : SMOKE_TICKS_LEGACY, R);
    }
  } catch (e) {
    R.err(`validator crashed: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  }
  if (strict && R.warnings.length) { R.errors.push(...R.warnings.map((m) => '[strict] ' + m)); }
  R.ok = R.errors.length === 0;
  R.ms = Math.round(performance.now() - t0);
  delete R.err;
  delete R.warn;
  delete R.note;
  return R;
}

export function validateAll({ mapsDir = MAPS_DIR, only = null, all = false, smoke = true, strict = false, ci = false, notes = false, log = null } = {}) {
  const data = JSON.parse(fs.readFileSync(path.join(CLIENT, 'data', 'game.json'), 'utf8'));
  const manifestPath = path.join(mapsDir, 'manifest.json');
  const results = [];
  const problems = [];
  let ids;
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    ids = manifest.maps;
    if (!Array.isArray(ids) || !ids.length) problems.push('manifest.json: "maps" must be a non-empty array');
    else if (new Set(ids).size !== ids.length) problems.push('manifest.json: duplicate map ids');
  } else {
    ids = [];
  }
  if (all || !fs.existsSync(manifestPath)) {
    // manifest order first, then every other map file on disk (unlisted maps)
    const disk = fs.readdirSync(mapsDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json').map((f) => f.slice(0, -5)).sort();
    ids = (ids || []).concat(disk.filter((id) => !(ids || []).includes(id)));
  }
  if (only) ids = (ids || []).filter((id) => only.includes(id)).concat(only.filter((id) => !(ids || []).includes(id)));
  for (const id of ids || []) {
    const file = path.join(mapsDir, id + '.json');
    let map = null;
    let R;
    try {
      map = JSON.parse(fs.readFileSync(file, 'utf8'));
      R = validateMap(id, map, data, { smoke, strict, ci });
    } catch (e) {
      R = { id, ok: false, kind: 'legacy', isNew: false, players: 0, size: '?', errors: [`cannot load ${id}.json: ${e.message}`], warnings: [], notes: [], metrics: {}, ms: 0 };
    }
    results.push(R);
    if (log) log(formatRow(R, { notes }));
  }
  // ---- pack-level rules (only meaningful for a full run) ----
  if (!only) {
    const loaded = (ids || []).map((id) => {
      try { return { id, map: JSON.parse(fs.readFileSync(path.join(mapsDir, id + '.json'), 'utf8')) }; } catch (e) { return null; }
    }).filter(Boolean);
    const dark = loaded.filter((e) => e.map.theme && (e.map.theme.tod === 'dusk' || e.map.theme.tod === 'night')).map((e) => e.id);
    if (dark.length > 2) problems.push(`pack: ${dark.length} maps use a dusk/night theme (max 2): ${dark.join(', ')}`);
    const names = new Map();
    for (const e of loaded) {
      if (names.has(e.map.name)) problems.push(`pack: maps '${names.get(e.map.name)}' and '${e.id}' share the name "${e.map.name}"`);
      names.set(e.map.name, e.id);
    }
  }
  const ok = problems.length === 0 && results.every((r) => r.ok);
  return { ok, problems, results };
}

const COLS = [
  ['map', 19], ['P', 2], ['size', 8], ['kind', 8], ['result', 6], ['deploy', 6], ['paths', 6], ['depot', 5],
  ['naval', 19], ['fair oil1/oil2/ctr', 19], ['room', 5], ['choke', 5], ['smoke', 11], ['AI dep', 6], ['ms', 6],
];
export function formatHeader() {
  return COLS.map(([n, wd]) => n.padEnd(wd)).join(' ') + '\n' + COLS.map(([, wd]) => '-'.repeat(wd)).join(' ');
}
export function formatRow(R, { notes = false } = {}) {
  const m = R.metrics || {};
  const s = m.smoke;
  const cells = [
    R.id, String(R.players), R.size, R.kind || (R.isNew ? 'v3' : 'legacy'),
    R.ok ? (R.warnings.length ? 'WARN' : 'PASS') : 'FAIL',
    m.deploy || '-', m.paths || '-', m.depotFields !== undefined ? String(m.depotFields) : '-',
    m.naval || '-', m.fairness || '-', m.baseRoom || '-', m.choke !== undefined ? String(m.choke) : '-',
    s ? `${s.ticks}t${s.over ? ' over' : ''}` : '-', s ? String(s.minDepots) : '-', String(R.ms),
  ];
  let out = cells.map((c, i) => String(c).padEnd(COLS[i][1])).join(' ');
  for (const e of R.errors) out += `\n    FAIL  ${e}`;
  for (const wn of R.warnings) out += `\n    warn  ${wn}`;
  if (notes) for (const nt of R.notes || []) out += `\n    note  ${nt}`;
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const json = args.includes('--json');
  if (!json) console.log(formatHeader());
  const t0 = performance.now();
  const res = validateAll({
    mapsDir: opt('--maps') ? path.resolve(opt('--maps')) : MAPS_DIR,
    only: opt('--only') ? opt('--only').split(',') : null,
    all: args.includes('--all'),
    smoke: !args.includes('--no-smoke'),
    strict: args.includes('--strict'),
    ci: args.includes('--ci'),
    notes: args.includes('--notes'),
    log: json ? null : (m) => console.log(m),
  });
  if (json) console.log(JSON.stringify(res, null, 2));
  else {
    for (const p of res.problems) console.log('FAIL  ' + p);
    const fail = res.results.filter((r) => !r.ok).length;
    const warn = res.results.filter((r) => r.ok && r.warnings.length).length;
    const noteCount = res.results.reduce((n, r) => n + (r.notes ? r.notes.length : 0), 0);
    console.log(`\n${res.results.length} maps: ${res.results.length - fail - warn} pass, ${warn} pass with warnings, ${fail} fail`
      + `  (${((performance.now() - t0) / 1000).toFixed(1)} s)`
      + (noteCount && !args.includes('--notes') ? `  [${noteCount} informational note(s): --notes]` : ''));
  }
  process.exit(res.ok ? 0 : 1);
}
