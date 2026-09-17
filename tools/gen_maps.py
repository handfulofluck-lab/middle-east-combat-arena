#!/usr/bin/env python3
"""Generate all MCA maps into client/maps/*.json plus client/maps/manifest.json.

DEPRECATED (v0.9.0): this script generates the retired v0.8.0 map set
(duel/sinai-pass/coast/tigris/hormuz/rubalkhali). The shipping set is the
real-geography one produced by tools/gen_real_maps.py — running this would
overwrite client/maps/sinai.json and manifest.json with the old content.
It now refuses to run unless --legacy is given (kept only so the old maps
stay regenerable on request).

Map format: {name, w, h, terrain: flat w*h (0=open, 1=blocked, 2=water),
oil: [{x,y}], spawns: [{x,y}]}. Deterministic (fixed seeds) — regenerate
freely. Every map is validated before being written:

- spawns on open terrain with a 9x9 open area (MCV deploy + building space)
- oil on open terrain, >=6 cells (Chebyshev) from every spawn, with a legal
  3x3 SH-03 depot footprint within 4 cells
- all spawns and oil fields mutually reachable over land (terrain == 0), so
  no field is stranded behind water for land harvesters
- on maps with water, every spawn has a water cell within 8 cells (Chebyshev)
  so naval yards are placeable from every base (v0.3.2)
"""
import json
import random
import sys
from collections import deque
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "client" / "maps"

# manifest order = menu order; spawn counts: 2/2/4/4/6/6
MAP_ORDER = ["duel", "sinai", "coast", "tigris", "hormuz", "rubalkhali"]


def new_map(name, w, h):
    return {"name": name, "w": w, "h": h,
            "terrain": [0] * (w * h), "oil": [], "spawns": []}


def set_t(m, x, y, v):
    if 0 <= x < m["w"] and 0 <= y < m["h"]:
        m["terrain"][y * m["w"] + x] = v


def block_rect(m, x, y, w, h, v=1):
    for dy in range(h):
        for dx in range(w):
            set_t(m, x + dx, y + dy, v)


def oil(m, x, y):
    m["oil"].append({"x": x, "y": y})


def spawn(m, x, y):
    m["spawns"].append({"x": x, "y": y})


def finger(m, x, y0, y1, w, rng):
    """Carve a vertical water inlet w cells wide centered at x, spanning rows
    y0..y1, with jittered edges for a natural shoreline. Rows stay mutually
    contiguous (jitter <=1 row-to-row keeps >=w-2 overlap)."""
    prev_j = 0
    for y in range(min(y0, y1), max(y0, y1) + 1):
        j = max(prev_j - 1, min(prev_j + 1, rng.randint(-1, 1)))
        prev_j = j
        half = w // 2
        for dx in range(-half + j, w - half + j):
            set_t(m, x + dx, y, 2)


def hfinger(m, y, x0, x1, w, rng):
    """Horizontal counterpart of finger(): w rows tall centered at y."""
    prev_j = 0
    for x in range(min(x0, x1), max(x0, x1) + 1):
        j = max(prev_j - 1, min(prev_j + 1, rng.randint(-1, 1)))
        prev_j = j
        half = w // 2
        for dy in range(-half + j, w - half + j):
            set_t(m, x, y + dy, 2)


# ---- the six maps -------------------------------------------------------------
# v0.6.0: all maps regenerated at ~1.5x dimensions (buildings were too big
# relative to open space). Spawn counts, water/dry identity, the sinai pass
# corridor and the rubalkhali FFA ring are preserved; oil counts stay ~per
# player, so the extra area is open maneuvering room.

def gen_duel():
    # 144x144 1v1: open desert, broken anti-diagonal rock ridge with a wide gap
    m = new_map("Duel", 144, 144)
    rng = random.Random(7)
    for y in list(range(21, 68)) + list(range(84, 128)):
        x = 143 - y
        set_t(m, x, y, 1)
        set_t(m, x - 1, y, 1)
        if rng.random() < 0.4:
            set_t(m, x - 2, y, 1)
        if rng.random() < 0.35:
            set_t(m, x, y + 1, 1)
    spawn(m, 15, 15)
    spawn(m, 127, 127)
    for (x, y) in [(24, 15), (15, 24), (120, 129), (129, 120), (72, 30), (30, 72)]:
        oil(m, x, y)
    return m


def gen_sinai():
    # 144x144 1v1: mountain spine across the middle, two 6-wide passes
    m = new_map("Sinai Pass", 144, 144)
    for y in range(66, 78):
        for x in range(144):
            if 33 <= x <= 38 or 105 <= x <= 110:
                continue  # passes
            set_t(m, x, y, 1)
    spawn(m, 21, 21)
    spawn(m, 121, 121)
    for (x, y) in [(30, 21), (21, 30), (72, 45), (112, 121), (121, 112), (70, 97)]:
        oil(m, x, y)
    return m


def gen_coast():
    # 192x192 4-player: land with a southern sea, three small rock clusters.
    # Two fjords run north off the sea along both edges so every spawn has
    # water within 8 cells (naval yards are reachable from every base).
    m = new_map("Coast", 192, 192)
    for y in range(181, 192):
        for x in range(192):
            set_t(m, x, y, 2)
    finger(m, 13, 26, 180, 5, random.Random(101))   # west fjord
    finger(m, 177, 26, 180, 5, random.Random(102))  # east fjord
    for (cx, cy) in [(48, 60), (96, 96), (144, 120)]:
        block_rect(m, cx, cy, 3, 3)
    for (x, y) in [(21, 21), (169, 21), (21, 150), (169, 150)]:
        spawn(m, x, y)
    for (x, y) in [(28, 21), (21, 28), (162, 21), (171, 28),
                   (28, 150), (21, 142), (162, 150), (171, 142),
                   (96, 75), (96, 117)]:
        oil(m, x, y)
    return m


def gen_tigris():
    # 192x192 4-player corners: 9-wide vertical river, two 8-row land bridges.
    # A short channel runs from the river to each corner spawn so naval yards
    # are reachable from every base (water within 8 cells).
    m = new_map("Tigris Crossing", 192, 192)
    for y in range(192):
        if 60 <= y <= 67 or 124 <= y <= 131:
            continue  # bridges
        for x in range(91, 100):
            set_t(m, x, y, 2)
    hfinger(m, 16, 28, 99, 3, random.Random(103))   # northwest channel
    hfinger(m, 16, 100, 163, 3, random.Random(104)) # northeast channel
    hfinger(m, 175, 28, 99, 3, random.Random(105))  # southwest channel
    hfinger(m, 175, 100, 163, 3, random.Random(106))# southeast channel
    for (x, y) in [(21, 21), (169, 21), (21, 169), (169, 169)]:
        spawn(m, x, y)
    for (x, y) in [(30, 21), (21, 30), (162, 21), (171, 30),
                   (30, 171), (21, 162), (162, 171), (171, 162)]:
        oil(m, x, y)
    return m


def gen_hormuz():
    # 240x240 6-player (3 north / 3 south): 21-row water strait, one 9-wide
    # land causeway near the west edge; naval-viable. A narrow inlet runs from
    # the strait to each spawn (water within 8 cells) so naval yards are
    # reachable from every base.
    m = new_map("Strait of Hormuz", 240, 240)
    for y in range(111, 132):
        for x in range(240):
            if 15 <= x <= 23:
                continue  # causeway
            set_t(m, x, y, 2)
    for i, sx in enumerate((45, 120, 195)):
        finger(m, sx, 29, 110, 4, random.Random(110 + i))   # north inlets
        finger(m, sx, 132, 209, 4, random.Random(120 + i))  # south inlets
    for sx in (45, 120, 195):
        spawn(m, sx, 21)
        spawn(m, sx, 217)
    for sx in (45, 120, 195):
        oil(m, sx - 10, 30)
        oil(m, sx + 10, 30)
        oil(m, sx - 10, 207)
        oil(m, sx + 10, 207)
    return m


def gen_rubalkhali():
    # 240x240 6-player ring: open desert, a few rock clusters, 14 oil fields
    # (2 per spawn + 2 bonus in the center) so small lobbies stay rich
    m = new_map("Empty Quarter", 240, 240)
    for (cx, cy) in [(120, 81), (120, 159), (54, 120), (186, 120), (96, 96), (144, 144)]:
        block_rect(m, cx, cy, 3, 3)
    for (x, y) in [(204, 120), (162, 192), (78, 192), (36, 120), (78, 48), (162, 48)]:
        spawn(m, x, y)
    for (x, y) in [(195, 111), (195, 129), (153, 183), (171, 183),
                   (69, 183), (87, 183), (45, 111), (45, 129),
                   (69, 57), (87, 57), (153, 57), (171, 57),
                   (111, 120), (129, 120)]:
        oil(m, x, y)
    return m


GENERATORS = {
    "duel": gen_duel, "sinai": gen_sinai, "coast": gen_coast,
    "tigris": gen_tigris, "hormuz": gen_hormuz, "rubalkhali": gen_rubalkhali,
}

# ---- validation ----------------------------------------------------------------

def validate(m):
    w, h, t = m["w"], m["h"], m["terrain"]

    def open_cell(x, y):
        return 0 <= x < w and 0 <= y < h and t[y * w + x] == 0

    assert len(m["terrain"]) == w * h
    for s in m["spawns"]:
        assert open_cell(s["x"], s["y"]), ("spawn blocked", m["name"], s)
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                assert open_cell(s["x"] + dx, s["y"] + dy), \
                    ("spawn clearance", m["name"], s, dx, dy)
    for i, a in enumerate(m["spawns"]):
        for b in m["spawns"][i + 1:]:
            assert max(abs(a["x"] - b["x"]), abs(a["y"] - b["y"])) >= 12, \
                ("spawns too close", m["name"], a, b)
    for o in m["oil"]:
        assert open_cell(o["x"], o["y"]), ("oil blocked", m["name"], o)
        for s in m["spawns"]:
            # >=4 clear cells from the 3x3 spawn footprint (footprint is
            # Chebyshev 1 around the spawn) -> oil at Chebyshev >= 5
            assert max(abs(o["x"] - s["x"]), abs(o["y"] - s["y"])) >= 5, \
                ("oil too close to spawn", m["name"], o, s)
        found = False
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                if all(open_cell(o["x"] + dx + i, o["y"] + dy + j)
                       for j in range(3) for i in range(3)):
                    found = True
                    break
            if found:
                break
        assert found, ("no depot spot within 4 cells", m["name"], o)

    # land connectivity: everything reachable on foot from spawn 0
    start = (m["spawns"][0]["x"], m["spawns"][0]["y"])
    seen = {start}
    q = deque([start])
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if (nx, ny) not in seen and open_cell(nx, ny):
                seen.add((nx, ny))
                q.append((nx, ny))
    for s in m["spawns"]:
        assert (s["x"], s["y"]) in seen, ("spawn unreachable over land", m["name"], s)
    for o in m["oil"]:
        assert (o["x"], o["y"]) in seen, ("oil unreachable over land", m["name"], o)

    # naval reachability: with water on the map, every spawn needs a water
    # cell within 8 cells (a ConYard chain can then reach a legal NY spot)
    if any(v == 2 for v in t):
        for s in m["spawns"]:
            near = any(
                0 <= s["x"] + dx < w and 0 <= s["y"] + dy < h
                and t[(s["y"] + dy) * w + (s["x"] + dx)] == 2
                for dy in range(-8, 9) for dx in range(-8, 9))
            assert near, ("no water within 8 of spawn", m["name"], s)


def main():
    if "--legacy" not in sys.argv:
        print("gen_maps.py is DEPRECATED (v0.9.0): it writes the retired "
              "duel/sinai-pass/coast/tigris/hormuz/rubalkhali set and would "
              "overwrite the shipping real-geography maps (sinai.json, "
              "manifest.json). Use tools/gen_real_maps.py instead. "
              "Pass --legacy to regenerate the old maps anyway.")
        return 1
    OUT.mkdir(exist_ok=True)
    for mid in MAP_ORDER:
        m = GENERATORS[mid]()
        validate(m)
        p = OUT / f"{mid}.json"
        p.write_text(json.dumps(m, separators=(",", ":")), encoding="utf-8")
        blocked = sum(1 for v in m["terrain"] if v == 1)
        water = sum(1 for v in m["terrain"] if v == 2)
        print(f"{mid}: {m['w']}x{m['h']} spawns={len(m['spawns'])} "
              f"oil={len(m['oil'])} blocked={blocked} water={water} "
              f"({p.stat().st_size:,} bytes)")
    manifest = {"maps": MAP_ORDER}
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    print(f"manifest.json: {MAP_ORDER}")


if __name__ == "__main__":
    sys.exit(main())
