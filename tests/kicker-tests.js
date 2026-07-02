// @ts-check
/**
 * Unit tests for the sculpted course-line kickers (jump-system completion JP-6) —
 * mountains/terrain.ts `setTerrainKickers` / `kickerRampHeight`.
 *
 * The kickers are the designed-air surface for the ◆◆ Expert tier: a ramp that
 * rises smoothly to a lip and then DROPS (the tabletop face the auto-jump launches
 * off), centered laterally on the descent centerline. These tests pin the JP-6
 * contracts:
 *   - NO kickers ⇒ `kickerRampHeight` is 0 and getTerrainHeight is untouched (the
 *     byte-identical guardrail for every tier without `features`).
 *   - the ramp rises monotonically along the approach to exactly `height` at the
 *     lip, tapers to 0 at the lateral edges, and is 0 PAST the lip (the drop).
 *   - getTerrainHeight WITH kickers == today's height + the SAME ramp term (the
 *     §2.2 two-formula contract: one shared formula for mesh and sampler).
 *   - each kicker is centered at laneX(lip z) of the line it was set with.
 *   - setting/clearing kickers resets the (tier-blind) heightMap cache.
 *
 * Imports the THREE-free terrain LEAF directly (not the mountains facade, which
 * pulls in three.js), so it runs headlessly — same pattern as the corridor suite.
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/kicker-tests.js
 */

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e instanceof Error ? e.message : String(e)}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, eps, msg) {
  if (Math.abs(a - b) > (eps == null ? 1e-9 : eps)) {
    throw new Error(`${msg || 'expected close'}: ${a} vs ${b} (eps ${eps})`);
  }
}

(async () => {
  const T = await import('../src/mountains/terrain.js');
  const { courseLineFor } = await import('../src/course-line.js');
  const { getDifficultyConfig } = await import('../src/difficulty.js');
  const {
    setTerrainKickers, kickerRampHeight, hasActiveKickers, resetHeightMap,
    getTerrainHeight, heightMap,
  } = T;

  console.log('\n🎿 SNOWGLIDER KICKER TESTS (JP-6, designed air) 🎿');
  console.log('=================================================\n');

  const expert = getDifficultyConfig('expert');
  const line = courseLineFor(expert);
  const kicker = { z: -100, length: 8, halfWidth: 7, height: 2.2 };

  runTest('no kickers set: ramp term is 0 and the sampler is byte-identical', () => {
    setTerrainKickers(null);
    assert(!hasActiveKickers(), 'no active kickers');
    assert(kickerRampHeight(0, -100) === 0, 'ramp term must be 0');
    resetHeightMap();
    const before = getTerrainHeight(3, -104);
    setTerrainKickers([]);           // empty list == none (the guardrail)
    assert(!hasActiveKickers(), 'empty features == no kickers');
    near(getTerrainHeight(3, -104), before, 0, 'height untouched with no kickers');
  });

  runTest('the ramp rises to exactly `height` at the lip and is 0 past it (the drop)', () => {
    setTerrainKickers([kicker], null); // centered at x = 0 (no line)
    // Entry edge (z = lip + length): 0. Mid-ramp: between 0 and height. Lip: height.
    near(kickerRampHeight(0, kicker.z + kicker.length), 0, 1e-9, 'entry edge is 0');
    const mid = kickerRampHeight(0, kicker.z + kicker.length / 2);
    assert(mid > 0 && mid < kicker.height, `mid-ramp in (0, height), got ${mid}`);
    near(kickerRampHeight(0, kicker.z), kicker.height, 1e-9, 'lip reaches full height');
    // Monotonic along the approach (skiing -z: u grows as z falls toward the lip).
    let prev = -1;
    for (let u = 0; u <= 1.0001; u += 0.1) {
      const h = kickerRampHeight(0, kicker.z + kicker.length * (1 - u));
      assert(h >= prev - 1e-12, `ramp must rise monotonically (u=${u.toFixed(1)})`);
      prev = h;
    }
    // Past the lip (further downhill): the drop — 0 immediately.
    assert(kickerRampHeight(0, kicker.z - 0.01) === 0, 'past the lip the added height is 0');
    assert(kickerRampHeight(0, kicker.z - 5) === 0, 'well past the lip is 0');
  });

  runTest('the ramp tapers smoothly to 0 at the lateral edges', () => {
    setTerrainKickers([kicker], null);
    const zLip = kicker.z;
    near(kickerRampHeight(kicker.halfWidth, zLip), 0, 1e-9, 'edge (+halfWidth) is 0');
    near(kickerRampHeight(-kicker.halfWidth, zLip), 0, 1e-9, 'edge (−halfWidth) is 0');
    const off = kickerRampHeight(kicker.halfWidth / 2, zLip);
    assert(off > 0 && off < kicker.height, `half-off-center in (0, height), got ${off}`);
    assert(kickerRampHeight(kicker.halfWidth + 1, zLip) === 0, 'outside the footprint is 0');
  });

  runTest('two-formula contract: getTerrainHeight == base + the SAME ramp term', () => {
    setTerrainKickers(null);
    resetHeightMap();
    const probes = [
      [0, kicker.z], [2, kicker.z + 3], [-4, kicker.z + 6], [0, kicker.z - 2], [9, kicker.z],
    ];
    const bases = probes.map(([x, z]) => getTerrainHeight(x, z));
    setTerrainKickers([kicker], null); // resets the cache itself
    probes.forEach(([x, z], i) => {
      near(getTerrainHeight(x, z), bases[i] + kickerRampHeight(x, z), 1e-9,
        `height at (${x}, ${z}) must be base + ramp`);
    });
  });

  runTest('kickers center on laneX(lip z) of the line they were set with', () => {
    setTerrainKickers([kicker], line);
    const xc = line.laneX(kicker.z);
    near(kickerRampHeight(xc, kicker.z), kicker.height, 1e-9, 'full height on the line');
    near(kickerRampHeight(xc + kicker.halfWidth, kicker.z), 0, 1e-9, 'taper edge follows the line');
    // The Expert line winds (amplitude 18), so the center is genuinely off x=0
    // somewhere; assert the wiring is line-aware at a lip where laneX ≠ 0.
    const winding = expert.features.find((k) => Math.abs(line.laneX(k.z)) > 1);
    if (winding) {
      setTerrainKickers([winding], line);
      const wxc = line.laneX(winding.z);
      near(kickerRampHeight(wxc, winding.z), winding.height, 1e-9, 'winding lip centered on laneX');
      assert(kickerRampHeight(0, winding.z) < winding.height, 'x=0 is off-center there');
    }
  });

  runTest('setting/clearing kickers resets the heightMap cache', () => {
    setTerrainKickers(null);
    resetHeightMap();
    getTerrainHeight(0, kicker.z); // populate one entry
    assert(Object.keys(heightMap).length > 0, 'cache populated');
    setTerrainKickers([kicker], null);
    assert(Object.keys(heightMap).length === 0, 'cache cleared on set');
    getTerrainHeight(0, kicker.z);
    setTerrainKickers(null);
    assert(Object.keys(heightMap).length === 0, 'cache cleared on clear');
  });

  console.log('\n================================================');
  console.log(`Kicker tests: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
