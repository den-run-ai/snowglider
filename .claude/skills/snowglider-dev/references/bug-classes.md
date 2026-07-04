# SnowGlider — Recurring Bug Classes (Codex review + regression corpus)

The dominant failure pattern in this repo: an author ships a plausible feature, and the
*second-order interaction* bites — a shared flag another subsystem reads, a state variable that
leaks across a mode/run boundary, an async gap, a resource never torn down, a frame-rate coupling,
or a consumer left un-updated. Codex (`chatgpt-codex-connector`, P1=serious / P2=important) catches
these repeatedly. Use this as a self-review checklist; each entry has the canonical example and the
fix shape.

---

## 1. Shared-flag repurposing — "what else reads this variable?"

**The canonical bug (PR #333, P1).** The author set `playerJump = true` for Expert-terrain kickers
to enable tricks. But `src/avalanche.ts` treats `isInAir && playerJump` as a *dodged avalanche* —
so a player merely launched by a natural kicker during an avalanche overlap became **immune and got
the dodge bonus instead of being buried** (a "free avalanche-immunity farm"). Also feeds
obstacle-clear and takeoff-dip policies.

**Fix shape.** Introduce a **separate provenance flag** (`freestyleAir`, a *superset* of
`playerJump`) so the narrow dodge/clear/takeoff readers keep reading the narrow flag. Never widen a
flag's meaning in place.

**Related.** #290 (crash then finish), #289 (score banked after read) are the same family — one
piece of state means two things to two readers.

**Self-check:** grep every reader of the flag/field you're about to set or reuse. If any reader
interprets it differently than your new write, split the flag.

---

## 2. State leaking across a boundary (transient vs. persisted / mode / restart / first-frame)

The camera cluster is the textbook case.

- **#306 P2 — transient bleeds into persisted.** Auto mode wrote the same `zoom` field manual zoom
  uses, and neither `resetSnowman()` nor `setMode()` reset it → after a fast Auto run, Restart
  spawned with the leftover zoomed-out framing. *Fix: a separate transient `autoZoom` multiplier
  cleared on `initialize()`/`setMode()`.*
- **#306 P2 — switching into a mode must reset what that mode advertises away.** Selecting Follow
  kept the previous Orbit yaw/pitch for a 90-frame hold. *Fix: clear orbit/hold on switch-to-follow,
  preserve manual zoom.*
- **#319 P2 — first-frame vs. steady-state math must match.** Cam/Drone rendered at the Follow pose
  for frame 1 then eased from the wrong spot → a visible snap. *Fix: a shared `entryOffset()` used
  by both `initialize()` and the first-frame branch.*
- **#310 P2 — gate a continuous contribution on the condition it expresses.** Slope-based pull-back
  fired at spawn because the reset point already has gradient ~0.685. *Fix: fade the slope term in
  with actual downhill motion.*

**Self-check:** for every new piece of state, answer: is it transient or persisted? What resets it
on restart and on mode-change? Does the first/initialize frame use the same math as steady state?

---

## 3. Teardown incompleteness — assume nothing is auto-freed

PR #226 alone drew ~21 P2 teardown findings. Enumerate *every* allocation site:

- `InstancedMesh.dispose()` for per-instance buffers (not just `geometry.dispose()`).
- Module-level singletons (Sky `cycle`, Course `gateGroup`, Diagnostics ring buffer + sink,
  1000-sprite snowflake array) — null/reset each.
- `window.*` closures (`window.disposeGame` itself) keep the module env rooted — even a module-local
  `noopDispose` roots `scene`/`renderer`; use `Function.prototype`.
- Timers, `MutationObserver`s (guard on `signal.aborted`), event listeners, audio (music + SFX),
  toasts, DOM nodes.
- Dedup shared-resource disposal (`0579189`: `Set` sweep so shared material buckets free once).
- Cancel in-flight async first (`0351cda`: build epoch); track multiple pending builds in a `Set`.
- Idempotent double-call; `resetControls()` (stuck-key), stop audio, route the fatal-error path
  through normal cleanup (#262).
- Keep teardown scene-local (#221) so you don't dispose another live scene's objects.

**Self-check:** list every `new`, `addEventListener`, `setTimeout/Interval`, observer, and
`window.x =` your change adds; write the matching teardown for each; run `test:leak`/`test:teardown`.

---

## 4. Async gaps — race between "recording intent" and "having the asset"

**#285 (P1 + several P2).** With EZ trees defaulting on, `addTrees` recorded collision
`treePositions` immediately but appended the actual meshes only after a 4 MB dynamic import → the
physics loop could **collide against invisible trees**, or a ranked run proceeded with **tree
collision disabled** until the chunk settled. *Fix: `startGameplayLoop` awaits `ezForestReady()`
raced against a 6s timeout; on timeout builds the stylized fallback **synchronously** for the same
placements before activating.* Follow-on P1: abandoning only one pending build left a stale
double-scheduled build gating `treeCollidersReady()` false → track pending in a `Set`.

**Related.** RNG swap held across an `await` (see invariants §2); stale closure firing post-dispose
(#226).

**Self-check:** is there an `await` between "I recorded this exists" and "the object actually
exists"? Don't start colliders / a ranked run until the awaited asset (or a synchronous fallback for
the same placements) is present. Cancel in-flight builds on teardown.

---

## 5. Frame-rate dependence when moving on/off the fixed grid

See invariants §3 for the full list. Key traps:
- Interpolation reseeded on no-step frames (holds then jumps at 120/144 Hz).
- Update→check→reset ordering broken (avalanche burial vs. `hasPassed()`).
- A per-render-frame decision becoming frame-rate-dependent on the grid (dodge flips to buried at
  low FPS, #289).
- Diagnostics fed `FIXED_DT` instead of real `frameDelta` (never flags low-FPS sessions).
- Equivalence claims over a common prefix instead of full trajectory + step count.
- Free-time cheat when rAF stops on a hidden tab (#278) — pause clock + physics together.

---

## 6. Incomplete consumer updates — a change not propagated everywhere

- **#277 P2 — new denormalized field, one render site missed.** `getLeaderboard()` exposed real
  `displayName` but the start-screen preview still rendered `Player ${index+1}`. *Update all render
  sites.*
- **#233 P1 — raised a constant, broke the fixtures that synthesize the old value.** An 18s
  plausibility floor broke tests that backdate the clock only 5s, so the fixture "skips both score
  recording and `CourseModule.onFinish`." *Change the constant → change the fixtures.*
- **#263 (two P2) — build-time vs. run-time selection diverged.** The avalanche was built once from
  `readStoredDifficulty()`, but the picker sets `state.difficulty` later → a Blue-loaded page
  started as Bunny still fired the Blue avalanche. *Retune the live system when the reload-rebuild
  path is skipped (private-mode/localStorage failure).*

**Self-check:** grep for *all* consumers of the field/constant/config you changed — render sites,
test fixtures, config/build paths, docs/comments.

---

## 7. Within-frame side-effect ordering

- **#290 P1 — a terminal outcome overwritten by a later check.** An Expert wipeout that also lands
  past `FINISH_Z` called `showGameOver` for the crash, then continued into the finish check with
  `gameActive` still true → **recorded a successful score for a crashed landing.** *Fix: pass
  `gameActive: gameActive && !wipedOut` downstream; add a re-entry guard to `showGameOver`.*
- **#289 P2 — score banked after it was read.** A `dodgedFirst` bonus applied *after*
  `CourseModule.onFinish()` read the total → the advertised 250-point bonus was missing from the
  finish screen. *Fix: gate the award on `state.gameActive` and bank before the finish read.*

**Self-check:** within a single frame, does any terminal outcome (crash/wipeout/finish) run before a
later check that assumes it didn't? Are score mutations banked before the value is read?

---

## 8. Perf-budget violations (`perf-budget.spec.ts`)

- **#327 P2 — per-object geometry instead of pooling.** 24 props × (2–5 meshes) adds ~70 live
  `BufferGeometry` against a ceiling of 185 (~155 baseline). *Fix: a shared `PropPool` (few
  geometries + materials) built once — the same pooling `trees.ts` already does.*
- **#332/#319 — new shader programs.** `side: THREE.DoubleSide` sets a program-cache key that blew
  the E2E program budget (`194a4be`) — make geometry double-faced + `FrontSide` to share one
  program. A DoubleSide material silently adds a program.

**Self-check:** does your change allocate geometry/material per scattered object (pool instead)? Does
it add a shader program (new material flags/DoubleSide/custom shader)? Check the perf budget.

---

## 9. Security & deploy ordering

- **#276 — XSS.** Escape user-controlled strings (display names from other players) in any DOM/HTML
  renderer. *Build leaderboard rows with DOM APIs, not `innerHTML` (`7d17c1f`).*
- **#277 P2 — client change racing a rules deploy.** CI publishes Pages before rules, so the new
  client can hit the previous production rules whose `validLeaderboardKeys` rejects the new field →
  `permission-denied`. *Fix: catch `permission-denied` and retry once in the old-rules shape
  (`40ef499`) — self-heals even a failed rules deploy. Don't just reorder CI.*

---

## Meta-lessons from the workflow

- **Every PR is written to defend an invariant explicitly** — bodies enumerate "render-only ·
  collision-neutral · physics-neutral · `Math.random`-stream-neutral · teardown-safe · cosmetic-tick
  -only" and name the harness that proves each. This legibility is *why* review findings are so
  targeted; deviations stand out. Write your change the same way.
- **Fixes ship with a regression test that fails against the old code** (#221 "verified to fail
  against the old global-array teardown"; #339 "Test #1 fails under the old condition"). Assert your
  test would have caught the bug.
- **Push back with reasoning when a review misreads intent** — but fix the docs/comments that misled
  the reviewer. (#289: the frame-perfect dodge is intended #47 behavior — "the docs were wrong, not
  the code"; #285: the RNG swap is deliberately not held across the await.)
- **Stacking/branch hygiene** is a recurring silent failure — a PR stacked on a branch that merges
  first shows "merged" but never reaches `main` and skips CI (`0` check-runs is the tripwire; ground
  truth `git merge-base --is-ancestor <sha> origin/main`). Keep stacks ordered and each
  independently mergeable.
