import { createHash } from 'crypto'
import type { Prisma, PrismaClient, ReportTarget } from '@prisma/client'
import type { NextResponse } from 'next/server'
import { errorResponse } from '@/lib/api/errors'
import { getCache, type Cache } from '@/lib/infra/cache'
import { log } from '@/lib/log'
import { fileAutomatedReport } from '@/lib/moderation/reports'
import { checkContent, REPEAT_LIMITS, type ContentSurface, type ContentVerdict } from './content'

// The content checks in a request (content.ts is the pure rulebook): counts how often the writer sent the same text lately, answers a refusal as 400
// CONTENT_REJECTED, and for a flagged text files an automatic report (for a moderator) and an integrity signal (for the risk score) once it is saved.

type Db = PrismaClient | Prisma.TransactionClient

const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

/** Checks a text, counting it as sent once more by `userId` (repeats are counted across surfaces, for ten minutes). */
export async function screenText(userId: string, text: string, surface: ContentSurface, cache: Cache = getCache()): Promise<ContentVerdict> {
  let repeats = 0
  const body = normalise(text)
  if (body.length >= 8) {
    try {
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 24)
      repeats = (await cache.hit(`repeat:${userId}:${hash}`, REPEAT_LIMITS.windowMinutes * 60_000)).count - 1
    } catch (error) {
      log.warn('could not count repeated content', { error })
    }
  }
  return checkContent(text, { surface, repeats })
}

export function contentRejection(verdict: ContentVerdict): NextResponse {
  return errorResponse('CONTENT_REJECTED', { params: { reasons: verdict.reasons.join(', ') }, details: { reasons: verdict.reasons } })
}

/** After a flagged text was saved: an automatic report for a moderator and a signal for the writer's risk score. Never throws. */
export async function recordFlag(db: Db, verdict: ContentVerdict, userId: string, target: { type: ReportTarget; id: string }): Promise<void> {
  if (verdict.verdict !== 'FLAG') return
  try {
    const reason = verdict.reasons.includes('BANNED_TERM') ? 'SCAM' : 'SPAM'
    await fileAutomatedReport(db, { targetType: target.type, targetId: target.id, reason, description: `Flagged by the content checks: ${verdict.reasons.join(', ')}`, details: { reasons: verdict.reasons, terms: verdict.terms } })
    await (db as PrismaClient).integritySignal.create({ data: { kind: 'CONTENT_FLAG', userId, subjectType: target.type, subjectId: target.id, data: { reasons: verdict.reasons } } })
  } catch (error) {
    log.warn('could not record a content flag', { error, userId })
  }
}
