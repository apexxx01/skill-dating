# The seed: a world to demo and to measure

`npm run seed` builds a believable, internally consistent world of builders in twelve cities. `npm run seed:demo -- --username <name>` adds one polished account on top of it. Both are for
development, previews and benchmarks. **Both refuse to run in production** (`NODE_ENV` or `VERCEL_ENV` says production) and against a database that is not on this machine (unless
`ALLOW_SEED_ON_REMOTE=1` names a disposable preview database; never in production). The code is `prisma/seed/` (one module per phase); the entry points are `prisma/seed.ts` and
`prisma/seed-demo.ts`.

```
npm run seed                                  # 400 builders, 75 days of history, about 4 to 5 minutes
npm run seed -- --scale 10000                 # the same 400, plus 9,600 background people written in bulk (docs/PERFORMANCE.md)
npm run seed -- --reset                       # delete the seeded world and build it again
npm run seed -- --with-romance                # also the 40 synthetic people of the romance mode (below)
npm run seed -- --seed another-world --days 120
npm run seed:demo -- --username aanya --name "Aanya Kapoor" --city blr --streak 45
```

## Deterministic and idempotent

- **Deterministic.** A seeded random generator (`prisma/seed/rng.ts`, mulberry32) draws every name, skill, day and choice; each part of the world has its own forked generator, so adding a feature to
  one part does not shift another. The same `--seed` and `--scale` give the same people, usernames, hackathons and decisions every time. (The *moments* are relative to when you run it: "today" is
  today, so the history always ends yesterday and the streaks are alive.) The first 400 people are the same at any scale.
- **Idempotent.** Everything it makes has an id that starts `sd_`, an address at `seed.skilldating.test`, or a hackathon slug that starts `seed-`. A marker (the flag `seed.world`, which holds the seed,
  scale and days it was built with) makes a second run print "already built" and change nothing; other settings are refused until `--reset`, which deletes exactly those rows (cascades remove what
  hangs off them) and builds again. A run that was cut short leaves no marker, so the next run cleans up and starts over.

## How the history is made: the real code, on a simulated clock

The first 400 people (`CORE_PEOPLE`) are played through **the domain functions**, day by day for the last 75 days (`prisma/seed/history.ts`). `prisma/seed/clock.ts` sets the process clock to the
person's afternoon of that day (`atMoment`): `Date.now()` and `new Date()` answer the simulated moment, so streaks, daily caps, quest periods, Ship Day tags, season stamps and levels are what a real
run writes. Columns the *database* stamps with its own clock are moved back to the same moment afterwards. Nothing in the seed writes XP: it is all `grant()`, reached through `emit` and the event
subscribers, so `User.xp` is exactly the sum of the XP log (a test checks it for everybody), achievements unlock from their counters, and quests, notifications and product events appear as they would.

| What | How it is made |
|---|---|
| XP, levels, tiers, streaks, achievements, quests, cosmetics, notifications of those | `grant()` and the event subscribers (`emit` inside `transactWithEvents`) |
| Ship Feed posts (SHIP, UPDATE, DEVLOG, DEMO), Props, comments | `createPost`, `giveProps`, `createComment` |
| Endorsements | `endorseEvidence` |
| Drops, sparks, matches, their conversations and notifications | `generateDropsForUser` (the scoring engine), `loadTodayDrops`, `passDrop`, `sendSpark` |
| Squads: team, slots, joining, registration, submission, results, peer reviews, reliability | `createSquadTeam`, `createSlots`, `checkJoin`/`addMember`, `writePeerReview`, the submit and results events |
| The looking-for-group board, the solo pool's rounds and the answers to its proposals | `createLfgPost`, `runRound`, `respondToProposal` |
| Invites and the reward for them | `ensurePersonalCode`, `redeemInvite`, `qualifyInvites` (which emits `INVITE_QUALIFIED`) |
| Reports in the moderation queue | `fileReport`, `fileAutomatedReport` |
| Reminders, Ship Day recaps, the rarity of achievements, the metrics of the last month | `sendSquadReminders`, `writeShipDayRecap`, `recomputeRarity`, `runSnapshot` |

**Written directly** (as the routes write them; there is no domain function to call, or it needs a request): the people, profiles, matching profiles, skills and the terms they accepted; verified
campus memberships (the hash only, never an address); the hackathon rows and their conversations; a squad's project, pledges, ideas, votes and checklist; the ranks of the results; projects, their
milestones and coordination channels (the same transaction `POST /api/projects` runs); skill evidence rows; follows, connections and the messages of the matches that went somewhere (no event, no XP);
the 19-odd crews and their applications; the "what I am building" cards; and the projects that went quiet (archived). The few places where an action is replayed from a route are marked in the code.

Everything is written for an idle database: do not run it against one that a server is using.

## Who is in it

- **People.** About 400 builders over Bangalore, Delhi, Mumbai, Hyderabad, Pune, San Francisco, New York, London, Berlin, Lagos, Singapore and São Paulo (weights in `catalog.ts`), with the right time
  zone, names from the region, one of 14 trades (skills, headline, what they look for), verified e-mail, a GitHub for most and a phone for some; accounts from 12 to 195 days old; about 3% are 16 or 17
  (no city, no cards); 14% keep a streak; some drifted away. About 38% have verified a college address at one of the 19 seeded campuses.
- **Work.** Projects in every status (idea, planning, building, testing, shipped, archived) with milestones and updates; posts of every kind with Props and comments; evidence, mostly verified, that
  peers endorsed; crews with applications; a Ship Day recap for the last weeks.
- **Hackathons.** Sixteen: native and external (Devfolio, MLH, Devpost, Unstop, Luma), past, live, upcoming and one cancelled; one closes registration in twenty hours. Squads in every state: forming
  (open slots), full, pledged, submitted, ranked and won, auto-formed from the solo pool, a proposal that fell through and one still waiting, the looking-for-group board, peer reviews and the
  reliability they produce.
- **Matching.** A week of drops for everyone with a matching profile, about a third sparked, a third passed, hundreds of matches with conversations and some replies.
- **Also.** A season, invites (personal and three campaign codes) with the reward paid, a handful of reports in the moderation queue (one automated), notification history, and metrics for the
  last 31 days so the admin pages are not empty.
- **Email and push** go to the in-memory twins only. The seed runs as a test process does (`NODE_ENV=test`), so the job queue runs nothing, and every notification it writes is marked already swept:
  nothing is mailed or pushed.

## `--scale`: background people

`--scale 10000` keeps the first 400 as above and adds 9,600 **background people**, written in bulk straight into the tables (`prisma/seed/background.ts`) because ten thousand people through the domain
functions would take hours. They exist to give the busiest queries realistic volumes (docs/PERFORMANCE.md): per person an XP log whose sum is `User.xp` (distinct dedupe keys), projects and project
updates, posts with Props and comments, follows (a fifth go to a popular few), evidence, a week of drops, sparks, notifications and hackathon registrations. They follow the same shapes and constraints as
the real ones but do not run the daily caps, pay achievements or hold meaningful streaks, and their drops are drawn, not scored. At 10,000 people (about six minutes on a laptop) the seed makes roughly 200,000 XP events, 22,000 posts,
280,000 Props, 50,000 comments, 150,000 follows, 170,000 drops and 135,000 notifications, on top of the 400 people's history.

## `--with-romance`

The romance mode ships closed, so the world has **no romance people unless this flag asks**. With it: forty people (`sd_r0`… `sd_r39`), plainly synthetic (named "Synthetic …", a bio that says so,
addresses at `seed.skilldating.test`), adults aged 25 to 38, each with a profile, the consent and this week's drop from the real weekly-drop function; no photos. The launch flag `romance.enabled`
stays **off**; the forty are put on its **allowlist**, which opens the mode for them and for nobody else, in this database only. `--reset` takes them off it again.

## `seed:demo`: the polished account

`npm run seed:demo -- --username aanya` makes one account worth showing, through the same functions (`prisma/seed/demo.ts`). If there is no world it builds a small one (150 people, 45 days) first. Running it
again deletes the account and rebuilds it, so the streak is alive today.

- **A passport with proof:** a verified GitHub and phone, a verified campus, eight skills, evidence that peers endorsed, three shipped projects and one in progress (the current build), a Ship Feed
  whose posts people gave Props and comments to, seventy followers.
- **A 45-day streak** (`--streak`), alive today, a high level, and rare achievements (the streak, Props, endorsements: the rarity job has run).
- **A squad before a hackathon deadline:** it owns a squad of three for the hackathon whose registration closes in twenty hours, with a pledge each, an idea chosen, a checklist, a post on the
  looking-for-group board and **one seat open** for a designer.
- **Matches and drops:** a few matches with conversations (some with unread messages), sparks waiting, and today's drops.
- **A share card that looks good:** an adult with cards on, with a headline, role and shipped work (`/api/og/passport/<username>`).
- The account is `<username>@demo.skilldating.test`; to sign in, run `npm run db:seed:clerk` (it creates the Clerk accounts for the demo domain only, password `DemoPass123!`).
  A world `--reset` removes demo accounts with the rest of the world (their ids start `sd_demo_`); run `seed:demo` again.

## Tests

`prisma/seed/seed.test.ts` (unit) covers the generator, the arguments, the guard and the plan. `tests/integration/seed.test.ts` runs the seed for real against a database of its own: the refusals, a world
that is consistent (XP equals the log, history is in the past, every status and phase is there), the second run changing nothing, `--reset` giving the same people, the romance people only on request, and
the demo account.
