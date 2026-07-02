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
// Measured on Chromium (warm frame, 1280x720 viewport, deterministic forest seed):
// calls ~236, triangles ~187k, geometries ~150, textures 13, programs 23. These are
// scene-dependent (the same geometry the production bundle builds), not
// GPU/driver-dependent, so they hold across Chromium builds. Ceilings are padded
// above those actuals as a REGRESSION GUARD, not an aspirational target.
//
// The forest is now InstancedMesh (src/mountains/trees.ts): the whole forest draws
// as up to 6 InstancedMeshes (~6 colour + ~6 shadow draws) instead of a Group-of-~20-meshes
// PER tree, which collapsed draw calls from ~2700 peak to ~252. So `calls` is now a
// TIGHT regression guard: a revert to per-tree meshes would push it back into the
// thousands, which the 800 ceiling flags immediately (was a loose 3500 when trees
// were un-instanced).
//
// `triangles` stays a LOOSE ceiling: a forest-wide InstancedMesh has a huge bounding
// sphere and effectively never frustum-culls, so every tree instance is always
// rasterized (the documented instancing tradeoff — see trees.ts buildForest /
// avalanche.ts:88). That raised triangles from ~125k (per-tree, culled) to ~176k,
// still a small fraction of the rasterizer budget; the shadow pass also makes it
// swing frame-to-frame, so a tight pin would flake. The other TIGHT guards are
// geometries/textures/programs — trees.ts pools shared trunk/cone/branch
// geometries+materials, so those live counts must NOT grow per object; a regression
// back to per-tree geometry would push `geometries` into the hundreds.
//
// Player-following sun shadow (#18) raised the resident-geometry + draw-call peaks.
// Before, the directional light's shadow frustum was three.js's default ±5 box at the
// world origin, so the shadow pass rendered essentially nothing (the player spawns at
// z=-15, outside it) and only camera-visible geometry was ever uploaded. Now the
// frustum follows the player (game/sun-shadow.ts), so the shadow pass renders the
// surrounding casters — trees/rocks/snow-patches that already set `castShadow` — making
// their geometry resident immediately and adding one shadow draw per caster batch. That
// moved `geometries` from ~86 to ~155 (peak) and `calls` from ~252 to ~273. The richer
// tree pass now measures ~150 geometries and ~236 calls with the same guard. `geometries`
// stays a TIGHT guard at 185: the forest geometry is still pooled, so a per-tree-mesh
// regression would blow it into the hundreds and red-bar well under 185.
const BUDGET = {
  calls: 800, // draw calls per frame (measured peak ~273; TIGHT — instancing must hold)
  triangles: 350_000, // rasterized triangles per frame (measured peak ~183k; loose — forest never culls)
  geometries: 185, // live BufferGeometry count (measured peak ~155 with the #18 shadow pass; TIGHT — pooled, must stay bounded)
  textures: 25, // live texture count (measured 11; TIGHT)
  programs: 25, // compiled shader programs (measured 16; TIGHT — catches shader-compile blowups)
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
