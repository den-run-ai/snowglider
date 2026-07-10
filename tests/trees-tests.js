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
    const foliageColors = new Set();
    tree.children.forEach((c) => {
      const mesh = /** @type {any} */ (c);
      const color = mesh.material && mesh.material.color;
      if (!color || typeof color.getHSL !== 'function') return;
      const hsl = { h: 0, s: 0, l: 0 };
      color.getHSL(hsl);
      if (hsl.h > 0.32 && hsl.h < 0.50 && hsl.s > 0.25) {
        foliageColors.add(color.getHexString());
      }
    });
    assert(foliageColors.size === 1,
      'createTree keeps one coherent foliage shade per tree',
      `${foliageColors.size} foliage shade(s)`);

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
    const forestParts = new Set(forest.map(m => m.userData.forestPart));
    const expectedParts = ['branch', 'cone', 'snowCap', 'snowPatch', 'trunk'];
    assert(expectedParts.every(p => forestParts.has(p)) && [...forestParts].every(p => expectedParts.includes(p)),
      'forest uses only complete live-tree part families (no broken bare-branch family)',
      [...forestParts].sort().join(', '));

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
    const snowPatch = forest.find(m => m.userData.forestPart === 'snowPatch');
    assert((!snowCap || snowCap.castShadow === false) && (!snowPatch || snowPatch.castShadow === false),
      'tree snow caps/patches do not cast dark snow-on-snow shadow blobs');

    // Re-init: a second addTrees must dispose the old forest and rebuild without
    // accumulating duplicate InstancedMeshes in the scene (covers the teardown loop).
    const positions2 = Trees.addTrees(scene);
    const forest2 = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    assert(forest2.length >= 1 && forest2.length <= 5,
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

  // --- Wind sway (issue #253, Phase A) ----------------------------------------
  // The instanced forest sways in the shared wind field via an onBeforeCompile vertex
  // sway on the instanced materials. Everything below is headless: we drive the shader
  // injection against a stub shader object and the uniform plumbing through updateWind /
  // resetWind, so no WebGL context is needed. (The rendered result is a browser concern.)
  {
    const { Wind, DEFAULT_WIND_CONFIG } = await import('../src/wind.js');

    // Build a forest so the lazy instanced materials exist, then read them off the meshes.
    const scene = new THREE.Scene();
    Trees.addTrees(scene);
    const forest = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    const trunkMat = /** @type {any} */ (forest.find(m => m.userData.forestPart === 'trunk')?.material);
    const foliageMat = /** @type {any} */ (forest.find(m => m.userData.forestPart === 'cone')?.material);
    assert(!!trunkMat && !!foliageMat, 'instanced trunk + foliage materials exist on the forest');

    // Distinct program cache keys so the trunk (rooted) and foliage shaders never collide,
    // and both differ from an un-swayed material's default key.
    assert(/^tree-wind-sway/.test(trunkMat.customProgramCacheKey()) &&
      /^tree-wind-sway/.test(foliageMat.customProgramCacheKey()),
      'instanced tree materials tag a wind-sway program cache key');
    assert(trunkMat.customProgramCacheKey() !== foliageMat.customProgramCacheKey(),
      'rooted (trunk) and canopy materials use distinct program cache keys');

    // Drive the injection against a stub shader carrying the two include markers we edit.
    // (three's Material.onBeforeCompile defaults to a no-op *function*, so we compare the
    // resulting shader source rather than the presence of the callback.)
    const stubVS = 'void main() {\n#include <common>\n#include <begin_vertex>\n#include <project_vertex>\n}';
    const trunkShader = { uniforms: {}, vertexShader: stubVS };
    const foliageShader = { uniforms: {}, vertexShader: stubVS };
    trunkMat.onBeforeCompile(trunkShader);
    foliageMat.onBeforeCompile(foliageShader);

    // The non-instanced Group-shim material must be left un-swayed: its onBeforeCompile
    // (three's default no-op) leaves the shader byte-for-byte unchanged.
    const legacyTrunkMat = /** @type {any} */ (Trees.createTree(1.0).children[0]).material;
    const legacyShader = { uniforms: {}, vertexShader: stubVS };
    legacyTrunkMat.onBeforeCompile(legacyShader);
    assert(legacyShader.vertexShader === stubVS && !/uWindDir/.test(legacyShader.vertexShader),
      'the non-instanced Group-shim material is left un-swayed (byte-identical shim path)');

    assert(/uWindDir/.test(trunkShader.vertexShader) && /uWindAmp/.test(trunkShader.vertexShader) &&
      /uWindSwayTime/.test(trunkShader.vertexShader),
      'sway injection declares the wind uniforms in the vertex shader');
    assert(/USE_INSTANCING/.test(trunkShader.vertexShader) && /instanceMatrix/.test(trunkShader.vertexShader),
      'the sway is applied in the instanced (post-instanceMatrix) branch only');
    assert(/TREE_SWAY_ROOTED/.test(trunkShader.vertexShader),
      'the trunk material defines TREE_SWAY_ROOTED (bend planted at the base)');
    assert(!/#define TREE_SWAY_ROOTED/.test(foliageShader.vertexShader),
      'the foliage material does NOT root the bend');
    assert(/TREE_SWAY_FLUTTER/.test(foliageShader.vertexShader),
      'the foliage material defines TREE_SWAY_FLUTTER (needle layers flex in gusts)');

    // Intra-tree coherence (the "realistic trees disappeared" regression): the sway
    // phase must come from the INSTANCE origin (instanceMatrix[3]) so every vertex of
    // one tree swings together — a per-vertex world-position phase (the old
    // `dot( mvPosition.xz, ... )`) makes different parts of ONE tree lean by up to the
    // full amplitude in different directions, which at the widened 0.9u band crumpled
    // the EZ archetype pines into diagonal scraggle.
    assert(/swayPhase = dot\( instanceMatrix\[3\]\.xz/.test(trunkShader.vertexShader),
      'sway phase derives from the tree instance origin (per-tree coherent swing)');
    assert(!/swayPhase = dot\( mvPosition\.xz/.test(trunkShader.vertexShader),
      'sway phase does NOT vary per vertex across a single tree');
    // Same trap in the flutter: raw LOCAL-space frequencies (position.y*k) flip sign
    // every fraction of a world unit on the EZ archetypes (local units are ~5x world),
    // shredding each needle card into its own phase. The along-tree variation must key
    // off the scale-independent swayWeight instead.
    const flutterBlock = foliageShader.vertexShader.match(/float flutter[\s\S]*?#endif/);
    assert(!!flutterBlock && !/position\.[xyz]/.test(flutterBlock[0]),
      'flutter phase is scale-independent (no raw local-position frequencies)',
      flutterBlock ? flutterBlock[0].slice(0, 120) : 'no flutter block');

    // The injection wires the SHARED uniform objects, so one update drives every material:
    // the stub shaders captured the same uWindAmp reference the trunk + foliage share.
    assert(trunkShader.uniforms.uWindAmp === foliageShader.uniforms.uWindAmp,
      'all tree materials share one uWindAmp uniform (a single update drives the forest)');

    // Shadow casters sway too: the forest InstancedMeshes castShadow, so each needs a
    // customDepthMaterial carrying the SAME sway — else the shadows stay put while the trees
    // lean (detached shadows). Verify the depth material exists, is shadow-map ready, and
    // injects the matching instanced sway from the same shared uniform.
    const trunkMesh = /** @type {any} */ (forest.find(m => m.userData.forestPart === 'trunk'));
    const coneMesh = /** @type {any} */ (forest.find(m => m.userData.forestPart === 'cone'));
    const trunkDepth = /** @type {any} */ (trunkMesh?.customDepthMaterial);
    const coneDepth = /** @type {any} */ (coneMesh?.customDepthMaterial);
    assert(trunkMesh.castShadow && coneMesh.castShadow, 'forest meshes cast shadows');
    assert(trunkDepth instanceof THREE.MeshDepthMaterial && coneDepth instanceof THREE.MeshDepthMaterial,
      'each shadow-casting forest mesh has a MeshDepthMaterial customDepthMaterial');
    assert(trunkDepth.depthPacking === THREE.RGBADepthPacking,
      'the depth material uses RGBA depth packing (shadow-map ready)');
    const trunkDepthShader = { uniforms: {}, vertexShader: stubVS };
    const coneDepthShader = { uniforms: {}, vertexShader: stubVS };
    trunkDepth.onBeforeCompile(trunkDepthShader);
    coneDepth.onBeforeCompile(coneDepthShader);
    assert(/uWindDir/.test(trunkDepthShader.vertexShader) && /instanceMatrix/.test(trunkDepthShader.vertexShader),
      'the depth material injects the same instanced sway (shadow leans with the tree)');
    assert(/TREE_SWAY_ROOTED/.test(trunkDepthShader.vertexShader) &&
      !/#define TREE_SWAY_ROOTED/.test(coneDepthShader.vertexShader),
      'depth sway matches the profile: trunk rooted, foliage not');
    assert(/TREE_SWAY_FLUTTER/.test(coneDepthShader.vertexShader),
      'foliage depth material includes TREE_SWAY_FLUTTER (shadows match needle flex)');
    assert(trunkDepthShader.uniforms.uWindAmp === trunkShader.uniforms.uWindAmp,
      'depth + visible materials share one uWindAmp (a single updateWind drives shadows too)');
    // The depth materials are built with Math.random swapped to a private RNG (so their uuid
    // draws never shift a caller's seeded obstacle stream — see getSwayDepthMaterial); that
    // private RNG still yields DISTINCT uuids for the two profiles. (End-to-end RNG-neutrality
    // is guarded by the seeded forward_stress harness.)
    assert(typeof trunkDepth.uuid === 'string' && trunkDepth.uuid !== coneDepth.uuid,
      'the two shadow-caster depth materials get distinct uuids from the private RNG');

    const U = trunkShader.uniforms;

    // resetWind → calm baseline (no lean).
    Trees.resetWind();
    assert(U.uWindAmp.value === 0 && U.uWindSwayTime.value === 0,
      'resetWind rewinds the flutter clock and zeroes the amplitude');

    // updateWind advances the flutter clock by dt and pulls a positive, bounded amplitude
    // from the live wind (Node has no window, so the reduced-motion gate is inactive).
    Wind.reset();
    Trees.updateWind(2.0);
    assert(Math.abs(U.uWindSwayTime.value - 2.0) < 1e-9, 'updateWind advances the flutter clock by dt');
    assert(U.uWindAmp.value > 0 && U.uWindAmp.value <= 0.9 + 1e-9,
      'updateWind maps wind strength into the bounded lean amplitude', `amp=${U.uWindAmp.value.toFixed(3)}`);
    assert(Math.abs(Math.hypot(U.uWindDir.value.x, U.uWindDir.value.y) - 1) < 1e-6,
      'updateWind sets a unit downwind direction');

    // Negative dt is ignored (no rewind), matching Wind.update's clock guard.
    Trees.updateWind(-5.0);
    assert(Math.abs(U.uWindSwayTime.value - 2.0) < 1e-9, 'updateWind ignores negative dt (no rewind)');

    // Deterministic: reset + the same advance reproduces the same amplitude exactly.
    const ampA = U.uWindAmp.value;
    Trees.resetWind(); Wind.reset(); Trees.updateWind(2.0);
    assert(U.uWindAmp.value === ampA, 'tree sway is deterministic (reset + same advance ⇒ same amplitude)');

    // treeSwayAmplitude (pure): a calm field (strength 0) reads as fully still, while any
    // positive wind gets at least the breeze floor and ramps to the max at full strength.
    assert(Trees.treeSwayAmplitude(0) === 0, 'treeSwayAmplitude(0) is fully still (dead calm ⇒ no sway)');
    assert(Math.abs(Trees.treeSwayAmplitude(1) - 0.9) < 1e-9, 'treeSwayAmplitude(1) reaches the max lean');
    assert(Trees.treeSwayAmplitude(0.5) > 0.06 && Trees.treeSwayAmplitude(0.5) < 0.9,
      'treeSwayAmplitude(mid) sits between the breeze floor and the max');
    assert(Trees.treeSwayAmplitude(0.0001) >= 0.06,
      'any positive wind gets at least the breeze floor');
    assert(Trees.treeSwayAmplitude(-3) === 0 && Trees.treeSwayAmplitude(NaN) === 0,
      'treeSwayAmplitude clamps junk/negative strength to still');

    // Integration: a dead-calm wind profile drives updateWind to zero amplitude, so trees
    // stop fluttering in step with the snow/scarf consumers (regression for the P2 finding).
    Wind.configure({ baseStrength: 0, gustRange: 0 });
    Wind.reset();
    Trees.updateWind(2.0);
    assert(U.uWindAmp.value === 0, 'updateWind holds trees still under a dead-calm wind field',
      `amp=${U.uWindAmp.value}`);
    // Restore the live field so the singleton is left in its default state.
    Wind.configure({ baseStrength: DEFAULT_WIND_CONFIG.baseStrength, gustRange: DEFAULT_WIND_CONFIG.gustRange });
    Wind.reset();
  }

  console.log(`\n=================================`);
  console.log(`Trees tests completed: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Trees test harness crashed:', err);
  process.exit(1);
});
