import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateQuery, createApiResponse } from '@/lib/api/handler'
import { REPORT_REASONS } from '@/lib/moderation/reports'
import { loadQueue } from '@/lib/moderation/queue'

// GET /api/admin/queue?kind=reports|appeals&reason=&offset=: open reports, most urgent first (minor safety, the romance mode, impersonation, then by the
// reporter's standing and how many people reported it), or pending appeals, oldest first. Staff only.
const querySchema = z.object({
  kind: z.enum(['reports', 'appeals']).default('reports'),
  reason: z.enum(REPORT_REASONS).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
})

export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const { items, hasMore } = await loadQueue(prisma, query.data)
  return createApiResponse({ kind: query.data.kind, items, nextOffset: hasMore ? query.data.offset + query.data.limit : null })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:queue' } })
