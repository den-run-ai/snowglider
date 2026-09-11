import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// One HEAD-owned capture harness drives both explicitly selected revisions. The
// app path can point at a separate checkout; this never changes the code it serves.
const port = Number(process.env.RENDER_REVIEW_PORT || 8084);
export default defineConfig({
  testDir: './tests/render-review',
  outputDir: './test-results/render-review-playwright',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } }
  ],
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort --host 127.0.0.1`,
    cwd: path.resolve(process.env.RENDER_APP_DIR || '.'),
    url: `http://127.0.0.1:${port}/@vite/client`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
