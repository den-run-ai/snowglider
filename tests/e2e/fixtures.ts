import { test as base, expect } from '@playwright/test';
// CJS coverage glue — default-imported so the ESM↔CJS interop is unambiguous.
import coverage from '../coverage/playwright-coverage.js';

// Auto fixture that, when E2E_COVERAGE is set, wraps each test in Chromium V8
// coverage collection and hands the raw entries to the coverage glue (which
// shards them to disk for globalTeardown to fold into coverage/e2e/lcov.info).
//
// Coverage is Chromium-only: WebKit/Firefox expose no V8 coverage API, so we gate
// on `browserName === 'chromium'` and skip silently everywhere else. The fixture
// depends on `page`, so the page exists before the test body navigates — required
// because JS coverage must start before the first `goto`. See issue #133 and
// tests/coverage/playwright-coverage.js.
export const test = base.extend<{ collectCoverage: void }>({
  collectCoverage: [
    async ({ page, browserName }, use) => {
      const enabled = coverage.isEnabled() && browserName === 'chromium';
      if (enabled) {
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
      }
      await use();
      if (enabled) {
        const entries = await page.coverage.stopJSCoverage();
        coverage.recordEntries(entries);
      }
    },
    { auto: true },
  ],
});

export { expect };
