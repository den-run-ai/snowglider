// @ts-check
// offline-store-tests.js — headless coverage for src/offline/offline-store.ts
// (issue #358, PR 1). Verifies throw-safe storage primitives, score validation,
// local-best read/save-if-better, the pending-sync marker, and that the reused
// difficulty.ts key builders produce the exact strings course.ts uses (so the
// offline layer and the game can never drift on key names). Auto-discovered by
// tests/run-node-suite.js.
'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++;
  else fail++;
}

/** A Storage-like that throws on every access (private mode / disabled storage). */
function throwingStorage() {
  return {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
    removeItem() { throw new Error('storage disabled'); },
  };
}

async function main() {
  const { createLocalStorageMock } = await import('./mocks/local-storage.mjs');
  const store = await import('../src/offline/offline-store.ts');
  const limits = await import('../src/score-limits.ts');

  const MIN = limits.MIN_VALID_SCORE_TIME;
  const MAX = limits.MAX_VALID_SCORE_TIME;

  // --- Key contract: reused builders must match course.ts's `${base}_${tier}` scheme ---
  check('localBestTimeKey(blue) is the legacy un-suffixed key', store.localBestTimeKey('blue') === 'snowgliderBestTime');
  check('localBestTimeKey(black) is suffixed', store.localBestTimeKey('black') === 'snowgliderBestTime_black');
  check('localBestSplitsKey(blue) is suffixed for blue too', store.localBestSplitsKey('blue') === 'snowgliderBestSplits_blue');
  check('localGhostKey(bunny) matches the course.ts scheme', store.localGhostKey('bunny') === 'snowgliderGhost_bunny');

  // --- isPlausibleTierTime uses the TIER'S OWN floor (not the global 18 s) ---
  check('valid mid-range time accepted (blue)', store.isPlausibleTierTime('blue', 30) === true);
  check('time at the blue floor accepted', store.isPlausibleTierTime('blue', MIN) === true);
  check('sub-floor blue time rejected', store.isPlausibleTierTime('blue', MIN - 1) === false);
  check('above-ceiling time rejected', store.isPlausibleTierTime('blue', MAX + 1) === false);
  check('NaN rejected', store.isPlausibleTierTime('blue', NaN) === false);
  check('Infinity rejected', store.isPlausibleTierTime('blue', Infinity) === false);
  check('string rejected', store.isPlausibleTierTime('blue', '30') === false);
  // Black/Expert legitimately finish below Blue's 18 s floor (their floor is 13 s).
  check('Black time below the Blue floor is valid (15 s)', store.isPlausibleTierTime('black', 15) === true);
  check('Expert time below the Blue floor is valid (15 s)', store.isPlausibleTierTime('expert', 15) === true);
  check('Black time below the BLACK floor rejected (12 s)', store.isPlausibleTierTime('black', 12) === false);

  // --- Throw-safe primitives never throw when storage is unavailable ---
  const bad = throwingStorage();
  check('safeGetItem returns null on throwing storage', store.safeGetItem('k', bad) === null);
  check('safeSetItem returns false on throwing storage', store.safeSetItem('k', 'v', bad) === false);
  let removeThrew = false;
  try { store.safeRemoveItem('k', bad); } catch { removeThrew = true; }
  check('safeRemoveItem swallows throws', removeThrew === false);
  check('safeGetItem returns null on null storage', store.safeGetItem('k', null) === null);
  check('safeSetItem returns false on null storage', store.safeSetItem('k', 'v', null) === false);

  // --- readLocalBest: valid / absent / corrupt ---
  const ls = createLocalStorageMock();
  check('readLocalBest null when absent', store.readLocalBest('blue', ls) === null);
  ls.setItem('snowgliderBestTime', '42.5');
  check('readLocalBest returns a valid stored best', store.readLocalBest('blue', ls) === 42.5);
  ls.setItem('snowgliderBestTime', 'not-a-number');
  check('readLocalBest null on corrupt value', store.readLocalBest('blue', ls) === null);
  check('readLocalBest purged the corrupt value', ls.getItem('snowgliderBestTime') === null);
  ls.setItem('snowgliderBestTime', String(MIN - 5)); // implausible / sub-floor for BLUE
  check('readLocalBest null on implausible value', store.readLocalBest('blue', ls) === null);
  check('readLocalBest purged the implausible value', ls.getItem('snowgliderBestTime') === null);
  // The SAME 13 s value is a VALID Black best (Black's floor is 13 s) — must be preserved,
  // not purged (Codex #359: tier-aware local-best validation).
  ls.setItem('snowgliderBestTime_black', '15');
  check('readLocalBest preserves a valid fast Black best (15 s)', store.readLocalBest('black', ls) === 15);
  check('valid Black best not purged', ls.getItem('snowgliderBestTime_black') === '15');
  check('saveLocalBestIfBetter accepts a sub-18 s Black best', store.saveLocalBestIfBetter('black', 14, ls) === true);
  check('Black best updated to 14', store.readLocalBest('black', ls) === 14);

  // --- saveLocalBestIfBetter: first write, improvement, no-regression, invalid ---
  ls.reset();
  check('save first valid best writes', store.saveLocalBestIfBetter('blue', 40, ls) === true);
  check('stored best is 40', store.readLocalBest('blue', ls) === 40);
  check('faster time improves the best', store.saveLocalBestIfBetter('blue', 35, ls) === true);
  check('stored best is now 35', store.readLocalBest('blue', ls) === 35);
  check('slower time does NOT regress the best', store.saveLocalBestIfBetter('blue', 50, ls) === false);
  check('stored best still 35', store.readLocalBest('blue', ls) === 35);
  check('equal time does not rewrite', store.saveLocalBestIfBetter('blue', 35, ls) === false);
  check('invalid time never writes', store.saveLocalBestIfBetter('blue', NaN, ls) === false);
  check('save is a no-op on throwing storage', store.saveLocalBestIfBetter('blue', 20, bad) === false);

  // --- Pending-sync marker ---
  ls.reset();
  check('readPendingSync empty when absent', Object.keys(store.readPendingSync(ls)).length === 0);
  check('markPendingSync writes a valid entry', store.markPendingSync('black', 25, 'u1', { recordedAt: 111, storage: ls }) === true);
  const p1 = store.getPendingSync('black', ls);
  check('pending entry has tier/time/uid/recordedAt', !!p1 && p1.tier === 'black' && p1.time === 25 && p1.uid === 'u1' && p1.recordedAt === 111);
  check('markPendingSync keeps the BEST (lower) time for the same owner', store.markPendingSync('black', 30, 'u1', { recordedAt: 222, storage: ls }) === false);
  check('pending time unchanged after slower mark', store.getPendingSync('black', ls).time === 25);
  check('faster pending time replaces', store.markPendingSync('black', 20, 'u1', { recordedAt: 333, storage: ls }) === true);
  check('pending time is now 20', store.getPendingSync('black', ls).time === 20);
  check('invalid pending time rejected', store.markPendingSync('black', NaN, 'u1', { storage: ls }) === false);
  // A marker MUST carry an owning uid (Codex #362): an empty uid is refused.
  check('markPendingSync without a uid is refused', store.markPendingSync('black', 19, '', { storage: ls }) === false);

  // A DIFFERENT owner's mark for the same tier overwrites (never blocked by the other user's
  // faster time), so each user's queued best is recorded rather than lost to a shared key.
  ls.reset();
  store.markPendingSync('black', 30, 'userA', { recordedAt: 1, storage: ls });
  check('a different owner overwrites even with a slower time', store.markPendingSync('black', 40, 'userB', { recordedAt: 2, storage: ls }) === true);
  const pOwner = store.getPendingSync('black', ls);
  check('the current owner + time are recorded', !!pOwner && pOwner.uid === 'userB' && pOwner.time === 40);
  ls.reset();
  // Restore the black=20 / u1 state the later two-tiers + clear assertions expect.
  store.markPendingSync('black', 20, 'u1', { recordedAt: 333, storage: ls });

  // markPendingSync without an explicit recordedAt stamps Date.now() (a finite number).
  store.markPendingSync('expert', 22, 'u1', { storage: ls });
  const pExpert = store.getPendingSync('expert', ls);
  check('markPendingSync defaults recordedAt to a finite timestamp', !!pExpert && typeof pExpert.recordedAt === 'number' && Number.isFinite(pExpert.recordedAt));
  // A non-finite explicit recordedAt normalizes to null.
  store.clearPendingSync('expert', ls);
  store.markPendingSync('expert', 22, 'u1', { recordedAt: NaN, storage: ls });
  check('non-finite recordedAt normalizes to null', store.getPendingSync('expert', ls).recordedAt === null);
  store.clearPendingSync('expert', ls);

  // clearPendingSync on an absent tier is a no-op (does not throw / create the key).
  let clearThrew = false;
  try { store.clearPendingSync('expert', ls); } catch { clearThrew = true; }
  check('clearPendingSync on absent tier is a safe no-op', clearThrew === false);

  // Second tier is independent.
  store.markPendingSync('bunny', 30, 'u1', { recordedAt: 444, storage: ls });
  check('two tiers tracked independently', store.getPendingSync('bunny', ls).time === 30 && store.getPendingSync('black', ls).time === 20);

  // Clear one tier; the other survives; key removed only when empty.
  store.clearPendingSync('black', ls);
  check('cleared tier is gone', store.getPendingSync('black', ls) === null);
  check('other tier survives clear', store.getPendingSync('bunny', ls).time === 30);
  store.clearPendingSync('bunny', ls);
  check('pending key removed when map empties', ls.getItem(store.PENDING_SYNC_KEY) === null);

  // Corrupt / tampered pending payloads are ignored, not thrown.
  ls.setItem(store.PENDING_SYNC_KEY, '{not json');
  check('readPendingSync empty on junk JSON', Object.keys(store.readPendingSync(ls)).length === 0);
  ls.setItem(store.PENDING_SYNC_KEY, '[1,2,3]');
  check('readPendingSync empty on array payload', Object.keys(store.readPendingSync(ls)).length === 0);
  // A tier whose stored `tier` field disagrees with its key (tamper) is dropped.
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ black: { tier: 'blue', time: 20, recordedAt: 1 } }));
  check('mismatched tier key dropped', store.getPendingSync('black', ls) === null);
  // A forged sub-floor time is dropped on read.
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ black: { tier: 'black', time: 1, recordedAt: 1 } }));
  check('forged sub-floor pending time dropped', store.getPendingSync('black', ls) === null);
  // An unknown/tampered tier key is rejected even if its `tier` field matches the key
  // (Codex #359 hardening) — only real difficulty ids survive readPendingSync.
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ evil: { tier: 'evil', time: 25, recordedAt: 1 } }));
  check('unknown tier key rejected (not a real difficulty)', Object.keys(store.readPendingSync(ls)).length === 0);
  // A valid entry with a non-number recordedAt reads back with recordedAt null.
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ blue: { tier: 'blue', time: 30, uid: 'u1', recordedAt: 'oops' } }));
  check('non-number stored recordedAt reads as null', store.getPendingSync('blue', ls).recordedAt === null);
  // An ownerless entry (no uid) is dropped on read — the flush could otherwise sync it to
  // whoever is signed in at retry (Codex #362). Also drops any pre-uid marker after upgrade.
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ blue: { tier: 'blue', time: 30, recordedAt: 1 } }));
  check('ownerless pending entry (no uid) dropped', store.getPendingSync('blue', ls) === null);

  console.log(`\nOFFLINE-STORE TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
