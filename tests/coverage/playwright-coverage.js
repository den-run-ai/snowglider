/**
 * Playwright V8-coverage glue (issue #133 — additive e2e coverage).
 *
 * The Playwright e2e job (tests/e2e/) drives real menu+input user flows across
 * Chromium/WebKit/mobile. WebKit/Firefox have no V8 coverage API, so coverage is
 * collected on the **chromium** project only; the other projects skip silently.
 * This is purely additive: the Puppeteer suite (BROWSER_COVERAGE) remains the
 * primary browser-coverage owner, and everything here is a no-op when the
 * `E2E_COVERAGE` env flag is unset.
 *
 * Flow:
 *   1. The auto coverage fixture (tests/e2e/fixtures.ts) starts JS coverage before
 *      each chromium test and, when it finishes, hands the raw entries here via
 *      `recordEntries`, which writes one JSON shard per test into a temp dir.
 *   2. Playwright `globalTeardown` (tests/e2e/global-teardown.ts) calls
 *      `collateLcov`, which folds every shard through the shared V8→Istanbul
 *      converter and writes `coverage/e2e/lcov.info`, then clears the temp dir.
 *
 * Sharding to disk (rather than an in-memory accumulator) is required because
 * Playwright runs tests across parallel worker processes; only globalTeardown,
 * in the main process, sees them all.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  createCoverageMap,
  foldV8Entry,
  writeBrowserReports,
  SRC_URL_RE
} = require('./browser-coverage');

const ROOT = path.resolve(__dirname, '..', '..');
// Both live under the gitignored /coverage/ dir. The temp dir is dot-prefixed so
// it is obviously scratch and never confused with a report dir.
const TEMP_DIR = path.join(ROOT, 'coverage', '.e2e-v8');
const OUT_DIR = path.join(ROOT, 'coverage', 'e2e');

/** Whether e2e coverage collection is requested (mirrors BROWSER_COVERAGE). */
function isEnabled() {
  return process.env.E2E_COVERAGE === '1' || process.env.E2E_COVERAGE === 'true';
}

// True only for served `/src/...(.ts|.js)` URLs — the modules we attribute to.
function isSrcUrl(url) {
  try {
    return SRC_URL_RE.test(decodeURIComponent(new URL(url).pathname));
  } catch {
    return false;
  }
}

/**
 * Persist one test's worth of Playwright JS-coverage entries as a JSON shard.
 *
 * Playwright's `stopJSCoverage()` returns `{ url, source, functions }` where
 * `functions` is the raw V8 `FunctionCoverage[]` — the exact input `foldV8Entry`
 * expects — so we keep only the served `/src/` modules and store those three
 * fields. No-op when disabled or when nothing relevant was covered.
 *
 * @param {Array<{ url: string, source?: string, functions?: any[] }>} entries
 */
function recordEntries(entries) {
  if (!isEnabled() || !Array.isArray(entries)) return;

  const kept = entries
    .filter((e) => e && isSrcUrl(e.url) && typeof e.source === 'string' && Array.isArray(e.functions))
    .map((e) => ({ url: e.url, source: e.source, functions: e.functions }));
  if (kept.length === 0) return;

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const shard = path.join(TEMP_DIR, `${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(shard, JSON.stringify(kept));
}

/**
 * Fold every recorded shard into a single `coverage/e2e/lcov.info`, then remove
 * the temp dir. Safe to call unconditionally: a no-op (no file written) when
 * disabled or when no shards exist, so the Codecov upload step can guard on the
 * file's presence.
 *
 * @returns {Promise<string | null>} the LCOV path, or null when nothing written
 */
async function collateLcov() {
  if (!isEnabled() || !fs.existsSync(TEMP_DIR)) return null;

  const shards = fs.readdirSync(TEMP_DIR).filter((f) => f.endsWith('.json'));
  const coverageMap = createCoverageMap();
  let folded = 0;

  for (const shard of shards) {
    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(path.join(TEMP_DIR, shard), 'utf8'));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (await foldV8Entry(coverageMap, ROOT, entry)) folded++;
    }
  }

  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  if (folded === 0) {
    console.log('playwright-coverage: no /src/ coverage recorded; nothing written');
    return null;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeBrowserReports(coverageMap, OUT_DIR);
  const out = path.join(OUT_DIR, 'lcov.info');
  console.log(`playwright-coverage: wrote ${out} (${coverageMap.files().length} files)`);
  return out;
}

module.exports = {
  isEnabled,
  recordEntries,
  collateLcov,
  TEMP_DIR,
  OUT_DIR
};
