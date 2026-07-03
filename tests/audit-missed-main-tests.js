// @ts-check
/**
 * Unit tests for the pure decision logic in scripts/audit-missed-main.mjs — the guard
 * that flags PRs which merged but never reached the default branch (the #277/#308
 * "silent miss" stacking hazard; see issue #312).
 *
 * These cover the parts that must be correct without touching the network: how a GitHub
 * compare `status` maps to "reached main", how the acknowledgement allowlist is parsed
 * (comment keys ignored, numeric-key normalization), and how candidates split into
 * acknowledged vs un-acknowledged misses (the latter fail the audit).
 */

'use strict';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`✅ PASS: ${name}`);
  } else {
    failures++;
    console.log(`❌ FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('\n🏂 SNOWGLIDER AUDIT-MISSED-MAIN TESTS 🏂');
  console.log('=========================================\n');

  const { reachedDefaultBranch, parseAllowlist, evaluate } =
    await import('../scripts/audit-missed-main.mjs');

  // --- reachedDefaultBranch: compare(base=default ... head=mergeSha) status mapping ---
  check('status "identical" => reached (merge commit IS the default tip)',
    reachedDefaultBranch('identical') === true);
  check('status "behind" => reached (merge commit is an ancestor of default)',
    reachedDefaultBranch('behind') === true);
  check('status "diverged" => MISSED (merge commit carries work default lacks)',
    reachedDefaultBranch('diverged') === false);
  check('status "ahead" => MISSED (merge commit not contained in default)',
    reachedDefaultBranch('ahead') === false);
  check('unknown status => MISSED (fail closed, do not vouch)',
    reachedDefaultBranch('wat') === false);

  // --- parseAllowlist: comment keys dropped, numeric keys normalized ---
  const allow = parseAllowlist(JSON.stringify({
    _comment: 'ignore me',
    '277': 're-landed by #313',
    '308': 're-landed by #311',
  }));
  check('allowlist ignores keys beginning with "_"', !('_comment' in allow));
  check('allowlist keeps acknowledged PR numbers', allow['277'] === 're-landed by #313');
  check('allowlist has exactly the two acked PRs', Object.keys(allow).length === 2);
  check('empty allowlist parses to {}', Object.keys(parseAllowlist('{}')).length === 0);

  // --- evaluate: split candidates into misses / acked / unacked ---
  const candidates = [
    { number: 100, reached: true },   // reached main — not a miss
    { number: 277, reached: false },  // missed, but acknowledged
    { number: 308, reached: false },  // missed, but acknowledged
    { number: 999, reached: false },  // missed and NOT acknowledged -> should fail audit
  ];
  const { misses, acked, unacked } = evaluate(candidates, allow);
  check('evaluate: 3 misses detected (reached=false)', misses.length === 3);
  check('evaluate: 2 misses acknowledged', acked.length === 2 && acked.every((m) => [277, 308].includes(m.number)));
  check('evaluate: 1 un-acknowledged miss (#999)', unacked.length === 1 && unacked[0].number === 999);
  check('evaluate: a reached PR is never a miss', !misses.some((m) => m.number === 100));

  // --- the shipped allowlist file must parse and cover #277 + #308 ---
  const shipped = parseAllowlist();
  check('shipped allowlist acknowledges #277', typeof shipped['277'] === 'string');
  check('shipped allowlist acknowledges #308', typeof shipped['308'] === 'string');

  console.log(`\nAUDIT-MISSED-MAIN TEST TOTAL: ${16 - failures} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
