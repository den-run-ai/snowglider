/**
 * Active leaderboard score-time bounds (physics v4).
 *
 * `npm run test:floor` measures 60 seeds × three jump policies for each tier.
 * Fastest sampled finishes: Bunny 33.18s, Blue 21.87s, Black 21.73s, Expert 20.38s.
 * Course distance / observed peak speed is only an estimate, not a proven lower
 * bound. The conservative review candidates were 22 / 15 / 10 / 10 seconds.
 * Bunny retains the previously accepted 15-second score floor so enabling its
 * board cannot reject an older accepted device record. Black and Expert need
 * their own lower floor; neither inherits Blue's slower physics limit.
 *
 * Firestore rules and the classic local-auth fallback duplicate these literals;
 * tests/score-limits-sync-tests.js guards drift. Historical remote eras keep
 * their original bounds and are never combined with these current boards.
 */
export const MIN_VALID_SCORE_TIME = 15;
export const MAX_VALID_SCORE_TIME = 600;
export const MIN_SCORE_TIME_BY_DIFFICULTY = {
  bunny: 15,
  blue: MIN_VALID_SCORE_TIME,
  black: 10,
  expert: 10,
} as const;
