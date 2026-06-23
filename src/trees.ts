// trees.ts — ROOT FACADE for the Trees module (Stage R-mountains, issue #34).
//
// Trees moved into `src/mountains/trees.ts` (a peer of rocks.ts — both are scenery
// scattered on the terrain); this thin file re-exports it so every importer keeps
// resolving the sibling `./trees.js` specifier (there is no directory-index
// resolution here):
//   - src/main.ts             (side-effect import, keeps it in the bundle graph)
//   - src/snow.ts             (import { Trees })
//   - src/game/scene-setup.ts (imports the TreePosition type)
//   - src/mountains/terrain-mesh.ts imports the moved module directly (./trees.js
//     sibling), not this facade
//
// `export *` re-exports the `Trees` object and the contract types (TreePosition,
// TerrainGradient).
export * from './mountains/trees.js';
