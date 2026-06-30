// wind.ts — a single shared, deterministic wind field for the whole scene (issue #253).
//
// Until now "wind" was faked per-subsystem: the sfx.ts ambient bed is purely
// speed-scaled (no direction, no gusts) and the #172 scarf "swings in the wind" via a
// fixed sine + turn-lag. This module is the one source of truth: a time-varying
// horizontal wind vector that snow drift, the scarf/snowman, tree sway, and the audio
// bed all read from (the consumers land in follow-up PRs; this PR is just the field +
// wiring + tests).
//
// DESIGN CONSTRAINTS (mirroring intro.ts / sfx.ts / snowman-flex.ts):
//   - **Cosmetic only.** Nothing here touches pos/velocity. The grounded no-input
//     physics stays byte-identical to the frozen snowman_baseline (see docs/PHYSICS.md
//     §6) — a wind *force* on the player is a deliberate, separate follow-up.
//   - **Deterministic.** The field is a PURE function of an internal clock (a seeded
//     sum-of-sines), with NO Math.random() and NO Date.now(), so a given (seed, t)
//     always yields the same vector. That keeps screenshots reproducible and lets the
//     physics-invariant harness inject a fixed wind if the force follow-up ever lands.
//   - **Headless-testable.** No three.js and no DOM import: the math lives in the pure
//     exported `windFieldAt(t, cfg)` so it unit-tests in plain Node.
//   - **Reduced-motion / automation gating lives in the CONSUMERS**, not here — exactly
//     like Flex checks prefers-reduced-motion itself. This module stays a pure field so
//     the audio bed can still read a (gentle) wind even when visible motion is damped.

/** Horizontal wind sample. `x`/`z` are the world-space vector (units/s-equivalent);
 *  `dirX`/`dirZ` is its unit direction; `magnitude` is |vector|; `strength` and `gust`
 *  are both normalized to 0..1 for easy consumer mapping. */
export interface WindSample {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  magnitude: number;
  strength: number; // 0..1: magnitude / (base + gustRange)
  gust: number;     // 0..1: the instantaneous gust factor
}

/** Tunable shape of the field. A difficulty tier (or a debug flag) can swap these via
 *  {@link WindModule.configure} — e.g. a calm Bunny vs. a gusty Black run. */
export interface WindConfig {
  /** Steady wind magnitude (world units/s-equivalent) before gusts. */
  baseStrength: number;
  /** Additional magnitude a full gust adds on top of {@link baseStrength}. */
  gustRange: number;
  /** Prevailing direction angle (radians) in the x–z plane: 0 = +x (cross-slope). */
  prevailingAngle: number;
  /** How far (radians) the direction wanders either side of {@link prevailingAngle}. */
  dirWander: number;
  /** Rate (rad/s) of the slow prevailing-direction drift. */
  dirDriftRate: number;
  /** Base rate (rad/s) of the gust oscillation. */
  gustRate: number;
  /** Phase seed so two runs (or two configs) can desync deterministically. */
  seed: number;
}

/** Default field: a moderate cross-slope breeze with slow, layered gusts. Sized so the
 *  magnitude sits around the low single digits — enough to slant the snowfall and trail
 *  the scarf without looking like a storm. */
export const DEFAULT_WIND_CONFIG: WindConfig = {
  baseStrength: 2.4,
  gustRange: 4.8,
  prevailingAngle: 0.35, // mostly +x (cross-slope) with a slight +z bias
  dirWander: 0.45,
  dirDriftRate: 0.06,
  gustRate: 0.7,
  seed: 0,
};

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const finite = (n: number): number => (Number.isFinite(n) ? n : 0);

/** Deterministic gust factor in [0,1]: a layered sum of sines (cheap pseudo-noise). The
 *  three octaves' amplitudes sum to 1, so `0.5 + 0.5*sum` stays in [0,1] for all t. */
function gustAt(t: number, cfg: WindConfig): number {
  const s = cfg.seed;
  const r = cfg.gustRate;
  const sum =
    0.6 * Math.sin(t * r + s) +
    0.3 * Math.sin(t * r * 2.7 + s * 1.3 + 1.1) +
    0.1 * Math.sin(t * r * 5.3 + s * 2.1 + 2.7);
  return clamp(0.5 + 0.5 * sum, 0, 1);
}

/** The pure field: sample the wind at clock time `t` (seconds) for a given config. No
 *  internal state — same inputs, same output — so it is trivially unit-testable. */
export function windFieldAt(t: number, cfg: WindConfig = DEFAULT_WIND_CONFIG): WindSample {
  t = finite(t);
  const base = Math.max(0, finite(cfg.baseStrength));
  const range = Math.max(0, finite(cfg.gustRange));

  const gust = gustAt(t, cfg);
  const magnitude = base + range * gust;

  // Direction wanders slowly around the prevailing angle (slower than the gusts, so the
  // breeze swings lazily while its strength pulses).
  const angle = cfg.prevailingAngle + cfg.dirWander * Math.sin(t * cfg.dirDriftRate + cfg.seed * 0.7);
  const dirX = Math.cos(angle);
  const dirZ = Math.sin(angle);

  const span = base + range;
  return {
    x: dirX * magnitude,
    z: dirZ * magnitude,
    dirX,
    dirZ,
    magnitude,
    strength: span > 0 ? clamp(magnitude / span, 0, 1) : 0,
    gust,
  };
}

// --- Stateful singleton: the live game's clock-advanced wind ---------------------
// The game advances ONE shared clock (`Wind.update(dt)` once per render frame) and every
// consumer reads the cached sample, so they all agree on the same gust at the same instant.
let config: WindConfig = { ...DEFAULT_WIND_CONFIG };
let clock = 0;
let current: WindSample = windFieldAt(0, config);

/** Advance the wind clock and recompute the cached sample. Cheap (a few sines); safe to
 *  call every frame. `dt` is the real render-frame delta. */
function update(dt: number): void {
  clock += Math.max(0, finite(dt));
  current = windFieldAt(clock, config);
}

/** The current horizontal wind vector {x, z} (world units/s-equivalent). */
function vector(): { x: number; z: number } {
  return { x: current.x, z: current.z };
}

/** The current unit wind direction {x, z}. */
function dir(): { x: number; z: number } {
  return { x: current.dirX, z: current.dirZ };
}

/** Current normalized strength 0..1 (base + gust over the full span). */
function strength(): number {
  return current.strength;
}

/** Current instantaneous gust factor 0..1. */
function gust(): number {
  return current.gust;
}

/** The full current sample (vector + direction + normalized scalars). */
function sample(): WindSample {
  return current;
}

/** Merge in a partial config (e.g. a difficulty tier's wind profile) and recompute the
 *  cached sample at the current clock so the change takes effect immediately. */
function configure(partial: Partial<WindConfig>): void {
  config = { ...config, ...partial };
  current = windFieldAt(clock, config);
}

/** Reset the clock to 0 (called on every run reset, like Flex.reset) so each run starts
 *  from the same deterministic point in the gust cycle. */
function reset(): void {
  clock = 0;
  current = windFieldAt(clock, config);
}

export const Wind = {
  update,
  vector,
  dir,
  strength,
  gust,
  sample,
  configure,
  reset,
};
