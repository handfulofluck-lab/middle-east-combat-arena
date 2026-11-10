#!/usr/bin/env python3
"""Render the MCA voice clips (announcer lines + unit radio acknowledgements).

    lines.json --Kokoro TTS--> speech --trim / process / loudness--> mp3
                                                  client/public/voice/*.mp3 + manifest.json

Run it with the virtualenv described in README.md:

    tools/voicegen/.cache/venv/bin/python tools/voicegen/generate.py
    tools/voicegen/.cache/venv/bin/python tools/voicegen/verify.py

Raw TTS output is cached under .cache/raw (keyed by model, voice, speed and
text), so changing the processing or one line only re-renders what changed.
The output is deterministic: same lines + same model -> the same files.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE / ".cache"
OUT = ROOT / "client" / "public" / "voice"
LINES = HERE / "lines.json"

MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
MODEL_FILES = {
    "kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}
SR = 24000  # Kokoro's native rate; kept end to end


def db(x):
    return 20.0 * np.log10(max(float(x), 1e-12))


def lin(d):
    return 10.0 ** (d / 20.0)


# ---- model ------------------------------------------------------------------------

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_model():
    """Download the Kokoro model files into .cache/models (never committed)."""
    d = CACHE / "models"
    d.mkdir(parents=True, exist_ok=True)
    for name, want in MODEL_FILES.items():
        p = d / name
        if not p.exists():
            print("downloading", MODEL_URL + name)
            tmp = p.with_suffix(p.suffix + ".part")
            with urllib.request.urlopen(MODEL_URL + name) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            tmp.rename(p)
        got = sha256(p)
        if got != want:
            sys.exit("%s: sha256 %s does not match the pinned %s (delete it to re-download)" % (p, got, want))
    return d / "kokoro-v1.0.onnx", d / "voices-v1.0.bin"


_kokoro = None
_tokenizer = None


def phonemes(text, lang):
    """The phoneme string the model is given for `text` (cached on disk)."""
    global _tokenizer
    key = hashlib.sha256(json.dumps(["phonemes", text, lang]).encode()).hexdigest()[:24]
    f = CACHE / "raw" / (key + ".txt")
    if f.exists():
        return f.read_text(encoding="utf-8")
    if _tokenizer is None:
        from kokoro_onnx.tokenizer import Tokenizer
        _tokenizer = Tokenizer()
    ph = _tokenizer.phonemize(text, lang)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(ph, encoding="utf-8")
    return ph


# final sounds that are themselves noise (fricatives, plosive releases): a line
# ending in one of these keeps its tail; any other line must end with its voice
NOISY_FINALS = set("sz\u0283\u0292f\u03b8tkp\u02a7\u02a4xh")


def ending(text, lang):
    """How a line ends: 'noisy' (fricative / unvoiced stop: the tail is part of
    the word), 'stop' (b d g: a short release follows the voicing) or 'open'
    (vowel, nasal, liquid: nothing should follow the voicing)."""
    ph = [c for c in phonemes(text, lang) if c.isalpha()]
    if not ph or ph[-1] in NOISY_FINALS:
        return "noisy"
    return "stop" if ph[-1] in "bdg\u0261" else "open"


def synth(text, voice, speed, lang):
    """Raw mono float32 speech at SR, cached on disk."""
    global _kokoro
    key = hashlib.sha256(json.dumps(["kokoro-v1.0", text, voice, speed, lang]).encode()).hexdigest()[:24]
    raw = CACHE / "raw" / (key + ".npy")
    if raw.exists():
        return np.load(raw)
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        model, voices = ensure_model()
        _kokoro = Kokoro(str(model), str(voices))
    audio, sr = _kokoro.create(text, voice=voice, speed=speed, lang=lang)
    if sr != SR:
        sys.exit("unexpected sample rate %d from the model" % sr)
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    raw.parent.mkdir(parents=True, exist_ok=True)
    np.save(raw, audio)
    return audio


# ---- DSP building blocks -------------------------------------------------------------

def envelope(x, ms):
    """Short-time RMS envelope (same length as x)."""
    n = max(1, int(SR * ms / 1000))
    return np.sqrt(np.maximum(uniform_filter1d(x.astype(np.float64) ** 2, n, mode="constant"), 0.0))


def trim(x, floor_db=-42.0, head_ms=8, tail_ms=45):
    """Cut leading / trailing silence: keep what rises above floor_db relative
    to the loudest 10 ms, plus a little air either side."""
    env = envelope(x, 10)
    live = np.nonzero(env > env.max() * lin(floor_db))[0]
    if not len(live):
        return x
    a = max(0, live[0] - int(SR * head_ms / 1000))
    b = min(len(x), live[-1] + int(SR * tail_ms / 1000))
    return fade(x[a:b].copy(), 4, 18)


def drop_breath(x, end_kind):
    """End the clip with the voice. The model sometimes lets out a breathy hiss
    after the last word (heard as a stray "s": "unit downs"). For a line whose
    last sound is voiced, whatever follows once the low band has died away is
    that hiss, so fade it out just past the end of the voicing (a little
    later after b / d / g, which have a release)."""
    if end_kind == "noisy":
        return x
    hold_ms, fade_ms = (40, 40) if end_kind == "stop" else (12, 35)
    low = envelope(butter(x, "lowpass", 1000, 4), 12)
    live = np.nonzero(low > low.max() * lin(-26))[0]
    if not len(live):
        return x
    voiced = live[-1]
    y = x.astype(np.float64).copy()
    if end_kind == "open":
        # the hiss often starts while the last vowel is still dying away:
        # over the final 90 ms of voicing, cross over to a 2.2 kHz low-passed
        # copy (zero-phase, so the two stay aligned)
        dark = signal.sosfiltfilt(signal.butter(4, 2200, btype="lowpass", fs=SR, output="sos"), y)
        a = max(0, voiced - int(SR * 0.09))
        b = min(len(y), a + int(SR * 0.05))
        mix = np.zeros(len(y))
        mix[a:b] = np.sin(np.linspace(0, np.pi / 2, b - a)) ** 2
        mix[b:] = 1.0
        y = y * (1 - mix) + dark * mix
    end = voiced + int(SR * hold_ms / 1000)
    stop = end + int(SR * fade_ms / 1000)
    if stop >= len(y):
        return y
    y = y[:stop]
    y[end:] *= np.cos(np.linspace(0, np.pi / 2, stop - end)) ** 2
    return y


def fade(x, in_ms, out_ms):
    i, o = int(SR * in_ms / 1000), int(SR * out_ms / 1000)
    if i > 1:
        x[:i] *= np.sin(np.linspace(0, np.pi / 2, i)) ** 2
    if o > 1:
        x[-o:] *= np.cos(np.linspace(0, np.pi / 2, o)) ** 2
    return x


def butter(x, kind, hz, order):
    sos = signal.butter(order, hz, btype=kind, fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def peaking(x, hz, gain_db, q):
    """RBJ peaking EQ."""
    a = 10 ** (gain_db / 40)
    w = 2 * np.pi * hz / SR
    alpha = np.sin(w) / (2 * q)
    b = [1 + alpha * a, -2 * np.cos(w), 1 - alpha * a]
    den = [1 + alpha / a, -2 * np.cos(w), 1 - alpha / a]
    return signal.lfilter(np.array(b) / den[0], np.array(den) / den[0], x)


def speech_rms(x):
    """RMS of the active part (frames within 30 dB of the loudest)."""
    env = envelope(x, 20)
    live = env > env.max() * lin(-30)
    return float(np.sqrt(np.mean(x[live].astype(np.float64) ** 2))) if live.any() else 0.0


def set_speech_rms(x, target_db):
    r = speech_rms(x)
    return x * (lin(target_db) / r) if r > 0 else x


def compress(x, threshold_db, ratio, attack_ms, release_ms, knee_db=6.0):
    """Feed-forward compressor on a peak envelope; no make-up gain."""
    a_att = np.exp(-1.0 / (SR * attack_ms / 1000))
    a_rel = np.exp(-1.0 / (SR * release_ms / 1000))
    level = np.abs(x)
    env = np.empty(len(x))
    e = 0.0
    for i, v in enumerate(level):
        c = a_att if v > e else a_rel
        e = c * e + (1 - c) * v
        env[i] = e
    lvl = 20 * np.log10(np.maximum(env, 1e-9))
    over = lvl - threshold_db
    half = knee_db / 2
    red = np.where(over <= -half, 0.0,
                   np.where(over >= half, over * (1 - 1 / ratio),
                            (over + half) ** 2 / (2 * knee_db) * (1 - 1 / ratio)))
    return x * 10 ** (-red / 20)


def limit(x, ceiling_db, look_ms=3.0):
    """Look-ahead peak limiter: the gain is the smoothed running minimum of the
    gain each sample needs, so no sample ends above the ceiling."""
    ceil = lin(ceiling_db)
    n = max(3, int(SR * look_ms / 1000) | 1)
    need = np.minimum(1.0, ceil / np.maximum(np.abs(x), 1e-9))
    g = uniform_filter1d(minimum_filter1d(need, n, mode="nearest"), n, mode="nearest")
    return x * np.minimum(g, need)


def true_peak_db(x):
    """Inter-sample peak, 4x oversampled."""
    if not len(x):
        return -120.0
    up = signal.resample_poly(np.concatenate([np.zeros(64), x, np.zeros(64)]), 4, 1)
    return db(max(np.abs(up).max(), np.abs(x).max()))


_meter = None


def loudness(x):
    """Integrated loudness (ITU-R BS.1770-4, LUFS). Short clips are repeated up
    to a few seconds first: the standard's 400 ms gating blocks need material."""
    global _meter
    import pyloudnorm
    if _meter is None:
        _meter = pyloudnorm.Meter(SR)
    reps = int(np.ceil(4.0 * SR / max(len(x), 1)))
    return float(_meter.integrated_loudness(np.tile(x.astype(np.float64), max(1, reps))))


# ---- the two treatments ---------------------------------------------------------------

def announcer(raw, end_kind="noisy"):
    """Command voice: clean and close, deliberately light. Rumble filter,
    gentle 2:1 levelling, and a transparent look-ahead limiter that holds the
    few stray peaks to 12 dB over the speech level so the line can sit
    higher in a battle. Levelling lifts the sibilants a couple of dB against
    the vowels; a broad 2 dB dip at 8 kHz puts the model's balance back."""
    x = trim(drop_breath(raw, end_kind), tail_ms=70)
    x = butter(x, "highpass", 85, 2)
    x = set_speech_rms(x, -20)
    x = compress(x, threshold_db=-20, ratio=2, attack_ms=4, release_ms=120)
    x = peaking(x, 8000, -2.0, 0.7)
    x = set_speech_rms(x, -20)
    x = limit(x, -8.0)
    return fade(x, 3, 25)


def radio(raw, seed, end_kind="noisy"):
    """Field radio: telephone band, speaker honk, hard levelling, a little
    saturation, carrier hiss while keyed, key-up click and a squelch tail."""
    rng = np.random.default_rng(seed)
    x = trim(drop_breath(raw, end_kind), floor_db=-36, head_ms=4, tail_ms=20)
    x = butter(x, "highpass", 320, 4)
    x = butter(x, "lowpass", 3300, 6)
    x = peaking(x, 1900, 4.0, 1.1)
    x = set_speech_rms(x, -20)
    x = compress(x, threshold_db=-26, ratio=5, attack_ms=2, release_ms=70)
    x = set_speech_rms(x, -15)
    x = np.tanh(x * 2.2) / 2.2                  # mild odd-harmonic grit on the peaks
    x = fade(x, 3, 12)

    def hiss(n, lo, hi):
        w = rng.standard_normal(n + 512)
        w = butter(butter(w, "highpass", lo, 2), "lowpass", hi, 4)[512:]
        return w / (np.sqrt(np.mean(w ** 2)) + 1e-12)

    pre, tail = int(SR * 0.018), int(SR * 0.095)
    n = pre + len(x) + tail
    out = np.zeros(n)
    out[pre:pre + len(x)] = x
    # carrier hiss for as long as the set is keyed
    keyed = pre + len(x)
    bed = hiss(n, 400, 3200) * lin(-45)
    bed[keyed:] = 0
    bed[:keyed] = fade(bed[:keyed], 6, 4)
    out += bed
    # key-up click: a few ms of decaying noise
    k = int(SR * 0.007)
    out[:k] += hiss(k, 700, 3300) * lin(-21) * np.exp(-np.arange(k) / (SR * 0.0016))
    # squelch tail: the receiver opens onto noise for a moment after unkeying
    t = np.arange(tail)
    burst = hiss(tail, 600, 3300) * lin(-19)
    burst *= (1 - np.exp(-t / (SR * 0.002))) * np.exp(-t / (SR * 0.026))
    out[keyed:keyed + tail] += burst
    out = butter(out, "lowpass", 3500, 4)
    return fade(out, 1, 14)


# ---- encode / measure -------------------------------------------------------------------

def encode_mp3(x, path, kbps):
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
           "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
           "-c:a", "libmp3lame", "-b:a", "%dk" % kbps, "-ar", str(SR), "-ac", "1",
           "-map_metadata", "-1", "-id3v2_version", "0", "-write_id3v1", "0", "-write_xing", "1",
           "-fflags", "+bitexact", "-flags:a", "+bitexact", str(path)]
    subprocess.run(cmd, input=np.asarray(x, dtype="<f4").tobytes(), check=True)


def decode(path):
    """Decode a clip with ffmpeg -> (float32 mono samples, sample rate)."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=sample_rate,channels,codec_name", "-of", "json", str(path)],
        capture_output=True, check=True)
    info = json.loads(probe.stdout)["streams"][0]
    sr = int(info["sample_rate"])
    pcm = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "pipe:1"],
        capture_output=True, check=True).stdout
    return np.frombuffer(pcm, dtype="<f4"), sr, info


def finish(x, path, kbps, target_lufs, ceiling_db):
    """Loudness-normalise, limit, encode; then measure the *decoded* file and
    correct the gain once or twice, so the shipped clips sit on the target."""
    gain = lin(target_lufs - loudness(x))
    for _ in range(4):
        y = limit(x * gain, ceiling_db - 1.2)   # the codec overshoots a little
        encode_mp3(y, path, kbps)
        got, _, _ = decode(path)
        err = target_lufs - loudness(got)
        if abs(err) < 0.15:
            break
        gain *= lin(err)
    return got


# ---- main --------------------------------------------------------------------------------

def text_of(line):
    return (line["text"], line.get("say", line["text"])) if isinstance(line, dict) else (line, line)


def slug(key):
    return key.replace(".", "_").lower()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=OUT, help="output directory (default: client/public/voice)")
    ap.add_argument("--list", action="store_true", help="print the line table and exit")
    args = ap.parse_args()

    cfg = json.loads(LINES.read_text(encoding="utf-8"))
    fmt, loud = cfg["format"], cfg["loudness"]
    jobs = []  # (section, bank, key, index, text, say, voice dict, relative file)
    for bank, v in cfg["announcers"].items():
        for key, lines in cfg["announcer_lines"].items():
            for i, line in enumerate(lines, 1):
                text, say = text_of(line)
                jobs.append(("ann", bank, key, i, text, say, v, "ann_%s/%s_%d.mp3" % (bank, slug(key), i)))
    for group, v in cfg["units"].items():
        for event, lines in v["lines"].items():
            for i, line in enumerate(lines, 1):
                text, say = text_of(line)
                jobs.append(("ack", group, event, i, text, say, v, "ack_%s/%s_%d.mp3" % (group, event, i)))

    if args.list:
        for j in jobs:
            print("%-28s %-10s %s" % (j[7], j[6]["voice"], j[4]))
        print(len(jobs), "clips")
        return

    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg (with libmp3lame) is required")
    out = args.out
    if out.exists():
        shutil.rmtree(out)
    manifest = {
        "v": 1, "ext": fmt["codec"], "model": cfg["model"],
        "default": cfg["default_announcer"],
        "factions": {f: bank for bank, v in cfg["announcers"].items() for f in v.get("factions", [])},
        "voices": {"ann": {b: v["voice"] for b, v in cfg["announcers"].items()},
                   "ack": {g: v["voice"] for g, v in cfg["units"].items()}},
        "ann": {}, "ack": {},
    }
    total = 0
    for n, (section, bank, key, i, text, say, v, rel) in enumerate(jobs, 1):
        lang = v.get("lang", "en-us")
        raw = synth(say, v["voice"], v.get("speed", 1.0), lang)
        end_kind = ending(say, lang)
        if section == "ann":
            x, kbps = announcer(raw, end_kind), fmt["announcer_kbps"]
        else:
            seed = int(hashlib.sha256(rel.encode()).hexdigest()[:8], 16)
            x, kbps = radio(raw, seed, end_kind), fmt["ack_kbps"]
        path = out / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        got = finish(x, path, kbps, loud["target_lufs"], loud["peak_ceiling_dbfs"])
        size = path.stat().st_size
        total += size
        manifest[section].setdefault(bank, {}).setdefault(key, []).append(
            {"f": rel, "d": round(len(got) / SR, 3), "t": text})
        print("[%3d/%d] %-30s %5.2fs %6d B  %s" % (n, len(jobs), rel, len(got) / SR, size, text))
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("%d clips, %d bytes (%.2f MB) + manifest -> %s" % (len(jobs), total, total / 1e6, out))
    print("now run: verify.py")


if __name__ == "__main__":
    main()
