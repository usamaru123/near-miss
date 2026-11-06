import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/game/constants';
import { createState, step } from '../src/game/sim';
import type { Input } from '../src/game/types';
import { botInput } from './bot';

const SEEDS = [1, 2, 3, 42, 99, 1234, 31337, 777, 2024, 987654321];
const SURVIVE = 90;

describe('greedy bot survival (fairness proof, no invincibility)', () => {
  for (const seed of SEEDS) {
    it('seed ' + seed + ' survives >= ' + SURVIVE + ' s', () => {
      const s = createState(seed);
      const input: Input = { move: 0, focus: false, overdrive: false };
      let steps = 0;
      const maxSteps = Math.ceil(120 / SIM_DT);
      while (s.alive && steps < maxSteps) {
        botInput(s, input);
        step(s, input, SIM_DT);
        steps++;
      }
      expect(s.invincible).toBe(false);
      expect(s.t).toBeGreaterThanOrEqual(SURVIVE);
      expect(s.alive).toBe(true);
    });
  }
});
