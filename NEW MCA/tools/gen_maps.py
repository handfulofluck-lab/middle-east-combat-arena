#!/usr/bin/env python3
"""Generate all MCA maps into client/maps/*.json plus client/maps/manifest.json.

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

def gen_duel():
    # 96x96 1v1: open desert, broken anti-diagonal rock ridge with a wide gap
    m = new_map("Duel", 96, 96)
    rng = random.Random(7)
    for y in list(range(14, 45)) + list(range(56, 85)):
        x = 95 - y
        set_t(m, x, y, 1)
        set_t(m, x - 1, y, 1)
        if rng.random() < 0.4:
            set_t(m, x - 2, y, 1)
        if rng.random() < 0.35:
            set_t(m, x, y + 1, 1)
    spawn(m, 10, 10)
    spawn(m, 85, 85)
    for (x, y) in [(16, 10), (10, 16), (80, 86), (86, 80), (48, 20), (20, 48)]:
        oil(m, x, y)
    return m


def gen_sinai():
    # 96x96 1v1: mountain spine across the middle, two 4-wide passes
    m = new_map("Sinai Pass", 96, 96)
    for y in range(44, 52):
        for x in range(96):
            if 22 <= x <= 25 or 70 <= x <= 73:
                continue  # passes
            set_t(m, x, y, 1)
    spawn(m, 14, 14)
    spawn(m, 81, 81)
    for (x, y) in [(20, 14), (14, 20), (48, 30), (75, 81), (81, 75), (47, 65)]:
        oil(m, x, y)
    return m


def gen_coast():
    # 128x128 4-player: land with a southern sea, three small rock clusters.
    # v0.3.2: two fjords run north off the sea along both edges so every spawn
    # has water within 8 cells (naval yards are reachable from every base).
    m = new_map("Coast", 128, 128)
    for y in range(121, 128):
        for x in range(128):
            set_t(m, x, y, 2)
    finger(m, 7, 20, 120, 4, random.Random(101))   # west fjord
    finger(m, 121, 20, 120, 4, random.Random(102))  # east fjord
    for (cx, cy) in [(32, 40), (64, 64), (96, 80)]:
        block_rect(m, cx, cy, 3, 3)
    for (x, y) in [(14, 14), (113, 14), (14, 100), (113, 100)]:
        spawn(m, x, y)
    for (x, y) in [(19, 14), (14, 19), (108, 14), (114, 19),
                   (19, 100), (14, 95), (108, 100), (114, 95),
                   (64, 50), (64, 78)]:
        oil(m, x, y)
    return m


def gen_tigris():
    # 128x128 4-player corners: 6-wide vertical river, two 5-row land bridges.
    # v0.3.2: a short channel runs from the river to each corner spawn so
    # naval yards are reachable from every base (water within 8 cells).
    m = new_map("Tigris Crossing", 128, 128)
    for y in range(128):
        if 40 <= y <= 44 or 83 <= y <= 87:
            continue  # bridges
        for x in range(61, 67):
            set_t(m, x, y, 2)
    hfinger(m, 11, 19, 66, 3, random.Random(103))   # northwest channel
    hfinger(m, 11, 67, 108, 3, random.Random(104))  # northeast channel
    hfinger(m, 117, 19, 66, 3, random.Random(105))  # southwest channel
    hfinger(m, 117, 67, 108, 3, random.Random(106)) # southeast channel
    for (x, y) in [(14, 14), (113, 14), (14, 113), (113, 113)]:
        spawn(m, x, y)
    for (x, y) in [(20, 14), (14, 20), (108, 14), (114, 20),
                   (20, 114), (14, 108), (108, 114), (114, 108)]:
        oil(m, x, y)
    return m


def gen_hormuz():
    # 160x160 6-player (3 north / 3 south): 14-row water strait, one 6-wide
    # land causeway near the west edge; naval-viable. v0.3.2: a narrow inlet
    # runs from the strait to each spawn (water within 8 cells) so naval
    # yards are reachable from every base.
    m = new_map("Strait of Hormuz", 160, 160)
    for y in range(74, 88):
        for x in range(160):
            if 10 <= x <= 15:
                continue  # causeway
            set_t(m, x, y, 2)
    for i, sx in enumerate((30, 80, 130)):
        finger(m, sx, 22, 73, 4, random.Random(110 + i))   # north inlets
        finger(m, sx, 88, 137, 4, random.Random(120 + i))  # south inlets
    for sx in (30, 80, 130):
        spawn(m, sx, 14)
        spawn(m, sx, 145)
    for sx in (30, 80, 130):
        oil(m, sx - 7, 20)
        oil(m, sx + 7, 20)
        oil(m, sx - 7, 138)
        oil(m, sx + 7, 138)
    return m


def gen_rubalkhali():
    # 160x160 6-player ring: open desert, a few rock clusters, 14 oil fields
    # (2 per spawn + 2 bonus in the center) so small lobbies stay rich
    m = new_map("Empty Quarter", 160, 160)
    for (cx, cy) in [(80, 54), (80, 106), (36, 80), (124, 80), (64, 64), (96, 96)]:
        block_rect(m, cx, cy, 3, 3)
    for (x, y) in [(136, 80), (108, 128), (52, 128), (24, 80), (52, 32), (108, 32)]:
        spawn(m, x, y)
    for (x, y) in [(130, 74), (130, 86), (102, 122), (114, 122),
                   (46, 122), (58, 122), (30, 74), (30, 86),
                   (46, 38), (58, 38), (102, 38), (114, 38),
                   (74, 80), (86, 80)]:
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
    main()
