import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse } from '@/lib/api/handler'
import { loadQueue } from '@/lib/moderation/queue'
import { querySchema } from './schema'

export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const { items, hasMore } = await loadQueue(prisma, query.data)
  return createApiResponse({ kind: query.data.kind, items, nextOffset: hasMore ? query.data.offset + query.data.limit : null })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:queue' } })
