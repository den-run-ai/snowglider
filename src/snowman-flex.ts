// snowman-flex.ts — cosmetic "flexible / wiggly snowman" layer (issue #53).
//
// Purely visual. It reads the per-frame motion the physics kernel already produced
// (speed/technique/landing) and writes ONLY child-mesh transforms on the snowman:
// squash-and-stretch breathing, a head-cluster bob + turn lag, a landing settle
// bounce, and a carve lean. It NEVER touches pos/velocity or anything inside
// `Snowman.updateSnowman`, so the physics-invariant harness and the frozen
// snowman_baseline stay byte-identical (no baseline regeneration). The orchestrator
// calls Flex.update(...) once per frame AFTER the physics step (see game/main-loop.ts)
// and Flex.reset(...) on every run reset (see game/lifecycle.ts).
//
// THREE is imported type-only so this module has no runtime dependency on three and
// stays trivially testable headless with plain `{position,scale,rotation,userData}`
// stand-ins.
import type * as THREE from 'three';

/** The per-frame motion the flex layer reads. All fields come straight from the
 *  updateSnowman `UpdateResult` except `turnRate`, which the caller derives with a
 *  ZERO-SPEED GUARD (`speed > eps ? velocity.x / speed : 0`) so a 0/0 first frame can
 *  never feed a NaN into the transforms below. */
export interface FlexMotion {
  speed: number;
  technique: string;
  turnRate: number;
  justLanded: boolean;
  landingForce: number;
  isInAir: boolean;
  /** Deliberate-takeoff anticipation (JP-5): true only on the frame a MANUAL jump
   *  leaves the ground (the loop gates it on playerJump provenance). Kicks the
   *  settle spring down for a 1–2 frame crouch whose overshoot reads as the stretch
   *  toward apex. DEFAULTS to absent, so every existing caller/test is byte-identical. */
  tookOff?: boolean;
  /** Apparent wind (wind − player velocity) resolved into the snowman's LOCAL frame and
   *  normalized to ~[-1,1] by the caller, so the scarf streams downwind (issue #253).
   *  `windSway` = sideways component (swings the tail left/right); `windStream` = forward
   *  component (lifts the tail back in a headwind / forward in a tailwind). BOTH DEFAULT
   *  to 0 (absent), so every existing caller/test is byte-identical. */
  windSway?: number;
  windStream?: number;
}

interface XYZ { x: number; y: number; z: number; }
interface BaseTransform { position: XYZ; scale: XYZ; rotation: XYZ; }
interface FlexState {
  t: number; settle: number; settleVel: number; leanZ: number; lagY: number;
  // Ski flex (issue #189): a smoothed base camber + a landing compression spring.
  skiCamber: number; skiSettle: number; skiSettleVel: number;
  // Wind (issue #253): smoothed apparent-wind sway/stream so the scarf cloth and the
  // brace lean ease between gusts instead of snapping.
  windSwayS: number; windStreamS: number;
}

const finite = (n: number): number => (Number.isFinite(n) ? n : 0);
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// --- tuning (clamped, so the snowman reads as clearly alive but never breaks) ---
// Amplitudes are sized to be visible at the follow-cam distance: the earlier values
// (~1.5% squash / 0.05u bob) rounded to nothing on screen (issue #53 follow-up).
const BREATHE_FREQ = 6.0;       // rad/s of the squash-stretch wobble
const BREATHE_BASE = 0.04;      // idle squash amplitude (4%)
const BREATHE_SPEED = 0.06;     // extra amplitude at full speed (=> ~10% squashing fast)
const BREATHE_AIR = 0.02;       // quieter breathing while airborne
const SPEED_REF = 18;           // speed at which the "fast" terms saturate
const SETTLE_K = 50;            // landing-spring stiffness
const SETTLE_C = 12;            // landing-spring damping
const SETTLE_CLAMP = 0.30;      // max squash from a landing
const BOB_FREQ = 5.0;           // head bob rad/s
const BOB_AMP = 0.16;           // head bob world units
const LAG_TARGET = 0.20;        // how far the head trails into a turn (rad)
const LEAN_TARGET = 0.28;       // carve lean of the head cluster (rad)
const LEAN_GLIDE = 0.5;         // fraction of the lean kept when not actively carving

const BALLS: ReadonlyArray<string> = ['bottom', 'middle', 'head'];
const BALL_PHASE: ReadonlyArray<number> = [0, 1.1, 2.2]; // stagger so the stack ripples

// --- wind tuning (issue #253) -----------------------------------------------
// The caller passes apparent wind (wind - velocity) resolved into the snowman's local
// frame, normalized to ~[-1,1]. The scarf streams with it; the body braces lightly into
// a crosswind. All amplitudes are clamped so a gust never throws the pose.
const SCARF_WIND_SWAY = 0.55;   // rad of tail side-swing at full crosswind
const SCARF_WIND_STREAM = 0.35; // rad of tail fore/aft lift at full head/tail wind
const BRACE_LEAN = 0.07;        // rad the head cluster leans INTO a full crosswind
const WIND_SMOOTH = 4;          // per-s lerp easing the (already gust-smooth) wind inputs

// --- ski flex tuning (issue #189) -------------------------------------------
// The skis are split (in model.ts) into a tip arm (extends +z) and a tail arm (extends
// -z) that pivot at the waist. Bending an arm's rotation.x raises/lowers that end:
// for the +z tip a NEGATIVE angle lifts it, for the -z tail a POSITIVE angle lifts it,
// so a positive "camber" lifts BOTH ends into an arch. Landing pushes camber negative
// (reverse-camber compression); a carve adds tip-pressure (the shovel digs down).
const SKI_CAMBER_GLIDE = 0.06;   // gentle unweighted arch while gliding
const SKI_CAMBER_PLOW = 0.025;   // snowplow sits flatter / planted
const SKI_CAMBER_AIR = 0.0;      // airborne ski de-cambers (relaxes flat)
const SKI_TIP_GAIN = 1.0;        // tip-arm angle per unit camber
const SKI_TAIL_GAIN = 0.8;       // tail kicks a little less than the shovel
const SKI_CHATTER_FREQ = 34;     // rad/s of the speed-chatter vibration
const SKI_CHATTER_AMP = 0.012;   // chatter amplitude at full speed
const SKI_TIP_PRESS = 0.11;      // extra shovel bend in a full-rate carve
const SKI_SETTLE_K = 60;         // landing-spring stiffness (skis)
const SKI_SETTLE_C = 11;         // landing-spring damping (skis)
const SKI_SETTLE_CLAMP = 0.18;   // max reverse-camber from a landing
const SKI_ARM_CLAMP = 0.5;       // hard clamp on any ski-arm bend (rad)
const SKI_TIP_PARTS: ReadonlyArray<string> = ['leftSkiTip', 'rightSkiTip'];
const SKI_TAIL_PARTS: ReadonlyArray<string> = ['leftSkiTail', 'rightSkiTail'];

function getState(ud: Record<string, unknown>): FlexState {
  let fs = ud.flex as FlexState | undefined;
  if (!fs) { fs = freshState(); ud.flex = fs; }
  return fs;
}

function freshState(): FlexState {
  return { t: 0, settle: 0, settleVel: 0, leanZ: 0, lagY: 0, skiCamber: SKI_CAMBER_GLIDE, skiSettle: 0, skiSettleVel: 0, windSwayS: 0, windStreamS: 0 };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Animate the snowman's cosmetic flex for one frame. No-ops unless the part registry
 *  (built by createSnowman) is present, so it is safe on any snowman stub. */
function update(snowman: THREE.Object3D, dt: number, m: FlexMotion): void {
  const ud = snowman.userData as Record<string, unknown> | undefined;
  if (!ud || !ud.parts || !ud.partBaseTransforms) return;

  // Reduced motion => rigid: snap to neutral and skip all motion.
  if (prefersReducedMotion()) { reset(snowman); return; }

  const parts = ud.parts as Record<string, THREE.Object3D>;
  const base = ud.partBaseTransforms as Record<string, BaseTransform>;
  const fs = getState(ud);

  dt = Math.max(0, finite(dt));
  const speed = Math.max(0, finite(m.speed));
  const speedN = clamp(speed / SPEED_REF, 0, 1);
  const turn = clamp(finite(m.turnRate), -1, 1);
  const air = !!m.isInAir;

  // Smooth the apparent-wind inputs (issue #253). Absent => 0, so a caller that doesn't
  // pass wind leaves the scarf/brace byte-identical to before.
  const swayIn = clamp(finite(m.windSway ?? 0), -1, 1);
  const streamIn = clamp(finite(m.windStream ?? 0), -1, 1);
  fs.windSwayS += (swayIn - fs.windSwayS) * clamp(dt * WIND_SMOOTH, 0, 1);
  fs.windStreamS += (streamIn - fs.windStreamS) * clamp(dt * WIND_SMOOTH, 0, 1);
  fs.windSwayS = finite(fs.windSwayS); fs.windStreamS = finite(fs.windStreamS);

  fs.t += dt;

  // Landing settle: a downward squash impulse that springs back to neutral.
  if (m.justLanded && finite(m.landingForce) > 0.25) {
    fs.settleVel -= clamp(finite(m.landingForce) * 1.4, 0, 1.8);
  }
  // Takeoff anticipation (JP-5): a deliberate jump's launch frame dips the body — the
  // same spring then overshoots past neutral, which reads as the stretch toward apex.
  // Smaller than a real landing hit; absent (default) on every non-takeoff frame.
  if (m.tookOff) {
    fs.settleVel -= 0.9;
  }
  fs.settleVel += (-SETTLE_K * fs.settle - SETTLE_C * fs.settleVel) * dt;
  fs.settle += fs.settleVel * dt;
  fs.settle = clamp(finite(fs.settle), -SETTLE_CLAMP, SETTLE_CLAMP);
  fs.settleVel = finite(fs.settleVel);

  // Breathing / jiggle on the three balls (volume-conserving squash<->stretch).
  const amp = air ? BREATHE_AIR : BREATHE_BASE + BREATHE_SPEED * speedN;
  for (let i = 0; i < BALLS.length; i++) {
    const p = parts[BALLS[i]!]; const b = base[BALLS[i]!];
    if (!p || !b) continue;
    const sq = Math.sin(fs.t * BREATHE_FREQ + BALL_PHASE[i]!) * amp + fs.settle;
    const sy = clamp(1 + sq, 0.7, 1.3);
    const sxz = clamp(1 - 0.5 * sq, 0.7, 1.3);
    p.scale.set(b.scale.x * sxz, b.scale.y * sy, b.scale.z * sxz);
  }

  // Head cluster: vertical bob, turn lag, and carve lean — all relative to neutral.
  const hg = parts.headGroup; const hb = base.headGroup;
  if (hg && hb) {
    const bob = Math.sin(fs.t * BOB_FREQ) * BOB_AMP * (0.5 + 0.5 * speedN) + fs.settle * 0.4;
    hg.position.set(hb.position.x, hb.position.y + clamp(bob, -0.3, 0.3), hb.position.z);

    const targetLag = -turn * LAG_TARGET;
    // Lean into every turn (the most readable cue), but only a committed CARVE gets the
    // full deep head-cluster lean; a skidded parallel turn (and glide/snowplow) keep the
    // lighter glide lean so the "skis flatter, body upright" parallel pose actually reads
    // (the body-lean split is driven harder in pose.ts). Both stay above the old hard gate
    // that left non-carve turns at 0.
    const carving = !air && m.technique === 'carve';
    const targetLean = air ? 0 : -turn * LEAN_TARGET * (carving ? 1 : LEAN_GLIDE);
    fs.lagY += (targetLag - fs.lagY) * clamp(dt * 6, 0, 1);
    fs.leanZ += (targetLean - fs.leanZ) * clamp(dt * 5, 0, 1);
    fs.lagY = finite(fs.lagY); fs.leanZ = finite(fs.leanZ);

    // Brace lightly INTO a crosswind (opposite the direction the scarf streams). Tiny and
    // clamped so it never reads as a turn; zero while airborne (#253).
    const brace = air ? 0 : clamp(-fs.windSwayS * BRACE_LEAN, -0.09, 0.09);

    hg.rotation.set(
      hb.rotation.x + clamp(fs.settle * 0.25, -0.1, 0.1),
      hb.rotation.y + clamp(fs.lagY, -0.28, 0.28),
      hb.rotation.z + clamp(fs.leanZ + brace, -0.36, 0.36)
    );
  }

  // Scarf tail trail — present-or-absent (added by the optional scarf follow-up, PR C).
  // It swings with turns, flutters with speed, AND now streams in the apparent wind so a
  // crosswind trails it sideways and a head/tail wind lifts it fore/aft (issue #253).
  const tail = parts.scarfTail; const tb = base.scarfTail;
  if (tail && tb) {
    const windSwing = fs.windSwayS * SCARF_WIND_SWAY;
    // Negate the apparent-wind stream: the tail's rest pose is forward-draped (more-negative
    // rotation.x sends it toward +z), so a head/tail wind must ADD positive rotation.x to
    // trail it behind. A downhill self-motion headwind (windStreamS < 0) thus streams the
    // scarf back; a tailwind (> 0) pushes it forward (Codex #259).
    const windLift = clamp(-fs.windStreamS * SCARF_WIND_STREAM, -0.4, 0.4);
    const swing = clamp(-turn * 0.4 + windSwing + Math.sin(fs.t * 7.0) * 0.12 * (0.4 + speedN), -0.8, 0.8);
    tail.rotation.set(tb.rotation.x + (air ? -0.3 : 0.1) + windLift, tb.rotation.y, tb.rotation.z + swing);
  }

  // --- Ski flex (issue #189) -------------------------------------------------
  // Bend the tip/tail arms (rotation.x ONLY) for camber, landing compression, and carve
  // tip-pressure. The ski ROOT transform stays untouched (pose.ts owns the snowplow
  // wedge / parallel edge + draw). Present-or-absent: no-ops on a snowman without arms.
  if (parts.leftSkiTip || parts.rightSkiTip) {
    const snowplow = !air && m.technique === 'snowplow';
    // Only a committed CARVE digs the shovel in (tip-pressure). A skidded parallel
    // turn keeps the skis flatter — it must NOT get carve tip-pressure (#191: the
    // low-charge skidded turn now reports 'parallel', not the old locked-edge tier).
    const carving = !air && m.technique === 'carve';

    // Smooth the resting camber between techniques so changes don't snap.
    const camberTarget = air ? SKI_CAMBER_AIR : (snowplow ? SKI_CAMBER_PLOW : SKI_CAMBER_GLIDE);
    fs.skiCamber += (camberTarget - fs.skiCamber) * clamp(dt * 6, 0, 1);
    fs.skiCamber = finite(fs.skiCamber);

    // Landing compression: a damped spring kicked toward reverse camber on touchdown.
    if (m.justLanded && finite(m.landingForce) > 0.25) {
      fs.skiSettleVel -= clamp(finite(m.landingForce) * 1.2, 0, 1.6);
    }
    fs.skiSettleVel += (-SKI_SETTLE_K * fs.skiSettle - SKI_SETTLE_C * fs.skiSettleVel) * dt;
    fs.skiSettle += fs.skiSettleVel * dt;
    fs.skiSettle = clamp(finite(fs.skiSettle), -SKI_SETTLE_CLAMP, SKI_SETTLE_CLAMP);
    fs.skiSettleVel = finite(fs.skiSettleVel);

    // Speed-chatter: a fast low-amplitude vibration of the whole arch while gliding.
    const chatter = air ? 0 : Math.sin(fs.t * SKI_CHATTER_FREQ) * SKI_CHATTER_AMP * speedN;
    const camber = fs.skiCamber + fs.skiSettle + chatter;       // signed arch (negative => reverse)
    const tipPress = carving ? SKI_TIP_PRESS * Math.abs(turn) : 0; // shovel digs in mid-carve

    for (const key of SKI_TIP_PARTS) {
      const p = parts[key]; const b = base[key];
      if (p && b) p.rotation.set(b.rotation.x + clamp(-camber * SKI_TIP_GAIN + tipPress, -SKI_ARM_CLAMP, SKI_ARM_CLAMP), b.rotation.y, b.rotation.z);
    }
    for (const key of SKI_TAIL_PARTS) {
      const p = parts[key]; const b = base[key];
      if (p && b) p.rotation.set(b.rotation.x + clamp(camber * SKI_TAIL_GAIN, -SKI_ARM_CLAMP, SKI_ARM_CLAMP), b.rotation.y, b.rotation.z);
    }
  }
}

/** Snap every flex-animated part back to its neutral transform and clear the flex
 *  state. Called on each run reset/restart so a new run starts from a clean pose. */
function reset(snowman: THREE.Object3D): void {
  const ud = snowman.userData as Record<string, unknown> | undefined;
  if (!ud || !ud.parts || !ud.partBaseTransforms) return;
  const parts = ud.parts as Record<string, THREE.Object3D>;
  const base = ud.partBaseTransforms as Record<string, BaseTransform>;
  for (const key of Object.keys(parts)) {
    const p = parts[key]; const b = base[key];
    if (!p || !b) continue;
    p.position.set(b.position.x, b.position.y, b.position.z);
    p.scale.set(b.scale.x, b.scale.y, b.scale.z);
    p.rotation.set(b.rotation.x, b.rotation.y, b.rotation.z);
  }
  ud.flex = freshState();
}

export const Flex = { update, reset };
