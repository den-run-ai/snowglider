// Per-frame run loop for SnowGlider: a FIXED-TIMESTEP accumulator that advances
// physics in whole 1/60 s steps (`stepFixed`), a per-render-frame cosmetic/observer
// pass (`renderFrame`), the requestAnimationFrame driver (`animate`), and the
// window-resize handler. `createMainLoop(deps)` is built by the coordinator, which
// injects the scene handles + run/player state and re-publishes
// `updateSnowman`/`updateCamera` on `window`.
//
// WHY THE FIXED TIMESTEP (issue: frame-rate determinism)
// ------------------------------------------------------
// The physics-invariant harness pins the kernel at dt = 1/60 on every step; the live
// loop was the only thing running variable dt, so on a slow device a single frame
// could step `velocity * delta` (delta up to the 0.1 s cap) far enough to tunnel
// through the discrete tree/rock collision check and to diverge from the 60 Hz
// trajectory. Stepping physics on a fixed 1/60 grid (see fixed-timestep.ts) makes the
// live game advance physics at exactly the rate the harness pins — the thing tested
// becomes the thing that runs — and makes the per-step displacement `velocity / 60`,
// so tunnel-risk frames go to zero by construction at any render rate. The physics
// kernel (snowman/physics.ts) is unchanged; the accumulator lives entirely here.
//
// SPLIT: physics-grid work vs. per-render cosmetics
//   stepFixed(dt)   — runs at the fixed rate: physics advance, course progress, and the
//                     avalanche burial check (anything that changes run outcome or could
//                     be MISSED between frames). Also feeds the read-only diagnostics
//                     recorder per substep, so it observes the true small physics step.
//   renderFrame(...) — runs once per render frame on the real frame delta: HUD, flex,
//                     SFX, snow particles, sky, avalanche advance/UI, camera, render.
//                     Visual only; never affects the physics-invariant harness.
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
import { FIXED_DT, planSubsteps } from './fixed-timestep.js';
import { AVALANCHE_TRIGGER_DISTANCE, type SceneContext } from './scene-setup.js';

/** Events that can fire on ANY substep within a render frame, reduced across the
 *  frame's substeps so a jump/landing that completes mid-frame is never dropped
 *  (see §5 of the fixed-timestep plan). The observer pass fires the one-shot SFX /
 *  toasts / shake from this aggregate, not from the last substep's result alone. */
interface FrameEvents {
  justLanded: boolean;             // a landing happened on some substep this frame
  tookOff: boolean;                // a ground->air transition happened this frame
  landingQuality: LandingQuality | null; // grade of a manual-jump landing (null otherwise)
  landingForce: number;            // force of the most recent landing this frame
}

function emptyFrameEvents(): FrameEvents {
  return { justLanded: false, tookOff: false, landingQuality: null, landingForce: 0 };
}

export interface MainLoopDeps extends
  Pick<SceneContext, 'state' | 'scene' | 'camera' | 'renderer' | 'cameraManager' |
    'snowman' | 'snowSplash' | 'treePositions' | 'rockPositions'> {
  player: PlayerState;
  showGameOver: (reason: string) => void;
}

export function createMainLoop(deps: MainLoopDeps) {
  const {
    state, scene, camera, renderer, cameraManager,
    snowman, snowSplash, treePositions, rockPositions,
    player, showGameOver,
  } = deps;
  const pos = player.pos;
  const velocity = player.velocity;

  // Previous-frame air state, so we can fire a takeoff whoosh on the ground→air
  // transition (the kernel's UpdateResult exposes justLanded but no justJumped).
  let prevInAir = false;

  // The most recent physics result, cached so a render frame that runs ZERO substeps
  // (render faster than 60 Hz) still has continuous readouts (speed/technique/slope)
  // for the HUD/flex/SFX observer pass.
  let lastResult: UpdateResult | null = null;

  // --- Physics advance (shared kernel call) ---------------------------------
  // One physics integration step. Physics.stepPlayer wraps Snowman.updateSnowman (the
  // unchanged kernel) and writes the mutated scalars back into the typed `player`
  // state, returning the per-frame result. This is the ONLY physics-state mutation in
  // the loop; both stepFixed (live, fixed grid) and updateSnowman (the compat seam the
  // browser tests drive) go through it.
  function stepPhysics(dt: number): UpdateResult {
    const activeShowGameOver = typeof window.showGameOver === 'function'
      ? window.showGameOver
      : showGameOver;
    return Physics.stepPlayer(player, {
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
  }

  // --- Per-render-frame cosmetic / observer pass ----------------------------
  // Everything purely visual or smoothing-based: HUD, the cosmetic flex/jiggle, and
  // the SFX one-shots + continuous bed. Reads the per-frame physics RESULT plus the
  // reduced FrameEvents — never mutates pos/velocity — so the physics-invariant harness
  // is unaffected. Runs once per render frame on the real frame delta.
  function applyFrameObservers(result: UpdateResult, frameDelta: number, events: FrameEvents) {
    // Update game stats display (speed/altitude/slope/technique). The slope
    // readout is the terrain steepness under the player: gradient magnitude
    // (rise/run = tan θ), the same measure the terrain code uses for placement.
    const grad = Snow.getTerrainGradient(pos.x, pos.z);
    const slopeRatio = Math.sqrt(grad.x * grad.x + grad.z * grad.z);
    updateStatsHud(result, pos, player.isInAir, slopeRatio);

    // Camera shake on a meaningful landing (scales with time spent aloft).
    if (events.justLanded && events.landingForce > 0.25 && EffectsModule) {
      EffectsModule.addShake(Math.min(1.2, events.landingForce * 0.6));
    }

    // Meaningful jumps (#47): on a graded *manual*-jump landing, toast the air time
    // + grade. landingQuality is non-null only for a player-initiated jump, so
    // auto-jumps / hop turns / coasting never toast. (The air score itself is banked
    // inside the step via bankAirScore, so a finish-frame jump still counts.)
    if (events.landingQuality && CourseModule) {
      CourseModule.flashAir(events.landingQuality, events.landingForce);
    }

    // Cosmetic flexibility / jiggle (issue #53). Purely visual: only writes child-mesh
    // transforms — never touches pos/velocity, so the harness is unaffected.
    const flexSpeed = result.currentSpeed;
    Flex.update(snowman, frameDelta, {
      speed: flexSpeed,
      technique: result.technique,
      turnRate: flexSpeed > 1e-3 ? velocity.x / flexSpeed : 0, // zero-speed guard (no 0/0 NaN)
      justLanded: events.justLanded,
      landingForce: events.landingForce,
      isInAir: player.isInAir
    });

    // Sound effects (issue #158): a takeoff whoosh on the ground→air transition, a
    // touchdown thump scaled by air time, and the continuous wind + ski-edge bed.
    // The jump/land one-shots fire from the reduced events (so a takeoff/landing on
    // any substep is heard); the continuous bed reads the latest result. Reads result
    // only — never pos/velocity — and is a no-op until the SFX context is unlocked.
    if (events.tookOff) Sfx.jump();
    if (events.justLanded) Sfx.land(events.landingForce);
    Sfx.updateSkiing(result.currentSpeed, result.technique, result.isInAir);
  }

  // Fold one substep's result into the frame's reduced events + advance prevInAir.
  function reduceFrameEvents(events: FrameEvents, result: UpdateResult) {
    if (result.justLanded) { events.justLanded = true; events.landingForce = result.landingForce; }
    if (result.isInAir && !prevInAir) events.tookOff = true;
    if (result.landingQuality) events.landingQuality = result.landingQuality;
    prevInAir = result.isInAir;
  }

  // --- Fixed substep: physics + run-outcome gates (the fixed-grid work) ------
  // Runs at the fixed 1/60 rate. Advances physics, then the two subsystems that gate
  // the run outcome and could be MISSED between frames at a low render rate: course
  // progress (split timing / finish) and the avalanche burial check. Also feeds the
  // read-only diagnostics recorder per substep, so it observes the true (small) physics
  // step — which is exactly why tunnel-risk frames go to zero with a fixed timestep.
  function stepFixed(dt: number, events: FrameEvents): UpdateResult {
    const activeShowGameOver = typeof window.showGameOver === 'function'
      ? window.showGameOver
      : showGameOver;

    const result = stepPhysics(dt);
    reduceFrameEvents(events, result);

    // Course progress: split timing, progress HUD, ghost racing — on the fixed grid so
    // gate/finish detection can't be skipped over by a large frame step.
    if (CourseModule) {
      const elapsed = (performance.now() - state.startTime) / 1000;
      CourseModule.update(pos, elapsed, snowman);
    }

    // Avalanche burial (game over) — also a run-outcome gate, so it samples the player
    // on the fixed grid against the boulder field. (Boulder advance + UI stay in the
    // render pass.)
    const avalanche = state.avalanche;
    if (avalanche && avalanche.checkBurial(snowman.position)) {
      activeShowGameOver("Buried by avalanche!");
    }

    // Frame-rate / physics telemetry (diagnostics.ts). READ-ONLY observer fed PER
    // SUBSTEP: it sees dt = FIXED_DT and the small per-step displacement, so on the
    // fixed grid `tunnelRisk` (step >= an obstacle radius) is zero by construction. It
    // never touches pos/velocity, so the physics-invariant harness is unaffected and it
    // is a no-op under automation.
    Diag.record({
      dt,
      speed: result.currentSpeed,
      x: pos.x,
      z: pos.z,
      technique: result.technique,
      isInAir: player.isInAir,
    });

    return result;
  }

  // --- Update Snowman: compat seam for the browser tests --------------------
  // The browser suites drive `window.updateSnowman(delta)` to advance the player one
  // frame by `delta` and run the cosmetic observers (they assert collision/jump from
  // it). Preserved with its exact original behavior — physics advance + observer pass
  // (course/avalanche stay out of it, as before). The LIVE loop no longer calls this;
  // it runs stepFixed substeps + renderFrame.
  function updateSnowman(delta: number) {
    const result = stepPhysics(delta);
    const events: FrameEvents = emptyFrameEvents();
    reduceFrameEvents(events, result);
    applyFrameObservers(result, delta, events);
    lastResult = result;

    // Per-frame telemetry (inert under automation, where the browser tests run).
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

  // --- Per-render-frame pass: cosmetics + avalanche advance + camera + render ----
  // Runs once per render frame on the real frame delta. `result` is the latest physics
  // result (the last substep's, or the cached one on a zero-substep frame); `events`
  // is reduced across this frame's substeps; `alpha` is the leftover-step fraction for
  // render interpolation. None of this mutates pos/velocity.
  function renderFrame(frameDelta: number, alpha: number, events: FrameEvents, result: UpdateResult | null) {
    // HUD / flex / SFX observers (only when we have a physics result to read).
    if (result) applyFrameObservers(result, frameDelta, events);

    Snow.updateSnowflakes(frameDelta, pos, scene);

    // Dynamic ski trails / snow accumulation (#17): carve fading grooves behind
    // the skis that fresh snow covers back over. Purely cosmetic — reads position
    // only, never the physics state.
    state.snowTrails?.update(frameDelta, snowman, player.isInAir);

    // Advance the golden-hour↔midday sun cycle (sun position/colour, sky
    // exposure, fog). Purely atmospheric; a no-op under reduced motion. (#163)
    Sky.update(frameDelta);

    // --- Avalanche advance + UI (the burial check ran on the fixed grid) ---
    const avalanche = state.avalanche;
    if (avalanche) {
      // Trigger avalanche based on distance traveled (simple geometric trigger)
      // Player starts at z=-15 and moves in -Z direction (downhill)
      const distanceTraveled = state.lastAvalancheZ - pos.z;

      if (!state.avalancheTriggered && distanceTraveled > AVALANCHE_TRIGGER_DISTANCE) {
        avalanche.trigger(snowman.position);
        state.avalancheTriggered = true;
        console.log("Avalanche triggered! Distance traveled:", distanceTraveled.toFixed(1));
      }

      // Update avalanche physics (boulder advance is cosmetic enough to run per render
      // frame; burial — the run-outcome gate — is sampled per fixed substep above).
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

    // --- Render interpolation ---
    // Place the snowman at lerp(prevPhysicsPos, curPhysicsPos, alpha) so the visual
    // position is smooth when the render rate doesn't divide 60 evenly (144 Hz, 50 Hz).
    // Physics state stays authoritative on the fixed grid in `player.pos`; we only move
    // the MESH for the camera + render, then restore it below. `hasPhysics` guards the
    // first frame(s) before any substep has run.
    if (hasPhysics) {
      snowman.position.set(
        prevPhysicsPos.x + (curPhysicsPos.x - prevPhysicsPos.x) * alpha,
        prevPhysicsPos.y + (curPhysicsPos.y - prevPhysicsPos.y) * alpha,
        prevPhysicsPos.z + (curPhysicsPos.z - prevPhysicsPos.z) * alpha,
      );
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

    updateCamera();
    updateTimerDisplay(state.gameActive, state.startTime); // Update the timer display

    // Camera juice: speed-based FOV + shake. Apply for the render only, then revert
    // the positional offset so the camera manager's own smoothing stays clean.
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

    // Restore the authoritative physics position to the mesh, so the next frame's
    // physics step, the burial check, and any other reader start from truth rather than
    // the interpolated render position.
    if (hasPhysics) {
      snowman.position.set(curPhysicsPos.x, curPhysicsPos.y, curPhysicsPos.z);
    }
  }

  // --- Animation Loop (fixed-timestep accumulator) ---
  let lastTime = 0;
  let accumulator = 0;
  // The physics position before/after the most recent fixed substep, for render
  // interpolation. `hasPhysics` becomes true once at least one substep has run.
  const prevPhysicsPos = { x: 0, y: 0, z: 0 };
  const curPhysicsPos = { x: 0, y: 0, z: 0 };
  let hasPhysics = false;

  function animate(time: number) {
    if (state.gameActive) {
      requestAnimationFrame(animate);

      // Fold the real elapsed time into the accumulator and decide how many whole 1/60 s
      // physics steps to run (clamped to MAX_SUBSTEPS — the spiral-of-death guard, the
      // same ~0.1 s ceiling the old clamp imposed, now expressed as a step count).
      const plan = planSubsteps(accumulator, (time - lastTime) / 1000);
      accumulator = plan.accumulator;
      lastTime = time;

      // Only set up test hooks if they're missing
      if (!window.testHooks) {
        console.log("Test hooks missing in animation loop, reinstalling");
        // addTestHooks(pos, showGameOver, getTerrainHeight) — matches the two other
        // call sites; the stray `gameActive` arg here was a latent bug (it landed in
        // the getTerrainHeight slot), surfaced by the type-checker.
        Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
      }

      // Advance physics on the fixed grid. Events are reduced across the substeps so a
      // jump/landing that completes mid-frame is never dropped (§5).
      const events: FrameEvents = emptyFrameEvents();
      for (let i = 0; i < plan.steps; i++) {
        prevPhysicsPos.x = pos.x; prevPhysicsPos.y = pos.y; prevPhysicsPos.z = pos.z;
        lastResult = stepFixed(FIXED_DT, events);
        curPhysicsPos.x = pos.x; curPhysicsPos.y = pos.y; curPhysicsPos.z = pos.z;
        hasPhysics = true;
        // showGameOver (finish / crash / burial) flips gameActive off; stop stepping the
        // moment a run ends so we never advance physics past its terminal frame.
        if (!state.gameActive) break;
      }

      renderFrame(plan.frameDelta, plan.alpha, events, lastResult);
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
    hasPhysics = false;
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
