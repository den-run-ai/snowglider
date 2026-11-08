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
  const { createRenderQuality } = await import('../src/game/render-quality.ts');
  const { DirectionalLight } = await import('three');
  const { CourseModule } = await import('../src/course.ts');
  const { Physics } = await import('../src/player-state.ts');
  const { Snow } = await import('../src/snow.ts');
  const { EffectsModule } = await import('../src/effects.ts');
  const { Sfx } = await import('../src/sfx.ts');
  const { AudioModule } = await import('../src/audio.ts');
  const { createLifecycle } = await import('../src/game/lifecycle.ts');

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
      rotation: { x: 0, y: Math.PI, z: 0, copy() {}, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
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
      renderer: overrides.renderer ?? { render() {}, setSize() {} },
      renderQuality: overrides.renderQuality,
      runClockGuard: overrides.runClockGuard,
      cameraManager: { update() {}, handleResize() {} },
      directionalLight: overrides.directionalLight ?? {
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

  // Drive the real reset + loop boundary. Construction, intro preparation and
  // hidden-tab frames must not inflate starts; active reset and replay must.
  {
    const events = [];
    window.firebaseModules = { logEvent: (name, params) => events.push({ name, params }) };
    let paused = true;
    const h = makeLoop({
      state: { gameActive: false },
      runClockGuard: { isPaused: () => paused, consumeResumed: () => false },
    });
    const lifecycle = createLifecycle(/** @type {any} */ ({
      state: h.state, player: h.player, snowman: h.snowman,
      cameraManager: { initialize() {} },
      gameOverOverlay: document.createElement('div'),
      restartButton: document.createElement('button'),
      startLoop: h.loop.startLoop, resetLoopState: h.loop.resetLoopState,
    }));
    lifecycle.resetSnowman();
    h.loop.startLoop();
    check('preparing a run emits neither reset nor start', events.length === 0);
    h.state.gameActive = true;
    h.loop.startLoop();
    check('a hidden start waits for an actual playable frame', events.length === 0);
    paused = false;
    h.loop.animate(performance.now());
    h.loop.animate(performance.now());
    check('first visible gameplay emits exactly one start',
      events.length === 1 && events[0].name === 'game_start' && events[0].params.run_attempt === 'first');
    lifecycle.resetSnowman();
    h.loop.animate(performance.now());
    check('in-game Reset emits one reset and a second playable start',
      events.filter(e => e.name === 'game_reset').length === 1
      && events.filter(e => e.name === 'game_start').length === 2
      && events.at(-1).params.run_attempt === 'second');
    h.state.gameActive = false;
    h.state.animationRunning = false;
    const savedEnableSound = AudioModule.enableSound;
    const savedUnlock = Sfx.unlock;
    try {
      AudioModule.enableSound = () => {};
      Sfx.unlock = () => {};
      lifecycle.restartGame();
    } finally {
      AudioModule.enableSound = savedEnableSound;
      Sfx.unlock = savedUnlock;
    }
    h.loop.animate(performance.now());
    check('Restart emits another start without requiring a new page initialization',
      events.filter(e => e.name === 'game_reset').length === 2
      && events.filter(e => e.name === 'game_start').length === 3
      && events.at(-1).params.run_attempt === 'later');
    delete window.firebaseModules;
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

  console.log('--- Adaptive quality transition presents a completed frame ---');

  // Terminal substeps must not re-enable the warning/audio cleared by the
  // result handler later in the same animation frame. Exercise actual finish
  // and burial paths, including a frame with several owed physics steps.
  for (const outcome of ['finish', 'burial']) {
    let renders = 0;
    let warnings = 0;
    let rumble = 0;
    const savedWarning = EffectsModule.updateAvalanche;
    const savedRumble = Sfx.setAvalanche;
    EffectsModule.updateAvalanche = () => { warnings++; };
    Sfx.setAvalanche = () => { rumble++; };
    const h = makeLoop({
      avalanche: { checkBurial: () => outcome === 'burial' },
      renderer: { render() { renders++; }, setSize() {} },
    });
    const realPush = h.gameOverReasons.push.bind(h.gameOverReasons);
    /** @type {any} */ (h.gameOverReasons).push = (reason) => {
      h.state.gameActive = false;
      return realPush(reason);
    };
    h.loop.startLoop();
    if (outcome === 'finish') h.player.pos.z = -196;
    const before = { renders, warnings, rumble };
    const t0 = performance.now();
    h.loop.animate(t0 + 100);
    check(`${outcome} ends exactly once inside the physics frame`,
      h.gameOverReasons.length === 1 && !h.state.gameActive);
    check(`${outcome} does not revive avalanche warnings or audio`,
      warnings === before.warnings && rumble === before.rumble);
    check(`${outcome} preserves the last completed render`, renders === before.renders);
    // A queued frame still exists. Restart may happen before it runs, so do
    // not clear animationRunning early and accidentally start a second chain.
    check(`${outcome} leaves the queued frame in charge of loop ownership`, h.state.animationRunning);
    h.loop.animate(t0 + 117);
    check(`${outcome} queued frame releases loop ownership`, !h.state.animationRunning);
    EffectsModule.updateAvalanche = savedWarning;
    Sfx.setAvalanche = savedRumble;
  }

  {
    let pixelRatio = 2;
    let frameHasImage = false;
    let blankFrames = 0;
    /** @type {string[]} */
    const operations = [];
    const renderer = /** @type {import('three').WebGLRenderer} */ (/** @type {unknown} */ ({
      getPixelRatio: () => pixelRatio,
      setPixelRatio(value) {
        pixelRatio = value;
        // Three.js setPixelRatio calls setSize, whose canvas width/height writes
        // clear the drawing buffer immediately, including an already drawn frame.
        frameHasImage = false;
        operations.push('resize');
      },
      setSize() {},
      render() { frameHasImage = true; operations.push('render'); },
      shadowMap: { needsUpdate: false },
      domElement: { dataset: {} },
    }));
    const sun = new DirectionalLight();
    sun.shadow.mapSize.set(2048, 2048);
    const renderQuality = createRenderQuality(renderer, sun, 'auto', 2);
    const h = makeLoop({ renderer, directionalLight: sun, renderQuality });
    h.loop.startLoop();
    const t0 = performance.now();
    // Real 30 FPS frame samples exhaust startup grace and cross two sustained
    // overload windows, causing exactly one high -> balanced resource change.
    for (let frame = 1; frame <= 225; frame++) {
      h.loop.animate(t0 + frame * (1000 / 30));
      if (!frameHasImage) blankFrames++;
    }
    const resizeIndex = operations.indexOf('resize');
    check('the live loop triggers a real high-to-balanced quality transition',
      pixelRatio === 1.5 && operations.filter(op => op === 'resize').length === 1);
    check('the quality resize is followed by drawing in the same frame',
      resizeIndex >= 0 && operations[resizeIndex + 1] === 'render' && blankFrames === 0);
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
