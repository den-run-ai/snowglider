// snowman.ts — ROOT FACADE for the Snowman module (Stage R3, issue #34).
//
// The implementation moved wholesale to `src/snowman/index.ts`; this thin file
// re-exports it so the existing importers keep resolving a *sibling* `./snowman.js`
// specifier (there is no directory-index resolution here):
//   - src/main.ts            (side-effect import, keeps it in the bundle graph)
//   - src/snowglider.ts      (import { Snowman })
//   - src/game/*.ts          (import { Snowman })
//   - src/player-state.ts    (imports the contract *types*)
//   - src/ui/hud.ts          (imports PlayerPos / UpdateResult types)
//   - tests/browser-tests.js (import { Snowman } from '../src/snowman.js')
//   - tests/contract-surface-tests.js (runtime import, via the .js->.ts hook)
//
// `export *` re-exports the `Snowman` object AND every contract type (PlayerPos,
// UpdateResult, …) that player-state.ts / hud.ts consume.
//
// NOTE: the physics-invariant harness (tests/verification/physics_invariant_harness.js)
// self-registers the same `.js`->`.ts` resolver used by the Node suites before
// importing this facade. That keeps `npm run test:verify` aligned with the app's
// public `./snowman.js` seam even as `src/snowman/index.ts` delegates to smaller
// submodules.
export * from './snowman/index.js';
