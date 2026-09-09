# Type checking and SDK boundaries

The application is TypeScript, with two classic JavaScript bootstrap scripts
checked by TypeScript. Most remaining JavaScript is test code. File extensions
are not the coverage measure: CI checks the compiler's file inventory and rejects
new gaps.

## Required checks

- `npm run typecheck:all` checks the strict application, JavaScript tests/configs,
  strict Playwright project, service worker, and their compiler file inventory.
- `npm run lint` uses type-aware rules for application TypeScript, Playwright and the worker.
  Explicit `any` and unsafe assignments, member access, calls, arguments and returns
  are errors there. The whole lint run permits zero warnings. JavaScript and MJS
  tooling receive the JavaScript rules appropriate to their module format.
- `npm test` includes persisted-data, SDK-adapter, dependency-version and coverage
  regressions alongside the gameplay suites.

The application retains `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, unused checks and checked JavaScript. The worker uses
the same strictness with the WebWorker library in its own project. Vite builds
transpile TypeScript; the separate compiler steps are the type-check gates.

The JavaScript test project checks files by default and relaxes implicit-any,
null and unused checks for existing scaffolding. Playwright TypeScript specs,
helpers and configurations additionally pass the full strict compiler settings in
`tsconfig.e2e.json`. Nine exact legacy exclusions remain: eight
classic in-page browser suites/runner files and the frozen historical physics
baseline. They are listed, with reasons, in `scripts/check-typecheck-coverage.mjs`.
New files do not inherit an exemption. The inventory check rejects additional
omissions, unchecked projects, new `@ts-nocheck` directives and stale exemptions.
The legacy browser suites still run through Puppeteer; the frozen baseline still
guards the coasting trajectory. Their type migration remains tracked by #367.

## Data and library contracts

- **Replay storage:** JSON is decoded from `unknown`. Ghost samples require finite
  numeric coordinates/rotation and nonnegative, nondecreasing timestamps with a
  positive final time. Equal timestamps are supported because the finish can append
  a sample at the same time as the last update. Splits require the expected number
  of cumulative finite times; replay metadata must match the current world.
- **Three.js:** runtime and declaration packages have matching exact versions.
  Snowman construction and physics/pose share `SnowmanUserData`; particle pools
  carry their own concrete state. Imported test rigs cross a validated boundary,
  cached by state-object identity without per-frame allocation or RNG changes.
- **Firebase:** CDN modules map to official SDK declarations. Firebase is pinned
  to the runtime CDN version, and `dependency-type-contract-tests.js` checks the
  manifest, lockfile, installed versions and every app CDN import. Boot initializer
  signatures preserve `FirebaseOptions`, `Firestore` and `Analytics` types.
  Leaderboard records require an SDK `DocumentReference` to the matching user's
  profile; rejection values are narrowed from `unknown` before reading error fields.
- **EZ-Tree:** the pinned 1.1.0 adapter describes numeric-keyed branch options,
  checks the instance before/after preset loading and generation, and validates
  the actual installed package in tests. Rejected instances release their geometry
  and materials without disposing the package's shared textures.

`skipLibCheck` remains enabled because EZ-Tree 1.1.0 ships defective declarations
(the audit with it disabled reported 21 declaration errors). This skips checking
declaration-file internals; application calls are still checked against the types
they consume. Upgrading or repairing those upstream declarations should be a
separate verified dependency change, followed by reevaluating this option.
