import type { Prisma, PrismaClient } from '@prisma/client'
import type { RepoFacts } from './facts'

// Co-authorship, verified from history (docs/PROOF.md): when two or more members have evidence for the same repository (matched by its GitHub numeric
// id), each one's authored share and active period come from git, and every pair who both authored work there gets a VerifiedCollaboration with both
// shares, the period both were active, and the receipts behind it. The trust graph (Stage 1N) reads these rows as edges. A claimant with no authored work
// gets no edge (their claim is UNSUPPORTED, sync.ts); when several such claims pile up on one repository, each claimant gets an integrity signal.

type Db = PrismaClient | Prisma.TransactionClient

export interface Claimant {
  userId: string
  authored: number
  /** The repository's total authored commits, as this claimant's sync saw it. */
  total: number
  first: Date | null
  last: Date | null
  receiptId: string | null
}

export interface CollaborationPair {
  userAId: string
  userBId: string
  shareA: number
  shareB: number
  overlapStart: Date | null
  overlapEnd: Date | null
  receiptIds: string[]
}

const round3 = (value: number) => Math.round(value * 1000) / 1000

/** Pure: one pair for every two claimants with authored work, ids in order, shares of the largest total any of them saw. */
export function collaborationPairs(claimants: readonly Claimant[]): CollaborationPair[] {
  const authors = claimants.filter((claimant) => claimant.authored > 0).sort((a, b) => a.userId.localeCompare(b.userId))
  const total = Math.max(1, ...authors.map((claimant) => Math.max(claimant.total, claimant.authored)))
  const pairs: CollaborationPair[] = []
  for (let i = 0; i < authors.length; i++) {
    for (let j = i + 1; j < authors.length; j++) {
      const [a, b] = [authors[i], authors[j]]
      const start = a.first && b.first ? new Date(Math.max(a.first.getTime(), b.first.getTime())) : null
      const end = a.last && b.last ? new Date(Math.min(a.last.getTime(), b.last.getTime())) : null
      const overlaps = start !== null && end !== null && start.getTime() <= end.getTime()
      pairs.push({
        userAId: a.userId,
        userBId: b.userId,
        shareA: round3(a.authored / total),
        shareB: round3(b.authored / total),
        overlapStart: overlaps ? start : null,
        overlapEnd: overlaps ? end : null,
        receiptIds: [a.receiptId, b.receiptId].filter((id): id is string => id !== null),
      })
    }
  }
  return pairs
}

/** Claimants with no authored work on one repository before each of them gets an integrity signal. */
export const UNSUPPORTED_CLAIMS_SIGNAL_AT = 3
export const UNSUPPORTED_CLAIMS_SIGNAL = 'EVIDENCE_UNSUPPORTED_CLAIMS'

/** Recomputes one repository's verified collaborations from every member's evidence for it, and flags a pile-up of unsupported claims. */
export async function recomputeCollaborations(db: Db, repoGithubId: string, now: Date = new Date()): Promise<{ pairs: number; unsupported: number }> {
  const rows = await db.githubRepoEvidence.findMany({
    where: { repoGithubId, moderatedAt: null, user: { deletedAt: null } },
    select: { userId: true, facts: true, claimed: true, support: true, firstAuthoredAt: true, lastAuthoredAt: true, receipts: { where: { status: { not: 'REVOKED' } }, orderBy: { capturedAt: 'desc' }, take: 1, select: { id: true } } },
  })
  const claimants: Claimant[] = rows.map((row) => {
    const facts = row.facts as unknown as RepoFacts
    return { userId: row.userId, authored: row.support === 'SUPPORTED' ? facts.commits?.authored ?? 0 : 0, total: facts.contributors?.total ?? 0, first: row.firstAuthoredAt, last: row.lastAuthoredAt, receiptId: row.receipts[0]?.id ?? null }
  })
  const pairs = collaborationPairs(claimants)
  for (const pair of pairs) {
    const data = { shareA: pair.shareA, shareB: pair.shareB, overlapStart: pair.overlapStart, overlapEnd: pair.overlapEnd, receiptIds: pair.receiptIds, computedAt: now }
    await db.verifiedCollaboration.upsert({ where: { repoGithubId_userAId_userBId: { repoGithubId, userAId: pair.userAId, userBId: pair.userBId } }, create: { repoGithubId, userAId: pair.userAId, userBId: pair.userBId, ...data }, update: data })
  }
  // A pair that no longer holds (a claim hidden, an account deleted, work no longer found) is removed: these rows are derived, the receipts are the record.
  const keep = pairs.map((pair) => `${pair.userAId}:${pair.userBId}`)
  const existing = await db.verifiedCollaboration.findMany({ where: { repoGithubId }, select: { id: true, userAId: true, userBId: true } })
  const stale = existing.filter((row) => !keep.includes(`${row.userAId}:${row.userBId}`)).map((row) => row.id)
  if (stale.length > 0) await db.verifiedCollaboration.deleteMany({ where: { id: { in: stale } } })

  const unsupported = rows.filter((row) => row.claimed && row.support === 'UNSUPPORTED')
  if (unsupported.length >= UNSUPPORTED_CLAIMS_SIGNAL_AT) {
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    for (const row of unsupported) {
      const recent = await db.integritySignal.findFirst({ where: { kind: UNSUPPORTED_CLAIMS_SIGNAL, userId: row.userId, subjectId: repoGithubId, createdAt: { gte: since } }, select: { id: true } })
      if (!recent) await db.integritySignal.create({ data: { kind: UNSUPPORTED_CLAIMS_SIGNAL, userId: row.userId, subjectType: 'GITHUB_REPO', subjectId: repoGithubId, data: { unsupportedClaimants: unsupported.length }, createdAt: now } })
    }
  }
  return { pairs: pairs.length, unsupported: unsupported.length }
}
