// player-state.ts - Typed player-physics state container + per-frame stepping for SnowGlider.
//
// Phase 3.21 (issues #84, #98): extracts the player's per-frame physics *state*
// — the cluster of mutable scalars (air / jump / auto-turn) plus the shared
// position and velocity objects — out of the snowglider.ts orchestrator, where
// it lived as ~11 loose module-scoped `let`s/`const`s aliased across modules.
// It now lives in one typed `PlayerState` object: the real fix for the
// shared-mutable-global aliasing that types alone can't catch (see
// `ARCHITECTURE.md`, "What the type system won't catch").
//
// The physics *math* is deliberately unchanged: it still lives in snowman.ts
// (`Snowman.updateSnowman` / `Snowman.resetSnowman`). This module is the thin,
// stateful integration layer on top of that kernel:
//   - createPlayerState() — the initial run state
//   - resetPlayer()       — reset to the start of a run (delegates to Snowman.resetSnowman)
//   - stepPlayer()        — advance one frame (delegates to Snowman.updateSnowman) and
//                           write the result's mutable scalars back into the state object
// Because the kernel is untouched, the physics-invariant harness (which imports
// snowman.ts directly) is unaffected and coasting stays byte-identical.
import type * as THREE from 'three';
import {
  Snowman,
  type PlayerPos,
  type PlanarVelocity,
  type TerrainHeightFn,
  type TerrainVecFn,
  type SnowmanControls,
  type TreePos,
  type RockPos,
  type CameraManagerLike,
  type ShowGameOverFn,
  type UpdateResult,
} from './snowman.js';

/** Auto-turn amplitude fed to the snowman physics each frame (was the
 * `turnAmplitude` const in the orchestrator). */
export const TURN_AMPLITUDE = 3.0;

/**
 * The per-frame, mutable player physics state. `pos`/`velocity` are shared
 * objects mutated in place (and passed by reference to course / camera / snow /
 * snowman); the scalars are reassigned each frame from the snowman step's
 * result. Owning them here makes that mutation a typed, single-source-of-truth
 * object instead of aliased module globals.
 */
export interface PlayerState {
  pos: PlayerPos;             // world position (mutated in place)
  velocity: PlanarVelocity;   // horizontal velocity (mutated in place)
  isInAir: boolean;
  verticalVelocity: number;
  jumpCooldown: number;
  lastTerrainHeight: number;
  airTime: number;
  turnPhase: number;          // auto-turn phase accumulator
  currentTurnDirection: number;
  turnChangeCooldown: number;
}

/** Per-frame inputs stepPlayer needs beyond the player state itself. */
export interface StepDeps {
  snowman: THREE.Object3D;
  delta: number;
  controls: SnowmanControls;
  getTerrainHeight: TerrainHeightFn;
  getTerrainGradient: TerrainVecFn;
  getDownhillDirection: TerrainVecFn;
  treePositions: TreePos[];
  rockPositions: RockPos[];
  gameActive: boolean;
  showGameOver: ShowGameOverFn;
  // Meaningful jumps (#47): bank a manual jump's air score from inside the kernel
  // step, *before* its synchronous finish check can build the result screen. Optional
  // so headless callers (the physics-invariant harness) need not provide it.
  bankAirScore?: (delta: number) => void;
}

/** Build the initial run state (matches the orchestrator's old module-scoped
 * defaults: start high on the slope, no velocity, grounded). */
function createPlayerState(getTerrainHeight: TerrainHeightFn): PlayerState {
  return {
    pos: { x: 0, z: -40, y: getTerrainHeight(0, -40) },
    velocity: { x: 0, z: 0 },
    isInAir: false,
    verticalVelocity: 0,
    jumpCooldown: 0,
    lastTerrainHeight: 0,
    airTime: 0,
    turnPhase: 0,
    currentTurnDirection: 0,
    turnChangeCooldown: 0,
  };
}

/** Reset the player to the start of a run. Delegates the position/velocity reset
 * (and camera re-init) to Snowman.resetSnowman, then clears the air / auto-turn
 * scalars exactly as the orchestrator's resetSnowman() did. */
function resetPlayer(
  player: PlayerState,
  snowman: THREE.Object3D,
  getTerrainHeight: TerrainHeightFn,
  cameraManager: CameraManagerLike
): void {
  // Snowman.resetSnowman mutates player.pos/player.velocity in place and returns
  // the terrain height used to seed lastTerrainHeight.
  player.lastTerrainHeight = Snowman.resetSnowman(snowman, player.pos, player.velocity, getTerrainHeight, cameraManager);

  // Reset automatic turning variables to avoid initial random turns.
  player.turnPhase = 0;
  player.currentTurnDirection = 0;
  player.turnChangeCooldown = 3.0; // Longer initial cooldown to prevent immediate turns

  // Reset air state variables.
  player.isInAir = false;
  player.verticalVelocity = 0;
  player.jumpCooldown = 0;
  player.airTime = 0;
}

/** Advance the player one frame. Delegates the physics integration to
 * Snowman.updateSnowman, writes the mutated scalars back into `player`, and
 * returns the full per-frame result for the HUD / camera juice. */
function stepPlayer(player: PlayerState, deps: StepDeps): UpdateResult {
  const result = Snowman.updateSnowman(
    deps.snowman, deps.delta, player.pos, player.velocity, player.isInAir, player.verticalVelocity,
    player.lastTerrainHeight, player.airTime, player.jumpCooldown, deps.controls,
    player.turnPhase, player.currentTurnDirection, player.turnChangeCooldown, TURN_AMPLITUDE,
    deps.getTerrainHeight, deps.getTerrainGradient, deps.getDownhillDirection,
    deps.treePositions, deps.gameActive, deps.showGameOver, deps.rockPositions, deps.bankAirScore
  );

  // Write the mutable scalars back (pos/velocity were mutated in place above).
  player.isInAir = result.isInAir;
  player.verticalVelocity = result.verticalVelocity;
  player.lastTerrainHeight = result.lastTerrainHeight;
  player.airTime = result.airTime;
  player.jumpCooldown = result.jumpCooldown;
  player.turnPhase = result.turnPhase;
  player.currentTurnDirection = result.currentTurnDirection;
  player.turnChangeCooldown = result.turnChangeCooldown;

  return result;
}

// Imported by snowglider.js (the orchestrator). The physics math stays in
// snowman.ts; this module owns the typed player state and the step/reset wiring.
export const Physics = {
  TURN_AMPLITUDE,
  createPlayerState,
  resetPlayer,
  stepPlayer,
};
