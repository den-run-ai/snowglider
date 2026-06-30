import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// Plan §1B — visual regression (Category 1). Kept as a SEPARATE, opt-in config so
// the default `npm run test:e2e` CI job (playwright.config.ts) never runs these
// specs — which means missing/mismatched baselines can't turn the gating e2e job
// red. Run it explicitly with `npm run test:e2e:visual`.
//
// Why separate rather than a project flag in the main config: pixel baselines are
// environment-specific (browser build + the host's installed system fonts), so a
// baseline generated on a dev machine or this sandbox will NOT match the CI
// Playwright Docker image's fonts. The intended workflow (see docs + PR) is to
// regenerate baselines ON the CI image once, commit them, and only then wire this
// config into CI. Until then it is a locally-runnable guard, not a CI gate.
//
// Chromium-only on purpose (plan §1B): cross-engine pixel diffs aren't comparable.

const PORT = Number(process.env.E2E_VISUAL_PORT || 8083);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e/visual',
  outputDir: './test-results/playwright-visual',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 60_000,
  // Pixel-diff tolerances. maxDiffPixelRatio absorbs sub-pixel anti-aliasing on
  // text edges (the dominant source of cross-build noise for DOM overlays) while
  // still failing on a real visual regression (a moved/recoloured/removed element
  // touches a large fraction of pixels). threshold is the per-pixel YIQ delta.
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.2, animations: 'disabled' },
  },
  use: {
    ...base.use,
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    // Freeze the day/night sky cycle to midday and disable CSS animations/transitions
    // (scene-setup.ts / src/sky.ts honour prefers-reduced-motion) so captures are
    // deterministic frame to frame.
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `${BASE_URL}/@vite/client`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
