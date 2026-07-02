// @ts-check
/**
 * Unit tests for the EZ-Tree evergreen prototype (issue #282):
 * src/mountains/ez-forest.ts (archetype provider) + the opt-in rendering path in
 * src/mountains/trees.ts.
 *
 * Headless notes: the published @dgreenheck/ez-tree build eagerly loads its
 * embedded textures with THREE.TextureLoader at import time, which needs a DOM —
 * ez-forest.ts installs (and removes) a minimal document shim around its lazy
 * import, so this suite runs in plain Node with no loader wiring beyond the usual
 * .js -> .ts resolve hook:
 *   node --import ./tests/loaders/register-ts-resolve.mjs tests/ez-forest-tests.js
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
  const EzForest = await import('../src/mountains/ez-forest.js');

  // --- Flag: default OFF, override wins ---------------------------------------
  {
    assert(Trees.isEzForestEnabled() === false,
      'EZ forest is OFF by default (no window/?eztrees)');
    Trees.setEzForestEnabled(true);
    assert(Trees.isEzForestEnabled() === true, 'setEzForestEnabled(true) turns the flag on');
    Trees.setEzForestEnabled(null);
    assert(Trees.isEzForestEnabled() === false, 'setEzForestEnabled(null) restores the default');
  }

  // --- Default path untouched when the flag is off ------------------------------
  {
    const scene = new THREE.Scene();
    const positions = Trees.addTrees(scene);
    await Trees.ezForestReady();
    const forest = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    const parts = new Set(forest.map(m => m.userData.forestPart));
    assert(positions.length > 0 && forest.length >= 1 && forest.length <= 5,
      'flag OFF: forest stays within the stylized 5-family envelope',
      `${forest.length} meshes`);
    assert(!parts.has('ezBranches') && !parts.has('ezLeaves'),
      'flag OFF: no EZ families are appended');
  }

  // --- Archetype generation: deterministic, low-poly, stream-neutral ------------
  {
    // Warm the one-time module import OUTSIDE the seeded window: the chunk's
    // import-eval mints texture uuids from the ambient Math.random by design (the
    // private-stream swap must not span the fetch await, or every concurrent game
    // caller would read a deterministic sequence — see loadEzTreeModule). The
    // neutrality contract covers GENERATION, which is what re-runs in the game.
    await EzForest.ensureEzArchetypes();
    EzForest.resetEzForest();

    const seeded = mulberry(42);
    const savedRandom = Math.random;
    Math.random = seeded.next;
    let archetypes;
    try {
      const before = seeded.draws;
      archetypes = await EzForest.ensureEzArchetypes();
      assert(seeded.draws === before,
        'archetype generation is Math.random-stream-neutral',
        `${seeded.draws - before} draws`);
    } finally {
      Math.random = savedRandom;
    }

    const speciesCount = EzForest.EZ_SPECIES_COUNT;
    assert(Array.isArray(archetypes) && archetypes.length === speciesCount * 2,
      'every species is generated at near AND far detail',
      `${archetypes.length} = ${speciesCount} species x 2 LODs`);
    const triCount = (a) => {
      const idx = a.branches.index;
      const leafIdx = a.leaves.index;
      return ((idx ? idx.count : a.branches.getAttribute('position').count) +
        (leafIdx ? leafIdx.count : a.leaves.getAttribute('position').count)) / 3;
    };
    for (const a of archetypes) {
      const tris = triCount(a);
      assert(tris > 0 && tris <= EzForest.EZ_ARCHETYPE_TRIANGLE_BUDGET,
        'archetype stays within the instancing triangle budget',
        `${a.detail}: ${Math.round(tris)} <= ${EzForest.EZ_ARCHETYPE_TRIANGLE_BUDGET}`);
      assert(a.height > 10, 'archetype reports a usable local height', a.height.toFixed(1));
      assert(a.snowAnchors.length >= 8, 'archetype exposes snow shelf anchors',
        `${a.snowAnchors.length}`);
      const midY = a.height / 2;
      assert(a.snowAnchors.every(p => p.y > midY * 0.5),
        'snow anchors sit in the upper canopy (top-biased sampling)');
    }
    // Layout contract trees.ts relies on: near builds at [0, speciesCount), each
    // species' far build exactly speciesCount later — and meaningfully cheaper.
    for (let i = 0; i < speciesCount; i++) {
      const near = archetypes[i];
      const far = archetypes[i + speciesCount];
      assert(near.detail === 'near' && far.detail === 'far' &&
        near.species === i && far.species === i,
        'archetype layout is [near x species..., far x species...]',
        `species ${i}`);
      assert(triCount(far) <= triCount(near) * EzForest.EZ_FAR_TRIANGLE_FRACTION,
        'far build costs at most the far-fraction of its near counterpart',
        `${Math.round(triCount(far))} <= ${EzForest.EZ_FAR_TRIANGLE_FRACTION} * ${Math.round(triCount(near))}`);
      assert(Math.abs(far.height - near.height) < near.height * 0.25,
        'far build keeps roughly the species silhouette height',
        `${far.height.toFixed(1)} vs ${near.height.toFixed(1)}`);
    }
    assert(EzForest.getEzArchetypesSync() === archetypes,
      'getEzArchetypesSync returns the cached archetypes after generation');

    // LOD split (pure): corridor-adjacent trees render near, off-piste far. On
    // straight tiers the centerline is x=0, so the band is a plain |x| check.
    assert(Trees.ezDetailForPlacement(0, -50) === 'near' &&
      Trees.ezDetailForPlacement(30, -50) === 'near',
      'trees inside the corridor band use the near build');
    assert(Trees.ezDetailForPlacement(40, -50) === 'far' &&
      Trees.ezDetailForPlacement(-80, -50) === 'far',
      'off-piste trees use the far build');
  }

  // --- Flag ON: addTrees appends the EZ families with matching counts -----------
  {
    Trees.setEzForestEnabled(true);
    const scene = new THREE.Scene();
    const positions = Trees.addTrees(scene);
    await Trees.ezForestReady();
    const forest = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    const parts = new Set(forest.map(m => m.userData.forestPart));
    assert(parts.has('ezBranches') && parts.has('ezLeaves'),
      'flag ON: EZ branch + needle families are appended', [...parts].sort().join(', '));
    assert(!parts.has('trunk') && !parts.has('cone'),
      'flag ON: the stylized trunk/cone families are replaced (snow collars remain)');
    assert(parts.has('snowPatch'), 'flag ON: ground snow collars still ground each tree');
    assert(parts.has('ezSnowCap') && parts.has('ezSnowPatch'),
      'flag ON: crown snow caps + draped shelves are instanced');

    const ezBranchMeshes = forest.filter(m => m.userData.forestPart === 'ezBranches');
    const ezLeafMeshes = forest.filter(m => m.userData.forestPart === 'ezLeaves');
    // The placement grid spans x -100..100 around a ±32 corridor band, so both
    // LOD tiers must be represented in the live build.
    const archetypeIdxs = new Set(ezBranchMeshes.map(m => m.userData.ezArchetype));
    assert([...archetypeIdxs].some(i => i < EzForest.EZ_SPECIES_COUNT) &&
      [...archetypeIdxs].some(i => i >= EzForest.EZ_SPECIES_COUNT),
      'the forest mixes near (corridor) and far (off-piste) LOD builds',
      [...archetypeIdxs].sort((a, b) => a - b).join(', '));
    const branchTotal = ezBranchMeshes.reduce((n, m) => n + m.count, 0);
    const leafTotal = ezLeafMeshes.reduce((n, m) => n + m.count, 0);
    assert(branchTotal === positions.length,
      'one EZ branch instance per collision tree position', `${branchTotal} === ${positions.length}`);
    assert(leafTotal === positions.length,
      'one EZ needle-card instance per collision tree position');
    assert(ezBranchMeshes.every(m => m.instanceColor != null) &&
      ezLeafMeshes.every(m => m.instanceColor != null),
      'EZ families carry per-instance palette tints');
    assert(ezBranchMeshes.every(m => m.castShadow === true) &&
      ezLeafMeshes.every(m => m.castShadow === true),
      'EZ trees cast shadows');
    const ezSnow = forest.filter(m => /^ezSnow/.test(m.userData.forestPart));
    assert(ezSnow.every(m => m.castShadow === false),
      'EZ snow never enters the real shadow map (no snow-on-snow pancakes)');

    // Sway: base-rooted per-archetype height on the visible AND depth materials,
    // sharing the forest's single uniform set.
    const stubVS = 'void main() {\n#include <common>\n#include <begin_vertex>\n#include <project_vertex>\n}';
    const branchMat = ezBranchMeshes[0].material;
    const leafMat = ezLeafMeshes[0].material;
    const branchShader = { uniforms: {}, vertexShader: stubVS };
    const leafShader = { uniforms: {}, vertexShader: stubVS };
    branchMat.onBeforeCompile(branchShader);
    leafMat.onBeforeCompile(leafShader);
    assert(/TREE_SWAY_ROOT_HEIGHT/.test(branchShader.vertexShader),
      'EZ bark sway is rooted against the archetype height');
    assert(/TREE_SWAY_ROOT_HEIGHT/.test(leafShader.vertexShader) &&
      /TREE_SWAY_FLUTTER/.test(leafShader.vertexShader),
      'EZ needles add flutter on top of the height-rooted sway');
    assert(/^tree-wind-sway-rooted-h/.test(branchMat.customProgramCacheKey()),
      'per-archetype root height is part of the program cache key',
      branchMat.customProgramCacheKey());
    const depth = ezBranchMeshes[0].customDepthMaterial;
    const leafDepth = ezLeafMeshes[0].customDepthMaterial;
    assert(depth instanceof THREE.MeshDepthMaterial && leafDepth instanceof THREE.MeshDepthMaterial,
      'EZ meshes carry sway depth materials (shadows lean with the trees)');
    assert(leafDepth.alphaTest > 0,
      'the needle depth material is alpha-tested (card silhouettes in the shadow map)');
    const depthShader = { uniforms: {}, vertexShader: stubVS };
    depth.onBeforeCompile(depthShader);
    assert(/TREE_SWAY_ROOT_HEIGHT/.test(depthShader.vertexShader),
      'depth sway matches the height-rooted profile');
    assert(depthShader.uniforms.uWindAmp === branchShader.uniforms.uWindAmp,
      'EZ materials share the forest wind uniforms (one updateWind drives all)');

    // Re-init supersedes the async build: an immediate second addTrees must leave
    // exactly one EZ forest in the scene (no stale duplicate append).
    Trees.addTrees(scene);
    const positions3 = Trees.addTrees(scene);
    await Trees.ezForestReady();
    const forest3 = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    const branchTotal3 = forest3.filter(m => m.userData.forestPart === 'ezBranches')
      .reduce((n, m) => n + m.count, 0);
    assert(branchTotal3 === positions3.length,
      'racing re-inits keep exactly one EZ forest (stale async builds dropped)',
      `${branchTotal3} === ${positions3.length}`);

    Trees.setEzForestEnabled(null);
  }

  // --- Chunk-load failure: collider gate, stylized fallback, then retry ----------
  {
    Trees.setEzForestEnabled(true);

    // Swap in a controllable importer (clears the module memo) and drop the cached
    // archetypes so the next build really goes through the failing import.
    /** @type {(err: Error) => void} */
    let rejectImport = () => {};
    EzForest.__setEzModuleImporterForTests(
      () => new Promise((_resolve, reject) => { rejectImport = reject; }));
    EzForest.resetEzForest();

    const scene = new THREE.Scene();
    Trees.addTrees(scene);
    assert(Trees.treeCollidersReady() === false,
      'tree colliders are gated while the EZ build awaits its chunk');

    rejectImport(new Error('simulated chunk-load failure'));
    await Trees.ezForestReady();
    assert(Trees.treeCollidersReady() === true,
      'tree colliders re-arm once the failed build settles');
    const forest = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    const parts = new Set(forest.map(m => m.userData.forestPart));
    assert(parts.has('trunk') && parts.has('cone'),
      'a failed chunk load falls back to the visible stylized forest',
      [...parts].sort().join(', '));
    assert(!parts.has('ezBranches') && !parts.has('ezLeaves'),
      'no EZ meshes appear on the failure path');

    // The rejected import must not wedge the memo (retry path): restore the real
    // importer and re-init — archetypes must generate again.
    EzForest.__setEzModuleImporterForTests(null);
    EzForest.resetEzForest();
    const retried = await EzForest.ensureEzArchetypes();
    assert(Array.isArray(retried) && retried.length >= 3,
      'a re-init after a failed chunk load retries the import and succeeds');

    Trees.setEzForestEnabled(null);
  }

  // --- Teardown: resetTreePools also frees the EZ pools -------------------------
  {
    const before = EzForest.getEzArchetypesSync();
    assert(before !== null, 'archetypes are cached before the reset');
    Trees.resetTreePools();
    assert(EzForest.getEzArchetypesSync() === null,
      'resetTreePools clears the cached EZ archetypes');
    let threw = false;
    try { Trees.resetTreePools(); } catch { threw = true; }
    assert(!threw, 'resetTreePools stays idempotent with the EZ pools wired in');
    // Regeneration after a reset yields fresh, usable archetypes (dev-HMR path).
    const again = await EzForest.ensureEzArchetypes();
    assert(Array.isArray(again) && again.length >= 3 && again !== before,
      'ensureEzArchetypes regenerates fresh archetypes after a reset');
  }

  // --- Teardown cancels an in-flight EZ build (disposeGame / dev-HMR) -----------
  {
    Trees.setEzForestEnabled(true);
    /** @type {(mod: unknown) => void} */
    let resolveImport = () => {};
    EzForest.__setEzModuleImporterForTests(
      () => new Promise((resolve) => { resolveImport = resolve; }));
    EzForest.resetEzForest();

    const scene = new THREE.Scene();
    Trees.addTrees(scene);
    const meshesBefore = scene.children.filter(c => c.name === 'forestInstanced').length;
    Trees.resetTreePools(); // disposeGame/HMR while the chunk is still in flight

    // Let the stale load settle with the REAL module (already in Node's cache).
    resolveImport(await import('@dgreenheck/ez-tree'));
    await Trees.ezForestReady();
    const forest = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    assert(forest.length === meshesBefore &&
      !forest.some(m => m.userData.forestPart === 'ezBranches'),
      'a teardown mid-load cancels the EZ build (nothing appended to the disposed scene)',
      `${forest.length} meshes, unchanged`);
    assert(Trees.treeCollidersReady() === true,
      'the collider gate re-opens after a cancelled build settles');

    EzForest.__setEzModuleImporterForTests(null);
    EzForest.resetEzForest();
    Trees.setEzForestEnabled(null);
  }

  console.log(`\n=================================`);
  console.log(`EZ forest tests completed: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

/** Tiny seeded PRNG with a draw counter (stream-neutrality assertions). */
function mulberry(seed) {
  let s = seed >>> 0;
  const state = {
    draws: 0,
    next() {
      state.draws++;
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
  };
  return state;
}

main().catch((err) => {
  console.error('EZ forest test harness crashed:', err);
  process.exit(1);
});
