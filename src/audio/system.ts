import type { AudioEngine, VolumeKind } from './audio';
import { createBank } from './bank';
import type { Music } from './music';
import type { Sfx } from './sfx';

/**
 * Gesture-free facade over the Tone.js audio stack.
 *
 * Tone.js is imported lazily on the first user gesture: merely importing it creates an AudioContext and
 * a handful of nodes, and Chrome logs an autoplay warning for each. Sample decoding (plain
 * OfflineAudioContext) happens up front so the title can show progress and enable START.
 */
export class AudioSystem {
  readonly bank = createBank();
  readonly vol: Record<VolumeKind, number> = { master: 0.8, bgm: 0.7, se: 1 };
  muted = false;
  private engine: AudioEngine | null = null;
  private music_: Music | null = null;
  private sfx_: Sfx | null = null;
  private starting: Promise<void> | null = null;

  /** Calls made before Tone exists are silently ignored (beatPulse() etc. return 0). */
  readonly music: Music = lazy(() => this.music_);
  readonly sfx: Sfx = lazy(() => this.sfx_);

  async load(onProgress?: (done: number, total: number) => void): Promise<void> {
    await this.bank.loadAll(onProgress);
  }

  get running(): boolean {
    return this.engine?.running ?? false;
  }

  stats(): Record<string, unknown> {
    return this.engine?.stats() ?? {};
  }

  get musicErrors(): number {
    return this.music_?.errors ?? 0;
  }

  /** Call from a user gesture. Loads Tone on first use, then starts the context. */
  unlock(): Promise<void> {
    if (this.engine) return this.engine.unlock();
    if (!this.starting) {
      this.starting = (async () => {
        const [{ AudioEngine }, { Music }, { Sfx }] = await Promise.all([import('./audio'), import('./music'), import('./sfx')]);
        const e = new AudioEngine(this.bank);
        Object.assign(e.vol, this.vol);
        e.muted = this.muted;
        this.engine = e;
        this.music_ = new Music(e);
        this.sfx_ = new Sfx(e);
        await e.unlock();
        // build every persistent synth now (load time), never in the middle of a run
        this.music_.prepare();
        this.sfx_.prepare();
      })().catch((err) => {
        this.starting = null;
        console.debug('[audio] start failed', err);
      });
    }
    return this.starting;
  }

  setVolume(kind: VolumeKind, v: number): void {
    this.vol[kind] = Math.max(0, Math.min(1, v));
    this.engine?.setVolume(kind, v);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.engine?.setMuted(m);
  }

  setFocus(on: boolean): void {
    this.engine?.setFocus(on);
  }

  restoreFilter(): void {
    this.engine?.restoreFilter();
  }

  suspend(): void {
    this.music_?.pause();
    this.engine?.suspend();
  }

  resume(): void {
    this.engine?.resume();
    this.music_?.unpause();
  }
}

function lazy<T extends object>(get: () => T | null): T {
  const noop = (): number => 0;
  return new Proxy({} as T, {
    get(_t, prop) {
      const real = get();
      if (!real) return noop;
      const v = (real as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  });
}
