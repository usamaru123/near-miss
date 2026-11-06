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

export interface Stats {
  scenario: string;
  seconds: number;
  peak: number;
  peakDb: number;
  rmsDb: number;
  clipped: number;
  perSecondRmsDb: number[];
  failedSamples: string[];
}

const db = (v: number): number => 20 * Math.log10(Math.max(1e-9, v));

function analyse(buf: AudioBuffer, scenario: string, failed: string[]): Stats {
  const sr = buf.sampleRate;
  let peak = 0;
  let sum = 0;
  let n = 0;
  let clipped = 0;
  const per: number[] = [];
  const chans = [...Array(buf.numberOfChannels).keys()].map((c) => buf.getChannelData(c));
  const secs = Math.floor(buf.length / sr);
  for (let s = 0; s < secs; s++) {
    let ss = 0;
    for (const d of chans) {
      for (let i = s * sr; i < (s + 1) * sr; i++) {
        const v = d[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        if (a >= 0.999) clipped++;
        ss += v * v;
      }
    }
    sum += ss;
    n += sr * chans.length;
    per.push(Math.round(db(Math.sqrt(ss / (sr * chans.length))) * 10) / 10);
  }
  return {
    scenario,
    seconds: buf.length / sr,
    peak,
    peakDb: Math.round(db(peak) * 10) / 10,
    rmsDb: Math.round(db(Math.sqrt(sum / Math.max(1, n))) * 10) / 10,
    clipped,
    perSecondRmsDb: per,
    failedSamples: failed,
  };
}

async function render(scenario: string, seconds: number): Promise<Stats> {
  let failed: string[] = [];
  const buf = await Tone.Offline(async ({ transport }) => {
    const bank = createBank();
    await bank.loadAll();
    const eng = new AudioEngine(bank);
    eng.build();
    eng.forceRunning = true;
    await eng.reverbReady();
    failed = [...eng.bank.failed];
    const music = new Music(eng);
    const sfx = new Sfx(eng);
    const octx = Tone.getContext();
    const at = (t: number, fn: () => void): void => {
      transport.schedule(() => {
        const prev = Tone.getContext();
        if (prev !== octx) Tone.setContext(octx);
        try {
          fn();
        } catch (err) {
          console.error('scenario step failed', String(err));
        }
      }, t);
    };
    const tierMatch = /^bgm-t(\d)(-od)?$/.exec(scenario);
    if (tierMatch) {
      music.start(Number(tierMatch[1]));
      if (tierMatch[2]) at(1.5, () => music.setOverdrive(true));
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
      ];
      if (scenario === 'sfx') {
        transport.start(0);
        list.forEach((fn, i) => at(0.2 + i * 1.6, fn));
      } else {
        list[Number(scenario.slice(4))]();
      }
    }
    if (scenario !== 'sfx') {
      // music scenarios already started the transport; make sure
    }
  }, seconds, 2, 44100);
  return analyse(buf.get() as AudioBuffer, scenario, failed);
}

declare global {
  interface Window {
    runOffline: (scenario: string, seconds: number) => Promise<Stats>;
  }
}
window.runOffline = render;
document.title = 'ready';
