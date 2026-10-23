import { Prisma, type InviteCode, type PrismaClient } from '@prisma/client'
import { env } from '@/lib/env'
import { didMeaningfulAction } from '@/lib/kpi/activity'
import { emit, transactWithEvents } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { effectiveLevel } from '@/lib/integrity/risk'
import { log } from '@/lib/log'
import { isOnboardingComplete } from '@/lib/onboarding'
import { REWARD_RULES } from '@/lib/rewards-config'
import { pairDistrust } from '@/lib/trust'
import { canonicalEmail, generateCode, normalizeCode } from './codes'

// Invites and attribution (docs/INVITES.md).
//
//   a personal code   one each, theirs to share; joining with it can earn the owner XP (once, capped);
//   a campaign code   made by an admin for a launch waitlist or a partner college: attribution only.
//
// A person joins with a code once, in the first 14 days of their account (redeemInvite). The attribution is a row, InviteRedemption, PENDING. It becomes QUALIFIED when the invitee has
// finished onboarding AND done a first real thing (kpi/activity.ts MEANINGFUL_EVENTS) — the hourly job qualifyInvites — and only then, for a personal code, is the inviter paid, through
// the rewards engine like any other XP (the domain event INVITE_QUALIFIED; nothing here writes XP). What stops the abuse that referral rewards invite:
//   - your own code, and the same mailbox (the same address up to dots and +tags) on both accounts: refused;
//   - an inviter or an invitee at a HIGH risk level, or in an open collusion finding together (FraudSignal): rejected, and recorded for review (IntegritySignal);
//   - the invitee has to be a trusted counterparty (src/lib/trust.ts: a week old, a verified email, no block between them), or the payment waits;
//   - at most INVITE_REWARD_CAP rewarded invitees per inviter, ever, and 3 payments a day (the reward rule's daily cap).

type Db = PrismaClient

/** The first days of an account in which it may join with a code. */
export const INVITE_WINDOW_DAYS = 14
/** An invitee who has not qualified by now is let go. */
export const INVITE_EXPIRES_DAYS = 30
/** A payment still waiting (the invitee not yet trusted, the daily cap) is let go after this long. */
export const INVITE_REWARD_EXPIRES_DAYS = 60
/** The most invitees one person is ever paid for. */
export const INVITE_REWARD_CAP = 10
/** The most a personal code can be redeemed. */
export const PERSONAL_MAX_USES = 50

const DAY_MS = 24 * 60 * 60 * 1000

// --- Codes ---------------------------------------------------------------------------------------------------------------

function isUnique(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/** The caller's personal code, made on first use. */
export async function ensurePersonalCode(db: Db, userId: string): Promise<InviteCode> {
  const existing = await db.inviteCode.findUnique({ where: { ownerId: userId } })
  if (existing) return existing
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await db.inviteCode.create({ data: { code: generateCode(), kind: 'PERSONAL', ownerId: userId, maxUses: PERSONAL_MAX_USES } })
    } catch (error) {
      if (!isUnique(error)) throw error
      // Either the code collided (try another) or a parallel request made this person's code (use it).
      const made = await db.inviteCode.findUnique({ where: { ownerId: userId } })
      if (made) return made
    }
  }
  throw new Error('could not make an invite code')
}

export interface InviteStats {
  code: string
  link: string | null
  redeemed: number
  qualified: number
  rewarded: number
  rewardCap: number
  rewardsLeft: number
  xpPerInvite: number
}

export async function inviteStats(db: Db, userId: string, baseUrl: string | null): Promise<InviteStats> {
  const code = await ensurePersonalCode(db, userId)
  const grouped = await db.inviteRedemption.groupBy({ by: ['status'], where: { inviterId: userId }, _count: { _all: true } })
  const count = (...statuses: string[]) => grouped.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0)
  const rewarded = count('REWARDED')
  return {
    code: code.code,
    link: baseUrl ? `${baseUrl}/signup?invite=${code.code}` : null,
    redeemed: count('PENDING', 'QUALIFIED', 'REWARDED', 'EXPIRED', 'REJECTED'),
    qualified: count('QUALIFIED', 'REWARDED'),
    rewarded,
    rewardCap: INVITE_REWARD_CAP,
    rewardsLeft: Math.max(INVITE_REWARD_CAP - rewarded, 0),
    xpPerInvite: REWARD_RULES.INVITE_QUALIFIED.amount ?? 0,
  }
}

// --- Redeeming -----------------------------------------------------------------------------------------------------------

export type RedeemOutcome =
  | { ok: true; kind: 'PERSONAL' | 'CAMPAIGN'; campusId: string | null }
  | { ok: false; code: 'INVITE_CODE_INVALID' | 'INVITE_ALREADY_REDEEMED' | 'INVITE_OWN_CODE' | 'INVITE_WINDOW_CLOSED' }

/** Whether a code can be used right now: not switched off, not expired, not used up. Whether it exists is the caller's question. */
export const isUsable = (code: Pick<InviteCode, 'disabledAt' | 'expiresAt' | 'maxUses' | 'uses'>, now: Date): boolean =>
  !code.disabledAt && !(code.expiresAt && code.expiresAt <= now) && !(code.maxUses !== null && code.uses >= code.maxUses)

/**
 * Whether a code as typed would be accepted by a sign-up or a redeem: for the sign-up page to say so before the person has an account. It answers yes or no and nothing
 * else (not whose code it is, what campus it names, or why it is not good), and the same no for a code that never existed, was switched off, ran out or expired.
 */
export async function checkInviteCode(db: Db, rawCode: string, now: Date = new Date()): Promise<boolean> {
  const normalized = normalizeCode(rawCode)
  const code = normalized ? await db.inviteCode.findUnique({ where: { code: normalized }, select: { disabledAt: true, expiresAt: true, maxUses: true, uses: true, ownerId: true } }) : null
  if (!code || !isUsable(code, now)) return false
  // A personal code whose owner is gone cannot be redeemed either (redeemInvite).
  if (code.ownerId) {
    const owner = await db.user.findUnique({ where: { id: code.ownerId }, select: { deletedAt: true } })
    if (!owner || owner.deletedAt) return false
  }
  return true
}

export async function redeemInvite(db: Db, userId: string, rawCode: string, now: Date = new Date()): Promise<RedeemOutcome> {
  const normalized = normalizeCode(rawCode)
  const code = normalized ? await db.inviteCode.findUnique({ where: { code: normalized } }) : null
  // One answer for a code that does not exist, was switched off, ran out or expired: a person trying codes learns nothing from the difference.
  if (!code || !isUsable(code, now)) return { ok: false, code: 'INVITE_CODE_INVALID' }
  if (code.ownerId === userId) return { ok: false, code: 'INVITE_OWN_CODE' }

  const invitee = await db.user.findUnique({ where: { id: userId }, select: { createdAt: true, email: true, deletedAt: true } })
  if (!invitee || invitee.deletedAt) return { ok: false, code: 'INVITE_CODE_INVALID' }
  if (now.getTime() - invitee.createdAt.getTime() > INVITE_WINDOW_DAYS * DAY_MS) return { ok: false, code: 'INVITE_WINDOW_CLOSED' }
  if (await db.inviteRedemption.findUnique({ where: { inviteeId: userId }, select: { id: true } })) return { ok: false, code: 'INVITE_ALREADY_REDEEMED' }

  // Rejected up front, and quietly: telling the person why would teach them what to change.
  let reason: string | null = null
  if (code.ownerId) {
    const owner = await db.user.findUnique({ where: { id: code.ownerId }, select: { email: true, deletedAt: true } })
    if (!owner || owner.deletedAt) return { ok: false, code: 'INVITE_CODE_INVALID' }
    if (canonicalEmail(owner.email) === canonicalEmail(invitee.email)) reason = 'SAME_EMAIL'
  }

  try {
    await db.$transaction(async (tx) => {
      // The count and the limit are checked in one statement, so two people redeeming the last use do not both get it.
      const claimed = await tx.$executeRaw`UPDATE "InviteCode" SET "uses" = "uses" + 1 WHERE "id" = ${code.id} AND ("maxUses" IS NULL OR "uses" < "maxUses")`
      if (claimed === 0) throw new CodeUsedUp()
      await tx.inviteRedemption.create({
        data: { codeId: code.id, inviteeId: userId, inviterId: code.ownerId, status: reason ? 'REJECTED' : 'PENDING', reason, redeemedAt: now },
      })
      if (reason) await tx.integritySignal.create({ data: { kind: 'invite_suspect', userId: code.ownerId, subjectType: 'INVITE', subjectId: code.id, data: { reason, inviteeId: userId } } })
    })
  } catch (error) {
    if (error instanceof CodeUsedUp) return { ok: false, code: 'INVITE_CODE_INVALID' }
    if (isUnique(error)) return { ok: false, code: 'INVITE_ALREADY_REDEEMED' }
    throw error
  }
  await track(userId, 'invite_redeemed', { kind: code.kind })
  return { ok: true, kind: code.kind, campusId: code.campusId }
}

class CodeUsedUp extends Error {}

// --- Qualifying and paying -------------------------------------------------------------------------------------------------

export interface QualifyResult {
  considered: number
  qualified: number
  rewarded: number
  waiting: number
  rejected: number
  expired: number
}

async function onboardingDone(db: Db, userId: string): Promise<boolean> {
  const [row, skillCount] = await Promise.all([db.user.findUnique({ where: { id: userId }, select: { headline: true, birthDate: true } }), db.userSkill.count({ where: { userId } })])
  return isOnboardingComplete({ headline: row?.headline, skillCount, hasBirthDate: Boolean(row?.birthDate) }, env.BIRTH_DATE_REQUIRED)
}

async function hasHighRisk(db: Db, userId: string): Promise<boolean> {
  return effectiveLevel(await db.userRisk.findUnique({ where: { userId }, select: { level: true, overrideLevel: true } })) === 'HIGH'
}

/** The first reason an invite must not pay its inviter, or null. */
async function rejectionReason(db: Db, inviterId: string, inviteeId: string): Promise<string | null> {
  const [inviter, invitee] = await Promise.all([
    db.user.findUnique({ where: { id: inviterId }, select: { email: true, deletedAt: true } }),
    db.user.findUnique({ where: { id: inviteeId }, select: { email: true, deletedAt: true } }),
  ])
  if (!inviter || inviter.deletedAt || !invitee || invitee.deletedAt) return 'GONE'
  if (canonicalEmail(inviter.email) === canonicalEmail(invitee.email)) return 'SAME_EMAIL'
  if ((await hasHighRisk(db, inviterId)) || (await hasHighRisk(db, inviteeId))) return 'RISK'
  const collusion = await db.fraudSignal.count({ where: { status: 'OPEN', memberIds: { hasEvery: [inviterId, inviteeId] } } })
  if (collusion > 0) return 'FRAUD'
  return null
}

async function markRejected(db: Db, redemptionId: string, reason: string, inviterId: string | null, inviteeId: string, codeId: string) {
  await db.$transaction(async (tx) => {
    await tx.inviteRedemption.update({ where: { id: redemptionId }, data: { status: 'REJECTED', reason } })
    if (reason !== 'GONE') await tx.integritySignal.create({ data: { kind: 'invite_suspect', userId: inviterId, subjectType: 'INVITE', subjectId: codeId, data: { reason, inviteeId } } })
  })
}

/** Pays the inviter for a qualified invite, if every check passes. Returns what became of it. */
async function payInviter(db: Db, redemption: { id: string; codeId: string; inviterId: string; inviteeId: string; qualifiedAt: Date | null }, now: Date): Promise<'REWARDED' | 'WAITING' | 'REJECTED'> {
  const { inviterId, inviteeId } = redemption
  const reason = await rejectionReason(db, inviterId, inviteeId)
  if (reason) {
    await markRejected(db, redemption.id, reason, inviterId, inviteeId, redemption.codeId)
    return 'REJECTED'
  }
  const paid = await db.inviteRedemption.count({ where: { inviterId, status: 'REWARDED' } })
  if (paid >= INVITE_REWARD_CAP) {
    await db.inviteRedemption.update({ where: { id: redemption.id }, data: { status: 'QUALIFIED', reason: 'CAP' } })
    return 'WAITING'
  }
  const distrust = await pairDistrust(db, { subjectId: inviterId, counterpartyId: inviteeId }, now)
  if (distrust === 'blocked') {
    await markRejected(db, redemption.id, 'BLOCKED', inviterId, inviteeId, redemption.codeId)
    return 'REJECTED'
  }
  if (distrust) {
    // A week old and a verified email are time and a click away: the payment waits for them.
    await db.inviteRedemption.update({ where: { id: redemption.id }, data: { status: 'QUALIFIED', reason: 'WAITING_TRUST' } })
    return 'WAITING'
  }
  const already = await db.xPEvent.findFirst({ where: { userId: inviterId, type: 'INVITE_QUALIFIED', dedupeKey: `invite:${redemption.id}` }, select: { id: true } })
  let rewarded = already !== null
  if (!rewarded) {
    const { value } = await transactWithEvents(db, async (tx) => (await emit(tx, 'INVITE_QUALIFIED', { userId: inviterId, otherUserId: inviteeId, redemptionId: redemption.id })).rewarded)
    rewarded = value
  }
  if (!rewarded) {
    // The day's cap: tomorrow.
    await db.inviteRedemption.update({ where: { id: redemption.id }, data: { status: 'QUALIFIED', reason: 'CAP' } })
    return 'WAITING'
  }
  await db.inviteRedemption.update({ where: { id: redemption.id }, data: { status: 'REWARDED', reason: null, rewardedAt: now } })
  return 'REWARDED'
}

const BATCH = 500

/**
 * The hourly job: moves open invites forward. A PENDING invite whose invitee finished onboarding and did a first real thing becomes QUALIFIED (and, for a personal code, its inviter is
 * paid when the checks pass); one that waits too long is let go. Safe to repeat.
 */
export async function qualifyInvites(db: Db, now: Date = new Date()): Promise<QualifyResult> {
  const result: QualifyResult = { considered: 0, qualified: 0, rewarded: 0, waiting: 0, rejected: 0, expired: 0 }
  const open = await db.inviteRedemption.findMany({
    where: { status: { in: ['PENDING', 'QUALIFIED'] } },
    orderBy: { redeemedAt: 'asc' },
    take: BATCH,
    select: { id: true, codeId: true, inviterId: true, inviteeId: true, status: true, redeemedAt: true, qualifiedAt: true, reason: true, code: { select: { kind: true } } },
  })
  result.considered = open.length
  for (const redemption of open) {
    try {
      const age = now.getTime() - redemption.redeemedAt.getTime()
      if (redemption.status === 'PENDING') {
        if (age > INVITE_EXPIRES_DAYS * DAY_MS) {
          await db.inviteRedemption.update({ where: { id: redemption.id }, data: { status: 'EXPIRED' } })
          result.expired += 1
          continue
        }
        // Onboarding finished AND a first real thing done, whenever in the account's life (the account is at most a few weeks old).
        if (!(await onboardingDone(db, redemption.inviteeId)) || !(await didMeaningfulAction(db, redemption.inviteeId, new Date(0), new Date(now.getTime() + 1)))) continue
        await db.inviteRedemption.update({ where: { id: redemption.id }, data: { status: 'QUALIFIED', qualifiedAt: now } })
        await track(redemption.inviteeId, 'invite_qualified', { kind: redemption.code.kind })
        result.qualified += 1
        redemption.qualifiedAt = now
      } else if (age > INVITE_REWARD_EXPIRES_DAYS * DAY_MS) {
        await db.inviteRedemption.update({ where: { id: redemption.id }, data: { status: 'EXPIRED' } })
        result.expired += 1
        continue
      }
      // A campaign code (no inviter) stops at QUALIFIED. A personal one pays its owner.
      if (redemption.code.kind !== 'PERSONAL' || !redemption.inviterId) continue
      const outcome = await payInviter(db, { id: redemption.id, codeId: redemption.codeId, inviterId: redemption.inviterId, inviteeId: redemption.inviteeId, qualifiedAt: redemption.qualifiedAt }, now)
      if (outcome === 'REWARDED') result.rewarded += 1
      else if (outcome === 'WAITING') result.waiting += 1
      else result.rejected += 1
    } catch (error) {
      log.error('could not move an invite forward', { error, redemptionId: redemption.id })
    }
  }
  log.info('invite run', { ...result })
  return result
}

export async function runQualifyInvitesJob(): Promise<QualifyResult> {
  const { prisma } = await import('@/lib/prisma')
  return qualifyInvites(prisma)
}
