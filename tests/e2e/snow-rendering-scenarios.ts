import type { Page } from '@playwright/test';
import type * as THREE from 'three';
import type { SceneContext } from '../../src/game/scene-setup.js';
import type { PlayerState } from '../../src/player-state.js';

export const SNOW_PHASES = ['midday', 'golden'] as const;
export type SnowPhase = typeof SNOW_PHASES[number];
type SnowWindow = Window &
  Pick<SceneContext, 'scene' | 'renderer' | 'camera' | 'cameraManager' | 'snowman'> &
  Pick<PlayerState, 'pos' | 'velocity'> & {
    terrainMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    getTerrainHeight: typeof import('../../src/snow.js').Snow.getTerrainHeight;
  };

/** Call immediately after prepareRenderScenario, before advancing its RAF clock.
 * Start's zero-delta frame leaves the captured production sun at exact midday.
 * The same fixed player/camera pose is used at both sun endpoints. */
export async function prepareSnowFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as SnowWindow;
    w.pos.x = 0;
    w.pos.z = -35;
    w.pos.y = w.getTerrainHeight(w.pos.x, w.pos.z);
    w.velocity.x = 0;
    w.velocity.z = -3;
    w.snowman.position.copy(w.pos);
    w.cameraManager.initialize(w.snowman.position, w.snowman.rotation, w.velocity);
  });
}

/** Ordered midday -> golden progression through the production cycle; no manual
 * substitute light colors or intensities and no gameplay/RAF steps between shots. */
export async function enterSnowPhase(page: Page, phase: SnowPhase): Promise<void> {
  await page.evaluate(async phase => {
    const w = window as unknown as SnowWindow;
    const skyPath = '/src/sky.ts';
    const shadowPath = '/src/game/sun-shadow.ts';
    const { Sky } = await import(/* @vite-ignore */ skyPath) as typeof import('../../src/sky.js');
    const shadow = await import(/* @vite-ignore */ shadowPath) as typeof import('../../src/game/sun-shadow.js');
    if (phase === 'golden') Sky.update(Sky.CYCLE_DURATION_S / 2);
    const sun = w.scene.children.find(object => (object as THREE.DirectionalLight).isDirectionalLight) as THREE.DirectionalLight | undefined;
    if (!sun) throw new Error('Snow review requires the production directional light');
    const direction = Sky.getSunDirection();
    shadow.aimSunLight(sun, direction, Sky.getSunDistance(), w.pos.x, w.pos.y, w.pos.z);
    shadow.compensateShadowBiasForElevation(sun, direction.y, Sky.getMiddaySunElevationSin());
    w.renderer.render(w.scene, w.camera);
  }, phase);
}

/** GPU measurements of the real terrain geometry, textures, vertex colors and
 * material under cloned production lights. Fog and obstacle shadows are omitted
 * only in this diagnostic target so white sky/props cannot hide snow clipping.
 * The separately captured player image retains the complete production scene. */
export async function measureSnowSurface(page: Page) {
  return page.evaluate(async () => {
    const w = window as unknown as SnowWindow;
    const threePath = '/node_modules/three/build/three.module.js';
    const T = await import(/* @vite-ignore */ threePath) as typeof import('three');
    const scene = new T.Scene();
    const terrain = new T.Mesh(w.terrainMesh.geometry, w.terrainMesh.material);
    terrain.matrix.copy(w.terrainMesh.matrix);
    terrain.matrixAutoUpdate = false;
    scene.add(terrain);
    let sun: THREE.DirectionalLight | undefined;
    for (const object of w.scene.children) {
      if (!(object as THREE.Light).isLight) continue;
      const light = (object as THREE.Light).clone();
      scene.add(light);
      if ((light as THREE.DirectionalLight).isDirectionalLight) {
        sun = light as THREE.DirectionalLight;
        sun.castShadow = false;
        scene.add(sun.target);
      }
    }
    if (!sun) throw new Error('Snow probe requires the production sun');
    const camera = new T.OrthographicCamera(-48, 48, 50, -50, 0.1, 500);
    camera.position.set(0, 200, -60);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, -60);
    const size = 256;
    const target = new T.WebGLRenderTarget(size, size, { depthBuffer: true });
    target.texture.colorSpace = w.renderer.outputColorSpace;
    const previousTarget = w.renderer.getRenderTarget();
    const previousColor = w.renderer.getClearColor(new T.Color());
    const previousAlpha = w.renderer.getClearAlpha();
    const pixels = new Uint8Array(size * size * 4);
    function read() {
      w.renderer.render(scene, camera);
      w.renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      const luma: number[] = [];
      let clipped = 0, red = 0, green = 0, blue = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3]! < 250) continue;
        const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
        if (Math.max(r, g, b) >= 250) clipped++;
        red += r; green += g; blue += b;
        luma.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      }
      luma.sort((a, b) => a - b);
      const count = luma.length;
      return { count, clippedFraction: clipped / count,
        p10: luma[Math.floor(count * 0.1)]!, median: luma[Math.floor(count * 0.5)]!,
        p90: luma[Math.floor(count * 0.9)]!,
        red: red / count, green: green / count, blue: blue / count };
    }
    try {
      w.renderer.setRenderTarget(target);
      w.renderer.setClearColor(0x000000, 0);
      const lit = read();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      const image = ctx.createImageData(size, size);
      for (let row = 0; row < size; row++) {
        image.data.set(pixels.subarray(row * size * 4, (row + 1) * size * 4), (size - 1 - row) * size * 4);
      }
      ctx.putImageData(image, 0, 0);
      const imageBase64 = canvas.toDataURL('image/png').split(',')[1]!;
      sun.intensity = 0;
      const shade = read();
      return { lit, shade, imageBase64 };
    } finally {
      w.renderer.setRenderTarget(previousTarget);
      w.renderer.setClearColor(previousColor, previousAlpha);
      target.dispose();
      // Geometry/material are borrowed from the live terrain: never dispose them.
      w.renderer.render(w.scene, w.camera);
    }
  });
}
