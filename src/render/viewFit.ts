/**
 * Camera fitting for narrow (portrait) screens. Pure math: no three.js, no DOM (unit-tested).
 *
 * DESIGN 17.2: on portrait screens the vertical FOV is widened until the horizontal FOV reaches 72 deg
 * (capped at a vertical 118 deg); the speed-driven FOV changes ride on top of that base.
 */

export const PORTRAIT_MIN_HFOV = 72;
export const PORTRAIT_MAX_VFOV = 118;
/** Sanity ceiling for base + speed boost (three.js is fine up to 179). */
export const FOV_HARD_MAX = 150;
/** The ship may take at most this fraction of the short screen side. */
export const SHIP_MAX_FRACTION = 0.12;
/** World width of the ship body (cone radius 0.34 x 1.25 scale, both sides). */
export const SHIP_WORLD_WIDTH = 0.85;

const D2R = Math.PI / 180;

/** Vertical FOV (deg) that gives `hfov` (deg) at `aspect` (w / h). */
export function vfovForHfov(hfov: number, aspect: number): number {
  return 2 * Math.atan(Math.tan(hfov * D2R * 0.5) / aspect) / D2R;
}

/** Horizontal FOV (deg) for a vertical FOV at `aspect`. */
export function hfovOf(vfov: number, aspect: number): number {
  return 2 * Math.atan(Math.tan(vfov * D2R * 0.5) * aspect) / D2R;
}

/** Base vertical FOV: `minVfov` on landscape, widened on portrait (so hfov >= 72 where the 118 deg cap allows). */
export function baseVfov(aspect: number, minVfov: number): number {
  if (aspect >= 1) return minVfov;
  return Math.max(minVfov, Math.min(PORTRAIT_MAX_VFOV, vfovForHfov(PORTRAIT_MIN_HFOV, aspect)));
}

/** Apparent ship width as a fraction of the short screen side. `dist` = camera-to-ship distance. */
export function shipFraction(vfov: number, aspect: number, dist: number): number {
  const shortFov = aspect < 1 ? hfovOf(vfov, aspect) : vfov;
  return SHIP_WORLD_WIDTH / dist / (2 * Math.tan(shortFov * D2R * 0.5));
}

/** Camera Z (distance behind the ship plane) that keeps the ship under SHIP_MAX_FRACTION; never closer than `camZ`. */
export function camZFor(vfov: number, aspect: number, camZ: number, shipOffset: number): number {
  let z = camZ;
  for (let i = 0; i < 40; i++) {
    const dist = Math.hypot(z, shipOffset);
    if (shipFraction(vfov, aspect, dist) <= SHIP_MAX_FRACTION * 0.9) return z;
    z += 0.25;
  }
  return z;
}

/** Fraction of the short side that the 12 m tunnel opening spans at distance `d` (obstacle visibility proxy). */
export function tunnelFraction(vfov: number, aspect: number, d: number, tunnelDiameter = 12): number {
  const shortFov = aspect < 1 ? hfovOf(vfov, aspect) : vfov;
  return tunnelDiameter / d / (2 * Math.tan(shortFov * D2R * 0.5));
}
