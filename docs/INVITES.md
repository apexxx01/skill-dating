# Invites and campuses

Two ways the platform grows on trust it already has: people bring people (invite codes), and colleges become places (campuses). Both are built so that the reward cannot be farmed and the place
cannot be faked. The code is in `src/lib/invites` and `src/lib/campus`; the activity rules they share with the metrics are in `src/lib/kpi/activity.ts`.

## Invite codes

| | personal | campaign |
|---|---|---|
| Whose | one per person, made the first time they ask (`GET /api/invites/me`) | made by an admin (`POST /api/admin/invites`) for a launch waitlist or a partner college |
| Looks like | eight characters from an alphabet without look-alikes (`K7M2QX9D`), typed in any case with or without hyphens | the same, or a chosen one (`IISC2026`) |
| Limit | 50 uses | as set (or none), with an optional expiry |
| Reward | XP to the owner (below) | none: attribution only |
| Campus | none | optionally one, suggested to people who join with it |

### Joining with a code

A person joins with a code **once**, in the first **14 days** of their account:

- **At sign-up.** The sign-up page sets `unsafeMetadata.inviteCode` on the Clerk user (`signUp.create({ unsafeMetadata: { inviteCode } })`). The first time the platform sees the account it reads the
  code and attributes the account to it (`syncClerkUser`). A bad code never stops a sign-up.
- **Afterwards.** `POST /api/invites/redeem { code }`, for pages that cannot carry it in the sign-up.
- **Before.** `GET /api/invites/check?code=` is public, for the sign-up page to say "you were invited" before there is an account. It answers `{ valid }` and nothing more (not whose code, not which
  campus), the same no for every reason a code cannot be used, and is limited to 10 a minute per address, so it is no way to find codes.

The attribution is a row (`InviteRedemption`): one per invitee, ever. The answers do not tell a code that never existed from one that was switched off, ran out or expired (`404
INVITE_CODE_INVALID`), so nobody learns anything by trying codes. Your own code is `400 INVITE_OWN_CODE`; a second code is `409 INVITE_ALREADY_REDEEMED`; an account older than 14 days is
`409 INVITE_WINDOW_CLOSED`. The last use of a limited code goes to exactly one of two people redeeming it at once (the count and the limit are checked in one statement).

### Earning XP

For a personal code, the owner is paid **40 XP per invitee, once**, when **all** of these hold:

1. the invitee has **finished onboarding** (a headline, a skill and, while required, a date of birth: the same rule as everywhere);
2. **and** has done a **first real thing** (a project, a post, a spark, Props, a comment, the squad builder or the solo pool, a squad submission, or XP for an action of their own: the list is "A real
   thing done" in [METRICS.md](METRICS.md)); looking at drops or following someone does not count;
3. the invitee is a **trusted counterparty** (`src/lib/trust.ts`): an account at least a week old with a verified email, with no block between the two of them. Until then the invite waits
   (`QUALIFIED`, reason `WAITING_TRUST`) and is paid when it holds;
4. the checks below pass.

The hourly job `invites/qualify` moves open invites forward. The XP itself is **not written by the invite code**: the job emits the domain event `INVITE_QUALIFIED` and the rewards engine pays it
under its ordinary rules (source type `INVITE`, once per invitee by the unique key on the XP log, **at most 3 a day**, not a streak action). On top of that, **at most 10 invitees are ever paid for
per person** (`INVITE_REWARD_CAP`); the 11th is qualified and stays unpaid (`CAP`).

States of an invite: `PENDING` (joined, not yet started) → `QUALIFIED` (started; for a campaign code that is the end) → `REWARDED`; or `REJECTED` (with a reason), or `EXPIRED` (not started in 30
days, or still waiting for its payment after 60).

### What stops the farming

- **Your own code**, and **the same mailbox on both accounts** (the same address up to `+tags` and, for Gmail, dots and the `googlemail.com` alias): the invite is recorded `REJECTED` and nothing is
  paid. The answer to the invitee says it worked, so a farmer is not told which rule caught them. Every such rejection writes an `IntegritySignal` (`invite_suspect`) for review.
- **Risk.** An inviter or an invitee at a **HIGH** risk level (`UserRisk`, an admin's override winning) is rejected; so are two people in an **open collusion finding** together (`FraudSignal`).
- **Trust.** Above: a week-old, verified invitee, no block between them.
- **Caps.** 3 payments a day, 10 invitees ever.
- **Throwaway addresses** cannot sign up at all (`src/lib/identity/signup.ts`), and sign-ups are limited per address.

### Admin

`POST /api/admin/invites` makes a campaign code (a label, optionally a chosen code, a campus, a limit, an expiry); `GET /api/admin/invites` lists them with how many joined and got started;
`PATCH /api/admin/invites/{id}` changes the label, limit or expiry or switches a code off and on (a personal code can only be switched). Every change is in the audit log.

## Campuses

A campus is a record an admin makes: a name, a slug (the key its leaderboard is called by: lower-case words with hyphens, never changed), the **e-mail domains** of the college, and where it is.
A person is on its **leaderboard** and in its **feed** (`Profile.campusKey` = the slug; `GET /api/leaderboard?scope=campus`, `GET /api/feed?tab=campus`) **only after verifying a campus e-mail
address**. Typing a campus name on the profile is only text to show: it puts nobody on a board (before this stage it did; the migration cleared those placements, and a typed name stays as text).

### Verifying

1. `GET /api/campuses?q=` lists the campuses that take members, with the domains to use.
2. `POST /api/campus/verification { campusId, email }` mails a six-digit code to the address. The address must be on one of the campus's domains (or a subdomain: `cs.iisc.ac.in` is on
   `iisc.ac.in`; `eviliisc.ac.in` is not) and not a throwaway domain. At most 5 a hour a person. The code is good for **15 minutes and 5 tries**.
3. `POST /api/campus/verification/confirm { code }`. The person becomes a member: `Profile.campusKey` and `campus` are set (and the country, if they had none), their entries move to the campus
   boards, and a `campus_verified` event is recorded.
4. `DELETE /api/campus/me` leaves the campus (the boards are told where the person was so the old one is cleared). While a campus is verified its text cannot be changed
   (`409 CAMPUS_IS_VERIFIED`); to change it, leave first.

**The address is private.** It is kept in `CampusVerification.email` only until the code is confirmed or has expired, then erased (a sweep in the retention job removes what is left an hour after
expiry). What remains is `CampusMembership.emailHash`, an HMAC of the address keyed with the server's secret: it stops one campus mailbox from verifying two accounts (`409
CAMPUS_EMAIL_IN_USE`, so the first account keeps the campus) and cannot be turned back into the address. No route returns an address, to its owner or to anyone else; `GET /api/campus/me` shows
only the domain of a verification in progress. The code is stored as a keyed hash too.

**Minors.** Accounts under 18, and accounts that have not said how old they are, share a country and nothing finer, so they cannot join a campus (`400 MINOR_LOCATION_LIMITED`; `GET
/api/campus/me` says `canJoin: false`).

**Campus suggestions.** A person who joined with a campaign code that has a campus gets that campus in `GET /api/campus/me` as `suggested`, for the page to offer. It is a suggestion: they still
verify an address.

### Admin

`POST /api/admin/campuses`, `GET /api/admin/campuses` (with member counts), `PATCH /api/admin/campuses/{id}` (rename, domains, place, close to new members: the people it has keep their place).
Changes are audited. Adding a college is: name, domains, country and city.

## Metrics

`invites_per_active_user_28d` and `invite_conversion_14d` ([METRICS.md](METRICS.md)) measure this; growth by campus is by verified campus.
