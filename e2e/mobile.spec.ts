import { expect, test } from '@playwright/test';
import type { CDPSession, Page, TestInfo } from '@playwright/test';

/**
 * Mobile e2e (DESIGN 17.7). Runs in the iPhone 15 Pro (portrait / landscape) and Pixel 7 projects.
 * 1. touch-driven smoke test   2. layout test (+ screenshots in test-results/mobile/)
 */

interface Dbg {
  getState(): Record<string, unknown>;
  getView(): Record<string, unknown>;
  setSeed(n: number): void;
  setInvincible(v: boolean): void;
  fillAdrenaline(): void;
  forceDeath(): void;
  popupDemo(): void;
  setQualityTier(n: number): void;
}
type Win = { __NEARMISS__: Dbg };
type State = { screen: string; theta: number; focusActive: boolean; overdrive: boolean; inputMode: string; qualityTier: number; [k: string]: unknown };
const state = (page: Page): Promise<State> => page.evaluate(() => (window as unknown as Win).__NEARMISS__.getState() as State);
const view = (page: Page): Promise<Record<string, number>> => page.evaluate(() => (window as unknown as Win).__NEARMISS__.getView() as Record<string, number>);

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

async function center(page: Page, sel: string): Promise<{ x: number; y: number }> {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error('no box for ' + sel);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Real multi-finger touch input through CDP (Playwright's touchscreen only taps). */
class Fingers {
  private readonly pts = new Map<number, { x: number; y: number }>();
  constructor(private readonly cdp: CDPSession) {}
  private send(type: 'touchStart' | 'touchEnd'): Promise<unknown> {
    const touchPoints = [...this.pts.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id }));
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  }
  async down(id: number, x: number, y: number): Promise<void> {
    this.pts.set(id, { x, y });
    await this.send('touchStart');
  }
  async up(id: number): Promise<void> {
    this.pts.delete(id);
    await this.send('touchEnd');
  }
}

async function startRun(page: Page): Promise<void> {
  const vp = page.viewportSize() as { width: number; height: number };
  await page.touchscreen.tap(Math.round(vp.width / 2), Math.round(vp.height * 0.3));
  await page.waitForFunction(() => (window as unknown as Win).__NEARMISS__.getState().screen === 'playing', null, { timeout: 30000 });
  await page.evaluate(() => {
    const d = (window as unknown as Win).__NEARMISS__;
    d.setSeed(4242);
    d.setInvincible(true);
  });
}

test('touch: tap to start, steer, FOCUS hold, OVERDRIVE button, pause button, resume', async ({ page, context }) => {
  const problems = watchConsole(page);
  await boot(page);
  const vp = page.viewportSize() as { width: number; height: number };
  const f = new Fingers(await context.newCDPSession(page));

  // touch wording on the title, no key names
  expect((await state(page)).inputMode).toBe('touch');
  await expect(page.locator('#press')).toHaveText('TAP TO START', { useInnerText: true });

  await startRun(page);
  expect((await state(page)).screen).toBe('playing');
  // a spurious window 'blur' (iOS long-press / system gestures) must NOT pause (DESIGN 17.4)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(200);
  expect((await state(page)).screen).toBe('playing');

  // steering: hold the left half, then the right half; theta moves in opposite directions
  const y = Math.round(vp.height * 0.45);
  // (hold until theta has really moved: slow software-GL frames make the sim run slower than real time)
  const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
  const holdUntilMoved = async (id: number, x: number): Promise<number> => {
    const from = (await state(page)).theta;
    await f.down(id, x, y);
    await page.waitForFunction((t0) => {
      const t = (window as unknown as Win).__NEARMISS__.getState().theta as number;
      return Math.abs(Math.atan2(Math.sin(t - t0), Math.cos(t - t0))) > 0.15;
    }, from, { timeout: 20000 });
    const d = wrap((await state(page)).theta - from);
    await f.up(id);
    await page.waitForTimeout(900); // let the angular velocity settle
    return d;
  };
  const dLeft = await holdUntilMoved(1, Math.round(vp.width * 0.2));
  const dRight = await holdUntilMoved(2, Math.round(vp.width * 0.8));
  expect(Math.sign(dLeft)).toBe(-Math.sign(dRight));

  // FOCUS: a finger held on the button; a second finger steering must not count as the 2-finger OVERDRIVE
  await page.evaluate(() => (window as unknown as Win).__NEARMISS__.fillAdrenaline());
  const fb = await center(page, '#focus-btn');
  await f.down(3, fb.x, fb.y);
  await page.waitForFunction(() => (window as unknown as Win).__NEARMISS__.getState().focusActive === true, null, { timeout: 5000 });
  await f.down(4, Math.round(vp.width * 0.15), y);
  const th3 = (await state(page)).theta;
  // steering still works while FOCUS is held (slow motion: small but non-zero movement)
  await page.waitForFunction((t0) => {
    const t = (window as unknown as Win).__NEARMISS__.getState().theta as number;
    return Math.abs(Math.atan2(Math.sin(t - t0), Math.cos(t - t0))) > 0.003;
  }, th3, { timeout: 20000 });
  const s3 = await state(page);
  expect(s3.focusActive).toBe(true);
  expect(s3.overdrive).toBe(false);
  await f.up(4);
  await f.up(3);
  await page.waitForFunction(() => (window as unknown as Win).__NEARMISS__.getState().focusActive === false, null, { timeout: 5000 });

  // OVERDRIVE: the button lights up when the gauge is full and a tap fires it
  await page.evaluate(() => (window as unknown as Win).__NEARMISS__.fillAdrenaline());
  await expect(page.locator('#od-btn.ready')).toBeVisible();
  const ob = await center(page, '#od-btn');
  await page.touchscreen.tap(ob.x, ob.y);
  await page.waitForFunction(() => (window as unknown as Win).__NEARMISS__.getState().overdrive === true, null, { timeout: 5000 });

  // pause button -> PAUSED with touch wording -> a deliberate tap resumes
  const pb = await center(page, '#pause-btn');
  await page.touchscreen.tap(pb.x, pb.y);
  await expect(page.locator('#pause')).toBeVisible();
  expect((await state(page)).screen).toBe('paused');
  await expect(page.locator('#pause .press')).toHaveText('TAP TO RESUME', { useInnerText: true });
  await page.waitForTimeout(500);
  await page.touchscreen.tap(Math.round(vp.width / 2), Math.round(vp.height / 2));
  await expect(page.locator('#pause')).toBeHidden();
  expect((await state(page)).screen).toBe('playing');

  // real backgrounding (visibilitychange -> hidden) pauses; it never resumes by itself
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect((await state(page)).screen).toBe('paused');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(500);
  expect((await state(page)).screen).toBe('paused');
  await page.touchscreen.tap(Math.round(vp.width / 2), Math.round(vp.height / 2));
  expect((await state(page)).screen).toBe('playing');
  await page.waitForTimeout(600);

  // adaptive quality exposes its tier on the debug hook and applies it
  const dpr0 = (await view(page)).dpr;
  await page.evaluate(() => (window as unknown as Win).__NEARMISS__.setQualityTier(3));
  expect((await state(page)).qualityTier).toBe(3);
  expect((await view(page)).dpr).toBeLessThanOrEqual(1);
  expect(dpr0).toBeGreaterThan(1);
  await page.evaluate(() => (window as unknown as Win).__NEARMISS__.setQualityTier(0));

  expect(problems, problems.join('\n')).toEqual([]);
});

interface Insets { t: number; r: number; b: number; l: number }

/** All HUD / button layout checks for the playing screen; returns human-readable problems. */
async function measure(page: Page, insets: Insets): Promise<string[]> {
  return page.evaluate((ins) => {
    type Rect = { l: number; t: number; r: number; b: number };
    const out: string[] = [];
    const w = window.innerWidth;
    const h = window.innerHeight;
    const rect = (sel: string): Rect | null => {
      const e = document.querySelector<HTMLElement>(sel);
      if (!e || getComputedStyle(e).display === 'none') return null;
      const b = e.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return null;
      return { l: b.left, t: b.top, r: b.right, b: b.bottom };
    };
    const names: Record<string, string> = {
      hudLeft: '#hud-left', hudRight: '#hud-right', speed: '#speed', heart: '#heart-row', effects: '#effects',
      pause: '#pause-btn', od: '#od-btn', focus: '#focus-btn', adr: '#adr-bar', focusBar: '#focus-bar', caption: '.bar-caption', gauge: '#hud-bottom',
    };
    const R: Record<string, Rect> = {};
    for (const [k, sel] of Object.entries(names)) {
      const r = rect(sel);
      if (r) R[k] = r;
    }
    // inside the viewport and the safe area
    for (const [k, r] of Object.entries(R)) {
      if (r.l < ins.l - 0.5 || r.t < ins.t - 0.5 || r.r > w - ins.r + 0.5 || r.b > h - ins.b + 0.5) {
        out.push(k + ' outside safe area ' + JSON.stringify(r) + ' in ' + w + 'x' + h + ' ' + JSON.stringify(ins));
      }
    }
    const hit = (a: Rect, b: Rect): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    const groups = ['hudLeft', 'hudRight', 'pause', 'od', 'focus', 'gauge'];
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = R[groups[i]];
        const b = R[groups[j]];
        if (a && b && hit(a, b)) out.push(groups[i] + ' overlaps ' + groups[j]);
      }
    }
    // the speedometer must be clear of the heart/BPM line, the effect icons and the pause button
    for (const [a, b] of [['speed', 'heart'], ['speed', 'effects'], ['speed', 'pause'], ['heart', 'effects'], ['effects', 'pause'], ['heart', 'pause']]) {
      if (R[a] && R[b] && hit(R[a], R[b])) out.push(a + ' overlaps ' + b);
    }
    for (const a of ['od', 'focus']) for (const b of ['adr', 'focusBar', 'caption']) if (R[a] && R[b] && hit(R[a], R[b])) out.push(a + ' overlaps gauge part ' + b);
    // touch targets >= 56 px
    for (const k of ['pause', 'od', 'focus']) {
      const r = R[k];
      if (!r) out.push(k + ' button not visible');
      else if (r.r - r.l < 56 || r.b - r.t < 56) out.push(k + ' button smaller than 56px: ' + (r.r - r.l) + 'x' + (r.b - r.t));
    }
    // central no-go zone: circle of 40 % of the short side
    const cx = w / 2;
    const cy = h / 2;
    const rad = 0.2 * Math.min(w, h);
    const dist = (b: Rect): number => Math.hypot(Math.max(b.l - cx, 0, cx - b.r), Math.max(b.t - cy, 0, cy - b.b));
    for (const k of ['hudLeft', 'hudRight', 'pause', 'od', 'focus', 'gauge']) if (R[k] && dist(R[k]) <= rad) out.push(k + ' enters the no-go zone');
    const sp = document.getElementById('speed-val');
    if (sp && parseFloat(getComputedStyle(sp).fontSize) < 30) out.push('speedometer digits too small: ' + getComputedStyle(sp).fontSize);
    return out;
  }, insets);
}

/** Every direct child of a screen fits inside the viewport. */
async function screenFits(page: Page, sel: string): Promise<string[]> {
  return page.evaluate((s) => {
    const bad: string[] = [];
    for (const e of document.querySelectorAll<HTMLElement>(s + ' > *')) {
      if (getComputedStyle(e).display === 'none') continue;
      const b = e.getBoundingClientRect();
      if (b.left < -0.5 || b.right > window.innerWidth + 0.5 || b.top < -0.5 || b.bottom > window.innerHeight + 0.5) bad.push(e.className + '#' + e.id + ' ' + JSON.stringify(b));
    }
    return bad;
  }, sel);
}

test('layout: inside the viewport, no overlaps, no-go zone, 56px targets, no key names, ship size', async ({ page }, testInfo: TestInfo) => {
  const problems = watchConsole(page);
  await boot(page);
  const name = testInfo.project.name;
  const shot = (s: string): Promise<Buffer> => page.screenshot({ path: 'test-results/mobile/' + name + '-' + s + '.png' });
  const keyNames = async (): Promise<string[]> => (await page.evaluate(() => document.body.innerText)).match(/\b(SHIFT|SPACE|ESC|P)\b|\[SHIFT\]/g) ?? [];
  const noScroll = async (): Promise<void> => {
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, sh: document.documentElement.scrollHeight, w: window.innerWidth, h: window.innerHeight }));
    expect(m.sw).toBeLessThanOrEqual(m.w);
    expect(m.bw).toBeLessThanOrEqual(m.w);
    expect(m.sh).toBeLessThanOrEqual(m.h);
  };
  const isIphone = /iPhone/.test(await page.evaluate(() => navigator.userAgent));
  const vp = page.viewportSize() as { width: number; height: number };
  const portrait = vp.height > vp.width;

  // ---- title ----
  expect((await state(page)).inputMode).toBe('touch');
  expect(await keyNames()).toEqual([]);
  await noScroll();
  // iOS Safari tab: "Add to Home Screen" hint (not on Android)
  if (isIphone) await expect(page.locator('#a2hs')).toBeVisible();
  else await expect(page.locator('#a2hs')).toBeHidden();
  expect(await screenFits(page, '#title')).toEqual([]);
  await shot('title');

  // ---- playing ----
  await startRun(page);
  await page.waitForTimeout(800);
  // worst case for the layout: every effect icon, the PB line and the OVERDRIVE label visible at once
  await page.evaluate(() => {
    for (const e of document.querySelectorAll('.fx')) e.classList.remove('hidden');
    const p = document.getElementById('pace');
    if (p) {
      p.classList.remove('hidden');
      p.textContent = 'PB +12,345';
    }
    const sp = document.getElementById('speed-val');
    if (sp) sp.textContent = '1000';
    document.getElementById('od-label')?.classList.add('show');
  });
  expect(await measure(page, { t: 0, r: 0, b: 0, l: 0 })).toEqual([]);
  // simulated notch / home indicator: same checks inside the safe area (env() cannot be emulated in a desktop browser)
  const ins: Insets = portrait ? { t: 59, r: 0, b: 34, l: 0 } : { t: 0, r: 59, b: 21, l: 59 };
  await page.addStyleTag({ content: ':root{--sa-t:' + ins.t + 'px;--sa-r:' + ins.r + 'px;--sa-b:' + ins.b + 'px;--sa-l:' + ins.l + 'px}' });
  expect(await measure(page, ins)).toEqual([]);
  await shot('playing-safe-area');
  await page.addStyleTag({ content: ':root{--sa-t:0px;--sa-r:0px;--sa-b:0px;--sa-l:0px}' });
  expect(await keyNames()).toEqual([]);
  await noScroll();

  // camera: horizontal FOV >= 72 deg on portrait, vertical <= 118 deg, ship <= 12 % of the short side
  const v = await view(page);
  expect(v.width).toBe(vp.width);
  if (portrait) {
    expect(v.hfovBase).toBeGreaterThanOrEqual(71.5);
    expect(v.fovBase).toBeLessThanOrEqual(118);
  }
  expect(v.shipFraction).toBeLessThanOrEqual(0.12);
  expect(v.shipFraction).toBeGreaterThan(0.01);

  // popups / floaters stay out of the central no-go circle (DESIGN 14) and clear of the buttons and gauges
  await page.evaluate(() => (window as unknown as Win).__NEARMISS__.popupDemo());
  await page.waitForTimeout(250);
  const pop = await page.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const rects = (sel: string): { l: number; t: number; r: number; b: number; text: string }[] =>
      [...document.querySelectorAll<HTMLElement>(sel)]
        .filter((e) => getComputedStyle(e).display !== 'none' && (e.textContent ?? '') !== '')
        .map((e) => {
          const b = e.getBoundingClientRect();
          return { l: b.left, t: b.top, r: b.right, b: b.bottom, text: e.textContent ?? '' };
        });
    const fixed = ['#pause-btn', '#od-btn', '#focus-btn', '#hud-bottom'].map((s) => {
      const b = (document.querySelector(s) as HTMLElement).getBoundingClientRect();
      return { s, l: b.left, t: b.top, r: b.right, b: b.bottom };
    });
    return { w, h, r: 0.2 * Math.min(w, h), items: [...rects('.popup:not(.off)').map((r) => ({ ...r, floater: false })), ...rects('.floater.go').map((r) => ({ ...r, floater: true }))], fixed };
  });
  expect(pop.items.length).toBeGreaterThanOrEqual(3);
  for (const b of pop.items) {
    const dx = Math.max(b.l - pop.w / 2, 0, pop.w / 2 - b.r);
    const dy = Math.max(b.t - pop.h / 2, 0, pop.h / 2 - b.b);
    expect(Math.hypot(dx, dy), 'no-go: "' + b.text + '" ' + JSON.stringify(b)).toBeGreaterThan(pop.r);
    for (const fx of pop.fixed) {
      // floaters sit just below the ship, which on a short landscape screen is right above the gauge: only buttons are checked for them
      if (b.floater && fx.s === '#hud-bottom') continue;
      expect(b.l < fx.r && fx.l < b.r && b.t < fx.b && fx.t < b.b, '"' + b.text + '" overlaps ' + fx.s).toBe(false);
    }
  }
  await shot('playing');

  // ---- pause ----
  await page.waitForTimeout(1800);
  await page.evaluate(() => document.getElementById('pause-btn')?.click());
  await expect(page.locator('#pause')).toBeVisible();
  expect(await keyNames()).toEqual([]);
  await noScroll();
  await shot('pause');

  // ---- game over ----
  await page.waitForTimeout(450);
  await page.touchscreen.tap(Math.round(vp.width / 2), Math.round(vp.height / 2)); // resume
  await page.waitForTimeout(800); // let the AudioContext come back before the death sound
  await page.evaluate(() => (window as unknown as Win).__NEARMISS__.forceDeath());
  await expect(page.locator('#gameover')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#gameover .press')).toHaveText('TAP TO RETRY', { useInnerText: true });
  expect(await keyNames()).toEqual([]);
  await noScroll();
  expect(await screenFits(page, '#gameover')).toEqual([]);
  await shot('gameover');

  // ---- standalone (home-screen) launch: no install hint (iPhone UA only) ----
  if (isIphone) {
    const p2 = await page.context().newPage();
    await p2.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    await p2.goto('/');
    await expect(p2.locator('#title')).toBeVisible();
    await expect(p2.locator('#a2hs')).toBeHidden();
    await p2.close();
  }

  expect(problems, problems.join('\n')).toEqual([]);
});
