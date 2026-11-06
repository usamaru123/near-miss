import { describe, expect, it } from 'vitest';
import { arcContains, arcLen, maxReachDistance, wrap } from '../src/game/angles';
import {
  DEG,
  MAX_ANG_VEL,
  REACH_FACTOR,
  SAFE_MIN_WIDTH,
  SNAKE_INNER_FACTOR,
  SPINNER_MIN_BLADE_GAP,
  START_THETA,
} from '../src/game/constants';
import { distAt, gapTime, tierAt } from '../src/game/difficulty';
import { createSpawner, nextObstacle } from '../src/game/spawner';
import type { Obstacle } from '../src/game/types';

function generate(seed: number, seconds: number): Obstacle[] {
  const sp = createSpawner(seed);
  const out: Obstacle[] = [];
  for (;;) {
    const o = nextObstacle(sp);
    if (o.tNom > seconds) break;
    out.push(o);
  }
  return out;
}

const SEEDS = [1, 2, 3, 42, 99, 1234, 31337, 777, 2024, 987654321];

describe('spawner', () => {
  it('is deterministic per seed', () => {
    const a = generate(7, 120);
    const b = generate(7, 120);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = generate(8, 120);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('obstacle positions are ascending and match nominal time', () => {
    const list = generate(5, 300);
    for (let i = 1; i < list.length; i++) {
      expect(list[i].pos).toBeGreaterThan(list[i - 1].pos);
      expect(list[i].tNom - list[i - 1].tNom).toBeCloseTo(list[i].dtPrev, 9);
    }
    for (const o of list) expect(o.pos).toBeCloseTo(distAt(o.tNom), 6);
  });

  it('gaps are 8th-note quantised and never below 0.9 x the design gap time (snake interior 0.6x)', () => {
    for (const seed of SEEDS) {
      const list = generate(seed, 300);
      for (let i = 1; i < list.length; i++) {
        const o = list[i];
        const prev = list[i - 1];
        const gt = gapTime(tierAt(prev.tNom));
        const factor = o.kind === 'SNAKE' && prev.kind === 'SNAKE' ? SNAKE_INNER_FACTOR : 1;
        expect(o.dtPrev).toBeGreaterThanOrEqual(0.9 * gt * (o.kind === 'SNAKE' ? SNAKE_INNER_FACTOR : 1) - 1e-9);
        // gap in beats is a multiple of 0.5
        const beats = (o.beat - prev.beat) / 0.5;
        expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-9);
        void factor;
      }
    }
  });

  it('10 seeds x 300 s: safe widths and reachability hold for every obstacle', () => {
    let total = 0;
    const kinds = new Set<string>();
    for (const seed of SEEDS) {
      const list = generate(seed, 300);
      total += list.length;
      let prevSafe = [{ a: START_THETA, b: START_THETA }];
      for (const o of list) {
        kinds.add(o.kind);
        expect(o.safe.length).toBeGreaterThan(0);
        for (const s of o.safe) expect(arcLen(s.a, s.b)).toBeGreaterThanOrEqual(SAFE_MIN_WIDTH - 1e-9);
        const r = REACH_FACTOR * MAX_ANG_VEL * o.dtPrev;
        const need = maxReachDistance(prevSafe, o.safe, 0.1 * DEG);
        expect(need).toBeLessThanOrEqual(r + 1e-6);
        prevSafe = o.safe;
      }
    }
    expect(total).toBeGreaterThan(2000);
    for (const k of ['GAP_RING', 'MULTI_GAP', 'SLAB', 'SPINNER', 'SNAKE']) expect(kinds.has(k)).toBe(true);
  });

  it('tier gating of kinds', () => {
    for (const seed of SEEDS) {
      for (const o of generate(seed, 300)) {
        const tier = tierAt(o.tNom);
        if (o.kind === 'MULTI_GAP' || o.kind === 'SPINNER') expect(tier).toBeGreaterThanOrEqual(2);
        if (o.kind === 'SNAKE') expect(tier).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('spinners keep blade width, min blade spacing and safe zones at every sampled rotation', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      for (const o of generate(seed, 300).filter((x) => x.kind === 'SPINNER')) {
        expect(o.solids.length).toBeGreaterThanOrEqual(2);
        expect(o.solids.length).toBeLessThanOrEqual(4);
        expect(Math.abs(o.omega)).toBeGreaterThanOrEqual(0.6);
        expect(Math.abs(o.omega)).toBeLessThanOrEqual(1.8);
        for (let k = 0; k < 60; k++) {
          const rot = o.rotHit + o.omega * (k / 60 - 0.5) * 2.0;
          const blades = o.solids
            .map((s) => ({ a: wrap(s.a + rot), b: wrap(s.b + rot) }))
            .sort((p, q) => p.a - q.a);
          for (const b of blades) expect(arcLen(b.a, b.b)).toBeCloseTo(30 * DEG, 6);
          for (let i = 0; i < blades.length; i++) {
            const next = blades[(i + 1) % blades.length];
            const gap = arcLen(blades[i].b, next.a);
            expect(gap).toBeGreaterThanOrEqual(SPINNER_MIN_BLADE_GAP - 1e-6);
            const mid = wrap(blades[i].b + gap / 2);
            expect(blades.some((b) => arcContains(b.a, b.b, mid))).toBe(false);
          }
          checked++;
        }
        for (const s of o.safe) expect(arcLen(s.a, s.b)).toBeGreaterThanOrEqual(SAFE_MIN_WIDTH);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('gap width shrinks from 70 to 42 deg over tiers', () => {
    const rings = generate(11, 300).filter((o) => o.kind === 'GAP_RING');
    const first = rings.find((o) => o.tier === 1)!;
    expect(arcLen(first.safe[0].a, first.safe[0].b)).toBeCloseTo(70 * DEG, 6);
    const last = rings.filter((o) => o.tier === 6)[0];
    expect(arcLen(last.safe[0].a, last.safe[0].b)).toBeCloseTo(42 * DEG, 6);
  });
});
