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
