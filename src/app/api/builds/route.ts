import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse } from '@/lib/api/handler'
import { z } from 'zod'
import { blockedUserIds } from '@/lib/blocks'

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  hackathonId: z.string().optional(),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const hackathonId = queryResult.data.hackathonId
  const skip = (page - 1) * limit

  const hidden = await blockedUserIds(prisma, user.id)
  const where: Record<string, unknown> = { isPublic: true, ...(hidden.length ? { userId: { notIn: hidden } } : {}) }
  if (hackathonId) where.hackathonId = hackathonId

  const [builds, total] = await Promise.all([
    prisma.currentBuild.findMany({
      where,
      skip,
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, username: true, image: true, headline: true } },
        hackathon: { select: { id: true, name: true, slug: true } },
      },
    }),
    prisma.currentBuild.count({ where }),
  ])

  return createApiResponse({
    builds,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'builds:list' } })
