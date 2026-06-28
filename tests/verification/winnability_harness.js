// @ts-check
// winnability_harness.js
// Two-sided winnability gate for the avalanche — the property neither existing
// harness covers (see forward_stress_harness.js for termination/finishability of the
// physics descent, and avalanche_framerate_harness.js for the boulder kernel in
// isolation; NEITHER runs the descent against a live slide):
//
//   G2  a too-slow descent is BURIED before the finish (the slide is a real threat)
//   G3  a full-speed descent ESCAPES and reaches the finish (the course is winnable)
//
// The invariant being protected:  the course is "winnable but not guaranteed" — a
// full-speed line reaches the finish, a too-slow line gets buried. A balance/physics
// tweak that quietly drops the escape speed below reach (course becomes UNwinnable)
// fails G3; one that neuters the slide so it never catches anyone fails G2.
//
// Player = a constant-terminal-speed point on the fall line vs. the REAL
// AvalancheSystem on the REAL slope, triggered exactly where the game triggers it
// (player starts at z=-15 and skis to z=-195; the slide fires AVALANCHE_TRIGGER_DISTANCE
// = 80 units in, at z=-95). Burial is the real checkBurial(); survival is the real
// hasPassed(). The constant-speed model is deliberately KERNEL-LEVEL — it isolates the
// avalanche from physics-integration noise and keeps the gate deterministic across
// machines/frame rates. (Real-physics-vs-slide fidelity is the Tier-2 e2e target.)
//
// Fixed dt = 1/60 so the per-frame point-in-sphere burial test can't tunnel: a coarse
// dt lets a fast player skip straight through a boulder between samples (a 6 m/s line
// buried at 1/60 s "escapes" at 1/10 s). 1/60 keeps the check conservative.
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/winnability_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals the avalanche + terrain touch (no DOM/WebGL). document
// stays undefined so the powder-sprite pool is skipped (and its Math.random() calls
// with it), keeping every descent byte-deterministic from the seed alone.
const g = /** @type {any} */ (globalThis);
g.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
g.document = undefined;
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

const FIXED_DT = 1 / 60;     // fine step: conservative burial sampling, no tunneling
const FINISH_Z = -195;       // course finish (course.ts FINISH_Z)
const TRIGGER_Z = -95;       // start z (-15) + AVALANCHE_TRIGGER_DISTANCE (80) downhill
const COUNT = 120;           // in-game boulder count (scene-setup.ts)
const HIT_RADIUS = 2;        // checkBurial default (matches the main-loop call)

// In-game top freewheel speed is ~8.2 (hold-Up) to ~9.6 (a tuned slalom) m/s at 60 FPS
// (forward_stress_harness summary). These two speeds bracket the observed escape/burial
// boundary; they are the only tunables. Keep a one-line note here if the balance shifts.
const FULL_SPEED = 9.0;      // a player who keeps their speed up (a good, fast line)
const SLOW_SPEED = 6.0;      // a heavily-braking / snowplowing player
const SEEDS = [12345, 777, 42, 9001, 31337];

// Clearance G3 must keep beyond the worst-case burial radius, so the gate has margin
// and isn't tripped by a single tweak. hitRadius + the largest boulder (0.4 + 1.2).
const SAFE_MARGIN = 1.0;     // metres of slack above (HIT_RADIUS + MAX_BOULDER)
const MAX_BOULDER = 0.4 + 1.2;

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

(async () => {
  await import(pathToFileURL(path.join(__dirname, '..', 'loaders', 'register-ts-resolve.mjs')).href);
  const THREE = await import('three');
  const { AvalancheSystem } = await import('../../src/avalanche.ts');
  const { getTerrainHeight } = await import('../../src/mountains/terrain.ts');

  // One descent at constant `speed` from the trigger point. Returns whether the player
  // was buried, the closest a boulder ever got (planar), and whether the finish was
  // reached (crossed z<-195, or the slide fell behind = survived).
  function runDescent(seed, speed) {
    Math.random = makeRng(seed);
    const _log = console.log; console.log = () => {};          // silence trigger() banner
    const scene = new THREE.Scene();
    const av = new AvalancheSystem(scene, COUNT);
    av.setTerrainFunction(getTerrainHeight);

    const player = { x: 0, y: 0, z: TRIGGER_Z };
    player.y = getTerrainHeight(player.x, player.z);
    av.trigger(player);
    console.log = _log;

    let buried = false, finished = false, minDist = Infinity, t = 0;
    while (t < 60) {
      av.update(FIXED_DT);
      player.z -= speed * FIXED_DT;
      player.y = getTerrainHeight(player.x, player.z);

      if (av.checkBurial(player, HIT_RADIUS)) { buried = true; break; }
      minDist = Math.min(minDist, av.getClosestDistance(player));
      if (player.z <= FINISH_Z) { finished = true; break; }
      if (av.hasPassed(player)) { finished = true; break; } // slide fell behind = survived
      t += FIXED_DT;
    }
    av.dispose();
    return { buried, finished, minDist };
  }

  // --- Gate runner --------------------------------------------------------------
  let failed = 0;
  function gate(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name} ${ok ? '✅' : '❌'}  ${detail}`);
    if (!ok) failed++;
  }

  console.log('=== Winnability: full speed escapes, slow speed is buried (real avalanche) ===');
  console.log(`dt = 1/60 | trigger z = ${TRIGGER_Z} | finish z = ${FINISH_Z} | full = ${FULL_SPEED} | slow = ${SLOW_SPEED} | seeds = ${SEEDS.length}`);

  const fast = SEEDS.map(s => runDescent(s, FULL_SPEED));
  const slow = SEEDS.map(s => runDescent(s, SLOW_SPEED));

  const threshold = HIT_RADIUS + MAX_BOULDER;
  const worstFastClearance = Math.min(...fast.map(r => r.minDist)) - threshold;

  console.log('\n--- G3: full-speed line escapes and finishes [GATING] ---');
  gate('full-speed descent reaches the finish, every seed',
    fast.every(r => r.finished && !r.buried),
    `finished ${fast.filter(r => r.finished).length}/${SEEDS.length}, buried ${fast.filter(r => r.buried).length}`);
  gate('full-speed clearance stays above the burial radius',
    worstFastClearance > SAFE_MARGIN,
    `worst clearance ${worstFastClearance.toFixed(2)} m (need > ${SAFE_MARGIN})`);

  console.log('\n--- G2: a too-slow line is buried (the slide is a real threat) [GATING] ---');
  gate('slow descent is buried before finishing, every seed',
    slow.every(r => r.buried && !r.finished),
    `buried ${slow.filter(r => r.buried).length}/${SEEDS.length}`);

  console.log(`\nWINNABILITY HARNESS: ${failed ? 'FAIL ❌' : 'OK ✅ (winnable at speed; lethal when slow)'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
