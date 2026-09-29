# API Reference

Generated from the actual route handlers in `src/app/api/`. Every route except
`POST /api/auth/register` and the NextAuth handler requires an authenticated
session (a valid `authjs.session-token` cookie) — routes marked **Auth: none**
are the only exceptions. All request/response bodies are JSON unless noted.

Error responses share one shape: `{ "error": string, "details"?: unknown }`.
Validation failures (`400`) return `{ "error": "Validation failed", "details": { field: [messages] } }`.

---

## Auth

### `POST /api/auth/register`
**Auth:** none.
Registers a new account with a hashed password.
**Body:** `{ name: string, username: string, email: string, password: string(min 8) }`
**Response `201`:** `{ id, name, username, email }`
**Errors:** `409` email/username already taken.

### `/api/auth/[...nextauth]`
NextAuth's own handler (session, CSRF, OAuth/credentials callbacks). Not a hand-written route — see `src/lib/auth.ts`. On a GitHub sign-in, raises `User.verificationLevel` to `GITHUB` (never downgrades an existing higher level) and marks a `Verification` row `VERIFIED`.

---

## Users

### `GET /api/users`
Paginated user directory, excludes the caller. Query: `page, limit, search, skills (comma-separated slugs), location`.
**Response:** `{ users: [...], pagination }`

### `PATCH /api/users`
Updates the caller's own profile (no ID param — always self).
**Body (all optional):** `name, bio, headline, location, timezone, availability, builderRole, website, githubUsername, twitterUsername, linkedinUrl`

### `GET /api/users/[id]`
Full profile: skills, skillEvidences, achievements, ownedProjects, member projects, owned teams, member teams, currentBuild, and a live `compatibility` score vs. the caller (`null` when viewing your own profile).

### `GET /api/users/[id]/skills`
List a user's skills (public).

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
One-to-one match candidates, ranked by real skill-compatibility score against a bounded recency-ordered pool. Query: `page, limit, search, skills, location`.
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
Visibility-scoped listing: public projects, plus (when no `ownerId` filter is given) the caller's own and any they're a member of. Query: `page, limit, status, search, techStack, ownerId`.

### `POST /api/projects`
Creates a project, `ProjectMember(OWNER)`, and its `PROJECT` conversation atomically. Awards `PROJECT_CREATED` XP, records activity, grants `first-project` achievement.
**Body:** `{ name, description?, shortDesc?, githubUrl?, demoUrl?, websiteUrl?, techStack?(≤20, each ≤50 chars), lookingFor?(≤20, each ≤50 chars), maxTeamSize?(1-10), hackathonId?, isPublic? }`

### `GET /api/projects/[id]`
**Auth:** public project, or owner/member.

### `PATCH /api/projects/[id]`
**Auth:** owner, member, or `ADMIN`/`MODERATOR` (`authorize()`).
Setting `status: 'SHIPPED'` for the first time (gated on `shippedAt` being null) atomically awards `PROJECT_SHIP` XP, a `ReputationEvent`, records activity, and grants `first-ship`.

### `DELETE /api/projects/[id]`
**Auth:** owner or `ADMIN`. Cascades `ProjectMember`; the project's own `Conversation` is deleted too (verified live).

---

## Teams

### `GET /api/teams`
Query: `page, limit, search, isRecruiting, hackathonId, skills` (comma-separated, exact-match against `lookingFor` via `hasSome` — distinct from `search`'s substring match).

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
Public feed (`isPublic: true`). Query: `page, limit, hackathonId`.

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
**Errors:** `400` self-connect, `404` receiver not found, `400` already connected, `409` already pending.

### `GET /api/connections`
The caller's own connections (sent + received, or filtered). Query: `page, limit, status, direction ('sent'|'received')`.

### `PATCH /api/connections/[id]`
**Auth:** the connection's `receiverId` only — not the sender.
**Body:** `{ status: 'ACCEPTED' | 'DECLINED' }`
On `ACCEPTED`: atomically finds-or-creates the `DIRECT` conversation between the two users, adds both as members, records activity, notifies the sender. `400` if not currently `PENDING`.

---

## Conversations & Messages

### `GET /api/conversations`
The caller's own conversations.

### `POST /api/conversations`
Creates a conversation (`DIRECT` requires exactly 1 `participantIds` entry, returns the existing one if a `DIRECT` conversation between the same two users already exists).
**Body:** `{ type, name?, participantIds(≤50), projectId?, teamId?, hackathonId? }`

### `GET /api/conversations/[id]`
**Auth:** conversation member only. Paginated messages, deleted messages masked (`content: null, isDeleted: true`) rather than omitted.

### `POST /api/conversations/[id]`
**Auth:** conversation member only. Sends a message, notifies other members.
**Body:** `{ content, type?, replyToId?, metadata? }`

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
**Response:** `{ entries: [{ rank, xp, user }], me: { xp, rank }, pagination }`

---

## Notes on scope

- **Challenges/ChallengeAttempt, CurrentBuild.maxTeamSize as a real cap on anything, VerificationRequest beyond the GitHub sign-in path, and precomputed Leaderboard snapshots** have schema support but no further routes than what's documented above — flagged during this session's audits as either out of scope for the current build or requiring a product decision not yet made (e.g. Challenges needs sandboxed code execution, a security decision).
- Every route above using a URL-path ID (`.pathname.split('/').pop()` style, not a typed Next.js dynamic param) was checked in this session's input-validation sweep: a malformed ID returns a clean `404`/`403`, never a raw `500`.
