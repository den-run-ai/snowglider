#!/usr/bin/env node
// audit-missed-main.mjs
//
// Guard against the "silent miss" bug: a PR that shows as MERGED on GitHub but whose
// commits never actually reached `main`.
//
// HOW IT HAPPENS
//   PR B is stacked on PR A's branch. PR A merges into `main` first, which consumes
//   A's branch. PR B is still targeting A's (now dead) branch, so when B "merges" it
//   merges into a ref that no longer feeds `main` — B's commits never propagate.
//   GitHub still marks B merged, so the miss is invisible. This bit #277 (re-landed by
//   #313) and #308 (re-landed by #311). See issue #312.
//
//   A compounding symptom: this repo's CI only runs on `base=main` PRs (see
//   .github/workflows/ci.yml `pull_request: branches: [main]`), so a PR stacked on a
//   non-main branch also never gets CI — a second reason not to stack on a branch that
//   is about to merge.
//
// WHAT THIS CHECKS
//   Every MERGED PR whose base branch is NOT the default branch is a candidate (only
//   such a PR *can* miss main — a merged `base=main` PR is on main by definition). For
//   each candidate we ask GitHub whether the PR's merge commit is actually contained in
//   the default branch, via `GET /compare/{default}...{mergeSha}`:
//       status 'identical' | 'behind'  -> merge commit is an ancestor of main  (REACHED)
//       status 'ahead'     | 'diverged'-> merge commit is not in main           (MISSED)
//   A MISSED candidate that is not acknowledged in scripts/missed-main-allowlist.json
//   fails the audit (exit 1). Acknowledged entries (a PR re-landed on main by a later
//   PR, e.g. #277 -> #313) are reported but do not fail — the original merge commit can
//   never become an ancestor of main, so it would otherwise alarm forever.
//
//   Out of scope: a `base=main` PR that was later reverted. That is a different failure
//   mode (the change *did* reach main, then left) and would false-alarm permanently; the
//   stacking hazard above is what this guard is for.
//
// AUTH  GITHUB_TOKEN / GH_TOKEN from the env (GitHub Actions provides `github.token`),
// else the local git credential helper (same trick documented in CLAUDE.md). Pure Node
// built-ins + global fetch (Node 18+); zero install.
//
// USAGE
//   node scripts/audit-missed-main.mjs            # audit; exit 1 if an un-acked miss
//   node scripts/audit-missed-main.mjs --json     # machine-readable JSON report
//   GITHUB_REPOSITORY=owner/repo node scripts/audit-missed-main.mjs
//
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = join(__dirname, 'missed-main-allowlist.json');

// ============================================================ pure, testable helpers ===

/**
 * Decide whether a PR's merge commit reached the default branch, given the `status`
 * field GitHub's compare API returns for `compare/{default}...{mergeSha}`.
 * @param {string} status - one of 'identical' | 'behind' | 'ahead' | 'diverged'
 * @returns {boolean} true when the merge commit is contained in the default branch
 */
export function reachedDefaultBranch(status) {
  // base=default, head=mergeSha. If the merge commit is an ancestor of the default
  // branch, GitHub reports the head as 'behind' the base (or 'identical' when it *is*
  // the tip). 'ahead'/'diverged' means the merge commit carries work the default branch
  // does not contain -> it never landed.
  return status === 'identical' || status === 'behind';
}

/**
 * Load and normalize the acknowledgement allowlist. Keys are PR numbers (as strings);
 * keys beginning with `_` are treated as comments and ignored.
 * @param {string} [text] - raw JSON text (defaults to reading ALLOWLIST_PATH)
 * @returns {Record<string,string>} map of acknowledged PR number -> reason
 */
export function parseAllowlist(text) {
  const raw = text != null ? text : (existsSync(ALLOWLIST_PATH) ? readFileSync(ALLOWLIST_PATH, 'utf8') : '{}');
  const obj = JSON.parse(raw);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    out[String(Number(k))] = String(v);
  }
  return out;
}

/**
 * Split evaluated candidates into misses vs un-acknowledged misses.
 * @param {Array<{number:number, reached:boolean}>} candidates
 * @param {Record<string,string>} allowlist - PR number -> ack reason
 * @returns {{misses:Array, unacked:Array, acked:Array}}
 */
export function evaluate(candidates, allowlist) {
  const misses = candidates.filter((c) => !c.reached);
  const acked = misses.filter((c) => String(c.number) in allowlist);
  const unacked = misses.filter((c) => !(String(c.number) in allowlist));
  return { misses, unacked, acked };
}

// ============================================================================ runtime ===

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(2); // 2 = the audit could not run (distinct from 1 = a miss was found)
}
const log = (m) => console.log(`  ${m}`);

function resolveToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    const m = out.match(/^password=(.*)$/m);
    if (m && m[1]) return m[1];
  } catch { /* no credential helper / not configured */ }
  return null;
}

function resolveRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    }).trim();
    const m = url.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (m) return m[1];
  } catch { /* not a git checkout */ }
  return null;
}

async function gh(token, path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'snowglider-audit-missed-main',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function listMergedPRs(token, repo) {
  const merged = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await gh(token, `/repos/${repo}/pulls?state=closed&per_page=100&page=${page}`);
    if (!batch.length) break;
    for (const p of batch) {
      if (p.merged_at) {
        merged.push({
          number: p.number,
          title: p.title,
          base: p.base.ref,
          head: p.head.ref,
          headSha: p.head.sha,
          mergeSha: p.merge_commit_sha,
          mergedAt: p.merged_at,
        });
      }
    }
    if (batch.length < 100) break;
  }
  return merged;
}

async function checkRunCount(token, repo, sha) {
  try {
    const d = await gh(token, `/repos/${repo}/commits/${sha}/check-runs`);
    return d.total_count;
  } catch {
    return null; // informational only
  }
}

async function main() {
  const jsonOut = process.argv.includes('--json');
  const token = resolveToken();
  if (!token) die('No GitHub token. Set GITHUB_TOKEN/GH_TOKEN, or configure git credentials for github.com.');
  const repo = resolveRepo();
  if (!repo) die('Could not determine owner/repo. Set GITHUB_REPOSITORY=owner/repo.');

  const allowlist = parseAllowlist();
  const repoInfo = await gh(token, `/repos/${repo}`);
  const defaultBranch = repoInfo.default_branch || 'main';

  if (!jsonOut) log(`Auditing merged PRs in ${repo} against default branch '${defaultBranch}'…`);

  const merged = await listMergedPRs(token, repo);
  const candidates = merged.filter((p) => p.base !== defaultBranch);

  const evaluated = [];
  for (const c of candidates) {
    let reached = false;
    let compareStatus = 'unknown';
    if (c.mergeSha) {
      const cmp = await gh(token, `/repos/${repo}/compare/${encodeURIComponent(defaultBranch)}...${c.mergeSha}`);
      compareStatus = cmp.status;
      reached = reachedDefaultBranch(cmp.status);
    }
    const checks = await checkRunCount(token, repo, c.headSha);
    evaluated.push({ ...c, reached, compareStatus, checks });
  }

  const { misses, unacked, acked } = evaluate(evaluated, allowlist);

  if (jsonOut) {
    console.log(JSON.stringify({
      repo, defaultBranch,
      totalMerged: merged.length,
      candidates: evaluated.length,
      misses: misses.map((m) => ({ number: m.number, base: m.base, checks: m.checks, acked: String(m.number) in allowlist })),
      unacked: unacked.map((m) => m.number),
    }, null, 2));
    process.exit(unacked.length ? 1 : 0);
  }

  log(`Scanned ${merged.length} merged PRs; ${evaluated.length} targeted a non-default base (the only PRs that can miss ${defaultBranch}).`);
  console.log('');

  if (!misses.length) {
    log(`✅ Every merged PR reached '${defaultBranch}'. No silent misses.`);
    process.exit(0);
  }

  for (const m of misses) {
    const ackReason = allowlist[String(m.number)];
    const tag = ackReason ? '✓ acknowledged' : '✗ MISSED main';
    console.log(`  ${tag}  #${m.number}  (base=${m.base}, CI check-runs=${m.checks == null ? '?' : m.checks})`);
    console.log(`      ${m.title}`);
    if (ackReason) console.log(`      allowlisted: ${ackReason}`);
    console.log('');
  }

  if (acked.length) log(`${acked.length} miss(es) acknowledged in scripts/missed-main-allowlist.json (re-landed on ${defaultBranch}).`);

  if (unacked.length) {
    console.log('');
    log(`✗ ${unacked.length} PR(s) merged but never reached '${defaultBranch}' and are NOT acknowledged:`);
    for (const m of unacked) log(`    #${m.number} — ${m.title}`);
    log('Re-land each on the default branch (a base=' + defaultBranch + ' PR, so it gets full CI), then add it to');
    log('scripts/missed-main-allowlist.json with the re-landing PR number. See issue #312.');
    process.exit(1);
  }

  process.exit(0);
}

// Only run when executed directly (not when imported by the test suite).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => die(e.message));
}
