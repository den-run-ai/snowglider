/**
 * Browser coverage helper (step 2 of the honest-coverage work).
 *
 * The Node/c8 pass (`npm run test:coverage`) only sees the `src/` modules that
 * Node tests `import`; the browser-only game modules (snowglider, trees, camera,
 * controls, course, effects, …) execute exclusively inside Chromium and would
 * otherwise show as 0% forever. This helper drives Puppeteer's V8 coverage API
 * while the unified browser suite runs, then converts the raw V8 coverage to
 * Istanbul/LCOV.
 *
 * Attribution: the suite is served by Vite, which transpiles each `.ts` module on
 * the fly and appends an inline base64 source map (`sources: ["physics.ts"]`,
 * `sourcesContent` included). `v8-to-istanbul` walks those maps so coverage is
 * attributed back to `src/*.ts` lines, matching the line numbers c8 reports for
 * the same files. The emitted LCOV is line-merged with c8's LCOV by
 * `merge-lcov.js`; merging at the line level (rather than the Istanbul-object
 * level) is required because c8 (Node type-stripping) and Vite (esbuild) produce
 * different statement structures for the same source.
 *
 * These libraries ship transitively with c8 and are declared as explicit
 * devDependencies so this direct `require` stays supported.
 */

const path = require('path');
const v8toIstanbul = require('v8-to-istanbul');
const libCoverage = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');

// Only attribute coverage for served `/src/**/*.ts|.js` URLs. Everything else
// (the Vite client, node_modules/three, inline <script> glue in index.html,
// eval'd anonymous scripts) is intentionally dropped.
const SRC_URL_RE = /^\/src\/.+\.(ts|js)$/;

/**
 * Begin collecting JS coverage on a page. Must be called before `page.goto` so
 * the initial module graph is instrumented. `resetOnNavigation` is false so a
 * redirect/navigation inside the suite does not discard earlier coverage.
 *
 * @param {import('puppeteer').Page} page
 */
async function startBrowserCoverage(page) {
  await page.coverage.startJSCoverage({
    resetOnNavigation: false,
    includeRawScriptCoverage: true,
    useBlockCoverage: true
  });
}

/**
 * Pull the trailing `//# sourceMappingURL=data:...` inline map out of a served
 * module and return the parsed source map object, or null when absent. Supports
 * both base64 and URL/plain-text JSON data URIs. Vite uses base64 in dev.
 *
 * @param {string} source
 * @returns {object | null}
 */
function extractInlineSourceMap(source) {
  const match = /\/\/[#@]\s*sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?(base64,)?([^\s'"]+)\s*$/m.exec(source);
  if (!match) return null;
  try {
    const isBase64 = Boolean(match[1]);
    const payload = isBase64
      ? Buffer.from(match[2], 'base64').toString('utf8')
      : decodeURIComponent(match[2]);
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Stop coverage on a page and fold every `src/` entry into `coverageMap`
 * (an `istanbul-lib-coverage` CoverageMap). Safe to call for multiple pages so a
 * single browser session can aggregate coverage across them.
 *
 * @param {import('puppeteer').Page} page
 * @param {import('istanbul-lib-coverage').CoverageMap} coverageMap
 * @param {string} root absolute repo root used to resolve `/src/...` URLs
 */
async function foldPageCoverage(page, coverageMap, root) {
  const entries = await page.coverage.stopJSCoverage();

  for (const entry of entries) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(entry.url).pathname);
    } catch {
      continue;
    }
    if (!SRC_URL_RE.test(pathname)) continue;
    if (!entry.rawScriptCoverage || !Array.isArray(entry.rawScriptCoverage.functions)) continue;

    const relative = pathname.replace(/^\//, '');
    const scriptPath = path.resolve(root, relative);
    const sourcemap = extractInlineSourceMap(entry.text);

    try {
      // wrapperLength 0: browser ES modules are not CJS-wrapped, so V8 offsets
      // index the served source directly.
      const converter = v8toIstanbul(scriptPath, 0, {
        source: entry.text,
        sourceMap: sourcemap ? { sourcemap } : undefined
      });
      await converter.load();
      converter.applyCoverage(entry.rawScriptCoverage.functions);
      // Identical instrumentation per file (same source + map), so Istanbul-level
      // merge across duplicate URL queries for one module is safe here.
      coverageMap.merge(libCoverage.createCoverageMap(converter.toIstanbul()));
      converter.destroy();
    } catch (err) {
      console.warn(`Browser coverage: skipped ${relative} (${err.message})`);
    }
  }
}

/**
 * Write `<outDir>/lcov.info` and `<outDir>/coverage-final.json` from a
 * CoverageMap. The LCOV keys are absolute paths; `merge-lcov.js` normalizes them
 * to repo-relative before combining with c8's LCOV.
 *
 * @param {import('istanbul-lib-coverage').CoverageMap} coverageMap
 * @param {string} outDir
 */
function writeBrowserReports(coverageMap, outDir) {
  const context = libReport.createContext({ dir: outDir, coverageMap });
  reports.create('lcovonly', { file: 'lcov.info' }).execute(context);
  reports.create('json', { file: 'coverage-final.json' }).execute(context);
}

module.exports = {
  startBrowserCoverage,
  foldPageCoverage,
  writeBrowserReports,
  extractInlineSourceMap,
  createCoverageMap: () => libCoverage.createCoverageMap({})
};
