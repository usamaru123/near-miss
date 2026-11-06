import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('architecture', () => {
  const dir = join(__dirname, '..', 'src', 'game');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const strip = (f: string): string =>
    readFileSync(join(dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it('src/game is pure TS: no three.js / DOM access', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const code = strip(f);
      expect(code, f).not.toMatch(/from\s+['"](three|postprocessing|tone)/);
      expect(code, f).not.toMatch(/\b(document|window|localStorage|AudioContext|requestAnimationFrame)\b/);
    }
  });

  it('the sim never looks at the rendering side: nothing in src/game imports render / audio / ui / input (biome shapes are visual only)', () => {
    for (const f of files) expect(strip(f), f).not.toMatch(/from\s+['"]\.\.\/(render|audio|ui|input)\b/);
  });
});
