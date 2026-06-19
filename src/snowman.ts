// snowman.ts — ROOT FACADE for the Snowman module (Stage R3, issue #34).
//
// The implementation moved wholesale to `src/snowman/index.ts`; this thin file
// re-exports it so the existing importers keep resolving a *sibling* `./snowman.js`
// specifier (there is no directory-index resolution here):
//   - src/main.ts            (side-effect import, keeps it in the bundle graph)
//   - src/snowglider.ts      (import { Snowman })
//   - src/game/*.ts          (import { Snowman })
//   - src/physics.ts         (imports the contract *types*)
//   - src/ui/hud.ts          (imports PlayerPos / UpdateResult types)
//   - tests/browser-tests.js (import { Snowman } from '../src/snowman.js')
//   - tests/contract-surface-tests.js (runtime import, via the .js->.ts hook)
//
// `export *` re-exports the `Snowman` object AND every contract type (PlayerPos,
// UpdateResult, …) that physics.ts / hud.ts consume.
//
// NOTE: the physics-invariant harness (tests/verification/physics_invariant_harness.js)
// runs under bare Node with NO `.js`->`.ts` resolve hook, so it cannot resolve this
// facade's `./snowman/index.js` re-export. It imports the relocated implementation
// directly (`src/snowman/index.ts`) instead; keep that harness import in sync if this
// facade ever changes. `src/snowman/index.ts` stays free of *relative* imports so it
// remains loadable under that bare-Node harness.
export * from './snowman/index.js';
