# API Reference

Generated from the actual route handlers in `src/app/api/`. Every route except
`GET /api/auth/session`, `POST /api/webhooks/clerk` and `/api/inngest` requires an authenticated
Clerk session: a session token sent as `Authorization: Bearer <token>` or in the
`__session` cookie that Clerk sets in browsers. The token is verified on every request
(signature, expiry and, when configured, authorized party); tokens last about 60 seconds,
so a revoked session can stay valid for up to that long. Routes marked **Auth: none** are the
only exceptions. All request/response bodies are JSON unless noted.

Error responses share one shape, `{ "error": { "code": "MACHINE_CODE", "message": "..." } }`, with
`params` and `details` added when there are any. Branch on `code`; `message` is an English
default and not a stable string. See [Errors](#errors) for the contract and every code.
Validation failures (`400`) return `{ "error": { "code": "VALIDATION_FAILED", "message": "Validation failed", "details": { field: [messages] } } }`.
Unknown request-body keys are stripped, so a client cannot set `id`, `ownerId`, `xp` or `role` by sending them.

Response types for the frontend are exported from `src/types/api.ts`; the page-by-page mapping (which endpoint each screen calls, and which mock fields have no API) is in `docs/FRONTEND_CONTRACT.md`.

**Rate limiting.** Every route is limited per signed-in user (per route family; the limit is listed in the route's handler). Over the limit: `429` with code `RATE_LIMITED` (the seconds to wait are `error.params.retryAfter`) and a `Retry-After` header. Counters live in the shared cache (Redis in production), so the limit holds across instances. If the cache is unavailable, routes keep serving. Signed-out traffic is limited per client address (120 requests a minute), which is only known when `TRUSTED_PROXY_HOPS` says how many reverse proxies to trust (see the README); without it, anonymous callers share one generously sized bucket. A first sign-in, which costs one Clerk API call, is limited to 10 a minute per Clerk account.

**Blocks.** Blocking is stored one way and enforced both ways. The blocked user gets `404` for the blocker's profile, content and conversations, and the blocker is left out of their lists, search, leaderboard and recommendations. The blocker who tries to interact with someone they blocked gets `403 USER_BLOCKED`. The blocked user is never told. Details under **Blocks** below.

**Request ids.** Every response carries an `X-Request-Id` header, and every log line written while the request ran carries the same id, so a report can be matched to the logs. A plausible `X-Request-Id` sent by the caller or a gateway (8 to 64 letters, digits, `.`, `_`, `-`) is kept; anything else is replaced. An unexpected failure inside a handler answers `500 INTERNAL_ERROR` in the usual error shape, never a bare page, and the cause is logged (and sent to Sentry when `SENTRY_DSN` is set), not returned.

**Pagination.** Every list endpoint takes `limit` and either `page` or `cursor`, and answers with `nextCursor` (`null` on the last page). Send `nextCursor` back as `cursor` to get the next page. Cursors are opaque, so do not build or read them; they are cheap at any depth and are not thrown off by rows added while someone pages. A request with `cursor` runs no count, so its answer has no `pagination` object; a `page` request keeps its `pagination` and also carries `nextCursor`, so a client can start with pages and continue with cursors. A cursor that is not valid is `400 INVALID_CURSOR`. Lists whose order is computed or spans several columns (`/api/discover`, `/api/skills`, milestones) use position cursors, which stay valid only while the ordering is unchanged. `/api/leaderboard` uses rank cursors, which remember who held the last rank and so follow them if scores move between pages. Two lists answer with a bare array, `GET /api/users/{id}/skills` and `GET /api/teams/{id}/applications`; they take `limit` (default and maximum 100) and `cursor`, and send the next cursor in the `X-Next-Cursor` header. `GET /api/teams/{id}/candidates` is a short ranked recommendation list (top 10) and is never paged.

**Idempotency.** `POST` routes that create something accept an `Idempotency-Key` header (8 to 128 letters, digits or `. _ : ~ = + -`; a UUID is a good choice). Repeating a request with the same key and the same method, path and body within 24 hours returns the **first response** (same status and body, plus `Idempotent-Replayed: true`) and creates nothing. The same key with a different request is `409 IDEMPOTENCY_KEY_REUSED`; the same key while the first request is still running is `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` with `Retry-After: 1`. Keys belong to the signed-in user. Only successful (2xx) responses are kept: after a failure the same key can be used again. If the cache is unavailable the request is processed without the guarantee. Supported on: projects, teams, hackathons (create and register), team registration for a hackathon, evidence, reports, skills, connections, conversations and messages, project updates and milestones, a user's skills, blocks, team applications and invitations, and feature flags (the admin-only create). A new creating `POST` must opt in with `idempotent: true`; see [ARCHITECTURE.md](ARCHITECTURE.md#api-conventions).

**Rewards.** Routes that can award XP return a `rewards` object next to their normal body (see [GAMIFICATION.md](GAMIFICATION.md)); it is present even when nothing was earned, and carries the user's streak and any achievements and quests the request completed. The type is `RewardsEnvelope` in `src/types/api.ts`.

**Requirements.** PostgreSQL 13 or newer (`gen_random_uuid()` is used when marking messages read).

---

## Auth

Sign-in, sign-up and passwords are Clerk's; there is no register or login route here. The
first authenticated request from a Clerk account creates its local `User` row (or links an
existing legacy row that has the same **Clerk-verified** email), so every route below can
answer these extra statuses through the shared auth layer: `401` for a missing, invalid, expired
or tampered token, or for an account that was deleted; `409 ACCOUNT_CONFLICT` when the verified email
belongs to a local account bound to a different Clerk user (nothing is taken over, the attempt is
audited); `429` when first-time syncs from one Clerk account come too fast; `503` when Clerk's API
cannot be reached during a first sync. Usernames are copied from Clerk; on a collision `_` plus
the first characters of the Clerk id is appended, so sign-in never fails over a name. Linking a
legacy row clears its password hash and its OAuth accounts.

### `GET /api/auth/session`
**Auth:** none (answers `null` when signed out). Compatibility for the frozen UI, which polls this path through `useSession()` in `src/lib/session-client.tsx`. **Response:** `{ user: { id, name, email, image, role }, expires }` with the **local** user id, or `null`. Temporary: remove it when the UI moves to Clerk's hooks.

### `GET /api/users/me`
The caller's own local profile summary. **Response:** `{ id, username, name, email, image, role, headline, verificationLevel, skillCount, ageRequired, isMinor, ageRefused, onboardingComplete }`. `onboardingComplete` is true with a headline, at least one skill and (while `BIRTH_DATE_REQUIRED` is on, the default) a date of birth on file; the middleware and the onboarding page use it, because Clerk's user id is not the local id. `ageRequired` says the date is still missing, `isMinor` that the account is a 16 or 17 year old's (docs/SAFETY.md), `ageRefused` that it was refused for being under 16. The date itself is never part of this response.

### `POST /api/webhooks/clerk`
**Auth:** none; the credential is the Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) over the raw body, made with `CLERK_WEBHOOK_SECRET`, and timestamps more than five minutes off are refused. `503` when the secret is not configured, `400` for any signature failure, `413` over 1 MB, `500` on a transient failure (Clerk then retries). Handles `user.created` and `user.updated` by fetching the user from Clerk and applying its **current** state (the payload is only a notification, so replays and reordering cannot roll anything back), and `user.deleted` by tombstoning: the local row is anonymised and detached from Clerk (email replaced, personal fields cleared, username `deleted_…`, `deletedAt` set) but never deleted, because projects, teams, messages and endorsements cascade from it. Tombstoned accounts are left out of every list and search and refused by the auth layer. Other event types are acknowledged and ignored. **Response `200`:** `{ status: 'synced' | 'tombstoned' | 'conflict' | 'ignored', ... }`.

---

## Users

### `GET /api/users`
Paginated user directory, excludes the caller and anyone blocked in either direction. Query: `page, cursor, limit, search, skills (comma-separated slugs), location`.
**Response:** `{ users: [...], pagination }`

### `PATCH /api/users`
Updates the caller's own profile (no ID param — always self).
**Body (all optional):** `name, bio, headline, location, timezone, availability, builderRole, website, githubUsername, twitterUsername, linkedinUrl, birthDate`

`birthDate` (`"YYYY-MM-DD"`, a real date in the past) is **required to finish onboarding** and is accepted here, with the headline. It is private (never returned by any route but the owner's `GET /api/users/me/profile`, and never written to the audit log), and it is set once: the same date again is fine, another is `409 BIRTH_DATE_LOCKED`. The platform age policy applies (docs/SAFETY.md): under 16 is refused with `403 AGE_BELOW_MINIMUM` (nothing but the moment is kept, and another date is not another chance: the account is closed to everything but `GET /api/users/me`, `GET /api/users/me/profile` and `POST /api/reports` until an admin corrects the date); 16 and 17 make the account a minor's, which clears any city, campus or free-text place already on the profile and refuses new ones (`400 MINOR_LOCATION_LIMITED`; `location` here, and `city` or `campus` in the settings). To correct a locked date a person files `POST /api/reports` with the reason `BIRTHDATE_CORRECTION`.

### `GET /api/users/[id]`
Full profile: skills, skillEvidences (including peer endorsements), achievements, ownedProjects, member projects, owned teams, member teams, currentBuild, plus:
- `email` — **only on your own profile**, never on anyone else's.
- `rank` — live leaderboard position among users you can see (`0` if the user has no XP). The stored `User.rank` column is not maintained and is not used.
- `compatibility` — live score vs. the caller (`null` on your own profile).
- `blockedByMe` — `true` when you have blocked this user.

**Errors:** `404` if the user does not exist or has blocked the caller.

### `GET /api/users/[id]/skills`
List a user's skills. `404` if the user is missing or has blocked the caller.

### `POST /api/users/[id]/skills`
**Auth:** self or `ADMIN`.
**Body:** `{ skillId: string, level?: 1-5, yearsExperience?: number }`
**Errors:** `400` already added, `404` skill not found.

### `PATCH /api/users/[id]/skills/[skillId]`
**Auth:** self or `ADMIN`. Updates `level`/`yearsExperience`.

### `DELETE /api/users/[id]/skills/[skillId]`
**Auth:** self or `ADMIN`.

---

## Discover

### `GET /api/discover`
One-to-one match candidates, ranked by real skill-compatibility score against a bounded recency-ordered pool. Blocked users (either direction) are never returned. Query: `page, cursor, limit, search, skills, location`.
**Response:** `{ people: [{ ...user, compatibility }], pagination }`

---

## Skills

### `GET /api/skills`
Browsable skill catalog (`isActive: true` only), annotated with the caller's own `userLevel`/`isVerified` per skill. Query: `page, cursor, limit, category, search`.

### `POST /api/skills`
**Auth:** `ADMIN`/`MODERATOR`.
**Body:** `{ name, slug?, category, subcategory?, description?, icon?, color? }`

---

## Projects

### `GET /api/projects`
Visibility-scoped listing: public projects, plus (when no `ownerId` filter is given) the caller's own and any they're a member of. Projects owned by a user the caller has a block with (either direction) are left out. Query: `page, cursor, limit, status, search, techStack, ownerId`.

### `POST /api/projects`
Creates a project, `ProjectMember(OWNER)`, and its `PROJECT` conversation atomically, records activity and emits `PROJECT_CREATED`, which pays 50 XP (at most 3 a day, once per project) and the `first-project` achievement. **Response:** the project plus `rewards`.
**Body:** `{ name, description?, shortDesc?, githubUrl?, demoUrl?, websiteUrl?, techStack?(≤20, each ≤50 chars), lookingFor?(≤20, each ≤50 chars), maxTeamSize?(1-10), hackathonId?, isPublic? }`

### `GET /api/projects/[id]`
**Auth:** public project, or owner/member. Returns the project with `owner`, `members`, `hackathon`, the 20 latest `updates`, all `milestones` (by `order`), `_count`, and the flags `isOwner`, `isMember`.

### `PATCH /api/projects/[id]`
**Auth:** owner, member, or `ADMIN`/`MODERATOR` (`authorize()`).
Setting `status: 'SHIPPED'` for the first time (gated on `shippedAt` being null) atomically emits `PROJECT_SHIPPED` (200 XP once per project, and the `first-ship` achievement), writes a `ReputationEvent` and records activity. **Response:** the project plus `rewards` (nothing earned unless this call shipped it).

### `DELETE /api/projects/[id]`
**Auth:** owner or `ADMIN`. Cascades `ProjectMember`; the project's own `Conversation` is deleted too (verified live).

---

## Teams

### `GET /api/teams`
Teams owned by a user the caller has a block with are left out. Query: `page, cursor, limit, search, isRecruiting, hackathonId, skills` (comma-separated, exact-match against `lookingFor` via `hasSome` — distinct from `search`'s substring match).

### `POST /api/teams`
Creates a team, `TeamMember(OWNER)`, and its `TEAM` conversation atomically.
**Body:** `{ name, description?, projectId?, hackathonId?, maxSize?(2-10), lookingFor?(≤20, each ≤50 chars), isRecruiting? }`
**Errors:** `404` if `projectId` isn't owned by the caller or already has a team; `400` if `hackathonId` given and caller isn't registered for it.

### `GET /api/teams/[id]`
**Auth:** owner or member. Includes members, applications, project, hackathon.

### `PATCH /api/teams/[id]`
**Auth:** owner or `ADMIN`.

### `DELETE /api/teams/[id]`
**Auth:** owner or `ADMIN`. Cascades `TeamMember`/`TeamApplication`; sets the team's `Conversation.teamId` to null (preserves message history) rather than deleting it (verified live).

### `POST /api/teams/[id]/transfer-ownership`
**Auth:** current owner or `ADMIN`.
**Body:** `{ newOwnerId: string }` — must already be a team member.
Atomically flips `Team.ownerId`, promotes the new owner's `TeamMember.role` to `OWNER`, demotes the previous owner to `ADMIN`. This is the only real way out of the sole-owner self-removal block (see below) — role-only promotion via `PATCH .../members/[userId]` never touches `Team.ownerId`, which is what every ownership check actually reads.

### `GET /api/teams/[id]/candidates`
**Auth:** owner or `ADMIN`. Recommends non-member, non-applicant users ranked by compatibility with the team's `lookingFor` list.

### `GET /api/teams/[id]/gaps`
**Auth:** the team's owner or an admin of the team (or a platform admin); `403 FORBIDDEN` for anyone else, `404 TEAM_NOT_FOUND`. What the team is missing and who could fill it (see [MATCHING.md](MATCHING.md#gap-finder-teams)): `{ team: { id, name, maxSize, memberCount, openSlots }, needs: { team, project, stack }, missing: { skills, roles }, covered: { skills, roles }, unmatchedStack, candidates }`. `needs` are the team's `lookingFor`, its project's `lookingFor` and its project's tech stack, as written. A need that is a skill of the catalog is a **skill** need (`{ name, slug, sources }`, covered when a member has it; `covered` entries add `memberIds`), anything else is a **role** (`{ name, sources }`, covered when a member's `builderRole` matches); `sources` say where it came from (`TEAM_NEEDS`, `PROJECT_NEEDS`, `PROJECT_STACK`). `unmatchedStack` lists technologies that are not catalog skills. `candidates` are at most five `{ person: MatchPerson, connectionType, score, reasons, fills }`, best first, from the same pool and scorer as the daily drops (so paused, deleted, untrusted and blocked people, and the team's members and applicants, are left out; people who chose only dating never appear); `fills` names the missing skills the person has. Invite one with the existing `POST /api/teams/[id]/invitations`.

### `POST /api/teams/[id]/applications`
Apply to join. **Errors:** `400` team not recruiting or already full (pre-check against `maxSize`), `400` already a member, `400` already applied.
**Body:** `{ message?: string }`

### `GET /api/teams/[id]/applications`
**Auth:** team owner or `ADMIN`.

### `PATCH /api/teams/[id]/applications/[applicationId]`
Three distinct authorization paths depending on the request:
- **`{ status: 'WITHDRAWN' }`** — the applicant only, on their own `PENDING` application (scoped by caller ID; a non-owning caller gets the same 404 as a nonexistent row, so this can't be used to probe other users' application IDs).
- **`{ status: 'ACCEPTED' | 'REJECTED' }` on an owner-sent invitation** (`invitedById` set) — the invitee only.
- **`{ status: 'ACCEPTED' | 'REJECTED' }` on a self-initiated application** — team `OWNER`/`ADMIN` or platform `ADMIN`.

`ACCEPTED` is race-safe: locks the `Team` row, re-counts members against `maxSize`, and (if the team has a linked project) locks the `Project` row and re-counts `ProjectMember`s against `maxTeamSize` — both checked inside the same transaction that flips status and creates `TeamMember`/`ProjectMember`/`ConversationMember`, records activity and emits `TEAM_APPLICATION_ACCEPTED` (50 XP to the applicant, once per application, at most 3 a day, and `team-player`; nothing is paid, achievement included, unless the person who reviewed the application, or sent the invitation, is a trusted counterparty and so is the applicant: an account at least 7 days old with a verified email, not blocked either way; see [GAMIFICATION.md](GAMIFICATION.md#rewards-other-people-trigger-the-trusted-counterparty-gate)). The response carries the caller's own `rewards`. Returns `400 "Team is full"` / `400 "...max team size..."` on either capacity guard.

### `POST /api/teams/[id]/invitations`
**Auth:** team `OWNER`/`ADMIN` or platform `ADMIN`.
**Body:** `{ userId: string, message?: string }` — creates a `TeamApplication` with `invitedById` set; responded to via the endpoint above by the invitee.
**Errors:** `400` already a member, `409` already pending (invited or self-applied).

### `GET /api/teams/applications`
The caller's own applications (sent or received-as-invitation), across all teams. Query: `page, cursor, limit, status`.

### `PATCH /api/teams/[id]/members/[userId]`
**Auth:** team owner or `ADMIN`. Promotes/demotes a `TeamMember.role` (does **not** touch `Team.ownerId` — see transfer-ownership above).
**Body:** `{ role: 'OWNER' | 'ADMIN' | 'MEMBER' }`

### `DELETE /api/teams/[id]/members/[userId]`
**Auth:** team owner, the member themselves (self-removal), or `ADMIN`.
**Errors:** `400` if the caller is removing themselves and is the team's *sole* `OWNER`-role member (promote a second owner or transfer ownership first); `403` if a non-owner tries to remove someone else.

---

## Hackathons

### `GET /api/hackathons`
Public list. Query: `page, cursor, limit, status, search`.
Each item carries the caller's own participation: `registered` (boolean), `myTeamId` (`string | null`) and `myStatus` (`REGISTERED | TEAM_FORMED | SUBMITTED | WITHDRAWN | null`), and `_count: { participants, teams }`.

### `POST /api/hackathons`
**Auth:** `ADMIN`/`MODERATOR`. Creates a hackathon and its `HACKATHON` conversation atomically.
**Body:** `{ name, description, shortDesc?, startDate, endDate, registrationDeadline?, organizer?, websiteUrl?, prizePool?, rules?, technologies?(≤20, each ≤50 chars), maxTeamSize?(1-10, default 5), minTeamSize?(1-10, default 1), location?, isPublic?, thumbnail?, banner? }`

### `GET /api/hackathons/[id]`
Includes the caller's own `HackathonParticipant` row (`participation`).

### `POST /api/hackathons/[id]`
Registers the caller as a participant (only while `UPCOMING` and before `registrationDeadline`). Records activity, notifies, and emits `HACKATHON_JOINED` (100 XP once per hackathon, `first-hackathon`). **Response:** the participant plus `rewards`.
**Body:** `{ skills?: string[], lookingFor?: string[] }`

### `PATCH /api/hackathons/[id]`
**Auth:** `ADMIN`/`MODERATOR`. A `status` change is validated against a forward-only transition map: `UPCOMING → ACTIVE|CANCELLED`, `ACTIVE → ENDED|CANCELLED`; `ENDED`/`CANCELLED` are terminal.

### `DELETE /api/hackathons/[id]`
**Auth:** `ADMIN` only.

### `POST /api/hackathons/[id]/teams`
Registers an already-formed team for the hackathon (caller must already be the team's owner or an accepted member, and registered as a hackathon participant). Idempotent across team members (a second member's call joins the existing registration). Atomically upserts `HackathonTeam`/`HackathonTeamMember`, links the team, adds the caller to the hackathon's own conversation, records activity and emits `TEAM_FORMED` (50 XP once per hackathon, `team-builder`). **Response:** `{ success, teamId, hackathonTeamId, rewards }`.
**Body:** `{ teamId: string, projectId?: string }`
**Errors:** `400` team already full (own `maxSize`), `400` exceeds/below the hackathon's own `maxTeamSize`/`minTeamSize`, `403` not a team member.

### `POST /api/hackathons/[id]/submit`
**Auth:** any member of the team registered for this hackathon. Only while the hackathon is `ACTIVE`. Moves every teammate's `HackathonParticipant.status` to `SUBMITTED` together (one team action, not per-member).
**Body:** `{ teamId: string }`
**Errors:** `400` not `ACTIVE`, `404` team not registered for this hackathon, `403` caller not on the team, `400` team has no linked project.

### `PATCH /api/hackathons/[id]/results`
**Auth:** `ADMIN`/`MODERATOR`. Only once the hackathon has `ENDED`.
**Body:** `{ results: [{ hackathonTeamId, rank, score? }] }`
For every team newly reaching rank `1` (idempotent — re-submitting the same rank doesn't re-fire), every member gets a `HACKATHON_WON` activity entry and a notification, and `HACKATHON_WON` is emitted for each (500 XP once per hackathon, `hackathon-winner`). **Response:** `{ success, results, rewards }`, where `rewards` is the caller's own (the winners are told by notification).

---

## Teams ↔ Hackathons ↔ Projects: Builds

### `GET /api/builds`
Public feed (`isPublic: true`), without builds from users the caller has a block with. Query: `page, cursor, limit, hackathonId`.

### `PUT /api/builds/me`
Full-replacement upsert of the caller's own `CurrentBuild` (one per user). An omitted field resets to its schema default, even on update.
**Body:** `{ title, description?, status?, progress?(0-100), techStack?(≤20, each ≤50), teamSize?(1-20), maxTeamSize?(1-20), rolesNeeded?(≤20, each ≤50), hackathonId?, githubUrl?, demoUrl?, isPublic? }`

### `DELETE /api/builds/me`
Deletes the caller's own `CurrentBuild`. `404` if none exists.

---

## Connections

### `POST /api/connections`
Sends a typed connection request (`TEAMMATE|COLLABORATOR|MENTOR|FRIEND|NETWORK`; `DATING` is no longer accepted: the romance mode is separate). Checks both directions for a conflict — an existing `PENDING` or `ACCEPTED` row either way blocks a new request. Notifies the receiver.
**Body:** `{ receiverId, type?, message? }`
**Errors:** `400` self-connect, `404` receiver not found (also when the receiver has blocked the caller), `403` the caller has blocked the receiver, `400` already connected, `409` already pending.

### `GET /api/connections`
The caller's own connections (sent + received, or filtered). Query: `page, cursor, limit, status, direction ('sent'|'received')`.

### `PATCH /api/connections/[id]`
**Auth:** the connection's `receiverId` only — not the sender.
**Body:** `{ status: 'ACCEPTED' | 'DECLINED' }`
On `ACCEPTED`: atomically finds-or-creates the `DIRECT` conversation between the two users, adds both as members, records activity, notifies the sender and emits `CONNECTION_ACCEPTED` (10 XP to both people, once per connection, at most 5 a day each). **Response:** the connection plus the accepter's own `rewards` (the sender is told by notification). `400` if not currently `PENDING`.

---

## Conversations & Messages

### `GET /api/conversations`
The caller's own conversations, most recently active first. Query: `page, cursor, limit, type (DIRECT|GROUP|PROJECT|TEAM|HACKATHON), search`.
`search` matches (case-insensitively) the conversation name, its team/project/hackathon name, and the other members' name or username.
**Response:** `{ conversations: [{ ...conversation, members, messages (latest one only), _count, unreadCount }], totalUnread, nextCursor, pagination? }`. `unreadCount` counts messages from other senders with no read row for the caller; `totalUnread` is their sum.

### `POST /api/conversations`
Creates a conversation (`DIRECT` requires exactly 1 `participantIds` entry, returns the existing one if a `DIRECT` conversation between the same two users already exists).
**Body:** `{ type?: 'DIRECT' | 'GROUP', name?, participantIds(1-50) }`. Only `DIRECT` and `GROUP` can be created by a client; team, project and hackathon conversations are created with the thing they belong to, and binding one from here is not possible (those keys are stripped, and other `type` values are a `400`).
**Errors:** `400` any participant does not exist; `404` the direct-conversation counterpart has blocked the caller; `403` the caller has blocked them.

### `GET /api/conversations/[id]`
**Auth:** conversation member only. Paginated messages (oldest first within the page), deleted messages masked (`content: null, isDeleted: true`) rather than omitted. Query: `page, cursor, limit(≤100), before (ISO datetime)`. The response's `nextCursor` leads to the next **older** page. Marks exactly the messages returned as read for the caller.

### `POST /api/conversations/[id]`
**Auth:** conversation member only. Sends a message and notifies other members; the message, the notifications and the conversation's activity stamp commit together. The first message ever sent in a direct conversation between two connected people emits `MESSAGE_SENT_FIRST_IN_CONNECTION` (5 XP to the sender, once per conversation, at most 5 a day). **Response:** the message plus the sender's `rewards`. Direct conversations are closed once either side blocks the other (`403` for the blocker, `404` for the blocked user); shared team, project and hackathon rooms stay open.
**Body:** `{ content, type?, replyToId?, metadata? }`

### `POST /api/conversations/[id]/read`
**Auth:** conversation member only. Marks messages from other senders as read for the caller.
**Body (optional):** `{ upToMessageId?: string }` — with it, only messages up to and including that one; without it (or with an empty body), everything.
**Response:** `{ conversationId, readCount, unreadCount }`
**Errors:** `400` `upToMessageId` is not in this conversation.

### `GET /api/messages/[id]/reactions`
**Auth:** member of the message's conversation. **Response:** `{ messageId, reactions: [{ emoji, count, reactedByMe }] }`

### `POST /api/messages/[id]/reactions`
**Auth:** member of the message's conversation. Toggles the caller's reaction: adds it if absent, removes it if present.
**Body:** `{ emoji: string }` — a single emoji.
**Response:** `{ reacted: boolean, reactions: [{ emoji, count, reactedByMe }] }`
**Errors:** `400` deleted message, more than 10 distinct emoji from one user on a message, or more than 30 distinct emoji on a message; `404` when the other side of a direct conversation has blocked the caller.

### `PATCH /api/messages/[id]`
**Auth:** sender only (no admin override — editing someone else's words isn't a moderation action, unlike delete).
**Body:** `{ content }`

### `DELETE /api/messages/[id]`
**Auth:** sender, the conversation's `OWNER`/`ADMIN`, or platform `ADMIN`. Soft delete (`deletedAt` set; content preserved for moderation/audit but masked from all reads).

---

## Notifications

### `GET /api/notifications`
The caller's own. Query: `page, cursor, limit, unreadOnly, type`. Response includes a real `unreadCount`.

### `PATCH /api/notifications`
Bulk mark-all-read. **Body:** `{ all: true }`

### `GET /api/notifications/preferences`
Which kinds of notification the caller gets. **Response:** `{ preferences: [{ kind, label, type, enabled }] }`, for the kinds `SPARK` (each spark, with who sent it, for a plan that shows who) and `SPARK_DIGEST` (the daily count of people who sparked you, for one that does not). Every kind is on until it is switched off.

### `PUT /api/notifications/preferences`
**Body:** `{ preferences: { [kind]: boolean } }`: at least one known kind; the kinds left out keep what they were; unknown keys are refused. **Response:** the same as `GET`. `400 VALIDATION_FAILED`.

### `PATCH /api/notifications/[id]`
Marks one read. **Auth:** the notification's own `userId` (a mismatch returns `404`, not `403`, so it can't be used to probe other users' notification IDs).

---

## Reports & Moderation

### `POST /api/reports`
**Body:** `{ reportedId, reason, description? }`. `reason` is `SPAM`, `HARASSMENT`, `INAPPROPRIATE_CONTENT`, `FAKE_PROFILE`, `SCAM`, `COPYRIGHT`, `OTHER` or `BIRTHDATE_CORRECTION`. The last is a person asking for their own locked date of birth to be corrected: `reportedId` must be the caller (`400 BIRTHDATE_CORRECTION_SELF_ONLY` otherwise), `description` is required (at least 10 characters: what is wrong and what it should be), and it is the one report a person refused for their age may still file. An admin decides with `POST /api/admin/users/{id}/birthdate`.
**Errors:** `400` self-report (every reason but the correction), `404` reported user not found, `409` an identical pending report from this reporter against this target already exists (returns the existing report in `details`).

### `GET /api/reports`
**Auth:** `ADMIN`/`MODERATOR` only (`403` for everyone else, not an empty list). Query: `page, cursor, limit, status`.

### `PATCH /api/reports/[id]`
**Auth:** `ADMIN`/`MODERATOR` only. Forward-only transitions: `PENDING → REVIEWING|RESOLVED|DISMISSED`, `REVIEWING → RESOLVED|DISMISSED`; both terminal states final. Atomically updates status, writes a `ModerationAction` (targeting the report itself) and an `AuditEvent`.
**Body:** `{ status, reason? }`

---

### `POST /api/admin/users/[id]/birthdate`
**Auth:** `ADMIN` only. **Body:** `{ birthDate: "YYYY-MM-DD", reason }` (`reason` 10 to 1000 characters, required; unknown keys are refused). Corrects a person's locked date of birth, whatever it was before (or was not), and clears a refusal for being under 16. The old and the new date and the reason go into the audit trail (`BIRTH_DATE_CORRECTED`); the response never carries a date: `{ id, ageBand: "MINOR"|"ADULT", isMinor, changed }`. A date that would put the person under 16 is not applied (`403 AGE_BELOW_MINIMUM`: a correction cannot admit a child; the account is dealt with through moderation). A correction to 16 or 17 clears the place down to a country. `404 USER_NOT_FOUND`.

## Media

Uploads go straight to object storage with a presigned URL; see ARCHITECTURE.md ("Storage"). Three steps: declare, PUT, confirm.

### `POST /api/media/uploads`
Honours `Idempotency-Key`. **Body:** `{ purpose: "POST_MEDIA"|"ROMANCE_PHOTO", contentType, bytes, width, height, durationMs?, sha256 }` (`sha256` is the lower-case hex SHA-256 of the file; unknown keys are refused). The rules: JPEG, PNG or WebP (IMAGE, at most 10 MB), GIF (at most 15 MB) or MP4/WebM video (at most 100 MB and 120 seconds, `durationMs` required; a duration for anything else is refused); each side 16 to 8000 pixels; a `ROMANCE_PHOTO` must be a JPEG, PNG or WebP of at most 8 MB and at least 400 by 400. **Response `201`:** `{ asset: { id, purpose, status: "PENDING", type, width, height, durationMs }, upload: { method: "PUT", url, headers, expiresAt }, duplicate: false }`; PUT the bytes to `upload.url` with exactly `upload.headers` (they are part of the signature; the URL is good for 10 minutes). If the caller already has a confirmed file with the same hash and purpose: `200 { asset (with url), upload: null, duplicate: true }` and nothing to upload. **Errors:** `400 MEDIA_INVALID` (`details.problems: [{ problem, message }]`, with `problem` one of `TYPE_NOT_ALLOWED`, `TOO_LARGE`, `DIMENSIONS_OUT_OF_RANGE`, `TOO_SMALL`, `DURATION_REQUIRED`, `DURATION_TOO_LONG`, `DURATION_NOT_ALLOWED`, `PURPOSE_TYPE_MISMATCH`), `400 VALIDATION_FAILED`, `429 MEDIA_PENDING_LIMIT` (20 unfinished uploads), `503 STORAGE_UNAVAILABLE`.

### `POST /api/media/[id]/complete`
After the PUT. The server reads the real object and compares its size and type with the declaration. **Response:** `{ id, purpose, status: "READY", type, width, height, durationMs, url }`. Safe to repeat. **Errors:** `404 MEDIA_NOT_FOUND` (also somebody else's), `409 MEDIA_NOT_UPLOADED`, `422 MEDIA_MISMATCH` (`details: { declared, found }`; the object is deleted and the asset rejected, and the same file can be declared again), `503 STORAGE_UNAVAILABLE`.

### `GET /api/media/[id]`
One of the caller's own uploads and where it stands (`url` once `READY`). `404 MEDIA_NOT_FOUND` for anyone else's.

### `PUT /api/media/dev-upload/[...key]`
Development only: the "bucket" of the in-memory storage stand-in (404 `MEDIA_NOT_FOUND` whenever a real bucket is configured or in production). Body: the file's bytes, with its `Content-Type`; the key must start `posts/<callerId>/` or `romance/<callerId>/`. Only the size and type are kept.

## Romance

The romance mode (docs/ROMANCE.md): opt-in, 18+, work first with private filters underneath. Its name in the interface comes from one constant (`modeLabel`, `ROMANCE_MODE_LABEL` in `src/lib/romance/config.ts`); the routes, tables and analytics say "romance". Nothing here is ever part of a professional response (docs/SAFETY.md).

### `GET /api/romance/profile`
The caller's own romance profile. **Response:** `{ modeLabel, exists, profile, photos, eligibility, options }`. `profile` is `null` until they join; otherwise `{ promptObsessed, promptBuild, promptWeekend, ambition (1-4), ambitionLabel, direction, rhythm, obsessions[], private: { gender, genderSelfDescribe, interestedIn[], ageMin, ageMax, scope, minEndorsements }, paused, createdAt, updatedAt }`. **`profile.private` is returned to its owner and to nobody else, anywhere**; its only effect on others is that someone it refuses is never shown. `photos` are the caller's own, with a (signed, short-lived) `url` each. `eligibility` is `{ eligible, blockers[], minAge }` (`BIRTH_DATE_MISSING`, `UNDER_AGE`, `EMAIL_NOT_VERIFIED`, `NO_PHONE_OR_GITHUB`). `options` is the vocabulary of the form (labelled values for `ambition`, `direction`, `rhythm`, `gender`, `scope`, and the `limits`).

### `PUT /api/romance/profile`
Saves the whole profile (what is left out takes its default); the first call joins the mode (`201`), later ones replace it (`200`). **Body (unknown keys refused):** `{ promptObsessed, promptBuild, promptWeekend (each 20 to 500 characters), ambition (1-4), direction ("founder"|"craft"|"research"|"steady-career"|"nomad"|"open"), rhythm ("night-owl"|"early-bird"|"bursty"|"steady"), obsessions?: string[] (up to 12, 2 to 40 characters each, lower-cased, each once), gender ("WOMAN"|"MAN"|"NON_BINARY"|"SELF_DESCRIBED"), genderSelfDescribe? (2 to 40 characters; required exactly when gender is SELF_DESCRIBED), interestedIn: gender[] (at least one, each once), ageMin (18 to 99), ageMax (ageMin to 99), scope ("CITY"|"COUNTRY"|"ANYWHERE"), minEndorsements? (0 to 5, default 0), paused? }`. **Errors:** `403 DATING_BIRTH_DATE_REQUIRED` / `DATING_UNDERAGE` / `DATING_VERIFICATION_REQUIRED` (the 18+ gate; `details.blockers`), `400 VALIDATION_FAILED` (a scope of `CITY` or `COUNTRY` needs a city or a country in the profile settings: `details.scope`).

### `GET /api/romance/drop`
This week's romance drop: **one** person, chosen for the caller once a local ISO week, from Monday 08:00 in the caller's time zone (the job `romance/drops`; someone who joins midweek gets theirs at the next run). **Response:** `{ modeLabel, weekKey, active, drop, nextDropAt }`. `active` is false for someone who has not joined, is paused or no longer passes the gate (and then `drop` is null). `drop` is `{ id, score (0-100), reasons (up to 3 lines: "You're both night-owl builders obsessed with climate tech"), status (NEW|SPARKED|PASSED|EXPIRED), expiresAt, candidate }`, or null when there is none yet, none this week, or the person left, blocked the caller or is gone. `candidate` is as much as a stranger may see: `{ id, name, username, headline, builderRole, level, tier, skills, proof, profile: { promptObsessed, promptBuild, promptWeekend, ambition, ambitionLabel, direction, rhythm, obsessions }, photos: [{ id, position, blurHash, revealed: false }] }`. **There is no photo and no avatar here, only a placeholder with the blur hash the person gave,** and nothing private (gender, age, place, filters, the inbox gate). The first read of a new drop counts one `romance_drop_viewed`. `nextDropAt` is when the next one is made (null while there is nothing to wait for).

### `POST /api/romance/drop/[id]/pass`
Passes on the drop: the person is not shown to the caller again for 120 days. **Response:** `{ id, status: "PASSED" }`; passing twice answers the same. `404 DROP_NOT_FOUND` (also for somebody else's), `409 DROP_NOT_PENDING` for one already sparked or expired.

### `POST /api/romance/sparks`
Honours `Idempotency-Key`. **Body (unknown keys refused):** `{ toId, opener, dropId? }`. Sparks this week's drop, or answers a spark waiting for the caller; when the person had already sparked the caller the two match in the same request (`match` is then the romance match item). The caller must have joined, pass the 18+ gate and be a trusted account (`ROMANCE_PROFILE_REQUIRED`, `DATING_*`, `ROMANCE_ACCOUNT_TOO_NEW`); the person must be one both people's private filters allow, who passes the gate, and whom the caller was shown in an open drop (or who sparked them): every other case is `404 SPARK_TARGET_UNAVAILABLE`, so no filter can be probed. The inbox gate does not apply to a reply. Limits: `ROMANCE_SPARKS_PER_WEEK` (3 for everyone while plans are not enforced; `429 ROMANCE_SPARK_LIMIT_REACHED`) and 8 an hour (`SPARK_THROTTLED`). Also `400 SPARK_OPENER_REJECTED`, `403 USER_BLOCKED`, `404 USER_NOT_FOUND`, `409 SPARK_ALREADY_SENT`, `409 MATCH_EXISTS`, `409 MATCH_ENDED`. A romance match announces no event and counts toward no achievement.

### `GET /api/romance/sparks/received`
Romance sparks waiting for the caller: `{ modeLabel, canSee, count, sparks, nextCursor }`. Who sent them needs `SEE_WHO_SPARKED`; without it `{ canSee: false, count, sparks: [] }`. A sender is shown as a candidate is (no photo, no avatar, nothing private). Query: `limit`, `cursor`.

### `GET /api/romance/matches`
The caller's open romance matches, newest first: `{ modeLabel, matches: [{ id, createdAt, conversationId, other }], nextCursor, total }` (`other` as a drop's candidate; `reveal.status` is `NONE`, `PENDING_MINE`, `PENDING_THEIRS`, `ACCEPTED`, `DECLINED` or `REVOKED`). Query: `limit`, `cursor`. To leave: `DELETE /api/matches/{id}`; to report and leave: `POST /api/matches/{id}/report`. Both are final and silent.

### `GET /api/romance/matches/[id]`
One open romance match of the caller's; anything else is `404 MATCH_NOT_FOUND`.

### `POST /api/romance/photos`
Honours `Idempotency-Key`. **Body (unknown keys refused):** `{ assetId, blurHash? }`: attaches a confirmed upload of the caller's (`POST /api/media/uploads` with `purpose: "ROMANCE_PHOTO"`, then `/complete`) at the end of their photos; `blurHash` is a BlurHash string the client made, shown in place of the photo to anybody who may not see it. **Response `201`:** `{ id, position }`. Photos come back to their owner only (`GET /api/romance/profile`). `400 ROMANCE_PROFILE_REQUIRED`, `404 MEDIA_NOT_FOUND` (not the caller's, not ready, or another purpose), `400 ROMANCE_PHOTO_LIMIT` (6), `400 VALIDATION_FAILED`.

### `DELETE /api/romance/photos/[id]`
Removes one of the caller's photos and its upload, and closes the gap in the order. `404 MEDIA_NOT_FOUND` for anyone else's.

### `POST /api/romance/matches/[id]/reveal`
Agrees to share photos with the other person of an open romance match: asks them, or accepts when they have already asked (two asks at the same moment are an agreement). Honours `Idempotency-Key`; safe to repeat. **Response:** `{ matchId, status }` from the caller's side: `PENDING_MINE` or `ACCEPTED`. Until both have agreed, the other person's photos in every response are placeholders `{ id, position, blurHash, revealed: false }` and their avatar is absent; once `ACCEPTED` they are `{ id, position, blurHash, revealed: true, url (signed, short-lived), width, height }` and `other.image` is present. `404 MATCH_NOT_FOUND` for anyone not in the match, an ended match or a professional one.

### `DELETE /api/romance/matches/[id]/reveal`
Withdraws: cancels the caller's own ask, declines the other's (`DECLINED`), or revokes an accepted reveal (`REVOKED`), at once and for both. Safe to repeat. Ending the match revokes it too. Either person may ask again later.

### `GET /api/romance/duo`
The caller's Duo, a page two people of a romance match share by consent. **Response:** `{ duo }`, `null` or `{ id, status ("PENDING"|"ACTIVE"), requestedByMe, partner: { id, name, username, headline }, shared }`. `shared` is set only while ACTIVE: `{ projects: [{ id, name, slug, status, shortDesc }] (projects both are members of), heatmap: { timezone, from, to, items: [{ date, xp, actions }], partnerActivityHidden } }`, the two people's XP per day added up on the caller's own days. A partner who turned "show activity" off contributes nothing (`partnerActivityHidden: true`). The Duo page is for the two of them only: it is on no profile, passport, feed or leaderboard.

### `POST /api/romance/duo`
Honours `Idempotency-Key`. **Body:** `{ matchId }` (unknown keys refused). Asks the other person of that open romance match to form a Duo, or accepts when they have already asked. **Response:** `{ id, status }`. `404 MATCH_NOT_FOUND` (not in the match, ended, or not a romance match), `409 DUO_BUSY` (either is in another active Duo).

### `DELETE /api/romance/duo`
Dissolves the caller's Duo, or declines or cancels a pending one, at once and for both. **Response:** `{ dissolved }`. Ending the match dissolves it too. (Build Dates, the first date as a small collaboration, are Phase 2: only their model exists; no route.)

### `DELETE /api/romance/profile`
Leaves the mode: the profile, its photos (and their uploads), every drop for or of the caller and every pending romance spark of theirs are removed, and their open romance matches are **ended for good and silently** (the conversation is closed for both; nobody is notified). **Response:** `{ left: true, hadProfile, matchesEnded }`. Safe to repeat. Being removed for an admin correction of the date of birth to 16 or 17, or by deleting the account, does the same.

## Posts & Feed

Long form in `docs/FEED.md`. A post is `{ id, kind, title, body, links, media[], stackTags, visibility, shipDay, author, coAuthors[], project, teamId, propsScore, propsCount, commentCount, yourProps, revision, createdAt, editedAt }`; the body is sanitized markdown (no raw HTML, only http and https links). Anything the caller may not see (followers-only, crew-only, a block either way, deleted) is `404 POST_NOT_FOUND`.

### `POST /api/posts`
Honours `Idempotency-Key`. **Body:** `{ kind: SHIP|UPDATE|DEVLOG|DEMO, title (3-120), body (1-10000), projectId?, teamId?, links? (5), mediaIds? (confirmed POST_MEDIA uploads of the caller), stackTags? (10), coAuthorIds? (5, members of the project or crew), visibility?: PUBLIC|FOLLOWERS|CREW }` (unknown keys refused). A `SHIP` post needs a `projectId`; the first one for a project ships it and pays once through the one ship gate, later ones are plain posts. An `UPDATE` or `DEVLOG` on a project is a project update (its XP and daily cap). `CREW` needs a project or crew. The author must belong to the project or crew. A post made on the author's Friday carries the `shipday` tag. **Response `201`:** `{ post, shipped }`. **Errors:** `400 POST_INVALID_CONTEXT`, `400 POST_COAUTHOR_NOT_MEMBER`, `404 MEDIA_NOT_FOUND`, `400 VALIDATION_FAILED`.

### `GET /api/posts`
The caller's own posts, newest first. **Query:** `cursor?`, `limit?` (1-50, default 20). **Response:** `{ posts, nextCursor }`.

### `GET /api/posts/[id]`
One post. `404 POST_NOT_FOUND`.

### `PATCH /api/posts/[id]`
Author only. **Body:** any of `title, body, links, stackTags, visibility`. Counts a revision (`revision`, `editedAt`). A co-author is `403 FORBIDDEN`; anyone else `404 POST_NOT_FOUND`.

### `DELETE /api/posts/[id]`
Soft delete by the author or an admin. **Response:** `{ deleted: true }`; `404 POST_NOT_FOUND` otherwise.

### `POST /api/posts/[id]/props` and `DELETE /api/posts/[id]/props`
Give or take back Props. Honours `Idempotency-Key`; giving twice answers `200` with `created: false`. **Response:** `{ propsScore, propsCount, yourProps, created? }`. `403 CANNOT_PROP_OWN_POST`, `404 POST_NOT_FOUND`. A giver the trust gate does not trust adds no weight and earns the author nothing.

### `GET /api/posts/[id]/comments` and `POST /api/posts/[id]/comments`
List (oldest first, replies nested one level, blocked authors left out; `cursor`, `limit`) and create. **Body:** `{ body (1-2000), parentId? }`. Honours `Idempotency-Key`. `400 COMMENT_REPLY_DEPTH` (reply to a reply), `404 COMMENT_NOT_FOUND`, `404 POST_NOT_FOUND`.

### `PATCH /api/comments/[id]` and `DELETE /api/comments/[id]`
Edit your comment within 15 minutes (`403 COMMENT_EDIT_WINDOW_CLOSED`, `params.minutes`) or soft-delete it (author or admin). `404 COMMENT_NOT_FOUND` for anyone else's.

### `POST /api/users/[id]/follow` and `DELETE /api/users/[id]/follow`
Follow or unfollow. Honours `Idempotency-Key`; repeating answers the same. **Response:** `{ following }`. `400 CANNOT_FOLLOW_SELF`, `403 USER_BLOCKED`, `404 USER_NOT_FOUND`.

### `GET /api/users/[id]/followers` and `GET /api/users/[id]/following`
Newest first, `cursor`/`limit`. **Response:** `{ people: [{ id, username, name, image, level, tier, followedAt }], nextCursor }`. People with a block in either direction are left out.

### `POST /api/projects/[id]/watch` and `DELETE /api/projects/[id]/watch`
Watch or stop watching a project; its new posts reach the watcher as one notification per project per hour. **Response:** `{ watching }`. `404 PROJECT_NOT_FOUND`.

### `GET /api/projects/[id]/timeline` and `GET /api/users/[id]/posts`
Posts newest first, only those the caller may see. `cursor`, `limit`. **Response:** `{ posts, nextCursor }`. `404 PROJECT_NOT_FOUND` (also a private project to a non-member), `404 USER_NOT_FOUND`.

### `GET /api/feed`
**Query:** `tab=for-you|following|city|campus` (default `for-you`), `cursor?`, `limit?` (1-50, default 20). **Response:** `{ tab, posts, nextCursor }`. Ranked (docs/FEED.md); at most two posts per author per page; blocked and hidden authors removed. `400 INVALID_CURSOR` for a cursor that is malformed or too old.

### `GET /api/ship-day`
**Response:** `{ isShipDay, startsAt, endsAt, dateKey, weekKey, todayCount, yourShips[], topPosts[], lastRecap }` for the Friday of the caller's own time zone (`endsAt` is the end of that Friday in their zone; before it starts `todayCount` is 0 and `topPosts` is empty). `lastRecap` is `{ weekKey, dateKey, totalPosts }` of the latest finished Ship Day, or `null`.

## Leaderboard

### `GET /api/leaderboard`
Ranks people by the XP they earned in a **period** on a **scope**. The boards are Redis sorted sets kept current by every award and rebuilt each night from the XP log (see [GAMIFICATION.md](GAMIFICATION.md#leaderboards)); the request does not sum the log.
**Query:** `period` = `weekly` | `monthly` | `season` | `all-time` (default); `scope` = `global` (default) | `country` | `city` | `campus` | `crew`; `scopeId` (country `IN`, city `IN:bengaluru`, campus `iisc-bangalore`, crew: a team id; for the first three it defaults to the caller's own place, for `crew` it is required); `limit` (1 to 100, default 50); `cursor` (the previous `nextCursor`) or `page`. Weeks and months are UTC.
Users blocked in either direction are left out of the list but nobody is renumbered: a rank is a person's place on the board, the same for every viewer and the same as `ranks` on their player card, so the caller's list can skip a rank (1, 3, 4) and a page can hold fewer than `limit` entries (a page covers `limit` consecutive ranks). `pagination.total` counts everybody on the board. People who switched leaderboards off (`PATCH /api/users/me/profile`) are on no board.
**Response:** `{ period, scope: { type, id }, season, entries: [{ rank, score, xp, level, tier, user }], me: { rank, score, xp, hidden }, around: [...], myScopes: { country, city, campus }, nextCursor, pagination? }`. `xp` repeats `score` for older clients. `me.rank` is `null` when the caller is not on the board (no XP in the period, or hidden). `around` is the caller and the two above and two below. `season` describes the season for `period=season` and is `null` otherwise. A `page` request also carries `pagination`. People with equal scores keep one order (by user id, descending).
**Errors:** `400 VALIDATION_FAILED` for a bad `period`, `scope`, `scopeId` or limit, and for a scope the caller has not set and did not name (`details.scopeId`); `400 INVALID_CURSOR`; `404 TEAM_NOT_FOUND` for a crew that does not exist.

---

## Progression

Streaks, achievements, quests, the player card, cosmetics and seasons. The rules are in [GAMIFICATION.md](GAMIFICATION.md).

### `GET /api/users/me/profile`
The caller's location and privacy settings: `{ timezone, countryCode, city, campus, hideFromLeaderboards, showActivity, birthDate }`. Nothing is created by reading; a user who never saved gets the defaults (`timezone`, `countryCode`, `city`, `campus`, `birthDate` null; `hideFromLeaderboards` false; `showActivity` true). `birthDate` (`YYYY-MM-DD`) is **private**: this read, for the owner, is the only place any route returns it.

### `PATCH /api/users/me/profile`
**Body (at least one):** `{ timezone?(IANA name or null), countryCode?(ISO 3166-1 alpha-2 or null), city?(≤200, free text or null), campus?(≤200, free text or null), hideFromLeaderboards?, showActivity?, birthDate? }`. Unknown keys are refused. `birthDate` is a real date in the past; it is set once and then locked (a different date afterwards is `409 BIRTH_DATE_LOCKED`, the same date again is fine, and it cannot be cleared). It is used only to check that someone is 18 or older for dating (see [MATCHING.md](MATCHING.md)) and is wiped when the account is deleted. Text is tidied and given a comparable key (see Leaderboards). `timezone` decides which day a streak, a quest and a daily cap use. A change of place or of `hideFromLeaderboards` queues a job that moves the person's entries on the boards; `showActivity: false` hides the heatmap and the streak from everyone else. **Response:** the settings.

### `GET /api/users/[id]/heatmap`
**Query:** `days` (1 to 365, default 365). XP and actions per **local day of the profile owner**, for days that had any, oldest first: `{ timezone, days, from, to, hidden, items: [{ date, xp, actions }] }`. `actions` counts what the person did; the XP of the achievements and quests it led to adds to `xp` only. Cached 10 minutes and retired by every award. `404 USER_NOT_FOUND` for a missing or deleted user, or one who has blocked the caller (the person who blocked can still open it); `hidden: true` with no items when the owner keeps their activity private (never for your own).

### `GET /api/users/[id]/stats`
The player card in one call: `{ userId, xp, level, tier, progress, ranks: { global, country, city }, equipped: { title, frame, banner, badges },  streak, topAchievements, counts: { shipped, hackathons, wins, endorsementsReceived, crews, milestones } }`. Cached 60 seconds and retired by every award. `ranks` are absolute places on the all-time boards (`null` where the person is not on one). `streak` is `null` on somebody else's card when they keep their activity private. `404 USER_NOT_FOUND` as for the heatmap.

### `GET /api/achievements`
All 40 achievements in order with the caller's standing: `{ achievements: [{ slug, name, description, icon, category, xpReward, secret, masked, earned, earnedAt, progress: { current, target }, rarity, order }], earned, total }`. Not paged (the catalog is fixed). The six secret achievements are `masked` until earned: placeholder slug `secret-<order>`, no text, reward, progress or rarity. `rarity` is the share of users active in the last 30 days who have it (0 to 1, null until the nightly job has run).

### `GET /api/users/[id]/achievements`
The same list for another person (earned, and how far along they are in the rest; secret ones masked). `404 USER_NOT_FOUND` for a missing or deleted user or one who has blocked the caller.

### `GET /api/quests`
The caller's three daily and three weekly quests: `{ enabled, timezone, daily: { periodKey, startsAt, resetsAt, quests }, weekly: { ... } }`, each quest `{ slug, name, description, type, xpReward, target, current, completed, completedAt }`. The quests are the same all period and on every device, and follow from the user and the period. Reading writes nothing and earns nothing; doing the action counts, and the response of that action lists `questsCompleted`. With the `quests` flag off, `enabled` is false and both lists are empty.

### `GET /api/users/me/cosmetics`
The cosmetic catalog with the caller's inventory: `{ equipped: { title, frame, banner, badges }, cosmetics: [{ slug, type, name, description, rarity, slot, owned, masked, equipped, unlockedAt, requirement, order }], owned, total }`. Read only. Cosmetics are earned and cannot be bought, granted or requested. Those earned by a secret achievement are `masked` until owned. The catalog is the fixed cosmetics plus the ones a finished season gave the caller (`season-N-top-100` title, `season-N-top-1-percent` and `season-N-top-10-percent` frames, `season-N-participant` badge with `type: "BADGE"` and `slot: "badges"`), so `total` is the fixed catalog plus however many season cosmetics the caller owns.

### `PATCH /api/users/me/equipped`
**Body (at least one):** `{ title?, frame?, banner?, badges? }`. `title`, `frame` and `banner` are a cosmetic slug or `null`; `badges` is an array of up to three badge slugs, each once, in display order (it replaces the list; `[]` clears it; more than three or a duplicate is `400 VALIDATION_FAILED`). Each slug must be owned by the caller and belong in that slot, or the whole request is refused: `403 COSMETIC_NOT_OWNED` (also for an unknown slug), `400 COSMETIC_WRONG_SLOT`. A slot left out is unchanged. **Response:** `{ equipped }`.

### Seasons
There is no season route: the active season rides in `GET /api/leaderboard?period=season` (`season: { id, number, name, startsAt, endsAt }`). The job `seasons/rollover` closes it and writes `SeasonStanding` rows (run it with `POST /api/admin/jobs/seasons/rollover`).

---

## Blocks

### `POST /api/blocks`
Blocks a user. One transaction: creates the block, deletes any connection between the pair, and withdraws pending team applications and invitations between them. Idempotent: blocking again returns `200` with the existing block.
**Body:** `{ userId: string, reason?: string(≤500) }`
**Response `201`** (`200` if it already existed): `{ block: { id, createdAt, reason, user }, severedConnections, withdrawnApplications, endedMatches }`
**Errors:** `400` blocking yourself, `404` user not found.

### `GET /api/blocks`
The caller's own block list, newest first. Query: `page, cursor, limit`. **Response:** `{ blocks: [{ id, createdAt, reason, user }], nextCursor, pagination? }`. The list shows only who the caller blocked, never who blocked the caller.

### `DELETE /api/blocks/[userId]`
Removes the caller's block on that user. Severed connections and withdrawn applications are not restored.

Where blocks are enforced (either direction unless noted): discover, user directory, team candidates, leaderboard, dashboard recommendations, project/team/build browse lists, user profile, user skills, evidence lists, activity feed, connection requests, team applications and invitations, direct conversations (create and send), reactions in direct conversations, and endorsements.

---

## Skill Evidence & Endorsements

Evidence is attached to a skill the user has added to their profile. A peer endorsement is a row on the same table (`type: 'PEER_ENDORSEMENT'`, `metadata: { endorsedEvidenceId, endorserId }`), written only by the endorse endpoint.

### `GET /api/evidence`
Query: `page, cursor, limit(≤50), userId (default: the caller), skillId`. Endorsement rows are not listed; each evidence item carries `endorsementCount` and `endorsedByMe`.
**Response:** `{ evidence: [{ id, userId, skillId, type, title, description, url, verifiedAt, createdAt, skill, endorsementCount, endorsedByMe }], pagination }`
**Errors:** `404` user not found or has blocked the caller.

### `POST /api/evidence`
Creates evidence for the caller. Records activity and emits `EVIDENCE_ADDED` (20 XP once per piece of evidence, at most 3 a day, and `first-evidence`). **Response:** the evidence plus `rewards`.
**Body:** `{ skillId, type: 'GITHUB_PROJECT' | 'PORTFOLIO' | 'CERTIFICATION' | 'CONTRIBUTION', title(≤200), url? (http/https, ≤2048), description?(≤2000) }` (unknown keys are rejected)
**Errors:** `400` the caller has not added that skill, or already has 20 pieces of evidence on it.

### `DELETE /api/evidence/[id]`
**Auth:** the evidence owner (`403` otherwise). Deleting evidence also removes the endorsements on it. **Response:** `{ success: true }`

### `POST /api/evidence/[id]/endorse`
Endorses someone else's evidence, once per endorser (enforced under a transaction-scoped advisory lock). Notifies the owner and records activity on first endorsement. Every endorsement counts toward `endorsementCount`, but the reward (10 XP to the owner, once per endorser and evidence, and the `endorsed` achievement, paid through the `EVIDENCE_ENDORSED` event) is only granted when the endorser is verified (`verificationLevel` above `NONE`: a password sign-up stays `NONE` until the account signs in through an OAuth provider), at most 10 rewards per endorser per rolling day, and at most 10 endorsement payments per recipient per local day. Nothing is paid for endorsing yourself or across a block (both are refused).
**Response:** `{ endorsed: true, endorsementCount }` — `201` when created, `200` if already endorsed.
**Errors:** `403` your own evidence; `403` you have blocked the owner; `404` missing, an endorsement row, or the owner has blocked you.

### `DELETE /api/evidence/[id]/endorse`
Removes the caller's endorsement. **Response:** `{ endorsed: false, endorsementCount }`.

---

## Project Progress

### `GET /api/projects/[id]/updates`
**Auth:** anyone who can read the project (public, owner or member). Query: `page, cursor, limit(≤50)`.
**Response:** `{ updates: [{ id, projectId, title, content, type, createdAt, author }], nextCursor, pagination? }`

### `POST /api/projects/[id]/updates`
**Auth:** project owner or member. Limited to 10 per minute per user. Notifies the other members, records activity and emits `PROJECT_UPDATE_POSTED` (15 XP per update, at most 3 a day, and `first-update` on the caller's first). **Response:** the update plus `rewards`.
**Body:** `{ title(≤200), content(≤10000), type?: 'UPDATE' | 'ANNOUNCEMENT' }` (`MILESTONE` and `SHIPPED` updates are written by the system).

### `PATCH /api/projects/[id]/updates/[updateId]`
**Auth:** the update's author (while still a member), or a platform admin. System-generated updates cannot be edited (`400`).
**Body:** `{ title?, content? }`

### `DELETE /api/projects/[id]/updates/[updateId]`
**Auth:** the author, the project owner, or a platform admin.

### `GET /api/projects/[id]/milestones`
**Auth:** anyone who can read the project. Query: `page, cursor, limit(≤50)`. Ordered by `order`.
**Response:** `{ milestones: [{ id, projectId, title, description, dueDate, completedAt, completed, order, createdAt, updatedAt }], nextCursor, pagination? }`

### `POST /api/projects/[id]/milestones`
**Auth:** owner or member. At most 100 per project (`400`).
**Body:** `{ title(≤200), description?(≤5000), dueDate? }`

### `PATCH /api/projects/[id]/milestones/[milestoneId]`
**Auth:** owner or member.
**Body (at least one):** `{ title?, description?(nullable), dueDate?(nullable), order?, completed?: boolean }`. Send `completed`, never `completedAt`. Completing a milestone for the first time records activity and emits `MILESTONE_COMPLETED` (30 XP once per milestone, at most 5 a day, and `first-milestone`); repeating it does not. **Response:** the milestone plus `rewards`.

### `DELETE /api/projects/[id]/milestones/[milestoneId]`
**Auth:** owner or member.

---

## Activity

### `GET /api/activity`
A user's activity feed, newest first. Query: `page, cursor, limit(≤50), userId (default: the caller), type`.
Your own feed is complete. Another user's feed shows entries with no project (achievements, team and hackathon milestones), entries on public projects, and entries on projects the caller is a member of.
**Response:** `{ activity: [{ id, userId, type, title, description, link, metadata, createdAt, project }], nextCursor, pagination? }`
**Errors:** `404` user not found or has blocked the caller.

---

## Dashboard

### `GET /api/dashboard`
Everything the dashboard page shows, through the same rules as every other endpoint. Blocked users and their teams never appear in recommendations. The same data is available to a server component as `getDashboardData(prisma, userId)` from `src/lib/dashboard.ts`.
**Response:** `{ currentBuild, userProjects (active, ≤5), userTeams, hackathonParticipations, userQuests, recentActivities, xpEvents, userSkills, recommendedBuilders (with compatibility and commonSkills), recruitingTeams, upcomingHackathons }`

---

## Matching

The matching engine's profile and quiz. The rules (scoring, daily drops, anti-spam) are in [MATCHING.md](MATCHING.md); the romance mode's are in [ROMANCE.md](ROMANCE.md).

### `GET /api/matching/quiz`
The fixed working-style quiz: `{ version, questions: [{ id, prompt, options: [{ id, label }] }] }`. The options of a question are ordered from one end of a spectrum to the other. Answers go in `workingStyle` of the profile as `{ [questionId]: optionId }`; any subset of the questions may be answered.

### `GET /api/matching/profile`
The caller's matching profile: `{ exists, profile }`. `profile` is `{ connectionTypes, intentTags, hoursPerWeek, availableFrom, remoteOk, cityOnly, lookingForSkills, workingStyle, dropTimeLocal, paused }`, with defaults (and no connection types) until the first save; nothing is created by reading.

### `PUT /api/matching/profile`
Saves the whole profile (what is left out takes its default). **Body:** `{ connectionTypes: ("COFOUNDER"|"HACKATHON_TEAMMATE"|"COLLABORATOR"|"MENTOR"|"MENTEE")[] (1 to 5, each once; `DATING` is refused: the romance mode has its own profile), intentTags?: { tag, hackathonId?, expiresAt? }[] (≤10; tag is 2 to 40 characters of a-z, 0-9 and "-"; expiresAt is a future ISO 8601 instant within a year), hoursPerWeek?: 1..100|null, availableFrom?: "YYYY-MM-DD"|null, remoteOk?, cityOnly?, lookingForSkills?: string[] (skill slugs, ≤20, each must exist), workingStyle?: { [questionId]: optionId }, dropTimeLocal?: "HH:MM" (default "09:00", in the caller's own time zone), paused? }`. Unknown keys are refused. **Response:** the same as `GET`. `400 VALIDATION_FAILED` (an unknown skill or hackathon is reported in `details`).

**The romance mode is not a type here.** `DATING` (the storage key of a romance match) is refused with `400 VALIDATION_FAILED`; join the romance mode with `PUT /api/romance/profile` (see [ROMANCE.md](ROMANCE.md)). The 18+ gate (`403 DATING_BIRTH_DATE_REQUIRED`, `DATING_UNDERAGE`, `DATING_VERIFICATION_REQUIRED`) applies there.

### `GET /api/drops/today`
The caller's daily drops for their own current date: `{ date, drops, hasProfile, paused, dropTimeLocal, nextDropAt }`. Each drop is `{ id, connectionType, score (0-100), reasons (≤3 lines), status (NEW|SPARKED|PASSED|EXPIRED), secondLook, expiresAt, candidate: { id, name, username, image, headline, builderRole, location, level, tier, skills (top 5), proof: { verifiedEvidence, shipped } } }`, best first. Someone who has been blocked either way since, or whose account is gone, is left out. The first read of a new drop counts one `drop_viewed`. `hasProfile: false` means the caller has not saved a matching profile (show the setup). `nextDropAt` is when the next drops arrive, to the hour (an hourly job makes them); `null` while paused or without a profile. Drops are made by the job `drops/generate`, not by this request, so it can be empty early in the day.

### `POST /api/drops/{id}/pass`
Passes on a drop: the person is not shown to the caller again for 30 days. **Response:** `{ id, status: "PASSED" }`; passing twice returns the same. `404 DROP_NOT_FOUND` for a drop that does not exist or is not the caller's; `409 DROP_NOT_PENDING` for one already sparked or expired.

### `POST /api/sparks`
Sends a spark. Honours `Idempotency-Key`. **Body:** `{ toId, connectionType, opener, dropId? }`: `connectionType` is the caller's side (`MENTEE` to spark a mentor); `opener` is 20 to 280 characters (judged by the opener rules, so the refusal says why); `dropId`, when sparking from a drop, must be the caller's own open drop for that person. Unknown keys are refused. **Response `201`:** `{ spark: { id, toId, connectionType, opener, status, createdAt }, match: MatchItem | null }`; `match` is set when the person had already sparked the caller with the counterpart type (the two are matched in the same request, with a conversation, notifications and a realtime push). Sparks and matches pay no XP. **Errors:** `400 CANNOT_SPARK_SELF`, `400 MATCHING_PROFILE_REQUIRED`, `400 SPARK_TYPE_NOT_CHOSEN`, `400 SPARK_OPENER_REJECTED` (`details: { reason, message }`), `403 USER_BLOCKED`, `404 USER_NOT_FOUND`, `404 SPARK_TARGET_UNAVAILABLE`, `404 DROP_NOT_FOUND`, `409 DROP_NOT_PENDING`, `409 SPARK_ALREADY_SENT`, `409 MATCH_EXISTS`, `409 MATCH_ENDED`, `429 SPARK_LIMIT_REACHED` (`params.limit`), `429 SPARK_THROTTLED` (`params.retryAfter`).

### `GET /api/sparks/received`
**Query:** `limit` (1 to 50, default 20), `cursor`. The caller's unanswered sparks, newest first: `{ canSee, count, sparks: [{ id, connectionType, opener, createdAt, from: MatchPerson }], nextCursor }`. `connectionType` is the sender's side; answer with a spark of the counterpart type. Who sparked and what they wrote needs the `SEE_WHO_SPARKED` entitlement: without it `canSee` is `false`, `sparks` is `[]` and only `count` is returned. Senders blocked either way, or gone, are not counted. `400 INVALID_CURSOR`.

### `GET /api/matches`
**Query:** `limit` (1 to 50, default 20), `cursor`. The caller's open matches, newest first: `{ matches: [{ id, connectionType, yourRole, theirRole, createdAt, conversationId, other: MatchPerson }], nextCursor, total }`. A match that ended, or is with someone blocked either way or gone, is not listed.

### `DELETE /api/matches/{id}`
Unmatches. Final: the conversation is closed for both people (readable, but posting it is `409 CONVERSATION_CLOSED`) and the pair can never be matched, dropped to each other or sparked again. Either person can do it; doing it twice answers the same. **Response:** `{ id, endedAt }`. `404 MATCH_NOT_FOUND` for a match that does not exist or is not the caller's. The other person gets a realtime `match.ended` on their `user:{id}` channel.

### `POST /api/matches/{id}/report`
Unmatch and report in one call. Honours `Idempotency-Key`. **Body:** `{ reason: SPAM|HARASSMENT|INAPPROPRIATE_CONTENT|FAKE_PROFILE|SCAM|COPYRIGHT|OTHER, description? (≤5000) }`. The match ends as for `DELETE`, and a report against the other person is filed in the same queue as `POST /api/reports` (`metadata: { source: "MATCH", matchId }`). If the caller already has a pending report against them it is kept: `alreadyReported: true`. **Response `201`:** `{ matchId, endedAt, report: { id }, alreadyReported }`.

### Realtime and notifications
A new match sends the notification type `MATCH` (`metadata: { kind: "MATCH_CREATED", matchId, conversationId, connectionType }`) to both people and publishes `match.created` `{ matchId, conversationId, connectionType }` on each `user:{id}` channel. An ended match publishes `match.ended` `{ matchId }` to the other person. `POST /api/blocks` also ends the open matches between the two and answers `endedMatches`.

### Jobs
`drops/generate` (hourly; without a payload it only dispatches `drops/generate-batch` jobs for everybody due and answers `{ due, zones, batches }`; payload `{ userIds?: string[] }` generates for exactly those people right away, whether or not they are due), `romance/drops` (hourly at :25; the weekly romance drop; like `drops/generate` it only dispatches `romance/drops-batch` jobs unless a payload `{ userIds }` names people) and `romance/drops-batch` (`{ userIds }`), `drops/generate-batch` (enqueued by the dispatcher; payload `{ userIds: string[] }`, 1 to 1000; generates for those of them who are due), `drops/expire` (hourly) and `drops/second-look` (Mondays 07:15 UTC; payload `{ userIds?: string[] }`; gives each person at most one previously passed candidate who has grown, as an extra drop with `secondLook: true`) are run on demand with `POST /api/admin/jobs/drops/generate`, `/expire` and `/second-look`. A payload the job's own schema refuses is `400 VALIDATION_FAILED`.

## Realtime

### `POST /api/realtime/token`
**Auth:** required. **Rate limit:** 30 a minute per user. Issues a short-lived (15 minute), **subscribe-only** token request for the realtime provider (Ably), bound to the caller as client id. The provider's API key never leaves the server; the browser passes `tokenRequest` to the provider's client, which exchanges it for a token and asks for a new one when it expires.

**Body (optional):** `{ channels?: string[] }`, 1 to 20 names. With no body, or no `channels`, the token covers the caller's own `user:<id>` channel.

| Channel | Who may subscribe |
| --- | --- |
| `user:<userId>` | That user only |
| `conversation:<id>` | Members of the conversation |
| `team:<id>` | Members of the team |

Any other name, a wildcard, or a channel the caller may not read refuses the **whole** request: `403 CHANNEL_FORBIDDEN` with `details: { denied: string[] }`, and no token. A `400 VALIDATION_FAILED` for a malformed body.

**Response `200`:** `{ tokenRequest, channels, expiresAt }`. `tokenRequest` is the signed request (`keyName`, `clientId`, `capability`, `timestamp`, `nonce`, `mac`, `ttl`); `capability` is JSON granting `["subscribe"]` on each listed channel and nothing else, so a browser cannot publish. Only the server publishes. Without an Ably key (development, tests) the response has the same shape with an unsigned stand-in.

## Background jobs

### `GET | POST | PUT /api/inngest`
**Auth:** none of ours. Inngest calls this route to discover and run the jobs declared in `src/lib/infra/jobs.ts`, and authenticates each request with its signature (`INNGEST_SIGNING_KEY`, required in production). Not for application clients. In development, without keys, `GET` answers a short description of the registered functions.

---

## Platform

### `GET /api/health`
**Auth: none.** For uptime monitors and load balancers. Reports whether each dependency answers and which implementation is in use, and nothing else (no hosts, keys or versions). `status` is `ok`; `degraded` when the cache, jobs or realtime check fails (still `200`, since the app keeps serving); or `down` when the database does not answer (`503`). Each check has 2 seconds. Limited to 300 requests a minute per client address. Responses are never cached.
**Response:** `{ status: 'ok' | 'degraded' | 'down', time, checks: { database, cache, jobs, realtime } }`, each check `{ status: 'ok' | 'down', provider: 'postgres' | 'memory' | 'upstash' | 'inngest' | 'ably', latencyMs? }`. The jobs check reports its configuration only, since probing it would mean enqueueing real work.

### `GET /api/flags`
Every feature flag with its answer for the caller: `{ flags: { "new-feed": true, ... } }`. Only keys and booleans: rollout percentages and allowlists stay with the admins. Read once per session; answers can be up to 30 seconds old on a deployment with several instances.

### `GET /api/admin/flags`
**Auth:** `ADMIN`. Flags ordered by key. Query: `limit(≤100, default 50), cursor`. **Response:** `{ flags: [{ key, description, enabled, rolloutPercent, allowUserIds, updatedById, createdAt, updatedAt }], nextCursor }`

### `POST /api/admin/flags`
**Auth:** `ADMIN`. **Body:** `{ key, description?(≤300), enabled?(default false), rolloutPercent?(0-100, default 100), allowUserIds?(≤500) }`. `key` is 2 to 64 characters: lower-case letters, digits, `-`, `_` or `.`, starting with a letter. `201` with the flag; `409 FLAG_EXISTS`.

### `GET /api/admin/flags/[key]`
**Auth:** `ADMIN`. `404 FLAG_NOT_FOUND`.

### `PATCH /api/admin/flags/[key]`
**Auth:** `ADMIN`. **Body (any of):** `{ description?(nullable), enabled?, rolloutPercent?, allowUserIds? }`. The change reaches users immediately (the cached flag set is dropped, which on Redis reaches every instance) and is written to the audit log with the old and new values.

### `DELETE /api/admin/flags/[key]`
**Auth:** `ADMIN`. **Response:** `{ success: true }`. Audited.

A flag is **on for a user** when they are on its `allowUserIds` (even while it is disabled), or it is `enabled` and the user falls inside the rollout: `rolloutPercent` 100 is everyone, a lower value is a stable share of users chosen by a hash of the flag key and the user id. Raising the percentage only adds users. A flag that does not exist is off.

### `POST /api/admin/jobs/{area}/{action}`
**Auth:** `ADMIN`. Runs one of the background jobs declared in `src/lib/infra/jobs.ts` (for example `seasons/rollover`, whose `result` is `{ closed, ..., rewards: [...] }`: the cosmetics granted for each season that was owed them) right now, inside the request, exactly as the queue would run it: the payload is validated by the job's own schema. **Body (optional):** `{ data?: {...} }`; no body runs the job with its defaults. **Response:** `{ name, durationMs, result }`, where `result` is what the job returned. `404 JOB_NOT_FOUND` for a name that is not in the registry. Limited to 30 a minute and written to the audit log (`JOB_RUN`). This is how an operator triggers a rebuild or a rollover outside its schedule, and how a deployment without the job queue runs them.

---

## Errors

Every error response, from every route, has this shape:

```json
{ "error": { "code": "TEAM_FULL", "message": "Team is full" } }
```

| Field | Present | Meaning |
| --- | --- | --- |
| `error.code` | always | A stable `MACHINE_CODE` from the table below. Codes are only ever added, never reused for a different meaning. Branch on this. |
| `error.message` | always | The English default for the code, with `params` filled in. Not a stable string: do not match on it. |
| `error.params` | when the message has values in it | The values the message interpolates, such as `{ "max": 20 }`. To show another language, render your own text from `code` and `params`. |
| `error.details` | when there is structured extra data | `VALIDATION_FAILED`: `{ field: string[] }`. `CONNECTION_PENDING` and `REPORT_ALREADY_PENDING`: the existing record. `CHANNEL_FORBIDDEN`: `{ denied: string[] }`. |

The HTTP status comes from the code. Rate limited (`429`) and temporarily unavailable (`503`) responses
also send `Retry-After`. The catalog is `ERROR_CATALOG` in `src/lib/api/errors.ts`; this table is generated from it
and a unit test fails if a code is missing here.

| Code | Status | Default message |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | Authentication required |
| `FORBIDDEN` | 403 | You do not have permission to do this |
| `VALIDATION_FAILED` | 400 | Validation failed |
| `INVALID_JSON` | 400 | The request body is not valid JSON |
| `MISSING_PARAMETER` | 400 | Missing required parameter: {parameters} |
| `PAYLOAD_TOO_LARGE` | 413 | The request body is too large |
| `RATE_LIMITED` | 429 | Too many requests. Try again in {retryAfter} seconds |
| `SERVICE_UNAVAILABLE` | 503 | The service is temporarily unavailable. Try again shortly |
| `AUTH_UNAVAILABLE` | 503 | Authentication is temporarily unavailable |
| `ACCOUNT_CONFLICT` | 409 | This email belongs to a different account |
| `INTERNAL_ERROR` | 500 | Something went wrong |
| `INVALID_CURSOR` | 400 | The cursor is not valid. Start again without a cursor |
| `IDEMPOTENCY_KEY_INVALID` | 400 | The Idempotency-Key header must be 8 to 128 letters, digits or . _ : ~ = + - |
| `IDEMPOTENCY_KEY_REUSED` | 409 | This Idempotency-Key was already used for a different request |
| `IDEMPOTENCY_REQUEST_IN_PROGRESS` | 409 | A request with this Idempotency-Key is still being processed |
| `WEBHOOK_NOT_CONFIGURED` | 503 | Webhook is not configured |
| `WEBHOOK_SIGNATURE_MISSING` | 400 | Missing signature headers |
| `WEBHOOK_SIGNATURE_INVALID` | 400 | Invalid signature |
| `WEBHOOK_PROCESSING_FAILED` | 500 | Processing failed |
| `CHANNEL_FORBIDDEN` | 403 | You cannot subscribe to one or more of these channels |
| `USER_NOT_FOUND` | 404 | User not found |
| `REPORTED_USER_NOT_FOUND` | 404 | Reported user not found |
| `PROJECT_NOT_FOUND` | 404 | Project not found |
| `PROJECT_NOT_OWNED` | 404 | Project not found or not owned by you |
| `MILESTONE_NOT_FOUND` | 404 | Milestone not found |
| `UPDATE_NOT_FOUND` | 404 | Update not found |
| `TEAM_NOT_FOUND` | 404 | Team not found |
| `MEMBER_NOT_FOUND` | 404 | Member not found |
| `APPLICATION_NOT_FOUND` | 404 | Application not found |
| `APPLICATION_NOT_PENDING` | 404 | Application not found or already resolved |
| `HACKATHON_NOT_FOUND` | 404 | Hackathon not found |
| `TEAM_NOT_IN_HACKATHON` | 404 | This team is not registered for this hackathon |
| `CONNECTION_NOT_FOUND` | 404 | Connection not found |
| `CONVERSATION_NOT_FOUND` | 404 | Conversation not found |
| `MESSAGE_NOT_FOUND` | 404 | Message not found |
| `NOTIFICATION_NOT_FOUND` | 404 | Notification not found |
| `EVIDENCE_NOT_FOUND` | 404 | Evidence not found |
| `SKILL_NOT_FOUND` | 404 | Skill not found |
| `USER_SKILL_NOT_FOUND` | 404 | Skill not found for user |
| `REPORT_NOT_FOUND` | 404 | Report not found |
| `BUILD_NOT_FOUND` | 404 | No current build found |
| `USER_BLOCKED` | 403 | You have blocked this user |
| `CANNOT_BLOCK_SELF` | 400 | You cannot block yourself |
| `CANNOT_CONNECT_SELF` | 400 | You cannot connect with yourself |
| `CANNOT_REPORT_SELF` | 400 | You cannot report yourself |
| `CANNOT_ENDORSE_OWN_EVIDENCE` | 403 | You cannot endorse your own evidence |
| `USERS_NOT_FOUND` | 400 | One or more users were not found |
| `CONNECTION_EXISTS` | 400 | Already connected with this user |
| `CONNECTION_PENDING` | 409 | A connection request is already pending between you and this user |
| `CONNECTION_ALREADY_RESOLVED` | 400 | Connection is already {status} |
| `REPORT_ALREADY_PENDING` | 409 | You already have a pending report against this user |
| `REPORT_INVALID_TRANSITION` | 400 | Cannot transition report from {from} to {to} |
| `DIRECT_CONVERSATION_PARTICIPANTS` | 400 | Direct conversations require exactly 1 participant |
| `READ_MARKER_NOT_IN_CONVERSATION` | 400 | upToMessageId does not belong to this conversation |
| `MESSAGE_DELETED` | 400 | This message has been deleted |
| `REACTION_LIMIT_PER_USER` | 400 | You can add at most {max} different reactions to one message |
| `REACTION_LIMIT_PER_MESSAGE` | 400 | A message can have at most {max} different reactions |
| `SKILL_ALREADY_ADDED` | 400 | Skill already added |
| `EVIDENCE_SKILL_NOT_ON_PROFILE` | 400 | You can only attach evidence to a skill you have added to your profile |
| `EVIDENCE_LIMIT_REACHED` | 400 | You can attach at most {max} pieces of evidence to one skill |
| `MILESTONE_LIMIT_REACHED` | 400 | A project can have at most {max} milestones |
| `SYSTEM_UPDATE_IMMUTABLE` | 400 | System-generated updates cannot be edited |
| `PROJECT_HAS_TEAM` | 400 | Project already has a team |
| `NOT_TEAM_MEMBER` | 403 | Not a team member |
| `ALREADY_TEAM_MEMBER` | 400 | Already a member of this team |
| `TEAM_FULL` | 400 | Team is full |
| `TEAM_PROJECT_FULL` | 400 | This team's linked project is already at its max team size |
| `TEAM_NOT_RECRUITING` | 400 | Team is not recruiting |
| `ALREADY_APPLIED` | 400 | Already applied to this team |
| `APPLICATION_ALREADY_REVIEWED` | 400 | Application already reviewed |
| `INVITATION_PENDING` | 409 | An invitation to this user is already pending |
| `APPLICATION_PENDING` | 409 | This user already has a pending application to this team |
| `CANNOT_REMOVE_OWNER` | 403 | Cannot remove team owner |
| `SOLE_OWNER_CANNOT_LEAVE` | 400 | Cannot leave: you're the sole owner. Promote another member or delete the team first |
| `ALREADY_OWNER` | 400 | That user is already the owner |
| `NEW_OWNER_NOT_MEMBER` | 400 | The new owner must already be a team member |
| `HACKATHON_REGISTRATION_REQUIRED` | 400 | You must be registered for this hackathon |
| `HACKATHON_ALREADY_REGISTERED` | 400 | Already registered |
| `HACKATHON_REGISTRATION_CLOSED` | 400 | Registration closed |
| `HACKATHON_REGISTRATION_DEADLINE_PASSED` | 400 | Registration deadline passed |
| `HACKATHON_INVALID_TRANSITION` | 400 | Cannot transition hackathon from {from} to {to} |
| `HACKATHON_NOT_ENDED` | 400 | Results can only be recorded once the hackathon has ended |
| `HACKATHON_SUBMISSIONS_CLOSED` | 400 | Submissions are only open while the hackathon is active |
| `HACKATHON_TEAM_MISMATCH` | 400 | One or more teams do not belong to this hackathon |
| `HACKATHON_TEAM_REGISTRATION_CLOSED` | 400 | Team registration closed |
| `ALREADY_IN_HACKATHON_TEAM` | 400 | Already in a team for this hackathon |
| `TEAM_WRONG_HACKATHON` | 400 | Team belongs to a different hackathon |
| `TEAM_NO_PROJECT` | 400 | This team has no linked project to submit |
| `HACKATHON_TEAM_TOO_LARGE` | 400 | Team exceeds this hackathon's max team size of {max} |
| `HACKATHON_TEAM_TOO_SMALL` | 400 | Team is below this hackathon's min team size of {min} |
| `FLAG_NOT_FOUND` | 404 | Feature flag not found |
| `FLAG_EXISTS` | 409 | A feature flag with this key already exists |
| `JOB_NOT_FOUND` | 404 | No such job |
| `COSMETIC_NOT_OWNED` | 403 | You have not earned this cosmetic |
| `COSMETIC_WRONG_SLOT` | 400 | This cosmetic does not go in that slot |
| `DATING_BIRTH_DATE_REQUIRED` | 403 | Add your date of birth in your profile settings to use {mode} |
| `DATING_UNDERAGE` | 403 | {mode} is only available to people who are 18 or older |
| `DATING_VERIFICATION_REQUIRED` | 403 | {mode} needs a verified email and either a verified phone number or a connected GitHub account |
| `BIRTH_DATE_LOCKED` | 409 | Your date of birth is already set and cannot be changed |
| `AGE_BELOW_MINIMUM` | 403 | You need to be at least {minAge} to use Skill Dating |
| `BIRTH_DATE_REQUIRED` | 400 | Your date of birth is required |
| `MINOR_LOCATION_LIMITED` | 400 | Accounts for people under 18 can share a country, not a city, campus or place |
| `BIRTHDATE_CORRECTION_SELF_ONLY` | 400 | A date of birth correction is a request about your own account |
| `STORAGE_UNAVAILABLE` | 503 | Uploads are not available right now |
| `MEDIA_NOT_FOUND` | 404 | Media not found |
| `MEDIA_INVALID` | 400 | That file cannot be uploaded |
| `MEDIA_PENDING_LIMIT` | 429 | You have too many unfinished uploads. Finish or wait for them to expire |
| `MEDIA_NOT_UPLOADED` | 409 | The file has not been uploaded yet |
| `MEDIA_MISMATCH` | 422 | The uploaded file is not what was declared |
| `DROP_NOT_FOUND` | 404 | Drop not found |
| `DROP_NOT_PENDING` | 409 | This drop has already been answered or has expired |
| `CANNOT_SPARK_SELF` | 400 | You cannot spark yourself |
| `MATCHING_PROFILE_REQUIRED` | 400 | Set up your matching profile first |
| `SPARK_TYPE_NOT_CHOSEN` | 400 | You have not chosen this type of connection in your matching profile |
| `SPARK_TARGET_UNAVAILABLE` | 404 | This person is not available to spark |
| `SPARK_ALREADY_SENT` | 409 | You have already sparked this person for this type of connection |
| `SPARK_OPENER_REJECTED` | 400 | That opener cannot be sent |
| `SPARK_LIMIT_REACHED` | 429 | You have used all {limit} of your sparks for today. More arrive tomorrow |
| `SPARK_THROTTLED` | 429 | You are sending sparks too fast. Try again in a little while |
| `ROMANCE_PROFILE_REQUIRED` | 400 | Join {mode} first |
| `ROMANCE_ACCOUNT_TOO_NEW` | 403 | Your account needs to be a week old, with a verified email, to send a {mode} spark |
| `ROMANCE_SPARK_LIMIT_REACHED` | 429 | You have used all {limit} of your {mode} sparks for this week. More arrive on Monday |
| `ROMANCE_PHOTO_LIMIT` | 400 | You can have at most 6 photos |
| `DUO_BUSY` | 409 | One of you is already in a Duo. Dissolve it first |
| `MATCH_NOT_FOUND` | 404 | Match not found |
| `MATCH_EXISTS` | 409 | You are already matched with this person |
| `MATCH_ENDED` | 409 | This match has ended and cannot be started again |
| `CONVERSATION_CLOSED` | 409 | This conversation has been closed |
| `POST_NOT_FOUND` | 404 | Post not found |
| `POST_INVALID_CONTEXT` | 400 | The project or crew does not fit this post |
| `POST_COAUTHOR_NOT_MEMBER` | 400 | Co-authors must be members of the project or crew |
| `CANNOT_PROP_OWN_POST` | 403 | You cannot give Props to your own post |
| `COMMENT_NOT_FOUND` | 404 | Comment not found |
| `COMMENT_REPLY_DEPTH` | 400 | You can reply to a comment, not to a reply |
| `COMMENT_EDIT_WINDOW_CLOSED` | 403 | A comment can only be edited for {minutes} minutes after it is posted |
| `CANNOT_FOLLOW_SELF` | 400 | You cannot follow yourself |

---

## Notes on scope

- **Challenges/ChallengeAttempt, CurrentBuild.maxTeamSize as a real cap on anything, VerificationRequest beyond the GitHub sign-in path, and precomputed Leaderboard snapshots** have schema support but no further routes than what's documented above — flagged during this session's audits as either out of scope for the current build or requiring a product decision not yet made (e.g. Challenges needs sandboxed code execution, a security decision).
- Every route above using a URL-path ID (`.pathname.split('/').pop()` style, not a typed Next.js dynamic param) was checked in this session's input-validation sweep: a malformed ID returns a clean `404`/`403`, never a raw `500`.
