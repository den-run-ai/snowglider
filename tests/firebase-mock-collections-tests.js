// @ts-check
// Misspelled Firestore collections must fail in the mock, as they do against
// the rules. Exercise both read and write entry points, not only the matcher.
const assert = require('node:assert/strict');

(async () => {
  const F = await import('./mocks/firebase.mjs');
  const validBoards = [
    'leaderboard', 'leaderboard_bunny', 'leaderboard_black', 'leaderboard_expert',
    'leaderboard_v3', 'leaderboard_v3_bunny', 'leaderboard_v3_black', 'leaderboard_v3_expert',
    'leaderboard_v4', 'leaderboard_v12_expert'
  ];
  const invalidBoards = [
    'leaderboards', 'leaderboard_typo', 'leaderboard_v3_typo', 'leaderboard_blue',
    'leaderboard_v3_blue', 'leaderboard_v', 'leaderboard_v0', 'leaderboard_v03',
    'leaderboard_v-1', 'leaderboard_v3.5', 'leaderboard_v3_bunny_extra',
    'leaderboard_bunny_v3', 'leaderboard_', 'leaderboard_v3/extra', 'unknown',
    '__proto__', 'constructor'
  ];
  F.reset();
  for (const board of validBoards) {
    F.seed(board, 'alice', { time: 25 });
    assert.equal(F.read(board, 'alice').time, 25);
    await F.setDoc(F.doc(F.firestoreInstance, board, 'alice'), { time: 24 });
    assert.equal((await F.getDoc(F.doc(F.firestoreInstance, board, 'alice'))).data().time, 24);
    const rows = [];
    (await F.getDocs(F.query(F.collection(F.firestoreInstance, board)))).forEach(snapshot => rows.push(snapshot.data()));
    assert.deepEqual(rows, [{ time: 24 }]);
  }
  for (const board of invalidBoards) {
    const rejectsUnknown = error => error instanceof Error && error.message === `Unknown collection: ${board}`;
    // The mock throws synchronously for invalid store access; wrapping the SDK
    // calls also catches asynchronous implementations if that contract changes.
    await assert.rejects(async () => F.seed(board, 'alice', { time: 20 }), rejectsUnknown);
    await assert.rejects(async () => F.getDoc(F.doc(F.firestoreInstance, board, 'alice')), rejectsUnknown);
    await assert.rejects(async () => F.getDocs(F.query(F.collection(F.firestoreInstance, board))), rejectsUnknown);
    await assert.rejects(async () => F.setDoc(F.doc(F.firestoreInstance, board, 'alice'), { time: 20 }), rejectsUnknown);
    assert.equal(Object.hasOwn(F.db, board), false, `${board} was silently created`);
  }
  F.reset();
  console.log(`FIREBASE MOCK COLLECTION TEST TOTAL: ${validBoards.length} valid + ${invalidBoards.length} invalid names passed`);
})().catch(error => { console.error(error); process.exit(1); });
