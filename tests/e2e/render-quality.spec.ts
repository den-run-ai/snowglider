import { PCFShadowMap } from 'three';
import { test, expect } from './fixtures';
import { gotoGame, startGame } from './helpers';

test.describe('render resolution and supported shadows', () => {
  const viewport = { width: 960, height: 640 };
  // DPR 1 would give both tiers the same framebuffer and miss a broken DPR cap.
  test.use({ viewport, deviceScaleFactor: 2 });
  test.skip(({ browserName }) => browserName !== 'chromium', 'real GPU resource checks use Chromium');
  for (const [quality, shadowSize, ratio] of [['high', 2048, 2], ['low', 512, 1]] as const) {
    test(`${quality} renders the requested framebuffer and shadow map`, async ({ page }) => {
      await gotoGame(page, `?eztrees=1&quality=${quality}`);
      await startGame(page);
      await page.waitForFunction((size) => {
        const w = window as unknown as {
          scene: import('three').Scene;
          renderer: import('three').WebGLRenderer;
        };
        const sun = w.scene.children.find(c => (c as import('three').DirectionalLight).isDirectionalLight) as import('three').DirectionalLight | undefined;
        return sun?.shadow.map?.width === size && w.renderer.info.render.calls > 0;
      }, shadowSize);
      const result = await page.evaluate(() => {
        const w = window as unknown as {
          scene: import('three').Scene;
          renderer: import('three').WebGLRenderer;
        };
        const r = w.renderer;
        const sun = w.scene.children.find(c => (c as import('three').DirectionalLight).isDirectionalLight) as import('three').DirectionalLight;
        const buffer = r.getDrawingBufferSize(sun.shadow.mapSize.clone());
        const gl = r.getContext();
        return {
          mode: r.domElement.dataset.renderQuality,
          ratio: r.getPixelRatio(),
          deviceRatio: window.devicePixelRatio,
          shadowType: r.shadowMap.type,
          buffer: { width: buffer.x, height: buffer.y },
          drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
        };
      });
      const expectedSize = { width: viewport.width * ratio, height: viewport.height * ratio };
      expect(result.mode).toBe(quality);
      expect(result.deviceRatio).toBe(2);
      expect(result.ratio).toBe(ratio);
      expect(result.buffer).toEqual(expectedSize);
      expect(result.drawingBuffer).toEqual(expectedSize);
      expect(result.shadowType).toBe(PCFShadowMap);
    });
  }
});
