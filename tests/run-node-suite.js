// run-node-suite.js — auto-discovering runner for the headless Node test suite.
//
// Replaces the hand-maintained 40+-command `&&` chain that `npm test` used to be.
// That chain was brittle: every new suite had to be wired into it by hand (and the
// individual `test:*` script), and it was easy to forget one. This runner instead
// DISCOVERS the suites on disk, so dropping a new `tests/<name>-tests.js` (or a new
// `tests/verification/*.js` harness) file into the tree is enough to get it run by
// `npm test` — no package.json edit required.
//
// It runs each file in its own child `node` process (matching the old
// one-process-per-file isolation), streaming output through, and exits non-zero if
// any suite fails. Because every child is still a separate `node` process, the c8
// wrapper in `npm run test:coverage` collects coverage from them exactly as before.
//
// Loader dispatch: every suite is launched with the superset
// `tests/loaders/register-firebase-mock.mjs` import hook. That hook layers the
// Firebase-CDN mock ON TOP OF the `.js`->`.ts` resolve fallback, and BOTH hooks are
// conditional no-ops unless their trigger fires (a `firebasejs` CDN specifier, or a
// `.js` specifier that only resolves as `.ts`). So a single loader covers the three
// old modes — plain `node`, `--import register-ts-resolve`, and
// `--import register-firebase-mock` — with zero per-file configuration. See the
// loader headers in tests/loaders/ for why each hook is inert when not needed.
//
// Usage:
//   node tests/run-node-suite.js            # run every discovered suite
//   node tests/run-node-suite.js --list     # print the discovered suites and exit
//   node tests/run-node-suite.js terrain    # run only suites whose path matches a filter
//   node tests/run-node-suite.js share auth  # multiple filters = OR (any match runs)

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const TESTS_DIR = __dirname;
const VERIFICATION_DIR = path.join(TESTS_DIR, 'verification');
const LOADER = pathToFileURL(
  path.join(TESTS_DIR, 'loaders', 'register-firebase-mock.mjs')
).href;

// Browser-context suites: they import DOM/WebGL-only modules and are driven by the
// in-page `?test=` runner (tests/puppeteer-runner.js / unified-test-runner.js), not
// Node. They cannot run headless, so discovery skips them here. New browser suites
// belong in that runner, not this one.
//
// Anything following the `browser-*-tests.js` naming convention is skipped BY
// PATTERN, so a browser suite added later is left out automatically — otherwise the
// runner would try to execute a DOM/WebGL suite under Node and break `npm test`. The
// explicit set below is only for the three browser suites that predate that
// convention and don't carry the `browser-` prefix.
const BROWSER_ONLY = new Set([
  'audio-tests.js',
  'camera-tests.js',
  'controls-tests.js'
]);

function isBrowserOnly(name) {
  return name.startsWith('browser-') || BROWSER_ONLY.has(name);
}

// Suites that need external services the base `npm test` environment does not
// provide. Firestore rules need a Java-backed emulator, so they run in their own
// `npm run test:firebase` job.
const REQUIRES_EXTERNAL = new Set([
  'firestore-rules-tests.js'
]);

// tests/verification/ entries that are fixtures/support, not runnable suites.
const NOT_A_SUITE = new Set([
  'snowman_baseline.js', // frozen physics baseline loaded BY the invariant harness
  'results.txt'
]);

function listFiles(dir, predicate) {
  return fs
    .readdirSync(dir)
    .filter(predicate)
    .sort()
    .map((name) => path.join(dir, name));
}

// Discover the two on-disk suite families. Everything is keyed off naming/location
// conventions so a new file is picked up automatically.
function discoverSuites() {
  const unit = listFiles(
    TESTS_DIR,
    (name) =>
      name.endsWith('-tests.js') &&
      !isBrowserOnly(name) &&
      !REQUIRES_EXTERNAL.has(name)
  );

  const verification = listFiles(
    VERIFICATION_DIR,
    (name) => name.endsWith('.js') && !NOT_A_SUITE.has(name)
  );

  return [
    ...unit.map((file) => ({ file, group: 'unit' })),
    ...verification.map((file) => ({ file, group: 'verification' }))
  ];
}

function runSuite(file) {
  const started = process.hrtime.bigint();
  const result = spawnSync(
    process.execPath,
    ['--import', LOADER, file],
    { stdio: 'inherit', env: process.env }
  );
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // spawnSync sets .error on failure to launch, .signal on a killed child, and
  // .status to the exit code otherwise. Treat anything but a clean 0 exit as a fail.
  const ok = !result.error && result.signal == null && result.status === 0;
  return { ok, ms, signal: result.signal, error: result.error, status: result.status };
}

function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const filters = args.filter((a) => !a.startsWith('--'));

  let suites = discoverSuites();
  if (filters.length) {
    suites = suites.filter((s) =>
      filters.some((f) => s.file.includes(f))
    );
  }

  if (!suites.length) {
    console.error(
      filters.length
        ? `No suites matched: ${filters.join(', ')}`
        : 'No suites discovered.'
    );
    process.exit(1);
  }

  if (listOnly) {
    for (const { file, group } of suites) {
      console.log(`${group.padEnd(12)} ${path.relative(TESTS_DIR, file)}`);
    }
    console.log(`\n${suites.length} suites discovered.`);
    return;
  }

  console.log(`Running ${suites.length} Node suites via ${path.basename(__filename)}\n`);

  const failures = [];
  const started = process.hrtime.bigint();
  for (const { file } of suites) {
    const rel = path.relative(path.dirname(TESTS_DIR), file);
    console.log(`\n─── ${rel} ───`);
    const { ok, ms, signal, error, status } = runSuite(file);
    if (!ok) {
      const why = error
        ? error.message
        : signal
          ? `killed by ${signal}`
          : `exit ${status}`;
      failures.push({ rel, why });
      console.log(`✗ ${rel} FAILED (${why}) in ${ms.toFixed(0)}ms`);
    } else {
      console.log(`✓ ${rel} (${ms.toFixed(0)}ms)`);
    }
  }
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6;

  console.log(`\n${'='.repeat(60)}`);
  const passed = suites.length - failures.length;
  console.log(
    `${passed}/${suites.length} suites passed in ${(totalMs / 1000).toFixed(1)}s`
  );
  if (failures.length) {
    console.log(`\n${failures.length} FAILED:`);
    for (const { rel, why } of failures) {
      console.log(`  ✗ ${rel} (${why})`);
    }
    process.exit(1);
  }
  console.log('All suites passed.');
}

main();
