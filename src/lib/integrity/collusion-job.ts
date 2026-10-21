import { Prisma, type PrismaClient } from '@prisma/client'
import { log } from '@/lib/log'
import { utcTimestamp } from '@/lib/sql'
import { recomputeReliability } from '@/lib/squads/peer-review'
import { COLLUSION_CONFIG, detectCollusion, weightFor, type AccountFacts, type Cluster, type Interaction } from './collusion'

// The nightly collusion run (job `integrity/collusion`): loads the last 30 days of interactions, finds the clusters (collusion.ts), and for each one
// writes or updates its FraudSignal and lowers the weight of what the members gave EACH OTHER in the window. Nothing is deleted and nobody is banned:
// a lower weight means an endorsement counts less toward the romance inbox gate, a Prop adds less to a post's score, a peer review moves reliability
// less. Dismissing a signal (dismissFraudSignal) restores exactly the rows it lowered.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export const FRAUD_SIGNAL_TYPE = 'COLLUSION_RING'

const DAY_MS = 24 * 60 * 60 * 1000
const STRONG_LEVELS = ['PHONE', 'GITHUB', 'PORTFOLIO', 'ORGANIZATION', 'IDENTITY'] as const

export interface AffectedRows {
  props: string[]
  endorsements: string[]
  peerReviews: string[]
}

/** Every interaction in the window, as directed edges. */
export async function loadInteractions(db: Db, since: Date): Promise<Interaction[]> {
  const [endorsements, props, connections, reviews, accepts] = await Promise.all([
    db.$queryRaw<{ from: string | null; to: string }[]>`
      SELECT "metadata"->>'endorserId' AS "from", "userId" AS "to" FROM "SkillEvidence"
      WHERE "type" = 'PEER_ENDORSEMENT' AND "createdAt" >= ${utcTimestamp(since)}`,
    db.$queryRaw<{ from: string; to: string }[]>`
      SELECT p."userId" AS "from", s."authorId" AS "to" FROM "Prop" p JOIN "ShipPost" s ON s."id" = p."postId" WHERE p."createdAt" >= ${utcTimestamp(since)}`,
    db.connection.findMany({ where: { status: 'ACCEPTED', updatedAt: { gte: since } }, select: { senderId: true, receiverId: true } }),
    db.peerReview.findMany({ where: { createdAt: { gte: since } }, select: { reviewerId: true, revieweeId: true } }),
    db.teamApplication.findMany({ where: { status: 'ACCEPTED', updatedAt: { gte: since } }, select: { userId: true, invitedById: true, team: { select: { ownerId: true } } } }),
  ])
  const edges: Interaction[] = []
  for (const row of endorsements) if (row.from) edges.push({ from: row.from, to: row.to, kind: 'ENDORSEMENT' })
  for (const row of props) edges.push({ from: row.from, to: row.to, kind: 'PROP' })
  for (const row of connections) {
    edges.push({ from: row.senderId, to: row.receiverId, kind: 'CONNECTION' }, { from: row.receiverId, to: row.senderId, kind: 'CONNECTION' })
  }
  for (const row of reviews) edges.push({ from: row.reviewerId, to: row.revieweeId, kind: 'PEER_REVIEW' })
  // An invitation is accepted by the invitee (toward the inviter); an application by the team's owner (toward the applicant).
  for (const row of accepts) edges.push(row.invitedById ? { from: row.userId, to: row.invitedById, kind: 'TEAM_ACCEPT' } : { from: row.team.ownerId, to: row.userId, kind: 'TEAM_ACCEPT' })
  return edges
}

export async function loadAccountFacts(db: Db, ids: readonly string[]): Promise<Map<string, AccountFacts>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const [users, shipped, verified] = await Promise.all([
    db.user.findMany({ where: { id: { in: unique } }, select: { id: true, createdAt: true, verificationLevel: true } }),
    db.project.groupBy({ by: ['ownerId'], where: { ownerId: { in: unique }, status: 'SHIPPED' }, _count: { _all: true } }),
    db.skillEvidence.groupBy({ by: ['userId'], where: { userId: { in: unique }, verifiedAt: { not: null }, type: { not: 'PEER_ENDORSEMENT' } }, _count: { _all: true } }),
  ])
  const proof = new Map<string, number>()
  for (const row of shipped) proof.set(row.ownerId, (proof.get(row.ownerId) ?? 0) + row._count._all)
  for (const row of verified) proof.set(row.userId, (proof.get(row.userId) ?? 0) + row._count._all)
  return new Map(
    users.map((user) => [
      user.id,
      { createdAt: user.createdAt, strongVerification: (STRONG_LEVELS as readonly string[]).includes(user.verificationLevel), proofCount: proof.get(user.id) ?? 0 },
    ])
  )
}

/** The rows inside a cluster in the window: what members gave each other. */
async function rowsInside(tx: Tx, members: string[], since: Date): Promise<AffectedRows> {
  const [props, endorsements, peerReviews] = await Promise.all([
    tx.$queryRaw<{ id: string }[]>`
      SELECT p."id" FROM "Prop" p JOIN "ShipPost" s ON s."id" = p."postId"
      WHERE p."createdAt" >= ${utcTimestamp(since)} AND p."userId" = ANY(${members}::text[]) AND s."authorId" = ANY(${members}::text[])`,
    tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "SkillEvidence" WHERE "type" = 'PEER_ENDORSEMENT' AND "createdAt" >= ${utcTimestamp(since)}
        AND "userId" = ANY(${members}::text[]) AND "metadata"->>'endorserId' = ANY(${members}::text[])`,
    tx.peerReview.findMany({ where: { createdAt: { gte: since }, reviewerId: { in: members }, revieweeId: { in: members } }, select: { id: true } }),
  ])
  return { props: props.map((r) => r.id), endorsements: endorsements.map((r) => r.id), peerReviews: peerReviews.map((r) => r.id) }
}

/** A post's score from its Props: each Prop's weight times its integrity weight. */
export async function recomputePropsScore(tx: Tx, postIds: readonly string[]): Promise<void> {
  for (const postId of new Set(postIds)) {
    await tx.$executeRaw`
      UPDATE "ShipPost" SET "propsScore" = COALESCE((SELECT ROUND(SUM("weight" * "integrityWeight")::numeric, 2) FROM "Prop" WHERE "postId" = ${postId}), 0)
      WHERE "id" = ${postId}`
  }
}

/** Sets the integrity weight of the given rows, and recomputes what depends on them (post scores, reliability). */
export async function applyWeights(tx: Tx, rows: AffectedRows, weight: number, now: Date): Promise<void> {
  if (rows.props.length > 0) {
    await tx.prop.updateMany({ where: { id: { in: rows.props } }, data: { integrityWeight: weight } })
    const posts = await tx.prop.findMany({ where: { id: { in: rows.props } }, select: { postId: true } })
    await recomputePropsScore(tx, posts.map((p) => p.postId))
  }
  if (rows.endorsements.length > 0) await tx.skillEvidence.updateMany({ where: { id: { in: rows.endorsements } }, data: { integrityWeight: weight } })
  if (rows.peerReviews.length > 0) {
    await tx.peerReview.updateMany({ where: { id: { in: rows.peerReviews } }, data: { integrityWeight: weight } })
    const reviewees = await tx.peerReview.findMany({ where: { id: { in: rows.peerReviews } }, select: { revieweeId: true }, distinct: ['revieweeId'] })
    for (const row of reviewees) await recomputeReliability(tx, row.revieweeId, now)
  }
}

const union = (a: AffectedRows, b: AffectedRows): AffectedRows => ({
  props: [...new Set([...a.props, ...b.props])],
  endorsements: [...new Set([...a.endorsements, ...b.endorsements])],
  peerReviews: [...new Set([...a.peerReviews, ...b.peerReviews])],
})

export function readAffected(value: Prisma.JsonValue): AffectedRows {
  const v = (value ?? {}) as Partial<AffectedRows>
  return { props: v.props ?? [], endorsements: v.endorsements ?? [], peerReviews: v.peerReviews ?? [] }
}

async function recordCluster(db: Db, cluster: Cluster, since: Date, now: Date, accounts: Map<string, AccountFacts>): Promise<'created' | 'updated' | 'skipped'> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'fraud:' + cluster.fingerprint}, 0))`
      const existing = await tx.fraudSignal.findUnique({ where: { type_fingerprint: { type: FRAUD_SIGNAL_TYPE, fingerprint: cluster.fingerprint } } })
      // A person looked at this group and disagreed: respect that.
      if (existing?.status === 'DISMISSED') return 'skipped'
      const rows = await rowsInside(tx, cluster.memberIds, since)
      const affected = existing ? union(readAffected(existing.affected), rows) : rows
      const evidence = {
        counts: cluster.counts,
        density: cluster.density,
        weakShare: cluster.weakShare,
        intensity: cluster.intensity,
        members: cluster.memberIds.map((id) => {
          const facts = accounts.get(id)
          return { id, accountAgeDays: facts ? Math.floor((now.getTime() - facts.createdAt.getTime()) / DAY_MS) : null, strongVerification: facts?.strongVerification ?? false, proofCount: facts?.proofCount ?? 0 }
        }),
      }
      const score = Math.max(cluster.score, existing?.score ?? 0)
      await applyWeights(tx, rows, weightFor(score), now)
      const data = { score, memberIds: cluster.memberIds, evidence: evidence as Prisma.InputJsonValue, affected: affected as unknown as Prisma.InputJsonValue, windowStart: since, windowEnd: now }
      if (existing) {
        await tx.fraudSignal.update({ where: { id: existing.id }, data })
        return 'updated'
      }
      const created = await tx.fraudSignal.create({ data: { type: FRAUD_SIGNAL_TYPE, fingerprint: cluster.fingerprint, ...data } })
      await tx.auditEvent.create({ data: { action: 'FRAUD_SIGNAL_CREATED', targetType: 'FRAUD_SIGNAL', targetId: created.id, newValue: { score, members: cluster.memberIds.length } } })
      return 'created'
    },
    { timeout: 60_000 }
  )
}

export async function runCollusionDetection(db: Db, now: Date = new Date()): Promise<{ clusters: number; created: number; updated: number; skipped: number }> {
  const since = new Date(now.getTime() - COLLUSION_CONFIG.windowDays * DAY_MS)
  const interactions = await loadInteractions(db, since)
  const accounts = await loadAccountFacts(db, interactions.flatMap((edge) => [edge.from, edge.to]))
  const clusters = detectCollusion(interactions, accounts, now)
  const totals = { clusters: clusters.length, created: 0, updated: 0, skipped: 0 }
  for (const cluster of clusters) {
    try {
      totals[await recordCluster(db, cluster, since, now, accounts)] += 1
    } catch (error) {
      log.error('could not record a collusion cluster', { error, fingerprint: cluster.fingerprint })
    }
  }
  log.info('collusion detection finished', { ...totals, interactions: interactions.length })
  return totals
}

/** Rows lowered by another signal that is still in force, which a dismissal must leave alone. */
async function stillLowered(tx: Tx, exceptId: string): Promise<AffectedRows> {
  const others = await tx.fraudSignal.findMany({ where: { id: { not: exceptId }, status: { in: ['OPEN', 'CONFIRMED'] } }, select: { affected: true } })
  return others.map((row) => readAffected(row.affected)).reduce(union, { props: [], endorsements: [], peerReviews: [] })
}

/**
 * An admin's decision on a signal. DISMISSED restores every weight the signal lowered (except rows another live signal also lowered) and keeps the
 * group from being flagged again; CONFIRMED keeps the down-weighting. Both are audited. Returns null for an unknown signal.
 */
export async function reviewFraudSignal(db: Db, input: { id: string; status: 'CONFIRMED' | 'DISMISSED'; reviewerId: string; note?: string; now?: Date }) {
  const now = input.now ?? new Date()
  return db.$transaction(
    async (tx) => {
      const signal = await tx.fraudSignal.findUnique({ where: { id: input.id } })
      if (!signal) return null
      if (input.status === 'DISMISSED' && signal.status !== 'DISMISSED') {
        const mine = readAffected(signal.affected)
        const keep = await stillLowered(tx, signal.id)
        const restore: AffectedRows = {
          props: mine.props.filter((id) => !keep.props.includes(id)),
          endorsements: mine.endorsements.filter((id) => !keep.endorsements.includes(id)),
          peerReviews: mine.peerReviews.filter((id) => !keep.peerReviews.includes(id)),
        }
        await applyWeights(tx, restore, 1, now)
      }
      const updated = await tx.fraudSignal.update({ where: { id: signal.id }, data: { status: input.status, reviewedById: input.reviewerId, reviewedAt: now } })
      await tx.auditEvent.create({
        data: { userId: input.reviewerId, action: `FRAUD_SIGNAL_${input.status}`, targetType: 'FRAUD_SIGNAL', targetId: signal.id, oldValue: { status: signal.status }, newValue: { status: input.status, note: input.note ?? null } },
      })
      return updated
    },
    { timeout: 60_000 }
  )
}

export async function runCollusionJob(): Promise<unknown> {
  const { prisma } = await import('@/lib/prisma')
  return runCollusionDetection(prisma)
}
