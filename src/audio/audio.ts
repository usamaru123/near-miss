import * as Tone from 'tone';
import type { Bank } from './bank';
import type { SampleId } from './manifest';

export type VolumeKind = 'master' | 'bgm' | 'se';

export interface PlayOpts {
  /** audio-context time (defaults to now) */
  time?: number;
  db?: number;
  rate?: number;
  /** playback rate at the end of the sound (doppler / pitch dive) */
  rateEnd?: number;
  pan?: number;
  reverse?: boolean;
  /** seconds into the (possibly reversed) buffer */
  offset?: number;
  dur?: number;
  fade?: number;
  dest?: Tone.ToneAudioNode;
  /** reverb send 0..1 (scaled by the SE slider) */
  send?: number;
}

export interface NoiseOpts {
  time?: number;
  dur: number;
  type?: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  peak: number;
  attack?: number;
  pan?: number;
  dest?: Tone.ToneAudioNode;
  send?: number;
  pink?: boolean;
}

export interface OscOpts {
  time?: number;
  type?: OscillatorType;
  f0: number;
  f1?: number;
  dur: number;
  peak: number;
  attack?: number;
  pan?: number;
  dest?: Tone.ToneAudioNode;
  send?: number;
  detune?: number;
}

const FLOOR = 0.0001;

/**
 * Tone.js context, mix buses, master chain, sends and one-shot helpers.
 *
 *   drums/bass/music -> (filters, sidechain) -> bgm  --+
 *   sfx/ui/heart ---------------------------> se   ---+-> mix -> focus lowpass -> bus comp -> limiter -> master
 *   sends: reverb (hall) and ping-pong delay return into `mix`
 */
export class AudioEngine {
  // Nothing Tone-related is created until the first user gesture (build()): Chrome logs an autoplay
  // warning for every audio node started on a suspended context, and the e2e test forbids warnings.
  // buses
  drums!: Tone.Gain;
  bass!: Tone.Gain;
  music!: Tone.Gain;
  sfx!: Tone.Gain;
  ui!: Tone.Gain;
  /** heartbeat bypasses nothing special, but gets its own trim so FOCUS can push it forward */
  heart!: Tone.Gain;
  // sidechain-ducked stages
  scBass!: Tone.Gain;
  scMusic!: Tone.Gain;
  // bgm tone shaping
  musicLP!: Tone.Filter;
  musicHP!: Tone.Filter;
  bassLP!: Tone.Filter;
  musicDist!: Tone.Distortion;
  // levels
  private bgm!: Tone.Gain;
  private se!: Tone.Gain;
  private mix!: Tone.Gain;
  private focusLP!: Tone.Filter;
  private comp!: Tone.Compressor;
  private limiter!: Tone.Limiter;
  /** soft clipper after the limiter: linear below 0.7, smoothly asymptotic to 1.0, so the output can never clip */
  private clipper!: Tone.WaveShaper;
  private masterGain!: Tone.Gain;
  // sends
  private reverb!: Tone.Reverb;
  private revIn!: Tone.Gain;
  private revOut!: Tone.Gain;
  /** reverb tap of the whole SE bus */
  private seFx!: Tone.Gain;
  /** per-sound reverb sends land here (scaled by the SE slider) */
  private seSend!: Tone.Gain;
  /** music-only reverb tap and BGM-scaled delay input */
  private bgmRev!: Tone.Gain;
  private bgmScale!: Tone.Gain;
  private dlyScale!: Tone.Gain;
  /** instruments (arp, lead) feed the ping-pong delay through this */
  delaySend!: Tone.Gain;
  private delay!: Tone.PingPongDelay;
  private delayOut!: Tone.Gain;
  built = false;

  private readonly reversed = new Map<SampleId, AudioBuffer>();

  muted = false;
  readonly vol: Record<VolumeKind, number> = { master: 0.8, bgm: 0.7, se: 1 };
  private focusOn = false;
  private unlocked: Promise<void> | null = null;

  constructor(readonly bank: Bank) {}

  /** Create the whole Tone graph. Called on the first user gesture (or by the offline test tool). */
  build(): void {
    if (this.built) return;
    this.built = true;
    Tone.getContext().lookAhead = 0.05;
    this.drums = new Tone.Gain(1);
    this.bass = new Tone.Gain(1);
    this.music = new Tone.Gain(1);
    this.sfx = new Tone.Gain(0.85);
    this.ui = new Tone.Gain(1);
    this.heart = new Tone.Gain(1);
    this.scBass = new Tone.Gain(1);
    this.scMusic = new Tone.Gain(1);
    this.musicLP = new Tone.Filter(8000, 'lowpass');
    this.musicHP = new Tone.Filter(20, 'highpass');
    this.bassLP = new Tone.Filter(9000, 'lowpass');
    this.musicDist = new Tone.Distortion({ distortion: 0.25, wet: 0 });
    this.bgm = new Tone.Gain(0.7);
    this.se = new Tone.Gain(1);
    this.mix = new Tone.Gain(1);
    this.focusLP = new Tone.Filter(20000, 'lowpass');
    this.comp = new Tone.Compressor({ threshold: -16, ratio: 3.5, attack: 0.012, release: 0.22, knee: 10 });
    this.limiter = new Tone.Limiter(-1.5);
    this.clipper = new Tone.WaveShaper((x: number) => {
    const a = Math.abs(x);
    if (a <= 0.7) return x;
    return Math.sign(x) * (0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3));
  }, 4096);
    this.masterGain = new Tone.Gain(0.8);
    this.reverb = new Tone.Reverb({ decay: 3.4, preDelay: 0.02 });
    this.revIn = new Tone.Gain(1);
    this.revOut = new Tone.Gain(0.5);
    this.seFx = new Tone.Gain(0.12);
    this.seSend = new Tone.Gain(1);
    this.bgmRev = new Tone.Gain(0.3);
    this.bgmScale = new Tone.Gain(0.7);
    this.dlyScale = new Tone.Gain(0.7);
    this.delaySend = new Tone.Gain(1);
    this.delay = new Tone.PingPongDelay({ delayTime: '8n.', feedback: 0.38, wet: 1 });
    this.delayOut = new Tone.Gain(0.45);

    this.drums.connect(this.bgm);
    this.bass.connect(this.bassLP);
    this.bassLP.connect(this.bgm);
    this.scBass.connect(this.bass);
    this.music.connect(this.musicLP);
    this.musicLP.connect(this.musicHP);
    this.musicHP.connect(this.musicDist);
    this.musicDist.connect(this.bgm);
    this.scMusic.connect(this.music);
    this.sfx.connect(this.se);
    this.ui.connect(this.se);
    this.heart.connect(this.se);
    this.bgm.connect(this.mix);
    this.se.connect(this.mix);

    // sends (post-slider so a muted bus has no ghost reverb)
    this.musicDist.connect(this.bgmRev);
    this.bgmRev.connect(this.bgmScale);
    this.bgmScale.connect(this.revIn);
    this.delaySend.connect(this.dlyScale);
    this.dlyScale.connect(this.delay);
    this.se.connect(this.seFx);
    this.seFx.connect(this.revIn);
    this.seSend.connect(this.revIn);
    this.revIn.connect(this.reverb);
    this.reverb.connect(this.revOut);
    this.revOut.connect(this.mix);
    this.delay.connect(this.delayOut);
    this.delayOut.connect(this.mix);

    this.mix.chain(this.focusLP, this.comp, this.limiter, this.clipper, this.masterGain, Tone.getDestination());
    this.applyVolumes(0);
  }

  /** Resolves once the reverb impulse has been rendered. */
  reverbReady(): Promise<void> {
    return this.built ? this.reverb.ready.then(() => undefined).catch(() => undefined) : Promise.resolve();
  }

  /** Call from a user gesture. Idempotent; resolves when the context is running. */
  unlock(): Promise<void> {
    this.build();
    if (!this.unlocked) {
      this.unlocked = Tone.start().catch(() => {
        this.unlocked = null;
      });
    } else if (this.rawContext.state === 'suspended') {
      void this.rawContext.resume();
    }
    return this.unlocked ?? Promise.resolve();
  }

  get rawContext(): AudioContext {
    return Tone.getContext().rawContext as AudioContext;
  }

  /** Offline rendering (tools / tests) has no running context; this lets sounds schedule anyway. */
  forceRunning = false;

  get running(): boolean {
    return this.forceRunning || (this.built && this.rawContext.state === 'running');
  }

  /** Current audio time plus a hair of safety. */
  get now(): number {
    return this.rawContext.currentTime + 0.01;
  }

  // ---- volume / mute / focus ----

  private applyVolumes(ramp = 0.03): void {
    if (!this.built) return;
    this.masterGain.gain.rampTo(this.muted ? 0 : this.vol.master, ramp);
    this.bgm.gain.rampTo(this.vol.bgm, ramp);
    this.bgmScale.gain.rampTo(this.vol.bgm, ramp);
    this.dlyScale.gain.rampTo(this.vol.bgm, ramp);
    this.seSend.gain.rampTo(this.vol.se, ramp);
    this.se.gain.rampTo(this.vol.se, ramp);
  }

  setVolume(kind: VolumeKind, v: number): void {
    this.vol[kind] = Math.max(0, Math.min(1, v));
    this.applyVolumes();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolumes();
  }

  /** FOCUS: 700 Hz lowpass over everything, more reverb. The heartbeat is pushed forward by the caller. */
  setFocus(on: boolean): void {
    this.focusOn = on;
    if (!this.built) return;
    this.focusLP.frequency.rampTo(on ? 700 : 20000, on ? 0.08 : 0.2);
    this.revOut.gain.rampTo(on ? 1.1 : 0.5, on ? 0.15 : 0.3);
    this.heart.gain.rampTo(on ? 2.2 : 1, 0.1);
  }

  get focusActive(): boolean {
    return this.focusOn;
  }

  /** Death: close the master lowpass. */
  muffleDeath(): void {
    if (!this.built) return;
    this.focusLP.frequency.rampTo(260, 0.5);
  }

  restoreFilter(): void {
    if (!this.built) return;
    this.focusLP.frequency.rampTo(this.focusOn ? 700 : 20000, 0.05);
    this.bgm.gain.cancelScheduledValues(this.now);
    this.bgm.gain.rampTo(this.vol.bgm, 0.02);
  }

  suspend(): void {
    if (this.running) void this.rawContext.suspend();
  }

  resume(): void {
    if (this.rawContext.state === 'suspended') void this.rawContext.resume();
  }

  // ---- sidechain ----

  /** Pump the bass / pad / chord stages on a kick. */
  duck(time: number, depth = 0.22, release = 0.2): void {
    if (!this.built) return;
    for (const g of [this.scBass.gain, this.scMusic.gain]) {
      g.setValueAtTime(depth, time);
      g.linearRampToValueAtTime(1, time + release);
    }
  }

  // ---- one-shot helpers ----

  private reversedOf(id: SampleId): AudioBuffer | null {
    const hit = this.reversed.get(id);
    if (hit) return hit;
    const raw = this.bank.get(id);
    if (!raw) return null;
    const out = this.rawContext.createBuffer(raw.numberOfChannels, raw.length, raw.sampleRate);
    for (let c = 0; c < raw.numberOfChannels; c++) {
      const a = raw.getChannelData(c);
      const b = out.getChannelData(c);
      for (let i = 0, n = a.length; i < n; i++) b[i] = a[n - 1 - i];
    }
    this.reversed.set(id, out);
    return out;
  }

  private release(nodes: Tone.ToneAudioNode[], seconds: number): void {
    window.setTimeout(() => {
      for (const n of nodes) {
        try {
          n.dispose();
        } catch {
          /* already disposed */
        }
      }
    }, Math.max(100, seconds * 1000 + 250));
  }

  private tail(node: Tone.ToneAudioNode, nodes: Tone.ToneAudioNode[], pan: number | undefined, dest: Tone.ToneAudioNode, send: number | undefined): void {
    let out: Tone.ToneAudioNode = node;
    if (pan !== undefined && pan !== 0) {
      const p = new Tone.Panner(Math.max(-1, Math.min(1, pan)));
      out.connect(p);
      nodes.push(p);
      out = p;
    }
    out.connect(dest);
    if (send && send > 0) {
      const s = new Tone.Gain(send);
      nodes.push(s);
      out.connect(s);
      s.connect(this.seSend);
    }
  }

  /** Play a decoded sample. Returns false if it is unavailable so the caller can run a synth fallback. */
  play(id: SampleId, o: PlayOpts = {}): boolean {
    if (!this.built) return false;
    const t = o.time ?? this.now;
    return this.bank.trigger(
      id,
      (buf, gain) => {
        const useBuf = o.reverse ? this.reversedOf(id) : buf;
        if (!useBuf) throw new Error('no buffer');
        const rate = o.rate ?? 1;
        const nodes: Tone.ToneAudioNode[] = [];
        const src = new Tone.ToneBufferSource({ url: useBuf, playbackRate: rate });
        const g = new Tone.Gain(gain * Math.pow(10, (o.db ?? 0) / 20));
        nodes.push(src, g);
        src.connect(g);
        if (o.rateEnd !== undefined) {
          const len = o.dur ?? useBuf.duration / rate;
          src.playbackRate.setValueAtTime(rate, t);
          src.playbackRate.exponentialRampToValueAtTime(Math.max(0.05, o.rateEnd), t + len);
        }
        this.tail(g, nodes, o.pan, o.dest ?? this.sfx, o.send);
        const fade = o.fade ?? 0.02;
        src.fadeOut = fade;
        const length = o.dur ?? Math.max(0.02, (useBuf.duration - (o.offset ?? 0)) / rate);
        src.start(t, o.offset ?? 0, o.dur !== undefined ? o.dur * rate : undefined);
        this.release(nodes, length + fade + (t - this.rawContext.currentTime));
      },
      () => undefined,
    );
  }

  /** Enveloped, filtered noise burst. */
  noise(o: NoiseOpts): void {
    if (!this.built) return;
    const t = o.time ?? this.now;
    const nodes: Tone.ToneAudioNode[] = [];
    const n = new Tone.Noise(o.pink ? 'pink' : 'white');
    const f = new Tone.Filter({ type: o.type ?? 'bandpass', frequency: o.f0, Q: o.q ?? 1 });
    const g = new Tone.Gain(FLOOR);
    nodes.push(n, f, g);
    n.connect(f);
    f.connect(g);
    if (o.f1 !== undefined) {
      f.frequency.setValueAtTime(o.f0, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + o.dur);
    }
    const a = Math.min(o.attack ?? 0.005, o.dur * 0.5);
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(Math.max(FLOOR * 2, o.peak), t + a);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + o.dur);
    this.tail(g, nodes, o.pan, o.dest ?? this.sfx, o.send);
    n.start(t).stop(t + o.dur + 0.05);
    this.release(nodes, o.dur + (t - this.rawContext.currentTime));
  }

  /** Enveloped oscillator with an exponential pitch glide. */
  osc(o: OscOpts): void {
    if (!this.built) return;
    const t = o.time ?? this.now;
    const nodes: Tone.ToneAudioNode[] = [];
    const osc = new Tone.Oscillator({ type: o.type ?? 'sine', frequency: o.f0, detune: o.detune ?? 0 });
    const g = new Tone.Gain(FLOOR);
    nodes.push(osc, g);
    osc.connect(g);
    if (o.f1 !== undefined && o.f1 !== o.f0) {
      osc.frequency.setValueAtTime(o.f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(10, o.f1), t + o.dur);
    }
    const a = Math.min(o.attack ?? 0.004, o.dur * 0.5);
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(Math.max(FLOOR * 2, o.peak), t + a);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + o.dur);
    this.tail(g, nodes, o.pan, o.dest ?? this.sfx, o.send);
    osc.start(t).stop(t + o.dur + 0.05);
    this.release(nodes, o.dur + (t - this.rawContext.currentTime));
  }

  /** Pitched gain helper used by melodic SFX. */
  get sendNode(): Tone.ToneAudioNode {
    return this.revIn;
  }

  /** Input of the ping-pong delay (for arps). */
  get delayInput(): Tone.ToneAudioNode {
    return this.delay;
  }
}


