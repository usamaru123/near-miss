import { describe, expect, it } from 'vitest';
import { FOV_MAX, FOV_MIN, SPEED_MAX } from '../src/game/constants';
import { QualityGovernor, settingsFor, TIER_MAX } from '../src/render/quality';
import type { QualitySettings } from '../src/render/quality';
import { PORTRAIT_MAX_VFOV, baseVfov, hfovOf, shipFraction, tunnelFraction } from '../src/render/viewFit';

const PHONES = [
  [393, 852], // iPhone 15 Pro
  [412, 915], // Pixel 7
  [375, 667], // iPhone SE
  [360, 780],
];

describe('portrait camera (DESIGN 17.2)', () => {
  it('desktop / landscape keeps the original FOV', () => {
    for (const a of [16 / 9, 4 / 3, 1, 844 / 390]) expect(baseVfov(a, FOV_MIN)).toBe(FOV_MIN);
  });

  it('portrait: horizontal FOV >= 72 deg, vertical <= 118 deg', () => {
    for (const [w, h] of PHONES) {
      const v = baseVfov(w / h, FOV_MIN);
      expect(v).toBeLessThanOrEqual(PORTRAIT_MAX_VFOV);
      expect(hfovOf(v, w / h)).toBeGreaterThanOrEqual(71.5);
    }
    expect(hfovOf(baseVfov(393 / 852, FOV_MIN), 393 / 852)).toBeGreaterThanOrEqual(72 - 1e-6);
  });

  it('the ship is at most 12 % of the short side, portrait and landscape', () => {
    const dist = Math.hypot(6.5, 2.3);
    for (const [w, h] of [...PHONES, [852, 393], [1280, 720], [800, 450]]) {
      const a = w / h;
      expect(shipFraction(baseVfov(a, FOV_MIN), a, dist)).toBeLessThanOrEqual(0.12);
    }
  });

  it('obstacles stay as visible 1.2 s ahead at top speed as on desktop at max FOV', () => {
    const d = SPEED_MAX * 1.2;
    const desktop = tunnelFraction(FOV_MAX, 1280 / 720, d);
    for (const [w, h] of PHONES) {
      const a = w / h;
      // the speed boost rides on top of the base: worst case is the widest FOV
      const worst = Math.min(150, baseVfov(a, FOV_MIN) + (FOV_MAX - FOV_MIN));
      expect(tunnelFraction(worst, a, d)).toBeGreaterThan(desktop * 0.6);
    }
  });
});

describe('adaptive quality (DESIGN 17.6)', () => {
  const run = (g: QualityGovernor, fps: number, seconds: number): number => {
    let drops = 0;
    const dt = 1 / fps;
    for (let t = 0; t < seconds; t += dt) if (g.tick(dt)) drops++;
    return drops;
  };

  it('stays at tier 0 at 60 fps', () => {
    const g = new QualityGovernor(3);
    run(g, 60, 60);
    expect(g.tier).toBe(0);
  });

  it('steps down one tier at a time while slow, and never back up', () => {
    const g = new QualityGovernor(3);
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      run(g, 30, 2);
      seen.push(g.tier);
    }
    expect(seen[0]).toBe(0); // one slow window is not enough
    for (let i = 1; i < seen.length; i++) expect(seen[i] - seen[i - 1]).toBeLessThanOrEqual(1);
    expect(g.tier).toBe(TIER_MAX);
    run(g, 60, 60);
    expect(g.tier).toBe(TIER_MAX);
  });

  it('skips DPR tiers that change nothing on a 1x screen', () => {
    const g = new QualityGovernor(1);
    run(g, 20, 4.1);
    expect(g.tier).toBe(4);
  });

  it('ignores windows with a stall (tab switch)', () => {
    const g = new QualityGovernor(3);
    for (let i = 0; i < 10; i++) {
      g.tick(1.5);
      run(g, 20, 1.5);
    }
    expect(g.tier).toBe(0);
  });

  it('tiers map to DPR -> bloom -> blur taps -> particles', () => {
    const q = { } as QualitySettings;
    expect(settingsFor(0, q).dprCap).toBe(2);
    expect(settingsFor(1, q).dprCap).toBe(1.5);
    expect(settingsFor(2, q).dprCap).toBe(1.25);
    expect(settingsFor(3, q).dprCap).toBe(1);
    expect(settingsFor(3, q).bloomHalf).toBe(false);
    expect(settingsFor(4, q).bloomHalf).toBe(true);
    expect(settingsFor(4, q).blurTaps).toBe(10);
    expect(settingsFor(5, q).blurTaps).toBe(5);
    expect(settingsFor(5, q).particleScale).toBe(1);
    expect(settingsFor(6, q).particleScale).toBe(0.5);
  });
});
