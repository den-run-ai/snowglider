// @ts-check
// Exact query-key regression coverage for src/test-mode.ts. Ordinary player URLs
// often contain the letters "test" in campaign names or unrelated parameter keys;
// only an exact `test` key may activate browser automation.
'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++;
  else fail++;
}

async function main() {
  const { getTestModeValues, isTestModeSearch } = await import('../src/test-mode.ts');

  check('bare ?test enables automation', isTestModeSearch('?test') === true);
  check('empty ?test= enables automation', isTestModeSearch('?test=') === true);
  check('named ?test= suite enables automation', isTestModeSearch('?test=unified') === true);
  check('test can appear after another parameter', isTestModeSearch('?foo=1&test=trees') === true);
  check('encoded exact key is parsed as test', isTestModeSearch('?te%73t=camera') === true);
  check('all exact test values are preserved',
    JSON.stringify(getTestModeValues('?test=tree&foo=1&test=regression')) ===
      JSON.stringify(['tree', 'regression']));

  for (const search of [
    '',
    '?latest=1',
    '?contest=regression',
    '?utm_campaign=beta-test',
    '?foo=test',
    '?mytest=unified',
    '?Test=unified',
  ]) {
    check(`${search || 'empty search'} stays in player mode`, isTestModeSearch(search) === false);
  }

  console.log(`\nTEST-MODE QUERY TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
