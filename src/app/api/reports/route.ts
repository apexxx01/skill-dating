import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { cursorParam, paginate } from '@/lib/api/pagination'

const REPORT_REASONS = [
  'SPAM',
  'HARASSMENT',
  'INAPPROPRIATE_CONTENT',
  'FAKE_PROFILE',
  'SCAM',
  'COPYRIGHT',
  'OTHER',
  // A person asking for their own locked date of birth to be corrected. The report is filed against themselves; an admin decides (docs/SAFETY.md).
  'BIRTHDATE_CORRECTION',
] as const

const createReportSchema = z
  .object({
    reportedId: z.string().min(1),
    reason: z.enum(REPORT_REASONS),
    description: z.string().max(5000).optional(),
  })
  .superRefine((value, ctx) => {
    // The one report that needs the words: an admin has to know what is wrong and what it should be.
    if (value.reason === 'BIRTHDATE_CORRECTION' && (value.description?.trim().length ?? 0) < 10) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['description'], message: 'Say what is wrong and what it should be (at least 10 characters)' })
    }
  })

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(['PENDING', 'REVIEWING', 'RESOLVED', 'DISMISSED']).optional(),
  cursor: cursorParam,
})

const userSummarySelect = { id: true, name: true, username: true, image: true } as const

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createReportSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { reportedId, reason, description } = bodyResult.data

  // A correction request is about one's own account and nobody else's; every other report is about somebody else.
  if (reason === 'BIRTHDATE_CORRECTION') {
    if (reportedId !== user.id) return createApiError('BIRTHDATE_CORRECTION_SELF_ONLY')
  } else if (reportedId === user.id) {
    return createApiError('CANNOT_REPORT_SELF')
  }

  const reportedUser = await prisma.user.findUnique({ where: { id: reportedId }, select: { id: true } })
  if (!reportedUser) {
    return createApiError('REPORTED_USER_NOT_FOUND')
  }

  // Judgment call: dedupe on (reporterId, reportedId) while a prior report
  // from this same reporter against this same user is still PENDING. Rather
  // than silently creating a second PENDING row (which would just let one
  // reporter spam a target's queue with duplicates) or silently returning
  // the old row as if it were a fresh 201, we surface the conflict
  // explicitly with 409 and hand back the existing report so the caller
  // knows exactly what's already in flight.
  const existingPending = await prisma.report.findFirst({
    where: { reporterId: user.id, reportedId, status: 'PENDING' },
  })
  if (existingPending) {
    return createApiError('REPORT_ALREADY_PENDING', { details: {
      existingReport: existingPending,
    } })
  }

  const report = await prisma.report.create({
    data: {
      reporterId: user.id,
      reportedId,
      reason,
      description,
    },
    include: {
      reporter: { select: userSummarySelect },
      reported: { select: userSummarySelect },
    },
  })

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: 'REPORT_CREATED',
      targetType: 'REPORT',
      targetId: report.id,
      newValue: { reportedId, reason },
    },
  })

  return createApiResponse(report, 201)
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
