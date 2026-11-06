import { arcCenter, arcLen, maxReachDistance, safeFromSolids, wrap } from './angles';
import {
  BEAT_GRID,
  DEG,
  FIRST_OBSTACLE_TIME,
  HIT_WINDOW,
  ITEM_SEED_XOR,
  KIND_WEIGHTS,
  LASER_BEATS,
  LASER_MARGIN,
  LASER_MIN_SAFE_2BEAM,
  LASER_OMEGA_MAX,
  LASER_OMEGA_MIN,
  LASER_WIDTH,
  MAX_ANG_VEL,
  MULTI_GAP_MIN_SOLID,
  POWERUP_INTERVAL_MAX,
  POWERUP_INTERVAL_MIN,
  PULSE_CLOSED_GAP,
  PULSE_MIN_OPEN,
  REACH_FACTOR,
  ROLE_GAP_SCALE,
  SAFE_MIN_WIDTH,
  SECTION_MIN_TIER,
  SHIP_Z_THICK,
  SLAB_MAX,
  SLAB_MIN,
  SNAKE_INNER_FACTOR,
  SNAKE_MAX_COUNT,
  SNAKE_MIN_COUNT,
  SNAKE_SHIFT_MAX,
  SNAKE_SHIFT_MIN,
  SPAWN_RETRIES,
  SPINNER_BLADE_WIDTH,
  SPINNER_MIN_BLADE_GAP,
  SPINNER_OMEGA_MAX,
  SPINNER_OMEGA_MIN,
  SPLIT_NARROW,
  SPLIT_WIDE_EXTRA,
  START_THETA,
  TAU,
} from './constants';
import type { SectionName } from './constants';
import { updateItems } from './items';
import { distAt, gapTime, gapWidth, quantizeGapBeat, spinnerOmegaMax, tierAt, timeAtBeat } from './difficulty';
import { Rng } from './rng';
import { Director } from './sections';
import type { Arc, Obstacle, ObstacleKind, PulseInfo, SectionDef, SpawnerState } from './types';

interface Cand {
  kind: ObstacleKind;
  solids: Arc[];
  omega: number;
  rotHit: number;
  safe: Arc[];
  /** dt multiplier relative to the base gap time (1 for leader, SNAKE_INNER_FACTOR for followers) */
  dtFactor: number;
  /** beat quantisation step (PULSE rings land on whole beats so the breathing is in step with the music) */
  step: number;
  /** half length in beats (LASER = 1): the obstacle occupies [beat - half, beat + half] */
  half: number;
  pulse: PulseInfo | null;
  narrow: number;
  /** ring centre to remember for the next ring of the section */
  center: number | null;
}

const SAMPLE_STEP = 0.5 * DEG;
const REACH_EPS = 0.01;
/** the hardest-of-N choice of a GAUNTLET never asks for more than this fraction of the reach budget */
const GAUNTLET_DEMAND_CAP = 0.9;
const GAUNTLET_TRIES = 8;

export function reachDistance(gt: number): number {
  return REACH_FACTOR * MAX_ANG_VEL * gt;
}

export function createSpawner(seed: number, itemsEnabled = true, dOff = 0): SpawnerState {
  const itemRng = new Rng((seed ^ ITEM_SEED_XOR) >>> 0);
  return {
    rng: new Rng(seed),
    itemsEnabled,
    itemRng,
    recent: [],
    itemCursor: 0,
    chainCountdown: itemRng.int(1, 2),
    nextPowerupT: itemRng.range(POWERUP_INTERVAL_MIN, POWERUP_INTERVAL_MAX),
    nextChainId: 1,
    nextItemId: 1,
    shardQ: [],
    powerQ: [],
    tNom: 0,
    beat: 0,
    dOff,
    nextId: 1,
    // The ship starts (and idles) at START_THETA.
    prevSafe: [{ a: START_THETA, b: START_THETA }],
    queue: [],
    dir: new Director(seed),
    sec: { idx: -1, center: null, dir: 1, n: 0 },
    prevTrail: 0,
    prevHalf: 0,
  };
}

export function makeObstacle(
  id: number,
  kind: ObstacleKind,
  pos: number,
  solids: Arc[],
  extra: {
    omega?: number;
    rotHit?: number;
    tNom?: number;
    beat?: number;
    dtPrev?: number;
    tier?: number;
    section?: SectionName;
    hw?: number;
    pulse?: PulseInfo | null;
    reachDt?: number;
    narrow?: number;
  } = {},
): Obstacle {
  const rotHit = extra.rotHit ?? 0;
  const hw = extra.hw ?? HIT_WINDOW;
  const pulse = extra.pulse ?? null;
  return {
    id,
    kind,
    pos,
    tNom: extra.tNom ?? 0,
    beat: extra.beat ?? 0,
    dtPrev: extra.dtPrev ?? 0,
    tier: extra.tier ?? 1,
    section: extra.section ?? 'RANDOM',
    thickness: 2 * (hw - SHIP_Z_THICK / 2),
    hw,
    solids,
    cur: pulse ? solids.map((s) => ({ a: s.a, b: s.b })) : solids,
    pulse,
    reachDt: extra.reachDt ?? extra.dtPrev ?? 0,
    narrow: extra.narrow ?? -1,
    safe: safeFromSolids(solids, rotHit),
    omega: extra.omega ?? 0,
    rotHit,
    rot: rotHit,
    z: 0,
    minDist: Infinity,
    overlapped: false,
    touched: false,
  };
}

function mk(kind: ObstacleKind, solids: Arc[], omega: number, rotHit: number, safe: Arc[], over: Partial<Cand> = {}): Cand {
  return { kind, solids, omega, rotHit, safe, dtFactor: 1, step: BEAT_GRID, half: 0, pulse: null, narrow: -1, center: null, ...over };
}

function ringSolid(center: number, w: number): Arc {
  return { a: wrap(center + w / 2), b: wrap(center - w / 2) };
}

function genRing(rng: Rng, tier: number, anchor: number | null, kind: ObstacleKind = 'GAP_RING', widen = 0): Cand {
  const c = anchor ?? rng.range(0, TAU);
  const solids = [ringSolid(c, gapWidth(tier) + widen)];
  return mk(kind, solids, 0, 0, safeFromSolids(solids, 0), { center: c });
}

function genMulti(rng: Rng, tier: number, anchor: number | null): Cand {
  const n = rng.int(2, 3);
  const w = gapWidth(tier);
  const total = TAU - n * w;
  const extraTotal = total - n * MULTI_GAP_MIN_SOLID;
  const weights: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = 0.2 + rng.next();
    weights.push(v);
    sum += v;
  }
  let cursor = (anchor ?? rng.range(0, TAU)) - w / 2;
  const solids: Arc[] = [];
  for (let i = 0; i < n; i++) {
    const solidStart = cursor + w;
    const len = MULTI_GAP_MIN_SOLID + (extraTotal * weights[i]) / sum;
    solids.push({ a: wrap(solidStart), b: wrap(solidStart + len) });
    cursor = solidStart + len;
  }
  return mk('MULTI_GAP', solids, 0, 0, safeFromSolids(solids, 0));
}

function genSlab(rng: Rng, anchor: number | null): Cand {
  const len = rng.range(SLAB_MIN, SLAB_MAX);
  const start = anchor === null ? rng.range(0, TAU) : anchor + Math.PI - len / 2;
  const solids = [{ a: wrap(start), b: wrap(start + len) }];
  return mk('SLAB', solids, 0, 0, safeFromSolids(solids, 0));
}

function genSpinner(rng: Rng, tier: number, anchor: number | null, omegaScale = 1): Cand {
  const n = rng.int(2, 4);
  const extraTotal = TAU - n * (SPINNER_BLADE_WIDTH + SPINNER_MIN_BLADE_GAP);
  const weights: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = rng.next();
    weights.push(v);
    sum += v;
  }
  const solids: Arc[] = [];
  let cursor = 0;
  let firstGapCenter = 0;
  for (let i = 0; i < n; i++) {
    solids.push({ a: wrap(cursor), b: wrap(cursor + SPINNER_BLADE_WIDTH) });
    const gap = SPINNER_MIN_BLADE_GAP + (sum > 0 ? (extraTotal * weights[i]) / sum : 0);
    if (i === 0) firstGapCenter = cursor + SPINNER_BLADE_WIDTH + gap / 2;
    cursor += SPINNER_BLADE_WIDTH + gap;
  }
  const rotHit = anchor === null ? rng.range(0, TAU) : wrap(anchor - firstGapCenter);
  const hi = Math.min(SPINNER_OMEGA_MAX, Math.max(SPINNER_OMEGA_MIN, spinnerOmegaMax(tier) * omegaScale));
  const omega = rng.sign() * rng.range(SPINNER_OMEGA_MIN, hi);
  return mk('SPINNER', solids, omega, rotHit, safeFromSolids(solids, rotHit));
}

function genSnake(rng: Rng, tier: number, anchor: number | null, gt: number): Cand[] {
  const count = rng.int(SNAKE_MIN_COUNT, SNAKE_MAX_COUNT);
  const innerReach = reachDistance(gt * SNAKE_INNER_FACTOR);
  const maxShift = Math.min(SNAKE_SHIFT_MAX, innerReach * 0.8);
  let center = anchor ?? rng.range(0, TAU);
  let dir = rng.sign();
  const out: Cand[] = [];
  for (let i = 0; i < count; i++) {
    const c = genRing(rng, tier, center, 'SNAKE');
    c.dtFactor = i === 0 ? 1 : SNAKE_INNER_FACTOR;
    out.push(c);
    if (rng.chance(0.22)) dir = -dir;
    center = wrap(center + dir * rng.range(SNAKE_SHIFT_MIN, Math.max(SNAKE_SHIFT_MIN, maxShift)));
  }
  return out;
}

/** PULSE_RING: open (full gap width) when it reaches the ship, breathing shut and open again once per beat on the way. */
function genPulse(tier: number, center: number): Cand {
  const wOpen = Math.max(PULSE_MIN_OPEN, gapWidth(tier));
  const solids = [ringSolid(center, wOpen)];
  return mk('PULSE_RING', solids, 0, 0, safeFromSolids(solids, 0), {
    step: 1,
    pulse: { center, wOpen, wClosed: PULSE_CLOSED_GAP },
    center,
  });
}

/** Seconds one beat of road takes around `beat` (the laser is two beats long: one beat each side of its centre). */
function beatSeconds(beat: number): number {
  return timeAtBeat(beat + LASER_BEATS / 2) - timeAtBeat(beat);
}

/**
 * LASER: 1 or 2 thin beams sweeping round the tunnel for two beats of road. The safe zone is what the beams never reach
 * (swept sector + beam width + margin), so a safe place exists at every instant of the sweep.
 */
function genLaser(rng: Rng, tier: number, intensity: number, beat0: number): Cand | null {
  const two = intensity >= 0.75 && tier >= 4 && rng.chance(0.55);
  const hi = Math.min(LASER_OMEGA_MAX, 1.3 + 0.22 * (tier - 3)) * (0.75 + 0.35 * intensity);
  const omega = rng.sign() * rng.range(LASER_OMEGA_MIN, Math.max(LASER_OMEGA_MIN + 0.1, hi));
  // time the beam spends from the laser's centre to either end of its hit window (one beat of road + ship half thickness)
  const t0 = timeAtBeat(beat0 + 3);
  const spd = (distAt(t0 + 0.01) - distAt(t0 - 0.01)) / 0.02;
  const tHalf = beatSeconds(beat0 + 3) + SHIP_Z_THICK / 2 / Math.max(1, spd);
  const half = Math.abs(omega) * tHalf + LASER_WIDTH / 2 + LASER_MARGIN;
  const phi = rng.range(0, TAU);
  const bases = two ? [phi, wrap(phi + Math.PI + rng.range(-15, 15) * DEG)] : [phi];
  const solids: Arc[] = bases.map((b) => ({ a: wrap(b - LASER_WIDTH / 2), b: wrap(b + LASER_WIDTH / 2) }));
  const swept: Arc[] = bases.map((b) => ({ a: wrap(b - half), b: wrap(b + half) }));
  const minSafe = two ? LASER_MIN_SAFE_2BEAM : SAFE_MIN_WIDTH + 30 * DEG;
  if (2 * half >= Math.PI * 0.95) return null;
  const safe = safeFromSolids(swept, 0);
  if (safe.length !== bases.length) return null;
  for (const s of safe) if (arcLen(s.a, s.b) < minSafe) return null;
  return mk('LASER', solids, omega, 0, safe, { half: LASER_BEATS / 2 });
}

/** SPLIT ring: a wide safe gap and, about opposite, a narrow gap (the shard route). */
function genSplit(rng: Rng, tier: number, wideCenter: number): Cand {
  const W = gapWidth(tier) + SPLIT_WIDE_EXTRA;
  const N = SPLIT_NARROW;
  const off = rng.range(150, 210) * DEG;
  const solids: Arc[] = [
    { a: wrap(wideCenter + W / 2), b: wrap(wideCenter + off - N / 2) },
    { a: wrap(wideCenter + off + N / 2), b: wrap(wideCenter - W / 2) },
  ];
  const safe: Arc[] = [
    { a: wrap(wideCenter - W / 2), b: wrap(wideCenter + W / 2) },
    { a: wrap(wideCenter + off - N / 2), b: wrap(wideCenter + off + N / 2) },
  ];
  return mk('MULTI_GAP', solids, 0, 0, safe, { narrow: 1, center: wideCenter });
}

function pickKind(rng: Rng, tier: number): ObstacleKind {
  const w = KIND_WEIGHTS[tier - 1];
  let total = 0;
  for (let i = 0; i < w.length; i++) total += w[i];
  let r = rng.next() * total;
  const kinds: ObstacleKind[] = ['GAP_RING', 'MULTI_GAP', 'SLAB', 'SPINNER', 'SNAKE'];
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r < 0) return kinds[i];
  }
  return 'GAP_RING';
}

function generate(rng: Rng, kind: ObstacleKind, tier: number, anchor: number | null, gt: number, omegaScale = 1): Cand[] {
  switch (kind) {
    case 'MULTI_GAP':
      return [genMulti(rng, tier, anchor)];
    case 'SLAB':
      return [genSlab(rng, anchor)];
    case 'SPINNER':
      return [genSpinner(rng, tier, anchor, omegaScale)];
    case 'SNAKE':
      return genSnake(rng, tier, anchor, gt);
    default:
      return [genRing(rng, tier, anchor)];
  }
}

interface Plan {
  beats: number[];
  dts: number[];
  /** reach time per obstacle: gap to the predecessor minus the half lengths of both */
  rdts: number[];
  /** seconds from the last obstacle's centre to its trailing end */
  trail: number;
}

function newPlan(): Plan {
  return { beats: [], dts: [], rdts: [], trail: 0 };
}

function copyPlan(p: Plan): Plan {
  return { beats: p.beats.slice(), dts: p.dts.slice(), rdts: p.rdts.slice(), trail: p.trail };
}

/**
 * Beat-grid placement of a candidate chain starting after `beat0`: beat of each obstacle and the real time
 * gap to its predecessor. (Design gaps are quantised to 0.5 beats, never below 0.9 x the design time; PULSE rings use whole
 * beats; LASERs keep clear of their neighbours' ends.) The first obstacle lands no earlier than `minBeat`.
 */
function plan(sp: SpawnerState, cands: Cand[], gt: number, minBeat: number, out: Plan): Plan {
  let b = sp.beat;
  let prevHalf = sp.prevHalf;
  let prevTrail = sp.prevTrail;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const step = c.step;
    let nb = quantizeGapBeat(b, gt * c.dtFactor, step);
    if (i === 0 && nb < minBeat - 1e-9) nb = b + Math.ceil((minBeat - b) / step - 1e-9) * step;
    const clear = prevHalf + c.half;
    if (clear > 0) while (nb < b + clear + BEAT_GRID - 1e-9) nb += step;
    if (step > BEAT_GRID && Math.abs(nb - Math.round(nb)) > 1e-9) nb += BEAT_GRID; // whole beats
    out.beats[i] = nb;
    out.dts[i] = timeAtBeat(nb) - timeAtBeat(b);
    const lead = c.half > 0 ? timeAtBeat(nb) - timeAtBeat(nb - c.half) : 0;
    out.rdts[i] = out.dts[i] - prevTrail - lead;
    prevTrail = c.half > 0 ? timeAtBeat(nb + c.half) - timeAtBeat(nb) : 0;
    prevHalf = c.half;
    b = nb;
  }
  out.trail = prevTrail;
  return out;
}

/**
 * Plan + validate: safe widths, reachability with the real (reach) time gaps. Returns the largest fraction of the reach
 * budget any hop asks for, or -1 when the chain is not fair (or does not fit the section).
 */
function chainDemand(sp: SpawnerState, cands: Cand[], gt: number, minBeat: number, endBeat: number, out: Plan): number {
  plan(sp, cands, gt, minBeat, out);
  if (!fits(out.beats[0], cands[0].half, endBeat)) return -1;
  let prev = sp.prevSafe;
  let demand = 0;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    for (const s of c.safe) if (arcLen(s.a, s.b) < SAFE_MIN_WIDTH) return -1;
    if (out.rdts[i] <= 0) return -1;
    const budget = reachDistance(out.rdts[i]);
    const need = maxReachDistance(prev, c.safe, SAMPLE_STEP);
    if (need > budget - REACH_EPS) return -1;
    demand = Math.max(demand, need / budget);
    prev = c.safe;
  }
  return demand;
}

function widestCenter(set: Arc[]): number {
  let best = set[0];
  for (const s of set) if (arcLen(s.a, s.b) > arcLen(best.a, best.b)) best = s;
  return arcCenter(best.a, best.b);
}

/** A ring must land before the end of its section; a LASER (half > 0) must also have finished by then. */
function fits(beat: number, half: number, endBeat: number): boolean {
  return half > 0 ? beat + half <= endBeat + 1e-9 : beat < endBeat - 1e-9;
}

/** Drop the part of a chain that would run past the end of its section (a LASER must also finish inside it). */
function trim(cands: Cand[], pl: Plan, endBeat: number): Cand[] {
  let n = cands.length;
  while (n > 1 && !fits(pl.beats[n - 1], cands[n - 1].half, endBeat)) n--;
  if (n < cands.length) {
    cands.length = n;
    pl.trail = cands[n - 1].half > 0 ? timeAtBeat(pl.beats[n - 1] + cands[n - 1].half) - timeAtBeat(pl.beats[n - 1]) : 0;
  }
  return cands;
}

/** One random chain for the section (null = the generator gave up this time). */
function sectionCands(sp: SpawnerState, def: SectionDef, tier: number, gt: number): Cand[] | null {
  const rng = sp.rng;
  const memo = sp.sec;
  const base = memo.center ?? widestCenter(sp.prevSafe);
  const dtEst = timeAtBeat(quantizeGapBeat(sp.beat, gt)) - timeAtBeat(sp.beat);
  const reach = reachDistance(dtEst);
  const omegaScale = 0.7 + 0.5 * def.intensity;
  // a section that opens a little before its tier-up (chapters are snapped down to a bar line) borrows the tier's old rules
  const name = tier >= SECTION_MIN_TIER[def.name] || def.forced ? def.name : 'RANDOM';
  switch (name) {
    case 'RANDOM':
    case 'DARK':
    case 'FLIP':
      return generate(rng, pickKind(rng, tier), tier, null, gt, omegaScale);
    case 'SPIRAL': {
      const hi = Math.min((tier >= 4 ? 46 : 32) * DEG, reach * 0.8);
      const lo = Math.min((tier >= 4 ? 22 : 14) * DEG, hi);
      return [genRing(rng, tier, wrap(base + memo.dir * rng.range(lo, hi)))];
    }
    case 'ZIGZAG': {
      const hi = Math.min((tier >= 4 ? 66 : 52) * DEG, reach * 0.8);
      const lo = Math.min(30 * DEG, hi);
      const swing = (memo.n % 2 === 0 ? 1 : -1) * memo.dir * rng.range(lo, hi);
      return [genRing(rng, tier, wrap(base + swing))];
    }
    case 'PULSE': {
      const hi = Math.min(26 * DEG, reach * 0.7);
      return [genPulse(tier, wrap(base + rng.range(-hi, hi)))];
    }
    case 'LASER': {
      const c = genLaser(rng, tier, def.intensity, sp.beat);
      return c ? [c] : null;
    }
    case 'SPLIT': {
      const hi = Math.min(24 * DEG, reach * 0.6);
      return [genSplit(rng, tier, wrap(base + memo.dir * rng.range(Math.min(8 * DEG, hi), hi)))];
    }
    case 'BREATHER': {
      // sparse and generous: wide gaps and fat slabs, then room to pick up the shard rain
      if (rng.chance(0.3)) return [genSlab(rng, null)];
      return [genRing(rng, tier, wrap(base + rng.range(-70, 70) * DEG), 'GAP_RING', 28 * DEG)];
    }
    case 'GAUNTLET': {
      // the hardest tools of the tier, at the design gap time
      const r = rng.next();
      if (tier >= 3 && r < 0.28) return genSnake(rng, tier, null, gt);
      if (tier >= 3 && r < 0.46) {
        const c = genLaser(rng, tier, 1, sp.beat);
        if (c) return [c];
      }
      if (r < 0.7) return [genSpinner(rng, tier, null, 1.2)];
      if (r < 0.88) return [genMulti(rng, tier, null)];
      return [genRing(rng, tier, null)];
    }
  }
}

interface Pick {
  cands: Cand[];
  plan: Plan;
}

function generateChain(sp: SpawnerState, def: SectionDef, tier: number, gtBase: number, first: boolean): Pick {
  const gt = first ? gtBase : gtBase * ROLE_GAP_SCALE[def.role];
  const minBeat = def.startBeat;
  const pl = newPlan();
  const hardest = def.name === 'GAUNTLET';
  let best: Cand[] | null = null;
  let bestDemand = -1;
  let bestPlan: Plan | null = null;
  const tries = hardest ? GAUNTLET_TRIES : SPAWN_RETRIES;
  for (let i = 0; i < tries; i++) {
    const cands = sectionCands(sp, def, tier, gt);
    if (!cands) continue;
    const d = chainDemand(sp, cands, gt, minBeat, def.endBeat, pl);
    if (d < 0) continue;
    if (!hardest) {
      trim(cands, pl, def.endBeat);
      return { cands, plan: copyPlan(pl) };
    }
    if (d <= GAUNTLET_DEMAND_CAP && d > bestDemand) {
      trim(cands, pl, def.endBeat);
      best = cands;
      bestDemand = d;
      bestPlan = copyPlan(pl);
    }
  }
  if (best && bestPlan) return { cands: best, plan: bestPlan };
  // Fallback 1: pull the gap toward the previous safe zone.
  const anchor = widestCenter(sp.prevSafe);
  for (const kind of ['GAP_RING', 'SNAKE'] as ObstacleKind[]) {
    if (kind === 'SNAKE' && tier < 3) continue;
    const cands = generate(sp.rng, kind, tier, anchor, gt);
    if (chainDemand(sp, cands, gt, minBeat, def.endBeat, pl) >= 0) {
      trim(cands, pl, def.endBeat);
      return { cands, plan: copyPlan(pl) };
    }
  }
  // Fallback 2: a slab is always reachable (worst case 50deg away vs >= 92deg reach).
  for (let i = 0; i < 24; i++) {
    const c = genSlab(sp.rng, null);
    if (chainDemand(sp, [c], gt, minBeat, def.endBeat, pl) >= 0) return { cands: [c], plan: copyPlan(pl) };
  }
  const c = genSlab(sp.rng, anchor);
  c.solids = [{ a: wrap(anchor + Math.PI - SLAB_MIN / 2), b: wrap(anchor + Math.PI + SLAB_MIN / 2) }];
  c.safe = safeFromSolids(c.solids, 0);
  chainDemand(sp, [c], gt, minBeat, Infinity, pl);
  return { cands: [c], plan: copyPlan(pl) };
}

/** Next obstacle in track order without consuming it. */
export function peekObstacle(sp: SpawnerState): Obstacle {
  if (sp.queue.length === 0) generateMore(sp);
  return sp.queue[0];
}

/** Returns (and consumes) the next obstacle in track order (ascending pos). */
export function nextObstacle(sp: SpawnerState): Obstacle {
  if (sp.queue.length === 0) generateMore(sp);
  return sp.queue.shift()!;
}

function generateMore(sp: SpawnerState): void {
  const first = sp.nextId === 1;
  const gtBase = first ? FIRST_OBSTACLE_TIME : gapTime(tierAt(sp.tNom));
  const tier = tierAt(sp.tNom + gtBase);
  // which section does the next obstacle land in? (the one holding the first beat after the last obstacle)
  let def = sp.dir.at(sp.beat);
  let pick: Pick;
  for (let guard = 0; ; guard++) {
    const gt = first ? gtBase : gtBase * ROLE_GAP_SCALE[def.role];
    if (Math.max(quantizeGapBeat(sp.beat, gt), def.startBeat) >= def.endBeat - 1e-9) {
      def = sp.dir.get(def.idx + 1);
      continue;
    }
    if (sp.sec.idx !== def.idx) sp.sec = { idx: def.idx, center: null, dir: sp.rng.sign(), n: 0 };
    pick = generateChain(sp, def, tier, gtBase, first);
    // the section's own spacing rules (whole beats, laser clearance) can push the first obstacle past its end
    if (pick.plan.beats[0] >= def.endBeat - 1e-9 && guard < 4) {
      def = sp.dir.get(def.idx + 1);
      continue;
    }
    break;
  }
  const { cands, plan: pl } = pick;
  sp.sec.center = cands[cands.length - 1].center;
  sp.sec.n++;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    sp.beat = pl.beats[i];
    sp.tNom = timeAtBeat(sp.beat);
    // LASER: two beats of road, symmetric about the grid beat
    let hw = HIT_WINDOW;
    if (c.half > 0) hw = 0.5 * (distAt(timeAtBeat(sp.beat + c.half)) - distAt(timeAtBeat(sp.beat - c.half))) + SHIP_Z_THICK / 2;
    const o = makeObstacle(sp.nextId++, c.kind, distAt(sp.tNom) + sp.dOff, c.solids, {
      omega: c.omega,
      rotHit: c.rotHit,
      tNom: sp.tNom,
      beat: sp.beat,
      dtPrev: pl.dts[i],
      tier,
      section: tier >= SECTION_MIN_TIER[def.name] || def.forced ? def.name : 'RANDOM',
      hw,
      pulse: c.pulse,
      reachDt: pl.rdts[i],
      narrow: c.narrow,
    });
    o.safe = c.safe;
    sp.queue.push(o);
    sp.recent.push(o);
    sp.prevHalf = c.half;
  }
  sp.prevTrail = pl.trail;
  sp.prevSafe = cands[cands.length - 1].safe;
  updateItems(sp);
}
