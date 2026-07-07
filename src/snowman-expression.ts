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

function getState(ud: Record<string, unknown>): ExprState {
  let es = ud.expr as ExprState | undefined;
  if (!es) { es = freshState(); ud.expr = es; }
  return es;
}

function freshState(): ExprState {
  return {
    t: 0, blink: BLINK_INTERVAL, curve: 0.3, open: 0, brow: 0, eye: 1, look: 0,
    armSpread: 0, armBack: 0, armAsym: 0, hatTilt: 0,
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

  // Ease the technique target + look toward the turn.
  const tgt = techniqueTarget(m, speedN);
  const k = clamp(dt * EASE, 0, 1);
  es.curve += (tgt.curve - es.curve) * k;
  es.open += (tgt.open - es.open) * k;
  es.brow += (tgt.brow - es.brow) * k;
  es.eye += (tgt.eye - es.eye) * k;
  es.look += (turn - es.look) * k;
  es.curve = finite(es.curve); es.open = finite(es.open);
  es.brow = finite(es.brow); es.eye = finite(es.eye); es.look = finite(es.look);

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

  // --- Brows: raise/lower + angle from the single brow channel -----------------------
  // brow>0 (surprise/panic) lifts the brows and arches them; brow<0 (focus/determined)
  // lowers them and angles the inner ends down. The per-brow sign mirrors left/right.
  writeBrow(parts.leftBrow, base.leftBrow, es.brow, +1);
  writeBrow(parts.rightBrow, base.rightBrow, es.brow, -1);

  // --- Eyes: squint from technique, times the deterministic blink dip ----------------
  const eyeOpen = clamp(es.eye * blinkFactor(es, dt), EYE_MIN, 1);
  writeEye(parts.leftEye, base.leftEye, eyeOpen);
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
  const spreadTgt = air ? 0.9 : m.technique === 'snowplow' ? 0.7 : m.technique === 'hop' ? 0.5 : 0;
  const backTgt = !air && m.technique === 'tuck' ? 0.85 : 0;
  const asymTgt = !air && m.technique === 'carve' ? turn : 0;
  const tiltTgt = !air && m.technique === 'tuck' ? 0 : turn; // hat leans into the turn (dropped in tuck)
  es.armSpread += (spreadTgt - es.armSpread) * k;
  es.armBack += (backTgt - es.armBack) * k;
  es.armAsym += (asymTgt - es.armAsym) * k;
  es.hatTilt += (tiltTgt - es.hatTilt) * k;
  es.armSpread = finite(es.armSpread); es.armBack = finite(es.armBack);
  es.armAsym = finite(es.armAsym); es.hatTilt = finite(es.hatTilt);

  writeArm(parts.leftArmGroup, base.leftArmGroup, es, +1);
  writeArm(parts.rightArmGroup, base.rightArmGroup, es, -1);
  writeHat(parts.hatBase, base.hatBase, es, m.technique === 'tuck' && !air);
  writeHat(parts.hatTop, base.hatTop, es, m.technique === 'tuck' && !air);
  // Deterministic carrot wobble: a tiny speed-scaled quiver plus a lean into the turn.
  writeNose(parts.nose, base.nose, Math.sin(es.t * 9) * NOSE_WOBBLE * speedN + turn * NOSE_TURN);
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
  const rotX = clamp(-es.armSpread * ARM_RAISE + es.armBack * ARM_BACK - sign * es.armAsym * ARM_ASYM, -1.4, 1.4);
  const rotZ = clamp(-sign * es.armSpread * ARM_SPREAD, -1.2, 1.2);
  p.rotation.set(b.rotation.x + rotX, b.rotation.y, b.rotation.z + rotZ);
}

/** Lean the hat into the turn (rotation.z) and, in a tuck, push it down/forward. The two
 *  hat pieces share the head cluster's bob via their parenting; this adds the personality. */
function writeHat(p: THREE.Object3D | undefined, b: BaseTransform | undefined, es: ExprState, tucking: boolean): void {
  if (!p || !b) return;
  const tilt = clamp(es.hatTilt * HAT_TILT, -0.4, 0.4);
  const drop = tucking ? HAT_TUCK_DROP : 0;
  p.position.set(b.position.x, b.position.y - drop, b.position.z);
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
