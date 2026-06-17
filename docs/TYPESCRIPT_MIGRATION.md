# SnowGlider — TypeScript Migration Roadmap

> Gradual, test-gated transition from the current classic-script JavaScript codebase to type-checked, then fully TypeScript, source — **without breaking the GitHub Pages deploy to snowglider.ai at any point.**

## Status

- **Current:** Phase 1 **complete and hardened.** Every `src/**/*.js` carries `// @ts-check`,
  `tsc --noEmit` is green and **blocking in CI**, and `tsconfig` now sets `"checkJs": true` so any
  *new* source file is type-checked by default (the per-file directives are now a belt-and-suspenders
  ratchet, not the gate). Still classic `<script>` modules (global namespaces), three.js **r160**
  loaded as a CDN global. `auth.js` / `scores.js` are ES modules for Firebase.
- **Build today:** a Vite step exists but currently only **copies** the static source tree into
  `dist/` (see `vite.config.js` `copyStaticAppFiles`) — it does **not** yet bundle an ES-module
  graph. `index.html` still loads CDN `THREE` and injects `src/*.js` via `src/boot/script-loader.js`.
  Turning that copy step into a real module bundle is the substance of Phase 2.
- **Target:** ES-module TypeScript with full type-checking in CI, `@types/three`, and a thin build step that still ships static files to GitHub Pages.
- **Guardrail:** the existing test suite (`npm test`) and ESLint must stay green after every phase. No phase is allowed to leave `main` un-deployable.

## TL;DR

The blocker is **not** TypeScript — it's the *classic-script + global-namespace + CDN-`THREE`* architecture. TS wants modules. So we do this in order, each step independently shippable:

1. **Phase 1 — Type-check in place (no architecture change, no build step).** `tsconfig` with `checkJs` + a `globals.d.ts` that mirrors the globals list already in `eslint.config.js`. Lean on the JSDoc you already write. CI gains `tsc --noEmit`. **Reversible, low risk, real value.**
2. **Phase 2 — Introduce a bundler + convert globals → ES modules**, module-by-module, behind the test suite. `THREE` moves from CDN global to `import * as THREE from 'three'`.
3. **Phase 3 — Rename `.js` → `.ts`** and ratchet strict flags up, `strictNullChecks` first.
4. **Parallel track — upgrade three.js** (separate from all type work): r134 → r160 can happen
   before Phase 2 because r160 is the final global build; r160 → latest must wait for Phase 2's
   ES-module conversion. See [`THREEJS_UPGRADE.md`](THREEJS_UPGRADE.md).

Highest ROI is **typed game-state + the pure-logic modules you already test** (physics, terrain, course, avalanche, scoring) — not annotating every rendering object.

---

## Phase 0 — Baseline & safety net (½ day)

Goal: lock in a known-good state so every later phase is measurable.

- [ ] Confirm `npm test` and `npm run lint` are green on a clean checkout. Record current `c8` coverage as the baseline.
- [ ] Tag the pre-migration commit (e.g. `pre-ts-baseline`) so any phase can be bisected against it.
- [ ] Skim `ARCHITECTURE.md` §3 (global namespace) and §4 (injection seams) — the seams (`setTerrainFunction`, etc.) are your future typed boundaries.

**No code changes. Nothing to revert.**

---

## Phase 1 — Type-checking in place (2–4 days)

Goal: catch type bugs across the existing JS with **zero changes to how the game loads or deploys**. This is pure static analysis layered on top of your existing ESLint setup.

### 1.1 Add the type-checker

```bash
npm i -D typescript
npm i -D @types/three@0.160.0  # MUST match the r160 you load from CDN
```

> ⚠️ Version-match `@types/three` to your three version. Mismatches are a known source of
> phantom type errors. After the r160 upgrade, pin `@types/three@0.160.0`.

`tsconfig.json` (checks JS, emits nothing — no build artifact, deploy unchanged):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": false,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.js", "types/**/*.d.ts"],
  "exclude": ["node_modules", "dist", "coverage", "tests"]
}
```

(`tests/` is excluded initially to keep noise down; fold it in once `src/` is clean.)

### 1.2 Teach TS about the globals — mirror `eslint.config.js`

Your `eslint.config.js` already enumerates every global namespace (`Avalanche`, `Camera`, `Controls`, `CourseModule`, `Mountains`, `Snow`, `Snowman`, `Trees`, `Utils`, `THREE`, plus mutable state like `scene`, `velocity`, `gameActive`…). Create the **type-level twin** of that list at `types/globals.d.ts`:

```ts
import type * as THREE_NS from 'three';

declare global {
  // three.js r160, loaded as a global from cdnjs (not a module yet)
  const THREE: typeof THREE_NS;

  // Game module namespaces — attached to window by classic scripts.
  // Start loose, tighten as each module gets typed.
  const Avalanche: { AvalancheSystem: typeof import('../src/avalanche.js') extends never ? unknown : any };
  const Camera: any;
  const Controls: any;
  const CourseModule: any;
  const Mountains: any;
  const Snow: any;
  const Snowman: any;
  const Trees: any;
  const Utils: any;

  // Shared mutable game state (see ARCHITECTURE.md §3)
  let scene: THREE_NS.Scene;
  let snowman: THREE_NS.Object3D;
  let velocity: THREE_NS.Vector3;
  let gameActive: boolean;
  // …keep this in lockstep with the globals block in eslint.config.js
}

export {};
```

Treat `globals.d.ts` and the eslint globals list as **one logical thing kept in sync** — when you tighten a type here, you've documented the contract for that seam.

### 1.3 Turn on checking file-by-file, lean on existing JSDoc

You already standardize on "JSDoc-style comments for public functions" (`CLAUDE.md`). Now make those JSDoc comments *typed*, and flip files on one at a time:

- [ ] Add `// @ts-check` to the top of a file, run `npx tsc --noEmit`, fix what it flags, commit.
- [ ] Recommended order (pure logic first — highest value, already test-protected): **`avalanche.js` → `course.js` → `camera.js` → `trees.js` → `controls.js` → `effects.js` → `snow.js` → `mountains.js` → `snowman.js` → `snowglider.js`**. (`auth.js` / `scores.js` can go in parallel — they're already modules and Firebase ships its own types.)
- [ ] Define **domain typedefs** early (in JSDoc or `types/`), since they pay off immediately:

```ts
/** @typedef {'start'|'racing'|'finished'|'crashed'} GamePhase */
/** @typedef {(x:number, z:number) => number} TerrainHeightFn */ // the setTerrainFunction seam

/**
 * @typedef {Object} PlayerState
 * @property {THREE.Vector3} position
 * @property {THREE.Vector3} velocity
 * @property {number} verticalVelocity
 * @property {number} heading
 * @property {boolean} isInAir
 * @property {boolean} grounded
 */

/**
 * @typedef {Object} Gate
 * @property {string} id
 * @property {THREE.Vector3} center
 * @property {number} width
 * @property {boolean} passed
 */
```

These map straight onto state you already track (`velocity`, `verticalVelocity`, `isInAir`, `gameActive`, gates/checkpoints in `course.js`).

### 1.4 Wire it into CI

```jsonc
// package.json scripts
"typecheck": "tsc --noEmit"
```

- [ ] Add a `typecheck` step to your existing `.github/` workflow (run it alongside `lint` and `test`).
- [ ] Optionally gate it as `"warn"`-equivalent first (don't fail the build) until `src/` is clean, then make it blocking.

**Exit criteria for Phase 1:** every `src/*.js` has `// @ts-check`, `tsc --noEmit` is green and blocking in CI, `npm test` still green, deploy untouched. **At this point you can keep shipping features in JS indefinitely with a real safety net.** Phases 2–3 are optional and only worth it if you're committing to long-term growth.

---

## Phase 2 — Bundler + ES modules (1–2 weeks, incremental)

Goal: replace the CDN-global + script-injection model with an ES-module graph and a thin build, so the type system can actually flow across files (and so you *can* upgrade three.js — the global/UMD build is gone in modern three).

> This is the phase that changes your deploy model: from "GitHub Pages serves source directly" to "build to `dist/`, deploy `dist/`." `dist/` is already gitignored, so you're half-anticipating this.

### 2.1 Add Vite (recommended) or esbuild

```bash
npm i -D vite
npm i three@0.160.0 # pull the current r160 from npm instead of the CDN; latest is a separate step
```

`vite.config.js` — custom domain (snowglider.ai via CNAME) means `base: '/'`:

```js
import { defineConfig } from 'vite';
export default defineConfig({
  base: '/',
  build: { outDir: 'dist', sourcemap: true },
});
```

- [ ] Replace the CDN `<script src=".../0.160.0/three.min.js">` and the nested `src/*.js` injection in `index.html` with a single module entry: `<script type="module" src="/src/snowglider.js"></script>`. Vite resolves the import graph and ordering for you.
- [ ] Update the GitHub Pages workflow to `npm run build` and deploy `dist/` (e.g. via `actions/deploy-pages`), keeping the `CNAME` file in the published output.

> ⚠️ **Vite does not type-check** — it strips types and bundles. Keep `tsc --noEmit` in CI as the *real* type gate. Optionally add `vite-plugin-checker` for in-editor/dev feedback.

### 2.2 Convert globals → modules, one module at a time

For each module, in the dependency order from Phase 1:

1. Replace `class X {}` + `window.X = X` with `export`.
2. Replace global `THREE` reads with `import * as THREE from 'three'` at the top.
3. Replace consumers' global reads (`new Avalanche.AvalancheSystem(...)`) with `import { AvalancheSystem } from './avalanche.js'`.
4. **Update that module's test** — it currently injects a `mockTHREE` and relies on globals; once the module imports real three, switch the test to import the module and either mock `three` or run against real three under node. Keep the test green before moving on.
5. Remove the now-dead entry from `globals.d.ts` and from the eslint globals list.

Convert lowest-coupling pure-logic modules first; convert `snowglider.js` (the orchestrator holding most global state) **last**.

**Exit criteria for Phase 2:** `index.html` loads one module entry, no `window.*` namespace assignments remain, `three` comes from npm, `npm test` + `tsc --noEmit` + build + Pages deploy all green.

---

## Phase 3 — Rename to `.ts` and tighten (3–5 days, incremental)

Now that modules exist and are JSDoc-typed, renaming is mostly mechanical.

- [ ] Rename `.js` → `.ts` module-by-module; move JSDoc typedefs to real `interface`/`type` declarations.
- [ ] **Enable `strictNullChecks` first** — it's the single highest-value flag for this game (empty raycaster hits, optional mesh refs, `getTerrainHeight` before injection). Fix, commit.
- [ ] Then ratchet the rest: `noImplicitAny` → `strictFunctionTypes` → full `"strict": true`. One flag per PR; never big-bang `strict`.
- [ ] Replace the shared mutable globals (`scene`, `velocity`, `gameActive`, `avalancheTriggered`, `lastAvalancheZ`, `bestTime`…) with a typed `GameState` object passed through the loop, or typed module state. This is where `PlayerState` / `Gate` / `GamePhase` / `AvalancheState` become real types and refactors get safe.

**Exit criteria:** all `src` is `.ts`, `"strict": true`, no `any` in domain/logic modules (rendering may keep a few, documented).

---

## Parallel track — upgrade three.js

Independent of the type work, but split it into the stages described in
[`THREEJS_UPGRADE.md`](THREEJS_UPGRADE.md):

- **r134 → r160** can land before Phase 2 because r160 is the last CDN/global UMD build.
- **r160 → latest** must be sequenced after Phase 2 because r161+ are ESM-only and `THREE`
  must be imported rather than read from `window`.

Do it as its own step, not mixed with type changes:

- [ ] Bump `three` + `@types/three` together, in lockstep.
- [ ] Expect breaking changes — most notably **color management** (defaults changed in r152; outputs/lighting can shift), renderer output-encoding renames, and any `examples/jsm` addon path/API changes you use.
- [ ] Your **regression and physics-invariant tests + puppeteer visual smoke** are exactly the guardrail for this; lean on them and bump a few minor versions at a time rather than r134 → latest in one jump.

---

## Per-module migration order

Ordered by ROI: pure, already-tested logic first; the big stateful orchestrator last.

| Order | Module | Lines | Existing tests | Notes |
|------|--------|------:|----------------|-------|
| 1 | `avalanche.js` | 218 | `avalanche-tests`, browser | Clean class, already `dispose()`s. Easy first win. |
| 2 | `course.js` | 588 | (regression) | Gates/checkpoints → richest domain types (`Gate`, `Checkpoint`, `CourseSegment`). |
| 3 | `camera.js` | 232 | `camera-tests` | One class, no global state assigned — low friction. |
| 4 | `trees.js` | 393 | `tree-collision-tests` | Collision logic worth typing precisely. |
| 5 | `controls.js` | 494 | `controls-tests` (browser) | Typed input state. |
| 6 | `effects.js` / `snow.js` | 184 / 405 | (regression) | Rendering-heavy; type the public surface, allow internal looseness. |
| 7 | `mountains.js` | 427 | `terrain-tests` | Terrain height = the `TerrainHeightFn` seam. Pure parts are high-value. |
| 8 | `snowman.js` | 853 | (regression) | Large, visual + state. |
| 9 | `snowglider.js` | 1193 | `physics-tests`, invariant harness, dom smoke | **Last.** Main loop + most global state. Consider extracting a typed `physics.ts` here (you have `PHYSICS.md` + invariant tests to keep it correct). |
| ∥ | `auth.js` / `scores.js` | 521 / 562 | `audio`/regression | Already ES modules; Firebase ships its own types. Can be typed in parallel anytime. |

---

## What TypeScript will *not* catch (so don't expect it to)

You're already ahead on the usual three.js footguns — `avalanche.js` shows correct `.dispose()` and `instanceMatrix.needsUpdate` usage. The bugs that survive any migration are **semantic**, and for this codebase specifically:

- **Radians vs degrees** in `heading` / rotation math — types see `number` either way.
- **Coordinate-system / up-axis assumptions** in terrain and camera follow logic.
- **Aliasing of shared mutable globals** (`scene`, `velocity`, `snowman`): TS types the reference but won't catch spooky action-at-a-distance from mutation across modules. Phase 3's `GameState` refactor is the real fix, not types alone.
- **Disposal you don't already do** — keep watching new geometry/material/texture creation in `snow.js` / `effects.js` / `mountains.js`.

These belong to your existing test suite and `PHYSICS.md` discipline, not the compiler.

---

## Decision summary

- **Stop after Phase 1** if SnowGlider is feature-stable: you get a genuine safety net, zero deploy change, and you keep shipping in JS. This is a perfectly good place to rest.
- **Go through Phase 3** if you're committing to sustained growth (more hazards, progression, the snowglider.ai "AI" features in your `ROADMAP.md`): full type flow + a typed `GameState` makes that feature work dramatically safer to refactor.
- **Always** keep `npm test`, `tsc --noEmit`, and the Pages deploy green at every step. Nothing here requires a big-bang rewrite, and every phase is independently revertable.
