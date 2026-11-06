// Colour constants for the normal and ZONE palettes (DESIGN 18.3) plus the luminance maths the tests use to prove
// that obstacles stay at least as readable inside a ZONE as outside. No three.js here: plain 0xRRGGBB numbers.
import { TIERS } from '../game/constants';

export const NORMAL_BG = 0x02020a;
/** Pure black: the ZONE background. */
export const ZONE_BG = 0x000000;
/** Brightness the renderer multiplies obstacle edges / fills with (before the output clamp). */
export const NORMAL_EDGE_GAIN = 1.7;
export const ZONE_EDGE_GAIN = 2.4;
/** ZONE obstacles: white-hot edges over a gold fill. */
export const ZONE_OBSTACLE_EDGE = 0xfff4d0;
export const ZONE_OBSTACLE_FILL = 0xffc23a;
/** OVERDRIVE palette (red / white), the other normal-mode extreme. */
export const OVERDRIVE_PRIMARY = 0xff1030;
/** Peak brightness multiplier of the tunnel lines: normal (tunnel.ts) vs ZONE (rainbow, deliberately calmer). */
export const NORMAL_LINE_PEAK = 1.3;
export const ZONE_LINE_PEAK = 0.8;
/** Seconds the palette takes to switch to / from the ZONE look: a snap normally, a soft 0.5 s fade in reduced-flash mode. */
export const ZONE_FADE_NORMAL = 0.12;
export const ZONE_FADE_REDUCED = 0.5;
/** Palette blend step for a frame of `dt` seconds. */
export function zoneFadeStep(dt: number, reducedFlash: boolean): number {
  return dt / (reducedFlash ? ZONE_FADE_REDUCED : ZONE_FADE_NORMAL);
}
/** Rank colours (HUD, edge glow, shards, rank-up burst). SSS is a rainbow in the HUD; this is its base. */
export const RANK_COLORS: readonly number[] = [0x9aa0a6, 0x3aa0ff, 0x3dff7a, 0xffe03a, 0xff9a1a, 0xff2a2a, 0xff40ff];

/** Obstacle edges are the tier colour mixed half-way to white (renderer.ts: `edge`). */
export function normalEdgeHex(primary: number): number {
  const mix = (c: number): number => Math.round(c + (255 - c) * 0.5);
  return (mix((primary >> 16) & 255) << 16) | (mix((primary >> 8) & 255) << 8) | mix(primary & 255);
}

/** Every normal-mode obstacle edge colour: the six tiers plus OVERDRIVE. */
export function normalEdgeColors(): number[] {
  return [...TIERS.map((t) => normalEdgeHex(t.rainbow ? 0xff4040 : t.primary)), normalEdgeHex(OVERDRIVE_PRIMARY)];
}

function lin(c8: number, gain: number): number {
  const c = Math.min(1, (c8 / 255) * gain); // the display clamps whatever the gain pushes past 1
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a colour after `gain`, clamped to the displayable range. */
export function luminance(hex: number, gain = 1): number {
  return 0.2126 * lin((hex >> 16) & 255, gain) + 0.7152 * lin((hex >> 8) & 255, gain) + 0.0722 * lin(hex & 255, gain);
}

/** WCAG contrast ratio between two luminances (1..21). */
export function contrast(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast of an obstacle edge (colour x gain) against a background. */
export function edgeContrast(edgeHex: number, gain: number, bgHex: number): number {
  return contrast(luminance(edgeHex, gain), luminance(bgHex, 1));
}

/** Smallest / largest edge-vs-background contrast over the normal palettes. */
export function normalContrastRange(): { min: number; max: number } {
  let min = Infinity;
  let max = 0;
  for (const c of normalEdgeColors()) {
    const r = edgeContrast(c, NORMAL_EDGE_GAIN, NORMAL_BG);
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  return { min, max };
}

export function zoneContrast(): number {
  return edgeContrast(ZONE_OBSTACLE_EDGE, ZONE_EDGE_GAIN, ZONE_BG);
}

function hslChannel(n: number, h: number, s: number, l: number): number {
  const k = (n + h * 12) % 12;
  return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
}

/** HSL (h 0..1, s, l 0..1) to 0..1 RGB written into `out`: allocation-free (no closures), called per ribbon segment. */
export function hsl(h: number, s: number, l: number, out: number[]): number[] {
  out[0] = hslChannel(0, h, s, l);
  out[1] = hslChannel(8, h, s, l);
  out[2] = hslChannel(4, h, s, l);
  return out;
}
