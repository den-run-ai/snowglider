// @ts-check
// run-clock-tests.js
// Headless coverage for src/game/run-clock.ts — the paused-by-hide run-clock guard.
//
// The guard freezes the wall-clock run timer (by shifting state.startTime forward on
// resume) and reports isPaused() so the main loop skips physics while the document is
// hidden. These tests drive the factory with an injected fake document + clock and
// assert the three properties the fix promises:
//   (a) startTime shifts by EXACTLY the hidden span (so every elapsed-time consumer —
//       HUD, splits, ghost record/playback, finish time — stays coherent);
//   (b) no physics step runs while hidden, even when a throttled background rAF keeps
//       firing (the free-distance cheat vector the fix must not introduce);
//   (c) elapsed time measured after a hide+resume matches a never-hidden control run
//       step for step.
// The mini-loop below mirrors main-loop.ts's animate() gating + accumulator (FIXED_DT,
// MAX_SUBSTEPS, the frameDelta ceiling, `lastTime = time` on paused frames) the same
// way the verification harnesses mirror the accumulator — and a final integration
// block drives the REAL createMainLoop().animate() under jsdom (mock scene handles,
// real physics kernel) to pin the live gate itself: a paused frame keeps the player
// frozen and the loop scheduled, and a resumed frame runs no backlog.
//
// Standalone run: node --import ./tests/loaders/register-ts-resolve.mjs tests/run-clock-tests.js
// (the auto-discovering runner wires an equivalent superset loader automatically).

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

// Minimal document stand-in: visibilityState + visibilitychange dispatch.
function fakeDoc() {
  /** @type {Array<() => void>} */
  const listeners = [];
  return {
    visibilityState: 'visible',
    /** @param {string} type @param {() => void} fn */
    addEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.push(fn);
    },
    /** @param {'visible'|'hidden'} state */
    setVisibility(state) {
      this.visibilityState = state;
      listeners.forEach(fn => fn());
    }
  };
}

// Mirrors main-loop.ts (kept literal like the verification harnesses; the drift test
// there is the constants' source of truth, this only shapes the mini-loop below).
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 8;

/**
 * Persistent mirror of animate()'s clock handling: `lastTime`/`accumulator` live
 * across calls (like the live loop's module-scoped state), the guard check sits
 * before the accumulator drain and resets lastTime — on paused frames AND (via
 * consumeResumed) on the first frame after a resume — exactly as in main-loop.ts.
 * Call the returned function once per rAF timestamp; it returns that frame's steps.
 * @param {{isPaused(): boolean, consumeResumed(): boolean} | undefined} guard
 * @param {number} firstFrame - the startLoop() seed timestamp in ms
 */
function makeLoop(guard, firstFrame) {
  let lastTime = firstFrame;
  let accumulator = 0;
  /** @param {number} time */
  return function frame(time) {
    if (guard) {
      if (guard.isPaused()) {
        lastTime = time; // don't accumulate the hidden span as frameDelta
        return 0;
      }
      // First frame after a resume: reseed the frame clock. Covers the stopped-rAF
      // case where no paused frame ever ran (codex review, PR #278).
      if (guard.consumeResumed()) lastTime = time;
    }
    const frameDelta = Math.min((time - lastTime) / 1000, MAX_SUBSTEPS * FIXED_DT);
    lastTime = time;
    accumulator += frameDelta;
    let substeps = 0;
    while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
      accumulator -= FIXED_DT;
      substeps++;
    }
    if (substeps >= MAX_SUBSTEPS && accumulator >= FIXED_DT) accumulator = 0;
    return substeps;
  };
}

/**
 * Drive one frame per timestamp through a fresh persistent loop.
 * @param {{isPaused(): boolean, consumeResumed(): boolean} | undefined} guard
 * @param {number[]} frames - rAF timestamps in ms
 */
function driveLoop(guard, frames) {
  const loop = makeLoop(guard, frames.length ? frames[0] : 0);
  return frames.map(time => ({ time, steps: loop(time) }));
}

async function main() {
  // Real jsdom globals: the default-document guard block and the live main-loop
  // integration block need window/document; the fake-doc blocks ignore them.
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  const { createRunClockGuard } = await import('../src/game/run-clock.ts');

  console.log('--- Run-clock guard: startTime shift ---');
  {
    const doc = fakeDoc();
    let t = 0;
    const state = { gameActive: true, startTime: 1000 };
    const guard = createRunClockGuard(state, {
      doc: /** @type {any} */ (doc),
      now: () => t
    });

    check('guard starts unpaused', guard.isPaused() === false);
    check('no resume is pending before any hide', guard.consumeResumed() === false);

    t = 5000;
    doc.setVisibility('hidden');
    check('hiding mid-run pauses the guard', guard.isPaused() === true);
    check('hiding alone does not touch startTime', state.startTime === 1000);

    t = 9000;
    doc.setVisibility('visible');
    check('resume shifts startTime by exactly the hidden span (4000 ms)',
      state.startTime === 5000);
    check('resume unpauses the guard', guard.isPaused() === false);
    check('consumeResumed reports the resume exactly once, then self-clears',
      guard.consumeResumed() === true && guard.consumeResumed() === false);

    // Elapsed parity with a never-hidden control run: at wall time 12000 the run has
    // been VISIBLE for (5000-1000) + (12000-9000) = 7000 ms; the shifted clock must
    // report exactly that, as if the 4 s hide never happened.
    t = 12000;
    check('elapsed after resume matches a never-hidden control run',
      (t - state.startTime) === 7000);
  }

  console.log('\n--- Run-clock guard: run becomes active while already hidden (codex round 2) ---');
  {
    // The player clicks Start, then switches tabs during the first-start loading
    // delay; the deferred startGameplayLoop timer fires in the background, so the
    // run BEGINS while the document is hidden. The capture must not be gated on
    // gameActive, or this run gets no shift and no physics gate.
    const doc = fakeDoc();
    let t = 0;
    const state = { gameActive: false, startTime: 500 }; // seeded at the Start click
    const guard = createRunClockGuard(state, {
      doc: /** @type {any} */ (doc),
      now: () => t
    });

    t = 2000;
    doc.setVisibility('hidden');
    check('a hide BEFORE the run is active still arms the pause', guard.isPaused() === true);
    t = 3000;
    state.gameActive = true; // the loading timer activates the run in the background
    check('the pause holds across the run becoming active', guard.isPaused() === true);
    t = 9000;
    doc.setVisibility('visible');
    // Visible play before the hide: 2000-500 = 1500 ms. The shift must preserve
    // exactly that: startTime = 500 + (9000-2000) = 7500 => elapsed 1500 at resume.
    check('resume shifts out the whole hidden span including the pre-active part',
      state.startTime === 7500 && (t - state.startTime) === 1500);
  }

  console.log('\n--- Run-clock guard: startTime seeded while hidden clamps to elapsed 0 ---');
  {
    // If the run clock is (re)seeded AFTER the hide began, a full-span shift would
    // push startTime past `now` (negative elapsed); the clamp resumes at exactly 0.
    const doc = fakeDoc();
    let t = 0;
    const state = { gameActive: false, startTime: 0 };
    const guard = createRunClockGuard(state, {
      doc: /** @type {any} */ (doc),
      now: () => t
    });

    t = 2000;
    doc.setVisibility('hidden');
    t = 3000;
    state.gameActive = true;
    state.startTime = 3000; // clock seeded mid-hide (zero visible play time yet)
    t = 9000;
    doc.setVisibility('visible');
    check('a run whose clock was seeded while hidden resumes at elapsed exactly 0',
      state.startTime === 9000 && (t - state.startTime) === 0);
    check('the clamped resume still unpauses', guard.isPaused() === false);
  }

  console.log('\n--- Run-clock guard: edge dispatches ---');
  {
    const doc = fakeDoc();
    let t = 0;
    const state = { gameActive: true, startTime: 0 };
    const guard = createRunClockGuard(state, {
      doc: /** @type {any} */ (doc),
      now: () => t
    });

    doc.setVisibility('visible');
    check('a visible event without a prior hide is a no-op',
      state.startTime === 0 && guard.isPaused() === false);

    t = 2000;
    doc.setVisibility('hidden');
    t = 3000;
    doc.setVisibility('hidden'); // duplicate hidden event (some browsers re-fire)
    t = 6000;
    doc.setVisibility('visible');
    check('a duplicate hidden event does not re-capture the pause start',
      state.startTime === 4000); // shifted by 6000-2000, not 6000-3000
  }

  console.log('\n--- Main-loop gating contract: no physics while hidden ---');
  {
    const doc = fakeDoc();
    let t = 0;
    const state = { gameActive: true, startTime: 0 };
    const guard = createRunClockGuard(state, {
      doc: /** @type {any} */ (doc),
      now: () => t
    });

    // A 60 Hz run, then the tab hides at 1000 ms while a THROTTLED rAF keeps firing
    // once a second (the browsers-that-throttle-instead-of-stop case), then resumes.
    /** @type {number[]} */
    const frames = [];
    for (let ms = 0; ms <= 1000; ms += 16.67) frames.push(ms);
    const hideAt = 1000, resumeAt = 4000;
    frames.push(1500, 2500, 3500);            // throttled background frames
    for (let ms = resumeAt; ms <= 5000; ms += 16.67) frames.push(ms);

    // Interleave the visibility flips with the frame drive, as the browser would.
    let steps = [];
    let lastTime = frames[0];
    let accumulator = 0;
    let stepsWhileHidden = 0;
    let totalSteps = 0;
    let hidden = false;
    let hiddenDispatchAt = 0;
    let resumeDispatchAt = 0;
    for (const time of frames) {
      if (!hidden && time >= hideAt && time < resumeAt) {
        t = time; doc.setVisibility('hidden'); hidden = true; hiddenDispatchAt = time;
      } else if (hidden && time >= resumeAt) {
        t = time; doc.setVisibility('visible'); hidden = false; resumeDispatchAt = time;
      }
      // mirror of animate()'s gate + accumulator (see driveLoop)
      if (guard.isPaused()) { lastTime = time; continue; }
      if (guard.consumeResumed()) lastTime = time;
      const frameDelta = Math.min((time - lastTime) / 1000, MAX_SUBSTEPS * FIXED_DT);
      lastTime = time;
      accumulator += frameDelta;
      let substeps = 0;
      while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
        accumulator -= FIXED_DT;
        substeps++;
      }
      if (substeps >= MAX_SUBSTEPS && accumulator >= FIXED_DT) accumulator = 0;
      if (hidden) stepsWhileHidden += substeps;
      totalSteps += substeps;
      steps.push(substeps);
    }

    check('zero physics steps run while the document is hidden', stepsWhileHidden === 0);
    check('physics still ran while visible', totalSteps > 50);
    check('the hidden span was shifted out of the run clock',
      state.startTime === resumeDispatchAt - hiddenDispatchAt && state.startTime > 0);
    // The first resumed frame starts from a reset lastTime, so at most the normal
    // per-frame backlog (here: one 16.67 ms frame => exactly 1 step) can run — the
    // 3 s hide can never pour a 3 s backlog into the accumulator.
    const firstResumedSteps = steps[steps.length - Math.round((5000 - resumeAt) / 16.67) - 1];
    check('resume does not flush the hidden span into the accumulator',
      firstResumedSteps <= 1);
  }

  console.log('\n--- Stopped-rAF resume: no free physics backlog (codex, PR #278) ---');
  {
    // The common background-tab behavior: the browser STOPS rAF entirely while
    // hidden, so no paused frame ever runs and the visibilitychange resume handler
    // clears the pause before the next animate() call. Without the consumeResumed
    // reseed, that resumed frame would compute frameDelta from the pre-hide lastTime
    // (capped at MAX_SUBSTEPS * FIXED_DT ≈ 133 ms) against a clock whose hidden span
    // was just removed — free distance on every hide/resume toggle.
    const doc = fakeDoc();
    let t = 0;
    const state = { gameActive: true, startTime: 0 };
    const guard = createRunClockGuard(state, {
      doc: /** @type {any} */ (doc),
      now: () => t
    });

    // ONE persistent loop across the whole scenario (lastTime survives the hide,
    // exactly like the live loop's module state). 60 Hz until 1000 ms, then NO
    // frames at all while hidden, then 60 Hz again from 4000.
    const loop = makeLoop(guard, 0);
    let beforeTotal = 0;
    for (let ms = 0; ms <= 1000; ms += 16.67) beforeTotal += loop(ms);

    t = 1000; doc.setVisibility('hidden');   // rAF stops: no frames until resume
    t = 4000; doc.setVisibility('visible');  // resume fires BEFORE the next frame

    check('stopped-rAF hide still shifts the clock by the hidden span',
      state.startTime === 3000);
    // The first resumed frame's lastTime still points at the pre-hide frame
    // (~1000 ms ago). Without the consumeResumed reseed it would run the capped
    // ~133 ms backlog (8 steps) against the already-shifted clock; with it, zero.
    const firstResumedSteps = loop(4000);
    check('first frame after a stopped-rAF resume runs zero backlog steps',
      firstResumedSteps === 0);
    let afterTotal = 0;
    for (let ms = 4016.67; ms <= 5000; ms += 16.67) afterTotal += loop(ms);
    check('physics resumes at the normal rate after the reseed',
      afterTotal >= 56 && afterTotal <= 62);
    check('pre-hide frames were unaffected', beforeTotal >= 58 && beforeTotal <= 62);

    // Farm attempt: repeated hide/resume toggles with stopped rAF between them must
    // grant zero physics in total — each resumed frame reseeds instead of stepping
    // the pre-hide backlog. (Same persistent loop throughout.)
    let farmedSteps = 0;
    let wall = 5000;
    for (let i = 0; i < 10; i++) {
      t = wall; doc.setVisibility('hidden');
      wall += 3000; // hidden for 3 s, no frames
      t = wall; doc.setVisibility('visible');
      farmedSteps += loop(wall + 1); // the single resumed frame
      wall += 10;
    }
    check('rapid hide/resume toggling farms zero physics steps', farmedSteps === 0);
  }

  console.log('\n--- driveLoop sanity (mirrors the live gate) ---');
  {
    // Without a guard the mirrored loop steps ~60 times over a simulated second.
    const frames = [];
    for (let ms = 0; ms <= 1000; ms += 16.67) frames.push(ms);
    const total = driveLoop(undefined, frames).reduce((a, f) => a + f.steps, 0);
    check('ungated mirror advances ~60 steps over one simulated second',
      total >= 58 && total <= 62);
  }

  console.log('\n--- Guard on the real document (default doc/now + AbortSignal teardown) ---');
  {
    // No opts.doc/now: the guard binds the real jsdom document and performance.now,
    // exactly as the live coordinator wires it (with the teardown signal). The
    // controller must come from the jsdom realm — its addEventListener rejects
    // Node's own AbortSignal brand.
    const ac = new (/** @type {any} */ (env.window).AbortController)();
    const state = { gameActive: true, startTime: 100 };
    const guard = createRunClockGuard(state, { signal: ac.signal });
    let vis = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
    document.dispatchEvent(new env.window.Event('visibilitychange'));
    check('default-document guard pauses on a real visibilitychange', guard.isPaused() === true);
    vis = 'visible';
    document.dispatchEvent(new env.window.Event('visibilitychange'));
    check('default-document guard resumes and shifts on the real clock',
      guard.isPaused() === false && guard.consumeResumed() === true &&
      state.startTime >= 100 && state.startTime <= performance.now());
    // Aborting the teardown signal removes the listener (disposeGame path).
    ac.abort();
    vis = 'hidden';
    document.dispatchEvent(new env.window.Event('visibilitychange'));
    check('aborting the teardown signal removes the listener', guard.isPaused() === false);
  }

  console.log('\n--- Live main-loop integration: the real animate() honors the guard ---');
  {
    // Drive the REAL createMainLoop().animate() (mock scene handles, real physics
    // kernel) so the live gate — not just its mirror — is exercised: a paused frame
    // keeps the player frozen while the loop stays scheduled, and the first resumed
    // frame consumes the resume flag and runs zero backlog.
    let rafCalls = 0;
    const raf = () => { rafCalls++; return 1; };
    /** @type {any} */ (globalThis).requestAnimationFrame = raf;
    /** @type {any} */ (env.window).requestAnimationFrame = raf;
    /** @type {any} */ (env.window).testHooks = {};

    const { createMainLoop } = await import('../src/game/main-loop.ts');
    const { Physics } = await import('../src/player-state.ts');
    const { Snow } = await import('../src/snow.ts');

    const ski = () => ({ position: { x: 0 }, rotation: { x: 0, y: 0, z: 0 } });
    const snowman = /** @type {any} */ ({
      position: { x: 0, y: 0, z: -15, set(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) { this.x = x; this.y = y; this.z = z; } },
      rotation: { x: 0, y: Math.PI, z: 0, copy() {} },
      userData: { targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
                  leftSki: ski(), rightSki: ski(), leftSkiBaseX: -1, rightSkiBaseX: 1 },
    });
    const player = Physics.createPlayerState(Snow.getTerrainHeight);
    const state = /** @type {any} */ ({
      gameActive: true, animationRunning: true, startTime: 0,
      avalanche: null, snowTrails: null, debris: null,
      avalancheTriggered: false, lastAvalancheZ: -15,
      difficulty: 'blue', builtDifficulty: 'blue', bestTime: Infinity, gameInitialized: true,
    });
    const doc = fakeDoc();
    let t = 0;
    const guard = createRunClockGuard(state, {
      doc: /** @type {any} */ (doc),
      now: () => t
    });

    const loop = createMainLoop(/** @type {any} */ ({
      state,
      player,
      scene: { children: [], add() {}, remove() {} },
      camera: { position: { x: 0, y: 0, z: 0 }, fov: 75, updateProjectionMatrix() {} },
      renderer: { render() {}, setSize() {} },
      cameraManager: { update() {}, handleResize() {} },
      directionalLight: { position: { set() {}, copy() {} },
        target: { position: { set() {} }, updateMatrixWorld() {} },
        // NS2: the loop compensates shadow.normalBias for sun elevation each frame.
        shadow: { normalBias: 0 } },
      snowman,
      snowSplash: null,
      treePositions: [],
      rockPositions: [],
      showGameOver: () => {},
      runClockGuard: guard,
    }));

    loop.startLoop(); // seeds lastTime at performance.now() and runs a ~0-delta frame
    const t0 = performance.now();
    loop.animate(t0 + 100); // ~6 fixed steps: the player starts moving
    const zAfterRun = player.pos.z;
    check('live loop advances the player while visible', zAfterRun !== -15);

    t = 1000; doc.setVisibility('hidden');
    const rafBefore = rafCalls;
    loop.animate(t0 + 200);
    check('a paused frame keeps the player frozen', player.pos.z === zAfterRun);
    check('a paused frame still reschedules the loop', rafCalls === rafBefore + 1);

    t = 4000; doc.setVisibility('visible');
    loop.animate(t0 + 3200); // first frame after a stopped-rAF resume
    check('the first resumed frame runs zero backlog through the live gate',
      player.pos.z === zAfterRun);
    check('the live loop consumed the resume flag', guard.consumeResumed() === false);

    loop.animate(t0 + 3300); // normal frame: physics moves again
    check('physics resumes normally after the live reseed', player.pos.z !== zAfterRun);
    check('no frame threw into the fatal-error overlay',
      document.getElementById('fatalErrorOverlay') === null);
  }

  console.log(`\nRUN CLOCK TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
