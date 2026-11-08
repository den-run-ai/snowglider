// @ts-check
// scores-tests.js
// Headless, c8-instrumented coverage for src/scores.ts against the real module.
//
// src/scores.ts imports the Firebase SDK from gstatic CDN URLs, which Node cannot
// resolve. Instead of eval'ing the source (which is invisible to c8), the resolve
// hook in tests/loaders/register-firebase-mock.mjs redirects those CDN imports to
// the in-memory mock in tests/mocks/firebase.mjs, so we `import` the real `.ts`
// under jsdom and c8 instruments it with correct source-mapped lines. Run via the
// `test:scores` npm script, which wires in that loader.
// DOM + localStorage + navigator.onLine come from the shared mocks (tests/mocks/).
// setupDom is async-imported in main() so the globals are wired before src/scores.ts
// loads; `env` holds the live handles (document, localStorage, setOnline).
/** @type {any} */ let env;

// AuthModule-driven flags. The Firestore/Analytics mock state lives in
// tests/mocks/firebase.mjs and is bound below once the mock is imported.
let firestoreAvailable = true;
/** @type {any} */ let currentAuthUser = null;
let reinitializeSucceeds = false;

// Bound from the shared Firebase mock in loadScoresModule(). The resolve hook hands
// src/scores.ts the SAME module instance, so seeding/reading here mutates exactly
// the store the module under test reads and writes.
/** @type {any} */ let fb;
/** @type {any} */ let firestoreInstance;
/** @type {any} */ let analyticsInstance;
/** @type {any} */ let calls;
/** @type {any} */ let doc;
/** @type {any} */ let seed;
/** @type {any} */ let read;
/** @type {any} */ let setPendingWrite;
/** @type {any} */ let setNextSetDocError;

async function loadScoresModule() {
  // Wire window/document/localStorage/navigator.onLine before src/scores.ts loads.
  const { setupDom } = await import('./mocks/dom.mjs');
  env = setupDom({ html: '<!doctype html><html><body><div id="leaderboard"></div></body></html>' });

  // AuthModule is read by src/scores.ts off window; install it now that window exists.
  env.window.AuthModule = {
    isFirebaseAvailable: () => ({ firestore: firestoreAvailable }),
    getAuthState: () => ({ user: currentAuthUser }),
    getCurrentUser: () => currentAuthUser,
    reinitializeFirestore: () => {
      calls.reinitializeFirestore++;
      if (reinitializeSucceeds && window.ScoresModule) {
        window.ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
        return true;
      }
      return false;
    }
  };

  fb = await import('./mocks/firebase.mjs');
  ({ firestoreInstance, analyticsInstance, calls, doc, seed, read, setPendingWrite,
     setNextSetDocError } = fb);
  // AuthModule.reinitializeFirestore is mocked in this harness (not in the Firebase
  // mock), so track its call count alongside the Firestore call log.
  calls.reinitializeFirestore = 0;
  // Importing the real module (rather than eval'ing it) is what makes it c8-visible;
  // its CDN Firebase imports resolve to `fb` via the registered hook.
  const scoresModule = await import('../src/scores.ts');
  return scoresModule.default;
}

function resetState(ScoresModule) {
  env.localStorage.reset();
  fb.reset();
  calls.reinitializeFirestore = 0;
  firestoreAvailable = true;
  currentAuthUser = null;
  reinitializeSucceeds = false;
  env.setOnline(true);
  document.getElementById('leaderboard').innerHTML = '';
  ScoresModule.setCurrentUser(null);
  ScoresModule.initializeScores(null, null);
}

let pass = 0;
let fail = 0;

function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) {
    pass++;
  } else {
    fail++;
  }
}

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function flushAll() {
  await flush();
  await flush();
  await flush();
}

// Versioned competitive best-time key builders (#403 review), bound in main().
// LB/LB_BUNNY and F_BLUE/F_BUNNY are the ACTIVE (version-namespaced) remote
// leaderboard collections and users/{uid} best-time fields — the suite asserts
// against whatever names the seams produce, so a PHYSICS_VERSION bump can't
// silently leave these checks pinned to a stale schema.
let BTK, BTMK, LB, LB_BUNNY, LB_BLACK, F_BLUE, F_BUNNY, F_BLACK;
async function main() {
  const Difficulty = await import('../src/difficulty.ts');
  const { MIN_VALID_SCORE_TIME: scoreFloor } = await import('../src/score-limits.ts');
  ({ localBestTimeKey: BTK, localBestMetaKey: BTMK } = Difficulty);
  LB = Difficulty.leaderboardCollectionName('blue');
  LB_BUNNY = Difficulty.leaderboardCollectionName('bunny');
  LB_BLACK = Difficulty.leaderboardCollectionName('black');
  F_BLUE = Difficulty.userBestTimeField('blue');
  F_BUNNY = Difficulty.userBestTimeField('bunny');
  F_BLACK = Difficulty.userBestTimeField('black');

  const ScoresModule = await loadScoresModule();
  // The pending-sync store is keyed by uid+tier (Codex #362); seed/read markers through it
  // rather than hand-building the composite localStorage keys.
  const store = await import('../src/offline/offline-store.ts');
  const seedPending = (uid, tier, time) => store.markPendingSync(tier, time, uid, { recordedAt: 1, storage: env.localStorage });
  const pendingTime = (uid, tier) => store.getPendingSync(uid, tier, env.localStorage)?.time;

  console.log('--- ScoresModule load & validation ---');
  check('module exposes the expected public surface',
    !!ScoresModule && ['initializeScores', 'setCurrentUser', 'recordScore',
      'getLeaderboard', 'updateUserBestTime', 'syncBestTimeWithRetry', 'updateLeaderboard',
      'isFirestoreAvailable', 'isValidScoreTime'].every(key => typeof ScoresModule[key] === 'function'));
  check('score validation rejects impossible, sub-floor and non-finite times',
    ScoresModule.isValidScoreTime(0.01) === false &&
    ScoresModule.isValidScoreTime(scoreFloor - 1) === false &&
    ScoresModule.isValidScoreTime(scoreFloor - 0.01) === false &&
    ScoresModule.isValidScoreTime(600.01) === false &&
    ScoresModule.isValidScoreTime(Infinity) === false &&
    ScoresModule.isValidScoreTime(/** @type {any} */ ('20')) === false);
  check('score validation accepts plausible numeric times at/above the floor',
    ScoresModule.isValidScoreTime(scoreFloor) === true &&
    ScoresModule.isValidScoreTime(600) === true &&
    ScoresModule.isValidScoreTime(25.43) === true);

  console.log('\n--- Local score recording ---');
  resetState(ScoresModule);
  ScoresModule.recordScore(0.01);
  check('invalid runs are not stored locally',
    localStorage.getItem(BTK('blue')) === null);
  ScoresModule.recordScore(600.01);
  check('over-cap runs are not stored locally',
    localStorage.getItem(BTK('blue')) === null);
  localStorage.setItem(BTK('blue'), 'bogus');
  ScoresModule.recordScore(21.5);
  check('invalid stored local best is replaced by a valid run',
    localStorage.getItem(BTK('blue')) === '21.5');
  ScoresModule.recordScore(25);
  check('slower valid runs do not replace the local best',
    localStorage.getItem(BTK('blue')) === '21.5');

  // Run-provenance stamp (#400): a new local best writes a SIDECAR meta record
  // ({seed, physicsVersion}) without touching the legacy bare-number value; a
  // slower run leaves the existing stamp alone.
  {
    const RC = await import('../src/run-context.ts');
    const { readLocalBestMeta } = await import('../src/scores.ts');
    const rawMeta = localStorage.getItem(BTMK('blue'));
    check('a new local best stamps the sidecar meta record', rawMeta !== null);
    const meta = readLocalBestMeta();
    check('the stamp carries the physics version and the (unseeded) null seed',
      !!meta && meta.physicsVersion === RC.PHYSICS_VERSION && meta.seed === null);
    // A SEEDED run's best carries its seed.
    RC.setWorldContext(RC.CANONICAL_WORLD_SEED, false);
    ScoresModule.recordScore(20.5);
    const seededMeta = readLocalBestMeta();
    check('a seeded run\'s best is stamped with its seed',
      !!seededMeta && seededMeta.seed === RC.CANONICAL_WORLD_SEED && seededMeta.physicsVersion === RC.PHYSICS_VERSION);
    // The nonce is part of the replay identity (worldSeed^nonce derives the
    // run-scoped streams), so the reader must hand it back (Codex review PR #407);
    // pre-nonce stamps read as the pinned practice value 0.
    check('the reader returns the stamped nonce', !!seededMeta && seededMeta.nonce === RC.getRunStamp().nonce);
    localStorage.setItem(BTMK('blue'), JSON.stringify({ seed: 5, physicsVersion: 1 }));
    check('a pre-nonce stamp reads with nonce 0', readLocalBestMeta()?.nonce === 0);
    RC.setRunSeed(null);
    // Corrupt sidecars read as null, never throw.
    localStorage.setItem(BTMK('blue'), '{not json');
    check('a corrupt meta sidecar reads as null', readLocalBestMeta() === null);
    localStorage.removeItem(BTMK('blue'));
    // Stamp-failure invalidation (Codex review PR #407): when the sidecar WRITE
    // fails (quota), a PREVIOUS run's stamp must not survive to be falsely
    // attributed to the newly recorded time — better unstamped than mis-stamped.
    const { stampLocalBestMeta } = await import('../src/difficulty.ts');
    localStorage.setItem(BTMK('blue'), JSON.stringify({ seed: 999, nonce: 1, physicsVersion: RC.PHYSICS_VERSION }));
    const realSetItem = localStorage.setItem;
    localStorage.setItem = (k, v) => { if (String(k).endsWith('_meta')) throw new Error('quota'); realSetItem(k, v); };
    stampLocalBestMeta();
    localStorage.setItem = realSetItem;
    check('a failed stamp write clears the stale sidecar instead of leaving it', readLocalBestMeta() === null);
    // Boot-race fallback (Codex review PR #407): auth can restore and backfill
    // BEFORE setupScene installs the world context (stamp seed still null). A
    // CANONICAL-stamped best must stay sync-eligible there — it's the
    // production-default world — while any other seed still fails closed.
    const { localBestProvenanceCompatible } = await import('../src/difficulty.ts');
    localStorage.setItem(BTMK('blue'),
      JSON.stringify({ seed: RC.CANONICAL_WORLD_SEED, nonce: 0, physicsVersion: RC.PHYSICS_VERSION }));
    check('a canonical-stamped best is sync-eligible before the world context installs',
      localBestProvenanceCompatible() === true);
    localStorage.setItem(BTMK('blue'),
      JSON.stringify({ seed: 12345, nonce: 0, physicsVersion: RC.PHYSICS_VERSION }));
    check('a non-canonical stamp is still rejected while unseeded',
      localBestProvenanceCompatible() === false);
    // ...and an active ?seed= PRACTICE world must not reject a canonical best
    // either (Codex review PR #407 round 6): the record is a canonical-world
    // record regardless of what world this session happens to be riding.
    localStorage.setItem(BTMK('blue'),
      JSON.stringify({ seed: RC.CANONICAL_WORLD_SEED, nonce: 0, physicsVersion: RC.PHYSICS_VERSION }));
    RC.setWorldContext(424242, true);
    check('a canonical-stamped best stays sync-eligible during a practice session',
      localBestProvenanceCompatible() === true);
    RC.setRunSeed(null);
    localStorage.removeItem(BTMK('blue'));
  }
  check('unauthenticated local scoring does not write Firestore',
    calls.setDoc.length === 0);

  console.log('\n--- Score persistence survives optional-service failures ---');
  {
    const RC = await import('../src/run-context.ts');
    RC.setWorldContext(RC.CANONICAL_WORLD_SEED, false);
    const previousMeta = JSON.stringify({ ...RC.getRunStamp(), nonce: 123 });
    const originalReinitialize = window.AuthModule.reinitializeFirestore;
    const originalAvailability = window.AuthModule.isFirebaseAvailable;

    for (const failure of ['analytics', 'reinitialize', 'availability']) {
      for (const time of [30, 20]) {
        resetState(ScoresModule);
        localStorage.setItem(BTK('blue'), '25');
        localStorage.setItem(BTMK('blue'), previousMeta);
        currentAuthUser = { uid: 'resilient', displayName: 'Resilient' };
        ScoresModule.setCurrentUser(currentAuthUser);
        ScoresModule.rememberAccountBest('resilient', 25, 'blue');
        if (failure === 'analytics') {
          ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
          fb.setNextLogEventError(new Error('analytics unavailable'));
        } else {
          firestoreAvailable = false;
          if (failure === 'reinitialize') {
            window.AuthModule.reinitializeFirestore = () => { throw new Error('reinit unavailable'); };
          } else {
            window.AuthModule.isFirebaseAvailable = () => { throw new Error('availability unavailable'); };
          }
        }
        ScoresModule.recordScore(time);
        await flushAll();
        const expected = Math.min(25, time);
        check(`${failure}: current ${time}s preserves the best ${expected}s`,
          localStorage.getItem(BTK('blue')) === String(expected));
        check(`${failure}: provenance changes only for an improved best`,
          localStorage.getItem(BTMK('blue')) === (time < 25 ? JSON.stringify(RC.getRunStamp()) : previousMeta));
        check(`${failure}: signed-in best still syncs or queues`,
          failure === 'analytics'
            ? read('users', 'resilient')?.[F_BLUE] === expected && read(LB, 'resilient')?.time === expected
            : pendingTime('resilient', 'blue') === expected);
        window.AuthModule.reinitializeFirestore = originalReinitialize;
        window.AuthModule.isFirebaseAvailable = originalAvailability;
      }
    }

    // A failed read must not be treated as an empty store. Even if writes still
    // work, leave the unread best and its original provenance alone.
    resetState(ScoresModule);
    localStorage.setItem(BTK('blue'), '25');
    localStorage.setItem(BTMK('blue'), previousMeta);
    currentAuthUser = { uid: 'read-denied', displayName: 'Read denied' };
    ScoresModule.setCurrentUser(currentAuthUser);
    ScoresModule.initializeScores(firestoreInstance, null);
    seed('users', 'read-denied', { [F_BLUE]: 25 });
    seed(LB, 'read-denied', { user: doc(firestoreInstance, 'users', 'read-denied'), time: 25 });
    const originalGetItem = localStorage.getItem;
    localStorage.getItem = () => { throw new Error('read denied'); };
    ScoresModule.recordScore(30);
    await flushAll();
    localStorage.getItem = originalGetItem;
    check('denied reads never overwrite an unread personal best or stamp',
      localStorage.getItem(BTK('blue')) === '25' && localStorage.getItem(BTMK('blue')) === previousMeta);
    check('denied reads do not prevent authoritative remote reconciliation',
      read('users', 'read-denied')?.[F_BLUE] === 25 && read(LB, 'read-denied')?.time === 25);

    // Denied writes must not abort the online score path or restamp the old best.
    resetState(ScoresModule);
    localStorage.setItem(BTK('blue'), '25');
    localStorage.setItem(BTMK('blue'), previousMeta);
    currentAuthUser = { uid: 'write-denied', displayName: 'Write denied' };
    ScoresModule.setCurrentUser(currentAuthUser);
    ScoresModule.initializeScores(firestoreInstance, null);
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => { throw new Error('write denied'); };
    ScoresModule.recordScore(20);
    await flushAll();
    localStorage.setItem = originalSetItem;
    check('denied writes leave existing time and provenance intact',
      localStorage.getItem(BTK('blue')) === '25' && localStorage.getItem(BTMK('blue')) === previousMeta);
    check('denied writes still sync an improved score to user and leaderboard',
      read('users', 'write-denied')?.[F_BLUE] === 20 && read(LB, 'write-denied')?.time === 20);
    RC.setRunSeed(null);
  }

  console.log('\n--- Authenticated score sync ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'u1', displayName: 'Snow' };
  ScoresModule.setCurrentUser(currentAuthUser);
  ScoresModule.rememberAccountBest('u1', 19.43, 'blue');
  // The stored best carries a CURRENT-world provenance stamp: only a compatible
  // stamp lets the backfill promote it to the board (Codex review PR #407).
  localStorage.setItem(BTK('blue'), '19.43');
  {
    const RCv = await import('../src/run-context.ts');
    localStorage.setItem(BTMK('blue'),
      JSON.stringify({ seed: RCv.getRunStamp().seed, nonce: 0, physicsVersion: RCv.PHYSICS_VERSION }));
  }
  ScoresModule.recordScore(22);
  await flushAll();
  check('slower authenticated finish syncs the stored local best to the user doc',
    read('users', 'u1')?.[F_BLUE] === 19.43);
  check('slower authenticated finish backfills the leaderboard with the stored best',
    read(LB, 'u1')?.time === 19.43);
  // PROVENANCE GATE (Codex review PR #407): an UNSTAMPED (or other-world) stored
  // best must NOT be promoted by the sync — the run's own time syncs instead, so
  // the faster-but-unprovenanced 19.01 never reaches the user doc or the board.
  // (19.01: plausible for Blue — above its 18 s floor — but faster than the
  // synced 19.43, so promotion WOULD improve the board if the gate leaked.)
  localStorage.setItem(BTK('blue'), '19.01');
  localStorage.removeItem(BTMK('blue'));
  ScoresModule.recordScore(22);
  await flushAll();
  check('an unstamped legacy stored best is NOT promoted to the board (run time syncs instead)',
    read('users', 'u1')?.[F_BLUE] === 19.43 && read(LB, 'u1')?.time === 19.43);
  // Restore the compatible stamped best for the cases below.
  localStorage.setItem(BTK('blue'), '19.43');
  {
    const RCv = await import('../src/run-context.ts');
    localStorage.setItem(BTMK('blue'),
      JSON.stringify({ seed: RCv.getRunStamp().seed, nonce: 0, physicsVersion: RCv.PHYSICS_VERSION }));
  }
  check('leaderboard write denormalizes the signed-in display name onto the entry',
    read(LB, 'u1')?.displayName === 'Snow');
  check('score saving does not emit lifecycle completion analytics',
    !calls.logEvent.some(event => event.name === 'complete_run'));
  const runContext = await import('../src/run-context.ts');
  check('slower finish does not log a new-high-score event',
    !calls.logEvent.some(event => event.name === 'new_high_score'));

  console.log('\n--- Per-tier score sync (D2): Blue == original names, siblings for others ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'pt', displayName: 'Tier' };
  ScoresModule.setCurrentUser(currentAuthUser);

  ScoresModule.recordScore(22, 'bunny');
  await flushAll();
  const highScore = calls.logEvent.find(event => event.name === 'new_high_score');
  check('personal-best telemetry uses the recorded tier and physics version without identity',
    highScore?.params.difficulty === 'bunny' && highScore.params.physics_version === runContext.PHYSICS_VERSION
    && !('uid' in highScore.params) && !('seed' in highScore.params) && !('nonce' in highScore.params));
  check('bunny finish stores the local best under the per-tier key only',
    localStorage.getItem(BTK('bunny')) === '22' &&
    localStorage.getItem(BTK('blue')) === null);
  check('bunny finish writes users.bestTimeBunny, not bestTime',
    read('users', 'pt')?.[F_BUNNY] === 22 && read('users', 'pt')?.[F_BLUE] === undefined);
  check('bunny finish writes the bunny board collection, not the Blue board',
    read(LB_BUNNY, 'pt')?.time === 22 && read(LB, 'pt') == null);

  ScoresModule.recordScore(30, 'black');
  await flushAll();
  check('black finish is independent (leaderboard_black + bestTimeBlack; bunny untouched)',
    read(LB_BLACK, 'pt')?.time === 30 &&
    read('users', 'pt')?.[F_BLACK] === 30 &&
    read(LB_BUNNY, 'pt')?.time === 22);

  const bunnyLb = await ScoresModule.getLeaderboard('bunny');
  check('getLeaderboard("bunny") reads the bunny board',
    bunnyLb.length === 1 && bunnyLb[0].userId === 'pt' && bunnyLb[0].time === 22);
  const blueLbEmpty = await ScoresModule.getLeaderboard('blue');
  check('getLeaderboard("blue") does not see bunny/black entries', blueLbEmpty.length === 0);

  ScoresModule.recordScore(25); // no tier => Blue, the original names (back-compat)
  await flushAll();
  check('default (Blue) finish still uses the original key/collection/field',
    localStorage.getItem(BTK('blue')) === '25' &&
    read(LB, 'pt')?.time === 25 && read('users', 'pt')?.[F_BLUE] === 25);

  console.log('\n--- Authoritative best reconciliation ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'u2', displayName: null };
  ScoresModule.setCurrentUser(currentAuthUser);
  seed('users', 'u2', { [F_BLUE]: 20, updatedAt: { old: true } });
  ScoresModule.updateUserBestTime('u2', 25.43);
  await flushAll();
  check('slower run does not overwrite a faster Firestore user best',
    read('users', 'u2')?.[F_BLUE] === 20);
  check('missing leaderboard entry is backfilled with the authoritative best',
    read(LB, 'u2')?.time === 20);
  check('raw slower run never reaches the leaderboard',
    calls.setDoc.every(call => call.path !== `${LB}/u2` || call.data.time !== 25.43));

  console.log('\n--- Leaderboard compare/write behavior ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'u3', displayName: null };
  ScoresModule.setCurrentUser(currentAuthUser);
  seed(LB, 'u3', {
    user: doc(firestoreInstance, 'users', 'u3'),
    time: 25,
    achievedAt: { old: true }
  });
  ScoresModule.updateLeaderboard('u3', 28);
  await flushAll();
  check('leaderboard update does not downgrade a faster existing entry',
    read(LB, 'u3')?.time === 25);
  ScoresModule.updateLeaderboard('u3', 22);
  await flushAll();
  check('leaderboard update accepts a faster time',
    read(LB, 'u3')?.time === 22);
  check('leaderboard write by an owner without a display name stores null',
    read(LB, 'u3')?.displayName === null);

  console.log('\n--- Leaderboard display-name denormalization limits ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  const longName = 'x'.repeat(50);
  currentAuthUser = { uid: 'long', displayName: longName };
  ScoresModule.setCurrentUser(currentAuthUser);
  ScoresModule.updateLeaderboard('long', 20);
  await flushAll();
  check('display name is truncated to the rules\' 40-char cap before writing',
    read(LB, 'long')?.displayName === 'x'.repeat(40));
  ScoresModule.updateLeaderboard('someone-else', 19);
  await flushAll();
  check('a write for a different uid is rejected before touching Firestore',
    read(LB, 'someone-else') === undefined && !calls.getDoc.includes(`${LB}/someone-else`));

  console.log('\n--- Leaderboard rules-skew fallback: retry without displayName ---');
  // A rules rollback or a stale deployment can reject a displayName field.
  // Keep the score retry compatible with that previous allowlist. The score must
  // survive: one retry in the old-rules shape (no displayName field).
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'skew', displayName: 'Skewed' };
  ScoresModule.setCurrentUser(currentAuthUser);
  setNextSetDocError(`${LB}/skew`, { code: 'permission-denied' });
  ScoresModule.updateLeaderboard('skew', 20);
  await flushAll();
  check('permission-denied on the displayName write retries without the field',
    calls.setDoc.filter(c => c.path === `${LB}/skew`).length === 2 &&
    !('displayName' in calls.setDoc.filter(c => c.path === `${LB}/skew`)[1].data));
  check('the retried write lands the score despite the rules skew',
    read(LB, 'skew')?.time === 20 &&
    read(LB, 'skew')?.displayName === undefined);

  // Any other write error is NOT retried (offline etc. rides the SDK queue instead).
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'flaky', displayName: 'Flaky' };
  ScoresModule.setCurrentUser(currentAuthUser);
  setNextSetDocError(`${LB}/flaky`, { code: 'unavailable' });
  ScoresModule.updateLeaderboard('flaky', 21);
  await flushAll();
  check('non-permission write errors are not retried',
    calls.setDoc.filter(c => c.path === `${LB}/flaky`).length === 1 &&
    read(LB, 'flaky') == null);

  console.log('\n--- Leaderboard fetch filtering ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'reader' };
  ScoresModule.setCurrentUser(currentAuthUser);
  seed(LB, 'bad-fast', {
    user: doc(firestoreInstance, 'users', 'bad-fast'),
    time: 0.01
  });
  seed(LB, 'sub-floor', {              // forged sub-floor entry: must be filtered
    user: doc(firestoreInstance, 'users', 'sub-floor'),
    time: scoreFloor - 1
  });
  seed(LB, 'missing-user', {
    time: 24
  });
  seed(LB, 'fast', {
    user: doc(firestoreInstance, 'users', 'fast'),
    time: 24.67
  });
  seed(LB, 'slow', {
    user: doc(firestoreInstance, 'users', 'slow'),
    time: 58.64
  });
  const leaderboard = await ScoresModule.getLeaderboard();
  check('getLeaderboard returns only valid (>= floor) entries with user refs',
    leaderboard.length === 2 &&
    leaderboard[0].userId === 'fast' &&
    leaderboard[1].userId === 'slow');
  check('getLeaderboard orders valid entries by ascending time',
    leaderboard[0].time === 24.67 && leaderboard[1].time === 58.64);

  // Runtime reference identity and ownership must survive document reads. Shape
  // lookalikes, strings, and another user's real reference all used to pass the
  // truthiness check and escape as a supposedly trusted DocumentReference.
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'reader' };
  ScoresModule.setCurrentUser(currentAuthUser);
  seed(LB, 'valid', { user: doc(firestoreInstance, 'users', 'valid'), time: 30 });
  seed(LB, 'string', { user: 'users/string', time: 31 });
  seed(LB, 'lookalike', { user: { type: 'document', path: 'users/lookalike' }, time: 32 });
  seed(LB, 'wrong-owner', { user: doc(firestoreInstance, 'users', 'someone-else'), time: 33 });
  seed(LB, 'wrong-collection', { user: doc(firestoreInstance, 'other', 'wrong-collection'), time: 34 });
  const checkedReferences = await ScoresModule.getLeaderboard();
  check('leaderboard drops malformed and mismatched references at the boundary',
    checkedReferences.length === 1 && checkedReferences[0].userId === 'valid');
  check('Firestore mock reads preserve DocumentReference instances',
    checkedReferences[0].userRef instanceof fb.DocumentReference);

  console.log('\n--- Offline write ordering ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'u4' };
  ScoresModule.setCurrentUser(currentAuthUser);
  const write = setPendingWrite('users/u4');
  ScoresModule.updateUserBestTime('u4', 18);
  await flushAll();
  check('queued user write starts before leaderboard reconciliation',
    calls.setDoc.some(call => call.path === 'users/u4') &&
    !calls.getDoc.includes(`${LB}/u4`) &&
    !read(LB, 'u4'));
  write.resolve();
  await flushAll();
  check('leaderboard reconciliation runs after the queued user write settles',
    read(LB, 'u4')?.time === 18);

  console.log('\n--- New high score analytics ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'hs', displayName: 'HS' };
  ScoresModule.setCurrentUser(currentAuthUser);
  ScoresModule.recordScore(19); // first finish, no stored best => a new personal best
  await flushAll();
  check('a new authenticated personal best logs new_high_score',
    calls.logEvent.some(event => event.name === 'new_high_score' && event.params.time === 19));
  check('new personal best is also synced to the user doc',
    read('users', 'hs')?.[F_BLUE] === 19);

  console.log('\n--- getActiveUser falls back to AuthModule ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  // No setCurrentUser() call: recordScore must resolve the signed-in user via the
  // AuthModule.getAuthState()/getCurrentUser() fallback path.
  currentAuthUser = { uid: 'fallback', displayName: 'Fallback' };
  ScoresModule.recordScore(19);
  await flushAll();
  check('getActiveUser pulls the user from AuthModule when none was set',
    read('users', 'fallback')?.[F_BLUE] === 19);

  console.log('\n--- isFirestoreAvailable reflects AuthModule + local instance ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  check('isFirestoreAvailable is true when AuthModule is available and the local instance is set',
    ScoresModule.isFirestoreAvailable() === true);
  firestoreAvailable = false;
  check('isFirestoreAvailable is false when AuthModule reports unavailable',
    ScoresModule.isFirestoreAvailable() === false);

  console.log('\n--- displayLeaderboard: offline ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  env.setOnline(false);
  ScoresModule.displayLeaderboard();
  await flushAll();
  check('offline displayLeaderboard renders the offline message',
    document.getElementById('leaderboard').textContent.includes('You’re offline.'));
  env.setOnline(true);

  console.log('\n--- displayLeaderboard: renders ranked table and highlights current user ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'me', displayName: 'Me' };
  ScoresModule.setCurrentUser(currentAuthUser);
  seed(LB, 'me', { user: doc(firestoreInstance, 'users', 'me'), time: 19.34 });
  seed(LB, 'other',
    { user: doc(firestoreInstance, 'users', 'other'), time: 20, displayName: 'Rival' });
  seed(LB, 'legacy', { user: doc(firestoreInstance, 'users', 'legacy'), time: 21 });
  ScoresModule.displayLeaderboard();
  await flushAll();
  let lbHtml = document.getElementById('leaderboard').innerHTML;
  check('displayLeaderboard renders the Top 10 times table',
    lbHtml.includes('Leaderboards') && lbHtml.includes('<table>'));
  check('displayLeaderboard renders rows ascending with formatted times',
    lbHtml.includes('19.34s') && lbHtml.includes('20.00s') &&
    lbHtml.indexOf('19.34s') < lbHtml.indexOf('20.00s'));
  check('displayLeaderboard highlights and names the current user row',
    lbHtml.includes('current-user-score') && lbHtml.includes('Me'));
  check('other players render their denormalized display name',
    lbHtml.includes('Rival'));
  check('entries without a denormalized name fall back to Skier',
    lbHtml.includes('Skier'));

  console.log('\n--- displayLeaderboard: user-controlled strings render as text (XSS regression) ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  // A display name that would execute if it ever reached innerHTML as markup.
  currentAuthUser = { uid: 'evil', displayName: '<img src=x onerror=window.__pwned=1>' };
  ScoresModule.setCurrentUser(currentAuthUser);
  seed(LB, 'evil', { user: doc(firestoreInstance, 'users', 'evil'), time: 19.5 });
  // The stored-XSS vector: ANOTHER player's denormalized name reaching the viewer.
  seed(LB, 'bystander', {
    user: doc(firestoreInstance, 'users', 'bystander'),
    time: 21,
    displayName: '<img src=y onerror=window.__pwned=2>'
  });
  ScoresModule.displayLeaderboard();
  await flushAll();
  const lbEl = document.getElementById('leaderboard');
  check('malicious display name renders as literal text, not markup',
    lbEl.textContent.includes('<img src=x onerror=window.__pwned=1>'));
  check('another player\'s malicious denormalized name renders as literal text',
    lbEl.textContent.includes('<img src=y onerror=window.__pwned=2>'));
  check('malicious display name injects no element into the leaderboard',
    lbEl.querySelectorAll('img').length === 0);
  check('no injected handler ran',
    /** @type {any} */ (env.window).__pwned === undefined);

  console.log('\n--- leaderboardRow: avatar scheme allowlist (unit seam) ---');
  {
    const row = ScoresModule.leaderboardRow(1, 'Alice', 'https://example.com/a.png', 19.5, false);
    const img = /** @type {HTMLImageElement | null} */ (row.querySelector('img.mini-avatar'));
    check('an https avatar URL renders as an img via property assignment',
      !!img && img.src === 'https://example.com/a.png' && img.alt === '');
    check('the avatar img carries referrerpolicy=no-referrer',
      !!img && img.referrerPolicy === 'no-referrer');
    check('row cells carry rank, name, and formatted time as text',
      row.cells.length === 3 && row.cells[0].textContent === '1' &&
      row.cells[1].textContent.includes('Alice') && row.cells[2].textContent === '19.50s');
    const jsRow = ScoresModule.leaderboardRow(2, 'Mallory', 'javascript:alert(1)', 20, false);
    const dataRow = ScoresModule.leaderboardRow(3, 'Trudy', 'data:text/html,x', 21, false);
    const httpRow = ScoresModule.leaderboardRow(4, 'Eve', 'http://example.com/a.png', 22, false);
    check('javascript:, data:, and plain-http avatar URLs are all rejected (no img)',
      !jsRow.querySelector('img') && !dataRow.querySelector('img') && !httpRow.querySelector('img'));
    check('rejected-avatar rows still render the name as text',
      jsRow.cells[1].textContent.includes('Mallory'));
    const meRow = ScoresModule.leaderboardRow(5, 'Me', null, 23, true);
    check('current-user rows are flagged and a null photoURL renders no avatar',
      meRow.className === 'current-user-score' && !meRow.querySelector('img'));
    const plainRow = ScoresModule.leaderboardRow(6, 'Zoe', null, 24, false);
    check('non-current-user rows carry no highlight class', plainRow.className === '');
  }

  console.log('\n--- displayLeaderboard: empty board ---');
  resetState(ScoresModule);
  currentAuthUser = { uid: 'reader' };
  ScoresModule.setCurrentUser(currentAuthUser);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  ScoresModule.displayLeaderboard();
  await flushAll();
  check('empty leaderboard invites the first time',
    document.getElementById('leaderboard').textContent.includes('times yet. Set the first one!'));

  console.log('\n--- displayLeaderboard: unavailable Firestore, failed reinitialization ---');
  resetState(ScoresModule);
  currentAuthUser = { uid: 'reader' };
  ScoresModule.setCurrentUser(currentAuthUser);
  // Local instance stays null (resetState initializes with null) and AuthModule reports
  // unavailable, so the reinitialization attempt fails => unavailable message.
  firestoreAvailable = false;
  reinitializeSucceeds = false;
  ScoresModule.displayLeaderboard();
  await flushAll();
  check('displayLeaderboard attempts reinitialization when Firestore is unavailable',
    calls.reinitializeFirestore > 0);
  check('failed reinitialization renders the unavailable message',
    document.getElementById('leaderboard').textContent.includes('Couldn’t load these times.'));

  console.log('\n--- displayLeaderboard: reinitializes a null local instance then renders ---');
  resetState(ScoresModule);
  currentAuthUser = { uid: 'reader' };
  ScoresModule.setCurrentUser(currentAuthUser);
  // AuthModule reports available but the local instance is null; a successful
  // reinitialization must restore it and let the fetch+render proceed.
  firestoreAvailable = true;
  reinitializeSucceeds = true;
  seed(LB, 'x', { user: doc(firestoreInstance, 'users', 'x'), time: 30 });
  ScoresModule.displayLeaderboard();
  await flushAll();
  check('successful reinitialization restores the local instance and renders scores',
    calls.reinitializeFirestore > 0 &&
    document.getElementById('leaderboard').innerHTML.includes('30.00s'));

  console.log('\n--- offline-queue reconnect (issue #358, PR 4) ---');
  // A signed-in real user finished a ranked run while Firestore was NOT initialized
  // (offline first-load), leaving a durable pending marker. On reconnect the module must
  // REINITIALIZE Firestore (whose initializeScores re-runs the flush), not just no-op.
  resetState(ScoresModule);
  currentAuthUser = { uid: 'u-recon', isAnonymous: false, displayName: 'Recon' };
  firestoreAvailable = false;             // AuthModule reports Firestore down...
  ScoresModule.initializeScores(null, null); // ...and the local instance is null
  reinitializeSucceeds = true;            // reinit will restore it + re-run the flush
  seedPending('u-recon', 'blue', 25);
  calls.reinitializeFirestore = 0;
  window.dispatchEvent(new window.Event('online'));
  await flushAll();
  // Triggering the reinit is the fix (Codex #362); reinit's initializeScores re-runs the
  // flush. The flush→clear mechanics (confirmed-sync only) are unit-tested in sync-manager.
  check('reconnect with a pending best reinitializes Firestore', calls.reinitializeFirestore > 0);

  // No reinit churn when there is no pending work.
  resetState(ScoresModule);
  currentAuthUser = { uid: 'u2', isAnonymous: false };
  firestoreAvailable = false;
  ScoresModule.initializeScores(null, null);
  calls.reinitializeFirestore = 0;
  window.dispatchEvent(new window.Event('online'));
  await flushAll();
  check('reconnect with NO pending work does not reinitialize', calls.reinitializeFirestore === 0);

  // An anonymous guest never triggers a reinit (stays local-only).
  resetState(ScoresModule);
  currentAuthUser = { uid: 'guest', isAnonymous: true };
  firestoreAvailable = false;
  ScoresModule.initializeScores(null, null);
  seedPending('guest', 'blue', 25);
  calls.reinitializeFirestore = 0;
  window.dispatchEvent(new window.Event('online'));
  await flushAll();
  check('anonymous guest does not reinitialize on reconnect', calls.reinitializeFirestore === 0);

  console.log('\n--- offline-queue flush on auth restore (issue #358, PR 4, Codex #362) ---');
  // A persisted login restored on reload: initializeScores runs its early flush BEFORE the
  // auth observer calls setCurrentUser, so that flush no-ops with no active user. When the
  // real user finally arrives via setCurrentUser (no later `online` event on an already-
  // online session), the module must drain the queue — here reinitialize Firestore, whose
  // initializeScores re-runs the flush — rather than leave the marker stuck.
  resetState(ScoresModule);
  firestoreAvailable = false;                // AuthModule reports Firestore down...
  ScoresModule.initializeScores(null, null); // ...local instance null; early flush no-ops (no user)
  reinitializeSucceeds = true;
  seedPending('u-restore', 'blue', 25);
  calls.reinitializeFirestore = 0;
  currentAuthUser = { uid: 'u-restore', isAnonymous: false, displayName: 'Restore' };
  ScoresModule.setCurrentUser(currentAuthUser);
  await flushAll();
  check('a restored real user with a pending best drains the queue (reinitializes Firestore)',
    calls.reinitializeFirestore > 0);

  // A restored anonymous guest never drains/reinits (stays local-only).
  resetState(ScoresModule);
  firestoreAvailable = false;
  ScoresModule.initializeScores(null, null);
  seedPending('guest2', 'blue', 25);
  calls.reinitializeFirestore = 0;
  currentAuthUser = { uid: 'guest2', isAnonymous: true };
  ScoresModule.setCurrentUser(currentAuthUser);
  await flushAll();
  check('a restored anonymous guest does not reinitialize', calls.reinitializeFirestore === 0);

  // No pending work → setCurrentUser must not churn a reinit.
  resetState(ScoresModule);
  firestoreAvailable = false;
  ScoresModule.initializeScores(null, null);
  calls.reinitializeFirestore = 0;
  currentAuthUser = { uid: 'u-nopending', isAnonymous: false };
  ScoresModule.setCurrentUser(currentAuthUser);
  await flushAll();
  check('setCurrentUser with no pending work does not reinitialize', calls.reinitializeFirestore === 0);

  console.log('\n--- offline-queue: a FAILED online sync is queued for retry (Codex #362) ---');
  // Online + Firestore ready + signed-in ranked finish, but the user-doc write fails
  // (flaky Firestore). updateUserBestTime resolves false, so recordScore must mark the
  // best pending — otherwise the best is stranded in localStorage with no retry (the
  // finish-path queueOfflineBest no-ops while online).
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'u-flaky-sync', isAnonymous: false, displayName: 'FlakySync' };
  ScoresModule.setCurrentUser(currentAuthUser);
  setNextSetDocError('users/u-flaky-sync', { code: 'unavailable' }); // the personal-best write fails
  ScoresModule.recordScore(25); // Blue (ranked); fresh best => effectiveBestTime = 25
  await flushAll();
  check('a failed online ranked sync is queued pending for retry',
    pendingTime('u-flaky-sync', 'blue') === 25);

  console.log('\n--- offline-queue: reinit reattaches a detached ScoresModule, then flushes (Codex #362) ---');
  // Divergence: AuthModule still holds Firestore (firestoreAvailable = true) but ScoresModule
  // nulled its OWN local instance after a transient leaderboard failure (scores.ts clears it
  // on 'unavailable'). resetState leaves exactly that state (available + local null). A
  // pending best + reconnect must reinitialize, REATTACH ScoresModule, and flush — not stay
  // stuck because reinit early-returns without re-pushing the instance (the auth.ts fix).
  resetState(ScoresModule); // firestoreAvailable = true, ScoresModule local firestore = null
  reinitializeSucceeds = true; // reinit reattaches ScoresModule (its initializeScores re-runs the flush)
  currentAuthUser = { uid: 'u-detached', isAnonymous: false, displayName: 'Detached' };
  ScoresModule.setCurrentUser(currentAuthUser); // no marker yet → drains to a no-op
  seedPending('u-detached', 'blue', 25);
  calls.reinitializeFirestore = 0;
  window.dispatchEvent(new window.Event('online'));
  await flushAll();
  check('a detached ScoresModule reconnect reinitializes', calls.reinitializeFirestore > 0);
  check('reattach + flush clears the pending marker',
    pendingTime('u-detached', 'blue') === undefined);

  console.log('\n--- syncBestTimeWithRetry: sign-in backfill queues a failed sync (Codex #362) ---');
  // auth.ts's sign-in backfill (the only automatic path for a local-only best) routes
  // through this. A transient user-doc failure must queue a pending marker rather than drop
  // the best; a confirmed sync must leave no marker.
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'u-backfill', isAnonymous: false, displayName: 'Backfill' };
  ScoresModule.setCurrentUser(currentAuthUser);
  setNextSetDocError('users/u-backfill', { code: 'unavailable' }); // the backfill write fails
  ScoresModule.syncBestTimeWithRetry('u-backfill', 22, 'blue');
  await flushAll();
  check('a failed sign-in backfill is queued pending for retry',
    pendingTime('u-backfill', 'blue') === 22);

  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'u-backfill-ok', isAnonymous: false, displayName: 'BackfillOK' };
  ScoresModule.setCurrentUser(currentAuthUser);
  ScoresModule.syncBestTimeWithRetry('u-backfill-ok', 22, 'blue');
  await flushAll();
  check('a confirmed sign-in backfill leaves no pending marker',
    pendingTime('u-backfill-ok', 'blue') === undefined);

  console.log('\n--- Every ranked level uses its own validated namespace ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'all-levels', displayName: 'All levels' };
  ScoresModule.setCurrentUser(currentAuthUser);
  for (const cfg of Difficulty.DIFFICULTIES) {
    const result = await ScoresModule.recordScore(cfg.minScoreTime, cfg.id);
    check(`${cfg.id}: the tier floor saves locally and confirms remotely`,
      result.status === 'saved' && result.localSaved && result.userId === 'all-levels' &&
      localStorage.getItem(BTK(cfg.id)) === String(cfg.minScoreTime) &&
      read('users', 'all-levels')?.[Difficulty.userBestTimeField(cfg.id)] === cfg.minScoreTime &&
      read(Difficulty.leaderboardCollectionName(cfg.id), 'all-levels')?.time === cfg.minScoreTime);
    const board = await ScoresModule.getLeaderboardResult(cfg.id);
    check(`${cfg.id}: retrieval accepts its own floor and no other level's rows`,
      board.status === 'ready' && board.scores.length === 1 && board.scores[0].time === cfg.minScoreTime &&
      calls.getDocs.at(-1).constraints.find(c => c.kind === 'where').value === cfg.minScoreTime);
    const before = calls.setDoc.length;
    const invalid = await ScoresModule.saveScore(cfg.minScoreTime - 0.01, cfg.id);
    check(`${cfg.id}: a sub-floor attempt never overwrites or submits a best`,
      invalid.status === 'invalid' && calls.setDoc.length === before &&
      localStorage.getItem(BTK(cfg.id)) === String(cfg.minScoreTime));
  }
  seed(Difficulty.legacyLeaderboardCollectionName('blue'), 'historical', {
    user: doc(firestoreInstance, 'users', 'historical'), time: 18,
  });
  const currentBoard = await ScoresModule.getLeaderboard('blue');
  check('historical physics eras never enter a current board',
    currentBoard.length === 1 && currentBoard[0].userId === 'all-levels');

  console.log('\n--- Device records do not transfer between accounts ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  localStorage.setItem(BTK('blue'), '18');
  Difficulty.stampLocalBestMeta('blue');
  currentAuthUser = { uid: 'owner-a' };
  ScoresModule.setCurrentUser(currentAuthUser);
  ScoresModule.rememberAccountBest('owner-a', 20, 'blue');
  const ownerA = await ScoresModule.saveScore(30, 'blue');
  check('an owner can reconcile their own faster record without claiming the device best',
    ownerA.status === 'saved' && read('users', 'owner-a')?.[F_BLUE] === 20 && read(LB, 'owner-a')?.time === 20);
  currentAuthUser = { uid: 'owner-b' };
  ScoresModule.setCurrentUser(currentAuthUser);
  const ownerB = await ScoresModule.saveScore(25, 'blue');
  check('a slower run by another account still creates that account’s own best',
    ownerB.status === 'saved' && ScoresModule.getLocalBestForUser('blue', 'owner-b') === 25 &&
    read('users', 'owner-b')?.[F_BLUE] === 25 && read(LB, 'owner-b')?.time === 25);
  check('saving for account B preserves account A and the shared device record',
    ScoresModule.getLocalBestForUser('blue', 'owner-a') === 20 &&
    localStorage.getItem(BTK('blue')) === '18' && read(LB, 'owner-a')?.time === 20);
  ScoresModule.rememberAccountBest('owner-b', 40, 'blue');
  check('a slower remembered account best cannot regress the account record',
    ScoresModule.getLocalBestForUser('blue', 'owner-b') === 25);
  const { accountBestTimeKey } = await import('../src/scores.ts');
  localStorage.setItem(accountBestTimeKey('owner-b', 'black'), JSON.stringify({
    uid: 'owner-a', time: 12, seed: runContext.CANONICAL_WORLD_SEED, physicsVersion: runContext.PHYSICS_VERSION,
  }));
  check('a mismatched owner in an account record is rejected', ScoresModule.getLocalBestForUser('black', 'owner-b') === null);
  for (const record of [
    { uid: 'owner-b', time: 12, seed: 123, physicsVersion: runContext.PHYSICS_VERSION },
    { uid: 'owner-b', time: 12, seed: runContext.CANONICAL_WORLD_SEED, physicsVersion: runContext.PHYSICS_VERSION - 1 },
  ]) {
    localStorage.setItem(accountBestTimeKey('owner-b', 'black'), JSON.stringify(record));
    check('a different world or physics era cannot populate the current account best',
      ScoresModule.getLocalBestForUser('black', 'owner-b') === null);
  }

  console.log('\n--- Guest save, explicit claim, and anonymous boundaries ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  localStorage.setItem(BTK('blue'), '18');
  const guestResult = await ScoresModule.recordScore(25);
  check('a signed-out finish reports local status without writing or queueing remotely',
    guestResult.status === 'local' && guestResult.localSaved && !guestResult.userId &&
    calls.setDoc.length === 0 && Object.keys(store.readPendingSync()).length === 0);
  currentAuthUser = { uid: 'claimed' };
  ScoresModule.setCurrentUser(currentAuthUser);
  check('signing in does not claim an unrelated shared-device best', calls.setDoc.length === 0);
  const claim = await ScoresModule.saveScore(25);
  check('explicit end-of-run save claims that finish instead of the faster device record',
    claim.status === 'saved' && read('users', 'claimed')?.[F_BLUE] === 25 && read(LB, 'claimed')?.time === 25 &&
    localStorage.getItem(BTK('blue')) === '18');
  check('a save retry does not duplicate completed-run telemetry',
    calls.logEvent.filter(event => event.name === 'complete_run').length === 0);
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, null);
  currentAuthUser = { uid: 'anonymous', isAnonymous: true };
  ScoresModule.setCurrentUser(currentAuthUser);
  const anonymousResult = await ScoresModule.recordScore(25);
  const anonymousWrite = await ScoresModule.updateUserBestTime('anonymous', 25);
  const anonymousRetry = await ScoresModule.syncBestTimeWithRetry('anonymous', 25, 'blue');
  check('an anonymous identity passed directly to ScoresModule remains local-only',
    anonymousResult.status === 'local' && !anonymousWrite && !anonymousRetry &&
    calls.setDoc.length === 0 && Object.keys(store.readPendingSync()).length === 0);
  runContext.setWorldContext(12345, true);
  const practiceResult = await ScoresModule.saveScore(20);
  check('a custom mountain cannot overwrite canonical device or account scores',
    practiceResult.status === 'invalid' && localStorage.getItem(BTK('blue')) === '25');
  runContext.setRunSeed(null);

  console.log('\n--- Save status confirms persistence instead of assuming it ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, null);
  currentAuthUser = { uid: 'offline-owner' };
  ScoresModule.setCurrentUser(currentAuthUser);
  env.setOnline(false);
  for (const cfg of Difficulty.DIFFICULTIES) {
    const offline = await ScoresModule.saveScore(30, cfg.id);
    check(`${cfg.id}: an offline registered finish is durably queued under its owner`,
      offline.status === 'queued' && offline.localSaved && offline.userId === 'offline-owner' &&
      pendingTime('offline-owner', cfg.id) === 30 && ScoresModule.getLocalBestForUser(cfg.id, 'offline-owner') === 30);
  }
  check('offline saves do not start SDK writes', calls.setDoc.length === 0);
  resetState(ScoresModule);
  currentAuthUser = { uid: 'storage-unavailable' };
  ScoresModule.setCurrentUser(currentAuthUser);
  env.setOnline(false);
  const realSetItem = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('quota'); };
  const unsaved = await ScoresModule.saveScore(25);
  localStorage.setItem = realSetItem;
  check('unavailable storage never produces a false saved or queued status',
    unsaved.status === 'unavailable' && !unsaved.localSaved && pendingTime('storage-unavailable', 'blue') === undefined);

  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, null);
  currentAuthUser = { uid: 'durable' };
  ScoresModule.setCurrentUser(currentAuthUser);
  const slowWrite = setPendingWrite('users/durable');
  const syncEvents = [];
  const onSync = event => syncEvents.push(/** @type {CustomEvent} */ (event).detail);
  window.addEventListener('snowglider:score-synced', onSync);
  const durableSave = ScoresModule.saveScore(30);
  check('retry intent exists synchronously before an online SDK request settles',
    pendingTime('durable', 'blue') === 30 && ScoresModule.getLocalBestForUser('blue', 'durable') === 30);
  await flushAll();
  seedPending('durable', 'blue', 25);
  slowWrite.resolve();
  const durableResult = await durableSave;
  check('an old confirmed save cannot erase a faster pending run',
    durableResult.status === 'saved' && pendingTime('durable', 'blue') === 25);
  check('confirmation events carry the confirmed request time rather than a newer pending time',
    syncEvents.some(event => event.userId === 'durable' && event.tier === 'blue' && event.time === 30) &&
    !syncEvents.some(event => event.time === 25));
  window.removeEventListener('snowglider:score-synced', onSync);

  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, null);
  currentAuthUser = { uid: 'hanging-write' };
  ScoresModule.setCurrentUser(currentAuthUser);
  const hangingWrite = setPendingWrite('users/hanging-write');
  const globalForTimer = /** @type {any} */ (globalThis);
  const originalTimeout = globalForTimer.setTimeout;
  globalForTimer.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 4000 ? 0 : delay, ...args);
  let timedResult;
  try { timedResult = await ScoresModule.saveScore(27); }
  finally { globalForTimer.setTimeout = originalTimeout; }
  check('a hanging online write returns queued without pretending to be saved',
    timedResult.status === 'queued' && pendingTime('hanging-write', 'blue') === 27 && read(LB, 'hanging-write') === undefined);
  hangingWrite.resolve();
  await flushAll();
  check('late confirmation finishes the board save and clears the durable marker',
    read(LB, 'hanging-write')?.time === 27 && pendingTime('hanging-write', 'blue') === undefined);

  console.log('\n--- Account switching cannot redirect in-flight work ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, null);
  currentAuthUser = { uid: 'switch-a' };
  ScoresModule.setCurrentUser(currentAuthUser);
  const switchedSave = ScoresModule.saveScore(25);
  currentAuthUser = { uid: 'switch-b' };
  ScoresModule.setCurrentUser(currentAuthUser);
  const switchedResult = await switchedSave;
  check('a session switch before a write preserves only the captured owner’s retry',
    switchedResult.status === 'queued' && switchedResult.userId === 'switch-a' &&
    pendingTime('switch-a', 'blue') === 25 && pendingTime('switch-b', 'blue') === undefined && calls.setDoc.length === 0);

  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, null);
  currentAuthUser = { uid: 'mid-write-a' };
  ScoresModule.setCurrentUser(currentAuthUser);
  const accountWrite = setPendingWrite('users/mid-write-a');
  const accountSave = ScoresModule.saveScore(26);
  await flushAll();
  currentAuthUser = { uid: 'mid-write-b' };
  ScoresModule.setCurrentUser(currentAuthUser);
  accountWrite.resolve();
  const accountResult = await accountSave;
  check('a switch during a queued profile write stops later board writes and retains the original retry',
    accountResult.status === 'queued' && pendingTime('mid-write-a', 'blue') === 26 &&
    read(LB, 'mid-write-a') === undefined && read('users', 'mid-write-b') === undefined && read(LB, 'mid-write-b') === undefined);

  console.log('\n--- Read statuses distinguish an empty board from an error ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, null);
  check('signed-out reads report sign-in required without an SDK query',
    (await ScoresModule.getLeaderboardResult()).status === 'signed-out' && calls.getDocs.length === 0);
  env.setOnline(false);
  check('offline reads report offline without an SDK query',
    (await ScoresModule.getLeaderboardResult()).status === 'offline' && calls.getDocs.length === 0);
  env.setOnline(true);
  currentAuthUser = { uid: 'reader' };
  ScoresModule.setCurrentUser(currentAuthUser);
  const empty = await ScoresModule.getLeaderboardResult();
  check('a successful empty query is ready with zero rows', empty.status === 'ready' && empty.scores.length === 0);
  const collectionStore = fb.db[LB];
  const originalEntries = collectionStore.entries;
  for (const code of ['permission-denied', 'unavailable']) {
    collectionStore.entries = () => { throw { code }; };
    const failedRead = await ScoresModule.getLeaderboardResult();
    check(`${code}: read failure is unavailable, not an empty ready board`, failedRead.status === 'unavailable' && failedRead.scores.length === 0);
  }
  collectionStore.entries = originalEntries;
  seed(LB, 'visible', { user: doc(firestoreInstance, 'users', 'visible'), time: 25 });
  const staleRead = ScoresModule.getLeaderboardResult();
  currentAuthUser = { uid: 'another-reader' };
  ScoresModule.setCurrentUser(currentAuthUser);
  check('a read that completes after an account switch returns no stale rows',
    (await staleRead).scores.length === 0);

  console.log('\n--- Cached and pending documents are not save confirmations ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, null);
  currentAuthUser = { uid: 'cached-profile' };
  ScoresModule.setCurrentUser(currentAuthUser);
  seed('users', 'cached-profile', { [F_BLUE]: 20 });
  const cachedRead = fb.setPendingRead('users/cached-profile', { fromCache: true });
  const cachedWrite = setPendingWrite('users/cached-profile');
  let cachedSettled = false;
  const cachedSave = ScoresModule.saveScore(30).then(result => { cachedSettled = true; return result; });
  await flushAll();
  cachedRead.resolve();
  await flushAll();
  check('a faster cached profile best requires a real write before saved status',
    !cachedSettled && calls.setDoc.some(call => call.path === 'users/cached-profile') &&
    pendingTime('cached-profile', 'blue') === 30 && read(LB, 'cached-profile') === undefined);
  cachedWrite.resolve();
  check('the cached best is confirmed only after its actual server write and board reconciliation',
    (await cachedSave).status === 'saved' && read(LB, 'cached-profile')?.time === 20);

  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, null);
  currentAuthUser = { uid: 'pending-board' };
  ScoresModule.setCurrentUser(currentAuthUser);
  seed('users', 'pending-board', { [F_BLUE]: 20 });
  seed(LB, 'pending-board', { user: doc(firestoreInstance, 'users', 'pending-board'), time: 18 });
  const pendingBoardRead = fb.setPendingRead(`${LB}/pending-board`, { hasPendingWrites: true });
  const pendingBoardWrite = setPendingWrite(`${LB}/pending-board`);
  let boardSettled = false;
  const pendingBoardSave = ScoresModule.saveScore(30).then(result => { boardSettled = true; return result; });
  await flushAll();
  pendingBoardRead.resolve();
  await flushAll();
  check('a faster unconfirmed board entry cannot satisfy the save early',
    !boardSettled && pendingTime('pending-board', 'blue') === 30 &&
    calls.setDoc.some(call => call.path === `${LB}/pending-board` && call.data.time === 18));
  pendingBoardWrite.resolve();
  check('the faster board time confirms after its actual write settles',
    (await pendingBoardSave).status === 'saved' && pendingTime('pending-board', 'blue') === undefined);
  check('a faster confirmed board best repairs the user profile for fresh-device retrieval',
    read('users', 'pending-board')?.[F_BLUE] === 18 && ScoresModule.getLocalBestForUser('blue', 'pending-board') === 18);

  console.log('\n--- Concurrent server improvements satisfy stale save requests ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, null);
  currentAuthUser = { uid: 'server-race' };
  ScoresModule.setCurrentUser(currentAuthUser);
  const rejectedWrite = setPendingWrite('users/server-race');
  const raceSave = ScoresModule.saveScore(30);
  await flushAll();
  seed('users', 'server-race', { [F_BLUE]: 20 });
  rejectedWrite.reject({ code: 'permission-denied' });
  check('a monotonic rejection reconciles the newer server best and confirms the board',
    (await raceSave).status === 'saved' && read('users', 'server-race')?.[F_BLUE] === 20 &&
    read(LB, 'server-race')?.time === 20 && pendingTime('server-race', 'blue') === undefined);

  console.log('\n--- Copied score modules use the bundled game’s live provenance ---');
  const previousLiveGetter = window.__snowgliderGetRunStamp;
  try {
    resetState(ScoresModule);
    ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
    currentAuthUser = { uid: 'live-world' };
    ScoresModule.setCurrentUser(currentAuthUser);
    // The imported score graph deliberately disagrees with the live game.
    runContext.setWorldContext(1234, true);
    const liveStamp = { seed: runContext.CANONICAL_WORLD_SEED, practice: false, nonce: 7, physicsVersion: runContext.PHYSICS_VERSION };
    window.__snowgliderGetRunStamp = () => liveStamp;
    const liveResult = await ScoresModule.recordScore(20);
    const storedStamp = JSON.parse(localStorage.getItem(BTMK('blue')));
    check('live canonical provenance controls save eligibility despite a stale imported context',
      liveResult.status === 'saved' && read('users', 'live-world')?.[F_BLUE] === 20 && read(LB, 'live-world')?.time === 20);
    check('device metadata preserves the bundled game’s canonical seed and replay nonce',
      storedStamp.seed === liveStamp.seed && storedStamp.nonce === 7 && !storedStamp.practice &&
      storedStamp.physicsVersion === liveStamp.physicsVersion);
    check('personal-best analytics uses the same live physics and practice context as the save',
      calls.logEvent.some(event => event.name === 'new_high_score' && event.params.practice === 'false' &&
        event.params.physics_version === liveStamp.physicsVersion));

    runContext.setWorldContext(runContext.CANONICAL_WORLD_SEED, false);
    const rejectedStamps = [
      { ...liveStamp, practice: true },
      { ...liveStamp, seed: 1234 },
      { ...liveStamp, physicsVersion: runContext.PHYSICS_VERSION - 1 },
      { ...liveStamp, seed: null },
    ];
    for (const stamp of rejectedStamps) {
      resetState(ScoresModule);
      ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
      currentAuthUser = { uid: 'blocked-live-world' };
      ScoresModule.setCurrentUser(currentAuthUser);
      window.__snowgliderGetRunStamp = () => stamp;
      const recorded = await ScoresModule.recordScore(20);
      const saved = await ScoresModule.saveScore(20);
      check('practice, noncanonical, wrong-version or missing live worlds cannot write or claim a score',
        recorded.status === 'invalid' && saved.status === 'invalid' && calls.setDoc.length === 0 &&
        calls.logEvent.length === 0 && localStorage.getItem(BTK('blue')) === null &&
        ScoresModule.getLocalBestForUser('blue', 'blocked-live-world') === null && Object.keys(store.readPendingSync()).length === 0);
    }
    window.__snowgliderGetRunStamp = () => { throw new Error('live context unavailable'); };
    check('a broken live getter fails closed instead of trusting the stale imported world',
      (await ScoresModule.saveScore(20)).status === 'invalid' && calls.setDoc.length === 0);
    delete window.__snowgliderGetRunStamp;
    runContext.rewindRunStreams(13);
    currentAuthUser = null;
    ScoresModule.setCurrentUser(null);
    const fallbackResult = await ScoresModule.saveScore(20);
    check('auth-only/test callers without a live seam retain the imported-context fallback',
      fallbackResult.status === 'local' && JSON.parse(localStorage.getItem(BTMK('blue'))).nonce === 13);
  } finally {
    if (previousLiveGetter) window.__snowgliderGetRunStamp = previousLiveGetter;
    else delete window.__snowgliderGetRunStamp;
    runContext.setRunSeed(null);
  }

  console.log(`\nSCORES TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
