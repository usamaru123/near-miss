// Biomes (DESIGN 20.1): per-tier worlds. Pure data and maths (no three.js, no DOM) so the tests can check the cross-section
// shapes, the palettes' obstacle contrast and the FLIP input mapping. The cross-section is VISUAL ONLY: the sim never sees it.
import { DEG, TAU } from '../game/constants';
import { contrast, luminance } from './palette';

export const XS_MAX_EDGES = 9;

/** A cross-section: a circle of relative radius `r` (n = 0), or a convex polygon of n half-planes (nx, ny, d) with the tunnel radius = 1. */
export interface Xs {
  n: number;
  r: number;
  edges: Float32Array;
}

export function createXs(): Xs {
  return { n: 0, r: 1, edges: new Float32Array(XS_MAX_EDGES * 3) };
}

export type XsShape = 'circle' | 'hex' | 'ngon9' | 'square' | 'pulse' | 'void';

const HEX_APOTHEM = 0.97;
const SQUARE_APOTHEM = 0.9;
/** Fixed angular jitter of the nine crystal vertices (deg): irregular but convex. */
const NGON_JITTER = [0, 7, -6, 9, -4, 5, -8, 3, -2];

function regularPolygon(out: Xs, n: number, apothem: number, phase: number): void {
  out.n = n;
  out.r = 1;
  for (let i = 0; i < n; i++) {
    const a = phase + (i * TAU) / n;
    out.edges[i * 3] = Math.cos(a);
    out.edges[i * 3 + 1] = Math.sin(a);
    out.edges[i * 3 + 2] = apothem;
  }
}

const vx = new Float64Array(XS_MAX_EDGES);
const vy = new Float64Array(XS_MAX_EDGES);

/** Fill `out` with the cross-section of `shape` at `time` (seconds, drives the wobble) and `beat` (0..1 pulse, INFERNO). */
export function fillXs(shape: XsShape, time: number, beat: number, out: Xs): Xs {
  switch (shape) {
    case 'hex':
      regularPolygon(out, 6, HEX_APOTHEM, 0);
      break;
    case 'square':
      regularPolygon(out, 4, SQUARE_APOTHEM, 0);
      break;
    case 'ngon9': {
      // nine vertices whose radii drift slowly (the cave breathes)
      const n = 9;
      for (let i = 0; i < n; i++) {
        const a = (i * TAU) / n + NGON_JITTER[i] * DEG;
        const r = Math.max(0.88, Math.min(1.12, 1 + 0.08 * Math.sin(time * 0.5 + 1.9 * i) + 0.05 * Math.sin(time * 0.9 + 3.1 * i)));
        vx[i] = Math.cos(a) * r;
        vy[i] = Math.sin(a) * r;
      }
      out.n = n;
      out.r = 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ex = vx[j] - vx[i];
        const ey = vy[j] - vy[i];
        const len = Math.hypot(ex, ey) || 1;
        const nx = ey / len; // outward normal of a counter-clockwise polygon
        const ny = -ex / len;
        out.edges[i * 3] = nx;
        out.edges[i * 3 + 1] = ny;
        out.edges[i * 3 + 2] = nx * vx[i] + ny * vy[i];
      }
      break;
    }
    case 'pulse':
      out.n = 0;
      out.r = 1 + 0.06 * beat + 0.012 * Math.sin(time * 2.1);
      break;
    case 'void':
    case 'circle':
      out.n = 0;
      out.r = 1;
      break;
  }
  return out;
}

/** Relative radius (tunnel radius = 1) of the cross-section in direction `phi`; mirrors xsScale() in bend.ts. */
export function xsRadius(xs: Xs, phi: number): number {
  if (xs.n === 0) return xs.r;
  const ux = Math.cos(phi);
  const uy = Math.sin(phi);
  let r = 1e6;
  for (let i = 0; i < xs.n; i++) {
    const c = xs.edges[i * 3] * ux + xs.edges[i * 3 + 1] * uy;
    if (c > 1e-4) r = Math.min(r, xs.edges[i * 3 + 2] / c);
  }
  return r;
}

export const SHAPE_OF: readonly XsShape[] = ['circle', 'hex', 'ngon9', 'square', 'pulse', 'void'];

/** Ambient particle flavour of each biome (biomefx.ts). */
export type ParticleKind = 'none' | 'spark' | 'glint' | 'glyph' | 'ember' | 'star';

export interface BiomePalette {
  name: string;
  /** background / fog */
  bg: number;
  /** dark shell colour */
  shell: number;
  /** obstacle edge: tier colour mixed this far toward white, times the gain */
  edgeMix: number;
  edgeGain: number;
  /** obstacle fill opacity multiplier (VOID: almost none, the edges carry it) */
  fill: number;
  /** tunnel line brightness multipliers */
  ring: number;
  long: number;
  lamp: number;
  /** fraction of each line dash that is cut away (DATA STREAM) */
  dash: number;
  /** obstacle fill pattern id for the shader (bend.ts) */
  style: number;
  /** obstacle inner-edge profile id (obstacles.ts): 0 round, 1 angular steps, 2 spikes, 3 blocks, 4 flames, 5 thin */
  profile: number;
  particles: ParticleKind;
  /** ambient particle colour */
  particleColor: number;
}

export const BIOME_PALETTES: readonly BiomePalette[] = [
  { name: 'NEON CITY', bg: 0x02020a, shell: 0x05050f, edgeMix: 0.5, edgeGain: 1.7, fill: 1, ring: 1, long: 1, lamp: 1, dash: 0, style: 0, profile: 0, particles: 'none', particleColor: 0x00f0ff },
  { name: 'HEX GRID', bg: 0x010a05, shell: 0x03100a, edgeMix: 0.5, edgeGain: 1.8, fill: 0.9, ring: 0.9, long: 1.3, lamp: 1.1, dash: 0, style: 1, profile: 1, particles: 'none', particleColor: 0xa6ff00 },
  { name: 'CRYSTAL CAVE', bg: 0x06020e, shell: 0x0a0618, edgeMix: 0.55, edgeGain: 1.9, fill: 1.25, ring: 0.8, long: 1.5, lamp: 0.9, dash: 0, style: 2, profile: 2, particles: 'glint', particleColor: 0xe6b8ff },
  { name: 'DATA STREAM', bg: 0x010808, shell: 0x031010, edgeMix: 0.5, edgeGain: 1.8, fill: 0.9, ring: 1, long: 0.9, lamp: 1.2, dash: 0.45, style: 3, profile: 3, particles: 'glyph', particleColor: 0x66ffcc },
  { name: 'INFERNO', bg: 0x0d0301, shell: 0x1a0502, edgeMix: 0.6, edgeGain: 2.0, fill: 1.15, ring: 1.1, long: 0.8, lamp: 1.3, dash: 0, style: 4, profile: 4, particles: 'ember', particleColor: 0xff8a2a },
  // VOID: the walls all but vanish; the obstacle edges (white-hot, gain 2.6) are all there is
  { name: 'VOID', bg: 0x000000, shell: 0x000000, edgeMix: 0.85, edgeGain: 2.6, fill: 0.18, ring: 0.18, long: 0.1, lamp: 0.1, dash: 0, style: 0, profile: 5, particles: 'star', particleColor: 0xffffff },
];

/** DARK sections: the lights go out. The obstacle edges burn at DARK_BASE of their peak and flash to the peak on every beat. */
export const DARK_BASE = 0.3;
export const DARK_PEAK_GAIN = 8;
export const DARK_BG = 0x000000;
/** Edge colour mixed to white (so the 30 % level is still bright enough: see darkEdgeContrast). */
export const DARK_EDGE_MIX = 0.9;
/** Edge gain of a DARK obstacle: 30 % between beats ... */
export const DARK_EDGE_GAIN_BASE = DARK_PEAK_GAIN * DARK_BASE;

export function mixToWhite(c: number, k: number): number {
  const m = (v: number): number => Math.round(v + (255 - v) * k);
  return (m((c >> 16) & 255) << 16) | (m((c >> 8) & 255) << 8) | m(c & 255);
}

/** Edge colour (hex) of an obstacle in a biome, for a tier colour `primary`. */
export function biomeEdgeHex(biome: number, primary: number): number {
  return mixToWhite(primary, BIOME_PALETTES[biome].edgeMix);
}

/** Contrast ratio of a biome's obstacle edge against its own background (primary: the tier colour; rainbow tiers use red). */
export function biomeContrast(biome: number, primary: number): number {
  const p = BIOME_PALETTES[biome];
  return contrast(luminance(biomeEdgeHex(biome, primary), p.edgeGain), luminance(p.bg, 1));
}

/** Contrast of a DARK section's obstacle edge (between beats, i.e. at its dimmest) against the DARK background. */
export function darkContrast(primary: number): number {
  return contrast(luminance(mixToWhite(primary, DARK_EDGE_MIX), DARK_EDGE_GAIN_BASE), luminance(DARK_BG, 1));
}

/**
 * FLIP (DESIGN 20.2): the camera rolls 180 degrees about the view axis. A roll of `rollRad` turns screen-right into
 * world-angle direction `cos(roll)` (+1 normally, -1 once upside down), so the steering input is multiplied by this sign:
 * left on the keyboard / touch always moves the ship to the left of the screen.
 */
export function flipInputSign(rollRad: number): number {
  return Math.cos(rollRad) >= 0 ? 1 : -1;
}
