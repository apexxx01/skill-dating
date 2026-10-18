# Safety

How the platform keeps people safe, and where each rule lives in the code. This file covers the **age policy** and, below it, the rules that keep
the romance mode apart from everything else (see [ROMANCE.md](ROMANCE.md) for the mode itself). Blocks, the trust gate and the report flow are described
where they are used: [GAMIFICATION.md](GAMIFICATION.md#the-trusted-counterparty-gate) and [MATCHING.md](MATCHING.md#safety).

> **Needs legal review for each launch country.** The age policy below is the product's starting position, not legal advice. Before launching in a
> country, have counsel confirm the minimum age, what is allowed for people under 18, and how a date of birth may be collected and kept there:
> **GDPR-K** (the EU and the UK: the age of digital consent is 13 to 16 depending on the member state, and parental consent below it),
> **COPPA** (the US: under 13) and the **India Digital Personal Data Protection Act 2023** (under 18 is a child, and verifiable parental consent is needed
> to process a child's data; tracking and targeted advertising towards children are prohibited). The numbers live in one file, `src/lib/age-policy.ts`
> (`MIN_PLATFORM_AGE`, `ADULT_AGE`), so a country that needs a different line changes it in one place. A country that treats 16 and 17 year olds as
> children for data purposes may need the platform minimum raised to 18 there, which this design supports (set both to 18: nobody is a "minor" and
> nobody under 18 is admitted).

## The age policy

A date of birth is **required to finish onboarding**, for everyone. It is asked once, with the headline, and it is private.

| Age | What happens |
| --- | --- |
| **Under 16** | Refused at onboarding with `403 AGE_BELOW_MINIMUM`. **The date is not stored**; the only thing kept is the moment of the refusal (`User.birthDateRefusedAt`) and an audit entry without the date. The account is closed to everything but `GET /api/users/me`, `GET /api/users/me/profile` and `POST /api/reports` (so a person who mistyped can ask for a correction). Giving another date is not another chance. |
| **16 and 17** | A **minor**. They may use the professional features (projects, crews, hackathons, the feed), but: **never the romance mode** (it is 18+: the gate refuses them with `403 DATING_UNDERAGE`, and they cannot be shown, matched or sparked in it), **no recruiter visibility** (there are no recruiters yet; `recruiterVisible()` in `src/lib/age-policy.ts` is the one function a future recruiter surface must ask), **a location no finer than their country** (`city`, `campus` and the free-text `location` are refused with `400 MINOR_LOCATION_LIMITED`, and are cleared when the date makes them a minor), and they are excluded from every 18+ surface. |
| **18 and over** | An adult. |

How it is built:

- **One writer.** `src/lib/birth-date.ts` (`setBirthDate`) is the only code that sets a person's date. It runs in `PATCH /api/users` (onboarding) and
  `PATCH /api/users/me/profile` (settings). Two requests at once cannot overwrite each other (the write only happens while the column is empty).
- **Locked.** Once set the date cannot be changed by the person: the same date again is fine, another is `409 BIRTH_DATE_LOCKED`, so it cannot be edited to pass
  for an adult. It cannot be cleared.
- **Derived, not flagged.** There is no stored "is a minor" flag to go stale. A person is a minor while their date says so (`isMinor()`), so every
  restriction ends on the 18th birthday without a job. Age is counted on the UTC calendar date; a 29 February birthday is reached on 1 March in a common year
  (`src/lib/age.ts`, with a test over every day of two years).
- **Private.** The date is returned to nobody but its owner, on `GET /api/users/me/profile`. `GET /api/users/me` says only whether one is still required
  (`birthDateRequired`), whether the account is a minor's (`isMinor`) and whether it was refused (`ageRefused`). It is never written to the audit log of a
  profile edit, never part of a search, a profile, a drop, a match or a leaderboard, and is wiped when the account is deleted. A source-scan test
  (`src/lib/matching/privacy.test.ts`) lists the only files allowed to name the column and the only route allowed to return it.
- **Rollout switch.** `BIRTH_DATE_REQUIRED` (default `true`) controls whether onboarding needs the date. The backend is ready before the onboarding screen asks for it, so a
  deployment that reaches people before the screen does can set it `false` for that window and flip it on afterwards. With it off the date is still accepted
  and every age rule still applies to whoever has given one.

### Correcting a locked date

A person who gave the wrong date files `POST /api/reports` with the reason `BIRTHDATE_CORRECTION` (against themselves; a description of what is wrong and what it
should be is required). It lands in the ordinary report queue. An admin decides, and corrects it with `POST /api/admin/users/{id}/birthdate { birthDate, reason }`:
the reason is required, the old and the new date and the reason go into the audit trail (`BIRTH_DATE_CORRECTED`), a refusal is cleared, and the response says
only the age band. A correction **cannot admit someone under 16** (it is refused with `AGE_BELOW_MINIMUM`; that account is a moderation matter, not a typo), and a
correction to 16 or 17 clears the place down to a country and removes the person from the romance mode.

### What we keep, and why

Only what the rules need. The date is kept for people 16 and over, because the age bands and the 18+ gates are computed from it; it is not kept for anyone refused.
A refusal keeps one timestamp. The audit trail of a correction keeps both dates, because a change that cannot be traced is worth nothing; that table has no route that
reads it. Nothing about age is sent to analytics.

### Known limits (to settle with counsel)

- A date of birth is self-declared. There is no document check; `VerificationLevel.IDENTITY` exists for a future one. The romance mode adds a verified email and a phone or
  GitHub on top, which makes a throwaway account harder but does not prove an age.
- A person refused at 15 can open another account with another email. The refusal is tied to the account, not the person, as it must be without collecting more
  than we need.
- Parental consent flows for 16 and 17 (where a country requires them) are not built.
