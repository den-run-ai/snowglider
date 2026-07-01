#!/usr/bin/env node
// ONE-TIME: rewrite old raw.githubusercontent.com asset URLs in existing PR/issue
// bodies and comments to the new release URLs, using the asset-manifest.json that
// scripts/migrate-asset-branches.mjs produced. Run this BEFORE deleting the
// `assets/*` branches so no embed 404s in the project history.
//
// Matches each old URL with an optional trailing query string (some embeds carry
// a `?v=<sha>` cache-buster), so those are rewritten too.
//
// Usage:
//   node scripts/rewrite-asset-links.mjs [--dry-run]
//
// Auth: same token resolution as scripts/upload-release-asset.mjs.

import { readFileSync } from 'node:fs';
import { getToken, getRepo } from './upload-release-asset.mjs';

const API = 'https://api.github.com';
const dryRun = process.argv.includes('--dry-run');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteBody(body, manifest) {
  let out = body || '';
  for (const [oldUrl, newUrl] of Object.entries(manifest)) {
    const re = new RegExp(escapeRegExp(oldUrl) + '(\\?[^\\s)"\\]]*)?', 'g');
    out = out.replace(re, newUrl);
  }
  return out;
}

async function ghJson(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}\n${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function* paginate(token, path) {
  let url = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}\n${await res.text()}`);
    yield* await res.json();
    const link = res.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync('asset-manifest.json', 'utf8'));
  const repo = getRepo();
  const token = await getToken();
  const base = `/repos/${repo.owner}/${repo.repo}`;
  let changed = 0;

  // Issue + PR bodies (the issues endpoint covers both; PR bodies are editable here).
  for await (const issue of paginate(token, `${base}/issues?state=all`)) {
    const next = rewriteBody(issue.body, manifest);
    if (next !== (issue.body || '')) {
      console.log(`${dryRun ? '[dry-run] ' : ''}#${issue.number} body`);
      if (!dryRun) await ghJson(token, `${API}${base}/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ body: next }) });
      changed++;
    }
  }

  // Issue + PR comments (review comments are not covered; images there are rare).
  for await (const comment of paginate(token, `${base}/issues/comments`)) {
    const next = rewriteBody(comment.body, manifest);
    if (next !== (comment.body || '')) {
      console.log(`${dryRun ? '[dry-run] ' : ''}comment ${comment.id}`);
      if (!dryRun) await ghJson(token, `${API}${base}/issues/comments/${comment.id}`, { method: 'PATCH', body: JSON.stringify({ body: next }) });
      changed++;
    }
  }

  console.log(`\n${dryRun ? '[dry-run] ' : ''}${changed} bodies/comments ${dryRun ? 'would be' : 'were'} rewritten.`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
