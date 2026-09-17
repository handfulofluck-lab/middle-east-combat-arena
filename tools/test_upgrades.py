# v0.3.7 research upgrade kits (Grok slice 3) + formation offsets (DEEPSEEK 5):
# validate gates, happy-path buff of living units, addUnit inheritance,
# offset move destinations, and checksum determinism with both features in play.
import json
import re
import sys
from pathlib import Path

from py_mini_racer import MiniRacer

CLIENT = Path(__file__).resolve().parent.parent / "client"
MODULES = [
    "src/sim/rng.js",
    "src/sim/state.js",
    "src/sim/orders.js",
    "src/sim/path.js",
    "src/sim/combat.js",
    "src/sim/economy.js",
    "src/sim/engine.js",
    "src/sim/ai.js",
]


def inline(path: Path) -> str:
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"import\s+[\s\S]*?\sfrom\s*'[^']*';", "", src)
    src = re.sub(r"export\s*\{[\s\S]*?\}\s*from\s*'[^']*';", "", src)
    src = re.sub(r"^export\s+(async function|function|const|let)", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[\s\S]*?\};", "", src, flags=re.M)
    return src


TEST_JS = r"""
function runUpgradeTests(data, duel) {
  const out = [];
  const push = (name, pass, detail) => out.push({ name, pass: !!pass, detail: String(detail || '') });
  const mk = (players, seed) => createMatch({
    data, map: JSON.parse(JSON.stringify(duel)), players, seed: seed || 7 });

  // (a) validate gates: wrong faction / no producer / credits / double-buy
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    addStructure(st, 'SH-06', 1, 8, 8); // Algeria airfield
    st.players[1].credits = 50000;
    const wrongFac = validateCommand(st, { player: 1, type: 'researchUpgrade', upgradeId: 'EG-F16-70' });
    const noProd = validateCommand(st, { player: 0, type: 'researchUpgrade', upgradeId: 'EG-F16-70' });
    addStructure(st, 'SH-06', 0, 8, 8); // Egypt airfield
    st.players[0].credits = 100;
    const broke = validateCommand(st, { player: 0, type: 'researchUpgrade', upgradeId: 'EG-F16-70' });
    st.players[0].credits = 50000;
    const first = applyCommand(st, { player: 0, type: 'researchUpgrade', upgradeId: 'EG-F16-70' });
    const again = validateCommand(st, { player: 0, type: 'researchUpgrade', upgradeId: 'EG-F16-70' });
    push('research-validate-gates',
      wrongFac.reason === 'wrong-faction' && noProd.reason === 'no-producer'
        && broke.reason === 'credits' && first.ok && again.reason === 'already-owned',
      JSON.stringify({ wrongFac: wrongFac.reason, noProd: noProd.reason,
        broke: broke.reason, first: first.ok, again: again.reason }));
  }

  // (b) happy path: living EG-10 gets hp/maxHp x1.2 (rounded), dmgMul, label
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    addStructure(st, 'SH-06', 0, 8, 8);
    const jet = addUnit(st, 'EG-10', 0, 20 * 64 + 32, 20 * 64 + 32);
    const hp0 = jet.hp, max0 = jet.maxHp;
    st.players[0].credits = 50000;
    const r = applyCommand(st, { player: 0, type: 'researchUpgrade', upgradeId: 'EG-F16-70' });
    push('research-happy-path',
      r.ok && jet.hp === Math.round(hp0 * 1.2) && jet.maxHp === Math.round(max0 * 1.2)
        && jet.dmgMul === 1.25 && jet.upgradeName === 'F-16V Block 70'
        && st.players[0].credits === 50000 - 2200
        && st.players[0].upgrades['EG-F16-70'] === true,
      JSON.stringify({ hp: hp0 + '->' + jet.hp, max: max0 + '->' + jet.maxHp,
        dmgMul: jet.dmgMul, name: jet.upgradeName, credits: st.players[0].credits }));
  }

  // (c) a unit trained AFTER the research inherits the buff via addUnit
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    addStructure(st, 'SH-06', 0, 8, 8);
    st.players[0].credits = 50000;
    applyCommand(st, { player: 0, type: 'researchUpgrade', upgradeId: 'EG-F16-70' });
    const fresh = addUnit(st, 'EG-10', 0, 22 * 64 + 32, 20 * 64 + 32);
    const def = st.unitDefs['EG-10'];
    const other = addUnit(st, 'EG-09', 0, 24 * 64 + 32, 20 * 64 + 32); // not in appliesTo
    push('research-addunit-inherits',
      fresh.hp === Math.round(def.hp * 1.2) && fresh.maxHp === Math.round(def.hp * 1.2)
        && fresh.dmgMul === 1.25 && fresh.upgradeName === 'F-16V Block 70'
        && other.dmgMul === 1 && other.upgradeName === null,
      JSON.stringify({ hp: fresh.hp, want: Math.round(def.hp * 1.2),
        dmgMul: fresh.dmgMul, otherDmgMul: other.dmgMul }));
  }

  // (d) formation offsets: 5 units, 5 offsets -> 5 distinct destinations;
  // mismatched length rejected; non-int / out-of-range rejected
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(addUnit(st, 'EG-01', 0, 10 * 64 + 32, 10 * 64 + 32).id);
    const offsets = [{ x: 0, y: 0 }, { x: 64, y: 0 }, { x: -64, y: 0 },
      { x: 0, y: 64 }, { x: 0, y: -64 }];
    const cx = 20 * 64 + 32, cy = 20 * 64 + 32;
    const r = applyCommand(st, { player: 0, type: 'move', unitIds: ids, x: cx, y: cy, offsets });
    const dests = ids.map((id) => st.units[id].order.x + ',' + st.units[id].order.y);
    const want = offsets.map((o) => (cx + o.x) + ',' + (cy + o.y));
    const distinct = new Set(dests).size === 5;
    const match = dests.every((d, i) => d === want[i]);
    const short = validateCommand(st, { player: 0, type: 'move', unitIds: ids,
      x: cx, y: cy, offsets: offsets.slice(0, 4) });
    const badVal = validateCommand(st, { player: 0, type: 'move', unitIds: ids,
      x: cx, y: cy, offsets: [{ x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 0, y: 0 },
        { x: 0, y: 0 }, { x: 0, y: 0 }] });
    const far = validateCommand(st, { player: 0, type: 'move', unitIds: ids,
      x: cx, y: cy, offsets: [{ x: 0, y: 0 }, { x: 7 * 64, y: 0 }, { x: 0, y: 0 },
        { x: 0, y: 0 }, { x: 0, y: 0 }] });
    push('formation-offsets',
      r.ok && distinct && match
        && short.reason === 'bad-offsets' && badVal.reason === 'bad-offsets'
        && far.reason === 'bad-offsets',
      JSON.stringify({ ok: r.ok, distinct, match, dests,
        short: short.reason, badVal: badVal.reason, far: far.reason }));
  }

  // (e) determinism: two identical scripted 300-tick runs (researchUpgrade +
  // offset move in flight) produce identical checksums
  {
    const sums = [];
    for (let run = 0; run < 2; run++) {
      const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 99);
      addStructure(st, 'SH-01', 0, 8, 8);
      addStructure(st, 'SH-06', 0, 14, 8);
      st.players[0].credits = 50000;
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(addUnit(st, 'EG-01', 0, 20 * 64 + 32, 20 * 64 + 32).id);
      addUnit(st, 'EG-10', 0, 22 * 64 + 32, 20 * 64 + 32);
      const offsets = [{ x: 0, y: 0 }, { x: 64, y: 64 }, { x: -64, y: 64 }];
      const runSums = [];
      for (let t = 0; t < 300; t++) {
        const cmds = [];
        if (t === 10) cmds.push({ player: 0, type: 'researchUpgrade', upgradeId: 'EG-F16-70' });
        if (t === 20) cmds.push({ player: 0, type: 'move', unitIds: ids,
          x: 30 * 64 + 32, y: 30 * 64 + 32, offsets });
        if (t === 120) cmds.push({ player: 0, type: 'setStance', unitIds: ids, stance: 1 });
        tick(st, cmds);
        if ((t + 1) % 100 === 0) runSums.push(checksum(st));
      }
      sums.push(runSums.join('/'));
    }
    push('research-offset-determinism', sums[0] === sums[1], sums[0] + ' vs ' + sums[1]);
  }
  return out;
}
"""


def main() -> int:
    bundle = "\n;\n".join(inline(CLIENT / m) for m in MODULES)
    ctx = MiniRacer()
    for name, rel in (("__data", "data/game.json"), ("__duel", "maps/duel.json")):
        payload = (CLIENT / rel).read_text(encoding="utf-8")
        ctx.eval(f"var {name} = {json.dumps(payload)};")
    ctx.eval(bundle)
    ctx.eval(TEST_JS)
    results = json.loads(ctx.eval(
        "JSON.stringify(runUpgradeTests(JSON.parse(__data), JSON.parse(__duel)))"
    ))
    passed = 0
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}")
        passed += 1 if r["pass"] else 0
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
