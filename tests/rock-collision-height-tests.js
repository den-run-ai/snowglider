// @ts-check
/**
 * Height-aware rock collision tests (issue #348, rock realism recovery PR 5).
 *
 * The old model treated EVERY rock hazard top as `y + 0.7·size`, so an airborne
 * player could be flagged as "clearing" a tall crag while visually passing through
 * it (the practical exposure: the collidable pinch-gate cliffs on Black/Expert).
 * Hazards now carry `topY` — the world-space top of the actual placed mesh — and
 * the clearance check uses it.
 *
 * Pins BOTH directions against the real detectCollisionsAndFinish:
 *   - airborne overlap BELOW topY + 0.5 ⇒ collision registers (would have been a
 *     phantom "clear" under the old model — fails against the old code);
 *   - airborne overlap ABOVE topY + 0.5 ⇒ cleared AND the rock-clear observation
 *     is reported (JP-2 scoring path);
 *   - grounded overlap ⇒ collision regardless of height;
 *   - legacy fallback: a fixture without topY behaves exactly as the old
 *     `y + 0.7·size` model (synthetic fixtures / rollout safety);
 *   - producer contract: every hazard addRocks returns carries a finite topY in a
 *     sane band over its terrain sample, and the honest tops straddle the legacy
 *     flat model — squat scraped boulders sit LOWER than 0.7·size (the old model
 *     blocked visually-clean jumps), crags far higher (the phantom clears).
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/rock-collision-height-tests.js
 */

// Minimal window shim (same as tree-jump-collision-tests): collision.ts reads
// window.location.search; kept free of "test" so the real production path runs.
globalThis.window = /** @type {any} */ ({ location: { search: '' } });

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ PASS: ${name}`); }
  else { failed++; console.log(`❌ FAIL: ${name}${detail ? `\n   ${detail}` : ''}`); }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run() {
  console.log('\n🪨🦅 SNOWGLIDER HEIGHT-AWARE ROCK COLLISION TESTS (#348) 🪨🦅');
  console.log('==============================================================\n');

  const { detectCollisionsAndFinish } = await import('../src/snowman/collision.js');

  /**
   * One collision frame against a single rock hazard.
   * @param {{x:number,y:number,z:number}} pos
   * @param {boolean} isInAir
   * @param {any} rock
   */
  function frame(pos, isInAir, rock) {
    /** @type {string|null} */
    let reason = null;
    /** @type {any[]} */
    let clears = [];
    detectCollisionsAndFinish({
      pos,
      isInAir,
      terrainHeightAtPosition: 0,
      treePositions: [],
      rockPositions: [rock],
      gameActive: true,
      showGameOver: (r) => { reason = r; },
      onObstaclesCleared: (c) => { clears = c; },
    });
    return { reason, clears };
  }

  // A tall pinch-gate-like crag: base terrain y=0, size 2.2, mesh top at 3.4u —
  // far above the legacy model's 0.7·size = 1.54u.
  const tallCrag = { x: 0, y: 0, z: 0, size: 2.2, topY: 3.4 };
  const legacyTop = tallCrag.y + tallCrag.size * 0.7; // 1.54

  {
    // The #348 phantom clear: airborne at y=2.5 — above legacy top + 0.5 (2.04),
    // but INSIDE the visible 3.4u crag. Old model: cleared. New model: crash.
    const r = frame({ x: 0.5, y: 2.5, z: 0 }, true, tallCrag);
    check('airborne overlap BELOW the real top registers a collision (the #348 fix)',
      r.reason !== null && /rock/i.test(String(r.reason)),
      `reason=${r.reason}`);
  }
  {
    // Above the real top + 0.5 clearance: cleared, and the clear is observed.
    const r = frame({ x: 0.5, y: 4.0, z: 0 }, true, tallCrag);
    check('airborne pass ABOVE topY + 0.5 clears the crag', r.reason === null, `reason=${r.reason}`);
    check('...and the rock-clear observation is reported (JP-2 scoring path)',
      r.clears.length === 1 && r.clears[0].type === 'rock', JSON.stringify(r.clears));
  }
  {
    // Grounded overlap: collision regardless of any height bookkeeping.
    const r = frame({ x: 0.5, y: 0.2, z: 0 }, false, tallCrag);
    check('grounded overlap still collides', r.reason !== null, `reason=${r.reason}`);
  }
  {
    // Legacy fallback: same geometry WITHOUT topY behaves as the old model — the
    // y=2.5 airborne pass clears (this is exactly the pre-#348 behavior, kept only
    // for synthetic fixtures that omit topY).
    const legacy = { x: 0, y: 0, z: 0, size: 2.2 };
    const r = frame({ x: 0.5, y: 2.5, z: 0 }, true, legacy);
    check('fixture without topY falls back to the legacy y + 0.7·size model',
      r.reason === null && r.clears.length === 1,
      `reason=${r.reason} clears=${JSON.stringify(r.clears)}`);
    check('sanity: legacy top for this rock is 1.54', Math.abs(legacyTop - 1.54) < 1e-12);
  }
  {
    // Boundary: just below vs just above the +0.5 clearance line on the real top.
    const below = frame({ x: 0, y: tallCrag.topY + 0.49, z: 0 }, true, tallCrag);
    const above = frame({ x: 0, y: tallCrag.topY + 0.51, z: 0 }, true, tallCrag);
    check('clearance boundary sits at topY + 0.5 (below hits, above clears)',
      below.reason !== null && above.reason === null,
      `below=${below.reason} above=${above.reason}`);
  }

  // --- Producer contract: addRocks hazards all carry a sane topY ------------------
  const THREE = await import('three');
  const { addRocks } = await import('../src/mountains/rocks.js');
  const realRandom = Math.random;
  Math.random = mulberry32(20260709);
  /** @type {any[]} */
  let hazards;
  try {
    hazards = addRocks(new THREE.Scene());
  } finally {
    Math.random = realRandom;
  }
  check('addRocks produced hazards to inspect', hazards.length > 0, `${hazards.length}`);
  let finite = 0, insideBand = 0, belowLegacy = 0, aboveLegacy = 0;
  for (const h of hazards) {
    if (Number.isFinite(h.topY)) finite++;
    // Sane band over the canonical sink: a hazard must still stand proud of its
    // terrain sample (a squat scraped boulder tilted by slope alignment can dip
    // to ~0.3·size) and can never exceed the tallest cliff envelope
    // (1.8·size above centre − 0.28·size sink).
    const rel = (h.topY - h.y) / h.size;
    if (rel >= 0.25 - 1e-9 && rel <= 1.8 - 0.28 + 1e-9) insideBand++;
    // Informational split vs the legacy flat 0.7·size model: honest tops land on
    // BOTH sides — squat scraped boulders sit lower (the old model overestimated
    // them and blocked visually-clean jumps), crags far higher (the #348 phantom
    // clears). Neither direction is asserted per-rock; the mix is the point.
    if (rel < 0.7) belowLegacy++; else aboveLegacy++;
  }
  check('every hazard carries a finite topY', finite === hazards.length, `${finite}/${hazards.length}`);
  check('every topY sits in the sane band over its terrain sample (0.25–1.52·size)',
    insideBand === hazards.length, `${insideBand}/${hazards.length}`);
  check('honest tops straddle the legacy 0.7·size model (both failure modes were real)',
    belowLegacy > 0 && aboveLegacy > 0, `below=${belowLegacy} above=${aboveLegacy}`);

  console.log(`\n==================================`);
  console.log(`Rock collision-height tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error('Rock collision-height test harness crashed:', e);
  process.exit(1);
});
