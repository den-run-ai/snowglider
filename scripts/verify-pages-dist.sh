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

# PWA service worker (issue #358, PR 3): the built worker must ship, and the raw TS
# worker source must NOT (it is compiled standalone by vite-plugin-pwa to dist/sw.js).
require_file dist/sw.js
if [ -f dist/src/pwa/sw.ts ]; then
  echo "::error::dist/src/pwa/sw.ts present — raw worker TypeScript leaked into the artifact"
  exit 1
fi

# Cache-safety (THE most important SW guard): the generated precache manifest inside
# dist/sw.js must never include the copied source / tests / node_modules / auth page /
# large MP3 / source maps. We check ONLY the precache entries — extracted as the
# `"url":"…"` values, which are unique to the injected manifest (the routing code uses
# url.pathname, so it legitimately mentions '/src/' etc. and must NOT be matched). If a
# glob change starts precaching a forbidden path, fail the build.
PRECACHE_URLS=$(grep -oE '"url":"[^"]*"' dist/sw.js | sed -E 's/"url":"(.*)"/\1/')
if [ -z "$PRECACHE_URLS" ]; then
  echo "::error::could not find any precache entries in dist/sw.js (injectManifest produced an empty manifest?)"
  exit 1
fi
while IFS= read -r u; do
  case "$u" in
    *src/*|*tests/*|*node_modules/*|*auth.html*|*.mp3|*.map)
      echo "::error::service-worker precache manifest includes a forbidden path: '$u' — check the injectManifest globs"
      exit 1;;
  esac
done <<EOF
$PRECACHE_URLS
EOF

echo "dist guard OK: transpiled JS present, PWA manifest+icons+sw present, precache excludes forbidden paths, no raw TypeScript in dist/"
