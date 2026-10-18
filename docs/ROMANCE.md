# The romance mode

Builder-first romance: people are matched on what they build, how they live and what they are obsessed with, and photos come last. The product name is not final: every label a
person reads comes from one constant, `ROMANCE_MODE_LABEL` in `src/lib/romance/config.ts` (today "Kindred"; API responses carry it as `modeLabel`, error messages as `{mode}`).
Everything else (code, routes, tables, analytics events, docs) says **romance**, so renaming the mode is that one line. The storage key of the old model stays `DATING` (the
`MatchType` and `ConnectionType` value, and the `Match` and `Spark` rows made with it); nobody ever sees it. Routes are in [API.md](API.md#romance), the 18+ gate and the
separation rules in [SAFETY.md](SAFETY.md).

## What it is made of

| Piece | Where |
| --- | --- |
| Profile (opt-in, 18+) | `RomanceProfile`; `PUT /api/romance/profile`; `src/lib/romance/profile.ts`, `service.ts` |
| Weekly drop | `RomanceDrop`; jobs `romance/drops` and `romance/drops-batch`; `GET /api/romance/drop`; `src/lib/romance/drops.ts`, `candidates.ts` |
| Scoring | `scoreRomance()` in `src/lib/matching/score.ts` |
| Sparks and matches | `POST /api/romance/sparks`; `src/lib/romance/sparks.ts`; the match writer is shared with the professional one |
| Photo reveal | `RevealRequest`; `src/lib/romance/reveal.ts` |
| Duo | `Duo`; `src/lib/romance/duo.ts` |
| Build Date | `BuildDate`: **Phase 2**, model and statuses only (the reveal can later key off `RevealRequest.buildDateId`); no route |

## The profile: work first, filters underneath

Public to a match or a drop (`PublicRomanceProfile`): three prompts answered in text (what I am obsessed with now, what I would build with someone, my ideal weekend build), an
**ambition** level (1 to 4), a **life direction** (`founder`, `craft`, `research`, `steady-career`, `nomad`, `open`), a **working rhythm** (`night-owl`, `early-bird`, `bursty`,
`steady`) and up to 12 **obsessions** (topics, tools, taste). Joining needs the 18+ gate: a date of birth that makes the person 18 or older, a verified email, and a verified phone or a
connected GitHub account (`403 DATING_*`); a minor is refused outright.

**Private filters** (`profile.private`, returned to the owner and to nobody else, in no response, anywhere): `gender` (a fixed list plus a self-description), `interestedIn[]`,
`ageMin` and `ageMax` (never below 18), `scope` (`CITY`, `COUNTRY` or `ANYWHERE`, which needs a city or country in the profile settings) and the **inbox gate** `minEndorsements` (0 to 5).
Their only effect on anyone else is that someone they refuse is never shown, and cannot spark.

### A match needs both sides to accept

`src/lib/romance/filters.ts` is the rule, as a pure function, used in both directions: B's gender is among A's `interestedIn`, B's age is inside A's range, and A and B are close enough
for A's scope; then the same with A and B swapped. The stricter side wins (A wanting only their own city is enough). `candidates.ts` is the same rule as SQL for the pool; an integration
test compares the two over a spread of 24 people (every ordered pair) and over explicit asymmetric cases (she would, he would not; he would, she would not; scope on one side only).

The **inbox gate**: "only people endorsed by at least N builders can spark me". The count is distinct *trusted* endorsers (a verified email, an account a week old, not deleted), counted from
peer endorsements (`src/lib/romance/endorsers.ts`), so a few new accounts cannot open someone's inbox. It does not stand in the way of a **reply**: someone who already sparked you can be
answered. The mode also never shows a person to someone who could not spark them.

## Scoring (`scoreRomance`)

A weighted sum like the professional score (0 to 100, unknown parts count as neutral, at most three reasons, deterministic), over its own components:

| Component | Weight | What it compares |
| --- | ---: | --- |
| `obsessions` | 28 | shared topics and tools; three shared is a full score |
| `direction` | 18 | the same direction is 1; "open" is 0.55; other pairs from a small affinity table, else 0.25 |
| `character` | 15 | how many trusted builders vouch for the **candidate** (5 is full) |
| `ambition` | 14 | distance on the 1 to 4 scale |
| `sharedTaste` | 13 | shared technologies of their builds (three is full) |
| `rhythm` | 12 | the same rhythm is 1; a night owl and an early bird are the furthest apart |

Skills, hours and time zones are not part of it, and the private filters are not either: they decide who may be shown, never how well two people fit. The reasons are human lines:
**"You're both night-owl builders obsessed with climate tech"**, "You both want to start a company", "You both build with Rust", "4 builders vouch for them".

## The weekly drop

**One** drop per person per local ISO week, its own job and its own limit, never part of the daily professional drops. A person is due from **Monday 08:00 in their own time zone** (and for the
rest of the week if they joined later); the hourly job `romance/drops` (:25) only dispatches `romance/drops-batch` jobs, a batch of 250 per time zone, exactly like the daily drops. The pool
(SQL, one query) applies, in order: the gate (18+, verified, a trusted account, active in the last 60 days, not paused or deleted), both people's filters, the candidate's inbox gate, blocks
either way, any match of the pair that ended or an existing romance match, a spark already sent, nobody shown to this viewer in the last 120 days, and a weekly exposure cap (25 people
a week per candidate). The best score at or above 35 is the drop; a week with nobody is looked at once a day, not hourly. `GET /api/romance/drop` shows it with **no photo and no
avatar** (placeholders with the blur hash) and nothing private; `POST /api/romance/drop/{id}/pass` passes. The person is told with a notification (switchable).

## Sparks and matches

`POST /api/romance/sparks`: the sender must have joined, pass the gate and be a **trusted account**; the person must be available (joined, not paused, gate and trust, both filters accept, the
inbox gate unless it is a reply) and the sender must have been **shown** them in this week's open drop, or have a spark from them waiting. Every way of being unavailable is the same
`404 SPARK_TARGET_UNAVAILABLE`, so no filter can be probed. Limits: `ROMANCE_SPARKS_PER_WEEK` (3 for everyone while plans are not enforced, scarce on purpose; 10 on PRO once they are) and the
8-an-hour throttle. A mutual pair makes a **romance match**: a conversation (system icebreaker built from the reasons the score found, then both openers), a notification each and a realtime
push. It **announces no event**: no `MATCH_CREATED`, so it counts toward no achievement, no counter and no XP. Unmatch and report reuse `DELETE /api/matches/{id}` and
`POST /api/matches/{id}/report`; both are final and silent. Notifications follow the professional rules: per spark with the sender for a plan that shows who, one daily count ("N people sparked
you in Kindred") for one that does not, both switchable (`ROMANCE_SPARK`, `ROMANCE_SPARK_DIGEST`).

## Photos and the reveal

Photos are uploads (`POST /api/media/uploads`, purpose `ROMANCE_PHOTO`, JPEG/PNG/WebP, at most 8 MB, at least 400 by 400, so up to six) attached with `POST /api/romance/photos`. They are
returned to **their owner only**. Everybody else gets a placeholder `{ blurHash, revealed: false }` and no avatar until a **mutual reveal**: `POST /api/romance/matches/{id}/reveal` asks (or accepts a
pending ask; two asks at once are an agreement); `DELETE` cancels, declines or **revokes** at any time, at once, for both. While `ACCEPTED` the other's photos come as short-lived signed URLs and
`other.image` appears. Ending a match revokes the reveal. `RevealRequest.buildDateId` is where Phase 2's Build Date (the first date as a micro-collaboration) will unlock it.

## Duo

Optional and by consent: one asks (`POST /api/romance/duo { matchId }`), the other accepts; either dissolves it (`DELETE`) at any time, and ending the match dissolves it. One active Duo each. The
page (`GET /api/romance/duo`) is for the two of them only and carries their **joint projects** and a **combined heatmap** (their XP per day added up on the caller's own days; a partner who hid
their activity adds nothing). It is on no profile, passport, feed or leaderboard.

## Leaving

`DELETE /api/romance/profile` removes the profile, photos (and their objects), drops and pending sparks, and ends open romance matches for good and silently. An admin correction of the date of
birth to 16 or 17, and deleting the account, do the same.

## Separation from everything professional

A source-scan test (`src/lib/romance/separation.test.ts`) lists the only files allowed to name the mode (each with its reason), requires that no professional surface (passport and player card,
leaderboards, profiles, search, dashboard, achievements, quests, the feed and posts) does, that the product name appears in exactly one place, and that no Build Date route exists. Professional
lists leave romance matches and sparks out; the professional pool, the daily drops and the second look ignore a stored `DATING`; and the mode has its own tables, jobs, notification kinds and analytics
events (`romance_*`).
