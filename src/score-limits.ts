/**
 * Active leaderboard score-time bounds (physics v4).
 *
 * The corrected tuck drag produced a fastest clean Blue run of 21.87 s across
 * 180 sampled policies/seeds, with a measured peak speed of 10.14 m/s. Dividing
 * the 180-unit course by that observed peak gives a 17.75 s estimate, not a
 * proven global lower bound. A conservative 15 s floor leaves headroom below
 * that estimate; the harness must be rerun when movement changes.
 *
 * Firestore's v4 validator and the classic local-auth fallback duplicate these
 * literals; tests/score-limits-sync-tests.js guards them. Historical rules keep
 * their original 18 s floor so existing data and cached clients remain valid.
 */
export const MIN_VALID_SCORE_TIME = 15;
export const MAX_VALID_SCORE_TIME = 600;
