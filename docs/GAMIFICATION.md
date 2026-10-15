# Gamification: XP, levels, tiers and achievements

Everything that decides who earns what lives in three small files, so the numbers can
be tuned without touching a route:

| File | What it holds |
| --- | --- |
| `src/lib/rewards-config.ts` | XP amounts, daily caps, the one-time rule, and which domain event pays what |
| `src/lib/levels.ts` | The level curve and the tiers (pure functions) |
| `src/lib/achievement-definitions.ts` | The achievements and their XP |

The code that applies them is `src/lib/rewards.ts` (`grant()`). **It is the only code that writes an
`XPEvent` or changes `User.xp`.** Routes never award anything themselves: they emit a
domain event inside their transaction, and the rewards engine, which subscribes to it,
pays out on the same transaction (see [ARCHITECTURE.md](ARCHITECTURE.md#domain-events-and-rewards)).
An action that rolls back pays nothing, and a reward that fails rolls the action back.

## XP table

| Action (`XPEvent.type`) | Paid when | XP | Once per | Daily cap |
| --- | --- | --- | --- | --- |
| `PROJECT_CREATED` | a project is created | 50 | project | 3 a day |
| `PROJECT_SHIP` | a project's status first becomes `SHIPPED` | 200 | project, ever | 3 a day |
| `HACKATHON_JOIN` | the user registers for a hackathon | 100 | hackathon | none |
| `TEAM_FORMED` | the user registers a team for a hackathon | 50 | hackathon | none |
| `HACKATHON_WIN` | the user's team is recorded as rank 1 | 500 | hackathon | none |
| `ACHIEVEMENT_EARNED` | an achievement unlocks | the achievement's own XP | achievement | none |

Events that are announced but pay nothing yet: `PROJECT_UPDATE_POSTED` and
`MILESTONE_COMPLETED` (achievements only), `CONNECTION_ACCEPTED` and
`MESSAGE_SENT_FIRST_IN_CONNECTION` (nothing yet; they exist so later stages can
subscribe).

### Achievements

| Slug | Name | XP | Unlocked by |
| --- | --- | --- | --- |
| `first-project` | First Project | 25 | `PROJECT_CREATED` |
| `first-ship` | Shipped It | 100 | `PROJECT_SHIPPED` |
| `first-hackathon` | Hackathon Rookie | 25 | `HACKATHON_JOINED` |
| `team-builder` | Team Builder | 25 | `TEAM_FORMED` |
| `team-player` | Team Player | 25 | `TEAM_APPLICATION_ACCEPTED` |
| `hackathon-winner` | Hackathon Winner | 250 | `HACKATHON_WON` |
| `first-evidence` | Show Your Work | 25 | `EVIDENCE_ADDED` |
| `endorsed` | Vouched For | 50 | `EVIDENCE_ENDORSED` (see below) |
| `first-update` | Building in Public | 25 | `PROJECT_UPDATE_POSTED` |
| `first-milestone` | Milestone Reached | 50 | `MILESTONE_COMPLETED` |

An achievement unlocks once per user. Its XP is paid as an `ACHIEVEMENT_EARNED`
award, so it counts toward levels like any other XP, and a level-up it causes is
reported too.

**Endorsements** are the one reward other people can trigger, so they are gated
before they pay (`endorsementRewardAllowed` in `src/lib/skill-evidence.ts`): the
endorser must have a verified account, one endorser can trigger at most 10
rewards per rolling day, and one owner can earn at most 50 XP a day from them. The
endorsement itself always counts toward the evidence.

## How "the same award" is decided

Every award stores `sourceType` and `sourceId` (what it was for) and a `dedupeKey`
built from them: `project:<projectId>`, `hackathon:<hackathonId>`,
`achievement:<slug>`. A unique index on `XPEvent (userId, type, dedupeKey)`
makes a second award for the same thing impossible, whatever retries, double clicks or
parallel requests happen. When two requests race, the database lets one insert win
and the other sees nothing was written and pays nothing.

- Creating a project twice is two different sources: both can pay (up to the cap).
- Shipping, cycling `SHIPPED → BUILDING → SHIPPED`, never pays twice for one project: the project's
  `shippedAt` is set only once, and the dedupe key backs it up.
- Re-recording hackathon results for a team that already won pays nothing more.

## Daily caps

A cap counts awards of one action since the start of the user's **local** day. The
day comes from `User.timezone` (an IANA name such as `Asia/Kolkata`) and falls back
to UTC when it is empty or not a zone the server knows. All timestamps are stored in
UTC; only "which day is it for this person" depends on the zone. Days that are 23 or
25 hours long (daylight saving), half-hour zones and zones that skip or repeat
midnight are handled by the runtime's time-zone database, not by fixed offsets
(`src/lib/time.ts`).

When the cap is reached, the action itself still succeeds; it just pays 0 XP
(`rewards.xpGained: 0`). The count includes awards for things that were deleted
afterwards, so creating and deleting projects in a loop stops paying after the third.
Capped awards for the same user and action are serialised with a transaction lock, so
parallel requests cannot all slip under the cap.

## Level curve

`xpForLevel(n) = round(100 × n^1.5)` is the XP needed to get from level `n` to level
`n + 1`. Level 1 starts at 0 XP. The maximum level is 100, which has no next level.

| Level | Size of the level | Total XP where it starts |
| ---: | ---: | ---: |
| 1 | 100 | 0 |
| 2 | 283 | 100 |
| 3 | 520 | 383 |
| 4 | 800 | 903 |
| 5 | 1,118 | 1,703 |
| 10 | 3,162 | 11,106 |
| 20 | 8,944 | 67,135 |
| 35 | 20,706 | 279,605 |
| 55 | 40,789 | 877,054 |
| 80 | 71,554 | 2,254,066 |
| 100 | 100,000 | 3,950,120 |

`levelFor(xp)` returns `{ level, tier, xpIntoLevel, xpForNextLevel, progress }`, where
`progress` is `xpIntoLevel / xpForNextLevel` (0 to 1; always 1 at level 100, where
`xpForNextLevel` is 0).

### Tiers

| Tier | Levels |
| --- | --- |
| `BRONZE` | 1 to 9 |
| `SILVER` | 10 to 19 |
| `GOLD` | 20 to 34 |
| `PLATINUM` | 35 to 54 |
| `DIAMOND` | 55 to 79 |
| `MYTHIC` | 80 and up |

The constants are `TIERS` and `TIER_START_LEVEL` in `src/lib/levels.ts`.

## What the interface receives: `RewardsEnvelope`

Every mutation that can award anything returns a `rewards` object next to its normal
body, **also when nothing was earned** (then `xpGained` is 0), so the interface can
always read it. The type is `RewardsEnvelope` in `src/types/api.ts`.

```ts
interface RewardsEnvelope {
  xpGained: number          // XP added by this request, achievement XP included
  totalXp: number           // the user's XP after this request
  oldLevel: number
  newLevel: number
  leveledUp: boolean
  oldTier: 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' | 'DIAMOND' | 'MYTHIC'
  newTier: Tier
  tierChanged: boolean
  achievements: { slug: string; name: string }[]   // unlocked by this request
  questsCompleted: { slug: string; name: string }[] // always [] until quests ship
  streak: null                                       // null until streaks ship
}
```

Routes that return it: `POST /api/projects`, `PATCH /api/projects/{id}`,
`POST /api/projects/{id}/updates`, `PATCH /api/projects/{id}/milestones/{milestoneId}`,
`POST /api/hackathons/{id}` (register), `POST /api/hackathons/{id}/teams`,
`PATCH /api/hackathons/{id}/results`, `POST /api/evidence` and
`PATCH /api/teams/{id}/applications/{applicationId}`. The envelope always describes
the **signed-in caller**. A route that rewards someone else (the winners of a
hackathon, an applicant who was accepted, the owner of endorsed evidence) tells them with
a notification instead.

### Examples

First project (50 XP for the project, 25 for the *First Project* achievement):

```json
{
  "id": "clx…", "name": "Habit tracker",
  "rewards": {
    "xpGained": 75, "totalXp": 75,
    "oldLevel": 1, "newLevel": 1, "leveledUp": false,
    "oldTier": "BRONZE", "newTier": "BRONZE", "tierChanged": false,
    "achievements": [{ "slug": "first-project", "name": "First Project" }],
    "questsCompleted": [], "streak": null
  }
}
```

Shipping that project (200 XP, plus 100 for *Shipped It*) takes the user from 75 to
375 XP, across the level 2 boundary at 100:

```json
{
  "rewards": {
    "xpGained": 300, "totalXp": 375,
    "oldLevel": 1, "newLevel": 2, "leveledUp": true,
    "oldTier": "BRONZE", "newTier": "BRONZE", "tierChanged": false,
    "achievements": [{ "slug": "first-ship", "name": "Shipped It" }],
    "questsCompleted": [], "streak": null
  }
}
```

A user 10 XP short of level 10 creates a project (tier boundary: `BRONZE` → `SILVER`):

```json
{
  "rewards": {
    "xpGained": 50, "totalXp": 11146,
    "oldLevel": 9, "newLevel": 10, "leveledUp": true,
    "oldTier": "BRONZE", "newTier": "SILVER", "tierChanged": true,
    "achievements": [], "questsCompleted": [], "streak": null
  }
}
```

A fourth project in a day, or a repeated action that already paid:

```json
{ "rewards": { "xpGained": 0, "totalXp": 175, "oldLevel": 2, "newLevel": 2, "leveledUp": false,
               "oldTier": "BRONZE", "newTier": "BRONZE", "tierChanged": false,
               "achievements": [], "questsCompleted": [], "streak": null } }
```

## Notifications and analytics

Inside the same transaction, the engine creates a `Notification` (type `ACHIEVEMENT`, with
`metadata.kind` of `LEVEL_UP`, `TIER_UP` or `ACHIEVEMENT_UNLOCKED`) for a level-up, a
tier change and an unlocked achievement. After the transaction commits it records the
product events `level_up`, `tier_up` and `achievement_earned` (no personal data in
their properties; see [ARCHITECTURE.md](ARCHITECTURE.md#analytics)).

## Reading XP

`User.xp` is a denormalised cache of the sum of the user's `XPEvent` rows, changed only
by `grant()`. The leaderboard reads the live sum from `XPEvent`, not the cache.
`XPEvent.seasonId` is reserved for seasons and is always null for now.

## Changing the rules

- A new amount or cap: edit `REWARD_RULES` in `src/lib/rewards-config.ts`. Existing awards
  are not recalculated.
- A new rewarded action: add the action to `REWARD_RULES`, add the domain event
  to `src/lib/events.ts` and to `EVENT_REWARDS`, and emit the event from the route inside
  its transaction. Nothing else pays XP.
- A new achievement: add it to `ACHIEVEMENT_DEFINITIONS` and name it in `EVENT_REWARDS`. It is
  not granted retroactively.
