/**
 * Adaptive quality (DESIGN 17.6). Pure logic, no DOM / three.js (unit-tested).
 *
 * Every WINDOW seconds of play the average fps is measured; QUIET windows below FPS_LOW in a row step the
 * quality down by one tier. The tier is never raised again (no flicker); the page keeps it between runs.
 */

export const QUALITY_WINDOW = 2;
export const FPS_LOW = 50;
/** consecutive slow windows required per step (rides out one-off hitches such as a shader compile) */
export const SLOW_WINDOWS = 2;

/** DPR caps for tiers 0..3 (1.25 and 1.5 are only reached on screens whose DPR is larger). */
export const DPR_STEPS = [2, 1.5, 1.25, 1] as const;

export const TIER_MAX = 6;

export interface QualitySettings {
  tier: number;
  dprCap: number;
  /** bloom runs at half resolution */
  bloomHalf: boolean;
  /** radial blur taps (shader loop count) */
  blurTaps: number;
  /** multiplier for particle / speed-line / streak counts */
  particleScale: number;
  /** ZONE: fraction of the light ribbons that are drawn (DESIGN 18.4) */
  ribbonScale: number;
  /** ZONE: number of ship after-images (3 at full quality) */
  afterimages: number;
  /** ZONE: film grain pass strength multiplier */
  grainScale: number;
}

/** Fills `out` for `tier` (0 = full quality). */
export function settingsFor(tier: number, out: QualitySettings): QualitySettings {
  const t = Math.max(0, Math.min(TIER_MAX, Math.floor(tier)));
  out.tier = t;
  out.dprCap = DPR_STEPS[Math.min(t, DPR_STEPS.length - 1)];
  out.bloomHalf = t >= 4;
  out.blurTaps = t >= 5 ? 5 : 10;
  out.particleScale = t >= 6 ? 0.5 : 1;
  // ZONE extras are the first things to go: ribbons thin out from tier 3, grain and after-images from tier 4
  out.ribbonScale = t >= 6 ? 0.25 : t >= 5 ? 0.4 : t >= 3 ? 0.7 : 1;
  out.afterimages = t >= 6 ? 0 : t >= 5 ? 1 : t >= 4 ? 2 : 3;
  out.grainScale = t >= 4 ? 0 : t >= 3 ? 0.5 : 1;
  return out;
}

export class QualityGovernor {
  tier = 0;
  /** device pixel ratio: DPR tiers that would not change the effective ratio are skipped */
  constructor(private readonly devDpr = 2) {}
  /** last measured fps (0 until the first window completes) */
  fps = 0;
  private acc = 0;
  private frames = 0;
  private slow = 0;
  private hitch = false;

  /**
   * Feed one frame's wall-clock delta while the game is running. Returns true when the tier just dropped.
   * Windows containing a stall (> 0.25 s: tab switch, GC, shader compile) are discarded.
   */
  tick(wallDt: number): boolean {
    if (wallDt > 0.25) this.hitch = true;
    this.acc += wallDt;
    this.frames++;
    if (this.acc < QUALITY_WINDOW) return false;
    const fps = this.frames / this.acc;
    const hitch = this.hitch;
    this.acc = 0;
    this.frames = 0;
    this.hitch = false;
    if (hitch) return false;
    this.fps = fps;
    if (fps >= FPS_LOW) {
      this.slow = 0;
      return false;
    }
    if (++this.slow < SLOW_WINDOWS) return false;
    this.slow = 0;
    if (this.tier >= TIER_MAX) return false;
    this.tier++;
    while (this.tier <= 3 && this.tier < TIER_MAX && Math.min(this.devDpr, DPR_STEPS[this.tier]) === Math.min(this.devDpr, DPR_STEPS[this.tier - 1])) this.tier++;
    return true;
  }

  /** Restart the measurement (new run / resume from pause). The tier itself is kept. */
  resetWindow(): void {
    this.acc = 0;
    this.frames = 0;
    this.slow = 0;
    this.hitch = false;
  }
}
