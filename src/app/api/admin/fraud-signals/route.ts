import { NextRequest } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { cursorParam, paginate } from '@/lib/api/pagination'

// GET /api/admin/fraud-signals?status=&cursor=: groups the nightly collusion run flagged (src/lib/integrity), newest first. Staff only.
const querySchema = z.object({
  status: z.enum(['OPEN', 'CONFIRMED', 'DISMISSED']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: cursorParam,
})

export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const where: Prisma.FraudSignalWhereInput = query.data.status ? { status: query.data.status } : {}
  const result = await paginate({
    cursor: query.data.cursor,
    page: 1,
    limit: query.data.limit,
    field: 'createdAt',
    direction: 'desc',
    where,
    find: (args) =>
      prisma.fraudSignal.findMany({
        ...args,
        select: { id: true, type: true, score: true, memberIds: true, evidence: true, status: true, windowStart: true, windowEnd: true, reviewedById: true, reviewedAt: true, createdAt: true },
      }),
    count: (w) => prisma.fraudSignal.count({ where: w }),
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')
  return createApiResponse({ signals: result.items, nextCursor: result.nextCursor })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:fraud-signals' } })
