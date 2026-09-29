import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse } from '@/lib/api/handler'
import { z } from 'zod'

// Self-scoped view of the caller's own outstanding/resolved team
// applications. Every other query against TeamApplication is scoped by
// teamId and gated to the team owner/admin (see [id]/applications and
// [id]/candidates) — this is the only place an applicant can see what
// happened to their own applications. Always scoped to the session's
// user.id; a userId is never accepted from the client.
const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN']).optional(),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const status = queryResult.data.status
  const skip = (page - 1) * limit

  const where = {
    userId: user.id,
    ...(status ? { status } : {}),
  }

  const [applications, total] = await Promise.all([
    prisma.teamApplication.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        team: { select: { id: true, name: true, slug: true } }
      }
    }),
    prisma.teamApplication.count({ where })
  ])

  return createApiResponse({
    applications,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'teams:my-applications' } })
