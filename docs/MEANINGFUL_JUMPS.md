# Meaningful Jumps — Implementation Proposal (#47)

> **Status:** initial proposal / design for review. Nothing here is implemented yet.
> Tracking issue: [#47 — "jumping should help to avoid obstacles and maybe even some
> avalanches"](https://github.com/den-run-ai/snowglider/issues/47); related
> [#32 — freestyle ski tricks](https://github.com/den-run-ai/snowglider/issues/32).
> This is the roadmap's named "remaining P1 thread" (make skiing skillful) now that
> #48/#54/#136/#146 have landed — see [`ROADMAP.md`](ROADMAP.md) Finding 4 / P1.

## 1. Why this, why now

Jump is already bound (Space / touch) but does almost nothing *for* the player: it
pops you into the air, costs you speed on landing, and that's it. Converting an
already-wired, currently-useless input into a real risk/reward mechanic is the
highest impact-per-effort gameplay move left, and it is **additive** — it extends
the existing physics, scoring, and effects systems rather than introducing new
infrastructure:

| Jump sub-feature | Plugs into existing system |
|---|---|
| Airtime + landing-quality grading | the split-time / result / medal / ghost layer (#56) |
| Clean-landing speed **boost** | the carve-vs-skid speed-management model (#136) |
| Obstacle clears | tree/rock jump-clearance already in `collision.ts` |
| **Avalanche-dodge window** | the avalanche — the game's central tension (#44/#49) |
| Style/trick scoring | groundwork for freestyle tricks (#32) and an AI coach (P3) |

## 2. What jump does today (grounded in the code)

All of this lives in [`src/snowman/physics.ts`](../src/snowman/physics.ts)
`stepSnowmanPhysics`, the deterministic kernel:

- **Manual jump** (Space/touch, **not** steering): `verticalVelocity = 10 + currentSpeed*0.5`, `jumpCooldown = 0.5`.
- **Hop turn** (Jump **while** steering L/R): a pivot + speed scrub — already shipped for #48/#146; *out of scope here, left untouched.*
- **Auto-jump** (terrain lip): when `!isInAir && heightDifference < -0.8 && currentSpeed > 12`, fires with **no player input**.
- **Airborne:** `airTime += delta`; gravity `-16*delta`; limited air control (`velocity.x ∓= 5*delta`); low air friction (`0.01`).
- **Landing** (`pos.y <= terrain`): `landingImpact = min(0.5, airTime*0.15)` scrubs **both** `velocity.x` and `velocity.z`; `landingForce = airTime` is returned and fed to `EffectsModule.addShake` in [`src/game/main-loop.ts`](../src/game/main-loop.ts).
- **Obstacle clearance:** [`src/snowman/collision.ts`](../src/snowman/collision.ts) already lets a jump clear a tree (`isInAir && verticalVelocity > 0 && pos.y > treeY + 5`) or a rock (lower threshold). So "jump over the thing" partly exists — it just isn't *rewarded or telegraphed.*

**Key observation that shapes the whole design:** today airtime is a pure
**penalty** — more time aloft means a bigger landing scrub — and that penalty
fires on the **no-input path** (auto-jumps happen while coasting). So we cannot
simply change the landing formula globally; see §5.

## 3. Proposed mechanics

### 3.1 Jump provenance (the enabling primitive)
Add a `playerJump` flag (stored on `snowman.userData`, exactly like `carveCharge`
/ `lastSteerDir` today, and cleared in `resetSnowman`). Set it **only** in the
manual-jump branch (`controls.jump && steering === 0`); leave it false for
auto-jumps and hop turns. Every reward below is gated on `playerJump`, which is
what keeps the no-input / coasting trajectory byte-identical (§5).

### 3.2 Landing-quality grading
On landing of a *player* jump, grade the landing from the angle between the
horizontal `velocity` and `getDownhillDirection(pos.x, pos.z)` at the landing
point (skis pointing the way you're travelling = clean):

- **CLEAN** (well aligned) → speed **boost** (§3.3), full style credit.
- **OK** (moderate) → neutral (no scrub, no boost).
- **SKETCHY** (badly crossed-up) → keep today's `landingImpact` scrub (or a bit more).
- *(stretch)* **WIPEOUT** (extreme) → trigger the existing crash path, which now
  also fires the shatter/debris effect (#171). Optional, behind a flag.

### 3.3 Clean-landing speed boost
For a CLEAN player-jump landing, replace the airtime scrub with a small forward
impulse along the current heading, scaled by airtime and **capped** (e.g. up to a
few % of speed, hard-limited). This is the crux: a well-timed, well-aimed jump
becomes a **speed tool**, mirroring the #136 idea that good technique holds/*gains*
speed while sloppy technique scrubs it. The cap prevents jump-spam from
trivialising the course; sketchy landings still cost you.

### 3.4 Obstacle clears (telegraph what already happens)
When a player jump passes over a collidable tree/rock (reuse the clearance test in
`collision.ts`), award style points + an on-slope flash. Mostly surfacing +
scoring on top of existing clearance logic.

### 3.5 Avalanche-dodge window (the #47 headline)
When the avalanche is active and within a danger distance (the main loop already
computes `avDist` and feeds `EffectsModule.updateAvalanche`), a **clean** player
jump opens a short grace window — either a brief burial-immunity span (skip
`AvalancheSystem.checkBurial` while airborne + a few frames after) and/or a forward
escape impulse. This makes a perfectly-timed jump the dramatic "leap ahead of the
slide" beat the issue asks for. Gated behind manual jump + avalanche-active, so it
never touches the normal physics path.

### 3.6 Scoring surface
- **On-slope:** reuse `CourseModule.showFlash(html, color)` for transient toasts
  ("✈ AIR 1.2s — CLEAN", "CLEARED!", "DODGED!").
- **Per run:** accumulate an `airScore` (airtime + clean bonuses + clears + dodges),
  show it on the result screen via `CourseModule.onFinish` /
  [`src/ui/result-overlay.ts`](../src/ui/result-overlay.ts), plus an optional HUD
  line in [`src/ui/hud.ts`](../src/ui/hud.ts).
- **Leaderboard:** out of scope for the initial cut (open question §8).

## 4. Where it plugs in

| File | Change |
|---|---|
| `src/snowman/physics.ts` | `playerJump` provenance; gated clean-landing boost vs. scrub; landing-quality calc. **The deterministic kernel — additive, input-gated only.** |
| `src/snowman/index.ts` | Extend `UpdateResult` with the new outputs (e.g. `landingQuality`, `airScoreDelta`); these are surfaced for the loop/HUD just like `technique`/`justLanded`/`landingForce` today. |
| `src/game/main-loop.ts` | Consume the new result fields: fire `showFlash`, accumulate run `airScore`, keep the existing landing camera shake. |
| `src/course.ts` | Hold/format `airScore`; show it on the result screen via `onFinish`; reuse `showFlash`. |
| `src/ui/hud.ts`, `src/ui/result-overlay.ts` | Optional air-score readouts. |
| `src/avalanche.ts` / `src/effects.ts` | Phase 2 dodge window: query proximity (`checkBurial`/distance) and grant the grace/boost. |
| `docs/PHYSICS.md` | Update §4 (Jumps & air) and §10 constants; note the new gated landing branch. |

## 5. Determinism & the test-safe seam (the #1 risk)

[`PHYSICS.md` §6](PHYSICS.md) guarantees **no-input identity**:
`tests/verification/physics_invariant_harness.js` asserts the coasting trajectory
differs from the frozen baseline by max-abs `0`, and also gates the carve-vs-skid,
snowplow, parallel, and hop checks. **Auto-jumps fire on the no-input path**, so:

1. **Every reward is gated on `playerJump`.** Auto-jump (and hop-turn) landings keep
   today's exact `landingImpact`/`landingForce`, so the coasting baseline does not
   move and `test:verify` max-diff stays `0`. This is the single most important
   constraint — the same input-gating discipline #136/#146 used.
2. **New gating harness checks** (mirroring the carve-vs-skid one): e.g. "a CLEAN,
   well-aimed player jump over a lip finishes faster than a SKETCHY one over the
   same lip," and an explicit "auto-jump landing trajectory unchanged" assertion.
3. **Baseline regen only if the no-input path genuinely changes** — and per §6 it
   must be ported into the classic-wrapper shape (drop `import * as THREE`/`export`,
   keep the `window.Snowman` block), **not** `git show … > snowman_baseline.js`.
   The goal is that this change is purely additive behind the manual-jump gate, so
   the coasting baseline does **not** need regenerating — only new manual-jump
   scenarios are added.
4. Browser suite (`?test=true`) + Playwright e2e for the UI/score surfacing.

## 6. Scope & phasing

- **Phase 1 (MVP, this proposal):** provenance flag → landing-quality grading →
  clean-landing speed boost → on-slope flash → per-run air score on the result
  screen. Kernel-additive, input-gated, self-contained.
- **Phase 2:** obstacle-clear scoring + the avalanche-dodge window (the #47
  headline) — needs the avalanche proximity/burial seam.
- **Phase 3 (#32):** spins/grabs/style combos using the existing air control;
  also produces richer per-run telemetry an AI coach (P3) can use.

## 7. Risks & mitigations

- **Touching the deterministic kernel** → input-gate everything on `playerJump`;
  add harness checks; avoid regenerating the coasting baseline.
- **Speed boost trivialising the course** → hard cap the impulse, require a clean
  (aligned) landing, keep the scrub for sketchy landings.
- **Inverting an existing penalty** → today airtime scrubs speed; we only flip that
  for *clean player jumps*, never for auto-jumps (which are no-input).
- **Mobile** → jump is a touch button; verify the dodge window and timing are
  reachable on touch (per the `controls.ts` touchstart gotcha).

## 8. Open questions (for review)

1. Should `airScore` feed the global leaderboard, or stay a per-run flourish for now?
2. Avalanche dodge: brief burial-immunity, a forward escape impulse, or both?
3. Landing-quality metric: velocity-vs-downhill alignment only, or also require a
   level-ish landing (terrain slope under the skis)?
4. Should an extreme landing **crash** (face-plant → #171 shatter) or just scrub hard?
5. Boost magnitude / cap and the CLEAN/OK/SKETCHY angle thresholds — tune live and
   lock with a gating harness check.
