import type { PrismaClient } from '@prisma/client'
import { blockedUserIds } from '@/lib/blocks'
import { loadConsentStates } from '@/lib/privacy/consent'
import { evidenceBudgetSetting } from '@/lib/settings'
import type { ExternalPullFacts, RepoFacts } from './facts'
import { skillSlugsFor } from './skill-map'
import { evidenceWeight, type StrengthResult } from './strength'

// The owner's view of their connected evidence (GET /api/github, the "Connected evidence" settings screen in docs/FRONTEND_CONTRACT.md): the connection and
// consent, the last sync and the day's budget, every repository with its strength explained, its support (an UNSUPPORTED claim with the reason), its
// receipts and its verified collaborators, the pull requests merged upstream, and the skills the repositories suggest that are not on the passport yet.
// Other people's claims to a repository are listed only to someone with authored work in it, who may dispute them.

export async function githubOverview(db: PrismaClient, userId: string) {
  const [user, consents, state, budget, rows, upstream, held] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { githubId: true } }),
    loadConsentStates(db, userId),
    db.githubSyncState.findUnique({ where: { userId } }),
    evidenceBudgetSetting(db),
    db.githubRepoEvidence.findMany({
      where: { userId },
      orderBy: [{ strength: 'desc' }, { fullName: 'asc' }],
      take: 100,
      include: { receipts: { where: { status: { not: 'REVOKED' } }, orderBy: { capturedAt: 'desc' }, take: 5, select: { id: true, status: true, signature: true, capturedAt: true, lastCheckedAt: true } } },
    }),
    db.evidenceReceipt.findMany({ where: { userId, repoEvidenceId: null, status: { not: 'REVOKED' } }, orderBy: { capturedAt: 'desc' }, take: 50, select: { id: true, status: true, signature: true, facts: true, capturedAt: true } }),
    db.userSkill.findMany({ where: { userId }, select: { skill: { select: { slug: true } } } }),
  ])
  const consent = consents.GITHUB_SYNC
  const blocked = new Set(await blockedUserIds(db, userId))
  const repoIds = rows.map((row) => row.repoGithubId)
  const [collaborations, others] = await Promise.all([
    db.verifiedCollaboration.findMany({ where: { repoGithubId: { in: repoIds }, OR: [{ userAId: userId }, { userBId: userId }] }, include: { userA: { select: { id: true, username: true, deletedAt: true } }, userB: { select: { id: true, username: true, deletedAt: true } } } }),
    db.githubRepoEvidence.findMany({ where: { repoGithubId: { in: repoIds }, userId: { not: userId }, claimed: true, user: { deletedAt: null } }, select: { id: true, repoGithubId: true, support: true, moderatedAt: true, user: { select: { id: true, username: true } } } }),
  ])

  const onProfile = new Set(held.map((row) => row.skill.slug))
  const suggested = new Set<string>()
  const repos = rows.map((row) => {
    const facts = row.facts as unknown as RepoFacts
    const breakdown = row.breakdown as unknown as Partial<Pick<StrengthResult, 'components' | 'reasons' | 'flags'>>
    const slugs = skillSlugsFor({ languages: facts.repo?.languages ?? [], topics: facts.repo?.topics ?? [] })
    if (row.support === 'SUPPORTED') for (const slug of slugs) if (!onProfile.has(slug)) suggested.add(slug)
    const mineThere = row.support === 'SUPPORTED' && row.firstAuthoredAt !== null
    return {
      id: row.id,
      repoGithubId: row.repoGithubId,
      fullName: row.fullName,
      url: row.url,
      claimed: row.claimed,
      strength: row.strength,
      weight: evidenceWeight({ strength: row.strength, support: row.support, sourceWeight: row.sourceWeight, moderated: row.moderatedAt !== null }),
      reasons: breakdown.reasons ?? [],
      components: breakdown.components ?? [],
      support: row.support,
      supportReason: row.supportReason,
      sourceWeight: row.sourceWeight,
      moderated: row.moderatedAt !== null,
      authoredShare: row.authoredShare,
      firstAuthoredAt: row.firstAuthoredAt?.toISOString() ?? null,
      lastAuthoredAt: row.lastAuthoredAt?.toISOString() ?? null,
      syncedAt: row.syncedAt.toISOString(),
      skills: slugs,
      receipts: row.receipts.map((receipt) => ({ id: receipt.id, status: receipt.status, signed: receipt.signature !== null, capturedAt: receipt.capturedAt.toISOString(), lastCheckedAt: receipt.lastCheckedAt.toISOString() })),
      collaborators: collaborations
        .filter((pair) => pair.repoGithubId === row.repoGithubId)
        .map((pair) => {
          const mine = pair.userAId === userId
          const other = mine ? pair.userB : pair.userA
          return { other, share: mine ? pair.shareB : pair.shareA, overlapStart: pair.overlapStart?.toISOString() ?? null, overlapEnd: pair.overlapEnd?.toISOString() ?? null }
        })
        .filter((pair) => !pair.other.deletedAt && !blocked.has(pair.other.id))
        .map((pair) => ({ userId: pair.other.id, username: pair.other.username, share: pair.share, overlapStart: pair.overlapStart, overlapEnd: pair.overlapEnd })),
      otherClaims: mineThere
        ? others.filter((other) => other.repoGithubId === row.repoGithubId && !blocked.has(other.user.id)).map((other) => ({ id: other.id, userId: other.user.id, username: other.user.username, support: other.support, moderated: other.moderatedAt !== null }))
        : [],
    }
  })

  return {
    connected: user.githubId !== null,
    consent: { current: consent.current, grantedAt: consent.grantedAt, currentVersion: consent.currentVersion },
    // Withdrawn consent hides all of this from everybody else and from every count; it is kept, and shown here, until the consent is given again or the retention rule removes it.
    visible: consent.current,
    sync: {
      status: state?.status ?? 'IDLE',
      requestedAt: state?.requestedAt?.toISOString() ?? null,
      lastSyncedAt: state?.lastSyncedAt?.toISOString() ?? null,
      authMode: state?.authMode ?? null,
      callsToday: state?.dayKey === new Date().toISOString().slice(0, 10) ? state.callsToday : 0,
      callsPerDay: budget.callsPerDay,
      lastError: state?.lastError ?? null,
    },
    repos,
    upstream: upstream.map((receipt) => {
      const facts = receipt.facts as unknown as ExternalPullFacts
      return { receiptId: receipt.id, fullName: facts.repo?.fullName ?? null, number: facts.pull?.number ?? null, mergedAt: facts.pull?.mergedAt ?? null, status: receipt.status, signed: receipt.signature !== null }
    }),
    suggestedSkills: [...suggested].sort(),
  }
}

export type GithubOverview = Awaited<ReturnType<typeof githubOverview>>
