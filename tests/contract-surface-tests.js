// contract-surface-tests.js
// Refactor-invariant guard for the public/test contract surface that the R2/R3
// split (issue #34; see the Refactoring Roadmap in docs/ROADMAP.md) must keep
// intact while it moves code between files.
//
// WHY THIS IS A SOURCE-CONTRACT TEST, NOT A BOOT TEST:
//   `snowglider.ts` constructs a real `THREE.WebGLRenderer` at module top level, so
//   it cannot be imported headless under jsdom — the puppeteer/unified browser suite
//   owns the *runtime* verification (it boots the real game and drives it by these
//   global names). This guard is the fast, pre-browser complement: it scans the whole
//   `src/` tree (NOT a single file) and fails the instant a contract name is dropped,
//   a proxy's get/set polarity flips, or the finish-reason string is re-worded. Because
//   it scans the tree rather than `snowglider.ts`, it keeps passing as lines move into
//   `src/game/*`, `src/ui/*`, and `src/snowman/*` — and only breaks on a real contract
//   regression. It deliberately asserts the documented surface ⊆ the code (drops fail;
//   additions are allowed and logged, since the proposal says re-grep before each PR).
//
//   The one runtime assertion is the `./snowman.js` import seam (R3's #1 risk): the
//   facade must keep resolving the `Snowman` object for main.ts / snowglider.ts /
//   player-state.ts / tests. snowman.ts touches no WebGL at import time, so that one is safe
//   to load. Run via the `test:contract` npm script (needs the .js->.ts resolve hook).
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');

// ---- read the whole src/ tree once (recursively), location-independent ----
function readSrcTree(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, readSrcTree(full));
    else if (entry.name.endsWith('.ts')) out[path.relative(SRC_DIR, full)] = fs.readFileSync(full, 'utf8');
  }
  return out;
}
const srcFiles = readSrcTree(SRC_DIR);
const allSrc = Object.values(srcFiles).join('\n');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++; else fail++;
}

// Extract the brace-balanced block beginning at the first `{` at/after `fromIdx`.
// The descriptor literals here contain no string/comment braces, so a naive depth
// counter is exact for this block; if that ever changes the polarity checks below
// would flip a name and fail loudly rather than silently pass.
function balancedBlock(src, fromIdx) {
  const start = src.indexOf('{', fromIdx);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

// === Section A — eager window.* hooks (assigned by bare `window.X = …`) ===
// These are read AND reassigned by controls.ts and the browser suites. Each must be
// assigned somewhere in src/ (any file — they move to game/* and ui/* in the split).
console.log('--- A. eager window.* hooks ---');
const EAGER_HOOKS = [
  'resetSnowman', 'restartGame', 'showGameOver', 'toggleCameraView', 'initializeGameWithAudio',
  'terrainMesh', 'treePositions', 'rockPositions', 'isTestMode', 'testHooks', 'testCollisionDetected',
];
for (const name of EAGER_HOOKS) {
  // `window.NAME =` but not `==`/`===`, and not a member assignment like `window.testHooks.x =`.
  const assigned = new RegExp(`window\\.${name}\\s*=(?!=)`).test(allSrc);
  check(`window.${name} is published (assigned) somewhere in src/`, assigned);
}

// === Section B — publishGameGlobals() proxy set: completeness + get/set polarity ===
// The proposal flags this as the easy-to-break contract: the browser suites reassign
// the scalars by bare name (`gameActive = true`), so a read/write proxy that loses its
// setter, or a dropped name, silently breaks the deployed tests. publishGameGlobals()
// must stay in the coordinator (it bridges bindings the extracted modules own), so we
// require exactly one definition and verify every documented name + its polarity.
console.log('--- B. publishGameGlobals() proxy set ---');
const PROXY_READWRITE = [
  'gameActive', 'isInAir', 'verticalVelocity', 'jumpCooldown',
  'bestTime', 'startTime', 'avalancheTriggered', 'lastAvalancheZ',
];
const PROXY_GETONLY = [
  'scene', 'camera', 'cameraManager', 'snowman', 'velocity', 'pos', 'avalanche',
  'snowSplash', 'terrain', 'getTerrainHeight', 'getControls', 'updateCamera', 'updateSnowman',
];

const proxyFiles = Object.entries(srcFiles).filter(([, c]) => c.includes('function publishGameGlobals'));
check('publishGameGlobals() defined exactly once (stays in the coordinator)', proxyFiles.length === 1);

if (proxyFiles.length === 1) {
  const src = proxyFiles[0][1];
  const liveBlock = balancedBlock(src, src.indexOf('const live'));
  check('publishGameGlobals() exposes a `const live` descriptor map', !!liveBlock);

  if (liveBlock) {
    // Per-name descriptor polarity: read/write entries carry a `set:`, get-only do not.
    function descriptorOf(name) {
      const m = new RegExp(`\\b${name}\\s*:\\s*\\{`).exec(liveBlock);
      return m ? balancedBlock(liveBlock, m.index) : null;
    }
    for (const name of PROXY_READWRITE) {
      const d = descriptorOf(name);
      check(`proxy ${name} present and read/WRITE (has setter — test reassignments flow back)`,
        !!d && /\bset\s*:/.test(d));
    }
    for (const name of PROXY_GETONLY) {
      const d = descriptorOf(name);
      check(`proxy ${name} present and get-only (no setter)`,
        !!d && !/\bset\s*:/.test(d));
    }
    // Surface the publish mechanism (defineProperty over every key) is still wired.
    check('every live descriptor is published via Object.defineProperty(window, …)',
      /Object\.defineProperty\(\s*window\s*,/.test(src) && /Object\.keys\(\s*live\s*\)/.test(src));

    // Info-only: flag globals added since this list was written (the doc says re-grep
    // before each PR). Extras don't fail — they just may want their own coverage.
    const documented = new Set([...PROXY_READWRITE, ...PROXY_GETONLY]);
    const actual = [...liveBlock.matchAll(/^\s*([A-Za-z_]\w*)\s*:\s*\{/gm)].map(m => m[1]);
    const extras = actual.filter(n => !documented.has(n));
    if (extras.length) console.log(`  INFO: undocumented proxied globals (add coverage?): ${extras.join(', ')}`);
  }
}

// === Section C — finish-reason string (do not re-word/re-case/re-derive) ===
// snowman produces it; snowglider keys three branches off it. The split moves the
// producer to snowman/collision.ts and the consumers to ui/result-overlay.ts, so the
// literal must survive byte-identical across at least two files.
console.log('--- C. finish-reason string ---');
const FINISH = 'You reached the end of the slope!';
const producer = (allSrc.match(new RegExp(`reason\\s*=\\s*"${FINISH}"`, 'g')) || []).length;
const consumer = (allSrc.match(new RegExp(`reason\\s*===\\s*"${FINISH}"`, 'g')) || []).length;
const filesWithLiteral = Object.values(srcFiles).filter(c => c.includes(FINISH)).length;
check('finish reason is produced (assigned) at least once', producer >= 1);
check('finish reason is compared in >= 3 branches', consumer >= 3);
check('finish reason literal spans >= 2 files (producer + consumer survive the split)', filesWithLiteral >= 2);

// === Section E — player-state.ts -> snowman.js types seam (source-level) ===
// player-state.ts imports the snowman *types* via the `./snowman.js` specifier; the facade
// must keep that specifier resolving after the snowman/ split.
console.log('--- E. player-state.ts -> ./snowman.js import seam ---');
check('player-state.ts imports from "./snowman.js"',
  /from\s*['"]\.\/snowman\.js['"]/.test(srcFiles['player-state.ts'] || ''));

// === Section D — Snowman runtime import seam (the one boot-safe runtime check) ===
// Proves `./snowman.js` resolves to the Snowman object with its 4 public methods — the
// specifier main.ts / snowglider.ts / player-state.ts / browser-tests.js all use. Under the
// .js->.ts resolve hook this loads snowman.ts today and the facade after R3's step 7.
async function main() {
  console.log('--- D. ./snowman.js runtime import seam ---');
  let Snowman;
  try {
    ({ Snowman } = await import('../src/snowman.js'));
    check('`./snowman.js` specifier resolves to a Snowman export', !!Snowman);
  } catch (e) {
    check(`\`./snowman.js\` specifier resolves (import threw: ${e.message})`, false);
  }
  if (Snowman) {
    for (const m of ['createSnowman', 'resetSnowman', 'updateSnowman', 'addTestHooks']) {
      check(`Snowman.${m} is a function`, typeof Snowman[m] === 'function');
    }
  }

  // === Section F — Mountains runtime import seam (the mountains/ facade split) ===
  // Like snowman, mountains.ts became a thin facade (export * from './mountains/index.js')
  // over src/mountains/*. The pre-split module exposed the `Mountains` object PLUS the
  // named exports terrainRidgeField / forestDensityField / rockCollisionRadius and the
  // TerrainVec2 / RockPosition types; camera/snow/trees/scene-setup and the terrain tests
  // import the `./mountains.js` specifier. mountains.ts touches no WebGL at import time
  // (terrain math + DOM-guarded canvas helpers), so it is boot-safe to load here. This
  // would have caught a dropped named re-export (e.g. rockCollisionRadius).
  console.log('--- F. ./mountains.js runtime import seam ---');
  let mountainsMod;
  try {
    mountainsMod = await import('../src/mountains.js');
    check('`./mountains.js` specifier resolves to a Mountains export', !!mountainsMod.Mountains);
  } catch (e) {
    check(`\`./mountains.js\` specifier resolves (import threw: ${e.message})`, false);
  }
  if (mountainsMod) {
    // The named exports the pre-split mountains.ts published (the facade must keep them).
    for (const n of ['terrainRidgeField', 'forestDensityField', 'rockCollisionRadius']) {
      check(`./mountains.js named export ${n} is a function`, typeof mountainsMod[n] === 'function');
    }
    // The Mountains object surface other modules read by member access.
    const M = mountainsMod.Mountains || {};
    for (const m of ['getTerrainHeight', 'getTerrainGradient', 'getDownhillDirection',
      'terrainRidgeField', 'forestDensityField', 'createTerrain', 'createRock', 'addRocks',
      'rockCollisionRadius', 'rockIsCollisionHazard', 'debugHeightMap']) {
      check(`Mountains.${m} is a function`, typeof M[m] === 'function');
    }
    check('Mountains.SimplexNoise is a constructor', typeof M.SimplexNoise === 'function');
    check('Mountains.heightMap is the shared cache object', M.heightMap && typeof M.heightMap === 'object');
  }

  // === Section G — Trees runtime import seam (the trees/ facade split) ===
  // trees.ts became a thin facade (export * from './mountains/trees.js') over the
  // moved src/mountains/trees.ts (a peer of rocks.ts). snow.ts / scene-setup.ts and
  // the bundle import the `./trees.js` specifier, so the facade must keep resolving
  // the `Trees` object with its full method surface. trees touches no WebGL at import
  // time (DOM-guarded canvas helpers), so it is boot-safe to load here.
  console.log('--- G. ./trees.js runtime import seam ---');
  let treesMod;
  try {
    treesMod = await import('../src/trees.js');
    check('`./trees.js` specifier resolves to a Trees export', !!treesMod.Trees);
  } catch (e) {
    check(`\`./trees.js\` specifier resolves (import threw: ${e.message})`, false);
  }
  if (treesMod && treesMod.Trees) {
    for (const m of ['createTree', 'addBranchesAtLayer', 'addSnowCaps', 'addTrees',
      'getTerrainHeight', 'getTerrainGradient']) {
      check(`Trees.${m} is a function`, typeof treesMod.Trees[m] === 'function');
    }
  }

  console.log(`\nCONTRACT SURFACE TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Contract-surface harness crashed:', err);
  process.exit(1);
});
