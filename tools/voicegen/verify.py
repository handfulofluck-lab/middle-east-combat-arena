#!/usr/bin/env python3
"""Measure every shipped voice clip and fail loudly if one is out of spec.

Nobody can listen in CI, so each clip in client/public/voice/manifest.json is
decoded with ffmpeg and checked against the limits in lines.json:

  * it decodes, mono, at the expected sample rate and codec
  * duration inside the bounds for its kind (acknowledgements are short)
  * no clipping: true peak (4x oversampled) under the ceiling
  * integrated loudness (BS.1770) within the tolerance of the target
  * leading / trailing silence trimmed
  * the manifest matches lines.json and the directory (no strays, no gaps)
  * everything together stays under the size budget

Usage:  tools/voicegen/.cache/venv/bin/python tools/voicegen/verify.py [--quiet]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

import generate as G

QUIET_DB = -45.0     # below this (absolute, dBFS) counts as silence
MAX_LEAD = 0.060     # seconds of silence tolerated before the first sound
MAX_TAIL = 0.160     # ... and after the last (speech decays, mp3 pads a frame)


def edges(x, sr):
    live = np.nonzero(np.abs(x) > G.lin(QUIET_DB))[0]
    if not len(live):
        return len(x) / sr, len(x) / sr
    return live[0] / sr, (len(x) - 1 - live[-1]) / sr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, default=G.OUT)
    ap.add_argument("--quiet", action="store_true", help="only print the summary and the failures")
    args = ap.parse_args()

    cfg = json.loads(G.LINES.read_text(encoding="utf-8"))
    loud, limits, fmt = cfg["loudness"], cfg["limits"], cfg["format"]
    manifest = json.loads((args.dir / "manifest.json").read_text(encoding="utf-8"))
    problems = []

    # the manifest must describe exactly what lines.json asks for
    want = {}
    for bank in cfg["announcers"]:
        for key, lines in cfg["announcer_lines"].items():
            want[("ann", bank, key)] = [G.text_of(line)[0] for line in lines]
    for group, v in cfg["units"].items():
        for event, lines in v["lines"].items():
            want[("ack", group, event)] = [G.text_of(line)[0] for line in lines]
    have = {}
    for section in ("ann", "ack"):
        for bank, slots in manifest[section].items():
            for key, clips in slots.items():
                have[(section, bank, key)] = [c["t"] for c in clips]
    if want != have:
        problems.append("manifest.json does not match lines.json - regenerate")
    for f in cfg["announcers"].values():
        for faction in f.get("factions", []):
            if faction not in manifest["factions"]:
                problems.append("faction %s missing from the manifest" % faction)

    rows = []
    listed = set()
    total = 0
    for section in ("ann", "ack"):
        lo, hi = limits["announcer_seconds" if section == "ann" else "ack_seconds"]
        for bank, slots in manifest[section].items():
            for key, clips in slots.items():
                for c in clips:
                    path = args.dir / c["f"]
                    listed.add(path.resolve())
                    row = {"file": c["f"], "text": c["t"], "bad": []}
                    rows.append(row)
                    try:
                        x, sr, info = G.decode(path)
                    except Exception as e:  # noqa: BLE001 - any decode failure is the finding
                        row["bad"].append("does not decode: %s" % e)
                        continue
                    size = path.stat().st_size
                    total += size
                    dur = len(x) / sr
                    lead, tail = edges(x, sr)
                    row.update(dur=dur, bytes=size, peak=G.db(np.abs(x).max()), tp=G.true_peak_db(x),
                               lufs=G.loudness(x) if sr == G.SR else float("nan"), lead=lead, tail=tail)
                    if info["codec_name"] != fmt["codec"] or sr != fmt["sample_rate"] or int(info["channels"]) != 1:
                        row["bad"].append("format %s %d Hz %s ch" % (info["codec_name"], sr, info["channels"]))
                    if not lo <= dur <= hi:
                        row["bad"].append("duration %.2fs outside %.1f-%.1fs" % (dur, lo, hi))
                    if abs(dur - c["d"]) > 0.03:
                        row["bad"].append("manifest duration %.3f != %.3f" % (c["d"], dur))
                    if row["tp"] > loud["peak_ceiling_dbfs"]:
                        row["bad"].append("true peak %.2f dBTP over %.1f" % (row["tp"], loud["peak_ceiling_dbfs"]))
                    if abs(row["lufs"] - loud["target_lufs"]) > loud["tolerance_lu"]:
                        row["bad"].append("loudness %.2f LUFS off target %.1f" % (row["lufs"], loud["target_lufs"]))
                    if lead > MAX_LEAD:
                        row["bad"].append("%.0f ms of leading silence" % (lead * 1000))
                    if tail > MAX_TAIL:
                        row["bad"].append("%.0f ms of trailing silence" % (tail * 1000))
    for p in args.dir.rglob("*"):
        if p.is_file() and p.name != "manifest.json" and p.resolve() not in listed:
            problems.append("stray file %s" % p.relative_to(args.dir))
    if total > limits["total_bytes"]:
        problems.append("clips total %d bytes, budget %d" % (total, limits["total_bytes"]))

    if not args.quiet:
        print("%-30s %5s %6s %6s %6s %7s %5s %5s  %s" % ("clip", "sec", "bytes", "peak", "dBTP", "LUFS", "lead", "tail", "text"))
        for r in rows:
            if "dur" not in r:
                print("%-30s  FAILED" % r["file"])
                continue
            print("%-30s %5.2f %6d %6.2f %6.2f %7.2f %5.0f %5.0f  %s%s" % (
                r["file"], r["dur"], r["bytes"], r["peak"], r["tp"], r["lufs"], r["lead"] * 1000, r["tail"] * 1000,
                r["text"], "   <-- " + "; ".join(r["bad"]) if r["bad"] else ""))
    ok = [r for r in rows if "dur" in r]
    for name, pick in (("announcer", "ann_"), ("acknowledgement", "ack_"), ("all", "")):
        sel = [r for r in ok if r["file"].startswith(pick)]
        if not sel:
            continue
        col = lambda k: np.array([r[k] for r in sel])  # noqa: E731
        print("%-15s %3d clips %8d B | sec %.2f-%.2f (mean %.2f) | LUFS %.2f..%.2f | max dBTP %.2f | lead <= %.0f ms, tail <= %.0f ms" % (
            name, len(sel), col("bytes").sum(), col("dur").min(), col("dur").max(), col("dur").mean(),
            col("lufs").min(), col("lufs").max(), col("tp").max(), col("lead").max() * 1000, col("tail").max() * 1000))
    bad = [r for r in rows if r["bad"]]
    for r in bad:
        print("FAIL %s: %s" % (r["file"], "; ".join(r["bad"])))
    for p in problems:
        print("FAIL", p)
    if bad or problems:
        sys.exit(1)
    print("OK: %d clips, %d bytes (budget %d)" % (len(rows), total, limits["total_bytes"]))


if __name__ == "__main__":
    main()
