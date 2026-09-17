# v0.9.0 transports (embark/disembark): load validation (ownership, infantry
# class, capacity), snapshot cargo (units despawn onto the carrier), carrier
# slowdown while loaded + restore after unload, land-only unload ring with
# blocked cells skipped, and cargo dying with a destroyed carrier.
# Usage: tools/.venv/Scripts/python tools/test_transports.py
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
function runTransportTests(data, duel) {
  const out = [];
  const push = (name, pass, detail) => out.push({ name, pass: !!pass,
    detail: String(detail || '') });
  const mk = (players, seed) => createMatch({
    data, map: JSON.parse(JSON.stringify(duel)), players, seed: seed || 7 });
  const infId = data.units
    .filter((u) => u.faction === 'Egypt' && u.cls === 'Infantry')
    .sort((a, b) => a.cost - b.cost)[0].id;

  // (a) validation: capacity rejection, class/ownership rules, empty unload
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const apc = addUnit(st, 'EG-12', 0, 30 * 64 + 32, 60 * 64 + 32); // cap 3
    const riflemen = [];
    for (let i = 0; i < 4; i++) {
      riflemen.push(addUnit(st, infId, 0, 31 * 64 + 32, 60 * 64 + 32).id);
    }
    const tank = addUnit(st, 'EG-06', 0, 32 * 64 + 32, 60 * 64 + 32);
    const foeApc = addUnit(st, 'DZ-11', 1, 33 * 64 + 32, 60 * 64 + 32);
    const over = validateCommand(st, { player: 0, type: 'load',
      unitIds: riflemen, carrierId: apc.id });
    const notInf = validateCommand(st, { player: 0, type: 'load',
      unitIds: [tank.id], carrierId: apc.id });
    const foeCar = validateCommand(st, { player: 0, type: 'load',
      unitIds: [riflemen[0]], carrierId: foeApc.id });
    const empty = validateCommand(st, { player: 0, type: 'unload', carrierId: apc.id });
    const notCarrier = validateCommand(st, { player: 0, type: 'unload', carrierId: tank.id });
    push('validate: capacity/class/ownership/empty',
      !over.ok && over.reason === 'capacity'
        && !notInf.ok && notInf.reason === 'no-units'
        && !foeCar.ok && foeCar.reason === 'bad-carrier'
        && !empty.ok && empty.reason === 'empty'
        && !notCarrier.ok && notCarrier.reason === 'bad-carrier',
      JSON.stringify({ over: over.reason, notInf: notInf.reason,
        foeCar: foeCar.reason, empty: empty.reason, notCarrier: notCarrier.reason }));
  }

  // (b) apply: 4 riflemen -> APC vanish into cargo=4 on a bigger carrier;
  // hp/rank snapshots preserved
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    // IL-06 heavy APC (cost 1100 -> capacity 7) via neutral-ish setup is
    // Israel-only; use Egypt's IFV EG-05 (cost 700 -> capacity 5)
    const ifv = addUnit(st, 'EG-05', 0, 30 * 64 + 32, 60 * 64 + 32);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(addUnit(st, infId, 0, 31 * 64 + 32, 60 * 64 + 32).id);
    st.units[ids[1]].hp = 77;
    st.units[ids[1]].rank = 1;
    const v = validateCommand(st, { player: 0, type: 'load', unitIds: ids, carrierId: ifv.id });
    const r = applyCommand(st, { player: 0, type: 'load', unitIds: ids, carrierId: ifv.id });
    const gone = ids.every((id) => !st.units[id]);
    const cargo = ifv.cargo || [];
    const snapOk = cargo.length === 4 && cargo[1].hp === 77 && cargo[1].rank === 1
      && cargo[0].defId === infId && cargo.every((c) => c.maxHp > 0);
    push('apply: 4 riflemen embark, cargo=4, snapshot kept',
      v.ok && r.ok && gone && snapOk,
      JSON.stringify({ v: v.ok, r: r.ok, gone, cargo: cargo.length,
        hp1: cargo[1] && cargo[1].hp, rank1: cargo[1] && cargo[1].rank }));
  }

  // (c) carrier slowdown while loaded, restored after unload
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const loaded = addUnit(st, 'EG-12', 0, 30 * 64 + 32, 60 * 64 + 32);
    const empty = addUnit(st, 'EG-12', 0, 33 * 64 + 32, 60 * 64 + 32);
    const men = [];
    for (let i = 0; i < 3; i++) men.push(addUnit(st, infId, 0, 30 * 64 + 32, 61 * 64 + 32).id);
    applyCommand(st, { player: 0, type: 'load', unitIds: men, carrierId: loaded.id });
    applyCommand(st, { player: 0, type: 'move', unitIds: [loaded.id],
      x: 30 * 64 + 32, y: 80 * 64 + 32 });
    applyCommand(st, { player: 0, type: 'move', unitIds: [empty.id],
      x: 33 * 64 + 32, y: 80 * 64 + 32 });
    for (let i = 0; i < 40; i++) tick(st);
    const dL = Math.round(Math.sqrt(dist2(loaded.x, loaded.y, 30 * 64 + 32, 60 * 64 + 32)));
    const dE = Math.round(Math.sqrt(dist2(empty.x, empty.y, 33 * 64 + 32, 60 * 64 + 32)));
    const slowed = dL < dE - 20; // 10 vs ~8-9 wu/tick over 40 ticks
    // unload: everyone back on land, cargo empty
    const uv = validateCommand(st, { player: 0, type: 'unload', carrierId: loaded.id });
    const ur = applyCommand(st, { player: 0, type: 'unload', carrierId: loaded.id });
    const cargoAfter = (loaded.cargo || []).length;
    // speed restored: both travel the same distance now
    const lx = loaded.x, ly = loaded.y, ex = empty.x, ey = empty.y;
    applyCommand(st, { player: 0, type: 'move', unitIds: [loaded.id],
      x: lx, y: ly + 15 * 64 });
    applyCommand(st, { player: 0, type: 'move', unitIds: [empty.id],
      x: ex, y: ey + 15 * 64 });
    for (let i = 0; i < 40; i++) tick(st);
    const dL2 = Math.abs(loaded.y - ly);
    const dE2 = Math.abs(empty.y - ey);
    push('carrier slowed loaded, restored after unload',
      slowed && uv.ok && ur.ok && cargoAfter === 0 && Math.abs(dL2 - dE2) <= 16,
      JSON.stringify({ dL, dE, slowed, cargoAfter, dL2, dE2 }));
  }

  // (d) unload ring: blocked water cells are skipped, spawns land on open land
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const apc = addUnit(st, 'EG-12', 0, 40 * 64 + 32, 60 * 64 + 32);
    const men = [];
    for (let i = 0; i < 3; i++) men.push(addUnit(st, infId, 0, 41 * 64 + 32, 60 * 64 + 32).id);
    applyCommand(st, { player: 0, type: 'load', unitIds: men, carrierId: apc.id });
    // flood the r=1 ring with water (terrain is read directly by the unload
    // search; no cached passability grid is consulted)
    const cx0 = cellOf(apc.x), cy0 = cellOf(apc.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        st.map.terrain[(cy0 + dy) * st.map.w + (cx0 + dx)] = 2;
      }
    }
    const r = applyCommand(st, { player: 0, type: 'unload', carrierId: apc.id });
    const spawned = Object.values(st.units)
      .filter((u) => u.defId === infId && u.owner === 0);
    const allLand = spawned.every((u) => {
      const t = st.map.terrain[cellOf(u.y) * st.map.w + cellOf(u.x)];
      return t === 0;
    });
    const allOutside = spawned.every((u) => {
      return Math.max(Math.abs(cellOf(u.x) - cx0), Math.abs(cellOf(u.y) - cy0)) >= 2;
    });
    push('unload ring skips blocked cells, lands on open land',
      r.ok && spawned.length === 3 && allLand && allOutside && (apc.cargo || []).length === 0,
      JSON.stringify({ spawned: spawned.length, allLand, allOutside,
        cargoLeft: (apc.cargo || []).length }));
  }

  // (e) carrier death kills the cargo (documented: cargo is not recoverable)
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const apc = addUnit(st, 'EG-12', 0, 40 * 64 + 32, 60 * 64 + 32);
    const men = [];
    for (let i = 0; i < 2; i++) men.push(addUnit(st, infId, 0, 41 * 64 + 32, 60 * 64 + 32).id);
    applyCommand(st, { player: 0, type: 'load', unitIds: men, carrierId: apc.id });
    dealDamage(st, apc, 999999, null);
    const noInf = !Object.values(st.units)
      .some((u) => u.owner === 0 && u.defId === infId);
    const v = validateCommand(st, { player: 0, type: 'unload', carrierId: apc.id });
    push('carrier death kills cargo',
      !st.units[apc.id] && noInf && !v.ok && v.reason === 'bad-carrier',
      JSON.stringify({ carrierGone: !st.units[apc.id], noInf, reason: v.reason }));
  }

  // (f) unload restores hp/rank from the snapshot
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const apc = addUnit(st, 'EG-12', 0, 40 * 64 + 32, 60 * 64 + 32);
    const man = addUnit(st, infId, 0, 41 * 64 + 32, 60 * 64 + 32);
    man.hp = 55;
    man.rank = 2;
    applyCommand(st, { player: 0, type: 'load', unitIds: [man.id], carrierId: apc.id });
    applyCommand(st, { player: 0, type: 'unload', carrierId: apc.id });
    const back = Object.values(st.units)
      .find((u) => u.defId === infId && u.owner === 0);
    push('unload restores hp/rank snapshot',
      !!back && back.hp === 55 && back.rank === 2,
      JSON.stringify({ hp: back && back.hp, rank: back && back.rank }));
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
        "JSON.stringify(runTransportTests(JSON.parse(__data), JSON.parse(__duel)))"
    ))
    passed = 0
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}")
        passed += 1 if r["pass"] else 0
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
