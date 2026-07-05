// Deterministic RNG helpers for the living-world agent layer (issue #366, Roadmap Finding 5).
//
// This mirrors `src/scenery/scenery-rng.ts` exactly — two distinct concerns kept apart:
//
//  1. PLACEMENT / MOTION randomness — `makeAgentRng(seed)` returns a self-contained,
//     seeded generator agents draw from for every layout / path decision (herd centres,
//     wander radii, gaits). It NEVER reads or writes the global `Math.random`, so agent
//     layout is reproducible per seed and independent of whatever else consumed the
//     global stream.
//
//  2. Three.js UUID neutrality — `withPrivateThreeRandom(fn)` runs `fn` with
//     `Math.random` temporarily swapped for a private xorshift generator, then restores
//     it in a `finally`. Constructing almost any Three.js object draws `Math.random` 4×
//     through `THREE.MathUtils.generateUUID`; those draws must NOT perturb a caller's
//     SEEDED global stream (the Node forward-stress harness seeds `Math.random` then
//     places obstacles on one stream; the browser perf/teardown specs seed before the
//     bundle even loads). This mirrors the guard proven in `src/mountains/trees.ts`
//     (`getSwayDepthMaterial`) and `src/scenery/scenery-rng.ts`.
//
// The agent layer keeps its OWN copies of these helpers (rather than importing scenery's)
// so the two subsystems stay independent peers, and — crucially — the private xorshift
// here is seeded off a DISTINCT constant from scenery's and trees', so the guards can
// never share a stream.

/**
 * A seeded, deterministic pseudo-random generator returning values in [0, 1).
 *
 * mulberry32: a small, well-distributed 32-bit PRNG. Same `seed` ⇒ same sequence, so
 * agent layout is byte-reproducible for a given seed and never touches the global
 * `Math.random`. Non-integer / non-finite seeds are coerced to a stable 32-bit integer
 * so callers can pass any number.
 */
export function makeAgentRng(seed: number): () => number {
  // Coerce to a finite 32-bit seed (>>> 0) so NaN/Infinity/floats can't wedge the
  // generator into a fixed point or produce NaN outputs.
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
  return function agentRandom(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// Private xorshift32 stream used ONLY to feed Three.js UUID draws while
// `withPrivateThreeRandom` is active. Seeded off a fixed constant DISTINCT from
// scenery-rng's (0x5f3a91c7) and trees.ts's `depthUuidRandom`, so no two guards ever
// share a stream. It is never the placement RNG (that is `makeAgentRng`).
let threeUuidRngState = 0x27d4eb2f;
function threeUuidRandom(): number {
  threeUuidRngState ^= threeUuidRngState << 13;
  threeUuidRngState ^= threeUuidRngState >>> 17;
  threeUuidRngState ^= threeUuidRngState << 5;
  return (threeUuidRngState >>> 0) / 0x100000000;
}

/**
 * Run `fn` with `Math.random` swapped for a private, deterministic generator so any
 * Three.js UUID draws inside it cannot perturb the caller's seeded global stream. The
 * original `Math.random` is always restored (even if `fn` throws), and `fn`'s return
 * value is passed straight through.
 *
 * Use this around EVERY Three.js object construction in agent code — `Group`, `Mesh`,
 * `InstancedMesh`, `BufferGeometry`, any `Material`, `.clone()`, etc.
 *
 * In non-browser/Node contexts there is still a global `Math`, so the swap works the
 * same headlessly — which is exactly what the stream-neutrality tests rely on.
 */
export function withPrivateThreeRandom<T>(fn: () => T): T {
  const savedRandom = Math.random;
  Math.random = threeUuidRandom;
  try {
    return fn();
  } finally {
    Math.random = savedRandom;
  }
}
