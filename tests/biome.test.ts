import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BIOMES, DEG, SHIP_RADIUS, SIM_DT, TIERS } from '../src/game/constants';
import { createState, step } from '../src/game/sim';
import type { Input } from '../src/game/types';
import {
  BIOME_PALETTES,
  DARK_BASE,
  DARK_EDGE_GAIN_BASE,
  DARK_PEAK_GAIN,
  SHAPE_OF,
  biomeContrast,
  biomeEdgeHex,
  createXs,
  darkContrast,
  fillXs,
  flipInputSign,
  mixToWhite,
  xsRadius,
} from '../src/render/biome';
import { CameraRig } from '../src/render/cameraRig';
import {
  NORMAL_EDGE_GAIN,
  OVERDRIVE_PRIMARY,
  ZONE_EDGE_GAIN,
  edgeContrast,
  normalContrastRange,
  zoneContrast,
  ZONE_BG,
  ZONE_OBSTACLE_EDGE,
} from '../src/render/palette';
import { QUALITY_WINDOW, settingsFor } from '../src/render/quality';
import type { QualitySettings } from '../src/render/quality';
import { botInput } from './bot';

const PRIMARIES = [...TIERS.map((t) => (t.rainbow ? 0xff4040 : t.primary)), OVERDRIVE_PRIMARY];

/** every hue of the BEYOND rainbow (HSL 1, 0.55) as 0xRRGGBB */
function rainbowHues(): number[] {
  const out: number[] = [];
  const c = new THREE.Color();
  for (let h = 0; h < 360; h += 15) {
    c.setHSL(h / 360, 1, 0.55);
    out.push(c.getHex());
  }
  return out;
}

describe('biomes (DESIGN 20.1)', () => {
  it('six biomes, one per tier, in the specified order and with the specified cross-sections', () => {
    expect(BIOMES.map((b) => b.name)).toEqual(['NEON CITY', 'HEX GRID', 'CRYSTAL CAVE', 'DATA STREAM', 'INFERNO', 'VOID']);
    expect(BIOMES.length).toBe(TIERS.length);
    expect(SHAPE_OF).toEqual(['circle', 'hex', 'ngon9', 'square', 'pulse', 'void']);
    expect(BIOME_PALETTES.map((p) => p.name)).toEqual(BIOMES.map((b) => b.name));
  });

  it('cross-sections: round / hexagon / irregular 9-gon / square / pulsing circle / void', () => {
    const xs = createXs();
    fillXs('circle', 0, 0, xs);
    for (let a = 0; a < 360; a += 10) expect(xsRadius(xs, a * DEG)).toBeCloseTo(1, 9);
    // hexagon: 6 flats (apothem 0.97), corners at 1/cos(30 deg) of it
    fillXs('hex', 0, 0, xs);
    expect(xs.n).toBe(6);
    expect(xsRadius(xs, 0)).toBeCloseTo(0.97, 6);
    expect(xsRadius(xs, 30 * DEG)).toBeCloseTo(0.97 / Math.cos(30 * DEG), 6);
    expect(xsRadius(xs, 60 * DEG)).toBeCloseTo(0.97, 6);
    // square: flats on the axes, corners on the diagonals
    fillXs('square', 0, 0, xs);
    expect(xs.n).toBe(4);
    expect(xsRadius(xs, 0)).toBeCloseTo(0.9, 6);
    expect(xsRadius(xs, 45 * DEG)).toBeCloseTo(0.9 * Math.SQRT2, 6);
    // crystal cave: nine edges, irregular, convex, wobbling in time, always within a sane band
    fillXs('ngon9', 0, 0, xs);
    expect(xs.n).toBe(9);
    const at0: number[] = [];
    for (let a = 0; a < 360; a += 5) at0.push(xsRadius(xs, a * DEG));
    expect(Math.max(...at0) - Math.min(...at0)).toBeGreaterThan(0.05); // irregular
    for (const r of at0) {
      expect(r).toBeGreaterThan(0.7);
      expect(r).toBeLessThan(1.25);
    }
    fillXs('ngon9', 3.3, 0, xs);
    const at1: number[] = [];
    for (let a = 0; a < 360; a += 5) at1.push(xsRadius(xs, a * DEG));
    expect(at1.some((r, i) => Math.abs(r - at0[i]) > 0.01)).toBe(true); // it moves
    // INFERNO: a circle whose radius pulses with the beat
    fillXs('pulse', 1, 0, xs);
    const quiet = xsRadius(xs, 1);
    fillXs('pulse', 1, 1, xs);
    expect(xsRadius(xs, 1)).toBeGreaterThan(quiet + 0.03);
    // every shape keeps the ship's wall well clear of the camera (radius 2.9 / 6)
    for (const shape of SHAPE_OF) {
      for (const beat of [0, 1]) {
        fillXs(shape, 7.7, beat, xs);
        for (let a = 0; a < 360; a += 3) expect(xsRadius(xs, a * DEG) * SHIP_RADIUS).toBeGreaterThan(4.2);
      }
    }
  });

  it('visibility: obstacle edge contrast in every biome palette (VOID and DARK included) is at least the existing minimum', () => {
    const base = normalContrastRange();
    expect(base.min).toBeGreaterThan(17); // the v5 floor
    const rows: string[] = [];
    let voidWorst = Infinity;
    let otherBest = 0;
    for (let b = 0; b < BIOME_PALETTES.length; b++) {
      let worst = Infinity;
      for (const p of [...PRIMARIES, ...(b === 5 ? rainbowHues() : [])]) worst = Math.min(worst, biomeContrast(b, p));
      rows.push(BIOME_PALETTES[b].name + ' ' + worst.toFixed(2));
      expect(worst, BIOME_PALETTES[b].name).toBeGreaterThanOrEqual(base.min);
      if (b === 5) voidWorst = worst;
      else otherBest = Math.max(otherBest, worst);
    }
    // VOID is the strictest: its contrast is >= every other biome's (the walls are gone, the edges carry everything)
    for (let b = 0; b < 5; b++) {
      let worst = Infinity;
      for (const p of PRIMARIES) worst = Math.min(worst, biomeContrast(b, p));
      expect(voidWorst).toBeGreaterThanOrEqual(worst - 1e-9);
    }
    expect(voidWorst).toBeGreaterThanOrEqual(Math.min(...PRIMARIES.map((p) => biomeContrast(1, p))));
    void otherBest;
    // DARK sections: edges at their dimmest (30 % of the flash peak) over the black DARK background
    let darkWorst = Infinity;
    for (const p of [...PRIMARIES, ...rainbowHues()]) darkWorst = Math.min(darkWorst, darkContrast(p));
    rows.push('DARK(30%) ' + darkWorst.toFixed(2));
    expect(darkWorst).toBeGreaterThanOrEqual(base.min);
    expect(DARK_EDGE_GAIN_BASE).toBeCloseTo(DARK_PEAK_GAIN * DARK_BASE, 9);
    // the ZONE palette overrides the biome's and was already proven at least as readable
    expect(zoneContrast()).toBeGreaterThanOrEqual(base.max);
    expect(edgeContrast(ZONE_OBSTACLE_EDGE, ZONE_EDGE_GAIN, ZONE_BG)).toBeGreaterThanOrEqual(base.min);
    expect(NORMAL_EDGE_GAIN).toBeLessThan(BIOME_PALETTES[5].edgeGain); // VOID edges glow harder
    // eslint-disable-next-line no-console
    console.log('obstacle contrast (worst case per palette; floor ' + base.min.toFixed(2) + '): ' + rows.join(', '));
  });

  it('the biome edge colour is the tier colour mixed toward white', () => {
    expect(biomeEdgeHex(0, 0x00f0ff)).toBe(mixToWhite(0x00f0ff, 0.5));
    expect(mixToWhite(0x000000, 1)).toBe(0xffffff);
    expect(mixToWhite(0x102030, 0)).toBe(0x102030);
  });
});

describe('FLIP: input stays screen-relative (DESIGN 20.2)', () => {
  /** Ship position at angle theta (the sim's SHIP_RADIUS) in normalised device coordinates. */
  function screenX(rig: CameraRig, theta: number): number {
    rig.camera.updateMatrixWorld(true);
    return new THREE.Vector3(Math.cos(theta) * SHIP_RADIUS, Math.sin(theta) * SHIP_RADIUS, 0).project(rig.camera).x;
  }

  function rigAt(roll01: number): CameraRig {
    const rig = new CameraRig(16 / 9);
    rig.snapFlip(false);
    const theta = 1.234;
    // settle the (lagged) camera on the ship angle, then set the flip progress
    for (let i = 0; i < 200; i++) rig.update(theta, 0, 50, false, 1 / 60, 0);
    if (roll01 >= 1) rig.snapFlip(true);
    else if (roll01 > 0) {
      rig.setFlip(true);
      // animate until the wanted fraction of the 0.6 s roll has passed
      for (let i = 0; i < 200 && rig.flipRoll < roll01 * Math.PI; i++) rig.update(theta, 0, 50, false, 1 / 240, 0);
    }
    rig.update(theta, 0, 50, false, 1 / 1000, 0);
    return rig;
  }

  it('flipInputSign: +1 upright, -1 upside down, switching at the quarter turn', () => {
    expect(flipInputSign(0)).toBe(1);
    expect(flipInputSign(0.49 * Math.PI)).toBe(1);
    expect(flipInputSign(0.51 * Math.PI)).toBe(-1);
    expect(flipInputSign(Math.PI)).toBe(-1);
  });

  it('left key / touch moves the ship to the left of the screen at every stage of the roll (and right moves it right)', () => {
    const theta = 1.234;
    for (const stage of [0, 0.15, 0.3, 0.7, 0.85, 1]) {
      const rig = rigAt(stage);
      const sign = rig.inputSign;
      if (Math.abs(Math.cos(rig.flipRoll)) < 0.2) continue; // at the quarter turn the screen direction is nearly vertical
      for (const move of [-1, 1]) {
        // what main.ts does: world input = screen input x sign; positive = increasing angle
        const dTheta = move * sign * 0.05;
        const dx = screenX(rig, theta + dTheta) - screenX(rig, theta);
        expect(Math.sign(dx), 'stage ' + stage + ' move ' + move).toBe(move);
      }
    }
  });

  it('without the sign correction the flipped camera would steer backwards (the test is not vacuous)', () => {
    const rig = rigAt(1);
    expect(rig.flipRoll).toBeCloseTo(Math.PI, 9);
    const theta = 1.234;
    const dx = screenX(rig, theta - 0.05) - screenX(rig, theta); // "left" with no correction
    expect(dx).toBeGreaterThan(0); // moved screen-RIGHT
    expect(rig.inputSign).toBe(-1);
  });

  it('the roll takes 0.6 s each way', () => {
    const rig = new CameraRig(16 / 9);
    rig.setFlip(true);
    for (let i = 0; i < 59; i++) rig.update(0, 0, 50, false, 0.01, 0);
    expect(rig.flipRoll).toBeLessThan(Math.PI);
    rig.update(0, 0, 50, false, 0.02, 0);
    expect(rig.flipRoll).toBeCloseTo(Math.PI, 9);
    rig.setFlip(false);
    for (let i = 0; i < 61; i++) rig.update(0, 0, 50, false, 0.01, 0);
    expect(rig.flipRoll).toBeCloseTo(0, 9);
  });
});

describe('the biome is visual only (DESIGN 20.1)', () => {
  it('the sim gives identical results whatever cross-section is rendered (same input, same seed)', () => {
    const run = (touchShapes: boolean): string => {
      const s = createState(2024, true);
      const input: Input = { move: 0, focus: false, overdrive: false };
      const xs = createXs();
      let acc = '';
      for (let i = 0; i < 120 * 70; i++) {
        if (touchShapes) {
          // a renderer fiddling with every cross-section and sampling it all the time cannot reach the sim
          fillXs(SHAPE_OF[Math.floor(i / 300) % SHAPE_OF.length], i / 120, (i % 60) / 60, xs);
          for (let a = 0; a < 6; a++) xsRadius(xs, s.theta + a);
        }
        botInput(s, input);
        for (const e of step(s, input, SIM_DT)) acc += e.type + ';';
        if (i % 240 === 0) acc += s.t.toFixed(6) + ',' + s.theta.toFixed(9) + ',' + s.score.toFixed(3) + ',' + s.obstacles.length + '|';
      }
      return acc + s.alive + s.t.toFixed(9) + s.score;
    };
    const a = run(false);
    const b = run(true);
    expect(b).toBe(a);
    expect(a.length).toBeGreaterThan(500);
  });
});

describe('adaptive quality covers the course effects (DESIGN 17.6)', () => {
  it('biome particles, shader patterns and the gate ghost are the first things to go', () => {
    const q: QualitySettings = settingsFor(0, { tier: 0, dprCap: 2, bloomHalf: false, blurTaps: 10, particleScale: 1, ribbonScale: 1, afterimages: 3, grainScale: 1, biomeParticles: 1, patterns: true, gateGhost: true });
    expect(q.biomeParticles).toBe(1);
    expect(q.patterns).toBe(true);
    let prev = 1;
    for (let t = 0; t <= 6; t++) {
      settingsFor(t, q);
      expect(q.biomeParticles).toBeLessThanOrEqual(prev);
      prev = q.biomeParticles;
    }
    settingsFor(6, q);
    expect(q.biomeParticles).toBeLessThan(0.3);
    expect(q.patterns).toBe(false);
    expect(q.gateGhost).toBe(false);
    expect(QUALITY_WINDOW).toBeGreaterThan(0);
  });
});
