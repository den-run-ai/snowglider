// @ts-check
/**
 * Unit tests for the Trees module (src/mountains/trees.ts) after the forest was
 * converted to InstancedMesh rendering (PR #221).
 *
 * The live game's `addTrees` instanced path is exercised by the browser/e2e suites,
 * but the Group-returning `createTree` shim, the Object3D-emitting
 * `addBranchesAtLayer`/`addSnowCaps` shims, the legacy palette materials they rebuild
 * from, and the dispose-on-reinit teardown are not reachable from the running game
 * (which only ever takes the instanced path). They ARE the public API surface other
 * callers/headless consumers rely on, so this test drives them directly. Everything
 * here is headless-safe: THREE constructs scene objects without a WebGL context, the
 * terrain samplers are analytic, and the bark/foliage normal maps are null without a
 * `document` (the instanced materials treat a null normalMap as no map).
 *
 * Node-only test in the CommonJS + dynamic-`import()` style of the other loader-based
 * suites (terrain-tests.js, player-state-tests.js). Run with the .js -> .ts resolve
 * hook so trees.ts's `./terrain.js` etc. imports resolve to their .ts siblings:
 *   node --import ./tests/loaders/register-ts-resolve.mjs tests/trees-tests.js
 */

let passed = 0;
let failed = 0;

function assert(cond, name, message) {
  if (cond) {
    passed++;
    console.log(`✅ PASS: ${name}${message ? ' - ' + message : ''}`);
  } else {
    failed++;
    console.log(`❌ FAIL: ${name}${message ? ' - ' + message : ''}`);
  }
}

async function main() {
  const THREE = await import('three');
  const { Trees } = await import('../src/trees.js');

  // --- createTree shim: returns a real Group of individual Meshes --------------
  // Exercises createTree -> collectTree/collectBranchesAtLayer/collectSnowCaps ->
  // meshFromDesc, plus the legacy getTrunkMaterials/getFoliageMaterials/
  // getSnowMaterial the rebuilt Meshes draw from.
  {
    const tree = Trees.createTree(1.0);
    assert(tree instanceof THREE.Group, 'createTree returns a Group');
    assert(tree.children.length > 3, 'createTree Group has the expected parts',
      `${tree.children.length} child meshes`);
    assert(tree.children.every(c => c instanceof THREE.Mesh),
      'every createTree child is a Mesh');

    const trunk = /** @type {any} */ (tree.children[0]);
    assert(trunk && trunk.material && trunk.material.isMeshStandardMaterial,
      'createTree trunk uses a shared MeshStandardMaterial');
    assert(trunk.castShadow === true, 'createTree parts cast shadows');

    // Scale variation is applied (canonical geometry resized, not duplicated).
    const small = Trees.createTree(0.5);
    assert(small instanceof THREE.Group && small.children.length > 0,
      'createTree honours a scale argument');
  }

  // --- addBranchesAtLayer shim: appends branch meshes to a parent --------------
  {
    const parent = new THREE.Object3D();
    Trees.addBranchesAtLayer(parent, new THREE.Vector3(0, 8, 0), 2.0);
    assert(parent.children.length >= 3, 'addBranchesAtLayer appends branches',
      `${parent.children.length} branches`);
    assert(parent.children.every(c => c instanceof THREE.Mesh),
      'addBranchesAtLayer children are Meshes');
  }

  // --- addSnowCaps shim: appends a snow cap (and sometimes patches) ------------
  // Force the patch branch (Math.random() > 0.4) so the optional snow-patch loop is
  // covered deterministically, then restore the RNG.
  {
    const tree = new THREE.Object3D();
    const realRandom = Math.random;
    Math.random = () => 0.99; // always take the patch branch, fixed sizes
    try {
      Trees.addSnowCaps(tree, 12, 1.0);
    } finally {
      Math.random = realRandom;
    }
    assert(tree.children.length >= 1, 'addSnowCaps appends a snow cap (+ patches)',
      `${tree.children.length} snow meshes`);
    assert(tree.children.every(c => c instanceof THREE.Mesh),
      'addSnowCaps children are Meshes');
  }

  // --- addTrees: builds the instanced forest, rebuilds cleanly on re-init -------
  {
    const scene = new THREE.Scene();
    const positions = Trees.addTrees(scene);
    assert(Array.isArray(positions) && positions.length > 0,
      'addTrees returns a non-empty treePositions array', `${positions.length} trees`);

    const forest = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    assert(forest.length >= 1 && forest.length <= 5,
      'forest renders as a handful of InstancedMeshes', `${forest.length} meshes`);
    assert(forest.every(m => m.isInstancedMesh), 'forest meshes are InstancedMeshes');

    const trunk = forest.find(m => m.userData.forestPart === 'trunk');
    assert(!!trunk, 'a trunk InstancedMesh is tagged via userData.forestPart');
    // One trunk instance per placed tree — the exact contract the browser test checks.
    assert(trunk && trunk.count === positions.length,
      'trunk instance count equals treePositions.length',
      trunk ? `${trunk.count} === ${positions.length}` : 'no trunk mesh');

    // Tinted families carry per-instance colour; snow does not.
    assert(trunk && trunk.instanceColor != null,
      'trunk InstancedMesh has per-instance colour');
    const snowCap = forest.find(m => m.userData.forestPart === 'snowCap');
    assert(!snowCap || snowCap.instanceColor == null,
      'snow caps use a shared white material (no instanceColor)');

    // Re-init: a second addTrees must dispose the old forest and rebuild without
    // accumulating duplicate InstancedMeshes in the scene (covers the teardown loop).
    const positions2 = Trees.addTrees(scene);
    const forest2 = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    assert(forest2.length === forest.length,
      're-init rebuilds the forest without duplicating instanced meshes',
      `${forest2.length} meshes after re-init`);
    assert(positions2.length > 0, 're-init still returns tree positions');
  }

  // --- Multi-scene teardown is scene-local (Codex review #221) -----------------
  // addTrees must clear/dispose only the forest in the scene it is given. A second
  // scene's addTrees must NOT remove or dispose the forest still live in the first
  // scene. Listen for the InstancedMesh 'dispose' event on scene A's forest, then
  // populate scene B and assert A was left untouched (the regression would no-op the
  // remove against B but still dispose A's meshes, leaving disposed forest in A).
  {
    const sceneA = new THREE.Scene();
    Trees.addTrees(sceneA);
    const forestA = /** @type {any[]} */ (sceneA.children.filter(c => c.name === 'forestInstanced'));
    assert(forestA.length >= 1, 'scene A gets its own forest', `${forestA.length} meshes`);

    let sceneADisposed = false;
    forestA.forEach(m => m.addEventListener('dispose', () => { sceneADisposed = true; }));

    const sceneB = new THREE.Scene();
    Trees.addTrees(sceneB);

    assert(!sceneADisposed,
      "addTrees on a second scene does not dispose the first scene's forest");
    const forestAAfter = /** @type {any[]} */ (sceneA.children.filter(c => c.name === 'forestInstanced'));
    assert(forestAAfter.length === forestA.length,
      'first scene keeps its forest when a second scene is populated',
      `${forestAAfter.length} meshes still in scene A`);
    const forestB = /** @type {any[]} */ (sceneB.children.filter(c => c.name === 'forestInstanced'));
    assert(forestB.length >= 1, 'second scene gets its own independent forest',
      `${forestB.length} meshes`);
  }

  // --- resetTreePools: dispose + null the shared geometry/material/texture pools -----
  // Added for the dispose-audit teardown (disposeGame): the pools are app-lifetime
  // singletons, so resetTreePools must free them AND null the caches so a later rebuild
  // re-creates fresh handles instead of dangling on freed ones.
  {
    const disposedGeo = new Set();
    const geoProto = THREE.BufferGeometry.prototype;
    const realDispose = geoProto.dispose;
    geoProto.dispose = function (...a) { disposedGeo.add(this.uuid); return realDispose.apply(this, a); };
    try {
      // Build a tree so the lazy geometry pools are populated, and capture the exact
      // pooled geometries it drew from.
      const treeA = Trees.createTree(1.0);
      const geomsA = new Set();
      treeA.traverse((o) => { const m = /** @type {any} */ (o); if (m.geometry) geomsA.add(m.geometry); });

      Trees.resetTreePools();

      const allDisposed = [...geomsA].every(g => disposedGeo.has(/** @type {any} */ (g).uuid));
      assert(geomsA.size > 0 && allDisposed,
        'resetTreePools disposes every pooled geometry the forest used');

      // A rebuild after the reset must allocate fresh geometries — none shared with the
      // pre-reset (now-disposed) pool — proving the singleton caches were nulled.
      const treeB = Trees.createTree(1.0);
      const geomsB = new Set();
      treeB.traverse((o) => { const m = /** @type {any} */ (o); if (m.geometry) geomsB.add(m.geometry); });
      const shared = [...geomsB].filter(g => geomsA.has(g));
      assert(geomsB.size > 0 && shared.length === 0,
        'a rebuild after resetTreePools allocates fresh geometries (no freed pool handles reused)');

      // Idempotent: a second reset with the caches already null must not throw.
      let threw = false;
      try { Trees.resetTreePools(); } catch { threw = true; }
      assert(!threw, 'resetTreePools is idempotent (safe when the pools are already null)');
    } finally {
      geoProto.dispose = realDispose;
    }
  }

  console.log(`\n=================================`);
  console.log(`Trees tests completed: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Trees test harness crashed:', err);
  process.exit(1);
});
