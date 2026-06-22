// Snowman visual pose updates: ski wedge, heading, terrain tilt, jump tilt, and turn lean.
import * as THREE from 'three';

import type { PlanarVelocity, PlayerPos, SkiTechnique, TerrainHeightFn } from './index.js';

interface SnowmanPoseState {
  delta: number;
  pos: PlayerPos;
  velocity: PlanarVelocity;
  isInAir: boolean;
  verticalVelocity: number;
  currentSpeed: number;
  technique: SkiTechnique;
  steering: number;
  getTerrainHeight: TerrainHeightFn;
}

export function applySnowmanPose(snowman: THREE.Object3D, state: SnowmanPoseState): void {
  const {
    delta,
    pos,
    velocity,
    isInAir,
    verticalVelocity,
    currentSpeed,
    technique,
    steering,
    getTerrainHeight
  } = state;

  // Show the current technique on the snowman: a snowplow forms a beginner ski
  // wedge ("pizza" — tips together, tails apart); a carve rolls the skis hard onto
  // their edges and draws them together (paired with a deep body lean below); a
  // skidded parallel turn keeps the skis flatter and brushing. Purely cosmetic; none
  // of this touches the physics.
  if (!isInAir && snowman.userData && snowman.userData.leftSki && snowman.userData.rightSki) {
    const ls = snowman.userData.leftSki, rs = snowman.userData.rightSki;
    const lerp = Math.min(1, delta * 10);
    // Wedge depth tracks how hard the player is braking (plowCharge, set in physics):
    // a light wedge for a quick speed check that opens into a deep "pizza" for a full
    // stop, so the snowplow's stop-vs-slow-down intent reads on the skis (issue #54).
    const plowCharge = (snowman.userData.plowCharge as number) || 0;
    const wedge = technique === 'snowplow' ? 0.18 + 0.32 * plowCharge : 0.0; // radians; converge the tips ("pizza")
    // Each ski's tip is at local +z and the skis sit at x = ∓1, so a POSITIVE
    // rotation.y swings the left ski's tip toward center and a NEGATIVE one swings
    // the right ski's tip toward center — tips meet, tails splay out (a real
    // snowplow). The opposite signs would splay the tips out (a reverse wedge).
    ls.rotation.y += ((wedge) - ls.rotation.y) * lerp;
    rs.rotation.y += ((-wedge) - rs.rotation.y) * lerp;
    // Make the two steered turns read clearly differently on the snowman:
    //   - CARVE: skis rolled hard onto their edges into the turn and drawn tight
    //     together (angulation) — paired below with a deep body inclination. The
    //     signature "on a rail" carve look.
    //   - PARALLEL (skidded): skis stay flatter and at roughly neutral width, brushing
    //     across the snow rather than knifing in.
    // Purely cosmetic; none of this touches the physics.
    let edge = 0.0, draw = 0.0;
    if (technique === 'carve') { edge = steering * 0.5; draw = 0.4; }
    else if (technique === 'parallel') { edge = steering * 0.1; draw = 0.05; }
    // TUCK: skis stay flat (edge 0) but draw parallel and slightly narrow under the
    // body for a clean aerodynamic stance — paired with the forward fold + crouch below.
    else if (technique === 'tuck') { draw = 0.22; }
    const lbx = (snowman.userData.leftSkiBaseX ?? -1) + draw;
    const rbx = (snowman.userData.rightSkiBaseX ?? 1) - draw;
    ls.rotation.z += (edge - ls.rotation.z) * lerp;
    rs.rotation.z += (edge - rs.rotation.z) * lerp;
    ls.position.x += (lbx - ls.position.x) * lerp;
    rs.position.x += (rbx - rs.position.x) * lerp;
    snowman.userData.technique = technique;
  }

  // Update snowman position and rotation
  snowman.position.set(pos.x, pos.y, pos.z);
  
  // More sophisticated rotation handling with smoothing
  const movementDir = { x: velocity.x, z: velocity.z };
  
  // Add persistent rotation value for smoother transitions
  if (!snowman.userData) snowman.userData = {};
  if (snowman.userData.targetRotationY === undefined) {
    snowman.userData.targetRotationY = Math.PI; // Default facing downhill
    snowman.userData.currentRotX = 0;
    snowman.userData.currentRotZ = 0;
  }
  
  if (currentSpeed > 0.5) { // Only rotate if moving with significant speed
    // Calculate target rotation - keep existing if below threshold
    snowman.userData.targetRotationY = Math.atan2(movementDir.x, movementDir.z);
  }
  
  // Apply rotation with smoothing - more stability at higher speeds
  const rotationSmoothingY = Math.min(1, Math.max(0.05, delta * 2.5));
  
  // Interpolate toward target rotation - never rotate more than 15 degrees at once
  const currentRotY = snowman.rotation.y;
  const targetRotY = snowman.userData.targetRotationY;
  
  // Determine the shortest rotation direction (handle wrapping at 2pi)
  let deltaRotation = targetRotY - currentRotY;
  if (deltaRotation > Math.PI) deltaRotation -= Math.PI * 2;
  if (deltaRotation < -Math.PI) deltaRotation += Math.PI * 2;
  
  // Apply smoothed rotation with a max rate to prevent spinning
  const maxRotationRate = delta * 3; // Max ~180deg per second
  const appliedDelta = Math.max(-maxRotationRate, Math.min(maxRotationRate, deltaRotation * rotationSmoothingY));
  snowman.rotation.y += appliedDelta;
  
  // Normalize rotation to 0-2pi range
  snowman.rotation.y = snowman.rotation.y % (Math.PI * 2);
  if (snowman.rotation.y < 0) snowman.rotation.y += Math.PI * 2;

  // Body crouch (cosmetic): fold the body lower for an aerodynamic TUCK and squat
  // into a hard SNOWPLOW wedge (deeper as plowCharge builds, #54). Driven off
  // scale.y about the foot-level origin — the skis sit at y≈0.1, so compressing y
  // lowers the body toward the skis without lifting them off the snow (a real crouch,
  // not a shrink). It is NOT a backward weight shift: a snowplow digs in with bent
  // knees, not by leaning back. Relaxes to upright in the air. Never touches physics.
  if (snowman.scale) { // real THREE.Object3D always has scale; the test mock may not
    const plowCharge = (snowman.userData.plowCharge as number) || 0;
    let crouchTarget = 1.0;
    if (!isInAir) {
      if (technique === 'tuck') crouchTarget = 0.86;                            // deep aero crouch
      else if (technique === 'snowplow') crouchTarget = 1.0 - 0.10 * plowCharge; // squat into the wedge
    }
    snowman.scale.y += (crouchTarget - snowman.scale.y) * Math.min(1, delta * 8);
  }

  // Calculate a tilt based on the slope and turning with improved smoothing
  // Use wider sample points for more stable gradients
  const sampleDist = 0.4; // Even wider sampling for stability
  const gradX = (getTerrainHeight(pos.x + sampleDist, pos.z) - getTerrainHeight(pos.x - sampleDist, pos.z)) / (2 * sampleDist);
  const gradZ = (getTerrainHeight(pos.x, pos.z + sampleDist) - getTerrainHeight(pos.x, pos.z - sampleDist)) / (2 * sampleDist);
  
  // Add more dramatic jump rotation - lean forward during jumps
  let jumpTilt = 0;
  if (isInAir) {
    // More dramatic tilt during jumps, especially on takeoff
    if (verticalVelocity > 0) {
      // Lean back on ascent
      jumpTilt = -Math.min(0.4, verticalVelocity * 0.03);
    } else {
      // Lean forward on descent, more as you fall faster
      jumpTilt = Math.min(0.5, -verticalVelocity * 0.025);
    }
  }
  
  // Add more controlled turning tilt with speed-based scaling
  const turnTiltFactor = Math.min(0.3, currentSpeed / 25); // Less tilt at lower speeds
  // A committed carve inclines the whole body hard into the turn (angulation/
  // inclination) — the signature carve look, and the strongest cue separating it
  // from a flatter, upright skidded parallel turn. Amplify the lean and raise the
  // clamp during a carve; every other technique keeps the original gentle lean.
  const isCarve = technique === 'carve';
  const isTuck = technique === 'tuck';
  const turnTilt = velocity.x * turnTiltFactor * (isCarve ? 2.0 : 1.0);
  // A TUCK folds the body forward into the fall line (nose-down = +rotation.x, the
  // same sign as the descent jump lean) on top of the terrain pitch — the "going
  // fast" cue that pairs with the crouch + drawn-in skis above. No-steer technique,
  // so the roll axis stays ~0 here.
  const tuckLean = isTuck ? 0.28 : 0.0; // ~16° forward fold over the terrain pitch

  // Limit maximum tilt angles to prevent unrealistic leaning. Pitch (rotation.x) and
  // roll (rotation.z) are clamped separately so a technique only relaxes the axis it
  // needs: a carve inclines the body hard into the turn (roll), a tuck folds it
  // forward (pitch). Carve/jump/coast pitch+roll are unchanged at 0.25 (0.42 carve).
  const maxPitchAngle = isTuck ? 0.5 : (isCarve ? 0.42 : 0.25); // ~29° tuck fold, else as before
  const maxRollAngle = isCarve ? 0.42 : 0.25;                   // ~24° into a carve, ~14° otherwise

  // Apply smoothing and clamping to rotation values
  const targetRotX = gradZ * 0.3 + jumpTilt + tuckLean; // terrain pitch + jump lean + tuck fold
  const targetRotZ = -gradX * 0.3 - turnTilt;
  
  // Significantly improve tilt smoothing
  const tiltSmoothing = isInAir ? 0.05 : 0.08; // Lower values for smoother transitions
  
  // Use lerp for smooth rotation
  snowman.userData.currentRotX = snowman.userData.currentRotX || 0;
  snowman.userData.currentRotZ = snowman.userData.currentRotZ || 0;
  
  // Smoothly transition current rotations toward target
  snowman.userData.currentRotX += (targetRotX - snowman.userData.currentRotX) * tiltSmoothing;
  snowman.userData.currentRotZ += (targetRotZ - snowman.userData.currentRotZ) * tiltSmoothing;
  
  // Apply clamped rotations
  snowman.rotation.x = Math.max(-maxPitchAngle, Math.min(maxPitchAngle, snowman.userData.currentRotX));
  snowman.rotation.z = Math.max(-maxRollAngle, Math.min(maxRollAngle, snowman.userData.currentRotZ));
}
