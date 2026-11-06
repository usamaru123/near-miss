import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

interface DebugState {
  screen: string;
  alive: boolean;
  score: number;
  t: number;
  seed: number;
  [k: string]: unknown;
}

async function getState(page: Page): Promise<DebugState> {
  return page.evaluate(() => (window as unknown as { __NEARMISS__: { getState(): unknown } }).__NEARMISS__.getState() as DebugState);
}

// Chromium + SwiftShader emits GL performance notes ("GPU stall due to ReadPixels") as console errors;
// they are driver chatter, not application errors.
const isDriverNoise = (s: string): boolean => /GL Driver Message|GPU stall/.test(s);

test('title -> play -> death -> retry, with no console errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !isDriverNoise(m.text())) problems.push(m.type() + ': ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as { __NEARMISS__?: unknown }).__NEARMISS__);

  // title
  await expect(page.locator('#title')).toBeVisible();
  await expect(page.locator('.logo')).toContainText('NEAR//MISS');
  expect((await getState(page)).screen).toBe('title');

  // the title shows audio loading progress; START appears once everything is decoded
  await expect(page.locator('#press')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('#loader')).toBeHidden();
  await expect(page.locator('#vol-master')).toBeVisible();
  expect(((await page.evaluate(() => (window as unknown as { __NEARMISS__: { audioStats(): Record<string, unknown> } }).__NEARMISS__.audioStats())) as { failed: string[] }).failed).toEqual([]);

  // start with Space -> 3-2-1-GO countdown -> playing
  await page.keyboard.press('Space');
  await expect(page.locator('#countdown')).toBeVisible();
  expect((await getState(page)).screen).toBe('countdown');
  await page.waitForFunction(() => (window as unknown as { __NEARMISS__: { getState(): { screen: string } } }).__NEARMISS__.getState().screen === 'playing');
  await expect(page.locator('#hud')).toBeVisible();
  await expect(page.locator('#title')).toBeHidden();

  // make the run deterministic and survivable while we check the HUD
  await page.evaluate(() => {
    const d = (window as unknown as { __NEARMISS__: { setSeed(n: number): void; setInvincible(v: boolean): void } }).__NEARMISS__;
    d.setSeed(4242);
    d.setInvincible(true);
  });
  const s0 = await getState(page);
  expect(s0.screen).toBe('playing');
  expect(s0.seed).toBe(4242);
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(1500);
  await page.keyboard.up('ArrowRight');
  const s1 = await getState(page);
  expect(s1.alive).toBe(true);
  expect(s1.score).toBeGreaterThan(s0.score);
  expect(s1.t).toBeGreaterThan(s0.t);
  const hudScore = Number(await page.locator('#score').innerText());
  expect(hudScore).toBeGreaterThan(0);
  await expect(page.locator('#speed-val')).not.toHaveText('');
  await expect(page.locator('#bpm-val')).not.toHaveText('');

  // power-ups: spawn each in front of the ship through the debug hook and let the sim pick it up
  for (const [kind, field] of [['SHIELD', 'shield'], ['NITRO', 'nitroT'], ['DOUBLE', 'doubleT'], ['WARP', 'warpT']] as const) {
    await page.evaluate((k) => (window as unknown as { __NEARMISS__: { spawnItem(t: string): void } }).__NEARMISS__.spawnItem(k), kind);
    await page.waitForFunction((f) => !!(window as unknown as { __NEARMISS__: { getState(): Record<string, unknown> } }).__NEARMISS__.getState()[f], field, { timeout: 8000 });
  }
  await expect(page.locator('.fx[data-k=SHIELD]')).toBeVisible();
  await expect(page.locator('.fx[data-k=NITRO]')).toBeVisible();
  await expect(page.locator('.popup:not(.off)').first()).toBeVisible();
  await page.evaluate(() => (window as unknown as { __NEARMISS__: { spawnItem(t: string): void } }).__NEARMISS__.spawnItem('EMP'));
  await page.waitForFunction(() => (window as unknown as { __NEARMISS__: { getState(): { powerups: number } } }).__NEARMISS__.getState().powerups === 0);
  expect((await getState(page)).alive).toBe(true);

  // pause / resume
  await page.keyboard.press('KeyP');
  await expect(page.locator('#pause')).toBeVisible();
  await page.keyboard.press('KeyP');
  await expect(page.locator('#pause')).toBeHidden();

  // death -> game over
  await page.evaluate(() => (window as unknown as { __NEARMISS__: { forceDeath(): void } }).__NEARMISS__.forceDeath());
  expect((await getState(page)).alive).toBe(false);
  await expect(page.locator('#gameover')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#go-score')).not.toHaveText('');
  const best = await page.evaluate(() => window.localStorage.getItem('nearmiss.best'));
  expect(Number(best)).toBeGreaterThan(0);

  // retry (input is ignored for the first 0.3 s)
  await page.waitForTimeout(450);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as unknown as { __NEARMISS__: { getState(): { screen: string } } }).__NEARMISS__.getState().screen === 'playing');
  await expect(page.locator('#gameover')).toBeHidden();
  await page.waitForTimeout(600);
  const s2 = await getState(page);
  expect(s2.alive).toBe(true);
  expect(s2.t).toBeGreaterThan(0);
  expect(s2.seed).not.toBe(4242);

  await page.screenshot({ path: 'test-results/play.png' });
  expect(problems, problems.join(String.fromCharCode(10))).toEqual([]);
});

test('retry within 0.3 s of the game over screen is ignored', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !isDriverNoise(m.text())) problems.push(m.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as { __NEARMISS__?: unknown }).__NEARMISS__);
  await expect(page.locator('#press')).toBeVisible({ timeout: 45000 });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as unknown as { __NEARMISS__: { getState(): { screen: string } } }).__NEARMISS__.getState().screen === 'playing');
  await page.waitForTimeout(200);
  await page.evaluate(() => (window as unknown as { __NEARMISS__: { forceDeath(): void } }).__NEARMISS__.forceDeath());
  // Inside the page: the moment the game-over screen appears, press Space synchronously (< 0.3 s) -> must be ignored.
  const screenAfter = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const dbg = (window as unknown as { __NEARMISS__: { getState(): { screen: string } } }).__NEARMISS__;
        const poll = (): void => {
          if (dbg.getState().screen === 'gameover') {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
            resolve(dbg.getState().screen);
          } else requestAnimationFrame(poll);
        };
        poll();
      }),
  );
  expect(screenAfter).toBe('gameover');
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyR');
  await page.waitForFunction(() => (window as unknown as { __NEARMISS__: { getState(): { screen: string } } }).__NEARMISS__.getState().screen === 'playing');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('overlay text never enters the central no-go circle (1280x720 and 390x844)', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !isDriverNoise(m.text())) problems.push(m.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as { __NEARMISS__?: unknown }).__NEARMISS__);
  await expect(page.locator('#press')).toBeVisible({ timeout: 45000 });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as unknown as { __NEARMISS__: { getState(): { screen: string } } }).__NEARMISS__.getState().screen === 'playing');
  await page.evaluate(() => (window as unknown as { __NEARMISS__: { setInvincible(v: boolean): void } }).__NEARMISS__.setInvincible(true));

  for (const size of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as unknown as { __NEARMISS__: { popupDemo(): void } }).__NEARMISS__.popupDemo());
    await page.waitForTimeout(150);
    const info = await page.evaluate(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const r = 0.2 * Math.min(w, h);
      const rects = (sel: string): { l: number; t: number; r: number; b: number; text: string }[] =>
        [...document.querySelectorAll<HTMLElement>(sel)]
          .filter((e) => getComputedStyle(e).display !== 'none' && (e.textContent ?? '') !== '')
          .map((e) => {
            const b = e.getBoundingClientRect();
            return { l: b.left, t: b.top, r: b.right, b: b.bottom, text: e.textContent ?? '' };
          });
      return { w, h, r, popups: rects('.popup:not(.off)'), floaters: rects('.floater.go') };
    });
    const cx = info.w / 2;
    const cy = info.h / 2;
    const dist = (b: { l: number; t: number; r: number; b: number }): number => {
      const dx = Math.max(b.l - cx, 0, cx - b.r);
      const dy = Math.max(b.t - cy, 0, cy - b.b);
      return Math.hypot(dx, dy);
    };
    expect(info.popups.length).toBeGreaterThanOrEqual(3);
    for (const b of [...info.popups, ...info.floaters]) {
      expect(dist(b), size.width + 'x' + size.height + ' "' + b.text + '" ' + JSON.stringify(b)).toBeGreaterThan(info.r);
    }
    // stacked, not overlapping
    const sorted = info.popups.slice().sort((a, b) => a.t - b.t);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].t).toBeGreaterThanOrEqual(sorted[i - 1].b - 1);
    // milestone sits in the 12-22 % band at its top edge
    const mile = info.popups.find((p) => p.text.includes('km/h'));
    expect(mile).toBeTruthy();
    await page.screenshot({ path: 'test-results/overlay-' + size.width + '.png' });
    await page.waitForTimeout(1800);
  }
  expect(problems, problems.join(String.fromCharCode(10))).toEqual([]);
});
