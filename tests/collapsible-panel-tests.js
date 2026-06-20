// collapsible-panel-tests.js
// Headless, c8-instrumented coverage for src/ui/collapsible-panel.ts — the shared
// collapse / auto-collapse / horizontal-swipe behavior for the HUD panels.
//
// The browser suites mount the panels but never simulate touch swipes, a small
// screen, or the header-clone failure path, so those branches sit uncovered on
// Codecov. We import the REAL module (Node strips the types; c8 attributes coverage
// to the real src path) and drive the DOM events directly under jsdom.

'use strict';

const { JSDOM } = require('jsdom');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

// jsdom lacks a TouchEvent constructor; the handlers only read e.touches[0].clientX
// and call preventDefault(), so a plain Event with a `touches` shim is enough.
function touchEvent(window, type, clientX) {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'touches', { value: [{ clientX }] });
  return ev;
}

function panelHtml(prefix) {
  return `
    <div id="${prefix}Container">
      <div id="${prefix}Header"><button id="${prefix}Toggle">▲</button></div>
    </div>`;
}

async function main() {
  console.log('--- collapsible-panel.ts ---');

  const dom = new JSDOM(`<!doctype html><body>
    ${panelHtml('stats')}
    ${panelHtml('ctrl')}
    ${panelHtml('reset')}
    ${panelHtml('fb')}
  </body>`, { url: 'https://snowglider.ai/', pretendToBeVisual: true });
  const { window } = dom;
  global.window = window;
  global.document = window.document;

  const { setupCollapsiblePanel } = await import('../src/ui/collapsible-panel.ts');

  // --- Missing elements -> warn + early return ---
  setupCollapsiblePanel({ name: 'Nope', containerId: 'missingC', toggleButtonId: 'missingT', headerId: 'missingH' });
  check('missing elements: no panel container gets a collapsed class', true);

  // --- Stats panel: resetListeners=false (wire nodes directly) ---
  setupCollapsiblePanel({ name: 'Stats', containerId: 'statsContainer', toggleButtonId: 'statsToggle', headerId: 'statsHeader' });
  const statsC = document.getElementById('statsContainer');
  const statsT = document.getElementById('statsToggle');
  const statsH = document.getElementById('statsHeader');

  statsT.dispatchEvent(new window.Event('click', { bubbles: true })); // toggle -> collapsed
  check('toggle button collapses the panel',
    statsC.classList.contains('collapsed') && statsT.textContent === '▼');

  statsH.dispatchEvent(new window.Event('click', { bubbles: true })); // header click -> expand
  check('header click expands the panel',
    !statsC.classList.contains('collapsed') && statsT.textContent === '▲');

  statsH.dispatchEvent(touchEvent(window, 'touchend')); // touchend -> collapse
  check('header touchend toggles the panel', statsC.classList.contains('collapsed'));

  // Swipe right while collapsed -> expand; swipe left while expanded -> collapse.
  statsH.dispatchEvent(touchEvent(window, 'touchstart', 100));
  statsH.dispatchEvent(touchEvent(window, 'touchmove', 200)); // diff +100 -> expand
  check('swipe right expands a collapsed panel', !statsC.classList.contains('collapsed'));
  statsH.dispatchEvent(touchEvent(window, 'touchstart', 200));
  statsH.dispatchEvent(touchEvent(window, 'touchmove', 100)); // diff -100 -> collapse
  check('swipe left collapses an expanded panel', statsC.classList.contains('collapsed'));

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

  // --- resetListeners=true: clones the header, re-resolves, wires the clone ---
  setupCollapsiblePanel({
    name: 'Reset', containerId: 'resetContainer', toggleButtonId: 'resetToggle',
    headerId: 'resetHeader', resetListeners: true,
  });
  const resetC = document.getElementById('resetContainer');
  document.getElementById('resetToggle').dispatchEvent(new window.Event('click', { bubbles: true }));
  check('reset-listeners panel wires the cloned header', resetC.classList.contains('collapsed'));

  // --- Fallback path: make header.replaceWith throw so setupCollapsiblePanel's
  // try block fails before any cloning, and wireFallback wires the original
  // still-in-DOM nodes (no second listener on a stray clone). ---
  const fbHeader = document.getElementById('fbHeader');
  fbHeader.replaceWith = function() { throw new Error('replaceWith blew up'); };
  setupCollapsiblePanel({
    name: 'Fallback', containerId: 'fbContainer', toggleButtonId: 'fbToggle',
    headerId: 'fbHeader', resetListeners: true,
  });
  const fbC = document.getElementById('fbContainer');
  const fbT = document.getElementById('fbToggle');
  fbT.dispatchEvent(new window.Event('click', { bubbles: true })); // fallback toggle -> collapse
  check('fallback toggle adds the collapsed class', fbC.classList.contains('collapsed') && fbT.textContent === '▼');
  fbT.dispatchEvent(new window.Event('click', { bubbles: true })); // fallback toggle -> expand
  check('fallback toggle removes the collapsed class', !fbC.classList.contains('collapsed') && fbT.textContent === '▲');

  console.log(`\nCOLLAPSIBLE-PANEL TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('collapsible-panel test crashed:', err);
  process.exit(1);
});
