import { test, expect } from './fixtures';
import type { Camera } from '../../src/camera.js';
import type * as THREE from 'three';
import {
  AUTO_REVIEW_PHASES, prepareRenderScenario, setAutoReviewFrame,
} from './render-scenarios';

test('Auto keeps the rider visible across changing grades, jumps and real obstacles', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await prepareRenderScenario(page);
  for (const phase of AUTO_REVIEW_PHASES) {
    const frame = await setAutoReviewFrame(page, phase);
    expect(frame.camera.every(Number.isFinite), `${phase}: finite camera`).toBe(true);
    expect(frame.clearance, `${phase}: terrain clearance`).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(Math.abs(frame.riderNdc[0]), `${phase}: rider stays in horizontal view`).toBeLessThan(1);
    expect(Math.abs(frame.riderNdc[1]), `${phase}: rider stays in vertical view`).toBeLessThan(1);
    expect(frame.riderNdc[2], `${phase}: rider stays in front of the camera`).toBeGreaterThan(-1);
    expect(frame.riderNdc[2]).toBeLessThan(1);
  }
  expect(errors).toEqual([]);
});

test('Auto framing follows travel when a ski pose changes yaw', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await prepareRenderScenario(page);
  await setAutoReviewFrame(page, 'auto-terrain');
  const displacement = await page.evaluate(() => {
    const w = window as unknown as Window & {
      cameraManager: Camera;
      snowman: THREE.Object3D;
      velocity: { x: number; z: number };
      getTerrainHeight: (x: number, z: number) => number;
    };
    const target = w.cameraManager.smoothingVectors.targetPosition.clone();
    w.snowman.rotation.y += Math.PI;
    w.cameraManager.update(w.snowman.position, w.snowman.rotation, w.velocity, w.getTerrainHeight, {
      frameDt: 1 / 60,
      treePositions: window.treePositions ?? [],
      rockPositions: window.rockPositions ?? [],
    });
    return target.distanceTo(w.cameraManager.smoothingVectors.targetPosition);
  });
  // A model-only pose flip used to swing the desired seat to the opposite side
  // of the rider, even though the skier still travelled in exactly the same line.
  expect(displacement, 'pose-only yaw must not orbit the Auto seat').toBeLessThan(0.1);
  expect(errors).toEqual([]);
});
