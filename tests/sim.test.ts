import { describe, expect, it } from 'vitest';
import { classifyNearMiss, createState, forceDeath, multiplierFor, step } from '../src/game/sim';
import {
  COMBO_TIMEOUT,
  DEG,
  FOCUS_TIMESCALE,
  HIT_WINDOW,
  KMH_FACTOR,
  OVERDRIVE_DURATION,
  OVERDRIVE_GRACE,
  SIM_DT,
  SPEED_MAX,
} from '../src/game/constants';
import { speedAt, tierAt } from '../src/game/difficulty';
import { makeObstacle } from '../src/game/spawner';
import type { Arc, GameEvent, GameState, Input } from '../src/game/types';

const idle = (): Input => ({ move: 0, focus: false, overdrive: false });

function fresh(): GameState {
  const s = createState(1);
  s.spawnEnabled = false;
  // the legacy tests below predate beat scoring and CLUTCH: keep both out of the way
  s.beatBonus = false;
  s.clutch.lastStart = 0; // on cooldown for the first 8 s
  return s;
}

let nextId = 1000;
function place(s: GameState, solids: Arc[], ahead = 12): void {
  const o = makeObstacle(nextId++, 'SLAB', s.dist + ahead, solids);
  o.z = -ahead;
  s.obstacles.push(o);
}

/** Step until all obstacles are gone (or death finished); collect events. */
function run(s: GameState, input: Input = idle(), maxSteps = 5000): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < maxSteps && s.obstacles.length > 0; i++) {
    all.push(...step(s, input, SIM_DT));
  }
  return all;
}

/** A single solid arc whose nearest edge is `d` radians away from the ship hit arc edge. */
function slabAtDistance(s: GameState, d: number): Arc[] {
  const start = s.theta + 6 * DEG + d;
  return [{ a: start, b: start + 90 * DEG }];
}

describe('speed curve and tiers', () => {
  it('speed(t) = min(50 + 1.4t, 180)', () => {
    expect(speedAt(0)).toBe(50);
    expect(speedAt(10)).toBeCloseTo(64);
    expect(speedAt(92)).toBeCloseTo(178.8);
    expect(speedAt(93)).toBe(SPEED_MAX);
    expect(speedAt(500)).toBe(SPEED_MAX);
    expect(SPEED_MAX).toBe(180);
    expect(SPEED_MAX * KMH_FACTOR).toBe(1620);
  });
  it('tiers advance every 25 s up to 6', () => {
    expect(tierAt(0)).toBe(1);
    expect(tierAt(24.99)).toBe(1);
    expect(tierAt(25)).toBe(2);
    expect(tierAt(100)).toBe(5);
    expect(tierAt(125)).toBe(6);
    expect(tierAt(999)).toBe(6);
  });
  it('sim emits tierUp events at the boundaries and tracks speed', () => {
    const s = fresh();
    const tiers: number[] = [];
    for (let i = 0; i < 26 * 120; i++) {
      for (const e of step(s, idle(), SIM_DT)) if (e.type === 'tierUp') tiers.push(e.tier);
    }
    expect(tiers).toEqual([2]);
    expect(s.tier).toBe(2);
    expect(s.speed).toBeCloseTo(speedAt(s.t), 6);
    expect(s.t).toBeCloseTo(26, 3);
  });
});

describe('collision', () => {
  it('colliding kills the ship', () => {
    const s = fresh();
    place(s, [{ a: s.theta - 20 * DEG, b: s.theta + 20 * DEG }]);
    const ev = run(s);
    expect(s.alive).toBe(false);
    expect(ev.some((e) => e.type === 'death')).toBe(true);
  });
  it('handles obstacle arcs that straddle 0/2pi', () => {
    const s = fresh();
    s.theta = 2 * DEG;
    place(s, [{ a: 350 * DEG, b: 10 * DEG }]);
    run(s);
    expect(s.alive).toBe(false);

    const s2 = fresh();
    s2.theta = 359 * DEG;
    place(s2, [{ a: 3 * DEG, b: 100 * DEG }]); // ship spans 353..5 deg -> overlaps at 3..5
    run(s2);
    expect(s2.alive).toBe(false);

    const s3 = fresh();
    s3.theta = 180 * DEG;
    place(s3, [{ a: 350 * DEG, b: 10 * DEG }]);
    run(s3);
    expect(s3.alive).toBe(true);
  });
  it('does not collide when the Z slab does not overlap yet', () => {
    const s = fresh();
    place(s, [{ a: s.theta - 20 * DEG, b: s.theta + 20 * DEG }], 100);
    for (let i = 0; i < 10; i++) step(s, idle(), SIM_DT);
    expect(s.alive).toBe(true);
  });
  it('even at max overdrive step size an obstacle cannot be tunnelled through', () => {
    const s = fresh();
    s.t = 200;
    s.dist = 1000;
    s.speed = SPEED_MAX;
    place(s, [{ a: s.theta - 20 * DEG, b: s.theta + 20 * DEG }], 1);
    run(s);
    expect(s.alive).toBe(false);
  });
  it('invincible ignores collisions', () => {
    const s = fresh();
    s.invincible = true;
    place(s, [{ a: s.theta - 20 * DEG, b: s.theta + 20 * DEG }]);
    const ev = run(s);
    expect(s.alive).toBe(true);
    expect(ev.some((e) => e.type === 'nearMiss' || e.type === 'insane')).toBe(false);
  });
  it('death triggers slow-mo for 1 s and then deathDone; forceDeath works', () => {
    const s = fresh();
    const ev = forceDeath(s);
    expect(ev.map((e) => e.type)).toEqual(['death']);
    expect(s.alive).toBe(false);
    step(s, idle(), SIM_DT);
    expect(s.timeScale).toBeCloseTo(0.08);
    expect(s.deathDone).toBe(false);
    for (let i = 0; i < 125; i++) step(s, idle(), SIM_DT);
    expect(s.deathDone).toBe(true);
  });
});

describe('near miss', () => {
  it('classification boundaries are strict (< 4deg INSANE, < 10deg NEAR)', () => {
    expect(classifyNearMiss(0.1 * DEG)).toBe('insane');
    expect(classifyNearMiss(3.99 * DEG)).toBe('insane');
    expect(classifyNearMiss(4 * DEG)).toBe('near');
    expect(classifyNearMiss(9.99 * DEG)).toBe('near');
    expect(classifyNearMiss(10 * DEG)).toBe('none');
    expect(classifyNearMiss(40 * DEG)).toBe('none');
  });
  it('INSANE at 3.9deg: +1500 x mult, adrenaline +0.25, focus capped', () => {
    const s = fresh();
    s.focus = 0.5;
    place(s, slabAtDistance(s, 3.9 * DEG));
    const ev = run(s);
    const e = ev.find((x) => x.type === 'insane');
    expect(e).toBeDefined();
    expect(s.alive).toBe(true);
    expect(s.combo).toBe(1);
    expect(s.adrenaline).toBeGreaterThan(0.24);
    expect(s.adrenaline).toBeLessThanOrEqual(0.25);
    expect(s.focus).toBeGreaterThan(0.69);
    if (e && e.type === 'insane') expect(e.points).toBe(1500);
  });
  it('NEAR MISS at 4.1deg and 9.9deg; none at 10.1deg', () => {
    for (const [d, expected] of [
      [4.1, 'nearMiss'],
      [9.9, 'nearMiss'],
      [10.1, null],
    ] as const) {
      const s = fresh();
      place(s, slabAtDistance(s, d * DEG));
      const ev = run(s);
      const hit = ev.find((x) => x.type === 'nearMiss' || x.type === 'insane');
      expect(hit?.type ?? null).toBe(expected);
      if (expected) {
        expect(s.adrenaline).toBeGreaterThan(0.11);
        if (hit && hit.type === 'nearMiss') expect(hit.points).toBe(500);
      } else {
        expect(s.combo).toBe(0);
      }
    }
  });
  it('works across the 0/2pi seam on the other side', () => {
    const s = fresh();
    s.theta = 1 * DEG;
    // solid ends 8deg before the ship hit arc start (-5deg) => 6deg gap... at 349..: end = -5-6 = -11 => 349
    place(s, [{ a: 200 * DEG, b: 349 * DEG }]);
    const ev = run(s);
    expect(ev.some((e) => e.type === 'nearMiss')).toBe(true);
  });
});

describe('combo and multiplier', () => {
  it('multiplier = 1 + floor(combo/4), capped at 8', () => {
    expect(multiplierFor(0)).toBe(1);
    expect(multiplierFor(3)).toBe(1);
    expect(multiplierFor(4)).toBe(2);
    expect(multiplierFor(27)).toBe(7);
    expect(multiplierFor(28)).toBe(8);
    expect(multiplierFor(500)).toBe(8);
  });
  it('combo grows per near miss and multiplier applies to score', () => {
    const s = fresh();
    for (let i = 0; i < 4; i++) {
      place(s, slabAtDistance(s, 7 * DEG), 6 + i * 5);
    }
    const ev: GameEvent[] = [];
    for (let i = 0; i < 2000 && s.obstacles.length > 0; i++) ev.push(...step(s, idle(), SIM_DT));
    expect(s.combo).toBe(4);
    expect(s.multiplier).toBe(2);
    const pts = ev.filter((e) => e.type === 'nearMiss').map((e) => (e.type === 'nearMiss' ? e.points : 0));
    expect(pts).toEqual([500, 500, 500, 1000]);
  });
  it('combo breaks 3 s after the last near miss', () => {
    const s = fresh();
    place(s, slabAtDistance(s, 7 * DEG));
    run(s);
    expect(s.combo).toBe(1);
    let broke = false;
    let t = 0;
    while (t < COMBO_TIMEOUT - 0.1) {
      step(s, idle(), SIM_DT);
      t += SIM_DT;
    }
    expect(s.combo).toBe(1);
    for (let i = 0; i < 40; i++) {
      for (const e of step(s, idle(), SIM_DT)) if (e.type === 'comboBreak') broke = true;
    }
    expect(broke).toBe(true);
    expect(s.combo).toBe(0);
    expect(s.multiplier).toBe(1);
  });
  it('running score accrues speed x multiplier per second', () => {
    const s = fresh();
    for (let i = 0; i < 120; i++) step(s, idle(), SIM_DT);
    const expected = (50 + 50.7) / 2; // average speed over the first second
    expect(s.score).toBeGreaterThan(expected * 0.95);
    expect(s.score).toBeLessThan(expected * 1.05);
  });
});

describe('overdrive', () => {
  it('cannot start unless the gauge is full', () => {
    const s = fresh();
    s.adrenaline = 0.8;
    const ev = step(s, { move: 0, focus: false, overdrive: true }, SIM_DT);
    expect(ev.some((e) => e.type === 'overdriveStart')).toBe(false);
    expect(s.overdrive).toBe(false);
    s.adrenaline = 1;
    const ev2 = step(s, { move: 0, focus: false, overdrive: true }, SIM_DT);
    expect(ev2.some((e) => e.type === 'overdriveStart')).toBe(true);
    expect(s.overdrive).toBe(true);
    expect(s.adrenaline).toBe(0);
    expect(s.speed).toBeCloseTo(speedAt(s.t) * 1.6, 6);
  });
  it('smashes obstacles for +1000 x multiplier instead of dying', () => {
    const s = fresh();
    s.adrenaline = 1;
    s.multiplier = 3;
    step(s, { move: 0, focus: false, overdrive: true }, SIM_DT);
    place(s, [{ a: s.theta - 20 * DEG, b: s.theta + 20 * DEG }]);
    const before = s.score;
    const ev = run(s);
    expect(s.alive).toBe(true);
    const smash = ev.find((e) => e.type === 'smash');
    expect(smash).toBeDefined();
    expect(s.score - before).toBeGreaterThanOrEqual(3000);
  });
  it('lasts 5 s, emits overdriveEnd, then gives 0.6 s grace', () => {
    const s = fresh();
    s.adrenaline = 1;
    step(s, { move: 0, focus: false, overdrive: true }, SIM_DT);
    let ended = -1;
    let steps = 0;
    while (ended < 0 && steps < 1000) {
      steps++;
      for (const e of step(s, idle(), SIM_DT)) if (e.type === 'overdriveEnd') ended = steps;
    }
    expect(ended * SIM_DT).toBeGreaterThan(OVERDRIVE_DURATION - 0.05);
    expect(ended * SIM_DT).toBeLessThan(OVERDRIVE_DURATION + 0.05);
    expect(s.graceT).toBeGreaterThan(OVERDRIVE_GRACE - 0.05);
    // collision during grace does not kill
    place(s, [{ a: s.theta - 20 * DEG, b: s.theta + 20 * DEG }], 4);
    for (let i = 0; i < 20; i++) step(s, idle(), SIM_DT);
    expect(s.alive).toBe(true);
  });
});

describe('focus', () => {
  it('slows time to 0.35, drains 0.33/s and auto-releases at zero', () => {
    const s = fresh();
    const held: Input = { move: 0, focus: true, overdrive: false };
    const ev = step(s, held, SIM_DT);
    expect(ev.some((e) => e.type === 'focusStart')).toBe(true);
    expect(s.timeScale).toBe(FOCUS_TIMESCALE);
    for (let i = 0; i < 120; i++) step(s, held, SIM_DT);
    expect(s.focus).toBeGreaterThan(1 - 0.33 * 1.05);
    expect(s.focus).toBeLessThan(1 - 0.33 * 0.95);
    let ended = false;
    for (let i = 0; i < 4 * 120; i++) for (const e of step(s, held, SIM_DT)) if (e.type === 'focusEnd') ended = true;
    expect(ended).toBe(true);
    expect(s.focusActive).toBe(false);
    expect(s.timeScale).toBe(1);
    expect(s.focus).toBeLessThan(0.1);
    // stays released while the key is still held; re-engages after release
    for (let i = 0; i < 60; i++) step(s, held, SIM_DT);
    expect(s.focusActive).toBe(false);
  });
  it('regenerates and is unavailable during overdrive', () => {
    const s = fresh();
    s.focus = 0.5;
    for (let i = 0; i < 120; i++) step(s, idle(), SIM_DT);
    expect(s.focus).toBeCloseTo(0.55, 2);
    s.adrenaline = 1;
    step(s, { move: 0, focus: true, overdrive: true }, SIM_DT);
    expect(s.overdrive).toBe(true);
    expect(s.focusActive).toBe(false);
    expect(s.timeScale).toBe(1);
  });
  it('world time passes slower under focus', () => {
    const a = fresh();
    const b = fresh();
    for (let i = 0; i < 120; i++) {
      step(a, idle(), SIM_DT);
      step(b, { move: 0, focus: true, overdrive: false }, SIM_DT);
    }
    expect(b.t).toBeCloseTo(a.t * FOCUS_TIMESCALE, 2);
  });
});

describe('ship movement', () => {
  it('accelerates at 30 rad/s^2 to a 4.2 rad/s cap and decelerates at 40 rad/s^2', () => {
    const s = fresh();
    const right: Input = { move: 1, focus: false, overdrive: false };
    for (let i = 0; i < 12; i++) step(s, right, SIM_DT);
    expect(s.angVel).toBeCloseTo(3.0, 1);
    for (let i = 0; i < 60; i++) step(s, right, SIM_DT);
    expect(s.angVel).toBeCloseTo(4.2, 6);
    for (let i = 0; i < 6; i++) step(s, idle(), SIM_DT);
    expect(s.angVel).toBeCloseTo(4.2 - 40 * 0.05, 1);
    for (let i = 0; i < 30; i++) step(s, idle(), SIM_DT);
    expect(s.angVel).toBe(0);
  });
});

describe('misc', () => {
  it('hit window is half obstacle thickness + half ship thickness', () => {
    expect(HIT_WINDOW).toBeCloseTo(0.7);
  });
  it('same seed => identical sim trajectory', () => {
    const run1 = (): number => {
      const s = createState(55);
      s.invincible = true;
      for (let i = 0; i < 2000; i++) step(s, { move: Math.sin(i / 50), focus: false, overdrive: false }, SIM_DT);
      return s.score + s.obstacles.length;
    };
    expect(run1()).toBe(run1());
  });
});

describe('adrenaline hold at full', () => {
  it('a full gauge does not decay, so OVERDRIVE stays available', async () => {
    const { createState, step } = await import('../src/game/sim');
    const s = createState(7);
    s.adrenaline = 1;
    s.invincible = true;
    const idle = { move: 0, overdrive: false, focus: false };
    for (let i = 0; i < 120 * 5; i++) step(s, idle, 1 / 120);
    expect(s.alive).toBe(true);
    expect(s.adrenaline).toBeGreaterThanOrEqual(0.999);
  });
});
