#!/usr/bin/env python3
"""Compress MCA artwork (artwork/*.png) into client/assets/art.json as
base64 data-URIs for the single-file build, and refresh dist/README.html
illustrations.

Usage: system python tools/build_art.py   (needs Pillow; venv has it)
Writes: client/assets/art.json, dist/README.html (image block between markers)
"""
import base64
import io
import json
import os
import re

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ART = os.path.join(ROOT, "artwork")
OUT = os.path.join(ROOT, "client", "assets", "art.json")
README = os.path.join(ROOT, "dist", "README.html")

# source file -> (art.json key, max width, jpeg quality)
FACTIONS = {
    "Egypt": "02-faction-egypt.png",
    "Saudi": "03-faction-saudi.png",
    "UAE": "04-faction-uae.png",
    "Algeria": "05-faction-algeria.png",
    "Turkey": "06-faction-turkey.png",
    "Israel": "07-faction-israel.png",
    "India": "08-faction-india.png",
    "Pakistan": "09-faction-pakistan.png",
    "Iran": "10-faction-iran.png",
}


def data_uri(path, max_w, quality):
    im = Image.open(path).convert("RGB")
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# ---- unit/structure/FX sprite pack (newest pack wins) ------------------------
PACK_V5 = os.path.join(ART, "units_v5", "mca-assets-v2")  # Kimi painted pass (hi-res)
PACK_V4 = os.path.join(ART, "units_v4", "mca-assets-v2")  # Grok pass-3: dirs+wrecks+cameos
PACK_V3 = os.path.join(ART, "units_v3", "mca-assets-v2")
PACK_V2 = os.path.join(ART, "units_v2", "mca-assets-v2")
PACK_V1 = os.path.join(ART, "units", "mca-assets")
for _cand in (PACK_V5, PACK_V4, PACK_V3, PACK_V2, PACK_V1):
    if os.path.exists(os.path.join(_cand, "manifest.json")):
        PACK = _cand
        break
UNITART_OUT = os.path.join(ROOT, "client", "assets", "unitart.json")
# sprites are authored at 2x world size; inline scale per group
PACK_SCALE = {"units": 0.75, "structures": 0.5, "effects": 0.5}
# Per-pack pipeline options: the painted Kimi pack keeps full color (quantizing
# gradients causes banding) and inlines slightly larger; older flat packs keep
# the 256-color optimization that their flat palettes were designed around.
DEFAULT_OPTS = {"quant": True, "dir": 0.5, "struct": 0.5, "icon": 0.75, "fx": 0.5}
PACK_OPTS = {
    # painted v5: full color; WebP q88 inlining (auto below) keeps quality high
    # without a 20MB bundle
    "units_v5": {"quant": False, "dir": 0.5, "struct": 0.6, "icon": 0.85, "fx": 0.6},
}
PACK_OPTS_KEY = os.path.basename(os.path.dirname(PACK))
OPTS = PACK_OPTS.get(PACK_OPTS_KEY, DEFAULT_OPTS)


def png_data_uri(path, scale, quant=False):
    im = Image.open(path)
    if scale != 1.0:
        w = max(1, round(im.width * scale))
        im = im.resize((w, max(1, round(im.height * scale))), Image.LANCZOS)
    if quant:
        # flat RA-style art quantizes to 256 colors with no visible loss and
        # saves ~75% of the bytes (6117 KB -> 1142 KB for the dir strips)
        im = im.quantize(colors=256, method=Image.FASTOCTREE)
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    # full-color (painted) art: lossy WebP with alpha — a fraction of PNG's
    # size with no visible difference at RTS zoom; canvas draws it natively
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=82, method=4)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def build_unitart():
    manifest = json.load(open(os.path.join(PACK, "manifest.json"), encoding="utf-8"))
    out = {"units": {}, "structures": {}, "effects": {}}
    has_dirs = bool(os.path.isdir(os.path.join(PACK, "sprites", "dirs"))
                    and next(iter(manifest["units"].values()), {}).get("strip"))
    if has_dirs:
        # pass-3 pack: 8-frame directional strips replace the north singles;
        # wrecks and painted cameos ride along. Singles stay OUT of the bundle.
        out["dirs"] = {}
        out["wrecks"] = {}
        out["icons"] = {}
        for id_, meta in manifest["units"].items():
            strip = os.path.join(PACK, meta["strip"])
            out["dirs"][id_] = {
                "strip": png_data_uri(strip, OPTS["dir"], quant=OPTS["quant"]),
                "fw": max(1, round(meta["canvas_px"] * OPTS["dir"])),
                "frames": meta.get("strip_frames", 8),
            }
            out["wrecks"][id_] = png_data_uri(
                os.path.join(PACK, meta["wreck"]), OPTS["struct"], quant=OPTS["quant"])
            out["icons"][id_] = png_data_uri(
                os.path.join(PACK, meta["icon"]), OPTS["icon"], quant=OPTS["quant"])
        for id_, meta in manifest["structures"].items():
            out["wrecks"][id_] = png_data_uri(
                os.path.join(PACK, meta["wreck"]), OPTS["struct"], quant=OPTS["quant"])
            out["icons"][id_] = png_data_uri(
                os.path.join(PACK, meta["icon"]), OPTS["icon"], quant=OPTS["quant"])
        # v4 delta: damaged (~50% HP) standing states for all 35 structures
        out["damaged"] = {}
        for id_, meta in manifest["structures"].items():
            if meta.get("damaged"):
                out["damaged"][id_] = png_data_uri(
                    os.path.join(PACK, meta["damaged"]), OPTS["struct"], quant=OPTS["quant"])
        # v5 delta: ConYard idle strip + ambient fx loops (rotor/radar/steam/…)
        idle_path = os.path.join(PACK, "sprites", "idle", "SH-01.png")
        if os.path.exists(idle_path):
            im = Image.open(idle_path)
            frames = im.width // im.height
            out["idle"] = {"SH-01": {
                "strip": png_data_uri(idle_path, OPTS["struct"], quant=OPTS["quant"]),
                "fw": max(1, round(im.height * OPTS["struct"])),
                "frames": frames, "fps": 8,
            }}
        if manifest.get("fx_loops"):
            out["loops"] = {}
            for key, meta in manifest["fx_loops"].items():
                out["loops"][key] = {
                    "strip": png_data_uri(os.path.join(PACK, meta["sprite"]), OPTS["fx"], quant=OPTS["quant"]),
                    "fw": max(1, round(meta["frame_w"] * OPTS["fx"])),
                    "frames": meta.get("strip_frames", 8),
                    "fps": meta.get("fps", 8),
                }
    else:
        for id_, meta in manifest["units"].items():
            out["units"][id_] = png_data_uri(
                os.path.join(PACK, meta["sprite"]), PACK_SCALE["units"])
    for id_, meta in manifest["structures"].items():
        out["structures"][id_] = png_data_uri(
            os.path.join(PACK, meta["sprite"]), PACK_SCALE["structures"])
    for key, meta in manifest["effects"].items():
        out["effects"][key] = png_data_uri(
            os.path.join(PACK, meta["sprite"]), OPTS["fx"])
        # v4 delta metadata (strip frame counts, projectile draw radius)
        if meta.get("strip_frames") or meta.get("radius"):
            out.setdefault("fxMeta", {})[key] = {
                k: meta[k] for k in ("strip_frames", "frame_w", "radius", "canvas_px")
                if k in meta
            }
    # v6 terrain pack: sand/rock/water tiles + decals (lives outside PACK)
    tiles_dir = os.path.join(ART, "terrain", "mca-assets-v2", "tiles")
    if os.path.isdir(tiles_dir):
        out["tiles"] = {
            os.path.splitext(f)[0]: png_data_uri(os.path.join(tiles_dir, f), 1.0, quant=True)
            for f in sorted(os.listdir(tiles_dir)) if f.endswith(".png")
        }
    with open(UNITART_OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    kb = os.path.getsize(UNITART_OUT) // 1024
    print(f"wrote {UNITART_OUT} ({kb} KB): "
          + "/".join(f"{len(out[g])} {g}" for g in out if out[g]))


def main():
    if os.path.exists(os.path.join(PACK, "manifest.json")):
        build_unitart()

    art = {
        "keyart": data_uri(os.path.join(ART, "01-keyart-mca.png"), 1600, 76),
        "setup": data_uri(os.path.join(ART, "12-choose-your-army.png"), 1280, 74),
        "factions": {name: data_uri(os.path.join(ART, f), 320, 72)
                     for name, f in FACTIONS.items()},
    }
    # v5: 9 briefing posters from the sprite pack (landscape 720x400 plates)
    posters_dir = os.path.join(PACK, "posters")
    if os.path.isdir(posters_dir):
        art["briefings"] = {
            name: data_uri(os.path.join(posters_dir, name + ".png"), 720, 78)
            for name in FACTIONS
            if os.path.exists(os.path.join(posters_dir, name + ".png"))
        }
    # v6: map thumbnails for the setup screen (from the terrain pack)
    thumbs_dir = os.path.join(ART, "terrain", "mca-assets-v2", "thumbs")
    if os.path.isdir(thumbs_dir):
        art["thumbs"] = {
            os.path.splitext(f)[0]: data_uri(os.path.join(thumbs_dir, f), 220, 74)
            for f in sorted(os.listdir(thumbs_dir)) if f.endswith(".png")
        }
    # v5 painted pass: menu ambient video loop (Kimi video-generation plugin
    # deliverable) — inlined as a data-URI <video> for the main menu backdrop
    for _mv in (os.path.join(PACK, "menu_ambient.mp4"),
                os.path.join(PACK, "menu_ambient.webm")):
        if os.path.exists(_mv):
            import mimetypes
            _mime = mimetypes.guess_type(_mv)[0] or "video/mp4"
            with open(_mv, "rb") as _fh:
                art["menuVideo"] = ("data:" + _mime + ";base64,"
                                    + base64.b64encode(_fh.read()).decode("ascii"))
            print(f"inlined menu video {_mv} "
                  f"({os.path.getsize(_mv) // 1024} KB)")
            break
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(art, fh, separators=(",", ":"))
    kb = os.path.getsize(OUT) // 1024
    print(f"wrote {OUT} ({kb} KB): keyart + setup + {len(art['factions'])} faction posters")

    # README illustrations (self-contained: data URIs between idempotent markers)
    if os.path.exists(README):
        hero = data_uri(os.path.join(ART, "01-keyart-mca.png"), 1200, 74)
        arsenal = data_uri(os.path.join(ART, "11-weapons-arsenal.png"), 1200, 74)
        block = (
            "<!-- ART-BEGIN -->\n"
            f'<img alt="MCA key art" src="{hero}" '
            'style="width:100%;border-radius:8px;margin:0 0 18px">\n'
            "<!-- ART-MID -->\n"
            f'<img alt="MCA weapons arsenal" src="{arsenal}" '
            'style="width:100%;border-radius:8px;margin:18px 0">\n'
            "<!-- ART-END -->"
        )
        html = open(README, encoding="utf-8").read()
        if "<!-- ART-BEGIN -->" in html:
            html = re.sub(r"<!-- ART-BEGIN -->[\s\S]*<!-- ART-END -->", block, html)
        else:
            # first insertion: hero right after <body...>, arsenal block before </body>
            html = re.sub(r"(<body[^>]*>)", r"\1\n" + block, html, count=1)
        open(README, "w", encoding="utf-8").write(html)
        print(f"updated {README} ({os.path.getsize(README) // 1024} KB)")


if __name__ == "__main__":
    main()
