#!/usr/bin/env bash
# Local neural TTS (Kokoro-82M v1.0, ONNX, CPU only). Output: 48 kHz mono 16-bit WAV.
#
#   say.sh <voice> <speed> <out.wav> <text...>
#   say.sh <voice> <speed> <out.wav> --file script.txt     (--file - reads stdin)
#   say.sh --list-voices
#   say.sh --phonemes <voice> <text...>                    (debug: print phonemes, no audio)
#
# voice: af_heart, am_michael, bf_emma, bm_george, ...  (a*=American, b*=British, f/m)
# speed: 0.5 .. 2.0 (1.0 = natural)
# See tts.py for pauses, the [word](/phonemes/) override and lexicon.txt.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -lt 1 ]; then
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
exec "$DIR/venv/bin/python" -I "$DIR/tts.py" "$@"
