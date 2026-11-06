import { describe, expect, it } from 'vitest';
import { CLUTCH_COOLDOWN, CLUTCH_DURATION, CLUTCH_SCORE, CLUTCH_TIMESCALE, DEG, SIM_DT } from '../src/game/constants';
import { createState, forceClutch, step } from '../src/game/sim';
import { makeObstacle } from '../src/game/spawner';
import type { GameEvent, GameState, Input } from '../src/game/types';

const input = (move = 0): Input => ({ move, focus: false, overdrive: false });

function fresh(): GameState {
  const s = createState(1);
  s.spawnEnabled = false;
  s.beatBonus = false;
  return s;
}

/** Slab whose CW edge overlaps the ship's CCW end by `pen` rad. */
function slab(s: GameState, pen: number, ahead = 6): void {
  const a = s.theta + 6 * DEG - pen;
  const o = makeObstacle(900 + s.obstacles.length, 'SLAB', s.dist + ahead, [{ a, b: a + 90 * DEG }]);
  o.z = -ahead;
  s.obstacles.push(o);
}

function types(ev: GameEvent[]): string[] {
  return ev.map((e) => e.type);
}

/** Run until `stop` or max steps; returns all events. */
function run(s: GameState, move: (s: GameState) => number, max = 120 * 3, stop?: (ev: GameEvent[]) => boolean): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < max; i++) {
    const ev = step(s, input(move(s)), SIM_DT);
    all.push(...ev);
    if (stop?.(all)) break;
  }
  return all;
}

describe('CLUTCH', () => {
  it('penetration <= 2.5 deg enters CLUTCH instead of dying: world timeScale 0.06, ship steers in real time', () => {
    const s = fresh();
    slab(s, 1 * DEG);
    const ev = run(s, () => 0, 200, (e) => types(e).includes('clutchStart'));
    expect(types(ev)).toContain('clutchStart');
    expect(s.alive).toBe(true);
    expect(s.clutch.active).toBe(true);
    const start = ev.find((e) => e.type === 'clutchStart');
    if (start?.type === 'clutchStart') expect(start.dir).toBe(-1); // slab is on the CCW side -> escape CW
    step(s, input(0), SIM_DT);
    expect(s.timeScale).toBe(CLUTCH_TIMESCALE);
    const th0 = s.theta;
    const dist0 = s.dist;
    for (let i = 0; i < 12; i++) step(s, input(-1), SIM_DT);
    expect(th0 - s.theta).toBeGreaterThan(2 * DEG);
    expect(s.dist - dist0).toBeLessThan(0.1 * 12 * SIM_DT * s.speed + 1e-9);
  });

  it('penetration > 2.5 deg is an immediate death', () => {
    const s = fresh();
    slab(s, 3 * DEG);
    const ev = run(s, () => 0, 200, (e) => types(e).includes('death'));
    expect(types(ev)).not.toContain('clutchStart');
    expect(s.alive).toBe(false);
  });

  it('escaping within 0.45 s real time = success: +3000 x mult, adrenaline +0.35, hit-stop', () => {
    const s = fresh();
    slab(s, 1 * DEG);
    const ev = run(s, () => 0, 200, (e) => types(e).includes('clutchStart'));
    const score0 = s.score;
    const adr0 = s.adrenaline;
    const t0 = s.realT;
    const ev2 = run(s, () => -1, 120, (e) => types(e).includes('clutchSuccess'));
    expect(types(ev)).toContain('clutchStart');
    expect(ev2.find((e) => e.type === 'clutchSuccess')).toBeTruthy();
    expect(s.alive).toBe(true);
    expect(s.realT - t0).toBeGreaterThanOrEqual(CLUTCH_DURATION - 2 * SIM_DT);
    expect(s.realT - t0).toBeLessThanOrEqual(CLUTCH_DURATION + 2 * SIM_DT);
    expect(s.score - score0).toBeGreaterThanOrEqual(CLUTCH_SCORE);
    expect(s.adrenaline - adr0).toBeGreaterThan(0.3);
    expect(s.hitStopT).toBeGreaterThan(0);
    expect(s.clutch.active).toBe(false);
  });

  it('still overlapping after 0.45 s = clutchFail, then death', () => {
    const s = fresh();
    slab(s, 1 * DEG);
    const ev = run(s, () => 0, 120 * 2, (e) => types(e).includes('death'));
    const t = types(ev);
    expect(t).toContain('clutchStart');
    expect(t).toContain('clutchFail');
    expect(t).toContain('death');
    expect(t.indexOf('clutchFail')).toBeLessThan(t.indexOf('death'));
    expect(s.alive).toBe(false);
  });

  it('8 s cooldown: a second near-collision right after dies; after 8 s it clutches again', () => {
    const s = fresh();
    slab(s, 1 * DEG);
    run(s, (st) => (st.clutch.active ? -1 : 0), 120 * 2, (e) => types(e).includes('clutchSuccess'));
    expect(s.alive).toBe(true);
    s.obstacles.length = 0;
    s.angVel = 0;
    slab(s, 1 * DEG);
    run(s, () => 0, 200);
    expect(s.alive).toBe(false);

    const s2 = fresh();
    slab(s2, 1 * DEG);
    run(s2, (st) => (st.clutch.active ? -1 : 0), 120 * 2, (e) => types(e).includes('clutchSuccess'));
    for (let i = 0; i < (CLUTCH_COOLDOWN + 0.2) / SIM_DT; i++) step(s2, input(0), SIM_DT);
    s2.obstacles.length = 0;
    s2.angVel = 0;
    slab(s2, 1 * DEG);
    const ev = run(s2, () => 0, 200, (e) => types(e).includes('clutchStart') || types(e).includes('death'));
    expect(types(ev)).toContain('clutchStart');
    expect(s2.alive).toBe(true);
  });

  it('never during OVERDRIVE (smash) or with a shield (shield wins)', () => {
    const od = fresh();
    od.overdrive = true;
    od.overdriveT = 5;
    slab(od, 1 * DEG);
    const e1 = run(od, () => 0, 200);
    expect(types(e1)).not.toContain('clutchStart');
    expect(types(e1)).toContain('smash');
    expect(od.alive).toBe(true);

    const sh = fresh();
    sh.shield = true;
    slab(sh, 1 * DEG);
    const e2 = run(sh, () => 0, 200);
    expect(types(e2)).not.toContain('clutchStart');
    expect(types(e2)).toContain('shieldBreak');
    expect(sh.alive).toBe(true);
  });

  it('the debug trigger starts a CLUTCH that resolves as a success', () => {
    const s = fresh();
    expect(types(forceClutch(s))).toEqual(['clutchStart']);
    const ev = run(s, () => 0, 120, (e) => types(e).includes('clutchSuccess'));
    expect(types(ev)).toContain('clutchSuccess');
    expect(s.alive).toBe(true);
  });
});
