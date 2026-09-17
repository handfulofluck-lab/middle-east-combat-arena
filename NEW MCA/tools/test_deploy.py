# v0.3.4 deployMCV regression: blocked exact spot -> spiral search succeeds;
# fully boxed in -> command fails with _deployFailTick set, MCV kept.
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
function runDeployTests(data, duel) {
  const out = [];
  const mkPlayers = () => [{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }];
  const findMcv = (st, slot) => Object.values(st.units).find((u) => u.owner === slot && u.defId === 'MCV');
  const findCy = (st, slot) => Object.values(st.structures).find((s) => s.owner === slot && s.defId === 'SH-01');

  // T1: open ground -> deploys at exact spot
  {
    const map = JSON.parse(JSON.stringify(duel));
    const st = createMatch({ data, map, players: mkPlayers(), seed: 7 });
    const mcv = findMcv(st, 0);
    const r = applyCommand(st, { player: 0, type: 'deployMCV', unitId: mcv.id });
    const cy = findCy(st, 0);
    const exactCx = cellOf(mcv.x) - 1, exactCy = cellOf(mcv.y) - 1;
    out.push({ name: 'T1 open deploy exact spot',
      pass: r.ok && !!cy && !st.units[mcv.id] && cy.cx === exactCx && cy.cy === exactCy,
      detail: JSON.stringify({ ok: r.ok, cy: cy ? [cy.cx, cy.cy] : null, want: [exactCx, exactCy] }) });
  }

  // T2: one rock cell inside the exact 3x3 -> deploy succeeds within 5 cells
  {
    const map = JSON.parse(JSON.stringify(duel));
    const st = createMatch({ data, map, players: mkPlayers(), seed: 7 });
    const mcv = findMcv(st, 0);
    const cx = cellOf(mcv.x) - 1, cy = cellOf(mcv.y) - 1;
    st.map.terrain[cy * st.map.w + cx] = 1; // rock over one footprint cell
    const r = applyCommand(st, { player: 0, type: 'deployMCV', unitId: mcv.id });
    const cyS = findCy(st, 0);
    const near = cyS && Math.max(Math.abs(cyS.cx - cx), Math.abs(cyS.cy - cy)) <= 5;
    out.push({ name: 'T2 rock in footprint -> spiral deploy',
      pass: r.ok && !!cyS && !st.units[mcv.id] && near,
      detail: JSON.stringify({ ok: r.ok, cy: cyS ? [cyS.cx, cyS.cy] : null, around: [cx, cy] }) });
  }

  // T3: fully boxed in (rock ring radius 7) -> fails, fail tick set, MCV kept
  {
    const map = JSON.parse(JSON.stringify(duel));
    const st = createMatch({ data, map, players: mkPlayers(), seed: 7 });
    const mcv = findMcv(st, 0);
    const cx = cellOf(mcv.x) - 1, cy = cellOf(mcv.y) - 1;
    for (let dy = -7; dy <= 10; dy++) {
      for (let dx = -7; dx <= 10; dx++) {
        const qx = cx + dx, qy = cy + dy;
        if (qx >= 0 && qy >= 0 && qx < st.map.w && qy < st.map.h) {
          st.map.terrain[qy * st.map.w + qx] = 1;
        }
      }
    }
    const r = applyCommand(st, { player: 0, type: 'deployMCV', unitId: mcv.id });
    out.push({ name: 'T3 boxed in -> fail + failTick + MCV kept',
      pass: !r.ok && r.reason === 'illegal-placement'
        && st.players[0]._deployFailTick === st.tick
        && !!st.units[mcv.id] && !findCy(st, 0),
      detail: JSON.stringify({ ok: r.ok, reason: r.reason, tick: st.players[0]._deployFailTick }) });
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
        "JSON.stringify(runDeployTests(JSON.parse(__data), JSON.parse(__duel)))"
    ))
    passed = 0
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}")
        passed += 1 if r["pass"] else 0
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
