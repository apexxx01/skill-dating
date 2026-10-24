import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import type { Prisma } from '@prisma/client'
import { paginate } from '@/lib/api/pagination'
import { createReportSchema, fileReport } from '@/lib/moderation/reports'
import { querySchema } from './schema'

const userSummarySelect = { id: true, name: true, username: true, image: true } as const

// POST /api/reports: report a person or anything they made, from any surface (src/lib/moderation/reports.ts). Body: { targetType?, targetId?, reportedId?,
// reason, description? }; `reportedId` alone is a report about a person, as before. You can only report what you can see.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createReportSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const result = await fileReport(prisma, user.id, bodyResult.data)
  if (!result.ok) return createApiError(result.code, result.details !== undefined ? { details: result.details } : undefined)
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: result.report.id },
    include: { reporter: { select: userSummarySelect }, reported: { select: userSummarySelect } },
  })
  // The queue's internals (priority, the reporter's standing) are for staff.
  const { priority: _priority, metadata: _metadata, ...visible } = report
  return createApiResponse(visible, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'reports:create' } })

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  if (user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
    return createApiError('FORBIDDEN')
  }

  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const status = queryResult.data.status

  const where: Prisma.ReportWhereInput = {}
  if (status) where.status = status

  const result = await paginate({
    cursor: queryResult.data.cursor,
    page,
    limit,
    field: 'createdAt',
    direction: 'desc',
    where,
    find: (args) =>
      prisma.report.findMany({
        ...args,
        include: {
          reporter: { select: userSummarySelect },
          reported: { select: userSummarySelect },
        },
      }),
    count: (w) => prisma.report.count({ where: w }),
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  return createApiResponse({ reports: result.items, nextCursor: result.nextCursor, pagination: result.pagination })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'reports:list' } })
