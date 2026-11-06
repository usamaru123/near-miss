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
  rainbow?: boolean;
}
export const TIERS: readonly TierDef[] = [
  { name: 'WARM UP', primary: 0x00f0ff, secondary: 0xff2bd6 },
  { name: 'RUSH', primary: 0xa6ff00, secondary: 0x00f0ff },
  { name: 'FRENZY', primary: 0xff8a00, secondary: 0xa23bff },
  { name: 'HYPER', primary: 0xff2bd6, secondary: 0xffee00 },
  { name: 'MANIAC', primary: 0xff1a2e, secondary: 0xffffff },
  { name: 'BEYOND', primary: 0xffffff, secondary: 0xffffff, rainbow: true },
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

// --- beat sync (section 15.1 / 16.3) ---
/** BPM follows the un-boosted speed: 140 at speed 50 -> 185 at speed 180. NITRO / OVERDRIVE do not change it. */
export const BPM_AT_BASE = 140;
export const BPM_AT_MAX = 185;
export const BPM_SLOPE_PER_SPEED = (BPM_AT_MAX - BPM_AT_BASE) / (SPEED_MAX - SPEED_BASE);
/** Grid unit: obstacles arrive on 8th notes (0.5 beats). */
export const BEAT_GRID = 0.5;
/** Quantised gaps are never shorter than this fraction of the design gapTime. */
export const GAP_MIN_FRACTION = 0.9;
export const ONBEAT_WINDOW = 0.07;
export const ONBEAT_MULT = 1.5;
export const BEAT_STREAK_EVERY = 4;
export const BEAT_STREAK_SCORE = 2000;

// --- CLUTCH + hit-stop (section 15.3) ---
export const CLUTCH_MAX_PEN = 2.5 * DEG;
export const CLUTCH_COOLDOWN = 8;
export const CLUTCH_TIMESCALE = 0.06;
export const CLUTCH_DURATION = 0.45;
export const CLUTCH_SCORE = 3000;
export const CLUTCH_ADRENALINE = 0.35;
export const HITSTOP_TIMESCALE = 0.03;
export const HITSTOP_INSANE = 0.05;
export const HITSTOP_INSANE_BEAT = 0.07;
export const HITSTOP_CLUTCH = 0.1;
/** Total hit-stop allowed in any trailing second (real time). */
export const HITSTOP_CAP_PER_SEC = 0.15;

// --- ghost / PB pace (section 15.2) ---
export const GHOST_Z_MIN = -14;
export const GHOST_Z_MAX = 3;
/** Score difference that moves the ghost by one world unit. */
export const GHOST_SCORE_PER_UNIT = 300;
export const TRACE_HZ = 10;
export const TRACE_MAX_SECONDS = 15 * 60;
export const OVERTAKE_MAX = 3;

// --- style rank + ZONE (section 18) ---
export const RANK_NAMES = ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS'] as const;
/** Style needed to hold each rank. */
export const RANK_THRESH: readonly number[] = [0, 100, 250, 450, 700, 1000, 1400];
/** Style lost per sim second at each rank. */
export const RANK_DECAY: readonly number[] = [0, 15, 25, 40, 60, 85, 110];
/** Score multiplier per rank (multiplies the combo / NITRO / DOUBLE chain). */
export const RANK_MULT: readonly number[] = [1, 1.1, 1.25, 1.5, 2, 2.5, 3];
export const RANK_S = 4;
export const RANK_SS = 5;
export const RANK_SSS = 6;
/** Seconds the style may stay under the held rank's threshold before the rank drops. */
export const RANK_DOWN_GRACE = 0.5;
export const STYLE_ADD = {
  near: 40,
  insane: 90,
  onBeat: 30,
  beatStreak: 60,
  clutch: 200,
  shard: 8,
  perfect: 80,
  smash: 30,
  item: 20,
  overtake: 50,
} as const;
export const STYLE_PENALTY = { comboBreak: 150, shieldBreak: 200 } as const;
/** Continuous SSS time that opens the ZONE. */
export const ZONE_ENTER_TIME = 3;
/** Score factor of ZONE Lv.1; every further level adds 1 (so 1 + Lv). */
export const ZONE_BASE_FACTOR = 2;
export const ZONE_LV_SECONDS = 10;
/** Per beat the BANK grows by this fraction x Lv. */
export const ZONE_BANK_COMPOUND = 0.01;
export const ZONE_BREAK_PAY = 0.5;
/** ZONE entry "charge": the world eases down to this timeScale over ZONE_CHARGE_DOWN real seconds, then back over ZONE_CHARGE_UP. */
export const ZONE_CHARGE_SCALE = 0.2;
export const ZONE_CHARGE_DOWN = 0.25;
export const ZONE_CHARGE_UP = 0.3;

// --- inflation (section 18.5) ---
/** Near-miss base points are multiplied by (baseSpeed / SPEED_BASE) ^ this. */
export const SPEED_SCORE_EXP = 1.5;
/** Consecutive INSANEs double the INSANE bonus, up to 2^this. */
export const INSANE_CHAIN_MAX_EXP = 10;
/** First 10^n score milestone (100,000). */
export const MILESTONE_FIRST_EXP = 5;
/** Chain breakdown is shown from this total multiplier on. */
export const BREAKDOWN_MIN = 10;
/** Ghost depth: score difference per world unit is at least this fraction of the best's score at the same time. */
export const GHOST_REL_PER_UNIT = 0.05;
