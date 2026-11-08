// @ts-check
// A completed run builds the real (hidden) snowman ghost on replay. Its shaped
// ski arms have material arrays; a single-material stand-in misses this path.
const assert = require('node:assert/strict');

async function main() {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  // Only gate-label painting is stubbed; the snowman, skis and materials are real.
  Object.defineProperty(env.window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ fillRect() {}, fillText() {} }),
  });
  const THREE = await import('three');
  const { Snowman } = await import('../src/snowman.ts');
  const { CourseModule: Course } = await import('../src/course.ts');
  const RC = await import('../src/run-context.ts');
  const { disposeSceneResources } = await import('../src/game/teardown.ts');
  const { resetSnowmanSnowMaterial } = await import('../src/snowman/snow-material.ts');
  const scene = new THREE.Scene();
  const player = Snowman.createSnowman(scene);
  /** @type {import('three').Object3D[]} */
  const ghosts = [];
  /** @type {{ mesh: import('three').Mesh, materials: import('three').Material[], array: boolean, geometry: import('three').BufferGeometry }[]} */
  const originals = [];
  /** @type {Map<import('three').Material, { transparent: boolean, opacity: number, color: number | null, emissive: number | null }>} */
  const sourceState = new Map();

  /** @param {import('three').Material} material */
  function materialState(material) {
    return {
      transparent: material.transparent,
      opacity: material.opacity,
      color: 'color' in material && material.color instanceof THREE.Color ? material.color.getHex() : null,
      emissive: 'emissive' in material && material.emissive instanceof THREE.Color ? material.emissive.getHex() : null,
    };
  }

  try {
    RC.setRunSeed(RC.CANONICAL_WORLD_SEED);
    Course.init({
      scene,
      getTerrainHeight: () => 30,
      getDifficulty: () => 'expert',
      createSnowman: (target) => {
        const ghost = Snowman.createSnowman(target);
        ghosts.push(ghost);
        ghost.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          originals.push({ mesh: object, materials, array: Array.isArray(object.material), geometry: object.geometry });
          for (const material of materials) sourceState.set(material, materialState(material));
        });
        return ghost;
      },
    });
    Course.reset();
    assert.equal(ghosts.length, 0, 'no ghost exists before a recorded finish');
    // Use the actual writer, including a playable sample before the finish. A
    // same-task finish with no sample leaves an invalid one-point ghost instead.
    Course.update({ x: 2, y: 30, z: Course._config.START_Z - 1 }, 1 / 60, player);
    Course.onFinish(25, Infinity);
    const saved = env.localStorage.getItem('snowgliderGhost_expert');
    assert.ok(saved);
    assert.equal(JSON.parse(saved).length, 2);
    assert.doesNotThrow(() => Course.reset(), 'replay must clone the real multi-material snowman');
    assert.equal(ghosts.length, 1);
    const ghost = ghosts[0];
    assert.equal(ghost.visible, false, 'the existing hidden-ghost setting is preserved');
    assert.equal(originals.filter(({ array }) => array).length, 4, 'all four shaped ski arms exercise material arrays');
    const clones = new Set();
    for (const { mesh, materials, array, geometry } of originals) {
      assert.equal(Array.isArray(mesh.material), array, 'material slots retain their scalar/array shape');
      const actual = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      assert.equal(actual.length, materials.length, 'all ski material slots survive');
      assert.equal(mesh.geometry, geometry, 'material conversion preserves geometry and its groups');
      actual.forEach((material, index) => {
        assert.notEqual(material, materials[index], 'ghost never mutates a source material');
        assert.equal(material.transparent, true);
        assert.equal(material.opacity, 0.32);
        if ('color' in material && material.color instanceof THREE.Color) {
          const before = sourceState.get(materials[index]);
          assert.ok(before && before.color !== null);
          const expected = new THREE.Color(before.color).lerp(new THREE.Color(0x66ccff), 0.6);
          assert.equal(material.color.getHex(), expected.getHex());
        }
        if ('emissive' in material && material.emissive instanceof THREE.Color) {
          assert.equal(material.emissive.getHex(), 0x113355);
        }
        clones.add(material);
      });
      assert.equal(mesh.castShadow, false);
      assert.equal(mesh.receiveShadow, false);
    }
    for (const [material, before] of sourceState) {
      assert.deepEqual(materialState(material), before, 'live/shared source material properties remain unchanged');
    }
    player.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      assert.ok(materials.every((material) => !clones.has(material)), 'live player shares no ghost clone');
    });
    for (let replay = 0; replay < 3; replay++) {
      Course.reset();
      Course.update({ x: 2, y: 30, z: Course._config.START_Z - 1 }, 1 / 60, player);
      assert.equal(ghosts.length, 1, 'repeated replay reuses the same ghost');
      assert.equal(ghost.visible, false);
    }

    // Scene teardown owns both scalar and array clone disposal. Course teardown
    // must leave those scene-owned resources intact until the deduplicated sweep.
    const resources = new Set();
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      resources.add(object.geometry);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) resources.add(material);
    });
    const disposed = new Map();
    for (const resource of resources) {
      disposed.set(resource, 0);
      resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource) + 1));
    }
    Course.teardown();
    assert.ok([...disposed.values()].every((count) => count === 0));
    disposeSceneResources(scene);
    assert.ok([...disposed.values()].every((count) => count === 1), 'all reachable ghost/player resources dispose exactly once');
    console.log('Ghost materials: real finish/replay, multi-material isolation, reuse and teardown passed');
  } finally {
    Course.teardown();
    resetSnowmanSnowMaterial();
    RC.setRunSeed(null);
    env.teardown();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
