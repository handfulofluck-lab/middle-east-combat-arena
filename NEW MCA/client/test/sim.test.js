// Headless scenario runner for the M2 sim core. Dependency-free ES module:
// importable from test.html (browser) or from any JS harness that can supply
// the JSON payloads (runTests({ data, duel, coast })).
import * as Sim from '../src/sim/index.js';

// ---- shared helpers ---------------------------------------------------------

function match(data, map, factions, seed, ai) {
  return Sim.createMatch({
    data, map, seed,
    players: factions.map((faction, slot) => ({
      slot, faction, ai: ai ? ai[slot] : undefined,
    })),
  });
}

function cheapestInfantry(data, faction) {
  return data.units
    .filter((u) => u.faction === faction && u.cls === 'Infantry')
    .sort((a, b) => a.cost - b.cost)[0].id;
}

function deploy(state, slot) {
  const mcv = Object.values(state.units).find((u) => u.owner === slot && u.defId === 'MCV');
  Sim.tick(state, [{ player: slot, type: 'deployMCV', unitId: mcv.id }]);
  for (let i = 0; i < 6; i++) Sim.tick(state);
  return Object.values(state.structures).find((s) => s.owner === slot && s.defId === 'SH-01');
}

function nearConyard(state, slot, def) {
  const cy = Object.values(state.structures).find((s) => s.owner === slot && s.defId === 'SH-01');
  const c = Sim.structCenter(cy);
  return Sim.findPlacement(state, slot, def, Sim.cellOf(c.x), Sim.cellOf(c.y), 10);
}

function buildAndPlace(state, slot, structId, spotFn, maxTicks) {
  Sim.tick(state, [{ player: slot, type: 'buildStructure', structId }]);
  const p = state.players[slot];
  let guard = 0;
  while (!p.ready.includes(structId) && guard++ < (maxTicks || 4000)) Sim.tick(state);
  if (!p.ready.includes(structId)) return null;
  const def = state.structDefs[structId];
  const spot = (spotFn || nearConyard)(state, slot, def);
  if (!spot) return null;
  Sim.tick(state, [{ player: slot, type: 'placeStructure', structId, cx: spot.x, cy: spot.y }]);
  guard = 0;
  while (guard++ < 12) {
    Sim.tick(state);
    const s = Object.values(state.structures)
      .find((x) => x.owner === slot && x.defId === structId);
    if (s) return s;
  }
  return null;
}

// ---- scenarios --------------------------------------------------------------

function tDeterminism(data, duel) {
  const script = (state, done) => {
    const t = state.tick;
    const cmds = [];
    const once = (key, cond, make) => {
      if (!done.has(key) && cond) {
        done.add(key);
        const c = make();
        if (c) cmds.push(...c);
      }
    };
    const mcvOf = (slot) => Object.values(state.units)
      .find((u) => u.owner === slot && u.defId === 'MCV');
    once('dep0', true, () => [{ player: 0, type: 'deployMCV', unitId: mcvOf(0).id }]);
    once('dep1', true, () => [{ player: 1, type: 'deployMCV', unitId: mcvOf(1).id }]);
    once('pp0', t >= 20, () => [{ player: 0, type: 'buildStructure', structId: 'SH-02' }]);
    once('pp1', t >= 25, () => [{ player: 1, type: 'buildStructure', structId: 'SH-02' }]);
    once('rax0', t >= 150, () => [{ player: 0, type: 'buildStructure', structId: 'SH-04' }]);
    once('rax1', t >= 160, () => [{ player: 1, type: 'buildStructure', structId: 'SH-04' }]);
    once('wf0', t >= 400, () => [{ player: 0, type: 'buildStructure', structId: 'SH-05' }]);
    for (const slot of [0, 1]) {
      const p = state.players[slot];
      if (p.ready.length) {
        const structId = p.ready[0];
        const key = `place${slot}:${structId}`;
        if (!done.has(key)) {
          const spot = nearConyard(state, slot, state.structDefs[structId]);
          if (spot) {
            done.add(key);
            cmds.push({ player: slot, type: 'placeStructure', structId, cx: spot.x, cy: spot.y });
          }
        }
      }
      const rax = Object.values(state.structures)
        .find((s) => s.owner === slot && s.defId === 'SH-04');
      once(`train${slot}`, !!rax, () => [0, 1, 2].map(() => ({
        player: slot, type: 'trainUnit',
        unitId: cheapestInfantry(data, state.players[slot].faction),
      })));
      const army = Object.values(state.units)
        .filter((u) => u.owner === slot && u.defId !== 'MCV' && u.defId !== 'HARV');
      once(`wave${slot}`, army.length >= 3, () => [{
        player: slot, type: 'attackMove',
        unitIds: army.map((u) => u.id), x: 48 * 64, y: 30 * 64,
      }]);
    }
    return cmds;
  };

  const run = (seed) => {
    const state = match(data, duel, ['Egypt', 'Algeria'], seed);
    const done = new Set();
    const sums = {};
    for (let t = 0; t <= 3000; t++) {
      Sim.tick(state, script(state, done));
      if (t === 500 || t === 1500 || t === 3000) sums[t] = Sim.checksum(state);
    }
    return sums;
  };
  const a = run(12345), b = run(12345);
  const same = a[500] === b[500] && a[1500] === b[1500] && a[3000] === b[3000];
  return [same, `checksums @500/1500/3000 = ${a[500]}/${a[1500]}/${a[3000]}${same ? '' : ' vs ' + JSON.stringify(b)}`];
}

function tCombatCounters(data, duel) {
  const state = match(data, duel, ['Egypt', 'Algeria'], 777);
  const kor = Sim.addUnit(state, 'EG-02', 0, 30 * 64 + 32, 60 * 64 + 32); // Kornet team
  const t90 = Sim.addUnit(state, 'DZ-07', 1, kor.x + 550, kor.y);          // T-90SA
  const t0 = state.tick;
  Sim.tick(state, [{ player: 0, type: 'attackTarget', unitIds: [kor.id], targetId: t90.id }]);
  let deathTick = -1;
  for (let i = 0; i < 2000; i++) {
    Sim.tick(state);
    if (!state.units[t90.id]) { deathTick = state.tick; break; }
  }
  if (deathTick < 0) return [false, 'T-90SA still alive after 2000 ticks'];
  const measured = deathTick - t0;
  const d = data.units.find((u) => u.id === 'EG-02');
  const hp = data.units.find((u) => u.id === 'DZ-07').hp;
  const predicted = hp / (d.dmg.armor * data.armorIncoming.Heavy * data.knobs.ATGMVsArmor) * d.rof_s * 10;
  const ok = Math.abs(measured - predicted) <= 0.25 * predicted;
  return [ok && state.units[kor.id] !== undefined,
    `T-90 died after ${measured} ticks, predicted ${predicted.toFixed(0)} (±25%)`];
}

function tEconomy(data, duel) {
  const state = match(data, duel, ['Egypt', 'Algeria'], 42);
  deploy(state, 0);
  const depot = buildAndPlace(state, 0, 'SH-03',
    (s, slot, def) => Sim.findDepotPlacement(s, slot, def));
  if (!depot) return [false, 'depot could not be placed'];
  const hv = state.units[depot.harvesterId];
  if (!hv) return [false, 'no harvester auto-spawned'];
  const p = state.players[0];
  const deltas = [];
  for (let w = 0; w < 3; w++) {
    const before = p.credits;
    for (let i = 0; i < 10; i++) Sim.tick(state);
    deltas.push(p.credits - before);
  }
  const expected = data.knobs.OilIncomePerField; // per 10 ticks (= 1s)
  const ok = deltas.every((d) => Math.abs(d - expected) <= 1);
  return [ok, `income per 10 ticks: ${deltas.join(',')} (expect ~${expected})`];
}

function tPower(data, duel) {
  const state = match(data, duel, ['Egypt', 'Algeria'], 99);
  deploy(state, 0);
  const wf = buildAndPlace(state, 0, 'SH-05');
  const af = buildAndPlace(state, 0, 'SH-06');
  const tech = buildAndPlace(state, 0, 'SH-08'); // EG-12 is WAVE1: needs tech
  if (!wf || !af || !tech) return [false, 'could not place WF/AF/tech'];
  const p = state.players[0];
  if (!p.lowPower) return [false, `expected low power (use ${p.powerUse} > out ${p.powerOut})`];

  const measure = () => {
    const before = p.unitsBuilt;
    Sim.tick(state, [{ player: 0, type: 'trainUnit', unitId: 'EG-12' }]); // Fahd APC, build_s 10
    let accept = -1, doneTick = -1, guard = 0;
    while (doneTick < 0 && guard++ < 2000) {
      Sim.tick(state);
      if (accept < 0 && wf.queue.length > 0) accept = state.tick;
      if (p.unitsBuilt > before) doneTick = state.tick;
    }
    return accept < 0 || doneTick < 0 ? -1 : doneTick - accept;
  };

  const lowTicks = measure();
  const pp = buildAndPlace(state, 0, 'SH-02');
  if (!pp) return [false, 'could not place power plant'];
  if (p.lowPower) return [false, 'expected power surplus after plant'];
  const fullTicks = measure();
  const ok = Math.abs(lowTicks - 167) <= 5 && Math.abs(fullTicks - 100) <= 5;
  return [ok, `10s unit: ${lowTicks} ticks low-power (expect ~167), ${fullTicks} ticks powered (expect ~100)`];
}

function tTechGate(data, duel) {
  const state = match(data, duel, ['Egypt', 'Algeria'], 7);
  deploy(state, 0);
  const wf = buildAndPlace(state, 0, 'SH-05');
  if (!wf) return [false, 'could not place WF'];
  const cmd = { player: 0, type: 'trainUnit', unitId: 'EG-13' }; // T-90MS, WAVE1
  const rejected = Sim.validateCommand(state, cmd);
  if (rejected.ok) return [false, 'train accepted without SH-08'];
  const tech = buildAndPlace(state, 0, 'SH-08');
  if (!tech) return [false, 'could not place SH-08'];
  const accepted = Sim.validateCommand(state, cmd);
  if (!accepted.ok) return [false, `train rejected with SH-08 (${accepted.reason})`];
  Sim.tick(state, [cmd]);
  for (let i = 0; i < 6; i++) Sim.tick(state);
  return [wf.queue.length === 1, `rejected without tech (${rejected.reason}), queued with tech`];
}

function tSuperweaponIntercept(data, duel) {
  const state = match(data, duel, ['Egypt', 'Israel'], 2024);
  deploy(state, 0);
  deploy(state, 1);
  const sw = buildAndPlace(state, 0, 'SH-13');       // October Battery
  const dome = buildAndPlace(state, 1, 'SH-23');     // Iron Dome battery
  if (!sw || !dome) return [false, `placement failed sw=${!!sw} dome=${!!dome}`];
  const dc = Sim.structCenter(dome);
  const target = { x: dc.x + 8 * 64, y: dc.y };      // in intercept range, outside blast
  const atk = state.players[0];
  const rolls0 = state.stats.interceptRolls, hits0 = state.stats.intercepted;
  const strikes = 200;
  for (let i = 0; i < strikes; i++) {
    atk.swChargeTicks = 0; // test harness: skip the 300s charge between strikes
    Sim.tick(state, [{ player: 0, type: 'useSuperweapon', x: target.x, y: target.y }]);
    for (let k = 0; k < 40; k++) Sim.tick(state);
  }
  const rolls = state.stats.interceptRolls - rolls0;
  const rate = (state.stats.intercepted - hits0) / rolls;
  const ok = rolls === strikes * 6 && rate >= 0.65 && rate <= 0.85;
  return [ok, `${rolls} rolls, intercept rate ${rate.toFixed(3)} (knob 0.75, accept [0.65, 0.85])`];
}

function tElimination(data, duel) {
  // part 1: deployed ConYard destroyed -> eliminated, match ends
  const s1 = match(data, duel, ['Egypt', 'Algeria'], 5);
  deploy(s1, 0);
  const cy = deploy(s1, 1);
  const rifle = Sim.addUnit(s1, cheapestInfantry(data, 'Algeria'), 1, 40 * 64, 40 * 64);
  s1.players[1].credits = 0; // below rebuild cost -> no rebuild window
  Sim.dealDamage(s1, cy, 999999, null);
  Sim.tick(s1);
  const p1 = s1.players[1];
  const part1 = p1.eliminated && s1.over && s1.winner === s1.players[0].team
    && s1.units[rifle.id] && s1.units[rifle.id].owner === -1;

  // part 2: undeployed MCV destroyed -> eliminated
  const s2 = match(data, duel, ['Egypt', 'Algeria'], 6);
  const mcv = Object.values(s2.units).find((u) => u.owner === 1 && u.defId === 'MCV');
  s2.players[1].credits = 0; // below rebuild cost -> no rebuild window
  Sim.dealDamage(s2, mcv, 999999, null);
  Sim.tick(s2);
  const part2 = s2.players[1].eliminated && s2.over;

  return [part1 && part2,
    `conyard-kill: eliminated=${part1}, mcv-kill: eliminated=${part2}`];
}

function tAiSmoke(data, duel) {
  const cfgs = [
    { personality: 'Front', difficulty: 'recruit' },
    { personality: 'Fortress', difficulty: 'recruit' },
  ];
  const state = match(data, duel, ['Egypt', 'Israel'], 31337, cfgs);
  const ai = Sim.createAI(
    [{ slot: 0, faction: 'Egypt', ai: cfgs[0] }, { slot: 1, faction: 'Israel', ai: cfgs[1] }],
    31337);
  try {
    for (let t = 0; t < 12000 && !state.over; t++) {
      Sim.tick(state, Sim.aiCommands(state, ai));
    }
  } catch (e) {
    return [false, `exception at tick ${state.tick}: ${e && e.message}`];
  }
  const built = state.players.reduce((n, p) => n + p.unitsBuilt, 0);
  const elim = state.players.some((p) => p.eliminated);
  const ok = elim || built >= 30;
  return [ok, `tick=${state.tick} over=${state.over} eliminated=${elim} unitsBuilt=${built}`];
}

// ---- runner -----------------------------------------------------------------

export function runAll(data, duel, coast) {
  const results = [];
  const cases = [
    ['determinism', () => tDeterminism(data, duel)],
    ['combat-counters', () => tCombatCounters(data, duel)],
    ['economy', () => tEconomy(data, duel)],
    ['power', () => tPower(data, duel)],
    ['tech-gate', () => tTechGate(data, duel)],
    ['superweapon-intercept', () => tSuperweaponIntercept(data, duel)],
    ['elimination', () => tElimination(data, duel)],
    ['ai-smoke', () => tAiSmoke(data, duel)],
  ];
  for (const [name, fn] of cases) {
    try {
      const [pass, detail] = fn();
      results.push({ name, pass: !!pass, detail });
    } catch (e) {
      results.push({ name, pass: false, detail: `exception: ${e && e.stack || e}` });
    }
  }
  return results;
}

export async function runTests(injected) {
  let { data, duel, coast } = injected || {};
  if (!data) {
    const get = (url) => fetch(url).then((r) => {
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      return r.json();
    });
    [data, duel, coast] = await Promise.all([
      get('./data/game.json'), get('./maps/duel.json'), get('./maps/coast.json'),
    ]);
  }
  return runAll(data, duel, coast);
}
