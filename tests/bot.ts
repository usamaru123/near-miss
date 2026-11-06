import { angDiff, arcContains, arcLen, pointArcDistance, wrap } from '../src/game/angles';
import { ANG_DECEL, DEG, MAX_ANG_VEL } from '../src/game/constants';
import type { GameState, Input } from '../src/game/types';

const MARGIN = 11 * DEG;

/** Greedy bot: head for the nearest point (with margin) of the next obstacle safe zone at hit time. */
export function botInput(s: GameState, out: Input): Input {
  out.focus = false;
  out.overdrive = false;
  const o = s.obstacles[0];
  if (!o) {
    out.move = 0;
    return out;
  }
  let best = o.safe[0];
  let bd = Infinity;
  for (const a of o.safe) {
    const d = pointArcDistance(s.theta, a.a, a.b);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  const len = arcLen(best.a, best.b);
  let target: number;
  if (len <= 2 * MARGIN) {
    target = wrap(best.a + len / 2);
  } else {
    const a = wrap(best.a + MARGIN);
    const b = wrap(best.b - MARGIN);
    if (arcContains(a, b, s.theta)) target = s.theta;
    else target = Math.abs(angDiff(s.theta, a)) < Math.abs(angDiff(s.theta, b)) ? a : b;
  }
  const err = angDiff(s.theta, target);
  const desired = Math.sign(err) * Math.min(MAX_ANG_VEL, Math.sqrt(2 * ANG_DECEL * 0.7 * Math.abs(err)));
  out.move = Math.max(-1, Math.min(1, desired / MAX_ANG_VEL));
  return out;
}
