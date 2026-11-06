import { describe, expect, it } from 'vitest';
import { TIERS } from '../src/game/constants';
import { UNIT_FROM, formatFull, formatScore, scoreSize, scoreTone } from '../src/game/format';
import { GHOST_Z_MAX, GHOST_Z_MIN } from '../src/game/constants';
import { PaceTracker, emptyTrace, ghostZ, parseTrace, recordSample, resultVsBest, sampleAt, serializeTrace } from '../src/game/pace';
import {
  NORMAL_BG,
  NORMAL_EDGE_GAIN,
  NORMAL_LINE_PEAK,
  ZONE_BG,
  ZONE_EDGE_GAIN,
  ZONE_FADE_NORMAL,
  ZONE_FADE_REDUCED,
  ZONE_LINE_PEAK,
  ZONE_OBSTACLE_EDGE,
  ZONE_OBSTACLE_FILL,
  contrast,
  edgeContrast,
  luminance,
  normalContrastRange,
  normalEdgeColors,
  zoneContrast,
  zoneFadeStep,
} from '../src/render/palette';
import { QualityGovernor, settingsFor, TIER_MAX } from '../src/render/quality';
import type { QualitySettings } from '../src/render/quality';

describe('score formatter: K / M / B / T / Qa / Qi (DESIGN 18.5)', () => {
  it('below 1,000,000 every digit, with separators', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(7)).toBe('7');
    expect(formatScore(999)).toBe('999');
    expect(formatScore(1000)).toBe('1,000');
    expect(formatScore(123456)).toBe('123,456');
    expect(formatScore(999999)).toBe('999,999');
    expect(formatScore(999999.9)).toBe('999,999');
  });

  it('boundaries: units start at 1,000,000 and roll over at each power of 1000', () => {
    expect(UNIT_FROM).toBe(1e6);
    expect(formatScore(1e6)).toBe('1.00M');
    expect(formatScore(1234567)).toBe('1.23M');
    expect(formatScore(12345678)).toBe('12.3M');
    expect(formatScore(123456789)).toBe('123M');
    expect(formatScore(999e6)).toBe('999M');
    expect(formatScore(999999999)).toBe('1.00B'); // 999.999999M rounds up: never "1000M"
    expect(formatScore(1e9)).toBe('1.00B');
    expect(formatScore(1.5e12)).toBe('1.50T');
    expect(formatScore(999.6e12)).toBe('1.00Qa');
    expect(formatScore(1e15)).toBe('1.00Qa');
    expect(formatScore(2.5e17)).toBe('250Qa');
    expect(formatScore(1e18)).toBe('1.00Qi');
    expect(formatScore(7.77e19)).toBe('77.7Qi');
    expect(formatScore(1e21)).toBe('1,000Qi');
    expect(formatScore(4.2e22)).toBe('42,000Qi');
  });

  it('never produces 1000 + unit, NaN or negative output', () => {
    for (let e = 6; e < 25; e += 0.37) {
      const out = formatScore(Math.pow(10, e));
      expect(out).toMatch(/^[\d,.]+(M|B|T|Qa|Qi)$/);
      expect(out).not.toMatch(/^1000(\.\d+)?[A-Za-z]/);
    }
    expect(formatScore(NaN)).toBe('0');
    expect(formatScore(-5)).toBe('0');
    expect(formatScore(Infinity)).toBe('0');
  });

  it('full digits: exact below 2^53, zero-padded shortest decimal above it', () => {
    expect(formatFull(0)).toBe('0');
    expect(formatFull(1234567)).toBe('1,234,567');
    expect(formatFull(9007199254740991)).toBe('9,007,199,254,740,991');
    expect(formatFull(1e18)).toBe('1,000,000,000,000,000,000');
    expect(formatFull(4.2e22)).toBe('42,000,000,000,000,000,000,000');
    expect(formatFull(1.2345e25)).toBe('12,345,000,000,000,000,000,000,000');
  });

  it('pop-up colour by size: white < 1k, cyan < 10k, yellow < 100k, magenta < 1M, rainbow from 1M', () => {
    expect(scoreTone(999)).toBe('white');
    expect(scoreTone(1000)).toBe('cyan');
    expect(scoreTone(9999)).toBe('cyan');
    expect(scoreTone(10000)).toBe('yellow');
    expect(scoreTone(99999)).toBe('yellow');
    expect(scoreTone(100000)).toBe('magenta');
    expect(scoreTone(999999)).toBe('magenta');
    expect(scoreTone(1e6)).toBe('rainbow');
    expect(scoreTone(1e30)).toBe('rainbow');
  });

  it('pop-up size grows with log10(points), within sane bounds', () => {
    const sizes = [100, 1000, 1e4, 1e5, 1e6, 1e9, 1e15].map(scoreSize);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    expect(scoreSize(1)).toBe(0.75);
    expect(scoreSize(1e30)).toBe(1.7);
    expect(scoreSize(2500)).toBeCloseTo(1, 2);
    expect(scoreSize(1e4)).toBeGreaterThan(scoreSize(1e3));
  });
});

describe('ZONE palette: obstacles are at least as readable as in the normal palette (DESIGN 18.4)', () => {
  it('luminance / contrast maths', () => {
    expect(luminance(0x000000)).toBe(0);
    expect(luminance(0xffffff)).toBeCloseTo(1, 9);
    expect(contrast(1, 0)).toBeCloseTo(21, 9);
    expect(contrast(0.2, 0.2)).toBe(1);
  });

  it('obstacle edge / background contrast in the ZONE >= the best normal palette', () => {
    const normal = normalContrastRange();
    const zone = zoneContrast();
    // eslint-disable-next-line no-console
    console.log('contrast normal min / max', normal.min.toFixed(2), normal.max.toFixed(2), 'ZONE', zone.toFixed(2));
    expect(zone).toBeGreaterThanOrEqual(normal.max);
    expect(zone).toBeGreaterThanOrEqual(normal.min);
    expect(zone).toBeGreaterThan(15);
    for (const c of normalEdgeColors()) expect(zone).toBeGreaterThanOrEqual(edgeContrast(c, NORMAL_EDGE_GAIN, NORMAL_BG) - 1e-9);
  });

  it('the ZONE background is darker than the normal one and the obstacle brighter', () => {
    expect(luminance(ZONE_BG)).toBeLessThan(luminance(NORMAL_BG));
    const zoneEdge = luminance(ZONE_OBSTACLE_EDGE, ZONE_EDGE_GAIN);
    for (const c of normalEdgeColors()) expect(zoneEdge).toBeGreaterThanOrEqual(luminance(c, NORMAL_EDGE_GAIN) - 1e-9);
    // the gold fill sits well above the black background too
    expect(contrast(luminance(ZONE_OBSTACLE_FILL, 1), luminance(ZONE_BG))).toBeGreaterThan(8);
  });

  it('the rainbow tunnel lines are calmer than the normal ones, and darker than the obstacle edge', () => {
    expect(ZONE_LINE_PEAK).toBeLessThan(NORMAL_LINE_PEAK);
    const worstLine = luminance(0xffffff, ZONE_LINE_PEAK);
    expect(worstLine).toBeLessThan(luminance(ZONE_OBSTACLE_EDGE, ZONE_EDGE_GAIN));
    // obstacle edge vs the brightest line colour still reads: contrast >= 1.5
    expect(contrast(luminance(ZONE_OBSTACLE_EDGE, ZONE_EDGE_GAIN), worstLine)).toBeGreaterThan(1.5);
    expect(TIERS.length).toBe(6);
  });

  it('reduced flash: the palette change is a 0.5 s fade instead of a snap', () => {
    expect(ZONE_FADE_REDUCED).toBe(0.5);
    expect(ZONE_FADE_NORMAL).toBeLessThan(ZONE_FADE_REDUCED);
    expect(zoneFadeStep(0.1, true)).toBeCloseTo(0.2, 9);
    expect(zoneFadeStep(0.1, false)).toBeGreaterThan(0.8);
    let a = 0;
    let t = 0;
    while (a < 1) {
      a += zoneFadeStep(1 / 60, true);
      t += 1 / 60;
    }
    expect(t).toBeGreaterThanOrEqual(0.5 - 1e-6);
    expect(t).toBeLessThan(0.52);
  });
});

describe('adaptive quality covers the ZONE effects (DESIGN 17.6 / 18.4)', () => {
  const q: QualitySettings = settingsFor(0, { tier: 0, dprCap: 2, bloomHalf: false, blurTaps: 10, particleScale: 1, ribbonScale: 1, afterimages: 3, grainScale: 1, biomeParticles: 1, patterns: true, gateGhost: true });
  it('full quality: all ribbons, 3 after-images, full grain', () => {
    settingsFor(0, q);
    expect(q.ribbonScale).toBe(1);
    expect(q.afterimages).toBe(3);
    expect(q.grainScale).toBe(1);
  });
  it('every tier step takes something away, never adds', () => {
    let prev = { r: 1, a: 3, g: 1 };
    for (let t = 0; t <= TIER_MAX; t++) {
      settingsFor(t, q);
      expect(q.ribbonScale).toBeLessThanOrEqual(prev.r);
      expect(q.afterimages).toBeLessThanOrEqual(prev.a);
      expect(q.grainScale).toBeLessThanOrEqual(prev.g);
      prev = { r: q.ribbonScale, a: q.afterimages, g: q.grainScale };
    }
    settingsFor(TIER_MAX, q);
    expect(q.ribbonScale).toBeLessThan(0.5);
    expect(q.afterimages).toBe(0);
    expect(q.grainScale).toBe(0);
  });
  it('the governor still steps down tier by tier', () => {
    const g = new QualityGovernor(2);
    for (let i = 0; i < 400; i++) g.tick(1 / 30);
    expect(g.tier).toBeGreaterThan(0);
  });
});

describe('pace with inflated scores (DESIGN 18.5: doubles end to end)', () => {
  it('ghost depth: 300 points per unit early, relative to the best later', () => {
    expect(ghostZ(-300)).toBeCloseTo(-1, 9); // unchanged without a reference
    expect(ghostZ(-300, 1000)).toBeCloseTo(-1, 9);
    expect(ghostZ(-5e12, 1e14)).toBeCloseTo(-5e12 / (1e14 * 0.05), 9);
    expect(ghostZ(-1e9, 1e9)).toBe(GHOST_Z_MIN);
    expect(ghostZ(1e15, 1e9)).toBe(GHOST_Z_MAX);
    // 1 % behind a 10^15 best is a fraction of a unit, not a wall
    expect(Math.abs(ghostZ(-1e13, 1e15))).toBeLessThan(3);
  });

  it('traces of 10^20-class scores survive the storage round trip and the comparison', () => {
    const tr = emptyTrace();
    for (let i = 0; i <= 100; i++) recordSample(tr, i / 10, 1, i * 3.3e18);
    tr.final = 3.3e20;
    const back = parseTrace(serializeTrace(tr));
    expect(back).not.toBeNull();
    if (!back) return;
    expect(back.final).toBe(3.3e20);
    expect(sampleAt(back, 5).score).toBeCloseTo(sampleAt(tr, 5).score, -10);
    expect(Math.abs(sampleAt(back, 5).score / 1.65e20 - 1)).toBeLessThan(1e-9);
    expect(serializeTrace(tr).length).toBeLessThan(5000);
  });

  it('best scores saved under the old scoring are simply smaller: comparisons still work', () => {
    const old = emptyTrace();
    for (let i = 0; i <= 50; i++) recordSample(old, i / 10, 1, i * 20);
    old.final = 1000;
    const p = new PaceTracker(old, 1000);
    const u = p.update(2, 4.4e9, 1);
    expect(u.hasBest).toBe(true);
    expect(u.diff).toBeGreaterThan(4e9 - 1000);
    expect(u.newRecord).toBe(true);
    expect(resultVsBest(2.5e12, 1000).beat).toBe(true);
    expect(resultVsBest(2.5e12, 1000).delta).toBe(Math.floor(2.5e12 - 1000));
  });

  it('during a ZONE the live (score + BANK) is compared, the trace records the banked score; a death trims the trace', () => {
    const best = emptyTrace();
    for (let i = 0; i <= 100; i++) recordSample(best, i / 10, 1, i * 100);
    best.final = 10000;
    const p = new PaceTracker(best, 10000);
    const u = p.update(5, 500, 1, 500 + 9000);
    expect(u.diff).toBeCloseTo(500 + 9000 - 5000, 6);
    expect(p.recording.sc.at(-1)).toBe(500);
    // the run dies; the final is lower than a (hypothetical) inflated last sample
    const rec = emptyTrace();
    for (let i = 0; i <= 20; i++) recordSample(rec, i / 10, 1, i * 1000);
    const q = new PaceTracker(null, 0);
    for (let i = 0; i <= 20; i++) q.update(i / 10, i * 1000, 1);
    const trace = q.finish(12345);
    expect(Math.max(...trace.sc)).toBeLessThanOrEqual(12345);
    expect(trace.final).toBe(12345);
  });
});
