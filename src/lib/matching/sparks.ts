import { checkContent } from '@/lib/safety/content'
import { reachFor } from '@/lib/integrity/reach-db'
import { sparkAllowance } from '@/lib/integrity/reach'
import type { Match, Prisma, PrismaClient, Spark } from '@prisma/client'
import type { ErrorCode, ErrorParams } from '@/lib/api/errors'
import { blockRelation } from '@/lib/blocks'
import { can, limit, subjectFor } from '@/lib/entitlements'
import { afterCommit, emit, transactWithEvents } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { getRealtime, userChannel } from '@/lib/infra/realtime'
import { log } from '@/lib/log'
import { createNotification } from '@/lib/notifications'
import { deliverSoon } from '@/lib/notify/immediate'
import { advisoryLock } from '@/lib/progress'
import { localDayStart } from '@/lib/time'
import { accountDistrust } from '@/lib/trust'
import { buildIcebreaker, sharedGround } from './icebreaker'
import { loadScoringProfiles } from './loader'
import { checkOpener, openerHash } from './opener'
import { ensureSystemUser } from './system-user'
import { counterpartType, relationshipType, type MatchType, type ProfessionalType } from './types'

// Sparks and matches.
//
// A SPARK is "I would like to work with you", with an opener that says why. When two people spark each other (the second spark is the counterpart
// type of the first) they MATCH: a Match row, a conversation seeded with both openers and a system icebreaker, a notification for each, a realtime
// push, and the MATCH_CREATED event. Sparks and matches pay NO XP, ever: the event only counts toward the match achievements.
//
// Every refusal is decided before anything is written, in the order the person can act on it; the writes are one transaction under a lock on the
// pair, so two people sparking each other at the same moment make exactly one match.

type Tx = Prisma.TransactionClient

/** The most sparks a person may send in an hour, whatever their daily allowance. */
export const SPARK_HOURLY_BURST = 8
/** Openers older than this are not looked at for repeats. */
export const OPENER_MEMORY_DAYS = 30
/** How many of the sender's recent openers a new one is compared with. */
const OPENER_MEMORY_SIZE = 50

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

export interface SendSparkInput {
  toId: string
  /** The sender's side of the relationship. */
  connectionType: MatchType
  opener: string
  dropId?: string
}

export interface SendSparkOptions {
  now?: Date
  /** Whether plan limits apply (defaults to ENTITLEMENTS_ENFORCED). */
  enforced?: boolean
}

export type SparkFailure = { ok: false; code: ErrorCode; params?: ErrorParams; details?: unknown }
export type SendSparkResult = { ok: true; spark: Spark; match: Match | null } | SparkFailure

const fail = (code: ErrorCode, extra: { params?: ErrorParams; details?: unknown } = {}): SparkFailure => ({ ok: false, code, ...extra })

/** The two ids of a pair, smaller first: the order a Match is stored in. */
export const pairOf = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

// --- Sending ------------------------------------------------------------------------------------------------

export async function sendSpark(db: PrismaClient, fromId: string, input: SendSparkInput, options: SendSparkOptions = {}): Promise<SendSparkResult> {
  const now = options.now ?? new Date()
  const { toId, connectionType } = input
  if (fromId === toId) return fail('CANNOT_SPARK_SELF')
  // The romance mode is not a connection type: it has its own profile, pool and sparks (src/lib/romance/sparks.ts).
  if (connectionType === 'DATING') return fail('SPARK_TYPE_NOT_CHOSEN')

  const [sender, target] = await Promise.all([
    db.user.findUnique({
      where: { id: fromId },
      select: {
        id: true,
        timezone: true,
        deletedAt: true,
        profile: { select: { cityKey: true } },
        matchingProfile: { select: { connectionTypes: true, cityOnly: true } },
      },
    }),
    db.user.findUnique({
      where: { id: toId },
      select: {
        id: true,
        deletedAt: true,
        createdAt: true,
        isEmailVerified: true,
        profile: { select: { cityKey: true } },
        matchingProfile: { select: { connectionTypes: true, paused: true, cityOnly: true } },
      },
    }),
  ])
  if (!sender || sender.deletedAt) return fail('USER_NOT_FOUND')
  if (!target || target.deletedAt) return fail('USER_NOT_FOUND')

  // Blocks first, and told the way every other surface tells them: the blocker plainly, the blocked person "not found".
  const relation = await blockRelation(db, fromId, toId)
  if (relation === 'BLOCKED_BY_ME') return fail('USER_BLOCKED')
  if (relation === 'BLOCKED_BY_THEM') return fail('USER_NOT_FOUND')

  // The sender: a matching profile that includes the type.
  if (!sender.matchingProfile || sender.matchingProfile.connectionTypes.length === 0) return fail('MATCHING_PROFILE_REQUIRED')
  if (!sender.matchingProfile.connectionTypes.includes(connectionType)) return fail('SPARK_TYPE_NOT_CHOSEN')

  // The person sparked: someone who can be paired with the sender on this type, and whom the platform trusts to be shown. Everything that makes
  // them unavailable looks the same from outside, so none of it can be probed (paused, wrong type, too new).
  const them = target.matchingProfile
  const unavailable =
    !them ||
    them.paused ||
    !them.connectionTypes.includes(counterpartType(connectionType)) ||
    accountDistrust(target, now) !== null
  if (unavailable) return fail('SPARK_TARGET_UNAVAILABLE')
  // "Only people in my city", from either side, is a wish about who may be matched, so it holds here as it does in a drop.
  const senderCity = sender.profile?.cityKey ?? null
  const sameCity = senderCity !== null && senderCity === (target.profile?.cityKey ?? null)
  if ((sender.matchingProfile.cityOnly || them.cityOnly) && !sameCity) return fail('SPARK_TARGET_UNAVAILABLE')

  // The pair, as it stands: an ended match is final for the pair, an open one of this kind means there is nothing to start.
  const [a, b] = pairOf(fromId, toId)
  const pairMatches = await db.match.findMany({ where: { userAId: a, userBId: b }, select: { connectionType: true, endedAt: true } })
  if (pairMatches.some((match) => match.endedAt !== null)) return fail('MATCH_ENDED')
  if (pairMatches.some((match) => match.connectionType === relationshipType(connectionType))) return fail('MATCH_EXISTS')
  const already = await db.spark.findUnique({ where: { fromId_toId_connectionType: { fromId, toId, connectionType } }, select: { id: true } })
  if (already) return fail('SPARK_ALREADY_SENT')

  // The drop it answers, if any: the sender's own, for this person, still open.
  if (input.dropId) {
    const drop = await db.drop.findUnique({ where: { id: input.dropId }, select: { userId: true, candidateId: true, status: true, expiresAt: true } })
    if (!drop || drop.userId !== fromId || drop.candidateId !== toId) return fail('DROP_NOT_FOUND')
    if (drop.status !== 'NEW' || drop.expiresAt.getTime() < now.getTime()) return fail('DROP_NOT_PENDING')
  }

  // The opener: a real reason, not the message they sent someone else.
  const recent = await db.spark.findMany({
    where: { fromId, createdAt: { gte: new Date(now.getTime() - OPENER_MEMORY_DAYS * DAY_MS) } },
    orderBy: { createdAt: 'desc' },
    take: OPENER_MEMORY_SIZE,
    select: { opener: true },
  })
  const opener = input.opener.trim()
  const verdict = checkOpener(opener, recent.map((row) => row.opener))
  if (!verdict.ok) return fail('SPARK_OPENER_REJECTED', { details: { reason: verdict.problem, message: verdict.message } })
  // The platform's banned terms (src/lib/safety/content.ts) apply to openers too.
  if (checkContent(opener, { surface: 'OPENER' }).verdict === 'REJECT') return fail('SPARK_OPENER_REJECTED', { details: { reason: 'CONTENT', message: 'That opener cannot be sent' } })

  // How many, and how fast.
  const subject = await subjectFor(db, fromId, now)
  // The plan's limit, lowered for a new or unverified account and for a HIGH risk level (reach gating, src/lib/integrity/reach.ts).
  const allowance = sparkAllowance(limit(subject, 'DAILY_SPARKS', { enforced: options.enforced }), await reachFor(db, fromId, now))
  const sentToday = await db.spark.count({ where: { fromId, createdAt: { gte: localDayStart(now, sender.timezone) } } })
  if (sentToday >= allowance) return fail('SPARK_LIMIT_REACHED', { params: { limit: allowance } })
  const lastHour = await db.spark.findMany({ where: { fromId, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  if (lastHour.length >= SPARK_HOURLY_BURST) {
    const retryAfter = Math.max(1, Math.ceil((lastHour[0].createdAt.getTime() + HOUR_MS - now.getTime()) / 1000))
    return fail('SPARK_THROTTLED', { params: { retryAfter } })
  }

  // --- The writes ---------------------------------------------------------------------------------------------
  type Written = { failure: SparkFailure } | { spark: Spark; match: Match | null }
  const outcome = await transactWithEvents(db, async (tx): Promise<Written> => {
    // The pair is locked, so a spark and its answer sent at the same moment are handled one after the other: the second finds the first.
    await advisoryLock(tx, `spark-pair:${a}:${b}`)

    if ((await tx.match.count({ where: { userAId: a, userBId: b, endedAt: { not: null } } })) > 0) return { failure: fail('MATCH_ENDED') }
    if (await tx.spark.findUnique({ where: { fromId_toId_connectionType: { fromId, toId, connectionType } }, select: { id: true } })) return { failure: fail('SPARK_ALREADY_SENT') }

    const spark = await tx.spark.create({
      data: { fromId, toId, dropId: input.dropId ?? null, connectionType, opener, openerHash: openerHash(opener), createdAt: now },
    })
    // The drop (and any other still-open drop between the two) is answered.
    await tx.drop.updateMany({ where: { status: 'NEW', userId: fromId, candidateId: toId }, data: { status: 'SPARKED' } })

    const answered = await tx.spark.findFirst({
      where: { fromId: toId, toId: fromId, connectionType: counterpartType(connectionType), status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    })
    if (!answered) {
      await notifySparked(tx, spark, options)
      return { spark, match: null }
    }
    return { spark, match: await createMatch(tx, answered, spark, now) }
  })

  const written = outcome.value
  if ('failure' in written) return written.failure
  const { spark, match } = written
  await track(fromId, 'spark_sent', { connectionType, matched: match !== null, fromDrop: input.dropId !== undefined })
  return { ok: true, spark, match }
}

// --- Telling the person ----------------------------------------------------------------------------------------

/**
 * A spark that did not make a match: a plan that shows who sparked you is told now, with the sender in the notification; any other plan is told by the daily count
 * (src/lib/matching/spark-digest.ts), which has no names. A person who switched sparks off is told neither way.
 */
async function notifySparked(tx: Tx, spark: Spark, options: SendSparkOptions): Promise<void> {
  const subject = await subjectFor(tx, spark.toId, options.now)
  if (!can(subject, 'SEE_WHO_SPARKED', { enforced: options.enforced })) return
  const sender = await tx.user.findUnique({ where: { id: spark.fromId }, select: { name: true, username: true } })
  await createNotification(tx, {
    userId: spark.toId,
    kind: 'SPARK',
    title: 'Someone sparked you',
    message: `${sender?.name || sender?.username || 'Someone'} sparked you`,
    link: '/sparks',
    metadata: { sparkId: spark.id, fromId: spark.fromId, connectionType: spark.connectionType },
  })
}

// --- Matching -----------------------------------------------------------------------------------------------

/** How a match is written, which is the only thing that differs between a professional match and a romance one (src/lib/romance/sparks.ts). */
export interface MatchStyle {
  /** The system message that opens the conversation. */
  icebreaker: string
  notificationTitle: string
  notificationMessage: (otherName: string) => string
  /** Announce MATCH_CREATED (it counts toward the match achievements). A romance match never does: achievements are public and nothing about romance is. */
  announce: boolean
  analyticsEvent: 'match_created' | 'romance_match_created'
}

/**
 * Makes the match for two sparks that answer each other, inside the transaction that wrote the second one (and under the pair's lock): the
 * Match, the conversation with both openers and the icebreaker, both sparks marked, a notification each, the event, and the push after commit.
 */
async function createMatch(tx: Tx, first: Spark, second: Spark, now: Date): Promise<Match> {
  const connectionType = relationshipType(first.connectionType)
  const [userAId, userBId] = pairOf(first.fromId, second.fromId)
  const existing = await tx.match.findUnique({ where: { userAId_userBId_connectionType: { userAId, userBId, connectionType } } })
  if (existing) return existing

  // What the two have in common, for the icebreaker.
  const [self, other] = await loadScoringProfiles(tx, [first.fromId, second.fromId], now, undefined, { includeWithoutMatchingProfile: true })
  const icebreaker = buildIcebreaker(connectionType as ProfessionalType, self && other ? sharedGround(self, other, now) : { skills: [], stack: [], intents: [], sameHackathon: false })
  return makeMatch(tx, first, second, now, {
    icebreaker,
    notificationTitle: 'It is a match',
    notificationMessage: (name) => `You and ${name} sparked each other`,
    announce: true,
    analyticsEvent: 'match_created',
  })
}

export async function makeMatch(tx: Tx, first: Spark, second: Spark, now: Date, style: MatchStyle): Promise<Match> {
  const [userAId, userBId] = pairOf(first.fromId, second.fromId)
  const roleOf = (userId: string): MatchType => (userId === first.fromId ? first.connectionType : second.connectionType)
  const connectionType = relationshipType(first.connectionType)

  const existing = await tx.match.findUnique({ where: { userAId_userBId_connectionType: { userAId, userBId, connectionType } } })
  if (existing) return existing

  const systemUserId = await ensureSystemUser(tx)

  // One conversation for the pair: a direct one they already have and that is still open, otherwise a new one.
  const open = await tx.conversation.findMany({
    where: { type: 'DIRECT', closedAt: null, AND: [{ members: { some: { userId: userAId } } }, { members: { some: { userId: userBId } } }] },
    select: { id: true, members: { select: { userId: true } } },
    take: 5,
  })
  const shared = open.find((conversation) => conversation.members.length === 2)
  const conversation =
    shared ??
    (await tx.conversation.create({
      data: { type: 'DIRECT', members: { create: [{ userId: userAId, role: 'MEMBER' }, { userId: userBId, role: 'MEMBER' }] } },
      select: { id: true, members: { select: { userId: true } } },
    }))

  // The icebreaker first, then the two openers in the order they were written. Written directly, not through the messages route: no event, no XP.
  const at = (offsetMs: number) => new Date(first.createdAt.getTime() + offsetMs)
  await tx.message.create({
    data: { conversationId: conversation.id, senderId: systemUserId, content: style.icebreaker, type: 'SYSTEM', metadata: { kind: 'MATCH_ICEBREAKER' }, createdAt: at(-1) },
  })
  await tx.message.create({
    data: { conversationId: conversation.id, senderId: first.fromId, content: first.opener, type: 'TEXT', metadata: { kind: 'SPARK_OPENER', sparkId: first.id }, createdAt: first.createdAt },
  })
  await tx.message.create({
    data: { conversationId: conversation.id, senderId: second.fromId, content: second.opener, type: 'TEXT', metadata: { kind: 'SPARK_OPENER', sparkId: second.id }, createdAt: now },
  })
  await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: now } })

  const match = await tx.match.create({
    data: { userAId, userBId, userARole: roleOf(userAId), userBRole: roleOf(userBId), connectionType, conversationId: conversation.id, createdAt: now },
  })
  await tx.spark.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { status: 'MATCHED' } })
  await tx.drop.updateMany({ where: { status: 'NEW', OR: [{ userId: userAId, candidateId: userBId }, { userId: userBId, candidateId: userAId }] }, data: { status: 'SPARKED' } })
  await tx.romanceDrop.updateMany({ where: { status: 'NEW', OR: [{ userId: userAId, candidateId: userBId }, { userId: userBId, candidateId: userAId }] }, data: { status: 'SPARKED' } })

  const people = await tx.user.findMany({ where: { id: { in: [userAId, userBId] } }, select: { id: true, name: true, username: true } })
  const label = (id: string) => {
    const person = people.find((candidate) => candidate.id === id)
    return person?.name || person?.username || 'someone'
  }
  await tx.notification.createMany({
    data: [userAId, userBId].map((userId) => ({
      userId,
      type: 'MATCH' as const,
      title: style.notificationTitle,
      message: style.notificationMessage(label(userId === userAId ? userBId : userAId)),
      link: `/messages/${conversation.id}`,
      metadata: { kind: 'MATCH_CREATED', matchId: match.id, conversationId: conversation.id, connectionType },
    })),
  })

  // A match is time-critical: both people are told as soon as it commits, not at the next sweep (src/lib/notify/immediate.ts).
  deliverSoon(tx, [userAId, userBId])

  // Announced last: the achievements it counts toward are merged in after the match itself. It pays no XP.
  if (style.announce) await emit(tx, 'MATCH_CREATED', { userId: second.fromId, otherUserId: first.fromId, matchId: match.id, connectionType, conversationId: conversation.id })

  // After the commit only: a rolled-back match is never pushed or counted.
  afterCommit(tx, async () => {
    for (const userId of [userAId, userBId]) {
      await track(userId, style.analyticsEvent, { connectionType, matchId: match.id })
      try {
        await getRealtime().publish(userChannel(userId), 'match.created', { matchId: match.id, conversationId: conversation.id, connectionType })
      } catch (error) {
        log.warn('could not push a new match', { error, matchId: match.id })
      }
    }
  })
  return match
}
