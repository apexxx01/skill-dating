import { NextRequest, NextResponse } from 'next/server'
import { withAuth, validateQuery, createApiError } from '@/lib/api/handler'
import { metricsQuerySchema, parseRange, readSnapshots, snapshotsCsv } from '@/lib/kpi/query'

// GET /api/admin/metrics/export.csv?from=&to=&keys=: the same numbers as a CSV file, one line per day, metric and dimension. Admins only.
export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const query = validateQuery(metricsQuerySchema)(request)
  if (query instanceof Response) return query
  const range = parseRange(query.data)
  if (!range.ok) return createApiError('VALIDATION_FAILED', { details: { [range.field]: [range.message] } })
  const { rows } = await readSnapshots(prisma, range)
  return new NextResponse(snapshotsCsv(rows), {
    status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="metrics-${range.from}-to-${range.to}.csv"`, 'Cache-Control': 'no-store' },
  })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'admin:metrics-csv' } })
