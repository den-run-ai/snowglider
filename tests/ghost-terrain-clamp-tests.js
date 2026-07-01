// @ts-check
// ghost-terrain-clamp-tests.js
// Headless regression coverage for the ghost playback height clamp in src/course.ts.
//
// A ghost stores each sample's recorded y, which was the terrain height at that (x, z)
// WHEN the run happened. If the terrain later changes shape — e.g. the Black-tier
// corridor/course-line raises the surface where an older ghost was recorded — that
// stale y ends up BELOW the current snow and the ghost skis buried underground, a path
// no live player can follow. course.update() clamps the ghost's render height to the
// current surface (Math.max(recordedY, terrainHeight)), so a stale ghost always rides on
// top while a real jump arc recorded above the terrain is preserved.
//
// Run via the register-ts-resolve loader so the module's `./*.js` sibling imports
// resolve to their `.ts` sources.

'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS ✅' : 'FAIL ❌'}: ${name}`);
  condition ? pass++ : fail++;
}

async function main() {
  console.log('--- ghost terrain-height clamp (course.ts) ---');
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  const local = env.localStorage;

  // jsdom has no canvas 2d context; the gate banners paint a label texture. Stub a
  // no-op context so init()->buildGates() runs the production path headlessly.
  const noopCtx = {
    fillRect() {}, fillText() {},
    set fillStyle(_v) {}, set font(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
  };
  env.window.HTMLCanvasElement.prototype.getContext = () => noopCtx;

  const THREE = await import('three');
  const { CourseModule } = await import('../src/course.ts');

  // A stale ghost recorded on OLD terrain: it skied straight down the fall line at a
  // low surface height (y ~ 0). The samples are stored under the Black tier's key.
  const START_Z = CourseModule._config.START_Z; // -15
  const staleGhost = [
    { t: 0.0, x: 0, y: 0, z: START_Z, rot: 0 },
    { t: 1.0, x: 0, y: 0, z: START_Z - 20, rot: 0 },
    { t: 2.0, x: 0, y: 0, z: START_Z - 40, rot: 0 },
  ];
  local.setItem('snowgliderGhost_black', JSON.stringify(staleGhost));

  // The CURRENT terrain has since risen to +30 everywhere the old ghost travelled
  // (simulating the corridor walls raising the flanks the straight ghost sat on).
  const RAISED_SURFACE = 30;
  const getTerrainHeight = () => RAISED_SURFACE;

  // A minimal snowman factory: a real THREE group with one mesh so buildGhost's
  // material clone/traverse runs the production path.
  function createSnowman(scene) {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial());
    group.add(mesh);
    scene.add(group);
    return group;
  }

  const scene = new THREE.Scene();
  CourseModule.init({
    scene,
    getTerrainHeight,
    createSnowman,
    getDifficulty: () => 'black',
  });
  CourseModule.reset();

  // Grab the ghost object out of the scene (the second Group added — after any gates).
  function findGhost() {
    let found = null;
    scene.traverse((obj) => {
      if (obj.type === 'Group' && obj !== scene && obj.children.some((c) => c.type === 'Mesh')) {
        found = obj;
      }
    });
    return found;
  }

  // Drive one frame at t = 1.0s (ghost recorded y = 0, well below the +30 surface).
  CourseModule.update({ x: 0, y: RAISED_SURFACE, z: START_Z - 20 }, 1.0);
  const ghost = findGhost();

  check('a ghost object is spawned into the scene', !!ghost);
  check('ghost is visible during playback', !!ghost && ghost.visible === true);
  check('ghost x/z follow the recorded track', !!ghost && ghost.position.x === 0 && ghost.position.z === START_Z - 20);
  check('ghost is NOT buried: render y is clamped up to the current surface',
    !!ghost && ghost.position.y >= RAISED_SURFACE - 1e-6);

  // A recorded jump arc ABOVE the current surface must be preserved (not flattened).
  const jumpGhost = [
    { t: 0.0, x: 0, y: RAISED_SURFACE, z: START_Z, rot: 0 },
    { t: 1.0, x: 0, y: RAISED_SURFACE + 12, z: START_Z - 20, rot: 0 }, // airborne, 12u above snow
    { t: 2.0, x: 0, y: RAISED_SURFACE, z: START_Z - 40, rot: 0 },
  ];
  local.setItem('snowgliderGhost_black', JSON.stringify(jumpGhost));
  CourseModule.reset();
  CourseModule.update({ x: 0, y: RAISED_SURFACE, z: START_Z - 20 }, 1.0);
  const ghost2 = findGhost();
  check('recorded jump arc above the surface is preserved (not clamped down)',
    !!ghost2 && Math.abs(ghost2.position.y - (RAISED_SURFACE + 12)) < 1e-6);

  CourseModule.teardown();
  env.teardown();

  console.log(`\nGHOST TERRAIN-CLAMP TOTAL: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
