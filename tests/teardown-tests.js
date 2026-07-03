// teardown-tests.js — headless coverage for the dispose-audit teardown path
// (src/game/teardown.ts): the dedup-safe scene-resource sweep and the idempotent
// disposeGame() entry point.
//
// There is NO production leak — the run/restart flow reuses the scene (see the plan
// §1). disposeGame() is the NEW path used by unmount + dev-HMR, so these tests guard
// its two load-bearing properties:
//   1. disposeSceneResources disposes each UNIQUE geometry/material/texture exactly
//      once even when many meshes share a pooled singleton (a naive per-mesh traverse
//      would double-free).
//   2. disposeGame is idempotent: a second call is a no-op (the §6 double-dispose
//      safety requirement), and the first call stops the loop, disposes every
//      subsystem once, drops the renderer + canvas, and aborts the listeners.
//
// A real WebGLRenderer needs a GL context (unreachable in Node), so the renderer is a
// spy double; the scene is a real THREE.Scene so the traverse/dedup logic runs for
// real. Run via the register-ts-resolve loader so teardown.ts's `./*.js` sibling
// imports (the trees facade) resolve to their `.ts` sources:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/teardown-tests.js
'use strict';

const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { disposeSceneResources, disposeGame } = await import('../src/game/teardown.ts');

  await testDedupSweep(THREE, disposeSceneResources);
  await testDisposeGameIdempotent(THREE, disposeGame);
  await testOwnedDomNodeRemoval(THREE, disposeGame);
  await testSnowflakePoolTeardown(THREE);
  await testAudioToastTeardown();

  console.log(`\nTEARDOWN TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---- AudioModule.teardown(): clears on-screen showMessage() toasts + their timers so a
// fixed z-index:3000 div doesn't linger over the host page after unmount (Codex review #226). ----
async function testAudioToastTeardown() {
  console.log('--- AudioModule.teardown: clears lingering showMessage toasts ---');
  const { AudioModule } = await import('../src/audio.ts');

  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
  const g = globalThis;
  const prevDoc = g.document, prevWin = g.window;
  g.window = dom.window;
  g.document = dom.window.document;
  try {
    AudioModule.showMessage('Loading game...', 100000); // long duration so it can't self-remove
    AudioModule.showMessage('Get Ready!', 100000);
    const toasts = () => [...dom.window.document.body.children].filter((el) => el.textContent === 'Loading game...' || el.textContent === 'Get Ready!');
    check('showMessage appends the toast nodes to the body', toasts().length === 2);

    AudioModule.teardown();
    check('teardown removes every on-screen toast node', toasts().length === 0);

    // Idempotent + a fresh toast after teardown is independent of the cleared ones.
    let threw = false;
    try { AudioModule.teardown(); } catch { threw = true; }
    check('teardown is idempotent (no throw when no toasts remain)', !threw);
  } finally {
    AudioModule.teardown();
    g.document = prevDoc;
    g.window = prevWin;
  }
}

// ---- Snow.teardownSnowflakes: detaches the sprites, frees their materials, and CLEARS
// the module-level pool so a same-instance remount doesn't stack a second snowfall on the
// stale sprites (Codex review #226). ----
async function testSnowflakePoolTeardown(THREE) {
  console.log('--- Snow.teardownSnowflakes: clears the module snowflake pool ---');
  const { Snow } = await import('../src/snow.ts');

  // jsdom lacks a 2d canvas context; stub the few calls createSnowflakes makes.
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
  const g = globalThis;
  const prevDoc = g.document, prevWin = g.window;
  g.window = dom.window;
  g.document = dom.window.document;
  const realCreate = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'canvas') {
      el.getContext = () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        fillRect() {}, fillStyle: '',
      });
    }
    return el;
  };

  // Count SpriteMaterial disposals so we can prove the pool was emptied. Since the
  // snow-particle correctness pass (completion-plan PR-V1) the flakes SHARE a few
  // opacity-bucket materials instead of cloning one per sprite, so a clean teardown
  // disposes each unique bucket exactly once — a small count far below the sprite
  // count (the dedup contract is pinned in detail by snow-particles-tests.js).
  let matDisposed = 0;
  const realMatDispose = THREE.SpriteMaterial.prototype.dispose;
  THREE.SpriteMaterial.prototype.dispose = function (...a) { matDisposed++; return realMatDispose.apply(this, a); };

  try {
    const scene = new THREE.Scene();
    const before = scene.children.length;

    Snow.createSnowflakes(scene);
    const added = scene.children.length - before;
    check('createSnowflakes adds the snowflake sprites to the scene', added > 0);
    const uniqueMats = new Set(
      scene.children.filter((c) => c.isSprite).map((s) => s.material)
    ).size;
    check('the flake pool shares bucket materials (uniques far below sprite count)',
      uniqueMats >= 2 && uniqueMats < added / 10);

    matDisposed = 0;
    Snow.teardownSnowflakes();
    check('teardownSnowflakes detaches every snowflake from the scene', scene.children.length === before);
    check('teardownSnowflakes disposes each unique bucket material exactly once',
      matDisposed === uniqueMats);

    // Second cycle: if teardown cleared the pool, this disposes the SAME unique count
    // again; a stale pool would sweep the old sprites' materials into the teardown
    // too and inflate the count.
    Snow.createSnowflakes(scene);
    check('a second createSnowflakes adds the same count (pool was cleared, not stacked)',
      scene.children.length - before === added);
    matDisposed = 0;
    Snow.teardownSnowflakes();
    check('the second teardown disposes only the fresh unique buckets (no stale-pool re-dispose)',
      matDisposed === uniqueMats);
  } finally {
    THREE.SpriteMaterial.prototype.dispose = realMatDispose;
    g.document = prevDoc;
    g.window = prevWin;
  }
}

// ---- disposeSceneResources: each unique resource freed exactly once, even when shared. ----
async function testDedupSweep(THREE, disposeSceneResources) {
  console.log('--- disposeSceneResources: dedups shared geometry/material/texture ---');

  // One geometry, one material (with a texture map) shared across THREE meshes — the
  // pooled-singleton case the dedup Set must collapse.
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const tex = new THREE.Texture();
  const mat = new THREE.MeshStandardMaterial({ map: tex });

  const geoDisposed = [];
  const matDisposed = [];
  const texDisposed = [];
  geo.addEventListener('dispose', () => geoDisposed.push(1));
  mat.addEventListener('dispose', () => matDisposed.push(1));
  tex.addEventListener('dispose', () => texDisposed.push(1));

  const scene = new THREE.Scene();
  for (let i = 0; i < 3; i++) scene.add(new THREE.Mesh(geo, mat));

  // A mesh with an ARRAY material (multi-material) plus a fresh unique geometry, to
  // exercise the Array.isArray branch and confirm distinct resources are each freed.
  const geo2 = new THREE.PlaneGeometry(1, 1);
  const matA = new THREE.MeshBasicMaterial();
  const matB = new THREE.MeshBasicMaterial();
  let geo2Disposed = 0, matADisposed = 0, matBDisposed = 0;
  geo2.addEventListener('dispose', () => geo2Disposed++);
  matA.addEventListener('dispose', () => matADisposed++);
  matB.addEventListener('dispose', () => matBDisposed++);
  scene.add(new THREE.Mesh(geo2, [matA, matB]));

  // An InstancedMesh (forest/avalanche/snow-trail case): its per-instance
  // instanceMatrix/instanceColor buffers are freed only by InstancedMesh.dispose(), NOT
  // geometry.dispose(), so the sweep must call it. dispose() dispatches a 'dispose' event.
  const instGeo = new THREE.BoxGeometry(1, 1, 1);
  const instMat = new THREE.MeshStandardMaterial();
  const inst = new THREE.InstancedMesh(instGeo, instMat, 4);
  let instDisposed = 0;
  inst.addEventListener('dispose', () => instDisposed++);
  scene.add(inst);

  // A mesh carrying a customDepthMaterial (the swaying-tree shadow-caster case): it is NOT
  // reachable via obj.material, so the sweep must collect it explicitly or the shadow-pass
  // material/program leaks.
  const cdmMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const cdmDepth = new THREE.MeshDepthMaterial();
  cdmMesh.customDepthMaterial = cdmDepth;
  let cdmDepthDisposed = 0;
  cdmDepth.addEventListener('dispose', () => cdmDepthDisposed++);
  scene.add(cdmMesh);

  disposeSceneResources(scene);

  check('shared geometry disposed exactly once across 3 meshes', geoDisposed.length === 1);
  check('shared material disposed exactly once across 3 meshes', matDisposed.length === 1);
  check('texture hung off the shared material disposed exactly once', texDisposed.length === 1);
  check('the unique second geometry disposed once', geo2Disposed === 1);
  check('both materials in an array material disposed once each', matADisposed === 1 && matBDisposed === 1);
  check('InstancedMesh per-instance buffers disposed (InstancedMesh.dispose called)', instDisposed === 1);
  check('customDepthMaterial (shadow-caster) disposed by the sweep', cdmDepthDisposed === 1);
}

// Build a fake SceneContext: a real THREE.Scene (so the sweep runs), spy subsystems,
// and a spy renderer double (a real WebGLRenderer needs a GL context).
function makeFakeContext(THREE) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));

  const calls = { debrisReset: 0, trailsDispose: 0, avalancheDispose: 0, rendererDispose: 0, forceContextLoss: 0, canvasRemoved: 0, listenersTorndown: 0 };

  // Model the real ownership: the canvas sits inside a #gameCanvas wrapper, which sits in
  // the body. disposeGame removes the WRAPPER (canvas.parentNode), taking the canvas with
  // it — so the spy lives on the wrapper's parent. (No global `document` here, so the
  // getElementById('cameraToggleBtn') branch is correctly skipped.)
  const body = { removeChild: (c) => { if (c === wrapper) calls.canvasRemoved++; } };
  const wrapper = { parentNode: body };
  const canvas = { parentNode: wrapper };
  const renderer = {
    domElement: canvas,
    dispose: () => { calls.rendererDispose++; },
    forceContextLoss: () => { calls.forceContextLoss++; },
  };

  const ctx = {
    scene,
    renderer,
    state: {
      gameActive: true,
      animationRunning: true,
      debris: { reset: () => { calls.debrisReset++; } },
      snowTrails: { dispose: () => { calls.trailsDispose++; } },
      avalanche: { dispose: () => { calls.avalancheDispose++; } },
    },
  };
  const teardownListeners = () => { calls.listenersTorndown++; };
  return { ctx, calls, teardownListeners };
}

// ---- disposeGame: stops the loop, disposes each subsystem once, drops renderer +
// canvas, aborts listeners — and a SECOND call is a no-op (idempotence). ----
async function testDisposeGameIdempotent(THREE, disposeGame) {
  console.log('--- disposeGame: full teardown, then idempotent on a second call ---');

  const { ctx, calls, teardownListeners } = makeFakeContext(THREE);

  disposeGame(ctx, teardownListeners);

  check('stops the loop (gameActive=false)', ctx.state.gameActive === false);
  check('stops the loop (animationRunning=false)', ctx.state.animationRunning === false);
  check('debris reset() called once', calls.debrisReset === 1);
  check('snowTrails dispose() called once', calls.trailsDispose === 1);
  check('avalanche dispose() called once', calls.avalancheDispose === 1);
  check('renderer dispose() called once', calls.rendererDispose === 1);
  check('renderer forceContextLoss() called once', calls.forceContextLoss === 1);
  check('owned #gameCanvas wrapper detached from the body once', calls.canvasRemoved === 1);
  check('listeners torn down once', calls.listenersTorndown === 1);

  // Second call: every side effect must stay at its first-call count (no-op).
  disposeGame(ctx, teardownListeners);
  check('second disposeGame() does not re-reset debris', calls.debrisReset === 1);
  check('second disposeGame() does not re-dispose snowTrails', calls.trailsDispose === 1);
  check('second disposeGame() does not re-dispose avalanche', calls.avalancheDispose === 1);
  check('second disposeGame() does not re-dispose the renderer', calls.rendererDispose === 1);
  check('second disposeGame() does not re-abort listeners', calls.listenersTorndown === 1);

  // A renderer whose forceContextLoss throws (headless / lost context) must not crash
  // disposeGame — the renderer block is wrapped — and the rest of teardown still runs.
  const { ctx: ctx2, calls: calls2, teardownListeners: tl2 } = makeFakeContext(THREE);
  ctx2.renderer.forceContextLoss = () => { throw new Error('no GL context'); };
  let threw = false;
  try { disposeGame(ctx2, tl2); } catch { threw = true; }
  check('disposeGame swallows a renderer teardown error', !threw);
  check('listeners still torn down despite the renderer throw', calls2.listenersTorndown === 1);

  // disposeGame must tolerate a missing teardownListeners arg.
  const { ctx: ctx3 } = makeFakeContext(THREE);
  let threw2 = false;
  try { disposeGame(ctx3); } catch { threw2 = true; }
  check('disposeGame works without a teardownListeners callback', !threw2);
}

// ---- disposeGame removes the instance-owned DOM nodes, not just the canvas (Codex
// review #226). setupScene() appends the #gameCanvas wrapper + #gameOverOverlay, and
// initLifecycleUI() appends #cameraToggleBtn; leaving them in the document on teardown
// would create duplicate IDs / stale UI on a remount. ----
async function testOwnedDomNodeRemoval(THREE, disposeGame) {
  console.log('--- disposeGame: removes #gameCanvas wrapper, #gameOverOverlay, #cameraToggleBtn ---');

  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
  const { document } = dom.window;
  const g = globalThis;
  const prevDoc = g.document;
  g.document = document; // teardown.ts reads the global `document` for getElementById

  try {
    // Mirror setupScene()/initLifecycleUI() DOM ownership: the canvas lives inside the
    // #gameCanvas wrapper, the overlay + toggle button are appended to the body.
    const wrapper = document.createElement('div');
    wrapper.id = 'gameCanvas';
    const canvas = document.createElement('canvas');
    wrapper.appendChild(canvas);
    document.body.appendChild(wrapper);

    const overlay = document.createElement('div');
    overlay.id = 'gameOverOverlay';
    document.body.appendChild(overlay);

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'cameraToggleBtn';
    document.body.appendChild(toggleBtn);

    // A reset button authored in index.html (NOT instance-owned) must survive teardown.
    const resetBtn = document.createElement('button');
    resetBtn.id = 'resetBtn';
    document.body.appendChild(resetBtn);

    let rendererDisposed = 0;
    const ctx = {
      scene: new THREE.Scene(),
      renderer: {
        domElement: canvas,
        dispose: () => { rendererDisposed++; },
        forceContextLoss: () => {},
      },
      gameOverOverlay: overlay,
      state: { gameActive: true, animationRunning: true, debris: null, snowTrails: null, avalanche: null },
    };

    disposeGame(ctx);

    check('renderer disposed', rendererDisposed === 1);
    check('#gameCanvas wrapper (and its canvas) removed from the document',
      document.getElementById('gameCanvas') === null && !document.body.contains(canvas));
    check('#gameOverOverlay removed from the document', document.getElementById('gameOverOverlay') === null);
    check('#cameraToggleBtn removed from the document', document.getElementById('cameraToggleBtn') === null);
    check('index.html-authored #resetBtn is NOT removed (not instance-owned)',
      document.getElementById('resetBtn') !== null);
  } finally {
    g.document = prevDoc;
  }
}

main().catch((err) => { console.error('teardown test harness crashed:', err); process.exit(1); });
