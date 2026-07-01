#!/usr/bin/env node
// analytics-report.mjs
//
// Pull product analytics for SnowGlider straight from the live Firebase project and
// render a self-contained HTML dashboard + a machine-readable JSON snapshot.
//
// DATA SOURCES
//   1. Cloud Firestore  (always on) — the `users` and `leaderboard` collections are the
//      real, first-party record of who plays and how fast they finish. Read with an Admin
//      SDK service-account key over the Firestore REST API (no firebase-admin dep needed).
//   2. Google Analytics 4  (opt-in) — GA4 engagement/event metrics via the Analytics Data
//      API. This only works once (a) the Analytics Data API is enabled on the GCP project
//      AND (b) the service-account email is added as a Viewer on the GA4 property, and you
//      pass the numeric property id via GA4_PROPERTY_ID. Until then the report degrades
//      gracefully and prints the exact steps to turn it on — no crash, no empty page.
//
// AUTH  (why no firebase-admin / googleapis): those pull dozens of transitive deps and
// their ADC path is flaky on headless machines. Instead we mint a Google OAuth token by
// signing a JWT with the SA private key (RS256) and exchanging it — same battle-tested
// pattern as scripts/deploy-firestore-rules.mjs. Pure Node built-ins, zero install.
//
// SECRETS  live in the SnowGlider checkout, never in this worktree and never in git
// (.gitignore already blocks *-firebase-adminsdk-*.json). Resolution order:
//   --sa <path>  >  $SNOWGLIDER_SA  >  $GOOGLE_APPLICATION_CREDENTIALS  >
//   first *-firebase-adminsdk-*.json found in [cwd, this worktree, the main checkout].
//
// PRIVACY  the raw report embeds player emails + display names (admin-only view). Pass
// --redact to hash PII so the HTML/JSON can be shared. Outputs land in ./analytics-out/
// which is git-ignored — do not commit generated reports.
//
// USAGE
//   node scripts/analytics-report.mjs                 # write analytics-out/report.{html,json}
//   node scripts/analytics-report.mjs --open          # ...and open the HTML
//   node scripts/analytics-report.mjs --redact        # hash emails/names for sharing
//   node scripts/analytics-report.mjs --out dir --sa /path/to/key.json --json-only
//   GA4_PROPERTY_ID=123456789 node scripts/analytics-report.mjs   # include GA4 metrics
//
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createSign, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------- CLI ----
function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const OPTS = {
  out: argVal('--out') || join(REPO_ROOT, 'analytics-out'),
  sa: argVal('--sa') || process.env.SNOWGLIDER_SA || process.env.GOOGLE_APPLICATION_CREDENTIALS || null,
  redact: process.argv.includes('--redact'),
  jsonOnly: process.argv.includes('--json-only'),
  open: process.argv.includes('--open'),
  gaProperty: argVal('--ga-property') || process.env.GA4_PROPERTY_ID || null,
};

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}
const log = (m) => console.log(`  ${m}`);

// ---------------------------------------------------------- service-account discovery ----
function findServiceAccount() {
  if (OPTS.sa) {
    const p = isAbsolute(OPTS.sa) ? OPTS.sa : resolve(process.cwd(), OPTS.sa);
    if (!existsSync(p)) die(`service-account key not found at ${p}`);
    return p;
  }
  // Search cwd, this worktree, and the git *main* checkout (where the user keeps the key).
  const dirs = new Set([process.cwd(), REPO_ROOT]);
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    // First "worktree <path>" line is the main working tree.
    const main = list.split('\n').find((l) => l.startsWith('worktree '));
    if (main) dirs.add(main.slice('worktree '.length).trim());
  } catch { /* not a git checkout — fine */ }

  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    const hit = names.find((n) => /-firebase-adminsdk-.*\.json$/.test(n)) ||
                names.find((n) => /serviceAccount.*\.json$/i.test(n));
    if (hit) return join(dir, hit);
  }
  die('no service-account key found. Pass --sa <path>, set $SNOWGLIDER_SA, or place a\n' +
      '    *-firebase-adminsdk-*.json in the SnowGlider checkout.');
}

function loadServiceAccount(path) {
  let sa;
  try { sa = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { die(`could not read/parse service-account key ${path}: ${e.message}`); }
  if (sa.type !== 'service_account') die(`${path} is not a service_account key (type=${sa.type})`);
  for (const k of ['client_email', 'private_key', 'project_id']) {
    if (!sa[k]) die(`service-account key missing required field: ${k}`);
  }
  return sa;
}

// ------------------------------------------------------------------------ Google auth ----
const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getAccessToken(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(sa.private_key);
  const assertion = `${signingInput}.${b64url(signature)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.error_description || body.error || JSON.stringify(body);
    throw new Error(`token exchange failed (HTTP ${res.status}): ${detail}`);
  }
  return body.access_token;
}

// -------------------------------------------------------------------- Firestore layer ----
// Decode Firestore REST "typed value" wrappers into plain JS.
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

async function fetchCollection(token, project, collection) {
  const docs = [];
  let pageToken;
  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${collection}`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(`Firestore read ${collection} failed (HTTP ${res.status}): ${JSON.stringify(json)}`);
    for (const d of json.documents || []) {
      docs.push({ id: d.name.split('/').pop(), ...decodeFields(d.fields || {}) });
    }
    pageToken = json.nextPageToken;
  } while (pageToken);
  return docs;
}

// ------------------------------------------------------------------------ GA4 (opt-in) ----
// Returns { available, ...metrics } or { available:false, reason, howTo }.
async function fetchGa4(sa) {
  const howTo = [
    `Enable the Analytics Data API on GCP project ${sa.project_id}:`,
    `  https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=${sa.project_id}`,
    `Add the service account as a Viewer on the GA4 property (Admin → Property Access Management):`,
    `  ${sa.client_email}`,
    `Find the numeric property id (Admin → Property Settings) and re-run with:`,
    `  GA4_PROPERTY_ID=<id> node scripts/analytics-report.mjs`,
  ];
  if (!OPTS.gaProperty) {
    return { available: false, reason: 'No GA4_PROPERTY_ID provided.', howTo };
  }
  let token;
  try {
    token = await getAccessToken(sa, 'https://www.googleapis.com/auth/analytics.readonly');
  } catch (e) {
    return { available: false, reason: `Could not mint an Analytics token: ${e.message}`, howTo };
  }
  const property = `properties/${OPTS.gaProperty}`;
  async function runReport(body) {
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    return json;
  }
  try {
    const range = [{ startDate: '28daysAgo', endDate: 'today' }];
    const totals = await runReport({
      dateRanges: range,
      metrics: [
        { name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' },
        { name: 'engagedSessions' }, { name: 'engagementRate' },
        { name: 'averageSessionDuration' }, { name: 'eventCount' },
      ],
    });
    const m = totals.rows?.[0]?.metricValues?.map((x) => x.value) || [];
    const events = await runReport({
      dateRanges: range,
      dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }],
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 25,
    });
    const byEvent = (events.rows || []).map((r) => ({
      event: r.dimensionValues[0].value, count: Number(r.metricValues[0].value),
    }));
    const daily = await runReport({
      dateRanges: range,
      dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    });
    const timeline = (daily.rows || []).map((r) => ({
      date: r.dimensionValues[0].value,
      activeUsers: Number(r.metricValues[0].value),
      sessions: Number(r.metricValues[1].value),
    }));
    let country = [];
    try {
      const geo = await runReport({
        dateRanges: range,
        dimensions: [{ name: 'country' }], metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 10,
      });
      country = (geo.rows || []).map((r) => ({
        country: r.dimensionValues[0].value, activeUsers: Number(r.metricValues[0].value),
      }));
    } catch { /* geo optional */ }

    // Anomaly detection: pull daily counts PER event over a longer window, then flag any
    // (event, day) whose count is a statistical outlier vs that event's own recent history.
    // This is what surfaces "yesterday's spike" and, crucially, WHICH event spiked.
    let anomalies = { available: false, days: [], spikes: [] };
    try {
      const perEvent = await runReport({
        dateRanges: [{ startDate: '90daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'date' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      });
      // series[event] = Map(date -> count); also a per-day grand total.
      const series = new Map();
      const dayTotals = new Map();
      const days = new Set();
      for (const r of perEvent.rows || []) {
        const date = r.dimensionValues[0].value;
        const ev = r.dimensionValues[1].value;
        const c = Number(r.metricValues[0].value);
        days.add(date);
        if (!series.has(ev)) series.set(ev, new Map());
        series.get(ev).set(date, c);
        dayTotals.set(date, (dayTotals.get(date) || 0) + c);
      }
      const sortedDays = [...days].sort();
      series.set('(all events)', dayTotals);
      anomalies = {
        available: true, window: '90daysAgo → today',
        days: sortedDays,
        spikes: detectAnomalies(series, sortedDays),
      };
    } catch (e) {
      anomalies = { available: false, reason: e.message, days: [], spikes: [] };
    }

    return {
      available: true, propertyId: OPTS.gaProperty, window: '28daysAgo → today',
      totals: {
        activeUsers: +m[0] || 0, newUsers: +m[1] || 0, sessions: +m[2] || 0,
        engagedSessions: +m[3] || 0, engagementRate: +m[4] || 0,
        averageSessionDuration: +m[5] || 0, eventCount: +m[6] || 0,
      },
      byEvent, timeline, country, anomalies,
    };
  } catch (e) {
    return { available: false, reason: `GA4 query failed: ${e.message}`, howTo };
  }
}

// ------------------------------------------------------------------------- statistics ----
const num = (x) => typeof x === 'number' && isFinite(x);
function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos), rest = pos - base;
  return sortedAsc[base + 1] !== undefined
    ? sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base])
    : sortedAsc[base];
}
function stats(values) {
  const v = values.filter(num).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    count: v.length, min: v[0], max: v[v.length - 1], mean: sum / v.length,
    p25: quantile(v, 0.25), median: quantile(v, 0.5), p75: quantile(v, 0.75),
  };
}
function histogram(values, binCount = 10) {
  const v = values.filter(num);
  if (!v.length) return [];
  const min = Math.min(...v), max = Math.max(...v);
  if (min === max) return [{ from: min, to: max, count: v.length }];
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: min + i * width, to: min + (i + 1) * width, count: 0,
  }));
  for (const x of v) {
    let idx = Math.floor((x - min) / width);
    if (idx >= binCount) idx = binCount - 1;
    bins[idx].count++;
  }
  return bins;
}
// Robust spike detection for daily event counts. For each event and each day, compare that
// day's count to a baseline of the *preceding* days (median + MAD, robust to the spike
// itself). Flag days that are both a large multiple of the baseline AND far above it in
// robust-z terms — that combination is what a real "anomaly spike" looks like and avoids
// firing on tiny-count noise. Returns spikes sorted most-recent first.
function detectAnomalies(seriesByEvent, sortedDays, { minCount = 15, z = 3.5, mult = 3 } = {}) {
  const spikes = [];
  const MADK = 1.4826; // scale MAD to be a std-dev estimate for normal data
  for (const [event, byDate] of seriesByEvent) {
    const counts = sortedDays.map((d) => byDate.get(d) || 0);
    for (let i = 7; i < counts.length; i++) {         // need a week of history to judge
      const day = sortedDays[i], val = counts[i];
      if (val < minCount) continue;
      const hist = counts.slice(Math.max(0, i - 28), i); // up to 4 weeks of prior days
      if (hist.length < 5) continue;
      const sortedHist = [...hist].sort((a, b) => a - b);
      const median = quantile(sortedHist, 0.5);
      const mad = quantile(sortedHist.map((x) => Math.abs(x - median)).sort((a, b) => a - b), 0.5);
      const sigma = mad * MADK || (median || 1) * 0.3; // fall back if MAD collapses to 0
      const robustZ = (val - median) / sigma;
      const ratio = median > 0 ? val / median : Infinity;
      if (robustZ >= z && ratio >= mult) {
        spikes.push({
          event, date: day, count: val,
          baselineMedian: Math.round(median * 10) / 10,
          robustZ: Math.round(robustZ * 10) / 10,
          multiple: median > 0 ? Math.round(ratio * 10) / 10 : null,
        });
      }
    }
  }
  return spikes.sort((a, b) => b.date.localeCompare(a.date) || b.robustZ - a.robustZ);
}

// ------------------------------------------------------ tracking-coverage / gap audit ----
// Scan the game source for the analytics events it actually logs, then compare against a
// checklist of events/dimensions a game of this shape should track. Purely static — no
// live data needed — so gaps show up even when GA4 is offline.
function scanTrackedEvents(repoRoot) {
  const srcDir = join(repoRoot, 'src');
  if (!existsSync(srcDir)) return null;
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name === 'node_modules') continue;
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(name.name)) files.push(p);
    }
  })(srcDir);

  // Match logEvent(analytics|fm|window.firebaseModules, 'name') / .logEvent('name') and the
  // diagnostics this.emit('name') sink calls (all land in GA4 via the report seam).
  const reLog = /\.?logEvent\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?['"]([a-z][a-z0-9_]+)['"]/g;
  const reEmit = /\bemit\(\s*['"]([a-z][a-z0-9_]+)['"]/g;
  const found = new Map(); // event -> Set(file)
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const rel = f.slice(repoRoot.length + 1);
    for (const re of [reLog, reEmit]) {
      re.lastIndex = 0;
      let mm;
      while ((mm = re.exec(src))) {
        const ev = mm[1];
        if (ev === 'log' || ev === 'name') continue; // skip identifiers/false hits
        if (!found.has(ev)) found.set(ev, new Set());
        found.get(ev).add(rel);
      }
    }
  }
  return [...found.entries()]
    .map(([event, files2]) => ({ event, files: [...files2] }))
    .sort((a, b) => a.event.localeCompare(b.event));
}

// The audit checklist. `has(tracked)` decides whether the recommendation is already met.
function auditCoverage(tracked) {
  if (!tracked) return null;
  const set = new Set(tracked.map((t) => t.event));
  const has = (...names) => names.some((n) => set.has(n));
  const recs = [
    { key: 'difficulty-dim', severity: 'high', met: false,
      title: 'Add a `difficulty` param to run events',
      why: 'complete_run / complete_game / game_over / new_high_score carry no tier. Finish times and death reasons cannot be segmented by Bunny/Blue/Black, so balance regressions per tier are invisible.' },
    { key: 'death-cause-enum', severity: 'high', met: false,
      title: 'Send a stable `cause` enum on game_over (not free-text `reason`)',
      why: 'game_over logs the human string ("You hit a tree!"). High-cardinality free text is hard to aggregate and silently re-buckets whenever the copy changes. Add cause: tree|rock|fall|avalanche_burial|out_of_bounds alongside it.' },
    { key: 'dup-complete', severity: 'high', met: has('complete_run') && has('complete_game'),
      metInverts: true,
      title: 'Deduplicate complete_run vs complete_game',
      why: 'A finished run fires BOTH complete_run (scores.ts) and complete_game (result-overlay.ts). Double-counting inflates conversions and is a prime suspect for a sudden event-count spike. Pick one canonical "run_finished" event.' },
    { key: 'error-tracking', severity: 'high', met: has('physics_anomaly', 'diag_note'),
      title: 'Track uncaught JS errors & asset-load failures as GA4 events',
      why: 'diagnostics.ts has the seam (physics_anomaly / diag_note) but it is disabled under webdriver and only wired for physics. Asset/network/WebGL-context-lost failures (Diag.note("asset_load_failed") has no caller) go unreported, so a broken deploy looks like a quiet traffic dip, not an error.' },
    { key: 'bot-filtering', severity: 'high', met: false,
      title: 'Tag/exclude automated traffic (webdriver, CI, crawlers)',
      why: 'game_start and complete_run are gated only on file:// — not on navigator.webdriver. E2E/puppeteer runs and bots hitting the live site inflate counts and are a common cause of anomaly spikes. Add an env/is_bot param so bot traffic can be filtered in GA4.' },
    { key: 'checkpoint', severity: 'medium', met: has('checkpoint_passed', 'checkpoint'),
      title: 'Emit a checkpoint / progression event',
      why: 'No mid-run signal exists. checkpoint_passed { index, split } would show WHERE players drop off within a run instead of only start vs finish.' },
    { key: 'abandon', severity: 'medium', met: has('run_abandoned', 'quit'),
      title: 'Distinguish abandonment from finish/crash',
      why: 'game_reset fires for every reset; a player who quits mid-run looks identical to one who finished and restarted. A run_abandoned { distance, elapsed } event measures rage-quit / difficulty walls.' },
    { key: 'jump-air', severity: 'low', met: has('jump', 'air_trick'),
      title: 'Track jumps / air time',
      why: 'Jumps are a headline mechanic (landing grade, air score) but emit nothing. A jump { airtime, grade } event would quantify how the feature is actually used.' },
    { key: 'avalanche', severity: 'medium', met: has('avalanche_triggered', 'avalanche'),
      title: 'Track avalanche encounters & survival',
      why: 'The avalanche is the signature hazard yet has no event. avalanche_triggered / avalanche_survived { distance } would show how often it fires and how lethal it is.' },
  ];
  // Normalise the "already met" flag (one rec inverts: duplication is a problem when BOTH exist).
  for (const r of recs) {
    if (r.metInverts) { r.met = !r.met; } // if both events present => NOT met (it's the bug)
  }
  const gaps = recs.filter((r) => !r.met);
  return { tracked, gaps, allRecs: recs };
}

const monthKey = (iso) => (iso ? String(iso).slice(0, 7) : null);
function monthlyCounts(isoDates) {
  const map = new Map();
  for (const d of isoDates) {
    const k = monthKey(d);
    if (k) map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, count]) => ({ month, count }));
}

// Parse a URL's hostname (empty string if unparseable) so provider checks match on the
// real host, not an arbitrary substring of the URL (avoids js/incomplete-url-substring
// sanitization — a spoofable `includes('googleusercontent.com')` check).
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
function hostIs(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}
function emailDomain(email) {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1);
}

// Best-effort sign-in provider from the stored profile (Firestore has no provider field).
function classifyProvider(user) {
  const host = hostOf(user.photoURL || '');
  const email = (user.email || '').toLowerCase();
  const dom = emailDomain(email);
  if (hostIs(host, 'githubusercontent.com') || dom === 'users.noreply.github.com') return 'GitHub';
  if (dom === 'privaterelay.appleid.com') return 'Apple';
  if (hostIs(host, 'googleusercontent.com') || dom === 'gmail.com') return 'Google';
  if (email) return 'Other (email)';
  return 'Unknown';
}

function redactEmail(email) {
  if (!email) return null;
  const [user, domain] = email.split('@');
  const head = user ? user.slice(0, 2) : '';
  return `${head}${'*'.repeat(Math.max(1, (user || '').length - 2))}@${domain || '?'}`;
}
function anonName(id) {
  return 'player_' + createHash('sha256').update(String(id)).digest('hex').slice(0, 8);
}

// Read the plausibility bounds from the game's single source of truth (src/score-limits.ts)
// so the reporter never folds forged/legacy times — the sub-floor scores the app itself
// rejects via isValidScoreTime — into the finish-time distribution or leaderboard. Falls
// back to the firestore.rules range if the file moves.
function readScoreLimits(repoRoot) {
  const fallback = { min: 4, max: 600 };
  try {
    const src = readFileSync(join(repoRoot, 'src', 'score-limits.ts'), 'utf8');
    const min = src.match(/MIN_VALID_SCORE_TIME\s*=\s*([\d.]+)/);
    const max = src.match(/MAX_VALID_SCORE_TIME\s*=\s*([\d.]+)/);
    return { min: min ? Number(min[1]) : fallback.min, max: max ? Number(max[1]) : fallback.max };
  } catch { return fallback; }
}

// The difficulty tiers, each with its Firestore best-time FIELD and leaderboard COLLECTION
// (mirrors difficulty.ts userBestTimeField / leaderboardCollectionName: Blue keeps the
// original un-suffixed names). recordScore stores per-tier bests on bestTimeBunny /
// bestTimeBlack (and per-tier leaderboard_<tier> collections), so counting only `bestTime`
// would miss anyone who finished Bunny/Black but not Blue.
//
// NOTE on the floor: plausibility is NOT judged against the client per-tier floors
// (difficulty.ts minScoreTime — those gate LOCAL practice bests). firestore.rules
// validates EVERY tier field and EVERY leaderboard collection against the single global
// isValidScoreTime (>= MIN_VALID_SCORE_TIME, <= MAX), so any value in Firestore below that
// global floor is forged/legacy regardless of tier. The reporter therefore uses the SERVER
// floor for all tiers — see buildInsights.
function readTiers() {
  return [
    { id: 'bunny', field: 'bestTimeBunny', collection: 'leaderboard_bunny' },
    { id: 'blue',  field: 'bestTime',      collection: 'leaderboard' },
    { id: 'black', field: 'bestTimeBlack', collection: 'leaderboard_black' },
  ];
}

// --------------------------------------------------------------------- build insights ----
// `boardEntries` is the merged per-tier leaderboard (each row tagged with `.tier`); `tiers`
// carries each tier's best-time field; `limits` is the SERVER validation range
// (firestore.rules isValidScoreTime), applied uniformly to every tier — see readTiers.
function buildInsights(users, boardEntries, nowMs, tiers, limits) {
  const usersById = new Map(users.map((u) => [u.id, u]));
  const isPlausible = (t) => num(t) && t >= limits.min && t <= limits.max;

  // Every tier best a user has recorded (bestTime / bestTimeBunny / bestTimeBlack). A
  // player who finished only Bunny/Black still counts, but each time is judged against the
  // SERVER floor the write had to clear, so a forged sub-floor value is excluded whatever
  // its tier field.
  const userBests = (u) => tiers
    .map((t) => ({ tier: t.id, time: u[t.field] }))
    .filter((b) => num(b.time));
  const completed = users.filter((u) => userBests(u).some((b) => isPlausible(b.time)));
  const bestTimes = users.flatMap((u) => userBests(u).filter((b) => isPlausible(b.time)).map((b) => b.time));
  const implausibleUserTimes = users.flatMap(userBests).filter((b) => !isPlausible(b.time)).length;
  // The single fastest PLAUSIBLE time each user has across tiers (for the players table).
  const bestOf = (u) => {
    const plausible = userBests(u).filter((b) => isPlausible(b.time)).map((b) => b.time);
    return plausible.length ? Math.min(...plausible) : null;
  };

  // Recency buckets from lastLogin.
  const buckets = { 'Last 24h': 0, 'Last 7 days': 0, 'Last 30 days': 0, 'Last 90 days': 0, 'Older': 0, 'Unknown': 0 };
  const DAY = 86400e3;
  for (const u of users) {
    if (!u.lastLogin) { buckets['Unknown']++; continue; }
    const age = nowMs - Date.parse(u.lastLogin);
    if (age < DAY) buckets['Last 24h']++;
    else if (age < 7 * DAY) buckets['Last 7 days']++;
    else if (age < 30 * DAY) buckets['Last 30 days']++;
    else if (age < 90 * DAY) buckets['Last 90 days']++;
    else buckets['Older']++;
  }

  // Provider mix.
  const provider = {};
  for (const u of users) { const p = classifyProvider(u); provider[p] = (provider[p] || 0) + 1; }

  // Merged per-tier leaderboard, each row judged against its own tier floor, fastest first.
  const board = boardEntries.map((e) => {
    const uid = (e.user || '').split('/').pop();
    const u = usersById.get(uid);
    return {
      uid, time: e.time, achievedAt: e.achievedAt, tier: e.tier,
      name: OPTS.redact ? anonName(uid) : (u?.displayName || '(unknown)'),
    };
  }).filter((e) => isPlausible(e.time)).sort((a, b) => a.time - b.time);
  const implausibleBoardEntries = boardEntries
    .filter((e) => num(e.time) && !isPlausible(e.time)).length;

  // Health / consistency checks.
  const boardUids = new Set(board.map((b) => b.uid));
  const completedNotOnBoard = completed.filter((u) => !boardUids.has(u.id)).length;
  let staleBoard = 0;
  for (const e of boardEntries) {
    const u = usersById.get((e.user || '').split('/').pop());
    const uBest = u && tiers.find((t) => t.id === e.tier) ? u[tiers.find((t) => t.id === e.tier).field] : undefined;
    if (num(uBest) && num(e.time) && Math.abs(uBest - e.time) > 0.5) staleBoard++;
  }
  const orphanBoard = boardEntries.filter((e) => !usersById.has((e.user || '').split('/').pop())).length;
  const tiersWithData = tiers.filter((t) => boardEntries.some((e) => e.tier === t.id)).map((t) => t.id);

  return {
    kpis: {
      totalUsers: users.length,
      completedRun: completed.length,
      completionRate: users.length ? completed.length / users.length : 0,
      leaderboardEntries: boardEntries.length,
      fastestTime: board[0]?.time ?? null,
      medianBestTime: stats(bestTimes)?.median ?? null,
      activeLast30d: buckets['Last 24h'] + buckets['Last 7 days'] + buckets['Last 30 days'],
    },
    funnel: [
      { stage: 'Registered', count: users.length },
      { stage: 'Completed a run', count: completed.length },
      { stage: 'On global leaderboard', count: boardUids.size },
    ],
    bestTime: { stats: stats(bestTimes), histogram: histogram(bestTimes, 10) },
    provider: Object.entries(provider).map(([k, v]) => ({ label: k, count: v }))
      .sort((a, b) => b.count - a.count),
    recency: Object.entries(buckets).map(([label, count]) => ({ label, count })),
    activityByMonth: monthlyCounts(users.map((u) => u.lastLogin)),
    runsByMonth: monthlyCounts(boardEntries.map((e) => e.achievedAt)),
    leaderboard: board.slice(0, 20).map((b) => ({
      name: b.name, time: b.time, achievedAt: b.achievedAt, tier: b.tier,
    })),
    tiers: tiersWithData,
    plausibility: {
      min: limits.min, max: limits.max,
      excludedUserTimes: implausibleUserTimes, excludedBoardEntries: implausibleBoardEntries,
    },
    health: {
      completedNotOnBoard, staleBoard, orphanBoard,
      implausibleTimes: implausibleUserTimes + implausibleBoardEntries,
      usersMissingProfile: users.filter((u) => !u.displayName && !u.email).length,
    },
    players: OPTS.redact ? users.map((u) => ({
      id: anonName(u.id), provider: classifyProvider(u),
      bestTime: bestOf(u), lastLogin: u.lastLogin || null,
    })) : users.map((u) => ({
      id: u.id, name: u.displayName || null, email: redactEmail(u.email),
      provider: classifyProvider(u), bestTime: bestOf(u),
      lastLogin: u.lastLogin || null,
    })),
  };
}

// ---------------------------------------------------------------- HTML rendering (SVG) ----
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => (num(t) ? t.toFixed(2) + 's' : '—');
const fmtPct = (x) => (num(x) ? (x * 100).toFixed(1) + '%' : '—');
const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '—');

// Horizontal bar chart from [{label,count}].
function hbars(rows, { color = '#3aa0ff', unit = '' } = {}) {
  if (!rows.length) return '<p class="empty">No data.</p>';
  const max = Math.max(1, ...rows.map((r) => r.count));
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar-row">
      <span class="hbar-label">${esc(r.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(r.count / max * 100).toFixed(1)}%;background:${color}"></span></span>
      <span class="hbar-val">${esc(r.count)}${unit}</span>
    </div>`).join('')}</div>`;
}

// Vertical bar / histogram as inline SVG from [{label,count}].
function vbars(rows, { color = '#3aa0ff', height = 160 } = {}) {
  if (!rows.length) return '<p class="empty">No data.</p>';
  const w = 640, padB = 34, padL = 4, padT = 12;
  const max = Math.max(1, ...rows.map((r) => r.count));
  const bw = (w - padL * 2) / rows.length;
  const bars = rows.map((r, i) => {
    const h = (r.count / max) * (height - padB - padT);
    const x = padL + i * bw, y = height - padB - h;
    return `<rect x="${(x + bw * 0.12).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.76).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}"/>
      <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" class="svg-val">${r.count || ''}</text>
      <text x="${(x + bw / 2).toFixed(1)}" y="${height - padB + 14}" class="svg-lbl">${esc(r.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${height}" class="chart" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}

function kpiCards(k) {
  const cards = [
    ['Registered players', k.totalUsers],
    ['Completed ≥1 run', `${k.completedRun} <small>(${fmtPct(k.completionRate)})</small>`],
    ['Active (30d)', k.activeLast30d],
    ['Leaderboard entries', k.leaderboardEntries],
    ['Fastest run', fmtTime(k.fastestTime)],
    ['Median best time', fmtTime(k.medianBestTime)],
  ];
  return `<div class="kpis">${cards.map(([label, val]) => `
    <div class="kpi"><div class="kpi-val">${val}</div><div class="kpi-label">${esc(label)}</div></div>`).join('')}</div>`;
}

function funnelHtml(funnel) {
  const top = funnel[0]?.count || 1;
  return `<div class="funnel">${funnel.map((s) => `
    <div class="funnel-row">
      <span class="funnel-label">${esc(s.stage)}</span>
      <span class="funnel-track"><span class="funnel-fill" style="width:${(s.count / top * 100).toFixed(1)}%"></span></span>
      <span class="funnel-val">${s.count} <small>${fmtPct(top ? s.count / top : 0)}</small></span>
    </div>`).join('')}</div>`;
}

function histogramHtml(hist) {
  if (!hist.length) return '<p class="empty">No completed runs yet.</p>';
  const rows = hist.map((b) => ({ label: `${b.from.toFixed(0)}–${b.to.toFixed(0)}`, count: b.count }));
  return vbars(rows, { color: '#5ad1a0' });
}

function leaderboardTable(rows, tiers = []) {
  if (!rows.length) return '<p class="empty">No leaderboard entries yet.</p>';
  const showTier = tiers.length > 1; // only surface the tier column once boards span >1 tier
  return `<table class="tbl"><thead><tr><th>#</th><th>Player</th>${showTier ? '<th>Tier</th>' : ''}<th>Time</th><th>Achieved</th></tr></thead><tbody>${
    rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td>${showTier ? `<td>${esc(r.tier || '—')}</td>` : ''}<td class="mono">${fmtTime(r.time)}</td><td>${fmtDate(r.achievedAt)}</td></tr>`).join('')
  }</tbody></table>`;
}

function ga4Html(ga) {
  if (!ga.available) {
    return `<div class="notice">
      <p><strong>GA4 metrics unavailable.</strong> ${esc(ga.reason)}</p>
      <p>Firestore already gives first-party player + score data above. To also pull GA4 engagement/events:</p>
      <ol>${ga.howTo.map((s) => `<li><code>${esc(s)}</code></li>`).join('')}</ol>
    </div>`;
  }
  const t = ga.totals;
  const kpis = [
    ['Active users', t.activeUsers], ['New users', t.newUsers], ['Sessions', t.sessions],
    ['Engagement rate', fmtPct(t.engagementRate)],
    ['Avg session', `${Math.round(t.averageSessionDuration)}s`], ['Events', t.eventCount],
  ];
  const evRows = ga.byEvent.map((e) => ({ label: e.event, count: e.count }));
  const geoRows = ga.country.map((c) => ({ label: c.country, count: c.activeUsers }));
  return `
    <p class="muted">GA4 property ${esc(ga.propertyId)} · window ${esc(ga.window)}</p>
    <div class="kpis">${kpis.map(([l, v]) => `<div class="kpi"><div class="kpi-val">${v}</div><div class="kpi-label">${esc(l)}</div></div>`).join('')}</div>
    <div class="grid2">
      <div><h3>Events (28d)</h3>${hbars(evRows, { color: '#c792ea' })}</div>
      <div><h3>Top countries</h3>${geoRows.length ? hbars(geoRows, { color: '#f6a04d' }) : '<p class="empty">No geo data.</p>'}</div>
    </div>`;
}

function anomaliesHtml(ga) {
  if (!ga.available) return '';
  const a = ga.anomalies;
  if (!a || !a.available) {
    return `<p class="empty">Daily per-event breakdown unavailable${a?.reason ? ' (' + esc(a.reason) + ')' : ''}.</p>`;
  }
  if (!a.spikes.length) {
    return `<p class="empty">No statistically significant spikes over ${esc(a.window)} (robust-z ≥ 3.5 and ≥ 3× the 4-week median).</p>`;
  }
  return `<p class="hint">Days where an event ran far above its own recent baseline — start here to explain an alert.</p>
    <table class="tbl"><thead><tr><th>Date</th><th>Event</th><th>Count</th><th>Baseline</th><th>× median</th><th>robust-z</th></tr></thead><tbody>${
    a.spikes.slice(0, 20).map((s) => `<tr>
      <td class="mono">${esc(s.date.slice(0, 4))}-${esc(s.date.slice(4, 6))}-${esc(s.date.slice(6, 8))}</td>
      <td>${esc(s.event)}</td><td class="mono">${s.count}</td>
      <td class="mono">${s.baselineMedian}</td>
      <td class="mono">${s.multiple ?? '∞'}×</td><td class="mono">${s.robustZ}</td></tr>`).join('')
    }</tbody></table>`;
}

function coverageHtml(cov) {
  if (!cov) return '<p class="empty">Source not available for a coverage audit.</p>';
  const sev = { high: '#f0616d', medium: '#f6a04d', low: '#7fc9ff' };
  const tracked = `<h3>Currently tracked (${cov.tracked.length})</h3>
    <div class="chips">${cov.tracked.map((t) => `<span class="chip" title="${esc(t.files.join(', '))}">${esc(t.event)}</span>`).join('')}</div>`;
  const gaps = cov.gaps.length ? `<h3 style="margin-top:18px">Recommended but missing (${cov.gaps.length})</h3>
    <div class="gaps">${cov.gaps.map((g) => `
      <div class="gap">
        <div class="gap-head"><span class="sev" style="background:${sev[g.severity]}">${g.severity}</span><b>${esc(g.title)}</b></div>
        <p>${esc(g.why)}</p>
      </div>`).join('')}</div>`
    : '<p class="empty" style="margin-top:14px">✓ All checklist items are covered.</p>';
  return tracked + gaps;
}

function renderHtml(data) {
  const { insights: I, ga4, coverage, meta } = data;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SnowGlider Analytics — ${esc(meta.project)}</title>
<style>
  :root{--bg:#0d1524;--panel:#152238;--ink:#e8f0fb;--muted:#8ba0be;--line:#243450;--accent:#3aa0ff}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(180deg,#0b1220,#0d1524);color:var(--ink)}
  header{padding:28px 24px 8px;max-width:1040px;margin:0 auto}
  h1{margin:0 0 2px;font-size:26px;letter-spacing:.3px}
  h1 .snow{color:#7fc9ff}
  .sub{color:var(--muted);font-size:13px}
  main{max-width:1040px;margin:0 auto;padding:8px 24px 60px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:18px 0;box-shadow:0 1px 0 rgba(255,255,255,.02)}
  section>h2{margin:0 0 4px;font-size:16px}
  section>.hint{color:var(--muted);font-size:12.5px;margin:0 0 16px}
  h3{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin:0 0 10px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .kpi{background:#101c30;border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .kpi-val{font-size:24px;font-weight:650}.kpi-val small{font-size:13px;color:var(--muted);font-weight:400}
  .kpi-label{color:var(--muted);font-size:12px;margin-top:2px}
  .hbars{display:flex;flex-direction:column;gap:8px}
  .hbar-row{display:grid;grid-template-columns:140px 1fr 54px;align-items:center;gap:10px}
  .hbar-label{color:var(--muted);font-size:13px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hbar-track{background:#0e1a2c;border-radius:6px;height:16px;overflow:hidden}
  .hbar-fill{display:block;height:100%;border-radius:6px}
  .hbar-val{font-variant-numeric:tabular-nums;font-size:13px}
  .funnel{display:flex;flex-direction:column;gap:10px}
  .funnel-row{display:grid;grid-template-columns:170px 1fr 90px;align-items:center;gap:10px}
  .funnel-label{color:var(--muted);font-size:13px;text-align:right}
  .funnel-track{background:#0e1a2c;border-radius:6px;height:22px;overflow:hidden}
  .funnel-fill{display:block;height:100%;background:linear-gradient(90deg,#3aa0ff,#5ad1a0);border-radius:6px}
  .funnel-val{font-size:13px}.funnel-val small{color:var(--muted)}
  .chart{width:100%;height:auto}
  .svg-val{fill:var(--muted);font-size:10px;text-anchor:middle}
  .svg-lbl{fill:var(--muted);font-size:9.5px;text-anchor:middle}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:22px}
  @media(max-width:720px){.grid2{grid-template-columns:1fr}.hbar-row,.funnel-row{grid-template-columns:110px 1fr 48px}}
  table.tbl{width:100%;border-collapse:collapse;font-size:14px}
  .tbl th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.5px;padding:6px 8px;border-bottom:1px solid var(--line)}
  .tbl td{padding:7px 8px;border-bottom:1px solid #1b283f}
  .mono,.tbl .mono{font-variant-numeric:tabular-nums}
  .stats-line{display:flex;flex-wrap:wrap;gap:18px;color:var(--muted);font-size:13px;margin-bottom:14px}
  .stats-line b{color:var(--ink)}
  .empty,.muted{color:var(--muted);font-size:13px}
  .notice{background:#101c30;border:1px dashed var(--line);border-radius:10px;padding:14px 16px}
  .notice code{color:#9fd0ff;font-size:12px}
  .notice ol{margin:8px 0 0;padding-left:20px}.notice li{margin:3px 0}
  .health-flags{display:flex;flex-wrap:wrap;gap:10px}
  .flag{background:#101c30;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:13px}
  .flag.warn{border-color:#6b4a1e;background:#241a0e}.flag b{font-size:16px;display:block}
  .chips{display:flex;flex-wrap:wrap;gap:7px}
  .chip{background:#0e2033;border:1px solid #1e5a86;color:#9fd0ff;border-radius:20px;padding:4px 11px;font-size:12.5px;font-variant-numeric:tabular-nums}
  .gaps{display:flex;flex-direction:column;gap:12px}
  .gap{background:#101c30;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .gap-head{display:flex;align-items:center;gap:9px;margin-bottom:5px}
  .gap p{margin:0;color:var(--muted);font-size:13px}
  .sev{color:#0b1220;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:2px 7px;border-radius:5px}
  footer{max-width:1040px;margin:0 auto;padding:0 24px 40px;color:var(--muted);font-size:12px}
</style></head>
<body>
<header>
  <h1>❄ Snow<span class="snow">Glider</span> Analytics</h1>
  <div class="sub">Firebase project <b>${esc(meta.project)}</b> · generated ${esc(meta.generatedAt)}${OPTS.redact ? ' · <b>redacted</b>' : ''}</div>
</header>
<main>

  <section>
    <h2>Overview</h2>
    <p class="hint">First-party metrics from the live Firestore <code>users</code> and <code>leaderboard</code> collections.</p>
    ${kpiCards(I.kpis)}
  </section>

  <section>
    <h2>Player funnel</h2>
    <p class="hint">Every signed-in player → those who finished a run → those good enough to post a global time.</p>
    ${funnelHtml(I.funnel)}
  </section>

  <section>
    <h2>Finish-time distribution</h2>
    <p class="hint">Best finish times across all tiers — the core game-balance signal. Times are kept only if they clear the server validation range (${I.plausibility.min}–${I.plausibility.max}s, enforced by firestore.rules on every tier)${(I.plausibility.excludedUserTimes + I.plausibility.excludedBoardEntries) ? `; <b>${I.plausibility.excludedUserTimes + I.plausibility.excludedBoardEntries}</b> implausible/forged time(s) excluded` : ''}.</p>
    ${I.bestTime.stats ? `<div class="stats-line">
      <span>fastest <b>${fmtTime(I.bestTime.stats.min)}</b></span>
      <span>p25 <b>${fmtTime(I.bestTime.stats.p25)}</b></span>
      <span>median <b>${fmtTime(I.bestTime.stats.median)}</b></span>
      <span>p75 <b>${fmtTime(I.bestTime.stats.p75)}</b></span>
      <span>slowest <b>${fmtTime(I.bestTime.stats.max)}</b></span>
      <span>mean <b>${fmtTime(I.bestTime.stats.mean)}</b></span>
    </div>` : ''}
    ${histogramHtml(I.bestTime.histogram)}
  </section>

  <section class="grid2">
    <div>
      <h2>Sign-in providers</h2>
      <p class="hint">Inferred from profile photo host / email domain.</p>
      ${hbars(I.provider, { color: '#7fc9ff' })}
    </div>
    <div>
      <h2>Player recency</h2>
      <p class="hint">Time since each player's last login.</p>
      ${hbars(I.recency, { color: '#f6a04d' })}
    </div>
  </section>

  <section class="grid2">
    <div>
      <h2>Most-recent login by month</h2>
      <p class="hint">Firestore keeps only each player's <em>latest</em> login, so this is last-seen distribution, not visit volume — a returning player moves rather than adds a bar. For true activity over time use the GA4 daily chart above.</p>
      ${vbars(I.activityByMonth.map((r) => ({ label: r.month.slice(2), count: r.count })), { color: '#3aa0ff' })}
    </div>
    <div>
      <h2>Personal best set by month</h2>
      <p class="hint"><code>achievedAt</code> is overwritten when a player beats their time, so this shows when current PBs were set — not every run.</p>
      ${vbars(I.runsByMonth.map((r) => ({ label: r.month.slice(2), count: r.count })), { color: '#5ad1a0' })}
    </div>
  </section>

  <section>
    <h2>Global leaderboard</h2>
    <p class="hint">Fastest completed runs synced to Firestore.</p>
    ${leaderboardTable(I.leaderboard, I.tiers)}
  </section>

  <section>
    <h2>Google Analytics (GA4)</h2>
    <p class="hint">Session &amp; event engagement from GA4 (event stream logged by the game: game_start, complete_run, new_high_score, login).</p>
    ${ga4Html(ga4)}
  </section>

  ${ga4.available ? `<section>
    <h2>Event anomalies &amp; spikes</h2>
    <p class="hint">Robust per-event spike detection over 90 days — this is where an "anomaly alert" like yesterday's shows up, with the exact event and magnitude.</p>
    ${anomaliesHtml(ga4)}
  </section>` : ''}

  <section>
    <h2>Tracking coverage &amp; gaps</h2>
    <p class="hint">Events the game logs today (scanned from <code>src/</code>) vs. what a game of this shape should track. Amber/red items are the recommended additions.</p>
    ${coverageHtml(coverage)}
  </section>

  <section>
    <h2>Data health</h2>
    <p class="hint">Consistency checks between the two collections — non-zero values are worth a look.</p>
    <div class="health-flags">
      <div class="flag${I.health.completedNotOnBoard ? ' warn' : ''}"><b>${I.health.completedNotOnBoard}</b>finished a run but not on leaderboard</div>
      <div class="flag${I.health.staleBoard ? ' warn' : ''}"><b>${I.health.staleBoard}</b>leaderboard time ≠ profile best time</div>
      <div class="flag${I.health.orphanBoard ? ' warn' : ''}"><b>${I.health.orphanBoard}</b>leaderboard rows with no user doc</div>
      <div class="flag${I.health.implausibleTimes ? ' warn' : ''}"><b>${I.health.implausibleTimes}</b>implausible/forged times (excluded from stats)</div>
      <div class="flag${I.health.usersMissingProfile ? ' warn' : ''}"><b>${I.health.usersMissingProfile}</b>users missing name &amp; email</div>
    </div>
  </section>

</main>
<footer>
  Generated by <code>scripts/analytics-report.mjs</code> · source: Firestore (${meta.userCount} users, ${meta.leaderboardCount} leaderboard rows)${ga4.available ? ' + GA4' : ''}.
  Contains player data — do not commit. Re-run any time to refresh.
</footer>
</body></html>`;
}

// -------------------------------------------------------------------------------- main ----
(async function main() {
  const saPath = findServiceAccount();
  const sa = loadServiceAccount(saPath);
  log(`service account: ${sa.client_email}`);
  log(`project: ${sa.project_id}`);

  log('minting Firestore token…');
  const fsToken = await getAccessToken(sa, 'https://www.googleapis.com/auth/datastore');
  const scoreLimits = readScoreLimits(REPO_ROOT);
  const tiers = readTiers();
  log('reading Firestore collections…');
  // Read the users doc + EVERY tier's leaderboard collection (Blue = 'leaderboard',
  // Bunny/Black = 'leaderboard_<tier>'). A tier with no board yet just returns []. Tag each
  // row with its tier so per-tier floors apply downstream.
  const [users, ...boards] = await Promise.all([
    fetchCollection(fsToken, sa.project_id, 'users'),
    ...tiers.map((t) => fetchCollection(fsToken, sa.project_id, t.collection)),
  ]);
  const boardEntries = boards.flatMap((rows, i) => rows.map((e) => ({ ...e, tier: tiers[i].id })));
  log(`  users: ${users.length}   leaderboard rows: ${boardEntries.length}` +
    (boardEntries.length ? ` (${tiers.map((t, i) => `${t.id}:${boards[i].length}`).filter((_, i) => boards[i].length).join(', ')})` : ''));

  log('checking GA4…');
  const ga4 = await fetchGa4(sa);
  log(ga4.available ? '  GA4: connected' : `  GA4: skipped (${ga4.reason})`);

  log('auditing tracking coverage from source…');
  const coverage = auditCoverage(scanTrackedEvents(REPO_ROOT));
  if (coverage) log(`  tracked events: ${coverage.tracked.length}   gaps: ${coverage.gaps.length}`);
  else log('  (no src/ found — coverage audit skipped)');

  const nowMs = Date.now();
  const insights = buildInsights(users, boardEntries, nowMs, tiers, scoreLimits);
  const data = {
    meta: {
      project: sa.project_id,
      generatedAt: new Date(nowMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      generatedAtMs: nowMs,
      redacted: OPTS.redact,
      userCount: users.length,
      leaderboardCount: boardEntries.length,
      source: 'firestore' + (ga4.available ? '+ga4' : ''),
    },
    insights,
    ga4,
    coverage,
  };

  mkdirSync(OPTS.out, { recursive: true });
  const jsonPath = join(OPTS.out, 'report.json');
  writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  log(`wrote ${jsonPath}`);

  if (!OPTS.jsonOnly) {
    const htmlPath = join(OPTS.out, 'report.html');
    writeFileSync(htmlPath, renderHtml(data));
    log(`wrote ${htmlPath}`);
    if (OPTS.open) {
      const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open';
      try { execFileSync(opener, [htmlPath], { stdio: 'ignore' }); } catch { /* non-fatal */ }
    }
  }
  console.log('\n  ✓ done\n');
})().catch((e) => die(e.stack || e.message));
