import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { resolveTarget } from '@/lib/moderation/targets'
import { loadReportDetail } from '@/lib/moderation/queue'

// GET /api/admin/reports/{id}: one report with what a decision needs: the reported thing as it was reported (snapshot) and as it is now, the other
// reports about the same person, earlier actions and their appeals, restrictions in force, and the risk of both people. Opening it marks it REVIEWING.
// Staff only.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop()!
  const detail = await loadReportDetail(prisma, id)
  if (!detail) return createApiError('REPORT_NOT_FOUND')
  const { report } = detail
  const current = await resolveTarget(prisma, report.targetType, report.targetId ?? report.reportedId, null)
  if (report.status === 'PENDING') {
    await prisma.report.update({ where: { id }, data: { status: 'REVIEWING' } })
    await prisma.auditEvent.create({ data: { userId: user.id, action: 'REPORT_OPENED', targetType: 'REPORT', targetId: id } })
  }
  return createApiResponse({ ...detail, report: { ...report, status: report.status === 'PENDING' ? 'REVIEWING' : report.status }, target: { asReported: report.snapshot, now: current?.snapshot ?? null } })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:report-detail' } })
