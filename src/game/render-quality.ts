import type * as THREE from 'three';

/** Render-only budgets. The highest tier preserves the shipped framebuffer/shadows. */
export const RENDER_QUALITY_LEVELS = [
  { name: 'high', pixelRatio: 2, shadowSize: 2048 },
  { name: 'balanced', pixelRatio: 1.5, shadowSize: 1024 },
  { name: 'low', pixelRatio: 1, shadowSize: 512 },
] as const;
export type RenderQualityName = typeof RENDER_QUALITY_LEVELS[number]['name'];
export type RenderQualityMode = RenderQualityName | 'auto';

/** Automation stays reproducible unless the adaptive path is explicitly requested. */
export function resolveRenderQualityMode(search: string, automated: boolean): RenderQualityMode {
  const value = new URLSearchParams(search).get('quality');
  if (value === 'auto' || value === 'high' || value === 'balanced' || value === 'low') return value;
  return automated ? 'high' : 'auto';
}

/** Sustained frame timing, not one GC stall, changes quality. No wall clock or RNG. */
export function createQualityPolicy(onChange: (level: number) => void, initialLevel = 0) {
  let level = Number.isFinite(initialLevel) ? Math.min(2, Math.max(0, Math.floor(initialLevel))) : 0;
  let warmup = 3;
  let seconds = 0;
  let frames = 0;
  let fastSeconds = 0;
  let slowWindows = 0;
  function resetTiming(): void {
    warmup = 3;
    seconds = frames = fastSeconds = slowWindows = 0;
  }
  return {
    resetTiming,
    getLevel: () => level,
    sample(dt: number, ready = true): void {
      if (!ready) { resetTiming(); return; }
      if (!Number.isFinite(dt) || dt <= 0) {
        seconds = frames = fastSeconds = slowWindows = 0;
        return;
      }
      // Bound an isolated GC/shader stall, but retain sustained overload: discarding
      // every >250 ms sample would leave a genuinely slow device at high forever.
      // Hidden/loading spans are excluded by the ready flag and resetTiming caller.
      const elapsed = Math.min(dt, 0.25);
      if (warmup > 0) { warmup -= elapsed; return; }
      seconds += elapsed;
      frames++;
      if (seconds < 2 || frames < 12) return;
      const meanMs = seconds * 1000 / frames;
      fastSeconds = meanMs < 18 ? fastSeconds + seconds : 0;
      // One capped stall can push a 50 Hz window over the threshold. Require a
      // second slow window; normal 20 ms frames must clear the pending downgrade.
      slowWindows = meanMs > 22 ? Math.min(2, slowWindows + 1) : 0;
      const next = slowWindows >= 2 ? Math.min(2, level + 1)
        : fastSeconds >= 12 ? Math.max(0, level - 1) : level;
      seconds = frames = 0;
      if (next !== level) {
        level = next;
        resetTiming();
        onChange(level);
      }
    },
  };
}

export interface RenderQualityController {
  sample: (dt: number, ready?: boolean) => void;
  resetTiming: () => void;
  setDevicePixelRatio: (ratio: number) => void;
}

/** Owns only resolution and shadow-map resources; never simulation/scene membership. */
export function createRenderQuality(
  renderer: THREE.WebGLRenderer,
  sun: THREE.DirectionalLight,
  mode: RenderQualityMode,
  devicePixelRatio: number,
): RenderQualityController {
  const cleanRatio = (ratio: number): number => Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  let ratio = cleanRatio(devicePixelRatio);
  let level = mode === 'low' ? 2 : mode === 'balanced' ? 1 : 0;
  const apply = (next: number): void => {
    level = next;
    const quality = RENDER_QUALITY_LEVELS[level]!;
    const pixelRatio = Math.min(ratio, quality.pixelRatio);
    if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
    if (sun.shadow.mapSize.x !== quality.shadowSize || sun.shadow.mapSize.y !== quality.shadowSize) {
      // Three.js creates the replacement on the next shadow pass. Free the previous
      // GPU targets first; merely changing mapSize would retain the old allocation.
      sun.shadow.map?.dispose();
      sun.shadow.mapPass?.dispose();
      sun.shadow.map = null;
      sun.shadow.mapPass = null;
      sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
      sun.shadow.needsUpdate = true;
      renderer.shadowMap.needsUpdate = true;
    }
    renderer.domElement.dataset.renderQuality = quality.name;
    renderer.domElement.dataset.renderQualityMode = mode;
  };
  const policy = createQualityPolicy(apply, level);
  apply(level);
  return {
    sample: (dt, ready = true) => { if (mode === 'auto') policy.sample(dt, ready); },
    resetTiming: policy.resetTiming,
    setDevicePixelRatio(next): void {
      ratio = cleanRatio(next);
      apply(level);
      policy.resetTiming();
    },
  };
}
