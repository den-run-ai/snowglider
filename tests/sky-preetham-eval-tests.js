// @ts-check
// sky-preetham-eval-tests.js — headless coverage for the fog↔horizon coupling
// (completion-plan PR-V3).
//
// The distance fog / background is now driven by the Preetham dome's OWN colour at the
// view-forward horizon (src/sky-preetham-eval.ts `evalPreethamColor`) instead of a
// hand-tuned constant that lerped to a warm golden constant. This suite pins:
//   1. The live sky's fog.color == evalPreethamColor(liveSunDir, -z horizon,
//      liveExposure) within ε at several cycle phases (the fog really is the dome
//      colour, so terrain fades into the sky with no seam).
//   2. The ANTI-SOLAR horizon (the -z the player faces) is measurably COOLER than the
//      SOLAR horizon (toward the sun azimuth) at golden hour — the seam the coupling
//      fixes: warm terrain fog can no longer meet a cool sky band.
// The static snow irradiance/headroom budget is tested separately against the
// production light rig in snow-lighting-tests.js.
//
// CommonJS + dynamic import so the register-ts-resolve loader resolves the `.ts`
// sources + 'three' from npm.

const assert = require('node:assert');

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { Sky } = await import('../src/sky.js');
  const { evalPreethamColor, VIEW_FORWARD_HORIZON } = await import('../src/sky-preetham-eval.js');

  // Same scattering constants as SKY_SHADER / preethamHorizonColor in sky.ts.
  const PARAMS = { turbidity: 8.0, rayleigh: 3.0, mieCoefficient: 0.005, mieDirectionalG: 0.8 };

  function makeScene() {
    const scene = new THREE.Scene();
    const directional = new THREE.DirectionalLight(0xfff4e6, 0.5 * Math.PI);
    directional.position.set(50, 100, 50);
    scene.add(directional);
    return { scene, directional };
  }
  /** Read the live sky material's exposure uniform. */
  function liveExposure(scene) {
    const sky = scene.children.find((c) => c.name === 'AtmosphericSky');
    return sky.material.uniforms.exposure.value;
  }

  console.log('--- fog == Preetham dome colour at the view-forward horizon ---');
  {
    const { scene, directional } = makeScene();
    Sky.applyAtmosphericSky(scene, directional);

    // Sample several cycle phases (midday, mid, golden, and an off-phase).
    const phases = [0, Sky.CYCLE_DURATION_S / 4, Sky.CYCLE_DURATION_S / 2, (Sky.CYCLE_DURATION_S * 3) / 4];
    let advanced = 0;
    for (const target of phases) {
      Sky.update(target - advanced); // advance to this elapsed
      advanced = target;
      const sunDir = Sky.getSunDirection();
      const expected = evalPreethamColor(sunDir, VIEW_FORWARD_HORIZON, { ...PARAMS, exposure: liveExposure(scene) });
      const fog = scene.fog.color;
      // scene.background is typed Color | Texture | null; the atmospheric sky always
      // sets a Color, so narrow it for the .r/.g/.b reads below.
      const bg = /** @type {import('three').Color} */ (scene.background);
      const close = Math.abs(fog.r - expected.r) < 1e-6 && Math.abs(fog.g - expected.g) < 1e-6 && Math.abs(fog.b - expected.b) < 1e-6;
      check(`fog.color matches the horizon eval at elapsed=${target.toFixed(1)} (p=${Sky.cycleProgress(target).toFixed(3)})`, close);
      check(`background tracks fog at elapsed=${target.toFixed(1)}`,
        bg.r === fog.r && bg.g === fog.g && bg.b === fog.b);
    }
    Sky.teardown();
  }

  console.log('\n--- anti-solar horizon is cooler than the solar horizon (seam fix) ---');
  {
    const { scene, directional } = makeScene();
    Sky.applyAtmosphericSky(scene, directional);
    Sky.update(Sky.CYCLE_DURATION_S / 2); // golden hour — the worst seam case
    const sunDir = Sky.getSunDirection();
    const exposure = liveExposure(scene);

    // Solar horizon: the sun's azimuth projected to the horizon (y=0). Anti-solar: -that.
    const az = Math.atan2(sunDir.x, sunDir.z);
    const solar = { x: Math.sin(az), y: 0, z: Math.cos(az) };
    const antiSolar = { x: -solar.x, y: 0, z: -solar.z };

    const solarC = evalPreethamColor(sunDir, solar, { ...PARAMS, exposure });
    const antiC = evalPreethamColor(sunDir, antiSolar, { ...PARAMS, exposure });
    // "Cooler" = a higher blue-minus-red balance.
    check('anti-solar horizon has a higher b−r than the solar horizon (cooler)',
      (antiC.b - antiC.r) > (solarC.b - solarC.r));

    // And the -z view-forward horizon (what the run faces) is on the cool side, near
    // the anti-solar direction (sun az ≈ 45°, so -z is well away from the sun).
    const forwardC = evalPreethamColor(sunDir, VIEW_FORWARD_HORIZON, { ...PARAMS, exposure });
    check('view-forward (-z) horizon is cooler than the solar horizon',
      (forwardC.b - forwardC.r) > (solarC.b - solarC.r));
    Sky.teardown();
  }

  console.log(`\nSKY PREETHAM EVAL TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('❌ sky-preetham-eval harness crashed:', e); process.exit(1); });
