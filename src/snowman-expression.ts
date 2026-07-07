// snowman-expression.ts — cosmetic facial-expression layer (issue #364).
//
// A sibling of snowman-flex.ts, kept SEPARATE so flex (breathing / squash / head-bob /
// ski camber) and emotion + body acting (mouth / brows / eyes / arms / hat / nose) stay
// cleanly decoupled. Like flex it is purely visual: it reads the per-frame motion the
// physics kernel already produced (speed / technique / turn / air) and writes ONLY
// child-mesh transforms on the FACE parts the face rig registered (src/snowman/face.ts)
// plus the arm groups / hat pieces / nose — a part-set DISJOINT from flex (flex never
// touches the mouth/brows/eyes/pupils/cheeks/arms/hat/nose) AND from pose.ts (which owns
// only the ski ROOTS + the root yaw), so the layers compose without fighting. It NEVER
// touches pos/velocity or anything the kernel owns, so the physics-invariant harness and
// the frozen baseline stay byte-identical.
//
// The face parts are parented under the head mesh, which flex squash-stretches every
// frame, so the whole face rides (and gently deforms with) the moving head surface;
// this layer writes each face part's LOCAL transform, composed on top of that squash.
//
// DETERMINISM: every oscillation (blink, micro-motion) is driven off an internal time
// accumulator advanced by dt — never Math.random and never wall-clock — so the sim is
// byte-identical and the animation is frame-rate independent (all easing is dt-scaled).
//
// The orchestrator calls Expression.update(...) once per frame AFTER Flex.update (see
// game/main-loop.ts) and Expression.reset(...) on every run reset (see game/lifecycle.ts).
//
// THREE is imported type-only so this module has no runtime dependency on three and stays
// trivially testable headless with plain `{position,scale,rotation,userData}` stand-ins.
import type * as THREE from 'three';

/** The per-frame motion the expression layer reads. `technique` is the SkiTechnique
 *  string; `turnRate` is the caller's ZERO-SPEED-GUARDED steering signal (the same one
 *  flex reads), so a 0/0 first frame can never feed a NaN into the transforms. Event
 *  signals (landing grade, tricks, avalanche) arrive in a later PR as OPTIONAL fields,
 *  so every field here is a steady-state technique/motion cue. */
export interface ExpressionMotion {
  speed: number;
  technique: string;
  turnRate: number;
  isInAir: boolean;
  // --- Event signals (issue #364 PR 4) — all OPTIONAL, absent => no reaction, so every
  //     PR 2/PR 3 caller/test stays byte-identical. Edge events (justLanded / trickName /
  //     obstacleCleared) kick a short-lived reaction; level signals (avalancheDistance /
  //     finished) drive a reaction while they hold. ---
  /** A landing completed THIS frame (aggregated across the frame's substeps by the loop). */
  justLanded?: boolean;
  /** How that landing graded: 'clean' | 'ok' | 'sketchy' | 'wipeout' | null. 'wipeout'
   *  ends the run (crash), so it drives no face reaction. */
  landingQuality?: string | null;
  /** A scored obstacle clear this frame ('tree' | 'rock'), or null. */
  obstacleCleared?: 'tree' | 'rock' | null;
  /** The completed freestyle trick's label this frame (Expert tier), or null. */
  trickName?: string | null;
  /** Closest active-avalanche distance; small => panic. Infinity/absent => no threat. */
  avalancheDistance?: number;
  /** The run finished this frame — celebration (reserved: the loop currently stops the
   *  render observers on finish, so this is a forward-compatible hook, defaulting false). */
  finished?: boolean;
}

interface XYZ { x: number; y: number; z: number; }
interface BaseTransform { position: XYZ; scale: XYZ; rotation: XYZ; }

/** Eased expression channels + the blink/micro-motion clock. All neutral at rest, so a
 *  fresh state renders the shipped relaxed-smile face. */
interface ExprState {
  t: number;          // time accumulator (blink + micro-motion), seconds
  blink: number;      // countdown to the next blink; negative = mid-blink
  curve: number;      // mouth smile(+)/frown(-), eased  [-1..1]
  open: number;       // mouth jaw-open (O),        eased  [0..1]
  brow: number;       // brow raise(+ surprise)/lower(- focus), eased [-1..1]
  eye: number;        // eye openness from technique (squint<1),eased [0..1]
  look: number;       // pupil shift toward the turn, eased [-1..1]
  // Body acting (issue #364 PR 3): arm / hat poses, all eased toward technique targets.
  armSpread: number;  // arms splay out/up (air / snowplow / hop), eased [0..1]
  armBack: number;    // arms swept back (tuck),                   eased [0..1]
  armAsym: number;    // carve counterbalance (inside fwd / outside back), eased [-1..1]
  hatTilt: number;    // hat lean into the turn + tuck push-down,  eased [-1..1]
  // Event reactions (issue #364 PR 4): short-lived timers (seconds remaining) + a hat
  // bounce spring kicked on landing. All zero at rest.
  cleanT: number; okT: number; sketchyT: number; trickT: number; wooT: number;
  hatBounce: number; hatBounceV: number;
}

const finite = (n: number): number => (Number.isFinite(n) ? n : 0);
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// --- tuning (all clamped so the face reads clearly but never breaks) ---------
const EASE = 8;                 // per-second lerp rate for the eased channels
const MOUTH_HALF_WIDTH = 0.42;  // matches face.ts (bead x reach) — normalizes bead x to nx
const CURVE_AMP = 0.34;         // bead-y lift/drop at full smile/frown (world units)
const OPEN_AMP = 0.30;          // extra jaw drop of the centre beads at full "O"
const BROW_RAISE_AMP = 0.14;    // brow y-raise at full surprise (world units)
const BROW_ANGLE_AMP = 0.5;     // brow rotation.z swing at full focus/surprise (rad)
const EYE_MIN = 0.12;           // eye scale.y at a full blink (a thin coal line)
const PUPIL_SHIFT = 0.05;       // pupil x-shift toward a full-rate turn (world units)
const CHEEK_POP = 0.35;         // extra cheek scale on a full grin
const MICRO = 0.02;             // idle micro-motion amplitude on the mouth curve

// --- body-acting tuning (issue #364 PR 3) — all clamped rotation offsets (rad) ------
const ARM_SPREAD = 0.7;         // arm splay-out around the shoulder z-axis at full spread
const ARM_RAISE = 0.5;          // arm lift (forward/up around x) at full spread
const ARM_BACK = 0.8;           // arm sweep-back (around x) at full tuck
const ARM_ASYM = 0.55;          // carve counterbalance swing per arm at full turn
const HAT_TILT = 0.22;          // hat lean into a full-rate turn
const HAT_TUCK_DROP = 0.12;     // hat pushed down/forward in a full tuck (world units)
const NOSE_WOBBLE = 0.06;       // deterministic carrot wobble amplitude at speed (rad)
const NOSE_TURN = 0.12;         // nose tilt into a full-rate turn (rad)

// --- event-reaction tuning (issue #364 PR 4) ----------------------------------------
// Short-lived reaction durations (seconds). Priority (highest first) is resolved in
// reactionOverride(): finish > trick > clean > woo > sketchy > avalanche panic > ok
// landing; below that the steady-state technique face (incl. airborne) shows through.
// (ok-landing is the mildest cue — a relieved smile — so it sits LAST, deliberately below
// avalanche panic: a bearing-down slide should never be masked by a relieved grin.)
const REACT_CLEAN = 0.6;        // clean-landing smile + cheek pop + arm pump
const REACT_OK = 0.4;           // ok-landing relieved smile
const REACT_SKETCHY = 0.8;      // sketchy-landing wince (one eye squeezed, crooked mouth, windmill)
const REACT_TRICK = 0.9;        // freestyle-trick celebration grin
const REACT_WOO = 0.5;          // obstacle-clear "woo!" open grin
const AVAL_PANIC_DIST = 40;     // avalanche closer than this => panic (matches the warning band)
const HAT_BOUNCE_KICK = 3.2;    // downward velocity impulse on the hat at a landing
const HAT_BOUNCE_K = 60;        // hat-bounce spring stiffness
const HAT_BOUNCE_C = 9;         // hat-bounce spring damping
const HAT_BOUNCE_CLAMP = 0.25;  // max hat-bounce displacement (world units)
const WINCE_CROOK = 0.22;       // mouth crook (rotation.z) at a full sketchy wince (rad)
const WINDMILL_RATE = 26;       // rad/s of the sketchy/panic arm windmill oscillation
const EYE_WIDE = 1.18;          // eye scale.y cap so panic/surprise can read bug-eyed

// Blink cadence — deterministic (no Math.random): a quick full blink on a fixed period.
const BLINK_INTERVAL = 3.6;     // seconds between blinks
const BLINK_DUR = 0.14;         // seconds a blink takes (down-and-up)

const MOUTH_BEADS: ReadonlyArray<string> = [
  'mouthBead0', 'mouthBead1', 'mouthBead2', 'mouthBead3', 'mouthBead4', 'mouthBead5', 'mouthBead6',
];

/** A technique's steady-state face target. Missing channels default to neutral. */
interface FaceTarget { curve: number; open: number; brow: number; eye: number; }

/** Map the ski technique (+ air) to a steady-state face. Small state machine, not
 *  dozens of bespoke animations — every value is eased toward, so transitions are smooth.
 *  Event reactions (landing grade / tricks / avalanche) layer on top in a later PR. */
function techniqueTarget(m: ExpressionMotion, speedN: number): FaceTarget {
  if (m.isInAir) {
    // Airborne: bright and open — big smile, mouth popped, brows up, eyes wide.
    return { curve: 0.7, open: 0.45, brow: 0.7, eye: 1 };
  }
  switch (m.technique) {
    case 'carve':
      // Determined: brows angled down into the turn, a small confident grin, a squint.
      return { curve: 0.25, open: 0, brow: -0.55, eye: 0.72 };
    case 'snowplow':
      // Braking "uh-oh": wide eyes, raised brows, a small O-mouth.
      return { curve: -0.1, open: 0.4, brow: 0.7, eye: 1 };
    case 'tuck':
      // Racer: low brows, compressed squint, flat mouth.
      return { curve: 0, open: 0, brow: -0.7, eye: 0.5 };
    case 'skid':
    case 'parallel':
      // Concentrated: flat/neutral mouth, brows slightly lowered, eyes near normal.
      return { curve: 0.05, open: 0, brow: -0.2, eye: 0.9 };
    case 'hop':
      // A quick little pop of surprise.
      return { curve: 0.4, open: 0.25, brow: 0.4, eye: 1 };
    default: {
      // idle / glide: a relaxed smile that grows a touch with speed. Blink handled below.
      return { curve: 0.3 + 0.15 * speedN, open: 0, brow: 0, eye: 1 };
    }
  }
}

/** An event reaction's full pose override: a face target plus the arm/hat body targets
 *  and any asymmetric extras (a one-eye wince, a mouth crook). Returned by
 *  reactionOverride() and — when present — REPLACES the technique targets for the frame. */
interface ReactionPose {
  face: FaceTarget;
  spread: number; back: number; asym: number;
  wince: number;      // 0..1: closes the left eye + crooks the mouth (sketchy)
}

/** Resolve the single highest-priority active reaction into a full pose override, or null
 *  to fall through to the steady-state technique face. Edge reactions are gated on their
 *  countdown timer (already ticked this frame); level reactions read the motion directly.
 *  Priority: finish > trick > clean > woo > sketchy > avalanche panic > ok landing. */
function reactionOverride(es: ExprState, m: ExpressionMotion): ReactionPose | null {
  if (m.finished) {
    // Celebration: big grin, brows up, both arms thrown up.
    return { face: { curve: 1, open: 0.3, brow: 0.85, eye: 1.1 }, spread: 1, back: 0, asym: 0, wince: 0 };
  }
  if (es.trickT > 0) {
    // Excited, slightly asymmetric grin; one arm reaching (asym), arms up.
    return { face: { curve: 0.9, open: 0.4, brow: 0.7, eye: 1.12 }, spread: 0.85, back: 0, asym: 0.6, wince: 0 };
  }
  if (es.cleanT > 0) {
    // Clean stomp: big smile + cheek pop, an arm pump.
    return { face: { curve: 1, open: 0.12, brow: 0.4, eye: 1 }, spread: 0.7, back: 0, asym: 0, wince: 0 };
  }
  if (es.wooT > 0) {
    // Obstacle clear: "woo!" open grin, brows up, a little arm flick.
    return { face: { curve: 0.85, open: 0.5, brow: 0.6, eye: 1.12 }, spread: 0.6, back: 0, asym: 0, wince: 0 };
  }
  if (es.sketchyT > 0) {
    // Sketchy landing: crooked mouth, one eye squeezed shut, arms windmill.
    const w = clamp(es.sketchyT / REACT_SKETCHY, 0, 1);
    return { face: { curve: -0.3, open: 0.2, brow: 0.35, eye: 0.9 }, spread: 0.5, back: 0, asym: Math.sin(es.t * WINDMILL_RATE) * 0.6 * w, wince: w };
  }
  const avDist = m.avalancheDistance ?? Infinity;
  if (Number.isFinite(avDist) && avDist < AVAL_PANIC_DIST) {
    // Avalanche close: panic eyes + raised brows, a frantic arm brace/windmill. Intensity
    // climbs as the slide closes in.
    const p = clamp(1 - avDist / AVAL_PANIC_DIST, 0, 1);
    return { face: { curve: -0.35, open: 0.2 + 0.4 * p, brow: 0.6 + 0.4 * p, eye: 1.1 }, spread: 0.45 + 0.4 * p, back: 0, asym: Math.sin(es.t * WINDMILL_RATE) * 0.5 * p, wince: 0 };
  }
  if (es.okT > 0) {
    // Relieved smile.
    return { face: { curve: 0.6, open: 0, brow: 0.2, eye: 1 }, spread: 0, back: 0, asym: 0, wince: 0 };
  }
  return null;
}

function getState(ud: Record<string, unknown>): ExprState {
  let es = ud.expr as ExprState | undefined;
  if (!es) { es = freshState(); ud.expr = es; }
  return es;
}

function freshState(): ExprState {
  return {
    t: 0, blink: BLINK_INTERVAL, curve: 0.3, open: 0, brow: 0, eye: 1, look: 0,
    armSpread: 0, armBack: 0, armAsym: 0, hatTilt: 0,
    cleanT: 0, okT: 0, sketchyT: 0, trickT: 0, wooT: 0, hatBounce: 0, hatBounceV: 0,
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Advance the deterministic blink clock and return this frame's eye-open multiplier
 *  (1 = open, EYE_MIN at the bottom of a blink). Frame-rate independent. */
function blinkFactor(es: ExprState, dt: number): number {
  es.blink -= dt;
  if (es.blink > 0) return 1;
  // Mid-blink: es.blink runs from 0 down to -BLINK_DUR, then re-arms.
  const p = clamp(-es.blink / BLINK_DUR, 0, 1);
  if (-es.blink >= BLINK_DUR) es.blink = BLINK_INTERVAL; // re-arm for the next blink
  return 1 - (1 - EYE_MIN) * Math.sin(p * Math.PI); // smooth down-and-up dip
}

/** Animate the snowman's facial expression for one frame. No-ops unless the face rig
 *  (built by createFace, registered by the model) is present, so it is safe on any
 *  snowman stub without a face. */
function update(snowman: THREE.Object3D, dt: number, m: ExpressionMotion): void {
  const ud = snowman.userData as Record<string, unknown> | undefined;
  if (!ud || !ud.parts || !ud.partBaseTransforms) return;
  const parts = ud.parts as Record<string, THREE.Object3D>;
  if (!parts.mouth || !parts.mouthBead0) return; // no face rig on this snowman

  // Reduced motion => rigid: snap the face to neutral and skip all motion.
  if (prefersReducedMotion()) { reset(snowman); return; }

  const base = ud.partBaseTransforms as Record<string, BaseTransform>;
  const es = getState(ud);

  dt = Math.max(0, finite(dt));
  const speedN = clamp(Math.max(0, finite(m.speed)) / 18, 0, 1);
  const turn = clamp(finite(m.turnRate), -1, 1);
  es.t += dt;

  // --- Event-reaction timers (PR 4) --------------------------------------------------
  // Kick a short-lived timer on each EDGE event this frame; a wipeout ends the run so it
  // drives no face reaction. Any non-wipeout landing also kicks the hat-bounce spring.
  if (m.justLanded) {
    const lq = m.landingQuality ?? null;
    if (lq === 'clean') es.cleanT = REACT_CLEAN;
    else if (lq === 'ok') es.okT = REACT_OK;
    else if (lq === 'sketchy') es.sketchyT = REACT_SKETCHY;
    if (lq !== 'wipeout') es.hatBounceV -= HAT_BOUNCE_KICK;
  }
  // A named trick can complete on the SAME frame the landing grades 'wipeout' (the physics
  // step computes trickName before assigning the wipeout grade on a hard/head-first
  // landing). A wipeout ends the run and must show no reaction, so suppress the (high
  // priority) trick celebration on a wipeout frame — otherwise a crash path that still
  // renders (or a test that disables shatter) flashes a celebration instead of the crash.
  if (m.trickName && m.landingQuality !== 'wipeout') es.trickT = REACT_TRICK;
  if (m.obstacleCleared) es.wooT = REACT_WOO;

  // Resolve the highest-priority active reaction from THIS frame's full timers, BEFORE
  // ticking them down — otherwise an edge reaction is shortened by the same frame's dt on
  // the very frame it fires (a large delta through the legacy updateSnowman(delta) seam
  // could clip it entirely), making the reaction frame-delta dependent.
  const react = reactionOverride(es, m);

  // Now tick the reaction timers down for the NEXT frame.
  es.cleanT = Math.max(0, es.cleanT - dt); es.okT = Math.max(0, es.okT - dt);
  es.sketchyT = Math.max(0, es.sketchyT - dt); es.trickT = Math.max(0, es.trickT - dt);
  es.wooT = Math.max(0, es.wooT - dt);
  const tgt = react ? react.face : techniqueTarget(m, speedN);

  // Ease the face target + look toward the turn.
  const k = clamp(dt * EASE, 0, 1);
  es.curve += (tgt.curve - es.curve) * k;
  es.open += (tgt.open - es.open) * k;
  es.brow += (tgt.brow - es.brow) * k;
  es.eye += (tgt.eye - es.eye) * k;
  es.look += (turn - es.look) * k;
  es.curve = finite(es.curve); es.open = finite(es.open);
  es.brow = finite(es.brow); es.eye = finite(es.eye); es.look = finite(es.look);

  // The sketchy-wince intensity fades with its own reaction timer, so no extra easing.
  const wince = react ? clamp(react.wince, 0, 1) : 0;

  // Hat-bounce spring: a damped landing bounce, integrated on the fixed easing dt.
  es.hatBounceV += (-HAT_BOUNCE_K * es.hatBounce - HAT_BOUNCE_C * es.hatBounceV) * dt;
  es.hatBounce = clamp(finite(es.hatBounce + es.hatBounceV * dt), -HAT_BOUNCE_CLAMP, HAT_BOUNCE_CLAMP);
  es.hatBounceV = finite(es.hatBounceV);

  // A tiny deterministic micro-quiver on the mouth so an idle face isn't frozen.
  const micro = Math.sin(es.t * 2.3) * MICRO;
  const curve = clamp(es.curve + micro, -1.2, 1.2);
  const open = clamp(es.open, 0, 1);

  // --- Mouth: reshape the 7 coal beads around their neutral (gentle-smile) base ------
  // bead.y = base.y + smile/frown(nx²) - jaw-open(centre). nx in [-1..1] is the bead's
  // normalized horizontal position, so the ENDS carry the smile/frown and the CENTRE
  // carries the jaw drop. Neutral (curve 0, open 0) reproduces the shipped smile exactly.
  for (const key of MOUTH_BEADS) {
    const p = parts[key]; const b = base[key];
    if (!p || !b) continue;
    const nx = clamp(b.position.x / MOUTH_HALF_WIDTH, -1, 1);
    const dy = curve * CURVE_AMP * nx * nx - open * OPEN_AMP * (1 - nx * nx);
    p.position.set(b.position.x, b.position.y + clamp(dy, -0.5, 0.5), b.position.z);
  }
  // Crook the whole mouth on a sketchy wince (a lopsided grimace).
  if (parts.mouth && base.mouth) {
    parts.mouth.rotation.set(base.mouth.rotation.x, base.mouth.rotation.y, base.mouth.rotation.z + wince * WINCE_CROOK);
  }

  // --- Brows: raise/lower + angle from the single brow channel -----------------------
  // brow>0 (surprise/panic) lifts the brows and arches them; brow<0 (focus/determined)
  // lowers them and angles the inner ends down. The per-brow sign mirrors left/right.
  writeBrow(parts.leftBrow, base.leftBrow, es.brow, +1);
  writeBrow(parts.rightBrow, base.rightBrow, es.brow, -1);

  // --- Eyes: squint/wide from technique-or-reaction, times the deterministic blink dip -
  // A sketchy wince squeezes ONE eye (the left) shut for a lopsided grimace.
  const blink = blinkFactor(es, dt);
  const eyeOpen = clamp(es.eye * blink, EYE_MIN, EYE_WIDE);
  writeEye(parts.leftEye, base.leftEye, clamp(eyeOpen * (1 - 0.9 * wince), EYE_MIN, EYE_WIDE));
  writeEye(parts.rightEye, base.rightEye, eyeOpen);

  // --- Pupils: shift a touch toward the turn (eye-local; ride the eye squash) ---------
  writePupil(parts.leftPupil, base.leftPupil, es.look);
  writePupil(parts.rightPupil, base.rightPupil, es.look);

  // --- Cheeks: pop out on a big grin --------------------------------------------------
  const pop = 1 + Math.max(0, es.curve) * CHEEK_POP;
  writeCheek(parts.leftCheek, base.leftCheek, pop);
  writeCheek(parts.rightCheek, base.rightCheek, pop);

  // --- Body acting (issue #364 PR 3): arms / hat / nose -------------------------------
  // Ease the arm/hat pose channels toward their technique targets, then write the arm
  // group + hat + nose transforms. These parts are NOT touched by flex or pose.ts (pose
  // owns only the ski ROOTS and the root yaw), so the writes compose cleanly. The ski
  // wedge/edge/draw is left to pose.ts by design.
  const air = !!m.isInAir;
  // A reaction OVERRIDES the technique arm targets while active (arms up for a
  // celebration, windmill for a wince/panic), else the technique poses drive.
  const spreadTgt = react ? react.spread : air ? 0.9 : m.technique === 'snowplow' ? 0.7 : m.technique === 'hop' ? 0.5 : 0;
  const backTgt = react ? react.back : (!air && m.technique === 'tuck' ? 0.85 : 0);
  const asymTgt = react ? react.asym : (!air && m.technique === 'carve' ? turn : 0);
  // Hat leans INTO the turn (dropped flat in tuck). The into-turn direction on rotation.z is
  // `-turn`, matching the flex head-cluster lean (targetLean = -turn * LEAN_TARGET in
  // snowman-flex.ts); +turn would tip the hat the opposite way from the body's lean.
  const tiltTgt = !air && m.technique === 'tuck' ? 0 : -turn;
  es.armSpread += (spreadTgt - es.armSpread) * k;
  es.armBack += (backTgt - es.armBack) * k;
  es.armAsym += (asymTgt - es.armAsym) * k;
  es.hatTilt += (tiltTgt - es.hatTilt) * k;
  es.armSpread = finite(es.armSpread); es.armBack = finite(es.armBack);
  es.armAsym = finite(es.armAsym); es.hatTilt = finite(es.hatTilt);

  writeArm(parts.leftArmGroup, base.leftArmGroup, es, +1);
  writeArm(parts.rightArmGroup, base.rightArmGroup, es, -1);
  const tucking = m.technique === 'tuck' && !air;
  writeHat(parts.hatBase, base.hatBase, es, tucking);
  writeHat(parts.hatTop, base.hatTop, es, tucking);
  // Deterministic carrot wobble: a tiny speed-scaled quiver plus a lean into the turn. The
  // nose lean uses the same into-turn sign as the hat/head (`-turn` on rotation.z).
  writeNose(parts.nose, base.nose, Math.sin(es.t * 9) * NOSE_WOBBLE * speedN - turn * NOSE_TURN);
}

function writeBrow(p: THREE.Object3D | undefined, b: BaseTransform | undefined, brow: number, sign: number): void {
  if (!p || !b) return;
  const raise = clamp(brow, -1, 1) * BROW_RAISE_AMP;
  const angle = sign * -brow * BROW_ANGLE_AMP; // lowered brows (brow<0) angle inward-down
  p.position.set(b.position.x, b.position.y + clamp(raise, -0.2, 0.2), b.position.z);
  p.rotation.set(b.rotation.x, b.rotation.y, b.rotation.z + clamp(angle, -0.7, 0.7));
}

function writeEye(p: THREE.Object3D | undefined, b: BaseTransform | undefined, open: number): void {
  if (!p || !b) return;
  p.scale.set(b.scale.x, b.scale.y * open, b.scale.z);
}

function writePupil(p: THREE.Object3D | undefined, b: BaseTransform | undefined, look: number): void {
  if (!p || !b) return;
  p.position.set(b.position.x + clamp(look, -1, 1) * PUPIL_SHIFT, b.position.y, b.position.z);
}

function writeCheek(p: THREE.Object3D | undefined, b: BaseTransform | undefined, pop: number): void {
  if (!p || !b) return;
  const s = clamp(pop, 1, 1 + CHEEK_POP);
  p.scale.set(b.scale.x * s, b.scale.y * s, b.scale.z * s);
}

/** Pose one arm group as rotation OFFSETS from its neutral base (the arm points +y out
 *  of the shoulder). `sign` is +1 for the left arm (+x shoulder), -1 for the right, so
 *  spread splays both arms symmetrically OUTWARD and the carve asymmetry counter-rotates
 *  them (inside arm forward, outside back). All offsets clamped so a pose never breaks. */
function writeArm(p: THREE.Object3D | undefined, b: BaseTransform | undefined, es: ExprState, sign: number): void {
  if (!p || !b) return;
  // rotZ splays the arms OUTWARD: the left arm (sign +1, +x shoulder) rotates -z so its tip
  // swings out to +x, the right arm mirrors it. (The earlier +sign rotation swung both arms
  // inward-and-up over the head, clipping the twigs into the r=1 head sphere in the spread
  // states — snowplow/air/hop; invisible from the front follow cam but visible in orbit/drone.)
  //
  // rotX: the arm sticks extend along local +Y and the face/nose point +Z, so a POSITIVE x
  // rotation swings the hands toward the FRONT (+z). The tuck sweep-back must therefore
  // SUBTRACT armBack (negative rotX → hands go behind, -z); a positive term reversed it,
  // throwing the hands out in front of the racer. Spread's raise is negative for the same
  // reason (up-and-slightly-back), and the carve asym counter-rotates the pair.
  const rotX = clamp(-es.armSpread * ARM_RAISE - es.armBack * ARM_BACK - sign * es.armAsym * ARM_ASYM, -1.4, 1.4);
  const rotZ = clamp(-sign * es.armSpread * ARM_SPREAD, -1.2, 1.2);
  p.rotation.set(b.rotation.x + rotX, b.rotation.y, b.rotation.z + rotZ);
}

/** Lean the hat into the turn (rotation.z), bounce it on a landing (the hatBounce spring),
 *  and in a tuck push it down/forward. The two hat pieces share the head cluster's bob via
 *  their parenting; this adds the personality on top. */
function writeHat(p: THREE.Object3D | undefined, b: BaseTransform | undefined, es: ExprState, tucking: boolean): void {
  if (!p || !b) return;
  const tilt = clamp(es.hatTilt * HAT_TILT, -0.4, 0.4);
  const drop = tucking ? HAT_TUCK_DROP : 0;
  p.position.set(b.position.x, b.position.y - drop + clamp(es.hatBounce, -HAT_BOUNCE_CLAMP, HAT_BOUNCE_CLAMP), b.position.z);
  p.rotation.set(b.rotation.x + (tucking ? 0.12 : 0), b.rotation.y, b.rotation.z + tilt);
}

/** A subtle deterministic carrot wobble/tilt (rotation.z offset from the base +x/2 pose). */
function writeNose(p: THREE.Object3D | undefined, b: BaseTransform | undefined, wobble: number): void {
  if (!p || !b) return;
  p.rotation.set(b.rotation.x, b.rotation.y, b.rotation.z + clamp(wobble, -0.3, 0.3));
}

/** Snap every expression-animated face part back to its neutral transform and clear the
 *  expression state. Called on each run reset/restart so a new run starts from a clean
 *  face (and by update() under prefers-reduced-motion). */
function reset(snowman: THREE.Object3D): void {
  const ud = snowman.userData as Record<string, unknown> | undefined;
  if (!ud || !ud.parts || !ud.partBaseTransforms) return;
  const parts = ud.parts as Record<string, THREE.Object3D>;
  const base = ud.partBaseTransforms as Record<string, BaseTransform>;
  const keys = [
    ...MOUTH_BEADS, 'mouth', 'leftBrow', 'rightBrow', 'leftEye', 'rightEye',
    'leftPupil', 'rightPupil', 'leftCheek', 'rightCheek',
    // Body acting (PR 3): arms / hat / nose.
    'leftArmGroup', 'rightArmGroup', 'hatBase', 'hatTop', 'nose',
  ];
  for (const key of keys) {
    const p = parts[key]; const b = base[key];
    if (!p || !b) continue;
    p.position.set(b.position.x, b.position.y, b.position.z);
    p.scale.set(b.scale.x, b.scale.y, b.scale.z);
    p.rotation.set(b.rotation.x, b.rotation.y, b.rotation.z);
  }
  ud.expr = freshState();
}

export const Expression = { update, reset };
