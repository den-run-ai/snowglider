// Snowman physics kernel: reset + per-frame movement integration.
import * as THREE from 'three';

import { BLUE_PHYSICS_TUNING, type SnowmanPhysicsTuning } from '../difficulty.js';
import type {
  CameraManagerLike,
  LandingQuality,
  PlanarVelocity,
  PlayerPos,
  SkiTechnique,
  SnowmanControls,
  TerrainHeightFn,
  TerrainVecFn,
  UpdateResult
} from './index.js';

// --- Manual-jump landing grade (meaningful jumps #47, §3.2/§3.3) -------------
// Tunables, mirrored in PHYSICS.md §10. A *manual* jump's landing is graded by
// `alignment`, the cosine between the horizontal heading and the fall line at
// touchdown (1 = skis pointing straight down the line). Everything here is gated
// behind playerJump provenance, so auto-jump / hop / coasting paths never see it.
// Exported so the plausibility-floor harness (tests/verification/plausibility_floor_harness.js)
// derives the jump-boost bounds it measures against from this single source instead of
// copying the literals — exporting is otherwise inert (no behaviour change).
export const LANDING_CLEAN_ALIGN = 0.85;   // alignment above this = CLEAN (boost)
const LANDING_OK_ALIGN = 0.55;      // CLEAN..this = OK (neutral); below = SKETCHY (scrub)
export const JUMP_BOOST_PER_SEC = 0.04;    // CLEAN forward impulse fraction per second aloft...
export const JUMP_BOOST_CAP = 0.06;        // ...hard-capped so jump-spam can't trivialise the course
const AIR_SCORE_PER_SEC = 100;      // air-score points per second aloft
const AIR_SCORE_CLEAN_BONUS = 50;   // extra points for sticking a CLEAN landing

// --- Impact-consistent landing grade (workstream C / JP-4; MEANINGFUL_JUMPS §8.3) --
// Real landing harshness is the velocity component INTO the landing surface, not
// just how the skis are aimed: touching down on a downslope transition is soft
// (the surface falls away with you) while flatting out from big air is harsh, even
// perfectly aligned. `vImpact = |v³ · n|` — the 3D velocity (vx, verticalVelocity,
// vz) against the surface normal n = normalize(-∇x, 1, -∇z) at the landing point.
// Gated on playerJump provenance like the rest of the grade, so auto-jump / hop /
// coasting landings never compute it. Thresholds are calibrated to MEASURED
// touchdown impacts (probe over speeds 8–25 on the harness hill + constant
// 9°/18°/30° slopes): a plain full-power straight jump lands at vImpact ≈ 15–28,
// so the soft line sits above the everyday band's bulk (ordinary stomps keep the
// #186 CLEAN boost), harsh starts past anything a plain downhill jump reaches
// (flat-outs and kicker-scale air get there), and wipeout is the extreme tail.
// Locked by the harness's landing-monotonicity + wipeout-gate checks; mirrored in
// PHYSICS.md §4.2/§10.
export const LAND_SOFT_NORMAL = 24;    // m/s into the surface; CLEAN additionally requires < this
export const LAND_HARSH_NORMAL = 30;   // above this the landing is forced SKETCHY (deeper scrub)
export const LAND_WIPEOUT_NORMAL = 34; // above this (tuning.wipeouts only) the landing is a crash
export const WIPEOUT_FLIP_RESIDUAL_DEG = 120; // landing this far into a somersault (tuning.wipeouts) crashes
const HARSH_SCRUB_FACTOR = 1.5;        // a harsh (forced-SKETCHY) landing scrubs 1.5× the base impact

// --- Scored obstacle clears (jump-system completion JP-2, #245 items 1) ------
// A *manual* jump that sails over a tree/rock the run would otherwise have hit
// banks CLEAR_SCORE per obstacle, capped per air phase so a single huge jump over
// dense forest can't print unbounded points. Provenance-gated on playerJump (an
// auto-jump/hop clear banks nothing), deduped per obstacle (one pass over a tree
// spans many overlap frames = ONE clear). Detection lives in collision.ts
// (ObstacleClear); the policy — provenance, dedup, cap, banking — is applied in
// index.ts updateSnowman. Exported for the harness/tests; mirrored in PHYSICS.md §10.
export const CLEAR_SCORE = 75;      // air-score points banked per cleared obstacle
export const CLEAR_MAX_PER_AIR = 3; // max scored clears in one air phase

// --- Freestyle tricks (#32, Expert tier only) --------------------------------
// The in-air trick vocabulary for a *manual* jump on a tier whose ski tuning sets
// `freestyleTricks` (the ◆◆ Expert tier): steering Left/Right spins (yaw), Up/Down
// flips (front/back somersault), and re-pressing Jump mid-air holds a grab. All of
// it is double-gated — playerJump provenance AND tuning.freestyleTricks — so every
// other tier, and every auto-jump / hop / coasting air phase, stays byte-identical
// to today (the §5 no-input invariant). Tricks never touch pos/velocity in the air
// (the existing airControl nudge is unchanged; the rotation itself is cosmetic and
// applied in pose.ts from the userData accumulators). Their one physics consequence
// is at touchdown: landing mid-rotation (under-rotated) spoils the landing — forced
// SKETCHY, today's scrub — no matter how well the skis are aimed, which is the
// freestyle risk/reward. Constants are exported for the headless trick tests.
export const SPIN_RATE_DEG = 360;        // deg/s of yaw while steering in the air
export const FLIP_RATE_DEG = 300;        // deg/s of pitch while holding Up/Down
export const SPIN_SCORE_PER_180 = 40;    // air-score points per completed half spin
export const FLIP_SCORE_PER_360 = 120;   // air-score points per completed somersault
export const GRAB_SCORE_PER_SEC = 60;    // air-score points per second of held grab
export const GRAB_MIN_HOLD = 0.25;       // s a grab must be held before it counts
export const SPIN_LAND_TOL_DEG = 60;     // residual yaw to the nearest 180° that still rides away
export const FLIP_LAND_TOL_DEG = 75;     // residual pitch to the nearest 360° that still rides away
const TRICK_UNDER_ROTATED_FACTOR = 0.5;  // an under-rotated trick pays half score

/** The settled outcome of one air phase's tricks, computed at touchdown. */
export interface TrickGrade {
  /** Toast label, e.g. "360", "BACKFLIP + GRAB", "540 + DOUBLE FRONTFLIP"; null when
   *  no trick component completed (a plain jump keeps its plain toast). */
  name: string | null;
  /** Trick points added to this landing's airScoreDelta (already halved if under-rotated). */
  score: number;
  /** Landed mid-rotation: the landing is spoiled (forced SKETCHY) regardless of aim. */
  underRotated: boolean;
}

/** Residual angle (deg) from `deg` to the nearest multiple of `period`. */
function residualToNearest(deg: number, period: number): number {
  const a = Math.abs(deg) % period;
  return Math.min(a, period - a);
}

/**
 * Grade one air phase's accumulated tricks. Pure — exported so the freestyle tests
 * pin the naming/scoring/under-rotation table without stepping the kernel. A spin is
 * credited per completed 180° (landing switch is a trick); a flip only per completed
 * 360° (anything else is not feet-down); a grab needs GRAB_MIN_HOLD of held Jump.
 * Credit counts increments actually reached (within the landing tolerance — a 350°
 * spin credits the 360) but never rounds a half-finished rotation up: landing
 * sideways at 90° credits nothing AND flags under-rotated.
 */
export function gradeFreestyleTrick(spinDeg: number, flipDeg: number, grabTime: number): TrickGrade {
  const spinHalves = Math.floor((Math.abs(spinDeg) + SPIN_LAND_TOL_DEG) / 180);
  const flips = Math.floor((Math.abs(flipDeg) + FLIP_LAND_TOL_DEG) / 360);
  const underRotated = residualToNearest(spinDeg, 180) > SPIN_LAND_TOL_DEG
    || residualToNearest(flipDeg, 360) > FLIP_LAND_TOL_DEG;
  const grabbed = grabTime >= GRAB_MIN_HOLD;

  const parts: string[] = [];
  if (spinHalves >= 1) parts.push(String(spinHalves * 180));
  if (flips >= 1) {
    const flipName = flipDeg > 0 ? 'FRONTFLIP' : 'BACKFLIP';
    parts.push(flips === 1 ? flipName : flips === 2 ? `DOUBLE ${flipName}` : `${flips}x ${flipName}`);
  }
  if (grabbed) parts.push('GRAB');

  let score = spinHalves * SPIN_SCORE_PER_180
    + flips * FLIP_SCORE_PER_360
    + (grabbed ? grabTime * GRAB_SCORE_PER_SEC : 0);
  if (underRotated) score *= TRICK_UNDER_ROTATED_FACTOR;

  return { name: parts.length ? parts.join(' + ') : null, score: Math.round(score), underRotated };
}

export interface SnowmanPhysicsStepOutput {
  terrainHeightAtPosition: number;
  result: UpdateResult;
}

// Reset the snowman to initial position
export function resetSnowman(
  snowman: THREE.Object3D,
  pos: PlayerPos,
  velocity: PlanarVelocity,
  getTerrainHeight: TerrainHeightFn,
  cameraManager: CameraManagerLike
): number {
  // Start higher up the mountain (z=-20 instead of -40 for a longer run)
  // With extended terrain, we can start even higher up at z=-15
  pos.x = 0;
  pos.z = -15;
  pos.y = getTerrainHeight(0, -15);
  
  // Smoother initial velocity - reduce the starting velocity to avoid the initial jolt
  velocity.x = 0;
  velocity.z = -3.0;
  
  // Reset user data for smooth motion if it exists
  if (snowman.userData) {
    snowman.userData.targetRotationY = Math.PI; // Default facing downhill
    snowman.userData.currentRotX = 0;
    snowman.userData.currentRotZ = 0;
    // Clear edge-engagement state so a new run starts with no locked carve.
    snowman.userData.carveCharge = 0;
    snowman.userData.lastSteerDir = 0;
    // Clear the snowplow wedge depth so a new run starts with no charged brake.
    snowman.userData.plowCharge = 0;
    // Clear jump provenance so a new run never inherits a stale "this air phase was
    // a deliberate jump" flag from the previous run (meaningful jumps #47, §3.1).
    snowman.userData.playerJump = false;
    // Clear the freestyle trick slate (#32) so a new run never inherits a mid-air
    // rotation or an armed grab from the previous run. trickCameraYaw is the pose
    // layer's camera-heading correction for the spin (incl. its post-landing
    // ease-out), cleared with the rest so a fresh run's camera starts uncorrected.
    snowman.userData.trickSpin = 0;
    snowman.userData.trickFlip = 0;
    snowman.userData.trickGrabTime = 0;
    snowman.userData.trickGrabArmed = false;
    snowman.userData.trickGrabbing = false;
    snowman.userData.trickCameraYaw = 0;
    // Clear the scored-obstacle-clear slate (JP-2) so a new run never inherits a
    // previous air phase's dedup set or count.
    snowman.userData.clearsThisAir = 0;
    snowman.userData.clearedObstacles = {};
  }
  
  // Force all rotations to be explicit - avoid any chance of NaN or unexpected values
  snowman.position.set(pos.x, pos.y, pos.z);
  snowman.rotation.set(0, Math.PI, 0);
  
  // Explicitly reset the rotation tracking for snowman tilt
  snowman.rotation.x = 0;
  snowman.rotation.z = 0;
  
  // Reset camera using the camera manager
  cameraManager.initialize(snowman.position, snowman.rotation);
  
  return getTerrainHeight(0, -15); // Return the terrain height for lastTerrainHeight
}

export function stepSnowmanPhysics(
  snowman: THREE.Object3D,
  delta: number,
  pos: PlayerPos,
  velocity: PlanarVelocity,
  isInAir: boolean,
  verticalVelocity: number,
  lastTerrainHeight: number,
  airTime: number,
  jumpCooldown: number,
  controls: SnowmanControls,
  turnPhase: number,
  currentTurnDirection: number,
  turnChangeCooldown: number,
  turnAmplitude: number,
  getTerrainHeight: TerrainHeightFn,
  getTerrainGradient: TerrainVecFn,
  getDownhillDirection: TerrainVecFn,
  // Difficulty tuning: defaults to the shipped Blue constants so every existing
  // caller (and the physics-invariant harness, which passes no tuning) is
  // byte-for-byte unchanged. A tier passes its own `config.ski` to vary the feel.
  tuning: SnowmanPhysicsTuning = BLUE_PHYSICS_TUNING
): SnowmanPhysicsStepOutput {
  // --- Frame-rate-independent drag (issue: "floor it forward and blow past the
  // obstacles") ----------------------------------------------------------------
  // The coasting/cruising drag below is a *per-frame* multiplier (velocity *= 1-k).
  // The driving forces (gravity, accelerate, turn) are all scaled by `delta`, so as
  // the frame time grows the forces keep up but a fixed per-frame drag does NOT —
  // it is applied fewer times per second. That made terminal speed scale inversely
  // with frame rate: ~8 m/s at 60 FPS but ~32 m/s at 10 FPS (the capped 0.1 s delta),
  // which on a slow/mobile device lets a player just hold Up and rocket straight
  // down the fall line, fast enough to slip between (and at the worst frame times
  // tunnel through) the trees without ever steering.
  //
  // Fix: treat each `1-k` as a 60 Hz per-frame factor and raise it to the number of
  // 60 Hz frames this delta represents, so the drag integrates to the same amount of
  // speed lost per *second* at any frame rate. `dragFactor(k)` is byte-identical at
  // the 60 Hz baseline — delta*60 == 1 exactly when delta === 1/60, and
  // Math.pow(x, 1) === x — so the physics-invariant harness (which steps at 1/60)
  // stays bit-for-bit unchanged; only off-60 Hz frames are corrected.
  const FRICTION_REF_HZ = 60;
  const dragFrames = delta * FRICTION_REF_HZ;
  const dragFactor = (k: number): number => Math.pow(1 - k, dragFrames);

  // Update jump cooldown
  if (jumpCooldown > 0) {
    jumpCooldown -= delta;
  }

  // Outer-scope outputs surfaced in the return value (HUD + camera juice).
  let technique: SkiTechnique = isInAir ? 'air' : 'glide';
  let justLanded = false;
  let landingForce = 0;
  // Meaningful jumps (#47): graded only when a *manual* jump lands this frame.
  let landingQuality: LandingQuality | null = null;
  let airScoreDelta = 0;
  // Freestyle (#32): non-null only when a manual jump lands with a completed trick.
  let trickName: string | null = null;
  
  // Get current terrain height at position
  const terrainHeightAtPosition = getTerrainHeight(pos.x, pos.z);
  
  // Check for landing
  if (isInAir && pos.y <= terrainHeightAtPosition) {
    isInAir = false;
    pos.y = terrainHeightAtPosition;
    justLanded = true;

    // Consume the takeoff provenance: read who launched this air phase, then clear
    // it so the grounded / between-jumps state reads as non-rewarding (#47, §3.1).
    const wasPlayerJump = !!(snowman.userData && snowman.userData.playerJump);
    if (snowman.userData) snowman.userData.playerJump = false;

    // Landing impact based on air time and height (the original always-on scrub).
    const landingImpact = Math.min(0.5, airTime * 0.15);
    landingForce = airTime; // seconds aloft; used for camera shake on touchdown

    if (wasPlayerJump) {
      // Grade a *manual* jump's landing from how well the horizontal heading lines
      // up with the fall line at the landing point — skis pointing the way you're
      // travelling = a clean stomp (§3.2). This whole branch is gated on the
      // playerJump flag, so auto-jump / hop / coasting landings (below) are
      // byte-identical to today and the no-input invariant holds (§5).
      const landSpeed = Math.sqrt(velocity.x*velocity.x + velocity.z*velocity.z);
      const landDir = getDownhillDirection(pos.x, pos.z); // unit downhill
      const alignment = landSpeed > 1e-3
        ? (velocity.x*landDir.x + velocity.z*landDir.z) / landSpeed
        : 1;

      // Impact against the landing surface (JP-4, §4.2): the normal component of
      // the full 3D touchdown velocity. verticalVelocity still holds the fall speed
      // here (it is zeroed below), so a downslope landing (surface falling away
      // along the travel direction) reads soft and a flat-out from big air harsh.
      const landGrad = getTerrainGradient(pos.x, pos.z);
      const nInvLen = 1 / Math.sqrt(landGrad.x*landGrad.x + 1 + landGrad.z*landGrad.z);
      const vImpact = Math.abs(
        (-velocity.x*landGrad.x + verticalVelocity - velocity.z*landGrad.z) * nInvLen
      );

      // Freestyle (#32): settle this air phase's tricks. On a non-freestyle tier the
      // accumulators were never written, so the grade is the zero grade (no name, no
      // score, not under-rotated) and everything below reduces to the #47 behaviour.
      const ud = snowman.userData;
      const trick = gradeFreestyleTrick(
        (ud && (ud.trickSpin as number)) || 0,
        (ud && (ud.trickFlip as number)) || 0,
        (ud && (ud.trickGrabTime as number)) || 0
      );
      trickName = trick.name;

      // Wipeout (JP-4, tuning.wipeouts — Expert only): an extreme landing crashes
      // instead of scrubbing. Two ways in: slamming the surface (vImpact past the
      // wipeout threshold) or landing mid-SOMERSAULT — the flip residual is the only
      // rotation that can exceed 120° (spin residual maxes at 90° to the nearest
      // 180°), i.e. coming down head-first. The run ends via the crash path in
      // updateSnowman (showGameOver → #171 shatter); the kernel just grades it.
      const flipResidual = residualToNearest((ud && (ud.trickFlip as number)) || 0, 360);
      if (tuning.wipeouts
          && (vImpact > LAND_WIPEOUT_NORMAL || flipResidual > WIPEOUT_FLIP_RESIDUAL_DEG)) {
        landingQuality = 'wipeout';
        // No reward on a crash landing (airScoreDelta stays 0); heavier camera hit.
        landingForce = airTime * 1.5;
        velocity.x *= (1 - landingImpact);
        velocity.z *= (1 - landingImpact);
      } else if (alignment > LANDING_CLEAN_ALIGN && !trick.underRotated
          && vImpact < LAND_SOFT_NORMAL) {
        // CLEAN: replace the scrub with a small, capped forward impulse along the
        // current heading — a well-timed, well-aimed jump becomes a speed tool (§3.3).
        // JP-4: a clean stomp now also has to be SOFT (vImpact under the soft
        // threshold) — aim alone no longer earns the boost off a flat slam.
        landingQuality = 'clean';
        const boost = Math.min(JUMP_BOOST_CAP, airTime * JUMP_BOOST_PER_SEC);
        velocity.x *= (1 + boost);
        velocity.z *= (1 + boost);
      } else if (alignment > LANDING_OK_ALIGN && !trick.underRotated
          && vImpact <= LAND_HARSH_NORMAL) {
        // OK: neither punished nor rewarded — keep your speed, no boost.
        landingQuality = 'ok';
      } else {
        // SKETCHY: badly crossed up, landed mid-rotation on a trick (#32), or came
        // down too hard (JP-4: vImpact past the harsh threshold forces SKETCHY with
        // a deeper scrub — landing harshness is physical, not just aim).
        landingQuality = 'sketchy';
        const harsh = vImpact > LAND_HARSH_NORMAL;
        const scrub = harsh
          ? Math.min(0.5, landingImpact * HARSH_SCRUB_FACTOR)
          : landingImpact;
        if (harsh) landingForce = airTime * 1.5; // stronger touchdown shake
        velocity.x *= (1 - scrub);
        velocity.z *= (1 - scrub);
      }

      // Air score for this jump: time aloft plus a clean-stomp bonus plus any trick
      // points (0 on non-freestyle tiers; already halved if under-rotated). Never
      // negative — and a wipeout banks NOTHING (the landing is a crash, not a score).
      airScoreDelta = landingQuality === 'wipeout' ? 0
        : Math.max(0, Math.round(airTime * AIR_SCORE_PER_SEC
          + (landingQuality === 'clean' ? AIR_SCORE_CLEAN_BONUS : 0)
          + trick.score));

      // Consume the trick state with the landing (mirrors the playerJump lifecycle):
      // the grounded / between-jumps state must never carry a stale rotation.
      if (ud) {
        ud.trickSpin = 0;
        ud.trickFlip = 0;
        ud.trickGrabTime = 0;
        ud.trickGrabArmed = false;
        ud.trickGrabbing = false;
        // Consume the clear slate too (JP-2) — belt-and-suspenders with the fresh
        // slate stamped at the next manual takeoff.
        ud.clearsThisAir = 0;
        ud.clearedObstacles = {};
      }
    } else {
      // Auto-jump (terrain lip) or hop-turn landing: unchanged from today. This is
      // the no-input / coasting path the physics-invariant harness pins, so the
      // scrub must stay exactly Math.min(0.5, airTime*0.15).
      velocity.x *= (1 - landingImpact);
      velocity.z *= (1 - landingImpact);
    }

    // Reset jump-related variables
    verticalVelocity = 0;
    airTime = 0;
    jumpCooldown = 0.3; // Short cooldown after landing
  }
  
  // Calculate the downhill direction
  const dir = getDownhillDirection(pos.x, pos.z);
  
  // Get gradient for physics calculations
  const gradient = getTerrainGradient(pos.x, pos.z);
  const steepness = Math.sqrt(gradient.x*gradient.x + gradient.z*gradient.z);
  
  // Detect natural jumps from terrain (like going over moguls)
  const heightDifference = terrainHeightAtPosition - lastTerrainHeight;
  const currentSpeed = Math.sqrt(velocity.x*velocity.x + velocity.z*velocity.z);
  const movingFast = currentSpeed > 12;
  
  // Auto-jump when going downhill after a steep uphill section.
  // Skipped while the player is holding Jump so a deliberate jump input wins over
  // the terrain auto-jump on a combined lip+jump frame (#47, §3.1 takeoff precedence):
  // because the manual / hop branch below is gated on `!isInAir`, an auto-jump that
  // fired here first would otherwise swallow the press and stamp it as a non-player
  // jump. The extra `!controls.jump` term is a no-op on every no-input / coasting
  // frame, so the frozen baseline and all plain auto-jumps stay byte-identical.
  // Per-tier availability (workstream A): `tuning.autoJump` is TRUE on the Blue
  // default, so this extra term is also a no-op for the frozen baseline; Bunny sets
  // it false so lips never loft and the grounded `pos.y = terrain` glues the run.
  if (!isInAir && tuning.autoJump && !controls.jump && heightDifference < -0.8 && movingFast && jumpCooldown <= 0) {
    verticalVelocity = 6 + (currentSpeed * 0.3);
    isInAir = true;
    // Terrain auto-jump is never player-initiated — stamp provenance false so its
    // landing keeps today's scrub and the no-input baseline never moves (§3.1).
    if (snowman.userData) snowman.userData.playerJump = false;
  }
  
  // Manual jump / hop turn with spacebar or touch (grounded, off cooldown).
  // Plain Jump = a straight pop into the air. Jump WHILE steering Left/Right = a
  // hop turn (issue #48): a quick edge-set pivot that snaps the heading toward the
  // steer direction and scrubs speed — the steep-terrain "hop the skis around and
  // set them down pointing the new way" move. It trades speed (HOP_SPEED_KEEP < 1)
  // for a sharper direction change than carving can give, and lands you on a fresh
  // edge committed to the new direction (carveCharge reset, lastSteerDir set). It
  // is fully gated behind explicit jump+steer input, so the no-input invariant and
  // every plain-steering harness check are untouched.
  // Per-tier availability (workstream A): the whole jump VERB — straight pop and
  // hop turn alike — rides `tuning.manualJump` (true on the Blue default, so every
  // existing caller is unchanged; false on Bunny, where Space/touch does nothing).
  if (tuning.manualJump && controls.jump && !isInAir && jumpCooldown <= 0) {
    const hopSteer = (controls.left ? -1 : 0) + (controls.right ? 1 : 0);
    if (hopSteer !== 0) {
      const HOP_PIVOT_ANGLE = 0.4; // rad (~23°) the velocity heading snaps per hop
      const HOP_SPEED_KEEP = 0.82; // a hop turn scrubs ~18% of horizontal speed
      const HOP_POP = 5.0;         // small vertical pop, well below a full jump
      const HOP_COOLDOWN = 0.45;   // s; prevents hop spam
      // Rotate the horizontal velocity toward the steer direction (right => +x).
      const theta = hopSteer * HOP_PIVOT_ANGLE;
      const c = Math.cos(theta), s = Math.sin(theta);
      const nvx = velocity.x * c - velocity.z * s;
      const nvz = velocity.x * s + velocity.z * c;
      velocity.x = nvx * HOP_SPEED_KEEP;
      velocity.z = nvz * HOP_SPEED_KEEP;
      verticalVelocity = HOP_POP;
      isInAir = true;
      jumpCooldown = HOP_COOLDOWN;
      // Land on a fresh edge committed to the new direction.
      if (snowman.userData) {
        snowman.userData.carveCharge = 0;
        snowman.userData.lastSteerDir = hopSteer;
        // A hop turn is a steering move, not a straight jump — it earns no jump
        // reward, so its landing keeps today's scrub (§3.1).
        snowman.userData.playerJump = false;
      }
      technique = 'hop';
    } else {
      verticalVelocity = 10 + (currentSpeed * 0.5);
      isInAir = true;
      jumpCooldown = 0.5; // Prevent jump spam
      // Deliberate straight jump: mark this air phase player-initiated so the landing
      // can grade it and award the clean-landing boost / air score (§3.1).
      if (snowman.userData) {
        snowman.userData.playerJump = true;
        // Freestyle (#32): a fresh trick slate for this air phase. The grab is DISARMED
        // until the (still held) Jump key is released mid-air, so the takeoff press can
        // never read as a grab. Input-gated (controls.jump), so coasting never runs this.
        snowman.userData.trickSpin = 0;
        snowman.userData.trickFlip = 0;
        snowman.userData.trickGrabTime = 0;
        snowman.userData.trickGrabArmed = false;
        snowman.userData.trickGrabbing = false;
        // Scored clears (JP-2): a fresh dedup slate for this air phase, so the cap and
        // the per-obstacle dedup are per-jump, not per-run.
        snowman.userData.clearsThisAir = 0;
        snowman.userData.clearedObstacles = {};
      }
    }
  }

  // --- Snowplow wedge depth: stop vs. slow-down, and steep-slope failure -----
  // `plowCharge` (0..1) is a hold ramp (mirroring carveCharge): tapping Brake forms a
  // shallow wedge that only trims speed, while holding it deepens into a full wedge
  // that can stop you — on moderate terrain. It is driven by `controls.down` EVERY
  // frame (incl. airborne) so the tap-vs-hold contract survives a jump: releasing Brake
  // in the air relaxes the wedge for the landing, and holding it pre-builds the charge.
  // The actual braking is still applied only while grounded (see the brake block
  // below, gated on `snowplow = down && !isInAir`). It is read/written every frame but
  // only ever alters velocity under a grounded Brake, so the no-input coasting path
  // stays byte-identical to the frozen baseline; resetSnowman clears it between runs.
  const PLOW_BUILD_RATE = 1.6;    // ~0.6s of holding Brake to reach a full wedge
  const PLOW_RELEASE_RATE = 4.0;  // wedge relaxes quickly once you ease off Brake
  {
    const ud = snowman.userData || (snowman.userData = {});
    const charge = ud.plowCharge || 0;
    ud.plowCharge = controls.down
      ? Math.min(1, charge + delta * PLOW_BUILD_RATE)
      : Math.max(0, charge - delta * PLOW_RELEASE_RATE);
  }

  // Update vertical position and velocity when in air
  if (isInAir) {
    // Track time in air
    airTime += delta;
    
    // Apply gravity to vertical velocity
    verticalVelocity -= tuning.airGravity * delta;

    // Update vertical position
    pos.y += verticalVelocity * delta;

    // Air control
    if (controls.left) {
      velocity.x -= tuning.airControl * delta;
    }
    if (controls.right) {
      velocity.x += tuning.airControl * delta;
    }

    // Freestyle tricks (#32): spin / flip / grab accumulate ONLY in a player-initiated
    // air phase on a freestyle tier (◆◆ Expert). Left/Right yaw the body (on top of the
    // unchanged airControl drift above), Up/Down somersault it, and re-pressing Jump —
    // it must be RELEASED after the takeoff press first — holds a grab. Pure userData
    // accumulator writes: pos/velocity are never touched here, so the coasting baseline
    // and every non-freestyle tier stay byte-identical; the rotation itself is applied
    // cosmetically in pose.ts, and the landing branch settles the consequences.
    if (tuning.freestyleTricks && snowman.userData && snowman.userData.playerJump) {
      const ud = snowman.userData;
      const spinDir = (controls.right ? 1 : 0) - (controls.left ? 1 : 0); // + = clockwise from above
      if (spinDir !== 0) ud.trickSpin = ((ud.trickSpin as number) || 0) + spinDir * SPIN_RATE_DEG * delta;
      const flipDir = (controls.up ? 1 : 0) - (controls.down ? 1 : 0);    // + = frontflip
      if (flipDir !== 0) ud.trickFlip = ((ud.trickFlip as number) || 0) + flipDir * FLIP_RATE_DEG * delta;
      if (!controls.jump) {
        ud.trickGrabArmed = true; // takeoff press released — a new press now grabs
        ud.trickGrabbing = false;
      } else if (ud.trickGrabArmed) {
        ud.trickGrabTime = ((ud.trickGrabTime as number) || 0) + delta;
        ud.trickGrabbing = true;  // pose cue: tuck into the grab while held
      }
    }

    // Less friction in air (frame-rate-independent; see dragFactor above)
    velocity.x *= dragFactor(0.01);
    velocity.z *= dragFactor(0.01);
  } else {
    // Update velocity based on gravity, gradient, and an improved friction model
    const gravity = tuning.gravity;

    // Dynamic friction based on speed - less friction at lower speeds for smoother acceleration
    // This prevents the jittery start by reducing initial resistance
    const speedFactor = Math.min(1, currentSpeed / 8);
    const baseFriction = tuning.baseFriction; // Lower base friction for smoother, glidier starts
    const friction = baseFriction + (tuning.frictionRamp * speedFactor); // Blue: max 0.032 at high speeds (faster cruising)
    
    // Apply forces to velocity (gravity pulls along slope direction) with smoother acceleration
    velocity.x += dir.x * steepness * gravity * delta;
    velocity.z += dir.z * steepness * gravity * delta;
    
    // --- Ski technique model -------------------------------------------------
    // Layered on top of the original arcade handling. Crucially, when the player
    // gives NO steering or brake input the behaviour below is identical to the
    // original (turnForce/accel unchanged, skidScrub == 0), so coasting physics
    // and the existing test expectations are preserved. Skill only emerges once
    // the player actually works the edges:
    //   - Snowplow (brake / Down): sheds real speed but grants tight, planted
    //     turns ("pizza" stop) - slow and controllable.
    //   - Carving (Left/Right): smooth, anticipatory turns hold speed; sharp
    //     direction changes at speed wash the edges out and scrub speed (skid).
    //   - Tuck / straight-line (Up, no steer): least friction, most speed, least
    //     room to react - the risk/reward line.
    const steering = (controls.left ? -1 : 0) + (controls.right ? 1 : 0);
    const snowplow = !!controls.down && !isInAir;

    // Terrain-dependent grip: a touch more bite on moderate pitches, looser when flat.
    const terrainGrip = tuning.gripBase + Math.min(0.4, steepness * 0.5);

    // --- Edge engagement: carve vs skidded parallel (issues #48 / #54) -------
    // `carveCharge` (0..1) tracks how committed/locked-in the current edge is: it
    // builds while the player holds ONE steering direction and collapses to 0 the
    // instant they reverse or first set an edge from straight. It is the single
    // axis that splits a turn into a tight, speed-scrubbing *skidded parallel* turn
    // (low charge) versus a wide, speed-holding *carve* (high charge) — driving the
    // turn radius, the speed scrub, and the pose together so the two read clearly
    // differently. The state lives on snowman.userData so it persists across frames
    // and resetSnowman clears it. It is read/written every frame but only *used*
    // under steering input, so the no-input coasting path stays byte-identical to the
    // frozen baseline.
    const CARVE_BUILD_RATE = tuning.carveBuild;    // ~0.4s (Blue) of a held turn to lock a carve in (> CARVE_LOCK)
    const CARVE_RELEASE_RATE = tuning.carveRelease; // edge releases ~2x faster than it engages
    const CARVE_LOCK = tuning.carveLock;            // carveCharge past this reads + behaves as a carve

    const ud = snowman.userData || (snowman.userData = {});
    let carveCharge = ud.carveCharge || 0;
    let lastSteerDir = ud.lastSteerDir || 0;
    if (steering !== 0) {
      // Same direction as last frame => the edge keeps engaging; a reversal or a
      // fresh edge out of a straight line breaks it and restarts the carve.
      carveCharge = steering === lastSteerDir
        ? Math.min(1, carveCharge + delta * CARVE_BUILD_RATE)
        : 0;
      lastSteerDir = steering;
    } else {
      carveCharge = Math.max(0, carveCharge - delta * CARVE_RELEASE_RATE);
      lastSteerDir = 0;
    }
    ud.carveCharge = carveCharge;
    ud.lastSteerDir = lastSteerDir;
    // Snowplow wedge depth was already advanced this frame (before the air/ground
    // split, so it tracks Brake through a jump); read it back for the brake + pose.
    const plowCharge = ud.plowCharge || 0;

    // Steering authority sets the turn RADIUS, and it is the inverse of commitment:
    //   - a skidded PARALLEL turn pivots tight (high authority) but scrubs speed;
    //   - a committed CARVE draws a wide, clean arc (low authority) but holds speed.
    // Blending by carveCharge makes the two turns *feel* different to drive, not just
    // post different numbers. Snowplow stays the tightest, most planted turn.
    const PARALLEL_TURN_FORCE = tuning.parallelTurnForce;  // skidded parallel: tight, pivoty
    const CARVE_TURN_FORCE = tuning.carveTurnForce;        // carved: wide, drawn-out arc
    let turnForce = snowplow
      ? 24.0                           // planted wedge = sharpest steering
      : PARALLEL_TURN_FORCE + (CARVE_TURN_FORCE - PARALLEL_TURN_FORCE) * carveCharge;
    if (!snowplow && currentSpeed > 18) turnForce *= 0.85; // harder to wrench at speed

    if (controls.left) {
      velocity.x -= turnForce * delta;
    }
    if (controls.right) {
      velocity.x += turnForce * delta;
    }

    // Forward input / straight-line tuck. Brake overrides accelerate: Up and Down are
    // independent key states, and the accelerate impulse (10) is stronger than even a
    // full wedge's brake cap (5.68), so without this gate holding W+S would accelerate
    // downhill instead of braking. A wedge and a forward push are mutually exclusive
    // anyway, so the snowplow simply ignores Up.
    const accelerationForce = tuning.tuckAccel;
    if (controls.up && !snowplow) {
      velocity.z -= accelerationForce * delta;
    }

    // Snowplow braking: decelerate along the actual direction of travel so it bleeds
    // genuine speed (not just downhill velocity). The deceleration scales with wedge
    // depth (plowCharge): a light wedge (PLOW_MIN_DECEL) only trims speed, a full
    // wedge (PLOW_MAX_DECEL) can stop you. PLOW_MAX_DECEL is the strongest brake there
    // is, so on steep pitches where gravity-along-slope exceeds it even a full wedge
    // can only hold a slow terminal speed — steep-slope failure falls straight out of
    // the force balance, no special-casing. (The old fixed +3 m/s² uphill nudge that
    // used to ride alongside the brake is folded into PLOW_MAX_DECEL: as a constant it
    // applied even to a feather-light wedge, which both stopped you on terrain too
    // steep to wedge and pushed the stop threshold past anything the run actually
    // skis, defeating the gradation and the steep-slope failure.) Clamp the impulse to
    // the current speed so braking can bring the snowman to a stop but never reverse
    // the velocity vector — at low speed an unclamped subtraction would overshoot zero
    // and let players creep/stall the timed course uphill by braking.
    //
    // Thresholds are aligned to the ski-difficulty tiers the Slope HUD shows (PR #201,
    // src/ui/hud.ts boundaries SLOPE_MODERATE 0.32 ≈ 18° and SLOPE_STEEP 0.58 ≈ 30°),
    // so the readout doubles as a "can I stop here?" cue — and "you can't pizza a black
    // diamond" holds literally: on a GREEN run (<18°) even a light wedge stops you; on a
    // BLUE run (18–30°) you need a committed full wedge; on a BLACK-DIAMOND pitch (>30°)
    // even a full wedge can only check your speed, not halt you. Each decel is the slope
    // gravity at a tier edge (steepness × 9.8 m/s²: 0.32→3.14, 0.58→5.68). For the stop
    // boundary to land *exactly* on the tier edge the brake must remove precisely
    // `brakeDecel·delta` along travel, so it is computed from the speed AFTER this
    // frame's gravity, not the stale start-of-frame `currentSpeed`. (Scaling by the
    // stale, smaller pre-gravity speed over-removed velocity as speed dropped, pinning
    // the snowman to a stop well past the cap — ~36° instead of 30° — so a pitch the HUD
    // calls black could still be stopped. Recomputing here keeps the brake honest; the
    // per-frame coast friction below then vanishes as v→0, so it does not shift the
    // boundary.)
    const PLOW_MIN_DECEL = tuning.plowDecelLight;  // light wedge: stops on green (<18°), only slows above
    const PLOW_MAX_DECEL = tuning.plowDecelFull;   // full wedge: stops up to the black-diamond line (~30°), fails above
    const brakeSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    if (snowplow && brakeSpeed > 0.001) {
      const brakeDecel = PLOW_MIN_DECEL + (PLOW_MAX_DECEL - PLOW_MIN_DECEL) * plowCharge;
      const brakeImpulse = Math.min(brakeDecel * delta, brakeSpeed);
      velocity.x -= (velocity.x / brakeSpeed) * brakeImpulse;
      velocity.z -= (velocity.z / brakeSpeed) * brakeImpulse;
    }

    // Edge skid / carve drag: only meaningful while steering. A skidded parallel
    // turn (low carveCharge) washes the edges out sideways and bleeds real speed; a
    // committed carve (carveCharge -> 1) sheds almost all of it and holds speed - so
    // holding a smooth, anticipatory line keeps speed while panicky/abrupt steering
    // scrubs it (the speed-management trade-off, issues #48/#54). Snowplow adds grip
    // so braking through a turn stays controlled. Gated on steering, so the no-input
    // coasting path is untouched and stays byte-identical to the frozen baseline.
    const CARVE_SCRUB_RELIEF = 0.92; // a locked carve sheds ~92% of the edge wash-out
    const SKID_SCRUB = tuning.skidScrubMax;  // base wash-out scrub for an uncommitted (skidded) turn
    const TURN_TAX = 0.008;          // small always-on turn cost, faded out by a carve
    let skidScrub = 0;
    if (steering !== 0 && currentSpeed > 4) {
      const speedFactor2 = Math.min(1, currentSpeed / 22);
      const grip = snowplow ? 1.0 : terrainGrip;
      const edgeScrub = SKID_SCRUB * speedFactor2 * (1 - grip * 0.85) * (1 - CARVE_SCRUB_RELIEF * carveCharge);
      skidScrub = edgeScrub + TURN_TAX * speedFactor2 * (1 - carveCharge);
    }

    // Expose technique for HUD + ski pose. There are exactly two steered turns now
    // (plus the snowplow wedge): an uncommitted, speed-scrubbing skidded **parallel**
    // turn, which locks into a speed-holding **carve** once the edge is committed past
    // CARVE_LOCK. (Real-skiing order: a carve is the mastery form of a parallel turn,
    // not a tier beyond it.)
    technique = 'glide';
    if (isInAir) technique = 'air';
    else if (snowplow) technique = 'snowplow';
    else if (steering !== 0) technique = carveCharge > CARVE_LOCK ? 'carve' : 'parallel';
    else if (controls.up) technique = 'tuck';
    
    // Only use automatic turning if no user input
    if (!controls.left && !controls.right) {
      // Update turn phase and apply automatic turning
      turnPhase += delta * 0.5; // Slower phase advancement for gentler turning
      turnChangeCooldown -= delta;
      
      // More gradual turn direction changes
      if (turnChangeCooldown <= 0) {
        // Instead of completely random direction, bias toward centered movement
        // Higher probability of returning to center line when far from center
        const centeringBias = Math.min(1, Math.abs(pos.x) / 20) * 0.7;
        const randomFactor = Math.random();
        
        if (pos.x > 5 && randomFactor < (0.6 + centeringBias)) {
          // If we're right of center, bias toward turning left
          currentTurnDirection = -1;
        } else if (pos.x < -5 && randomFactor < (0.6 + centeringBias)) {
          // If we're left of center, bias toward turning right
          currentTurnDirection = 1;
        } else {
          // Otherwise random direction with smooth transition
          currentTurnDirection = Math.random() > 0.5 ? 1 : -1;
        }
        
        // Longer cooldown for smoother movement
        turnChangeCooldown = 3 + Math.random() * 2;
      }
      
      // Scale turn intensity with speed, but with much gentler effect at low speeds
      const turnIntensity = Math.min(currentSpeed, 10) / 10;
      
      // Use eased sine wave for smoother turning - using 0.3 for smoother transition
      velocity.x += Math.sin(turnPhase * 0.3) * (turnAmplitude * 0.7) * delta * turnIntensity * currentTurnDirection;
    }
    
    // Apply friction to slow down. Base friction is unchanged when not steering
    // (skidScrub == 0), so straight-line/coasting behaviour is identical to before;
    // hard turns at speed add edge-skid drag on top.
    const totalFriction = friction + skidScrub;
    const totalDrag = dragFactor(totalFriction);
    velocity.x *= totalDrag;
    velocity.z *= totalDrag;
    
    // Update y position to terrain height when not in air
    pos.y = terrainHeightAtPosition;
  }
  
  // Apply velocity to position
  pos.x += velocity.x * delta;
  pos.z += velocity.z * delta;
  
  // Store current terrain height for next frame
  lastTerrainHeight = terrainHeightAtPosition;
  
  return {
    terrainHeightAtPosition,
    result: {
      isInAir,
      verticalVelocity,
      lastTerrainHeight,
      airTime,
      jumpCooldown,
      turnPhase,
      currentTurnDirection,
      turnChangeCooldown,
      currentSpeed,
      technique,
      justLanded,
      landingForce,
      landingQuality,
      airScoreDelta,
      trickName,
      // Scored clears (JP-2) are observed by the collision walk AFTER this step, so
      // the kernel step always reports null; updateSnowman (index.ts) stamps the
      // type when a provenance-gated, deduped, in-cap clear is scored this frame.
      obstacleCleared: null
    }
  };
}
