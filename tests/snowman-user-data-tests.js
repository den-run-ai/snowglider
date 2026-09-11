// @ts-check
// The raw THREE dictionary is an interface boundary for structural/headless rigs.
const assert = require('node:assert/strict');

async function main() {
  const THREE = await import('three');
  const { getSnowmanUserData, setSnowmanUserData } = await import('../src/snowman/user-data.ts');
  const { createSnowman } = await import('../src/snowman/model.ts');

  const rig = new THREE.Group();
  const raw = {
    plowCharge: 0.25,
    playerJump: false,
    leftSki: { position: { x: -1 }, rotation: { y: 0, z: 0 } },
    clearedObstacles: { 'tree:1': true }
  };
  rig.userData = raw;
  const state = getSnowmanUserData(rig);
  assert.strictEqual(state, raw, 'validation preserves the caller-owned bag and ski refs');
  state.plowCharge = 0.5;
  assert.equal(raw.plowCharge, 0.5, 'kernel and observers share one mutable state');
  assert.strictEqual(getSnowmanUserData(rig), state, 'subsequent frames reuse the same state');

  for (const bad of [
    { plowCharge: '0.5' }, { currentRotX: NaN }, { trickSpin: Infinity },
    { playerJump: 'false' }, { technique: 'teleport' },
    { leftSki: { position: { x: 0 }, rotation: { y: 'zero', z: 0 } } },
    { clearedObstacles: { 'tree:1': 'yes' } }, { parts: { bottom: {} } },
    { partBaseTransforms: { bottom: { position: {}, rotation: {}, scale: {} } } },
    { flipPivot: {} }, { shatterRoots: [{}] }
  ]) {
    rig.userData = bad;
    assert.throws(() => getSnowmanUserData(rig), TypeError,
      'replacement bags must be validated before entering physics or pose');
  }

  let fieldReads = 0;
  const external = { get trickSpin() { fieldReads++; return 0; } };
  rig.userData = external;
  getSnowmanUserData(rig);
  const initialReads = fieldReads;
  assert.ok(initialReads > 0, 'unknown rigs are validated on entry');
  for (let i = 0; i < 1000; i++) getSnowmanUserData(rig);
  assert.equal(fieldReads, initialReads, 'hot frames do not revalidate every metadata field');

  const known = { trickSpin: 90, playerJump: true };
  setSnowmanUserData(rig, known);
  assert.strictEqual(getSnowmanUserData(rig), known, 'typed construction installs the exact bag');
  assert.strictEqual(rig.userData, known, 'public THREE observers see the same state');

  const model = createSnowman(new THREE.Scene());
  const modelData = getSnowmanUserData(model);
  assert.strictEqual(modelData.parts, model.userData.parts);
  assert.ok(modelData.parts?.bottom instanceof THREE.Mesh);
  assert.ok(modelData.flipPivot instanceof THREE.Group);
  assert.ok(modelData.shatterRoots?.every(part => part instanceof THREE.Object3D));
  console.log('PASS: snowman metadata validates external rigs, shares typed state and has a cached hot path');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
