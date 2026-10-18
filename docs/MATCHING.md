# Matching

How Skill Dating finds the people a builder should meet: the matching profile, the compatibility score, daily drops, sparks and
matches, and the rules that keep it safe. The code is in `src/lib/matching/` and the routes under `src/app/api/{matching,drops,sparks,matches}`.
The routes themselves are in [API.md](API.md); what the interface needs is in [FRONTEND_CONTRACT.md](FRONTEND_CONTRACT.md).

## The matching profile

One row per person (`MatchingProfile`), saved whole by `PUT /api/matching/profile`.

| Field | Meaning |
| --- | --- |
| `connectionTypes` | What they are looking for, one or more of `COFOUNDER`, `HACKATHON_TEAMMATE`, `COLLABORATOR`, `MENTOR`, `MENTEE`, `DATING`. |
| `intentTags` | What they want right now: up to 10 `{ tag, hackathonId?, expiresAt? }`. A tag is lower-case words joined by dashes (`ship-mvp-90-days`). A few are suggested by the client and have a hand-written line for "why you matched"; any other well-formed tag is matched on and shown as its words. A tag tied to a hackathon only matches the same hackathon; an expired tag stops counting at its `expiresAt` (at most a year ahead). |
| `hoursPerWeek`, `availableFrom` | How much time they can give and from when. |
| `remoteOk`, `cityOnly` | `cityOnly` means "only people in my city" (`Profile.cityKey`); it is a filter and a score component. |
| `lookingForSkills` | Skill slugs they need. |
| `workingStyle` | Their answers to the fixed quiz (`GET /api/matching/quiz`, in `src/lib/matching/quiz.ts`): six questions about pace, communication, planning, decisions, working hours and appetite for risk. Each question's options are ordered from one end of a spectrum to the other, which is how two answers are compared. |
| `dropTimeLocal` | When their daily drops arrive, `HH:MM` in their own time zone (default 09:00). |
| `paused` | Out of everybody's drops, and no drops of their own. |

**Pairing of types.** `MENTOR` pairs with `MENTEE`; every other type pairs with itself. Two people can be paired on a type only if
one has it and the other has its counterpart. A match is stored under the name of the relationship (a mentor and a mentee are a `MENTOR`
match).

## The dating gate

`DATING` is strictly opt-in and gated, by one rule in `src/lib/matching/dating.ts` that is used everywhere dating appears (saving the
profile, building drops, sending a spark). A person may use dating only with **all** of:

- a **verified email**, and a **verified phone or a connected GitHub account**;
- a **date of birth on file that makes them 18 or older**. No date of birth, no dating. A minor is refused outright.

Refusals are `403 DATING_BIRTH_DATE_REQUIRED`, `403 DATING_UNDERAGE` and `403 DATING_VERIFICATION_REQUIRED`, and `GET /api/matching/profile`
tells the owner what is missing. Age is counted on the UTC calendar date, so in the hours when a birthday has come in one zone and not yet
in another the person is treated as not yet 18; a 29 February birthday is reached on 1 March in a common year. The same rule exists as SQL
for the candidate query (`datingEligibleSql`), and a test proves the two agree for every day across four years.

**The date of birth is private.** `User.birthDate` is set through `PATCH /api/users/me/profile` and returned only by that profile read, to its
owner; no other route, list, card or search carries it (a test scans the source for every file that so much as names the column and
fails when an unlisted one does, and an integration test reads every public surface for it). It is **set once and then locked**, so a minor
cannot change it to pass for an adult (a different date afterwards is `409 BIRTH_DATE_LOCKED`; the same date again is fine). It is wiped
when the account is deleted, along with the matching profile.

**Dating never mixes with the other types, in either direction.** A drop or a spark of type `DATING` needs `DATING` on both profiles and both
people eligible; a drop of any other type never shows somebody who has only `DATING`; and somebody who chose `COFOUNDER` and `DATING` is
shown cofounder candidates for the one and dating candidates for the other, each only from people who chose that same type.

## Compatibility score (v2)

`scoreCompatibility()` in `src/lib/matching/score.ts` is a pure function: two profiles that the caller has already loaded, the type of
relationship and the clock, and nothing else. It returns `{ score, components, reasons }` (and `excluded` for someone who must not be
shown). The score is from the viewer's side: a `MENTEE` looks at candidates for a `MENTOR`.

### Components and weights

All the numbers are in `SCORE_CONFIG`. Each component is worth 0 to 1 and is multiplied by its weight; the weights add up to 100.

| Component | Weight | What it measures |
| --- | --- | --- |
| `skillComplement` | 22 | What each has that the other is looking for (and what you have for them). A wanted skill counts half, plus the rest by level. Both directions are averaged. |
| `skillOverlap` | 8 | The skills both know, by the lower of the two levels, relative to the smaller list. |
| `sharedStack` | 7 | Technologies shared between their current builds and projects; three shared is a full score. |
| `intentMatch` | 14 | The share of the smaller list of active intent tags that both have. |
| `commitmentFit` | 9 | The ratio of `hoursPerWeek` (80%) and how close `availableFrom` is (20%): within two weeks is the same, three months apart is nothing. |
| `timezoneOverlap` | 9 | Hours of a 09:00 to 19:00 day that both are in; six or more is a full score. |
| `location` | 5 | Only when either asked for `cityOnly`: 1 for the same city, 0 otherwise. When it does not apply it is left out and the other weights are scaled to 100. |
| `workingStyle` | 8 | How alike the quiz answers are over the questions both answered. |
| `proofStrength` | 9 | The candidate's verified evidence (45%), tier (30%), shipped projects (15%) and endorsements (10%). |
| `activityRecency` | 5 | The candidate's last activity (50%), last XP (30%) and streak (20%), fading to nothing over 30 days. |
| `priorSignal` | 4 | The average Build Date rating the viewer gave them, once there are any. |

**Missing data is neutral, not zero.** A component that needs something from both sides (how many hours a week, which time zone) is
unknown when one side has not said, counts as the neutral value (0.4) and never produces a reason. So a sparse profile is neither
punished nor inflated.

**The type of relationship moves the weights**, and they are scaled back to 100 afterwards (`typeMultipliers`): a mentee chooses a mentor for what
they have shown (proof ×1.8, shared skills ×0.25), a mentor looks at a mentee for drive (recent activity ×2, intent ×1.3, proof ×0.7), and
dating leans on how two people work and what they want (working style ×1.8, intent ×1.6) and hardly on skills (complement ×0.2, proof ×0.3).

**Excluded people are not scored.** Someone the viewer blocked (or who blocked them), or passed within the last 30 days, scores 0 with
`excluded` set. In practice they never reach the scorer, because the candidate query leaves them out first.

### Reasons

The three strongest lines, strongest first (a line's strength is how strong its component is times what the component is worth for this
type). They are built from facts and never from a guess: "You need ML, they have 3 verified ML projects", "6h timezone overlap", "Both
want to ship by year end", "You both build with Next.js and Postgres", "They have shipped 4 projects". They say **"they"**, never a guess
at a pronoun, and a component with no data behind it says nothing.

## Daily drops

A **drop** (`Drop`) is one person shown to another for one day of the viewer's own calendar: `{ userId, candidateId, connectionType, score,
reasons, localDate, status: NEW | SPARKED | PASSED | EXPIRED, secondLook, expiresAt }`, unique on `(userId, candidateId, localDate)`. The
type is the relationship from the *viewer's* side (a mentee is shown mentors as `MENTEE`).

### When

The job `drops/generate` runs **hourly** (`:05`) and only **dispatches** (see "Fan-out" below). A person is *due* when their `dropTimeLocal` has passed in **their own time zone** today and
they have no drops for that local day yet (`MatchingProfile.lastDropDate`). That is a catch-up rule, not "this exact hour": somebody who saves
their profile at 22:00 gets their drops at the next run, and a missed run is made up by the next. A day is generated once, even when nobody
fits (the marker is written either way). The time zones in use are looked up once, and each zone's due people are one query. A person
with no time zone is on UTC. `drops/expire` runs hourly (`:20`) and marks `NEW` drops past `expiresAt` (the end of the viewer's day) as `EXPIRED`.

### How many, and which

- **How many:** `limit(user, DAILY_DROPS)` from the entitlements table: **3 for everyone while `ENTITLEMENTS_ENFORCED=false`** (scarcity is the product, so the
  free number applies to every plan until plans are switched on), and 3 on FREE and 10 on PRO/CREW_PRO/ORG once it is `true`; the hard ceiling of 50 is an abuse
  limit that applies either way. Less what they already have today. A second-look drop is extra and does not count. Daily sparks follow the same rule (5, then 25).
- **Who is in the pool** (`src/lib/matching/candidates.ts`, one SQL query per type of relationship the viewer chose):
  has the counterpart type · not paused · not deleted · seen in the last 60 days · **a trusted account** (verified email, at least 7 days old: the same
  rule as the trusted-counterparty gate, `MIN_TRUSTED_ACCOUNT_AGE_DAYS`) · **not blocked either way** · not shown to the viewer in the last 7 days ·
  **not passed in the last 30 days** · for DATING only, dating-eligible · the "only my city" wish of either side · and under the **exposure
  cap**. (Existing matches and people already sparked are left out too: see Sparks and matches.)
- **Fairness: the exposure cap.** One person is shown to at most **20** people a UTC day (`DROP_CONFIG.exposureCapPerDay`). Drops are made
  one viewer at a time, so each sees what the viewers before them were shown, and the order of viewers is shuffled by the day
  (`shuffledForDay`) so nobody is always first at the popular candidates. A popular person is therefore spread over many viewers, not shown to all of them.
- **Scored in batches:** the database hands back at most 300 candidates per type, pre-ranked cheaply (skills each wants that the other has, then recency).
  Their profiles are loaded 300 at a time in a handful of queries (never one per person; a person who is a candidate for many viewers is loaded once per run)
  and ranked by the pure scorer.
- **Floor:** a candidate scoring under 30 is not shown.
- **Diversity:** somebody who chose **several types** gets **at most one drop per type** a day (the best cofounder, the best teammate, the best mentor, each
  a different person); somebody who chose **only one type** gets as many as their allowance. A person who fits two types is shown once, as the better fit.
- **Dating** pools are separate queries from every other type (see "The dating gate"), and a viewer who is no longer eligible is simply given no dating drops.

Writing the drops is one transaction under a per-person advisory lock that re-checks the marker and the allowance, so two runs at once (or an
admin run during the hourly one) cannot give anybody more than their allowance.

### Reading and passing

`GET /api/drops/today` returns the caller's drops for their own current date, best first, each with the person's card, the score and the reasons; people who
were blocked since, or whose account is gone, are left out. The first read of a new drop stamps `viewedAt` and counts one `drop_viewed` (once per drop, even
under concurrent reads). `POST /api/drops/{id}/pass` marks a `NEW` drop `PASSED` and stores a snapshot of the person's tier and verified evidence (for the second look);
passing twice is fine; someone else's drop is `404`; a sparked or expired one is `409`.

## Sparks and matches

A **spark** says "I would like to work with you", with an **opener** of 20 to 280 characters that gives a reason. `POST /api/sparks`
`{ toId, connectionType, opener, dropId? }` (it honours `Idempotency-Key`); `connectionType` is the *sender's* side (a mentee sparks a
mentor as `MENTEE`). One spark per person per type. When the person had already sparked the sender with the **counterpart type** they are
**matched**, in the same request:

- a **Match** (`userAId` is always the smaller id, so a pair is one row whichever of them sparked first; unique on the pair and the
  relationship; a database check keeps the order);
- a **conversation**: the direct one the two already had if it is still open, otherwise a new one, holding the platform's **icebreaker**
  (what the two share: skills, technologies, intents; a first question for the type; for dating only intents), then the two openers in the
  order they were written. These are written directly, so they pay nothing and raise no "first message" event;
- a **notification** (`MATCH`) for each, a **realtime push** `match.created` on each `user:{id}` channel, and the event `MATCH_CREATED`;
- both sparks `MATCHED`, and any still-open drop between the two `SPARKED`.

**Concurrency.** The pair is locked (a transaction-scoped advisory lock) for the writes, and the second spark re-reads under it, so two people
sparking each other at the same moment make exactly one match, one conversation and three messages (a test repeats it). The unique keys on
the spark and the match are the backstop.

**Unmatching is final.** `DELETE /api/matches/{id}` (either person) ends the match, **closes the conversation for both** (it stays readable;
posting is `409 CONVERSATION_CLOSED`), and the pair can never be matched, shown to each other in drops or sparked again (`409 MATCH_ENDED`).
`POST /api/matches/{id}/report` does the same and files a report against the other person in the ordinary `Report` queue (with
`metadata: { source: "MATCH", matchId }` and an audit event); a pending report of the caller's against them is kept rather than duplicated.
Blocking someone ends every open match with them and closes the conversations; a match with a blocked person is hidden even if it were not.

**Received sparks.** `GET /api/sparks/received` returns the sparks the caller has not answered. Who sent them, and what they wrote, needs the
`SEE_WHO_SPARKED` entitlement; without it the response is `{ canSee: false, count, sparks: [] }` (the number only). Senders who are blocked
either way or gone are not counted.

### Safety

- **Dating** needs both people eligible (see "The dating gate"); a minor is refused with `403 DATING_UNDERAGE` and can neither send nor
  receive a dating spark, appear in a dating drop, or be matched for dating. Dating and the other types never mix: a spark of one type cannot
  be answered with another, a `DATING`-only person is not available for any other type and the other way round.
- **Trust.** The person sparked must be a trusted account (verified email, at least 7 days old) and must have chosen the counterpart type and not
  be paused; every way of being unavailable looks the same (`404 SPARK_TARGET_UNAVAILABLE`), so none can be probed. A person blocked by the sender is
  told so plainly; a person who blocked the sender gets `404 USER_NOT_FOUND`.
- **Blocks** are checked on every surface: sparks, the received list, the matches list, drops and the candidate pool, and a block ends open matches.
- **No contact details in an opener** (links, e-mail addresses, phone numbers, "message me on WhatsApp"): they can be shared once matched.

### Anti-spam

Checked, in order, before anything is written (`src/lib/matching/opener.ts` and `sparks.ts`), each with its own error:

1. **Opener quality** (`400 SPARK_OPENER_REJECTED`, `details: { reason, message }`): 20 to 280 characters; at least five words; not a stock message
   ("hey how are you", "let's connect", "love your profile", "would love to pick your brain", "I think we would be a great match"), judged by what is left once
   greetings, stock phrases and filler are removed; no links; no e-mail addresses, phone numbers or invitations to talk elsewhere; no characters or words
   repeated to fill space. `reason` is one of `TOO_SHORT`, `TOO_LONG`, `TOO_FEW_WORDS`, `LOW_EFFORT`, `LINK`, `CONTACT_DETAILS`, `REPEATED_CHARACTERS`, `DUPLICATE`.
2. **The same opener to many** (`DUPLICATE`): an opener with the same words as, or at least 80% of the words of, any of the sender's last 50 openers in the
   last 30 days is refused, whatever its case and punctuation. A different sender may use the same words; an old repeat is forgotten.
3. **Daily limit** (`429 SPARK_LIMIT_REACHED`, `params.limit`): `DAILY_SPARKS` from the entitlements table (**5 for everyone** while `ENTITLEMENTS_ENFORCED=false`, since scarcity is the product; 5 on FREE and 25 on
   PRO/CREW_PRO/ORG once it is `true`; the hard ceiling of 40 is an abuse limit either way), counted in the **sender's own local day**.
4. **Burst throttle** (`429 SPARK_THROTTLED`, `params.retryAfter`): at most 8 sparks in any hour, whatever the plan.
5. **Rate limit**: 20 requests a minute per user on `POST /api/sparks`, like any route.

### XP and achievements

**Sparks and matches pay no XP.** The event `MATCH_CREATED` is announced and counts a metric, nothing more. Three achievements recognise matching and pay
a one-off amount, which cannot be farmed because an achievement is earned once: `first-match` (25 XP), `matches-10` (50) and `match-teamed` (100; "Better Together":
a team with someone you matched with). See
[GAMIFICATION.md](GAMIFICATION.md#achievements). Analytics events: `drop_viewed`, `spark_sent` (`matched` says whether it completed a pair),
`match_created` (one per person) and `unmatch`.

## Gap finder (teams)

`GET /api/teams/{id}/gaps` (the team's owner or an admin of the team, or a platform admin) says what a team is missing and who could fill it.

- **Declared needs.** `Team.lookingFor` and the project's `lookingFor`, set against what the members can do. A need that is a **skill of the
  catalog** (matched by name or slug, ignoring case) is covered when a member has that skill; anything else is a **role** ("Designer"), covered when a
  member's own `builderRole` contains it (or is contained by it). The project's **stack** counts as skills too: a technology that is a catalog skill should be
  known by somebody on the team; one that is not (a hosting product) cannot be checked and is only listed (`unmatchedStack`). Each need keeps where it
  came from (`TEAM_NEEDS`, `PROJECT_NEEDS`, `PROJECT_STACK`). The analysis is a pure function (`src/lib/matching/gaps.ts`).
- **Top 5 candidates**, from the same pool query and the same scorer as the daily drops, so the same people are left out: paused, deleted and
  untrusted accounts, anyone blocked with the caller, anyone the caller passed in the last 30 days, anyone over the daily exposure cap, anyone who ended a
  match with the caller, and every current member and applicant. The candidates are people who chose a type that fits the team: `HACKATHON_TEAMMATE` for a team
  of a hackathon, otherwise `COLLABORATOR` or `COFOUNDER`. **Dating is never part of it.** The team is scored as a viewer who is looking for its missing
  skills and offers its members' skills, so "You need ML, they have 3 verified ML projects" reads the same as in a drop. Two things differ from a drop:
  somebody shown to the caller in the last week, or already sparked or matched with them, is **not** left out (a matched person is a good person to invite).
- **Inviting** reuses the invitation flow: `POST /api/teams/{id}/invitations { userId }`. Nothing here sends anything.

## Second look (weekly)

The job `drops/second-look` (Mondays, 07:15 UTC; safe to repeat) gives each person **at most one** previously passed candidate a week, as an extra drop
flagged `secondLook: true`, when that candidate **has grown since the pass**: a higher tier, or more verified evidence than the snapshot taken when the
drop was passed (`Drop.passSnapshot`). It looks at passes between 14 and 120 days old, picks the candidate who grew most (a tier counts as five pieces of
evidence; ties go to the more recent pass), and checks them against the same pool rules as any drop (still eligible, not blocked, not matched, dating
eligibility for dating) except that the 30-day cooldown after a pass does not apply: that is the point. The drop is for the person's current local day, has a
fresh score and reasons with the growth first ("Since you last saw them they moved up to Gold"), is **extra** (it does not use up the daily allowance), and a
person gets one a **local week** (Monday to Sunday), however often the job runs.

## Scale: complexity and timings

**What one person's drops cost** (`generateDropsForUser`), for a viewer who chose *k* types (usually 1 or 2, at most 6):

| Step | Work | Why it is bounded |
| --- | --- | --- |
| Pool, one SQL query per type | `MatchingProfile ⋈ User ⋈ Profile` with the cheap filters as hash joins and anti-joins (type, paused, deleted, trusted, active in 60 days, dating, city, blocks, matches, sparks, recent drops), then one index scan of `UserSkill(skillId)` for the viewer's wanted skills, a top-N sort, and the exposure cap checked for the best 600 only | Linear in *M*, the people who hold the counterpart type and were active lately (about 0.4 µs a row), plus the holders of the wanted skills. Returns at most 300 ids per type. |
| Load the pool | 4 queries for 300 candidates (users with their profile, skills, current build and projects; verified evidence grouped; counters), never one per person; a person who is a candidate for many viewers is loaded once per run | 300 per batch |
| Score | `scoreCompatibility` for each: pure arithmetic over a few dozen numbers, about 5 µs each | 300 per type |
| Write | one transaction under a per-person lock | at most the daily allowance |

So a person costs *O(k · (M + 300))* and **the work does not grow with the number of accounts that ever signed up**, only with the active, trusted people of the type, which the 60 day window bounds. The hourly run is *O(due people × that)*. People are processed one after another on purpose
(the exposure cap sees the people before them), in an order that changes every day.

**Measured** with `npm run bench:matching` (seeds synthetic people with skills, evidence, builds, blocks and mixed types, then generates drops for viewers on a FREE plan, so 3 each; one sequential worker; PostgreSQL 16 on the same Apple M5 laptop as the script, so add about a millisecond per query for a network hop in production):

| People | Viewers measured | Whole person (mean / p50 / p95) | Pool query (mean) | Load a 300 pool (mean) | Score a 300 pool (mean) | Everybody, one after another |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | 1,000 | 53 / 44 / 109 ms | 8 ms | 13 ms | 1.2 ms | 53 s |
| 10,000 | 1,000 (a tenth) | 96 / 106 / 154 ms | 29 ms | 25 ms | 1.9 ms | about 16 min |
| 10,000 | 2,000 (a fifth), re-measured for 1D | 72 / 72 / 126 ms | 31 ms | 22 ms | 2.1 ms | about 12 min |

The pool query is the part that grows (8 ms at 1,000 people, 29 to 31 ms at 10,000: about linear in *M*); everything else is bounded by the pool size.

### Fan-out: one batch job per chunk of a time zone (1D)

The hourly run used to be one worker walking everybody who was due, so the worst case, one dense time zone at one popular drop time (everyone at 09:00 in
the same city), took as long as all of them one after another: 10,000 such people were about 16 minutes. It is now split:

1. `drops/generate` (hourly, `:05`) **dispatches only**. It looks up who is due, grouped by time zone (`dueUsersByZone`: the zones in use once, then one query per zone),
   shuffles each zone's people for the day (so no batch is always first at the candidates everyone wants), cuts the zone into batches of `DROP_CONFIG.fanOutBatch`
   (250) and enqueues one `drops/generate-batch` job for each, with the id `drops:<hour>:<zone>:<n>`. The queue drops a repeated id, so a dispatch that runs twice in
   one hour enqueues nothing new. It does no scoring itself: a few queries and a few enqueues however many people are due.
2. `drops/generate-batch` (declared with a concurrency of `DROP_CONFIG.fanOutConcurrency`, 8, which Inngest enforces) generates for its 250 people one after another,
   exactly as before (`runDropGeneration`, not forced), so a person who already has today's drops is skipped. A batch that runs twice, or a retry, changes nothing.
   A person's failure does not stop the others in the batch; they are tried again at the next hourly run.

What does not change: the rules, the per-person lock and the unique key on `Drop` (which make a duplicate impossible whatever runs at once), and the order inside a
batch. What changes slightly: the **exposure cap** (20 a UTC day per candidate) is counted live from `Drop`, and batches run at the same time, so a very popular
candidate can end a day a few over the cap; the cap is a fairness guide, not a safety limit, and the overshoot is bounded by the batches in flight.

**Measured** with `npm run bench:matching -- --users 10000 --sample 2000 --workers 8`, which generates the same 2,000 people first one after another and then as eight batches of 250 at the same time:

| 2,000 people | Wall time | Per person |
| --- | ---: | ---: |
| One after another | 143 s | 72 ms |
| 8 batches of 250, 8 at a time | 36 s | 18 ms |

That is **4x** with all eight batches in one Node process (their scoring shares one thread) while the laptop was also running other work, so it is a floor. At that rate the
dense case, 10,000 people in one zone at one time, is about **3 minutes** instead of 16, and with the batches on separate workers (each job is its own process on Inngest) it is
bounded by the database, not by one thread. In general the time for a zone is about `ceil(batches / concurrency) × 250 × 72 ms`: 40 batches at a concurrency of 8 is 5 waves of
about 18 s of work each before contention, and a 1,000 person zone is a single wave of 4 batches, about 18 to 20 seconds. Each running batch holds one database connection at a time, so
`fanOutConcurrency` must stay below the connection pool of the deployment (Prisma's default pool is `2 × CPUs + 1`).

**Where it goes next** when one dense hour no longer fits in an hour even so (not needed at this size, and none of it changes the rules): raise the concurrency and the pool together;
precompute each person's skill set as an indexed array on `MatchingProfile` so the relevance rank is one GIN lookup; and put the exposure counters in Redis rather than counting `Drop` rows.

Every query path has an index: `MatchingProfile(connectionTypes)` (GIN) and `(paused, dropTimeLocal)`; `Drop(userId, localDate)`, `(userId, candidateId, createdAt)`, `(candidateId, createdAt)`, `(status, expiresAt)` and `(status, updatedAt)`; `UserSkill(skillId)`; `Spark(toId, status, createdAt)`, `(fromId, createdAt)` and `(openerHash, createdAt)`; `Match(userAId, endedAt)`, `(userBId, endedAt)`. The numbers above are re-measured with that script; the seeding is described at the top of `scripts/bench-matching.ts`.
