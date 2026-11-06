import {
  GAP_TIME_T1,
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
