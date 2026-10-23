# Security

How the backend is defended, what is enforced where, and what to do when something goes wrong. Safety (abuse, moderation, minors) is in
[SAFETY.md](SAFETY.md); personal data is in [PRIVACY.md](PRIVACY.md); deploys, backups and secret rotation are in [DEPLOY.md](DEPLOY.md).

## Reporting a vulnerability

Write to **security@skilldating.app** (the address must exist before launch) with what you found and how to reproduce it. Please do not test against
other people's accounts or data, do not degrade the service, and give us 90 days before disclosing. We answer within two working days, keep you told
of progress, and credit you if you wish. A `/.well-known/security.txt` with this address is a launch item.

## Threat model (STRIDE)

| Threat | Where | Mitigation | Code |
| --- | --- | --- | --- |
| **Spoofing** a user | every API route | the Clerk session token is verified on every request (signature, expiry, authorized party, known signing key) before anything runs; middleware is never trusted | `src/lib/session.ts`, `src/lib/api/handler.ts` |
| Spoofing a webhook or a job | `/api/webhooks/clerk`, `/api/webhooks/email`, `/api/inngest` | Svix signature with a per-environment secret (Clerk's and Resend's); the Inngest signing key | `src/app/api/webhooks/clerk/route.ts`, `src/lib/infra/jobs.ts` |
| Account takeover by a squatted e-mail | first sign-in | a legacy row is linked only on an e-mail Clerk says is verified; the old credentials are removed | `src/lib/user-sync.ts` |
| Impersonation | usernames, display names | reserved names and look-alikes (homoglyphs, `rn`/`m`, digits) are refused; the verified-organisation mark only from an admin; impersonation reports go to the top of the queue | `src/lib/identity`, `src/app/api/admin/users/[id]/verification` |
| **Tampering** with someone else's data | routes taking ids | ownership and membership checked in the handler; another person's thing is "not found" | `src/lib/api/permissions.ts` and each route |
| Tampering with rewards | XP, Props, endorsements, reviews | one writer (`grant()`), unique keys, daily caps, the trust gate; collusion rings found nightly and down-weighted | `src/lib/rewards.ts`, `src/lib/trust.ts`, `src/lib/integrity` |
| Mass assignment | request bodies | Zod schemas, `.strict()` where it matters; every field bounded (the schema audit) | `src/lib/api/schema-audit.test.ts` |
| **Repudiation** | staff and sensitive actions | `AuditEvent` for moderation, role and verification changes, plan overrides, risk overrides, fraud reviews, consent, exports, deletion, admin lookups | `AuditEvent`, `GET /api/admin/audit` |
| **Information disclosure** | responses | private fields returned to their owner only (date of birth, romance filters, reliability, risk); blocked people look absent; a source-scan test pins who may name the date of birth | `src/lib/matching/privacy.test.ts`, `src/lib/romance/separation.test.ts` |
| Disclosure through logs and analytics | logs, PostHog, Sentry | ids only; sensitive-looking fields replaced; analytics props reduced to safe names | `src/lib/log.ts`, `src/lib/infra/analytics.ts` |
| Disclosure through the server's own fetches (SSRF) | external hackathon pages | the safe fetcher refuses private and loopback addresses at connect time, with a size and time cap | `src/lib/infra/page-fetch.ts` |
| Script injection (XSS) | posts, comments, pages | Markdown sanitised on the way in; a nonce-based Content-Security-Policy on pages; `nosniff` | `src/lib/posts/sanitize.ts`, `src/lib/security/csp.ts` |
| Clickjacking | pages | `frame-ancestors 'none'` and `X-Frame-Options: DENY` | `src/lib/security/static-headers.js` |
| **Denial of service** | every route | per-route rate limits, an anonymous limit per address, a body size cap before parsing, bounded fields and pages, jobs for heavy work | below |
| Abuse at sign-up | first sign-in | sign-ups kill switch, throwaway domains, a per-address limit on new accounts | `src/lib/identity/signup.ts` |
| **Elevation of privilege** | admin routes | `requiredRole` on every one (the route audit fails otherwise); moderators act on content and people, admins alone manage flags, plans, verification and roles; destructive actions need a recent sign-in; only an admin acts on a staff account; a moderator does not decide an appeal of their own action | `src/lib/api/route-audit.test.ts`, `src/lib/api/recent-auth.ts` |
| Middleware bypass (CVE-2025-29927) | pages | Next 15.5.27; no security decision is made in middleware; a test sends the bypass header to every route | `tests/integration/middleware-bypass.test.ts` |

## Authorization model

1. **Authenticated or public.** Every API handler is wrapped in `withAuth` except the explicit public allowlist: `/api/auth/session` (says whether a
   session is valid), `/api/health`, `/api/webhooks/clerk` and `/api/webhooks/email` (signed), `/api/inngest` (signed), the two signed links in emails
   (`/api/notifications/unsubscribe`, `/api/notifications/open/{token}`: an HMAC token is the credential, rate limited by address), the invite-code check for the sign-up page (`/api/invites/check`: yes or no only, 10 a minute per address) and the share cards and their address route (`/api/og/...`: public images and the versioned address of one, rate
   limited by address, with their privacy rules in `src/lib/og/data.ts`). `src/lib/api/route-audit.test.ts` parses every route file
   with the TypeScript compiler and fails on any other unwrapped handler; `tests/integration/route-authz.test.ts` calls every route anonymously against
   the running server and requires `401`.
2. **Roles.** `UserRole` is `USER`, `MODERATOR`, `ADMIN`.

   | What | USER | MODERATOR | ADMIN |
   | --- | --- | --- | --- |
   | The queue, report detail, actions on content and people, appeals, fraud signals, risk overrides | | yes | yes |
   | Find people by id or username | | yes | yes |
   | Find people by e-mail, see e-mail addresses | | | yes |
   | The audit log | | | yes |
   | Feature flags and kill switches, plans (entitlements), verification marks, roles, jobs | | | yes |
   | Act on a staff account | | | yes |

   Every admin route declares `requiredRole` (the route audit fails otherwise); the integration test calls each one as a signed-in member and requires
   `403`.
3. **Ownership and membership** are checked in the handler, on the row, every time (`src/lib/api/permissions.ts` and the domain modules).
4. **The request gate** (`src/lib/api/gate.ts`) runs after authentication and the role check, before the handler: bans and suspensions, kill
   switches, moderation's feature restrictions, re-consent, and the extra write limit of a HIGH risk account.
5. **Recent sign-in** for destructive actions (`src/lib/api/recent-auth.ts`): a ban, removing content, verification changes, plan overrides, role
   changes and deleting one's own account need a session whose first factor was verified in the last 10 minutes (Clerk's `fva` claim), or, when the
   token does not say, a session created in the last 10 minutes. Otherwise `403 REAUTH_REQUIRED` with `maxAgeMinutes`; the client signs in again
   (Clerk reverification) and retries.

## Rate limits

Each route sets its own limit (`withAuth(..., { rateLimit })`), keyed on the local user id (it cannot be forged or shared) or, before sign-in, the client
address as far as `TRUSTED_PROXY_HOPS` lets it be trusted. The route audit fails on a route without one, on two routes sharing a key, and on a limit
above its class's ceiling (`src/lib/api/rate-limit-classes.ts`):

| Class | Which routes | Ceiling per caller | Typical |
| --- | --- | --- | --- |
| Auth | first sight of a Clerk account; anonymous calls | 10 a minute per account; 120 a minute per address | |
| Sign-up | new accounts | 5 an hour per address (`SIGNUP_LIMIT`) | |
| Search | `GET /api/users`, `/api/discover`, `/api/projects`, `/api/teams`, `/api/builds`, `/api/hackathons`, `/api/leaderboard` | 60 a minute | 60 |
| Read | other `GET` routes | 120 a minute | 60 to 120 |
| Write | `POST`, `PUT`, `PATCH`, `DELETE` | 60 a minute | 10 to 30 |
| Toggle | marking a conversation read, ticking a checklist item, voting on an idea | 120 a minute | 120 |
| Admin | `/api/admin/*` | 60 a minute | 10 to 60 |
| HIGH risk | every write of an account with a HIGH risk level | 30 per 10 minutes, on top of the route's own | |

Some writes are far lower by design (reports 10 a minute, appeals 10 an hour, exports 5 a day, account deletion 5 an hour, external hackathons 10 an
hour, the squad builder 20 an hour). A refusal is `429 RATE_LIMITED` with `Retry-After`; running into limits is a signal of the risk score. On Redis the
counts are shared by every instance; without Redis (a preview) each instance counts on its own.

## Input limits

- **Body size.** Every body is read through `readBodyText` (`src/lib/api/handler.ts`): over 256 KB (`MAX_BODY_BYTES`) by the declared length or by what
  arrives is `413 PAYLOAD_TOO_LARGE` before parsing. Uploads never pass through the API (presigned URLs to the bucket). The Clerk webhook has its own
  1 MB cap.
- **Fields.** `src/lib/api/schema-audit.test.ts` parses the whole source with the TypeScript compiler and fails on any `z.string()` without a maximum
  (or a fixed format, or an anchored pattern without open-ended repetition), any `z.array()` without a maximum, and any `z.record()`, `z.any()` or
  `z.unknown()`. Free-form objects go through `boundedRecord` / `boundedJson` (`src/lib/api/limits.ts`), which cap their keys and size. The only
  exemption is the environment schema, written by the operator.
- **Pages.** Lists are paginated with a maximum page size; cursors are opaque and validated (`400 INVALID_CURSOR`).

## Headers

Sent on every response (`src/lib/security/static-headers.js`, through `next.config.js`): `Strict-Transport-Security: max-age=63072000; includeSubDomains;
preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation,
payment, USB and topics all off), `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`.

**Content-Security-Policy.**

- **API responses:** `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. An API answer is data, never a document.
- **Pages** (`src/lib/security/csp.ts`, set by `src/middleware.ts` with a fresh nonce per request, which Next puts on the scripts it renders):
  `script-src 'self' 'nonce-…' 'strict-dynamic'` plus Clerk's Frontend API and Cloudflare's bot check; styles from this origin (inline allowed, for the
  component library); images from this origin, `data:`, `blob:`, Clerk's image host and the storage bucket; connections to this origin, Clerk, Ably and the
  bucket; frames from Clerk and Cloudflare only; `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `upgrade-insecure-requests`.
- **The exception.** Next prerenders `/`, `/error`, `/onboarding` and the not-found page as static HTML, which cannot carry a per-request nonce. For those
  pages scripts are allowed from this origin and inline (`'unsafe-inline'`), with every other directive the same. Moving them to dynamic rendering (a
  frontend change) removes the exception; until then it is an open item.
- `tests/integration/security-headers.test.ts` checks all of it against the running server, including that the nonce in the header is the one on the
  page's scripts and changes on every request.

## Data handling

- **In transit:** HTTPS only in production (HSTS; the host terminates TLS). Database, Redis, Inngest, Ably and the bucket over TLS.
- **At rest:** the database and the bucket are encrypted by their providers; romance photos are private objects read only through short-lived signed
  URLs after the access rule; export files are private and deleted after 24 hours.
- **Secrets** come from the environment only, validated at boot by name and never echoed (`src/lib/env.ts`); nothing in the repository holds one
  (`tests/integration/no-secret-leaks.test.ts`).
- **Personal data:** see [PRIVACY.md](PRIVACY.md) for the inventory, retention, export and deletion.

## Dependencies

`npm audit --omit=dev` on Next 15.5.27 and React 19.3 (October 2026): **2 findings (1 high, 1 moderate), 0 critical**, both the PostCSS copy bundled
inside Next. The only fix the audit offers is Next 16, a major upgrade, so it is not taken here. Exposure: build time only; it processes this
repository's own stylesheets, never request input. Development-only findings (the test runner, the dev server's bundler, the CSS generator) never run in
the deployed server; details in [ARCHITECTURE.md](ARCHITECTURE.md#dependency-advisories).

## Incident response

1. **Detect.** Sentry errors, the health check, a report through the vulnerability address, a spike in reports or fraud signals, a provider's notice.
2. **Triage** (the on-call engineer, within 30 minutes): what is affected, is personal data involved, is it ongoing. Open an incident channel and a
   timeline document; one person leads.
3. **Contain.** The kill switches (`PATCH /api/admin/flags/kill.*`, [DEPLOY.md](DEPLOY.md#kill-switches)) stop sign-ups, the romance mode, messaging,
   posting, external hackathon submissions or automatic squads at once, without a deploy. Suspend or ban the accounts involved (`POST
   /api/admin/actions`). Rotate any credential that may be exposed ([DEPLOY.md](DEPLOY.md#secrets-rotation)). Revoke sessions in Clerk.
4. **Eradicate and recover.** Fix, deploy, and if data was damaged restore from a backup or a point in time ([DEPLOY.md](DEPLOY.md#backups-and-restore)).
5. **Notify.** A personal data breach goes to the supervisory authority within **72 hours** of becoming aware (GDPR Art. 33), to the Data Protection
   Board of India and each affected person under the DPDP Act and its rules, and to affected people without undue delay when the risk is high (GDPR Art.
   34). Counsel decides the wording; the audit log and the timeline are the evidence.
6. **Review** within a week: a written, blameless post-mortem with what will change.
