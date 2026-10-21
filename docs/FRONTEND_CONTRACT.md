# Frontend Contract

What each page that still runs on mock data should call, the exact shapes that
come back, and every field the mocks invent that the API does not provide.

- Response types for everything below are exported from `src/types/api.ts`
  (dates are ISO strings on the wire).
- `docs/API.md` is the per-route reference (bodies, auth, errors). This file is
  organised by page.
- `tests/integration/frontend-contract.test.ts` fetches these shapes from a
  running server and fails if a promised key disappears.

## Conventions that apply to every endpoint

| Topic | Rule |
| --- | --- |
| Auth | Clerk session: the `__session` cookie Clerk sets, or `Authorization: Bearer <token>`. No session gives `401` with code `UNAUTHORIZED`. Users are identified by their **local** id (`GET /api/users/me`), never by Clerk's id. |
| Errors | Always `{ error: { code, message, params?, details? } }`. Branch on `code` (the list is in `docs/API.md`, "Errors"); `message` is an English default. `params` carries the values a translation needs. Validation failures are `400 VALIDATION_FAILED` with `details` as `{ field: string[] }`. |
| Pagination | `?page=1&limit=20`, response carries `pagination: { page, limit, total, totalPages }` **and** `nextCursor` (`string \| null`). For infinite scroll or "load more", send `nextCursor` back as `?cursor=` (with `limit`) until it is `null`: that is cheaper and is not thrown off by items added while the user scrolls. A cursor request has **no `pagination` object** (no count is run). Cursors are opaque; never build or store one across sessions. Two lists are bare arrays and send the cursor in the `X-Next-Cursor` response header (`GET /api/users/{id}/skills`, `GET /api/teams/{id}/applications`). `limit` is capped per route (usually 50, messages and leaderboard 100). Asking for more than the cap is a `400`, not a silent clamp. A bad cursor is `400 INVALID_CURSOR`: start again from the first page. |
| Rewards | Every request that can earn XP returns `rewards` (`RewardsEnvelope`) next to its normal body, also when nothing was earned. See the next section. |
| Retrying creates | Send an `Idempotency-Key` header (any UUID, one per user action, reused on a retry) on creating `POST`s. A retry then returns the first response (`Idempotent-Replayed: true`) and creates nothing. Same key with a different body is `409 IDEMPOTENCY_KEY_REUSED`; while the first call is still running, `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` (wait a second, retry). Do not reuse a key for a new action. |
| Request id | Every response has `X-Request-Id`. Show it in "something went wrong" screens and send it with bug reports. |
| Time zones | Set `timezone` (an IANA name such as `Europe/Paris`) on the profile with `PATCH /api/users`; anything that is "per day" (XP caps, streaks, quests, the heatmap) follows the user's local midnight and "per week" (quests) the local Monday. Weekly and monthly leaderboards are UTC. An invalid zone is `400`. Dates stay UTC ISO strings. |
| Feature flags | `GET /api/flags` returns `{ flags: { key: boolean } }` for the signed-in user. Read it once per session and gate unreleased UI on it; a key that is missing is off. |
| Rate limits | Per signed-in user, per route family. Over the limit gives `429 RATE_LIMITED` (`error.params.retryAfter` is the seconds to wait) with a `Retry-After` header. If the limiter store is down you may see `503 SERVICE_UNAVAILABLE` with `Retry-After`. Back off and retry; do not hammer. |
| Dates | ISO 8601 strings. |
| Blocks | Blocking is symmetric. The blocked user cannot see or reach the blocker anywhere: they get `404` on the blocker's profile, and the blocker is missing from lists, search, leaderboard, recommendations and the dashboard. The blocker gets `403 "You have blocked this user"` if they try to interact with someone they blocked (so the UI can offer "Unblock"). Nothing tells the blocked user they were blocked. |
| Missing vs forbidden | `404` means it does not exist **or** you may not know it exists. `403` means it exists and you lack the role for the action. |
| Unknown request keys | Ignored (stripped). Never send `id`, `ownerId`, `xp`, `role` and expect them to stick. |

Error codes you should handle everywhere: `400` validation or state, `401`
signed out, `403` role, `404` missing or hidden, `409` duplicate, `429` slow
down, `503` retry shortly.

---

## 1. Messages (`/messages`)

| Need | Call |
| --- | --- |
| Conversation list with tabs and search | `GET /api/conversations?type=&search=&page=&limit=` |
| Open a conversation (oldest first within the page) | `GET /api/conversations/{id}?page=&limit=&before=` |
| Send | `POST /api/conversations/{id}` body `{ content, type?, replyToId?, metadata? }` |
| Start a chat | `POST /api/conversations` body `{ type: 'DIRECT' \| 'GROUP', name?, participantIds: string[] }` |
| Mark read | `POST /api/conversations/{id}/read` body `{ upToMessageId? }` |
| Edit / delete own message | `PATCH` / `DELETE /api/messages/{id}` |
| Reactions | `GET` / `POST /api/messages/{id}/reactions` body `{ emoji }` (POST toggles) |

### List response (`ConversationsResponse`)

```jsonc
{
  "conversations": [{
    "id": "…", "type": "DIRECT", "name": null,
    "members": [{ "userId": "…", "user": { "id", "name", "username", "image", "headline" } }],
    "messages": [{ "content": "hey", "createdAt": "…", "sender": { "id", "name", "username" } }],
    "_count": { "messages": 12 },
    "unreadCount": 3,
    "updatedAt": "…"
  }],
  "totalUnread": 3,
  "pagination": { … }
}
```

- `type` filter accepts `DIRECT | GROUP | PROJECT | TEAM | HACKATHON`. The mock's
  tabs map directly to it. An unknown value is a `400`.
- `search` matches the conversation name, its team/project/hackathon name, and
  the other members' name or username. Case-insensitive.
- `messages` holds at most one item: the latest message, for the preview line.
  Its `content` is `null` if that message was deleted.
- `unreadCount` counts messages from others that you have not read.
  `totalUnread` is the sum, for a nav badge.
- Sorted by most recent activity.

### Send rules

- Only `DIRECT` and `GROUP` can be created by a client. Team, project and
  hackathon conversations are created with the thing they belong to; trying to
  bind one yourself is a `400`.
- `participantIds` are validated: unknown users are a `400`, a `DIRECT` chat
  needs exactly one other participant.
- Sending into a direct conversation with someone you have a block with:
  `403` for the blocker, `404` for the blocked user.
- Opening `GET /api/conversations/{id}` marks the messages it returns as read.
  Call `POST …/read` only when you want to mark read without fetching, for
  example on focus.

### Fields the mock invents

| Mock field | Status |
| --- | --- |
| `online` / presence dot | **No API.** There is no presence or heartbeat. Remove it or keep it purely cosmetic. |
| `unread` | Real: `unreadCount`. |
| `lastMessage` | Real: `messages[0]`. |
| Direct chat `name` | `null` in the API. Show the other member's `name` (the member whose `userId` is not yours). |
| `avatar` | `members[].user.image` (may be `null`, keep an initials fallback). |
| `typing…` | **No API.** |

---

## 2. Discover (`/discover`)

| Need | Call |
| --- | --- |
| People cards | `GET /api/discover?search=&skills=&location=&page=&limit=` |
| Projects tab | `GET /api/projects?search=&status=&techStack=&page=&limit=` |
| Teams tab | `GET /api/teams?search=&isRecruiting=&skills=&hackathonId=` |
| Hackathons tab | `GET /api/hackathons?status=&search=` |
| Connect | `POST /api/connections` body `{ receiverId, type?, message? }` |

`skills` is a comma-separated list of skill slugs. The four tab counts come
from `pagination.total` of each list; ask for `limit=1` when you only need a
count.

### `GET /api/discover` (`DiscoverResponse`)

```jsonc
{ "people": [{
    "id", "name", "username", "image", "headline", "location", "builderRole",
    "xp", "reputationScore", "githubUsername", "createdAt",
    "skills": [{ "level": 4, "yearsExperience": 3, "isVerified": false,
                 "skill": { "id", "name", "slug", "category" } }],
    "compatibility": 82
}], "pagination": { … } }
```

Ranked by `compatibility` (0-100) against the signed-in user. Yourself and
blocked users are never returned.

### Fields the mock invents

| Mock field | Real field |
| --- | --- |
| `role` | `builderRole` (nullable) |
| `match` | `compatibility` |
| `avatar` | `image` (nullable) |
| `skills: string[]` | `skills[].skill.name`. Skills are objects with a level. |
| `rank` | Do not use `rank` from this endpoint. The stored column is never updated and is always `0`. Use `/api/leaderboard` or the profile's live `rank`. |
| `stars`, `forks` on projects | **No API and no data model.** Remove, or replace with `_count.members` and `_count.updates`. |

---

## 3. Projects (`/projects`)

| Need | Call |
| --- | --- |
| List | `GET /api/projects?status=&search=&techStack=&ownerId=&page=&limit=` |
| Detail | `GET /api/projects/{id}` |
| Create | `POST /api/projects` body `{ name, description?, shortDesc?, githubUrl?, demoUrl?, websiteUrl?, techStack?, lookingFor?, maxTeamSize?, hackathonId?, isPublic? }` |
| Edit / status | `PATCH /api/projects/{id}` (owner or admin) |
| Progress feed | `GET /api/projects/{id}/updates` |
| Post update | `POST /api/projects/{id}/updates` body `{ title, content, type?: 'UPDATE' \| 'ANNOUNCEMENT' }` (members; 10 per minute) |
| Milestones | `GET`/`POST /api/projects/{id}/milestones`, `PATCH`/`DELETE …/milestones/{milestoneId}` (PATCH `{ completed: true }` to tick one off) |
| Apply to the team | `POST /api/teams/{teamId}/applications` |

### List item (`ProjectsResponse`)

`id, name, slug, description, shortDesc, status, ownerId, techStack,
lookingFor, teamSize, maxTeamSize, githubUrl, demoUrl, websiteUrl, thumbnail,
isPublic, startedAt, shippedAt, createdAt, updatedAt`, plus
`owner { id, name, username, image }`, `members[]`, `hackathon`, and
`_count { members, updates, milestones }`.

Projects owned by someone you have a block with are left out of the list.

### Detail (`GET /api/projects/{id}`)

The project row with `owner`, `members[].user`, `hackathon`, the 20 latest
`updates` (with `author`), all `milestones` ordered by `order`, `_count`, and
two flags for the UI: `isOwner`, `isMember`. A private project is `403` unless
you are the owner or a member. Page through updates with the dedicated
endpoint for more than 20.

Milestone (`MilestoneItem`): `{ id, projectId, title, description, dueDate,
completedAt, completed, order, createdAt, updatedAt }`. `completed` is derived
from `completedAt`; send `completed: true|false` to change it, never
`completedAt`.

Update (`ProjectUpdateItem`): `{ id, projectId, title, content, type,
createdAt, author }`. `type` is `UPDATE | ANNOUNCEMENT | MILESTONE | SHIPPED`;
the last two are written by the system when a milestone completes or the
project ships, and cannot be edited.

### Fields the mock invents

| Mock field | Status |
| --- | --- |
| `stars`, `forks` | **No API.** Remove. |
| `progress` percentage | Not stored on projects. Derive it: `milestones.filter(m => m.completed).length / milestones.length`. (`progress` exists only on a user's *current build*, see Profile.) |
| `updatedAt` "2d ago" | Real. Format an ISO string, do not expect a relative string. |
| `owner` as a string | Real value is an object; show `owner.name ?? owner.username`. |
| `tags` | `techStack: string[]` |

---

## 4. Profile (`/profile`, `/profile/{id}`)

| Need | Call |
| --- | --- |
| Profile page | `GET /api/users/{id}` (use your own id for "me") |
| Edit | `PATCH /api/users` body of any of `name, bio, headline, location, timezone, availability, builderRole, website, githubUsername, twitterUsername, linkedinUrl` |
| Add / edit / remove skill | `POST /api/users/{id}/skills`, `PATCH`/`DELETE …/skills/{skillId}` |
| Skill catalogue | `GET /api/skills?category=&search=` |
| Evidence list | `GET /api/evidence?userId=&skillId=` |
| Add evidence | `POST /api/evidence` body `{ skillId, type: 'GITHUB_PROJECT' \| 'PORTFOLIO' \| 'CERTIFICATION' \| 'CONTRIBUTION', title, url?, description? }` |
| Endorse / remove endorsement | `POST` / `DELETE /api/evidence/{id}/endorse` |
| Activity tab | `GET /api/activity?userId=&type=&page=&limit=` |
| Block / unblock / list blocks | `POST /api/blocks { userId, reason? }`, `DELETE /api/blocks/{userId}`, `GET /api/blocks` |
| Report | `POST /api/reports { reportedId, reason, description? }` |
| Connect | `POST /api/connections` |

### `GET /api/users/{id}` (`ProfileResponse`)

Everything on the user that is safe to show: identity fields, `xp`, live
`rank`, `reputationScore`, verification flags, `skills[]`, `skillEvidences[]`,
`ownedProjects[]`, `projects[]` (memberships), `ownedTeams[]`, `teams[]`,
`achievements[]`, `currentBuild`, and:

- `email`: present **only** on your own profile. Never on anyone else's.
- `rank`: live position on the leaderboard among users you can see (`0` if the
  user has no XP yet). The stored column is not used.
- `compatibility`: 0-100 against you, `null` on your own profile.
- `blockedByMe`: `true` if you blocked them (show "Unblock").

Passwords, hashes, tokens and other users' email addresses are never returned
by any endpoint.

`404` if the user does not exist or has blocked you.

### Achievements

`achievements[]` on the profile is `{ id, earnedAt, achievement: { name, slug, description,
icon, category, xpReward, isSecret } }`: **earned** achievements only. `icon` is a string name (for example
`"rocket"`), not a component: map it to an icon in the UI. For the whole catalogue with progress, rarity and the
locked grid use `GET /api/users/{id}/achievements` (see Progress pages below).

### Activity (`ActivityResponse`)

Your own feed is complete. Someone else's shows entries not tied to a project
(achievements, hackathon and team milestones) plus entries for public projects
and for projects you are a member of. Private-project activity is hidden from
everyone else. `404` if the user is missing or has blocked you.

### Endorsements and evidence

Evidence rows come from `GET /api/evidence`; each has `endorsementCount` and
`endorsedByMe`. Peer endorsements are rows on the same table with type
`PEER_ENDORSEMENT`, so `skillEvidences[]` on the profile includes them; use the
evidence endpoint for the display list. You cannot endorse your own evidence
(`403`), and each person can endorse an item once. Endorsements from
unverified accounts still show in `endorsementCount`, but only verified
endorsers unlock the owner's "Vouched For" achievement and XP, so do not promise
the owner a badge in the UI when an endorsement arrives.

### Fields the mock invents

| Mock field | Status |
| --- | --- |
| `email` on someone else's profile | Not available, by design. Own profile only. |
| `skills: string[]` | `skills[].skill.name` with `level` (1-5) and `isVerified`. |
| `rank` | Real and live on the profile. Ignore `rank` on list endpoints. |
| `achievement.xp` | `achievement.xpReward` |
| `followers`, `following` | **No API.** Connections are the closest thing: `GET /api/connections?status=ACCEPTED`. |
| `joined` date | `createdAt` |
| `streak`, `reputation` badges | `reputationScore` exists; `streak` has no API. |

---

## 5. Hackathons (`/hackathons`)

| Need | Call |
| --- | --- |
| List | `GET /api/hackathons?status=&search=&page=&limit=` |
| Detail | `GET /api/hackathons/{id}` |
| Register | `POST /api/hackathons/{id}` body `{ skills?: string[], lookingFor?: string[] }` |
| Enter a team | `POST /api/hackathons/{id}/teams` body `{ teamId, projectId? }` |
| Submit | `POST /api/hackathons/{id}/submit` body `{ teamId }` |
| Results | Read from the detail's `hackathonTeams[].rank` / `score` |
| Create / edit / results (admin) | `POST /api/hackathons`, `PATCH /api/hackathons/{id}`, `PATCH /api/hackathons/{id}/results` |
| Squads (builder, solo pool, LFG, team space) | see [Squads](#squads-hackathon-page-squad-builder-lfg-board-team-space) below |

### List item (`HackathonsResponse`)

The hackathon row (`id, name, slug, description, shortDesc, startDate, endDate,
registrationDeadline, status, prizePool, technologies, maxTeamSize,
minTeamSize, location, thumbnail, banner, …`) plus:

- `_count: { participants, teams }`
- `registered: boolean`, `myTeamId: string | null`,
  `myStatus: 'REGISTERED' | 'TEAM_FORMED' | 'SUBMITTED' | 'WITHDRAWN' | null`

These three drive "Register", "My team" and "Registered" buttons without a
second request per card.

### Detail (`GET /api/hackathons/{id}`)

The row with `participants[].user`, `hackathonTeams[]` (each with `name`, `team`,
`rank`, `score`; `rank` and `score` are `null` until results are recorded), `_count { participants, hackathonTeams }` and
`participation` (your own participant row or `null`). Note the count key on the
detail is `hackathonTeams`, on the list it is `teams`.

Registration rules the UI should mirror: `400 HACKATHON_REGISTRATION_CLOSED` when the
status is not open, `400 HACKATHON_REGISTRATION_DEADLINE_PASSED`, `400
HACKATHON_ALREADY_REGISTERED`. Entering a team needs you to be registered first and to be a
member of the team; the team size must sit inside the hackathon's min/max.
Only admins create hackathons (`403` otherwise).

### Fields the mock invents

| Mock field | Status |
| --- | --- |
| `registered` | Real: `registered` |
| `participants` number | `_count.participants` |
| `prize` | `prizePool` (a free-text string, not a number) |
| `daysLeft` | Compute from `endDate` / `startDate`. |
| `tags` | `technologies: string[]` |
| Leaderboard rows for a finished event | Detail's `hackathonTeams[].rank`, sorted by `rank`. |

---

## 6. Teams (`/teams`)

| Need | Call |
| --- | --- |
| List | `GET /api/teams?search=&isRecruiting=&skills=&hackathonId=` |
| Detail | `GET /api/teams/{id}` |
| Create | `POST /api/teams` body `{ name, description?, projectId?, hackathonId?, maxSize?, lookingFor?, isRecruiting? }` |
| Edit / delete | `PATCH` / `DELETE /api/teams/{id}` (owner or admin role on the team) |
| Apply | `POST /api/teams/{id}/applications` body `{ message? }` |
| My applications | `GET /api/teams/applications?status=` |
| Review applications (team admins) | `GET /api/teams/{id}/applications`, `PATCH …/applications/{applicationId}` body `{ status: 'ACCEPTED' \| 'REJECTED' \| 'WITHDRAWN' }` |
| Invite | `POST /api/teams/{id}/invitations` body `{ userId, message? }` |
| Suggested members | `GET /api/teams/{id}/candidates` |
| Members | `PATCH`/`DELETE /api/teams/{id}/members/{userId}`; `POST /api/teams/{id}/transfer-ownership { newOwnerId }` |

### List item (`TeamsResponse`)

`id, name, slug, description, maxSize, isRecruiting, lookingFor, createdAt,
updatedAt` plus `owner`, `members[]` (with `role` and `user`), `project`,
`hackathon`, `_count { members, applications }`.

Teams owned by someone you have a block with are left out.

### Fields the mock invents

| Mock field | Status |
| --- | --- |
| `members` as a number | `_count.members` (the array `members[]` is also present) |
| `owner` as a string | Object `{ id, name, username, image }` |
| `skills` needed | `lookingFor: string[]` |
| `openSlots` | `maxSize - _count.members` |
| `logo` | **No API.** Use initials. |

---

## 7. Dashboard (`/dashboard`)

The page currently queries Prisma directly from a server component. That
bypasses the API's rules (notably blocks), so recommendations there can show
people a viewer has blocked. Switch it to either:

- `GET /api/dashboard` from the client, or
- `import { getDashboardData } from '@/lib/dashboard'` in the server component
  and pass in the session user's id (same data, same rules, no HTTP hop).

### `GET /api/dashboard` (`DashboardResponse`)

```jsonc
{
  "currentBuild": { … } | null,
  "userProjects": [ … ],            // your active projects (idea, planning, building, testing), newest first, at most 5
  "userTeams": [ … ],
  "hackathonParticipations": [ { "hackathon": { … }, "status": "…", "teamId": "…" } ],
  "userQuests": [ … ],
  "recentActivities": [ /* ActivityItem */ ],
  "xpEvents": [ { "type", "amount", "description", "createdAt" } ],
  "userSkills": [ … ],
  "recommendedBuilders": [ { …user, "compatibility": 78, "commonSkills": ["React"] } ],
  "recruitingTeams": [ … ],         // teams looking for your skills, not yours
  "upcomingHackathons": [ … ]
}
```

Blocked users (either direction) and their teams never appear in
`recommendedBuilders` or `recruitingTeams`. The dashboard also has the
notification badge: use `GET /api/notifications?unreadOnly=true` and
`PATCH /api/notifications/{id}` or `PATCH /api/notifications { all: true }`.

### Fields the mock invents

| Mock field | Status |
| --- | --- |
| Streaks | `streak` of `GET /api/users/{id}/stats` (your own id), and `rewards.streak` on every action. |
| "Weekly goal" | `weekly.quests` of `GET /api/quests`: three weekly quests with progress and `resetsAt`. |
| Stat tiles (projects, connections, XP) | `xp`, `level`, `counts` from `GET /api/users/{id}/stats`; counts of lists from `pagination.total`. |
| Leaderboard position | `GET /api/leaderboard` → `me.rank` (`null` when you have no XP yet), or `ranks` on the stats call. |
| `userQuests` in this response | Legacy rows of quests that were started, not the current ones. Use `GET /api/quests`. |

---

## Rewards, levels and tiers

Everything that earns XP returns `rewards` (type `RewardsEnvelope` in
`src/types/api.ts`). Use it to animate the outcome of the action the user just took:

| Field | Use |
| --- | --- |
| `xpGained` | "+75 XP" toast. `0` means nothing was earned (a cap was reached or it already paid): show nothing. |
| `totalXp`, `newLevel`, `newTier` | Replace the cached XP, level and tier in the header without another request. |
| `leveledUp`, `oldLevel`, `newLevel` | Level-up celebration. |
| `tierChanged`, `oldTier`, `newTier` | Tier celebration (`BRONZE`, `SILVER`, `GOLD`, `PLATINUM`, `DIAMOND`, `MYTHIC`). |
| `achievements[]` | `{ slug, name }` of badges unlocked by this request. |
| `questsCompleted[]` | `{ slug, name }` of quests this request completed: "Quest complete" toast, the XP is already in `xpGained`. |
| `streak` | `{ current, longest, extended, freezeUsed }`. Always present. `extended` is true on the first counting action of the local day: flash the flame. `freezeUsed` means a banked freeze just saved the streak. `current` is 0 for a lapsed streak. |

Where it comes back: `POST /api/projects`, `PATCH /api/projects/{id}`,
`POST /api/projects/{id}/updates`, `PATCH /api/projects/{id}/milestones/{milestoneId}`,
`POST /api/hackathons/{id}` (register), `POST /api/hackathons/{id}/teams`,
`PATCH /api/hackathons/{id}/results`, `POST /api/evidence`,
`PATCH /api/teams/{id}/applications/{applicationId}`. It always describes **the signed-in user**.
When someone else is rewarded (a hackathon winner, an accepted applicant, the owner of endorsed
evidence) they find out from a notification: level-ups, tier changes and unlocked
achievements create a `Notification` of type `ACHIEVEMENT` whose `metadata.kind` is `LEVEL_UP`,
`TIER_UP`, `ACHIEVEMENT_UNLOCKED`, `QUEST_COMPLETED` or `COSMETIC_UNLOCKED`.

Level progress for a progress bar is not in the envelope; compute it from the user's `xp` with the
curve in [GAMIFICATION.md](GAMIFICATION.md#level-curve) (`levelFor()` in `src/lib/levels.ts` is pure
and safe to import in the browser: `{ level, tier, xpIntoLevel, xpForNextLevel, progress }`).

Do not promise XP the UI cannot be sure of. Every award is paid once per thing, and most have a
daily cap: project creation and shipping 3 a day; milestones 5; project updates, evidence 3;
endorsements received 10; connections 5; first messages 5. Joining, forming a team, winning and
an accepted team application pay once per hackathon or application. Accepting a connection
(`PATCH /api/connections/{id}`, type `ReviewConnectionResponse`) and sending a message
(`POST /api/conversations/{id}`, type `SendMessageResponse`) return the caller's own `rewards` too;
the other person in a connection is told by notification.

---

## Progress pages: Home, Passport, Leaderboards, Quests, Achievements

Every call here is read only except where marked. Types are in `src/types/api.ts`. Days, weeks, streaks and quests
follow the **user's** time zone (`PATCH /api/users` `timezone`, or `PATCH /api/users/me/profile`); weekly and monthly leaderboards are UTC.

### Home (`/dashboard`)

| Need | Call |
| --- | --- |
| Level, tier, XP bar, streak, rank, counts | `GET /api/users/{me}/stats` (`PlayerCard`): `level`, `tier`, `progress.fraction`, `streak.current`, `ranks.global`, `counts` |
| Today's quests, "resets in 5h" | `GET /api/quests` → `daily.quests[]` and `daily.resetsAt` |
| This week's quests | `GET /api/quests` → `weekly.quests[]`, `weekly.resetsAt` |
| Contribution calendar | `GET /api/users/{me}/heatmap?days=365` → `items[]` (only days with activity; draw the rest empty) |
| "What changed" after any action | the `rewards` envelope of that action (XP, level, streak, achievements, quests) |
| Where I stand now | `GET /api/leaderboard?period=weekly` → `me` and `around` (the two above and below) |

When a request comes back with `rewards.streak.extended`, update the flame without another call. `rewards.questsCompleted`
tells you which quest to tick. After a completed action you can refetch `/api/quests` (cheap, nothing is written), but you
do not need to: the response already says what completed.

### Passport (`/profile`, `/profile/{id}`)

| Need | Call |
| --- | --- |
| Header: title, frame, banner, level, tier, rank, streak | `GET /api/users/{id}/stats`: `equipped.{title,frame,banner}` are `{ slug, name }` or null and `equipped.badges` is a list of up to three `{ slug, name }`, `ranks` are absolute places (null where not on a board), `streak` is `null` on someone else's page when they keep their activity private |
| Rarest badges | `stats.topAchievements` (three, rarest first, with `rarity`) |
| Badge wall | `GET /api/users/{id}/achievements` (see Achievements) |
| Contribution calendar | `GET /api/users/{id}/heatmap?days=365`; `hidden: true` means the owner keeps it private: show nothing |
| My inventory and what I wear | `GET /api/users/me/cosmetics`; wear with `PATCH /api/users/me/equipped { title?, frame?, banner?, badges? }` (**write**; `badges` is up to three slugs in order and replaces the list) |
| Settings: where I am, privacy | `GET`/`PATCH /api/users/me/profile` `{ timezone, countryCode, city, campus, hideFromLeaderboards, showActivity }` (**write**) |

Cosmetics are only earned: there is nothing to buy and no "unlock" button, only `requirement` text on the locked ones. A finished season
adds a few for everyone who played or placed (`Season N Top 100` title, `Season N Top 1%` and `Season N Top 10%` frames, a `Season N Participant`
badge): they appear in `cosmetics` once owned, with the badge as `type: "BADGE"`, `slot: "badges"` (it can be worn, up to three at a time, via `badges`). Equipping a
cosmetic in the wrong slot is `400 COSMETIC_WRONG_SLOT`; more than three badges is `400 VALIDATION_FAILED`. Placings cost no XP and do not appear in a `rewards` envelope; they arrive as a `COSMETIC_UNLOCKED` notification. A
cosmetic earned by a secret achievement is `masked` until owned (show a mystery tile). Equipping something you do not own is
`403 COSMETIC_NOT_OWNED`, so disable the control for locked items. Tell the user why a rank is missing: `hideFromLeaderboards`,
no XP yet, or no country/city set.

### Leaderboards (`/leaderboard`)

`GET /api/leaderboard?period=&scope=&scopeId=&cursor=&limit=` returns
`{ period, scope, season, entries: [{ rank, score, level, tier, user }], me: { rank, score, hidden }, around, myScopes, nextCursor, pagination? }`.

| Control | Value |
| --- | --- |
| Period tabs | `weekly`, `monthly`, `season` (shows `season.name` and `season.endsAt`), `all-time` |
| Scope picker | `global`, `country`, `city`, `campus`, `crew`. Build it from `myScopes`: a scope whose id is `null` needs the user to set a place first (offer the profile settings), and asking without one is `400` with `details.scopeId`. For `crew` pass the team id as `scopeId` |
| Infinite scroll | send `nextCursor` back as `cursor` until it is `null`. Ranks keep continuing even if scores move. Do not store cursors |
| "You" row | `me.rank` (`null`: not on this board) and `around`; pin them under the list |

A rank is the person's place on the board, the same number for every viewer and the same as the player card's `ranks`. Blocked people
are simply left out of **your** list, so ranks can skip (1, 3, 4) and a page can have fewer than `limit` rows: do not renumber, do not
assume row `i` has rank `i + 1`, and keep following `nextCursor` while it is not `null`. People who turned leaderboards off
are on no board. Weekly and monthly boards reset at UTC midnight on Monday and on the 1st.

### Quests (`/quests`)

`GET /api/quests` → `{ enabled, timezone, daily: { periodKey, resetsAt, quests }, weekly: { ... } }`, three of each.
Each quest: `{ slug, name, description, xpReward, target, current, completed, completedAt }`. Render `current / target`, and
`resetsAt` as a countdown. The quests are the same all period and on every device: do not cache them past `resetsAt`. There
is no "claim": doing the action counts, and the XP arrives with that action's `rewards.questsCompleted`. Reading earns nothing
and no quest asks the user to open or visit anything. If `enabled` is false, hide the page (an operator paused quests).

### Achievements (`/achievements`)

`GET /api/achievements` (yours) or `GET /api/users/{id}/achievements` → `{ achievements: [...40], earned, total }`, in display
order, each `{ slug, name, description, icon, category, xpReward, secret, masked, earned, earnedAt, progress: { current, target }, rarity, order }`.
Group by `category` (`BUILDING`, `HACKATHON`, `TEAM`, `REPUTATION`, `STREAK`, `SECRET`); tiered families share a category and read
naturally by `order`. Show `progress` as a bar for locked ones. `rarity` is the share of recently active users who have it (0.02 = 2%);
format it as "2% of builders" and treat `null` as "not measured yet". A `masked` item is a secret achievement not yet earned:
show a mystery tile with `name` and `description` as given and nothing else. Unlock events arrive in `rewards.achievements`
and as a notification of kind `ACHIEVEMENT_UNLOCKED`.

---

## Matching pages: Setup, Drops, Sparks, Matches

The rules (scoring, daily drops, anti-spam) are in [MATCHING.md](MATCHING.md); the routes in [API.md](API.md#matching). The romance mode has its own pages (below, "Romance pages") and is never part of these.
Types: `MatchPerson`, `DropItem`, `TodayDrops` and `MatchTypeName` in `src/types/api.ts`.

### Setup (`/matching/setup`)

| Need | Call |
| --- | --- |
| The quiz questions | `GET /api/matching/quiz` → `{ version, questions: [{ id, prompt, options: [{ id, label }] }] }` (options run from one end of a spectrum to the other; show them in order) |
| Load / save the profile | `GET` / `PUT /api/matching/profile` (**write**, saves the whole profile) → `{ exists, profile }` (the professional types only: `COFOUNDER`, `HACKATHON_TEAMMATE`, `COLLABORATOR`, `MENTOR`, `MENTEE`; sending `DATING` is `400 VALIDATION_FAILED`) |
| Date of birth | asked at **onboarding**: `PATCH /api/users { birthDate: "YYYY-MM-DD", headline }` (**write, once**), required to finish onboarding (`GET /api/users/me` → `ageRequired`); `PATCH /api/users/me/profile` takes it too. Read back with `GET /api/users/me/profile`. Never shown to anyone else. Under 16 is `403 AGE_BELOW_MINIMUM`; 16 and 17 make a minor (`isMinor`) who may share a country and nothing finer (`400 MINOR_LOCATION_LIMITED`) |
| Skills to pick from | `GET /api/skills` (send the slugs as `lookingForSkills`) |

A birth date cannot be changed once set (`409 BIRTH_DATE_LOCKED`), so confirm it before
saving. `PUT` replaces the whole profile: send every field the user has, including `paused` (to pause, send the profile back with `paused: true`).

### Discover / Drops (`/discover`, the daily tab)

| Need | Call |
| --- | --- |
| Today's people | `GET /api/drops/today` → `TodayDrops` |
| "Not for me" | `POST /api/drops/{id}/pass` (**write**) → `{ id, status: "PASSED" }` |

Show `drops` in the order given (best fit first). Each has `score` (0-100) and up to three `reasons` to print under the card; `connectionType` is what the user is being
shown this person for (a MENTEE is shown mentors as `MENTEE`). Show at most one drop per type when `drops` holds several types: that is by design. A
`secondLook: true` drop is someone the user passed earlier who has grown since; label it. When `hasProfile` is `false` show the setup; when `paused` is `true` say so; use `nextDropAt`
for "your next drops arrive in…" (it is to the hour). `status` is `NEW` until the user acts: grey out `PASSED` and `SPARKED`, hide `EXPIRED`.
The old `compatibility` number on `/api/discover` and the dashboard keeps its shape.

### Team gap finder (`/teams/{id}`, owner view)

| Need | Call |
| --- | --- |
| What is missing, and who could fill it | `GET /api/teams/{id}/gaps` → `TeamGapsResponse` (owner or team admin only; `403` otherwise: hide the panel) |
| Invite a suggestion | `POST /api/teams/{id}/invitations { userId }` (**write**, as today) |

Show `missing.skills` and `missing.roles` as "Your team needs…" chips (`sources` says whether the team or the project asked), `covered.*` as ticked, and `candidates` (five at most, best first)
as cards with `reasons`, `fills` and an Invite button. `unmatchedStack` is informational ("we can't check Vercel"). An empty `candidates` is normal for a team whose needs nobody fits; a team that
asked for nothing has nothing missing. Suggestions are not drops: opening this panel shows no one to the other person, and nobody is notified until you invite.

### Sparks (`/sparks`, and the Spark button on a drop or a profile)

| Need | Call |
| --- | --- |
| Spark someone | `POST /api/sparks { toId, connectionType, opener, dropId? }` (**write**, send an `Idempotency-Key`) → `{ spark, match }` |
| Who sparked me | `GET /api/sparks/received?limit=&cursor=` → `{ canSee, count, sparks, nextCursor }` |

The **opener** is required: 20 to 280 characters, a real reason to talk. Show the counter while typing and the refusal's `error.details.message` (an English
default; branch on `details.reason`: `TOO_SHORT`, `TOO_LONG`, `TOO_FEW_WORDS`, `LOW_EFFORT`, `LINK`, `CONTACT_DETAILS`, `REPEATED_CHARACTERS`, `DUPLICATE`) when it is
refused. Do not offer "paste a link or a number": they are refused until the two have matched. `connectionType` is the user's own side: on a drop send the drop's
`connectionType`; to answer a received spark send the **counterpart** of its `connectionType` (`MENTOR`↔`MENTEE`, every other type the same). When the other person had already
sparked (the received list shows it) the response carries a `match`: go straight to the match screen, there is no second step. `429 SPARK_LIMIT_REACHED`
(`error.params.limit`) means today's sparks are used (more arrive tomorrow; show the paid plan's number); `429 SPARK_THROTTLED` (`params.retryAfter`) means slow down.
A person who is not available (`404 SPARK_TARGET_UNAVAILABLE`) is shown as "not available"; never explain why.

`canSee: false` in the received list means the plan does not show who sparked: show `count` ("3 people sparked you") with an upgrade prompt and no names. Sparks and
matches never earn XP, so there is no `rewards` envelope to show on these calls.

### Matches (`/matches`)

| Need | Call |
| --- | --- |
| My matches | `GET /api/matches?limit=&cursor=` → `{ matches, nextCursor, total }` |
| Open the chat | `GET /api/conversations/{match.conversationId}` and `POST /api/conversations/{id}` (as any direct conversation) |
| Unmatch | `DELETE /api/matches/{id}` (**write**) → `{ id, endedAt }` |
| Unmatch and report | `POST /api/matches/{id}/report { reason, description? }` (**write**) |

A match opens a conversation that already holds a `SYSTEM` message (the icebreaker: render it as a banner, its sender is the platform) followed by both openers. Show
`yourRole` / `theirRole` for mentoring matches. **Unmatching is final and shuts the chat for both**: ask for confirmation, and afterwards the conversation answers `closedAt`
with a timestamp and `POST` to it is `409 CONVERSATION_CLOSED` (show it read-only). A realtime `match.created` on `user:{id}` means a new match (refresh the list and show the
banner); `match.ended` means the other person ended one. Blocking someone also ends the matches with them (`endedMatches` on the block response).

## Feed pages: Feed, Post, Ship Day

The rules (posts, Props weights, ranking, Ship Day) are in [FEED.md](FEED.md); the routes in [API.md](API.md#posts--feed). Types: `PostItem`, `FeedResponse`, `PostsPageResponse`,
`PostCommentItem`, `PostCommentsResponse`, `PropsResponse`, `FollowPeopleResponse` and `ShipDayResponse` in `src/types/api.ts`. A post's `body` is **Markdown source**, sanitized on the server:
render it with a Markdown renderer that does not allow raw HTML; never put it in `innerHTML` as it is.

### Feed (`/feed`)

| Need | Call |
| --- | --- |
| The page | `GET /api/feed?tab=for-you`, `following`, `city` or `campus`, and `limit=` → `FeedResponse` |
| More | the same with `cursor=<nextCursor>`; stop when `nextCursor` is `null` |
| Give / take back Props | `POST` / `DELETE /api/posts/{id}/props` (**write**, honours `Idempotency-Key`) → `PropsResponse`; update the card from it |
| Follow / unfollow an author | `POST` / `DELETE /api/users/{id}/follow` (**write**) → `{ following }` |
| Watch a project | `POST` / `DELETE /api/projects/{id}/watch` (**write**) → `{ watching }` |

Switching tab starts again without a cursor. `400 INVALID_CURSOR` (a cursor is good for an hour) means "reload the feed", not an error to show. The order is the server's: do not re-sort.
`city` and `campus` are empty until the user has set a place on their profile: say so and link to the profile. Show `yourProps` as the state of the Props button, `propsCount` as the number,
and never `propsScore`. A new post by the user does not appear at the top of the feed by itself: put the `post` from `POST /api/posts` at the top locally.

### Post (`/posts/{id}`, and the composer)

| Need | Call |
| --- | --- |
| Read | `GET /api/posts/{id}` → `{ post }`. `404 POST_NOT_FOUND` for a post that is gone, hidden by a block or not for the user (followers-only, crew-only): all look the same, show "not found" |
| Compose | upload each file first (`POST /api/media/uploads` with `purpose: "POST_MEDIA"`, PUT to the returned URL, `POST /api/media/{id}/complete`), then `POST /api/posts { kind, title, body, projectId?, teamId?, links?, mediaIds?, stackTags?, coAuthorIds?, visibility? }` (**write**, `Idempotency-Key`) → `CreatePostResponse` |
| Edit | `PATCH /api/posts/{id}` with any of `title, body, links, stackTags, visibility` (**write**, author only); show "edited" from `editedAt` |
| Delete | `DELETE /api/posts/{id}` (**write**, author or admin) |
| Comments | `GET /api/posts/{id}/comments?cursor=` → `PostCommentsResponse` (oldest first, replies nested one level) |
| Comment / reply | `POST /api/posts/{id}/comments { body, parentId? }` (**write**, `Idempotency-Key`); replying to a reply is `400 COMMENT_REPLY_DEPTH`, so show Reply only on top-level comments |
| Edit / delete a comment | `PATCH` / `DELETE /api/comments/{id}`: editing is open for 15 minutes (`403 COMMENT_EDIT_WINDOW_CLOSED`, the message says how long); hide Edit after `createdAt + 15 min` |
| A project's timeline | `GET /api/projects/{id}/timeline` → `PostsPageResponse` (a private project's is `404 PROJECT_NOT_FOUND` to non-members) |
| A person's posts | `GET /api/users/{id}/posts` → `PostsPageResponse`; followers / following: `GET /api/users/{id}/followers`, `/following` → `FollowPeopleResponse` |

Composer rules to enforce before sending (the server enforces them too): title 3 to 120 characters, body 1 to 10,000, at most 6 files, 5 links, 10 tags and 5 co-authors (a `DEMO` post for a hackathon squad: up to the hackathon's `maxTeamSize`, at most 10). A `SHIP` post needs a
project the user belongs to; `CREW` visibility needs a project or crew. Co-authors can only be members of the project or crew (`400 POST_COAUTHOR_NOT_MEMBER`). When `shipped` is `true` in the
response the project has just shipped: show the ship celebration. A post made on the author's Friday has the `ship-day` tag in `stackTags`; render it as the Ship Day badge.

### Ship Day (`/ship-day`)

| Need | Call |
| --- | --- |
| The page | `GET /api/ship-day` → `ShipDayResponse` |

If `isShipDay`, show the banner, the live `todayCount`, a countdown to `endsAt` (the end of the user's own Friday), the user's `yourShips` and the day's `topPosts`; the composer is the Post composer
with kind `SHIP` or `DEMO` and nothing extra to set: the tag is applied by the server. If it is not Ship Day, show when the next one is (the coming Friday in the user's zone) and `lastRecap` if there
is one; `todayCount` and `topPosts` are empty before the day starts. `dateKey` is the user's Friday of this week, which on a Saturday or Sunday is behind them. Nothing about Ship Day pays XP by
itself; the *Friday Shipper* achievements arrive through the usual `rewards` envelope.

### Matching preferences (`/matching/preferences`)

The private side of the romance mode, shown under its product name `modeLabel` (never hard-code it: every romance response carries it). Rules in [ROMANCE.md](ROMANCE.md), routes in [API.md](API.md#romance).

| Need | Call |
| --- | --- |
| Load: the form, the labelled choices, whether the user may join | `GET /api/romance/profile` → `{ modeLabel, exists, profile, photos, eligibility, options }` |
| Join / save | `PUT /api/romance/profile` (**write**, saves the whole profile; the first call is `201`) |
| Leave | `DELETE /api/romance/profile` (**write**; final for their open matches, say so before) |
| Photos | upload with `purpose: "ROMANCE_PHOTO"`, then `POST /api/romance/photos { assetId, blurHash? }`; `DELETE /api/romance/photos/{id}` |
| Pause | `PUT` the profile with `paused: true` |

Only draw the form when `eligibility.eligible` is `true`; otherwise list `eligibility.blockers` as steps (`BIRTH_DATE_MISSING`, `UNDER_AGE`, `EMAIL_NOT_VERIFIED`, `NO_PHONE_OR_GITHUB`) and show
nothing else. The **work comes first**: the three prompts, ambition, direction, rhythm and obsessions are the top of the form; gender, who they are interested in, the age range, the scope (`CITY`,
`COUNTRY`, `ANYWHERE`) and `minEndorsements` sit under a section headed "Private filters", with the line that they are **never shown to anyone**: they only decide whom the user is shown and who is
shown to them, and both sides' filters must accept. `profile.private` comes back to its owner only. A person of 16 or 17 never gets the form; do not offer the mode to them at all. The `options`
object holds the choices and the limits; do not hard-code the lists. The weekly drop, sparks, matches, the photo reveal and Duo are `GET /api/romance/drop`, `/sparks/received`, `/matches`,
`/matches/{id}/reveal` and `/duo`; none of them is ever shown on a profile, a passport, a feed or a leaderboard.

## Squads: Hackathon page, Squad Builder, LFG board, Team space

The rules are in [SQUADS.md](SQUADS.md) and the routes in [API.md](API.md#squads). The types are in `src/types/api.ts` under "Squads":
`SquadRole`, `TeamSlotItem`, `TeamStrengthResponse`, `SquadProposal`, `SquadInviteResponse`, `ParticipationResponse`, `SquadProposalsResponse`,
`LfgBoardResponse`, `TeamSpaceResponse`, `PledgeResponse`, `PeerReviewTodoResponse`, `ExternalHackathonResponse` and
`HackathonSquadMetricsResponse`.

Show a role with its label, never the raw enum. `roleLabel` comes back where it matters. Otherwise map the enum (the same labels as `ROLE_LABELS` in `src/lib/squads/roles.ts`):

| Enum | Label |
| --- | --- |
| `FRONTEND` | Frontend developer |
| `BACKEND` | Backend developer |
| `FULLSTACK` | Full-stack developer |
| `MOBILE` | Mobile developer |
| `ML_AI` | ML / AI engineer |
| `DATA` | Data engineer |
| `DEVOPS` | DevOps engineer |
| `DESIGN_UI_UX` | Designer (UI/UX) |
| `PRODUCT` | Product lead |
| `PITCH_BUSINESS` | Pitch & business |
| `HARDWARE` | Hardware engineer |
| `OTHER` | the `customLabel` |

### Hackathon page (`/hackathons/{id}`)

| Need | Call |
| --- | --- |
| The hackathon | `GET /api/hackathons/{id}`. Also `source`, `platform`, `externalUrl`, `mode`, `city`, `country`, `tracks`, `submissionDeadline`, `resultsAt` and `unverified`. |
| Register | `POST /api/hackathons/{id}` (as before) |
| Join the solo pool | `PATCH /api/hackathons/{id}/participation { lookingForTeam, preferredRoles, openToAutoTeam }` (**write**) → `ParticipationResponse` |
| My proposed squads | `GET /api/squad-proposals` → `SquadProposalsResponse`, then `GET /api/squad-proposals/{id}` → `{ proposal }` |
| Answer a pool squad | `POST /api/squad-proposals/{id}/respond { accept }` (**write**) → `{ status, teamId, proposal }` |
| Peer reviews (after the end) | `GET /api/hackathons/{id}/peer-reviews` → `PeerReviewTodoResponse`, and `POST` one per teammate (**write**, `Idempotency-Key`) |
| Add a hackathon from another platform | `POST /api/hackathons/external { url, … }` (**write**, `Idempotency-Key`) → `ExternalHackathonResponse` (`201` new, `200` known) |

**Teamless and registered.** Offer three things: *Find my squad*, *Join the solo pool* (explain that two days before the deadline a squad is
proposed to you, and you have a day to say yes), and *the LFG board*.

**`unverified`.** Show the hackathon with an "Unverified" flag and a link to `externalUrl`. It works for squads, but do not promise XP for it.

**External link errors.**

| Code | Show |
| --- | --- |
| `400 EXTERNAL_URL_REFUSED` | "That link can't be used" |
| `422 EXTERNAL_PAGE_UNREADABLE` | A form asking for the name and dates, then send again with them |
| `422 EXTERNAL_DATES_UNKNOWN` | Ask for the dates |
| `403 ACCOUNT_NOT_TRUSTED` | The account is under a week old or not verified: say when it can try |

**Reviews.** Show the review panel when `window.open` is true. Each review is private: say so. The note is at most 140 characters and only
moderators read it. Never show anyone what was said about them.

### Squad Builder ("Find my squad")

| Need | Call |
| --- | --- |
| Propose | `POST /api/hackathons/{id}/squad-builder { size?, tracks?, seed? }` → `201 { proposal }` |
| Try again | the same with another `seed`: the same seed gives the same squad |
| Send the invitations | `POST /api/hackathons/{id}/squad-builder/{proposalId}/invite { teamName? }` (**write**, send an `Idempotency-Key`) → `SquadInviteResponse` |

**Rendering the proposal.**

- Show `strength.score` as a meter. List `strength.gaps[].message` as what is missing ("No designer").
- For each member, show their `person`, their `roleLabel` and `reasons` (the "why this person" lines). `onTeam` marks the caller and their team.
- After inviting, show `skipped` with a human reason. Then go to the team space.

**Errors.**

| Code | Show |
| --- | --- |
| `422 SQUAD_POOL_EMPTY` | "Nobody to suggest yet": offer the LFG board |
| `409 SQUAD_COMPLETE` | "Your squad is full" |
| `400 TRACK_NOT_FOUND` | Refresh the track list |
| `410 SQUAD_PROPOSAL_EXPIRED` | Propose again |
| `409 SQUAD_PROPOSAL_USED` | The invitations already went out |

### LFG board (`/hackathons/{id}/lfg`)

| Need | Call |
| --- | --- |
| The board | `GET /api/hackathons/{id}/lfg?role=&stack=&tz=&kind=&limit=` → `LfgBoardResponse`; more with `cursor=<nextCursor>` |
| Post | `POST /api/hackathons/{id}/lfg { kind: PERSON, roles, stack?, timezone?, note }`. A team posts `{ kind: TEAM, teamId, … }` (**write**, `Idempotency-Key`). |
| Edit / take down | `PATCH` / `DELETE /api/hackathons/{id}/lfg/{postId}` (**write**, author) |

- The order is the server's (best fit to the viewer first). Do not re-sort.
- Show `fit.score` and `fit.reasons` on each card. `mine` marks the viewer's own post.
- `409 LFG_ACTIVE_POST_EXISTS` carries `details.postId`: open that post for editing instead.
- `tz` takes an IANA zone. Default it to the viewer's own.
- A TEAM card has `team.openSlots`: link "Apply" to `POST /api/teams/{teamId}/applications { slotId }`. The slots are in
  `GET /api/teams/{teamId}/slots`.

### Team space (`/teams/{id}/space`, members only)

| Need | Call |
| --- | --- |
| The page | `GET /api/teams/{id}/space` → `TeamSpaceResponse` |
| Strength | `GET /api/teams/{id}/strength` → `TeamStrengthResponse` (score, components, gaps, who covers which role) |
| Slots | `GET /api/teams/{id}/slots`. Owner: `POST /api/teams/{id}/slots`, `PATCH` / `DELETE /api/teams/{id}/slots/{slotId}`. |
| My role | `PATCH /api/teams/{id}/members/{me} { squadRole, roleLabel? }` |
| Target tracks (owner) | `PATCH /api/teams/{id} { targetTracks }` |
| Pledge | `PUT /api/teams/{id}/pledge { attendance, hoursAvailable, availableFrom, availableUntil }` until the start (`409 PLEDGE_CLOSED` after) |
| Checklist | `POST /api/teams/{id}/checklist { title, assigneeId? }`, `PATCH` / `DELETE /api/teams/{id}/checklist/{itemId}` |
| Ideas | `POST /api/teams/{id}/ideas`. `POST` / `DELETE …/ideas/{ideaId}/vote`. Owner: `POST …/ideas/{ideaId}/choose`. `DELETE …/ideas/{ideaId}`. |
| Post our demo | `POST /api/teams/{id}/demo-post { title, body, links?, mediaIds?, stackTags? }` (**write**, `Idempotency-Key`) → `201 { post }` |
| Keep building (owner, after the end) | `POST /api/teams/{id}/keep-building { projectName? }` → `KeepBuildingResponse` (with `rewards`) |
| Leave / remove | `DELETE /api/teams/{id}/members/{userId}` → `{ reopenedSlotId }` |

**Countdown.** Count down from `hackathon.secondsLeft` to `locksAt`. When `locked` is true, hide every membership and slot control: the server
refuses them with `409 TEAM_LOCKED`.

**Pledges.** Show who has not pledged (`unconfirmedPledges`), and the pledge form, until the start.

**Keep building.** Show it after the hackathon's `endDate` or once `resultsAt` is set. `keptBuildingAt` means it already happened.

**Strength privacy.** Strength never contains the members' reliability. Do not try to derive one.

**Profile badge.** `GET /api/users/{id}` and the player card `GET /api/users/{id}/stats` both have `reliableTeammate: boolean`, by the same rule. Show
it as a "Reliable teammate" badge. There is no number to show.

### Admin

- `PATCH /api/admin/hackathons/{id}/verify { verified }` verifies an external hackathon.
- `GET /api/admin/hackathons/{id}/teams.csv` downloads the teams.
- `GET /api/admin/hackathons/{id}/metrics` returns the squad numbers.
- `GET /api/admin/hackathons/{id}/peer-reviews` returns the reviews with their notes.

## Trust, safety and privacy pages: Report, Mute, Moderation notices and appeals, Privacy settings, Export, Consent, Delete account

The design is in [SAFETY.md](SAFETY.md) and [PRIVACY.md](PRIVACY.md); the endpoints in [API.md](API.md#reports--moderation) and
[API.md](API.md#privacy). Types are in `src/types/api.ts` (`ReportTargetType`, `ModerationHistoryResponse`, `PrivacySettings`, `DataExportResponse`,
`ConsentState`, `QueueResponse` and the rest).

### Report (a menu item on every surface)

Every person, message, post, comment, received spark, romance profile, LFG post, idea and external hackathon gets a **Report** entry in its menu, next
to **Mute** and **Block** where a person is involved. It opens a sheet with the reasons (`HARASSMENT`, `SPAM`, `IMPERSONATION`, `INAPPROPRIATE_CONTENT`,
`MINOR_SAFETY`, `SCAM`, `FAKE_PROFILE`, `COPYRIGHT`, `OTHER`; label `MINOR_SAFETY` "A child may be at risk") and an optional description, then
`POST /api/reports { targetType, targetId, reason, description? }` (**write**, `Idempotency-Key`). On `201` say "Thanks, a moderator will look at it";
on `409 REPORT_ALREADY_PENDING` say it was already reported. Offer **Block** after a report about a person. Never tell the reported person anything.

### Mute

`POST /api/mutes { userId }` hides the person from the caller's feed, comments, lists and drops without blocking; `DELETE /api/mutes/{userId}` undoes it;
`GET /api/mutes` lists them in settings. Copy: "You won't see their posts. They won't know."

### Moderation notices and appeals (`/settings/account`)

Moderation notices arrive as `SYSTEM` notifications with `metadata.kind = "MODERATION"` and link here. The page reads `GET /api/users/me/moderation`:
show `state` at the top (suspended until, banned, which features are restricted until when), then each action with its `category`, `noteToUser`, end date
and an **Appeal** button while `canAppeal`. The appeal form posts `POST /api/appeals { actionId, body }` (10 to 5000 characters). Show `GET /api/appeals`
for their status and decision.

A suspended or banned account gets `403 ACCOUNT_SUSPENDED` (`params.until`) or `ACCOUNT_BANNED` from nearly everything: route it to this page, which
still works, together with the export, delete-account and consent pages. `403 FEATURE_RESTRICTED` (`params.feature`, `params.until`) means one feature is
closed: show "You can't {post / message / use the romance mode} until {date}" where that feature's button is, and link here.

### Privacy settings (`/settings/privacy`)

One page over `GET/PATCH /api/users/me/privacy`: a visibility picker (Everyone / Connections / Only me) for each passport field in `fieldVisibility`;
switches for `hideFromLeaderboards`, `hideFromRecruiters` ("Recruiters" may say "coming soon"), `matchingPaused`, `invisibleMode`, `showActivity`; and
`whoCanMessage` (Everyone / People I'm connected with / Nobody). PATCH only what changed; the response is the whole state. Blocked and muted people are
listed here too (`GET /api/blocks`, `GET /api/mutes`).

On someone else's passport a field they keep to themselves (or to connections, when the viewer is not one) comes back `null`: hide its row.

### Export my data (`/settings/privacy`, "Download my data")

`POST /api/users/me/export` (**write**, `Idempotency-Key`) answers `202` with `status: "PENDING"`; say "We'll notify you when it's ready (usually a few
minutes)". The notification (`metadata.kind = "DATA_EXPORT"`) links back here. `GET /api/users/me/export` shows the latest: while `PENDING` a spinner,
when `READY` a **Download** button on `downloadUrl` (valid until `expiresAt`, 24 hours), `FAILED` "Try again", `404` nothing yet, `410 EXPORT_EXPIRED`
"Expired: ask for a new one".

### Consent (onboarding and after a policy change)

Onboarding shows the terms and the privacy notice with an explicit checkbox each, and records each with `POST /api/users/me/consents { type: "TERMS" |
"PRIVACY", version, source: "onboarding" }`, `version` from `GET /api/users/me/consents` (`currentVersion`). `GET /api/users/me` lists what is still
needed in `consentRequired`; onboarding is not complete until it is empty.

After a policy change any write can answer `403 CONSENT_REQUIRED` with `details.consents` (e.g. `["PRIVACY"]`): show a blocking "We've updated our
{documents}" dialog with the document, record the acceptance the same way (`source: "settings"`), and retry.

**The romance mode** asks for its own consent before the opt-in form is sent: a separate screen explaining that gender and who they are interested in are
sensitive data, used only to find matches, never shown on the professional side, deleted if they withdraw; an unticked checkbox; then `POST
/api/users/me/consents { type: "ROMANCE_MODE", version, source: "romance-optin" }`. `PUT /api/romance/profile` without it answers `403
ROMANCE_CONSENT_REQUIRED` with the version in `details.consent`. Settings has **Withdraw consent and delete my romance data** (`DELETE
/api/users/me/consents/ROMANCE_MODE`), with a confirmation that says what is deleted. Marketing is an optional switch (`MARKETING`).

### Delete account (`/settings/account`)

A danger-zone button with a typed confirmation, then `DELETE /api/users/me`. It needs a recent sign-in: on `403 REAUTH_REQUIRED` run Clerk's
reverification (or sign-in) and retry. On `200` sign out and show "Your account was deleted". Say before they confirm what stays (messages in other
people's conversations, shown as from a deleted account; shared projects and crews) and what goes (everything else).

### Avatar upload

Upload with `purpose: "AVATAR"` (`POST /api/media/uploads`, PUT, `POST /api/media/{id}/complete`). The confirm answers `status: "READY"` when the scan
passed (then `PUT /api/users/me/avatar { mediaId }`), `IN_REVIEW` ("We're checking your photo, it'll show once approved"), `BLOCKED` ("This photo can't be
used"), or `SCANNING` (poll `GET /api/media/{id}`). Romance photos follow the same states. `503 MEDIA_SCANNING_UNAVAILABLE`: "Photo uploads are
unavailable right now".

### Content refusals and gates on existing pages

| Code | Where | Show |
| --- | --- | --- |
| `400 CONTENT_REJECTED` (`details.reasons`) | composer, comment box, chat input, LFG and idea forms | "This can't be posted as written" with a hint per reason (`LINK_NOT_ALLOWED` / `CONTACT_DETAILS`: "Share links and contact details once you've both written"; `REPEATED`: "You've sent this a few times already") and keep the text |
| `403 EMAIL_VERIFICATION_REQUIRED` | composer (public), comments | "Verify your email to post publicly" with a link to Clerk's verification; followers-only posts still work |
| `403 MESSAGING_NOT_ALLOWED` | "Message" button | "{name} isn't accepting messages" (hide the button when you can) |
| `503 *_PAUSED` | the affected feature | "This is paused for a little while"; nothing to retry immediately |
| `409 ROMANCE_PROFILE_HIDDEN` | romance profile "visible" switch | "Your profile is hidden while a moderator reviews it" |
| `403 SIGNUP_EMAIL_REJECTED`, `429 SIGNUP_RATE_LIMITED`, `503 SIGNUPS_PAUSED` | first screen after sign-up | the message from the error, with sign-out |

### Admin console (staff only)

`/admin/queue` over `GET /api/admin/queue` (tabs for reports and appeals), a report page over `GET /api/admin/reports/{id}` with the action form (`POST
/api/admin/actions`), appeal decisions (`POST /api/admin/appeals/{id}/decide`), people lookup (`GET /api/admin/users?q=`), fraud signals, and for admins
the audit log, roles, verification marks, plans and the kill switches (`/api/admin/flags`). Destructive actions answer `403 REAUTH_REQUIRED` when the
session is old: reverify and retry.

## Backend gaps closed for these pages

| Gap | Fix |
| --- | --- |
| Hackathon cards could not show "Registered" or "My team" | `registered`, `myTeamId`, `myStatus` on every list item |
| Conversation tabs and search had no server support | `type` and `search` query params; `unreadCount` and `totalUnread` |
| Profile mock showed email and rank | own email only; live `rank`; `compatibility` and `blockedByMe` |
| Profile Activity tab | new `GET /api/activity` |
| Dashboard bypassed API rules | new `GET /api/dashboard` and `src/lib/dashboard.ts` |
| Read state and reactions | `POST /api/conversations/{id}/read`, `/api/messages/{id}/reactions` |
| Progress features had no endpoints | updates and milestones under `/api/projects/{id}/` |
| Evidence and endorsements | `/api/evidence` and `/api/evidence/{id}/endorse` |
| Blocking | `/api/blocks`, enforced across every list and interaction |
| Reward feedback after an action | `rewards` envelope on the awarding routes (streak, achievements, quests included); level-up, tier, achievement, quest and cosmetic notifications |
| Streaks, quests, achievements, cosmetics, seasons, location leaderboards | Stage 1B: see Progress pages above |
| Infinite scroll and retries | `cursor` / `nextCursor` on every list; `Idempotency-Key` on creating POSTs |
| Showing work: posts, Props, comments, follows, the feed, Ship Day | Stage 1D: see Feed pages above |

## Still missing (no backend, needs a product decision)

| Item | Note |
| --- | --- |
| Presence / typing indicators | Needs a realtime channel. |
| Project stars and forks | No data model. |
| Mutual-follow (friends) view | Follows are one-way (`/api/users/{id}/follow`); connections remain the mutual relationship. |
| Team and project logos | Only `Project.thumbnail` exists; upload storage is not built. |
