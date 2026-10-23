import type { Prisma, PrismaClient } from '@prisma/client'
import { afterCommit, canAfterCommit } from '@/lib/events'
import { getJobQueue } from '@/lib/infra/jobs'
import { log } from '@/lib/log'
import { isImmediateNotification } from './policy'

// Time-critical notifications are not left for the sweep (every three minutes, dispatch.ts): the moment one is written, a job is queued that delivers it. These are the kinds the
// policy marks `immediate` (policy.ts): a spark someone is entitled to see, a match, an invitation to a squad, the reminder a day before squad registration closes, and an account
// notice from a moderator. Everything else, and the digests, stay batched.
//
// "Immediately" means no waiting for the sweep. It does not skip anything the pipeline decides: the person's switches, quiet hours and limits apply to these like to any
// notification (decideDelivery), and a failure here changes nothing for the person, because the notification is still unswept and the next sweep takes it.

type Db = PrismaClient | Prisma.TransactionClient

/** How far back a notification can have been written and still be dispatched by this path; older ones are the sweep's. */
const LOOKBACK_MS = 15 * 60 * 1000
/** Notifications per queued job. */
export const IMMEDIATE_BATCH = 100

/**
 * Queues delivery of the immediate notifications these people have waiting (written lately, not yet swept). Call it once the rows are committed. Never throws: a notification not
 * dispatched here is dispatched by the sweep.
 */
export async function requestImmediateDelivery(db: PrismaClient, userIds: readonly string[], now: Date = new Date()): Promise<number> {
  if (userIds.length === 0) return 0
  try {
    const rows = await db.notification.findMany({
      where: { userId: { in: [...userIds] }, sweptAt: null, createdAt: { gte: new Date(now.getTime() - LOOKBACK_MS) } },
      select: { id: true, type: true, metadata: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    })
    const ids = rows.filter(isImmediateNotification).map((row) => row.id)
    for (let i = 0; i < ids.length; i += IMMEDIATE_BATCH) await getJobQueue().enqueue('notifications/deliver-now', { ids: ids.slice(i, i + IMMEDIATE_BATCH) })
    return ids.length
  } catch (error) {
    log.warn('could not queue immediate delivery; the sweep will deliver', { error })
    return 0
  }
}

/**
 * Asks for immediate delivery for these people once the surrounding transaction commits (at once on a bare client). In a transaction that is not tracked (not opened with
 * transactWithEvents) there is no way to know when it commits, so nothing is asked and the sweep delivers, which is the same message a few minutes later.
 */
export function deliverSoon(db: Db, userIds: readonly string[]): void {
  if (userIds.length === 0 || !canAfterCommit(db)) return
  afterCommit(db, async () => {
    const { prisma } = await import('@/lib/prisma')
    await requestImmediateDelivery(prisma, userIds)
  })
}
