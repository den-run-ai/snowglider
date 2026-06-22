// turn_styles_compare.js
// Side-by-side comparison of the two steered ski turns introduced by the
// carve-vs-parallel rework (follow-up to #185 / issues #48/#54): a committed
// **carve** vs. a skidded **parallel** turn. It drives the REAL
// Snowman.updateSnowman (physics + applySnowmanPose) and GATES the exit code on
// the distinctions the rework promises:
//
//   - Carve  : holds speed, draws a WIDER arc, deep body lean, skis edged + drawn together.
//   - Parallel (skidded): scrubs speed, turns TIGHTER, upright body, skis flatter + neutral width.
//
// Two scenarios, each isolating a property cleanly:
//
//   A) Single-arc side-by-side — one held-Right carve vs. one skidded parallel
//      from an identical start. Animated as a top-down ASCII map for human
//      review, and gated on turn RADIUS (speed-independent curvature) + POSE +
//      the technique each turn locks into. (Final speed here is terrain-confounded
//      — a single sustained turn wanders off across the radial hill — so it is a
//      diagnostic only.)
//   B) Linked turns around the fall line — committed carves vs. chatter-skidding,
//      sharing the same terrain band, to gate SPEED-HOLDING fairly (the carve must
//      finish clearly faster). Mirrors physics_invariant_harness check 3.
//
// This complements the physics_invariant_harness (which gates the no-input
// coasting invariant). Run via:
//   node tests/verification/turn_styles_compare.js
//   npm run test:turn-styles
const path = require('path');
const { pathToFileURL } = require('url');

// --- Shared deterministic terrain (mirrors mountains.js downhill shape, no noise) ---
// Identical to physics_invariant_harness.js so both harnesses agree on terrain.
function getTerrainHeight(x, z) {
  let y = 40 * Math.exp(-Math.sqrt(x * x + z * z) / 40);
  if (z < -30) y += (z + 30) * 0.12;
  return y;
}
function getTerrainGradient(x, z) {
  const eps = 0.1, h = getTerrainHeight(x, z);
  return { x: (getTerrainHeight(x + eps, z) - h) / eps, z: (getTerrainHeight(x, z + eps) - h) / eps };
}
function getDownhillDirection(x, z) {
  const g = getTerrainGradient(x, z);
  const d = { x: -g.x, z: -g.z };
  const len = Math.sqrt(d.x * d.x + d.z * d.z);
  return len ? { x: d.x / len, z: d.z / len } : { x: 0, z: 1 };
}

// Seeded PRNG so the auto-turn Math.random path (linked runs reverse, so it is
// never hit there; single arcs hold a steer, also never hitting it) is deterministic.
function makeRng(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Stub snowman with body + ski transforms so applySnowmanPose (run inside
// updateSnowman) has somewhere to write the cosmetic pose we read back:
//   snowman.rotation.z          -> body lean into the turn
//   userData.leftSki/rightSki   -> ski edge (rotation.z) and width (position.x)
function fakeSnowman() {
  const ski = (baseX) => ({ position: { x: baseX }, rotation: { x: 0, y: 0, z: 0 } });
  const ls = ski(-1), rs = ski(1);
  return {
    position: { set() {} },
    rotation: { x: 0, y: Math.PI, z: 0 },
    userData: { targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
                leftSki: ls, rightSki: rs, leftSkiBaseX: -1, rightSkiBaseX: 1 }
  };
}

const RIGHT = { left: false, right: true, up: false, down: false, jump: false };
const LEFT = { left: true, right: false, up: false, down: false, jump: false };

// Drive one descent. `ctrl(i)` supplies the controls each frame; `breakEdge`
// simulates a continuously-skidded (uncommitted) turn by resetting the edge state
// every frame so the carve never locks (a held turn otherwise commits into a
// carve). Returns a per-frame record of position, speed, heading, technique, and
// the cosmetic pose.
function run(updateFn, ctrl, { steps = 130, dt = 1 / 60, z0 = -40, vz0 = -16, seed = 4242, breakEdge = false } = {}) {
  const rng = makeRng(seed); Math.random = rng;
  const snowman = fakeSnowman();
  const pos = { x: 0, z: z0, y: getTerrainHeight(0, z0) };
  const velocity = { x: 0, z: vz0 };
  let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, z0),
             airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
  const frames = [];
  for (let i = 0; i < steps; i++) {
    if (breakEdge) { snowman.userData.carveCharge = 0; snowman.userData.lastSteerDir = 0; }
    st = updateFn(snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity, st.lastTerrainHeight,
      st.airTime, st.jumpCooldown, ctrl(i), st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown,
      3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {});
    frames.push({
      i,
      x: pos.x,
      z: pos.z,
      speed: Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z),
      heading: Math.atan2(velocity.x, velocity.z),
      technique: st.technique,
      lean: snowman.rotation.z,                                              // body inclination
      skiEdge: snowman.userData.leftSki.rotation.z,                          // ski roll onto edge
      skiGap: snowman.userData.rightSki.position.x - snowman.userData.leftSki.position.x, // ski width
      carveCharge: snowman.userData.carveCharge || 0
    });
    if (pos.z < -195) break;
  }
  return frames;
}

const last = (frames) => frames[frames.length - 1];
const maxAbs = (frames, key) => frames.reduce((m, f) => Math.max(m, Math.abs(f[key])), 0);
const techniques = (frames) => new Set(frames.map((f) => f.technique));

// Mean turn radius over the arc — SPEED-INDEPENDENT (pathLength / total heading
// change). Reported as a diagnostic; over a long arc gravity keeps redirecting the
// velocity back toward the fall line, which muddies it, so the gated tightness
// measure is the single-frame turn impulse below.
function turnRadius(frames) {
  let pathLen = 0, turned = 0;
  for (let i = 1; i < frames.length; i++) {
    pathLen += Math.hypot(frames[i].x - frames[i - 1].x, frames[i].z - frames[i - 1].z);
    let d = frames[i].heading - frames[i - 1].heading;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turned += d;
  }
  return Math.abs(turned) > 1e-6 ? pathLen / Math.abs(turned) : Infinity;
}

// Controlled single-frame turn impulse from an IDENTICAL state, differing only in
// edge commitment: a carve (carveCharge locked) vs. a parallel (carveCharge 0).
// The sideways velocity gained in one Right frame is the turn's tightness — the
// parallel pivots harder (turnForce 19) than the carve (turnForce 10). Unconfounded
// by terrain, speed, or path history, so it is the clean GATING tightness measure.
function turnImpulse(updateFn, committed, { z0 = -40, vz0 = -16 } = {}) {
  Math.random = makeRng(1);
  const snowman = fakeSnowman();
  snowman.userData.carveCharge = committed ? 1 : 0;
  snowman.userData.lastSteerDir = committed ? 1 : 0;
  const pos = { x: 0, z: z0, y: getTerrainHeight(0, z0) };
  const velocity = { x: 0, z: vz0 };
  const st = updateFn(snowman, 1 / 60, pos, velocity, false, 0, getTerrainHeight(0, z0), 0, 0, RIGHT,
    0, 0, 3, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {});
  return { dvx: Math.abs(velocity.x), technique: st.technique };
}

// --- Top-down ASCII map of both single arcs (downhill = downward) ------------
function renderMaps(carve, parallel) {
  const W = 27, H = 16;
  const all = carve.concat(parallel);
  let minX = Math.min(...all.map((f) => f.x)), maxX = Math.max(...all.map((f) => f.x));
  const minZ = Math.min(...all.map((f) => f.z)), maxZ = Math.max(...all.map((f) => f.z));
  const padX = Math.max(0.5, (maxX - minX) * 0.08); minX -= padX; maxX += padX;
  const col = (x) => Math.max(0, Math.min(W - 1, Math.round((x - minX) / (maxX - minX || 1) * (W - 1))));
  const row = (z) => Math.max(0, Math.min(H - 1, Math.round((maxZ - z) / (maxZ - minZ || 1) * (H - 1))));
  const blank = () => Array.from({ length: H }, () => Array(W).fill(' '));
  function plot(grid, frames, ch) {
    for (const f of frames) grid[row(f.z)][col(f.x)] = ch;
    grid[row(frames[0].z)][col(frames[0].x)] = 'S';
    grid[row(last(frames).z)][col(last(frames).x)] = 'E';
    return grid;
  }
  const cGrid = plot(blank(), carve, '·');
  const pGrid = plot(blank(), parallel, '·');
  const oGrid = blank();          // overlay: C = carve, P = parallel, X = both
  for (const f of carve) oGrid[row(f.z)][col(f.x)] = 'C';
  for (const f of parallel) {
    const r = row(f.z), c = col(f.x);
    oGrid[r][c] = oGrid[r][c] === 'C' ? 'X' : 'P';
  }
  const center = col(0);
  const lines = [];
  const cap = (s) => s + ' '.repeat(Math.max(0, W - s.length));
  lines.push('   ' + cap('CARVE (held edge)') + '   ' + cap('PARALLEL (skidded)') + '   ' + cap('OVERLAY  C/P/X=both'));
  for (let r = 0; r < H; r++) {
    const draw = (grid) => grid[r].map((ch, c) => (ch === ' ' && c === center) ? ':' : ch).join('');
    lines.push('   |' + draw(cGrid) + '|   |' + draw(pGrid) + '|   |' + draw(oGrid) + '|');
  }
  lines.push('   (S=start, E=end, ":"=fall line x=0; rows go downhill; same x/z scale across panels)');
  return lines.join('\n');
}

(async () => {
  // src/snowman is an ES module behind a `.js`-specifier import graph, so register
  // the `.js` -> `.ts` resolver before importing the public facade (same pattern as
  // physics_invariant_harness.js, so this runs with a plain `node ...`).
  await import(pathToFileURL(path.join(__dirname, '..', 'loaders', 'register-ts-resolve.mjs')).href);
  const { Snowman } = await import('../../src/snowman.ts');
  const update = Snowman.updateSnowman;
  // updateSnowman reads window.location.search / window.treeCollisionRadius on its
  // debug + test-hook paths; provide the same minimal stub the harness expects.
  global.window = global.window || { location: { search: '' } };

  let hardFail = false;
  const gate = (name, cond, detail) => {
    console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}${detail ? ' — ' + detail : ''}`);
    if (!cond) hardFail = true;
  };

  // === Scenario A: single-arc side-by-side (radius + pose + technique) ========
  const Z0 = -40;
  const carve = run(update, () => RIGHT, { z0: Z0, breakEdge: false });
  const parallel = run(update, () => RIGHT, { z0: Z0, breakEdge: true });
  const carveR = turnRadius(carve), parR = turnRadius(parallel);
  // Clean tightness probe: one Right frame from an identical state, carve vs parallel.
  const carveImp = turnImpulse(update, true), parImp = turnImpulse(update, false);

  console.log('=== A) Carve vs. parallel — single turn, side-by-side ===');
  console.log('(identical start: z=-40, entry 16 u/s, held Right; only edge commitment differs)\n');
  console.log(renderMaps(carve, parallel));

  console.log('\n--- Frame-by-frame (every 20 frames) ---');
  console.log('  frame |        CARVE  speed  x      lean  tech     |     PARALLEL  speed  x      lean  tech');
  for (let i = 0; i < Math.max(carve.length, parallel.length); i += 20) {
    const c = carve[Math.min(i, carve.length - 1)];
    const p = parallel[Math.min(i, parallel.length - 1)];
    const fmt = (f) => `${f.speed.toFixed(2).padStart(6)} ${f.x.toFixed(1).padStart(6)} ${f.lean.toFixed(3).padStart(7)}  ${f.technique}`;
    console.log(`  ${String(i).padStart(5)} |        ${fmt(c).padEnd(34)} |     ${fmt(p)}`);
  }

  console.log('\n--- Scenario A metrics ---');
  console.log(`  turn impulse (1 frame) carve ${carveImp.dvx.toFixed(3)}  vs  parallel ${parImp.dvx.toFixed(3)}  (parallel pivots harder = tighter, +${((parImp.dvx / carveImp.dvx - 1) * 100).toFixed(0)}%)`);
  console.log(`  mean turn radius (diag) carve ${carveR.toFixed(2)}  vs  parallel ${parR.toFixed(2)}  (carve = wider arc)`);
  console.log(`  max body lean      carve ${maxAbs(carve, 'lean').toFixed(3)}  vs  parallel ${maxAbs(parallel, 'lean').toFixed(3)} rad`);
  console.log(`  max ski edge       carve ${maxAbs(carve, 'skiEdge').toFixed(3)}  vs  parallel ${maxAbs(parallel, 'skiEdge').toFixed(3)} rad`);
  console.log(`  min ski gap        carve ${Math.min(...carve.map((f) => f.skiGap)).toFixed(2)}  vs  parallel ${Math.min(...parallel.map((f) => f.skiGap)).toFixed(2)} (carve draws skis together)`);
  console.log(`  techniques seen    carve {${[...techniques(carve)].join(', ')}}  parallel {${[...techniques(parallel)].join(', ')}}`);
  console.log(`  final speed (diag) carve ${last(carve).speed.toFixed(2)}  vs  parallel ${last(parallel).speed.toFixed(2)}  (not gated: single sustained turn wanders to steeper terrain — see B for speed)`);

  console.log('\n--- Scenario A gates (tightness + pose + technique) ---');
  gate('committed turn locks into a carve', techniques(carve).has('carve'),
    `carve techniques {${[...techniques(carve)].join(', ')}}`);
  gate('skidded turn reads as parallel and never carves',
    techniques(parallel).has('parallel') && !techniques(parallel).has('carve'),
    `parallel techniques {${[...techniques(parallel)].join(', ')}}`);
  gate('parallel pivots harder than the carve (tighter turn)', parImp.dvx > carveImp.dvx * 1.2,
    `impulse ${parImp.dvx.toFixed(3)} > ${carveImp.dvx.toFixed(3)} (carve=${carveImp.technique}, parallel=${parImp.technique})`);
  gate('carve leans the body deeper into the turn', maxAbs(carve, 'lean') > maxAbs(parallel, 'lean'),
    `${maxAbs(carve, 'lean').toFixed(3)} > ${maxAbs(parallel, 'lean').toFixed(3)} rad`);
  gate('carve rolls the skis harder onto edge', maxAbs(carve, 'skiEdge') > maxAbs(parallel, 'skiEdge'),
    `${maxAbs(carve, 'skiEdge').toFixed(3)} > ${maxAbs(parallel, 'skiEdge').toFixed(3)} rad`);
  gate('carve draws the skis closer together than the parallel turn',
    Math.min(...carve.map((f) => f.skiGap)) < Math.min(...parallel.map((f) => f.skiGap)),
    `gap ${Math.min(...carve.map((f) => f.skiGap)).toFixed(2)} < ${Math.min(...parallel.map((f) => f.skiGap)).toFixed(2)}`);

  // === Scenario B: linked turns around the fall line (speed-holding) ==========
  // Both link turns that oscillate around the fall line, so they end near the same
  // x and share terrain; they differ only in reversal frequency:
  //   - carve   : 30-frame committed edges -> carveCharge locks into a carve.
  //   - chatter : reverse the edge every frame -> carveCharge never engages (skid).
  // The skid must finish clearly slower. (Measured spread is large; gate at a
  // conservative 8% so it stays robust, not flaky.)
  const PERIOD = 30;
  const carveLinked = run(update, (i) => (Math.floor(i / PERIOD) % 2 === 0 ? RIGHT : LEFT), { vz0: -20, steps: 120 });
  const skidLinked = run(update, (i) => (i % 2 === 0 ? RIGHT : LEFT), { vz0: -20, steps: 120 });
  const spread = last(carveLinked).speed / last(skidLinked).speed - 1;

  console.log('\n=== B) Linked turns around the fall line — speed-holding ===');
  console.log(`  carve   (committed ${PERIOD}-frame edges) finalSpeed ${last(carveLinked).speed.toFixed(2)} @x ${last(carveLinked).x.toFixed(1)}  techniques {${[...techniques(carveLinked)].join(', ')}}`);
  console.log(`  skid    (chatter every frame)        finalSpeed ${last(skidLinked).speed.toFixed(2)} @x ${last(skidLinked).x.toFixed(1)}  techniques {${[...techniques(skidLinked)].join(', ')}}`);
  console.log('\n--- Scenario B gate (speed-holding) ---');
  gate('committed carves hold more speed than chatter-skidding', spread > 0.08,
    `carve +${(spread * 100).toFixed(0)}% vs skid`);

  console.log(`\nTURN-STYLES COMPARE: ${hardFail ? 'FAIL ❌ (a distinctness gate failed)' : 'OK ✅ (carve and parallel turns are distinct in radius, speed, and pose)'}`);
  process.exit(hardFail ? 1 : 0);
})().catch((err) => { console.error('turn-styles compare harness crashed:', err); process.exit(1); });
