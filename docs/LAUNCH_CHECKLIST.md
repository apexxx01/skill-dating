# Launch checklist

Everything that must be true before the product is open to the public, and how to check that it is. Nothing here is a statement that it already is: the software is complete and tested against
in-memory twins of every provider, and **none of the providers below has been exercised with real credentials by this repository**. Tick a box only after doing the check on the
production (or production-like, `VERCEL_ENV=production`) environment, and write the date and who did it next to it.

The checks use only what the product already has: `GET /api/health`, `npm run postdeploy`, the admin API (`/api/admin/*`), and the providers' own consoles. [DEPLOY.md](DEPLOY.md) has the procedures
(order of deploy, backups, rotation, kill switches); this file is the gate.

Contents: [Providers](#1-providers-real-and-smoke-tested) · [Identity](#2-identity-and-the-edge) · [Data](#3-data-and-recovery) · [Legal](#4-legal-reviews) · [Safety operations](#5-safety-operations) ·
[The release](#6-the-release) · [Left to the frontend phase](#7-left-to-the-frontend-phase) · [Turning on Halves (post-launch)](#turning-on-halves-post-launch)

## 1. Providers: real and smoke-tested

Boot refuses a production start without Upstash, Inngest, Ably and the Clerk webhook secret. The others do not stop the server (mail goes to an in-memory outbox, pushes are recorded and not
sent, uploads are refused, and avatars and romance photos are refused without a scanner), but they are **reported**: the startup log carries a boxed warning listing each missing provider, and in production
`GET /api/health` answers `status: "degraded"` with `missingProviders` naming them. **The first check of this section: `GET /api/health` on production says `"status": "ok"` and `"missingProviders": []`.** The checks below prove each provider
really works, which a configured key does not.

| ☐ | Item | How to verify |
| --- | --- | --- |
| ☐ | **No provider is reported missing** | `GET /api/health` → `status: "ok"`, `missingProviders: []` (no `email`, `push`, `storage`, `media-scanning`, `error-reporting` or `receipt-signing`), and no `WARNING: ... providers are not configured` block in the startup log of the production deployment. |

| ☐ | **Upstash Redis** holds rate limits, boards and the flag cache | `GET /api/health` → `checks.cache.provider` is `"upstash"`, not `"memory"`. Send more requests in a minute than a limited route allows (60 for the leaderboard, for example) from one session: the next one is `429` with `Retry-After`, and the count is shared when the app runs on more than one instance. `npm run postdeploy -- --production --dry-run` ends without a warning about the cache. |
| ☐ | **Inngest** runs the scheduled work | `GET /api/health` → `checks.jobs.provider` is `"inngest"`. In the Inngest dashboard the app is synced (`/api/inngest`) and lists every function in `src/lib/infra/jobs.ts`; run one by hand (`POST /api/admin/jobs/metrics/snapshot`, or any name from the list) and see the run complete. Confirm the next scheduled `notifications/deliver` (every 3 minutes) shows in the run history. |
| ☐ | **Ably** delivers realtime | `GET /api/health` → `checks.realtime.provider` is `"ably"`. `POST /api/realtime/token` returns a `tokenRequest` with your app's `keyName` (not the unsigned stand-in). With two accounts in two browsers: one sparks the other's drop after the second sparked first; `match.created` arrives on `user:{id}` in the first within seconds. |
| ☐ | **Resend** sends mail, and bounces come back | `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`, `RESEND_WEBHOOK_SECRET` set; the sending domain has SPF, DKIM and DMARC passing in the Resend dashboard. Make a test account and trigger a notification that mails (a squad invitation, or `POST /api/users/me/export`): the message arrives, looks right, and its unsubscribe link works without a session. Create an account whose address is Resend's bounce test address (`bounced@resend.dev`), send it something: `GET /api/notifications/channels` for that account shows `email.undeliverable: true` (the webhook at `/api/webhooks/email` works). |
| ☐ | **Unsubscribe links** survive a key rotation | `NOTIFICATION_SIGNING_SECRET` is set to its own random value (32+ characters), not derived from the Clerk key. Check: the same unsubscribe link still works after you rotate `CLERK_SECRET_KEY` on a preview. |
| ☐ | **Web push** (VAPID) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` set; `GET /api/notifications/push` → `configured: true`. In a real browser (Chrome and Safari 16.4+), once the interface has its service worker: subscribe, trigger a push (a spark), see it arrive with the app closed, tap it, and see the open recorded (`delivery_open_rate` in the admin metrics moves). Until the service worker exists in the interface this cannot be completed: it is a launch blocker for push, not for the rest. |
| ☐ | **Object storage** accepts uploads from browsers | `STORAGE_*` set; the bucket has a CORS rule allowing `PUT` from the app's origin with `Content-Type`; versioning on, export prefix excluded ([DEPLOY.md](DEPLOY.md#backups-and-restore)). `POST /api/media/uploads`, `PUT` the returned URL from a browser on the real origin, `POST /api/media/{id}/complete`: no CORS error, and the object appears in the bucket. Without the settings production answers `503 STORAGE_UNAVAILABLE`. |
| ☐ | **Media scanning** is live (avatars and romance photos fail closed without it) | `MEDIA_MODERATION_URL` and `MEDIA_MODERATION_TOKEN` set. Upload an ordinary photo: `status` becomes `READY`. Upload the provider's documented test image for a blocked verdict: `BLOCKED`, and the object is deleted at once. Stop the provider (or set a wrong token on a preview): the upload answers `503 MEDIA_SCANNING_UNAVAILABLE`, never `READY`. Test the one a human reviewer would see: an `IN_REVIEW` verdict appears in the admin queue. |
| ☐ | **Sentry** receives errors, scrubbed | `SENTRY_DSN` set (and `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` in the **build** environment for source maps). From a preview with the DSN, cause one server error (a branch with a deliberate throw in a scratch route) and see the event in Sentry with a readable stack, the release, and the request id. Open it: no email address, IP, cookie, authorization header, token or user-written text. |
| ☐ | **Product analytics** (optional) | If `POSTHOG_KEY` is set, events from a test session appear in PostHog; events are stored in the database either way. |
| ☐ | **Receipt signing keys** are generated, stored and live | One Ed25519 key per environment, generated as in [DEPLOY.md](DEPLOY.md#receipt-signing-keys), kept in the platform's secret store only (not in the repository, not shared with a preview). `GET /api/health` → `evidence.signing: "configured"` with the expected `kid`, never `"fixture"` or `"unsigned"`; `GET /api/receipts/keys` lists that kid as `active` and no other. If production ever ran without a key, `POST /api/admin/jobs/receipts/sign-backlog` reports the receipts it signed. Verify one real receipt with the script in [PROOF.md](PROOF.md#verifying-a-receipt-offline) on a machine that is not the server. Write down who holds the key and the rotation date. |
| ☐ | **GitHub access** for the evidence engine (optional token) | Optionally set `GITHUB_TOKEN` (a fine-grained token with no repository permissions, public data only): `GET /api/health` → `evidence.github: "server-token"`. With a test account that signed in with GitHub and gave the GITHUB_SYNC consent, `POST /api/github/sync`, then `GET /api/github`: `sync.status` is `DONE`, `sync.authMode` is `user-oauth`, and its repositories have strength and receipts. The receipt page (`GET /api/receipts/{id}`) opens signed out. |
| ☐ | **Clerk webhook** is delivered and verified | `CLERK_WEBHOOK_SECRET` set (boot requires it); in the Clerk dashboard the endpoint `/api/webhooks/clerk` shows recent deliveries with `200`. Sign up a test account and see its local row; delete it and see it tombstoned. |

## 2. Identity and the edge

| ☐ | Item | How to verify |
| --- | --- | --- |
| ☐ | **The Clerk secret key that was exposed in development is rotated**, in **both** the development and the production instances | Procedure and reasoning: [DEPLOY.md](DEPLOY.md#secrets-rotation). Verify: a request to Clerk's Backend API with the old key answers `401`; Clerk's logs show no use of it after the rotation; the new key is in production, previews, CI (`CLERK_SECRET_KEY` repository secret) and each developer's `.env.local`; the Clerk audit log was reviewed for API use nobody recognises. |
| ☐ | The **production Clerk instance** is the one the production build uses | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` starts `pk_live_` in the production build (it is inlined at build time; a wrong one needs a rebuild). Sign-in methods (password, Google, GitHub) are enabled in that instance, and email verification is required. |
| ☐ | `CLERK_AUTHORIZED_PARTIES` lists the production origin(s) | The value is exactly the origins that mint session tokens; a token minted for another origin is refused (`401`). |
| ☐ | `TRUSTED_PROXY_HOPS` matches the proxies in front of the app | On Vercel this is `1`. Verify: two signed-out callers from different networks get separate rate-limit buckets (each can make its allowed requests; one flooding does not slow the other). With `0` they share one bucket, which is wrong for production. |
| ☐ | **Rate limits and the request gate** work on production traffic | Hit a limited route past its limit (`429` with `Retry-After`); the consent gate, suspension and kill switches answer as documented (a test account with a restriction set by an admin gets `403 FEATURE_RESTRICTED`). |
| ☐ | **Security headers and CSP** are on | `curl -I` the app and an API route: the headers of `SECURITY_HEADERS` in `next.config.js` are present, and pages carry the nonce-based `Content-Security-Policy` from `src/middleware.ts` (docs/SECURITY.md). The CSP allows the Sentry DSN host and the storage origin (uploads) and nothing broader. |
| ☐ | **Mail domain** is authenticated | SPF, DKIM, DMARC pass for `EMAIL_FROM`'s domain (Resend's domain page, or a mail-tester message); the From address can receive replies, or the mail says not to reply. |

## 3. Data and recovery

| ☐ | Item | How to verify |
| --- | --- | --- |
| ☐ | **Backups and point-in-time recovery are on** and **a restore has been practised** | Daily snapshots kept 30 days and PITR for 7 on the database host. Run the drill in [DEPLOY.md](DEPLOY.md#backups-and-restore): restore last night's snapshot and a point from the day before into a scratch database, run `npm run db:migrate:status` and the integration suite against it (`TEST_DB_BASE_URL`), and write down how long it took and what went wrong. Attach the write-up here. A restore nobody has practised is not a backup. |
| ☐ | **Migrations** are applied and agree with the schema | `npm run db:migrate:status` on production: up to date. CI's migration job is green on the release commit. |
| ☐ | **No seeded data** is in production | `SELECT count(*) FROM "User" WHERE email LIKE '%@seed.skilldating.test' OR email LIKE '%@demo.skilldating.test';` is `0`; the flag `seed.world` does not exist (`GET /api/admin/flags/seed.world` is `404`). The seed refuses to run when `NODE_ENV` or `VERCEL_ENV` says production, but a copied database is not covered by that. |
| ☐ | **Planner statistics** are fresh | After any bulk load or restore run `ANALYZE;`. Autovacuum is on. The indexes of [PERFORMANCE.md](PERFORMANCE.md) exist (`\di` on `"User"`, `"ShipPost"`, `"Project"`, `"Notification"`). |
| ☐ | **Retention jobs** run | The `privacy/retention` job (nightly 05:15 UTC) appears in the Inngest run history and deletes what [PRIVACY.md](PRIVACY.md) says it deletes (export files after 24 hours, answered romance interest after 180 days). |
| ☐ | **Data export and account deletion** work end to end on production | A test account: `POST /api/users/me/export` → notification → download works and expires; `DELETE /api/users/me` (with reverification) removes what [PRIVACY.md](PRIVACY.md) says and leaves what it says. |

## 4. Legal reviews

The documents describe what the software does. **Whether it is enough in each launch country is for counsel to confirm**, in writing, before the product is public there. Each of these is a
decision with an owner, not a code change; the code has the switch for each ready.

| ☐ | Item | What to confirm | How to verify |
| --- | --- | --- | --- |
| ☐ | **Age policy** | Under 16 refused; 16 and 17 as minors (country-only location, no cards, no romance, narrower discovery); 18+ full ([SAFETY.md](SAFETY.md)). Confirm the thresholds per launch country, and how age is established (a self-declared, write-once date of birth with admin correction). | Signed review per country on file. If a country needs a different threshold, it is `src/lib/age-policy.ts` and one migration, not a rewrite. |
| ☐ | **Privacy notice and consent per country** | Lawful bases, retention periods ([PRIVACY.md](PRIVACY.md) inventory), cross-border transfers (Clerk, Upstash, Ably, Resend, Sentry, PostHog, the storage region), the grievance officer or data-protection contact, the deletion and export promises. | Signed review per country; `src/config/legal-versions.json` points at the reviewed versions of the terms and privacy notice, and the consent screens show those texts. |
| ☐ | **Digests as account mail** | The daily and weekly digests are treated as account mail (on by default, no consent, one-click unsubscribe), not marketing. This is a legal position. | Written confirmation, or switch the default off (`DIGEST_DAILY` and `DIGEST_WEEKLY` in `src/lib/notify/policy.ts`) before launch. |
| ☐ | **Share cards default** | The cards show passport fields to the open web; the default for adults, and that it stays off for anyone who was ever a minor. | Written confirmation of the default (PRIVACY.md); the switch is `showCardsOnWeb`. |
| ☐ | **Retaining evidence of blocked uploads** | Some countries require keeping evidence of child sexual abuse material for the authorities for a set period; the product keeps only a hash, verdict and labels and deletes the object. | Counsel's written instruction; adjust the blocked-upload retention if required ([PRIVACY.md](PRIVACY.md)). |
| ☐ | **Romance photos and the mode itself** (before Halves opens, not before launch) | Sensitive data (gender, who the person is interested in), photos, the reveal, the 18+ rule, and any country where the mode is restricted. | See [Turning on Halves](#turning-on-halves-post-launch). |
| ☐ | **Moderation obligations** | Notice-and-action, reporting duties for child safety, appeals, record keeping, per country. | Written review; the queue, the appeal flow and `MINOR_SAFETY` escalation match it. |

## 5. Safety operations

| ☐ | Item | How to verify |
| --- | --- | --- |
| ☐ | **Every kill switch has a named owner** and the owner knows it | The seven switches in [DEPLOY.md](DEPLOY.md#kill-switches) (`kill.signups`, `kill.romance`, `kill.messaging`, `kill.posting`, `kill.external-hackathons`, `kill.squad-autoform`, `kill.notification-delivery`) each have a person (not a role name) written next to them in the incident channel's pinned message, with a deputy. |
| ☐ | **Each switch works in production** | In a maintenance window, for each switch: `PATCH /api/admin/flags/kill.<name> { "enabled": true }` → the affected route answers its code (e.g. `503 MESSAGING_PAUSED`) on a second instance within 30 seconds → `{ "enabled": false }` → it works again. The two audit entries are in `GET /api/admin/audit`. |
| ☐ | **Moderation is staffed** | At least two people with the `MODERATOR` role and two with `ADMIN` (`GET /api/admin/users?q=`); an agreed response time for the queue (`GET /api/admin/queue`) and for `MINOR_SAFETY` reports; someone is on call for the incident playbook ([SECURITY.md](SECURITY.md#incident-response)). |
| ☐ | **Appeals and data requests have an inbox** | A monitored address and an owner for appeals (`/api/appeals`), data requests the product cannot answer by itself, and legal notices. |
| ☐ | **Admin sessions are protected** | Admin accounts have two-factor authentication in Clerk; destructive admin actions answer `403 REAUTH_REQUIRED` on an old session. |
| ☐ | **Alerts exist** | Sentry alerts on new issue and on error rate; an uptime monitor on `GET /api/health` (it is `200` for `ok` and `degraded`, `503` for `down`; alert on `degraded` too); the Inngest failed-run alert. |

## 6. The release

| ☐ | Item | How to verify |
| --- | --- | --- |
| ☐ | **CI is green on the release commit**, including the integration workflow | The `CI` workflow (types, lint, unit, build, migration drift, API description) and the `Integration` workflow (the full suite against a production build) both pass on the commit that will be deployed. |
| ☐ | **`npm run postdeploy` has run** against production | `npm run postdeploy -- --production --dry-run`, then without `--dry-run`: it ends `Post-deploy finished: ...` with exit code 0, a season is running, leaderboards rebuilt, cosmetics granted ([DEPLOY.md](DEPLOY.md#what-npm-run-postdeploy-does)). |
| ☐ | **Performance holds on the real stack** | Run `npm run perf:load` against a preview deployment with a 10,000-person database (instructions in [PERFORMANCE.md](PERFORMANCE.md)); p95 under 200 ms for reads and 400 ms for writes. The 10,000-person numbers in that document were measured on a laptop against a local database, not on the hosting platform: this is where they become true or not. |
| ☐ | **The API description is current** | `npm run openapi:check` passes; `docs/openapi.json` is what the frontend builds against. |
| ☐ | **Halves is OFF in production** | `GET /api/admin/flags/romance.enabled` → `enabled: false`, empty `allowUserIds`; no `romance.city.*` flag is enabled; as an ordinary signed-in user `GET /api/romance/profile` answers `503 ROMANCE_PAUSED` and `GET /api/users/me/consents` has no `ROMANCE_MODE`. |
| ☐ | **Flags and settings are as intended** | `BIRTH_DATE_REQUIRED` is on (default); `ENTITLEMENTS_ENFORCED` is the intended value; `kill.*` are all off; `GET /api/flags` lists the product flags you expect. |
| ☐ | **A test account has walked the whole path** on production | Sign up with an invite link → onboarding (birth date, consent) → passport → first project and post → a spark and a match (second account) → report and block → export → delete. Every step answers as [FRONTEND_CONTRACT.md](FRONTEND_CONTRACT.md) says. |
| ☐ | **Rollback is known** | The previous deployment can be promoted; migrations are forward-only (a bad one is fixed by a new migration, [README](../README.md#database-migrations)); who decides, and in which channel. |

## 7. Left to the frontend phase

The backend cannot do these; the launch waits for them.

| ☐ | Item | How to verify |
| --- | --- | --- |
| ☐ | **The Sentry global error boundary** (`app/global-error.tsx`, plus the route error boundaries) reports render errors from the browser | Throw in a component on a preview with `NEXT_PUBLIC_SENTRY_DSN` set: the event reaches Sentry with the release and no personal data, and the person sees the error page with the request id. |
| ☐ | **The service worker** (`/sw.js`) handles `push` and `notificationclick` and reports taps | Section 1, web push. |
| ☐ | **Consent and age screens** show the reviewed texts, with unticked boxes and the write-once warning | Walk onboarding as a 15-year-old (refused), a 16-year-old (country only) and an adult. |
| ☐ | **Nothing about Halves is in the navigation, the landing page or the metadata** | Search the built app for the mode's name and its routes; only Settings → "Notify me" may mention it. |
| ☐ | **Each page handles the four states** (loading, empty, error with the request id, paused) | [FRONTEND_CONTRACT.md](FRONTEND_CONTRACT.md#conventions-that-apply-to-every-endpoint). |
| ☐ | **Accessibility and performance of the interface** | Outside this repository's tests: an audit of the real pages. |

---

## Turning on Halves (post-launch)

Halves is built and **ships closed**. Opening it is a separate decision, made later, **city by city**, never by a deploy. It is a sensitive mode (photos, sexual orientation and gender
preferences, 18+ only), so each of these must be true **for that city** before its flag is switched on. [ROMANCE.md](ROMANCE.md) has the rules of the mode and how the flags work.

| ☐ | Condition | How to verify |
| --- | --- | --- |
| ☐ | **Enough people asked for it, in that city** | The rule: **at least 250 interested adults in the city, and each side of the interested-in pairing is at least 30% of that pool.** Both numbers are the admin setting `romance.launch-threshold` (`{ "minInterestedAdults": 250, "minPairingSharePercent": 30 }`; read it with `GET /api/admin/settings`, change it with `PUT /api/admin/settings/romance.launch-threshold`, audited; it applies to every city, so change it for all or none, and write down why). **First half, measured:** the admin metrics `romance_interest` (`GET /api/admin/metrics`) have one row per city with `detail.meetsInterestThreshold` (1 when the city has at least `minInterestedAdults`; `romance_interest_share_of_adult_actives` gives the context). **Second half, not measured by the product:** the interest list holds only a country and a city, on purpose, so the balance of the pairing (who is interested in whom) is not in it and the city cannot be checked against `minPairingSharePercent` from the metrics. Evidence it another way and file it: a short, consented survey of the interested people in that city, or the allowlisted rehearsal below with staff and invited testers. Collecting gender or preference in the interest list would be a new use of sensitive data and needs the legal review of the next row first. A mode that opens to a handful of people, or to a pool where one side has no one to meet, is a worse first experience than waiting. |
| ☐ | **The media-scanning provider is live and tested** | Section 1. Romance photos are refused with `503 MEDIA_SCANNING_UNAVAILABLE` without it; verify a blocked verdict, a review verdict and an outage on production. |
| ☐ | **Legal review is done for that country** | Written sign-off covering: processing of gender and orientation (consent text in `ROMANCE_MODE`, its version in `legal-versions.json`), photos and the blurred reveal, the 18+ rule and how it is enforced (`isAdult`, no minors in any romance table or flow), retention and deletion on withdrawal, and any restriction on the mode in that country. |
| ☐ | **Moderation capacity exists** | A moderator on shift whose queue includes romance reports (target type `ROMANCE_PROFILE`); a response-time target for photo reviews (`IN_REVIEW`) and reports; the hidden-profile flow (`409 ROMANCE_PROFILE_HIDDEN`) is understood by the team; the appeal path for a romance restriction is staffed. |
| ☐ | **The interface for it is built and reviewed** | [Romance mode in the contract](FRONTEND_CONTRACT.md#14-romance-mode-halves-post-launch): eligibility steps, consent screen, private-filters section, photos, the weekly drop, reveal, Duo; the neutral notification wording is unchanged; nothing about it appears on any professional surface. |
| ☐ | **`kill.romance` has an owner who is reachable** | Section 5; the Trust & Safety lead can close it everywhere in one `PATCH`. |
| ☐ | **A rehearsal on staging** | `npm run seed -- --with-romance` creates 40 clearly synthetic adults on the allowlist (flag stays off); run a weekly drop, a spark, a match, a reveal and the withdrawal, and read what the notifications say. **Never run the seed in production.** |

Then, for each city that passes, in this order:

1. **Allowlist first.** Create the city flag with an allowlist of staff and invited testers (`POST /api/admin/flags { key: "romance.city.<country>-<city>", enabled: false, allowUserIds: [...] }`, for example `romance.city.in-pune`). The mode opens for those people only. Use it for a week; watch Sentry and the queue.
2. **Roll out a share.** `PATCH /api/admin/flags/romance.city.<country>-<city> { enabled: true, rolloutPercent: 10 }`, then 25, 50, 100, a day or more apart, watching reports per active user, photo `BLOCKED`/`IN_REVIEW` rates, `409 ROMANCE_PROFILE_HIDDEN` counts and the queue age. A rollout is a stable share of people, so nobody flickers in and out.
3. **Tell the people who asked.** Switching a launch flag queues the `romance/announce` job; each interested person in that city gets one neutral notification, once. Check in the Inngest run history that `romance/announce` ran, and that one interested test account received exactly one note and no second one on the next run.
4. **Stop conditions.** Pull `kill.romance` (closes it everywhere, at once, whatever else is on), or set that city's flag back to off, if reports, scanning or moderation capacity are not holding. Write down why. Leaving the mode (`DELETE /api/romance/profile`) and asking to be told keep working while it is closed.
5. **Only then the next city.** `romance.enabled` (everywhere) is the last step, if ever: it opens the mode for every city with no flag of its own.
