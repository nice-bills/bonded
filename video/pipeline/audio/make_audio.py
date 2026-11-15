#!/usr/bin/env python3
"""make_audio.py - synthesise an original, beat-locked soundtrack for a product video.

    python3 make_audio.py cues.json --out <dir> [--vo vo.json] [--seed N]
                          [--stems] [--music-db X] [--sfx-db X] [--vo-db X]

Writes (48 kHz, stereo, 16-bit, all exactly duration + 2.0 s long):
    music.wav          music bed, peak -3 dBFS
    sfx.wav            UI sound effects placed at their cue times
    mix_music_sfx.wav  music + sfx, normalised to -16 LUFS (peak <= -3 dBFS)
    vo.wav, mix_full.wav   only with --vo: voice-over stem and the full ducked mix
    report.json        arrangement, gains, loudness, kick grid, final sfx list

Everything is generated from oscillators and seeded noise with numpy. No samples.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time
import wave

import numpy as np

SR = 48000
TAIL = 2.0
TWO_PI = 2.0 * np.pi
SFX_NAMES = ("tap", "tick", "check", "decline", "paid", "callout", "sign",
             "whoosh", "dark", "light")


class CueError(ValueError):
    pass


# --------------------------------------------------------------------------- utils

def db2lin(d):
    return 10.0 ** (d / 20.0)


def lin2db(x):
    return 20.0 * math.log10(max(float(x), 1e-12))


def midi_hz(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def next_pow2(n):
    return 1 << int(n - 1).bit_length()


def butter_h(freqs, fc, order, kind):
    """Exact frequency response of a bilinear-transform Butterworth filter (causal)."""
    w = np.tan(np.pi * np.minimum(freqs, SR * 0.49999) / SR) / math.tan(math.pi * fc / SR)
    if kind == "hp":
        s = 1.0 / (1j * np.maximum(w, 1e-12))
    else:
        s = 1j * w
    h = np.ones(len(freqs), dtype=complex)
    for k in range(order):
        p = np.exp(1j * np.pi * (2 * k + order + 1) / (2 * order))
        h = h / (s - p)
    return h


def filt(x, specs, zero_phase=False, pad_s=0.5):
    """Apply a cascade of Butterworth filters [(kind, fc, order), ...] via the FFT.
    The response is that of the real causal IIR filter (no pre-ringing) unless
    zero_phase is set (used for analysis only)."""
    x = np.asarray(x, dtype=np.float64)
    n = x.shape[-1]
    nf = next_pow2(n + int(pad_s * SR))
    fr = np.fft.rfftfreq(nf, 1.0 / SR)
    h = np.ones(len(fr), dtype=complex)
    for kind, fc, order in specs:
        h = h * butter_h(fr, fc, order, kind)
    if zero_phase:
        h = np.abs(h)
    return np.fft.irfft(np.fft.rfft(x, nf, axis=-1) * h, nf, axis=-1)[..., :n]


def analytic_env(x):
    n = len(x)
    nf = next_pow2(n)
    X = np.fft.fft(x, nf)
    h = np.zeros(nf)
    h[0] = 1.0
    h[1:nf // 2] = 2.0
    h[nf // 2] = 1.0
    return np.abs(np.fft.ifft(X * h))[:n]


def smooth(x, w):
    w = max(3, int(w) | 1)
    k = np.hanning(w + 2)[1:-1]
    return np.convolve(x, k / k.sum(), mode="same")


def att(n, a_s):
    """Raised-cosine attack of a_s seconds, then 1."""
    e = np.ones(n)
    a = min(n, max(2, int(a_s * SR)))
    e[:a] = 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    return e


def rel(n, start_s, r_s):
    """1 until start_s, then a raised-cosine fade to 0 over r_s; 0 afterwards."""
    e = np.ones(n)
    s = min(n, max(0, int(start_s * SR)))
    r = max(2, int(r_s * SR))
    m = min(r, n - s)
    e[s:s + m] = 0.5 + 0.5 * np.cos(np.pi * np.arange(m) / r)
    e[s + m:] = 0.0
    return e


def place(bus, start, sig, gain=1.0, pan=0.0):
    """Add a mono (n,) or stereo (2, n) signal into bus (2, N) at sample `start`."""
    N = bus.shape[1]
    n = sig.shape[-1]
    s0 = max(0, -start)
    e = min(n, N - start)
    if e <= s0:
        return
    if sig.ndim == 1:
        a = (min(1.0, max(-1.0, pan)) + 1.0) * np.pi / 4.0
        seg = sig[s0:e]
        bus[0, start + s0:start + e] += (gain * math.cos(a)) * seg
        bus[1, start + s0:start + e] += (gain * math.sin(a)) * seg
    else:
        bus[:, start + s0:start + e] += gain * sig[:, s0:e]


# ----------------------------------------------------------------------- loudness

def lufs(x):
    """Integrated loudness (ITU-R BS.1770-4, gated) of a (2, N) signal at 48 kHz."""
    n = x.shape[1]
    nf = next_pow2(n + SR)
    z = np.exp(-1j * TWO_PI * np.fft.rfftfreq(nf, 1.0 / SR) / SR)
    h1 = (1.53512485958697 - 2.69169618940638 * z + 1.19839281085285 * z * z) / \
         (1.0 - 1.69065929318241 * z + 0.73248077421585 * z * z)
    h2 = (1.0 - 2.0 * z + z * z) / (1.0 - 1.99004745483398 * z + 0.99007225036621 * z * z)
    y = np.fft.irfft(np.fft.rfft(x, nf, axis=1) * (h1 * h2), nf, axis=1)[:, :n]
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    if n < blk:
        return -70.0
    cs = np.concatenate([np.zeros((2, 1)), np.cumsum(y * y, axis=1)], axis=1)
    idx = np.arange(0, n - blk + 1, hop)
    zj = ((cs[:, idx + blk] - cs[:, idx]) / blk).sum(axis=0)
    lj = -0.691 + 10.0 * np.log10(np.maximum(zj, 1e-12))
    g = lj > -70.0
    if not g.any():
        return -70.0
    thr = -0.691 + 10.0 * math.log10(zj[g].mean()) - 10.0
    g2 = g & (lj > thr)
    return -0.691 + 10.0 * math.log10(zj[g2].mean())


def sliding_min(a, before, after):
    """out[n] = min(a[n-before .. n+after])."""
    w = before + after + 1
    p = np.concatenate([np.ones(before), a, np.ones(after)])
    span = 1
    while span < w:
        step = min(span, w - span)
        p[:-step] = np.minimum(p[:-step], p[step:].copy())
        span += step
    return p[:len(a)]


def limiter(x, ceiling, look_s=0.005, hold_s=0.05):
    """Transparent look-ahead peak limiter (stereo-linked). Returns (y, max_gr_db)."""
    pk = np.abs(x).max(axis=0)
    if pk.max() <= ceiling:
        return x, 0.0
    g = np.minimum(1.0, ceiling / np.maximum(pk, 1e-9))
    L = int(look_s * SR)
    gm = sliding_min(g, L + int(hold_s * SR), L)
    # triangular smoothing (two box-cars, total width 2L+1 <= min window) keeps gm <= g
    for _ in range(2):
        c = np.cumsum(np.concatenate([np.ones(L // 2 + 1), gm, np.ones(L // 2 + 1)]))
        w = 2 * (L // 2) + 1
        gm = (c[w:w + len(gm)] - c[:len(gm)]) / w
    y = x * gm
    return y, -lin2db(gm.min())


def finalize(x, target_lufs=-16.0, ceiling_db=-3.0, max_gr_db=2.0):
    """Loudness-normalise a mix to target_lufs with a sample-peak ceiling. The limiter
    is allowed at most max_gr_db of gain reduction; beyond that the mix simply stays
    a little quieter than the target (mux.sh's loudnorm does the rest)."""
    l0 = lufs(x)
    pk = float(np.abs(x).max())
    if pk <= 0 or l0 <= -69:
        return x, dict(lufs=-70.0, gain_db=0.0, limiter_gr_db=0.0, peak_db=-120.0)
    gain = target_lufs - l0
    gain = min(gain, ceiling_db - lin2db(pk) + max_gr_db)
    y = x * db2lin(gain)
    y, gr = limiter(y, db2lin(ceiling_db))
    return y, dict(lufs=round(lufs(y), 2), gain_db=round(gain, 2),
                   limiter_gr_db=round(gr, 2), peak_db=round(lin2db(np.abs(y).max()), 2))


# --------------------------------------------------------------------------- WAV

def write_wav(path, x, rng):
    """(2, N) float -> 16-bit stereo PCM with TPDF dither (digital silence stays silent)."""
    x = np.asarray(x, dtype=np.float64)
    d = (rng.random(x.shape) - rng.random(x.shape))
    d[x == 0.0] = 0.0
    q = np.clip(np.round(x * 32767.0 + d), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(np.ascontiguousarray(q.T).tobytes())


def read_wav(path):
    """Returns (channels, N) float64 and the sample rate (16-bit PCM only)."""
    with wave.open(path, "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise ValueError(f"{path}: only 16-bit PCM is supported by the built-in reader")
    a = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    return a.reshape(-1, ch).T, sr


def read_mono_48k(path):
    """Decode any audio file to 48 kHz mono float via ffmpeg (falls back to `wave`)."""
    if not os.path.isfile(path):
        raise CueError(f"VO file not found: {path}")
    try:
        p = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-f", "f32le",
                            "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True)
        return np.frombuffer(p.stdout, dtype="<f4").astype(np.float64)
    except (OSError, subprocess.CalledProcessError):
        a, sr = read_wav(path)
        if sr != SR:
            raise CueError(f"{path}: expected 48 kHz, got {sr} Hz (ffmpeg unavailable to resample)")
        return a.mean(axis=0)


# ------------------------------------------------------------------------ voices

def v_epiano(f, dur, vel=1.0, bright=1.0):
    """Soft 2-operator FM electric piano."""
    r = 0.30
    n = int((dur + r) * SR)
    t = np.arange(n) / SR
    ph = TWO_PI * f * t
    ks = min(1.0, (262.0 / f) ** 0.6)
    idx = bright * ks * (0.30 + 1.0 * vel) * np.exp(-t / 0.30) + 0.10
    y = np.sin(ph + idx * np.sin(ph))
    tau = min(2.2, 1.5 * (262.0 / f) ** 0.4)
    return y * att(n, 0.004) * np.exp(-t / tau) * rel(n, dur, r) * vel


def v_pad(f, n, rng, partials=5, tilt=1.7, cents=6.0):
    """Warm additive pad, two detuned voices left/right. Envelope applied by caller."""
    t = np.arange(n) / SR
    out = np.zeros((2, n))
    for ch, sgn in ((0, -1.0), (1, 1.0)):
        ff = f * 2.0 ** (sgn * cents / 1200.0)
        for k in range(1, partials + 1):
            if ff * k > 4000.0:
                break
            out[ch] += k ** (-tilt) * np.sin(TWO_PI * ff * k * t + rng.uniform(0, TWO_PI))
    mid = 0.5 * (out[0] + out[1])
    return 0.75 * out + 0.25 * mid


def v_bass(f, dur, r=0.07):
    n = int((dur + r) * SR)
    t = np.arange(n) / SR
    ph = TWO_PI * f * t
    y = np.sin(ph) + 0.30 * np.sin(2 * ph) * np.exp(-t / 0.5) + 0.12 * np.sin(3 * ph) * np.exp(-t / 0.25)
    return y * att(n, 0.006) * (0.72 + 0.28 * np.exp(-t / 0.25)) * rel(n, dur, r)


def v_sub(f, dur, r=0.5):
    n = int((dur + r) * SR)
    t = np.arange(n) / SR
    ph = TWO_PI * f * t
    return (np.sin(ph) + 0.15 * np.sin(2 * ph)) * att(n, 0.06) * rel(n, dur, r)


def v_kick():
    """Soft sine kick: 121 -> 46 Hz sweep, 3 ms raised-cosine attack, no click layer."""
    n = int(0.42 * SR)
    t = np.arange(n) / SR
    f = 46.0 + 75.0 * np.exp(-t / 0.030)
    ph = TWO_PI * (np.cumsum(f) - f[0]) / SR
    return np.sin(ph) * att(n, 0.003) * np.exp(-t / 0.12) * rel(n, 0.34, 0.08)


def v_mallet(f, dur, vel=1.0):
    r = 0.25
    n = int((dur + r) * SR)
    t = np.arange(n) / SR
    ph = TWO_PI * f * t
    y = np.sin(ph) + 0.22 * np.sin(2 * ph) * np.exp(-t / 0.25) + 0.06 * np.sin(3 * ph) * np.exp(-t / 0.10)
    return y * att(n, 0.006) * np.exp(-t / 0.9) * rel(n, dur, r) * vel


def v_pluck(f, vel=1.0, length=0.7):
    n = int(length * SR)
    t = np.arange(n) / SR
    ph = TWO_PI * f * t
    y = np.zeros(n)
    for k in range(1, 5):
        y += k ** -2.0 * np.sin(k * ph) * np.exp(-t * k / 0.22)
    return y * att(n, 0.004) * rel(n, length - 0.1, 0.1) * vel


def v_chime(f, length=1.6):
    n = int(length * SR)
    t = np.arange(n) / SR
    ph = TWO_PI * f * t
    y = np.sin(ph) * np.exp(-t / 0.5) + 0.3 * np.sin(2 * ph) * np.exp(-t / 0.3)
    return y * att(n, 0.008) * rel(n, length - 0.3, 0.3)


def band_noise(n, lo, hi, rng, order=2):
    x = filt(rng.standard_normal(n), [("hp", lo, order), ("lp", hi, order)])
    return x / (np.sqrt(np.mean(x * x)) + 1e-12)


def lev_noise(n, lo, hi, rng, order=2):
    """Band-limited noise whose short-term envelope has been levelled to ~1, so that the
    amplitude envelope applied afterwards is the envelope you actually get."""
    pad = 2048
    x = filt(rng.standard_normal(n + 2 * pad), [("hp", lo, order), ("lp", hi, order)])
    e = smooth(analytic_env(x), int(0.004 * SR))
    y = x / np.maximum(e, 0.05 * e.max())
    return y[pad:pad + n]


# ------------------------------------------------------------------------- harmony
# Key of F major. Voicings are MIDI note numbers.
CH = {
    "F":    dict(bass=41, lh=41, keys=[57, 60, 64, 67], pad=[53, 60, 64, 69], arp=[65, 69, 72, 79]),
    "Am":   dict(bass=45, lh=45, keys=[55, 60, 64, 69], pad=[57, 60, 64, 67], arp=[64, 69, 72, 76]),
    "Dm":   dict(bass=38, lh=50, keys=[53, 57, 60, 64], pad=[50, 57, 60, 65], arp=[62, 69, 72, 77]),
    "Bb":   dict(bass=34, lh=46, keys=[53, 57, 62, 65], pad=[58, 62, 65, 69], arp=[65, 70, 74, 77]),
    "Csus": dict(bass=36, lh=48, keys=[53, 58, 62, 65], pad=[48, 58, 62, 65], arp=[60, 65, 70, 74]),
    "Gm":   dict(bass=43, lh=43, keys=[53, 58, 62, 67], pad=[55, 58, 62, 65], arp=[62, 67, 70, 74]),
    "Fend": dict(bass=41, lh=41, keys=[53, 57, 60, 64, 67], pad=[53, 60, 64, 69], arp=[65, 69, 72, 79]),
}
CHORD_NAMES = {"F": "Fmaj9", "Am": "Am7", "Dm": "Dm9", "Bb": "Bbmaj7", "Csus": "C9sus",
               "Gm": "Gm7", "Fend": "Fmaj9 (ring)"}
LOOP_A = ["F", "Am", "Dm", "Bb"]
LOOP_B = ["F", "Dm", "Bb", "Csus"]
LOOP_DARK = ["Dm", "Bb", "Gm", "Am"]
DARK_SUB = {"Dm": 38, "Bb": 34, "Gm": 43, "Am": 33, "Csus": 36, "F": 41}

# Top line: F major pentatonic, (beat, midi, length in beats) per chord.
LEAD = {
    "A": {
        "F":    [(0, 72, 1.0), (1.5, 74, 0.5), (2, 72, 1.0), (3, 69, 1.0)],
        "Am":   [(0, 67, 1.5), (1.5, 69, 0.5), (2, 72, 2.0)],
        "Dm":   [(0, 74, 1.0), (1.5, 72, 0.5), (2, 69, 1.0), (3, 72, 1.0)],
        "Bb":   [(0, 74, 1.5), (1.5, 72, 0.5), (2, 69, 2.0)],
        "Csus": [(0, 72, 1.5), (1.5, 74, 0.5), (2, 67, 2.0)],
    },
    "B": {
        "F":    [(0, 69, 0.5), (0.5, 72, 0.5), (1, 74, 1.5), (2.5, 72, 1.5)],
        "Am":   [(0, 76, 1.5), (1.5, 74, 0.5), (2, 72, 1.0), (3, 69, 1.0)],
        "Dm":   [(0, 77, 1.5), (1.5, 76, 0.5), (2, 74, 1.0), (3, 72, 1.0)],
        "Bb":   [(0, 74, 1.0), (1.5, 77, 0.5), (2, 74, 1.0), (3, 72, 1.0)],
        "Csus": [(0, 72, 1.0), (1, 74, 1.0), (2, 79, 2.0)],
    },
}
KEYS_PAT = {
    "P1": [(0, "full", 0.90, 1.4), (1.5, "top3", 0.60, 1.0), (3, "top3", 0.50, 0.9)],
    "P2": [(0, "full", 0.90, 1.4), (1.5, "top3", 0.60, 0.9), (2.5, "top3", 0.50, 0.45),
           (3.5, "top2", 0.42, 0.45)],
}

# Per-instrument mix gains (linear) and reverb sends. Tuned by measurement, see verify.py.
GAIN = dict(keys=0.115, dkeys=0.17, pad=0.050, dpad=0.085, bass=0.30, sub=0.30, kick=0.62,
            hat=0.040, ohat=0.035, shaker=0.018, rim=0.040, arp=0.085, lead=0.13,
            chime=0.035, swell=0.16)
SEND = dict(keys=0.22, dkeys=0.55, pad=0.20, dpad=0.35, lead=0.40, arp=0.30, chime=0.8,
            rim=0.25, hat=0.05, ohat=0.10, swell=0.5)
REVERB_WET = 0.55
SIDECHAIN_DB = 2.5


# ---------------------------------------------------------------------- cue sheet

def load_cues(path):
    with open(path) as fh:
        c = json.load(fh)
    for k in ("bpm", "duration", "scenes"):
        if k not in c:
            raise CueError(f"cue sheet is missing '{k}'")
    bpm, dur = float(c["bpm"]), float(c["duration"])
    if not (40 <= bpm <= 240):
        raise CueError(f"bpm {bpm} out of range 40..240")
    bar = 240.0 / bpm
    scenes = [dict(s) for s in c["scenes"]]
    if len(scenes) < 2:
        raise CueError("need at least 2 scenes")
    for i, s in enumerate(scenes):
        if s.get("theme", "light") not in ("light", "dark"):
            raise CueError(f"scene {s.get('id', i)}: theme must be 'light' or 'dark'")
        sb = round(s["start"] / bar)
        if abs(s["start"] - sb * bar) > 1e-3:
            raise CueError(f"scene {s.get('id', i)} starts at {s['start']} s, which is not on a "
                           f"bar line (bar = {bar:g} s at {bpm:g} BPM)")
        s["start_bar"] = sb
        s.setdefault("id", f"scene{i}")
        s.setdefault("theme", "light")
    if scenes[0]["start_bar"] != 0:
        raise CueError("first scene must start at 0.0")
    for i, s in enumerate(scenes):
        if i + 1 < len(scenes):
            s["n_bars"] = scenes[i + 1]["start_bar"] - s["start_bar"]
            if s["n_bars"] < 1:
                raise CueError(f"scene {s['id']}: scenes must be in order and at least one bar long")
        else:
            if dur <= s["start"] + 1e-6:
                raise CueError("duration must be greater than the last scene's start")
            s["n_bars"] = max(1, math.ceil((dur - s["start"]) / bar - 1e-6))
    sfx = []
    for e in c.get("sfx", []):
        if e.get("name") not in SFX_NAMES:
            raise CueError(f"unknown sfx name {e.get('name')!r} at t={e.get('t')}; "
                           f"valid names: {', '.join(SFX_NAMES)}")
        sfx.append(dict(t=float(e["t"]), name=e["name"]))
    darks = [i for i, s in enumerate(scenes) if s["theme"] == "dark"]
    names = {e["name"] for e in sfx}
    for d in darks:
        if "dark" not in names:
            sfx.append(dict(t=float(scenes[d]["start"]), name="dark", auto=True))
        if "light" not in names and d + 1 < len(scenes):
            sfx.append(dict(t=float(scenes[d + 1]["start"]), name="light", auto=True))
    sfx.sort(key=lambda e: e["t"])
    return dict(bpm=bpm, duration=dur, bar=bar, beat=60.0 / bpm, scenes=scenes, sfx=sfx)


def plan(cues):
    """Decide the arrangement of every scene. Works for any number of scenes."""
    sc = cues["scenes"]
    S = len(sc)
    last = S - 1
    dark = next((i for i, s in enumerate(sc) if s["theme"] == "dark" and i not in (0, last)), None)
    build_end = dark if dark is not None else last          # build scenes are 1 .. build_end-1
    k = build_end - 1
    FULL = 5
    light_i = 0
    for i, s in enumerate(sc):
        a = dict(kick=False, bass=False, hat=False, lead=None, arp=False, shaker=False, rim=False,
                 ohat=False, lead8=False, arp_hi=False, keys="P1", chime=i > 0)
        n = s["n_bars"]
        if i == dark:
            a.update(kind="dark", keys="dark", chime=False)
            chords = [LOOP_DARK[b % 4] for b in range(n)]
            if n >= 2:
                chords[-1] = "Csus"
            desc = "DARK: low pad (LP 600 Hz) + sine sub + sparse e-piano (LP 800 Hz); no drums; reverse swell through final bar"
        else:
            loop = LOOP_A if light_i % 2 == 0 else LOOP_B
            light_i += 1
            chords = [loop[b % 4] for b in range(n)]
            if i == 0 and i != last:
                a.update(kind="hook", keys="hook")
                desc = "pad + e-piano only, soft downbeat at t=0"
            else:
                if i == last:
                    kind, level, v = "end", FULL, 0
                elif dark is not None and i > dark:
                    kind, level, v = "return", FULL, i - dark - 1
                else:
                    kind = "build"
                    j = i
                    if k >= FULL:
                        level, v = min(j, FULL), max(0, j - FULL)
                    else:
                        level, v = max(1, round(j * FULL / k)), 0
                a["kind"] = kind
                a["kick"] = a["bass"] = level >= 1
                a["hat"] = level >= 2
                a["lead"] = ("B" if v % 2 else "A") if level >= 3 else None
                a["arp"] = level >= 4
                a["shaker"] = a["rim"] = level >= 5
                a["keys"] = "P2" if v % 2 else "P1"
                a["arp_hi"] = (v // 2) % 2 == 1
                parts = ["pad", "e-piano", "kick", "bass"]
                parts += ["off-beat hat"] if a["hat"] else []
                parts += [f"top line ({a['lead']})"] if a["lead"] else []
                parts += ["8th pluck arp" + (" 8va" if a["arp_hi"] else "")] if a["arp"] else []
                parts += ["shaker + rim"] if a["shaker"] else []
                if kind == "return" or (kind == "end" and dark is not None):
                    a["lead8"] = True
                    a["ohat"] = kind == "return"
                    parts += ["LIFT: top-line octave" + (" + open hat" if a["ohat"] else "")]
                if kind == "end":
                    a["arp"] = a["shaker"] = False
                    parts = [p for p in parts if not p.startswith(("8th", "shaker"))] + ["rim"]
                    if n == 1:
                        chords = ["Fend"]
                    elif n == 2:
                        chords = ["Bb", "Fend"]
                    else:
                        chords = [LOOP_A[b % 4] for b in range(n - 2)]
                        chords += ["Csus" if chords[-1] == "Bb" else "Bb", "Fend"]
                    parts += ["final bar: drums out, tonic chord rings through the tail"]
                if a["keys"] == "P2":
                    parts[1] = "e-piano (busier comp)"
                desc = " + ".join(parts)
        a["chords"] = chords
        a["desc"] = desc
        s["arr"] = a
    return dark


# -------------------------------------------------------------------------- music

def render_music(cues, seed):
    rng = np.random.default_rng([seed, 1])
    beat = cues["beat"]
    N = int(round((cues["duration"] + TAIL) * SR))
    end_s = N / SR

    def pos(b):                       # beat number -> sample index (exact at 120 BPM)
        return int(round(b * beat * SR))

    names = ["keys", "dkeys", "pad", "dpad", "bass", "sub", "kick", "hat", "ohat", "shaker",
             "rim", "arp", "lead", "chime", "swell"]
    bus = {k: np.zeros((2, N), dtype=np.float32) for k in names}
    kick = v_kick()
    hat_n = band_noise(4 * SR, 6000, 11000, rng, 4)
    shk_n = band_noise(4 * SR, 3500, 8000, rng, 2)
    rim_n = band_noise(4 * SR, 900, 2800, rng, 2)
    kick_pos = []

    def noise_hit(src, length, a_s, tau):
        n = int(length * SR)
        o = int(rng.integers(0, len(src) - n))
        t = np.arange(n) / SR
        return src[o:o + n] * att(n, a_s) * np.exp(-t / tau) * rel(n, length * 0.6, length * 0.4)

    def keys_hit(target, b, ch, sel, vel, dur_s, bright=1.0):
        notes = list(ch["keys"])
        if sel == "top3":
            notes = notes[-3:]
        elif sel == "top2":
            notes = notes[-2:]
        elif sel == "full+lh":
            notes = [ch["lh"]] + notes
        for i, m in enumerate(notes):
            p = -0.35 + 0.7 * i / max(1, len(notes) - 1)
            v = vel * (1.0 + 0.05 * rng.uniform(-1, 1))
            place(bus[target], pos(b), v_epiano(midi_hz(m), dur_s, v, bright), 1.0, p)

    for si, s in enumerate(cues["scenes"]):
        a = s["arr"]
        is_last = si == len(cues["scenes"]) - 1
        for bi, cname in enumerate(a["chords"]):
            ch = CH[cname]
            b0 = (s["start_bar"] + bi) * 4
            final_bar = is_last and bi == s["n_bars"] - 1
            t0 = b0 * beat
            bar_s = 4 * beat

            # ---- dark scene -------------------------------------------------
            if a["kind"] == "dark":
                n = int((bar_s + 1.2) * SR)
                env = att(n, 0.45) * rel(n, bar_s, 1.2)
                for m in ch["pad"][:3]:
                    place(bus["dpad"], pos(b0), v_pad(midi_hz(m), n, rng, partials=3) * env)
                place(bus["sub"], pos(b0), v_sub(midi_hz(DARK_SUB[cname]), bar_s - 0.1), 1.0, 0.0)
                keys_hit("dkeys", b0, ch, "full+lh", 0.7, 3.6 * beat, 0.8)
                if bi % 2 == 1 and bi != s["n_bars"] - 1:
                    keys_hit("dkeys", b0 + 2.5, ch, "top2", 0.4, 1.3 * beat, 0.8)
                if bi == s["n_bars"] - 1:
                    # reverse swell: a reversed e-piano chord + levelled noise, peaking on the cut
                    n = int(bar_s * SR)
                    sw = np.zeros((2, n))
                    for i, m in enumerate([ch["lh"]] + ch["keys"]):
                        y = v_epiano(midi_hz(m), bar_s - 0.3, 0.9, 1.2)[:n][::-1]
                        place(sw, 0, np.ascontiguousarray(y), 1.0, -0.4 + 0.2 * i)
                    t = np.arange(n) / SR
                    rise = np.exp((t - bar_s) / (0.28 * bar_s))
                    nz = np.stack([lev_noise(n, 400, 2500, rng), lev_noise(n, 400, 2500, rng)])
                    sw = sw * 0.5 + nz * rise * 0.10
                    sw *= att(n, 0.05) * rel(n, bar_s - 0.02, 0.02)
                    place(bus["swell"], pos(b0), sw)
                continue

            # ---- pad --------------------------------------------------------
            r = 2.5 if final_bar else 1.0
            hold = (end_s - t0 - r) if final_bar else bar_s
            n = int((hold + r) * SR)
            env = att(n, 0.45 if (bi == 0 and si == 0) else 0.35) * rel(n, hold, r)
            for m in ch["pad"]:
                place(bus["pad"], pos(b0), v_pad(midi_hz(m), n, rng) * env)

            # ---- final bar: everything rings -------------------------------
            if final_bar:
                ring = end_s - t0
                keys_hit("keys", b0, ch, "full+lh", 0.9, ring)
                if a["bass"]:
                    place(bus["bass"], pos(b0), v_bass(midi_hz(ch["bass"]), 3.0 * beat, 1.2), 0.8, 0.0)
                if a["lead"]:
                    place(bus["lead"], pos(b0), v_mallet(midi_hz(69), ring, 0.9), 1.0, 0.0)
                    if a["lead8"]:
                        place(bus["lead"], pos(b0), v_mallet(midi_hz(81), ring, 0.9), 0.3, 0.1)
                place(bus["chime"], pos(b0), v_chime(midi_hz(84)), 1.0, -0.2)
                continue

            # ---- keys -------------------------------------------------------
            if a["keys"] == "hook":
                keys_hit("keys", b0, ch, "full+lh", 0.8, 3.9 * beat)
            else:
                for (b, sel, vel, d) in KEYS_PAT[a["keys"]]:
                    keys_hit("keys", b0 + b, ch, sel, vel, d * beat)
            if bi == 0 and a["chime"]:
                place(bus["chime"], pos(b0), v_chime(midi_hz(84)), 1.0, 0.2)

            # ---- drums + bass ----------------------------------------------
            if a["kick"]:
                for b in range(4):
                    place(bus["kick"], pos(b0 + b), kick, 1.0, 0.0)
                    kick_pos.append(pos(b0 + b))
            if a["bass"]:
                f = midi_hz(ch["bass"])
                for (b, d, vel, tr) in [(0, 1.3, 1.0, 0), (1.5, 0.9, 0.8, 0), (3, 0.45, 0.8, 0),
                                        (3.5, 0.4, 0.55, 12)]:
                    place(bus["bass"], pos(b0 + b), v_bass(f * 2 ** (tr / 12), d * beat), vel, 0.0)
            if a["hat"]:
                for b, vel in ((0.5, 0.8), (1.5, 0.6), (2.5, 0.8), (3.5, 0.65)):
                    if a["ohat"] and b == 3.5 and bi % 2 == 1:
                        place(bus["ohat"], pos(b0 + b), noise_hit(hat_n, 0.36, 0.004, 0.09), 1.0, 0.2)
                    else:
                        place(bus["hat"], pos(b0 + b), noise_hit(hat_n, 0.07, 0.003, 0.014),
                              vel * rng.uniform(0.92, 1.0), 0.2)
            if a["shaker"]:
                for q in range(16):
                    vel = (0.5, 0.3, 0.8, 0.3)[q % 4] * rng.uniform(0.85, 1.0)
                    place(bus["shaker"], pos(b0 + q * 0.25), noise_hit(shk_n, 0.09, 0.012, 0.02),
                          vel, -0.25)
            if a["rim"]:
                for b in (1, 3):
                    place(bus["rim"], pos(b0 + b), noise_hit(rim_n, 0.09, 0.003, 0.018), 1.0, 0.1)

            # ---- arp + top line --------------------------------------------
            if a["arp"]:
                tr = 12 if a["arp_hi"] else 0
                for q, (ix, vel) in enumerate(zip((0, 1, 2, 3, 2, 1, 2, 3),
                                                  (0.8, 0.55, 0.65, 0.55, 0.7, 0.5, 0.6, 0.5))):
                    place(bus["arp"], pos(b0 + q * 0.5), v_pluck(midi_hz(ch["arp"][ix] + tr), vel),
                          1.0, -0.3 if q % 2 == 0 else 0.3)
            if a["lead"]:
                for (b, m, d) in LEAD[a["lead"]][cname]:
                    place(bus["lead"], pos(b0 + b), v_mallet(midi_hz(m), d * beat, 0.9), 1.0, -0.05)
                    if a["lead8"]:
                        place(bus["lead"], pos(b0 + b), v_mallet(midi_hz(m + 12), d * beat, 0.9), 0.3, 0.15)

    # ---- bus processing ---------------------------------------------------------
    sc = np.ones(N)
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    dip = (1.0 - db2lin(-SIDECHAIN_DB)) * att(n, 0.005) * np.exp(-t / 0.10) * rel(n, 0.35, 0.10)
    for p in kick_pos:
        e = min(N, p + n)
        sc[p:e] = np.minimum(sc[p:e], 1.0 - dip[:e - p])
    for k in ("pad", "bass"):
        bus[k] *= sc.astype(np.float32)

    bus["dkeys"] = filt(bus["dkeys"], [("lp", 800, 4)]).astype(np.float32)
    bus["dpad"] = filt(bus["dpad"], [("lp", 600, 2)]).astype(np.float32)

    def pingpong(x, d, fb, taps, lp):
        wet = filt(x.mean(axis=0), [("lp", lp, 2), ("hp", 200, 1)])
        out = np.zeros_like(x)
        for k in range(1, taps + 1):
            if k * d >= N:
                break
            g = fb ** k
            out[k % 2, k * d:] += g * wet[:N - k * d]
            out[1 - k % 2, k * d:] += 0.3 * g * wet[:N - k * d]
        return out

    bus["arp"] += pingpong(bus["arp"], pos(0.75), 0.38, 3, 2500)
    bus["lead"] += pingpong(bus["lead"], pos(1.0), 0.25, 2, 3000)

    dry = np.zeros((2, N))
    send = np.zeros((2, N))
    for k in names:
        dry += GAIN[k] * bus[k]
        if k in SEND:
            send += (GAIN[k] * SEND[k]) * bus[k]

    # reverb: convolution with synthetic, stereo-decorrelated decaying noise
    n = int(2.4 * SR)
    t = np.arange(n) / SR
    ir = np.zeros((2, n))
    for c in range(2):
        hi = filt(rng.standard_normal(n), [("hp", 300, 2), ("lp", 5500, 2)]) * np.exp(-6.908 * t / 1.3)
        lo = filt(rng.standard_normal(n), [("hp", 200, 2), ("lp", 1500, 2)]) * np.exp(-6.908 * t / 2.1)
        ir[c] = (hi + 0.8 * lo) * att(n, 0.006) * rel(n, 2.0, 0.4)
    ir = np.concatenate([np.zeros((2, int(0.018 * SR))), ir], axis=1)
    ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
    nf = next_pow2(N + ir.shape[1])
    wet = np.fft.irfft(np.fft.rfft(send, nf, axis=1) * np.fft.rfft(ir, nf, axis=1), nf, axis=1)[:, :N]
    mix = dry + REVERB_WET * wet

    def master(x):
        y = filt(x, [("hp", 30, 2), ("lp", 14000, 4)])
        y *= att(N, 0.02)
        return y * rel(N, cues["duration"], TAIL - 0.1)

    mix = master(mix)
    g = db2lin(-3.0) / np.abs(mix).max()
    stems = {k: master(GAIN[k] * bus[k]) * g for k in names}
    stems["reverb"] = master(REVERB_WET * wet) * g
    return mix * g, stems, [p / SR for p in kick_pos]


# ---------------------------------------------------------------------------- sfx
# Pitched effects use only G, A, C, D - consonant over every chord in the music bed.

def pk_env(n, a_s, tau):
    """Raised-cosine attack peaking at exactly a_s, exponential decay, faded to 0 at the end."""
    t = np.arange(n) / SR
    a = max(2, int(round(a_s * SR)))
    e = np.exp(-np.maximum(t - a / SR, 0.0) / tau)
    e[:a] = 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    m = max(2, n // 4)
    e[-m:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(m) / m)
    return e


def tone(n, f, a_s, tau, h2=0.0, h3=0.0):
    t = np.arange(n) / SR
    ph = TWO_PI * f * t
    y = np.sin(ph)
    if h2:
        y = y + h2 * np.sin(2 * ph) * np.exp(-t / (0.5 * tau))
    if h3:
        y = y + h3 * np.sin(3 * ph) * np.exp(-t / (0.4 * tau))
    return y * pk_env(n, a_s, tau)


def st(mono, pan=0.0):
    out = np.zeros((2, len(mono)))
    place(out, 0, mono, 1.0, pan)
    return out * math.sqrt(2.0)


def sfx_tap(rng, **_):
    n = int(0.040 * SR)
    t = np.arange(n) / SR
    f = 587.33 * (1.0 + 0.8 * np.exp(-t / 0.004))
    ph = TWO_PI * (np.cumsum(f) - f[0]) / SR
    y = np.sin(ph) * pk_env(n, 0.003, 0.007)
    y += 0.12 * lev_noise(n, 2000, 5000, rng) * pk_env(n, 0.003, 0.003)
    return st(y), int(0.003 * SR)


def sfx_tick(rng, step=0, **_):
    f = (1567.98, 1760.0, 2093.0, 2349.32)[min(step, 3)]
    n = int(0.030 * SR)
    return st(tone(n, f, 0.002, 0.006)), int(0.002 * SR)


def sfx_check(rng, **_):
    n = int(0.250 * SR)
    y = np.zeros(n)
    y += tone(n, 880.0, 0.004, 0.060, h2=0.25)
    o = int(0.090 * SR)
    y[o:] += 0.85 * tone(n - o, 1174.66, 0.004, 0.060, h2=0.25)
    return st(y), int(0.004 * SR)


def sfx_decline(rng, **_):
    n = int(0.300 * SR)
    y = tone(n, 293.66, 0.006, 0.080, h3=0.18)
    o = int(0.120 * SR)
    y[o:] += 0.85 * tone(n - o, 220.0, 0.006, 0.085, h3=0.18)
    return st(y), int(0.006 * SR)


def sfx_paid(rng, **_):
    n = int(0.900 * SR)
    out = np.zeros((2, n))
    for i, (f, o_s, g, pan) in enumerate(((392.0, 0.0, 1.0, -0.3), (587.33, 0.11, 0.8, 0.0),
                                          (880.0, 0.22, 0.8, 0.3))):
        o = int(o_s * SR)
        last = i == 2
        y = tone(n - o, f, 0.005, 0.30 if last else 0.16, h2=0.30 if last else 0.2,
                 h3=0.08 if last else 0.0)
        place(out, o, y, g * math.sqrt(2.0), pan)
    o = int(0.22 * SR)                                  # warm octave-below bloom under the bell
    place(out, o, tone(n - o, 440.0, 0.08, 0.28), 0.35 * math.sqrt(2.0), 0.0)
    return out, int(0.005 * SR)


def sfx_callout(rng, **_):
    n = int(0.150 * SR)
    return st(tone(n, 783.99, 0.003, 0.035, h2=0.4, h3=0.15)), int(0.003 * SR)


def sfx_sign(rng, **_):
    n = int(0.500 * SR)
    a = int(0.005 * SR)
    t = np.arange(n) / SR - a / SR
    T = n / SR - a / SR
    e = 0.40 * np.exp(-np.maximum(t, 0) / 0.022) + \
        0.60 * (0.72 + 0.28 * np.cos(TWO_PI * 6.5 * np.maximum(t, 0))) * \
        np.clip(1.0 - (np.maximum(t, 0) / T) ** 2, 0, 1)
    e[:a] = 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    y = lev_noise(n, 1500, 5000, rng) * e
    out = np.zeros((2, n))
    pan = np.linspace(-0.35, 0.35, n)
    ang = (pan + 1) * np.pi / 4
    out[0], out[1] = y * np.cos(ang) * math.sqrt(2), y * np.sin(ang) * math.sqrt(2)
    return out, a


def sfx_whoosh(rng, **_):
    pre, post = 0.30, 0.15
    n = int((pre + post) * SR)
    a = int(pre * SR)
    t = np.arange(n) / SR - pre
    e = np.where(t < 0, np.exp(t / 0.075), np.exp(-t / 0.040))
    e *= att(n, 0.03) * rel(n, pre + post - 0.05, 0.05)
    x = np.clip(1.0 - np.abs(t) / pre, 0, 1)             # 0 far from the cue .. 1 at the cue
    lo, mid, hi = (lev_noise(n, 300, 1200, rng), lev_noise(n, 900, 3000, rng),
                   lev_noise(n, 2200, 6000, rng))
    y = (lo * (1 - x) + mid * 0.9 + hi * 0.6 * x * x) * e / 1.9
    pan = np.clip(t / pre, -1, 1) * 0.5
    ang = (pan + 1) * np.pi / 4
    return np.stack([y * np.cos(ang), y * np.sin(ang)]) * math.sqrt(2), a


def sfx_dark(rng, **_):
    n = int(0.600 * SR)
    a = int(0.008 * SR)
    t = np.arange(n) / SR
    f = 73.42 + (110.0 - 73.42) * np.exp(-t / 0.12)
    ph = TWO_PI * (np.cumsum(f) - f[0]) / SR
    y = (np.sin(ph) + 0.25 * np.sin(2 * ph) * np.exp(-t / 0.15)) * pk_env(n, 0.008, 0.20)
    y += 0.45 * lev_noise(n, 60, 350, rng) * pk_env(n, 0.008, 0.035)
    return st(y), a


def sfx_light(rng, **_):
    n = int(0.600 * SR)
    a = int(0.005 * SR)
    t = np.arange(n) / SR
    y = 0.6 * tone(n, 880.0, 0.005, 0.22, h2=0.15) + 0.45 * tone(n, 1318.51, 0.005, 0.25)
    f = 880.0 * 2.0 ** np.minimum(t / 0.45, 1.0)          # faint glide up one octave
    y += 0.12 * np.sin(TWO_PI * (np.cumsum(f) - f[0]) / SR) * pk_env(n, 0.005, 0.30)
    x = np.clip(t / 0.5, 0, 1)
    air = lev_noise(n, 2500, 5000, rng) * (1 - x) + lev_noise(n, 5000, 9500, rng) * x
    y += 0.16 * air * pk_env(n, 0.005, 0.28)
    return st(y), a


SFX = dict(tap=(sfx_tap, -5.0), tick=(sfx_tick, -9.0), check=(sfx_check, -3.0),
           decline=(sfx_decline, -2.0), paid=(sfx_paid, 0.0), callout=(sfx_callout, -4.0),
           sign=(sfx_sign, -10.0), whoosh=(sfx_whoosh, -8.0), dark=(sfx_dark, -1.0),
           light=(sfx_light, -8.0))
SFX_REF_DB = -8.0     # peak level of a 0 dB effect in sfx.wav


def render_sfx(cues, seed):
    rng = np.random.default_rng([seed, 2])
    N = int(round((cues["duration"] + TAIL) * SR))
    out = np.zeros((2, N))
    step, prev_tick = 0, -10.0
    for e in cues["sfx"]:
        fn, gdb = SFX[e["name"]]
        if e["name"] == "tick":                      # consecutive ticks climb G-A-C-D
            step = step + 1 if e["t"] - prev_tick < 1.25 else 0
            prev_tick = e["t"]
        sig, anchor = fn(rng, step=step)
        sig = sig * (db2lin(SFX_REF_DB + gdb) / np.abs(sig).max())
        place(out, int(round(e["t"] * SR)) - anchor, sig)
    out = filt(out, [("hp", 35, 2), ("lp", 14000, 4)])
    return out


# --------------------------------------------------------------------------- VO

def render_vo(vo_path, N):
    with open(vo_path) as fh:
        spec = json.load(fh)
    vo = np.zeros(N)
    spans = []
    for it in spec.get("items", []):
        x = read_mono_48k(it["file"]) * db2lin(float(it.get("gain_db", 0)))
        start = int(round(float(it["at"]) * SR))
        e = smooth(np.abs(x), int(0.010 * SR))
        act = np.nonzero(e > e.max() * db2lin(-40.0))[0]
        if len(act) == 0:
            continue
        spans.append(((start + act[0]) / SR, (start + act[-1]) / SR))
        s0, e0 = max(0, -start), min(len(x), N - start)
        if e0 > s0:
            vo[start + s0:start + e0] += x[s0:e0]
    return vo, spans


def duck_curve(spans, N, depth_db=7.0, attack=0.05, release=0.30, lead=0.03):
    """Gain (dB) for the music: reaches -depth `lead` s before each VO item starts
    (so the ramp begins attack+lead early) and recovers over `release` after it ends."""
    g = np.zeros(N)
    for (s, e) in spans:
        a0 = int(round((s - lead - attack) * SR))
        a1 = int(round((s - lead) * SR))
        r0 = int(round(e * SR))
        r1 = int(round((e + release) * SR))
        seg = np.zeros(max(0, r1 - a0))
        na, nr = a1 - a0, r1 - r0
        seg[:na] = -depth_db * (0.5 - 0.5 * np.cos(np.pi * np.arange(na) / na))
        seg[na:r0 - a0] = -depth_db
        seg[r0 - a0:] = -depth_db * (0.5 + 0.5 * np.cos(np.pi * np.arange(nr) / nr))
        lo, hi = max(0, a0), min(N, r1)
        if hi > lo:
            g[lo:hi] = np.minimum(g[lo:hi], seg[lo - a0:hi - a0])
    return g


# -------------------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cues")
    ap.add_argument("--out", required=True)
    ap.add_argument("--vo")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--stems", action="store_true", help="also write per-instrument stems to <out>/stems")
    ap.add_argument("--music-db", type=float, default=0.0, help="trim music in the mixes")
    ap.add_argument("--sfx-db", type=float, default=0.0, help="trim sfx in the mixes")
    ap.add_argument("--vo-db", type=float, default=0.0, help="trim VO in the full mix")
    ap.add_argument("--target-lufs", type=float, default=-16.0)
    args = ap.parse_args(argv)
    t_start = time.time()
    try:
        cues = load_cues(args.cues)
        dark = plan(cues)
    except (CueError, KeyError, TypeError, json.JSONDecodeError) as ex:
        print(f"error: {ex}", file=sys.stderr)
        return 2
    os.makedirs(args.out, exist_ok=True)
    wrng = np.random.default_rng([args.seed, 3])
    N = int(round((cues["duration"] + TAIL) * SR))

    music, stems, kick_times = render_music(cues, args.seed)
    sfx = render_sfx(cues, args.seed)
    write_wav(os.path.join(args.out, "music.wav"), music, wrng)
    write_wav(os.path.join(args.out, "sfx.wav"), sfx, wrng)
    if args.stems:
        os.makedirs(os.path.join(args.out, "stems"), exist_ok=True)
        for k, v in stems.items():
            write_wav(os.path.join(args.out, "stems", k + ".wav"), v, wrng)

    gm, gs = db2lin(args.music_db), db2lin(args.sfx_db)
    mix, info = finalize(gm * music + gs * sfx, args.target_lufs)
    write_wav(os.path.join(args.out, "mix_music_sfx.wav"), mix, wrng)
    rep = dict(
        sample_rate=SR, samples=N, seconds=N / SR, bpm=cues["bpm"], seed=args.seed,
        scenes=[dict(id=s["id"], start=s["start"], bars=s["n_bars"], theme=s["theme"],
                     kind=s["arr"]["kind"], chords=[CHORD_NAMES[c] for c in s["arr"]["chords"]],
                     arrangement=s["arr"]["desc"]) for s in cues["scenes"]],
        sfx=cues["sfx"], kick_times=kick_times,
        music=dict(peak_db=round(lin2db(np.abs(music).max()), 2), lufs=round(lufs(music), 2)),
        sfx_stem=dict(peak_db=round(lin2db(np.abs(sfx).max()), 2)),
        mix_music_sfx=dict(music_gain_db=round(args.music_db + info["gain_db"], 2),
                           sfx_gain_db=round(args.sfx_db + info["gain_db"], 2), **info),
    )

    if args.vo:
        try:
            vo, spans = render_vo(args.vo, N)
        except (CueError, KeyError, TypeError, json.JSONDecodeError, OSError) as ex:
            print(f"error: {ex}", file=sys.stderr)
            return 2
        vo2 = np.stack([vo, vo])
        vpk = float(np.abs(vo).max())
        if vpk <= 0:
            print("error: VO items are silent", file=sys.stderr)
            return 2
        vscale = min(1.0, db2lin(-1.0) / vpk)             # only so the stem itself cannot clip
        write_wav(os.path.join(args.out, "vo.wav"), vo2 * vscale, wrng)
        gv = db2lin(args.vo_db)
        # levels relative to the VO: sfx peaks 10 dB under VO peaks, music 16 LU under VO
        g_sfx = gv * vpk * db2lin(-10.0) / db2lin(SFX_REF_DB) * gs
        g_mus = gv * db2lin(lufs(vo2) - 16.0 - lufs(music)) * gm
        duck = duck_curve(spans, N)
        full = gv * vo2 + g_sfx * sfx + g_mus * music * db2lin(duck)
        full, finfo = finalize(full, args.target_lufs)
        write_wav(os.path.join(args.out, "mix_full.wav"), full, wrng)
        rep["mix_full"] = dict(
            vo_gain_db=round(lin2db(gv) + finfo["gain_db"], 2),
            vo_stem_gain_db=round(lin2db(gv / vscale) + finfo["gain_db"], 2),
            sfx_gain_db=round(lin2db(g_sfx) + finfo["gain_db"], 2),
            music_gain_db=round(lin2db(g_mus) + finfo["gain_db"], 2),
            duck_db=-7.0, duck_attack_s=0.05, duck_release_s=0.30, duck_lookahead_s=0.08,
            vo_spans=[[round(a, 4), round(b, 4)] for a, b in spans], **finfo)

    rep["render_seconds"] = round(time.time() - t_start, 2)
    with open(os.path.join(args.out, "report.json"), "w") as fh:
        json.dump(rep, fh, indent=1)
    print(f"rendered {N / SR:.3f} s ({N} samples) in {rep['render_seconds']} s -> {args.out}")
    for s in rep["scenes"]:
        print(f"  {s['start']:6.2f}s {s['id']:<10} {s['bars']} bars  [{' | '.join(s['chords'])}]  {s['arrangement']}")
    print(f"  music peak {rep['music']['peak_db']} dBFS, {rep['music']['lufs']} LUFS; "
          f"mix_music_sfx {info['lufs']} LUFS, peak {info['peak_db']} dBFS, limiter GR {info['limiter_gr_db']} dB")
    if args.vo:
        f = rep["mix_full"]
        print(f"  mix_full {f['lufs']} LUFS, peak {f['peak_db']} dBFS, limiter GR {f['limiter_gr_db']} dB; "
              f"gains dB: vo {f['vo_gain_db']}, sfx {f['sfx_gain_db']}, music {f['music_gain_db']} (-7 under VO)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
