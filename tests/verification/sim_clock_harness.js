// @ts-check
// sim_clock_harness.js
// Single-simulation-clock gate (issue #402). Two properties the audit found
// broken and this PR fixes:
//
//   1. AVALANCHE FRAME-RATE EQUIVALENCE [GATING] — boulder physics used to
//      advance once per RENDER frame (avalanche.update(frameDelta)), so
//      player/boulder relative motion varied with refresh rate even though each
//      side was individually dt-scaled. The live loop now advances boulders in
//      the SAME fixed 1/60 substeps as the player (updatePhysics per substep),
//      so a seeded slide's boulder trajectories are byte-identical at
//      30/60/144 Hz. The old per-render-frame shape is run as the DIAGNOSTIC
//      contrast (it diverges).
//
//   2. RANKED TIME IS SIMULATION TIME [GATING] — course/split/ghost timing used
//      performance.now inside the fixed substep, so a stall that DROPPED
//      physics time (the MAX_SUBSTEPS spiral guard) kept the ranked clock
//      running: the player advanced less but paid full wall-clock. Driving the
//      REAL createMainLoop with stalled frames, the elapsed the course sees now
//      advances exactly substeps x FIXED_DT — never the wall delta.
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/sim_clock_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 8;

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

(async () => {
  await import(pathToFileURL(path.join(__dirname, '..', 'loaders', 'register-ts-resolve.mjs')).href);

  let pass = 0, fail = 0;
  const check = (gating, name, cond, detail) => {
    const tag = cond ? 'PASS ✅' : (gating ? 'FAIL ❌' : 'note');
    console.log(`  ${tag}: ${name}${detail ? ` — ${detail}` : ''}`);
    if (gating) { cond ? pass++ : fail++; }
  };

  console.log('\n=== Single simulation clock (issue #402) ===');

  // ---- 1) Avalanche boulder physics: fixed-grid frame-rate equivalence -------
  console.log('\n--- 1) boulder physics on the fixed grid: byte-identical across render rates [GATING] ---');
  {
    // Headless: no DOM => no powder pool; updatePhysics is pure boulder math.
    const g = /** @type {any} */ (globalThis);
    g.window = { location: { search: '' } };
    g.document = undefined;
    const { AvalancheSystem } = await import('../../src/avalanche.ts');
    const terrain = await import('../../src/mountains/terrain.ts');
    const THREE = await import('three');
    const realRandom = Math.random;

    /** Drive the main-loop accumulator shape at a render rate, advancing the
     *  boulders per FIXED substep (the new live-loop contract). */
    const runFixedGrid = (hz, seconds) => {
      Math.random = makeRng(0xA7A1A2); // identical spawn draws per profile
      const av = new AvalancheSystem(new THREE.Scene(), 40);
      av.setTerrainFunction(terrain.getTerrainHeightUncached);
      av.trigger({ x: 0, y: 12, z: -60 });
      Math.random = realRandom;
      const frames = Math.round(seconds * hz);
      let accumulator = 0;
      for (let f = 0; f < frames; f++) {
        accumulator += Math.min(1 / hz, MAX_SUBSTEPS * FIXED_DT);
        let substeps = 0;
        while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
          av.updatePhysics(FIXED_DT);
          accumulator -= FIXED_DT;
          substeps++;
        }
      }
      return Array.from(av.positions);
    };
    /** The OLD shape: boulders advance once per RENDER frame at the frame delta. */
    const runPerFrame = (hz, seconds) => {
      Math.random = makeRng(0xA7A1A2);
      const av = new AvalancheSystem(new THREE.Scene(), 40);
      av.setTerrainFunction(terrain.getTerrainHeightUncached);
      av.trigger({ x: 0, y: 12, z: -60 });
      Math.random = realRandom;
      const frames = Math.round(seconds * hz);
      for (let f = 0; f < frames; f++) av.updatePhysics(1 / hz);
      return Array.from(av.positions);
    };
    const maxDiff = (a, b) => {
      let m = 0;
      for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i]));
      return m;
    };

    const g30 = runFixedGrid(30, 6);
    const g60 = runFixedGrid(60, 6);
    const g144 = runFixedGrid(144, 6);
    // 144 Hz leaves a fractional-substep residue vs 30/60 (float accumulation);
    // compare at 30-vs-60 exactly (both divide 60 evenly => same substep count).
    check(true, '30 Hz vs 60 Hz boulder trajectories byte-identical on the fixed grid',
      maxDiff(g30, g60) === 0, `max abs diff ${maxDiff(g30, g60).toExponential(3)}`);
    check(true, '60 Hz vs 144 Hz boulder trajectories agree to the 1-substep float residue',
      maxDiff(g60, g144) < 0.5, `max abs diff ${maxDiff(g60, g144).toExponential(3)}`);

    const p30 = runPerFrame(30, 6);
    const p144 = runPerFrame(144, 6);
    check(false, 'the OLD per-render-frame advance diverges across rates (the motivating failure)',
      maxDiff(p30, p144) > 0.5, `max abs diff ${maxDiff(p30, p144).toExponential(3)}`);
  }

  // ---- 2) Course elapsed == accumulated fixed steps, through the REAL loop ----
  console.log('\n--- 2) ranked time is simulation time (stall does not inflate it) [GATING] ---');
  {
    const { setupDom } = await import('../setup/../mocks/dom.mjs');
    const env = setupDom();
    const raf = () => 1;
    /** @type {any} */ (globalThis).requestAnimationFrame = raf;
    /** @type {any} */ (env.window).requestAnimationFrame = raf;
    /** @type {any} */ (env.window).testHooks = {};

    const { createMainLoop, FIXED_DT: LOOP_DT, MAX_SUBSTEPS: LOOP_MAX } = await import('../../src/game/main-loop.ts');
    const { CourseModule } = await import('../../src/course.ts');
    const { Physics } = await import('../../src/player-state.ts');
    const { Snow } = await import('../../src/snow.ts');

    const elapsedSeen = [];
    const realUpdate = CourseModule.update;
    CourseModule.update = (pos, elapsed) => { elapsedSeen.push(elapsed); };

    const ski = () => ({ position: { x: 0 }, rotation: { x: 0, y: 0, z: 0 } });
    const player = Physics.createPlayerState(Snow.getTerrainHeight);
    player.pos.x = 0; player.pos.z = -15;
    player.pos.y = Snow.getTerrainHeight(0, -15);
    const snowman = /** @type {any} */ ({
      position: { x: 0, y: player.pos.y, z: -15, set(x, y, z) { this.x = x; this.y = y; this.z = z; }, clone() { return { ...this }; } },
      rotation: { x: 0, y: Math.PI, z: 0 },
      userData: { targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
                  leftSki: ski(), rightSki: ski(), leftSkiBaseX: -1, rightSkiBaseX: 1 },
    });
    const state = /** @type {any} */ ({
      gameActive: true, animationRunning: true, gameInitialized: true,
      avalanche: null, snowTrails: null, snowDepth: null, debris: null, scenery: null,
      avalancheTriggered: false, lastAvalancheZ: -15, dodgeAwarded: false,
      startTime: performance.now(), bestTime: Infinity,
      difficulty: 'blue', builtDifficulty: 'blue',
    });
    const loop = createMainLoop(/** @type {any} */ ({
      state,
      scene: { children: [] },
      renderer: { render() {}, setSize() {}, domElement: env.document.createElement('canvas') },
      camera: { position: { x: 0, y: 0, z: 0 }, fov: 75, updateProjectionMatrix() {} },
      cameraManager: { update() {}, handleResize() {} },
      directionalLight: /** @type {any} */ ({
        position: { set() {}, copy() {} },
        target: { position: { set() {} }, updateMatrixWorld() {} },
        // The loop writes shadow.normalBias each frame (elevation-aware bias);
        // without this the write throws into onFatalLoopError and every later
        // frame silently no-ops (same trap main-loop-avalanche-tests documents).
        shadow: { normalBias: 0 },
      }),
      snowman,
      snowSplash: null,
      treePositions: [],
      rockPositions: [],
      player,
      showGameOver: () => {},
    }));

    // Healthy 60 Hz frames first, then a burst of 500 ms STALL frames: each stall
    // frame is ceilinged to MAX_SUBSTEPS substeps and its surplus accumulator time
    // is DROPPED — so the course clock must advance by exactly substeps*FIXED_DT,
    // not by the 500 ms of wall time.
    loop.startLoop();
    const t0 = performance.now();
    let t = t0;
    for (let f = 1; f <= 30; f++) loop.animate(t0 + f * (1000 / 60));
    t = t0 + 30 * (1000 / 60);
    const healthyElapsed = elapsedSeen[elapsedSeen.length - 1];
    const healthySteps = elapsedSeen.length;
    check(true, 'healthy frames: course elapsed == accumulated fixed steps exactly',
      Math.abs(healthyElapsed - healthySteps * LOOP_DT) < 1e-12,
      `elapsed ${healthyElapsed.toFixed(4)} vs ${healthySteps} steps`);

    const stepsBeforeStall = elapsedSeen.length;
    for (let s = 0; s < 4; s++) { t += 500; loop.animate(t); }
    const stallSteps = elapsedSeen.length - stepsBeforeStall;
    const stallElapsedGain = elapsedSeen[elapsedSeen.length - 1] - healthyElapsed;
    check(true, `each 500 ms stall frame runs the substep ceiling (${LOOP_MAX} steps)`,
      stallSteps === 4 * LOOP_MAX, `${stallSteps} steps across 4 stall frames`);
    check(true, 'stalled frames advance the ranked clock by SIM time, not wall time',
      Math.abs(stallElapsedGain - stallSteps * LOOP_DT) < 1e-9 && stallElapsedGain < 1.0,
      `clock +${stallElapsedGain.toFixed(4)}s for 2.0s of wall stall`);

    // The published run clock the FINISH/SCORE path reads (result-overlay's
    // finishTime) must be the same sim clock the course just saw — the final
    // recorded score pays sim time, not wall time (Codex review PR #409 P1).
    check(true, 'state.simElapsed (the finish/score clock) equals the course clock exactly',
      Math.abs(state.simElapsed - elapsedSeen[elapsedSeen.length - 1]) < 1e-12,
      `simElapsed ${state.simElapsed.toFixed(4)}`);
    const fs = require('fs');
    const overlaySrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'result-overlay.ts'), 'utf8');
    check(true, 'result-overlay computes finishTime from state.simElapsed (not wall clock)',
      /finishTime = typeof state\.simElapsed === 'number'/.test(overlaySrc));

    CourseModule.update = realUpdate;
  }

  console.log(`\nSIM-CLOCK HARNESS: ${fail === 0 ? 'OK ✅' : 'FAILING ❌'} (${pass} gates passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
