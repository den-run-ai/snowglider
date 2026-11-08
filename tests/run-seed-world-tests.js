// @ts-check
/**
 * Seeded world build + ranked-seed seam (issue #400, PR 3).
 *
 * Covers the #400 tail on top of the RunContext streams:
 *  - withGameplayStream('hazards', …): the world-build bridge. Unseeded it is a
 *    pure no-op (the global Math.random the harnesses seed is consumed exactly
 *    as before); seeded it makes the REAL createTerrain — mesh noise/bumps,
 *    rocks, the single #397 forest — a deterministic function of the run seed.
 *  - parseRunSeedParam: the `?seed=` URL seam (NaN-safe).
 *  - The wiring contracts: setupScene applies the seed BEFORE the world build,
 *    lifecycle rewinds the streams every run start, course.ts stamps the ghost.
 *
 * (Local best-time stamping is covered in tests/scores-tests.js, which owns the
 * scores harness.)
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ PASS: ${name}`); }
  else { failed++; console.log(`❌ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function main() {
  console.log('\n🌍 SEEDED WORLD BUILD TESTS (#400 PR 3) 🌍');
  console.log('===========================================\n');

  // jsdom + canvas stub so the REAL createTerrain (snow textures, rock textures,
  // contact shadows) builds headlessly — same stub shape as dom_smoke_test.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://snowglider.ai/' });
  const g = /** @type {any} */ (globalThis);
  g.window = dom.window;
  g.document = dom.window.document;
  const origCreate = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = function (tag) {
    const el = origCreate(tag);
    if (tag === 'canvas') {
      el.getContext = () => ({
        fillStyle: '', font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData() {},
        createRadialGradient: () => ({ addColorStop() {} }),
        createLinearGradient: () => ({ addColorStop() {} }),
        fillRect() {}, fillText() {}, beginPath() {}, arc() {}, fill() {},
        clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {}
      });
    }
    return el;
  };

  const RC = await import('../src/run-context.ts');
  const realRandom = Math.random;

  // ---------- withGameplayStream mechanics ----------
  console.log('--- withGameplayStream (the world-build bridge) ---');
  {
    // Unseeded: a pure no-op — fn sees the exact global Math.random (the
    // seeded-harness contract), and nothing is swapped afterwards.
    RC.setRunSeed(null);
    const mock = () => 0.42;
    Math.random = mock;
    let seenInside = null;
    RC.withGameplayStream('hazards', () => { seenInside = Math.random; });
    check('unseeded: fn runs against the untouched global Math.random',
      seenInside === mock && Math.random === mock);
    Math.random = realRandom;

    // Seeded: draws inside come from the hazards stream; the global stays out of
    // the loop entirely (a throwing global proves it) and is restored after.
    RC.setRunSeed(1234);
    const thrower = () => { throw new Error('global drawn during seeded stream'); };
    Math.random = thrower;
    let threw = false, val = -1;
    try { val = RC.withGameplayStream('hazards', () => Math.random()); }
    catch { threw = true; }
    check('seeded: draws come from the hazards stream, never the global',
      !threw && val >= 0 && val < 1);
    check('seeded: the global is restored after the call', Math.random === thrower);

    // Restore-on-throw: a placement pass that throws must not leak the swap.
    let restored = false;
    try {
      RC.withGameplayStream('hazards', () => { throw new Error('boom'); });
    } catch {
      restored = Math.random === thrower;
    }
    check('a throwing fn still restores the global (finally)', restored);
    Math.random = realRandom;
    RC.setRunSeed(null);
  }

  // ---------- parseRunSeedParam ----------
  console.log('\n--- parseRunSeedParam (?seed= URL seam) ---');
  check('?seed=123 parses', RC.parseRunSeedParam('?seed=123') === 123);
  check('?seed=12.7 normalizes to the integer floor', RC.parseRunSeedParam('?seed=12.7') === 12);
  check('absent seed => null', RC.parseRunSeedParam('?test=1') === null);
  check('empty seed => null', RC.parseRunSeedParam('?seed=') === null);
  check('non-numeric seed => null (NaN-safe)', RC.parseRunSeedParam('?seed=abc') === null);
  check('empty search => null', RC.parseRunSeedParam('') === null);

  // ---------- seeded world determinism through the REAL createTerrain ----------
  console.log('\n--- seeded world build: same seed => same obstacle field ---');
  const THREE = await import('three');
  const { Trees } = await import('../src/mountains/trees.ts');
  const { createTerrain } = await import('../src/mountains/terrain-mesh.ts');
  Trees.setEzForestEnabled(false); // synchronous stylized build; no async EZ chunk in a unit test

  const quiet = (fn) => {
    const _log = console.log, _warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try { return fn(); } finally { console.log = _log; console.warn = _warn; }
  };
  const build = () => quiet(() => createTerrain(new THREE.Scene()));
  const posKey = (arr) => JSON.stringify(arr.map(p => [p.x, p.y, p.z]));

  // Warm-up build: the FIRST createTerrain of a process lazily constructs the
  // one-time material/texture/geometry pools, and those constructions consume
  // stream draws that later builds skip. In the live game there is exactly ONE
  // world build per page load (a tier switch reloads the page), so "same seed
  // => same world" is a cross-page-load contract — which a fresh process's first
  // build honors deterministically. The warm-up puts the comparison builds on
  // the same (pools-ready) footing a repeated same-process build would have.
  quiet(() => { RC.setRunSeed(null); createTerrain(new THREE.Scene()); });

  {
    RC.setRunSeed(4242);
    const a = build();
    // Junk draws between builds: global, cosmetic, and OTHER gameplay streams —
    // none of them may perturb the hazards lane.
    for (let i = 0; i < 17; i++) { Math.random(); RC.cosmeticRandom('snowParticles'); }
    RC.gameplayRandom('physics'); RC.gameplayRandom('avalanche');
    RC.setRunSeed(4242);
    const b = build();
    check('same seed rebuilds the SAME forest (collision positions identical)',
      posKey(a.treePositions) === posKey(b.treePositions),
      `${a.treePositions.length} vs ${b.treePositions.length} trees`);
    check('same seed rebuilds the SAME rock field',
      posKey(a.rockPositions) === posKey(b.rockPositions),
      `${a.rockPositions.length} vs ${b.rockPositions.length} rocks`);

    RC.setRunSeed(999);
    const c = build();
    check('a different seed is a different world',
      posKey(a.treePositions) !== posKey(c.treePositions));
    RC.setRunSeed(null);
  }

  // Unseeded: the build consumes the GLOBAL stream exactly as before the bridge —
  // seeding global Math.random reproduces the layout (the harness contract).
  {
    Math.random = makeRng(0xBEEF);
    const a = build();
    Math.random = makeRng(0xBEEF);
    const b = build();
    Math.random = realRandom;
    check('unseeded: a seeded GLOBAL Math.random still pins the layout (harness contract)',
      posKey(a.treePositions) === posKey(b.treePositions) &&
      posKey(a.rockPositions) === posKey(b.rockPositions));
  }

  // ---------- canonical world / practice / run nonce (#403 review) ----------
  console.log('\n--- canonical world, practice flag, run-stream nonce ---');
  {
    // Canonical world: concrete seed, NOT practice; gameplay streams private.
    RC.setWorldContext(RC.CANONICAL_WORLD_SEED, false);
    check('canonical world is not a practice run', RC.isPracticeRun() === false);
    Math.random = () => { throw new Error('canonical-world gameplay draw touched global'); };
    let threw = false;
    try { RC.gameplayRandom('physics'); RC.gameplayRandom('hazards'); } catch { threw = true; }
    Math.random = realRandom;
    check('canonical-world gameplay streams are PRIVATE (never global Math.random)', !threw);

    // ?seed= world: practice.
    RC.setWorldContext(1234, true);
    check('?seed= world is a practice run', RC.isPracticeRun() === true);
    check('the stamp carries the practice flag', RC.getRunStamp().practice === true);
    RC.rewindRunStreams(0xBEEF);
    check('the stamp carries the run nonce (full reproducibility — Codex PR #407 P1)',
      RC.getRunStamp().nonce === 0xBEEF);

    // Run-scoped streams: same world + same nonce => same physics sequence;
    // a different nonce varies physics/avalanche but NOT the world streams.
    RC.setWorldContext(RC.CANONICAL_WORLD_SEED, false);
    RC.rewindRunStreams(1111);
    const phys1 = [RC.gameplayRandom('physics'), RC.gameplayRandom('physics')];
    const haz1 = [RC.gameplayRandom('hazards'), RC.gameplayRandom('hazards')];
    RC.rewindRunStreams(1111);
    const phys1b = [RC.gameplayRandom('physics'), RC.gameplayRandom('physics')];
    RC.rewindRunStreams(2222);
    const phys2 = [RC.gameplayRandom('physics'), RC.gameplayRandom('physics')];
    const haz2 = [RC.gameplayRandom('hazards'), RC.gameplayRandom('hazards')];
    check('same world + same nonce replays the same physics sequence',
      JSON.stringify(phys1) === JSON.stringify(phys1b));
    check('a fresh nonce varies the run-scoped physics stream',
      JSON.stringify(phys1) !== JSON.stringify(phys2));
    // The lifecycle nonce draw must NOT touch global Math.random: cosmetic
    // subsystems (Sfx noise buffers) advance the global stream by
    // machine-dependent amounts, so a Math.random-sourced nonce would let sound
    // availability change gameplay streams (Codex review PR #407).
    {
      const realRandom = Math.random;
      Math.random = () => { throw new Error('drawRunNonce must not consume global Math.random'); };
      let nonceOk = true;
      let a = 0, b = 0;
      try { a = RC.drawRunNonce(); b = RC.drawRunNonce(); } catch { nonceOk = false; }
      Math.random = realRandom;
      check('drawRunNonce never consumes global Math.random (crypto-backed)',
        nonceOk && Number.isInteger(a) && a >= 0 && a <= 0xFFFFFFFF && Number.isInteger(b));
    }
    check('the WORLD streams (hazards) are pinned to the world seed across nonces',
      JSON.stringify(haz1) === JSON.stringify(haz2));
    RC.setRunSeed(null);
  }

  // ---------- wiring contracts ----------
  console.log('\n--- wiring contracts (source level) ---');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  check('setupScene selects a CONCRETE world before the build (canonical unless ?seed=)',
    /setWorldContext\(urlSeed \?\? CANONICAL_WORLD_SEED, urlSeed !== null\)/.test(read('src/game/scene-setup.ts')));
  // The nonce draw must be gated on a CONCRETE world seed: with runSeed null the
  // gameplay streams are Math.random passthroughs (the frozen-baseline and
  // seeded-harness mode), so an unconditional draw would consume a global value
  // every reset and shift the auto-turn/avalanche sequence (Codex review PR #407).
  check('lifecycle draws a fresh run nonce ONLY on a concrete non-practice world',
    /rewindRunStreams\(runStamp\.seed !== null && !isPracticeRun\(\)/.test(read('src/game/lifecycle.ts')));
  check('createTerrain wraps the world build in the hazards stream',
    /withGameplayStream\('hazards'/.test(read('src/mountains/terrain-mesh.ts')));
  check('course.ts stamps the committed ghost with the run provenance',
    /ghostMetaKey\(\), JSON\.stringify\(getRunStamp\(\)\)/.test(read('src/course.ts')));
  // A partial ghost commit (ghost wrote, stamp hit quota) must clear the stale
  // sidecar instead of leaving the OLD run's seed/nonce attached to the NEW
  // trajectory (Codex review PR #407).
  check('a failed ghost commit clears the stale stamp sidecar (never mis-stamped)',
    /removeItem\(ghostMetaKey\(\)\)/.test(read('src/course.ts')));

  console.log('\n===========================================');
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
