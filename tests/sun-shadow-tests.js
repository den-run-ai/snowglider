// @ts-check
// Headless coverage for the player-following sun shadow (issue #18).
//
// The bug: the directional (sun) light's shadow camera was left at Three.js's default
// ±5 orthographic box at the origin, while the snowman spawns at z=-15 and skis far
// downhill — so it sat outside the shadow frustum for the whole run and cast no contact
// shadow. The fix (src/game/sun-shadow.ts) widens the frustum once and re-aims the light
// + target at the player every frame, preserving the sun-cycle's direction.
//
// These are pure, WebGL-free assertions: configureSunShadow only mutates the light's
// shadow camera + a fake renderer.shadowMap; aimSunLight only moves the light + target;
// Sky.getSunDirection/getSunDistance read the sun-cycle singleton. CommonJS + dynamic
// import (like dom_smoke_test.js) so the register-ts-resolve loader resolves the `.ts`
// sources and `'three'` from npm.

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

async function main() {
  const THREE = await import('three');
  const {
    configureSunShadow,
    aimSunLight,
    SHADOW_HALF_EXTENT,
    SHADOW_NEAR,
    SHADOW_FAR,
    SHADOW_MAP_SIZE,
    SHADOW_BIAS,
    SHADOW_NORMAL_BIAS,
    SHADOW_NORMAL_BIAS_MAX_FACTOR,
    shadowNormalBiasForElevation,
    compensateShadowBiasForElevation,
  } = await import('../src/game/sun-shadow.ts');
  const { Sky } = await import('../src/sky.ts');

  console.log('--- sun-shadow: configureSunShadow ---');
  {
    const light = new THREE.DirectionalLight(0xffffff, 1);
    // The default DirectionalLight shadow camera is a ±5 box — the root of the bug.
    check('default shadow frustum is the ±5 Three.js box (pre-fix baseline)',
      light.shadow.camera.right === 5 && light.shadow.camera.left === -5);

    const renderer = /** @type {any} */ ({ shadowMap: { enabled: true, type: THREE.BasicShadowMap } });
    configureSunShadow(light, renderer);
    const cam = light.shadow.camera;

    check('frustum widened well past the default ±5 (right > 5)', cam.right > 5);
    check('frustum half-extent applied symmetrically',
      cam.right === SHADOW_HALF_EXTENT && cam.left === -SHADOW_HALF_EXTENT &&
      cam.top === SHADOW_HALF_EXTENT && cam.bottom === -SHADOW_HALF_EXTENT);
    check('near/far brackets the sun distance', cam.near === SHADOW_NEAR && cam.far === SHADOW_FAR);
    check('projection matrix updated for the new frustum',
      cam.projectionMatrix.elements.some(v => v !== 0));
    check('shadow map size raised',
      light.shadow.mapSize.width === SHADOW_MAP_SIZE && light.shadow.mapSize.height === SHADOW_MAP_SIZE);
    check('depth biases set to kill acne / peter-panning',
      light.shadow.bias === SHADOW_BIAS && light.shadow.normalBias === SHADOW_NORMAL_BIAS);
    check('soft (PCF) shadows enabled on the renderer', renderer.shadowMap.type === THREE.PCFSoftShadowMap);
  }

  console.log('\n--- sun-shadow: aimSunLight ---');
  {
    const light = new THREE.DirectionalLight(0xffffff, 1);
    const sunDir = new THREE.Vector3(50, 100, 50).normalize();
    const distance = 122.474;
    // Player somewhere downhill, well outside the old ±5 box.
    const px = 3, py = 4, pz = -90;
    aimSunLight(light, sunDir, distance, px, py, pz);

    check('target sits exactly on the player',
      light.target.position.x === px && light.target.position.y === py && light.target.position.z === pz);
    check('light placed at player + sunDir*distance',
      approx(light.position.x, px + sunDir.x * distance, 1e-4) &&
      approx(light.position.y, py + sunDir.y * distance, 1e-4) &&
      approx(light.position.z, pz + sunDir.z * distance, 1e-4));
    // The shadow direction Three.js uses is light.position - light.target.position; it must
    // stay exactly sunDir*distance so following the player never rotates the shadow.
    const dir = light.position.clone().sub(light.target.position);
    check('light→target vector preserves the sun direction (shadow does not rotate)',
      approx(dir.x, sunDir.x * distance, 1e-4) &&
      approx(dir.y, sunDir.y * distance, 1e-4) &&
      approx(dir.z, sunDir.z * distance, 1e-4));
    check('target.matrixWorld updated (so the shadow camera can orient toward it)',
      light.target.matrixWorld.elements[13] === py);

    // Re-aim to a new position: no drift, frustum follows again (idempotent, absolute).
    aimSunLight(light, sunDir, distance, -7, 2, -150);
    check('re-aim follows to the new player position without drift',
      light.target.position.z === -150 && approx(light.position.z, -150 + sunDir.z * distance, 1e-4));
  }

  console.log('\n--- sun-shadow: elevation-aware normal-bias compensation (NS2) ---');
  {
    // Reference = the captured midday sun elevation (unit y of the (50,100,50) dir).
    const midElevSin = new THREE.Vector3(50, 100, 50).normalize().y;

    // p == 1 (midday): the live sun IS the midday reference ⇒ factor exactly 1 ⇒ the
    // tuned constant, byte-for-byte.
    check('normalBias at midday equals SHADOW_NORMAL_BIAS exactly',
      shadowNormalBiasForElevation(midElevSin, midElevSin) === SHADOW_NORMAL_BIAS);

    // p == 0 (golden, 8° guard): compensated value = tuned * sin(mid)/sin(8°), clamped.
    const sin8 = Math.sin(THREE.MathUtils.degToRad(8));
    const expected8 = SHADOW_NORMAL_BIAS * Math.min(midElevSin / sin8, SHADOW_NORMAL_BIAS_MAX_FACTOR);
    check('normalBias at the 8° guard equals the clamped compensated value',
      approx(shadowNormalBiasForElevation(sin8, midElevSin), expected8, 1e-9));

    // Monotonic non-decreasing as the sun drops (elevation shrinks).
    let prev = shadowNormalBiasForElevation(midElevSin, midElevSin);
    let monotonic = true;
    for (let deg = Math.round(THREE.MathUtils.radToDeg(Math.asin(midElevSin))); deg >= 8; deg--) {
      const cur = shadowNormalBiasForElevation(Math.sin(THREE.MathUtils.degToRad(deg)), midElevSin);
      if (cur < prev - 1e-12) monotonic = false;
      prev = cur;
    }
    check('normalBias is monotonic non-decreasing as the sun drops midday->8°', monotonic);

    // Never scales past the clamp, even at an absurdly low sun.
    check('normalBias is clamped to SHADOW_NORMAL_BIAS_MAX_FACTOR at extreme low sun',
      approx(shadowNormalBiasForElevation(1e-6, midElevSin), SHADOW_NORMAL_BIAS * SHADOW_NORMAL_BIAS_MAX_FACTOR, 1e-9));

    // Never dips below the tuned constant if the sun is somehow above midday (factor >= 1).
    check('normalBias never drops below SHADOW_NORMAL_BIAS (factor floored at 1)',
      shadowNormalBiasForElevation(0.999, midElevSin) === SHADOW_NORMAL_BIAS);

    // The live-light applier writes the same value onto light.shadow.normalBias.
    const light = new THREE.DirectionalLight(0xffffff, 1);
    compensateShadowBiasForElevation(light, sin8, midElevSin);
    check('compensateShadowBiasForElevation writes the compensated bias onto the light',
      approx(light.shadow.normalBias, expected8, 1e-9));
    compensateShadowBiasForElevation(light, midElevSin, midElevSin);
    check('applier restores the tuned constant at midday',
      light.shadow.normalBias === SHADOW_NORMAL_BIAS);
  }

  console.log('\n--- sun-shadow: Sky sun getters ---');
  {
    // Before the sky is built, getters return safe overhead defaults.
    check('getSunDirection defaults to overhead (0,1,0) before the sky exists',
      Sky.getSunDirection().equals(new THREE.Vector3(0, 1, 0)));
    check('getSunDistance defaults to 1 before the sky exists', Sky.getSunDistance() === 1);

    // Build the atmospheric sky from a light at the static midday position, frozen (reduced
    // motion) so the captured midday endpoint is what the getters report.
    const scene = new THREE.Scene();
    const light = new THREE.DirectionalLight(0xffffff, 0.5 * Math.PI);
    light.position.set(50, 100, 50);
    Sky.applyAtmosphericSky(scene, light, { enabled: false, reducedMotion: true });

    const expectedDir = new THREE.Vector3(50, 100, 50).normalize();
    const gotDir = Sky.getSunDirection();
    check('getSunDirection matches the captured midday sun direction',
      approx(gotDir.x, expectedDir.x) && approx(gotDir.y, expectedDir.y) && approx(gotDir.z, expectedDir.z));
    check('getSunDistance matches the captured midday sun distance',
      approx(Sky.getSunDistance(), Math.hypot(50, 100, 50), 1e-4));
    check('getSunDirection writes into the provided scratch (no allocation)',
      (() => { const t = new THREE.Vector3(); const r = Sky.getSunDirection(t); return r === t && approx(t.y, expectedDir.y); })());

    // End-to-end: the loop's per-frame call — getSunDirection + getSunDistance feeding
    // aimSunLight — lands the target on the player and keeps the shadow direction.
    Sky.getSunDirection(gotDir);
    aimSunLight(light, gotDir, Sky.getSunDistance(), 0, 0, -120);
    check('loop wiring aims the sun light at a downhill player',
      light.target.position.z === -120 &&
      approx(light.position.z, -120 + expectedDir.z * Math.hypot(50, 100, 50), 1e-3));

    Sky.teardown();
  }

  console.log(`\nsun-shadow: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error('❌ SUN-SHADOW TESTS FAILED:', err); process.exit(1); });
