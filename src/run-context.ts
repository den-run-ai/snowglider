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

let runSeed: number | null = null;
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
 *  — an unseeded run — never as a poisoned stream. Always resets every stream,
 *  so calling it at run start makes the run replayable from the top. */
export function setRunSeed(seed: number | null): void {
  runSeed = normalizeSeed(seed);
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
    stream = deriveStream(name, runSeed);
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
