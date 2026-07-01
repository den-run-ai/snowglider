# SnowGlider Analytics

A reusable, zero-dependency reporter that pulls product analytics straight from the live
Firebase project and renders a self-contained HTML dashboard + a JSON snapshot.

- Script: [`scripts/analytics-report.mjs`](../scripts/analytics-report.mjs)
- Run: `npm run analytics` → writes `analytics-out/report.html` and `analytics-out/report.json`
- Open the HTML: `npm run analytics -- --open`

## Quick start

```bash
# The Firebase Admin SDK key lives in the SnowGlider checkout root (git-ignored).
# The script auto-discovers *-firebase-adminsdk-*.json there; no flag needed.
npm run analytics
open analytics-out/report.html          # macOS (or --open)
```

Flags / env:

| Flag / env | Effect |
|---|---|
| `--sa <path>` / `SNOWGLIDER_SA` / `GOOGLE_APPLICATION_CREDENTIALS` | explicit service-account key |
| `--redact` | hash player emails/names so the report can be shared |
| `--out <dir>` | output directory (default `analytics-out/`) |
| `--json-only` | skip the HTML |
| `--open` | open the HTML when done |
| `GA4_PROPERTY_ID=<id>` / `--ga-property <id>` | also pull GA4 engagement, events, and spike detection |

## Data sources

1. **Cloud Firestore** (always on) — the `users` and `leaderboard` collections are the
   first-party record of who plays and how fast they finish. Read over the Firestore REST
   API using an Admin SDK service-account key (JWT → OAuth token, no `firebase-admin` dep).
2. **Google Analytics 4** (opt-in) — session/event engagement + anomaly detection via the
   Analytics Data API. **Currently offline** because the Data API is disabled on the GCP
   project and the service account isn't a member of the GA4 property. The report degrades
   gracefully and prints the exact enable steps. See below.

### What the Firestore section shows

Overview KPIs, a player funnel (registered → completed a run → on the leaderboard),
the **finish-time distribution** (the core balance signal), sign-in provider mix, player
recency, activity/leaderboard timelines, the global leaderboard, and cross-collection
**data-health** checks (e.g. leaderboard rows whose time disagrees with the profile best).

## Enabling GA4 (engagement, events, anomaly spikes)

The game already logs a rich GA4 event stream, but the Data API must be turned on and the
service account granted read access before this tool can query it:

1. Enable the Analytics Data API on the project:
   `https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=sn0wglider`
2. In GA4 → Admin → **Property Access Management**, add the service-account email
   (`firebase-adminsdk-fbsvc@sn0wglider.iam.gserviceaccount.com`) as a **Viewer**.
3. Copy the numeric **property id** (Admin → Property Settings) and run:
   ```bash
   GA4_PROPERTY_ID=<id> npm run analytics
   ```

Once connected, the report adds an **Event anomalies & spikes** section: robust per-event
spike detection over 90 days (median + MAD, robust-z ≥ 3.5 and ≥ 3× baseline) that names
the exact event and day behind an anomaly alert — the reproducible view for questions like
"what caused yesterday's spike?".

## Tracking coverage & gaps

The report scans `src/` for the analytics events the game actually logs and compares them
to a checklist. **Tracked today** (14): `game_start`, `complete_run`, `complete_game`,
`new_high_score`, `game_over`, `game_reset`, `login`, `share_result`, `feedback_submitted`,
plus the diagnostics error/health seam (`client_error`, `unhandled_rejection`,
`physics_anomaly`, `session_health`, `diag_note`).

Recommended additions the audit flags (high → low):

| Sev | Gap | Why it matters |
|---|---|---|
| high | `difficulty` param on run events | finish times & deaths can't be segmented by Bunny/Blue/Black tier |
| high | stable `cause` enum on `game_over` | it currently logs free-text `reason` — high-cardinality, breaks when copy changes |
| high | de-dup `complete_run` vs `complete_game` | both fire on one finish → double-counts, a prime suspect for event spikes |
| high | tag/exclude bot traffic | gameplay events aren't gated on `navigator.webdriver`; E2E/crawlers inflate counts (a likely spike cause) |
| medium | `checkpoint_passed` progression event | no mid-run signal → can't see where players drop off |
| medium | `run_abandoned` vs finish/crash | a mid-run quit looks identical to a finish+restart |
| medium | `avalanche_triggered` / `_survived` | the signature hazard emits nothing |
| low | `jump` / air-time event | a headline mechanic is unmeasured |

## Security & privacy

- The service-account key is a live secret. It is **git-ignored**
  (`*-firebase-adminsdk-*.json`) and must stay in the SnowGlider checkout, never in a
  worktree or a commit. Rotate immediately if it is ever pushed.
- `analytics-out/` is git-ignored — generated reports embed player emails/names. Use
  `--redact` before sharing.
