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
  SECTION_NAMES,
  SPEED_MAX,
  START_THETA,
  BIOMES,
  TIERS,
} from './game/constants';
import type { SectionName } from './game/constants';
import { createState, forceClutch, forceDeath, forceSection, multiplierFor, spawnItemAhead, step } from './game/sim';
import { formatScore } from './game/format';
import { awardOvertake, forceZone, setStyle } from './game/style';
import { PaceTracker, parseTrace, resultVsBest, serializeTrace } from './game/pace';
import type { Trace } from './game/pace';
import type { GameEvent, GameState, Input } from './game/types';
import { ITEM_KINDS } from './game/constants';
import type { ItemKind } from './game/constants';
import { InputManager } from './input/input';
import { InputModeTracker } from './input/inputMode';
import { QualityGovernor } from './render/quality';
import { haptic, isAndroid, setAudioSessionPlayback, tryFullscreen } from './ui/platform';
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
  /** Enter CLUTCH right now (no obstacle needed). */
  triggerClutch(): void;
  /** Beat clock / Transport slaving diagnostics. */
  musicSync(): Record<string, unknown>;
  /** Worst-case audio load for `seconds`; reports limiter reduction and underrun indicators. */
  audioStress(seconds: number): Promise<Record<string, unknown>>;
  /** Fill the adrenaline gauge and hold it full until OVERDRIVE starts (touch OVERDRIVE button test). */
  fillAdrenaline(): void;
  /** Camera / canvas facts for the mobile layout tests. */
  getView(): Record<string, unknown>;
  /** Force an adaptive-quality tier (0 = full) for diagnostics. */
  setQualityTier(n: number): void;
  /** Jump the style meter to `n` (rank changes at once, with their effects). */
  setStyle(n: number): void;
  /** Open a ZONE right now (SSS, as if the 3 s had been held). */
  forceZone(): void;
  /** Show biome `n` (0..5) instead of the tier's; -1 follows the tier again. Visual only: the sim is untouched. */
  setBiome(n: number): void;
  /** Fire the biome-change effects (banner, white-out / fade, jingle) for biome `n` as if the warp gate had just been passed. */
  warpTo(n: number): void;
  /** Make the next section of the course `name` (see SECTION_NAMES); cuts the track further than ~45 units ahead. */
  forceSection(name: string): void;
  /** Set the combo (and its multiplier) and keep it alive; `expireCombo()` lets it break on the next step. */
  setCombo(n: number): void;
  expireCombo(): void;
  /** Keep the combo alive (its 3 s timer pinned) until expireCombo() / the next run: e2e steps that wait longer than the timer. */
  holdCombo(on: boolean): void;
  /** Add `n` points to the running ZONE BANK (e2e: makes CLEAR / BREAK / LOST show big numbers). */
  addBank(n: number): void;
  /** Force the next score through the sim as if it were `n` (e2e: milestones / formatting). */
  setScore(n: number): void;
}
declare global {
  interface Window {
    __NEARMISS__?: NearMissDebug;
  }
}

const LS_BEST = 'nearmiss.best';
const LS_FLASH = 'nearmiss.reducedFlash';
const LS_VOL = 'nearmiss.vol.';
const LS_GHOST = 'nearmiss.ghost';

/** Banner text for the start of each section (RANDOM is the plain course: no banner). */
const SECTION_BANNER: Partial<Record<SectionName, { text: string; color: string }>> = {
  SPIRAL: { text: 'SPIRAL', color: '#7df9ff' },
  ZIGZAG: { text: 'ZIGZAG', color: '#7df9ff' },
  PULSE: { text: 'PULSE // ON THE BEAT', color: '#ff7df0' },
  LASER: { text: 'LASER GRID', color: '#ff4a5a' },
  SPLIT: { text: 'SPLIT // GREEDY ROUTE', color: '#ffe066' },
  DARK: { text: 'DARK // LIGHTS OUT', color: '#b8b8ff' },
  FLIP: { text: 'FLIP!', color: '#ffb84a' },
  BREATHER: { text: 'BREATHER // COLLECT!', color: '#7dffb0' },
  GAUNTLET: { text: 'GAUNTLET!', color: '#ff4a5a' },
};
/** Sections that announce themselves one bar early. */
const SECTION_NOTICE: Partial<Record<SectionName, string>> = { FLIP: 'FLIP INCOMING', GAUNTLET: 'GAUNTLET AHEAD', DARK: 'LIGHTS OUT' };

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

setAudioSessionPlayback();

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const app = document.getElementById('app') as HTMLElement;

const renderer = new GameRenderer(canvas);
const audio = new AudioSystem();
const music = audio.music;
const sfx = audio.sfx;
const hud = new Hud();
const screens = new Screens();
const inputMode = new InputModeTracker();
const input = new InputManager(app);
hud.touch = inputMode.mode === 'touch';
inputMode.onChange = (m) => {
  hud.touch = m === 'touch';
};
// adaptive quality (DESIGN 17.6): only ever steps down, silently
const quality = new QualityGovernor(Math.min(window.devicePixelRatio || 1, 2));
function applyQuality(): void {
  renderer.setQuality(quality.tier);
  hud.setParticleScale(renderer.quality.particleScale);
}
/** Pausing is never triggered by a tap that is part of the same touch; resume needs a fresh, deliberate tap. */
const RESUME_LOCK_MS = 350;
let pausedAt = 0;
let wantFullscreen = false;
/** debug: keep the adrenaline gauge full until OVERDRIVE starts (the natural full window is only a few frames) */
let holdAdrenaline = false;
/** debug: pin the combo timer so slow (software GL) e2e steps cannot break the combo behind the test's back */
let holdComboOn = false;

let screen: Screen = 'title';
let state: GameState = makeTitleState();
let pendingSeed: number | null = null;
let acc = 0;
let heartAcc = 0;
/** How much of real time the sim actually keeps up with (1 at a healthy frame rate; < 1 when frames are dropped). */
let simSpeed = 1;
let simNum = 0;
let simDen = 0;
let gameOverAt = 0;
let overdriveQueued = false;
let best = Number(lsGet(LS_BEST)) || 0;
let titleTime = 0;
let countdownT = 0;
let countdownShown = -1;
let milestonesHit = 0;
let pace = new PaceTracker(null, 0);
const ghostView = { visible: false, theta: 0, z: 0 };
const viewState: { flashScale: number; beat: number; ghost: typeof ghostView | null } = { flashScale: 1, beat: 0, ghost: null };
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
  state.reducedFlash = v;
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
  state = createState(seed, true, true);
  state.reducedFlash = reducedFlash;
  let trace: Trace | null = parseTrace(lsGet(LS_GHOST));
  if (best <= 0) trace = null;
  pace = new PaceTracker(trace, best);
  ghostView.visible = false;
  acc = 0;
  heartAcc = 0;
  simSpeed = 1;
  simNum = 0;
  simDen = 0;
  overdriveQueued = false;
  milestonesHit = 0;
  holdComboOn = false;
  renderer.biomeOverride = -1;
  renderer.reset(state);
  music.setBiome(0);
  music.setSection('RANDOM', 0.4, 8, 0, 0);
  hud.resetSpeed(0);
  hud.clearStreaks();
  void audio.unlock();
  audio.setFocus(false);
  audio.restoreFilter();
  music.setNitro(false);
  music.setFocus(false);
  music.setRank(0);
  hud.clearPopups();
  hud.setPace(null);
}

/** The real start of a run: music, wind, launch punch. */
function launchRun(): void {
  state.dist = 0;
  state.speed = state.baseSpeed * 0.2; // start of the launch ramp (keeps the distance integral exact)
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
  pausedAt = performance.now();
  input.releaseTouch();
  screens.show('pause');
  audio.suspend();
}

function resumeGame(): void {
  if (screen !== 'paused') return;
  screen = 'playing';
  screens.show('none');
  audio.resume();
  quality.resetWindow();
  acc = 0;
}

function finishRun(): void {
  const score = Math.floor(state.score);
  const prevBest = best;
  const newRecord = score > best;
  if (newRecord) {
    best = score;
    lsSet(LS_BEST, String(best)); // a double: may be far beyond 2^53, saved and compared as a float
    lsSet(LS_GHOST, serializeTrace(pace.finish(score)));
  }
  hud.setVisible(false);
  screens.showGameOver({
    score,
    best,
    newRecord,
    maxCombo: state.maxCombo,
    topSpeedKmh: Math.round(state.maxSpeed * KMH_FACTOR),
    tier: state.maxTier,
    rank: state.style.maxRank,
    zoneLv: state.zone.maxLv,
    lost: state.zone.lost,
    vs: prevBest > 0 ? resultVsBest(score, prevBest) : null,
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
          if (inputMode.mode === 'touch' && isAndroid()) wantFullscreen = true; // requested in touchend (a valid gesture)
          startCountdown(takeSeed());
        }
      } else if (screen === 'countdown') {
        /* locked until GO */
      } else if (screen === 'paused') {
        if (a !== 'retry' && performance.now() - pausedAt >= RESUME_LOCK_MS) resumeGame();
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

/** FOCUS and CLUTCH both muffle the mix (lowpass, more reverb, louder heartbeat). */
function applyMuffle(): void {
  audio.setFocus(state.focusActive || state.clutch.active);
}

/** Where the floaters go: under the ship - and when FLIP has put the ship at the top, where it would be upright (never into the no-go circle). */
function shipFloaterPos(): void {
  renderer.shipScreen(shipPos);
  if (renderer.rig.flipRoll > Math.PI / 2) shipPos.y = window.innerHeight - shipPos.y;
}

function handleEvent(e: GameEvent): void {
  switch (e.type) {
    case 'nearMiss':
      sfx.nearMiss(e.dist, e.pan);
      shipFloaterPos();
      hud.floater('NEAR MISS +' + formatScore(e.points) + (e.onBeat ? ' \u00b7 ON BEAT' : ''), shipPos.x, shipPos.y + 34, e.onBeat ? 'insane' : 'near', e.points);
      hud.popScore();
      hud.flash(e.onBeat ? '#7df9ff' : '#ffffff', e.onBeat ? 0.12 : 0.08);
      if (e.onBeat) sfx.beatAccent(false);
      break;
    case 'insane':
      sfx.insane(e.dist, e.pan);
      shipFloaterPos();
      hud.floater(
        (e.chain > 1 ? 'INSANE \u00d7' + e.chain + ' CHAIN!! +' : 'INSANE!! +') + formatScore(e.points) + (e.onBeat ? ' \u00b7 ON BEAT' : ''),
        shipPos.x,
        shipPos.y + 34,
        'insane',
        e.points,
      );
      hud.popScore();
      hud.flash(e.onBeat ? '#7df9ff' : '#ffee66', 0.2);
      if (e.onBeat) sfx.beatAccent(true);
      break;
    case 'beatStreak':
      sfx.beatStreak();
      hud.popup('BEAT STREAK x' + e.streak + ' +' + formatScore(e.points), 'beat');
      hud.popScore();
      break;
    case 'clutchStart':
      sfx.clutchStart();
      applyMuffle();
      hud.flash('#ff1030', 0.3);
      break;
    case 'clutchSuccess':
      haptic(30);
      sfx.clutchSuccess();
      hud.popup('CLUTCH!! +' + formatScore(e.points), 'clutch');
      hud.popScore();
      hud.flash('#ffffff', 0.5);
      applyMuffle();
      break;
    case 'clutchFail':
      applyMuffle();
      break;
    case 'smash':
      sfx.smash();
      shipFloaterPos();
      hud.floater('SMASH +' + formatScore(e.points), shipPos.x, shipPos.y + 34, 'smash', e.points);
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
      hud.popup('PERFECT CHAIN! +' + formatScore(e.points), 'perfect');
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
      if (e.count > 0) hud.itemPopup('EMP x' + e.count + ' +' + formatScore(e.points), '#ff4a5a');
      break;
    case 'multUp':
      sfx.multUp(e.mult);
      break;
    case 'death':
      haptic(60);
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
    case 'biomeChange': {
      haptic(30);
      const t = TIERS[e.biome];
      sfx.warp();
      music.setBiome(e.biome);
      hud.warpFlash(reducedFlash);
      hud.biomeBanner(BIOMES[e.biome].name, t.rainbow ? '#ffffff' : '#' + t.primary.toString(16).padStart(6, '0'));
      break;
    }
    case 'sectionNotice': {
      music.sectionNotice(e.name, e.inBeats);
      const text = SECTION_NOTICE[e.name];
      if (text) hud.sectionBanner(text, 'notice');
      break;
    }
    case 'sectionStart': {
      music.setSection(e.name, e.intensity, e.bars, e.startBeat, e.idx);
      const b = SECTION_BANNER[e.name];
      if (b) hud.sectionBanner(b.text, 'section', b.color);
      if (e.name === 'FLIP') sfx.flip();
      break;
    }
    case 'gauntletClear':
      haptic(30);
      sfx.gauntletClear();
      hud.gauntletClear(e.points);
      hud.flash('#ffe9a8', 0.3);
      break;
    case 'overdriveStart':
      holdAdrenaline = false;
      haptic(25);
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
    case 'focusEnd':
      applyMuffle();
      break;
    case 'comboBreak':
      break;
    case 'rankUp':
      sfx.rankUp(e.rank);
      music.setRank(e.rank);
      hud.rankUp(e.rank, e.from);
      if (e.rank >= 4) haptic(15);
      break;
    case 'rankDown':
      sfx.rankDown();
      music.setRank(e.rank);
      hud.rankDown(e.rank, e.from);
      break;
    case 'zoneEnter':
      haptic(40);
      sfx.zoneEnter();
      music.zoneEnter();
      hud.zoneEnter();
      break;
    case 'zoneLevel':
      sfx.zoneLevel(e.lv);
      hud.zoneLevel(e.lv);
      break;
    case 'zoneClear':
      haptic(30);
      sfx.zoneClear();
      music.zoneEnd(true);
      hud.zoneClear(e.bank);
      break;
    case 'zoneBreak':
      haptic(40);
      sfx.zoneBreak();
      music.zoneEnd(false);
      hud.zoneBreak(e.paid);
      break;
    case 'zoneLost':
      hud.zoneLost(e.bank);
      break;
    case 'scoreMilestone':
      sfx.milestone(e.exp);
      hud.scoreBanner(e.exp);
      break;
  }
  renderer.onEvent(e, state);
}

/** Beat pulse from the sim clock: strong on the downbeat, weak on the offbeat (8th grid). */
function simBeatPulse(): number {
  const f = state.beatPos * 2;
  const idx = Math.floor(f);
  return ((idx & 1) === 0 ? 1 : 0.45) * Math.exp(-(f - idx) * 5);
}

function updatePace(): void {
  // during a ZONE the banked points count towards the comparison; the recorded trace holds the real score
  const u = pace.update(state.t, state.score, state.theta, state.score + state.zone.bank);
  ghostView.visible = u.ghostVisible;
  ghostView.theta = u.ghostTheta;
  ghostView.z = u.ghostZ;
  hud.setPace(u.hasBest ? u.diff : null);
  if (u.overtake) {
    hud.popup('OVERTAKE!', 'overtake');
    hud.flash('#5dff8a', 0.22);
    sfx.overtake();
    // +50 style (events go through the normal handler)
    const ev = awardOvertake(state);
    for (let i = 0; i < ev.length; i++) handleEvent(ev[i]);
  }
  if (u.newRecord) {
    hud.popup('NEW RECORD!', 'record');
    hud.flash('#ffee66', 0.4);
    sfx.newRecord();
    renderer.rig.addTrauma(0.6);
  }
}

function simStep(): void {
  if (holdAdrenaline) state.adrenaline = 1;
  if (holdComboOn && state.combo > 0 && state.comboTimer < 1.5) state.comboTimer = 1.5;
  // FLIP: the camera is upside down, so the screen-relative input is mirrored into the world (left is always screen-left)
  simInput.move = input.move * renderer.rig.inputSign;
  simInput.focus = input.focus;
  simInput.overdrive = overdriveQueued;
  overdriveQueued = false;
  const events = step(state, simInput, SIM_DT);
  for (let i = 0; i < events.length; i++) {
    // a pay-out that jumps over several powers of ten announces only the highest one
    if (events[i].type === 'scoreMilestone' && events.slice(i + 1).some((x) => x.type === 'scoreMilestone')) continue;
    handleEvent(events[i]);
  }
}

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const wall = Math.max(0.001, (now - last) / 1000);
  const dt = Math.min(0.1, Math.max(0, wall));
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
    if (screen === 'playing') {
      // ratio of simulated to real time over a ~0.4 s window (unbiased, unlike averaging per-frame ratios)
      const decay = Math.exp(-wall / 0.4);
      simNum = simNum * decay + n * SIM_DT;
      simDen = simDen * decay + wall;
      simSpeed = Math.min(1.5, simNum / Math.max(0.05, simDen));
    }
    if (screen === 'playing' && !state.alive && state.deathDone) finishRun();

    // heartbeat: the HUD heart always pulses; the thump is only audible in FOCUS / CLUTCH (no constant low loop)
    if (screen === 'playing' && state.alive) {
      heartAcc += dt;
      const loud = state.focusActive || state.clutch.active;
      const interval = state.clutch.active ? 0.34 : 60 / hud.heartBpm;
      if (heartAcc >= interval) {
        heartAcc -= interval;
        if (heartAcc > interval) heartAcc = 0;
        hud.beat();
        sfx.heart(loud);
      }
      // the Transport follows the sim's beat clock (BPM x timeScale, +-3 % drift trim)
      music.sync(state.beatPos, state.bpm, state.timeScale * simSpeed);
      updatePace();
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

  if (screen === 'playing' && quality.tick(wall)) applyQuality();

  if (screen !== 'paused') {
    const speedFrac = Math.max(0, Math.min(1, (state.baseSpeed - SPEED_BASE) / (SPEED_MAX - SPEED_BASE)));
    const beat = screen === 'playing' ? simBeatPulse() : music.beatPulse();
    viewState.flashScale = flashScale();
    viewState.beat = beat;
    viewState.ghost = screen === 'playing' ? ghostView : null;
    renderer.frame(state, dt, viewState);
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

window.addEventListener('resize', () => {
  renderer.resize();
  hud.fitPopups();
});
window.addEventListener('orientationchange', () => {
  renderer.resize();
  // iOS reports the new size a moment after the event
  window.setTimeout(() => {
    renderer.resize();
    hud.fitPopups();
  }, 120);
  window.setTimeout(() => {
    renderer.resize();
    hud.fitPopups();
  }, 400);
});
window.visualViewport?.addEventListener('resize', () => renderer.resize());
// Auto-pause ONLY when the page is really hidden (app switch, tab switch, screen lock). window 'blur' is NOT used:
// iOS Safari fires it for a long press, the edge-swipe system gestures and toolbar interaction (DESIGN 17.4).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseGame();
});

// first interaction unlocks audio (also covers pointer/keyboard before any action fires).
// iOS only treats touchend (not touchstart / pointerdown) as an audio-unlocking gesture.
window.addEventListener('pointerdown', gesture, { passive: true });
window.addEventListener('keydown', gesture);
window.addEventListener(
  'touchend',
  () => {
    gesture();
    if (wantFullscreen) {
      wantFullscreen = false;
      tryFullscreen(app);
    }
  },
  { passive: true },
);

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
      beatPos: state.beatPos,
      bpm: state.bpm,
      clutch: state.clutch.active,
      clutchDir: state.clutch.dir,
      hitStop: state.hitStopActive,
      beatStreak: state.beatStreak,
      hasGhost: pace.hasTrace,
      ghostVisible: ghostView.visible,
      paceDiff: pace.out.diff,
      inputMode: inputMode.mode,
      qualityTier: quality.tier,
      fps: Math.round(quality.fps * 10) / 10,
      fullscreen: !!document.fullscreenElement,
      style: state.style.value,
      rank: state.style.rank,
      maxRank: state.style.maxRank,
      zone: state.zone.active,
      zoneLv: state.zone.lv,
      zoneBank: state.zone.bank,
      zoneLost: state.zone.lost,
      zoneT: state.zone.t,
      scoreExact: state.score,
      insaneChain: state.insaneChain,
      hudFxAlive: hud.fx.alive,
      section: state.section.name,
      sectionIdx: state.section.idx,
      kinds: [...new Set(state.obstacles.map((o) => o.kind + '/' + o.section))],
      sectionRole: state.section.role,
      sectionIntensity: state.section.intensity,
      gauntlets: state.section.gauntlets,
      biome: state.tier - 1,
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
    hud.popup('CLUTCH!! +3000', 'clutch');
    hud.popup('NEW RECORD!', 'record');
    hud.milestone('1000 km/h!!');
    shipFloaterPos();
    hud.floater('NEAR MISS +500', shipPos.x, shipPos.y + 34, 'near');
    hud.floater('INSANE!! +1500', shipPos.x, shipPos.y + 34, 'insane');
    renderer.milestone();
  },
  triggerClutch() {
    if (screen !== 'playing' || !state.alive) return;
    const ev = forceClutch(state);
    for (let i = 0; i < ev.length; i++) handleEvent(ev[i]);
  },
  musicSync() {
    return {
      simSpeed,
      syncError: music.syncError,
      hardResyncs: music.hardResyncs,
      transportBpm: music.bpm,
      simBpm: state.bpm,
      timeScale: state.timeScale,
      beatPos: state.beatPos,
      errors: audio.musicErrors,
    };
  },
  fillAdrenaline() {
    state.adrenaline = 1;
    holdAdrenaline = true;
  },
  getView() {
    const cam = renderer.rig.camera;
    const aspect = cam.aspect;
    const rad = Math.PI / 180;
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      aspect,
      dpr: renderer.renderer.getPixelRatio(),
      fov: cam.fov,
      fovBase: renderer.rig.fovBase,
      hfov: (2 * Math.atan(Math.tan(cam.fov * rad * 0.5) * aspect)) / rad,
      hfovBase: (2 * Math.atan(Math.tan(renderer.rig.fovBase * rad * 0.5) * aspect)) / rad,
      shipFraction: renderer.shipScreenFraction(),
      canvasW: canvas.width,
      canvasH: canvas.height,
      quality: { ...renderer.quality },
      zoneAmount: renderer.zoneAmount,
      ...renderer.biomeInfo,
      inputSign: renderer.rig.inputSign,
    };
  },
  setStyle(n: number) {
    if (screen !== 'playing' || !state.alive) return;
    const ev = setStyle(state, n);
    for (let i = 0; i < ev.length; i++) handleEvent(ev[i]);
  },
  forceZone() {
    if (screen !== 'playing' || !state.alive) return;
    const ev = forceZone(state);
    for (let i = 0; i < ev.length; i++) handleEvent(ev[i]);
  },
  setCombo(n: number) {
    state.combo = n;
    state.multiplier = multiplierFor(n);
    state.comboTimer = 3;
  },
  expireCombo() {
    holdComboOn = false;
    state.comboTimer = 0.001;
  },
  holdCombo(on: boolean) {
    holdComboOn = on;
  },
  warpTo(n: number) {
    const b = Math.max(0, Math.min(BIOMES.length - 1, Math.floor(n)));
    renderer.biomeOverride = b;
    handleEvent({ type: 'biomeChange', biome: b });
  },
  setBiome(n: number) {
    renderer.biomeOverride = n < 0 ? -1 : Math.min(BIOMES.length - 1, Math.floor(n));
    if (n >= 0) music.setBiome(renderer.biomeOverride);
  },
  forceSection(name: string) {
    if (screen !== 'playing' || !state.alive || !(SECTION_NAMES as readonly string[]).includes(name)) return;
    forceSection(state, name as SectionName);
  },
  addBank(n: number) {
    if (state.zone.active) state.zone.bank += n;
  },
  setScore(n: number) {
    state.score = n;
  },
  setQualityTier(n: number) {
    quality.tier = Math.max(0, Math.min(6, Math.floor(n)));
    applyQuality();
  },
  async audioStress(seconds: number) {
    await audio.unlock();
    music.start(6);
    music.setOverdrive(true);
    music.setNitro(true);
    // the ZONE layers (lead hook, vocal chops, shimmer, hard sidechain) are part of the worst case
    music.setRank(6);
    music.zoneEnter();
    sfx.startWind();
    sfx.updateWind(1, true, true);
    let worstGr = 0;
    let worstSfxGr = 0;
    const sample = (): void => {
      const st = audio.stats();
      worstGr = Math.min(worstGr, Number(st.limiterReductionDb) || 0);
      worstSfxGr = Math.min(worstSfxGr, Number(st.sfxLimiterReductionDb) || 0);
    };
    const poll = window.setInterval(sample, 20);
    let k = 0;
    const burst = window.setInterval(() => {
      sfx.insane(0, -0.5);
      sfx.smash();
      sfx.shard(k++ % 8);
      sfx.whoosh(0.4, 1);
      sfx.nearMiss(0.02, 0.3);
      if (k % 4 === 0) sfx.powerup('EMP');
      if (k % 5 === 0) sfx.perfectChain();
      if (k % 7 === 0) sfx.shieldBreak();
      if (k % 9 === 0) sfx.overdriveStart();
      if (k % 11 === 0) sfx.boom();
      if (k % 6 === 0) sfx.zoneLevel(k % 9);
      if (k % 13 === 0) sfx.rankUp(6);
      if (k % 17 === 0) sfx.zoneClear();
      if (k % 19 === 0) sfx.zoneBreak();
      if (k % 23 === 0) sfx.milestone(9);
      // the course effects (DESIGN 20) are part of the worst case too
      if (k % 5 === 0) sfx.warp();
      if (k % 7 === 2) sfx.flip();
      if (k % 8 === 3) sfx.gauntletClear();
      if (k % 9 === 0) music.setSection(SECTION_NAMES[k % SECTION_NAMES.length], 0.9, 4, 4 * k, k);
    }, 180);
    await new Promise((r) => window.setTimeout(r, seconds * 1000));
    window.clearInterval(burst);
    window.clearInterval(poll);
    sample();
    const stats = audio.stats();
    music.stop();
    sfx.stopWind();
    return { worstLimiterReductionDb: worstGr, worstSfxLimiterReductionDb: worstSfxGr, ...stats };
  },
  audioStats() {
    return {
      ready: audioReady,
      running: audio.running,
      failed: [...audio.bank.failed],
      loaded: audio.bank.done,
      total: audio.bank.total,
      musicErrors: audio.musicErrors,
      engine: audio.stats(),
    };
  },
};

// keep the invincible debug flag across restarts is intentionally NOT done: each run starts clean.
showTitle();
requestAnimationFrame((t) => {
  last = t;
  requestAnimationFrame(frame);
});
