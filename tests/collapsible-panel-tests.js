// @ts-check
// collapsible-panel-tests.js
// Headless, c8-instrumented coverage for src/ui/collapsible-panel.ts — the shared
// collapse / auto-collapse / horizontal-swipe behavior for the HUD panels.
//
// Exercise disclosure semantics, gesture ownership, responsive state and teardown
// against the real module. Browser layout/keyboard checks complement these tests.

'use strict';

const { JSDOM } = require('jsdom');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

// Reproduce real single-finger sequences, including empty touches on release.
function touchEvent(window, type, clientX = 0, clientY = 0, touches) {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'touches', {
    value: touches ?? (type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX, clientY, identifier: 1 }]),
  });
  return ev;
}

function viewport(window, width, height) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  window.dispatchEvent(new window.Event('resize'));
}

function panelHtml(prefix) {
  return `
    <div id="${prefix}Container">
      <div id="${prefix}Header"><button id="${prefix}Toggle">▲</button></div>
      <div id="${prefix}Content"><button id="${prefix}Action">Action</button></div>
    </div>`;
}

async function main() {
  console.log('--- collapsible-panel.ts ---');

  const dom = new JSDOM(`<!doctype html><body>
    ${panelHtml('stats')}
    ${panelHtml('ctrl')}
    ${panelHtml('reset')}
    ${panelHtml('fb')}
    ${panelHtml('sig')}
    ${panelHtml('fbs')}
    ${panelHtml('rewire')}
    ${panelHtml('clone')}
    ${panelHtml('aborted')}
  </body>`, { url: 'https://snowglider.ai/', pretendToBeVisual: true });
  const { window } = dom;
  const g = /** @type {any} */ (globalThis);
  g.window = window;
  g.document = window.document;

  const { setupCollapsiblePanel, setPanelCollapsed, isCompactPanelViewport } = await import('../src/ui/collapsible-panel.ts');

  // --- Missing elements -> warn + early return ---
  setupCollapsiblePanel({ name: 'Nope', containerId: 'missingC', toggleButtonId: 'missingT', headerId: 'missingH' });
  check('missing elements: no panel container gets a collapsed class', true);

  // --- Stats panel: resetListeners=false (wire nodes directly) ---
  setupCollapsiblePanel({ name: 'Stats', containerId: 'statsContainer', toggleButtonId: 'statsToggle', headerId: 'statsHeader' });
  const statsC = document.getElementById('statsContainer');
  const statsT = document.getElementById('statsToggle');
  const statsH = document.getElementById('statsHeader');
  const statsContent = document.getElementById('statsContent');
  const statsAction = document.getElementById('statsAction');
  check('all panels use shared surface, header and disclosure classes',
    statsC.classList.contains('hud-panel') && statsH.classList.contains('hud-panel-header')
    && statsT.classList.contains('panel-disclosure'));
  check('disclosure uses one decorative chevron instead of a text triangle',
    statsT.querySelectorAll('.panel-chevron').length === 1
    && statsT.firstElementChild.getAttribute('aria-hidden') === 'true' && statsT.textContent === '');
  check('disclosure is named and points at its content',
    statsT.getAttribute('aria-label') === 'Toggle Stats options'
    && statsT.getAttribute('aria-controls') === 'statsContent'
    && statsT.getAttribute('aria-expanded') === 'true');
  statsAction.focus();

  statsT.dispatchEvent(new window.Event('click', { bubbles: true })); // toggle -> collapsed
  check('toggle button collapses the panel',
    statsC.classList.contains('collapsed') && statsT.getAttribute('aria-expanded') === 'false');
  check('collapse removes content from focus/accessibility and returns focus to disclosure',
    statsContent.inert === true && statsContent.getAttribute('aria-hidden') === 'true'
    && statsT.getAttribute('aria-expanded') === 'false' && document.activeElement === statsT);

  statsH.dispatchEvent(new window.Event('click', { bubbles: true })); // header click -> expand
  check('header click expands the panel',
    !statsC.classList.contains('collapsed') && statsT.getAttribute('aria-expanded') === 'true');
  check('expansion restores content and state', statsContent.inert === false
    && statsContent.getAttribute('aria-hidden') === 'false' && statsT.getAttribute('aria-expanded') === 'true');

  statsH.dispatchEvent(touchEvent(window, 'touchstart', 100, 100));
  const tapEnd = touchEvent(window, 'touchend');
  statsH.dispatchEvent(tapEnd);
  check('header tap toggles once and suppresses synthesized click',
    statsC.classList.contains('collapsed') && tapEnd.defaultPrevented);

  // Swipe right while collapsed -> expand; swipe left while expanded -> collapse.
  statsH.dispatchEvent(touchEvent(window, 'touchstart', 100));
  statsH.dispatchEvent(touchEvent(window, 'touchmove', 200)); // diff +100 -> expand
  check('swipe right expands a collapsed panel', !statsC.classList.contains('collapsed'));
  statsH.dispatchEvent(touchEvent(window, 'touchstart', 200));
  statsH.dispatchEvent(touchEvent(window, 'touchmove', 100)); // diff -100 -> collapse
  check('swipe left collapses an expanded panel', statsC.classList.contains('collapsed'));

  // A REAL swipe fires touchstart -> touchmove -> touchend. The trailing touchend must
  // not re-toggle and undo the swipe, or the gesture nets back to the start state
  // (Codex review, PR #331). Panel is collapsed here.
  statsH.dispatchEvent(touchEvent(window, 'touchstart', 100));
  statsH.dispatchEvent(touchEvent(window, 'touchmove', 200)); // swipe right -> expand
  statsH.dispatchEvent(touchEvent(window, 'touchend'));       // must NOT collapse again
  check('swipe right + touchend stays expanded (no double-toggle)',
    !statsC.classList.contains('collapsed'));
  statsH.dispatchEvent(touchEvent(window, 'touchstart', 200));
  statsH.dispatchEvent(touchEvent(window, 'touchmove', 100)); // swipe left -> collapse
  statsH.dispatchEvent(touchEvent(window, 'touchend'));       // must NOT expand again
  check('swipe left + touchend stays collapsed (no double-toggle)',
    statsC.classList.contains('collapsed'));
  // A plain tap with no swipe still toggles.
  statsH.dispatchEvent(touchEvent(window, 'touchstart', 100));
  statsH.dispatchEvent(touchEvent(window, 'touchend'));       // tap -> expand
  check('tap without a swipe still toggles', !statsC.classList.contains('collapsed'));

  statsH.dispatchEvent(touchEvent(window, 'touchstart', 100, 100));
  const verticalMove = touchEvent(window, 'touchmove', 60, 180);
  statsH.dispatchEvent(verticalMove);
  statsH.dispatchEvent(touchEvent(window, 'touchmove', -10, 185));
  statsH.dispatchEvent(touchEvent(window, 'touchend'));
  check('vertical scrolling locks its axis and never folds the panel',
    !statsC.classList.contains('collapsed') && !verticalMove.defaultPrevented);

  statsH.dispatchEvent(touchEvent(window, 'touchstart', 100, 100));
  statsH.dispatchEvent(touchEvent(window, 'touchcancel'));
  statsH.dispatchEvent(touchEvent(window, 'touchend'));
  check('cancelled touch and orphan touchend never toggle', !statsC.classList.contains('collapsed'));

  statsH.dispatchEvent(touchEvent(window, 'touchstart', 100, 100));
  statsH.dispatchEvent(touchEvent(window, 'touchmove', 0, 0, [
    { clientX: 200, clientY: 100, identifier: 1 }, { clientX: 250, clientY: 100, identifier: 2 },
  ]));
  statsH.dispatchEvent(touchEvent(window, 'touchend'));
  check('multi-touch cannot fold a panel', !statsC.classList.contains('collapsed'));

  let gameplayTouches = 0;
  const observeTouch = () => { gameplayTouches++; };
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) document.addEventListener(type, observeTouch);
  statsH.dispatchEvent(touchEvent(window, 'touchstart', 100, 100));
  statsH.dispatchEvent(touchEvent(window, 'touchmove', 101, 100));
  statsH.dispatchEvent(touchEvent(window, 'touchend'));
  statsH.dispatchEvent(touchEvent(window, 'touchcancel'));
  check('header touches never bubble to document gameplay controls', gameplayTouches === 0);
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) document.removeEventListener(type, observeTouch);

  // --- Controls panel: autoCollapseOnSmallScreens=true ---
  // Force a small viewport so the resize handler auto-collapses on wire-up.
  Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
  setupCollapsiblePanel({
    name: 'Controls', containerId: 'ctrlContainer', toggleButtonId: 'ctrlToggle',
    headerId: 'ctrlHeader', autoCollapseOnSmallScreens: true,
  });
  const ctrlC = document.getElementById('ctrlContainer');
  check('small-screen auto-collapse runs on wire-up', ctrlC.classList.contains('collapsed'));
  // A resize while already collapsed exercises the "already collapsed" guard.
  window.dispatchEvent(new window.Event('resize'));
  check('resize while collapsed is a no-op', ctrlC.classList.contains('collapsed'));
  const ctrlT = document.getElementById('ctrlToggle');
  ctrlT.click();
  viewport(window, 400, 430);
  check('browser toolbar resize preserves a user-expanded compact panel', !ctrlC.classList.contains('collapsed'));
  viewport(window, 1100, 800);
  check('leaving compact layout does not overwrite disclosure state', !ctrlC.classList.contains('collapsed'));
  viewport(window, 844, 390);
  check('wide landscape phone enters compact layout and folds panel', ctrlC.classList.contains('collapsed'));
  ctrlT.click();
  viewport(window, 844, 420);
  check('landscape toolbar resize preserves user expansion', !ctrlC.classList.contains('collapsed'));

  viewport(window, 600, 800);
  check('600px portrait uses compact controls', isCompactPanelViewport());
  viewport(window, 1200, 500);
  check('500px-high desktop uses short-screen compact controls', isCompactPanelViewport());
  viewport(window, 601, 501);
  check('viewport outside both compact bounds uses desktop controls', !isCompactPanelViewport());

  setPanelCollapsed(statsC, statsT, false);
  setPanelCollapsed(ctrlC, ctrlT, true);
  ctrlT.click();
  check('desktop allows more than one panel to remain expanded',
    !ctrlC.classList.contains('collapsed') && !statsC.classList.contains('collapsed'));
  viewport(window, 390, 844);
  statsAction.focus();
  ctrlT.click();
  check('opening a compact panel folds the other initialized panels',
    !ctrlC.classList.contains('collapsed') && statsC.classList.contains('collapsed')
    && statsContent.inert && statsT.getAttribute('aria-expanded') === 'false');
  check('opening a compact panel keeps focus on its disclosure when a peer folds', document.activeElement === ctrlT);
  setPanelCollapsed(statsC, statsT, false);
  check('programmatic state changes do not unexpectedly operate the accordion',
    !ctrlC.classList.contains('collapsed') && !statsC.classList.contains('collapsed'));

  // --- resetListeners=true: clones the header, re-resolves, wires the clone ---
  setupCollapsiblePanel({
    name: 'Reset', containerId: 'resetContainer', toggleButtonId: 'resetToggle',
    headerId: 'resetHeader', resetListeners: true,
  });
  const resetC = document.getElementById('resetContainer');
  document.getElementById('resetToggle').dispatchEvent(new window.Event('click', { bubbles: true }));
  check('reset-listeners panel wires the cloned header', resetC.classList.contains('collapsed'));

  // A clone failure must retain the same disclosure behavior on the original nodes.
  const fbHeader = document.getElementById('fbHeader');
  fbHeader.replaceWith = function() { throw new Error('replaceWith blew up'); };
  setupCollapsiblePanel({
    name: 'Fallback', containerId: 'fbContainer', toggleButtonId: 'fbToggle',
    headerId: 'fbHeader', resetListeners: true,
  });
  const fbC = document.getElementById('fbContainer');
  const fbT = document.getElementById('fbToggle');
  fbT.dispatchEvent(new window.Event('click', { bubbles: true })); // fallback toggle -> collapse
  check('fallback toggle adds the collapsed class', fbC.classList.contains('collapsed') && fbT.getAttribute('aria-expanded') === 'false');
  fbT.dispatchEvent(new window.Event('click', { bubbles: true })); // fallback toggle -> expand
  check('fallback toggle removes the collapsed class', !fbC.classList.contains('collapsed') && fbT.getAttribute('aria-expanded') === 'true');

  // --- Fallback path WITH a teardown signal: the fallback listeners are removed on
  // abort just like the normal setup. ---
  const fbsHeader = document.getElementById('fbsHeader');
  fbsHeader.replaceWith = function() { throw new Error('replaceWith blew up'); };
  const acFbs = new window.AbortController();
  setupCollapsiblePanel({
    name: 'FallbackSig', containerId: 'fbsContainer', toggleButtonId: 'fbsToggle',
    headerId: 'fbsHeader', resetListeners: true, signal: acFbs.signal,
  });
  const fbsC = document.getElementById('fbsContainer');
  const fbsT = document.getElementById('fbsToggle');
  fbsT.dispatchEvent(new window.Event('click', { bubbles: true }));
  check('fallback-with-signal toggle collapses while the signal is live',
    fbsC.classList.contains('collapsed'));
  acFbs.abort();
  fbsT.dispatchEvent(new window.Event('click', { bubbles: true }));
  check('after abort, the fallback listeners are gone',
    fbsC.classList.contains('collapsed'));

  // --- teardown signal threading (camera tray; PR #383) ---
  // The camera tray passes `signal` + autoCollapseOnSmallScreens: aborting the signal
  // must remove EVERY listener this call registered — most importantly the
  // WINDOW-level auto-collapse resize listener, which would otherwise outlive the
  // torn-down tray and stack one copy per game.
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  const acSig = new window.AbortController();
  setupCollapsiblePanel({
    name: 'Sig', containerId: 'sigContainer', toggleButtonId: 'sigToggle',
    headerId: 'sigHeader', autoCollapseOnSmallScreens: true, signal: acSig.signal,
  });
  const sigC = document.getElementById('sigContainer');
  const sigT = document.getElementById('sigToggle');
  check('wire-up on a large screen leaves the panel expanded', !sigC.classList.contains('collapsed'));
  Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
  window.dispatchEvent(new window.Event('resize'));
  check('resize to a small screen auto-collapses the panel (signal live)',
    sigC.classList.contains('collapsed'));
  sigT.dispatchEvent(new window.Event('click', { bubbles: true })); // expand again
  check('toggle still works while the signal is live', !sigC.classList.contains('collapsed'));
  acSig.abort(); // teardown
  window.dispatchEvent(new window.Event('resize'));
  check('after abort, the window-level auto-collapse resize listener is gone',
    !sigC.classList.contains('collapsed'));
  sigT.dispatchEvent(new window.Event('click', { bubbles: true }));
  check('after abort, the toggle/header listeners are gone',
    !sigC.classList.contains('collapsed'));

  // Rewiring must remove both DOM and global listeners even without cloning, and
  // an earlier owner's teardown must not affect the newly wired panel.
  viewport(window, 1200, 800);
  const previousOwner = new window.AbortController();
  const currentOwner = new window.AbortController();
  const rewireOptions = {
    name: 'Rewire', containerId: 'rewireContainer', toggleButtonId: 'rewireToggle', headerId: 'rewireHeader',
  };
  setupCollapsiblePanel({ ...rewireOptions, autoCollapseOnSmallScreens: true, signal: previousOwner.signal });
  setupCollapsiblePanel({ ...rewireOptions, signal: currentOwner.signal });
  const rewireC = document.getElementById('rewireContainer');
  const rewireT = document.getElementById('rewireToggle');
  rewireT.click();
  check('repeated setup without cloning keeps one disclosure listener', rewireC.classList.contains('collapsed'));
  previousOwner.abort();
  rewireT.click();
  check('an old teardown signal cannot remove the current panel listeners', !rewireC.classList.contains('collapsed'));
  viewport(window, 390, 844);
  check('repeated setup removes the previous window resize listener', !rewireC.classList.contains('collapsed'));
  currentOwner.abort();
  rewireT.click();
  check('the current teardown signal removes the replacement listeners', !rewireC.classList.contains('collapsed'));

  viewport(window, 1200, 800);
  const cloneOptions = {
    name: 'Clone', containerId: 'cloneContainer', toggleButtonId: 'cloneToggle', headerId: 'cloneHeader', resetListeners: true,
  };
  setupCollapsiblePanel({ ...cloneOptions, autoCollapseOnSmallScreens: true });
  const staleToggle = document.getElementById('cloneToggle');
  setupCollapsiblePanel(cloneOptions);
  staleToggle.click();
  const cloneC = document.getElementById('cloneContainer');
  check('resetListeners removes listeners from the detached header', !cloneC.classList.contains('collapsed'));
  viewport(window, 390, 844);
  check('resetListeners also removes the previous window resize listener', !cloneC.classList.contains('collapsed'));

  const abortedOwner = new window.AbortController();
  abortedOwner.abort();
  setupCollapsiblePanel({
    name: 'Aborted', containerId: 'abortedContainer', toggleButtonId: 'abortedToggle', headerId: 'abortedHeader',
    signal: abortedOwner.signal, autoCollapseOnSmallScreens: true,
  });
  document.getElementById('abortedToggle').click();
  check('an already-aborted owner never wires or changes a panel',
    !document.getElementById('abortedContainer').classList.contains('collapsed'));

  console.log(`\nCOLLAPSIBLE-PANEL TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('collapsible-panel test crashed:', err);
  process.exit(1);
});
