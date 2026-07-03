// Snowman geometry/model construction.
import * as THREE from 'three';
import { getSnowmanSnowMaterial } from './snow-material.js';

// --- Junction-crease shading (completion-plan PR-V4, the last #17 item) -----
// The ring where two snowballs meet is the snowman's "cavity" (cf. the terrain
// cavity/AO vertex term in mountains/snow-surface.ts): real stacked snow reads a
// faint cool shadow in that crease, while a bare white-on-white seam reads plastic.
// Bake the tint into each sphere's vertex colours (the shared snow material has
// `vertexColors` on) — full strength at/beyond the crease latitude (most of that cap
// is hidden inside the neighbouring ball anyway; the visible fringe gets the fade),
// feathering back to plain white over CREASE_FEATHER of latitude.
const CREASE_TINT = { r: 0.86, g: 0.9, b: 0.95 }; // faint cool powder-shadow hue
const CREASE_FEATHER = 0.25;                       // latitude span of the fade

const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));
const smooth01 = (t: number): number => { const c = clamp01(t); return c * c * (3 - 2 * c); };

/** Bake the crease tint into a body sphere's vertex colours. `top`/`bottom` are the
 *  normalized crease latitudes (localY / radius, -1..1) where this ball meets its
 *  neighbour — derived from the sphere-sphere intersection of the shipped layout. */
function bakeJunctionTint(
  geo: THREE.SphereGeometry,
  radius: number,
  creases: { top?: number; bottom?: number }
): void {
  const pos = geo.attributes.position!;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const ny = pos.getY(i) / radius; // -1 (bottom pole) .. 1 (top pole)
    let k = 0;
    if (creases.top !== undefined) {
      k = Math.max(k, smooth01((ny - (creases.top - CREASE_FEATHER)) / CREASE_FEATHER));
    }
    if (creases.bottom !== undefined) {
      k = Math.max(k, smooth01(((creases.bottom + CREASE_FEATHER) - ny) / CREASE_FEATHER));
    }
    colors[i * 3] = 1 - k * (1 - CREASE_TINT.r);
    colors[i * 3 + 1] = 1 - k * (1 - CREASE_TINT.g);
    colors[i * 3 + 2] = 1 - k * (1 - CREASE_TINT.b);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Create Snowman (Three Spheres)
export function createSnowman(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group();
  // Shared snowman/debris snow material (PR-V4): the same albedo/normal generators as
  // the terrain snow, so the player stops reading as plastic against the slope. One
  // module-level instance shared with the crash debris — see snow-material.ts for the
  // ownership/teardown contract.
  const snowMaterial = getSnowmanSnowMaterial();
  const blackMaterial = new THREE.MeshStandardMaterial({ color: 0x000000 });
  const carrotMaterial = new THREE.MeshStandardMaterial({ color: 0xFF6600 });
  const stickMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 }); // Brown for sticks
  const hatMaterial = new THREE.MeshStandardMaterial({ color: 0x111111 }); // Dark grey/black for hat

  // Crease latitudes from the shipped layout (centres y=2/4.5/7, radii 2/1.5/1):
  // bottom↔middle intersect at world y=3.6 (bottom ny=0.8, middle ny=-0.6);
  // middle↔head are tangent at world y=6.0 (middle ny=1.0, head ny=-1.0).

  // Bottom sphere
  const bottomGeo = new THREE.SphereGeometry(2, 24, 24);
  bakeJunctionTint(bottomGeo, 2, { top: 0.8 });
  const bottom = new THREE.Mesh(bottomGeo, snowMaterial);
  bottom.position.y = 2;
  bottom.castShadow = true;
  group.add(bottom);

  // Middle sphere
  const middleGeo = new THREE.SphereGeometry(1.5, 24, 24);
  bakeJunctionTint(middleGeo, 1.5, { top: 1.0, bottom: -0.6 });
  const middle = new THREE.Mesh(middleGeo, snowMaterial);
  middle.position.y = 4.5;
  middle.castShadow = true;
  group.add(middle);

  // Head sphere
  const headGeo = new THREE.SphereGeometry(1, 24, 24);
  bakeJunctionTint(headGeo, 1, { bottom: -1.0 });
  const head = new THREE.Mesh(headGeo, snowMaterial);
  head.position.y = 7.0; // Lowered head to sit on middle sphere (4.5 + 1.5 + 1.0)
  head.castShadow = true;
  group.add(head);
  
  // Eyes
  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), blackMaterial);
  leftEye.position.set(0.4, 7.2, 0.8); // Adjusted Y based on new head position
  group.add(leftEye);
  
  const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), blackMaterial);
  rightEye.position.set(-0.4, 7.2, 0.8); // Adjusted Y based on new head position
  group.add(rightEye);
  
  // Carrot nose
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1, 12), carrotMaterial);
  nose.position.set(0, 7.0, 1); // Adjusted Y based on new head position
  nose.rotation.x = Math.PI / 2;
  group.add(nose);
  
  // Buttons (on middle and bottom spheres)
  const buttonGeometry = new THREE.SphereGeometry(0.15, 12, 12);
  const button1 = new THREE.Mesh(buttonGeometry, blackMaterial);
  button1.position.set(0, 5.5, 1.4); // On middle sphere front
  group.add(button1);
  
  const button2 = new THREE.Mesh(buttonGeometry, blackMaterial);
  button2.position.set(0, 4.5, 1.45); // On middle sphere front
  group.add(button2);
  
  const button3 = new THREE.Mesh(buttonGeometry, blackMaterial);
  button3.position.set(0, 3.0, 1.9); // On bottom sphere front
  group.add(button3);
  
  // --- Stick Arms ---
  // Create a function to build a branched arm
  function createBranchArm(isLeft: boolean): THREE.Group {
    const armGroup = new THREE.Group();
    const mainStickLength = 2.5;
    const mainStickRadius = 0.08; // Slightly thinner radius
    const segments = 8; // Segments for the tube

    // Create a slightly irregular path for the main stick
    const pathPoints = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, mainStickLength * 0.4, isLeft ? 0.1 : -0.1), // Slight bend
      new THREE.Vector3(isLeft ? -0.1 : 0.1, mainStickLength * 0.8, 0), // Another slight bend
      new THREE.Vector3(0, mainStickLength, 0) // End point
    ];
    const curve = new THREE.CatmullRomCurve3(pathPoints);

    // Main stick using TubeGeometry
    const mainStickGeom = new THREE.TubeGeometry(curve, segments * 2, mainStickRadius, 5, false); // Fewer radial segments
    const mainStick = new THREE.Mesh(mainStickGeom, stickMaterial);
    // No need to translate geometry origin with TubeGeometry path starting at 0,0,0
    mainStick.rotation.z = isLeft ? -Math.PI / 10 : Math.PI / 10; // Adjusted angle slightly
    mainStick.castShadow = true;
    armGroup.add(mainStick);

    // Small branch 1 (thinner)
    const branch1Length = 0.8;
    const branch1Radius = 0.05;
    const branch1 = new THREE.Mesh(
      new THREE.CylinderGeometry(branch1Radius, branch1Radius * 0.7, branch1Length, 5), // Fewer segments
      stickMaterial
    );
    branch1.geometry.translate(0, branch1Length / 2, 0); // Move origin to base
    // Attach near the first bend point using curve.getPointAt
    const attachPoint1 = curve.getPointAt(0.5); // Get point halfway along the curve
    branch1.position.copy(attachPoint1);
    branch1.rotation.z = isLeft ? -Math.PI / 5 : Math.PI / 5; // Angle outward more
    branch1.rotation.x = Math.PI / 12; // Angle slightly forward
    branch1.castShadow = true;
    mainStick.add(branch1); // Add as child of main stick

    // Small branch 2 (optional, smaller and thinner)
    const branch2Length = 0.5;
    const branch2Radius = 0.04;
    const branch2 = new THREE.Mesh(
      new THREE.CylinderGeometry(branch2Radius, branch2Radius * 0.7, branch2Length, 5), // Fewer segments
      stickMaterial
    );
    branch2.geometry.translate(0, branch2Length / 2, 0); // Move origin to base
    // Attach near the second bend point
    const attachPoint2 = curve.getPointAt(0.8); // Get point further along the curve
    branch2.position.copy(attachPoint2);
    branch2.rotation.z = isLeft ? Math.PI / 4 : -Math.PI / 4; // Angle more sharply
    branch2.rotation.x = -Math.PI / 10; // Angle slightly backward
    branch2.castShadow = true;
    mainStick.add(branch2); // Add as child of main stick

    // Position the entire arm group
    // Attach to middle sphere, slightly adjusted position
    armGroup.position.set(isLeft ? 1.35 : -1.35, 4.9, 0); // Adjusted position slightly
    // Rotate slightly forward and outward
    armGroup.rotation.x = Math.PI / 16; // Less forward tilt
    armGroup.rotation.y = isLeft ? -Math.PI / 8 : Math.PI / 8; // Rotate arms outward more

    return armGroup;
  }

  // Left Arm
  const leftArmGroup = createBranchArm(true);
  group.add(leftArmGroup);

  // Right Arm
  const rightArmGroup = createBranchArm(false);
  group.add(rightArmGroup);
  // --- End Stick Arms ---
  
  // Hat
  const hatBase = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.2, 24), hatMaterial);
  hatBase.position.y = 7.9; // Adjusted Y based on new head position: 7.0 (head_y) + 1.0 (head_r) - 0.1
  hatBase.castShadow = true;
  group.add(hatBase);
  
  const hatTop = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.9, 24), hatMaterial);
  hatTop.position.y = 8.45; // Adjusted Y: 7.9 (base_y) + 0.1 (base_half_h) + 0.45 (new_top_half_h)
  hatTop.castShadow = true;
  group.add(hatTop);
  
  // --- Shaped skis (issue #189) ---------------------------------------------
  // Real ski geometry instead of two flat boxes: a custom lofted BufferGeometry
  // with sidecut (wide shovel -> narrow waist -> medium tail), a smooth shovel/tip
  // rise, a small tail kick, rounded end caps, a visible binding block, and three
  // materials (red top-sheet, dark base, steel-edge accent). Each ski is a pose-owned
  // root GROUP holding two pivot arms (tip + tail) that overlap at the waist so the
  // surface reads as one continuous ski; the cosmetic flex layer (src/snowman-flex.ts)
  // bends those arms (rotation.x only) for camber/landing/carve, while pose.ts still
  // owns the root transform (snowplow wedge / parallel edge+draw). See buildSkiArm().
  // DoubleSide keeps the hand-wound loft solid from every angle (no reliance on a
  // single correct triangle winding across the lofted tube + caps).
  const topSheetMat = new THREE.MeshStandardMaterial({ color: 0xD42B2B, roughness: 0.5, side: THREE.DoubleSide }); // red top-sheet
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x1A1A20, roughness: 0.7, side: THREE.DoubleSide });     // dark sintered base
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xB8BCC4, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide }); // steel edge
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x202024, roughness: 0.6 });     // binding boot
  const plateMat = new THREE.MeshStandardMaterial({ color: 0x55585F, roughness: 0.4, metalness: 0.5 }); // binding plate
  const skiMats = [topSheetMat, baseMat, steelMat];

  // Build one ski (root group + tip/tail arms + binding). Mirrored by `side`.
  function createShapedSki(side: number): { root: THREE.Group; tipArm: THREE.Mesh; tailArm: THREE.Mesh } {
    const root = new THREE.Group();
    root.position.set(side, 0.1, 1);

    // Two arms share the SAME longitudinal profile sampled in absolute ski-z, so their
    // cross-sections are identical at the waist seam; each is built in arm-local space
    // (waist at z=0) and overlaps SKI_SEAM_OVERLAP past the waist so a flex bend never
    // opens a visible gap. Pivot lives at the waist (root-local z = SKI_Z_WAIST).
    const tipArm = new THREE.Mesh(buildSkiArm(SKI_Z_WAIST - SKI_SEAM_OVERLAP, SKI_Z_TIP), skiMats);
    const tailArm = new THREE.Mesh(buildSkiArm(SKI_Z_TAIL, SKI_Z_WAIST + SKI_SEAM_OVERLAP), skiMats);
    for (const arm of [tipArm, tailArm]) {
      arm.position.z = SKI_Z_WAIST; // arm-local origin -> waist pivot
      arm.castShadow = true;
      root.add(arm);
    }

    // Binding: a metal plate + boot block, parented to the ROOT (not the arms) so it sits
    // over the waist seam and hides the joint while the arms flex underneath it.
    const binding = new THREE.Group();
    const waistY = sampleProfile(SKI_Z_WAIST, SKI_CENTER_Y);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.9), plateMat);
    plate.position.set(0, waistY + 0.075, 0);
    plate.castShadow = true;
    binding.add(plate);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.52), bootMat);
    boot.position.set(0, waistY + 0.2, 0.02);
    boot.castShadow = true;
    binding.add(boot);
    binding.position.z = SKI_Z_WAIST;
    root.add(binding);

    group.add(root);
    return { root, tipArm, tailArm };
  }

  const left = createShapedSki(-1);
  const right = createShapedSki(1);
  const leftSki = left.root, rightSki = right.root;

  // --- Scarf (issue #53, optional follow-up PR C) ---------------------------
  // A red wool scarf: a torus wrap at the narrow neck seam + a short two-segment tail
  // draped down the front. The tail is its own neck-pivoted group so the flex layer can
  // swing it in the wind (Flex already handles `scarfTail` present-or-absent), and both
  // join the registries below so the crash shatter flings them too. Kept OUT of the head
  // cluster so head bob doesn't drag the scarf.
  const scarfMaterial = new THREE.MeshStandardMaterial({ color: 0xCC2222, roughness: 1.0 });
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.26, 8, 16), scarfMaterial);
  scarf.position.set(0, 6.1, 0);
  scarf.rotation.x = Math.PI / 2; // lie flat around the neck
  scarf.castShadow = true;
  group.add(scarf);

  const scarfTail = new THREE.Group();
  const tailSeg1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.7, 0.16), scarfMaterial);
  tailSeg1.position.y = -0.35;
  tailSeg1.castShadow = true;
  scarfTail.add(tailSeg1);
  const tailSeg2 = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.6, 0.14), scarfMaterial);
  tailSeg2.position.set(0.04, -0.9, 0);
  tailSeg2.rotation.z = -0.18;
  tailSeg2.castShadow = true;
  scarfTail.add(tailSeg2);
  // Anchor at the neck-front and DRAPE FORWARD so the tail hangs in front of the middle
  // snowball instead of being buried inside it: the middle sphere (center y=4.5, r=1.5)
  // bulges out to z≈1.1–1.3 over the tail's vertical range, so a straight tail at z≈0.55
  // would be occluded by the opaque body. Tilting the group forward (rotation.x ≈ -0.6)
  // sends its local -Y axis down-and-out (+z), keeping the tail just outside the chest
  // surface and visible in the front/chase view. Flex preserves this drape (it offsets
  // rotation.x from the base) and only swings rotation.z in the wind.
  scarfTail.position.set(0.3, 6.25, 0.75); // neck-front, just outside the narrow neck
  scarfTail.rotation.x = -0.8;             // drape forward over the chest (clears the snowball)
  group.add(scarfTail);
  // Verified: at the resting base angle and the flex-animated grounded (+0.1) and
  // airborne (-0.3) offsets, both tail segments stay in front of the body spheres.

  // --- Head cluster (issue #53) ---------------------------------------------
  // Parent the head sphere AND its accessories (eyes, nose, hat) into one
  // neck-pivoted group so the flexibility/jiggle layer (src/snowman-flex.ts) can
  // bob/lean the whole face + hat together instead of sliding the accessories off a
  // bare head mesh. Re-basing each child's y by NECK_Y keeps world positions
  // identical at rest, so this is purely structural — no visual or physics change.
  // headGroup is a THREE.Group (no geometry/material), which the PR-B shatter loop
  // handles via its isMesh branch (the whole head breaks off as one piece).
  const NECK_Y = 6.0; // top of the middle sphere / base of the head — a natural pivot
  const headGroup = new THREE.Group();
  headGroup.position.set(0, NECK_Y, 0);
  for (const part of [head, leftEye, rightEye, nose, hatBase, hatTop]) {
    part.position.y -= NECK_Y;   // into headGroup-local space (identical world y)
    headGroup.add(part);         // Object3D.add() reparents from `group`
  }
  group.add(headGroup);

  // Keep references + neutral pose so ski technique (e.g. snowplow wedge) can be shown.
  group.userData = group.userData || {};
  group.userData.leftSki = leftSki;
  group.userData.rightSki = rightSki;
  group.userData.leftSkiBaseX = leftSki.position.x;
  group.userData.rightSkiBaseX = rightSki.position.x;

  // --- Cosmetic part registries (issue #53) ---------------------------------
  // FLEX registry: fine-grained animatable refs read by src/snowman-flex.ts. Every
  // value is a renderable Object3D; headGroup is the neck-pivoted cluster above.
  group.userData.parts = {
    bottom, middle,
    headGroup, head,
    leftEye, rightEye, nose,
    button1, button2, button3,
    leftArmGroup, rightArmGroup,
    hatBase, hatTop,
    scarf, scarfTail,
    // Ski flex arms (issue #189): the only ski transforms the flex layer writes
    // (rotation.x bend). The ski ROOTS (leftSki/rightSki) stay off the registry so
    // pose.ts keeps sole ownership of the wedge/edge/draw transform.
    leftSkiTip: left.tipArm, leftSkiTail: left.tailArm,
    rightSkiTip: right.tipArm, rightSkiTail: right.tailArm
  };
  // SHATTER roots: the flat list of TOP-LEVEL rigid pieces the PR-B debris system
  // flings, so accessories ride with their cluster instead of being double-spawned.
  // headGroup + arms (+ scarfTail) are THREE.Groups; the shatter loop branches on
  // `part.isMesh` (the scarf wrap is a Mesh).
  group.userData.shatterRoots = [
    bottom, middle, headGroup,
    leftArmGroup, rightArmGroup,
    button1, button2, button3,
    scarf, scarfTail
  ];
  // --- Freestyle flip pivot (jump-system completion JP-5, plan §6.1) ----------
  // The group root's origin sits at the SKI BASE (spheres at y = 2 / 4.5 / 7), so a
  // flip applied to the root orbits the feet — visually wrong (a somersault rotates
  // about the body's center of mass). Interpose one child group at the mass-weighted
  // center (radii 2 / 1.5 / 1 ⇒ masses ∝ 8 / 3.375 / 1 ⇒ COM ≈ y 3.1) holding EVERY
  // part (skis included — the whole snowman flips), each child re-based by −COM_Y so
  // world placement is identical at rest. pose.ts applies `trickFlip` to THIS pivot
  // while the root keeps position / yaw / terrain tilt — so the follow camera (which
  // reads the root) stays steady through a flip. Purely structural: the userData
  // part/shatter registries keep their references (debris resolves world transforms
  // via getWorldPosition), and partBaseTransforms below is recorded AFTER the
  // restructure so the flex layer's neutral bases match the new locals.
  const COM_Y = 3.1;
  const flipPivot = new THREE.Group();
  flipPivot.position.y = COM_Y;
  for (const child of [...group.children]) {
    child.position.y -= COM_Y;
    flipPivot.add(child); // Object3D.add() reparents from `group`
  }
  group.add(flipPivot);
  group.userData.flipPivot = flipPivot;

  // Neutral local transforms, kept OFF the registries so a generic loop over .parts
  // / .shatterRoots only ever sees renderable Object3Ds. Keyed by the same names so
  // the flex layer can pair part <-> base and restore exactly on reset.
  group.userData.partBaseTransforms = recordBaseTransforms(group.userData.parts);

  scene.add(group);
  return group;
}

/** A plain-number snapshot of a part's neutral local transform. */
interface BaseTransform {
  position: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
}

/** Snapshot each part's neutral local position/scale/rotation so the cosmetic flex
 *  layer can animate as offsets from neutral and restore exactly on reset. Stored as
 *  plain numbers (not Vector3/Euler) so the baseline survives independent of the live
 *  object's later mutation. */
function recordBaseTransforms(parts: Record<string, THREE.Object3D>): Record<string, BaseTransform> {
  const out: Record<string, BaseTransform> = {};
  for (const [key, p] of Object.entries(parts)) {
    out[key] = {
      position: { x: p.position.x, y: p.position.y, z: p.position.z },
      scale: { x: p.scale.x, y: p.scale.y, z: p.scale.z },
      rotation: { x: p.rotation.x, y: p.rotation.y, z: p.rotation.z }
    };
  }
  return out;
}

// --- Ski longitudinal profile (issue #189) ----------------------------------
// The ski is a loft along its length (absolute ski-z: -z = tail, +z = tip), driven by
// two control-point curves smoothly interpolated by sampleProfile(). SKI_WIDTH is the
// top-view half-width (the sidecut: wide shovel, narrow waist, medium tail, pinched to
// rounded end caps); SKI_CENTER_Y is the side-profile centerline (a gentle camber bump
// at the waist, a rising shovel toward the tip, and a small tail kick). Both arms sample
// these in absolute z, so their shared waist cross-section matches exactly (no seam).
const SKI_Z_TAIL = -2.9;
const SKI_Z_TIP = 3.3;
const SKI_Z_WAIST = -0.1;       // pivot / binding location
const SKI_SEAM_OVERLAP = 0.28;  // how far each arm runs past the waist to hide the bend seam

type ProfilePt = readonly [number, number]; // [ski-z, value]
const SKI_WIDTH: ReadonlyArray<ProfilePt> = [
  [-2.9, 0.06], [-2.5, 0.21], [-2.0, 0.25], [-0.1, 0.17],
  [1.6, 0.29], [2.2, 0.30], [3.0, 0.19], [3.3, 0.06]
];
const SKI_CENTER_Y: ReadonlyArray<ProfilePt> = [
  [-2.9, 0.17], [-2.4, 0.05], [-1.8, 0.0], [-0.1, 0.04],
  [1.6, 0.0], [2.4, 0.13], [3.0, 0.31], [3.3, 0.47]
];

const smoothstep = (t: number): number => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/** Smoothly interpolate a control-point curve at ski-z (clamped, smoothstep between pts). */
function sampleProfile(z: number, pts: ReadonlyArray<ProfilePt>): number {
  if (z <= pts[0]![0]) return pts[0]![1];
  const n = pts.length;
  if (z >= pts[n - 1]![0]) return pts[n - 1]![1];
  for (let i = 0; i < n - 1; i++) {
    const [z0, v0] = pts[i]!, [z1, v1] = pts[i + 1]!;
    if (z >= z0 && z <= z1) return v0 + (v1 - v0) * smoothstep((z - z0) / (z1 - z0));
  }
  return pts[n - 1]![1];
}

/** Thickness taper -> 0 toward both ends so the caps round off instead of ending blunt. */
function skiThicknessScale(z: number): number {
  const fade = 0.55;
  return 0.18 + 0.82 * Math.min(smoothstep((SKI_Z_TIP - z) / fade), smoothstep((z - SKI_Z_TAIL) / fade));
}

// Cross-section ring: 6 vertices (base-L, mid-L, top-L, top-R, mid-R, base-R). The mid
// vertices are the widest line — the steel edge. The 6 ring edges map to materials:
//   0:(0-1) lower-left  -> steel    3:(3-4) upper-right -> top-sheet
//   1:(1-2) upper-left  -> top-sheet 4:(4-5) lower-right -> steel
//   2:(2-3) top         -> top-sheet 5:(5-0) base        -> base
const RING_MAT: ReadonlyArray<number> = [2, 0, 0, 0, 2, 1]; // 0=top-sheet,1=base,2=steel

/** Build one ski arm as a lofted, capped BufferGeometry with three material groups
 *  (top-sheet / base / steel-edge). `z0..z1` is the absolute ski-z span; vertices are
 *  emitted in arm-local space (waist at z=0) so the mesh can pivot at the waist. */
function buildSkiArm(z0: number, z1: number): THREE.BufferGeometry {
  const STATIONS = 22;
  const positions: number[] = [];
  // Per-material triangle index buckets, concatenated into one index buffer + groups.
  const buckets: number[][] = [[], [], []]; // top-sheet, base, steel

  for (let s = 0; s < STATIONS; s++) {
    const z = z0 + (z1 - z0) * (s / (STATIONS - 1));
    const w = sampleProfile(z, SKI_WIDTH);
    const cy = sampleProfile(z, SKI_CENTER_Y);
    const ts = skiThicknessScale(z);
    const topH = 0.05 * ts, baseH = 0.07 * ts;
    const wTop = w * 0.82, wMid = w, wBase = w * 0.9;
    const lz = z - SKI_Z_WAIST; // arm-local z (waist pivot at 0)
    positions.push(
      -wBase, cy - baseH, lz,   // 0 base-left
      -wMid, cy, lz,            // 1 mid-left (steel)
      -wTop, cy + topH, lz,     // 2 top-left
      wTop, cy + topH, lz,      // 3 top-right
      wMid, cy, lz,             // 4 mid-right (steel)
      wBase, cy - baseH, lz     // 5 base-right
    );
  }

  // Side quads between adjacent stations (consistent winding around the tube).
  for (let s = 0; s < STATIONS - 1; s++) {
    const a = s * 6, b = (s + 1) * 6;
    for (let e = 0; e < 6; e++) {
      const r0 = e, r1 = (e + 1) % 6;
      const v00 = a + r0, v01 = a + r1, v10 = b + r0, v11 = b + r1;
      buckets[RING_MAT[e]!]!.push(v00, v10, v11, v00, v11, v01);
    }
  }

  // End caps: a center vertex per end + a fan to its ring, so the arm reads solid and
  // casts a clean shadow. Both caps ride with the top-sheet group.
  const ringCenter = (s: number): number => {
    const base = s * 6, idx = positions.length / 3;
    // average the ring's 6 verts for a centroid cap vertex
    let x = 0, y = 0, zz = 0;
    for (let r = 0; r < 6; r++) { x += positions[(base + r) * 3]!; y += positions[(base + r) * 3 + 1]!; zz += positions[(base + r) * 3 + 2]!; }
    positions.push(x / 6, y / 6, zz / 6);
    return idx;
  };
  const c0 = ringCenter(0);
  for (let e = 0; e < 6; e++) buckets[0]!.push(c0, (e + 1) % 6, e);
  const last = (STATIONS - 1) * 6;
  const cN = ringCenter(STATIONS - 1);
  for (let e = 0; e < 6; e++) buckets[0]!.push(cN, last + e, last + (e + 1) % 6);

  const indices = [...buckets[0]!, ...buckets[1]!, ...buckets[2]!];
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.addGroup(0, buckets[0]!.length, 0);
  geom.addGroup(buckets[0]!.length, buckets[1]!.length, 1);
  geom.addGroup(buckets[0]!.length + buckets[1]!.length, buckets[2]!.length, 2);
  geom.computeVertexNormals();
  return geom;
}
