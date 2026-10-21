import type { Prisma, PrismaClient, Report, ReportReason, ReportTarget } from '@prisma/client'
import { z } from 'zod'
import type { ErrorCode } from '@/lib/api/errors'
import { accountDistrust } from '@/lib/trust'
import { isHighRisk } from '@/lib/integrity/risk-job'
import { reportPriority, type ReasonName } from './priority'
import { resolveTarget, type ResolvedTarget } from './targets'
import { USER_REPORTABLE_TARGETS } from './target-types'

// Filing reports, by people (POST /api/reports, from any surface) and by the platform itself (flagged content, photos for review). A report about a thing
// keeps a snapshot of what it said, so an edit or a delete does not erase the evidence, and gets its place in the queue (priority.ts). When another
// person reports the same thing while it is open, every open report about it moves up.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export const REPORT_REASONS = [
  'SPAM',
  'HARASSMENT',
  'INAPPROPRIATE_CONTENT',
  'FAKE_PROFILE',
  'SCAM',
  'COPYRIGHT',
  'OTHER',
  'IMPERSONATION',
  'MINOR_SAFETY',
  // A person asking for their own locked date of birth to be corrected (docs/SAFETY.md). Filed against themselves.
  'BIRTHDATE_CORRECTION',
] as const

export const createReportSchema = z
  .object({
    // The thing reported; for USER, targetId is the person (and `reportedId` is accepted as before).
    targetType: z.enum(USER_REPORTABLE_TARGETS as unknown as [string, ...string[]]).default('USER'),
    targetId: z.string().min(1).max(64).optional(),
    reportedId: z.string().min(1).max(64).optional(),
    reason: z.enum(REPORT_REASONS),
    description: z.string().max(5000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.targetId && !value.reportedId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetId'], message: 'Say what you are reporting' })
    if (value.targetType !== 'USER' && !value.targetId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetId'], message: 'Say which one' })
    // The one report that needs the words: an admin has to know what is wrong and what it should be.
    if (value.reason === 'BIRTHDATE_CORRECTION' && (value.description?.trim().length ?? 0) < 10) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['description'], message: 'Say what is wrong and what it should be (at least 10 characters)' })
    }
  })

export type ReportInput = z.infer<typeof createReportSchema>

export type FileFailure = { ok: false; code: ErrorCode; details?: unknown }

const sameThing = (target: Pick<ResolvedTarget, 'type' | 'id' | 'ownerId'>): Prisma.ReportWhereInput =>
  target.type === 'USER' ? { targetType: 'USER', reportedId: target.ownerId } : { targetType: target.type, targetId: target.id }

/** Recomputes the priority of every open report about the thing, from the number of distinct people reporting it. */
async function reprioritise(tx: Tx, target: ResolvedTarget): Promise<void> {
  const open = await tx.report.findMany({ where: { ...sameThing(target), status: { in: ['PENDING', 'REVIEWING'] } }, select: { id: true, reporterId: true, reason: true, metadata: true } })
  const reporters = new Set(open.map((row) => row.reporterId).filter(Boolean))
  for (const row of open) {
    const reporter = (row.metadata as { reporterStanding?: { trusted: boolean; stronglyVerified: boolean; highRisk: boolean } } | null)?.reporterStanding ?? null
    const others = Math.max(0, reporters.size - (row.reporterId ? 1 : 0))
    const priority = reportPriority({ reason: row.reason as ReasonName, romance: target.romance, reporter: row.reporterId ? reporter : null, otherReporters: others })
    await tx.report.update({ where: { id: row.id }, data: { priority } })
  }
}

async function standingOf(db: Db, userId: string, now: Date) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { createdAt: true, isEmailVerified: true, verificationLevel: true } })
  return {
    trusted: accountDistrust(user, now) === null,
    stronglyVerified: ['PHONE', 'GITHUB', 'PORTFOLIO', 'ORGANIZATION', 'IDENTITY'].includes(user?.verificationLevel ?? 'NONE'),
    highRisk: await isHighRisk(db, userId),
  }
}

/** A person reports something they can see. */
export async function fileReport(db: Db, reporterId: string, input: ReportInput, now: Date = new Date()): Promise<{ ok: true; report: Report } | FileFailure> {
  const targetType = input.targetType as ReportTarget
  const targetId = targetType === 'USER' ? (input.targetId ?? input.reportedId)! : input.targetId!

  // A correction request is about one's own account and nobody else's; every other report is about somebody else.
  if (input.reason === 'BIRTHDATE_CORRECTION') {
    if (targetType !== 'USER' || targetId !== reporterId) return { ok: false, code: 'BIRTHDATE_CORRECTION_SELF_ONLY' }
  } else if (targetType === 'USER' && targetId === reporterId) return { ok: false, code: 'CANNOT_REPORT_SELF' }

  const target = await resolveTarget(db, targetType, targetId, input.reason === 'BIRTHDATE_CORRECTION' ? null : reporterId)
  if (!target) return { ok: false, code: targetType === 'USER' ? 'REPORTED_USER_NOT_FOUND' : 'REPORT_TARGET_NOT_FOUND' }
  if (input.reason !== 'BIRTHDATE_CORRECTION' && target.ownerId === reporterId) return { ok: false, code: 'CANNOT_REPORT_SELF' }

  // One open report per reporter and thing: a second one would only let one person flood the queue.
  const existing = await db.report.findFirst({ where: { reporterId, ...sameThing(target), status: 'PENDING' } })
  if (existing) return { ok: false, code: 'REPORT_ALREADY_PENDING', details: { existingReport: existing } }

  const standing = await standingOf(db, reporterId, now)
  const report = await db.$transaction(async (tx) => {
    const created = await tx.report.create({
      data: {
        reporterId,
        reportedId: target.ownerId,
        reason: input.reason as ReportReason,
        description: input.description,
        targetType,
        targetId: targetType === 'USER' ? null : targetId,
        source: 'USER',
        snapshot: target.snapshot as Prisma.InputJsonValue,
        metadata: { reporterStanding: standing },
        createdAt: now,
      },
    })
    await reprioritise(tx, target)
    await tx.auditEvent.create({ data: { userId: reporterId, action: 'REPORT_CREATED', targetType: 'REPORT', targetId: created.id, newValue: { reportedId: target.ownerId, reason: input.reason, targetType } } })
    return tx.report.findUniqueOrThrow({ where: { id: created.id } })
  })
  return { ok: true, report }
}

/** The platform files a report itself (content flagged by the checks, a photo the scanner was unsure about). Once per open thing and reason. */
export async function fileAutomatedReport(
  db: Db | Tx,
  input: { targetType: ReportTarget; targetId: string; reason: ReportReason; description: string; details?: Record<string, unknown> },
  now: Date = new Date()
): Promise<Report | null> {
  const tx = db as Tx
  const target = await resolveTarget(tx, input.targetType, input.targetId, null)
  if (!target) return null
  const open = await tx.report.findFirst({ where: { ...sameThing(target), source: 'AUTOMATED', reason: input.reason, status: { in: ['PENDING', 'REVIEWING'] } } })
  if (open) return open
  const created = await tx.report.create({
    data: {
      reporterId: null,
      reportedId: target.ownerId,
      reason: input.reason,
      description: input.description,
      targetType: input.targetType,
      targetId: input.targetType === 'USER' ? null : input.targetId,
      source: 'AUTOMATED',
      snapshot: target.snapshot as Prisma.InputJsonValue,
      metadata: (input.details ?? {}) as Prisma.InputJsonValue,
      priority: reportPriority({ reason: input.reason as ReasonName, romance: target.romance, reporter: null, otherReporters: 0 }),
      createdAt: now,
    },
  })
  return created
}
