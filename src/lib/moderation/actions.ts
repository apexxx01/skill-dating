import type { ModerationAction, Prisma, PrismaClient, ReportTarget, RestrictionKind } from '@prisma/client'
import { z } from 'zod'
import type { ErrorCode } from '@/lib/api/errors'
import { getStorage } from '@/lib/infra/storage'
import { log } from '@/lib/log'
import { deliverSoon } from '@/lib/notify/immediate'
import { invalidateAccountState, KIND_OF_FEATURE, type RestrictedFeature } from './restrictions'
import { applyContentEffect, resolveTarget } from './targets'
import { CONTENT_TARGETS, REPORT_TARGETS } from './target-types'

// Moderator actions (docs/SAFETY.md, "Moderation"). One function writes them all, in one transaction: the action row, its effect (content hidden or
// removed, a restriction), the reports it resolves, an audit event, and a notification to the person it is about. Every action can be reversed, and an
// overturned appeal reverses it; a reversal lifts restrictions and restores hidden content (removed text stays removed).
//
//   WARN              a notice to the person; nothing else changes. Not appealable.
//   HIDE_CONTENT      the content disappears for everyone but staff; reversible.
//   REMOVE_CONTENT    hidden and its text blanked (the report keeps the evidence). Needs a recent sign-in.
//   RESTRICT_FEATURE  romance, messaging or posting closed for N days (or until lifted).
//   SUSPEND           the account is closed for N days, except for appeals, its own data and deleting it.
//   BAN               closed until lifted. Needs a recent sign-in.
//   APPROVE_MEDIA     a photo the scanner was unsure about is let through.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export const MODERATION_ACTIONS = ['WARN', 'HIDE_CONTENT', 'REMOVE_CONTENT', 'RESTRICT_FEATURE', 'SUSPEND', 'BAN', 'APPROVE_MEDIA'] as const
export type ModerationActionName = (typeof MODERATION_ACTIONS)[number]

/** Actions that cannot be taken back cheaply: they need a session signed in within the last few minutes (src/lib/api/recent-auth.ts). */
export const DESTRUCTIVE_ACTIONS: readonly ModerationActionName[] = ['BAN', 'REMOVE_CONTENT']

export const REASON_CATEGORIES = ['SPAM', 'HARASSMENT', 'INAPPROPRIATE_CONTENT', 'FAKE_PROFILE', 'SCAM', 'COPYRIGHT', 'OTHER', 'IMPERSONATION', 'MINOR_SAFETY'] as const

/** How long after an action the person may appeal it. */
export const APPEAL_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export const actionSchema = z
  .object({
    action: z.enum(MODERATION_ACTIONS),
    targetType: z.enum(REPORT_TARGETS),
    targetId: z.string().min(1).max(64),
    reportId: z.string().min(1).max(64).optional(),
    category: z.enum(REASON_CATEGORIES),
    // What the moderator writes for the record (staff only).
    reason: z.string().trim().min(3).max(2000),
    // What the person is told, besides the category. Optional.
    noteToUser: z.string().trim().max(2000).optional(),
    feature: z.enum(['romance', 'messaging', 'posting']).optional(),
    durationDays: z.number().int().min(1).max(365).optional(),
  })
  .strict()

export type ActionInput = z.infer<typeof actionSchema>

export type ActionFailure = { ok: false; code: ErrorCode; params?: Record<string, string> }
const fail = (code: ErrorCode, params?: Record<string, string>): ActionFailure => ({ ok: false, code, ...(params ? { params } : {}) })

/** Pure: whether the action fits the target and has what it needs. */
export function checkActionShape(input: Pick<ActionInput, 'action' | 'targetType' | 'feature' | 'durationDays'>): ActionFailure | null {
  const content = (CONTENT_TARGETS as readonly string[]).includes(input.targetType)
  switch (input.action) {
    case 'HIDE_CONTENT':
    case 'REMOVE_CONTENT':
      if (!content || input.targetType === 'MEDIA' && input.action === 'HIDE_CONTENT') return fail('MODERATION_ACTION_INVALID', { target: input.targetType })
      return null
    case 'APPROVE_MEDIA':
      return input.targetType === 'MEDIA' ? null : fail('MODERATION_ACTION_INVALID', { target: input.targetType })
    case 'RESTRICT_FEATURE':
      return input.feature ? null : fail('VALIDATION_FAILED')
    case 'SUSPEND':
      return input.durationDays ? null : fail('VALIDATION_FAILED')
    default:
      return null
  }
}

const notificationText: Record<ModerationActionName, string> = {
  WARN: 'You received a warning from a moderator',
  HIDE_CONTENT: 'A moderator hid something you posted',
  REMOVE_CONTENT: 'A moderator removed something you posted',
  RESTRICT_FEATURE: 'A moderator limited part of your account',
  SUSPEND: 'Your account is suspended',
  BAN: 'Your account has been banned',
  APPROVE_MEDIA: 'Your photo was approved',
}

const CATEGORY_LABEL: Record<(typeof REASON_CATEGORIES)[number], string> = {
  SPAM: 'spam',
  HARASSMENT: 'harassment',
  INAPPROPRIATE_CONTENT: 'inappropriate content',
  FAKE_PROFILE: 'a fake profile',
  SCAM: 'a scam',
  COPYRIGHT: 'copyright',
  OTHER: 'a breach of the community rules',
  IMPERSONATION: 'impersonation',
  MINOR_SAFETY: 'the safety of minors',
}

/** A notice about one's own account: always written (not a switchable kind). */
async function notifySubject(tx: Tx, userId: string, title: string, message: string, actionId: string) {
  await tx.notification.create({ data: { userId, type: 'SYSTEM', title, message, link: '/settings/account', metadata: { kind: 'MODERATION', actionId } } })
}

function restrictionFor(input: ActionInput): { kind: RestrictionKind; days: number | null } | null {
  if (input.action === 'BAN') return { kind: 'BANNED', days: null }
  if (input.action === 'SUSPEND') return { kind: 'SUSPENDED', days: input.durationDays ?? null }
  if (input.action === 'RESTRICT_FEATURE' && input.feature) return { kind: KIND_OF_FEATURE[input.feature as RestrictedFeature], days: input.durationDays ?? null }
  return null
}

export async function applyModerationAction(
  db: Db,
  actor: { id: string; role: string },
  input: ActionInput,
  now: Date = new Date()
): Promise<{ ok: true; action: ModerationAction } | ActionFailure> {
  const shape = checkActionShape(input)
  if (shape) return shape
  const target = await resolveTarget(db, input.targetType as ReportTarget, input.targetId, null)
  if (!target) return fail('REPORT_TARGET_NOT_FOUND')
  if (target.ownerId === actor.id) return fail('FORBIDDEN')
  // Only an admin acts on a staff account.
  const subject = await db.user.findUnique({ where: { id: target.ownerId }, select: { role: true } })
  if (subject && subject.role !== 'USER' && actor.role !== 'ADMIN') return fail('FORBIDDEN')
  if (input.reportId && !(await db.report.findUnique({ where: { id: input.reportId }, select: { id: true } }))) return fail('REPORT_NOT_FOUND')

  const restriction = restrictionFor(input)
  const expiresAt = restriction?.days ? new Date(now.getTime() + restriction.days * DAY_MS) : null
  const appealable = !['WARN', 'APPROVE_MEDIA'].includes(input.action)
  let objectKeys: string[] = []

  const action = await db.$transaction(
    async (tx) => {
      const row = await tx.moderationAction.create({
        data: {
          moderatorId: actor.id,
          targetType: input.targetType,
          targetId: input.targetId,
          action: input.action,
          reason: input.reason,
          duration: restriction?.days ?? null,
          subjectUserId: target.ownerId,
          reportId: input.reportId ?? null,
          noteToUser: input.noteToUser ?? null,
          feature: input.feature ?? null,
          expiresAt,
          appealableUntil: appealable ? new Date(now.getTime() + APPEAL_WINDOW_DAYS * DAY_MS) : null,
          metadata: { category: input.category, snapshot: target.snapshot } as Prisma.InputJsonValue,
          createdAt: now,
        },
      })
      if (input.action === 'HIDE_CONTENT' || input.action === 'REMOVE_CONTENT' || input.action === 'APPROVE_MEDIA') {
        const effect = input.action === 'HIDE_CONTENT' ? 'HIDE' : input.action === 'REMOVE_CONTENT' ? 'REMOVE' : 'RESTORE'
        objectKeys = (await applyContentEffect(tx, input.targetType as ReportTarget, input.targetId, effect, now)).objectKeys
      }
      if (restriction) await tx.userRestriction.create({ data: { userId: target.ownerId, kind: restriction.kind, actionId: row.id, endsAt: expiresAt, createdAt: now } })

      // Every open report about the same thing is answered by this action.
      await tx.report.updateMany({
        where: {
          status: { in: ['PENDING', 'REVIEWING'] },
          OR: [...(input.reportId ? [{ id: input.reportId }] : []), { targetType: input.targetType as ReportTarget, targetId: input.targetType === 'USER' ? null : input.targetId, reportedId: target.ownerId }],
        },
        data: { status: 'RESOLVED', resolvedAt: now, resolvedById: actor.id },
      })
      await tx.auditEvent.create({
        data: {
          userId: actor.id,
          action: 'MODERATION_ACTION',
          targetType: input.targetType,
          targetId: input.targetId,
          newValue: { actionId: row.id, action: input.action, category: input.category, subjectUserId: target.ownerId, feature: input.feature ?? null, durationDays: restriction?.days ?? null, reportId: input.reportId ?? null },
        },
      })
      const because = `This was for ${CATEGORY_LABEL[input.category]}.`
      const until = expiresAt ? ` It lasts until ${expiresAt.toISOString().slice(0, 10)}.` : ''
      const appeal = appealable ? ' You can appeal within 30 days.' : ''
      await notifySubject(tx, target.ownerId, notificationText[input.action], [because + until + appeal, input.noteToUser].filter(Boolean).join(' '), row.id)
      return row
    },
    { timeout: 30_000 }
  )

  await invalidateAccountState(target.ownerId)
  // An account notice is time-critical: dispatched now, not at the next sweep (src/lib/notify/immediate.ts).
  deliverSoon(db, [target.ownerId])
  if (objectKeys.length > 0) {
    const storage = getStorage()
    for (const key of objectKeys) await storage.remove(key).catch((error) => log.warn('could not remove a moderated object', { error, key }))
  }
  return { ok: true, action }
}

/** Takes an action back: lifts what it restricted and restores what it hid. Audited, and the person is told. Null when there is no such action. */
export async function reverseModerationAction(
  db: Db | Tx,
  input: { actionId: string; actorId: string; reason: string; now?: Date },
  options: { inTransaction?: boolean } = {}
): Promise<ModerationAction | 'NOT_FOUND' | 'ALREADY'> {
  const now = input.now ?? new Date()
  const run = async (tx: Tx) => {
    const action = await tx.moderationAction.findUnique({ where: { id: input.actionId } })
    if (!action) return 'NOT_FOUND' as const
    if (action.reversedAt) return 'ALREADY' as const
    await tx.userRestriction.updateMany({ where: { actionId: action.id, liftedAt: null }, data: { liftedAt: now } })
    if (action.action === 'HIDE_CONTENT' || action.action === 'REMOVE_CONTENT') await applyContentEffect(tx, action.targetType as ReportTarget, action.targetId, 'RESTORE', now)
    const reversed = await tx.moderationAction.update({ where: { id: action.id }, data: { reversedAt: now, reversedById: input.actorId, reverseReason: input.reason } })
    await tx.auditEvent.create({ data: { userId: input.actorId, action: 'MODERATION_ACTION_REVERSED', targetType: action.targetType, targetId: action.targetId, newValue: { actionId: action.id, reason: input.reason } } })
    if (action.subjectUserId) await notifySubject(tx, action.subjectUserId, 'A moderation action was reversed', 'A moderator reviewed an action on your account and took it back.', action.id)
    return reversed
  }
  const result = options.inTransaction ? await run(db as Tx) : await (db as Db).$transaction(run, { timeout: 30_000 })
  if (typeof result !== 'string' && result.subjectUserId) {
    await invalidateAccountState(result.subjectUserId)
    deliverSoon(db as Db, [result.subjectUserId])
  }
  return result
}
