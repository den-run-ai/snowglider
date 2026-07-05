// @ts-check
// install-prompt-tests.js — headless coverage for src/pwa/install-prompt.ts (issue
// #358, PR 2). Verifies the pure show/hide decision and the jsdom-driven controller:
// the chip appears only after `beforeinstallprompt`, is hidden under automation /
// standalone / after dismissal, installs on click, and cleans up. Auto-discovered by
// tests/run-node-suite.js.
'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++;
  else fail++;
}

/** Build a fake beforeinstallprompt event with a controllable userChoice. */
function makeBip(win, outcome) {
  const evt = new win.Event('beforeinstallprompt', { cancelable: true });
  let prompted = false;
  Object.defineProperty(evt, 'prompt', { value: () => { prompted = true; return Promise.resolve(); } });
  Object.defineProperty(evt, 'userChoice', { value: Promise.resolve({ outcome: outcome || 'accepted' }) });
  Object.defineProperty(evt, '_prompted', { get: () => prompted });
  return evt;
}

const START_HTML = '<!doctype html><html><body><div id="startGameContainer"></div></body></html>';

async function main() {
  const { setupDom } = await import('./mocks/dom.mjs');
  const { createLocalStorageMock } = await import('./mocks/local-storage.mjs');
  const ip = await import('../src/pwa/install-prompt.ts');

  // --- Pure shouldOfferInstall ---
  const base = { testMode: false, standalone: false, promptAvailable: true, dismissed: false };
  check('offers install when supported + eligible', ip.shouldOfferInstall(base) === true);
  check('no offer without a captured prompt', ip.shouldOfferInstall({ ...base, promptAvailable: false }) === false);
  check('no offer under automation', ip.shouldOfferInstall({ ...base, testMode: true }) === false);
  check('no offer when already standalone', ip.shouldOfferInstall({ ...base, standalone: true }) === false);
  check('no offer after dismissal', ip.shouldOfferInstall({ ...base, dismissed: true }) === false);

  // --- Controller: nothing shows before the browser offers install ---
  const env = setupDom({ html: START_HTML });
  const storage = createLocalStorageMock();
  const ctrl = ip.initInstallPrompt({
    doc: env.document,
    win: env.window,
    isTestMode: () => false,
    standalone: () => false,
    storage,
  });
  check('no chip before beforeinstallprompt', env.document.getElementById(ip.INSTALL_PROMPT_ID) === null);

  // Fire beforeinstallprompt → chip mounts and shows.
  const bip = makeBip(env.window, 'accepted');
  env.window.dispatchEvent(bip);
  const chip = env.document.getElementById(ip.INSTALL_PROMPT_ID);
  check('chip mounted after beforeinstallprompt', !!chip);
  check('chip is shown (display flex)', !!chip && chip.style.display === 'flex');
  check('chip mounted inside #startGameContainer', !!chip && chip.parentElement === env.document.getElementById('startGameContainer'));
  check('browser mini-infobar suppressed (preventDefault)', bip.defaultPrevented === true);

  // Clicking Install triggers the native prompt and hides the chip afterwards.
  const installBtn = env.document.getElementById('installPromptButton');
  installBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  check('install click invoked the native prompt', bip._prompted === true);

  // A second controller / event after install: reset dismissal and re-open.
  ctrl.dispose();
  check('dispose removes the chip', env.document.getElementById(ip.INSTALL_PROMPT_ID) === null);

  // --- Dismissal persists and suppresses the chip ---
  const env2 = setupDom({ html: START_HTML });
  const storage2 = createLocalStorageMock();
  const ctrl2 = ip.initInstallPrompt({ doc: env2.document, win: env2.window, isTestMode: () => false, standalone: () => false, storage: storage2 });
  env2.window.dispatchEvent(makeBip(env2.window, 'dismissed'));
  const dismissBtn = env2.document.getElementById('installPromptDismiss');
  dismissBtn.click();
  check('dismiss hides the chip', env2.document.getElementById(ip.INSTALL_PROMPT_ID).style.display === 'none');
  check('dismiss persisted to storage', storage2.getItem(ip.INSTALL_DISMISSED_KEY) === '1');
  // Re-fire after dismissal — must stay hidden.
  env2.window.dispatchEvent(makeBip(env2.window, 'accepted'));
  check('stays hidden after prior dismissal', env2.document.getElementById(ip.INSTALL_PROMPT_ID).style.display === 'none');
  ctrl2.dispose();

  // --- Automation gate: chip never shows under test mode ---
  const env3 = setupDom({ html: START_HTML });
  const ctrl3 = ip.initInstallPrompt({ doc: env3.document, win: env3.window, isTestMode: () => true, standalone: () => false, storage: createLocalStorageMock() });
  env3.window.dispatchEvent(makeBip(env3.window, 'accepted'));
  const chip3 = env3.document.getElementById(ip.INSTALL_PROMPT_ID);
  check('no visible chip under automation', !chip3 || chip3.style.display === 'none');
  ctrl3.dispose();

  // --- appinstalled hides the chip ---
  const env4 = setupDom({ html: START_HTML });
  const ctrl4 = ip.initInstallPrompt({ doc: env4.document, win: env4.window, isTestMode: () => false, standalone: () => false, storage: createLocalStorageMock() });
  env4.window.dispatchEvent(makeBip(env4.window, 'accepted'));
  check('chip visible before appinstalled', env4.document.getElementById(ip.INSTALL_PROMPT_ID).style.display === 'flex');
  env4.window.dispatchEvent(new env4.window.Event('appinstalled'));
  check('appinstalled hides the chip', env4.document.getElementById(ip.INSTALL_PROMPT_ID).style.display === 'none');
  ctrl4.dispose();

  // --- No document: inert controller, no throw ---
  const inert = ip.initInstallPrompt({ doc: /** @type {any} */ (null), win: /** @type {any} */ (null) });
  let inertThrew = false;
  try { inert.refresh(); inert.dispose(); } catch { inertThrew = true; }
  check('inert controller when no document/window', inertThrew === false);

  console.log(`\nINSTALL PROMPT TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
