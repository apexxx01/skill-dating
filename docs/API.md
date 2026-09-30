# API Reference

Generated from the actual route handlers in `src/app/api/`. Every route except
`GET /api/auth/session` and `POST /api/webhooks/clerk` requires an authenticated
Clerk session: a session token sent as `Authorization: Bearer <token>` or in the
`__session` cookie that Clerk sets in browsers. The token is verified on every request
(signature, expiry and, when configured, authorized party); tokens last about 60 seconds,
so a revoked session can stay valid for up to that long. Routes marked **Auth: none** are the
only exceptions. All request/response bodies are JSON unless noted.

Error responses share one shape: `{ "error": string, "details"?: unknown }`.
Validation failures (`400`) return `{ "error": "Validation failed", "details": { field: [messages] } }`.
Unknown request-body keys are stripped, so a client cannot set `id`, `ownerId`, `xp` or `role` by sending them.

Response types for the frontend are exported from `src/types/api.ts`; the page-by-page mapping (which endpoint each screen calls, and which mock fields have no API) is in `docs/FRONTEND_CONTRACT.md`.

**Rate limiting.** Every route is limited per signed-in user (per route family; the limit is listed in the route's handler). Over the limit: `429 { error }` with a `Retry-After` header in seconds. If the limiter's store is unavailable, routes keep serving. Signed-out traffic is limited per client address (120 requests a minute), which is only known when `TRUSTED_PROXY_HOPS` says how many reverse proxies to trust (see the README); without it, anonymous callers share one generously sized bucket. A first sign-in, which costs one Clerk API call, is limited to 10 a minute per Clerk account.

**Blocks.** Blocking is stored one way and enforced both ways. The blocked user gets `404` for the blocker's profile, content and conversations, and the blocker is left out of their lists, search, leaderboard and recommendations. The blocker who tries to interact with someone they blocked gets `403 "You have blocked this user"`. The blocked user is never told. Details under **Blocks** below.

**Requirements.** PostgreSQL 13 or newer (`gen_random_uuid()` is used when marking messages read).

---

## Auth

Sign-in, sign-up and passwords are Clerk's; there is no register or login route here. The
first authenticated request from a Clerk account creates its local `User` row (or links an
existing legacy row that has the same **Clerk-verified** email), so every route below can
answer these extra statuses through the shared auth layer: `401` for a missing, invalid, expired
or tampered token, or for an account that was deleted; `409 { error }` when the verified email
belongs to a local account bound to a different Clerk user (nothing is taken over, the attempt is
audited); `429` when first-time syncs from one Clerk account come too fast; `503` when Clerk's API
cannot be reached during a first sync. Usernames are copied from Clerk; on a collision `_` plus
the first characters of the Clerk id is appended, so sign-in never fails over a name. Linking a
legacy row clears its password hash and its OAuth accounts.

### `GET /api/auth/session`
**Auth:** none (answers `null` when signed out). Compatibility for the frozen UI, which polls this path through `next-auth/react`'s `useSession()`. **Response:** `{ user: { id, name, email, image, role }, expires }` with the **local** user id, or `null`. Temporary: remove it when the UI moves to Clerk's hooks.

### `GET /api/users/me`
The caller's own local profile summary. **Response:** `{ id, username, name, email, image, role, headline, verificationLevel, skillCount, onboardingComplete }`. `onboardingComplete` is true with a headline and at least one skill; the middleware and the onboarding page use it, because Clerk's user id is not the local id.

### `POST /api/webhooks/clerk`
**Auth:** none; the credential is the Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) over the raw body, made with `CLERK_WEBHOOK_SECRET`, and timestamps more than five minutes off are refused. `503` when the secret is not configured, `400` for any signature failure, `413` over 1 MB, `500` on a transient failure (Clerk then retries). Handles `user.created` and `user.updated` by fetching the user from Clerk and applying its **current** state (the payload is only a notification, so replays and reordering cannot roll anything back), and `user.deleted` by tombstoning: the local row is anonymised and detached from Clerk (email replaced, personal fields cleared, username `deleted_…`, `deletedAt` set) but never deleted, because projects, teams, messages and endorsements cascade from it. Tombstoned accounts are left out of every list and search and refused by the auth layer. Other event types are acknowledged and ignored. **Response `200`:** `{ status: 'synced' | 'tombstoned' | 'conflict' | 'ignored', ... }`.

---

## Users

### `GET /api/users`
Paginated user directory, excludes the caller and anyone blocked in either direction. Query: `page, limit, search, skills (comma-separated slugs), location`.
**Response:** `{ users: [...], pagination }`

### `PATCH /api/users`
Updates the caller's own profile (no ID param — always self).
**Body (all optional):** `name, bio, headline, location, timezone, availability, builderRole, website, githubUsername, twitterUsername, linkedinUrl`

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
One-to-one match candidates, ranked by real skill-compatibility score against a bounded recency-ordered pool. Blocked users (either direction) are never returned. Query: `page, limit, search, skills, location`.
**Response:** `{ people: [{ ...user, compatibility }], pagination }`

---

## Skills

### `GET /api/skills`
Browsable skill catalog (`isActive: true` only), annotated with the caller's own `userLevel`/`isVerified` per skill. Query: `page, limit, category, search`.

### `POST /api/skills`
**Auth:** `ADMIN`/`MODERATOR`.
**Body:** `{ name, slug?, category, subcategory?, description?, icon?, color? }`

---

## Projects

### `GET /api/projects`
Visibility-scoped listing: public projects, plus (when no `ownerId` filter is given) the caller's own and any they're a member of. Projects owned by a user the caller has a block with (either direction) are left out. Query: `page, limit, status, search, techStack, ownerId`.

### `POST /api/projects`
Creates a project, `ProjectMember(OWNER)`, and its `PROJECT` conversation atomically. Awards `PROJECT_CREATED` XP, records activity, grants `first-project` achievement.
**Body:** `{ name, description?, shortDesc?, githubUrl?, demoUrl?, websiteUrl?, techStack?(≤20, each ≤50 chars), lookingFor?(≤20, each ≤50 chars), maxTeamSize?(1-10), hackathonId?, isPublic? }`

### `GET /api/projects/[id]`
**Auth:** public project, or owner/member. Returns the project with `owner`, `members`, `hackathon`, the 20 latest `updates`, all `milestones` (by `order`), `_count`, and the flags `isOwner`, `isMember`.

### `PATCH /api/projects/[id]`
**Auth:** owner, member, or `ADMIN`/`MODERATOR` (`authorize()`).
Setting `status: 'SHIPPED'` for the first time (gated on `shippedAt` being null) atomically awards `PROJECT_SHIP` XP, a `ReputationEvent`, records activity, and grants `first-ship`.

### `DELETE /api/projects/[id]`
**Auth:** owner or `ADMIN`. Cascades `ProjectMember`; the project's own `Conversation` is deleted too (verified live).

---

## Teams

### `GET /api/teams`
Teams owned by a user the caller has a block with are left out. Query: `page, limit, search, isRecruiting, hackathonId, skills` (comma-separated, exact-match against `lookingFor` via `hasSome` — distinct from `search`'s substring match).

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

`ACCEPTED` is race-safe: locks the `Team` row, re-counts members against `maxSize`, and (if the team has a linked project) locks the `Project` row and re-counts `ProjectMember`s against `maxTeamSize` — both checked inside the same transaction that flips status and creates `TeamMember`/`ProjectMember`/`ConversationMember`, records activity, and grants `team-player`. Returns `400 "Team is full"` / `400 "...max team size..."` on either capacity guard.

### `POST /api/teams/[id]/invitations`
**Auth:** team `OWNER`/`ADMIN` or platform `ADMIN`.
**Body:** `{ userId: string, message?: string }` — creates a `TeamApplication` with `invitedById` set; responded to via the endpoint above by the invitee.
**Errors:** `400` already a member, `409` already pending (invited or self-applied).

### `GET /api/teams/applications`
The caller's own applications (sent or received-as-invitation), across all teams. Query: `page, limit, status`.

### `PATCH /api/teams/[id]/members/[userId]`
**Auth:** team owner or `ADMIN`. Promotes/demotes a `TeamMember.role` (does **not** touch `Team.ownerId` — see transfer-ownership above).
**Body:** `{ role: 'OWNER' | 'ADMIN' | 'MEMBER' }`

### `DELETE /api/teams/[id]/members/[userId]`
**Auth:** team owner, the member themselves (self-removal), or `ADMIN`.
**Errors:** `400` if the caller is removing themselves and is the team's *sole* `OWNER`-role member (promote a second owner or transfer ownership first); `403` if a non-owner tries to remove someone else.

---

## Hackathons

### `GET /api/hackathons`
Public list. Query: `page, limit, status, search`.
Each item carries the caller's own participation: `registered` (boolean), `myTeamId` (`string | null`) and `myStatus` (`REGISTERED | TEAM_FORMED | SUBMITTED | WITHDRAWN | null`), and `_count: { participants, teams }`.

### `POST /api/hackathons`
**Auth:** `ADMIN`/`MODERATOR`. Creates a hackathon and its `HACKATHON` conversation atomically.
**Body:** `{ name, description, shortDesc?, startDate, endDate, registrationDeadline?, organizer?, websiteUrl?, prizePool?, rules?, technologies?(≤20, each ≤50 chars), maxTeamSize?(1-10, default 5), minTeamSize?(1-10, default 1), location?, isPublic?, thumbnail?, banner? }`

### `GET /api/hackathons/[id]`
Includes the caller's own `HackathonParticipant` row (`participation`).

### `POST /api/hackathons/[id]`
Registers the caller as a participant (only while `UPCOMING` and before `registrationDeadline`). Awards `HACKATHON_JOIN` XP, records activity, grants `first-hackathon`, notifies.
**Body:** `{ skills?: string[], lookingFor?: string[] }`

### `PATCH /api/hackathons/[id]`
**Auth:** `ADMIN`/`MODERATOR`. A `status` change is validated against a forward-only transition map: `UPCOMING → ACTIVE|CANCELLED`, `ACTIVE → ENDED|CANCELLED`; `ENDED`/`CANCELLED` are terminal.

### `DELETE /api/hackathons/[id]`
**Auth:** `ADMIN` only.

### `POST /api/hackathons/[id]/teams`
Registers an already-formed team for the hackathon (caller must already be the team's owner or an accepted member, and registered as a hackathon participant). Idempotent across team members (a second member's call joins the existing registration). Atomically upserts `HackathonTeam`/`HackathonTeamMember`, links the team, adds the caller to the hackathon's own conversation, awards `TEAM_FORMED` XP, records activity, grants `team-builder`.
**Body:** `{ teamId: string, projectId?: string }`
**Errors:** `400` team already full (own `maxSize`), `400` exceeds/below the hackathon's own `maxTeamSize`/`minTeamSize`, `403` not a team member.

### `POST /api/hackathons/[id]/submit`
**Auth:** any member of the team registered for this hackathon. Only while the hackathon is `ACTIVE`. Moves every teammate's `HackathonParticipant.status` to `SUBMITTED` together (one team action, not per-member).
**Body:** `{ teamId: string }`
**Errors:** `400` not `ACTIVE`, `404` team not registered for this hackathon, `403` caller not on the team, `400` team has no linked project.

### `PATCH /api/hackathons/[id]/results`
**Auth:** `ADMIN`/`MODERATOR`. Only once the hackathon has `ENDED`.
**Body:** `{ results: [{ hackathonTeamId, rank, score? }] }`
For every team newly reaching rank `1` (idempotent — re-submitting the same rank doesn't re-fire), every member gets `HACKATHON_WIN` XP, a `HACKATHON_WON` activity entry, the `hackathon-winner` achievement, and a notification.

---

## Teams ↔ Hackathons ↔ Projects: Builds

### `GET /api/builds`
Public feed (`isPublic: true`), without builds from users the caller has a block with. Query: `page, limit, hackathonId`.

### `PUT /api/builds/me`
Full-replacement upsert of the caller's own `CurrentBuild` (one per user). An omitted field resets to its schema default, even on update.
**Body:** `{ title, description?, status?, progress?(0-100), techStack?(≤20, each ≤50), teamSize?(1-20), maxTeamSize?(1-20), rolesNeeded?(≤20, each ≤50), hackathonId?, githubUrl?, demoUrl?, isPublic? }`

### `DELETE /api/builds/me`
Deletes the caller's own `CurrentBuild`. `404` if none exists.

---

## Connections

### `POST /api/connections`
Sends a typed connection request (`TEAMMATE|COLLABORATOR|MENTOR|FRIEND|NETWORK|DATING`). Checks both directions for a conflict — an existing `PENDING` or `ACCEPTED` row either way blocks a new request. Notifies the receiver.
**Body:** `{ receiverId, type?, message? }`
**Errors:** `400` self-connect, `404` receiver not found (also when the receiver has blocked the caller), `403` the caller has blocked the receiver, `400` already connected, `409` already pending.

### `GET /api/connections`
The caller's own connections (sent + received, or filtered). Query: `page, limit, status, direction ('sent'|'received')`.

### `PATCH /api/connections/[id]`
**Auth:** the connection's `receiverId` only — not the sender.
**Body:** `{ status: 'ACCEPTED' | 'DECLINED' }`
On `ACCEPTED`: atomically finds-or-creates the `DIRECT` conversation between the two users, adds both as members, records activity, notifies the sender. `400` if not currently `PENDING`.

---

## Conversations & Messages

### `GET /api/conversations`
The caller's own conversations, most recently active first. Query: `page, limit, type (DIRECT|GROUP|PROJECT|TEAM|HACKATHON), search`.
`search` matches (case-insensitively) the conversation name, its team/project/hackathon name, and the other members' name or username.
**Response:** `{ conversations: [{ ...conversation, members, messages (latest one only), _count, unreadCount }], totalUnread, pagination }`. `unreadCount` counts messages from other senders with no read row for the caller; `totalUnread` is their sum.

### `POST /api/conversations`
Creates a conversation (`DIRECT` requires exactly 1 `participantIds` entry, returns the existing one if a `DIRECT` conversation between the same two users already exists).
**Body:** `{ type?: 'DIRECT' | 'GROUP', name?, participantIds(1-50) }`. Only `DIRECT` and `GROUP` can be created by a client; team, project and hackathon conversations are created with the thing they belong to, and binding one from here is not possible (those keys are stripped, and other `type` values are a `400`).
**Errors:** `400` any participant does not exist; `404` the direct-conversation counterpart has blocked the caller; `403` the caller has blocked them.

### `GET /api/conversations/[id]`
**Auth:** conversation member only. Paginated messages (oldest first within the page), deleted messages masked (`content: null, isDeleted: true`) rather than omitted. Query: `page, limit(≤100), before (ISO datetime)`. Marks exactly the messages returned as read for the caller.

### `POST /api/conversations/[id]`
**Auth:** conversation member only. Sends a message, notifies other members. Direct conversations are closed once either side blocks the other (`403` for the blocker, `404` for the blocked user); shared team, project and hackathon rooms stay open.
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
The caller's own. Query: `page, limit, unreadOnly, type`. Response includes a real `unreadCount`.

### `PATCH /api/notifications`
Bulk mark-all-read. **Body:** `{ all: true }`

### `PATCH /api/notifications/[id]`
Marks one read. **Auth:** the notification's own `userId` (a mismatch returns `404`, not `403`, so it can't be used to probe other users' notification IDs).

---

## Reports & Moderation

### `POST /api/reports`
**Body:** `{ reportedId, reason, description? }`
**Errors:** `400` self-report, `404` reported user not found, `409` an identical pending report from this reporter against this target already exists (returns the existing report in `details`).

### `GET /api/reports`
**Auth:** `ADMIN`/`MODERATOR` only (`403` for everyone else, not an empty list). Query: `page, limit, status`.

### `PATCH /api/reports/[id]`
**Auth:** `ADMIN`/`MODERATOR` only. Forward-only transitions: `PENDING → REVIEWING|RESOLVED|DISMISSED`, `REVIEWING → RESOLVED|DISMISSED`; both terminal states final. Atomically updates status, writes a `ModerationAction` (targeting the report itself) and an `AuditEvent`.
**Body:** `{ status, reason? }`

---

## Leaderboard

### `GET /api/leaderboard`
Live `SUM(XPEvent.amount)` aggregate per user (not the denormalized `User.xp` cache — that's kept in sync for cheap sort/display elsewhere, but this endpoint computes the real total). Query: `page, limit`.
Users blocked in either direction are left out, and ranks are counted among the users the caller can see.
**Response:** `{ entries: [{ rank, xp, user }], me: { xp, rank }, pagination }`. `me.rank` is `null` until the caller has earned XP, and is computed live so it is right even when the caller is off the current page.

---

## Blocks

### `POST /api/blocks`
Blocks a user. One transaction: creates the block, deletes any connection between the pair, and withdraws pending team applications and invitations between them. Idempotent: blocking again returns `200` with the existing block.
**Body:** `{ userId: string, reason?: string(≤500) }`
**Response `201`** (`200` if it already existed): `{ block: { id, createdAt, reason, user }, severedConnections, withdrawnApplications }`
**Errors:** `400` blocking yourself, `404` user not found.

### `GET /api/blocks`
The caller's own block list, newest first. Query: `page, limit`. **Response:** `{ blocks: [{ id, createdAt, reason, user }], pagination }`. The list shows only who the caller blocked, never who blocked the caller.

### `DELETE /api/blocks/[userId]`
Removes the caller's block on that user. Severed connections and withdrawn applications are not restored.

Where blocks are enforced (either direction unless noted): discover, user directory, team candidates, leaderboard, dashboard recommendations, project/team/build browse lists, user profile, user skills, evidence lists, activity feed, connection requests, team applications and invitations, direct conversations (create and send), reactions in direct conversations, and endorsements.

---

## Skill Evidence & Endorsements

Evidence is attached to a skill the user has added to their profile. A peer endorsement is a row on the same table (`type: 'PEER_ENDORSEMENT'`, `metadata: { endorsedEvidenceId, endorserId }`), written only by the endorse endpoint.

### `GET /api/evidence`
Query: `page, limit(≤50), userId (default: the caller), skillId`. Endorsement rows are not listed; each evidence item carries `endorsementCount` and `endorsedByMe`.
**Response:** `{ evidence: [{ id, userId, skillId, type, title, description, url, verifiedAt, createdAt, skill, endorsementCount, endorsedByMe }], pagination }`
**Errors:** `404` user not found or has blocked the caller.

### `POST /api/evidence`
Creates evidence for the caller. Records activity and grants `first-evidence`.
**Body:** `{ skillId, type: 'GITHUB_PROJECT' | 'PORTFOLIO' | 'CERTIFICATION' | 'CONTRIBUTION', title(≤200), url? (http/https, ≤2048), description?(≤2000) }` (unknown keys are rejected)
**Errors:** `400` the caller has not added that skill, or already has 20 pieces of evidence on it.

### `DELETE /api/evidence/[id]`
**Auth:** the evidence owner (`403` otherwise). Deleting evidence also removes the endorsements on it. **Response:** `{ success: true }`

### `POST /api/evidence/[id]/endorse`
Endorses someone else's evidence, once per endorser (enforced under a transaction-scoped advisory lock). Notifies the owner and records activity on first endorsement. Every endorsement counts toward `endorsementCount`, but the reward (the `endorsed` achievement and its XP) is only granted when the endorser is verified (`verificationLevel` above `NONE`: a password sign-up stays `NONE` until the account signs in through an OAuth provider), at most 10 rewards per endorser per rolling day, and at most 50 XP per recipient per rolling day from endorsements.
**Response:** `{ endorsed: true, endorsementCount }` — `201` when created, `200` if already endorsed.
**Errors:** `403` your own evidence; `403` you have blocked the owner; `404` missing, an endorsement row, or the owner has blocked you.

### `DELETE /api/evidence/[id]/endorse`
Removes the caller's endorsement. **Response:** `{ endorsed: false, endorsementCount }`.

---

## Project Progress

### `GET /api/projects/[id]/updates`
**Auth:** anyone who can read the project (public, owner or member). Query: `page, limit(≤50)`.
**Response:** `{ updates: [{ id, projectId, title, content, type, createdAt, author }], pagination }`

### `POST /api/projects/[id]/updates`
**Auth:** project owner or member. Limited to 10 per minute per user. Notifies the other members, records activity, and grants `first-update` on the caller's first.
**Body:** `{ title(≤200), content(≤10000), type?: 'UPDATE' | 'ANNOUNCEMENT' }` (`MILESTONE` and `SHIPPED` updates are written by the system).

### `PATCH /api/projects/[id]/updates/[updateId]`
**Auth:** the update's author (while still a member), or a platform admin. System-generated updates cannot be edited (`400`).
**Body:** `{ title?, content? }`

### `DELETE /api/projects/[id]/updates/[updateId]`
**Auth:** the author, the project owner, or a platform admin.

### `GET /api/projects/[id]/milestones`
**Auth:** anyone who can read the project. Query: `page, limit(≤50)`. Ordered by `order`.
**Response:** `{ milestones: [{ id, projectId, title, description, dueDate, completedAt, completed, order, createdAt, updatedAt }], pagination }`

### `POST /api/projects/[id]/milestones`
**Auth:** owner or member. At most 100 per project (`400`).
**Body:** `{ title(≤200), description?(≤5000), dueDate? }`

### `PATCH /api/projects/[id]/milestones/[milestoneId]`
**Auth:** owner or member.
**Body (at least one):** `{ title?, description?(nullable), dueDate?(nullable), order?, completed?: boolean }`. Send `completed`, never `completedAt`. Completing a milestone for the first time records activity and grants `first-milestone` (repeating it does not).

### `DELETE /api/projects/[id]/milestones/[milestoneId]`
**Auth:** owner or member.

---

## Activity

### `GET /api/activity`
A user's activity feed, newest first. Query: `page, limit(≤50), userId (default: the caller), type`.
Your own feed is complete. Another user's feed shows entries with no project (achievements, team and hackathon milestones), entries on public projects, and entries on projects the caller is a member of.
**Response:** `{ activity: [{ id, userId, type, title, description, link, metadata, createdAt, project }], pagination }`
**Errors:** `404` user not found or has blocked the caller.

---

## Dashboard

### `GET /api/dashboard`
Everything the dashboard page shows, through the same rules as every other endpoint. Blocked users and their teams never appear in recommendations. The same data is available to a server component as `getDashboardData(prisma, userId)` from `src/lib/dashboard.ts`.
**Response:** `{ currentBuild, userProjects (active, ≤5), userTeams, hackathonParticipations, userQuests, recentActivities, xpEvents, userSkills, recommendedBuilders (with compatibility and commonSkills), recruitingTeams, upcomingHackathons }`

---

## Notes on scope

- **Challenges/ChallengeAttempt, CurrentBuild.maxTeamSize as a real cap on anything, VerificationRequest beyond the GitHub sign-in path, and precomputed Leaderboard snapshots** have schema support but no further routes than what's documented above — flagged during this session's audits as either out of scope for the current build or requiring a product decision not yet made (e.g. Challenges needs sandboxed code execution, a security decision).
- Every route above using a URL-path ID (`.pathname.split('/').pop()` style, not a typed Next.js dynamic param) was checked in this session's input-validation sweep: a malformed ID returns a clean `404`/`403`, never a raw `500`.
