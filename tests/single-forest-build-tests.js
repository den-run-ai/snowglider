// @ts-check
/**
 * Single forest build — source contract (#397).
 *
 * The forest must be built EXACTLY ONCE per scene setup, inside createTerrain:
 * that one build supplies (a) the rendered trees, (b) the collision positions, and
 * (c) the positions the baked contact shadows are derived from. scene-setup.ts
 * used to call Snow.addTrees() a second time "for collision", which replaced the
 * visible forest and collision layout with a fresh random one while the contact-AO
 * blobs stayed keyed to the discarded first forest — tree shadows where no tree
 * stands, doubled placement/geometry/global-RNG work, and two async EZ-tree builds
 * racing back-to-back.
 *
 * createTerrain cannot run headless (its snow textures need a 2D canvas), so this
 * pins the wiring at the source level: scene-setup must consume the treePositions
 * createTerrain returns and must not schedule its own forest build, and
 * terrain-mesh must derive the contact shadows from that same single build.
 */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ PASS: ${name}`); }
  else { failed++; console.log(`❌ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

console.log('\n🌲 SINGLE FOREST BUILD — SOURCE CONTRACT (#397) 🌲');
console.log('==================================================\n');

const sceneSetup = read('src/game/scene-setup.ts');
const terrainMesh = read('src/mountains/terrain-mesh.ts');

check('scene-setup consumes the treePositions createTerrain returned',
  /terrainResult\.treePositions/.test(sceneSetup));

check('scene-setup does not build a second forest via Snow.addTrees(...)',
  !/Snow\.addTrees\s*\(/.test(sceneSetup),
  'a second addTrees call replaces the forest the contact shadows were baked from');

check('scene-setup no longer carries the addTreesWithPositions wrapper',
  !/function\s+addTreesWithPositions/.test(sceneSetup));

check('createTerrain builds the forest and returns its collision positions',
  /Trees\.addTrees\s*\(\s*scene\s*\)/.test(terrainMesh) &&
  /return\s*\{\s*terrain\s*,\s*treePositions\s*,\s*rockPositions\s*\}/.test(terrainMesh));

check('contact shadows are derived from that same single build',
  /addContactShadows\s*\(\s*scene\s*,\s*treePositions/.test(terrainMesh));

console.log('\n==================================================');
console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
