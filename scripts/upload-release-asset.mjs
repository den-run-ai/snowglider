#!/usr/bin/env node
// Upload a file (typically a PR/issue screenshot or the og:image card) to the
// GitHub Release that SnowGlider uses as its asset store, and print the stable
// download URL.
//
// Why a Release instead of an `assets/*` git branch: release assets live in
// GitHub's blob storage (objects.githubusercontent.com, Fastly-backed) — they
// are NOT part of the git object database, so they add nothing to clone size,
// never clutter the branch list, and survive branch deletion. See docs/ASSETS.md.
//
// Usage:
//   node scripts/upload-release-asset.mjs <file> [--name <assetName>] [--tag <tag>]
//   node scripts/upload-release-asset.mjs shot.png --name pr201-before.png
//
// Auth: a token is read from $GITHUB_TOKEN / $GH_TOKEN, else from the git
// credential helper (the same token `git push` uses). The token is never printed.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export const DEFAULT_TAG = 'assets';
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

/** Resolve a GitHub token from the environment or the git credential helper. */
export async function getToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env.trim();
  const token = await new Promise((resolve, reject) => {
    const p = spawn('git', ['credential', 'fill'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => {
      const m = out.match(/^password=(.*)$/m);
      resolve(m ? m[1] : null);
    });
    p.stdin.write('protocol=https\nhost=github.com\n\n');
    p.stdin.end();
  });
  if (!token) {
    throw new Error('No GitHub token: set $GITHUB_TOKEN or configure the git credential helper.');
  }
  return token;
}

/** Determine { owner, repo } from $GITHUB_REPOSITORY or the `origin` remote. */
export function getRepo() {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv && fromEnv.includes('/')) {
    const [owner, repo] = fromEnv.split('/');
    return { owner, repo };
  }
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Cannot parse owner/repo from origin url: ${url}`);
  return { owner: m[1], repo: m[2] };
}

async function gh(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}\n${body}`);
  }
  return res;
}

function contentType(name) {
  const ext = name.toLowerCase().split('.').pop();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', json: 'application/json',
  })[ext] || 'application/octet-stream';
}

/**
 * Look up the asset-store release by tag, creating it (as a prerelease, never
 * "latest") on first use so it does not pose as a software release.
 */
export async function ensureRelease(token, repo, tag = DEFAULT_TAG) {
  const lookup = await fetch(`${API}/repos/${repo.owner}/${repo.repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (lookup.ok) return lookup.json();
  if (lookup.status !== 404) {
    throw new Error(`Release lookup for "${tag}" failed: ${lookup.status} ${await lookup.text()}`);
  }
  const created = await gh(token, `${API}/repos/${repo.owner}/${repo.repo}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      name: 'Hosted assets (screenshots & social-share card)',
      body: [
        'Not a software release. This release is SnowGlider\'s asset store: it holds',
        'PR/issue screenshots and the og:image social card, served from GitHub\'s',
        'asset CDN instead of orphan `assets/*` branches. See docs/ASSETS.md.',
      ].join(' '),
      prerelease: true,
      make_latest: 'false',
    }),
  });
  return created.json();
}

/** Upload a Buffer/Uint8Array as a release asset, replacing any same-named asset. */
export async function uploadBuffer(data, assetName, { token, repo, tag = DEFAULT_TAG } = {}) {
  token = token || await getToken();
  repo = repo || getRepo();
  const release = await ensureRelease(token, repo, tag);
  const existing = (release.assets || []).find((a) => a.name === assetName);
  if (existing) {
    await gh(token, `${API}/repos/${repo.owner}/${repo.repo}/releases/assets/${existing.id}`, { method: 'DELETE' });
  }
  const url = `${UPLOADS}/repos/${repo.owner}/${repo.repo}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`;
  const res = await gh(token, url, {
    method: 'POST',
    headers: { 'Content-Type': contentType(assetName) },
    body: data,
  });
  const asset = await res.json();
  return asset.browser_download_url;
}

/** Read a file from disk and upload it as a release asset. Returns the download URL. */
export async function uploadReleaseAsset(filePath, { name, tag = DEFAULT_TAG } = {}) {
  const data = await readFile(filePath);
  return uploadBuffer(data, name || basename(filePath), { tag });
}

function parseArgs(argv) {
  const out = { tag: DEFAULT_TAG };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--tag') out.tag = argv[++i];
    else if (!a.startsWith('--') && !out.file) out.file = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return out;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const { file, name, tag } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error('Usage: node scripts/upload-release-asset.mjs <file> [--name <assetName>] [--tag <tag>]');
    process.exit(1);
  }
  uploadReleaseAsset(file, { name, tag })
    .then((url) => { console.log(url); })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
