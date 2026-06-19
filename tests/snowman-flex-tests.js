// snowman-flex-tests.js — headless unit tests for the cosmetic flex layer (issue #53).
//
// Flex (src/snowman-flex.ts) imports THREE type-only, so it has no runtime three
// dependency and can be driven with plain `{position,scale,rotation,userData}`
// stand-ins. Run via:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/snowman-flex-tests.js
//
// What we guard:
//  - update() only mutates child transforms and stays bounded;
//  - it is NaN-safe on a zero-speed / zero-delta first frame;
//  - idle motion stays small (no runaway);
//  - reset() restores the exact neutral transforms;
//  - it no-ops on a snowman without the part registry;
//  - prefers-reduced-motion snaps the snowman rigid.

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

// Minimal Vector3/Euler stand-in: x/y/z plus the .set() Flex uses.
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
function makeSnowman() {
  const parts = {
    bottom: makePart(0, 2, 0),
    middle: makePart(0, 4.5, 0),
    head: makePart(0, 1.0, 0),       // head is inside headGroup (local y)
    headGroup: makePart(0, 6.0, 0),
    leftArmGroup: makePart(1.35, 4.9, 0),
    rightArmGroup: makePart(-1.35, 4.9, 0)
  };
  return { userData: { parts, partBaseTransforms: recordBase(parts) } };
}
const allTransforms = (sm) => Object.values(sm.userData.parts).flatMap(p =>
  [p.position.x, p.position.y, p.position.z, p.scale.x, p.scale.y, p.scale.z, p.rotation.x, p.rotation.y, p.rotation.z]);
const allFinite = (arr) => arr.every(n => Number.isFinite(n));

async function main() {
  const { Flex } = await import('../src/snowman-flex.js');
  check('module exports update/reset', !!Flex && typeof Flex.update === 'function' && typeof Flex.reset === 'function');

  // 1) Zero-speed / zero-delta first frame must stay finite (no 0/0 NaN).
  {
    const sm = makeSnowman();
    Flex.update(sm, 0, { speed: 0, technique: 'glide', turnRate: 0, justLanded: false, landingForce: 0, isInAir: false });
    check('finite on {speed:0, delta:0} frame (no NaN)', allFinite(allTransforms(sm)));
  }

  // 2) A long, hard run stays bounded (scales clamped, head rotations clamped).
  {
    const sm = makeSnowman();
    let bounded = true;
    for (let i = 0; i < 600; i++) {
      const turn = Math.sin(i * 0.3); // thrash the steering
      Flex.update(sm, 1 / 60, { speed: 25, technique: 'carve', turnRate: turn, justLanded: i % 120 === 0, landingForce: 0.8, isInAir: false });
      const b = sm.userData.parts.bottom.scale;
      const hg = sm.userData.parts.headGroup.rotation;
      if (b.y < 0.7 || b.y > 1.3 || Math.abs(hg.z) > 0.4 || Math.abs(hg.y) > 0.4) bounded = false;
      if (!allFinite(allTransforms(sm))) bounded = false;
    }
    check('bounded + finite over 600 hard frames', bounded);
  }

  // 3) Idle motion stays small — the snowman breathes but does not drift.
  {
    const sm = makeSnowman();
    let small = true;
    for (let i = 0; i < 300; i++) {
      Flex.update(sm, 1 / 60, { speed: 0, technique: 'glide', turnRate: 0, justLanded: false, landingForce: 0, isInAir: false });
      const sy = sm.userData.parts.middle.scale.y;
      if (Math.abs(sy - 1) > 0.05) small = false;       // idle squash < 5%
      const hy = sm.userData.parts.headGroup.position.y; // base 6.0
      if (Math.abs(hy - 6.0) > 0.15) small = false;
    }
    check('idle breathing stays small (no drift)', small);
  }

  // 4) reset() restores the exact neutral transforms.
  {
    const sm = makeSnowman();
    for (let i = 0; i < 50; i++) Flex.update(sm, 1 / 60, { speed: 20, technique: 'skid', turnRate: 0.8, justLanded: i === 0, landingForce: 1.0, isInAir: false });
    Flex.reset(sm);
    const base = sm.userData.partBaseTransforms;
    let exact = true;
    for (const [k, p] of Object.entries(sm.userData.parts)) {
      const b = base[k];
      if (p.position.x !== b.position.x || p.position.y !== b.position.y || p.position.z !== b.position.z) exact = false;
      if (p.scale.x !== b.scale.x || p.scale.y !== b.scale.y || p.scale.z !== b.scale.z) exact = false;
      if (p.rotation.x !== b.rotation.x || p.rotation.y !== b.rotation.y || p.rotation.z !== b.rotation.z) exact = false;
    }
    check('reset() restores exact neutral transforms', exact);
  }

  // 5) No registry => safe no-op (e.g. the physics-harness stub snowman).
  {
    const bare = { userData: {} };
    let threw = false;
    try { Flex.update(bare, 1 / 60, { speed: 10, technique: 'glide', turnRate: 0, justLanded: false, landingForce: 0, isInAir: false }); Flex.reset(bare); }
    catch (e) { threw = true; }
    check('no-op (no throw) when part registry is absent', !threw);
  }

  // 6) prefers-reduced-motion snaps the snowman rigid (== base).
  {
    const prevWindow = global.window;
    global.window = { matchMedia: () => ({ matches: true }) };
    const sm = makeSnowman();
    // run a frame that WOULD jiggle, but reduced-motion should keep it at base
    Flex.update(sm, 1 / 60, { speed: 25, technique: 'carve', turnRate: 1, justLanded: true, landingForce: 1, isInAir: false });
    const base = sm.userData.partBaseTransforms;
    const rigid = Object.entries(sm.userData.parts).every(([k, p]) =>
      p.scale.y === base[k].scale.y && p.rotation.z === base[k].rotation.z && p.position.y === base[k].position.y);
    check('prefers-reduced-motion keeps the snowman rigid (== base)', rigid);
    if (prevWindow === undefined) delete global.window; else global.window = prevWindow;
  }

  console.log(`\nSNOWMAN-FLEX TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('snowman-flex test harness crashed:', err); process.exit(1); });
