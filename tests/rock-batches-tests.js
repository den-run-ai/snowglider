// @ts-check
const assert = require('node:assert/strict');

async function main() {
  const THREE = await import('three');
  const { batchStaticRocks } = await import('../src/mountains/rock-batches.js');
  const { addRocks, createRock, resetRockCaches } = await import('../src/mountains/rocks.js');
  const { makeSceneryRng } = await import('../src/scenery/scenery-rng.js');
  const { setActiveCourseLine, courseLineFor } = await import('../src/course-line.js');
  const { getDifficultyConfig } = await import('../src/difficulty.js');
  const { setTerrainCorridor, setTerrainKickers } = await import('../src/mountains/terrain.js');
  const scene = new THREE.Scene();
  const savedRandom = Math.random;
  Math.random = makeSceneryRng(281);
  const originals = [];
  try {
    // Two materials in one cell, plus a distant cell. Different rotations/scales
    // make a missing matrix/normal transform observable in the merged buffers.
    for (let i = 0; i < 6; i++) {
      const rock = createRock(1 + i * 0.2, { cliff: i >= 4, seed: i });
      rock.position.set(i < 2 ? 180 + i * 5 : 4 + i * 4, 10 + i, -20);
      rock.rotation.set(0.2 * i, 0.35 * i, -0.1 * i);
      rock.updateMatrix();
      originals.push(rock); scene.add(rock);
    }
  } finally { Math.random = savedRandom; }
  let disposed = 0;
  originals.forEach(r => r.geometry.addEventListener('dispose', () => disposed++));
  let draws = 0;
  Math.random = () => { draws++; return 0.5; };
  try { batchStaticRocks(scene); } finally { Math.random = savedRandom; }
  assert.equal(draws, 0);
  assert.equal(scene.children.length, 3, 'six rocks become three material/cell draws');
  assert.equal(disposed, 6, 'unique original geometry resources released');
  const vertex = new THREE.Vector3(), expected = new THREE.Vector3();
  const normal = new THREE.Vector3(), expectedNormal = new THREE.Vector3();
  for (const object of scene.children) {
    assert(object instanceof THREE.Mesh);
    const mesh = /** @type {import('three').Mesh<import('three').BufferGeometry, import('three').Material>} */ (object);
    assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, true);
    assert(Number.isFinite(mesh.geometry.boundingSphere.radius));
    const inputs = originals.filter(rock => rock.material === mesh.material &&
      Math.floor(rock.position.x / 40) === Math.floor(mesh.position.x / 40));
    assert.equal(mesh.userData.rockCount, inputs.length);
    let offset = 0;
    for (const input of inputs) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(input.matrix);
      for (let i = 0; i < input.geometry.getAttribute('position').count; i++, offset++) {
        vertex.fromBufferAttribute(mesh.geometry.getAttribute('position'), offset);
        assert(mesh.geometry.boundingBox.containsPoint(vertex));
        assert(vertex.distanceTo(mesh.geometry.boundingSphere.center) <= mesh.geometry.boundingSphere.radius + 1e-6);
        vertex.add(mesh.position);
        expected.fromBufferAttribute(input.geometry.getAttribute('position'), i).applyMatrix4(input.matrix);
        assert(vertex.distanceTo(expected) < 0.00001, 'visible world-space shape retained');
        normal.fromBufferAttribute(mesh.geometry.getAttribute('normal'), offset);
        expectedNormal.fromBufferAttribute(input.geometry.getAttribute('normal'), i).applyNormalMatrix(normalMatrix);
        assert(normal.distanceTo(expectedNormal) < 0.000001, 'lighting normals retained');
        for (const name of ['color', 'uv']) {
          const actual = mesh.geometry.getAttribute(name), original = input.geometry.getAttribute(name);
          for (let c = 0; c < actual.itemSize; c++) {
            assert.equal(actual.array[offset * actual.itemSize + c], original.array[i * original.itemSize + c], `${name} retained exactly`);
          }
        }
      }
    }
    assert.equal(offset, mesh.geometry.getAttribute('position').count, 'no dropped or duplicated triangles');
  }
  scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.set(20, 15, 10); camera.lookAt(20, 15, -20); camera.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const visible = scene.children.filter(m => frustum.intersectsObject(m));
  assert.equal(visible.length, 2, 'remote rock batch is culled independently');

  // The real placement path: every tier retains byte-identical hazards (including
  // topY), contact-shadow positions and downstream RNG with batching enabled.
  for (const tier of ['bunny', 'blue', 'black', 'expert']) {
    const config = getDifficultyConfig(/** @type {import('../src/difficulty.js').Difficulty} */ (tier));
    const line = config.line.curviness > 0 ? courseLineFor(config) : null;
    setActiveCourseLine(line);
    setTerrainCorridor(line && config.terrain ? { line, params: config.terrain } : null);
    setTerrainKickers(config.features ?? null, line);
    const runs = [];
    for (const batching of [false, true]) {
      const built = new THREE.Scene();
      const rendered = [];
      Math.random = makeSceneryRng(539);
      let hazards, sentinel;
      try { hazards = addRocks(built, rendered, { batching }); sentinel = Math.random(); }
      finally { Math.random = savedRandom; }
      const rocks = built.children.filter(m => m.userData.isRock);
      runs.push({ built, rendered, hazards, sentinel, rocks });
    }
    const [off, on] = runs;
    assert.deepEqual(on.hazards, off.hazards, `${tier}: collision tops/positions unchanged`);
    assert.deepEqual(on.rendered, off.rendered, `${tier}: contact-shadow positions unchanged`);
    assert.equal(on.sentinel, off.sentinel, `${tier}: downstream RNG unchanged`);
    assert.equal(on.rocks.reduce((sum, rock) => sum + (rock.userData.rockCount ?? 1), 0), off.rocks.length);
    assert(on.rocks.length < off.rocks.length / 2, `${tier}: at least half the full-scene rock draws removed`);
    let oldGeometryDisposed = 0;
    on.rocks.forEach(rock => /** @type {import('three').Mesh} */ (rock).geometry.addEventListener('dispose', () => oldGeometryDisposed++));
    addRocks(on.built);
    assert.equal(oldGeometryDisposed, on.rocks.length, `${tier}: rebuilding disposes merged and singleton geometry`);
    assert(on.rocks.every(rock => rock.parent === null));
    for (const run of runs) run.built.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    console.log(`${tier}: ${off.rocks.length} rock meshes -> ${on.rocks.length} bounded draws; collider/RNG identity passed.`);
  }
  setActiveCourseLine(null); setTerrainCorridor(null); setTerrainKickers(null, null);
  scene.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
  resetRockCaches();
  console.log('Rock batches: shapes, normals, colors, UVs, shadows, culling, all-tier colliders/RNG and disposal passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
