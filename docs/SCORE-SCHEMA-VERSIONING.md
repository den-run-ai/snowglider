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
5. Deploy the additive Firestore rules before serving the new client. Rules are
   a separate deployment from GitHub Pages. Confirm the deployed rules support
   both old and new clients, then run the complete repository gate and deploy.
6. Tell players that comparable personal bests and boards start fresh under the
   new physics version; existing historical data is retained.

The fast gate includes a V3-to-V4 replacement mutation: complete V4 rules still
fail compatibility checks if the edit drops V3. The Firebase mock accepts only
the exact legacy and numeric-version tier naming shapes; typos fail immediately.
