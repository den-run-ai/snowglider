// @ts-check
// pwa-build-artifact-tests.js — asserts the BUILT service worker (dist/sw.js) is
// shaped correctly (issue #358, PR 3): it precaches the true app shell and NOTHING
// forbidden (copied src/tests/node_modules, the auth page, the large MP3 / ez-tree
// chunk, source maps). This is the Node twin of the cache-safety check in
// scripts/verify-pages-dist.sh. It runs after `npm run build` (the CI `test` job
// builds before the Node suite); when dist/sw.js is absent (a bare `npm test` with no
// prior build) it self-skips rather than fail. Auto-discovered by run-node-suite.js.
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++;
  else fail++;
}

const root = path.resolve(__dirname, '..');
const swPath = path.join(root, 'dist', 'sw.js');

if (!fs.existsSync(swPath)) {
  console.log('  SKIP: dist/sw.js not present (run `npm run build` first) — build-artifact checks skipped.');
  console.log('\nPWA BUILD-ARTIFACT TEST TOTAL: 0 passed, 0 failed (skipped, no build)');
  process.exit(0);
}

const sw = fs.readFileSync(swPath, 'utf8');

// Extract the precache URLs — the `"url":"…"` values are unique to the injected
// manifest (routing code uses url.pathname, so it legitimately contains '/src/' etc.).
const urls = [];
for (const m of sw.matchAll(/"url":"([^"]*)"/g)) {
  urls.push(m[1]);
}
check('precache manifest has entries', urls.length > 0);

// Forbidden: copied source/tests/node_modules, the auth page, media, maps, ez-tree.
const FORBIDDEN = ['/src/', 'src/', '/tests/', 'tests/', 'node_modules/', 'auth.html', '.mp3', '.map', 'ez-tree'];
const offenders = urls.filter((u) => FORBIDDEN.some((f) => u.includes(f)));
check(`precache excludes all forbidden paths (offenders: ${JSON.stringify(offenders)})`, offenders.length === 0);

// The true app shell IS precached.
check('precaches index.html', urls.some((u) => u === 'index.html' || u.endsWith('/index.html')));
check('precaches the manifest', urls.some((u) => u.includes('manifest.webmanifest')));
check('precaches a hashed JS chunk', urls.some((u) => /assets\/.*\.js$/.test(u)));
check('precaches the CSS', urls.some((u) => /assets\/.*\.css$/.test(u)));
check('precaches the icon', urls.some((u) => u.includes('icons/') && u.endsWith('.svg')));

// The large ez-tree chunk is runtime-cached, NOT precached.
check('does NOT precache the ez-tree chunk (runtime-cached)', !urls.some((u) => u.includes('ez-tree')));

// The raw worker TypeScript must not ship in the copied source tree.
check('no raw dist/src/pwa/sw.ts in the artifact', !fs.existsSync(path.join(root, 'dist', 'src', 'pwa', 'sw.ts')));

// The worker references the app-shell fallback + a skip-waiting message hook.
check('worker binds the /index.html app-shell fallback', sw.includes('/index.html'));
check('worker honors a SKIP_WAITING message', sw.includes('SKIP_WAITING'));

console.log(`\nPWA BUILD-ARTIFACT TEST TOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
