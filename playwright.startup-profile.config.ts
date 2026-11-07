import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const port = Number(process.env.STARTUP_PROFILE_PORT || 8087);
const appDir = path.resolve(process.env.STARTUP_PROFILE_APP_DIR || '.');
const outputDir = path.resolve(process.env.STARTUP_PROFILE_OUTPUT_DIR || './test-results/webkit-startup-comparison');

// Run the unchanged test and application from each exact checkout. Only the
// runner's repetition, worker count, and evidence retention differ from CI.
export default defineConfig({
  testDir: path.join(appDir, 'tests/e2e'),
  testMatch: 'start-replay.spec.ts',
  grep: /blocked storage/,
  outputDir: path.join(outputDir, 'tests'),
  globalTeardown: path.join(appDir, 'tests/e2e/global-teardown.ts'),
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  repeatEach: 5,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(outputDir, 'results.json') }],
    ['html', { open: 'never', outputFolder: path.join(outputDir, 'report') }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort --host 127.0.0.1`,
    cwd: appDir,
    url: `http://127.0.0.1:${port}/@vite/client`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
