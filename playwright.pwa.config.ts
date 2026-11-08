import { defineConfig, devices } from '@playwright/test';

// PWA / offline acceptance layer (issue #358, PR 5). Separate from playwright.config.ts
// on purpose: the service worker + its precache manifest are PRODUCTION artifacts, so
// these specs MUST run against `vite preview` (the built dist/, which actually contains
// sw.js) — NOT the Vite dev server, where vite-plugin-pwa emits no worker
// (devOptions.enabled: false). Run via `npm run test:pwa`, which builds first.
//
// Chromium only: it has the most complete + reliable service-worker + offline support
// in Playwright (WebKit's SW support is partial and flaky for offline emulation). The
// cross-browser/mobile matrix stays in playwright.config.ts.

const PORT = Number(process.env.PWA_E2E_PORT || 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Only the PWA specs — the rest of tests/e2e/ is the dev-server suite.
  testMatch: /pwa-.*\.spec\.ts/,
  outputDir: './test-results/playwright-pwa',
  fullyParallel: false, // service-worker/cache state is per-origin; keep specs serial.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // 127.0.0.1 is a secure context, so the service worker registers (register-sw.ts
    // gates on secure-context, not on webdriver — that's what lets these specs drive it).
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'chromium-pwa',
      use: {
        ...devices['Desktop Chrome'],
        // Escape hatch for environments whose pre-installed Chromium doesn't match the
        // @playwright/test-pinned browser build (e.g. a sandbox with a browser at a fixed
        // path): set PWA_CHROMIUM_PATH to that executable. Unset in CI (the Playwright
        // container ships the matched browser), so it's a no-op there.
        ...(process.env.PWA_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PWA_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    // vite preview serves the BUILT dist/ (with the real sw.js). `npm run test:pwa`
    // runs `npm run build` first; --strictPort so a stale listener can't be mistaken
    // for our server.
    command: `npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
