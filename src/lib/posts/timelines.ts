import type { Prisma, PrismaClient } from '@prisma/client'
import { decodeKeysetCursor, keysetOrderBy, keysetPage, keysetWhere } from '@/lib/api/pagination'
import { loadViewerScope, toPostViews, visibleWhere, type PostView } from './posts'

// Chronological lists of posts: a project's timeline and a person's posts. Newest first, keyset-paged, and only what the viewer may see (visibility, blocks, soft delete).

type Db = PrismaClient

export interface TimelinePage {
  posts: PostView[]
  nextCursor: string | null
}

async function page(db: Db, viewerId: string, scoped: Prisma.ShipPostWhereInput, options: { cursor?: string; limit: number }): Promise<TimelinePage | 'INVALID_CURSOR'> {
  const scope = await loadViewerScope(db, viewerId)
  const base: Prisma.ShipPostWhereInput = { AND: [visibleWhere(scope), scoped] }
  let where = base
  if (options.cursor !== undefined) {
    const after = decodeKeysetCursor(options.cursor)
    if (!after) return 'INVALID_CURSOR'
    where = { AND: [base, keysetWhere('createdAt', 'desc', after)] }
  }
  const rows = await db.shipPost.findMany({ where, orderBy: keysetOrderBy('createdAt', 'desc') as Prisma.ShipPostOrderByWithRelationInput[], take: options.limit + 1 })
  const result = keysetPage(rows, options.limit, (row) => ({ sort: row.createdAt, id: row.id }))
  return { posts: await toPostViews(db, viewerId, result.items), nextCursor: result.nextCursor }
}

/** `null` when the project does not exist or the viewer may not see it (a private project's timeline is for its members). */
export async function projectTimeline(db: Db, viewerId: string, projectId: string, options: { cursor?: string; limit: number }): Promise<TimelinePage | 'INVALID_CURSOR' | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { isPublic: true, ownerId: true, members: { where: { userId: viewerId }, select: { userId: true } } } })
  if (!project) return null
  if (!project.isPublic && project.ownerId !== viewerId && project.members.length === 0) return null
  return page(db, viewerId, { projectId }, options)
}

/** A person's posts, including the ones they co-authored. `null` when they do not exist, are gone or are hidden from the viewer by a block. */
export async function userPosts(db: Db, viewerId: string, userId: string, options: { cursor?: string; limit: number }): Promise<TimelinePage | 'INVALID_CURSOR' | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { deletedAt: true } })
  if (!user || user.deletedAt) return null
  const scope = await loadViewerScope(db, viewerId)
  if (userId !== viewerId && scope.hidden.has(userId)) return null
  return page(db, viewerId, { OR: [{ authorId: userId }, { coAuthorIds: { has: userId } }] }, options)
}
