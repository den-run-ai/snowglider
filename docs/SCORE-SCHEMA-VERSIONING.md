# Changing the physics / remote score version

Physics versions have independent best-time fields and leaderboards. Updating the
active client must also preserve every earlier deployed schema: historical fields
remain on user documents, and cached clients can still write their own version.
Removing a historical field from either rules allowlist breaks ordinary profile
updates for players whose documents contain it.

For each `PHYSICS_VERSION` bump:

1. Append the version to `SHIPPED_REMOTE_VERSIONS` in
   `tests/lib/remote-score-schemas.js`. V3 is the first versioned remote schema;
   retain the unversioned schema and every version from V3 onward. Never rename
   the previous entry to the new version.
2. Add the new fields to both create and update allowlists in `firestore.rules`,
   with their plausibility bounds and independent monotonic-improvement checks.
   Keep all earlier fields, bounds, and checks. If the new version changes score
   limits, add a separate validator; do not change historical score validation.
3. Add the new tier collections with the intended authenticated-read and
   ranked/unranked write policies. Keep every historical collection's policy.
4. Run `node --import ./tests/loaders/register-ts-resolve.mjs
   tests/remote-version-sync-tests.js` and `npm run test:firebase`. Both consume
   the complete schema history. The emulator verifies historical profile updates,
   bounds, monotonic scores, independent versions, and collection permissions.
5. Deploy the additive Firestore rules before serving the new client. The existing
   CI `deploy-rules` job uses the Rules REST API and runs before the Pages build;
   it requires the repository service-account secret, not a Firebase app or CLI.
   Keep that gate: a failed rules deployment must prevent the new client shipping.
6. Tell players that comparable personal bests and boards start fresh under the
   new physics version; existing historical data is retained.

The fast gate replaces the active schema with its successor: complete new-version
rules still fail compatibility checks if the edit drops a previously shipped
version. The Firebase mock accepts only the exact legacy and numeric-version tier
naming shapes; typos fail immediately.

Physics v4 separates the corrected tuck acceleration from v3 scores. The additive
rules retain unversioned and v3 fields/boards; personal bests and ranked Blue times
start fresh in v4. Bunny, Black and Expert remain unranked. Historical records are
retained and are never copied into the v4 leaderboard.

v4 uses a 15 s active Blue plausibility floor; legacy/v3 keep 18 s. The sampled
fastest clean run was 21.87 s. Course length divided by the observed peak speed
gives a 17.75 s estimate, not a proven bound; 15 s leaves conservative headroom.
