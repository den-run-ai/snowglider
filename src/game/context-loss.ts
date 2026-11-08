// Three.js silently skips render() after WebGL context loss. Observe the canvas
// itself so menu/intro/debris and deferred starts are covered too, not just the
// gameplay loop's exception handler. Recovery is a fresh page load: the current
// run and its async work must never resume on a restored graphics context.

export interface ContextLossOptions {
  signal: AbortSignal;
  onLost: () => void;
  isContextLost: () => boolean;
}

/** Own the canvas listener for exactly one game instance; abort removes it. */
export function watchContextLoss(canvas: EventTarget, options: ContextLossOptions): void {
  const { signal, onLost, isContextLost } = options;
  if (signal.aborted) return;
  let lost = false;
  function stopOnce(event?: Event): void {
    // Permit the browser's normal restoration protocol. Restoration deliberately
    // cannot restart this game instance: the coordinator disposes it on first loss.
    event?.preventDefault();
    if (lost || signal.aborted) return;
    lost = true;
    onLost();
  }
  canvas.addEventListener('webglcontextlost', stopOnce, { signal });
  // Covers loss during synchronous scene construction, before this listener was
  // installed. Call only once the coordinator's teardown is fully initialized.
  if (isContextLost()) stopOnce();
}
