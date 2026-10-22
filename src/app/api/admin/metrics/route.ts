import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { definitionsFor, metricsQuerySchema, parseRange, readSnapshots } from '@/lib/kpi/query'

// GET /api/admin/metrics?from=&to=&keys=: the numbers the nightly job measured (docs/METRICS.md), for a range of days (default the last 30), with what every key means. Admins only.
export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const query = validateQuery(metricsQuerySchema)(request)
  if (query instanceof Response) return query
  const range = parseRange(query.data)
  if (!range.ok) return createApiError('VALIDATION_FAILED', { details: { [range.field]: [range.message] } })
  const { rows, truncated, computedThrough } = await readSnapshots(prisma, range)
  return createApiResponse({ from: range.from, to: range.to, computedThrough, truncated, definitions: definitionsFor(range.keys), rows })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:metrics' } })
