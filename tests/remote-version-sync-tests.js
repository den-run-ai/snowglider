// @ts-check
// remote-version-sync-tests.js
// Lockstep guard for the VERSION-NAMESPACED remote score schema (#403 review tail).
//
// The client derives its Firestore names from PHYSICS_VERSION at runtime
// (userBestTimeField / leaderboardCollectionName in src/difficulty.ts), but
// firestore.rules cannot import JavaScript — the rules must name the active
// fields and collections literally. Same for tests/firestore-rules-tests.js,
// which runs under `emulators:exec` without the TS loader. This suite parses
// both files and asserts they carry exactly the names the seams produce, so
// bumping PHYSICS_VERSION without extending the rules (and the rules tests)
// fails `npm test` instead of silently shipping a client whose writes the
// server rejects. (Until a matching rules deploy, such writes fail CLOSED —
// rejected server-side, kept locally, resynced by the sign-in backfill — but
// they must never fail SILENTLY in CI.)
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/remote-version-sync-tests.js
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name} ${ok ? '✅' : '❌'}`);
  if (ok) pass++; else fail++;
}

/** Escape a literal for embedding in a RegExp. */
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

(async () => {
  const D = await import('../src/difficulty.ts');
  const { PHYSICS_VERSION } = await import('../src/run-context.ts');

  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  const rulesTests = fs.readFileSync(path.join(__dirname, 'firestore-rules-tests.js'), 'utf8');

  const TIERS = /** @type {const} */ (['blue', 'bunny', 'black', 'expert']);

  console.log('--- difficulty.ts seams: versioned, distinct from the legacy names ---');
  for (const tier of TIERS) {
    const field = D.userBestTimeField(tier);
    const coll = D.leaderboardCollectionName(tier);
    check(`${tier}: active field/collection carry the physics version (v${PHYSICS_VERSION})`,
      field.includes(`V${PHYSICS_VERSION}`) && coll.includes(`_v${PHYSICS_VERSION}`));
    check(`${tier}: active names differ from the legacy (historical) names`,
      field !== D.legacyUserBestTimeField(tier)
      && coll !== D.legacyLeaderboardCollectionName(tier));
  }

  console.log('\n--- firestore.rules: every ACTIVE users/{uid} field is validated ---');
  for (const tier of TIERS) {
    const field = D.userBestTimeField(tier);
    // Accepted by BOTH key allowlists: validUserKeys (create) and the
    // changedUserKeys().hasOnly list (update).
    const allowlisted = (rules.match(new RegExp(`'${esc(field)}'`, 'g')) || []).length;
    check(`rules allowlist '${field}' for create AND update`, allowlisted >= 2);
    // Plausibility-gated like every other best-time field...
    check(`rules bound '${field}' with isValidScoreTime`,
      new RegExp(`isValidScoreTime\\(data\\.${esc(field)}\\)`).test(rules));
    // ...and monotonic within its own version (no downgrade to a slower time).
    check(`rules enforce monotonic improvement on '${field}'`,
      new RegExp(`request\\.resource\\.data\\.${esc(field)}\\s*<=\\s*resource\\.data\\.${esc(field)}`).test(rules));
  }

  console.log('\n--- firestore.rules: the ACTIVE leaderboard collections exist ---');
  // The ranked Blue board must be a VALIDATED writable match block.
  const blueColl = D.leaderboardCollectionName('blue');
  const blueBlockStart = rules.indexOf(`match /${blueColl}/{userId}`);
  check(`rules declare match /${blueColl}/{userId}`, blueBlockStart !== -1);
  if (blueBlockStart !== -1) {
    const nextMatch = rules.indexOf('match /', blueBlockStart + 1);
    const block = rules.slice(blueBlockStart, nextMatch === -1 ? rules.length : nextMatch);
    check(`${blueColl}: create validates via validLeaderboardDoc`,
      block.includes('validLeaderboardDoc'));
    check(`${blueColl}: update validates via validLeaderboardUpdate`,
      block.includes('validLeaderboardUpdate'));
  }
  // The unranked sibling boards must exist (the client reads them) and stay
  // server-side read-only until their flip-to-ranked PR.
  for (const tier of /** @type {const} */ (['bunny', 'black', 'expert'])) {
    const coll = D.leaderboardCollectionName(tier);
    const start = rules.indexOf(`match /${coll}/{userId}`);
    check(`rules declare match /${coll}/{userId}`, start !== -1);
    if (start !== -1) {
      const nextMatch = rules.indexOf('match /', start + 1);
      const block = rules.slice(start, nextMatch === -1 ? rules.length : nextMatch);
      check(`${coll}: every client write is denied (unranked guarantee)`,
        /allow\s+write:\s*if\s+false/.test(block));
    }
  }

  console.log('\n--- firestore-rules-tests.js: emulator coverage names the active schema ---');
  // The emulator suite cannot import the seams, so its literals drift-guard here.
  check('rules tests exercise the active Blue best-time field',
    rulesTests.includes(`'users', 'alice'`) && rulesTests.includes(D.userBestTimeField('blue')));
  check('rules tests exercise the active Blue board',
    rulesTests.includes(`'${blueColl}'`));
  for (const tier of /** @type {const} */ (['bunny', 'black', 'expert'])) {
    check(`rules tests exercise the active ${tier} names`,
      rulesTests.includes(D.userBestTimeField(tier))
      && rulesTests.includes(`'${D.leaderboardCollectionName(tier)}'`));
  }

  console.log(`\nREMOTE-VERSION SYNC TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
