import coverage from '../coverage/playwright-coverage.js';

// Fold the per-test Chromium V8 shards recorded by the coverage fixture into a
// single coverage/e2e/lcov.info, then clear the scratch dir. No-op (writes
// nothing) when E2E_COVERAGE is unset or no chromium coverage was recorded, so
// the default e2e run is unaffected. See issue #133.
async function globalTeardown(): Promise<void> {
  await coverage.collateLcov();
}

export default globalTeardown;
