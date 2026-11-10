// Runs the deterministic sim test-suite in Node (no browser, no bundler).
//   node tools/run_sim_tests.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runAll } from '../client/test/sim.test.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client');
const json = async (rel) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));

const [data, duel, coast] = await Promise.all([
  json('data/game.json'), json('maps/duel.json'), json('maps/coast.json'),
]);
const t0 = performance.now();
const results = runAll(data, duel, coast);
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + String(r.detail).slice(0, 400) : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} sim tests passed in ${(performance.now() - t0).toFixed(0)} ms`);
process.exit(failed ? 1 : 0);
