import type { Prisma, PrismaClient } from '@prisma/client'
import type { ErrorCode } from '@/lib/api/errors'
import { emit, transactWithEvents } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { levelFor } from '@/lib/levels'
import { coalesceNotification } from '@/lib/notifications'
import { advisoryLock } from '@/lib/progress'
import { utcTimestamp } from '@/lib/sql'
import { canView, loadViewerScope } from './posts'
import { propWeight } from './props-weight'

// Props: a builder's respect for a post. One per (giver, post), never for your own post (or one you co-authored), never across a block. The weight comes from the giver's tier, the age
// of their account and how verified they are (props-weight.ts), is stored on the row and added to the post's `propsScore` in the same transaction. A giver the trust gate does not trust
// (an unverified email, an account under a week old) is recorded with weight 0: it counts for nothing and pays nothing. The author earns PROPS_RECEIVED through the rewards engine (small, daily capped, and
// only for a trusted giver), which also feeds the Props achievements. Bursts that look wrong are recorded as integrity signals for a person to look at later; nothing acts on them by itself.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

/** More than this many Props from one giver in ten minutes, or this many from accounts under 30 days old on one post, is recorded as a signal. */
export const VELOCITY = { windowMinutes: 10, perGiver: 30, newAccountsPerPost: 12, newAccountDays: 30 } as const

export type PropResult = { ok: true; created: boolean; propsScore: number; propsCount: number; weight: number } | { ok: false; code: ErrorCode }

async function recordSignal(tx: Tx, kind: string, subjectType: string, subjectId: string, userId: string | null, data: Prisma.InputJsonValue, now: Date): Promise<void> {
  // Once an hour per subject is enough for a person to look.
  const recent = await tx.integritySignal.findFirst({ where: { kind, subjectType, subjectId, createdAt: { gte: new Date(now.getTime() - 60 * 60_000) } }, select: { id: true } })
  if (!recent) await tx.integritySignal.create({ data: { kind, subjectType, subjectId, userId, data, createdAt: now } })
}

export async function giveProps(db: Db, giverId: string, postId: string, now: Date = new Date()): Promise<PropResult> {
  const post = await db.shipPost.findUnique({ where: { id: postId } })
  if (!post) return { ok: false, code: 'POST_NOT_FOUND' }
  const scope = await loadViewerScope(db, giverId)
  if (!canView(post, scope)) return { ok: false, code: 'POST_NOT_FOUND' }
  if (post.authorId === giverId || post.coAuthorIds.includes(giverId)) return { ok: false, code: 'CANNOT_PROP_OWN_POST' }

  const giver = await db.user.findUnique({ where: { id: giverId }, select: { createdAt: true, isEmailVerified: true, verificationLevel: true, xp: true } })
  if (!giver) return { ok: false, code: 'USER_NOT_FOUND' }
  const weight = propWeight({ tier: levelFor(giver.xp).tier, createdAt: giver.createdAt, isEmailVerified: giver.isEmailVerified, verificationLevel: giver.verificationLevel }, now)

  const outcome = await transactWithEvents(db, async (tx) => {
    await advisoryLock(tx, `prop:${postId}:${giverId}`)
    const existing = await tx.prop.findUnique({ where: { userId_postId: { userId: giverId, postId } } })
    if (existing) {
      const current = await tx.shipPost.findUniqueOrThrow({ where: { id: postId }, select: { propsScore: true, propsCount: true } })
      return { created: false, weight: existing.weight, ...current }
    }
    const prop = await tx.prop.create({ data: { userId: giverId, postId, weight, createdAt: now } })
    const updated = await tx.shipPost.update({ where: { id: postId }, data: { propsScore: { increment: weight }, propsCount: { increment: 1 } }, select: { propsScore: true, propsCount: true } })

    if (weight > 0) {
      await emit(tx, 'PROPS_RECEIVED', { userId: post.authorId, giverId, postId, propId: prop.id })
      const giverName = await tx.user.findUnique({ where: { id: giverId }, select: { name: true, username: true } })
      await coalesceNotification(tx, {
        userId: post.authorId,
        kind: 'PROPS',
        title: 'Props',
        subject: `props:${postId}`,
        message: (count) => (count === 1 ? `${giverName?.name || giverName?.username || 'Someone'} gave Props to "${post.title}"` : `${count} people gave Props to "${post.title}"`),
        link: `/posts/${postId}`,
        metadata: { postId },
        now,
      })
    }

    // Velocity: a giver giving far too many, or a post collecting too many from new accounts. Recorded, never acted on.
    const since = utcTimestamp(new Date(now.getTime() - VELOCITY.windowMinutes * 60_000))
    const givenLately = await tx.prop.count({ where: { userId: giverId, createdAt: { gte: new Date(now.getTime() - VELOCITY.windowMinutes * 60_000) } } })
    if (givenLately > VELOCITY.perGiver) await recordSignal(tx, 'PROP_VELOCITY_GIVER', 'USER', giverId, giverId, { givenLately, windowMinutes: VELOCITY.windowMinutes }, now)
    const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS "n" FROM "Prop" p JOIN "User" u ON u."id" = p."userId"
      WHERE p."postId" = ${postId} AND p."createdAt" >= ${since} AND u."createdAt" >= ${utcTimestamp(new Date(now.getTime() - VELOCITY.newAccountDays * 86_400_000))}
    `
    if (Number(n) > VELOCITY.newAccountsPerPost) await recordSignal(tx, 'PROP_VELOCITY_POST', 'POST', postId, post.authorId, { newAccounts: Number(n), windowMinutes: VELOCITY.windowMinutes }, now)
    return { created: true, weight, ...updated }
  })
  const value = outcome.value
  if (value.created) await track(giverId, 'props_given', { weighted: value.weight > 0 })
  return { ok: true, created: value.created, propsScore: Math.round(value.propsScore * 100) / 100, propsCount: value.propsCount, weight: value.weight }
}

/** Takes Props back. The score and count follow; the XP the author earned stays, and giving again pays nothing new (once per post and giver). */
export async function removeProps(db: Db, giverId: string, postId: string): Promise<{ propsScore: number; propsCount: number } | null> {
  const post = await db.shipPost.findUnique({ where: { id: postId }, select: { id: true, deletedAt: true } })
  if (!post || post.deletedAt) return null
  return db.$transaction(async (tx) => {
    await advisoryLock(tx, `prop:${postId}:${giverId}`)
    const existing = await tx.prop.findUnique({ where: { userId_postId: { userId: giverId, postId } } })
    if (existing) {
      await tx.prop.delete({ where: { id: existing.id } })
      await tx.shipPost.update({ where: { id: postId }, data: { propsScore: { decrement: existing.weight * existing.integrityWeight }, propsCount: { decrement: 1 } } })
    }
    const current = await tx.shipPost.findUniqueOrThrow({ where: { id: postId }, select: { propsScore: true, propsCount: true } })
    return { propsScore: Math.max(0, Math.round(current.propsScore * 100) / 100), propsCount: current.propsCount }
  })
}
