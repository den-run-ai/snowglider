// Per-frame run loop for SnowGlider: a FIXED-TIMESTEP accumulator that advances the
// physics + run-outcome checks in fixed 1/60 s substeps and runs the cosmetic/observer
// layer (HUD, camera, render, particles, avalanche UI) once per render frame.
// Extracted from snowglider.ts as `createMainLoop(deps)`; the coordinator injects the
// constructed scene handles + run/player state and re-publishes `updateSnowman`/
// `updateCamera` on `window`.
//
// WHY FIXED TIMESTEP (the bug class it closes)
// --------------------------------------------
// The loop used to step physics with the real, variable render delta. That makes the
// steady state frame-rate dependent (the #209 class — see diagnostics.ts): at low FPS a
// single `pos += velocity * delta` step can exceed an obstacle's collision radius and
// tunnel through a tree, and a per-frame-vs-per-second mismatch in any force balloons
// terminal speed. Stepping physics ONLY in FIXED_DT (1/60 s) substeps — exactly the rate
// physics_invariant_harness.js pins the kernel at — removes the cause: the per-step
// displacement is `velocity / 60` (well under any collision radius), tunnel-risk frames go
// to zero by construction, and the live build advances physics at the same rate the suite
// tests. The physics kernel (snowman/physics.ts) is UNCHANGED; the accumulator lives here.
//
// SPLIT: fixed substep vs render frame
//   - stepFixed(FIXED_DT)  — runs anything that changes physics state or could be MISSED
//     between frames: the physics advance, course progress + finish, avalanche burial, and
//     the read-only Diag.record (per substep, so the step it sees is the fixed-grid
//     displacement and tunnelRisk stays zero).
//   - renderFrame(frameDelta, alpha) — runs anything purely visual or smoothing-based on
//     the real frame delta: HUD, Flex, Sfx, snow/sky/trails, avalanche advance + UI, and
//     the interpolated camera + render. None of it touches the physics state.

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
import { AVALANCHE_TRIGGER_DISTANCE, type SceneContext } from './scene-setup.js';
import { FIXED_DT, MAX_SUBSTEPS, lerp, planSubsteps } from './fixed-timestep.js';

export interface MainLoopDeps extends
  Pick<SceneContext, 'state' | 'scene' | 'camera' | 'renderer' | 'cameraManager' |
    'snowman' | 'snowSplash' | 'treePositions' | 'rockPositions'> {
  player: PlayerState;
  showGameOver: (reason: string) => void;
}

// Whether to render the snowman/camera at the interpolated position between the two
// bracketing physics states (removes temporal aliasing when the render rate doesn't
// divide 60 evenly, e.g. 144 Hz or 50 Hz). Flip to false to render at the latest
// physics state instead (no interpolation latency, minor stutter on non-60 panels).
const RENDER_INTERPOLATION = true;

/** Events that can fire on ANY substep within a frame and must NOT be dropped if only
 *  the last substep's result is read (a jump+land completing mid-frame). Reduced across
 *  the frame's substeps, then fired once in renderFrame. */
interface FrameEvents {
  justLanded: boolean;
  tookOff: boolean;
  landingQuality: LandingQuality | null;
  landingForce: number;
}

function freshEvents(): FrameEvents {
  return { justLanded: false, tookOff: false, landingQuality: null, landingForce: 0 };
}

export function createMainLoop(deps: MainLoopDeps) {
  const {
    state, scene, camera, renderer, cameraManager,
    snowman, snowSplash, treePositions, rockPositions,
    player, showGameOver,
  } = deps;
  const pos = player.pos;
  const velocity = player.velocity;

  // Previous-substep air state, so we can fire a takeoff whoosh on the ground→air
  // transition (the kernel's UpdateResult exposes justLanded but no justJumped). Tracked
  // across substeps so a takeoff in any substep of a frame is caught (§5).
  let prevInAir = false;
  // The most recent per-frame physics result, cached so the cosmetic layer still has a
  // result to read on a frame that ran zero substeps (render rate above 60 Hz).
  let lastResult: UpdateResult | null = null;
  // The fixed-timestep accumulator (leftover real time not yet consumed by a substep).
  let accumulator = 0;

  // --- One fixed physics substep ------------------------------------------------------
  // Advances the player one FIXED_DT step and runs everything that gates the run outcome
  // (course finish, avalanche burial) on the fixed grid, plus the read-only Diag record.
  // Reduces the per-substep events into `events`. Returns the per-substep result.
  function stepFixed(dt: number, events: FrameEvents): UpdateResult {
    // Test hooks are installed at init / after resets; in the live loop they are present.
    const activeShowGameOver = typeof window.showGameOver === 'function'
      ? window.showGameOver
      : showGameOver;

    // Advance the player one fixed step. Physics.stepPlayer wraps Snowman.updateSnowman
    // (the unchanged physics kernel) and writes the mutated scalars back into the typed
    // `player` state. At FIXED_DT the kernel is byte-identical to the invariant harness.
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

    // Reduce the frame's events across its substeps so none is dropped (§5): a takeoff,
    // a landing, or its grade can fire on any substep within a single render frame.
    if (result.justLanded) events.justLanded = true;
    if (result.isInAir && !prevInAir) events.tookOff = true;
    if (result.landingQuality) {
      events.landingQuality = result.landingQuality;
      events.landingForce = result.landingForce;
    }
    prevInAir = result.isInAir;

    // --- Course progress: split timing, progress HUD, ghost racing, finish check ---
    // On the fixed grid because the finish gate (pos.z < -195) decides the run outcome
    // and must not be skipped over by a large variable step.
    if (CourseModule) {
      const elapsed = (performance.now() - state.startTime) / 1000;
      CourseModule.update(pos, elapsed, snowman);
    }

    // --- Avalanche burial (game-over) check ---
    // On the fixed grid for the same reason: burial decides the run outcome. The boulder
    // physics advance + UI stay per render frame (renderFrame); only the outcome-gating
    // collision test runs here, against the current boulder positions.
    const avalanche = state.avalanche;
    if (avalanche && state.avalancheTriggered && avalanche.checkBurial(snowman.position)) {
      showGameOver("Buried by avalanche!");
    }

    // Frame-rate / physics telemetry (diagnostics.ts). READ-ONLY observer: it reads the
    // per-substep result + pos only and never touches pos/velocity, so the physics-
    // invariant harness is unaffected and it is a no-op under automation. Recorded PER
    // SUBSTEP at FIXED_DT, so the step it sees is the fixed-grid displacement
    // (velocity / 60) — which is exactly why tunnelRisk frames go to zero now.
    Diag.record({
      dt,
      speed: result.currentSpeed,
      x: pos.x,
      z: pos.z,
      technique: result.technique,
      isInAir: player.isInAir,
    });

    lastResult = result;
    return result;
  }

  // --- Snowman-observer cosmetic layer (HUD / landing juice / flex / SFX) --------------
  // Reads the latest physics result + the reduced frame events, never the physics state,
  // so the physics-invariant harness is unaffected. Shared by the live renderFrame (once
  // per render frame) and the updateSnowman compat seam (once per direct call), so the two
  // never drift. A no-op when no substep produced a result yet (result == null).
  function applySnowmanObservers(delta: number, result: UpdateResult | null, events: FrameEvents) {
    if (!result) return;

    // Update game stats display (speed/altitude/slope/technique). The slope readout is the
    // terrain steepness under the player: gradient magnitude (rise/run = tan θ).
    const grad = Snow.getTerrainGradient(pos.x, pos.z);
    const slopeRatio = Math.sqrt(grad.x * grad.x + grad.z * grad.z);
    updateStatsHud(result, pos, player.isInAir, slopeRatio);

    // Camera shake on a meaningful landing (scales with time spent aloft).
    if (events.justLanded && events.landingForce > 0.25 && EffectsModule) {
      EffectsModule.addShake(Math.min(1.2, events.landingForce * 0.6));
    }

    // Meaningful jumps (#47): on a graded *manual*-jump landing, toast the air time +
    // grade. landingQuality is non-null only for a player-initiated jump (auto-jumps /
    // hop turns / coasting never toast). The air score itself is banked inside the step.
    if (events.justLanded && events.landingQuality && CourseModule) {
      CourseModule.flashAir(events.landingQuality, events.landingForce);
    }

    // Cosmetic flexibility / jiggle (issue #53). Purely visual: only writes child-mesh
    // transforms, never pos/velocity, so the physics-invariant harness is unaffected.
    const flexSpeed = result.currentSpeed;
    Flex.update(snowman, delta, {
      speed: flexSpeed,
      technique: result.technique,
      turnRate: flexSpeed > 1e-3 ? velocity.x / flexSpeed : 0, // zero-speed guard (no 0/0 NaN)
      justLanded: events.justLanded,
      landingForce: events.landingForce,
      isInAir: player.isInAir
    });

    // Sound effects (issue #158): a takeoff whoosh on the ground→air transition, a
    // touchdown thump scaled by air time, and the continuous wind + ski-edge bed. Fired
    // from the reduced events, so a jump+land completing mid-frame still sounds. Reads the
    // per-frame result only — never pos/velocity — and is a no-op until the SFX context is
    // unlocked by the start gesture.
    if (events.tookOff) Sfx.jump();
    if (events.justLanded) Sfx.land(events.landingForce);
    Sfx.updateSkiing(result.currentSpeed, result.technique, result.isInAir);
  }

  // --- The per-render-frame cosmetic / world layer ------------------------------------
  // The snowman observers (above) plus everything else purely visual or smoothing-based:
  // particles, sky, ski trails, the avalanche advance + UI, and the interpolated camera +
  // render. Runs once per render frame on the real frame delta; none of it touches the
  // physics state. `result` is null only before the first substep of a run.
  function renderFrame(frameDelta: number, alpha: number, result: UpdateResult | null, events: FrameEvents) {
    applySnowmanObservers(frameDelta, result, events);

    Snow.updateSnowflakes(frameDelta, pos, scene);

    // Dynamic ski trails / snow accumulation (#17): carve fading grooves behind the skis
    // that fresh snow covers back over. Purely cosmetic — reads position only.
    state.snowTrails?.update(frameDelta, snowman, player.isInAir);

    // Advance the golden-hour↔midday sun cycle (sun position/colour, sky exposure, fog).
    // Purely atmospheric; a no-op under reduced motion. (#163)
    Sky.update(frameDelta);

    // --- Avalanche advance + telegraph (burial is checked on the fixed grid) ---
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

      // Update avalanche physics
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

    // Save player position before snow splash effect updates
    const playerPosBefore = {
      x: snowman.position.x,
      y: snowman.position.y,
      z: snowman.position.z
    };

    // Update snow splash particles - pass all required parameters
    Snow.updateSnowSplash(snowSplash, frameDelta, snowman, velocity, player.isInAir, scene);

    // Ensure snowman position wasn't affected by particles
    snowman.position.set(playerPosBefore.x, playerPosBefore.y, playerPosBefore.z);

    // Render the snowman/camera at the interpolated position between the two bracketing
    // physics states, so the render rate not dividing 60 evenly doesn't alias. The
    // physics state stays authoritative at the fixed grid: we restore snowman.position
    // after the render (same save/revert pattern the camera shake below uses).
    let interpSaved: { x: number; y: number; z: number } | null = null;
    if (RENDER_INTERPOLATION && renderPrev) {
      interpSaved = { x: snowman.position.x, y: snowman.position.y, z: snowman.position.z };
      snowman.position.set(
        lerp(renderPrev.x, interpSaved.x, alpha),
        lerp(renderPrev.y, interpSaved.y, alpha),
        lerp(renderPrev.z, interpSaved.z, alpha),
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

    // Restore the authoritative (non-interpolated) physics position for the next substep.
    if (interpSaved) snowman.position.set(interpSaved.x, interpSaved.y, interpSaved.z);
  }

  // --- Update Snowman (compat seam) ---------------------------------------------------
  // Re-published on `window` so the browser test suites can drive the live game one frame
  // by bare name (updateSnowman(delta)). Runs a single combined step at the given delta:
  // the fixed-grid work (physics + course progress + burial) plus the snowman-observer
  // cosmetic layer (HUD / Flex / SFX), matching what one frame did before this refactor.
  // It deliberately does NOT advance the world particles or render — the live rAF loop
  // (the accumulator below) owns those once per render frame.
  function updateSnowman(delta: number) {
    const events = freshEvents();
    const result = stepFixed(delta, events);
    applySnowmanObservers(delta, result, events);
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

  // --- Animation Loop -----------------------------------------------------------------
  let lastTime = 0;
  // The snowman render position at the START of this frame's substeps (the earlier of the
  // two states the interpolation brackets). Null before the first substep of a run.
  let renderPrev: { x: number; y: number; z: number } | null = null;
  function animate(time: number) {
    if (state.gameActive) {
      requestAnimationFrame(animate);
      // Real seconds since the last frame. planSubsteps ceiling-caps it at
      // MAX_SUBSTEPS * FIXED_DT (the spiral-of-death guard) before consuming it.
      const frameDelta = (time - lastTime) / 1000;
      lastTime = time;

      // Only set up test hooks if they're missing
      if (!window.testHooks) {
        console.log("Test hooks missing in animation loop, reinstalling");
        Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
      }

      const plan = planSubsteps(frameDelta, accumulator);
      accumulator = plan.accumulator;

      // Run the fixed substeps, remembering the player position just BEFORE the LAST one:
      // `alpha` is the fraction past that final completed step, so the render interpolates
      // between the penultimate and final physics states (not across the whole frame).
      const events = freshEvents();
      let result: UpdateResult | null = lastResult;
      let prevState: { x: number; y: number; z: number } | null = null;
      for (let i = 0; i < plan.substeps; i++) {
        prevState = { x: snowman.position.x, y: snowman.position.y, z: snowman.position.z };
        result = stepFixed(FIXED_DT, events);
        // A substep can end the run (finish / crash / burial); stop stepping a dead run.
        if (!state.gameActive) break;
      }
      // Only bracket interpolation when a substep actually moved the player this frame;
      // otherwise render at the current (unchanged) state.
      renderPrev = prevState;

      renderFrame(frameDelta, plan.alpha, result, events);
    } else if (state.animationRunning) {
      state.animationRunning = false;
    }
  }

  // Seed the frame clock and kick the loop. Replaces the lifecycle sites' previous
  // `lastTime = performance.now(); animate(lastTime)` so the first delta stays ~0
  // while `lastTime` remains private to the loop.
  function startLoop() {
    lastTime = performance.now();
    accumulator = 0;
    renderPrev = null;
    animate(lastTime);
  }

  // --- Handle Window Resize ---
  function handleResize() {
    cameraManager.handleResize();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  return { updateSnowman, updateCamera, animate, startLoop, handleResize };
}

// Re-export the accumulator surface for the frame-rate-equivalence / tunnel-risk harnesses.
export { FIXED_DT, MAX_SUBSTEPS, planSubsteps };
