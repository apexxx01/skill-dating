# Squads: hackathon team building

Squads are how people find a team for a hackathon, here or on another platform. A **squad** is a `Team` with a `hackathonId`. Its people play
**roles** from a fixed catalogue, it fills **slots** for the roles it still needs, and it has a **strength** score with the **gaps** that hold it
back. Three ways in:

- **Find my squad** (the squad builder). It proposes a complete squad around you, and one call invites everyone on it.
- **The solo pool.** Two days before the registration deadline, everyone who said they are open to it is split into balanced squads.
- **The looking-for-group board.** Posts by people who want a squad and by squads that want people.

Before a hackathon, members **pledge** how they will take part. After it, they **review** each other in private. Those reviews add up to a
**reliability** that every step above reads. The reliability number itself is never shown.

Code: `src/lib/squads/`. Routes: `src/app/api/teams/[id]/…`, `src/app/api/hackathons/[id]/…`, `src/app/api/squad-proposals/…`,
`src/app/api/admin/hackathons/[id]/…`. Endpoint reference: [API.md](API.md). Page wiring: [FRONTEND_CONTRACT.md](FRONTEND_CONTRACT.md#squads-hackathon-page-squad-builder-lfg-board-team-space).

## Roles and slots

The role catalogue (`SquadRole`, `src/lib/squads/roles.ts`) is: `FRONTEND`, `BACKEND`, `FULLSTACK`, `MOBILE`, `ML_AI`, `DATA`, `DEVOPS`,
`DESIGN_UI_UX`, `PRODUCT`, `PITCH_BUSINESS`, `HARDWARE`, and `OTHER` with a `customLabel` (at most 40 characters). A smart contract developer is
`OTHER` with the label "Smart contract developer".

- **`TeamSlot`**: `role`, `customLabel`, `requiredSkills[]`, `status` `OPEN` or `FILLED`, `filledById`, `position`. The owner and admins of a team
  add, edit and remove **open** slots. A team never has more open slots than free places (`SLOT_LIMIT_REACHED`).
- **`TeamMember.squadRole`** (+ `roleLabel` for OTHER) is what the member does on the squad. `TeamMember.role` is still the permission role
  (OWNER, ADMIN, MEMBER). Members declare their own `squadRole`, and the owner can set anyone's.
- **Applications and invitations** can name a `slotId`. When one is accepted, the slot is filled and the member's `squadRole` comes from it. An
  invitation lasts **48 hours**. After that, accepting it is `410 INVITATION_EXPIRED`, and the hourly sweep marks it `EXPIRED`.
- **`Team.lookingFor`** is kept for old clients. It is now *derived* from the open slots (each slot's required skills, or its role's name). An
  old client that writes `lookingFor` replaces the open slots with one slot per entry, inferring the role from the text. The migration turned
  every existing entry into an OTHER slot with the entry as its label.

### Joining rules (`src/lib/squads/membership.ts`)

Every way into a team runs `checkJoin()` and then `addMember()` in one transaction:

- **Capacity.** The team row is locked, then the members are counted. Capacity is `min(Team.maxSize, Hackathon.maxTeamSize)`. A team created or
  edited for a hackathon is clamped to the hackathon's `maxTeamSize`.
- **One squad per person per hackathon.** You cannot be registered with, or a member of, two teams of the same hackathon
  (`ALREADY_IN_HACKATHON_TEAM`).
- **The lock.** At the hackathon's `submissionDeadline` (or its `endDate` when there is none), the team's membership freezes. Nobody can join,
  leave, be removed or invited, and no slot can change (`TEAM_LOCKED`).
- **Registration.** Joining a team that is already registered for the hackathon (it has a `HackathonTeam`) registers a registered participant
  with it, stamps `teamJoinedAt` and pays `TEAM_FORMED` once. Registering again with the same team through `POST /api/hackathons/{id}/teams` is a
  no-op that answers the same. The minimum team size is checked at submission.
- **Leaving.** Leaving, or being removed, reopens the slot the person filled. The owner then gets a **refill suggestion**: up to three people
  from the pool who want that role, best fit first (the `squads/refill-suggestion` job). Owner transfer uses the existing
  `POST /api/teams/{id}/transfer-ownership`.
- Joining a squad closes your open PERSON post on that hackathon's board.

## Squad strength (`src/lib/squads/strength.ts`)

Strength is a score from 0 to 100. It is a weighted sum of six components, each worth 0 to 1. It follows the same rules as the pairwise score
(`src/lib/matching/score.ts`):

- A component the data cannot judge counts as **neutral (0.4, the pairwise score's neutral)**.
- A component that does not apply is left out, and the other weights are scaled back up to 100. For example, skill coverage is left out when no
  skills are required.

| Component | Weight | Value |
| --- | --- | --- |
| `roleCoverage` | 25 | The share of the template's roles that someone covers. Members are matched to roles one-to-one (a maximum matching), and a role a member declared counts before a role they could merely play. A full-stack developer covers frontend or backend. |
| `skillCoverage` | 20 | The share of required skills someone on the squad has. Required skills are each template role's skills plus the open slots' skills. |
| `timezoneOverlap` | 15 | Hours of the working day (09:00 to 19:00 local) that **everyone** shares, divided by 4, capped at 1. |
| `commitmentFit` | 15 | The mean of: the fewest hours a week over the most (from pledges, else matching profiles); the share of pledges confirmed (only before the start); and the members' mean reliability (only for members with reviews). |
| `experienceMix` | 15 | 0 when nobody has shipped (or deployed) before. 0.75 with one person who has, plus 0.25 for each more. |
| `chemistry` | 10 | Neutral for strangers (never a penalty). Otherwise 0.4 + 0.6 × min(1, good pairs / (n − 1)), where a "would build again" pair counts 1 and a pair who were on a hackathon team before counts 0.6. |

**Role template** (`templateFor`). For a squad of size *n*:

1. The specialised roles that the chosen tracks name, then those the hackathon's technologies name. These are ML/AI, mobile, data, DevOps,
   hardware, and OTHER labels such as smart contract developer. At most *n − 1* of them.
2. Then the balanced default: frontend, backend, designer, pitch, full-stack, product, DevOps, data, ML, mobile.

Each technology becomes a required skill of the role it implies. For an existing team, *n* is its capacity.

**Gaps**, most important first. Each has a `code` and a `message`:

| Code | When | Example message |
| --- | --- | --- |
| `TOO_SMALL` | Fewer members than `minTeamSize` | "Needs 2 more members to reach the minimum of 3" |
| `MISSING_ROLE` | A template role nobody covers | "No designer" |
| `NO_DEPLOYER` | Nobody has shipped before | "No one on this squad has deployed before" |
| `MISSING_SKILLS` | Required skills nobody has | "No one knows Python" |
| `LOW_TIMEZONE_OVERLAP` | Fewer than 3 shared hours | "Only 2h timezone overlap" |
| `UNCONFIRMED_PLEDGES` | Before the start, someone has not pledged | "1 member has not confirmed their commitment pledge" |
| `HOURS_MISMATCH` | The fewest hours are less than 35% of the most | "Time to give ranges from 5h to 40h" |

Reliability is never its own gap and is never shown. `GET /api/teams/{id}/strength` is for members and admins only.

### Worked example

This is the case pinned in `strength.test.ts`. The hackathon's technologies are React, Node.js and Python, and the squad has 4 places, so the
template is frontend (React), backend (Node.js), designer, pitch. Python is required too. Before the start:

| Member | Role | Skills | Zone | Hours | Shipped | Pledge |
| --- | --- | --- | --- | --- | --- | --- |
| Ana | Frontend (declared) | React | UTC | 20 | yes | yes |
| Ben | Backend (declared) | Node.js | UTC−5 | 10 | no | yes |
| Chi | could design | Figma | UTC+5:30 | 20 | no | no |

Ana and Ben said they would build together again.

| Component | Value | Points |
| --- | --- | --- |
| roleCoverage | 3 of 4 (nobody to pitch) = 0.75 | 25 × 0.75 = 18.75 |
| skillCoverage | React and Node.js of React, Node.js, Python = 0.667 | 20 × 0.667 = 13.33 |
| timezoneOverlap | UTC, UTC−5 and UTC+5:30 share no working hours = 0 | 15 × 0 = 0 |
| commitmentFit | mean of hours 10/20 = 0.5 and pledges 2/3 = 0.583 | 15 × 0.583 = 8.75 |
| experienceMix | one person has shipped = 0.75 | 15 × 0.75 = 11.25 |
| chemistry | one good pair of the 2 a chain of three needs: 0.4 + 0.6 × ½ = 0.7 | 10 × 0.7 = 7 |
| **Score** | | **59.08, shown as 59** |

Gaps: "No one to pitch", "No one knows Python", "No shared working hours across your time zones", "1 member has not confirmed their commitment
pledge".

`STRENGTH_CONFIG` in `strength.ts` is the source of truth for every weight and threshold.

## The squad builder ("Find my squad")

`POST /api/hackathons/{id}/squad-builder` with `{ size?, seed?, tracks? }`. The caller must be registered for the hackathon. Rate limit: 20 an
hour.

1. **Anchor.** The caller, plus their team's members if they already have a team for the hackathon. People that team has already invited (and
   not heard back from) hold their places and are not proposed again. If the squad is already complete: `SQUAD_COMPLETE`.
2. **Size.** The default is 4, or what was asked, always within `minTeamSize..maxTeamSize`.
3. **Template.** From the chosen tracks (or the team's `targetTracks`) and the hackathon's technologies, as above. An unknown track is
   `TRACK_NOT_FOUND`.
4. **Pool.** Registered participants of the hackathon who have no team, said `lookingForTeam`, are trusted by the trust gate (`src/lib/trust.ts`:
   a week old with a verified email), are in no team of it, and are not deleted. At most the 400 most recent are considered.
5. **Shortlist.** Each candidate is scored against the caller with the pairwise score (`score.ts`), with the squad history as its prior signal.
   Excluded candidates (blocked) are dropped. The best 40 go to the optimiser.
6. **Optimise** (`buildSquad`, `src/lib/squads/optimizer.ts`).
   - A greedy pass adds the candidate who raises squad strength most, ties broken by the pairwise fit, then by a seeded shuffle.
   - Then a swap search: replace a proposed member with a candidate while strength improves.
   - **Forbidden pairs** (a block either way, or a mutual "would not build again") are never on one squad.
   - Bounded by 20,000 strength evaluations, not by time. The same input and seed always give the same squad. The default seed comes from the
     hackathon, the caller and the day.
7. The proposal is stored (`SquadProposal`, kind BUILDER, status OPEN) for **24 hours**. It holds each member's role and the reasons from the
   pairwise score, and the squad's strength. An empty result is `SQUAD_POOL_EMPTY`. Tracked as `squad_builder_used`.

`POST /api/hackathons/{id}/squad-builder/{proposalId}/invite` with `{ teamName? }` (Idempotency-Key honoured) does everything in one
transaction:

- It claims the proposal once. A second call gets `SQUAD_PROPOSAL_USED`, and a proposal past its 24 hours gets `SQUAD_PROPOSAL_EXPIRED`.
- It uses the caller's team, or creates one. A new team comes with its owner, its conversation, and its `HackathonTeam`, so the team space exists
  at once.
- For each proposed person who is still free, it opens a slot for their role (or reuses an open one) and sends a 48-hour slot invitation.
- People who joined another squad, are blocked, are already invited, or for whom there is no room come back in `skipped`.

Invitees are notified (`SQUAD_INVITE`). Accepting a builder invitation is tracked as `squad_proposal_accepted`.

## The solo pool and auto-formation (`src/lib/squads/pool.ts`)

`PATCH /api/hackathons/{id}/participation` with `{ lookingForTeam?, preferredRoles?, openToAutoTeam? }` puts a registrant in the pool (tracked as
`solo_pool_joined`). Being open to an automatic team implies looking for one.

**Timeline** (*D* is the registration deadline, or the start date when there is none):

| When | What |
| --- | --- |
| D − 7 days | Reminder to teamless registrants (`SQUAD_REMINDER`, stage `T7D`) |
| D − 48 hours | **Round 1** (the `squads/auto-form` job, hourly). Reminder `T48H`. |
| Round 1 + 24 hours | Each proposed squad is settled: it forms or it fails |
| After round 1 settles, if at least 25 hours remain before D | **Round 2**, once: the people who accepted a squad that failed, plus everyone left over |
| D − 24 hours | Reminder `T24H` |

**A round:**

- The pool is registered, teamless, `openToAutoTeam`, trusted participants who are in no squad and are not waiting on a proposal. Round 2 leaves
  out anyone who declined, or never answered, a squad that failed.
- The pool is partitioned (`partitionPool`): squad sizes are as close to the target as `min..max` allows (never fewer than 2 people).
  - Each person, in seeded order, goes to the squad with room that they raise most.
  - Then swaps between the weakest squad and the others, while a swap raises the **weakest squad's strength** (then the total). This is max-min:
    no squad is sacrificed to make another great.
  - Forbidden pairs are kept apart, and people who cannot be placed are leftovers.
- The `SquadFormationRun` row (unique per hackathon and round) and all its `PROPOSED` proposals are written in **one transaction**. Running the
  job twice, or on two workers, makes one set. A duplicate is answered `ALREADY_RAN`.
- Everyone proposed is notified (`SQUAD_PROPOSAL`) and has 24 hours (never past the lock) to answer:
  `POST /api/squad-proposals/{id}/respond { accept }`. An accept is tracked as `squad_proposal_accepted`.

**Settling** happens when everyone has answered, or the 24 hours are up (the hourly `squads/sweep`). It runs under a per-proposal advisory lock,
so it is safe to repeat.

- If at least `max(2, minTeamSize)` of those who accepted are still free, the squad **forms**:
  - A team is created with the first of them as owner, and each of the others fills a FILLED slot for their proposed role, through
    `checkJoin`/`addMember`.
  - `AUTO_SQUAD_FORMED` is emitted for each member (the pool-squad achievement) and tracked as `auto_squad_formed`.
  - Everyone is notified (`SQUAD_UPDATE`).
- Otherwise it **fails**, and the people who accepted stay in the pool.
- The run is marked settled when its last proposal is.

An admin runs a hackathon's next round, or a given one, right away with
`POST /api/admin/jobs/squads/auto-form { "data": { "hackathonId": "…", "round": 1 } }`.

## Looking-for-group board (`src/lib/squads/lfg.ts`)

`LfgPost`: `kind` PERSON or TEAM (with `teamId`), `roles[]`, `stack[]` (lower-cased), `timezone`, `note` (at most 500 characters), `expiresAt`
(by default when the teams lock).

- **One active post per person per hackathon**, kept under `pg_advisory_xact_lock('lfg:<hackathon>:<author>')`. A partial unique index was not
  used because Prisma cannot see one. A second post gets `LFG_ACTIVE_POST_EXISTS`, with the existing post's id.
- A PERSON post needs the author registered and in no squad. A TEAM post needs a team of the hackathon that the author owns or administers.
- `GET /api/hackathons/{id}/lfg?role=&stack=&tz=&kind=&cursor=&limit=`:
  - Only active posts, filtered by role, stack tag and kind.
  - `tz` keeps posts within 3 hours of that zone. A post without a zone is kept. Wrap-around at the date line is handled.
  - Ranked by the **author's pairwise fit to the viewer** (`score.ts`), then the newer post, then the id. Each post carries `fit` (score and
    reasons).
  - People the viewer blocked, or who blocked the viewer, are left out.
  - Offset cursors. The order is computed, as on the other scored lists.
- The author edits (PATCH) or closes (DELETE) their own post. An admin can close any post.

## Team space (`src/lib/squads/space.ts`)

For members (and admins). `GET /api/teams/{id}/space` returns:

- the roles, each with its pledge;
- the hackathon's dates, tracks and the countdown (`locksAt`, `secondsLeft`, `locked`);
- the open slots;
- the checklist (title, assignee, done);
- the idea board (votes, `votedByMe`, the chosen idea);
- `unconfirmedPledges`.

Writes:

- **Checklist**: `POST /checklist`, `PATCH`/`DELETE /checklist/{itemId}`. Any member can write it, an assignee must be a member, and there are at
  most 100 items.
- **Ideas**: `POST /ideas`. `POST`/`DELETE /ideas/{ideaId}/vote` are one vote per member, and both are safe to repeat.
  `POST /ideas/{ideaId}/choose` (owner or admin) marks one idea as chosen. Its author, or whoever runs the team, deletes an idea. At most 50.
- **Post our demo**: `POST /demo-post`. A `DEMO` post on the Ship Feed through the existing `createPost`, for the team and its project,
  co-authored by the other members (at most five, the feed's limit, skipping anyone blocked).
- **Keep building**: `POST /keep-building` (owner or admin), once the results are in or the hackathon has ended.
  - The squad becomes a permanent crew: `keptBuildingAt` is set and `hackathonId` cleared, so the hackathon's size limits and lock stop applying.
    Its `HackathonTeam` keeps the history.
  - Members and roles stay.
  - The project is kept, or created from the chosen idea (else the team's name) with every member on it. That creation pays `PROJECT_CREATED`
    as usual.
- **Tracks**: `PATCH /api/teams/{id}` with `targetTracks` (at most 5) is checked against the hackathon's tracks (`TRACK_NOT_FOUND`) and stored in
  the hackathon's spelling. Hackathon create and update accept `tracks` (name and description) and `submissionDeadline`.

## External hackathons

Most hackathons live on Devfolio, Devpost, MLH, Unstop or Luma. This platform is the team layer. `Hackathon` has these fields:

- `source`: NATIVE or EXTERNAL
- `externalUrl`: normalised, unique
- `platform`: DEVFOLIO, DEVPOST, MLH, UNSTOP, LUMA or OTHER, from the host
- `mode`: ONLINE, IN_PERSON or HYBRID
- `city`, `country`, `tracks`
- `submittedById`, `verifiedAt`

`POST /api/hackathons/external` (trusted accounts only, `ACCOUNT_NOT_TRUSTED`; Idempotency-Key; 10 an hour):

1. **Normalise** the link (`normalizeExternalUrl`):
   - https;
   - the host in lower case without `www.`;
   - no default port, no fragment, no tracking parameters (`utm_*`, `ref`, `fbclid`, …), the other parameters sorted;
   - no trailing slash.

   If that spelling is already known, the existing hackathon comes back with `200 { created: false }`.
2. **Fetch** the page through `PageFetcher` (`src/lib/infra/page-fetch.ts`). The safety rules:
   - only `http:`/`https:`, only ports 80 and 443, no credentials in the URL;
   - **every address the host resolves to is checked at connect time** by a custom DNS lookup on the socket. Private, loopback, link-local,
     CGNAT, multicast, documentation and IPv6 unique-local addresses, including IPv4-mapped IPv6, are refused. A name cannot pass a check and then
     resolve somewhere else;
   - redirects are followed by hand: at most 3, on the same host only (a `www.` difference is allowed);
   - 5-second timeout for the whole fetch, 1 MB cap, HTML only;
   - `PAGE_FETCH_ALLOW_PRIVATE` (`host:port` pairs) exists for the integration tests' fixture page, and the server refuses to start with it in
     production.

   A link these rules refuse is `400 EXTERNAL_URL_REFUSED` (with `details.reason`). A page that is down, slow or not HTML is
   `422 EXTERNAL_PAGE_UNREADABLE`, unless the caller sent `name`, `startDate` and `endDate`, in which case those are used.
3. **Read** the page as data (`parseHackathonPage`): a JSON-LD `Event`/`Hackathon` first, then OpenGraph and Twitter tags, then the `<title>`.
   - Name, description, image (absolute http(s) only), dates, attendance mode, place.
   - Every text is reduced to plain text: scripts, styles and tags are removed, entities decoded, control characters dropped, and the length
     capped. **Nothing from the page is executed or stored as markup.**
   - The caller's own fields override what the page says. With no dates at all: `422 EXTERNAL_DATES_UNKNOWN`.
4. **Create** it `EXTERNAL`, with its status from its dates and its own conversation. It is **unverified**: usable for squads straight away,
   `unverified: true` in every hackathon response, and it **pays no XP** (registering, forming, submitting, winning) until an admin verifies it
   (`PATCH /api/admin/hackathons/{id}/verify { verified }`). Anybody trusted can submit a link, so an unverified hackathon must not be a way to
   mint XP. Two people adding the same link at the same moment get one hackathon.

## Reliability and peer review

- **Pledge**: `PUT /api/teams/{id}/pledge` with `{ attendance: IN_PERSON|REMOTE, hoursAvailable (1–168), availableFrom, availableUntil }`.
  - A member makes or changes it until the hackathon starts (`PLEDGE_CLOSED`), within the hackathon's dates with a day of slack
    (`PLEDGE_DATES_OUTSIDE`).
  - Unconfirmed members are a strength gap and are listed in the team space.
- **Peer review**: `POST /api/hackathons/{id}/peer-reviews` with `{ revieweeId, showedUp: YES|PARTLY|NO, wouldBuildAgain, note? }`.
  - The note is one line, at most 140 characters, and **only admins** see it (`GET /api/admin/hackathons/{id}/peer-reviews`).
  - The window opens at `min(resultsAt, endDate)` and lasts **7 days** (`PEER_REVIEW_WINDOW_CLOSED`). `PATCH …/results` stamps `resultsAt`.
  - Teammates only: the members of your `HackathonTeam` for it (`NOT_TEAMMATES`). One review per pair per hackathon (`PEER_REVIEW_EXISTS`).
    Refused while either has blocked the other.
  - **Trust gate**: a review from an account the gate does not trust is kept with `counted: false` and changes nothing. Its author is not told.
  - `GET` gives the caller their teammates and what they said, never what anyone said about them.
  - The sweep asks each squad member once (`PEER_REVIEW`, coalesceKey `peer-review:<hackathon>`).
- **ReliabilityScore** (`src/lib/squads/reliability.ts`, `UserReliability`) is recomputed in the transaction of each counted review:
  - Each review is worth `0.7 × showedUp (1 / 0.5 / 0) + 0.3 × wouldBuildAgain`.
  - The score is a Bayesian average shrunk toward a neutral prior of 0.75 that counts as 3 reviews.
  - Each review's weight halves every 365 days, so recent reviews count more.
  - It feeds squad strength (commitment fit), the builder, the solo pool, and `score.ts`'s `priorSignal`. `priorSignal` is the mean of the known
    parts: Build Date rating, reliability, and the viewer's own would-build-again (1/0). Its reasons are "You said you would build with them
    again" and "Reliable teammate on past squads".
  - **Never shown as a number.** `GET /api/users/{id}` and the player card (`GET /api/users/{id}/stats`) carry only `reliableTeammate: true|false`:
    a score of at least 0.85 from at least 3 reviews. A counted review retires the cached player card, so the badge shows at once.
- **Chemistry**: a "would build again" from either side makes a pair good chemistry. A **mutual "no"** makes them a forbidden pair: the builder
  and the pool never put them together again.

## Lifecycle and safety rails

- **Reminders** to registered-but-teamless participants at T−7d, T−48h and T−24h from the deadline.
  - Each stage is sent once per person: `Notification.coalesceKey` `squad-reminder:<hackathon>:<stage>` is unique per person, so a rerun writes
    nothing.
  - Nobody who switched `SQUAD_REMINDER` off gets one.
  - A stage missed because the sweep did not run is sent late. A stage that has passed is never sent.
- **Expiry**: invitations after 48 hours, builder proposals after 24 hours, automatic proposals after 24 hours (then settled). All of it is the
  hourly `squads/sweep`.
- **Rate limits**:

  | Route | Limit |
  | --- | --- |
  | Builder, and builder invite | 20 an hour |
  | External links | 10 an hour |
  | LFG posts | 20 an hour |
  | Demo posts | 10 an hour |

  The existing invitation and application limits still apply.
- **Organizer data** (admins; B2B later):
  - `GET /api/admin/hackathons/{id}/teams.csv`: one row per member, with roles, rank, submission and project links. Every cell is escaped so a
    spreadsheet never reads it as a formula.
  - `GET /api/admin/hackathons/{id}/metrics`: the share of registrants who ended in a team, the median minutes from registering to joining one
    (from `teamJoinedAt`), squads, automatic squads formed, builder proposals sent, and the size of the solo pool.

## Fairness and safety rules

- **Nobody is ever placed with someone they blocked, or who blocked them.** Blocks are forbidden pairs for the builder and the pool, LFG hides
  blocked people both ways, invitations skip them, and peer reviews and accepts are refused.
- **Nobody the trust gate does not trust is in the builder's pool or the solo pool**, and untrusted peer reviews do not count.
- **A mutual "would not build again" is never paired again.** A one-sided "no" only lowers chemistry and the pairwise prior.
- **The weakest squad first.** The pool maximises the minimum strength, so nobody is left with the scraps.
- **Deterministic and bounded.** Every optimiser run is reproducible from its seed and stops after a fixed number of evaluations.
- **Reliability is private.** It is a number only the scorers read. People see the badge, and only above the threshold with enough reviews.
- **XP cannot be farmed** with throwaway accounts or unverified links. Peer-driven squad awards go through the trust gate, everything is once per
  slot or per hackathon, and unverified external hackathons pay nothing. See [GAMIFICATION.md](GAMIFICATION.md#squads).
