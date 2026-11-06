import * as Tone from 'tone';
import { TIERS } from '../game/constants';
import type { AudioEngine } from './audio';

/** A minor, Am - F - C - G (8-bar phrase = the 4-chord loop twice). */
const CHORDS: readonly (readonly number[])[] = [
  [57, 60, 64], // Am
  [57, 60, 65], // F
  [55, 60, 64], // C
  [55, 59, 62], // G
];
const ROOTS = [33, 29, 36, 31];
/** Lead motif, 8th-note grid, 0 = rest. */
const LEAD: readonly (readonly number[])[] = [
  [76, 0, 76, 74, 72, 0, 69, 0],
  [77, 0, 77, 76, 72, 0, 69, 0],
  [79, 0, 76, 0, 72, 76, 79, 0],
  [74, 0, 74, 76, 79, 0, 76, 74],
  [76, 0, 76, 79, 81, 0, 79, 76],
  [77, 76, 72, 0, 77, 0, 81, 0],
  [79, 0, 76, 72, 76, 0, 79, 84],
  [83, 0, 79, 0, 74, 0, 79, 0],
];
const ARP_PATTERN = [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 5, 4, 3, 2];
const ACID_PATTERN = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1];
const ACID_NOTES = [0, 0, 12, 0, 0, 3, 0, 7, 0, 0, 12, 0, 10, 0, 7, 0];

/** Low-pass cutoff of the music bus per tier (opens as the track builds). */
const TIER_LP = [2400, 3600, 5600, 8200, 11000, 16000];
const OD_LP = 20000;
const FOCUS_BPM_MUL = 0.55;
const RISER_MIN = 0.45;

type Mode = 'off' | 'title' | 'play' | 'over';

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

interface Pending {
  tier: number;
  stepIdx: number;
  bpm: number;
}

/**
 * Adaptive layered BGM driven by Tone.Transport (16th-note grid).
 * Layers stack with the tier; a tier-up is a "drop" on the next bar line; OVERDRIVE opens everything;
 * FOCUS slows the Transport; NITRO lifts the highpass and runs 16th hats; death is a tape stop.
 */
export class Music {
  private built = false;
  private mode: Mode = 'off';
  private tier = 1;
  private od = false;
  private nitro = false;
  private focus = false;
  private pending: Pending | null = null;
  private step = 0;
  private lastStep = 0;
  private lastStepTime = 0;
  private baseBpm = 120;
  private repeatId: number | null = null;
  private token = 0;
  private diveTimer: number | null = null;
  private wantMode: Mode = 'off';
  private readonly kicks = [0, 0, 0, 0, 0, 0, 0, 0];
  private kickIdx = 0;
  errors = 0;

  // instruments (created lazily after the first user gesture)
  private kickSub!: Tone.MembraneSynth;
  private pad!: Tone.PolySynth;
  private chord!: Tone.PolySynth;
  private arp!: Tone.Synth;
  private lead!: Tone.MonoSynth;
  private lead2!: Tone.MonoSynth;
  private subBass!: Tone.MonoSynth;
  private rollBass!: Tone.MonoSynth;
  private acid!: Tone.MonoSynth;
  private reese!: Tone.MonoSynth;
  private voices: { set(o: object): unknown }[] = [];
  // synth fallbacks for missing drum samples
  private fbKick!: Tone.MembraneSynth;
  private fbHat!: Tone.NoiseSynth;
  private fbOpen!: Tone.NoiseSynth;
  private fbClap!: Tone.NoiseSynth;
  private fbSnare!: Tone.NoiseSynth;
  private fbRoll!: Tone.NoiseSynth;
  private fbCrash!: Tone.NoiseSynth;

  constructor(private readonly eng: AudioEngine) {}

  private build(): void {
    if (this.built) return;
    this.eng.build();
    this.built = true;
    const e = this.eng;
    this.kickSub = new Tone.MembraneSynth({
      pitchDecay: 0.035,
      octaves: 5,
      envelope: { attack: 0.001, decay: 0.28, sustain: 0, release: 0.05 },
      volume: -8,
    }).connect(e.drums);
    this.fbKick = new Tone.MembraneSynth({
      pitchDecay: 0.05,
      octaves: 6,
      envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.05 },
      volume: 0,
    }).connect(e.drums);

    const padLP = new Tone.Filter(1100, 'lowpass');
    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 28 },
      envelope: { attack: 0.5, decay: 0.4, sustain: 0.8, release: 1.4 },
      volume: -24,
    });
    this.pad.maxPolyphony = 20;
    this.pad.chain(padLP, e.scMusic);

    const chordLP = new Tone.Filter(4200, 'lowpass');
    this.chord = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 42 },
      envelope: { attack: 0.004, decay: 0.22, sustain: 0.05, release: 0.12 },
      volume: -20,
    });
    this.chord.maxPolyphony = 20;
    this.chord.chain(chordLP, e.scMusic);

    this.arp = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.002, decay: 0.12, sustain: 0, release: 0.05 },
      volume: -25,
    });
    const arpLP = new Tone.Filter(3800, 'lowpass');
    this.arp.chain(arpLP, e.music);
    arpLP.connect(e.delaySend);

    this.lead = new Tone.MonoSynth({
      oscillator: { type: 'fatsawtooth', count: 2, spread: 24 },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.55, release: 0.18 },
      filter: { Q: 2, type: 'lowpass', rolloff: -12 },
      filterEnvelope: { attack: 0.01, decay: 0.25, sustain: 0.5, release: 0.2, baseFrequency: 900, octaves: 2.6 },
      portamento: 0.045,
      volume: -21,
    });
    this.lead.connect(e.music);
    this.lead.connect(e.delaySend);
    this.lead2 = new Tone.MonoSynth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.15 },
      filter: { Q: 1, type: 'lowpass', rolloff: -12 },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.2, baseFrequency: 1400, octaves: 2 },
      portamento: 0.03,
      volume: -29,
    });
    this.lead2.connect(e.music);

    this.subBass = new Tone.MonoSynth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0.9, release: 0.1 },
      filter: { Q: 0.5, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.001, decay: 0.1, sustain: 1, release: 0.1, baseFrequency: 160, octaves: 0.5 },
      volume: -6,
    });
    this.subBass.connect(e.scBass);

    this.rollBass = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.004, decay: 0.12, sustain: 0.25, release: 0.04 },
      filter: { Q: 2.5, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.002, decay: 0.12, sustain: 0.1, release: 0.05, baseFrequency: 160, octaves: 3 },
      volume: -14,
    });
    this.rollBass.connect(e.scBass);

    this.acid = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.002, decay: 0.16, sustain: 0.15, release: 0.04 },
      filter: { Q: 11, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.001, decay: 0.2, sustain: 0.05, release: 0.05, baseFrequency: 220, octaves: 3.4 },
      volume: -15,
    });
    this.acid.connect(e.scBass);

    const reeseDist = new Tone.Distortion({ distortion: 0.5, wet: 0.8 });
    this.reese = new Tone.MonoSynth({
      oscillator: { type: 'fatsawtooth', count: 3, spread: 46 },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.1 },
      filter: { Q: 3, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.45, release: 0.2, baseFrequency: 260, octaves: 3 },
      volume: -17,
    });
    this.reese.chain(reeseDist, e.scBass);

    // synth fallbacks (only used when a drum sample failed to load)
    const noiseVoice = (decay: number, filter: BiquadFilterType, freq: number, vol: number, q = 1): Tone.NoiseSynth => {
      const f = new Tone.Filter({ type: filter, frequency: freq, Q: q });
      const n = new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.001, decay, sustain: 0, release: 0.02 },
        volume: vol,
      });
      n.chain(f, e.drums);
      return n;
    };
    this.fbHat = noiseVoice(0.04, 'highpass', 7800, -20);
    this.fbOpen = noiseVoice(0.16, 'highpass', 7000, -22);
    this.fbClap = noiseVoice(0.14, 'bandpass', 1800, -10, 0.8);
    this.fbSnare = noiseVoice(0.16, 'bandpass', 2200, -9, 0.7);
    this.fbRoll = noiseVoice(0.1, 'bandpass', 2400, -14, 0.7);
    this.fbCrash = noiseVoice(1.1, 'highpass', 4200, -14);

    this.voices = [this.pad, this.chord, this.arp, this.lead, this.lead2, this.subBass, this.rollBass, this.acid, this.reese];
  }

  get bpm(): number {
    return Tone.getTransport().bpm.value;
  }

  // ------------------------------------------------------------------ control

  /** Chill title loop (call after the first user gesture). */
  startTitle(): void {
    this.wantMode = 'title';
    if (this.eng.forceRunning) {
      this.begin('title', 84);
      return;
    }
    void this.eng.unlock().then(() => {
      if (this.wantMode === 'title' && this.mode !== 'title') this.begin('title', 84);
    });
  }

  /** Real game start: Tier 1 comes in with GO. */
  start(tier: number): void {
    this.wantMode = 'play';
    this.tier = tier;
    this.od = false;
    this.nitro = false;
    this.focus = false;
    this.build();
    this.eng.musicHP.frequency.value = 20;
    this.begin('play', TIERS[tier - 1].bpm);
  }

  /** Quiet pad loop for the game-over screen. */
  startGameOver(): void {
    this.wantMode = 'over';
    this.begin('over', 62);
  }

  stop(): void {
    this.wantMode = 'off';
    this.token++;
    this.halt();
    this.mode = 'off';
  }

  /** Death: tape stop. Tempo and pitch fall away over 0.6 s, then silence. */
  cut(): void {
    if (this.mode !== 'play') return;
    if (!this.built) return;
    const tok = ++this.token;
    this.wantMode = 'off';
    const tr = Tone.getTransport();
    tr.bpm.cancelScheduledValues(0);
    tr.bpm.rampTo(14, 0.6);
    this.eng.muffleDeath();
    const t0 = performance.now();
    if (this.diveTimer !== null) window.clearInterval(this.diveTimer);
    this.diveTimer = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / 600);
      this.setDetune(-2400 * k * k);
      if (k >= 1 && this.diveTimer !== null) {
        window.clearInterval(this.diveTimer);
        this.diveTimer = null;
      }
    }, 30);
    window.setTimeout(() => {
      if (tok === this.token) {
        this.halt();
        this.mode = 'off';
      }
    }, 700);
  }

  setTier(t: number): void {
    this.tier = t;
  }

  /** Tier-up = drop on the next bar line: snare roll + riser, then crash + sub boom and the new layers. */
  tierUp(tier: number): void {
    if (this.mode !== 'play' || !this.eng.running) {
      this.tier = tier;
      return;
    }
    const ctxNow = this.eng.rawContext.currentTime;
    const stepDur = this.stepDur();
    let idx = (Math.floor(this.lastStep / 16) + 1) * 16;
    let dropTime = this.lastStepTime + (idx - this.lastStep) * stepDur;
    if (dropTime - ctxNow < RISER_MIN) {
      idx += 16;
      dropTime += 16 * stepDur;
    }
    this.pending = { tier, stepIdx: idx, bpm: TIERS[tier - 1].bpm };
    const dur = dropTime - ctxNow;
    this.buildUp(ctxNow + 0.005, dropTime, dur);
  }

  setOverdrive(on: boolean): void {
    if (this.od === on || !this.built) return;
    this.od = on;
    const lp = this.eng.musicLP.frequency;
    if (on) lp.rampTo(OD_LP, 0.25);
    else lp.rampTo(TIER_LP[this.tier - 1], 0.9);
    this.eng.musicDist.wet.rampTo(on || this.tier >= 6 ? 0.28 : 0, 0.2);
  }

  setNitro(on: boolean): void {
    this.nitro = on;
    if (!this.built) return;
    this.eng.musicHP.frequency.rampTo(on ? 280 : 20, on ? 0.12 : 0.25);
  }

  /** FOCUS: Transport to 55 % (slow motion). The engine handles the 700 Hz lowpass and reverb. */
  setFocus(on: boolean): void {
    this.focus = on;
    this.applyBpm(on ? 0.12 : 0.2);
  }

  /** 0..1 pulse that peaks on each kick drum. */
  beatPulse(): number {
    if (this.mode !== 'play') return 0;
    const now = this.eng.rawContext.currentTime;
    let latest = -1;
    for (let i = 0; i < this.kicks.length; i++) {
      const k = this.kicks[i];
      if (k <= now && k > latest) latest = k;
    }
    if (latest < 0) return 0;
    return Math.exp(-(now - latest) * 7);
  }

  // ------------------------------------------------------------------ transport

  private stepDur(): number {
    return 60 / this.bpm / 4;
  }

  private applyBpm(ramp: number): void {
    const tr = Tone.getTransport();
    tr.bpm.cancelScheduledValues(0);
    tr.bpm.rampTo(this.baseBpm * (this.focus ? FOCUS_BPM_MUL : 1), ramp);
  }

  private setDetune(cents: number): void {
    for (const v of this.voices) v.set({ detune: cents });
  }

  private halt(): void {
    const tr = Tone.getTransport();
    if (this.diveTimer !== null) {
      window.clearInterval(this.diveTimer);
      this.diveTimer = null;
    }
    if (this.repeatId !== null) {
      tr.clear(this.repeatId);
      this.repeatId = null;
    }
    tr.stop();
    tr.cancel(0);
    for (const v of this.voices) {
      const r = v as unknown as { releaseAll?: () => void; triggerRelease?: () => void };
      try {
        r.releaseAll?.();
        r.triggerRelease?.();
      } catch {
        /* nothing playing */
      }
    }
  }

  private begin(mode: Mode, bpm: number): void {
    if (!this.eng.running) {
      void this.eng.unlock().then(() => {
        if (this.wantMode === mode) this.begin(mode, bpm);
      });
      return;
    }
    this.build();
    this.token++;
    this.halt();
    const e = this.eng;
    const tr = Tone.getTransport();
    this.mode = mode;
    this.baseBpm = bpm;
    this.pending = null;
    this.step = 0;
    this.lastStep = 0;
    this.kicks.fill(0);
    this.setDetune(0);
    e.restoreFilter();
    tr.bpm.cancelScheduledValues(0);
    tr.bpm.value = bpm * (this.focus && mode === 'play' ? FOCUS_BPM_MUL : 1);
    tr.position = 0;
    e.scBass.gain.cancelScheduledValues(0);
    e.scMusic.gain.cancelScheduledValues(0);
    e.scBass.gain.value = 1;
    e.scMusic.gain.value = 1;
    e.musicLP.frequency.cancelScheduledValues(0);
    e.musicLP.frequency.value = mode === 'play' ? TIER_LP[this.tier - 1] : 2600;
    e.musicDist.wet.value = mode === 'play' && this.tier >= 6 ? 0.28 : 0;
    this.repeatId = tr.scheduleRepeat((t) => this.onStep(t), '16n');
    tr.start('+0.05');
  }

  private onStep(time: number): void {
    const s = this.step++;
    this.lastStep = s;
    this.lastStepTime = time;
    try {
      if (this.mode === 'play') this.playStep(time, s);
      else if (this.mode === 'title') this.titleStep(time, s);
      else if (this.mode === 'over') this.overStep(time, s);
    } catch (err) {
      this.errors++;
      console.debug('[music] step failed', err);
    }
  }

  // ------------------------------------------------------------------ voices

  private kick(time: number, vel = 1): void {
    const e = this.eng;
    const ok = e.play('kickHeavy', { time, db: 2 + 6 * (vel - 1), dest: e.drums });
    if (!ok) this.fbKick.triggerAttackRelease(46, 0.25, time, vel);
    else this.kickSub.triggerAttackRelease(44, 0.22, time, vel);
    e.duck(time, 0.2, Math.min(0.26, this.stepDur() * 3.4));
    this.kicks[this.kickIdx++ % this.kicks.length] = time;
  }

  private hat(time: number, open: boolean, db: number): void {
    const e = this.eng;
    const ok = open
      ? e.play('hatOpen', { time, db, dur: 0.14, fade: 0.05, dest: e.drums, pan: 0.18 })
      : e.play('hatClosed', { time, db, dest: e.drums, pan: -0.12 });
    if (!ok) (open ? this.fbOpen : this.fbHat).triggerAttackRelease(open ? 0.14 : 0.04, time, 0.7);
  }

  private hat16(time: number, db: number): void {
    const e = this.eng;
    if (!e.play('hat16', { time, db, dest: e.drums, pan: 0.2 })) this.fbHat.triggerAttackRelease(0.03, time, 0.4);
  }

  private clap(time: number, db = 0): void {
    const e = this.eng;
    const a = e.play('clap', { time, db, dest: e.drums, send: 0.1 });
    e.play('clapBig', { time: time + 0.004, db: db - 5, dest: e.drums });
    if (!a) this.fbClap.triggerAttackRelease(0.14, time, 0.8);
  }

  private snare(time: number, db: number, fb: Tone.NoiseSynth = this.fbSnare): void {
    const e = this.eng;
    if (!e.play('snare', { time, db, dest: e.drums, send: 0.08 })) fb.triggerAttackRelease(0.14, time, 0.7);
  }

  private crash(time: number, db = 0): void {
    const e = this.eng;
    if (!e.play('crashBig', { time, db: db + 3, dest: e.drums, send: 0.15 })) {
      if (!e.play('crash', { time, db: db + 6, dest: e.drums, send: 0.15 })) this.fbCrash.triggerAttackRelease(1.1, time, 0.8);
    }
  }

  private subBoom(time: number): void {
    const e = this.eng;
    if (!e.play('subDrop', { time, db: 2, dest: e.drums })) this.fbKick.triggerAttackRelease(34, 0.9, time, 1);
  }

  /** Snare roll + noise riser from `t0` to the drop at `t1`; filter closes during the build. */
  private buildUp(t0: number, t1: number, dur: number): void {
    const e = this.eng;
    const lp = e.musicLP.frequency;
    lp.cancelScheduledValues(t0);
    lp.setValueAtTime(Math.max(300, lp.value as number), t0);
    lp.exponentialRampToValueAtTime(420, t1 - 0.02);
    // noise riser + pitch riser on the drum bus (BGM-scaled, never sidechained)
    e.noise({ time: t0, dur, type: 'bandpass', f0: 300, f1: 9500, q: 1.6, peak: 0.34, attack: dur * 0.85, dest: e.drums, send: 0.1 });
    e.osc({ time: t0, type: 'sawtooth', f0: 110, f1: 1500, dur, peak: 0.07, attack: dur * 0.9, dest: e.drums });
    // snare roll accelerating from 8ths to 32nds
    const sd = this.stepDur();
    let t = t0 + 0.02;
    let k = 0;
    let gap = sd * 2;
    while (t < t1 - 0.03) {
      const p = (t - t0) / dur;
      this.snare(t, -16 + 12 * p, this.fbRoll);
      if (p > 0.5) e.play('snareRoll', { time: t, db: -12 + 6 * p, dest: e.drums });
      t += gap;
      gap = Math.max(sd * 0.5, gap * 0.93);
      k++;
    }
    void k;
  }

  // ------------------------------------------------------------------ patterns

  private effTier(): number {
    return this.od ? 6 : this.tier;
  }

  private playStep(time: number, s: number): void {
    const e = this.eng;
    const s16 = s & 15;
    const bar = s >> 4;
    const b8 = bar & 7;
    const ch = bar & 3;
    const sd = this.stepDur();

    // ---- tier drop ----
    if (this.pending && s >= this.pending.stepIdx) {
      const p = this.pending;
      this.pending = null;
      this.tier = p.tier;
      this.baseBpm = p.bpm;
      // Tone warns when untimed Param changes are made inside a Transport callback: defer out of it
      window.setTimeout(() => this.applyBpm(0.02), 0);
      e.musicLP.frequency.cancelScheduledValues(time);
      e.musicLP.frequency.setValueAtTime(this.od ? OD_LP : TIER_LP[p.tier - 1], time);
      e.musicDist.wet.setValueAtTime(this.od || p.tier >= 6 ? 0.28 : 0, time);
      this.crash(time, 0);
      this.subBoom(time);
      this.clap(time, -2);
      e.duck(time, 0.1, 0.35);
    }
    const L = this.effTier();
    const bassMidi = ROOTS[ch];
    const chord = CHORDS[ch];

    // ---- L1: heavy kick, sub bass, filtered pad ----
    if (s16 % 4 === 0) this.kick(time);
    if (s16 === 0 || s16 === 8) {
      this.subBass.triggerAttackRelease(mtof(bassMidi), sd * 7.4, time, 0.9);
    }
    if (s16 === 0) {
      this.pad.triggerAttackRelease(
        [...chord, chord[0] + 12].map(mtof),
        sd * 15.5,
        time,
        0.7,
      );
    }

    // ---- L2: hats, off-beat rolling bass, claps on 2 and 4 ----
    if (L >= 2) {
      if (s16 % 4 === 2) this.hat(time, true, -2);
      if (s16 === 4 || s16 === 12) this.clap(time, 0);
      if (L < 5 && s16 % 4 !== 0) {
        const note = mtof(bassMidi + 12 + (s16 % 8 === 7 ? 7 : 0));
        this.rollBass.triggerAttackRelease(note, sd * 0.8, time, s16 % 4 === 2 ? 0.9 : 0.6);
      }
    }
    if ((L >= 4 && s16 % 2 === 1) || (this.nitro && s16 % 2 === 1)) this.hat16(time, s16 % 4 === 3 ? -2 : -6);
    if (L >= 2 && this.nitro && s16 % 4 === 0) this.hat(time, false, -4);
    if (L >= 6 && s16 % 2 === 0 && s16 % 4 !== 2) this.hat16(time, -5);

    // ---- L3: supersaw stabs + ping-pong arp ----
    if (L >= 3) {
      if (s16 === 0 || s16 === 3 || s16 === 6 || s16 === 10 || s16 === 12) {
        this.chord.triggerAttackRelease(chord.map((m) => mtof(m + 12)), sd * 1.6, time, s16 === 0 ? 0.85 : 0.65);
      }
      const tones = [chord[0], chord[1], chord[2], chord[0] + 12, chord[1] + 12, chord[2] + 12];
      const n = tones[ARP_PATTERN[s16] % tones.length] + 12;
      this.arp.triggerAttackRelease(mtof(n), sd * 0.9, time, s16 % 4 === 0 ? 0.9 : 0.55);
    }

    // ---- L4: lead melody + fills ----
    if (L >= 4) {
      if (s16 % 2 === 0) {
        const note = LEAD[b8][s16 >> 1];
        if (note) {
          this.lead.triggerAttackRelease(mtof(note), sd * 1.8, time, 0.85);
          if (L >= 6) this.lead2.triggerAttackRelease(mtof(note + 12), sd * 1.8, time, 0.7);
        }
      }
      if ((b8 === 3 || b8 === 7) && s16 >= 12) {
        this.snare(time, -8 + (s16 - 12) * 2.5);
      }
    }

    // ---- L5: acid bass, phrase crash ----
    if (L >= 5) {
      if (ACID_PATTERN[s16]) {
        const sweep = 0.5 + 0.5 * Math.sin(s * 0.055);
        this.acid.filterEnvelope.baseFrequency = 140 + 1500 * sweep * sweep;
        this.acid.triggerAttackRelease(mtof(bassMidi + 12 + ACID_NOTES[s16]), sd * 0.85, time, s16 % 4 === 0 ? 1 : 0.7);
      }
      if (s16 === 0 && b8 === 0 && s > 0) this.crash(time, -3);
    }

    // ---- OVERDRIVE: reese bass on the beat ----
    if (this.od && s16 % 2 === 0) {
      this.reese.triggerAttackRelease(mtof(bassMidi + (s16 % 8 === 6 ? 7 : 0)), sd * 1.7, time, 0.9);
    }
  }

  private titleStep(time: number, s: number): void {
    const e = this.eng;
    const s16 = s & 15;
    const bar = s >> 4;
    const ch = (bar >> 1) & 3;
    const chord = CHORDS[ch];
    const sd = this.stepDur();
    if (s16 === 0 || s16 === 10) {
      if (!e.play('kickClub', { time, db: -10, dest: e.drums })) this.fbKick.triggerAttackRelease(48, 0.2, time, 0.5);
      this.kicks[this.kickIdx++ % this.kicks.length] = time;
      e.duck(time, 0.45, 0.3);
    }
    if (s16 === 4 || s16 === 12) this.hat(time, false, -4);
    if (s16 === 8 && (bar & 1) === 1) this.hat(time, true, -8);
    if (s16 === 0 && (bar & 1) === 0) {
      this.pad.triggerAttackRelease([...chord, chord[0] + 12].map(mtof), sd * 31, time, 0.8);
      this.subBass.triggerAttackRelease(mtof(ROOTS[ch]), sd * 15, time, 0.6);
    }
    if (s16 % 2 === 0 && (s16 >> 1) % 3 !== 1) {
      const tones = [chord[0], chord[1], chord[2], chord[1]];
      this.arp.triggerAttackRelease(mtof(tones[(s16 >> 2) % 4] + 12), sd * 1.6, time, 0.4);
    }
  }

  private overStep(time: number, s: number): void {
    const s16 = s & 15;
    const bar = s >> 4;
    const ch = (bar >> 1) & 3;
    const chord = CHORDS[ch];
    const sd = this.stepDur();
    if (s16 === 0 && (bar & 1) === 0) {
      this.pad.triggerAttackRelease([...chord, chord[0] + 12].map(mtof), sd * 31, time, 0.55);
    }
    if (s16 === 8 && (bar & 1) === 1) {
      this.arp.triggerAttackRelease(mtof(chord[2] + 12), sd * 3, time, 0.3);
    }
  }
}
