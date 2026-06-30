// @ts-check
// feedback-tests.js
// Focused, headless coverage for src/ui/feedback.ts - the in-game feature-request /
// bug-report helper behind the start screen's "💬 Feedback" button (issue #258).
//
// feedback.ts imports nothing (no three.js / Firebase / DOM module), so we import
// the REAL `.ts` directly - Node 23 type-strips it and c8 instruments it with
// correct source-mapped lines. The module's DOM code is all inside functions the
// pure-helper tests never call, and its self-init block is guarded by
// `typeof document !== 'undefined'`, so importing it under Node is side-effect free.
// The Analytics seam is reached via `window.firebaseModules`, so that case installs
// a stub and restores it. Run via `test:feedback` (`node tests/feedback-tests.js`).

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS ✅' : 'FAIL ❌'}: ${name}`);
  if (condition) pass++; else fail++;
}

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
function clearGlobal(name) {
  if (Object.prototype.hasOwnProperty.call(globalThis, name)) delete globalThis[name];
}

async function main() {
  const {
    buildFeedbackIssueUrl, buildIssueBody, collectContext, truncate,
    isFeedbackCategory, logFeedbackEvent, FEEDBACK_CATEGORIES, FEEDBACK_LABEL,
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
  check('labels include enhancement + game-feedback',
    parsed.searchParams.get('labels') === 'enhancement,game-feedback');

  // bug category mapping
  const bugUrl = new URL(buildFeedbackIssueUrl({ category: 'bug', message: 'Avalanche clips through trees' }));
  check('bug title prefix', bugUrl.searchParams.get('title') === '[Bug] Avalanche clips through trees');
  check('bug labels include bug + game-feedback', bugUrl.searchParams.get('labels') === 'bug,game-feedback');

  // general category mapping
  const genUrl = new URL(buildFeedbackIssueUrl({ category: 'general', message: 'Love the game' }));
  check('general title prefix', genUrl.searchParams.get('title') === '[Feedback] Love the game');
  check('general labels = game-feedback only', genUrl.searchParams.get('labels') === FEEDBACK_LABEL);

  // invalid category falls back to feature (default)
  const fbUrl = new URL(buildFeedbackIssueUrl({ category: /** @type {any} */ ('bogus'), message: 'x' }));
  check('invalid category defaults to [Feature]', (fbUrl.searchParams.get('title') || '').startsWith('[Feature]'));

  // title uses first non-empty line and is bounded
  const multiline = new URL(buildFeedbackIssueUrl({ category: 'feature', message: '\n\n  First real line\nsecond' }));
  check('title picks first non-empty line', multiline.searchParams.get('title') === '[Feature] First real line');

  const longTitle = new URL(buildFeedbackIssueUrl({ category: 'feature', message: 'x'.repeat(200) }));
  check('long title is bounded (<= prefix + 80)',
    (longTitle.searchParams.get('title') || '').length <= '[Feature] '.length + 80);

  // empty message -> graceful title + placeholder body
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

  // ---- collectContext: guarded reads ----
  console.log('--- collectContext ---');
  // No DOM/window globals in Node -> returns an (almost) empty object, never throws.
  const bare = collectContext(false);
  check('collectContext returns an object with no globals', bare && typeof bare === 'object');
  check('collectContext skips diagnostics when none present', bare.diagnostics === undefined);

  // With a __snowgliderDiag dump available and opt-in.
  setGlobal('window', { __snowgliderDiag: { dump: () => ({ fps: 60, ok: true }) } });
  const withDiag = collectContext(true);
  check('collectContext serialises diagnostics when opted in', (withDiag.diagnostics || '').includes('"fps":60'));
  const optedOut = collectContext(false);
  check('collectContext omits diagnostics when not opted in', optedOut.diagnostics === undefined);
  clearGlobal('window');

  // ---- logFeedbackEvent: analytics seam ----
  console.log('--- logFeedbackEvent ---');
  /** @type {{ name: string, params: { category?: string } } | null} */
  let logged = null;
  setGlobal('window', { firebaseModules: { logEvent: (/** @type {string} */ name, /** @type {{ category?: string }} */ params) => { logged = { name, params }; } } });
  logFeedbackEvent('feature');
  check('fires feedback_submitted', logged && logged.name === 'feedback_submitted');
  check('carries only the category dimension', logged && logged.params && logged.params.category === 'feature');
  clearGlobal('window');

  // No window / no seam -> no throw.
  let threw = false;
  try { logFeedbackEvent('bug'); } catch { threw = true; }
  check('logFeedbackEvent no-ops without a window', threw === false);

  // ---- category table sanity ----
  console.log('--- FEEDBACK_CATEGORIES ---');
  check('every category carries the shared game-feedback label',
    ['feature', 'bug', 'general'].every((k) => FEEDBACK_CATEGORIES[k].issueLabels.includes(FEEDBACK_LABEL)));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
