// Shared, lightweight startup state. The menu can subscribe before Three.js is
// ready, and background failures stay inline until the player asks to start.
import { showFatalErrorOverlay } from '../ui/fatal-error-overlay.js';

export type StartupStage = 'loading' | 'building' | 'warming' | 'ready' | 'error';
export interface StartupStatus {
  readonly stage: StartupStage;
  readonly error?: unknown;
  readonly reason?: 'context-lost';
}

let status: StartupStatus = { stage: 'loading' };
const listeners = new Set<(status: StartupStatus) => void>();

export function getStartupStatus(): StartupStatus { return status; }

/** Immediately publishes the current state, then each real milestone. */
export function subscribeStartupStatus(listener: (status: StartupStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => { listeners.delete(listener); };
}

export function setStartupStatus(stage: StartupStage, error?: unknown, reason?: 'context-lost'): void {
  status = stage === 'error' ? { stage, error, ...(reason ? { reason } : {}) } : { stage };
  for (const listener of listeners) listener(status);
}

/** Use from the Start action; speculative background loading never opens a modal. */
export function showStartupError(): boolean {
  if (status.stage !== 'error') return false;
  showFatalErrorOverlay(status.error, status.reason ? { reason: status.reason } : {});
  return true;
}
