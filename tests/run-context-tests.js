// @ts-check
/**
 * RunContext named RNG streams (issue #400) — unit + behavioral isolation.
 *
 * Contract under test (src/run-context.ts):
 *  - GAMEPLAY streams unseeded are pure Math.random() passthroughs (exactly one
 *    global call per draw, same value) — the byte-identical-baseline and
 *    seeded-harness compatibility guarantee.
 *  - GAMEPLAY streams seeded are independent deterministic PRNGs derived from
 *    the run seed + stream name; the global stream is never touched.
 *  - COSMETIC streams NEVER touch global Math.random, seeded or not — so
 *    particle activity can never perturb gameplay RNG (the audit's P0).
 *  - Non-finite seeds mean "unseeded", never a poisoned stream (NaN bug class).
 *
 * Behavioral half (jsdom + real modules): the avalanche powder cloud and the
 * ski snow-spray consume ZERO global Math.random draws per frame, and their
 * emission is frame-rate independent (same budget per simulated second at
 * 30 Hz and 144 Hz).
 */
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ PASS: ${name}`); }
  else { failed++; console.log(`❌ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  console.log('\n🎲 RUN-CONTEXT RNG STREAM TESTS (#400) 🎲');
  console.log('==========================================\n');

  // jsdom globals BEFORE the game modules load (snow.ts/avalanche.ts touch
  // document for canvas textures; the 2d context is stubbed like dom_smoke_test).
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://snowglider.ai/' });
  const g = /** @type {any} */ (globalThis);
  g.window = dom.window;
  g.document = dom.window.document;
  const origCreate = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = function (tag) {
    const el = origCreate(tag);
    if (tag === 'canvas') {
      el.getContext = () => ({
        fillStyle: '', font: '', textAlign: '', textBaseline: '',
        createRadialGradient: () => ({ addColorStop() {} }),
        createLinearGradient: () => ({ addColorStop() {} }),
        fillRect() {}, fillText() {}, beginPath() {}, arc() {}, fill() {},
        clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {},
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {}
      });
    }
    return el;
  };

  const RC = await import('../src/run-context.ts');
  const realRandom = Math.random;

  // ---------- unit: passthrough equivalence (unseeded gameplay) ----------
  console.log('--- gameplay streams: unseeded passthrough ---');
  RC.setRunSeed(null);
  {
    const script = [0.11, 0.22, 0.33, 0.44];
    let i = 0, calls = 0;
    Math.random = () => { calls++; return script[i++ % script.length]; };
    const a = RC.gameplayRandom('physics');
    const b = RC.gameplayRandom('avalanche');
    Math.random = realRandom;
    check('unseeded draw = exactly one global Math.random call, same value',
      calls === 2 && a === 0.11 && b === 0.22, `calls=${calls} a=${a} b=${b}`);
  }

  // ---------- unit: seeded determinism + independence ----------
  console.log('\n--- gameplay streams: seeded determinism ---');
  {
    Math.random = () => { throw new Error('seeded gameplay draw touched global Math.random'); };
    let threw = false, seqA = [], seqB = [], replayA = [];
    try {
      RC.setRunSeed(1234);
      for (let k = 0; k < 5; k++) seqA.push(RC.gameplayRandom('physics'));
      for (let k = 0; k < 5; k++) seqB.push(RC.gameplayRandom('avalanche'));
      RC.setRunSeed(1234); // re-seed = replay from the top
      for (let k = 0; k < 5; k++) replayA.push(RC.gameplayRandom('physics'));
    } catch { threw = true; }
    Math.random = realRandom;
    check('seeded gameplay draws never touch global Math.random', !threw);
    check('same seed replays the same sequence',
      JSON.stringify(seqA) === JSON.stringify(replayA));
    check('sibling streams from one seed are decorrelated',
      JSON.stringify(seqA) !== JSON.stringify(seqB));
    check('all draws in [0,1)',
      [...seqA, ...seqB].every(v => v >= 0 && v < 1));
    const seq9 = [];
    RC.setRunSeed(9999);
    for (let k = 0; k < 5; k++) seq9.push(RC.gameplayRandom('physics'));
    check('different seeds give different sequences',
      JSON.stringify(seqA) !== JSON.stringify(seq9));
  }

  // ---------- unit: cosmetic isolation ----------
  console.log('\n--- cosmetic streams: never global ---');
  {
    Math.random = () => { throw new Error('cosmetic draw touched global Math.random'); };
    let threw = false;
    const seq = [];
    try {
      RC.setRunSeed(null); // even unseeded, cosmetics stay private
      for (let k = 0; k < 8; k++) seq.push(RC.cosmeticRandom('snowParticles'));
      RC.cosmeticRandom('avalanchePowder');
      RC.cosmeticRandom('cameraEffects');
    } catch { threw = true; }
    Math.random = realRandom;
    check('cosmetic draws never touch global Math.random (seeded or not)', !threw);
    check('cosmetic draws are valid [0,1) numbers', seq.every(v => v >= 0 && v < 1));
  }

  // ---------- unit: NaN-safe seeds ----------
  console.log('\n--- seed normalization (NaN bug class) ---');
  {
    RC.setRunSeed(NaN);
    check('setRunSeed(NaN) means unseeded, not poisoned', RC.getRunSeed() === null);
    RC.setRunSeed(Infinity);
    check('setRunSeed(Infinity) means unseeded', RC.getRunSeed() === null);
    RC.setRunSeed(42.9);
    check('fractional seeds normalize to a stable integer', RC.getRunSeed() === 42);
    RC.setRunSeed(null);
    check('setRunSeed(null) clears the seed', RC.getRunSeed() === null);
  }

  // ---------- behavioral: real modules draw zero global randoms ----------
  console.log('\n--- behavioral: cosmetic systems off the global stream ---');
  const THREE = await import('three');
  const { AvalancheSystem } = await import('../src/avalanche.ts');
  const { Snow } = await import('../src/snow.ts');

  // Avalanche: trigger() draws GAMEPLAY randoms (passthrough → global, exactly as
  // the seeded winnability harness pins), but the per-frame powder cloud must not
  // consume a single global draw.
  {
    RC.setRunSeed(null);
    RC.resetRunStreams();
    const av = new AvalancheSystem(new THREE.Scene(), 30);
    av.setTerrainFunction(() => 0);
    check('powder pool built under the stubbed DOM', av.powder.length > 0);
    av.trigger({ x: 0, y: 12, z: -50 }); // gameplay draws happen HERE (global ok)
    let globalDraws = 0;
    Math.random = () => { globalDraws++; return realRandom(); };
    for (let i = 0; i < 30; i++) av.update(1 / 60);
    Math.random = realRandom;
    const live = av.powder.filter(p => p.userData.active).length;
    check('a live slide emits powder puffs', live > 0, `live=${live}`);
    check('30 update frames consume ZERO global Math.random draws',
      globalDraws === 0, `globalDraws=${globalDraws}`);
    av.dispose();
  }

  // Ski snow-spray: a grounded, moving update must emit particles while drawing
  // zero global randoms.
  {
    const scene = new THREE.Scene();
    const splash = Snow.createSnowSplash();
    const snowman = new THREE.Object3D();
    snowman.position.set(0, 0, 0);
    let globalDraws = 0;
    Math.random = () => { globalDraws++; return realRandom(); };
    for (let i = 0; i < 30; i++) {
      Snow.updateSnowSplash(splash, 1 / 60, snowman, { x: 0, z: -8 }, false, scene);
    }
    Math.random = realRandom;
    const active = splash.particles.filter(p => p.userData.active).length;
    check('grounded moving spray emits particles', active > 0, `active=${active}`);
    check('30 spray frames consume ZERO global Math.random draws',
      globalDraws === 0, `globalDraws=${globalDraws}`);
  }

  // ---------- behavioral: frame-rate-independent emission ----------
  console.log('\n--- behavioral: emission is frame-rate independent ---');

  // Avalanche powder: fresh system + reset cosmetic streams per rate, so both
  // rates see the SAME tick count and the SAME cosmetic sequence over the same
  // simulated time — activation counts must match to within one tick's puffs.
  {
    // Step by an exact FRAME COUNT (never `t += dt` — float accumulation slips an
    // extra frame in at some rates and skews the comparison).
    const countPuffs = (dt, seconds) => {
      RC.resetRunStreams();
      const av = new AvalancheSystem(new THREE.Scene(), 30);
      av.setTerrainFunction(() => 0);
      Math.random = () => 0.5; // pin the gameplay boulder draws identically
      av.trigger({ x: 0, y: 12, z: -50 });
      Math.random = realRandom;
      const seen = new Set();
      const frames = Math.round(seconds / dt);
      for (let f = 0; f < frames; f++) {
        av.update(dt);
        av.powder.forEach((p, i) => { if (p.userData.active) seen.add(i); });
      }
      av.dispose();
      return seen.size;
    };
    const at30 = countPuffs(1 / 30, 0.5);
    const at144 = countPuffs(1 / 144, 0.5);
    check('puff budget per simulated second matches at 30 Hz and 144 Hz (±7)',
      Math.abs(at30 - at144) <= 7, `30Hz=${at30} 144Hz=${at144}`);
    check('the old per-render-frame behavior (~4.8x more puffs at 144 Hz) is gone',
      at144 < at30 * 2, `30Hz=${at30} 144Hz=${at144}`);
  }

  // Ski spray: same double-run comparison. The accumulator is module-level, so
  // drain it to a known state via an airborne frame (which resets it) first.
  {
    const countSpray = (dt, seconds) => {
      RC.resetRunStreams();
      const scene = new THREE.Scene();
      const splash = Snow.createSnowSplash();
      const snowman = new THREE.Object3D();
      Snow.updateSnowSplash(splash, dt, snowman, { x: 0, z: -8 }, true, scene); // airborne: accum -> 0
      const seen = new Set();
      const frames = Math.round(seconds / dt);
      for (let f = 0; f < frames; f++) {
        Snow.updateSnowSplash(splash, dt, snowman, { x: 0, z: -8 }, false, scene);
        splash.particles.forEach((p, i) => { if (p.userData.active) seen.add(i); });
      }
      return seen.size;
    };
    const at30 = countSpray(1 / 30, 0.5);
    const at144 = countSpray(1 / 144, 0.5);
    check('spray budget per simulated second matches at 30 Hz and 144 Hz (±5)',
      Math.abs(at30 - at144) <= 5, `30Hz=${at30} 144Hz=${at144}`);
  }

  // ---------- source contract: no direct global draws in cosmetic layers ----------
  console.log('\n--- source contract: cosmetic layers never CALL Math.random ---');
  {
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const rel of ['src/snow.ts', 'src/effects.ts', 'src/avalanche.ts']) {
      check(`${rel} never calls Math.random directly (streams only)`,
        !/Math\.random\(/.test(read(rel)));
    }
    check('src/run-context.ts is the single passthrough site',
      /Math\.random\(\)/.test(read('src/run-context.ts')));
  }

  console.log('\n==========================================');
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
