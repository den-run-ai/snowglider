// Shared ski-slope steepness thresholds, in gradient magnitude (rise/run = tan θ).
//
// Single source of truth for BOTH the HUD's difficulty tiers (src/ui/hud.ts — the
// ● green / ■ blue / ◆ black-diamond readout) AND the terrain's slope-aware snow
// shading (src/mountains/snow-surface.ts — the cavity/AO darkening leans harder on
// steeper ground). Before this module each side carried its own copy of the numbers,
// so a retune of one would silently drift from the other; importing the same
// constants keeps the on-snow shading and the on-screen difficulty mark in agreement.
//
// Dependency-free constants (no THREE), so the physics kernel or any UI module can
// import them without pulling in the render stack.
export const SLOPE_MODERATE = 0.32; // ≈18° / 32% — green (●) → blue (■)
export const SLOPE_STEEP = 0.58;    // ≈30° / 58% — blue (■) → black diamond (◆)
