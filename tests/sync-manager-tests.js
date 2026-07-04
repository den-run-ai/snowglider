// @ts-check
// sync-manager-tests.js — headless coverage for src/offline/sync-manager.ts (issue
// #358, PR 4): the local-first score-sync decisions (queue eligibility, reconnect
// flush) and the honest result-screen copy. Preserves the leaderboard trust rules —
// anonymous guests never queue, only ranked tiers queue, flush only when online +
// Firestore ready + a real user is signed in. Auto-discovered by run-node-suite.js.
'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++;
  else fail++;
}

const REAL_USER = { uid: 'u1', isAnonymous: false };
const GUEST = { uid: 'g1', isAnonymous: true };

async function main() {
  const { createLocalStorageMock } = await import('./mocks/local-storage.mjs');
  const sm = await import('../src/offline/sync-manager.ts');
  const store = await import('../src/offline/offline-store.ts');

  // --- isSyncEligibleUser ---
  check('null user not eligible', sm.isSyncEligibleUser(null) === false);
  check('anonymous guest not eligible', sm.isSyncEligibleUser(GUEST) === false);
  check('real signed-in user eligible', sm.isSyncEligibleUser(REAL_USER) === true);
  check('user with empty uid not eligible', sm.isSyncEligibleUser({ uid: '', isAnonymous: false }) === false);

  // --- shouldQueuePending (blue = ranked, black = unranked) ---
  check('queue: eligible + ranked + cannot sync now', sm.shouldQueuePending(REAL_USER, 'blue', false) === true);
  check('no queue: eligible + ranked but CAN sync now', sm.shouldQueuePending(REAL_USER, 'blue', true) === false);
  check('no queue: unranked tier', sm.shouldQueuePending(REAL_USER, 'black', false) === false);
  check('no queue: anonymous guest', sm.shouldQueuePending(GUEST, 'blue', false) === false);
  check('no queue: signed out', sm.shouldQueuePending(null, 'blue', false) === false);

  // --- queueOfflineBest: writes a marker only when eligible + couldn't sync ---
  /** @param {{ user?: any, firestore?: boolean, online?: boolean, storage?: any, sync?: any }} [o] */
  function deps({ user = REAL_USER, firestore = false, online = false, storage, sync } = {}) {
    return {
      getActiveUser: () => user,
      isFirestoreReady: () => firestore,
      isOnline: () => online,
      sync: sync || (() => {}),
      storage,
    };
  }

  let ls = createLocalStorageMock();
  check('queues an eligible offline ranked best', sm.queueOfflineBest('blue', 30, deps({ online: false, firestore: false, storage: ls })) === true);
  check('marker written for blue', store.getPendingSync('u1', 'blue', ls) !== null && store.getPendingSync('u1', 'blue', ls).time === 30);

  ls = createLocalStorageMock();
  check('does NOT queue when it can sync now (online + firestore)', sm.queueOfflineBest('blue', 30, deps({ online: true, firestore: true, storage: ls })) === false);
  check('no marker when syncable now', store.getPendingSync('u1', 'blue', ls) === null);

  ls = createLocalStorageMock();
  check('does NOT queue an anonymous guest', sm.queueOfflineBest('blue', 30, deps({ user: GUEST, online: false, storage: ls })) === false);
  ls = createLocalStorageMock();
  check('does NOT queue an unranked tier', sm.queueOfflineBest('black', 30, deps({ online: false, storage: ls })) === false);

  // --- queueFailedSync: an ONLINE attempt that didn't confirm still queues (Codex #362) ---
  // Takes the ORIGINAL uid EXPLICITLY (captured before the async write), not getActiveUser —
  // so an account switch while the write is in flight can't misattribute or drop the retry.
  // It ignores connectivity (the sync already ran online + failed); a ranked tier + a real
  // uid is enough. Guest/unranked gating lives in the caller (syncBestTimeWithRetry).
  ls = createLocalStorageMock();
  check('queues a failed ONLINE ranked sync under the captured uid',
    sm.queueFailedSync('u1', 'blue', 30, deps({ storage: ls })) === true);
  check('marker written for the failed online blue sync (owned by the captured uid)',
    store.getPendingSync('u1', 'blue', ls)?.time === 30);
  ls = createLocalStorageMock();
  check('queueFailedSync refuses an empty uid',
    sm.queueFailedSync('', 'blue', 30, deps({ storage: ls })) === false);
  ls = createLocalStorageMock();
  check('queueFailedSync does NOT queue an unranked tier',
    sm.queueFailedSync('u1', 'black', 30, deps({ storage: ls })) === false);

  // --- hasPendingSync (drives the reconnect reinit decision; scoped by uid) ---
  ls = createLocalStorageMock();
  check('hasPendingSync false when empty', sm.hasPendingSync('u1', ls) === false);
  store.markPendingSync('blue', 25, 'u1', { recordedAt: 1, storage: ls });
  check('hasPendingSync true for the owning uid', sm.hasPendingSync('u1', ls) === true);
  check('hasPendingSync false for a DIFFERENT uid (scoped, Codex #362)', sm.hasPendingSync('someone-else', ls) === false);
  check('hasPendingSync with no uid counts any entry', sm.hasPendingSync(null, ls) === true);

  // --- flushPendingSync (async; clears only on a CONFIRMED sync) ---
  ls = createLocalStorageMock();
  store.markPendingSync('blue', 25, 'u1', { recordedAt: 1, storage: ls });
  const synced = [];
  const flushDeps = deps({ user: REAL_USER, firestore: true, online: true, storage: ls, sync: (uid, time, tier) => { synced.push({ uid, time, tier }); return Promise.resolve(true); } });
  const flushed = await sm.flushPendingSync(flushDeps);
  check('flush synced the queued blue best', synced.length === 1 && synced[0].uid === 'u1' && synced[0].time === 25 && synced[0].tier === 'blue');
  check('flush returned the cleared tiers', flushed.length === 1 && flushed[0] === 'blue');
  check('flush cleared the marker after a confirmed sync', store.getPendingSync('u1', 'blue', ls) === null);

  // A sync that resolves false (write did not settle) LEAVES the marker.
  ls = createLocalStorageMock();
  store.markPendingSync('blue', 25, 'u1', { recordedAt: 1, storage: ls });
  const failCleared = await sm.flushPendingSync(deps({ firestore: true, online: true, storage: ls, sync: () => Promise.resolve(false) }));
  check('unconfirmed sync (false) does NOT clear the marker', failCleared.length === 0 && store.getPendingSync('u1', 'blue', ls) !== null);

  // A sync that REJECTS leaves the marker too (the durable retry record survives).
  ls = createLocalStorageMock();
  store.markPendingSync('blue', 25, 'u1', { recordedAt: 1, storage: ls });
  await sm.flushPendingSync(deps({ firestore: true, online: true, storage: ls, sync: () => Promise.reject(new Error('transient')) }));
  check('a rejected sync leaves the durable marker (Codex #362)', store.getPendingSync('u1', 'blue', ls) !== null);

  // No-op when offline.
  ls = createLocalStorageMock();
  store.markPendingSync('blue', 25, 'u1', { recordedAt: 1, storage: ls });
  const off = [];
  await sm.flushPendingSync(deps({ firestore: true, online: false, storage: ls, sync: (u, t, ti) => { off.push(ti); return true; } }));
  check('flush no-ops offline (marker retained)', off.length === 0 && store.getPendingSync('u1', 'blue', ls) !== null);

  // No-op when Firestore not ready.
  ls = createLocalStorageMock();
  store.markPendingSync('blue', 25, 'u1', { recordedAt: 1, storage: ls });
  const noFs = [];
  await sm.flushPendingSync(deps({ firestore: false, online: true, storage: ls, sync: (u, t, ti) => { noFs.push(ti); return true; } }));
  check('flush no-ops when Firestore unavailable (marker retained)', noFs.length === 0 && store.getPendingSync('u1', 'blue', ls) !== null);

  // No-op for anonymous / signed-out.
  ls = createLocalStorageMock();
  store.markPendingSync('blue', 25, 'u1', { recordedAt: 1, storage: ls });
  const anon = [];
  await sm.flushPendingSync(deps({ user: GUEST, firestore: true, online: true, storage: ls, sync: (u, t, ti) => { anon.push(ti); return true; } }));
  check('flush no-ops for an anonymous user (marker retained)', anon.length === 0 && store.getPendingSync('u1', 'blue', ls) !== null);

  // A tier that became unranked is cleared without syncing.
  ls = createLocalStorageMock();
  // Force a pending entry on an unranked tier directly (bypass the queue eligibility).
  store.markPendingSync('black', 20, 'u1', { recordedAt: 1, storage: ls });
  const unrankedSync = [];
  await sm.flushPendingSync(deps({ firestore: true, online: true, storage: ls, sync: (u, t, ti) => { unrankedSync.push(ti); return true; } }));
  check('flush drops an unranked pending tier without syncing', unrankedSync.length === 0 && store.getPendingSync('u1', 'black', ls) === null);

  // A marker owned by a DIFFERENT user is NOT synced (shared browser: user A queued, user B
  // is now signed in). Both entries coexist under their own composite keys; the flush syncs
  // only the current user's and leaves the foreign one for its own owner's retry (Codex #362).
  ls = createLocalStorageMock();
  store.markPendingSync('blue', 25, 'userA', { recordedAt: 1, storage: ls }); // user A's entry
  store.markPendingSync('blue', 22, 'u1', { recordedAt: 2, storage: ls });    // current user's entry
  const mixed = [];
  const mixedFlushed = await sm.flushPendingSync(deps({ user: REAL_USER, firestore: true, online: true, storage: ls, sync: (u, t, ti) => { mixed.push({ u, ti }); return true; } }));
  check('flush syncs ONLY the current user’s entry (Codex #362)', mixed.length === 1 && mixed[0].u === 'u1' && mixedFlushed.length === 1 && mixedFlushed[0] === 'blue');
  check('the current user’s marker is cleared', store.getPendingSync('u1', 'blue', ls) === null);
  check('the other user’s marker is left intact for their own retry', store.getPendingSync('userA', 'blue', ls)?.uid === 'userA' && store.getPendingSync('userA', 'blue', ls)?.time === 25);

  // A BETTER run rewrites the same (uid, tier) marker WHILE the sync awaits: the flush must
  // not clear the newer entry, since only the older time was confirmed (Codex #362).
  ls = createLocalStorageMock();
  store.markPendingSync('blue', 30, 'u1', { recordedAt: 1, storage: ls }); // the entry being flushed
  const raceFlushed = await sm.flushPendingSync(deps({ user: REAL_USER, firestore: true, online: true, storage: ls,
    sync: async () => {
      // mid-await: the player finishes a faster Blue run, rewriting the marker (keep-best).
      store.markPendingSync('blue', 25, 'u1', { recordedAt: 2, storage: ls });
      return true;
    } }));
  check('flush does NOT clear a marker rewritten to a better time mid-sync (Codex #362)',
    raceFlushed.length === 0 && store.getPendingSync('u1', 'blue', ls)?.time === 25);

  // --- resultSyncStatusCopy precedence ---
  const S = (o) => Object.assign({ online: true, firestoreAvailable: true, ranked: true, signedIn: true, anonymous: false }, o);
  check('normal online signed-in sync → no caveat', sm.resultSyncStatusCopy(S({})) === null);
  check('unranked → practice copy', sm.resultSyncStatusCopy(S({ ranked: false })) === sm.RESULT_UNRANKED_COPY);
  check('offline → offline copy', sm.resultSyncStatusCopy(S({ online: false })) === sm.RESULT_OFFLINE_COPY);
  check('anonymous → guest copy', sm.resultSyncStatusCopy(S({ anonymous: true })) === sm.RESULT_GUEST_COPY);
  check('signed-out online → defer to login prompt (null)', sm.resultSyncStatusCopy(S({ signedIn: false })) === null);
  check('online signed-in but Firestore down → leaderboard-unavailable copy', sm.resultSyncStatusCopy(S({ firestoreAvailable: false })) === sm.RESULT_LEADERBOARD_UNAVAILABLE_COPY);
  // The outage copy must NOT claim a cached/last-online board is shown (Codex #362): the
  // result overlay renders "Leaderboard unavailable" in that path, not a stale board.
  check('leaderboard-unavailable copy does not promise a shown board', !/last online|out of date/i.test(sm.RESULT_LEADERBOARD_UNAVAILABLE_COPY));
  check('offline takes precedence over anonymous', sm.resultSyncStatusCopy(S({ online: false, anonymous: true })) === sm.RESULT_OFFLINE_COPY);
  check('unranked takes precedence over offline', sm.resultSyncStatusCopy(S({ ranked: false, online: false })) === sm.RESULT_UNRANKED_COPY);

  console.log(`\nSYNC-MANAGER TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
