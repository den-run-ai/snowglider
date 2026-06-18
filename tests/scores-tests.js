// scores-tests.js
// Headless coverage for src/scores.js against the real module code.
//
// scores.js imports Firebase from CDN URLs, which Node cannot resolve directly.
// Match the auth-tests.js harness: strip import/export syntax, evaluate the
// shipped source under jsdom, and inject a small in-memory Firestore mock.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="leaderboard"></div>
</body></html>`, { url: 'https://snowglider.ai/' });
const { window } = dom;
global.window = window;
global.document = window.document;

let localStore = {};
global.localStorage = {
  getItem: key => (Object.prototype.hasOwnProperty.call(localStore, key) ? localStore[key] : null),
  setItem: (key, value) => { localStore[key] = String(value); },
  removeItem: key => { delete localStore[key]; },
  clear: () => { localStore = {}; }
};
window.localStorage = global.localStorage;

let online = true;
Object.defineProperty(window.navigator, 'onLine', {
  configurable: true,
  get: () => online
});

const firestoreInstance = { __firestore: true };
const analyticsInstance = { __analytics: true };
const db = {
  users: new Map(),
  leaderboard: new Map()
};
const calls = {
  getDoc: [],
  setDoc: [],
  getDocs: [],
  logEvent: [],
  reinitializeFirestore: 0
};

let firestoreAvailable = true;
let currentAuthUser = null;
let reinitializeSucceeds = false;
let pendingWritePath = null;
let pendingWrite = null;
let timestampCounter = 0;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getCollectionStore(name) {
  if (!db[name]) {
    throw new Error(`Unknown collection: ${name}`);
  }
  return db[name];
}

function makeDocSnap(ref) {
  const store = getCollectionStore(ref.collectionName);
  const value = store.get(ref.id);
  return {
    id: ref.id,
    exists: () => value !== undefined,
    data: () => clone(value)
  };
}

function writeDoc(ref, data, options) {
  const store = getCollectionStore(ref.collectionName);
  const existing = store.get(ref.id) || {};
  const next = options && options.merge ? { ...existing, ...clone(data) } : clone(data);
  store.set(ref.id, next);
}

function makeDeferredWrite() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seed(collectionName, id, value) {
  getCollectionStore(collectionName).set(id, clone(value));
}

function read(collectionName, id) {
  return getCollectionStore(collectionName).get(id);
}

function resetState(ScoresModule) {
  localStore = {};
  db.users.clear();
  db.leaderboard.clear();
  calls.getDoc = [];
  calls.setDoc = [];
  calls.getDocs = [];
  calls.logEvent = [];
  calls.reinitializeFirestore = 0;
  firestoreAvailable = true;
  currentAuthUser = null;
  reinitializeSucceeds = false;
  pendingWritePath = null;
  pendingWrite = null;
  online = true;
  timestampCounter = 0;
  document.getElementById('leaderboard').innerHTML = '';
  ScoresModule.setCurrentUser(null);
  ScoresModule.initializeScores(null, null);
}

function getFirestore() {
  return firestoreInstance;
}

function getAnalytics() {
  return analyticsInstance;
}

function logEvent(_analytics, name, params) {
  calls.logEvent.push({ name, params });
}

function doc(firestore, collectionName, id) {
  return {
    firestore,
    collectionName,
    id,
    path: `${collectionName}/${id}`
  };
}

function collection(firestore, collectionName) {
  return {
    firestore,
    collectionName,
    path: collectionName
  };
}

function where(field, op, value) {
  return { kind: 'where', field, op, value };
}

function orderBy(field, direction) {
  return { kind: 'orderBy', field, direction };
}

function query(collectionRef, ...constraints) {
  return { collectionRef, constraints };
}

function limit(count) {
  return { kind: 'limit', count };
}

function serverTimestamp() {
  timestampCounter++;
  return { __serverTimestamp: timestampCounter };
}

function getDoc(ref) {
  calls.getDoc.push(ref.path);
  return Promise.resolve(makeDocSnap(ref));
}

function setDoc(ref, data, options) {
  calls.setDoc.push({ path: ref.path, data: clone(data), options: clone(options) });
  const commit = () => writeDoc(ref, data, options);

  if (pendingWritePath === ref.path && pendingWrite) {
    const write = pendingWrite;
    pendingWritePath = null;
    pendingWrite = null;
    return write.promise.then(() => commit());
  }

  commit();
  return Promise.resolve();
}

function getDocs(q) {
  calls.getDocs.push(q);
  let rows = Array.from(getCollectionStore(q.collectionRef.collectionName).entries())
    .map(([id, data]) => ({ id, data: clone(data) }));

  q.constraints.forEach(constraint => {
    if (constraint.kind === 'where') {
      rows = rows.filter(row => {
        const value = row.data[constraint.field];
        if (constraint.op === '>=') {
          return value >= constraint.value;
        }
        throw new Error(`Unsupported where op: ${constraint.op}`);
      });
    }

    if (constraint.kind === 'orderBy') {
      const direction = constraint.direction === 'desc' ? -1 : 1;
      rows = rows.slice().sort((a, b) => {
        const av = a.data[constraint.field];
        const bv = b.data[constraint.field];
        return av === bv ? 0 : (av < bv ? -1 : 1) * direction;
      });
    }

    if (constraint.kind === 'limit') {
      rows = rows.slice(0, constraint.count);
    }
  });

  return Promise.resolve({
    forEach: callback => {
      rows.forEach(row => {
        callback({
          id: row.id,
          data: () => clone(row.data)
        });
      });
    }
  });
}

const mocks = {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  where,
  orderBy,
  query,
  limit,
  getDocs,
  serverTimestamp,
  getAnalytics,
  logEvent
};

function loadScoresModule() {
  // src/scores.ts is TypeScript (issue #84, Phase 3.8). Strip the types to runnable
  // JS first (transpile via the TypeScript devDependency) so the `new Function(...)`
  // eval below sees plain JavaScript. ESNext output keeps import/export statements
  // as-is, so the existing import/export removal still works.
  const ts = require('typescript');
  const tsSource = fs.readFileSync(path.join(REPO, 'src', 'scores.ts'), 'utf8');
  let code = ts.transpileModule(tsSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  code = code.replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, '');
  code = code.replace(/export\s+default\s+[^;]+;/g, '');
  const argNames = Object.keys(mocks);
  const fn = new Function(
    'window', 'document', 'localStorage', 'console', ...argNames,
    code + '\nreturn window.ScoresModule;'
  );
  return fn(window, window.document, global.localStorage, console, ...argNames.map(name => mocks[name]));
}

window.AuthModule = {
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
  const ScoresModule = loadScoresModule();

  console.log('--- ScoresModule load & validation ---');
  check('module exposes the expected public surface',
    !!ScoresModule && ['initializeScores', 'setCurrentUser', 'recordScore',
      'getLeaderboard', 'updateUserBestTime', 'updateLeaderboard',
      'isFirestoreAvailable', 'isValidScoreTime'].every(key => typeof ScoresModule[key] === 'function'));
  check('score validation rejects impossible and non-finite times',
    ScoresModule.isValidScoreTime(0.01) === false &&
    ScoresModule.isValidScoreTime(Infinity) === false &&
    ScoresModule.isValidScoreTime('14') === false);
  check('score validation accepts plausible numeric times',
    ScoresModule.isValidScoreTime(4) === true &&
    ScoresModule.isValidScoreTime(14.67) === true);

  console.log('\n--- Local score recording ---');
  resetState(ScoresModule);
  ScoresModule.recordScore(0.01);
  check('invalid runs are not stored locally',
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
  seed('users', 'u2', { bestTime: 14, updatedAt: { old: true } });
  ScoresModule.updateUserBestTime('u2', 19.43);
  await flushAll();
  check('slower run does not overwrite a faster Firestore user best',
    read('users', 'u2')?.bestTime === 14);
  check('missing leaderboard entry is backfilled with the authoritative best',
    read('leaderboard', 'u2')?.time === 14);
  check('raw slower run never reaches the leaderboard',
    calls.setDoc.every(call => call.path !== 'leaderboard/u2' || call.data.time !== 19.43));

  console.log('\n--- Leaderboard compare/write behavior ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  seed('leaderboard', 'u3', {
    user: doc(firestoreInstance, 'users', 'u3'),
    time: 17,
    achievedAt: { old: true }
  });
  ScoresModule.updateLeaderboard('u3', 19);
  await flushAll();
  check('leaderboard update does not downgrade a faster existing entry',
    read('leaderboard', 'u3')?.time === 17);
  ScoresModule.updateLeaderboard('u3', 16);
  await flushAll();
  check('leaderboard update accepts a faster time',
    read('leaderboard', 'u3')?.time === 16);

  console.log('\n--- Leaderboard fetch filtering ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  seed('leaderboard', 'bad-fast', {
    user: doc(firestoreInstance, 'users', 'bad-fast'),
    time: 0.01
  });
  seed('leaderboard', 'missing-user', {
    time: 8
  });
  seed('leaderboard', 'fast', {
    user: doc(firestoreInstance, 'users', 'fast'),
    time: 14.67
  });
  seed('leaderboard', 'slow', {
    user: doc(firestoreInstance, 'users', 'slow'),
    time: 58.64
  });
  const leaderboard = await ScoresModule.getLeaderboard();
  check('getLeaderboard returns only valid entries with user refs',
    leaderboard.length === 2 &&
    leaderboard[0].userId === 'fast' &&
    leaderboard[1].userId === 'slow');
  check('getLeaderboard orders valid entries by ascending time',
    leaderboard[0].time === 14.67 && leaderboard[1].time === 58.64);

  console.log('\n--- Offline write ordering ---');
  resetState(ScoresModule);
  ScoresModule.initializeScores(firestoreInstance, analyticsInstance);
  pendingWritePath = 'users/u4';
  pendingWrite = makeDeferredWrite();
  const write = pendingWrite;
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

  console.log(`\nSCORES TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
