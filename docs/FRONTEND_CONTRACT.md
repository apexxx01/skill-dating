# Frontend Contract

One section per page: which endpoints it calls, the types that come back, the realtime channels it listens to, what to draw when there is nothing, while it loads and when it fails, and
the moments to celebrate. Build against this file and the typed client; use [API.md](API.md) for the long form of any route (bodies, limits, every error).

- **The machine-readable contract is `docs/openapi.json`** (OpenAPI 3.1, generated from the routes and their Zod schemas; `GET /api/openapi.json` serves it to administrators, and to any signed-in person in
  development). A test fails when a route and the spec disagree or when the file is stale, so the spec is never behind the code. Regenerate with `npm run openapi:build`.
- **The typed client is `src/lib/api-client`** (generated from that spec, `npm run openapi:client`). Use it instead of `fetch`: [The client](#the-client).
- Response types are exported from `src/types/api.ts` (dates are ISO strings on the wire). Where this file says "type `X`" it means that export.
- `tests/integration/frontend-contract.test.ts` fetches the main shapes from a running server and fails if a promised key disappears.
- **Post-launch.** The private romance mode ("Halves") ships **closed**. Its pages are specified in [Romance mode](#14-romance-mode-halves-post-launch) so they can be built last; until it is opened every route there except
  `/api/romance/interest` answers `503 ROMANCE_PAUSED`. Do not put any of it in the launch navigation.

Contents: [Conventions](#conventions-that-apply-to-every-endpoint) · [The client](#the-client) · [Realtime](#realtime) · [Rewards and what to celebrate](#rewards-and-what-to-celebrate) ·
1 [Landing](#1-landing) · 2 [Onboarding](#2-onboarding) · 3 [Home / Today](#3-home--today) · 4 [Discover / Drops](#4-discover--drops) · 5 [Sparks & Matches](#5-sparks--matches) · 6 [Passport](#6-passport) ·
7 [Crew HQ](#7-crew-hq) · 8 [Squads](#8-squads) · 9 [Ship Feed + Post](#9-ship-feed--post) · 10 [Search](#10-search--command-palette) · 11 [Leaderboards](#11-leaderboards) · 12 [Quests](#12-quests) ·
13 [Achievements](#13-achievements) · 14 [Romance mode](#14-romance-mode-halves-post-launch) · 15 [Notifications](#15-notifications) · 16 [Settings](#16-settings) · 17 [Moderation & Admin](#17-moderation--admin) ·
[Other pages](#other-pages-messages-projects-hackathons-ship-day) · [Mock fields that do not exist](#mock-fields-that-do-not-exist)

## Conventions that apply to every endpoint

| Topic | Rule |
| --- | --- |
| Auth | Clerk session: the `__session` cookie Clerk sets, or `Authorization: Bearer <token>`. No session gives `401` with code `UNAUTHORIZED`. Users are identified by their **local** id (`GET /api/users/me`), never by Clerk's id. |
| Errors | Always `{ error: { code, message, params?, details? } }`. Branch on `code` (the catalogue is `x-error-catalog` in the spec and "Errors" in API.md); `message` is an English default. `params` carries the values a translation needs. Validation failures are `400 VALIDATION_FAILED` with `details` as `{ field: string[] }`. |
| Pagination | `?page=1&limit=20`, response carries `pagination: { page, limit, total, totalPages }` **and** `nextCursor` (`string \| null`). For infinite scroll or "load more", send `nextCursor` back as `?cursor=` (with `limit`) until it is `null`: that is cheaper and is not thrown off by items added while the user scrolls. A cursor request has **no `pagination` object** (no count is run). Cursors are opaque; never build or store one across sessions. Two lists are bare arrays and send the cursor in the `X-Next-Cursor` response header (`GET /api/users/{id}/skills`, `GET /api/teams/{id}/applications`). `limit` is capped per route (usually 50, messages and leaderboard 100). Asking for more than the cap is a `400`, not a silent clamp. A bad cursor is `400 INVALID_CURSOR`: start again from the first page. |
| Rewards | Every request that can earn XP returns `rewards` (`RewardsEnvelope`) next to its normal body, also when nothing was earned. See [Rewards](#rewards-and-what-to-celebrate). |
| Retrying creates | Send an `Idempotency-Key` header (any UUID, one per user action, reused on a retry) on creating `POST`s; the client does it for you. A retry then returns the first response (`Idempotent-Replayed: true`) and creates nothing. Same key with a different body is `409 IDEMPOTENCY_KEY_REUSED`; while the first call is still running, `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` (wait a second, retry). Do not reuse a key for a new action. |
| Caching | 28 read-only `GET`s answer `Cache-Control: private, max-age=N`, `Vary: Authorization, Cookie` and a weak `ETag`; send `If-None-Match` and a matching one gets `304` with no body. The browser does this by itself; `fresh: true` on a client call forces a revalidation (use it after your own write, for the page that shows it). `GET /api/drops/today` and everything that writes are never cached. |
| Request id | Every response has `X-Request-Id`. Show it in "something went wrong" screens and send it with bug reports. |
| Time zones | Set `timezone` (an IANA name such as `Europe/Paris`) on the profile with `PATCH /api/users`; anything that is "per day" (XP caps, streaks, quests, the heatmap) follows the user's local midnight and "per week" (quests) the local Monday. Weekly and monthly leaderboards are UTC. An invalid zone is `400`. Dates stay UTC ISO strings. |
| Feature flags | `GET /api/flags` returns `{ flags: { key: boolean } }` for the signed-in user. Read it once per session and gate unreleased UI on it; a key that is missing is off. The romance launch flags are deliberately not in it. |
| Rate limits | Per signed-in user, per route family. Over the limit gives `429 RATE_LIMITED` (`error.params.retryAfter` is the seconds to wait) with a `Retry-After` header. If the limiter store is down you may see `503 SERVICE_UNAVAILABLE` with `Retry-After`. Back off and retry; do not hammer. |
| Blocks | Blocking is symmetric. The blocked user cannot see or reach the blocker anywhere: they get `404` on the blocker's profile, and the blocker is missing from lists, search, leaderboard, recommendations and the dashboard. The blocker gets `403 "You have blocked this user"` if they try to interact with someone they blocked (so the UI can offer "Unblock"). Nothing tells the blocked user they were blocked. |
| Missing vs forbidden | `404` means it does not exist **or** you may not know it exists. `403` means it exists and you lack the role for the action. |
| Unknown request keys | Ignored (stripped). Never send `id`, `ownerId`, `xp`, `role` and expect them to stick. |
| Paused features | `503 *_PAUSED` (a kill switch an operator pulled) is not an error to retry: hide or disable that feature and say "paused for a little while". |
| Account state | `403 ACCOUNT_SUSPENDED` / `ACCOUNT_BANNED` from nearly any route: send the person to [Moderation notices](#17-moderation--admin). `403 CONSENT_REQUIRED` after a policy change: show the consent dialog ([Settings](#16-settings)). |

Error codes you should handle everywhere: `400` validation or state, `401` signed out, `403` role, `404` missing or hidden, `409` duplicate, `429` slow down, `503` retry shortly.

**Every page has the same four failure states, so build them once:** *loading* (skeleton, not a spinner, for lists), *error* (the message, a Retry button, and the `requestId`), *signed out* (`401`: go to sign-in and come back)
and *paused* (`503 *_PAUSED`: the feature's own "paused" panel). Per page below, only what is specific to it is listed.

## The client

`import { createApiClient, momentsOf, isApiError } from '@/lib/api-client'`. It is fetch-only (no dependencies), works in the browser and in server components, and is generated from `docs/openapi.json`, so a
route that is added or changed shows up as a method and a type with no manual step. `npm run openapi:client` regenerates it; a unit test fails when `generated.ts` is out of date.

```ts
const api = createApiClient({
  baseUrl: '',                                   // same origin; give a full URL on the server
  getToken: () => clerk.session?.getToken(),     // omit in the browser when the session cookie is enough
  onRewards: (rewards, operation) => celebrate(momentsOf(rewards)),   // called for every answer that carries a RewardsEnvelope
})

const { data, rewards, nextCursor, requestId } = await api.shipFeed.getFeed({ query: { tab: 'city', limit: 20 } })
await api.shipFeed.postPosts({ body: { kind: 'SHIP', title, body, projectId } })    // gets an Idempotency-Key by itself
```

- **One method per operation**, named by its `operationId` (`getFeed`, `postPosts`, `putTeamsByIdPledge`) and grouped by area: `account`, `passport`, `matching`, `shipFeed`, `projects`, `squads`, `progress`, `search`,
  `messaging`, `notifications`, `growth`, `safety`, `media`, `shareCards`, `romance`, `admin`, `platform`. Arguments are `{ path?, query?, body?, idempotencyKey?, fresh?, signal?, headers? }`, typed from the route's own Zod schema.
- **The result** is `{ data, status, requestId, etag, nextCursor, rewards }`. `rewards` is the `RewardsEnvelope` when the answer has one (also from the body of a creating call), else `null`. A `304` is an answer with `data: null`.
- **Errors are typed.** A non-2xx answer throws `ApiClientError` (`code`, `status`, `message`, `params`, `details`, `requestId`, plus `retryAfter` for `429` and `fieldErrors` for `VALIDATION_FAILED`);
  `isApiError(e, 'RATE_LIMITED')` narrows by catalogue code, and `e.is('SPARK_LIMIT_REACHED')` does the same on an instance. A network failure or an answer that is not the API's (a gateway page) is `ApiNetworkError` or an
  `INTERNAL_ERROR` with the status. The set of codes comes from the catalogue in the spec, so a misspelt code is a type error.
- **Idempotency.** An operation marked `x-idempotent` gets an `Idempotency-Key` automatically (pass `idempotencyKey` to choose it: reuse the same value for the same user action, e.g. one per click of "Post"). The same key is sent
  on each retry, so a retried create cannot create twice. Reads are retried (default 2) on network errors and `502/503/504`; a write is retried only if it carries a key.
- **Pagination.** `for await (const page of paginate(api.shipFeed.getFeed, { query: { tab: 'for-you' } })) …` follows `nextCursor` (or `X-Next-Cursor`); `collectAll(operation, args, pageItems, { maxItems })` gathers them.
- **Rewards.** `momentsOf(rewards)` turns the envelope into an ordered list of things to celebrate (`TIER_UP`, `LEVEL_UP`, `ACHIEVEMENT`, `QUEST_COMPLETED`, `STREAK_SAVED` or `STREAK_EXTENDED`, `XP`), empty when nothing was earned.
- **Files.** Operations that answer a CSV or an image (`/api/og/*`, the admin CSV exports) have no JSON body; `Transport.raw` returns the `Response`. Their typed method returns the address to put in an `<img>` or a link.
- `urlFor(OPERATIONS.getFeed, { query }, baseUrl)` builds an address without sending it (for `<img src>`, `og:image`, prefetch).
- About 170 operations still answer with an untyped object in the spec (admin tools, many writes): they are typed `Record<string, unknown>` until their response type is added to `src/types/api.ts` and `src/lib/openapi/metadata.ts`
  (a test only lets that number shrink). Every response this file names is typed.

## Realtime

Realtime is **subscribe-only for the browser**; only the server publishes. Ask for a token with `api.platform.postRealtimeToken({ body: { channels } })` (no body means your own `user:` channel), pass `tokenRequest` to the Ably client
(`authCallback`), and renew when `expiresAt` (15 minutes) comes. A channel you may not read refuses the whole request (`403 CHANNEL_FORBIDDEN`, `details.denied`).

| Channel | Who may subscribe | Events today |
| --- | --- | --- |
| `user:{userId}` | that user | `match.created` `{ matchId, conversationId, connectionType }` (a match was made, also when the other person sparked back), `match.ended` `{ matchId }` (the other person unmatched) |
| `conversation:{id}` | its members | none published yet |
| `team:{id}` | its members | none published yet |

Subscribe to `user:{me}` once in the app shell. Everything else about "live" in the product is polling or refetch-after-write, on purpose: the lists are cheap and cached, and an event that is only a hint would need a refetch anyway.
There is **no presence and no typing indicator** (nothing publishes them). Without an Ably key (development, preview) the token is an unsigned stand-in and nothing is delivered: pages must work with no events at all, treating one as
"refetch this list now". `conversation:` and `team:` are authorised and ready, so a page can subscribe now; it will simply never hear anything until events are added there.

## Rewards and what to celebrate

Everything that earns XP returns `rewards` (type `RewardsEnvelope`). Use it to animate the outcome of the action the user just took. It always describes **the signed-in user**; when someone else is rewarded (a hackathon winner,
an accepted applicant, the owner of endorsed evidence) they find out from a notification of kind `ACHIEVEMENT` whose `metadata.kind` is `LEVEL_UP`, `TIER_UP`, `ACHIEVEMENT_UNLOCKED`, `QUEST_COMPLETED` or `COSMETIC_UNLOCKED`.

| Field | Use |
| --- | --- |
| `xpGained` | "+75 XP" toast. `0` means nothing was earned (a cap was reached or it already paid): show nothing. |
| `totalXp`, `newLevel`, `newTier` | Replace the cached XP, level and tier in the header without another request. |
| `leveledUp`, `oldLevel`, `newLevel` | **Level-up** celebration. |
| `tierChanged`, `oldTier`, `newTier` | **Tier-up** celebration (`BRONZE`, `SILVER`, `GOLD`, `PLATINUM`, `DIAMOND`, `MYTHIC`). Show it before the level-up it came with. |
| `achievements[]` | **Achievement** unlocked: `{ slug, name }`; open the badge with `/api/og/achievement/{slug}` for the share image. |
| `questsCompleted[]` | **Quest complete**: `{ slug, name }`; the XP is already in `xpGained`. |
| `streak` | `{ current, longest, extended, freezeUsed }`. Always present. `extended` is true on the first counting action of the local day: **flash the flame**. `freezeUsed` means a banked freeze just saved the streak. `current` is 0 for a lapsed streak. |

The celebrations that are **not** in the envelope, because they are a different fact about the response:

| Moment | Where it shows | What to do |
| --- | --- | --- |
| **Match** | `match` is not `null` in the `POST /api/sparks` answer; and `match.created` on `user:{me}` | Go straight to the match screen (the conversation already exists). No XP is involved. |
| **Squad formed** | `POST /api/hackathons/{id}/teams` (with `rewards`), squad-builder invitations answered, a `SquadProposalRespondResponse` with `status: "ACCEPTED"` and a `teamId`; notification `SQUAD_UPDATE` | Confetti and a "Your squad is set" panel with the team space link. |
| **Shipped** | `shipped: true` in `CreatePostResponse`; `PATCH /api/projects/{id}` to `SHIPPED` (with `rewards`) | The ship celebration, with Share (the card, see [Settings](#16-settings)). |
| **Cosmetic unlocked** | notification `COSMETIC_UNLOCKED` (season placings; they cost no XP) | A "new frame" toast on the notification. |

Where `rewards` comes back: `POST /api/projects`, `PATCH /api/projects/{id}`, `POST /api/projects/{id}/updates`, `PATCH /api/projects/{id}/milestones/{milestoneId}`, `POST /api/hackathons/{id}` (register),
`POST /api/hackathons/{id}/teams`, `POST /api/hackathons/{id}/submit`, `PATCH /api/hackathons/{id}/results`, `POST /api/evidence`, `PATCH /api/teams/{id}/applications/{applicationId}`, `PATCH /api/connections/{id}`,
`POST /api/conversations/{id}` and `POST /api/teams/{id}/keep-building`. The spec marks each with `x-rewards`.

Level progress for a progress bar is not in the envelope; compute it from the user's `xp` with the curve in [GAMIFICATION.md](GAMIFICATION.md#level-curve) (`levelFor()` in `src/lib/levels.ts` is pure and safe to import in the
browser: `{ level, tier, xpIntoLevel, xpForNextLevel, progress }`). Do not promise XP the UI cannot be sure of. Every award is paid once per thing, and most have a daily cap: project creation and shipping 3 a day; milestones 5;
project updates, evidence 3; endorsements received 10; connections 5; first messages 5. Joining, forming a team, winning and an accepted team application pay once per hackathon or application. Sparks and matches never pay.

---

## 1. Landing

`/` for a signed-out visitor. It is a static marketing page: **there is no data endpoint behind it** and no number to fetch (do not put live counts on it; nothing public exposes them).

| Need | Call |
| --- | --- |
| Is this invite link good (quiet "you were invited") | `GET /api/invites/check?code=CODE` (public, no session, 10 a minute per address) → `InviteCheckResponse` `{ valid }` |
| Preview image for a pasted link to a public page | `GET /api/og/link?kind=…&id=…` (public) → `CardLinkResponse`, server side, in the page's metadata |
| Uptime banner (only on a status page) | `GET /api/health` → `HealthResponse` |

- **States.** Nothing loads, so nothing is empty. If `/api/invites/check` fails or is rate limited, show nothing: an invite is never an error for a visitor.
- **Invite links.** Read `?invite=CODE`, keep it through the sign-up and pass it to Clerk (`unsafeMetadata: { inviteCode }`), see [Onboarding](#2-onboarding).
- **Romance.** Nothing about the romance mode appears on the landing page or in its metadata.
- **Celebrate.** Nothing.

## 2. Onboarding

`/onboarding`, until `GET /api/users/me` says `onboardingComplete: true` (the middleware sends everyone there). Three things finish it: a headline, at least one skill and (while `BIRTH_DATE_REQUIRED`, the default) a date of birth, plus
the terms and privacy consent when `consentRequired` is not empty.

| Need | Call |
| --- | --- |
| Where the person is | `GET /api/users/me` → `{ id, username, name, image, headline, skillCount, ageRequired, isMinor, ageRefused, consentRequired, onboardingComplete }` (a user's `email` is part of it) |
| Skills to pick from | `GET /api/skills?category=&search=`, then `POST /api/users/{me}/skills { skillId, level }` (`PATCH`/`DELETE …/{skillId}`) |
| Headline, date of birth, place | `PATCH /api/users { headline, birthDate: "YYYY-MM-DD", timezone, … }` (`birthDate` is **write-once**); `PATCH /api/users/me/profile { timezone, countryCode, city }` |
| Terms and privacy | `GET /api/users/me/consents` (`currentVersion`), `POST /api/users/me/consents { type: "TERMS" \| "PRIVACY", version, source: "onboarding" }` |
| Matching profile (can be skipped) | `GET /api/matching/quiz`, `PUT /api/matching/profile` (section [Discover](#4-discover--drops)) |
| Avatar | `POST /api/media/uploads { purpose: "AVATAR" }`, PUT the file, `POST /api/media/{id}/complete`, `PUT /api/users/me/avatar { mediaId }` |
| Campus (optional) | [Settings → Campus](#16-settings) |
| Invite | pass `inviteCode` to Clerk; for flows that cannot, `POST /api/invites/redeem { code }` within 14 days |

- **Birth date.** Ask for it once and say it cannot be changed (`409 BIRTH_DATE_LOCKED`); it is never shown to anyone. Under 16 is `403 AGE_BELOW_MINIMUM` (the account cannot continue: show the refusal page, not the form). 16 and 17 make a
  **minor** (`isMinor`): they may share a country and nothing finer (`400 MINOR_LOCATION_LIMITED`), have no share cards and never see the romance mode. Show the country-only form to them without explaining the law.
- **Consent.** Check boxes are unticked and explicit; after a policy change any write can answer `403 CONSENT_REQUIRED` with `details.consents`, handled the same way.
- **Sign-up refusals** on the first screen after Clerk: `403 SIGNUP_EMAIL_REJECTED`, `429 SIGNUP_RATE_LIMITED`, `503 SIGNUPS_PAUSED`: show the message and a sign-out. Never show an error for a bad invite code.
- **Nothing romance-related** is in onboarding data or steps. The mode is offered from Settings only, and only after launch.
- **States.** Empty: every step starts empty. Saving a step with `400 VALIDATION_FAILED` highlights `fieldErrors`. A retry of a step is safe (writes are idempotent by value).
- **Celebrate.** The first skill, headline and evidence can earn XP elsewhere; onboarding itself returns no envelope. Do show the finished passport with "Welcome" and, when `?invite=` was used, nothing about who invited them.

## 3. Home / Today

`/dashboard`: what to do today, what is moving, where the person stands.

| Need | Call |
| --- | --- |
| The page's data in one call | `GET /api/dashboard` → `DashboardResponse` (`currentBuild`, `userProjects`, `userTeams`, `hackathonParticipations`, `recentActivities`, `xpEvents`, `recommendedBuilders`, `recruitingTeams`, `upcomingHackathons`) |
| Level, tier, XP bar, streak, rank, counts | `GET /api/users/{me}/stats` → `PlayerCard` (`level`, `tier`, `progress.fraction`, `streak.current`, `ranks.global`, `counts`) |
| Today's drops | `GET /api/drops/today` → `TodayDrops` ([Discover](#4-discover--drops)) |
| Today's and this week's quests | `GET /api/quests` → `QuestsResponse` ([Quests](#12-quests)) |
| Contribution calendar | `GET /api/users/{me}/heatmap?days=365` → `HeatmapResponse` (`items[]`, only days with activity) |
| Where I stand now | `GET /api/leaderboard?period=weekly` → `me` and `around` |
| Ship Day banner | `GET /api/ship-day` → `ShipDayResponse` |
| Notification badge | `GET /api/notifications?unreadOnly=true` → `NotificationsResponse` (`unreadCount`) |
| Feature flags | `GET /api/flags` → `FlagsResponse` |
| Realtime | `user:{me}` ([Realtime](#realtime)) |

- **States.** Empty: no `currentBuild` → "What are you building?" with the new-project button; no `recentActivities` → the first-action checklist; no drops (`hasProfile: false`) → the matching setup prompt; `recommendedBuilders` empty is normal for a new account.
  Loading: render the shell with skeletons and let each card load on its own (they are separate calls and can fail separately; one failed card shows its own Retry).
- **`userQuests` in `DashboardResponse`** are legacy rows; use `GET /api/quests`.
- **Blocked users** never appear in `recommendedBuilders` or `recruitingTeams`; do not filter again.
- **Refetch after a write.** Use `rewards` from the action to update the XP bar, flame and quest ticks without a request; refetch `/api/quests` with `fresh: true` only if you want to be sure.
- **Celebrate.** Every `RewardsEnvelope` that arrives on this page's actions: **streak** (flame on the first action of the local day; the streak counter is `rewards.streak.current`), **level-up**, **tier-up**, **quest complete**,
  **achievement**. When the streak is about to lapse, nothing in the API says so: compare `streak.current` with whether there was activity today (`heatmap`), or leave it to the daily reminder notification.

## 4. Discover / Drops

`/discover`: the daily drops (a few well-explained people) and the browsable lists.

| Need | Call |
| --- | --- |
| The quiz | `GET /api/matching/quiz` → `{ version, questions: [{ id, prompt, options: [{ id, label }] }] }` (options run from one end of a spectrum to the other; show them in order) |
| Load / save the matching profile | `GET` / `PUT /api/matching/profile` (**write**, saves the whole profile, send every field including `paused`) → `{ exists, profile }`. Types: `COFOUNDER`, `HACKATHON_TEAMMATE`, `COLLABORATOR`, `MENTOR`, `MENTEE`; sending `DATING` is `400 VALIDATION_FAILED` |
| Today's people | `GET /api/drops/today` → `TodayDrops` |
| "Not for me" | `POST /api/drops/{id}/pass` (**write**) → `{ id, status: "PASSED" }` |
| Browse people | `GET /api/discover?search=&skills=&location=&page=&limit=` → `DiscoverResponse` |
| Projects tab | `GET /api/projects?search=&status=&techStack=` → `ProjectsResponse` |
| Crews tab | `GET /api/teams?search=&isRecruiting=&skills=&hackathonId=` → `TeamsResponse` |
| Hackathons tab | `GET /api/hackathons?status=&search=` → `HackathonsResponse` |
| Connect | `POST /api/connections { receiverId, type?, message? }` |
| Skills | `GET /api/skills` (send the slugs as `lookingForSkills`, and as `skills=` on browse) |

Show `drops` in the order given (best fit first). Each has `score` (0-100) and up to three `reasons` to print under the card; `connectionType` is what the user is being shown this person for (a MENTEE is shown mentors as `MENTEE`).
Show at most one drop per type when `drops` holds several types: that is by design. A `secondLook: true` drop is someone the user passed earlier who has grown since; label it. Use `nextDropAt` for "your next drops arrive in…"
(it is to the hour). `status` is `NEW` until the user acts: grey out `PASSED` and `SPARKED`, hide `EXPIRED`. `compatibility` (0-100) on `/api/discover` and the dashboard is a separate, older number and keeps its shape.
The four tab counts come from `pagination.total` of each list; ask for `limit=1` when you only need a count. Yourself and blocked users are never returned. `rank` on a list item is always `0`: use the leaderboard.

- **States.** `hasProfile: false` → the setup (quiz and profile), `paused: true` → "Drops are paused" with a resume switch, no drops yet today → the `nextDropAt` countdown and the browse list, an empty browse → "Nobody matches these
  filters" with a clear-filters button. A quiz `version` change means the saved answers are for an older quiz: let the person re-answer.
- **Date of birth** is asked in onboarding; see there for the age rules. A person of 16 or 17 gets the professional drops only.
- **Realtime.** None here; a spark's match arrives on `user:{me}` ([Sparks & Matches](#5-sparks--matches)).
- **Celebrate.** Nothing is paid here. Do celebrate completing the matching profile (the first drops arrive the next hour) with a plain confirmation.

## 5. Sparks & Matches

| Need | Call |
| --- | --- |
| Spark someone | `POST /api/sparks { toId, connectionType, opener, dropId? }` (**write**, `Idempotency-Key`) → `SendSparkResponse` `{ spark, match }` |
| Who sparked me | `GET /api/sparks/received?limit=&cursor=` → `ReceivedSparks` `{ canSee, count, sparks, nextCursor }` |
| My matches | `GET /api/matches?limit=&cursor=` → `MatchesResponse` `{ matches, nextCursor, total }` |
| Open the chat | `GET /api/conversations/{match.conversationId}` and `POST /api/conversations/{id}` (as any direct conversation) |
| Unmatch | `DELETE /api/matches/{id}` (**write**) → `{ id, endedAt }` |
| Unmatch and report | `POST /api/matches/{id}/report { reason, description? }` (**write**, `Idempotency-Key`) |
| Block / report a person | [Moderation](#17-moderation--admin) |
| Realtime | `user:{me}`: `match.created`, `match.ended` |

The **opener** is required: 20 to 280 characters, a real reason to talk. Show the counter while typing and the refusal's `error.details.message` (an English default; branch on `details.reason`: `TOO_SHORT`, `TOO_LONG`,
`TOO_FEW_WORDS`, `LOW_EFFORT`, `LINK`, `CONTACT_DETAILS`, `REPEATED_CHARACTERS`, `DUPLICATE`) when it is refused. Do not offer "paste a link or a number": they are refused until the two have matched. `connectionType` is the user's own
side: on a drop send the drop's `connectionType`; to answer a received spark send the **counterpart** of its `connectionType` (`MENTOR`↔`MENTEE`, every other type the same). `429 SPARK_LIMIT_REACHED` (`error.params.limit`) means today's
sparks are used (more arrive tomorrow; show the paid plan's number); `429 SPARK_THROTTLED` (`params.retryAfter`) means slow down. A person who is not available (`404 SPARK_TARGET_UNAVAILABLE`) is shown as "not available"; never explain why.

A match opens a conversation that already holds a `SYSTEM` message (the icebreaker: render it as a banner, its sender is the platform) followed by both openers. Show `yourRole` / `theirRole` for mentoring matches. **Unmatching is final
and shuts the chat for both**: ask for confirmation, and afterwards the conversation answers `closedAt` with a timestamp and `POST` to it is `409 CONVERSATION_CLOSED` (show it read-only). Blocking someone also ends the matches with them
(`endedMatches` on the block response).

- **States.** `canSee: false` in the received list means the plan does not show who sparked: show `count` ("3 people sparked you") with an upgrade prompt and no names. No sparks → "Sparks you get appear here"; no matches → point at
  today's drops. On `match.ended` mark the match ended in place (read-only chat), do not remove it from under the reader.
- **Celebrate.** **Match**: when `match` is set in the spark answer, or `match.created` arrives, go straight to the match screen with the banner. A spark alone gets a quiet confirmation. Sparks and matches never pay XP, so there is no
  `rewards` envelope on these calls.

## 6. Passport

`/profile` (own) and `/profile/{id}`: the proof of what someone builds.

| Need | Call |
| --- | --- |
| The page | `GET /api/users/{id}` → `ProfileResponse` (use your own id for "me") |
| Header: title, frame, banner, level, tier, rank, streak | `GET /api/users/{id}/stats` → `PlayerCard`: `equipped.{title,frame,banner}` are `{ slug, name }` or null and `equipped.badges` is up to three `{ slug, name }`; `ranks` are absolute places (null where not on a board); `streak` is `null` on someone else's page when they keep their activity private; `reliableTeammate: boolean` |
| Rarest badges | `stats.topAchievements` (three, rarest first, with `rarity`) |
| Badge wall | `GET /api/users/{id}/achievements` ([Achievements](#13-achievements)) |
| Contribution calendar | `GET /api/users/{id}/heatmap?days=365`; `hidden: true` means the owner keeps it private: show nothing |
| Edit | `PATCH /api/users` any of `name, bio, headline, location, timezone, availability, builderRole, website, githubUsername, twitterUsername, linkedinUrl` |
| Skills | `GET /api/users/{id}/skills`, `POST /api/users/{id}/skills`, `PATCH`/`DELETE …/skills/{skillId}` |
| Evidence | `GET /api/evidence?userId=&skillId=` → `EvidenceResponse`; `POST /api/evidence { skillId, type, title, url?, description? }` (with `rewards`); `DELETE /api/evidence/{id}` |
| Endorse | `POST` / `DELETE /api/evidence/{id}/endorse` → `EndorseResponse` |
| Activity tab | `GET /api/activity?userId=&type=&page=&limit=` → `ActivityResponse` |
| A person's posts | `GET /api/users/{id}/posts` → `PostsPageResponse` |
| Follow | `POST` / `DELETE /api/users/{id}/follow`; `GET /api/users/{id}/followers`, `/following` → `FollowPeopleResponse` |
| Connect | `POST /api/connections` |
| Block / mute / report | [Moderation](#17-moderation--admin) |
| My cosmetics, wearing them | `GET /api/users/me/cosmetics` → `CosmeticsResponse`; `PATCH /api/users/me/equipped { title?, frame?, banner?, badges? }` (**write**; `badges` is up to three slugs in order and replaces the list) |
| Share the card | `GET /api/og/link?kind=passport&id={username}` ([Settings](#16-settings)) |
| Builds ("what I am building") | `GET /api/builds`, `PUT` / `DELETE /api/builds/me` |

`ProfileResponse` is everything on the user that is safe to show: identity fields, `xp`, live `rank`, `reputationScore`, verification flags, `skills[]`, `skillEvidences[]`, `ownedProjects[]`, `projects[]`, `ownedTeams[]`, `teams[]`,
`achievements[]`, `currentBuild`, and: `email` **only** on your own profile; `rank` the live position (`0` with no XP yet); `compatibility` 0-100 against you (`null` on your own); `blockedByMe` (show "Unblock").
A field the owner keeps to themselves (or to connections, when you are not one) comes back `null`: hide its row, do not show a placeholder. `404` if the user does not exist or has blocked you. Passwords, hashes, tokens and other
people's email addresses are never returned by any endpoint. `achievements[]` on the profile are **earned** ones only; `icon` is a string name to map to an icon in the UI.

Endorsement rules: evidence rows come from `GET /api/evidence`; each has `endorsementCount` and `endorsedByMe`. You cannot endorse your own evidence (`403`), and each person can endorse an item once. Endorsements from unverified accounts
still show in `endorsementCount`, but only verified endorsers unlock the owner's "Vouched For" achievement and XP, so do not promise the owner a badge when one arrives.

Cosmetics are only earned: there is nothing to buy and no "unlock" button, only `requirement` text on the locked ones. A finished season adds a few for everyone who played or placed (`Season N Top 100` title, `Season N Top 1%` and
`Season N Top 10%` frames, a `Season N Participant` badge). Equipping in the wrong slot is `400 COSMETIC_WRONG_SLOT`; more than three badges is `400 VALIDATION_FAILED`; equipping something not owned is `403 COSMETIC_NOT_OWNED`, so disable
the control for locked items. A cosmetic from a secret achievement is `masked` until owned (show a mystery tile). Tell the user why a rank is missing: `hideFromLeaderboards`, no XP yet, or no country/city set.

- **Privacy.** Someone with cards off, or a minor, has no share card; the page must not set `og:image` for them. A private profile field is hidden, not blank.
- **States.** New passport: no skills → "Add your first skill"; no evidence → "Proof beats claims: add a project or link"; no posts → "Ship something"; no streak → the empty flame. A blocked or missing user is the same "not found" page.
- **Celebrate.** Adding evidence and finishing a project (**shipped**), receiving endorsements (a notification, not an envelope), and everything in the envelope on the actions here: achievement, level-up, tier-up, streak.

## 7. Crew HQ

`/teams` and `/teams/{id}`: crews (teams) that build together, outside any one hackathon. A hackathon squad is also a crew; its extra pages are in [Squads](#8-squads).

| Need | Call |
| --- | --- |
| List | `GET /api/teams?search=&isRecruiting=&skills=&hackathonId=` → `TeamsResponse` |
| Detail | `GET /api/teams/{id}` |
| Create | `POST /api/teams { name, description?, projectId?, hackathonId?, maxSize?, lookingFor?, isRecruiting? }` (**write**, `Idempotency-Key`) |
| Edit / delete | `PATCH` / `DELETE /api/teams/{id}` (owner or admin role on the team) |
| Apply | `POST /api/teams/{id}/applications { message?, slotId? }` (**write**, `Idempotency-Key`) |
| My applications | `GET /api/teams/applications?status=` |
| Review applications (team admins) | `GET /api/teams/{id}/applications`, `PATCH …/applications/{applicationId} { status: 'ACCEPTED' \| 'REJECTED' \| 'WITHDRAWN' }` (with `rewards`) |
| Invite | `POST /api/teams/{id}/invitations { userId, message? }` (**write**, `Idempotency-Key`) |
| Suggested members | `GET /api/teams/{id}/candidates` |
| What the crew is missing, and who could fill it | `GET /api/teams/{id}/gaps` → `TeamGapsResponse` (owner or team admin; `403` otherwise: hide the panel) |
| Members | `PATCH` / `DELETE /api/teams/{id}/members/{userId}`; `POST /api/teams/{id}/transfer-ownership { newOwnerId }` |
| The crew's projects | `GET /api/projects?ownerId=` and [Other pages](#other-pages-messages-projects-hackathons-ship-day) |
| The crew's chat | `GET /api/conversations?type=TEAM`; subscribe to `team:{id}` (no events yet) |

`TeamsResponse` items: `id, name, slug, description, maxSize, isRecruiting, lookingFor, createdAt, updatedAt` plus `owner`, `members[]` (with `role` and `user`), `project`, `hackathon`, `_count { members, applications }`. Teams owned by
someone you have a block with are left out. `openSlots` is `maxSize - _count.members`. There are no team logos: use initials.

Gap finder: show `missing.skills` and `missing.roles` as "Your team needs…" chips (`sources` says whether the team or the project asked), `covered.*` as ticked, and `candidates` (five at most, best first) as cards with `reasons`,
`fills` and an Invite button. `unmatchedStack` is informational ("we can't check Vercel"). Suggestions are not drops: opening the panel shows no one to the other person, and nobody is notified until you invite.

- **States.** No crews → "Start one or browse"; a crew nobody applied to → "No applications yet"; applying twice is `409`; a locked squad answers `409 TEAM_LOCKED` ([Squads](#8-squads)).
- **Celebrate.** **Accepted applicant**: the applicant is told by notification; the owner who accepts gets the `rewards` of that `PATCH`. A crew filling its last seat → "Crew complete".

## 8. Squads

Hackathon team building. The rules are in [SQUADS.md](SQUADS.md) and the routes in [API.md](API.md#squads). Types are in `src/types/api.ts` under "Squads": `SquadRole`, `TeamSlotItem`, `TeamStrengthResponse`,
`SquadProposal`, `SquadInviteResponse`, `ParticipationResponse`, `SquadProposalsResponse`, `LfgBoardResponse`, `TeamSpaceResponse`, `PledgeResponse`, `PeerReviewTodoResponse`, `ExternalHackathonResponse` and
`HackathonSquadMetricsResponse`.

Show a role with its label, never the raw enum. `roleLabel` comes back where it matters. Otherwise map the enum (the same labels as `ROLE_LABELS` in `src/lib/squads/roles.ts`):

| Enum | Label | Enum | Label |
| --- | --- | --- | --- |
| `FRONTEND` | Frontend developer | `DEVOPS` | DevOps engineer |
| `BACKEND` | Backend developer | `DESIGN_UI_UX` | Designer (UI/UX) |
| `FULLSTACK` | Full-stack developer | `PRODUCT` | Product lead |
| `MOBILE` | Mobile developer | `PITCH_BUSINESS` | Pitch & business |
| `ML_AI` | ML / AI engineer | `HARDWARE` | Hardware engineer |
| `DATA` | Data engineer | `OTHER` | the `customLabel` |

### 8a. Hackathon page (`/hackathons/{id}`)

| Need | Call |
| --- | --- |
| The hackathon | `GET /api/hackathons/{id}`; also `source`, `platform`, `externalUrl`, `mode`, `city`, `country`, `tracks`, `submissionDeadline`, `resultsAt` and `unverified` |
| The list | `GET /api/hackathons?status=&search=` → `HackathonsResponse` (`registered`, `myTeamId`, `myStatus` drive the buttons without a request per card) |
| Register | `POST /api/hackathons/{id} { skills?, lookingFor? }` (**write**, with `rewards`) |
| Enter a team | `POST /api/hackathons/{id}/teams { teamId, projectId? }` (**write**, with `rewards`) |
| Submit | `POST /api/hackathons/{id}/submit { teamId }` (**write**, with `rewards`) |
| Join the solo pool | `PATCH /api/hackathons/{id}/participation { lookingForTeam, preferredRoles, openToAutoTeam }` → `ParticipationResponse` |
| My proposed squads | `GET /api/squad-proposals` → `SquadProposalsResponse`, then `GET /api/squad-proposals/{id}` → `{ proposal }` |
| Answer a pool squad | `POST /api/squad-proposals/{id}/respond { accept }` (**write**) → `{ status, teamId, proposal }` |
| Peer reviews (after the end) | `GET /api/hackathons/{id}/peer-reviews` → `PeerReviewTodoResponse`; `POST` one per teammate (**write**, `Idempotency-Key`) |
| Add a hackathon from another platform | `POST /api/hackathons/external { url, … }` (**write**, `Idempotency-Key`) → `ExternalHackathonResponse` (`201` new, `200` known) |
| Results | the detail's `hackathonTeams[].rank` / `score` (`null` until recorded) |
| Squad recap card | `GET /api/og/link?kind=squad&id={teamId}` (after the hackathon has ended) |

The detail has `participants[].user`, `hackathonTeams[]`, `_count { participants, hackathonTeams }` and `participation` (your own row or `null`); on the list the count key is `teams`. Registration rules to mirror:
`400 HACKATHON_REGISTRATION_CLOSED`, `400 HACKATHON_REGISTRATION_DEADLINE_PASSED`, `400 HACKATHON_ALREADY_REGISTERED`; entering a team needs you registered and a member, and the team size inside the hackathon's min/max. Only admins create
hackathons (`403` otherwise). `prizePool` is free text, not a number.

**Teamless and registered.** Offer three things: *Find my squad*, *Join the solo pool* (explain that two days before the deadline a squad is proposed to you, and you have a day to say yes), and *the LFG board*.
**`unverified`.** Show the hackathon with an "Unverified" flag and a link to `externalUrl`. It works for squads, but do not promise XP for it.

| External link error | Show |
| --- | --- |
| `400 EXTERNAL_URL_REFUSED` | "That link can't be used" |
| `422 EXTERNAL_PAGE_UNREADABLE` | A form asking for the name and dates, then send again with them |
| `422 EXTERNAL_DATES_UNKNOWN` | Ask for the dates |
| `403 ACCOUNT_NOT_TRUSTED` | The account is under a week old or not verified: say when it can try |

**Reviews.** Show the review panel when `window.open` is true. Each review is private: say so. The note is at most 140 characters and only moderators read it. Never show anyone what was said about them.

### 8b. Squad Builder ("Find my squad")

| Need | Call |
| --- | --- |
| Propose | `POST /api/hackathons/{id}/squad-builder { size?, tracks?, seed? }` → `201 SquadProposalResponse` |
| Read one again | `GET /api/hackathons/{id}/squad-builder/{proposalId}` |
| Try again | the same call with another `seed`: the same seed gives the same squad |
| Send the invitations | `POST /api/hackathons/{id}/squad-builder/{proposalId}/invite { teamName? }` (**write**, `Idempotency-Key`) → `SquadInviteResponse` |

Show `strength.score` as a meter and `strength.gaps[].message` as what is missing ("No designer"). For each member show their `person`, their `roleLabel` and `reasons` (the "why this person" lines); `onTeam` marks the caller and their
team. After inviting, show `skipped` with a human reason, then go to the team space. The proposal is computed (about a quarter of a second): show a progress state, do not call it twice.

| Error | Show |
| --- | --- |
| `422 SQUAD_POOL_EMPTY` | "Nobody to suggest yet": offer the LFG board |
| `409 SQUAD_COMPLETE` | "Your squad is full" |
| `400 TRACK_NOT_FOUND` | Refresh the track list |
| `410 SQUAD_PROPOSAL_EXPIRED` | Propose again |
| `409 SQUAD_PROPOSAL_USED` | The invitations already went out |

### 8c. LFG board (`/hackathons/{id}/lfg`)

| Need | Call |
| --- | --- |
| The board | `GET /api/hackathons/{id}/lfg?role=&stack=&tz=&kind=&limit=` → `LfgBoardResponse`; more with `cursor=<nextCursor>` |
| Post | `POST /api/hackathons/{id}/lfg { kind: PERSON, roles, stack?, timezone?, note }`; a team posts `{ kind: TEAM, teamId, … }` (**write**, `Idempotency-Key`) |
| Edit / take down | `PATCH` / `DELETE /api/hackathons/{id}/lfg/{postId}` (**write**, author) |
| Apply to a team's seat | `POST /api/teams/{teamId}/applications { slotId }`; seats from `GET /api/teams/{teamId}/slots` |

The order is the server's (best fit to the viewer first); do not re-sort. Show `fit.score` and `fit.reasons` on each card; `mine` marks the viewer's own post. `409 LFG_ACTIVE_POST_EXISTS` carries `details.postId`: open that post for
editing instead. `tz` takes an IANA zone; default it to the viewer's own. Empty board → "Be the first to post". Every post has a Report entry.

### 8d. Team space (`/teams/{id}/space`, members only)

| Need | Call |
| --- | --- |
| The page | `GET /api/teams/{id}/space` → `TeamSpaceResponse` |
| Strength | `GET /api/teams/{id}/strength` → `TeamStrengthResponse` (score, components, gaps, who covers which role) |
| Slots | `GET /api/teams/{id}/slots`; owner: `POST /api/teams/{id}/slots`, `PATCH` / `DELETE …/slots/{slotId}` |
| My role | `PATCH /api/teams/{id}/members/{me} { squadRole, roleLabel? }` |
| Target tracks (owner) | `PATCH /api/teams/{id} { targetTracks }` |
| Pledge | `PUT /api/teams/{id}/pledge { attendance, hoursAvailable, availableFrom, availableUntil }` until the start (`409 PLEDGE_CLOSED` after) → `PledgeResponse` |
| Checklist | `POST /api/teams/{id}/checklist { title, assigneeId? }`, `PATCH` / `DELETE …/checklist/{itemId}` |
| Ideas | `POST /api/teams/{id}/ideas`; `POST` / `DELETE …/ideas/{ideaId}/vote`; owner: `POST …/ideas/{ideaId}/choose`; `DELETE …/ideas/{ideaId}` |
| Post our demo | `POST /api/teams/{id}/demo-post { title, body, links?, mediaIds?, stackTags? }` (**write**, `Idempotency-Key`) → `201 { post }` |
| Keep building (owner, after the end) | `POST /api/teams/{id}/keep-building { projectName? }` → `KeepBuildingResponse` (with `rewards`) |
| Leave / remove | `DELETE /api/teams/{id}/members/{userId}` → `{ reopenedSlotId }` |
| Realtime | `team:{id}` (authorised; no events published yet, so refetch on focus) |

- **Countdown.** Count down from `hackathon.secondsLeft` to `locksAt`. When `locked` is true, hide every membership and slot control: the server refuses them with `409 TEAM_LOCKED`.
- **Pledges.** Show who has not pledged (`unconfirmedPledges`) and the pledge form until the start. **Keep building.** Show it after the hackathon's `endDate` or once `resultsAt` is set; `keptBuildingAt` means it already happened.
- **Strength privacy.** Strength never contains the members' reliability. Do not try to derive one; the profile has a boolean `reliableTeammate` for a badge, and no number.
- **States.** A squad of one → the invite and LFG prompts; no ideas → "Pitch the first idea"; empty checklist → a starter suggestion; a hackathon that was cancelled → the space turns read-only with the reason.
- **Celebrate.** **Squad formed** (the last seat filled, or a proposal accepted); **submitted** (`POST …/submit`, with `rewards`); **results** (rank and score appear on the detail; winners are told by notification);
  **shipped** when the demo is posted; every `RewardsEnvelope` on these calls.

## 9. Ship Feed + Post

The rules (posts, Props weights, ranking, Ship Day) are in [FEED.md](FEED.md). Types: `PostItem`, `FeedResponse`, `PostsPageResponse`, `PostCommentItem`, `PostCommentsResponse`, `PropsResponse`, `FollowPeopleResponse`,
`CreatePostResponse`, `ShipDayResponse`. A post's `body` is **Markdown source**, sanitized on the server: render it with a Markdown renderer that does not allow raw HTML; never put it in `innerHTML` as it is.

### 9a. Feed (`/feed`)

| Need | Call |
| --- | --- |
| The page | `GET /api/feed?tab=for-you\|following\|city\|campus&limit=` → `FeedResponse` |
| More | the same with `cursor=<nextCursor>`; stop when `nextCursor` is `null` |
| Give / take back Props | `POST` / `DELETE /api/posts/{id}/props` (**write**, `Idempotency-Key`) → `PropsResponse`; update the card from it |
| Follow / unfollow an author | `POST` / `DELETE /api/users/{id}/follow` → `{ following }` |
| Watch a project | `POST` / `DELETE /api/projects/{id}/watch` → `{ watching }` |
| Ship Day | `GET /api/ship-day` → `ShipDayResponse` |

Switching tab starts again without a cursor. `400 INVALID_CURSOR` (a cursor is good for an hour) means "reload the feed", not an error to show. The order is the server's: do not re-sort. `city` and `campus` are empty until the user has set a
place (a verified campus for `campus`): say so and link to Settings. Show `yourProps` as the state of the Props button, `propsCount` as the number, and never `propsScore`. A new post by the user does not appear at the top of the feed by
itself: put the `post` from `POST /api/posts` at the top locally.

### 9b. Post (`/posts/{id}`) and the composer

| Need | Call |
| --- | --- |
| Read | `GET /api/posts/{id}` → `{ post }`. `404 POST_NOT_FOUND` for a post that is gone, hidden by a block or not visible to the user (followers-only, crew-only): all look the same, show "not found" |
| Compose | upload each file first (`POST /api/media/uploads` with `purpose: "POST_MEDIA"`, PUT to the returned URL, `POST /api/media/{id}/complete`), then `POST /api/posts { kind, title, body, projectId?, teamId?, links?, mediaIds?, stackTags?, coAuthorIds?, visibility? }` (**write**, `Idempotency-Key`) → `CreatePostResponse` |
| Edit | `PATCH /api/posts/{id}` any of `title, body, links, stackTags, visibility` (author only); show "edited" from `editedAt` |
| Delete | `DELETE /api/posts/{id}` (author or admin) |
| Comments | `GET /api/posts/{id}/comments?cursor=` → `PostCommentsResponse` (oldest first, replies nested one level) |
| Comment / reply | `POST /api/posts/{id}/comments { body, parentId? }` (**write**, `Idempotency-Key`); replying to a reply is `400 COMMENT_REPLY_DEPTH`, so show Reply only on top-level comments |
| Edit / delete a comment | `PATCH` / `DELETE /api/comments/{id}`: editing is open for 15 minutes (`403 COMMENT_EDIT_WINDOW_CLOSED`); hide Edit after `createdAt + 15 min` |
| A project's timeline | `GET /api/projects/{id}/timeline` → `PostsPageResponse` (a private project's is `404 PROJECT_NOT_FOUND` to non-members) |
| Share image | `GET /api/og/link?kind=post&id={id}` |
| Report / mute | [Moderation](#17-moderation--admin) |

Composer rules to enforce before sending (the server enforces them too): title 3 to 120 characters, body 1 to 10,000, at most 6 files, 5 links, 10 tags and 5 co-authors (a `DEMO` post for a hackathon squad: up to the hackathon's
`maxTeamSize`, at most 10). A `SHIP` post needs a project the user belongs to; `CREW` visibility needs a project or crew. Co-authors can only be members of the project or crew (`400 POST_COAUTHOR_NOT_MEMBER`). A post made on the author's
Friday has the `ship-day` tag in `stackTags`; render it as the Ship Day badge. Refusals to handle: `400 CONTENT_REJECTED` (`details.reasons`), `403 EMAIL_VERIFICATION_REQUIRED` (public posts need a verified email; followers-only still works).

### 9c. Ship Day (`/ship-day`)

If `isShipDay`, show the banner, the live `todayCount`, a countdown to `endsAt` (the end of the user's own Friday), the user's `yourShips` and the day's `topPosts`; the composer is the Post composer with kind `SHIP` or `DEMO` and
nothing extra to set: the tag is applied by the server. If it is not Ship Day, show when the next one is (the coming Friday in the user's zone) and `lastRecap` if there is one. `dateKey` is the user's Friday of this week, which on a
Saturday or Sunday is behind them. Nothing about Ship Day pays XP by itself; the *Friday Shipper* achievements arrive through the usual `rewards` envelope.

- **States.** Empty feed (new account, no follows) → "Follow builders or check For you"; empty comments → "Say something specific"; an author who deleted their account shows as a deleted user. Optimistic Props: flip the button,
  and on error put it back and show the code.
- **Realtime.** None. Refetch the feed on focus after a long absence (the ETag makes it cheap).
- **Celebrate.** **Shipped** (`shipped: true`: the project has just shipped), **achievement** / **level-up** / **streak** from the post's `rewards`, **first Props** received (a notification). A Ship Day post gets the badge on the card.

## 10. Search / command palette

| Need | Call |
| --- | --- |
| Search | `GET /api/search?q=…&types=&cursor=&limit=` → `SearchResponse` |

Two or more letters (fewer answers an empty list): ask on every keystroke after a debounce of 150 ms and cancel the request in flight (`signal`). Results are one ranked list; render them grouped by `type` in the order they arrive,
with the first result highlighted for Enter. Paths to build from a hit (the app's routes): `user` → `/profile/{id}`, `project` → `/projects/{id}`, `crew` → `/teams/{id}`, `hackathon` → `/hackathons/{id}`, `post` →
`/posts/{id}`. `types=users` for a mention picker; `types=posts` for a feed search. "Show more" sends `nextCursor` back as `cursor`. A `user` hit has `headline` only when the person made it public: show nothing, not a placeholder,
when it is `null`. Blocked people never appear. No romance profile or post is ever a result.

- **States.** Before typing: recent places and suggestions made in the app (the API has none). No results → "No matches for 'q'" with the other types as links. `429` → keep what is shown and retry quietly after `retryAfter`.
- **Celebrate.** Nothing.

## 11. Leaderboards

`GET /api/leaderboard?period=&scope=&scopeId=&cursor=&limit=` → `LeaderboardResponse`
`{ period, scope, season, entries: [{ rank, score, level, tier, user }], me: { rank, score, hidden }, around, myScopes, nextCursor, pagination? }`.

| Control | Value |
| --- | --- |
| Period tabs | `weekly`, `monthly`, `season` (shows `season.name` and `season.endsAt`), `all-time` |
| Scope picker | `global`, `country`, `city`, `campus`, `crew`. Build it from `myScopes`: a scope whose id is `null` needs the user to set a place first (offer the profile settings), and asking without one is `400` with `details.scopeId`. For `crew` pass the team id as `scopeId` |
| Infinite scroll | send `nextCursor` back as `cursor` until it is `null`. Ranks keep continuing even if scores move. Do not store cursors |
| "You" row | `me.rank` (`null`: not on this board) and `around`; pin them under the list |

A rank is the person's place on the board, the same number for every viewer and the same as the player card's `ranks`. Blocked people are simply left out of **your** list, so ranks can skip (1, 3, 4) and a page can have fewer than
`limit` rows: do not renumber, do not assume row `i` has rank `i + 1`, and keep following `nextCursor` while it is not `null`. People who turned leaderboards off are on no board. Weekly and monthly boards reset at UTC midnight on
Monday and on the 1st. The leaderboard route has a tight rate limit: do not poll it.

- **States.** Empty board (a new campus or city) → "Be the first": show the `me` row anyway. `me.hidden: true` → "You are hidden from leaderboards" with a link to Settings → Privacy. A season between seasons → `season: null`.
- **Realtime.** None.
- **Celebrate.** Climbing is shown by comparing `me.rank` to the last visit (store it locally); the API does not announce rank changes. Season placings arrive as a `COSMETIC_UNLOCKED` notification.

## 12. Quests

`GET /api/quests` → `QuestsResponse` `{ enabled, timezone, daily: { periodKey, resetsAt, quests }, weekly: { … } }`, three of each. Each quest: `{ slug, name, description, xpReward, target, current, completed, completedAt }`.

Render `current / target`, and `resetsAt` as a countdown. The quests are the same all period and on every device: do not cache them past `resetsAt`. There is no "claim": doing the action counts, and the XP arrives with that action's
`rewards.questsCompleted`. Reading earns nothing and no quest asks the user to open or visit anything. If `enabled` is false, hide the page (an operator paused quests).

- **States.** Always three and three, so never empty; `completed` quests stay visible, ticked. Just after local midnight the list changes: refetch when the countdown ends.
- **Celebrate.** **Quest complete** from `rewards.questsCompleted` on whichever action completed it (tick it live, with the XP already in `xpGained`); completing all three of a period is the person's own pleasure, nothing extra is paid.

## 13. Achievements

`GET /api/achievements` (yours) or `GET /api/users/{id}/achievements` → `AchievementsResponse` `{ achievements: [...40], earned, total }`, in display order, each
`{ slug, name, description, icon, category, xpReward, secret, masked, earned, earnedAt, progress: { current, target }, rarity, order }`.

Group by `category` (`BUILDING`, `HACKATHON`, `TEAM`, `REPUTATION`, `STREAK`, `SECRET`); tiered families share a category and read naturally by `order`. Show `progress` as a bar for locked ones. `rarity` is the share of recently active
users who have it (0.02 = 2%); format it as "2% of builders" and treat `null` as "not measured yet". A `masked` item is a secret achievement not yet earned: show a mystery tile with `name` and `description` as given and nothing else.
The share image of an earned one is `/api/og/achievement/{slug}?user={username}` (ask for the address with `GET /api/og/link?kind=achievement&id={slug}&user={username}`).

- **States.** Nothing earned yet → every tile locked with its progress; someone else's page shows the same grid with their earned ones.
- **Celebrate.** **Achievement unlocked**, from `rewards.achievements` on the action that earned it (a toast with the name and the share button) and from the `ACHIEVEMENT_UNLOCKED` notification when the cause was someone else's action.

## 14. Romance mode ("Halves", post-launch)

**Post-launch. It ships closed.** Until an operator opens it for the person's city, every route in this section except `/api/romance/interest` answers `503 ROMANCE_PAUSED` ("{mode} is not open for you yet"), nothing about it appears in
onboarding data, search, notifications, consents or `GET /api/flags`, and the pages must not be in the navigation. Show the **product name from `modeLabel`** (every romance response carries it; it is "Halves" today); never hard-code it.
Rules in [ROMANCE.md](ROMANCE.md); routes in [API.md](API.md#romance). Nothing in this mode is ever shown on a profile, a passport, a feed, a leaderboard or a share card.

### 14a. Before launch: "Notify me when it opens" (this one is live)

| Need | Call |
| --- | --- |
| Am I on the list | `GET /api/romance/interest` → `RomanceInterestState` |
| Add me | `POST /api/romance/interest` (adults only, idempotent; records the profile's country and city) → `RomanceInterestState` |
| Take me off | `DELETE /api/romance/interest` (idempotent) |

Offer it to **adults only** (`403 DATING_UNDERAGE` for a minor, `403 DATING_BIRTH_DATE_REQUIRED` with no date of birth: do not show it to them at all). The page that offers it lives in Settings, not in the main navigation. When it opens for them they get one
notification (`ROMANCE_OPEN`) with the link; nothing else is sent. `409 ROMANCE_ALREADY_OPEN` on a `POST` means it is open for them: go to the profile instead.

### 14b. After launch (build last)

| Page | Calls |
| --- | --- |
| Profile and eligibility (`/matching/preferences`) | `GET /api/romance/profile` → `{ modeLabel, exists, profile, photos, eligibility, options }`; `PUT` (**write**, saves the whole profile; the first call is `201`); `DELETE` (final for their open matches, say so) |
| Consent | `POST /api/users/me/consents { type: "ROMANCE_MODE", version, source: "romance-optin" }` first; `PUT /api/romance/profile` without it is `403 ROMANCE_CONSENT_REQUIRED` (`details.consent`); withdraw with `DELETE /api/users/me/consents/ROMANCE_MODE` |
| Photos | upload with `purpose: "ROMANCE_PHOTO"`, then `POST /api/romance/photos { assetId, blurHash? }`; `DELETE /api/romance/photos/{id}` |
| The weekly drop | `GET /api/romance/drop`; `POST /api/romance/drop/{id}/pass` |
| Sparks | `POST /api/romance/sparks` (**write**, `Idempotency-Key`); `GET /api/romance/sparks/received` |
| Matches and the photo reveal | `GET /api/romance/matches`, `GET /api/romance/matches/{id}`, `POST` / `DELETE /api/romance/matches/{id}/reveal` |
| Duo | `GET` / `POST` / `DELETE /api/romance/duo` |
| Pause | `PUT` the profile with `paused: true` |

Only draw the form when `eligibility.eligible` is `true`; otherwise list `eligibility.blockers` as steps (`BIRTH_DATE_MISSING`, `UNDER_AGE`, `EMAIL_NOT_VERIFIED`, `NO_PHONE_OR_GITHUB`) and show nothing else. The **work comes first**: the
three prompts, ambition, direction, rhythm and obsessions are the top of the form; gender, who they are interested in, the age range, the scope (`CITY`, `COUNTRY`, `ANYWHERE`) and `minEndorsements` sit under a section headed "Private
filters", with the line that they are **never shown to anyone**: they only decide whom the user is shown and who is shown to them, and both sides' filters must accept. `profile.private` comes back to its owner only. The `options`
object holds the choices and the limits; do not hard-code the lists. A person of 16 or 17 never gets the form; do not offer the mode to them at all. The consent screen explains that gender and who they are interested in are sensitive data,
used only to find matches, never shown on the professional side, deleted if they withdraw; an unticked checkbox.

- **States.** `409 ROMANCE_PROFILE_HIDDEN` → "Your profile is hidden while a moderator reviews it"; photo `IN_REVIEW` / `BLOCKED` / `SCANNING` as in [Settings → Photos](#16-settings); `503 MEDIA_SCANNING_UNAVAILABLE` →
  "Photo uploads are unavailable right now". Notifications and push for this mode are deliberately generic ("Activity in a private mode"): never add text to them.
- **Realtime.** The same `user:{me}` channel; the events of this mode are not published yet.
- **Celebrate.** A match, quietly. This mode never pays XP and never touches a streak or a leaderboard, so there is no envelope.

## 15. Notifications

| Need | Call |
| --- | --- |
| The list | `GET /api/notifications?unreadOnly=&cursor=` → `NotificationsResponse` (`unreadCount` for the badge) |
| Mark one / all read | `PATCH /api/notifications/{id}`, `PATCH /api/notifications { all: true }` |
| In-app preferences | `GET` / `PUT /api/notifications/preferences` |
| Delivery channels and quiet hours | `GET` / `PUT /api/notifications/channels` → `NotificationChannelsResponse` |
| Web push | `GET` / `POST` / `DELETE /api/notifications/push`, `DELETE /api/notifications/push/{id}` → `PushDevicesResponse` |
| Report a tapped push | `POST /api/notifications/deliveries/{id}/open` |
| Unsubscribe (token page) | `GET` / `POST /api/notifications/unsubscribe?t=…` |
| Realtime | `user:{me}` (matches); everything else is polled |

Poll `GET /api/notifications?unreadOnly=true` for the badge on focus and every few minutes while the tab is open; a poll that finds nothing new is a `304` with no body (the answer carries an ETag, revalidated every time). A notification's `type` and `metadata.kind` say how to draw it and where to link.
Level-up, tier, achievement, quest and cosmetic notifications are **celebrations that happened to someone who was not looking** (an endorsement paid out, a result was recorded): show them with the badge art, not as plain rows.

**Settings (`/settings/notifications`)** is one page over `GET /api/notifications/channels` (and `PUT`, which answers with the whole picture again):

- **Two global switches** (`settings.emailEnabled`, `settings.pushEnabled`) and **quiet hours** (`settings.quietHours`: `enabled`, `start`, `end` as `"22:00"` local times; they may cross midnight). Say which time zone they follow
  (the profile's, `GET /api/users/me/profile`).
- **Per kind, two switches** (`kinds[].email`, `kinds[].push`): `enabled` is what is on now, `default` what it is until the person chooses, `available: false` means the kind is never sent on that channel (hide the switch; the digests
  are email only). Every kind today is `ACTIVITY` (things people did to you or asked of you, and the two digests); `PROMOTIONAL` is reserved for marketing mail and none exists yet. Show **account and safety notices as a fixed line** that
  cannot be switched ("We always tell you about your account and safety by email"): they are not in `kinds`.
- **Digests** are account mail: on by default, no consent needed. `settings.dailyDigest` and `settings.weeklyDigest` are the person's own switches; every digest email has a one-click unsubscribe. `marketingConsent` is for promotional
  mail, which does not exist yet: do not gate the digest switches on it.
- **Undeliverable mail.** When `email.undeliverable` is true, show a banner: mail to the address bounced or was reported, nothing is sent (not even account notices) until the address changes. When `email.verified` is false, say mail
  only goes to a verified address.
- A kind's label is `label`. The romance mode's kinds are not listed while it is closed.

**Web push.**

1. Register a service worker (`/sw.js`) that handles `push` and `notificationclick`.
2. To enable: ask the browser (`Notification.requestPermission()`, from a click, never on load), `GET /api/notifications/push` for `publicKey`, `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })`,
   then `POST /api/notifications/push` with `subscription.toJSON()` plus a `label` ("Chrome on macOS"). `409 PUSH_DEVICE_LIMIT` (10 devices): show the list so the person can remove one. `400 PUSH_ENDPOINT_NOT_ALLOWED` should not happen from a real browser.
3. List devices from the same `GET` (`devices[]`), remove with `DELETE /api/notifications/push/{id}`. When the person turns push off *in this browser*, `subscription.unsubscribe()` and `DELETE /api/notifications/push { endpoint }`. When
   `configured` is false (development, preview) pushes are recorded and not sent: say so in the UI of those environments.
4. **Payload** (`PushPayload`, `event.data.json()`): `{ title, body, url, tag?, deliveryId }`. Show it with `showNotification(title, { body, tag, data: { url, deliveryId } })`. On `notificationclick`: open `url` (a path in the app), and
   report the tap: `POST /api/notifications/deliveries/{deliveryId}/open` (the push open rate; ignore the answer). Do not add anything to what the payload says.
5. On sign-out, `DELETE /api/notifications/push { endpoint }` for this browser so the next person to sign in on it does not get the previous person's pushes.

**Unsubscribe.** Every optional email links to `GET /api/notifications/unsubscribe?t=…`, which already works and shows a plain page. To replace it with a page of your own, set the links to your route and have that route call
`POST /api/notifications/unsubscribe?t=…` with the same token; show the result and a link to `/settings/notifications`. Nothing there needs a session.

- **States.** Empty → "Nothing yet"; `unreadCount` over 99 → "99+"; an old notification whose target is gone links to a page that answers `404`: show the normal "not found" page.
- **Celebrate.** The celebration notifications above; the ones for a **match** (`MATCH_CREATED`) and **squad formed** (`SQUAD_UPDATE`) open the same screens as the live moment.

## 16. Settings

`/settings/*`: profile, privacy, notifications ([above](#15-notifications)), consent, campus, invites, account.

### Profile and place

`GET` / `PATCH /api/users/me/profile` `{ timezone, countryCode, city, campus, hideFromLeaderboards, showActivity, birthDate? }` → `ProfileSettings`. The `campus` text field becomes read-only while a campus is verified
(`CAMPUS_IS_VERIFIED`). A minor can set a country and nothing finer (`400 MINOR_LOCATION_LIMITED`). The date of birth is read back here, never shown to anyone else, and cannot be changed (`409 BIRTH_DATE_LOCKED`); a correction goes
through support.

### Privacy (`/settings/privacy`)

One page over `GET/PATCH /api/users/me/privacy` → `PrivacySettings`: a visibility picker (Everyone / Connections / Only me) for each passport field in `fieldVisibility`; switches for `hideFromLeaderboards`, `hideFromRecruiters`
("Recruiters" may say "coming soon"), `matchingPaused`, `invisibleMode`, `showActivity`, and **"Show my cards on the web"** (`showCardsOnWeb`: the public share images); and `whoCanMessage` (Everyone / People I'm connected with / Nobody).
PATCH only what changed; the response is the whole state. Blocked and muted people are listed here too (`GET /api/blocks`, `GET /api/mutes`).

**Cards.** When `cardsAvailable` is false (every minor, and every account with no date of birth yet) show the switch **off and disabled** with "Share cards are for accounts 18 and older"; turning it on is `400 CARDS_NOT_AVAILABLE`.
An account that was under 18 at any point **keeps it off** when it turns 18; on the birthday (in their time zone) they get one notification (`CARDS_ADULT`) that says they can turn it on. Never default it on in the UI.

### Share cards

Put the card in the page's metadata so a pasted link previews:

```html
<meta property="og:image" content="https://app.example.com/api/og/post/{id}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
```

Passport `/api/og/passport/{username}`, post `/api/og/post/{id}`, squad recap `/api/og/squad/{teamId}` (after the hackathon has ended), achievement `/api/og/achievement/{slug}?user={username}`. **Do not build these addresses by hand: ask
for them.** `GET /api/og/link?kind=passport|post|squad|achievement&id=...&user=...` (public, no session) answers `{ path, url }` with a version in it (`...?v=3f9a1c2b7d10`) that changes whenever the person, post, squad or achievement is
edited, so a link preview never shows a day-old picture of an edit; use `url` (absolute) in `og:image`. `{ path: null, url: null }` means there is no card: leave the tag out. Call it where the page's metadata is made (server side). A card
that may not be shown is a `404`: do not set the tag for a private or hidden page, or for a person with `showCardsOnWeb` off or who is a minor. The card is a day old at worst; there is no way to purge one. The layout is deliberately plain:
restyle it in `src/lib/og/layout.ts` (the data is `src/lib/og/models.ts`), bump `LAYOUT_VERSION` when you do.

### Consent (onboarding and after a policy change)

Onboarding shows the terms and the privacy notice with an explicit checkbox each, and records each with `POST /api/users/me/consents { type: "TERMS" | "PRIVACY", version, source: "onboarding" }`, `version` from
`GET /api/users/me/consents` (`currentVersion`) → `ConsentsResponse`. `GET /api/users/me` lists what is still needed in `consentRequired`. After a policy change any write can answer `403 CONSENT_REQUIRED` with
`details.consents` (e.g. `["PRIVACY"]`): show a blocking "We've updated our {documents}" dialog with the document, record the acceptance the same way (`source: "settings"`), and retry. Marketing is an optional switch (`MARKETING`).
The romance mode's own consent is part of [its profile flow](#14-romance-mode-halves-post-launch), and is not listed while the mode is closed.

### Export my data

`POST /api/users/me/export` (**write**, `Idempotency-Key`) answers `202` with `status: "PENDING"`; say "We'll notify you when it's ready (usually a few minutes)". The notification (`metadata.kind = "DATA_EXPORT"`) links back here.
`GET /api/users/me/export` shows the latest → `DataExportResponse`: while `PENDING` a spinner, when `READY` a **Download** button on `downloadUrl` (valid until `expiresAt`, 24 hours), `FAILED` "Try again", `404` nothing yet,
`410 EXPORT_EXPIRED` "Expired: ask for a new one".

### Delete account

A danger-zone button with a typed confirmation, then `DELETE /api/users/me`. It needs a recent sign-in: on `403 REAUTH_REQUIRED` run Clerk's reverification (or sign-in) and retry. On `200` sign out and show "Your account was deleted".
Say before they confirm what stays (messages in other people's conversations, shown as from a deleted account; shared projects and crews) and what goes (everything else).

### Photos and avatar

Upload with `purpose: "AVATAR"` (`POST /api/media/uploads`, PUT, `POST /api/media/{id}/complete`). The confirm answers `status: "READY"` when the scan passed (then `PUT /api/users/me/avatar { mediaId }`), `IN_REVIEW` ("We're checking your
photo, it'll show once approved"), `BLOCKED` ("This photo can't be used"), or `SCANNING` (poll `GET /api/media/{id}`). `503 MEDIA_SCANNING_UNAVAILABLE`: "Photo uploads are unavailable right now".

### Invites and campus

- **Invite page** (`/settings/invites`): `GET /api/invites/me` → `InviteStats` gives `code`, `link`, how many `redeemed`, got started (`qualified`) and were `rewarded`, `xpPerInvite` and `rewardsLeft`. Say what earns it: "when a friend
  finishes onboarding and does something real". Do not show who joined.
- **Campus** (`/settings/campus`): `GET /api/campus/me` → `CampusMeResponse`; if `canJoin` is false say campuses are for people 18 and over. Otherwise pick (`GET /api/campuses?q=`, showing `emailDomains`), ask for the campus address,
  `POST /api/campus/verification` (`CAMPUS_EMAIL_INVALID` carries `params.domains`; `CAMPUS_EMAIL_IN_USE` means that mailbox is on another account), then a six-digit field and `POST /api/campus/verification/confirm` (`params.remaining`
  tries; `CAMPUS_CODE_EXPIRED` means ask again). `pending` survives a reload. `suggested` is a campus an invite pointed at: offer it first. Leaving is `DELETE /api/campus/me`. A typed campus no longer joins a board: the campus
  leaderboard and campus feed tab need a verified campus.

- **States.** Every settings page loads its own state and saves on change with an inline "Saved"; a failed save puts the control back. `403 FEATURE_RESTRICTED` on a switch means a moderator restricted that feature.
- **Celebrate.** The invite reward (`xpPerInvite`) arrives as a notification when a friend qualifies; the first verified campus can unlock the campus board. Nothing else here pays.

## 17. Moderation & Admin

The design is in [SAFETY.md](SAFETY.md) and [PRIVACY.md](PRIVACY.md); the endpoints in [API.md](API.md#reports--moderation) and [API.md](API.md#privacy).

### Report, mute, block (menu items on every surface)

Every person, message, post, comment, received spark, romance profile, LFG post, idea and external hackathon gets a **Report** entry in its menu, next to **Mute** and **Block** where a person is involved. It opens a sheet with the
reasons (`HARASSMENT`, `SPAM`, `IMPERSONATION`, `INAPPROPRIATE_CONTENT`, `MINOR_SAFETY`, `SCAM`, `FAKE_PROFILE`, `COPYRIGHT`, `OTHER`; label `MINOR_SAFETY` "A child may be at risk") and an optional description, then
`POST /api/reports { targetType, targetId, reason, description? }` (**write**, `Idempotency-Key`). On `201` say "Thanks, a moderator will look at it"; on `409 REPORT_ALREADY_PENDING` say it was already reported. Offer **Block** after a
report about a person. Never tell the reported person anything.

`POST /api/mutes { userId }` hides the person from the caller's feed, comments, lists and drops without blocking; `DELETE /api/mutes/{userId}` undoes it; `GET /api/mutes` lists them. Copy: "You won't see their posts. They won't know."
`POST /api/blocks { userId, reason? }`, `DELETE /api/blocks/{userId}`, `GET /api/blocks`.

### Moderation notices and appeals (`/settings/account`)

Moderation notices arrive as `SYSTEM` notifications with `metadata.kind = "MODERATION"` and link here. The page reads `GET /api/users/me/moderation` → `ModerationHistoryResponse`: show `state` at the top (suspended until, banned,
which features are restricted until when), then each action with its `category`, `noteToUser`, end date and an **Appeal** button while `canAppeal`. The appeal form posts `POST /api/appeals { actionId, body }` (10 to 5000
characters). Show `GET /api/appeals` for their status and decision.

A suspended or banned account gets `403 ACCOUNT_SUSPENDED` (`params.until`) or `ACCOUNT_BANNED` from nearly everything: route it to this page, which still works, together with the export, delete-account and consent pages.
`403 FEATURE_RESTRICTED` (`params.feature`, `params.until`) means one feature is closed: show "You can't {post / message} until {date}" where that feature's button is, and link here.

### Content refusals and gates on existing pages

| Code | Where | Show |
| --- | --- | --- |
| `400 CONTENT_REJECTED` (`details.reasons`) | composer, comment box, chat input, LFG and idea forms | "This can't be posted as written" with a hint per reason (`LINK_NOT_ALLOWED` / `CONTACT_DETAILS`: "Share links and contact details once you've both written"; `REPEATED`: "You've sent this a few times already") and keep the text |
| `403 EMAIL_VERIFICATION_REQUIRED` | composer (public), comments | "Verify your email to post publicly" with a link to Clerk's verification; followers-only posts still work |
| `403 MESSAGING_NOT_ALLOWED` | "Message" button | "{name} isn't accepting messages" (hide the button when you can) |
| `503 *_PAUSED` | the affected feature | "This is paused for a little while"; nothing to retry immediately |
| `403 SIGNUP_EMAIL_REJECTED`, `429 SIGNUP_RATE_LIMITED`, `503 SIGNUPS_PAUSED` | first screen after sign-up | the message from the error, with sign-out |

### Admin console (staff only; `403` otherwise: hide the whole area. Moderators get the queue and people lookup, the rest is `ADMIN` only)

| Page | Calls |
| --- | --- |
| Queue (`/admin/queue`) | `GET /api/admin/queue` → `QueueResponse` (tabs for reports and appeals); `GET /api/admin/reports/{id}`; `POST /api/admin/actions` (**write**, `Idempotency-Key`); `POST /api/admin/actions/{id}/reverse`; `POST /api/admin/appeals/{id}/decide` |
| People | `GET /api/admin/users?q=`; `GET` / `PATCH /api/admin/users/{id}/risk` → `RiskView`; `PATCH …/role`, `…/verification`; `PUT …/plan`; `POST …/birthdate` (a correction) |
| Fraud | `GET /api/admin/fraud-signals`, `PATCH …/{id}` |
| Audit (admins) | `GET /api/admin/audit` |
| Kill switches and flags (admins) | `GET` / `POST /api/admin/flags`, `GET` / `PATCH` / `DELETE /api/admin/flags/{key}` → `AdminFlag`. The romance launch keys (`romance.enabled`, `romance.city.*`) and the `kill.romance` switch are here; switching one on notifies the people who asked to be told |
| Metrics (`/admin/metrics`) | `GET /api/admin/metrics` → `MetricsResponse`; export `GET /api/admin/metrics/export.csv` |
| Campuses and campaign codes | `GET` / `POST /api/admin/campuses`, `PATCH …/{id}`; `GET` / `POST /api/admin/invites`, `PATCH …/{id}` |
| Hackathons | `PATCH /api/admin/hackathons/{id}/verify { verified }`, `GET …/teams.csv`, `GET …/metrics`, `GET …/peer-reviews` |
| Jobs | `POST /api/admin/jobs/{name}` (run a scheduled job now) |
| The API description | `GET /api/openapi.json` |

Destructive actions answer `403 REAUTH_REQUIRED` when the session is old: reverify and retry.

**Metrics page.** `GET /api/admin/metrics` returns `definitions` (put them in a tooltip on every number) and `rows`. Lead with `weekly_active_shippers` (with `shippers_share_of_wau`) as a line over the last 30 days; then retention as a
cohort table from the latest day's `retention_d1/7/30` rows (dimension = signup week, `detail.cohort` is the size, grey out cells whose `detail.eligible` is small), activation, the matching funnel (spark to match, match to message),
squads, notifications by channel (the dimension), safety, growth by place and invites. A **Demand** group has `romance_interest` (people who asked to be told, by city) and `romance_interest_share_of_adult_actives`: this is the signal
for [turning on Halves](LAUNCH_CHECKLIST.md#turning-on-halves-post-launch). `unit` says how to format (`ratio` as a percent, `hours`, `per1k`). `computedThrough` is the last day measured: say "as of" it.

- **States.** Empty queue → "Nothing to review"; a report already acted on shows its action; metrics before the first snapshot → "Not measured yet".
- **Celebrate.** Nothing; this is a tool.

---

## Other pages: Messages, Projects, Hackathons list, Ship Day

### Messages (`/messages`)

| Need | Call |
| --- | --- |
| Conversation list with tabs and search | `GET /api/conversations?type=&search=&page=&limit=` → `ConversationsResponse` |
| Open a conversation (oldest first within the page) | `GET /api/conversations/{id}?page=&limit=&before=` |
| Send | `POST /api/conversations/{id}` body `{ content, type?, replyToId?, metadata? }` → `SendMessageResponse` (with `rewards`) |
| Start a chat | `POST /api/conversations` body `{ type: 'DIRECT' \| 'GROUP', name?, participantIds: string[] }` (`Idempotency-Key`) |
| Mark read | `POST /api/conversations/{id}/read` body `{ upToMessageId? }` → `MarkReadResponse` |
| Edit / delete own message | `PATCH` / `DELETE /api/messages/{id}` |
| Reactions | `GET` / `POST /api/messages/{id}/reactions` body `{ emoji }` (POST toggles) |

- `type` filter accepts `DIRECT | GROUP | PROJECT | TEAM | HACKATHON`; an unknown value is a `400`. `search` matches the conversation name, its team/project/hackathon name, and the other members' name or username.
- `messages` holds at most one item: the latest message, for the preview line; its `content` is `null` if it was deleted. `unreadCount` counts messages from others that you have not read; `totalUnread` is the sum, for a nav badge.
- Only `DIRECT` and `GROUP` can be created by a client; team, project and hackathon conversations are created with the thing they belong to. A `DIRECT` chat needs exactly one other participant. Sending into a direct conversation with
  someone you have a block with: `403` for the blocker, `404` for the blocked user. A closed (unmatched) conversation is `409 CONVERSATION_CLOSED`.
- Opening `GET /api/conversations/{id}` marks the messages it returns as read. Call `POST …/read` only to mark read without fetching.
- A direct chat's `name` is `null`: show the other member's name. No presence, no typing indicator. **States:** no conversations → "Match with someone to start one"; a deleted message shows "Message deleted".
- **Celebrate.** The first messages can earn XP (5 a day): use `rewards` from the send.

### Projects (`/projects`, `/projects/{id}`)

| Need | Call |
| --- | --- |
| List | `GET /api/projects?status=&search=&techStack=&ownerId=&page=&limit=` → `ProjectsResponse` |
| Detail | `GET /api/projects/{id}` (the project, `owner`, `members[].user`, `hackathon`, the 20 latest `updates`, all `milestones`, `_count`, `isOwner`, `isMember`; a private project is `403` to others) |
| Create | `POST /api/projects { name, description?, shortDesc?, githubUrl?, demoUrl?, websiteUrl?, techStack?, lookingFor?, maxTeamSize?, hackathonId?, isPublic? }` (**write**, `Idempotency-Key`, with `rewards`) |
| Edit / status | `PATCH /api/projects/{id}` (owner or admin; with `rewards`; `SHIPPED` is the ship moment) |
| Progress feed | `GET /api/projects/{id}/updates` → `ProjectUpdatesResponse`; `POST` `{ title, content, type?: 'UPDATE' \| 'ANNOUNCEMENT' }` (members; 10 a minute; with `rewards`) |
| Milestones | `GET`/`POST /api/projects/{id}/milestones` → `MilestonesResponse`, `PATCH`/`DELETE …/{milestoneId}` (PATCH `{ completed: true }`, with `rewards`) |

Progress is not stored: derive `milestones.filter(m => m.completed).length / milestones.length`. `completed` is derived from `completedAt`; send `completed: true|false`, never `completedAt`. Update `type` is `UPDATE | ANNOUNCEMENT | MILESTONE | SHIPPED`;
the last two are written by the system and cannot be edited. Projects owned by someone you have a block with are left out. **States:** no projects → "Start your first build"; no milestones → a starter prompt.
**Celebrate:** milestone done, **shipped** (project status), first update; all via `rewards`.

### Hackathons list (`/hackathons`)

`GET /api/hackathons?status=&search=&page=&limit=` → `HackathonsResponse`; each item is the hackathon plus `_count { participants, teams }`, `registered`, `myTeamId` and `myStatus`
(`REGISTERED | TEAM_FORMED | SUBMITTED | WITHDRAWN | null`). Detail and the rest: [Squads](#8-squads). **States:** none upcoming → "No hackathons yet: add one from its link" (`POST /api/hackathons/external`).

---

## Mock fields that do not exist

For the pages that were first built on mock data. Real field on the right; **no API** means the field should be removed or made cosmetic.

| Mock field | Status |
| --- | --- |
| `online` / presence dot, `typing…` | **No API.** |
| `role` on a person | `builderRole` (nullable) |
| `match` percentage | `compatibility` |
| `avatar` | `image` / `members[].user.image` (nullable, keep an initials fallback) |
| `skills: string[]` | `skills[].skill.name`, with `level` (1-5) and `isVerified` |
| `rank` on a list item | Do not use it (always `0`); the profile's live `rank` or the leaderboard |
| `stars`, `forks`, project `progress` | **No API** (derive progress from milestones) |
| `tags` | `techStack` (projects), `technologies` (hackathons) |
| `owner` as a string | An object; show `owner.name ?? owner.username` |
| `members` as a number | `_count.members` |
| `openSlots` | `maxSize - _count.members` |
| `prize`, `daysLeft` | `prizePool` (free text); compute from the dates |
| `achievement.xp` | `achievement.xpReward` |
| `followers`, `following` counts | `GET /api/users/{id}/followers` / `following` (`pagination.total`) |
| `joined` | `createdAt` |
| `logo` (team or project) | **No API**; only `Project.thumbnail` exists |
| Email on someone else's profile | Never, by design |

## Still missing (no backend, needs a product decision)

| Item | Note |
| --- | --- |
| Presence / typing indicators | A realtime channel exists (`conversation:{id}`) but nothing publishes. |
| Project stars and forks | No data model. |
| Mutual-follow (friends) view | Follows are one-way; connections remain the mutual relationship. |
| Team and project logos | Only `Project.thumbnail` exists. |
| Realtime events beyond matches | Messages, notifications, squad changes: refetch for now. |
| Typed responses for ~170 operations | The spec marks them as untyped objects; add the type to `src/types/api.ts` and `src/lib/openapi/metadata.ts`. |
