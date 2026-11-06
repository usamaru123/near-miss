import { describe, expect, it } from 'vitest';
import { GHOST_Z_MAX, GHOST_Z_MIN, OVERTAKE_MAX } from '../src/game/constants';
import {
  PaceTracker,
  TRACE_MAX_SAMPLES,
  emptyTrace,
  ghostZ,
  paceDiff,
  parseTrace,
  recordSample,
  resultVsBest,
  sampleAt,
  serializeTrace,
  traceDuration,
} from '../src/game/pace';
import type { Trace } from '../src/game/pace';

/** A trace for a run that scores `rate` points per second and circles at `w` rad/s. */
function makeTrace(seconds: number, rate: number, w = 0.5): Trace {
  const tr = emptyTrace();
  for (let i = 0; i <= seconds * 10; i++) recordSample(tr, i / 10, 1 + w * (i / 10), rate * (i / 10));
  tr.final = Math.round(rate * seconds);
  return tr;
}

describe('pace: recording and interpolation', () => {
  it('records at 10 Hz, quantised', () => {
    const tr = emptyTrace();
    for (let i = 0; i < 1200; i++) recordSample(tr, i / 120, 1.2345, i * 3.3);
    expect(tr.th.length).toBe(100);
    expect(tr.th[0]).toBe(Math.round((1.2345 / (2 * Math.PI)) * 4096));
    expect(Number.isInteger(tr.sc[5])).toBe(true);
    expect(traceDuration(tr)).toBeCloseTo(9.9, 9);
  });
  it('caps at 15 minutes', () => {
    const tr = emptyTrace();
    for (let i = 0; i < TRACE_MAX_SAMPLES + 500; i++) recordSample(tr, i / 10, 0, i);
    expect(tr.th.length).toBe(TRACE_MAX_SAMPLES);
    expect(recordSample(tr, 99999, 0, 1)).toBe(false);
  });
  it('interpolates score and theta (shortest way round) and holds the final score afterwards', () => {
    const tr = emptyTrace();
    recordSample(tr, 0, 6.2, 0);
    recordSample(tr, 0.1, 0.1, 1000);
    tr.final = 5000;
    const mid = sampleAt(tr, 0.05);
    expect(mid.score).toBeCloseTo(500, 6);
    // 6.2 -> 0.1 goes up through 2pi: the midpoint is near 6.2 + 0.0916, not near pi
    const around = (mid.theta + 2 * Math.PI) % (2 * Math.PI);
    expect(Math.abs(around - (6.2 + 0.0916) % (2 * Math.PI))).toBeLessThan(0.05);
    expect(sampleAt(tr, 10).live).toBe(false);
    expect(sampleAt(tr, 10).score).toBe(5000);
  });
  it('diff and ghost depth: best ahead -> in front, clamped to [-14, +3]', () => {
    const tr = makeTrace(60, 1000);
    expect(paceDiff(tr, 10, 12000)).toBeCloseTo(2000, 6);
    expect(paceDiff(tr, 10, 9000)).toBeCloseTo(-1000, 6);
    expect(ghostZ(-300)).toBeCloseTo(-1, 9);
    expect(ghostZ(-1e9)).toBe(GHOST_Z_MIN);
    expect(ghostZ(1e9)).toBe(GHOST_Z_MAX);
    expect(ghostZ(0)).toBe(0);
  });
});

describe('pace: tracker events', () => {
  function runThrough(tracker: PaceTracker, scoreAt: (t: number) => number, seconds: number): { over: number; rec: number } {
    let over = 0;
    let rec = 0;
    for (let i = 0; i <= seconds * 60; i++) {
      const t = i / 60;
      const u = tracker.update(t, scoreAt(t), 1);
      if (u.overtake) over++;
      if (u.newRecord) rec++;
    }
    return { over, rec };
  }
  it('OVERTAKE fires when the diff goes from negative to positive, at most 3 times per run', () => {
    const best = makeTrace(60, 1000);
    const tr = new PaceTracker(best, best.final);
    const r = runThrough(tr, (t) => 1000 * t + 800 * Math.sin(t * 3), 50);
    expect(r.over).toBe(OVERTAKE_MAX);
    const tr2 = new PaceTracker(best, best.final);
    const r2 = runThrough(tr2, (t) => 600 * t + 40 * t * t, 50);
    expect(r2.over).toBe(1);
  });
  it('live NEW RECORD fires once when the best final score is passed, never without a best', () => {
    const best = makeTrace(30, 1000);
    const tr = new PaceTracker(best, best.final);
    const r = runThrough(tr, (t) => 2000 * t, 40);
    expect(r.rec).toBe(1);
    const none = new PaceTracker(null, 0);
    const r0 = runThrough(none, (t) => 2000 * t, 40);
    expect(r0.rec).toBe(0);
    expect(none.out.hasBest).toBe(false);
  });
  it('shows a ghost while the best is still running and hides it afterwards', () => {
    const best = makeTrace(10, 1000);
    const tr = new PaceTracker(best, best.final);
    expect(tr.update(5, 3000, 1).ghostVisible).toBe(true);
    expect(tr.update(20, 3000, 1).ghostVisible).toBe(false);
    expect(tr.out.diff).toBeCloseTo(3000 - best.final, 6);
  });
  it('the run is recorded as it goes and can be finished into a trace', () => {
    const tr = new PaceTracker(null, 0);
    for (let i = 0; i < 600; i++) tr.update(i / 60, i * 10, 2);
    const t = tr.finish(12345.9);
    expect(t.final).toBe(12345);
    expect(t.th.length).toBeGreaterThanOrEqual(99);
  });
});

describe('pace: storage', () => {
  it('serialises and parses losslessly, and stays small', () => {
    const tr = makeTrace(300, 1500, 0.7);
    const back = parseTrace(serializeTrace(tr));
    expect(back).not.toBeNull();
    expect(back!.th).toEqual(tr.th);
    expect(back!.sc).toEqual(tr.sc);
    expect(back!.final).toBe(tr.final);
    const long = makeTrace(900, 5000, 0.7);
    expect(long.th.length).toBe(9000);
    expect(serializeTrace(long).length).toBeLessThan(150_000);
  });
  it('rejects garbage', () => {
    expect(parseTrace(null)).toBeNull();
    expect(parseTrace('nope')).toBeNull();
    expect(parseTrace('{"v":2}')).toBeNull();
    expect(parseTrace('{"v":1,"f":1,"t":[1,2],"s":[1]}')).toBeNull();
    expect(parseTrace('{"v":1,"f":1,"t":[1,"x"],"s":[1,2]}')).toBeNull();
  });
  it('game-over summary', () => {
    expect(resultVsBest(5000, 12000)).toEqual({ beat: false, delta: 7000, pct: 5000 / 12000 });
    expect(resultVsBest(13000, 12000)).toEqual({ beat: true, delta: 1000, pct: 1 });
  });
});
