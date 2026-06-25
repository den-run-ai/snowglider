// @ts-check
// dom_smoke_test.js
// Headless coverage for course.ts + effects.ts under jsdom, without a browser.
// Requires jsdom (devDependency).
//
// Phase 2.2/2.6 (issue #84): course and effects are ES modules, so they can no
// longer be evaluated with a `new Function(src)` + mock-THREE injection — that
// pattern can't load `import`/`export`. Both sections now `import()` the REAL
// module (and, for course, REAL three: its geometry/material/texture constructors
// need no WebGL, so they build fine headless under Node), exercising shipped code
// directly. effects uses no three.js at all, so its import needs no mock; the
// previous mock-THREE scaffolding and `new Function` loader are gone.
//
// Phase 3.1 (issue #84): both modules were renamed `.js` -> `.ts`. Node does not
// remap `.js` import specifiers to `.ts`, so these direct imports use the real
// `.ts` extension (Node strips the erasable types natively, like `avalanche.ts`).
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
const g = /** @type {any} */ (globalThis);
g.window = window;
g.document = window.document;
g.localStorage = (function () {
  let store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { store = {}; }
  };
})();
g.window.localStorage = g.localStorage;
window.matchMedia = window.matchMedia || (() => /** @type {any} */ ({ matches: false }));

// Stub <canvas> 2d context (jsdom has none without the native canvas pkg).
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = function (tag) {
  const el = origCreate(tag);
  if (tag === 'canvas') {
    el.getContext = () => ({
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
      fillRect() {}, fillText() {}
    });
  }
  return el;
};

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  // ---- EffectsModule (real ES module, PR 2.6; uses no three.js) ----
  console.log('--- EffectsModule ---');
  // effects builds DOM overlays and pokes a plain camera object; it imports no
  // three, so we import the REAL module directly. Its `document`/`window` reads
  // resolve to the jsdom globals wired up above.
  const { EffectsModule: Effects } = await import('../../src/effects.ts');
  check('module exports init/updateAvalanche/tickCamera', !!Effects && typeof Effects.init === 'function' && typeof Effects.tickCamera === 'function');
  Effects.init();
  const banner = window.document.body.querySelector('div');
  check('init builds DOM overlays without throwing', !!banner);
  // Inactive avalanche hides things, active shows + sets danger
  Effects.updateAvalanche(false, Infinity);
  Effects.updateAvalanche(true, 40);
  Effects.updateAvalanche(true, 8); // very close
  check('updateAvalanche(active, near) runs', true);
  // Camera FOV widens with speed and shake offset returned
  const cam = { fov: 75, position: { x: 0, y: 0, z: 0 }, updateProjectionMatrix() { this._u = (this._u || 0) + 1; } };
  Effects.addShake(1.0);
  let off = Effects.tickCamera(cam, 1 / 60, 30);
  check('tickCamera returns an offset object', off && typeof off.x === 'number');
  check('high speed widens FOV above base 75', cam.fov > 75.0);
  Effects.reset();
  check('reset() runs without throwing', true);

  // ---- CourseModule (real ES module + real three, PR 2.2) ----
  console.log('\n--- CourseModule ---');
  // course `import`s three from npm, so we import the REAL module + REAL three
  // rather than evaluating the source with a mock. The fake snowman is a real
  // three Group whose mesh carries a MeshStandardMaterial so buildGhost's
  // material.clone()/color.lerp()/emissive path exercises shipped code.
  const RealTHREE = await import('three');
  const { CourseModule: Course } = await import('../../src/course.ts');
  const fakeCreateSnowman = () => {
    const g = new RealTHREE.Group();
    g.add(new RealTHREE.Mesh(new RealTHREE.BoxGeometry(1, 1, 1), new RealTHREE.MeshStandardMaterial()));
    return g;
  };
  check('module exports init/update/onFinish', !!Course && typeof Course.update === 'function' && typeof Course.onFinish === 'function');

  const terrain = (x, z) => 40 * Math.exp(-Math.sqrt(x * x + z * z) / 40) + (z < -30 ? (z + 30) * 0.12 : 0);
  Course.init({ scene: new RealTHREE.Scene(), getTerrainHeight: terrain, createSnowman: fakeCreateSnowman });
  check('init builds gates + HUD', true);

  // Simulate a clean run reaching every split.
  global.localStorage.clear();
  Course.reset();
  const cfg = Course._config;
  const splitZ = cfg.splitPoints.map(s => s.z);
  let crossed = 0;
  const snowmanMock = /** @type {any} */ ({ rotation: { y: Math.PI } });
  let t = 0;
  for (let z = cfg.START_Z; z >= cfg.FINISH_Z; z -= 1.0) {
    t += 0.12; // ~ seconds; arbitrary monotonic clock
    Course.update({ x: 1.5, y: terrain(1.5, z), z }, t, snowmanMock);
    // count how many split thresholds we've now passed
    crossed = splitZ.filter(sz => z <= sz).length;
  }
  check('all checkpoints + finish are reachable', crossed === splitZ.length);

  // First finish: should be a "first descent" (no previous best) and persist a ghost.
  const panel1 = Course.onFinish(t, Infinity);
  check('onFinish returns a result panel node', !!panel1 && panel1.id === 'courseResult');
  check('ghost trajectory persisted to localStorage', !!global.localStorage.getItem('snowgliderGhost'));
  check('best splits persisted to localStorage', !!global.localStorage.getItem('snowgliderBestSplits'));
  const panelText1 = panel1.textContent || '';
  check('first finish shows a medal/result text', /descent|record|Finish/i.test(panelText1));

  // Gap 3 regression: the persisted ghost's final sample keeps the player's real x
  // (not a hardcoded 0) so it doesn't snap to center at the line.
  const ghostSaved = JSON.parse(global.localStorage.getItem('snowgliderGhost'));
  const ghostLast = ghostSaved[ghostSaved.length - 1];
  check('ghost final sample keeps real x (Gap 3, not snapped to 0)', Math.abs(ghostLast.x - 0) > 0.5 && ghostLast.z === cfg.FINISH_Z);

  // Social sharing (see docs/CHANGELOG.md): the result panel hosts a hybrid share
  // control built only inside the finish result panel, so it appears solely on a
  // valid finish. On desktop (no navigator.share under jsdom) the primary button
  // toggles a menu of per-platform links + "Save image" + "Copy link".
  const shareBtn1 = /** @type {HTMLButtonElement} */ (panel1.querySelector('#shareResultBtn'));
  check('finish result panel includes a Share button', !!shareBtn1);
  check('Share button is labelled "Share Result"', /Share Result/.test(shareBtn1 ? shareBtn1.textContent : ''));

  const shareMenu1 = /** @type {HTMLDivElement} */ (panel1.querySelector('#shareMenu'));
  check('share menu is present but hidden until toggled', !!shareMenu1 && shareMenu1.style.display === 'none');
  check('share menu lists all six social platforms',
    shareMenu1 ? shareMenu1.querySelectorAll('[data-platform]').length === 6 : false);
  check('share menu includes the Copy-link action', !!(shareMenu1 && shareMenu1.querySelector('#shareCopyBtn')));
  // The Save-image (Instagram) action stays visible on every device, so it is a
  // panel-level sibling of the toggle menu rather than inside it.
  check('Save-image (Instagram) action is always visible', !!panel1.querySelector('#shareImageBtn'));

  // Desktop: clicking the primary button reveals the explicit menu (jsdom has no
  // navigator.share, so prefersNativeShare() is false and we don't open a sheet).
  shareBtn1.click();
  check('clicking Share Result opens the menu on desktop', shareMenu1.style.display === 'block');

  // "Copy link" uses the clipboard fallback. Install a clipboard spy via
  // defineProperty because Node exposes a getter-only `navigator` global.
  /** @type {string | null} */
  let clipboardText = null;
  Object.defineProperty(global, 'navigator', {
    value: { clipboard: { writeText: async (txt) => { clipboardText = txt; } } },
    configurable: true, writable: true
  });
  const copyBtn1 = /** @type {HTMLButtonElement} */ (shareMenu1.querySelector('#shareCopyBtn'));
  copyBtn1.click();
  await new Promise((r) => setTimeout(r, 0));
  // The clipboard fallback writes "<message>\n<url>"; validate the URL line by
  // parsing it and checking the parsed origin (a substring/`includes` host check
  // is unsafe — e.g. https://snowglider.ai.evil.com would pass).
  let copiedToPublicSite = false;
  if (typeof clipboardText === 'string') {
    try {
      const shareUrl = new URL(clipboardText.trim().split('\n').pop());
      copiedToPublicSite = shareUrl.protocol === 'https:' && shareUrl.host === 'snowglider.ai';
    } catch {
      copiedToPublicSite = false;
    }
  }
  check('Copy link copies a stable public link', copiedToPublicSite);
  check('Copy link reflects the copied state', /copied/i.test(copyBtn1.textContent || ''));
  delete global.navigator;

  // Second run, faster: should read as a new record and a ghost should now exist + interpolate.
  Course.reset(); // loads the stored ghost AND best splits (Gap 2 fix)
  let t2 = 0;
  for (let z = cfg.START_Z; z >= cfg.FINISH_Z; z -= 1.0) {
    t2 += 0.09; // faster pace than run 1 (0.12)
    Course.update({ x: 1.5, y: terrain(1.5, z), z }, t2, snowmanMock);
  }
  const previousBest = t; // run 1 total
  const panel2 = Course.onFinish(t2, previousBest);
  const panelText2 = panel2.textContent || '';
  check('faster second run reports a new record', /record/i.test(panelText2));
  check('result panel contains a split table (Δ Best)', /Δ Best/.test(panelText2));
  check('second finish panel also includes a Share button', !!panel2.querySelector('#shareResultBtn'));

  // Gap 2 regression: after a personal best, reset() must reload bestSplits, so the
  // second run's result table shows real per-split deltas instead of the "—" placeholder.
  // (Scope the check to the split table by id — the "X — new personal best!" line
  // legitimately uses an em dash as a separator, so checking the whole panel would
  // false-positive.)
  const EM_DASH = String.fromCharCode(0x2014);
  const deltaTable = panel2.querySelector('#resultSplitTable');
  check('best-split deltas not stale after PB (Gap 2)',
    !!deltaTable && deltaTable.textContent.indexOf(EM_DASH) === -1);

  // flashAir (meaningful jumps #47): the on-slope air toast routes through the shared
  // #courseFlash element with the air time + grade label.
  Course.flashAir('clean', 1.234);
  const flashEl = window.document.getElementById('courseFlash');
  check('flashAir shows air time + CLEAN grade (#47)',
    !!flashEl && /CLEAN/.test(flashEl.innerHTML) && /1\.2s/.test(flashEl.innerHTML));
  Course.flashAir('sketchy', 0.8);
  check('flashAir maps the SKETCHY grade (#47)', /SKETCHY/.test(flashEl.innerHTML));

  // Air score (meaningful jumps #47): banked air-score points show on the result
  // screen, and a run with no banked air omits the readout entirely.
  check('result panel omits air score when none banked (#47)', !panel2.querySelector('#resultAirScore'));
  Course.reset();           // zeroes airScore
  Course.addAirScore(180);
  Course.addAirScore(70);   // accumulates -> 250
  Course.addAirScore(-5);   // non-positive ignored
  const panel3 = Course.onFinish(t + 0.5, t);
  const airEl = panel3.querySelector('#resultAirScore');
  check('result panel shows banked air score (#47)', !!airEl && /250/.test(airEl.textContent));
  Course.reset();
  const panel4 = Course.onFinish(t + 0.6, t);
  check('air score resets to 0 between runs (#47)', !panel4.querySelector('#resultAirScore'));

  Course.hideHud();
  check('hideHud() runs without throwing', true);

  // ---- Snowman model: head cluster + part registries + flex (issue #53) ----
  // Import the submodules directly (not the snowman.ts facade): this harness runs
  // under plain `node` without the .js->.ts resolver, and model.ts/snowman-flex.ts
  // only depend on (type-only, for flex) three, so they load headless. createSnowman
  // builds real three geometry/materials, which need no WebGL.
  console.log('\n--- Snowman model (flex registries) ---');
  const { createSnowman } = await import('../../src/snowman/model.ts');
  const { Flex } = await import('../../src/snowman-flex.ts');
  const snowman = createSnowman(new RealTHREE.Scene());
  const ud = snowman.userData;
  check('createSnowman builds a fine-grained part registry', !!ud && !!ud.parts && !!ud.parts.headGroup && !!ud.parts.head && !!ud.parts.bottom);
  check('shatterRoots is a flat list including the head cluster', Array.isArray(ud.shatterRoots) && ud.shatterRoots.includes(ud.parts.headGroup));
  check('base transforms kept OFF the registry (parts.base undefined)', !!ud.partBaseTransforms && !!ud.partBaseTransforms.headGroup && ud.parts.base === undefined);
  check('scarf + tail present in registry and shatter roots (PR C)', !!ud.parts.scarf && !!ud.parts.scarfTail && ud.shatterRoots.includes(ud.parts.scarfTail));
  check('face/hat are children of the head cluster (head bob keeps them attached)',
    ud.parts.head.parent === ud.parts.headGroup &&
    ud.parts.leftEye.parent === ud.parts.headGroup &&
    ud.parts.hatTop.parent === ud.parts.headGroup);
  // Re-basing the cluster must keep world positions identical at rest (~head y=7).
  const headWorld = new RealTHREE.Vector3();
  ud.parts.head.getWorldPosition(headWorld);
  check('head world position preserved at rest (~y=7, x~0)', Math.abs(headWorld.y - 7.0) < 1e-6 && Math.abs(headWorld.x) < 1e-6);
  // Flex drives the REAL snowman finitely, then resets clean.
  Flex.update(snowman, 1 / 60, { speed: 18, technique: 'carve', turnRate: 0.6, justLanded: true, landingForce: 0.9, isInAir: false });
  check('Flex.update mutates the real snowman finitely', Number.isFinite(ud.parts.head.scale.y) && Number.isFinite(ud.parts.headGroup.rotation.z));
  Flex.reset(snowman);
  check('Flex.reset restores the head cluster to neutral',
    Math.abs(ud.parts.headGroup.position.y - ud.partBaseTransforms.headGroup.position.y) < 1e-9 &&
    Math.abs(ud.parts.head.scale.y - 1) < 1e-9);

  // ---- AvalancheSystem powder cloud (issue #49 / ROADMAP Finding 3) ----
  // The billowing powder is sprite-based and only built when a DOM is present, so
  // exercise it under jsdom: the pool must build, activate while the slide is live,
  // clear on reset, and empty on dispose. (Pure JS three sprites need no WebGL.)
  console.log('\n--- AvalancheSystem powder cloud ---');
  const { AvalancheSystem } = await import('../../src/avalanche.ts');
  const av = new AvalancheSystem(new RealTHREE.Scene(), 30);
  av.setTerrainFunction(() => 0);
  check('powder sprite pool built under a DOM', Array.isArray(av.powder) && av.powder.length > 0);
  check('powder starts fully inactive', av.powder.every(p => p.userData.active === false));
  // Inactive puffs must be visible=false so three skips them in the render
  // traversal/transparent sort on the idle menu/gameplay path (perf, esp. mobile).
  check('inactive powder is hidden from the renderer', av.powder.every(p => p.visible === false));
  av.trigger({ x: 0, y: 12, z: -50 });
  for (let i = 0; i < 10; i++) av.update(0.05);
  const live = av.powder.filter(p => p.userData.active === true);
  check('powder activates while the slide is live', live.length > 0);
  check('live puffs are flipped visible, idle puffs stay hidden',
    live.every(p => p.visible === true) &&
    av.powder.every(p => p.visible === p.userData.active));
  av.reset();
  check('reset() clears every powder puff', av.powder.every(p => p.userData.active === false));
  check('reset() re-hides every puff from the renderer', av.powder.every(p => p.visible === false));
  av.dispose();
  check('dispose() empties the powder pool', av.powder.length === 0);

  console.log(`\nSMOKE TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test harness crashed:', err);
  process.exit(1);
});
