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
An action that rolls back pays nothing, and a reward that fails rolls the action back. A unit test (`src/lib/xp-writers.test.ts`) fails if any other file under `src/` writes an `XPEvent` or changes `User.xp`; only the demo seed (`prisma/seed.ts`) writes sample XP directly.

## XP table

| Action (`XPEvent.type`) | Paid when | XP | Once per | Daily cap |
| --- | --- | --- | --- | --- |
| `PROJECT_CREATED` | a project is created | 50 | project | 3 a day |
| `PROJECT_SHIP` | a project's status first becomes `SHIPPED` | 200 | project, ever | 3 a day |
| `HACKATHON_JOIN` | the user registers for a hackathon | 100 | hackathon | none |
| `TEAM_FORMED` | the user registers a team for a hackathon | 50 | hackathon | none |
| `HACKATHON_WIN` | the user's team is recorded as rank 1 | 500 | hackathon | none |
| `ACHIEVEMENT_EARNED` | an achievement unlocks | the achievement's own XP | achievement | none |
| `MILESTONE_COMPLETED` | a project milestone is completed | 30 | milestone | 5 a day |
| `PROJECT_UPDATE_POSTED` | the user posts a project update | 15 | update | 3 a day |
| `EVIDENCE_ADDED` | the user attaches evidence to a skill | 20 | evidence | 3 a day |
| `EVIDENCE_ENDORSED` | someone else endorses the user's evidence (paid to the **owner**) | 10 | evidence and endorser | 10 a day |
| `CONNECTION_ACCEPTED` | a connection request is accepted (paid to **both** people) | 10 | connection | 5 a day, each |
| `MESSAGE_SENT_FIRST_IN_CONNECTION` | the user sends the first message of a direct conversation with a connection (paid to the **sender**) | 5 | conversation | 5 a day |
| `TEAM_APPLICATION_ACCEPTED` | a team application is accepted (paid to the **applicant**, not to whoever accepted it) | 50 | application | none |

Who is **not** paid: the milestone update post that completing a milestone creates is not an
update the user posted, so it pays nothing as one; nobody is paid for endorsing their own
evidence or across a block (the route refuses both, and the reward check refuses them
again); declined connections and rejected applications pay nothing; a second message in a
conversation is not a first message.

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
before they pay, XP and achievement alike (`endorsementRewardAllowed` in
`src/lib/skill-evidence.ts`): not for yourself or across a block, the endorser must
have a verified account, and one endorser can trigger at most 10 rewards per rolling
day. How much one owner can earn per day is the rule's own cap (10 payments, so 100
XP), enforced by the engine like every other cap. The endorsement itself always
counts toward the evidence.

## How "the same award" is decided

Every award stores `sourceType` and `sourceId` (what it was for) and a `dedupeKey`
built from them: `project:<projectId>`, `hackathon:<hackathonId>`,
`achievement:<slug>`, `milestone:<id>`, `connection:<id>`, `conversation:<id>`,
`team_application:<id>`, and `endorsement:<evidenceId>:<endorserId>` (so each endorser pays
an owner once per piece of evidence, however often they withdraw and endorse again).
A unique index on `XPEvent (userId, type, dedupeKey)`
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

`xpForLevel(n) = round(5 × n^1.85)` is the XP needed to get from level `n` to level
`n + 1`. Level 1 starts at 0 XP. The maximum level is 100, which has no next level.
The early levels are deliberately cheap: level 2 starts at 5 XP and level 4 at 61, so a first
project (50 XP) with its *First Project* achievement (25 XP) takes a new user to **level 4**,
the onboarding moment, and level 5 starts at 126. The curve then steepens, which is what keeps the
upper tiers rare (see the simulation below).

| Level | Size of the level | Total XP where it starts |
| ---: | ---: | ---: |
| 1 | 5 | 0 |
| 2 | 18 | 5 |
| 3 | 38 | 23 |
| 4 | 65 | 61 |
| 5 | 98 | 126 |
| 10 | 354 | 1,070 |
| 20 | 1,276 | 8,326 |
| 35 | 3,593 | 42,348 |
| 55 | 8,292 | 155,891 |
| 80 | 16,584 | 457,255 |
| 100 | 25,059 | 866,787 |

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

## How long it takes: the progression simulation

`npm run sim:progression` (`scripts/simulate-progression.ts`) plays four kinds of user, day by day
for six years, against the real rules. The XP table, daily caps, once-per-source rule, achievements
and level curve are imported from the files above, not copied, so the numbers follow any change to
them. Nothing is random and nothing touches the database. After changing a rule, run it and paste
the output below; a unit test (`src/lib/progression-sim.test.ts`) keeps the script honest about
caps and levels.

- **Casual**: 3 actions a week: a project every two weeks, shipped, with a milestone and an update along the way. Earns about 24 XP a day over its first year.
- **Active**: Something every day, about 3 a day: a project every 10 days, milestones, updates, and the social side. Earns about 69 XP a day over its first year.
- **Power**: About 6 a day, ships a project every week, joins a hackathon every month. Earns about 142 XP a day over its first year.
- **Ceiling**: Hits every daily cap every day. The fastest the rules allow, not a person. Earns about 1181 XP a day over its first year.

Days until the user first reaches each level (a tier starts at levels 10, 20, 35, 55 and 80):

| User | Level 2 | Level 5 | Level 10 | Level 20 | Level 35 | Level 55 | Level 80 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Casual | 10 d | 14 d (2.0 wk) | 42 d (6.0 wk) | 350 d (11.5 mo) | 1820 d (5.0 yr) | never (6 yr+) | never (6 yr+) |
| Active | 2 d | 3 d | 14 d (2.0 wk) | 120 d (3.9 mo) | 616 d (1.7 yr) | never (6 yr+) | never (6 yr+) |
| Power | 1 d | 1 d | 7 d | 59 d (8.4 wk) | 303 d (10.0 mo) | 1104 d (3.0 yr) | never (6 yr+) |
| Ceiling | 1 d | 1 d | 1 d | 7 d | 36 d (5.1 wk) | 132 d (4.3 mo) | 388 d (12.8 mo) |

What the curve is tuned against:

| Target | Wanted | Simulated | XP a day: needed / earned | |
| --- | --- | --- | --- | --- |
| First project and its achievement | level 4 | level 4 | | met |
| Casual: Silver in 6-8 weeks | 42-56 d | 42 d (6.0 wk) | 22 / 24 | met |
| Active: Gold in 3-4 months | 91-122 d | 120 d (3.9 mo) | 78 / 69 | met |
| Power: Platinum in 9-12 months | 274-365 d | 303 d (10.0 mo) | 133 / 142 | met |
| Mythic is top-0.1% territory | not within 3 years of steady play | Power: never (6 yr+) | | met |

The curve was tuned against these users. Notes on the targets:

- **The first project lands on level 4**, on purpose. A curve that also met the speed targets
  below and kept the first project on level 2 does not exist among `round(a × n^p)` curves; the
  closest, `round(24 × n^1.2)`, puts power at about 6 months to Platinum instead of 9 to 12. Cheap early levels and a steep later
  curve were chosen over that.
- **Mythic stays top-0.1% territory.** The power user reaches Diamond (level 55) in about 3 years and
  does not reach Mythic (level 80) within the six simulated; run for longer, it takes about 9 years.
  Only the ceiling, a user who hits every daily cap every day (a person cannot), gets there in about 13 months. No steeper upper
  levels were needed.
- Casual and active sit at the early edge of their windows (42 days of 42 to 56, 120 days of 91 to 122), so a
  cut to an XP amount slows them past the target; re-run the script after touching `REWARD_RULES`.

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

Two routes pay the caller XP without returning an envelope yet:
`PATCH /api/connections/{id}` (accepting) and `POST /api/conversations/{id}` (the first
message of a direct conversation). The gain shows in the next read of the user's XP.

### Examples

First project (50 XP for the project, 25 for the *First Project* achievement):

```json
{
  "id": "clx…", "name": "Habit tracker",
  "rewards": {
    "xpGained": 75, "totalXp": 75,
    "oldLevel": 1, "newLevel": 4, "leveledUp": true,
    "oldTier": "BRONZE", "newTier": "BRONZE", "tierChanged": false,
    "achievements": [{ "slug": "first-project", "name": "First Project" }],
    "questsCompleted": [], "streak": null
  }
}
```

Shipping that project (200 XP, plus 100 for *Shipped It*) takes the user from 75 to
375 XP, from level 4 to level 7 (which starts at 362):

```json
{
  "rewards": {
    "xpGained": 300, "totalXp": 375,
    "oldLevel": 4, "newLevel": 7, "leveledUp": true,
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
    "xpGained": 50, "totalXp": 1110,
    "oldLevel": 9, "newLevel": 10, "leveledUp": true,
    "oldTier": "BRONZE", "newTier": "SILVER", "tierChanged": true,
    "achievements": [], "questsCompleted": [], "streak": null
  }
}
```

A fourth project in a day, or a repeated action that already paid:

```json
{ "rewards": { "xpGained": 0, "totalXp": 175, "oldLevel": 5, "newLevel": 5, "leveledUp": false,
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
