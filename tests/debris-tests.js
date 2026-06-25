// @ts-check
// debris-tests.js — headless unit tests for the crash-shatter wipeout (issue #53).
//
// SnowmanDebris (src/debris.ts) imports only three (bare) and self-guards on
// requestAnimationFrame, so it constructs + runs headless under Node like
// avalanche-tests.js. We drive update(dt) manually (no rAF in Node) against a REAL
// snowman built by createSnowman, so the shatterRoots / world-position / disposal
// paths are exercised on shipped geometry.
//
// Run via:  node tests/debris-tests.js
//
// Uses dynamic import() (like dom_smoke_test.js) rather than top-level `import` so the
// file parses as CommonJS for eslint while still loading the real .ts ES modules + real
// three at runtime (Node strips the erasable types natively).
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

const flatTerrain = () => 0;
function snowmanGeometries(group) {
  const set = new Set();
  group.traverse(o => { if (o.geometry) set.add(o.geometry); });
  return set;
}
function fragmentMeshes(scene, snowmanGroup) {
  return scene.children.filter(c => c !== snowmanGroup && c.isMesh);
}

async function main() {
  const THREE = await import('three');
  const { SnowmanDebris } = await import('../src/debris.ts');
  const { createSnowman } = await import('../src/snowman/model.ts');

  // ---- shatter() basics ----
  {
    const scene = new THREE.Scene();
    const snowman = createSnowman(scene);            // adds the group to the scene
    const debris = new SnowmanDebris();
    debris.setTerrainFunction(flatTerrain);
    const before = scene.children.length;
    debris.shatter(scene, snowman, { x: -5, z: -12 });
    check('shatter hides the snowman', snowman.visible === false);
    check('shatter marks the system active', debris.active === true);
    check('shatter spawns fragments into the scene', scene.children.length > before);

    // Ownership: every fragment uses debris-OWNED geometry, never the snowman's.
    const snowGeoms = snowmanGeometries(snowman);
    const frags = fragmentMeshes(scene, snowman);
    const ownsAll = frags.length > 0 && frags.every(f => !snowGeoms.has(f.geometry));
    check('fragments use debris-owned geometry (not the snowman\'s)', ownsAll);
  }

  // ---- update() converges; fragments rest on the slope, never sink through ----
  {
    const scene = new THREE.Scene();
    const snowman = createSnowman(scene);
    const debris = new SnowmanDebris();
    const FLOOR = 10;
    debris.setTerrainFunction(() => FLOOR);          // raised terrain: must not rest at y=0
    debris.shatter(scene, snowman, { x: 2, z: -10 });
    const frags = fragmentMeshes(scene, snowman);

    let stillSettling = true, steps = 0;
    let sankThrough = false;
    while (stillSettling && steps < 400) {            // up to ~6.7s of 60fps steps
      stillSettling = debris.update(1 / 60);
      for (const f of frags) { if (f.position.y < FLOOR - 0.05) sankThrough = true; }
      steps++;
    }
    check('update() converges (settles within the budget)', stillSettling === false);
    check('settled system reports inactive', debris.active === false);
    check('fragments never sink through the terrain', !sankThrough);
    const minY = Math.min(...frags.map(f => f.position.y));
    check('fragments rest on the raised slope (terrain fn respected, not y=0)', minY > FLOOR - 0.05 && minY < FLOOR + 5);
  }

  // ---- reset() disposes debris-owned assets, re-shows the snowman, leaves it intact ----
  {
    const scene = new THREE.Scene();
    const snowman = createSnowman(scene);
    const debris = new SnowmanDebris();
    debris.setTerrainFunction(flatTerrain);
    const baseline = scene.children.length;
    debris.shatter(scene, snowman, { x: 0, z: -8 });
    debris.reset();
    check('reset re-shows the snowman', snowman.visible === true);
    check('reset removes all fragments from the scene', scene.children.length === baseline);
    check('reset clears active', debris.active === false);
    // The snowman's own geometry/material must survive the shatter->reset cycle.
    const bottom = snowman.userData.parts.bottom;
    check('snowman geometry intact after reset (not disposed with debris)',
      !!bottom.geometry && !!bottom.geometry.attributes && !!bottom.geometry.attributes.position);
    // Re-usable: a second crash works after a reset (no stale state / leak).
    debris.shatter(scene, snowman, { x: 1, z: -9 });
    check('shatter is reusable after reset', debris.active === true && snowman.visible === false && scene.children.length > baseline);
    debris.reset();
  }

  // ---- reduced motion: still hides + puffs, but no flying tumble (fewer fragments) ----
  {
    const scene = new THREE.Scene();
    const snowman = createSnowman(scene);
    const full = new SnowmanDebris(); full.setTerrainFunction(flatTerrain);
    full.shatter(scene, snowman, { x: -6, z: -14 }, { reducedMotion: false });
    const fullCount = fragmentMeshes(scene, snowman).length;
    full.reset();

    const reduced = new SnowmanDebris(); reduced.setTerrainFunction(flatTerrain);
    reduced.shatter(scene, snowman, { x: -6, z: -14 }, { reducedMotion: true });
    const reducedCount = fragmentMeshes(scene, snowman).length;
    check('reduced-motion still hides the snowman + emits a small puff', snowman.visible === false && reducedCount > 0);
    check('reduced-motion emits fewer fragments than full', reducedCount < fullCount);
    reduced.reset();
  }

  console.log(`\nDEBRIS TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('debris test harness crashed:', err); process.exit(1); });
