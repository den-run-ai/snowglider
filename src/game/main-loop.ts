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

import * as THREE from 'three';
import { Controls } from '../controls.js';
import { Snow } from '../snow.js';
import { Sky } from '../sky.js';
import { aimSunLight } from './sun-shadow.js';
import { Wind } from '../wind.js';
import { Snowman, type UpdateResult, type LandingQuality } from '../snowman.js';
import { Flex } from '../snowman-flex.js';
import { CourseModule } from '../course.js';
import { AudioModule } from '../audio.js';
import { Sfx } from '../sfx.js';
import { Diag } from '../diagnostics.js';
import { EffectsModule, type ShakeOffset } from '../effects.js';
import { Physics, type PlayerState } from '../player-state.js';
import { getDifficultyConfig } from '../difficulty.js';
import { updateStatsHud, updateTimerDisplay, updateLevelHud } from '../ui/hud.js';
import { showFatalErrorOverlay } from '../ui/fatal-error-overlay.js';
import { type SceneContext } from './scene-setup.js';
import { type RunClockGuard } from './run-clock.js';

// The physics grid. FIXED_DT is the rate the invariant harness pins (1/60 s), so the
// kernel is byte-identical here to the headless suites. MAX_SUBSTEPS caps how many
// physics steps a single slow render frame may run (the spiral-of-death guard): at
// ~<8 FPS the game *slows down* rather than tunnelling — the same ~133 ms ceiling the
// old `Math.min(delta, 0.1)` clamp imposed, expressed as a step count instead.
export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 8;

// Apparent-wind normalization for the scarf (#253): the local-frame apparent wind is
// divided by this reference speed and clamped to [-1,1] before it reaches the cosmetic
// flex layer. ~16 ≈ a brisk run, so a strong gust or fast straight-line saturates the
// scarf stream without it ever exceeding its clamps.
const WIND_LOCAL_REF = 16;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Events that can fire on ANY substep within a render frame, reduced across the
 *  frame so a jump/land that completes mid-frame still drives its one-shot cosmetics
 *  (whoosh / thump / toast / shake). Reading only the LAST substep's result would
 *  silently drop a landing that happened in substep 2 of 3 (§5 of the plan). */
interface FrameEvents {
  justLanded: boolean;
  tookOff: boolean;                    // ground->air edge seen within the frame's substeps
  landingQuality: LandingQuality | null;
  landingForce: number;
  trickName: string | null;            // freestyle (#32): completed-trick label, Expert only
}

export interface MainLoopDeps extends
  Pick<SceneContext, 'state' | 'scene' | 'camera' | 'renderer' | 'cameraManager' |
    'directionalLight' | 'snowman' | 'snowSplash' | 'treePositions' | 'rockPositions'> {
  player: PlayerState;
  showGameOver: (reason: string) => void;
  // Paused-by-hide guard (run-clock.ts): while it reports paused, animate() skips
  // stepping and rendering so the frozen run clock can't be outrun by a throttled
  // background rAF. Optional (explicitly undefined under automation and in the unit
  // harnesses, which keeps their loop byte-identical).
  runClockGuard?: RunClockGuard | undefined;
}

export function createMainLoop(deps: MainLoopDeps) {
  const {
    state, scene, camera, renderer, cameraManager, directionalLight,
    snowman, snowSplash, treePositions, rockPositions,
    player, showGameOver, runClockGuard,
  } = deps;
  const pos = player.pos;
  const velocity = player.velocity;
  // Scratch reused each frame by the player-following sun shadow (#18), so re-aiming the
  // light allocates nothing per frame.
  const sunDirScratch = new THREE.Vector3();

  // Previous-substep air state, so we can fire a takeoff whoosh on the ground->air
  // transition (the kernel's UpdateResult exposes justLanded but no justJumped).
  // Tracked across substeps so a takeoff in any substep is seen.
  let prevInAir = false;
  // The latest per-step physics result, retained so a render frame that ran ZERO
  // substeps (a >60 Hz panel) can still repaint the HUD / advance cosmetics from the
  // last known state instead of going blank.
  let lastResult: UpdateResult | null = null;
  // Persistent render-interpolation window: the player position BEFORE (`interpPrev`)
  // and AFTER (`interpCur`) the most recent fixed step. They update ONLY when a step
  // runs, so on a no-step render frame (a >60 Hz panel) they hold their values while
  // `alpha` grows with the accumulator — the render advances smoothly from interpPrev
  // toward interpCur instead of freezing at the last step and jumping when the next
  // lands. Seeded to the spawn position by startLoop().
  const interpPrev = { x: 0, y: 0, z: 0 };
  const interpCur = { x: 0, y: 0, z: 0 };

  function newFrameEvents(): FrameEvents {
    return { justLanded: false, tookOff: false, landingQuality: null, landingForce: 0, trickName: null };
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
      ev.trickName = result.trickName;           // freestyle (#32): null outside an Expert trick landing
    }
    if (result.isInAir && !prevInAir) ev.tookOff = true;
    prevInAir = result.isInAir;
  }

  // --- Physics advance (one step) -----------------------------------------------
  // The kernel step: advances the player one step at `dt`. Shared by the live loop's
  // fixed substep and the legacy `updateSnowman(delta)` test seam. Diagnostics are NOT
  // recorded here — they are recorded once per RENDER frame (see recordDiag) so the FPS /
  // clamped-frame signal reflects the real device frame time, not the fixed 1/60 substep.
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
      bankAirScore: (points: number) => { if (CourseModule) CourseModule.addAirScore(points); },
      // Felt per-tier difficulty (D3): the run's ski tuning. Blue's ski === BLUE_PHYSICS_TUNING,
      // so a Blue run is byte-identical to the frozen baseline; Bunny/Black vary the handling.
      tuning: getDifficultyConfig(state.difficulty).ski
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
    // On the fixed grid so a fast render frame can't carry the player past a split gate
    // between samples; the split/ghost readouts still key off wall-clock elapsed.
    if (CourseModule) {
      const elapsed = (performance.now() - state.startTime) / 1000;
      CourseModule.update(pos, elapsed, snowman);
    }

    // (Avalanche burial is checked once per RENDER frame — after the player's substeps and
    // this frame's boulder advance, before hasPassed()/reset — so it still runs on a
    // no-step >60 Hz frame. See the avalanche block in animate().)
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
    // Keep the selected-tier badge in sync with the run's live difficulty (cheap:
    // only touches the DOM when the tier actually changes).
    updateLevelHud(state.difficulty);

    // Camera shake on a meaningful landing (scales with time spent aloft).
    if (ev.justLanded && ev.landingForce > 0.25 && EffectsModule) {
      EffectsModule.addShake(Math.min(1.2, ev.landingForce * 0.6));
    }

    // Meaningful jumps (#47): on a graded *manual*-jump landing, toast the air time +
    // grade — plus the completed trick's name on an Expert freestyle landing (#32).
    // landingQuality is non-null only for a player-initiated jump, so auto-jumps /
    // hop turns / coasting never toast. (The air score itself is banked inside the step.)
    if (ev.justLanded && ev.landingQuality && CourseModule) {
      CourseModule.flashAir(ev.landingQuality, ev.landingForce, ev.trickName);
    }

    // Apparent wind for the scarf (#253): the wind a moving snowman feels is
    // wind - velocity. Resolve it into the snowman's LOCAL frame (heading = rotation.y,
    // forward = (sin h, cos h), lateral = (cos h, -sin h)) and normalize, so the scarf
    // streams sideways in a crosswind and lifts fore/aft in a head/tail wind. Reads
    // Wind/velocity/rotation only — never writes pos/velocity.
    const wv = Wind.vector();
    const appX = wv.x - velocity.x;
    const appZ = wv.z - velocity.z;
    const h = snowman.rotation.y;
    const sinH = Math.sin(h), cosH = Math.cos(h);
    const windStream = clamp((appX * sinH + appZ * cosH) / WIND_LOCAL_REF, -1, 1); // forward
    const windSway = clamp((appX * cosH - appZ * sinH) / WIND_LOCAL_REF, -1, 1);   // sideways

    // Cosmetic flexibility / jiggle (issue #53). Purely visual: reads the per-frame
    // result, only writes child-mesh transforms — never pos/velocity.
    const flexSpeed = result.currentSpeed;
    Flex.update(snowman, frameDelta, {
      speed: flexSpeed,
      technique: result.technique,
      turnRate: flexSpeed > 1e-3 ? velocity.x / flexSpeed : 0, // zero-speed guard (no 0/0 NaN)
      justLanded: ev.justLanded,
      landingForce: ev.landingForce,
      isInAir: player.isInAir,
      windSway,
      windStream
    });

    // Sound effects (issue #158): a takeoff whoosh on the ground->air transition, a
    // touchdown thump scaled by air time, and the continuous wind + ski-edge bed. The wind
    // bed also reads the shared Wind field (#253 PR5) so a gusty slope hisses even at a
    // standstill. Wind.strength() returns this frame's cached normalized magnitude — the
    // SAME pre-Wind.update() sample the scarf reads above, so audio and the visible wind
    // agree on the same gust (Wind.update() advances the clock after these observers; the
    // one-frame lag is imperceptible and smoothed by the bed's ramp). Reads the per-frame
    // result/events + wind only — never pos/velocity — so the harness is unaffected, and
    // every call is a no-op until the SFX context is unlocked.
    if (ev.tookOff) Sfx.jump();
    if (ev.justLanded) Sfx.land(ev.landingForce);
    Sfx.updateSkiing(result.currentSpeed, result.technique, result.isInAir, Wind.strength());
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
    // One step == one record here, at the caller's real delta; let diagnostics derive the
    // step from the previous position (no fixed-substep split in this single-call path).
    recordDiag(delta, result);
    lastResult = result;
  }

  // Frame-rate / physics telemetry (diagnostics.ts). READ-ONLY observer: reads the result
  // + pos only and never touches pos/velocity, so the physics-invariant harness is
  // unaffected and it is a no-op under automation. `dt` is the REAL render-frame duration
  // (so the FPS-band / clamped-frame / runaway detection sees the true device rate), while
  // `stepOverride` — when given — is the max SUBSTEP displacement, so `tunnelRisk` reflects
  // the actual collision-time step (`v/60`) rather than the whole-frame displacement. The
  // loop records once per render frame; the single-step path omits stepOverride.
  function recordDiag(dt: number, result: UpdateResult, stepOverride?: number) {
    Diag.record({
      dt,
      speed: result.currentSpeed,
      x: pos.x,
      z: pos.z,
      technique: result.technique,
      isInAir: player.isInAir,
      ...(stepOverride !== undefined ? { step: stepOverride } : {}),
    });
  }

  // Scratch Euler reused when a freestyle spin is riding on the snowman's yaw (#32),
  // so handing the camera a corrected heading allocates nothing per frame.
  const cameraRotScratch = new THREE.Euler();

  // --- Update Camera: Follow the Snowman ---
  function updateCamera() {
    // Freestyle (#32): the trick spin is written onto the snowman's root rotation.y
    // (pose.ts) — the transform the follow camera also derives its orbit angle from,
    // so left alone the camera would whirl around the rider at the spin rate
    // (~360°/s) instead of staying behind the line of travel (codex review, PR #275).
    // pose.ts maintains `userData.trickCameraYaw` (radians): the spun yaw while
    // airborne, then — after a switch / under-rotated landing — the leftover residual,
    // eased out in lock-step with the heading recovery so the camera never snaps to
    // the spun side at touchdown (codex round 2). Adding it back recovers the
    // trick-free heading for the camera only; the model itself keeps spinning. Zero
    // on every non-trick frame, so this passes the snowman's own Euler through
    // untouched outside an Expert spin.
    const trickCameraYaw = (snowman.userData && (snowman.userData.trickCameraYaw as number)) || 0;
    if (trickCameraYaw !== 0) {
      cameraRotScratch.copy(snowman.rotation);
      cameraRotScratch.y = snowman.rotation.y + trickCameraYaw;
      cameraManager.update(snowman.position, cameraRotScratch, velocity, Snow.getTerrainHeight);
      return;
    }
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
  // Set once a frame throws an uncaught error: the loop hard-stops (no reschedule) and
  // the recovery overlay is shown, instead of spinning rAF and re-throwing on a frozen
  // frame forever. animate() reschedules at the TOP of the frame, so without this guard
  // a single bad frame (e.g. a stale-cache module skew after a deploy) freezes the
  // screen silently. Cleared only by a full page reload (the overlay's action).
  let loopFailed = false;

  // Stop the loop cleanly after a fatal per-frame error and offer a one-tap reload. The
  // overlay/log are best-effort and self-guarded so recovery can never re-throw into the
  // loop. A fatal loop error is almost always a bad module graph or a lost WebGL context,
  // neither of which the in-game restart fixes — hence a reload, not a restart.
  function onFatalLoopError(err: unknown): void {
    loopFailed = true;
    state.gameActive = false;
    state.animationRunning = false;
    try { console.error('[SnowGlider] Fatal animation-loop error — stopping the run:', err); } catch { /* */ }
    try { Diag.endRun(); } catch { /* telemetry must never block recovery */ }
    // The loop stops here, so nothing else will drive the continuous SFX gains (wind /
    // carve / avalanche bed) back down — they'd hold their last targets and keep droning
    // under the recovery overlay until reload. This shutdown path bypasses showGameOver(),
    // so end the run audio explicitly (Codex #262). Guarded: audio must never re-throw here.
    try { Sfx.endRun('crash'); } catch { /* audio teardown must never block recovery */ }
    // Sfx.endRun only silences the procedural Web Audio beds; the looping background
    // music (audio.ts) is separate and would keep playing under the recovery overlay.
    // showGameOver() normally pauses it via enableSound(false), so mirror that here
    // (Codex #262). Guarded: audio must never re-throw into recovery.
    try { if (AudioModule) AudioModule.enableSound(false); } catch { /* audio teardown must never block recovery */ }
    try { showFatalErrorOverlay(err); } catch { /* overlay must never re-throw into the loop */ }
  }

  function animate(time: number) {
    if (loopFailed) return; // a prior frame failed fatally; stay stopped until reload
    if (state.gameActive) {
      requestAnimationFrame(animate);
      // Paused-by-hide (run-clock.ts): the run clock is frozen while the document is
      // hidden, so physics must not advance either — a background tab whose rAF is
      // throttled (~1 fps) rather than stopped would otherwise bank up to
      // MAX_SUBSTEPS * FIXED_DT of physics per wall-second against a stopped timer.
      // Reset lastTime so the hidden span never enters the accumulator as frameDelta.
      // Boulders, wind, snow, and rendering all sit below this gate, so the whole
      // frame pauses coherently.
      if (runClockGuard) {
        if (runClockGuard.isPaused()) {
          lastTime = time;
          return;
        }
        // First frame after a resume: reseed the frame clock. On browsers that STOP
        // rAF while hidden (the common case) the paused branch above never ran, so
        // lastTime still points at the last PRE-HIDE frame — without this reseed the
        // resumed frame would run the ~133 ms capped backlog of physics against a
        // clock whose hidden interval was just shifted out, and repeated hide/resume
        // could farm that into free distance (codex review, PR #278).
        if (runClockGuard.consumeResumed()) {
          lastTime = time;
        }
      }
      try {
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

      // --- Avalanche advance (boulder physics) — BEFORE the substeps ------------
      // Advance the boulders FIRST (trigger + update), then the player substeps, then the
      // per-frame burial check + hasPassed()/reset + warning UI (after the physics core,
      // below) — so burial always tests this frame's boulder AND player positions before
      // the slide can deactivate. Boulder physics stays on the render delta (its own
      // frame-rate fix lives in avalanche.ts).
      const avalanche = state.avalanche;
      if (avalanche) {
        // Trigger based on distance traveled (player starts at z=-15, skis toward -Z).
        // Per-tier (D3.2d): `enabled` is false for Bunny (never fires); `triggerDistance` is
        // the active tier's arm distance (Black arms sooner than Blue). Both come from the
        // system's own fields, set from the tier's `avalanche` block in scene-setup.
        const distanceTraveled = state.lastAvalancheZ - pos.z;
        if (avalanche.enabled && !state.avalancheTriggered && distanceTraveled > avalanche.triggerDistance) {
          avalanche.trigger(snowman.position);
          state.avalancheTriggered = true;
          console.log("Avalanche triggered! Distance traveled:", distanceTraveled.toFixed(1));
        }
        // Update avalanche physics (boulder tumble advances on the render delta).
        avalanche.update(frameDelta);
      }

      // --- Fixed-step physics core ---------------------------------------------
      // Drain the accumulator in fixed 1/60 s steps. The interpolation window
      // (interpPrev -> interpCur) advances ONE step per substep and PERSISTS across
      // frames, so the render lerps between the last two physics states by `alpha`. A
      // render rate that doesn't divide 60 evenly (144 Hz, 50 Hz) or a no-step frame
      // therefore reads a smoothly-advancing position, not an aliased/frozen one.
      // Physics state stays authoritative on the grid.
      accumulator += frameDelta;
      const ev = newFrameEvents();
      let result = lastResult;
      let substeps = 0;
      let maxSubstepStep = 0; // largest single-substep planar move = the collision-time step
      while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS && state.gameActive) {
        // Shift the window: the prior step's end (interpCur) becomes this step's start.
        interpPrev.x = interpCur.x; interpPrev.y = interpCur.y; interpPrev.z = interpCur.z;
        result = stepFixed(FIXED_DT);
        interpCur.x = pos.x; interpCur.y = pos.y; interpCur.z = pos.z; // this step's end
        const substepStep = Math.hypot(interpCur.x - interpPrev.x, interpCur.z - interpPrev.z);
        if (substepStep > maxSubstepStep) maxSubstepStep = substepStep;
        aggregateEvents(ev, result);
        accumulator -= FIXED_DT;
        substeps++;
      }
      // Spiral-of-death guard: if we hit the substep ceiling with time still owed, drop
      // the surplus (the game slows down rather than tunnelling) and keep alpha in [0,1).
      if (substeps >= MAX_SUBSTEPS && accumulator >= FIXED_DT) accumulator = 0;
      const alpha = accumulator / FIXED_DT;
      if (result) lastResult = result;

      // Per-render-frame observers + telemetry — once per frame on the REAL delta.
      // `result` is null only before the very first physics step has ever run; on a
      // no-step (>60 Hz) frame it is the retained last result, so the FPS/clamped signal
      // is still recorded for that render frame (maxSubstepStep stays 0 → no tunnel flag).
      if (result) {
        renderObservers(frameDelta, result, ev);
        recordDiag(frameDelta, result, maxSubstepStep);
      }

      // Advance the shared wind field (issue #253). Deterministic and cosmetic-only —
      // every wind consumer (snow drift, scarf, tree sway, audio bed) reads this one
      // clock-advanced sample, so they all agree on the same gust at the same instant.
      Wind.update(frameDelta);
      // Push the wind into the instanced forest's vertex sway (GPU; a few uniform writes).
      Snow.updateTreeWind(frameDelta);
      // Drive the wind "howl" (#253): a resonant whistle that swells with the field's
      // strength and sweeps its pitch with each gust. Reads the freshly-advanced sample
      // (audio can lag a frame imperceptibly, unlike the scarf which reads the pre-update
      // sample); a no-op until the SFX context is unlocked and silent on a calm slope.
      Sfx.updateWindHowl(Wind.strength(), Wind.gust());

      Snow.updateSnowflakes(frameDelta, pos, scene);

      // Dynamic ski trails / snow accumulation (#17): carve fading grooves behind the
      // skis that fresh snow covers back over. Purely cosmetic — reads position only.
      state.snowTrails?.update(frameDelta, snowman, player.isInAir);

      // Advance the golden-hour<->midday sun cycle (sun position/colour, sky exposure,
      // fog). Purely atmospheric; a no-op under reduced motion. (#163)
      Sky.update(frameDelta);

      // --- Avalanche burial + survival check + warning UI -----------------------
      // Burial is checked ONCE PER RENDER FRAME here — after the player's substeps and
      // after this frame's avalanche.update (above) — and BEFORE hasPassed()/reset. So a
      // boulder overlapping the player is always tested before the slide can deactivate,
      // including on a no-step (>60 Hz) frame where the substep loop didn't run. Per-frame
      // is sufficient: bounded speed × the broad 120-boulder slide means the player can't
      // traverse a boulder between frames, so the final-position check can't miss one.
      // checkBurial() self-guards when inactive.
      if (avalanche) {
        if (avalanche.checkBurial(snowman.position)) {
          const activeShowGameOver = typeof window.showGameOver === 'function'
            ? window.showGameOver
            : showGameOver;
          activeShowGameOver("Buried by avalanche!");
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
      Snow.updateSnowSplash(snowSplash, frameDelta, snowman, velocity, player.isInAir, scene);

      // Ensure snowman position wasn't affected by particles
      snowman.position.set(playerPosBefore.x, playerPosBefore.y, playerPosBefore.z);

      // --- Render at the interpolated position --------------------------------
      // Render the snowman/camera at lerp(interpPrev, interpCur, alpha) — the persistent
      // last-two-step window — to remove temporal aliasing on non-60 panels, then restore
      // the authoritative physics position so the camera manager's own smoothing and the
      // next frame stay clean. (Up to ~1 fixed step of visual latency; acceptable for this
      // game — see §7 of the plan.)
      const renderX = interpPrev.x + (interpCur.x - interpPrev.x) * alpha;
      const renderY = interpPrev.y + (interpCur.y - interpPrev.y) * alpha;
      const renderZ = interpPrev.z + (interpCur.z - interpPrev.z) * alpha;
      snowman.position.set(renderX, renderY, renderZ);

      // Player-following sun shadow (#18): re-aim the directional light + its target at the
      // interpolated render position (above) so the snowman and nearby obstacles cast a
      // contact shadow across the whole descent, instead of sitting outside the default ±5
      // shadow box. Runs on the render pose, before renderer.render below; the sun-cycle's
      // direction (sky.ts) is preserved — only the light→target pair is offset to the player.
      Sky.getSunDirection(sunDirScratch);
      aimSunLight(directionalLight, sunDirScratch, Sky.getSunDistance(), renderX, renderY, renderZ);

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
      } catch (err) {
        // A frame threw: stop cleanly and show the reload prompt instead of freezing.
        onFatalLoopError(err);
      }
    } else if (state.animationRunning) {
      state.animationRunning = false;
    }
  }

  // Reset the loop's per-run carry-over to the (already-reset) spawn state: drop the
  // accumulator, clear the last result + air edge, and reseed the interpolation window to
  // the current player position. MUST run after the player has been teleported to spawn.
  // Called by startLoop AND by the lifecycle's resetSnowman — the in-game Reset button
  // keeps the loop running (no startLoop), so without this the stale pre-reset position
  // would leak into the render lerp (a visible camera/snowman jump) and into the first
  // diagnostics step (a huge maxSubstepStep false tunnel-risk sample). Idempotent.
  function resetLoopState() {
    accumulator = 0;
    lastResult = null;
    prevInAir = false;
    interpPrev.x = interpCur.x = pos.x;
    interpPrev.y = interpCur.y = pos.y;
    interpPrev.z = interpCur.z = pos.z;
    // Restart each run from the same deterministic point in the gust cycle (#253).
    Wind.reset();
    Snow.resetTreeWind();
  }

  // Seed the frame clock and kick the loop. Replaces the lifecycle sites' previous
  // `lastTime = performance.now(); animate(lastTime)` so the first delta stays ~0 while
  // `lastTime`/`accumulator` remain private to the loop. resetLoopState() clears the
  // per-run carry-over so a restart doesn't render one stale frame from the previous run.
  function startLoop() {
    lastTime = performance.now();
    resetLoopState();
    animate(lastTime);
  }

  // --- Handle Window Resize ---
  function handleResize() {
    cameraManager.handleResize();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  return { updateSnowman, updateCamera, animate, startLoop, resetLoopState, handleResize };
}
