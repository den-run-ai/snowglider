import { test, expect } from '@playwright/test';
import type { CDPSession } from '@playwright/test';
import type * as THREE from 'three';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  REVIEW_SEED, prepareRenderScenario, enterRenderPhase, measureRenderPhase,
  assertRenderPhase, captureRenderCanvas
} from '../e2e/render-scenarios';

type RenderTiming = { nativeStartMs: number; nativeEndMs: number; durationMs: number };
type FrameTiming = {
  index: number;
  phase: 'settle' | 'measured';
  phaseIndex: number;
  nativeStartMs: number;
  nativeEndMs: number;
  simulatedTimeMs: number;
  callbackCpuMs: number;
  synchronizedMs: number;
  finishMs: number;
  renderMs: number;
  nonRenderCpuMs: number;
  renders: RenderTiming[];
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
};
type Recording = {
  timeOriginUnixMs: number;
  initNativeMs: number;
  startClickNativeMs: number | null;
  startClickUnixMs: number | null;
  installed: boolean;
  frames: FrameTiming[];
  outsideFrameRenders: RenderTiming[];
};
type ProfileWindow = Window & {
  renderer: THREE.WebGLRenderer;
  __renderClock: { step: () => { cpuMs: number; synchronizedMs: number } };
  __startupProfile: Recording;
};
type TraceComplete = { stream?: string; dataLossOccurred?: boolean };

async function saveTrace(session: CDPSession, filename: string): Promise<TraceComplete> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let listener: (event: TraceComplete) => void = () => undefined;
  const completed = new Promise<TraceComplete>((resolve, reject) => {
    listener = resolve;
    session.once('Tracing.tracingComplete', listener);
    timeout = setTimeout(() => reject(new Error('Timed out stopping diagnostic trace')), 30_000);
  });
  let result: TraceComplete;
  try {
    await session.send('Tracing.end');
    result = await completed;
  } finally {
    clearTimeout(timeout);
    session.removeListener('Tracing.tracingComplete', listener);
  }
  if (!result.stream) throw new Error('Diagnostic trace did not return a stream');
  const stream = result.stream;
  const file = await fs.open(filename, 'w');
  try {
    for (;;) {
      const chunk = await session.send('IO.read', { handle: stream }) as {
        data: string; base64Encoded?: boolean; eof?: boolean;
      };
      await file.write(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
      if (chunk.eof) break;
    }
  } finally {
    await file.close();
    await session.send('IO.close', { handle: stream });
  }
  return result;
}

test('profile the real phone Start and the existing 8 + 12 spawn frames', async ({ page }, testInfo) => {
  const commit = process.env.RENDER_COMMIT;
  expect(commit, 'the runtime must be an exact revision').toMatch(/^[0-9a-f]{40}$/);
  const appDirectory = path.resolve(process.env.RENDER_APP_DIR || '.');
  expect(execFileSync('git', ['-C', appDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(commit);
  const output = path.resolve(process.env.RENDER_OUTPUT_DIR || 'test-results/startup-profile');
  await fs.mkdir(output, { recursive: true });
  const prefix = path.join(output, `${testInfo.project.name}-repeat-${testInfo.repeatEachIndex + 1}`);

  // This init script only observes the existing harness. It keeps a bound native
  // clock before that harness replaces performance.now with simulated RAF time.
  // The capture listener runs immediately before the real Start handler, after
  // prepareRenderScenario installs its clock; no application source is changed.
  await page.addInitScript(() => {
    const w = window as unknown as ProfileWindow;
    const nativeNow = performance.now.bind(performance);
    const recording: Recording = {
      timeOriginUnixMs: performance.timeOrigin,
      initNativeMs: nativeNow(), startClickNativeMs: null, startClickUnixMs: null,
      installed: false, frames: [], outsideFrameRenders: []
    };
    w.__startupProfile = recording;
    performance.mark('startup-profile-document-init');
    const onStart = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest('#startGameButton')) return;
      document.removeEventListener('click', onStart, true);
      recording.startClickNativeMs = nativeNow();
      recording.startClickUnixMs = Date.now();
      performance.mark('startup-profile-start-click');
      if (!w.renderer || !w.__renderClock) throw new Error('Diagnostic hook missed the real Start clock');
      recording.installed = true;
      let activeRenders: RenderTiming[] | null = null;
      const originalRender = w.renderer.render.bind(w.renderer);
      w.renderer.render = (...args: Parameters<THREE.WebGLRenderer['render']>) => {
        const nativeStartMs = nativeNow();
        try {
          return originalRender(...args);
        } finally {
          const nativeEndMs = nativeNow();
          const timing = { nativeStartMs, nativeEndMs, durationMs: nativeEndMs - nativeStartMs };
          (activeRenders || recording.outsideFrameRenders).push(timing);
        }
      };
      const originalStep = w.__renderClock.step.bind(w.__renderClock);
      w.__renderClock.step = () => {
        const index = recording.frames.length + 1;
        const phase = index <= 8 ? 'settle' : 'measured';
        const phaseIndex = index <= 8 ? index : index - 8;
        const marker = `startup-profile-${phase}-${phaseIndex}-frame-${index}`;
        performance.mark(`${marker}-start`);
        const renders: RenderTiming[] = [];
        activeRenders = renders;
        const nativeStartMs = nativeNow();
        try {
          const timing = originalStep();
          const nativeEndMs = nativeNow();
          const renderMs = renders.reduce((total, render) => total + render.durationMs, 0);
          const info = w.renderer.info;
          recording.frames.push({
            index, phase, phaseIndex, nativeStartMs, nativeEndMs,
            simulatedTimeMs: performance.now(), callbackCpuMs: timing.cpuMs,
            synchronizedMs: timing.synchronizedMs,
            finishMs: timing.synchronizedMs - timing.cpuMs,
            renderMs, nonRenderCpuMs: timing.cpuMs - renderMs, renders,
            calls: info.render.calls, triangles: info.render.triangles,
            geometries: info.memory.geometries, textures: info.memory.textures,
            programs: info.programs?.length || 0
          });
          return timing;
        } finally {
          activeRenders = null;
          performance.mark(`${marker}-end`);
        }
      };
    };
    document.addEventListener('click', onStart, true);
  });

  const session = await page.context().newCDPSession(page);
  const traceCategories = [
    'toplevel', 'devtools.timeline', 'blink.user_timing', 'v8', 'cc', 'gpu',
    'disabled-by-default-v8.gc', 'disabled-by-default-v8.compile'
  ];
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 1000 });
  await session.send('Tracing.start', {
    categories: traceCategories.join(','), transferMode: 'ReturnAsStream',
    options: 'record-as-much-as-possible'
  });
  await session.send('Profiler.start');
  try {
    const errors = await prepareRenderScenario(page);
    await enterRenderPhase(page, 'spawn');
    const metrics = await measureRenderPhase(page, 'spawn');
    const recording = await page.evaluate(() => (window as unknown as ProfileWindow).__startupProfile);
    const measured = recording.frames.filter(frame => frame.phase === 'measured');
    const summarize = (key: 'callbackCpuMs' | 'renderMs' | 'nonRenderCpuMs' | 'finishMs' | 'synchronizedMs') => {
      const values = measured.map(frame => frame[key]).sort((a, b) => a - b);
      return {
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        p50: values[Math.ceil(values.length * .5) - 1],
        p95: values[Math.ceil(values.length * .95) - 1],
        max: values[values.length - 1]
      };
    };
    const summary = {
      callbackCpuMs: summarize('callbackCpuMs'), renderMs: summarize('renderMs'),
      nonRenderCpuMs: summarize('nonRenderCpuMs'), finishMs: summarize('finishMs'),
      synchronizedMs: summarize('synchronizedMs')
    };
    // Save raw evidence before assertions so a failed capture is still useful.
    await fs.writeFile(`${prefix}.json`, JSON.stringify({
      schema: 1, commit, harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      seed: REVIEW_SEED, device: testInfo.project.name, repeat: testInfo.repeatEachIndex + 1,
      viewport: page.viewportSize(), errors, metrics, summary, recording,
      method: {
        renderer: 'Chromium SwiftShader; service-time diagnostic, not hardware GPU FPS',
        path: 'Existing prepareRenderScenario normal Start; enterRenderPhase(spawn) settles 8 frames; measureRenderPhase(spawn) measures 12',
        nativeClock: 'performance.now bound before the existing controlled-clock replacement; timestamps relative to timeOriginUnixMs',
        traceAlignment: 'blink.user_timing startup-profile-* marks bracket each frame and Start; simulatedTimeMs is not trace wall time',
        renderMs: 'Synchronous renderer.render wall duration, which can include driver waits; excludes the explicit post-callback gl.finish',
        callbackCpuMs: 'Original harness callback elapsed time including render wrapper overhead; not pure CPU execution time',
        finishMs: 'Original synchronizedMs minus callbackCpuMs; explicit gl.finish wait plus timer-call overhead',
        scope: 'Trace/profile includes navigation, scene preparation, Start and all 20 frames; initial Start renders are outsideFrameRenders',
        limitations: 'Sampling profiler, trace and timers perturb timings equally on both revisions; one 12-frame p95 is the maximum; do not infer real-device FPS',
        cpuSamplingIntervalUs: 1000, traceCategories
      }
    }, null, 2));
    console.log(JSON.stringify({ commit, repeat: testInfo.repeatEachIndex + 1, summary }));
    expect(recording.installed, 'instrumentation runs before the actual Start handler').toBe(true);
    expect(recording.frames.map(frame => frame.index)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(recording.frames.filter(frame => frame.phase === 'settle')).toHaveLength(8);
    expect(measured).toHaveLength(12);
    expect(recording.frames.every(frame => frame.renders.length > 0), 'every sample renders the actual scene').toBe(true);
    assertRenderPhase(metrics, false);
    expect(errors).toEqual([]);
  } finally {
    try {
      const { profile } = await session.send('Profiler.stop') as { profile: unknown };
      await fs.writeFile(`${prefix}.cpuprofile`, JSON.stringify(profile));
    } finally {
      try {
        const trace = await saveTrace(session, `${prefix}.trace.json`);
        await fs.writeFile(`${prefix}.trace-status.json`, JSON.stringify(trace, null, 2));
        expect(trace.dataLossOccurred, 'trace must retain all requested events').not.toBe(true);
      } finally {
        await session.detach();
      }
    }
  }
  // PNG encoding and its extra render are deliberately outside the profile.
  await fs.writeFile(`${prefix}-spawn.png`, await captureRenderCanvas(page));
});
