// @ts-check
// offline-ui-tests.js — headless coverage for src/offline/offline-ui.ts (issue
// #358, PR 1). Verifies the copy constants, the pure leaderboard-fallback chooser,
// and the offline-badge mount/toggle DOM helpers (idempotent mount, hidden by
// default, visibility transitions). Auto-discovered by tests/run-node-suite.js.
'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++;
  else fail++;
}

async function main() {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ html: '<!doctype html><html><body><div id="startGameContainer"></div></body></html>' });
  const ui = await import('../src/offline/offline-ui.ts');

  // --- Copy constants are the exact contract wording ---
  check('badge text copy', ui.OFFLINE_BADGE_TEXT === 'Offline mode — local bests only');
  check('leaderboard offline copy', ui.LEADERBOARD_OFFLINE_TEXT === 'Global leaderboard unavailable. Showing your local best.');
  check('install hint copy exists (reused by PR 2)', typeof ui.INSTALL_HINT_TEXT === 'string' && ui.INSTALL_HINT_TEXT.length > 0);

  // --- leaderboardFallbackCopy: null when available, the fallback line otherwise ---
  check('no fallback copy when board available', ui.leaderboardFallbackCopy(true) === null);
  check('fallback copy when board unavailable', ui.leaderboardFallbackCopy(false) === ui.LEADERBOARD_OFFLINE_TEXT);

  // --- ensureOfflineBadge: mounts hidden, idempotent ---
  const container = env.document.getElementById('startGameContainer');
  const badge = ui.ensureOfflineBadge(container);
  check('badge mounted with the expected id', badge.id === ui.OFFLINE_BADGE_ID);
  check('badge text set', badge.textContent === ui.OFFLINE_BADGE_TEXT);
  check('badge hidden on mount (no online change)', badge.style.display === 'none');
  check('badge is a child of the container', badge.parentElement === container);
  check('badge announces politely for a11y', badge.getAttribute('role') === 'status' && badge.getAttribute('aria-live') === 'polite');

  const again = ui.ensureOfflineBadge(container);
  check('ensureOfflineBadge is idempotent (same node)', again === badge);
  check('only one badge in the DOM', env.document.querySelectorAll('#' + ui.OFFLINE_BADGE_ID).length === 1);

  // --- setOfflineBadgeVisible transitions ---
  ui.setOfflineBadgeVisible(badge, true);
  check('badge shown when offline', badge.style.display === 'block');
  ui.setOfflineBadgeVisible(badge, false);
  check('badge hidden when back online', badge.style.display === 'none');
  let threw = false;
  try { ui.setOfflineBadgeVisible(null, true); } catch { threw = true; }
  check('setOfflineBadgeVisible tolerates a null badge', threw === false);

  env.teardown();
  console.log(`\nOFFLINE-UI TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
