import * as Tone from 'tone';
import type { Bank } from './bank';
import type { SampleId } from './manifest';
import { DuckModel, VoiceBook } from './voicePolicy';

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
/** Sample start / stop fade (anti-click). */
const EDGE_FADE = 0.004;
/** Minimum envelope attack: nothing starts at zero attack. */
const MIN_ATTACK = 0.003;
const POOL_NOISE = 10;
const POOL_OSC = 10;
const MAX_POLY = 3;
const MERGE_WINDOW = 0.03;
/** SFX output bus trim and mix-bus headroom (DESIGN 16.4: >= 6 dB at the master input). */
const MIX_HEADROOM = 0.45;
const MAKEUP = 1.25;

interface NoiseVoice {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  env: GainNode;
  pan: StereoPannerNode;
  send: GainNode;
  dest: Tone.ToneAudioNode | null;
  busyUntil: number;
  startedAt: number;
}

interface OscVoice {
  osc: OscillatorNode;
  env: GainNode;
  pan: StereoPannerNode;
  send: GainNode;
  dest: Tone.ToneAudioNode | null;
  busyUntil: number;
  startedAt: number;
}

interface SampleVoice {
  src: AudioBufferSourceNode;
  g: GainNode;
}

/**
 * Tone.js context, mix buses, master chain, sends and one-shot helpers.
 *
 *   drums/bass/music -> (filters, sidechain) -> bgm -> bgmDuck --+
 *   sfx/ui/heart --------------------------> se -> sfxDuck ------+-> mix(-6 dB) -> focus lowpass -> comp
 *                                                                      -> limiter -> soft clipper -> makeup -> master
 *   sends: reverb (hall) and ping-pong delay return into `mix`
 *
 * One-shot effects never construct Tone nodes: noise / oscillator voices are pooled and reused, sample voices are
 * single-use native source nodes with a 4 ms fade in and out, polyphony is capped per sound (oldest stolen) and
 * identical triggers within 30 ms are merged.
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
  private bgmDuck!: Tone.Gain;
  private se!: Tone.Gain;
  private sfxDuck!: Tone.Gain;
  sfxLimiter!: Tone.Limiter;
  private mix!: Tone.Gain;
  private focusLP!: Tone.Filter;
  private comp!: Tone.Compressor;
  limiter!: Tone.Limiter;
  /** soft clipper after the limiter: linear below 0.9, smoothly asymptotic to 1.0, so the output can never clip */
  private clipper!: Tone.WaveShaper;
  private makeup!: Tone.Gain;
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
  /** true when running inside Tone.Offline (tools / tests): keep the context Tone gives us */
  offline = false;
  /** measurement taps (offline tool only): where the render is read from */
  tap: 'master' | 'mix' | 'limiterIn' = 'master';

  private readonly reversed = new Map<SampleId, AudioBuffer>();
  private readonly book = new VoiceBook<SampleId>(MAX_POLY, MERGE_WINDOW);
  private readonly sampleVoices = new Map<number, SampleVoice>();
  private readonly duckBgm = new DuckModel(0.3, 1.6, 0.22, 0.5);
  private readonly duckSfx = new DuckModel(0.25, 4, 0.1, 0.7);
  private noisePool: NoiseVoice[] = [];
  private oscPool: OscVoice[] = [];
  private noiseBuf: AudioBuffer | null = null;
  /** Per-effect trim applied to everything triggered while it is set (see Sfx.scoped). */
  level = 1;
  /** counters for diagnostics */
  readonly counters = { merged: 0, stolen: 0, played: 0 };

  muted = false;
  readonly vol: Record<VolumeKind, number> = { master: 0.8, bgm: 0.7, se: 1 };
  private focusOn = false;
  private unlocked: Promise<void> | null = null;
  private renderCap: { peakLoad: number; averageLoad: number; underrunRatio: number; updates: number } | null = null;

  constructor(readonly bank: Bank) {}

  /** Create the whole Tone graph. Called on the first user gesture (or by the offline test tool). */
  build(): void {
    if (this.built) return;
    this.built = true;
    if (!this.offline) {
      // 'balanced' (not 'interactive'): bigger render quanta, far fewer underruns under load; the game schedules
      // everything ahead of time, so the extra latency is inaudible.
      const old = Tone.getContext();
      Tone.setContext(new Tone.Context({ latencyHint: 'balanced', lookAhead: 0.06 }));
      try {
        void old.dispose();
      } catch {
        /* nothing to dispose */
      }
    }
    Tone.getContext().lookAhead = 0.06;
    this.drums = new Tone.Gain(1);
    this.bass = new Tone.Gain(1);
    this.music = new Tone.Gain(1);
    this.sfx = new Tone.Gain(0.45);
    this.ui = new Tone.Gain(0.55);
    this.heart = new Tone.Gain(0.6);
    this.scBass = new Tone.Gain(1);
    this.scMusic = new Tone.Gain(1);
    this.musicLP = new Tone.Filter(8000, 'lowpass');
    this.musicHP = new Tone.Filter(20, 'highpass');
    this.bassLP = new Tone.Filter(9000, 'lowpass');
    this.musicDist = new Tone.Distortion({ distortion: 0.25, wet: 0 });
    this.bgm = new Tone.Gain(0.7);
    this.bgmDuck = new Tone.Gain(1);
    this.se = new Tone.Gain(1);
    this.sfxDuck = new Tone.Gain(1);
    // safety net for stacked effects: rarely engaged once the bus trims above are right
    this.sfxLimiter = new Tone.Limiter(-6);
    this.mix = new Tone.Gain(MIX_HEADROOM);
    this.focusLP = new Tone.Filter(20000, 'lowpass');
    this.comp = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.012, release: 0.22, knee: 12 });
    this.limiter = new Tone.Limiter(-1.5);
    this.clipper = new Tone.WaveShaper((x: number) => {
      const a = Math.abs(x);
      if (a <= 0.9) return x;
      return Math.sign(x) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
    }, 4096);
    this.makeup = new Tone.Gain(MAKEUP);
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
    this.bgm.connect(this.bgmDuck);
    this.bgmDuck.connect(this.mix);
    this.se.connect(this.sfxDuck);
    this.sfxDuck.connect(this.sfxLimiter);
    this.sfxLimiter.connect(this.mix);

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

    if (this.offline && this.tap === 'mix') {
      // measurement: the raw mix (master input), no dynamics
      this.mix.chain(this.masterGain, Tone.getDestination());
      this.masterGain.gain.value = 1;
    } else if (this.offline && this.tap === 'limiterIn') {
      // measurement: exactly what the limiter sees
      this.mix.chain(this.focusLP, this.comp, this.masterGain, Tone.getDestination());
      this.masterGain.gain.value = 1;
    } else {
      this.mix.chain(this.focusLP, this.comp, this.makeup, this.limiter, this.clipper, this.masterGain, Tone.getDestination());
    }
    this.applyVolumes(0);
    this.buildPools();
    // everything heavy happens now (load time), not in the middle of a run
    for (const id of ['crash', 'fxWarp', 'fxSweep'] as SampleId[]) this.reversedOf(id);
  }

  /** Resolves once the reverb impulse has been rendered. */
  reverbReady(): Promise<void> {
    return this.built ? this.reverb.ready.then(() => undefined).catch(() => undefined) : Promise.resolve();
  }

  /** Call from a user gesture. Idempotent; resolves when the context is running and the reverb is ready. */
  unlock(): Promise<void> {
    this.build();
    if (!this.unlocked) {
      this.unlocked = Tone.start()
        .then(() => this.reverbReady())
        .then(() => this.startCapacityProbe())
        .catch(() => {
          this.unlocked = null;
        });
    } else if (!this.pauseMute && (this.rawContext.state as string) !== 'running') {
      // 'suspended' (not yet allowed) or iOS's 'interrupted' (call, Siri, alarm, background): resume from this gesture
      void this.rawContext.resume().catch(() => undefined);
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
    return (this.timeOverride ?? this.rawContext.currentTime) + 0.01;
  }

  /** Offline tool only: sounds triggered from a Transport callback start at the callback's own time. */
  timeOverride: number | null = null;

  // ---- diagnostics ----

  private startCapacityProbe(): void {
    const rc = (this.rawContext as unknown as { renderCapacity?: EventTarget & { start(o: { updateInterval: number }): void } }).renderCapacity;
    if (!rc) return;
    this.renderCap = { peakLoad: 0, averageLoad: 0, underrunRatio: 0, updates: 0 };
    rc.addEventListener('update', (ev) => {
      const e = ev as unknown as { peakLoad: number; averageLoad: number; underrunRatio: number };
      const c = this.renderCap;
      if (!c) return;
      c.updates++;
      c.peakLoad = Math.max(c.peakLoad, e.peakLoad);
      c.averageLoad = e.averageLoad;
      c.underrunRatio = Math.max(c.underrunRatio, e.underrunRatio);
    });
    rc.start({ updateInterval: 1 });
  }

  /** Underrun indicators for the debug hook. */
  stats(): Record<string, unknown> {
    const ctx = this.rawContext;
    return {
      sampleRate: ctx.sampleRate,
      baseLatency: ctx.baseLatency,
      outputLatency: (ctx as AudioContext).outputLatency,
      state: ctx.state,
      renderCapacity: this.renderCap,
      limiterReductionDb: this.built ? this.limiter.reduction : 0,
      sfxLimiterReductionDb: this.built ? this.sfxLimiter.reduction : 0,
      voices: { ...this.counters },
    };
  }

  // ---- volume / mute / focus ----

  private applyVolumes(ramp = 0.03): void {
    if (!this.built) return;
    this.masterGain.gain.rampTo(this.muted || this.pauseMute ? 0 : this.vol.master, ramp);
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

  /** FOCUS / CLUTCH: 700 Hz lowpass over everything, more reverb. The heartbeat is pushed forward by the caller. */
  setFocus(on: boolean): void {
    this.focusOn = on;
    if (!this.built) return;
    this.focusLP.frequency.rampTo(on ? 700 : 20000, on ? 0.08 : 0.2);
    this.revOut.gain.rampTo(on ? 1.1 : 0.5, on ? 0.15 : 0.3);
    this.heart.gain.rampTo(on ? 1.5 : 0.6, 0.1);
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
    this.duckBgm.reset();
    this.duckSfx.reset();
    this.bgmDuck.gain.cancelScheduledValues(this.now);
    this.bgmDuck.gain.rampTo(1, 0.05);
    this.sfxDuck.gain.cancelScheduledValues(this.now);
    this.sfxDuck.gain.rampTo(1, 0.05);
  }

  private pauseMute = false;
  private suspendToken = 0;

  /**
   * Pause: fade the master out at once, and suspend the context only after the notes already queued inside Tone
   * (PolySynth defers attacks with timeouts up to ~0.5 s ahead) have played out silently. Suspending earlier makes
   * those deferred attacks start sources on a suspended context, which Tone reports as a console warning.
   */
  suspend(): void {
    if (!this.running) return;
    const tok = ++this.suspendToken;
    this.pauseMute = true;
    this.applyVolumes(0.03);
    window.setTimeout(() => {
      if (tok === this.suspendToken && this.pauseMute) void this.rawContext.suspend();
    }, 700);
  }

  /** Resolves once the context is running again (after a long pause it was really suspended, and resuming takes a moment). */
  resume(): Promise<void> {
    this.suspendToken++;
    this.pauseMute = false;
    const ready = (this.rawContext.state as string) !== 'running' ? this.rawContext.resume().catch(() => undefined) : Promise.resolve();
    this.applyVolumes(0.05);
    return ready.then(() => undefined);
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

  /** Overlap ducking: called for every effect; many at once lower the music (and, lightly, each other). */
  private registerLoad(t: number, weight: number): void {
    const gb = this.duckBgm.add(t, weight);
    const gs = this.duckSfx.add(t, weight);
    const b = this.bgmDuck.gain;
    const s = this.sfxDuck.gain;
    b.cancelScheduledValues(t);
    b.setTargetAtTime(gb, t, 0.015);
    b.setTargetAtTime(1, t + 0.2, 0.25);
    s.cancelScheduledValues(t);
    s.setTargetAtTime(gs, t, 0.015);
    s.setTargetAtTime(1, t + 0.15, 0.2);
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

  private buildPools(): void {
    const ctx = this.rawContext;
    const n = ctx.sampleRate * 2;
    const nb = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = nb.getChannelData(0);
    // deterministic LCG so offline renders are repeatable
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    this.noiseBuf = nb;
    for (let i = 0; i < POOL_NOISE; i++) {
      const src = ctx.createBufferSource();
      src.buffer = nb;
      src.loop = true;
      src.loopStart = (i * 0.137) % 1.5;
      const filter = ctx.createBiquadFilter();
      const env = ctx.createGain();
      env.gain.value = 0;
      const pan = ctx.createStereoPanner();
      const send = ctx.createGain();
      send.gain.value = 0;
      src.connect(filter);
      filter.connect(env);
      env.connect(pan);
      pan.connect(send);
      src.start(0, (i * 0.31) % 1.9);
      this.noisePool.push({ src, filter, env, pan, send, dest: null, busyUntil: 0, startedAt: 0 });
      Tone.connect(send, this.seSend);
    }
    for (let i = 0; i < POOL_OSC; i++) {
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      const env = ctx.createGain();
      env.gain.value = 0;
      const pan = ctx.createStereoPanner();
      const send = ctx.createGain();
      send.gain.value = 0;
      osc.connect(env);
      env.connect(pan);
      pan.connect(send);
      osc.start(0);
      this.oscPool.push({ osc, env, pan, send, dest: null, busyUntil: 0, startedAt: 0 });
      Tone.connect(send, this.seSend);
    }
  }

  /** Route the voice's panner to `dest` (rewired only when the destination changes). */
  private route(v: { pan: StereoPannerNode; dest: Tone.ToneAudioNode | null }, dest: Tone.ToneAudioNode): void {
    if (v.dest === dest) return;
    // pan feeds both the destination and the send gain; only the destination connection is replaced
    if (v.dest) Tone.disconnect(v.pan, v.dest);
    Tone.connect(v.pan, dest);
    v.dest = dest;
  }

  private pick<T extends { busyUntil: number; startedAt: number }>(pool: T[], t: number): { v: T; stolen: boolean } {
    let free: T | null = null;
    let oldest = pool[0];
    for (const v of pool) {
      if (v.busyUntil <= t - 0.004 && (!free || v.busyUntil < free.busyUntil)) free = v;
      if (v.startedAt < oldest.startedAt) oldest = v;
    }
    if (free) return { v: free, stolen: false };
    return { v: oldest, stolen: true };
  }

  private isSfxDest(dest: Tone.ToneAudioNode): boolean {
    return dest !== this.drums && dest !== this.music && dest !== this.bass;
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
        const offset = o.offset ?? 0;
        const length = o.dur ?? Math.max(0.02, (useBuf.duration - offset) / rate);
        const end = t + length;
        const req = this.book.request(id, t, end);
        if (req.merged) {
          this.counters.merged++;
          return;
        }
        if (req.steal !== null) this.stealSample(req.steal, t);
        const ctx = this.rawContext;
        const dest = o.dest ?? this.sfx;
        const src = ctx.createBufferSource();
        src.buffer = useBuf;
        src.playbackRate.setValueAtTime(rate, t);
        if (o.rateEnd !== undefined) src.playbackRate.exponentialRampToValueAtTime(Math.max(0.05, o.rateEnd), end);
        const g = ctx.createGain();
        const peak = gain * this.level * Math.pow(10, (o.db ?? 0) / 20);
        const fadeOut = Math.min(Math.max(o.fade ?? 0.02, EDGE_FADE), length * 0.5);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + EDGE_FADE);
        g.gain.setValueAtTime(peak, Math.max(t + EDGE_FADE, end - fadeOut));
        g.gain.linearRampToValueAtTime(0, end);
        src.connect(g);
        let last: AudioNode = g;
        if (o.pan !== undefined && o.pan !== 0) {
          const p = ctx.createStereoPanner();
          p.pan.value = Math.max(-1, Math.min(1, o.pan));
          last.connect(p);
          last = p;
        }
        Tone.connect(last, dest);
        let sendNode: GainNode | null = null;
        if (o.send && o.send > 0) {
          sendNode = ctx.createGain();
          sendNode.gain.value = o.send;
          last.connect(sendNode);
          Tone.connect(sendNode, this.seSend);
        }
        src.start(t, offset, o.dur !== undefined ? o.dur * rate : undefined);
        src.stop(end + 0.02);
        this.sampleVoices.set(req.token, { src, g });
        src.onended = () => {
          this.sampleVoices.delete(req.token);
          try {
            src.disconnect();
            g.disconnect();
            if (last !== g) last.disconnect();
            sendNode?.disconnect();
          } catch {
            /* already gone */
          }
        };
        this.counters.played++;
        if (this.isSfxDest(dest)) this.registerLoad(t, 0.35 + Math.min(0.5, peak * 0.4));
      },
      () => undefined,
    );
  }

  private stealSample(token: number, t: number): void {
    const v = this.sampleVoices.get(token);
    if (!v) return;
    this.counters.stolen++;
    try {
      v.g.gain.cancelScheduledValues(t);
      v.g.gain.setTargetAtTime(0, t, 0.0015);
      v.src.stop(t + 0.02);
    } catch {
      /* already stopped */
    }
    this.sampleVoices.delete(token);
  }

  /** Enveloped, filtered noise burst (pooled voice). */
  noise(o: NoiseOpts): void {
    if (!this.built || !this.noiseBuf) return;
    const t = o.time ?? this.now;
    const { v, stolen } = this.pick(this.noisePool, t);
    let t0 = t;
    if (stolen) {
      this.counters.stolen++;
      const ts = Math.max(this.rawContext.currentTime, t - 0.004);
      v.env.gain.cancelScheduledValues(ts);
      v.env.gain.setTargetAtTime(0, ts, 0.001);
      t0 = t + 0.004;
    }
    const dest = o.dest ?? this.sfx;
    this.route(v, dest);
    v.filter.type = o.type ?? 'bandpass';
    v.filter.Q.cancelScheduledValues(t0);
    v.filter.Q.setValueAtTime(o.q ?? 1, t0);
    v.filter.frequency.cancelScheduledValues(t0);
    v.filter.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 !== undefined) v.filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.dur);
    const a = Math.min(Math.max(o.attack ?? 0.005, MIN_ATTACK), o.dur * 0.5);
    const e = v.env.gain;
    e.cancelScheduledValues(t0);
    e.setValueAtTime(0, t0);
    e.linearRampToValueAtTime(Math.max(FLOOR * 2, o.peak * this.level), t0 + a);
    e.exponentialRampToValueAtTime(FLOOR, t0 + o.dur);
    e.linearRampToValueAtTime(0, t0 + o.dur + 0.004);
    v.pan.pan.setValueAtTime(Math.max(-1, Math.min(1, o.pan ?? 0)), t0);
    v.send.gain.setValueAtTime(o.send ?? 0, t0);
    v.busyUntil = t0 + o.dur + 0.01;
    v.startedAt = t0;
    this.counters.played++;
    if (this.isSfxDest(dest)) this.registerLoad(t0, 0.15 + Math.min(0.4, o.peak * 0.5));
  }

  /** Enveloped oscillator with an exponential pitch glide (pooled voice). */
  osc(o: OscOpts): void {
    if (!this.built) return;
    const t = o.time ?? this.now;
    const { v, stolen } = this.pick(this.oscPool, t);
    let t0 = t;
    if (stolen) {
      this.counters.stolen++;
      const ts = Math.max(this.rawContext.currentTime, t - 0.004);
      v.env.gain.cancelScheduledValues(ts);
      v.env.gain.setTargetAtTime(0, ts, 0.001);
      t0 = t + 0.004;
    }
    const dest = o.dest ?? this.sfx;
    this.route(v, dest);
    v.osc.type = o.type ?? 'sine';
    v.osc.detune.cancelScheduledValues(t0);
    v.osc.detune.setValueAtTime(o.detune ?? 0, t0);
    v.osc.frequency.cancelScheduledValues(t0);
    v.osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 !== undefined && o.f1 !== o.f0) v.osc.frequency.exponentialRampToValueAtTime(Math.max(10, o.f1), t0 + o.dur);
    const a = Math.min(Math.max(o.attack ?? 0.004, MIN_ATTACK), o.dur * 0.5);
    const e = v.env.gain;
    e.cancelScheduledValues(t0);
    e.setValueAtTime(0, t0);
    e.linearRampToValueAtTime(Math.max(FLOOR * 2, o.peak * this.level), t0 + a);
    e.exponentialRampToValueAtTime(FLOOR, t0 + o.dur);
    e.linearRampToValueAtTime(0, t0 + o.dur + 0.004);
    v.pan.pan.setValueAtTime(Math.max(-1, Math.min(1, o.pan ?? 0)), t0);
    v.send.gain.setValueAtTime(o.send ?? 0, t0);
    v.busyUntil = t0 + o.dur + 0.01;
    v.startedAt = t0;
    this.counters.played++;
    if (this.isSfxDest(dest)) this.registerLoad(t0, 0.1 + Math.min(0.4, o.peak * 0.4));
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
