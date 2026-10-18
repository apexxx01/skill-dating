import type { Match, Prisma, PrismaClient, Spark } from '@prisma/client'
import type { ErrorCode, ErrorParams } from '@/lib/api/errors'
import { ageOn } from '@/lib/age'
import { blockRelation } from '@/lib/blocks'
import { limit, subjectFor, can } from '@/lib/entitlements'
import { transactWithEvents } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { datingBlockers } from '@/lib/matching/dating'
import { checkOpener, openerHash } from '@/lib/matching/opener'
import { datingFactsSelect, datingRefusal } from '@/lib/matching/profile'
import { scoreRomance } from '@/lib/matching/score'
import { makeMatch, pairOf, SPARK_HOURLY_BURST, OPENER_MEMORY_DAYS } from '@/lib/matching/sparks'
import { createNotification } from '@/lib/notifications'
import { advisoryLock } from '@/lib/progress'
import { localWeekStart } from '@/lib/time'
import { accountDistrust } from '@/lib/trust'
import { ROMANCE_MODE_LABEL, romanceCopy, type Gender, type Scope } from './config'
import { countCharacterEndorsers } from './endorsers'
import { inboxAllows, mutuallyAccept, type FilterFacts } from './filters'
import { buildRomanceIcebreaker } from './icebreaker'
import { loadRomanceScoringProfiles } from './loader'

// Sparks and matches in the romance mode. The same shape as the professional ones (src/lib/matching/sparks.ts) with the romance rules on top, every one of which is decided
// BEFORE anything is written, in the order the person can act on it:
//
//   - the sender must have joined, pass the 18+ gate and be a TRUSTED account (a verified email, a week old);
//   - the person sparked must be someone the sender could be matched with: joined, not paused, passes the gate and trust, the private filters of BOTH accept each other
//     (gender, age range, scope), and the inbox gate lets the sender in (enough trusted endorsers) unless the other person already sparked them;
//   - and the sender must have been SHOWN them: this week's drop, or a spark from them waiting to be answered. Nobody can be sparked by guessing an id.
//   Every way of being unavailable looks the same from outside (SPARK_TARGET_UNAVAILABLE), so no filter and no setting can be probed.
//
// A romance spark is limited per local week (ROMANCE_SPARKS_PER_WEEK), not per day. A match is made by the second spark of a pair; it writes the conversation, a notification
// for each (named from the mode's label) and a push, and it announces NOTHING: no MATCH_CREATED, so it counts toward no achievement and appears on no professional surface.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export interface SendRomanceSparkInput {
  toId: string
  opener: string
  /** The drop this answers, if the caller says so: their own, for this person, still open. */
  dropId?: string
}

export interface SendRomanceSparkOptions {
  now?: Date
  /** Whether plan limits apply (defaults to ENTITLEMENTS_ENFORCED). */
  enforced?: boolean
}

export type RomanceSparkFailure = { ok: false; code: ErrorCode; params?: ErrorParams; details?: unknown }
export type SendRomanceSparkResult = { ok: true; spark: Spark; match: Match | null } | RomanceSparkFailure

const fail = (code: ErrorCode, extra: { params?: ErrorParams; details?: unknown } = {}): RomanceSparkFailure => ({ ok: false, code, ...extra })

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const OPENER_MEMORY_SIZE = 50

interface Side {
  id: string
  timezone: string | null
  deletedAt: Date | null
  createdAt: Date
  birthDate: Date | null
  isEmailVerified: boolean
  isPhoneVerified: boolean
  githubConnected: boolean
  profile: { cityKey: string | null; countryCode: string | null } | null
  romanceProfile: { gender: string; interestedIn: string[]; ageMin: number; ageMax: number; scope: string; minEndorsements: number; paused: boolean } | null
}

const sideSelect = {
  id: true,
  timezone: true,
  deletedAt: true,
  createdAt: true,
  ...datingFactsSelect,
  profile: { select: { cityKey: true, countryCode: true } },
  romanceProfile: { select: { gender: true, interestedIn: true, ageMin: true, ageMax: true, scope: true, minEndorsements: true, paused: true } },
} as const

function filterFacts(side: Side, now: Date): FilterFacts | null {
  const rp = side.romanceProfile
  if (!rp || !side.birthDate) return null
  return {
    gender: rp.gender as Gender,
    interestedIn: rp.interestedIn as Gender[],
    ageMin: rp.ageMin,
    ageMax: rp.ageMax,
    scope: rp.scope as Scope,
    age: ageOn(side.birthDate, now),
    cityKey: side.profile?.cityKey ?? null,
    countryCode: side.profile?.countryCode ?? null,
  }
}

/** Whether `side` can be shown and matched at all: joined, not paused, passes the 18+ gate and the trust gate. */
function available(side: Side, now: Date): boolean {
  return Boolean(side.romanceProfile) && !side.romanceProfile!.paused && datingBlockers(side, now).length === 0 && accountDistrust(side, now) === null
}

export async function sendRomanceSpark(db: Db, fromId: string, input: SendRomanceSparkInput, options: SendRomanceSparkOptions = {}): Promise<SendRomanceSparkResult> {
  const now = options.now ?? new Date()
  const { toId } = input
  if (fromId === toId) return fail('CANNOT_SPARK_SELF')

  const [sender, target] = await Promise.all([db.user.findUnique({ where: { id: fromId }, select: sideSelect }), db.user.findUnique({ where: { id: toId }, select: sideSelect })])
  if (!sender || sender.deletedAt || !target || target.deletedAt) return fail('USER_NOT_FOUND')

  // Blocks first, told the way every other surface tells them: the blocker plainly, the blocked person "not found".
  const relation = await blockRelation(db, fromId, toId)
  if (relation === 'BLOCKED_BY_ME') return fail('USER_BLOCKED')
  if (relation === 'BLOCKED_BY_THEM') return fail('USER_NOT_FOUND')

  // The sender: joined, 18+ and verified, and a trusted account.
  if (!sender.romanceProfile) return fail('ROMANCE_PROFILE_REQUIRED')
  const blockers = datingBlockers(sender, now)
  const refusal = datingRefusal(blockers)
  if (refusal) return fail(refusal, { details: { blockers } })
  if (accountDistrust(sender, now) !== null) return fail('ROMANCE_ACCOUNT_TOO_NEW')

  // The person sparked.
  if (!available(target, now)) return fail('SPARK_TARGET_UNAVAILABLE')
  const mine = filterFacts(sender, now)
  const theirs = filterFacts(target, now)
  if (!mine || !theirs || !mutuallyAccept(mine, theirs).ok) return fail('SPARK_TARGET_UNAVAILABLE')

  // The pair, as it stands: an ended match of any kind is final; an open romance match means there is nothing to start.
  const [a, b] = pairOf(fromId, toId)
  const pairMatches = await db.match.findMany({ where: { userAId: a, userBId: b }, select: { connectionType: true, endedAt: true } })
  if (pairMatches.some((match) => match.endedAt !== null)) return fail('MATCH_ENDED')
  if (pairMatches.some((match) => match.connectionType === 'DATING')) return fail('MATCH_EXISTS')
  if (await db.spark.findUnique({ where: { fromId_toId_connectionType: { fromId, toId, connectionType: 'DATING' } }, select: { id: true } })) return fail('SPARK_ALREADY_SENT')

  // Already sparked by them? Then this is an answer: the inbox gate does not stand in the way of a reply, and they need not have been shown to the sender.
  const incoming = await db.spark.findFirst({ where: { fromId: toId, toId: fromId, connectionType: 'DATING', status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (!incoming) {
    const endorsers = (await countCharacterEndorsers(db, [fromId], now)).get(fromId) ?? 0
    if (!inboxAllows(target.romanceProfile!.minEndorsements, endorsers)) return fail('SPARK_TARGET_UNAVAILABLE')
    // Only someone the sender was shown, in a drop that is still open.
    const shown = await db.romanceDrop.findFirst({ where: { userId: fromId, candidateId: toId, status: 'NEW', expiresAt: { gt: now } }, select: { id: true } })
    if (!shown) return fail('SPARK_TARGET_UNAVAILABLE')
  }
  if (input.dropId) {
    const drop = await db.romanceDrop.findUnique({ where: { id: input.dropId }, select: { userId: true, candidateId: true, status: true, expiresAt: true } })
    if (!drop || drop.userId !== fromId || drop.candidateId !== toId) return fail('DROP_NOT_FOUND')
    if (drop.status !== 'NEW' || drop.expiresAt.getTime() < now.getTime()) return fail('DROP_NOT_PENDING')
  }

  // The opener: a real reason to talk, by the same rules as any other.
  const recent = await db.spark.findMany({
    where: { fromId, createdAt: { gte: new Date(now.getTime() - OPENER_MEMORY_DAYS * DAY_MS) } },
    orderBy: { createdAt: 'desc' },
    take: OPENER_MEMORY_SIZE,
    select: { opener: true },
  })
  const opener = input.opener.trim()
  const verdict = checkOpener(opener, recent.map((row) => row.opener))
  if (!verdict.ok) return fail('SPARK_OPENER_REJECTED', { details: { reason: verdict.problem, message: verdict.message } })

  // How many, and how fast: a few a week in the mode, and the same hourly throttle as any spark.
  const subject = await subjectFor(db, fromId, now)
  const allowance = limit(subject, 'ROMANCE_SPARKS_PER_WEEK', { enforced: options.enforced })
  const sentThisWeek = await db.spark.count({ where: { fromId, connectionType: 'DATING', createdAt: { gte: localWeekStart(now, sender.timezone) } } })
  if (sentThisWeek >= allowance) return fail('ROMANCE_SPARK_LIMIT_REACHED', { params: { limit: allowance, mode: ROMANCE_MODE_LABEL } })
  const lastHour = await db.spark.findMany({ where: { fromId, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  if (lastHour.length >= SPARK_HOURLY_BURST) {
    const retryAfter = Math.max(1, Math.ceil((lastHour[0].createdAt.getTime() + HOUR_MS - now.getTime()) / 1000))
    return fail('SPARK_THROTTLED', { params: { retryAfter } })
  }

  // --- The writes ---------------------------------------------------------------------------------------------
  type Written = { failure: RomanceSparkFailure } | { spark: Spark; match: Match | null }
  const outcome = await transactWithEvents(db, async (tx): Promise<Written> => {
    // The pair is locked, so a spark and its answer sent at the same moment are handled one after the other: the second finds the first.
    await advisoryLock(tx, `spark-pair:${a}:${b}`)
    if ((await tx.match.count({ where: { userAId: a, userBId: b, endedAt: { not: null } } })) > 0) return { failure: fail('MATCH_ENDED') }
    if (await tx.spark.findUnique({ where: { fromId_toId_connectionType: { fromId, toId, connectionType: 'DATING' } }, select: { id: true } })) return { failure: fail('SPARK_ALREADY_SENT') }

    const spark = await tx.spark.create({ data: { fromId, toId, connectionType: 'DATING', opener, openerHash: openerHash(opener), createdAt: now } })
    await tx.romanceDrop.updateMany({ where: { status: 'NEW', userId: fromId, candidateId: toId }, data: { status: 'SPARKED' } })

    const answered = await tx.spark.findFirst({ where: { fromId: toId, toId: fromId, connectionType: 'DATING', status: 'PENDING' }, orderBy: { createdAt: 'asc' } })
    if (!answered) {
      await notifySparked(tx, spark, options)
      return { spark, match: null }
    }
    return { spark, match: await createRomanceMatch(tx, answered, spark, now) }
  })

  const written = outcome.value
  if ('failure' in written) return written.failure
  await track(fromId, 'romance_spark_sent', { matched: written.match !== null })
  return { ok: true, spark: written.spark, match: written.match }
}

/** A romance spark that did not make a match: per spark, with the sender, for a plan that shows who; otherwise the daily count (romance/spark-digest) tells. */
async function notifySparked(tx: Tx, spark: Spark, options: SendRomanceSparkOptions): Promise<void> {
  const subject = await subjectFor(tx, spark.toId, options.now)
  if (!can(subject, 'SEE_WHO_SPARKED', { enforced: options.enforced })) return
  const sender = await tx.user.findUnique({ where: { id: spark.fromId }, select: { name: true, username: true } })
  await createNotification(tx, {
    userId: spark.toId,
    kind: 'ROMANCE_SPARK',
    title: romanceCopy.modeName,
    message: romanceCopy.sparkedYouBy(sender?.name || sender?.username || 'Someone'),
    link: '/romance',
    metadata: { sparkId: spark.id, fromId: spark.fromId },
  })
}

async function createRomanceMatch(tx: Tx, first: Spark, second: Spark, now: Date): Promise<Match> {
  const [self, other] = await loadRomanceScoringProfiles(tx, [second.fromId, first.fromId], now)
  const reasons = self && other ? scoreRomance({ viewer: self, candidate: other, now }).reasons : []
  return makeMatch(tx, first, second, now, {
    icebreaker: buildRomanceIcebreaker(reasons),
    notificationTitle: romanceCopy.matchTitle,
    notificationMessage: (name) => `You and ${name} sparked each other`,
    // A romance match counts toward no achievement and nothing public: no MATCH_CREATED.
    announce: false,
    analyticsEvent: 'romance_match_created',
  })
}
