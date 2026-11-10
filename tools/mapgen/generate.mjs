#!/usr/bin/env node
// mapgen-v3: deterministic generator for the competitive map pack.
//
//   node tools/mapgen/generate.mjs            write every new map + manifest +
//                                             theme metadata and economy repairs
//                                             (legacy_repairs.mjs) on legacy maps
//   node tools/mapgen/generate.mjs --check    regenerate in memory and compare
//                                             with the files on disk (exit 1 on
//                                             any difference) — determinism gate
//   node tools/mapgen/generate.mjs --only id[,id]   just these designs
//   node tools/mapgen/generate.mjs --out DIR  write map JSONs to DIR instead
//                                             (scratch iteration; no manifest /
//                                             legacy metadata changes)
//
// No Math.random / Date / trig anywhere: a design is a pure function of its
// fixed seed, so re-running rewrites byte-identical files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MapBuilder } from './lib/builder.mjs';
import * as S from './lib/sdf.mjs';
import { DESIGNS } from './designs/index.mjs';
import { LEGACY_META } from './legacy_meta.mjs';
import { LEGACY_REPAIRS } from './legacy_repairs.mjs';
import { applyRepair, replaceArrayField } from './lib/legacy.mjs';
import { GENERATOR, LEGACY_GENERATOR, TAGLINE_MAX, sizeClass } from './lib/vocab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MAPS_DIR = path.resolve(HERE, '../../client/maps');

// design -> map JSON object (key order is the on-disk order)
export function buildMap(design) {
  const b = new MapBuilder(design);
  const finishOpts = design.build(b, S) || {};
  const out = b.finish(finishOpts);
  if (out.spawns.length !== design.players) {
    throw new Error(`[${design.id}] ${out.spawns.length} spawns, expected ${design.players}`);
  }
  if (design.tagline.length > TAGLINE_MAX) throw new Error(`[${design.id}] tagline longer than ${TAGLINE_MAX} chars`);
  return {
    name: design.name,
    w: out.w,
    h: out.h,
    terrain: out.terrain,
    oil: out.oil,
    spawns: out.spawns,
    briefing: design.briefing,
    tagline: design.tagline,
    theme: design.theme,
    meta: {
      players: design.players,
      size: sizeClass(out.w, out.h),
      symmetry: design.symmetry,
      tags: design.tags,
      seed: design.seed,
      generator: GENERATOR,
    },
  };
}

// compact single-line JSON, same shape as the legacy map files
export const serialize = (map) => JSON.stringify(map);

// legacy map text + metadata (+ optional repair) -> new text. All edits are
// TEXT-level so every other byte of the file is preserved exactly:
//  - `briefing` (only when the map had none), `tagline`, `theme` and, for
//    repaired maps, `meta` are written as the last keys;
//  - a repair (legacy_repairs.mjs) replaces the `oil` array and, only where
//    the record says so, the `spawns` and `terrain` arrays.
// Idempotent: feeding the output back in returns the same text.
export function applyLegacyMeta(text, meta, repair = null) {
  let head = text.trimEnd();
  if (!head.endsWith('}')) throw new Error('legacy map JSON does not end with }');
  const before = JSON.parse(head);
  let fixed = null;
  if (repair) {
    fixed = applyRepair(before, repair);
    const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
    if (differs(fixed.oil, before.oil)) head = replaceArrayField(head, 'oil', fixed.oil);
    if (differs(fixed.spawns, before.spawns)) head = replaceArrayField(head, 'spawns', fixed.spawns);
    if (differs(fixed.terrain, before.terrain)) head = replaceArrayField(head, 'terrain', fixed.terrain);
  }
  const ours = (meta.briefing ? ['"briefing"'] : []).concat(['"tagline"', '"theme"', '"meta"']);
  const base = head.lastIndexOf('"spawns"');
  let cut = head.length - 1;
  for (const k of ours) {
    const i = head.indexOf(',' + k + ':', base);
    if (i >= 0 && i < cut) cut = i;
  }
  if (meta.tagline.length > TAGLINE_MAX) throw new Error(`tagline longer than ${TAGLINE_MAX} chars: ` + meta.tagline);
  const block = repair ? {
    players: fixed.spawns.length,
    size: sizeClass(before.w, before.h),
    tags: repair.tags,
    generator: LEGACY_GENERATOR,
  } : null;
  const out = head.slice(0, cut)
    + (meta.briefing ? ',"briefing":' + JSON.stringify(meta.briefing) : '')
    + ',"tagline":' + JSON.stringify(meta.tagline)
    + ',"theme":' + JSON.stringify(meta.theme)
    + (block ? ',"meta":' + JSON.stringify(block) : '') + '}';
  // nothing may change except what the records say
  const after = JSON.parse(out);
  const want = fixed || before;
  const frozen = (m) => JSON.stringify([m.name, m.w, m.h, m.terrain, m.oil, m.spawns]);
  if (frozen({ ...before, ...want }) !== frozen(after)) throw new Error('legacy map payload changed unexpectedly: ' + before.name);
  if (!(repair && repair.terrain) && JSON.stringify(before.terrain) !== JSON.stringify(after.terrain)) throw new Error('legacy terrain changed: ' + before.name);
  if (!meta.briefing && before.briefing !== after.briefing) throw new Error('legacy briefing changed: ' + before.name);
  if (typeof after.briefing !== 'string' || !after.briefing.trim()) throw new Error('legacy map without a briefing: ' + before.name);
  return out;
}

// new ids first (design order), then every previously listed id, other keys kept
export function buildManifest(oldManifest, newIds) {
  const rest = oldManifest.maps.filter((id) => !newIds.includes(id));
  return { ...oldManifest, maps: [...newIds, ...rest], mapgen_v3_maps: newIds };
}

export function generateAll({ only = null, outDir = null, check = false, log = () => {} } = {}) {
  const designs = only ? DESIGNS.filter((d) => only.includes(d.id)) : DESIGNS;
  const scratch = !!outDir;
  const dir = outDir || MAPS_DIR;
  const files = []; // { file, text }
  for (const d of designs) {
    const t0 = performance.now();
    const map = buildMap(d);
    const text = serialize(map);
    files.push({ file: path.join(dir, d.id + '.json'), text });
    const c = [0, 0, 0];
    for (const v of map.terrain) c[v]++;
    const n = map.w * map.h;
    log(`${d.id.padEnd(18)} ${String(map.w).padStart(3)}x${String(map.h).padEnd(3)} ${map.meta.players}p `
      + `${map.meta.symmetry.padEnd(8)} land ${(c[0] * 100 / n).toFixed(0).padStart(2)}% rock ${(c[1] * 100 / n).toFixed(0).padStart(2)}% `
      + `water ${(c[2] * 100 / n).toFixed(0).padStart(2)}% oil ${String(map.oil.length).padStart(2)}  ${(performance.now() - t0).toFixed(0)} ms`);
  }
  if (!scratch && !only) {
    const manifestPath = path.join(MAPS_DIR, 'manifest.json');
    const manifest = buildManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), DESIGNS.map((d) => d.id));
    for (const id of Object.keys(LEGACY_REPAIRS)) {
      if (!LEGACY_META[id]) throw new Error(`legacy_repairs.mjs: '${id}' has no entry in legacy_meta.mjs`);
    }
    for (const id of manifest.maps) {
      if (!DESIGNS.some((d) => d.id === id) && !LEGACY_REPAIRS[id]) throw new Error(`manifest map '${id}' has no repair record`);
    }
    files.push({ file: manifestPath, text: JSON.stringify(manifest, null, 2) + '\n' });
    for (const [id, meta] of Object.entries(LEGACY_META)) {
      const file = path.join(MAPS_DIR, id + '.json');
      files.push({ file, text: applyLegacyMeta(fs.readFileSync(file, 'utf8'), meta, LEGACY_REPAIRS[id] || null) });
    }
  }
  let changed = 0;
  for (const f of files) {
    const cur = fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8') : null;
    if (cur === f.text) continue;
    changed++;
    if (check) log(`DIFFERS: ${path.relative(process.cwd(), f.file)}`);
    else {
      fs.mkdirSync(path.dirname(f.file), { recursive: true });
      fs.writeFileSync(f.file, f.text);
    }
  }
  log(check ? (changed ? `${changed} file(s) differ from the generator output` : `all ${files.length} files match the generator output`)
    : `${files.length} files checked, ${changed} written`);
  return { files: files.length, changed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const check = args.includes('--check');
  const res = generateAll({
    only: opt('--only') ? opt('--only').split(',') : null,
    outDir: opt('--out') ? path.resolve(opt('--out')) : null,
    check,
    log: (m) => console.log(m),
  });
  if (check && res.changed) process.exit(1);
}
