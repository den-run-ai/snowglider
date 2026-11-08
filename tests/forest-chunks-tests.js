// @ts-check
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

async function main() {
  const THREE = await import('three');
  const { splitForestMesh } = await import('../src/mountains/forest-chunks.js');
  const { Trees } = await import('../src/trees.js');
  const { makeSceneryRng } = await import('../src/scenery/scenery-rng.js');

  // Deliberately interleave cells; colours, weights and mutable snow attributes
  // must follow their original matrices, including negative-coordinate boundaries.
  const geometry = new THREE.BoxGeometry(2, 6, 2);
  geometry.setAttribute('aSnowLoad', new THREE.InstancedBufferAttribute(new Float32Array([0.2, 0.4, 0.6, 0.8]), 1));
  geometry.setAttribute('aSnowRatio', new THREE.InstancedBufferAttribute(new Float32Array(4).fill(1), 1));
  const source = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 4);
  source.customDepthMaterial = new THREE.MeshDepthMaterial();
  source.castShadow = true;
  const matrix = new THREE.Matrix4();
  const positions = [[1, 4, -10], [165, 20, -10], [5, 6, -15], [-1, 8, -10]];
  positions.forEach((p, i) => {
    source.setMatrixAt(i, matrix.makeTranslation(p[0], p[1], p[2]));
    source.setColorAt(i, new THREE.Color(i / 4, 0.5, 1));
  });
  let draws = 0;
  const savedRandom = Math.random;
  Math.random = () => { draws++; return 0.5; };
  let chunks;
  try { chunks = splitForestMesh(source, 1.2); } finally { Math.random = savedRandom; }
  assert.equal(draws, 0, 'splitting consumes no gameplay RNG');
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.flatMap(c => c.sourceIndices).sort((a, b) => a - b), [0, 1, 2, 3]);
  const point = new THREE.Vector3();
  for (const { mesh, sourceIndices } of chunks) {
    assert.notEqual(mesh.geometry.getAttribute('position'), geometry.getAttribute('position'), 'static GPU identity independent from the source');
    assert.equal(mesh.geometry.getAttribute('position').array, geometry.getAttribute('position').array, 'immutable CPU vertex data shared');
    assert.equal(mesh.geometry.getAttribute('position'), chunks[0].mesh.geometry.getAttribute('position'), 'static GPU buffers shared within family');
    assert.notEqual(mesh.geometry.getAttribute('aSnowLoad'), geometry.getAttribute('aSnowLoad'), 'chunk loads independent');
    assert.equal(mesh.customDepthMaterial, source.customDepthMaterial);
    assert.equal(mesh.castShadow, true);
    assert.equal(mesh.frustumCulled, true);
    assert(Number.isFinite(mesh.boundingSphere.radius));
    for (const [local, original] of sourceIndices.entries()) {
      mesh.getMatrixAt(local, matrix);
      assert.equal(matrix.elements[12], positions[original][0]);
      assert.equal(mesh.geometry.getAttribute('aSnowLoad').getX(local), geometry.getAttribute('aSnowLoad').getX(original));
      const a = new THREE.Color(), b = new THREE.Color();
      mesh.getColorAt(local, a); source.getColorAt(original, b);
      assert(a.equals(b));
      // Full-size and shed snow, plus every corner of a displacement envelope
      // larger than the shader's max 1.008u lean, 0.144u flutter, 0.6u droop.
      for (const ratio of [0.3, 0.65, 1]) for (let v = 0; v < geometry.getAttribute('position').count; v++) {
        for (const dx of [-1.152, 1.152]) for (const dz of [-1.152, 1.152]) for (const dy of [-0.6, 0]) {
          point.fromBufferAttribute(geometry.getAttribute('position'), v).multiplyScalar(ratio).applyMatrix4(matrix);
          point.add(new THREE.Vector3(dx, dy, dz));
          assert(mesh.boundingBox.containsPoint(point), 'moving/shed vertex remains in padded bounds');
          assert(mesh.boundingSphere.containsPoint(point), 'moving/shed vertex remains in culling sphere');
        }
      }
    }
  }
  // Actual Three frustum rejects a remote chunk while keeping the visible stand.
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(3, 5, 10); camera.lookAt(3, 5, -10); camera.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  assert(frustum.intersectsObject(chunks[0].mesh));
  assert(!frustum.intersectsObject(chunks[1].mesh), 'remote stand is culled');

  // Frozen pre-chunk placement + RNG result, captured with cold pools. A renderer
  // refactor must not silently rewrite the collider layout or downstream randoms.
  Trees.resetTreePools(); Trees.setEzForestEnabled(false);
  const scene = new THREE.Scene();
  Math.random = makeSceneryRng(731);
  let collisionPositions, next;
  try { collisionPositions = Trees.addTrees(scene); next = Math.random(); } finally { Math.random = savedRandom; }
  assert.equal(collisionPositions.length, 228);
  assert.equal(createHash('sha256').update(JSON.stringify(collisionPositions)).digest('hex'),
    '3c380896772cdc907e4ffa61bf0533fd11ef429479a05556b94ba0bf34eece85');
  assert.equal(next, 0.6300006124656647);
  const forest = scene.children.filter(c => c instanceof THREE.InstancedMesh);
  assert(forest.length > 5);
  assert.equal(forest.filter(m => m.userData.forestPart === 'trunk').reduce((sum, m) => sum + m.count, 0), collisionPositions.length);
  // A tree in any chunk still updates its own snow parts; no geographically
  // unrelated tree may inherit its load when source-index ranges are remapped.
  for (const index of [0, 42, 130, collisionPositions.length - 1]) {
    const before = forest.map(m => Array.from(m.geometry.getAttribute('aSnowLoad')?.array ?? []));
    Trees.setTreeLoad(index, 0.12345);
    let changed = 0;
    forest.forEach((m, mi) => {
      const loads = m.geometry.getAttribute('aSnowLoad');
      if (!loads) return;
      for (let k = 0; k < loads.count; k++) if (loads.getX(k) !== before[mi][k]) {
        m.getMatrixAt(k, matrix);
        assert(Math.hypot(matrix.elements[12] - collisionPositions[index].x, matrix.elements[14] - collisionPositions[index].z) < 10,
          'load update stays on the selected tree across chunk boundaries');
        changed++;
      }
    });
    assert(changed > 0);
  }
  // Rebuild must dispose every chunk wrapper + instance buffer and remove it.
  let meshesDisposed = 0, geometriesDisposed = 0;
  forest.forEach(m => {
    m.addEventListener('dispose', () => meshesDisposed++);
    m.geometry.addEventListener('dispose', () => geometriesDisposed++);
  });
  Trees.addTrees(scene);
  assert.equal(meshesDisposed, forest.length);
  assert.equal(geometriesDisposed, forest.length);
  assert(forest.every(m => m.parent === null));
  Trees.resetTreePools(); Trees.setEzForestEnabled(null);
  for (const { mesh } of chunks) { mesh.geometry.dispose(); mesh.dispose(); }
  source.dispose(); geometry.dispose(); source.material.dispose(); source.customDepthMaterial.dispose();
  console.log('Forest chunks: RNG/colliders, matrix/color/load pairing, bounds, frustum culling, shedding and rebuild passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
