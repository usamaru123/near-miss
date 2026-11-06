import '@fontsource/orbitron/400.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/900.css';
import '@fontsource/noto-sans-jp/japanese-700.css';
import './ui/styles.css';

import { AudioSystem } from './audio/system';
import {
  GAMEOVER_INPUT_LOCK,
  COUNTDOWN_STEP,
  KMH_FACTOR,
  MILESTONES_KMH,
  MAX_STEPS_PER_FRAME,
  REDUCED_FLASH_FACTOR,
  SIM_DT,
  SPEED_BASE,
  SPEED_MAX,
  START_THETA,
  TIERS,
} from './game/constants';
import { createState, forceDeath, spawnItemAhead, step } from './game/sim';
import type { GameEvent, GameState, Input } from './game/types';
import { ITEM_KINDS } from './game/constants';
import type { ItemKind } from './game/constants';
import { InputManager } from './input/input';
import type { Action } from './input/input';
import { GameRenderer } from './render/renderer';
import { Hud } from './ui/hud';
import { Screens } from './ui/screens';

type Screen = 'title' | 'countdown' | 'playing' | 'paused' | 'gameover';

interface NearMissDebug {
  getState(): Record<string, unknown>;
  forceDeath(): void;
  setSeed(n: number): void;
  setInvincible(v: boolean): void;
  /** Put a power-up in front of the ship. */
  spawnItem(type: ItemKind): void;
  /** Fire every kind of overlay text at once (layout test). */
  popupDemo(): void;
  audioStats(): Record<string, unknown>;
}
declare global {
  interface Window {
    __NEARMISS__?: NearMissDebug;
  }
}

const LS_BEST = 'nearmiss.best';
const LS_FLASH = 'nearmiss.reducedFlash';
const LS_VOL = 'nearmiss.vol.';

const ITEM_LABEL: Record<ItemKind, { text: string; color: string }> = {
  SHIELD: { text: 'SHIELD!', color: '#4a9bff' },
  NITRO: { text: 'NITRO!!', color: '#ff8a00' },
  DOUBLE: { text: 'DOUBLE x2!', color: '#ffd23c' },
  WARP: { text: 'WARP!', color: '#c47bff' },
  EMP: { text: 'EMP BLAST!!', color: '#ff4a5a' },
};

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, v: string): void {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const app = document.getElementById('app') as HTMLElement;

const renderer = new GameRenderer(canvas);
const audio = new AudioSystem();
const music = audio.music;
const sfx = audio.sfx;
const hud = new Hud();
const screens = new Screens();
const input = new InputManager(app);

let screen: Screen = 'title';
let state: GameState = makeTitleState();
let pendingSeed: number | null = null;
let acc = 0;
let heartAcc = 0;
let gameOverAt = 0;
let overdriveQueued = false;
let best = Number(lsGet(LS_BEST)) || 0;
let titleTime = 0;
let countdownT = 0;
let countdownShown = -1;
let milestonesHit = 0;
const simInput: Input = { move: 0, focus: false, overdrive: false };
const shipPos = { x: 0, y: 0 };

// reduced flash: stored preference, else follow prefers-reduced-motion
let reducedFlash: boolean;
{
  const stored = lsGet(LS_FLASH);
  reducedFlash =
    stored !== null ? stored === '1' : window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function flashScale(): number {
  return reducedFlash ? REDUCED_FLASH_FACTOR : 1;
}
function setReducedFlash(v: boolean): void {
  reducedFlash = v;
  lsSet(LS_FLASH, v ? '1' : '0');
  screens.setReducedFlash(v);
  hud.flashScale = flashScale();
}
screens.onReducedFlashChange = setReducedFlash;
setReducedFlash(reducedFlash);
screens.setBest(best);
screens.show('title');

// ---- audio: volumes (persisted), loading, first-gesture unlock ----
for (const k of ['master', 'bgm', 'se'] as const) {
  const raw = lsGet(LS_VOL + k);
  const v = Number(raw);
  if (raw !== null && Number.isFinite(v)) audio.setVolume(k, v);
}
screens.setVolumes(audio.vol);
screens.onVolume = (k, v) => {
  audio.setVolume(k, v);
  lsSet(LS_VOL + k, String(v));
};
let audioReady = false;
void audio.load((d, t) => screens.setLoading(d, t)).then(() => {
  audioReady = true;
  screens.setReady();
});
/** First user gesture: start the Tone context, then the chill title loop. */
function gesture(): void {
  void audio.unlock().then(() => {
    if (screen === 'title') music.startTitle();
  });
}

function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

function makeTitleState(): GameState {
  const s = createState(1);
  s.spawnEnabled = false;
  s.baseSpeed = 62;
  s.speed = 62;
  return s;
}

function takeSeed(): number {
  if (pendingSeed !== null) {
    const s = pendingSeed;
    pendingSeed = null;
    return s;
  }
  return randomSeed();
}

function resetRunState(seed: number): void {
  state = createState(seed);
  state.launchRamp = true;
  acc = 0;
  heartAcc = 0;
  overdriveQueued = false;
  milestonesHit = 0;
  renderer.reset(state);
  hud.resetSpeed(0);
  hud.clearStreaks();
  void audio.unlock();
  audio.setFocus(false);
  audio.restoreFilter();
  music.setNitro(false);
  music.setFocus(false);
  hud.clearPopups();
}

/** The real start of a run: music, wind, launch punch. */
function launchRun(): void {
  state.dist = 0;
  music.start(1);
  sfx.launch();
  sfx.startWind();
  renderer.launch();
  hud.flash('#ffffff', 0.35);
  screens.show('none');
  hud.setVisible(true);
  hud.overdriveBanner(false);
  screen = 'playing';
}

/** Instant retry (no countdown). */
function startRun(seed: number): void {
  sfx.stopWind();
  hud.countdown(null);
  resetRunState(seed);
  launchRun();
}

/** First start from the title: 3-2-1-GO. */
function startCountdown(seed: number): void {
  resetRunState(seed);
  state.baseSpeed = SPEED_BASE;
  state.speed = 20;
  screens.show('none');
  hud.setVisible(true);
  countdownT = -0.12; // let the audio context come up before the first beep
  countdownShown = -1;
  screen = 'countdown';
}

function showTitle(): void {
  state = makeTitleState();
  renderer.reset(state);
  music.stop();
  sfx.stopWind();
  hud.setVisible(false);
  screens.setBest(best);
  screens.show('title');
  screen = 'title';
}

function pauseGame(): void {
  if (screen !== 'playing' || !state.alive) return;
  screen = 'paused';
  screens.show('pause');
  audio.suspend();
}

function resumeGame(): void {
  if (screen !== 'paused') return;
  screen = 'playing';
  screens.show('none');
  audio.resume();
  acc = 0;
}

function finishRun(): void {
  const score = Math.floor(state.score);
  const newRecord = score > best;
  if (newRecord) {
    best = score;
    lsSet(LS_BEST, String(best));
  }
  hud.setVisible(false);
  screens.showGameOver({
    score,
    best,
    newRecord,
    maxCombo: state.maxCombo,
    topSpeedKmh: Math.round(state.maxSpeed * KMH_FACTOR),
    tier: state.maxTier,
  });
  gameOverAt = performance.now();
  screen = 'gameover';
  music.startGameOver();
}

function onAction(a: Action): void {
  gesture();
  switch (a) {
    case 'mute':
      audio.setMuted(!audio.muted);
      screens.flashMute(audio.muted);
      return;
    case 'flash':
      if (screen === 'title') setReducedFlash(!reducedFlash);
      return;
    case 'pause':
      if (screen === 'playing') pauseGame();
      else if (screen === 'paused') resumeGame();
      return;
    case 'overdrive':
      if (screen === 'playing') overdriveQueued = true;
      return;
    case 'space':
    case 'tap':
    case 'retry': {
      if (screen === 'title') {
        if (a !== 'retry' && audioReady) {
          (document.activeElement as HTMLElement | null)?.blur?.();
          startCountdown(takeSeed());
        }
      } else if (screen === 'countdown') {
        /* locked until GO */
      } else if (screen === 'paused') {
        if (a !== 'retry') resumeGame();
      } else if (screen === 'gameover') {
        if (performance.now() - gameOverAt >= GAMEOVER_INPUT_LOCK * 1000) startRun(takeSeed());
      } else if (screen === 'playing' && a === 'space') {
        overdriveQueued = true;
      }
      return;
    }
  }
}
input.onAction = onAction;

function handleEvent(e: GameEvent): void {
  switch (e.type) {
    case 'nearMiss':
      sfx.nearMiss(e.dist, e.pan);
      renderer.shipScreen(shipPos);
      hud.floater('NEAR MISS +' + e.points, shipPos.x, shipPos.y + 34, 'near');
      hud.popScore();
      hud.flash('#ffffff', 0.08);
      break;
    case 'insane':
      sfx.insane(e.dist, e.pan);
      renderer.shipScreen(shipPos);
      hud.floater('INSANE!! +' + e.points, shipPos.x, shipPos.y + 34, 'insane');
      hud.popScore();
      hud.flash('#ffee66', 0.2);
      break;
    case 'smash':
      sfx.smash();
      renderer.shipScreen(shipPos);
      hud.floater('SMASH +' + e.points, shipPos.x, shipPos.y + 34, 'smash');
      hud.popScore();
      hud.flash('#ff6070', 0.18);
      break;
    case 'pass':
      sfx.whoosh(e.pan, Math.max(0, Math.min(1, (state.baseSpeed - SPEED_BASE) / (SPEED_MAX - SPEED_BASE))));
      break;
    case 'shard':
      sfx.shard(e.chainIdx);
      hud.popScore();
      hud.flash('#aef6ff', 0.035);
      break;
    case 'perfectChain':
      sfx.perfectChain();
      hud.popup('PERFECT CHAIN! +' + e.points, 'perfect');
      hud.popScore();
      hud.flash('#ffee66', 0.14);
      break;
    case 'powerup': {
      const l = ITEM_LABEL[e.kind];
      sfx.powerup(e.kind);
      hud.itemPopup(l.text, l.color);
      hud.flash(l.color, e.kind === 'EMP' ? 0.4 : 0.16);
      if (e.kind === 'NITRO') music.setNitro(true);
      break;
    }
    case 'effectEnd':
      if (e.kind === 'NITRO') music.setNitro(false);
      break;
    case 'shieldBreak':
      sfx.shieldBreak();
      hud.itemPopup('SHIELD BREAK', '#66b4ff');
      hud.flash('#66b4ff', 0.25);
      break;
    case 'emp':
      sfx.emp();
      if (e.count > 0) hud.itemPopup('EMP x' + e.count + ' +' + e.points, '#ff4a5a');
      break;
    case 'multUp':
      sfx.multUp(e.mult);
      break;
    case 'death':
      sfx.death();
      sfx.stopWind();
      audio.setFocus(false);
      music.setFocus(false);
      music.setNitro(false);
      music.cut();
      hud.flash('#ffffff', 0.7);
      break;
    case 'tierUp':
      music.tierUp(e.tier);
      hud.tierBanner(e.tier);
      hud.flash('#ffffff', 0.18);
      break;
    case 'overdriveStart':
      sfx.overdriveStart();
      music.setOverdrive(true);
      hud.overdriveBanner(true);
      hud.flash('#ff1030', 0.45);
      break;
    case 'overdriveEnd':
      sfx.overdriveEnd();
      music.setOverdrive(false);
      hud.overdriveBanner(false);
      break;
    case 'focusStart':
      audio.setFocus(true);
      music.setFocus(true);
      break;
    case 'focusEnd':
      audio.setFocus(false);
      music.setFocus(false);
      break;
    case 'comboBreak':
      break;
  }
  renderer.onEvent(e, state);
}

function simStep(): void {
  simInput.move = input.move;
  simInput.focus = input.focus;
  simInput.overdrive = overdriveQueued;
  overdriveQueued = false;
  const events = step(state, simInput, SIM_DT);
  for (let i = 0; i < events.length; i++) handleEvent(events[i]);
}

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;

  if (screen === 'playing' || screen === 'gameover') {
    acc += dt;
    let n = 0;
    while (acc >= SIM_DT && n < MAX_STEPS_PER_FRAME) {
      simStep();
      acc -= SIM_DT;
      n++;
    }
    if (n === MAX_STEPS_PER_FRAME) acc = 0;
    if (screen === 'playing' && !state.alive && state.deathDone) finishRun();

    // heartbeat synced with the HUD heart
    if (screen === 'playing' && state.alive) {
      heartAcc += dt;
      const interval = 60 / hud.heartBpm;
      if (heartAcc >= interval) {
        heartAcc -= interval;
        if (heartAcc > interval) heartAcc = 0;
        hud.beat();
        sfx.heart(state.focusActive);
      }
    }
  } else if (screen === 'countdown') {
    countdownT += dt;
    const idx = Math.min(3, Math.floor(countdownT / COUNTDOWN_STEP));
    if (idx !== countdownShown) {
      countdownShown = idx;
      if (idx < 3) {
        hud.countdown(String(3 - idx));
        sfx.countBeep(false);
      }
    }
    state.dist += 22 * dt;
    state.theta = START_THETA;
    if (countdownT >= COUNTDOWN_STEP * 3) {
      hud.countdown('GO!', true);
      sfx.countBeep(true);
      launchRun();
    }
  } else if (screen === 'title') {
    titleTime += dt;
    state.dist += 52 * dt;
    state.theta = START_THETA + Math.sin(titleTime * 0.45) * 0.9;
    state.angVel = Math.cos(titleTime * 0.45) * 0.9 * 0.45;
  }

  if (screen !== 'paused') {
    const speedFrac = Math.max(0, Math.min(1, (state.baseSpeed - SPEED_BASE) / (SPEED_MAX - SPEED_BASE)));
    const beat = music.beatPulse();
    renderer.frame(state, dt, { flashScale: flashScale(), beat });
    if (screen === 'playing' || screen === 'countdown') {
      const tier = TIERS[state.tier - 1];
      const css = state.overdrive ? '#ff6070' : tier.rainbow ? '#ffffff' : '#' + tier.primary.toString(16).padStart(6, '0');
      hud.update(state, beat, speedFrac, renderer.focusAmount, dt, css);
    }
    if (screen === 'playing' && state.alive) {
      sfx.updateWind(speedFrac, state.overdrive, state.nitroT > 0);
      const kmh = state.speed * KMH_FACTOR;
      while (milestonesHit < MILESTONES_KMH.length && kmh >= MILESTONES_KMH[milestonesHit]) {
        hud.milestone(MILESTONES_KMH[milestonesHit] + ' km/h!!');
        renderer.milestone();
        sfx.boom();
        milestonesHit++;
      }
    }
  }
}

window.addEventListener('resize', () => renderer.resize());
window.addEventListener('blur', () => pauseGame());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseGame();
});

// first interaction unlocks audio (also covers pointer/keyboard before any action fires)
window.addEventListener('pointerdown', gesture, { passive: true });
window.addEventListener('keydown', gesture);

window.__NEARMISS__ = {
  getState() {
    return {
      screen,
      alive: state.alive,
      deathDone: state.deathDone,
      t: state.t,
      dist: state.dist,
      score: Math.floor(state.score),
      combo: state.combo,
      maxCombo: state.maxCombo,
      multiplier: state.multiplier,
      adrenaline: state.adrenaline,
      focus: state.focus,
      focusActive: state.focusActive,
      overdrive: state.overdrive,
      speed: state.speed,
      tier: state.tier,
      theta: state.theta,
      seed: state.seed,
      invincible: state.invincible,
      timeScale: state.timeScale,
      obstacles: state.obstacles.length,
      best,
      reducedFlash,
      muted: audio.muted,
      audioReady,
      shield: state.shield,
      nitroT: state.nitroT,
      doubleT: state.doubleT,
      warpT: state.warpT,
      shards: state.shards.length,
      powerups: state.powerups.length,
    };
  },
  forceDeath() {
    if (screen !== 'playing' || !state.alive) return;
    const ev = forceDeath(state);
    for (let i = 0; i < ev.length; i++) handleEvent(ev[i]);
  },
  setSeed(n: number) {
    pendingSeed = n >>> 0;
    if (screen === 'playing') startRun(takeSeed());
  },
  setInvincible(v: boolean) {
    state.invincible = v;
  },
  spawnItem(type: ItemKind) {
    if (!ITEM_KINDS.includes(type)) return;
    spawnItemAhead(state, type, 14);
  },
  popupDemo() {
    hud.popup('PERFECT CHAIN! +1000', 'perfect');
    hud.tierBanner(3);
    hud.itemPopup('NITRO!!', '#ff8a00');
    hud.milestone('1000 km/h!!');
    renderer.shipScreen(shipPos);
    hud.floater('NEAR MISS +500', shipPos.x, shipPos.y + 34, 'near');
    hud.floater('INSANE!! +1500', shipPos.x, shipPos.y + 34, 'insane');
    renderer.milestone();
  },
  audioStats() {
    return {
      ready: audioReady,
      running: audio.running,
      failed: [...audio.bank.failed],
      loaded: audio.bank.done,
      total: audio.bank.total,
      musicErrors: audio.musicErrors,
    };
  },
};

// keep the invincible debug flag across restarts is intentionally NOT done: each run starts clean.
showTitle();
requestAnimationFrame((t) => {
  last = t;
  requestAnimationFrame(frame);
});
