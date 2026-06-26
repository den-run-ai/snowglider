// Per-frame run loop for SnowGlider: a FIXED-TIMESTEP physics core (the accumulator
// in `animate`) wrapped by a per-render-frame cosmetic/observer layer, plus the
// requestAnimationFrame loop (avalanche advance, snow splash, camera follow, render)
// and the window-resize handler. Extracted from snowglider.ts as `createMainLoop(deps)`;
// the coordinator injects the constructed scene handles + run/player state and
// re-publishes `updateSnowman`/`updateCamera` on `window`.
//
// WHY A FIXED TIMESTEP (the bug class it closes — see diagnostics.ts / PR #209)
// ---------------------------------------------------------------------------
// The kernel mixes per-second forces (`v += a*dt`) with what used to be a per-frame
// drag multiplier, so a variable-`dt` loop made the steady state frame-rate dependent:
// terminal speed ballooned at low FPS and a single large step (`pos += v*dt`) could
// exceed an obstacle's collision radius (2.5) and tunnel straight through the trees.
// Stepping physics ONLY in fixed 1/60 s increments removes the cause: the per-step
// displacement is `v/60` (well under 2.5 at any sane speed) and the kernel always sees
// the exact `dt` the physics-invariant harness pins, so the live game advances physics
// at the same rate the tests verify. The kernel (snowman/physics.ts) is untouched; the
// accumulator lives entirely here. See `docs/PHYSICS.md` and the §-comments below.

import { Controls } from '../controls.js';
import { Snow } from '../snow.js';
import { Sky } from '../sky.js';
import { Snowman, type UpdateResult, type LandingQuality } from '../snowman.js';
import { Flex } from '../snowman-flex.js';
import { CourseModule } from '../course.js';
import { Sfx } from '../sfx.js';
import { Diag } from '../diagnostics.js';
import { EffectsModule, type ShakeOffset } from '../effects.js';
import { Physics, type PlayerState } from '../player-state.js';
import { updateStatsHud, updateTimerDisplay } from '../ui/hud.js';
import { AVALANCHE_TRIGGER_DISTANCE, type SceneContext } from './scene-setup.js';

// The physics grid. FIXED_DT is the rate the invariant harness pins (1/60 s), so the
// kernel is byte-identical here to the headless suites. MAX_SUBSTEPS caps how many
// physics steps a single slow render frame may run (the spiral-of-death guard): at
// ~<8 FPS the game *slows down* rather than tunnelling — the same ~133 ms ceiling the
// old `Math.min(delta, 0.1)` clamp imposed, expressed as a step count instead.
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 8;

/** Events that can fire on ANY substep within a render frame, reduced across the
 *  frame so a jump/land that completes mid-frame still drives its one-shot cosmetics
 *  (whoosh / thump / toast / shake). Reading only the LAST substep's result would
 *  silently drop a landing that happened in substep 2 of 3 (§5 of the plan). */
interface FrameEvents {
  justLanded: boolean;
  tookOff: boolean;                    // ground->air edge seen within the frame's substeps
  landingQuality: LandingQuality | null;
  landingForce: number;
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

  // Previous-substep air state, so we can fire a takeoff whoosh on the ground->air
  // transition (the kernel's UpdateResult exposes justLanded but no justJumped).
  // Tracked across substeps so a takeoff in any substep is seen.
  let prevInAir = false;
  // The latest per-step physics result, retained so a render frame that ran ZERO
  // substeps (a >60 Hz panel) can still repaint the HUD / advance cosmetics from the
  // last known state instead of going blank.
  let lastResult: UpdateResult | null = null;

  function newFrameEvents(): FrameEvents {
    return { justLanded: false, tookOff: false, landingQuality: null, landingForce: 0 };
  }

  // Reduce one substep's result into the frame's aggregated events (§5). Also advances
  // prevInAir so a ground->air edge within the substeps is caught exactly once. (Air
  // SCORE is not aggregated here — it is banked in-kernel per step via bankAirScore, so
  // a mid-frame landing's points are never dropped; only the one-shot CUES are reduced.)
  function aggregateEvents(ev: FrameEvents, result: UpdateResult): void {
    if (result.justLanded) {
      ev.justLanded = true;
      ev.landingForce = result.landingForce;
      ev.landingQuality = result.landingQuality; // null for auto-jumps; non-null only on a manual jump
    }
    if (result.isInAir && !prevInAir) ev.tookOff = true;
    prevInAir = result.isInAir;
  }

  // --- Physics advance + telemetry (one step) -----------------------------------
  // The kernel step: advances the player one step at `dt` and records read-only
  // diagnostics. Shared by the live loop's fixed substep and the legacy
  // `updateSnowman(delta)` test seam, so both record telemetry exactly as before.
  function stepPhysics(dt: number): UpdateResult {
    const activeShowGameOver = typeof window.showGameOver === 'function'
      ? window.showGameOver
      : showGameOver;

    // Advance the player one step. Physics.stepPlayer wraps Snowman.updateSnowman (the
    // unchanged physics kernel) and writes the mutated scalars back into the typed
    // `player` state, returning the per-step result. The kernel itself runs the discrete
    // tree/rock collision + the finish check and calls showGameOver on a crash/finish.
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

    // Frame-rate / physics telemetry (diagnostics.ts). READ-ONLY observer: it reads the
    // per-step result + pos only and never touches pos/velocity, so the physics-invariant
    // harness is unaffected and it is a no-op under automation. Recorded PER STEP (and in
    // the loop that means per FIXED 1/60 step, not per render frame) so `step` reflects
    // the real collision-time displacement — `v/60` — and `tunnelRisk` frames go to zero
    // by construction (#209).
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

  // --- Fixed substep: physics + the loop's outcome gates ------------------------
  // The live loop's fixed-grid step. Wraps stepPhysics with the two run-outcome checks
  // that live in the loop (not the kernel) and so must also run on the fixed grid, so a
  // fast render frame can't carry the player past them between samples. Runs at FIXED_DT.
  function stepFixed(dt: number): UpdateResult {
    const result = stepPhysics(dt);

    // --- Course progress: split timing, progress HUD, ghost racing ---
    // The split/ghost readouts still key off wall-clock elapsed.
    if (CourseModule) {
      const elapsed = (performance.now() - state.startTime) / 1000;
      CourseModule.update(pos, elapsed, snowman);
    }

    // --- Avalanche burial check (outcome gate) ---
    // The only run-ending check that lives in the loop rather than the kernel.
    // checkBurial() self-guards when inactive.
    const avalanche = state.avalanche;
    if (avalanche && avalanche.checkBurial(snowman.position)) {
      const activeShowGameOver = typeof window.showGameOver === 'function'
        ? window.showGameOver
        : showGameOver;
      activeShowGameOver("Buried by avalanche!");
    }

    return result;
  }

  // --- Per-render-frame observers: HUD + cosmetics that read the physics result ----
  // Purely visual / smoothing-based: runs once per render frame on the real frame delta
  // and never affects the harness. `result` is the latest substep's; `ev` aggregates the
  // frame's one-shot events so a mid-frame landing isn't dropped.
  function renderObservers(frameDelta: number, result: UpdateResult, ev: FrameEvents): void {
    // Update game stats display (speed/altitude/slope/technique). The slope readout is
    // the terrain steepness under the player: gradient magnitude (rise/run = tan θ).
    const grad = Snow.getTerrainGradient(pos.x, pos.z);
    const slopeRatio = Math.sqrt(grad.x * grad.x + grad.z * grad.z);
    updateStatsHud(result, pos, player.isInAir, slopeRatio);

    // Camera shake on a meaningful landing (scales with time spent aloft).
    if (ev.justLanded && ev.landingForce > 0.25 && EffectsModule) {
      EffectsModule.addShake(Math.min(1.2, ev.landingForce * 0.6));
    }

    // Meaningful jumps (#47): on a graded *manual*-jump landing, toast the air time +
    // grade. landingQuality is non-null only for a player-initiated jump, so auto-jumps /
    // hop turns / coasting never toast. (The air score itself is banked inside the step.)
    if (ev.justLanded && ev.landingQuality && CourseModule) {
      CourseModule.flashAir(ev.landingQuality, ev.landingForce);
    }

    // Cosmetic flexibility / jiggle (issue #53). Purely visual: reads the per-frame
    // result, only writes child-mesh transforms — never pos/velocity.
    const flexSpeed = result.currentSpeed;
    Flex.update(snowman, frameDelta, {
      speed: flexSpeed,
      technique: result.technique,
      turnRate: flexSpeed > 1e-3 ? velocity.x / flexSpeed : 0, // zero-speed guard (no 0/0 NaN)
      justLanded: ev.justLanded,
      landingForce: ev.landingForce,
      isInAir: player.isInAir
    });

    // Sound effects (issue #158): a takeoff whoosh on the ground->air transition, a
    // touchdown thump scaled by air time, and the continuous wind + ski-edge bed. Reads
    // the per-frame result/events only — never pos/velocity — so the harness is
    // unaffected, and every call is a no-op until the SFX context is unlocked.
    if (ev.tookOff) Sfx.jump();
    if (ev.justLanded) Sfx.land(ev.landingForce);
    Sfx.updateSkiing(result.currentSpeed, result.technique, result.isInAir);
  }

  // --- Update Snowman: ONE physics step + its observers (legacy / test seam) -------
  // Preserved as the window-published `updateSnowman(delta)` the browser suites drive
  // directly (e.g. updateSnowman(0.1) in the tree/regression tests). It advances physics
  // exactly one step at the passed delta and applies the same per-step observers the old
  // single-call loop did — physics + telemetry + HUD/flex/sfx, with no course/avalanche
  // (those lived in `animate`, not `updateSnowman`). The live rAF loop does NOT call
  // this; it runs the fixed-step accumulator below.
  function updateSnowman(delta: number) {
    // We no longer need to add test hooks every frame as they're set up at initialization
    // and after resets. This improves performance.
    const result = stepPhysics(delta);
    const ev = newFrameEvents();
    aggregateEvents(ev, result);
    renderObservers(delta, result, ev);
    lastResult = result;
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

  // --- Animation Loop (fixed-timestep accumulator) ---
  let lastTime = 0;
  let accumulator = 0;
  function animate(time: number) {
    if (state.gameActive) {
      requestAnimationFrame(animate);
      // Ceiling the frame delta at the spiral guard (MAX_SUBSTEPS * FIXED_DT) so a long
      // stall (tab restore, GC pause) can't pour an unbounded backlog into the accumulator.
      const frameDelta = Math.min((time - lastTime) / 1000, MAX_SUBSTEPS * FIXED_DT);
      lastTime = time;

      // Only set up test hooks if they're missing
      if (!window.testHooks) {
        console.log("Test hooks missing in animation loop, reinstalling");
        // addTestHooks(pos, showGameOver, getTerrainHeight) — matches the two other
        // call sites; the stray `gameActive` arg here was a latent bug (it landed in
        // the getTerrainHeight slot), surfaced by the type-checker.
        Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
      }

      // --- Fixed-step physics core ---------------------------------------------
      // Drain the accumulator in fixed 1/60 s steps. `prevState` is the player position
      // BEFORE the final substep and `pos` is the position AFTER it; we interpolate the
      // render between them by `alpha` so a render rate that doesn't divide 60 evenly
      // (144 Hz, 50 Hz) doesn't alias. Physics state stays authoritative on the grid.
      accumulator += frameDelta;
      let prevX = pos.x, prevY = pos.y, prevZ = pos.z;
      const ev = newFrameEvents();
      let result = lastResult;
      let substeps = 0;
      while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS && state.gameActive) {
        prevX = pos.x; prevY = pos.y; prevZ = pos.z; // state before this step
        result = stepFixed(FIXED_DT);
        aggregateEvents(ev, result);
        accumulator -= FIXED_DT;
        substeps++;
      }
      // Spiral-of-death guard: if we hit the substep ceiling with time still owed, drop
      // the surplus (the game slows down rather than tunnelling) and keep alpha in [0,1).
      if (substeps >= MAX_SUBSTEPS && accumulator >= FIXED_DT) accumulator = 0;
      const alpha = accumulator / FIXED_DT;
      if (result) lastResult = result;

      // Per-render-frame observers (HUD/flex/sfx) — once per frame on the real delta.
      // `result` is null only before the very first physics step has ever run.
      if (result) renderObservers(frameDelta, result, ev);

      Snow.updateSnowflakes(frameDelta, pos, scene);

      // Dynamic ski trails / snow accumulation (#17): carve fading grooves behind the
      // skis that fresh snow covers back over. Purely cosmetic — reads position only.
      state.snowTrails?.update(frameDelta, snowman, player.isInAir);

      // Advance the golden-hour<->midday sun cycle (sun position/colour, sky exposure,
      // fog). Purely atmospheric; a no-op under reduced motion. (#163)
      Sky.update(frameDelta);

      // --- Avalanche advance / UI (cosmetic boulder physics; burial is gated above) ---
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

        // Update avalanche physics (boulder tumble advances on the render delta).
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

      // --- Render at the interpolated position --------------------------------
      // Render the snowman/camera at lerp(prevState, curState, alpha) to remove temporal
      // aliasing on non-60 panels, then restore the authoritative physics position so the
      // camera manager's own smoothing and the next frame stay clean. (Up to ~1 fixed
      // step of visual latency; acceptable for this game — see §7 of the plan.)
      const renderX = prevX + (pos.x - prevX) * alpha;
      const renderY = prevY + (pos.y - prevY) * alpha;
      const renderZ = prevZ + (pos.z - prevZ) * alpha;
      snowman.position.set(renderX, renderY, renderZ);

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

      // Restore the authoritative (un-interpolated) physics position for the next frame.
      snowman.position.set(pos.x, pos.y, pos.z);
    } else if (state.animationRunning) {
      state.animationRunning = false;
    }
  }

  // Seed the frame clock and kick the loop. Replaces the lifecycle sites' previous
  // `lastTime = performance.now(); animate(lastTime)` so the first delta stays ~0 while
  // `lastTime`/`accumulator` remain private to the loop. Clears the per-run observer
  // carry-over (last result + air edge) so a restart doesn't render one stale HUD/SFX
  // frame from the previous run before its first physics step lands.
  function startLoop() {
    lastTime = performance.now();
    accumulator = 0;
    lastResult = null;
    prevInAir = false;
    animate(lastTime);
  }

  // --- Handle Window Resize ---
  function handleResize() {
    cameraManager.handleResize();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  return { updateSnowman, updateCamera, animate, startLoop, handleResize };
}
