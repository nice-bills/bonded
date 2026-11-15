#!/usr/bin/env python3
"""Local neural TTS: Kokoro-82M v1.0 (ONNX, CPU) with misaki G2P.

Usage (normally through say.sh):
    tts.py <voice> <speed> <out.wav> <text...>
    tts.py <voice> <speed> <out.wav> --file script.txt
    tts.py --list-voices
    tts.py --phonemes <voice> <text...>      # print phonemes only, no audio

Output: 48 kHz mono 16-bit PCM WAV (Kokoro's native 24 kHz, resampled by ffmpeg).

Text conventions
  * A blank line (paragraph break) inserts a long pause   (TTS_PARA_PAUSE, default 0.70 s).
  * A single newline inserts a medium pause               (TTS_LINE_PAUSE, default 0.45 s).
  * Inline pronunciation override (misaki markup): [Kwame](/kwˈɑmA/)
  * lexicon.txt next to this file: "Word = replacement" applied to whole words before
    G2P (replacement may be a respelling or the [word](/phonemes/) markup).

Environment
  TTS_G2P=misaki|espeak   phonemizer (default misaki; espeak = raw espeak-ng phonemes)
  TTS_LEXICON=path        alternative lexicon file ("" disables)
  TTS_PAD=seconds         silence added at head and tail (default 0.15)
  TTS_VERBOSE=1           print phonemes and timing to stderr
"""
import os
import re
import subprocess
import sys
import tempfile
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

HERE = Path(__file__).resolve().parent
MODEL = HERE / "models" / "kokoro-v1.0.onnx"
VOICES = HERE / "models" / "voices-v1.0.bin"
OUT_RATE = 48000


def die(msg, code=2):
    print(f"tts: {msg}", file=sys.stderr)
    sys.exit(code)


def english_voices(all_voices):
    return sorted(v for v in all_voices if v[:1] in "ab" and v[1:2] in "fm")


def load_lexicon():
    path = os.environ.get("TTS_LEXICON")
    if path is None:
        path = HERE / "lexicon.txt"
    if not path or not Path(path).exists():
        return []
    rules = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        word, repl = (s.strip() for s in line.split("=", 1))
        if word and repl:
            # whole word, case-sensitive, and not already inside [..](/../) markup
            rules.append((re.compile(rf"(?<![\w\[]){re.escape(word)}(?![\w\]])"), repl))
    return rules


MARKUP = re.compile(r"\[([^\]]+)\]\(/[^/)]*/\)")


class G2P:
    def __init__(self, kokoro, mode):
        self.kokoro = kokoro
        self.mode = mode
        self._misaki = {}

    def __call__(self, text, british):
        if self.mode == "espeak":
            text = MARKUP.sub(r"\1", text)  # markup is misaki-only
            return self.kokoro.tokenizer.phonemize(text, "en-gb" if british else "en-us")
        if british not in self._misaki:
            from misaki import en, espeak

            self._misaki[british] = en.G2P(
                trf=False, british=british, fallback=espeak.EspeakFallback(british=british)
            )
        phonemes, _ = self._misaki[british](text)
        return phonemes


def split_script(text):
    """-> list of (chunk_text, pause_after_seconds). Blank line = paragraph, newline = line."""
    para_pause = float(os.environ.get("TTS_PARA_PAUSE", "0.70"))
    line_pause = float(os.environ.get("TTS_LINE_PAUSE", "0.45"))
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out = []
    for para in re.split(r"\n\s*\n", text):
        lines = [ln.strip() for ln in para.split("\n") if ln.strip()]
        for i, ln in enumerate(lines):
            out.append([ln, line_pause if i < len(lines) - 1 else para_pause])
    if out:
        out[-1][1] = 0.0
    return out


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    import numpy as np
    from kokoro_onnx import Kokoro

    if not MODEL.exists() or not VOICES.exists():
        die(f"model files missing in {MODEL.parent}")

    t0 = time.time()
    kokoro = Kokoro(str(MODEL), str(VOICES))
    voices = english_voices(kokoro.voices.keys())

    if argv[0] == "--list-voices":
        print("\n".join(voices))
        return 0

    phonemes_only = argv[0] == "--phonemes"
    if phonemes_only:
        if len(argv) < 3:
            die("usage: --phonemes <voice> <text...>")
        voice, speed, out_path, rest = argv[1], 1.0, None, argv[2:]
    else:
        if len(argv) < 4:
            die("usage: say.sh <voice> <speed> <out.wav> <text...> | --file path")
        voice, out_path, rest = argv[0], argv[2], argv[3:]
        try:
            speed = float(argv[1])
        except ValueError:
            die(f"speed must be a number, got {argv[1]!r}")
        if not 0.5 <= speed <= 2.0:
            die("speed must be between 0.5 and 2.0")

    if voice not in voices:
        die(f"unknown voice {voice!r}; available: {' '.join(voices)}")

    if rest[0] == "--file":
        if len(rest) != 2:
            die("--file takes exactly one path")
        text = sys.stdin.read() if rest[1] == "-" else Path(rest[1]).read_text(encoding="utf-8")
    else:
        text = " ".join(rest)
    # typographic quotes/apostrophes confuse the lexicon lookup ("won’t")
    text = text.translate({0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"'})
    for pattern, repl in load_lexicon():
        text = pattern.sub(lambda m, r=repl: r, text)
    chunks = split_script(text)
    if not chunks:
        die("no text to speak")

    british = voice.startswith("b")
    mode = os.environ.get("TTS_G2P", "misaki").lower()
    if mode not in ("misaki", "espeak"):
        die("TTS_G2P must be misaki or espeak")
    g2p = G2P(kokoro, mode)
    verbose = os.environ.get("TTS_VERBOSE") == "1"

    if phonemes_only:
        for chunk, _ in chunks:
            print(g2p(chunk, british))
        return 0

    t1 = time.time()
    sr = 24000
    pad = np.zeros(int(float(os.environ.get("TTS_PAD", "0.15")) * sr), dtype=np.float32)
    parts = [pad]
    for chunk, pause in chunks:
        phonemes = g2p(chunk, british)
        if verbose:
            print(f"[{len(phonemes)} phonemes] {phonemes}", file=sys.stderr)
        if not phonemes.strip():
            continue
        # kokoro-onnx splits >510-phoneme chunks at sentence/clause boundaries itself
        audio, sr = kokoro.create(phonemes, voice=voice, speed=speed, is_phonemes=True)
        parts.append(np.asarray(audio, dtype=np.float32))
        if pause:
            parts.append(np.zeros(int(pause * sr), dtype=np.float32))
    parts.append(pad)
    audio = np.concatenate(parts)
    if audio.size <= 2 * pad.size:
        die("synthesis produced no audio")

    peak = float(np.abs(audio).max())
    if peak > 0.97:  # never clip: scale down to -0.3 dBFS
        audio = audio * (0.97 / peak)
    t2 = time.time()

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".f32", dir=str(out_path.parent)) as raw:
        raw.write(audio.astype("<f4").tobytes())
        raw.flush()
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", raw.name,
            "-af", f"aresample={OUT_RATE}:resampler=soxr:precision=28:dither_method=triangular",
            "-ar", str(OUT_RATE), "-ac", "1", "-c:a", "pcm_s16le", str(out_path),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:  # ffmpeg built without libsoxr
            cmd[cmd.index("-af") + 1] = f"aresample={OUT_RATE}:dither_method=triangular"
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode != 0:
                die(f"ffmpeg failed: {res.stderr.strip()}", 1)

    dur = len(audio) / sr
    words = len(re.findall(r"[A-Za-z0-9']+", MARKUP.sub(r"\1", text)))
    print(
        f"{out_path}  voice={voice} speed={speed} dur={dur:.2f}s words={words} "
        f"wpm={words / dur * 60:.0f} peak={min(peak, 0.97):.2f} "
        f"load={t1 - t0:.1f}s synth={t2 - t1:.1f}s rtf={(t2 - t1) / dur:.2f}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
