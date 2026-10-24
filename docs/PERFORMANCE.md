# Performance

How fast the API is at **10,000 people**, how that was measured, what was slow, what was changed, and what is still unproven. Numbers are from a laptop (Apple M5, 10 cores, 16 GB), a
local PostgreSQL 16 with its default (small) settings, and one `next start` process on the production build; the files are `docs/perf/before.json` and `docs/perf/after.json`.

## Targets and where they stand

| Target (local Postgres) | Measured | |
|---|---|---|
| p95 of a read under 200 ms | slowest: search **134 ms**, then discover 81 ms, dashboard 55 ms, leaderboard 47 ms; everything else under 35 ms | met |
| p95 of a write under 400 ms | slowest: giving Props **57 ms**; the squad builder, which computes a squad rather than saving something, is 253 ms | met |
| digests for 10,000 people within a few minutes, in batches | **9,562 digests in 101 s** across a day's five passes, one process, one person at a time (below) | met |
| the daily drops for everybody | 233 ms a person at p50: **about 5 minutes** with the job's batches 8 at a time, 38 minutes one at a time | works; see "Not fixed" |

## How it was measured

1. `npm run seed -- --scale 10000` ([SEED.md](SEED.md)) builds the world: 10,001 people, 214,523 XP events, 26,313 posts, 288,464 Props, 149,966 follows, 152,573 notifications, 176,888 drops, 110,765 activity days.
   It ends with `ANALYZE` (what autovacuum does a minute after a bulk load); measuring before that plans for tables it thinks are empty and makes everything look worse.
2. `npm run perf:measure -- --label after --plans` builds the app, starts `next start` on the database, makes ten real sessions (Clerk development instance) for ten of the busiest people, one of them an
   admin, and requests each scenario 25 times per person (250 samples; fewer for the routes whose rate limit is lower), three people at a time. The first request of each scenario is a warm-up and is
   not counted. The time is the wall time of the HTTP request from the same machine, body included, so it contains the framework, the session check, the rate limiter, the gate and the query.
   The ten users are deleted from Clerk at the end. With `--plans` Postgres's `auto_explain` writes the plan, with real timings, of every statement over 20 ms to the server log, and the script
   groups them by statement.
3. The rate limits are the product's, so the measurement stays under them (a scenario that would exceed one is given fewer requests); the statuses of every request are in the JSON.

## Before and after (milliseconds)

| Scenario | p50 before | p50 after | p95 before | p95 after | p99 after |
|---|---:|---:|---:|---:|---:|
| feed: for-you | 17.4 | 15.3 | 37.7 | 20.7 | 43 |
| feed: following | 16.4 | 16.2 | 23.3 | 23.4 | 26.3 |
| feed: city | 18 | 15.4 | 24.6 | 32 | 42.2 |
| feed: campus | 12.9 | 9 | 22.4 | 13.4 | 19.3 |
| drops: today | 10.1 | 9.7 | 15.8 | 12 | 13.2 |
| leaderboard: global weekly | 30.2 | 30.3 | 44.3 | 43.3 | 43.9 |
| leaderboard: global all-time | 40.3 | 40.5 | 59.5 | 47.3 | 49.7 |
| leaderboard: city season | 8.9 | 9 | 11 | 11 | 12.3 |
| leaderboard: campus | 6.5 | 19.6 | 25.1 | 22.9 | 24.6 |
| heatmap | 7.3 | 7.3 | 11.8 | 9 | 27 |
| stats (player card) | 4.9 | 5 | 12.6 | 12.9 | 22.6 |
| passport (user profile) | 53.2 | 16.7 | 75.6 | 28.2 | 31.2 |
| discover | 61.2 | 64.4 | 74.8 | 80.8 | 95.6 |
| discover: text search | 75.9 | 50.6 | 96.5 | 80.6 | 88.8 |
| search (command palette) | 351.6 | 22.9 | 520.7 | 133.6 | 192.3 |
| lfg board | 23.5 | 21.1 | 31 | 26 | 27.9 |
| hackathons list | 7.9 | 9.4 | 10.8 | 12.1 | 12.8 |
| notifications list | 6 | 6.1 | 7.8 | 9.3 | 11.3 |
| dashboard (today) | 43.3 | 40 | 65.2 | 54.7 | 71.6 |
| moderation queue | 2.5 | 2.7 | 2.9 | 3.1 | 3.1 |
| admin metrics | 31.3 | 32.9 | 33.1 | 35.1 | 35.8 |
| squad builder (propose) | 237.8 | 247.7 | 251.2 | 252.6 | 254.9 |
| write: post an update | 18.8 | 18 | 29.9 | 30.8 | 36.9 |
| write: give Props | 24.1 | 18.6 | 61.8 | 57.3 | 96.4 |
| write: comment | 15.5 | 15.1 | 24.3 | 20.4 | 38.6 |
| write: mark a notification read | 5.8 | 7.5 | 8.3 | 9 | 10.1 |
| write: follow | 9.9 | 10.2 | 15 | 15.4 | 19.4 |
| write: solo pool preferences | 7.2 | 6.7 | 9.8 | 9.1 | 9.6 |

The rows that did not change are not slow; they are here so a regression is visible. `squad builder` is a `POST` that computes a squad from the solo pool (an optimiser), 20 requests.

## What was slow, and what was done

The plans of the first measurement named five things.

1. **Search for posts and projects** (p50 352 ms, p95 521 ms). The statement scored every candidate by building its text vector (`search_vec(...)`) from the title, 4,000 characters of the body and the
   tags: twice, once to test the match and once to rank it. A common word (`react`) matches a fifth of all posts, so 5,000 vectors were built per search (591 ms for the statement). The vector is now a
   **stored generated column** (`ShipPost."searchVec"`, `Project."searchVec"`: the same function over the same columns, maintained by the database, with a GIN index in place of the expression index),
   and the search reads it. Same text, same results (`search.test.ts` passes unchanged). p50 352 → 23 ms, p95 521 → 134 ms. Declaring a generated column to Prisma is `Unsupported("tsvector")` with
   `@default(dbgenerated(...))` and a `Gin` index; the migration drift check in CI confirms the schema and the migrations agree.
2. **A person's passport** (p50 53 ms): it ranked the person by summing the whole XP log (214,000 rows, a scan every time). `User.xp` is the cache of that total, maintained only by `grant()` in the
   same transaction, so the rank is a count on an index of it (`User_xp_idx`). p50 53 → 17 ms.
3. **Discover with a text filter** (p50 76 ms, two statements of 110 ms): a case-insensitive "contains" on four columns scanned every person. Trigram indexes on `name`, `username`, `headline` and
   `bio` serve `ILIKE '%word%'`. p50 76 → 51 ms. (Discover without a filter is dominated by the scoring of a pool of 100 candidates in the application, and was not changed.)
4. **Search for people** (the other half of the palette's cost): the plan joined every person to the list of candidates and then evaluated the match filters and the score on the whole table. The
   candidates now drive the join (`LATERAL ... OFFSET 0`), so the filters and the score are worked out for the few hundred people who can match. The worst statement is still 200 ms for a word that
   many people share ("rust" matches 1,700 people by skill) and is the next thing to look at (below).
5. **Small ones:** `SkillEvidence(userId, skillId)`, `Project(ownerId, updatedAt)` and `Notification(userId, createdAt)` indexes (scans of 15,000 projects and 50,000 evidence rows for a handful of
   people), a partial index on deleted accounts, and fresh statistics.

Everything is in the migration `20261024000300_performance_indexes`.

## Other things that were timed

| | | |
|---|---|---|
| **Digest job** (`npm run perf:digests`) | 9,562 digests sent (mail goes to the in-memory twin) across five passes at 01, 06, 12, 18 and 23 UTC: 101 s in all. A pass finds the people whose local morning it is and scans everybody else cheaply (14 to 18 s for the 10,000, 19 batches of 500). The job runs hourly and continues itself in batches, so no run is long. | |
| **Daily drops** (`npm run perf:drops`) | 233 ms a person at p50, 387 ms at p95 (scoring and writing). The hourly job gives each person their drops once their chosen time has passed in their zone and fans out batches of 250 per zone, so an hour has a few hundred people; the whole 10,000 is about 5 minutes if 8 batches run at once. | |
| **Metrics job** | 31 days of snapshots, the activity days filled from the log, 24 s in all at 10,000 people (the nightly job does one day). | |
| **Leaderboards** | a cold build of a board is one aggregate over the XP log: 260 to 430 ms. It runs on the first read after a deploy and nightly (`leaderboards/reconcile`), not per request; a read is 30 to 47 ms (in-memory cache here; Upstash in production). | |
| **The seed** | 6 minutes for 10,000 people. | |

## Not fixed, and why

- **The squad builder** takes 248 ms at p50: a CPU-bound optimiser over the solo pool (`partitionPool`/`buildSquad`), one proposal per request, limited to 20 an hour per person. Under the write target, and a
  person asks for it a few times a hackathon. If it needs to be faster the place is `src/lib/squads/optimizer.ts`, not the database.
- **Daily drops** at 233 ms a person: most of it is the candidate query and the scoring of 200 candidates (`bench:matching` and docs/MATCHING.md show where). Fine as a background job; not something to
  call per request.
- **People search for a very common skill or word** has a worst statement of 200 ms. The score of a person who matches only by skill is the same for all of them but for the XP bonus, so a cap on
  that branch of candidates by XP would remove the tail; it changes what deep pages return, so it was left as a decision.
- **Anything on a real deployment.** See below.

## Caching headers

Read-heavy `GET`s send `Cache-Control: private, max-age=N`, `Vary: Authorization, Cookie` and an `ETag`, and answer `304` with no body to `If-None-Match` (`src/lib/api/http-cache.ts`, the `cache` option of
`withAuth`). Everything is about the signed-in person, so **private**: a shared cache must never keep it. The ETag is a hash of the body that was going to be sent, so it saves bytes, not the query.
Opted in (seconds): feed 5, search 5, discover 20, leaderboard 30, passport 30, player card 30, heatmap 60, achievements 60, quests 15, Ship Day 15, projects and teams 20, hackathons 30, LFG board 10,
a user's posts 10, a post 10, skills and campuses 300; and **0** (always ask, but a `304` is a saving) for notifications, the dashboard and matches. Never cached: today's drops (reading them marks them as
seen), and every write. After a write of your own, ask with `Cache-Control: no-cache` (`fetch(url, { cache: 'no-cache' })`; the generated client does this with `{ fresh: true }`): the browser skips the max-age and revalidates with the ETag, so it is told `304` if nothing changed and sent the new body if the write did.

## Load against a deployment

`npm run perf:load` ([scripts/perf/load.ts](../scripts/perf/load.ts)) runs autocannon against the feed, today's drops, search, the leaderboard and (with `--hackathon <id>`) the squad builder:

```
# a preview deployment, with real sessions made on the preview's Clerk development instance
CLERK_SECRET_KEY=sk_test_... npm run perf:load -- --url https://skill-dating-git-branch.vercel.app --sessions sess_a,sess_b,sess_c --duration 20 --connections 10
# or ready-made tokens (they live about a minute)
npm run perf:load -- --url https://preview.example.com --tokens "<jwt>,<jwt>" --duration 10
```

Fresh tokens are minted every 40 seconds from the session ids. It refuses a production-looking address. The routes are rate limited per person (that is the product, and it will show as `429`), so the
report counts `2xx`, `429` and everything else apart and takes latencies from the answered requests: to push harder, use more sessions. Create the people with the seed against the preview's database
(`ALLOW_SEED_ON_REMOTE=1`, a disposable preview database only) and make their sessions with the Clerk Backend API as `scripts/perf/measure.ts` does.

## What this does not prove

- **A real deployment.** Vercel functions have cold starts and a connection pool per instance (use the pooled connection string; see DEPLOY.md), Upstash is a network hop for every rate-limit check and
  cache read (here both are in memory), and Postgres is a hosted instance with its own settings (`random_page_cost` 1.1 on SSD makes index plans more likely than the default 4 used here). Measure the preview.
- **Concurrency.** Three people at a time on one process is a light load; `perf:load` is for more, and lock contention on hot rows (a popular post's Props counter: one statement took 80 to 140 ms
  waiting for a lock) shows at higher concurrency than this.
- **Ten people.** The ten are the busiest of the seed, so their pages are the heaviest, which is the conservative side; the typical person is lighter.
- The background people of `--scale` are written in bulk, not played through the domain functions ([SEED.md](SEED.md)): their volumes are right, their texts and relationships are simpler.
