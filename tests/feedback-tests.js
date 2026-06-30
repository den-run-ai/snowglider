// @ts-check
// feedback-tests.js
// Headless, c8-instrumented coverage for src/ui/feedback.ts - the in-game
// feature-request / bug-report helper behind the start screen's "💬 Feedback"
// button (issue #258).
//
// feedback.ts imports nothing (no three.js / Firebase / DOM module), so we import
// the REAL `.ts` directly - Node 23 type-strips it and c8 instruments it with
// correct source-mapped lines. We set up jsdom first so importing the module (its
// self-init wires the start-screen button) and the modal builder are exercised for
// real. The Analytics / window.open seams are reached via the jsdom `window`.
// Run via the `test:feedback` npm script (`node tests/feedback-tests.js`).

const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<!doctype html><html><head>
  <meta name="build-id" content="2026-06-30 05:00">
</head><body>
  <div id="startGameContainer">
    <div id="difficultyPicker"></div>
    <div id="startMenu">
      <button id="startGameButton">Start Game</button>
      <button id="aboutGameButton">About</button>
      <button id="feedbackButton">💬 Feedback</button>
    </div>
  </div>
</body></html>`, { url: 'https://snowglider.ai/play' });

const { window } = dom;
const g = /** @type {any} */ (globalThis);
g.window = window;
g.document = window.document;
// feedback.ts uses bare `instanceof HTMLInputElement` / `HTMLTextAreaElement`,
// which resolve to globalThis; expose jsdom's constructors there.
g.HTMLInputElement = window.HTMLInputElement;
g.HTMLTextAreaElement = window.HTMLTextAreaElement;
g.navigator = window.navigator;

// Capture window.open (jsdom's is a not-implemented stub).
/** @type {string | null} */
let openedUrl = null;
window.open = (/** @type {string} */ url) => { openedUrl = url; return null; };

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS ✅' : 'FAIL ❌'}: ${name}`);
  if (condition) pass++; else fail++;
}

async function main() {
  const {
    buildFeedbackIssueUrl, buildIssueBody, collectContext, truncate,
    isFeedbackCategory, logFeedbackEvent, openFeedback, initFeedback,
    FEEDBACK_CATEGORIES, FEEDBACK_LABEL,
  } = await import('../src/ui/feedback.ts');

  // ---- isFeedbackCategory ----
  console.log('--- isFeedbackCategory ---');
  check('accepts feature', isFeedbackCategory('feature') === true);
  check('accepts bug', isFeedbackCategory('bug') === true);
  check('accepts general', isFeedbackCategory('general') === true);
  check('rejects unknown string', isFeedbackCategory('nope') === false);
  check('rejects non-string', isFeedbackCategory(undefined) === false);

  // ---- truncate ----
  console.log('--- truncate ---');
  check('passes through short text', truncate('hello', 10) === 'hello');
  check('truncates with ellipsis', truncate('abcdef', 4) === 'abc…');
  check('ellipsis keeps length at max', truncate('abcdef', 4).length === 4);
  check('non-string -> empty', truncate(/** @type {any} */ (null)) === '');

  // ---- buildFeedbackIssueUrl: structure ----
  console.log('--- buildFeedbackIssueUrl ---');
  const url = buildFeedbackIssueUrl({ category: 'feature', message: 'Add a replay mode' });
  check('targets the snowglider new-issue endpoint',
    url.startsWith('https://github.com/den-run-ai/snowglider/issues/new?'));
  const parsed = new URL(url);
  check('title carries the [Feature] prefix + first line',
    parsed.searchParams.get('title') === '[Feature] Add a replay mode');
  check('body contains the message', (parsed.searchParams.get('body') || '').includes('Add a replay mode'));
  // The URL must NOT carry a `labels` param: GitHub 404s the /issues/new form for
  // users without label permission (i.e. ordinary players). Labels are applied
  // repo-side (templates / title prefix), not via the query string.
  check('URL omits the labels param (avoids 404 for non-collaborators)',
    parsed.searchParams.get('labels') === null && !url.includes('labels='));

  const bugUrl = new URL(buildFeedbackIssueUrl({ category: 'bug', message: 'Avalanche clips through trees' }));
  check('bug title prefix', bugUrl.searchParams.get('title') === '[Bug] Avalanche clips through trees');
  check('bug URL also omits labels', bugUrl.searchParams.get('labels') === null);

  const genUrl = new URL(buildFeedbackIssueUrl({ category: 'general', message: 'Love the game' }));
  check('general title prefix', genUrl.searchParams.get('title') === '[Feedback] Love the game');

  const fbUrl = new URL(buildFeedbackIssueUrl({ category: /** @type {any} */ ('bogus'), message: 'x' }));
  check('invalid category defaults to [Feature]', (fbUrl.searchParams.get('title') || '').startsWith('[Feature]'));

  const multiline = new URL(buildFeedbackIssueUrl({ category: 'feature', message: '\n\n  First real line\nsecond' }));
  check('title picks first non-empty line', multiline.searchParams.get('title') === '[Feature] First real line');

  const longTitle = new URL(buildFeedbackIssueUrl({ category: 'feature', message: 'x'.repeat(200) }));
  check('long title is bounded (<= prefix + 80)',
    (longTitle.searchParams.get('title') || '').length <= '[Feature] '.length + 80);

  const emptyUrl = new URL(buildFeedbackIssueUrl({ category: 'feature', message: '' }));
  check('empty message title falls back', emptyUrl.searchParams.get('title') === '[Feature] feedback');
  check('empty message body placeholder', (emptyUrl.searchParams.get('body') || '').includes('no description provided'));

  // ---- buildIssueBody: context rendering ----
  console.log('--- buildIssueBody ---');
  const body = buildIssueBody({
    category: 'bug',
    message: 'It broke',
    context: { build: 'abc123', url: 'https://x/', viewport: '800x600', userAgent: 'TestUA' },
  });
  check('body has the message', body.includes('It broke'));
  check('body renders build context', body.includes('abc123'));
  check('body renders viewport', body.includes('800x600'));
  check('body renders user agent', body.includes('TestUA'));
  check('body has the submitted-from footer', body.includes('in-game feedback form'));

  const bodyNoCtx = buildIssueBody({ category: 'feature', message: 'Just text' });
  check('body without context omits the Context heading', !bodyNoCtx.includes('### Context'));

  const diagBody = buildIssueBody({ category: 'bug', message: 'm', context: { diagnostics: '{"fps":60}' } });
  check('diagnostics render in a details block', diagBody.includes('<details>') && diagBody.includes('{"fps":60}'));

  // ---- collectContext: opt-in gating ----
  console.log('--- collectContext ---');
  // Opt-OUT: nothing is attached — no build, URL, viewport, or user-agent. This is
  // the privacy contract behind the "Include diagnostics" checkbox.
  const optedOut = collectContext(false);
  check('opt-out attaches NO build', optedOut.build === undefined);
  check('opt-out attaches NO url (no query-string leak)', optedOut.url === undefined);
  check('opt-out attaches NO viewport', optedOut.viewport === undefined);
  check('opt-out attaches NO user agent', optedOut.userAgent === undefined);
  check('opt-out attaches NO diagnostics', optedOut.diagnostics === undefined);

  // Opt-IN (no diag API present yet): device/page context is collected.
  const ctx = collectContext(true);
  check('opt-in reads the build-id meta', ctx.build === '2026-06-30 05:00');
  check('opt-in reads the location', ctx.url === 'https://snowglider.ai/play');
  check('opt-in reads the viewport', typeof ctx.viewport === 'string' && ctx.viewport.includes('x'));
  check('opt-in reads the user agent', typeof ctx.userAgent === 'string' && ctx.userAgent.length > 0);
  check('opt-in omits diagnostics trace when no diag API present', ctx.diagnostics === undefined);

  // Opt-IN with a diagnostics API: serialise via __snowgliderDiag.snapshot() (NOT
  // dump(), which would trigger a file download). dump is present here to assert
  // we never call it.
  let dumpCalls = 0;
  g.window.__snowgliderDiag = { snapshot: () => ({ fps: 60, ok: true }), dump: () => { dumpCalls++; return {}; } };
  const withDiag = collectContext(true);
  check('opt-in serialises diagnostics when available', (withDiag.diagnostics || '').includes('"fps":60'));
  check('collectContext uses snapshot(), never the downloading dump()', dumpCalls === 0);
  check('opt-out still attaches nothing even when a diag API exists', collectContext(false).diagnostics === undefined);
  delete g.window.__snowgliderDiag;

  // ---- logFeedbackEvent: analytics seam ----
  console.log('--- logFeedbackEvent ---');
  /** @type {{ name: string, params: { category?: string } } | null} */
  let logged = null;
  g.window.firebaseModules = { logEvent: (/** @type {string} */ name, /** @type {{category?: string}} */ params) => { logged = { name, params }; } };
  logFeedbackEvent('feature');
  check('fires feedback_submitted', logged && logged.name === 'feedback_submitted');
  check('carries only the category dimension', logged && logged.params && logged.params.category === 'feature');

  // ---- DOM: button wiring + modal flow ----
  console.log('--- modal flow ---');
  // The self-init at import time already wired #feedbackButton; calling initFeedback
  // again must be idempotent (data-flag guard).
  initFeedback();
  const btn = document.getElementById('feedbackButton');
  if (btn) btn.click();
  let overlay = document.getElementById('feedbackOverlay');
  check('clicking the start-screen button opens the modal',
    !!overlay && overlay.style.display === 'flex');

  // Submitting with an empty message shows an error and does NOT open GitHub.
  openedUrl = null;
  logged = null;
  const submitBtn = document.getElementById('feedbackSubmit');
  if (submitBtn) submitBtn.click();
  const errEl = document.getElementById('feedbackError');
  check('empty submit shows an error', !!errEl && errEl.style.display === 'block');
  check('empty submit does not open GitHub', openedUrl === null);

  // Fill it in, pick the bug category, opt into diagnostics, submit.
  const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById('feedbackMessage'));
  ta.value = 'Tree collision feels off';
  const bugRadio = /** @type {HTMLInputElement} */ (document.querySelector('input[name="feedbackCategory"][value="bug"]'));
  bugRadio.checked = true;
  const diagCheck = /** @type {HTMLInputElement} */ (document.getElementById('feedbackIncludeDiagnostics'));
  diagCheck.checked = true;
  if (submitBtn) submitBtn.click();
  check('submit opens a prefilled GitHub issue URL',
    typeof openedUrl === 'string' && openedUrl.includes('/issues/new?'));
  check('submit URL carries the [Bug] title',
    typeof openedUrl === 'string' &&
    new URL(openedUrl).searchParams.get('title') === '[Bug] Tree collision feels off');
  check('submit fires the analytics event with the bug category',
    logged && logged.name === 'feedback_submitted' && logged.params.category === 'bug');
  check('submit closes the modal', overlay !== null && overlay.style.display === 'none');
  check('submit clears the textarea', ta.value === '');

  // ---- DOM: keystroke isolation (Codex P1) ----
  console.log('--- keystroke isolation ---');
  // Mimic start-menu.ts's document-level keydown handler that starts the run on
  // Enter/Space. With the modal open, in-modal keystrokes must NOT reach it.
  /** @type {boolean} */
  let docSawKey = false;
  const docHandler = () => { docSawKey = true; };
  document.addEventListener('keydown', docHandler);

  // Codex P2: Enter/Space on the (focusable) start-screen button must not bubble
  // to the start-menu handler either, or keyboard-activating it would start the run.
  if (btn) {
    btn.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    check('Space on the feedback button does not reach the start-menu handler', docSawKey === false);
    btn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    check('Enter on the feedback button does not reach the start-menu handler', docSawKey === false);
    // A non-activation key (e.g. Tab) is left alone to bubble normally.
    btn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    check('Tab on the feedback button still bubbles (not swallowed)', docSawKey);
    docSawKey = false;
  }

  if (btn) btn.click(); // reopen
  overlay = document.getElementById('feedbackOverlay');
  const ta2 = /** @type {HTMLTextAreaElement} */ (document.getElementById('feedbackMessage'));
  ta2.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  check('space typed in the modal does not bubble to the start-menu handler', docSawKey === false);
  // Escape on the overlay closes the modal.
  ta2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape inside the modal closes it', overlay !== null && overlay.style.display === 'none');
  check('Escape did not reach the start-menu handler either', docSawKey === false);
  document.removeEventListener('keydown', docHandler);

  // ---- DOM: cancel + backdrop close ----
  console.log('--- close paths ---');
  if (btn) btn.click();
  overlay = document.getElementById('feedbackOverlay');
  const cancelBtn = document.getElementById('feedbackCancel');
  if (cancelBtn) cancelBtn.click();
  check('cancel closes the modal', overlay !== null && overlay.style.display === 'none');

  if (btn) btn.click();
  overlay = document.getElementById('feedbackOverlay');
  // Backdrop click (target === overlay) closes; a click on the panel does not.
  const panel = document.getElementById('feedbackPanel');
  if (panel) panel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('clicking inside the panel keeps the modal open',
    overlay !== null && overlay.style.display === 'flex');
  if (overlay) overlay.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('clicking the backdrop closes the modal', overlay !== null && overlay.style.display === 'none');

  // ---- category table sanity ----
  console.log('--- FEEDBACK_CATEGORIES ---');
  check('every category carries the shared game-feedback label',
    ['feature', 'bug', 'general'].every((k) => FEEDBACK_CATEGORIES[k].issueLabels.includes(FEEDBACK_LABEL)));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
