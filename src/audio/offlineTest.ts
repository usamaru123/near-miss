/**
 * Dev tool (not part of the game build): renders audio scenarios with Tone.Offline and reports peak / RMS,
 * so clipping or silence can be caught without listening. Open /audio-test.html on the dev server and call
 * window.runOffline(name, seconds).
 */
import * as Tone from 'tone';
import { AudioEngine } from './audio';
import { createBank } from './bank';
import { Music } from './music';
import { Sfx } from './sfx';

export interface LowEnd {
  kicks: number;
  kickPeak: number;
  /** RMS below 120 Hz outside the 150 ms after each kick, dB re kick peak */
  rmsOutsideKickDb: number;
  /** RMS below 120 Hz from 200 ms after each kick to the next kick, dB re kick peak */
  tailRmsDb: number;
  /** same metric, worst single beat */
  worstTailDb: number;
  /** per-second low-band RMS (dB re kick peak), whole signal */
  perSecond: number[];
  /** mean low-band RMS (dB re kick peak) by 25 ms bin after the kick */
  profile: number[];
}

export interface Stats {
  tap: string;
  maxDelta: number;
  /** max adjacent-sample delta divided by the local (+-64 sample) RMS: > ~6 marks a click in non-noise material */
  maxDeltaRatio: number;
  deltaOver03: number;
  lowEnd: LowEnd | null;
  scenario: string;
  seconds: number;
  peak: number;
  peakDb: number;
  rmsDb: number;
  clipped: number;
  perSecondRmsDb: number[];
  perSecondPeakDb: number[];
  failedSamples: string[];
}

const db = (v: number): number => 20 * Math.log10(Math.max(1e-9, v));

/** 2nd-order Butterworth low-pass, applied twice (24 dB/oct). */
function lowpass120(x: Float32Array, sr: number): Float32Array {
  const w0 = (2 * Math.PI * 120) / sr;
  const alpha = Math.sin(w0) / Math.SQRT2;
  const c = Math.cos(w0);
  const b0 = (1 - c) / 2;
  const b1 = 1 - c;
  const b2 = (1 - c) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * c;
  const a2 = 1 - alpha;
  let cur = x;
  for (let pass = 0; pass < 2; pass++) {
    const y = new Float32Array(cur.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < cur.length; i++) {
      const xi = cur[i];
      const yi = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      y[i] = yi;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = yi;
    }
    cur = y;
  }
  return cur;
}

function lowEnd(buf: AudioBuffer, kicks: number[]): LowEnd | null {
  if (kicks.length < 4) return null;
  const sr = buf.sampleRate;
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  const lp = lowpass120(mono, sr);
  const ks = kicks.filter((k) => k > 0.5 && k < buf.duration - 0.6).sort((a, b) => a - b);
  let peak = 0;
  for (const k of ks) for (let i = Math.floor(k * sr); i < Math.floor((k + 0.12) * sr) && i < lp.length; i++) peak = Math.max(peak, Math.abs(lp[i]));
  const inKick = new Uint8Array(lp.length);
  for (const k of ks) for (let i = Math.floor(k * sr); i < Math.floor((k + 0.15) * sr) && i < lp.length; i++) inKick[i] = 1;
  let ss = 0;
  let n = 0;
  const from = Math.floor(ks[0] * sr);
  const to = Math.floor((ks[ks.length - 1] + 0.15) * sr);
  for (let i = from; i < to && i < lp.length; i++) {
    if (inKick[i]) continue;
    ss += lp[i] * lp[i];
    n++;
  }
  let ts = 0;
  let tn = 0;
  let worst = -200;
  for (let j = 0; j + 1 < ks.length; j++) {
    let bs = 0;
    let bn = 0;
    for (let i = Math.floor((ks[j] + 0.2) * sr); i < Math.floor(ks[j + 1] * sr) && i < lp.length; i++) {
      bs += lp[i] * lp[i];
      bn++;
    }
    ts += bs;
    tn += bn;
    if (bn > 0) worst = Math.max(worst, db(Math.sqrt(bs / bn) / peak));
  }
  return {
    kicks: ks.length,
    kickPeak: peak,
    rmsOutsideKickDb: Math.round(db(Math.sqrt(ss / Math.max(1, n)) / peak) * 10) / 10,
    tailRmsDb: Math.round(db(Math.sqrt(ts / Math.max(1, tn)) / peak) * 10) / 10,
    worstTailDb: Math.round(worst * 10) / 10,
    profile: Array.from({ length: 14 }, (_, b) => {
      let q = 0;
      let cnt = 0;
      for (const k of ks) {
        for (let i = Math.floor((k + b * 0.025) * sr); i < Math.floor((k + (b + 1) * 0.025) * sr) && i < lp.length; i++) {
          q += lp[i] * lp[i];
          cnt++;
        }
      }
      return Math.round(db(Math.sqrt(q / Math.max(1, cnt)) / peak) * 10) / 10;
    }),
    perSecond: Array.from({ length: Math.floor(lp.length / sr) }, (_, k) => {
      let q = 0;
      for (let i = k * sr; i < (k + 1) * sr; i++) q += lp[i] * lp[i];
      return Math.round(db(Math.sqrt(q / sr) / peak) * 10) / 10;
    }),
  };
}

function analyse(buf: AudioBuffer, scenario: string, failed: string[], tap: string, kicks: number[]): Stats {
  const sr = buf.sampleRate;
  let peak = 0;
  let sum = 0;
  let n = 0;
  let clipped = 0;
  const per: number[] = [];
  const perPk: number[] = [];
  const chans = [...Array(buf.numberOfChannels).keys()].map((c) => buf.getChannelData(c));
  const secs = Math.floor(buf.length / sr);
  for (let s = 0; s < secs; s++) {
    let ss = 0;
    let spk = 0;
    for (const d of chans) {
      for (let i = s * sr; i < (s + 1) * sr; i++) {
        const v = d[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        if (a > spk) spk = a;
        if (a >= 0.999) clipped++;
        ss += v * v;
      }
    }
    perPk.push(Math.round(db(spk) * 10) / 10);
    sum += ss;
    n += sr * chans.length;
    per.push(Math.round(db(Math.sqrt(ss / (sr * chans.length))) * 10) / 10);
  }
  let maxDelta = 0;
  let over = 0;
  for (const d of chans) {
    for (let i = 1; i < d.length; i++) {
      const dd = Math.abs(d[i] - d[i - 1]);
      if (dd > maxDelta) maxDelta = dd;
      if (dd > 0.3) over++;
    }
  }
  let ratio = 0;
  {
    const d = chans[0];
    const W = 64;
    let acc = 0;
    for (let i = 0; i < Math.min(W, d.length); i++) acc += d[i] * d[i];
    for (let i = W + 1; i < d.length - W; i++) {
      acc += d[i + W] * d[i + W] - d[i - W - 1] * d[i - W - 1];
      const rms = Math.sqrt(Math.max(0, acc) / (2 * W + 1));
      const dd = Math.abs(d[i] - d[i - 1]);
      if (dd > 0.02) ratio = Math.max(ratio, dd / (rms + 1e-3));
    }
  }
  return {
    tap,
    maxDeltaRatio: Math.round(ratio * 10) / 10,
    maxDelta: Math.round(maxDelta * 1000) / 1000,
    deltaOver03: over,
    lowEnd: lowEnd(buf, kicks),
    scenario,
    seconds: buf.length / sr,
    peak,
    peakDb: Math.round(db(peak) * 10) / 10,
    rmsDb: Math.round(db(Math.sqrt(sum / Math.max(1, n))) * 10) / 10,
    clipped,
    perSecondRmsDb: per,
    perSecondPeakDb: perPk,
    failedSamples: failed,
  };
}

async function render(scenario: string, seconds: number, tap: 'master' | 'mix' | 'limiterIn' = 'master'): Promise<Stats> {
  let failed: string[] = [];
  const kicks: number[] = [];
  const buf = await Tone.Offline(async ({ transport }) => {
    const bank = createBank();
    await bank.loadAll();
    const eng = new AudioEngine(bank);
    eng.offline = true;
    eng.tap = tap;
    eng.vol.master = 1;
    eng.build();
    eng.forceRunning = true;
    await eng.reverbReady();
    failed = [...eng.bank.failed];
    const music = new Music(eng);
    music.onKick = (t) => kicks.push(t);
    const sfx = new Sfx(eng);
    const octx = Tone.getContext();
    const at = (t: number, fn: () => void): void => {
      transport.schedule((cbTime: number) => {
        const prev = Tone.getContext();
        if (prev !== octx) Tone.setContext(octx);
        try {
          eng.timeOverride = cbTime;
          fn();
        } catch (err) {
          console.error('scenario step failed', String(err));
        }
        eng.timeOverride = null;
      }, t);
    };
    const tierMatch = /^bgm-t([0-9])(-od|-nop)?$/.exec(scenario);
    if (tierMatch) {
      // the BGM tempo at the start of that tier (continuous BPM: 140 + (speed - 50) x 45 / 130)
      const tierN = Number(tierMatch[1]);
      const sp = Math.min(180, 50 + 1.4 * 25 * (tierN - 1));
      music.start(tierN, 140 + ((sp - 50) * 45) / 130);
      if (tierMatch[2] === '-od') music.setOverdrive(true);
      if (tierMatch[2] === '-nop') at(1.5, () => undefined);
    } else if (scenario === 'title') {
      music.startTitle();
    } else if (scenario === 'drop') {
      music.start(1);
      at(2, () => music.tierUp(2));
    } else if (scenario === 'busy') {
      // worst case: top tier, overdrive, nitro and a pile of simultaneous effects
      music.start(6);
      at(0.5, () => music.setOverdrive(true));
      at(0.5, () => music.setNitro(true));
      for (let k = 0; k < 6; k++) {
        const t = 1 + k * 0.5;
        at(t, () => sfx.insane(0, -0.5));
        at(t + 0.1, () => sfx.smash());
        at(t + 0.1, () => sfx.shard(k));
        at(t + 0.2, () => sfx.whoosh(0.4, 1));
      }
      at(2, () => sfx.overdriveStart());
      at(3, () => sfx.powerup('EMP'));
      at(4, () => sfx.death());
      at(4.2, () => sfx.perfectChain());
      at(4.4, () => sfx.shieldBreak());
      at(4.5, () => sfx.boom());
    } else if (scenario === 'zone' || scenario === 'zone-stack') {
      // worst case with ZONE (DESIGN 18): top tier, SSS shimmer layer, ZONE hook + vocal chops, OVERDRIVE, NITRO,
      // and the ZONE stingers on top of the usual pile of effects. 'zone-stack' fires every new stinger at the same instant.
      music.start(6);
      at(0.2, () => music.setRank(6));
      at(0.5, () => music.setOverdrive(true));
      at(0.5, () => music.setNitro(true));
      at(1.0, () => {
        music.zoneEnter();
        sfx.zoneEnter();
        sfx.rankUp(6);
      });
      for (let k = 0; k < 8; k++) {
        const tt = 2 + k * 0.45;
        at(tt, () => sfx.insane(0, -0.5));
        at(tt + 0.1, () => sfx.smash());
        at(tt + 0.1, () => sfx.shard(k));
        at(tt + 0.2, () => sfx.whoosh(0.4, 1));
        if (k % 3 === 0) at(tt + 0.25, () => sfx.zoneLevel(k + 2));
      }
      if (scenario === 'zone-stack') {
        at(3, () => {
          sfx.rankUp(6);
          sfx.zoneEnter();
          sfx.zoneLevel(5);
          sfx.zoneClear();
          sfx.zoneBreak();
          sfx.milestone(9);
          sfx.powerup('EMP');
          sfx.overdriveStart();
          sfx.perfectChain();
        });
      }
      at(6, () => {
        music.zoneEnd(true);
        sfx.zoneClear();
        sfx.milestone(7);
      });
      at(7, () => {
        sfx.zoneBreak();
        sfx.rankDown();
      });
      at(8, () => sfx.death());
      at(8.2, () => sfx.boom());
    } else if (scenario.startsWith('course')) {
      // 'course-nosfx' / 'course-nosec' drop the new effects / the section music changes (to see which one sets the peak)
      const noSfx = scenario.includes('nosfx');
      const noSec = scenario.includes('nosec');
      // 'course-music': only the music (every section change in turn): the low-end metric of DESIGN 16.1
      const musicOnly = scenario.includes('music');
      // worst case with the course (DESIGN 20): top tier, OVERDRIVE, NITRO, ZONE layers, every section's music change in
      // turn (GAUNTLET snare roll, DARK bass, BREATHER thinning, FLIP reverse cymbal) and the warp / flip / fanfare effects
      // on top of the usual pile. 'course-stack' fires all of the new effects at the same instant.
      music.start(6, 185);
      at(0.2, () => music.setRank(6));
      at(0.5, () => music.setOverdrive(true));
      at(0.5, () => music.setNitro(true));
      if (!scenario.includes('nozone')) at(0.6, () => music.zoneEnter());
      const bar = (4 * 60) / 185;
      if (!noSec) music.setSection('GAUNTLET', 1, 4, 0, 0);
      const plan: [number, 'DARK' | 'BREATHER' | 'FLIP' | 'GAUNTLET' | 'LASER'][] = [
        [4, 'DARK'],
        [8, 'FLIP'],
        [12, 'BREATHER'],
        [16, 'GAUNTLET'],
        [20, 'LASER'],
      ];
      if (!noSec) plan.forEach(([bars, name], i) => {
        at(bars * bar - 0.05, () => music.setSection(name, 0.9, 4, bars * 4, i + 1));
      });
      at(7 * bar, () => music.sectionNotice('FLIP', 4));
      for (let k = 0; k < (musicOnly ? 0 : 14); k++) {
        const tt = 1 + k * 0.45;
        at(tt, () => sfx.insane(0, -0.5));
        at(tt + 0.1, () => sfx.smash());
        at(tt + 0.1, () => sfx.shard(k));
        at(tt + 0.2, () => sfx.whoosh(0.4, 1));
        if (!noSfx && k % 3 === 0) at(tt + 0.25, () => sfx.warp());
        if (!noSfx && k % 4 === 1) at(tt + 0.3, () => sfx.flip());
        if (!noSfx && k % 5 === 2) at(tt + 0.3, () => sfx.gauntletClear());
      }
      if (scenario === 'course-stack') {
        at(3, () => {
          sfx.warp();
          sfx.flip();
          sfx.gauntletClear();
          sfx.zoneEnter();
          sfx.rankUp(6);
          sfx.powerup('EMP');
          sfx.overdriveStart();
          sfx.perfectChain();
          sfx.milestone(9);
        });
      }
      if (!musicOnly) {
        at(7, () => sfx.death());
        at(7.2, () => sfx.boom());
      }
    } else if (scenario === 'sfx' || scenario.startsWith('one-')) {
      // every effect on its own, 1.6 s apart, no music
      const list: (() => void)[] = [
        () => sfx.nearMiss(5 * Math.PI / 180, 0.5),
        () => sfx.insane(0.02, -0.5),
        () => sfx.whoosh(0.5, 0.8),
        () => sfx.shard(0),
        () => sfx.shard(5),
        () => sfx.perfectChain(),
        () => sfx.powerup('SHIELD'),
        () => sfx.powerup('NITRO'),
        () => sfx.powerup('DOUBLE'),
        () => sfx.powerup('WARP'),
        () => sfx.powerup('EMP'),
        () => sfx.shieldBreak(),
        () => sfx.overdriveStart(),
        () => sfx.overdriveEnd(),
        () => sfx.smash(),
        () => sfx.death(),
        () => sfx.boom(),
        () => sfx.launch(),
        () => sfx.countBeep(false),
        () => sfx.countBeep(true),
        () => sfx.multUp(3),
        () => sfx.heart(true),
        () => sfx.rankUp(2),
        () => sfx.rankUp(6),
        () => sfx.rankDown(),
        () => sfx.zoneEnter(),
        () => sfx.zoneLevel(3),
        () => sfx.zoneClear(),
        () => sfx.zoneBreak(),
        () => sfx.milestone(8),
        () => sfx.warp(),
        () => sfx.flip(),
        () => sfx.gauntletClear(),
      ];
      if (scenario === 'sfx') {
        transport.start(0);
        list.forEach((fn, i) => at(0.2 + i * 2.2, fn));
      } else {
        list[Number(scenario.slice(4))]();
      }
    }
    if (scenario !== 'sfx') {
      // music scenarios already started the transport; make sure
    }
  }, seconds, 2, 44100);
  return analyse(buf.get() as AudioBuffer, scenario, failed, tap, kicks);
}

declare global {
  interface Window {
    runOffline: (scenario: string, seconds: number, tap?: 'master' | 'mix' | 'limiterIn') => Promise<Stats>;
    runOfflineTap: (scenario: string, seconds: number, tap?: 'master' | 'mix' | 'limiterIn') => Promise<Stats>;
  }
}
window.runOffline = render;
window.runOfflineTap = render;
document.title = 'ready';
