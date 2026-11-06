import { defineConfig, devices } from '@playwright/test';

const chromiumArgs = [
  '--use-angle=swiftshader',
  '--use-gl=angle',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
];

/**
 * Mobile projects (DESIGN 17.7). The iPhone projects use Chromium with the iPhone 15 Pro viewport, UA, DPR,
 * isMobile and hasTouch: Playwright's Windows WebKit renders WebGL but has no AudioContext at all, so Tone.js
 * cannot run there. (Safari-only behaviour — safe-area insets, toolbar, silent switch — needs a real iPhone.)
 */
const chromiumAs = (device: string): Record<string, unknown> => ({
  ...devices[device],
  browserName: 'chromium',
  defaultBrowserType: 'chromium',
});

export default defineConfig({
  testDir: 'e2e',
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 800, height: 450 },
    launchOptions: { args: chromiumArgs },
  },
  projects: [
    { name: 'chromium', testMatch: /(smoke|zone)\.spec\.ts/, use: { browserName: 'chromium' } },
    { name: 'iphone-portrait', testMatch: /(mobile|zone)\.spec\.ts/, use: chromiumAs('iPhone 15 Pro') },
    { name: 'iphone-landscape', testMatch: /(mobile|zone)\.spec\.ts/, use: chromiumAs('iPhone 15 Pro landscape') },
    { name: 'pixel7-portrait', testMatch: /(mobile|zone)\.spec\.ts/, use: { ...devices['Pixel 7'] } },
    { name: 'pixel7-landscape', testMatch: /(mobile|zone)\.spec\.ts/, use: { ...devices['Pixel 7 landscape'] } },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 180000,
  },
});
