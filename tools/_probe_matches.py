# Temporary probe: run the three candidate ai-full matches standalone to
# measure conclusion + ticks before encoding them into run_qa.py. Deleted
# after use.
import json
import sys
import time
from pathlib import Path

from py_mini_racer import MiniRacer

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_qa as rq

MAP_IDS = ["sinai", "gulf", "maghreb"]
MATCHES = [
    ("sinai 2p", "sinai", ["Egypt", "Israel"], 31337, 40000),
    ("gulf 6p", "gulf",
     ["Egypt", "Saudi", "Turkey", "Israel", "Iran", "Pakistan"], 2024, 60000),
    ("maghreb 4p", "maghreb", ["Egypt", "Israel", "Turkey", "Iran"], 777, 60000),
    ("maghreb 6p", "maghreb",
     ["Egypt", "Saudi", "Turkey", "Israel", "Iran", "Pakistan"], 778, 60000),
]


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    bundle = "\n;\n".join(rq.inline(rq.CLIENT / m) for m in rq.MODULES)
    ctx = MiniRacer()
    payload = (rq.CLIENT / "data/game.json").read_text(encoding="utf-8")
    ctx.eval(f"var __data = {json.dumps(payload)};")
    for m in MAP_IDS:
        mp = (rq.CLIENT / f"maps/{m}.json").read_text(encoding="utf-8")
        ctx.eval(f"var __map_{m} = {json.dumps(mp)};")
    ctx.eval(bundle)
    ctx.eval(rq.TEST_JS)
    ctx.eval(
        "var DATA = JSON.parse(__data);"
        "var MAPS = {" + ",".join(f"{m}: JSON.parse(__map_{m})" for m in MAP_IDS) + "};"
    )
    ctx.eval(
        "var __probe = function (mid, factions, seed, cap) {"
        "  try { return { err: null, r: qaAiMatch(DATA, MAPS, mid, factions, seed, cap) }; }"
        "  catch (e) { return { err: String(e && e.stack || e), r: null }; }"
        "};"
    )
    for name, mid, factions, seed, cap in MATCHES:
        t0 = time.perf_counter()
        args = json.dumps([mid, factions, seed, cap])
        r = json.loads(ctx.eval(
            f"JSON.stringify(__probe.apply(null, JSON.parse('{args}')))"))
        dt = time.perf_counter() - t0
        print(f"[{dt:6.1f}s] {name}: {json.dumps(r)}", flush=True)


if __name__ == "__main__":
    main()
