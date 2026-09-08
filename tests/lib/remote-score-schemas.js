// @ts-check
// Append-only history shared by the fast drift gate and the Firestore emulator.
// V1/V2 never shipped versioned remote names; V3 is the first. Never replace an
// old version: stored fields and old clients still require their original rules.
const SHIPPED_REMOTE_VERSIONS = Object.freeze([3]);
const TIERS = Object.freeze(/** @type {const} */ (['blue', 'bunny', 'black', 'expert']));

function schemaForVersion(version) {
  const fieldSuffix = version === null ? '' : `V${version}`;
  const boardSuffix = version === null ? '' : `_v${version}`;
  return {
    version,
    label: version === null ? 'legacy' : `v${version}`,
    // Keep historical floors unchanged when a future version changes its floor.
    scoreValidator: 'isValidScoreTime',
    minTime: 18,
    maxTime: 600,
    tiers: TIERS.map(tier => ({
      tier,
      field: `bestTime${tier === 'blue' ? '' : tier[0].toUpperCase() + tier.slice(1)}${fieldSuffix}`,
      board: `leaderboard${boardSuffix}${tier === 'blue' ? '' : `_${tier}`}`,
      ranked: tier === 'blue'
    }))
  };
}

const REMOTE_SCORE_SCHEMAS = Object.freeze([
  schemaForVersion(null),
  ...SHIPPED_REMOTE_VERSIONS.map(schemaForVersion)
]);

module.exports = { SHIPPED_REMOTE_VERSIONS, REMOTE_SCORE_SCHEMAS, schemaForVersion };
