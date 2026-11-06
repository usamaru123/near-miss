import { angDiff, arcCenter, arcLen, pointSetDistance, wrap } from './angles';
import {
  CHAIN_EVERY_MAX,
  CHAIN_EVERY_MIN,
  DEG,
  HIT_WINDOW,
  ITEM_KINDS,
  ITEM_WEIGHTS,
  POWERUP_CLEARANCE,
  POWERUP_EDGE_MAX,
  POWERUP_EDGE_MIN,
  POWERUP_INTERVAL_MAX,
  POWERUP_INTERVAL_MIN,
  SHARD_CLEARANCE,
  SHARD_EDGE_MAX,
  SHARD_EDGE_MIN,
  SHARD_MAX_COUNT,
  SHARD_MIN_COUNT,
  SHARD_SPACING_TIME,
  SHARD_WEAVE_STEP,
} from './constants';
import type { ItemKind } from './constants';
import { distAt, speedAt } from './difficulty';
import type { Arc, Obstacle, Shard, SpawnerState } from './types';

/** Items closer than this to an obstacle's Z are validated against its solids. */
const Z_CHECK = HIT_WINDOW + 1.0;
const MIN_ARC = 28 * DEG;
const RECENT_KEEP = 8;

export type ChainRoute = 'SAFE' | 'EDGE' | 'WEAVE';

/** Solid arcs of `o` at the moment the ship is `dz` past its centre (same formula as the sim). */
export function solidsAt(o: Obstacle, dz: number): Arc[] {
  const rot = o.omega !== 0 ? o.rotHit + (o.omega * dz) / Math.max(1, speedAt(o.tNom)) : 0;
  if (rot === 0) return o.solids;
  return o.solids.map((s) => ({ a: wrap(s.a + rot), b: wrap(s.b + rot) }));
}

/** Distance (rad) from `theta` to the nearest solid of every obstacle overlapping `pos`; 0 means inside. */
export function solidClearance(obstacles: readonly Obstacle[], pos: number, theta: number): number {
  let m = Infinity;
  for (const o of obstacles) {
    const dz = pos - o.pos;
    if (Math.abs(dz) > Z_CHECK) continue;
    const d = pointSetDistance(theta, solidsAt(o, dz));
    if (d < m) m = d;
  }
  return m;
}

function pickSafeArc(sp: SpawnerState, o: Obstacle): Arc | null {
  const ok = o.safe.filter((s) => arcLen(s.a, s.b) >= MIN_ARC);
  if (ok.length === 0) return null;
  return ok[sp.itemRng.int(0, ok.length - 1)];
}

function pickKind(sp: SpawnerState): ItemKind {
  let total = 0;
  for (const w of ITEM_WEIGHTS) total += w;
  let r = sp.itemRng.next() * total;
  for (let i = 0; i < ITEM_KINDS.length; i++) {
    r -= ITEM_WEIGHTS[i];
    if (r < 0) return ITEM_KINDS[i];
  }
  return 'SHIELD';
}

function insertSorted<T extends { pos: number }>(q: T[], item: T): void {
  let i = q.length;
  while (i > 0 && q[i - 1].pos > item.pos) i--;
  q.splice(i, 0, item);
}

function makeChain(sp: SpawnerState, o: Obstacle): boolean {
  const rng = sp.itemRng;
  const arc = pickSafeArc(sp, o);
  if (!arc) return false;
  const n = rng.int(SHARD_MIN_COUNT, SHARD_MAX_COUNT);
  const r = rng.next();
  const route: ChainRoute = r < 0.4 ? 'SAFE' : r < 0.7 ? 'EDGE' : 'WEAVE';
  const w = arcLen(arc.a, arc.b);
  const center = arcCenter(arc.a, arc.b);
  const thetas: number[] = [];
  if (route === 'SAFE') {
    for (let k = 0; k < n; k++) thetas.push(center);
  } else if (route === 'EDGE') {
    const fromStart = rng.chance(0.5);
    const d = rng.range(SHARD_EDGE_MIN, SHARD_EDGE_MAX);
    for (let k = 0; k < n; k++) thetas.push(fromStart ? wrap(arc.a + d) : wrap(arc.b - d));
  } else {
    const amp = Math.min(11 * DEG, w / 2 - SHARD_CLEARANCE - 5 * DEG);
    const step = Math.min(SHARD_WEAVE_STEP, (2 * amp * 1.6) / Math.max(1, n - 1));
    let off = -amp;
    let dir = 1;
    if (rng.chance(0.5)) {
      off = amp;
      dir = -1;
    }
    for (let k = 0; k < n; k++) {
      thetas.push(wrap(center + off));
      off += dir * step;
      if (off > amp) {
        off = amp - (off - amp);
        dir = -1;
      } else if (off < -amp) {
        off = -amp + (-amp - off);
        dir = 1;
      }
    }
  }
  const chainId = sp.nextChainId++;
  const made: Shard[] = [];
  for (let k = 0; k < n; k++) {
    const pos = distAt(o.tNom + (k - (n - 1) / 2) * SHARD_SPACING_TIME) + sp.dOff;
    // never inside a solid, with a visual margin
    if (solidClearance(sp.recent, pos, thetas[k]) < SHARD_CLEARANCE) return false;
    made.push({ id: 0, chainId, idx: k, chainLen: n, anchorId: o.id, pos, theta: thetas[k], z: 0, done: false });
  }
  for (const s of made) {
    s.id = sp.nextItemId++;
    insertSorted(sp.shardQ, s);
  }
  return true;
}

function makePowerup(sp: SpawnerState, o: Obstacle): boolean {
  const rng = sp.itemRng;
  const arc = pickSafeArc(sp, o);
  if (!arc) return false;
  const kind = pickKind(sp);
  const center = arcCenter(arc.a, arc.b);
  let theta = center;
  if (rng.chance(0.5)) {
    const d = rng.range(POWERUP_EDGE_MIN, POWERUP_EDGE_MAX);
    theta = rng.chance(0.5) ? wrap(arc.a + d) : wrap(arc.b - d);
  }
  if (solidClearance(sp.recent, o.pos, theta) < POWERUP_CLEARANCE) return false;
  insertSorted(sp.powerQ, {
    id: sp.nextItemId++,
    kind,
    anchorId: o.id,
    pos: o.pos,
    theta,
    z: 0,
    done: false,
  });
  return true;
}

/**
 * Called after the obstacle spawner produced new obstacles. Each obstacle is processed once its
 * successor exists (so neighbours can be checked). Reads obstacles only; uses its own RNG.
 */
export function updateItems(sp: SpawnerState): void {
  if (!sp.itemsEnabled) return;
  while (sp.itemCursor + 1 < sp.recent.length) {
    const o = sp.recent[sp.itemCursor++];
    if (o.kind === 'SNAKE') continue;
    if (sp.chainCountdown <= 0) {
      if (makeChain(sp, o)) sp.chainCountdown = sp.itemRng.int(CHAIN_EVERY_MIN, CHAIN_EVERY_MAX);
      else sp.chainCountdown = 1;
    } else {
      sp.chainCountdown--;
      if (o.tNom >= sp.nextPowerupT) {
        if (makePowerup(sp, o)) {
          sp.nextPowerupT = o.tNom + sp.itemRng.range(POWERUP_INTERVAL_MIN, POWERUP_INTERVAL_MAX);
        }
      }
    }
  }
  if (sp.recent.length > RECENT_KEEP + 4) {
    const drop = sp.recent.length - RECENT_KEEP;
    sp.recent.splice(0, drop);
    sp.itemCursor = Math.max(0, sp.itemCursor - drop);
  }
}

export function angleToItem(theta: number, itemTheta: number): number {
  return Math.abs(angDiff(theta, itemTheta));
}
