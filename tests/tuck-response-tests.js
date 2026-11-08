// @ts-check
// Exercise the real kernel and Blue surface: a straight tuck must keep gaining
// useful speed after the old coast-drag plateau, while release/brake restore grip.
const assert = require('node:assert/strict');
const g = /** @type {any} */ (globalThis);
g.window = { location: { search: '' }, matchMedia: () => ({ matches: false }) };

(async () => {
  const { Snowman } = await import('../src/snowman.ts');
  const terrain = await import('../src/mountains/terrain.ts');
  const { getDifficultyConfig } = await import('../src/difficulty.ts');
  const { fakeSnowman, makeRng } = await import('./helpers/tier-descent.mjs');
  const neutral = { left: false, right: false, up: false, down: false, jump: false };
  const up = { ...neutral, up: true };
  const brake = { ...neutral, down: true };
  const savedRandom = Math.random;
  const dt = 1 / 60;

  function descent(controlAt, { seconds = 3, tier = 'blue', slope = null, initialSpeed = 3, frameDt = dt } = {}) {
    Math.random = makeRng(12345);
    const config = getDifficultyConfig(tier);
    const getHeight = slope === null ? terrain.getTerrainHeight : (_x, z) => slope * z;
    const getGradient = slope === null ? terrain.getTerrainGradient : () => ({ x: 0, z: slope });
    const getDownhill = slope === null ? terrain.getDownhillDirection : () => ({ x: 0, z: -1 });
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -15, y: getHeight(0, -15) };
    const velocity = { x: 0, z: -initialSpeed };
    let state = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: pos.y,
      airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    // Use the live fixed-step convention, including frames with zero substeps.
    let accumulator = 0;
    let steps = 0;
    const targetSteps = Math.round(seconds / dt);
    let peak = initialSpeed;
    while (steps < targetSteps) {
      accumulator += frameDt;
      while (accumulator + 1e-12 >= dt && steps < targetSteps) {
        const controls = controlAt(steps * dt);
        state = Snowman.updateSnowman(snowman, dt, pos, velocity, state.isInAir, state.verticalVelocity,
          state.lastTerrainHeight, state.airTime, state.jumpCooldown, controls, state.turnPhase,
          state.currentTurnDirection, state.turnChangeCooldown, 3, getHeight, getGradient,
          getDownhill, [], false, () => {}, [], undefined, config.ski);
        accumulator -= dt;
        steps++;
        peak = Math.max(peak, Math.hypot(velocity.x, velocity.z));
      }
    }
    return { speed: Math.hypot(velocity.x, velocity.z), distance: -15 - pos.z, peak,
      x: pos.x, z: pos.z, technique: state.technique };
  }

  try {
    terrain.setTerrainCorridor(null);
    terrain.setTerrainKickers(null);
    const coast = descent(() => neutral);
    const tuck = descent(() => up);
    const released = descent(t => t < 1.5 ? up : neutral);
    const stopped = descent(t => t < 1.5 ? up : brake);
    console.log('Blue actual terrain, 3 seconds from spawn:', { coast, tuck, released, stopped });
    assert.ok(tuck.speed > 9, `straight tuck should exceed the old ~7.8m/s plateau; got ${tuck.speed}`);
    assert.ok(tuck.distance > 23, `tuck should cover more than 23m in 3s; got ${tuck.distance}`);
    assert.ok(tuck.speed > coast.speed * 2, 'held acceleration materially beats coasting');
    assert.ok(stopped.speed < released.speed && released.speed < tuck.speed,
      'braking < releasing Up < continuing a tuck');
    assert.equal(tuck.technique, 'tuck');
    assert.equal(released.technique, 'glide');
    assert.equal(stopped.technique, 'snowplow');

    // Holding both does not retain tuck drag relief or defeat the brake.
    const both = descent(() => ({ ...up, down: true }));
    assert.deepEqual(both, descent(() => brake));

    // Production advances fixed steps regardless of display refresh rate.
    for (const fps of [30, 60, 144]) {
      assert.deepEqual(descent(() => up, { frameDt: 1 / fps }), tuck,
        `${fps}Hz must produce exactly the same acceleration trajectory`);
    }

    // Long constant-slope holds stay finite and friction-bounded at every tier.
    // A 60s run must converge instead of growing without limit; the actual-world
    // stress/floor harnesses independently cover collision and ranking outcomes.
    for (const tier of ['bunny', 'blue', 'black', 'expert']) {
      const a = descent(() => up, { tier, slope: 0.4, seconds: 30 });
      const b = descent(() => up, { tier, slope: 0.4, seconds: 60 });
      assert.ok(Number.isFinite(b.speed) && b.speed < 25, `${tier}: bounded terminal speed`);
      assert.ok(Math.abs(a.speed - b.speed) < 0.5, `${tier}: terminal speed converges`);
    }
    console.log('TUCK RESPONSE TESTS: PASS');
  } finally {
    Math.random = savedRandom;
    terrain.setTerrainCorridor(null);
    terrain.setTerrainKickers(null);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
