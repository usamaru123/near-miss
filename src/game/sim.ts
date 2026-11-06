import { angDiff, arcCenter, arcDistance, wrap } from './angles';
import type { ItemKind } from './constants';
import {
  ADRENALINE_DECAY,
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
import { speedAt, tierAt } from './difficulty';
import { createSpawner, nextObstacle, peekObstacle } from './spawner';
import type { GameEvent, GameState, Input, Obstacle, PowerUp } from './types';

export function createState(seed: number, itemsEnabled = true): GameState {
  return {
    seed,
    t: 0,
    dist: 0,
    speed: speedAt(0),
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
    tier: 1,
    maxTier: 1,
    alive: true,
    deathTimer: 0,
    deathDone: false,
    invincible: false,
    spawnEnabled: true,
    launchRamp: false,
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
    spawner: createSpawner(seed, itemsEnabled),
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

function award(s: GameState, kind: 'insane' | 'near', dist: number, pan: number): void {
  const insane = kind === 'insane';
  s.combo++;
  if (s.combo > s.maxCombo) s.maxCombo = s.combo;
  s.comboTimer = COMBO_TIMEOUT;
  const prevMult = s.multiplier;
  s.multiplier = multiplierFor(s.combo);
  const points = (insane ? INSANE_SCORE : NEAR_SCORE) * s.multiplier * scoreMult(s);
  s.score += points;
  if (!s.overdrive) s.adrenaline = Math.min(1, s.adrenaline + (insane ? INSANE_ADRENALINE : NEAR_ADRENALINE));
  s.focus = Math.min(1, s.focus + (insane ? INSANE_FOCUS : NEAR_FOCUS));
  push(s, {
    type: kind === 'insane' ? 'insane' : 'nearMiss',
    points,
    mult: s.multiplier,
    combo: s.combo,
    theta: s.theta,
    dist,
    pan,
  });
  if (s.multiplier > prevMult) push(s, { type: 'multUp', mult: s.multiplier });
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

/** Debug / test helper: put a power-up right in front of the ship. */
export function spawnItemAhead(s: GameState, kind: ItemKind, ahead = 12): PowerUp {
  const p: PowerUp = { id: 900000 + s.powerups.length, kind, anchorId: 0, pos: s.dist + ahead, theta: s.theta, z: -ahead, done: false };
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
  } else {
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
  if (s.alive && input.overdrive && !s.overdrive && s.adrenaline >= 0.999) {
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

  // ---- clock, speed, tier ----
  if (s.alive) {
    s.t += sdtEff;
    s.baseSpeed = speedAt(s.t);
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
    if (s.launchRamp && s.t < LAUNCH_RAMP_TIME) {
      const k = s.t / LAUNCH_RAMP_TIME;
      s.speed *= 0.2 + 0.8 * (1 - (1 - k) * (1 - k) * (1 - k));
    }
    if (s.speed > s.maxSpeed) s.maxSpeed = s.speed;
  }
  s.dist += s.speed * sdt;

  if (s.alive) updateMove(s, input.move, sdt);
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

    if (s.alive && prevZ <= HIT_WINDOW && o.z >= -HIT_WINDOW) {
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
        if (cls !== 'none') award(s, cls, o.minDist, pan);
        else push(s, { type: 'pass', pan, dist: o.minDist });
      }
      removed = true;
    }
    if (!removed) obs[w++] = o;
  }
  obs.length = w;

  if (s.alive) collectItems(s);

  if (!s.alive) return ev;

  // ---- combo, adrenaline, running score ----
  if (s.combo > 0) {
    s.comboTimer -= sdtEff;
    if (s.comboTimer <= 0) {
      push(s, { type: 'comboBreak', combo: s.combo });
      s.combo = 0;
      s.multiplier = 1;
    }
  }
  if (!s.overdrive && s.adrenaline > 0) s.adrenaline = Math.max(0, s.adrenaline - ADRENALINE_DECAY * sdtEff);
  s.score += s.speed * s.multiplier * scoreMult(s) * sdtEff;
  return ev;
}
