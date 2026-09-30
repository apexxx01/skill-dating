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
| Auth | Session cookie. No session gives `401 { error }`. |
| Errors | Always `{ error: string, details?: unknown }`. Validation failures are `400` with `details` as `{ field: string[] }`. |
| Pagination | `?page=1&limit=20`, response carries `pagination: { page, limit, total, totalPages }`. `limit` is capped per route (usually 50, messages and leaderboard 100). Asking for more than the cap is a `400`, not a silent clamp. |
| Rate limits | Per signed-in user, per route family. Over the limit gives `429 { error }` with a `Retry-After` header (seconds). If the limiter store is down you may see `503` with `Retry-After`. Back off and retry; do not hammer. |
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

`achievements[]` is `{ id, earnedAt, achievement: { name, slug, description,
icon, category, xpReward, isSecret } }`. `icon` is a string name (for example
`"rocket"`), not a component: map it to an icon in the UI. Only
earned achievements are listed; the full catalogue is not exposed, so a
locked-badge grid has no API behind it.

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

Registration rules the UI should mirror: `400 "Registration closed"` when the
status is not open, `400 "Registration deadline passed"`, `400 "Already
registered"`. Entering a team needs you to be registered first and to be a
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
| Streaks and "weekly goal" | **No API.** |
| Stat tiles (projects, connections, XP) | `xp` from the profile/leaderboard `me`; counts from list `pagination.total`. |
| Leaderboard position | `GET /api/leaderboard` → `me.rank` (`null` when you have no XP yet). |

---

## Leaderboard

`GET /api/leaderboard?page=&limit=` returns
`{ entries: [{ rank, xp, user }], me: { xp, rank | null }, pagination }`.
Ranks are computed live from the XP log, among users you can see. `me.rank` is
`null` until you have earned XP.

---

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

## Still missing (no backend, needs a product decision)

| Item | Note |
| --- | --- |
| Presence / typing indicators | Needs a realtime channel. |
| Project stars and forks | No data model. |
| Followers and following | Only symmetric connections exist. |
| Streaks and weekly goals | No data model. |
| Team and project logos | Only `Project.thumbnail` exists; upload storage is not built. |
