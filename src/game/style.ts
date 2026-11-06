// Style rank + ZONE + score inflation (DESIGN 18). Pure logic: sim.ts calls into here.
import {
  INSANE_CHAIN_MAX_EXP,
  RANK_DECAY,
  RANK_DOWN_GRACE,
  RANK_MULT,
  RANK_S,
  RANK_SSS,
  RANK_THRESH,
  SPEED_BASE,
  SPEED_SCORE_EXP,
  STYLE_ADD,
  STYLE_PENALTY,
  ZONE_BANK_COMPOUND,
  ZONE_BASE_FACTOR,
  ZONE_BREAK_PAY,
  ZONE_CHARGE_DOWN,
  ZONE_CHARGE_SCALE,
  ZONE_CHARGE_UP,
  ZONE_ENTER_TIME,
  ZONE_LV_SECONDS,
} from './constants';
import type { GameEvent, GameState, StyleState, ZoneState } from './types';

export function createStyle(): StyleState {
  return { value: 0, rank: 0, maxRank: 0, downT: 0, sssT: 0 };
}

export function createZone(): ZoneState {
  return { active: false, t: 0, lv: 0, maxLv: 0, bank: 0, beat: 0, lost: 0, entries: 0 };
}

/** Highest rank whose threshold `value` reaches. */
export function rankForStyle(value: number): number {
  for (let i = RANK_THRESH.length - 1; i > 0; i--) if (value >= RANK_THRESH[i]) return i;
  return 0;
}

/** Fraction (0..1) of the way from the held rank's threshold to the next one (1 at SSS). */
export function rankProgress(st: StyleState): number {
  if (st.rank >= RANK_SSS) return 1;
  const a = RANK_THRESH[st.rank];
  const b = RANK_THRESH[st.rank + 1];
  return Math.max(0, Math.min(1, (st.value - a) / (b - a)));
}

export function rankMult(s: GameState): number {
  return RANK_MULT[s.style.rank];
}

/** ZONE factor: 1 outside a ZONE, x2 at Lv.1 and +1 per further level (so 1 + Lv). */
export function zoneMult(s: GameState): number {
  return s.zone.active ? ZONE_BASE_FACTOR + (s.zone.lv - 1) : 1;
}

/** The whole multiplication chain except ON BEAT: combo x rank x ZONE x NITRO x DOUBLE (DESIGN 18.5). */
export function totalMult(s: GameState): number {
  return s.multiplier * rankMult(s) * zoneMult(s) * (s.nitroT > 0 ? 2 : 1) * (s.doubleT > 0 ? 2 : 1);
}

/** Near-miss base points scale with the un-boosted speed: (baseSpeed / 50) ^ 1.5 (about 6.8 at top speed). */
export function speedFactor(baseSpeed: number): number {
  return Math.pow(Math.max(1, baseSpeed) / SPEED_BASE, SPEED_SCORE_EXP);
}

/** INSANE bonus factor for the n-th consecutive INSANE (n >= 1): 1, 2, 4 ... capped at 2^10. */
export function insaneChainFactor(n: number): number {
  return Math.pow(2, Math.min(INSANE_CHAIN_MAX_EXP, Math.max(0, n - 1)));
}

/**
 * timeScale during the ZONE-entry dip, from the real seconds left: eases down to 0.2 over 0.25 s, then back to 1 over 0.3 s.
 */
export function zoneChargeScale(left: number): number {
  const total = ZONE_CHARGE_DOWN + ZONE_CHARGE_UP;
  const elapsed = Math.max(0, Math.min(total, total - left));
  if (elapsed < ZONE_CHARGE_DOWN) {
    const u = elapsed / ZONE_CHARGE_DOWN;
    return 1 - (1 - ZONE_CHARGE_SCALE) * u * u * (3 - 2 * u);
  }
  const u = (elapsed - ZONE_CHARGE_DOWN) / ZONE_CHARGE_UP;
  return ZONE_CHARGE_SCALE + (1 - ZONE_CHARGE_SCALE) * u * u * (3 - 2 * u);
}

/** Earn points: straight into the score, or into the ZONE BANK while a ZONE is running. */
export function gain(s: GameState, points: number): void {
  if (s.zone.active) s.zone.bank += points;
  else s.score += points;
}

export interface Breakdown {
  /** the factors > 1, in display order */
  factors: number[];
  count: number;
  total: number;
}

const FACTOR_CAP = 6;

export function createBreakdown(): Breakdown {
  return { factors: new Array<number>(FACTOR_CAP).fill(1), count: 0, total: 1 };
}

/** The multiplier chain as individual factors (combo, rank, ZONE, NITRO, DOUBLE); allocation-free. */
export function multBreakdown(s: GameState, out: Breakdown): Breakdown {
  let n = 0;
  const f = out.factors;
  if (s.multiplier > 1) f[n++] = s.multiplier;
  if (rankMult(s) > 1) f[n++] = rankMult(s);
  if (zoneMult(s) > 1) f[n++] = zoneMult(s);
  if (s.nitroT > 0) f[n++] = 2;
  if (s.doubleT > 0) f[n++] = 2;
  out.count = n;
  out.total = totalMult(s);
  return out;
}

// ------------------------------------------------------------------ style meter

/** Add (or, with a negative amount, remove) style. Rank-ups are immediate; rank-downs wait for tickStyle(). */
export function addStyle(s: GameState, amount: number): void {
  const st = s.style;
  st.value = Math.max(0, st.value + amount);
  if (amount <= 0) return;
  const r = rankForStyle(st.value);
  if (r > st.rank) {
    const from = st.rank;
    st.rank = r;
    st.downT = 0;
    if (r > st.maxRank) st.maxRank = r;
    s.events.push({ type: 'rankUp', rank: r, from });
  }
}

/** Ghost OVERTAKE (+50 style). Returns the events (rank-ups) it caused; the array is the sim's reusable one. */
export function awardOvertake(s: GameState): GameEvent[] {
  s.events.length = 0;
  if (s.alive) addStyle(s, STYLE_ADD.overtake);
  return s.events;
}

/** Debug / tests: jump the meter to `value` with immediate rank changes (no grace). Returns the events. */
export function setStyle(s: GameState, value: number): GameEvent[] {
  s.events.length = 0;
  const st = s.style;
  st.value = Math.max(0, value);
  const r = rankForStyle(st.value);
  st.downT = 0;
  if (r > st.rank) {
    const from = st.rank;
    st.rank = r;
    if (r > st.maxRank) st.maxRank = r;
    s.events.push({ type: 'rankUp', rank: r, from });
  } else if (r < st.rank) {
    const from = st.rank;
    st.rank = r;
    s.events.push({ type: 'rankDown', rank: r, from });
    if (s.zone.active && r <= RANK_S) endZone(s, 'clear');
  }
  return s.events;
}

export function enterZone(s: GameState): void {
  const z = s.zone;
  if (z.active) return;
  z.active = true;
  z.t = 0;
  z.lv = 1;
  if (z.maxLv < 1) z.maxLv = 1;
  z.bank = 0;
  z.beat = Math.floor(s.beatPos);
  z.lost = 0;
  z.entries++;
  s.style.sssT = 0;
  s.zoneChargeT = ZONE_CHARGE_DOWN + ZONE_CHARGE_UP;
  s.events.push({ type: 'zoneEnter' });
}

/** Debug / tests: open the ZONE right now (at SSS, as if the 3 s had been held). Returns the events. */
export function forceZone(s: GameState): GameEvent[] {
  s.events.length = 0;
  if (!s.alive) return s.events;
  if (s.style.rank < RANK_SSS) {
    const st = s.style;
    st.value = RANK_THRESH[RANK_SSS] + 50;
    const from = st.rank;
    st.rank = RANK_SSS;
    st.maxRank = RANK_SSS;
    st.downT = 0;
    s.events.push({ type: 'rankUp', rank: RANK_SSS, from });
  }
  if (!s.zone.active) enterZone(s);
  return s.events;
}

export type ZoneEnd = 'clear' | 'break';

/** Settle the BANK: everything on a natural end (CLEAR), half after a combo / shield break (BREAK). */
export function endZone(s: GameState, how: ZoneEnd): void {
  const z = s.zone;
  if (!z.active) return;
  const bank = z.bank;
  z.active = false;
  z.bank = 0;
  s.style.sssT = 0;
  if (how === 'clear') {
    s.score += bank;
    s.events.push({ type: 'zoneClear', bank });
  } else {
    const paid = bank * ZONE_BREAK_PAY;
    s.score += paid;
    s.events.push({ type: 'zoneBreak', bank, paid });
  }
}

/** Death inside a ZONE: the whole BANK is forfeited. */
export function loseZone(s: GameState): void {
  const z = s.zone;
  if (!z.active) return;
  const bank = z.bank;
  z.active = false;
  z.bank = 0;
  z.lost = bank;
  s.events.push({ type: 'zoneLost', bank });
}

/** COMBO BREAK: -150 style, the INSANE chain resets, a running ZONE breaks. */
export function onComboBreak(s: GameState): void {
  s.insaneChain = 0;
  addStyle(s, -STYLE_PENALTY.comboBreak);
  endZone(s, 'break');
}

/** Shield destroyed: -200 style, a running ZONE breaks. */
export function onShieldBreak(s: GameState): void {
  addStyle(s, -STYLE_PENALTY.shieldBreak);
  endZone(s, 'break');
}

/** Per sim step (sim-time `sdt`): decay, rank-down grace, ZONE entry / levels / BANK compounding / natural end. */
export function tickStyle(s: GameState, sdt: number): void {
  const st = s.style;
  const z = s.zone;
  if (st.value > 0) st.value = Math.max(0, st.value - RANK_DECAY[st.rank] * sdt);
  if (st.rank > 0 && st.value < RANK_THRESH[st.rank]) {
    st.downT += sdt;
    if (st.downT >= RANK_DOWN_GRACE) {
      const from = st.rank;
      st.rank = rankForStyle(st.value);
      st.downT = 0;
      s.events.push({ type: 'rankDown', rank: st.rank, from });
    }
  } else st.downT = 0;

  if (z.active) {
    z.t += sdt;
    const lv = 1 + Math.floor(z.t / ZONE_LV_SECONDS);
    while (z.lv < lv) {
      z.lv++;
      if (z.lv > z.maxLv) z.maxLv = z.lv;
      s.events.push({ type: 'zoneLevel', lv: z.lv });
    }
    // the BANK compounds on every beat: x (1 + 0.01 x Lv)
    const b = Math.floor(s.beatPos);
    let guard = 8;
    while (z.beat < b && guard-- > 0) {
      z.beat++;
      z.bank *= 1 + ZONE_BANK_COMPOUND * z.lv;
    }
    if (z.beat < b) z.beat = b;
    if (st.rank <= RANK_S) endZone(s, 'clear');
  } else if (st.rank === RANK_SSS) {
    st.sssT += sdt;
    if (st.sssT >= ZONE_ENTER_TIME) enterZone(s);
  } else st.sssT = 0;
}

/** Announce every 10^n the score has crossed since the last call (one event per power of ten). */
export function checkMilestones(s: GameState): void {
  let guard = 24;
  while (guard-- > 0 && s.score >= Math.pow(10, s.milestoneExp + 1)) {
    s.milestoneExp++;
    s.events.push({ type: 'scoreMilestone', exp: s.milestoneExp });
  }
}
