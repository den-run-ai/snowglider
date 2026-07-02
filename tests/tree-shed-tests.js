// @ts-check
// tree-shed-tests.js — headless tests for the per-tree snow load + gust shedding
// (issue #253, Phase B: src/tree-shed.ts + the load registry in src/mountains/trees.ts).
//
// Everything here runs in plain Node: the stylized instanced forest builds headless
// (no window ⇒ the EZ flag's automation gate keeps the synchronous path), the load
// registry is CPU-side Float32Array bookkeeping, and the shed system's puff pool is
// document-guarded so update() drives the load dynamics without a DOM. The shader
// side is exercised by injecting into a stub shader object, exactly like the sway
// block in trees-tests.js. Run with the .js -> .ts resolve hook:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/tree-shed-tests.js

let passed = 0;
let failed = 0;

function assert(cond, name, message) {
  if (cond) {
    passed++;
    console.log(`✅ PASS: ${name}${message ? ' - ' + message : ''}`);
  } else {
    failed++;
    console.log(`❌ FAIL: ${name}${message ? ' - ' + message : ''}`);
  }
}

async function main() {
  const THREE = await import('three');
  const { Trees } = await import('../src/trees.js');
  const { TreeShed, gustRisingEdge, selectShedTargets, forestProximityAt } =
    await import('../src/tree-shed.js');
  const { Wind, DEFAULT_WIND_CONFIG } = await import('../src/wind.js');

  // --- gustRisingEdge (pure) ------------------------------------------------------
  {
    assert(gustRisingEdge(0.5, 0.9, 0.8) === true, 'gust edge fires on an upward crossing');
    assert(gustRisingEdge(0.85, 0.9, 0.8) === false, 'no edge while already above the threshold');
    assert(gustRisingEdge(0.9, 0.5, 0.8) === false, 'no edge on the way down');
    assert(gustRisingEdge(0.5, 0.8, 0.8) === true, 'landing exactly on the threshold counts');
    assert(gustRisingEdge(NaN, 0.9, 0.8) === false && gustRisingEdge(0.5, NaN, 0.8) === false,
      'NaN samples never fire the edge');
  }

  // --- selectShedTargets (pure) -----------------------------------------------------
  {
    const positions = [
      { x: 0, y: 0, z: 0, scale: 1 },    // close, heavy
      { x: 5, y: 0, z: 0, scale: 1 },    // close, light (below minLoad)
      { x: 8, y: 0, z: 0, scale: 1 },    // close, medium
      { x: 500, y: 0, z: 0, scale: 1 },  // heavy but far outside the radius
      { x: -6, y: 0, z: 0, scale: 1 }    // close, heavy (ties with [0] on load)
    ];
    const loads = [0.9, 0.2, 0.6, 1.0, 0.9];
    const opts = { radius: 40, maxTrees: 2, minLoad: 0.45 };
    const picks = selectShedTargets(positions, loads, 1, 0, opts);
    assert(picks.length === 2, 'respects maxTrees', `picked ${picks.length}`);
    assert(!picks.includes(3), 'a tree outside the radius never sheds');
    assert(!picks.includes(1), 'a tree below minLoad never sheds');
    assert(picks[0] === 0, 'most-laden-then-closest wins the tie', `first=${picks[0]}`);
    assert(picks[1] === 4, 'the tied-load farther tree comes second');
    const again = selectShedTargets(positions, loads, 1, 0, opts);
    assert(JSON.stringify(again) === JSON.stringify(picks), 'selection is deterministic');
    assert(selectShedTargets([], [], 0, 0, opts).length === 0, 'empty forest picks nothing');
  }

  // --- forestProximityAt (pure) -----------------------------------------------------
  {
    assert(forestProximityAt(null, 0, 0) === 0 && forestProximityAt([], 0, 0) === 0,
      'no forest ⇒ zero proximity');
    const lone = [{ x: 3, y: 0, z: 0, scale: 1 }];
    const oneNear = forestProximityAt(lone, 0, 0);
    assert(oneNear > 0 && oneNear < 1, 'a single nearby tree registers but does not saturate',
      `prox=${oneNear.toFixed(3)}`);
    assert(forestProximityAt(lone, 200, 200) === 0, 'a distant tree is inaudible');
    assert(forestProximityAt(lone, 1, 0) > forestProximityAt(lone, 20, 0),
      'closer trees weigh more');
    const glade = Array.from({ length: 12 }, (_, i) => ({ x: (i % 4) * 3 - 4, y: 0, z: Math.floor(i / 4) * 3 - 3, scale: 1 }));
    assert(forestProximityAt(glade, 0, 0) === 1, 'a tight glade saturates to full proximity');
  }

  // --- Load registry: addTrees registers per-tree loads + attributes ---------------
  const scene = new THREE.Scene();
  const positions = Trees.addTrees(scene);
  const state = Trees.getTreeLoadState();
  {
    assert(state.count === positions.length,
      'registry registers one base load per placed tree', `${state.count}/${positions.length}`);
    assert(state.baseLoads.every(l => l >= 0 && l <= 1), 'base loads are all within [0, 1]');

    const forest = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    const byPart = (part) => forest.find(m => m.userData.forestPart === part);
    const cone = byPart('cone');
    const trunk = byPart('trunk');
    const snowPatch = byPart('snowPatch');
    const snowCap = byPart('snowCap');
    assert(!!cone && !!trunk && !!snowPatch && !!snowCap, 'forest part meshes exist');

    // Flex families carry aSnowLoad; snow families add aSnowRatio; the trunk carries
    // neither (it keeps the pooled geometry — no per-forest clone).
    assert(!!cone.geometry.getAttribute('aSnowLoad') && !cone.geometry.getAttribute('aSnowRatio'),
      'foliage (flex) geometry carries aSnowLoad only');
    assert(!!snowPatch.geometry.getAttribute('aSnowLoad') && !!snowPatch.geometry.getAttribute('aSnowRatio'),
      'snow (shrink) geometry carries aSnowLoad + aSnowRatio');
    assert(!trunk.geometry.getAttribute('aSnowLoad'), 'trunk geometry carries no load attribute');
    assert(cone.userData.ownsGeometry === true && trunk.userData.ownsGeometry === undefined,
      'load families own their geometry clone; the trunk still draws the shared pool');

    // Every cone instance inherited its tree's base load.
    const coneLoads = cone.geometry.getAttribute('aSnowLoad').array;
    let coneMatches = 0;
    for (let i = 0; i < coneLoads.length; i++) {
      if (state.baseLoads.some(b => Math.abs(b - coneLoads[i]) < 1e-6)) coneMatches++;
    }
    assert(coneMatches === coneLoads.length, 'every cone instance carries a registered tree load');

    // setTreeLoad writes the whole tree (absolute load + shelf ratio) and nothing else.
    const heavy = state.baseLoads.findIndex(b => b >= 0.3);
    assert(heavy >= 0, 'a reasonably laden tree exists to exercise setTreeLoad');
    Trees.setTreeLoad(heavy, 0);
    const ratios = snowPatch.geometry.getAttribute('aSnowRatio').array;
    const capRatios = snowCap.geometry.getAttribute('aSnowRatio').array;
    const zeroRatios = ratios.filter(r => r === 0).length + capRatios.filter(r => r === 0).length;
    assert(zeroRatios > 0, 'zeroing a laden tree zeroes its snow ratios (shelves shrink)');
    assert(cone.geometry.getAttribute('aSnowLoad').needsUpdate === true ||
      cone.geometry.getAttribute('aSnowLoad').version > 0,
      'attribute re-upload is flagged after a load write');

    // Ground collars are pushed OUTSIDE the per-tree ranges: setting every tree to a
    // non-zero load leaves exactly one untouched (load 0, full ratio) snowPatch
    // instance per tree — the collar, which must never droop or shrink on a shed.
    for (let i = 0; i < state.count; i++) Trees.setTreeLoad(i, 0.5);
    const patchLoads = snowPatch.geometry.getAttribute('aSnowLoad').array;
    const collarCount = patchLoads.filter(l => l === 0).length;
    assert(collarCount === state.count,
      'exactly one immutable ground collar per tree stays load-0', `${collarCount}/${state.count}`);
    for (let i = 0; i < state.count; i++) Trees.setTreeLoad(i, state.baseLoads[i]);
  }

  // --- Shader injection: load defines land on the right materials ------------------
  {
    const forest = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    const stubVS = 'void main() {\n#include <common>\n#include <begin_vertex>\n#include <project_vertex>\n}';
    const inject = (mat) => {
      const shader = { uniforms: {}, vertexShader: stubVS };
      mat.onBeforeCompile(shader);
      return shader.vertexShader;
    };
    const coneMesh = /** @type {any} */ (forest.find(m => m.userData.forestPart === 'cone'));
    const trunkMesh = /** @type {any} */ (forest.find(m => m.userData.forestPart === 'trunk'));
    const snowMesh = /** @type {any} */ (forest.find(m => m.userData.forestPart === 'snowPatch'));
    const coneVS = inject(coneMesh.material);
    const trunkVS = inject(trunkMesh.material);
    const snowVS = inject(snowMesh.material);
    assert(/attribute float aSnowLoad/.test(coneVS) && /#define TREE_SNOW_LOAD\b/.test(coneVS),
      'foliage shader declares the per-instance snow load');
    assert(!/TREE_SNOW_SHRINK/.test(coneVS.split('#include')[0]) && !/aSnowRatio/.test(coneVS.split('void main')[0]),
      'foliage shader head has no shrink attribute (flex only)');
    assert(/TREE_LOAD_DAMP/.test(coneVS) && /TREE_LOAD_DROOP/.test(coneVS),
      'load damping + droop terms are injected');
    assert(/attribute float aSnowRatio/.test(snowVS) && /#define TREE_SNOW_SHRINK/.test(snowVS),
      'snow shader declares the shrink ratio attribute');
    assert(!/attribute float aSnowLoad/.test(trunkVS),
      'trunk shader stays load-free (rooted sway only)');
    assert(coneMesh.material.customProgramCacheKey() !== trunkMesh.material.customProgramCacheKey() &&
      /flex/.test(coneMesh.material.customProgramCacheKey()) &&
      /shrink/.test(snowMesh.material.customProgramCacheKey()),
      'program cache keys distinguish the load modes');
    // The foliage shadow caster droops in lockstep: its depth material carries the
    // same flex injection (a laden tree's shadow must bow with it).
    const coneDepthVS = inject(coneMesh.customDepthMaterial);
    assert(/attribute float aSnowLoad/.test(coneDepthVS) && /TREE_LOAD_DROOP/.test(coneDepthVS),
      'foliage depth material droops in lockstep with the visible mesh');
  }

  // --- Shed dynamics: gust edge → dump → spring-back → slow recovery ---------------
  {
    // A windy field (strength ≥ minStrength always) + permissive thresholds so the
    // deterministic gust cycle sheds on the very first update.
    Wind.configure({ baseStrength: 8, gustRange: 2, gustRate: 2, seed: 0 });
    Wind.reset();
    // reloadRate 0 keeps the dump phase pure (recovery is re-enabled further down).
    TreeShed.configure({ gustEdge: 0.01, minStrength: 0, minLoad: 0, radius: 60, maxTrees: 2, cooldown: 1000, keep: 0.25, shedRate: 10, reloadRate: 0 });

    const player = { x: positions[0].x, y: positions[0].y, z: positions[0].z };
    Wind.update(0.05);
    const events = TreeShed.update(0.05, player, positions, scene);
    assert(events.length > 0 && events.length <= 2, 'a gust front sheds up to maxTrees trees',
      `${events.length} events`);
    assert(events.every(e => Number.isFinite(e.distance) && e.distance >= 0 && e.distance <= 60),
      'shed events report a finite in-radius distance');

    // Find the shed tree's index (nearest position match) and watch it dump fast...
    const shedIdx = positions.findIndex(p => p.x === events[0].x && p.z === events[0].z);
    assert(shedIdx >= 0, 'the shed event points at a real tree');
    const before = TreeShed.getLoad(shedIdx);
    for (let i = 0; i < 40; i++) { Wind.update(0.05); TreeShed.update(0.05, player, positions, scene); }
    const dumped = TreeShed.getLoad(shedIdx);
    const base = Trees.getTreeLoadState().baseLoads[shedIdx];
    assert(dumped < before || base === 0, 'the shed tree dumps its load', `${before.toFixed(2)} -> ${dumped.toFixed(2)}`);
    assert(Math.abs(dumped - base * 0.25) < 1e-3 || base === 0,
      'the dump settles at keep × base (branches keep a dusting)');

    // ...the registry attribute followed the dump (the visible spring-back)...
    const forest = /** @type {any[]} */ (scene.children.filter(c => c.name === 'forestInstanced'));
    const cone = /** @type {any} */ (forest.find(m => m.userData.forestPart === 'cone'));
    const coneLoads = cone.geometry.getAttribute('aSnowLoad').array;
    assert(Array.prototype.some.call(coneLoads, (l) => Math.abs(l - dumped) < 1e-3),
      'the dumped load is written through to the instanced attribute');

    // ...no re-shed during the cooldown...
    let extra = 0;
    for (let i = 0; i < 40; i++) {
      Wind.update(0.05);
      extra += TreeShed.update(0.05, player, positions, scene).length;
    }
    assert(extra === 0, 'the cooldown suppresses immediate re-sheds');

    // ...then the snowfall slowly re-ladens it (recovery accelerated for the test)...
    TreeShed.configure({ reloadRate: 10 });
    for (let i = 0; i < 40; i++) { Wind.update(0.05); TreeShed.update(0.05, player, positions, scene); }
    const recovered = TreeShed.getLoad(shedIdx);
    assert(Math.abs(recovered - base) < 1e-3, 'the tree re-ladens back to its base load',
      `${recovered.toFixed(2)} vs base ${base.toFixed(2)}`);

    // ...and reset() restores the whole forest instantly (run restart).
    Wind.update(0.05);
    TreeShed.update(0.05, player, positions, scene); // may shed again post-recovery
    TreeShed.reset();
    const st = Trees.getTreeLoadState();
    let allBase = true;
    for (let i = 0; i < st.count; i++) {
      if (Math.abs(TreeShed.getLoad(i) - st.baseLoads[i]) > 1e-6) allBase = false;
    }
    assert(allBase, 'reset() restores every tree to its base load');

    // A rebuilt forest resyncs the shed state (registry version bump).
    const positions2 = Trees.addTrees(scene);
    TreeShed.update(0.05, player, positions2, scene);
    assert(Number.isFinite(TreeShed.getLoad(0)), 'a forest rebuild resyncs the shed registry');

    // Restore the shared field + tunables for any suite that runs after us.
    Wind.configure(DEFAULT_WIND_CONFIG);
    Wind.reset();
    TreeShed.teardown();
  }

  // --- Puff pool under a DOM (the visible shed burst) --------------------------------
  // The pool is document-guarded (headless Node above never built it); mirror the
  // avalanche powder coverage: bring up jsdom + a stubbed 2d canvas context, shed a
  // tree, and watch the sprites spawn, billow, fade, and reclaim.
  {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const g = /** @type {any} */ (globalThis);
    g.window = dom.window;
    g.document = dom.window.document;
    dom.window.matchMedia = () => /** @type {any} */ ({ matches: false });
    // jsdom has no 2d context without the native canvas pkg — stub what the
    // radial-gradient puff texture draws with.
    const origCreate = dom.window.document.createElement.bind(dom.window.document);
    dom.window.document.createElement = function (tag) {
      const el = origCreate(tag);
      if (tag === 'canvas') {
        el.getContext = () => ({
          fillStyle: '',
          createRadialGradient: () => ({ addColorStop() {} }),
          fillRect() {}
        });
      }
      return el;
    };

    const scene2 = new THREE.Scene();
    const positions3 = Trees.addTrees(scene2);
    Wind.configure({ baseStrength: 8, gustRange: 2, gustRate: 2, seed: 0 });
    Wind.reset();
    TreeShed.configure({ gustEdge: 0.01, minStrength: 0, minLoad: 0, radius: 60, maxTrees: 3, cooldown: 1000, keep: 0.25, shedRate: 10, reloadRate: 0 });
    const player3 = { x: positions3[0].x, y: positions3[0].y, z: positions3[0].z };
    Wind.update(0.05);
    const events3 = TreeShed.update(0.05, player3, positions3, scene2);
    assert(events3.length > 0, 'a shed fires under the DOM too');
    const livePuffs = () => scene2.children.filter(c => c.name === 'treeShedPuff' && c.visible);
    const burst = livePuffs();
    assert(burst.length >= 2, 'shed trees burst pooled puff sprites into the scene', `${burst.length} puffs`);

    // Puffs billow: advance and watch one drift, expand, and take opacity.
    const p0 = /** @type {any} */ (burst[0]);
    const y0 = p0.position.y;
    const s0 = p0.scale.x;
    for (let i = 0; i < 6; i++) { Wind.update(0.05); TreeShed.update(0.05, player3, positions3, scene2); }
    assert(p0.position.y < y0, 'a puff sinks (falling snow dust)');
    assert(p0.scale.x > s0, 'a puff expands as it billows');
    assert(p0.material.opacity > 0, 'a live puff is visible (blooming opacity)');

    // ...and are reclaimed once their life runs out.
    for (let i = 0; i < 50; i++) { Wind.update(0.05); TreeShed.update(0.05, player3, positions3, scene2); }
    assert(livePuffs().length === 0, 'expired puffs are hidden back into the pool');

    // reset() hides in-flight puffs immediately.
    Wind.update(0.05);
    TreeShed.update(0.05, player3, positions3, scene2); // may shed again (cooldown reset on registry? no — force below)
    TreeShed.configure({ cooldown: 0 });
    Wind.update(0.05);
    TreeShed.update(0.05, player3, positions3, scene2);
    TreeShed.reset();
    assert(livePuffs().length === 0, 'reset() reclaims every in-flight puff');

    // teardown() disposes the pool + template resources and is idempotent.
    TreeShed.teardown();
    TreeShed.teardown();
    assert(scene2.children.filter(c => c.name === 'treeShedPuff').length === 0,
      'teardown removes the pooled sprites from the scene');

    // Reduced motion: the whole system is inert — no load writes, no puffs.
    dom.window.matchMedia = () => /** @type {any} */ ({ matches: true });
    Wind.update(0.05);
    const rmEvents = TreeShed.update(0.05, player3, positions3, scene2);
    assert(rmEvents.length === 0 && scene2.children.filter(c => c.name === 'treeShedPuff').length === 0,
      'prefers-reduced-motion keeps the shed system fully inert');
    TreeShed.teardown();

    Wind.configure(DEFAULT_WIND_CONFIG);
    Wind.reset();
    delete g.window;
    delete g.document;
  }

  // --- Hygiene: deterministic by construction ---------------------------------------
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tree-shed.ts'), 'utf8');
    assert(!/Math\.random\(/.test(src), 'tree-shed.ts never CALLS Math.random (private xorshift only)');
    assert(!/Date\.now|new Date\(/.test(src), 'tree-shed.ts uses no wall clock (dt-driven only)');
  }

  console.log('\n=================================');
  console.log(`Tree-shed tests completed: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Tree-shed tests crashed:', err);
  process.exit(1);
});
