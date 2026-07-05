// @ts-check
// pwa-update-ui-tests.js — headless coverage for src/pwa/update-ui.ts (issue #358,
// PR 3): the "New version available" banner shown only on a safe (start) screen, with
// a Reload button that runs the apply() callback. Auto-discovered by run-node-suite.js.
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
  const env = setupDom({ html: '<!doctype html><html><body><div id="startGameContainer"></div><div id="gameOverOverlay" style="display:none"></div></body></html>' });
  const ui = await import('../src/pwa/update-ui.ts');

  const container = env.document.getElementById('startGameContainer');

  // Safe screen visible → banner shows.
  let applied = 0;
  const shown = ui.showUpdatePrompt(() => { applied++; }, env.document);
  check('banner shown on a visible start screen', shown === true);
  const banner = env.document.getElementById(ui.UPDATE_BANNER_ID);
  check('banner element mounted', !!banner && banner.parentElement === container);
  check('banner carries the version copy', !!banner && banner.textContent.includes(ui.UPDATE_BANNER_TEXT));

  // Idempotent: a second call does not duplicate.
  check('second call does not re-show (idempotent)', ui.showUpdatePrompt(() => {}, env.document) === false);
  check('only one banner in the DOM', env.document.querySelectorAll('#' + ui.UPDATE_BANNER_ID).length === 1);

  // Reload button runs apply().
  const reload = env.document.getElementById('swUpdateReload');
  reload.click();
  check('Reload invokes apply()', applied === 1);

  // Enter/Space on Reload must NOT bubble to a document keydown listener (which would
  // start a run — Codex #361). stopPropagation keeps native activation but blocks bubbling.
  let bubbled = false;
  const bubbledNow = () => bubbled; // read through a fn so CFA doesn't narrow to the init
  env.document.addEventListener('keydown', () => { bubbled = true; });
  reload.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check('Enter on Reload does not bubble to document', bubbledNow() === false);
  reload.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  check('Space on Reload does not bubble to document', bubbledNow() === false);
  // A non-activation key still bubbles normally (we only stop Enter/Space).
  reload.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  check('other keys still bubble', bubbledNow() === true);

  // --- Defer during a run: the update installs while the start screen is hidden ---
  container.style.display = 'none';
  env.document.getElementById(ui.UPDATE_BANNER_ID).remove();
  let deferApplied = 0;
  check('mid-run showUpdatePrompt returns false (deferred, not lost)', ui.showUpdatePrompt(() => { deferApplied++; }, env.document) === false);
  check('no banner mounted while hidden', env.document.getElementById(ui.UPDATE_BANNER_ID) === null);
  // The start screen returns → the stashed prompt re-surfaces (MutationObserver, Codex #361).
  container.style.display = 'flex';
  await new Promise((r) => setTimeout(r, 0));
  const deferred = env.document.getElementById(ui.UPDATE_BANNER_ID);
  check('deferred banner re-surfaces when the start screen returns', !!deferred);
  if (deferred) {
    env.document.getElementById('swUpdateReload').click();
    check('deferred banner uses the stashed apply callback', deferApplied === 1);
    deferred.remove();
  }

  // --- Surface on the game-over overlay too (Codex #361): update installs mid-run,
  // the player finishes → the result overlay is the safe screen, not the start screen.
  const gameOver = env.document.getElementById('gameOverOverlay');
  container.style.display = 'none';
  const stale = env.document.getElementById(ui.UPDATE_BANNER_ID);
  if (stale) stale.remove();
  let goApplied = 0;
  check('mid-run showUpdatePrompt (both hidden) returns false', ui.showUpdatePrompt(() => { goApplied++; }, env.document) === false);
  gameOver.style.display = 'flex';
  await new Promise((r) => setTimeout(r, 0));
  const goBanner = env.document.getElementById(ui.UPDATE_BANNER_ID);
  check('banner surfaces on the game-over overlay', !!goBanner && goBanner.parentElement === gameOver);
  if (goBanner) {
    env.document.getElementById('swUpdateReload').click();
    check('game-over banner uses the stashed apply', goApplied === 1);
    goBanner.remove();
  }
  gameOver.style.display = 'none';

  // retryPendingUpdatePrompt no-ops when no safe screen is visible (both hidden here).
  check('retryPendingUpdatePrompt no-ops when no safe screen visible', ui.retryPendingUpdatePrompt(env.document) === false);

  // A throwing apply() is isolated (needs a visible safe screen to mount the banner).
  container.style.display = 'flex';
  ui.showUpdatePrompt(() => { throw new Error('boom'); }, env.document);
  let threw = false;
  try { env.document.getElementById('swUpdateReload').click(); } catch { threw = true; }
  check('a throwing apply() is swallowed', threw === false);

  env.teardown();
  console.log(`\nPWA UPDATE-UI TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
