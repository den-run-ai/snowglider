// snowman.ts - Snowman model and functions for SnowGlider game
//
// Phase 2.8 (issue #84): final terrain-cluster module converted off the classic
// global model. `THREE` now comes from the npm package via a real ES-module
// import instead of the CDN global, and `Snowman` is `export`ed. snowman.js
// receives the terrain samplers (getTerrainHeight/getTerrainGradient/
// getDownhillDirection) as function arguments (not globals); it is loaded into the
// page through the bundle entry (src/main.js) and imported by snowglider.js.
//
// Phase 3.7 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
// (implied for a real `.ts` file) and the movement/physics contract is now
// expressed as real type declarations: the player position/velocity inputs, the
// injected terrain samplers, the controls object, the tree-collision shape, the
// camera-manager seam, and the per-frame `UpdateResult`. The physics math is
// byte-identical — every edit is type-only/erasable, so esbuild (Vite) and Node's
// native type-stripping run it exactly as before; the physics-invariant harness
// confirms coasting stays bit-identical to the frozen baseline.
import * as THREE from 'three';
import { detectCollisionsAndFinish } from './collision.js';
import { createSnowman } from './model.js';
import { resetSnowman, stepSnowmanPhysics } from './physics.js';
import { applySnowmanPose } from './pose.js';
import { addTestHooks } from './test-hooks.js';

// These contract types are exported so the typed player-state layer in
// physics.ts (PR 3.21) shares snowman's exact call contract instead of
// re-declaring it. Exporting interfaces/types is purely additive and erasable.

/** Mutable player position the physics integrates each frame. */
export interface PlayerPos {
  x: number;
  y: number;
  z: number;
}

/** Mutable horizontal velocity (vertical motion is tracked by verticalVelocity). */
export interface PlanarVelocity {
  x: number;
  z: number;
}

/** A 2D terrain vector: a gradient or a unit downhill direction. */
interface TerrainVec2 {
  x: number;
  z: number;
}

/** Terrain height sampler injected by the orchestrator. */
export type TerrainHeightFn = (x: number, z: number) => number;
/** Terrain gradient / downhill-direction sampler injected by the orchestrator. */
export type TerrainVecFn = (x: number, z: number) => TerrainVec2;

/** The control flags updateSnowman reads each frame. */
export interface SnowmanControls {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
}

/** Minimal tree-position shape the collision check reads. */
export interface TreePos {
  x: number;
  y: number;
  z: number;
}

/** Minimal rock-position shape the collision check reads. */
export interface RockPos {
  x: number;
  y: number;
  z: number;
  size: number;
}

/** The camera-manager seam resetSnowman drives (satisfied by the Camera class). */
export interface CameraManagerLike {
  initialize(position: THREE.Vector3, rotation: THREE.Euler): void;
}

/** Game-over callback handed in by the orchestrator. */
export type ShowGameOverFn = (reason: string) => void;

/** Ski technique surfaced for the HUD + ski pose. */
export type SkiTechnique = 'air' | 'glide' | 'snowplow' | 'skid' | 'carve' | 'parallel' | 'tuck' | 'hop';

/** Per-frame physics output returned by updateSnowman. */
export interface UpdateResult {
  isInAir: boolean;
  verticalVelocity: number;
  lastTerrainHeight: number;
  airTime: number;
  jumpCooldown: number;
  turnPhase: number;
  currentTurnDirection: number;
  turnChangeCooldown: number;
  currentSpeed: number;
  technique: SkiTechnique;
  justLanded: boolean;
  landingForce: number;
}

// Update snowman physics and movement
function updateSnowman(snowman: THREE.Object3D, delta: number, pos: PlayerPos, velocity: PlanarVelocity, isInAir: boolean, verticalVelocity: number,
                      lastTerrainHeight: number, airTime: number, jumpCooldown: number, controls: SnowmanControls,
                      turnPhase: number, currentTurnDirection: number, turnChangeCooldown: number, turnAmplitude: number,
                      getTerrainHeight: TerrainHeightFn, getTerrainGradient: TerrainVecFn, getDownhillDirection: TerrainVecFn,
                      treePositions: TreePos[], gameActive: boolean, showGameOver: ShowGameOverFn,
                      rockPositions: RockPos[] = []): UpdateResult {
  const { terrainHeightAtPosition, result } = stepSnowmanPhysics(
    snowman,
    delta,
    pos,
    velocity,
    isInAir,
    verticalVelocity,
    lastTerrainHeight,
    airTime,
    jumpCooldown,
    controls,
    turnPhase,
    currentTurnDirection,
    turnChangeCooldown,
    turnAmplitude,
    getTerrainHeight,
    getTerrainGradient,
    getDownhillDirection
  );

  applySnowmanPose(snowman, {
    delta,
    pos,
    velocity,
    isInAir: result.isInAir,
    verticalVelocity: result.verticalVelocity,
    currentSpeed: result.currentSpeed,
    technique: result.technique,
    // Steering sign for parallel ski angulation — recomputed from `controls`
    // (in scope here) so the cosmetic pose matches #146.
    steering: (controls.left ? -1 : 0) + (controls.right ? 1 : 0),
    getTerrainHeight
  });

  isInAir = result.isInAir;
  verticalVelocity = result.verticalVelocity;

  detectCollisionsAndFinish({
    pos,
    isInAir,
    verticalVelocity,
    terrainHeightAtPosition,
    treePositions,
    rockPositions,
    gameActive,
    showGameOver
  });

  // Return updated state variables
  return result;
}

// Export snowman functions
export const Snowman = {
  createSnowman,
  resetSnowman,
  updateSnowman,
  addTestHooks
};

// Snowman is imported directly by snowglider.js and the gameplay browser tests
// (issue #84).
