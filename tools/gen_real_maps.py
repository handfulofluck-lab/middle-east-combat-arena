#!/usr/bin/env python3
"""Generate the v0.9.0 real-geography map set into client/maps/*.json plus
client/maps/manifest.json.

Each region is drawn north-up from hand-tuned boolean coast functions
(polygons, varying-width coast polylines, discs); cells are land when the
center sample is inside AND at least 2 of the 4 quadrant sub-samples are
inside. Post-processing: one 3x3 majority smooth (kept to a single pass so
6+ cell straits survive), a deterministic hash-based rock scatter, then
deterministic spawn/oil placement, then hard validation.

Map format: {name, w, h, terrain: flat w*h (0=open, 1=rock, 2=water),
oil: [{x,y}], spawns: [{x,y}], briefing}. Deterministic: no RNG, only
coordinate hashes — two consecutive runs produce byte-identical JSON.

Validation per map:
- terrain length/values; land (non-water) fraction 45-75%
- spawns on open cells with a 9x9 open area, a 10x10 open block within 6
  cells, pairwise Chebyshev >= 25% of map width, spread across the region
- one connected land mass (BFS over terrain==0); every spawn and oil field
  reachable from spawn 0
- oil on open cells, 6..14 fields, >=5 Chebyshev from spawns and from each
  other, with a legal 3x3 depot footprint within 4 cells
- wet maps: water exists and at least half the spawns are within 70
  (Chebyshev) of water, so naval yards are placeable from most bases
- dry maps: zero water cells

Playability deviations from strict geography (deliberate, documented):
- straits are drawn 6-10 cells wide (Gibraltar, Hormuz, Bab al-Mandab,
  the Bosporus) so buildings/armies fit; real widths are far thinner
- the gulf/gulfstates head bays close inside the frame so Iran and Arabia
  share a land corridor at the map edge (real assault route around the
  Shatt al-Arab head; keeps land assault possible, like the old hormuz
  causeway)
- islands smaller than ~30 cells (Bahrain etc.) are joined to the nearest
  coast by a narrow isthmus to preserve the single-land-mass guarantee
- the Indus is a narrow navigable channel crossed by two rock causeways
"""
import json
import sys
from collections import deque
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "client" / "maps"

T_OPEN, T_ROCK, T_WATER = 0, 1, 2

# map id -> per-map seed for the coordinate hash (arbitrary constants)
SEEDS = {
    "sinai": 1101, "jerusalem": 1102, "arabia": 1103, "gulf": 1104,
    "redsea": 1105, "maghreb": 1106, "anatolia": 1107, "indus": 1108,
    "gulfstates": 1109,
}


def h2(seed, x, y):
    """FNV-1a over (seed, x, y) -> uint32. Pure coordinate hash."""
    h = 0x811C9DC5
    for v in (seed, x & 0xFFFF, y & 0xFFFF, (x >> 16) & 0xFFFF, (y >> 16) & 0xFFFF):
        h ^= v & 0xFFFF
        h = (h * 0x01000193) & 0xFFFFFFFF
        h ^= (v >> 16) & 0xFFFF
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


# ---------- geometry primitives (all in cell units, y grows south) ----------

def in_poly(px, py, pts):
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > py) != (yj > py):
            xint = (xj - xi) * (py - yi) / (yj - yi) + xi
            if px < xint:
                inside = not inside
        j = i
    return inside


def _seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        t = 0.0
    else:
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    qx, qy = ax + t * dx, ay + t * dy
    return (px - qx) ** 2 + (py - qy) ** 2, t


def poly(pts):
    return lambda x, y: in_poly(x, y, pts)


def disc(cx, cy, r):
    r2 = r * r
    return lambda x, y: (x - cx) ** 2 + (y - cy) ** 2 <= r2


def band(pts_r):
    """Varying-width polyline 'coast': pts_r = [(x, y, half_width), ...].
    Inside when within the interpolated half-width of any segment."""
    def f(x, y):
        best = None
        for i in range(len(pts_r) - 1):
            ax, ay, ra = pts_r[i]
            bx, by, rb = pts_r[i + 1]
            d2, t = _seg(x, y, ax, ay, bx, by)
            r = ra + (rb - ra) * t
            v = d2 - r * r
            if best is None or v < best:
                best = v
        return best <= 0.0
    return f


def U(*fs):
    return lambda x, y: any(f(x, y) for f in fs)


def D(f, *gs):
    return lambda x, y: f(x, y) and not any(g(x, y) for g in gs)


# ---------- raster + post-processing ----------

def rasterize(w, h, land_fn):
    """center-inside AND >=2 of 4 quadrant sub-samples inside -> land"""
    g = [T_WATER] * (w * h)
    for y in range(h):
        for x in range(w):
            c = land_fn(x + 0.5, y + 0.5)
            if not c:
                continue
            q = (land_fn(x + 0.25, y + 0.25) + land_fn(x + 0.75, y + 0.25) +
                 land_fn(x + 0.25, y + 0.75) + land_fn(x + 0.75, y + 0.75))
            if q >= 2:
                g[y * w + x] = T_OPEN
    return g


def smooth_majority(g, w, h):
    """One 3x3 majority pass over land/water, scaled to the clipped
    neighborhood size so border/corner cells aren't eroded; exact ties
    (half the sampled cells solid) keep the current cell."""
    out = g[:]
    for y in range(h):
        for x in range(w):
            solid = 0
            cnt = 0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h:
                        cnt += 1
                        if g[ny * w + nx] != T_WATER:
                            solid += 1
            want_solid = solid * 2 > cnt
            if want_solid and g[y * w + x] == T_WATER:
                out[y * w + x] = T_OPEN
            elif not want_solid and g[y * w + x] != T_WATER:
                out[y * w + x] = T_WATER
    return out


def land_components(g, w, h):
    """4-connected components over open land (terrain==0)."""
    comp = [-1] * (w * h)
    sizes = []
    cid = 0
    for i in range(w * h):
        if g[i] != T_OPEN or comp[i] >= 0:
            continue
        q = deque([i])
        comp[i] = cid
        n = 0
        while q:
            j = q.popleft()
            n += 1
            x, y = j % w, j // w
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h:
                    k = ny * w + nx
                    if g[k] == T_OPEN and comp[k] < 0:
                        comp[k] = cid
                        q.append(k)
        sizes.append(n)
        cid += 1
    return comp, sizes


def enforce_single_landmass(g, w, h, name):
    """Erase tiny islets; join >=30-cell components to the largest mass with
    a 3-cell-wide deterministic isthmus."""
    for _ in range(4):
        comp, sizes = land_components(g, w, h)
        if len(sizes) <= 1:
            return
        main = max(range(len(sizes)), key=lambda i: sizes[i])
        # Chebyshev distance field from the main mass (8-neigh BFS)
        INF = 10 ** 9
        dist = [INF] * (w * h)
        q = deque()
        for i in range(w * h):
            if comp[i] == main:
                dist[i] = 0
                q.append(i)
        while q:
            j = q.popleft()
            x, y = j % w, j // w
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if not dx and not dy:
                        continue
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h:
                        k = ny * w + nx
                        if dist[k] > dist[j] + 1:
                            dist[k] = dist[j] + 1
                            q.append(k)
        joined = False
        for cid in range(len(sizes)):
            if cid == main or sizes[cid] == 0:
                continue
            cells = [i for i in range(w * h) if comp[i] == cid]
            if sizes[cid] < 30:
                for i in cells:
                    g[i] = T_WATER
                joined = True
                continue
            # isthmus from the component cell closest to the main mass,
            # walking down the distance field
            start = min(cells, key=lambda i: (dist[i], i))
            if dist[start] >= INF:
                for i in cells:
                    g[i] = T_WATER
                joined = True
                continue
            path = []
            i = start
            while dist[i] > 0:
                path.append(i)
                x, y = i % w, i // w
                nxt = None
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        if not dx and not dy:
                            continue
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h:
                            k = ny * w + nx
                            if dist[k] < dist[i]:
                                nxt = k
                                break
                    if nxt is not None:
                        break
                i = nxt
            for p in path:
                px, py = p % w, p // w
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = px + dx, py + dy
                        if 0 <= nx < w and 0 <= ny < h:
                            k = ny * w + nx
                            if g[k] == T_WATER:
                                g[k] = T_OPEN
            joined = True
        if not joined:
            raise AssertionError(f"{name}: cannot join land components")


# ---------- spawn / oil / rocks ----------

def water_cheb_dist(g, w, h):
    """Chebyshev distance to the nearest water cell (8-neigh BFS)."""
    INF = 10 ** 9
    dist = [INF] * (w * h)
    q = deque()
    for i in range(w * h):
        if g[i] == T_WATER:
            dist[i] = 0
            q.append(i)
    while q:
        j = q.popleft()
        x, y = j % w, j // w
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if not dx and not dy:
                    continue
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h:
                    k = ny * w + nx
                    if dist[k] > dist[j] + 1:
                        dist[k] = dist[j] + 1
                        q.append(k)
    return dist


def open_block(g, w, h, x, y, hw, hh):
    """all cells of the (2hw+1)x(2hh+1) block around (x,y) are open land"""
    for dy in range(-hh, hh + 1):
        for dx in range(-hw, hw + 1):
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h) or g[ny * w + nx] != T_OPEN:
                return False
    return True


def has_open_block(g, w, h, x, y, bw, bh, r):
    """a bw x bh all-open block exists within Chebyshev r of (x,y)"""
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if max(abs(dx), abs(dy)) > r:
                continue
            ok = True
            for by in range(bh):
                for bx in range(bw):
                    nx, ny = x + dx + bx, y + dy + by
                    if not (0 <= nx < w and 0 <= ny < h) or g[ny * w + nx] != T_OPEN:
                        ok = False
                        break
                if not ok:
                    break
            if ok:
                return True
    return False


def spawn_ok(g, w, h, x, y):
    return (open_block(g, w, h, x, y, 4, 4)
            and has_open_block(g, w, h, x, y, 10, 10, 6))


def pick_spawns(g, w, h, zones, n, sep, wdist):
    """zones: ordered [{rect:(x0,y0,x1,y1), wet:bool}]. One spawn per zone in
    order (best max-min-distance candidate), then a global fallback pass."""
    chosen = []

    def try_cell(x, y, wet):
        if not spawn_ok(g, w, h, x, y):
            return None
        if wet and wdist[y * w + x] > 70:
            return None
        d = min((max(abs(x - c[0]), abs(y - c[1])) for c in chosen), default=10 ** 9)
        if chosen and d < sep:
            return None
        return d

    for zone in zones:
        if len(chosen) >= n:
            break
        x0, y0, x1, y1 = zone["rect"]
        best = None
        for y in range(max(6, y0), min(h - 6, y1)):
            for x in range(max(6, x0), min(w - 6, x1)):
                d = try_cell(x, y, zone.get("wet", False))
                if d is not None and (best is None or d > best[0]):
                    best = (d, x, y)
        if best:
            chosen.append((best[1], best[2]))
    while len(chosen) < n:
        best = None
        for y in range(6, h - 6):
            for x in range(6, w - 6):
                d = try_cell(x, y, False)
                if d is not None and (best is None or d > best[0]):
                    best = (d, x, y)
        if not best:
            raise AssertionError(f"only {len(chosen)}/{n} spawns placed")
        chosen.append((best[1], best[2]))
    return [{"x": x, "y": y} for x, y in chosen[:n]]


def scatter_rocks(g, w, h, seed, spawns, density_permille=3):
    """Small deterministic rock patches on land, away from spawn bases."""
    for y in range(h):
        for x in range(w):
            if g[y * w + x] != T_OPEN:
                continue
            hh = h2(seed, x, y)
            if hh % 1000 >= density_permille:
                continue
            if hh % 3 == 0:  # two-cell blob, orientation from the hash
                cells = [(x, y), (x + (1 if hh & 4 else -1), y)]
            else:
                cells = [(x, y)]
            for cx, cy in cells:
                if not (0 <= cx < w and 0 <= cy < h):
                    continue
                if g[cy * w + cx] != T_OPEN:
                    continue
                if any(max(abs(cx - s["x"]), abs(cy - s["y"])) < 28 for s in spawns):
                    continue
                g[cy * w + cx] = T_ROCK
    # a rock blob can pinch off a tiny open pocket — reopen rock cells until
    # the open land is a single mass again
    for _ in range(64):
        comp, sizes = land_components(g, w, h)
        if len(sizes) <= 1:
            break
        main = max(range(len(sizes)), key=lambda i: sizes[i])
        fixed = False
        for i in range(w * h):
            if comp[i] < 0 or comp[i] == main or sizes[comp[i]] >= 30:
                continue
            x, y = i % w, i // w
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and g[ny * w + nx] == T_ROCK:
                    g[ny * w + nx] = T_OPEN
                    fixed = True
                    break
            if fixed:
                break
        if not fixed:
            break


def place_oil(g, w, h, spawns, target, wdist):
    """Deterministic per-spawn ring scan: ~2 fields per base, coastal when
    possible, >=5 Chebyshev from spawns and from each other, with a 3x3
    depot footprint within 4 cells."""
    oil = []

    def ok_cell(x, y, coastal):
        if not (0 <= x < w and 0 <= y < h) or g[y * w + x] != T_OPEN:
            return False
        if coastal and wdist[y * w + x] > 24:
            return False
        if any(max(abs(x - s["x"]), abs(y - s["y"])) < 5 for s in spawns):
            return False
        if any(max(abs(x - o["x"]), abs(y - o["y"])) < 5 for o in oil):
            return False
        return has_open_block(g, w, h, x, y, 3, 3, 4)

    for coastal in (True, False):
        for r in range(9, 40):
            for s in spawns:
                if len(oil) >= target:
                    return oil
                placed = False
                for dy in range(-r, r + 1):
                    for dx in range(-r, r + 1):
                        if max(abs(dx), abs(dy)) != r:
                            continue
                        if ok_cell(s["x"] + dx, s["y"] + dy, coastal):
                            oil.append({"x": s["x"] + dx, "y": s["y"] + dy})
                            placed = True
                            break
                    if placed:
                        break
            if len(oil) >= target:
                break
    if len(oil) < 6:
        raise AssertionError(f"oil placement starved: {len(oil)}/{target}")
    return oil


# ---------- validation ----------

def validate(mid, m, wet, n_spawns):
    w, h, g = m["w"], m["h"], m["terrain"]
    assert len(g) == w * h, (mid, "terrain length")
    assert all(v in (0, 1, 2) for v in g), (mid, "terrain values")
    water = sum(1 for v in g if v == T_WATER)
    if wet:
        assert water > 0, (mid, "expected water")
    else:
        assert water == 0, (mid, "dry map has water")
    land = w * h - water
    frac = land / (w * h)
    assert 0.45 <= frac <= 0.75, (mid, "land fraction", frac)

    sp = m["spawns"]
    assert len(sp) == n_spawns, (mid, "spawn count", len(sp))
    sep = int(0.25 * w)
    for i, s in enumerate(sp):
        assert open_at(g, w, h, s["x"], s["y"]), (mid, "spawn blocked", s)
        assert open_block(g, w, h, s["x"], s["y"], 4, 4), (mid, "spawn 9x9", s)
        assert has_open_block(g, w, h, s["x"], s["y"], 10, 10, 6), (mid, "spawn room", s)
        for s2 in sp[i + 1:]:
            assert max(abs(s["x"] - s2["x"]), abs(s["y"] - s2["y"])) >= sep, \
                (mid, "spawns close", s, s2)
    o = m["oil"]
    assert 6 <= len(o) <= 14, (mid, "oil count", len(o))
    for i, f in enumerate(o):
        assert open_at(g, w, h, f["x"], f["y"]), (mid, "oil blocked", f)
        assert has_open_block(g, w, h, f["x"], f["y"], 3, 3, 4), (mid, "oil depot", f)
        for s in sp:
            assert max(abs(f["x"] - s["x"]), abs(f["y"] - s["y"])) >= 5, \
                (mid, "oil near spawn", f, s)
        for f2 in o[i + 1:]:
            assert max(abs(f["x"] - f2["x"]), abs(f["y"] - f2["y"])) >= 5, \
                (mid, "oil fields close", f, f2)

    # single connected open-land mass reaching every spawn and oil field
    comp, sizes = land_components(g, w, h)
    open_cells = sum(1 for v in g if v == T_OPEN)
    assert sizes and sizes[0] == open_cells and len(sizes) == 1, \
        (mid, "land not one connected mass", sizes[:6])
    for s in sp:
        assert comp[s["y"] * w + s["x"]] == 0, (mid, "spawn off main mass", s)
    for f in o:
        assert comp[f["y"] * w + f["x"]] == 0, (mid, "oil off main mass", f)

    if wet:
        wd = water_cheb_dist(g, w, h)
        near = sum(1 for s in sp if wd[s["y"] * w + s["x"]] <= 70)
        assert 2 * near >= len(sp), (mid, "too few coastal spawns", near)
        return wd, water, frac
    return None, water, frac


def open_at(g, w, h, x, y):
    return 0 <= x < w and 0 <= y < h and g[y * w + x] == T_OPEN


# ---------- the nine regions ----------

def land_sinai():
    # Sinai triangle: Mediterranean along the top, Gulf of Suez down the
    # west side, Gulf of Aqaba down the east, Ras Muhammad apex at the south.
    return poly([
        (4, 5), (178, 3), (170, 42), (158, 80), (145, 116), (130, 152),
        (113, 189), (101, 189), (86, 158), (69, 125), (51, 92), (33, 60),
        (16, 30),
    ])


def land_jerusalem():
    # Levant: Mediterranean strip along the west, Dead Sea + Arava valley
    # cutting the east, Red Sea (Gulf of Aqaba) at the south-east corner.
    main = poly([
        (40, 0), (192, 0), (192, 142), (172, 156), (156, 168), (146, 192),
        (36, 192), (32, 140), (30, 90), (34, 45),
    ])
    water = U(
        band([(155, 54, 6.5), (153, 84, 7.0), (151, 116, 6.5)]),  # Dead Sea
        band([(151, 116, 4.0), (158, 144, 4.0), (166, 168, 5.0)]),  # Arava
        poly([(140, 192), (152, 170), (168, 158), (192, 144), (192, 192)]),  # Red Sea
    )
    return D(main, water)


def land_arabia():
    # Saudi heartland: Red Sea coast west, Gulf coast east, seas flaring at
    # the south-west (Bab approaches) and south-east (Gulf widening).
    return poly([
        (44, 0), (36, 55), (40, 110), (30, 158), (14, 224),
        (192, 224), (200, 180), (190, 120), (198, 60), (188, 0),
    ])


def land_gulf():
    # The whole Arabian Gulf: wide rounded head in the NW (the Shatt al-Arab
    # corner stays land so both shores connect at the west edge), tapering
    # SE to the Hormuz pinch in the NE corner, opening to the Gulf of Oman.
    # Coast radii keep the strait ~9-11 cells wide.
    gulf_water = U(
        disc(52, 116, 40),
        band([(52, 116, 35.0), (95, 122, 34.0), (135, 112, 28.0),
              (168, 95, 19.0), (192, 76, 10.0), (206, 63, 4.5)]),
        poly([(198, 44), (240, 0), (240, 112), (226, 104), (212, 86),
              (200, 72), (196, 58)]),  # Gulf of Oman basin (NE)
    )
    land = U(
        poly([  # Iran: north coast wrapping the gulf head
            (0, 0), (240, 0), (240, 40), (222, 44), (208, 42),
            (196, 54), (186, 66), (172, 78), (154, 90), (132, 96),
            (108, 100), (84, 96), (62, 88), (44, 76), (28, 62), (14, 48),
            (0, 40),
        ]),
        poly([  # Arabia: from the western land bridge around the head and
                # down the whole southern shore to Musandam
            (0, 240), (240, 240), (240, 108), (226, 102), (214, 88),
            (208, 80), (198, 74), (186, 80), (176, 92), (162, 104),
            (146, 116), (126, 126), (104, 132), (82, 130), (62, 122),
            (46, 110), (32, 96), (18, 80), (8, 66), (0, 58),
        ]),
        poly([(0, 30), (26, 30), (30, 72), (0, 72)]),  # Iraq land corridor
        poly([(166, 68), (186, 60), (190, 70), (172, 78)]),  # Qeshm
        disc(96, 122, 2.6),                                  # Bahrain
    )
    return D(land, gulf_water)


def land_redsea():
    # Red Sea corridor: Suez + Aqaba branches at the top flanking the Sinai
    # tip, the long sea between Africa and Arabia, pinched at Bab al-Mandab
    # in the south, opening into the Gulf of Aden along the bottom.
    water = U(
        band([(104, 24, 5.0), (80, 12, 5.5), (54, 3, 6.0)]),    # Gulf of Suez
        band([(118, 24, 3.0), (142, 10, 3.0), (164, 1, 3.0)]),  # Gulf of Aqaba
        band([(108, 30, 23.0), (118, 80, 24.0), (108, 140, 23.0),
              (104, 186, 4.5)]),                                # Red Sea
        poly([(40, 224), (224, 224), (224, 194), (142, 194),
              (120, 190), (108, 192)]),                         # Gulf of Aden
    )
    frame = poly([(0, 0), (224, 0), (224, 224), (0, 224)])
    return D(frame, water)


def land_maghreb():
    # Iberia at the top, Morocco/Algeria/Sahara below, the Mediterranean
    # across the north with the Gulf of Sidra embayment, the Atlantic down
    # the west, and the Gibraltar strait pinched at the far west beside a
    # land causeway (Ceuta isthmus) that keeps Europe walkable to Africa.
    iberia = poly([
        (0, 0), (118, 0), (106, 30), (86, 50), (54, 58), (26, 60), (0, 58),
    ])
    causeway = poly([(30, 56), (42, 56), (42, 78), (30, 78)])  # Ceuta isthmus
    africa = poly([
        (30, 78), (62, 90), (120, 96), (156, 98), (162, 120), (174, 144),
        (202, 150), (216, 124), (210, 96), (240, 96),
        (240, 240), (12, 240), (22, 160), (16, 108),
    ])
    return U(iberia, causeway, africa)


def land_anatolia():
    # Anatolia: Black Sea across the north, Bosporus channel + Sea of
    # Marmara at the NW, Aegean down the west, Mediterranean along the
    # south.
    water = U(
        poly([(58, 0), (224, 0), (224, 42), (170, 38), (120, 42), (80, 38),
              (58, 28)]),                     # Black Sea
        poly([(28, 0), (34, 0), (34, 74), (28, 74)]),  # Bosporus channel
        disc(31, 84, 10),                              # Sea of Marmara
        poly([(0, 56), (26, 60), (34, 96), (48, 140), (58, 180), (64, 224),
              (0, 224)]),                   # Aegean
        poly([(64, 224), (112, 198), (152, 192), (224, 196), (224, 224)]),  # Med
    )
    frame = poly([(0, 0), (224, 0), (224, 224), (0, 224)])
    return D(frame, water)


def land_indus():
    # Pakistan + NW India: Arabian Sea along the south-west, the Saurashtra
    # peninsula splitting the Gulf of Kutch from the Gulf of Khambhat, the
    # Indus running south as a narrow channel crossed by two causeways.
    water = U(
        poly([(0, 224), (0, 196), (40, 188), (80, 196), (96, 204),
              (110, 216), (104, 224)]),      # Arabian Sea + Kutch
        poly([(104, 224), (110, 216), (124, 208), (160, 190), (224, 178),
              (224, 224)]),                  # Gulf of Khambhat
        band([(84, 36, 2.5), (88, 80, 2.5), (80, 124, 2.5), (86, 168, 2.5),
              (96, 196, 3.0)]),              # the Indus
    )
    frame = poly([(0, 0), (224, 0), (224, 224), (0, 224)])
    land = D(frame, water)
    cause1 = poly([(76, 93), (94, 93), (94, 99), (76, 99)])    # Sukkur ford
    cause2 = poly([(78, 138), (96, 138), (96, 144), (78, 144)])  # Hyderabad ford
    return U(land, cause1, cause2)


def land_gulfstates():
    # Iran's southern shore against Arabia's Gulf coast: the Gulf head closes
    # inside the NW frame (land bridge = Iraq), Qatar and Bahrain sit mid-
    # gulf, Qeshm guards the north shore, and the Hormuz pinch in the NE
    # opens to the Gulf of Oman.
    iran = poly([
        (0, 0), (224, 0), (224, 40), (204, 50), (188, 62), (170, 74),
        (158, 86), (146, 96), (134, 92), (116, 88), (96, 84), (74, 78),
        (52, 70), (32, 60), (16, 50), (0, 44),
    ])
    arabia = U(
        poly([
            (0, 224), (224, 224), (224, 150), (210, 144), (198, 132),
            (190, 124), (182, 118), (174, 120), (168, 130), (160, 142),
            (146, 154), (128, 162), (112, 166), (100, 164), (92, 152),
            (88, 138), (82, 132), (74, 136), (70, 150), (64, 156),
            (48, 146), (32, 136), (16, 126), (0, 118),
        ]),
        poly([(96, 164), (106, 162), (102, 134), (94, 130), (90, 142),
              (90, 154)]),                      # Qatar peninsula
        disc(76, 148, 2.6),                     # Bahrain
    )
    qeshm = poly([(148, 82), (168, 76), (172, 86), (154, 94)])
    iraq = poly([(0, 34), (34, 34), (40, 116), (24, 130), (0, 126)])  # W corridor
    gulf_water = U(
        disc(56, 74, 22),
        band([(56, 74, 20.0), (84, 94, 22.0), (116, 106, 20.0),
              (142, 112, 13.0), (160, 108, 6.0)]),
        poly([(164, 98), (224, 48), (224, 140), (206, 134), (192, 122),
              (182, 116), (172, 114)]),  # Gulf of Oman (NE)
    )
    return D(U(iran, arabia, qeshm, iraq), gulf_water)


# map spec table -------------------------------------------------------------
# zones are tried in order: one spawn each; wet zones require water within 70.

MAPS = [
    {
        "id": "sinai", "name": "Sinai Peninsula", "size": 192, "spawns": 4,
        "oil": 8, "land": land_sinai, "wet": True,
        "zones": [
            {"rect": (48, 22, 96, 52), "wet": False},     # northern plain
            {"rect": (84, 136, 120, 164), "wet": False},  # southern highlands
            {"rect": (128, 40, 152, 72), "wet": True},    # Aqaba coast
            {"rect": (34, 56, 60, 86), "wet": True},      # Suez coast
        ],
        "briefing": "Sinai: the triangular desert between the Gulf of Suez and "
                    "the Gulf of Aqaba, opening north to the Mediterranean.",
    },
    {
        "id": "jerusalem", "name": "Levant", "size": 192, "spawns": 4,
        "oil": 8, "land": land_jerusalem, "wet": True,
        "zones": [
            {"rect": (36, 20, 76, 56), "wet": True},      # coast north (Haifa)
            {"rect": (30, 120, 70, 156), "wet": True},    # coast south (Gaza)
            {"rect": (120, 30, 148, 70), "wet": False},   # east hills (Amman)
            {"rect": (112, 130, 142, 160), "wet": True},  # Dead Sea west shore
        ],
        "briefing": "Levant: the Mediterranean coastal plain from Haifa to "
                    "Gaza, cut by the Dead Sea and the Jordan valley.",
    },
    {
        "id": "arabia", "name": "Arabia", "size": 224, "spawns": 6,
        "oil": 12, "land": land_arabia, "wet": True,
        "zones": [
            {"rect": (44, 24, 84, 56), "wet": False},      # Tabuk
            {"rect": (148, 24, 188, 56), "wet": False},    # Ha'il / Hafar
            {"rect": (30, 96, 62, 128), "wet": True},      # Jeddah coast
            {"rect": (160, 96, 196, 128), "wet": True},    # Dammam coast
            {"rect": (36, 164, 76, 196), "wet": True},     # Asir / Bab flare
            {"rect": (140, 164, 180, 196), "wet": False},  # Empty Quarter
        ],
        "briefing": "Arabia: the Saudi heartland between the Red Sea Tihamah "
                    "and the Gulf shore of al-Hasa.",
    },
    {
        "id": "gulf", "name": "Arabian Gulf", "size": 240, "spawns": 6,
        "oil": 12, "land": land_gulf, "wet": True,
        "zones": [
            {"rect": (6, 91, 34, 119), "wet": True},       # western land bridge
            {"rect": (81, 16, 109, 44), "wet": False},     # north Iran
            {"rect": (156, 28, 184, 56), "wet": True},     # Bushehr coast
            {"rect": (106, 161, 134, 189), "wet": True},   # Arabia mid coast
            {"rect": (191, 106, 219, 134), "wet": True},   # near the strait
            {"rect": (31, 166, 59, 194), "wet": False},    # Arabia west
        ],
        "briefing": "Arabian Gulf: the whole gulf from the Shatt al-Arab head "
                    "to the Hormuz pinch in the north-east.",
    },
    {
        "id": "redsea", "name": "Red Sea", "size": 224, "spawns": 6,
        "oil": 12, "land": land_redsea, "wet": True,
        "zones": [
            {"rect": (30, 18, 70, 44), "wet": True},       # Egypt / Suez side
            {"rect": (156, 28, 184, 56), "wet": True},     # NW Arabia coast
            {"rect": (30, 101, 58, 129), "wet": True},     # Sudan coast
            {"rect": (156, 102, 184, 130), "wet": True},   # Hejaz coast
            {"rect": (30, 176, 58, 204), "wet": True},     # Eritrea / Bab
            {"rect": (156, 178, 184, 206), "wet": True},   # Yemen coast
        ],
        "briefing": "Red Sea: the long corridor between Africa and Arabia, "
                    "pinched at Bab al-Mandab in the south.",
    },
    {
        "id": "maghreb", "name": "Maghreb", "size": 240, "spawns": 6,
        "oil": 12, "land": land_maghreb, "wet": True,
        "zones": [
            {"rect": (10, 10, 38, 32), "wet": True},       # Iberia NW
            {"rect": (26, 116, 56, 144), "wet": True},     # Morocco Atlantic
            {"rect": (126, 98, 156, 126), "wet": True},   # Algeria coast
            {"rect": (126, 183, 156, 211), "wet": False},  # Sahara
            {"rect": (82, 10, 112, 36), "wet": True},     # Iberia NE / Med
            {"rect": (191, 94, 221, 122), "wet": True},   # Tunisia coast
        ],
        "briefing": "Maghreb: North Africa and Iberia across the "
                    "Mediterranean, joined at the Gibraltar strait in the west.",
    },
    {
        "id": "anatolia", "name": "Anatolia", "size": 224, "spawns": 6,
        "oil": 12, "land": land_anatolia, "wet": True,
        "zones": [
            {"rect": (38, 68, 66, 96), "wet": True},       # Istanbul / Marmara
            {"rect": (162, 58, 196, 86), "wet": True},     # Black Sea coast
            {"rect": (98, 86, 126, 114), "wet": False},    # central plateau
            {"rect": (46, 178, 80, 206), "wet": True},     # south coast W
            {"rect": (162, 168, 196, 196), "wet": True},   # south coast E
            {"rect": (102, 150, 130, 178), "wet": False},  # Taurus foothills
        ],
        "briefing": "Anatolia: Turkey between the Black Sea, the Aegean and "
                    "the Mediterranean, split by the Bosporus.",
    },
    {
        "id": "indus", "name": "Indus Valley", "size": 240, "spawns": 6,
        "oil": 12, "land": land_indus, "wet": True,
        "zones": [
            {"rect": (81, 26, 109, 54), "wet": False},     # Punjab north
            {"rect": (41, 96, 69, 124), "wet": True},      # Indus mid valley
            {"rect": (31, 158, 59, 186), "wet": True},     # Sindh delta coast
            {"rect": (171, 86, 199, 114), "wet": False},   # Rajasthan
            {"rect": (136, 151, 164, 179), "wet": True},   # Gujarat / Khambhat
            {"rect": (184, 6, 216, 26), "wet": False},     # north India
        ],
        "briefing": "Indus: Pakistan and north-west India, from the Arabian "
                    "Sea up the Indus valley to the Gulf of Khambhat.",
    },
    {
        "id": "gulfstates", "name": "Gulf States", "size": 224, "spawns": 6,
        "oil": 12, "land": land_gulfstates, "wet": True,
        "zones": [
            {"rect": (56, 8, 84, 36), "wet": False},       # Khuzestan / head
            {"rect": (116, 44, 150, 68), "wet": True},     # Bushehr coast
            {"rect": (10, 96, 38, 124), "wet": True},      # western land bridge
            {"rect": (94, 136, 122, 164), "wet": True},    # Qatar coast
            {"rect": (150, 144, 178, 172), "wet": True},   # UAE coast
            {"rect": (200, 196, 220, 216), "wet": True},   # Oman coast SE
        ],
        "briefing": "Gulf States: Iran's southern coast against Arabia's Gulf "
                    "shore, strangled at Hormuz in the north-east.",
    },
]


def build(spec):
    mid = spec["id"]
    w = h = spec["size"]
    g = rasterize(w, h, spec["land"]())
    g = smooth_majority(g, w, h)
    enforce_single_landmass(g, w, h, mid)
    wdist = water_cheb_dist(g, w, h)
    spawns = pick_spawns(g, w, h, spec["zones"], spec["spawns"],
                         sep=int(0.25 * w), wdist=wdist)
    scatter_rocks(g, w, h, SEEDS[mid], spawns)
    oil = place_oil(g, w, h, spawns, spec["oil"], wdist)
    m = {"name": spec["name"], "w": w, "h": h, "terrain": g,
         "oil": oil, "spawns": spawns, "briefing": spec["briefing"]}
    wd, water, frac = validate(mid, m, spec["wet"], spec["spawns"])
    max_wd = max(wd[s["y"] * w + s["x"]] for s in spawns)
    return m, water, frac, max_wd


def ascii_map(m):
    w, h, g = m["w"], m["h"], m["terrain"]
    lines = []
    marks = {}
    for s in m["spawns"]:
        marks[(s["x"], s["y"])] = "S"
    for o in m["oil"]:
        marks[(o["x"], o["y"])] = "o"
    for y in range(0, h, 2):
        row = []
        for x in range(w):
            ch = marks.get((x, y))
            if ch is None:
                ch = marks.get((x, y + 1))
            if ch is None:
                v = g[y * w + x]
                ch = "." if v == T_OPEN else ("#" if v == T_ROCK else "~")
            row.append(ch)
        lines.append("".join(row))
    return "\n".join(lines)


def main():
    args = [a for a in sys.argv[1:]]
    show_ascii = "--ascii" in args
    only = next((a for a in args if a != "--ascii"), None)
    OUT.mkdir(exist_ok=True)
    order = []
    stats = {}
    for spec in MAPS:
        mid = spec["id"]
        if only and mid != only:
            continue
        m, water, frac, max_wd = build(spec)
        p = OUT / f"{mid}.json"
        p.write_text(json.dumps(m, separators=(",", ":")), encoding="utf-8")
        order.append(mid)
        rock = sum(1 for v in m["terrain"] if v == T_ROCK)
        stats[mid] = (water, frac, max_wd)
        print(f"{mid}: {m['w']}x{m['h']} spawns={len(m['spawns'])} "
              f"oil={len(m['oil'])} rock={rock} water={water} "
              f"({100.0 * water / (m['w'] * m['h']):.1f}%) "
              f"land={100.0 * frac:.1f}% maxSpawnWater={max_wd} "
              f"({p.stat().st_size:,} bytes)")
        if show_ascii:
            print(ascii_map(m))
    if not only:
        manifest = {"maps": order}
        (OUT / "manifest.json").write_text(
            json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
        print(f"manifest.json: {order}")
    return stats


if __name__ == "__main__":
    main()
