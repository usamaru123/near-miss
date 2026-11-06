import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Style rank + ZONE (DESIGN 18.4). Runs on the desktop project and on all four mobile projects:
 * rank-up -> ZONE -> CLEAR / BREAK / LOST with a clean console, ZONE text clear of the central no-go circle and of
 * the touch buttons, and screenshots in test-results/zone/.
 */

interface Dbg {
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
  setScore(n: number): void;
  spawnItem(t: string): void;
}
type Win = { __NEARMISS__: Dbg };
type State = {
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
const state = (page: Page): Promise<State> => page.evaluate(() => (window as unknown as Win).__NEARMISS__.getState() as State);
const dbg = <T extends keyof Dbg>(page: Page, fn: T, ...args: Parameters<Dbg[T]>): Promise<void> =>
  page.evaluate(([f, a]) => ((window as unknown as Win).__NEARMISS__[f as keyof Dbg] as (...x: unknown[]) => void)(...(a as unknown[])), [fn, args] as const);

// Chromium + SwiftShader emits GL performance notes as console errors; they are driver chatter.
const isDriverNoise = (s: string): boolean => /GL Driver Message|GPU stall/.test(s);

function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !isDriverNoise(m.text())) problems.push(m.type() + ': ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  return problems;
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as { __NEARMISS__?: unknown }).__NEARMISS__);
  await expect(page.locator('#press')).toBeVisible({ timeout: 45000 });
}

async function startRun(page: Page): Promise<void> {
  const vp = page.viewportSize() as { width: number; height: number };
  if ((await state(page)).inputMode === 'touch') await page.touchscreen.tap(Math.round(vp.width / 2), Math.round(vp.height * 0.3));
  else await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as unknown as Win).__NEARMISS__.getState().screen === 'playing', null, { timeout: 30000 });
  await dbg(page, 'setSeed', 4242);
  await dbg(page, 'setInvincible', true);
  await page.waitForTimeout(500);
}

const waitFor = (page: Page, expr: string, timeout = 15000): Promise<unknown> =>
  page.waitForFunction((e) => new Function('s', 'return (' + e + ')')((window as unknown as Win).__NEARMISS__.getState()), expr, { timeout });

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
  text: string;
  sel: string;
  dbg?: string;
}

/** Rects of the ZONE / rank text and the fixed touch UI; returns human-readable problems. */
async function layoutProblems(page: Page, what: string): Promise<string[]> {
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

const shot = (page: Page, info: TestInfo, name: string): Promise<Buffer> =>
  page.screenshot({ path: 'test-results/zone/' + info.project.name + '-' + name + '.png' });

test('rank-up -> ZONE -> CLEAR / BREAK / LOST: effects run clean, text stays out of the no-go zone and clear of the buttons', async ({ page }, info) => {
  const problems = watchConsole(page);
  await boot(page);
  const touch = (await state(page)).inputMode === 'touch';
  if (!touch) await page.setViewportSize({ width: 1280, height: 720 });
  await startRun(page);
  const vp = page.viewportSize() as { width: number; height: number };

  // ---- rank meter: D -> C -> S ----
  expect((await state(page)).rank).toBe(0);
  await expect(page.locator('#rank-letter')).toHaveText('D');
  await dbg(page, 'setStyle', 120);
  await expect(page.locator('#rank-letter')).toHaveText('C');
  await dbg(page, 'setStyle', 720);
  await expect(page.locator('#rank-letter')).toHaveText('S');
  expect((await state(page)).rank).toBe(4);
  await page.waitForTimeout(250);
  await shot(page, info, 'rank-meter-S');
  await dbg(page, 'setStyle', 1010);
  await expect(page.locator('#rank-letter')).toHaveText('SS');
  await dbg(page, 'setStyle', 1500);
  await expect(page.locator('#rank-letter')).toHaveText('SSS');
  expect((await state(page)).maxRank).toBe(6);

  // ---- multiplier chain: combo x rank x DOUBLE passes x10, factors pop in ----
  await dbg(page, 'setCombo', 12); // x4
  await dbg(page, 'spawnItem', 'DOUBLE');
  await waitFor(page, 's.doubleT > 0');
  await dbg(page, 'setStyle', 1500);
  await expect(page.locator('#chain')).toBeVisible();
  await expect(page.locator('#chain')).toContainText('×4');
  await expect(page.locator('#chain')).toContainText('×3');
  await expect(page.locator('#chain')).toContainText('= ×24');
  await page.waitForTimeout(500); // the pop-up column re-fits under the taller left column a frame or two later
  expect(await layoutProblems(page, 'chain')).toEqual([]);
  await page.waitForTimeout(250);
  await shot(page, info, 'multiplier-chain');

  // ---- ZONE entry ----
  await dbg(page, 'forceZone');
  await waitFor(page, 's.zone === true');
  await expect(page.locator('.popup.zone:not(.off)')).toBeVisible();
  // the title slams in from 2.6x on purpose: measure once that animation is past its first 0.4 s (software GL frames can lag behind wall time)
  await page.waitForFunction(() => {
    const a = document.querySelector('.popup.zone')?.getAnimations().find((x) => (x as CSSAnimation).animationName === 'zonein');
    return !!a && Number(a.currentTime) > 400;
  }, null, { timeout: 15000 });
  expect(await layoutProblems(page, 'zone-entry')).toEqual([]);
  await shot(page, info, 'zone-entry');
  await waitFor(page, 's.zoneBank > 0');
  await page.waitForFunction(() => (window as unknown as Win).__NEARMISS__.getView().zoneAmount === 1, null, { timeout: 10000 });
  // a big number in the BANK (the real one grows with the running score and compounds on every beat)
  await dbg(page, 'addBank', 123456789);
  await dbg(page, 'setStyle', 1500);
  await page.waitForTimeout(1500);
  await expect(page.locator('#zone-hud')).toBeVisible();
  await expect(page.locator('#zone-bank')).toContainText(/M|B/);
  expect(await layoutProblems(page, 'zone-active')).toEqual([]);
  await shot(page, info, 'zone-active-bank');
  const z = await state(page);
  expect(z.zoneLv).toBe(1);
  expect(z.rank).toBeGreaterThanOrEqual(5); // SSS decays at 110 / s: SS (still a ZONE) after a couple of seconds

  // ---- CLEAR: the rank falls to S or below -> the whole BANK is paid ----
  const before = (await state(page)).scoreExact;
  const bank = (await state(page)).zoneBank;
  // a slow (software GL) run can outlast the 3 s combo timer, and a combo break would end the ZONE as a BREAK instead
  await dbg(page, 'setCombo', 12);
  await dbg(page, 'setStyle', 100);
  await waitFor(page, 's.zone === false');
  await page.waitForFunction(() => !!document.querySelector('.popup.zoneclear:not(.off)'), null, { timeout: 8000 }).catch(async () => {
    throw new Error('no ZONE CLEAR pop-up; pop-ups: ' + (await page.evaluate(() => [...document.querySelectorAll('.popup')].map((e) => e.className + ':' + e.textContent).join(' | '))));
  });
  await page.waitForTimeout(500);
  expect(await layoutProblems(page, 'zone-clear')).toEqual([]);
  await shot(page, info, 'zone-clear');
  const after = (await state(page)).scoreExact;
  expect(after - before).toBeGreaterThanOrEqual(bank * 0.99);
  await page.waitForTimeout(1600);

  // ---- BREAK: a combo break pays half and cracks the screen edges ----
  await dbg(page, 'setStyle', 1500);
  await dbg(page, 'setCombo', 5);
  await dbg(page, 'forceZone');
  await waitFor(page, 's.zone === true');
  await page.waitForTimeout(800);
  await dbg(page, 'setStyle', 1500);
  await dbg(page, 'addBank', 5000000);
  const b0 = await state(page);
  await dbg(page, 'expireCombo');
  await waitFor(page, 's.zone === false');
  const b1 = await state(page);
  expect(b1.scoreExact - b0.scoreExact).toBeGreaterThan(b0.zoneBank * 0.45);
  expect(b1.scoreExact - b0.scoreExact).toBeLessThan(b0.zoneBank * 0.6);
  await expect(page.locator('.popup.zonebreak:not(.off)')).toBeVisible();
  await expect(page.locator('#break-glass.go')).toHaveCount(1);
  await page.waitForTimeout(250);
  expect(await layoutProblems(page, 'zone-break')).toEqual([]);
  await shot(page, info, 'zone-break');
  await page.waitForTimeout(1800);

  // ---- LOST: dying inside a ZONE forfeits the BANK ----
  await dbg(page, 'setStyle', 1500);
  await dbg(page, 'forceZone');
  await waitFor(page, 's.zone === true');
  await page.waitForTimeout(600);
  await dbg(page, 'addBank', 7777777);
  const s0 = (await state(page)).scoreExact;
  await dbg(page, 'forceDeath');
  await expect(page.locator('.popup.zonebreak:not(.off)')).toBeVisible();
  await expect(page.locator('#gameover')).toBeVisible({ timeout: 30000 });
  const dead = await state(page);
  expect(dead.scoreExact).toBe(s0); // the BANK never reached the score
  expect(dead.zoneLost).toBeGreaterThan(7000000);
  await expect(page.locator('#go-lost')).toBeVisible();
  await expect(page.locator('#go-lost')).toContainText('LOST');
  await expect(page.locator('#go-lost-n')).toContainText(/M|B/);
  // the card fits the viewport (landscape phones are the tight case)
  const overflow = await page.evaluate(() => {
    const bad: string[] = [];
    for (const e of document.querySelectorAll<HTMLElement>('#gameover > *')) {
      if (getComputedStyle(e).display === 'none') continue;
      const b = e.getBoundingClientRect();
      if (b.left < -0.5 || b.right > window.innerWidth + 0.5 || b.top < -0.5 || b.bottom > window.innerHeight + 0.5) bad.push(e.className + '#' + e.id + ' ' + JSON.stringify(b));
    }
    return bad;
  });
  expect(overflow).toEqual([]);
  await page.waitForTimeout(900);
  await shot(page, info, 'zone-lost-gameover');
  void vp;
  expect(problems, problems.join('\n')).toEqual([]);
});

test('numbers: milestone banner, units and full digits, huge scores keep working', async ({ page }, info) => {
  const problems = watchConsole(page);
  await boot(page);
  await startRun(page);
  // 10^5, 10^6 ... announced once each (jumping over several at once announces each)
  await dbg(page, 'setScore', 99990);
  await page.waitForTimeout(400);
  await dbg(page, 'setScore', 1e6 + 5);
  await expect(page.locator('.popup.scorebanner:not(.off)').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#score')).toContainText(/M|\d/, { timeout: 10000 });
  await dbg(page, 'setScore', 3.5e17);
  await expect(page.locator('#score')).toHaveText(/^350Qa$/, { timeout: 10000 });
  await dbg(page, 'setScore', 4.2e22); // far beyond 2^53
  await expect(page.locator('#score')).toHaveText(/Qi$/, { timeout: 10000 });
  // the score swells (x1.2) when a power of ten passes: measure after that animation, like a player would read it
  await page.waitForFunction(() => document.getElementById('score')?.getAnimations().length === 0, null, { timeout: 15000 });
  await page.waitForTimeout(350);
  expect(await layoutProblems(page, 'numbers')).toEqual([]);
  await shot(page, info, 'big-numbers');
  await dbg(page, 'forceDeath');
  await expect(page.locator('#gameover')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#go-full')).toBeVisible();
  await expect(page.locator('#go-full')).toContainText('42,000,000,000,000,000,000,000');
  expect(Number(await page.evaluate(() => window.localStorage.getItem('nearmiss.best')))).toBeGreaterThan(1e22);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('reduced flash: no white flash on ZONE entry, the palette fades instead of snapping', async ({ page }) => {
  const problems = watchConsole(page);
  await page.addInitScript(() => window.localStorage.setItem('nearmiss.reducedFlash', '1'));
  await boot(page);
  await startRun(page);
  await page.waitForTimeout(800);
  const flashWrites = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const el = document.getElementById('flash') as HTMLElement;
        let n = 0;
        const mo = new MutationObserver((m) => (n += m.length));
        mo.observe(el, { attributes: true });
        (window as unknown as Win).__NEARMISS__.setStyle(1500);
        (window as unknown as Win).__NEARMISS__.forceZone();
        window.setTimeout(() => {
          mo.disconnect();
          resolve(n);
        }, 400);
      }),
  );
  expect(flashWrites).toBe(0);
  await waitFor(page, 's.zone === true');
  await page.waitForFunction(() => (window as unknown as Win).__NEARMISS__.getView().zoneAmount === 1, null, { timeout: 15000 });
  expect(problems, problems.join('\n')).toEqual([]);
});
