// Rock review gallery (rock realism recovery PR 1, issue #385).
//
// A review harness, not a game feature: `?gallery=rocks` boots the REAL scene
// pipeline (renderer, lights, terrain, sky — via the same `setupScene()` the game
// runs) and lays the fixed rock samples from rock-gallery-samples.ts out on the
// actual slope, so screenshots judge the rocks under the exact materials, lighting,
// fog, and snow terrain the player sees — the #344 lesson that a disconnected
// render path (or the automation-fallback scene, #336) misrepresents the game.
//
// The samples are the SAME {kind, size, seed} set the headless metrics harness
// (tests/rock-visual-metrics-tests.js) gates on, and each rock is built with the
// global Math.random stream pinned to the harness's mulberry32(1234), so what the
// gallery renders is byte-for-byte the geometry the CI numbers describe.
//
// Loaded ONLY through main.ts's `?gallery=rocks` branch (it replaces the deferred
// orchestrator import, so the game itself never boots on a gallery page). Never
// imported by game code; ships in its own lazy chunk.

import * as THREE from 'three';
import { setupScene } from '../game/scene-setup.js';
import { createRock } from '../mountains/rocks.js';
import { getTerrainHeight, getTerrainGradient } from '../mountains/terrain.js';
import { Sky } from '../sky.js';
import { ROCK_GALLERY_SAMPLES } from './rock-gallery-samples.js';

// Must match the pinned stream in tests/rock-visual-metrics-tests.js buildSample().
const PINNED_STREAM_SEED = 1234;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Row layout on the real slope, downhill of the spawn pocket: one row per kind,
// four samples per row. The slope drops toward −z, so the camera sits uphill
// (+z of the rows) looking down — rocks read against snow, trees, and the sky
// horizon exactly as in play.
const ROW_Z: Record<string, number> = { boulder: -36, cliff: -48, pinch: -62 };
const SLOT_X = [-12, -4, 4, 12];

/** Boot the gallery page. Returns the window handle it publishes (for tests). */
export function initRockGallery(): NonNullable<Window['__rockGallery']> {
  const { scene, renderer, camera } = setupScene();

  // Review page: hide every DOM overlay (start menu, HUD, auth) and show the canvas.
  const style = document.createElement('style');
  style.textContent =
    'body > :not(#gameCanvas) { display: none !important; } ' +
    '#gameCanvas { display: block !important; }';
  document.head.appendChild(style);

  // --- Place the sample rocks -----------------------------------------------------
  // Build with the global stream pinned so each rock is byte-identical to the
  // metrics-harness sample with the same id (jitter + base colour ride the global
  // stream; only the scrape pass is seeded). The scene is fully built by now and no
  // game loop runs on a gallery page, so the swap is not on any seeded path.
  const galleryGroup = new THREE.Group();
  galleryGroup.name = 'rockGallery';
  const realRandom = Math.random;
  const slotCounters: Record<string, number> = {};
  for (const sample of ROCK_GALLERY_SAMPLES) {
    const slot = slotCounters[sample.kind] ?? 0;
    slotCounters[sample.kind] = slot + 1;
    const x = SLOT_X[slot]!;
    const z = ROW_Z[sample.kind]!;

    Math.random = mulberry32(PINNED_STREAM_SEED);
    let rock: THREE.Mesh;
    try {
      rock = createRock(sample.size, { cliff: sample.kind !== 'boulder', seed: sample.seed });
    } finally {
      Math.random = realRandom;
    }

    // Same grounding transform addRocks applies: sink into the terrain and align to
    // the local slope. Yaw comes from a per-sample seeded stream (addRocks draws it
    // from global Math.random; the gallery must be reproducible frame-to-frame).
    const h = getTerrainHeight(x, z);
    const sink = sample.kind === 'boulder' ? 0.3 : 0.28;
    rock.position.set(x, h - sample.size * sink, z);
    rock.rotation.y = mulberry32(sample.seed ^ 0x51ab)() * Math.PI * 2;
    const g = getTerrainGradient(x, z);
    rock.rotation.x = Math.atan(g.z) * 0.8;
    rock.rotation.z = -Math.atan(g.x) * 0.8;
    rock.userData.gallerySampleId = sample.id;
    galleryGroup.add(rock);
  }
  scene.add(galleryGroup);

  // --- Frame the rows --------------------------------------------------------------
  // Uphill of the first row, high enough to clear the slope, looking at the rows'
  // centroid. The perspective keeps all three rows and the horizon in frame.
  const setView = (view: 'overview' | 'boulder' | 'cliff' | 'pinch'): void => {
    if (view === 'overview') {
      const centerZ = (ROW_Z.boulder! + ROW_Z.pinch!) / 2;
      const camZ = ROW_Z.boulder! + 17;
      camera.position.set(0, getTerrainHeight(0, camZ) + 8.5, camZ);
      camera.lookAt(new THREE.Vector3(0, getTerrainHeight(0, centerZ) + 1.5, centerZ));
      return;
    }
    // Row close-up: low and near, so side faces and snow shelves are readable.
    const rowZ = ROW_Z[view]!;
    const camZ = rowZ + 11;
    camera.position.set(2, getTerrainHeight(2, camZ) + 4.5, camZ);
    camera.lookAt(new THREE.Vector3(0, getTerrainHeight(0, rowZ) + 1.2, rowZ));
  };
  setView('overview');

  const render = (): void => {
    renderer.render(scene, camera);
  };

  // --- Capture API for the puppeteer runner ---------------------------------------
  let phase: 'midday' | 'golden' = 'midday';
  const handle: NonNullable<Window['__rockGallery']> = {
    ready: true,
    samples: galleryGroup.children.length,
    /** Set the sun-cycle phase. Golden hour = Sky.update(45): halfway through the
     *  90 s cycle, where shading differences are most visible. One-way (the cycle
     *  only advances), so the runner captures midday first. */
    setPhase(next: 'midday' | 'golden'): string {
      if (next === 'golden' && phase === 'midday') {
        Sky.update(Sky.CYCLE_DURATION_S / 2);
        phase = 'golden';
      }
      render();
      return phase;
    },
    /** Aim the camera: the 3-row overview or a single-row close-up. */
    setView(view: 'overview' | 'boulder' | 'cliff' | 'pinch'): void {
      setView(view);
      render();
    },
    /** NDC projection of every sample rock through the CURRENT camera — lets the
     *  runner assert the row it's capturing is actually in frame (#336: never save
     *  a shot of the wrong thing). */
    projections(): Array<{ id: string; ndcX: number; ndcY: number; inFrame: boolean }> {
      camera.updateMatrixWorld();
      return galleryGroup.children.map((rock) => {
        const p = rock.getWorldPosition(new THREE.Vector3()).project(camera);
        return {
          id: String(rock.userData.gallerySampleId),
          ndcX: p.x,
          ndcY: p.y,
          inFrame: Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1,
        };
      });
    },
    /** Render one frame and read it back in the same tick (the share-card trick —
     *  the back buffer is still valid, no preserveDrawingBuffer needed). */
    capture(): string {
      render();
      return renderer.domElement.toDataURL('image/png');
    },
    /** Real-path assertions for the runner (#336): the gallery rocks must be
     *  attached and, when the EZ forest is requested, its instanced branches must
     *  actually be in the scene — otherwise the capture shows the automation
     *  fallback and misrepresents the game. */
    stats(): Record<string, unknown> {
      return {
        galleryRocks: galleryGroup.children.length,
        sceneRocks: scene.children.filter((c) => c.userData.isRock === true).length,
        ezBranchesAttached: scene.children.some((c) => c.userData.forestPart === 'ezBranches'),
        isTestMode: window.isTestMode === true,
        webdriver: navigator.webdriver === true,
        phase,
      };
    },
  };
  window.__rockGallery = handle;
  render();
  console.log(`Rock gallery ready: ${handle.samples} samples across 3 rows`);
  return handle;
}
