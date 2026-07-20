/** Tiny procedural WebAudio SFX — no asset files needed. */

export type EngineKind = 'sports' | 'v8' | 'rally';

/** Engine synthesis: the fundamental is the FIRING frequency (cylinders firing
 *  per second), with a strong half-frequency subharmonic — that crankshaft
 *  burble is what reads as a real V engine. Everything scales with RPM; fixed-
 *  rate modulation is banned (a constant tremolo sounds like a helicopter). */
interface EngineProfile {
  fLo: number;         // firing freq at idle (Hz) — synth fallback
  fHi: number;         // firing freq at redline (Hz) — synth fallback
  gears: number;       // virtual gears (pitch saws up, drops on shift)
  filterLo: number;
  filterHi: number;
  half: number;        // half-order harmonic level (V-engine burble)
  sub: number;         // sine sub level (body/weight)
  noise: number;       // intake/road noise level at redline
  drive: number;       // distortion drive (warmth/grit)
  rateLo: number;      // SAMPLE path: playbackRate at idle
  rateHi: number;      // SAMPLE path: playbackRate at redline
}

const ENGINE_PROFILES: Record<EngineKind, EngineProfile> = {
  // high-revving exotic: bright, sharp, screams at the top
  sports: { fLo: 65, fHi: 390, gears: 4, filterLo: 1100, filterHi: 6200, half: 0.5, sub: 0.22, noise: 0.5, drive: 2.2, rateLo: 0.55, rateHi: 1.5 },
  // V6 truck: slowed way down — deep and chunky from the same sample
  v8: { fLo: 36, fHi: 185, gears: 3, filterLo: 340, filterHi: 1600, half: 0.9, sub: 0.8, noise: 0.35, drive: 3.2, rateLo: 0.32, rateHi: 0.95 },
  // punchy tuned rally four: mid-bright with grit
  rally: { fLo: 50, fHi: 300, gears: 4, filterLo: 650, filterHi: 3200, half: 0.7, sub: 0.45, noise: 0.45, drive: 2.7, rateLo: 0.45, rateHi: 1.25 },
};

// engine voice = MICRO-LOOP from the sharp rev sample (engine-short.mp3):
// ~6 engine cycles at its most aggressive instant (t=0.70s, 211Hz, measured by
// autocorrelation). A 28ms loop can't wobble — ALL rev movement comes from
// playbackRate, so pitch response is 1:1 with speed/boost.
const ENGINE_SAMPLE_LOOP = { start: 0.7001, end: 0.7279 };
const ENGINE_BASE_HZ = 211;

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;

  // modular engine voice (rebuilt per vehicle profile)
  private engProfile: EngineProfile = ENGINE_PROFILES.rally;
  private engOsc1: OscillatorNode | null = null;   // firing fundamental (saw)
  private engHalf: OscillatorNode | null = null;   // half-order burble (saw)
  private engSub: OscillatorNode | null = null;    // sine sub
  private engNoise: AudioBufferSourceNode | null = null;
  private engNoiseGain: GainNode | null = null;
  private engNoiseFilter: BiquadFilterNode | null = null;
  private engShaper: WaveShaperNode | null = null;
  private engFilter: BiquadFilterNode | null = null;
  private engGain: GainNode | null = null;
  private engHalfGain: GainNode | null = null;
  private engSubGain: GainNode | null = null;
  private lastSpeedN = 0;
  // sample-based engine (preferred when loaded)
  private engineBuf: AudioBuffer | null = null;
  private revBuf: AudioBuffer | null = null;
  private engSample: AudioBufferSourceNode | null = null;
  private engineLoop = { ...ENGINE_SAMPLE_LOOP };
  private engWobble = 0;
  // nitro: sustained whoosh held exactly while boost is active
  private nitroGain: GainNode | null = null;
  private nitroFilter: BiquadFilterNode | null = null;
  private revSrc: AudioBufferSourceNode | null = null;
  private revGain: GainNode | null = null;

  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);

    const len = this.ctx.sampleRate * 1;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.buildEngineVoice();
    this.buildNitroVoice();
    void this.loadEngineSamples();
  }

  /** persistent looping whoosh at gain 0 — nitro() opens/closes it */
  private buildNitroVoice() {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    this.nitroFilter = this.ctx.createBiquadFilter();
    this.nitroFilter.type = 'bandpass';
    this.nitroFilter.frequency.value = 1100;
    this.nitroFilter.Q.value = 0.7;
    this.nitroGain = this.ctx.createGain();
    this.nitroGain.gain.value = 0;
    src.connect(this.nitroFilter).connect(this.nitroGain).connect(this.master);
    src.start();
  }

  /** call every frame: whoosh holds while active, pitch rises with speed,
   *  cuts within ~120ms of release — fully adaptive to boost duration */
  nitro(active: boolean, speedN: number) {
    if (!this.ctx || !this.nitroGain || !this.nitroFilter) return;
    const t = this.ctx.currentTime;
    this.nitroGain.gain.setTargetAtTime(active ? 0.16 + speedN * 0.1 : 0, t, active ? 0.05 : 0.045);
    if (active) this.nitroFilter.frequency.setTargetAtTime(900 + speedN * 1500, t, 0.1);
  }

  /** load the rev sample: micro-loop = engine voice, full sweep = turbo vroom */
  private async loadEngineSamples() {
    if (!this.ctx) return;
    try {
      const data = await fetch('/audio/engine-short.mp3').then((r) => r.arrayBuffer());
      const buf = await this.ctx.decodeAudioData(data);
      this.engineBuf = buf;
      this.revBuf = buf;
      // snap loop points to rising zero-crossings — no clicks at the seam
      const ch = buf.getChannelData(0);
      const sr = buf.sampleRate;
      const snap = (t: number) => {
        let i = Math.floor(t * sr);
        while (i < ch.length - 1 && !(ch[i] <= 0 && ch[i + 1] > 0)) i++;
        return i / sr;
      };
      this.engineLoop.start = snap(ENGINE_SAMPLE_LOOP.start);
      this.engineLoop.end = snap(ENGINE_SAMPLE_LOOP.end);
      this.teardownEngine();
      this.buildEngineVoice();   // rebuild on the sample path
    } catch {
      // keep the synth fallback silently
    }
  }

  /** recorded rev "vroom" ignition on turbo engagement — MANAGED: revStop()
   *  cuts it early if the boost ends before the sweep does */
  revBlip() {
    if (!this.ctx || !this.master || !this.revBuf) return;
    this.revStop();
    const t = this.ctx.currentTime;
    this.revSrc = this.ctx.createBufferSource();
    this.revSrc.buffer = this.revBuf;
    this.revGain = this.ctx.createGain();
    this.revGain.gain.setValueAtTime(0.38, t);
    this.revGain.gain.setValueAtTime(0.38, t + 0.9);
    this.revGain.gain.exponentialRampToValueAtTime(0.001, t + 1.35);
    this.revSrc.connect(this.revGain).connect(this.master);
    this.revSrc.start(t, 0.15, 1.3);
  }

  /** fast-fade the ignition vroom (boost released early) */
  revStop() {
    if (!this.ctx || !this.revGain || !this.revSrc) return;
    const t = this.ctx.currentTime;
    this.revGain.gain.cancelScheduledValues(t);
    this.revGain.gain.setTargetAtTime(0, t, 0.04);
    try { this.revSrc.stop(t + 0.2); } catch { /* already stopped */ }
    this.revSrc = null;
    this.revGain = null;
  }

  private teardownEngine() {
    for (const n of [this.engOsc1, this.engHalf, this.engSub, this.engNoise, this.engSample]) {
      try { n?.stop(); n?.disconnect(); } catch { /* already stopped */ }
    }
    for (const n of [this.engFilter, this.engGain, this.engHalfGain, this.engSubGain, this.engShaper, this.engNoiseGain, this.engNoiseFilter]) {
      n?.disconnect();
    }
    this.engOsc1 = this.engHalf = this.engSub = null;
    this.engSample = null;
  }

  private buildEngineVoice() {
    if (!this.ctx || !this.master) return;
    const p = this.engProfile;

    // SAMPLE PATH: real recorded loop, RPM = playback rate
    if (this.engineBuf) {
      this.engFilter = this.ctx.createBiquadFilter();
      this.engFilter.type = 'lowpass';
      this.engFilter.frequency.value = p.filterLo * 2.2; // recordings need less taming
      this.engFilter.Q.value = 0.5;
      this.engGain = this.ctx.createGain();
      this.engGain.gain.value = 0;
      this.engFilter.connect(this.engGain).connect(this.master);

      this.engSample = this.ctx.createBufferSource();
      this.engSample.buffer = this.engineBuf;
      this.engSample.loop = true;
      this.engSample.loopStart = this.engineLoop.start;
      this.engSample.loopEnd = this.engineLoop.end;
      this.engSample.playbackRate.value = p.rateLo;
      this.engSample.connect(this.engFilter);
      this.engSample.start(0, this.engineLoop.start);

      // sine sub tracks the sample pitch for chest weight
      this.engSub = this.ctx.createOscillator();
      this.engSub.type = 'sine';
      this.engSub.frequency.value = ENGINE_BASE_HZ * p.rateLo * 0.25;
      this.engSubGain = this.ctx.createGain();
      this.engSubGain.gain.value = p.sub * 0.4;
      this.engSub.connect(this.engSubGain).connect(this.engFilter);
      this.engSub.start();
      return;
    }

    // chain: oscillators → soft-clip saturation → lowpass → gain → master
    this.engShaper = this.ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = i / 128 - 1;
      curve[i] = Math.tanh(p.drive * x);
    }
    this.engShaper.curve = curve;

    this.engFilter = this.ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = p.filterLo;
    this.engFilter.Q.value = 0.9;
    this.engGain = this.ctx.createGain();
    this.engGain.gain.value = 0;
    this.engShaper.connect(this.engFilter).connect(this.engGain).connect(this.master);

    this.engOsc1 = this.ctx.createOscillator();
    this.engOsc1.type = 'sawtooth';
    this.engOsc1.frequency.value = p.fLo;
    this.engOsc1.connect(this.engShaper);

    // half-order harmonic: the uneven crankshaft pulse of a V engine
    this.engHalf = this.ctx.createOscillator();
    this.engHalf.type = 'sawtooth';
    this.engHalf.frequency.value = p.fLo / 2;
    this.engHalfGain = this.ctx.createGain();
    this.engHalfGain.gain.value = p.half;
    this.engHalf.connect(this.engHalfGain).connect(this.engShaper);

    this.engSub = this.ctx.createOscillator();
    this.engSub.type = 'sine';
    this.engSub.frequency.value = p.fLo / 2;
    this.engSubGain = this.ctx.createGain();
    this.engSubGain.gain.value = p.sub;
    this.engSub.connect(this.engSubGain).connect(this.engShaper);

    // intake/road noise — swells with RPM
    if (this.noiseBuf) {
      this.engNoise = this.ctx.createBufferSource();
      this.engNoise.buffer = this.noiseBuf;
      this.engNoise.loop = true;
      this.engNoiseFilter = this.ctx.createBiquadFilter();
      this.engNoiseFilter.type = 'bandpass';
      this.engNoiseFilter.frequency.value = 900;
      this.engNoiseFilter.Q.value = 0.6;
      this.engNoiseGain = this.ctx.createGain();
      this.engNoiseGain.gain.value = 0;
      this.engNoise.connect(this.engNoiseFilter).connect(this.engNoiseGain).connect(this.engShaper);
      this.engNoise.start();
    }
    this.engOsc1.start();
    this.engHalf.start();
    this.engSub.start();
  }

  /** swap the whole engine voice for the selected vehicle's audio profile */
  setEngineProfile(kind: EngineKind) {
    this.engProfile = ENGINE_PROFILES[kind];
    if (!this.ctx) return;
    this.teardownEngine();
    this.buildEngineVoice();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.35;
  }

  toggleMuted() { this.setMuted(!this.muted); return this.muted; }

  /** velocity → RPM with virtual gear shifts: pitch climbs within each gear,
   *  drops on the shift, climbs again — reads as acceleration */
  engine(speedN: number, turbo: boolean) {
    if (!this.ctx || !this.engGain || !this.engFilter) return;
    const p = this.engProfile;
    const t = this.ctx.currentTime;
    const g = Math.min(p.gears - 1, Math.floor(speedN * p.gears));
    const rpm = Math.min(1, speedN * p.gears - g);           // 0..1 within gear
    const revN = Math.min(1, (0.18 + 0.82 * rpm) * (0.62 + 0.38 * (g / Math.max(1, p.gears - 1))) * (turbo ? 1.12 : 1));
    // volume swells with throttle-on acceleration
    const accel = Math.max(0, speedN - this.lastSpeedN) * 30;
    this.lastSpeedN = speedN;
    const vol = 0.05 + speedN * 0.05 + Math.min(0.03, accel) + (turbo ? 0.02 : 0);

    if (this.engSample) {
      // micro-loop: RPM drives playback rate 1:1 through the gear curve, with
      // a slow random pitch drift for organic life (never a fixed-rate pulse)
      this.engWobble = Math.max(-0.025, Math.min(0.025, this.engWobble + (Math.random() - 0.5) * 0.006));
      const boost = turbo ? 1.14 : 1;
      const rate = (p.rateLo + (p.rateHi - p.rateLo) * revN) * boost * (1 + this.engWobble);
      this.engSample.playbackRate.setTargetAtTime(rate, t, 0.045);
      this.engSub?.frequency.setTargetAtTime(ENGINE_BASE_HZ * rate * 0.25, t, 0.045);
      this.engFilter.frequency.setTargetAtTime((p.filterLo + revN * (p.filterHi - p.filterLo)) * 2.2, t, 0.07);
      this.engGain.gain.setTargetAtTime(vol * 1.5, t, 0.07);
      return;
    }
    if (!this.engOsc1 || !this.engHalf || !this.engSub) return;
    const f = p.fLo + (p.fHi - p.fLo) * revN;
    this.engOsc1.frequency.setTargetAtTime(f, t, 0.06);
    this.engHalf.frequency.setTargetAtTime(f / 2, t, 0.06);
    this.engSub.frequency.setTargetAtTime(f / 2, t, 0.06);
    this.engFilter.frequency.setTargetAtTime(p.filterLo + revN * (p.filterHi - p.filterLo), t, 0.09);
    this.engNoiseGain?.gain.setTargetAtTime(p.noise * (0.15 + 0.85 * revN) * 0.2, t, 0.1);
    this.engGain.gain.setTargetAtTime(vol, t, 0.09);
  }

  engineOff() {
    if (!this.ctx || !this.engGain) return;
    this.engGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.nitroGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.revStop();
  }

  /** incoming-missile warning blip — rate is driven by the caller */
  warnBeep(urgent: boolean) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = urgent ? 1560 : 1080;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(urgent ? 0.16 : 0.11, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + (urgent ? 0.05 : 0.09));
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.12);
  }

  /** heavy low thud — wall crashes and hard landings */
  thud(vol = 1) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5 * vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.25);
    this.noiseBurst(0.12, 0.2 * vol, 500, 0.6);
  }

  private noiseBurst(dur: number, vol: number, filterFreq: number, filterQ = 0.8) {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filterFreq;
    f.Q.value = filterQ;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  shoot() {
    this.noiseBurst(0.07, 0.25, 2600, 1.2);
  }

  hit() {
    this.noiseBurst(0.04, 0.18, 5000);
  }

  missileLaunch() {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    const t = this.ctx.currentTime;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 0.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.7);
  }

  explosion(loud = 1) {
    if (!this.ctx || !this.master) return;
    this.noiseBurst(0.7, 0.55 * loud, 900, 0.5);
    const t = this.ctx.currentTime;
    // low thump
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.6 * loud, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.5);
    // bass-boost layer: sub-woofer body that makes hits feel massive
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(52, t);
    sub.frequency.exponentialRampToValueAtTime(22, t + 0.7);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.85 * loud, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
    sub.connect(sg).connect(this.master);
    sub.start(t);
    sub.stop(t + 0.8);
  }

  /** low lub-dub — panic-state heartbeat */
  heartbeat() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    for (const [delay, vol] of [[0, 0.5], [0.14, 0.32]] as const) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(62, t + delay);
      o.frequency.exponentialRampToValueAtTime(38, t + delay + 0.1);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(vol, t + delay + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.12);
      o.connect(g).connect(this.master);
      o.start(t + delay);
      o.stop(t + delay + 0.15);
    }
  }

  /** two rising blips — lock acquired */
  lockOn() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = i === 0 ? 880 : 1320;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.08);
      g.gain.exponentialRampToValueAtTime(0.14, t + i * 0.08 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.07);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.08);
      o.stop(t + i * 0.08 + 0.09);
    }
  }

  pickup() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = i === 0 ? 620 : 930;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.07 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.12);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.07);
      o.stop(t + i * 0.07 + 0.15);
    }
  }
}

export const sfx = new Sfx();
