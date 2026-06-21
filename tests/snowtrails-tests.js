/**
 * Temporary ski-track overlay tests for SnowGlider (issue #17 follow-up).
 *
 * Mirrors avalanche-tests.js: runs against the REAL `src/snowtracks.ts` ES module
 * and real three.js from npm. three's geometry/material/InstancedMesh constructors
 * need no WebGL context, so `SnowTrails` constructs fine headless under Node.
 *
 * The trail system is purely cosmetic, so the assertions are about its *contract*:
 * it stamps grooves only while grounded and moving, fades them over their lifetime,
 * clears on reset, and never claims to touch physics state.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ts = require('typescript');

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
  return true;
}
function assertEquals(a, b, message) {
  if (a !== b) throw new Error(message || `Expected ${a} to equal ${b}`);
  return true;
}

let passCount = 0;
let failCount = 0;

async function importTranspiledTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      sourceMap: false
    },
    fileName: sourcePath
  });
  const tempDir = path.join(__dirname, '.tmp-snowtrails-tests');
  const tempPath = path.join(tempDir, `snowtrails-${process.pid}-${Date.now()}.mjs`);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(tempPath, transpiled.outputText, 'utf8');
  try {
    return await import(pathToFileURL(tempPath).href);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runTest(name, testFn) {
  try {
    testFn();
    console.log(`✅ PASS: ${name}`);
    passCount++;
  } catch (error) {
    console.log(`❌ FAIL: ${name}`);
    console.log(`   Error: ${error.message}`);
    failCount++;
  }
}

async function main() {
  const THREE = await import('three');
  const { SnowTrails } = await importTranspiledTypeScriptModule(
    path.join(__dirname, '..', 'src', 'snowtracks.ts')
  );

  // matchMedia is undefined under Node => reduced-motion is treated as OFF, so the
  // system is enabled and stamping runs. Flat terrain keeps the math simple.
  const makeTrails = (count) => {
    const t = new SnowTrails(new THREE.Scene(), count);
    t.setTerrainFunction(() => 0);
    return t;
  };
  // Move the snowman far enough each tick to force at least one stamp.
  const snowmanAt = (x, z, heading = 0) => ({ position: { x, y: 0, z }, rotation: { y: heading } });

  console.log('\n🎿 SNOWGLIDER SNOW-TRAILS TESTS 🎿');
  console.log('==================================\n');

  runTest('Initialization', () => {
    const trails = makeTrails(40);
    assertEquals(trails.count, 40, 'pool size should match');
    assert(trails.mesh && trails.mesh.isInstancedMesh === true, 'should build a real InstancedMesh');
    assertEquals(trails.mesh.geometry.type, 'PlaneGeometry', 'dabs are flat quads');
    assertEquals(trails.activeCount(), 0, 'no dabs active before any update');
  });

  runTest('Mesh added to scene; frustum culling disabled', () => {
    const scene = new THREE.Scene();
    const trails = new SnowTrails(scene, 20);
    assert(scene.children.includes(trails.mesh), 'constructor adds its mesh to the scene');
    assertEquals(trails.mesh.frustumCulled, false, 'trail batch must not be frustum-culled');
  });

  runTest('Terrain function connection', () => {
    const trails = new SnowTrails(new THREE.Scene(), 10);
    trails.setTerrainFunction((x, z) => x + z);
    assert(trails.getTerrainHeight !== null, 'terrain function should be set');
    assertEquals(trails.getTerrainHeight(3, 4), 7, 'terrain function should be used');
  });

  runTest('Stamps grooves while grounded and moving', () => {
    const trails = makeTrails(60);
    // First update seeds the anchor without stamping.
    trails.update(0.1, snowmanAt(0, 0), false);
    assertEquals(trails.activeCount(), 0, 'first frame only anchors position');
    // Move 5 units in one frame at speed -> multiple stamp pairs.
    trails.update(0.1, snowmanAt(0, -5), false);
    assert(trails.activeCount() >= 2, 'moving on the ground should stamp dab pairs');
  });

  runTest('A fast/hitchy frame spreads its dabs along the path, not stacked (#181)', () => {
    const trails = makeTrails(220);
    trails.update(0.1, snowmanAt(0, 0), false);    // anchor
    // One frame covering ~10x STAMP_SPACING (a hitch / fast glide / capped delta).
    trails.update(0.1, snowmanAt(0, -11), false);
    assert(trails.activeCount() >= 10, `a fast frame should lay many dabs, got ${trails.activeCount()}`);
    // Collect the z of every *active* dab (non-zero scale in its instance matrix).
    const m = new THREE.Matrix4();
    const zs = [];
    for (let i = 0; i < trails.count; i++) {
      trails.mesh.getMatrixAt(i, m);
      const e = m.elements;
      if (Math.hypot(e[0], e[1], e[2]) > 1e-4) zs.push(e[14]); // e[14] = z
    }
    const maxZ = Math.max(...zs); // nearest the segment start (~ -1.1)
    const minZ = Math.min(...zs); // nearest the segment end   (~ -11)
    // The pre-fix code stamped every miss at the endpoint, so the span was ~0.
    assert(maxZ - minZ > 5, `dabs must spread along the 11-unit path; span was ${(maxZ - minZ).toFixed(2)}`);
    assert(maxZ > -3, `a dab should land near the segment start; nearest was z=${maxZ.toFixed(2)}`);
  });

  runTest('Dabs conform to the terrain slope (not left flat)', () => {
    // Terrain that drops along +z (height = -0.2*z) => surface normal tilts in z.
    const trails = new SnowTrails(new THREE.Scene(), 40);
    trails.setTerrainFunction((x, z) => -0.2 * z);
    trails.update(0.1, snowmanAt(0, 0), false);
    trails.update(0.1, snowmanAt(0, -5), false); // move -> stamp pairs
    assert(trails.activeCount() > 0, 'should have stamped a dab to inspect');
    // The instance's up axis (matrix column 1) should follow the terrain normal
    // (~(0,1,0.2) normalized), i.e. a clearly non-zero z component — a flat dab
    // would leave it at (0,1,0).
    const m = new THREE.Matrix4();
    trails.mesh.getMatrixAt(0, m);
    const e = m.elements;
    const upZ = e[6]; // z component of the local +Y axis after rotation (scaleY = 1)
    assert(Math.abs(upZ) > 0.1, `dab up axis should tilt to the slope (got upZ=${upZ.toFixed(3)})`);
  });

  runTest('No stamping while airborne', () => {
    const trails = makeTrails(60);
    trails.update(0.1, snowmanAt(0, 0), true);
    trails.update(0.1, snowmanAt(0, -5), true); // airborne: skis not in snow
    assertEquals(trails.activeCount(), 0, 'airborne travel should not stamp trails');
  });

  runTest('No stamping when essentially stopped', () => {
    const trails = makeTrails(60);
    trails.update(0.1, snowmanAt(0, 0), false);
    // Tiny movement below the speed threshold across many frames.
    for (let i = 0; i < 20; i++) trails.update(0.1, snowmanAt(0, -0.001 * i), false);
    assertEquals(trails.activeCount(), 0, 'sub-threshold creep should not stamp trails');
  });

  runTest('Dabs fade out over their lifetime', () => {
    const trails = makeTrails(60);
    trails.update(0.1, snowmanAt(0, 0), false);
    trails.update(0.1, snowmanAt(0, -5), false);
    const active = trails.activeCount();
    assert(active > 0, 'should have active dabs to fade');
    // Age past the lifetime with the snowman parked (no new stamps).
    for (let i = 0; i < 120; i++) trails.update(0.1, snowmanAt(0, -5), false);
    assertEquals(trails.activeCount(), 0, 'all dabs should expire once covered by fresh snow');
  });

  runTest('reset() clears all trails and the stamp cadence', () => {
    const trails = makeTrails(60);
    trails.update(0.1, snowmanAt(0, 0), false);
    trails.update(0.1, snowmanAt(0, -5), false);
    assert(trails.activeCount() > 0, 'should have trails before reset');
    trails.reset();
    assertEquals(trails.activeCount(), 0, 'reset clears every dab');
    // After reset the next frame re-anchors (no immediate stamp burst).
    trails.update(0.1, snowmanAt(10, 10), false);
    assertEquals(trails.activeCount(), 0, 'reset re-anchors cadence; no stamp on the first frame');
  });

  runTest('Ring buffer is bounded by the pool size', () => {
    const trails = makeTrails(8);
    trails.update(0.1, snowmanAt(0, 0), false);
    // Drive a long way so far more dab pairs are requested than the pool holds.
    for (let i = 1; i <= 50; i++) trails.update(0.05, snowmanAt(0, -3 * i), false);
    assert(trails.activeCount() <= 8, 'active dabs never exceed the fixed pool');
  });

  runTest('Disabled (reduced motion) system is an inert no-op', () => {
    const trails = makeTrails(20);
    trails.enabled = false; // simulate prefers-reduced-motion
    trails.update(0.1, snowmanAt(0, 0), false);
    trails.update(0.1, snowmanAt(0, -5), false);
    assertEquals(trails.activeCount(), 0, 'a disabled trail system stamps nothing');
  });

  console.log(`\n==================================`);
  console.log(`Tests completed: ${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Snow-trails test harness crashed:', err);
  process.exit(1);
});
