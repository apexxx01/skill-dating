# Gamification: XP, levels, streaks, achievements, quests, leaderboards, cosmetics and seasons

Everything that decides who earns what lives in a few small files, so the numbers can
be tuned without touching a route:

| File | What it holds |
| --- | --- |
| `src/lib/rewards-config.ts` | XP amounts, daily caps, the one-time rule, whether an award counts for the streak, and which domain event pays what |
| `src/lib/levels.ts` | The level curve and the tiers (pure functions) |
| `src/lib/streaks.ts` | The streak rules (pure functions) |
| `src/lib/metrics.ts` | What is counted per user, and which event counts what |
| `src/lib/achievement-definitions.ts` | The 43 achievements, their XP and what unlocks them |
| `src/lib/quest-definitions.ts`, `src/lib/quests.ts` | The quest pool and the daily and weekly rotation |
| `src/lib/cosmetic-definitions.ts` | The cosmetics and the rules that unlock them |
| `src/lib/leaderboard-boards.ts` | The boards: periods, scopes, and what each is called in the cache |

The code that applies them is `src/lib/rewards.ts` (`grant()`). **It is the only code that writes an
`XPEvent` or changes `User.xp`.** Routes never award anything themselves: they emit a
domain event inside their transaction, and the rewards engine, which subscribes to it,
pays out on the same transaction (see [ARCHITECTURE.md](ARCHITECTURE.md#domain-events-and-rewards)).
An action that rolls back pays nothing, and a reward that fails rolls the action back. A unit test
(`src/lib/xp-writers.test.ts`) fails if any other file under `src/` writes an `XPEvent` or changes
`User.xp`; only the demo seed (`prisma/seed.ts`) writes sample XP directly.

```
route ──emit──▶ domain event ──▶ payForEvent (src/lib/subscribers.ts), on the route's transaction
                                   1. the gates (endorsements, accepted applications)
                                   2. grant()  ─ XP, the daily cap, the streak, the season stamp, level and tier
                                   3. advanceProgress ─ count the event, unlock achievements, move quests
                                   4. cosmetics for the tier / achievement / streak that just happened
                    after commit ──▶ leaderboards, cached views, analytics
```

## XP table

| Action (`XPEvent.type`) | Paid when | XP | Once per | Daily cap | Counts for the streak |
| --- | --- | --- | --- | --- | --- |
| `PROJECT_CREATED` | a project is created | 50 | project | 3 a day | yes |
| `PROJECT_SHIP` | a project's status first becomes `SHIPPED` | 200 | project, ever | 3 a day | yes |
| `HACKATHON_JOIN` | the user registers for a hackathon | 100 | hackathon | none | yes |
| `TEAM_FORMED` | the user registers a team for a hackathon | 50 | hackathon | none | yes |
| `HACKATHON_WIN` | the user's team is recorded as rank 1 | 500 | hackathon | none | no |
| `ACHIEVEMENT_EARNED` | an achievement unlocks | the achievement's own XP | achievement | none | no |
| `QUEST_COMPLETED` | a daily or weekly quest is completed | the quest's own XP | quest and period | none (at most 3 + 3 quests are open) | no |
| `MILESTONE_COMPLETED` | a project milestone is completed | 30 | milestone | 5 a day | yes |
| `PROJECT_UPDATE_POSTED` | the user posts a project update | 15 | update | 3 a day | yes |
| `EVIDENCE_ADDED` | the user attaches evidence to a skill | 20 | evidence | 3 a day | yes |
| `EVIDENCE_ENDORSED` | someone else endorses the user's evidence (paid to the **owner**) | 10 | evidence and endorser | 10 a day | no |
| `CONNECTION_ACCEPTED` | a connection request is accepted (paid to **both** people) | 10 | connection | 5 a day, each | the one who accepted |
| `MESSAGE_SENT_FIRST_IN_CONNECTION` | the user sends the first message of a direct conversation with a connection (paid to the **sender**) | 5 | conversation | 5 a day | yes |
| `TEAM_APPLICATION_ACCEPTED` | a team application is accepted (paid to the **applicant**, not to whoever accepted it) | 50 | application | 3 a day | no |

Who is **not** paid: the milestone update post that completing a milestone creates is not an
update the user posted, so it pays nothing as one; declined connections and rejected applications
pay nothing; a second message in a conversation is not a first message.

### Rewards other people trigger: the trusted-counterparty gate

Some rewards exist because somebody else acted: an endorsement, an accepted application or invitation, an
accepted connection, a first message, a reply. Those are what two accounts made for the purpose would farm from
each other, so they all go through **one rule** (`src/lib/trust.ts`, applied by the rewards subscriber in
`src/lib/subscribers.ts`). A reward is paid to a person only when the *other* person in the interaction, the
**counterparty**, is trusted:

- their account is **at least 7 days old** (to the millisecond);
- their **email is verified**;
- **neither has blocked the other**, and they are not the same account.

| Event | Paid to (the subject) | Counterparty that must be trusted |
| --- | --- | --- |
| `EVIDENCE_ENDORSED` | the owner of the evidence | the endorser |
| `TEAM_APPLICATION_ACCEPTED` | the applicant, or the invitee who accepted | whoever reviewed the application, or sent the invitation (and the applicant's own account must pass too) |
| `CONNECTION_ACCEPTED` | each of the two people | the other one |
| `MESSAGE_SENT_FIRST_IN_CONNECTION` | the sender | the recipient |
| `MESSAGE_REPLIED` (pays no XP) | the person who replied | the person who was waiting for the reply |
| `MATCH_CREATED` (pays no XP itself) | each of the two people | the other one |
| `MATCH_TEAM_FORMED` (pays no XP itself) | each of the two people | the other one |

When the counterparty is not trusted the subject gets **nothing from the event**: no XP, and nothing counted toward achievements
and quests. The action itself still happens (the connection is made, the person is on the team, the message is sent, the
endorsement shows on the evidence). The achievements and quests that these actions count toward need no gate of their own: a count
is only recorded for an XP award that was paid, and the replies, which pay no XP, are checked directly. In a connection each person is
judged on the other, so a new account connecting with an established one is paid nothing for it while the established one is paid.

**Why the gate judges the counterparty and not the person being paid.** What makes farming work is a cheap payer: an account made in a
minute that "endorses", "accepts" or "replies" to its twin. Making the payer expensive (a week old, a verified email, not blocked) stops
that, because an attacker then needs an aged, verified account for every payment. Judging the *recipient* as well would add nothing
against that and would hurt the people the platform wants most: a real newcomer would earn nothing for the first thing an established
builder does for them. So the default is counterparty-only. There is one deliberate exception, `TEAM_APPLICATION_ACCEPTED`
(`subjectMustBeTrusted`), which also requires the applicant's own account to pass. An accept is a single click by whoever runs the team,
it pays the largest of these rewards, and nothing caps it per recipient, so one aged account could otherwise mint XP for any number of
fresh accounts by accepting their applications. Requiring the applicant to be established too closes that, and costs a real applicant only
the wait for their account to reach a week. The pair is checked in `pairDistrust`, and this is the only event that sets the flag
(a test pins that).

A new person therefore earns nothing from other people for their first week, and earns it all after: the XP for what they do
themselves (projects, milestones, evidence, updates) is unaffected. Endorsements keep two further rules of their own
(`endorsementRewardAllowed`): the endorser has a verified login, and one endorser can trigger at most 10 rewards per rolling day. How
much one owner can earn per day is the rule's own cap (10 payments, so 100 XP), enforced by the engine like every other cap.

## How "the same award" is decided

Every award stores `sourceType` and `sourceId` (what it was for) and a `dedupeKey`
built from them: `project:<projectId>`, `hackathon:<hackathonId>`,
`achievement:<slug>`, `milestone:<id>`, `connection:<id>`, `conversation:<id>`,
`team_application:<id>`, `quest:<userQuestId>`, and `endorsement:<evidenceId>:<endorserId>` (so each endorser pays
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

The size of a level is the XP needed to get from level `n` to level `n + 1`. Level 1 starts at
0 XP. The maximum level is 100, which has no next level.

- **Levels 1 to 35:** `xpForLevel(n) = round(5 × n^1.85)`. Unchanged since the first version: every
  threshold up to the start of level 36 (45,941 XP) is what it always was.
- **Levels 36 to 100:** an eased curve. It starts from the power law's size at level 35 (3,593 XP) and
  grows by the same amount per level the power law did there (about 190), but the growth falls in a
  straight line to nothing over 22 levels (a parabola), so the size levels off at 5,683 XP from
  level 57 on. `xpForLevel` never goes down from one level to the next, anywhere (a unit test checks all
  100 levels), and no level is more than about 190 XP bigger than the one before it.

The early levels are deliberately cheap: level 2 starts at 5 XP and level 4 at 61, so a first
project (50 XP) with its *First Project* achievement (25 XP) takes a new user to **level 4**,
the onboarding moment, and level 5 starts at 126. The power law then steepens, which is what keeps
the Silver, Gold and Platinum tiers on schedule (see the simulation below).

Left alone, the power law makes Mythic (level 80) a nine year goal even for a power user, because
the size of a level keeps growing with the square (8,292 XP at level 55, 16,700 by level 80). From
level 36 the growth is eased off instead, which brings Diamond to about two and a half years and Mythic to
about five for a power user. A fixed plateau is what makes both possible without a step: a curve that
never decreases and still reaches Mythic in five years cannot ask for much more per level at 55 than it
does at 80.

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
| 36 | 3,779 | 45,941 |
| 45 | 5,061 | 85,598 |
| 55 | 5,666 | 139,643 |
| 57 | 5,683 | 150,988 |
| 80 | 5,683 | 281,697 |
| 100 | 5,683 | 395,357 |

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

## Streaks

A **streak** is the number of consecutive days, in the user's own time zone, on which they earned
XP from an action of their own. The rules are pure functions in `src/lib/streaks.ts`; `grant()` applies
them in the same transaction as the award, so a streak moves exactly when the XP does.

- **What counts.** An award counts when its rule says so (the last column of the XP table) and the user was the
  one who acted. Nothing counts that someone else did for you (an endorsement you received, an accepted
  application, a win recorded by an organiser, the other person in a connection), and the XP of an
  achievement or a quest never counts by itself. An action that paid nothing (a repeat, a daily cap) does not count.
- **The day** is the local date from `User.timezone` (UTC when unset). A day counts once, however many actions it holds.
  `User.lastStreakDay` is that date as `YYYY-MM-DD`.
- **Extending.** The day after a counting day extends the streak by one. The first ever counting day makes it 1.
- **Freezes.** One freeze is earned for every completed run of 7 days (day 7, 14, 21...), up to **2 banked**
  (`User.streakFreezes`). Missing exactly **one** day spends a freeze automatically and the streak carries on, and
  the response says so (`freezeUsed`). Missing two or more days ends the streak (the freezes are kept) and the next
  counting day starts a new run at 1.
- **Best and current.** `longestStreak` only goes up. `currentStreak` is only rewritten when the user earns something,
  so it can be stale; the API always reports the *effective* streak, which is 0 once a day was missed with no freeze to
  cover it (`effectiveStreak`). A streak last extended yesterday is still alive: it can be kept going today.
- **Changing time zone** can move "today" by up to a day; a day that goes backwards is simply not counted again.
- **What it unlocks.** The streak achievements (7, 30, 100, 365 days), *No Safety Net* (30 days without a freeze:
  `User.streakFreezeUsed` is whether a freeze was spent in the current run), the *Comeback Kid* (earning again after
  30 or more idle days, measured between counting days) and the four streak frames. They arrive through the
  `STREAK_EXTENDED` and `USER_COMEBACK` events that `grant()` announces.

The envelope reports it as `streak: { current, longest, extended, freezeUsed }` on every response that has one.
`GET /api/users/{id}/heatmap?days=365` returns the XP and number of actions on each local day of the profile owner
(only days that had any, oldest first), cached for 10 minutes and retired by every award; it honours blocks and the
owner's `showActivity` switch.

## Achievements

There are **43**, in a few families. A tiered family is one counter with several targets; the first tier of each keeps the
slug it had before there were tiers.

**How they work.** A domain event is turned into *ticks* (`EVENT_TICKS` in `src/lib/metrics.ts`): "this user shipped
this project". A tick is only produced for an award that really paid XP, so the daily caps, the once-per-source rule
and the gates above limit achievements and quests exactly as they limit XP, and a repeated event (withdrawing an
endorsement and giving it again) counts once. `recordTick()` writes the tick, whose unique key makes it count once, and
raises the user's counter (`UserCounter`). Then `src/lib/achievement-progress.ts` unlocks every achievement of that
counter whose target is reached, through `grantAchievement()` and so through `grant()`: the XP, the notification and the
`achievements` list of the response all follow. `UserAchievement.progress` stores `{ current, target }` as it stood.
Nothing grants an achievement from anywhere else. The counters are backfilled from the XP log by the migration, so
nobody starts at zero; an achievement whose target a counter already meets unlocks on the user's next action of that kind
(several can unlock at once).

| Slug | Name | XP | Unlocked when |
| --- | --- | ---: | --- |
| `first-project` | First Project | 25 | 1 projects created |
| `projects-10` | Idea Machine | 50 | 10 projects created |
| `first-ship` | Shipped It | 100 | 1 projects shipped |
| `ship-5` | Shipping Habit | 100 | 5 projects shipped |
| `ship-25` | Shipping Machine | 250 | 25 projects shipped |
| `ship-100` | Centurion | 800 | 100 projects shipped |
| `first-update` | Building in Public | 25 | 1 project updates posted |
| `updates-25` | Regular Dispatch | 60 | 25 project updates posted |
| `updates-100` | Chronicler | 200 | 100 project updates posted |
| `first-milestone` | Milestone Reached | 50 | 1 milestones completed |
| `milestones-10` | Steady Progress | 60 | 10 milestones completed |
| `milestones-50` | Milestone Master | 200 | 50 milestones completed |
| `first-hackathon` | Hackathon Rookie | 25 | 1 hackathons joined |
| `hackathons-5` | Hackathon Regular | 75 | 5 hackathons joined |
| `hackathon-winner` | Hackathon Winner | 250 | 1 hackathons won |
| `hackathon-champion` | Hackathon Champion | 400 | 3 hackathons won |
| `hackathon-legend` | Hackathon Legend | 1000 | 10 hackathons won |
| `team-builder` | Team Builder | 25 | 1 crews formed |
| `crews-5` | Crew Captain | 75 | 5 crews formed |
| `crews-15` | Crew Architect | 150 | 15 crews formed |
| `team-player` | Team Player | 25 | 1 teams joined |
| `teams-5` | Familiar Face | 75 | 5 teams joined |
| `first-evidence` | Show Your Work | 25 | 1 evidence added |
| `evidence-10` | Portfolio Builder | 75 | 10 evidence added |
| `endorsed` | Vouched For | 50 | 1 endorsements received |
| `endorsed-10` | Well Vouched | 75 | 10 endorsements received |
| `endorsed-50` | Pillar of the Community | 300 | 50 endorsements received |
| `endorser-1` | Vouch | 25 | 1 endorsements given |
| `endorser-10` | Trusted Voice | 60 | 10 endorsements given |
| `endorser-50` | Kingmaker | 250 | 50 endorsements given |
| `streak-7` | Week Warrior | 40 | 7 day streak |
| `streak-30` | Month of Momentum | 120 | 30 day streak |
| `streak-100` | Hundred Days | 400 | 100 day streak |
| `streak-365` | Year of Building | 1500 | 365 day streak |
| `first-match` | First Match | 25 | 1 match |
| `matches-10` | Well Matched | 50 | 10 matches |
| `match-teamed` | Better Together | 100 | formed a team with someone you matched with (once per match) |

**Sparks and matches pay no XP; the three match achievements pay a one-off amount** (25, 50 and 100). An achievement can be earned once per
person, so the XP cannot be farmed the way a per-match payment could be: the tenth match pays nothing new, and the hundredth pays nothing.
A match counts for a person only when the other person is a trusted account (the counterparty gate above), so two throwaway accounts that
match each other earn nothing from it. A match counts when it is made (`MATCH_CREATED`, the metric `matches`); *Better Together* counts when
somebody joins a team that has a member they have an open match with (`MATCH_TEAM_FORMED`, the metric `match_teams`, detected on
`TEAM_APPLICATION_ACCEPTED` in `src/lib/matching/team-match.ts`), so the match must be older than the team and not ended. **A romance match
counts for none of these** (docs/ROMANCE.md): achievements are public, and nothing about the romance mode is.

### Secret achievements

Six are unlocked by a rule on one event and are **hidden until earned**: `GET /api/achievements` lists them with a
placeholder slug (`secret-<order>`), no name, no text, no icon, no reward, no progress and no rarity, so nothing gives the rule
away. (They are written out here because this is a developer document.)

| Slug | Name | XP | Unlocked when |
| --- | --- | ---: | --- |
| `night-owl` | Night Owl | 75 | Shipped a project between 2 and 5 in the morning, your time. |
| `hat-trick` | Hat Trick | 100 | Shipped 3 projects in one week. |
| `no-safety-net` | No Safety Net | 200 | Reached a 30 day streak without spending a freeze. |
| `golden-vouch` | Golden Vouch | 75 | Received an endorsement from a Gold builder or higher. |
| `weekend-warrior` | Weekend Warrior | 75 | Shipped on the weekend after shipping during the week. |
| `comeback-kid` | Comeback Kid | 50 | Came back and earned XP after more than 30 days away. |

*Night Owl* looks at the user's local hour when the project shipped (02:00 up to but not including 05:00), *Hat Trick*
counts the ship ticks since local Monday 00:00, and *Weekend Warrior* wants a weekend ship (local Saturday or Sunday)
after a ship earlier in the same local Monday to Sunday week that was not on a weekend. *Golden Vouch* is the first
endorsement the owner receives from somebody at level 20 or above.

### Rarity

`Achievement.rarity` is the share of users active in the last 30 days (`User.lastActiveAt`) who have the achievement,
0 to 1 (smaller is rarer). Only active people count on both sides, so it cannot pass 1 and does not shrink because of
people who left. The job `achievements/rarity` recomputes all of them in one statement every night at 03:30 UTC (and creates
the rows of achievements nobody has earned, at 0). It is `null` until the job has run once.

`GET /api/achievements` (yours) and `GET /api/users/{id}/achievements` (anyone's) list all 43 in order with `earned`,
`earnedAt`, `progress: { current, target }`, `rarity` and the masking above.

## Quests

Every person has **three daily and three weekly quests** at a time. Each is a genuinely useful action (post an update,
complete a milestone, add evidence, endorse a teammate, accept a connection, ship a project, reply to a conversation that is
waiting on you...) and **none rewards an engagement action**: a quest asks for a number of one *counted* action, and an action
is only counted when it paid XP, so "open the app" and "visit a page" cannot be written. `src/lib/quest-definitions.test.ts`
checks that, and that no quest depends on somebody else's decision (an accepted application) or on luck (a win).

**Rotation.** Which quests a person has is a pure function of `(user, period)`: a shuffle of the pool seeded by a hash of the
user id and the period key (`2026-10-16` for a day, `2026-W42` for a week), then the first three that ask for *different* actions.
Nothing is stored for it and no job runs at midnight: any server computes the same quests, a quest cannot be re-rolled by
reloading, and they reset at the user's own local midnight and local Monday (`resetsAt`). A test pins the picks for a fixed user
and period, so changing the pool or the shuffle is a decision and not an accident.

**Progress.** The same ticks that move achievements move quests: when a tick is counted, `advanceQuests()` raises the matching
quest of the user's current day and week. The `UserQuest` row is created by the first thing that counts, with the period
(`periodKey`, `periodStart`, `periodEnd`) and `progress: { current, target, completed }`. Reaching the target completes it: the
quest's XP is paid as `QUEST_COMPLETED` through `grant()`, with the `UserQuest` as the source, so it pays once, and the
response's `rewards.questsCompleted` lists it. `GET /api/quests` returns the current six with their progress and when they reset;
it writes nothing, and looking at quests earns nothing.

Replies (`MESSAGE_REPLIED`: answering a direct message that was waiting on you) are the one counted action that pays no XP of its own,
so nothing caps them but the quests: two accounts answering each other can complete the reply quests, which is worth a few XP once per
period (at most three daily and three weekly quests are open at a time), and nothing more.

Quest XP is small next to the action behind it (an update that completes a daily quest already paid 15), because the point is to
point people at useful work and not to be the reason to do it. The `quests` **feature flag** is a kill switch: while it is off for
a user nothing counts toward their quests and `GET /api/quests` says `enabled: false` with empty lists. It starts on for everybody.

### Daily pool (20)

| Quest | Do this | XP |
| --- | --- | ---: |
| Share your progress | Post a project update. | 2 |
| Keep them posted | Post two project updates. | 4 |
| Narrate the build | Post three project updates. | 6 |
| Hit a milestone | Complete a project milestone. | 3 |
| Two steps forward | Complete two project milestones. | 4 |
| On a roll | Complete three project milestones. | 6 |
| Show your work | Add evidence to a skill. | 3 |
| Back it up | Add evidence to two of your skills. | 4 |
| Vouch for a teammate | Endorse another builder's work. | 2 |
| Spread the credit | Endorse three builders' work. | 6 |
| Welcome someone in | Accept a connection request. | 2 |
| Grow your circle | Accept two connection requests. | 4 |
| Break the ice | Start a conversation with a new connection. | 2 |
| Say hello twice | Start conversations with two new connections. | 4 |
| Answer the waiting message | Reply in a conversation that is waiting on you. | 2 |
| Clear the backlog | Reply in two conversations that are waiting on you. | 4 |
| Inbox hero | Reply in three conversations that are waiting on you. | 6 |
| Ship it | Ship a project. | 9 |
| Start something | Create a new project. | 3 |
| Two ideas in motion | Create two new projects. | 4 |

### Weekly pool (12)

| Quest | Do this | XP |
| --- | --- | ---: |
| Ship something this week | Ship a project. | 16 |
| Double ship | Ship two projects. | 29 |
| Build in public | Post five project updates. | 11 |
| Make real progress | Complete five project milestones. | 14 |
| Milestone sprint | Complete ten project milestones. | 26 |
| Build your proof | Add evidence to three skills. | 11 |
| Vouch for five | Endorse five builders' work. | 11 |
| Meet five builders | Accept five connection requests. | 11 |
| Start three conversations | Start conversations with three new connections. | 8 |
| Always answer | Reply in five conversations that were waiting on you. | 10 |
| Enter a hackathon | Register for a hackathon. | 16 |
| Two new projects | Create two new projects. | 11 |

## Leaderboards

`GET /api/leaderboard?period=&scope=&scopeId=&cursor=&limit=` ranks people by the XP they earned in a **period**, on a **scope**.

| Periods | |
| --- | --- |
| `weekly` | the ISO week, Monday to Sunday, **in UTC** (everybody's week ends at the same instant) |
| `monthly` | the calendar month, in UTC |
| `season` | the XP stamped with the active season (`XPEvent.seasonId`), see Seasons |
| `all-time` | everything (the default) |

| Scopes | `scopeId` |
| --- | --- |
| `global` (the default) | none |
| `country` | an ISO 3166-1 alpha-2 code, `IN` (default: the user's own `Profile.countryCode`) |
| `city` | `IN:bengaluru`: country and city key (default: the user's own). A city needs a country, since names repeat |
| `campus` | the campus key, `iisc-bangalore` (default: the user's own) |
| `crew` | a team id (required). A crew is a handful of people, so its board is summed from the XP log when asked for |

`Profile.countryCode`, `city` and `campus` are set with `PATCH /api/users/me/profile`. Text is tidied when stored (Unicode
normalised, control characters removed, whitespace collapsed, 80 characters) and compared by a key (accents and case removed:
"São Paulo", "sao  paulo" and "SAO-PAULO" are one place). The response's `myScopes` has the ids of the user's own boards for a picker.

**Where the ranks come from.** Each board is a Redis sorted set (user id and period XP) behind the Cache adapter, named
`lb:<period>:<scope>`. Three things keep them right, each covering what the one before can miss:

1. every award is added to the user's boards right after its transaction commits, in one pipelined call (`recordBoardXp`);
2. a change of place or of the privacy switch queues the job `leaderboards/refresh-user`, which removes the person from the boards
   they left and sets their score on the ones they are on;
3. **every night at 04:00 UTC the job `leaderboards/reconcile` rebuilds every board of the current periods from the `XPEvent` log**
   (the source of truth) and swaps each in whole with one rename. Weekly and monthly boards expire a few weeks after they end.

   The rebuild takes its time and awards keep arriving, so it works period by period in five steps (`src/lib/leaderboard-rebuild.ts`):
   (1) take a **cutoff T** one minute in the past (room for awards still being committed); (2) **aggregate the log up to T in SQL**, a batch of
   5,000 people at a time, into *staged* copies of the boards (the live boards are not touched, and no more than a batch is in memory);
   (3) **replay what came after T**: everybody with an event after T has their whole score for the period re-read from the log and *set*
   (never added) on the staged boards, repeating until a pass finds nothing new; (4) swap each staged board in for the live one with one
   rename; (5) **settle**: everybody with an event stamped since the last replay pass began has their whole score re-read and *set* on the
   live boards, so an award that committed between the last pass and the rename (and landed on the board the rename replaced) is put
   back, and is just as right if it landed on the new board. Setting an absolute score is what makes an award that lands mid-rebuild count
   exactly once: it cannot be counted by the aggregate and again by the replay or the settle. What is not covered: an award that commits
   after the settle pass has read the log (milliseconds wide; the next run repairs it), and a move to another country or an opt-out
   in that same window is applied on the next run. The scratch boards of a rebuild that died expire by themselves after six hours.

Boards that were never built (a restart of the in-process cache, a new Redis) are built on the first read with the in-process cache,
and by queueing `leaderboards/reconcile` with Redis. `npm run postdeploy` runs it after every deploy (see [DEPLOY.md](DEPLOY.md)).

**What the viewer sees.** A rank belongs to the board alone: it is the same for every viewer and the same as the rank on the player card. People the viewer has blocked
(or who blocked them) are left out of their list and nobody is renumbered, so a viewer's page can skip ranks and hold fewer than `limit`
people. People who switched leaderboards off
(`Profile.hideFromLeaderboards`) are on no board and in no rank; so are deleted accounts (a board is cleaned of any it still holds
as it is read). Ties are broken by user id, descending, the order Redis keeps. `me` is the viewer's `{ rank, score, hidden }`
(`rank` is `null` with no XP in the period, or when hidden), and `around` is the viewer and the two above and two below.

**Cursors** are rank cursors: they remember the rank of the last row and who held it, so if scores move between pages the next page
starts right after that person *wherever they are now*, and nobody is shown twice. `page` still works, with `pagination`; a cursor
request runs no count.

## Player card

`GET /api/users/{id}/stats` returns everything a profile header shows in one call: `xp`, `level`, `tier`, `progress`, `ranks`
(absolute places on the all-time global, country and city boards; `null` where the person is not on one), `streak`, the three
rarest `topAchievements` earned, `equipped` cosmetics and `counts` (`shipped`, `hackathons`, `wins`, `endorsementsReceived`, `crews`
= teams the person is in now, `milestones`). It is cached for 60 seconds and **retired by every award**. A person who keeps their
activity private (`showActivity: false`) shows no streak to others.

## Cosmetics

Titles, frames and banners for a profile, **earned only**: the catalog is below (plus a set for every finished [season](#seasons)), each has an unlock rule, and `src/lib/cosmetics.ts` is the
only code that gives anyone one. A tier reached (`TIER_REACHED`, which also fires for Bronze with a person's first XP), an achievement
unlocked (`ACHIEVEMENT_UNLOCKED`) or a streak extended (`STREAK_EXTENDED`) are announced by the rewards engine and the cosmetics subscriber
grants what matches. A tier or a streak also grants every lower one, so nobody misses a title by skipping a tier. There is no price, no
purchase and no route that grants one; `src/lib/cosmetics.test.ts` scans the code base for any write to the inventory outside the module,
any route that calls the unlock or season-reward functions, any shop-like route, and any price column, and checks that the only things a client can do are
`GET /api/users/me/cosmetics` and `PATCH /api/users/me/equipped`.

`PATCH /api/users/me/equipped` body `{ title?, frame?, banner?, badges? }` chooses what to wear. `title`, `frame` and `banner` are a slug or `null`;
`badges` is a list of up to three badge slugs, shown in that order (the list replaces the previous one; `[]` takes them all off). The season
participation badge is a `BADGE` and goes in the badges slot. Each slug must be one the user
**owns** and that goes in that slot, else `403 COSMETIC_NOT_OWNED` (also for an unknown slug) or `400 COSMETIC_WRONG_SLOT`. Cosmetics earned by a secret
achievement are masked in the catalog until owned. People who earned things before cosmetics existed are caught up by the job
`cosmetics/backfill` (quietly, safe to repeat).

| Slug | Type | Name | Rarity | Earned by |
| --- | --- | --- | --- | --- |
| `title-bronze` | title | Bronze Builder | common | Reach the Bronze tier |
| `title-silver` | title | Silver Shipper | common | Reach the Silver tier |
| `title-gold` | title | Gold Maker | uncommon | Reach the Gold tier |
| `title-platinum` | title | Platinum Architect | rare | Reach the Platinum tier |
| `title-diamond` | title | Diamond Founder | epic | Reach the Diamond tier |
| `title-mythic` | title | Mythic Visionary | legendary | Reach the Mythic tier |
| `title-centurion` | title | Centurion | epic | Unlock the achievement "Centurion" |
| `title-kingmaker` | title | Kingmaker | rare | Unlock the achievement "Kingmaker" |
| `title-champion` | title | Champion | epic | Unlock the achievement "Hackathon Champion" |
| `title-night-owl` | title | Night Owl | rare | Unlock the achievement "Night Owl" |
| `title-comeback` | title | Comeback Kid | uncommon | Unlock the achievement "Comeback Kid" |
| `frame-streak-7` | frame | Ember | common | Keep a 7 day streak |
| `frame-streak-30` | frame | Blaze | uncommon | Keep a 30 day streak |
| `frame-streak-100` | frame | Inferno | epic | Keep a 100 day streak |
| `frame-streak-365` | frame | Sun | legendary | Keep a 365 day streak |
| `frame-golden-vouch` | frame | Gilded | rare | Unlock the achievement "Golden Vouch" |
| `banner-first-win` | banner | First Place | uncommon | Unlock the achievement "Hackathon Winner" |
| `banner-champion` | banner | Podium | epic | Unlock the achievement "Hackathon Champion" |
| `banner-legend` | banner | Hall of Fame | legendary | Unlock the achievement "Hackathon Legend" |
| `banner-shipper` | banner | Production Line | rare | Unlock the achievement "Shipping Machine" |

## Seasons

A **season** is a fixed stretch of eight weeks with its own leaderboard. `Season 1` starts when the migration is deployed
(`20261016000200_seasons`). `grant()` stamps every `XPEvent.seasonId` with the active season, so a season's standings are always a sum over
the log (and the season board reads it). The job `seasons/rollover` runs hourly: when the active season's time is up it writes the **final
standings** once into `SeasonStanding` (rank, score; the same order as the live board, leaving out people who opted out of leaderboards and
deleted accounts), deactivates it, and opens the next season (starting where the last one ended, or now if the job was down for longer than
a season) in the same transaction under a lock, so running it twice, or at once, closes a season once. A season runs over its end by at most
the hour between runs.

### Season rewards: cosmetics only, never XP

A season pays **cosmetics and nothing else**: no XP, no level, no progress, no achievement. A placing is not something a person *did*, so it
does not go through the rewards engine at all (`grant()` is not called, and nothing is written to `XPEvent`). After closing a season the same job grants
(`grantSeasonRewards` in `src/lib/seasons.ts`, which calls `grantSeasonCosmetics` in `src/lib/cosmetics.ts`, the only code that writes the inventory), from the
final standings:

| Cosmetic | Type | Who gets it | Rarity |
| --- | --- | --- | --- |
| `Season N Top 100` | title | ranks 1 to 100 (everyone, in a season with fewer than 100 ranked) | epic |
| `Season N Top 1%` | frame | ranks 1 to ⌈1% of the people ranked⌉ | legendary |
| `Season N Top 10%` | frame | ranks 1 to ⌈10% of the people ranked⌉ | rare |
| `Season N Participant` | badge (an avatar part: it has no slot to wear, it is just shown as owned) | **everyone who earned XP in the season**, ranked or not | common |

Every season has its own set (slugs `season-N-top-100`, `season-N-top-1-percent`, `season-N-top-10-percent`, `season-N-participant`), created the first time the
season's rewards are granted, so a person who places in several seasons collects a title and frames for each. Percentages round up, so the
winner of even a tiny season is in the top 1%; and because the ranks come from the standings, a person who switched leaderboards off has no placing
(they still get the badge, since they played), and deleted accounts get nothing. The people who get a cosmetic are notified (`COSMETIC_UNLOCKED`), once.

It is **idempotent three ways**: the season is marked done (`Season.rewardsGrantedAt`) and skipped from then on; a lock stops two runs doing
it at once; and a cosmetic somebody already has is never granted again (nor announced again), so even losing the marker changes nothing. A season that
closed but could not be granted (the database went away) keeps a null marker, and the next hourly run, or `npm run postdeploy`, grants it.

## How long it takes: the progression simulation

`npm run sim:progression` (`scripts/simulate-progression.ts`) plays five kinds of user, day by day
for ten years, against the real rules: the XP table, daily caps, once-per-source rule, the counters and achievements, the streak rules and the
real quest rotation are imported from the files above, not copied, so the numbers follow any change to
them. Nothing is random and nothing touches the database. Quests depend on who you are, so each result is the **median of nine simulated
users**. After changing a rule, run it and paste the output below; a unit test (`src/lib/progression-sim.test.ts`) keeps the script honest about
caps and levels, and fails when a target below is missed (by more than a week: the windows are "about 9 months", and the simulation has a day for resolution).

- **Casual**: 3 actions a week: a project every two weeks, shipped, with a milestone and an update along the way. Earns about 26 XP a day over its first year.
- **Active**: Something every day, about 3 a day: a project every 10 days, milestones, updates, and the social side. Earns about 76 XP a day over its first year.
- **Power**: About 6 a day, ships a project every week, joins a hackathon every month. Earns about 159 XP a day over its first year.
- **Power + wins**: The Power user, with about four hackathon wins a year instead of one. Earns about 165 XP a day over its first year.
- **Ceiling**: Hits every daily cap every day. The fastest the rules allow, not a person. Earns about 1209 XP a day over its first year.

Not simulated: the secret achievements (they depend on the clock), and any change in what people do because of quests (the simulated users do
what they would have done anyway). A user who is endorsed is assumed to endorse about as often.

Days until the user first reaches each level (a tier starts at levels 10, 20, 35, 55 and 80):

| User | Level 2 | Level 5 | Level 10 | Level 20 | Level 35 | Level 55 | Level 80 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Casual | 10 d | 14 d (2.0 wk) | 42 d (6.0 wk) | 327 d (10.8 mo) | 1671 d (4.6 yr) | never (10 yr+) | never (10 yr+) |
| Active | 2 d | 3 d | 14 d (2.0 wk) | 105 d (3.5 mo) | 572 d (1.6 yr) | 1950 d (5.3 yr) | never (10 yr+) |
| Power | 1 d | 1 d | 7 d | 50 d (7.1 wk) | 273 d (9.0 mo) | 915 d (2.5 yr) | 1876 d (5.1 yr) |
| Power + wins | 1 d | 1 d | 7 d | 50 d (7.1 wk) | 266 d (8.8 mo) | 889 d (2.4 yr) | 1820 d (5.0 yr) |
| Ceiling | 1 d | 1 d | 1 d | 6 d | 34 d (4.9 wk) | 115 d (3.8 mo) | 233 d (7.7 mo) |

What the curve is tuned against:

| Target | Wanted | Simulated | XP a day: needed / earned | |
| --- | --- | --- | --- | --- |
| First project and its achievement | level 4 | level 4 | | met |
| Casual: Silver in 6-8 weeks | 42-56 d | 42 d (6.0 wk) | 22 / 26 | met |
| Active: Gold in 3-4 months | 91-122 d | 105 d (3.5 mo) | 78 / 76 | met |
| Power: Platinum in 9-12 months | 274-365 d | 273 d (9.0 mo) | 133 / 159 | met |
| Power: Diamond in 2.5-3 years | 913-1095 d | 915 d (2.5 yr) | 139 / 159 | met |
| Power: Mythic in about 5 years | 1734-1916 d | 1876 d (5.1 yr) | 154 / 159 | met |
| Power + wins: Mythic in about 5 years, a little sooner than Power | 1095-1825 d | 1820 d (5.0 yr) | 193 / 165 | met |
| Mythic is top-0.1% territory | not within 3 years of steady play | Power: 1876 d (5.1 yr) | | met |

Notes on the targets:

- **The first project lands on level 4**, on purpose. A curve that also met the speed targets
  below and kept the first project on level 2 does not exist among `round(a × n^p)` curves; the
  closest, `round(24 × n^1.2)`, puts power at about 6 months to Platinum instead of 9 to 12. Cheap early levels and a steep later
  curve were chosen over that.
- **Mythic is a multi-year goal.** The power user reaches Diamond (level 55) in about 2.5 years and
  Mythic (level 80) in about 5. The power user who also wins about four hackathons a year gets there a few
  weeks sooner, not years: a win is 500 XP in a year of about 58,000, so wins alone do not move anyone
  a year closer. The *Ceiling* is not a person: it hits every daily cap every day, and reaches Mythic in
  about 8 months.
  Diamond and Mythic pull against each other, because the curve cannot get smaller as levels go up: Diamond
  any sooner than 2.5 years would push Mythic past five.
- **The new rewards were sized to keep the early tiers on schedule.** Achievements, streaks and quests add about 12% to what a
  power user earns (159 XP a day against 142 before), and their amounts were trimmed until Silver, Gold and Platinum stayed inside the
  windows the curve was tuned for. Quest XP is the smallest slice. Because the curve up to level 35 is not touched, any
  further XP source brings the early tiers in: re-run the script after touching `REWARD_RULES`, the achievements or the quests.
- Casual and active sit at the early edge of their windows (42 days of 42 to 56, 105 days of 91 to 122), so a
  cut to an XP amount slows them past the target.

## What the interface receives: `RewardsEnvelope`

Every mutation that can award anything returns a `rewards` object next to its normal
body, **also when nothing was earned** (then `xpGained` is 0), so the interface can
always read it. The type is `RewardsEnvelope` in `src/types/api.ts`.

```ts
interface RewardsEnvelope {
  xpGained: number          // XP added by this request: achievement and quest XP included
  totalXp: number           // the user's XP after this request
  oldLevel: number
  newLevel: number
  leveledUp: boolean
  oldTier: 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' | 'DIAMOND' | 'MYTHIC'
  newTier: Tier
  tierChanged: boolean
  achievements: { slug: string; name: string }[]      // unlocked by this request
  questsCompleted: { slug: string; name: string }[]   // completed by this request
  streak: { current: number; longest: number; extended: boolean; freezeUsed: boolean }
}
```

`streak` is always present. `extended` is true on the first counting action of the local day (the streak grew or started), `freezeUsed`
when a banked freeze covered a missed day to keep it alive, and `current` is 0 for a lapsed streak.

Routes that return it: `POST /api/projects`, `PATCH /api/projects/{id}`,
`POST /api/projects/{id}/updates`, `PATCH /api/projects/{id}/milestones/{milestoneId}`,
`POST /api/hackathons/{id}` (register), `POST /api/hackathons/{id}/teams`,
`PATCH /api/hackathons/{id}/results`, `POST /api/evidence`,
`PATCH /api/teams/{id}/applications/{applicationId}`, `PATCH /api/connections/{id}` (accepting; 10 XP) and
`POST /api/conversations/{id}` (the first message of a direct conversation; 5 XP). The envelope always describes
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
    "oldLevel": 1, "newLevel": 4, "leveledUp": true,
    "oldTier": "BRONZE", "newTier": "BRONZE", "tierChanged": false,
    "achievements": [{ "slug": "first-project", "name": "First Project" }],
    "questsCompleted": [],
    "streak": { "current": 1, "longest": 1, "extended": true, "freezeUsed": false }
  }
}
```

Shipping that project (200 XP, plus 100 for *Shipped It*) takes the user from 75 to
375 XP, from level 4 to level 7 (which starts at 362); it is the second action of the day, so the streak does not grow again:

```json
{
  "rewards": {
    "xpGained": 300, "totalXp": 375,
    "oldLevel": 4, "newLevel": 7, "leveledUp": true,
    "oldTier": "BRONZE", "newTier": "BRONZE", "tierChanged": false,
    "achievements": [{ "slug": "first-ship", "name": "Shipped It" }],
    "questsCompleted": [],
    "streak": { "current": 1, "longest": 1, "extended": false, "freezeUsed": false }
  }
}
```

The seventh day in a row, which unlocks *Week Warrior* and completes a quest:

```json
{
  "rewards": {
    "xpGained": 57, "totalXp": 4310,
    "oldLevel": 15, "newLevel": 15, "leveledUp": false,
    "oldTier": "SILVER", "newTier": "SILVER", "tierChanged": false,
    "achievements": [{ "slug": "streak-7", "name": "Week Warrior" }],
    "questsCompleted": [{ "slug": "daily-update-1", "name": "Share your progress" }],
    "streak": { "current": 7, "longest": 7, "extended": true, "freezeUsed": false }
  }
}
```

A fourth project in a day, or a repeated action that already paid:

```json
{ "rewards": { "xpGained": 0, "totalXp": 175, "oldLevel": 5, "newLevel": 5, "leveledUp": false,
               "oldTier": "BRONZE", "newTier": "BRONZE", "tierChanged": false,
               "achievements": [], "questsCompleted": [],
               "streak": { "current": 3, "longest": 3, "extended": false, "freezeUsed": false } } }
```

## Notifications and analytics

Inside the same transaction, the engine creates a `Notification` (type `ACHIEVEMENT`, with
`metadata.kind` of `LEVEL_UP`, `TIER_UP`, `ACHIEVEMENT_UNLOCKED`, `QUEST_COMPLETED` or `COSMETIC_UNLOCKED`) for a level-up, a
tier change, an unlocked achievement, a completed quest and an unlocked cosmetic. After the transaction commits it records the
product events `level_up`, `tier_up`, `achievement_earned`, `quest_completed` and `streak_extended` (no personal data in
their properties; see [ARCHITECTURE.md](ARCHITECTURE.md#analytics)).

## Reading XP

`User.xp` is a denormalised cache of the sum of the user's `XPEvent` rows, changed only
by `grant()`. The `/api/users/{id}` rank, and the leaderboards' source of truth, are the log; the boards in Redis are a copy of it.

## Operations

| Job | Runs | What it does |
| --- | --- | --- |
| `seasons/rollover` | hourly | closes the active season when its time is up (standings, next season) and grants the cosmetics of every closed season that is owed them |
| `achievements/rarity` | nightly, 03:30 UTC | recomputes every achievement's rarity |
| `leaderboards/reconcile` | nightly, 04:00 UTC | rebuilds all current boards from the XP log |
| `leaderboards/refresh-user` | on demand | moves one person's entries after a place or privacy change |
| `cosmetics/backfill` | once, on demand | gives people who earned things before cosmetics existed their cosmetics |

Schedules are cron triggers in Inngest. Any job can be run right now with `POST /api/admin/jobs/{name}` (admin only; this is also how a
deployment without Inngest runs them). **After every deploy** run `npm run postdeploy` ([DEPLOY.md](DEPLOY.md)): it makes sure a season is running, runs `leaderboards/reconcile` and
`cosmetics/backfill`, and fails if production has no Upstash Redis (the in-process stand-in cannot hold leaderboards across several instances).

## Changing the rules

- A new amount or cap: edit `REWARD_RULES` in `src/lib/rewards-config.ts`. Existing awards
  are not recalculated. Re-run `npm run sim:progression`.
- A new rewarded action: add the action to `REWARD_RULES`, add the domain event
  to `src/lib/events.ts` and to `EVENT_REWARDS`, and emit the event from the route inside
  its transaction. Nothing else pays XP.
- A new counted thing: add the metric to `METRICS` and to `EVENT_TICKS` in `src/lib/metrics.ts`.
- A new achievement: add it to `ACHIEVEMENT_DEFINITIONS` (a metric and a target, or a secret rule written in
  `src/lib/achievement-progress.ts`). It is not granted retroactively; a counter that already meets it unlocks it on the next action.
- A new quest: add it to `DAILY_QUESTS` or `WEEKLY_QUESTS` for a metric in `QUEST_METRICS`. This changes who is given what in the periods
  that have not started, and the pinned test in `src/lib/quests.test.ts` will tell you so.
- A new cosmetic: add it to `COSMETIC_DEFINITIONS` with a rule. It is granted to people the next time the rule is met; run `cosmetics/backfill` for people who already meet it.
