// Snowman face rig — the static procedural expression geometry (issue #364, PR 1).
//
// Builds the coal-bead mouth, twig eyebrows, frosty cheeks, and eye-highlight dots
// and parents them UNDER the head mesh (like the existing eyes/nose), so the flex
// layer's per-frame head squash/stretch carries them along the moving face surface
// (the same fix the eyes/nose/hat got in issue #337). Every new part joins the
// cosmetic part registry so recordBaseTransforms() snapshots its neutral pose; the
// expression controller (src/snowman-expression.ts, PR 2+) animates these as offsets
// from neutral, exactly like the flex layer animates the balls/head/skis.
//
// PURE GEOMETRY here — no animation, no physics, no RNG. Determinism / perf notes:
//  - The snowman is constructed LAST in scene-setup (after terrain/rocks/trees/
//    scenery), so the THREE UUID draws these meshes make have no downstream seeded
//    consumer — placement is already done. This module adds NO Math.random of its own.
//  - Geometry is SHARED across repeated parts (one bead sphere for all 7 beads, one
//    brow cylinder, one cheek sphere, one highlight sphere) so the live BufferGeometry
//    count grows by 4, not 13 (perf-budget `geometries` is tight).
//  - Both new materials are plain MeshStandardMaterials (colour-only), so they share
//    the existing "plain standard" shader program — +0 compiled programs (the
//    perf-budget `programs` ceiling is tight). The coal beads/brows reuse the caller's
//    shared black material.
//  - Face parts do NOT castShadow (matching the existing eyes/nose): tiny parts on the
//    face self-shadow into noise and would only add shadow-pass draw calls.
//  - Blink/squint is done by the controller SCALING the existing eye meshes, so no
//    eyelid geometry is needed here.
//
// Disposal: every mesh here is reachable via obj.geometry / obj.material under the
// snowman in the scene, so disposeGame's dedup scene-traversal sweep (game/teardown.ts)
// frees each unique geometry/material exactly once at unmount. No explicit teardown.
import * as THREE from 'three';

/** The animatable face parts, handed back to the model so it can merge them into the
 *  cosmetic part registry. Every value is a renderable Object3D. The pre-existing
 *  `leftEye`/`rightEye` stay in the registry unchanged (the controller squashes them
 *  for blink/squint), and their highlight dots ride under them as `leftPupil`/
 *  `rightPupil`. */
export interface SnowmanFaceParts {
  mouth: THREE.Group;
  mouthBeads: THREE.Mesh[];
  leftBrow: THREE.Object3D;
  rightBrow: THREE.Object3D;
  leftCheek: THREE.Object3D;
  rightCheek: THREE.Object3D;
  leftPupil: THREE.Object3D;
  rightPupil: THREE.Object3D;
}

// --- Geometry / layout constants (head-LOCAL space) --------------------------
// The head is a unit sphere (radius 1) centred at the head mesh's local origin; the
// face looks down +z (nose at z=1, eyes at z≈0.8). Every position below is head-local.
const HEAD_R = 1.0;
const BEAD_COUNT = 7;                 // coal beads along the mouth curve (7–9 reads well)
const MOUTH_Y = -0.42;                // mouth centre latitude on the face
const MOUTH_HALF_WIDTH = 0.42;        // x reach of the outermost bead
const MOUTH_SMILE_BASE = 0.12;        // neutral pose is a gentle relaxed smile (ends up)
const BEAD_RADIUS = 0.055;
const BROW_Y = 0.52;                  // brows sit above the eyes (eyes at y≈0.2)
const BROW_X = 0.4;                   // same x as the eyes
const BROW_LEN = 0.42;
const BROW_TILT = 0.18;               // slight inward-down "resting" angle (rad)
const CHEEK_X = 0.62;
const CHEEK_Y = -0.16;
const PUPIL_R = 0.05;                 // white highlight dots ride under the eyes (radius 0.15)

/** Surface z on the unit head for a face feature at (x, y), pushed a hair proud so the
 *  part sits ON the snow rather than half-sunk into it. Guards the sqrt against a
 *  feature placed outside the visible cap. */
function surfaceZ(x: number, y: number, proud = 0.02): number {
  const inside = HEAD_R * HEAD_R - x * x - y * y;
  return Math.sqrt(Math.max(0.04, inside)) + proud;
}

/**
 * Build the face rig and parent it under `head`. `coalMaterial` is the caller's shared
 * black material (reused for the coal beads and twig brows); `leftEye`/`rightEye` are
 * the existing coal eyes (already parented under `head`) that the highlight dots ride.
 * Returns the animatable parts for the registry.
 */
export function createFace(
  head: THREE.Mesh,
  coalMaterial: THREE.Material,
  leftEye: THREE.Object3D,
  rightEye: THREE.Object3D
): SnowmanFaceParts {
  // Frosty cheek + eye-highlight materials. Plain colour-only MeshStandardMaterials so
  // they share the existing "plain standard" shader program (perf-budget: +0 programs).
  const cheekMaterial = new THREE.MeshStandardMaterial({ color: 0xE8909A, roughness: 0.9 }); // faint frosty pink
  const highlightMaterial = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.4, emissive: 0x222222 });

  // --- Coal-bead mouth ------------------------------------------------------
  // A neck-pivoted-style group at the mouth centre so the controller can nudge/tilt the
  // whole mouth, with 7 beads whose individual y the controller reshapes into
  // smile / flat / gritted / frown / O. Beads share ONE sphere geometry.
  const beadGeo = new THREE.SphereGeometry(BEAD_RADIUS, 8, 6);
  const mouth = new THREE.Group();
  mouth.position.set(0, MOUTH_Y, 0);
  const mouthBeads: THREE.Mesh[] = [];
  for (let i = 0; i < BEAD_COUNT; i++) {
    // Even spread across [-halfWidth, +halfWidth]; single bead guard avoids /0.
    const t = BEAD_COUNT > 1 ? (i / (BEAD_COUNT - 1)) * 2 - 1 : 0; // -1..1
    const x = t * MOUTH_HALF_WIDTH;
    // Neutral = gentle smile: the ends lift by MOUTH_SMILE_BASE*t². y is mouth-LOCAL
    // (the group already sits at MOUTH_Y), so the bead's head-local latitude is MOUTH_Y+y.
    const y = MOUTH_SMILE_BASE * t * t;
    const z = surfaceZ(x, MOUTH_Y + y);
    const bead = new THREE.Mesh(beadGeo, coalMaterial);
    bead.position.set(x, y, z);
    mouth.add(bead);
    mouthBeads.push(bead);
  }
  head.add(mouth);

  // --- Twig eyebrows --------------------------------------------------------
  // Short coal/twig cylinders above each eye. Built lying along local x (rotate the
  // cylinder's y-axis onto x), with a slight resting tilt; the controller rotates/raises
  // them for focus / panic / joy. Shared geometry.
  const browGeo = new THREE.CylinderGeometry(0.05, 0.05, BROW_LEN, 6);
  function makeBrow(sign: number): THREE.Object3D {
    const brow = new THREE.Mesh(browGeo, coalMaterial);
    brow.position.set(sign * BROW_X, BROW_Y, surfaceZ(sign * BROW_X, BROW_Y));
    // Cylinder default axis is +y; lay it horizontal (along x) then add a small inward
    // downward tilt so the resting brow reads relaxed, not angry.
    brow.rotation.z = Math.PI / 2 + sign * BROW_TILT;
    return brow;
  }
  const leftBrow = makeBrow(1);   // +x side (the snowman's own left as built, matching leftEye)
  const rightBrow = makeBrow(-1);
  head.add(leftBrow);
  head.add(rightBrow);

  // --- Frosty cheeks --------------------------------------------------------
  // Faint pink flattened spheres beside the nose. Flattened via mesh scale so the one
  // shared sphere geometry serves both. The controller pops them on a big smile / land.
  const cheekGeo = new THREE.SphereGeometry(0.16, 8, 8);
  function makeCheek(sign: number): THREE.Object3D {
    const cheek = new THREE.Mesh(cheekGeo, cheekMaterial);
    cheek.position.set(sign * CHEEK_X, CHEEK_Y, surfaceZ(sign * CHEEK_X, CHEEK_Y, -0.04));
    cheek.scale.set(1, 0.7, 0.35); // press flat against the face
    return cheek;
  }
  const leftCheek = makeCheek(1);
  const rightCheek = makeCheek(-1);
  head.add(leftCheek);
  head.add(rightCheek);

  // --- Eye-highlight dots ---------------------------------------------------
  // Tiny white dots parented UNDER each coal eye (eye-local space) so they ride the
  // eye's squash/blink; the controller can also shift them a touch toward a turn/hazard.
  // The eyes are spheres of radius 0.15 centred at head-local (±0.4, 0.2, 0.8).
  const pupilGeo = new THREE.SphereGeometry(PUPIL_R, 6, 6);
  function makePupil(): THREE.Object3D {
    const pupil = new THREE.Mesh(pupilGeo, highlightMaterial);
    // Eye-local: upper-front of the coal eye (eye radius 0.15, so 0.11 sits proud).
    pupil.position.set(0, 0.04, 0.11);
    return pupil;
  }
  const leftPupil = makePupil();
  const rightPupil = makePupil();
  leftEye.add(leftPupil);
  rightEye.add(rightPupil);

  return { mouth, mouthBeads, leftBrow, rightBrow, leftCheek, rightCheek, leftPupil, rightPupil };
}
