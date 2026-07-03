// Teardown / disposal for SnowGlider (dispose-audit plan). A single idempotent
// `disposeGame(ctx)` entry point that releases EVERY resource the one-shot
// `setupScene()` allocated — the WebGL context, the scene graph's GPU buffers, the
// subsystem InstancedMeshes, the pooled tree assets, the canvas DOM node, and the
// game-lifetime DOM listeners — so the game can be unmounted cleanly.
//
// WHY THIS EXISTS (there is no production leak — see the plan §1)
// --------------------------------------------------------------
// The run/restart flow correctly REUSES the scene (lifecycle.ts resets state in
// place and never rebuilds terrain/trees/snowman), so restarting leaks nothing and
// this path is never on it. The teardown matters in three places the page-IS-the-game
// model never exercised:
//   1. Vite dev HMR — every hot edit re-evaluates the module graph; without a
//      `import.meta.hot.dispose` hook the previous WebGL context, listeners, and GPU
//      buffers are never released, stacking "too many active contexts" warnings and
//      leaking memory across a dev session.
//   2. Embedding / unmount — the moment SnowGlider lives in a route that can unmount
//      (SPA, modal, portfolio site) navigation leaks the whole context + buffers.
//   3. Forest rebuild groundwork — the instanced forest's per-forest instance buffers
//      need disposal if the forest is ever rebuilt; this is the natural home for it.
//
// DEDUP IS LOAD-BEARING. Geometries/materials/textures are SHARED singletons (the
// tree pools, one avalanche InstancedMesh, etc.), so a naive per-mesh `traverse`
// dispose would free the same pooled buffer many times. `disposeSceneResources`
// collects each UNIQUE resource into a Set and disposes it exactly once; the tree
// pools are additionally nulled via `resetTreePools()` so a later rebuild re-creates
// them instead of referencing freed handles.

import * as THREE from 'three';
import { resetTreePools } from '../trees.js';
import { resetSnowmanSnowMaterial } from '../snowman/snow-material.js';
import { TreeShed } from '../tree-shed.js';
import type { SceneContext } from './scene-setup.js';

// Idempotence guard, keyed on the context object (not a shared module bool) so each
// SceneContext disposes at most once while distinct contexts — e.g. across test
// cases — stay independent. A WeakSet lets a disposed context be GC'd.
const disposedContexts = new WeakSet<object>();

/**
 * Dispose every UNIQUE GPU resource reachable from the scene graph, exactly once.
 *
 * Geometries, materials, and the textures hung off those materials (`map`,
 * `normalMap`, …) are deduped through Sets before disposal, because the scene shares
 * pooled singletons across many meshes — disposing per-traversed-mesh would free the
 * same buffer repeatedly (and could free a resource still referenced elsewhere). The
 * caller is responsible for nulling any module-level caches that point at these
 * now-freed handles (see `resetTreePools`).
 *
 * InstancedMesh nodes (the forest, avalanche boulders, snow-trail grooves) own
 * per-instance GPU buffers (`instanceMatrix`/`instanceColor`) that `geometry.dispose()`
 * does NOT free — only `InstancedMesh.dispose()` does. They are disposed here too so the
 * sweep actually releases every GPU buffer, not just the shared geometry/material.
 */
export function disposeSceneResources(scene: THREE.Scene): void {
  const geoms = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  const texes = new Set<THREE.Texture>();
  const instanced = new Set<THREE.InstancedMesh>();

  scene.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (m.geometry) geoms.add(m.geometry);
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => { if (x) mats.add(x); });
    else if (mat) mats.add(mat);
    // Custom shadow-pass materials (e.g. the swaying-tree customDepthMaterial) are NOT reachable
    // via obj.material, so collect them explicitly — otherwise the shadow-caster material/program
    // leaks when a caller uses this sweep without the module's own pool reset. Shared/pooled
    // instances dedup in the Set and dispose() is idempotent, so this is safe next to resetTreePools.
    if (m.customDepthMaterial) mats.add(m.customDepthMaterial);
    if (m.customDistanceMaterial) mats.add(m.customDistanceMaterial);
    // InstancedMesh owns instanceMatrix/instanceColor buffers freed only by its own
    // dispose() (geometry/material handled above). Each is a distinct scene node, so no
    // dedup is needed — but a Set keeps the disposal uniform and double-call-safe.
    if ((obj as THREE.InstancedMesh).isInstancedMesh) instanced.add(obj as THREE.InstancedMesh);
  });

  // Collect textures off each material before disposing it (map/normalMap/etc.).
  for (const mat of mats) {
    const fields = mat as unknown as Record<string, unknown>;
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      // `instanceof` narrows to Texture<any, any>; cast to the canonical Texture
      // type so the Set.add argument is type-safe (no-unsafe-argument).
      if (v instanceof THREE.Texture) texes.add(v as THREE.Texture);
    }
    mat.dispose();
  }
  for (const g of geoms) g.dispose();
  for (const t of texes) t.dispose();
  // Free the per-instance buffers last (geometry/material already gone above; THREE's
  // InstancedMesh.dispose only releases instanceMatrix/instanceColor, so order is moot).
  for (const im of instanced) im.dispose();
}

/**
 * Idempotently tear down a SnowGlider instance: stop the loop, free all GPU
 * resources, drop the renderer + WebGL context, detach the canvas, and remove the
 * game-lifetime DOM listeners (via the injected `teardownListeners`, which aborts the
 * coordinator's AbortController). A second call with the same `ctx` is a no-op.
 *
 * Does NOT touch the run/restart flow — that path deliberately reuses the scene.
 *
 * @param ctx               the handles returned by `setupScene()`
 * @param teardownListeners removes the game-lifetime listeners (AbortController.abort)
 */
export function disposeGame(ctx: SceneContext, teardownListeners?: () => void): void {
  if (disposedContexts.has(ctx)) return; // idempotent: second dispose is a no-op
  disposedContexts.add(ctx);

  // 1. Stop the loop.
  ctx.state.gameActive = false;
  ctx.state.animationRunning = false;

  // 2. Dispose every unique GPU resource reachable from the scene, once.
  disposeSceneResources(ctx.scene);

  // 3. Subsystems that own buffers/meshes (mirror their existing patterns). debris
  //    disposes its owned fragments via reset(); snowTrails/avalanche detach their
  //    InstancedMesh and free its geometry/material. Double-dispose with the scene
  //    sweep above is safe (THREE's dispose tolerates a second call).
  ctx.state.debris?.reset();
  ctx.state.snowTrails?.dispose();
  ctx.state.avalanche?.dispose();

  // 4. Null the pooled tree singletons so a later rebuild re-creates them cleanly
  //    instead of holding freed-but-still-referenced handles (the scene sweep already
  //    disposed the scene-attached ones; this frees the rest and clears the caches).
  resetTreePools();
  // ... the shared snowman/debris snow material cache likewise (the sweep just
  //    disposed the material + its textures; a remount must rebuild, not reuse).
  resetSnowmanSnowMaterial();
  // ... and the shed system's pooled puff sprites/texture + its stale load state
  //    (its bindings point into the buffers the sweep above just freed).
  TreeShed.teardown();

  // 5. Renderer + WebGL context. Wrapped because forceContextLoss touches the live GL
  //    context, which can throw in a headless / already-lost environment.
  try {
    ctx.renderer.dispose();
    ctx.renderer.forceContextLoss();
  } catch (e) {
    console.log('disposeGame: renderer teardown skipped:', (e as Error).message);
  }

  // 6. Instance-owned DOM nodes. setupScene() appends the `#gameCanvas` wrapper (which
  //    holds renderer.domElement) and `#gameOverOverlay`; initLifecycleUI() appends
  //    `#cameraToggleBtn` and the `#cameraControls` tray. Removing only the canvas would
  //    leave the wrapper + overlay + camera UI in the document, so a remount creates
  //    duplicate IDs and stale UI,
  //    and getElementById('gameCanvas') / overlay queries hit the old empty node. Remove
  //    every owner node. (The wrapper is the canvas's parent, so detaching it takes the
  //    canvas with it.) Reset/start buttons authored in index.html are NOT ours to remove.
  const removeNode = (el: Node | null | undefined): void => { el?.parentNode?.removeChild(el); };
  removeNode(ctx.renderer.domElement.parentNode); // the #gameCanvas wrapper (+ its canvas)
  removeNode(ctx.gameOverOverlay);
  if (typeof document !== 'undefined') {
    removeNode(document.getElementById('cameraToggleBtn'));
    // Camera control tray (lifecycle.ts initCameraControls appends #cameraControls).
    removeNode(document.getElementById('cameraControls'));
    // Mobile visual controls (controls.ts appends these lazily on touch devices); they
    // have no module state to null, so remove them by class here.
    document.querySelectorAll('.touch-control').forEach((el) => el.remove());
  }
  // Subsystem HUD owned by CourseModule/EffectsModule (#courseHud, #courseFlash, the
  // avalanche banner/meter/vignette) is removed by their own teardown(), invoked from
  // the coordinator's disposeSnowGlider — those modules hold the node + state handles.

  // 7. Game-lifetime DOM listeners (resize, keyboard/touch, buttons, …) — one abort
  //    removes them all (Controls + scene-setup + lifecycle + the coordinator's resize).
  if (teardownListeners) teardownListeners();
}
