# Deploying

The order of a deploy, what to run after it, and what to do when it fails. For what each setting means see
the [README](../README.md#configuration) and [ARCHITECTURE.md](ARCHITECTURE.md#environment-srclibenvts); for the
gamification stage (leaderboards, cosmetics, seasons) see [GAMIFICATION.md](GAMIFICATION.md).

## The order

1. **Migrate the database**, before the new code takes traffic: `npm run db:migrate:deploy`. Migrations only ever add to
   what the previous release reads (new tables, new columns with defaults), so the old release keeps working while this runs.
   `npm run db:migrate:status` should then say the database is up to date.
2. **Deploy the application** (build, then switch traffic).
3. **Run the post-deploy command** once the new release is live:

   ```
   npm run postdeploy
   ```

   It is safe to run after every deploy. Run it from a shell that has the **production** environment (the same
   `DATABASE_URL`, Clerk and Upstash settings the application has), for example as a step of the deploy pipeline or through your
   platform's "run a command with this environment" feature. It prints what it does and never a secret. A non-zero exit means the
   deploy is **not finished**.
4. **Check** (below).

**The matching engine** (see [MATCHING.md](MATCHING.md)) needs nothing extra after a deploy: its migrations are additive (the enum `MatchType`, `MatchingProfile`, `Drop`, `Spark`, `Match`,
`User.birthDate`, a `closedAt` on `Conversation`, new indexes), its jobs (`drops/generate` hourly, which only dispatches `drops/generate-batch` jobs, 250 people each and 8 at a time; `drops/expire` hourly; `drops/second-look` Mondays) are registered with the job queue like the others and
are safe to repeat, and no new setting is required. The first hourly run after a deploy gives every person whose chosen drop time has already passed today their drops (catch-up), so expect one larger run (a dispatch plus as many batches as it takes). Make sure the job queue's concurrency for `drops/generate-batch` (8) is below your database connection pool. Run
`POST /api/admin/jobs/drops/generate` with `{ "data": { "userIds": [...] } }` to regenerate for particular people. One migration (`utc_database_default`) sets the database's default time zone to UTC and, where the role may not
change the database, only prints a notice; applications connecting through a pooler (`pgbouncer=true`) rely on that default, because poolers refuse session settings.

## What `npm run postdeploy` does

In this order, stopping at the first failure:

| Step | What it does | If it cannot |
| --- | --- | --- |
| `environment` | Decides whether this is production (`VERCEL_ENV=production`, or `NODE_ENV=production` where `VERCEL_ENV` is not set, the same rule the application boots by). **In production without `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` it refuses to run**, saying which is missing, before touching anything. With them set it pings Upstash and fails if it does not answer. | Exit 1, `REFUSING TO RUN: ...` |
| `database` | `SELECT 1`. | Exit 1 with the database's error. |
| `season` | Makes sure a season is running. A season that is over is closed first (final standings written, the next one opened). With none at all, Season 1 is opened starting now; with none running after the last, the next number follows on from it. | Exit 1. |
| `leaderboards` | Runs the job `leaderboards/reconcile`: rebuilds every board of the current periods from the XP log and swaps each in whole, then checks that the cache kept what was written. | Exit 1. The old boards are left as they were. |
| `cosmetics` | Runs the job `cosmetics/backfill`, page by page (500 people at a time, following the cursor it hands back) until it is done: gives everybody the cosmetics their tier, achievements and streak have already earned. | Exit 1. Run again; what was granted stays granted. |

Every step is idempotent: a second run finds the season running, rebuilds the same boards, and grants nothing new. Running it twice, or
two deploys at once, does no harm (the season step takes a database lock; two rebuilds each swap in a complete board).

The script prints its own progress only: it switches the database client's query logging off for itself (`PRISMA_QUERY_LOG=off`), so
a run from a development environment is not buried under one line per query.

Options (`npm run postdeploy -- <option>`):

- `--dry-run` runs the environment and database checks and says what each other step would do, changing nothing. Production without
  Upstash still fails a dry run.
- `--production` holds the environment to the production rules even if it does not say it is production. Use it when the script is run
  from somewhere that does not set `VERCEL_ENV` or `NODE_ENV` against the production database (a laptop, a bare CI job).

Outside production without Upstash (a development database), the command warns and **skips the leaderboards step**: the in-process
cache would be gone when the script exits, so there is nothing to build. Everything else runs. The leaderboards of a running server build
themselves on its first read.

## Why Upstash is not optional in production

The leaderboards are Redis sorted sets. The in-process stand-in is a separate copy in every server process, so with several instances
(or a restart) each would rank only the awards it happened to see. `npm run postdeploy` and the application's own boot both refuse a
production configuration without it.

## Check it worked

- The command ended with `Post-deploy finished: ... leaderboards done, cosmetics done` and exit code 0.
- `GET /api/health` is healthy.
- `GET /api/leaderboard?period=all-time` as a signed-in user returns entries, and `me.rank` for somebody with XP matches the `ranks.global` of
  `GET /api/users/{id}/stats`.
- `GET /api/quests` shows `resetsAt` in the future, and `GET /api/users/me/cosmetics` lists what a long-time user has earned.

## When it fails

- **`REFUSING TO RUN ... UPSTASH_REDIS_REST_...`**: set the named variables in the environment the command runs in (they must match the ones
  the application uses, or the application will read a different Redis than the one the script filled), and run it again.
- **`Upstash Redis did not answer a ping`**: the credentials are set but wrong, or the service is unreachable from where the script runs. Nothing was changed.
- **`Invalid environment configuration`**: the application's own settings check (`src/lib/env.ts`) lists every setting that is missing or malformed, by name.
- **A step fails halfway**: fix the cause and run the command again; steps already done report that nothing needed doing. The boards
  swap whole, so a failed rebuild leaves the previous boards in place, and half-built ones expire on their own after six hours.
- **No shell on the host**: each job can be run on its own by an admin with `POST /api/admin/jobs/leaderboards/reconcile` and
  `POST /api/admin/jobs/cosmetics/backfill` (send the `next` it returns as `data.after` to continue). That does not open a season; seasons
  also roll over by themselves, hourly, through `seasons/rollover`.

## Scheduled work

Inngest runs these on a schedule (cron triggers; see the job table in [GAMIFICATION.md](GAMIFICATION.md#operations)): the hourly
`seasons/rollover`, the nightly `achievements/rarity` (03:30 UTC) and `leaderboards/reconcile` (04:00 UTC). Without Inngest credentials
they do not run on their own and a scheduler of your own has to call the admin route.

Stage 1F added four nightly jobs: `integrity/collusion` (02:30 UTC), `integrity/risk` (03:00 UTC), `privacy/retention` (05:15 UTC), and the
event-driven `privacy/export` and `media/scan`. Its migrations are additive (new tables, nullable columns, enum values, defaults); one fills
`User.usernameSkeleton` for existing rows and one creates the six kill-switch flags, OFF.

## Settings added in Stage 1F

| Setting | Required | What it does |
| --- | --- | --- |
| `MEDIA_MODERATION_URL`, `MEDIA_MODERATION_TOKEN` | for romance photos and avatars in production | the media scanner ([SAFETY.md](SAFETY.md#media-safety-srclibinframedia-moderationts)). Without them production refuses those uploads (fail closed). Set together. |
| `CONSENT_REQUIRED` | no (default `true`) | onboarding is complete only with the current terms and privacy notice accepted ([PRIVACY.md](PRIVACY.md#consent-srclibprivacyconsentts)) |
| `INTEGRATION_TEST_SERVER` | never in production (refused) | set by the integration harness only, so its production build may use the in-memory stand-ins |

## Settings added in Stage 1G

| Setting | Required | What it does |
| --- | --- | --- |
| `APP_URL` | with `RESEND_API_KEY` | the address the app is served at, no trailing slash: the links in emails and share cards. Without it links point at `http://localhost:3000` |
| `RESEND_API_KEY`, `EMAIL_FROM` | to send email | notifications and digests by email ([NOTIFICATIONS.md](NOTIFICATIONS.md)). Without them an in-memory outbox keeps what would have been sent: nothing leaves the server. `EMAIL_FROM` is `Name <address@domain>` on a domain verified in Resend |
| `RESEND_WEBHOOK_SECRET` | to learn of bounces | the signing secret (`whsec_…`) of the Resend webhook endpoint for `/api/webhooks/email`. Without it the webhook answers `503` and bounced addresses keep being mailed |
| `NOTIFICATION_SIGNING_SECRET` | recommended where mail is real | 32+ random characters (`openssl rand -base64 48`) that sign the unsubscribe and click-through links. Without it the key is derived from `CLERK_SECRET_KEY`; rotating either breaks the links in mail already sent, so set this one and never rotate it casually |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | to send web push | the VAPID identity (`npx web-push generate-vapid-keys`) and a contact (`mailto:ops@example.com` or an https URL). Set together. Without them an in-memory stand-in records pushes and nothing is sent |
| `SENTRY_DSN` | to report errors | turns the Sentry SDK on for the server, the edge and the browser ([below](#error-reporting-with-sentry)) |
| `SENTRY_TRACES_SAMPLE_RATE` | no (default `0.05`) | share of requests traced, 0 to 1 |
| `SENTRY_RELEASE` | no | names the release; defaults to the commit Vercel built (`VERCEL_GIT_COMMIT_SHA`) |

### Email with Resend

1. Create a Resend account, add and verify the sending domain (SPF, DKIM and a DMARC record are what make the mail arrive), and create an API key with *sending access*.
2. Set `RESEND_API_KEY`, `EMAIL_FROM` and `APP_URL`.
3. In Resend, Webhooks, add an endpoint `https://<app>/api/webhooks/email` for the events `email.bounced` and `email.complained` (the others are acknowledged and ignored) and
   copy its signing secret into `RESEND_WEBHOOK_SECRET`.
4. Check it: sign in as a test account, trigger a notification that emails by default (a squad invitation); the mail should arrive with a
   *Unsubscribe* button in the mail client (the `List-Unsubscribe` header). Then send the webhook test event from Resend and look for `200 {"handled":…}`.
5. Mail is sent by the `notifications/deliver` job (every three minutes), by `notifications/deliver-now` for the time-critical kinds (queued the moment they are written), and the digests by `digests/daily` and `digests/weekly` (hourly). All of them need Inngest.
6. To stop all email and push at once without a deploy, turn on `kill.notification-delivery` ([below](#kill-switches)).

Send from a subdomain (`mail.example.com`) so a reputation problem there cannot reach the domain people sign in with. Watch the bounce rate: a rate above 2% or a complaint
rate above 0.1% is how a sender gets blocked, and the metrics ([METRICS.md](METRICS.md)) report both.

### Web push

1. `npx web-push generate-vapid-keys`; set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` to a monitored address.
2. Never change the keys once people have subscribed: every existing subscription is tied to the public key and stops working. If it must change, people subscribe again.
3. The frontend registers a service worker that shows the payload and reports taps (`POST /api/notifications/deliveries/{deliveryId}/open`); the contract is in
   [FRONTEND_CONTRACT.md](FRONTEND_CONTRACT.md#reach-and-retention-notifications-search-share-cards-invites).
4. Web push needs https (except on localhost) and, on iPhones, the site added to the home screen.

### Error reporting with Sentry

With `SENTRY_DSN` set, the official Sentry SDK reports unhandled errors from the Node server, the edge runtime (middleware) and the browser, plus errors logged at error level
(`log.error`). Without it nothing is sent and nothing is loaded. Every event is tagged with the release and the environment (`VERCEL_ENV`, else `NODE_ENV`) and carries the
request id; personal data is removed before it leaves the process (cookies, authorization headers, IP addresses, e-mail addresses, tokens, query strings, user-written text:
`src/lib/observability/scrub.ts`). Traces are sampled at `SENTRY_TRACES_SAMPLE_RATE` (5% by default), and session replay is off.

Source maps: to get readable stack traces set `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` **in the build environment**; the build then uploads them and removes them from
the deployed files. Without them errors are reported with minified stacks. The browser SDK reads `NEXT_PUBLIC_SENTRY_DSN`, which `next.config.js` fills in from `SENTRY_DSN` at build
time: changing the DSN needs a rebuild. The Content-Security-Policy allows the DSN's host for `connect-src` automatically.

## Kill switches

Seven feature flags, six created OFF by the migration `20261021000600_kill_switches` and one by `20261022000200_kill_notification_delivery`. Turning one **ON** stops that feature for everyone within 30 seconds
(the flag cache's lifetime; on Redis every instance at once), with its own error code, until it is turned off. Nothing else changes and nothing is
lost.

```
PATCH /api/admin/flags/kill.messaging  { "enabled": true }     (admin; audited)
```

| Flag | Stops | Answers | Owner |
| --- | --- | --- | --- |
| `kill.signups` | new accounts (existing ones are not affected) | `503 SIGNUPS_PAUSED` | engineering on-call |
| `kill.romance` | the romance mode: every romance route except leaving it | `503 ROMANCE_PAUSED` | Trust & Safety lead |
| `kill.messaging` | starting conversations, sending, editing and reacting to messages | `503 MESSAGING_PAUSED` | Trust & Safety lead |
| `kill.posting` | Ship Feed posts and edits, comments, LFG posts, squad ideas and demos | `503 POSTING_PAUSED` | Trust & Safety lead |
| `kill.external-hackathons` | adding hackathons from other sites | `503 EXTERNAL_HACKATHONS_PAUSED` | Squads product owner |
| `kill.squad-autoform` | the solo pool's automatic squads (the job skips) | the job returns `paused: true` | Squads product owner |
| `kill.notification-delivery` | all email and push (in-app notifications are unaffected); what was written meanwhile is not sent afterwards | the delivery and digest jobs skip | engineering on-call |

The owner decides when to turn a switch on and off, says so in the incident channel, and writes down why (the flag change itself is in the audit log).
Turning one on outside an incident needs the owner's or the on-call engineer's agreement.

## Backups and restore

- **What is backed up.** PostgreSQL is the system of record: the host's automated daily snapshots, kept 30 days, plus **point-in-time recovery** (the
  write-ahead log, kept 7 days) so any moment of the last week can be restored. Redis holds only what can be rebuilt (leaderboards are rebuilt from the
  XP log by `leaderboards/reconcile`; rate limits, caches and idempotency keys are short-lived). The bucket keeps versioning on, so a deleted or overwritten
  object can be brought back for 30 days; export files are excluded from versioning (they must not outlive their 24 hours).
- **Who.** The engineering on-call can restore; restoring production needs a second engineer's agreement in the incident channel.
- **How (point in time).** Restore into a **new** database at the chosen time (never over the live one), point a one-off copy of the application at
  it with `npm run db:migrate:status` (it should be up to date or behind, never ahead), check the data in question, then either switch
  `DATABASE_URL` to it during a maintenance window or copy the affected rows back with a reviewed script. Run `npm run postdeploy` after switching, so
  the leaderboards are rebuilt from the restored XP log.
- **Drill.** Once a quarter, and before launch: restore last night's snapshot and a point in time from the day before into a scratch database, run the
  migrations status check and the integration suite against it (`TEST_DB_BASE_URL`), and write down how long it took and what went wrong. A restore
  nobody has practised is not a backup.
- **After a restore,** anything written after the restore point is gone: tell affected people, and remember that accounts deleted since then come back
  and must be deleted again (the Clerk webhook deliveries can be replayed from the Svix dashboard).

## Secrets rotation

Every credential lives in the hosting platform's environment and nowhere else (never in the repository; `tests/integration/no-secret-leaks.test.ts`
checks the tree). Rotate each at least yearly, on staff departure, and at once when exposed:

| Secret | How |
| --- | --- |
| `CLERK_SECRET_KEY` | Clerk dashboard: create a new secret key, set it in production and redeploy, then delete the old key in Clerk. |
| `CLERK_WEBHOOK_SECRET` | Clerk dashboard, Webhooks: roll the signing secret; set it and redeploy within the grace period Svix gives. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | public by design; changes only with the instance. |
| `DATABASE_URL` | create a new database role with the same grants, switch, redeploy, then drop the old role. |
| `UPSTASH_REDIS_REST_TOKEN`, `INNGEST_*`, `ABLY_API_KEY`, `STORAGE_*`, `MEDIA_MODERATION_TOKEN`, `POSTHOG_KEY`, `SENTRY_DSN` | each provider's console: create a new key, set it, redeploy, revoke the old one. |

**The Clerk key exposed earlier in development.** A Clerk secret key was exposed during development. Before launch, and regardless of which instance it
belonged to: rotate the secret keys of **both** the development and the production Clerk instances, delete the exposed key in the Clerk dashboard, set
the new key in every environment (production, previews, CI, each developer's `.env.local`), and confirm in Clerk's logs that the old key is no longer
used. Treat any data reachable with it as potentially read: review the Clerk audit log for API use you do not recognise.

## Incident playbook

The full procedure is in [SECURITY.md](SECURITY.md#incident-response). In short:

1. **Declare.** Whoever notices opens the incident channel and pages the on-call engineer. One person leads; one keeps the timeline.
2. **Contain** first, investigate second: a kill switch, a suspension (`POST /api/admin/actions`), revoking sessions in Clerk, rotating a credential,
   rolling back the deploy (the previous build, with migrations only ever additive so the old code still runs).
3. **Assess** whether personal data was involved. If it was, the 72-hour clock for the authority starts when we became aware: involve counsel at once.
4. **Recover** (fix forward or restore, above), then **verify**: health check, the integration suite against production-like data, the audit log.
5. **Communicate** to affected people and, where required, to the authorities ([SECURITY.md](SECURITY.md#incident-response)).
6. **Review** within a week, blameless, with owners and dates for each follow-up.
