# Image assets & screenshots

SnowGlider hosts **non-code images** — PR/issue screenshots and the production
`og:image` social card — on a single **GitHub Release** (tag `assets`) instead of
the old `assets/*` orphan git branches.

## Why not git branches

The previous pattern pushed each batch of screenshots to its own orphan branch
(`assets/social-sharing-shots`, `assets/ski-redesign-shots`, …) and embedded them
via `raw.githubusercontent.com` URLs. That worked but had real downsides:

- **Branch sprawl** — ~16 branches that look deletable and nearly got cleaned up
  by accident.
- **Clone bloat** — orphan-branch blobs (~42&nbsp;MB) land in every full `git fetch`,
  permanently, even though they are never part of `main`.
- **Fragile URLs** — `raw.githubusercontent.com` is rate-limited and not a CDN, and
  the links break the moment anyone tidies the branches.

## The model

A GitHub Release is used purely as an object store:

- Release assets live in GitHub's blob storage (`objects.githubusercontent.com`,
  Fastly-backed) — they are **not** in the git object database, so they add
  nothing to clone size and survive branch deletion.
- Stable URL shape:
  `https://github.com/<owner>/<repo>/releases/download/assets/<name>`
  (302-redirects to the asset CDN with the right `Content-Type`).
- Fully scriptable with the token `git push` already uses — no new account, no
  DNS, no GitHub Pages change.

The release is tagged `assets`, marked **prerelease / not latest**, so it never
poses as a software release.

> Note: this is GitHub's CDN, not an independent third-party store (Cloudflare R2,
> S3, …). If a separate provider is ever wanted, the migration scripts below are
> mostly reusable — both flows are just "upload bytes → get a URL".

## Add a screenshot (going forward)

```bash
node scripts/upload-release-asset.mjs path/to/shot.png --name pr201-before.png
# prints: https://github.com/<owner>/<repo>/releases/download/assets/pr201-before.png
```

Paste the printed URL into the PR/issue body. Do **not** create new `assets/*`
branches. Prefix the `--name` with the PR/issue number to keep the (flat) asset
namespace tidy.

## The og:image card

The social-share card is the asset named `og-card.png`.

> **Transitional (as of this PR):** `index.html`'s `og:image` / `twitter:image` meta
> tags still point at the legacy `assets/og-image` **branch** URL
> (`raw.githubusercontent.com/.../assets/og-image/og-card.png`). This PR only lands the
> Release-based hosting **tooling**; repointing the production meta tags is the gated
> migration step (run `scripts/rewrite-asset-links.mjs`, then verify the live
> `snowglider.ai` link preview) and is intentionally **not** done here. Until that step
> lands, treat the branch URL as the source of truth for the live card.

Once the meta tags are repointed to the Release asset: when the card changes, re-upload
`og-card.png` (same name) and re-run the Facebook / LinkedIn / X card debuggers so the
scrapers re-cache.

## Screen recordings & demo videos

Motion features (carve/parallel, avalanche, the README demo) are captured with a
**deterministic headless recorder** — it drives the game behind a virtual clock
(overriding `requestAnimationFrame`/`performance.now`) so frames are exactly one
fixed timestep apart, yielding a smooth 30&nbsp;fps independent of the slow headless
software-GL render rate, then stitches the frames with ffmpeg. See the demo-video
tooling under `tools/` (`record-deterministic.mjs` + `build-demo-video.mjs`).

Recordings host the **same way** as screenshots — on the `assets` Release, **not**
an `assets/*` branch. `upload-release-asset.mjs` already accepts `.gif` and `.mp4`:

```bash
node scripts/upload-release-asset.mjs /tmp/snowglider_demo.mp4 --name demo-v1.mp4
node scripts/upload-release-asset.mjs /tmp/snowglider_demo.gif --name demo-v1.gif
```

One honest caveat about video: a release-download `.mp4` URL embeds as a *link*,
not an inline `<video>` player (only GitHub's drag-and-drop `user-attachments`
render a player, and that path isn't scriptable). So for an inline-playing preview
use a **`.gif`** (renders inline as an image) or a poster `.jpg`, and keep the
`.mp4` as the full-quality download. That matches the demo PR's existing layout
(gif preview + still jpgs), just pointed at the Release instead of a branch.

## One-time migration (operational runbook)

These scripts moved the existing branch contents onto the release. They are kept
for auditability and reuse; the steps that mutate the live repo are **gated** —
run them deliberately.

1. **Dry run** the move to preview the asset names:
   ```bash
   git fetch origin
   node scripts/migrate-asset-branches.mjs --dry-run
   ```
2. **Migrate** (creates the `assets` release on first upload, writes
   `asset-manifest.json` mapping old URL → new URL):
   ```bash
   node scripts/migrate-asset-branches.mjs
   ```
   Only media (`png/jpg/gif/webp/svg/mp4/…`) is moved — all images/gifs/clips
   across the `assets/*` branches (run `--dry-run` for the current count; new
   `*-shots` branches keep appearing). Two branches (`ski-design-proposal`,
   `snowman-flex-shots`) were
   created as full repo mirrors, so they also carry source, CI workflows and the
   game audio; those are intentionally **not** migrated. If a non-media artifact
   on one of those branches is still wanted (e.g. the `ski_design_3d.py` mockup
   generator), preserve it separately before deleting the branch in step 5.
3. **Repoint the og:image** — update the two `og:image` / `twitter:image` URLs in
   `index.html` to `.../releases/download/assets/og-card.png`, then verify with the
   social card debuggers before continuing.
4. **Rewrite old links** in existing PR/issue bodies & comments (preview first):
   ```bash
   node scripts/rewrite-asset-links.mjs --dry-run
   node scripts/rewrite-asset-links.mjs
   ```
5. **Delete the retired branches** once steps 3–4 are verified:
   ```bash
   git push origin --delete $(git branch -r --list 'origin/assets/*' | sed 's#origin/##')
   ```

`asset-manifest.json` is generated output and is git-ignored.
