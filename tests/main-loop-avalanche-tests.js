// @ts-check
// Headless coverage for the main-loop side of the JP-3 avalanche dodge window.
//
// avalanche-tests.js pins the pure resolver; this suite drives the real
// createMainLoop().animate() with a fake avalanche so the loop-owned effects stay
// covered: game-over on burial, once-per-slide reward banking, escape impulse, and
// re-arming after the slide passes.

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
   * Build the minimum scene handles createMainLoop needs. animate(0) runs the
   * per-render observers and avalanche block without draining physics substeps, so
   * each test can directly set the airborne/provenance state under inspection.
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

  console.log('--- Main-loop avalanche dodge integration ---');

  {
    score = 0;
    flashes = 0;
    const h = makeLoop({ avalanche: { checkBurial: () => true } });
    h.player.isInAir = true;
    h.snowman.userData.playerJump = true;

    h.loop.animate(0);
    check('deliberate airborne overlap does not end the run', h.gameOverReasons.length === 0);
    check('first dodge banks the JP-3 air-score bonus', score === 250);
    check('first dodge flashes the dodge toast', flashes === 1);
    check('first dodge marks the slide as awarded', h.state.dodgeAwarded === true);
    check('first dodge applies the escape impulse',
      h.player.velocity.x === 11 && h.player.velocity.z === -22);

    h.loop.animate(0);
    check('continued overlap after the award does not pay again', score === 250 && flashes === 1);
    check('continued overlap after the award does not boost again',
      h.player.velocity.x === 11 && h.player.velocity.z === -22);
  }

  {
    const h = makeLoop({ avalanche: { checkBurial: () => true } });
    h.player.isInAir = false;
    h.snowman.userData.playerJump = true;

    h.loop.animate(0);
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

    h.loop.animate(0);
    check('passed avalanche resets the system', h.getResetCalls() === 1);
    check('passed avalanche clears the active trigger flag', h.state.avalancheTriggered === false);
    check('passed avalanche re-arms the once-per-slide dodge award', h.state.dodgeAwarded === false);
    check('passed avalanche records the new trigger origin', h.state.lastAvalancheZ === h.player.pos.z);
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
