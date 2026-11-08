// mouth-line.ts — shared geometry math for the snowman's silhouette-line mouth.
//
// The mouth is a thin continuous polyline: 7 joint spheres (the animation control
// points the expression controller reshapes into smile / flat / frown / "O") linked by
// 6 thin cylinder segments. This module owns the layout constants and the pure
// segment-fitting math so src/snowman/face.ts (initial build, real THREE meshes) and
// src/snowman-expression.ts (per-frame reshape, plain transform stand-ins in headless
// tests) use ONE source of truth instead of duplicated MUST-MATCH constants.
//
// Everything here is pure math over `{position, scale, rotation}` shaped objects —
// no runtime THREE import — so the expression layer stays trivially testable headless.

/** Head sphere radius (the head mesh is a unit sphere; face coords are head-local). */
export const HEAD_R = 1.0;
/** Mouth joints along the curve (the expression controller's control points). */
export const MOUTH_JOINT_COUNT = 7;
/** Mouth centre latitude on the face. */
export const MOUTH_Y = -0.42;
/** x reach of the outermost joint (eyes sit at ±0.4 — the mouth stays well inside). */
export const MOUTH_HALF_WIDTH = 0.3;
/** Neutral pose is a gentle relaxed smile (ends lifted by this × t²). */
export const MOUTH_SMILE_BASE = 0.1;
/** Line thickness: the joint sphere radius AND the segment cylinder radius, so the
 *  joints read as the rounded bends of one thin line — not as separate dots. */
export const MOUTH_LINE_R = 0.025;

/** Surface z on the unit head for a face feature at head-local (x, y), a hair proud so
 *  the feature sits ON the snow rather than half-sunk. Guards the sqrt against a
 *  feature placed outside the visible cap. */
export function surfaceZ(x: number, y: number, proud = 0.02): number {
  return Math.sqrt(Math.max(0.04, HEAD_R * HEAD_R - x * x - y * y)) + proud;
}

/** The minimal transform surface layoutMouthLine writes — satisfied by THREE.Object3D
 *  and by the plain `{position, scale, rotation}` stand-ins the headless suites use. */
export interface MouthTransformLike {
  position: { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown };
  scale: { set(x: number, y: number, z: number): unknown };
  rotation: { set(x: number, y: number, z: number): unknown };
}

/**
 * Fit each line segment between its two neighbouring joints: positioned at the chord
 * midpoint, stretched to the chord length (unit-height cylinder → scale.y), and rotated
 * about z to lie along the chord (cylinder axis is +y). The tiny out-of-plane z delta
 * between adjacent joints (< the line radius on the head sphere) is absorbed by the
 * joint spheres, so no x-tilt is needed. Skips any missing joint/segment, so a partial
 * rig (or an old test stub without segments) is a safe no-op.
 */
export function layoutMouthLine(
  joints: ReadonlyArray<MouthTransformLike | undefined>,
  segments: ReadonlyArray<MouthTransformLike | undefined>
): void {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const a = joints[i];
    const b = joints[i + 1];
    if (!seg || !a || !b) continue;
    const dx = b.position.x - a.position.x;
    const dy = b.position.y - a.position.y;
    const dz = b.position.z - a.position.z;
    const len = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy + dz * dz));
    seg.position.set(
      (a.position.x + b.position.x) / 2,
      (a.position.y + b.position.y) / 2,
      (a.position.z + b.position.z) / 2
    );
    seg.scale.set(1, len, 1);
    // Rotate the +y cylinder axis onto the chord direction in the face plane.
    seg.rotation.set(0, 0, Math.atan2(dy, dx) - Math.PI / 2);
  }
}
