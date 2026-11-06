import { describe, expect, it } from 'vitest';
import { angDiff, arcContains, arcLen, wrap } from '../src/game/angles';
import {
  DEG,
  DOUBLE_DURATION,
  EMP_RANGE,
  FOCUS_DRAIN,
  HIT_WINDOW,
  ITEM_KINDS,
  MAX_ANG_VEL,
  NITRO_DURATION,
  NITRO_SPEED_MULT,
  OBSTACLE_THICK,
  REACH_FACTOR,
  SHARD_EDGE_MAX,
  SHARD_PICK_ANGLE,
  SHARD_SPACING_TIME,
  SHIELD_GRACE,
  SIM_DT,
  SMASH_SCORE,
  WARP_DURATION,
} from '../src/game/constants';
import { speedAt } from '../src/game/difficulty';
import { solidsAt } from '../src/game/items';
import { applyItem, createState, scoreMult, spawnItemAhead, step } from '../src/game/sim';
import { createSpawner, makeObstacle, nextObstacle } from '../src/game/spawner';
import type { Arc, GameEvent, GameState, Input, Obstacle, PowerUp, Shard } from '../src/game/types';

const SEEDS = [1, 2, 3, 42, 99, 1234, 31337, 777, 2024, 987654321];
const idle = (): Input => ({ move: 0, focus: false, overdrive: false });

interface Gen {
  obstacles: Obstacle[];
  shards: Shard[];
  powerups: PowerUp[];
}

function generate(seed: number, seconds: number, items = true): Gen {
  const sp = createSpawner(seed, items);
  const obstacles: Obstacle[] = [];
  for (;;) {
    const o = nextObstacle(sp);
    if (o.tNom > seconds) break;
    obstacles.push(o);
  }
  return { obstacles, shards: sp.shardQ.slice(), powerups: sp.powerQ.slice() };
}

function insideSolid(obstacles: Obstacle[], pos: number, theta: number): Obstacle | null {
  for (const o of obstacles) {
    const dz = pos - o.pos;
    if (Math.abs(dz) > OBSTACLE_THICK / 2) continue;
    for (const a of solidsAt(o, dz)) if (arcContains(a.a, a.b, theta)) return o;
  }
  return null;
}

describe('shards and power-ups: placement', () => {
  const gens = SEEDS.map((s) => generate(s, 300));

  it('produces chains of 5-8 shards and every power-up kind across the seeds', () => {
    let chains = 0;
    const kinds = new Set<string>();
    for (const g of gens) {
      const byChain = new Map<number, Shard[]>();
      for (const s of g.shards) byChain.set(s.chainId, [...(byChain.get(s.chainId) ?? []), s]);
      for (const c of byChain.values()) {
        if (c.length === c[0].chainLen) {
          chains++;
          expect(c.length).toBeGreaterThanOrEqual(5);
          expect(c.length).toBeLessThanOrEqual(8);
        }
      }
      for (const p of g.powerups) kinds.add(p.kind);
    }
    expect(chains).toBeGreaterThan(100);
    for (const k of ITEM_KINDS) expect(kinds.has(k)).toBe(true);
  });

  it('10 seeds x 300 s: no shard or power-up is ever inside a solid arc', () => {
    let n = 0;
    for (const g of gens) {
      for (const s of g.shards) {
        expect(insideSolid(g.obstacles, s.pos, s.theta)).toBeNull();
        n++;
      }
      for (const p of g.powerups) {
        expect(insideSolid(g.obstacles, p.pos, p.theta)).toBeNull();
        n++;
      }
    }
    expect(n).toBeGreaterThan(800);
  });

  it('items sit on routes the ship can follow: inside the anchor safe arc, steps within reach', () => {
    for (const g of gens) {
      const byId = new Map(g.obstacles.map((o) => [o.id, o]));
      const sorted = g.shards.slice().sort((a, b) => a.chainId - b.chainId || a.idx - b.idx);
      let prev: Shard | null = null;
      for (const s of sorted) {
        const o = byId.get(s.anchorId)!;
        expect(o.safe.some((a) => arcContains(a.a, a.b, s.theta))).toBe(true);
        if (prev && prev.chainId === s.chainId) {
          expect(Math.abs(angDiff(prev.theta, s.theta))).toBeLessThanOrEqual(
            REACH_FACTOR * MAX_ANG_VEL * SHARD_SPACING_TIME + 1e-9,
          );
          expect(s.pos).toBeGreaterThan(prev.pos);
        }
        prev = s;
      }
      for (const p of g.powerups) {
        const o = byId.get(p.anchorId)!;
        expect(o.safe.some((a: Arc) => arcContains(a.a, a.b, p.theta))).toBe(true);
      }
    }
  });

  it('EDGE chains hug an obstacle edge (<= 8 deg), SAFE chains the arc centre; power-ups split centre / edge', () => {
    let edge = 0;
    let safe = 0;
    let powEdge = 0;
    let powCenter = 0;
    for (const g of gens) {
      const byId = new Map(g.obstacles.map((o) => [o.id, o]));
      for (const s of g.shards) {
        const o = byId.get(s.anchorId)!;
        const arc = o.safe.find((a) => arcContains(a.a, a.b, s.theta))!;
        const dEdge = Math.min(wrap(s.theta - arc.a), wrap(arc.b - s.theta));
        if (dEdge <= SHARD_EDGE_MAX + 1e-9) edge++;
        else if (Math.abs(dEdge - arcLen(arc.a, arc.b) / 2) < 1e-6) safe++;
      }
      for (const p of g.powerups) {
        const o = byId.get(p.anchorId)!;
        const arc = o.safe.find((a) => arcContains(a.a, a.b, p.theta))!;
        const dEdge = Math.min(wrap(p.theta - arc.a), wrap(arc.b - p.theta));
        if (dEdge <= 12 * DEG + 1e-9) powEdge++;
        else if (Math.abs(dEdge - arcLen(arc.a, arc.b) / 2) < 1e-6) powCenter++;
      }
    }
    expect(edge).toBeGreaterThan(100);
    expect(safe).toBeGreaterThan(100);
    expect(powEdge).toBeGreaterThan(10);
    expect(powCenter).toBeGreaterThan(10);
  });

  it('power-ups appear roughly every 7-11 s of course time', () => {
    for (const g of gens) {
      const ts = g.powerups.map((p) => g.obstacles.find((o) => o.id === p.anchorId)!.tNom).sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(7 - 1e-9);
        expect(ts[i] - ts[i - 1]).toBeLessThan(25); // 11 s timer + wait for an eligible obstacle (snake runs, rare placement rejects)
      }
    }
  });
});

describe('independence: items never change the obstacle course', () => {
  it('identical obstacle sequences with and without items', () => {
    for (const seed of SEEDS) {
      const a = generate(seed, 300, true);
      const b = generate(seed, 300, false);
      expect(b.shards.length).toBe(0);
      expect(a.shards.length).toBeGreaterThan(0);
      expect(JSON.stringify(a.obstacles)).toBe(JSON.stringify(b.obstacles));
    }
  });
  it('the sim state sees the same obstacles with items on / off', () => {
    const on = createState(55, true);
    const off = createState(55, false);
    const ids: number[][] = [[], []];
    const solids: string[][] = [[], []];
    [on, off].forEach((s, k) => {
      s.invincible = true;
      for (let i = 0; i < 120 * 60; i++) {
        step(s, idle(), SIM_DT);
        for (const o of s.obstacles) {
          if (!ids[k].includes(o.id)) {
            ids[k].push(o.id);
            solids[k].push(JSON.stringify(o.solids));
          }
        }
      }
    });
    expect(ids[0]).toEqual(ids[1]);
    expect(solids[0]).toEqual(solids[1]);
  });
});

function fresh(): GameState {
  const s = createState(1);
  s.spawnEnabled = false;
  return s;
}
let nextId = 5000;
function place(s: GameState, solids: Arc[], ahead = 12): Obstacle {
  const o = makeObstacle(nextId++, 'SLAB', s.dist + ahead, solids);
  o.z = -ahead;
  s.obstacles.push(o);
  return o;
}
function slabOverShip(s: GameState): Arc[] {
  return [{ a: s.theta - 40 * DEG, b: s.theta + 40 * DEG }];
}
function run(s: GameState, seconds: number, input: Input = idle()): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) out.push(...step(s, input, SIM_DT));
  return out;
}

describe('SHIELD', () => {
  it('picking one up sets the shield and emits a powerup event', () => {
    const s = fresh();
    spawnItemAhead(s, 'SHIELD', 10);
    const ev = run(s, 0.5);
    expect(s.shield).toBe(true);
    expect(ev.some((e) => e.type === 'powerup' && e.kind === 'SHIELD')).toBe(true);
  });
  it('absorbs exactly one hit, smashes that obstacle and grants 0.8 s of invulnerability', () => {
    expect(SHIELD_GRACE).toBe(0.8);
    const s = fresh();
    applyItem(s, 'SHIELD');
    place(s, slabOverShip(s), 12);
    place(s, slabOverShip(s), 12 + 3);
    const ev = run(s, 0.3);
    expect(ev.filter((e) => e.type === 'shieldBreak').length).toBe(1);
    expect(s.alive).toBe(true);
    expect(s.shield).toBe(false);
    run(s, 0.5);
    expect(s.alive).toBe(true); // second slab met during the grace window
    // once the grace is over a further hit kills
    const s2 = fresh();
    applyItem(s2, 'SHIELD');
    place(s2, slabOverShip(s2), 5);
    run(s2, 0.3);
    expect(s2.alive).toBe(true);
    run(s2, 1.0);
    place(s2, slabOverShip(s2), 5);
    run(s2, 0.3);
    expect(s2.alive).toBe(false);
  });
  it('does not stack', () => {
    const s = fresh();
    applyItem(s, 'SHIELD');
    applyItem(s, 'SHIELD');
    place(s, slabOverShip(s), 6);
    run(s, 0.3);
    expect(s.shield).toBe(false);
    run(s, 1.0);
    place(s, slabOverShip(s), 6);
    run(s, 0.3);
    expect(s.alive).toBe(false);
  });
});

describe('NITRO', () => {
  it('speed x1.35 and score multiplier x2 for 4 s, then ends (not invincible)', () => {
    const s = fresh();
    const base = fresh();
    applyItem(s, 'NITRO');
    const ev = run(s, 1);
    run(base, 1);
    expect(s.speed).toBeCloseTo(speedAt(s.t) * NITRO_SPEED_MULT, 6);
    expect(s.dist).toBeGreaterThan(base.dist * 1.25);
    expect(scoreMult(s)).toBe(2);
    expect(ev.some((e) => e.type === 'effectEnd')).toBe(false);
    const ev2 = run(s, NITRO_DURATION);
    expect(ev2.some((e) => e.type === 'effectEnd' && e.kind === 'NITRO')).toBe(true);
    expect(scoreMult(s)).toBe(1);
    expect(s.speed).toBeCloseTo(speedAt(s.t), 6);
    const s2 = fresh();
    applyItem(s2, 'NITRO');
    place(s2, slabOverShip(s2), 6);
    run(s2, 0.3);
    expect(s2.alive).toBe(false);
  });
  it('doubles near-miss points', () => {
    const mk = (nitro: boolean): number => {
      const s = fresh();
      if (nitro) applyItem(s, 'NITRO');
      const start = s.theta + 12 * DEG;
      place(s, [{ a: start, b: start + 90 * DEG }], 10);
      const ev = run(s, 0.6);
      const e = ev.find((x) => x.type === 'nearMiss');
      if (!e || e.type !== 'nearMiss') throw new Error('no near miss');
      return e.points;
    };
    expect(mk(true)).toBe(mk(false) * 2);
  });
});

describe('DOUBLE', () => {
  it('lasts 12 s, doubles all scoring, stacks with NITRO to x4', () => {
    const s = fresh();
    applyItem(s, 'DOUBLE');
    expect(scoreMult(s)).toBe(2);
    run(s, DOUBLE_DURATION - 0.5);
    expect(scoreMult(s)).toBe(2);
    const ev = run(s, 1);
    expect(ev.some((e) => e.type === 'effectEnd' && e.kind === 'DOUBLE')).toBe(true);
    expect(scoreMult(s)).toBe(1);
    applyItem(s, 'DOUBLE');
    applyItem(s, 'NITRO');
    expect(scoreMult(s)).toBe(4);
  });
  it('running score accrues twice as fast', () => {
    const a = fresh();
    const b = fresh();
    applyItem(b, 'DOUBLE');
    run(a, 2);
    run(b, 2);
    expect(b.score).toBeCloseTo(a.score * 2, 3);
  });
});

describe('WARP', () => {
  it('refills FOCUS and halves its drain for 4 s', () => {
    const drainOf = (warp: boolean): number => {
      const s = fresh();
      s.focus = 1;
      if (warp) applyItem(s, 'WARP');
      const focusIn: Input = { move: 0, focus: true, overdrive: false };
      run(s, 0.5, focusIn);
      return 1 - s.focus;
    };
    const s = fresh();
    s.focus = 0.1;
    applyItem(s, 'WARP');
    expect(s.focus).toBe(1);
    const normal = drainOf(false);
    const halved = drainOf(true);
    expect(normal).toBeGreaterThan(0.1);
    expect(halved / normal).toBeGreaterThan(0.4);
    expect(halved / normal).toBeLessThan(0.62);
    expect(normal).toBeLessThan(FOCUS_DRAIN * 0.5 + 0.01);
    const ev = run(s, WARP_DURATION + 0.2);
    expect(ev.some((e) => e.type === 'effectEnd' && e.kind === 'WARP')).toBe(true);
    expect(s.warpT).toBe(0);
  });
});

describe('EMP', () => {
  it('destroys every obstacle within 90 units ahead, with smash bonus, and leaves the rest', () => {
    const s = fresh();
    place(s, slabOverShip(s), 20);
    place(s, slabOverShip(s), 60);
    place(s, slabOverShip(s), EMP_RANGE - 1);
    const far = place(s, slabOverShip(s), EMP_RANGE + 20);
    const score0 = s.score;
    applyItem(s, 'EMP');
    expect(s.obstacles).toEqual([far]);
    expect(s.score - score0).toBe(3 * SMASH_SCORE);
  });
  it('picking one up emits the emp event and clears the slab in front', () => {
    const s2 = fresh();
    place(s2, slabOverShip(s2), 40);
    spawnItemAhead(s2, 'EMP', 5);
    const ev2 = run(s2, 0.3);
    const emp = ev2.find((e) => e.type === 'emp');
    expect(emp && emp.type === 'emp' && emp.count).toBe(1);
    expect(s2.alive).toBe(true);
    expect(s2.obstacles.length).toBe(0);
  });
});

describe('shards and PERFECT CHAIN', () => {
  function chain(s: GameState, n: number, skip = -1): void {
    for (let k = 0; k < n; k++) {
      const pos = s.dist + 10 + k * 4;
      s.shards.push({ id: 7000 + k, chainId: 77, idx: k, chainLen: n, anchorId: 0, pos, theta: s.theta, z: -(10 + k * 4), done: false });
    }
    if (skip >= 0) s.shards[skip].theta = wrap(s.theta + SHARD_PICK_ANGLE + 20 * DEG);
  }
  it('collecting a whole chain raises the pitch index and awards PERFECT', () => {
    const s = fresh();
    chain(s, 6);
    const ev = run(s, 1.2);
    const shards = ev.filter((e) => e.type === 'shard');
    expect(shards.map((e) => (e.type === 'shard' ? e.chainIdx : -1))).toEqual([0, 1, 2, 3, 4, 5]);
    const p = ev.filter((e) => e.type === 'perfectChain');
    expect(p.length).toBe(1);
    expect(p[0].type === 'perfectChain' && p[0].points).toBe(1000);
    expect(s.shards.length).toBe(0);
  });
  it('shards give 100 x multiplier', () => {
    const s = fresh();
    s.multiplier = 3;
    chain(s, 5, 2);
    const evs = run(s, 1.2);
    const got = evs.filter((e) => e.type === 'shard');
    expect(got.length).toBe(4);
    expect(got[0].type === 'shard' && got[0].points).toBe(300);
  });
  it('missing one shard breaks the chain: no PERFECT, pitch index restarts', () => {
    const s = fresh();
    chain(s, 6, 2);
    const ev = run(s, 1.2);
    expect(ev.some((e) => e.type === 'perfectChain')).toBe(false);
    const idx = ev.filter((e) => e.type === 'shard').map((e) => (e.type === 'shard' ? e.chainIdx : -1));
    expect(idx).toEqual([0, 1, 0, 1, 2]);
  });
  it('collision window constant is sane', () => {
    expect(HIT_WINDOW).toBeCloseTo(0.7);
  });
});
