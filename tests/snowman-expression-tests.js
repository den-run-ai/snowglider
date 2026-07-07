// @ts-check
// snowman-expression-tests.js — headless unit tests for the facial-expression layer
// (issue #364). Expression (src/snowman-expression.ts) imports THREE type-only, so it
// has no runtime three dependency and can be driven with plain
// `{position,scale,rotation,userData}` stand-ins (exactly like the flex suite). Run via:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/snowman-expression-tests.js
//
// What we guard:
//  - update() only mutates FACE child transforms and stays bounded/finite;
//  - it is NaN-safe on a zero-speed / zero-delta first frame;
//  - reset() restores the exact neutral transforms;
//  - prefers-reduced-motion snaps the face rigid;
//  - it no-ops on a snowman without the face rig;
//  - technique states drive the expected mouth/brow/eye shapes;
//  - the deterministic blink fires; pupils track the turn;
//  - it NEVER touches body/physics parts (no baseline regeneration needed).

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

function vec(x = 0, y = 0, z = 0) {
  return { x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } };
}
function makePart(px = 0, py = 0, pz = 0) {
  return { position: vec(px, py, pz), scale: vec(1, 1, 1), rotation: vec(0, 0, 0) };
}
function recordBase(parts) {
  const out = {};
  for (const [k, p] of Object.entries(parts)) {
    out[k] = {
      position: { x: p.position.x, y: p.position.y, z: p.position.z },
      scale: { x: p.scale.x, y: p.scale.y, z: p.scale.z },
      rotation: { x: p.rotation.x, y: p.rotation.y, z: p.rotation.z }
    };
  }
  return out;
}
const HALF = 0.42;
/** @returns {any} */
function makeSnowman(withFace = true) {
  /** @type {Record<string, any>} */
  const parts = {
    // Body/physics parts the expression layer must NEVER touch.
    bottom: makePart(0, 2, 0), middle: makePart(0, 4.5, 0),
    head: makePart(0, 1.0, 0), headGroup: makePart(0, 6.0, 0),
  };
  if (withFace) {
    // Mouth beads at the shipped layout: x = (i/6*2-1)*0.42, gentle-smile base y.
    for (let i = 0; i < 7; i++) {
      const t = (i / 6) * 2 - 1;
      parts[`mouthBead${i}`] = makePart(t * HALF, 0.12 * t * t, 0.85);
    }
    parts.mouth = makePart(0, -0.42, 0);
    parts.leftBrow = makePart(0.4, 0.52, 0.75); parts.leftBrow.rotation.z = Math.PI / 2 + 0.18;
    parts.rightBrow = makePart(-0.4, 0.52, 0.75); parts.rightBrow.rotation.z = Math.PI / 2 - 0.18;
    parts.leftEye = makePart(0.4, 0.2, 0.8); parts.rightEye = makePart(-0.4, 0.2, 0.8);
    parts.leftPupil = makePart(0, 0.04, 0.11); parts.rightPupil = makePart(0, 0.04, 0.11);
    parts.leftCheek = makePart(0.62, -0.16, 0.7); parts.rightCheek = makePart(-0.62, -0.16, 0.7);
    // Body-acting parts (PR 3): arm groups (base rot x=PI/16, y=∓PI/8), hat, nose.
    parts.leftArmGroup = makePart(1.35, 4.9, 0); parts.leftArmGroup.rotation.set(Math.PI / 16, -Math.PI / 8, 0);
    parts.rightArmGroup = makePart(-1.35, 4.9, 0); parts.rightArmGroup.rotation.set(Math.PI / 16, Math.PI / 8, 0);
    parts.hatBase = makePart(0, 7.9, 0); parts.hatTop = makePart(0, 8.45, 0);
    parts.nose = makePart(0, 0, 1); parts.nose.rotation.x = Math.PI / 2;
  }
  return { userData: { parts, partBaseTransforms: recordBase(parts) } };
}
const faceKeys = ['mouthBead0', 'mouthBead1', 'mouthBead2', 'mouthBead3', 'mouthBead4', 'mouthBead5', 'mouthBead6', 'leftBrow', 'rightBrow', 'leftEye', 'rightEye', 'leftPupil', 'rightPupil', 'leftCheek', 'rightCheek', 'leftArmGroup', 'rightArmGroup', 'hatBase', 'hatTop', 'nose'];
const allVals = (sm) => faceKeys.flatMap(k => { const p = sm.userData.parts[k]; return [p.position.x, p.position.y, p.position.z, p.scale.x, p.scale.y, p.scale.z, p.rotation.x, p.rotation.y, p.rotation.z]; });
const allFinite = (arr) => arr.every(n => Number.isFinite(n));
function runFor(sm, Expression, frames, motion, dt = 1 / 60) { for (let i = 0; i < frames; i++) Expression.update(sm, dt, typeof motion === 'function' ? motion(i) : motion); }

async function main() {
  const { Expression } = await import('../src/snowman-expression.js');
  check('module exports update/reset', !!Expression && typeof Expression.update === 'function' && typeof Expression.reset === 'function');

  // 1) NaN-safe on a zero-speed / zero-delta first frame.
  {
    const sm = makeSnowman();
    Expression.update(sm, 0, { speed: 0, technique: 'glide', turnRate: 0, isInAir: false });
    check('finite on {speed:0, dt:0} frame (no 0/0 NaN)', allFinite(allVals(sm)));
  }

  // 2) A long, hard, thrashing run stays bounded + finite (deviation from base clamped).
  {
    const sm = makeSnowman();
    const base = sm.userData.partBaseTransforms;
    let bounded = true;
    const techs = ['glide', 'carve', 'snowplow', 'tuck', 'skid', 'parallel', 'hop', 'air'];
    runFor(sm, Expression, 1200, (i) => ({ speed: 20, technique: techs[i % techs.length], turnRate: Math.sin(i * 0.2), isInAir: i % 90 < 15 }));
    for (const k of faceKeys) {
      const p = sm.userData.parts[k], b = base[k];
      // No part may drift more than 2u from its neutral position, exceed 3x scale, or
      // swing more than 2 rad from its neutral orientation on any axis.
      if (Math.abs(p.position.y - b.position.y) > 2 || Math.abs(p.position.x - b.position.x) > 2 ||
          p.scale.y > 3 || p.scale.y < 0 || Math.abs(p.rotation.z - b.rotation.z) > 2 ||
          Math.abs(p.rotation.x - b.rotation.x) > 2) bounded = false;
    }
    check('bounded + finite over 1200 hard mixed frames', bounded && allFinite(allVals(sm)));
  }

  // 3) reset() restores the EXACT neutral transforms.
  {
    const sm = makeSnowman();
    const before = recordBase(sm.userData.parts);
    runFor(sm, Expression, 200, { speed: 15, technique: 'carve', turnRate: 0.8, isInAir: false });
    Expression.reset(sm);
    let restored = true;
    for (const k of faceKeys) {
      const p = sm.userData.parts[k], b = before[k];
      if (p.position.y !== b.position.y || p.scale.y !== b.scale.y || p.rotation.z !== b.rotation.z || p.position.x !== b.position.x) restored = false;
    }
    check('reset() restores exact neutral face transforms', restored);
  }

  // 4) prefers-reduced-motion snaps the face rigid (update == reset, no motion).
  {
    const g = /** @type {any} */ (globalThis);
    const orig = g.window;
    g.window = { matchMedia: () => ({ matches: true }) };
    try {
      const sm = makeSnowman();
      const before = recordBase(sm.userData.parts);
      runFor(sm, Expression, 50, { speed: 20, technique: 'air', turnRate: 1, isInAir: true });
      let rigid = true;
      for (const k of faceKeys) {
        const p = sm.userData.parts[k], b = before[k];
        if (p.position.y !== b.position.y || p.scale.y !== b.scale.y || p.rotation.z !== b.rotation.z) rigid = false;
      }
      check('prefers-reduced-motion holds the face at neutral', rigid);
    } finally { if (orig === undefined) delete g.window; else g.window = orig; }
  }

  // 5) no-ops (no throw, no mutation) on a snowman without the face rig.
  {
    const sm = makeSnowman(false);
    let ok = true;
    try { Expression.update(sm, 1 / 60, { speed: 10, technique: 'carve', turnRate: 0, isInAir: false }); }
    catch { ok = false; }
    check('no-ops safely on a snowman without a face rig', ok && sm.userData.parts.bottom.position.y === 2);
  }

  // 6) NEVER touches body/physics parts (no baseline regeneration needed).
  {
    const sm = makeSnowman();
    runFor(sm, Expression, 300, (i) => ({ speed: 18, technique: 'carve', turnRate: Math.sin(i * 0.1), isInAir: i % 60 < 10 }));
    const body = sm.userData.parts;
    check('body parts (bottom/middle/head/headGroup) are untouched',
      body.bottom.position.y === 2 && body.bottom.scale.y === 1 &&
      body.middle.scale.y === 1 && body.head.scale.y === 1 &&
      body.headGroup.position.y === 6 && body.headGroup.rotation.z === 0);
  }

  // 7) Technique → expected shapes. Ease to steady state, then read the pose.
  {
    // snowplow "uh-oh": raised brows (above base y) + mouth opened (centre bead drops).
    const sm = makeSnowman();
    runFor(sm, Expression, 120, { speed: 8, technique: 'snowplow', turnRate: 0, isInAir: false });
    const p = sm.userData.parts;
    check('snowplow raises the brows (position.y above base)',
      p.leftBrow.position.y > 0.52 + 1e-4 && p.rightBrow.position.y > 0.52 + 1e-4);
    check('snowplow opens the mouth (centre bead drops below its base)',
      p.mouthBead3.position.y < 0 - 1e-4);
  }
  {
    // carve "determined": lowered brows (below base y).
    const sm = makeSnowman();
    runFor(sm, Expression, 120, { speed: 20, technique: 'carve', turnRate: 0, isInAir: false });
    const p = sm.userData.parts;
    check('carve lowers the brows (position.y below base)',
      p.leftBrow.position.y < 0.52 - 1e-4 && p.rightBrow.position.y < 0.52 - 1e-4);
    check('carve squints the eyes (scale.y < 1)', p.leftEye.scale.y < 0.95);
  }
  {
    // air "excited": a big smile (outer beads lifted above the centre) + brows raised.
    const sm = makeSnowman();
    runFor(sm, Expression, 120, { speed: 22, technique: 'air', turnRate: 0, isInAir: true });
    const p = sm.userData.parts;
    check('air lifts the mouth corners into a big smile (ends above centre)',
      p.mouthBead0.position.y > p.mouthBead3.position.y + 0.05 && p.mouthBead6.position.y > p.mouthBead3.position.y + 0.05);
    check('air raises the brows', p.leftBrow.position.y > 0.52 + 1e-4);
  }

  // 8) Deterministic blink fires (eye scale.y dips well below the open value over time).
  {
    const sm = makeSnowman();
    let minEye = 1;
    runFor(sm, Expression, 300, () => ({ speed: 0, technique: 'glide', turnRate: 0, isInAir: false })); // ~5s
    // sample the dip across a second run window
    for (let i = 0; i < 300; i++) { Expression.update(sm, 1 / 60, { speed: 0, technique: 'glide', turnRate: 0, isInAir: false }); minEye = Math.min(minEye, sm.userData.parts.leftEye.scale.y); }
    check('deterministic blink dips the eyes closed at least once', minEye < 0.4);
  }

  // 9) Pupils track the turn (shift toward a sustained turn direction).
  {
    const smL = makeSnowman(), smR = makeSnowman();
    runFor(smL, Expression, 120, { speed: 15, technique: 'parallel', turnRate: -1, isInAir: false });
    runFor(smR, Expression, 120, { speed: 15, technique: 'parallel', turnRate: 1, isInAir: false });
    check('pupils shift opposite directions for opposite turns',
      Math.sign(smL.userData.parts.leftPupil.position.x - 0) !== Math.sign(smR.userData.parts.leftPupil.position.x - 0) &&
      Math.abs(smR.userData.parts.leftPupil.position.x) > 1e-3);
  }

  // 10) Body acting: air spreads/raises the arms (rotation offsets from base).
  {
    const sm = makeSnowman();
    const base = sm.userData.partBaseTransforms;
    runFor(sm, Expression, 120, { speed: 22, technique: 'air', turnRate: 0, isInAir: true });
    const p = sm.userData.parts;
    check('air splays the arms outward (rotation.z offset, mirrored L/R)',
      Math.abs(p.leftArmGroup.rotation.z - base.leftArmGroup.rotation.z) > 0.1 &&
      Math.sign(p.leftArmGroup.rotation.z - base.leftArmGroup.rotation.z) !== Math.sign(p.rightArmGroup.rotation.z - base.rightArmGroup.rotation.z) &&
      // Lock the OUTWARD direction: the left arm (+x shoulder) must rotate -z so its tip
      // swings out to +x. A +z regression swings both arms inward over the head (clipping
      // the twigs into the head sphere in the spread states — snowplow/air/hop).
      (p.leftArmGroup.rotation.z - base.leftArmGroup.rotation.z) < 0);
  }

  // 11) Body acting: tuck sweeps the arms BACK and drops the hat. The sticks extend along
  //     local +y and the nose points +z, so a NEGATIVE rotation.x offset swings the hands
  //     behind the racer (-z); a positive offset would throw them out in front (the bug this
  //     locks against). The real-model world-space direction is asserted in the PR5
  //     integration suite; here we lock the rotation sign the stand-ins can see.
  {
    const sm = makeSnowman();
    const base = sm.userData.partBaseTransforms;
    runFor(sm, Expression, 120, { speed: 24, technique: 'tuck', turnRate: 0, isInAir: false });
    const p = sm.userData.parts;
    check('tuck sweeps the arms back (rotation.x below base → hands go behind)',
      p.leftArmGroup.rotation.x < base.leftArmGroup.rotation.x - 0.1 && p.rightArmGroup.rotation.x < base.rightArmGroup.rotation.x - 0.1);
    check('tuck pushes the hat down (position.y below base)',
      p.hatTop.position.y < base.hatTop.position.y - 1e-3 && p.hatBase.position.y < base.hatBase.position.y - 1e-3);
  }

  // 11b) The tuck hat-drop EASES in with the arm sweep-back, it does NOT snap on the boolean:
  //      after a single tuck frame the hat has barely dropped; the drop deepens as armBack
  //      eases toward its tuck target. A boolean-snap regression drops the full amount frame 1.
  {
    const sm = makeSnowman();
    const base = sm.userData.partBaseTransforms;
    Expression.update(sm, 1 / 60, { speed: 24, technique: 'tuck', turnRate: 0, isInAir: false });
    const drop1 = base.hatTop.position.y - sm.userData.parts.hatTop.position.y;
    runFor(sm, Expression, 60, { speed: 24, technique: 'tuck', turnRate: 0, isInAir: false });
    const dropN = base.hatTop.position.y - sm.userData.parts.hatTop.position.y;
    check('hat tuck-drop eases in (one-frame drop is a small fraction of the settled drop)',
      dropN > 1e-3 && drop1 < dropN * 0.4);
  }

  // 12) Body acting: carve counter-rotates the arms (inside forward / outside back).
  {
    const sm = makeSnowman();
    const base = sm.userData.partBaseTransforms;
    runFor(sm, Expression, 120, { speed: 20, technique: 'carve', turnRate: 0.9, isInAir: false });
    const p = sm.userData.parts;
    check('carve counter-rotates the arms (L/R rotation.x diverge oppositely)',
      Math.sign(p.leftArmGroup.rotation.x - base.leftArmGroup.rotation.x) !== Math.sign(p.rightArmGroup.rotation.x - base.rightArmGroup.rotation.x));
  }

  // 13) Body acting: the hat leans INTO the turn (rotation.z offset flips with turn sign,
  //     AND matches the flex head-cluster convention: into-turn is `-turn` on rotation.z,
  //     so a positive turnRate must give a NEGATIVE hat rotation.z offset — not just any
  //     opposite pair, which a sign-inverted lean would also satisfy).
  {
    const smL = makeSnowman(), smR = makeSnowman();
    const b = smL.userData.partBaseTransforms.hatTop.rotation.z;
    runFor(smL, Expression, 120, { speed: 15, technique: 'parallel', turnRate: -1, isInAir: false });
    runFor(smR, Expression, 120, { speed: 15, technique: 'parallel', turnRate: 1, isInAir: false });
    const dzL = smL.userData.parts.hatTop.rotation.z - b, dzR = smR.userData.parts.hatTop.rotation.z - b;
    check('hat leans into the turn (turn>0 → negative rotation.z, matching the flex head lean)',
      Math.sign(dzL) !== Math.sign(dzR) && Math.abs(dzR) > 1e-3 && dzR < 0);
  }

  // 14) Body acting: reset() restores arms/hat/nose to neutral.
  {
    const sm = makeSnowman();
    const before = recordBase(sm.userData.parts);
    runFor(sm, Expression, 200, { speed: 24, technique: 'tuck', turnRate: 0.8, isInAir: false });
    Expression.reset(sm);
    const p = sm.userData.parts;
    let restored = true;
    for (const k of ['leftArmGroup', 'rightArmGroup', 'hatBase', 'hatTop', 'nose']) {
      const b = before[k];
      if (p[k].rotation.x !== b.rotation.x || p[k].rotation.z !== b.rotation.z || p[k].position.y !== b.position.y) restored = false;
    }
    check('reset() restores arms/hat/nose to neutral', restored);
  }

  // ===== Event reactions (PR 4) =====
  console.log('--- event reactions (PR 4) ---');

  // 15) Clean-landing smile: a graded clean landing overrides the technique with a big
  //     grin + cheek pop for its window. Compared against a CONTROL run with identical
  //     motion but NO landing — the clean reaction must produce a STRICTLY bigger grin +
  //     cheek pop than the plain idle-glide face, so the check fails if the reaction is a
  //     no-op (both the neutral smile and idle glide already satisfy a bare threshold).
  {
    const sm = makeSnowman(), ctl = makeSnowman();
    Expression.update(sm, 1 / 60, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false, justLanded: true, landingQuality: 'clean' });
    Expression.update(ctl, 1 / 60, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false });
    runFor(sm, Expression, 18, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false });
    runFor(ctl, Expression, 18, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false });
    const p = sm.userData.parts, pc = ctl.userData.parts;
    const grin = (q) => q.mouthBead0.position.y - q.mouthBead3.position.y;
    check('clean landing → bigger grin + cheek pop than a plain glide (reaction is not a no-op)',
      p.mouthBead0.position.y > p.mouthBead3.position.y + 0.1 &&
      grin(p) > grin(pc) + 1e-3 && p.leftCheek.scale.x > pc.leftCheek.scale.x + 1e-3);
  }

  // 15b) OK-landing priority: alone it shows the relieved smile (hat-bounce + mild grin),
  //      but a bearing-down avalanche outranks it (panic wins — brows raise, no relief).
  {
    const solo = makeSnowman();
    Expression.update(solo, 1 / 60, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false, justLanded: true, landingQuality: 'ok' });
    runFor(solo, Expression, 8, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false });
    const ps = solo.userData.parts, bs = solo.userData.partBaseTransforms;
    check('ok landing alone → relieved smile (grin above the neutral base)',
      ps.mouthBead0.position.y - ps.mouthBead3.position.y > (bs.mouthBead0.position.y - bs.mouthBead3.position.y) + 1e-3);

    // Same ok landing, but with a close slide every frame: avalanche panic outranks ok.
    const both = makeSnowman();
    const bb = both.userData.partBaseTransforms;
    Expression.update(both, 1 / 60, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false, justLanded: true, landingQuality: 'ok', avalancheDistance: 6 });
    runFor(both, Expression, 8, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false, avalancheDistance: 6 });
    const pb = both.userData.parts;
    check('avalanche panic outranks ok landing (brows raised into panic, not a relieved smile)',
      pb.leftBrow.position.y > bb.leftBrow.position.y + 1e-3);
  }

  // 16) Sketchy wince: one eye squeezed shut (left < right) + crooked mouth + windmill.
  {
    const sm = makeSnowman();
    Expression.update(sm, 1 / 60, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false, justLanded: true, landingQuality: 'sketchy' });
    runFor(sm, Expression, 10, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false });
    const p = sm.userData.parts;
    check('sketchy landing → left eye squeezed shut (scale.y well below right)', p.leftEye.scale.y < p.rightEye.scale.y - 0.2);
    check('sketchy landing → mouth is crooked (mouth.rotation.z != 0)', Math.abs(p.mouth.rotation.z) > 1e-3);
  }

  // 17) Obstacle "woo!": an open grin (mouth opens, corners up).
  {
    const sm = makeSnowman();
    Expression.update(sm, 1 / 60, { speed: 15, technique: 'glide', turnRate: 0, isInAir: true, obstacleCleared: 'tree' });
    runFor(sm, Expression, 12, { speed: 15, technique: 'glide', turnRate: 0, isInAir: false });
    const p = sm.userData.parts;
    check('obstacle clear → "woo" open grin (centre bead dropped + corners up)',
      p.mouthBead3.position.y < -0.05 && p.mouthBead0.position.y > p.mouthBead3.position.y);
  }

  // 18) Trick celebration persists AFTER landing (overrides the grounded technique).
  {
    const sm = makeSnowman();
    Expression.update(sm, 1 / 60, { speed: 18, technique: 'glide', turnRate: 0, isInAir: false, justLanded: true, trickName: '360' });
    runFor(sm, Expression, 20, { speed: 5, technique: 'glide', turnRate: 0, isInAir: false }); // grounded, slow
    const p = sm.userData.parts;
    const base = sm.userData.partBaseTransforms;
    check('trick landing → celebration grin persists while grounded (arms up + big smile)',
      Math.abs(p.leftArmGroup.rotation.z - base.leftArmGroup.rotation.z) > 0.1 && p.mouthBead0.position.y > p.mouthBead3.position.y + 0.1);
  }

  // 18b) A named trick that lands as a WIPEOUT drives NO celebration (the crash frame must
  //      not flash a trick grin — the trickName can coincide with the wipeout grade).
  {
    const sm = makeSnowman();
    const base = sm.userData.partBaseTransforms;
    Expression.update(sm, 1 / 60, { speed: 18, technique: 'glide', turnRate: 0, isInAir: false, justLanded: true, trickName: '360', landingQuality: 'wipeout' });
    runFor(sm, Expression, 20, { speed: 5, technique: 'glide', turnRate: 0, isInAir: false });
    const p = sm.userData.parts;
    // No trick override => arms are NOT thrown up (they stay at the neutral glide pose).
    check('trick on a wipeout landing → no celebration (arms stay near neutral)',
      Math.abs(p.leftArmGroup.rotation.z - base.leftArmGroup.rotation.z) < 0.05 &&
      Math.abs(p.rightArmGroup.rotation.z - base.rightArmGroup.rotation.z) < 0.05);
  }

  // 19) Avalanche panic: a close slide raises the brows and animates the arms; it clears
  //     once the slide is far away.
  {
    const sm = makeSnowman();
    const base = sm.userData.partBaseTransforms;
    runFor(sm, Expression, 30, { speed: 16, technique: 'glide', turnRate: 0, isInAir: false, avalancheDistance: 8 });
    const p = sm.userData.parts;
    check('avalanche close → brows raised (panic)', p.leftBrow.position.y > base.leftBrow.position.y + 1e-3 && p.rightBrow.position.y > base.rightBrow.position.y + 1e-3);
    // Far avalanche => no panic, face eases back to the idle smile.
    runFor(sm, Expression, 120, { speed: 16, technique: 'glide', turnRate: 0, isInAir: false, avalancheDistance: 500 });
    check('avalanche far → panic clears (brows return near neutral)', Math.abs(p.leftBrow.position.y - base.leftBrow.position.y) < 0.05);
  }

  // 20) Hat bounce: a landing kicks the hat spring (displaces then settles back).
  {
    const sm = makeSnowman();
    const base = sm.userData.partBaseTransforms;
    Expression.update(sm, 1 / 60, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false, justLanded: true, landingQuality: 'ok' });
    let maxDev = 0;
    for (let i = 0; i < 8; i++) { Expression.update(sm, 1 / 60, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false }); maxDev = Math.max(maxDev, Math.abs(sm.userData.parts.hatTop.position.y - base.hatTop.position.y)); }
    check('landing kicks a hat bounce (hat displaces from base)', maxDev > 0.02);
    runFor(sm, Expression, 200, { speed: 12, technique: 'glide', turnRate: 0, isInAir: false });
    check('hat bounce settles back to rest', Math.abs(sm.userData.parts.hatTop.position.y - base.hatTop.position.y) < 0.01);
  }

  // 21) Wipeout drives NO face reaction (it ends the run via the crash path).
  {
    const sm = makeSnowman();
    const base = sm.userData.partBaseTransforms;
    Expression.update(sm, 1 / 60, { speed: 20, technique: 'glide', turnRate: 0, isInAir: false, justLanded: true, landingQuality: 'wipeout' });
    runFor(sm, Expression, 10, { speed: 5, technique: 'glide', turnRate: 0, isInAir: false });
    const p = sm.userData.parts;
    // No sketchy/clean override: the mouth is NOT crooked and the face is a plain idle smile.
    check('wipeout landing drives no wince/celebration (mouth uncrooked)', Math.abs(p.mouth.rotation.z - base.mouth.rotation.z) < 1e-6);
  }

  // 22) Backward-compat: with no event fields, the face is byte-identical to the pure
  //     technique face (reactions never fire).
  {
    const a = makeSnowman(), b = makeSnowman();
    for (let i = 0; i < 100; i++) {
      Expression.update(a, 1 / 60, { speed: 15, technique: 'carve', turnRate: 0.5, isInAir: false });
      Expression.update(b, 1 / 60, { speed: 15, technique: 'carve', turnRate: 0.5, isInAir: false, justLanded: false, landingQuality: null, obstacleCleared: null, trickName: null, avalancheDistance: Infinity });
    }
    const pa = a.userData.parts, pb = b.userData.parts;
    check('absent vs explicitly-empty event fields produce identical faces',
      pa.mouthBead0.position.y === pb.mouthBead0.position.y && pa.leftEye.scale.y === pb.leftEye.scale.y && pa.leftArmGroup.rotation.z === pb.leftArmGroup.rotation.z);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
