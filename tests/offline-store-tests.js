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
  const PV = (await import('../src/run-context.ts')).PHYSICS_VERSION;
  check('localBestTimeKey(blue) is the versioned base key (#403 review)',
    store.localBestTimeKey('blue') === `snowgliderBestTime_v${PV}`);
  check('localBestTimeKey(black) is suffixed within the version namespace',
    store.localBestTimeKey('black') === `snowgliderBestTime_v${PV}_black`);
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
  ls.setItem(store.localBestTimeKey('blue'), '42.5');
  check('readLocalBest returns a valid stored best', store.readLocalBest('blue', ls) === 42.5);
  ls.setItem(store.localBestTimeKey('blue'), 'not-a-number');
  check('readLocalBest null on corrupt value', store.readLocalBest('blue', ls) === null);
  check('readLocalBest purged the corrupt value', ls.getItem(store.localBestTimeKey('blue')) === null);
  ls.setItem(store.localBestTimeKey('blue'), String(MIN - 5)); // implausible / sub-floor for BLUE
  check('readLocalBest null on implausible value', store.readLocalBest('blue', ls) === null);
  check('readLocalBest purged the implausible value', ls.getItem(store.localBestTimeKey('blue')) === null);
  // The SAME 13 s value is a VALID Black best (Black's floor is 13 s) — must be preserved,
  // not purged (Codex #359: tier-aware local-best validation).
  ls.setItem(store.localBestTimeKey('black'), '15');
  check('readLocalBest preserves a valid fast Black best (15 s)', store.readLocalBest('black', ls) === 15);
  check('valid Black best not purged', ls.getItem(store.localBestTimeKey('black')) === '15');
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

  // --- Pending-sync marker (keyed by uid + tier, Codex #362) ---
  // Composite storage key: `${uid}\u0000${tier}` (the NUL separator the module uses).
  const pk = (uid, tier) => uid + '\u0000' + tier;
  ls.reset();
  check('readPendingSync empty when absent', Object.keys(store.readPendingSync(ls)).length === 0);
  check('markPendingSync writes a valid entry', store.markPendingSync('black', 25, 'u1', { recordedAt: 111, storage: ls }) === true);
  const p1 = store.getPendingSync('u1', 'black', ls);
  check('pending entry has tier/time/uid/recordedAt', !!p1 && p1.tier === 'black' && p1.time === 25 && p1.uid === 'u1' && p1.recordedAt === 111);
  check('markPendingSync keeps the BEST (lower) time for the same owner', store.markPendingSync('black', 30, 'u1', { recordedAt: 222, storage: ls }) === false);
  check('pending time unchanged after slower mark', store.getPendingSync('u1', 'black', ls).time === 25);
  check('faster pending time replaces', store.markPendingSync('black', 20, 'u1', { recordedAt: 333, storage: ls }) === true);
  check('pending time is now 20', store.getPendingSync('u1', 'black', ls).time === 20);
  check('invalid pending time rejected', store.markPendingSync('black', NaN, 'u1', { storage: ls }) === false);
  // A marker MUST carry an owning uid (Codex #362): an empty uid is refused.
  check('markPendingSync without a uid is refused', store.markPendingSync('black', 19, '', { storage: ls }) === false);

  // A DIFFERENT owner's mark for the same tier is PRESERVED alongside (its own composite
  // key) — never overwriting or being blocked by the other user's time — so each user's
  // queued best survives on a shared browser (Codex #362).
  ls.reset();
  store.markPendingSync('black', 30, 'userA', { recordedAt: 1, storage: ls });
  check('a different owner queues independently (slower time still written)', store.markPendingSync('black', 40, 'userB', { recordedAt: 2, storage: ls }) === true);
  check('userA’s black entry is intact', store.getPendingSync('userA', 'black', ls)?.time === 30);
  check('userB’s black entry coexists', store.getPendingSync('userB', 'black', ls)?.time === 40);
  check('both owners present in the map', Object.keys(store.readPendingSync(ls)).length === 2);
  ls.reset();
  store.markPendingSync('black', 20, 'u1', { recordedAt: 333, storage: ls });

  // markPendingSync without an explicit recordedAt stamps Date.now() (a finite number).
  store.markPendingSync('expert', 22, 'u1', { storage: ls });
  const pExpert = store.getPendingSync('u1', 'expert', ls);
  check('markPendingSync defaults recordedAt to a finite timestamp', !!pExpert && typeof pExpert.recordedAt === 'number' && Number.isFinite(pExpert.recordedAt));
  // A non-finite explicit recordedAt normalizes to null.
  store.clearPendingSync('u1', 'expert', ls);
  store.markPendingSync('expert', 22, 'u1', { recordedAt: NaN, storage: ls });
  check('non-finite recordedAt normalizes to null', store.getPendingSync('u1', 'expert', ls).recordedAt === null);
  store.clearPendingSync('u1', 'expert', ls);

  // clearPendingSync on an absent (uid, tier) is a no-op (does not throw / create the key).
  let clearThrew = false;
  try { store.clearPendingSync('u1', 'expert', ls); } catch { clearThrew = true; }
  check('clearPendingSync on absent tier is a safe no-op', clearThrew === false);

  // Second tier is independent.
  store.markPendingSync('bunny', 30, 'u1', { recordedAt: 444, storage: ls });
  check('two tiers tracked independently', store.getPendingSync('u1', 'bunny', ls).time === 30 && store.getPendingSync('u1', 'black', ls).time === 20);

  // Clear one tier; the other survives; storage key removed only when the map empties.
  store.clearPendingSync('u1', 'black', ls);
  check('cleared tier is gone', store.getPendingSync('u1', 'black', ls) === null);
  check('other tier survives clear', store.getPendingSync('u1', 'bunny', ls).time === 30);
  store.clearPendingSync('u1', 'bunny', ls);
  check('pending key removed when map empties', ls.getItem(store.PENDING_SYNC_KEY) === null);

  // Corrupt / tampered pending payloads are ignored, not thrown.
  ls.setItem(store.PENDING_SYNC_KEY, '{not json');
  check('readPendingSync empty on junk JSON', Object.keys(store.readPendingSync(ls)).length === 0);
  ls.setItem(store.PENDING_SYNC_KEY, '[1,2,3]');
  check('readPendingSync empty on array payload', Object.keys(store.readPendingSync(ls)).length === 0);
  // A stored `tier` field that disagrees with the composite key's tier (tamper) is dropped.
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ [pk('u1', 'black')]: { tier: 'blue', time: 20, uid: 'u1', recordedAt: 1 } }));
  check('mismatched tier field dropped', store.getPendingSync('u1', 'black', ls) === null);
  // A stored `uid` field that disagrees with the composite key's uid is dropped.
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ [pk('u1', 'black')]: { tier: 'black', time: 20, uid: 'someone-else', recordedAt: 1 } }));
  check('mismatched uid field dropped', store.getPendingSync('u1', 'black', ls) === null);
  // A forged sub-floor time is dropped on read.
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ [pk('u1', 'black')]: { tier: 'black', time: 1, uid: 'u1', recordedAt: 1 } }));
  check('forged sub-floor pending time dropped', store.getPendingSync('u1', 'black', ls) === null);
  // An unknown/tampered tier in the composite key is rejected — only real difficulty ids survive.
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ [pk('u1', 'evil')]: { tier: 'evil', time: 25, uid: 'u1', recordedAt: 1 } }));
  check('unknown tier key rejected (not a real difficulty)', Object.keys(store.readPendingSync(ls)).length === 0);
  // A legacy bare-tier key (no uid separator) is dropped — a pre-uid marker can't be flushed
  // safely, so it's discarded on upgrade (Codex #362).
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ blue: { tier: 'blue', time: 30, uid: 'u1', recordedAt: 1 } }));
  check('legacy bare-tier key (no uid) dropped', Object.keys(store.readPendingSync(ls)).length === 0);
  // A valid entry with a non-number recordedAt reads back with recordedAt null.
  ls.setItem(store.PENDING_SYNC_KEY, JSON.stringify({ [pk('u1', 'blue')]: { tier: 'blue', time: 30, uid: 'u1', recordedAt: 'oops' } }));
  check('non-number stored recordedAt reads as null', store.getPendingSync('u1', 'blue', ls).recordedAt === null);

  console.log(`\nOFFLINE-STORE TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
