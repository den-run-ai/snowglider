# SnowGlider — Implementation Report
### Skill & Structure layer: gates/checkpoints, carving/snowplow, avalanche warning UI, and ghost racing

**Scope of this work:** the single *Top Recommendation* from the feature-gap analysis —

> gates/checkpoints + carving/snowplow mechanics + avalanche warning UI, plus split-time ghost racing.

This is the layer the report argues should ship *before* more content, because it converts a pleasant
Three.js snowman demo into a game with skill, tension, and a reason to replay. Everything below was
implemented against the repository at `github.com/den-run-ai/snowglider` and verified headlessly in this
session.

---

## 1. Summary of changes

| File | Status | What changed |
|------|--------|--------------|
| `course.js` | **new** (~560 lines) | Checkpoint gates + finish arch, live split timing, progress HUD, ghost racing, result screen |
| `effects.js` | **new** (~190 lines) | Avalanche warning banner + danger meter + vignette + camera shake; speed‑based FOV |
| `snowman.js` | modified | Carving / snowplow / tuck ski‑technique model; technique + landing surfaced for HUD/juice |
| `snowglider.js` | modified | Wires the two modules into reset, the animation loop, and game‑over; HUD technique readout |
| `index.html` | modified | Loads `effects.js` and `course.js` in the existing script chain, before `snowglider.js` |

Net: **2 new files, 3 modified files, +195 / −13 lines on tracked files.** No dependencies added, no
build step, no changes to the Firebase/auth/audio/scores subsystems.

---

## 2. How each recommendation was addressed

### 2.1 A clearer course and objective feedback (report §1) — `course.js`

The slope previously read as a sandbox: the only objective was the implicit "reach `z < -195`". The course
is now legible end‑to‑end:

- **Gates** are placed down the fall line at `z = -60, -105, -150`, plus a larger gold **finish arch** at
  `z = -195`. Each gate is two coloured poles + a banner with a canvas‑texture label
  (`CHECKPOINT 1…3`, `FINISH`). Gates are **purely decorative — they never collide**, so they cannot fight
  the existing tree‑collision system.
- A **progress bar + "m to finish"** read‑out sits at the top of the screen (1 world unit = 1 m, ~180 m
  course).
- Crossing a checkpoint flashes the **split time** and, once you have a personal best, the **±delta vs your
  best split** in green/red.
- A **result screen** at the finish shows total time, a medal, an improvement line, and a per‑checkpoint
  split table with Δ‑vs‑best.

### 2.2 Skiing skill, not just steering (report §2, issues #48/#54) — `snowman.js`

The original handling was "slide with steering": left/right added lateral velocity with constant friction,
and the brake only nudged downhill velocity. The new model rewards technique:

- **Snowplow / "pizza" brake (Down):** decelerates along the *actual* direction of travel (sheds real
  speed, not just downhill velocity) and *raises* steering authority + grip, so you can scrub speed under
  control. The skis visibly form a wedge.
- **Carving vs skidding (Left/Right):** smooth turns hold speed; hard turns at speed wash the edges out and
  scrub speed. The penalty scales with speed and (inversely) with grip, so panic‑steering at speed costs
  you while anticipatory turns do not.
- **Tuck / straight‑line (Up, no steer):** least friction, most speed, least room to react — the
  risk/reward line.
- **Terrain‑dependent grip:** a touch more bite on moderate pitches, looser when flat (folded into the
  carve/skid term, not the base coast friction — see §4).

The live technique (`Carving / Snowplow / Tuck / Skidding / Ground`) is shown in the Game Stats HUD.

### 2.3 Telegraphing and drama around the avalanche (report §3, issues #44/#49) — `effects.js`

The avalanche existed but was poorly communicated, especially from behind. Now, while it is bearing down:

- A red **warning banner** ("⚠ AVALANCHE — GO!", escalating to "RIGHT BEHIND YOU!" when very close).
- A **danger meter** showing metres behind you, filling amber→red as it closes.
- A **red vignette** and **camera shake** whose intensity rise with proximity.

These are driven by the avalanche system's existing `getClosestDistance(playerPos)` and `active` flag, so no
changes to `avalanche.js` were needed.

### 2.4 Progression and replay hooks (report §6) — `course.js`

- **Ghost racing:** your best run's trajectory is recorded (~20 Hz) and replayed as a translucent blue
  snowman you race in real time. A HUD read‑out shows **AHEAD / BEHIND** by seconds, computed at your
  current depth on the hill.
- **Medals:** awarded relative to your own pace, which is robust without a hand‑tuned global par —
  *first descent* (first finish), *new record* (beat your best), *silver* (within +10 %), *bronze*
  (within +25 %), else *finished*.
- **Persistence:** best splits (`snowgliderBestSplits`) and the best‑run ghost (`snowgliderGhost`) are
  saved to `localStorage` and committed **only when a run beats the stored best**, keeping the ghost
  honest. This complements — and does not change — the existing `snowgliderBestTime` flow.

### 2.5 Game feel / "juice" (report §7) — `effects.js`

- **Speed‑based FOV** widens from 75° toward 88° at speed for a sense of acceleration.
- **Camera shake** on hard landings (scaled by airtime) and on avalanche proximity.
- All motion respects `prefers-reduced-motion`.

---

## 3. Controls (additions)

| Input | Before | After |
|-------|--------|-------|
| ↓ / S | weak downhill nudge | **Snowplow brake** — sheds real speed, tighter turns, ski wedge |
| ← → / A D | add lateral velocity | **Carve** (smooth) holds speed; **skid** (hard, fast) scrubs speed |
| ↑ / W | accelerate | **Tuck / straight‑line** — max speed, least control |

No keys were added or remapped, so the existing keyboard/touch handling and `controls-tests` are untouched.

---

## 4. Key design decision: a test‑safe physics seam

The repository ships a comprehensive test suite, and several browser tests drive the **real**
`Snowman.updateSnowman`. The ski‑technique model is therefore layered so that **when the player gives no
steering or brake input, the grounded physics is byte‑for‑byte identical to the original**:

- The skid‑scrub term is `0` unless the player is steering, so the friction applied while coasting is
  unchanged.
- The snowplow deceleration branch only runs on `controls.down`.
- `turnForce` is recomputed but is only *applied* under left/right input, and the sign is preserved
  (left → −x, right → +x), so the sign‑based physics assertions still hold.
- The terrain‑dependent term modifies carve/skid grip only — never the base coast friction.

This was not assumed; it was **measured** (see §5).

---

## 5. Verification

All suites were run at integration time (see `verification/results.txt`), **including the browser/Puppeteer
suite** — which the original packaging sandbox could not run. Against the fully integrated game (which now
loads `effects.js` + `course.js`), `npm run test:browser` is **51/51 passing, 0 failed**, identical to a
clean baseline checkout; an in‑browser probe additionally confirms `CourseModule`/`EffectsModule` initialize,
the course HUD and avalanche banner build, and the checkpoint labels are unified, with no page errors. Re‑run
before deploy as a matter of course.

**5.1 Node regression suite — 31/31 passing**, before and after the changes
(terrain 7, physics 6, regression 5, tree‑collision 3, avalanche 10). `three` was installed in an isolated
directory so the two `three`‑dependent suites could run.

**5.2 Physics invariant + technique harness** (`verification/physics_invariant_harness.js`) loads the
baseline `updateSnowman` (the frozen pre‑feature snapshot `verification/snowman_baseline.js`) and the current
one with a shared deterministic terrain and a seeded RNG, then compares trajectories. **All five checks are
reported here** (one is a deliberate diagnostic, not a pass):

1. **Coasting, no input: max abs difference `0.000e+0` → IDENTICAL ✅.** The load‑bearing property that keeps
   the existing suite green; the harness's exit code gates on this.
2. **Snowplow (Down):** final speed `0.13` vs `3.27` coasting — brakes to a near‑stop ✅.
3. **Hold Right vs coast straight:** turn ends faster than coasting → **"turning costs speed" is `❌`.** This
   is a **diagnostic, not a regression**: the technique model is intentionally thin (the lateral turn force
   still nets positive at normal speeds; skid scrub only dominates at high speed), so it does **not** fail the
   build. Deepening it is a tracked design decision — see §8 and issues #48/#54.
4. **Same Right input, baseline vs current:** current is slower, edge scrub active ✅.
5. **High‑speed hard turn (entry 20 u/s):** current ~9 % slower than baseline ✅.

**5.3 DOM smoke test** (`verification/dom_smoke_test.js`, jsdom + a mocked THREE) — **16/16 passing**:
both modules build their DOM/gates without throwing; the full per‑frame loop runs; every checkpoint and the
finish are reached; the ghost trajectory and best splits persist; the result panel is produced; and a faster
second run is correctly reported as a new record.

**5.4 Static checks:** `node --check` passes on all four JS files and on the extracted inline loader block
in `index.html`; no test references `fov` and none invoke `animate()`, so the loop‑only FOV/shake cannot
affect the camera suite.

---

## 6. Integration points (for review)

- **`snowglider.js` init** (after the snowman is created): `CourseModule.init({ scene, getTerrainHeight,
  createSnowman })` and `EffectsModule.init()`.
- **`resetSnowman()`**: `CourseModule.reset()` + `EffectsModule.reset()` start a fresh timed run.
- **`animate()`**: `CourseModule.update(pos, elapsed, snowman)` each frame; the avalanche block feeds
  `EffectsModule.updateAvalanche(active, distance)`; camera shake/FOV are applied for the render and the
  positional offset is reverted afterward so the camera manager's own smoothing is never fed its own shake.
- **`showGameOver(reason)`**: captures `previousBest` *before* the existing finish branch mutates it, and on
  `"You reached the end of the slope!"` inserts `CourseModule.onFinish(elapsed, previousBest)` above the
  restart button. The load‑bearing finish string and the existing best‑time/leaderboard logic are unchanged.
- **`index.html`**: `effects.js` → `course.js` → `snowglider.js` in the existing sequential loader.

---

## 7. What to run

The five files are integrated directly into the repository (no patch/`src/` apply step). The headless
harnesses moved into `verification/` and are wired into `npm test` via `npm run test:verify`; `jsdom` was
added as a test‑only devDependency for the DOM smoke test.

```bash
npm ci                  # or: npm install
npm test                # Node suite + verify harness (test:verify) — physics invariant + DOM smoke
npm run test:browser    # Puppeteer suite — run before deploy
npm start               # play locally at http://localhost:8080
```

`verification/physics_invariant_harness.js` compares `verification/snowman_baseline.js` (the frozen
pre‑feature snapshot) against the live `snowman.js`; regenerate the baseline only on a deliberate physics
change (`git show <ref>:snowman.js > verification/snowman_baseline.js`, re‑adding the header).

**Recommended manual smoke before deploy:** one full run to the finish (confirm gates, splits, ghost, result
screen), a snowplow stop, a hard carve, an avalanche encounter from behind, and a **second run after a
personal best** to confirm split deltas stay live (the Gap‑2 fix).

---

## 8. Deliberately out of scope

Left for follow‑ups so this change stays focused on the top recommendation: snow trails carved from the skis,
a day→sunset→night skybox and weather, the "Yeti"-style chaser, arcade power‑ups, and the AI‑coach / NL course
prompt ideas from the report's AI section.
