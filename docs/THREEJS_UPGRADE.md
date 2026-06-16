# SnowGlider — three.js Upgrade Roadmap (r134 → r160 → latest)

> Move off the pinned **three.js r134** toward the current release — without breaking
> the GitHub Pages deploy to snowglider.ai, and **without entangling the upgrade with
> the TypeScript migration** ([`TYPESCRIPT_MIGRATION.md`](TYPESCRIPT_MIGRATION.md)).
> This is the "parallel track" that doc defers; here is the concrete plan.

## Status

- **Before PR #76:** three.js **r134**, loaded as a **browser global** from a CDN `<script>`:
  `index.html` → `https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js`.
  `package.json` also pins `three@^0.134.0` (used by `tests/terrain-tests.js`, which does
  `require('three')`). No bundler, no build step.
- **After PR #76:** three.js **0.160.0** in both the CDN tag and npm, with
  `@types/three@0.160.0` checked by the TypeScript Phase 1 gate from main.
- **Latest:** three.js **0.184.0** / `@types/three` **0.184.1** (npm, at time of writing).
- **Guardrail:** `npm test`, `npm run lint`, `npm run typecheck`, the verification harness,
  and the puppeteer browser smoke must stay green after every step. No step may leave `main`
  un-deployable or visibly broken.

## TL;DR — the hard constraint that shapes everything

**three.js dropped the UMD / browser-global build at r161.** The last version that ships a
`three.min.js` you can load with a plain `<script>` (setting `window.THREE`) is **r160**.
Verified against both cdnjs and jsdelivr:

| Version | `build/three.min.js` (UMD global) |
|--------:|:----------------------------------|
| r134 (PR #76 base) | ✅ present |
| 0.160.0 | ✅ **present — last UMD build** |
| 0.161.0 | ❌ gone |
| 0.184.0 (latest) | ❌ ESM-only (`three.module.js`, `three.core.js`) |

So "upgrade to latest" is **not one move**. The current `<script>`-global +
global-namespace architecture (see [`ARCHITECTURE.md`](ARCHITECTURE.md) §1–§3) physically
**caps out at r160**. Reaching r161+ requires ES modules — which is exactly **Phase 2 of the
TypeScript migration**. Therefore:

1. **Stage A — bump r134 → r160 in place (no architecture change).** Still a CDN `<script>`
   global. This is where the *real* work and visual risk live: it crosses the **color-management
   default (r152)** and the **physically-correct-lights default (r155)**. Independently
   shippable in PR #76, with the TypeScript checker already active. **High value, self-contained.**
2. **Stage B — r160 → latest, after ES modules exist.** Sequenced **after** TS-migration
   Phase 2. `THREE` comes from npm via `import * as THREE from 'three'` (bundler) or an
   **import map** (keeps the no-build static-site model). Mostly mechanical once Stage A's
   color/lighting tuning is already done.

> This **refines** the note in [`TYPESCRIPT_MIGRATION.md`](TYPESCRIPT_MIGRATION.md)
> ("upgrade three.js off r134 … sequence it after Phase 2"). True for *latest*, but you don't
> have to wait: **r134 → r160 is reachable now**, and it front-loads the only genuinely risky
> part (color/lighting), isolated from the architecture change.

---

## Why this is low-coupling for SnowGlider

A scan of the codebase shows the upgrade surface is small and well-bounded:

- **No `examples/jsm` addons.** No `OrbitControls`, `GLTFLoader`, post-processing, etc. —
  the addon path/API churn that dominates most three upgrades **does not apply here**.
- **No removed legacy APIs.** No `THREE.Geometry`, `Face3`, `.faces`, `FaceColors`/`VertexColors`
  (all removed by r125, before our r134 baseline).
- **The renderer surface is tiny:** one `WebGLRenderer({ antialias: true })`,
  `shadowMap.enabled = true`, `scene.background = new THREE.Color(0x87CEEB)`
  (`src/snowglider.js:11-15`). No `outputEncoding` / `toneMapping` set explicitly.
- **Lights:** one `AmbientLight(0xffffff, 0.5)` + one `DirectionalLight(0xffffff, 0.8)`
  (`src/snowglider.js:106-112`).
- **Materials:** all `MeshStandardMaterial` with hex / `setHSL` colors across
  `snowman.js`, `trees.js`, `mountains.js`.

That profile means the **entire risk reduces to two semantic changes** (color + lights), both
landing inside Stage A. Everything else is a version-string bump.

---

## Phase 0 — Baseline & visual safety net (½ day)

The physics tests won't catch a rendering regression. The guardrail for *this* migration is
visual, so capture it first.

- [ ] Confirm `npm test`, `npm run lint`, and `npm run test:verify` are green on a clean
      checkout of this branch's base.
- [ ] **Capture reference screenshots on r134** before touching anything: drive `index.html`
      headless (extend `tests/puppeteer-runner.js`) and save canvas screenshots at a few fixed
      points — start pose, mid-run, a tree cluster, the result screen. These are the
      before/after the color/lighting work is judged against. (Pixel-exact diffs aren't
      required; a human eyeball compare of paired PNGs is enough to catch a washed-out or
      over-bright scene.)
- [ ] Note the two CDN spellings: old tags are `…/three.js/r134/three.min.js`; numeric
      releases are `…/three.js/0.160.0/three.min.js`. The bump changes **both** the path
      segment and the prefix.

**No code changes. Nothing to revert.**

---

## Phase A — r134 → r160, in place (1–2 days)

> **✅ Implemented in PR #76.** Chose **Option 1 (preserve the r134 look)** — the three opt-out
> lines below, all in `src/snowglider.js`. Verified: `npm run lint`, `npm run typecheck`
> (TypeScript Phase 1 from main, with `@types/three@0.160.0`), full `npm test` (terrain 7,
> physics 6, regression 9, tree-collision 3, avalanche 11, auth 23, invariant + DOM smoke 18,
> all against three@0.160), and `npm run test:browser` (**79 passed, 0 failed**, system Chrome,
> real `index.html` on the r160 CDN build). No architecture change.
>
> One r160 behavior change surfaced and was fixed in the same PR: `InstancedMesh` now
> frustum-culls against a cached bounding sphere, which would have made the avalanche's
> hidden-then-moved boulders invisible — `avalanche.js` now sets `frustumCulled = false`
> (with a real-module regression test).
>
> A headless capture after Start confirmed the preserved look — `THREE.REVISION = 160`,
> `ColorManagement.enabled = false`, no page errors, and the original colors (sky / snow /
> trees / snowman) intact. (Kept out of the repo to avoid a binary in history; attach such
> shots to the PR instead.)

Goal: land on the **last UMD build** with **zero** change to how the game loads or deploys.
Pure version bump + color/lighting reconciliation.

### A.1 Bump the version in lockstep — **including the lockfile**

This repo commits `package-lock.json`, and `npm ci` only *installs* an existing lockfile — it
does not update one. So bump the CDN URL, `package.json`, **and** `package-lock.json` together,
using `npm install` (not `npm ci`) so the lockfile is regenerated before tests run:

- [ ] `index.html` CDN `<script>`: `…/three.js/r134/three.min.js` → `…/three.js/0.160.0/three.min.js`.
- [ ] Add an SRI `integrity` hash and `crossorigin="anonymous"` to the CDN tag.
- [ ] `npm install three@0.160.0 --save-exact` — updates `package.json`
      (`"three": "^0.134.0"` → `"three": "0.160.0"`), **`package-lock.json`**, and `node_modules`
      in one step. Pin exact: the CDN and npm copy must be the *same* version so
      `terrain-tests.js`'s `require('three')` exercises the shipped version.
- [ ] Bump `@types/three` to exact `0.160.0` in the same step; a mismatched `@types/three`
      is a known phantom-type-error source now that the Phase 1 checker runs on main.
- [ ] `npm test` (terrain/physics now run against three@0.160), `npm run lint`, and
      `npm run typecheck` stay green.

> Verified flow: `npm install three@0.160.0 --save-exact` regenerated the runtime lockfile
> cleanly; `@types/three` was then version-matched to `0.160.0`, and the latest TypeScript
> checker from main passed. (The harmless `require('three/package.json')` resolution error
> you may see is just three's `exports` map — it does not affect `require('three')`.)

### A.2 Decide the color-management posture — **the load-bearing choice**

**r152 turned `THREE.ColorManagement.enabled = true` on by default** and renamed
`renderer.outputEncoding` → `renderer.outputColorSpace` (sRGB output by default). Authored hex
colors are now treated as sRGB and converted to linear for lighting math. The scene **will look
different** unless handled deliberately. Two viable postures — pick one explicitly:

- **Option 1 — Preserve the r134 look (lowest risk, recommended for the first landing).**
  Opt out so pixels stay as close to today as possible:
  ```js
  THREE.ColorManagement.enabled = false;          // before creating materials
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  ```
  Ship the version bump with the *current* art direction intact; treat adopting modern color as
  a separate, later visual-polish change.
- **Option 2 — Adopt modern color management.** Leave defaults on, then **re-tune light
  intensities and any colors that shift** against the Phase 0 screenshots. More work, better
  long-term, but it mixes "upgrade" with "art change" — defer unless you want the nicer output now.

> Recommendation: **Option 1** for this PR. Get onto r160 with an unchanged look, prove the
> deploy and tests, then adopt modern color/lighting as its own reviewable change.

### A.3 Reconcile lighting (default flipped at r155)

`physicallyCorrectLights` was replaced by `useLegacyLights`, and **r155 flipped its default to
`false`** (physically-correct lighting on). That **rescales light intensity units**, so
`AmbientLight(…, 0.5)` / `DirectionalLight(…, 0.8)` (`src/snowglider.js:106-107`) will render at
a different brightness on r160 than on r134.

- [ ] To preserve the r134 look alongside Option 1, set `renderer.useLegacyLights = true`
      explicitly (still available at r160; **removed at r165** — note for Stage B). Verify
      against the Phase 0 screenshots.
- [ ] If adopting modern lighting (Option 2), re-tune the two intensities until the snow/scene
      brightness matches the reference, then update the values in `src/snowglider.js`.

### A.4 Test & visual gate

- [ ] `npm run lint`, `npm test`, `npm run test:verify` green.
- [ ] `npm run test:browser` (puppeteer) green — this loads the **real** `index.html` against the
      new CDN version, so it exercises r160 end to end.
- [ ] Eyeball Phase 0 before/after screenshots: no washed-out, over-bright, or color-shifted
      scene. Sky (`0x87CEEB`), red skis (`0xFF0000`), carrot (`0xFF6600`), tree greens
      (`setHSL`) are the quickest tells.

**Exit criteria for Phase A:** game loads three **r160** from CDN, look matches r134 (or is
deliberately re-tuned and signed off), all suites + deploy green, **architecture unchanged**.
Shippable as its own PR; after PR #74, the Phase 1 TypeScript checker is an additional gate.

---

## Phase B — r160 → latest (≈0.184), after ES modules

**Blocked on TypeScript-migration Phase 2** (ES modules + bundler/import-map). r161+ ship no
global build, so `THREE` must be imported, not read off `window`. Do **not** start Phase B until
`index.html` loads modules instead of the `<script>`-chain in [`ARCHITECTURE.md`](ARCHITECTURE.md) §2.2.

### B.1 Source `THREE` as a module

Once modules exist, two ways to get latest three while keeping deploys sane:

- **Import map (keeps the no-build static-site model — preferred if staying build-less):**
  ```html
  <script type="importmap">
  { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js" } }
  </script>
  ```
  Modules then `import * as THREE from 'three'`. No bundler, still copy-deploys to Pages, but
  **note `file://` import maps are blocked by CORS** — `open index.html` would need the dev
  server (`npm start`). Weigh against the `file://`-fallback design in `ARCHITECTURE.md` §7.
- **Bundler (Vite):** per `TYPESCRIPT_MIGRATION.md` §2.1; `import * as THREE from 'three'`,
  `npm i three@0.184`, build to `dist/`, deploy `dist/`.

### B.2 Bump and clear the r160→r184 deltas

- [ ] Bump `three` + `@types/three` **together** to 0.184.x.
- [ ] **`useLegacyLights` was removed at r165** — the A.3 escape hatch is gone. By here, lighting
      must already be tuned for physically-correct units (finish the Option 2 work if Stage A
      shipped Option 1).
- [ ] Re-run the full suite + visual gate. Bump **a few minor versions at a time** (e.g.
      160 → 168 → 176 → 184), not in one jump, so a regression is bisectable.
- [ ] No `examples/jsm` today, so addon-path breakage is N/A — but re-check if any addon is added
      before this phase runs.

**Exit criteria:** game runs latest three via module import/import-map, full suite + visual gate
+ Pages deploy green.

---

## Risk register

| Risk | Where | Mitigation |
|------|-------|-----------|
| **Color-management default (r152)** shifts all colors/brightness | every `MeshStandardMaterial`, `scene.background` | A.2: opt out (`ColorManagement.enabled=false`) first; adopt later as its own change |
| **Physically-correct lights default (r155)** rescales intensity | `snowglider.js:106-107` | A.3: `useLegacyLights=true` at r160, or re-tune intensities |
| **`useLegacyLights` removed (r165)** | renderer | Must tune for modern lighting **before** crossing r165 (Stage B) |
| **CDN vs npm version skew** | `index.html` vs `package.json` (`terrain-tests.js` uses npm three) | A.1: bump both to the identical version |
| **No visual regression test exists** | rendering | Phase 0: capture reference screenshots; gate on eyeball diff |
| **`file://` fallback breaks under import maps** | Stage B | B.1: accept dev-server requirement or choose the bundler path |
| **Big-bang r134 → r184** | everything | Never; stage at r160, then step minors in Stage B |

**What the compiler / tests will *not* catch:** the color/lighting shifts are *valid* code that
merely *looks* wrong. Only the Phase 0 screenshots catch them. Treat the visual gate as the
real acceptance test for this migration, the way `PHYSICS.md`'s invariant harness is for physics.

---

## Decision summary

- **Do Stage A (r134 → r160) now, as its own PR.** It is fully decoupled from the TypeScript
  work, front-loads the only real risk (color + lights) while the architecture is still simple,
  and lands you on the newest version the current `<script>`-global model can run. **Highest ROI,
  lowest coupling.**
- **Gate Stage B (r160 → latest) behind TypeScript-migration Phase 2.** It is genuinely blocked
  by the ESM-only builds; attempting it before modules exist means rewriting the load model and
  the upgrade at once. Don't.
- **Always** keep `npm test`, `npm run test:verify`, the puppeteer smoke, and the Pages deploy
  green, and **judge every step against the Phase 0 reference screenshots** — the test suite
  alone cannot see a washed-out mountain.

### Reference

- Official three.js migration notes: <https://github.com/mrdoob/three.js/wiki/Migration-Guide>
  (read the r135 → r160 entries; color management is r152, lighting default is r155,
  `useLegacyLights` removal is r165).
- Companion plans: [`TYPESCRIPT_MIGRATION.md`](TYPESCRIPT_MIGRATION.md) (Phase 2 unblocks Stage B),
  [`ARCHITECTURE.md`](ARCHITECTURE.md) §2 (load order), [`tests/README.md`](../tests/README.md)
  (where the visual smoke lives).
