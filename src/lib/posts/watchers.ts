import type { Prisma, PrismaClient } from '@prisma/client'
import { log } from '@/lib/log'
import { coalesceNotification } from '@/lib/notifications'
import { excerptOf } from './sanitize'

// Telling the people who watch a project that it has a new post. This is fan-out, so it is a Job (`posts/notify-watchers`), enqueued after the post commits, never work done inside the
// request: watchers are read in batches by id, each batch is filtered by who may see the post, and the notification to each is coalesced per project and hour ("3 new posts on X").

type Db = PrismaClient

export const WATCHER_BATCH = 500

export interface NotifyResult {
  notified: number
  /** Continue from here (another job), or null when every watcher has been looked at. */
  next: string | null
}

export async function notifyWatchers(db: Db, postId: string, after?: string, now: Date = new Date()): Promise<NotifyResult> {
  const post = await db.shipPost.findUnique({ where: { id: postId }, include: { project: { select: { name: true, slug: true } } } })
  if (!post || post.deletedAt || !post.projectId || !post.project) return { notified: 0, next: null }

  const watchers = await db.watch.findMany({
    where: { projectId: post.projectId, userId: { notIn: [post.authorId, ...post.coAuthorIds] }, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: 'asc' },
    take: WATCHER_BATCH,
    select: { id: true, userId: true },
  })
  const ids = watchers.map((watcher) => watcher.userId)
  const next = watchers.length === WATCHER_BATCH ? watchers[watchers.length - 1].id : null
  if (ids.length === 0) return { notified: 0, next }

  // Who may see it, for this batch: nobody who blocked or was blocked by the author; for a followers-only post, followers; for a crew-only one, members.
  const blocks = await db.block.findMany({ where: { OR: [{ blockerId: post.authorId, blockedId: { in: ids } }, { blockedId: post.authorId, blockerId: { in: ids } }] }, select: { blockerId: true, blockedId: true } })
  const blocked = new Set(blocks.flatMap((block) => [block.blockerId, block.blockedId]))
  let allowed: Set<string> | null = null
  if (post.visibility === 'FOLLOWERS') allowed = new Set((await db.follow.findMany({ where: { followeeId: post.authorId, followerId: { in: ids } }, select: { followerId: true } })).map((row) => row.followerId))
  if (post.visibility === 'CREW') {
    const [members, owner, teamMembers] = await Promise.all([
      db.projectMember.findMany({ where: { projectId: post.projectId, userId: { in: ids } }, select: { userId: true } }),
      db.project.findUnique({ where: { id: post.projectId }, select: { ownerId: true } }),
      post.teamId ? db.teamMember.findMany({ where: { teamId: post.teamId, userId: { in: ids } }, select: { userId: true } }) : Promise.resolve([]),
    ])
    allowed = new Set([...members.map((row) => row.userId), ...teamMembers.map((row) => row.userId), ...(owner ? [owner.ownerId] : [])])
  }

  let notified = 0
  for (const userId of ids) {
    if (blocked.has(userId) || (allowed && !allowed.has(userId))) continue
    try {
      await db.$transaction((tx: Prisma.TransactionClient) =>
        coalesceNotification(tx, {
          userId,
          kind: 'WATCH',
          title: 'New post',
          subject: `watch:${post.projectId}`,
          message: (count) => (count === 1 ? `New on ${post.project!.name}: ${excerptOf(post.title, 80)}` : `${count} new posts on ${post.project!.name}`),
          link: `/projects/${post.project!.slug}`,
          metadata: { postId, projectId: post.projectId },
          now,
        })
      )
      notified += 1
    } catch (error) {
      log.warn('could not notify a watcher', { error, postId, userId })
    }
  }
  return { notified, next }
}

/** What the job runs. A big list continues itself as another job, so no one run is long. */
export async function runNotifyWatchersJob(data: { postId: string; after?: string }): Promise<NotifyResult> {
  const { prisma } = await import('@/lib/prisma')
  const result = await notifyWatchers(prisma, data.postId, data.after)
  if (result.next) {
    const { getJobQueue } = await import('@/lib/infra/jobs')
    await getJobQueue().enqueue('posts/notify-watchers', { postId: data.postId, after: result.next }, { id: `watchers:${data.postId}:${result.next}` })
  }
  return result
}
