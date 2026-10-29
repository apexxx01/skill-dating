# Proof: evidence receipts and the evidence engine

Reputation is the product: Passports decide who gets matched and picked for squads, so people will try to fake them. This stage makes evidence
**provable** (signed receipts anybody can check) and **scored** (a strength that honest builders earn and fakers do not), without punishing a
beginner whose project is small. The code is in `src/lib/evidence` and `src/lib/infra/github*.ts`; routes in [API.md](API.md#proof); screens in
[FRONTEND_CONTRACT.md](FRONTEND_CONTRACT.md#passport-proof).

- [Receipts](#receipts): what one is, how it is signed, how to verify one offline
- [The GitHub adapter](#the-github-adapter): auth, budgets, rate limits, conditional requests
- [The engine](#the-engine): what a sync reads, what it writes
- [Strength](#strength): the model, its weights, and the anti-gaming table
- [Co-authorship](#co-authorship) and [disputes](#disputes)
- [Freshness](#freshness)
- [Rewards](#rewards)
- [Privacy and operations](#privacy-and-operations)

## Receipts

An `EvidenceReceipt` is a signed statement of **minimal facts** about one source, captured at one moment.

| Field | What it is |
| --- | --- |
| `id` | 128 random bits in base62, always 22 characters (`src/lib/evidence/receipt-id.ts`). Not a cuid: a cuid carries a time and a counter, so ids would be ordered and guessable. |
| `userId` | the owner. The signed envelope names them by this id (it never changes; a handle can). |
| `source` | `GITHUB` (an enum Stage 1J extends with the proof-of-control providers). |
| `sourceRef` | what the facts are about: `repo:<GitHub repo id>@commit:<sha>` or `repo:<id>@pr:<number>`, followed by `/facts:<first 16 hex of the payload hash>`, so new facts are a new receipt and the same facts are the same one. |
| `sourceUrl` | the canonical GitHub URL of that commit or pull request. |
| `capturedAt`, `factsVersion` | when, and the version of the facts' shape (`FACTS_VERSION`, 1). |
| `facts` | normalised, minimal facts (`src/lib/evidence/facts.ts`): counts, dates, and the GitHub numeric ids of the person and the repository. **Never** a raw payload, a commit message, a file name, an email, or anything about another contributor beyond the repository's total commit count. |
| `payloadHash` | sha256 (hex) of the canonical facts. |
| `kid`, `signature`, `signedAt` | the key and the Ed25519 signature (base64url); null while unsigned. |
| `status`, `lastCheckedAt` | `VALID`, `SOURCE_CHANGED` (the source exists but no longer shows it: history rewritten), `SOURCE_GONE` (deleted or no longer public), `REVOKED` (the account was deleted). |

A receipt's facts never change after it is issued. A recheck changes only its status (and the weight of the evidence it backs).

### Canonical form and signing

The signature covers the **envelope**, in canonical JSON in the style of RFC 8785 (JCS, `src/lib/evidence/canonical.ts`): object members sorted by
their names as UTF-16 code units, no whitespace, strings escaped as `JSON.stringify` escapes them, numbers printed as ECMAScript prints them (`-0` is
`0`), arrays in order. Anything that is not plain JSON is refused rather than guessed at.

```json
{
  "v": 1,
  "id": "4fXq0b2kV9mN1pR7sT3uWy",
  "subject": { "platform": "skill-dating", "userId": "cmabc…" },
  "source": "github",
  "sourceRef": "repo:123456@commit:9f2c…/facts:1a2b3c4d5e6f7a8b",
  "sourceUrl": "https://github.com/owner/name/commit/9f2c…",
  "factsVersion": 1,
  "facts": { "v": 1, "kind": "repo", "repo": { "id": "123456", … }, "author": { "githubId": "42" }, "commits": { … }, … },
  "payloadHash": "…",
  "capturedAt": "2026-10-29T09:00:00.000Z",
  "kid": "2026-11"
}
```

Signing is Ed25519 through `node:crypto` (`src/lib/evidence/signing.ts`).

### Keys and rotation

`RECEIPT_SIGNING_KEYS` is a comma-separated list of `kid=key`:

- `kid=<base64 PKCS#8 DER Ed25519 private key>`: a key that signs. **The first entry signs**, and it must be a private key.
- `kid=pub:<base64url raw public key>`: a retired key kept only so that what it signed still verifies.

Every entry is published, by its public half only, at `GET /api/receipts/keys` (JWKS style, the active key marked). **To rotate:** generate a key, put it
first, keep the old one after it (its `pub:` form is enough), deploy. Old receipts keep verifying with their kid; new ones are signed with the new key.
Dropping a kid from the list makes what it signed unverifiable, so only do that for a compromised key. A setting that does not parse stops the server at
boot, naming the entry, never its value. Generating a key: [DEPLOY.md](DEPLOY.md#receipt-signing-keys).

| Where | Without `RECEIPT_SIGNING_KEYS` |
| --- | --- |
| development, tests, previews | a **fixture** key whose private half is in `signing.ts`, published under the kid `dev-fixture-NOT-FOR-PRODUCTION`: anything it signed proves nothing. |
| production (`requiresProductionConfig`) | **no** signing, never with a key made up at start. Receipts are created **unsigned** (`signature: null`, `signed: false` on their page), the boot prints a warning naming `receipt-signing`, and `/api/health` answers `degraded` with `receipt-signing` in `missingProviders`. Once a key is set, run the job `receipts/sign-backlog` (`POST /api/admin/jobs/receipts/sign-backlog`): it signs every unsigned receipt over its original facts and `capturedAt`, so the signature states exactly what signing at capture would have. |

`/api/health` reports `evidence: { signing: configured|fixture|unsigned, kid, github: server-token|anonymous }`: modes and the public key id, never a key.

### Verifying a receipt offline

Anybody can check a receipt with Node 18 or later, the receipt's JSON (`GET /api/receipts/{id}`) and the key set (`GET /api/receipts/keys`), and
nothing else: no account, no call to us once the two files are saved.

```js
// verify-receipt.mjs: node verify-receipt.mjs receipt.json keys.json
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

// RFC 8785 (JCS) for the values a receipt holds: sorted members, no whitespace, JSON escapes, ECMAScript numbers.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('not JSON')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

const { receipt } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const { keys } = JSON.parse(readFileSync(process.argv[3], 'utf8'))
const { envelope, signature } = receipt
if (!signature) throw new Error('this receipt is not signed yet')
const jwk = keys.find((key) => key.kid === envelope.kid)
if (!jwk) throw new Error(`no key ${envelope.kid} in the key set`)

const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' })
const signed = verify(null, Buffer.from(canonicalize(envelope), 'utf8'), publicKey, Buffer.from(signature, 'base64url'))
const hashed = createHash('sha256').update(canonicalize(envelope.facts), 'utf8').digest('hex') === envelope.payloadHash
console.log(signed && hashed ? `valid: signed by ${envelope.kid}, captured ${envelope.capturedAt}` : 'INVALID')
process.exit(signed && hashed ? 0 : 1)
```

`src/lib/evidence/signing.test.ts` runs this same procedure against tampered facts, a changed subject, another key and a rotated key set, and
`tests/integration/evidence-engine.test.ts` runs it against a receipt the server issued. The signature says the platform saw these facts at that time; the
receipt's `status` says whether the source still shows them.

### Who can see a receipt

`GET /api/receipts/{id}` is public: rate limited per address (60 a minute), cached five minutes with an ETag (304 when unchanged), and the same 404
(`RECEIPT_NOT_FOUND`) whether a receipt never existed or may not be shown, so the address cannot be used to learn which.

| Answer | When |
| --- | --- |
| 200 | the owner is an adult whose passport shows their GitHub handle publicly, with the GITHUB_SYNC consent in force |
| 404 | an id that is not a receipt id; the owner is closed for their age, suspended, banned or in invisible mode; their `githubUsername` field is not `PUBLIC`; they withdrew the GITHUB_SYNC consent; a moderator hid the claim; or they are **not known to be an adult**: the share-card rule ([PRIVACY.md](PRIVACY.md#share-cards-stage-1g)), so a minor's work is not put on the open web and an account with no date of birth is not known to be an adult. A minor still sees all of it on `GET /api/github`. |
| 410 | the receipt was revoked, or the account was deleted (`RECEIPT_REVOKED`) |
| 503 | the `receipts-public` kill switch (`RECEIPTS_PAUSED`); the key set stays up, so copies of receipts can still be verified |

## The GitHub adapter

`src/lib/infra/github.ts` (the interface `GitHubApi` and `HttpGitHub`), `github.memory.ts` (`MemoryGitHub`, answering from fixtures), and
`github.contract.ts` (the behaviour both must have; `github.test.ts` runs it against the memory twin and against `HttpGitHub` over a REST stand-in,
`github.rest-fixture.ts`, built from the same fixtures). **Nothing in a test or in CI reaches GitHub.** The integration server answers from
`tests/integration/fixtures/github.json` (`GITHUB_FIXTURES_FILE`, refused in production).

**Auth**, one `GitHubAuth` per run, from the first source that has one (`resolveGitHubAuth`):

1. the person's own GitHub sign-in token from Clerk: `clerkClient().users.getUserOauthAccessToken(clerkUserId, 'github')` (`@clerk/backend` 2, provider
   id `github` without the deprecated `oauth_` prefix). Fetched per run and **never stored**;
2. the optional server `GITHUB_TOKEN`, for public data;
3. none: anonymous, on a strict budget (GitHub allows 60 unauthenticated calls an hour per address).

A GitHub App installation token (Stage 1K) is one more `GitHubAuthSource` put first in `DEFAULT_AUTH_SOURCES`; callers do not change. Tokens are only
ever put in the `Authorization` header: never logged, never in an error, never in a cached answer's key (the cache key is a hash of a scope and the URL).

**Public repositories only** in this stage: a private repository is skipped even when the person's token could read it.

**Rate limits.** `x-ratelimit-remaining` is read on every answer; below `RATE_LIMIT_RESERVE` (10) the client stops by itself. A 403 or 429 that says the
limit is reached (or carries `Retry-After`) is a `GitHubRateLimitedError` with the reset time: the run stops, records `RATE_LIMITED`, and the next
weekly or manual run carries on. No run sleeps.

**Conditional requests.** Every answer's ETag is kept in the Cache adapter (seven days) with the minimal body; the next request sends `If-None-Match`.
A 304 is refunded to the run's budget (GitHub does not count it against an authenticated limit either), up to a hard ceiling of twice the budget.

**Budgets** (PlatformSetting `evidence.github-budget`, defaults in `strength-config.ts`):

| | Default |
| --- | ---: |
| repositories per sync | 10 |
| recent repositories looked at (besides claimed ones) | 6 |
| API calls per sync (authenticated) | 200 |
| API calls per sync (anonymous) | 40 |
| API calls per person per UTC day | 600 |
| commit pages per repository (100 each) | 3 |
| commits whose files are looked at, per repository | 8 |
| pull requests whose merger is looked up, per repository | 8 |
| upstream pull requests looked at | 5 |

A typical repository costs 12 to 15 calls (languages, a commit page, 8 commit details, contributors, a pull request page and its details, reviews,
releases). `GitHubBudget` throws when a run is spent; the run stops cleanly with `BUDGET`.

**Outbound requests.** The adapter only ever sends GETs to `https://api.github.com`, with paths built from parsed parts (owner, name, a hex sha, a pull
request number), never a URL a person typed; a redirect is followed only if it stays on the API host. A repository link is read by `parseRepoUrl`, which
accepts `https://github.com/<owner>/<name>` and nothing else. The SSRF guard for user links (`src/lib/infra/page-fetch.ts`) is not needed here because no
user-supplied URL is fetched; see [SECURITY.md](SECURITY.md#outbound-requests).

### Identity

`User.githubId` is the immutable GitHub numeric id, set only from the **verified** GitHub external account Clerk reports (`providerUserId`), on sign-in
and on the Clerk webhook (`src/lib/user-sync.ts`). Everything is matched by it, **never** by login or email:

- a run first asks GitHub who the id is today (`GET /user/{id}`), then asks for that login's commits, and keeps only the commits whose author **is that
  id**. A renamed account keeps its evidence; somebody who takes the old login gets none of it; a commit with somebody else's email typed in counts for
  nobody but the account GitHub links the email to;
- the id is unique: two accounts cannot hold it. It is never cleared because Clerk stops reporting it (evidence survives a disconnect); when Clerk gives
  the id to a different account, it moves there (audited `GITHUB_ID_MOVED`), since Clerk lets one GitHub account belong to one Clerk user.

## The engine

`src/lib/evidence/sync.ts`, the job `github/sync`, per person, **debounced** (a request while one queued or started in the last ten minutes is pending
is the same request). It runs when GitHub is connected, when the GITHUB_SYNC consent is given, on `POST /api/github/sync` (three every ten minutes), and
weekly (`github/sync-weekly`, Mondays 06:00 UTC, 500 people a run, those not synced for six days).

1. Nothing without the GITHUB_SYNC consent, a GitHub id, the `evidence-engine` kill switch off, and calls left in the person's day.
2. The repositories: the ones the person **claimed** (a project's or current build's GitHub link, `GITHUB_PROJECT` evidence), then their most recent
   public non-fork repositories, up to the limit.
3. For each, the minimal facts (`collect.ts`) about **this person only**:
   - authored commits (merge commits left out), sorted by kind from a sample's files: new code, modification, tests, docs, trivial
     (lockfile, generated, vendored, minified, whitespace-only);
   - active days, first and last authored dates, a per-day histogram (for burst dampening);
   - commits with `Co-authored-by` trailers (counted, never who);
   - merged pull requests they wrote, split by who merged them (themselves or another maintainer);
   - reviews of other people's pull requests, releases published;
   - languages (each at least 10% of the code, at most three) and topics;
   - fork status and commits after the fork point; whether the repository came from a template;
   - stars at capture (a weak signal only);
   - their share of the repository's commits (from its contributor list).
4. The strength (below), the `GithubRepoEvidence` row, a **receipt** when there is authored work, and `GITHUB_ACTIVITY` skill evidence for the mapped
   skills the person **already has** on their passport. A sync never adds a skill to a profile, and never creates a skill: the language and topic table
   (`skill-map.ts`) only names existing skill slugs, and unknown tags are ignored. Skills a repository suggests that are not on the passport are listed on
   `GET /api/github` (`suggestedSkills`) for the person to add.
5. A claimed repository with **no authored work** is `UNSUPPORTED` ("Claimed, not evidenced: no commits of yours in owner/name"), and so is the person's
   `GITHUB_PROJECT` evidence that points at it. It is shown to its owner with that reason, counts for nothing, is left off the public passport, and is
   **never deleted**. A repository the person did not claim and has no work in is not written at all.
6. Pull requests the person wrote that another maintainer merged into a public repository they do not own get receipts of their own.
7. Collaborations are recomputed for every repository touched; skill freshness is refreshed; the day's calls are added up.

The sync is idempotent: run again with nothing new on GitHub, it issues no receipt and pays nothing.

**Every engine-produced evidence row is backed by receipts**: each `GITHUB_ACTIVITY` row points at its `GithubRepoEvidence`, whose receipts are listed
on `GET /api/github` and whose newest is linked from the passport.

### Rechecks

`receipts/recheck` (02:45 UTC nightly) takes the 60 receipts checked longest ago and asks GitHub, with the server's own access (public data needs nobody's
token), within 150 calls: is the repository still there and public, is the commit still there with the same author, is the pull request still merged.
The receipt's status is set; the weight of the evidence it backs (its newest receipt) follows: `VALID` 1, `SOURCE_CHANGED` 0.6, `SOURCE_GONE` 0.3.
**Nothing is deleted and nobody is penalised**: a force-push or a deleted repository lowers what the evidence counts for, it does not touch XP, a level,
or the account. The owner can recheck one now (`POST /api/receipts/{id}/recheck`, five a minute).

## Strength

`src/lib/evidence/strength.ts`: a pure, deterministic function of the facts and one config, 0 to 100, with the components and a list of reasons a screen
shows ("Counts: 34 authored commits over 34 active days, 6 PRs merged by other maintainers"). All weights live in `strength-config.ts`; the ones an
operator may tune are the PlatformSetting `evidence.strength` (burst threshold, kind weights, the import factor, the beginner floor), audited like the rest.

| Component | Points | Cap |
| --- | --- | ---: |
| authored work | 6 × √(dampened commits × origin share × co-author share × kind weight), and at most 6 per active day | 35 |
| active days | 4 × √(active days, trivial ones left out) | 20 |
| span | 2 × log2(1 + weeks from first to last commit) | 10 |
| tests | 1.5 × √(commits that touched tests) | 5 |
| PRs merged by other maintainers | 5 × √n | 15 |
| PRs merged by themselves | 1 × √n | 3 |
| reviews given | 2 × √n | 8 |
| releases | 1.5 × √n | 5 |
| stars | 1 × log10(1 + stars) | 2 |

Kind weights: new code 1, tests 1, modification 0.8, docs 0.3, trivial 0.05 (0.7 for a repository whose files could not be looked at). Burst dampening:
a day's commits beyond 4 count as log2 of the rest. The beginner floor: at least 3 non-trivial commits over at least 2 days, not an import, never below 20.
An upstream pull request merged by another maintainer is evidence of its own at a fixed 30.

### Attacks and counters

| Attack | Counter | Fixture | Score |
| --- | --- | --- | ---: |
| Fork a popular repository and claim it | forks count only commits after the fork point; none: authored work is zero | `forkWithoutCommits` (40 stars) | 2 |
| Fork and really build on it | the commits after the fork point count in full | `forkWithRealWork` | 55 |
| Script 500 commits in one night | per-day dampening (4, then log2) and at most 6 work points per active day | `burst500OneNight` | 10 |
| Commit lockfile and generated churn | trivial files weigh 0.05 and do not count as active days | `lockfileOnly` | 0 |
| Create a repository from a template and claim it | the template's initial commit does not count | `templateUntouched` / `templateBuiltOn` | 0 / 39 |
| Import a finished codebase in one commit | a first commit with ≥80% of the code and ≤5 commits in all counts a quarter, and gets no floor | `hugeInitialImport` | 8 |
| Ride on co-authors | each commit with N co-author trailers counts 1/(N+1) | `coauthoredHalf` vs `coauthoredNone` | 36 vs 43 |
| Merge your own pull requests | self-merged PRs weigh 1 × √n (cap 3); merged by others 5 × √n (cap 15) | `selfMerged6` vs `externallyMerged6` | 46 vs 55 |
| Buy stars | stars give at most 2 points | `starFarm` (50,000 stars) | 9 |
| Claim somebody else's repository | matched by GitHub id: no authored work is `UNSUPPORTED`, worth 0; others with work there can dispute | integration test | 0 |
| Take over a renamed account's old login | commits are matched by the id, not the login | `collect.test.ts` | 0 |
| A genuine but tiny first project | the beginner floor | `tinyBeginner` (6 commits over 3 days) | 21 |
| (for comparison) a steady, collaborative repository | | `honest` (34 commits, 34 days, 6 PRs merged by others) | 77 |

The fixtures and their scores are pinned in `src/lib/evidence/strength.test.ts`.

### Where strength reaches

- **The passport**: each skill carries `proof` (its strongest engine evidence's strength and weight, repositories, receipts) and the profile a `proof`
  section (repositories, receipts, upstream merges, the three strongest with a receipt link).
- **The weight of skill evidence**: `evidenceWeight` = strength / 100 × source weight × integrity weight; 0 for an UNSUPPORTED or moderator-hidden claim.
- **Matching** (Stage 1L): `evidenceSignals(db, userIds)` in `src/lib/evidence/passport.ts` gives each person's per-skill weight and freshness. It is
  exposed for the scorer; nothing reads it yet, so no match score changes in this stage.
- **Never XP.** Strength does not change any XP amount or level.

## Co-authorship

When two or more members have evidence for the same repository (matched by its numeric id), each one's authored share and active period come from git
(`coauthorship.ts`). Every pair who **both** authored work there gets a `VerifiedCollaboration`: both shares (of the largest commit total either of them
saw), the period both were active (null when they never overlapped), and the receipts behind it. Ids are stored in order (`userAId < userBId`), so the
trust graph (Stage 1N) reads each row as one undirected edge. A pair that no longer holds (a claim hidden, an account deleted) is removed: the receipts
are the record, these rows are derived.

## Disputes

Somebody with verified authored work in a repository can contest another person's claim to it: `POST /api/github/repos/{claimId}/dispute` (the claim ids
are on `GET /api/github` under `otherClaims`, listed only to people with work there). It files an ordinary report, target `EVIDENCE_CLAIM`, reason
`CLAIM_DISPUTE`, priority 250 plus the queue's usual reporter standing and volume ([SAFETY.md](SAFETY.md#the-queue-priorityts-get-apiadminqueue)). A moderator decides with the
existing actions: `HIDE_CONTENT` on the claim takes it out of strength and off the passport and receipt pages, never deleting it (audited
`MODERATION_ACTION`, the person told, appealable for 30 days through `POST /api/appeals`); an overturned appeal or a reversal restores it.

## Freshness

`UserSkill.lastEvidencedAt` is the newest evidence behind a skill: a person's own evidence from when it was verified (or added), engine evidence from the
last authored commit. Endorsements, UNSUPPORTED and hidden claims, and engine evidence while the consent is withdrawn do not count. Freshness decays with
a half-life (PlatformSetting `evidence.freshness`, default 18 months): 1 when just evidenced, 0.5 after one half-life. Labels: `ACTIVE` from 0.68 (about
the first 10 months), `WARM` from 0.3 (to about 31 months), `RUSTY` after. Display and matching weight only: never XP, never a level. On
`GET /api/users/{id}/skills` and the profile's `skills`.

## Rewards

Seasoning, never inflation. A sync pays **no XP for history**: no `EVIDENCE_ADDED` award for engine evidence, no rule per commit, receipt or repository.
The two events it emits (`RECEIPT_VERIFIED`, `UPSTREAM_MERGE_VERIFIED`) pay nothing and only count towards three achievements, whose own XP is paid once
each through `ACHIEVEMENT_EARNED`:

| Achievement | When | XP |
| --- | --- | ---: |
| Receipts | the first receipt of the person's own work | 25 |
| Upstream | the first pull request merged by another maintainer into a public repository the person does not own, created at least 90 days before the merge | 50 |
| Archaeologist (secret) | evidence whose first authored commit is at least five years old | 50 |

So a sync of any size is worth at most 125 XP, ever. Upstream is triggered by somebody else (the merging maintainer), who is not on the platform, so the
trusted-counterparty gate cannot apply; its counters are that the merger is another GitHub id, the repository is public, not the person's, and was
established (90 days old) when it merged. See [GAMIFICATION.md](GAMIFICATION.md#proof-achievements) for the simulation.

## Privacy and operations

- **Consent**: `GITHUB_SYNC` ([PRIVACY.md](PRIVACY.md#consent-srclibprivacyconsentts)), optional, given in settings or the connect flow, withdrawable
  (`DELETE /api/users/me/consents/GITHUB_SYNC`). Withdrawing stops every sync and hides the engine's evidence from the passport, the receipt pages and
  every count; it is kept, and comes back if the consent is given again. A year after a withdrawal that was never reversed, retention deletes it and
  revokes its receipts.
- **Export** includes receipts, repository evidence, the sync state and collaborations. **Deletion** revokes every receipt (facts, source and signature
  removed; the bare id kept so its address answers 410) and deletes the rest; revoked receipts are deleted two years later.
- **Kill switches**: `kill.evidence-engine` (syncs, rechecks and disputes answer 503 `EVIDENCE_ENGINE_PAUSED`; the jobs skip) and `kill.receipts-public`
  (receipt pages answer 503 `RECEIPTS_PAUSED`; the key set stays up). Owner: Trust & Safety lead.
- **Integrity signals**: `EVIDENCE_UNSUPPORTED_CLAIMS` for each unsupported claimant once three or more pile up on one repository, and
  `EVIDENCE_REPEATED_DISPUTES` for someone filing three or more disputes in 30 days. Both feed the risk score like the others.
- **Jobs**: `github/sync`, `github/sync-weekly`, `receipts/recheck`, `receipts/sign-backlog` ([ARCHITECTURE.md](ARCHITECTURE.md#jobs)).
- **Settings**: `evidence.strength`, `evidence.freshness`, `evidence.github-budget` (`PUT /api/admin/settings/{key}`, audited).
