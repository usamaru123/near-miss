import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { boot, dbg, layoutProblems, startRun, state, waitFor, watchConsole } from './helpers';
import type { Win } from './helpers';

/**
 * Style rank + ZONE (DESIGN 18.4). Runs on the desktop project and on all four mobile projects:
 * rank-up -> ZONE -> CLEAR / BREAK / LOST with a clean console, ZONE text clear of the central no-go circle and of
 * the touch buttons, and screenshots in test-results/zone/.
 */

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
  // pin the combo for the whole script: the steps below take longer than the 3 s combo timer on a loaded machine, and a
  // combo break while the ZONE runs ends it as a BREAK (half pay) before the CLEAR step gets to ask for a CLEAR
  await dbg(page, 'holdCombo', true);
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
  expect((await state(page)).zone).toBe(true); // still running: nothing may have ended it behind our back
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
  await dbg(page, 'holdCombo', true);
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
