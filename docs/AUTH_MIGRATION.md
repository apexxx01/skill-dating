# Authentication migration: NextAuth to Clerk

Branch: `auth-migration`. `main` is untouched and keeps working on NextAuth until this
branch passes the gate (typecheck, unit, integration, production build).

The frontend is frozen for this migration: nothing under `src/app/(dashboard)` or
`src/components` is edited, and sign-in / sign-up UI wiring is out of scope. The
frontend files that will need changes are listed in [Frontend files that need changes](#frontend-files-that-need-changes).

Status of this document: sections 1 to 7 are the design, written before any code. Where a live run
changed it, section 9 says so. Section 8 lists what needs you.

---

## 1. Clerk SDK and Next.js 14.1

We are on `next@14.1.0` (React 18.3.1, Node 20+).

| `@clerk/nextjs` | Peer range for `next` | Works with 14.1.0? |
| --- | --- | --- |
| 7.x (current, `latest`) | `^15.2.8 \|\| ^15.3.8 \|\| ^15.4.10 \|\| ^15.5.9 \|\| ^15.6.0-0 \|\| ^16.0.10 \|\| ^16.1.0-0` | No |
| 6.13 to 6.39 | `^13.5.7 \|\| ^14.2.25 \|\| ^15.2.3 \|\| ^16` | No (14.x floor is 14.2.25) |
| 6.0 to 6.12.8 | `^13.5.4 \|\| ^14.0.3 \|\| ^15` | Yes |
| 5.x (5.7.6 is the last) | `^13.5.4 \|\| ^14.0.3 \|\| >=15.0.0-rc` | Yes |
| 4.x | `>=10`, later `^10 \|\| ^13.5.7 \|\| ^14.2.25 \|\| ^15.2.3` | Early 4.x only |

Facts behind the table, taken from the npm registry (`npm view @clerk/nextjs@<version> peerDependencies`):

- **Exact minimum Next for the current SDK (7.x): 15.2.8.** It also needs Node 20.9 or newer.
- **6.12.8 is the newest release whose peer range still includes 14.0.3+.** 6.12.9
  (published two days later, 2025-03-23) raised the 14.x floor to 14.2.25.
- The floor moved to 14.2.25 because of CVE-2025-29927: a client can send an
  `x-middleware-subrequest` header and make Next.js skip middleware entirely. It is fixed
  in Next 14.2.25 and 15.2.3. **Next 14.1.0 is affected.** This is a property of our current
  Next version, not of Clerk.

### Options

| Option | What it means | Risk |
| --- | --- | --- |
| **A (recommended)** `@clerk/nextjs@6.12.8`, exact pin, Next stays 14.1.0 | Single-variable change: auth swaps, framework does not. | The 6.12 line is frozen, so it gets no further Clerk fixes. Middleware on Next 14.1.0 is bypassable (CVE above). Mitigated below by never relying on middleware alone for authorization. |
| B: upgrade Next to 14.2.35 (latest 14.x patch), then `@clerk/nextjs@6.39.7` | Fixes the middleware bypass, newer SDK. | It is a framework upgrade with its own regression surface (build output, caching semantics), mixed into an auth change. You asked for no silent Next upgrade. |
| C: Next 15.2.8+ and `@clerk/nextjs@7` | Fully current. | Next 15 changes async request APIs and caching defaults and the frozen frontend has not been tested on it. Largest blast radius. |

**Decision for this branch: Option A**, because an older major supports 14.1.0 and nothing
here needs your decision to continue. **Recommendation for after merge: schedule Option B
as its own change**, for the middleware bypass alone.

Because of the bypass, this design does not treat middleware as a security boundary:

- Every API route authenticates inside `withAuth`, by verifying the session token itself
  (signature and expiry against Clerk's keys). It does not read any header middleware
  might have set.
- Server components that need a user (`(dashboard)/layout.tsx`, `dashboard/page.tsx`)
  call `auth()` from `@/lib/auth`, which verifies the token the same way.
- Middleware only does UX redirects (send signed-out visitors to `/signin`, incomplete
  profiles to `/onboarding`). Phase 2 includes a test that sends the bypass header and asserts
  protected API routes still answer `401`.

If Option A shows a runtime incompatibility with Next 14.1.0 (the peer range is not a
guarantee), the fallback is `@clerk/nextjs@5.7.6`, and if that fails too this document is
updated and the work stops for your decision.

---

## 2. Configuration found on the Clerk development instance

You described the instance as: email + password, username required, Google, GitHub, no phone.
Probed live through the Backend API with a throwaway user (deleted straight after; user count
is 0):

- **Phone number is required by the instance.** Creating a user without one returns
  `form_data_missing: ["phone_number"] doesn't match user requirements set for this instance`.
  This contradicts "no phone". It also means real sign-up would ask visitors for a phone number.
  **Action for you (dashboard):** User & authentication, Phone number, turn off "Require"
  (and turn the attribute off if you do not want it at all).
- Until you change it, the integration harness works around it for **test users only**, by
  supplying one of Clerk's fictional development phone numbers when the instance demands one.
  The application never reads or stores phone data (`isPhoneVerified` is not driven by Clerk).
- Users created through the Backend API come back with a verified email and a verified phone.
- A session token minted through the Backend API is an RS256 JWT valid for 60 seconds. Its
  claims are `sub`, `sid`, `sts`, `iss`, `iat`, `nbf`, `exp`, `fva`, `v`. It carries **no email,
  username or image**, so the first-request sync must fetch the user from Clerk.

---

## 3. Inventory: everything that touches NextAuth

### Server

| Where | What it does today | Plan |
| --- | --- | --- |
| `src/lib/auth.ts` | NextAuth config: Prisma adapter, JWT sessions, GitHub / Google / Discord / Credentials providers, `jwt` and `session` callbacks, `createUser` event (audit row), `signIn` event (lastActiveAt, email verified, GitHub verification + level bump). | Becomes the Clerk-backed session reader. Exports `auth()` returning the same `{ user: { id, name, email, image, role } }` shape so frozen server components keep compiling. The old config moves to `src/lib/legacy-auth.ts` until the final removal commit. |
| `src/lib/api/handler.ts` (`withAuth`) | `auth()` then `prisma.user.findUnique`. Rate limit keyed on `session.user.id`. Anonymous flood bucket. | Verify Clerk token, lazy upsert, then rate limit keyed by the **local** user id. The `AuthenticatedUser` shape does not change, so no route changes. |
| `src/middleware.ts` | `auth()` from NextAuth. Protected pages redirect to `/signin`, auth pages redirect to `/dashboard`, onboarding checks call `/api/users/{id}` with the cookie. | `clerkMiddleware`. The onboarding check must use the local id, so it calls a new `GET /api/users/me` instead. |
| `src/app/api/auth/[...nextauth]/route.ts` | NextAuth handlers, plus the credentials login throttle. | Kept until the removal commit. Replaced by a small compat `GET /api/auth/session`. |
| `src/lib/login-throttle.ts` | Per-email and per-IP throttle for credentials login. | Removed in the final commit (Clerk owns password attempts). |
| `src/app/api/auth/register/route.ts` | Creates a user with a bcrypt hash. | Removed in the final commit. |
| `src/lib/rate-limiter.ts` | `clientIp`, `consumeSafely`, `enforceRateLimit` keyed on user id or IP. | No change needed except that the id is now the local id resolved after the upsert. |
| `prisma/schema.prisma` | `User.passwordHash`, `Account`, `Session`, `VerificationToken` (adapter tables). | Add `User.clerkId`. Adapter tables and `passwordHash` are not dropped on this branch (see section 6). |
| `prisma/seed.ts` | Upserts demo users with a bcrypt hash and `isEmailVerified`. | Demo users stay as legacy rows (`clerkId` null) and are linkable, see section 5. |
| `package.json` | `next-auth`, `@auth/prisma-adapter`, `bcryptjs`. | `next-auth` **stays installed**: frozen client components import `next-auth/react`. |
| `.env.example`, README, `docs/API.md`, `docs/FRONTEND_CONTRACT.md`, `PRODUCT.md`, CI workflow | Mention `NEXTAUTH_SECRET`, session cookie, register route. | Updated in Phase 1. |

### Tests

| Where | What it does today | Plan |
| --- | --- | --- |
| `tests/integration/helpers.ts` `registerAndLogin` | Calls `/api/auth/register`, does the CSRF dance and credentials login, reads `/api/auth/session`. Used by 14 test files. | Rewritten: creates a real Clerk user with the Backend API, mints real session tokens, sends them as a bearer token. Signature and return shape (`{ jar, userId }`, `userId` = local id) are unchanged. |
| `tests/integration/global-setup.ts` | Polls `/api/auth/csrf` for readiness and to detect an occupied port. | Polls a route that exists after migration. Also generates a per-run webhook secret and deletes leftover Clerk test users at teardown. |
| `rate-limit.test.ts` (3 of 6 tests) | Drives credentials login and `/api/auth/register` directly. | These test code that the final commit removes. They pass unchanged until then. See the accounting under section 6. |
| `no-secret-leaks.test.ts` | Hits `/api/auth/register` and `/api/auth/session`. | Passes unchanged until the removal commit (the compat session route stays). |

### Frontend (read only, not edited)

Listed in [Frontend files that need changes](#frontend-files-that-need-changes).

---

## 4. Design

### 4.1 Schema

- `User.clerkId String? @unique`: nullable for legacy and seeded rows. Requires `npm run db:push`.
- `User.deletedAt DateTime?`: set when the Clerk account is deleted (section 4.5). Requires `npm run db:push`.

No other model changes.

### 4.2 Request authentication (`withAuth`)

1. Verify the session token from the request (`Authorization: Bearer` or the `__session`
   cookie) with the Clerk backend SDK. This checks signature and expiry against the instance keys.
   No header set by middleware is trusted. Not signed in gives the existing anonymous flood
   bucket and `401`.
2. Resolve the local user: by `clerkId`; on a miss run the lazy upsert (4.3).
3. Rate limit keyed by the **local user id** (never the Clerk id, never an IP).
4. Refuse with `401` if the row is tombstoned (`deletedAt` set). Then the role check and the
   handler run with the same `AuthenticatedUser` shape as before.

### 4.3 Lazy upsert (race safe)

On a miss by `clerkId`, fetch the user from Clerk (`sub` from the token) and:

1. Choose the email: the primary email address **only if Clerk marks it verified**.
2. Look for a local row with that email and `clerkId` null. If found, **link** it (set `clerkId`).
   Linking happens only on a Clerk-verified email, so nobody can claim a legacy account by
   typing its address.
3. If the email belongs to a row already bound to a **different** `clerkId`: do not link and do
   not overwrite. Answer `409` and write an audit event. (Reachable only if a webhook was missed.)
4. Otherwise create the row (username rule in 4.4).
5. Idempotence and races: the write is a single guarded operation. Two simultaneous first
   requests for one Clerk user both reach the unique constraints on `clerkId` / `email` / `username`;
   the loser catches the constraint error, re-reads by `clerkId` and continues. No request
   fails because another request won the race. A transaction-scoped advisory lock keyed on the
   `clerkId` serialises the two writers so the loser's read sees the winner's row.
6. A Clerk user with **no verified email** gets a row with a deterministic placeholder email
   (`clerk_<id>@no-email.invalid`), `isEmailVerified` false, and is never linked to anything.

Create-time side effects match today's behaviour: an `AuditEvent` `USER_CREATED`, `lastActiveAt`,
and verification bookkeeping (4.6).

### 4.4 Username rule (collision handling, never fails the request)

`User.username` is copied from the Clerk username, lowercased.

1. If no other local row has it: use it.
2. If taken by another local row: `<base>_<suffix>` where `suffix` is the first 6 characters of
   the Clerk id after `user_`, lowercased. `base` is truncated so the result is at most 30 characters.
3. If that is also taken: extend the suffix by 2 characters at a time up to the full id, then stop.
   Given a Clerk id and a database state the result is deterministic.
4. If Clerk has no username (should not happen with "required"): base is the email local part
   reduced to `[a-z0-9_]`, or `user` if empty, then the same steps.

On `user.updated`, a **username change in Clerk is applied** through the same rule (only when the
new name is free or already ours; it never takes another user's name).

### 4.5 Webhook route (`POST /api/webhooks/clerk`)

- Verifies the Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) over the **raw body**
  with `CLERK_WEBHOOK_SECRET`. Refuses with `400` on any failure and with `503` when the secret is
  not configured (fails closed, never processes unsigned input). The signature check rejects
  timestamps outside a five minute window.
- Handles `user.created`, `user.updated`, `user.deleted`; every other event type answers `200` and is ignored.
- **Replay and ordering:** the payload is treated as a change notification, not as the source of
  truth. For created/updated the handler re-fetches the user from Clerk and applies the current
  state, so a replayed or reordered old event cannot roll state back. Handlers are idempotent.
- The route is in the middleware matcher exclusions and unauthenticated by design; its only
  credential is the signature.
- **`user.deleted`: tombstone, never delete.** Foreign keys cascade across 57 relations, so
  `prisma.user.delete` would erase the person's projects, teams, messages and endorsements for
  everyone else. Instead: set `deletedAt`, clear `clerkId`, replace email with a unique
  placeholder, clear personal fields (name, image, bio, headline, location, links, `passwordHash`),
  rename the username to `deleted_<local id suffix>`, and delete `Account` / `Session` rows. Content
  stays and is attributed to the anonymised profile. Tombstoned users are excluded from discovery
  surfaces and refused by `withAuth`. Because the email is replaced, a later sign-up with the
  same address creates a **fresh** account, not a resurrection of the old one.
  This is a product decision recorded here; say if you want hard deletion or content removal instead.

### 4.6 Verification level

- Verified primary email gives `isEmailVerified` true and `verificationLevel` at least `EMAIL`.
- Never downgrades: the level only moves up (same rank table as the old `signIn` event).
- A connected GitHub external account keeps the existing bump: a `Verification` row of type
  `GITHUB` marked `VERIFIED`, `githubConnected` true, and level at least `GITHUB`.
- Phone data from Clerk is ignored.

### 4.7 Compat surface for the frozen frontend

- `@/lib/auth` keeps exporting `auth()` with the old session shape (`user.id` is the **local** id).
- `GET /api/auth/session` returns `{ user: { id, name, email, image, role }, expires }` or `null`,
  so `useSession()` consumers keep rendering (name, avatar, onboarding) while `SessionProvider` is still mounted.
  Temporary: delete it when the UI moves to Clerk hooks.
- `GET /api/users/me`: the caller's local profile summary, for middleware and for the future UI.

---

## 5. Seed users

Seeded demo users are inserted as **legacy rows**: `clerkId` is null. That is their marker.
There are two ways for one to become usable:

1. **Link by verified email.** Anyone who signs up in Clerk with the demo email and verifies it is
   linked on first request (4.3). The seeded addresses are not real mailboxes, so nobody can verify them.
2. **`npm run db:seed:clerk`** (Phase 1): an opt-in script that creates the matching Clerk users
   with the Backend API using the documented demo password and stores `clerkId`, so the demo
   accounts can sign in through Clerk. Idempotent, and refuses to run against a production key.

---

## 6. Removal of NextAuth-specific code (separate final commit)

Proposed and implemented as the last commit on the branch so it can be reviewed, or dropped, alone:

- Remove `POST /api/auth/register`, `src/lib/login-throttle.ts`, `src/lib/legacy-auth.ts` and the
  `[...nextauth]` handler (the compat `GET /api/auth/session` remains).
- Remove `@auth/prisma-adapter` and `bcryptjs` from `package.json`. `next-auth` **stays** while the
  frontend imports `next-auth/react`.
- Stop writing `passwordHash` in the seed.
- **Not** dropped on this branch: `User.passwordHash` and the `Account` / `Session` /
  `VerificationToken` tables. Dropping them is data-destroying and needs your explicit
  `db push --accept-data-loss` once every user is on Clerk.

Effect on tests. Four tests in `rate-limit.test.ts` exist only to test what the last commit
deletes: credentials-login throttling, a bystander check that depended on it, and the two
`/api/auth/register` limiter tests; and `no-secret-leaks.test.ts` probed the register route. Before
that commit every pre-existing test passed through the new Clerk harness with one exception: the
endorsement reward tests assumed a fresh account is unverified, which a Clerk account (email
verified) is not, so their setup now resets the row explicitly. In the removal commit the four tests
are replaced by three anonymous flood-bucket tests (keeping the forged `X-Forwarded-For`
guarantee), the register probe is dropped, and a `/api/users/me` leak probe is added.

---

## 7. Testing without driving Clerk's UI and without a bypass

No auth bypass is added anywhere in application code. The harness:

1. Creates a real user on the development instance with the Backend API (`email`, `username`,
   random strong password, fictional phone only if the instance still demands one).
2. Creates a real session and mints real 60 second session tokens for it, refreshing before expiry.
3. Sends the token as `Authorization: Bearer`, the path Clerk documents for testing. The
   server verifies it exactly as it would a browser token.
4. Deletes every user it created at teardown, and sweeps stragglers left by a crashed earlier run.
5. Sets a per-run random `CLERK_WEBHOOK_SECRET` on the spawned server only, so webhook tests sign with
   a secret that never existed outside that process.

Costs to be aware of: the suite now needs network access and the Clerk secret key, and a dev
instance has a user cap and Backend API rate limits (the harness retries on `429`).

---

## 8. Open items that need you

1. **`npm run db:push`** against every database this branch will run on: it adds `User.clerkId`
   (unique, nullable) and `User.deletedAt`. Nothing is dropped.
2. **Clerk dashboard, phone number.** The instance no longer requires a phone number (section 2
   is now historical); the harness does not use phone numbers.
3. **Clerk dashboard, webhook.** Add an endpoint `https://<your host>/api/webhooks/clerk`
   subscribed to `user.created`, `user.updated` and `user.deleted`. Copy its **Signing secret**
   (starts with `whsec_`) into `CLERK_WEBHOOK_SECRET`. Locally, expose the dev server with a
   tunnel first. Without the secret the route answers `503`. Without the webhook everything still
   works (rows are created on first request); only renames and deletions in Clerk would not be
   picked up.
4. **Production settings:** set `CLERK_AUTHORIZED_PARTIES` to your app's origin(s) and
   `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app.
5. **CI:** add `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (development instance)
   as repository secrets, or the integration job is skipped with a warning.
6. **Frontend wiring** (frozen here): the table below. Until then the sign-in and sign-up pages do
   not work.
7. **Product decisions taken on your behalf, easy to reverse:** a deleted Clerk account is
   anonymised, not erased (section 4.5); linking a legacy account clears its password hash and
   OAuth accounts (section 9).
8. **Later:** upgrade Next to 14.2.35 as its own change (the middleware bypass, section 1), then
   move to a current `@clerk/nextjs`; drop `User.passwordHash` and the NextAuth tables once every
   user is on Clerk (needs `db push --accept-data-loss`, so it is yours to run); and remove
   `next-auth`, `GET /api/auth/session` and `src/types/next-auth.d.ts` when the UI uses Clerk's hooks.

## 9. What was built, and what the live runs changed

Everything here was run against a real Clerk development instance with real users and real
60 second session tokens; no application-side bypass exists.

**Deviations from the design above, each found by running it:**

- **`verifyToken` returns claims and throws.** In `@clerk/backend` 1.x the exported function is
  wrapped that way, although its declared type suggests `{ data, errors }`. A first attempt that
  satisfied the type checker with a cast made every valid token look anonymous; the first live run
  caught it.
- **Junk tokens cost a Clerk API call each.** The SDK re-fetches the signing keys for any unknown
  key id before checking anything else (measured 80 to 200 ms each), so anonymous callers could
  exhaust the Backend API rate limit that sync and the webhook share. `src/lib/jwks-guard.ts`
  keeps the set of real key ids, refreshes it at most once a minute, and refuses other tokens without
  calling the SDK. Mutation checked: 25 junk requests took 4.9 s without it, about 1 s with it.
- **Linking clears the old credentials.** Someone who pre-registered a victim's address with a
  password would otherwise keep access after the victim linked the account. Linking now sets
  `passwordHash` to null and deletes the row's OAuth accounts and sessions.
- **Clerk cannot hold the seeded identities as they are.** It rejects the reserved `.test` TLD
  (the demo emails) and dots in usernames (`fatima.pm`). `db:seed:clerk` maps to
  `demo.skilldating.example.com` addresses and dot-free usernames; the seed data is unchanged (a
  changed domain would have duplicated users in an already-seeded database), and a name that
  differs from Clerk's only by such characters is not renamed on first sync.
- **Tombstoned users are hidden through `blockedUserIds`**, which every list and search surface
  already used, rather than a new mechanism. The dashboard page (frozen) reads Prisma directly and
  does not use it, the same existing gap as for blocks.
- **`next build` failed twice with a `next/font` Google Fonts error** during this work, unrelated to
  auth (`main` built fine in a separate checkout, and three later builds of this branch passed).
  If it appears, retry. The build has no Edge-runtime warnings any more, and needs no Clerk
  variables.

**Known limits, accepted:** a revoked or banned Clerk session stays valid until its token expires
(about 60 seconds), because verification is networkless; `CLERK_AUTHORIZED_PARTIES` unset skips the
authorized-party check; the `__session` cookie is `SameSite=Lax`, the same posture the old session
cookie had.

**Tests.** Unit: 85 (was 55 before the migration: 12 username, 8 webhook handler, 9 key guard, the
rest existing). Integration: see the count in the final report; 18 are new and cover the whole
Clerk path (`tests/integration/clerk-auth.test.ts`). The three tests of credentials login and
registration throttling, and the register probe in `no-secret-leaks`, were removed with the routes
they tested; anonymous flood-bucket tests (including the forged `X-Forwarded-For` guarantee) and a
`/api/users/me` leak probe replace them.

## Frontend files that need changes

None edited on this branch. When you wire the UI:

| File | Uses | Change needed |
| --- | --- | --- |
| `src/components/providers.tsx` | `SessionProvider` from `next-auth/react` | Wrap in `ClerkProvider`; drop `SessionProvider` once the files below stop calling `useSession`. |
| `src/app/(auth)/signin/page.tsx` | `signIn('credentials' \| provider)` | Replace the form with Clerk's `<SignIn />` (or custom flow). |
| `src/app/(auth)/signup/page.tsx` | `POST /api/auth/register` then `signIn('credentials')` | Replace with `<SignUp />`; `/api/auth/register` is gone after the removal commit. |
| `src/app/(auth)/error/page.tsx` | NextAuth error page | Likely delete: no NextAuth error redirects remain. |
| `src/components/navigation/NavMain.tsx` | `useSession`, `signOut({ callbackUrl })` | `useUser` and `useClerk().signOut`. |
| `src/components/navigation/MobileNavigation.tsx` | `useSession`, `signOut` | Same. |
| `src/components/command-palette/CommandPalette.tsx` | `useSession` (truthy check only) | `useAuth().isSignedIn`. |
| `src/app/onboarding/page.tsx` | `useSession().data.user.id` as the **local** id in `/api/users/{id}/skills` | Get the local id from `GET /api/users/me` (Clerk's `user.id` is not the local id). |
| `src/app/(dashboard)/layout.tsx` | `auth()` from `@/lib/auth` | Works unchanged through the compat `auth()`. Optional cleanup later. |
| `src/app/(dashboard)/dashboard/page.tsx` | `auth()`, then Prisma reads directly | Works unchanged. Note: it still bypasses block rules (existing issue, unrelated to auth). |

Until those changes are made, **signing in through the app's UI does not work on this branch**
(the credentials provider and its forms are what the migration replaces). API access with a Clerk session token does.
