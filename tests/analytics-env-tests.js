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
  const { isAutomatedClient, withTrafficTag } = await import('../src/analytics-env.ts');

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
  check('adds is_bot=true under automation', tagged.is_bot === true);

  setNav({ webdriver: false });
  check('adds is_bot=false for real users', withTrafficTag({ method: 'Google' }).is_bot === false);
  check('is_bot=false keeps other params', withTrafficTag({ method: 'Google' }).method === 'Google');

  const src = { time: 5 };
  const out = withTrafficTag(src);
  check('does not mutate the input params', !('is_bot' in src) && out !== src);

  check('handles undefined params', typeof withTrafficTag().is_bot === 'boolean');

  setNav({ webdriver: true });
  check('an explicit is_bot in params is preserved', withTrafficTag({ is_bot: false }).is_bot === false);

  // Restore.
  if (hadNav) setNav(savedNav); else delete globalThis.navigator;

  console.log(`\nANALYTICS-ENV TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
