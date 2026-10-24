import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { blockRelation } from '@/lib/blocks'
import { paginate } from '@/lib/api/pagination'
import { querySchema } from './schema'

const activitySelect = {
  id: true,
  userId: true,
  type: true,
  title: true,
  description: true,
  link: true,
  metadata: true,
  createdAt: true,
  project: { select: { id: true, name: true, slug: true } },
} as const

// A user's activity feed: their own in full, anyone else's limited to what the
// viewer is allowed to see. Activity tied to a project follows that project's
// visibility (public, or the viewer is a member); activity tied to no project
// (achievements, hackathon and team milestones) is public.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const { userId, type } = queryResult.data
  const ownerId = userId ?? user.id
  const where: Prisma.ActivityWhereInput = { userId: ownerId, ...(type ? { type } : {}) }

  if (ownerId !== user.id) {
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } })
    if (!owner || (await blockRelation(prisma, user.id, ownerId)) === 'BLOCKED_BY_THEM') {
      return createApiError('USER_NOT_FOUND')
    }
    where.OR = [
      { projectId: null },
      { project: { isPublic: true } },
      { project: { members: { some: { userId: user.id } } } },
    ]
  }

  const result = await paginate({
    cursor: queryResult.data.cursor,
    page,
    limit,
    field: 'createdAt',
    direction: 'desc',
    where,
    find: (args) => prisma.activity.findMany({ ...args, select: activitySelect }),
    count: (w) => prisma.activity.count({ where: w }),
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  return createApiResponse({ activity: result.items, nextCursor: result.nextCursor, pagination: result.pagination })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'activity:list' } })
