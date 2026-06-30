// @ts-check
// difficulty-picker-tests.js
// Headless, c8-instrumented coverage for src/ui/difficulty-picker.ts — the shared
// ●Bunny / ■Blue / ◆Black radiogroup widget used by BOTH the start screen and the
// finish/game-over overlay. The start-menu suite exercises it through the start screen
// (build + click + arrow keys + rebuild), but the programmatic setSelected() path and
// the unknown-id guards are only reachable from the finish-screen wiring, so cover them
// directly here. Run via the register-ts-resolve loader so the module's `./*.js` sibling
// imports resolve to their `.ts` sources.

'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

async function main() {
  console.log('--- difficulty-picker.ts (shared widget) ---');
  const { setupDom } = await import('./mocks/dom.mjs');
  setupDom();

  const { buildDifficultyPicker } = await import('../src/ui/difficulty-picker.ts');

  function makeContainer() {
    const el = document.createElement('div');
    el.setAttribute('role', 'radiogroup');
    document.body.appendChild(el);
    return el;
  }

  // --- Build: heading + one role=radio option per tier, with labels + blurbs ---
  {
    const container = makeContainer();
    const handle = buildDifficultyPicker(container, { initial: 'blue', heading: 'Play again on' });
    const options = container.querySelectorAll('.difficulty-option');
    check('renders one option per tier (3)', options.length === 3);
    check('heading text is configurable', container.querySelector('.difficulty-heading').textContent === 'Play again on');
    check('options carry role=radio + data-difficulty', Array.from(options).every(
      (o) => o.getAttribute('role') === 'radio' && !!o.getAttribute('data-difficulty')));
    check('options render name + blurb spans', container.querySelector('.difficulty-name') && container.querySelector('.difficulty-blurb'));
    check('renders the config labels (◆ Black present)', /◆ Black/.test(container.textContent));
    check('getSelected reflects the initial tier', handle.getSelected() === 'blue');
    const blue = container.querySelector('[data-difficulty="blue"]');
    check('initial option is selected + aria-checked + tabbable',
      blue.classList.contains('selected') && blue.getAttribute('aria-checked') === 'true' && blue.getAttribute('tabindex') === '0');
    const others = Array.from(options).filter((o) => o.getAttribute('data-difficulty') !== 'blue');
    check('only the selected option is tabbable (roving tabindex)',
      others.every((o) => o.getAttribute('tabindex') === '-1' && o.getAttribute('aria-checked') === 'false'));
  }

  // --- Click selects + fires onChange (once, with the clicked tier) ---
  {
    const container = makeContainer();
    const changes = [];
    const handle = buildDifficultyPicker(container, { initial: 'blue', onChange: (id) => changes.push(id) });
    check('onChange does NOT fire on build', changes.length === 0);
    container.querySelector('[data-difficulty="black"]').dispatchEvent(new window.Event('click'));
    check('click updates the live selection', handle.getSelected() === 'black');
    check('click fires onChange with the clicked tier', changes.length === 1 && changes[0] === 'black');
    const black = container.querySelector('[data-difficulty="black"]');
    const blue = container.querySelector('[data-difficulty="blue"]');
    check('click moves the highlight (blue deselected, black selected)',
      black.classList.contains('selected') && !blue.classList.contains('selected'));
  }

  // --- Arrow keys move + wrap + focus + fire onChange ---
  {
    const container = makeContainer();
    const changes = [];
    buildDifficultyPicker(container, { initial: 'blue', onChange: (id) => changes.push(id) });
    container.querySelector('[data-difficulty="blue"]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    check('ArrowDown moves to the next tier (blue -> black)',
      changes[changes.length - 1] === 'black'
      && container.querySelector('[data-difficulty="black"]').getAttribute('tabindex') === '0');
    container.querySelector('[data-difficulty="black"]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    check('ArrowDown wraps from the last tier back to the first (black -> bunny)',
      changes[changes.length - 1] === 'bunny');
    container.querySelector('[data-difficulty="bunny"]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    check('ArrowUp wraps from the first tier to the last (bunny -> black)',
      changes[changes.length - 1] === 'black');
    container.querySelector('[data-difficulty="black"]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    check('ArrowRight behaves like ArrowDown (next tier)', changes[changes.length - 1] === 'bunny');
    container.querySelector('[data-difficulty="bunny"]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    check('ArrowLeft behaves like ArrowUp (previous tier)', changes[changes.length - 1] === 'black');
  }

  // --- setSelected: programmatic sync that does NOT fire onChange ---
  {
    const container = makeContainer();
    const changes = [];
    const handle = buildDifficultyPicker(container, { initial: 'blue', onChange: (id) => changes.push(id) });
    handle.setSelected('bunny');
    check('setSelected updates the selection', handle.getSelected() === 'bunny');
    check('setSelected does NOT fire onChange (programmatic, not a user gesture)', changes.length === 0);
    check('setSelected moves the highlight + aria + tabindex',
      container.querySelector('[data-difficulty="bunny"]').classList.contains('selected')
      && container.querySelector('[data-difficulty="bunny"]').getAttribute('tabindex') === '0');
    handle.setSelected(/** @type {any} */('nonsense'));
    check('setSelected ignores an unknown tier id (selection unchanged)', handle.getSelected() === 'bunny');
  }

  // --- Junk initial falls back to the first tier (never throws / never undefined) ---
  {
    const container = makeContainer();
    const handle = buildDifficultyPicker(container, { initial: /** @type {any} */('garbage') });
    check('junk initial falls back to the first tier (bunny)', handle.getSelected() === 'bunny');
  }

  console.log(`\nDIFFICULTY-PICKER TEST TOTAL: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
