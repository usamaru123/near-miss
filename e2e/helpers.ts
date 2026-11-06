import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Shared helpers of the e2e specs that drive the game through window.__NEARMISS__. */

export interface Dbg {
  getState(): Record<string, unknown>;
  getView(): Record<string, unknown>;
  setSeed(n: number): void;
  setInvincible(v: boolean): void;
  setStyle(n: number): void;
  forceZone(): void;
  forceDeath(): void;
  addBank(n: number): void;
  setCombo(n: number): void;
  expireCombo(): void;
  holdCombo(on: boolean): void;
  setScore(n: number): void;
  spawnItem(t: string): void;
  setBiome(n: number): void;
  forceSection(name: string): void;
  warpTo(n: number): void;
  popupDemo(): void;
}
export type Win = { __NEARMISS__: Dbg };
export type State = {
  screen: string;
  alive: boolean;
  rank: number;
  maxRank: number;
  zone: boolean;
  zoneLv: number;
  zoneBank: number;
  zoneLost: number;
  scoreExact: number;
  inputMode: string;
  [k: string]: unknown;
};
export const state = (page: Page): Promise<State> => page.evaluate(() => (window as unknown as Win).__NEARMISS__.getState() as State);
export const dbg = <T extends keyof Dbg>(page: Page, fn: T, ...args: Parameters<Dbg[T]>): Promise<void> =>
  page.evaluate(([f, a]) => ((window as unknown as Win).__NEARMISS__[f as keyof Dbg] as (...x: unknown[]) => void)(...(a as unknown[])), [fn, args] as const);

// Chromium + SwiftShader emits GL performance notes as console errors; they are driver chatter.
export const isDriverNoise = (s: string): boolean => /GL Driver Message|GPU stall/.test(s);

export function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !isDriverNoise(m.text())) problems.push(m.type() + ': ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  return problems;
}

export async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as { __NEARMISS__?: unknown }).__NEARMISS__);
  await expect(page.locator('#press')).toBeVisible({ timeout: 45000 });
}

export async function startRun(page: Page): Promise<void> {
  const vp = page.viewportSize() as { width: number; height: number };
  if ((await state(page)).inputMode === 'touch') await page.touchscreen.tap(Math.round(vp.width / 2), Math.round(vp.height * 0.3));
  else await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as unknown as Win).__NEARMISS__.getState().screen === 'playing', null, { timeout: 30000 });
  await dbg(page, 'setSeed', 4242);
  await dbg(page, 'setInvincible', true);
  await page.waitForTimeout(500);
}

export const waitFor = (page: Page, expr: string, timeout = 15000): Promise<unknown> =>
  page.waitForFunction((e) => new Function('s', 'return (' + e + ')')((window as unknown as Win).__NEARMISS__.getState()), expr, { timeout });

export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
  text: string;
  sel: string;
  dbg?: string;
}

/** Rects of the ZONE / rank text and the fixed touch UI; returns human-readable problems. */
export async function layoutProblems(page: Page, what: string): Promise<string[]> {
  // Pop-ups start with a small lift + 1.1x scale for the first ~12 % of their animation (the ZONE title slams in from 2.6x).
  // A fixed sleep is not enough on a loaded machine: a software-GL frame can take longer than the sleep, so the animation is
  // still at its first keyframe when the rect is read. Wait on the animations themselves (document timeline, not wall sleeps).
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.popup:not(.off)')].every((p) =>
        p.getAnimations().every((an) => {
          const d = Number((an.effect as AnimationEffect | null)?.getTiming().duration ?? 0);
          return an.playState === 'finished' || (!an.pending && Number(an.currentTime) >= 0.25 * d);
        }),
      ),
    null,
    { timeout: 15000 },
  );
  return page.evaluate((label) => {
    const out: string[] = [];
    const w = window.innerWidth;
    const h = window.innerHeight;
    const box = (e: Element, sel: string): Box | null => {
      const he = e as HTMLElement;
      const cs = getComputedStyle(he);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      const b = he.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return null;
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, text: (he.textContent ?? '').trim().slice(0, 24), sel, dbg: cs.animationName + ' ' + cs.fontSize + ' ' + cs.transform + ' ' + cs.letterSpacing + ' ' + he.className } as Box;
    };
    const all = (sel: string): Box[] => [...document.querySelectorAll(sel)].map((e) => box(e, sel)).filter((x): x is Box => !!x);
    const texts: Box[] = [
      ...all('.popup:not(.off)'),
      ...all('.floater.go'),
      ...all('#rank-box'),
      ...all('#chain:not(.hidden)'),
      ...all('#zone-hud:not(.hidden)'),
      ...all('#pace:not(.hidden)'),
      ...all('#score'),
      ...all('#mult-row'),
    ];
    const fixed: Box[] = [...all('#pause-btn'), ...all('#od-btn'), ...all('#focus-btn'), ...all('#hud-bottom'), ...all('#hud-right')];
    const cx = w / 2;
    const cy = h / 2;
    const rad = 0.2 * Math.min(w, h);
    const dist = (b: Box): number => Math.hypot(Math.max(b.l - cx, 0, cx - b.r), Math.max(b.t - cy, 0, cy - b.b));
    const hit = (a: Box, b: Box): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    for (const b of texts) {
      if (dist(b) <= rad) out.push(label + ': ' + b.sel + ' "' + b.text + '" enters the no-go circle (' + Math.round(dist(b)) + ' <= ' + Math.round(rad) + ')');
      if (b.l < -0.5 || b.r > w + 0.5 || b.t < -0.5 || b.b > h + 0.5) out.push(label + ': ' + b.sel + ' "' + b.text + '" outside the viewport');
      for (const f of fixed) {
        // the ship floaters sit just under the ship, i.e. above the gauge on short screens: buttons only
        if (b.sel === '.floater.go' && f.sel === '#hud-bottom') continue;
        if (hit(b, f)) out.push(label + ': ' + b.sel + ' "' + b.text + '" overlaps ' + f.sel + ' ' + JSON.stringify(b) + JSON.stringify(f));
      }
    }
    // the stacked popups never overlap each other, and never overlap the left column's rank / ZONE blocks
    const pops = texts.filter((b) => b.sel === '.popup:not(.off)').sort((a, b) => a.t - b.t);
    for (let i = 1; i < pops.length; i++) if (pops[i].t < pops[i - 1].b - 8) out.push(label + ': popups overlap "' + pops[i - 1].text + '" / "' + pops[i].text + '"');
    const left = texts.filter((b) => ['#rank-box', '#chain:not(.hidden)', '#zone-hud:not(.hidden)', '#score', '#mult-row'].includes(b.sel));
    for (const p of pops) for (const l of left) if (hit(p, l)) out.push(label + ': popup "' + p.text + '" overlaps ' + l.sel);
    // left column vs gauges / buttons (whole column)
    const col = all('#hud-left')[0];
    if (col) for (const f of fixed) if (hit(col, f)) out.push(label + ': #hud-left overlaps ' + f.sel);
    return out;
  }, what);
}

