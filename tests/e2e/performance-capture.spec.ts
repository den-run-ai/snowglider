import { readFile } from 'node:fs/promises';
import type { Locator } from '@playwright/test';
import type { PerformanceCapture } from '../../src/performance-capture.js';
import { test, expect } from './fixtures';
import { gotoGame, mockFirebase, startGame } from './helpers';

type Report = ReturnType<PerformanceCapture['snapshot']>;
async function activate(button: Locator, touch: boolean): Promise<void> {
  if (touch) await button.tap(); else await button.click();
}

test('debug capture exports live frames across a restart using touch-safe controls', async ({ page, hasTouch, baseURL }, testInfo) => {
  // This functional capture needs real frames on both sides of a native Reset.
  // Isolated software-GL Chromium can consume 60s before that second sample;
  // allow the full flow without changing frames, controls, scene or assertions.
  // Renderer budgets and physical-device performance acceptance are separate.
  test.setTimeout(180_000);
  await mockFirebase(page, baseURL);
  // Exercise the real player diagnostics/forest path, not the automation fallback.
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  await gotoGame(page, '?debug&eztrees=1&intro=off');
  await page.waitForFunction(() => window.terrainMesh?.parent?.children.some(
    child => child.userData.forestPart === 'ezBranches'));
  await startGame(page);
  const start = page.locator('#diagCaptureStart');
  const stop = page.locator('#diagCaptureStop');
  await expect(start).toBeInViewport();
  expect((await start.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await activate(start, hasTouch);
  await expect(start).toBeDisabled();
  await page.waitForFunction(() => {
    const report = window.__snowgliderDiag?.captureSnapshot() as Report | null;
    return report && report.pendingWindowFrames + report.windows.reduce((n, w) => n + w.frames, 0) >= 15;
  });
  await activate(page.locator('#resetBtn'), hasTouch);
  await page.waitForFunction(() => {
    const report = window.__snowgliderDiag?.captureSnapshot() as Report | null;
    const run = window.__snowgliderDiag?.snapshot() as { summary?: { frames?: number } } | null;
    return report && report.resetCount >= 1 && (run?.summary?.frames ?? 0) >= 15;
  });
  await expect(stop).toBeInViewport();
  await testInfo.attach('debug-performance-controls', { body: await page.screenshot(), contentType: 'image/png' });
  const downloadEvent = page.waitForEvent('download');
  await activate(stop, hasTouch);
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('snowglider-performance.json');
  const path = await download.path();
  if (!path) throw new Error('The local capture download has no artifact path');
  const text = await readFile(path, 'utf8');
  const report = JSON.parse(text) as Report;
  expect(report).toMatchObject({ schemaVersion: 1, status: 'stopped', stopReason: 'manual', scope: 'active-gameplay-frame-intervals' });
  expect(report.resetCount).toBeGreaterThanOrEqual(1);
  expect(report.elapsedMs).toBeLessThanOrEqual(600000);
  expect(report.windows.length).toBeGreaterThan(0);
  expect(report.windows.length).toBeLessThanOrEqual(60);
  expect(report.checkpoints.length).toBeLessThanOrEqual(720);
  expect(report.checkpoints.some(point => point.reason === 'reset')).toBe(true);
  expect(report.checkpoints.some(point => point.probe?.renderer.available &&
    (point.probe.renderer.geometries ?? 0) > 0 && point.probe.renderer.qualityMode === 'auto')).toBe(true);
  for (const window of report.windows) {
    expect(window.frames).toBeGreaterThan(0);
    expect(window.frames).toBeLessThanOrEqual(4096);
    expect(window.p50Ms).toBeLessThanOrEqual(window.p95Ms);
    expect(window.p95Ms).toBeLessThanOrEqual(window.p99Ms);
    expect(window.p99Ms).toBeLessThanOrEqual(window.maxMs);
    expect(window.over250Ms).toBeLessThanOrEqual(window.over50Ms);
  }
  expect(text).not.toMatch(/"(?:userAgent|url|uid|seed|stack|message)"/);
  await testInfo.attach('local-performance-capture', { body: text, contentType: 'application/json' });
  await expect(start).toBeEnabled();
});
