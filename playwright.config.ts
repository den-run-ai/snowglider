import { defineConfig, devices } from '@playwright/test';

// NOTE: run the specs via `npm run test:e2e` (not a bare `npx playwright test`).
// Those scripts set PLAYWRIGHT_FORCE_ASYNC_LOADER=1, which is required on Node 23:
// Playwright 1.61's synchronous registerHooks loader crashes resolving the relative
// `.ts` imports in the specs ("context.conditions?.includes is not a function").
// The env must be set before the process starts, so it can't live in this config.

// Playwright E2E layer (added alongside the existing Puppeteer suite, not as a
// replacement). It exists for the things the Puppeteer/in-page `?test=` runner
// can't reach: cross-browser engines (WebKit ≈ Safari), real menu+input user
// flows, and emulated mobile touch. The Puppeteer runner keeps owning the unified
// in-page suites and the honest-coverage pipeline; this never touches coverage.
//
// It reuses the same Vite dev server the Puppeteer runner does, on a dedicated
// port so the two can run side by side. Specs live in tests/e2e/.

const PORT = Number(process.env.E2E_PORT || 8082);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Keep Playwright's failure artifacts under the already-gitignored test-results/.
  outputDir: './test-results/playwright',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      // Headless Chromium — the same engine the Puppeteer suite uses, kept here so
      // the user-flow specs have a fast, reliable baseline to compare WebKit against.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      // WebKit — the closest CI proxy for desktop/iOS Safari. This is the whole
      // point of adding Playwright: nothing in the repo ran on the Safari engine
      // before. (It does NOT cover the iOS hardware silent-switch audio caveat in
      // CLAUDE.md — that still needs a real device.)
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      // Emulated iPhone (WebKit engine, mobile UA, touch, mobile viewport). The
      // game's control layer enables touch input when it detects a mobile UA, so
      // this is where the touch-control specs run. Mobile-only by testMatch.
      name: 'Mobile Safari',
      use: { ...devices['iPhone 13'] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: {
    // Same dev server as tests/puppeteer-runner.js: Vite transpiles the .ts game
    // modules and resolves the `./x.js` import graph, so the specs exercise the
    // real shipped modules. --strictPort so a stale listener can't be mistaken for
    // our server.
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `${BASE_URL}/@vite/client`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
