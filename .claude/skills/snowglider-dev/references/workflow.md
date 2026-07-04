# SnowGlider — Workflow, Testing & CI Playbook

How work actually lands in this repo without breaking the deterministic sim, the deploy, or CI.

---

## The acceptance gate (run before you call a change done)

```
npm run typecheck        # tsc --noEmit  (src)
npm run typecheck:tests   # tsc -p tsconfig.tests.json  (drift-checks @ts-check suites vs typed src)
npm run lint              # eslint .
npm test                  # auto-discovering Node suite
npm run test:verify       # byte-identical coasting + DOM smoke — the physics gate
npm run build             # vite build (must emit clean dist/)
```
For anything touching physics/collision/avalanche also run `npm run test:stress` (the frame-rate
matrix). For anything touching a specific subsystem, run its targeted `test:*` (see `package.json`;
there are ~70 of them — e.g. `test:camera`, `test:scenery`, `test:sfx`, `test:tree-shed`).

---

## Testing philosophy

- **The Node runner auto-discovers.** `npm test` → `tests/run-node-suite.js` finds every
  `tests/*-tests.js` and `tests/verification/*.js` and runs each in its own child `node` process.
  **Adding a Node suite needs no `package.json` edit — drop in `tests/<name>-tests.js`.** Documented
  denylists: browser-context suites (`browser-*`, `audio`/`camera`/`controls-tests.js`) and the
  emulator-only `firestore-rules-tests.js`. Every suite loads with the superset
  `register-firebase-mock.mjs` hook (Firebase-CDN mock layered over the `.js`→`.ts` resolve
  fallback; both sub-hooks are conditional no-ops).
- **Ship the fix with a headless test that fails against the old code.** This is the repo norm — a
  test that only passes post-fix doesn't prove it caught the bug. State explicitly that the assertion
  fails on the pre-fix condition.
- **Prove invariants with the seeded, frame-rate-swept harnesses** (`tests/verification/`):
  - `physics_invariant_harness.js` — coasting == frozen baseline, diff `0`, **gates exit code**.
  - `forward_stress_harness.js` — input × frame-rate matrix (incl. adversarial "steer into nearest
    tree" + jump-spam at 60/30/10 FPS + GC-pause spikes): no tunneling, no speed balloon, no NaN,
    every descent terminates.
  - `fixed_timestep_harness.js` — 30/50/144 FPS + jitter traces a byte-identical path to 60 FPS.
  - `avalanche_framerate_harness.js` — 10/60 FPS front-travel ratio ≈ 1.
  - `winnability_harness.js` / `plausibility_floor_harness.js` — the avalanche stays winnable and
    times stay plausible after a speed-touching change (a green invariant harness is *not* enough).
  - `dom_smoke_test.js` — jsdom + mocked THREE boots `effects.ts`/`course.ts`.
- **Type-check the tests.** `npm run typecheck:tests` drift-checks `// @ts-check` Node suites against
  typed `src` (it caught invalid camera-mode literals). A targeted `test:*` script that runs plain
  `node` on a suite importing `.ts` needs `--import ./tests/loaders/register-ts-resolve.mjs` (Node
  does *not* remap `.js`→`.ts`; only Vite/tsc do). `ERR_MODULE_NOT_FOUND` = missing the resolver.
- **Coverage is merged honestly.** c8 (Node) + Chromium V8 (browser) + Playwright LCOV are
  *line*-merged (`coverage:merge`) because type-stripping and esbuild emit different statement
  structure for the same file. New Node tests must land in the c8 path to be counted.
- **Beware green ≠ covered.** Echo-stub scripts (`echo 'Controls tests require browser…'`) contribute
  *zero* coverage while looking passing (#126); a mock that doesn't model `.shadow` produces a
  false-pass (#297). Logic/physics suites are structurally blind to the most common bug class here —
  **visual/rendering** regressions (whiteout, grey corduroy, muddy snow; #248). Visual baselines
  can't be committed (`main` is text/binary-free; host-font/GPU dependent), so canvas snapshots are
  double-gated behind `VISUAL_CANVAS=1`.

---

## The physics baseline (regenerate rarely, carefully)

- Regenerate `tests/verification/snowman_baseline.js` **only** on an intentional physics change,
  when `test:verify` diff is *expected* to be non-zero.
- **Never** `git show :src/snowman.ts > baseline.js`. The baseline is a *classic script* (global
  `THREE`, `window.Snowman`, `vm.runInContext`); `src/snowman.ts` is ESM. A raw copy writes
  `import`/`export`, silently populates nothing, and fails the next run (#137). Port the changed
  `updateSnowman` into the classic-wrapper shape.
- If the diff is non-zero and you did *not* mean to change physics, the gating on your new mechanic
  leaked — fix the input/tier/provenance gate, don't touch the baseline.

---

## Screenshots & visual verification

- **Show the real player path, never the automation cone fallback.** Headless
  puppeteer/Playwright set `navigator.webdriver = true`, so the EZ forest serves stylized cones
  and intro/debris/sfx serve their reduced forms — a naive shot misrepresents the game. Force the
  player path: append `?eztrees=1` (overrides the automation gate via `resolveEzForestEnabled`)
  and/or defeat the gate in an init script
  (`Object.defineProperty(navigator,'webdriver',{get:()=>false})`).
- **Sanity-check before embedding:** assert the EZ branch instances actually attached, e.g.
  `terrainMesh.parent.children.some(c => c.userData.forestPart === 'ezBranches')`.
- Drive the real app (vite dev server + puppeteer with `PUPPETEER_EXECUTABLE_PATH` at system
  Chrome — see `tests/puppeteer-runner.js`). Show before/after for changed visuals.
- **Never commit screenshots/PNGs into the repo tree** (`main` stays text-only; media uses Git LFS).
  Host PR screenshots off-tree: push the PNG(s) to a throwaway `assets/*` branch via the Git Data
  API (blob → tree → parentless commit → `refs/heads/assets/<name>`) and embed
  `https://raw.githubusercontent.com/<owner>/<repo>/assets/<name>/<file>.png`. Confirm each raw URL
  returns HTTP 200 before relying on it.

---

## Branch / PR hygiene

- **The stacked-branch trap.** A PR stacked on a branch that merges into `main` *first* shows
  "merged" on GitHub but its commits **never propagate to `main`** — and repo CI only runs on
  `base=main` PRs, so a stacked PR gets `0` check-runs. The miss is silent (#312). Tripwire: `0`
  check-runs; ground truth: `git merge-base --is-ancestor <merge_sha> origin/main`. **Don't stack a
  follow-up on a branch about to merge — fold it in or target `main`.** There's a CI guard against
  silently missing main (#318) and `scripts/audit-missed-main.mjs`.
- **Ordered, byte-identical PR stacks** are the house style for large features: each PR independently
  mergeable, `main` deployable after every one, docs updated in the *same* PR, fixed acceptance gate.
  Ship a risky subsystem as an **empty seam first** (scenery #320 PR 1) so invariants land and pin
  before any visual layer.
- If your designated branch's PR was already merged, restart from the latest default branch (same
  branch name) for follow-up work — don't stack new commits on already-merged history.

---

## CI / deployment (least-privilege)

- **GitHub Pages publishes only after the test job passes.** A CI guard rejects raw `.ts` in the
  `dist/` artifact (the Pages build transpiles copied `dist/src/**/*.ts` to `.js`; don't publish raw
  `.ts` as the only browser-test target — #98).
- **Merging to `main` does NOT auto-deploy `firestore.rules`** — only Pages deploys (#235). Rules go
  out via a separate REST deploy after tests pass (#250/#264). Deploy rules *before* purging data;
  a clean-looking board doesn't prove a purge ran (the client filter hides a bad doc identically
  whether it was deleted or not).
- Workflows stay least-privileged and must **not** publish `node_modules/`, `coverage/`, test
  artifacts, or local-only files.
- `npm run lint` green does **not** mean TS lint coverage — ESLint's `no-unsafe-*`/`no-explicit-any`
  are *warnings* (surfaced as debt via reviewdog), not errors; new code is still expected to type its
  boundaries.

---

## Mobile — the perennial second surface (CI can't see it)

- Touch handlers are a distinct failure class ("dead-button" #50/#231); use standard handlers with
  `{ passive: false }`; camera controls are explicit UI or **two-finger** gestures — never one-finger
  steering (that's reserved for the gameplay steer). Exclude UI trays from gameplay touch steering.
- **Auth is popup-only on all devices** (redirect flow was abandoned, #23); handle popup-blocked /
  popup-closed-by-user; degrade to localStorage when Firebase is unavailable.
- **Audio needs a user gesture** and can be suspended: the Web Audio context is created/resumed only
  inside the start/restart-button gesture (`Sfx.unlock()`); iOS routes Web Audio through the hardware
  silent switch. Treat audio changes as high risk — **mobile playback is not verified on real
  devices** (#249); test on hardware before relying on it.
- Low frame-rate on mobile interacts with physics: a frame-rate fix silently rebalanced avalanche
  winnability for iPhone players (#229). Re-check winnability/plausibility after any speed change.
