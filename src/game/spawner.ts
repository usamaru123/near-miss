import { arcCenter, arcLen, maxReachDistance, safeFromSolids, wrap } from './angles';
import {
  DEG,
  FIRST_OBSTACLE_TIME,
  ITEM_SEED_XOR,
  POWERUP_INTERVAL_MAX,
  POWERUP_INTERVAL_MIN,
  KIND_WEIGHTS,
  MAX_ANG_VEL,
  MULTI_GAP_MIN_SOLID,
  OBSTACLE_THICK,
  REACH_FACTOR,
  SAFE_MIN_WIDTH,
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
  SPINNER_OMEGA_MIN,
  START_THETA,
  TAU,
} from './constants';
import { updateItems } from './items';
import { distAt, gapTime, gapWidth, quantizeGapBeat, spinnerOmegaMax, tierAt, timeAtBeat } from './difficulty';
import { Rng } from './rng';
import type { Arc, Obstacle, ObstacleKind, SpawnerState } from './types';

interface Cand {
  kind: ObstacleKind;
  solids: Arc[];
  omega: number;
  rotHit: number;
  safe: Arc[];
  /** dt multiplier relative to the base gap time (1 for leader, SNAKE_INNER_FACTOR for followers) */
  dtFactor: number;
}

const SAMPLE_STEP = 0.5 * DEG;
const REACH_EPS = 0.01;

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
  };
}

export function makeObstacle(
  id: number,
  kind: ObstacleKind,
  pos: number,
  solids: Arc[],
  extra: { omega?: number; rotHit?: number; tNom?: number; beat?: number; dtPrev?: number; tier?: number } = {},
): Obstacle {
  const rotHit = extra.rotHit ?? 0;
  return {
    id,
    kind,
    pos,
    tNom: extra.tNom ?? 0,
    beat: extra.beat ?? 0,
    dtPrev: extra.dtPrev ?? 0,
    tier: extra.tier ?? 1,
    thickness: OBSTACLE_THICK,
    solids,
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

function ringSolid(center: number, w: number): Arc {
  return { a: wrap(center + w / 2), b: wrap(center - w / 2) };
}

function genRing(rng: Rng, tier: number, anchor: number | null, kind: ObstacleKind = 'GAP_RING'): Cand {
  const c = anchor ?? rng.range(0, TAU);
  const solids = [ringSolid(c, gapWidth(tier))];
  return { kind, solids, omega: 0, rotHit: 0, safe: safeFromSolids(solids, 0), dtFactor: 1 };
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
  return { kind: 'MULTI_GAP', solids, omega: 0, rotHit: 0, safe: safeFromSolids(solids, 0), dtFactor: 1 };
}

function genSlab(rng: Rng, anchor: number | null): Cand {
  const len = rng.range(SLAB_MIN, SLAB_MAX);
  const start = anchor === null ? rng.range(0, TAU) : anchor + Math.PI - len / 2;
  const solids = [{ a: wrap(start), b: wrap(start + len) }];
  return { kind: 'SLAB', solids, omega: 0, rotHit: 0, safe: safeFromSolids(solids, 0), dtFactor: 1 };
}

function genSpinner(rng: Rng, tier: number, anchor: number | null): Cand {
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
  const omega = rng.sign() * rng.range(SPINNER_OMEGA_MIN, spinnerOmegaMax(tier));
  return { kind: 'SPINNER', solids, omega, rotHit, safe: safeFromSolids(solids, rotHit), dtFactor: 1 };
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

function generate(rng: Rng, kind: ObstacleKind, tier: number, anchor: number | null, gt: number): Cand[] {
  switch (kind) {
    case 'GAP_RING':
      return [genRing(rng, tier, anchor)];
    case 'MULTI_GAP':
      return [genMulti(rng, tier, anchor)];
    case 'SLAB':
      return [genSlab(rng, anchor)];
    case 'SPINNER':
      return [genSpinner(rng, tier, anchor)];
    case 'SNAKE':
      return genSnake(rng, tier, anchor, gt);
  }
}

/**
 * Beat-grid placement of a candidate chain starting after `beat0`: beat of each obstacle and the real time
 * gap to its predecessor. (Design gaps are quantised to 0.5 beats, never below 0.9 x the design time.)
 */
function plan(beat0: number, cands: Cand[], gt: number, beats: number[], dts: number[]): void {
  let b = beat0;
  for (let i = 0; i < cands.length; i++) {
    const nb = quantizeGapBeat(b, gt * cands[i].dtFactor);
    beats[i] = nb;
    dts[i] = timeAtBeat(nb) - timeAtBeat(b);
    b = nb;
  }
}

function chainValid(prevSafe: Arc[], cands: Cand[], beat0: number, gt: number): boolean {
  const beats: number[] = [];
  const dts: number[] = [];
  plan(beat0, cands, gt, beats, dts);
  let prev = prevSafe;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    for (const s of c.safe) if (arcLen(s.a, s.b) < SAFE_MIN_WIDTH) return false;
    const r = reachDistance(dts[i]) - REACH_EPS;
    if (maxReachDistance(prev, c.safe, SAMPLE_STEP) > r) return false;
    prev = c.safe;
  }
  return true;
}

function widestCenter(set: Arc[]): number {
  let best = set[0];
  for (const s of set) if (arcLen(s.a, s.b) > arcLen(best.a, best.b)) best = s;
  return arcCenter(best.a, best.b);
}

function generateChain(sp: SpawnerState, tier: number, gt: number): Cand[] {
  const rng = sp.rng;
  for (let i = 0; i < SPAWN_RETRIES; i++) {
    const cands = generate(rng, pickKind(rng, tier), tier, null, gt);
    if (chainValid(sp.prevSafe, cands, sp.beat, gt)) return cands;
  }
  // Fallback 1: pull the gap toward the previous safe zone.
  const anchor = widestCenter(sp.prevSafe);
  for (const kind of ['GAP_RING', 'SNAKE'] as ObstacleKind[]) {
    if (kind === 'SNAKE' && tier < 3) continue;
    const cands = generate(rng, kind, tier, anchor, gt);
    if (chainValid(sp.prevSafe, cands, sp.beat, gt)) return cands;
  }
  // Fallback 2: a slab is always reachable (worst case 50deg away vs >= 92deg reach).
  for (let i = 0; i < 24; i++) {
    const c = genSlab(rng, null);
    if (chainValid(sp.prevSafe, [c], sp.beat, gt)) return [c];
  }
  const c = genSlab(rng, anchor);
  c.solids = [{ a: wrap(anchor + Math.PI - SLAB_MIN / 2), b: wrap(anchor + Math.PI + SLAB_MIN / 2) }];
  c.safe = safeFromSolids(c.solids, 0);
  return [c];
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
  const gt = first ? FIRST_OBSTACLE_TIME : gapTime(tierAt(sp.tNom));
  const tier = tierAt(sp.tNom + gt);
  const cands = generateChain(sp, tier, gt);
  const beats: number[] = [];
  const dts: number[] = [];
  plan(sp.beat, cands, gt, beats, dts);
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    sp.beat = beats[i];
    sp.tNom = timeAtBeat(sp.beat);
    const o = makeObstacle(sp.nextId++, c.kind, distAt(sp.tNom) + sp.dOff, c.solids, {
      omega: c.omega,
      rotHit: c.rotHit,
      tNom: sp.tNom,
      beat: sp.beat,
      dtPrev: dts[i],
      tier,
    });
    o.safe = c.safe;
    sp.queue.push(o);
    sp.recent.push(o);
  }
  sp.prevSafe = cands[cands.length - 1].safe;
  updateItems(sp);
}
