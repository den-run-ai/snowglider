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
 * promise standing in for the slow chunk fetch. Scenarios 3-4 stand in for the
 * BROWSER-ONLY failure recovery (document-gated in trees.ts): a scoped document
 * shim (with the minimal canvas stub the texture pools need), a serviceWorker
 * fake observing the stale-shell nudge, and a setTimeout interceptor that
 * captures the ladder's 8s+ backoff timers so the test can fire them.
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

    // --- Scenarios 3-4: the FAILURE-path recovery (browser-only in production) ---
    // A failed (not just slow) chunk load nudges the service worker's update check
    // and starts an exponential-backoff retry ladder — both gated on `document`,
    // so this block builds a scoped stand-in browser environment.
    const g = /** @type {any} */ (globalThis);
    // Minimal canvas: resetTreePools (scenario 2) cleared the texture pools, and a
    // rebuild under `document` goes through document.createElement('canvas') →
    // getContext('2d') → createImageData/putImageData (see buildNormalTexture).
    const stubCanvas = () => ({
      width: 0, height: 0, style: {},
      addEventListener() {}, removeEventListener() {}, setAttribute() {},
      getContext: () => ({
        createImageData: (/** @type {number} */ w, /** @type {number} */ h) =>
          ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {}
      })
    });
    let swUpdateNudges = 0;
    const hadDocument = typeof g.document !== 'undefined';
    const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const realSetTimeout = g.setTimeout;
    /** Captured 8s+ backoff timers from the retry ladder (shorter timers pass through). */
    const ladderTimers = /** @type {Array<{fn: () => void, delay: number}>} */ ([]);
    const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));
    let importerCalls = 0;
    try {
      if (!hadDocument) g.document = { createElement: stubCanvas, createElementNS: stubCanvas };
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          serviceWorker: {
            getRegistration: () => Promise.resolve({
              update: () => { swUpdateNudges++; return Promise.resolve(); }
            })
          }
        }
      });
      g.setTimeout = (/** @type {any} */ fn, /** @type {any} */ delay, /** @type {any[]} */ ...args) => {
        if (typeof delay === 'number' && delay >= 8000) {
          ladderTimers.push({ fn, delay });
          return 0;
        }
        return realSetTimeout(fn, delay, ...args);
      };

      // --- Scenario 3: every load fails → nudge + ladder walks to its attempt cap ---
      EzForest.resetEzForest();
      EzForest.__setEzModuleImporterForTests(() => {
        importerCalls++;
        return Promise.reject(new Error('simulated chunk-load failure'));
      });
      const scene3 = new THREE.Scene();
      Trees.addTrees(scene3);
      await Trees.ezForestReady(); // build fails → fallback + nudge + upgrade attempt 0
      await flush();

      const failedLoad = forestSnapshot(scene3);
      assert((failedLoad.parts.cone || 0) > 0 && failedLoad.fallbackMeshes > 0,
        'a failed chunk load builds the tagged stylized fallback (browser path)',
        `${failedLoad.parts.cone} cones, ${failedLoad.fallbackMeshes} tagged meshes`);
      assert(swUpdateNudges >= 1,
        'a failed chunk load nudges the service worker update check (stale-shell recovery)',
        `${swUpdateNudges} nudge(s)`);
      assert(importerCalls === 2 && ladderTimers.length === 1 && ladderTimers[0]?.delay === 8000,
        'the failure-path upgrade retries immediately, then parks on the first backoff timer',
        `${importerCalls} loads, delays: ${ladderTimers.map((t) => t.delay).join(', ')}`);

      // Fire each captured timer: 8s → 16s → 32s, then the session gives up.
      const seenDelays = [ladderTimers[0]?.delay];
      while (ladderTimers.length > 0) {
        const timer = ladderTimers.shift();
        if (timer) timer.fn();
        await flush();
        if (ladderTimers.length > 0) seenDelays.push(ladderTimers[0]?.delay);
      }
      assert(seenDelays.join(',') === '8000,16000,32000',
        'the retry ladder backs off exponentially and stops at the attempt cap',
        seenDelays.join(', '));
      assert(importerCalls === 5,
        'every retry re-fetches through the importer (a rejected memo never wedges)',
        `${importerCalls} loads`);
      const gaveUp = forestSnapshot(scene3);
      assert((gaveUp.parts.cone || 0) > 0 && !gaveUp.parts.ezBranches && ladderTimers.length === 0,
        'a session whose chunk keeps failing keeps the fallback forest, with no timer leaked');

      // --- Scenario 4: the ladder RECOVERS — a later retry lands the EZ forest ---
      EzForest.resetEzForest();
      let failuresLeft = 2; // the build's own load + upgrade attempt 0
      EzForest.__setEzModuleImporterForTests(() => {
        if (failuresLeft > 0) {
          failuresLeft--;
          return Promise.reject(new Error('still offline'));
        }
        return import('@dgreenheck/ez-tree');
      });
      const scene4 = new THREE.Scene();
      const positions4 = Trees.addTrees(scene4);
      await Trees.ezForestReady(); // fails → fallback; attempt 0 fails → 8s timer
      await flush();
      assert(ladderTimers.length === 1 && (forestSnapshot(scene4).parts.cone || 0) > 0,
        'the recovery scenario starts on the fallback with one backoff timer pending');

      const retry = ladderTimers.shift();
      if (retry) retry.fn(); // the 8s timer fires; this attempt's load succeeds
      // Ladder upgrades are untracked (never park on ezForestReady) — poll the scene.
      let recovered = forestSnapshot(scene4);
      for (let i = 0; i < 400 && !recovered.parts.ezBranches; i++) {
        await flush();
        recovered = forestSnapshot(scene4);
      }
      assert((recovered.parts.ezBranches || 0) === positions4.length &&
        !recovered.parts.cone && recovered.fallbackMeshes === 0,
        'a successful retry swaps the fallback for the EZ forest mid-session',
        `${recovered.parts.ezBranches}/${positions4.length} EZ instances`);
      assert(Trees.getTreeLoadState().count === positions4.length,
        'the ladder upgrade re-registers the load registry for the shed system',
        `${Trees.getTreeLoadState().count} loads`);
      assert(ladderTimers.length === 0, 'a successful upgrade ends the retry ladder');
    } finally {
      g.setTimeout = realSetTimeout;
      if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor);
      else delete g.navigator;
      if (!hadDocument) delete g.document;
    }
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
