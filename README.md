# Skill Dating

A builder-first social network. Find the right people to build with — hackathon
teammates, collaborators, mentors — matched on demonstrated skills instead of static
profiles, then take the whole journey inside one product: form a team, chat, build,
ship, and earn reputation.

> Status: pre-launch. The backend is functional end to end; the interface is a
> functional placeholder while the visual design is being built separately.

## The core loop

```
Discover → Connect → Team up → Chat → Build → Ship → Compete → Win → Reputation
```

1. **Discover** builders ranked by skill compatibility with you, and **connect** with
   a typed request (teammate, collaborator, mentor, friend, network, or dating) that
   unlocks a DM the moment it's accepted.
2. **Team up.** Teams are open or closed to applications, capped by size, and joined
   through an apply/accept flow — either direction: apply to a recruiting team, or get
   invited directly by its owner.
3. **Coordinate.** Every team, project and hackathon gets a conversation, and members
   are added to it the moment they join.
4. **Build and ship** projects, or post a "currently building" status others can browse.
5. **Compete** in hackathons as a team, submit for judging, and **win** — placements
   award XP and a permanent achievement to every member of the winning team.
6. **Reputation.** XP, an activity feed, achievements, and a live leaderboard.

## What's implemented

| Area | Details |
| --- | --- |
| Auth | Sign-in, sign-up, passwords and social login belong to [Clerk](https://clerk.com). Every API route verifies the Clerk session token itself (bearer header or the `__session` cookie) and maps it to a local `User` row, created or linked on first sight; middleware only does redirects and is not trusted for security. A verified email raises `verificationLevel` to `EMAIL` and a connected GitHub account to `GITHUB`, never downgrading. A signed webhook keeps the row in step and turns a deleted Clerk account into an anonymised tombstone instead of erasing its content. See [`docs/AUTH_MIGRATION.md`](docs/AUTH_MIGRATION.md). |
| Rate limiting | Every API route is limited per signed-in user, with `429` and `Retry-After`; signed-out traffic shares a per-address flood bucket. The limiter sits behind an interface (in-memory today, swappable for a shared store), bounds its own memory, and keeps serving if its store fails. See [Rate limiting and proxies](#rate-limiting-and-proxies). |
| Onboarding | Route-level gating: an account can't reach the app until it has a headline and at least one skill. |
| Discovery | `GET /api/discover` — paginated, excludes yourself, ranked by a shared, unit-tested skill-compatibility score. |
| Connections | Typed connection requests in either direction, checked both ways for conflicts, no self-connect. Accepting one atomically creates the shared DM conversation. |
| Teams | Create, browse and filter (recruiting, hackathon, free text, skill match), apply, accept or reject, withdraw your own application, invite someone directly, leave, remove members, promote/demote roles, transfer ownership, delete. |
| Team integrity | Team and (independently) project size caps are enforced atomically inside the accept transaction, so simultaneous accepts can never overfill either one. A sole owner can't abandon a team with no owner left — they transfer ownership first. |
| Projects | Public showcase listing with correct visibility rules for private and member projects (owner, member, or public — not just public). Status lifecycle through to shipped. Delete cascades cleanly. |
| Current builds | Post a "what I'm building right now" status (`PUT /api/builds/me`), browsable as a public feed, optionally scoped to a hackathon. |
| Hackathons | Browse by status, register, form or join a team, min/max team size enforced independently of the team's own cap, submit a project for judging, and record final placements — which award win XP and an achievement to every member of the winning team. Status moves forward only (upcoming → active → ended, or cancelled). |
| Messaging | Direct, group, team, project and hackathon conversations. Send, edit and delete with soft-delete masking, pagination, per-conversation unread counts and a total, mark-as-read (all or up to a message), emoji reactions, and list filtering by type and search. Clients cannot bind a conversation to a team, project or hackathon. |
| Blocking | Block and unblock a user. Blocking severs the connection and withdraws pending applications and invitations in one transaction, and is enforced in both directions across discovery, lists, the leaderboard, recommendations, profiles, messaging, applications and endorsements. The blocked user is never told. |
| Notifications | Written on applications, decisions, invitations, connections, messages, removals, registrations and hackathon wins. The UI reads real data, supports mark-read and mark-all-read, and keeps an unread count. |
| Moderation | Report a user (deduped, no self-reporting), moderator/admin review queue with forward-only status transitions, each resolution logged as a moderation action and an audit event. |
| Reputation | Shared XP award logic, a real activity feed, achievements (granted idempotently, defined in one place), and a live leaderboard computed from the XP event log. |
| Profiles | Skills, XP, a live rank, achievements, owned and joined projects, owned and joined teams, an activity feed (`GET /api/activity`), and your own email on your own profile only. |
| Skill evidence | Attach evidence (portfolio, GitHub project, certification, contribution) to a skill on your profile, and endorse other people's evidence, once each. Endorsements are stored as evidence rows of their own type. The achievement and XP for being endorsed only count endorsements from verified accounts, with daily caps per endorser and per recipient. |
| Project progress | Project updates and milestones, with a members-only write path, per-user posting limits, notifications to teammates, and achievements for a first update and first completed milestone. |
| Dashboard | `GET /api/dashboard` returns everything the dashboard shows through the same rules as the rest of the API, including block filtering. |
| My applications | `GET /api/teams/applications` — a user's own applications and their status, including invitations sent to them. |
| Demo data | `npm run db:seed` populates a small, clearly-fake community (users, projects, teams in different states, hackathons, messages, applications, skill evidence and endorsements, project updates and milestones, connections, read state and reactions) — idempotent, safe to re-run. |

Ownership and membership checks live in shared helpers, so authorization is not
re-implemented per route. Every route is documented in
[`docs/API.md`](docs/API.md), generated from the actual handler code. Response
types for the interface are exported from `src/types/api.ts`, and
[`docs/FRONTEND_CONTRACT.md`](docs/FRONTEND_CONTRACT.md) maps each page to the
endpoints it should call, including the mock fields that have no API behind them.

## Stack

Next.js 14 (App Router) · TypeScript · PostgreSQL · Prisma · Clerk · Zod ·
Tailwind CSS · Radix UI · React Query · react-three-fiber · Vitest

## Getting started

Requirements: Node 20+ and PostgreSQL 13 or newer.

```bash
git clone https://github.com/apexxx01/skill-dating.git
cd skill-dating
npm install

cp .env.example .env.local
# set DATABASE_URL and the three Clerk values from your Clerk development
# instance (dashboard, API keys): NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and
# CLERK_SECRET_KEY, plus CLERK_WEBHOOK_SECRET once you have created the webhook
# endpoint (see docs/AUTH_MIGRATION.md, "Open items")

npm run db:migrate:deploy   # applies prisma/migrations to an empty database
npm run db:seed         # optional — populates a small demo community
npm run db:seed:clerk   # optional — creates the matching Clerk users so the demo accounts can sign in
npm run dev
```

Open http://localhost:3000.

Configuration lives in environment variables, all documented in `.env.example`.
See [Configuration](#configuration) for the ones that matter when deploying.

`/signin` and `/signup` render Clerk's `<SignIn />` and `<SignUp />` with path routing, so the
sign-in methods offered (password, Google, GitHub, and so on) are whatever the Clerk instance enables
in its dashboard. Returning users go to `/dashboard`, new accounts to `/onboarding`. The rest of the
frontend is unchanged; see [`docs/AUTH_MIGRATION.md`](docs/AUTH_MIGRATION.md#frontend-files-that-need-changes).

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string (PostgreSQL 13 or newer). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | yes | From the Clerk dashboard. Use a development (`pk_test_` / `sk_test_`) instance while developing; the integration suite refuses any other key. |
| `CLERK_WEBHOOK_SECRET` | in production | The signing secret of the webhook endpoint that points at `/api/webhooks/clerk`. Without it the route answers `503` and processes nothing. |
| `CLERK_AUTHORIZED_PARTIES` | set it in production | Comma separated origins allowed to mint session tokens (for example `https://app.example.com`). Unset skips the authorized-party check. |
| `TRUSTED_PROXY_HOPS` | set it when deploying | Number of reverse proxies you run in front of the app. `0` (the default) means the client address is unknown, so **all signed-out callers share one rate-limit bucket**. Behind a single load balancer set `1`. Details below. |

| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | in production | Upstash Redis (REST). Holds rate-limit counters, leaderboards, presence. Set both or neither. |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | in production | Inngest, for background jobs (served at `/api/inngest`). Set both or neither. |
| `ABLY_API_KEY` | in production | Ably (`appId.keyId:secret`), for realtime. Used only on the server; browsers get tokens from `POST /api/realtime/token`. |

Sign-in providers (Google, GitHub, and so on) are configured in the Clerk dashboard, not here.

### Validation

Every setting is checked by `src/lib/env.ts` when the server starts. A missing or malformed one
stops it (in production the process exits with code 1), with all the problems listed by name
(never by value). Empty values count as unset.
`next build` needs none of them. In development and tests the Redis, Inngest and Ably settings are
optional: an in-memory stand-in is used, which keeps state per process and delivers nothing
outside it. In production they are required, because those stand-ins cannot work across instances.

"Production" means `VERCEL_ENV=production`, or `NODE_ENV=production` where `VERCEL_ENV` is not set
(self-hosting stays strict). A Vercel **preview** deployment also runs with `NODE_ENV=production`;
with `VERCEL_ENV=preview` it may start without the "in production" settings above, on the in-memory
stand-ins, and prints a startup warning naming each one it is running without. Settings that are
present are still validated, and credential pairs must still be set together.
Code reads settings through the typed `env` object, never `process.env`. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Rate limiting and proxies

Limits are keyed on the signed-in user. Signed-out traffic needs the client's
address, and a client address can only be trusted when a proxy you
control writes it. So the address is read from `X-Forwarded-For` only when you say how
many proxies sit in front of the app:

| `TRUSTED_PROXY_HOPS` | Behaviour |
| --- | --- |
| `0` (default) | Forwarding headers are ignored. Signed-out callers share one generously sized bucket. Right for local development. |
| `1` | One reverse proxy or load balancer in front. The address the proxy appended (the rightmost entry) is used. |
| `N` | N trusted proxies; the Nth entry from the right is used. |

Never set it higher than the number of proxies you actually run: anything to the left
of the trusted entries can be forged by the client. Counters live in the shared cache
(`src/lib/infra/cache.ts`): Upstash Redis when configured, so the limit is exact across
instances, and process memory otherwise, where each instance keeps its own count.

## Database migrations

The schema changes through Prisma migrations only. `prisma db push` is not used (there is
no script for it) because it changes a database without leaving a record that can be
reviewed, replayed or rolled forward elsewhere.

- **New database:** `npm run db:migrate:deploy`.
- **Changing the schema:** edit `prisma/schema.prisma`, run `npm run db:migrate` and give
  the migration a descriptive name, read the generated SQL, and commit the schema change and
  the migration directory together. CI fails a pull request whose schema differs from what
  the migrations produce.
- **A database that already exists** (created earlier with `prisma db push`): it already has
  the baseline schema, so do not run the baseline SQL against it. Run `npm run db:baseline`
  once to record `20261014000000_baseline` as applied, then `npm run db:migrate:deploy` for
  anything newer. `npm run db:migrate:status` should then report the database is up to date.
- **Rolling back** is a new forward migration; Prisma does not generate down migrations.

`20261014000000_baseline` was generated with
`prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`. Applied
to an empty database it produces exactly the schema `db push` produced.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run typecheck` | Type-check the project |
| `npm test` | Run the unit tests (fast, mocked Prisma, no DB needed) |
| `npm run test:integration` | Run the integration suite against a real, disposable database — spins up its own `next dev` server, no manual setup beyond a reachable Postgres **and a Clerk development secret key** (`CLERK_SECRET_KEY` in the environment or `.env.local`): the tests create real users and sessions on your development instance through the Backend API and delete them afterwards. It needs network access and refuses a non-development key. Configure with `TEST_PORT` (default 3459), `TEST_DB_NAME` (default `skill_dating_integration`) and `TEST_DB_BASE_URL` (default `postgresql://postgres:postgres@localhost:5432`). It refuses an occupied port and refuses to use the `skill_dating` database, so it cannot touch development data. Runs that share a machine need separate checkouts, since two dev servers cannot share one `.next` directory. |
| `npm run db:seed` | Populate a small idempotent demo community (legacy rows: no password, no Clerk id) |
| `npm run db:seed:clerk` | Create the matching Clerk users for the seeded accounts (password `DemoPass123!`) and store their ids. Idempotent; refuses a non-development key |
| `npm run db:migrate` | Create and apply a migration after editing `prisma/schema.prisma` (development only; review the SQL it writes before committing) |
| `npm run db:migrate:deploy` | Apply every pending migration. This is what to run in CI and in production |
| `npm run db:migrate:status` | Show which migrations the database has applied |
| `npm run db:baseline` | One-off for a database that already has the current schema (created with the old `prisma db push`): mark the baseline migration as applied without running it |
| `npm run db:studio` | Browse the database in Prisma Studio |

## Project layout

```
prisma/schema.prisma   data model
prisma/migrations/     SQL migrations; the only way the schema changes
prisma/seed.ts         idempotent demo data
src/app/api/           route handlers
src/app/(dashboard)/   authenticated app pages
src/lib/               scoring, XP, activity/achievements, auth, shared API helpers
src/lib/env.ts         validated, typed environment (the only reader of process.env)
src/lib/api/errors.ts  the error codes and the { error: { code, message } } contract
src/lib/infra/         cache (Redis), jobs (Inngest) and realtime (Ably) behind interfaces
src/instrumentation.ts validates the environment when the server starts
src/hooks/             client data hooks
tests/integration/     real-server, real-database integration tests
docs/API.md            full route reference and the error code list
docs/ARCHITECTURE.md   how it fits together and why
docs/FRONTEND_CONTRACT.md  page-by-page endpoint and response contract for the interface
src/types/api.ts       shared response types
```

## Continuous integration

`.github/workflows/ci.yml` runs on every push: type-check, backend lint (blocking),
whole-repository lint (report only, so interface lint issues do not block backend
work), a production build, unit tests, a check that `prisma/schema.prisma` and
`prisma/migrations` agree, and the integration suite against a Postgres 16 service
container, which builds its database from the migrations.

## Roadmap

- Challenges (would need sandboxed code execution — a security decision, not a
  route) and full skill-evidence verification beyond the GitHub sign-in signal
  are modelled in the schema but have no further API routes yet.
- Muting (blocking is done).
- A dedicated endorsement table, and an index on activity by project, if evidence or
  activity volume grows: both need a schema change. Endorsements currently live as
  evidence rows of their own type, matched through JSON metadata.
- Presence, typing indicators, project stars and forks, followers and streaks: the
  interface mocks show them, but no data model or API exists yet (see
  `docs/FRONTEND_CONTRACT.md`).
- Real-time delivery. The Ably adapter and the subscription token endpoint exist, but nothing
  publishes yet, so notifications still refresh by polling.
- Real jobs. The Inngest pipeline is in place with a single `system/ping` job.
- Full interface design.

See [PRODUCT.md](PRODUCT.md) for the product vision and principles.
