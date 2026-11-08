#!/usr/bin/env node
// ONE-TIME migration: copy the contents of every `assets/*` git branch onto the
// `assets` GitHub Release, then write asset-manifest.json mapping each old
// raw.githubusercontent.com URL -> new release download URL.
//
// After this runs and scripts/rewrite-asset-links.mjs updates the old PR/issue
// bodies, the `assets/*` branches can be deleted with no broken embeds. The
// production og:image (assets/og-image/og-card.png) becomes og-card.png on the
// release; flip index.html's meta tags to it only after verifying the new URL
// with the social card debuggers. See docs/ASSETS.md.
//
// Usage:
//   node scripts/migrate-asset-branches.mjs [--dry-run] [--tag assets]
//
// Reads remote refs from the local clone, so run `git fetch origin` first.

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getToken, getRepo, uploadBuffer, DEFAULT_TAG } from './upload-release-asset.mjs';

const MANIFEST = 'asset-manifest.json';
const dryRun = process.argv.includes('--dry-run');
const tagIdx = process.argv.indexOf('--tag');
const tag = tagIdx !== -1 ? process.argv[tagIdx + 1] : DEFAULT_TAG;

for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i];
  if (argument === '--dry-run') continue;
  if (argument === '--tag' && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    i++;
    continue;
  }
  throw new Error(`Unexpected or incomplete argument: ${argument}`);
}

/** Remote `assets/*` branches, e.g. ["assets/og-image", "assets/ski-redesign-shots"]. */
function assetBranches() {
  const out = execFileSync('git', ['branch', '-r', '--list', 'origin/assets/*'], { encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim().replace(/^origin\//, '')).filter(Boolean);
}

// Only images / gifs / short video are ever embedded via raw URLs. A couple of
// asset branches (ski-design-proposal, snowman-flex-shots) were created as full
// repo mirrors, so they also carry source, CI workflows and even the game audio —
// none of which belong on the asset release. Restrict the move to media.
const MEDIA = /\.(png|jpe?g|gif|webp|svg|avif|apng|mp4|mov|webm)$/i;

function filesIn(branch) {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', `origin/${branch}`], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter((f) => MEDIA.test(f));
}

// Release assets share a flat namespace, so flatten "<branch>/<path>" into a
// unique asset name. og-image keeps its bare filename (og-card.png) so the
// production meta tag gets a clean, stable URL.
function assetNameFor(branch, file) {
  const slug = branch.replace(/^assets\//, '').replace(/\//g, '__');
  const flat = file.replace(/\//g, '__');
  return slug === 'og-image' ? flat : `${slug}__${flat}`;
}

async function main() {
  const repo = getRepo();
  const branches = assetBranches();
  if (branches.length === 0) {
    console.error('No origin/assets/* branches found. Did you `git fetch origin`?');
    process.exit(1);
  }

  // Validate the entire flat namespace before any upload can replace an asset.
  const plan = [];
  const names = new Map();
  for (const branch of branches) {
    for (const file of filesIn(branch)) {
      const assetName = assetNameFor(branch, file);
      if (names.has(assetName)) {
        throw new Error(`Asset name collision: ${names.get(assetName)} and ${branch}/${file} both map to ${assetName}`);
      }
      names.set(assetName, `${branch}/${file}`);
      plan.push({ branch, file, assetName });
    }
  }

  const token = dryRun ? null : await getToken();
  const manifest = {};
  for (const { branch, file, assetName } of plan) {
    if (dryRun) {
      console.log(`would upload ${branch}/${file}  ->  ${assetName}`);
    } else {
      const oldUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}/${file}`;
      const buf = execFileSync('git', ['show', `origin/${branch}:${file}`], { maxBuffer: 64 * 1024 * 1024 });
      const newUrl = await uploadBuffer(buf, assetName, { token, repo, tag });
      manifest[oldUrl] = newUrl;
      console.log(`uploaded ${branch}/${file}  ->  ${newUrl}`);
    }
  }

  if (dryRun) {
    console.log(`\n[dry-run] ${plan.length} files across ${branches.length} branches. ${MANIFEST} was not changed.`);
  } else {
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\n${plan.length} files across ${branches.length} branches. Manifest written to ${MANIFEST}.`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
