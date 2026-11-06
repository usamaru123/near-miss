import * as Tone from 'tone';
import { NEAR_DIST } from '../game/constants';
import type { ItemKind } from '../game/constants';
import type { AudioEngine } from './audio';

/** A minor pentatonic, rising: semitones above A5. */
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17];
const a5 = (semi: number): number => 880 * Math.pow(2, semi / 12);
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

/**
 * Every effect is a stack of a decoded sample plus synth layers, with pan and a reverb send.
 * Each sample layer has a synth fallback, so a missing file never silences an effect.
 */
export class Sfx {
  private windSrc: Tone.Noise | null = null;
  private windFilter: Tone.Filter | null = null;
  private windGain: Tone.Gain | null = null;
  private windHP: Tone.Filter | null = null;
  private pluck!: Tone.PolySynth;
  private bell!: Tone.PolySynth;
  private built = false;
  private lastHeart = -1;

  constructor(private readonly a: AudioEngine) {}

  /** Build the persistent synths up front (load time). */
  prepare(): void {
    if (!this.built) this.build();
  }

  private build(): void {
    this.built = true;
    const a = this.a;
    this.pluck = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.003, decay: 0.16, sustain: 0, release: 0.08 },
      volume: -11,
    });
    this.pluck.maxPolyphony = 40;
    this.pluck.connect(a.sfx);
    const sendP = new Tone.Gain(0.35);
    this.pluck.connect(sendP);
    sendP.connect(a.sendNode);
    this.bell = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 6,
      envelope: { attack: 0.003, decay: 0.5, sustain: 0, release: 0.3 },
      modulationEnvelope: { attack: 0.003, decay: 0.3, sustain: 0, release: 0.2 },
      volume: -18,
    });
    this.bell.maxPolyphony = 32;
    this.bell.connect(a.sfx);
    const sendB = new Tone.Gain(0.5);
    this.bell.connect(sendB);
    sendB.connect(a.sendNode);
  }

  /** Run `fn` with every sound it triggers trimmed by `level` (keeps each effect's peak in its mix slot). */
  private scoped(level: number, fn: () => void): void {
    const prev = this.a.level;
    this.a.level = prev * level;
    try {
      fn();
    } finally {
      this.a.level = prev;
    }
  }

  private get ok(): boolean {
    if (!this.a.running) return false;
    if (!this.built) this.build();
    return true;
  }

  // ------------------------------------------------------------------ wind

  /** Continuous filtered-noise wind; cutoff and level rise with speed. */
  startWind(): void {
    if (!this.ok || this.windSrc) return;
    const n = new Tone.Noise('pink');
    // no wind below 600 Hz: it only adds rumble
    const hp = new Tone.Filter({ type: 'highpass', frequency: 600, rolloff: -24 });
    const f = new Tone.Filter({ type: 'bandpass', frequency: 900, Q: 0.7 });
    const g = new Tone.Gain(0);
    n.chain(hp, f, g, this.a.sfx);
    this.windHP = hp;
    n.start();
    this.windSrc = n;
    this.windFilter = f;
    this.windGain = g;
  }

  updateWind(speedFrac: number, overdrive: boolean, nitro = false): void {
    if (!this.windFilter || !this.windGain) return;
    this.windFilter.frequency.rampTo(900 + speedFrac * 2400 + (overdrive ? 1400 : 0) + (nitro ? 900 : 0), 0.1);
    this.windGain.gain.rampTo(0.05 + speedFrac * 0.26 + (overdrive ? 0.16 : 0) + (nitro ? 0.08 : 0), 0.1);
  }

  stopWind(): void {
    const n = this.windSrc;
    const g = this.windGain;
    const f = this.windFilter;
    const hp = this.windHP;
    this.windHP = null;
    if (!n || !g || !f) return;
    this.windSrc = null;
    this.windGain = null;
    this.windFilter = null;
    g.gain.rampTo(0, 0.12);
    window.setTimeout(() => {
      try {
        n.stop();
        n.dispose();
        f.dispose();
        hp?.dispose();
        g.dispose();
      } catch {
        /* disposed */
      }
    }, 600);
  }

  // ------------------------------------------------------------------ passes / near misses

  /** Doppler-style pass-by: pitch falls as the obstacle passes, panned to its side. */
  private _whoosh(pan: number, speedFrac: number): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    const lvl = 0.5 + speedFrac * 0.5;
    const played = a.play('whoosh', { time: t, db: -3 + 6 * speedFrac, rate: 1.5, rateEnd: 0.75, dur: 0.4, pan, send: 0.12 });
    a.noise({
      time: t, dur: 0.38, type: 'bandpass', f0: 3600 + speedFrac * 1800, f1: 500, q: 4,
      peak: (played ? 0.12 : 0.26) * lvl, attack: 0.05, pan,
    });
  }

  private _nearMiss(dist = NEAR_DIST * 0.5, pan = 0): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    const k = 1 - Math.max(0, Math.min(1, dist / NEAR_DIST));
    const rate = 1.1 + k * 0.9;
    const p = pan * 0.9;
    a.play('whoosh2', { time: t, db: 4, rate, rateEnd: rate * 1.8, dur: 0.3, pan: p, send: 0.18 });
    a.play('whoosh', { time: t, db: 0, rate: rate * 0.9, rateEnd: rate * 1.5, dur: 0.26, pan: p });
    a.noise({ time: t, dur: 0.26, type: 'bandpass', f0: 700 + 500 * k, f1: 4600 + 3600 * k, q: 2.5, peak: 0.34, attack: 0.03, pan: p });
    a.osc({ time: t, type: 'sine', f0: 600 + 500 * k, f1: 2000 + 900 * k, dur: 0.2, peak: 0.1, attack: 0.02, pan: p });
  }

  insane(dist = 0, pan = 0): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    this.nearMiss(dist, pan);
    // glassy chime
    if (!a.play('glassChime', { time: t + 0.02, db: 2, rate: 1.4, send: 0.35 })) {
      this.bell.triggerAttackRelease(a5(12), 0.4, t + 0.02);
    }
    this.bell.triggerAttackRelease(a5(19), 0.5, t + 0.07, 0.8);
    this.pluck.triggerAttackRelease(a5(24), 0.2, t + 0.12, 0.7);
    a.osc({ time: t, type: 'sine', f0: 1760, f1: 2349, dur: 0.18, peak: 0.16, send: 0.3 });
    // reverse cymbal swell that cuts on the hit
    a.play('crash', { time: t, db: 2, reverse: true, offset: 1.9, dur: 0.5, fade: 0.03, send: 0.2 });
  }

  // ------------------------------------------------------------------ items

  /** Rising pluck inside a chain: minor pentatonic, one step per consecutive shard. */
  shard(chainIdx: number): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    const semi = PENTA[Math.min(PENTA.length - 1, chainIdx)] + (chainIdx >= PENTA.length ? 12 : 0);
    const f = a5(semi);
    this.pluck.triggerAttackRelease(f, 0.1, t, 0.9);
    this.pluck.triggerAttackRelease(f * 2, 0.06, t + 0.004, 0.35);
    a.play('uiTick', { time: t, db: -4, rate: 1 + chainIdx * 0.08, pan: rnd(-0.15, 0.15) });
  }

  perfectChain(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    for (let i = 0; i < 9; i++) {
      const f = a5(PENTA[i % PENTA.length] + (i >= 6 ? 12 : 0));
      this.pluck.triggerAttackRelease(f, 0.14, t + i * 0.045, 0.85);
      if (i % 2 === 0) this.bell.triggerAttackRelease(f * 2, 0.4, t + i * 0.045 + 0.01, 0.5);
    }
    if (!a.play('coin', { time: t, db: 4, rate: 0.9, send: 0.3 })) a.osc({ time: t, type: 'square', f0: 1200, f1: 1800, dur: 0.12, peak: 0.12 });
    a.noise({ time: t + 0.1, dur: 0.6, type: 'highpass', f0: 7000, q: 0.5, peak: 0.1, attack: 0.15, send: 0.3 });
    a.play('glassChime', { time: t + 0.38, db: 2, rate: 1.8, send: 0.4 });
  }

  powerup(kind: ItemKind): void {
    if (!this.ok) return;
    switch (kind) {
      case 'SHIELD':
        return this.shieldUp();
      case 'NITRO':
        return this.nitroUp();
      case 'DOUBLE':
        return this.doubleUp();
      case 'WARP':
        return this.warpUp();
      case 'EMP':
        return this.empBlast();
    }
  }

  /** Electronic barrier: a shimmering up-sweep with a pulsing hum. */
  private shieldUp(): void {
    const a = this.a;
    const t = a.now;
    a.osc({ time: t, type: 'sawtooth', f0: 180, f1: 1400, dur: 0.45, peak: 0.12, attack: 0.1, send: 0.35 });
    a.osc({ time: t, type: 'square', f0: 182, f1: 1420, dur: 0.45, peak: 0.07, attack: 0.1, detune: 14, pan: 0.3 });
    a.noise({ time: t, dur: 0.5, type: 'bandpass', f0: 400, f1: 6000, q: 3, peak: 0.2, attack: 0.15, send: 0.3 });
    if (!a.play('fxZap', { time: t + 0.05, db: 2, rate: 0.7, send: 0.3 })) a.osc({ time: t, type: 'triangle', f0: 800, f1: 200, dur: 0.3, peak: 0.2 });
    a.play('uiBlip', { time: t + 0.32, db: 6, rate: 1.5, send: 0.3 });
    this.bell.triggerAttackRelease(a5(7), 0.6, t + 0.3, 0.8);
    this.bell.triggerAttackRelease(a5(14), 0.8, t + 0.38, 0.8);
  }

  /** Jet ignition: whoosh of flame, ramping turbine. */
  private _nitroUp(): void {
    const a = this.a;
    const t = a.now;
    a.noise({ time: t, dur: 0.7, type: 'lowpass', f0: 300, f1: 9500, q: 0.8, peak: 0.55, attack: 0.08, send: 0.15 });
    a.osc({ time: t, type: 'sawtooth', f0: 70, f1: 640, dur: 0.6, peak: 0.16, attack: 0.05 });
    a.play('fxJet', { time: t, db: 2, rate: 1.1, dur: 0.9, fade: 0.25, send: 0.15 });
    a.play('subBoom', { time: t + 0.05, db: -2 });
    a.osc({ time: t + 0.05, type: 'sine', f0: 130, f1: 40, dur: 0.5, peak: 0.5, attack: 0.004 });
  }

  /** Coin chime: bright major chord, two quick arpeggio passes. */
  private doubleUp(): void {
    const a = this.a;
    const t = a.now;
    if (!a.play('coin', { time: t, db: 5, rate: 1, send: 0.25 })) a.osc({ time: t, type: 'square', f0: 988, f1: 1319, dur: 0.15, peak: 0.12 });
    const notes = [a5(3), a5(7), a5(12), a5(15)];
    notes.forEach((f, i) => {
      this.bell.triggerAttackRelease(f, 0.4, t + 0.03 + i * 0.05, 0.8);
      this.pluck.triggerAttackRelease(f * 2, 0.12, t + 0.03 + i * 0.05, 0.6);
    });
    this.bell.triggerAttackRelease(a5(12), 0.7, t + 0.3, 0.9);
    this.bell.triggerAttackRelease(a5(19), 0.7, t + 0.3, 0.7);
  }

  /** Time stretching: a reversed swell and a falling, widening tone. */
  private _warpUp(): void {
    const a = this.a;
    const t = a.now;
    if (!a.play('fxWarp', { time: t, db: 6, reverse: true, rate: 0.9, send: 0.4, pan: -0.2 })) {
      a.osc({ time: t, type: 'sine', f0: 200, f1: 1200, dur: 0.9, peak: 0.2, attack: 0.5, send: 0.4 });
    }
    a.osc({ time: t + 0.5, type: 'sine', f0: 1500, f1: 160, dur: 0.9, peak: 0.2, attack: 0.02, send: 0.5 });
    a.osc({ time: t + 0.5, type: 'triangle', f0: 1508, f1: 164, dur: 0.9, peak: 0.1, attack: 0.02, pan: 0.5, send: 0.5 });
    a.noise({ time: t, dur: 0.9, type: 'bandpass', f0: 2500, f1: 300, q: 2, peak: 0.1, attack: 0.4, send: 0.3 });
  }

  /** Deep drop and a shockwave. */
  private _empBlast(): void {
    const a = this.a;
    const t = a.now;
    if (!a.play('subDrop', { time: t, db: 3 })) a.osc({ time: t, type: 'sine', f0: 100, f1: 26, dur: 1.2, peak: 0.9, attack: 0.004 });
    a.osc({ time: t, type: 'sine', f0: 90, f1: 26, dur: 1.3, peak: 0.7, attack: 0.004 });
    a.play('fxZap', { time: t, db: 4, rate: 0.6, send: 0.3 });
    a.play('fxRumble', { time: t, db: 2, dur: 1.1, fade: 0.3, rate: 0.7 });
    a.noise({ time: t, dur: 0.9, type: 'lowpass', f0: 8000, f1: 150, q: 0.7, peak: 0.6, attack: 0.004, send: 0.2 });
    a.noise({ time: t + 0.05, dur: 0.7, type: 'highpass', f0: 1000, f1: 9000, q: 0.5, peak: 0.25, attack: 0.15, send: 0.35 });
    a.play('crashBig', { time: t, db: 2, send: 0.25 });
  }

  /** Glass shatter with a low thud. */
  private _shieldBreak(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    if (!a.play('glass', { time: t, db: 5, rate: 0.9, send: 0.3 })) {
      a.noise({ time: t, dur: 0.5, type: 'highpass', f0: 4500, q: 0.7, peak: 0.5, attack: 0.002, send: 0.3 });
    }
    a.play('glass', { time: t + 0.02, db: 2, rate: 1.4, send: 0.3, pan: 0.3 });
    a.play('glassChime', { time: t, db: 4, rate: 1.1, send: 0.4 });
    a.play('debrisPing', { time: t + 0.04, db: 0, rate: 1.6, pan: -0.3 });
    a.noise({ time: t, dur: 0.3, type: 'highpass', f0: 5500, q: 0.7, peak: 0.28, attack: 0.002, pan: 0.2 });
    a.osc({ time: t, type: 'sine', f0: 140, f1: 45, dur: 0.3, peak: 0.45, attack: 0.002 });
  }

  /** EMP shockwave as seen from the event (the pick-up sound already carries the drop). */
  private _emp(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now + 0.05;
    a.noise({ time: t, dur: 0.6, type: 'bandpass', f0: 6000, f1: 400, q: 1.2, peak: 0.3, attack: 0.01, send: 0.3 });
    a.play('smashMetal', { time: t, db: 0, rate: 0.8, send: 0.2 });
    a.play('debris', { time: t + 0.03, db: -2, rate: 0.9, pan: 0.2 });
  }

  // ------------------------------------------------------------------ big moments

  private _overdriveStart(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    a.noise({ time: t, dur: 0.7, type: 'bandpass', f0: 200, f1: 9500, q: 1.5, peak: 0.45, attack: 0.5, send: 0.15 });
    a.osc({ time: t, type: 'sawtooth', f0: 70, f1: 900, dur: 0.6, peak: 0.16, attack: 0.3 });
    a.play('fxSweep', { time: t, db: 4, dur: 0.7, fade: 0.1, rate: 1.3 });
    const h = t + 0.38;
    a.play('subDrop', { time: h, db: 3 });
    a.play('crashBig', { time: h, db: 1, send: 0.3 });
    a.play('kickHeavy', { time: h, db: 0 });
    a.osc({ time: h, type: 'sine', f0: 140, f1: 28, dur: 0.8, peak: 0.8, attack: 0.008 });
    a.noise({ time: h, dur: 0.55, type: 'lowpass', f0: 7000, f1: 300, q: 0.7, peak: 0.55, attack: 0.004, send: 0.2 });
  }

  overdriveEnd(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    a.osc({ time: t, type: 'sawtooth', f0: 900, f1: 60, dur: 0.5, peak: 0.12, attack: 0.01 });
    a.noise({ time: t, dur: 0.5, type: 'lowpass', f0: 6000, f1: 200, q: 1, peak: 0.28, attack: 0.01 });
    a.play('fxSweep', { time: t, db: -2, reverse: true, dur: 0.5, rate: 1.2 });
  }

  /** Metal and rubble impact. */
  private _smash(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    const metal = Math.random() < 0.5 ? 'smashMetal' : 'smashMetal2';
    const r = rnd(0.9, 1.15);
    if (!a.play('smashImpact', { time: t, db: 1, rate: r, send: 0.12 })) {
      a.noise({ time: t, dur: 0.28, type: 'highpass', f0: 9000, f1: 1200, q: 0.6, peak: 0.6, attack: 0.002 });
    }
    a.play(metal, { time: t + 0.006, db: 1, rate: r * 1.1, pan: rnd(-0.3, 0.3), send: 0.15 });
    a.play('stomp', { time: t, db: 3, rate: 0.8 });
    a.play('debris', { time: t + 0.03, db: -3, rate: rnd(0.9, 1.3), pan: rnd(-0.5, 0.5), send: 0.12 });
    a.osc({ time: t, type: 'sine', f0: 120, f1: 38, dur: 0.25, peak: 0.55, attack: 0.002 });
    a.osc({ time: t, type: 'square', f0: 440, f1: 90, dur: 0.1, peak: 0.1, attack: 0.002 });
  }

  /** Explosion, metal shards, sub boom. (The tape stop is the music's job.) */
  private _death(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    if (!a.play('subBoom', { time: t, db: 6 })) a.osc({ time: t, type: 'sine', f0: 120, f1: 24, dur: 1.5, peak: 1, attack: 0.004 });
    a.play('subDrop', { time: t, db: 2 });
    a.play('fxRumble', { time: t, db: 3, dur: 1.4, fade: 0.5, rate: 0.6, send: 0.2 });
    a.play('smashImpact', { time: t, db: 3, rate: 0.7, send: 0.2 });
    a.play('stomp', { time: t, db: 4, rate: 0.6 });
    a.play('smashMetal', { time: t + 0.02, db: 2, rate: 0.8, pan: -0.4, send: 0.2 });
    a.play('smashMetal2', { time: t + 0.05, db: 2, rate: 0.9, pan: 0.4, send: 0.2 });
    a.play('debris', { time: t + 0.08, db: 0, rate: 0.7, pan: -0.2, send: 0.25 });
    a.play('debrisPing', { time: t + 0.14, db: 0, rate: 1.4, pan: 0.5, send: 0.3 });
    a.play('debrisPing', { time: t + 0.26, db: -2, rate: 0.9, pan: -0.6, send: 0.3 });
    a.noise({ time: t, dur: 1.3, type: 'lowpass', f0: 7000, f1: 120, q: 0.7, peak: 0.7, attack: 0.004, send: 0.3 });
    a.osc({ time: t, type: 'sine', f0: 90, f1: 22, dur: 1.5, peak: 0.8, attack: 0.004 });
    a.osc({ time: t, type: 'sawtooth', f0: 220, f1: 30, dur: 0.9, peak: 0.15, attack: 0.004 });
  }

  /** Sonic boom for speed milestones. */
  private _boom(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    if (!a.play('subBoom', { time: t, db: 3 })) a.osc({ time: t, type: 'sine', f0: 80, f1: 24, dur: 1.1, peak: 0.9, attack: 0.003 });
    a.play('fxRumble', { time: t, db: 0, dur: 0.9, fade: 0.4, rate: 0.9 });
    a.play('smashImpact', { time: t, db: -2, rate: 0.6 });
    a.noise({ time: t, dur: 0.7, type: 'lowpass', f0: 5000, f1: 150, q: 0.7, peak: 0.5, attack: 0.003, send: 0.25 });
    a.noise({ time: t + 0.03, dur: 0.8, type: 'highpass', f0: 800, f1: 8000, q: 0.5, peak: 0.12, attack: 0.25, send: 0.4 });
    a.osc({ time: t, type: 'sawtooth', f0: 200, f1: 40, dur: 0.5, peak: 0.1, attack: 0.003 });
  }

  /** Launch boost on GO. */
  private _launch(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    this.boom();
    a.noise({ time: t, dur: 0.5, type: 'bandpass', f0: 400, f1: 9000, q: 1.2, peak: 0.5, attack: 0.1 });
    a.osc({ time: t, type: 'sawtooth', f0: 60, f1: 700, dur: 0.45, peak: 0.18, attack: 0.02 });
    a.play('kickClub', { time: t, db: 2 });
  }

  /** 3-2-1 beeps; GO is a strong hit. */
  countBeep(final: boolean): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    if (final) {
      a.level *= 0.65;
      a.osc({ time: t, type: 'square', f0: 1320, dur: 0.45, peak: 0.2, attack: 0.004, dest: a.ui });
      a.osc({ time: t, type: 'sawtooth', f0: 660, dur: 0.45, peak: 0.14, attack: 0.004, dest: a.ui });
      a.play('kickHeavy', { time: t, db: 0 });
      a.play('crash', { time: t, db: 6, send: 0.2 });
      a.play('uiBeep', { time: t, db: 6, rate: 1.5, dest: a.ui });
      a.level /= 0.65;
    } else {
      a.osc({ time: t, type: 'square', f0: 660, dur: 0.2, peak: 0.2, attack: 0.004, dest: a.ui });
      a.play('uiBeep', { time: t, db: 2, rate: 1, dest: a.ui, send: 0.1 });
    }
  }

  /** Short synth "up" for a multiplier increase. */
  multUp(mult: number): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    const base = 523 * Math.pow(2, Math.min(7, mult) / 12);
    a.osc({ time: t, type: 'square', f0: base, f1: base * 2, dur: 0.12, peak: 0.12, attack: 0.003, dest: a.ui });
    a.osc({ time: t + 0.07, type: 'square', f0: base * 1.5, f1: base * 3, dur: 0.12, peak: 0.1, attack: 0.003, dest: a.ui });
    a.play('uiBlip', { time: t, db: 6, rate: 1.4, dest: a.ui });
  }

  /** Lub-dub, two sub thumps. Louder and fatter during FOCUS. */
  heart(loud: boolean): void {
    // the steady heartbeat loop was a constant low thump: it only sounds in FOCUS / CLUTCH now
    if (!loud || !this.ok) return;
    const a = this.a;
    const t = a.now;
    if (t - this.lastHeart < 0.15) return;
    this.lastHeart = t;
    const v = loud ? 0.9 : 0.5;
    a.osc({ time: t, type: 'sine', f0: 62, f1: 40, dur: 0.16, peak: v, attack: 0.004, dest: a.heart });
    a.osc({ time: t + 0.15, type: 'sine', f0: 56, f1: 38, dur: 0.2, peak: v * 0.75, attack: 0.004, dest: a.heart });
    if (loud) a.osc({ time: t, type: 'triangle', f0: 124, f1: 80, dur: 0.1, peak: 0.25, attack: 0.003, dest: a.heart });
  }

  /** ON BEAT: a bright punch layered on the kick (high enough not to add low-end). */
  beatAccent(strong: boolean): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    a.osc({ time: t, type: 'sine', f0: 190, f1: 90, dur: 0.07, peak: strong ? 0.4 : 0.3, attack: 0.003, dest: a.ui });
    a.noise({ time: t, dur: 0.04, type: 'highpass', f0: 3500, q: 0.7, peak: 0.2, attack: 0.003, dest: a.ui });
    a.play('uiBlip', { time: t, db: 3, rate: strong ? 1.8 : 1.5, dest: a.ui });
  }

  /** BEAT STREAK bonus: a quick rising arpeggio. */
  beatStreak(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    [0, 4, 7, 12].forEach((semi, i) => this.pluck.triggerAttackRelease(a5(semi + 12), 0.1, t + i * 0.05, 0.8));
    this.bell.triggerAttackRelease(a5(24), 0.4, t + 0.2, 0.6);
  }

  /** CLUTCH start: time stops (reverse swell, falling tone) over a muffled mix. */
  clutchStart(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    a.play('fxWarp', { time: t, db: 4, reverse: true, rate: 1.2, dur: 0.45, fade: 0.1, send: 0.4 });
    a.osc({ time: t, type: 'sine', f0: 1400, f1: 180, dur: 0.5, peak: 0.22, attack: 0.01, send: 0.5 });
    a.noise({ time: t, dur: 0.4, type: 'bandpass', f0: 3000, f1: 300, q: 2, peak: 0.12, attack: 0.05, send: 0.3 });
  }

  /** CLUTCH success: time snaps back with a big hit. */
  clutchSuccess(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    a.play('crashBig', { time: t, db: 2, send: 0.3, dur: 1.2, fade: 0.4 });
    a.play('smashImpact', { time: t, db: 1, rate: 0.9 });
    a.noise({ time: t, dur: 0.5, type: 'bandpass', f0: 500, f1: 9000, q: 1.2, peak: 0.4, attack: 0.01, send: 0.2 });
    [0, 7, 12, 16, 19].forEach((semi, i) => {
      this.pluck.triggerAttackRelease(a5(semi), 0.14, t + 0.04 + i * 0.05, 0.9);
      this.bell.triggerAttackRelease(a5(semi + 12), 0.5, t + 0.04 + i * 0.05, 0.6);
    });
  }

  /** Short fanfare for OVERTAKE!. */
  overtake(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    [0, 5, 9, 12].forEach((semi, i) => this.pluck.triggerAttackRelease(a5(semi), 0.12, t + i * 0.06, 0.9));
    a.play('coin', { time: t + 0.12, db: 2, rate: 1.1, send: 0.25 });
  }

  /** Bigger fanfare for the live NEW RECORD. */
  newRecord(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    [0, 4, 7, 12, 16, 19, 24].forEach((semi, i) => {
      this.pluck.triggerAttackRelease(a5(semi), 0.16, t + i * 0.07, 0.9);
      this.bell.triggerAttackRelease(a5(semi + 12), 0.6, t + i * 0.07, 0.6);
    });
    a.play('crash', { time: t, db: 2, send: 0.3, dur: 1.4, fade: 0.5 });
    a.play('coin', { time: t + 0.1, db: 4, rate: 0.95, send: 0.3 });
  }

  blip(high = false): void {
    if (!this.ok) return;
    const a = this.a;
    a.osc({ type: 'square', f0: high ? 1320 : 660, f1: high ? 1760 : 990, dur: 0.09, peak: 0.12, dest: a.ui });
  }

  // ------------------------------------------------------------------ style rank + ZONE (DESIGN 18.3)

  /** Rank-up: a rising run whose pitch climbs with the rank; S and above add a chord stinger. */
  private _rankUp(rank: number): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    const n = 2 + Math.ceil(rank / 2); // 3..5 notes: PolySynth voices are a shared, capped resource
    for (let i = 0; i < n; i++) {
      const semi = rank * 2 + PENTA[i % PENTA.length] + (i >= PENTA.length ? 12 : 0);
      this.pluck.triggerAttackRelease(a5(semi - 12), 0.1, t + i * 0.042, 0.8);
    }
    a.osc({ time: t, type: 'sine', f0: 500 + rank * 90, f1: 1500 + rank * 260, dur: 0.22, peak: 0.1, attack: 0.02, send: 0.3 });
    a.noise({ time: t, dur: 0.25, type: 'bandpass', f0: 1500, f1: 7000 + rank * 600, q: 1.5, peak: 0.1, attack: 0.1, send: 0.25 });
    if (rank >= 4) {
      // chord stinger: S = triad, SS adds the 9th, SSS the octave on top and a glass chime
      const h = t + n * 0.042 + 0.02;
      const chord = rank >= 5 ? [0, 4, 7, 12] : [0, 4, 7];
      chord.forEach((semi) => this.bell.triggerAttackRelease(a5(semi + rank), 0.9, h, 0.55));
      this.pluck.triggerAttackRelease(a5(rank + 12), 0.2, h, 0.6);
      a.play('crashBig', { time: h, db: -4 + rank, send: 0.3, dur: 1.0, fade: 0.4 });
      if (rank >= 6) a.play('glassChime', { time: h + 0.05, db: 2, rate: 1.5, send: 0.4 });
    }
  }

  /** Rank-down: three falling notes and a dull thud. */
  private _rankDown(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    [12, 7, 0].forEach((semi, i) => this.pluck.triggerAttackRelease(a5(semi - 12), 0.14, t + i * 0.07, 0.8));
    a.osc({ time: t, type: 'triangle', f0: 700, f1: 160, dur: 0.4, peak: 0.16, attack: 0.01, send: 0.2 });
    a.noise({ time: t, dur: 0.3, type: 'lowpass', f0: 3000, f1: 200, q: 1, peak: 0.16, attack: 0.005 });
  }

  /** ZONE entry: a reversed swell into the drop (the music adds its own riser), then a huge hit and a bright chord. */
  private _zoneEnter(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    a.play('crash', { time: t, db: 1, reverse: true, offset: 1.4, dur: 0.6, fade: 0.05, send: 0.3 });
    a.osc({ time: t, type: 'sawtooth', f0: 220, f1: 1760, dur: 0.6, peak: 0.07, attack: 0.5, send: 0.3 });
    const h = t + 0.6;
    a.play('kickHeavy', { time: h, db: 0 });
    a.play('crashBig', { time: h, db: 2, send: 0.35, dur: 1.4, fade: 0.5 });
    a.play('subDrop', { time: h, db: -2, dur: 0.9, fade: 0.3 });
    a.noise({ time: h, dur: 0.6, type: 'bandpass', f0: 600, f1: 9000, q: 1, peak: 0.2, attack: 0.01, send: 0.3 });
    [0, 7, 12, 19].forEach((semi, i) => {
      this.bell.triggerAttackRelease(a5(semi), 1.0, h + 0.02, 0.5);
      this.pluck.triggerAttackRelease(a5(semi), 0.14, h + i * 0.05, 0.7);
    });
    a.play('glassChime', { time: h + 0.1, db: 3, rate: 1.2, send: 0.4 });
  }

  /** ZONE level-up stinger. */
  private _zoneLevel(lv: number): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    const base = Math.min(12, lv * 2);
    [0, 4, 7, 12].forEach((semi, i) => {
      this.pluck.triggerAttackRelease(a5(semi + base), 0.1, t + i * 0.05, 0.8);
      if (i % 2 === 0) this.bell.triggerAttackRelease(a5(semi + base + 12), 0.45, t + i * 0.05, 0.5);
    });
    a.play('coin', { time: t + 0.15, db: 2, rate: 1 + lv * 0.04, send: 0.3 });
    a.noise({ time: t, dur: 0.35, type: 'highpass', f0: 6000, q: 0.5, peak: 0.1, attack: 0.1, send: 0.3 });
  }

  /** ZONE CLEAR: a counting arpeggio, coin and chime. */
  private _zoneClear(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    for (let i = 0; i < 9; i++) {
      const f = a5(PENTA[i % PENTA.length] + (i >= 6 ? 24 : i >= 3 ? 12 : 0) - 12);
      this.pluck.triggerAttackRelease(f, 0.08, t + i * 0.07, 0.7);
      if (i % 4 === 0) this.bell.triggerAttackRelease(f * 2, 0.5, t + i * 0.07, 0.45);
    }
    a.play('coin', { time: t, db: 3, rate: 0.95, send: 0.3 });
    a.play('coin', { time: t + 0.33, db: 3, rate: 1.2, send: 0.3 });
    a.play('glassChime', { time: t + 0.7, db: 3, rate: 1.4, send: 0.4 });
    a.noise({ time: t + 0.1, dur: 0.8, type: 'highpass', f0: 6500, q: 0.5, peak: 0.1, attack: 0.3, send: 0.3 });
  }

  /** ZONE BREAK: record-scratch swipes, glass and a low thud. */
  private _zoneBreak(): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    for (let i = 0; i < 4; i++) {
      const up = i % 2 === 0;
      a.osc({ time: t + i * 0.075, type: 'sawtooth', f0: up ? 260 : 1300, f1: up ? 1300 : 260, dur: 0.07, peak: 0.12, attack: 0.004, pan: up ? -0.3 : 0.3 });
      a.noise({ time: t + i * 0.075, dur: 0.07, type: 'bandpass', f0: up ? 900 : 4200, f1: up ? 4200 : 900, q: 3, peak: 0.28, attack: 0.004, pan: up ? -0.3 : 0.3 });
    }
    const h = t + 0.3;
    a.play('glass', { time: h, db: 3, rate: 0.8, send: 0.3 });
    a.osc({ time: h, type: 'sine', f0: 150, f1: 40, dur: 0.35, peak: 0.4, attack: 0.003 });
    a.osc({ time: h, type: 'sawtooth', f0: 900, f1: 90, dur: 0.6, peak: 0.1, attack: 0.004, send: 0.2 });
  }

  /** 10^n score milestone: a rising sweep and a bright chord that climbs with n. */
  private _milestone(exp: number): void {
    if (!this.ok) return;
    const a = this.a;
    const t = a.now;
    const up = Math.min(14, (exp - 4) * 2);
    a.osc({ time: t, type: 'sine', f0: 400, f1: 1800, dur: 0.4, peak: 0.1, attack: 0.1, send: 0.3 });
    [0, 4, 7, 12].forEach((semi) => this.bell.triggerAttackRelease(a5(semi + up), 0.8, t + 0.3, 0.55));
    this.pluck.triggerAttackRelease(a5(up + 12), 0.2, t + 0.3, 0.7);
    a.play('coin', { time: t + 0.3, db: 1, rate: 0.9 + exp * 0.02, send: 0.3 });
  }

  // ---- level-trimmed entry points ----

  rankUp(rank: number): void {
    this.scoped(0.62, () => this._rankUp(rank));
  }

  rankDown(): void {
    this.scoped(0.6, () => this._rankDown());
  }

  zoneEnter(): void {
    this.scoped(0.5, () => this._zoneEnter());
  }

  zoneLevel(lv: number): void {
    this.scoped(0.6, () => this._zoneLevel(lv));
  }

  zoneClear(): void {
    this.scoped(0.6, () => this._zoneClear());
  }

  zoneBreak(): void {
    this.scoped(0.55, () => this._zoneBreak());
  }

  milestone(exp: number): void {
    this.scoped(0.6, () => this._milestone(exp));
  }


  nearMiss(dist = NEAR_DIST * 0.5, pan = 0): void {
    this.scoped(0.6, () => this._nearMiss(dist, pan));
  }

  whoosh(pan: number, speedFrac: number): void {
    this.scoped(0.8, () => this._whoosh(pan, speedFrac));
  }

  private nitroUp(): void {
    this.scoped(0.55, () => this._nitroUp());
  }

  private warpUp(): void {
    this.scoped(0.85, () => this._warpUp());
  }

  private empBlast(): void {
    this.scoped(0.45, () => this._empBlast());
  }

  emp(): void {
    this.scoped(0.6, () => this._emp());
  }

  shieldBreak(): void {
    this.scoped(0.7, () => this._shieldBreak());
  }

  overdriveStart(): void {
    this.scoped(0.4, () => this._overdriveStart());
  }

  smash(): void {
    this.scoped(0.55, () => this._smash());
  }

  death(): void {
    this.scoped(0.25, () => this._death());
  }

  boom(): void {
    this.scoped(0.5, () => this._boom());
  }

  launch(): void {
    this.scoped(0.8, () => this._launch());
  }
}
