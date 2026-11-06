import { describe, expect, it } from 'vitest';
import {
  angDiff,
  angDist,
  arcCenter,
  arcContains,
  arcDistance,
  arcLen,
  arcsIntersect,
  maxReachDistance,
  safeFromSolids,
  wrap,
} from '../src/game/angles';
import { DEG, TAU } from '../src/game/constants';

describe('angles', () => {
  it('wraps into [0, 2pi)', () => {
    expect(wrap(-0.5)).toBeCloseTo(TAU - 0.5);
    expect(wrap(TAU + 0.25)).toBeCloseTo(0.25);
    expect(wrap(0)).toBe(0);
    expect(wrap(-TAU * 3 + 1)).toBeCloseTo(1);
    expect(wrap(TAU)).toBeCloseTo(0);
  });
  it('signed shortest diff crosses the seam', () => {
    expect(angDiff(350 * DEG, 10 * DEG)).toBeCloseTo(20 * DEG);
    expect(angDiff(10 * DEG, 350 * DEG)).toBeCloseTo(-20 * DEG);
    expect(angDist(1 * DEG, 359 * DEG)).toBeCloseTo(2 * DEG);
    expect(angDist(0, Math.PI)).toBeCloseTo(Math.PI);
  });
  it('arc contains across 0/2pi', () => {
    const a = 340 * DEG;
    const b = 20 * DEG;
    expect(arcLen(a, b)).toBeCloseTo(40 * DEG);
    expect(arcContains(a, b, 350 * DEG)).toBe(true);
    expect(arcContains(a, b, 5 * DEG)).toBe(true);
    expect(arcContains(a, b, 0)).toBe(true);
    expect(arcContains(a, b, 30 * DEG)).toBe(false);
    expect(arcContains(a, b, 180 * DEG)).toBe(false);
    expect(angDist(arcCenter(a, b), 0)).toBeLessThan(1e-9);
  });
  it('arc intersection incl. wrap and containment', () => {
    expect(arcsIntersect(340 * DEG, 20 * DEG, 10 * DEG, 50 * DEG)).toBe(true);
    expect(arcsIntersect(340 * DEG, 20 * DEG, 30 * DEG, 50 * DEG)).toBe(false);
    expect(arcsIntersect(10 * DEG, 50 * DEG, 340 * DEG, 20 * DEG)).toBe(true);
    expect(arcsIntersect(0, 180 * DEG, 40 * DEG, 60 * DEG)).toBe(true);
    expect(arcsIntersect(40 * DEG, 60 * DEG, 0, 180 * DEG)).toBe(true);
    expect(arcsIntersect(300 * DEG, 100 * DEG, 355 * DEG, 5 * DEG)).toBe(true);
  });
  it('arc distance', () => {
    expect(arcDistance(0, 10 * DEG, 5 * DEG, 20 * DEG)).toBe(0);
    expect(arcDistance(0, 10 * DEG, 14 * DEG, 20 * DEG)).toBeCloseTo(4 * DEG);
    expect(arcDistance(350 * DEG, 355 * DEG, 5 * DEG, 10 * DEG)).toBeCloseTo(10 * DEG);
    expect(arcDistance(20 * DEG, 30 * DEG, 355 * DEG, 5 * DEG)).toBeCloseTo(15 * DEG);
  });
  it('safe arcs are the complement of solids', () => {
    const safe = safeFromSolids([{ a: 30 * DEG, b: 350 * DEG }], 0);
    expect(safe).toHaveLength(1);
    expect(arcContains(safe[0].a, safe[0].b, 0)).toBe(true);
    expect(arcLen(safe[0].a, safe[0].b)).toBeCloseTo(40 * DEG);
    const rotated = safeFromSolids(
      [
        { a: 0, b: 30 * DEG },
        { a: 180 * DEG, b: 210 * DEG },
      ],
      90 * DEG,
    );
    expect(rotated).toHaveLength(2);
    expect(rotated.reduce((s, x) => s + arcLen(x.a, x.b), 0)).toBeCloseTo(TAU - 60 * DEG);
  });
  it('max reach distance', () => {
    const from = [{ a: 0, b: 40 * DEG }];
    const to = [{ a: 60 * DEG, b: 100 * DEG }];
    expect(maxReachDistance(from, to, 0.1 * DEG)).toBeCloseTo(60 * DEG, 2);
    expect(maxReachDistance(to, from, 0.1 * DEG)).toBeCloseTo(60 * DEG, 2);
    expect(maxReachDistance(from, from, 0.1 * DEG)).toBe(0);
  });
});
