// @ts-check
// snow-particles-tests.js — headless coverage for the snow-particle correctness pass
// (completion-plan PR-V1): snowflakes + ski splash render as diffuse snow, not emitters.
//
// What this locks in:
//   1. BLENDING — flake + splash materials use NormalBlending (never Additive: snow is
//      a diffuse scatterer; additive washed out over bright snow and glowed cyan against
//      dark trees — the avalanche powder cloud already documented this) and keep
//      depthWrite off so transparent sprites never punch holes in each other.
//   2. SHARING — the 1000 flakes share a few opacity-bucket materials and ONE texture
//      (they used to clone a material each, solely for a rotation that is invisible on
//      a radially symmetric texture). The splash pool keeps per-sprite materials by
//      design (its per-particle lifetime fade animates material.opacity, which sprites
//      cannot express per-instance) but shares its two textures.
//   3. FRAME-RATE INDEPENDENCE — the sideways wobble is delta-scaled: total wobble
//      displacement over one simulated second matches between dt=1/60 and dt=1/120 and
//      matches the analytic integral of the wobble term (#209 bug class, which
//      previously survived in the visuals: 120 Hz drifted sideways twice as fast).
//   4. TEARDOWN — with shared materials, teardownSnowflakes disposes each UNIQUE
//      material/texture exactly once (Set-based dedup), stays idempotent, and detaches
//      every sprite.
//
// createSnowflakes/createSnowSplash paint their sprite textures on a 2d canvas, so this
// suite installs a minimal document/canvas shim (gradient + fillRect only — exactly the
// ops the painters use) before loading the module; THREE.CanvasTexture never touches
// the GPU headless. CommonJS + dynamic import like the other suites, so the
// register-ts-resolve loader resolves the `.ts` sources + 'three' from npm.
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

// --- Minimal 2d-canvas shim (the only DOM the snow painters touch) -----------
function fakeCanvas() {
  const gradient = { addColorStop() {} };
  const ctx = {
    fillStyle: null,
    createRadialGradient: () => gradient,
    fillRect() {},
  };
  return { width: 0, height: 0, getContext: () => ctx };
}

async function main() {
  // Install before load so module-eval and call-time both see it.
  globalThis.document = /** @type {any} */ ({
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      return fakeCanvas();
    }
  });

  const THREE = await import('three');
  const { Snow } = await import('../src/snow.ts');

  // ---- snowflakes: blending + material/texture dedup -------------------------
  console.log('--- snowflakes: diffuse blending + shared bucket materials ---');
  const scene = new THREE.Scene();
  Snow.createSnowflakes(scene);
  const flakes = scene.children.filter((c) => /** @type {any} */ (c).isSprite);
  {
    check('creates the full flake pool (1000 sprites)', flakes.length === 1000);

    const mats = new Set(flakes.map((f) => /** @type {any} */ (f).material));
    const texes = new Set([...mats].map((m) => m.map));
    check(`flakes share opacity-bucket materials, not one clone each (${mats.size} uniques)`,
      mats.size >= 2 && mats.size <= 4);
    check('all flake materials share ONE texture', texes.size === 1);
    check('every flake material uses NormalBlending (diffuse snow, not an emitter)',
      [...mats].every((m) => m.blending === THREE.NormalBlending));
    check('every flake material is transparent with depthWrite off',
      [...mats].every((m) => m.transparent === true && m.depthWrite === false));
    check('opacity buckets vary across the pool (visual variance retained)',
      new Set([...mats].map((m) => m.opacity)).size === mats.size);
    check('per-flake rotation is gone (a no-op on a radially symmetric texture)',
      flakes.every((f) => f.userData.rotationSpeed === undefined));
  }

  // ---- snowflakes: frame-rate-independent wobble ------------------------------
  console.log('\n--- snowflakes: delta-scaled wobble (dt-independence) ---');
  {
    const player = { x: 0, y: 990, z: -40 };
    // Pin every flake to a controlled state: no fall, no wind coupling, and a slow
    // wobble phase so the discretization error of the two step sizes stays far below
    // the tolerance while the old per-frame bug would show up as a clean 2x.
    const WOBBLE = 0.1, WSPEED = 0.01, PHASE = Math.PI / 2;
    const setup = () => {
      for (const f of flakes) {
        f.position.set(0, 1000, -40);
        f.userData.speed = 0;
        f.userData.windFactor = 0;
        f.userData.wobble = WOBBLE;
        f.userData.wobbleSpeed = WSPEED;
        f.userData.wobblePos = PHASE;
      }
    };

    const run = (dt, steps) => {
      setup();
      for (let i = 0; i < steps; i++) Snow.updateSnowflakes(dt, player, scene);
      return { x: flakes[0].position.x - 0, z: flakes[0].position.z - (-40) };
    };

    const d60 = run(1 / 60, 60);   // one simulated second at 60 Hz
    const d120 = run(1 / 120, 120); // one simulated second at 120 Hz

    // Analytic integral of the x wobble term: ∫0..1 WOBBLE*60*sin(PHASE + WSPEED*t) dt.
    const analyticX = (WOBBLE * 60 / WSPEED) * (Math.cos(PHASE) - Math.cos(PHASE + WSPEED));
    check(`x wobble displacement matches across 60/120 Hz (|${d60.x.toFixed(6)} - ${d120.x.toFixed(6)}| < 1e-3)`,
      Math.abs(d60.x - d120.x) < 1e-3);
    check('x wobble displacement matches the analytic integral at 60 Hz',
      Math.abs(d60.x - analyticX) < 5e-2);
    check('x wobble displacement matches the analytic integral at 120 Hz',
      Math.abs(d120.x - analyticX) < 5e-2);
    check('z wobble displacement matches across 60/120 Hz',
      Math.abs(d60.z - d120.z) < 1e-3);
    // The old per-frame accumulation would have doubled displacement at 120 Hz.
    check('120 Hz displacement is nowhere near the old 2x per-frame bug',
      Math.abs(d120.x) < Math.abs(analyticX) * 1.5);
  }

  // ---- snowflakes: teardown disposes each unique resource exactly once --------
  console.log('\n--- snowflakes: dedup teardown ---');
  {
    const mats = [...new Set(flakes.map((f) => /** @type {any} */ (f).material))];
    const texes = [...new Set(mats.map((m) => m.map))];
    const disposals = new Map();
    for (const res of [...mats, ...texes]) {
      const real = res.dispose.bind(res);
      disposals.set(res, 0);
      res.dispose = () => { disposals.set(res, disposals.get(res) + 1); real(); };
    }

    Snow.teardownSnowflakes();
    check('teardown detaches every flake from the scene',
      scene.children.filter((c) => /** @type {any} */ (c).isSprite).length === 0);
    check('each unique material disposed exactly once (no per-sprite re-dispose)',
      mats.every((m) => disposals.get(m) === 1));
    check('the shared texture disposed exactly once',
      texes.every((t) => disposals.get(t) === 1));

    Snow.teardownSnowflakes(); // idempotent: nothing new to dispose
    check('second teardown is a no-op (idempotent)',
      [...disposals.values()].every((n) => n === 1));

    // The pool restarts clean after teardown (no stale sprites accumulate).
    Snow.createSnowflakes(scene);
    check('createSnowflakes after teardown rebuilds a clean 1000-sprite pool',
      scene.children.filter((c) => /** @type {any} */ (c).isSprite).length === 1000);
    Snow.teardownSnowflakes();
  }

  // ---- splash: blending + shared textures -------------------------------------
  console.log('\n--- ski splash: diffuse blending + shared textures ---');
  {
    const splash = Snow.createSnowSplash();
    check('splash pool holds 250 sprites', splash.particles.length === 250 && splash.particleCount === 250);

    const mats = splash.particles.map((p) => p.material);
    const texes = new Set(mats.map((m) => m.map));
    check('splash shares exactly its two puff textures across the pool', texes.size === 2);
    check('every splash material uses NormalBlending (powder mist, not an emitter)',
      mats.every((m) => m.blending === THREE.NormalBlending));
    check('every splash material is transparent with depthWrite off',
      mats.every((m) => m.transparent === true && m.depthWrite === false));
  }

  console.log(`\nSNOW PARTICLES TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('snow-particles harness crashed:', err); process.exit(1); });
