import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { paginate } from '@/lib/api/pagination'
import { querySchema } from './schema'

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
