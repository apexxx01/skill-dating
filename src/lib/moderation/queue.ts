import type { Prisma, PrismaClient } from '@prisma/client'
import { effectiveLevel } from '@/lib/integrity/risk'

// The moderation queue (GET /api/admin/queue): open reports, most urgent first (priority.ts), and pending appeals. Report detail
// (GET /api/admin/reports/{id}) carries the context a decision needs: the reported thing as it was reported and as it is now, the other reports about
// the same person, earlier actions, and both people's risk.

type Db = PrismaClient

const person = { id: true, username: true, name: true, image: true, role: true, createdAt: true, deletedAt: true } as const

export async function loadQueue(db: Db, options: { kind: 'reports' | 'appeals'; limit: number; offset: number; reason?: string }) {
  if (options.kind === 'appeals') {
    const appeals = await db.appeal.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      skip: options.offset,
      take: options.limit + 1,
      include: { action: true, user: { select: person } },
    })
    return { items: appeals.slice(0, options.limit).map((appeal) => ({ kind: 'APPEAL' as const, ...appeal })), hasMore: appeals.length > options.limit }
  }
  const where: Prisma.ReportWhereInput = { status: { in: ['PENDING', 'REVIEWING'] }, ...(options.reason ? { reason: options.reason as Prisma.EnumReportReasonFilter['equals'] } : {}) }
  const reports = await db.report.findMany({
    where,
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    skip: options.offset,
    take: options.limit + 1,
    include: { reporter: { select: person }, reported: { select: person } },
  })
  return { items: reports.slice(0, options.limit).map((report) => ({ kind: 'REPORT' as const, ...report })), hasMore: reports.length > options.limit }
}

async function riskOf(db: Db, userId: string | null) {
  if (!userId) return null
  const row = await db.userRisk.findUnique({ where: { userId } })
  return { score: row?.score ?? 0, level: row?.level ?? 'LOW', effectiveLevel: effectiveLevel(row), factors: row?.factors ?? {} }
}

export async function loadReportDetail(db: Db, id: string) {
  const report = await db.report.findUnique({ where: { id }, include: { reporter: { select: person }, reported: { select: person } } })
  if (!report) return null
  const [priorReports, priorActions, subjectRisk, reporterRisk, restrictions] = await Promise.all([
    db.report.findMany({ where: { reportedId: report.reportedId, id: { not: report.id } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, reason: true, status: true, targetType: true, source: true, createdAt: true } }),
    db.moderationAction.findMany({ where: { subjectUserId: report.reportedId }, orderBy: { createdAt: 'desc' }, take: 20, include: { appeal: { select: { id: true, status: true } } } }),
    riskOf(db, report.reportedId),
    riskOf(db, report.reporterId),
    db.userRestriction.findMany({ where: { userId: report.reportedId, liftedAt: null }, select: { kind: true, endsAt: true, createdAt: true } }),
  ])
  return { report, priorReports, priorActions, restrictions, risk: { subject: subjectRisk, reporter: reporterRisk } }
}
