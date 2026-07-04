// @ts-check
// snow-depth-tests.js — headless coverage for the persistent snow-depth field
// (src/mountains/snow-depth.ts, issue #246, visual-only v1 · PRs 1–3 of the stack).
//
// The field logic is fully Node-testable — exactly what #246 asks the field PR to pin:
//   * construction is full powder (depth 1) everywhere
//   * compaction lowers depth near the pass, tapering to the rim, clamped >= 0
//   * refill raises packed cells back toward full, clamped <= 1
//   * values stay bounded in [0..1] under an adversarial input sequence
//   * the field is deterministic for a fixed input sequence
//   * it consumes ZERO global Math.random (the DataTexture UUID draw is privately guarded)
//   * update() is driven off the grounded+moving trigger and never mutates the player (PR 2)
//   * the DataTexture byte mirror stays in sync via flush(); applySnowDepthModulation wires
//     the terrain material's onBeforeCompile without removing its chunks (PR 3)
//   * reset() restores full powder; dispose() frees the texture idempotently
//
// The live shader COMPILE + per-frame perf are verified separately by the e2e checks
// (tests/e2e/perf-budget.spec.ts / boot smoke), per #246 — node tests cover the logic.
//
// Run via the ts-resolve loader (the auto-runner supplies it):
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/snow-depth-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const { SnowDepthField, applySnowDepthModulation } = await import('../src/mountains/snow-depth.ts');

  testConstruction(SnowDepthField);
  testStreamNeutrality(SnowDepthField);
  testCompaction(SnowDepthField);
  testCompactionFalloffAndLocality(SnowDepthField);
  testCompactParams(SnowDepthField);
  testRefill(SnowDepthField);
  testBounds(SnowDepthField);
  testNonFiniteHardening(SnowDepthField);
  testDeterminism(SnowDepthField);
  testUpdateGating(SnowDepthField);
  testTextureAndFlush(SnowDepthField);
  testShaderModulation(SnowDepthField, applySnowDepthModulation);
  testResetAndDispose(SnowDepthField);

  console.log(`\nSNOW-DEPTH TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function testConstruction(SnowDepthField) {
  console.log('construction — full powder');
  const f = new SnowDepthField();
  check('sample() returns 1 (full powder) at the origin', Math.abs(f.sample(0, 0) - 1) < 1e-9);
  check('depthAt() aliases sample()', f.depthAt(0, 0) === f.sample(0, 0));
  check('every cell starts at full powder', f.depth.every(v => v === 1));
  check('grid resolution is capped/positive', f.cols >= 2 && f.rows >= 2 && f.cols <= 400 && f.rows <= 520);
  check('grid length == cols * rows', f.depth.length === f.cols * f.rows);
  check('sample() is clamped for out-of-bounds coordinates',
    f.sample(1e6, 1e6) === 1 && f.sample(-1e6, -1e6) === 1);
}

function testStreamNeutrality(SnowDepthField) {
  console.log('Math.random neutrality — pure logic draws nothing');
  const saved = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return saved(); };
  try {
    const f = new SnowDepthField();
    f.compactAt(0, 0);
    f.refill(1);
    f.reset();
  } finally {
    Math.random = saved;
  }
  check('constructing + driving the field consumes ZERO global Math.random draws', calls === 0);
}

function testCompaction(SnowDepthField) {
  console.log('compaction — a ski pass packs the snow');
  const f = new SnowDepthField();
  const before = f.sample(0, 0);
  f.compactAt(0, 0);
  const after = f.sample(0, 0);
  check('depth at the pass centre drops', after < before);
  check('depth never drops below 0', f.depth.every(v => v >= 0));
  for (let i = 0; i < 20; i++) f.compactAt(0, 0);
  check('repeated passes clamp at 0 (fully packed)', f.sample(0, 0) === 0);
}

function testCompactionFalloffAndLocality(SnowDepthField) {
  console.log('compaction — tapering falloff + bounded footprint');
  const f = new SnowDepthField({ packRadius: 6 });
  f.compactAt(0, 0);
  const atCenter = 1 - f.sample(0, 0);   // depth removed at the centre
  const atRim = 1 - f.sample(5, 0);      // depth removed near the rim (within radius)
  check('the centre is packed more than the rim', atCenter > atRim && atRim >= 0);
  check('cells well outside packRadius are untouched (still powder)', f.sample(60, 60) === 1);
}

function testCompactParams(SnowDepthField) {
  console.log('compaction — explicit radius / strength overrides');
  const f = new SnowDepthField();
  // A zero strength or zero radius is a no-op.
  f.compactAt(0, 0, 5, 0);
  check('zero strength leaves the snow untouched', f.sample(0, 0) === 1);
  f.compactAt(0, 0, 0, 0.9);
  check('zero radius leaves the snow untouched', f.sample(0, 0) === 1);
  // A stronger pass packs more than a gentler one.
  const a = new SnowDepthField();
  const b = new SnowDepthField();
  a.compactAt(0, 0, 4, 0.2);
  b.compactAt(0, 0, 4, 0.8);
  check('a stronger pass removes more depth than a gentle one', b.sample(0, 0) < a.sample(0, 0));
}

function testRefill(SnowDepthField) {
  console.log('refill — fresh snow covers a packed line back over');
  const f = new SnowDepthField({ refillRate: 0.5, compactionPerPass: 1 });
  f.compactAt(0, 0);
  const packed = f.sample(0, 0);
  check('cell is packed before refill', packed < 1);
  f.refill(1); // 1 s * 0.5/s
  check('refill raises depth back toward full', f.sample(0, 0) > packed);
  for (let i = 0; i < 100; i++) f.refill(1);
  check('refill clamps at 1 (never overshoots powder)', f.sample(0, 0) === 1);
  // Undisturbed cells are never pushed past full.
  check('undisturbed cells stay exactly at 1 through refill', f.depth.every(v => v <= 1));
}

function testBounds(SnowDepthField) {
  console.log('bounds — [0..1] under an adversarial sequence');
  const f = new SnowDepthField();
  for (let i = 0; i < 50; i++) {
    f.compactAt((i % 7) - 3, (i % 5) - 2);
    f.refill(0.3);
  }
  check('all cells stay within [0..1]', f.depth.every(v => v >= 0 && v <= 1 && Number.isFinite(v)));
  // Degenerate dt / coordinates must not corrupt the field.
  f.refill(NaN);
  f.refill(-5);
  f.compactAt(NaN, NaN);
  check('NaN/negative inputs leave the field bounded',
    f.depth.every(v => v >= 0 && v <= 1 && Number.isFinite(v)));
}

function testNonFiniteHardening(SnowDepthField) {
  console.log('non-finite hardening — NaN options / strength never poison the grid (Codex #349)');
  // NaN construction options fall back to defaults / clamp, never store NaN.
  const f = new SnowDepthField({ refillRate: NaN, compactionPerPass: NaN, packRadius: NaN });
  check('NaN construction options resolve to finite tunables',
    Number.isFinite(f.refillRate) && Number.isFinite(f.compactionPerPass) && Number.isFinite(f.packRadius));
  check('a NaN-option field still starts full powder', f.depth.every(v => v === 1));
  // A NaN strength / radius passed explicitly must not write NaN into depth.
  const g = new SnowDepthField();
  g.compactAt(0, 0, 4, NaN);
  g.compactAt(0, 0, NaN, 0.5);
  g.compactAt(NaN, 0, 4, 0.5);
  check('NaN strength / radius / centre leave the grid finite and bounded',
    g.depth.every(v => v >= 0 && v <= 1 && Number.isFinite(v)));
  check('NaN compaction args are a no-op (still full powder)', g.sample(0, 0) === 1);
}

function testDeterminism(SnowDepthField) {
  console.log('determinism — identical inputs produce identical grids');
  const drive = (f) => {
    for (let i = 0; i < 30; i++) {
      f.compactAt(Math.sin(i) * 4, Math.cos(i) * 6);
      f.refill(0.2);
    }
  };
  const a = new SnowDepthField();
  const b = new SnowDepthField();
  drive(a); drive(b);
  let identical = a.depth.length === b.depth.length;
  for (let i = 0; identical && i < a.depth.length; i++) {
    if (a.depth[i] !== b.depth[i]) identical = false;
  }
  check('two fields driven with the same sequence are byte-identical', identical);
}

function testUpdateGating(SnowDepthField) {
  console.log('update — driven off the grounded + moving trigger; physics-neutral (PR 2)');
  // Airborne: no compaction (but refill still runs).
  const air = new SnowDepthField();
  air.update(0.1, { x: 0, y: 5, z: 0 }, true, 20);
  check('airborne frames leave no track', air.sample(0, 0) === 1);

  // Grounded but essentially stopped: no compaction.
  const stopped = new SnowDepthField();
  stopped.update(0.1, { x: 0, y: 0, z: 0 }, false, 0.2);
  check('a stopped snowman leaves no track', stopped.sample(0, 0) === 1);

  // Grounded + moving: a packed track appears.
  const skiing = new SnowDepthField();
  skiing.update(0.1, { x: 0, y: 0, z: 0 }, false, 20);
  check('a grounded, moving snowman packs a track', skiing.sample(0, 0) < 1);

  // update() must never mutate the player position object (physics-neutral).
  const player = { x: 3, y: 1, z: -4 };
  skiing.update(0.1, player, false, 20);
  check('update() does not mutate the player position', player.x === 3 && player.y === 1 && player.z === -4);

  // NaN player / speed must not corrupt the field.
  const robust = new SnowDepthField();
  robust.update(0.1, { x: NaN, y: 0, z: 0 }, false, 20);
  robust.update(0.1, { x: 0, y: 0, z: 0 }, false, NaN);
  check('NaN player / speed leave the field bounded and untracked',
    robust.depth.every(v => v >= 0 && v <= 1 && Number.isFinite(v)) && robust.sample(0, 0) === 1);

  // Frame-rate INDEPENDENCE + CONTINUITY (Codex #350): stamps are spaced by travelled
  // DISTANCE, so a straight run packs the same continuous line whether it's one big frame
  // or many small ones. Isolate compaction with refillRate 0 so the check is exact.
  const coarse = new SnowDepthField({ refillRate: 0 });
  const fine = new SnowDepthField({ refillRate: 0 });
  // Same path (-10,0) -> (10,0): coarse in one 20-unit frame, fine in forty 0.5-unit steps.
  coarse.update(0.1, { x: -10, y: 0, z: 0 }, false, 20);
  coarse.update(0.1, { x: 10, y: 0, z: 0 }, false, 20);
  fine.update(0.01, { x: -10, y: 0, z: 0 }, false, 20);
  for (let i = 1; i <= 40; i++) fine.update(0.01, { x: -10 + i * 0.5, y: 0, z: 0 }, false, 20);
  let continuous = true, matched = true;
  for (let x = -9; x <= 9; x += 0.5) {
    const c = coarse.sample(x, 0), f = fine.sample(x, 0);
    if (c >= 1 || f >= 1) continuous = false;          // an unpacked point on the line == a gap
    if (Math.abs(c - f) > 1e-6) matched = false;
  }
  check('the packed line is continuous along the path — no dots/gaps', continuous);
  check('one big frame and many small frames pack an identical line (frame-rate independent)', matched);

  // A jump must NOT draw a packed line across the airborne gap (the anchor drops when the
  // skis leave the snow, so takeoff and landing tracks are separate).
  const jump = new SnowDepthField({ refillRate: 0 });
  jump.update(0.016, { x: -5, y: 0, z: 0 }, false, 20); // anchor
  jump.update(0.016, { x: -4, y: 0, z: 0 }, false, 20); // ground: stamps -5 -> -4
  jump.update(0.016, { x: 0, y: 5, z: 0 }, true, 20);   // airborne over the middle (no stamp)
  jump.update(0.016, { x: 5, y: 0, z: 0 }, false, 20);  // land far: re-anchor, no cross-gap line
  jump.update(0.016, { x: 6, y: 0, z: 0 }, false, 20);  // ground: stamps 5 -> 6
  check('a jump leaves the airborne gap unpacked (no line across it)',
    jump.sample(0, 0) === 1 && jump.sample(-4.5, 0) < 1 && jump.sample(5.5, 0) < 1);
}

function testTextureAndFlush(SnowDepthField) {
  console.log('texture + flush (PR 3) — GPU mirror stays in sync');
  const f = new SnowDepthField();
  check('owns a DataTexture matching the grid dimensions',
    !!f.texture && f.texture.image.width === f.cols && f.texture.image.height === f.rows);
  check('texture starts as a full-powder byte mirror (all 255)',
    f.texture.image.data.every(v => v === 255));
  // A packing pass + flush must lower the corresponding texel bytes.
  f.compactAt(0, 0);
  f.flush();
  check('flush lowers the packed texel bytes below 255',
    Array.from(f.texture.image.data).some(v => v < 255));
  // A clean flush is a cheap no-op — three bumps texture.version on each needsUpdate=true,
  // so a no-op flush must NOT bump it (needsUpdate itself is a write-only setter).
  const versionAfterFlush = f.texture.version;
  f.flush();
  check('a clean flush does not re-upload the texture (version unchanged)',
    f.texture.version === versionAfterFlush);
  // A packing pass re-uploads after the next flush (version bumps).
  f.compactAt(10, 10);
  f.flush();
  check('a change re-uploads the texture (version bumps)', f.texture.version > versionAfterFlush);
}

function testShaderModulation(SnowDepthField, applySnowDepthModulation) {
  console.log('applySnowDepthModulation (PR 3) — onBeforeCompile injection');
  const f = new SnowDepthField();
  // A minimal material stand-in — the function only assigns onBeforeCompile + cache key.
  const material = {};
  applySnowDepthModulation(material, f);
  check('assigns a stable customProgramCacheKey', typeof material.customProgramCacheKey === 'function'
    && material.customProgramCacheKey() === 'terrain-snow-depth-v1');
  check('assigns an onBeforeCompile hook', typeof material.onBeforeCompile === 'function');

  // Drive the hook with a stub shader carrying the chunks it edits.
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main(){\n#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main(){\n#include <map_fragment>\n#include <roughnessmap_fragment>\n}',
  };
  material.onBeforeCompile(shader);
  check('binds the depth texture + field-extent uniforms',
    shader.uniforms.uSnowDepthTex && shader.uniforms.uSnowDepthTex.value === f.texture
    && !!shader.uniforms.uSnowFieldMin && !!shader.uniforms.uSnowFieldSize);
  check('injects the depth-uv varying into the vertex shader',
    shader.vertexShader.includes('vSnowDepthUv') && shader.vertexShader.includes('uSnowFieldMin'));
  check('modulates diffuse + roughness in the fragment shader',
    shader.fragmentShader.includes('uSnowDepthTex')
    && shader.fragmentShader.includes('diffuseColor.rgb')
    && shader.fragmentShader.includes('roughnessFactor'));
  check('leaves the original chunk includes in place (edits append, not remove)',
    shader.fragmentShader.includes('#include <map_fragment>')
    && shader.vertexShader.includes('#include <begin_vertex>'));
}

function testResetAndDispose(SnowDepthField) {
  console.log('reset + dispose');
  const f = new SnowDepthField();
  for (let i = 0; i < 10; i++) f.compactAt(0, 0);
  f.flush();
  check('field is packed before reset', f.sample(0, 0) < 1);
  f.reset();
  check('reset restores full powder everywhere', f.depth.every(v => v === 1));
  check('reset restores the texture byte mirror to full powder', f.texture.image.data.every(v => v === 255));
  let threw = false;
  try { f.dispose(); f.dispose(); } catch { threw = true; }
  check('dispose is idempotent (second call does not throw)', !threw);
}

main().catch(err => { console.error(err); process.exit(1); });
