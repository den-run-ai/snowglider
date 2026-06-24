# Physics / Frame-Rate Diagnostics

`src/diagnostics.ts` (`Diag`) is a **runtime telemetry observer** for the physics loop.
It exists to catch one specific, expensive class of bug — and the next one like it.

## The bug class it targets

PR #209 and its avalanche follow-up fixed two instances of the **same shape of bug**: a
quantity integrated as a *per-frame* multiplier (`v *= 1 − k`) sitting next to forces that
are *delta-scaled* (`v += a · dt`). Mix the two and the steady state scales with frame
rate. The snowman's terminal speed ballooned **~8 → ~32 m/s from 60 to 10 FPS**, fast
enough to slip between — and, when a per-frame step exceeded an obstacle's collision
radius, **tunnel straight through** — the trees.

Why it was so hard to find:

- **No existing test varied the frame time.** Every harness ran at a fixed `dt = 1/60`, so
  the whole dimension the bug lived in was unexercised.
- **It only bites on slow/mobile devices.** The developer's 60 FPS machine never sees it;
  the bug report is "the game freezes / I drove through a tree with no warning" — with no
  way to reproduce.

The offline stress harnesses (`tests/verification/forward_stress_harness.js`,
`physics_invariant_harness.js`) now **sweep `dt` in CI**. `Diag` is the **runtime
counterpart**: it watches the `dt` the *real device* produces and the speed/step that ride
on it, and surfaces the same smells live.

## What it detects

For every frame the main loop feeds it (`Diag.record(...)`), it classifies:

| Signal | Meaning | Verdict |
| --- | --- | --- |
| **step ≥ collision radius** | The per-frame move jumped farther than an obstacle's radius, so the discrete point-vs-disk collision check could skip the disk entirely. The radius is the **smallest** collidable obstacle — `min(tree 2.5u, smallest collidable rock ≈1.69u)` — so a step that would tunnel a small rock isn't masked by the larger tree radius. Runtime analog of the harness's offline tunneling probe. | **BAD** |
| **fps→speed ratio ≥ 2.0** | Max **cruise-speed** speed in low-FPS frames is ≥2× the max in high-FPS frames → a force path scales with frame time (the #209 signature, which was ~4×). Only *genuine cruising* frames (≥85% of the expected terminal speed) count, and each band needs a minimum of them — so a steady frame rate, an accelerating start, or a normal mid-run speed rise (e.g. 5→8 m/s) never reaches BAD. A milder gap (≥1.5×) is **WARN-only**, since it can come from run progression / technique rather than a frame-rate-dependent force. | **BAD** (≥1.5 → WARN) |
| **speed past the absolute ceiling** | A frame above `speedCeiling` (50 m/s) — impossible for legit play even buggy. Caught independent of frame rate, so a runaway with *no* FPS tell still fires. | **BAD** |
| **NaN / Infinity** | Non-finite physics state. | **BAD** |
| **≥10% of frames at the delta cap** | The device is below 1/cap FPS (the regime the bug bites). Informational, not an accusation. | **WARN** |

## How to use it

- **Console breadcrumbs.** During normal play, throttled `console.warn`s fire on any
  anomaly — so even a tester who never opened a panel leaves a trail in the console.
- **Live overlay.** Load the game with `?debug` (or press `` ` `` at any time) for a HUD:
  current/avg FPS, dt-cap hits, max step vs radius, the **speed-by-FPS-band** table, and
  the health verdict with reasons.
- **Bug-report export.** `window.__snowgliderDiag.dump()` returns *and downloads* a JSON
  trace — config, running summary, health verdict, recent frames, and any `note()`s —
  ready to attach to a GitHub issue. `snapshot()` returns it without downloading;
  `reset()` clears the trace; `overlay(true|false)` toggles the HUD.

## Aggregation: Firebase Analytics + global error capture

A detector whose output dies in the device console can't catch the *next* bug in the
wild. `Diag` therefore routes its findings into the **existing Firebase Analytics
pipeline** (`window.firebaseModules.logEvent`, the same seam `game_start`/`game_over`/
`game_reset` already use) via a `report` sink injected at `init()`:

- **`physics_anomaly`** — emitted **once per run** the moment a run's health first reaches
  BAD, with the structured summary (fps, dtMax, speedMax, tunnel/runaway/non-finite frame
  counts, fps→speed ratio). Aggregated across real devices, this is exactly how the #209
  class would have surfaced — low-FPS sessions correlating with runaway speed / tunnel
  events — instead of as an unreproducible "I drove through a tree".
- **`session_health`** — a **sampled baseline** so HEALTHY runs contribute data too, not
  just anomalies (an anomaly is only meaningful against a baseline). Same shape as
  `physics_anomaly` minus `reasons`, and it flattens the **FPS-band distribution**
  (`fps_ge50_frames`, `fps_30_50_frames`, `fps_15_30_frames`, `fps_lt15_frames`) so you can
  chart the real-world frame-rate spread and slice anomalies against it. Emitted on a
  periodic heartbeat through a long run (`healthSampleSec`, default 30s) **and once at
  run-end** — at the game-over/finish (`Diag.endRun()` from `showGameOver`), on the next
  `reset()`, or on `pagehide` if the player just navigates away — so even a short
  one-and-done run (finish/crash, then leave without pressing Reset) is sampled exactly once.
  All three paths share one de-duped flush, so a run is never double-counted; a
  trivial/empty run emits nothing.
- **`client_error` / `unhandled_rejection`** — the app had **no** `window.onerror` /
  `unhandledrejection` handler, so an uncaught throw in the rAF loop (a real "freezes"
  candidate) vanished silently. `Diag` installs both, attaching the message/stack plus the
  current physics snapshot as context.
- **`diag_note`** — the generic `Diag.note(category, detail)` seam lets **other
  subsystems** (asset loaders, avalanche, camera) report anomalies into the same pipeline,
  so diagnostics is not limited to the physics kernel. e.g.
  `Diag.note('asset_load_failed', { url })`.

The sink is wrapped so a telemetry failure can never throw into the game loop, is gated
exactly like the other `logEvent` call sites (modular SDK present, not `file://`), and is
inert under automation (the recorder is off there). Swapping the sink for a dedicated
error monitor (Sentry / self-hosted GlitchTip) later is a one-line change at the `init()`
call site — `Diag` itself stays decoupled from the transport.

## Design constraints (shared with `sfx`/`intro`/`debris`)

- **Read-only.** `record()` takes the per-frame result + `pos`; it never writes
  `pos`/`velocity` or any kernel state, so the physics-invariant harness stays
  byte-identical.
- **Automation-safe.** Off by default under `?test=` suites (`window.isTestMode`) and
  webdriver runs, unless a test opts in via `window.testHooks.diagnosticsEnabled`.
- **Cheap.** O(1) per frame — a fixed ring buffer plus an incremental summary fold (no
  full-history rescan). The overlay repaints at a throttled ~6 Hz; warnings are
  rate-limited per category.
- **Headless-testable.** All analytics (`percentile`, `classifyFrame`, `foldFrame`,
  `fpsSpeedRatio`, `frameRateHealth`) are exported pure functions with no DOM dependency,
  unit-tested in `tests/diagnostics-tests.js` (`npm run test:diagnostics`).

## Tests

`npm run test:diagnostics` proves the detector both **fires and stays quiet**:

- the real #209 numbers (8 → 32 m/s across a 60→10 FPS drop) grade **BAD** and the verdict
  cites both the tunnel risk and the frame-rate-dependent force;
- a steady 60 FPS run grades **OK**;
- a steady-slow-but-bounded device is **WARN**ed about the delta cap but **not** accused of
  the speed bug (the guard against crying wolf).

To disable the subsystem entirely, set `DIAG_ENABLED = false` in `src/diagnostics.ts`
(every method early-exits).
