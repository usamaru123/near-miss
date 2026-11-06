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
  /** Beat position (8th-note grid) at which the obstacle reaches the ship. */
  beat: number;
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
  | { type: 'nearMiss'; points: number; mult: number; combo: number; theta: number; dist: number; pan: number; onBeat: boolean; streak: number }
  | { type: 'insane'; points: number; mult: number; combo: number; theta: number; dist: number; pan: number; onBeat: boolean; streak: number; chain: number }
  | { type: 'beatStreak'; streak: number; points: number }
  | { type: 'clutchStart'; theta: number; dir: number }
  | { type: 'clutchSuccess'; points: number; theta: number }
  | { type: 'clutchFail' }
  | { type: 'smash'; points: number; theta: number; id: number }
  | { type: 'pass'; pan: number; dist: number; onBeat: boolean }
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
  | { type: 'multUp'; mult: number }
  | { type: 'rankUp'; rank: number; from: number }
  | { type: 'rankDown'; rank: number; from: number }
  | { type: 'zoneEnter' }
  | { type: 'zoneLevel'; lv: number }
  | { type: 'zoneClear'; bank: number }
  | { type: 'zoneBreak'; bank: number; paid: number }
  | { type: 'zoneLost'; bank: number }
  | { type: 'scoreMilestone'; exp: number };

export interface SpawnerState {
  rng: Rng;
  tNom: number;
  /** Beat position of the last obstacle placed. */
  beat: number;
  /** Added to every course position (the launch ramp costs distance, so this is negative then so obstacles stay on the beat grid). */
  dOff: number;
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

export interface ClutchState {
  active: boolean;
  /** Real seconds left. */
  t: number;
  /** Direction (+1 / -1) of the nearest escape, 0 when already clear. */
  dir: number;
  obs: Obstacle | null;
  /** Real-time clock value of the last CLUTCH start. */
  lastStart: number;
}

/** Style rank meter (section 18.1). */
export interface StyleState {
  value: number;
  /** held rank, 0 (D) .. 6 (SSS) */
  rank: number;
  maxRank: number;
  /** seconds the value has been under the held rank's threshold */
  downT: number;
  /** continuous seconds at SSS (outside a ZONE) */
  sssT: number;
}

/** ZONE state (section 18.2). While active, every point earned goes to the BANK instead of the score. */
export interface ZoneState {
  active: boolean;
  /** sim seconds since entry */
  t: number;
  lv: number;
  maxLv: number;
  bank: number;
  /** last beat index the BANK compounded on */
  beat: number;
  /** BANK forfeited by the last death (game-over screen) */
  lost: number;
  /** ZONEs entered this run */
  entries: number;
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
  /** Beat clock owned by the sim: integral of BPM / 60 over sim time. */
  beatPos: number;
  /** Current BPM (follows the un-boosted speed). */
  bpm: number;
  /** ON BEAT near misses in a row. */
  beatStreak: number;
  /** Real-time clock (never scaled). */
  realT: number;
  /** Real seconds of hit-stop still to play. */
  hitStopT: number;
  hitStopActive: boolean;
  /** Rolling 1 s window (one flag per step) used to cap total hit-stop. */
  hitRing: Uint8Array;
  hitRingIdx: number;
  hitRingSum: number;
  /** Debug / tests: turn ON BEAT detection off (everything counts as off-beat). */
  beatBonus: boolean;
  /** Reduced-flash mode halves hit-stop. */
  reducedFlash: boolean;
  clutch: ClutchState;
  style: StyleState;
  zone: ZoneState;
  /** Real seconds left of the ZONE-entry slow-motion dip (0 = none). */
  zoneChargeT: number;
  /** consecutive INSANEs (the INSANE bonus doubles with each one) */
  insaneChain: number;
  /** highest 10^n the score has been announced for */
  milestoneExp: number;
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
