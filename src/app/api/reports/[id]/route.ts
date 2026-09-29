import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const updateReportSchema = z.object({
  status: z.enum(['REVIEWING', 'RESOLVED', 'DISMISSED']),
  reason: z.string().max(2000).optional(),
})

// Judgment call: allowed forward-only transitions. PENDING can move to any
// of the three next states (a moderator may resolve/dismiss immediately
// without first parking it in REVIEWING). REVIEWING can only be closed out
// to RESOLVED/DISMISSED. RESOLVED and DISMISSED are terminal — nothing
// (including re-opening back to PENDING/REVIEWING) is allowed from there;
// a report that needs to be revisited should get a fresh report/action
// trail rather than mutating a closed one.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['REVIEWING', 'RESOLVED', 'DISMISSED'],
  REVIEWING: ['RESOLVED', 'DISMISSED'],
  RESOLVED: [],
  DISMISSED: [],
}

const userSummarySelect = { id: true, name: true, username: true, image: true } as const

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  if (user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
    return createApiError('Forbidden', 403)
  }

  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('Report ID required', 400)
  }

  const bodyResult = await validateBody(updateReportSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { status: nextStatus, reason } = bodyResult.data

  const report = await prisma.report.findUnique({ where: { id } })
  if (!report) {
    return createApiError('Report not found', 404)
  }

  const allowed = ALLOWED_TRANSITIONS[report.status] ?? []
  if (!allowed.includes(nextStatus)) {
    return createApiError(
      `Cannot transition report from ${report.status} to ${nextStatus}`,
      400
    )
  }

  // Judgment call: the ModerationAction targets the REPORT itself
  // (targetType 'REPORT', targetId = report.id), not the reported user —
  // this action records that a moderator reviewed/closed *this report*,
  // which is distinct from any separate moderation action a moderator
  // might later take directly against the reported user (warn/suspend/ban),
  // and keeps the two audit trails from being conflated.
  const actionName =
    nextStatus === 'RESOLVED'
      ? 'REPORT_RESOLVED'
      : nextStatus === 'DISMISSED'
        ? 'REPORT_DISMISSED'
        : 'REPORT_MOVED_TO_REVIEWING'

  const [updatedReport] = await prisma.$transaction([
    prisma.report.update({
      where: { id },
      data: { status: nextStatus },
      include: {
        reporter: { select: userSummarySelect },
        reported: { select: userSummarySelect },
      },
    }),
    prisma.moderationAction.create({
      data: {
        moderatorId: user.id,
        targetId: report.id,
        targetType: 'REPORT',
        action: actionName,
        reason: reason ?? `Report transitioned from ${report.status} to ${nextStatus}`,
        metadata: { reportedId: report.reportedId, reporterId: report.reporterId, fromStatus: report.status, toStatus: nextStatus },
      },
    }),
    prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: actionName,
        targetType: 'REPORT',
        targetId: report.id,
        oldValue: { status: report.status },
        newValue: { status: nextStatus },
      },
    }),
  ])

  return createApiResponse(updatedReport)
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'reports:update' } })
