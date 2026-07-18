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
import { Trees } from '../trees.js';
import { Sky } from '../sky.js';
import { aimSunLight, compensateShadowBiasForElevation } from './sun-shadow.js';
import { Wind } from '../wind.js';
import { TreeShed, forestProximityAt } from '../tree-shed.js';
import { Snowman, type UpdateResult, type LandingQuality } from '../snowman.js';
import { Flex } from '../snowman-flex.js';
import { Expression } from '../snowman-expression.js';
import { CourseModule } from '../course.js';
import { AudioModule } from '../audio.js';
import { Sfx } from '../sfx.js';
import { Diag } from '../diagnostics.js';
import { EffectsModule, type ShakeOffset } from '../effects.js';
import { Physics, type PlayerState } from '../player-state.js';
import { resolveBurialOutcome } from '../avalanche.js';
import { comboMultiplier, comboLabel, nextComboStep } from './combo.js';
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

// Total wall-clock seconds of dropped (stall-guarded) physics time a run may absorb
// and still count as ranked. Generous for real machines — a healthy run drops zero;
// an occasional GC hiccup drops tens of milliseconds — but a sustained slow-motion
// stall (the exploit: throttle the tab, gain reaction time against a slowed clock)
// crosses it within a couple of seconds of wall time (#403 review).
export const DROPPED_TIME_RANKED_LIMIT = 0.25;

// Apparent-wind normalization for the scarf (#253): the local-frame apparent wind is
// divided by this reference speed and clamped to [-1,1] before it reaches the cosmetic
// flex layer. ~16 ≈ a brisk run, so a strong gust or fast straight-line saturates the
// scarf stream without it ever exceeding its clamps.
const WIND_LOCAL_REF = 16;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// Avalanche-dodge window (JP-3 — the #47 headline). A deliberate jump carrying the
// player over the slide front survives it: the burial overlap is immune while the
// playerJump air phase lasts, and the FIRST dodging frame of a slide banks the bonus
// and kicks a small forward escape impulse (adopted §10.2: immunity + impulse) so a
// stomped dodge can outrun the front after touchdown. Loop-side only — the kernel
// never sees any of this (#245); provenance/once-per-slide guards live in
// resolveBurialOutcome (avalanche.ts, headlessly pinned). Mirrored in PHYSICS.md §10.
//
// Timing note (Codex review on #289): burial resolves AFTER the frame's physics
// substeps, so a jump pressed on the very frame the overlap begins is already
// airborne (playerJump stamped) when it's resolved — a frame-perfect leap as the
// front arrives counts as a dodge. That is DELIBERATE (the heroic last-instant
// escape is the #47 fantasy) and it cannot be farmed: if the overlap began on any
// EARLIER grounded frame, that frame's check already buried the player; a bunny-hop
// spends ≥0.3 s grounded (the landing cooldown) inside the front between hops; and
// the award pays once per slide.
const DODGE_SCORE = 250;        // air-score points banked once per dodged slide
const DODGE_ESCAPE_BOOST = 1.10; // one-shot horizontal velocity factor on the award frame

// Stand-in collider list while the async EZ forest build is in flight (issue #282):
// the tree meshes aren't visible yet, so the kernel must not collide against their
// positions. One shared frozen instance — the swap allocates nothing per step.
const NO_TREE_COLLIDERS: SceneContext['treePositions'] = [];

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
  obstacleCleared: 'tree' | 'rock' | null; // scored clear (JP-2): last cleared type this frame
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
  // Style/combo chain (JP-7): consecutive CLEAN landings / clears / dodges build a
  // multiplier on every point banked into the air score. Loop-side only (no kernel
  // state, per #245): the bankAirScore callback below multiplies by the CURRENT
  // step, and aggregateEvents advances the step from each substep's result AFTER
  // its banking ran — so an event's points ride the chain built BEFORE it. Reset
  // per run in resetLoopState; a SKETCHY/wipeout landing breaks it (combo.ts).
  let comboStep = 0;
  // THE simulation clock (#402): seconds of ACCUMULATED FIXED STEPS this run.
  // Course/split/ghost timing keys off this — not performance.now — so ranked
  // time can no longer advance while physics time is being dropped (the
  // MAX_SUBSTEPS spiral guard discards surplus accumulator time on a stall: the
  // game slows down, and now the clock slows down WITH it), and a hidden-tab
  // pause freezes it naturally (no substeps run). Wall clock remains only for
  // the cosmetic HUD readout (updateTimerDisplay) and analytics.
  let simTime = 0;
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
    return { justLanded: false, tookOff: false, landingQuality: null, landingForce: 0, trickName: null, obstacleCleared: null };
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
    // Scored clear (JP-2): a one-shot cue like the landing — reduce across substeps
    // so a clear on substep 1 of 3 still toasts. (The points bank in-kernel.)
    if (result.obstacleCleared) ev.obstacleCleared = result.obstacleCleared;
    // Style/combo chain (JP-7): advance AFTER this substep's banking already ran —
    // a clear/CLEAN builds the chain for the NEXT banked points; an OK landing
    // holds it; SKETCHY/wipeout breaks it. Order matters within the substep: the
    // clear (mid-air) advances before the landing verdict settles the chain.
    // Advance once per BANKED clear (obstaclesClearedCount) — a dense row can score
    // several clears in one step, each banking CLEAR_SCORE, and the chain must
    // reflect every one of them for the next award (Codex on #293). All clears
    // within the step bank at the step's entry multiplier; the chain catches up here.
    for (let i = 0; i < result.obstaclesClearedCount; i++) {
      comboStep = nextComboStep(comboStep, 'clear');
    }
    if (result.justLanded && result.landingQuality) {
      comboStep = nextComboStep(comboStep,
        result.landingQuality === 'clean' ? 'clean'
          : result.landingQuality === 'ok' ? 'ok'
          : result.landingQuality); // 'sketchy' | 'wipeout' both break
    }
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
      // Trees collide only once they are visible: the EZ evergreen forest (issue
      // #282) appends its meshes asynchronously after the archetype chunk loads,
      // and until then (or after a failed load rebuilds the stylized fallback) a
      // run must not crash into invisible obstacles. The stylized path builds
      // synchronously, so this gate is always open outside the EZ flag.
      treePositions: Trees.treeCollidersReady() ? treePositions : NO_TREE_COLLIDERS,
      rockPositions,
      gameActive: state.gameActive,
      showGameOver: activeShowGameOver,
      // Meaningful jumps (#47): bank a manual jump's air score from inside the step,
      // before its synchronous finish check can build the result screen — so a jump
      // landed on the finish frame still counts (see Snowman.updateSnowman).
      // JP-7: the combo chain multiplies every banked point (landing deltas AND
      // scored clears both route through here). Rounded so the score stays integral.
      bankAirScore: (points: number) => {
        if (CourseModule) CourseModule.addAirScore(Math.round(points * comboMultiplier(comboStep)));
      },
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
    // --- Avalanche trigger + boulder physics: ON THE FIXED GRID (#402) ---------
    // Boulders advance in the same 1/60 substeps as the player (boulders first,
    // then the player — the same within-frame order the old per-render-frame
    // advance had), so player/boulder RELATIVE motion no longer varies with the
    // render rate, and the live slide finally matches the winnability harness,
    // which always stepped the avalanche at a fixed 1/60. The trigger's
    // distance check moves with it, so arming can't skew by frame timing.
    // Powder cosmetics stay on the render frame (see animate()).
    const avalanche = state.avalanche;
    if (avalanche) {
      const distanceTraveled = state.lastAvalancheZ - pos.z;
      if (avalanche.enabled && !state.avalancheTriggered && distanceTraveled > avalanche.triggerDistance) {
        avalanche.trigger(snowman.position);
        state.avalancheTriggered = true;
        console.log("Avalanche triggered! Distance traveled:", distanceTraveled.toFixed(1));
      }
      avalanche.updatePhysics(dt);
    }

    // --- The simulation clock (#402) -----------------------------------------
    // Advance and PUBLISH the clock BEFORE executing the step: the step being
    // run occupies (simTime, simTime + dt], and the kernel can end the run
    // SYNCHRONOUSLY inside stepPhysics (crossing FINISH_Z calls showGameOver,
    // whose finishTime reads state.simElapsed) — stamping afterwards would
    // record the finishing run one substep (1/60 s) short. Dropped accumulator
    // time (the spiral guard) and hidden-tab pauses simply don't advance it.
    simTime += dt;
    state.simElapsed = simTime;

    const result = stepPhysics(dt);

    // --- Course progress: split timing, progress HUD, ghost racing ---
    // On the fixed grid so a fast render frame can't carry the player past a split
    // gate between samples. Splits, the ghost, and the FINAL COURSE TIME key off
    // the simulation clock (#402): sim time == wall time on a healthy run, but a
    // stall that drops physics time no longer inflates the ranked time (and a
    // ranked run can no longer bank wall-clock while frozen).
    if (CourseModule) {
      CourseModule.update(pos, simTime, snowman);
    }

    // --- Avalanche OUTCOME resolution: ON THE FIXED GRID (#403 review) --------
    // Burial, the dodge window, hasPassed()/reset and the re-arm all resolve here,
    // per substep, against the kernel `pos` this step just produced — not once per
    // render frame against the (render-interpolated, one-frame-lagged) mesh
    // position. At low frame rates multiple substeps can no longer pass between
    // collision decisions, so survival outcomes are the same at every render rate
    // given the same boulder/player trajectories. The `state.gameActive` guard
    // enforces EXACTLY ONE terminal event: if this substep's kernel step already
    // ended the run (tree/rock crash or finish — showGameOver runs synchronously
    // inside stepPhysics), burial cannot fire afterwards and replace the
    // already-built result; and once any terminal event fires, the substep loop
    // itself stops. Only the powder cosmetics, warning UI and audio remain on the
    // render frame (see animate()).
    if (avalanche && state.gameActive) {
      // Avalanche-dodge window (JP-3, #47): an overlap only buries the player when
      // they are NOT airborne on a deliberate jump. resolveBurialOutcome holds the
      // provenance / once-per-slide guards; the kernel is never involved (#245).
      const burialOutcome = resolveBurialOutcome(
        avalanche.checkBurial(pos),
        player.isInAir,
        !!(snowman.userData && snowman.userData.playerJump),
        state.dodgeAwarded
      );
      if (burialOutcome === 'buried') {
        const activeShowGameOver = typeof window.showGameOver === 'function'
          ? window.showGameOver
          : showGameOver;
        activeShowGameOver("Buried by avalanche!");
      } else if (burialOutcome === 'dodgedFirst') {
        // First dodging substep of this slide: bank the bonus (same air-score
        // channel the result screen reads), toast it, and kick the escape impulse
        // so a stomped landing can outrun the front. Later overlap substeps of the
        // same jump resolve to 'dodged' (immune, no re-award). The enclosing
        // gameActive guard keeps a finish-frame dodge from mutating a result the
        // kernel already built (Codex review on #289).
        state.dodgeAwarded = true;
        if (CourseModule) {
          // JP-7: the dodge banks through the chain like everything else (its own
          // points ride the multiplier built before it), then builds the chain.
          CourseModule.addAirScore(Math.round(DODGE_SCORE * comboMultiplier(comboStep)));
          CourseModule.flashDodge();
        }
        comboStep = nextComboStep(comboStep, 'dodge');
        velocity.x *= DODGE_ESCAPE_BOOST;
        velocity.z *= DODGE_ESCAPE_BOOST;
      }

      // Reset avalanche if it has passed the player (survived!) — on the same
      // grid, AFTER this substep's burial test, so a boulder overlapping the
      // player is always tested before the slide can deactivate. Re-checks
      // gameActive: if THIS substep's burial (or a kernel crash/finish) just
      // ended the run, the passed/re-arm transition must not fire after the
      // terminal event and clear the very slide that ended the run.
      if (state.gameActive && state.avalancheTriggered && avalanche.hasPassed(pos)) {
        console.log("Avalanche passed - player survived!");
        avalanche.reset();
        state.avalancheTriggered = false;
        state.lastAvalancheZ = pos.z; // Reset trigger point for potential next avalanche
        state.dodgeAwarded = false;   // the next slide re-arms the once-per-slide bonus
      }
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
    // Scored obstacle clear (JP-2): toast the mid-air reward cue. Dispatched BEFORE
    // the landing toast so if one frame carries both (clear in an early substep,
    // landing in a later one) the graded landing — the richer, terminal cue — wins
    // the shared flash element. The points were already banked in-kernel.
    if (ev.obstacleCleared && CourseModule) {
      CourseModule.flashClear(ev.obstacleCleared);
    }

    // 'wipeout' (JP-4) is excluded: that landing ended the run through the crash
    // path (showGameOver + shatter) — the game-over overlay is the feedback, and
    // flashAir only speaks the ride-away grades. JP-7: the toast carries the live
    // combo label ("✈ AIR 1.2s · 360 · CLEAN ×1.56") — comboStep has already been
    // advanced by this landing (aggregateEvents), so the label shows the chain the
    // landing just built (empty at ×1).
    if (ev.justLanded && ev.landingQuality && ev.landingQuality !== 'wipeout' && CourseModule) {
      CourseModule.flashAir(ev.landingQuality, ev.landingForce, ev.trickName, comboLabel(comboStep));
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
      // Takeoff anticipation (JP-5): only a DELIBERATE jump's launch frame dips the
      // body (playerJump provenance, still true while its air phase lasts) — an
      // auto-jump lip pop keeps today's un-anticipated launch.
      tookOff: ev.tookOff && !!(snowman.userData && snowman.userData.playerJump),
      windSway,
      windStream
    });

    // Cosmetic facial expression + body acting (issue #364). Same render-observer
    // contract as Flex: reads the per-frame result + this frame's aggregated events only,
    // writes ONLY the face/arm/hat/nose child transforms (a set disjoint from Flex) —
    // never pos/velocity. Runs right after Flex.update so it composes on top of this
    // frame's head squash. The event signals (landing grade / trick / obstacle clear)
    // come from `ev` (aggregated across the frame's substeps, so a mid-frame landing
    // isn't dropped); the avalanche distance is the closest active-slide boulder, read
    // from the avalanche system only (never pos/velocity), mirroring updateCamera.
    let exprAvalancheDist = Infinity;
    const avForExpr = state.avalanche;
    if (avForExpr && state.avalancheTriggered && avForExpr.active) {
      exprAvalancheDist = avForExpr.getClosestDistance(snowman.position);
    }
    Expression.update(snowman, frameDelta, {
      speed: flexSpeed,
      technique: result.technique,
      turnRate: flexSpeed > 1e-3 ? velocity.x / flexSpeed : 0, // zero-speed guard (no 0/0 NaN)
      isInAir: player.isInAir,
      justLanded: ev.justLanded,
      landingQuality: ev.landingQuality,
      obstacleCleared: ev.obstacleCleared,
      trickName: ev.trickName,
      avalancheDistance: exprAvalancheDist,
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
    // Grade-keyed touchdown (JP-5): a graded manual-jump landing colors the thump
    // (CLEAN ping / SKETCHY skid-wash); null (auto-jump/hop) keeps the plain thump.
    if (ev.justLanded) Sfx.land(ev.landingForce, ev.landingQuality);
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
    // Advance the PUBLISHED sim clock for this legacy fixed-step seam too (#402):
    // the kernel can end the run synchronously inside this step (FINISH_Z calls
    // showGameOver, whose finishTime reads state.simElapsed), so a harness that
    // drives a whole run through repeated updateSnowman(...) must accumulate a
    // real elapsed — not finish at 0 s and be discarded as implausible. ADDITIVE
    // on state.simElapsed (never overwritten from the live loop's private
    // simTime): a harness that pre-set the clock through the startTime/simElapsed
    // window seam keeps its offset, and the live rAF loop — which never calls
    // this — keeps its own accumulator authority.
    state.simElapsed += delta;

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
  // `frameDt` is the render-frame delta in seconds. The camera uses it only to dt-scale the
  // cameraman-mode eases so their convergence is frame-rate independent (codex, PR #379);
  // it never feeds physics.
  function updateCamera(frameDt: number) {
    // Cosmetic-only situational signals for Auto framing (issue #305, P3+): a jump and
    // how close an avalanche is. Reads the loop's air flag + the avalanche system only
    // (never pos/velocity), so the deterministic sim is untouched. Terrain steepness,
    // turn rate and screen aspect the camera derives itself.
    const avalanche = state.avalanche;
    let avalancheDistance = Infinity;
    if (avalanche && state.avalancheTriggered && avalanche.active) {
      avalancheDistance = avalanche.getClosestDistance(snowman.position);
    }
    const cameraContext = { isInAir: player.isInAir, avalancheDistance, frameDt };
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
      cameraManager.update(snowman.position, cameraRotScratch, velocity, Snow.getTerrainHeight, cameraContext);
      return;
    }
    // Simply delegate to the camera manager
    cameraManager.update(
      snowman.position,
      snowman.rotation,
      velocity,
      Snow.getTerrainHeight,
      cameraContext
    );
  }

  // --- Animation Loop (fixed-timestep accumulator) ---
  let lastTime = 0;
  let accumulator = 0;
  // Wall-clock seconds of THIS RUN's physics time discarded by the stall guards
  // (the frame-delta ceiling + the spiral-guard accumulator drop). Dropping time
  // is the right anti-tunnel behavior, but it slows the SIM relative to real
  // time — a stall-heavy (or artificially stalled) run plays in slow motion
  // while paying a proportionally small ranked clock, which is free reaction
  // time. Past DROPPED_TIME_RANKED_LIMIT the run is flagged timing-compromised:
  // it still finishes and shows its time, but records nothing competitive
  // (#403 review: ranked integrity). Hidden-tab pauses do NOT count — the run
  // clock guard freezes sim AND timer together there, so no advantage exists.
  let droppedSimTime = 0;
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
      const rawDelta = (time - lastTime) / 1000;
      const frameDelta = Math.min(rawDelta, MAX_SUBSTEPS * FIXED_DT);
      if (rawDelta > frameDelta) droppedSimTime += rawDelta - frameDelta;
      lastTime = time;

      // Only set up test hooks if they're missing
      if (!window.testHooks) {
        console.log("Test hooks missing in animation loop, reinstalling");
        // addTestHooks(pos, showGameOver, getTerrainHeight) — matches the two other
        // call sites; the stray `gameActive` arg here was a latent bug (it landed in
        // the getTerrainHeight slot), surfaced by the type-checker.
        Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
      }

      // --- Avalanche powder cosmetics — render frame only (#402) ----------------
      // The gameplay half (trigger, boulder physics, AND the burial/dodge/
      // passed outcomes) lives in stepFixed's 1/60 substeps, so a run's slide is
      // frame-rate independent; only the render-only powder cloud stays on the
      // render delta (its 60 Hz-referenced emission accumulator keeps the
      // budget-per-second rate-independent, #400).
      const avalanche = state.avalanche;
      if (avalanche) {
        avalanche.updateCosmetics(frameDelta);
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
      if (substeps >= MAX_SUBSTEPS && accumulator >= FIXED_DT) {
        droppedSimTime += accumulator;
        accumulator = 0;
      }
      // Ranked-integrity flag (#403 review): enough dropped time means this run's sim
      // clock ran materially slower than wall time (slow-motion reaction advantage) —
      // flag it once; the finish path reads the flag and declines to rank the run.
      if (!state.timingCompromised && droppedSimTime > DROPPED_TIME_RANKED_LIMIT) {
        state.timingCompromised = true;
      }
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
      // Dynamic snow load (#253 Phase B): a strong gust dumps the snow off the most
      // laden trees near the player — a powder puff bursts, the shelves shrink, the
      // branches spring back — and each shed is voiced by its distance. The collider-
      // gated tree list keeps an in-flight EZ forest build (invisible trees) from
      // shedding. Cosmetic-only: loads drive shader attributes + sprites, never physics.
      const shedTrees = Trees.treeCollidersReady() ? treePositions : NO_TREE_COLLIDERS;
      for (const shed of TreeShed.update(frameDelta, snowman.position, shedTrees, scene)) {
        Sfx.treeShed(shed.distance);
      }
      // The needle-rustle bed: wind moving through the trees AROUND the player.
      Sfx.updateForest(Wind.strength(), Wind.gust(), forestProximityAt(shedTrees, pos.x, pos.z));

      Snow.updateSnowflakes(frameDelta, pos, scene);

      // Dynamic ski trails / snow accumulation (#17): carve fading grooves behind the
      // skis that fresh snow covers back over. Purely cosmetic — reads position only.
      state.snowTrails?.update(frameDelta, snowman, player.isInAir);

      // Persistent snow-depth field (#246, PR 2): the skis pack the snow into lasting ski
      // lines that fresh snow slowly refills — driven off the same grounded/moving trigger
      // as the ski trails above. Purely cosmetic data: reads position + horizontal speed
      // only, never writes physics; not yet rendered (a later PR samples it in the shader).
      const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
      state.snowDepth?.update(frameDelta, snowman.position, player.isInAir, horizontalSpeed);

      // Advance the golden-hour<->midday sun cycle (sun position/colour, sky exposure,
      // fog). Purely atmospheric; a no-op under reduced motion. (#163)
      Sky.update(frameDelta);

      // Background scenery (#320): cosmetic-only tick in the render-frame zone (NOT the
      // fixed physics substep). Reads the render delta, the player position, and the
      // shared wind signals; never writes pos/velocity/treePositions/rockPositions/
      // terrain/course state. A no-op until later PRs add animated layers.
      state.scenery?.update(frameDelta, snowman.position, {
        windStrength: Wind.strength(),
        windGust: Wind.gust(),
      });

      // --- Avalanche warning UI + audio — render frame only (#403 review) -------
      // Every GAMEPLAY decision (burial, dodge, hasPassed/reset/re-arm) resolves
      // per fixed substep inside stepFixed; this render-side block only telegraphs
      // the threat off the render-facing mesh position.
      if (avalanche && EffectsModule) {
        const avActive = state.avalancheTriggered && avalanche.active;
        const avDist = avActive ? avalanche.getClosestDistance(snowman.position) : Infinity;
        EffectsModule.updateAvalanche(avActive, avDist);
        // Avalanche rumble crescendos with the same proximity the banner uses (#158).
        Sfx.setAvalanche(avActive, avDist);
      }

      // Save player position before snow splash effect updates
      const playerPosBefore = {
        x: snowman.position.x,
        y: snowman.position.y,
        z: snowman.position.z
      };

      // Update snow splash particles - pass all required parameters.
      // Touchdown burst by grade (JP-5): a graded manual-jump landing kicks a one-shot
      // radial puff — CLEAN a crisp small one, SKETCHY a wide skidding wash (a wipeout
      // gets nothing here; the #171 shatter debris owns that crash). 0 on every other
      // frame, so the splash call is byte-identical outside a graded landing.
      const landingBurst = ev.justLanded && ev.landingQuality && ev.landingQuality !== 'wipeout'
        ? (ev.landingQuality === 'sketchy' ? 1.0 : ev.landingQuality === 'ok' ? 0.55 : 0.35)
        : 0;
      Snow.updateSnowSplash(snowSplash, frameDelta, snowman, velocity, player.isInAir, scene, landingBurst);

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
      // Low-sun shadow stability (NS2): the ortho frustum's ground footprint stretches
      // ~1/sin(elev) along the sun axis as the cycle drops the sun toward the 8° guard,
      // so scale the shadow normal bias on that curve (clamped) to keep acne off the
      // mogul field. Exactly the tuned constant at midday. See game/sun-shadow.ts.
      compensateShadowBiasForElevation(directionalLight, sunDirScratch.y, Sky.getMiddaySunElevationSin());

      updateCamera(frameDelta);
      updateTimerDisplay(state.gameActive, state.simElapsed); // HUD shows the SIM clock (#402) — matches the recorded finish time

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
    simTime = 0; // a new run starts its simulation clock (#402) from zero
    state.simElapsed = 0;
    droppedSimTime = 0;
    state.timingCompromised = false; // each run earns (or loses) ranked status fresh
    lastResult = null;
    prevInAir = false;
    comboStep = 0; // a new run starts its style chain from ×1 (JP-7)
    interpPrev.x = interpCur.x = pos.x;
    interpPrev.y = interpCur.y = pos.y;
    interpPrev.z = interpCur.z = pos.z;
    // Restart each run from the same deterministic point in the gust cycle (#253).
    Wind.reset();
    Snow.resetTreeWind();
    // Re-laden every shed tree and clear in-flight puffs so each run starts from the
    // same forest state the deterministic gust cycle expects.
    TreeShed.reset();
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
