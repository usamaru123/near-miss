import { describe, expect, it } from 'vitest';
import { DuckModel, VoiceBook } from '../src/audio/voicePolicy';

describe('voice policy (DESIGN 16.4)', () => {
  it('merges identical sounds triggered within 30 ms', () => {
    const b = new VoiceBook<string>(3, 0.03);
    expect(b.request('smash', 1.0, 1.5).merged).toBe(false);
    expect(b.request('smash', 1.02, 1.5).merged).toBe(true);
    expect(b.request('smash', 1.029, 1.5).merged).toBe(true);
    // a different sound is unaffected, and so is the same one once the window has passed
    expect(b.request('whoosh', 1.01, 1.4).merged).toBe(false);
    expect(b.request('smash', 1.06, 1.5).merged).toBe(false);
  });

  it('caps polyphony per sound at 3 and steals the oldest voice', () => {
    const b = new VoiceBook<string>(3, 0.03);
    const a = b.request('hit', 0, 5);
    const c = b.request('hit', 0.1, 5);
    const d = b.request('hit', 0.2, 5);
    expect([a.steal, c.steal, d.steal]).toEqual([null, null, null]);
    expect(b.count('hit', 0.25)).toBe(3);
    const e = b.request('hit', 0.3, 5);
    expect(e.steal).toBe(a.token); // oldest goes
    expect(b.count('hit', 0.35)).toBe(3);
    const f = b.request('hit', 0.4, 5);
    expect(f.steal).toBe(c.token);
  });

  it('voices that already ended do not count', () => {
    const b = new VoiceBook<string>(3, 0.03);
    b.request('x', 0, 0.2);
    b.request('x', 0.1, 0.3);
    b.request('x', 0.2, 0.4);
    const r = b.request('x', 1.0, 1.2);
    expect(r.steal).toBeNull();
    expect(b.count('x', 1.05)).toBe(1);
  });

  it('hammering one sound never runs more than 3 voices', () => {
    const b = new VoiceBook<string>(3, 0.03);
    let worst = 0;
    for (let i = 0; i < 500; i++) {
      const t = i * 0.04;
      b.request('spam', t, t + 0.5);
      worst = Math.max(worst, b.count('spam', t + 0.001));
    }
    expect(worst).toBeLessThanOrEqual(3);
  });
});

describe('overlap ducking', () => {
  it('a single effect does not duck; many at once duck, bounded below by the floor; it recovers', () => {
    const d = new DuckModel(0.3, 1.6, 0.22, 0.5);
    expect(d.add(0, 0.6)).toBe(1);
    let g = 1;
    for (let i = 0; i < 30; i++) g = d.add(0.01 * i, 0.8);
    expect(g).toBeLessThan(0.7);
    expect(g).toBeGreaterThanOrEqual(0.5);
    expect(d.add(3, 0.2)).toBeGreaterThan(0.95); // 2.7 s later the load has decayed
  });
});
