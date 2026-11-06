import { angDiff, arcCenter, arcDistance, arcLen, wrap } from './angles';
import type { ItemKind } from './constants';
import {
  ADRENALINE_DECAY,
  BEAT_STREAK_EVERY,
  BEAT_STREAK_SCORE,
  CLUTCH_ADRENALINE,
  CLUTCH_COOLDOWN,
  CLUTCH_DURATION,
  CLUTCH_MAX_PEN,
  CLUTCH_SCORE,
  CLUTCH_TIMESCALE,
  HITSTOP_CAP_PER_SEC,
  HITSTOP_CLUTCH,
  HITSTOP_INSANE,
  HITSTOP_INSANE_BEAT,
  HITSTOP_TIMESCALE,
  ONBEAT_MULT,
  SIM_DT,
  ANG_ACCEL,
  ANG_DECEL,
  COMBO_PER_MULT,
  COMBO_TIMEOUT,
  DEATH_SLOWMO_TIME,
  DEATH_TIMESCALE,
  DOUBLE_DURATION,
  EMP_RANGE,
  NITRO_DURATION,
  NITRO_SPEED_MULT,
  PERFECT_ADRENALINE,
  PERFECT_SCORE,
  POWERUP_PICK_ANGLE,
  POWERUP_PICK_Z,
  SHARD_ADRENALINE,
  SHARD_PICK_ANGLE,
  SHARD_PICK_Z,
  SHARD_SCORE,
  SHIELD_GRACE,
  WARP_DRAIN_MULT,
  WARP_DURATION,
  FOCUS_DRAIN,
  FOCUS_REGEN,
  FOCUS_TIMESCALE,
  HIT_WINDOW,
  INSANE_ADRENALINE,
  INSANE_DIST,
  INSANE_FOCUS,
  INSANE_SCORE,
  LAUNCH_RAMP_TIME,
  MAX_ANG_VEL,
  MULT_MAX,
  NEAR_ADRENALINE,
  NEAR_DIST,
  NEAR_FOCUS,
  NEAR_SCORE,
  OVERDRIVE_DURATION,
  OVERDRIVE_GRACE,
  OVERDRIVE_SPEED_MULT,
  SHIP_HALF_ANGLE,
  SMASH_SCORE,
  SPAWN_AHEAD,
  START_THETA,
} from './constants';
import { beatAt, bpmAtSpeed, gridOffsetSec, isOnBeat, LAUNCH_LOSS, launchFactor, speedAt, tierAt } from './difficulty';
import { createSpawner, nextObstacle, peekObstacle } from './spawner';
import type { GameEvent, GameState, Input, Obstacle, PowerUp } from './types';

export function createState(seed: number, itemsEnabled = true, launchRamp = false): GameState {
  const ringLen = Math.max(1, Math.round(1 / SIM_DT));
  return {
    seed,
    t: 0,
    dist: 0,
    speed: speedAt(0) * (launchRamp ? launchFactor(0) : 1),
    baseSpeed: speedAt(0),
    maxSpeed: speedAt(0),
    theta: START_THETA,
    angVel: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    multiplier: 1,
    comboTimer: 0,
    adrenaline: 0,
    overdriveT: 0,
    overdrive: false,
    graceT: 0,
    focus: 1,
    focusActive: false,
    focusLocked: false,
    timeScale: 1,
    beatPos: 0,
    bpm: bpmAtSpeed(speedAt(0)),
    beatStreak: 0,
    realT: 0,
    hitStopT: 0,
    hitStopActive: false,
    hitRing: new Uint8Array(ringLen),
    hitRingIdx: 0,
    hitRingSum: 0,
    reducedFlash: false,
    beatBonus: true,
    clutch: { active: false, t: 0, dir: 0, obs: null, lastStart: -1e9 },
    tier: 1,
    maxTier: 1,
    alive: true,
    deathTimer: 0,
    deathDone: false,
    invincible: false,
    spawnEnabled: true,
    launchRamp,
    shards: [],
    powerups: [],
    shield: false,
    nitroT: 0,
    doubleT: 0,
    warpT: 0,
    chainId: 0,
    chainRun: 0,
    chainGot: 0,
    chainBroken: false,
    obstacles: [],
    spawner: createSpawner(seed, itemsEnabled, launchRamp ? -LAUNCH_LOSS : 0),
    events: [],
  };
}

export type NearMissClass = 'insane' | 'near' | 'none';

/** Boundary: strictly below the threshold qualifies. */
export function classifyNearMiss(dist: number): NearMissClass {
  if (dist < INSANE_DIST) return 'insane';
  if (dist < NEAR_DIST) return 'near';
  return 'none';
}

export function multiplierFor(combo: number): number {
  return Math.min(MULT_MAX, 1 + Math.floor(combo / COMBO_PER_MULT));
}

/** Score multiplier from NITRO (x2) and DOUBLE (x2); they stack. */
export function scoreMult(s: GameState): number {
  return (s.nitroT > 0 ? 2 : 1) * (s.doubleT > 0 ? 2 : 1);
}

function updateMove(s: GameState, move: number, sdt: number): void {
  const target = Math.max(-1, Math.min(1, move)) * MAX_ANG_VEL;
  const v = s.angVel;
  let rate: number;
  if (move === 0) rate = ANG_DECEL;
  else if (v * target < 0 || Math.abs(target) < Math.abs(v)) rate = ANG_DECEL;
  else rate = ANG_ACCEL;
  const dv = target - v;
  const maxDv = rate * sdt;
  s.angVel = Math.abs(dv) <= maxDv ? target : v + Math.sign(dv) * maxDv;
  s.theta = wrap(s.theta + s.angVel * sdt);
}

function rotOf(o: Obstacle, baseSpeed: number): number {
  // Rotation is defined relative to the hit moment so the safe zone at hit time is exact
  // regardless of OVERDRIVE speed changes.
  return o.rotHit + (o.omega * o.z) / Math.max(1, baseSpeed);
}

/** Smallest distance between the ship arc and the solids; 0 means colliding. */
function shipDistance(o: Obstacle, theta: number): number {
  const sa = theta - SHIP_HALF_ANGLE;
  const sb = theta + SHIP_HALF_ANGLE;
  const rot = o.omega !== 0 ? o.rot : 0;
  let m = Infinity;
  const arcs = o.solids;
  for (let i = 0; i < arcs.length; i++) {
    const d = arcDistance(sa, sb, arcs[i].a + rot, arcs[i].b + rot);
    if (d < m) m = d;
    if (m === 0) return 0;
  }
  return m;
}

function passPan(o: Obstacle, theta: number): number {
  const rot = o.omega !== 0 ? o.rot : 0;
  let best = Infinity;
  let pan = 0;
  for (let i = 0; i < o.solids.length; i++) {
    const c = arcCenter(o.solids[i].a + rot, o.solids[i].b + rot);
    const d = angDiff(theta, c);
    if (Math.abs(d) < best) {
      best = Math.abs(d);
      pan = d;
    }
  }
  return Math.max(-1, Math.min(1, pan / (Math.PI / 2)));
}

function push(s: GameState, e: GameEvent): void {
  s.events.push(e);
}

function kill(s: GameState): void {
  if (!s.alive) return;
  if (s.clutch.active) {
    s.clutch.active = false;
    s.clutch.obs = null;
    push(s, { type: 'clutchFail' });
  }
  s.alive = false;
  s.deathTimer = 0;
  s.deathDone = false;
  s.combo = 0;
  if (s.focusActive) {
    s.focusActive = false;
    push(s, { type: 'focusEnd' });
  }
  push(s, { type: 'death', theta: s.theta });
}

/** Kill the player immediately (debug / tests). Returns events like step(). */
export function forceDeath(s: GameState): GameEvent[] {
  s.events.length = 0;
  kill(s);
  return s.events;
}

function award(s: GameState, kind: 'insane' | 'near', dist: number, pan: number, onBeat: boolean): void {
  const insane = kind === 'insane';
  s.combo++;
  if (s.combo > s.maxCombo) s.maxCombo = s.combo;
  s.comboTimer = COMBO_TIMEOUT;
  const prevMult = s.multiplier;
  s.multiplier = multiplierFor(s.combo);
  const points = (insane ? INSANE_SCORE : NEAR_SCORE) * s.multiplier * scoreMult(s) * (onBeat ? ONBEAT_MULT : 1);
  s.score += points;
  if (!s.overdrive) s.adrenaline = Math.min(1, s.adrenaline + (insane ? INSANE_ADRENALINE : NEAR_ADRENALINE));
  s.focus = Math.min(1, s.focus + (insane ? INSANE_FOCUS : NEAR_FOCUS));
  s.beatStreak = onBeat ? s.beatStreak + 1 : 0;
  push(s, {
    type: kind === 'insane' ? 'insane' : 'nearMiss',
    points,
    mult: s.multiplier,
    combo: s.combo,
    theta: s.theta,
    dist,
    pan,
    onBeat,
    streak: s.beatStreak,
  });
  if (onBeat && s.beatStreak % BEAT_STREAK_EVERY === 0) {
    const bonus = BEAT_STREAK_SCORE * s.multiplier * scoreMult(s);
    s.score += bonus;
    push(s, { type: 'beatStreak', streak: s.beatStreak, points: bonus });
  }
  if (s.multiplier > prevMult) push(s, { type: 'multUp', mult: s.multiplier });
  if (insane) requestHitStop(s, onBeat ? HITSTOP_INSANE_BEAT : HITSTOP_INSANE);
}

/**
 * Ask for a hit-stop of `sec` real seconds (world timeScale 0.03). Requests are honoured while the trailing
 * second holds less than HITSTOP_CAP_PER_SEC of hit-stop (see step()); reduced-flash mode halves them.
 */
export function requestHitStop(s: GameState, sec: number): void {
  const t = sec * (s.reducedFlash ? 0.5 : 1);
  if (t > s.hitStopT) s.hitStopT = t;
}

interface Pen {
  /** smallest angle the ship must move to get clear of the solid (rad) */
  p: number;
  /** +1 / -1 direction of that escape */
  dir: number;
}
const pen: Pen = { p: 0, dir: 0 };

/** Penetration of the ship into the (rotated) solids of `o`: min escape shift of the deepest overlap. */
function penetration(o: Obstacle, theta: number, out: Pen): Pen {
  const sa = theta - SHIP_HALF_ANGLE;
  const sb = theta + SHIP_HALF_ANGLE;
  const rot = o.omega !== 0 ? o.rot : 0;
  out.p = 0;
  out.dir = 0;
  for (let i = 0; i < o.solids.length; i++) {
    const a = o.solids[i].a + rot;
    const b = o.solids[i].b + rot;
    if (arcDistance(sa, sb, a, b) > 0) continue;
    const plus = wrap(b - sa); // shift needed to leave through the CCW end
    const minus = wrap(sb - a); // ... through the CW end
    const shift = Math.min(plus, minus, arcLen(sa, sb) + arcLen(a, b));
    if (shift >= out.p) {
      out.p = shift;
      out.dir = plus <= minus ? 1 : -1;
    }
  }
  return out;
}

function clutchReady(s: GameState): boolean {
  return !s.clutch.active && !s.overdrive && !s.shield && s.realT - s.clutch.lastStart >= CLUTCH_COOLDOWN;
}

function startClutch(s: GameState, o: Obstacle | null, dir: number): void {
  const c = s.clutch;
  c.active = true;
  c.t = CLUTCH_DURATION;
  c.dir = dir;
  c.obs = o;
  c.lastStart = s.realT;
  if (o) o.touched = true;
  if (s.focusActive) {
    s.focusActive = false;
    push(s, { type: 'focusEnd' });
  }
  push(s, { type: 'clutchStart', theta: s.theta, dir });
}

/** Debug / tests: enter CLUTCH right now without an obstacle (it resolves as a success). */
export function forceClutch(s: GameState): GameEvent[] {
  s.events.length = 0;
  if (s.alive && !s.clutch.active) startClutch(s, null, 1);
  return s.events;
}

function resolveClutch(s: GameState): void {
  const c = s.clutch;
  const o = c.obs;
  c.active = false;
  c.obs = null;
  c.dir = 0;
  if (o && shipDistance(o, s.theta) === 0) {
    push(s, { type: 'clutchFail' });
    c.active = false;
    kill(s);
    return;
  }
  const points = CLUTCH_SCORE * s.multiplier * scoreMult(s);
  s.score += points;
  if (!s.overdrive) s.adrenaline = Math.min(1, s.adrenaline + CLUTCH_ADRENALINE);
  push(s, { type: 'clutchSuccess', points, theta: s.theta });
  requestHitStop(s, HITSTOP_CLUTCH);
}

function activate(s: GameState, p: PowerUp): void {
  push(s, { type: 'powerup', kind: p.kind, theta: s.theta });
  applyItem(s, p.kind);
}

/** Apply a power-up's effect to the state (also used by tests / debug). */
export function applyItem(s: GameState, kind: ItemKind): void {
  switch (kind) {
    case 'SHIELD':
      s.shield = true;
      break;
    case 'NITRO':
      s.nitroT = NITRO_DURATION;
      break;
    case 'DOUBLE':
      s.doubleT = DOUBLE_DURATION;
      break;
    case 'WARP':
      s.focus = 1;
      s.focusLocked = false;
      s.warpT = WARP_DURATION;
      break;
    case 'EMP': {
      let n = 0;
      const obs = s.obstacles;
      let w = 0;
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        if (o.z <= HIT_WINDOW && -o.z <= EMP_RANGE) n++;
        else obs[w++] = o;
      }
      obs.length = w;
      const points = n * SMASH_SCORE * s.multiplier * scoreMult(s);
      s.score += points;
      push(s, { type: 'emp', count: n, points });
      break;
    }
  }
}

/**
 * Debug / test helper: put a power-up right in front of the ship.
 * The ship may still be coasting to a stop (ANG_DECEL), so the item goes where the ship will be when it
 * arrives if the player lets go of the controls, not where it is right now: placing it at the current angle
 * made pick-ups miss by more than POWERUP_PICK_ANGLE whenever a turn had just ended (the flaky e2e).
 * The id comes from the spawner's counter, so it never repeats after an item was removed.
 */
export function spawnItemAhead(s: GameState, kind: ItemKind, ahead = 12): PowerUp {
  const va = Math.abs(s.angVel);
  const tArrive = ahead / Math.max(1, s.speed);
  const dRest = (va * va) / (2 * ANG_DECEL);
  const dArrive = tArrive >= va / ANG_DECEL ? dRest : va * tArrive - 0.5 * ANG_DECEL * tArrive * tArrive;
  // aim between "where the ship is on arrival" and "where it ends up" so the whole pick-up window is covered
  const coast = Math.sign(s.angVel) * 0.5 * (dArrive + dRest);
  const p: PowerUp = {
    id: s.spawner.nextItemId++,
    kind,
    anchorId: 0,
    pos: s.dist + ahead,
    theta: wrap(s.theta + coast),
    z: -ahead,
    done: false,
  };
  s.powerups.push(p);
  return p;
}

function collectItems(s: GameState): void {
  const sh = s.shards;
  let w = 0;
  for (let i = 0; i < sh.length; i++) {
    const it = sh[i];
    it.z = s.dist - it.pos;
    let keep = true;
    if (!it.done && it.z >= -SHARD_PICK_Z && Math.abs(angDiff(s.theta, it.theta)) <= SHARD_PICK_ANGLE) {
      it.done = true;
      keep = false;
      if (it.chainId !== s.chainId) {
        s.chainId = it.chainId;
        s.chainRun = 0;
        s.chainGot = 0;
        s.chainBroken = false;
      }
      const points = SHARD_SCORE * s.multiplier * scoreMult(s);
      s.score += points;
      if (!s.overdrive) s.adrenaline = Math.min(1, s.adrenaline + SHARD_ADRENALINE);
      push(s, { type: 'shard', points, chainIdx: s.chainRun, idx: it.idx, chainLen: it.chainLen, theta: it.theta });
      s.chainRun++;
      s.chainGot++;
      if (it.idx === it.chainLen - 1 && s.chainGot === it.chainLen && !s.chainBroken) {
        const bonus = PERFECT_SCORE * s.multiplier * scoreMult(s);
        s.score += bonus;
        if (!s.overdrive) s.adrenaline = Math.min(1, s.adrenaline + PERFECT_ADRENALINE);
        push(s, { type: 'perfectChain', points: bonus, theta: s.theta });
      }
    } else if (!it.done && it.z > SHARD_PICK_Z) {
      keep = false;
      if (it.chainId !== s.chainId) {
        s.chainId = it.chainId;
        s.chainGot = 0;
      }
      s.chainRun = 0;
      s.chainBroken = true;
    }
    if (keep) sh[w++] = it;
  }
  sh.length = w;

  const pw = s.powerups;
  w = 0;
  for (let i = 0; i < pw.length; i++) {
    const it = pw[i];
    it.z = s.dist - it.pos;
    let keep = true;
    if (!it.done && it.z >= -POWERUP_PICK_Z && Math.abs(angDiff(s.theta, it.theta)) <= POWERUP_PICK_ANGLE) {
      it.done = true;
      keep = false;
      activate(s, it);
    } else if (it.z > POWERUP_PICK_Z) {
      keep = false;
    }
    if (keep) pw[w++] = it;
  }
  pw.length = w;
}

/**
 * Advance the simulation by one fixed real-time step `dt`.
 * The returned array is reused: it is valid until the next call.
 */
export function step(s: GameState, input: Input, dt: number): GameEvent[] {
  const ev = s.events;
  ev.length = 0;
  s.realT += dt;

  // ---- focus & time scale (real time) ----
  if (s.alive) {
    const wantFocus = input.focus && !s.overdrive;
    if (!input.focus) s.focusLocked = false;
    if (wantFocus && !s.focusActive && !s.focusLocked && s.focus > 0.02) {
      s.focusActive = true;
      push(s, { type: 'focusStart' });
    } else if (s.focusActive && !wantFocus) {
      s.focusActive = false;
      push(s, { type: 'focusEnd' });
    }
    if (s.focusActive) {
      s.focus = Math.max(0, s.focus - FOCUS_DRAIN * (s.warpT > 0 ? WARP_DRAIN_MULT : 1) * dt);
      if (s.focus <= 0) {
        s.focusActive = false;
        s.focusLocked = true;
        push(s, { type: 'focusEnd' });
      }
    } else {
      s.focus = Math.min(1, s.focus + FOCUS_REGEN * dt);
    }
    s.timeScale = s.focusActive ? FOCUS_TIMESCALE : 1;
    if (s.clutch.active) s.timeScale = CLUTCH_TIMESCALE;
    // hit-stop: capped so that no trailing second holds more than HITSTOP_CAP_PER_SEC of it
    const capSteps = Math.round(HITSTOP_CAP_PER_SEC / SIM_DT);
    const stop = s.hitStopT > 0 && s.hitRingSum < capSteps;
    if (s.hitStopT > 0) {
      s.hitStopT = stop ? Math.max(0, s.hitStopT - dt) : 0;
    }
    s.hitStopActive = stop;
    if (stop) s.timeScale = Math.min(s.timeScale, HITSTOP_TIMESCALE);
    const ring = s.hitRing;
    s.hitRingSum += (stop ? 1 : 0) - ring[s.hitRingIdx];
    ring[s.hitRingIdx] = stop ? 1 : 0;
    s.hitRingIdx = (s.hitRingIdx + 1) % ring.length;
  } else {
    s.hitStopActive = false;
    s.deathTimer += dt;
    if (s.deathTimer >= DEATH_SLOWMO_TIME) s.deathDone = true;
    s.timeScale = DEATH_TIMESCALE;
  }
  if (s.alive && s.warpT > 0) {
    s.warpT -= dt;
    if (s.warpT <= 0) {
      s.warpT = 0;
      push(s, { type: 'effectEnd', kind: 'WARP' });
    }
  }
  const sdt = dt * s.timeScale;

  // ---- overdrive trigger ----
  if (s.alive && input.overdrive && !s.overdrive && !s.clutch.active && s.adrenaline >= 0.999) {
    s.overdrive = true;
    s.overdriveT = OVERDRIVE_DURATION;
    s.adrenaline = 0;
    if (s.focusActive) {
      s.focusActive = false;
      push(s, { type: 'focusEnd' });
      s.timeScale = 1;
    }
    push(s, { type: 'overdriveStart' });
  }

  const sdtEff = sdt;
  const prevSpeed = s.speed;

  // ---- clock, speed, tier ----
  if (s.alive) {
    s.t += sdtEff;
    s.baseSpeed = speedAt(s.t);
    s.bpm = bpmAtSpeed(s.baseSpeed);
    s.beatPos = beatAt(s.t);
    const tier = tierAt(s.t);
    if (tier > s.tier) {
      s.tier = tier;
      if (tier > s.maxTier) s.maxTier = tier;
      push(s, { type: 'tierUp', tier });
    }
    if (s.overdrive) {
      s.overdriveT -= sdtEff;
      if (s.overdriveT <= 0) {
        s.overdrive = false;
        s.overdriveT = 0;
        s.graceT = OVERDRIVE_GRACE;
        push(s, { type: 'overdriveEnd' });
      }
    } else if (s.graceT > 0) {
      s.graceT = Math.max(0, s.graceT - sdtEff);
    }
    if (s.nitroT > 0) {
      s.nitroT -= sdtEff;
      if (s.nitroT <= 0) {
        s.nitroT = 0;
        push(s, { type: 'effectEnd', kind: 'NITRO' });
      }
    }
    if (s.doubleT > 0) {
      s.doubleT -= sdtEff;
      if (s.doubleT <= 0) {
        s.doubleT = 0;
        push(s, { type: 'effectEnd', kind: 'DOUBLE' });
      }
    }
    s.speed = s.baseSpeed * (s.overdrive ? OVERDRIVE_SPEED_MULT : 1) * (s.nitroT > 0 ? NITRO_SPEED_MULT : 1);
    if (s.launchRamp && s.t < LAUNCH_RAMP_TIME) s.speed *= launchFactor(s.t / LAUNCH_RAMP_TIME);
    if (s.speed > s.maxSpeed) s.maxSpeed = s.speed;
  }
  // trapezoid rule: exact for the linear speed curve, so obstacles reach the ship on the beat grid
  s.dist += 0.5 * (prevSpeed + s.speed) * sdt;
  if (!s.alive) s.beatPos += (s.bpm / 60) * sdt;

  // the ship steers in real time, even while the world is frozen by CLUTCH
  if (s.alive) updateMove(s, input.move, s.clutch.active ? dt : sdt);
  else {
    // drift to a stop slowly
    s.angVel *= 0.98;
  }

  // ---- spawn ----
  if (s.spawnEnabled) {
    const sp = s.spawner;
    while (peekObstacle(sp).pos <= s.dist + SPAWN_AHEAD) {
      const o = nextObstacle(sp);
      o.z = s.dist - o.pos;
      s.obstacles.push(o);
    }
    const sq = sp.shardQ;
    while (sq.length > 0 && sq[0].pos <= s.dist + SPAWN_AHEAD) {
      const it = sq.shift()!;
      it.z = s.dist - it.pos;
      s.shards.push(it);
    }
    const pq = sp.powerQ;
    while (pq.length > 0 && pq[0].pos <= s.dist + SPAWN_AHEAD) {
      const it = pq.shift()!;
      it.z = s.dist - it.pos;
      s.powerups.push(it);
    }
  }

  // ---- obstacles: motion, collision, resolution ----
  const obs = s.obstacles;
  let w = 0;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    const prevZ = o.z;
    o.z = s.dist - o.pos;
    if (o.omega !== 0) o.rot = rotOf(o, s.baseSpeed);
    let removed = false;

    const pending = s.clutch.active && o === s.clutch.obs; // collision with this one is deferred
    if (s.alive && !pending && prevZ <= HIT_WINDOW && o.z >= -HIT_WINDOW) {
      o.overlapped = true;
      const d = shipDistance(o, s.theta);
      if (d < o.minDist) o.minDist = d;
      if (d === 0) {
        if (s.overdrive) {
          const points = SMASH_SCORE * s.multiplier * scoreMult(s);
          s.score += points;
          push(s, { type: 'smash', points, theta: s.theta, id: o.id });
          removed = true;
        } else if (s.graceT > 0 || s.invincible) {
          o.touched = true;
        } else if (s.shield) {
          s.shield = false;
          s.graceT = Math.max(s.graceT, SHIELD_GRACE);
          push(s, { type: 'shieldBreak', theta: s.theta, id: o.id });
          removed = true;
        } else if (clutchReady(s) && penetration(o, s.theta, pen).p <= CLUTCH_MAX_PEN) {
          startClutch(s, o, pen.dir);
        } else {
          o.touched = true;
          kill(s);
        }
      }
    }

    if (!removed && o.z > HIT_WINDOW) {
      if (s.alive && o.overlapped && !o.touched && o.minDist !== Infinity) {
        const cls = classifyNearMiss(o.minDist);
        const pan = passPan(o, s.theta);
        // sim time at which the obstacle finished passing the ship (interpolated inside the step)
        const tPass = s.t - (o.z - HIT_WINDOW) / Math.max(1, s.speed);
        const onBeat = s.beatBonus && isOnBeat(gridOffsetSec(tPass));
        if (cls !== 'none') award(s, cls, o.minDist, pan, onBeat);
        else push(s, { type: 'pass', pan, dist: o.minDist, onBeat });
      }
      removed = true;
    }
    if (!removed) obs[w++] = o;
  }
  obs.length = w;

  // ---- CLUTCH: keep the escape arrow current, resolve after the real-time window ----
  const cl = s.clutch;
  if (s.alive && cl.active) {
    cl.t -= dt;
    if (cl.obs && shipDistance(cl.obs, s.theta) === 0) cl.dir = penetration(cl.obs, s.theta, pen).dir;
    else if (cl.obs) cl.dir = 0;
    if (cl.t <= 0) resolveClutch(s);
  }

  if (s.alive) collectItems(s);

  if (!s.alive) return ev;

  // ---- combo, adrenaline, running score ----
  if (s.combo > 0) {
    s.comboTimer -= sdtEff;
    if (s.comboTimer <= 0) {
      push(s, { type: 'comboBreak', combo: s.combo });
      s.combo = 0;
      s.multiplier = 1;
      s.beatStreak = 0;
    }
  }
  // A full gauge stays full until OVERDRIVE is used; otherwise it decays below the
  // 0.999 trigger threshold within ~70 ms and OVERDRIVE is nearly impossible to fire.
  if (!s.overdrive && s.adrenaline > 0 && s.adrenaline < 0.999) s.adrenaline = Math.max(0, s.adrenaline - ADRENALINE_DECAY * sdtEff);
  s.score += s.speed * s.multiplier * scoreMult(s) * sdtEff;
  return ev;
}
