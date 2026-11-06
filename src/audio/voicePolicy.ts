/**
 * Pure voice-allocation policy (no Web Audio): per-sound polyphony cap with oldest-voice stealing, and merging
 * of identical triggers that arrive within a short window. Kept separate so it can be unit-tested.
 */
export interface VoiceRequest {
  /** the new voice should not be started: an identical one just played */
  merged: boolean;
  /** token of the oldest voice that must be faded out to make room */
  steal: number | null;
  /** token of the new voice (0 when merged) */
  token: number;
}

interface Entry {
  token: number;
  start: number;
  end: number;
}

export class VoiceBook<K> {
  private readonly active = new Map<K, Entry[]>();
  private readonly lastStart = new Map<K, number>();
  private nextToken = 1;

  constructor(
    readonly maxPoly = 3,
    readonly mergeWindow = 0.03,
  ) {}

  request(id: K, start: number, end: number): VoiceRequest {
    const last = this.lastStart.get(id);
    if (last !== undefined && Math.abs(start - last) < this.mergeWindow) return { merged: true, steal: null, token: 0 };
    this.lastStart.set(id, start);
    let list = this.active.get(id);
    if (!list) {
      list = [];
      this.active.set(id, list);
    }
    let w = 0;
    for (let i = 0; i < list.length; i++) if (list[i].end > start) list[w++] = list[i];
    list.length = w;
    let steal: number | null = null;
    if (list.length >= this.maxPoly) {
      let oi = 0;
      for (let i = 1; i < list.length; i++) if (list[i].start < list[oi].start) oi = i;
      steal = list[oi].token;
      list.splice(oi, 1);
    }
    const token = this.nextToken++;
    list.push({ token, start, end });
    return { merged: false, steal, token };
  }

  count(id: K, at: number): number {
    return (this.active.get(id) ?? []).filter((e) => e.end > at).length;
  }
}

/**
 * Overlap ducking: every effect adds load that decays over `tau` seconds. The returned gain (<= 1) is applied to
 * the music (and, lightly, to the effects bus) so that many simultaneous sounds make room instead of summing up.
 */
export class DuckModel {
  private load = 0;
  private lastT = 0;

  constructor(
    private readonly tau = 0.3,
    private readonly free = 1.5,
    private readonly k = 0.22,
    private readonly floor = 0.45,
  ) {}

  add(t: number, weight: number): number {
    this.load = this.load * Math.exp(-Math.max(0, t - this.lastT) / this.tau) + weight;
    this.lastT = Math.max(this.lastT, t);
    return this.gain();
  }

  gain(): number {
    return Math.max(this.floor, 1 / (1 + this.k * Math.max(0, this.load - this.free)));
  }

  reset(): void {
    this.load = 0;
    this.lastT = 0;
  }
}
