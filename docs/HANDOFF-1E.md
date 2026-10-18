# Stage 1E (Squads) — handoff

Branch `phase-1e`, cut from `main` at `0520138`. Work stopped partway through. This file says what is done, what is half-done, and exactly what is left.

## State of verification

- Typecheck and unit tests passed on `main` before the branch was cut.
- **Role slots** (step 1): the new integration test `tests/integration/squads-slots.test.ts` passed (8/8) against the real server and database.
- The pure modules (strength, optimiser, reliability, external parsing, page fetcher): their unit tests passed (53 + 22 + 6 + 18 + 38).
- **Not verified:** the full integration suite was started once after the slot changes and stopped before it finished, so regressions in existing
  team/hackathon tests are possible (see "Risks" below). Lint was run only on the slot routes and `src/lib/squads`.
- **The branch does not typecheck right now.** The Prisma client must be regenerated (`npx prisma generate`) for the new schema, and
  `src/lib/squads/prior.ts` uses `PriorSignal.reliability` / `PriorSignal.wouldBuildAgain`, which do not exist yet in `src/lib/matching/score.ts`.
- The migrations were generated with `prisma migrate diff` and have not been applied to a database yet, apart from migration 1, which the
  integration harness applied.

## Done

| Area | Files |
| --- | --- |
| Schema, all of Stage 1E | `prisma/schema.prisma`; migrations `20261019000100_squad_slots` (with the data migration of `lookingFor` into OTHER slots), `…0200_squad_pool_proposals`, `…0300_lfg_posts`, `…0400_team_space_tracks`, `…0500_external_hackathons`, `…0600_pledges_peer_reviews` |
| Role catalogue, inference, templates, derived lookingFor | `src/lib/squads/roles.ts` (+ test) |
| Joining and leaving (race-safe capacity under hackathon maxTeamSize, lock at submission deadline, one squad per hackathon, slot fill/reopen, auto-link to the HackathonTeam with TEAM_FORMED, reward gate for unverified external hackathons) | `src/lib/squads/membership.ts` |
| Slot routes | `src/app/api/teams/[id]/slots/route.ts`, `src/app/api/teams/[id]/slots/[slotId]/route.ts` |
| Team routes on slots | `src/app/api/teams/route.ts` (structured `slots`, legacy `lookingFor` → slots, creator `squadRole`, `?role=` filter, size clamped to the hackathon), `teams/[id]/route.ts` (slots in detail; PATCH lookingFor replaces open slots; maxSize bounds), `applications/route.ts` + `invitations/route.ts` (`slotId`, 48h expiry, lock), `applications/[applicationId]/route.ts` (accept goes through `checkJoin`/`addMember`; `INVITATION_EXPIRED`, `TEAM_LOCKED`, `SLOT_NOT_OPEN`, `ALREADY_IN_HACKATHON_TEAM`), `members/[userId]/route.ts` (self-declared `squadRole`, removal reopens the slot) |
| Error codes | `src/lib/api/errors.ts` (Squads section) |
| Squad strength (pure) | `src/lib/squads/strength.ts` (+ test, including the worked example meant for docs/SQUADS.md: score 59) |
| Optimiser (pure: seeded greedy + swap, max-min partition, bounded by evaluations) | `src/lib/squads/optimizer.ts` (+ test) |
| Reliability (pure: shrunk Bayesian average, recency half-life, badge rule) | `src/lib/squads/reliability.ts` (+ test) |
| External hackathon parsing (pure: URL normalisation, platform, OpenGraph/JSON-LD, sanitising) | `src/lib/squads/external.ts` (+ test) |
| Safe page fetcher (SSRF rules, connect-time DNS guard) | `src/lib/infra/page-fetch.ts` (+ test); `PAGE_FETCH_ALLOW_PRIVATE` in `src/lib/env.ts` (test only, refused in production) |
| Helpers | `src/lib/squads/access.ts`, `schemas.ts`, `lifecycle.ts`, `tracks.ts` |

## Half-done (written, not wired, not tested)

- `src/lib/squads/builder.ts`: `proposeSquad`, `proposalView`, `inviteProposal`, `expireBuilderProposals`. No route exists for it yet.
- `src/lib/squads/people.ts`: `loadSquadPeople`, `loadPairFacts` (would-build-again, teams together, blocks and mutual "no" as forbidden pairs), `trustedIds`.
- `src/lib/squads/prior.ts`: `loadPriorSignals`. It needs the `score.ts` change below.
- `src/lib/squads/teams.ts`: `createSquadTeam`, which makes the team, owner, conversation and HackathonTeam, and registers the owner.
- `builder.ts` uses the notification kind `SQUAD_INVITE`, and `track('squad_builder_used')`. Neither is registered yet (see steps 2 and 7).

## Remaining steps, in order

1. **Make it typecheck.** Run `npx prisma generate`. Then in `src/lib/matching/score.ts`, extend `PriorSignal` with `reliability?: number | null` and
   `wouldBuildAgain?: boolean | null`. Fold them into `priorSignal()` as the mean of the known parts (rating, reliability, would-build-again = 1/0),
   with the reasons "You said you would build with them again" and "Reliable teammate on past squads" (never show the number). Add unit tests to
   `score.test.ts`. Wire `loadPriorSignals` into `recommend.ts`, `team-gaps.ts` and `drops.ts`. Check that `drops.test.ts` mocks still work.
2. **Compatibility fix:** in `src/app/api/hackathons/[id]/teams/route.ts`, allow `participant.teamId === body.teamId`, so it is idempotent. An accepted
   invitee is now auto-linked to a registered squad. Add `teamJoinedAt` when it sets `teamId`.
3. Add notification kinds to `src/lib/notification-kinds.ts`: `SQUAD_INVITE`, `SQUAD_PROPOSAL`, `SQUAD_REMINDER`, `SQUAD_UPDATE` (TEAM_INVITATION /
   HACKATHON_REMINDER / SYSTEM types), and `PEER_REVIEW`.
4. **Strength route:** `GET /api/teams/{id}/strength` (members, owner, admin). Use `loadSquadPeople` and `loadPairFacts`, needs from `templateFor` (team
   tracks + hackathon technologies, size = capacity), open-slot skills, and `pledgesExpected` before the start date.
5. **Builder routes:** `POST /api/hackathons/{id}/squad-builder` (registered participant; body `{ size?, seed?, tracks? }`; rate limit ~20/hour;
   returns `proposal`) and `POST /api/hackathons/{id}/squad-builder/{proposalId}/invite` (`idempotent: true`; body `{ teamName? }`). Add the error
   codes `SQUAD_COMPLETE`, `SQUAD_POOL_EMPTY`, `TRACK_NOT_FOUND`, `SQUAD_PROPOSAL_NOT_FOUND`, `SQUAD_PROPOSAL_USED` and `SQUAD_PROPOSAL_EXPIRED`. In the
   accept route, `track('squad_proposal_accepted')` when the application has a `proposalId`.
6. **Solo pool:** `PATCH /api/hackathons/{id}/participation` (`lookingForTeam`, `preferredRoles`, `openToAutoTeam`; `solo_pool_joined`). Write
   `src/lib/squads/pool.ts`:
   - Round 1 at `registrationDeadline - 48h`: `partitionPool` over the teamless, trusted pool that is `openToAutoTeam`, with blocks and mutual-no as
     forbidden pairs. Create the `SquadFormationRun` (unique hackathon+round) and its AUTO `PROPOSED` proposals in one transaction, with a 24h
     expiry, and notify everyone.
   - `POST /api/squad-proposals/{id}/respond` `{ accept }`. `GET /api/squad-proposals` (mine, cursor).
   - Settle when everyone has answered, or at expiry. If `>= minTeamSize` accepted, `createSquadTeam`, then `checkJoin` + `addMember` with FILLED slots.
     Emit `AUTO_SQUAD_FORMED` and track `auto_squad_formed`. Otherwise mark it FAILED.
   - Round 2 re-pools, once, the people who accepted in failed squads plus the round-1 leftovers, if there is time before the deadline.
   - Add jobs in `src/lib/infra/jobs.ts`: `squads/auto-form` (hourly; `{ hackathonId?, round? }` on demand via admin jobs) and `squads/sweep`
     (hourly: settle, expire builder proposals, mark invitations past `expiresAt` as EXPIRED, reminders).
7. **Rewards** (`events.ts`, `rewards-config.ts`, `metrics.ts`, `achievement-definitions.ts`, `trust.ts` PEER_PAIRS, `analytics.ts`):
   - Events: `SQUAD_SLOT_FILLED` (owner, 15 XP, once per slot, daily cap 5, filler must be trusted; emit from `addMember`), `SQUAD_SUBMITTED` (each
     member, 75 XP, once per hackathon), `SQUAD_JOIN_CONFIRMED` (non-owners at submit, 30 XP, once per hackathon), and `AUTO_SQUAD_FORMED` and
     `SQUAD_REUNITED`, which pay no XP.
   - Metrics `squads`, `pool_squads`, `reunions`. Achievements `first-squad`, `squads-5`, `pool-squad`, `reunite`: 51 in total, so update the
     integration tests that pin 47.
   - Analytics names: `squad_builder_used`, `squad_proposal_accepted`, `solo_pool_joined`, `auto_squad_formed`, `squad_submitted`.
   - In `hackathons/[id]/submit/route.ts`: `transactWithEvents`, a minTeamSize check, the emits, and a reunite check (the squad shares 2+ people from
     a previous hackathon squad).
   - Gate every XP-paying hackathon event on `hackathonPaysRewards` (an unverified external hackathon pays nothing): register, teams and results
     routes too. Set `Hackathon.resultsAt` in the results route.
8. **LFG:** `src/lib/squads/lfg.ts`, plus `GET/POST /api/hackathons/{id}/lfg` (`?role=&stack=&tz=&kind=&cursor=`, ranked by score.ts fit to the
   viewer then recency, excluding blocked people) and `PATCH/DELETE /api/hackathons/{id}/lfg/{postId}`. Keep one active post per person per hackathon
   under `pg_advisory_xact_lock('lfg:<hackathon>:<author>')`. Use `idempotent: true`.
9. **Team space:**
   - `GET /api/teams/{id}/space`: roles, countdown (`lockTimeOf`), checklist, ideas, pledge status.
   - Checklist CRUD, ideas (post / vote / unvote / choose), `POST /api/teams/{id}/demo-post` (a DEMO post via `createPost`, with `coAuthorIds` = all
     members), and `POST /api/teams/{id}/keep-building` (after results or the end date: set `keptBuildingAt`, link or create the project; no lock
     afterwards).
   - `PATCH /api/teams/{id}` accepts `targetTracks`, validated against `tracksOf(hackathon.tracks)`. Hackathon create/patch accept `tracks`
     (`tracksSchema`) and `submissionDeadline`.
10. **External hackathons:** `POST /api/hackathons/external` (trusted users only via `accountDistrust`; `idempotent: true`): normalise, dedupe, then
    `getPageFetcher().fetchPage` → `parseHackathonPage`, with body overrides for name and dates and 422 when the dates are still unknown. Store it as
    EXTERNAL and unverified, with `platformOf`. Add `PATCH /api/admin/hackathons/{id}/verify`. Show `unverified: true` in hackathon responses. For the
    integration test, add `PAGE_FETCH_ALLOW_PRIVATE=localhost:<port>` to the child env in `tests/integration/global-setup.ts` and serve a fixture page
    from the test.
11. **Reliability:**
    - `PUT /api/teams/{id}/pledge` (a member, before the start date).
    - `POST/GET /api/hackathons/{id}/peer-reviews`: the window opens at `min(resultsAt, endDate)` and lasts 7 days; one review per pair; teammates
      only; `counted = trust gate`.
    - Recompute `UserReliability` in the same transaction with `reliabilityOf`.
    - An admin-only notes route.
    - A `reliableTeammate` badge on `GET /api/users/{id}`.
12. **Lifecycle extras:** a refill-suggestion notification to the owner when a slot reopens (the members route already returns `reopenedSlotId`).
    Reminders at T-7d, T-48h and T-24h to teamless registrants, deduped with `Notification.coalesceKey` `squad-reminder:<hackathon>:<stage>`. Admin
    `GET /api/admin/hackathons/{id}/teams.csv` and `GET /api/admin/hackathons/{id}/metrics` (% in a team, median time-to-team from `teamJoinedAt`).
13. **Types and docs:** add types to `src/types/api.ts`. Write `docs/SQUADS.md`, using the worked example from `strength.test.ts`. Update `docs/API.md`,
    `docs/FRONTEND_CONTRACT.md` (Hackathon page, Squad Builder, LFG board, Team space) and `docs/GAMIFICATION.md`.
14. Write integration tests for every new route. Then run typecheck, lint, unit tests and the **full** integration suite. Push `phase-1e`; never merge.

## Decisions taken so far

- `TeamMember.role` stays as the permission role. What a member does is the new `squadRole` (+ `roleLabel` for OTHER).
- A smart-contract developer is `OTHER` with the label "Smart contract developer". The catalogue is kept exactly as specified.
- The migration turns each legacy `lookingFor` entry into an OTHER slot labelled with the entry. Later legacy writes infer the role. The slot limit
  applies only to structured `slots`, so old clients never start failing.
- Squads created by the builder or the pool get their HackathonTeam immediately, so the team space exists from the start. The min size is meant to
  be checked at submit.
- Unverified external hackathons pay no XP, so they can't be used to farm it.
- A partial unique index for LFG was avoided because Prisma cannot see it. An advisory lock is used instead.

## Risks to check first

- The accept route was refactored onto `checkJoin`/`addMember`. It now auto-links registered members to an existing HackathonTeam and enforces one
  squad per hackathon. Existing tests that put one person on two teams of the same hackathon, or that register a member after acceptance (step 2),
  may fail.
- Team creation clamps `maxSize` to the hackathon's `maxTeamSize`.
