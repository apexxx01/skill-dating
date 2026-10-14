# Architecture

How the backend is put together, and why. For routes and bodies see [`API.md`](API.md), for
setup see the [README](../README.md), for how authentication was moved to Clerk see
[`AUTH_MIGRATION.md`](AUTH_MIGRATION.md).

## Shape of the system

```
Browser ──► Next.js 14 (App Router, one deployable)
              ├─ src/middleware.ts        page redirects only (not a security boundary)
              ├─ src/app/api/**           route handlers, each wrapped in withAuth
              ├─ src/lib/                 domain logic, auth, env, errors, rate limiting
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
   app pages and signed-in ones away from sign-in. It exists for navigation. **It is not
   trusted for security**: a client could once make middleware be skipped
   (CVE-2025-29927, fixed in Next 14.2.25 and later; this repo runs 14.2.35), and API routes are
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
`/onboarding`); it passes on 14.2.35.

## Environment (`src/lib/env.ts`)

`process.env` is read in one place. A Zod schema validates every setting the app uses and
exposes it as a typed `env` object.

- **Fail fast.** `src/instrumentation.ts` validates when the server starts. A missing or
  malformed setting stops the process with every problem listed, by name and never by value.
  `next build` does not run it, so builds and CI need no secrets.
- **Empty means unset**, so a copied `.env.example` parses.
- **Production is stricter.** The webhook secret and the Redis, Inngest and Ably credentials
  are required, because the in-memory stand-ins would give each instance its own rate limits
  and presence, and would run no real jobs or realtime delivery. Each credential pair must be
  set together.
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

Each getter is process-wide and survives dev-server reloads; `setCache`, `setJobQueue` and
`setRealtime` replace it in tests.

### Cache

Strings with optional expiry, counters, fixed windows, and sorted sets (`zadd`, `zincr`, `ztop`,
`zrevrank`, range by score). `createPresence` and `createLeaderboard` are built on those. The two
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
`drain()` in tests or automatically in development. It is not durable.

`system/ping` is the only job. It exists to check a new environment's Inngest credentials end to
end. To add a job, add an entry to `jobs`, enqueue it with `getJobQueue().enqueue(name, data)`, and
test the handler through `runJob` or a `MemoryJobQueue`.

### Realtime

The server publishes; browsers only subscribe. `POST /api/realtime/token` returns a signed,
subscribe-only token request bound to the caller, covering only channels they may read (own
`user:<id>`; `conversation:<id>` and `team:<id>` for members). One refused channel refuses the
request. Channel access is the pure function `authorizeChannels`, built on the existing membership
checks. The API key never leaves the server. **No code publishes yet**: the adapter and the
subscription path are in place, and wiring publishes into messaging and notifications is the next
step.

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

Integration tests run against a real `next dev` server and a real database rebuilt from
migrations, with real Clerk users and sessions. The server runs the in-memory infrastructure, so
those tests check policy and wiring, not the providers. `TEST_SERVER_LOG=<file>` keeps the server's
output when a run fails. One contract suite (`cache.contract.ts`) defines how every `Cache` must
behave and runs against both implementations.

**What is not verified against the real service.** The Upstash adapter is tested through a fake
Redis client, which proves command mapping, key prefixing and reply parsing but not Redis semantics
(including that Lua script). The Inngest adapter is tested against a recording sender, not Inngest
Cloud. The Ably adapter's token signing is tested against the real SDK offline, but publishing is
not. Run each against a real instance before depending on it.

## Continuous integration

Type-check, backend lint (blocking), whole-repo lint (report only), production build, unit tests,
a migrations check (replay the migrations into an empty database and diff against the schema),
and the integration suite against a Postgres service container.

## Known limitations and open items

- The sign-in and sign-up screens are not wired to Clerk. The UI reads sessions through
  `src/lib/session-client.tsx`, whose `signIn` reports failure until they are.
- The onboarding page and the legacy sign-up page read `data.error` as a string. It is now an
  object, so they need `data.error?.message` (UI files, not changed here).
- Nothing publishes realtime events and the only job is `system/ping`.
- `npm audit` reports vulnerabilities in the dependency tree that were not part of this work.
- `inngest` was installed with `--legacy-peer-deps` (an optional SvelteKit peer needs Vite 8, the
  test runner uses Vite 5).
