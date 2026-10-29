import { Prisma, type PrismaClient } from '@prisma/client'
import { emit, transactWithEvents } from '@/lib/events'
import {
  GitHubBudget,
  GitHubBudgetExceededError,
  GitHubRateLimitedError,
  GitHubUnavailableError,
  openGitHub,
  parseRepoUrl,
  resolveGitHubAuth,
  type GhRepo,
  type GitHubApi,
  type GitHubAuthSource,
} from '@/lib/infra/github'
import { getJobQueue } from '@/lib/infra/jobs'
import { log } from '@/lib/log'
import { isKilled } from '@/lib/ops/kill-switches'
import { loadConsentStates } from '@/lib/privacy/consent'
import { evidenceBudgetSetting, evidenceStrengthSetting } from '@/lib/settings'
import { utcTimestamp } from '@/lib/sql'
import { recomputeCollaborations } from './coauthorship'
import { collectRepoFacts, collectUpstreamPulls, type Person } from './collect'
import { FACTS_VERSION, type RepoFacts } from './facts'
import { refreshLastEvidenced } from './freshness-db'
import { issueReceipt } from './receipts'
import { skillSlugsFor } from './skill-map'
import { externalPullStrength, repoStrength } from './strength'
import { strengthConfigFrom, type BudgetSetting } from './strength-config'

// The GitHub sync (job github/sync): reads one person's public GitHub history into evidence. Triggered when GitHub is connected, when the GITHUB_SYNC
// consent is given, by the person (POST /api/github/sync) and weekly (github/sync-weekly). Debounced: a request while one is queued or running within
// DEBOUNCE_MS is the same request. It never pays XP for history: the only rewards a sync can lead to are three achievements, once each.
//
//   1. nothing without the GITHUB_SYNC consent, a verified GitHub id, the evidence-engine switch off, and calls left in the person's day;
//   2. GitHub is asked who the id is today (so a rename changes nothing), then for the repositories the person CLAIMED (a project's or current build's
//      GitHub link, GITHUB_PROJECT evidence) and their most recent public non-fork repositories, up to the per-sync limit, public only;
//   3. for each: the minimal facts (collect.ts), the strength (strength.ts), the repository evidence row, a receipt when there is authored work, and
//      GITHUB_ACTIVITY skill evidence for the mapped skills the person already has on their passport (a sync never adds skills to a profile);
//   4. a claimed repository with no authored work is UNSUPPORTED ("claimed, not evidenced"), with the reason, and so is the person's GITHUB_PROJECT
//      evidence that points at it; it is shown to its owner and counts for nothing, and is never deleted;
//   5. pull requests merged by other maintainers into repositories the person does not own get receipts of their own (Upstream);
//   6. collaborations are recomputed for every repository touched, skill freshness is refreshed, and the run's calls are added to the day.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export const DEBOUNCE_MS = 10 * 60 * 1000
export const GITHUB_ACTIVITY_TYPE = 'GITHUB_ACTIVITY'
/** Engine evidence rows per skill, apart from the per-skill limit on evidence people add themselves. */
export const MAX_ENGINE_EVIDENCE_PER_SKILL = 20

export type SyncReason = 'connected' | 'consent' | 'manual' | 'weekly'

const dayKeyOf = (now: Date) => now.toISOString().slice(0, 10)

/** Whether the engine's evidence for this person may be shown and counted: the GITHUB_SYNC consent is in force. */
export async function engineEvidenceVisible(db: Db | Tx, userId: string): Promise<boolean> {
  return (await loadConsentStates(db, userId)).GITHUB_SYNC.current
}

/** Queues a sync unless one is already queued or running from the last DEBOUNCE_MS. Returns whether this call queued it. */
export async function requestGithubSync(db: Db, userId: string, reason: SyncReason, now: Date = new Date()): Promise<{ queued: boolean }> {
  const state = await db.githubSyncState.findUnique({ where: { userId } })
  if (state && ['QUEUED', 'RUNNING'].includes(state.status) && state.requestedAt && now.getTime() - state.requestedAt.getTime() < DEBOUNCE_MS) return { queued: false }
  await db.githubSyncState.upsert({ where: { userId }, create: { userId, status: 'QUEUED', requestedAt: now }, update: { status: 'QUEUED', requestedAt: now } })
  await getJobQueue().enqueue('github/sync', { userId, reason }, { id: `github-sync:${userId}:${Math.floor(now.getTime() / DEBOUNCE_MS)}` })
  return { queued: true }
}

export type SyncOutcome =
  | { status: 'paused' | 'no-consent' | 'not-connected' | 'budget' | 'github-account-missing' }
  | { status: 'done' | 'partial' | 'rate-limited'; repos: number; receipts: number; calls: number; authMode: string; stoppedBy: string | null }

/** Claimed repositories: what the person named as theirs anywhere on the platform. owner/name, lowercased, each once. */
export async function claimedRepoNames(db: Db | Tx, userId: string): Promise<string[]> {
  const [projects, build, evidence] = await Promise.all([
    db.project.findMany({ where: { githubUrl: { not: null }, OR: [{ ownerId: userId }, { members: { some: { userId } } }] }, select: { githubUrl: true }, take: 100 }),
    db.currentBuild.findUnique({ where: { userId }, select: { githubUrl: true } }),
    db.skillEvidence.findMany({ where: { userId, type: 'GITHUB_PROJECT', url: { not: null } }, select: { url: true }, take: 200 }),
  ])
  const names = [...projects.map((p) => p.githubUrl), build?.githubUrl, ...evidence.map((e) => e.url)].map((url) => parseRepoUrl(url)?.fullName.toLowerCase()).filter((name): name is string => Boolean(name))
  return [...new Set(names)]
}

interface Candidate {
  repo: GhRepo
  claimed: boolean
}

async function candidates(api: GitHubApi, person: Person, claimed: string[], budget: BudgetSetting): Promise<Candidate[]> {
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const name of claimed) {
    if (out.length >= budget.reposPerSync) break
    const repo = await api.repoByName(name)
    if (!repo || repo.private || seen.has(repo.id)) continue
    seen.add(repo.id)
    out.push({ repo, claimed: true })
  }
  if (out.length < budget.reposPerSync && budget.recentRepos > 0) {
    for (const listed of await api.ownedRepos(person.login, budget.recentRepos)) {
      if (out.length >= budget.reposPerSync) break
      if (listed.fork || listed.private || seen.has(listed.id)) continue
      // Lists do not say whether a repository came from a template; the repository does.
      const repo = await api.repoById(listed.id)
      if (!repo || repo.private) continue
      seen.add(repo.id)
      out.push({ repo, claimed: false })
    }
  }
  return out
}

const unsupportedReason = (fullName: string) => `Claimed, not evidenced: no commits of yours in ${fullName}`

/** Writes one repository's evidence in one transaction. Returns the receipt id when one was issued. */
async function writeRepoEvidence(db: Db, userId: string, candidate: Candidate, facts: RepoFacts, headSha: string | null, score: ReturnType<typeof repoStrength>, now: Date): Promise<{ receiptId: string | null; repoGithubId: string } | null> {
  const authored = facts.commits.authored
  // A repository the person did not claim and has no work in is not evidence of anything: nothing is written for it.
  if (authored === 0 && !candidate.claimed) return null
  const supported = authored > 0
  const fullName = candidate.repo.fullName
  const { value } = await transactWithEvents(db, async (tx) => {
    const data = {
      fullName,
      url: candidate.repo.htmlUrl,
      facts: facts as unknown as Prisma.InputJsonValue,
      strength: supported ? score.score : 0,
      breakdown: { components: score.components, reasons: score.reasons, flags: score.flags } as unknown as Prisma.InputJsonValue,
      support: supported ? ('SUPPORTED' as const) : ('UNSUPPORTED' as const),
      supportReason: supported ? null : unsupportedReason(fullName),
      authoredShare: facts.contributors.total > 0 ? Math.round((facts.contributors.authored / facts.contributors.total) * 1000) / 1000 : null,
      firstAuthoredAt: facts.commits.first ? new Date(facts.commits.first) : null,
      lastAuthoredAt: facts.commits.last ? new Date(facts.commits.last) : null,
      syncedAt: now,
    }
    const existing = await tx.githubRepoEvidence.findUnique({ where: { userId_repoGithubId: { userId, repoGithubId: candidate.repo.id } }, select: { id: true, claimed: true } })
    const row = existing
      ? await tx.githubRepoEvidence.update({ where: { id: existing.id }, data: { ...data, claimed: existing.claimed || candidate.claimed } })
      : await tx.githubRepoEvidence.create({ data: { ...data, userId, repoGithubId: candidate.repo.id, claimed: candidate.claimed } })

    // The person's own GITHUB_PROJECT evidence for this repository is marked the same way.
    const own = await tx.skillEvidence.findMany({ where: { userId, type: 'GITHUB_PROJECT', url: { not: null } }, select: { id: true, url: true } })
    const pointing = own.filter((e) => parseRepoUrl(e.url)?.fullName.toLowerCase() === fullName.toLowerCase()).map((e) => e.id)
    if (pointing.length > 0) await tx.skillEvidence.updateMany({ where: { id: { in: pointing } }, data: { support: data.support, supportReason: data.supportReason } })

    let receiptId: string | null = null
    if (supported && headSha) {
      const { receipt, created } = await issueReceipt(tx, { userId, repoEvidenceId: row.id, sourceRef: `repo:${candidate.repo.id}@commit:${headSha}`, sourceUrl: `${candidate.repo.htmlUrl}/commit/${headSha}`, factsVersion: FACTS_VERSION, facts: facts as unknown as Record<string, unknown>, capturedAt: now })
      receiptId = receipt.id
      if (created) await emit(tx, 'RECEIPT_VERIFIED', { userId, receiptId: receipt.id, firstAuthoredAt: facts.commits.first })
    }

    // Skill evidence for the mapped skills the person has (never new skills, and never skills added to their profile).
    const slugs = skillSlugsFor({ languages: facts.repo.languages, topics: facts.repo.topics })
    const held = slugs.length ? await tx.userSkill.findMany({ where: { userId, skill: { slug: { in: slugs }, isActive: true } }, select: { skillId: true } }) : []
    const already = await tx.skillEvidence.findMany({ where: { repoEvidenceId: row.id }, select: { id: true, skillId: true } })
    await tx.skillEvidence.updateMany({ where: { repoEvidenceId: row.id }, data: { support: data.support, supportReason: data.supportReason, verifiedAt: supported ? now : null, url: candidate.repo.htmlUrl, title: `${fullName} on GitHub`.slice(0, 200) } })
    if (supported) {
      for (const { skillId } of held) {
        if (already.some((e) => e.skillId === skillId)) continue
        const count = await tx.skillEvidence.count({ where: { userId, skillId, type: GITHUB_ACTIVITY_TYPE } })
        if (count >= MAX_ENGINE_EVIDENCE_PER_SKILL) continue
        await tx.skillEvidence.create({ data: { userId, skillId, type: GITHUB_ACTIVITY_TYPE, title: `${fullName} on GitHub`.slice(0, 200), url: candidate.repo.htmlUrl, repoEvidenceId: row.id, support: 'SUPPORTED', verifiedAt: now, metadata: { repoGithubId: candidate.repo.id } } })
      }
    }
    return { receiptId, repoGithubId: candidate.repo.id }
  })
  return value
}

export interface SyncDeps {
  authSources?: readonly GitHubAuthSource[]
}

/** The job github/sync. Idempotent: running it again with nothing new on GitHub issues no new receipts and changes nothing but the times. */
export async function runGithubSync(db: Db, userId: string, now: Date = new Date(), deps: SyncDeps = {}): Promise<SyncOutcome> {
  const finish = (status: string, data: Prisma.GithubSyncStateUncheckedUpdateInput = {}) => db.githubSyncState.upsert({ where: { userId }, create: { userId, status, ...(data as object) }, update: { status, ...data } })
  if (await isKilled(db, 'evidence_engine')) {
    await finish('IDLE')
    return { status: 'paused' }
  }
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, clerkId: true, githubId: true, deletedAt: true } })
  if (!user || user.deletedAt || !user.githubId) {
    if (user) await finish('IDLE')
    return { status: 'not-connected' }
  }
  if (!(await engineEvidenceVisible(db, userId))) {
    await finish('IDLE')
    return { status: 'no-consent' }
  }

  const settings = await evidenceBudgetSetting(db)
  const config = strengthConfigFrom(await evidenceStrengthSetting(db))
  const state = await db.githubSyncState.findUnique({ where: { userId } })
  const dayKey = dayKeyOf(now)
  const usedToday = state?.dayKey === dayKey ? state.callsToday : 0
  if (usedToday >= settings.callsPerDay) {
    await finish('BUDGET', { dayKey, callsToday: usedToday })
    return { status: 'budget' }
  }

  const auth = await resolveGitHubAuth({ userId, clerkId: user.clerkId }, deps.authSources)
  const perSync = auth.mode === 'anonymous' ? settings.anonymousCallsPerSync : settings.callsPerSync
  const budget = new GitHubBudget(Math.min(perSync, settings.callsPerDay - usedToday))
  const { api } = openGitHub(auth, budget)
  await finish('RUNNING', { startedAt: now, authMode: auth.mode, dayKey, callsToday: usedToday })

  let repos = 0
  let receipts = 0
  let stoppedBy: string | null = null
  const touched = new Set<string>()
  try {
    const who = await api.userById(user.githubId)
    if (!who) {
      await finish('FAILED', { lastError: 'github-account-missing', dayKey, callsToday: usedToday + budget.used, lastCalls: budget.used })
      return { status: 'github-account-missing' }
    }
    const person: Person = { githubId: user.githubId, login: who.login }
    for (const candidate of await candidates(api, person, await claimedRepoNames(db, userId), settings)) {
      const { facts, headSha } = await collectRepoFacts(api, candidate.repo, person, settings)
      const written = await writeRepoEvidence(db, userId, candidate, facts, headSha, repoStrength(facts, config), now)
      if (!written) continue
      repos += 1
      touched.add(written.repoGithubId)
      if (written.receiptId) receipts += 1
    }
    for (const upstream of await collectUpstreamPulls(api, person, settings)) {
      await transactWithEvents(db, async (tx) => {
        const { receipt, created } = await issueReceipt(tx, { userId, repoEvidenceId: null, sourceRef: `repo:${upstream.facts.repo.id}@pr:${upstream.facts.pull.number}`, sourceUrl: `${upstream.repoHtmlUrl}/pull/${upstream.facts.pull.number}`, factsVersion: FACTS_VERSION, facts: { ...upstream.facts, strength: externalPullStrength(upstream.facts, config).score } as unknown as Record<string, unknown>, capturedAt: now })
        receipts += 1
        if (created) {
          await emit(tx, 'RECEIPT_VERIFIED', { userId, receiptId: receipt.id, firstAuthoredAt: null })
          if (upstream.established) await emit(tx, 'UPSTREAM_MERGE_VERIFIED', { userId, receiptId: receipt.id })
        }
      })
    }
  } catch (error) {
    if (error instanceof GitHubBudgetExceededError) stoppedBy = 'budget'
    else if (error instanceof GitHubRateLimitedError) stoppedBy = 'rate-limited'
    else if (error instanceof GitHubUnavailableError) stoppedBy = 'github-unavailable'
    else {
      await finish('FAILED', { lastError: 'internal', dayKey, callsToday: usedToday + budget.used, lastCalls: budget.used })
      throw error
    }
    log.info('github sync stopped early', { userId, stoppedBy, calls: budget.used })
  }

  for (const repoGithubId of touched) await recomputeCollaborations(db, repoGithubId, now)
  await refreshLastEvidenced(db, userId)
  const status = stoppedBy === 'rate-limited' ? 'RATE_LIMITED' : stoppedBy ? 'BUDGET' : 'DONE'
  await finish(status, { lastSyncedAt: now, dayKey, callsToday: usedToday + budget.used, lastCalls: budget.used, lastError: stoppedBy })
  return { status: stoppedBy === 'rate-limited' ? 'rate-limited' : stoppedBy ? 'partial' : 'done', repos, receipts, calls: budget.used, authMode: auth.mode, stoppedBy }
}

/** People synced per weekly run, and how long since their last sync before they are due. */
export const WEEKLY_BATCH = 500
const WEEK_MS = 6 * 24 * 60 * 60 * 1000

/** The weekly dispatch (job github/sync-weekly): queues a sync for everyone with GitHub connected and the consent given who was not synced this week. */
export async function runWeeklyGithubSync(db: Db, now: Date = new Date()): Promise<{ queued: number }> {
  if (await isKilled(db, 'evidence_engine')) return { queued: 0 }
  const due = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT u."id" FROM "User" u
    LEFT JOIN "GithubSyncState" s ON s."userId" = u."id"
    WHERE u."githubId" IS NOT NULL AND u."deletedAt" IS NULL
      AND (s."lastSyncedAt" IS NULL OR s."lastSyncedAt" < ${utcTimestamp(new Date(now.getTime() - WEEK_MS))})
      AND EXISTS (
        SELECT 1 FROM "ConsentRecord" c WHERE c."userId" = u."id" AND c."type" = 'GITHUB_SYNC' AND c."withdrawnAt" IS NULL
          AND c."grantedAt" = (SELECT MAX(c2."grantedAt") FROM "ConsentRecord" c2 WHERE c2."userId" = u."id" AND c2."type" = 'GITHUB_SYNC'))
    ORDER BY s."lastSyncedAt" ASC NULLS FIRST
    LIMIT ${WEEKLY_BATCH}`)
  let queued = 0
  for (const { id } of due) if ((await requestGithubSync(db, id, 'weekly', now)).queued) queued += 1
  return { queued }
}
