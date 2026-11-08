# SnowGlider telemetry

The browser sends gameplay events and bounded diagnostic summaries to Firebase Analytics.
The private reporter reads Firestore score/profile data and, when configured, GA4 reports.
These answer different questions: Firestore records signed-in players and their current
personal bests; GA4 measures visits, events and diagnostics, including signed-out players.
Neither is a complete census when collection is blocked or unavailable.

## Private reports

```bash
npm run analytics -- --sa /private/path/service-account.json --ga-property <numeric-id> --hostname snowglider.ai
# After registering the is_bot custom dimension:
npm run analytics -- --sa /private/path/service-account.json --ga-property <numeric-id> --hostname snowglider.ai --traffic human
```

The output is `analytics-out/report.html` and `report.json`. On POSIX systems, report files
are owner-only (`0600`), including overwritten exports; newly created output directories
use `0700`. Existing directory permissions are unchanged. Keep the service-account key
outside the repository; `--sa`, `SNOWGLIDER_SA` or `GOOGLE_APPLICATION_CREDENTIALS` selects
it. Legacy auto-discovery of ignored key files in the checkout remains supported.

| Option | Effect |
|---|---|
| `--ga-property <id>` / `GA4_PROPERTY_ID` | Query a GA4 numeric property ID, not a `G-…` measurement ID |
| `--hostname <hostname>` | Restrict GA4 to one exact host; omitted means all hosts. Use `snowglider.ai` for production reports |
| `--traffic all` (default) | All traffic; explicitly includes automation and untagged events |
| `--traffic human` | Only events explicitly tagged `is_bot=false` |
| `--traffic bot` | Only events explicitly tagged `is_bot=true` |
| `--redact` | Replace player names/IDs with stable pseudonyms; still a private report |
| `--out <dir>` | Change output directory; only the default `analytics-out/` is automatically ignored |
| `--json-only` / `--open` | Skip HTML / open HTML locally |

GA4 requires the **Analytics Data API** enabled on the service account's project and the
service-account email added as a **Viewer** in GA4 → Admin → Property Access Management.
Firebase administrator access alone does not grant GA4 report access. Missing credentials,
disabled APIs or denied permissions are access failures, not evidence of zero traffic.
The reporter explains GA4 failures while preserving the Firestore report. Every HTTP
request has a 30-second deadline.

### Interpreting the results

- Gameplay scores use the current `PHYSICS_VERSION` and the complete difficulty registry,
  including Expert. Old seasons are excluded. The server's shared score limits determine
  plausibility. Unranked-only finishes do not imply a missing global leaderboard entry.
- Firestore timelines show latest login/current personal-best dates, **not** visit/run
  counts. The finish distribution includes a player's best in each completed tier; it is
  not a distribution of every attempt. Guests are intentionally absent from Firestore.
- GA4 totals cover **28 complete days ending yesterday**. Spike detection uses 90 complete
  days in the **GA4 property's timezone**, preserves zero-event days, and paginates the
  event history. It fails visibly when the timezone or full history cannot be verified.
  Yesterday can still change as delayed events arrive; an alert is a lead to investigate.
- Anomalies compare each day to the preceding 28-day median/MAD and require at least seven
  days of history, 15 events, 3× baseline and robust-z ≥ 3.5. They do not establish causation
  or distinguish a release, a new event, automation, renewed traffic or a regression.
- Hostname filtering uses GA4's built-in `hostName` dimension and requires no custom
  definition. Use `--hostname snowglider.ai` for production reports; it does not include
  subdomains automatically. It applies together with any traffic filter. This only changes
  the GA4 report; Firestore is still the selected project's current score/profile snapshot.
- Traffic filters require an event-scoped custom dimension named `is_bot`. They include
  **only explicit tags**: old data and SDK-generated events such as page views may be
  untagged and disappear from either filtered view. Filtered session/user metrics must
  not be treated as a complete human audience. GA4 custom dimensions are not retroactive.
- The report surfaces thresholding, sampling, `(other)` aggregation and data-truncation
  warnings from every response, including empty reports and later pages. Historical
  retention or other truncation can omit events: zero rows do not prove there were none.
  Event-name source scanning is a coverage hint, not proof of delivered events or correct
  parameters; parameters, asset failures and production delivery remain explicit manual checks.

Analytics initializes only on `snowglider.ai` and `www.snowglider.ai`. Local, LAN,
preview and fork hosts skip the Analytics SDK, including its automatic page-view/session
collection. This gate does not change authentication or Firestore availability.

## Gameplay and performance dimensions

Use `complete_run` as the canonical finish event; `new_high_score` is a separate personal-best
signal, not another finish. Run events include `difficulty`, `physics_version`, `practice`
and `timing_compromised` context. Register dimensions needed for exploration rather than
creating a new event for each tier or release.

### Playable-run funnel (version 2)

Filter new funnel analysis to `funnel_version = 2`; older start/reset counts used different
boundaries and cannot be repaired retrospectively.

| Event | Boundary |
|---|---|
| `game_start` | First active, visible gameplay frame, after assets and any intro. Includes in-game Reset and same-level Restart; loading intent and visibility resumes do not add a start. |
| `game_reset` | A previously playable attempt is replaced. Initial setup and repeated preparation do not count. Its context describes the replaced attempt. |
| `complete_run` | Reaching the finish, once per attempt, whether or not score storage/auth works. `score_eligible` separates valid ranked results from practice, compromised timing and invalid score times. |
| `game_over` | A crash, once per attempt. Fatal animation-loop failures use the fixed `runtime_error` reason; raw exceptions remain in the sanitized diagnostics channel. |

`run_attempt` is bounded to `first`, `second` or `later`. A counter capped at three lives
in `sessionStorage` so a difficulty change/reload in the same tab preserves replay context.
It contains no account identifier, run seed, nonce or timestamp. If storage is blocked,
the count falls back to this page's memory. This is a **tab-run category**, not a first-ever
player or a GA4-session identifier; browser session restoration can retain the counter. Register
`run_attempt`, `funnel_version` and `score_eligible` as event-scoped dimensions for GA4
explorations. Use GA4's audience/cohort tools separately for next-day returns.

The result boundary owns completion telemetry; score saving and later sign-in/retry do not
emit another `complete_run`. When Analytics initializes late, up to 16 whole attempts are
held in memory and flushed in order on active frames or auth readiness, including after a
finish. No event payload is persisted. Overflow and throwing sinks discard whole attempts
so a dropped start does not leave an orphan completion. Counts remain best-effort when
Analytics is blocked, absent or the page closes before delivery. Missing events are not
proof that a player never started or finished.
Closing/backgrounding a tab is not automatically a crash or abandonment event.

`session_health` contains bounded frame/performance summaries; `physics_anomaly` and
`diag_note` cover specific failures. Browser errors use `client_error` and
`unhandled_rejection`. Error telemetry must remain sanitized, rate-limited and best-effort:
never upload profile identity, raw feedback, arbitrary exception text or full URL queries.
Remote error fields are `error_type`, `error_code`, `error_source`, a validated public
`script` path, `line`/`column`, and bounded frame/health context. `app_build` identifies
the deployed build; `is_bot` uses explicit `true`/`false` strings. Raw messages/stacks
remain in the local diagnostic export. GA4 is an aggregate diagnostic channel, not a
full stack-trace or distributed tracing store. The diagnostic `error_source` field is
separate from GA campaign attribution; do not use the campaign `source` parameter for errors.
For local reproduction, use `?debug` and the private diagnostic export documented in
[DIAGNOSTICS.md](DIAGNOSTICS.md).

When validating a release, verify a human browser session's start → finish/reset events,
error categories and frame summaries in DebugView/Realtime, then check the processed
reports after ingestion. Keep automation separate and do not fabricate failures on a
production audience simply to populate dashboards.

## Crashlytics and tracing

Crashlytics is not integrated in this repository. **Web support now exists in public
preview**: Firebase JS SDK 13.2.0 introduced it on October 30, 2026, after this app's pinned
11.5.0 SDK. Google's current API reference explicitly advises against production use of
the preview. Evaluate an SDK upgrade and staged integration separately, including
source-map handling, collection controls, retention and costs. Do not assume native/mobile
Crashlytics setup applies unchanged to this static web application.

The preview's optional breadcrumbs also collect navigation, user-action and network trace
information. Enabling them changes the data collected; review redaction and delivery before
using them. This PR's GA4 diagnostics do not claim to activate Crashlytics, Firebase
Performance Monitoring or Cloud Trace.

Official references:

- [Firebase JS release notes](https://firebase.google.com/support/release-notes/js)
- [Crashlytics Web API and preview status](https://firebase.google.com/docs/reference/js/crashlytics)
- [GA4 report pagination and response metadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/RunReportResponse)

## Privacy

Private reports, service-account keys and production counts belong outside pull requests,
CI logs and public artifacts. Default reports omit email addresses but contain player names,
identifiers and activity times. `--redact` is pseudonymization, **not anonymization**; exact
scores/timestamps and stable pseudonyms can still identify players. Review any export before
sharing, and do not commit it even if redacted.

The client does not add provider emails to new Firestore profile writes. Existing Auth,
Firestore and Analytics records are not erased by this policy; historical cleanup, account
deletion and retention remain separate administrative work tracked in #419. Provider
inference from profile-photo hosts is approximate, not an authoritative sign-in count.
