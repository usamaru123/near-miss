import { TAU } from './constants';
import type { Arc } from './types';

/** Wrap into [0, 2pi). */
export function wrap(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Signed shortest difference from a to b, in (-pi, pi]. */
export function angDiff(a: number, b: number): number {
  let d = wrap(b - a);
  if (d > Math.PI) d -= TAU;
  return d;
}

export function angDist(a: number, b: number): number {
  return Math.abs(angDiff(a, b));
}

/** CCW length of the arc from a to b, in [0, 2pi). */
export function arcLen(a: number, b: number): number {
  return wrap(b - a);
}

export function arcCenter(a: number, b: number): number {
  return wrap(a + arcLen(a, b) / 2);
}

/** Is angle x inside the CCW arc from a to b (inclusive)? Handles the 0/2pi wrap. */
export function arcContains(a: number, b: number, x: number): boolean {
  return wrap(x - a) <= wrap(b - a) + 1e-12;
}

/** Do two CCW arcs [a0,b0], [a1,b1] overlap (inclusive)? */
export function arcsIntersect(a0: number, b0: number, a1: number, b1: number): boolean {
  return arcContains(a0, b0, a1) || arcContains(a1, b1, a0);
}

/** Angular distance between two arcs: 0 if they intersect, else gap between nearest endpoints. */
export function arcDistance(a0: number, b0: number, a1: number, b1: number): number {
  if (arcsIntersect(a0, b0, a1, b1)) return 0;
  return Math.min(angDist(a0, a1), angDist(a0, b1), angDist(b0, a1), angDist(b0, b1));
}

/** Distance from point x to an arc (0 inside). */
export function pointArcDistance(x: number, a: number, b: number): number {
  if (arcContains(a, b, x)) return 0;
  return Math.min(angDist(x, a), angDist(x, b));
}

export function pointSetDistance(x: number, set: readonly Arc[]): number {
  let m = Infinity;
  for (let i = 0; i < set.length; i++) {
    const d = pointArcDistance(x, set[i].a, set[i].b);
    if (d < m) m = d;
    if (m === 0) break;
  }
  return m;
}

/**
 * Max over every point p in `from` of the distance from p to the nearest point of `to`.
 * Sampled every `step` radians plus the arc endpoints.
 */
export function maxReachDistance(from: readonly Arc[], to: readonly Arc[], step: number): number {
  let worst = 0;
  for (let i = 0; i < from.length; i++) {
    const { a, b } = from[i];
    const len = arcLen(a, b);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) {
      const d = pointSetDistance(a + (len * k) / n, to);
      if (d > worst) worst = d;
    }
  }
  return worst;
}

/** Complement of a set of (non-overlapping) solid arcs rotated by `rot`: the safe arcs. */
export function safeFromSolids(solids: readonly Arc[], rot: number): Arc[] {
  const n = solids.length;
  if (n === 0) return [{ a: 0, b: TAU - 1e-9 }];
  const s = solids.map((x) => ({ a: wrap(x.a + rot), b: wrap(x.b + rot) }));
  s.sort((p, q) => p.a - q.a);
  const out: Arc[] = [];
  for (let i = 0; i < n; i++) {
    const cur = s[i];
    const next = s[(i + 1) % n];
    if (arcLen(cur.b, next.a) > 1e-9 || n === 1) out.push({ a: cur.b, b: next.a });
  }
  return out;
}
