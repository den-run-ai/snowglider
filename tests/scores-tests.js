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
  ({ firestoreInstance, analyticsInstance, calls, doc, seed, read, setPendingWrite } = fb);
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

async function main() {
  const ScoresModule = await loadScoresModule();

  console.log('--- ScoresModule load & validation ---');
  check('module exposes the expected public surface',
    !!ScoresModule && ['initializeScores', 'setCurrentUser', 'recordScore',
      'getLeaderboard', 'updateUserBestTime', 'updateLeaderboard',
      'isFirestoreAvailable', 'isValidScoreTime'].every(key => typeof ScoresModule[key] === 'function'));
  check('score validation rejects impossible, sub-floor and non-finite times',
    ScoresModule.isValidScoreTime(0.01) === false &&
    ScoresModule.isValidScoreTime(14) === false &&     // below the 18 s plausibility floor (PR C)
    ScoresModule.isValidScoreTime(17.99) === false &&  // just under the floor
    ScoresModule.isValidScoreTime(600.01) === false &&
    ScoresModule.isValidScoreTime(Infinity) === false &&
    ScoresModule.isValidScoreTime(/** @type {any} */ ('20')) === false);
  check('score validation accepts plausible numeric times at/above the floor',
    ScoresModule.isValidScoreTime(18) === true &&
    ScoresModule.isValidScoreTime(600) === true &&
    ScoresModule.isValidScoreTime(25.43) === true);

  console.log('\n--- Local score recording ---');
  resetState(ScoresModule);
  ScoresModule.recordScore(0.01);
  check('invalid runs are not stored locally',
    localStorage.getItem('snowgliderBestTime') === null);
  ScoresModule.recordScore(600.01);
  check('over-cap runs are not stored locally',
    localStorage.getItem('snowgliderBestTime') === null);
  localStorage.setItem('snowgliderBestTime', 'bogus');
  ScoresModule.recordScore(21.5);
  check('invalid stored local best is replaced by a valid run',
    localStorage.getItem('snowgliderBestTime') === '21.5');
  ScoresModule.recordScore(25);
  check('slower valid runs do not replace the local best',
    localStorage.getItem('snowgliderBestTime') === '21.5');
  check('unauthenticated local scoring does not write Firestore',
    calls.setDoc.length === 0);

  console.log('\n--- Authenticated score sync ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'u1', displayName: 'Snow' };
  ScoresModule.setCurrentUser(currentAuthUser);
  localStorage.setItem('snowgliderBestTime', '19.43');
  ScoresModule.recordScore(22);
  await flushAll();
  check('slower authenticated finish syncs the stored local best to the user doc',
    read('users', 'u1')?.bestTime === 19.43);
  check('slower authenticated finish backfills the leaderboard with the stored best',
    read('leaderboard', 'u1')?.time === 19.43);
  check('score completion analytics are logged',
    calls.logEvent.some(event => event.name === 'complete_run' && event.params.time === 22));
  check('slower finish does not log a new-high-score event',
    !calls.logEvent.some(event => event.name === 'new_high_score'));

  console.log('\n--- Authoritative best reconciliation ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  seed('users', 'u2', { bestTime: 20, updatedAt: { old: true } });
  ScoresModule.updateUserBestTime('u2', 25.43);
  await flushAll();
  check('slower run does not overwrite a faster Firestore user best',
    read('users', 'u2')?.bestTime === 20);
  check('missing leaderboard entry is backfilled with the authoritative best',
    read('leaderboard', 'u2')?.time === 20);
  check('raw slower run never reaches the leaderboard',
    calls.setDoc.every(call => call.path !== 'leaderboard/u2' || call.data.time !== 25.43));

  console.log('\n--- Leaderboard compare/write behavior ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  seed('leaderboard', 'u3', {
    user: doc(firestoreInstance, 'users', 'u3'),
    time: 25,
    achievedAt: { old: true }
  });
  ScoresModule.updateLeaderboard('u3', 28);
  await flushAll();
  check('leaderboard update does not downgrade a faster existing entry',
    read('leaderboard', 'u3')?.time === 25);
  ScoresModule.updateLeaderboard('u3', 22);
  await flushAll();
  check('leaderboard update accepts a faster time',
    read('leaderboard', 'u3')?.time === 22);

  console.log('\n--- Leaderboard fetch filtering ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  seed('leaderboard', 'bad-fast', {
    user: doc(firestoreInstance, 'users', 'bad-fast'),
    time: 0.01
  });
  seed('leaderboard', 'sub-floor', {              // forged sub-18s entry: must be filtered (PR C)
    user: doc(firestoreInstance, 'users', 'sub-floor'),
    time: 14
  });
  seed('leaderboard', 'missing-user', {
    time: 24
  });
  seed('leaderboard', 'fast', {
    user: doc(firestoreInstance, 'users', 'fast'),
    time: 24.67
  });
  seed('leaderboard', 'slow', {
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

  console.log('\n--- Offline write ordering ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  const write = setPendingWrite('users/u4');
  ScoresModule.updateUserBestTime('u4', 18);
  await flushAll();
  check('queued user write starts before leaderboard reconciliation',
    calls.setDoc.some(call => call.path === 'users/u4') &&
    !calls.getDoc.includes('leaderboard/u4') &&
    !read('leaderboard', 'u4'));
  write.resolve();
  await flushAll();
  check('leaderboard reconciliation runs after the queued user write settles',
    read('leaderboard', 'u4')?.time === 18);

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
    read('users', 'hs')?.bestTime === 19);

  console.log('\n--- getActiveUser falls back to AuthModule ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  // No setCurrentUser() call: recordScore must resolve the signed-in user via the
  // AuthModule.getAuthState()/getCurrentUser() fallback path.
  currentAuthUser = { uid: 'fallback', displayName: 'Fallback' };
  ScoresModule.recordScore(19);
  await flushAll();
  check('getActiveUser pulls the user from AuthModule when none was set',
    read('users', 'fallback')?.bestTime === 19);

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
    document.getElementById('leaderboard').innerHTML.includes('offline'));
  env.setOnline(true);

  console.log('\n--- displayLeaderboard: renders ranked table and highlights current user ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  currentAuthUser = { uid: 'me', displayName: 'Me' };
  ScoresModule.setCurrentUser(currentAuthUser);
  seed('leaderboard', 'me', { user: doc(firestoreInstance, 'users', 'me'), time: 19.34 });
  seed('leaderboard', 'other', { user: doc(firestoreInstance, 'users', 'other'), time: 20 });
  ScoresModule.displayLeaderboard();
  await flushAll();
  let lbHtml = document.getElementById('leaderboard').innerHTML;
  check('displayLeaderboard renders the Top 10 Times table',
    lbHtml.includes('Top 10 Times') && lbHtml.includes('<table>'));
  check('displayLeaderboard renders rows ascending with formatted times',
    lbHtml.includes('19.34s') && lbHtml.includes('20.00s') &&
    lbHtml.indexOf('19.34s') < lbHtml.indexOf('20.00s'));
  check('displayLeaderboard highlights and names the current user row',
    lbHtml.includes('current-user-score') && lbHtml.includes('Me'));

  console.log('\n--- displayLeaderboard: empty board ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  ScoresModule.displayLeaderboard();
  await flushAll();
  check('empty leaderboard renders the no-scores message',
    document.getElementById('leaderboard').innerHTML.includes('No scores recorded yet'));

  console.log('\n--- displayLeaderboard: unavailable Firestore, failed reinitialization ---');
  resetState(ScoresModule);
  // Local instance stays null (resetState initializes with null) and AuthModule reports
  // unavailable, so the reinitialization attempt fails => unavailable message.
  firestoreAvailable = false;
  reinitializeSucceeds = false;
  ScoresModule.displayLeaderboard();
  await flushAll();
  check('displayLeaderboard attempts reinitialization when Firestore is unavailable',
    calls.reinitializeFirestore > 0);
  check('failed reinitialization renders the unavailable message',
    document.getElementById('leaderboard').innerHTML === '<h3>Leaderboard unavailable</h3>');

  console.log('\n--- displayLeaderboard: reinitializes a null local instance then renders ---');
  resetState(ScoresModule);
  // AuthModule reports available but the local instance is null; a successful
  // reinitialization must restore it and let the fetch+render proceed.
  firestoreAvailable = true;
  reinitializeSucceeds = true;
  seed('leaderboard', 'x', { user: doc(firestoreInstance, 'users', 'x'), time: 30 });
  ScoresModule.displayLeaderboard();
  await flushAll();
  check('successful reinitialization restores the local instance and renders scores',
    calls.reinitializeFirestore > 0 &&
    document.getElementById('leaderboard').innerHTML.includes('30.00s'));

  console.log(`\nSCORES TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
