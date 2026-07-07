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
  }
  return { userData: { parts, partBaseTransforms: recordBase(parts) } };
}
const faceKeys = ['mouthBead0', 'mouthBead1', 'mouthBead2', 'mouthBead3', 'mouthBead4', 'mouthBead5', 'mouthBead6', 'leftBrow', 'rightBrow', 'leftEye', 'rightEye', 'leftPupil', 'rightPupil', 'leftCheek', 'rightCheek'];
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

  // 2) A long, hard, thrashing run stays bounded + finite.
  {
    const sm = makeSnowman();
    let bounded = true;
    const techs = ['glide', 'carve', 'snowplow', 'tuck', 'skid', 'parallel', 'hop', 'air'];
    runFor(sm, Expression, 1200, (i) => ({ speed: 20, technique: techs[i % techs.length], turnRate: Math.sin(i * 0.2), isInAir: i % 90 < 15 }));
    for (const k of faceKeys) {
      const p = sm.userData.parts[k];
      if (Math.abs(p.position.y) > 2 || p.scale.y > 3 || p.scale.y < 0 || Math.abs(p.rotation.z) > 4) bounded = false;
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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
