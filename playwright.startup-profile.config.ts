import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const port = Number(process.env.STARTUP_PROFILE_PORT || 8087);

export default defineConfig({
  testDir: './tests/startup-profile',
  outputDir: './test-results/startup-profile-playwright',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  repeatEach: 3,
  timeout: 180_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
  },
  projects: [{ name: 'phone', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort --host 127.0.0.1`,
    cwd: path.resolve(process.env.RENDER_APP_DIR || '.'),
    url: `http://127.0.0.1:${port}/@vite/client`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
