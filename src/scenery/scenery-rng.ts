// Deterministic RNG helpers for the background scenery system (issue #320).
//
// Two distinct concerns, kept separate on purpose:
//
//  1. PLACEMENT randomness — `makeSceneryRng(seed)` returns a self-contained,
//     seeded generator the scenery modules draw from for every layout decision
//     (ridge offsets, prop transforms, belt jitter). It NEVER reads or writes the
//     global `Math.random`, so scenery placement is reproducible per seed and
//     independent of whatever else has consumed the global stream.
//
//  2. Three.js UUID neutrality — `withPrivateThreeRandom(fn)` runs `fn` with
//     `Math.random` temporarily swapped for a private xorshift generator, then
//     restores it in a `finally`. Constructing almost any Three.js object
//     (`Group`, `Mesh`, `Material`, `BufferGeometry`, `Texture`, `clone()`, …)
//     draws `Math.random` 4× through `THREE.MathUtils.generateUUID`. Those draws
//     must NOT perturb a caller's SEEDED global stream: the Node forward-stress
//     harness seeds `Math.random` then places obstacles on one stream, and the
//     browser perf/teardown specs seed before the bundle even loads. This mirrors
//     the guard already proven in `src/mountains/trees.ts` (`getSwayDepthMaterial`
//     wraps `new MeshDepthMaterial()` in exactly this swap).
//
// Wrap every scenery Three.js construction call in `withPrivateThreeRandom`, and
// use `makeSceneryRng` for all placement math — together they keep the whole
// subsystem `Math.random`-stream-neutral (invariant #4 of the scenery plan).

/**
 * A seeded, deterministic pseudo-random generator returning values in [0, 1).
 *
 * mulberry32: a small, well-distributed 32-bit PRNG. Same `seed` ⇒ same sequence,
 * so scenery layout is byte-reproducible for a given seed and never touches the
 * global `Math.random`. Non-integer or non-finite seeds are coerced to a stable
 * 32-bit integer so callers can pass any number.
 */
export function makeSceneryRng(seed: number): () => number {
  // Coerce to a finite 32-bit seed (>>> 0) so NaN/Infinity/floats can't wedge the
  // generator into a fixed point or produce NaN outputs.
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
  return function sceneryRandom(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// Private xorshift32 stream used ONLY to feed Three.js UUID draws while
// `withPrivateThreeRandom` is active. Distinct draws ⇒ distinct uuids; seeded off a
// fixed constant so it is deterministic across runs and self-contained. It is never
// the placement RNG (that is `makeSceneryRng`). A distinct seed constant from
// trees.ts's `depthUuidRandom` keeps the two guards from ever sharing a stream.
let threeUuidRngState = 0x5f3a91c7;
function threeUuidRandom(): number {
  threeUuidRngState ^= threeUuidRngState << 13;
  threeUuidRngState ^= threeUuidRngState >>> 17;
  threeUuidRngState ^= threeUuidRngState << 5;
  return (threeUuidRngState >>> 0) / 0x100000000;
}

/**
 * Run `fn` with `Math.random` swapped for a private, deterministic generator so any
 * Three.js UUID draws inside it cannot perturb the caller's seeded global stream.
 * The original `Math.random` is always restored (even if `fn` throws), and `fn`'s
 * return value is passed straight through.
 *
 * Use this around EVERY Three.js object construction in scenery code — `Group`,
 * `Mesh`, `InstancedMesh`, `BufferGeometry`, any `Material`, `Texture`,
 * `CanvasTexture`, `.clone()`, and (later) GLTF parse/clone.
 *
 * In non-browser/Node contexts there is still a global `Math`, so the swap works
 * the same headlessly — which is exactly what the stream-neutrality tests rely on.
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
