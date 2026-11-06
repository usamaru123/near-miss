import type { ItemKind } from './constants';
import type { Rng } from './rng';

export interface Arc {
  /** CCW start, [0, 2pi) */
  a: number;
  /** CCW end, [0, 2pi) */
  b: number;
}

export type ObstacleKind = 'GAP_RING' | 'MULTI_GAP' | 'SLAB' | 'SPINNER' | 'SNAKE';

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  /** Position along the track (distance units). */
  pos: number;
  /** Nominal time the ship reaches it (course time). */
  tNom: number;
  /** Nominal time since the previous obstacle. */
  dtPrev: number;
  tier: number;
  thickness: number;
  /** Solid arcs. For spinners these are relative to rotation 0 (rotate by `rot`). */
  solids: Arc[];
  /** Safe arcs at the moment the obstacle passes the ship. */
  safe: Arc[];
  omega: number;
  /** Rotation at hit time. */
  rotHit: number;
  /** Current rotation. */
  rot: number;
  /** Current z relative to ship (negative = ahead). */
  z: number;
  /** Smallest observed angular distance (ship edge to solid edge) while overlapping. */
  minDist: number;
  overlapped: boolean;
  touched: boolean;
}

export interface Input {
  /** -1..1 ; positive = increasing angle */
  move: number;
  focus: boolean;
  /** Edge-triggered request to start OVERDRIVE. */
  overdrive: boolean;
}

export interface Shard {
  id: number;
  chainId: number;
  /** index inside the chain, 0-based */
  idx: number;
  chainLen: number;
  /** Obstacle the chain is routed through */
  anchorId: number;
  pos: number;
  theta: number;
  z: number;
  done: boolean;
}

export interface PowerUp {
  id: number;
  kind: ItemKind;
  anchorId: number;
  pos: number;
  theta: number;
  z: number;
  done: boolean;
}

export type GameEvent =
  | { type: 'nearMiss'; points: number; mult: number; combo: number; theta: number; dist: number; pan: number }
  | { type: 'insane'; points: number; mult: number; combo: number; theta: number; dist: number; pan: number }
  | { type: 'smash'; points: number; theta: number; id: number }
  | { type: 'pass'; pan: number; dist: number }
  | { type: 'death'; theta: number }
  | { type: 'tierUp'; tier: number }
  | { type: 'overdriveStart' }
  | { type: 'overdriveEnd' }
  | { type: 'focusStart' }
  | { type: 'focusEnd' }
  | { type: 'comboBreak'; combo: number }
  | { type: 'shard'; points: number; chainIdx: number; idx: number; chainLen: number; theta: number }
  | { type: 'perfectChain'; points: number; theta: number }
  | { type: 'powerup'; kind: ItemKind; theta: number }
  | { type: 'effectEnd'; kind: ItemKind }
  | { type: 'shieldBreak'; theta: number; id: number }
  | { type: 'emp'; count: number; points: number }
  | { type: 'multUp'; mult: number };

export interface SpawnerState {
  rng: Rng;
  tNom: number;
  nextId: number;
  prevSafe: Arc[];
  queue: Obstacle[];
  /** Separate RNG stream for items: obstacle generation never touches it. */
  itemsEnabled: boolean;
  itemRng: Rng;
  recent: Obstacle[];
  itemCursor: number;
  chainCountdown: number;
  nextPowerupT: number;
  nextChainId: number;
  nextItemId: number;
  shardQ: Shard[];
  powerQ: PowerUp[];
}

export interface GameState {
  seed: number;
  /** Play time in sim seconds. */
  t: number;
  /** Distance travelled. */
  dist: number;
  /** Current speed incl. overdrive. */
  speed: number;
  baseSpeed: number;
  maxSpeed: number;
  theta: number;
  angVel: number;
  score: number;
  combo: number;
  maxCombo: number;
  multiplier: number;
  comboTimer: number;
  adrenaline: number;
  overdriveT: number;
  overdrive: boolean;
  graceT: number;
  focus: number;
  focusActive: boolean;
  focusLocked: boolean;
  timeScale: number;
  tier: number;
  maxTier: number;
  alive: boolean;
  deathTimer: number;
  deathDone: boolean;
  invincible: boolean;
  spawnEnabled: boolean;
  /** Visual/feel: ease the speed in over the first LAUNCH_RAMP_TIME seconds. */
  launchRamp: boolean;
  shards: Shard[];
  powerups: PowerUp[];
  shield: boolean;
  nitroT: number;
  doubleT: number;
  warpT: number;
  chainId: number;
  chainRun: number;
  chainGot: number;
  chainBroken: boolean;
  obstacles: Obstacle[];
  spawner: SpawnerState;
  events: GameEvent[];
}
