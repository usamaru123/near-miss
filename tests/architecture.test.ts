import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('architecture', () => {
  it('src/game is pure TS: no three.js / DOM access', () => {
    const dir = join(__dirname, '..', 'src', 'game');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/from\s+['"](three|postprocessing)/);
      expect(code, f).not.toMatch(/\b(document|window|localStorage|AudioContext|requestAnimationFrame)\b/);
    }
  });
});
