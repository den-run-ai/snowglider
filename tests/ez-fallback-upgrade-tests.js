/**
 * EZ forest fallback self-upgrade (issue #282 follow-up: "EZ trees missing on
 * mobile"). When the ~4 MB archetype chunk outlives the 6s run-start hold (slow
 * cellular) or a fetch fails, the run starts on the stylized fallback forest —
 * but the session must RECOVER: the moment an archetype (re)load succeeds, the
 * tagged fallback stand is swapped in place for the EZ evergreens on the same
 * placements (collision positions never change), and the ground snow collars
 * survive the swap. Before this feature the player kept cone trees for the whole
 * session even though the chunk finished seconds later.
 *
 * Drives the REAL addTrees/abandonPendingEzBuild/upgrade path headlessly via the
 * injectable importer seam (__setEzModuleImporterForTests) with a deferred
 * promise standing in for the slow chunk fetch.
 *
 *   node --import ./tests/loaders/register-ts-resolve.mjs tests/ez-fallback-upgrade-tests.js
 */

let passCount = 0;
let failCount = 0;
function assert(condition, message, detail) {
  if (condition) {
    passCount++;
    console.log(`✅ PASS: ${message}${detail ? ' - ' + detail : ''}`);
  } else {
    failCount++;
    console.error(`❌ FAIL: ${message}${detail ? ' - ' + detail : ''}`);
  }
}

function forestSnapshot(scene) {
  const parts = {};
  let fallbackMeshes = 0;
  let collarMeshes = 0;
  scene.traverse((o) => {
    const p = o.userData && o.userData.forestPart;
    if (!p) return;
    parts[p] = (parts[p] || 0) + (o.count || 0);
    if (o.userData.ezFallbackTree) fallbackMeshes++;
    if (p === 'snowPatch' && !o.userData.ezFallbackTree) collarMeshes++;
  });
  return { parts, fallbackMeshes, collarMeshes };
}

async function run() {
  const THREE = await import('three');
  const { Trees } = await import('../src/trees.js');
  const EzForest = await import('../src/mountains/ez-forest.js');

  // Deferred importer: the "chunk fetch" resolves only when the test says so,
  // handing back the REAL @dgreenheck/ez-tree module.
  let releaseImport;
  const gate = new Promise((resolve) => { releaseImport = resolve; });
  EzForest.__setEzModuleImporterForTests(() => gate.then(() => import('@dgreenheck/ez-tree')));
  Trees.setEzForestEnabled(true);

  try {
    // --- Scenario 1: abandonment at run start, then the chunk lands → upgrade ---
    const scene = new THREE.Scene();
    const positions = Trees.addTrees(scene);
    assert(positions.length > 0, 'addTrees returns collision positions immediately', `${positions.length} trees`);
    assert(Trees.treeCollidersReady() === false, 'colliders gate off while the EZ chunk is pending');

    const before = forestSnapshot(scene);
    assert(!before.parts.cone && !before.parts.ezBranches,
      'no visible tree meshes while the chunk is pending (collars only)',
      JSON.stringify(before.parts));

    assert(Trees.abandonPendingEzBuild() === true, 'run-start timeout abandons the pending EZ build');
    const fallback = forestSnapshot(scene);
    assert((fallback.parts.cone || 0) > 0 && fallback.fallbackMeshes > 0,
      'abandonment builds the stylized fallback forest, tagged for upgrade',
      `${fallback.parts.cone} cones, ${fallback.fallbackMeshes} tagged meshes`);
    assert(Trees.treeCollidersReady() === true, 'colliders re-arm with the fallback forest');
    assert(fallback.collarMeshes > 0, 'the collar-only snowPatch mesh is not tagged as fallback');

    // The chunk finally lands (the abandoned load keeps going in the background).
    releaseImport();
    await Trees.ezForestReady();
    const upgraded = forestSnapshot(scene);
    assert((upgraded.parts.ezBranches || 0) === positions.length,
      'the fallback stand is swapped for the EZ evergreens on the same placements',
      `${upgraded.parts.ezBranches}/${positions.length} EZ instances`);
    assert(!upgraded.parts.cone && upgraded.fallbackMeshes === 0,
      'every tagged fallback mesh is removed by the upgrade');
    assert(upgraded.collarMeshes > 0, 'the ground snow collars survive the upgrade');
    assert(Trees.getTreeLoadState().count === positions.length,
      'the load registry re-registers every tree for the shed system',
      `${Trees.getTreeLoadState().count} loads`);
    assert(Trees.treeCollidersReady() === true, 'colliders stay armed through the swap');

    // --- Scenario 2: teardown after abandonment stales the pending upgrade ---
    EzForest.resetEzForest();
    let releaseSecond;
    const gate2 = new Promise((resolve) => { releaseSecond = resolve; });
    EzForest.__setEzModuleImporterForTests(() => gate2.then(() => import('@dgreenheck/ez-tree')));
    const scene2 = new THREE.Scene();
    Trees.addTrees(scene2);
    Trees.abandonPendingEzBuild();
    Trees.resetTreePools(); // disposeGame: bumps the build epoch
    releaseSecond();
    await Trees.ezForestReady();
    const afterTeardown = forestSnapshot(scene2);
    assert(!afterTeardown.parts.ezBranches,
      'an upgrade whose world was torn down never appends EZ meshes',
      JSON.stringify(afterTeardown.parts));
  } finally {
    Trees.resetTreePools();
    EzForest.resetEzForest();
    EzForest.__setEzModuleImporterForTests(null);
    Trees.setEzForestEnabled(null);
  }
}

run().then(() => {
  console.log('=================================');
  console.log(`EZ fallback upgrade tests completed: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}).catch((err) => {
  console.error('EZ fallback upgrade tests crashed:', err);
  process.exit(1);
});
