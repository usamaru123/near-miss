// All tuning values live here. No three.js / DOM imports allowed in src/game.
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

// --- loop ---
export const SIM_DT = 1 / 120;
export const MAX_STEPS_PER_FRAME = 8;

// --- geometry ---
export const TUNNEL_R = 6;
export const SHIP_RADIUS = TUNNEL_R - 0.8;
export const SHIP_HALF_ANGLE = 6 * DEG;
export const SHIP_Z_THICK = 0.6;
export const OBSTACLE_THICK = 0.8;
/** Obstacle/ship Z overlap half window. */
export const HIT_WINDOW = OBSTACLE_THICK / 2 + SHIP_Z_THICK / 2;
export const START_THETA = 1.5 * Math.PI;

// --- ship control ---
export const MAX_ANG_VEL = 4.2;
export const ANG_ACCEL = 30;
export const ANG_DECEL = 40;

// --- speed ---
export const SPEED_BASE = 50;
export const SPEED_GROWTH = 1.4;
export const SPEED_MAX = 180;
export const OVERDRIVE_SPEED_MULT = 1.6;
export const KMH_FACTOR = 9;
/** Time at which speed reaches SPEED_MAX. */
export const SPEED_CAP_TIME = (SPEED_MAX - SPEED_BASE) / SPEED_GROWTH;

// --- tiers ---
export const TIER_DURATION = 25;
export const MAX_TIER = 6;
export interface TierDef {
  name: string;
  primary: number;
  secondary: number;
  bpm: number;
  rainbow?: boolean;
}
export const TIERS: readonly TierDef[] = [
  { name: 'WARM UP', primary: 0x00f0ff, secondary: 0xff2bd6, bpm: 120 },
  { name: 'RUSH', primary: 0xa6ff00, secondary: 0x00f0ff, bpm: 132 },
  { name: 'FRENZY', primary: 0xff8a00, secondary: 0xa23bff, bpm: 144 },
  { name: 'HYPER', primary: 0xff2bd6, secondary: 0xffee00, bpm: 156 },
  { name: 'MANIAC', primary: 0xff1a2e, secondary: 0xffffff, bpm: 166 },
  { name: 'BEYOND', primary: 0xffffff, secondary: 0xffffff, bpm: 175, rainbow: true },
];

// --- obstacles / spawner ---
export const GAP_WIDTH_T1 = 70 * DEG;
export const GAP_WIDTH_MIN = 42 * DEG;
export const GAP_TIME_T1 = 1.1;
export const GAP_TIME_T6 = 0.55;
export const SNAKE_INNER_FACTOR = 0.6;
export const REACH_FACTOR = 0.7;
export const SAFE_MARGIN = 16 * DEG;
export const SAFE_MIN_WIDTH = 2 * SHIP_HALF_ANGLE + SAFE_MARGIN;
export const FIRST_OBSTACLE_TIME = 3.0;
export const SPAWN_AHEAD = 320;
export const SLAB_MIN = 100 * DEG;
export const SLAB_MAX = 200 * DEG;
export const SPINNER_BLADE_WIDTH = 30 * DEG;
export const SPINNER_MIN_BLADE_GAP = 60 * DEG;
export const SPINNER_OMEGA_MIN = 0.6;
export const SPINNER_OMEGA_MAX = 1.8;
export const MULTI_GAP_MIN_SOLID = 24 * DEG;
export const SNAKE_MIN_COUNT = 4;
export const SNAKE_MAX_COUNT = 7;
export const SNAKE_SHIFT_MIN = 10 * DEG;
export const SNAKE_SHIFT_MAX = 32 * DEG;
export const SPAWN_RETRIES = 20;
/** Weights per tier index: RING, MULTI, SLAB, SPINNER, SNAKE */
export const KIND_WEIGHTS: readonly (readonly number[])[] = [
  [55, 0, 45, 0, 0],
  [35, 25, 15, 25, 0],
  [28, 20, 12, 20, 20],
  [26, 20, 10, 20, 24],
  [24, 20, 8, 22, 26],
  [22, 20, 8, 22, 28],
];

// --- near miss / scoring ---
export const INSANE_DIST = 4 * DEG;
export const NEAR_DIST = 10 * DEG;
export const NEAR_SCORE = 500;
export const INSANE_SCORE = 1500;
export const NEAR_ADRENALINE = 0.12;
export const INSANE_ADRENALINE = 0.25;
export const NEAR_FOCUS = 0.1;
export const INSANE_FOCUS = 0.2;
export const SMASH_SCORE = 1000;
export const COMBO_TIMEOUT = 3;
export const COMBO_PER_MULT = 4;
export const MULT_MAX = 8;

// --- adrenaline / overdrive / focus ---
export const ADRENALINE_DECAY = 0.015;
export const OVERDRIVE_DURATION = 5;
export const OVERDRIVE_GRACE = 0.6;
export const FOCUS_TIMESCALE = 0.35;
export const FOCUS_DRAIN = 0.33;
export const FOCUS_REGEN = 0.05;

// --- death ---
export const DEATH_SLOWMO_TIME = 1.0;
export const DEATH_TIMESCALE = 0.08;
export const GAMEOVER_INPUT_LOCK = 0.3;

// --- heart ---
export const HEART_BASE_BPM = 72;
export const HEART_SPEED_BPM = 0.9;
export const HEART_OVERDRIVE_BONUS = 30;

// --- camera / fx (render side, kept here for single tuning point) ---
export const FOV_MIN = 70;
export const FOV_MAX = 100;
export const FOV_OVERDRIVE = 112;
export const CAM_ROLL_MAX = 10 * DEG;
export const SHAKE = { nearMiss: 0.15, insane: 0.3, smash: 0.25, tierUp: 0.4, death: 1.0 };
export const REDUCED_FLASH_FACTOR = 0.3;
export const FOG_FAR = 330;

// --- sense of speed (section 10) ---
export const MILESTONES_KMH = [500, 1000, 1500];
export const LAUNCH_RAMP_TIME = 0.4;
export const LAUNCH_START_FOV = 60;
export const COUNTDOWN_STEP = 0.8;

// --- items (section 11) ---
export const SHARD_SCORE = 100;
export const SHARD_ADRENALINE = 0.02;
export const PERFECT_SCORE = 1000;
export const PERFECT_ADRENALINE = 0.08;
export const SHARD_PICK_ANGLE = 7 * DEG;
export const SHARD_PICK_Z = 1.0;
export const SHARD_MIN_COUNT = 5;
export const SHARD_MAX_COUNT = 8;
/** Time between neighbouring shards of a chain. */
export const SHARD_SPACING_TIME = 0.06;
/** Minimum angular clearance between a shard / item centre and any solid edge. */
export const SHARD_CLEARANCE = 3 * DEG;
export const SHARD_EDGE_MIN = 4 * DEG;
export const SHARD_EDGE_MAX = 8 * DEG;
export const SHARD_WEAVE_STEP = 7 * DEG;
export const CHAIN_EVERY_MIN = 3;
export const CHAIN_EVERY_MAX = 4;
export const POWERUP_PICK_ANGLE = 10 * DEG;
export const POWERUP_PICK_Z = 1.5;
export const POWERUP_CLEARANCE = 5 * DEG;
export const POWERUP_EDGE_MIN = 5 * DEG;
export const POWERUP_EDGE_MAX = 12 * DEG;
export const POWERUP_INTERVAL_MIN = 7;
export const POWERUP_INTERVAL_MAX = 11;
export type ItemKind = 'SHIELD' | 'NITRO' | 'DOUBLE' | 'WARP' | 'EMP';
export const ITEM_KINDS: readonly ItemKind[] = ['SHIELD', 'NITRO', 'DOUBLE', 'WARP', 'EMP'];
export const ITEM_WEIGHTS: readonly number[] = [25, 20, 20, 20, 15];
export const SHIELD_GRACE = 0.8;
export const NITRO_DURATION = 4;
export const NITRO_SPEED_MULT = 1.35;
export const DOUBLE_DURATION = 12;
export const WARP_DURATION = 4;
export const WARP_DRAIN_MULT = 0.5;
export const EMP_RANGE = 90;
export const ITEM_SEED_XOR = 0x9e3779b9;
