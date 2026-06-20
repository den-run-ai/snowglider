// Snowman physics kernel: reset + per-frame movement integration.
import * as THREE from 'three';

import type {
  CameraManagerLike,
  PlanarVelocity,
  PlayerPos,
  SkiTechnique,
  SnowmanControls,
  TerrainHeightFn,
  TerrainVecFn,
  UpdateResult
} from './index.js';

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
  getDownhillDirection: TerrainVecFn
): SnowmanPhysicsStepOutput {
  // Update jump cooldown
  if (jumpCooldown > 0) {
    jumpCooldown -= delta;
  }
  
  // Outer-scope outputs surfaced in the return value (HUD + camera juice).
  let technique: SkiTechnique = isInAir ? 'air' : 'glide';
  let justLanded = false;
  let landingForce = 0;
  
  // Get current terrain height at position
  const terrainHeightAtPosition = getTerrainHeight(pos.x, pos.z);
  
  // Check for landing
  if (isInAir && pos.y <= terrainHeightAtPosition) {
    isInAir = false;
    pos.y = terrainHeightAtPosition;
    justLanded = true;
    
    // Landing impact based on air time and height
    const landingImpact = Math.min(0.5, airTime * 0.15);
    landingForce = airTime; // seconds aloft; used for camera shake on touchdown
    const currentSpeed = Math.sqrt(velocity.x*velocity.x + velocity.z*velocity.z);
    
    // Reduce speed on landing
    velocity.x *= (1 - landingImpact);
    velocity.z *= (1 - landingImpact);
    
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
  
  // Auto-jump when going downhill after a steep uphill section
  if (!isInAir && heightDifference < -0.8 && movingFast && jumpCooldown <= 0) {
    verticalVelocity = 6 + (currentSpeed * 0.3);
    isInAir = true;
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
  if (controls.jump && !isInAir && jumpCooldown <= 0) {
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
      }
      technique = 'hop';
    } else {
      verticalVelocity = 10 + (currentSpeed * 0.5);
      isInAir = true;
      jumpCooldown = 0.5; // Prevent jump spam
    }
  }
  
  // Update vertical position and velocity when in air
  if (isInAir) {
    // Track time in air
    airTime += delta;
    
    // Apply gravity to vertical velocity
    verticalVelocity -= 16 * delta;
    
    // Update vertical position
    pos.y += verticalVelocity * delta;
    
    // Air control
    if (controls.left) {
      velocity.x -= 5.0 * delta;
    }
    if (controls.right) {
      velocity.x += 5.0 * delta;
    }
    
    // Less friction in air
    velocity.x *= (1 - 0.01);
    velocity.z *= (1 - 0.01);
  } else {
    // Update velocity based on gravity, gradient, and an improved friction model
    const gravity = 9.8;
    
    // Dynamic friction based on speed - less friction at lower speeds for smoother acceleration
    // This prevents the jittery start by reducing initial resistance
    const speedFactor = Math.min(1, currentSpeed / 8);
    const baseFriction = 0.015; // Lower base friction for smoother starts
    const friction = baseFriction + (0.025 * speedFactor); // Maximum 0.04 at high speeds
    
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
    const terrainGrip = 0.6 + Math.min(0.4, steepness * 0.5);

    // Steering authority: snowplow tightens the turn, speed loosens it slightly.
    let turnForce = 16.0;
    if (snowplow) turnForce = 24.0;            // planted wedge = sharper steering
    else if (currentSpeed > 18) turnForce = 14.0; // hard to wrench the skis at speed

    if (controls.left) {
      velocity.x -= turnForce * delta;
    }
    if (controls.right) {
      velocity.x += turnForce * delta;
    }

    // Forward input / straight-line tuck.
    const accelerationForce = 10.0;
    if (controls.up) {
      velocity.z -= accelerationForce * delta;
    }

    // Snowplow braking: decelerate along the actual direction of travel so it
    // bleeds genuine speed (not just downhill velocity), with a little extra dig.
    // Clamp the impulse to the current speed so braking can bring the snowman to a
    // stop but never reverse the velocity vector - otherwise at low speed the
    // subtraction overshoots zero and the control bias below drives it back uphill,
    // letting players climb/stall the timed course by braking.
    if (snowplow && currentSpeed > 0.001) {
      const brakeDecel = 14.0;
      const brakeImpulse = Math.min(brakeDecel * delta, currentSpeed);
      velocity.x -= (velocity.x / currentSpeed) * brakeImpulse;
      velocity.z -= (velocity.z / currentSpeed) * brakeImpulse;
      // Only nudge the slight uphill control bias while still moving; never after the
      // brake has stopped the snowman (that would push it uphill from a standstill).
      if (brakeImpulse < currentSpeed) {
        velocity.z += accelerationForce * delta * 0.3;
      }
    }

    // --- Edge engagement: carve vs skid (issues #48 / #54) -------------------
    // Turning is only a real *skill* if a clean, committed turn costs less speed
    // than a panicked one. `carveCharge` (0..1) tracks how "locked in" the
    // current edge is: it builds while the player commits to ONE steering
    // direction and collapses to 0 the instant they reverse or first set an edge
    // from straight. A locked carve sheds little speed; a fresh or reversed edge
    // washes out sideways and scrubs hard. So anticipating and holding a smooth
    // line keeps speed, while flip-flopping the skis bleeds it - the
    // speed-management trade-off the roadmap calls for.
    //
    // The state lives on snowman.userData (like `technique` and the pose state)
    // so it persists across frames without widening the updateSnowman contract,
    // and resetSnowman clears it between runs. Crucially it is *read/written but
    // never used to alter velocity when the player gives no steering input*, so
    // the no-input coasting path stays byte-identical to the frozen baseline.
    const CARVE_BUILD_RATE = 1.5;    // ~0.66s of a held turn to lock the carve in
    const CARVE_RELEASE_RATE = 3.0;  // edge releases ~2x faster than it engages
    const CARVE_SCRUB_RELIEF = 0.8;  // a locked carve sheds up to 80% of edge wash-out
    const TURN_TAX = 0.01;           // small always-on turn cost so a turn is never free
    const PARALLEL_LOCK = 0.85;      // carveCharge past this = a mastered parallel turn

    const ud = snowman.userData || (snowman.userData = {});
    let carveCharge = ud.carveCharge || 0;
    let lastSteerDir = ud.lastSteerDir || 0;
    if (steering !== 0) {
      // Same direction as last frame => the edge keeps engaging; a reversal or a
      // fresh edge out of a straight line breaks it and starts the carve over.
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

    // Edge skid / carve drag: only meaningful while steering. Snowplow adds grip,
    // so braking through a turn stays controlled instead of washing out.
    let skidScrub = 0;
    if (steering !== 0 && currentSpeed > 4) {
      const speedFactor2 = Math.min(1, currentSpeed / 22);
      const grip = snowplow ? 1.0 : terrainGrip;
      // Edge wash-out: sharper turn relative to grip => more scrub (~0..0.06). A
      // locked carve (carveCharge to 1) sheds most of it; a skid (carveCharge to 0)
      // keeps all of it.
      const edgeScrub = 0.06 * speedFactor2 * (1 - grip * 0.85) * (1 - CARVE_SCRUB_RELIEF * carveCharge);
      // Plus an always-on turn tax (scaled by speed) so committing to a turn still
      // costs a little versus straight-lining - turning is never free, but a clean
      // carve is cheap. A fully-locked PARALLEL turn (carveCharge past the 0.85
      // parallel threshold - skis together and rolled onto edge) is the most
      // efficient turn there is, so the tax fades out across the parallel lock:
      // mastering the carve into a parallel turn makes it nearly free. Below 0.85
      // `parallelLock` is 0, so carve/skid feel and the gating carve-vs-skid check
      // are byte-identical.
      const parallelLock = Math.min(1, Math.max(0, (carveCharge - PARALLEL_LOCK) / (1 - PARALLEL_LOCK)));
      skidScrub = edgeScrub + TURN_TAX * speedFactor2 * (1 - parallelLock);
    }

    // Expose technique for HUD + ski pose. A turn reads as a "skid" until the edge
    // locks in (carveCharge), then a "carve", and finally a "parallel" turn once
    // the edge is fully committed past PARALLEL_LOCK - the mastery tier above the
    // beginner snowplow wedge.
    technique = 'glide';
    if (isInAir) technique = 'air';
    else if (snowplow) technique = 'snowplow';
    else if (steering !== 0) technique = carveCharge > PARALLEL_LOCK ? 'parallel' : (carveCharge > 0.55 ? 'carve' : 'skid');
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
    velocity.x *= (1 - totalFriction);
    velocity.z *= (1 - totalFriction);
    
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
      landingForce
    }
  };
}
