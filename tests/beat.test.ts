import { describe, expect, it } from 'vitest';
import {
  BEAT_STREAK_SCORE,
  DEG,
  HIT_WINDOW,
  HITSTOP_CAP_PER_SEC,
  HITSTOP_TIMESCALE,
  INSANE_SCORE,
  NEAR_SCORE,
  ONBEAT_MULT,
  SIM_DT,
} from '../src/game/constants';
import { beatAt, bpmAt, bpmAtSpeed, distAt, gridOffsetSec, isOnBeat, quantizeGapBeat, speedAt, timeAtBeat } from '../src/game/difficulty';
import { createState, requestHitStop, step } from '../src/game/sim';
import { makeObstacle } from '../src/game/spawner';
import { speedFactor } from '../src/game/style';
import type { GameEvent, GameState, Input } from '../src/game/types';

const SEEDS = [1, 2, 3, 42, 99, 1234, 31337, 777, 2024, 987654321];
const idle = (): Input => ({ move: 0, focus: false, overdrive: false });

describe('continuous BPM and the closed-form beat clock', () => {
  it('BPM = 140 + (speed - 50) * 45 / 130 : 140 -> 185', () => {
    expect(bpmAtSpeed(50)).toBeCloseTo(140, 9);
    expect(bpmAtSpeed(180)).toBeCloseTo(185, 9);
    expect(bpmAt(0)).toBeCloseTo(140, 9);
    expect(bpmAt(200)).toBeCloseTo(185, 9);
    expect(bpmAtSpeed(115)).toBeCloseTo(162.5, 9);
  });
  it('beatAt is the integral of BPM/60 and timeAtBeat inverts it', () => {
    for (const end of [3, 40, 92, 93, 150, 400]) {
      const n = 200000;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += bpmAt(((i + 0.5) / n) * end) / 60;
      expect(beatAt(end)).toBeCloseTo((sum * end) / n, 3);
      expect(timeAtBeat(beatAt(end))).toBeCloseTo(end, 9);
    }
  });
  it('the sim integrates the same clock (beatPos == beatAt(t), BPM follows the base speed)', () => {
    const s = createState(5);
    s.spawnEnabled = false;
    for (let i = 0; i < 120 * 30; i++) step(s, idle(), SIM_DT);
    expect(s.beatPos).toBeCloseTo(beatAt(s.t), 9);
    expect(s.bpm).toBeCloseTo(bpmAt(s.t), 9);
  });
  it('NITRO / OVERDRIVE do not change the BPM', () => {
    const s = createState(5);
    s.spawnEnabled = false;
    s.nitroT = 100;
    s.overdrive = true;
    s.overdriveT = 100;
    for (let i = 0; i < 120 * 5; i++) step(s, idle(), SIM_DT);
    expect(s.bpm).toBeCloseTo(bpmAt(s.t), 9);
    expect(s.speed).toBeGreaterThan(s.baseSpeed * 2);
  });
  it('gap quantisation: 0.5-beat multiples, never below 0.9 x the design gap', () => {
    for (const gt of [0.33, 0.55, 0.88, 1.1, 3]) {
      for (let b = 0; b < 400; b += 3.5) {
        const nb = quantizeGapBeat(b, gt);
        expect(Math.abs((nb - b) / 0.5 - Math.round((nb - b) / 0.5))).toBeLessThan(1e-9);
        expect(timeAtBeat(nb) - timeAtBeat(b)).toBeGreaterThanOrEqual(0.9 * gt - 1e-9);
      }
    }
  });
});

describe('beat grid: obstacle pass times land on the 8th-note grid', () => {
  for (const ramp of [false, true]) {
    it('10 seeds x 120 s, no boosts' + (ramp ? ' (with the launch ramp)' : '') + ': within 2 ms', () => {
      let worst = 0;
      let count = 0;
      for (const seed of SEEDS) {
        // items off: an idle ship that happens to pick up a NITRO would (by design) leave the grid
        const s = createState(seed, false, ramp);
        s.invincible = true;
        const prevZ = new Map<number, number>();
        for (let i = 0; i < 120 * 120; i++) {
          step(s, idle(), SIM_DT);
          for (const o of s.obstacles) {
            const pz = prevZ.get(o.id);
            if (pz !== undefined && pz < 0 && o.z >= 0) {
              const tCross = s.t - o.z / s.speed;
              worst = Math.max(worst, gridOffsetSec(tCross));
              count++;
            }
            prevZ.set(o.id, o.z);
          }
          if (i % 600 === 0) for (const k of [...prevZ.keys()]) if (!s.obstacles.some((o) => o.id === k)) prevZ.delete(k);
        }
      }
      expect(count).toBeGreaterThan(600); // sections thin the course out (build x1.25, breather x2.1 of the design gap)
      expect(worst).toBeLessThanOrEqual(0.002);
      console.log('max grid offset over', count, 'obstacles (ramp=' + ramp + '):', (worst * 1000).toFixed(3), 'ms');
    });
  }
});

describe('ON BEAT', () => {
  it('window is +-70 ms, inclusive', () => {
    expect(isOnBeat(0)).toBe(true);
    expect(isOnBeat(0.069)).toBe(true);
    expect(isOnBeat(0.07)).toBe(true);
    expect(isOnBeat(0.0701)).toBe(false);
    const t0 = timeAtBeat(100);
    expect(isOnBeat(gridOffsetSec(t0 + 0.069))).toBe(true);
    expect(isOnBeat(gridOffsetSec(t0 - 0.069))).toBe(true);
    expect(isOnBeat(gridOffsetSec(t0 + 0.072))).toBe(false);
    expect(isOnBeat(gridOffsetSec(t0 - 0.072))).toBe(false);
  });

  /** One slab whose pass-finish lands `offset` seconds after a beat grid line. */
  function passAt(offset: number, dist: number, start?: GameState): { s: GameState; ev: GameEvent[] } {
    const s = start ?? createState(1);
    if (!start) {
      s.spawnEnabled = false;
      s.t = timeAtBeat(100) - 0.5;
      s.baseSpeed = speedAt(s.t);
      s.speed = s.baseSpeed;
      s.dist = 0;
    }
    s.clutch.lastStart = s.realT; // keep CLUTCH out of this test
    const target = timeAtBeat(Math.round(beatAt(s.t + 0.5) * 2) / 2) + offset;
    const v = speedAt((s.t + target) / 2);
    const pos = s.dist + v * (target - s.t) - HIT_WINDOW;
    const solids = [{ a: s.theta + 6 * DEG + dist, b: s.theta + 6 * DEG + dist + 90 * DEG }];
    const o = makeObstacle(500 + s.obstacles.length, 'SLAB', pos, solids);
    o.z = s.dist - pos;
    s.obstacles.push(o);
    const ev: GameEvent[] = [];
    for (let i = 0; i < 400 && s.obstacles.length > 0; i++) ev.push(...step(s, idle(), SIM_DT));
    return { s, ev };
  }

  it('an INSANE on the beat scores x1.5 and is flagged; off the beat it does not', () => {
    const on = passAt(0.03, 3 * DEG);
    const e1 = on.ev.find((e) => e.type === 'insane');
    expect(e1).toBeTruthy();
    if (e1 && e1.type === 'insane') {
      expect(e1.onBeat).toBe(true);
      // base x ON BEAT x the speed factor of the (high) speed this pass happens at
      expect(e1.points / (INSANE_SCORE * ONBEAT_MULT)).toBeCloseTo(speedFactor(on.s.baseSpeed), 1);
    }
    const off = passAt(0.105, 3 * DEG);
    const e2 = off.ev.find((e) => e.type === 'insane');
    expect(e2).toBeTruthy();
    if (e2 && e2.type === 'insane') {
      expect(e2.onBeat).toBe(false);
      expect(e2.points / INSANE_SCORE).toBeCloseTo(speedFactor(off.s.baseSpeed), 1);
    }
    const near = passAt(-0.04, 8 * DEG);
    const e3 = near.ev.find((e) => e.type === 'nearMiss');
    expect(e3).toBeTruthy();
    if (e3 && e3.type === 'nearMiss') expect(e3.points / (NEAR_SCORE * ONBEAT_MULT)).toBeCloseTo(speedFactor(near.s.baseSpeed), 1);
  });

  it('BEAT STREAK: every 4th consecutive ON BEAT near miss pays +2000 x mult; an off-beat one resets it', () => {
    const first = passAt(0.01, 8 * DEG);
    const s = first.s;
    const evs: GameEvent[] = [...first.ev];
    for (let k = 0; k < 7; k++) evs.push(...passAt(0.01, 8 * DEG, s).ev);
    const streaks = evs.filter((e) => e.type === 'beatStreak');
    expect(streaks.length).toBe(2);
    const b = streaks[0];
    if (b.type === 'beatStreak') {
      expect(b.streak).toBe(4);
      // combo 4 -> x2, and four ON BEAT near misses (+70 style each) have lifted the rank to B (x1.25)
      expect(b.points).toBe(BEAT_STREAK_SCORE * 2 * 1.25);
    }
    passAt(0.105, 8 * DEG, s);
    expect(s.beatStreak).toBe(0);
  });
});

describe('hit-stop', () => {
  function stoppedSeconds(s: GameState): number {
    let n = 0;
    for (let i = 0; i < 60; i++) {
      step(s, idle(), SIM_DT);
      if (s.timeScale === HITSTOP_TIMESCALE) n++;
    }
    return n * SIM_DT;
  }
  it('world timeScale 0.03 for the requested time; halved in reduced-flash mode', () => {
    const s = createState(1);
    s.spawnEnabled = false;
    requestHitStop(s, 0.05);
    expect(stoppedSeconds(s)).toBeCloseTo(0.05, 1);
    const r = createState(1);
    r.spawnEnabled = false;
    r.reducedFlash = true;
    requestHitStop(r, 0.07);
    expect(stoppedSeconds(r)).toBeCloseTo(0.035, 1);
  });

  it('never more than 150 ms in any trailing second, however often it is requested', () => {
    const s = createState(1);
    s.spawnEnabled = false;
    const flags: number[] = [];
    for (let i = 0; i < 120 * 12; i++) {
      if (i % 9 === 0) requestHitStop(s, 0.07);
      step(s, idle(), SIM_DT);
      flags.push(s.timeScale === HITSTOP_TIMESCALE ? 1 : 0);
    }
    let worst = 0;
    let run = 0;
    const win = Math.round(1 / SIM_DT);
    for (let i = 0; i < flags.length; i++) {
      run += flags[i] - (i >= win ? flags[i - win] : 0);
      worst = Math.max(worst, run);
    }
    expect(worst * SIM_DT).toBeLessThanOrEqual(HITSTOP_CAP_PER_SEC + 1e-9);
    expect(worst).toBeGreaterThan(10);
  });
});

describe('distAt', () => {
  it('still the integral of the speed curve', () => {
    expect(distAt(10)).toBeCloseTo(50 * 10 + 0.7 * 100, 9);
  });
});
