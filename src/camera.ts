// camera.ts - Camera management for SnowGlider
//
// Phase 2.3 (issue #84): converted off the classic global model. `THREE` and the
// terrain sampler (`Mountains.getTerrainHeight`) now come from real ES-module
// imports instead of the CDN global / window bridge, and the class is `export`ed.
// Loaded via the bundle entry (src/main.js).
//
// Phase 3.2 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
// (implied for a real `.ts` file) and the camera's state is now expressed as
// explicit, typed class fields plus typed method signatures. Behaviour is
// unchanged — every edit is type-only/erasable, so esbuild (Vite) and Node's
// native type-stripping both run it exactly as before.
import * as THREE from 'three';
import { Mountains } from './mountains.js';

/**
 * Camera viewpoint modes (issue #305). Three third-person
 * variants plus a head cam:
 *  - `auto`        — smart default: orbit auto-centers behind travel, and the follow
 *                    distance/pitch adapt situationally to speed, terrain steepness, jumps,
 *                    avalanche danger and screen aspect. Best hands-off view for casual play.
 *  - `follow`      — classic chase: always behind the player, honoring manual zoom.
 *  - `orbit`       — free 360° orbit: player fully controls yaw/pitch/zoom, held put.
 *  - `firstPerson` — over-the-head cam.
 * `V` cycles them in this order; the legacy toggle (controls.ts / lifecycle) maps to
 * the same cycle via the `toggleCameraMode()` compatibility wrapper.
 */
export const CAMERA_MODES = ['auto', 'follow', 'orbit', 'firstPerson'] as const;
export type CameraMode = typeof CAMERA_MODES[number];

/** Third-person modes share the follow/orbit rig; only `firstPerson` is the head cam. */
export function isThirdPerson(mode: CameraMode): boolean {
  return mode !== 'firstPerson';
}

// --- View-control tuning (issue #305) ---
// Per-frame easing factor the auto-frame recenter/zoom uses. Matches the gentle,
// frame-rate-independent-enough feel of the existing `smoothing` lerp (0.08); the
// game runs a fixed-timestep loop, so a constant factor is safe here (same pattern
// the follow smoothing already relies on).
const AUTO_FRAME_EASE = 0.06;
// Frames a manual orbit/zoom nudge suppresses auto-frame easing for, so the chosen
// framing holds briefly before the smart camera eases back (~1.5s @ 60fps).
const MANUAL_HOLD_FRAMES = 90;

// --- Situational Auto framing (issue #305, P3+) ---
// Auto builds a target follow profile from cosmetic-only signals and EASES toward it
// (never snaps), so a reframe reads as a smooth camera move. Every term is additive on
// top of the base speed pull-back; all are 0 in the neutral case, so calm cruising on
// gentle terrain still reduces to the classic follow framing. Emphasis (per the tracking
// issue's guardrails + the request): expert/steep terrain and jumps get the biggest
// pull-back and overhead lift so the drop and the landing zone stay in shot.
//
// Zoom terms (multiplier on the follow distance; > 1 pulls the camera back):
const AUTO_SPEED_ZOOM = 0.2;      // extra pull-back at top speed — more of the run ahead in shot
const AUTO_SLOPE_ZOOM = 0.35;     // extra pull-back on the steepest (expert) fall lines
const AUTO_AIR_ZOOM = 0.45;       // extra pull-back off a jump so the landing stays framed
const AUTO_TURN_ZOOM_IN = 0.15;   // pull IN through tight, twisty (tree-line) turns
const AUTO_PORTRAIT_ZOOM = 0.3;   // pull back on tall/portrait screens for vertical context
const AUTO_DANGER_ZOOM = 0.4;     // widen out when an avalanche is bearing down
// Overhead-pitch terms (radians added to the follow pitch; + lifts the camera up/over so
// it looks further down the slope). Only steep terrain and airtime raise it — that is
// where seeing the ground *below/ahead* matters most:
const AUTO_SLOPE_PITCH = 0.28;    // lift overhead on steep terrain to reveal the drop below
const AUTO_AIR_PITCH = 0.35;      // lift overhead in the air to keep the landing zone framed
// Normalization references — the signal value treated as "fully engaged" (factor 1):
const AUTO_SLOPE_REF = 0.8;       // terrain gradient (rise/run ≈ tan θ) counted as fully expert
const AUTO_TURN_REF = 0.06;       // per-frame travel-heading change (rad) counted as a hard carve
const AUTO_DANGER_REF = 60;       // distance (world units) to the nearest avalanche boulder = max danger
// Slope framing is gated on ACTUAL downhill motion: the spawn/parked spot sits on a steep
// gradient (~0.7), so an ungated slope term would pull back + lift the camera before the
// player is even skiing, drifting Auto off the neutral spawn/slow framing the transient
// reset is meant to preserve. Below this speed slope framing fades to nothing; a gentle
// cruise (well under the top-speed `speedThreshold`) already re-engages it fully.
const AUTO_MOTION_REF = 6;
// Bounds on the combined transient multipliers so a stack of signals can't crash the
// camera into the player or fling it to the horizon:
const AUTO_MIN_AUTOZOOM = 0.75;
const AUTO_MAX_AUTOZOOM = 1.9;
const AUTO_MAX_AUTOPITCH = AUTO_SLOPE_PITCH + AUTO_AIR_PITCH;

/** Clamp `v` to [lo, hi]. */
function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap an angle to (-π, π] so easing toward 0 always takes the short way round. */
function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r <= -Math.PI) r += twoPi;
  return r;
}

/** Terrain sampler signature (the live game injects `Snow.getTerrainHeight`). */
export type TerrainHeightFn = (x: number, z: number) => number;

/**
 * Horizontal velocity the camera reads. Only x/z are used (for follow distance
 * and look-ahead), so this accepts both a real `THREE.Vector3` and the plain
 * `{ x, z }` velocity the game loop tracks.
 */
interface PlanarVelocity {
  x: number;
  z: number;
}

/**
 * Cosmetic-only, per-frame signals the game loop feeds the camera so Auto can frame the
 * action situationally (issue #305, P3+). Everything here is a READ of the physics result,
 * never `pos`/`velocity`, so the deterministic fixed-timestep sim is unaffected. All fields
 * are optional — an omitted context leaves Auto on its speed-only behaviour, and the other
 * situational inputs (slope, turn rate, screen aspect) the camera derives itself.
 */
export interface AutoFrameContext {
  /** True while the player is airborne (a jump): pull back + lift so the landing stays framed. */
  isInAir?: boolean;
  /** World-unit distance to the nearest active avalanche boulder; Infinity/omitted = safe. */
  avalancheDistance?: number;
}

/** Reusable vectors that carry smoothing state between frames. */
interface SmoothingVectors {
  lastPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  lookAtPosition: THREE.Vector3;
}

export class Camera {
  camera: THREE.PerspectiveCamera;
  smoothingVectors: SmoothingVectors;
  smoothing: number;
  minDistance: number;
  maxDistance: number;
  speedThreshold: number;
  frameCount: number;
  isFirstFrame: boolean;
  mode: CameraMode;

  // --- Orbit / zoom view controls (issue #305) ---
  // These layer on top of the third-person follow and are all neutral at their
  // defaults, so the framing at spawn is identical to the classic camera.
  orbitYaw: number;        // horizontal orbit offset added to the follow angle (radians, full 360°)
  orbitPitch: number;      // vertical orbit offset (radians); 0 = default framing, + = more overhead
  zoom: number;            // MANUAL follow-distance multiplier (>1 pulls back, <1 moves in). Persisted.
  autoZoom: number;        // TRANSIENT situational multiplier Auto eases; never persisted into `zoom`
  autoPitch: number;       // TRANSIENT situational overhead pitch (radians) Auto eases; additive on orbitPitch
  lastTravelHeading: number | null; // previous frame's travel heading, for the Auto turn-rate signal
  manualHoldFrames: number;// frames left before auto/follow centering resumes after a manual nudge
  minZoom: number;
  maxZoom: number;
  minPitch: number;
  maxPitch: number;

  // `_scene` is accepted to match the call site (`new Camera(scene)`) and kept for
  // parity with the other managers, though the camera reads terrain via the
  // imported `Mountains` sampler rather than the scene graph (hence the
  // underscore: deliberately unused).
  constructor(_scene: THREE.Scene) {
    // Create the camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
    
    // Initialize camera vectors for smoothing
    this.smoothingVectors = {
      lastPosition: new THREE.Vector3(),
      targetPosition: new THREE.Vector3(),
      lookAtPosition: new THREE.Vector3()
    };
    
    // Camera parameters
    this.smoothing = 0.08; // Lower value for smoother camera
    this.minDistance = 15;
    this.maxDistance = 25;
    this.speedThreshold = 20; // Speed at which we reach max distance
    this.frameCount = 0;
    this.isFirstFrame = true;
    
    // Camera mode - "auto" is the smart default (see CAMERA_MODES).
    this.mode = "auto";

    // View controls: neutral defaults (behind the player, default distance).
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.zoom = 1;
    this.autoZoom = 1;
    this.autoPitch = 0;
    this.lastTravelHeading = null;
    this.manualHoldFrames = 0;
    this.minZoom = 0.5;
    this.maxZoom = 2.5;
    this.minPitch = -0.35; // a little below level
    this.maxPitch = 1.15;  // near top-down
  }

  // Compute the third-person camera offset from the player for a given base follow
  // `distance` and player-heading `yaw`, applying the current orbit (yaw + pitch) and
  // zoom. At the defaults (orbitYaw 0, orbitPitch 0, zoom 1) this reduces exactly to
  // the classic offset (sin·d, 8, cos·d), so re-init and the follow snap are unchanged.
  followOffset(distance: number, yaw: number): THREE.Vector3 {
    const d = distance * this.zoom * this.autoZoom;
    const angle = yaw + this.orbitYaw;
    // Manual orbit pitch plus Auto's transient situational lift, clamped to the same sane
    // range. autoPitch is 0 outside Auto (and in the neutral case), so this reduces to the
    // classic offset at the defaults.
    const pitch = clampNum(this.orbitPitch + this.autoPitch, this.minPitch, this.maxPitch);
    const horiz = d * Math.cos(pitch);
    const height = 8 + d * Math.sin(pitch);
    return new THREE.Vector3(Math.sin(angle) * horiz, height, Math.cos(angle) * horiz);
  }

  /**
   * Orbit the third-person camera around the player. `dYaw`/`dPitch` are radian
   * deltas; yaw wraps a full 360°, pitch is clamped to a sane range. Registers manual
   * input so auto-frame easing pauses briefly and the chosen angle holds.
   */
  orbit(dYaw: number, dPitch: number = 0): void {
    this.orbitYaw = wrapAngle(this.orbitYaw + dYaw);
    this.orbitPitch = clampNum(this.orbitPitch + dPitch, this.minPitch, this.maxPitch);
    this.manualHoldFrames = MANUAL_HOLD_FRAMES;
  }

  /** Set the orbit yaw to an absolute angle (radians, wrapped). Used by the 360° slider. */
  setOrbitYaw(angle: number): void {
    this.orbitYaw = wrapAngle(angle);
    this.manualHoldFrames = MANUAL_HOLD_FRAMES;
  }

  /** Recenter the orbit behind the player (yaw + pitch to 0), keeping the current zoom. */
  recenter(): void {
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.manualHoldFrames = 0;
  }

  /**
   * Zoom by multiplying the follow distance. `factor` < 1 moves the camera in, > 1
   * pulls it back; the result is clamped to [minZoom, maxZoom]. Returns the new zoom.
   */
  adjustZoom(factor: number): number {
    this.zoom = clampNum(this.zoom * factor, this.minZoom, this.maxZoom);
    this.manualHoldFrames = MANUAL_HOLD_FRAMES;
    return this.zoom;
  }

  /** Jump straight to a mode (used by the on-screen camera tray). Returns it. */
  setMode(mode: CameraMode): CameraMode {
    this.mode = mode;
    // Auto re-frames from the live state, so just release any manual hold. Follow is
    // the classic behind-the-player chase, so entering it recenters the orbit (keeping
    // the player's manual zoom) rather than holding the previous side/front angle for
    // the manual-hold window before easing back (codex review, PR #306).
    if (mode === 'auto') this.manualHoldFrames = 0;
    else if (mode === 'follow') this.recenter();
    // Only Auto applies the situational zoom/pitch; drop both transients when leaving Auto
    // so Follow/Orbit/FP don't inherit a transient reframe as if it were manual.
    if (mode !== 'auto') { this.autoZoom = 1; this.autoPitch = 0; }
    return this.mode;
  }

  /** Advance to the next mode in the cycle (auto → follow → orbit → firstPerson → auto). */
  cycleMode(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    return this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]!);
  }

  /**
   * Backward-compatible view toggle. controls.ts (the `V` key) and lifecycle call
   * this by name; it now advances the mode cycle instead of flipping two modes.
   */
  toggleCameraMode(): CameraMode {
    const mode = this.cycleMode();
    console.log(`Camera mode switched to: ${mode}`);
    return mode;
  }

  /** Recenter the orbit behind the player and reset zoom to the default framing. */
  resetView(): void {
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.zoom = 1;
    this.autoZoom = 1;
    this.autoPitch = 0;
    this.lastTravelHeading = null;
    this.manualHoldFrames = 0;
  }

  /**
   * Pure situational-framing profile (issue #305, P3+). Given the current cosmetic signals,
   * returns the follow multiplier (`zoom`) and overhead lift (`pitch`) Auto should ease
   * toward. No side effects and no `this` state mutated, so it unit-tests directly.
   *
   *  - `speed`      — base speed pull-back (bomb the fall line → see more ahead).
   *  - `slope`      — terrain gradient magnitude (rise/run); steep/expert lines pull back AND lift,
   *                   but only once actually skiing (gated on motion so a parked/slow snowman on the
   *                   steep spawn keeps the neutral framing).
   *  - `turnRate`   — |travel-heading change| per frame; hard, twisty carves pull IN for tight framing.
   *  - `aspect`     — camera aspect; tall/portrait screens pull back for vertical context.
   *  - `isInAir`    — a jump pulls back AND lifts so the landing zone stays framed.
   *  - `avalancheDistance` — nearer boulders widen the shot so the slide is visible.
   */
  autoFrameTargets(
    speed: number, slope: number, turnRate: number, aspect: number,
    isInAir: boolean, avalancheDistance: number,
  ): { zoom: number; pitch: number } {
    const speedFactor = clampNum(speed / this.speedThreshold, 0, 1);
    // Fade slope framing in with motion so a parked/slow snowman on the steep spawn keeps
    // the neutral framing (the base speed term still handles the "you're moving" pull-back).
    const motionFactor = clampNum(speed / AUTO_MOTION_REF, 0, 1);
    const slopeFactor = clampNum(slope / AUTO_SLOPE_REF, 0, 1) * motionFactor;
    const turnFactor = clampNum(turnRate / AUTO_TURN_REF, 0, 1);
    const portraitFactor = aspect < 1 ? clampNum(1 - aspect, 0, 1) : 0;
    const dangerFactor = clampNum(1 - avalancheDistance / AUTO_DANGER_REF, 0, 1);

    const zoom = clampNum(
      1
        + speedFactor * AUTO_SPEED_ZOOM
        + slopeFactor * AUTO_SLOPE_ZOOM
        + (isInAir ? AUTO_AIR_ZOOM : 0)
        + portraitFactor * AUTO_PORTRAIT_ZOOM
        + dangerFactor * AUTO_DANGER_ZOOM
        - turnFactor * AUTO_TURN_ZOOM_IN,
      AUTO_MIN_AUTOZOOM, AUTO_MAX_AUTOZOOM,
    );
    const pitch = clampNum(
      slopeFactor * AUTO_SLOPE_PITCH + (isInAir ? AUTO_AIR_PITCH : 0),
      0, AUTO_MAX_AUTOPITCH,
    );
    return { zoom, pitch };
  }

  // Ease the orbit back behind the direction of travel and the TRANSIENT autoZoom/autoPitch
  // toward the situational target above, so the camera dynamically re-frames the action when
  // the player isn't actively steering the view. Writes only the transients (`autoZoom`,
  // `autoPitch`), never the persisted manual `zoom`/`orbitPitch`, so a run can't leak framing
  // into the next run's spawn or into Follow/Orbit (codex review, PR #306). Called once per
  // third-person frame while Auto is on and no recent manual nudge is holding. `slope`,
  // `turnRate` and `aspect` are derived by `update()`; `ctx` carries the loop-only signals.
  applyAutoFrame(currentSpeed: number, slope = 0, turnRate = 0, aspect = 1, ctx: AutoFrameContext = {}): void {
    this.orbitYaw += (0 - this.orbitYaw) * AUTO_FRAME_EASE;
    this.orbitPitch += (0 - this.orbitPitch) * AUTO_FRAME_EASE;
    const { zoom, pitch } = this.autoFrameTargets(
      currentSpeed, slope, turnRate, aspect,
      ctx.isInAir === true,
      ctx.avalancheDistance === undefined ? Infinity : ctx.avalancheDistance,
    );
    this.autoZoom += (zoom - this.autoZoom) * AUTO_FRAME_EASE;
    this.autoPitch += (pitch - this.autoPitch) * AUTO_FRAME_EASE;
  }

  // Position camera initially behind the player
  initialize(playerPosition: THREE.Vector3, playerRotation: THREE.Euler) {
    // Spawn framing is driven by the persisted manual `zoom` only; clear the transient
    // situational autoZoom/autoPitch (and the turn-rate memory) so a restart after a
    // steep/fast/airborne Auto run re-seats at the neutral view.
    this.autoZoom = 1;
    this.autoPitch = 0;
    this.lastTravelHeading = null;
    if (this.mode === "firstPerson") {
      // First-person camera initialization
      const angle = playerRotation.y;
      
      // Position camera significantly above and behind the head
      const cameraOffset = new THREE.Vector3(
        // Slightly to the right of center (0.2 units) to avoid the nose
        -Math.sin(angle) * 2.5 + 0.2,
        // Well above the head (head is at 7.5, camera at 10.0)
        10.0,
        // Further behind the head by 2.5 units
        -Math.cos(angle) * 2.5
      );
      
      // Position camera relative to player
      const cameraPosition = new THREE.Vector3().copy(playerPosition).add(cameraOffset);
      this.camera.position.copy(cameraPosition);
      
      // Match snowman's rotation
      this.camera.rotation.set(playerRotation.x, playerRotation.y, playerRotation.z);
      
      // Look further ahead to compensate for the higher and more distant camera position
      const lookTarget = new THREE.Vector3(
        playerPosition.x + Math.sin(playerRotation.y) * 8,
        playerPosition.y + 6.5, // Look more downward for better terrain visibility
        playerPosition.z + Math.cos(playerRotation.y) * 8
      );
      this.camera.lookAt(lookTarget);
    } else {
      // Original third-person camera initialization
      // Start with the base distance of minDistance - will adjust dynamically during
      // gameplay. followOffset() folds in the current orbit/zoom (neutral by default).
      const camOffset = this.followOffset(this.minDistance, playerRotation.y);

      // Place camera exactly where it should be in its final position
      const initialPos = new THREE.Vector3(playerPosition.x, playerPosition.y, playerPosition.z).add(camOffset);
      this.camera.position.copy(initialPos);
      this.camera.lookAt(playerPosition.x, playerPosition.y, playerPosition.z);
      
      // Initialize smoothing vectors exactly matching the final position
      this.smoothingVectors.targetPosition.copy(initialPos);
      this.smoothingVectors.lastPosition.copy(initialPos);
      this.smoothingVectors.lookAtPosition.set(playerPosition.x, playerPosition.y, playerPosition.z);
    }
    
    // Reset frame counter
    this.frameCount = 0;
    this.isFirstFrame = true;
  }

  // Update camera position based on player position, rotation, and velocity.
  // `_getTerrainHeight` is accepted for call-site parity but unused: the camera
  // samples terrain via the imported `Mountains.getTerrainHeight`/`getTerrainGradient`
  // directly. `context` carries the loop's cosmetic-only situational signals (jump /
  // avalanche) for Auto framing; omitted (or `{}`) it falls back to speed-only Auto.
  update(playerPosition: THREE.Vector3, playerRotation: THREE.Euler, velocity: PlanarVelocity, _getTerrainHeight: TerrainHeightFn, context: AutoFrameContext = {}) {
    // Track frames for smoothing transitions
    this.frameCount++;
    
    if (this.mode === "firstPerson") {
      this.updateFirstPerson(playerPosition, playerRotation, velocity);
      return;
    }
    
    // Third-person camera mode (original implementation)
    
    // Special handling for the first frame to ensure proper initialization
    if (this.isFirstFrame) {
      this.isFirstFrame = false;
      this.frameCount = 0;
      
      // Calculate the exact position where the camera should be based on the player's
      // rotation and the current orbit/zoom (neutral by default -> classic offset).
      const camOffset = this.followOffset(this.minDistance, playerRotation.y);

      // Set camera directly to its final position
      const camPos = new THREE.Vector3().copy(playerPosition).add(camOffset);
      this.camera.position.copy(camPos);
      
      // Ensure all vectors are properly set to match this position
      this.smoothingVectors.lastPosition.copy(camPos);
      this.smoothingVectors.targetPosition.copy(camPos);
      this.smoothingVectors.lookAtPosition.copy(playerPosition);
      
      // Look at the player
      this.camera.lookAt(playerPosition);
      return;
    }
    
    // Calculate current speed for dynamic camera positioning
    const currentSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);

    // Travel-heading turn rate for the Auto situational profile: how hard the line is
    // curving this frame (tight tree-line carves pull the camera IN). Tracked every
    // third-person frame — including during a manual hold — so the delta is current when
    // Auto resumes. Only meaningful while actually moving; a near-stop clears the memory
    // so the first heading after it doesn't read as a huge jump.
    let turnRate = 0;
    if (currentSpeed > 1) {
      const heading = Math.atan2(velocity.x, velocity.z);
      if (this.lastTravelHeading !== null) {
        turnRate = Math.abs(wrapAngle(heading - this.lastTravelHeading));
      }
      this.lastTravelHeading = heading;
    } else {
      this.lastTravelHeading = null;
    }

    // Per-mode view easing (runs once a recent manual nudge has expired):
    //  - auto:   recenter the orbit behind travel AND ease the situational zoom/pitch profile.
    //  - follow: recenter the orbit behind travel, but leave the player's zoom alone.
    //  - orbit:  no easing — the player's yaw/pitch/zoom are held exactly as set.
    if (this.manualHoldFrames > 0) {
      this.manualHoldFrames--;
    } else if (this.mode === 'auto') {
      // Terrain steepness under the player (gradient magnitude, rise/run ≈ tan θ) drives the
      // expert-terrain pull-back + overhead lift; the loop's context adds jump / avalanche.
      const grad = Mountains.getTerrainGradient(playerPosition.x, playerPosition.z);
      const slope = Math.sqrt(grad.x * grad.x + grad.z * grad.z);
      this.applyAutoFrame(currentSpeed, slope, turnRate, this.camera.aspect, context);
    } else if (this.mode === 'follow') {
      this.orbitYaw += (0 - this.orbitYaw) * AUTO_FRAME_EASE;
      this.orbitPitch += (0 - this.orbitPitch) * AUTO_FRAME_EASE;
    }

    // Calculate dynamic distance based on speed, then apply the current orbit + zoom.
    const dynamicDistance = this.minDistance + Math.min(1.0, currentSpeed / this.speedThreshold) * (this.maxDistance - this.minDistance);
    const camOffset = this.followOffset(dynamicDistance, playerRotation.y);

    // Calculate target position
    this.smoothingVectors.targetPosition.copy(playerPosition).add(camOffset);
    
    // For the first 2 frames, use a higher smoothing factor to quickly snap to position if needed
    let effectiveSmoothingFactor = this.smoothing;
    if (this.frameCount <= 2) {
      effectiveSmoothingFactor = 0.5; // Quick correction in first frames if needed
    }
    
    // Apply smoothing - interpolate current position toward target
    this.camera.position.lerp(this.smoothingVectors.targetPosition, effectiveSmoothingFactor);
    
    // Maintain minimum height above terrain to prevent camera from going below ground
    const terrainHeightAtCamera = Mountains.getTerrainHeight(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < terrainHeightAtCamera + 5) {
      this.camera.position.y = terrainHeightAtCamera + 5;
    }
    
    // Also smooth the lookAt point, focusing slightly ahead of the player in movement direction
    this.smoothingVectors.lookAtPosition.copy(playerPosition);
    
    // Add a small forward offset based on speed vector to look ahead slightly
    const speedMagnitude = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    if (speedMagnitude > 1) {
      const lookAheadFactor = Math.min(5, speedMagnitude * 0.3);
      this.smoothingVectors.lookAtPosition.x += (velocity.x / speedMagnitude) * lookAheadFactor;
      this.smoothingVectors.lookAtPosition.z += (velocity.z / speedMagnitude) * lookAheadFactor;
    }
    
    this.camera.lookAt(this.smoothingVectors.lookAtPosition);
    
    // Save current position for next frame
    this.smoothingVectors.lastPosition.copy(this.camera.position);
  }
  
  // First-person camera update method
  updateFirstPerson(playerPosition: THREE.Vector3, playerRotation: THREE.Euler, velocity: PlanarVelocity) {
    // Calculate a position slightly behind and above the snowman's head
    // to prevent obstruction by the character model
    const angle = playerRotation.y;
    
    // Position camera significantly above and behind the head
    const cameraOffset = new THREE.Vector3(
      // Slightly to the right of center (0.2 units) to avoid the nose
      -Math.sin(angle) * 2.5 + 0.2,
      // Well above the head (head is at 7.5, camera at 10.0)
      10.0,
      // Further behind the head by 2.5 units
      -Math.cos(angle) * 2.5
    );
    
    // Position camera relative to player
    const cameraPosition = new THREE.Vector3().copy(playerPosition).add(cameraOffset);
    this.camera.position.copy(cameraPosition);
    
    // Match camera rotation with snowman's rotation direction
    this.camera.rotation.set(playerRotation.x, playerRotation.y, playerRotation.z);
    
    // Add a more significant forward-looking offset for better visibility
    const speedMagnitude = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    
    // Calculate a point to look at ahead of the snowman, increased distance for better visibility
    const lookAheadFactor = Math.min(10, Math.max(6, speedMagnitude * 0.5));
    const lookTarget = new THREE.Vector3(
      playerPosition.x + Math.sin(angle) * lookAheadFactor,
      // Look more downward for better terrain visibility due to higher camera
      playerPosition.y + 6.0, 
      playerPosition.z + Math.cos(angle) * lookAheadFactor
    );
    this.camera.lookAt(lookTarget);
  }

  // Handle window resize
  handleResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  // Get camera for rendering
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }
}

// Camera is imported directly by snowglider.js (issue #84).