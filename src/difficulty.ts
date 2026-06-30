// difficulty.ts — single source of truth for the SnowGlider difficulty tiers.
//
// Mirrors the score-limits.ts pattern: one config object is the spine, everything
// *reads* it, nothing hard-codes a tier. This first stage (the config spine + the
// kernel tuning API) lands the data and the type surface; later stacked PRs wire the
// selection, terrain/obstacle/avalanche tuning, per-tier leaderboards, and assists.
//
// Design anchors (see the difficulty-tiers proposal):
//   - Ski-resort trail ratings as the names: ● Bunny (Easy) / ■ Blue (Medium) /
//     ◆ Black (Hard), matching the green/yellow/red Slope-HUD language.
//   - Blue == today's frozen constants. `BLUE_PHYSICS_TUNING` is the current
//     hard-coded physics locals extracted verbatim, so the no-input identity gate
//     and the historical baseline never need regenerating for the default tier.
//
// This module is intentionally dependency-free (it only reads the score-limits
// floor), so it can be imported by the physics kernel without pulling in THREE.
import { MIN_VALID_SCORE_TIME } from './score-limits.js';
// Type-only import: the lane shape lives next to the centerline primitive it feeds
// (course-line.ts, also THREE-free), and `import type` erases at build time so this
// stays a runtime-dependency-free module.
import type { CourseLineParams } from './course-line.js';

/** The three difficulty tiers, keyed by their ski-resort trail rating. */
export type Difficulty = 'bunny' | 'blue' | 'black';

/**
 * The physics-kernel tuning struct. These are exactly the constants that were
 * hard-coded as locals inside `stepSnowmanPhysics` (src/snowman/physics.ts); the
 * kernel now takes this struct as an optional, BLUE-defaulted parameter so a tier
 * can vary the handling feel without forking the kernel. Only `config.ski` (a value
 * of this type) is ever passed into the kernel — never the whole DifficultyConfig —
 * which keeps the kernel pure and the no-input baseline frozen.
 */
export interface SnowmanPhysicsTuning {
  gravity: number;            // along-slope gravity (grounded)
  airGravity: number;         // downward gravity while airborne
  baseFriction: number;       // friction floor at low speed
  frictionRamp: number;       // extra friction added at high speed (max = base + ramp)
  gripBase: number;           // terrain-grip floor (edge bite on flats)
  carveLock: number;          // carveCharge past this reads + behaves as a carve
  carveBuild: number;         // per-second carve-charge build rate (held turn)
  carveRelease: number;       // per-second carve-charge release rate
  parallelTurnForce: number;  // skidded parallel turn authority (tight/pivoty)
  carveTurnForce: number;     // carved turn authority (wide/drawn-out arc)
  tuckAccel: number;          // straight-line tuck acceleration (Up, no steer)
  plowDecelLight: number;     // light-wedge brake deceleration
  plowDecelFull: number;      // full-wedge brake deceleration
  skidScrubMax: number;       // base wash-out scrub for an uncommitted (skidded) turn
  airControl: number;         // side force available while airborne
}

/**
 * BLUE == today's shipped constants, extracted VERBATIM from the kernel's former
 * hard-coded locals. This is the default tuning the kernel uses when no tier passes
 * its own, so the physics-invariant harness (which calls with no tuning) and the
 * frozen baseline stay bit-for-bit unchanged.
 */
export const BLUE_PHYSICS_TUNING: SnowmanPhysicsTuning = {
  gravity: 9.8,
  airGravity: 16,
  baseFriction: 0.012,
  frictionRamp: 0.020,
  gripBase: 0.6,
  carveLock: 0.6,
  carveBuild: 1.5,
  carveRelease: 3.0,
  parallelTurnForce: 19.0,
  carveTurnForce: 10.0,
  tuckAccel: 10.0,
  plowDecelLight: 3.14,
  plowDecelFull: 5.68,
  skidScrubMax: 0.10,
  airControl: 5.0,
};

// --- Per-tier ski tuning (playtest starting points; Blue is authoritative-current) ---
// Bunny: easier to earn a carve, sloppy turns barely cost speed, slower terminal,
// gentler tuck — it teaches carving without punishing. Brake decel stays identical to
// Blue (per the proposal, Bunny difficulty comes from capped terrain + assists later,
// not a stronger brake).
const BUNNY_PHYSICS_TUNING: SnowmanPhysicsTuning = {
  ...BLUE_PHYSICS_TUNING,
  baseFriction: 0.020,
  frictionRamp: 0.025,   // max 0.045
  gripBase: 0.7,
  carveLock: 0.45,
  carveBuild: 2.0,
  tuckAccel: 7,
  skidScrubMax: 0.06,
};

// Black: the carve is hard to lock, panic-steering bleeds speed fast, less friction so
// it runs faster, weaker air control. Brake decel unchanged (there is just more red
// terrain to fail on, wired in a later PR).
const BLACK_PHYSICS_TUNING: SnowmanPhysicsTuning = {
  ...BLUE_PHYSICS_TUNING,
  baseFriction: 0.008,
  frictionRamp: 0.014,   // max 0.022
  gripBase: 0.5,
  carveLock: 0.72,
  carveBuild: 1.2,
  tuckAccel: 13,
  skidScrubMax: 0.14,
  airControl: 3.0,
};

/**
 * A difficulty tier's full config. This stage carries the identity, the picker copy,
 * the per-tier seed, the kernel ski tuning, and the per-tier plausibility floor.
 * Terrain / obstacle / avalanche / surface / assist tuning are added by later stacked
 * PRs as each lands, so this interface grows additively rather than shipping a wide
 * speculative surface up front.
 */
export interface DifficultyConfig {
  id: Difficulty;
  label: string;            // "● Bunny", "■ Blue", "◆ Black"
  blurb: string;            // one-line description for the start-screen picker
  seed: number;             // base seed (derives the per-tier RNG streams in a later PR)
  ski: SnowmanPhysicsTuning;
  // Whether this tier submits to the global per-tier leaderboard. Bunny/Black ship
  // UNRANKED (practice only — local best/ghost still work) until their plausibility
  // floors are measured + a winnability gate passes; flipped on in a later stacked PR.
  ranked: boolean;
  // Per-tier leaderboard plausibility floor (seconds). Blue is the MEASURED shipped
  // floor (score-limits.ts). Bunny/Black are PROVISIONAL illustrative values and MUST
  // be re-measured with tests/verification/plausibility_floor_harness.js before the
  // per-tier leaderboards ship ranked (a later stacked PR).
  minScoreTime: number;
  // The descent centerline shape (course-line.ts reads this + `seed`). Bunny/Blue are
  // STRAIGHT (`curviness 0` ⇒ `laneX ≡ 0`), so their terrain/gates/obstacles stay
  // byte-identical to today; Black winds. Only the line *data* lands here for now — the
  // terrain corridor, gates, and obstacle field that read it are wired in later D3.2
  // sub-PRs, so this PR is no felt change for any tier.
  line: CourseLineParams;
}

// The classic straight fall line: `laneX ≡ 0` everywhere. Shared by Bunny + Blue so
// their course is provably unchanged (the byte-identical guardrail).
const STRAIGHT_LINE: CourseLineParams = { curviness: 0, amplitude: 0, controlPoints: 0 };

const BUNNY: DifficultyConfig = {
  id: 'bunny',
  label: '● Bunny',
  // Picker copy is intentionally tier-identity only (Easy/Medium/Hard) for now: it
  // must not promise mechanics that aren't wired yet (no avalanche / gentler terrain).
  // The richer flavour copy lands with the per-tier tuning PR, where it becomes true.
  blurb: 'Easy — the gentlest way down.',
  seed: 1001,
  ski: BUNNY_PHYSICS_TUNING,
  ranked: false, // unranked until its floor is measured (D3 follow-up)
  minScoreTime: 28, // PROVISIONAL — re-measure before ranked
  line: STRAIGHT_LINE, // easy tier stays a straight fall line
};

const BLUE: DifficultyConfig = {
  id: 'blue',
  label: '■ Blue',
  blurb: 'Medium — the classic SnowGlider run.',
  seed: 1002,
  ski: BLUE_PHYSICS_TUNING,
  ranked: true, // the classic, measured, ranked board
  minScoreTime: MIN_VALID_SCORE_TIME, // the measured shipped floor (18 s)
  line: STRAIGHT_LINE, // the classic straight run — byte-identical to today
};

const BLACK: DifficultyConfig = {
  id: 'black',
  label: '◆ Black',
  blurb: 'Hard — for confident skiers.',
  seed: 1003,
  ski: BLACK_PHYSICS_TUNING,
  ranked: false, // unranked until its floor is measured (D3 follow-up)
  minScoreTime: 13, // PROVISIONAL — re-measure before ranked
  // The winding corridor — "the line is the difficulty". A ±18 u serpentine of ~5
  // turns over the run; the fixed seed (1003) makes it identical for everyone. Tuned
  // for real against Black's #240 physics in a later D3.2 sub-PR (terrain + winnability).
  line: { curviness: 1, amplitude: 18, controlPoints: 5 },
};

/** All tiers in display order (easy → hard). */
export const DIFFICULTIES: readonly DifficultyConfig[] = [BUNNY, BLUE, BLACK];

/** The default tier == the classic game. */
export const DEFAULT_DIFFICULTY: Difficulty = 'blue';

/** localStorage key for the player's last-chosen tier. */
export const DIFFICULTY_STORAGE_KEY = 'snowgliderDifficulty';

const BY_ID: Record<Difficulty, DifficultyConfig> = {
  bunny: BUNNY,
  blue: BLUE,
  black: BLACK,
};

/** Type guard: is `value` one of the known difficulty ids? */
export function isDifficulty(value: unknown): value is Difficulty {
  return value === 'bunny' || value === 'blue' || value === 'black';
}

/** Resolve a tier id to its config, falling back to the default tier. */
export function getDifficultyConfig(id: unknown): DifficultyConfig {
  return isDifficulty(id) ? BY_ID[id] : BY_ID[DEFAULT_DIFFICULTY];
}

// --- Per-tier scoring storage names (single source of truth) -----------------
// Blue maps to the ORIGINAL un-suffixed names so the existing leaderboard collection,
// the `users/{uid}.bestTime` field, and the `snowgliderBestTime` localStorage key keep
// working untouched — no migration of live Blue scores. Bunny/Black get sibling names.

/** localStorage key for a tier's best time. */
export function localBestTimeKey(tier: Difficulty): string {
  return tier === 'blue' ? 'snowgliderBestTime' : `snowgliderBestTime_${tier}`;
}

/** Firestore leaderboard collection name for a tier. */
export function leaderboardCollectionName(tier: Difficulty): string {
  return tier === 'blue' ? 'leaderboard' : `leaderboard_${tier}`;
}

/** Field on `users/{uid}` holding a tier's best time. */
export function userBestTimeField(tier: Difficulty): string {
  if (tier === 'bunny') return 'bestTimeBunny';
  if (tier === 'black') return 'bestTimeBlack';
  return 'bestTime';
}

/** Resolve the Storage to read/write the tier from: the passed one, else the
 *  ambient localStorage when present (browser), else null (Node / no DOM). */
function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/** Read the player's last-chosen tier from storage, validated. Falls back to the
 *  default tier on junk, an absent key, or unavailable storage — never throws. */
export function readStoredDifficulty(storage?: Storage | null): Difficulty {
  try {
    const s = resolveStorage(storage);
    const raw = s ? s.getItem(DIFFICULTY_STORAGE_KEY) : null;
    return isDifficulty(raw) ? raw : DEFAULT_DIFFICULTY;
  } catch {
    return DEFAULT_DIFFICULTY;
  }
}

/** Resolve the tier for a starting run: prefer a valid live picker choice (the
 *  current session's visible selection), else the persisted value, else default.
 *  This keeps the run honest when storage writes are blocked (private mode), where
 *  the picker highlight changes but `setItem` silently fails — the live pick wins. */
export function resolveActiveDifficulty(livePick: unknown, storage?: Storage | null): Difficulty {
  return isDifficulty(livePick) ? livePick : readStoredDifficulty(storage);
}

/** Persist the player's chosen tier. No-op (never throws) when storage is
 *  unavailable (private mode / Node). */
export function storeDifficulty(id: Difficulty, storage?: Storage | null): void {
  try {
    const s = resolveStorage(storage);
    if (s) s.setItem(DIFFICULTY_STORAGE_KEY, id);
  } catch {
    /* storage unavailable; the choice simply won't persist */
  }
}
