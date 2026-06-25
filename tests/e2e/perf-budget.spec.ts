import { test, expect } from './fixtures';
import { gotoGame, startGame } from './helpers';

// Plan §1A — performance / draw-call budget. Nothing in the repo asserts on
// `renderer.info` today (grep confirms zero usages in src or tests), so an
// un-instanced-tree-style regression (draw calls / geometry blowup) ships silently.
// This is the cheapest high-value rendering category: boot the REAL game, let the
// loop render a few warm frames, then read renderer.info off the test-only seam
// (publishGameGlobals in src/snowglider.ts) and pin ceilings just above the
// measured values — a regression guard, not an aspirational target.
//
// Chromium-only on purpose: renderer.info is GPU/driver-dependent and the numbers
// aren't comparable across WebKit/mobile, so comparing them there would add noise
// without value. WebKit/mobile keep owning the user-flow + touch specs.

// --- Budget ceilings -------------------------------------------------------
// Measured on Chromium (warm frame, 1280x720 viewport): calls 1783, triangles
// ~105k, geometries 111, textures 11, programs 13. These are scene-dependent (the
// same geometry the production bundle builds), not GPU/driver-dependent, so they
// hold across Chromium builds. Ceilings are padded above those actuals as a
// REGRESSION GUARD, not an aspirational target. Trees are still a Group-of-Mesh
// per tree today (NOT InstancedMesh — src/mountains/trees.ts), so draw-call count
// is inherently high; these pin "no worse than today" and tighten automatically
// if instancing lands.
//
// calls/triangles are LOOSE catastrophe ceilings: frustum culling AND the
// per-frame shadow-map pass make them swing frame-to-frame (measured peak ~2700
// calls vs ~1800 steady), so a tight pin would flake. They still catch a
// catastrophic blowup (losing geometry pooling / instancing would multiply trees
// per-instance, easily 2x+). The TIGHT regression guards are
// geometries/textures/programs — trees.ts pools shared trunk/cone/branch
// geometries+materials, so those live counts must NOT grow per object; a
// regression back to per-tree geometry would push `geometries` from ~110 into the
// hundreds, which the tight pin flags.
const BUDGET = {
  calls: 3500, // draw calls per frame (measured peak ~2700; loose catastrophe ceiling)
  triangles: 350_000, // rasterized triangles per frame (measured peak ~125k; loose)
  geometries: 130, // live BufferGeometry count (measured ~111; TIGHT — pooled, must stay bounded)
  textures: 25, // live texture count (measured 11; TIGHT)
  programs: 25, // compiled shader programs (measured 13; TIGHT — catches shader-compile blowups)
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

test.describe('rendering perf / draw-call budget @chromium', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'perf numbers are Chromium-only');

  test('renderer.info stays within the draw-call / geometry budget', async ({ page }) => {
    // Seed Math.random BEFORE any game script runs so the forest produced by
    // Trees.addTrees/createTree (tree count, branch count, placement, snow patches)
    // is identical on every CI run. Without this the production random layout varies
    // the mesh/triangle count run to run, so the calls/triangles ceilings — calibrated
    // from one measured scene — could red-bar an unrelated PR on a denser draw. A
    // deterministic layout makes the budget a real regression guard. addInitScript runs
    // in the page realm before the bundle's first Math.random call.
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
    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoGame(page);
    await startGame(page);

    // Let the running loop render warm frames, then sample renderer.info across
    // several of them and take the per-metric MAX. renderer.info reflects the LAST
    // rendered frame, and frustum culling makes draw-calls/triangles vary frame to
    // frame as the snowman moves, so a single arbitrary frame is flaky — the max
    // over a window is the representative worst case and is what the budget guards.
    await page.waitForFunction(() => !!(window as RendererWindow).renderer);
    const samples: PerfInfo[] = [];
    for (let i = 0; i < 12; i++) {
      const s: PerfInfo | null = await page.evaluate(
        () =>
          new Promise((resolve) => {
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
          }),
      );
      if (s) samples.push(s);
    }

    expect(samples.length, 'renderer seam did not publish renderer.info').toBeGreaterThan(0);
    const peak: PerfInfo = {
      calls: Math.max(...samples.map((s) => s.calls)),
      triangles: Math.max(...samples.map((s) => s.triangles)),
      geometries: Math.max(...samples.map((s) => s.geometries)),
      textures: Math.max(...samples.map((s) => s.textures)),
      programs: Math.max(...samples.map((s) => s.programs)),
    };
    // Surface the live peak in the test output so threshold drift is auditable.
    console.log('[perf-budget] renderer.info peak over', samples.length, 'frames:', JSON.stringify(peak));

    expect(peak.calls, 'draw calls per frame').toBeGreaterThan(0);
    expect(peak.calls, 'draw calls per frame').toBeLessThanOrEqual(BUDGET.calls);
    expect(peak.triangles, 'triangles per frame').toBeLessThanOrEqual(BUDGET.triangles);
    // Tight pin: the shared geometry cache means this must not grow per object.
    expect(peak.geometries, 'live BufferGeometry count').toBeLessThanOrEqual(BUDGET.geometries);
    expect(peak.textures, 'live texture count').toBeLessThanOrEqual(BUDGET.textures);
    expect(peak.programs, 'compiled shader programs').toBeLessThanOrEqual(BUDGET.programs);
  });
});
