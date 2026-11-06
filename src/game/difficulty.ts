import {
  BEAT_GRID,
  BPM_AT_BASE,
  BPM_SLOPE_PER_SPEED,
  GAP_MIN_FRACTION,
  GAP_TIME_T1,
  LAUNCH_RAMP_TIME,
  ONBEAT_WINDOW,
  GAP_TIME_T6,
  GAP_WIDTH_MIN,
  GAP_WIDTH_T1,
  MAX_TIER,
  SPEED_BASE,
  SPEED_CAP_TIME,
  SPEED_GROWTH,
  SPEED_MAX,
  SPINNER_OMEGA_MAX,
  SPINNER_OMEGA_MIN,
  TIER_DURATION,
} from './constants';

/** Base speed (no overdrive) at play time t. */
export function speedAt(t: number): number {
  return Math.min(SPEED_BASE + SPEED_GROWTH * t, SPEED_MAX);
}

/** Course distance travelled at base speed after play time t. */
export function distAt(t: number): number {
  if (t <= SPEED_CAP_TIME) return SPEED_BASE * t + 0.5 * SPEED_GROWTH * t * t;
  return (
    SPEED_BASE * SPEED_CAP_TIME +
    0.5 * SPEED_GROWTH * SPEED_CAP_TIME * SPEED_CAP_TIME +
    SPEED_MAX * (t - SPEED_CAP_TIME)
  );
}

export function tierAt(t: number): number {
  return Math.min(MAX_TIER, 1 + Math.floor(t / TIER_DURATION));
}

export function gapWidth(tier: number): number {
  const f = (tier - 1) / (MAX_TIER - 1);
  return GAP_WIDTH_T1 + (GAP_WIDTH_MIN - GAP_WIDTH_T1) * f;
}

export function gapTime(tier: number): number {
  const f = (tier - 1) / (MAX_TIER - 1);
  return GAP_TIME_T1 + (GAP_TIME_T6 - GAP_TIME_T1) * f;
}

export function spinnerOmegaMax(tier: number): number {
  return Math.min(SPINNER_OMEGA_MAX, SPINNER_OMEGA_MIN + (tier - 1) * 0.24);
}

// ---------------------------------------------------------------- beat clock (DESIGN 15.1 / 16.3)

/** BPM for a given un-boosted speed. */
export function bpmAtSpeed(baseSpeed: number): number {
  return BPM_AT_BASE + (baseSpeed - SPEED_BASE) * BPM_SLOPE_PER_SPEED;
}

/** BPM at play time t (linear while the speed grows, constant after the cap). */
export function bpmAt(t: number): number {
  return bpmAtSpeed(speedAt(t));
}

const BPM_RATE = SPEED_GROWTH * BPM_SLOPE_PER_SPEED; // BPM per second while accelerating
const BEATS_AT_CAP = (BPM_AT_BASE * SPEED_CAP_TIME + 0.5 * BPM_RATE * SPEED_CAP_TIME * SPEED_CAP_TIME) / 60;

/** beatPos = integral of BPM(t)/60 dt, in closed form. */
export function beatAt(t: number): number {
  if (t <= 0) return (BPM_AT_BASE * t) / 60;
  if (t <= SPEED_CAP_TIME) return (BPM_AT_BASE * t + 0.5 * BPM_RATE * t * t) / 60;
  return BEATS_AT_CAP + (bpmAt(SPEED_CAP_TIME) * (t - SPEED_CAP_TIME)) / 60;
}

/** Inverse of beatAt. */
export function timeAtBeat(b: number): number {
  if (b <= 0) return (60 * b) / BPM_AT_BASE;
  if (b <= BEATS_AT_CAP) {
    return (-BPM_AT_BASE + Math.sqrt(BPM_AT_BASE * BPM_AT_BASE + 2 * BPM_RATE * 60 * b)) / BPM_RATE;
  }
  return SPEED_CAP_TIME + ((b - BEATS_AT_CAP) * 60) / bpmAt(SPEED_CAP_TIME);
}

/** Distance from the nearest 8th-note grid line, in sim seconds, for a sim time. */
export function gridOffsetSec(t: number): number {
  const b = beatAt(t);
  const nearest = Math.round(b / BEAT_GRID) * BEAT_GRID;
  return (Math.abs(b - nearest) * 60) / bpmAt(t);
}

/** ON BEAT: boundary is inclusive. */
export function isOnBeat(offsetSec: number): boolean {
  return offsetSec <= ONBEAT_WINDOW + 1e-9;
}

/**
 * Next grid beat after `beat0` for a design gap of `gapSec`: nearest 0.5-beat multiple, at least one
 * grid step, and never shorter than 0.9 x the design gap in real time.
 */
export function quantizeGapBeat(beat0: number, gapSec: number): number {
  const t0 = timeAtBeat(beat0);
  const beats = (gapSec * bpmAt(t0)) / 60;
  let nb = beat0 + Math.max(BEAT_GRID, Math.round(beats / BEAT_GRID) * BEAT_GRID);
  while (timeAtBeat(nb) - t0 < GAP_MIN_FRACTION * gapSec - 1e-9) nb += BEAT_GRID;
  return nb;
}

/** Distance lost while the launch ramp eases the speed in (so the spawner can compensate and stay on the grid). */
export const LAUNCH_LOSS = (() => {
  const n = 2000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * LAUNCH_RAMP_TIME;
    sum += speedAt(t) * (1 - launchFactor(t / LAUNCH_RAMP_TIME));
  }
  return (sum * LAUNCH_RAMP_TIME) / n;
})();

/** Speed multiplier of the launch ramp at k = t / LAUNCH_RAMP_TIME in 0..1. */
export function launchFactor(k: number): number {
  const m = 1 - k;
  return 0.2 + 0.8 * (1 - m * m * m);
}
