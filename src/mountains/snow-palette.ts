// mountains/snow-palette.ts — the ONE set of snow colour/roughness constants shared
// by the terrain surface, the rock snow caps, the tree snow caps/shelves, and the
// snowman body (PR 2 of the visual-materials plan).
//
// Every value is copied verbatim from the constants the consumers shipped with, so
// adopting this module is visually a no-op by construction; what it buys is that the
// "snow is snow" coherence can no longer drift when one consumer is retuned. Values
// are authored for the project's legacy linear pipeline (ColorManagement disabled).
// Dependency-free on purpose: safe to import from any module (terrain, trees, rocks,
// snowman) without cycles, and from the headless Node suites.

/** Snow-cap / shelf white — a faintly cool near-white so accumulated snow reads as
 *  snow, not blown highlight (rock caps, tree caps/shelves, rock scrape shelves). */
export const SNOW_WHITE = { r: 0.97, g: 0.98, b: 1.0 } as const;

/** Slope-shadow tint the terrain pitches (and the sastrugi drift bands) lean
 *  toward — a barely-cool powder shadow, almost white. */
export const SNOW_SHADE = { r: 0.93, g: 0.95, b: 0.99 } as const;

/** Occluded-pocket tint for concave hollows (terrain cavity/AO vertex term). */
export const CAVITY_COLOR = { r: 0.8, g: 0.84, b: 0.93 } as const;

/** Matte powder roughness of the broad snow surfaces: the terrain mesh and the
 *  snowman body spheres (snowman/snow-material.ts re-exports it). */
export const SNOW_ROUGHNESS_SURFACE = 0.92;

/** Roughness of the compact accumulated caps/shelves on the trees. */
export const SNOW_ROUGHNESS_CAPS = 0.82;
