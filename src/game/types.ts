import type { ItemKind, SectionName, SectionRole } from './constants';
import type { Director } from './sections';
import type { Rng } from './rng';

export interface Arc {
  /** CCW start, [0, 2pi) */
  a: number;
  /** CCW end, [0, 2pi) */
  b: number;
}

export type ObstacleKind = 'GAP_RING' | 'MULTI_GAP' | 'SLAB' | 'SPINNER' | 'SNAKE' | 'PULSE_RING' | 'LASER';

/** One section of the course (DESIGN 20.2): a run of obstacles between two beats. */
export interface SectionDef {
  idx: number;
  name: SectionName;
  role: SectionRole;
  /** first / one-past-last beat (bar aligned) in which obstacles of this section reach the ship */
  startBeat: number;
  endBeat: number;
  /** tier chapter the section belongs to (1..6) */
  chapter: number;
  /** 0..1, drives gap time, spinner / laser speed, music */
  intensity: number;
  /** debug (forceSection): ignore the section's minimum tier */
  forced?: boolean;
}

/** PULSE_RING gap geometry: the gap is centred on `center` and breathes between `wClosed` and `wOpen` once per beat. */
export interface PulseInfo {
  center: number;
  wOpen: number;
  wClosed: number;
}

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
  /** section this obstacle belongs to */
  section: SectionName;
  thickness: number;
  /** half length of the Z hit window (ship half thickness included): HIT_WINDOW for rings, longer for LASER */
  hw: number;
  /** Solid arcs as they are right now (== solids unless the obstacle breathes, i.e. PULSE_RING). */
  cur: Arc[];
  pulse: PulseInfo | null;
  /** seconds the ship has to get from the previous obstacle's safe zone to this one's (centre gap minus half lengths) */
  reachDt: number;
  /** index in safe[] of the narrow (greedy) route of a SPLIT ring, -1 otherwise */
  narrow: number;
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
  | { type: 'biomeChange'; biome: number }
  | { type: 'sectionNotice'; name: SectionName; inBeats: number }
  | { type: 'sectionStart'; name: SectionName; idx: number; role: SectionRole; intensity: number; bars: number; startBeat: number }
  | { type: 'gauntletClear'; points: number }
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
  /** Section planner (derives from the seed alone). */
  dir: Director;
  /** per-section generator memory */
  sec: SectionMemo;
  /** seconds from the last placed obstacle's centre to its trailing end (LASER is two beats long) */
  prevTrail: number;
  prevHalf: number;
}

export interface SectionMemo {
  idx: number;
  /** centre of the last ring this section placed (null = none yet) */
  center: number | null;
  dir: number;
  n: number;
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

/** The section the ship is running through (events fire when beatPos crosses a boundary). */
export interface SectionState {
  idx: number;
  name: SectionName;
  role: SectionRole;
  intensity: number;
  startBeat: number;
  endBeat: number;
  /** index of the next def to announce / start */
  next: number;
  noticed: number;
  /** sections cleared: GAUNTLETs survived */
  gauntlets: number;
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
  /** Section the ship is in right now (by beat). */
  section: SectionState;
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
