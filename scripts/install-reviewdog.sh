#!/usr/bin/env bash
# action-eslint@v1.34.0 ignores installer failure and then invokes reviewdog.
# Preinstall its exact version so that action's temporary PATH prefix retains a
# verified fallback. Keep reporter/filter/failure policy in pr-review.yml.
set -euo pipefail

reviewdog_version=0.21.0
reviewdog_archive=reviewdog_0.21.0_Linux_x86_64.tar.gz
# Official release asset digest, recorded from:
# https://api.github.com/repos/reviewdog/reviewdog/releases/tags/v0.21.0
reviewdog_sha256=ad5ce7d5ffa52aaa7ec8710a8fa764181b6cecaab843cc791e1cce1680381569
reviewdog_url="https://github.com/reviewdog/reviewdog/releases/download/v$reviewdog_version/$reviewdog_archive"

if [[ "$(uname -sm)" != "Linux x86_64" ]]; then
  echo "::error::The pinned reviewdog installer requires Linux x86_64." >&2
  exit 1
fi
# GitHub supplies these paths. Refuse to publish a binary outside that context.
if [[ -z "${RUNNER_TEMP:-}" || -z "${GITHUB_PATH:-}" ]]; then
  echo "::error::RUNNER_TEMP and GITHUB_PATH must be set." >&2
  exit 1
fi

reviewdog_tmp="$(mktemp -d "$RUNNER_TEMP/reviewdog-install.XXXXXX")"
trap 'rm -rf "$reviewdog_tmp"' EXIT
reviewdog_bin="$RUNNER_TEMP/reviewdog-bin"

# At most four attempts; each transfer and the retry window are bounded. Keep
# HTTP/transport diagnostics visible instead of silently continuing to ESLint.
curl --fail --show-error --silent --location \
  --proto '=https' --proto-redir '=https' \
  --retry 3 --retry-all-errors --retry-delay 2 --retry-max-time 180 \
  --connect-timeout 10 --max-time 45 \
  --output "$reviewdog_tmp/$reviewdog_archive" "$reviewdog_url"
printf '%s  %s\n' "$reviewdog_sha256" "$reviewdog_tmp/$reviewdog_archive" \
  | sha256sum --check --strict

# Extract only the known executable, and never run unverified downloaded bytes.
tar -xzf "$reviewdog_tmp/$reviewdog_archive" -C "$reviewdog_tmp" reviewdog
reviewdog_actual="$("$reviewdog_tmp/reviewdog" -version)"
if [[ "$reviewdog_actual" != "$reviewdog_version" ]]; then
  echo "::error::Expected reviewdog $reviewdog_version; received $reviewdog_actual." >&2
  exit 1
fi

install -d "$reviewdog_bin"
install -m 0755 "$reviewdog_tmp/reviewdog" "$reviewdog_bin/reviewdog"
printf '%s\n' "$reviewdog_bin" >> "$GITHUB_PATH"
echo "Verified reviewdog $reviewdog_version is available for the review action."
