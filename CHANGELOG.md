# Changelog

What changed, stage by stage. The newest stage is first. Each stage was built on its own branch and merged into `main` once its tests were green; the dates are the days
the work landed. Behaviour is described in the documents under [docs/](docs/); this file only says what arrived and why it matters.

## Stage 1H: seed, performance, API contract, CI and polish (2026-10-23)

- **Halves is off at launch.** The romance mode answers `503 ROMANCE_PAUSED` on every route until it is explicitly opened (the flag `romance.enabled`, or a city's flag), and
  appears nowhere else: not in the notification settings, the consents, the search, the onboarding data or the contract. `POST`/`DELETE /api/romance/interest` records
  "tell me when it opens" for adults, with their country and city; the admin metrics show the interest by city and as a share of adult actives; opening the mode tells the
  people who asked, once.
- **Cards for people who were minors.** Turning 18 does not publish a card: an account that was under 18 at any point keeps `showCardsOnWeb` off until the person turns it on, and
  is told once, on the 18th birthday in their own time zone, what the switch is.
- **A world to demo.** `npm run seed` builds a deterministic, idempotent world of about 400 builders in twelve cities (or 10,000 with `--scale`), through the real domain
  functions; `npm run seed:demo -- --username <name>` makes a polished demo account.
- **Performance.** The hottest queries were measured with `EXPLAIN ANALYZE` at 10,000 users, the missing indexes were added, read-heavy `GET`s carry private caching headers and
  ETags, and `docs/PERFORMANCE.md` has the before and after. A load script (`npm run load`) drives the busiest endpoints against a preview deployment.
- **An API contract.** `docs/openapi.json` (OpenAPI 3.1, built from the Zod schemas and the response types), served at `GET /api/openapi.json` to admins and in development; a
  test fails when a route and the spec disagree. A typed client in `src/lib/api-client`. `docs/FRONTEND_CONTRACT.md` is rewritten as one section per page.
- **CI and docs.** Workflows for typecheck, lint, unit, build and migration drift on every push, and for the full integration suite on pull requests to `main` and nightly. A
  pitch-grade README, this changelog, and `docs/LAUNCH_CHECKLIST.md`.

## Stage 1G: reach and retention (2026-10-22 to 2026-10-23)

- Notification delivery by email and web push behind adapters with in-memory twins: a channel policy per kind, quiet hours by the person's time zone, limits, de-duplication,
  signed one-click unsubscribe, bounce and complaint handling, and the daily and weekly digests (account mail, on by default). Time-critical kinds (a spark, a match, a squad
  invitation, the last squad reminder, an account notice) are dispatched the moment they are written; the three-minute sweep is the fallback.
- Universal search over people, projects, crews, hackathons and posts with PostgreSQL full-text and trigram matching behind a provider interface.
- Share cards (OG images) for passports, posts, squad recaps and achievements: brand-neutral, with a "show my cards on the web" switch (adults only) and versioned addresses
  (`GET /api/og/link`) so an edit is a new URL while the long cache stays.
- Sentry through the official SDK when `SENTRY_DSN` is set, with personal data scrubbed.
- Admin metrics with every definition in one place: the north star (weekly active shippers), activity, retention cohorts, activation, matching, feed, squads, notifications,
  safety and growth by place, a nightly job, a CSV export.
- Invite codes (personal and campaign) with an XP reward that cannot be farmed, a public yes-or-no check for the sign-up page, and verified campus chapters whose e-mail
  addresses are kept only as a keyed hash.
- A suppressed e-mail address is stored only as a SHA-256 of the normalised address.

## Stage 1F: safety, privacy and security (2026-10-21)

- A request gate in front of every authenticated route: banned and suspended accounts, kill switches, feature restrictions set by moderation, stale consent, and a write limit
  for high-risk accounts.
- Moderation: a prioritised report queue, moderator actions with notices, appeals, reversible actions, and an audit log. Content screening of messages, posts, comments and
  openers (link spam, contact details, repeats, banned terms).
- Integrity: nightly collusion-ring detection and a reversible risk score per user that reduces reach.
- Privacy: consent records for the terms, the privacy notice, the romance mode and marketing; a data export as a job; account deletion with a field-by-field inventory of what is
  kept, anonymised or removed.
- Media safety: romance photos and avatars stay pending until a scan clears them, and fail closed in production. Security headers with a nonce-based CSP, and an audit of every
  API route.

## Stage 1E: squads (2026-10-19 to 2026-10-20)

- Hackathons gain tracks, a submission deadline, a mode and a place; external hackathons are added by link by trusted accounts, deduplicated by the normalised link, through a
  fetcher that only talks to the public web.
- Structured role slots on teams, squad strength against a role template with gaps, the looking-for-group board, the solo pool with automatic squads two days before
  registration closes, and the squad builder that proposes a complete squad around the caller.
- Commitment pledges, private peer reviews, a members-only team space with a countdown and open slots, refill suggestions when a slot reopens, organiser CSV exports, and the
  squad rewards (a filled slot, a submitted squad, reliable teammates).

## Stage 1D: the Ship Feed (2026-10-18)

- Ship posts (SHIP, UPDATE, DEVLOG, DEMO) with the one ship gate, Props with stored weights, comments, follows and project watches.
- The feed: ranking v1 over a cached window, at most two posts per author per page, an opaque cursor, a tab per audience.
- Ship Day (Friday): a tag, a weekly quest, a recap, and a counter.
- Coalesced notifications: one notification stands for several events inside an hour.

## Stage 1C: matching, then age policy and the romance mode (2026-10-17 to 2026-10-18)

- Matching profile and quiz, a pure compatibility score with components and at most three human-readable reasons, daily drops generated hourly in batches per time zone,
  sparks and matches with opener-quality checks, the team gap finder, the weekly second look.
- The platform age policy: a date of birth is required, under 16 is refused, 16 and 17 are minors, 18 and over are adults. Phone verification synced from Clerk.
- The romance mode ("Halves" in the interface, `romance` in the code): its own profile with private filters, a weekly drop, sparks and matches, a mutual photo reveal, Duo,
  built on a storage adapter and presigned media uploads. Its separation from every professional surface is enforced by a source-scan test.

## Stage 1B: gamification (2026-10-16 to 2026-10-17)

- Streaks with freezes, the season stamp and the rewards envelope reporting level-ups, tier-ups, achievements and streaks.
- Event-driven achievements (47) and quests with rarity and periods, leaderboards by global, country, city, campus and crew for the week, month, season and all time, built
  without drift, cosmetics earned only, season rollover with end-of-season rewards, the player card, the heatmap.
- The trusted-counterparty rule that gates every peer-driven reward.
- UTC database sessions; a progression simulator that plays four kinds of user against the real rules.
- `npm run postdeploy`, which checks the environment and the leaderboards.

## Stage 1A: platform foundations (2026-10-15)

- The event bus and the rewards engine (`grant()` is the only writer of XP; a build step fails otherwise), the level curve and tiers, entitlements, feature flags, analytics
  events, structured logging with request ids, `Idempotency-Key` on creating routes, cursor pagination on every list.
- Validated environment, adapters with in-memory twins for Redis, jobs, realtime and storage.

## Phase 0: the product, the identity layer and the upgrade (2026-09-28 to 2026-10-14)

- The product core: profiles, skills with evidence and endorsements, projects with updates and milestones, teams and applications and invitations, hackathons with results,
  connections, messaging with read receipts and reactions, blocks, reports, the discovery ranking, the leaderboard, the achievements.
- API conventions: the `{ error: { code, message } }` contract with an enumerated catalogue, rate limiting on a shared cache, an integration suite against a real server and a
  real database.
- Authentication moved from NextAuth to Clerk, with a webhook, a lazy sync of users and a migration for legacy accounts.
- Upgrades: Next.js 14 to 15.5 and React 19; migrations from a baseline, with a drift check in CI; self-hosted fonts.
