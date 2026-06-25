// @ts-check
/**
 * Headless tests for the Tier 3 sun cycle in src/sky.ts (issue #163, contract in
 * issue #188). The cycle is a *bounded atmospheric layer*: it captures the merged
 * static-midday lighting at setup and only sweeps the directional sun, the sky
 * exposure, and the fog/background between that captured midday and a low, warm
 * golden hour. It must never touch the HemisphereLight, the AmbientLight, snow
 * albedo, or terrain.
 *
 * Runs against the REAL src/sky.ts and real three.js from npm — three's
 * Light/Color/Fog/ShaderMaterial constructors need no WebGL context, so the cycle
 * drives a real scene headless under Node.
 *
 * Run with the .js -> .ts resolve hook:
 *   node --import ./tests/loaders/register-ts-resolve.mjs tests/sky-cycle-tests.js
 */

const assert = require('node:assert');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS ✅: ${name}`);
}

(async () => {
  const THREE = await import('three');
  const { Sky } = await import('../src/sky.js');

  // The merged static lighting from src/game/scene-setup.ts (post-#181). The cycle
  // must capture THESE at runtime — never the old pre-#181 0.8π/0.5π constants.
  const STATIC_AMB_INTENSITY = 0.26 * Math.PI;
  const STATIC_HEMI_INTENSITY = 0.62 * Math.PI;
  const STATIC_DIR_INTENSITY = 0.5 * Math.PI;
  const OLD_WHITEOUT_AMBIENT = 0.5 * Math.PI; // the value the cycle must never approach

  /** Build a scene with the exact static lights scene-setup creates. */
  function makeScene() {
    const scene = new THREE.Scene();
    const ambient = new THREE.AmbientLight(0xffffff, STATIC_AMB_INTENSITY);
    const hemisphere = new THREE.HemisphereLight(0xdcebfb, 0xbcc7d4, STATIC_HEMI_INTENSITY);
    const directional = new THREE.DirectionalLight(0xffffff, STATIC_DIR_INTENSITY);
    directional.position.set(50, 100, 50);
    scene.add(ambient);
    scene.add(hemisphere);
    scene.add(directional);
    return { scene, ambient, hemisphere, directional };
  }

  /** Read every value the cycle is allowed to drive, off the live scene objects. */
  function liveState(scene, directional) {
    const sky = scene.children.find((c) => c.name === 'AtmosphericSky');
    const u = sky.material.uniforms;
    return {
      sunPos: u.sunPosition.value.clone(),
      exposure: u.exposure.value,
      dirPos: directional.position.clone(),
      dirIntensity: directional.intensity,
      dirColor: directional.color.getHex(),
      fog: scene.fog.color.getHex(),
      bg: scene.background.getHex()
    };
  }

  function assertStateEqual(a, b, msg) {
    assert.ok(a.sunPos.distanceTo(b.sunPos) < 1e-12, `${msg}: sunPosition`);
    assert.strictEqual(a.exposure, b.exposure, `${msg}: exposure`);
    assert.ok(a.dirPos.distanceTo(b.dirPos) < 1e-12, `${msg}: dir position`);
    assert.strictEqual(a.dirIntensity, b.dirIntensity, `${msg}: dir intensity`);
    assert.strictEqual(a.dirColor, b.dirColor, `${msg}: dir colour`);
    assert.strictEqual(a.fog, b.fog, `${msg}: fog colour`);
    assert.strictEqual(a.bg, b.bg, `${msg}: background colour`);
  }

  console.log('--- Sun cycle (sky.ts) ---');

  // -------------------------------------------------------------------------
  test('midday == captured static snapshot (captured, not hardcoded old constants)', () => {
    const { scene, directional } = makeScene();
    Sky.applyAtmosphericSky(scene, directional);
    const captured = liveState(scene, directional);

    // It captured the STATIC scene values, not the old #163 hardcoded 0.8π/0.5π.
    assert.strictEqual(captured.dirIntensity, STATIC_DIR_INTENSITY, 'captured the static 0.5π directional');
    assert.notStrictEqual(captured.dirIntensity, 0.8 * Math.PI, 'did not revert to the old 0.8π');
    assert.strictEqual(captured.dirColor, 0xffffff, 'midday sun is white');
    // Midday sun direction is the normalized static (50,100,50).
    const expected = new THREE.Vector3(50, 100, 50).normalize();
    assert.ok(captured.sunPos.distanceTo(expected) < 1e-9, 'sun direction == static light');

    // After a full period the live state returns to that exact captured snapshot.
    Sky.update(Sky.CYCLE_DURATION_S);
    assertStateEqual(liveState(scene, directional), captured, 'after one full period');
  });

  // -------------------------------------------------------------------------
  test('reduced-motion freeze leaves lights/fog/background/uniforms exactly static', () => {
    const { scene, directional } = makeScene();
    Sky.applyAtmosphericSky(scene, directional, { reducedMotion: true });
    const frozen = liveState(scene, directional);
    for (let i = 0; i < 200; i++) Sky.update(0.5);
    assertStateEqual(liveState(scene, directional), frozen, 'reduced-motion');
  });

  // -------------------------------------------------------------------------
  test('SUN_CYCLE_ENABLED=false leaves lights/fog/background/uniforms exactly static', () => {
    const { scene, directional } = makeScene();
    Sky.applyAtmosphericSky(scene, directional, { enabled: false });
    const frozen = liveState(scene, directional);
    for (let i = 0; i < 200; i++) Sky.update(0.5);
    assertStateEqual(liveState(scene, directional), frozen, 'disabled');
  });

  // -------------------------------------------------------------------------
  test('HemisphereLight is untouched across setup and updates', () => {
    const { scene, hemisphere, directional } = makeScene();
    const before = {
      sky: hemisphere.color.getHex(),
      ground: hemisphere.groundColor.getHex(),
      intensity: hemisphere.intensity
    };
    Sky.applyAtmosphericSky(scene, directional);
    for (let i = 0; i < 180; i++) Sky.update(0.5);
    assert.strictEqual(hemisphere.color.getHex(), before.sky, 'hemi sky colour unchanged');
    assert.strictEqual(hemisphere.groundColor.getHex(), before.ground, 'hemi ground colour unchanged');
    assert.strictEqual(hemisphere.intensity, before.intensity, 'hemi intensity unchanged');
    assert.strictEqual(before.intensity, STATIC_HEMI_INTENSITY, 'hemi stayed at the static 0.62π');
  });

  // -------------------------------------------------------------------------
  test('AmbientLight stays static, under budget, and never moves toward the 0.5π whiteout', () => {
    const { scene, ambient, directional } = makeScene();
    Sky.applyAtmosphericSky(scene, directional);
    for (let i = 0; i < 180; i++) {
      Sky.update(0.5);
      assert.strictEqual(ambient.intensity, STATIC_AMB_INTENSITY, 'ambient never animates');
      assert.ok(ambient.intensity <= STATIC_AMB_INTENSITY, 'ambient under captured budget');
      assert.ok(ambient.intensity < OLD_WHITEOUT_AMBIENT, 'ambient nowhere near the old whiteout value');
      assert.strictEqual(ambient.color.getHex(), 0xffffff, 'ambient colour unchanged');
    }
  });

  // -------------------------------------------------------------------------
  test('sun stays above the horizon (no night)', () => {
    const { scene, directional } = makeScene();
    Sky.applyAtmosphericSky(scene, directional);
    const minElevSin = Math.sin(THREE.MathUtils.degToRad(Sky.SUN_ELEV_MIN_DEG));
    for (let e = 0; e <= Sky.CYCLE_DURATION_S * 2; e += 0.5) {
      Sky.update(0.5);
      assert.ok(directional.position.y > 0, `sun above horizon at e=${e}`);
      const dir = /** @type {any} */ (scene.children.find((c) => c.name === 'AtmosphericSky')).material.uniforms.sunPosition.value;
      assert.ok(dir.y >= minElevSin - 1e-9, `sun elevation >= guard at e=${e}: ${dir.y}`);
    }
  });

  // -------------------------------------------------------------------------
  test('golden hour is warmer and dimmer than midday', () => {
    const { scene, directional } = makeScene();
    Sky.applyAtmosphericSky(scene, directional);
    const midday = liveState(scene, directional);
    // Half a period from midday is golden hour (cycleProgress(45) == 0).
    assert.ok(Sky.cycleProgress(Sky.CYCLE_DURATION_S / 2) < 1e-9, 'half-period is golden hour');
    Sky.update(Sky.CYCLE_DURATION_S / 2);
    const golden = liveState(scene, directional);

    assert.ok(golden.dirIntensity < midday.dirIntensity, 'golden dimmer than midday');
    assert.ok(golden.exposure < midday.exposure, 'golden lower exposure than midday');
    const c = new THREE.Color(golden.dirColor);
    assert.ok(c.r > c.b, 'golden sun is warm (red > blue)');
  });

  // -------------------------------------------------------------------------
  test('golden colour endpoints honour the scene colour-management opt-out (codex #163)', () => {
    // Production builds the scene with three colour management OFF (scene-setup opts
    // out before lights/fog are created). sky.ts is imported earlier, while CM is
    // still ON — so a module-scope golden Color endpoint would be linearised at
    // import and, lerped against the raw captured midday colours, render golden hour
    // muddy/dark. The endpoints must be built inside applyAtmosphericSky, under the
    // same opted-out regime, so their raw RGB matches the authored hex.
    const prevCM = THREE.ColorManagement.enabled;
    try {
      THREE.ColorManagement.enabled = false;
      const { scene, directional } = makeScene();
      Sky.applyAtmosphericSky(scene, directional);
      Sky.update(Sky.CYCLE_DURATION_S / 2); // golden hour, p == 0 → endpoints exactly
      const close = (a, b, label) =>
        assert.ok(Math.abs(a.r - b.r) < 1e-6 && Math.abs(a.g - b.g) < 1e-6 && Math.abs(a.b - b.b) < 1e-6,
          `${label}: got (${a.r},${a.g},${a.b}) vs raw (${b.r},${b.g},${b.b}) — colour spaces mixed`);
      close(scene.fog.color, new THREE.Color(0xe6dcc8), 'golden fog raw-sRGB');
      close(directional.color, new THREE.Color(0xffc89e), 'golden sun raw-sRGB');
    } finally {
      THREE.ColorManagement.enabled = prevCM;
    }
  });

  // -------------------------------------------------------------------------
  test('golden hour does not wash the whole mountain warm (fill stays static & cool)', () => {
    const { scene, ambient, hemisphere, directional } = makeScene();
    Sky.applyAtmosphericSky(scene, directional);
    Sky.update(Sky.CYCLE_DURATION_S / 2); // to golden hour
    // The skylight fill that lights most of the snow is unchanged, so the mountain
    // is not globally tinted warm — only the direct sun warms.
    assert.strictEqual(ambient.color.getHex(), 0xffffff, 'ambient still neutral');
    assert.strictEqual(hemisphere.color.getHex(), 0xdcebfb, 'hemi sky still cool blue');
    assert.strictEqual(hemisphere.groundColor.getHex(), 0xbcc7d4, 'hemi ground unchanged');
  });

  // -------------------------------------------------------------------------
  test('brightness is monotonic on each half-cycle', () => {
    // cycleProgress p: 1 at midday → 0 at golden → 1 at midday. Directional
    // intensity and exposure are monotonic in p, so monotonic p ⇒ monotonic light.
    const P = Sky.CYCLE_DURATION_S;
    let prev = Sky.cycleProgress(0);
    for (let e = 1; e <= P / 2; e++) {
      const cur = Sky.cycleProgress(e);
      assert.ok(cur <= prev + 1e-12, `descending midday→golden at e=${e}: ${prev}→${cur}`);
      prev = cur;
    }
    prev = Sky.cycleProgress(P / 2);
    for (let e = P / 2 + 1; e <= P; e++) {
      const cur = Sky.cycleProgress(e);
      assert.ok(cur >= prev - 1e-12, `ascending golden→midday at e=${e}: ${prev}→${cur}`);
      prev = cur;
    }
  });

  // -------------------------------------------------------------------------
  test('cycle is periodic', () => {
    for (let e = 0; e <= Sky.CYCLE_DURATION_S; e += 3) {
      const a = Sky.cycleProgress(e);
      const b = Sky.cycleProgress(e + Sky.CYCLE_DURATION_S);
      assert.ok(Math.abs(a - b) < 1e-12, `cycleProgress periodic at e=${e}: ${a} vs ${b}`);
    }
    // And the driven live state is periodic too.
    const { scene, directional } = makeScene();
    Sky.applyAtmosphericSky(scene, directional);
    Sky.update(20);
    const at20 = liveState(scene, directional);
    Sky.update(Sky.CYCLE_DURATION_S);
    assertStateEqual(liveState(scene, directional), at20, 'live state periodic');
  });

  console.log(`\n==================================`);
  console.log(`SKY CYCLE TESTS: ${passed} passed, 0 failed`);
  process.exit(0);
})().catch((e) => {
  console.error('❌ SKY CYCLE TESTS FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
