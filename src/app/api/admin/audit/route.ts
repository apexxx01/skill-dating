import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { paginate } from '@/lib/api/pagination'
import { querySchema } from './schema'

export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const { actorId, targetId, targetType, action, limit, cursor } = query.data
  const where: Prisma.AuditEventWhereInput = {
    ...(actorId ? { userId: actorId } : {}),
    ...(targetId ? { targetId } : {}),
    ...(targetType ? { targetType } : {}),
    ...(action ? { action } : {}),
  }
  const result = await paginate({
    cursor,
    page: 1,
    limit,
    field: 'createdAt',
    direction: 'desc',
    where,
    find: (args) => prisma.auditEvent.findMany({ ...args, select: { id: true, userId: true, action: true, targetType: true, targetId: true, oldValue: true, newValue: true, createdAt: true } }),
    count: (w) => prisma.auditEvent.count({ where: w }),
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')
  return createApiResponse({ events: result.items, nextCursor: result.nextCursor })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:audit' } })
