import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLES, SAMPLE_IDS } from '../src/audio/manifest';
import type { SampleId } from '../src/audio/manifest';
import { SampleBank, peakNorm } from '../src/audio/samples';
import type { BufferLike } from '../src/audio/samples';
import { NOGO_DIAMETER_FRAC, SHOCK_INNER, shockRadius } from '../src/render/fx';

function fakeBuf(peak = 0.5, len = 100): BufferLike {
  const d = new Float32Array(len);
  d[3] = peak;
  return { duration: len / 44100, length: len, numberOfChannels: 1, getChannelData: () => d };
}

describe('sample bank: per-sound synth fallback', () => {
  it('loads everything and normalises each sample to its peak', async () => {
    const bank = new SampleBank<BufferLike, SampleId>(SAMPLES, async () => fakeBuf(0.25));
    const progress: number[] = [];
    await bank.loadAll((d) => progress.push(d));
    expect(bank.failed.size).toBe(0);
    expect(bank.done).toBe(SAMPLE_IDS.length);
    expect(progress.at(-1)).toBe(SAMPLE_IDS.length);
    // peak 0.25 -> normalised x4, times the manifest trim
    expect(bank.gain('kickHeavy')).toBeCloseTo(4 * Math.pow(10, SAMPLES.kickHeavy.db / 20), 6);
  });

  it('a sample that fails to load never rejects loadAll and triggers its fallback instead', async () => {
    const bad = new Set<string>([SAMPLES.kickHeavy.file, SAMPLES.glass.file]);
    const bank = new SampleBank<BufferLike, SampleId>(SAMPLES, async (url) => {
      if ([...bad].some((f) => url.endsWith(f))) throw new Error('404');
      return fakeBuf();
    }, 'audio/');
    await bank.loadAll();
    expect([...bank.failed].sort()).toEqual(['glass', 'kickHeavy']);
    expect(bank.done).toBe(bank.total);

    let played = 0;
    let fell = 0;
    expect(bank.trigger('kickHeavy', () => played++, () => fell++)).toBe(false);
    expect(bank.trigger('snare', () => played++, () => fell++)).toBe(true);
    expect(played).toBe(1);
    expect(fell).toBe(1);
  });

  it('an empty / undecodable buffer counts as failed', async () => {
    const bank = new SampleBank<BufferLike, SampleId>(SAMPLES, async () => fakeBuf(0.5, 0));
    await bank.loadAll();
    expect(bank.failed.size).toBe(SAMPLE_IDS.length);
  });

  it('if the play callback throws, the fallback still runs', async () => {
    const bank = new SampleBank<BufferLike, SampleId>(SAMPLES, async () => fakeBuf());
    await bank.loadAll();
    let fell = 0;
    const used = bank.trigger(
      'crash',
      () => {
        throw new Error('decoder exploded');
      },
      () => fell++,
    );
    expect(used).toBe(false);
    expect(fell).toBe(1);
  });

  it('even when every sample fails the bank resolves (game keeps working with synths)', async () => {
    const bank = new SampleBank<BufferLike, SampleId>(SAMPLES, async () => {
      throw new Error('offline');
    });
    await bank.loadAll();
    expect(bank.failed.size).toBe(SAMPLE_IDS.length);
    let fell = 0;
    for (const id of SAMPLE_IDS) bank.trigger(id, () => undefined, () => fell++);
    expect(fell).toBe(SAMPLE_IDS.length);
  });

  it('peakNorm ignores silence', () => {
    expect(peakNorm(fakeBuf(0))).toBe(1);
    expect(peakNorm(fakeBuf(0.5))).toBe(2);
  });
});

describe('audio assets', () => {
  const dir = join(__dirname, '..', 'public', 'audio');
  it('every manifest file exists, is a RIFF/WAVE, and is listed in CREDITS.md', () => {
    const credits = readFileSync(join(dir, 'CREDITS.md'), 'utf8');
    let total = 0;
    for (const id of SAMPLE_IDS) {
      const f = SAMPLES[id].file;
      const p = join(dir, f);
      expect(existsSync(p), f).toBe(true);
      const head = readFileSync(p).subarray(0, 12).toString('ascii');
      expect(head.slice(0, 4)).toBe('RIFF');
      expect(head.slice(8, 12)).toBe('WAVE');
      expect(credits.includes(f), f + ' missing from CREDITS.md').toBe(true);
      total += statSync(p).size;
    }
    expect(total).toBeLessThan(15 * 1024 * 1024);
  });
});

describe('central no-go circle (DESIGN 14)', () => {
  it('the shockwave ring never starts inside the no-go circle', () => {
    // radii are in units of the half short side; the no-go circle has diameter 40 % of the short side
    const nogo = NOGO_DIAMETER_FRAC; // = radius 0.4 of the half short side
    for (let e = 0; e <= 1; e += 0.01) expect(shockRadius(e) * SHOCK_INNER).toBeGreaterThan(nogo);
    expect(shockRadius(0) * SHOCK_INNER).toBeGreaterThan(nogo * 1.1);
  });
});
