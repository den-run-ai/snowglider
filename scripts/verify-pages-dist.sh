#!/usr/bin/env bash
#
# Verify the Vite production build (dist/) emitted transpiled JavaScript and that
# no raw TypeScript leaked into the deployable output.
#
# Why this exists: on GitHub Pages a raw .ts file is served with MIME
# "video/mp2t" and a missing .js 404s, which breaks every ES-module entrypoint —
# the exact failure mode of the 2026-06 production outage. The load-bearing fix
# for that outage was switching the Pages source to GitHub Actions
# (build_type=workflow) so the legacy "deploy from a branch" builder can no longer
# serve raw src/. This script is defense-in-depth: if the Vite build ever stops
# transpiling .ts -> .js, CI fails instead of shipping a broken artifact.
#
# Run AFTER `npm run build`. Shared by the per-PR `test` gate and the `build-pages`
# job so the assertion lives in exactly one place.
set -euo pipefail

require_js() {
  if [ ! -f "$1" ]; then
    echo "::error::expected transpiled $1 — the Vite build did not emit it"
    exit 1
  fi
}

require_js dist/src/main.js
require_js dist/src/boot/script-loader.js
require_js dist/src/ui/start-menu.js
require_js dist/src/auth.js
require_js dist/src/scores.js

if grep -En 'src/(main|boot/script-loader|ui/start-menu)\.ts|<script[^>]+type="module"[^>]+src="src/[^"]+\.ts"' dist/index.html; then
  echo "::error::dist/index.html references raw TypeScript module entrypoints"
  exit 1
fi

if find dist/src -name '*.ts' -print -quit | grep -q .; then
  echo "::error::dist/src contains raw TypeScript files (build did not transpile)"
  find dist/src -name '*.ts' -print
  exit 1
fi

# PWA install assets (issue #358, PR 2): the manifest + icon must ship so the game is
# installable. They live in public/ and Vite copies public/ to dist/ root on build; if
# that ever stops, the app silently loses installability — fail the build instead.
require_file() {
  if [ ! -f "$1" ]; then
    echo "::error::expected $1 in the Pages artifact — the build did not emit it"
    exit 1
  fi
}
require_file dist/manifest.webmanifest
require_file dist/icons/icon.svg

echo "dist guard OK: transpiled JS present, PWA manifest+icons present, no raw TypeScript in dist/"
