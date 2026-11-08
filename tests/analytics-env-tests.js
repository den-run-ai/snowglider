// @ts-check
// analytics-env-tests.js
// Unit tests for src/analytics-env.ts — the traffic-source tagging that lets bot/automation
// traffic be filtered out of GA4. Automated clients set navigator.webdriver=true; every
// analytics event is tagged with `is_bot` so it can be excluded without dropping the data
// (a follow-up to the anomaly-spike investigation — see docs/ANALYTICS.md).
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/analytics-env-tests.js

let pass = 0, fail = 0;
function check(name, ok) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name} ${ok ? '✅' : '❌'}`);
  if (ok) pass++; else fail++;
}

(async () => {
  const { isAutomatedClient, withTrafficTag, analyticsBuildId, shouldCollectAnalytics } = await import('../src/analytics-env.ts');

  console.log('--- analytics-env: production hostname gate ---');
  check('canonical host collects Analytics', shouldCollectAnalytics('snowglider.ai'));
  check('public www host collects Analytics', shouldCollectAnalytics('www.snowglider.ai'));
  check('hostname matching is case-insensitive', shouldCollectAnalytics('SNOWGLIDER.AI'));
  for (const hostname of ['preview.local', 'example.com', 'localhost', '127.0.0.1', '[::1]',
    '192.168.1.2', 'preview.snowglider.ai', 'snowglider.ai.example.com', '']) {
    check(`non-production hostname ${hostname || '(empty)'} is excluded`, !shouldCollectAnalytics(hostname));
  }

  // Preserve and restore any real navigator so the test is isolated.
  const hadNav = 'navigator' in globalThis;
  const savedNav = hadNav ? globalThis.navigator : undefined;
  const setNav = (v) => { Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true }); };

  console.log('--- analytics-env: isAutomatedClient() ---');
  setNav({ webdriver: true });
  check('webdriver=true → automated', isAutomatedClient() === true);
  setNav({ webdriver: false });
  check('webdriver=false → not automated', isAutomatedClient() === false);
  setNav({});
  check('webdriver undefined → not automated', isAutomatedClient() === false);

  console.log('--- analytics-env: withTrafficTag() ---');
  setNav({ webdriver: true });
  const tagged = withTrafficTag({ time: 22 });
  check('keeps existing params', tagged.time === 22);
  check('adds is_bot=true under automation', tagged.is_bot === 'true');

  setNav({ webdriver: false });
  check('adds is_bot=false for real users', withTrafficTag({ method: 'Google' }).is_bot === 'false');
  check('is_bot=false keeps other params', withTrafficTag({ method: 'Google' }).method === 'Google');

  const src = { time: 5 };
  const out = withTrafficTag(src);
  check('does not mutate the input params', !('is_bot' in src) && out !== src);

  check('handles undefined params', withTrafficTag().is_bot === 'false');

  setNav({ webdriver: true });
  check('callers cannot disguise automated traffic', withTrafficTag({ is_bot: false }).is_bot === 'true');

  const hadWindow = 'window' in globalThis;
  const savedWindow = globalThis.window;
  setNav({ webdriver: false });
  const g = /** @type {any} */ (globalThis);
  g.window = { isTestMode: true, location: { search: '' } };
  check('test mode is tagged even without webdriver', isAutomatedClient());
  g.window = { location: { search: '?test=unified' } };
  check('test URL is tagged before test mode initialization', isAutomatedClient());
  g.window = { location: { search: '?debug' } };
  check('ordinary debug sessions remain human', !isAutomatedClient());
  if (hadWindow) g.window = savedWindow; else delete g.window;

  const savedDocument = g.document;
  g.document = { querySelector: () => ({ getAttribute: () => '2026-11-07 12:30 UTC' }) };
  check('fixed deployment timestamp tags events', withTrafficTag().app_build === '2026-11-07 12:30 UTC');
  g.document = { querySelector: () => ({ getAttribute: () => 'person@example.invalid' }) };
  check('arbitrary build metadata is excluded', analyticsBuildId() === 'unknown');
  if (savedDocument) g.document = savedDocument; else delete g.document;

  // Restore.
  if (hadNav) setNav(savedNav); else delete globalThis.navigator;

  console.log(`\nANALYTICS-ENV TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
