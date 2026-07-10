/**
 * EZ forest wind-sway deformation bounds (headless, deterministic).
 *
 * Guards the "realistic trees disappeared from the foreground" regression at the
 * level the player actually sees: how far the sway shader is allowed to deform a
 * single EZ tree *within itself* at maximum gust. The GPU chunk cannot run in
 * Node, so this suite mirrors TREE_SWAY_PROJECT_VERTEX's lean/flutter formula in
 * JS (see the NOTE beside the chunk in src/mountains/trees.ts — the two must be
 * updated in lockstep; tests/trees-tests.js pins the GLSL text itself) and
 * evaluates it over the REAL generated EZ archetype geometry:
 *
 *  - per-needle-card deformation (max displacement spread across one card's 4
 *    vertices) stays below a small world-unit bound — cards ride the sway as
 *    stiff sprites instead of shearing into diagonal scraggle;
 *  - equal-height branch vertices sway together (intra-tree coherence) — the
 *    only intra-tree variation is the height-rooted swayWeight;
 *  - the pre-fix formula (per-vertex world phase + raw local-position flutter
 *    frequencies) VIOLATES both bounds on the same geometry, so this suite
 *    genuinely discriminates the regression it pins.
 *
 * Runs in plain Node via the ts-resolve loader (auto-discovered by npm test):
 *   node --import ./tests/loaders/register-ts-resolve.mjs tests/ez-sway-deformation-tests.js
 */

let passCount = 0;
let failCount = 0;
function assert(condition, message, detail) {
  if (condition) {
    passCount++;
    console.log(`✅ PASS: ${message}${detail ? ' - ' + detail : ''}`);
  } else {
    failCount++;
    console.error(`❌ FAIL: ${message}${detail ? ' - ' + detail : ''}`);
  }
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Shader constants mirrored from src/mountains/trees.ts (TREE_SWAY_HEAD_BASE /
// TREE_SWAY_PROJECT_VERTEX / EZ_TREE_TARGET_HEIGHT / TREE_SWAY_MAX_AMP).
const RATE = 1.1;
const MAX_AMP = 0.9;
const TARGET_HEIGHT = 10;

/** CURRENT formula: per-instance phase, swayWeight-keyed flutter (loadEase = 1). */
function dispNew(v, origin, rootHeight, t) {
  const weight = clamp01(v.y / rootHeight);
  const phase = 0.35 * origin.x + 0.27 * origin.z;
  const osc = Math.sin(RATE * t + phase) + 0.3 * Math.sin(RATE * 2.1 * t + phase * 1.7);
  const ampVar = 0.82 + 0.18 * Math.sin(phase * 5.7 + 2.1);
  const lean = MAX_AMP * ampVar * weight * (0.6 + 0.4 * osc);
  const flutter = MAX_AMP * weight *
    (0.10 * Math.sin(5.3 * t + phase * 3.9 + weight * 6.0) +
     0.06 * Math.sin(8.9 * t + phase * 7.1 + weight * 11.0));
  return { x: lean, z: flutter }; // wind dir (1, 0): lean downwind, flutter crosswind
}

/** PRE-FIX formula: per-vertex WORLD phase + raw LOCAL-position flutter frequencies. */
function dispOld(v, origin, rootHeight, scale, t) {
  const weight = clamp01(v.y / rootHeight);
  const phase = 0.35 * (origin.x + scale * v.x) + 0.27 * (origin.z + scale * v.z);
  const osc = Math.sin(RATE * t + phase) + 0.3 * Math.sin(RATE * 2.1 * t + phase * 1.7);
  const ampVar = 0.82 + 0.18 * Math.sin(phase * 5.7 + 2.1);
  const lean = MAX_AMP * ampVar * weight * (0.6 + 0.4 * osc);
  const flutter = MAX_AMP * weight *
    (0.10 * Math.sin(5.3 * t + phase * 3.9 + v.y * 2.0) +
     0.06 * Math.sin(8.9 * t + phase * 7.1 + v.x * 3.0));
  return { x: lean, z: flutter };
}

/** Max pairwise 2D displacement spread within one 4-vertex needle card. */
function cardSpread(disps) {
  let max = 0;
  for (let i = 0; i < disps.length; i++) {
    for (let j = i + 1; j < disps.length; j++) {
      const d = Math.hypot(disps[i].x - disps[j].x, disps[i].z - disps[j].z);
      if (d > max) max = d;
    }
  }
  return max;
}

async function run() {
  const { setEzForestEnabled, ensureEzArchetypes, resetEzForest, EZ_SPECIES_COUNT } =
    await import('../src/mountains/ez-forest.js');
  setEzForestEnabled(true);
  const archetypes = await ensureEzArchetypes();
  try {
    assert(archetypes.length === EZ_SPECIES_COUNT * 2, 'real EZ archetypes generated (near + far builds)',
      `${archetypes.length} archetypes`);

    // Trees planted at a few representative origins on the slope; a full gust; time
    // swept over several oscillation periods. All deterministic — no RNG, no clock.
    const origins = [{ x: 12, z: -60 }, { x: -25, z: -100 }, { x: 30, z: 0 }];
    const times = Array.from({ length: 32 }, (_, i) => i * 0.4);

    let newMaxCard = 0;   // worst per-card spread, current formula
    let oldMaxCard = 0;   // worst per-card spread, pre-fix formula
    let newMaxLevel = 0;  // worst equal-height branch spread, current formula
    let oldMaxLevel = 0;  // worst equal-height branch spread, pre-fix formula

    for (const a of archetypes.slice(0, EZ_SPECIES_COUNT)) { // near builds = the foreground trees
      const scale = TARGET_HEIGHT / a.height;
      const leafPos = a.leaves.getAttribute('position');
      const branchPos = a.branches.getAttribute('position');
      for (const origin of origins) {
        for (const t of times) {
          // Needle cards: consecutive 4-vertex quads (billboard doubles are 2 quads).
          for (let q = 0; q + 4 <= leafPos.count; q += 4) {
            const vs = [0, 1, 2, 3].map((k) => ({
              x: leafPos.getX(q + k), y: leafPos.getY(q + k), z: leafPos.getZ(q + k)
            }));
            const sNew = cardSpread(vs.map((v) => dispNew(v, origin, a.height, t)));
            const sOld = cardSpread(vs.map((v) => dispOld(v, origin, a.height, scale, t)));
            if (sNew > newMaxCard) newMaxCard = sNew;
            if (sOld > oldMaxCard) oldMaxCard = sOld;
          }
          // Intra-tree coherence: bucket branch vertices by height band; vertices in
          // the same band must sway (near-)identically.
          const buckets = new Map();
          for (let i = 0; i < branchPos.count; i++) {
            const v = { x: branchPos.getX(i), y: branchPos.getY(i), z: branchPos.getZ(i) };
            const band = Math.round((v.y / a.height) * 20);
            if (!buckets.has(band)) buckets.set(band, []);
            buckets.get(band).push(v);
          }
          for (const vs of buckets.values()) {
            if (vs.length < 2) continue;
            const sNew = cardSpread(vs.map((v) => dispNew(v, origin, a.height, t)));
            const sOld = cardSpread(vs.map((v) => dispOld(v, origin, a.height, scale, t)));
            if (sNew > newMaxLevel) newMaxLevel = sNew;
            if (sOld > oldMaxLevel) oldMaxLevel = sOld;
          }
        }
      }
    }

    console.log(`  per-card spread   — new: ${newMaxCard.toFixed(3)}u | old: ${oldMaxCard.toFixed(3)}u`);
    console.log(`  same-height spread — new: ${newMaxLevel.toFixed(3)}u | old: ${oldMaxLevel.toFixed(3)}u`);

    // A needle card is ~0.5-1.5 world units across; deformation beyond ~a third of
    // a unit visibly shears it. The bound covers the height-rooted weight varying
    // across a card (the intended base-anchored bend) with margin.
    assert(newMaxCard < 0.35,
      'max-gust per-card deformation stays below the shear-visibility bound',
      `${newMaxCard.toFixed(3)}u < 0.35u at amp ${MAX_AMP}`);
    assert(oldMaxCard > newMaxCard * 2,
      'the pre-fix formula deforms needle cards at least 2x more (test discriminates the regression)',
      `old ${oldMaxCard.toFixed(3)}u vs new ${newMaxCard.toFixed(3)}u`);

    // Equal-height parts of one tree must move together — the intra-tree scramble
    // (parts of one tree at different phases) is exactly what crumpled the pines.
    assert(newMaxLevel < 0.15,
      'equal-height branch vertices sway coherently (intra-tree scramble bounded)',
      `${newMaxLevel.toFixed(3)}u < 0.15u`);
    assert(oldMaxLevel > 0.3,
      'the pre-fix formula scrambles equal-height vertices past the bound (test discriminates)',
      `${oldMaxLevel.toFixed(3)}u > 0.3u`);
  } finally {
    resetEzForest();
    setEzForestEnabled(null);
  }
}

run().then(() => {
  console.log('=================================');
  console.log(`EZ sway deformation tests completed: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}).catch((err) => {
  console.error('EZ sway deformation tests crashed:', err);
  process.exit(1);
});
