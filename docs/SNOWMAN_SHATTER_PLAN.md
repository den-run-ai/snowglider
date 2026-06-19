# SnowGlider — Expressive Snowman: Flex, Scarf & Crash Shatter

> Implementation proposal for **[issue #53](https://github.com/den-run-ai/snowglider/issues/53)**
> — *"more realistic snowman: scarf, flexible, breaks down on impact"* — and Roadmap
> **Finding #11 (Personality & fail-state fun)** / **P2 (Make it memorable)**. This is a
> design/plan doc in the spirit of [`REFACTORING_SNOWGLIDER_SNOWMAN.md`](REFACTORING_SNOWGLIDER_SNOWMAN.md):
> it specifies the modules, the data flow, the code seams, and a mergeable PR sequence
> so the actual implementation PR(s) are mechanical.

---

## 1. Goal

Three user-visible upgrades, in rising order of risk:

1. **Flexible / "wiggly" snowman** — the body squashes, stretches, and jiggles as it
   skis: head bob, a settle-bounce on landing, lean into carves. Makes the snowman read
   as *alive* rather than a rigid stack of spheres.
2. **Breaks down on impact** — on a **crash** (tree / rock / off-mountain / fell-off /
   avalanche burial — *not* a finish), the snowman bursts apart: the three balls, hat,
   nose, arms, and buttons fly off as tumbling fragments while a puff of snow splashes
   out. The classic SkiFree-style wipeout.
3. **Scarf** *(optional follow-up — see §12 PR C)* — a red knitted scarf around the neck
   with a tail that trails in the wind. **Deferred out of the core work**: the
   overlapping neck geometry and trailing tail are the fiddliest, most iteration-prone
   piece of #53, so it's quarantined into its own PR. The flex animator and shatter
   system are both built to pick the scarf up automatically once it exists, so A/B don't
   depend on it and it can land later or be dropped.

**The single hard constraint:** none of this may touch the deterministic skiing
physics. Flex and shatter are *cosmetic* layers that live **outside** the
`Snowman.updateSnowman` kernel, so the physics-invariant harness and the frozen
`snowman_baseline.js` stay byte-identical and need **no** regeneration. See §3.

---

## 2. How it maps to the codebase today

Relevant facts established from the current source (`main`):

- `Snowman.createSnowman(scene)` (`src/snowman.ts:100`) builds one `THREE.Group` of
  named-but-untagged children: `bottom`/`middle`/`head` spheres, `leftEye`/`rightEye`,
  `nose`, three buttons, two `createBranchArm` groups, `hatBase`/`hatTop`, and
  `leftSki`/`rightSki`. Only the skis are currently stashed on `group.userData`
  (`leftSki`, `rightSki`, `leftSkiBaseX`, `rightSkiBaseX`).
- The **only** cosmetic pose code today lives *inside* `updateSnowman` (the ski-wedge /
  parallel-angulation block, `src/snowman.ts:631-649`). It is guarded by
  `if (snowman.userData && snowman.userData.leftSki && …)`, so in the headless physics
  harness — where the snowman stub has no `leftSki` — the branch is skipped and the
  trajectory is unaffected. **We will not add to this block.** New flex animation goes
  in a *separate* cosmetic function the orchestrator calls after physics (§5).
- `showGameOver(reason)` (`src/snowglider.ts:729`) is the single chokepoint for every
  end-of-run, crash and finish alike, including the avalanche-burial call from the main
  loop (`src/snowglider.ts:647`). It early-returns through
  `window._testShowGameOverOverride` and otherwise sets `state.gameActive = false`
  (which stops `animate()`), then shows the `#gameOverOverlay` (a 70%-opaque black DOM
  layer over the canvas). The finish is identified by the load-bearing string
  `"You reached the end of the slope!"`.
- `restartGame()` (`src/snowglider.ts:894`) and `resetSnowman()` (`:436`) re-arm a run;
  both must clean up any debris and restore the snowman.
- Prior art for the patterns we need: `AvalancheSystem` (`src/avalanche.ts`) for a
  self-contained physics body system with terrain-aware ground collision and a `reset()`
  that **disposes** geometry/material; `Snow.createSnowSplash`/`updateSnowSplash`
  (`src/snow.ts`) for a pooled snow-particle burst; `EffectsModule` (`src/effects.ts`)
  for the `prefers-reduced-motion` opt-out (`src/effects.ts:64`) and `addShake`.

---

## 3. Design principles & guardrails (non-negotiable)

These come straight from the Roadmap "Guardrails" and `PHYSICS.md` §6:

1. **Do not edit the `updateSnowman` physics math.** No new force, no new branch in the
   grounded/air integration, no constant change. Flex + shatter are cosmetic and run
   from the orchestrator, never from the kernel. ⇒ `physics_invariant_harness.js` stays
   green with **no baseline regeneration**, and `PHYSICS.md` needs no physics edits.
2. **Cosmetic state lives on `snowman.userData` or in the new modules**, never in the
   `updateSnowman` argument contract (keeps the typed signature and the verification
   wrapper untouched).
3. **Dispose every THREE object** the shatter creates on `reset()` (geometry +
   material), mirroring `AvalancheSystem.reset()`. No per-run leak.
4. **Respect `prefers-reduced-motion`** — reduced motion skips the flying-fragment
   tumble and the lingering jiggle; it still hides the snowman and shows a single small
   snow puff so the crash still reads, but with no large motion.
5. **Gate on test mode — with an explicit opt-in.** By default, when `window.isTestMode`
   is set (or `_testShowGameOverOverride` intercepts) the shatter is skipped, so headless/
   browser suites and the e2e reset spec are unaffected (the reset-flake spec already
   fights overlay z-order — see the `e2e-reset-flake-overlay` note; the debris must not add
   a new moving cover over `#resetBtn`). But a blanket `!isTestMode` gate would make the
   shatter path itself **untestable** in the browser harness (which always runs under
   `?test=`), so the gate also honors an explicit `window.testHooks.debrisEnabled` opt-in
   that the dedicated debris test sets and every other suite leaves unset (§8.3, §9).
6. **Behavior-preserving for the finish.** A successful finish must look exactly as it
   does today (result screen, ghost, medal). Shatter is crash-only.

---

## 4. Architecture overview

Two new files + small, surgical edits to three existing ones.

```
NEW  src/debris.ts        SnowmanDebris: shatter fragments + snow-puff burst + own
                          settle loop, terrain-aware, disposable. (class, like avalanche)
NEW  src/snowman-flex.ts  Flex: cosmetic squash/stretch/jiggle animator (scarf-trail
                          branch is dormant until PR C). Pure fn over (group, dt, motion).

EDIT src/snowman.ts       createSnowman(): tag parts into group.userData.parts {…}.
                          (Scarf geometry is the optional PR C.) NO change to updateSnowman.
EDIT src/snowglider.ts    main loop calls Flex.update(...) each frame after physics;
                          showGameOver() triggers Debris.shatter() on crash reasons;
                          resetSnowman()/restartGame() call Debris.reset() + Flex.reset().
EDIT src/main.ts          import the two new modules so they join the bundle graph.
```

Data flow per frame (grounded run):

```
updateSnowman(delta)  →  pos/velocity/technique   (UNCHANGED kernel)
        │
        ├─ Flex.update(snowman, delta, { speed, technique, turnRate, justLanded, isInAir })
        │     └─ writes child-mesh scale/position/rotation only (cosmetic)
        └─ render
```

On crash:

```
showGameOver(reason)
   ├─ if reason is a CRASH and debris-allowed (default; opt-in under ?test=):
   │     Debris.shatter(scene, snowman, velocity, { reducedMotion, render })
   │       │   (terrain comes from an earlier setTerrainFunction(); render =
   │       │    () => renderer.render(scene, camera) since animate() has stopped)
   │       ├─ hide snowman group
   │       ├─ spawn debris-owned fragment chunks (own geometry/material) with burst velocities
   │       ├─ Snow puff burst at impact
   │       └─ start own rAF settle loop (gravity + ground bounce + tumble, repaint each tick, ~2.5s)
   │     EffectsModule.addShake(impactScaledBySpeed)   // reuse existing juice
   │     (optionally) delay #gameOverOverlay ~700ms so the wipeout is the star
   └─ … existing overlay / score / result logic unchanged
```

---

## 5. Tag the model (`src/snowman.ts`)

### 5.1 Part registry

At the end of `createSnowman`, alongside the existing ski refs, register every animatable
/ shatterable part so both new modules address them by name instead of fishing through
`group.children`:

```ts
// Cosmetic part registry — consumed by snowman-flex.ts (jiggle) and debris.ts (shatter).
// INVARIANT: every value here is a renderable Object3D — but NOT necessarily a Mesh.
// leftArmGroup/rightArmGroup (and the PR-C scarfTail) are THREE.Group (createBranchArm()
// returns a Group, src/snowman.ts:157), which have no .geometry/.material. So the shatter
// loop MUST branch on type (§7.2): own-clone a Mesh's geometry/material directly, but for
// a Group traverse to its child meshes (or spawn a generic chunk at the group's world
// transform). The registry must still never hold a non-renderable entry (snapshots, flags,
// counters) — that's why base transforms live in the separate partBaseTransforms map below.
// Storing Object3Ds (not indices) keeps both modules decoupled from child order.
group.userData.parts = {
  bottom, middle, head,            // the three snow balls
  leftEye, rightEye, nose,
  button1, button2, button3,
  leftArmGroup, rightArmGroup,
  hatBase, hatTop,
  // scarf, scarfTail — added by the optional scarf follow-up (PR C). Both the flex
  // animator and the shatter system treat these as present-or-absent, so the registry
  // simply gains two keys when PR C lands; nothing in A/B depends on them existing.
};
// Neutral local transforms live in a SEPARATE map (not on .parts) precisely so the
// shatter loop above can treat every .parts value as a renderable Object3D. A snapshot
// stashed under parts.base would be a plain transform record, and a generic
// `for (const p of Object.values(parts)) p.geometry…/p.getWorldPosition…` would throw on
// it. Keyed by the same names so flex can pair part↔base.
group.userData.partBaseTransforms = recordBaseTransforms(group.userData.parts);
```

`recordBaseTransforms` snapshots each part's `position`/`scale`/`rotation` into a plain
object so the flex animator can express everything as an offset from neutral and
`Flex.reset()` can snap exactly back (no drift across runs). Keeping it off `.parts`
(under `userData.partBaseTransforms`) is what lets the shatter code blindly iterate the
registry. This is the same discipline the ski-pose code already uses with
`leftSkiBaseX`/`rightSkiBaseX`.

### 5.2 Scarf geometry — *optional follow-up (PR C), NOT in the core work*

Deferred because the overlapping neck geometry + a trailing tail is the fiddliest,
highest-risk piece of #53. Captured here as a ready reference for PR C; A and B ship
scarf-free. A simple, cheap scarf: a flattened torus (the wrap) at the neck seam
(~`y = 6.2`, between the `middle` top and the `head`) plus a short two-segment tail
hanging over the front in red wool. Keep it low-poly (matches the rest of the model) and
`castShadow = true`:

```ts
const scarfMaterial = new THREE.MeshStandardMaterial({ color: 0xCC2222, roughness: 1.0 });
const scarf = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.28, 8, 16), scarfMaterial);
scarf.position.y = 6.2; scarf.rotation.x = Math.PI / 2; scarf.castShadow = true;
group.add(scarf);

// Tail: a short box draped down the front, pivoted at the neck so flex can swing it.
const scarfTail = new THREE.Group();
const tailSeg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.4, 0.18), scarfMaterial);
tailSeg.position.y = -0.7; tailSeg.castShadow = true;
scarfTail.add(tailSeg);
scarfTail.position.set(0.35, 6.1, 1.0);
group.add(scarfTail);
```

This is additive geometry only — it does not touch physics, collision radius, or the
spawn pose, so terrain/physics tests are unaffected. PR C adds the two `scarf`/`scarfTail`
keys to the part registry plus one DOM-smoke assertion; until it lands, the flex and
shatter modules simply run scarf-free.

---

## 6. Feature 2 — Flexibility / wiggle (`src/snowman-flex.ts`)

A **pure cosmetic** animator, called from `animate()` *after* `updateSnowman`. It reads
the per-frame motion the kernel already returns (speed, technique, justLanded, isInAir)
plus the snowman's own turn rate, and writes only child-mesh transforms. It holds a tiny
amount of state (jiggle phase, settle spring) on `snowman.userData.flex`.

```ts
export interface FlexMotion {
  speed: number;        // currentSpeed from UpdateResult
  technique: string;    // 'carve' | 'skid' | 'tuck' | … (for lean styling)
  turnRate: number;     // signed, zero-speed-guarded (0 when speed≈0), drives lean (+ scarf swing in PR C)
  justLanded: boolean;  // landingForce > threshold → settle bounce
  landingForce: number;
  isInAir: boolean;
}

export const Flex = {
  update(snowman: THREE.Object3D, dt: number, m: FlexMotion): void { /* … */ },
  reset(snowman: THREE.Object3D): void { /* snap all parts to base, clear state */ },
};
```

Effects, all expressed as offsets from the recorded base transforms (so they compose and
reset cleanly):

- **Idle breathing / jiggle.** A low-amplitude sine on each ball's vertical scale
  (squash↔stretch, conserving volume by widening as it shortens), phase-offset per ball
  so the stack ripples. Amplitude scales gently with speed.
- **Head bob & lag.** The head lags the body heading by a frame-smoothed amount and bobs
  on bumps (driven by `justLanded`/terrain change), so it feels weighty.
- **Landing settle.** On `justLanded` with meaningful `landingForce`, kick a critically-
  damped spring on the whole stack's vertical scale → a satisfying *squash-and-recover*.
- **Carve lean.** On `carve`/`parallel`, lean the upper balls + hat into the turn
  (`turnRate`-scaled, clamped) — a *cosmetic* lean layered on top of the kernel's
  existing body tilt, addressing the "flexible" ask without spine math.
- **Scarf trail** *(only when the scarf exists — PR C)*. If `parts.scarfTail` is present,
  swing it opposite to travel/turn (trails behind) with a sine flutter scaled by speed; in
  air it lifts. Guarded so the animator is a no-op on the scarf when it's absent — A ships
  without this branch active.

**Reduced motion:** `Flex.update` early-returns to base transforms (no jiggle/lean), so
the snowman is simply rigid — identical silhouette, no motion.

**Robustness:** `Flex.update` must stay finite on a zero-speed/zero-delta first frame —
it treats `turnRate` as `0` when `speed ≈ 0` (§8) and clamps every output, so a `0/0`
can never write a NaN rotation/scale onto the snowman. The flex-unit test asserts finite
transforms for a `{ speed: 0 }` motion input.

**Why a separate module, not inside `updateSnowman`:** keeps the physics kernel and its
frozen baseline byte-identical (§3.1), and keeps R3's planned `snowman/pose.ts` split
clean — this is exactly the cosmetic-pose concern R3 wants out of the kernel anyway.

---

## 7. Feature 3 — Crash shatter (`src/debris.ts`)

A self-contained `SnowmanDebris` class, modeled on `AvalancheSystem`: terrain-aware,
disposable, owns its own settle loop so it can animate **after** `state.gameActive` flips
false.

### 7.1 API

```ts
export class SnowmanDebris {
  setTerrainFunction(fn: (x: number, z: number) => number): void;
  // `render` repaints the canvas each settle tick — REQUIRED: showGameOver has already
  // set gameActive=false, so animate() is no longer rendering (§7.4). The orchestrator
  // passes () => renderer.render(scene, camera).
  shatter(scene, snowman, velocity,
          opts?: { reducedMotion?: boolean; render?: () => void }): void;
  update(dt: number): boolean;   // returns true while still settling
  reset(scene): void;            // dispose fragments, re-show snowman
  get active(): boolean;
}
```

### 7.2 `shatter()`

1. **Hide** the live snowman group (`snowman.visible = false`) — we replace it with
   free-flying fragments so the original stays intact for the next run (cheaper + safer
   than detaching real children).
2. **Spawn fragments.** For each shatterable part in `userData.parts`, create a
   lightweight fragment positioned at the part's current **world** transform. **Resource
   ownership is load-bearing for the crash→restart cycle:** the snowman is only *hidden*
   (step 1), so its geometry/material must survive. A bare `part.clone()` is **not safe** —
   Three.js `Object3D.clone()` *shares* the source `geometry`/`material` by reference, so
   disposing the fragment in `reset()` (§7.5) would dispose the still-hidden snowman's
   originals and the next run would re-show it with freed buffers. Pick one of:
   - **(preferred) generic fragment assets** — spawn a small pool of generic snow-ball
     chunks from geometry/materials the debris system *owns* and creates once, sized/tinted
     from the part. Nothing references the snowman's assets, so disposal is unambiguous and
     the three balls cracking into 2–3 chunks each falls out naturally.
   - **owned clones** — if a fragment must mirror a distinctive *mesh* part (hat, nose,
     buttons, eyes), clone with explicit ownership:
     `mesh = new THREE.Mesh(part.geometry.clone(), part.material.clone())` (cloning the mesh
     alone is insufficient — it keeps the shared buffers). Track these as "owned" so
     `reset()` disposes only them.
   - **Group parts** — `leftArmGroup`/`rightArmGroup` (and the PR-C `scarfTail`) are
     `THREE.Group`s with **no `.geometry`/`.material`**, so a blind `part.geometry.clone()`
     would throw or skip the arms. The loop must branch on `part.isMesh`: for a Group,
     either traverse it and own-clone each child mesh into one fragment group, or (simpler)
     spawn a single generic stick/snow chunk at the group's **world** transform.

   Either way, tag each fragment's geometry/material as debris-owned (e.g. push into an
   `ownedResources` set) so `reset()` disposes **exactly** what the debris system created
   and never anything still wired to the snowman. Give each fragment:
   - initial velocity = inherited snowman `velocity` (×~0.6) **+** an outward radial
     burst (`6–11` u/s) **+** an upward pop (`4–8` u/s), scaled by impact speed;
   - a random angular velocity (`THREE.Vector3`) for tumbling;
   - a `radius` for ground collision.
   The three balls additionally crack into 2–3 sub-chunks each so it reads as
   "balls breaking," per the issue. Cap total fragments (≈24) for perf.
3. **Snow puff.** Fire a one-shot burst from the existing snow-splash texture/material at
   the impact point (a dozen-ish sprites with the same gravity/fade as `updateSnowSplash`),
   so the break-up is wrapped in a cloud of powder — the "balls with snow splashing" ask.
4. **Juice.** `EffectsModule.addShake(clamp(impactSpeed * k))` for a crash thud (already
   `prefers-reduced-motion`-aware inside effects).
5. Start the settle loop (§7.4).

### 7.3 Per-fragment physics (cosmetic, terrain-aware)

Same shape as the avalanche boulder integrator, simplified:

```
gravity = 18 ; bounce = 0.35 ; friction = 0.9
vel.y -= gravity * dt ; pos += vel * dt ; rotate by angularVel * dt
floorY = getTerrainHeight(pos.x, pos.z)        // requires setTerrainFunction()
if (pos.y < floorY + radius):
    pos.y = floorY + radius
    vel.y *= -bounce
    vel.x *= friction ; vel.z *= friction
    angularVel *= friction
```

Fragments settle and stop within ~2–2.5 s, then the loop ends (or `reset()` cuts it
short on restart).

### 7.4 Settle loop & the `gameActive` interaction

`showGameOver` sets `state.gameActive = false`, which halts `animate()` — so **after the
crash frame nothing repaints the canvas**. `SnowmanDebris` therefore runs its own
`requestAnimationFrame` loop while settling (the avalanche-style `update(dt)` ticked from a
private rAF) **and must repaint each tick itself**: `shatter()` takes a `render` callback
(§7.1) and the orchestrator passes `() => renderer.render(scene, camera)` (it owns
`renderer`/`scene`/`camera`). Without that callback the fragments would update but the
frozen canvas would never show them — exactly the gap the explicit `render` param closes.
The camera stays where the crash left it (the camera manager isn't ticking); if we later
want it to track the debris, the same callback is the place to nudge it. The loop
self-terminates when `update()` returns false.

> **Alternative considered:** keep the main `animate()` loop alive on a `state.debrisActive`
> flag instead of a private rAF. Rejected as the default because it spreads debris state
> into the main-loop gating; the self-contained loop + injected `render` keeps the
> orchestrator change to ~3 lines. (It also means the test path needs an explicit opt-in
> rather than riding the live loop — see §3 / §9.)

> **Overlay timing (user-visible, flag this for review).** The `#gameOverOverlay` is 70%
> black and would dim the wipeout. Proposal: on a **crash**, delay showing the overlay by
> ~700 ms (a `setTimeout`) so the shatter plays at full brightness, then fade it in;
> **finish** stays immediate (unchanged). **If implemented with `setTimeout`, the timer id
> MUST be stored (e.g. a module-scoped `crashOverlayTimer`) and cleared in `resetSnowman`/
> `restartGame` (§8.4).** `showGameOver` has already set `gameActive = false` while the
> Reset control stays visible (and tests call the restart helpers directly), so a
> reset/restart *before* the timer fires would otherwise re-show `#gameOverOverlay` over
> the fresh run or strand it inactive behind a stale overlay. Alternative if we want zero
> timing change: show the overlay immediately and accept the dimmed shatter behind it. Pick
> one in review — see Open Questions §11.

### 7.5 `reset()`

Mirror `AvalancheSystem.reset()`: remove every fragment + puff sprite from the scene,
then `geometry.dispose()` / `material.dispose()` **only on debris-owned resources** (the
`ownedResources` set from §7.2 — never the snowman's shared geometry/material, or the
re-shown snowman would render with freed buffers), clear arrays, stop the private rAF, and
set `snowman.visible = true`. Called from both `resetSnowman()` and `restartGame()` so a
new run always starts from a clean, visible snowman. The repeated crash→restart heap-leak
check in §11 is what guards this.

---

## 8. Game-loop & lifecycle integration (`src/snowglider.ts`)

Minimal, localized edits:

1. **Construct once** near the avalanche setup: `const debris = new SnowmanDebris();
   debris.setTerrainFunction(Snow.getTerrainHeight);` (store on `state` like
   `state.avalanche`). Because `state` is **module-scoped** and we add no new `window.*`
   bridge, expose a read seam on the **existing** `window.testHooks` surface so the browser
   test can observe debris without reaching `state`:
   `window.testHooks.isDebrisActive = () => !!state.debris && state.debris.active;` — a
   deliberate test hook like the collision hooks (`window.testHooks.forceTreeCollision`),
   **not** a per-module namespace bridge, so it stays within the sanctioned test seam.
2. **Per frame**, after the existing `updateSnowman(delta)` + splash, call
   `Flex.update(snowman, delta, motionFromUpdateResult)`. (The wrapper already has the
   `UpdateResult` in scope — `player`/the return value — so `speed`, `technique`,
   `justLanded`, `landingForce`, `isInAir` are in hand.) Derive turn rate with a
   **zero-speed guard**: `turnRate = speed > 1e-3 ? velocity.x / speed : 0`. On the first
   frame after start/restart `speed` can be `0` (and `delta` `0`), so an unguarded
   `velocity.x / speed` is `0/0 = NaN`; that NaN would flow into the lean/scarf rotations
   and scales and corrupt the visible snowman until the next reset.
3. **In `showGameOver(reason)`**, *after* the `_testShowGameOverOverride` early return and
   setting `gameActive = false`, add a crash branch:

   ```ts
   const isFinish = reason === "You reached the end of the slope!";
   const crash = !isFinish;
   // Off under ?test= by DEFAULT (protects the e2e reset-flake + headless suites), but
   // the dedicated debris browser test opts in via window.testHooks.debrisEnabled so the
   // real shatter path is still covered (§9). _testShowGameOverOverride already
   // short-circuited above for the unit-level mocks. Gating on isTestMode alone would
   // make the live game UNtestable here — that's why the opt-in exists.
   const allowDebris = !window.isTestMode ||
     !!(window.testHooks && window.testHooks.debrisEnabled);
   if (crash && allowDebris && state.debris) {
     const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
     state.debris.shatter(scene, snowman, velocity, {
       reducedMotion: !!reduced,
       render: () => renderer.render(scene, camera), // §7.4: animate() has stopped
     });
     if (EffectsModule) EffectsModule.addShake(/* impact ∝ speed */);
   }
   ```

   Everything else in `showGameOver` (best-time, login prompt, leaderboard, result
   screen, `EffectsModule.reset()`, overlay) is unchanged — except the optional
   crash-only overlay delay (§7.4).
4. **In `resetSnowman()` and `restartGame()`**: call `state.debris?.reset(scene)` and
   `Flex.reset(snowman)` before re-initializing the camera, so the fragments are gone and
   the snowman is visible and back to neutral pose. **If the crash-only overlay delay
   (§7.4) is implemented, also `clearTimeout(crashOverlayTimer)` and null it here** — a
   restart inside the ~700 ms window must not let the pending callback re-show
   `#gameOverOverlay` over the fresh run.
5. **`src/main.ts`**: add `import './debris.js';` / `import './snowman-flex.js';` (the
   `.js` specifier resolving to `.ts`, per the repo import convention) so they join the
   bundle graph; the orchestrator imports the named exports directly.

No new `window.*` globals (respects the no-per-module-bridge rule). `EffectsModule.reset()`
already runs in `showGameOver`; the debris is independent of it.

---

## 9. Testing plan

| Layer | What | Where |
|-------|------|-------|
| **Physics invariant** | Unchanged — assert no regression. Because the kernel is untouched, `npm run test:verify` must stay green **without** regenerating `snowman_baseline.js`. This is itself the proof that flex/shatter didn't leak into physics. | `tests/verification/physics_invariant_harness.js` (run, don't edit) |
| **DOM smoke** | `createSnowman` still builds; assert the new `userData.parts` registry exists. (The `scarf`-present assertion is added by PR C.) | `tests/verification/dom_smoke_test.js` (extend) |
| **Debris unit** | Headless with a mocked `THREE` + deterministic terrain fn: `shatter()` spawns N fragments and hides the snowman; `update(dt)` applies gravity and converges (fragments rest at/above terrain, loop returns false within ~2.5 s); `reset()` disposes **only debris-owned** geometry/material and re-shows the snowman with its original assets intact (assert the snowman's geometry/material were NOT disposed across a shatter→reset cycle). Mirror the existing `avalanche-tests.js` harness. | new `tests/debris-tests.js` + `npm` script |
| **Flex unit** | `Flex.update` only mutates child transforms and is bounded (clamped lean, returns to base when idle / reduced-motion); stays **finite** for a `{ speed: 0, delta: 0 }` frame (no NaN); `Flex.reset` restores base transforms exactly. | new `tests/snowman-flex-tests.js` |
| **Browser** | Set `window.testHooks.debrisEnabled = true` (the §8.3 opt-in that re-enables shatter under `?test=`), then force a tree collision (`window.testHooks.forceTreeCollision`) and assert `snowman.visible === false` + `window.testHooks.isDebrisActive()` (the read seam from §8.1 — `state` is module-scoped, so the test reads through `testHooks`, never `state.debris`) immediately after; assert restart re-shows the snowman. Every other suite leaves the flag unset, so debris stays off for them and the e2e reset spec. | extend `tests/browser-tests.js` |
| **E2E** | Reuse the reset spec's "coast → crash" but assert the wipeout doesn't block `#resetBtn` (debris must not cover the button; keep overlay z-order intact). Watch the known reset-flake (see memory `e2e-reset-flake-overlay`). | `tests/e2e/` |

Docs to update in the same PR (Roadmap guardrail): `ARCHITECTURE.md` (new modules in the
export table + loop step), `ROADMAP.md` (#53 / Finding #11 → ◐), `CHANGELOG.md`. `PHYSICS.md`
needs **no** change (kernel untouched) — explicitly note that in the PR description.

---

## 10. Performance & accessibility

- **Fragment cap** ≈24 chunks + ≈12 puff sprites; reuse the snow-splash material. One-shot,
  disposed on reset — no steady-state cost during normal play (debris only exists post-crash).
- **`prefers-reduced-motion`**: flex → rigid; shatter → hide snowman + single small puff,
  no flying tumble, no `addShake` (effects already honors it).
- **Mobile**: the settle loop is short and low-count; gate fragment sub-cracking behind a
  simple device/perf check if needed (optional, can follow the roadmap's perf-scaling item).

---

## 11. Risks & review checklist

- [ ] `npm run test:verify` green with **no** `snowman_baseline.js` change → proves the
      physics kernel is untouched (the load-bearing invariant).
- [ ] Finish flow visually unchanged (no shatter on `"You reached the end of the slope!"`).
- [ ] `reset()` disposes only debris-**owned** geometry/material (the `ownedResources`
      set), never the snowman's shared assets; after a crash→restart the re-shown snowman
      still renders (no freed-buffer artifacts). No leak across repeated crash→restart
      cycles (watch heap in the browser test).
- [ ] Debris does **not** render over `#resetBtn` / `#gameOverOverlay` interactive
      elements (guards the known e2e reset flake).
- [ ] Under `?test=`, shatter is off by default (protects the e2e reset spec) but the
      dedicated debris browser test re-enables it via `window.testHooks.debrisEnabled`;
      `_testShowGameOverOverride` still short-circuits the unit path.
- [ ] Debris settle loop repaints via the injected `render` callback (animate() has
      stopped after game over) — fragments are actually drawn, not just updated off-screen.
- [ ] Debris active state is read in tests via the `window.testHooks.isDebrisActive()`
      seam, not module-scoped `state.debris` (no new `window.*` bridge added).
- [ ] If the crash overlay delay is used, its `setTimeout` id is stored and
      `clearTimeout`'d in `resetSnowman`/`restartGame` — a restart inside the delay window
      can't re-show or strand `#gameOverOverlay`.
- [ ] Shatter loop branches on `part.isMesh` — Group parts (arms, PR-C scarf tail) are
      traversed or replaced with a generic chunk, never `part.geometry.clone()`'d directly.
- [ ] `Flex.update` is NaN-safe on a zero-speed/zero-delta frame (epsilon-guarded
      `turnRate`, clamped outputs); no NaN rotation/scale ever reaches the snowman.
- [ ] No new `window.*` per-module bridge; modules `import` directly and are imported by
      `main.ts`.
- [ ] *(PR C only)* Scarf doesn't alter collision radius, spawn pose, or terrain tests.

## 12. Suggested PR breakdown (mergeable, low-risk first)

1. **PR A — Part registry + flex** (no game-over changes, **no scarf**): add the
   `userData.parts` registry and `src/snowman-flex.ts`, wire `Flex.update`/`Flex.reset`.
   Lowest risk; ships the "flexible/wiggly" half of #53 on its own. Tests: DOM smoke +
   flex unit + verify-green.
2. **PR B — Crash shatter**: `src/debris.ts`, the `showGameOver` crash branch, the
   reset/restart cleanup, the optional overlay delay. Ships "breaks down on impact."
   Tests: debris unit + browser crash test + e2e.
3. **PR C — Scarf (optional follow-up)**: add the scarf/tail geometry (§5.2), the two
   `scarf`/`scarfTail` keys in the registry, the flex scarf-trail branch (§6), and a DOM-
   smoke assertion. **Quarantined on purpose** — the overlapping neck geometry / trailing
   tail is the riskiest, most iteration-prone piece, and A/B don't depend on it (both
   treat the scarf as present-or-absent). Can land any time after A, or be dropped without
   affecting A/B.

Splitting this way keeps each PR's blast radius small, lands the expressive-pose and
wipeout work first, and quarantines the fiddly scarf so it can't hold them up.

## 13. Open questions (for the maintainer)

1. **Overlay timing** — delay the crash overlay ~700 ms so the wipeout is visible (§7.4;
   the delay timer must be stored and cleared on reset/restart), or keep the overlay
   immediate and accept a dimmed shatter? (Recommend the short delay.)
2. **Fragment fidelity** — owned clones of the distinctive *mesh* parts (hat, nose read
   clearly; clone with `geometry.clone()`/`material.clone()` so disposal is safe — §7.2)
   vs. generic snow-ball chunks (cheaper, uniform, trivially debris-owned)? Note the arms
   are `THREE.Group`s, so "fidelity" there means traversing/cloning their child meshes
   (§7.2 Group-parts bullet), not a single `geometry.clone()`. (Recommend owned clones for
   the distinctive mesh parts + generic chunks for the 3 balls and the arms.)
3. **Scope of #53** — close #53 once A+B+C land, or close with A+B (flex + wipeout) and
   track the scarf (PR C) + further polish (snowballing-downhill after wipeout,
   celebratory finish animation) as follow-ups? The scarf is now explicitly a follow-up,
   so A+B alone are a coherent shippable slice.
