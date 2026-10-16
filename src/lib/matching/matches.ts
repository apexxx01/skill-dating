import type { Match, Prisma, PrismaClient, ReportReason } from '@prisma/client'
import type { MatchesResponse, MatchItem, MatchTypeName, ReceivedSparkItem, ReceivedSparks } from '@/types/api'
import { blockedPeerIds } from '@/lib/blocks'
import { can, subjectFor } from '@/lib/entitlements'
import { afterCommit, transactWithEvents } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { getRealtime, userChannel } from '@/lib/infra/realtime'
import { log } from '@/lib/log'
import { advisoryLock } from '@/lib/progress'
import { decodeKeysetCursor, keysetPage, keysetWhere, keysetOrderBy } from '@/lib/api/pagination'
import { loadPersonSummaries } from './summary'
import { counterpartType, type MatchType } from './types'

// Listing, ending and reporting matches, and the list of sparks a person has received.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

const matchType = (value: string) => value as MatchTypeName

// --- Matches ----------------------------------------------------------------------------------------------------

export function toMatchItem(match: Match, viewerId: string, other: MatchItem['other']): MatchItem {
  const viewerIsA = match.userAId === viewerId
  return {
    id: match.id,
    connectionType: matchType(match.connectionType),
    yourRole: matchType(viewerIsA ? match.userARole : match.userBRole),
    theirRole: matchType(viewerIsA ? match.userBRole : match.userARole),
    createdAt: match.createdAt.toISOString(),
    conversationId: match.conversationId,
    other,
  }
}


/** The caller's open matches, newest first. Someone blocked either way, or whose account is gone, is not listed. */
export async function listMatches(db: Db, userId: string, options: { cursor?: string; limit: number }): Promise<MatchesResponse | 'INVALID_CURSOR'> {
  const hidden = await blockedPeerIds(db, userId)
  const visible = (side: 'userA' | 'userB'): Prisma.MatchWhereInput => ({
    endedAt: null,
    [`${side}Id`]: userId,
    [side === 'userA' ? 'userB' : 'userA']: { deletedAt: null, ...(hidden.length > 0 ? { id: { notIn: hidden } } : {}) },
  })
  const base: Prisma.MatchWhereInput = { OR: [visible('userA'), visible('userB')] }

  let where: Prisma.MatchWhereInput = base
  if (options.cursor !== undefined) {
    const after = decodeKeysetCursor(options.cursor)
    if (!after) return 'INVALID_CURSOR'
    where = { AND: [base, keysetWhere('createdAt', 'desc', after)] }
  }
  const [rows, total] = await Promise.all([
    db.match.findMany({ where, orderBy: keysetOrderBy('createdAt', 'desc') as Prisma.MatchOrderByWithRelationInput[], take: options.limit + 1 }),
    db.match.count({ where: base }),
  ])
  const page = keysetPage(rows, options.limit, (row) => ({ sort: row.createdAt, id: row.id }))
  const people = await loadPersonSummaries(db, page.items.map((match) => (match.userAId === userId ? match.userBId : match.userAId)))
  const items = page.items.flatMap((match) => {
    const other = people.get(match.userAId === userId ? match.userBId : match.userAId)
    return other ? [toMatchItem(match, userId, other)] : []
  })
  return { matches: items, nextCursor: page.nextCursor, total }
}

async function publishEnded(userIds: string[], matchId: string) {
  try {
    const realtime = getRealtime()
    for (const userId of userIds) await realtime.publish(userChannel(userId), 'match.ended', { matchId })
  } catch (error) {
    log.warn('could not push an ended match', { error, matchId })
  }
}

/** Ends a match inside a transaction and closes its conversation for both. Returns false when it was already over. */
async function endMatchIn(tx: Tx, match: Match, endedById: string, reason: 'UNMATCHED' | 'REPORTED' | 'BLOCKED', now: Date): Promise<boolean> {
  if (match.endedAt) return false
  const changed = await tx.match.updateMany({ where: { id: match.id, endedAt: null }, data: { endedAt: now, endedById, endReason: reason } })
  if (changed.count === 0) return false
  if (match.conversationId) {
    await tx.conversation.updateMany({ where: { id: match.conversationId, closedAt: null }, data: { closedAt: now, closedReason: reason } })
  }
  return true
}

export type EndMatchResult = { kind: 'NOT_FOUND' } | { kind: 'ENDED'; match: Match; alreadyEnded: boolean }

/**
 * Unmatching: final, for both people. The match is over, its conversation is closed for both (readable, but nobody can post), and the pair
 * can never be matched, dropped to each other or sparked again. Either person can do it; anyone else gets "not found".
 */
export async function unmatch(db: Db, userId: string, matchId: string, now: Date = new Date()): Promise<EndMatchResult> {
  const { value } = await transactWithEvents(db, async (tx) => {
    await advisoryLock(tx, `match:${matchId}`)
    const match = await tx.match.findUnique({ where: { id: matchId } })
    if (!match || (match.userAId !== userId && match.userBId !== userId)) return { kind: 'NOT_FOUND' as const }
    const ended = await endMatchIn(tx, match, userId, 'UNMATCHED', now)
    if (ended) {
      afterCommit(tx, async () => {
        await track(userId, 'unmatch', { connectionType: match.connectionType, matchId })
        await publishEnded([match.userAId === userId ? match.userBId : match.userAId], matchId)
      })
    }
    return { kind: 'ENDED' as const, match: ended ? { ...match, endedAt: now, endedById: userId, endReason: 'UNMATCHED' as const } : match, alreadyEnded: !ended }
  })
  return value
}

/** Ends every open match between two people because one blocked the other. Called inside the block's transaction. */
export async function endMatchesBetween(tx: Tx, blockerId: string, otherId: string, now: Date = new Date()): Promise<number> {
  const [a, b] = blockerId < otherId ? [blockerId, otherId] : [otherId, blockerId]
  const open = await tx.match.findMany({ where: { userAId: a, userBId: b, endedAt: null } })
  let ended = 0
  for (const match of open) if (await endMatchIn(tx, match, blockerId, 'BLOCKED', now)) ended += 1
  return ended
}

export interface ReportMatchInput {
  reason: ReportReason
  description?: string
}

export type ReportMatchResult = { kind: 'NOT_FOUND' } | { kind: 'REPORTED'; match: Match; reportId: string; alreadyReported: boolean }

/**
 * Unmatch and report in one call. The match ends and its conversation closes exactly as for an unmatch (and a match that was already over
 * stays as it was), and a report against the other person is filed in the same Report table as any other. If the caller already has a pending
 * report against them, that one is kept and no second is filed.
 */
export async function reportMatch(db: Db, userId: string, matchId: string, input: ReportMatchInput, now: Date = new Date()): Promise<ReportMatchResult> {
  const { value } = await transactWithEvents(db, async (tx) => {
    await advisoryLock(tx, `match:${matchId}`)
    const match = await tx.match.findUnique({ where: { id: matchId } })
    if (!match || (match.userAId !== userId && match.userBId !== userId)) return { kind: 'NOT_FOUND' as const }
    const otherId = match.userAId === userId ? match.userBId : match.userAId

    const ended = await endMatchIn(tx, match, userId, 'REPORTED', now)

    const pending = await tx.report.findFirst({ where: { reporterId: userId, reportedId: otherId, status: 'PENDING' }, select: { id: true } })
    const report =
      pending ??
      (await tx.report.create({
        data: { reporterId: userId, reportedId: otherId, reason: input.reason, description: input.description, metadata: { source: 'MATCH', matchId } },
        select: { id: true },
      }))
    if (!pending) {
      await tx.auditEvent.create({ data: { userId, action: 'REPORT_CREATED', targetType: 'REPORT', targetId: report.id, newValue: { reportedId: otherId, reason: input.reason, matchId } } })
    }
    if (ended) {
      afterCommit(tx, async () => {
        await track(userId, 'unmatch', { connectionType: match.connectionType, matchId, reported: true })
        await publishEnded([otherId], matchId)
      })
    }
    return {
      kind: 'REPORTED' as const,
      match: ended ? { ...match, endedAt: now, endedById: userId, endReason: 'REPORTED' as const } : match,
      reportId: report.id,
      alreadyReported: Boolean(pending),
    }
  })
  return value
}

// --- Sparks received --------------------------------------------------------------------------------------------

/**
 * The sparks the caller has not answered. Who sent them and what they wrote is a paid feature (SEE_WHO_SPARKED): without it the caller gets the
 * number and nothing else, and can still spark back from a drop or a profile. Senders who are blocked either way, or gone, are not counted.
 */
export async function loadReceivedSparks(
  db: Db,
  userId: string,
  options: { cursor?: string; limit: number; enforced?: boolean }
): Promise<ReceivedSparks | 'INVALID_CURSOR'> {
  const hidden = await blockedPeerIds(db, userId)
  const base: Prisma.SparkWhereInput = {
    toId: userId,
    status: 'PENDING',
    from: { deletedAt: null, ...(hidden.length > 0 ? { id: { notIn: hidden } } : {}) },
  }
  const subject = await subjectFor(db, userId)
  const canSee = can(subject, 'SEE_WHO_SPARKED', { enforced: options.enforced })
  const count = await db.spark.count({ where: base })
  if (!canSee) return { canSee: false, count, sparks: [], nextCursor: null }

  let where: Prisma.SparkWhereInput = base
  if (options.cursor !== undefined) {
    const after = decodeKeysetCursor(options.cursor)
    if (!after) return 'INVALID_CURSOR'
    where = { AND: [base, keysetWhere('createdAt', 'desc', after)] }
  }
  const rows = await db.spark.findMany({ where, orderBy: keysetOrderBy('createdAt', 'desc') as Prisma.SparkOrderByWithRelationInput[], take: options.limit + 1 })
  const page = keysetPage(rows, options.limit, (row) => ({ sort: row.createdAt, id: row.id }))
  const people = await loadPersonSummaries(db, page.items.map((spark) => spark.fromId))
  const sparks: ReceivedSparkItem[] = page.items.flatMap((spark) => {
    const from = people.get(spark.fromId)
    return from ? [{ id: spark.id, connectionType: matchType(spark.connectionType), opener: spark.opener, createdAt: spark.createdAt.toISOString(), from }] : []
  })
  return { canSee: true, count, sparks, nextCursor: page.nextCursor }
}

/** The type a received spark would be answered with: the counterpart of the sender's side. */
export const answerType = (sparkType: MatchType): MatchType => counterpartType(sparkType)
