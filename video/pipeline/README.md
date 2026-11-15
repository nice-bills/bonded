# Demo video pipeline

How `video/bonded-demo-*.mp4` was made. Everything runs locally; nothing here is part of the app.

1. **Record** `node capture/capture.cjs real take1` drives the live console with Playwright (makes real
   testnet quotes, one premium, two claims; click budget in budget.json). `mock` rehearses with no API writes.
2. **Narrate** `tts/say.sh am_michael 1.0 out.wav "text"` (Kokoro-82M ONNX; models + venv not committed:
   `pip install kokoro-onnx soundfile` and fetch kokoro-v1.0.onnx + voices-v1.0.bin from Hugging Face).
   Pronunciation fixes live in tts/lexicon.txt. Lines: story/lines.json.
3. **Story** `python3 story/build.py` writes story.json + vo.json (scene bars sized from the VO clips;
   camera rects and callouts in source CSS px of the 1280x720 capture). Paths inside point at the old scratch dir: edit them.
4. **Render** `cd stage && npm i && node render.cjs story.json --format wide|tall`
   (`--timeline` validates, `--frame-at T out.png` previews one frame).
5. **Sound** `python3 audio/make_audio.py out/cues.json --out audio_out --vo vo.json`, then
   `audio/mux.sh out/wide.mp4 audio_out/mix_full.wav final.mp4`.
