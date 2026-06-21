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
    const wedge = technique === 'snowplow' ? 0.35 : 0.0; // radians; converge the tips ("pizza")
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
  const turnTilt = velocity.x * turnTiltFactor * (isCarve ? 2.0 : 1.0);

  // Limit maximum tilt angles to prevent unrealistic leaning
  const maxTiltAngle = isCarve ? 0.42 : 0.25; // ~24° into a carve, ~14° otherwise
  
  // Apply smoothing and clamping to rotation values
  const targetRotX = gradZ * 0.3 + jumpTilt; // Add jump tilt to X rotation
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
  snowman.rotation.x = Math.max(-maxTiltAngle, Math.min(maxTiltAngle, snowman.userData.currentRotX));
  snowman.rotation.z = Math.max(-maxTiltAngle, Math.min(maxTiltAngle, snowman.userData.currentRotZ));
}
