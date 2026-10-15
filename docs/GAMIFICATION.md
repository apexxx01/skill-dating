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

`xpForLevel(n) = round(60 × n^1.25)` is the XP needed to get from level `n` to level
`n + 1`. Level 1 starts at 0 XP. The maximum level is 100, which has no next level.
Level 2 starts at 60 XP, so a first project (50 XP) with its *First Project* achievement
(25 XP) takes a new user to level 2, and no further: level 3 starts at 203.

| Level | Size of the level | Total XP where it starts |
| ---: | ---: | ---: |
| 1 | 60 | 0 |
| 2 | 143 | 60 |
| 3 | 237 | 203 |
| 4 | 339 | 440 |
| 5 | 449 | 779 |
| 10 | 1,067 | 4,216 |
| 20 | 2,538 | 21,298 |
| 35 | 5,108 | 76,915 |
| 55 | 8,987 | 215,200 |
| 80 | 14,355 | 503,253 |
| 100 | 18,974 | 833,806 |

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
them. Nothing is random and nothing touches the database. Paste the output back here after changing
a rule; a unit test (`src/lib/progression-sim.test.ts`) keeps the script honest about caps and levels.

- **Casual**: 3 actions a week: a project every two weeks, shipped, with a milestone and an update along the way. Earns about 24 XP a day over its first year.
- **Active**: Something every day, about 3 a day: a project every 10 days, milestones, updates, and the social side. Earns about 69 XP a day over its first year.
- **Power**: About 6 a day, ships a project every week, joins a hackathon every month. Earns about 142 XP a day over its first year.
- **Ceiling**: Hits every daily cap every day. The fastest the rules allow, not a person. Earns about 1181 XP a day over its first year.

Days until the user first reaches each level (a tier starts at levels 10, 20, 35, 55 and 80):

| User | Level 2 | Level 5 | Level 10 | Level 20 | Level 35 | Level 55 | Level 80 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Casual | 10 d | 28 d (4.0 wk) | 182 d (6.0 mo) | 910 d (2.5 yr) | never (6 yr+) | never (6 yr+) | never (6 yr+) |
| Active | 2 d | 10 d | 60 d (8.6 wk) | 310 d (10.2 mo) | 1120 d (3.1 yr) | never (6 yr+) | never (6 yr+) |
| Power | 1 d | 7 d | 29 d (4.1 wk) | 153 d (5.0 mo) | 546 d (1.5 yr) | 1525 d (4.2 yr) | never (6 yr+) |
| Ceiling | 1 d | 1 d | 4 d | 18 d (2.6 wk) | 65 d (9.3 wk) | 183 d (6.0 mo) | 427 d (14.0 mo) |

What the curve is tuned against, and how far off it is:

| Target | Wanted | Simulated | XP a day: needed / earned | |
| --- | --- | --- | --- | --- |
| First project and its achievement | level 2 | level 2 | | met |
| Casual: Silver in 6-8 weeks | 42-56 d | 182 d (6.0 mo) | 86 / 24 | MISSED (too slow) |
| Active: Gold in 3-4 months | 91-122 d | 310 d (10.2 mo) | 200 / 69 | MISSED (too slow) |
| Power: Platinum in 9-12 months | 274-365 d | 546 d (1.5 yr) | 241 / 142 | MISSED (too slow) |
| Mythic is top-0.1% territory | not within 3 years of steady play | Power: never (6 yr+) | | met |

How to read it. The first-project target is met: 75 XP is level 2, not level 3. The three
speed targets are not: with the amounts in the XP table, this curve is 2 to 4 times too slow for
them. The "needed" column is the XP a day a user would have to earn, on average, to land in the
middle of the target window; none of the three users earns anything like it. Three actions a
week cannot: most actions pay 5 to 50 XP and only shipping pays 200, so a casual user earns about
24 XP a day, not 86.

What would meet them, found by searching `round(a × n^p)` against these same users:

- Keeping the XP table, a steeper and much cheaper-to-start curve fits all three speed targets,
  for example `round(5 × n^1.85)` (casual 42 days to Silver, active 120 to Gold, power 303 to
  Platinum; the ceiling reaches Mythic in about a year). The price is the first target: level 2
  would start at 5 XP, so a first project and its achievement would land on level 4.
- Keeping "a first project reaches level 2" (`a` of at least about 22), no `(a, p)` fits all three:
  the best compromise (`round(24 × n^1.2)`) puts casual and active inside their windows and power at about 6
  months instead of 9 to 12.
- Or change the economy rather than the curve: the XP amounts in `REWARD_RULES` and the
  achievements are the other lever.

Mythic stays out of reach for ordinary play with the current curve: the power user does not get
there in six years, and only a user who hits every daily cap, every day (the ceiling) takes about 14 months.

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
    "oldLevel": 1, "newLevel": 2, "leveledUp": true,
    "oldTier": "BRONZE", "newTier": "BRONZE", "tierChanged": false,
    "achievements": [{ "slug": "first-project", "name": "First Project" }],
    "questsCompleted": [], "streak": null
  }
}
```

Shipping that project (200 XP, plus 100 for *Shipped It*) takes the user from 75 to
375 XP, across the level 3 boundary at 203:

```json
{
  "rewards": {
    "xpGained": 300, "totalXp": 375,
    "oldLevel": 2, "newLevel": 3, "leveledUp": true,
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
    "xpGained": 50, "totalXp": 4256,
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
