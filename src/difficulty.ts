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
import { getRunStamp } from './run-context.js';
// Type-only import: the lane shape lives next to the centerline primitive it feeds
// (course-line.ts, also THREE-free), and `import type` erases at build time so this
// stays a runtime-dependency-free module.
import type { CourseLineParams } from './course-line.js';
// Type-only too: the corridor shape lives next to the terrain seam that reads it.
import type { TerrainCorridorParams, KickerSpec } from './mountains/terrain.js';

/** The four difficulty tiers, keyed by their ski-resort trail rating. */
export type Difficulty = 'bunny' | 'blue' | 'black' | 'expert';

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
  // Freestyle tricks (#32): whether the kernel accepts in-air trick input (spins /
  // flips / grabs) on ANY jump — a deliberate manual pop AND a terrain kicker
  // (auto-jump), since kicker air is where touch players actually rotate. Expert-only.
  // False on every other tier, so the BLUE default — the tuning the physics-invariant
  // harness runs with — is byte-identical to the pre-freestyle kernel even under
  // airborne steering input (a non-freestyle kicker stays a non-player jump).
  freestyleTricks: boolean;
  // Per-tier jump availability (#47 round 2 / jump-system completion, workstream A).
  // Both default TRUE on Blue — the tuning the physics-invariant harness runs with —
  // so every existing caller and the frozen no-input baseline are byte-identical.
  // Bunny sets both false: Space/touch does nothing (no straight jump, no hop turn)
  // and terrain lips never loft — the easy tier is a calm, grounded learning run.
  // NOTE: `manualJump: false` + `autoJump: true` is an UNSUPPORTED combination — the
  // auto-jump gate keeps its `!controls.jump` takeoff-precedence term, so holding
  // Jump on such a tier would suppress auto-pops and diverge from the no-input
  // trajectory. No shipped tier uses it (see PHYSICS.md §4).
  manualJump: boolean;        // Space/touch straight jump + hop turn available
  autoJump: boolean;          // terrain-lip auto-pop fires
  // Landing-physics upgrade (workstream C): when true, an extreme manual-jump
  // landing — slamming the surface too hard (normal-impact speed past
  // LAND_WIPEOUT_NORMAL) or coming down mid-somersault — CRASHES (the #171
  // shatter, run over) instead of merely scrubbing. Expert-only: freestyle risk
  // gets real consequences; every other tier keeps the forgiving scrub.
  wipeouts: boolean;
  // Designed air (workstream E / JP-6): when true, the terrain auto-jump's takeoff
  // velocity derives from the LIP GEOMETRY the player actually rode off (convexity
  // along travel × speed, clamped — see PHYSICS.md §4.3) instead of the legacy
  // `6 + 0.3·speed` constant, so bigger ramps at higher speed give proportionally
  // bigger, physically plausible arcs — what makes the sculpted kickers work.
  // False everywhere but Expert (designed air is Expert-exclusive for now — adopted
  // plan decision §10.4, revisit for Black), so the frozen no-input auto-jump
  // constants never move.
  lipLaunch: boolean;
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
  freestyleTricks: false,
  manualJump: true,
  autoJump: true,
  wipeouts: false,
  lipLaunch: false,
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
  // No jumps on Bunny (jump-system completion, workstream A): the jump verb —
  // straight pop AND hop turn — is off, and terrain lips never auto-pop, so the
  // grounded path's `pos.y = terrain` keeps the snowman glued over lips (reads as
  // a groomed run). Held-jump on Bunny is provably ≡ no-input (invariant harness).
  manualJump: false,
  autoJump: false,
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

// Expert: Black's handling with the freestyle trick system unlocked (#32). The tier
// after Hard is not a new physics feel — it is the same unforgiving Black setup plus
// the in-air trick vocabulary (spin/flip/grab on a manual jump), which adds its own
// risk: an under-rotated trick spoils the landing. Kernel gating lives behind this
// single flag, so every other tier's air phase is byte-identical to today.
const EXPERT_PHYSICS_TUNING: SnowmanPhysicsTuning = {
  ...BLACK_PHYSICS_TUNING,
  freestyleTricks: true,
  // Freestyle risk with real consequences (workstream C): an over-harsh or
  // mid-rotation landing on Expert is a crash (shatter), not just a scrub.
  wipeouts: true,
  // Designed air (workstream E): Expert's lips launch from the geometry the player
  // rode off — required for the sculpted kickers below to produce real arcs.
  lipLaunch: true,
};

/**
 * Per-tier avalanche tuning (the `avalanche` block of a difficulty config). The slide is
 * "the mountain chasing you": a tier can make it fire earlier, run faster, and pack more
 * boulders (Black), or turn it off entirely (Bunny). Only these numbers reach the
 * AvalancheSystem (via scene-setup) — never the kernel. `boulderCount` sizes the
 * InstancedMesh; `triggerDistance` is how far downhill the player travels before a slide
 * (re)arms; `slideSpeedBase`/`slideSpeedJitter` set each boulder's initial downhill speed
 * (`-(base + random()*jitter)` m/s). Black's numbers are PROVISIONAL — they are validated
 * and tuned against the follow-the-line winnability harness (D3.2d), the quantitative gate
 * the ranked flip depends on.
 */
export interface AvalancheTuning {
  enabled: boolean;         // false ⇒ this tier has no avalanche (Bunny) — the slide never arms
  triggerDistance: number;  // downhill units the player travels before a slide (re)arms
  boulderCount: number;     // boulders in the slide (sizes the InstancedMesh)
  slideSpeedBase: number;   // base initial downhill boulder speed (m/s)
  slideSpeedJitter: number; // random 0..jitter added to the base, per boulder
}

/**
 * BLUE == today's shipped slide, extracted VERBATIM: the 80 u trigger distance and 120
 * boulders that lived as `AVALANCHE_TRIGGER_DISTANCE`/`AVALANCHE_BOULDER_COUNT`, and the
 * `-(7 + random()*3)` m/s per-boulder speed that lived in avalanche.ts `trigger()`. So the
 * default tier's avalanche stays byte-identical — the same boulder count draws from the
 * same Math.random() stream in the same order (the byte-identical guardrail).
 */
export const BLUE_AVALANCHE: AvalancheTuning = {
  enabled: true,
  triggerDistance: 80,
  boulderCount: 120,
  slideSpeedBase: 7,
  slideSpeedJitter: 3,
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
  // The winding-corridor terrain shape (mountains/terrain.ts banks the skiable channel
  // onto the `line` and raises walls off it). Present ONLY for tiers whose terrain winds
  // (Black); absent ⇒ straight tiers build today's exact terrain — the byte-identical
  // guardrail. Wired into the run by scene-setup.ts before the mesh is built (D3.2b).
  terrain?: TerrainCorridorParams;
  // Sculpted kickers on the course line (JP-6, workstream E): ramps rising to a lip
  // that drops off, centered laterally at `laneX(z)`. Absent ⇒ byte-identical terrain
  // (the same guardrail pattern as `terrain` above). Expert-exclusive for now
  // (adopted plan decision §10.4); wired by scene-setup.ts before the mesh is built,
  // added in the ONE canonical height source (mountains/terrain.ts) that both the
  // mesh and the physics sampler consume — the §2.2 two-formula contract.
  features?: KickerSpec[];
  // The per-tier avalanche slide (scene-setup.ts builds the AvalancheSystem from it).
  // Blue is today's shipped slide (byte-identical); Bunny turns it off; Black fires
  // earlier, faster, and heavier. Required so every tier is explicit and scene-setup
  // needs no fallback. Black's numbers are provisional — the follow-the-line winnability
  // harness (D3.2d) is where they get tuned for real (the ranked-flip gate).
  avalanche: AvalancheTuning;
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
  // Honest about the tier's control surface: Bunny has no jump verb at all
  // (ski.manualJump/autoJump false), so the picker says so up front.
  blurb: 'Easy — the gentlest way down. No jumps, just carving.',
  seed: 1001,
  ski: BUNNY_PHYSICS_TUNING,
  ranked: false, // unranked until its floor is measured (D3 follow-up)
  minScoreTime: 28, // PROVISIONAL — re-measure before ranked
  line: STRAIGHT_LINE, // easy tier stays a straight fall line
  // Bunny has NO avalanche — the easy tier is a calm learning run. `enabled: false` keeps
  // the AvalancheSystem inert (main-loop skips the trigger), and triggerDistance Infinity is
  // belt-and-suspenders. boulderCount stays a valid non-zero so the InstancedMesh is sound.
  avalanche: { ...BLUE_AVALANCHE, enabled: false, triggerDistance: Infinity },
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
  avalanche: BLUE_AVALANCHE, // today's exact slide — the byte-identical guardrail
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
  // Bank that line into a skiable channel: a 14 u-wide flat floor (the on-line feel is
  // exactly today's), flanks ramping ~9 u up to a 10 u wall — running straight when the
  // line turns climbs the wall, and the walls funnel avalanche boulders down the channel.
  // Provisional — re-tuned against the winnability harness in D3.2d.
  terrain: { channelHalfWidth: 7, wallRamp: 9, wallHeight: 10 },
  // The Black slide is the mountain chasing you: it arms sooner (60 u vs Blue's 80 ⇒ more
  // slides over the run), the boulders start faster (-(9 + rand*3) vs -(7 + rand*3)), and it
  // packs more of them (150 vs 120 ⇒ a broader, harder-to-flank wall). PROVISIONAL — tuned
  // against the follow-the-line winnability harness so a skilled Black line still escapes
  // (D3.2d); the corridor walls funnel these boulders down the channel onto the fast line.
  avalanche: { enabled: true, triggerDistance: 60, boulderCount: 150, slideSpeedBase: 9, slideSpeedJitter: 3 },
};

// Expert (◆◆ double black): the tier after Hard. Same winding corridor + heavy slide
// as Black (values copied, own seed so the line is its own course), same ski feel —
// what changes is the unlocked freestyle trick system (ski.freestyleTricks). Unranked
// practice tier like Bunny/Black until its floor is measured (D3 follow-up).
const EXPERT: DifficultyConfig = {
  id: 'expert',
  label: '◆◆ Expert',
  blurb: 'Expert — freestyle: spin, flip & grab in the air.',
  seed: 1004,
  ski: EXPERT_PHYSICS_TUNING,
  ranked: false, // unranked until its floor is measured (D3 follow-up)
  minScoreTime: 13, // PROVISIONAL — re-measure before ranked (mirrors Black)
  // Black's serpentine, re-seeded: the same difficulty of line, its own fixed course.
  line: { curviness: 1, amplitude: 18, controlPoints: 5 },
  terrain: { channelHalfWidth: 7, wallRamp: 9, wallHeight: 10 },
  // Designed air (JP-6): three sculpted kickers spaced down the run, each centered
  // on the course line (laneX at its lip) and spanning the channel floor
  // (halfWidth == channelHalfWidth). The u² ramp profile is steepest AT the lip
  // (~0.86 rise/run for 3 u over 7 u ≈ 40° lip pitch), which is what the
  // lip-consistent launch converts to air — a committed straight run launches a
  // real arc; a cautious line can brake or skirt the taper. PROVISIONAL —
  // validated by the follow-the-line winnability gate (a line rider goes off
  // every kicker and must still finish and out-ski the slide).
  features: [
    { z: -70, length: 7, halfWidth: 7, height: 3.0 },
    { z: -110, length: 7, halfWidth: 7, height: 3.0 },
    { z: -150, length: 7, halfWidth: 7, height: 3.0 },
  ],
  avalanche: { enabled: true, triggerDistance: 60, boulderCount: 150, slideSpeedBase: 9, slideSpeedJitter: 3 },
};

/** All tiers in display order (easy → hard). */
export const DIFFICULTIES: readonly DifficultyConfig[] = [BUNNY, BLUE, BLACK, EXPERT];

/** The default tier == the classic game. */
export const DEFAULT_DIFFICULTY: Difficulty = 'blue';

/** localStorage key for the player's last-chosen tier. */
export const DIFFICULTY_STORAGE_KEY = 'snowgliderDifficulty';

const BY_ID: Record<Difficulty, DifficultyConfig> = {
  bunny: BUNNY,
  blue: BLUE,
  black: BLACK,
  expert: EXPERT,
};

/** Type guard: is `value` one of the known difficulty ids? */
export function isDifficulty(value: unknown): value is Difficulty {
  return value === 'bunny' || value === 'blue' || value === 'black' || value === 'expert';
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
/** Sidecar key for the run-provenance stamp next to a tier's local best time. */
export function localBestMetaKey(tier: Difficulty = DEFAULT_DIFFICULTY): string {
  return `${localBestTimeKey(tier)}_meta`;
}

/** Stamp the just-recorded local best with its run provenance (#400): the run
 *  seed (null while unseeded) and the PHYSICS_VERSION that produced the time,
 *  so a future replay/ranked mode knows whether the record is reproducible and
 *  against which kernel. A SIDECAR key: the legacy bare-number best-time value
 *  and every existing reader stay byte-for-byte unchanged. Best-effort — a
 *  blocked storage write must never break score recording.
 *
 *  Lives HERE (not scores.ts) so every local-best write path can stamp without
 *  pulling the Firebase SDK into its module graph: scores.ts imports the
 *  gstatic CDN modules, and result-overlay.ts is part of the game orchestrator
 *  graph that must still boot when the CDN is blocked and the local fallback is
 *  installed (Codex review, PR #407 P1). */
export function stampLocalBestMeta(tier: Difficulty = DEFAULT_DIFFICULTY): void {
  try {
    localStorage.setItem(localBestMetaKey(tier), JSON.stringify(getRunStamp()));
  } catch { /* storage may be unavailable; the time itself already saved */ }
}

/** Read a tier's run-provenance stamp ({seed, physicsVersion}) or null. */
export function readLocalBestMeta(tier: Difficulty = DEFAULT_DIFFICULTY): { seed: number | null; physicsVersion: number } | null {
  try {
    const raw = localStorage.getItem(localBestMetaKey(tier));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as { seed?: unknown; physicsVersion?: unknown };
    if (typeof rec.physicsVersion !== 'number') return null;
    return {
      seed: typeof rec.seed === 'number' ? rec.seed : null,
      physicsVersion: rec.physicsVersion,
    };
  } catch {
    return null;
  }
}

export function localBestTimeKey(tier: Difficulty): string {
  return tier === 'blue' ? 'snowgliderBestTime' : `snowgliderBestTime_${tier}`;
}

// Split/ghost storage names. Unlike best-time, these are suffixed for EVERY tier
// (Blue included) — the historical scheme in course.ts, whose one-time
// `migrateLegacyLocalKeys` moved the pre-tier un-suffixed keys onto `…_blue`. These
// exports are the single source of truth the offline layer reuses instead of
// re-deriving the strings (see src/offline/offline-store.ts); course.ts still owns
// its own literals today — tests/offline-store-tests.js pins the format so the two
// can never drift.

/** localStorage base name for a tier's best splits (per-tier suffixed, Blue included). */
export const LOCAL_BEST_SPLITS_BASE = 'snowgliderBestSplits';

/** localStorage base name for a tier's ghost recording (per-tier suffixed, Blue included). */
export const LOCAL_GHOST_BASE = 'snowgliderGhost';

/** localStorage key for a tier's best splits. Suffixed for every tier (Blue included). */
export function localBestSplitsKey(tier: Difficulty): string {
  return `${LOCAL_BEST_SPLITS_BASE}_${tier}`;
}

/** localStorage key for a tier's ghost recording. Suffixed for every tier (Blue included). */
export function localGhostKey(tier: Difficulty): string {
  return `${LOCAL_GHOST_BASE}_${tier}`;
}

/** Firestore leaderboard collection name for a tier. */
export function leaderboardCollectionName(tier: Difficulty): string {
  return tier === 'blue' ? 'leaderboard' : `leaderboard_${tier}`;
}

/** Field on `users/{uid}` holding a tier's best time. */
export function userBestTimeField(tier: Difficulty): string {
  if (tier === 'bunny') return 'bestTimeBunny';
  if (tier === 'black') return 'bestTimeBlack';
  if (tier === 'expert') return 'bestTimeExpert';
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

/** Does a run on `runTier` need the scene rebuilt for it? The corridor/gates/obstacles/
 *  avalanche are baked once from `builtTier` (the tier setupScene ran on); they only match
 *  the run when the tiers agree. `automation` forces `false` so the test/E2E suites stay on
 *  a single, reload-free path (they never switch tiers mid-session). Pure decision core of
 *  snowglider.ts `maybeReloadForRunTier`; the reload + persistence side effects stay there. */
export function runTierNeedsRebuild(runTier: Difficulty, builtTier: Difficulty, automation: boolean): boolean {
  return !automation && runTier !== builtTier;
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
