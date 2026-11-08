// Performance probes deliberately use the uninstrumented Playwright fixture.
// Precise V8 coverage changes frame cost and its stop/serialization can exhaust
// the test timeout after all frame assertions have passed. Other E2E specs keep
// the shared coverage fixture; rendering evidence must measure the player path.
import { test, expect, devices } from '@playwright/test';
import { gotoGame, startGame } from './helpers';
import type * as THREE from 'three';
import type { SceneContext } from '../../src/game/scene-setup.js';
import { RENDER_PHASES, prepareRenderScenario, enterRenderPhase, measureRenderPhase, assertRenderPhase } from './render-scenarios';

// Boot the real game, sample renderer.info after warm frames, and pin ceilings
// above measured values. These are regression guards, not performance targets.
//
// Chromium owns the measured baseline; WebKit/mobile also exercise user flows,
// touch controls, and resource teardown.

// --- Budget ceilings -------------------------------------------------------
// Spatial forest batches cull independently in the camera and sun-shadow frusta.
// Each chunk has a BufferGeometry wrapper for its instance attributes/bounds, but
// chunks in one family share static vertex/index BufferAttributes. renderer.info
// counts wrappers, not unique GPU buffers or bytes. The family sharing and GPU
// lifetime invariants are separately covered by forest-buffer-lifetime-tests.js.
//
// Chromium CI, PR #444 (1280x720, seeded layout), measured classic peaks of
// 186 calls / 219898 triangles / 212 geometries and, on retry, 207 / 222480 / 228.
// After rock batching, PR #445 measured 135 calls / 221026 triangles / 141
// geometries. This restores the earlier 185-geometry cap. Other ceilings retain
// the pre-chunk guards. These historical ceilings now explicitly measure Follow
// composition; Auto's wider, terrain-aware composition has its own gate below.
const BUDGET = {
  calls: 800, // instancing must keep this well below a per-tree mesh scene
  triangles: 350_000, // color and shadow triangles vary with the player camera
  geometries: 185, // measured 141 after rock batching (212–228 before)
  textures: 25, // live texture count (measured 16 incl. the snow-depth DataTexture; TIGHT)
  // Snow-depth terrain modulation (#246 PR 3) samples a DataTexture in the terrain
  // material via onBeforeCompile, which needs a stable customProgramCacheKey — that
  // un-shares the terrain program from any identical MeshStandardMaterial, adding exactly
  // one dedicated program (measured 24 -> 25). Ceiling nudged to 26 for a hair of headroom;
  // still TIGHT — a per-object shader regression would blow this well past 26.
  programs: 26, // compiled shader programs (measured 25 with the snow-depth terrain program)
};

type PerfInfo = {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
};

type RendererWindow = Window & {
  renderer?: {
    info: {
      render: { calls: number; triangles: number };
      memory: { geometries: number; textures: number };
      programs?: Array<unknown>;
    };
  };
};

// --- EZ evergreen variant budget (issue #282, ?eztrees=1 prototype) ---------
// EZ uses species/LOD archetypes and needle cards, so it has more geometry
// families and spatial wrappers. PR #444 measured 230 calls / 382868 triangles /
// 265 geometries / 17 textures / 43 programs. Rock batching in PR #445 measured
// 179 / 384010 / 193 / 17 / 43, restoring the previous 210-geometry cap.
const EZ_BUDGET = {
  calls: 800, // parity with the stylized budget — instancing must hold here too
  triangles: 600_000, // needle cards remain bounded after spatial culling
  geometries: 210, // measured 193 after rock batching (265 before)
  textures: 30, // + needle sprite & co. over the stylized measured ~11
  // Background scenery system (issue #320) adds a handful of shared instanced-basic-fog
  // program variants; the ambient-life layer tipped the EZ peak to 41 (its clouds/birds/
  // spindrift share ONE FrontSide basic+fog program — see ambient-life.ts). The snow-depth
  // terrain program (#246 PR 3) then adds one more, to 42. Still TIGHT: a per-archetype/
  // -object shader regression would blow this into the dozens, well past 43.
  programs: 43, // measured peak 42 (41 scenery stack + 1 snow-depth terrain program)
};

// Auto reveals more existing forest chunks and scenery immediately. Exact
// BASE/HEAD review (0d1b5fd → 3884075) measured desktop spawn 189→314 geometries
// and 43→46 programs, but end-of-course 322→338 and 47→47. CI fc9fbe8 measured
// startup EZ320/46; classic231/29. This bounded full-course envelope allows the
// already-built resources into view, while retaining the draw/triangle ceilings.
// Repeated-view residency and exact scene identity checks below reject growth.
const AUTO_EZ_BUDGET = { ...EZ_BUDGET, geometries: 350, programs: 48 };

async function selectFollowForBudget(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Window & Pick<SceneContext, 'cameraManager'>;
    w.cameraManager.setMode('follow');
  });
}

/** Seed Math.random BEFORE any game script runs so the forest layout (tree count,
 *  placement, snow patches) is identical on every CI run. Without this the random
 *  layout varies the mesh/triangle count run to run, so ceilings calibrated from
 *  one measured scene could red-bar an unrelated PR on a denser draw. addInitScript
 *  runs in the page realm before the bundle's first Math.random call. */
async function seedDeterministicLayout(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    // mulberry32 — small, fast, well-distributed seeded PRNG.
    let s = 0x9e3779b9 >>> 0;
    Math.random = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
}

/** Sample renderer.info across several warm frames and return the per-metric MAX.
 *  renderer.info reflects the LAST rendered frame, and frustum culling makes
 *  draw-calls/triangles vary frame to frame as the snowman moves, so a single
 *  arbitrary frame is flaky — the max over a window is the representative worst
 *  case and is what the budgets guard. */
async function sampleRendererPeak(page: import('@playwright/test').Page): Promise<PerfInfo> {
  await page.waitForFunction(() => !!(window as RendererWindow).renderer);
  // Keep the window in one browser evaluation: per-frame runner round trips allow
  // arbitrary extra simulation frames under CI load, changing scenery/effects.
  const samples = await page.evaluate(async () => {
    const frames: PerfInfo[] = [];
    for (let i = 0; i < 12; i++) {
      const sample = await new Promise<PerfInfo | null>((resolve) => {
        requestAnimationFrame(() => {
          const r = (window as RendererWindow).renderer;
          resolve(
            r
              ? {
                  calls: r.info.render.calls,
                  triangles: r.info.render.triangles,
                  geometries: r.info.memory.geometries,
                  textures: r.info.memory.textures,
                  programs: r.info.programs?.length ?? 0,
                }
              : null,
          );
        });
      });
      if (sample) frames.push(sample);
    }
    return frames;
  });
  expect(samples.length, 'renderer seam did not publish renderer.info').toBeGreaterThan(0);
  return {
    calls: Math.max(...samples.map((s) => s.calls)),
    triangles: Math.max(...samples.map((s) => s.triangles)),
    geometries: Math.max(...samples.map((s) => s.geometries)),
    textures: Math.max(...samples.map((s) => s.textures)),
    programs: Math.max(...samples.map((s) => s.programs)),
  };
}

function expectWithinBudget(peak: PerfInfo, budget: typeof BUDGET): void {
  expect(peak.calls, 'draw calls per frame').toBeGreaterThan(0);
  expect(peak.calls, 'draw calls per frame').toBeLessThanOrEqual(budget.calls);
  expect(peak.triangles, 'triangles per frame').toBeLessThanOrEqual(budget.triangles);
  // Includes spatial wrappers; static buffer sharing has a separate unit gate.
  expect(peak.geometries, 'live BufferGeometry count').toBeLessThanOrEqual(budget.geometries);
  expect(peak.textures, 'live texture count').toBeLessThanOrEqual(budget.textures);
  expect(peak.programs, 'compiled shader programs').toBeLessThanOrEqual(budget.programs);
}

test.describe('rendering perf / draw-call budget @chromium', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'perf numbers are Chromium-only');

  test('renderer.info stays within the draw-call / geometry budget', async ({ page }) => {
    await seedDeterministicLayout(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoGame(page);
    await selectFollowForBudget(page);
    await startGame(page);

    const peak = await sampleRendererPeak(page);
    // Surface the live peak in the test output so threshold drift is auditable.
    console.log('[perf-budget] renderer.info peak over warm frames:', JSON.stringify(peak));
    expectWithinBudget(peak, BUDGET);
  });

  test('EZ evergreen forest (?eztrees=1) stays within its perf budget', async ({ page }) => {
    await seedDeterministicLayout(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoGame(page, '?eztrees=1');
    await selectFollowForBudget(page);
    await startGame(page);

    // The EZ forest is appended asynchronously once the archetype chunk loads;
    // sampling before it lands would measure the collars-only scene.
    await page.waitForFunction(() => {
      const t = (window as Window & { terrainMesh?: { parent?: { children: Array<{ name: string; userData: Record<string, unknown> }> } } }).terrainMesh;
      return !!(t && t.parent && t.parent.children.some(
        (c) => c.name === 'forestInstanced' && c.userData.forestPart === 'ezBranches'));
    }, undefined, { timeout: 30_000 });

    const peak = await sampleRendererPeak(page);
    console.log('[perf-budget:eztrees] renderer.info peak over warm frames:', JSON.stringify(peak));
    expectWithinBudget(peak, EZ_BUDGET);
  });

  test('Auto reveals existing scene resources and plateaus across repeated terrain views', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    const errors = await prepareRenderScenario(page);
    const evidence = await page.evaluate(() => {
      const w = window as unknown as Window & Pick<SceneContext, 'scene' | 'renderer' | 'camera' | 'cameraManager' | 'snowman'> & {
        getTerrainHeight: (x: number, z: number) => number;
      };
      const inventory = () => {
        const geometries = new Set<string>(), materials = new Set<string>();
        w.scene.traverse(object => {
          const mesh = object as THREE.Mesh;
          if (mesh.geometry) geometries.add(mesh.geometry.uuid);
          for (const material of mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []) {
            materials.add(material.uuid);
          }
        });
        return { geometries: [...geometries].sort(), materials: [...materials].sort() };
      };
      const original = inventory();
      const passes = [];
      const velocity = { x: 0, z: -16 };
      let maximumZoom = 1, maximumPitch = 0;
      w.cameraManager.setMode('auto');
      // The deterministic RAF clock stays paused: no physics, particle, lighting
      // or debris updates can account for changes in this camera-only inventory.
      for (let pass = 0; pass < 3; pass++) {
        const peak = { calls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0 };
        for (const z of [-15, -65, -115, -160]) {
          const isInAir = z === -115;
          w.snowman.position.set(0, w.getTerrainHeight(0, z) + (isInAir ? 7 : 0), z);
          w.cameraManager.initialize(w.snowman.position, w.snowman.rotation, velocity);
          for (let frame = 0; frame < 180; frame++) {
            w.cameraManager.update(w.snowman.position, w.snowman.rotation, velocity, w.getTerrainHeight, {
              frameDt: 1 / 60, isInAir,
              treePositions: window.treePositions ?? [], rockPositions: window.rockPositions ?? [],
            });
            // Capture the entry trajectory and fully settled three-second Auto
            // view. Intermediate camera math needs no GPU submission: the wider
            // final framing must fit the budget as well as the first 20 frames.
            if (frame >= 20 && frame !== 179) continue;
            w.renderer.render(w.scene, w.camera);
            const info = w.renderer.info;
            peak.calls = Math.max(peak.calls, info.render.calls);
            peak.triangles = Math.max(peak.triangles, info.render.triangles);
            peak.geometries = Math.max(peak.geometries, info.memory.geometries);
            peak.textures = Math.max(peak.textures, info.memory.textures);
            peak.programs = Math.max(peak.programs, info.programs?.length ?? 0);
            maximumZoom = Math.max(maximumZoom, w.cameraManager.autoZoom);
            maximumPitch = Math.max(maximumPitch, w.cameraManager.autoPitch);
          }
        }
        w.renderer.getContext().finish();
        passes.push({ peak, inventory: inventory() });
      }
      return { original, passes, mode: w.cameraManager.mode, maximumZoom, maximumPitch };
    });
    expect(evidence.mode).toBe('auto');
    expect(evidence.maximumZoom, 'probe exercised adaptive zoom').toBeGreaterThan(1.1);
    expect(evidence.maximumPitch, 'probe exercised adaptive pitch').toBeGreaterThan(0.1);
    for (const pass of evidence.passes) {
      expectWithinBudget(pass.peak, AUTO_EZ_BUDGET);
      expect(pass.inventory, 'camera must retain the exact scene geometry/material identities').toEqual(evidence.original);
    }
    const residency = (peak: PerfInfo) => ({ geometries: peak.geometries, textures: peak.textures, programs: peak.programs });
    expect(residency(evidence.passes[1]!.peak), 'second sweep reuses first-sweep GPU residency').toEqual(residency(evidence.passes[0]!.peak));
    expect(residency(evidence.passes[2]!.peak), 'third sweep must not accumulate resources').toEqual(residency(evidence.passes[1]!.peak));
    console.log('[perf-budget:auto] frozen terrain sweeps:', JSON.stringify(evidence.passes.map(pass => pass.peak)));
    expect(errors).toEqual([]);
  });
});

// The startup ceilings above are retained as historical regression guards. This
// second tier exercises full player effects at fixed phases down the entire course,
// including late spray and crash resources. Timing is reported, never treated as
// machine-independent FPS. The frozen RAF clock makes phase state repeatable.
for (const [name, device] of Object.entries({
  desktop: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
  phone: { ...devices['Pixel 7'] }
})) {
  test.describe(`player rendering phases (${name}) @chromium`, () => {
    const { defaultBrowserType: _browserType, ...contextOptions } = device;
    test.use(contextOptions);
    test.skip(({ browserName }) => browserName !== 'chromium', 'renderer phase probes use Chromium');
    test('spawn, downhill, avalanche, spray and crash stay batched', async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const errors = await prepareRenderScenario(page);
      const metrics = [];
      for (const phase of RENDER_PHASES) {
        await enterRenderPhase(page, phase);
        const measured = await measureRenderPhase(page, phase);
        metrics.push(measured);
        assertRenderPhase(measured);
      }
      await testInfo.attach(`render-phases-${name}`, { body: Buffer.from(JSON.stringify(metrics, null, 2)), contentType: 'application/json' });
      console.log(`[render-phases:${name}]`, JSON.stringify(metrics));
      expect(errors, 'uncaught page/shader errors').toEqual([]);
    });
  });
}
