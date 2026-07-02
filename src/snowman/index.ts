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
import type { SnowmanPhysicsTuning } from '../difficulty.js';
import { detectCollisionsAndFinish, type ObstacleClear } from './collision.js';
import { createSnowman } from './model.js';
import { CLEAR_MAX_PER_AIR, CLEAR_SCORE, resetSnowman, stepSnowmanPhysics } from './physics.js';
import { applySnowmanPose } from './pose.js';
import { addTestHooks } from './test-hooks.js';

// These contract types are exported so the typed player-state layer in
// player-state.ts (PR 3.21) shares snowman's exact call contract instead of
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

/** How a *manual* jump's landing was graded (meaningful jumps #47, §3.2). Null on
 *  any non-manual-jump landing (auto-jump / hop / no landing this frame). */
export type LandingQuality = 'clean' | 'ok' | 'sketchy';

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
  // Meaningful jumps (#47): set only on the frame a *manual* (player-initiated)
  // jump lands. `landingQuality` is null on every other frame; `airScoreDelta` is
  // the air-score points earned this frame (0 unless a manual jump just landed).
  landingQuality: LandingQuality | null;
  airScoreDelta: number;
  // Freestyle tricks (#32, Expert tier): the completed-trick toast label (e.g.
  // "360", "BACKFLIP + GRAB"), set only on the frame a manual jump lands with at
  // least one completed trick component. Null on every other frame and on every
  // non-freestyle tier; the trick points ride inside airScoreDelta.
  trickName: string | null;
  // Scored obstacle clears (jump-system completion JP-2, #245): the obstacle type
  // when a *manual* jump cleared a would-have-hit tree/rock this frame (deduped per
  // obstacle, capped per air phase; the points bank via bankAirScore). Null on every
  // other frame — auto-jump / hop air never scores a clear (playerJump provenance).
  obstacleCleared: 'tree' | 'rock' | null;
}

// Update snowman physics and movement
function updateSnowman(snowman: THREE.Object3D, delta: number, pos: PlayerPos, velocity: PlanarVelocity, isInAir: boolean, verticalVelocity: number,
                      lastTerrainHeight: number, airTime: number, jumpCooldown: number, controls: SnowmanControls,
                      turnPhase: number, currentTurnDirection: number, turnChangeCooldown: number, turnAmplitude: number,
                      getTerrainHeight: TerrainHeightFn, getTerrainGradient: TerrainVecFn, getDownhillDirection: TerrainVecFn,
                      treePositions: TreePos[], gameActive: boolean, showGameOver: ShowGameOverFn,
                      rockPositions: RockPos[] = [], bankAirScore?: (delta: number) => void,
                      tuning?: SnowmanPhysicsTuning): UpdateResult {
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
    getDownhillDirection,
    // undefined => stepSnowmanPhysics applies its BLUE default (byte-identical).
    tuning
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

  // Bank a graded manual-jump's air score BEFORE the finish/collision check below.
  // detectCollisionsAndFinish can fire showGameOver synchronously on the finish frame
  // (pos.z < -195), which builds the result screen via CourseModule.onFinish — so if a
  // manual jump lands on the same frame the player crosses the line, banking here is
  // what gets that last jump's score onto the result screen (meaningful jumps #47).
  // Gated on airScoreDelta > 0 (a player-jump landing only), so the no-input path and
  // the physics-invariant harness — which passes no bankAirScore — are untouched.
  if (bankAirScore && result.airScoreDelta > 0) bankAirScore(result.airScoreDelta);

  detectCollisionsAndFinish({
    pos,
    isInAir,
    verticalVelocity,
    terrainHeightAtPosition,
    treePositions,
    rockPositions,
    gameActive,
    showGameOver,
    // Scored obstacle clears (JP-2, #245): collision.ts reports every airborne
    // "would-have-hit but sailed over" observation; the POLICY lives here —
    //   provenance: only a *manual* jump's air scores (playerJump still true while
    //     airborne; auto-jump/hop air banks nothing, the §3.1 discipline);
    //   dedup: one pass over an obstacle spans many overlap frames — the per-air
    //     `clearedObstacles` set (stamped fresh at each manual takeoff) counts it once;
    //   cap: at most CLEAR_MAX_PER_AIR scored clears per air phase;
    //   banking: CLEAR_SCORE per clear through the SAME bankAirScore path as the
    //     landing score — and collision.ts invokes this callback BEFORE its finish
    //     check can synchronously build the result screen, so a clear on the finish
    //     frame still counts (#186 rationale).
    // The callback runs synchronously inside detectCollisionsAndFinish, so stamping
    // `result.obstacleCleared` here is visible to this frame's caller (toast cue).
    onObstaclesCleared: (clears: ObstacleClear[]) => {
      const ud = snowman.userData;
      if (!ud || !ud.playerJump) return;
      if (!ud.clearedObstacles) ud.clearedObstacles = {};
      const seen = ud.clearedObstacles as Record<string, boolean>;
      for (const clear of clears) {
        if (seen[clear.key]) continue;
        seen[clear.key] = true;
        const count = ((ud.clearsThisAir as number) || 0) + 1;
        ud.clearsThisAir = count;
        if (count > CLEAR_MAX_PER_AIR) continue;
        result.obstacleCleared = clear.type;
        if (bankAirScore) bankAirScore(CLEAR_SCORE);
      }
    }
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
