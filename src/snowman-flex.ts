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
}

interface XYZ { x: number; y: number; z: number; }
interface BaseTransform { position: XYZ; scale: XYZ; rotation: XYZ; }
interface FlexState { t: number; settle: number; settleVel: number; leanZ: number; lagY: number; }

const finite = (n: number): number => (Number.isFinite(n) ? n : 0);
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// --- tuning (all small + clamped, so the snowman reads as alive but never breaks) ---
const BREATHE_FREQ = 6.0;       // rad/s of the squash-stretch wobble
const BREATHE_BASE = 0.015;     // idle squash amplitude (1.5%)
const BREATHE_SPEED = 0.020;    // extra amplitude at full speed
const BREATHE_AIR = 0.008;      // quieter breathing while airborne
const SPEED_REF = 18;           // speed at which the "fast" terms saturate
const SETTLE_K = 50;            // landing-spring stiffness
const SETTLE_C = 12;            // landing-spring damping
const SETTLE_CLAMP = 0.25;      // max squash from a landing
const BOB_FREQ = 5.0;           // head bob rad/s
const BOB_AMP = 0.05;           // head bob world units
const LAG_TARGET = 0.12;        // how far the head trails into a turn (rad)
const LEAN_TARGET = 0.16;       // carve lean of the head cluster (rad)

const BALLS: ReadonlyArray<string> = ['bottom', 'middle', 'head'];
const BALL_PHASE: ReadonlyArray<number> = [0, 1.1, 2.2]; // stagger so the stack ripples

function getState(ud: Record<string, unknown>): FlexState {
  let fs = ud.flex as FlexState | undefined;
  if (!fs) { fs = { t: 0, settle: 0, settleVel: 0, leanZ: 0, lagY: 0 }; ud.flex = fs; }
  return fs;
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

  fs.t += dt;

  // Landing settle: a downward squash impulse that springs back to neutral.
  if (m.justLanded && finite(m.landingForce) > 0.25) {
    fs.settleVel -= clamp(finite(m.landingForce) * 0.9, 0, 1.2);
  }
  fs.settleVel += (-SETTLE_K * fs.settle - SETTLE_C * fs.settleVel) * dt;
  fs.settle += fs.settleVel * dt;
  fs.settle = clamp(finite(fs.settle), -SETTLE_CLAMP, SETTLE_CLAMP);
  fs.settleVel = finite(fs.settleVel);

  // Breathing / jiggle on the three balls (volume-conserving squash<->stretch).
  const amp = air ? BREATHE_AIR : BREATHE_BASE + BREATHE_SPEED * speedN;
  for (let i = 0; i < BALLS.length; i++) {
    const p = parts[BALLS[i]]; const b = base[BALLS[i]];
    if (!p || !b) continue;
    const sq = Math.sin(fs.t * BREATHE_FREQ + BALL_PHASE[i]) * amp + fs.settle;
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
    const carving = !air && (m.technique === 'carve' || m.technique === 'parallel' || m.technique === 'skid');
    const targetLean = carving ? -turn * LEAN_TARGET : 0;
    fs.lagY += (targetLag - fs.lagY) * clamp(dt * 6, 0, 1);
    fs.leanZ += (targetLean - fs.leanZ) * clamp(dt * 5, 0, 1);
    fs.lagY = finite(fs.lagY); fs.leanZ = finite(fs.leanZ);

    hg.rotation.set(
      hb.rotation.x + clamp(fs.settle * 0.25, -0.1, 0.1),
      hb.rotation.y + clamp(fs.lagY, -0.2, 0.2),
      hb.rotation.z + clamp(fs.leanZ, -0.22, 0.22)
    );
  }

  // Scarf tail trail — present-or-absent (added by the optional scarf follow-up, PR C).
  const tail = parts.scarfTail; const tb = base.scarfTail;
  if (tail && tb) {
    const swing = clamp(-turn * 0.4 + Math.sin(fs.t * 7.0) * 0.12 * (0.4 + speedN), -0.6, 0.6);
    tail.rotation.set(tb.rotation.x + (air ? -0.3 : 0.1), tb.rotation.y, tb.rotation.z + swing);
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
  ud.flex = { t: 0, settle: 0, settleVel: 0, leanZ: 0, lagY: 0 };
}

export const Flex = { update, reset };
