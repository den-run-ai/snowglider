// @ts-check
// Headless coverage for the main-loop side of the JP-3 avalanche dodge window.
//
// avalanche-tests.js pins the pure resolver; this suite drives the real
// createMainLoop() loop with a fake avalanche so the loop-owned effects stay
// covered: game-over on burial, once-per-slide reward banking, escape impulse, and
// re-arming after the slide passes.
//
// Avalanche OUTCOMES resolve inside stepFixed, once per fixed 1/60 substep
// (#403 review) — NOT once per render frame — so every case here drives real
// substeps: startLoop() seeds the frame clock, then animate(t0 + n*STEP_MS)
// drains one substep per call. Airborne cases pin the player high above the
// terrain so the kernel step they ride through keeps isInAir true.

let pass = 0;
let fail = 0;

function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

async function main() {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();

  let rafCalls = 0;
  const raf = () => { rafCalls++; return 1; };
  /** @type {any} */ (globalThis).requestAnimationFrame = raf;
  /** @type {any} */ (env.window).requestAnimationFrame = raf;
  /** @type {any} */ (env.window).testHooks = {};

  const { createMainLoop } = await import('../src/game/main-loop.ts');
  const { CourseModule } = await import('../src/course.ts');
  const { Physics } = await import('../src/player-state.ts');
  const { Snow } = await import('../src/snow.ts');

  const realAddAirScore = CourseModule.addAirScore;
  const realFlashDodge = CourseModule.flashDodge;
  let score = 0;
  let flashes = 0;
  CourseModule.addAirScore = (points) => { score += points; };
  CourseModule.flashDodge = () => { flashes++; };

  function ski() {
    return { position: { x: 0 }, rotation: { x: 0, y: 0, z: 0 } };
  }

  /**
   * Build the minimum scene handles createMainLoop needs. Each case starts the
   * loop (seeding the frame clock) and advances wall time in ~one-substep steps,
   * so the avalanche outcome block runs on the fixed grid exactly as live.
   * @param {Partial<any>} overrides
   */
  function makeLoop(overrides = {}) {
    const player = Physics.createPlayerState(Snow.getTerrainHeight);
    player.pos.x = 0;
    player.pos.z = -15;
    player.pos.y = Snow.getTerrainHeight(player.pos.x, player.pos.z);
    player.velocity.x = 10;
    player.velocity.z = -20;

    const snowman = /** @type {any} */ ({
      position: {
        x: player.pos.x,
        y: player.pos.y,
        z: player.pos.z,
        set(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) {
          this.x = x;
          this.y = y;
          this.z = z;
        }
      },
      rotation: { x: 0, y: Math.PI, z: 0, copy() {} },
      userData: {
        targetRotationY: Math.PI,
        currentRotX: 0,
        currentRotZ: 0,
        leftSki: ski(),
        rightSki: ski(),
        leftSkiBaseX: -1,
        rightSkiBaseX: 1,
      },
    });

    let resetCalls = 0;
    const avalanche = {
      enabled: false,
      active: true,
      triggerDistance: 50,
      trigger() {},
      update() {},
      // #402 split: the live loop drives boulder physics per fixed substep and
      // powder cosmetics per render frame via these halves.
      updatePhysics() {},
      updateCosmetics() {},
      checkBurial: () => false,
      hasPassed: () => false,
      reset() { resetCalls++; },
      getClosestDistance: () => 6,
      ...overrides.avalanche,
    };

    const state = /** @type {any} */ ({
      gameActive: true,
      animationRunning: true,
      startTime: 0,
      avalanche,
      snowTrails: null,
      debris: null,
      avalancheTriggered: true,
      lastAvalancheZ: -15,
      dodgeAwarded: false,
      difficulty: 'blue',
      builtDifficulty: 'blue',
      bestTime: Infinity,
      gameInitialized: true,
      ...overrides.state,
    });

    /** @type {string[]} */
    const gameOverReasons = [];
    const loop = createMainLoop(/** @type {any} */ ({
      state,
      player,
      scene: { children: [], add() {}, remove() {} },
      camera: { position: { x: 0, y: 0, z: 0 }, fov: 75, updateProjectionMatrix() {} },
      renderer: { render() {}, setSize() {} },
      cameraManager: { update() {}, handleResize() {} },
      directionalLight: {
        position: { set() {}, copy() {} },
        target: { position: { set() {} }, updateMatrixWorld() {} },
        // NS2 (PR-V2): the loop writes shadow.normalBias each frame (elevation-aware
        // bias compensation). Without this a real DirectionalLight's `.shadow` object
        // is absent on the mock, the write throws into onFatalLoopError, and the loop
        // silently no-ops every later frame — so multi-frame assertions would pass
        // without a second frame ever running.
        shadow: { normalBias: 0 }
      },
      snowman,
      snowSplash: null,
      treePositions: [],
      rockPositions: [],
      showGameOver: (reason) => { gameOverReasons.push(reason); },
    }));

    return { loop, state, player, snowman, avalanche, gameOverReasons, getResetCalls: () => resetCalls };
  }

  console.log('--- Main-loop avalanche dodge integration (outcomes on the fixed grid) ---');

  // One render frame == one fixed substep: 17 ms > 1000/60 ms, so each animate()
  // call drains exactly one 1/60 step (the residue stays below a second step).
  const STEP_MS = 17;
  /** @param {{loop: any}} h @param {number} n */
  function stepFrames(h, n, t0) {
    for (let f = 1; f <= n; f++) h.loop.animate(t0 + f * STEP_MS);
  }

  {
    score = 0;
    flashes = 0;
    const h = makeLoop({ avalanche: { checkBurial: () => true } });
    h.loop.startLoop();
    const t0 = performance.now();
    // Genuinely airborne through the kernel step this substep runs: high above
    // the terrain on a deliberate jump, so stepPhysics keeps isInAir true.
    h.player.pos.y += 40;
    h.player.verticalVelocity = 5;
    h.player.isInAir = true;
    h.snowman.userData.playerJump = true;

    stepFrames(h, 1, t0);
    check('deliberate airborne overlap does not end the run', h.gameOverReasons.length === 0);
    check('first dodge banks the JP-3 air-score bonus', score === 250);
    check('first dodge flashes the dodge toast', flashes === 1);
    check('first dodge marks the slide as awarded', h.state.dodgeAwarded === true);
    const vAfterX = h.player.velocity.x;
    const vAfterZ = h.player.velocity.z;
    check('first dodge applies the escape impulse (velocity boosted ~10%)',
      vAfterX > 10 && vAfterZ < -20);

    stepFrames(h, 1, t0 + STEP_MS);
    check('continued overlap after the award does not pay again', score === 250 && flashes === 1);
    check('continued overlap after the award marks no second boost',
      h.state.dodgeAwarded === true && h.gameOverReasons.length === 0);
  }

  {
    const h = makeLoop({ avalanche: { checkBurial: () => true } });
    h.loop.startLoop();
    const t0 = performance.now();
    h.player.isInAir = false;
    h.snowman.userData.playerJump = true;

    stepFrames(h, 1, t0);
    check('grounded overlap still buries the player',
      h.gameOverReasons[0] === 'Buried by avalanche!');
  }

  {
    const h = makeLoop({
      avalanche: {
        checkBurial: () => false,
        hasPassed: () => true,
      },
      state: { dodgeAwarded: true, lastAvalancheZ: -80 }
    });
    h.loop.startLoop();
    const t0 = performance.now();

    stepFrames(h, 1, t0);
    check('passed avalanche resets the system', h.getResetCalls() === 1);
    check('passed avalanche clears the active trigger flag', h.state.avalancheTriggered === false);
    check('passed avalanche re-arms the once-per-slide dodge award', h.state.dodgeAwarded === false);
    check('passed avalanche records the new trigger origin', h.state.lastAvalancheZ === h.player.pos.z);
  }

  console.log('--- Exactly one terminal event per run (#403 review) ---');

  {
    // A realistic showGameOver ends the run (gameActive=false) like the real
    // overlay does. Across a 500 ms STALL frame (8 substeps at the ceiling) with
    // burial true every substep, the outcome must fire exactly ONCE: the first
    // burying substep ends the run, the gameActive guard stops the outcome block,
    // and the substep while-loop's own gameActive condition stops later substeps.
    const h = makeLoop({ avalanche: { checkBurial: () => true } });
    const realPush = h.gameOverReasons.push.bind(h.gameOverReasons);
    /** @type {any} */ (h.gameOverReasons).push = (r) => { h.state.gameActive = false; return realPush(r); };
    h.loop.startLoop();
    const t0 = performance.now();
    h.player.isInAir = false;
    h.loop.animate(t0 + 500);
    check('a stall frame resolves burial per substep but fires exactly one terminal event',
      h.gameOverReasons.length === 1 && h.gameOverReasons[0] === 'Buried by avalanche!');
  }

  {
    // Burial in the same substep as hasPassed(): burial resolves FIRST (a boulder
    // overlapping the player is tested before the slide can deactivate) and, with
    // the run over, the passed/reset/re-arm transition never runs.
    const h = makeLoop({ avalanche: { checkBurial: () => true, hasPassed: () => true } });
    const realPush2 = h.gameOverReasons.push.bind(h.gameOverReasons);
    /** @type {any} */ (h.gameOverReasons).push = (r) => { h.state.gameActive = false; return realPush2(r); };
    h.loop.startLoop();
    const t0 = performance.now();
    h.player.isInAir = false;
    stepFrames(h, 1, t0);
    check('burial beats hasPassed in the same substep (no reset after the terminal event)',
      h.gameOverReasons[0] === 'Buried by avalanche!' && h.getResetCalls() === 0 && h.state.avalancheTriggered === true);
  }

  {
    // A run that already ended (finish/crash earlier in the same frame) never
    // resolves an avalanche outcome at all — the second terminal event is
    // structurally impossible, not merely unlikely.
    const h = makeLoop({ avalanche: { checkBurial: () => true } });
    h.loop.startLoop();
    const t0 = performance.now();
    h.state.gameActive = false;
    h.loop.animate(t0 + STEP_MS);
    check('no avalanche outcome resolves once the run is over', h.gameOverReasons.length === 0);
  }

  CourseModule.addAirScore = realAddAirScore;
  CourseModule.flashDodge = realFlashDodge;
  env.teardown();

  console.log(`\nMAIN LOOP AVALANCHE TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
