import { describe, expect, it } from 'vitest';
import {
  BREAKDOWN_MIN,
  DEG,
  INSANE_SCORE,
  NEAR_SCORE,
  RANK_DECAY,
  RANK_DOWN_GRACE,
  RANK_MULT,
  RANK_THRESH,
  SIM_DT,
  SPEED_BASE,
  SPEED_MAX,
  STYLE_ADD,
  STYLE_PENALTY,
  ZONE_BANK_COMPOUND,
  ZONE_CHARGE_DOWN,
  ZONE_CHARGE_SCALE,
  ZONE_CHARGE_UP,
  ZONE_ENTER_TIME,
  ZONE_LV_SECONDS,
} from '../src/game/constants';
import { speedAt } from '../src/game/difficulty';
import { applyItem, createState, forceDeath, step } from '../src/game/sim';
import { makeObstacle } from '../src/game/spawner';
import {
  addStyle,
  awardOvertake,
  createBreakdown,
  endZone,
  forceZone,
  gain,
  insaneChainFactor,
  multBreakdown,
  rankForStyle,
  rankProgress,
  setStyle,
  speedFactor,
  tickStyle,
  totalMult,
  zoneChargeScale,
  zoneMult,
} from '../src/game/style';
import type { Arc, GameEvent, GameState, Input } from '../src/game/types';

const idle = (): Input => ({ move: 0, focus: false, overdrive: false });
// section events (a new notice / start can fall into any stretch of sim time) are not what these tests are about
const types = (ev: GameEvent[]): string[] => ev.map((e) => e.type).filter((t) => !t.startsWith('section') && t !== 'biomeChange');

/** A sim without obstacles, ON BEAT scoring and CLUTCH out of the way: only what each test sets up happens. */
function fresh(): GameState {
  const s = createState(1);
  s.spawnEnabled = false;
  s.beatBonus = false;
  s.clutch.lastStart = 0;
  return s;
}

/** Run `seconds` of sim time collecting every event. */
function run(s: GameState, seconds: number, input: Input = idle()): GameEvent[] {
  const all: GameEvent[] = [];
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n && s.alive; i++) all.push(...step(s, input, SIM_DT));
  return all;
}

let nid = 9000;
/** A slab whose nearest edge ends up `distDeg` from the ship when it passes (an INSANE below 4 deg, a NEAR MISS below 10). */
function slab(s: GameState, distDeg: number, ahead = 12): void {
  const a = s.theta + 6 * DEG + distDeg * DEG;
  const o = makeObstacle(nid++, 'SLAB', s.dist + ahead, [{ a, b: a + 90 * DEG } as Arc]);
  o.z = -ahead;
  s.obstacles.push(o);
}

function passAll(s: GameState): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < 4000 && s.obstacles.length > 0 && s.alive; i++) all.push(...step(s, idle(), SIM_DT));
  return all;
}

describe('style rank: thresholds, decay, grace (DESIGN 18.1)', () => {
  it('rank table', () => {
    expect([...RANK_THRESH]).toEqual([0, 100, 250, 450, 700, 1000, 1400]);
    expect([...RANK_DECAY]).toEqual([0, 15, 25, 40, 60, 85, 110]);
    expect([...RANK_MULT]).toEqual([1, 1.1, 1.25, 1.5, 2, 2.5, 3]);
  });

  it('rankForStyle: each threshold belongs to the higher rank', () => {
    expect(rankForStyle(0)).toBe(0);
    expect(rankForStyle(99.99)).toBe(0);
    expect(rankForStyle(100)).toBe(1);
    expect(rankForStyle(249.9)).toBe(1);
    expect(rankForStyle(250)).toBe(2);
    expect(rankForStyle(450)).toBe(3);
    expect(rankForStyle(700)).toBe(4);
    expect(rankForStyle(1000)).toBe(5);
    expect(rankForStyle(1399)).toBe(5);
    expect(rankForStyle(1400)).toBe(6);
    expect(rankForStyle(99999)).toBe(6);
  });

  it('scores add style and a rank-up is immediate (one event, even across several ranks)', () => {
    const s = fresh();
    addStyle(s, 99);
    expect(s.style.rank).toBe(0);
    expect(s.events).toEqual([]);
    addStyle(s, 1);
    expect(s.style.rank).toBe(1);
    expect(s.events).toEqual([{ type: 'rankUp', rank: 1, from: 0 }]);
    s.events.length = 0;
    addStyle(s, 700);
    expect(s.style.rank).toBe(4);
    expect(s.events).toEqual([{ type: 'rankUp', rank: 4, from: 1 }]);
    expect(s.style.maxRank).toBe(4);
  });

  it('the style values of every action (near +40, insane +90, on beat +30, ...)', () => {
    expect(STYLE_ADD).toEqual({ near: 40, insane: 90, onBeat: 30, beatStreak: 60, clutch: 200, shard: 8, perfect: 80, smash: 30, item: 20, overtake: 50 });
    expect(STYLE_PENALTY).toEqual({ comboBreak: 150, shieldBreak: 200 });
  });

  it('a real near miss adds 40, an INSANE 90 (80 / 120 with ON BEAT is checked in beat.test)', () => {
    const a = fresh();
    slab(a, 7);
    passAll(a);
    expect(a.style.value).toBeCloseTo(40, 6);
    const b = fresh();
    slab(b, 2);
    passAll(b);
    expect(b.style.value).toBeCloseTo(90, 6);
  });

  it('shards +8, PERFECT CHAIN +80, items +20, smash +30, CLUTCH +200, OVERTAKE +50', () => {
    const s = fresh();
    s.shards.push({ id: 1, chainId: 5, idx: 0, chainLen: 1, anchorId: 0, pos: s.dist + 3, theta: s.theta, z: -3, done: false });
    run(s, 0.3);
    expect(s.style.value).toBeCloseTo(8 + 80, 6); // one-shard chain: the shard, then PERFECT
    const t = fresh();
    applyItem(t, 'DOUBLE');
    expect(t.style.value).toBe(0); // applyItem is the effect only; the pick-up (activate) awards the style
    const o = fresh();
    expect(awardOvertake(o)).toEqual([]);
    expect(o.style.value).toBe(STYLE_ADD.overtake);
  });

  it('no decay at D; decay per second by rank, in sim time (FOCUS slows it)', () => {
    const d = fresh();
    d.style.value = 90;
    run(d, 2);
    expect(d.style.value).toBe(90);
    for (const rank of [1, 2, 3, 4, 5, 6]) {
      const s = fresh();
      s.style.rank = rank;
      s.style.value = RANK_THRESH[rank] + 500;
      const v0 = s.style.value;
      run(s, 1);
      expect(v0 - s.style.value, 'rank ' + rank).toBeCloseTo(RANK_DECAY[rank], 0);
    }
    // FOCUS: the world runs at 0.35, so the style decays at 0.35 x
    const f = fresh();
    f.style.rank = 4;
    f.style.value = 1100;
    for (let i = 0; i < 240; i++) step(f, { move: 0, focus: true, overdrive: false }, SIM_DT);
    expect(1100 - f.style.value).toBeLessThan(60 * 2 * 0.5);
    expect(1100 - f.style.value).toBeGreaterThan(60 * 2 * 0.25);
  });

  it('rank-down grace: 0.5 s under the threshold, a recovery inside the grace keeps the rank', () => {
    const s = fresh();
    s.style.rank = 3;
    s.style.value = 449;
    // under the A threshold: grace runs, nothing yet
    let ev = run(s, RANK_DOWN_GRACE - 0.1);
    expect(types(ev)).not.toContain('rankDown');
    expect(s.style.rank).toBe(3);
    // back above: the grace resets
    s.style.value = 600;
    run(s, 0.3);
    expect(s.style.downT).toBe(0);
    expect(s.style.rank).toBe(3);
    // now really under, for longer than the grace: the rank drops, once
    s.style.value = 300;
    ev = run(s, RANK_DOWN_GRACE + 0.1);
    expect(ev.filter((e) => e.type === 'rankDown')).toEqual([{ type: 'rankDown', rank: 2, from: 3 }]);
    expect(s.style.rank).toBe(2);
  });

  it('the grace is exactly 0.5 s', () => {
    const s = fresh();
    s.style.rank = 2;
    s.style.value = 249;
    let steps = 0;
    for (; steps < 200 && s.style.rank === 2; steps++) tickStyle(s, SIM_DT);
    expect(steps * SIM_DT).toBeGreaterThanOrEqual(RANK_DOWN_GRACE - 1e-9);
    expect(steps * SIM_DT).toBeLessThanOrEqual(RANK_DOWN_GRACE + 2 * SIM_DT);
  });

  it('rankProgress runs 0..1 between thresholds and is full at SSS', () => {
    const s = fresh();
    s.style.rank = 1;
    s.style.value = 175;
    expect(rankProgress(s.style)).toBeCloseTo(0.5, 9);
    s.style.rank = 6;
    s.style.value = 3000;
    expect(rankProgress(s.style)).toBe(1);
  });

  it('penalties: combo break -150 and shield break -200, never below 0', () => {
    const s = fresh();
    s.style.value = 500;
    s.style.rank = 3;
    s.combo = 3;
    s.multiplier = 1;
    s.comboTimer = 0.001;
    const ev = run(s, 0.05);
    expect(types(ev)).toContain('comboBreak');
    expect(s.style.value).toBeLessThanOrEqual(350 + 1e-9);
    expect(s.style.value).toBeGreaterThan(340);
    const t = fresh();
    t.style.value = 120;
    t.style.rank = 1;
    t.shield = true;
    const o = makeObstacle(nid++, 'SLAB', t.dist + 8, [{ a: t.theta - 40 * DEG, b: t.theta + 40 * DEG }]);
    o.z = -8;
    t.obstacles.push(o);
    const ev2 = run(t, 0.3);
    expect(types(ev2)).toContain('shieldBreak');
    expect(t.style.value).toBe(0);
  });
});

describe('multiplier chain (DESIGN 18.5)', () => {
  it('total = combo x rank x ZONE x NITRO x DOUBLE', () => {
    const s = fresh();
    expect(totalMult(s)).toBe(1);
    s.multiplier = 8;
    s.style.rank = 6; // x3
    expect(totalMult(s)).toBe(24);
    s.zone.active = true;
    s.zone.lv = 1; // x2
    expect(zoneMult(s)).toBe(2);
    expect(totalMult(s)).toBe(48);
    s.zone.lv = 3; // x4: Lv.1 is x2 and every level adds 1
    expect(zoneMult(s)).toBe(4);
    s.nitroT = 1;
    expect(totalMult(s)).toBe(8 * 3 * 4 * 2);
    s.doubleT = 1;
    expect(totalMult(s)).toBe(8 * 3 * 4 * 2 * 2); // 384: "up to hundreds"
  });

  it('the rank multiplier multiplies the combo multiplier (rank S x2 doubles the near-miss score)', () => {
    const a = fresh();
    slab(a, 7);
    const pa = passAll(a).find((e) => e.type === 'nearMiss');
    const b = fresh();
    b.style.rank = 4;
    b.style.value = 800;
    slab(b, 7);
    const pb = passAll(b).find((e) => e.type === 'nearMiss');
    expect(pa && pb && pa.type === 'nearMiss' && pb.type === 'nearMiss' && pb.points / pa.points).toBeCloseTo(2, 6);
  });

  it('breakdown lists the factors above 1 and the total; shown from x10', () => {
    const s = fresh();
    s.multiplier = 8;
    s.style.rank = 6;
    s.zone.active = true;
    s.zone.lv = 4; // x5
    s.doubleT = 2;
    const bd = multBreakdown(s, createBreakdown());
    expect(bd.factors.slice(0, bd.count)).toEqual([8, 3, 5, 2]);
    expect(bd.total).toBe(240); // "x8 x3 x5 x2 = x240"
    expect(bd.total).toBeGreaterThanOrEqual(BREAKDOWN_MIN);
    const low = fresh();
    low.multiplier = 3;
    expect(multBreakdown(low, createBreakdown()).total).toBeLessThan(BREAKDOWN_MIN);
  });

  it('near-miss base points scale with (baseSpeed / 50) ^ 1.5, about 6.8 at the top speed', () => {
    expect(speedFactor(SPEED_BASE)).toBe(1);
    expect(speedFactor(SPEED_MAX)).toBeCloseTo(6.83, 2);
    expect(speedFactor(100)).toBeCloseTo(Math.pow(2, 1.5), 9);
    const s = fresh();
    s.t = 100;
    s.baseSpeed = speedAt(100);
    s.speed = s.baseSpeed;
    slab(s, 7);
    const e = passAll(s).find((x) => x.type === 'nearMiss');
    expect(e && e.type === 'nearMiss' && e.points / NEAR_SCORE).toBeCloseTo(speedFactor(speedAt(100.1)), 1);
  });

  it('INSANE chain doubles the bonus each time (1500, 3000, 6000 ...), capped at 2^10; a plain near miss or a combo break resets it', () => {
    expect([1, 2, 3, 4, 11, 12, 20].map(insaneChainFactor)).toEqual([1, 2, 4, 8, 1024, 1024, 1024]);
    const s = fresh();
    const pts: number[] = [];
    for (let i = 0; i < 4; i++) {
      slab(s, 2, 6 + i * 5);
    }
    const ev = passAll(s);
    for (const e of ev) if (e.type === 'insane') pts.push(e.points / (INSANE_SCORE * speedFactor(s.baseSpeed)));
    expect(ev.filter((e) => e.type === 'insane').map((e) => (e.type === 'insane' ? e.chain : 0))).toEqual([1, 2, 4, 8]);
    expect(s.insaneChain).toBe(4);
    // a normal near miss resets
    slab(s, 7);
    passAll(s);
    expect(s.insaneChain).toBe(0);
    slab(s, 2);
    const ev2 = passAll(s);
    expect(ev2.find((e) => e.type === 'insane' && e.chain === 1)).toBeTruthy();
    // a combo break resets it too
    s.comboTimer = 0.001;
    run(s, 0.05);
    expect(s.insaneChain).toBe(0);
    // the 11th consecutive INSANE is capped
    const c = fresh();
    c.insaneChain = 14;
    slab(c, 2);
    const e = passAll(c).find((x) => x.type === 'insane');
    expect(e && e.type === 'insane' && e.chain).toBe(1024);
    void pts;
  });
});

describe('ZONE (DESIGN 18.2)', () => {
  function atSSS(): GameState {
    const s = fresh();
    setStyle(s, 1500);
    s.events.length = 0;
    return s;
  }

  it('SSS held for 3.0 s continuous opens the ZONE (zoneEnter once)', () => {
    const s = atSSS();
    const ev: GameEvent[] = [];
    // hold the meter at SSS against the 110 / s decay
    const hold = (sec: number): void => {
      for (let i = 0; i < Math.round(sec / SIM_DT); i++) {
        s.style.value = 1500;
        ev.push(...step(s, idle(), SIM_DT));
      }
    };
    hold(ZONE_ENTER_TIME - 0.5);
    expect(s.zone.active).toBe(false);
    hold(0.4);
    expect(s.zone.active).toBe(false);
    hold(0.2);
    expect(types(ev)).toEqual(['zoneEnter']);
    expect(s.zone.active).toBe(true);
    expect(s.zone.lv).toBe(1);
  });

  it('dropping below SSS resets the 3 s', () => {
    const s = atSSS();
    run(s, 2);
    s.style.value = 900;
    run(s, 0.7); // grace passes, rank falls to S/SS
    expect(s.style.rank).toBeLessThan(6);
    expect(s.style.sssT).toBe(0);
    setStyle(s, 1500);
    run(s, 2.5);
    expect(s.zone.active).toBe(false);
  });

  it('inside the ZONE the factor is x2 and every 10 s adds one level (zoneLevel events), +1 factor each', () => {
    const s = atSSS();
    forceZone(s);
    expect(s.zone.active).toBe(true);
    expect(zoneMult(s)).toBe(2);
    const lv: number[] = [];
    for (let i = 0; i < 25; i++) {
      s.style.value = 1500;
      for (const e of run(s, 1)) if (e.type === 'zoneLevel') lv.push(e.lv);
    }
    expect(lv).toEqual([2, 3]);
    expect(s.zone.lv).toBe(3);
    expect(zoneMult(s)).toBe(4);
    expect(s.zone.t).toBeGreaterThan(2 * ZONE_LV_SECONDS);
  });

  it('points earned in the ZONE go to the BANK, not the score', () => {
    const s = atSSS();
    s.zone.active = false;
    const sc0 = s.score;
    forceZone(s);
    s.style.value = 1500;
    run(s, 1);
    expect(s.score).toBe(sc0);
    expect(s.zone.bank).toBeGreaterThan(0);
    // a near miss inside the ZONE also lands in the bank
    const b0 = s.zone.bank;
    slab(s, 7);
    passAll(s);
    expect(s.score).toBe(sc0);
    expect(s.zone.bank).toBeGreaterThan(b0 + NEAR_SCORE);
  });

  it('the BANK compounds on every beat by x(1 + 0.01 x Lv)', () => {
    const s = atSSS();
    forceZone(s);
    s.zone.lv = 3;
    s.zone.bank = 1000;
    s.beatPos = 10;
    s.zone.beat = 10;
    s.style.value = 1500;
    s.beatPos = 11;
    tickStyle(s, 0);
    expect(s.zone.bank).toBeCloseTo(1000 * (1 + ZONE_BANK_COMPOUND * 3), 9);
    s.beatPos = 14.5;
    tickStyle(s, 0);
    expect(s.zone.bank).toBeCloseTo(1000 * Math.pow(1.03, 4), 6);
    // no beat crossed: unchanged
    const b = s.zone.bank;
    s.beatPos = 14.9;
    tickStyle(s, 0);
    expect(s.zone.bank).toBe(b);
    // exponential: 100 beats at Lv 5 is about x1.05^100
    s.zone.lv = 5;
    s.zone.bank = 1;
    s.zone.beat = 200;
    for (let b = 201; b <= 300; b++) {
      s.beatPos = b + 0.01;
      tickStyle(s, 0);
    }
    expect(s.zone.bank).toBeCloseTo(Math.pow(1.05, 100), 3);
  });

  it('CLEAR: the rank falls to S or below -> the whole BANK is paid (zoneClear)', () => {
    const s = atSSS();
    forceZone(s);
    s.zone.bank = 123456;
    s.style.value = 100; // far under SSS: after the 0.5 s grace the rank collapses below SS
    const sc0 = s.score;
    const ev = run(s, 0.8);
    const clear = ev.find((e) => e.type === 'zoneClear');
    expect(clear && clear.type === 'zoneClear' && clear.bank).toBeGreaterThanOrEqual(123456);
    expect(s.zone.active).toBe(false);
    expect(s.score - sc0).toBeGreaterThanOrEqual(123456);
    expect(types(ev)).not.toContain('zoneBreak');
    expect(types(ev)).not.toContain('zoneLost');
  });

  it('SS keeps the ZONE running; only S and below ends it', () => {
    const s = atSSS();
    forceZone(s);
    s.zone.bank = 1;
    setStyle(s, 1100); // SS
    expect(s.zone.active).toBe(true);
    setStyle(s, 710); // S
    expect(s.zone.active).toBe(false);
    expect(s.events.map((e) => e.type)).toContain('zoneClear');
  });

  it('BREAK: a combo break pays 50 % (zoneBreak{bank, paid})', () => {
    const s = atSSS();
    forceZone(s);
    s.zone.bank = 1000000;
    s.combo = 4;
    s.multiplier = 2;
    s.comboTimer = 0.001;
    s.style.value = 1500;
    const sc0 = s.score;
    const ev = run(s, 0.05);
    const br = ev.find((e) => e.type === 'zoneBreak');
    expect(br).toBeTruthy();
    if (br && br.type === 'zoneBreak') {
      expect(br.paid).toBeCloseTo(br.bank * 0.5, 6);
      expect(br.bank).toBeGreaterThanOrEqual(1000000);
      // the half is paid straight into the score (plus the running score of the same step)
      expect(s.score - sc0).toBeGreaterThanOrEqual(br.paid);
      expect(s.score - sc0).toBeLessThan(br.paid + 100);
    }
    expect(s.zone.active).toBe(false);
  });

  it('BREAK: a shield break pays 50 %', () => {
    const s = atSSS();
    forceZone(s);
    s.zone.bank = 800000;
    s.shield = true;
    const o = makeObstacle(nid++, 'SLAB', s.dist + 8, [{ a: s.theta - 40 * DEG, b: s.theta + 40 * DEG }]);
    o.z = -8;
    s.obstacles.push(o);
    const sc0 = s.score;
    const ev = run(s, 0.4);
    const br = ev.find((e) => e.type === 'zoneBreak');
    expect(br && br.type === 'zoneBreak' && br.paid).toBeCloseTo((br && br.type === 'zoneBreak' ? br.bank : 0) * 0.5, 6);
    expect(s.score).toBeGreaterThan(sc0 + 399999);
    expect(s.zone.active).toBe(false);
    expect(s.alive).toBe(true);
  });

  it('DEATH: the whole BANK is forfeited (zoneLost), the score keeps only what it had', () => {
    const s = atSSS();
    s.score = 5000;
    forceZone(s);
    s.zone.bank = 987654;
    const ev = forceDeath(s);
    const lost = ev.find((e) => e.type === 'zoneLost');
    expect(lost).toEqual({ type: 'zoneLost', bank: 987654 });
    expect(s.score).toBe(5000);
    expect(s.zone.active).toBe(false);
    expect(s.zone.lost).toBe(987654);
    expect(types(ev).indexOf('zoneLost')).toBeLessThan(types(ev).indexOf('death'));
  });

  it('endZone directly: clear pays all, break half, and only while active', () => {
    const s = fresh();
    s.zone.active = true;
    s.zone.bank = 200;
    endZone(s, 'clear');
    expect(s.score).toBe(200);
    endZone(s, 'break');
    expect(s.score).toBe(200);
    s.zone.active = true;
    s.zone.bank = 200;
    endZone(s, 'break');
    expect(s.score).toBe(300);
  });

  it('entry charge: timeScale eases down to 0.2 over 0.25 s and back to 1 over 0.3 s', () => {
    expect(zoneChargeScale(ZONE_CHARGE_DOWN + ZONE_CHARGE_UP)).toBeCloseTo(1, 9);
    expect(zoneChargeScale(ZONE_CHARGE_UP)).toBeCloseTo(ZONE_CHARGE_SCALE, 9);
    expect(zoneChargeScale(0)).toBeCloseTo(1, 9);
    expect(zoneChargeScale(ZONE_CHARGE_UP + ZONE_CHARGE_DOWN / 2)).toBeLessThan(0.7);
    const s = atSSS();
    forceZone(s);
    let min = 1;
    let steps = 0;
    while (s.zoneChargeT > 0 && steps++ < 500) {
      step(s, idle(), SIM_DT);
      min = Math.min(min, s.timeScale);
    }
    expect(min).toBeLessThan(0.25);
    expect(min).toBeGreaterThanOrEqual(ZONE_CHARGE_SCALE - 1e-6);
    step(s, idle(), SIM_DT);
    expect(s.timeScale).toBe(1);
  });

  it('OVERDRIVE can still be used in the ZONE', () => {
    const s = atSSS();
    forceZone(s);
    s.adrenaline = 1;
    const ev = step(s, { move: 0, focus: false, overdrive: true }, SIM_DT);
    expect(types(ev)).toContain('overdriveStart');
    expect(s.overdrive).toBe(true);
    expect(s.zone.active).toBe(true);
  });
});

describe('score milestones (10^n) fire once each', () => {
  it('crossing 10^5 .. 10^9 one at a time', () => {
    const s = fresh();
    const seen: number[] = [];
    for (const target of [50000, 100000, 250000, 1e6, 3e6, 1e7, 1e9]) {
      s.score = target;
      for (const e of run(s, 0.02)) if (e.type === 'scoreMilestone') seen.push(e.exp);
    }
    expect(seen).toEqual([5, 6, 7, 8, 9]);
  });

  it('a jump over several powers fires each of them once, and nothing repeats', () => {
    const s = fresh();
    s.score = 4e8;
    const ev = run(s, 0.05);
    expect(ev.filter((e) => e.type === 'scoreMilestone').map((e) => (e.type === 'scoreMilestone' ? e.exp : 0))).toEqual([5, 6, 7, 8]);
    expect(run(s, 0.5).filter((e) => e.type === 'scoreMilestone')).toEqual([]);
    s.score = 4e22;
    const big = run(s, 0.05).filter((e) => e.type === 'scoreMilestone');
    expect(big.length).toBe(14); // 10^9 .. 10^22
  });

  it('the score is a double: far beyond 2^53 it keeps accumulating', () => {
    const s = fresh();
    s.score = 2 ** 60; // 1.15e18, past Number.MAX_SAFE_INTEGER
    expect(s.score).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    s.zone.active = false;
    gain(s, 2 ** 40);
    expect(s.score).toBeGreaterThan(2 ** 60);
    s.score = 4e22;
    run(s, 0.1);
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(4e22);
  });
});
