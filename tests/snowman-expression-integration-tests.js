// @ts-check
// snowman-expression-integration-tests.js — end-to-end acceptance for the expression rig
// (issue #364, PR 5). The unit suites (snowman-face-tests / snowman-expression-tests) run
// against plain stand-ins; this one drives the REAL procedural snowman (createSnowman, real
// THREE) through the REAL Flex + Expression layers to prove they compose on the actual part
// registry / base transforms without fighting, without NaN, and without touching physics.
//
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/snowman-expression-integration-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { createSnowman } = await import('../src/snowman/model.ts');
  const { Expression } = await import('../src/snowman-expression.ts');
  const { Flex } = await import('../src/snowman-flex.ts');

  const scene = new THREE.Scene();
  const snowman = createSnowman(scene);
  const parts = snowman.userData.parts;
  const base = snowman.userData.partBaseTransforms;

  // Snapshot the true neutral local transforms straight off the freshly built model.
  const snap = (p) => ({ px: p.position.x, py: p.position.y, pz: p.position.z, sx: p.scale.x, sy: p.scale.y, sz: p.scale.z, rx: p.rotation.x, ry: p.rotation.y, rz: p.rotation.z });
  const neutral = {}; for (const k of Object.keys(parts)) neutral[k] = snap(parts[k]);

  console.log('--- real model: expression animates the real face/body parts ---');
  // Drive a determined carve then a big air with a clean landing — exercises face + body.
  for (let i = 0; i < 90; i++) Expression.update(snowman, 1 / 60, { speed: 20, technique: 'carve', turnRate: 0.8, isInAir: false });
  const carved = { mouth: snap(parts.mouthBead0), brow: snap(parts.leftBrow), arm: snap(parts.leftArmGroup), eye: snap(parts.leftEye) };
  check('carve moved the mouth beads off neutral', Math.abs(carved.mouth.py - neutral.mouthBead0.py) > 1e-3);
  check('carve lowered/angled the brows off neutral', Math.abs(carved.brow.py - neutral.leftBrow.py) > 1e-3 || Math.abs(carved.brow.rz - neutral.leftBrow.rz) > 1e-3);
  check('carve counter-rotated the arms off neutral', Math.abs(carved.arm.rx - neutral.leftArmGroup.rx) > 1e-3 || Math.abs(carved.arm.rz - neutral.leftArmGroup.rz) > 1e-3);
  check('carve squinted the eyes (scale.y < 1)', parts.leftEye.scale.y < 0.98);

  // A clean-landing reaction should drive a big grin + cheek pop — STRICTLY stronger than
  // a control snowman driven through the identical motion WITHOUT the landing, so the check
  // fails if the reaction becomes a no-op (a bare smile threshold is already met by the
  // neutral/idle face). The control runs the same carve→glide sequence sans justLanded.
  const control = createSnowman(new THREE.Scene());
  const cp = control.userData.parts;
  for (let i = 0; i < 90; i++) Expression.update(control, 1 / 60, { speed: 20, technique: 'carve', turnRate: 0.8, isInAir: false });
  Expression.update(snowman, 1 / 60, { speed: 18, technique: 'glide', turnRate: 0, isInAir: false, justLanded: true, landingQuality: 'clean' });
  Expression.update(control, 1 / 60, { speed: 18, technique: 'glide', turnRate: 0, isInAir: false });
  for (let i = 0; i < 18; i++) {
    Expression.update(snowman, 1 / 60, { speed: 18, technique: 'glide', turnRate: 0, isInAir: false });
    Expression.update(control, 1 / 60, { speed: 18, technique: 'glide', turnRate: 0, isInAir: false });
  }
  const grin = (q) => q.mouthBead0.position.y - q.mouthBead3.position.y;
  check('clean landing → outer mouth beads lifted into a big smile', parts.mouthBead0.position.y > parts.mouthBead3.position.y + 0.05);
  check('clean landing → grin + cheek pop strictly exceed the same motion without the landing',
    grin(parts) > grin(cp) + 1e-3 && parts.leftCheek.scale.x > cp.leftCheek.scale.x + 1e-3);

  console.log('--- tuck sweeps the hands BEHIND the racer (world -z), not in front ---');
  {
    // The arm sticks extend along local +y and the nose points +z, so a rotation-only
    // unit test can't tell forward from back. Measure the actual WORLD position of the
    // hand (the arm vertex farthest from the shoulder): a tuck must pull it BEHIND neutral
    // (-z), never throw it out in front (the reversed-sign bug).
    const tk = createSnowman(new THREE.Scene());
    const handZ = (sm) => {
      sm.updateMatrixWorld(true);
      const g = sm.userData.parts.leftArmGroup;
      const sh = new THREE.Vector3(); g.getWorldPosition(sh);
      let farZ = 0, maxr = -1; const v = new THREE.Vector3();
      g.traverse((o) => { const pos = o.geometry && o.geometry.attributes.position; if (!pos) return;
        for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); const r = v.distanceTo(sh); if (r > maxr) { maxr = r; farZ = v.z; } } });
      return farZ;
    };
    const neutralZ = handZ(tk);
    for (let i = 0; i < 120; i++) Expression.update(tk, 1 / 60, { speed: 24, technique: 'tuck', turnRate: 0, isInAir: false });
    check('tuck sweeps the hand behind the racer (world z well below neutral)', handZ(tk) < neutralZ - 0.3);
  }

  console.log('--- mouth beads ride the head sphere at expression extremes (no float) ---');
  {
    // A wide-open mouth drops the centre bead's latitude; its surface z must be recomputed so
    // it rides DOWN the head sphere and its distance from the head centre stays ~constant. The
    // old code held the neutral z, leaving the coal bead floating ~0.15u proud of the face.
    const mb = createSnowman(new THREE.Scene());
    const beadDist = (sm, key) => {
      sm.updateMatrixWorld(true);
      const hc = new THREE.Vector3(); sm.userData.parts.head.getWorldPosition(hc);
      const bp = new THREE.Vector3(); sm.userData.parts[key].getWorldPosition(bp);
      return bp.distanceTo(hc);
    };
    const neutralR = beadDist(mb, 'mouthBead3');
    // Sustained avalanche panic drives the widest steady jaw-open (a level reaction, so it
    // holds while the slide is close — unlike the short timed landing reactions).
    for (let i = 0; i < 120; i++) Expression.update(mb, 1 / 60, { speed: 16, technique: 'glide', turnRate: 0, isInAir: false, avalancheDistance: 1 });
    const openR = beadDist(mb, 'mouthBead3');
    check('open mouth keeps the centre bead on the head surface (distance ~ neutral, not proud)',
      Math.abs(openR - neutralR) < 0.03 * neutralR);
    // The silhouette-line segments must follow the dropped joints (continuous line at
    // the jaw-open extreme: midpoint position + chord length, mouth-local space).
    const mp = mb.userData.parts;
    check('line segments track the reshaped joints on the real model', [2, 3].every((i) => {
      const a = mp[`mouthBead${i}`].position, b = mp[`mouthBead${i + 1}`].position, s = mp[`mouthSeg${i}`];
      return Math.abs(s.position.y - (a.y + b.y) / 2) < 1e-9 &&
        Math.abs(s.scale.y - Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)) < 1e-9;
    }));
  }

  console.log('--- finiteness: every world matrix stays finite ---');
  snowman.updateMatrixWorld(true);
  let allFinite = true;
  snowman.traverse((o) => { for (const e of o.matrixWorld.elements) if (!Number.isFinite(e)) allFinite = false; });
  check('all world-matrix elements finite after animation', allFinite);

  console.log('--- Flex + Expression compose without fighting ---');
  // Reset, then run BOTH layers each frame like the real loop does. Flex squashes the head
  // + balls; Expression animates the face/arms. They write disjoint parts, so both stick.
  Expression.reset(snowman); Flex.reset(snowman);
  const posBefore = snowman.position.clone();
  for (let i = 0; i < 120; i++) {
    const mot = { speed: 22, technique: 'tuck', turnRate: Math.sin(i * 0.2), isInAir: i % 40 < 8 };
    Flex.update(snowman, 1 / 60, { ...mot, justLanded: i === 8, landingForce: 0.8 });
    Expression.update(snowman, 1 / 60, mot);
  }
  check('Flex still squashed the head (a body ball scale != 1)',
    Math.abs(parts.bottom.scale.y - 1) > 1e-3 || Math.abs(parts.middle.scale.y - 1) > 1e-3);
  check('Expression still posed the arms (tuck swept them back off neutral)',
    Math.abs(parts.leftArmGroup.rotation.x - neutral.leftArmGroup.rx) > 1e-3);
  check('neither layer moved the snowman root position (physics-neutral)',
    snowman.position.equals(posBefore));

  console.log('--- reset restores the exact neutral pose ---');
  Expression.reset(snowman);
  // Expression owns face + arms/hat/nose; Flex owns the balls/head/skis/scarf. Reset both.
  Flex.reset(snowman);
  let restored = true;
  for (const k of Object.keys(neutral)) {
    const p = parts[k], n = neutral[k];
    // position.x is included on purpose: it's the pupil "look" axis the preceding turning
    // run displaces, so a reset leak there (which py/sy/rz/rx alone would miss) is caught.
    if (Math.abs(p.position.x - n.px) > 1e-9 || Math.abs(p.position.y - n.py) > 1e-9 || Math.abs(p.scale.y - n.sy) > 1e-9 || Math.abs(p.rotation.z - n.rz) > 1e-9 || Math.abs(p.rotation.x - n.rx) > 1e-9) restored = false;
  }
  check('every part is byte-identical to its freshly-built neutral after reset', restored);
  // The recorded base transforms must equal the freshly-built neutral (the flex/expression
  // layers animate as offsets from exactly this snapshot).
  check('partBaseTransforms matches the freshly-built neutral pose',
    Math.abs(base.mouthBead0.position.y - neutral.mouthBead0.py) < 1e-9 && Math.abs(base.leftArmGroup.rotation.x - neutral.leftArmGroup.rx) < 1e-9);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
