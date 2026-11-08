---
name: snowglider-dev
description: >
  Engineering discipline and hard-won lessons for developing the SnowGlider game
  (Three.js + TypeScript + Vite skiing sim in this repo). Use this skill whenever you
  add, change, refactor, or review code under src/, tests/, docs/, index.html, or the
  CI/Firebase config — especially anything touching physics, the game loop, terrain,
  trees/scenery, snow, avalanche, camera, jumps, controls, snowman, audio/sfx, scoring,
  Firebase/auth, teardown/dispose, or the test harnesses. It encodes the invariants the
  codebase enforces (determinism, byte-identical no-input physics, seeded-RNG neutrality,
  fixed-timestep frame-rate independence, teardown safety, automation gating) and the
  recurring bug classes that Codex review and past regressions keep catching, so changes
  don't break skiing physics, collision, test streams, or the GitHub Pages deploy.
---

# SnowGlider Development — Invariants & Bug-Class Playbook

This is the cross-cutting engineering discipline for this repo, distilled from ~220 commits,
Codex code-review threads, GitHub issues, and the invariant docs. It **complements** — does
not repeat — the root [`CLAUDE.md`](../../../CLAUDE.md) (module map, commands, style) and the
[`webgpu-threejs-tsl`](../webgpu-threejs-tsl/SKILL.md) skill (WebGPU/TSL reference). Read those
for *what things are*; read this for *how not to break them*.

**Golden rule of this codebase:** a real-time deterministic physics kernel sits under a pile of
cosmetic layers. Nearly every regression here comes from a change that *looked* local but
perturbed the kernel, its seeded RNG stream, a shared flag, an async ordering, or the teardown
path. Before you touch anything, know which side of the physics/cosmetic line you are on.

## Pre-flight checklist (run through this before writing code)

1. **Am I on the physics/collision side or the cosmetic side?** Cosmetic layers (camera, snow,
   flex, tracks, wind, scenery, sfx, powder) must be **render-only · collision-neutral ·
   physics-neutral · `Math.random`-stream-neutral · teardown-safe** and tick in the render-frame
   zone, **never** inside the fixed physics substep. They read the per-frame physics *result*
   only — never `pos`/`velocity`, never write them.
2. **Will the no-input coasting trajectory stay byte-identical?** New gameplay behavior must be
   gated behind an input flag / per-tier tuning field / provenance tag. If `npm run test:verify`
   reports a non-zero max-abs diff on the frozen baseline, the gating leaked — **stop and fix the
   gate**, don't regenerate the baseline.
3. **Does my change construct any THREE object on a seeded path?** `Group`/`Mesh`/`Material`/
   `BufferGeometry`/`clone()` all draw `Math.random()` 4× for UUIDs. Wrap construction in
   `withPrivateThreeRandom(...)` and draw placement from a seeded PRNG (`makeSceneryRng`),
   never global `Math.random`.
4. **Am I reusing an existing flag or state variable?** Audit *every* reader before repurposing
   it (the #1 Codex-caught bug). `playerJump` is the classic trap.
5. **Does my change allocate anything?** Then it must be freed on teardown — enumerate every
   allocation site. `InstancedMesh` buffers, module singletons, `window.*` handles, timers,
   observers, listeners, audio, DOM nodes are all leaks-in-waiting.
6. **Is there async between "record intent" and "have the asset"?** Don't arm colliders / start a
   ranked run before awaited assets exist; cancel in-flight builds on teardown.
7. **Is this frame-rate dependent?** Physics runs only in `FIXED_DT = 1/60` substeps via an
   accumulator. Never mix a per-frame multiplier (`v *= 1−k`) with delta-scaled forces
   (`v += a·dt`). Delta-scale cosmetic animation too.
8. **What proves it?** Add/adjust a headless test that **fails against the old code**. Then run
   the gate: `npm run typecheck && npm run typecheck:tests && npm run lint && npm test &&
   npm run test:verify && npm run build`.

## The hard invariants (never violate these)

| Invariant | Guard / API | Breaks if… |
|---|---|---|
| No-input physics is **byte-identical** to the frozen baseline | `tests/verification/physics_invariant_harness.js` (`test:verify`) gates exit on max-abs diff `0`; gate new behavior behind `controls.*` / per-tier tuning / provenance flags | you add ungated randomness or force to the grounded path |
| Seeded `Math.random` stream is **not perturbed** | `withPrivateThreeRandom(fn)` (`src/scenery/scenery-rng.ts`; original in `mountains/trees.ts` `getSwayDepthMaterial`); `makeSceneryRng(seed)` for placement | any THREE construction on a seeded path draws UUID randomness |
| Physics is **fixed-timestep & frame-rate independent** | `FIXED_DT=1/60`, `MAX_SUBSTEPS=8` accumulator in `src/game/main-loop.ts`; `src/diagnostics.ts` (`Diag`) detects it live | per-frame factor mixed with dt-scaled force; per-step > collision radius (tunneling) |
| Terrain height **two-formula contract** | `createTerrain()` mesh term and `getTerrainHeight(x,z)` sampler are commented `MUST MATCH`; edit in lockstep; key `heightMap` per tier/run | you edit one path only → snowman floats/sinks; or stale cache serves old heights |
| Collision arrays are the **single source of truth** | only `treePositions` / `rockPositions` drive collisions; `course-line.ts` `laneX(z)` is the one centerline | a cosmetic layer writes them, or path math is duplicated |
| Cosmetics never mutate kernel state | read per-frame result only; snow-splash restores `pos` after moving particles | you write `pos`/`velocity`/`rotation.y` from a cosmetic tick |
| Everything is **teardown-safe & idempotent** | `dispose()` (56× in src); `test:leak`, `test:teardown` pin it; build-epoch cancels in-flight async | a singleton/`window.*` closure/`InstancedMesh` buffer/timer survives dispose |
| Automation serves a **reduced deterministic scene** | gate heavy/nondeterministic features off under `window.isTestMode \|\| navigator.webdriver \|\| ?test=`; opt in via `window.testHooks.*` | you screenshot the automation path and think the game is broken |
| No `window.*` module bridges | modules `import` each other; only `AuthModule`/`ScoresModule` + boot/test seams stay global | you re-add `window.Mountains`/`window.Camera`/`THREE` |
| Run clock ↔ physics pause **together** | `src/game/run-clock.ts` shifts `startTime` on tab-hide and skips stepping while hidden | a throttled background rAF banks free distance (cheat) or inflates times |
| Never trust the client for score validity | `MIN_VALID_SCORE_TIME` enforced **client + server** (`firestore.rules`); guests kept out of Firestore | you enforce only client-side, or forget rules deploy is not auto |

Full detail with WHY and concrete commit examples: [`references/invariants.md`](references/invariants.md).

## Codex / regression bug-class self-check

These are the classes that review and past regressions catch over and over. Before you finish,
re-read your diff hunting for each:

1. **Shared-flag repurposing** — you set a boolean for feature X; another subsystem still reads it
   as something else (e.g. reusing `playerJump` granted free avalanche-dodge immunity, PR #333 P1).
   *Audit every reader; introduce a narrower provenance flag instead.*
2. **State leaking across a boundary** — transient vs. persisted, mode-switch, run-restart,
   first-frame vs. steady-state (camera cluster #306/#310/#319). *Reset transients on
   `initialize()`/`setMode()`; use the same framing math on first frame and steady state.*
3. **Teardown incompleteness** — assume *nothing* is auto-freed; enumerate every allocation
   (module singletons, `window.*`, `InstancedMesh.dispose()`, timers, observers, audio, toasts).
4. **Async gaps** — collider/run started before awaited assets exist; an RNG swap held across an
   `await`; a stale closure firing post-dispose; multiple pending builds gating "ready" (#285).
5. **Frame-rate dependence** — a decision moved on/off the fixed grid; interpolation reseeded on
   no-step frames; update→check→reset ordering broken; free-time cheat on hidden tabs (#224/#278).
6. **Incomplete consumer updates** — a new data field / new mode / raised constant not propagated
   to *all* render sites, fixtures, and config paths (denormalized names #277; plausibility floor
   broke fixtures #233).
7. **Within-frame side-effect ordering** — a terminal outcome overwritten by a later check (crash
   then finish records a score #290); score banked *after* it's read (#289).
8. **Perf-budget violations** — per-object geometry instead of pooling/instancing; a new shader
   program; a `DoubleSide` material adding a program (`perf-budget.spec.ts` has a tight ceiling).
9. **Security / deploy ordering** — unescaped user strings in a DOM renderer (XSS #276); a client
   change racing a `firestore.rules` deploy (#277 — self-heal with a retry).

Concrete examples and the fix for each: [`references/bug-classes.md`](references/bug-classes.md).

## Workflow, testing & CI

- **Tests auto-discover.** Drop `tests/<name>-tests.js` in — the runner picks it up, no
  `package.json` edit. Ship the fix *with* a headless test that fails against the old code.
- **Prove invariants with the seeded, frame-rate-swept harnesses** in `tests/verification/`
  (`test:verify`, `test:stress`) — coasting diff `0`, no tunneling at 10/30/144 FPS, no NaN,
  every descent terminates.
- **Type-check tests too:** `npm run typecheck:tests` drift-checks `// @ts-check` suites against
  typed `src`. Targeted `test:*` scripts running plain `node` need the `.js`→`.ts` resolve hook.
- **Baseline regen is deliberate and fiddly** — only on an intentional physics change, and never
  by copying `src/snowman.ts` verbatim (ESM `import`/`export` breaks the classic-script harness).
- **Screenshots must show the real player path**, not the automation cone fallback — force
  `?eztrees=1` and/or defeat the `navigator.webdriver` gate, and assert `ezBranches` attached.
  Never commit PNGs into the tree; host off-tree and embed by raw URL.
- **Stacked-branch hazard:** a PR stacked on a branch that merges first shows "merged" but its
  commits silently never reach `main` (and skip CI). Verify with
  `git merge-base --is-ancestor <sha> origin/main`. Keep feature stacks ordered, each
  independently mergeable and `main`-deployable after every one.
- **Deploy least-privilege:** Pages publishes only after tests pass; `firestore.rules` is a
  separate REST deploy (merging to `main` does **not** auto-deploy rules); never publish
  `node_modules/`, coverage, or test artifacts.

More: [`references/workflow.md`](references/workflow.md).

## Where the deeper truth lives

- `docs/PHYSICS.md` — terrain/skiing/jump/collision/avalanche model + the byte-identical rules.
- `docs/DIAGNOSTICS.md` — the frame-rate-dependence bug class (#209) and the `Diag` detector.
- `docs/ARCHITECTURE.md` — module load order, injection seams, the `window.*` boundary (§3).
- `docs/CHANGELOG.md` — the running narrative of *why* each change was shaped the way it was.
- `tests/README.md` — the auto-discovery runner, denylists, and the loader hooks.
