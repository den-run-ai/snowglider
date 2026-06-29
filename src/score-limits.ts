/**
 * score-limits.ts — single source of truth for the leaderboard score-time bounds.
 *
 * MIN_VALID_SCORE_TIME is the leaderboard PLAUSIBILITY FLOOR. It was measured
 * empirically by tests/verification/plausibility_floor_harness.js (issue #229, PR A),
 * which drives the real Snowman physics over the real 180 m course: the shipped engine's
 * fastest clean descent is ~26 s, and the hard theoretical minimum is ~21.8 s (the
 * COURSE_LENGTH ÷ the ~8.2 m/s friction-capped terminal speed). Chaining the clean-landing
 * jump boost is NET-SLOWER, so there is no exploit that beats the cruise — any sub-floor
 * time is therefore forged, not engine-producible.
 *
 * 18 s sits ~15% under the theoretical minimum: low enough that a legitimate engine run is
 * never rejected, high enough to reject the implausible ~14 s records issue #229 flagged.
 * (The previous value, 4 s, was a placeholder that let forged times through.)
 *
 * MAX_VALID_SCORE_TIME is a generous upper bound for a completed run.
 *
 * IMPORTANT: firestore.rules duplicates these two literals because Firestore security
 * rules cannot import JavaScript. tests/score-limits-sync-tests.js asserts the rules
 * literals equal these constants, so the client and server floors can never drift.
 */
export const MIN_VALID_SCORE_TIME = 18;
export const MAX_VALID_SCORE_TIME = 600;
