// Per-frame run loop for SnowGlider. Restructured around a FIXED-TIMESTEP ACCUMULATOR
// (see game/fixed-step.ts): physics only ever advances in fixed 1/60 s substeps,
// while cosmetics/observers run once per render frame on the real frame delta. This
// closes the frame-rate-dependence bug class (#209) — tunnelling and divergent
// terminal behaviour at low FPS — by construction, and makes the live build advance
// physics at exactly the rate the physics-invariant harness pins. The physics kernel
// (snowman/physics.ts) is UNCHANGED; the accumulator lives entirely here.
//
// Three responsibilities are kept distinct:
//   - stepFixed(dt)   — the fixed-grid work that gates run outcome: the physics step,
//                       collision (inside the kernel), course progress + finish, and
//                       avalanche burial. Runs 0..MAX_SUBSTEPS times per frame.
//   - renderFrame(..) — the per-frame cosmetic/observer layer: HUD, flex, SFX, snow,
//                       sky, avalanche advance/UI, camera, render. Runs once per frame
//                       on the real frame delta and never affects the physics state.
//   - updateSnowman(delta) — a backward-compatible single-step entry (physics step +
//                       observer layer) preserved for the gameplay browser tests and
//                       the `window.updateSnowman` seam, which call it directly with an
//                       explicit delta and expect one physics advance.
//
// Extracted from snowglider.ts as `createMainLoop(deps)`; the coordinator injects the
// constructed scene handles + run/player state and re-publishes
// `updateSnowman`/`updateCamera` on `window`.

import { Controls } from '../controls.js';
import { Snow } from '../snow.js';
import { Sky } from '../sky.js';
import { Snowman } from '../snowman.js';
import { Flex } from '../snowman-flex.js';
import { CourseModule } from '../course.js';
import { Sfx } from '../sfx.js';
import { Diag } from '../diagnostics.js';
import { EffectsModule, type ShakeOffset } from '../effects.js';
import { Physics, type PlayerState } from '../player-state.js';
import type { LandingQuality, UpdateResult } from '../snowman.js';
import { updateStatsHud, updateTimerDisplay } from '../ui/hud.js';
import { FIXED_DT, MAX_SUBSTEPS, lerp, planFrameSteps } from './fixed-step.js';
import { AVALANCHE_TRIGGER_DISTANCE, type SceneContext } from './scene-setup.js';

export interface MainLoopDeps extends
  Pick<SceneContext, 'state' | 'scene' | 'camera' | 'renderer' | 'cameraManager' |
    'snowman' | 'snowSplash' | 'treePositions' | 'rockPositions'> {
  player: PlayerState;
  showGameOver: (reason: string) => void;
}

// Render the player/camera between the last two fixed physics states (alpha in [0,1)),
// removing temporal aliasing on panels whose refresh doesn't divide 60 (144 Hz, 50 Hz).
// Physics state stays authoritative on the fixed grid; only the rendered transform is
// interpolated. Flip to false to render the latest fixed state directly (minor stutter
// on non-60 panels, ~1 fixed step less visual latency) — a one-line switch, per the plan.
const INTERPOLATE_RENDER = true;

/** Events that can fire on ANY substep within a render frame. Reduced across the
 *  frame's substeps so a jump/land that completes mid-frame is never dropped (its
 *  whoosh/thump/toast/shake), then consumed once in renderFrame. */
interface FrameEvents {
  tookOff: boolean;                       // ground->air edge seen on some substep
  justLanded: boolean;                    // a landing occurred on some substep
  landingForce: number;                   // force of that landing (for SFX + shake)
  landingQuality: LandingQuality | null;  // grade of a *manual*-jump landing (toast)
}

function freshFrameEvents(): FrameEvents {
  return { tookOff: false, justLanded: false, landingForce: 0, landingQuality: null };
}

export function createMainLoop(deps: MainLoopDeps) {
  const {
    state, scene, camera, renderer, cameraManager,
    snowman, snowSplash, treePositions, rockPositions,
    player, showGameOver,
  } = deps;
  const pos = player.pos;
  const velocity = player.velocity;

  // Previous-substep air state, so we can fire a takeoff whoosh on the ground->air
  // transition (the kernel's UpdateResult exposes justLanded but no justJumped).
  // Tracked across substeps (not just frames) so an in-frame takeoff still registers.
  let prevInAir = false;

  // Fixed-timestep accumulator state. `accumulator` carries leftover real time between
  // frames; prev/curPos hold the last two fixed physics positions for render
  // interpolation. Seeded from the spawn position so a frame with zero substeps (high
  // refresh rate) renders the player exactly at rest.
  let accumulator = 0;
  const prevPos = { x: pos.x, y: pos.y, z: pos.z };
  const curPos = { x: pos.x, y: pos.y, z: pos.z };

  // --- Physics advance for one step at `dt` (shared by the fixed loop + the
  // backward-compatible updateSnowman entry). Runs the unchanged kernel via
  // Physics.stepPlayer, reduces the per-step events into `events`, and tracks the
  // air-state edge. Returns the per-step result for the HUD / camera. ---
  function physicsStep(dt: number, events: FrameEvents): UpdateResult {
    const activeShowGameOver = typeof window.showGameOver === 'function'
      ? window.showGameOver
      : showGameOver;

    // Advance the player one fixed step. Physics.stepPlayer wraps Snowman.updateSnowman
    // (the unchanged physics kernel) and writes the mutated scalars back into the typed
    // `player` state, returning the per-step result.
    const result = Physics.stepPlayer(player, {
      snowman,
      delta: dt,
      controls: Controls.getControls(),
      getTerrainHeight: Snow.getTerrainHeight,
      getTerrainGradient: Snow.getTerrainGradient,
      getDownhillDirection: Snow.getDownhillDirection,
      treePositions,
      rockPositions,
      gameActive: state.gameActive,
      showGameOver: activeShowGameOver,
      // Meaningful jumps (#47): bank a manual jump's air score from inside the step,
      // before its synchronous finish check can build the result screen — so a jump
      // landed on the finish frame still counts (see Snowman.updateSnowman).
      bankAirScore: (points: number) => { if (CourseModule) CourseModule.addAirScore(points); }
    });

    // Reduce the substep's events into the frame aggregate (§5): events can fire on any
    // substep, so OR/accumulate them rather than reading only the last substep's result.
    if (result.isInAir && !prevInAir) events.tookOff = true; // ground->air edge within substeps
    if (result.justLanded) {
      events.justLanded = true;
      events.landingForce = result.landingForce;
    }
    if (result.landingQuality) events.landingQuality = result.landingQuality;
    prevInAir = result.isInAir;

    return result;
  }

  // --- The per-frame cosmetic/observer layer that reads the physics result but never
  // mutates physics state (HUD, camera shake, landing toast, flex, SFX). Shared by the
  // render frame and the backward-compatible updateSnowman entry. `frameDelta` is the
  // real render delta (cosmetics are smoothing-based and run on wall-clock time). ---
  function applyObservers(frameDelta: number, result: UpdateResult, events: FrameEvents): void {
    // Update game stats display (speed/altitude/slope/technique). The slope readout is
    // the terrain steepness under the player: gradient magnitude (rise/run = tan θ).
    const grad = Snow.getTerrainGradient(pos.x, pos.z);
    const slopeRatio = Math.sqrt(grad.x * grad.x + grad.z * grad.z);
    updateStatsHud(result, pos, player.isInAir, slopeRatio);

    // Camera shake on a meaningful landing (scales with time spent aloft). Fired once
    // per frame from the aggregated event so a landing on substep 2 of 3 still shakes.
    if (events.justLanded && events.landingForce > 0.25 && EffectsModule) {
      EffectsModule.addShake(Math.min(1.2, events.landingForce * 0.6));
    }

    // Meaningful jumps (#47): on a graded *manual*-jump landing, toast the air time +
    // grade. landingQuality is non-null only for a player-initiated jump, so auto-jumps
    // / hop turns / coasting never toast. (The air score itself is banked inside the
    // step via bankAirScore, so a finish-frame jump still counts.)
    if (events.justLanded && events.landingQuality && CourseModule) {
      CourseModule.flashAir(events.landingQuality, events.landingForce);
    }

    // Cosmetic flexibility / jiggle (issue #53). Purely visual: only writes child-mesh
    // transforms — it never touches pos/velocity, so the physics-invariant harness is
    // unaffected. Runs on the real frame delta (smoothing-based).
    const flexSpeed = result.currentSpeed;
    Flex.update(snowman, frameDelta, {
      speed: flexSpeed,
      technique: result.technique,
      turnRate: flexSpeed > 1e-3 ? velocity.x / flexSpeed : 0, // zero-speed guard (no 0/0 NaN)
      justLanded: events.justLanded,
      landingForce: events.landingForce,
      isInAir: player.isInAir
    });

    // Sound effects (issue #158): a takeoff whoosh on the ground->air transition, a
    // touchdown thump scaled by air time, and the continuous wind + ski-edge bed. The
    // one-shots fire from the aggregated events so a jump/land completed mid-frame isn't
    // dropped; the continuous bed reads the latest substep's result. Reads the result
    // only — never pos/velocity — and is a no-op until the SFX context is unlocked.
    if (events.tookOff) Sfx.jump();
    if (events.justLanded) Sfx.land(events.landingForce);
    Sfx.updateSkiing(result.currentSpeed, result.technique, result.isInAir);
  }

  // --- One FIXED physics substep: the kernel advance plus the fixed-grid work that
  // gates run outcome (course progress + finish, avalanche burial) and the per-step
  // diagnostics sample. Anything that could be MISSED between frames belongs here, on
  // the fixed grid; cosmetics run once per frame in renderFrame. ---
  function stepFixed(events: FrameEvents): UpdateResult {
    const result = physicsStep(FIXED_DT, events);

    // --- Course progress: split timing, progress HUD, ghost racing, finish line. ---
    // On the fixed grid so a gate / finish can't be skipped between render frames.
    if (CourseModule) {
      const elapsed = (performance.now() - state.startTime) / 1000;
      CourseModule.update(pos, elapsed, snowman);
    }

    // --- Avalanche burial check (game-over). On the fixed grid: the player advances in
    // fixed steps, so a burial can't be tunnelled past between render frames. Boulder
    // advance + UI stay in renderFrame (cosmetic / proximity readout). ---
    const avalanche = state.avalanche;
    if (avalanche && avalanche.checkBurial(snowman.position)) {
      const activeShowGameOver = typeof window.showGameOver === 'function'
        ? window.showGameOver
        : showGameOver;
      activeShowGameOver("Buried by avalanche!");
    }

    // Frame-rate / physics telemetry (diagnostics.ts). READ-ONLY observer: reads the
    // per-step result + pos only and never touches pos/velocity. Recorded PER FIXED
    // SUBSTEP at FIXED_DT, so the step it measures is `velocity / 60` and tunnelRisk
    // frames go to zero by construction regardless of render rate (#209). A no-op under
    // automation.
    Diag.record({
      dt: FIXED_DT,
      speed: result.currentSpeed,
      x: pos.x,
      z: pos.z,
      technique: result.technique,
      isInAir: player.isInAir,
    });

    return result;
  }

  // --- The per-render-frame layer: cosmetics/observers, avalanche advance/UI, the
  // interpolated camera follow, camera juice, and the render. Runs once per frame on
  // the real `frameDelta`; `alpha` is the render-interpolation factor. ---
  function renderFrame(frameDelta: number, result: UpdateResult, events: FrameEvents, alpha: number): void {
    // HUD / flex / SFX / landing toast / shake (reads the physics result; never writes it).
    applyObservers(frameDelta, result, events);

    // Keep the rendered transform authoritative (= latest fixed state) for the snow /
    // avalanche logic below, in case the previous frame left an interpolated value on it.
    snowman.position.set(curPos.x, curPos.y, curPos.z);

    Snow.updateSnowflakes(frameDelta, pos, scene);

    // Dynamic ski trails / snow accumulation (#17): carve fading grooves behind the
    // skis that fresh snow covers back over. Purely cosmetic — reads position only.
    state.snowTrails?.update(frameDelta, snowman, player.isInAir);

    // Advance the golden-hour<->midday sun cycle (sun position/colour, sky exposure,
    // fog). Purely atmospheric; a no-op under reduced motion. (#163)
    Sky.update(frameDelta);

    // --- Avalanche advance + UI (boulder physics, banner, proximity meter, rumble).
    // The burial check that gates game-over runs on the fixed grid (stepFixed); this is
    // the cosmetic/advance half. ---
    const avalanche = state.avalanche;
    if (avalanche) {
      // Trigger avalanche based on distance traveled (simple geometric trigger).
      // Player starts at z=-15 and moves in -Z direction (downhill).
      const distanceTraveled = state.lastAvalancheZ - pos.z;

      if (!state.avalancheTriggered && distanceTraveled > AVALANCHE_TRIGGER_DISTANCE) {
        avalanche.trigger(snowman.position);
        state.avalancheTriggered = true;
        console.log("Avalanche triggered! Distance traveled:", distanceTraveled.toFixed(1));
      }

      // Update avalanche physics (cosmetic boulders; burial already checked per substep).
      avalanche.update(frameDelta);

      // Reset avalanche if it has passed the player (survived!)
      if (state.avalancheTriggered && avalanche.hasPassed(snowman.position)) {
        console.log("Avalanche passed - player survived!");
        avalanche.reset();
        state.avalancheTriggered = false;
        state.lastAvalancheZ = pos.z; // Reset trigger point for potential next avalanche
      }

      // Telegraph the threat: banner, "distance behind you" meter, vignette, shake.
      if (EffectsModule) {
        const avActive = state.avalancheTriggered && avalanche.active;
        const avDist = avActive ? avalanche.getClosestDistance(snowman.position) : Infinity;
        EffectsModule.updateAvalanche(avActive, avDist);
        // Avalanche rumble crescendos with the same proximity the banner uses (#158).
        Sfx.setAvalanche(avActive, avDist);
      }
    }

    // Save player position before snow splash effect updates.
    const playerPosBefore = {
      x: snowman.position.x,
      y: snowman.position.y,
      z: snowman.position.z
    };

    // Update snow splash particles - pass all required parameters.
    Snow.updateSnowSplash(snowSplash, frameDelta, snowman, velocity, player.isInAir, scene);

    // Ensure snowman position wasn't affected by particles.
    snowman.position.set(playerPosBefore.x, playerPosBefore.y, playerPosBefore.z);

    // Render interpolation: place the snowman between the last two fixed physics states
    // so motion stays smooth on panels whose refresh doesn't divide 60. The physics
    // state itself stays authoritative on the fixed grid; we restore it after rendering.
    if (INTERPOLATE_RENDER && alpha > 0) {
      snowman.position.set(
        lerp(prevPos.x, curPos.x, alpha),
        lerp(prevPos.y, curPos.y, alpha),
        lerp(prevPos.z, curPos.z, alpha),
      );
    }

    updateCamera();
    updateTimerDisplay(state.gameActive, state.startTime); // Update the timer display

    // Camera juice: speed-based FOV + shake. Apply for the render only, then revert the
    // positional offset so the camera manager's own smoothing stays clean.
    let _shake: ShakeOffset | null = null;
    if (EffectsModule) {
      const spd = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
      _shake = EffectsModule.tickCamera(camera, frameDelta, spd);
    }
    renderer.render(scene, camera);
    if (_shake) {
      camera.position.x -= _shake.x;
      camera.position.y -= _shake.y;
      camera.position.z -= _shake.z;
    }

    // Restore the authoritative (latest fixed) position so physics reads and the next
    // frame's prevPos capture are never seeded from the interpolated render transform.
    if (INTERPOLATE_RENDER && alpha > 0) {
      snowman.position.set(curPos.x, curPos.y, curPos.z);
    }
  }

  // --- Backward-compatible single-step entry. The gameplay browser tests and the
  // `window.updateSnowman` seam call this directly with an explicit delta and expect
  // ONE physics advance plus the observer layer (HUD/flex/SFX/shake/toast) — the
  // pre-accumulator behaviour. It deliberately does NOT run course / avalanche / camera
  // / render (those lived in the animation loop, not in updateSnowman), so the test
  // semantics are unchanged. The live loop uses stepFixed + renderFrame instead. ---
  function updateSnowman(delta: number) {
    if (!window.testHooks) {
      console.log("Test hooks missing, reinstalling");
      Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
    }
    const events = freshFrameEvents();
    const result = physicsStep(delta, events);
    applyObservers(delta, result, events);

    // Diagnostics parity with the pre-refactor single-step path (a no-op under
    // automation, where these tests run). The live loop records per fixed substep.
    Diag.record({
      dt: delta,
      speed: result.currentSpeed,
      x: pos.x,
      z: pos.z,
      technique: result.technique,
      isInAir: player.isInAir,
    });
  }

  // --- Update Camera: Follow the Snowman ---
  function updateCamera() {
    // Simply delegate to the camera manager
    cameraManager.update(
      snowman.position,
      snowman.rotation,
      velocity,
      Snow.getTerrainHeight
    );
  }

  // --- Animation Loop ---
  let lastTime = 0;
  // The most recent per-step result, retained so a render frame that ran zero physics
  // substeps (refresh rate above 60 Hz) can still drive the cosmetic layer.
  let lastResult: UpdateResult | null = null;
  function animate(time: number) {
    if (state.gameActive) {
      requestAnimationFrame(animate);
      // Real elapsed render time. planFrameSteps caps it at MAX_SUBSTEPS * FIXED_DT
      // (the spiral-of-death guard, ~133 ms — the same ceiling as the old 0.1 s clamp).
      const frameDelta = (time - lastTime) / 1000;
      lastTime = time;

      // Only set up test hooks if they're missing.
      if (!window.testHooks) {
        console.log("Test hooks missing in animation loop, reinstalling");
        Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
      }

      // Advance physics on the FIXED grid: drain whole 1/60 s steps from the
      // accumulator. Events are reduced across the frame's substeps so a jump/land that
      // completes mid-frame still fires its SFX/toast/shake exactly once in renderFrame.
      const plan = planFrameSteps(accumulator, frameDelta, FIXED_DT, MAX_SUBSTEPS);
      accumulator = plan.accumulator;
      const events = freshFrameEvents();
      let result: UpdateResult | null = null;
      for (let i = 0; i < plan.substeps; i++) {
        // Snapshot the pre-step position for render interpolation, then advance.
        prevPos.x = curPos.x; prevPos.y = curPos.y; prevPos.z = curPos.z;
        result = stepFixed(events);
        curPos.x = pos.x; curPos.y = pos.y; curPos.z = pos.z;
        // A finish / crash / burial during a substep stops the run — drop the remaining
        // substeps so we don't keep stepping a dead run (matches the old single-step
        // loop, which advanced once per frame and checked gameActive next frame).
        if (!state.gameActive) break;
      }

      // Render once per frame on the real delta. If zero substeps ran this frame (high
      // refresh rate), reuse the latest result so the HUD/cosmetics still update; the
      // physics state is unchanged so this is purely a redraw.
      if (!result) result = lastResult;
      if (result) renderFrame(frameDelta, result, events, plan.alpha);
      lastResult = result;
    } else if (state.animationRunning) {
      state.animationRunning = false;
    }
  }

  // Seed the frame clock and kick the loop. Replaces the lifecycle sites' previous
  // `lastTime = performance.now(); animate(lastTime)` so the first delta stays ~0 while
  // `lastTime` remains private to the loop. Also resets the accumulator + interpolation
  // anchors so a fresh run starts on the fixed grid from the current position.
  function startLoop() {
    lastTime = performance.now();
    accumulator = 0;
    prevPos.x = pos.x; prevPos.y = pos.y; prevPos.z = pos.z;
    curPos.x = pos.x; curPos.y = pos.y; curPos.z = pos.z;
    prevInAir = player.isInAir;
    lastResult = null;
    animate(lastTime);
  }

  // --- Handle Window Resize ---
  function handleResize() {
    cameraManager.handleResize();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  return { updateSnowman, updateCamera, animate, startLoop, handleResize };
}
