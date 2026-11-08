# Image assets & screenshots

These tools can host **non-code images** — PR/issue screenshots and the production
`og:image` social card — on a single **GitHub Release** (tag `assets`). Adding the
tools does not migrate existing `assets/*` branches or change production image URLs.

## Why use release assets

The previous pattern pushed each batch of screenshots to its own orphan branch
(`assets/social-sharing-shots`, `assets/ski-redesign-shots`, …) and embedded them
via `raw.githubusercontent.com` URLs. That worked but had real downsides:

- **Extra refs to maintain** — each screenshot batch adds another branch that must
  be retained while its URLs are in use.
- **Extra fetch objects** — fetches that include those branches download their
  image objects even though the files are outside `main`.
- **Branch-dependent URLs** — deleting an asset branch breaks links that name it.

## The model

A GitHub Release is used purely as an object store:

- Release assets are stored separately from the repository's Git objects, so
  regular Git clones and fetches do not download their bytes. Their download URLs
  do not depend on the original `assets/*` branches.
- Stable URL shape:
  `https://github.com/<owner>/<repo>/releases/download/assets/<name>`
  (GitHub redirects downloads to its asset storage).
- The scripts accept a GitHub token from the environment or the Git credential
  helper.

The release is tagged `assets`, marked **prerelease / not latest**, so it never
poses as a software release.

Retain the release and its assets for as long as their download URLs are in use.

## Add a screenshot (going forward)

```bash
node scripts/upload-release-asset.mjs path/to/shot.png --name pr201-before.png
# prints: https://github.com/<owner>/<repo>/releases/download/assets/pr201-before.png
```

Paste the printed URL into the PR/issue body after verifying it loads. Prefix the
`--name` with the PR/issue number to keep the flat asset namespace tidy. An upload
with an existing name replaces that asset; use a new name to preserve the old image.

## The og:image card

The social-share card is the asset named `og-card.png`.

> **Transitional (as of this PR):** `index.html`'s `og:image` / `twitter:image` meta
> tags still point at the legacy `assets/og-image` **branch** URL
> (`raw.githubusercontent.com/.../assets/og-image/og-card.png`). This PR only lands the
> Release-based hosting **tooling**; repointing the production meta tags is the gated
> migration step (update `index.html`, then verify the live
> `snowglider.ai` link preview) and is intentionally **not** done here. Until that step
> lands, treat the branch URL as the source of truth for the live card.

Once the meta tags are repointed to the Release asset: when the card changes, re-upload
`og-card.png` (same name) and re-run the Facebook / LinkedIn / X card debuggers so the
scrapers re-cache.

## Screen recordings & demo videos

The choreographed video recorder proposed in
[draft PR #208](https://github.com/den-run-ai/snowglider/pull/208)
(`tools/record-deterministic.mjs` and `tools/build-demo-video.mjs`) remains unmerged.
Its capture contract requires repair and validation before the recording workflow
is ready to use.

For current screenshot evidence, use `npm run test:render-review` and the
[Rendering review workflow](../.github/workflows/render-review.yml). These capture
desktop and phone scenarios; the workflow compares the selected base and head.

Existing recordings can be uploaded to the `assets` Release.
`upload-release-asset.mjs` accepts `.gif` and `.mp4`:

```bash
node scripts/upload-release-asset.mjs /tmp/snowglider_demo.mp4 --name demo-v1.mp4
node scripts/upload-release-asset.mjs /tmp/snowglider_demo.gif --name demo-v1.gif
```

Use a **`.gif`** or a poster `.jpg` for an inline preview, and link the `.mp4` as
the full-quality download.

## One-time migration (operational runbook)

The steps that mutate the live repository are separate from merging the tooling;
run them deliberately only after reviewing the dry-run output.

1. **Dry run** the move to preview the asset names:
   ```bash
   git fetch origin
   node scripts/migrate-asset-branches.mjs --dry-run
   ```
   Dry runs never create or overwrite `asset-manifest.json`. Asset-name collisions
   are rejected before any upload, including in a real migration.
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
   The rewriter requires a real migration manifest containing release URLs in this
   repository; it rejects dry-run placeholders before reading credentials or
   contacting GitHub. It updates issue/PR bodies and conversation comments, not
   inline review comments, external embeds, or source files such as `index.html`.
5. **Retain branches until all references are verified.** Check inline review
   comments, repository files, external embeds, and any non-media files before
   separately approving deletion of the exact migrated branches. New asset branches
   may have appeared after the migration; do not delete them with a wildcard.

`asset-manifest.json` is generated output and is git-ignored.
