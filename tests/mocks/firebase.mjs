// firebase.mjs — in-memory Firebase (Firestore + Analytics) mock for Node coverage.
//
// The headless score/auth harnesses used to load the module-under-test through a
// `new Function(...)` eval so they could strip the gstatic CDN imports and inject
// mocks. That eval is invisible to c8 (V8 cannot attribute an anonymous eval to
// `src/*.ts`), so none of those assertions counted toward coverage — the Codecov
// numbers came entirely from the browser run.
//
// Instead, this single ES module IS the mock: the resolve hook in
// tests/loaders/firebase-cdn-mock.hooks.mjs redirects the three
// `https://www.gstatic.com/firebasejs/.../firebase-{firestore,analytics,auth}.js`
// specifiers here, so the real `src/scores.ts` / `src/auth.ts` import these
// functions in place of the CDN SDK. The test harness imports the SAME module
// (same resolved file URL ⇒ same instance) to seed data, drive deferred writes,
// and assert recorded calls. Because the module is imported (not eval'd), Node
// type-strips the `.ts` under test and c8 instruments it with correct source-mapped
// line numbers.
//
// The Firestore behavior below is a faithful extraction of the in-memory mock that
// previously lived inline in tests/scores-tests.js (compare-and-write semantics,
// where('>=')/orderBy/limit query support, and the deferred-write hook used to
// model an offline setDoc that flushes on reconnect).

// ---- shared, test-controllable state ----
export const db = {
  users: new Map(),
  leaderboard: new Map()
};

export const calls = {
  getDoc: [],
  setDoc: [],
  getDocs: [],
  logEvent: []
};

// Sentinels handed back to callers that ask the SDK for the service instances.
export const firestoreInstance = { __firestore: true };
export const analyticsInstance = { __analytics: true };

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

// ---- test control surface ----

/** Clear all in-memory documents, recorded calls, and any armed deferred write. */
export function reset() {
  db.users.clear();
  db.leaderboard.clear();
  calls.getDoc = [];
  calls.setDoc = [];
  calls.getDocs = [];
  calls.logEvent = [];
  pendingWritePath = null;
  pendingWrite = null;
  timestampCounter = 0;
}

export function seed(collectionName, id, value) {
  getCollectionStore(collectionName).set(id, clone(value));
}

export function read(collectionName, id) {
  return getCollectionStore(collectionName).get(id);
}

/**
 * Arm a one-shot deferred write for the given document path. The next setDoc to
 * that path will not commit until the returned controller's promise is resolved —
 * modelling a setDoc that stays queued offline and flushes on reconnect.
 * @param {string} path - e.g. 'users/u4'
 */
export function setPendingWrite(path) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pendingWritePath = path;
  pendingWrite = { promise, resolve, reject };
  return pendingWrite;
}

// ---- firebase-firestore.js surface ----
export function getFirestore() {
  return firestoreInstance;
}

export function doc(firestore, collectionName, id) {
  return {
    firestore,
    collectionName,
    id,
    path: `${collectionName}/${id}`
  };
}

export function collection(firestore, collectionName) {
  return {
    firestore,
    collectionName,
    path: collectionName
  };
}

export function where(field, op, value) {
  return { kind: 'where', field, op, value };
}

export function orderBy(field, direction) {
  return { kind: 'orderBy', field, direction };
}

export function query(collectionRef, ...constraints) {
  return { collectionRef, constraints };
}

export function limit(count) {
  return { kind: 'limit', count };
}

export function serverTimestamp() {
  timestampCounter++;
  return { __serverTimestamp: timestampCounter };
}

export function getDoc(ref) {
  calls.getDoc.push(ref.path);
  return Promise.resolve(makeDocSnap(ref));
}

export function setDoc(ref, data, options) {
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

export function getDocs(q) {
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

// ---- firebase-analytics.js surface ----
export function getAnalytics() {
  return analyticsInstance;
}

export function logEvent(_analytics, name, params) {
  calls.logEvent.push({ name, params });
}
