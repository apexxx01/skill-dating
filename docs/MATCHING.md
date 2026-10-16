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
