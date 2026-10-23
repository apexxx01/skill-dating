import type { PrismaClient } from '@prisma/client'
import { romanceCopy } from './config'
import { romanceOpenAnywhere, romanceOpenForMany } from './launch'
import { loadFlags } from '@/lib/flags'
import { log } from '@/lib/log'
import { isLaunchGateFlag } from './launch-keys'

// The opening note: when the romance mode opens where somebody asked to be told (POST /api/romance/interest), they get ONE notification saying so. It runs hourly and right after an
// admin changes a launch flag (the flag routes enqueue it), and does nothing while the mode is closed. A request is answered once: the notification is keyed `romance:open` per person
// (the database allows one), and the request is stamped `notifiedAt`. The words come from romanceCopy (one place); the notification leaves the app as the neutral line like every romance kind.

type Db = Pick<PrismaClient, 'featureFlag' | 'profile' | 'romanceInterest' | 'notification' | '$transaction'>

export const ROMANCE_OPEN_KEY = 'romance:open'
const BATCH = 500

export interface AnnounceResult {
  checked: number
  notified: number
}

export async function runRomanceAnnounce(db: Db, now: Date = new Date()): Promise<AnnounceResult> {
  const result: AnnounceResult = { checked: 0, notified: 0 }
  if (!romanceOpenAnywhere(await loadFlags(db))) return result
  let after: string | undefined
  for (;;) {
    const waiting = await db.romanceInterest.findMany({
      where: { notifiedAt: null, user: { deletedAt: null }, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, userId: true },
      orderBy: { id: 'asc' },
      take: BATCH,
    })
    if (waiting.length === 0) break
    after = waiting[waiting.length - 1].id
    result.checked += waiting.length
    const open = await romanceOpenForMany(db, waiting.map((row) => row.userId))
    const ready = waiting.filter((row) => open.has(row.userId))
    if (ready.length > 0) {
      await db.$transaction(async (tx) => {
        const written = await tx.notification.createMany({
          data: ready.map((row) => ({
            userId: row.userId,
            type: 'SYSTEM' as const,
            title: romanceCopy.opened.title,
            message: romanceCopy.opened.message,
            link: '/romance',
            coalesceKey: ROMANCE_OPEN_KEY,
            createdAt: now,
            metadata: { kind: 'ROMANCE_OPEN' },
          })),
          skipDuplicates: true,
        })
        result.notified += written.count
        await tx.romanceInterest.updateMany({ where: { id: { in: ready.map((row) => row.id) } }, data: { notifiedAt: now } })
      })
    }
    if (waiting.length < BATCH) break
  }
  if (result.notified > 0) log.info('told people the romance mode opened', { ...result })
  return result
}

export async function runRomanceAnnounceJob(): Promise<AnnounceResult> {
  const { prisma } = await import('@/lib/prisma')
  return runRomanceAnnounce(prisma)
}

/** Called after an admin changes a flag: if it is one of the launch flags, the opening note goes out now rather than at the next hour. A failure to queue is logged; the hourly run is the fallback. */
export async function announceAfterFlagChange(key: string, now: Date = new Date()): Promise<void> {
  if (!isLaunchGateFlag(key)) return
  try {
    const { getJobQueue } = await import('@/lib/infra/jobs')
    await getJobQueue().enqueue('romance/announce', {}, { id: `romance-announce:${now.toISOString().slice(0, 16)}` })
  } catch (error) {
    log.warn('could not queue the romance opening note', { error, key })
  }
}
