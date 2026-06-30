// @ts-check
// Headless coverage for the obstacle contact-shadow decals (issue #17).
//
// addContactShadows places one soft AO blob under each tree + large rock as a single
// InstancedMesh, so hazards read as grounded against the bright snow. These assertions
// verify the instance count, placement (on the terrain, sized to the obstacle), the
// no-shadow flags, the empty/headless fall-backs, and that it never throws without a DOM.
// Pure + WebGL-free (THREE buffers only). CommonJS + dynamic import so the
// register-ts-resolve loader resolves the `.ts` sources + 'three'.

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

async function main() {
  const THREE = await import('three');
  const { addContactShadows } = await import('../src/mountains/contact-shadows.ts');

  console.log('--- contact-shadows: placement ---');
  const scene = new THREE.Scene();
  const trees = [
    { x: 5, y: 0, z: -20, scale: 1.0 },
    { x: -8, y: 0, z: -40, scale: 0.1 },  // tiny -> radius floor
  ];
  const rocks = [
    { x: 30, y: 0, z: -60, size: 2.0 },
  ];
  const getH = (x, z) => 100 + x * 0.01 + z * 0.02; // varying terrain height

  const mesh = addContactShadows(scene, trees, rocks, getH);
  check('returns an InstancedMesh', !!mesh && mesh.isInstancedMesh === true);
  check('one instance per tree + rock', mesh.count === trees.length + rocks.length);
  check('named for the cleanup sweep', mesh.name === 'contactShadows');
  check('never casts or receives shadows (it IS the fake shadow)', mesh.castShadow === false && mesh.receiveShadow === false);
  check('added to the scene', scene.children.includes(mesh));

  // Decode instance 0 (tree, scale 1 -> radius 1.6 -> quad span 3.2) and check it sits on
  // the terrain at the obstacle's x/z.
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  mesh.getMatrixAt(0, m); m.decompose(p, q, s);
  check('blob 0 centred on the tree x/z', approx(p.x, 5) && approx(p.z, -20));
  check('blob 0 sits just above the terrain height', approx(p.y, getH(5, -20) + 0.05));
  check('blob 0 sized to the tree footprint (radius 1.6 -> span 3.2)', approx(s.x, 3.2) && approx(s.z, 3.2));

  // Instance 1 is the tiny tree -> radius floored to 0.8 -> span 1.6.
  mesh.getMatrixAt(1, m); m.decompose(p, q, s);
  check('tiny obstacle radius is floored (span 1.6, not 0.32)', approx(s.x, 1.6));

  // Instance 2 is the rock (size 2 -> radius 2.3 -> span 4.6).
  mesh.getMatrixAt(2, m); m.decompose(p, q, s);
  check('rock blob sized by rock.size (radius 2.3 -> span 4.6)', approx(s.x, 4.6) && approx(p.x, 30));

  console.log('\n--- contact-shadows: edge cases ---');
  check('no obstacles -> returns null (no empty draw)', addContactShadows(new THREE.Scene(), [], [], getH) === null);
  check('headless build has no texture map (document-guarded), did not throw',
    mesh.material.map === null);
  check('material is a soft transparent black overlay', mesh.material.transparent === true && mesh.material.depthWrite === false);

  console.log(`\ncontact-shadows: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error('❌ CONTACT-SHADOWS TESTS FAILED:', err); process.exit(1); });
