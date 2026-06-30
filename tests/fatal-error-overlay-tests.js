// @ts-check
// fatal-error-overlay-tests.js
// Headless coverage for src/ui/fatal-error-overlay.ts — the last-resort recovery UI the
// run loop (game/main-loop.ts `animate`) shows when a frame throws an uncaught error.
//
// The overlay turns the old "silent frozen screen" failure mode (rAF rescheduled at the
// top of the frame, so a throwing frame spins forever) into a one-tap reload. These
// tests drive the module directly under jsdom: it builds once, re-shows idempotently,
// surfaces the error message, and its Reload button invokes the recovery action.

'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

async function main() {
  console.log('--- fatal-error-overlay.ts ---');
  const { setupDom } = await import('./mocks/dom.mjs');
  setupDom();

  const { showFatalErrorOverlay, resetFatalErrorOverlay } = await import('../src/ui/fatal-error-overlay.ts');

  // --- Builds the overlay with a reload button, visible, above the game-over overlay ---
  {
    resetFatalErrorOverlay();
    const el = showFatalErrorOverlay(new Error('module boom'));
    check('returns the overlay element', !!el && el.id === 'fatalErrorOverlay');
    check('overlay is attached to the document body', document.getElementById('fatalErrorOverlay') === el);
    check('overlay is visible', el.style.display === 'flex');
    check('overlay sits above the game-over overlay (z-index 1000)', Number(el.style.zIndex) > 1000);
    check('has a Reload button', !!document.getElementById('fatalErrorReloadBtn'));
    check('surfaces the error message', /module boom/.test(document.getElementById('fatalErrorMessage').textContent));
  }

  // --- Idempotent: a second call reuses the same node (no duplicates) ---
  {
    const first = document.getElementById('fatalErrorOverlay');
    const again = showFatalErrorOverlay(new Error('second boom'));
    check('reuses the single overlay node', again === first);
    check('only one overlay exists in the DOM', document.querySelectorAll('#fatalErrorOverlay').length === 1);
    check('updates the message on re-show', /second boom/.test(document.getElementById('fatalErrorMessage').textContent));
  }

  // --- The Reload button invokes the (injected) recovery action ---
  {
    resetFatalErrorOverlay();
    let reloads = 0;
    showFatalErrorOverlay(new Error('boom'), { onReload: () => { reloads++; } });
    document.getElementById('fatalErrorReloadBtn').click();
    check('clicking Reload fires the recovery action', reloads === 1);
  }

  // --- Non-Error / missing payloads are handled without throwing ---
  {
    resetFatalErrorOverlay();
    const el = showFatalErrorOverlay(undefined);
    check('no error payload still shows a generic message', !!el && /unexpected error/.test(document.getElementById('fatalErrorMessage').textContent));
    // An arbitrary object must not be stringified into the copy.
    showFatalErrorOverlay({ weird: true });
    check('non-Error object payload does not leak [object Object]', !/\[object Object\]/.test(document.getElementById('fatalErrorMessage').textContent));
  }

  // --- resetFatalErrorOverlay detaches the node so a fresh run starts clean ---
  {
    resetFatalErrorOverlay();
    check('reset removes the overlay from the DOM', document.getElementById('fatalErrorOverlay') === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
