import { Prisma, type PrismaClient } from '@prisma/client'
import { recordActivity } from '@/lib/activity'
import { grantAchievement } from '@/lib/achievements'
import { blockRelation } from '@/lib/blocks'

type Db = PrismaClient | Prisma.TransactionClient

// Types a client may create. CHALLENGE and CONNECTED_PROFILE are produced by
// the platform, PEER_ENDORSEMENT only by the endorse endpoint; accepting any of
// them from a client would let a user forge verification or endorsements.
export const USER_EVIDENCE_TYPES = ['GITHUB_PROJECT', 'PORTFOLIO', 'CERTIFICATION', 'CONTRIBUTION'] as const

export const MAX_EVIDENCE_PER_SKILL = 20

export const ENDORSEMENT_TYPE = 'PEER_ENDORSEMENT'

export const evidenceUserSelect = { id: true, name: true, username: true, image: true, headline: true } as const

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// Transaction-scoped advisory lock: serialises writers that share a key
// without needing a unique constraint (the schema has no endorsement table).
// Released automatically at commit/rollback.
export async function lockKey(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

const endorsementOf = (evidenceId: string): Prisma.SkillEvidenceWhereInput => ({
  type: ENDORSEMENT_TYPE,
  metadata: { path: ['endorsedEvidenceId'], equals: evidenceId },
})

const endorsementBy = (evidenceId: string, endorserId: string): Prisma.SkillEvidenceWhereInput => ({
  type: ENDORSEMENT_TYPE,
  AND: [
    { metadata: { path: ['endorsedEvidenceId'], equals: evidenceId } },
    { metadata: { path: ['endorserId'], equals: endorserId } },
  ],
})

export function countEndorsements(db: Db, evidenceId: string) {
  return db.skillEvidence.count({ where: endorsementOf(evidenceId) })
}

// Endorsement totals and "did the caller endorse it" for a page of evidence in
// one grouped query rather than one per row.
export async function endorsementSummaries(
  db: Db,
  evidenceIds: string[],
  viewerId: string
): Promise<Map<string, { count: number; byViewer: boolean }>> {
  const summaries = new Map<string, { count: number; byViewer: boolean }>()
  if (evidenceIds.length === 0) return summaries

  const rows = await db.$queryRaw<{ evidence_id: string; total: bigint; by_viewer: boolean }[]>`
    SELECT "metadata"->>'endorsedEvidenceId' AS evidence_id,
           COUNT(*) AS total,
           BOOL_OR("metadata"->>'endorserId' = ${viewerId}) AS by_viewer
    FROM "SkillEvidence"
    WHERE "type" = ${ENDORSEMENT_TYPE}
      AND "metadata"->>'endorsedEvidenceId' = ANY(${evidenceIds}::text[])
    GROUP BY 1
  `
  for (const row of rows) {
    summaries.set(row.evidence_id, { count: Number(row.total), byViewer: row.by_viewer })
  }
  return summaries
}

export type EndorseOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'self' }
  | { outcome: 'blocked_by_me' }
  | { outcome: 'blocked_by_them' }
  | { outcome: 'created' | 'exists'; endorsementCount: number }

/**
 * The only place one user acts on another user's evidence. Any rule that
 * restricts who may endorse whom belongs here.
 *
 * At most one endorsement per (endorser, evidence) is enforced by a
 * transaction-scoped advisory lock on that pair plus a check inside the lock,
 * since the table cannot carry a unique constraint over the metadata. The
 * owner's activity entry, notification and achievement fire only the FIRST
 * time a given endorser ever endorses a given piece of evidence: the activity
 * row written then doubles as the durable record, so endorse -> unendorse ->
 * endorse cannot be used to spam the owner.
 */
export async function endorseEvidence(
  prisma: PrismaClient,
  params: { endorserId: string; endorserName: string; evidenceId: string }
): Promise<EndorseOutcome> {
  const { endorserId, endorserName, evidenceId } = params

  return prisma.$transaction(async (tx) => {
    const evidence = await tx.skillEvidence.findUnique({
      where: { id: evidenceId },
      select: { id: true, userId: true, skillId: true, type: true, title: true },
    })
    if (!evidence || evidence.type === ENDORSEMENT_TYPE) return { outcome: 'not_found' as const }
    if (evidence.userId === endorserId) return { outcome: 'self' as const }

    const relation = await blockRelation(tx, endorserId, evidence.userId)
    if (relation === 'BLOCKED_BY_ME') return { outcome: 'blocked_by_me' as const }
    if (relation === 'BLOCKED_BY_THEM') return { outcome: 'blocked_by_them' as const }

    await lockKey(tx, `evidence-endorse:${evidenceId}:${endorserId}`)

    const existing = await tx.skillEvidence.findFirst({
      where: endorsementBy(evidenceId, endorserId),
      select: { id: true },
    })
    if (existing) {
      return { outcome: 'exists' as const, endorsementCount: await countEndorsements(tx, evidenceId) }
    }

    await tx.skillEvidence.create({
      data: {
        userId: evidence.userId,
        skillId: evidence.skillId,
        type: ENDORSEMENT_TYPE,
        title: `Peer endorsement: ${evidence.title}`.slice(0, 200),
        metadata: { endorsedEvidenceId: evidenceId, endorserId },
      },
    })

    const alreadyRecorded = await tx.activity.findFirst({
      where: {
        userId: evidence.userId,
        type: 'SKILL_EVIDENCE_ENDORSED',
        AND: [
          { metadata: { path: ['evidenceId'], equals: evidenceId } },
          { metadata: { path: ['endorserId'], equals: endorserId } },
        ],
      },
      select: { id: true },
    })

    if (!alreadyRecorded) {
      await recordActivity(tx, evidence.userId, 'SKILL_EVIDENCE_ENDORSED', `Your evidence "${evidence.title}" was endorsed`, {
        metadata: { evidenceId, endorserId },
      })
      await grantAchievement(tx, evidence.userId, 'endorsed')
      await tx.notification.create({
        data: {
          userId: evidence.userId,
          type: 'SYSTEM',
          title: 'New endorsement',
          message: `${endorserName} endorsed your evidence "${evidence.title}"`,
          metadata: { kind: 'SKILL_EVIDENCE_ENDORSED', evidenceId, endorserId },
        },
      })
    }

    return { outcome: 'created' as const, endorsementCount: await countEndorsements(tx, evidenceId) }
  })
}

export type UnendorseOutcome = { outcome: 'not_found' } | { outcome: 'ok'; endorsementCount: number }

export async function unendorseEvidence(
  prisma: PrismaClient,
  params: { endorserId: string; evidenceId: string }
): Promise<UnendorseOutcome> {
  const { endorserId, evidenceId } = params

  return prisma.$transaction(async (tx) => {
    const evidence = await tx.skillEvidence.findUnique({
      where: { id: evidenceId },
      select: { id: true, type: true },
    })
    if (!evidence || evidence.type === ENDORSEMENT_TYPE) return { outcome: 'not_found' as const }

    await lockKey(tx, `evidence-endorse:${evidenceId}:${endorserId}`)
    await tx.skillEvidence.deleteMany({ where: endorsementBy(evidenceId, endorserId) })

    return { outcome: 'ok' as const, endorsementCount: await countEndorsements(tx, evidenceId) }
  })
}

// Deleting evidence also removes the endorsements that point at it, so they
// do not linger on the owner's profile as orphans.
export async function deleteEvidenceWithEndorsements(prisma: PrismaClient, evidenceId: string) {
  await prisma.$transaction([
    prisma.skillEvidence.deleteMany({ where: endorsementOf(evidenceId) }),
    prisma.skillEvidence.delete({ where: { id: evidenceId } }),
  ])
}
