import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const REPORT_REASONS = [
  'SPAM',
  'HARASSMENT',
  'INAPPROPRIATE_CONTENT',
  'FAKE_PROFILE',
  'SCAM',
  'COPYRIGHT',
  'OTHER',
] as const

const createReportSchema = z.object({
  reportedId: z.string().min(1),
  reason: z.enum(REPORT_REASONS),
  description: z.string().max(5000).optional(),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(['PENDING', 'REVIEWING', 'RESOLVED', 'DISMISSED']).optional(),
})

const userSummarySelect = { id: true, name: true, username: true, image: true } as const

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createReportSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { reportedId, reason, description } = bodyResult.data

  if (reportedId === user.id) {
    return createApiError('You cannot report yourself', 400)
  }

  const reportedUser = await prisma.user.findUnique({ where: { id: reportedId }, select: { id: true } })
  if (!reportedUser) {
    return createApiError('Reported user not found', 404)
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
    return createApiError('You already have a pending report against this user', 409, {
      existingReport: existingPending,
    })
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
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'reports:create' } })

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  if (user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
    return createApiError('Forbidden', 403)
  }

  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const status = queryResult.data.status
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = {}
  if (status) where.status = status

  const [reports, total] = await Promise.all([
    prisma.report.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        reporter: { select: userSummarySelect },
        reported: { select: userSummarySelect },
      },
    }),
    prisma.report.count({ where }),
  ])

  return createApiResponse({
    reports,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'reports:list' } })
