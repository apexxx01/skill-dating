import type { PrismaClient } from '@prisma/client'
import type { ErrorCode } from '@/lib/api/errors'
import { decodeKeysetCursor, keysetOrderBy, keysetPage, keysetWhere } from '@/lib/api/pagination'
import { blockRelation, blockedPeerIds } from '@/lib/blocks'
import { loadPersonSummaries } from '@/lib/matching/summary'
import { transactWithEvents } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { coalesceNotification } from '@/lib/notifications'
import { accountDistrust } from '@/lib/trust'

// Follows (user to user) and Watches (user to project). A follow sees the person's FOLLOWERS posts and gives their posts a boost in the feed; a watch gets a notification for posts on a
// project. Neither is a reward source. Blocks stop both; a follower the trust gate does not trust does not notify the person they follow.

type Db = PrismaClient

export type SocialResult = { ok: true; changed: boolean } | { ok: false; code: ErrorCode }

export async function follow(db: Db, followerId: string, followeeId: string, now: Date = new Date()): Promise<SocialResult> {
  if (followerId === followeeId) return { ok: false, code: 'CANNOT_FOLLOW_SELF' }
  const [followee, follower] = await Promise.all([
    db.user.findUnique({ where: { id: followeeId }, select: { id: true, deletedAt: true } }),
    db.user.findUnique({ where: { id: followerId }, select: { createdAt: true, isEmailVerified: true, name: true, username: true } }),
  ])
  if (!followee || followee.deletedAt || !follower) return { ok: false, code: 'USER_NOT_FOUND' }
  const relation = await blockRelation(db, followerId, followeeId)
  if (relation === 'BLOCKED_BY_ME') return { ok: false, code: 'USER_BLOCKED' }
  if (relation === 'BLOCKED_BY_THEM') return { ok: false, code: 'USER_NOT_FOUND' }

  const outcome = await transactWithEvents(db, async (tx) => {
    const made = await tx.follow.createMany({ data: [{ followerId, followeeId, createdAt: now }], skipDuplicates: true })
    if (made.count > 0 && accountDistrust(follower, now) === null) {
      await coalesceNotification(tx, {
        userId: followeeId,
        kind: 'FOLLOW',
        title: 'New follower',
        subject: 'follow',
        message: (count) => (count === 1 ? `${follower.name || follower.username} followed you` : `${count} people followed you`),
        link: `/users/${followerId}`,
        metadata: { followerId },
        now,
      })
    }
    return made.count > 0
  })
  if (outcome.value) await track(followerId, 'follow_created')
  return { ok: true, changed: outcome.value }
}

export async function unfollow(db: Db, followerId: string, followeeId: string): Promise<{ changed: boolean }> {
  const removed = await db.follow.deleteMany({ where: { followerId, followeeId } })
  return { changed: removed.count > 0 }
}

/** Watching a project the person can see (public, or one they belong to). */
export async function watch(db: Db, userId: string, projectId: string): Promise<SocialResult> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { isPublic: true, ownerId: true, members: { where: { userId }, select: { userId: true } } } })
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND' }
  if (!project.isPublic && project.ownerId !== userId && project.members.length === 0) return { ok: false, code: 'PROJECT_NOT_FOUND' }
  const made = await db.watch.createMany({ data: [{ userId, projectId }], skipDuplicates: true })
  return { ok: true, changed: made.count > 0 }
}

export async function unwatch(db: Db, userId: string, projectId: string): Promise<{ changed: boolean }> {
  const removed = await db.watch.deleteMany({ where: { userId, projectId } })
  return { changed: removed.count > 0 }
}

// --- Lists --------------------------------------------------------------------------------------------------

export interface FollowPerson {
  id: string
  username: string
  name: string | null
  image: string | null
  level: number
  tier: string
  followedAt: string
}

/** Who follows `userId` (`direction: 'followers'`) or whom they follow (`'following'`), newest first. People the viewer has a block with, in either direction, are left out. */
export async function listFollows(
  db: Db,
  viewerId: string,
  userId: string,
  direction: 'followers' | 'following',
  options: { cursor?: string; limit: number }
): Promise<{ people: FollowPerson[]; nextCursor: string | null } | 'INVALID_CURSOR' | null> {
  const subject = await db.user.findUnique({ where: { id: userId }, select: { deletedAt: true } })
  if (!subject || subject.deletedAt) return null
  if (userId !== viewerId && (await blockRelation(db, viewerId, userId))) return null
  const hidden = await blockedPeerIds(db, viewerId)

  const side = direction === 'followers' ? 'followerId' : 'followeeId'
  const anchor = direction === 'followers' ? 'followeeId' : 'followerId'
  let cursorWhere = {}
  if (options.cursor !== undefined) {
    const after = decodeKeysetCursor(options.cursor)
    if (!after) return 'INVALID_CURSOR'
    cursorWhere = keysetWhere('createdAt', 'desc', after)
  }
  const rows = await db.follow.findMany({
    where: { [anchor]: userId, ...(hidden.length > 0 ? { [side]: { notIn: hidden } } : {}), ...cursorWhere },
    orderBy: keysetOrderBy('createdAt', 'desc') as { createdAt: 'desc'; id: 'desc' }[],
    take: options.limit + 1,
  })
  const page = keysetPage(rows, options.limit, (row) => ({ sort: row.createdAt, id: row.id }))
  const people = await loadPersonSummaries(db, page.items.map((row) => row[side]))
  return {
    people: page.items.flatMap((row) => {
      const person = people.get(row[side])
      return person ? [{ id: person.id, username: person.username, name: person.name, image: person.image, level: person.level, tier: person.tier, followedAt: row.createdAt.toISOString() }] : []
    }),
    nextCursor: page.nextCursor,
  }
}
