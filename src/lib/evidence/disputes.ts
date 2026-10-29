import type { PrismaClient, Report } from '@prisma/client'
import type { ErrorCode } from '@/lib/api/errors'
import { fileReport } from '@/lib/moderation/reports'

// Disputing a claim to a repository (POST /api/github/repos/{id}/dispute). Only somebody whose own authored work in that repository the engine verified
// may contest another person's claim to it; the dispute is an ordinary report (target EVIDENCE_CLAIM, reason CLAIM_DISPUTE) so it takes its place in the
// moderation queue by the queue's own rules, a moderator decides with the existing actions (HIDE_CONTENT hides the claim; audited), and its owner can
// appeal that decision through the existing appeals flow. Several disputes from one person in a month are an integrity signal.

export const REPEATED_DISPUTES_SIGNAL = 'EVIDENCE_REPEATED_DISPUTES'
/** Disputes by one person within 30 days from which each further one writes an integrity signal. */
export const REPEATED_DISPUTES_AT = 3
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

export type DisputeOutcome = { ok: true; report: Report } | { ok: false; code: ErrorCode; details?: unknown }

export async function fileClaimDispute(db: PrismaClient, disputerId: string, claimId: string, description: string, now: Date = new Date()): Promise<DisputeOutcome> {
  const claim = await db.githubRepoEvidence.findUnique({ where: { id: claimId }, select: { id: true, userId: true, repoGithubId: true, claimed: true, user: { select: { deletedAt: true } } } })
  if (!claim || !claim.claimed || claim.user.deletedAt) return { ok: false, code: 'CLAIM_NOT_FOUND' }
  if (claim.userId === disputerId) return { ok: false, code: 'CANNOT_REPORT_SELF' }
  const mine = await db.githubRepoEvidence.findUnique({ where: { userId_repoGithubId: { userId: disputerId, repoGithubId: claim.repoGithubId } }, select: { support: true, firstAuthoredAt: true } })
  if (!mine || mine.support !== 'SUPPORTED' || !mine.firstAuthoredAt) return { ok: false, code: 'DISPUTE_NOT_ALLOWED' }

  const filed = await fileReport(db, disputerId, { targetType: 'EVIDENCE_CLAIM', targetId: claim.id, reason: 'CLAIM_DISPUTE' as never, description }, now)
  if (!filed.ok) return filed

  const recent = await db.report.count({ where: { reporterId: disputerId, reason: 'CLAIM_DISPUTE', createdAt: { gte: new Date(now.getTime() - MONTH_MS) } } })
  if (recent >= REPEATED_DISPUTES_AT) {
    await db.integritySignal.create({ data: { kind: REPEATED_DISPUTES_SIGNAL, userId: disputerId, subjectType: 'USER', subjectId: disputerId, data: { disputesIn30Days: recent, latestReportId: filed.report.id }, createdAt: now } })
  }
  return filed
}
