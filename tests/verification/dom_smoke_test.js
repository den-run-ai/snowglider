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
global.window = window;
global.document = window.document;
global.localStorage = (function () {
  let store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { store = {}; }
  };
})();
window.localStorage = global.localStorage;
window.matchMedia = window.matchMedia || (() => ({ matches: false }));

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
  const snowmanMock = { rotation: { y: Math.PI } };
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

  // Gap 2 regression: after a personal best, reset() must reload bestSplits, so the
  // second run's result table shows real per-split deltas instead of the "—" placeholder.
  // (Scope the check to the split table — the "X — new personal best!" line legitimately
  // uses an em dash as a separator, so checking the whole panel would false-positive.)
  const EM_DASH = String.fromCharCode(0x2014);
  const deltaTable = panel2.lastElementChild; // split table is appended last in the panel
  check('best-split deltas not stale after PB (Gap 2)',
    !!deltaTable && deltaTable.textContent.indexOf(EM_DASH) === -1);

  Course.hideHud();
  check('hideHud() runs without throwing', true);

  console.log(`\nSMOKE TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test harness crashed:', err);
  process.exit(1);
});
