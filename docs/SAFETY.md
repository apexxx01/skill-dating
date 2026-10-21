# Safety

How the platform keeps people safe, and where each rule lives in the code: the **age policy**, the rules that keep the romance mode apart from
everything else (see [ROMANCE.md](ROMANCE.md) for the mode itself), **integrity** (collusion, risk, reach gating), **moderation** (reports, the queue,
actions, appeals), **content checks**, **mutes** and **media safety**. The trust gate is described in
[GAMIFICATION.md](GAMIFICATION.md#the-trusted-counterparty-gate); personal data in [PRIVACY.md](PRIVACY.md); security in [SECURITY.md](SECURITY.md).

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
  (`ageRequired`), whether the account is a minor's (`isMinor`) and whether it was refused (`ageRefused`). It is never written to the audit log of a
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

## The romance mode: gating and separation

The mode ([ROMANCE.md](ROMANCE.md)) is the most sensitive surface, so it is closed by default and kept apart from everything else.

- **Gating, in layers.** 18 or older on a date of birth on file (a minor is refused whatever else is true), a verified email, a verified phone or a connected GitHub account (one rule, `src/lib/matching/dating.ts`, as
  code and as SQL, tested against each other for every day of four years); a **trusted account** to spark (a verified email, a week old); the **inbox gate** (only people endorsed by at least N trusted builders
  can spark someone who set N, 0 to 5); both people's private filters; blocks either way; and a person can only be sparked after being **shown** to the sender in an open weekly drop, so ids cannot be guessed.
- **Privacy of the filters.** Gender, who someone is interested in, the age range, the scope and the inbox gate are returned to their owner and no one else. Every way a person can be unavailable is the same
  `404 SPARK_TARGET_UNAVAILABLE`, so no setting can be probed. Reasons shown to a match are built from public answers only.
- **Photos.** Stored, returned to their owner only; to anyone else a blurred placeholder and no avatar until **both** people of a match agree, revocable by either at any time, at once; ending the match revokes it.
  Reads are short-lived signed URLs after the check.
- **Report and unmatch** reuse the existing flows (`POST /api/matches/{id}/report`, `DELETE /api/matches/{id}`): final, silent, closing the conversation. Blocking ends the match. A report lands in the ordinary queue.
- **Separation.** Nothing about the mode ever appears on the public passport and player card, a profile, the feed, the leaderboards, achievements or quests, search or any professional list. A romance match announces no
  event, so it counts toward no achievement and pays no XP. Its data lives in its own tables; the professional pool and drops never read them. `src/lib/romance/separation.test.ts` enforces this over the whole source.
- **Leaving is complete**: the profile, photos and their objects, drops and pending sparks go, open matches end silently. An admin correction to 16 or 17, and deleting the account, do the same.
- **Not built, to settle before launch**: ID verification beyond a verified phone or GitHub, moderation tooling specific to the mode (the report queue is shared), and per-country rules for a romance feature (needs legal review like the age policy above).

## Integrity (`src/lib/integrity`)

Nothing here bans anyone or deletes anything. It lowers how much suspicious things count, lowers reach, and puts people in front of a moderator.

### Collusion (job `integrity/collusion`, nightly 02:30 UTC)

The job builds a graph of the last 30 days: endorsements, Props, accepted connections (both ways), peer reviews and accepted team applications or
invitations, one directed edge per interaction (`collusion-job.ts`). The pure detector (`collusion.ts`):

1. keeps the **reciprocal** pairs (both directions seen) where at least one side is a **weak account**: younger than 30 days, or without proof of work
   (no shipped project, no verified evidence) and nothing beyond an e-mail verified;
2. splits them into connected groups;
3. flags a group of 3 or more whose reciprocal **density** is at least 0.6 and whose weak share is at least half, or a pair of weak accounts that each
   gave the other 3 or more interactions (groups over 50 are left for a person);
4. scores it: `100 x (0.4 density + 0.4 weak share + 0.2 min(1, interactions per member / 5))`.

Each flagged group is one `FraudSignal` (type `COLLUSION_RING`, keyed by a hash of its sorted members, so later runs update it): score, members,
evidence (counts per kind, density, the members' ages and proof; ids only, never content), and the exact rows it lowered. What the members gave **each
other** inside the window gets an integrity weight of `clamp(1 - score/100, 0.1, 0.5)`:

- a **Prop** adds `weight x integrityWeight` to the post's score (the score is recomputed);
- an **endorsement** below 0.5 no longer counts toward the romance inbox gate;
- a **peer review** moves reliability by its weight (reliability is recomputed).

XP already paid is not taken back. Staff review signals (`GET /api/admin/fraud-signals`, `PATCH /api/admin/fraud-signals/{id}`): **DISMISSED**
restores every weight the signal lowered (except rows another live signal also lowered) and the same group is never flagged again; **CONFIRMED** keeps
the down-weighting. Both are audited.

### Risk score (job `integrity/risk`, nightly 03:00 UTC)

Every person with any signal (and everyone already scored, so scores fall as signals age out) gets a score from 0 to 100 (`risk.ts`):

| Factor | Points |
| --- | --- |
| collusion: the highest score of an open or confirmed fraud signal they are in | 0.4 x score, at most 40 |
| distinct people who reported them in 90 days (reports not dismissed) | 8 each, at most 25 |
| people who blocked them in 90 days | 3 each, at most 15 |
| rate limits they ran into in 30 days | 2 each, at most 10 |
| velocity and content flags recorded about them in 30 days | 2 each, at most 10 |
| no date of birth on file; e-mail not verified | 5 each |

LOW below 40, ELEVATED from 40, HIGH from 70. A change of level is written to `AuditEvent` (`RISK_LEVEL_CHANGED`). Staff can override the level either
way (`PATCH /api/admin/users/{id}/risk { level | null, reason }`, audited); the override wins until cleared. **HIGH** means reduced reach, all of it
reversible: left out of other people's daily drops and the romance drop, left out of the squad builder, the solo pool and refill suggestions, posts
reach only the author's own network in the feed (followers, crew, matches; strangers do not see them), sparks capped at 1 a day, and 30 writes per 10
minutes on top of every route's own limit.

### Reach gating (`reach.ts`)

| Tier | Who | Sparks a day | Public posts and comments | Host rooms, post bounties |
| --- | --- | --- | --- | --- |
| UNVERIFIED | e-mail not verified | 1 | no (`403 EMAIL_VERIFICATION_REQUIRED`; followers-only and crew posts are fine) | no |
| NEW | verified e-mail, account younger than 7 days | 3 | yes | no |
| TRUSTED | verified e-mail, 7 days or older | the plan's limit | yes | no |
| VERIFIED | TRUSTED plus a phone, GitHub or higher verification | the plan's limit | yes | yes |

A HIGH risk level caps sparks at 1 a day whatever the tier. Rooms and bounties do not exist yet; `canHostRooms` and `canPostBounties` are where their
gate will be read.

## Moderation (`src/lib/moderation`)

### Reports

Anything can be reported from the surface it is on (`POST /api/reports { targetType, targetId, reason, description? }`; `reportedId` alone is still a
report about a person): a **user**, a **message**, a **ship post**, a **comment**, a **spark**, a **romance profile**, an **LFG post**, an **idea**, an
**external hackathon**. You can only report what you can see (a message in your conversation, a spark sent to you, a profile you were shown or matched
with); anything else is `404 REPORT_TARGET_NOT_FOUND`, so ids cannot be probed. Reasons: harassment, spam, impersonation, inappropriate content, minor
safety, scam, fake profile, copyright, other, and the date-of-birth correction. The report keeps a **snapshot** of what the thing said, so an edit or a
delete does not erase the evidence. One open report per reporter and thing. The platform files reports too (`source: AUTOMATED`): flagged content and
photos the scanner was unsure about.

### The queue (`priority.ts`, `GET /api/admin/queue`)

Open reports, most urgent first: **minor safety** (2000), then anything in the **romance mode** (+800), **impersonation** (600), harassment and scams
(400), inappropriate content and fake profiles (300), spam (200), corrections and copyright (150), other (100). Inside a band: the reporter's standing (a
trusted account +50, strongly verified +25 more, a HIGH risk reporter -100) and volume (+40 for each other person reporting the same open thing, up to
+200; every open report about it is re-ranked when another arrives). `?kind=appeals` lists pending appeals, oldest first. `GET /api/admin/reports/{id}`
shows the report with its context (the thing as reported and as it is now, the other reports about the person, earlier actions and their appeals,
restrictions in force, the risk of both people) and marks it REVIEWING.

### Actions (`actions.ts`, `POST /api/admin/actions`)

| Action | Effect | Appealable |
| --- | --- | --- |
| `WARN` | a notice | no |
| `HIDE_CONTENT` | the content disappears for everyone but staff; reversible | yes |
| `REMOVE_CONTENT` | hidden and its text blanked; needs a recent sign-in | yes |
| `RESTRICT_FEATURE` | romance, messaging or posting closed for N days or until lifted (`403 FEATURE_RESTRICTED` with the feature and the end) | yes |
| `SUSPEND` | the account is closed for N days (`403 ACCOUNT_SUSPENDED`) except for its own account, notices, data export, deletion, consent and appeals | yes |
| `BAN` | closed until lifted (`403 ACCOUNT_BANNED`), with the same exceptions; needs a recent sign-in | yes |
| `APPROVE_MEDIA` | a held photo is let through | no |

Every action carries a reason category, the moderator's note for the record and an optional note to the person; resolves every open report about the
same thing; is written to `AuditEvent`; and **notifies the person** (a notice about their own account, which cannot be switched off), with the end date
and whether they can appeal. `POST /api/admin/actions/{id}/reverse` takes one back (restrictions lifted, hidden content restored; removed text stays
removed). Only an admin acts on a staff account. Restrictions are read on every request by the request gate (`src/lib/api/gate.ts`), cached for a
minute and dropped on every change.

### Roles

Moderators act on content and people (the queue, actions, appeals, fraud signals, risk overrides, finding people by id or username). Only admins manage
feature flags and kill switches, plans, verification marks (the verified-organisation mark among them) and roles, read the audit log, and search by
e-mail. The full table is in [SECURITY.md](SECURITY.md#authorization-model).

### Appeals (`appeals.ts`)

The person an action is about appeals once, within 30 days (`POST /api/appeals { actionId, body }`), even while suspended or banned. `GET
/api/users/me/moderation` shows them what was done (the category, the note to them, the dates, whether they can appeal), never who reported them or the
moderator's own note. A moderator **other than the one who acted** decides (`POST /api/admin/appeals/{id}/decide { decision: UPHELD|OVERTURNED, note? }`);
OVERTURNED reverses the action. The person is told either way; the decision is audited.

## Content checks (`src/lib/safety`)

Messages, posts, comments, LFG posts, ideas and openers pass through `checkContent` before they are saved:

| Check | Outcome |
| --- | --- |
| a **hard** term from the banned list (`src/config/banned-terms.json`, matched as whole words with look-alike characters folded) | refused, `400 CONTENT_REJECTED` |
| a **soft** term | saved, and an automatic report for a moderator plus a signal for the risk score |
| more links than the surface allows (messages 3, posts 5, comments 2) / far more | flagged / refused |
| a link shortener | flagged |
| the same text 3 times in 10 minutes / 5 times | flagged / refused |
| links or contact details (e-mail, phone, "text me on WhatsApp") in a **spark opener** or the **first messages of a romance match** (until both have written) | refused |

The banned list is config, not code: Trust & Safety owns the production list and changes it by deploy. Openers keep their own stricter rules too
(`src/lib/matching/opener.ts`).

## Blocks and mutes

A **block** (`POST /api/blocks`) works everywhere: neither person can message, connect, invite, apply to or spark the other, and each is hidden from the
other's lists. A **mute** (`POST /api/mutes`) only hides: the muted person's posts, comments and listings leave the muter's feed and lists, and their
drops; they are not told and can still interact. Both are reachable from any surface the person appears on.

## Media safety (`src/lib/infra/media-moderation.ts`)

Romance photos and avatars are **scanned before anyone else can see them**. An upload that passes the size and type check is held as `SCANNING`, and the
scanner answers:

- **SAFE**: the file becomes READY and can be used;
- **NEEDS_REVIEW**: held as `IN_REVIEW`, with an automatic report in the queue (minor-safety labels make it a MINOR_SAFETY report); a moderator approves
  it (`APPROVE_MEDIA`) or removes it;
- **BLOCKED**: the object is deleted at once; only the hash, the verdict and the labels are kept.

A scanner that fails leaves the file held and retries (`media/scan`). Development and tests use a scanner that says SAFE. **In production, without a
provider (`MEDIA_MODERATION_URL` and `MEDIA_MODERATION_TOKEN`), romance photo and avatar uploads are refused** (`503 MEDIA_SCANNING_UNAVAILABLE`): the
adapter fails closed.

> **Needs legal review, and must be in place before romance photos are enabled in production.** A general-purpose image classifier is not enough for
> child safety. Before launch: (1) **hash matching against known child sexual abuse material** with a PhotoDNA-class service (Microsoft PhotoDNA,
> Thorn Safer, or the provider's own hash lists from NCMEC and the IWF), run on every romance photo and avatar before it is stored; (2) the **legal
> reporting duty of each launch country** wired into the BLOCKED path: in the US, reports to NCMEC's CyberTipline (18 U.S.C. 2258A); in the EU, the rules
> under the interim CSAM regulation and national law; in India, reporting under the POCSO Act and the IT Rules 2021; and the evidence each requires
> kept for the period each requires (today only the hash, verdict and labels are kept); (3) a documented process and trained people for the reports that
> reach the queue. The adapter is where the provider plugs in; the reporting duties are a process and a contract, not code.

## Kill switches

Six feature flags stop a feature for everyone at once, without a deploy: sign-ups, the romance mode, messaging, posting, external hackathon submissions
and automatic squads. Each is checked on the server and answers its own code. Owners and the procedure are in [DEPLOY.md](DEPLOY.md#kill-switches).
