// firestore-rules-tests.js
// Firestore Security Rules coverage for SnowGlider score/profile data.
//
// Run with: npm run test:firebase
// The script starts the Firestore emulator via firebase-tools, then this file
// exercises the checked-in firestore.rules with @firebase/rules-unit-testing.
const fs = require('fs');
const path = require('path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} = require('@firebase/rules-unit-testing');
const {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where
} = require('firebase/firestore');

const REPO = path.join(__dirname, '..');
const PROJECT_ID = 'snowglider-rules-test';

let testEnv;
let pass = 0;
let fail = 0;

function profile(name = 'Alice') {
  return {
    displayName: name,
    email: `${name.toLowerCase()}@snowglider.test`,
    photoURL: null,
    lastLogin: serverTimestamp()
  };
}

function bestTime(time) {
  return {
    bestTime: time,
    updatedAt: serverTimestamp()
  };
}

function leaderboardEntry(db, userId, time) {
  return {
    user: doc(db, 'users', userId),
    time,
    achievedAt: serverTimestamp()
  };
}

function dbFor(uid) {
  return testEnv.authenticatedContext(uid, {
    email: `${uid}@snowglider.test`
  }).firestore();
}

function anonDb() {
  return testEnv.unauthenticatedContext().firestore();
}

async function seed(seedFn) {
  await testEnv.withSecurityRulesDisabled(async context => {
    await seedFn(context.firestore());
  });
}

async function reset() {
  await testEnv.clearFirestore();
}

async function runTest(name, testFn) {
  try {
    await reset();
    await testFn();
    console.log(`  PASS: ${name}`);
    pass++;
  } catch (error) {
    console.log(`  FAIL: ${name}`);
    console.log(`    ${error.message}`);
    fail++;
  }
}

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('FIRESTORE_EMULATOR_HOST is not set. Run this with `npm run test:firebase`.');
    process.exit(1);
  }

  const rules = fs.readFileSync(path.join(REPO, 'firestore.rules'), 'utf8');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules
    }
  });

  console.log('--- Firestore rules: users ---');
  await runTest('signed-in users can create and read their own profile', async () => {
    const alice = dbFor('alice');
    await assertSucceeds(setDoc(doc(alice, 'users', 'alice'), profile(), { merge: true }));
    await assertSucceeds(getDoc(doc(alice, 'users', 'alice')));
  });

  await runTest('users cannot read or write another user profile', async () => {
    const alice = dbFor('alice');
    await seed(async admin => {
      await setDoc(doc(admin, 'users', 'bob'), profile('Bob'));
    });

    await assertFails(getDoc(doc(alice, 'users', 'bob')));
    await assertFails(setDoc(doc(alice, 'users', 'bob'), profile('Bob'), { merge: true }));
  });

  await runTest('user best times must be plausible score values', async () => {
    const alice = dbFor('alice');

    // Sub-floor and over-cap writes are rejected first (no doc is created), then a
    // plausible at-the-floor time is accepted as a fresh create. 17.99 specifically
    // guards the 18 s plausibility floor (PR C, issue #229).
    await assertFails(setDoc(doc(alice, 'users', 'alice'), bestTime(3.99), { merge: true }));
    await assertFails(setDoc(doc(alice, 'users', 'alice'), bestTime(17.99), { merge: true }));
    await assertFails(setDoc(doc(alice, 'users', 'alice'), bestTime(601), { merge: true }));
    await assertSucceeds(setDoc(doc(alice, 'users', 'alice'), bestTime(18), { merge: true }));
  });

  await runTest('user best times cannot be downgraded to a slower time', async () => {
    const alice = dbFor('alice');
    await seed(async admin => {
      await setDoc(doc(admin, 'users', 'alice'), bestTime(20)); // a valid (>= floor) existing best
    });

    await assertFails(setDoc(doc(alice, 'users', 'alice'), bestTime(25), { merge: true }));     // slower
    await assertSucceeds(setDoc(doc(alice, 'users', 'alice'), bestTime(19), { merge: true }));  // faster, plausible
  });

  await runTest('valid user best times can repair a corrupt stored best', async () => {
    const alice = dbFor('alice');
    await seed(async admin => {
      await setDoc(doc(admin, 'users', 'alice'), bestTime(0.01));
    });

    await assertSucceeds(setDoc(doc(alice, 'users', 'alice'), bestTime(19.43), { merge: true }));
  });

  await runTest('unexpected user document fields are rejected', async () => {
    const alice = dbFor('alice');

    await assertFails(setDoc(doc(alice, 'users', 'alice'), {
      ...profile(),
      isAdmin: true
    }, { merge: true }));
  });

  console.log('\n--- Firestore rules: leaderboard ---');
  await runTest('signed-in users can write their own valid leaderboard entry', async () => {
    const alice = dbFor('alice');
    await assertSucceeds(setDoc(doc(alice, 'users', 'alice'), profile(), { merge: true }));

    await assertSucceeds(setDoc(
      doc(alice, 'leaderboard', 'alice'),
      leaderboardEntry(alice, 'alice', 25.43)
    ));
  });

  await runTest('signed-in users can query leaderboard entries', async () => {
    const alice = dbFor('alice');
    await seed(async admin => {
      await setDoc(doc(admin, 'users', 'alice'), profile());
      await setDoc(doc(admin, 'leaderboard', 'alice'), leaderboardEntry(admin, 'alice', 25.43));
    });

    await assertSucceeds(getDocs(query(
      collection(alice, 'leaderboard'),
      where('time', '>=', 18),
      orderBy('time', 'asc'),
      limit(10)
    )));
  });

  await runTest('anonymous users cannot read or write leaderboard data', async () => {
    const anon = anonDb();

    await assertFails(getDocs(query(
      collection(anon, 'leaderboard'),
      where('time', '>=', 18),
      orderBy('time', 'asc'),
      limit(10)
    )));
    await assertFails(setDoc(
      doc(anon, 'leaderboard', 'alice'),
      leaderboardEntry(anon, 'alice', 25.43)
    ));
  });

  await runTest('leaderboard writes require the matching user document and reference', async () => {
    const alice = dbFor('alice');
    await seed(async admin => {
      await setDoc(doc(admin, 'users', 'alice'), profile());
      await setDoc(doc(admin, 'users', 'bob'), profile('Bob'));
    });

    await assertFails(setDoc(
      doc(alice, 'leaderboard', 'alice'),
      leaderboardEntry(alice, 'bob', 25.43)
    ));
    await assertFails(setDoc(
      doc(alice, 'leaderboard', 'bob'),
      leaderboardEntry(alice, 'bob', 25.43)
    ));
  });

  await runTest('leaderboard times must be plausible score values', async () => {
    const alice = dbFor('alice');
    await seed(async admin => {
      await setDoc(doc(admin, 'users', 'alice'), profile());
    });

    await assertFails(setDoc(
      doc(alice, 'leaderboard', 'alice'),
      leaderboardEntry(alice, 'alice', 0.01)
    ));
    // A forged sub-floor time (faster than the engine can produce) is rejected server-side
    // even from a patched client — the core PR C guard for issue #229.
    await assertFails(setDoc(
      doc(alice, 'leaderboard', 'alice'),
      leaderboardEntry(alice, 'alice', 14)
    ));
    await assertFails(setDoc(
      doc(alice, 'leaderboard', 'alice'),
      leaderboardEntry(alice, 'alice', 17.99)
    ));
    await assertFails(setDoc(
      doc(alice, 'leaderboard', 'alice'),
      leaderboardEntry(alice, 'alice', 601)
    ));
    await assertSucceeds(setDoc(
      doc(alice, 'leaderboard', 'alice'),
      leaderboardEntry(alice, 'alice', 18)
    ));
  });

  await runTest('leaderboard entries cannot be downgraded to a slower time', async () => {
    const alice = dbFor('alice');
    await seed(async admin => {
      await setDoc(doc(admin, 'users', 'alice'), profile());
      await setDoc(doc(admin, 'leaderboard', 'alice'), leaderboardEntry(admin, 'alice', 20)); // valid existing best
    });

    await assertFails(setDoc(
      doc(alice, 'leaderboard', 'alice'),
      leaderboardEntry(alice, 'alice', 25)
    ));
    await assertSucceeds(setDoc(
      doc(alice, 'leaderboard', 'alice'),
      leaderboardEntry(alice, 'alice', 19)
    ));
  });

  await runTest('valid leaderboard times can repair a corrupt stored entry', async () => {
    const alice = dbFor('alice');
    await seed(async admin => {
      await setDoc(doc(admin, 'users', 'alice'), profile());
      await setDoc(doc(admin, 'leaderboard', 'alice'), leaderboardEntry(admin, 'alice', 0.01));
    });

    await assertSucceeds(setDoc(
      doc(alice, 'leaderboard', 'alice'),
      leaderboardEntry(alice, 'alice', 19.43)
    ));
  });

  console.log('\n--- Firestore rules: per-tier best times + sibling leaderboards (D2) ---');
  await runTest('per-tier user best fields validate like bestTime (plausible + no downgrade)', async () => {
    const alice = dbFor('alice');
    // sub-floor rejected
    await assertFails(setDoc(doc(alice, 'users', 'alice'),
      { bestTimeBunny: 17.99, updatedAt: serverTimestamp() }, { merge: true }));
    // plausible per-tier fields accepted (fresh create)
    await assertSucceeds(setDoc(doc(alice, 'users', 'alice'),
      { bestTimeBunny: 20, bestTimeBlack: 18, bestTimeExpert: 21, updatedAt: serverTimestamp() }, { merge: true }));
    // downgrade rejected, improvement accepted (bunny)
    await assertFails(setDoc(doc(alice, 'users', 'alice'),
      { bestTimeBunny: 25, updatedAt: serverTimestamp() }, { merge: true }));
    await assertSucceeds(setDoc(doc(alice, 'users', 'alice'),
      { bestTimeBunny: 19, updatedAt: serverTimestamp() }, { merge: true }));
  });

  await runTest('an unknown best-time-like field is still rejected', async () => {
    const alice = dbFor('alice');
    await assertFails(setDoc(doc(alice, 'users', 'alice'),
      { ...profile(), bestTimeRainbow: 20 }, { merge: true }));
  });

  // Bunny/Black/Expert are UNRANKED for now: reads allowed, but ALL client writes denied
  // (the unranked guarantee is enforced server-side, not just in the finish overlay).
  for (const coll of ['leaderboard_bunny', 'leaderboard_black', 'leaderboard_expert']) {
    await runTest(`${coll} (unranked): every client write is denied, even a valid owner entry`, async () => {
      const alice = dbFor('alice');
      await assertSucceeds(setDoc(doc(alice, 'users', 'alice'), profile(), { merge: true }));
      // A write that WOULD be valid on the ranked Blue board is still denied here.
      await assertFails(setDoc(doc(alice, coll, 'alice'), leaderboardEntry(alice, 'alice', 20)));
    });

    await runTest(`${coll} (unranked): signed-in can read, anonymous cannot`, async () => {
      const alice = dbFor('alice');
      await seed(async admin => {
        await setDoc(doc(admin, 'users', 'alice'), profile());
        await setDoc(doc(admin, coll, 'alice'), leaderboardEntry(admin, 'alice', 20));
      });
      await assertSucceeds(getDocs(query(
        collection(alice, coll), where('time', '>=', 18), orderBy('time', 'asc'), limit(10))));
      const anon = anonDb();
      await assertFails(getDocs(query(
        collection(anon, coll), where('time', '>=', 18), orderBy('time', 'asc'), limit(10))));
    });
  }

  console.log(`\nFIRESTORE RULES TEST TOTAL: ${pass} passed, ${fail} failed`);
  await testEnv.cleanup();
  process.exit(fail ? 1 : 0);
}

main().catch(async error => {
  console.error(error);
  if (testEnv) {
    await testEnv.cleanup();
  }
  process.exit(1);
});
