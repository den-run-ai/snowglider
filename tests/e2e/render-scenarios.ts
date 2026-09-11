import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type * as THREE from 'three';
import type { GameState, SceneContext } from '../../src/game/scene-setup.js';
import type { PlayerState } from '../../src/player-state.js';
import resultContract from '../helpers/browser-results.js';

export const RENDER_PHASES = ['spawn', 'downhill', 'avalanche', 'spray', 'crash'] as const;
export type RenderPhase = typeof RENDER_PHASES[number];
export const REVIEW_SEED = 0x531060d5;

// Derive the published scene/player handles from their checked producers, so
// particle and SDK contracts keep following the application after upgrades.
type RenderWindow = Window &
  Pick<SceneContext, 'scene' | 'renderer' | 'camera' | 'cameraManager' | 'snowman' | 'snowSplash'> &
  Pick<PlayerState, 'pos' | 'velocity'> &
  Pick<GameState, 'avalanche' | 'avalancheTriggered' | 'gameActive'> &
  Required<Pick<Window, 'showGameOver'>> & {
    getTerrainHeight: typeof import('../../src/snow.js').Snow.getTerrainHeight;
    getControls: typeof import('../../src/controls.js').Controls.getControls;
    testHooks: Required<Pick<NonNullable<Window['testHooks']>, 'isDebrisActive'>>;
    __renderClock: { step: () => { cpuMs: number; synchronizedMs: number } };
  };

export type PhaseMetrics = {
  phase: RenderPhase;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  frameCpuMs: { p50: number; p95: number };
  synchronizedFrameMs: { p50: number; p95: number };
  state: {
    position: { x: number; y: number; z: number };
    activeSpray: number;
    powder: number;
    avalanche: boolean;
    debris: boolean;
    forestMeshes: number;
    forestChunks: number;
    snowBatches: number;
    snowInstances: number;
    snowCapacity: number;
    attachedSpraySprites: number;
    finite: boolean;
  };
};

/** The game constructs the full player scene. The intro is skipped and Web Audio
 * is disabled; a practice seed avoids leaderboard writes. RAF then advances at exact
 * 1/60 steps independent of the CI machine. Native timers still boot the app.
 * These are prescribed phase replays, not a claim that an autonomous skier won. */
export async function prepareRenderScenario(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (resultContract.isRendererFailure(message.text())) errors.push(message.text());
  });
  await page.addInitScript(() => {
    // Muting only changes gain: Sfx.unlock still builds a noise buffer using the
    // global RNG also consumed by crash debris. Disable both constructors before
    // boot so audio-only changes cannot alter rendering comparison fixtures.
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      Object.defineProperty(window, name, { configurable: true, value: undefined });
    }
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    localStorage.setItem('snowgliderMuted', 'true');
    let seed = 0x9e3779b9;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`/index.html?eztrees=1&intro=off&quality=high&seed=${REVIEW_SEED}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const w = window as unknown as RenderWindow;
    let ready = false;
    w.scene?.traverse(object => {
      const data: Record<string, unknown> = object.userData;
      if (data.forestPart === 'ezBranches') ready = true;
    });
    return ready && typeof window.initializeGameWithAudio === 'function';
  }, undefined, { timeout: 30_000 });

  await page.evaluate(() => {
    const w = window as unknown as RenderWindow;
    const nativeNow = performance.now.bind(performance);
    const nativeCancel = cancelAnimationFrame.bind(window);
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    let time = 1000;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => time });
    window.requestAnimationFrame = callback => {
      callbacks.set(--nextId, callback);
      return nextId;
    };
    window.cancelAnimationFrame = id => { if (id < 0) callbacks.delete(id); else nativeCancel(id); };
    w.__renderClock = {
      step() {
        const pending = [...callbacks.values()];
        callbacks.clear();
        if (!pending.length) throw new Error('No game/debris frame is scheduled');
        time += 1000 / 60;
        const started = nativeNow();
        for (const callback of pending) callback(time);
        const cpuMs = nativeNow() - started;
        // Diagnostic service time, not FPS: finish includes queued GPU work and
        // deliberately serializes the frame. Neither timing metric is a gate.
        w.renderer.getContext().finish();
        return { cpuMs, synchronizedMs: nativeNow() - started };
      }
    };
    // Actionability checks need live RAF; this is a rendering scenario, so invoke
    // the real Start button handler directly once the deterministic clock owns RAF.
    document.getElementById('startGameButton')!.click();
  });
  await page.waitForFunction(() => (window as unknown as RenderWindow).gameActive === true, undefined, { polling: 100, timeout: 30_000 });
  expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
  return errors;
}

export async function enterRenderPhase(page: Page, phase: RenderPhase): Promise<void> {
  await page.evaluate(phase => {
    const w = window as unknown as RenderWindow;
    if (phase === 'crash') {
      w.showGameOver('You hit a tree!');
    } else {
      // Blue's cleared corridor is centered on x=0. Short real physics windows
      // follow each prescribed position; collisions and particle emission stay on.
      const z = { spawn: -15, downhill: -65, avalanche: -115, spray: -160 }[phase];
      w.pos.x = 0;
      w.pos.z = z;
      w.pos.y = w.getTerrainHeight(0, z);
      w.velocity.x = phase === 'spray' ? 2 : 0;
      w.velocity.z = phase === 'spawn' ? -3 : -9;
      w.snowman.position.set(w.pos.x, w.pos.y, w.pos.z);
      w.cameraManager.initialize(w.snowman.position, w.snowman.rotation, w.velocity);
      Object.assign(w.getControls(), { up: true, down: false, left: false, right: phase === 'spray', jump: false });
      if (phase === 'avalanche') {
        if (!w.avalanche) throw new Error('Render scenario requires the live avalanche system');
        w.avalanche.trigger(w.pos);
        w.avalancheTriggered = true;
      }
    }
    // Keep the fixed settling window in the page. One automation round trip per
    // frame accumulated seconds of overhead under covered/parallel CI despite
    // the controlled frame itself completing in milliseconds (PR #447 traces).
    // The clock still executes every physics/camera/effects/render callback and
    // GPU finish; crash debris gets the same eight settling frames too.
    for (let i = 0; i < 8; i++) w.__renderClock.step();
  }, phase);
}

export async function measureRenderPhase(page: Page, phase: RenderPhase): Promise<PhaseMetrics> {
  // Sample all twelve controlled frames and their final state in one evaluation.
  // This removes runner/trace/coverage round trips, not rendered frames or checks.
  const { samples, state } = await page.evaluate(() => {
    const w = window as unknown as RenderWindow;
    if (!w.avalanche) throw new Error('Render scenario requires the live avalanche system');
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const timing = w.__renderClock.step();
      const info = w.renderer.info;
      samples.push({ ...timing, calls: info.render.calls, triangles: info.render.triangles,
        geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length || 0 });
    }
    let forestMeshes = 0, snowBatches = 0, snowInstances = 0, snowCapacity = 0;
    let finite = Object.values(w.pos).every(Number.isFinite);
    const chunks = new Set<string>();
    w.scene.traverse(object => {
      if (object.name === 'forestInstanced') {
        forestMeshes++;
        const data: Record<string, unknown> = object.userData;
        if (typeof data.forestChunk === 'string') chunks.add(data.forestChunk);
      }
      if (object.name === 'snowBillboards') {
        snowBatches++;
        const geometry = (object as THREE.Mesh<THREE.InstancedBufferGeometry>).geometry;
        snowInstances += geometry.instanceCount;
        snowCapacity += geometry.getAttribute('aParticlePosition').count;
        for (const attribute of Object.values(geometry.attributes)) {
          finite &&= Array.from(attribute.array).every(Number.isFinite);
        }
      }
      finite &&= object.matrixWorld.elements.every(Number.isFinite);
    });
    const state = {
      position: { ...w.pos }, activeSpray: w.snowSplash.particles.filter(p => p.userData.active).length,
      powder: w.avalanche.powder.filter(p => p.visible).length, avalanche: w.avalanche.active,
      debris: w.testHooks.isDebrisActive(), forestMeshes, forestChunks: chunks.size,
      snowBatches, snowInstances, snowCapacity, attachedSpraySprites: w.snowSplash.particles.filter(p => !!p.parent).length, finite
    };
    return { samples, state };
  });
  const peak = (key: 'calls' | 'triangles' | 'geometries' | 'textures' | 'programs') => Math.max(...samples.map(s => s[key]));
  const quantiles = (key: 'cpuMs' | 'synchronizedMs') => {
    const values = samples.map(s => s[key]).sort((a, b) => a - b);
    return { p50: values[Math.ceil(values.length * .5) - 1]!, p95: values[Math.ceil(values.length * .95) - 1]! };
  };
  return { phase, calls: peak('calls'), triangles: peak('triangles'), geometries: peak('geometries'),
    textures: peak('textures'), programs: peak('programs'), frameCpuMs: quantiles('cpuMs'),
    synchronizedFrameMs: quantiles('synchronizedMs'), state };
}

export function assertRenderPhase(metrics: PhaseMetrics, strictStructure = true): void {
  for (const key of ['calls', 'triangles', 'geometries', 'textures', 'programs'] as const) {
    expect(Number.isFinite(metrics[key]) && metrics[key] >= 0, `${metrics.phase}: finite ${key}`).toBe(true);
  }
  expect(metrics.calls, `${metrics.phase}: a real frame rendered`).toBeGreaterThan(0);
  expect(metrics.triangles).toBeGreaterThan(0);
  expect(metrics.state.finite, `${metrics.phase}: finite scene transforms`).toBe(true);
  for (const time of [metrics.frameCpuMs.p50, metrics.frameCpuMs.p95, metrics.synchronizedFrameMs.p50, metrics.synchronizedFrameMs.p95]) {
    expect(Number.isFinite(time) && time >= 0, 'valid timing observation').toBe(true);
  }
  if (metrics.phase === 'avalanche') {
    expect(metrics.state.avalanche).toBe(true);
    expect(metrics.state.powder).toBeGreaterThan(0);
  }
  if (metrics.phase === 'spray') expect(metrics.state.activeSpray).toBeGreaterThan(0);
  if (metrics.phase === 'crash') expect(metrics.state.debris).toBe(true);
  if (strictStructure) {
    expect(metrics.state.snowBatches, 'one shared snow-effects batch').toBe(1);
    expect(metrics.state.snowCapacity, '1000 flakes + 250 spray + 260 avalanche + 18 shed').toBe(1528);
    expect(metrics.state.snowInstances, 'live snow instances must render').toBeGreaterThan(0);
    expect(metrics.state.snowInstances).toBeLessThanOrEqual(metrics.state.snowCapacity);
    expect(metrics.state.attachedSpraySprites, 'spray must not regress to individual Sprite draws').toBe(0);
    expect(metrics.state.forestChunks, 'forest must remain spatially partitioned').toBeGreaterThan(1);
  }
}

/** Exact WebGL canvas capture: a fresh render and readback in the same JS turn.
 * It intentionally excludes HTML overlays so a crash image actually shows debris. */
export async function captureRenderCanvas(page: Page): Promise<Buffer> {
  const png = await page.evaluate(() => {
    const w = window as unknown as RenderWindow;
    w.renderer.render(w.scene, w.camera);
    return w.renderer.domElement.toDataURL('image/png').split(',')[1]!;
  });
  return Buffer.from(png, 'base64');
}

export async function setObstructedOrbitFrame(page: Page, update: 0 | 1 | 2): Promise<{ phase: string; clearance: number; camera: number[] }> {
  return page.evaluate(update => {
    const w = window as unknown as RenderWindow;
    if (update === 0) {
      window.resetSnowman!();
      w.pos.x = 0;
      w.pos.z = -80;
      w.pos.y = w.getTerrainHeight(0, -80);
      w.velocity.x = 0;
      w.velocity.z = -9;
      w.snowman.position.set(w.pos.x, w.pos.y, w.pos.z);
      w.snowman.rotation.set(0, Math.PI, 0);
      w.cameraManager.setMode('orbit');
      w.cameraManager.setOrbitYaw(Math.PI);
      w.cameraManager.orbitPitch = 0;
      w.cameraManager.zoom = 2.5;
      w.cameraManager.initialize(w.snowman.position, w.snowman.rotation, w.velocity);
    } else {
      // No physics/cosmetic step between these captures: same avatar and world,
      // only the camera entry path differs. Captures the #434 first-frame repro.
      w.cameraManager.update(w.snowman.position, w.snowman.rotation, w.velocity, w.getTerrainHeight, { frameDt: 1 / 60 });
    }
    return {
      phase: ['orbit-entry', 'orbit-first-update', 'orbit-second-update'][update]!,
      clearance: w.camera.position.y - w.getTerrainHeight(w.camera.position.x, w.camera.position.z),
      camera: w.camera.position.toArray()
    };
  }, update);
}
