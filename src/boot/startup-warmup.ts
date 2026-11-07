// Startup scheduling only: this helper never advances the simulation or creates
// graphics resources. It waits on the scene's existing asset construction.

/** Let the lightweight menu paint before synchronous scene construction. Hidden
 * tabs wait for visibility, and teardown cancels outstanding animation frames. */
export function waitForStartupPaint(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (typeof document === 'undefined' || typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function') return Promise.resolve(true);

  return new Promise(resolve => {
    let frame: number | null = null;
    let painted = false;
    let settled = false;
    const finish = (visible: boolean) => {
      if (settled) return;
      settled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', schedule);
      signal?.removeEventListener('abort', abort);
      resolve(visible);
    };
    const abort = () => finish(false);
    const schedule = () => {
      if (settled || frame !== null) return;
      if (document.visibilityState === 'hidden') return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (document.visibilityState === 'hidden') { painted = false; return; }
        if (painted) finish(true);
        else { painted = true; schedule(); }
      });
    };
    document.addEventListener('visibilitychange', schedule);
    signal?.addEventListener('abort', abort, { once: true });
    schedule();
  });
}

type WaitResult = 'complete' | 'timeout' | 'failed' | 'aborted';

/** Bound the asset wait and clear its deadline/listener on every outcome.
 * Late fulfillment/rejection is consumed; it cannot reopen a completed start. */
function boundedWait(work: () => Promise<unknown>, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
  if (signal?.aborted) return Promise.resolve('aborted');
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => finish('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    void Promise.resolve().then(() => settled ? undefined : work()).then(
      () => finish('complete'),
      () => finish('failed'),
    );
  });
}

export interface StartupWarmupOptions {
  assetsReady: () => boolean;
  waitForAssets: () => Promise<unknown>;
  useFallback: () => void;
  signal?: AbortSignal;
  assetTimeoutMs?: number;
}

/** Resolve true once the existing scene is safe to start. Visible/collidable
 * assets are required; already-prepared assets add no artificial waiting. */
export async function warmupStartupScene(options: StartupWarmupOptions): Promise<boolean> {
  const { assetsReady, waitForAssets, useFallback, signal } = options;
  if (signal?.aborted) return false;
  if (!assetsReady()) {
    const result = await boundedWait(waitForAssets, options.assetTimeoutMs ?? 6000, signal);
    if (result === 'aborted' || signal?.aborted) return false;
    // A stalled/rejected detailed forest keeps the same placements through the
    // existing stylized fallback, preserving collision visibility and fairness.
    if (!assetsReady()) {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden' &&
          !await waitForStartupPaint(signal)) return false;
      // Teardown can occur after the paint promise resolves but before this
      // continuation runs. Never construct fallback geometry after disposal.
      if (signal?.aborted) return false;
      useFallback();
    }
    if (!assetsReady()) throw new Error('The forest could not finish preparing. Please reload.');
  }
  return !signal?.aborted;
}
