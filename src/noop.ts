// A shared do-nothing function, allocated in THIS tiny module's (empty) lexical
// environment. disposeSnowGlider rebinds window.disposeGame to it on teardown to keep the
// public API idempotent — using an external helper rather than a coordinator-local
// closure, so the retained window reference does NOT root snowglider.ts's module
// environment (which still holds sceneContext/renderer/scene). See the dispose-audit plan.
export function noop(): void {}
