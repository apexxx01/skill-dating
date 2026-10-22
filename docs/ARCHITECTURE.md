# Architecture

How the backend is put together, and why. For routes and bodies see [`API.md`](API.md), for
setup see the [README](../README.md), for how authentication was moved to Clerk see
[`AUTH_MIGRATION.md`](AUTH_MIGRATION.md).

## Shape of the system

```
Browser ──► Next.js 15 (App Router, one deployable)
              ├─ src/middleware.ts        page redirects only (not a security boundary)
              ├─ src/app/api/**           route handlers, each wrapped in withAuth
              ├─ src/lib/                 domain logic, auth, env, errors, rate limiting, events, rewards
              └─ src/lib/infra/           swappable providers behind interfaces
                    ├─ cache      Upstash Redis   counters, rate limits, sorted sets, presence
                    ├─ jobs       Inngest         background work, served at /api/inngest
                    └─ realtime   Ably            server publish, per-user subscribe tokens
            PostgreSQL (Prisma)   system of record, changed only by migrations
            Clerk                 identity and sessions
```

One process type serves everything. State that must be shared between instances lives in
PostgreSQL or Redis, never in process memory.

## A request, start to finish

1. **Middleware** (`src/middleware.ts`, Clerk) redirects signed-out visitors away from
   app pages and signed-in ones away from sign-in, and asks `/api/users/me` whether onboarding is
   done. That answer is `complete`, `incomplete` or `unknown` (`src/lib/onboarding-state.ts`): only
   a definite `incomplete` sends anyone to `/onboarding`, and a `401` or any other failure is
   `unknown`, which lets the request through to the page's own `auth()` check. It exists for navigation. **It is not
   trusted for security**: a client could once make middleware be skipped
   (CVE-2025-29927, fixed in Next 14.2.25 and 15.2.3; this repo runs 15.5.27), and API routes are
   not matched by it at all.
2. **`withAuth`** (`src/lib/api/handler.ts`) wraps every API handler. It calls `authenticate`
   (`src/lib/session.ts`), which takes the bearer token or the `__session` cookie, verifies
   signature, expiry and authorized party against Clerk's keys, and resolves the **local**
   `User` row, creating or linking it on first sight. Anonymous callers are rate limited
   before getting a `401`.
3. The per-route **rate limit** and **role check** run, then the handler. Handlers get
   `{ user, prisma }` and return through `createApiResponse` / `createApiError`.
4. Server components call `auth()` (`src/lib/auth.ts`), which runs the same verification.

`tests/integration/middleware-bypass.test.ts` walks every page and API route and sends
`x-middleware-subrequest` in both spellings. It requires an anonymous caller to be refused exactly
as without the header. Against Next 14.1.0 it failed (an anonymous visitor was served
`/onboarding`); it passes on 14.2.35 and on 15.5.27.

## Environment (`src/lib/env.ts`)

`process.env` is read in one place. A Zod schema validates every setting the app uses and
exposes it as a typed `env` object.

- **Fail fast.** `src/instrumentation.ts` validates when the server starts and every problem is
  listed in one pass, by name and never by value. In production the process then **exits with
  code 1** (`src/lib/boot.ts`): `next start` on its own only logs an error from this hook and keeps
  listening, answering every request with a 500, which a supervisor would take for a healthy
  process. In development the error is thrown instead, so the dev server stays up for a fixed
  `.env.local`. `next build` does not run it, so builds and CI need no secrets; they need only the public Clerk
  publishable key, which the root layout's `ClerkProvider` reads while pages are prerendered. Fonts
  are self-hosted (`src/app/fonts`, `next/font/local`, SIL Open Font License texts included), so a
  build needs no network access for them.
- **Empty means unset**, so a copied `.env.example` parses.
- **Production is stricter.** The webhook secret and the Redis, Inngest and Ably credentials
  are required, because the in-memory stand-ins would give each instance its own rate limits
  and presence, and would run no real jobs or realtime delivery. Each credential pair must be
  set together. Production means `VERCEL_ENV=production`, or `NODE_ENV=production` when
  `VERCEL_ENV` is unset (`requiresProductionConfig`). A Vercel preview runs with
  `NODE_ENV=production` as well, so `VERCEL_ENV=preview` is what lets it boot on the in-memory
  stand-ins: `src/lib/boot.ts` then prints a warning naming every service it is running without
  (`inMemoryFallbacks`), and the stand-in job queue runs jobs in-process. The services, and what
  each stand-in loses, are listed once in `SERVICES` in `env.ts`, which both the production
  requirement and the warning read.
- Module-scope code that cannot wait for the whole configuration uses `nodeEnv`, which parses
  `NODE_ENV` alone.
- Tests that change `process.env` call `resetEnvCache()`. Unit tests get dummy values for the
  required settings from `vitest.config.ts`.

## Database and migrations

PostgreSQL through Prisma. The schema changes only through migrations in `prisma/migrations`;
there is no `db push` script. `20261014000000_baseline` was generated from the schema as it stood
(`prisma migrate diff --from-empty`) and is marked applied on databases that already had it
(`npm run db:baseline`). CI replays all migrations into an empty database and fails when the result
differs from `schema.prisma`. The integration suite drops and rebuilds its own database from the
migrations on every run, so it exercises what production runs. The workflow is in the README.

## Infrastructure adapters (`src/lib/infra/`)

Each capability is an interface with a production implementation and an in-memory one. Callers
import the interface and a getter (`getCache()`, `getJobQueue()`, `getRealtime()`); the factory
picks the implementation from configuration. Swapping a provider means writing one class that
implements the interface and changing one factory. Nothing else moves.

| | Interface | Production | In-memory | Chosen when |
| --- | --- | --- | --- | --- |
| Cache | `Cache` in `cache.ts` | `RedisCache` over Upstash REST | `MemoryCache` (`cache.memory.ts`) | `UPSTASH_REDIS_REST_URL` and `_TOKEN` set |
| Jobs | `JobQueue` in `jobs.ts` | `InngestJobQueue` | `MemoryJobQueue` (`jobs.memory.ts`) | `INNGEST_EVENT_KEY` and `_SIGNING_KEY` set |
| Realtime | `Realtime` in `realtime.ts` | `AblyRealtime` | `MemoryRealtime` (`realtime.memory.ts`) | `ABLY_API_KEY` set |
| Storage | `Storage` in `storage.ts` | `S3Storage` (any S3-compatible store, signed with `sigv4.ts`) | `MemoryStorage` (`storage.memory.ts`); in production without a bucket `UnavailableStorage`, which refuses | `STORAGE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY` set |
| Email | `EmailSender` in `email.contract.ts` | `ResendEmail` (`email.ts`, over `fetch`; retryable and final failures told apart) | `MemoryEmail` (`email.memory.ts`): an outbox a test can read | `RESEND_API_KEY` and `EMAIL_FROM` set (and `APP_URL`) |
| Web push | `PushSender` in `push.contract.ts` | `WebPushSender` (`push.ts`, the `web-push` library, VAPID) | `MemoryPush` (`push.memory.ts`) | `VAPID_PUBLIC_KEY`, `_PRIVATE_KEY` and `VAPID_SUBJECT` set |
| Search | `SearchProvider` in `src/lib/search/types.ts` | `PostgresSearch` (full text and `pg_trgm`) | none needed: it is the database | always PostgreSQL today; `setSearch()` swaps it |

Each getter is process-wide and survives dev-server reloads; `setCache`, `setJobQueue` and
`setRealtime` replace it in tests.

### Cache

Strings with optional expiry, counters, fixed windows, and sorted sets (`zadd`, `zincr`, `ztop`,
`zrevrank`, range by score). Three operations exist for leaderboards: `zincrMany` (many increments in
one round trip, a pipeline on Redis, with an expiry that is started and never pushed back), `zreplace`
(rebuild a board under a scratch key and swap it in with one rename, so nobody sees a half-built board),
`zstage` (the same, for a board that is built in pieces and corrected while it is built: `set`, `remove`, then
`commit` or `discard`) and `expire`. `createPresence` and `createLeaderboard` are built on those. The two
operations that must not race, `incr` and `hit`, are single atomic operations: one Lua script on
Redis that increments, starts the expiry if the key has none, and reports the time left. A key can
therefore never outlive its window. The Redis client runs with automatic deserialization off so a
member that looks like a number stays a string. The in-memory cache keeps the safety properties of
the limiter it replaced: expired entries are swept and the key count is hard-capped, so
fabricated keys cannot grow memory.

**Rate limiting** (`src/lib/rate-limiter.ts`) is `CacheRateLimiter` on `hit`. The `RateLimiter`
interface, `consumeSafely` (fails open by default, closed on request) and every caller are unchanged.
Client addresses are trusted only as far as `TRUSTED_PROXY_HOPS` says (README, "Rate limiting").

### Jobs

`jobs` in `jobs.ts` is the registry: each job has a name (`area/action`, also the Inngest event
name), a Zod payload schema, a retry count and a handler. Payloads are validated when enqueued and
again when run. `inngestFunctions()` turns the registry into Inngest functions, and
`/api/inngest` serves them; the handlers are built on first use, so a build needs no credentials.
`MemoryJobQueue` validates, drops repeated ids and retries like the real queue, and runs on
`drain()` in tests or automatically in development. It is not durable. Two rules keep it honest inside a
Next server, where every route is its own bundle with its own copy of the registry and the queue (on
`globalThis`) is shared by all of them: a job runs with the definition from the registry of the code that
queued it (`getJobQueue()` hands each module a view bound to its own registry), because a handler's lazy
`import()` run through another route's bundle can find its module missing and fail every attempt ("Cannot
read properties of undefined (reading 'call')"); and a job that fails every attempt is logged as
`job failed`, never dropped silently.

A job may declare a `schedule` (a UTC cron expression): Inngest then triggers it on that schedule as
well as on its event. The in-process queue never schedules; any job can be run right away with
`POST /api/admin/jobs/{name}` (admin only, audited), which is also how a deployment without Inngest runs
them. Handlers import their module lazily, so the registry stays light.

| Job | Schedule | Module |
| --- | --- | --- |
| `system/ping` | none | checks a new environment's Inngest credentials end to end |
| `seasons/rollover` | hourly | `src/lib/seasons.ts`: close the finished season, write its standings, open the next |
| `achievements/rarity` | 03:30 daily | `src/lib/achievement-rarity.ts` |
| `leaderboards/reconcile` | 04:00 daily | `src/lib/leaderboard-rebuild.ts`: rebuild every current board from the XP log: aggregate up to a cutoff, replay what came after, swap |
| `leaderboards/refresh-user` | event | move one person's entries after a place or privacy change |
| `cosmetics/backfill` | event, once | `src/lib/cosmetics.ts`: grandfather cosmetics for existing users |
| `drops/generate` | hourly (:05) | `src/lib/matching/drops.ts`: finds everyone whose chosen local time has passed and enqueues a `drops/generate-batch` job for each chunk of 250 in each time zone (dispatch only) |
| `drops/generate-batch` | event, 8 at a time | `src/lib/matching/drops.ts`: daily drops for one batch of people; safe to run twice |
| `media/cleanup` | daily (04:50) | `src/lib/media-assets.ts`: removes uploads nobody finished (declared and never confirmed for a day, or rejected), with their objects |
| `romance/drops` | hourly (:25) | `src/lib/romance/drops.ts`: from Monday 08:00 in each person's own zone, enqueues a `romance/drops-batch` job per chunk of 250 people of each time zone who have no drop for their local week (dispatch only) |
| `posts/notify-watchers` | event | `src/lib/posts/watchers.ts`: tells the watchers of a project about a new post, 500 at a time, queuing itself for the next batch; one coalesced notification per project per hour |
| `posts/ship-day-recap` | Saturday 12:30 UTC | `src/lib/posts/ship-day.ts`: writes the week's `ShipDayRecap` (best posts, counts per country, city and campus) once |
| `romance/drops-batch` | event, 8 at a time | `src/lib/romance/drops.ts`: the weekly romance drop for one batch of people; safe to run twice |
| `sparks/digest` | hourly (:35) | `src/lib/matching/spark-digest.ts`: once a local day from 09:00, "N people sparked you" (a count, no names) for plans that do not show who |
| `drops/expire` | hourly (:20) | `src/lib/matching/drops.ts`: mark unanswered drops past their day EXPIRED |
| `drops/second-look` | Mondays 07:15 | `src/lib/matching/second-look.ts`: one grown, previously passed candidate per person per week |
| `integrity/collusion` | 02:30 daily | `src/lib/integrity/collusion-job.ts`: finds groups boosting each other over 30 days, writes fraud signals and lowers what they gave each other |
| `integrity/risk` | 03:00 daily | `src/lib/integrity/risk-job.ts`: recomputes risk scores; level changes are audited |
| `privacy/export` | event | `src/lib/privacy/export.ts`: builds one person's data export into the bucket and notifies them |
| `privacy/retention` | 05:15 daily | `src/lib/privacy/retention.ts`: deletes what the retention rules say is old enough, in batches |
| `media/scan` | event, 5 retries | `src/lib/media-assets.ts`: scans a held romance photo or avatar again after the scanner failed |
| `notifications/deliver` | every 3 minutes | `src/lib/notify/dispatch.ts`: decides what leaves the app for the notifications written since the last run and sends it by email and web push; sends what was held for quiet hours or a retry ([NOTIFICATIONS.md](NOTIFICATIONS.md)) |
| `digests/daily` | hourly (:10) | `src/lib/notify/digest.ts`: the daily digest email, once a local day an hour after each person's drop time; skipped when there is nothing worth sending; continues itself in batches of 500 |
| `digests/weekly` | hourly (:20) | the weekly digest email, Monday from 09:00 local |
| `invites/qualify` | hourly (:45) | `src/lib/invites/invites.ts`: moves open invites forward, and pays an inviter through the rewards engine when the checks pass ([INVITES.md](INVITES.md)) |
| `metrics/snapshot` | 01:20 daily | `src/lib/kpi/snapshot.ts`: records who was active, measures every metric for the day that ended, writes the rows ([METRICS.md](METRICS.md)) |

To add a job, add an entry to `jobs`, enqueue it with `getJobQueue().enqueue(name, data)`, and
test the handler through `runJob` or a `MemoryJobQueue`.

### Storage (uploads)

Uploads never pass through the application. `src/lib/media.ts` is the rulebook (types, sizes, dimensions, duration; a romance photo is stricter), `src/lib/media-assets.ts` the flow, and
`src/lib/infra/storage.ts` the adapter: **declare** the file (type, size, dimensions, SHA-256) with `POST /api/media/uploads`, which checks the declaration and returns a **presigned PUT** for exactly that key and content
type; the client uploads straight to the bucket; **confirm** with `POST /api/media/{id}/complete`, which `HEAD`s the real object and compares its size and type with the declaration (a mismatch deletes the object and
rejects the asset). Only a `READY` asset can be used in a post or as a photo. The key is `posts|romance/<owner>/<sha256>.<ext>`, and `(owner, purpose, sha256)` is unique, which is the **content-hash dedupe**: declaring a file
already uploaded and confirmed answers `duplicate: true` with nothing to upload. Signing is AWS Signature V4 query-string authentication done by hand (`sigv4.ts`, no SDK; the unit test reproduces AWS's published example byte
for byte), so S3, R2 and MinIO all work. Private objects (romance photos) are only ever read through a short-lived signed GET made after the access rule is satisfied; post media uses `STORAGE_PUBLIC_BASE_URL` when the
bucket is public. With no `STORAGE_*` settings development uses `MemoryStorage`, whose "bucket" is `PUT /api/media/dev-upload/{key}` of this server (it exists only while that stand-in is in use), and production uses
`UnavailableStorage`: every call is refused with `503 STORAGE_UNAVAILABLE` rather than pretending to keep files in memory it would lose.

### Realtime

The server publishes; browsers only subscribe. `POST /api/realtime/token` returns a signed,
subscribe-only token request bound to the caller, covering only channels they may read (own
`user:<id>`; `conversation:<id>` and `team:<id>` for members). One refused channel refuses the
request. Channel access is the pure function `authorizeChannels`, built on the existing membership
checks. The API key never leaves the server. **No code publishes yet**: the adapter and the
subscription path are in place, and wiring publishes into messaging and notifications is the next
step.

## Domain events and rewards

Anything that should react to something a user did (pay XP, count it, tell someone) listens to
a **domain event** instead of being called from the route. `src/lib/events.ts` is a typed
in-process bus. A route that changes something calls `emit(tx, 'PROJECT_CREATED', payload)`
**inside its database transaction**, opened with `transactWithEvents()` instead of
`prisma.$transaction()` so the bus knows when it ends. Two kinds of subscriber exist:

- **transactional** subscribers run inside `emit()`, on the same transaction. Anything that must
  commit or roll back together with the action belongs here: the rewards engine is one, so XP
  is never paid for an action that rolled back, and a failing reward rolls the action back;
- **committed** subscribers run after the commit, and never for a rollback. A throwing committed
  subscriber is logged and swallowed, since the request already succeeded. Analytics lives here.

**Handlers stay light; heavy work goes to Jobs.** A transactional subscriber holds the request's
database transaction open, so it may only do database work that has to commit with the action
(write a row, pay XP, create a notification). Anything slow or that talks to another service
(email, webhooks, recounts, fan-out to many users) is enqueued as a [Job](#jobs) instead, and a
committed subscriber is the place to enqueue it, since a job must not start for an action that
rolled back. To make a runaway handler fail rather than hold a connection, every transaction
opened with `transactWithEvents()` has an explicit **15 second timeout**
(`EVENT_TRANSACTION_TIMEOUT_MS` in `src/lib/events.ts`; Prisma's default would be 5). A caller
can pass its own `timeout`, but a longer one is a sign the work belongs in a Job. A unit test
fails if a file that emits an event does not open its transaction with `transactWithEvents()`.

`src/lib/subscribers.ts` registers both and is loaded by the bus before the first event. The
bus is one per process (kept on `globalThis`): Next can evaluate a module once per route bundle,
and separate copies would each have their own subscribers and their own record of open
transactions.

```mermaid
sequenceDiagram
    participant R as Route (withAuth)
    participant DB as PostgreSQL (one transaction)
    participant B as Event bus
    participant W as Rewards engine
    participant A as Analytics
    R->>DB: transactWithEvents: BEGIN
    R->>DB: write the project, activity, ...
    R->>B: emit(tx, PROJECT_CREATED)
    B->>W: transactional subscriber (same tx)
    W->>DB: XPEvent (unique key), User.xp, level/tier/achievement notifications
    W-->>B: envelope recorded for the user
    R->>DB: COMMIT
    B->>A: committed subscribers: project_created, level_up, ...
    R-->>R: scope.rewardsFor(user) becomes `rewards` in the response
    Note over R,DB: on rollback nothing above is kept and no committed subscriber runs
```

Events today: `PROJECT_CREATED`, `PROJECT_SHIPPED`, `PROJECT_UPDATE_POSTED`, `MILESTONE_COMPLETED`,
`HACKATHON_JOINED`, `HACKATHON_WON`, `TEAM_FORMED`, `TEAM_APPLICATION_ACCEPTED`, `EVIDENCE_ADDED`,
`EVIDENCE_ENDORSED`, `CONNECTION_ACCEPTED`, `MESSAGE_SENT_FIRST_IN_CONNECTION`, `MESSAGE_REPLIED`, and four
that the rewards engine announces itself: `STREAK_EXTENDED`, `USER_COMEBACK`, `ACHIEVEMENT_UNLOCKED`,
`TIER_REACHED`. A new event is one entry
in `DomainEvents`, one in `DOMAIN_EVENT_NAMES` and one in `EVENT_REWARDS`
(`src/lib/rewards-config.ts`), which a unit test keeps in step. Emit it from the route inside
its transaction; nothing else needs to change.

### Rewards engine

`src/lib/rewards.ts` (`grant()`) is the **only** code that writes an `XPEvent` or changes `User.xp`.
What an event pays is data, in `src/lib/rewards-config.ts`: amount, daily cap and the one-time key
per action. The rules, the level curve, the tiers and the response envelope are in
[GAMIFICATION.md](GAMIFICATION.md). Three properties come from the design:

- **Exactly once.** Each award has a `dedupeKey` (`project:<id>`, `achievement:<slug>`, `milestone:<id>`, ...) and a
  unique index on `XPEvent (userId, type, dedupeKey)`. Two racing requests cannot both insert; the
  loser sees nothing was written and pays nothing. No lock is needed for this.
- **Capped per local day.** Capped actions take a transaction advisory lock per user and action,
  then count awards since the user's local midnight (`src/lib/time.ts`, `User.timezone`, UTC if
  unset). Parallel requests line up on the lock, so none slips under the cap.
- **One reported total.** `User.xp` moves by one atomic `UPDATE ... RETURNING`, and the
  `RewardsEnvelope` is computed from the before and after totals by pure functions, so level and
  tier changes in it cannot disagree with `levelFor()`.

Existing rows were migrated safely: the dedupe columns are nullable, achievement rows were back-filled with
their key, and every other legacy row keeps a null key, which the unique index treats as distinct
(`20261015000000_xp_event_dedupe`).

### Progress: streaks, achievements, quests, cosmetics

`grant()` does more than pay. In the same transaction it stamps the award with the active season
(`XPEvent.seasonId`), moves the user's streak when the award is an action of their own (`src/lib/streaks.ts`;
the `User` row is locked by the same `UPDATE ... RETURNING` that adds the XP, so concurrent awards cannot
tear a streak), and announces `STREAK_EXTENDED`, `USER_COMEBACK` and `TIER_REACHED`. After the commit it
retires the user's cached views and adds the award to the Redis leaderboards (`src/lib/xp-views.ts`);
a failure there is logged and the nightly rebuild repairs it.

The subscriber for every event (`payForEvent`, `src/lib/subscribers.ts`) then counts what happened.
`src/lib/metrics.ts` turns an event into **ticks** ("this user shipped this project"), but only for an award
that actually paid, so the daily caps and the gates limit achievements and quests exactly as they limit XP.
`recordTick()` inserts the tick (a unique key makes it count once) and raises a counter
(`ProgressTick`, `UserCounter`); `src/lib/achievement-progress.ts` unlocks the achievements the counter
reaches through `grantAchievement()` and `src/lib/quest-progress.ts` moves the user's current quests. Everything
that touches one user's progress takes an advisory lock for that user first, in id order for events that
involve two people, so concurrent requests serialise and cannot deadlock. Cosmetics are earned by
`TIER_REACHED`, `ACHIEVEMENT_UNLOCKED` and `STREAK_EXTENDED` through `src/lib/cosmetics.ts`, the only code that
writes the inventory. Quests can be paused with the `quests` feature flag.

Which three daily and three weekly quests a person has is not stored: it is a seeded shuffle of the pool by
`(user, period)` (`src/lib/quests.ts`), so there is no midnight job and no state to get out of step.

## Matching

The matching engine (profile, compatibility score, daily drops, sparks, matches) is described in [MATCHING.md](MATCHING.md). It follows the
platform patterns: the pure scorer is in `src/lib/matching/score.ts`; the hourly jobs `drops/generate` and `drops/expire` are in the job
registry; a spark that completes a pair writes the match, its conversation and its notifications in one `transactWithEvents`
transaction under a per-pair advisory lock and announces `MATCH_CREATED`, which pays no XP and only counts toward three achievements;
realtime pushes (`match.created`, `match.ended` on the `user:{id}` channel) and analytics (`drop_viewed`, `spark_sent`, `match_created`,
`unmatch`) happen after the commit. The platform's own conversation lines (a match's icebreaker) are sent by a tombstone-style system
account (`src/lib/matching/system-user.ts`) that every list leaves out because it is marked deleted.

## Entitlements and feature flags

`src/lib/entitlements.ts` holds one table of what each plan (`FREE`, `PRO`, `CREW_PRO`, `ORG`) gets:
counted limits (`DAILY_DROPS`, `DAILY_SPARKS`, `BUILD_DATES_PER_WEEK`) and switches (`SEE_WHO_SPARKED`,
`ADVANCED_FILTERS`, `PROFILE_ANALYTICS`, `CUSTOM_DOMAIN`). Code asks `can(subject, feature)` or
`limit(subject, feature)`, never for a plan name. The plan comes from the user's `Subscription` row
(`subjectFor`): none, expired, or lapsed means `FREE`. A paywall is therefore a config change:

- `ENTITLEMENTS_ENFORCED=false` (default) opens every switch to everyone and lifts counted limits to
  their **hard safety ceiling** (`hardLimit`, an abuse bound that applies to every plan, enforced or not),
  except the **scarce** ones (`DAILY_DROPS`, `DAILY_SPARKS`, marked `scarce` in the table): scarcity is the
  product in matching, so everybody gets the FREE numbers, 3 drops and 5 sparks a day, until plans are enforced;
- `ENTITLEMENTS_ENFORCED=true` applies the limits of the user's plan.

Nothing consumes `can()` or `limit()` yet; the first caller arrives with the features they guard.
`Subscription.provider` and `providerRef` are reserved for billing and unused.

`src/lib/flags.ts` evaluates runtime flags stored in `FeatureFlag`: a user is in when they are on
the allowlist (even while the flag is off), or the flag is enabled and a hash of the flag key and user
id falls under `rolloutPercent`. The hash is stable, so raising the percentage only adds users. The flag
set is cached for 30 seconds in the Cache adapter and dropped on every admin change (on Redis that
reaches every instance). Admins manage flags under `/api/admin/flags`; every user reads their own
answers from `GET /api/flags`.

## Analytics

`src/lib/infra/analytics.ts` follows the adapter pattern: `track(userId, event, props)` always writes
a `ProductEvent` row (so the numbers exist with no third party) and, with `POSTHOG_KEY` set, also
forwards the event to PostHog. Events: `signup`, `onboarding_completed`, `project_created`,
`project_shipped`, `level_up`, `tier_up`, `achievement_earned`, `quest_completed`, `streak_extended`. Tracking happens after the
transaction commits, never fails the request, and carries no personal data: the user is our
internal id, and props are reduced to plain values under safe names (names, emails, free text and
URLs are dropped whoever passes them). `signup` counts a brand-new account only, not the linking of an old
row; `onboarding_completed` is recorded once, the first time the profile has a headline and a skill.

## The request gate, and trust and safety

`withAuth` runs one more step after the session, the rate limit and the role check: the **request gate** (`src/lib/api/gate.ts`). It closes a banned
or suspended account to everything but its own account, data and appeals, answers a feature under a **kill switch** (`src/lib/ops/kill-switches.ts`,
feature flags named `kill.*`) or under a moderation **restriction** with its code, asks for **re-consent** on writes after a policy change, and adds a
tighter write limit for a HIGH **risk** account. Which feature a request uses is decided from its method and path in one pure function
(`src/lib/api/request-features.ts`), so no route can forget a switch. What it reads (restrictions, stale consents, the HIGH risk set, the flags) is
cached in the Cache adapter for a minute or less and dropped by every change. Destructive staff actions also need a **recent sign-in**
(`src/lib/api/recent-auth.ts`).

The rest is in its own modules, each with its pure core unit-tested:

| Area | Code | Doc |
| --- | --- | --- |
| Collusion, risk, reach gating | `src/lib/integrity` | [SAFETY.md](SAFETY.md#integrity-srclibintegrity) |
| Reports, the queue, actions, restrictions, appeals | `src/lib/moderation` | [SAFETY.md](SAFETY.md#moderation-srclibmoderation) |
| Content checks | `src/lib/safety`, `src/config/banned-terms.json` | [SAFETY.md](SAFETY.md#content-checks-srclibsafety) |
| Sign-up abuse, reserved names, look-alikes | `src/lib/identity`, `src/config/*.json` | [SECURITY.md](SECURITY.md) |
| Media scanning | `src/lib/infra/media-moderation.ts` (an adapter like the others: no-op, HTTP provider, or fail closed) | [SAFETY.md](SAFETY.md#media-safety-srclibinframedia-moderationts) |
| Consent, privacy settings, export, deletion, retention, the data inventory | `src/lib/privacy` | [PRIVACY.md](PRIVACY.md) |
| Security headers and the CSP | `src/lib/security`, `next.config.js`, `src/middleware.ts` | [SECURITY.md](SECURITY.md#headers) |
| Route, schema and data-inventory audits | `src/lib/api/route-audit.ts`, `schema-audit.ts`, `src/lib/privacy/inventory.test.ts` | [SECURITY.md](SECURITY.md) |

The Storage adapter gained `put` (the server writes an export file) and the in-memory stand-in a read route of its own (`/api/media/dev-download`, like
`dev-upload`, present only while the stand-in is in use).

## API conventions

All of these are built into `withAuth` (`src/lib/api/handler.ts`), so a route gets them by being a
route:

- **Request id.** One per request (a plausible incoming `X-Request-Id` is kept), returned in the
  `X-Request-Id` header and attached to every log line written while the request runs, through
  `AsyncLocalStorage`. The wrapper also writes one access line per request (method, path without query,
  status, duration, user id) and turns an unexpected exception into a logged `500 INTERNAL_ERROR`.
- **Logging** (`src/lib/log.ts`) is JSON lines. Fields whose name looks sensitive are replaced before
  anything is written; the rule for callers is still "ids, never names, emails or message text".
  With `SENTRY_DSN` set, error-level logs are also sent to Sentry through its envelope endpoint over `fetch`
  (no SDK); `setErrorReporter()` swaps in an SDK later.
- **Pagination** (`src/lib/api/pagination.ts`): `paginate()` for lists ordered by a stored column
  (keyset cursors: the sort value and id of the last row, so a page costs the same at any depth and
  paging is not shifted by new rows), `paginateOffset()` and offset cursors where the order is computed
  or spans columns. Page-numbered requests still work and now also return `nextCursor`.
- **Idempotency** (`src/lib/api/idempotency.ts`): `withAuth(handler, { idempotent: true })` on
  creating POST routes. **Every new creating `POST` must opt in** (one that creates a row, a
  message, a request or an award), because a client that retries after a timeout must not create it
  twice. Today that is 18 routes: the 17 user-facing creating routes listed in [API.md](API.md#platform)
  and `POST /api/admin/flags`. The POSTs that do not opt in change existing state or are unique by
  construction rather than create something: marking a conversation read, submitting for a
  hackathon, transferring a team, endorsing (one per endorser and evidence), the reaction toggle
  (a retried toggle undoes itself, so a client must not retry it blindly), the realtime token and the
  Inngest endpoint. The stored response lives 24 hours in the Cache adapter; an atomic counter
  decides which of several simultaneous requests runs. See [API.md](API.md#platform).
- **Health.** `GET /api/health` is public and reports database, cache, jobs and realtime. Only a
  database failure answers 503.

## Error contract

Every API error is `{ error: { code, message } }`, plus `params` and `details` when present. Codes
are enumerated in `src/lib/api/errors.ts` with an HTTP status and an English default message
using `{placeholders}`, which keeps them translatable: a client renders its own text from
`code` and `params`. Routes call `createApiError('TEAM_FULL')`; the code is a TypeScript union, so
an unknown code does not compile. A unit test fails if any route builds an error body by hand, and
another if `docs/API.md` does not list every code. Codes are only added, never repurposed.

## Testing

| Suite | Command | Needs |
| --- | --- | --- |
| Unit | `npm test` | nothing; Prisma and providers are mocked or in-memory |
| Integration | `npm run test:integration` | PostgreSQL and a Clerk **development** secret key |
| Typecheck, lint | `npm run typecheck`, `npm run lint` | nothing |

Integration tests run against a real server and a real database rebuilt from migrations, with real
Clerk users and sessions. By default the server is a **production build** (`next build` into its own
directory, `.next-test`, then `next start`), so routes are compiled before the first request and the
suite exercises what production runs; `TEST_SERVER=dev` uses `next dev` instead (faster to start), and
`TEST_SKIP_BUILD=1` reuses the last build when nothing under `src/` changed. A production build always
runs with `NODE_ENV=production`, so the harness also sets `VERCEL_ENV=preview` (start on the stand-ins)
and `INTEGRATION_TEST_SERVER=true`, which lets it keep uploads in memory and reach the suite's fixture
page; `src/lib/env.ts` refuses that setting wherever production services are required. The server runs
the in-memory infrastructure, so those tests check policy and wiring, not the providers.
`TEST_SERVER_LOG=<file>` keeps the server's output (and the build's) when a run fails. One contract suite (`cache.contract.ts`) defines how every `Cache` must
behave and runs against both implementations.

**What is not verified against the real service.** The Upstash adapter is tested through a fake
Redis client, which proves command mapping, key prefixing and reply parsing but not Redis semantics
(including that Lua script). The Inngest adapter is tested against a recording sender, not Inngest
Cloud. The Ably adapter's token signing is tested against the real SDK offline, but publishing is
not. Run each against a real instance before depending on it.

`/api/inngest` is the Inngest SDK's own handler. Without a signing key (development, tests, a preview, the integration suite's production build) it runs in the
SDK's dev mode: `GET` describes the functions, an unsigned `POST` is refused with `401`, and `PUT`
(registration) answers `500` because it tries to reach a local Inngest dev server that is not
running. That `500` is the SDK's behaviour, not a fault in the route. That an unsigned request is
rejected when `INNGEST_SIGNING_KEY` is set has not been exercised, since it needs a real key.

Run against `next dev` (`TEST_SERVER=dev`), the integration suite can hit a race inside Next itself:
several first requests to dynamic-segment routes at once make the dev server read a manifest file while
another compile is writing it, giving a `500` from inside `next/dist` before any application code runs,
or a brief `404` for a page that exists; under the suite's load the dev server also drops connections
(`fetch failed`) and lets requests run past their timeout. That is why the production build is the
default: `next start` uses prebuilt manifests and is not affected. The bypass test still requests each
route once, one at a time, before sending anything in parallel (the warm-up), so the dev mode keeps
working.

## Deploying

The order of a deploy (migrate, deploy, `npm run postdeploy`) and the post-deploy command are in [`DEPLOY.md`](DEPLOY.md).

## Continuous integration

Type-check, backend lint (blocking), whole-repo lint (report only), production build, unit tests,
a migrations check (replay the migrations into an empty database and diff against the schema),
and the integration suite against a Postgres service container.

## Reach and retention

Stage 1G adds what brings people back and what tells you whether it works. Each part is an adapter or a pure function with a thin database layer, in the same shape as the rest.

- **Notification delivery** (`src/lib/notify`, [NOTIFICATIONS.md](NOTIFICATIONS.md)). Nothing that writes a notification knows about email or push: `Notification.sweptAt` is null until the delivery job has
  looked at it. `policy.ts` is the table (class, defaults, limits, exposure per kind), `decide.ts` the pure decision (eleven rules, first wins), `dispatch.ts` the sweep and the release of held
  deliveries, `digest.ts` the two digests, `templates.ts` and `strings.ts` the words, `tokens.ts` the signed links. `NotificationDelivery` is both the log and the lock (a unique key per person,
  channel and thing), so a repeat is harmless and the metrics read it. The romance mode's kinds have a `NEUTRAL` exposure: only "You have a new message" leaves the app.
- **Search** (`src/lib/search`, [SEARCH.md](SEARCH.md)). A `SearchProvider` interface, PostgreSQL behind it, and every permission rule inside the query.
- **Share cards** (`src/lib/og`, `src/app/api/og`). `data.ts` makes plain models under the privacy rules; `layout.ts` draws a model; `render.ts` is the route wrapper (rate limit, ETag, cache).
- **Error reporting** (`src/lib/observability`, `sentry.*.config.ts`, `src/instrumentation*.ts`). The Sentry SDK when `SENTRY_DSN` is set, with personal data scrubbed before anything leaves; nothing loaded without it.
- **Metrics** (`src/lib/kpi`, [METRICS.md](METRICS.md)). `ActivityDay` as the base, one function per group of numbers, a catalogue of definitions the API and the document both use.
- **Invites and campuses** (`src/lib/invites`, `src/lib/campus`, [INVITES.md](INVITES.md)). XP only through `grant()` (the event `INVITE_QUALIFIED`), under the trusted counterparty rule.

## Known limitations and open items

- The pages Next prerenders as static HTML (`/`, `/error`, `/onboarding`, not-found) get a CSP without a nonce (`'unsafe-inline'` scripts): a per-request
  nonce cannot be in static HTML. Rendering them dynamically (a frontend change) lets them use the nonce policy.
- The per-address sign-up limit applies to accounts first seen through the API. An account the Clerk webhook creates first is checked for the
  kill switch and throwaway domains, but has no client address to count; Clerk's own bot protection on sign-up is the guard there.
- Collusion detection looks at connected groups of reciprocal pairs involving weak accounts; a large ring of established accounts, or a ring hidden inside
  a big group (over 50), is left for a person to find.

- Nothing publishes realtime events.
- Delivery is swept every three minutes, so an email or a push follows its in-app notification by up to that long (and, held for quiet hours, by up to the night). Email opens are click-throughs, not
  pixel loads; a mail scanner that follows links counts as an open.
- Search ranks with PostgreSQL's full-text and trigram scores. It does not segment Chinese, Japanese or Thai, and it ranks without learning from clicks; both are reasons to move to a search engine (the
  interface is there), not to tune the SQL further.
- Share cards are public images: a passport card shows what a person left `PUBLIC` (which means "everyone signed in" in the app). There is no separate "allow share cards" setting yet; see the open
  questions in [PRIVACY.md](PRIVACY.md#share-cards).
- The metrics are measured in UTC days and cohorts by ISO week; `ActivityDay` grows by a row per active person per day (see [METRICS.md](METRICS.md#operating-it) for when to partition it).
- Leaderboard boards are copies of the XP log in Redis. They are repaired nightly, so a failure to update one
  can show a stale score for up to a day. XP that arrives during a rebuild is counted exactly once (see
  [GAMIFICATION.md](GAMIFICATION.md#leaderboards)); an award committing between the last replay pass and the
  rename is put back by a final pass after the swap; what remains is an award committing after that pass has read the log,
  which costs it until the next run. The rebuild aggregates in SQL and holds one batch of 5,000 people in
  memory, but it still scans each period's slice of the `XPEvent` table (indexed by time and by season) every night;
  at tens of millions of rows an incremental version is the next step.
- Raw SQL that compares a bound `Date` with a `DateTime` column goes through `utcTimestamp()` (`src/lib/sql.ts`); written
  without it the comparison is read in the database's time zone, which is only right when that zone is UTC. Every raw query
  that binds a date uses it (leaderboards, heatmap, rarity, counters). Beyond that, every database session runs in UTC, in three
  layers: the application's connections ask for it with the `options=-c timezone=UTC` connection parameter
  (`src/lib/database-url.ts`, skipped for a URL with `pgbouncer=true`, since poolers refuse startup options); the
  migration `utc_database_default` sets the database's own default to UTC (this also covers pooled connections); and
  the queries convert explicitly. `tests/integration/session-timezone.test.ts` runs the heatmap, the rarity job and the counters on
  sessions in five zones and requires identical answers.
- `ProgressTick` gets a row per counted action. Once an action has paid, its XP award is what stops it counting
  twice, so ticks older than a couple of weeks are only history (the week-based secret achievements look back at most
  seven days); pruning them is not built.
- Migrations and counters use `gen_random_uuid()`, which is built into PostgreSQL 13 and later.
- A season is closed by an hourly job, so it can run past its end by up to an hour; a closed season's cosmetics are granted by the same job (and by `npm run postdeploy`), and a season that could not be granted is retried every hour.
- A blocked person is left out of a viewer's leaderboard but keeps their rank, so a rank is the same number on every
  leaderboard and on the player card; a viewer's page can skip ranks.
- `npm audit --omit=dev` still reports Next's bundled PostCSS (fixable only by Next 16); see
  [Dependency advisories](#dependency-advisories).
- Dependencies are installed with `--legacy-peer-deps` when they change: `inngest` has an optional
  SvelteKit peer that needs Vite 8 (the test runner uses Vite 5), and `@react-three/fiber` 9 lists
  `react-native` and `expo` as optional peers, a mobile-only chain npm cannot resolve here. A plain
  `npm ci` accepts the resulting lockfile, and `npm ls` reports no invalid peer range.

## Dependency advisories

`npm audit --omit=dev` on Next 15.5.27 and React 19.3: **2 findings (1 high, 1 moderate), 0 critical.**
Moving from Next 14.2.35 to 15.5.27 cleared every advisory against Next itself (including the
Server Components and request-handling ones the 14.x line could not fix) and the `braces` /
`tailwindcss` chain that used to be reported through `tailwindcss-animate`. Earlier fixes stand:
`@clerk/nextjs` 6.39.7, `glob` pinned to 10.5.0 on the Inngest tracing path through an `overrides`
entry, `source-map-js` updated. The image optimizer is also off (`images.unoptimized`; `/_next/image`
answers 404), since no code uses `next/image`.

| Finding | Why it remains | Exposure |
| --- | --- | --- |
| `postcss` 8.4.31 bundled inside `next` (high: stringify XSS and three source-map read issues) | Next ships its own copy; the audit's only fix is Next 16.4.0, a major upgrade | Build time only. It processes this repository's own stylesheets, never request input, so there is no attacker-controlled CSS or source-map comment to exploit. |
| `next` (moderate) | Reported only because it depends on that PostCSS; none of Next's own advisories apply to 15.5.27 | Same as above. |

Across the whole tree, including dev dependencies, `npm audit` reports 17 findings (2 critical:
`vitest` and its `tinypool`; the rest `vite`, `esbuild`, `tailwindcss` and its `braces` /
`micromatch` / `fast-glob` / `chokidar` chain, `eslint-config-next`). All are development tools that
never run in the deployed server: the test runner, the dev server's bundler and the CSS generator.
They are upgraded with their own major versions (Vitest 3 or later, Tailwind 4), not here.
