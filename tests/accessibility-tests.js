// @ts-check
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

async function main() {
  const dom = new JSDOM(`<body>
    <div id="gameAnnouncements" role="status" aria-live="polite"></div>
    <button id="gameControl">Reset</button>
    <section id="start"><button id="startButton">Start</button><button id="feedbackButton">Feedback</button></section>
    <div id="collapsed" inert><button>Hidden</button></div>
    <div id="feedback" style="display:none"><textarea id="message"></textarea><button id="cancel">Cancel</button></div>
  </body>`, { pretendToBeVisual: true });
  const g = /** @type {any} */ (globalThis);
  g.document = dom.window.document;
  g.window = dom.window;
  const { document } = dom.window;
  const { openOverlayFocus, closeOverlayFocus, announceGameStatus } = await import('../src/ui/accessibility.ts');
  const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  // jsdom does not reflect native inert, but its property state is sufficient here.
  el('collapsed').inert = true;
  openOverlayFocus(el('start'), { initialFocus: el('startButton'), modal: false });
  assert.equal(el('gameControl').inert, true);
  assert.equal(document.activeElement, el('startButton'));
  assert.notEqual(el('gameAnnouncements').inert, true);

  el('feedbackButton').focus();
  // Dialog was already present while the start page was isolated. Opening it
  // must temporarily allow that root even when the previous scope made it inert.
  el('feedback').style.display = 'block';
  openOverlayFocus(el('feedback'), { initialFocus: el('message'), onEscape() {
    el('feedback').style.display = 'none';
    closeOverlayFocus(el('feedback'));
  } });
  assert.equal(el('feedback').inert, false);
  assert.equal(el('start').inert, true);
  assert.equal(document.activeElement, el('message'));
  const late = document.createElement('button');
  document.body.appendChild(late);
  await Promise.resolve();
  assert.equal(late.inert, true, 'late game controls stay blocked');
  el('message').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.activeElement, el('feedbackButton'));
  assert.notEqual(el('start').inert, true);
  closeOverlayFocus(el('start'), false);
  assert.notEqual(el('gameControl').inert, true);
  assert.equal(el('collapsed').inert, true, 'nested state survives modal restoration');

  announceGameStatus('Checkpoint 1. 12.50 seconds.');
  assert.equal(el('gameAnnouncements').textContent, 'Checkpoint 1. 12.50 seconds.');
  const afterClose = document.createElement('button');
  document.body.appendChild(afterClose);
  await Promise.resolve();
  assert.notEqual(afterClose.inert, true, 'closed overlays leave no active observer');
  document.body.insertAdjacentHTML('beforeend', `<div id="gameStatsContainer">
    <div id="gameStatsHeader"><button id="toggleStats">▲</button></div>
    <div id="gameStatsContent">Stats</div></div>`);
  const { initializeGameStats } = await import('../src/ui/hud.ts');
  initializeGameStats();
  initializeGameStats(); // DOM-ready followed by Start must not double-wire clicks
  el('toggleStats').click();
  assert.equal(el('toggleStats').getAttribute('aria-expanded'), 'false');
  assert.equal(el('gameStatsContent').inert, true);
  const result = document.createElement('section');
  result.setAttribute('role', 'dialog');
  result.innerHTML = '<button id="nestedTrigger" aria-expanded="true">Account</button><div id="nestedOptions"><button id="nestedProvider">Sign in</button></div>';
  document.body.appendChild(result);
  result.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    el('nestedTrigger').setAttribute('aria-expanded', 'false');
    el('nestedOptions').style.display = 'none';
    el('nestedTrigger').focus();
    event.stopPropagation();
  });
  openOverlayFocus(result, { initialFocus: el('nestedProvider') });
  el('nestedProvider').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(el('nestedTrigger').getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, el('nestedTrigger'));
  assert.equal(el('gameControl').inert, true, 'nested Escape does not dismiss the result focus boundary');
  closeOverlayFocus(result, false);
  dom.window.close();
  console.log('Accessibility: focus entry/restore, nested isolation, dynamic controls, cleanup, and event announcements pass.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
