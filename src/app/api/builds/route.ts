import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import type { Prisma } from '@prisma/client'
import { cursorParam, paginate } from '@/lib/api/pagination'
import { z } from 'zod'
import { blockedUserIds } from '@/lib/blocks'

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  hackathonId: z.string().max(64).optional(),
  cursor: cursorParam,
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const hackathonId = queryResult.data.hackathonId

  const hidden = await blockedUserIds(prisma, user.id)
  const where: Prisma.CurrentBuildWhereInput = { isPublic: true, ...(hidden.length ? { userId: { notIn: hidden } } : {}) }
  if (hackathonId) where.hackathonId = hackathonId

  const result = await paginate({
    cursor: queryResult.data.cursor,
    page,
    limit,
    field: 'updatedAt',
    direction: 'desc',
    where,
    find: (args) =>
      prisma.currentBuild.findMany({
        ...args,
        include: {
          user: { select: { id: true, name: true, username: true, image: true, headline: true } },
          hackathon: { select: { id: true, name: true, slug: true } },
        },
      }),
    count: (w) => prisma.currentBuild.count({ where: w }),
    sortOf: (row) => row.updatedAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  return createApiResponse({ builds: result.items, nextCursor: result.nextCursor, pagination: result.pagination })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'builds:list' } })
