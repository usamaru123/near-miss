import type { SampleDef } from './manifest';

/** The subset of AudioBuffer / ToneAudioBuffer the bank needs. */
export interface BufferLike {
  duration: number;
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export type Loader<B> = (url: string) => Promise<B>;

const LOAD_TIMEOUT_MS = 20000;

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sample load timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Loads every sample of a manifest. A sample that fails to load never rejects `loadAll`;
 * it is recorded in `failed`, and `trigger()` runs the synth fallback for it instead.
 */
export class SampleBank<B extends BufferLike, K extends string = string> {
  private readonly bufs = new Map<K, { buf: B; norm: number }>();
  readonly failed = new Set<K>();
  done = 0;
  readonly total: number;

  constructor(
    private readonly defs: Record<K, SampleDef>,
    private readonly loader: Loader<B>,
    private readonly base = '',
  ) {
    this.total = Object.keys(defs).length;
  }

  async loadAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const ids = Object.keys(this.defs) as K[];
    await Promise.all(
      ids.map(async (id) => {
        try {
          const buf = await timeout(this.loader(this.base + this.defs[id].file), LOAD_TIMEOUT_MS);
          if (!buf || buf.length === 0) throw new Error('empty sample');
          this.bufs.set(id, { buf, norm: peakNorm(buf) });
        } catch {
          this.failed.add(id);
        }
        this.done++;
        onProgress?.(this.done, this.total);
      }),
    );
  }

  has(id: K): boolean {
    return this.bufs.has(id);
  }

  get(id: K): B | null {
    return this.bufs.get(id)?.buf ?? null;
  }

  /** Linear gain that brings the sample's peak to 0 dBFS, times its manifest trim. */
  gain(id: K): number {
    const e = this.bufs.get(id);
    if (!e) return 1;
    return e.norm * Math.pow(10, (this.defs[id].db ?? 0) / 20);
  }

  /** Play the sample if loaded, else run the synth fallback. Returns true when the sample was used. */
  trigger(id: K, play: (buf: B, gain: number) => void, fallback: () => void): boolean {
    const buf = this.get(id);
    if (!buf) {
      fallback();
      return false;
    }
    try {
      play(buf, this.gain(id));
      return true;
    } catch {
      fallback();
      return false;
    }
  }
}

export function peakNorm(buf: BufferLike): number {
  let pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > pk) pk = v;
    }
  }
  return pk > 1e-4 ? 1 / pk : 1;
}
