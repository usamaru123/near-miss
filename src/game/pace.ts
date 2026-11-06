// Ghost + personal-best pace (DESIGN 15.2). Pure logic: no DOM / storage access in here.
import { angDiff, wrap } from './angles';
import {
  GHOST_REL_PER_UNIT,
  GHOST_SCORE_PER_UNIT,
  GHOST_Z_MAX,
  GHOST_Z_MIN,
  OVERTAKE_MAX,
  TAU,
  TRACE_HZ,
  TRACE_MAX_SECONDS,
} from './constants';

export const TRACE_MAX_SAMPLES = TRACE_MAX_SECONDS * TRACE_HZ;
const THETA_STEPS = 4096; // 12 bit angle quantisation (0.088 deg)

/** A recorded run: theta and score sampled at TRACE_HZ, quantised. */
export interface Trace {
  /** quantised theta, 0..THETA_STEPS-1 */
  th: number[];
  /** score at each sample (integer) */
  sc: number[];
  /** final score of the run */
  final: number;
}

export function emptyTrace(): Trace {
  return { th: [], sc: [], final: 0 };
}

/** Time covered by a trace in sim seconds. */
export function traceDuration(tr: Trace): number {
  return Math.max(0, tr.th.length - 1) / TRACE_HZ;
}

/** Record a sample whenever sim time `t` reaches the next 10 Hz slot. Returns true if one was stored. */
export function recordSample(tr: Trace, t: number, theta: number, score: number): boolean {
  if (tr.th.length >= TRACE_MAX_SAMPLES) return false;
  const idx = Math.floor(t * TRACE_HZ + 1e-9);
  let stored = false;
  while (tr.th.length <= idx && tr.th.length < TRACE_MAX_SAMPLES) {
    tr.th.push(Math.round((wrap(theta) / TAU) * THETA_STEPS) % THETA_STEPS);
    tr.sc.push(Math.max(0, Math.round(score)));
    stored = true;
  }
  return stored;
}

function thetaOf(q: number): number {
  return (q / THETA_STEPS) * TAU;
}

export interface TraceSample {
  theta: number;
  score: number;
  /** false once the trace has ended */
  live: boolean;
}

const tmp: TraceSample = { theta: 0, score: 0, live: false };

/** Interpolated theta / score at sim time t. After the end: last theta, the final score, live = false. */
export function sampleAt(tr: Trace, t: number, out: TraceSample = tmp): TraceSample {
  const n = tr.th.length;
  if (n === 0) {
    out.theta = 0;
    out.score = tr.final;
    out.live = false;
    return out;
  }
  const f = Math.max(0, t) * TRACE_HZ;
  const i = Math.floor(f);
  if (i >= n - 1) {
    out.theta = thetaOf(tr.th[n - 1]);
    out.score = Math.max(tr.final, tr.sc[n - 1]);
    out.live = false;
    return out;
  }
  const k = f - i;
  const a = thetaOf(tr.th[i]);
  const b = thetaOf(tr.th[i + 1]);
  out.theta = wrap(a + angDiff(a, b) * k);
  out.score = tr.sc[i] + (tr.sc[i + 1] - tr.sc[i]) * k;
  out.live = true;
  return out;
}

/** Score difference vs. the best at the same time (positive = ahead of the best). */
export function paceDiff(tr: Trace, t: number, score: number): number {
  return score - sampleAt(tr, t).score;
}

/**
 * Ghost depth from the score difference: best ahead -> in front (negative z), clamped to [-14, +3].
 * One world unit is 300 points, or 5 % of the best's score at that time once scores have inflated
 * (`ref` = the best's score then), so the ghost keeps moving sensibly at 1,000 or at 10^12 points.
 */
export function ghostZ(diff: number, ref = 0): number {
  const unit = Math.max(GHOST_SCORE_PER_UNIT, ref * GHOST_REL_PER_UNIT);
  return Math.max(GHOST_Z_MIN, Math.min(GHOST_Z_MAX, diff / unit));
}

// ---------------------------------------------------------------- persistence

/** Compact JSON: {v,f,t:[...],s:[...]} with the scores delta-encoded. */
export function serializeTrace(tr: Trace): string {
  const d: number[] = [];
  let prev = 0;
  for (const v of tr.sc) {
    d.push(v - prev);
    prev = v;
  }
  return JSON.stringify({ v: 1, f: tr.final, t: tr.th, s: d });
}

export function parseTrace(raw: string | null): Trace | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v?: number; f?: unknown; t?: unknown; s?: unknown };
    if (o.v !== 1 || !Array.isArray(o.t) || !Array.isArray(o.s) || typeof o.f !== 'number') return null;
    if (o.t.length !== o.s.length || o.t.length > TRACE_MAX_SAMPLES) return null;
    const th: number[] = [];
    const sc: number[] = [];
    let acc = 0;
    for (let i = 0; i < o.t.length; i++) {
      const a = o.t[i];
      const b = o.s[i];
      if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return null;
      th.push(a);
      acc += b;
      sc.push(acc);
    }
    return { th, sc, final: o.f };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- per-run tracker

export interface PaceUpdate {
  /** score - best score at the same time; 0 without a best */
  diff: number;
  hasBest: boolean;
  ghostVisible: boolean;
  ghostTheta: number;
  ghostZ: number;
  /** just crossed from behind to ahead of the best (max OVERTAKE_MAX per run) */
  overtake: boolean;
  /** just passed the best's final score (once per run) */
  newRecord: boolean;
}

/** Tracks one run against the stored best. Allocation-free after construction. */
export class PaceTracker {
  readonly out: PaceUpdate = {
    diff: 0,
    hasBest: false,
    ghostVisible: false,
    ghostTheta: 0,
    ghostZ: 0,
    overtake: false,
    newRecord: false,
  };
  readonly recording: Trace = emptyTrace();
  private prevDiff = 0;
  private overtakes = 0;
  private recordShown = false;
  private readonly smp: TraceSample = { theta: 0, score: 0, live: false };

  constructor(
    private readonly best: Trace | null,
    private readonly bestScore: number,
  ) {}

  get hasTrace(): boolean {
    return this.best !== null && this.best.th.length > 1;
  }

  get overtakeCount(): number {
    return this.overtakes;
  }

  /**
   * Call once per rendered frame (or sim step) with the sim time, score and ship angle.
   * `live` (default = score) is what is compared with the best: during a ZONE it is score + BANK, because the
   * banked points are on their way into the score; the recorded trace always holds the real, banked score.
   */
  update(t: number, score: number, theta: number, live = score): PaceUpdate {
    const o = this.out;
    o.overtake = false;
    o.newRecord = false;
    recordSample(this.recording, t, theta, score);
    const tr = this.best;
    if (tr && this.hasTrace) {
      const s = sampleAt(tr, t, this.smp);
      const diff = live - s.score;
      o.hasBest = true;
      o.diff = diff;
      o.ghostVisible = s.live;
      o.ghostTheta = s.theta;
      o.ghostZ = ghostZ(diff, s.score);
      if (s.live && this.prevDiff < 0 && diff >= 0 && this.overtakes < OVERTAKE_MAX) {
        this.overtakes++;
        o.overtake = true;
      }
      this.prevDiff = diff;
    } else {
      o.hasBest = false;
      o.diff = 0;
      o.ghostVisible = false;
    }
    if (!this.recordShown && this.bestScore > 0 && live > this.bestScore) {
      this.recordShown = true;
      o.newRecord = true;
    }
    return o;
  }

  /** Finish the run: the trace to store (when it is a new best). */
  finish(finalScore: number): Trace {
    const fin = Math.floor(finalScore);
    this.recording.final = fin;
    // a ZONE that ended in death never paid its BANK: samples may not claim more than the final score
    const sc = this.recording.sc;
    for (let i = sc.length - 1; i >= 0 && sc[i] > fin; i--) sc[i] = fin;
    return this.recording;
  }
}

/** Game-over summary text data. */
export function resultVsBest(score: number, best: number): { beat: boolean; delta: number; pct: number } {
  if (score > best) return { beat: true, delta: Math.floor(score - best), pct: 1 };
  return { beat: false, delta: Math.ceil(best - score), pct: best > 0 ? Math.max(0, Math.min(1, score / best)) : 0 };
}
