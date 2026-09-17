# M2 test harness: inlines the browser ES modules and runs sim.test.js's
# runAll() inside a V8 engine (py_mini_racer; no Node on this machine).
# Usage: .venv/Scripts/python run_tests.py
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
    "test/sim.test.js",
]


def inline(path: Path) -> str:
    src = path.read_text(encoding="utf-8")
    # drop import statements (single or multiline)
    src = re.sub(r"import\s+[\s\S]*?\sfrom\s*'[^']*';", "", src)
    # drop pure re-export statements
    src = re.sub(r"export\s*\{[\s\S]*?\}\s*from\s*'[^']*';", "", src)
    # unwrap export keywords
    src = re.sub(r"^export\s+(async function|function|const|let)", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[\s\S]*?\};", "", src, flags=re.M)
    # test file references the namespace `Sim.`; modules are flat here
    if path.name == "sim.test.js":
        src = src.replace("Sim.", "")
    return src


def main() -> int:
    bundle = "\n;\n".join(inline(CLIENT / m) for m in MODULES)
    ctx = MiniRacer()
    for name, rel in (("__data", "data/game.json"), ("__duel", "maps/duel.json"),
                      ("__coast", "maps/coast.json")):
        payload = (CLIENT / rel).read_text(encoding="utf-8")
        ctx.eval(f"var {name} = {json.dumps(payload)};")
    ctx.eval(bundle)
    results = json.loads(ctx.eval(
        "JSON.stringify(runAll(JSON.parse(__data), JSON.parse(__duel), JSON.parse(__coast)))"
    ))
    passed = 0
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}")
        passed += 1 if r["pass"] else 0
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
