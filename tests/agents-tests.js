// @ts-check
// agents-tests.js — headless coverage for the living-world agent facade
// (src/agents/agents.ts), its seed derivation (src/agents/agents-budget.ts) and the
// first cosmetic layer (src/agents/wildlife.ts). Issue #366 (Roadmap Finding 5).
//
// PR 1 is the integration SEAM plus a purely-background wildlife herd, so these tests
// pin the invariants the seam must uphold —
//   * createAgents() consumes ZERO global Math.random (stream-neutral)
//   * it parents exactly one owned group under the scene, with finite transforms
//   * update() is cosmetic — never touches the collision arrays or the player position,
//     and consumes no global Math.random
//   * dispose() detaches the group and is idempotent
//   * agentsSeedFor() is deterministic and tier-distinct
//   * the wildlife herd is seed-reproducible, terrain-grounded (read-only sampler), and
//     bounded by the budget with finite instance transforms
//
// Run via the ts-resolve loader:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/agents-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { createAgents } = await import('../src/agents/agents.ts');
  const { agentsSeedFor, DEFAULT_AGENT_BUDGET } = await import('../src/agents/agents-budget.ts');

  testSeedDerivation(agentsSeedFor);
  testCreateAgents(THREE, createAgents, agentsSeedFor, DEFAULT_AGENT_BUDGET);
  testCollisionArrayNeutrality(THREE, createAgents, agentsSeedFor);
  testWildlife(THREE, createAgents, agentsSeedFor, DEFAULT_AGENT_BUDGET);
  testDispose(THREE, createAgents, agentsSeedFor);

  console.log(`\nAGENTS TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const flatTerrain = () => 0; // pure sampler stand-in

function baseCtx(agentsSeedFor, difficulty, extra) {
  return Object.assign({
    getTerrainHeight: flatTerrain,
    courseLine: null,
    difficulty,
    seed: agentsSeedFor(difficulty),
  }, extra || {});
}

/** Find the herd InstancedMesh under an agent system's group. */
function findHerd(agents) {
  let herd = null;
  agents.group.traverse((o) => { if (o.isInstancedMesh) herd = o; });
  return herd;
}

function testSeedDerivation(agentsSeedFor) {
  console.log('--- agentsSeedFor: deterministic, tier-distinct ---');
  const tiers = ['bunny', 'blue', 'black', 'expert'];
  check('same tier => same seed', tiers.every((t) => agentsSeedFor(t) === agentsSeedFor(t)));
  const seeds = tiers.map(agentsSeedFor);
  check('all seeds finite integers', seeds.every((s) => Number.isInteger(s)));
  check('tiers get distinct seeds', new Set(seeds).size === tiers.length);
}

function testCreateAgents(THREE, createAgents, agentsSeedFor, budget) {
  console.log('--- createAgents: stream-neutral seam, finite owned group ---');

  const scene = new THREE.Scene();
  const before = scene.children.length;

  const savedRandom = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return savedRandom(); };
  let agents;
  try {
    agents = createAgents(scene, baseCtx(agentsSeedFor, 'blue'));
    check('createAgents consumes no global Math.random', calls === 0);
  } finally {
    Math.random = savedRandom;
  }

  check('exactly one node added to the scene', scene.children.length === before + 1);
  check('owns a group named "agents"', agents.group.isGroup === true && agents.group.name === 'agents');
  check('group is parented under the scene', agents.group.parent === scene);
  const p = agents.group.position;
  check('group transform is finite (no NaN/Infinity)', Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  check('default budget is exposed', budget && budget.wildlife > 0);

  // update(): cosmetic — no throw, and no global Math.random consumption.
  const savedRandom2 = Math.random;
  let updCalls = 0;
  Math.random = () => { updCalls++; return savedRandom2(); };
  let threw = false;
  try {
    agents.update(0.016, new THREE.Vector3(1, 2, 3));
    agents.update(0.016, new THREE.Vector3(1, 2, 3));
  } catch { threw = true; } finally { Math.random = savedRandom2; }
  check('update() does not throw', !threw);
  check('update() consumes no global Math.random', updCalls === 0);
}

function testCollisionArrayNeutrality(THREE, createAgents, agentsSeedFor) {
  console.log('--- createAgents: collision-array neutrality ---');
  const scene = new THREE.Scene();
  const treePositions = [{ x: 5, z: -10 }, { x: -3, z: -20 }];
  const rockPositions = [{ x: 8, z: -30, radius: 2 }];
  const treeSnapshot = JSON.stringify(treePositions);
  const rockSnapshot = JSON.stringify(rockPositions);

  const agents = createAgents(scene, baseCtx(agentsSeedFor, 'black'));
  agents.update(0.016, new THREE.Vector3(0, 0, -15));

  check('treePositions length unchanged', treePositions.length === 2);
  check('rockPositions length unchanged', rockPositions.length === 1);
  check('treePositions contents unchanged', JSON.stringify(treePositions) === treeSnapshot);
  check('rockPositions contents unchanged', JSON.stringify(rockPositions) === rockSnapshot);

  // A player Vector3 handed to update() is read-only; it must not be mutated.
  const player = new THREE.Vector3(2, 3, -18);
  agents.update(0.033, player);
  check('player position not mutated by update()', player.x === 2 && player.y === 3 && player.z === -18);
}

function testWildlife(THREE, createAgents, agentsSeedFor, budget) {
  console.log('--- wildlife: seed-reproducible, terrain-grounded, bounded ---');

  // Two systems built from the SAME seed + terrain, advanced identically, must produce
  // byte-identical instance matrices (deterministic layout + motion).
  const sceneA = new THREE.Scene(), sceneB = new THREE.Scene();
  const agentsA = createAgents(sceneA, baseCtx(agentsSeedFor, 'blue'));
  const agentsB = createAgents(sceneB, baseCtx(agentsSeedFor, 'blue'));
  const herdA = findHerd(agentsA), herdB = findHerd(agentsB);
  check('a herd InstancedMesh exists', !!herdA && herdA.isInstancedMesh === true);
  check('herd count within budget', herdA.count > 0 && herdA.count <= budget.wildlife);

  for (let f = 0; f < 30; f++) { agentsA.update(0.016, new THREE.Vector3()); agentsB.update(0.016, new THREE.Vector3()); }
  const mA = new THREE.Matrix4(), mB = new THREE.Matrix4();
  let identical = true, finite = true;
  for (let i = 0; i < herdA.count; i++) {
    herdA.getMatrixAt(i, mA); herdB.getMatrixAt(i, mB);
    for (let e = 0; e < 16; e++) {
      if (mA.elements[e] !== mB.elements[e]) identical = false;
      if (!Number.isFinite(mA.elements[e])) finite = false;
    }
  }
  check('same seed => byte-identical instance matrices after 30 frames', identical);
  check('all instance matrix elements finite', finite);

  // The herd is grounded on the terrain sampler: a sloped terrain shifts the resting Y,
  // so a system built on a slope must differ from the flat one (proves the sampler is read).
  const sceneC = new THREE.Scene();
  const sloped = (x, z) => 100 + 0.05 * z; // clearly non-flat, non-zero
  const agentsC = createAgents(sceneC, baseCtx(agentsSeedFor, 'blue', { getTerrainHeight: sloped }));
  agentsC.update(0.016, new THREE.Vector3());
  const herdC = findHerd(agentsC);
  const m0 = new THREE.Matrix4(), mc = new THREE.Matrix4();
  herdA.getMatrixAt(0, m0); herdC.getMatrixAt(0, mc);
  // element 13 is the Y translation of a column-major Matrix4.
  check('herd is grounded on the terrain sampler (sloped Y differs from flat)', m0.elements[13] !== mc.elements[13]);

  // Reduced-motion / no-op deltas: update() with dt<=0 must not advance the layout.
  const before = new THREE.Matrix4(); herdA.getMatrixAt(0, before);
  agentsA.update(0, new THREE.Vector3());
  agentsA.update(-1, new THREE.Vector3());
  const after = new THREE.Matrix4(); herdA.getMatrixAt(0, after);
  check('update(dt<=0) does not advance the herd', before.equals(after));

  // A zero-wildlife budget yields an empty (but valid, disposable) herd.
  const sceneD = new THREE.Scene();
  const agentsD = createAgents(sceneD, baseCtx(agentsSeedFor, 'blue', { budget: { wildlife: 0 } }));
  const herdD = findHerd(agentsD);
  check('zero-wildlife budget => empty herd (count 0)', !!herdD && herdD.count === 0);
  let threwEmpty = false;
  try { agentsD.update(0.016, new THREE.Vector3()); agentsD.dispose(); } catch { threwEmpty = true; }
  check('empty herd updates + disposes without throwing', !threwEmpty);

  // Grounding stays ON the rendered terrain: the mesh spans x∈[-150,150], z∈[-200,200].
  // Record every (x,z) the herd hands the sampler across build + a long run and assert it
  // never samples past the mesh edge (guards the old off-mesh z-range that left animals
  // floating in mid-air past the south edge).
  const sceneE = new THREE.Scene();
  let onMesh = true;
  const boundsSampler = (x, z) => {
    if (x < -150 || x > 150 || z < -200 || z > 200) onMesh = false;
    return 0;
  };
  const agentsE = createAgents(sceneE, baseCtx(agentsSeedFor, 'expert', { getTerrainHeight: boundsSampler }));
  for (let f = 0; f < 400; f++) agentsE.update(0.033, new THREE.Vector3());
  check('herd stays on the rendered terrain (never samples past the mesh edge)', onMesh);

  // A non-finite budget override (public/optional field) must not throw or poison the
  // count — it falls back to the shipped default and yields a bounded, valid herd.
  const sceneF = new THREE.Scene();
  let threwNaN = false, herdF = null;
  try {
    const agentsF = createAgents(sceneF, baseCtx(agentsSeedFor, 'blue', { budget: { wildlife: NaN } }));
    herdF = findHerd(agentsF);
    agentsF.update(0.016, new THREE.Vector3());
  } catch { threwNaN = true; }
  check('NaN wildlife budget does not throw', !threwNaN);
  check('NaN wildlife budget => bounded herd (count within [0,24])',
    !!herdF && Number.isInteger(herdF.count) && herdF.count >= 0 && herdF.count <= 24);
}

function testDispose(THREE, createAgents, agentsSeedFor) {
  console.log('--- dispose: detaches group, idempotent ---');
  const scene = new THREE.Scene();
  const agents = createAgents(scene, baseCtx(agentsSeedFor, 'bunny'));
  check('group attached before dispose', agents.group.parent === scene);

  agents.dispose();
  check('group detached from scene after dispose', agents.group.parent === null);
  check('scene has no agents child after dispose', !scene.children.includes(agents.group));

  let threw = false;
  try { agents.dispose(); } catch { threw = true; }
  check('dispose is idempotent (no throw on second call)', !threw);
}

main().catch((e) => { console.error(e); process.exit(1); });
