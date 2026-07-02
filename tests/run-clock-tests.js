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
// way the verification harnesses mirror the accumulator, so the contract the live loop
// relies on is pinned without importing the whole scene graph.
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

  console.log('\n--- Run-clock guard: only an ACTIVE run is guarded ---');
  {
    const doc = fakeDoc();
    let t = 0;
    const state = { gameActive: false, startTime: 1000 };
    const guard = createRunClockGuard(state, {
      doc: /** @type {any} */ (doc),
      now: () => t
    });

    t = 5000;
    doc.setVisibility('hidden');
    check('hiding on the menu / game-over screen does not pause', guard.isPaused() === false);
    t = 9000;
    doc.setVisibility('visible');
    check('and does not shift the next run\'s startTime', state.startTime === 1000);
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

  console.log(`\nRUN CLOCK TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
