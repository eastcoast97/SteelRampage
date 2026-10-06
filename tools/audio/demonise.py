#!/usr/bin/env python3
"""
Turn a recorded human laugh into REAPER's.

A TTS take is a person laughing, and it stays a person however the voice is
chosen: the pitch sits in the male speech band (85-180 Hz) and there is exactly
one of him, in a room with no size. Those are the three things fixed here, in
the order they matter:

  PITCH      resample slower. Everything below is cosmetic next to this.
  LAYERS     the same laugh at an octave down and at a slight detune, offset by
             a few tens of milliseconds. Nothing with one throat can do this, so
             it is the single strongest "not human" cue available.
  GROWL      ring-modulate a copy at ~30 Hz. Sidebands land between the voice's
             own harmonics, which is heard as a rasp rather than as a tone.
  SATURATE   soft clip, for grit the layers alone do not give.
  SPACE      convolve with a dark decaying-noise impulse. Ominous is mostly
             reverb: a dry demon sounds like a man doing a voice.

Run:  python3 tools/audio/demonise.py IN.wav OUT.wav [--start S] [--len L]
"""
import argparse
import sys
import wave

import numpy as np

SR_OUT = 16000


def read_wav(path):
    with wave.open(path) as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit(f'{path}: expected 16-bit, got {sw * 8}-bit')
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return a, sr


def write_wav(path, a, sr):
    a = np.clip(a, -1.0, 1.0)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((a * 32767).astype('<i2').tobytes())


def resample(a, src, dst):
    """plain linear resample — the signal is lowpassed later anyway"""
    if src == dst:
        return a.copy()
    n = int(round(len(a) * dst / src))
    return np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a)


def pitch(a, factor):
    """
    Resample-pitch: slower playback drops pitch AND stretches time.

    That coupling is wanted here. A formant-preserving shift keeps the voice
    human-sized and merely lower, which sounds like a big man; stretching the
    laugh out as it descends is what makes it sound like something larger and
    slower than a man.
    """
    n = int(round(len(a) / factor))
    return np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a)


def onepole_lp(a, sr, hz):
    c = np.exp(-2.0 * np.pi * hz / sr)
    out = np.empty_like(a)
    z = 0.0
    for i, v in enumerate(a):
        z = v * (1 - c) + z * c
        out[i] = z
    return out


def onepole_hp(a, sr, hz):
    return a - onepole_lp(a, sr, hz)


def reverb_ir(sr, secs=1.5, decay=5.0, lp_hz=2600, seed=7):
    """a dark, smooth decaying-noise impulse — a cellar, not a plate"""
    rng = np.random.default_rng(seed)
    n = int(sr * secs)
    t = np.arange(n) / sr
    ir = rng.standard_normal(n) * np.exp(-decay * t)
    ir = onepole_lp(ir, sr, lp_hz)
    ir[: int(sr * 0.012)] *= np.linspace(0, 1, int(sr * 0.012))  # no click on the front
    return ir / (np.sqrt((ir ** 2).sum()) + 1e-9)


def f0(a, sr, lo=40, hi=400):
    """dominant pitch of the loudest half-second, by autocorrelation"""
    w = int(sr * 0.5)
    if len(a) <= w:
        seg = a
    else:
        e = np.array([np.abs(a[i:i + w]).mean() for i in range(0, len(a) - w, w // 4)])
        start = int(np.argmax(e)) * (w // 4)
        seg = a[start:start + w]
    seg = seg - seg.mean()
    if not np.any(seg):
        return 0.0
    c = np.correlate(seg, seg, 'full')[len(seg) - 1:]
    a0, b0 = int(sr / hi), min(int(sr / lo), len(c) - 1)
    if b0 <= a0:
        return 0.0
    return float(sr / (a0 + int(np.argmax(c[a0:b0]))))


def mix_delayed(dst, src, offset):
    """add src into dst at a sample offset, growing dst if needed"""
    end = offset + len(src)
    if end > len(dst):
        dst = np.pad(dst, (0, end - len(dst)))
    dst[offset:end] += src
    return dst


def demonise(a, sr):
    # ---------------------------------------------------------------- pitch
    sr_w = sr
    main = pitch(a, 0.70)        # ~6 semitones down, and that much slower
    sub = pitch(a, 0.47)         # an octave below the original: the chest
    det = pitch(a, 0.735)        # a hair sharp of main -> beating, two throats

    # Resample-pitching stretches time, so the octave-down copy is HALF AGAIN as
    # long as the main one and would keep rumbling for a second after the laugh
    # has finished. The sub is there to put weight under the laugh, not to outlive
    # it, so the deeper layers are cut to the main layer's length and faded.
    def under(x, gain):
        y = x[: len(main)].copy() * gain
        rel = min(len(y), int(sr_w * 0.18))
        if rel:
            y[-rel:] *= np.linspace(1, 0, rel)
        return y

    out = np.zeros(0)
    out = mix_delayed(out, main * 1.00, 0)
    out = mix_delayed(out, under(sub, 0.55), int(sr_w * 0.012))
    out = mix_delayed(out, under(det, 0.42), int(sr_w * 0.031))

    # ---------------------------------------------------------------- growl
    t = np.arange(len(out)) / sr_w
    ring = out * np.sin(2 * np.pi * 31.0 * t)
    out = out + 0.26 * ring

    # ------------------------------------------------------------- saturate
    out = np.tanh(out * 1.9) / np.tanh(1.9)

    # --------------------------------------------------------------- shaped
    out = onepole_lp(out, sr_w, 4200)    # kill the human sibilance/air
    out = onepole_hp(out, sr_w, 38)      # keep it from turning to mud

    # ---------------------------------------------------------------- space
    ir = reverb_ir(sr_w)
    wet = np.convolve(out, ir)[: len(out) + int(sr_w * 0.9)]
    out = np.pad(out, (0, len(wet) - len(out))) + 1.9 * wet

    # ------------------------------------------------------------- envelope
    atk = int(sr_w * 0.008)
    out[:atk] *= np.linspace(0, 1, atk)
    rel = int(sr_w * 0.22)
    out[-rel:] *= np.linspace(1, 0, rel)
    return out, sr_w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--start', type=float, default=0.0, help='seconds into the source')
    ap.add_argument('--len', dest='length', type=float, default=1.9, help='seconds to take')
    ap.add_argument('--gain', type=float, default=0.92, help='peak after normalising')
    args = ap.parse_args()

    a, sr = read_wav(args.src)
    i0 = int(args.start * sr)
    seg = a[i0: i0 + int(args.length * sr)]
    if not len(seg):
        raise SystemExit('empty selection')
    # trim leading/trailing near-silence so the delays line up on the laugh
    amp = np.abs(seg)
    thr = amp.max() * 0.06
    nz = np.flatnonzero(amp > thr)
    if len(nz):
        seg = seg[nz[0]: nz[-1] + 1]

    before = f0(seg, sr)
    out, sr_w = demonise(seg, sr)
    out = resample(out, sr_w, SR_OUT)
    peak = np.abs(out).max()
    if peak > 0:
        out *= args.gain / peak
    after = f0(out, SR_OUT)
    write_wav(args.dst, out, SR_OUT)

    print(f'{args.src} -> {args.dst}')
    print(f'  source   {len(seg) / sr:.2f}s  f0 {before:6.1f} Hz')
    print(f'  demonic  {len(out) / SR_OUT:.2f}s  f0 {after:6.1f} Hz   '
          f'({before / after if after else 0:.2f}x lower)')
    print(f'  {SR_OUT} Hz mono, {len(out) * 2 / 1024:.0f} KB')


if __name__ == '__main__':
    sys.exit(main())
