// mountains.ts — ROOT FACADE for the Mountains module (Stage R-mountains, issue #34).
//
// The implementation moved wholesale to `src/mountains/index.ts`; this thin file
// re-exports it so the existing importers keep resolving a *sibling* `./mountains.js`
// specifier (there is no directory-index resolution here):
//   - src/main.ts            (side-effect import, keeps it in the bundle graph)
//   - src/camera.ts          (import { Mountains })
//   - src/snow.ts            (import { Mountains })
//   - src/trees.ts           (import { Mountains } — circular, resolves at call time)
//   - src/game/scene-setup.ts (imports the RockPosition type)
//   - tests/terrain-tests.js / regression-tests.js (import { Mountains })
//   - tests/terrain-tests.js (import { terrainRidgeField } from '../src/mountains.js')
//   - tests/verification/*   (via the .js->.ts resolve hook)
//
// `export *` re-exports the `Mountains` object, the named samplers/helpers
// (terrainRidgeField, forestDensityField, rockCollisionRadius) AND the contract
// types (TerrainVec2, RockPosition) that scene-setup.ts consumes.
//
// NOTE: the Node terrain/regression suites and the physics-invariant harness
// self-register the same `.js`->`.ts` resolver before importing this facade, so the
// public `./mountains.js` seam stays the thing under test even as
// `src/mountains/index.ts` delegates to smaller submodules.
export * from './mountains/index.js';
