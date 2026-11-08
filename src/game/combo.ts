// game/combo.ts — the style/combo meter's pure decision core (jump-system
// completion JP-7, workstream F; #286 / #245 phase 3).
//
// Consecutive rewarded air events — CLEAN landings, scored obstacle clears (JP-2),
// avalanche dodges (JP-3) — build a multiplier applied to the air-score points
// banked from that moment on: ×COMBO_STEP_FACTOR per step, capped at
// COMBO_MAX_MULTIPLIER. An OK landing keeps the chain (neither builds nor breaks);
// a SKETCHY or WIPEOUT landing breaks it; a new run resets it (the loop calls
// `reset` from resetLoopState, and a crash ends the run anyway).
//
// LOOP-SIDE ONLY, NO KERNEL STATE (the #245 discipline): the kernel keeps banking
// raw airScoreDelta through its injected bankAirScore callback; the loop's callback
// multiplies by the CURRENT step's multiplier before it reaches
// CourseModule.addAirScore, and the combo advances from the per-step result AFTER
// banking — so an event's own points ride the multiplier built by the events
// BEFORE it, and start compounding from the next one.
//
// This module is intentionally THREE/DOM-free so the combo math pins headlessly
// (tests/freestyle-tests.js).
//
// PHYSICAL SPINS (#244) — reserved seam: once heading becomes real kernel state, a
// landed 180 rides switch and the landing grade reads heading-vs-velocity; the
// combo event stream here is where a "switch landing" event would slot in as a
// builder. This module deliberately keys off LandingQuality/clear/dodge events
// only, so #244 can add events without touching the multiplier math.

/** Per-step combo growth: ×1.25 per consecutive rewarded event. */
export const COMBO_STEP_FACTOR = 1.25;
/** Hard multiplier cap — combos never exceed ×3 (provisional, plan §11). */
export const COMBO_MAX_MULTIPLIER = 3;

/** The loop-observed events that drive the combo chain. */
export type ComboEvent =
  | 'clean'    // CLEAN manual-jump landing — builds
  | 'clear'    // scored obstacle clear (JP-2) — builds
  | 'dodge'    // avalanche dodge award (JP-3) — builds
  | 'ok'       // OK landing — keeps the chain, doesn't build
  | 'sketchy'  // SKETCHY landing — breaks it
  | 'wipeout'  // wipeout landing (JP-4) — breaks it (the run is over anyway)
  | 'reset';   // run start/restart — clean slate

/** The multiplier a given chain step earns: min(cap, factor^step). Step 0 == ×1. */
export function comboMultiplier(step: number): number {
  return Math.min(COMBO_MAX_MULTIPLIER, Math.pow(COMBO_STEP_FACTOR, Math.max(0, step)));
}

/** Advance the chain: builders increment, OK holds, breakers/reset zero it. */
export function nextComboStep(step: number, event: ComboEvent): number {
  switch (event) {
    case 'clean':
    case 'clear':
    case 'dodge':
      return Math.max(0, step) + 1;
    case 'ok':
      return Math.max(0, step);
    default:
      return 0;
  }
}

/** Compact toast suffix for a live chain: '×1.25', '×1.56', '×3' — or '' at ×1
 *  (no chain, nothing to advertise). Trims trailing zeros so ×2.50 reads ×2.5. */
export function comboLabel(step: number): string {
  const m = comboMultiplier(step);
  if (m <= 1) return '';
  return `×${m.toFixed(2).replace(/\.?0+$/, '')}`;
}
