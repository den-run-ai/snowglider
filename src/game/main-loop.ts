// Per-frame run loop for SnowGlider: physics step + HUD, camera follow, the
// requestAnimationFrame loop (course progress, avalanche, snow splash, camera juice,
// render), and the window-resize handler. Extracted from snowglider.ts as
// `createMainLoop(deps)`; the coordinator injects the constructed scene handles +
// run/player state and re-publishes `updateSnowman`/`updateCamera` on `window`.
// Mechanical move — per-frame ordering and behavior are unchanged.

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
import { updateStatsHud, updateTimerDisplay } from '../ui/hud.js';
import { AVALANCHE_TRIGGER_DISTANCE, type SceneContext } from './scene-setup.js';

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

  // --- Update Snowman: Physics-based Movement ---
  function updateSnowman(delta: number) {
    // We no longer need to add test hooks every frame as they're set up at initialization
    // and after resets. This improves performance.
    const activeShowGameOver = typeof window.showGameOver === 'function'
      ? window.showGameOver
      : showGameOver;

    // Advance the player one frame. Physics.stepPlayer wraps Snowman.updateSnowman
    // (the unchanged physics kernel) and writes the mutated scalars back into the
    // typed `player` state, returning the per-frame result for the HUD/camera.
    const result = Physics.stepPlayer(player, {
      snowman,
      delta,
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

    // Update game stats display (speed/altitude/slope/technique). The slope
    // readout is the terrain steepness under the player: gradient magnitude
    // (rise/run = tan θ), the same measure the terrain code uses for placement.
    const grad = Snow.getTerrainGradient(pos.x, pos.z);
    const slopeRatio = Math.sqrt(grad.x * grad.x + grad.z * grad.z);
    updateStatsHud(result, pos, player.isInAir, slopeRatio);

    // Camera shake on a meaningful landing (scales with time spent aloft).
    if (result.justLanded && result.landingForce > 0.25 && EffectsModule) {
      EffectsModule.addShake(Math.min(1.2, result.landingForce * 0.6));
    }

    // Meaningful jumps (#47): on a graded *manual*-jump landing, toast the air time
    // + grade. landingQuality is non-null only for a player-initiated jump, so
    // auto-jumps / hop turns / coasting never toast. (The air score itself is banked
    // inside the step via bankAirScore above, so a finish-frame jump still counts.)
    if (result.justLanded && result.landingQuality && CourseModule) {
      CourseModule.flashAir(result.landingQuality, result.landingForce);
    }

    // Cosmetic flexibility / jiggle (issue #53). Purely visual: runs AFTER the physics
    // kernel so it can read the per-frame result, and only writes child-mesh transforms —
    // it never touches pos/velocity, so the physics-invariant harness is unaffected.
    const flexSpeed = result.currentSpeed;
    Flex.update(snowman, delta, {
      speed: flexSpeed,
      technique: result.technique,
      turnRate: flexSpeed > 1e-3 ? velocity.x / flexSpeed : 0, // zero-speed guard (no 0/0 NaN)
      justLanded: result.justLanded,
      landingForce: result.landingForce,
      isInAir: player.isInAir
    });

    // Sound effects (issue #158): a takeoff whoosh on the ground→air transition, a
    // touchdown thump scaled by air time, and the continuous wind + ski-edge bed.
    // Reads the per-frame result only — never pos/velocity — so the physics-invariant
    // harness is unaffected, and every call is a no-op until the SFX context is
    // unlocked by the start gesture.
    if (result.isInAir && !prevInAir) Sfx.jump();
    if (result.justLanded) Sfx.land(result.landingForce);
    prevInAir = result.isInAir;
    Sfx.updateSkiing(result.currentSpeed, result.technique, result.isInAir);

    // Frame-rate / physics telemetry (diagnostics.ts). READ-ONLY observer, wired in
    // beside Sfx/Flex: it reads the per-frame result + pos only and never touches
    // pos/velocity, so the physics-invariant harness is unaffected and it is a no-op
    // under automation. It watches the dt the real device produces and the speed/step
    // that ride on it, surfacing the frame-rate-dependence bug class (#209) live.
    Diag.record({
      dt: delta,
      speed: result.currentSpeed,
      x: pos.x,
      z: pos.z,
      technique: result.technique,
      isInAir: player.isInAir,
    });

    // Update timer in the updateTimerDisplay function which is called separately
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
  function animate(time: number) {
    if (state.gameActive) {
      requestAnimationFrame(animate);
      const delta = Math.min((time - lastTime) / 1000, 0.1); // Cap delta to avoid jumps
      lastTime = time;

      // Only set up test hooks if they're missing
      if (!window.testHooks) {
        console.log("Test hooks missing in animation loop, reinstalling");
        // addTestHooks(pos, showGameOver, getTerrainHeight) — matches the two other
        // call sites; the stray `gameActive` arg here was a latent bug (it landed in
        // the getTerrainHeight slot), surfaced by the type-checker.
        Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
      }

      updateSnowman(delta);
      Snow.updateSnowflakes(delta, pos, scene);

      // Dynamic ski trails / snow accumulation (#17): carve fading grooves behind
      // the skis that fresh snow covers back over. Purely cosmetic — reads position
      // only, never the physics state.
      state.snowTrails?.update(delta, snowman, player.isInAir);

      // Advance the golden-hour↔midday sun cycle (sun position/colour, sky
      // exposure, fog). Purely atmospheric; a no-op under reduced motion. (#163)
      Sky.update(delta);

      // --- Course progress: split timing, progress HUD, ghost racing ---
      if (CourseModule) {
        const elapsed = (performance.now() - state.startTime) / 1000;
        CourseModule.update(pos, elapsed, snowman);
      }

      // --- Avalanche Logic ---
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

        // Update avalanche physics
        avalanche.update(delta);

        // Check for burial (collision with avalanche)
        if (avalanche.checkBurial(snowman.position)) {
          showGameOver("Buried by avalanche!");
        }

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
      Snow.updateSnowSplash(snowSplash, delta, snowman, velocity, player.isInAir, scene);

      // Ensure snowman position wasn't affected by particles
      snowman.position.set(playerPosBefore.x, playerPosBefore.y, playerPosBefore.z);

      updateCamera();
      updateTimerDisplay(state.gameActive, state.startTime); // Update the timer display

      // Camera juice: speed-based FOV + shake. Apply for the render only, then revert
      // the positional offset so the camera manager's own smoothing stays clean.
      let _shake: ShakeOffset | null = null;
      if (EffectsModule) {
        const spd = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
        _shake = EffectsModule.tickCamera(camera, delta, spd);
      }
      renderer.render(scene, camera);
      if (_shake) {
        camera.position.x -= _shake.x;
        camera.position.y -= _shake.y;
        camera.position.z -= _shake.z;
      }
    } else if (state.animationRunning) {
      state.animationRunning = false;
    }
  }

  // Seed the frame clock and kick the loop. Replaces the lifecycle sites' previous
  // `lastTime = performance.now(); animate(lastTime)` so the first delta stays ~0
  // while `lastTime` remains private to the loop.
  function startLoop() {
    lastTime = performance.now();
    animate(lastTime);
  }

  // --- Handle Window Resize ---
  function handleResize() {
    cameraManager.handleResize();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  return { updateSnowman, updateCamera, animate, startLoop, handleResize };
}
