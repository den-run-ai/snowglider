// @ts-check
// score-limits-sync-tests.js
// Lockstep guard: the leaderboard plausibility floor + upper cap live in src/score-limits.ts
// as the single source of truth, but firestore.rules has to duplicate the two literals
// because Firestore security rules cannot import JavaScript. This test parses the
// isValidScoreTime() bounds out of firestore.rules and asserts they exactly equal the
// exported JS constants, so the client-side gate (scores.ts / result-overlay.ts) and the
// server-side gate (the rules) can never silently drift apart (issue #229, PR C).
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/score-limits-sync-tests.js
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name} ${ok ? '✅' : '❌'}`);
  if (ok) pass++; else fail++;
}

(async () => {
  const { MIN_VALID_SCORE_TIME, MAX_VALID_SCORE_TIME } = await import('../src/score-limits.ts');

  const rulesPath = path.join(__dirname, '..', 'firestore.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');

  // Pull the bounds straight out of the isValidScoreTime() body:
  //   return time is number && time >= <MIN> && time <= <MAX>;
  const m = rules.match(/time\s+is\s+number\s*&&\s*time\s*>=\s*([\d.]+)\s*&&\s*time\s*<=\s*([\d.]+)/);

  console.log('--- score-limits.ts <-> firestore.rules lockstep ---');
  check('firestore.rules exposes an isValidScoreTime() numeric range', !!m);

  if (m) {
    const rulesMin = Number(m[1]);
    const rulesMax = Number(m[2]);
    console.log(`  score-limits.ts: MIN=${MIN_VALID_SCORE_TIME} MAX=${MAX_VALID_SCORE_TIME} | firestore.rules: MIN=${rulesMin} MAX=${rulesMax}`);
    check('rules floor equals MIN_VALID_SCORE_TIME', rulesMin === MIN_VALID_SCORE_TIME);
    check('rules cap equals MAX_VALID_SCORE_TIME', rulesMax === MAX_VALID_SCORE_TIME);
  }

  // The classic-script local-auth fallback (src/boot/local-auth.js) can't import ES
  // modules, so it duplicates the same two literals — assert they match too.
  const localAuthPath = path.join(__dirname, '..', 'src', 'boot', 'local-auth.js');
  const localAuth = fs.readFileSync(localAuthPath, 'utf8');
  const laMin = localAuth.match(/MIN_VALID_SCORE_TIME\s*=\s*([\d.]+)/);
  const laMax = localAuth.match(/MAX_VALID_SCORE_TIME\s*=\s*([\d.]+)/);
  check('local-auth.js declares MIN/MAX literals', !!laMin && !!laMax);
  if (laMin && laMax) {
    check('local-auth.js floor equals MIN_VALID_SCORE_TIME', Number(laMin[1]) === MIN_VALID_SCORE_TIME);
    check('local-auth.js cap equals MAX_VALID_SCORE_TIME', Number(laMax[1]) === MAX_VALID_SCORE_TIME);
  }

  // Sanity on the constants themselves so a typo (e.g. min > max, non-finite) is caught.
  check('MIN_VALID_SCORE_TIME is a positive finite number',
    Number.isFinite(MIN_VALID_SCORE_TIME) && MIN_VALID_SCORE_TIME > 0);
  check('MAX_VALID_SCORE_TIME is greater than the floor',
    Number.isFinite(MAX_VALID_SCORE_TIME) && MAX_VALID_SCORE_TIME > MIN_VALID_SCORE_TIME);

  console.log(`\nSCORE-LIMITS SYNC TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
