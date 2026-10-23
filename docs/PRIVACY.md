# Privacy

How the platform handles personal data, written for the GDPR and India's Digital Personal Data Protection Act 2023 (DPDP), and where each rule lives in
the code. The age rules are in [SAFETY.md](SAFETY.md#the-age-policy); security controls are in [SECURITY.md](SECURITY.md).

> **Needs legal review before launch.** This document describes what the software does. Whether it is enough in each launch country (the lawful basis
> of each processing activity, the records of processing, the retention periods, cross-border transfers, the Data Protection Officer or the DPDP
> grievance officer, and the notices people are shown) is for counsel to confirm.

## Rights and where they are served

| Right | GDPR | DPDP Act | Endpoint |
| --- | --- | --- | --- |
| Access, portability | Art. 15, 20 | s.11 | `POST /api/users/me/export`, then `GET /api/users/me/export` for the signed link |
| Erasure | Art. 17 | s.12 | `DELETE /api/users/me` (or deleting the Clerk account, through the webhook) |
| Rectification | Art. 16 | s.12 | the profile and settings routes; a locked date of birth through the correction report ([SAFETY.md](SAFETY.md#correcting-a-locked-date)) |
| Withdraw consent | Art. 7(3) | s.6(4) | `DELETE /api/users/me/consents/{ROMANCE_MODE|MARKETING}`; the terms and the privacy notice by deleting the account |
| Object, restrict | Art. 18, 21 | | privacy settings: pause matching, invisible mode, leaderboards, recruiters, who can message |
| Grievance redressal | | s.13 | the report flow and appeals (`POST /api/reports`, `POST /api/appeals`); a published grievance contact is a launch item |

A suspended or banned person keeps every one of these: the request gate (`src/lib/api/gate.ts`) lets their export, deletion, consent and appeal routes
through.

## Consent (`src/lib/privacy/consent.ts`)

`ConsentRecord` is append-only: `(userId, type, version, grantedAt, withdrawnAt, source)`. Types: `TERMS`, `PRIVACY`, `ROMANCE_MODE`, `MARKETING`. The
version in force of each document is config, `src/config/legal-versions.json`.

- **At onboarding.** `GET /api/users/me` returns `consentRequired` (the documents not yet accepted in their current version), and onboarding is
  complete only with none left while `CONSENT_REQUIRED` is on (the default; like `BIRTH_DATE_REQUIRED` it exists so the backend can ship before the
  onboarding screen asks). The client records each with `POST /api/users/me/consents { type, version, source: "onboarding" }`. Only the current version
  can be accepted (`400 CONSENT_VERSION_UNKNOWN`).
- **Re-consent.** Raising `TERMS` or `PRIVACY` in the config asks everybody who accepted an older version to accept again: their writes answer
  `403 CONSENT_REQUIRED` (with `details.consents`) until they do. Reading, their own data, appeals and the consent route itself stay open.
- **The romance mode** handles special-category data: gender and who someone is interested in reveal sexual orientation (GDPR Art. 9). Turning it on
  (`PUT /api/romance/profile`) needs an explicit, current `ROMANCE_MODE` consent (`403 ROMANCE_CONSENT_REQUIRED` with the version to show). Withdrawing
  it (`DELETE /api/users/me/consents/ROMANCE_MODE`) turns the mode off **and deletes** the profile, its private filters, the photos and their objects,
  drops, pending sparks and the reveal state; open romance matches end silently (`src/lib/romance/consent.ts`). Kept: the consent record itself (proof
  of the lawful basis for what happened while it was given) and what moderation or the law holds (reports, actions, the audit trail).
- **Marketing** is off unless granted. It covers promotional mail only, and **no mail is promotional today**: the two digest emails are account mail, not marketing (below), so granting or withdrawing this consent changes nothing that is sent now. The pipeline checks it for any promotional kind added later ([NOTIFICATIONS.md](NOTIFICATIONS.md#classes)). Withdrawing it is `DELETE /api/users/me/consents/MARKETING`.

## Privacy settings (`src/lib/privacy/settings.ts`)

`GET /api/users/me/privacy` returns all of them and `PATCH` changes any subset (audited as `PRIVACY_SETTINGS_CHANGED`):

| Setting | Effect |
| --- | --- |
| `fieldVisibility` | per passport field (`bio`, `headline`, `location`, `website`, `githubUsername`, `twitterUsername`, `linkedinUrl`, `availability`, `builderRole`, `timezone`): `PUBLIC`, `CONNECTIONS` (accepted connection, open match, shared crew or project) or `PRIVATE`; others get `null` for a field they may not see on `GET /api/users/{id}` |
| `hideFromLeaderboards` | off every board and every rank others can see (the entries are moved by a job) |
| `hideFromRecruiters` | out of any recruiter surface; none exists yet, and `recruiterVisible()` in `src/lib/age-policy.ts` is the one place a future one must ask |
| `matchingPaused` | no daily drops, and not shown in anyone else's |
| `invisibleMode` | left out of people search (`GET /api/users`) and discovery (`GET /api/discover`) |
| `whoCanMessage` | `EVERYONE`, `CONNECTIONS` or `NOBODY` may start a direct conversation (`403 MESSAGING_NOT_ALLOWED`); rooms already shared stay open |
| `showActivity` | whether others see the heatmap and the streak |
| `showCardsOnWeb` | "Show my cards on the web": whether the public share images may be drawn for the person. On by default for an adult who was never a minor on the platform; stored off for anyone who was (until they turn it on); never in force for a minor (16 or 17) or an account with no date of birth yet, who cannot turn it on (`400 CARDS_NOT_AVAILABLE`) |

## Export (`src/lib/privacy/export.ts`)

`POST /api/users/me/export` makes a `DataExport` row and queues the job `privacy/export`; an export already being prepared is returned instead of a
second one. The job reads every table in the inventory below through each column that points at the person, leaves out what the inventory redacts,
writes `exports/<user>/<export>.json` to the bucket through the Storage adapter, marks the row `READY` and notifies the person. `GET
/api/users/me/export` returns the latest export with a signed download link that lasts until the file expires, **24 hours** after it was made; after
that it answers `410 EXPORT_EXPIRED` and the retention job deletes the file. In development and the integration suite the "bucket" is the in-memory
stand-in, read back through `GET /api/media/dev-download/{key}` (owner only, and only while the stand-in is in use).

What an export never contains: secrets (password hashes, OAuth tokens, sessions), **who reported, blocked, muted or sparked the person**, the drops in
which they were shown to someone else, who wrote a peer review about them and its private note, internal scores (reliability, risk, the integrity
weights), moderators' identities and notes, and the audit trail. Each table is capped at 10,000 rows per column; an export over it lists the table in
`truncated`.

## Deletion (`src/lib/privacy/delete.ts`, `tombstoneClerkUser` in `src/lib/user-sync.ts`)

`DELETE /api/users/me` needs a session signed in within the last 10 minutes, deletes the Clerk account and then the local data at once; deleting the
Clerk account elsewhere does the same through the webhook. The `User` row is kept, anonymised (`deleted_<id>` names, an `.invalid` address, every
profile field and verification flag cleared, the **date of birth wiped**), because deleting it would cascade through work other people share. Every
other table is handled by its rule in the inventory: private data is deleted, posts and comments are hidden and blanked, Props given are removed and the
scores recomputed, the romance mode is purged, links are cleared, and what other people depend on is kept under the anonymised account.

**The coverage test.** `src/lib/privacy/inventory.test.ts` reads the Prisma schema and fails when a model with a column pointing at `User`, or a column
holding user ids, is missing from the inventory. A new table cannot ship without a decision about what deleting an account does to it and what an
export gives.

## Data inventory

Generated from `DATA_INVENTORY` in `src/lib/privacy/inventory.ts` (the source of truth; this table is a copy of it). Deletion rules: DELETE (rows
removed), SCRUB (hidden and blanked), KEEP (kept under the anonymised account, for the reason given), SET_NULL (link cleared), CUSTOM (a step of its
own in `delete.ts`).

| Table | Deleting the account (per column) | Export | What it is, and why |
| --- | --- | --- | --- |
| User | `id` CUSTOM | REDACTED (without `passwordHash`) | the account: anonymised and marked deleted; the date of birth is wiped |
| Account | `userId` DELETE | REDACTED (without `access_token`, `refresh_token`, `id_token`, `session_state`) | legacy sign-in links (tokens are secrets, never exported) |
| Session | `userId` DELETE | NONE | legacy sessions: secrets |
| Profile | `userId` DELETE | FULL | the passport: bio, links, place, privacy settings |
| UserSkill | `userId` DELETE | FULL | skills on the passport |
| SkillEvidence | `userId` DELETE | FULL | evidence on the passport and the endorsements received on it (endorsements the person gave belong to the endorsed person) |
| Project | `ownerId` KEEP | FULL | projects are shared work: other members and posts point at them |
| ProjectMember | `userId` KEEP | FULL | membership of shared projects |
| ProjectUpdate | `authorId` KEEP | FULL | updates on shared projects |
| Team | `ownerId` KEEP | FULL | crews and squads are shared |
| TeamMember | `userId` KEEP | FULL | membership of shared crews |
| TeamApplication | `userId` DELETE, `invitedById` SET_NULL | FULL | applications and invitations |
| TeamSlot | `filledById` KEEP | FULL | a squad slot the person filled: the squad keeps its shape |
| Hackathon | `submittedById` SET_NULL | FULL | external hackathons the person submitted: public listings |
| HackathonParticipant | `userId` KEEP | FULL | registrations: hackathon history and results |
| HackathonTeamMember | `userId` KEEP | FULL | squad history: other members’ results depend on it |
| ChallengeAttempt | `userId` DELETE | FULL | challenge attempts |
| UserAchievement | `userId` DELETE | FULL | achievements |
| UserCounter | `userId` DELETE | FULL | progress counters |
| ProgressTick | `userId` DELETE | FULL | progress history |
| UserCosmetic | `userId` DELETE | FULL | cosmetics owned |
| XPEvent | `userId` KEEP | FULL | the XP log: leaderboards and season standings are rebuilt from it (a deleted account is left out of every board) |
| SeasonStanding | `userId` KEEP | FULL | final standings of closed seasons: others’ ranks depend on them |
| ReputationEvent | `userId` DELETE | FULL | reputation history |
| Connection | `senderId` DELETE, `receiverId` DELETE | FULL | connections |
| ConversationMember | `userId` KEEP | FULL | conversation membership: the other people keep the conversation |
| Message | `senderId` KEEP | FULL | messages sent: part of the other people’s conversations, shown as from a deleted account (messages received are the senders’ data) |
| MessageReaction | `userId` DELETE | FULL | reactions |
| MessageRead | `userId` DELETE | FULL | read markers |
| Notification | `userId` DELETE | FULL | notifications |
| NotificationPreference | `userId` DELETE | FULL | notification switches |
| PushSubscription | `userId` DELETE | REDACTED (without `p256dh`, `auth`) | browsers registered for web push (the keys the pushes are encrypted to are secrets, never exported) |
| NotificationSettings | `userId` DELETE | FULL | delivery settings: email and push switches, quiet hours, digests |
| ChannelPreference | `userId` DELETE | FULL | which kinds of notification reach the person by email or push |
| NotificationDelivery | `userId` DELETE | REDACTED (without `providerId`) | what was emailed or pushed and when (no content); deleted after 90 days anyway |
| InviteCode | `ownerId` DELETE, `createdById` SET_NULL | FULL (through `ownerId`) | the person’s own invite code (campaign codes belong to the platform; the admin who made one is unlinked) |
| InviteRedemption | `inviteeId` DELETE, `inviterId` SET_NULL | FULL (through `inviteeId`) | which invite code the person joined with (who joined with theirs is other people’s data); an inviter’s deletion unlinks them and keeps the attribution |
| Campus | `createdById` SET_NULL | NONE | a college’s record, managed by admins: reference data, not about a person |
| CampusMembership | `userId` DELETE | REDACTED (without `emailHash`) | the campus the person verified (the campus e-mail address itself is never kept, only a keyed hash that cannot be reversed) |
| CampusVerification | `userId` DELETE | NONE | a campus verification in progress: holds the campus e-mail address until the code is confirmed or expires, then it is erased |
| ActivityDay | `userId` DELETE | FULL | the days (UTC) the person did something of their own: what retention and active counts are made from, kept 25 months |
| Report | `reporterId` KEEP, `reportedId` KEEP | REDACTED (without `reporterId`, `metadata`, `priority`, `snapshot`) | moderation records: kept for safety and legal holds, deleted 2 years after they are resolved; who reported someone is never exported |
| ModerationAction | `moderatorId` KEEP, `subjectUserId` KEEP, `reversedById` KEEP | REDACTED (without `moderatorId`, `reason`, `metadata`, `reversedById`) | moderation decisions: the person sees the category, the note to them and the dates; the moderator and their notes are not exported |
| Appeal | `userId` KEEP, `decidedById` KEEP | REDACTED (without `decidedById`) | appeals: moderation records |
| UserRestriction | `userId` KEEP | FULL | restrictions: moderation records |
| Mute | `muterId` DELETE, `mutedId` DELETE | FULL; only through `muterId` | people the person muted (who muted them is not exported) |
| AuditEvent | `userId` KEEP | NONE | the security audit trail: kept for incident response and legal duties; not part of the export because it names staff and other accounts |
| Verification | `userId` DELETE | FULL | verification records |
| CurrentBuild | `userId` DELETE | FULL | the current build on the passport |
| UserQuest | `userId` DELETE | FULL | quests |
| Activity | `userId` DELETE | FULL | the activity log |
| Block | `blockerId` DELETE, `blockedId` DELETE | FULL; only through `blockerId` | people the person blocked (who blocked them is not exported) |
| LeaderboardEntry | `userId` DELETE | FULL | leaderboard snapshots |
| Subscription | `userId` KEEP | FULL | billing records: kept as tax and accounting law requires |
| ProductEvent | `userId` SET_NULL | FULL | product analytics: the counts stay, the link to the person goes; deleted after 13 months anyway |
| MatchingProfile | `userId` DELETE | FULL | matching preferences |
| Drop | `userId` DELETE, `candidateId` DELETE | REDACTED (without `score`); only through `userId` | daily drops shown to the person (the people shown, and drops where the person was shown to someone, are other people’s) |
| Spark | `fromId` DELETE, `toId` DELETE | REDACTED (without `openerHash`); only through `fromId` | sparks sent (sparks received are the senders’ data, shown in the app as the person’s plan allows) |
| Match | `userAId` CUSTOM, `userBId` CUSTOM, `endedById` KEEP | FULL | matches: open ones are ended; the row stays for the other person’s history |
| RevealRequest | `revokedById` KEEP | NONE | romance photo reveal state: removed with the romance data (CUSTOM via the match) |
| BuildDate | `proposedById` KEEP | NONE | romance build dates (not in use yet): removed with the romance data |
| MediaAsset | `ownerId` CUSTOM | REDACTED (without `key`) | uploads: rows and the objects in the bucket are deleted |
| RomanceProfile | `userId` CUSTOM | FULL | the romance profile and private filters: deleted with photos, drops and reveal state (special-category data) |
| RomanceDrop | `userId` CUSTOM, `candidateId` CUSTOM | REDACTED (without `score`); only through `userId` | romance drops: deleted with the romance data |
| Duo | `userAId` CUSTOM, `userBId` CUSTOM, `requestedById` KEEP, `dissolvedById` KEEP | FULL | romance duos: dissolved with the romance data |
| ShipPost | `authorId` SCRUB, `coAuthorIds` CUSTOM | FULL | posts: hidden and blanked (comments under them keep their thread); the person is taken off others’ posts as a co-author |
| Prop | `userId` CUSTOM | FULL | Props given: deleted, and the posts’ scores recomputed |
| Comment | `authorId` SCRUB | FULL | comments: hidden and blanked, so replies keep their thread |
| Follow | `followerId` DELETE, `followeeId` DELETE | FULL | follows |
| Watch | `userId` DELETE | FULL | watched projects |
| SquadProposal | `requesterId` SET_NULL | FULL | squad builder proposals: shared with the proposed members |
| SquadProposalMember | `userId` DELETE | FULL | seats in proposed squads |
| LfgPost | `authorId` DELETE | FULL | looking-for-group posts |
| TeamChecklistItem | `assigneeId` SET_NULL, `createdById` KEEP | FULL | a squad’s shared checklist |
| TeamIdea | `authorId` KEEP | FULL | a squad’s shared idea board |
| TeamIdeaVote | `userId` KEEP | FULL | votes on a squad’s ideas: the board’s counts stay right |
| CommitmentPledge | `userId` DELETE | FULL | hackathon pledges |
| PeerReview | `reviewerId` CUSTOM, `revieweeId` DELETE | REDACTED (without `reviewerId`, `note`, `integrityWeight`, `counted`) | reviews given stay (teammates’ reliability depends on them) with their private note blanked; reviews received are deleted; who wrote a review is never exported |
| UserReliability | `userId` DELETE | NONE | an internal score, never shown as a number; deleted |
| UserRisk | `userId` DELETE, `overrideById` KEEP | NONE | an internal safety score; deleted (the audit trail keeps its changes) |
| DataExport | `userId` CUSTOM | NONE | export requests: the files and rows are deleted |
| ConsentRecord | `userId` KEEP | FULL | proof of consent and of its withdrawal: kept as the legal record of the basis for past processing |
| Report (resolvedBy) | `resolvedById` KEEP | NONE | the moderator who resolved a report (Report.resolvedById) |
| FeatureFlag | `allowUserIds` CUSTOM, `updatedById` KEEP | NONE | early-access allowlists: the person is taken off every list |
| IntegritySignal | `userId` SET_NULL | NONE | integrity signals: internal; the link to the person is cleared |
| FraudSignal | `memberIds` KEEP, `reviewedById` KEEP | NONE | collusion findings: internal evidence, kept as ids of an anonymised account |

## Retention (`src/lib/privacy/retention.ts`, job `privacy/retention`, nightly 05:15 UTC)

| What | Kept for | How |
| --- | --- | --- |
| Product analytics events (`ProductEvent`) | 13 months | rows deleted in batches |
| Idempotency keys | 24 hours | the expiry on the cache entry itself (`IDEMPOTENCY_TTL_MS`); nothing to sweep |
| Expired drops (`Drop`, status `EXPIRED`) | 90 days after they expired | rows deleted |
| Resolved reports (`RESOLVED` or `DISMISSED`) | 2 years after resolution | rows deleted, with their evidence snapshot |
| Data export files | 24 hours after they were made | object deleted, row marked `EXPIRED` |
| Email and push delivery log (`NotificationDelivery`) | 90 days | rows deleted in batches; no message content is in them |
| Activity days (`ActivityDay`) | 25 months | rows deleted. The metrics built from them hold no person and are kept |
| Campus verifications (`CampusVerification`) | an hour after the code expired | rows deleted, and the campus e-mail address in them with them |
| "Tell me when it opens" for the romance mode (`RomanceInterest`) | 180 days after the person was told (a request nobody has been told about is kept until they withdraw it) | rows deleted. Holds the country and city of the profile when they asked; seen by nobody but the admin metrics, as counts by city of at least 3 people. NEEDS LEGAL REVIEW: wanting a dating mode is personal data, and in some countries more |
| Blocked uploads | the hash, verdict and labels only; the object is deleted at once | needs legal review: some countries require keeping evidence of child sexual abuse material for the authorities for a set period |

Everything else is kept while the account exists and handled by the deletion rules above when it is deleted. The audit trail, moderation records and
consent records are kept as the security and legal record; their retention periods are a launch item for counsel.

## Email and push (Stage 1G)

- **What is sent, to whom.** An email address is sent to Resend to send mail to it; a push goes to the push service of the person's browser, encrypted so only the browser can read it. Nothing
  else about a person is sent: the mail provider also receives the subject and body of each message, which are the notification's own text (see "what leaves" below).
- **What the romance mode sends: nothing but "You have a new message".** Every romance notification, and a message or match in a romance conversation, goes out (by push; by email only if the person
  turned that on) as that one neutral line with the neutral link `/notifications`: no name, no kind of event, no mode name, no count. The unsubscribe link of such an email, its headers, its tags at the provider
  and its footer say nothing about the mode either (`src/lib/notify/policy.ts`, tested). The daily digest counts only non-romance sparks.
- **Account notices say only that there is one.** A moderation decision is emailed and pushed as "You have an account notice", not as what it says.
- **Control.** Per kind and channel, globally, with quiet hours in the person's own zone (`GET/PUT /api/notifications/channels`); one-click unsubscribe in every optional email, per kind and for all, by signed links
  and the `List-Unsubscribe` headers. Account notices cannot be switched off (they are the platform telling a person something about their account), and a bounced address stops them too.
- **Digests are account mail, not marketing.** The daily and weekly digests are on by default and need no consent; each carries a one-click unsubscribe for its kind and for all mail, and is switched off by the digest or email switches. *Treating them as account mail rather than marketing is a legal position: confirm in legal review before launch.* Only promotional mail needs the MARKETING consent, and none exists yet.
- **Bounces.** An address that bounced for good or was reported as spam is suppressed by address (`EmailSuppression`), not by account, and kept after the account is deleted: forgetting a bounced address
  would start mailing a dead mailbox, or a person who complained, again. It holds **the SHA-256 of the lower-cased address** and the reason and nothing else, never the address (a database check refuses anything
  else); it is a legitimate-interest record and the one thing derived from an address that outlives the account. It is not exported (it is not about the person's use of the product).
- **Logs** carry the delivery id and the kind, never an address or the text.

## Search (Stage 1G)

Search shows what the rest of the app shows, to the same people. It leaves out anyone blocked or muted in either direction, deleted, suspended, banned, age-closed or in invisible mode, a person at a high risk
level (unless found by exact username), anything hidden or removed, private projects and posts the viewer may not see; a passport field set to anything but `PUBLIC` is neither searched nor returned (so a
search cannot be used to read a private headline), and no romance data is read. The rules are in the SQL of each query ([SEARCH.md](SEARCH.md)). The text a person types is not stored.

## Share cards (Stage 1G)

A share card (`/api/og/...`) is a public image: anyone with the link can fetch it, signed in or not, and it ends up in link previews. So it shows less than the app:

- **Never**: e-mail, bio, links, location, the date of birth, the romance mode, anything of a private or hidden thing.
- **The switch.** "Show my cards on the web" (`showCardsOnWeb`, `PATCH /api/users/me/privacy`) is on by default for an adult, and turning it off removes every card of the person (passport, their posts, their achievements, and their name on a squad recap) from a fresh request.
- **A minor (16 or 17), or an account with no date of birth yet, has no cards at all**, whatever the switch says; they cannot turn it on. (`cardsAllowed` in `src/lib/age-policy.ts`: the switch is checked in `holderOf`, `src/lib/og/data.ts`.) **Turning 18 does not publish anything.** An account that was under 18 at any point (a minor now, or an account made before the 18th birthday) has the switch **stored off**, and it stays off until the person turns it on themselves: the date writers (`setBirthDate`, the admin correction) store it off (`keepCardsOff`, `src/lib/birth-date.ts`), and the migration `20261024000100_cards_for_former_minors` did the same for existing accounts. A person who joined as an adult is on by default. On the 18th birthday they are told once what the switch is (below).
- **The note on the 18th birthday.** The hourly job `cards/adult-notice` (`src/lib/privacy/cards-notice.ts`) writes one in-app notification (`CARDS_ADULT`, link `/settings/privacy`) to a person who was under 18 on the platform: from the 18th birthday on their own calendar, and not before the UTC calendar the age policy counts in has also reached it, so the note never says "you can turn it on" while the switch still refuses. A job that was down catches up for 7 days. It is keyed `cards:adult` per person, so it is written once; a person who joined as an adult, a deleted account and an account with no date get none. NEEDS LEGAL REVIEW: the wording and the default for former minors.
- **Fields**: the headline and builder role only when they are `PUBLIC` (which in the app means "everyone signed in"); the name is shown only if the fonts can draw it, else the username.
- **No card at all** (the same `404` as for a card that never existed) for an account that is deleted, age-closed, suspended, banned, in invisible mode or at a high risk level; for a post that is not public or
  was hidden or removed; for a squad before its hackathon ends; for an achievement not earned.
- **Squads** name only people who have cards; the rest (minors, people who turned cards off, invisible mode) are counted.
- **Caching.** Browsers and shared caches may keep a card for a day (and serve it a week more while a new one is made). Edits reach people at once through the **versioned address** (`GET /api/og/link`, a hash of the
  `updatedAt` stamps of what the card is drawn from, in `?v=`): a new address is a new thing to every cache. A person who goes private is gone from a fresh request at once, but a copy a cache already holds under an
  older address can live up to that long; a person cannot purge it. This is a trade-off for the cost of drawing.

The cards show "signed-in public" fields to the open web, so the person decides: the switch above, on by default for adults and forced off for minors. *Confirm the default in legal review.*

## Invites and campuses (Stage 1G)

- An **invite code** links two accounts (who joined with whose code). It is kept while both exist; the inviter's deletion unlinks them and keeps the attribution. An invite rejected as suspicious writes an integrity signal
  (account ids, no content) for review.
- A **campus e-mail address** is used once, to send a code, and erased when the code is confirmed or expires (a sweep removes what is left an hour after it expired). The platform keeps only a keyed hash of it,
  which stops one mailbox from verifying two accounts and cannot be reversed. No route returns an address. Minors and accounts of unknown age cannot join a campus.

## Metrics (Stage 1G)

The admin metrics are aggregates (`MetricsSnapshot`: a day, a key, a number); no row names a person, and places with fewer than three people are not reported. They are built from `ActivityDay`
(person and UTC day), which is deleted with the account and after 25 months. The romance mode is in none of them. Definitions: [METRICS.md](METRICS.md).

## What never leaves the platform

Analytics carry no personal data (`src/lib/infra/analytics.ts`: our internal id, and props reduced to plain values under safe names). Logs carry ids,
never names, e-mails or message text (`src/lib/log.ts` replaces sensitive-looking fields). Error reports to Sentry are scrubbed before they leave the process: cookies, authorization headers, request bodies,
query strings, IP addresses, e-mail addresses, phone numbers and token-looking strings are removed, and only our own opaque user id is kept (`src/lib/observability/scrub.ts`, tested). The date of birth is returned to nobody but its owner
([SAFETY.md](SAFETY.md#the-age-policy)). Romance data stays in its own tables ([SAFETY.md](SAFETY.md#the-romance-mode-gating-and-separation)).

## Sub-processors

Clerk (identity), the PostgreSQL host, Upstash (cache), Inngest (jobs), Ably (realtime), the S3-compatible bucket, Resend (email, when configured), the browsers' push services
(Google, Mozilla, Apple, Microsoft: the encrypted payload and the device's push endpoint, when a person registers a browser), PostHog and Sentry when configured,
and the media moderation provider when configured. Each needs a data processing agreement and, for transfers out of the EU or India, a transfer
mechanism: a launch item.
