// @ts-check
// snowman-material-tests.js — headless coverage for the shared snowman/debris snow
// material (completion-plan PR-V4; the last #17 item).
//
// What this locks in:
//   1. SHARING — the three body spheres and every crash-debris fragment render with
//      ONE module-level MeshStandardMaterial (snowman/snow-material.ts), so teardown
//      stays single-dispose (the disposeGame sweep dedups) and broken snow matches
//      the snowman.
//   2. SURFACE CONTRACT — roughness matches the terrain snow (0.92) and vertexColors
//      is on (it carries the baked junction-crease tint).
//   3. JUNCTION CREASE — each sphere bakes a faint COOL (blue>red), slightly darker
//      ring at the latitudes where the balls meet, feathering back to plain white at
//      the equator — the snowman's version of the terrain cavity/AO term.
//   4. OWNERSHIP — debris.reset() disposes its owned geometry but NEVER the shared
//      material; resetSnowmanSnowMaterial() makes the next call rebuild fresh.
//   5. HEADLESS GUARD — with no 2d canvas (plain Node) the material builds without
//      textures and without throwing.
//
// CommonJS + dynamic import like the other suites (register-ts-resolve loader).
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { createSnowman } = await import('../src/snowman/model.ts');
  const { SnowmanDebris } = await import('../src/debris.ts');
  const { getSnowmanSnowMaterial, resetSnowmanSnowMaterial, SNOWMAN_SNOW_ROUGHNESS } =
    await import('../src/snowman/snow-material.ts');

  console.log('--- shared snow material: identity + surface contract ---');
  const scene = new THREE.Scene();
  const snowman = createSnowman(scene);
  const parts = snowman.userData.parts;
  {
    const mat = getSnowmanSnowMaterial();
    check('body spheres all share the module-level material instance',
      parts.bottom.material === mat && parts.middle.material === mat && parts.head.material === mat);
    check('a second snowman shares the SAME instance (module singleton)',
      (() => { const s2 = createSnowman(scene); const same = s2.userData.parts.bottom.material === mat; scene.remove(s2); return same; })());
    check(`roughness matches the terrain snow (${SNOWMAN_SNOW_ROUGHNESS})`,
      mat.roughness === SNOWMAN_SNOW_ROUGHNESS && SNOWMAN_SNOW_ROUGHNESS === 0.92);
    check('vertexColors on (carries the junction-crease tint)', mat.vertexColors === true);
    check('headless guard: no 2d canvas -> no textures, no throw',
      mat.map === null && mat.normalMap === null);
    check('accessories keep their own materials (only snow is shared)',
      parts.nose.material !== mat && parts.hatBase.material !== mat);
  }

  console.log('\n--- junction-crease vertex tint ---');
  {
    /** Vertex colour at the position index nearest a target latitude ny (y/r). */
    const colorAt = (mesh, radius, targetNy) => {
      const pos = mesh.geometry.attributes.position;
      const col = mesh.geometry.attributes.color;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < pos.count; i++) {
        const d = Math.abs(pos.getY(i) / radius - targetNy);
        if (d < bestD) { bestD = d; best = i; }
      }
      return { r: col.getX(best), g: col.getY(best), b: col.getZ(best) };
    };

    check('every body sphere has a baked color attribute',
      [parts.bottom, parts.middle, parts.head].every((m) => !!m.geometry.attributes.color));

    const bottomTop = colorAt(parts.bottom, 2, 1.0);     // pole inside the middle ball
    const bottomEq = colorAt(parts.bottom, 2, 0.0);      // visible equator
    check('bottom sphere: crease cap is darker than white', bottomTop.r < 1 && bottomTop.g < 1 && bottomTop.b < 1);
    check('bottom sphere: crease tint is cool (blue > red)', bottomTop.b > bottomTop.r);
    check('bottom sphere: equator stays plain white',
      bottomEq.r === 1 && bottomEq.g === 1 && bottomEq.b === 1);

    const middleLow = colorAt(parts.middle, 1.5, -1.0);  // sits in the bottom-ball crease
    check('middle sphere: lower crease tinted cool', middleLow.b > middleLow.r && middleLow.r < 1);
    const headLow = colorAt(parts.head, 1, -1.0);        // neck tangent point
    check('head sphere: neck crease tinted cool', headLow.b > headLow.r && headLow.r < 1);
    const headTop = colorAt(parts.head, 1, 0.3);         // open face area
    check('head sphere: face area stays plain white', headTop.r === 1 && headTop.b === 1);
  }

  console.log('\n--- debris shares the material; reset never disposes it ---');
  {
    const mat = getSnowmanSnowMaterial();
    let disposed = 0;
    const realDispose = mat.dispose.bind(mat);
    mat.dispose = () => { disposed++; realDispose(); };

    const debris = new SnowmanDebris();
    debris.setTerrainFunction(() => 0);
    for (let cycle = 0; cycle < 3; cycle++) {
      debris.shatter(scene, snowman, { x: 2, z: -10 });
      const frags = scene.children.filter((c) => c !== snowman && /** @type {any} */ (c).isMesh);
      check(`cycle ${cycle}: every fragment renders with the shared snow material`,
        frags.length > 0 && frags.every((f) => /** @type {any} */ (f).material === mat));
      check(`cycle ${cycle}: fragment geometries carry white vertex colours`,
        frags.every((f) => {
          const col = /** @type {any} */ (f).geometry.attributes.color;
          return !!col && col.getX(0) === 1 && col.getY(0) === 1 && col.getZ(0) === 1;
        }));
      let steps = 0;
      while (debris.update(1 / 60) && steps < 400) steps++;
      debris.reset();
    }
    check('reset() across 3 cycles never disposed the shared material', disposed === 0);
    check('snowman still renders with the live shared material after the cycles',
      parts.bottom.material === mat && snowman.visible === true);
    mat.dispose = realDispose;
  }

  console.log('\n--- reset hook (dispose-audit / remount) ---');
  {
    const before = getSnowmanSnowMaterial();
    resetSnowmanSnowMaterial();
    const after = getSnowmanSnowMaterial();
    check('resetSnowmanSnowMaterial() makes the next call rebuild a fresh instance',
      after !== before && after.roughness === SNOWMAN_SNOW_ROUGHNESS && after.vertexColors === true);
    resetSnowmanSnowMaterial();
  }

  console.log(`\nSNOWMAN MATERIAL TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('snowman-material harness crashed:', err); process.exit(1); });
