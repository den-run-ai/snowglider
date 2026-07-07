// @ts-check
// snowman-face-tests.js — headless coverage for the static face rig (issue #364, PR 1).
//
// The face rig (src/snowman/face.ts) adds the coal-bead mouth, twig brows, frosty
// cheeks, and eye-highlight dots to the procedural snowman and registers them in the
// cosmetic part registry so the expression controller (PR 2+) can animate them. This
// suite locks in the STATIC contract:
//   1. every face part is present in userData.parts and got a recorded base transform;
//   2. the mouth has 7 beads under a mouth Group; pupils ride under the eyes;
//   3. adding the face did NOT move any pre-existing part (eyes/nose/hat/balls world
//      positions stay byte-identical — proof this is purely additive, no baseline shift);
//   4. face parts don't cast shadows (matching the existing eyes/nose) and are finite;
//   5. coal beads/brows reuse the shared black material; cheeks/pupils are plain
//      MeshStandardMaterials (so they share the standard shader program — perf budget).
//
// CommonJS + dynamic import like the other model suites (register-ts-resolve loader):
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/snowman-face-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { createSnowman } = await import('../src/snowman/model.ts');

  const scene = new THREE.Scene();
  const snowman = createSnowman(scene);
  snowman.updateMatrixWorld(true);
  const parts = snowman.userData.parts;
  const base = snowman.userData.partBaseTransforms;

  console.log('--- face rig: registry + base transforms ---');
  const faceKeys = [
    'mouth', 'mouthBead0', 'mouthBead1', 'mouthBead2', 'mouthBead3', 'mouthBead4',
    'mouthBead5', 'mouthBead6', 'leftBrow', 'rightBrow', 'leftCheek', 'rightCheek',
    'leftPupil', 'rightPupil',
  ];
  check('every face part is registered in userData.parts',
    faceKeys.every((k) => !!parts[k] && parts[k].isObject3D));
  check('every face part got a recorded base transform (for reset/offsets)',
    faceKeys.every((k) => !!base[k] && typeof base[k].position.x === 'number'));

  console.log('--- structure: mouth group + bead / pupil parenting ---');
  check('mouth is a THREE.Group', parts.mouth.isGroup === true);
  check('mouth has exactly 7 coal beads as children',
    parts.mouth.children.length === 7 &&
    [0, 1, 2, 3, 4, 5, 6].every((i) => parts[`mouthBead${i}`].parent === parts.mouth));
  check('mouth is parented under the head mesh', parts.mouth.parent === parts.head);
  check('brows + cheeks are parented under the head mesh',
    parts.leftBrow.parent === parts.head && parts.rightBrow.parent === parts.head &&
    parts.leftCheek.parent === parts.head && parts.rightCheek.parent === parts.head);
  check('eye-highlight dots ride under the coal eyes',
    parts.leftPupil.parent === parts.leftEye && parts.rightPupil.parent === parts.rightEye);

  console.log('--- purely additive: pre-existing part world positions unchanged ---');
  // The shipped layout (byte-identical): eyes (±0.4, 7.2, 0.8), nose (0, 7.0, 1.0),
  // hatBase y=7.9, hatTop y=8.45, balls at y = 2 / 4.5 / 7. getWorldPosition must
  // recover these through the headGroup + flipPivot restructure regardless of the
  // face additions.
  const w = new THREE.Vector3();
  const near = (v, x, y, z) => Math.abs(v.x - x) < 1e-3 && Math.abs(v.y - y) < 1e-3 && Math.abs(v.z - z) < 1e-3;
  check('leftEye world position unchanged (0.4, 7.2, 0.8)',
    near(parts.leftEye.getWorldPosition(w), 0.4, 7.2, 0.8));
  check('rightEye world position unchanged (-0.4, 7.2, 0.8)',
    near(parts.rightEye.getWorldPosition(w), -0.4, 7.2, 0.8));
  check('nose world position unchanged (0, 7.0, 1.0)',
    near(parts.nose.getWorldPosition(w), 0, 7.0, 1.0));
  check('hatBase world y unchanged (7.9)', Math.abs(parts.hatBase.getWorldPosition(w).y - 7.9) < 1e-3);
  check('hatTop world y unchanged (8.45)', Math.abs(parts.hatTop.getWorldPosition(w).y - 8.45) < 1e-3);
  check('body balls world y unchanged (2 / 4.5 / 7)',
    Math.abs(parts.bottom.getWorldPosition(w).y - 2) < 1e-3 &&
    Math.abs(parts.middle.getWorldPosition(w).y - 4.5) < 1e-3 &&
    Math.abs(parts.head.getWorldPosition(w).y - 7) < 1e-3);

  console.log('--- face geometry sits on the front face hemisphere (+z) + finite ---');
  const finite3 = (p) => Number.isFinite(p.position.x) && Number.isFinite(p.position.y) && Number.isFinite(p.position.z);
  check('all mouth beads have finite local positions', [0, 1, 2, 3, 4, 5, 6].every((i) => finite3(parts[`mouthBead${i}`])));
  check('mouth beads sit proud of the face (+z surface)', [0, 1, 2, 3, 4, 5, 6].every((i) => parts[`mouthBead${i}`].position.z > 0.6));
  check('neutral mouth is a gentle smile (outer beads lifted above the centre bead)',
    parts.mouthBead0.position.y > parts.mouthBead3.position.y && parts.mouthBead6.position.y > parts.mouthBead3.position.y);
  check('brows sit above the eyes (y > eye y 0.2, head-local)',
    parts.leftBrow.position.y > 0.2 && parts.rightBrow.position.y > 0.2);

  console.log('--- shadows off + material sharing (perf budget) ---');
  const faceMeshes = ['mouthBead0', 'mouthBead3', 'leftBrow', 'rightBrow', 'leftCheek', 'rightCheek', 'leftPupil', 'rightPupil'];
  check('face parts do NOT cast shadows (matches eyes/nose)', faceMeshes.every((k) => parts[k].castShadow === false));
  const blackMat = parts.leftEye.material; // the shared black coal material
  check('coal beads reuse the shared black material', parts.mouthBead0.material === blackMat && parts.mouthBead3.material === blackMat);
  check('twig brows reuse the shared black material', parts.leftBrow.material === blackMat && parts.rightBrow.material === blackMat);
  check('cheeks + pupils are plain MeshStandardMaterial (share the standard program)',
    parts.leftCheek.material.isMeshStandardMaterial === true && parts.leftPupil.material.isMeshStandardMaterial === true);
  check('both cheeks share one material instance; both pupils share one',
    parts.leftCheek.material === parts.rightCheek.material && parts.leftPupil.material === parts.rightPupil.material);
  check('all 7 beads share ONE geometry; both brows share ONE (pooled)',
    [1, 2, 3, 4, 5, 6].every((i) => parts[`mouthBead${i}`].geometry === parts.mouthBead0.geometry) &&
    parts.leftBrow.geometry === parts.rightBrow.geometry);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
