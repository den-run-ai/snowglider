import { test, expect } from './fixtures';
import { gotoGame, startGame } from './helpers';

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
// Geometry headroom accounts for the measured chunk wrappers plus unbatched rocks;
// draw, triangle, texture and program ceilings retain the pre-chunk guards.
const BUDGET = {
  calls: 800, // instancing must keep this well below a per-tree mesh scene
  triangles: 350_000, // color and shadow triangles vary with the player camera
  geometries: 230, // measured 212–228 resident wrappers before rock batching
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
// 265 geometries / 17 textures / 43 programs. The 280-wrapper cap leaves 15 of
// headroom without changing the draw, triangle, texture or shader limits.
const EZ_BUDGET = {
  calls: 800, // parity with the stylized budget — instancing must hold here too
  triangles: 600_000, // needle cards remain bounded after spatial culling
  geometries: 280, // measured 265 resident wrappers before rock batching
  textures: 30, // + needle sprite & co. over the stylized measured ~11
  // Background scenery system (issue #320) adds a handful of shared instanced-basic-fog
  // program variants; the ambient-life layer tipped the EZ peak to 41 (its clouds/birds/
  // spindrift share ONE FrontSide basic+fog program — see ambient-life.ts). The snow-depth
  // terrain program (#246 PR 3) then adds one more, to 42. Still TIGHT: a per-archetype/
  // -object shader regression would blow this into the dozens, well past 43.
  programs: 43, // measured peak 42 (41 scenery stack + 1 snow-depth terrain program)
};

/** Seed Math.random BEFORE any game script runs so the forest layout (tree count,
 *  placement, snow patches) is identical on every CI run. Without this the random
 *  layout varies the mesh/triangle count run to run, so ceilings calibrated from
 *  one measured scene could red-bar an unrelated PR on a denser draw. addInitScript
 *  runs in the page realm before the bundle's first Math.random call. */
function seedDeterministicLayout(page: import('@playwright/test').Page): Promise<void> {
  return page.addInitScript(() => {
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
});
