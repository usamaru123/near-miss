import {
  BEATS_PER_BAR,
  DIRECTOR_SEED_XOR,
  GAUNTLET_BARS,
  MAX_TIER,
  ROLE_CYCLE_HIGH,
  ROLE_CYCLE_HIGH_TIER,
  ROLE_CYCLE_LOW,
  SECTION_MIN_TIER,
} from './constants';
import type { SectionName, SectionRole } from './constants';
import { chapterStartBeat } from './difficulty';
import { Rng } from './rng';
import type { SectionDef } from './types';

/**
 * Section planner / intensity director (DESIGN 20.2, 20.3).
 *
 * The whole section sequence is a pure function of the seed: it has its own RNG stream and is planned one section at a
 * time in order, so it never depends on how far the obstacle generator or the sim has advanced (a DAILY seed gives
 * everybody the same sequence).
 *
 * Layout: the run is cut into one "chapter" per tier. A chapter starts on the bar line just under the tier-up beat and
 * is filled with sections of 8 bars (one phrase); the last chapter bars before a tier-up are a 4 bar GAUNTLET, and
 * what is left over (4..7 bars) becomes the second section. Roles follow build -> build -> peak -> breather, with more
 * peaks from tier 4 on.
 */

/** Weight of each section by role (a section below its minimum tier is never picked). */
const WEIGHTS: Readonly<Record<'build' | 'peak', readonly [SectionName, number][]>> = {
  build: [
    ['RANDOM', 36],
    ['SPIRAL', 30],
    ['ZIGZAG', 22],
    ['PULSE', 18],
    ['SPLIT', 16],
    ['DARK', 14],
  ],
  peak: [
    ['RANDOM', 20],
    ['SPIRAL', 8],
    ['ZIGZAG', 20],
    ['PULSE', 20],
    ['LASER', 28],
    ['SPLIT', 14],
    ['DARK', 14],
    ['FLIP', 16],
  ],
};

export function roleIntensity(role: SectionRole, chapter: number): number {
  const up = 0.03 * (chapter - 1);
  switch (role) {
    case 'build':
      return Math.min(1, 0.4 + up);
    case 'peak':
      return Math.min(1, 0.8 + up);
    case 'breather':
      return 0.1;
    case 'gauntlet':
      return 1;
  }
}

export function chapterOf(beat: number): number {
  let k = 1;
  while (k < MAX_TIER && beat >= chapterStartBeat(k + 1)) k++;
  return k;
}

export function chapterEnd(k: number): number {
  return k < MAX_TIER ? chapterStartBeat(k + 1) : Infinity;
}

export class Director {
  readonly defs: SectionDef[] = [];
  private readonly rng: Rng;
  private roleIdx = 0;
  private cursor = chapterStartBeat(1);

  constructor(seed: number) {
    this.rng = new Rng((seed ^ DIRECTOR_SEED_XOR) >>> 0);
  }

  /** Plan sections until one covers `beat`. */
  ensure(beat: number): void {
    while (this.cursor <= beat) this.planNext();
  }

  /** The section that covers `beat` (beats before the first section report the first one). */
  at(beat: number): SectionDef {
    if (this.defs.length === 0) this.planNext();
    this.ensure(beat);
    const d = this.defs;
    for (let i = d.length - 1; i >= 0; i--) if (d[i].startBeat <= beat) return d[i];
    return d[0];
  }

  /** Index-based access: plan up to and including def `idx`. */
  get(idx: number): SectionDef {
    while (this.defs.length <= idx) this.planNext();
    return this.defs[idx];
  }

  /**
   * Debug: replace the future from `startBeat` with one section of `bars` bars (the sections after it carry on as
   * planned from the chapter layout). Used by forceSection(); the normal course never calls it.
   */
  force(name: SectionName, startBeat: number, bars = 8): SectionDef {
    // drop every def that starts at or after the cut, shorten the one that straddles it
    while (this.defs.length > 0 && this.defs[this.defs.length - 1].startBeat >= startBeat) this.defs.pop();
    const last = this.defs[this.defs.length - 1];
    if (last && last.endBeat > startBeat) last.endBeat = startBeat;
    const chapter = chapterOf(startBeat);
    const role: SectionRole = name === 'BREATHER' ? 'breather' : name === 'GAUNTLET' ? 'gauntlet' : 'peak';
    const def: SectionDef = {
      idx: this.defs.length,
      name,
      role,
      startBeat,
      endBeat: startBeat + bars * BEATS_PER_BAR,
      chapter,
      intensity: roleIntensity(role, chapter),
      forced: true,
    };
    this.defs.push(def);
    this.cursor = def.endBeat;
    return def;
  }

  private nextRole(chapter: number): SectionRole {
    const cyc = chapter >= ROLE_CYCLE_HIGH_TIER ? ROLE_CYCLE_HIGH : ROLE_CYCLE_LOW;
    return cyc[this.roleIdx++ % cyc.length];
  }

  private pick(role: 'build' | 'peak', chapter: number, flipOk: boolean): SectionName {
    const recent = this.defs.slice(-3).map((d) => d.name);
    const prev = recent[recent.length - 1];
    const cands: [SectionName, number][] = [];
    let total = 0;
    for (const [name, w0] of WEIGHTS[role]) {
      if (SECTION_MIN_TIER[name] > chapter) continue;
      if (name === 'FLIP' && !flipOk) continue;
      if (name === prev) continue; // never the same section twice in a row
      // the last three sections count against a name (the more recent, the more)
      let w = w0;
      for (let i = 0; i < recent.length; i++) if (recent[i] === name) w *= 0.3;
      cands.push([name, w]);
      total += w;
    }
    if (cands.length === 0) return 'RANDOM' === prev ? 'SPIRAL' : 'RANDOM';
    let r = this.rng.next() * total;
    for (const [name, w] of cands) {
      r -= w;
      if (r < 0) return name;
    }
    return cands[cands.length - 1][0];
  }

  private planNext(): void {
    const start = this.cursor;
    const chapter = chapterOf(start);
    const end = chapterEnd(chapter);
    const left = (end - start) / BEATS_PER_BAR; // bars to the chapter end
    const hasGauntlet = chapter >= 2 && chapter < MAX_TIER;
    let name: SectionName;
    let role: SectionRole;
    let bars: number;
    if (hasGauntlet && left <= GAUNTLET_BARS + 1e-9) {
      name = 'GAUNTLET';
      role = 'gauntlet';
      bars = left;
    } else {
      const pre = left - (hasGauntlet ? GAUNTLET_BARS : 0);
      bars = pre >= 12 ? 8 : pre; // 8 bar phrases; the remainder (4..11 bars) is one section
      if (!Number.isFinite(bars)) bars = 8;
      role = this.nextRole(chapter);
      if (role === 'breather') name = 'BREATHER';
      else {
        // no FLIP in the last slot before a GAUNTLET / tier-up: the roll must not coincide with the warp
        const endsBeat = start + bars * BEATS_PER_BAR;
        const lastSlot = endsBeat + (hasGauntlet ? GAUNTLET_BARS * BEATS_PER_BAR : 0) >= end - 1e-9;
        name = this.pick(role === 'peak' ? 'peak' : 'build', chapter, !lastSlot);
      }
    }
    const def: SectionDef = {
      idx: this.defs.length,
      name,
      role,
      startBeat: start,
      endBeat: start + bars * BEATS_PER_BAR,
      chapter,
      intensity: roleIntensity(role, chapter),
    };
    this.defs.push(def);
    this.cursor = def.endBeat;
  }
}
