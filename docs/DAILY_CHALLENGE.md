# Daily mountain identity and friend challenges

Daily v1 gives a guest the same named mountain, difficulty and gameplay randomness
as a friend. Every tier, including Black and Expert, remains available without an
account. The pure core lives in `src/daily-challenge.ts`; it neither starts a run
nor stores a record.

## Public API

```ts
createDailyChallenge(date: string, difficulty: Difficulty): DailyChallenge
utcDayString(now: Date | number = new Date()): string
parseDailyChallenge(search: string, now: Date | number = new Date()): DailyChallengeSelection
buildDailyChallengeUrl(challenge: DailyChallenge, href?: string, targetMs?: number | null): string
isDailyChallenge(value: unknown): value is DailyChallenge
isValidDailyTargetMs(value: unknown, difficulty: Difficulty): value is number
isDailyRunEligible(challenge: DailyChallenge, stamp: DailyRunStamp,
  tier: Difficulty, timeSeconds: number, timingCompromised = false): boolean
```

`DailyChallengeSelection` is one of:

- `{ kind: 'none' }` for an ordinary or practice URL with no daily intent.
- `{ kind: 'invalid' | 'unsupported', reason: string }` for a link that cannot be
  played as the requested daily challenge.
- `{ kind: 'daily', challenge: DailyChallenge, targetMs: number | null }`.

`DailyChallenge` contains readonly `id`, `date`, `day`, `difficulty`,
`physicsVersion`, `challengeVersion`, `seed`, `nonce: 0`, and `name`. New values are
frozen. `DailyRunStamp` contains the actual run's `seed: number | null`,
`practice: boolean`, `nonce: number`, and `physicsVersion: number`.

`createDailyChallenge` throws on invalid dates or tiers. It permits authoring a
future date; `parseDailyChallenge` rejects dates later than the injected clock's
UTC date. `buildDailyChallengeUrl` throws on forged/unsupported identity, invalid
targets, and non-HTTP(S) URLs. It never upgrades an old identity to today's rules.

## Stable identity

The date is a real `YYYY-MM-DD` UTC calendar date between 1970-01-01 and
9999-12-31, inclusive. `day` is the integer number of UTC days since the Unix
epoch. Leap days must exist; JavaScript's normalized dates such as February 30
are rejected by a canonical round trip.

The identity format is `d<challengeVersion>-v<physicsVersion>-<day>-<difficulty>`.
The first release uses challenge version **1** and the game's current physics
version **4**. For 2026-11-08 on Blue:

```text
id:   d1-v4-20765-blue
seed: 1218096549
name: Frost Peak
nonce: 0
```

Difficulty ordinals are deliberately fixed protocol data:

| Difficulty | Ordinal | Minimum target/result time |
|---|---:|---:|
| Bunny | 0 | 15 seconds |
| Blue | 1 | 15 seconds |
| Black | 2 | 10 seconds |
| Expert | 3 | 10 seconds |

The maximum target/result time is 600 seconds. Bounds come from
`src/score-limits.ts`, shared with the current all-level score policy. Target
values are integers in milliseconds. Completed result times may retain their
full seconds precision; callers should round a valid finish to milliseconds
when creating an invitation.

The seed calculation is intentionally verifiable using Firestore arithmetic:

```text
seed = (day * 1664525 + 1013904223 + ordinal * 69069) % 4294967296
```

The supported date range keeps every intermediate integer below JavaScript's
exact integer limit (2^53). The seed is an unsigned 32-bit integer. The world
seed controls the seeded layout and hazard streams; the gameplay nonce is
always zero, so physics and avalanche streams reset to the same challenge on
Replay. Neither target times nor display names participate in the seed.

Names use a fixed ASCII adjective/landmark vocabulary selected from the seed.
They are player-facing labels, not identifiers; different challenges can share
a name. A future name vocabulary change must not change identity or seed.

## Link format and validation

```text
https://snowglider.ai/?daily=2026-11-08&level=blue&cv=1&pv=4
https://snowglider.ai/?daily=2026-11-08&level=blue&cv=1&pv=4&beat=35000
```

The date, tier and both versions are required. Versions must be canonical
positive decimal integers; a syntactically valid version this client does not
support produces `unsupported`. No old or future rules are silently replayed
using the current implementation.

Daily-only metadata (`daily`, `cv`, `pv`, `beat`) without a complete identity
fails closed. Ordinary `?seed=123` practice URLs remain outside the daily parser.
A daily URL cannot contain any `seed` override. Duplicate run parameters
(`daily`, `level`, `cv`, `pv`, `beat`, `seed`, `play`) are rejected even when their
values match. Parameter names are case-sensitive; daily-looking names with
incorrect casing are invalid. Encoded names are decoded before duplicate checks.
A `play` handoff may match the daily tier; a conflicting or unknown tier is
invalid. The parser bounds search input to 8 KiB.

Campaign/display parameters may coexist with a valid challenge but cannot alter
its identity. The URL builder strips all prior parameters, user information and
fragments, then emits only `daily`, `level`, `cv`, `pv`, and optional `beat`. It
preserves the supplied HTTP(S) origin and pathname. Public sharing code must
select the public game origin; the pure builder also supports local preview
origins and subpath hosting.

A `beat` value is an **untrusted invitation target**. It is not evidence that
anyone completed that time. Parsing or opening a link must never import it as a
personal best, account result, leaderboard entry, earned reward, or eligibility
proof. A changed target leaves the mountain identity and random streams intact.

## Caller obligations and local record eligibility

The integration must lock the parsed challenge at scene construction and keep it
through the run. A menu selection or URL edit during play must not relabel a
finished scene. Replay must restore its seed and nonce zero. UTC midnight may
change the next featured mountain, but cannot change a run already underway.

For daily v1, install `setWorldContext(challenge.seed, true)` and keep the daily
record separate from canonical scores and ghosts. `practice: true` is deliberate
isolation; it does not make arbitrary practice URLs eligible for daily records.
`isDailyRunEligible` additionally verifies every challenge field, the exact seed,
physics version, nonce zero, scene tier, uncompromised timing, and the tier's time
bounds. The helper requires a real finished result from the caller; it cannot
prove a finish by itself. It does not read browser globals or the live singleton.

An `invalid` or `unsupported` daily selection must **block the requested daily
Play action** and explain the reason. Do not collapse it to `none`, silently fall
back to a canonical ranked run, or clear it during loading to make a score pass.
An explicit player action can leave the rejected invitation for ordinary play.

This layer does not create a global daily leaderboard. Before enabling remote
saving, add an isolated versioned daily namespace, authenticated ownership and
server rules that verify the identity/seed/tier/nonce/version/time bounds.
Client consistency checks alone are not anti-cheat proof. Keep arbitrary seed
URLs practice-only and preserve the existing canonical score guards.

## Guest playable flow

The welcome screen offers today's mountain for the selected level. A shared
invitation opens the same date, level, seed and nonce, without sign-in. Starting
still requires a gesture in the loaded page so browser audio activation works.
Changing levels rebuilds the world and removes a target from the previous level;
Replay keeps the original mountain even across UTC midnight. Returning to the
menu refreshes today's invitation, while an active run's identity stays locked.

`daily-session.ts` selects the world before scene construction. `daily-records.ts`
stores only validated completed times under `snowgliderDailyBest_<challengeId>`.
Each write re-reads the existing best, and reports storage failure without
blocking sharing or replay. These are **device** records: signing in does not
claim them for an account, and daily runs do not update regular scores or ghosts.
Custom `?seed=` practice runs remain ineligible for both record paths.

The finish screen shows a separate daily best and the delta to an optional
friend's shared target. Share links contain the exact challenge and a valid
completed target; a timing-compromised run can invite someone to the mountain
but cannot supply a target. Text, native sharing and downloaded images retain
the level/date context. Global daily ranking and account saving remain a later
layer requiring their own server rules and qualification.

## Integration verification

`tests/daily-records-tests.js` covers canonical/practice/daily world selection,
isolated records, altered provenance, denied storage, slower writes, fixed
gameplay streams, sharing and target comparison. `tests/daily-result-tests.js`
uses the actual result overlay, course panel and share controls to verify tied
times, storage-denied finishes, invalid provenance and canonical-record isolation.
The cross-browser
`tests/e2e/daily-mountain.spec.ts` exercises guest entry, finish/share/retry,
level changes and rejected invitations, and attaches actual EZ-forest welcome
and result screenshots. These browser checks use scripted finishes; they do
not establish physical-phone control, thermal performance or OAuth acceptance.

The production PWA job also runs `tests/e2e/pwa-daily.spec.ts` against the built
artifact. It checks bundled run provenance, isolated device saving, the copied
invitation, replay and reload persistence. Daily native sharing prefers the
playable URL; a separate image action remains available. A native share dialog
resolving is not evidence that a social post was published.

Run telemetry adds bounded `run_mode=regular|practice|daily` and
`challenge_entry=none|daily|friend` fields from the locked, provenance-matched
scene. A friend entry means a valid target was present when the mountain loaded.
These fields separate incoming challenge play from sharing actions without
emitting the date, seed, target, challenge ID or player identity.

## Core verification

`tests/daily-challenge-tests.js` is auto-discovered by `npm test`. Run it directly:

```sh
node --import ./tests/loaders/register-ts-resolve.mjs tests/daily-challenge-tests.js
```

It covers a pinned identity/seed vector, UTC and leap boundaries, all tiers,
strict and fuzzed URL inputs, duplicate/conflicting parameters, future dates,
unsupported versions, time bounds, clean URL round trips, target/seed isolation,
forged identities/stamps, and global RNG/DOM/storage neutrality.
