# voicegen — the game's voice clips

Everything the game says is rendered here, offline, and shipped as small mp3
files in `client/public/voice/` (Vite copies that folder into the build
unchanged). At runtime `client/src/audio/voice.js` reads `manifest.json`,
fetches clips on demand and plays them on the engine's voice bus. Nothing in
this folder runs in the browser or on the server.

| File | What it is |
| --- | --- |
| `lines.json` | The line table: announcer voices and which factions hear them, every announcer line, every unit acknowledgement, loudness target, limits. **Edit lines here.** |
| `generate.py` | Text → speech → trim → processing → loudness → mp3 + `manifest.json`. |
| `verify.py` | Decodes every shipped clip and checks duration, peak, loudness, trimming, manifest consistency and the size budget. Exits non-zero on any failure. |
| `.cache/` | Virtualenv, downloaded model, cached raw speech. Git-ignored. |

## Regenerating

```bash
python3 -m venv tools/voicegen/.cache/venv
tools/voicegen/.cache/venv/bin/pip install -r tools/voicegen/requirements.txt
tools/voicegen/.cache/venv/bin/python tools/voicegen/generate.py   # downloads the model on first run (~350 MB)
tools/voicegen/.cache/venv/bin/python tools/voicegen/verify.py
npm run build
```

Requirements: Python 3.10+, `ffmpeg` with `libmp3lame` on the PATH. A full
render takes a few minutes on a laptop CPU; raw speech is cached per line, so
after editing one line (or the processing) only the changed work is redone.
`generate.py --list` prints the clip list without rendering. The output is
deterministic: unchanged lines produce byte-identical files.

Commit the regenerated `client/public/voice/` together with `lines.json`.
`verify.py` fails if the two disagree.

## What the pipeline does

* **Announcer** ("command" voice), deliberately light: silence trimmed, 85 Hz
  rumble filter, gentle 2:1 levelling, a broad 2 dB dip at 8 kHz to undo the
  brightening that levelling causes, and a look-ahead limiter holding stray
  peaks to 12 dB over the speech level. 48 kbps mono mp3.
* **Unit acknowledgements** (field radio): 320–3300 Hz band-pass, a speaker
  resonance near 1.9 kHz, 5:1 compression, mild saturation, carrier hiss while
  keyed, a key-up click and a short squelch tail. 32 kbps mono mp3. Each unit
  group (infantry, vehicle, air, naval, support) has its own voice.
* Every clip is normalised to the same integrated loudness (BS.1770, target in
  `lines.json`), peak-limited, encoded, then **measured again after decoding**
  and corrected, so the files on disk sit on the target.

A line can be a plain string, or `{ "text": "...", "say": "..." }` when the
TTS needs a respelling to pronounce it properly (`text` is what the manifest
and the speech fallback use, `say` is what is fed to the model).

## Model and licence

* Model: **Kokoro-82M v1.0** (`kokoro-v1.0.onnx` + `voices-v1.0.bin`), a
  neural text-to-speech model released under the **Apache License 2.0** by
  hexgrad — <https://huggingface.co/hexgrad/Kokoro-82M>.
* Runtime: the [`kokoro-onnx`](https://github.com/thewh1teagle/kokoro-onnx)
  Python package (MIT), which phonemises with eSpeak NG (`espeakng-loader`).
* The model files are downloaded by `generate.py` from the kokoro-onnx
  release page
  (<https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0>)
  into `.cache/models/` and checked against pinned SHA-256 sums.

**The model is not redistributed with the game** and is not part of this
repository: only the audio it produced is shipped. The lines themselves are
original to this project.

The voices used (see `lines.json`) are stock Kokoro voice packs; all of them
speak English. Kokoro has no Arabic, Hebrew, Farsi, Turkish or Urdu voices,
which is why the announcer is English for every faction.
