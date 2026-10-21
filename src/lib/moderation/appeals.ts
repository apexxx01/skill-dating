import type { Appeal, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import type { ErrorCode } from '@/lib/api/errors'
import { reverseModerationAction } from './actions'
import { invalidateAccountState } from './restrictions'

// Appeals (POST /api/appeals): the person an action is about asks for it to be looked at again, once per action, while its appeal window is open. The
// appeal goes to the queue; a moderator other than the one who acted decides. OVERTURNED reverses the action (restrictions lifted, hidden content
// restored); UPHELD leaves it. Either way the person is told, and the decision is audited.

type Db = PrismaClient

export const appealSchema = z.object({ actionId: z.string().min(1).max(64), body: z.string().trim().min(10).max(5000) }).strict()
export const decideAppealSchema = z.object({ decision: z.enum(['UPHELD', 'OVERTURNED']), note: z.string().trim().max(2000).optional() }).strict()

type Failure = { ok: false; code: ErrorCode }

export async function fileAppeal(db: Db, userId: string, input: z.infer<typeof appealSchema>, now: Date = new Date()): Promise<{ ok: true; appeal: Appeal } | Failure> {
  const action = await db.moderationAction.findUnique({ where: { id: input.actionId }, include: { appeal: true } })
  // Somebody else's action does not exist as far as you are concerned.
  if (!action || action.subjectUserId !== userId) return { ok: false, code: 'MODERATION_ACTION_NOT_FOUND' }
  if (action.appeal) return { ok: false, code: 'APPEAL_EXISTS' }
  if (!action.appealableUntil || action.appealableUntil.getTime() < now.getTime() || action.reversedAt) return { ok: false, code: 'APPEAL_NOT_ALLOWED' }
  const appeal = await db.$transaction(async (tx) => {
    const created = await tx.appeal.create({ data: { actionId: action.id, userId, body: input.body, createdAt: now } })
    await tx.auditEvent.create({ data: { userId, action: 'APPEAL_FILED', targetType: 'MODERATION_ACTION', targetId: action.id, newValue: { appealId: created.id } } })
    return created
  })
  return { ok: true, appeal }
}

export async function decideAppeal(
  db: Db,
  input: { appealId: string; deciderId: string; decision: 'UPHELD' | 'OVERTURNED'; note?: string; now?: Date }
): Promise<{ ok: true; appeal: Appeal } | Failure> {
  const now = input.now ?? new Date()
  const appeal = await db.appeal.findUnique({ where: { id: input.appealId }, include: { action: true } })
  if (!appeal) return { ok: false, code: 'APPEAL_NOT_FOUND' }
  if (appeal.status !== 'PENDING') return { ok: false, code: 'APPEAL_ALREADY_DECIDED' }
  // A second pair of eyes: the moderator who acted does not decide the appeal.
  if (appeal.action.moderatorId === input.deciderId) return { ok: false, code: 'FORBIDDEN' }
  const decided = await db.$transaction(
    async (tx) => {
      if (input.decision === 'OVERTURNED') await reverseModerationAction(tx, { actionId: appeal.actionId, actorId: input.deciderId, reason: `Appeal overturned: ${input.note ?? ''}`.trim(), now }, { inTransaction: true })
      const row = await tx.appeal.update({ where: { id: appeal.id }, data: { status: input.decision, decidedById: input.deciderId, decisionNote: input.note ?? null, decidedAt: now } })
      await tx.auditEvent.create({ data: { userId: input.deciderId, action: `APPEAL_${input.decision}`, targetType: 'APPEAL', targetId: appeal.id, newValue: { actionId: appeal.actionId, note: input.note ?? null } } })
      await tx.notification.create({
        data: {
          userId: appeal.userId,
          type: 'SYSTEM',
          title: input.decision === 'OVERTURNED' ? 'Your appeal was accepted' : 'Your appeal was reviewed',
          message: input.decision === 'OVERTURNED' ? 'The action has been reversed.' : `The action stands.${input.note ? ` ${input.note}` : ''}`,
          link: '/settings/account',
          metadata: { kind: 'MODERATION', appealId: appeal.id },
        },
      })
      return row
    },
    { timeout: 30_000 }
  )
  await invalidateAccountState(appeal.userId)
  return { ok: true, appeal: decided }
}
