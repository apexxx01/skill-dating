import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'
import { cursorParam, paginate } from '@/lib/api/pagination'

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
  cursor: cursorParam,
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const status = queryResult.data.status

  const where = {
    userId: user.id,
    ...(status ? { status } : {}),
  }

  const result = await paginate({
    cursor: queryResult.data.cursor,
    page,
    limit,
    field: 'createdAt',
    direction: 'desc',
    where,
    find: (args) =>
      prisma.teamApplication.findMany({
        ...args,
        include: {
          team: { select: { id: true, name: true, slug: true } }
        }
      }),
    count: (w) => prisma.teamApplication.count({ where: w }),
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  return createApiResponse({ applications: result.items, nextCursor: result.nextCursor, pagination: result.pagination })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'teams:my-applications' } })
