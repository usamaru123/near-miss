import { describe, expect, it } from 'vitest';
import { arcContains, arcLen, maxReachDistance, pointSetDistance, wrap } from '../src/game/angles';
import {
  BEATS_PER_BAR,
  DEG,
  FIRST_SECTION_BEAT,
  GAUNTLET_BARS,
  HIT_WINDOW,
  LASER_MARGIN,
  MAX_ANG_VEL,
  MAX_TIER,
  PULSE_CLOSED_GAP,
  REACH_FACTOR,
  SAFE_MIN_WIDTH,
  SECTION_MIN_TIER,
  SECTION_NAMES,
  SIM_DT,
  SNAKE_INNER_FACTOR,
  START_THETA,
  TAU,
  TIER_DURATION,
} from '../src/game/constants';
import { beatAt, bpmAt, chapterStartBeat, gapTime, speedAt, tierAt, timeAtBeat } from '../src/game/difficulty';
import { Director, chapterEnd, chapterOf } from '../src/game/sections';
import { createState, forceSection, pulseWidth, step } from '../src/game/sim';
import { createSpawner, nextObstacle } from '../src/game/spawner';
import type { GameEvent, Input, Obstacle, SectionDef, SpawnerState } from '../src/game/types';
import { botInput } from './bot';

const SEEDS = [1, 2, 3, 42, 99, 1234, 31337, 777, 2024, 987654321];
const idle = (): Input => ({ move: 0, focus: false, overdrive: false });

function generate(seed: number, seconds: number): { list: Obstacle[]; sp: SpawnerState } {
  const sp = createSpawner(seed);
  const list: Obstacle[] = [];
  for (;;) {
    const o = nextObstacle(sp);
    if (o.tNom > seconds) break;
    list.push(o);
  }
  return { list, sp };
}

const END_300 = beatAt(300);

function plan(seed: number, beats = END_300): SectionDef[] {
  const d = new Director(seed);
  d.ensure(beats);
  return d.defs.filter((x) => x.endBeat <= beats);
}

describe('director (DESIGN 20.3)', () => {
  it('the section sequence derives from the seed alone (own RNG stream: independent of obstacle generation)', () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const a = plan(seed);
      const b = plan(seed);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      // ... also equal to what a spawner that generated 300 s of obstacles (and consumed its own RNG) planned
      const { sp } = generate(seed, 300);
      const used = sp.dir.defs.slice(0, a.length);
      expect(JSON.stringify(used)).toBe(JSON.stringify(a));
    }
    expect(JSON.stringify(plan(1))).not.toBe(JSON.stringify(plan(2)));
  });

  it('sections tile the course on bar lines, never repeat back to back, and respect their minimum tier', () => {
    for (const seed of SEEDS) {
      const defs = plan(seed);
      expect(defs[0].startBeat).toBe(FIRST_SECTION_BEAT);
      for (let i = 0; i < defs.length; i++) {
        const d = defs[i];
        expect(d.startBeat % BEATS_PER_BAR).toBe(0);
        expect(d.endBeat % BEATS_PER_BAR).toBe(0);
        expect(d.endBeat).toBeGreaterThan(d.startBeat);
        if (i > 0) {
          expect(d.startBeat).toBe(defs[i - 1].endBeat);
          expect(d.name).not.toBe(defs[i - 1].name);
        }
        expect(SECTION_MIN_TIER[d.name]).toBeLessThanOrEqual(d.chapter);
        expect(chapterOf(d.startBeat)).toBe(d.chapter);
        expect(d.endBeat).toBeLessThanOrEqual(chapterEnd(d.chapter));
        // an 8 bar phrase starts the chapter's phrase grid: heads sit 32 beats apart from the chapter start
        if (d.name !== 'GAUNTLET') expect((d.startBeat - chapterStartBeat(d.chapter)) % 32).toBe(0);
      }
    }
  });

  it('a 4 bar GAUNTLET closes every chapter that ends in a tier-up (T2..T5), just before the warp', () => {
    for (const seed of SEEDS) {
      const d = new Director(seed);
      d.ensure(beatAt(TIER_DURATION * 5) + 1);
      for (let k = 2; k < MAX_TIER; k++) {
        const last = [...d.defs].reverse().find((x) => x.chapter === k)!;
        expect(last.name).toBe('GAUNTLET');
        expect(last.role).toBe('gauntlet');
        expect((last.endBeat - last.startBeat) / BEATS_PER_BAR).toBe(GAUNTLET_BARS);
        const tierUp = beatAt(TIER_DURATION * k);
        expect(last.endBeat).toBeLessThanOrEqual(tierUp);
        expect(tierUp - last.endBeat).toBeLessThan(BEATS_PER_BAR);
      }
      // no GAUNTLET in the first tier, none after the last tier-up
      expect(d.defs.filter((x) => x.chapter === 1 || x.chapter === MAX_TIER).some((x) => x.name === 'GAUNTLET')).toBe(false);
    }
  });

  it('BREATHER is 15-25 % of the course; the share of peaks grows with the tier', () => {
    for (const seed of SEEDS) {
      const defs = plan(seed);
      const bars = (x: SectionDef): number => (x.endBeat - x.startBeat) / BEATS_PER_BAR;
      const total = defs.reduce((s, x) => s + bars(x), 0);
      const breather = defs.filter((x) => x.name === 'BREATHER').reduce((s, x) => s + bars(x), 0);
      expect(breather / total).toBeGreaterThanOrEqual(0.15);
      expect(breather / total).toBeLessThanOrEqual(0.25);
      const share = (lo: number, hi: number): number => {
        const part = defs.filter((x) => x.chapter >= lo && x.chapter <= hi && x.role !== 'gauntlet');
        const t = part.reduce((s, x) => s + bars(x), 0);
        return part.filter((x) => x.role === 'peak').reduce((s, x) => s + bars(x), 0) / t;
      };
      expect(share(4, 6)).toBeGreaterThan(share(1, 3));
    }
  });

  it('every section type turns up within 300 s (across the seeds), and each has its own obstacle behaviour', () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) for (const d of plan(seed)) seen.add(d.name);
    for (const n of SECTION_NAMES) expect(seen.has(n), n).toBe(true);
  });

  it('sectionStart / notice events fire as the beat clock crosses the boundaries (a phrase head each)', () => {
    const s = createState(7, false);
    s.invincible = true;
    const starts: { name: string; beatPos: number; startBeat: number }[] = [];
    let notices = 0;
    for (let i = 0; i < 120 * 150; i++) {
      for (const e of step(s, idle(), SIM_DT)) {
        if (e.type === 'sectionStart') starts.push({ name: e.name, beatPos: s.beatPos, startBeat: e.startBeat });
        if (e.type === 'sectionNotice') notices++;
      }
    }
    expect(starts.length).toBeGreaterThan(8);
    for (const x of starts) expect(x.beatPos - x.startBeat).toBeLessThan(0.06);
    expect(starts[0].startBeat).toBe(FIRST_SECTION_BEAT);
    expect(notices).toBeGreaterThan(0);
  });
});

describe('course fairness: every section and every boundary (10 seeds x 300 s)', () => {
  it('safe widths, reachability (with the real reach time), beat grid and section ranges', () => {
    let total = 0;
    const kinds = new Set<string>();
    const secKinds = new Map<string, Set<string>>();
    for (const seed of SEEDS) {
      const { list, sp } = generate(seed, 300);
      total += list.length;
      let prevSafe = [{ a: START_THETA, b: START_THETA }];
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        kinds.add(o.kind);
        if (!secKinds.has(o.section)) secKinds.set(o.section, new Set());
        secKinds.get(o.section)!.add(o.kind);
        expect(o.safe.length).toBeGreaterThan(0);
        for (const s of o.safe) expect(arcLen(s.a, s.b)).toBeGreaterThanOrEqual(SAFE_MIN_WIDTH - 1e-9);
        // reachability across the boundary to the previous obstacle, whichever section it belonged to
        const budget = REACH_FACTOR * MAX_ANG_VEL * o.reachDt;
        expect(o.reachDt).toBeGreaterThan(0);
        expect(o.reachDt).toBeLessThanOrEqual(o.dtPrev + 1e-9);
        expect(maxReachDistance(prevSafe, o.safe, 0.1 * DEG)).toBeLessThanOrEqual(budget + 1e-6);
        prevSafe = o.safe;
        // 8th-note grid; the gap never drops below 0.9 x the design gap (which only sections may widen)
        const beats = o.beat / 0.5;
        expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-9);
        if (i > 0) {
          const prev = list[i - 1];
          const gt = gapTime(tierAt(prev.tNom));
          const inner = o.kind === 'SNAKE' && prev.kind === 'SNAKE' ? SNAKE_INNER_FACTOR : 1;
          if (o.kind !== 'LASER' && prev.kind !== 'LASER') expect(o.dtPrev).toBeGreaterThanOrEqual(0.9 * gt * inner - 1e-9);
          expect(o.pos).toBeGreaterThan(prev.pos);
        }
        // the obstacle sits inside the section it is tagged with (a section that opens just before its tier-up borrows RANDOM)
        const def = sp.dir.at(o.beat);
        expect(o.beat).toBeGreaterThanOrEqual(def.startBeat);
        expect(o.beat + (o.kind === 'LASER' ? 1 : 0)).toBeLessThanOrEqual(def.endBeat + 1e-9);
        expect(o.section === def.name || o.section === 'RANDOM').toBe(true);
        expect(SECTION_MIN_TIER[o.section]).toBeLessThanOrEqual(Math.max(1, o.tier));
        // obstacles never overlap in z (a LASER is two beats long)
        if (i > 0) {
          const prev = list[i - 1];
          expect(o.pos - o.hw).toBeGreaterThan(prev.pos + prev.hw);
        }
      }
    }
    expect(total).toBeGreaterThan(1500);
    for (const k of ['GAP_RING', 'MULTI_GAP', 'SLAB', 'SPINNER', 'SNAKE', 'PULSE_RING', 'LASER']) expect(kinds.has(k), k).toBe(true);
    expect(secKinds.get('LASER')!.has('LASER')).toBe(true);
    expect(secKinds.get('PULSE')!.has('PULSE_RING')).toBe(true);
    expect(secKinds.get('SPLIT')!.has('MULTI_GAP')).toBe(true);
  });

  it('PULSE_RING breathes with the beat and is open >= the minimum gap whenever it overlaps the ship', () => {
    let rings = 0;
    for (const seed of SEEDS) {
      for (const o of generate(seed, 300).list.filter((x) => x.kind === 'PULSE_RING')) {
        rings++;
        const p = o.pulse!;
        expect(o.beat % 1).toBe(0); // whole beats: in step with the music
        const v = speedAt(o.tNom);
        const bpm = bpmAt(o.tNom);
        for (let k = 0; k <= 40; k++) {
          const z = -o.hw + (2 * o.hw * k) / 40;
          expect(pulseWidth(p, z, v, bpm)).toBeGreaterThanOrEqual(SAFE_MIN_WIDTH);
        }
        expect(pulseWidth(p, 0, v, bpm)).toBeCloseTo(p.wOpen, 9);
        expect(arcLen(o.safe[0].a, o.safe[0].b)).toBeCloseTo(p.wOpen, 9);
        // ... and it really closes (half a beat of road before the arrival)
        const halfBeat = ((v * 60) / bpm) * 0.5;
        expect(pulseWidth(p, -halfBeat, v, bpm)).toBeCloseTo(PULSE_CLOSED_GAP, 6);
      }
    }
    expect(rings).toBeGreaterThan(50);
  });

  it('LASER: the safe zone stays clear of the beams at every sampled instant of the sweep (and is reachable)', () => {
    let lasers = 0;
    let two = 0;
    for (const seed of SEEDS) {
      for (const o of generate(seed, 300).list.filter((x) => x.kind === 'LASER')) {
        lasers++;
        if (o.solids.length === 2) two++;
        expect(o.solids.length).toBeGreaterThanOrEqual(1);
        // two beats of road
        const v = speedAt(o.tNom);
        const secs = (2 * (o.hw - 0.3)) / v;
        expect(secs).toBeGreaterThan(1.7 * (60 / bpmAt(o.tNom)));
        expect(secs).toBeLessThan(2.3 * (60 / bpmAt(o.tNom)));
        expect(Math.abs(o.omega)).toBeGreaterThanOrEqual(0.9);
        expect(Math.abs(o.omega)).toBeLessThanOrEqual(2.4 + 1e-9);
        let minClear = Infinity;
        for (let k = 0; k <= 60; k++) {
          const z = -o.hw + (2 * o.hw * k) / 60;
          // the sim rotates the beams by omega x z / baseSpeed(now)
          const rot = o.rotHit + (o.omega * z) / speedAt(o.tNom + z / v);
          const beams = o.solids.map((s) => ({ a: wrap(s.a + rot), b: wrap(s.b + rot) }));
          // the safe set, sampled every degree, is outside every beam by at least the margin
          for (const s of o.safe) {
            const len = arcLen(s.a, s.b);
            for (let d = 0; d <= len; d += 1 * DEG) minClear = Math.min(minClear, pointSetDistance(wrap(s.a + d), beams));
          }
          // at this instant the free arcs between the beams are all wide enough to fly in
          const gaps = [...beams].sort((p, q) => p.a - q.a);
          for (let i = 0; i < gaps.length; i++) {
            const nx = gaps[(i + 1) % gaps.length];
            if (gaps.length === 1 || nx !== gaps[i]) expect(arcLen(gaps[i].b, nx.a)).toBeGreaterThanOrEqual(SAFE_MIN_WIDTH);
          }
        }
        expect(minClear).toBeGreaterThanOrEqual(LASER_MARGIN * 0.8);
      }
    }
    expect(lasers).toBeGreaterThan(60);
    expect(two).toBeGreaterThan(0);
  });

  it('SPLIT: a wide safe route and a narrow one that is still flyable; chains are routed through the narrow gap', () => {
    let rings = 0;
    let fallback = 0;
    let chained = 0;
    for (const seed of SEEDS.slice(0, 6)) {
      const { list, sp } = generate(seed, 300);
      for (const o of list.filter((x) => x.section === 'SPLIT')) {
        rings++;
        // (the rare fallback ring - when no SPLIT could be fair - carries a single safe zone and is not a SPLIT)
        if (o.safe.length === 1) {
          fallback++;
          continue;
        }
        expect(o.safe.length).toBe(2);
        expect(o.narrow).toBe(1);
        const w = arcLen(o.safe[0].a, o.safe[0].b);
        const n = arcLen(o.safe[1].a, o.safe[1].b);
        expect(w).toBeGreaterThan(n);
        expect(n).toBeGreaterThanOrEqual(SAFE_MIN_WIDTH);
      }
      // every SPLIT ring (but the last one: its chain waits for a successor) has a shard chain, all inside its narrow gap
      const shards = [...sp.shardQ];
      const split = list.filter((x) => x.section === 'SPLIT' && x.safe.length === 2).slice(0, -1);
      for (const o of split) {
        const mine = shards.filter((x) => x.anchorId === o.id);
        if (mine.length === 0) continue; // a chain is skipped when it would not clear a neighbouring solid
        chained++;
        for (const sh of mine) expect(arcContains(o.safe[1].a, o.safe[1].b, sh.theta)).toBe(true);
      }
    }
    expect(rings).toBeGreaterThan(30);
    expect(fallback).toBeLessThan(rings * 0.05);
    expect(chained).toBeGreaterThan(rings * 0.6);
  });
});

describe('BREATHER shard rain', () => {
  it('sparse obstacles (>= 1.6 x the design gap) and several shard chains per obstacle', () => {
    let chains = 0;
    let obstacles = 0;
    for (const seed of SEEDS.slice(0, 6)) {
      const { list, sp } = generate(seed, 300);
      const mine = list.filter((x) => x.section === 'BREATHER').slice(1, -1);
      for (const o of mine) {
        expect(o.dtPrev).toBeGreaterThanOrEqual(1.6 * gapTime(tierAt(o.tNom - o.dtPrev)) - 1e-9);
        obstacles++;
        chains += new Set(sp.shardQ.filter((x) => x.anchorId === o.id).map((x) => x.chainId)).size;
      }
    }
    expect(obstacles).toBeGreaterThan(40);
    expect(chains / obstacles).toBeGreaterThan(1.5);
  });
});

describe('course in the sim', () => {
  const SEC300 = 300;

  it('the greedy bot survives 300 s on 10 seeds through every section (items off: a NITRO pick-up would break the beat grid)', () => {
    const names = new Set<string>();
    for (const seed of SEEDS) {
      const s = createState(seed, false);
      const input = idle();
      const clears: GameEvent[] = [];
      const maxSteps = Math.ceil(SEC300 / SIM_DT);
      let n = 0;
      while (s.alive && s.t < SEC300 && n < maxSteps * 2) {
        botInput(s, input);
        for (const e of step(s, input, SIM_DT)) {
          if (e.type === 'sectionStart') names.add(e.name);
          if (e.type === 'gauntletClear') clears.push(e);
        }
        n++;
      }
      expect(s.alive, 'seed ' + seed).toBe(true);
      expect(s.t).toBeGreaterThanOrEqual(SEC300);
      // one fanfare per GAUNTLET survived: chapters 2..5 end in one each
      expect(clears.length).toBe(4);
      expect(s.section.gauntlets).toBe(4);
    }
    for (const n of SECTION_NAMES) expect(names.has(n), n).toBe(true);
  });

  it('forceSection(name) puts that section next; the bot flies every one of them at the highest tiers', () => {
    for (const name of SECTION_NAMES) {
      const s = createState(11, false);
      const input = idle();
      // run to tier 5 first so every section is allowed
      while (s.alive && s.t < 100) {
        botInput(s, input);
        step(s, input, SIM_DT);
      }
      expect(s.alive).toBe(true);
      forceSection(s, name);
      let started = false;
      let met = 0;
      const until = s.t + 16;
      while (s.alive && s.t < until) {
        botInput(s, input);
        for (const e of step(s, input, SIM_DT)) if (e.type === 'sectionStart' && e.name === name) started = true;
        if (s.obstacles[0]?.section === name && s.obstacles[0].z > -2) met++;
      }
      expect(s.alive, name).toBe(true);
      expect(started, name).toBe(true);
      expect(met, name).toBeGreaterThan(0);
    }
  });

  it('PULSE rings stay open at the ship even at NITRO / OVERDRIVE speed (the breathing follows the road, not the clock)', () => {
    const s = createState(5, false);
    s.invincible = true;
    while (s.t < 60) step(s, idle(), SIM_DT);
    forceSection(s, 'PULSE');
    s.nitroT = 1000; // 1.35 x the road speed: 2 units per step, so the 1.4 unit hit window is sampled most of the time
    let seen = 0;
    let closedSomewhere = false;
    for (let i = 0; i < 120 * 14; i++) {
      step(s, idle(), SIM_DT);
      for (const o of s.obstacles) {
        if (o.pulse === null) continue;
        const gap = TAU - arcLen(o.cur[0].a, o.cur[0].b);
        if (gap < SAFE_MIN_WIDTH - 1e-6 && o.z < -2 * HIT_WINDOW) closedSomewhere = true;
        if (Math.abs(o.z) <= o.hw) {
          seen++;
          expect(gap).toBeGreaterThanOrEqual(SAFE_MIN_WIDTH - 1e-6);
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(closedSomewhere).toBe(true);
  });

  it('an obstacle that is a LASER is two beats long in z and hits for the whole length', () => {
    const s = createState(5, false);
    s.invincible = true;
    while (s.t < 60) step(s, idle(), SIM_DT);
    forceSection(s, 'LASER');
    let found: Obstacle | null = null;
    for (let i = 0; i < 120 * 10 && !found; i++) {
      step(s, idle(), SIM_DT);
      found = s.obstacles.find((o) => o.kind === 'LASER') ?? null;
    }
    expect(found).not.toBeNull();
    const o = found as Obstacle;
    expect(o.hw).toBeGreaterThan(20);
    expect(o.thickness).toBeCloseTo(2 * (o.hw - 0.3), 9);
    // the beam is already in the hit window when the ship is one beat away
    const vBeat = (speedAt(o.tNom) * 60) / bpmAt(o.tNom);
    expect(o.hw).toBeGreaterThan(0.8 * vBeat);
    expect(timeAtBeat(o.beat)).toBeCloseTo(o.tNom, 9);
  });
});
