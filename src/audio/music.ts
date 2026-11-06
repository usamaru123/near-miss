import * as Tone from 'tone';
import type { AudioEngine } from './audio';
import type { SectionName } from '../game/constants';

/*
 * Adaptive BGM (DESIGN 12.3 / 15.1 / 16). Drum'n'bass / hard-trance racing feel from tier 1:
 * four-on-the-floor kick, 16th hats and a short-gated, sidechained, rolling 16th bass.
 *
 * Rules that keep the low end clean (DESIGN 16.1):
 *  - nothing below ~120 Hz is ever sustained: the kick is a tight 909-style hit (gated body, hard fade),
 *    the bass lives above 170 Hz as short plucks, pads and wind are high-passed;
 *  - long 808 booms are one-shot drop impacts only, never on the beat.
 *
 * The tempo is NOT owned here: the sim's beat clock is the master (see sync()).
 */

/** A minor, Am - F - C - G: pad / stab voicings. */
const CHORDS: readonly (readonly number[])[] = [
  [57, 60, 64], // Am
  [57, 60, 65], // F
  [55, 60, 64], // C
  [55, 59, 62], // G
];
/** Rolling-bass roots (A3 F3 C4 G3): fundamentals >= 175 Hz. */
const BASS_ROOT = [57, 53, 60, 55];
const A_MINOR = [0, 2, 3, 5, 7, 8, 10];
/** Scale degree of each chord root. */
const CHORD_DEG = [0, 5, 2, 6];
const R = null;

/** Rolling 16th bass per 8-bar phrase variant: semitones over the root, null = rest (kick steps are rests). */
const BASS_VARIANTS: readonly (readonly (number | null)[])[] = [
  [R, 0, 12, 0, R, 0, 12, 7, R, 0, 12, 0, R, 12, 7, 10],
  [R, 0, 0, 12, R, 7, 0, 12, R, 0, 0, 12, R, 3, 7, 12],
  [R, 12, 0, 7, R, 12, 0, 10, R, 12, 0, 7, R, 15, 12, 10],
  [R, 0, 7, 0, R, 12, 10, 7, R, 0, 7, 12, R, 15, 12, 19],
];
/** Arp shapes (indices into the six chord tones), one per phrase variant. */
const ARP_VARIANTS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3],
  [0, 2, 1, 3, 2, 4, 3, 5, 4, 3, 5, 4, 2, 3, 1, 2],
  [0, 0, 2, 2, 1, 1, 3, 3, 2, 2, 4, 4, 3, 3, 5, 5],
  [5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0],
];
/** Lead per variant: 4 bar shapes of 8 eighth-note slots, as scale-degree offsets from the chord root. */
const LEAD_VARIANTS: readonly (readonly (readonly (number | null)[])[])[] = [
  [
    [0, R, 2, R, 4, R, 2, 3],
    [4, R, 4, 2, 0, R, 2, R],
    [0, R, 2, 4, 7, R, 4, 2],
    [4, R, 5, 4, 2, R, 0, R],
  ],
  [
    [4, 4, R, 2, 4, R, 5, R],
    [2, R, 4, R, 5, 4, 2, R],
    [4, R, 7, R, 4, 5, 4, 2],
    [5, R, 4, 2, 0, R, 2, 4],
  ],
  [
    [0, 2, 4, 7, R, 4, 2, R],
    [7, R, 5, R, 4, 2, 4, R],
    [0, 2, 4, 7, 9, R, 7, 4],
    [7, R, 9, 7, 4, R, 2, 0],
  ],
  [
    [7, R, 7, 4, R, 4, 2, 4],
    [5, R, 5, 2, R, 2, 0, 2],
    [4, R, 7, 9, R, 7, 4, R],
    [9, 7, 4, R, 7, 4, 2, 0],
  ],
];

/** Low-pass cutoff of the music bus per tier (opens as the track builds). */
const TIER_LP = [4200, 6000, 8200, 11000, 14000, 18000];
const OD_LP = 20000;
const RISER_MIN = 0.45;
/** Tempo trim limits while pulling the Transport onto the sim beat clock. */
const SYNC_MAX_TRIM = 0.03;
const SYNC_GAIN = 0.4;
const SYNC_RESYNC_BEATS = 1;
const SYNC_UPDATE_S = 0.05;
const STEP_TICKS_DIV = 4;

/** ZONE hook: scale-degree offsets from the chord root, one 16th step each (null = rest). Rises to the 5th and answers. */
const ZONE_HOOK: readonly (readonly (number | null)[])[] = [
  [7, R, R, 9, R, 7, R, 4, 5, R, R, 4, R, 2, R, R],
  [9, R, R, 11, R, 9, R, 7, 7, R, 9, R, 7, R, 4, R],
  [7, R, R, 9, R, 11, R, 14, 12, R, R, 11, R, 9, R, R],
  [14, R, 12, R, 11, R, 9, R, 7, R, 9, R, 11, R, 12, R],
];
/** Vocal-chop steps (16ths) and the formant vowels [F1, F2] in Hz (a, o, e, i). */
const VOX_STEPS = [2, 3, 6, 10, 11, 14];
const VOWELS: readonly (readonly [number, number])[] = [
  [800, 1150],
  [450, 800],
  [530, 1840],
  [270, 2290],
];

type Mode = 'off' | 'title' | 'play' | 'over';

/**
 * Per-biome timbre set (DESIGN 20.1): arpeggio and lead voices and the pad's texture. Applied when the warp gate is passed.
 * Every set keeps the low-end rules: pads stay high-passed, nothing sustained below 250 Hz.
 */
interface Timbre {
  arp: { type: string; width?: number; decay: number; lp: number };
  lead: { type: string; spread: number; base: number };
  pad: { type: string; lp: number };
}
const TIMBRES: readonly Timbre[] = [
  { arp: { type: 'square', decay: 0.1, lp: 4600 }, lead: { type: 'fatsawtooth', spread: 24, base: 1100 }, pad: { type: 'fatsawtooth', lp: 1400 } }, // NEON CITY
  { arp: { type: 'pulse', width: 0.25, decay: 0.09, lp: 5400 }, lead: { type: 'fatsquare', spread: 18, base: 1300 }, pad: { type: 'fatsquare', lp: 1700 } }, // HEX GRID
  { arp: { type: 'triangle', decay: 0.2, lp: 8200 }, lead: { type: 'fatsine', spread: 20, base: 1500 }, pad: { type: 'fatsine', lp: 2800 } }, // CRYSTAL CAVE
  { arp: { type: 'sawtooth', decay: 0.05, lp: 3200 }, lead: { type: 'fatsquare', spread: 34, base: 900 }, pad: { type: 'fatsquare', lp: 1100 } }, // DATA STREAM
  { arp: { type: 'sawtooth', decay: 0.12, lp: 3800 }, lead: { type: 'fatsawtooth', spread: 62, base: 800 }, pad: { type: 'fatsawtooth', lp: 900 } }, // INFERNO
  { arp: { type: 'sine', decay: 0.16, lp: 6200 }, lead: { type: 'fatsine', spread: 36, base: 1700 }, pad: { type: 'fatsawtooth', lp: 3400 } }, // VOID
];

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const scaleNote = (deg: number): number => {
  const oct = Math.floor(deg / 7);
  const idx = ((deg % 7) + 7) % 7;
  return 69 + 12 * oct + A_MINOR[idx];
};

interface Pending {
  tier: number;
  stepIdx: number;
}

/**
 * Layers stack with the tier; a tier-up is a "drop" on the next bar line; OVERDRIVE opens everything;
 * NITRO lifts the highpass; death is a tape stop. Tone.Transport is slaved to the sim beat clock.
 */
export class Music {
  private built = false;
  private mode: Mode = 'off';
  private tier = 1;
  private od = false;
  private nitro = false;
  private pending: Pending | null = null;
  private step = 0;
  private lastStep = 0;
  private lastStepTime = 0;
  private repeatId: number | null = null;
  private token = 0;
  private diveTimer: number | null = null;
  private wantMode: Mode = 'off';
  private readonly kicks = [0, 0, 0, 0, 0, 0, 0, 0];
  private kickIdx = 0;
  /** diagnostics: called with the audio time of every BGM kick */
  onKick: ((t: number) => void) | null = null;
  errors = 0;

  // tempo slaving state
  private lastTempoSet = 0;
  private lastTempo = 0;
  /** last measured sim-minus-music offset in beats (diagnostics) */
  syncError = 0;
  hardResyncs = 0;

  // instruments (created lazily after the first user gesture)
  private kickSub!: Tone.MembraneSynth;
  private pad!: Tone.PolySynth;
  private chord!: Tone.PolySynth;
  private arp!: Tone.Synth;
  private lead!: Tone.MonoSynth;
  private lead2!: Tone.MonoSynth;
  private bass!: Tone.MonoSynth;
  private acid!: Tone.MonoSynth;
  private growl!: Tone.MonoSynth;
  // style layer + ZONE (DESIGN 18.3)
  private shim!: Tone.Synth;
  private zoneLead!: Tone.MonoSynth;
  private vox!: Tone.MonoSynth;
  private voxF1!: Tone.Filter;
  private voxF2!: Tone.Filter;
  private styleRank = 0;
  private zone = false;
  // course (DESIGN 20): biome timbre and the section the sim is in
  private biome = 0;
  private sec: SectionName = 'RANDOM';
  private secIdx = 0;
  private secBars = 8;
  /** 16th step on which the current section (= BGM phrase) began, and the previous one (steps already scheduled use it) */
  private anchor = 0;
  private prevAnchor = 0;
  /** BREATHER dips and DARK darkens the music bus */
  private lpFactor = 1;
  private padLP!: Tone.Filter;
  private arpLP!: Tone.Filter;
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
    // tight 909-style sub: short pitch drop, hard decay (a body of ~130 ms), nothing left before the next beat
    this.kickSub = new Tone.MembraneSynth({
      pitchDecay: 0.03,
      octaves: 3.2,
      envelope: { attack: 0.003, decay: 0.13, sustain: 0, release: 0.02 },
      volume: -9,
    }).connect(e.drums);
    this.fbKick = new Tone.MembraneSynth({
      pitchDecay: 0.03,
      octaves: 4,
      envelope: { attack: 0.003, decay: 0.15, sustain: 0, release: 0.02 },
      volume: -3,
    }).connect(e.drums);

    // pad: high-passed at 250 Hz so it can never add low-end mud
    const padHP = new Tone.Filter({ type: 'highpass', frequency: 250, rolloff: -24 });
    const padLP = new Tone.Filter(1400, 'lowpass');
    this.padLP = padLP;
    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 28 },
      envelope: { attack: 0.5, decay: 0.4, sustain: 0.7, release: 1.2 },
      volume: -28,
    });
    this.pad.maxPolyphony = 24;
    this.pad.chain(padHP, padLP, e.scMusic);

    const chordLP = new Tone.Filter(5200, 'lowpass');
    this.chord = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 42 },
      envelope: { attack: 0.004, decay: 0.16, sustain: 0.04, release: 0.1 },
      volume: -23,
    });
    this.chord.maxPolyphony = 16;
    this.chord.chain(chordLP, e.scMusic);

    this.arp = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.003, decay: 0.1, sustain: 0, release: 0.04 },
      volume: -27,
    });
    const arpLP = new Tone.Filter(4600, 'lowpass');
    this.arpLP = arpLP;
    this.arp.chain(arpLP, e.music);
    arpLP.connect(e.delaySend);

    this.lead = new Tone.MonoSynth({
      oscillator: { type: 'fatsawtooth', count: 2, spread: 24 },
      envelope: { attack: 0.01, decay: 0.18, sustain: 0.5, release: 0.14 },
      filter: { Q: 2, type: 'lowpass', rolloff: -12 },
      filterEnvelope: { attack: 0.01, decay: 0.25, sustain: 0.5, release: 0.2, baseFrequency: 1100, octaves: 2.6 },
      portamento: 0.04,
      volume: -23,
    });
    this.lead.connect(e.music);
    this.lead.connect(e.delaySend);
    this.lead2 = new Tone.MonoSynth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.12 },
      filter: { Q: 1, type: 'lowpass', rolloff: -12 },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.2, baseFrequency: 1400, octaves: 2 },
      portamento: 0.03,
      volume: -31,
    });
    this.lead2.connect(e.music);

    // rolling bass: short plucks, always gated (sustain 0), high-passed so no sub energy exists
    const bassHP = new Tone.Filter({ type: 'highpass', frequency: 140, rolloff: -24 });
    this.bass = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.003, decay: 0.09, sustain: 0, release: 0.02 },
      filter: { Q: 3, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.003, decay: 0.1, sustain: 0.05, release: 0.03, baseFrequency: 260, octaves: 3.4 },
      volume: -13,
    });
    this.bass.chain(bassHP, e.scBass);

    const acidHP = new Tone.Filter({ type: 'highpass', frequency: 140, rolloff: -24 });
    this.acid = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.003, decay: 0.14, sustain: 0, release: 0.03 },
      filter: { Q: 11, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.002, decay: 0.18, sustain: 0.05, release: 0.05, baseFrequency: 300, octaves: 3.4 },
      volume: -16,
    });
    this.acid.chain(acidHP, e.scBass);

    // OVERDRIVE growl: distorted saw stabs (gated, replaces the old sustained reese)
    const growlDist = new Tone.Distortion({ distortion: 0.5, wet: 0.7 });
    const growlHP = new Tone.Filter({ type: 'highpass', frequency: 160, rolloff: -24 });
    this.growl = new Tone.MonoSynth({
      oscillator: { type: 'fatsawtooth', count: 3, spread: 40 },
      envelope: { attack: 0.004, decay: 0.12, sustain: 0, release: 0.03 },
      filter: { Q: 3, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.004, decay: 0.15, sustain: 0.1, release: 0.05, baseFrequency: 420, octaves: 3 },
      volume: -18,
    });
    this.growl.chain(growlDist, growlHP, e.scBass);

    // style layer from SS: a thin 16th shimmer high above the chord (nothing below 700 Hz)
    this.shim = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.003, decay: 0.06, sustain: 0, release: 0.03 },
      volume: -28,
    });
    const shimHP = new Tone.Filter({ type: 'highpass', frequency: 700, rolloff: -12 });
    this.shim.chain(shimHP, e.music);
    shimHP.connect(e.delaySend);

    // ZONE lead hook: gated fat saw, bright, with the delay on top
    const zl = new Tone.Filter({ type: 'highpass', frequency: 320, rolloff: -24 });
    this.zoneLead = new Tone.MonoSynth({
      oscillator: { type: 'fatsawtooth', count: 3, spread: 36 },
      envelope: { attack: 0.004, decay: 0.16, sustain: 0.35, release: 0.08 },
      filter: { Q: 3, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.004, decay: 0.2, sustain: 0.5, release: 0.1, baseFrequency: 1500, octaves: 2.4 },
      portamento: 0.02,
      volume: -24,
    });
    this.zoneLead.chain(zl, e.music);
    zl.connect(e.delaySend);

    // vocal chops: a saw through two parallel formant band-passes (the vowel moves per step)
    this.voxF1 = new Tone.Filter({ type: 'bandpass', frequency: 800, Q: 6 });
    this.voxF2 = new Tone.Filter({ type: 'bandpass', frequency: 1150, Q: 8 });
    const voxMix = new Tone.Gain(1.6);
    const voxHP = new Tone.Filter({ type: 'highpass', frequency: 260, rolloff: -12 });
    this.vox = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.005, decay: 0.09, sustain: 0.2, release: 0.05 },
      filter: { Q: 0.5, type: 'lowpass', rolloff: -12 },
      filterEnvelope: { attack: 0.001, decay: 0.05, sustain: 1, release: 0.05, baseFrequency: 6000, octaves: 0 },
      volume: -21,
    });
    this.vox.connect(this.voxF1);
    this.vox.connect(this.voxF2);
    this.voxF1.connect(voxMix);
    this.voxF2.connect(voxMix);
    voxMix.chain(voxHP, e.music);

    // synth fallbacks (only used when a drum sample failed to load)
    const noiseVoice = (decay: number, filter: BiquadFilterType, freq: number, vol: number, q = 1): Tone.NoiseSynth => {
      const f = new Tone.Filter({ type: filter, frequency: freq, Q: q });
      const n = new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.003, decay, sustain: 0, release: 0.02 },
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

    this.applyBiome();
    this.voices = [this.pad, this.chord, this.arp, this.lead, this.lead2, this.bass, this.acid, this.growl, this.shim, this.zoneLead, this.vox];
  }

  /** Effective Transport tempo (BPM x timeScale while playing). */
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

  /** Real game start: the groove is in from the first beat of GO. The tempo then follows the sim (sync()). */
  start(tier: number, bpm = 140): void {
    this.wantMode = 'play';
    this.tier = tier;
    this.od = false;
    this.nitro = false;
    this.zone = false;
    this.styleRank = 0;
    this.sec = 'RANDOM';
    this.secIdx = 0;
    this.anchor = this.prevAnchor = 0;
    this.lpFactor = 1;
    this.build();
    this.eng.musicHP.frequency.value = 20;
    this.begin('play', bpm);
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

  /** Build every synth up front (called at load time, not in the middle of a run). */
  prepare(): void {
    this.build();
  }

  /** Pause: stop the Transport synchronously, before the context is suspended (no steps can fire half-suspended). */
  pause(): void {
    if (!this.built || this.mode === 'off') return;
    Tone.getTransport().pause();
  }

  /** Continue after pause() once the context runs again. */
  unpause(): void {
    if (!this.built || this.mode === 'off') return;
    Tone.getTransport().start();
  }

  setTier(t: number): void {
    this.tier = t;
  }

  /** Tier-up = drop on the next bar line: snare roll + riser, then crash + one sub boom and the new layers. */
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
    this.pending = { tier, stepIdx: idx };
    const dur = dropTime - ctxNow;
    this.buildUp(ctxNow + 0.005, dropTime, dur);
  }

  setOverdrive(on: boolean): void {
    if (this.od === on || !this.built) return;
    this.od = on;
    const lp = this.eng.musicLP.frequency;
    if (on) lp.rampTo(OD_LP, 0.25);
    else lp.rampTo(this.lpFor(this.tier), 0.9);
    this.eng.musicDist.wet.rampTo(on || this.tier >= 6 ? 0.22 : 0, 0.2);
  }

  private lpFor(tier: number): number {
    return TIER_LP[tier - 1] * this.lpFactor;
  }

  /** Apply the current biome's timbre set to the arp / lead / pad voices (no-op until the synths exist). */
  private applyBiome(): void {
    if (!this.built) return;
    const tb = TIMBRES[this.biome];
    const set = (v: { set(o: object): unknown }, o: object): void => {
      try {
        v.set(o);
      } catch (err) {
        console.debug('[music] timbre', err);
      }
    };
    set(this.arp, { oscillator: tb.arp.width !== undefined ? { type: tb.arp.type, width: tb.arp.width } : { type: tb.arp.type }, envelope: { decay: tb.arp.decay } });
    this.arpLP.frequency.rampTo(tb.arp.lp, 0.3);
    set(this.lead, { oscillator: { type: tb.lead.type, spread: tb.lead.spread }, filterEnvelope: { baseFrequency: tb.lead.base } });
    set(this.pad, { oscillator: { type: tb.pad.type } });
    this.padLP.frequency.rampTo(tb.pad.lp, 0.5);
  }

  /** Warp gate passed: the new biome's timbre set. */
  setBiome(biome: number): void {
    const b = Math.max(0, Math.min(TIMBRES.length - 1, Math.floor(biome)));
    if (b === this.biome) return;
    this.biome = b;
    this.applyBiome();
  }

  /**
   * The sim crossed into a new section (DESIGN 20.3). Sections start on bar lines, so this is also the BGM phrase head:
   * the 8-bar phrase counter restarts here, and the melody variation steps on with every section. BREATHER dips the
   * filter and thins the parts, GAUNTLET rolls the snare, DARK pushes the bass, leaving FLIP rings a reverse cymbal.
   */
  setSection(name: SectionName, intensity: number, bars: number, startBeat: number, idx: number): void {
    const prev = this.sec;
    this.sec = name;
    this.secIdx = idx;
    this.secBars = bars;
    this.prevAnchor = this.anchor;
    this.anchor = Math.max(0, Math.round(startBeat * 4));
    void intensity;
    const factor = name === 'BREATHER' ? 0.55 : name === 'DARK' ? 0.62 : 1;
    if (factor !== this.lpFactor) {
      this.lpFactor = factor;
      if (this.built && this.mode === 'play' && this.eng.running && !this.od && !this.zone) this.eng.musicLP.frequency.rampTo(this.lpFor(this.tier), 0.5);
    }
    if (this.built) {
      this.bass.volume.rampTo(name === 'DARK' ? -9 : -13, 0.4);
      if (prev === 'FLIP' && name !== 'FLIP' && this.mode === 'play' && this.eng.running) this.reverseCymbal(this.eng.now, 0.55);
    }
  }

  /** One bar early: FLIP gets a reverse cymbal that peaks as the camera starts to roll. */
  sectionNotice(name: SectionName, inBeats: number): void {
    if (name !== 'FLIP' || !this.built || this.mode !== 'play' || !this.eng.running) return;
    const wait = Math.max(0, (inBeats * 60) / Math.max(70, this.bpm));
    this.reverseCymbal(this.eng.now + Math.max(0, wait - 0.9), 0.9);
  }

  private reverseCymbal(time: number, dur: number): void {
    const e = this.eng;
    // the reversed crash swells towards its end: play its last `dur` seconds, then it cuts on the beat
    if (!e.play('crash', { time, db: -4, reverse: true, offset: Math.max(0, 2.4 - dur), dur, fade: 0.04, dest: e.drums, send: 0.2 })) {
      e.noise({ time, dur, type: 'highpass', f0: 1800, f1: 9000, q: 0.8, peak: 0.16, attack: dur * 0.9, dest: e.drums, send: 0.2 });
    }
  }

  setNitro(on: boolean): void {
    this.nitro = on;
    if (!this.built) return;
    this.eng.musicHP.frequency.rampTo(on ? 280 : 20, on ? 0.12 : 0.25);
  }

  /** Style rank 0..6: from SS (5) a shimmer layer is added to the groove (DESIGN 18.3). */
  setRank(rank: number): void {
    this.styleRank = rank;
  }

  /**
   * ZONE entry: riser into the drop. The world is in slow motion for the first 0.25 s, so the riser covers the ~0.6 s
   * the sequence takes; at the drop the filter opens and a crash + sub boom hit, then the ZONE layers (lead hook,
   * vocal chops, harder sidechain) run from the next step.
   */
  zoneEnter(): void {
    if (this.mode !== 'play' || !this.built || !this.eng.running) {
      this.zone = true;
      return;
    }
    const e = this.eng;
    const t0 = e.now;
    const t1 = t0 + 0.6;
    const lp = e.musicLP.frequency;
    lp.cancelScheduledValues(t0);
    lp.setValueAtTime(Math.max(300, lp.value as number), t0);
    lp.exponentialRampToValueAtTime(900, t1 - 0.02);
    e.noise({ time: t0, dur: 0.6, type: 'bandpass', f0: 500, f1: 9500, q: 1.6, peak: 0.26, attack: 0.5, dest: e.drums, send: 0.1 });
    e.osc({ time: t0, type: 'sawtooth', f0: 330, f1: 2000, dur: 0.6, peak: 0.05, attack: 0.5, dest: e.drums });
    const sd = this.stepDur();
    for (let t = t0 + 0.04, gap = sd * 2; t < t1 - 0.03; t += gap, gap = Math.max(sd * 0.5, gap * 0.8)) {
      this.snare(t, -15 + (12 * (t - t0)) / 0.6, this.fbRoll);
    }
    lp.setValueAtTime(OD_LP, t1);
    this.crash(t1, 0);
    this.subBoom(t1);
    this.clap(t1, -2);
    e.duck(t1, 0.05, 0.3);
    this.zone = true;
  }

  /** ZONE end: CLEAR closes the filter and opens it again (back to normal); BREAK dips it harder and faster. */
  zoneEnd(clear: boolean): void {
    this.zone = false;
    if (!this.built || this.mode !== 'play' || !this.eng.running) return;
    const lp = this.eng.musicLP.frequency;
    const now = this.eng.now;
    const target = this.od ? OD_LP : this.lpFor(this.tier);
    lp.cancelScheduledValues(now);
    lp.setValueAtTime(Math.max(300, lp.value as number), now);
    lp.exponentialRampToValueAtTime(clear ? 600 : 380, now + (clear ? 0.45 : 0.15));
    lp.exponentialRampToValueAtTime(target, now + (clear ? 1.6 : 1.0));
  }

  /** The world slows via the sim's timeScale and sync() follows it; kept for API compatibility. */
  setFocus(_on: boolean): void {
    void _on;
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

  // ------------------------------------------------------------------ tempo slaving (DESIGN 15.1)

  /**
   * Slave Tone.Transport to the sim beat clock. Call every frame while playing.
   * Tempo = sim BPM x timeScale, trimmed by at most +-3 % to absorb drift smoothly; only an error of more than
   * one beat re-cues the Transport (by whole 16th steps, so the pattern phase stays aligned).
   */
  sync(simBeat: number, bpm: number, timeScale: number): void {
    if (this.mode !== 'play' || !this.built) return;
    const tr = Tone.getTransport();
    const effRate = Math.max(1, tr.bpm.value) / 60;
    // the Transport runs ahead of what is audible by the scheduling look-ahead
    const musicBeat = tr.ticks / tr.PPQ - Tone.getContext().lookAhead * effRate;
    const err = simBeat - musicBeat;
    this.syncError = err;
    if (Math.abs(err) > SYNC_RESYNC_BEATS) {
      const dSteps = Math.round(err * STEP_TICKS_DIV);
      tr.ticks = Math.max(0, tr.ticks + dSteps * (tr.PPQ / STEP_TICKS_DIV));
      this.step = Math.max(0, this.step + dSteps);
      this.hardResyncs++;
      return;
    }
    const trim = Math.max(-SYNC_MAX_TRIM, Math.min(SYNC_MAX_TRIM, err * SYNC_GAIN));
    const tempo = Math.max(1, bpm * timeScale * (1 + trim));
    const now = performance.now() / 1000;
    if (now - this.lastTempoSet >= SYNC_UPDATE_S && Math.abs(tempo - this.lastTempo) > 0.0005 * tempo) {
      this.lastTempoSet = now;
      this.lastTempo = tempo;
      tr.bpm.value = tempo;
    }
  }

  // ------------------------------------------------------------------ transport

  private stepDur(): number {
    // floor: under CLUTCH / hit-stop the Transport crawls, and note lengths must not stretch with it
    return 60 / Math.max(70, this.bpm) / 4;
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
    this.pending = null;
    this.step = 0;
    this.lastStep = 0;
    this.lastTempo = bpm;
    this.lastTempoSet = 0;
    this.hardResyncs = 0;
    this.kicks.fill(0);
    this.setDetune(0);
    e.restoreFilter();
    tr.bpm.cancelScheduledValues(0);
    tr.bpm.value = bpm;
    tr.position = 0;
    e.scBass.gain.cancelScheduledValues(0);
    e.scMusic.gain.cancelScheduledValues(0);
    e.scBass.gain.value = 1;
    e.scMusic.gain.value = 1;
    e.musicLP.frequency.cancelScheduledValues(0);
    e.musicLP.frequency.value = mode === 'play' ? this.lpFor(this.tier) : 2600;
    e.musicDist.wet.value = mode === 'play' && this.tier >= 6 ? 0.22 : 0;
    this.repeatId = tr.scheduleRepeat((t) => this.onStep(t), '16n');
    tr.start('+0.05');
  }

  private onStep(time: number): void {
    const s = this.step++;
    this.lastStep = s;
    this.lastStepTime = time;
    // paused (context suspended): a step that is already queued must not start any sources
    if (!this.eng.forceRunning && this.eng.rawContext.state !== 'running') return;
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

  /**
   * Tight kick: sampled club body gated to 150 ms with a hard fade, a short synth sub (~130 ms), a click on top.
   * Nothing rings past ~170 ms, so consecutive kicks (even at 185 BPM = 324 ms apart) never overlap.
   */
  private kick(time: number, vel = 1): void {
    const e = this.eng;
    const ok = e.play('kickClub', { time, db: 3 + 6 * (vel - 1), dur: 0.15, fade: 0.05, dest: e.drums });
    if (!ok) this.fbKick.triggerAttackRelease(50, 0.12, time, vel);
    else this.kickSub.triggerAttackRelease(54, 0.1, time, vel);
    e.noise({ time, dur: 0.014, type: 'highpass', f0: 2800, q: 0.7, peak: 0.16 * vel, attack: 0.003, dest: e.drums });
    // inside a ZONE the sidechain pumps much harder and longer
    if (this.zone) e.duck(time, 0.07, Math.min(0.26, this.stepDur() * 3.6));
    else e.duck(time, 0.18, Math.min(0.2, this.stepDur() * 3));
    this.kicks[this.kickIdx++ % this.kicks.length] = time;
    this.onKick?.(time);
  }

  private hat(time: number, open: boolean, db: number): void {
    const e = this.eng;
    const ok = open
      ? e.play('hatOpen', { time, db, dur: 0.1, fade: 0.05, dest: e.drums, pan: 0.18 })
      : e.play('hatClosed', { time, db, dur: 0.06, fade: 0.03, dest: e.drums, pan: -0.12 });
    if (!ok) (open ? this.fbOpen : this.fbHat).triggerAttackRelease(open ? 0.1 : 0.04, time, 0.7);
  }

  private hat16(time: number, db: number): void {
    const e = this.eng;
    if (!e.play('hat16', { time, db, dest: e.drums, pan: 0.2 })) this.fbHat.triggerAttackRelease(0.03, time, 0.4);
  }

  private clap(time: number, db = 0): void {
    const e = this.eng;
    const a = e.play('clap', { time, db, dest: e.drums, send: 0.08 });
    e.play('clapBig', { time: time + 0.004, db: db - 5, dest: e.drums });
    if (!a) this.fbClap.triggerAttackRelease(0.14, time, 0.8);
  }

  private snare(time: number, db: number, fb: Tone.NoiseSynth = this.fbSnare): void {
    const e = this.eng;
    if (!e.play('snare', { time, db, dest: e.drums, send: 0.06, dur: 0.22, fade: 0.08 })) fb.triggerAttackRelease(0.14, time, 0.7);
  }

  private crash(time: number, db = 0): void {
    const e = this.eng;
    if (!e.play('crashBig', { time, db: db + 3, dest: e.drums, send: 0.12 })) {
      if (!e.play('crash', { time, db: db + 6, dest: e.drums, send: 0.12 })) this.fbCrash.triggerAttackRelease(1.1, time, 0.8);
    }
  }

  /** The one long low hit: a single drop impact (never on the beat), gated to 0.8 s. */
  private subBoom(time: number): void {
    const e = this.eng;
    if (!e.play('subDrop', { time, db: 0, dur: 0.8, fade: 0.3, dest: e.drums })) this.fbKick.triggerAttackRelease(38, 0.5, time, 1);
  }

  /** Snare roll + noise riser from `t0` to the drop at `t1`; filter closes during the build. */
  private buildUp(t0: number, t1: number, dur: number): void {
    const e = this.eng;
    const lp = e.musicLP.frequency;
    lp.cancelScheduledValues(t0);
    lp.setValueAtTime(Math.max(300, lp.value as number), t0);
    lp.exponentialRampToValueAtTime(420, t1 - 0.02);
    e.noise({ time: t0, dur, type: 'bandpass', f0: 500, f1: 9500, q: 1.6, peak: 0.3, attack: dur * 0.85, dest: e.drums, send: 0.1 });
    e.osc({ time: t0, type: 'sawtooth', f0: 330, f1: 1700, dur, peak: 0.06, attack: dur * 0.9, dest: e.drums });
    const sd = this.stepDur();
    let t = t0 + 0.02;
    let gap = sd * 2;
    while (t < t1 - 0.03) {
      const p = (t - t0) / dur;
      this.snare(t, -16 + 12 * p, this.fbRoll);
      if (p > 0.5) e.play('snareRoll', { time: t, db: -12 + 6 * p, dest: e.drums, dur: 0.1, fade: 0.04 });
      t += gap;
      gap = Math.max(sd * 0.5, gap * 0.93);
    }
  }

  // ------------------------------------------------------------------ patterns

  private effTier(): number {
    return this.od ? 6 : this.tier;
  }

  private playStep(time: number, s: number): void {
    const e = this.eng;
    const s16 = s & 15;
    // the phrase counter restarts at every section head (DESIGN 20.3): sections start on bar lines, so s16 is unaffected
    const rel = s - (s >= this.anchor ? this.anchor : this.prevAnchor);
    const bar = rel >> 4;
    const b8 = bar & 7;
    const ch = bar & 3;
    const v = (this.secIdx + (bar >> 3)) & 3; // melody / bass variation changes with every 8 bars and every section
    const sd = this.stepDur();
    const sec = this.sec;
    const breather = sec === 'BREATHER' && !this.od;
    const dark = sec === 'DARK';
    const hd = breather || dark ? -4 : 0;

    // ---- tier drop ----
    if (this.pending && s >= this.pending.stepIdx) {
      const p = this.pending;
      this.pending = null;
      this.tier = p.tier;
      e.musicLP.frequency.cancelScheduledValues(time);
      e.musicLP.frequency.setValueAtTime(this.od ? OD_LP : this.lpFor(p.tier), time);
      e.musicDist.wet.setValueAtTime(this.od || p.tier >= 6 ? 0.22 : 0, time);
      this.crash(time, 0);
      this.subBoom(time);
      this.clap(time, -2);
      e.duck(time, 0.1, 0.3);
    }
    let L = this.effTier();
    // BREATHER thins the arrangement out (kick, hats, bass, pad, a quiet arp); GAUNTLET brings the next layer in early
    if (breather) L = Math.min(L, 2);
    else if (sec === 'GAUNTLET' && !this.od) L = Math.min(6, L + 1);
    const chord = CHORDS[ch];
    const root = BASS_ROOT[ch];

    // ---- tier 1: four-on-the-floor, 16th hats, rolling bass, filtered pad ----
    if (s16 % 4 === 0) this.kick(time);
    if (s16 % 4 === 2) this.hat(time, true, -3 + hd);
    else if (s16 % 2 === 1) this.hat16(time, -5 + hd);
    else this.hat16(time, -10 + hd);
    const bn = BASS_VARIANTS[v][s16];
    if (bn !== null) {
      // gated: a pluck of about half a step, so each note is cut before the next
      this.bass.triggerAttackRelease(mtof(root + bn), sd * 0.55, time, (s16 % 4 === 2 ? 0.95 : 0.7) * (breather ? 0.6 : 1));
    }
    if (s16 === 0) this.pad.triggerAttackRelease([...chord, chord[0] + 12].map(mtof), sd * 15, time, 0.7);

    // ---- tier 2: backbeat clap + 16th arp ----
    if (L >= 2) {
      if (s16 === 4 || s16 === 12) this.clap(time, 0);
      const tones = [chord[0], chord[1], chord[2], chord[0] + 12, chord[1] + 12, chord[2] + 12];
      const n = tones[ARP_VARIANTS[v][s16]] + 12 + (L >= 6 && s16 % 4 === 3 ? 12 : 0);
      this.arp.triggerAttackRelease(mtof(n), sd * 0.8, time, (s16 % 4 === 0 ? 0.9 : 0.5) * (breather ? 0.55 : dark ? 0.6 : 1));
    }

    // ---- tier 3: rising lead ----
    if (L >= 3 && s16 % 2 === 0) {
      const deg = LEAD_VARIANTS[v][ch][s16 >> 1];
      if (deg !== null) {
        const climb = (b8 >> 1) + (v >= 2 ? 1 : 0); // each 2 bars the line steps up
        const note = scaleNote(CHORD_DEG[ch] + deg + climb);
        this.lead.triggerAttackRelease(mtof(note), sd * 1.7, time, 0.85);
        if (L >= 6) this.lead2.triggerAttackRelease(mtof(note + 12), sd * 1.7, time, 0.7);
      }
    }

    // ---- GAUNTLET: a snare roll that tightens over the section (8ths from the second bar, 16ths in the last) ----
    if (sec === 'GAUNTLET' && !this.od) {
      const total = Math.max(1, this.secBars);
      const last = bar >= total - 1;
      if (last || (bar >= 1 && s16 % 2 === 0)) {
        const p = Math.min(1, (rel + 1) / (total * 16));
        this.snare(time, -26 + 10 * p + (last ? s16 * 0.3 : 0), this.fbRoll);
      }
    }

    // ---- tier 4: snare fills (end of every 4th bar, longer on the phrase end) ----
    if (L >= 4 && sec !== 'GAUNTLET') {
      if (b8 === 7 && s16 >= 8) this.snare(time, -14 + (s16 - 8) * 1.8);
      else if ((b8 & 3) === 3 && s16 >= 12) this.snare(time, -12 + (s16 - 12) * 2.5);
    }

    // ---- tier 5: crash on the phrase start, off-beat chord stabs ----
    if (L >= 5) {
      if (s16 === 0 && b8 === 0 && s > 0) this.crash(time, -3);
      if (s16 % 4 === 2) this.chord.triggerAttackRelease(chord.map((m) => mtof(m + 12)), sd * 1.2, time, 0.7);
    }

    // ---- tier 6: acid line + extra crash every 4 bars ----
    if (L >= 6) {
      if (s16 === 0 && (bar & 3) === 0 && b8 !== 0) this.crash(time, -6);
      if (s16 % 4 === 3 || s16 === 6 || s16 === 10) {
        const sweep = 0.5 + 0.5 * Math.sin(s * 0.055);
        this.acid.filterEnvelope.baseFrequency = 220 + 1500 * sweep * sweep;
        this.acid.triggerAttackRelease(mtof(root + 12 + (s16 === 6 ? 7 : s16 === 10 ? 10 : 0)), sd * 0.5, time, 0.7);
      }
    }

    // ---- style layer (SS and above): high 16th shimmer on the chord tones and a rolling extra hat ----
    if (this.styleRank >= 5 && !breather) {
      const sn = chord[(s16 >> 1) % 3] + 36;
      if (s16 % 2 === 1) this.shim.triggerAttackRelease(mtof(sn), sd * 0.4, time, this.styleRank >= 6 ? 0.9 : 0.6);
      if (s16 % 4 === 1) this.hat16(time, -9);
    }

    // ---- ZONE: lead hook, vocal chops, extra drive ----
    if (this.zone) {
      const hook = ZONE_HOOK[v][s16];
      if (hook !== null) {
        const note = scaleNote(CHORD_DEG[ch] + hook);
        this.zoneLead.triggerAttackRelease(mtof(note), sd * 1.6, time, 0.85);
      }
      if (VOX_STEPS.includes(s16)) {
        const vow = VOWELS[(s16 + bar) & 3];
        this.voxF1.frequency.setValueAtTime(vow[0], time);
        this.voxF2.frequency.setValueAtTime(vow[1], time);
        this.vox.triggerAttackRelease(mtof(chord[(s16 >> 2) % 3] + 12), sd * 0.7, time, 0.8);
      }
      if (s16 % 4 === 2) this.hat(time, false, -7);
    }

    // ---- NITRO: extra open-hat push on the off 8ths ----
    if (this.nitro && s16 % 4 === 0 && s16 > 0) this.hat(time, false, -6);

    // ---- OVERDRIVE: gated growl stabs on the 8ths ----
    if (this.od && s16 % 2 === 0) {
      this.growl.triggerAttackRelease(mtof(root + 12 + (s16 % 8 === 6 ? 7 : 0)), sd * 0.7, time, 0.9);
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
      if (!e.play('kickClub', { time, db: -8, dur: 0.14, fade: 0.05, dest: e.drums })) this.fbKick.triggerAttackRelease(48, 0.12, time, 0.5);
      this.kicks[this.kickIdx++ % this.kicks.length] = time;
      e.duck(time, 0.45, 0.3);
    }
    if (s16 === 4 || s16 === 12) this.hat(time, false, -4);
    if (s16 === 8 && (bar & 1) === 1) this.hat(time, true, -8);
    if (s16 === 0 && (bar & 1) === 0) {
      this.pad.triggerAttackRelease([...chord, chord[0] + 12].map(mtof), sd * 31, time, 0.8);
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
