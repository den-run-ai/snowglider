// run-context.ts - Named RNG streams for one deterministic run (issue #400).
//
// The audit finding this fixes: gameplay (physics auto-turns, avalanche boulders)
// and cosmetics (ski-spray, powder puffs, camera shake) all drew from ONE global
// Math.random stream, and the cosmetic systems drew per RENDER frame — so a
// 144 Hz display consumed far more of the stream than a 30 Hz one before the
// next gameplay draw, making gameplay outcomes depend on refresh rate and
// particle activity under any fixed seed.
//
// Two stream classes with different contracts:
//
// GAMEPLAY streams ('physics' | 'avalanche' | 'hazards' | 'course') affect run
// outcomes. UNSEEDED (the default, every production run today) they are pure
// passthroughs — `gameplayRandom(name)` calls global `Math.random()` exactly
// once, same order, same count as the direct call it replaced, so:
//   - the physics-invariant harness stays BYTE-IDENTICAL (the frozen baseline
//     copy calls Math.random() directly; the live kernel must consume the very
//     same seeded values), and
//   - the seeded verification harnesses (winnability, fixed-timestep) that pin
//     behavior by assigning `Math.random = makeRng(seed)` keep working unchanged.
// SEEDED (setRunSeed) each gameplay stream becomes an independent deterministic
// PRNG derived from the run seed + the stream name — the seam ranked/replayable
// runs build on: same seed => same auto-turns and same boulder field, no matter
// what any cosmetic layer does.
//
// COSMETIC streams ('snowParticles' | 'avalanchePowder' | 'cameraEffects') are
// ALWAYS private deterministic PRNGs and never touch global Math.random — the
// same discipline tree-shed.ts and scenery-rng.ts already follow. This is what
// structurally severs "particle activity" from "gameplay RNG": a cosmetic layer
// can draw any number of values on any render cadence without perturbing either
// the global stream or a seeded gameplay stream.
//
// Determinism rules for this module: no Date.now(), no wall-clock, no THREE.

/** Streams whose draws affect run outcomes (collision layouts, trajectories). */
export type GameplayStreamName = 'physics' | 'avalanche' | 'hazards' | 'course';
/** Streams whose draws are render-only and must never leak into gameplay. */
export type CosmeticStreamName = 'snowParticles' | 'avalanchePowder' | 'cameraEffects';

/** Physics/behavior versioning anchor (#400): stored alongside a run seed by
 *  future score/ghost records so a replay knows which kernel produced it. Bump
 *  ONLY on an intentional physics-behavior change (the same events that would
 *  justify regenerating the frozen invariant baseline). */
export const PHYSICS_VERSION = 1;

/** Small, fast, well-distributed deterministic PRNG (same family the test
 *  fixtures use). Never global: each stream owns one instance. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the stream name: a stable per-stream lane so every stream derived
 *  from one run seed is decorrelated from its siblings. */
function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** NaN-safe seed normalization (the clamp01(NaN) bug class): any non-finite or
 *  non-number input means "unseeded", never a poisoned PRNG state. */
function normalizeSeed(seed: unknown): number | null {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) return null;
  return Math.floor(seed) >>> 0;
}

/** THE canonical world seed (#403 review): the world every player rides by
 *  default — one shared, fixed layout, so leaderboard times compare the same
 *  obstacle field and a stored ghost's world id is stable across page loads.
 *  Changing this constant is a WORLD change (pair it with a PHYSICS_VERSION
 *  bump); per-season/server-selected worlds are the #247 follow-up. */
export const CANONICAL_WORLD_SEED = 0x5310_60D5;

let runSeed: number | null = null;
/** True when the world came from an explicit ?seed= (a PRACTICE world): freely
 *  chosen seeds must never submit to the shared leaderboard or overwrite the
 *  canonical-world records (seed-shopping). */
let practiceRun = false;
/** Per-run lane for the RUN-SCOPED gameplay streams (physics/avalanche): mixed
 *  into their derivation so canonical-world runs still vary run to run (fresh
 *  nonce each run start) while the WORLD streams (hazards/course) stay pinned
 *  to the world seed. Practice replays pin the nonce to 0 => full determinism. */
let runStreamNonce = 0;
const RUN_SCOPED_STREAMS: ReadonlySet<GameplayStreamName> = new Set(['physics', 'avalanche']);
const gameplayStreams = new Map<GameplayStreamName, () => number>();
const cosmeticStreams = new Map<CosmeticStreamName, () => number>();

// Fixed default seeds for the cosmetic streams (unseeded runs): deterministic
// per build like tree-shed's private xorshift — cosmetics don't need cross-run
// variety, they need to stay off the gameplay stream.
const COSMETIC_DEFAULT_SEED = 0x5eed_c0de;

function deriveStream(name: string, base: number): () => number {
  return mulberry32((base ^ hashName(name)) >>> 0);
}

/** (Re)derive every stream from the current seed state. Called by setRunSeed and
 *  exposed for a run RESTART: replaying the same seed must replay the same
 *  sequences from the top, not continue mid-stream. */
export function resetRunStreams(): void {
  gameplayStreams.clear();
  cosmeticStreams.clear();
}

/** Set (or clear, with null) the run seed. Non-finite input is treated as null
 *  — passthrough mode, the harness default — never as a poisoned stream. Always
 *  resets every stream, so calling it at run start makes the run replayable
 *  from the top. (The live game always runs SEEDED via setWorldContext; null
 *  passthrough exists for the `Math.random = makeRng(seed)` harnesses.) */
export function setRunSeed(seed: number | null): void {
  runSeed = normalizeSeed(seed);
  practiceRun = false;
  runStreamNonce = 0;
  resetRunStreams();
}

/** The live game's world selection (#403 review), called once by setupScene
 *  BEFORE the world build: a concrete world seed ALWAYS (canonical by default,
 *  the ?seed= override for practice), so production gameplay streams are never
 *  the global-Math.random passthrough — SFX init or any other global consumer
 *  cannot perturb gameplay, and the default world is the same for every player
 *  and every load (leaderboard comparability + a stable ghost world id). */
export function setWorldContext(worldSeed: number, practice: boolean): void {
  runSeed = normalizeSeed(worldSeed) ?? CANONICAL_WORLD_SEED;
  practiceRun = practice;
  runStreamNonce = 0;
  resetRunStreams();
}

/** True while the active world came from an explicit ?seed= (practice-only:
 *  no leaderboard submit, no canonical-record writes). */
export function isPracticeRun(): boolean {
  return practiceRun;
}

/** Rewind the streams for a NEW RUN on the current world: world streams
 *  (hazards/course) replay from the world seed; the run-scoped streams
 *  (physics/avalanche) re-derive from worldSeed^nonce. Canonical runs pass a
 *  fresh nonce for run-to-run variety on the shared world; practice replays
 *  pass 0 so the same ?seed= is a full deterministic replay. No-op-safe in
 *  harness passthrough mode (streams stay passthrough). */
export function rewindRunStreams(nonce: number): void {
  runStreamNonce = normalizeSeed(nonce) ?? 0;
  resetRunStreams();
}

/** The active run seed, or null while unseeded (today's production default). */
export function getRunSeed(): number | null {
  return runSeed;
}

/**
 * One draw from a GAMEPLAY stream. Unseeded: exactly one global Math.random()
 * call (byte-identical to the direct call it replaced — the frozen-baseline and
 * seeded-harness contract). Seeded: the stream's private deterministic PRNG.
 */
export function gameplayRandom(name: GameplayStreamName): number {
  if (runSeed === null) return Math.random();
  let stream = gameplayStreams.get(name);
  if (!stream) {
    const base = RUN_SCOPED_STREAMS.has(name) ? (runSeed ^ runStreamNonce) >>> 0 : runSeed;
    stream = deriveStream(name, base);
    gameplayStreams.set(name, stream);
  }
  return stream();
}

/**
 * One draw from a COSMETIC stream: always a private deterministic PRNG, never
 * global Math.random — regardless of seed state. Any number of cosmetic draws
 * on any render cadence leaves the global stream and every seeded gameplay
 * stream untouched.
 */
export function cosmeticRandom(name: CosmeticStreamName): number {
  let stream = cosmeticStreams.get(name);
  if (!stream) {
    stream = deriveStream(name, runSeed === null ? COSMETIC_DEFAULT_SEED : runSeed);
    cosmeticStreams.set(name, stream);
  }
  return stream();
}

/**
 * Run `fn` with every `Math.random()` inside it drawing from the named GAMEPLAY
 * stream — the world-build bridge (#400): wrapping a placement pass (trees,
 * rocks, terrain-mesh noise/bumps) in `withGameplayStream('hazards', ...)`
 * makes the ~120 legacy draw sites seed-deterministic without touching one of
 * them.
 *
 * UNSEEDED this is a pure no-op — `fn()` runs against the untouched global
 * Math.random, so today's production build and every harness that assigns
 * `Math.random = makeRng(seed)` before placement are byte-identical. SEEDED it
 * swaps global Math.random for the stream draw for the DURATION OF THE
 * SYNCHRONOUS CALL and restores it in a finally (same shape as scenery-rng's
 * withPrivateThreeRandom). `fn` must be synchronous — never hold the swap
 * across an await (the async-gap bug class).
 *
 * Determinism scope: "same seed => same world" is a cross-PAGE-LOAD contract.
 * The first build of a page also constructs the one-time material/texture pools
 * inside the stream (deterministic, since it is always the first build); a
 * hypothetical second same-process build would skip those draws — which never
 * happens live, because a tier switch reloads the page.
 */
export function withGameplayStream<T>(name: GameplayStreamName, fn: () => T): T {
  if (runSeed === null) return fn();
  const realRandom = Math.random;
  Math.random = () => gameplayRandom(name);
  try {
    return fn();
  } finally {
    Math.random = realRandom;
  }
}

/** The provenance stamp future score/ghost records carry (#400): which seed (if
 *  any) and which physics behavior produced the run. */
export function getRunStamp(): { seed: number | null; practice: boolean; nonce: number; physicsVersion: number } {
  // `nonce` completes reproducibility (Codex review PR #407 P1): two canonical
  // records share {seed, physicsVersion} but their run-scoped streams (physics
  // auto-turns, avalanche boulders) derive from worldSeed^nonce — without the
  // nonce the stamp could not reproduce the exact run that set the record.
  return { seed: runSeed, practice: practiceRun, nonce: runStreamNonce, physicsVersion: PHYSICS_VERSION };
}

/** Parse a `?seed=<uint>` run seed from a URL search string (the ranked/replay
 *  opt-in seam). Absent / empty / non-finite ⇒ null (unseeded — today's
 *  default). Kept pure so the node harnesses can cover it without a window. */
export function parseRunSeedParam(search: string): number | null {
  try {
    const raw = new URLSearchParams(search).get('seed');
    if (raw === null || raw.trim() === '') return null;
    return normalizeSeed(Number(raw));
  } catch {
    return null;
  }
}
