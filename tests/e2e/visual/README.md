# Visual-regression specs (opt-in)

Plan §1B. These specs guard the game's **visual** surface — the bug history here is
almost entirely visual (colour management, the light-intensity rebalance, "grey
lines" shadow artifacts, snow readability, the sky cycle), none of which logic or
physics-invariant tests can reach.

They are **opt-in** and run via their own config, never the gating CI e2e job:

```bash
npm run test:e2e:visual          # compare against your committed-locally baselines
npm run test:e2e:visual:update   # (re)generate baselines for THIS environment
```

(`playwright.visual.config.ts`, Chromium-only.)

## Two tiers

- **`overlays.spec.ts` (1B-i) — the reliable everyday guard.** Screenshots the
  start menu, auth panel, and About panel: real, static HTML, so the diff is
  essentially deterministic (tight tolerance). `#buildBadge` is masked (it falls
  back to a wall-clock timestamp).
- **`canonical-frame.spec.ts` (1B-ii) — the flaky tier.** Screenshots the live
  WebGL canvas after seeding `Math.random` (reproducible terrain/tree layout) and
  freezing the sky cycle via reduced-motion. GPU/driver AA makes this
  non-deterministic, so it uses a generous tolerance and is **double-gated**: it
  only runs when `VISUAL_CANVAS=1` is also set.

## Why baselines are not committed

Pixel baselines depend on the **browser build + the host's installed system fonts**,
so a baseline generated on one machine won't match another (or the CI Playwright
image). The repo also keeps `main` text-only / binary-free (see `CLAUDE.md`), so
baseline PNGs are **gitignored** (`tests/e2e/visual/**/*-snapshots/`) — every
environment generates its own with `test:e2e:visual:update`.

To wire this into CI later: generate the baselines once **on the CI Playwright
image** (`mcr.microsoft.com/playwright:v1.61.0-noble`), host them via Git LFS or an
off-tree store per `CLAUDE.md`, and add a `test:e2e:visual` step. Until then this is
a local pre-push guard.
