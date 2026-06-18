import { defineConfig, devices } from '@playwright/test';

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
