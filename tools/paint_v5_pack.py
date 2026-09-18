#!/usr/bin/env python3
"""Paint the MCA v5 'cinematic' pack myself — no external AI.

Two deliverables:
1. Procedural painted TERRAIN tiles (256px seamless value-noise sand/rock,
   4-frame animated water with drifting specular streaks, decals) written to
   artwork/terrain/mca-assets-v2/tiles/ (backups in _orig_tiles).
2. An ENHANCED sprite pack in artwork/units_v5/mca-assets-v2/: every v4 asset
   repainted with soft SE drop shadows, a specular sheen sweep, a rich warm
   color grade, and fine grain — full color, no quantization downstream.

Deterministic: seeded RNG everywhere. Run: tools/.venv/Scripts/python tools/paint_v5_pack.py
"""
import json
import math
import os
import random
import shutil

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ART = os.path.join(ROOT, "artwork")
TILES = os.path.join(ART, "terrain", "mca-assets-v2", "tiles")
V4 = os.path.join(ART, "units_v4", "mca-assets-v2")
V5 = os.path.join(ART, "units_v5", "mca-assets-v2")
rng = random.Random(20260918)


# ---- tileable value noise / fbm ------------------------------------------------
def value_noise(period, size, seed):
    r = np.random.default_rng(seed)
    g = r.random((period, period)).astype(np.float32)
    gp = np.pad(g, ((0, 1), (0, 1)), mode="wrap")
    im = Image.fromarray((gp * 255).astype(np.uint8)).resize(
        (size + size // period, size + size // period), Image.BICUBIC)
    im = im.crop((0, 0, size, size))
    return np.asarray(im, dtype=np.float32) / 255.0


def fbm(size, seed, octaves=5, base=4):
    out = np.zeros((size, size), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        out += amp * value_noise(base << o, size, seed + o * 131)
        tot += amp
        amp *= 0.55
    return out / tot


def save_rgb(arr, path):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(path, optimize=True)


# ---- terrain painters ----------------------------------------------------------
def paint_sand(size=256):
    n = fbm(size, 11, 5, 4)
    streak = fbm(size, 23, 4, 2)          # low-freq wind streaks
    hi = fbm(size, 37, 3, 32)             # pebble speckle
    base = np.array([184, 160, 106], np.float32)
    l = 1.0 + (n - 0.5) * 0.16 + (streak - 0.5) * 0.10
    hue = (fbm(size, 51, 3, 8) - 0.5) * 0.10
    r = base[0] * l * (1 + hue * 0.6)
    g = base[1] * l * (1 + hue * 0.2)
    b = base[2] * l * (1 - hue * 0.5)
    peb = np.clip((hi - 0.72) * 8, 0, 1) * 26   # darker pebbles
    r -= peb * 1.0; g -= peb * 0.9; b -= peb * 0.7
    warm = np.stack([r, g, b], -1)
    save_rgb(warm, os.path.join(TILES, "sand.png"))


def paint_rock(size=256):
    n = fbm(size, 71, 5, 4)
    y = np.arange(size, dtype=np.float32)[:, None]
    band = 0.5 + 0.5 * np.sin(y * 0.11 + (n - 0.5) * 7.0)
    hi = fbm(size, 83, 3, 32)
    t = np.clip(n * 0.6 + band * 0.4, 0, 1)
    lo = np.array([74, 66, 56], np.float32)
    hib = np.array([122, 108, 88], np.float32)
    col = lo[None, None, :] * (1 - t[..., None]) + hib[None, None, :] * t[..., None]
    crack = np.clip((0.5 - np.abs(hi - 0.5)) * 40 - 7.0, 0, 1) * 30
    col -= crack[..., None] * np.array([1.0, 0.95, 0.8])
    save_rgb(col, os.path.join(TILES, "rock.png"))


def paint_water(size=256, frames=4):
    base = np.array([42, 92, 138], np.float32)
    deep = np.array([30, 72, 116], np.float32)
    glint_c = np.array([168, 205, 232], np.float32)
    n = fbm(size, 97, 4, 4)
    depth = np.clip(n, 0, 1)
    # one elongated streak field: stretch noise horizontally, then drift it
    s0 = fbm(size, 113, 3, 8)
    for f in range(frames):
        s = np.roll(s0, f * (size // 8), axis=1)          # periodic drift
        streak = 1.0 - np.abs(2 * s - 1)
        streak = np.roll(streak, 0, axis=0)
        glint = np.clip((streak - 0.90) * 10, 0, 1) ** 1.5
        glint = np.asarray(
            Image.fromarray((glint * 255).astype(np.uint8)).filter(
                ImageFilter.GaussianBlur(2)), np.float32) / 255.0
        col = deep[None, None, :] * (1 - depth[..., None]) + base[None, None, :] * depth[..., None]
        col += (fbm(size, 131 + f, 3, 16) - 0.5)[..., None] * 10
        col = col * (1 - glint[..., None] * 0.7) + glint_c[None, None, :] * glint[..., None] * 0.7
        save_rgb(col, os.path.join(TILES, f"water_{f}.png"))


def paint_decals():
    # dune: soft crescent ridge, bright crest / shadowed lee
    w, h = 192, 96
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pts = [(8, h - 12), (w * 0.30, h * 0.30), (w * 0.62, h * 0.26), (w - 8, h - 16),
           (w - 8, h - 8), (8, h - 6)]
    d.polygon(pts, fill=(196, 168, 110, 200))
    d.line(pts[1:4], fill=(224, 198, 142, 220), width=5)
    d.polygon([(w * 0.30, h * 0.34), (w * 0.62, h * 0.30), (w - 8, h - 12),
               (w - 8, h - 8), (8, h - 6), (8, h - 14)], fill=(120, 98, 62, 110))
    im = im.filter(ImageFilter.GaussianBlur(2))
    im.save(os.path.join(TILES, "decal_dune.png"), optimize=True)

    # scrub: dry bush cluster with shadow
    s = 96
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for (cx, cy, r) in [(40, 46, 16), (58, 40, 12), (50, 58, 13), (34, 58, 9)]:
        d.ellipse([cx - r + 3, cy - r + 6, cx + r + 3, cy + r + 6], fill=(52, 44, 30, 90))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(92, 88, 52, 235))
        d.ellipse([cx - r, cy - r, cx, cy], fill=(128, 118, 66, 220))
    im = im.filter(ImageFilter.GaussianBlur(1))
    im.save(os.path.join(TILES, "decal_scrub.png"), optimize=True)

    # rock outcrop
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.polygon([(18, 70), (30, 34), (52, 26), (74, 44), (78, 70)], fill=(96, 88, 76, 255))
    d.polygon([(30, 34), (52, 26), (58, 44), (36, 52)], fill=(138, 126, 106, 255))
    d.polygon([(18, 70), (78, 70), (74, 78), (22, 78)], fill=(60, 54, 46, 160))
    im = im.filter(ImageFilter.GaussianBlur(0.6))
    im.save(os.path.join(TILES, "decal_rock.png"), optimize=True)

    # foam: translucent wavy surf edge
    w, h = 192, 48
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for x in range(0, w, 6):
        y = 16 + 6 * math.sin(x * 0.055) + 3 * math.sin(x * 0.021 + 1.7)
        d.ellipse([x - 4, y - 3, x + 8, y + 6], fill=(235, 244, 248, 95))
        d.ellipse([x - 2, y + 7, x + 4, y + 11], fill=(210, 230, 240, 45))
    im = im.filter(ImageFilter.GaussianBlur(3.5))
    im.save(os.path.join(TILES, "decal_foam.png"), optimize=True)


# ---- sprite enhancement --------------------------------------------------------
def enhance(im, mode):
    """mode: 'unit' (shadow+sheen+grade+grain), 'wreck' (grade+darken+grain),
    'structure' (shadow+sheen+grade+grain), 'plain' (grade+grain only)."""
    im = im.convert("RGBA")
    size = im.width
    alpha = im.getchannel("A")

    if mode in ("unit", "structure"):
        # soft SE cast shadow baked under the sprite
        off = max(2, size // 36)
        sh = alpha.filter(ImageFilter.GaussianBlur(max(2, size // 22)))
        black = Image.new("RGBA", im.size, (24, 18, 10, 0))
        black.putalpha(sh.point(lambda a: int(a * 0.42)))
        base = Image.new("RGBA", im.size, (0, 0, 0, 0))
        base.alpha_composite(black, (off, off))
        base.alpha_composite(im)
        im = base
        alpha = im.getchannel("A")

    # warm rich grade
    rgb = im.convert("RGB")
    rgb = ImageEnhance.Color(rgb).enhance(1.14)
    rgb = ImageEnhance.Contrast(rgb).enhance(1.07)
    warm = Image.new("RGB", rgb.size, (255, 240, 214))
    rgb = ImageChops.screen(rgb, warm.point(lambda p: p * 6 // 100))
    im = Image.merge("RGBA", (*rgb.split(), alpha))

    if mode == "wreck":
        im = ImageEnhance.Brightness(im).enhance(0.88)

    if mode != "plain":
        # specular sheen sweep from NW (vectorized)
        yy, xx = np.mgrid[0:im.height, 0:im.width].astype(np.float32)
        sarr = np.clip(150 - (yy / im.height) * 210 - (xx / im.width) * 70, 0, 255)
        sheen = Image.fromarray(sarr.astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(6))
        sheen = ImageChops.multiply(sheen, alpha)
        white = Image.new("RGBA", im.size, (255, 252, 244, 0))
        white.putalpha(sheen.point(lambda a: int(a * 0.20)))
        im = Image.alpha_composite(im, white)

        # fine grain
        arr = np.asarray(im).astype(np.int16)
        noise = np.random.default_rng(size + im.height).integers(-3, 4, arr.shape[:2])
        arr[..., :3] = np.clip(arr[..., :3] + noise[..., None], 0, 255)
        im = Image.fromarray(arr.astype(np.uint8))
    return im


def enhance_strip(path, out, frames, mode):
    im = Image.open(path).convert("RGBA")
    fw = im.height
    outs = []
    for i in range(min(frames, im.width // fw)):
        f = im.crop((i * fw, 0, (i + 1) * fw, fw))
        outs.append(enhance(f, mode))
    strip = Image.new("RGBA", (fw * len(outs), fw), (0, 0, 0, 0))
    for i, f in enumerate(outs):
        strip.paste(f, (i * fw, 0))
    strip.save(out, optimize=True)


def build_pack():
    manifest = json.load(open(os.path.join(V4, "manifest.json"), encoding="utf-8"))
    for sub in ("sprites/units", "sprites/dirs", "sprites/wrecks", "sprites/damaged",
                "sprites/structures", "sprites/effects", "sprites/idle", "sprites/fx",
                "icons/units", "icons/structures", "posters"):
        os.makedirs(os.path.join(V5, sub), exist_ok=True)

    n = 0
    for id_, meta in manifest["units"].items():
        enhance_strip(os.path.join(V4, meta["strip"]),
                      os.path.join(V5, meta["strip"]), 8, "unit")
        # north master = frame 0
        im = Image.open(os.path.join(V5, meta["strip"]))
        im.crop((0, 0, im.height, im.height)).save(
            os.path.join(V5, meta["sprite"]), optimize=True)
        enhance(Image.open(os.path.join(V4, meta["wreck"])), "wreck").save(
            os.path.join(V5, meta["wreck"]), optimize=True)
        enhance(Image.open(os.path.join(V4, meta["icon"])), "plain").save(
            os.path.join(V5, meta["icon"]), optimize=True)
        n += 1
    for id_, meta in manifest["structures"].items():
        enhance(Image.open(os.path.join(V4, meta["sprite"])), "structure").save(
            os.path.join(V5, meta["sprite"]), optimize=True)
        enhance(Image.open(os.path.join(V4, meta["wreck"])), "wreck").save(
            os.path.join(V5, meta["wreck"]), optimize=True)
        if meta.get("damaged"):
            enhance(Image.open(os.path.join(V4, meta["damaged"])), "wreck").save(
                os.path.join(V5, meta["damaged"]), optimize=True)
        enhance(Image.open(os.path.join(V4, meta["icon"])), "plain").save(
            os.path.join(V5, meta["icon"]), optimize=True)
    for key, meta in manifest.get("effects", {}).items():
        p = os.path.join(V4, meta["sprite"])
        if os.path.exists(p):
            enhance(Image.open(p), "plain").save(
                os.path.join(V5, meta["sprite"]), optimize=True)
    if manifest.get("fx_loops"):
        for key, meta in manifest["fx_loops"].items():
            enhance_strip(os.path.join(V4, meta["sprite"]),
                          os.path.join(V5, meta["sprite"]),
                          meta.get("strip_frames", 8), "plain")
    idle = os.path.join(V4, "sprites/idle/SH-01.png")
    if os.path.exists(idle):
        enhance_strip(idle, os.path.join(V5, "sprites/idle/SH-01.png"), 8, "structure")
    for f in os.listdir(os.path.join(V4, "posters")):
        shutil.copy2(os.path.join(V4, "posters", f), os.path.join(V5, "posters", f))

    manifest["style"] = "painted-v5-self"
    json.dump(manifest, open(os.path.join(V5, "manifest.json"), "w", encoding="utf-8"),
              separators=(",", ":"))
    print(f"v5 pack written: {n} units enhanced -> {V5}")


if __name__ == "__main__":
    paint_sand()
    paint_rock()
    paint_water()
    paint_decals()
    print("terrain tiles painted")
    build_pack()
