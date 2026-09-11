// @ts-check
// Real simulation handles + Three camera/frustum math: packing, transparency
// order, billboard vertex parity, sparse uploads, and disposal across remounts.
const assert = require('node:assert/strict');

async function main() {
  const THREE = await import('three');
  const { Snow } = await import('../src/snow.ts');
  const { snowBillboardsFor } = await import('../src/snow-billboards.ts');
  const { AvalancheSystem } = await import('../src/avalanche.ts');
  globalThis.document = /** @type {any} */ ({
    createElement: () => ({ width: 0, height: 0, getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }), fillRect() {},
    }) }),
  });

  const scene = new THREE.Scene();
  let priorRenderCalls = 0;
  const previousHook = () => { priorRenderCalls++; };
  scene.onBeforeRender = previousHook;
  const flakes = Snow.createSnowflakes(scene);
  const snowman = new THREE.Object3D();
  const splash = Snow.createSnowSplash();
  Snow.updateSnowSplash(splash, 0, snowman, { x: 0, z: 0 }, true, scene);
  const batch = snowBillboardsFor(scene);
  assert.equal(splash.batch, batch, 'snowfall and both spray textures share one batch');
  assert.equal(scene.children.length, 1, 'only the batch enters renderer traversal');
  assert.ok([...flakes, ...splash.particles].every((p) => p.parent === null));

  const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 100);
  camera.updateMatrixWorld(true);
  for (const flake of flakes) flake.visible = false;
  const far = flakes[0], near = splash.particles[0], middle = splash.particles[1];
  for (const [p, z] of [[far, -30], [middle, -20], [near, -10]]) {
    const sprite = /** @type {import('three').Sprite} */ (p);
    sprite.visible = true;
    sprite.position.set(0, 0, /** @type {number} */ (z));
    sprite.scale.set(2.5, 1.5, 1);
    sprite.material.opacity = 0.45;
    sprite.material.rotation = 0.63;
    sprite.material.color.setRGB(0.7, 0.8, 0.9);
    sprite.center.set(0.3, 0.6);
  }
  Reflect.apply(scene.onBeforeRender, scene, [{}, scene, camera, null]);
  assert.equal(priorRenderCalls, 1, 'existing scene callbacks are preserved');
  assert.equal(batch.mesh.geometry.instanceCount, 3);
  const positions = batch.mesh.geometry.getAttribute('aParticlePosition');
  assert.deepEqual([0, 1, 2].map((i) => positions.getZ(i)), [-30, -20, -10],
    'all texture families sort together, back to front');
  const sizes = batch.mesh.geometry.getAttribute('aParticleSizeRotation');
  const centers = batch.mesh.geometry.getAttribute('aParticleCenter');
  const colors = batch.mesh.geometry.getAttribute('aParticleColor');
  const textures = batch.mesh.geometry.getAttribute('aParticleTexture');
  assert.ok(positions instanceof THREE.InstancedBufferAttribute);
  assert.equal(textures.getX(0), 0);
  assert.equal(textures.getX(2), near.userData.type === 0 ? 1 : 2);
  assert.ok(Math.abs(colors.getW(0) - 0.45) < 1e-6);
  assert.ok(Math.abs(colors.getX(0) - 0.7) < 1e-6);
  assert.equal(positions.usage, THREE.DynamicDrawUsage);
  assert.equal(positions.updateRanges[0].count, 9, 'only live positions are uploaded');
  assert.equal(batch.mesh.material.depthWrite, false);
  assert.equal(batch.mesh.material.fog, true);
  assert.equal(batch.mesh.material.blending, THREE.NormalBlending);
  assert.equal(batch.mesh.material.uniforms.flakeMap.value, far.material.map);
  assert.ok(batch.mesh.material.vertexShader.includes('vParticleUv = uv;'));
  assert.ok(!batch.mesh.material.vertexShader.includes('modelViewMatrix[ 3 ]'),
    'Three upgrades cannot silently restore a shared object center');
  assert.ok(!batch.mesh.material.vertexShader.includes('cos( rotation )'),
    'rotation is per particle, not a shared material uniform');
  assert.ok(!batch.mesh.material.fragmentShader.includes('#include <map_fragment>'),
    'all particle texture families use their original samplers');
  const avalanche = new AvalancheSystem(scene, 1);
  const powder = avalanche.powder[0];
  powder.visible = true;
  powder.position.set(0, 0, -25);
  powder.scale.set(3, 3, 3);
  powder.material.opacity = 0.5;
  batch.sync(camera);
  assert.equal(batch.mesh.geometry.instanceCount, 4);
  assert.deepEqual([0, 1, 2, 3].map((i) => positions.getZ(i)), [-30, -25, -20, -10],
    'avalanche powder interleaves with snowfall and ski spray in the same draw');
  assert.equal(textures.getX(1), 3);
  assert.ok(avalanche.powder.every((p) => !p.parent), 'avalanche has no separate alpha-sprite draws');
  avalanche.dispose();
  batch.sync(camera);
  assert.equal(batch.mesh.material.uniforms.avalancheMap.value, null);
  assert.equal(batch.mesh.geometry.instanceCount, 3);
  assert.equal(positions.count, 1528, 'buffers bound all four existing particle pools');

  // Independent reference: transform a real Sprite's stock geometry with Three
  // matrices and the stock Sprite shader equation, then compare the packed data.
  far.updateMatrixWorld(true);
  const referenceView = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, far.matrixWorld);
  const referenceCenter = new THREE.Vector3().setFromMatrixPosition(referenceView);
  const referenceScale = new THREE.Vector3().setFromMatrixScale(far.matrixWorld);
  const corner = new THREE.Vector3().fromBufferAttribute(far.geometry.getAttribute('position'), 2);
  const aligned = new THREE.Vector2(
    (corner.x - (far.center.x - 0.5)) * referenceScale.x,
    (corner.y - (far.center.y - 0.5)) * referenceScale.y,
  ).rotateAround(new THREE.Vector2(), far.material.rotation);
  referenceCenter.x += aligned.x;
  referenceCenter.y += aligned.y;
  const referenceNdc = referenceCenter.applyMatrix4(camera.projectionMatrix);
  const packedCenter = new THREE.Vector3().fromBufferAttribute(positions, 0).applyMatrix4(camera.matrixWorldInverse);
  const packedAligned = new THREE.Vector2(
    (corner.x - (centers.getX(0) - 0.5)) * sizes.getX(0),
    (corner.y - (centers.getY(0) - 0.5)) * sizes.getY(0),
  ).rotateAround(new THREE.Vector2(), sizes.getZ(0));
  packedCenter.x += packedAligned.x;
  packedCenter.y += packedAligned.y;
  assert.ok(referenceNdc.distanceTo(packedCenter.applyMatrix4(camera.projectionMatrix)) < 1e-6,
    'billboard corners retain Sprite size, alignment, rotation and perspective');

  // Moving/turning the camera must repack THIS render, not lag by one frame.
  camera.position.z = -40;
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  batch.sync(camera);
  assert.deepEqual([0, 1, 2].map((i) => positions.getZ(i)), [-10, -20, -30]);
  near.visible = false;
  middle.position.x = 1000;
  batch.sync(camera);
  assert.equal(batch.mesh.geometry.instanceCount, 1, 'inactive and offscreen particles are omitted');
  far.scale.set(0, 0, 0);
  batch.sync(camera);
  assert.equal(batch.mesh.geometry.instanceCount, 0, 'no zero-area/inactive GPU instances');

  // CPU state sampling/upload must not consume gameplay OR cosmetic randomness.
  const savedRandom = Math.random;
  let draws = 0;
  Math.random = () => { draws++; return 0.5; };
  const isolatedScene = new THREE.Scene(); // one known THREE UUID allocation
  draws = 0;
  const isolatedBatch = snowBillboardsFor(isolatedScene);
  isolatedBatch.sync(camera);
  isolatedBatch.dispose();
  Math.random = savedRandom;
  assert.equal(draws, 0, 'batch allocation and render sync leave ambient RNG untouched');

  let geometryDisposals = 0, materialDisposals = 0, textureDisposals = 0;
  batch.mesh.geometry.addEventListener('dispose', () => { geometryDisposals++; });
  batch.mesh.material.addEventListener('dispose', () => { materialDisposals++; });
  const sprayTextures = new Set(splash.particles.map((p) => p.material.map));
  for (const texture of sprayTextures) texture.addEventListener('dispose', () => { textureDisposals++; });
  Snow.teardownSnowflakes();
  assert.equal(scene.children.length, 1, 'spray keeps the shared batch alive');
  assert.equal(batch.mesh.material.uniforms.flakeMap.value, null,
    'a removed pool cannot re-upload its disposed texture through stale sampler uniforms');
  Snow.teardownSnowSplash(splash);
  Snow.teardownSnowSplash(splash);
  assert.equal(scene.children.length, 0);
  assert.equal(scene.onBeforeRender, previousHook);
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(textureDisposals, 2, 'detached spray textures are freed exactly once');
  assert.equal(splash.particles.length, 0);
  assert.notEqual(snowBillboardsFor(scene), batch, 'remount creates a fresh batch');
  snowBillboardsFor(scene).dispose();
  console.log('SNOW BILLBOARDS: packing, sorting, Sprite parity, culling, RNG, and teardown passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
