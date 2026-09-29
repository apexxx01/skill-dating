import { NextRequest } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { blockRelation } from '@/lib/blocks'

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  userId: z.string().min(1).max(64).optional(),
  type: z.string().min(1).max(64).optional(),
})

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
  const skip = (page - 1) * limit

  const where: Prisma.ActivityWhereInput = { userId: ownerId, ...(type ? { type } : {}) }

  if (ownerId !== user.id) {
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } })
    if (!owner || (await blockRelation(prisma, user.id, ownerId)) === 'BLOCKED_BY_THEM') {
      return createApiError('User not found', 404)
    }
    where.OR = [
      { projectId: null },
      { project: { isPublic: true } },
      { project: { members: { some: { userId: user.id } } } },
    ]
  }

  const [activity, total] = await Promise.all([
    prisma.activity.findMany({ where, skip, take: limit, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: activitySelect }),
    prisma.activity.count({ where }),
  ])

  return createApiResponse({
    activity,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'activity:list' } })
