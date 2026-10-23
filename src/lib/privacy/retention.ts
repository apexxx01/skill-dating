import type { PrismaClient } from '@prisma/client'
import { getStorage, type Storage } from '@/lib/infra/storage'
import { IDEMPOTENCY_TTL_MS } from '@/lib/api/idempotency'
import { sweepVerifications } from '@/lib/campus/campus'
import { log } from '@/lib/log'

// Data retention (docs/PRIVACY.md, "Retention"). How long each kind of record is kept after it stops being needed, and the nightly job
// `privacy/retention` that deletes what is older. Deletes go in batches so one run never holds a long transaction.
//
//   what                        kept for                       how
//   product analytics events    13 months                      ProductEvent rows deleted
//   idempotency keys            24 hours                       an expiry on the cache entry itself (src/lib/api/idempotency.ts); nothing to sweep
//   expired drops               90 days after they expired     Drop rows (status EXPIRED) deleted
//   resolved reports            2 years after resolution       Report rows (RESOLVED or DISMISSED) deleted, with their evidence snapshot
//   data export files           24 hours after they were made  the object is deleted and the row marked EXPIRED
//   email and push delivery log 90 days                        NotificationDelivery rows deleted (no content is in them)
//   activity days               25 months                      ActivityDay rows deleted (the metrics are kept: they hold no person)
//   campus verifications        1 hour after their code expired  the row, and with it the campus e-mail address it held, is deleted
//   "tell me when it opens"       180 days after the person was told  RomanceInterest rows deleted (a request nobody has been told about is kept until the person withdraws it)

export const RETENTION = {
  productEventsMonths: 13,
  idempotencyKeysMs: IDEMPOTENCY_TTL_MS,
  expiredDropsDays: 90,
  resolvedReportsYears: 2,
  exportFilesHours: 24,
  deliveryLogDays: 90,
  activityDaysMonths: 25,
  romanceInterestAnsweredDays: 180,
} as const

const BATCH = 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Pure: the moment before which each kind of record is old enough to delete. */
export function retentionCutoffs(now: Date) {
  const months = new Date(now)
  months.setUTCMonth(months.getUTCMonth() - RETENTION.productEventsMonths)
  const months25 = new Date(now)
  months25.setUTCMonth(months25.getUTCMonth() - RETENTION.activityDaysMonths)
  const years = new Date(now)
  years.setUTCFullYear(years.getUTCFullYear() - RETENTION.resolvedReportsYears)
  return {
    productEvents: months,
    expiredDrops: new Date(now.getTime() - RETENTION.expiredDropsDays * DAY_MS),
    resolvedReports: years,
    exportFiles: now,
    deliveryLog: new Date(now.getTime() - RETENTION.deliveryLogDays * DAY_MS),
    activityDays: months25,
    romanceInterest: new Date(now.getTime() - RETENTION.romanceInterestAnsweredDays * DAY_MS),
  }
}

async function deleteInBatches(find: () => Promise<{ id: string }[]>, remove: (ids: string[]) => Promise<unknown>): Promise<number> {
  let total = 0
  for (;;) {
    const ids = (await find()).map((row) => row.id)
    if (ids.length === 0) return total
    await remove(ids)
    total += ids.length
    if (ids.length < BATCH) return total
  }
}

export async function runRetention(db: PrismaClient, storage: Storage = getStorage(), now: Date = new Date()) {
  const cut = retentionCutoffs(now)
  const productEvents = await deleteInBatches(
    () => db.productEvent.findMany({ where: { createdAt: { lt: cut.productEvents } }, select: { id: true }, take: BATCH }),
    (ids) => db.productEvent.deleteMany({ where: { id: { in: ids } } })
  )
  const expiredDrops = await deleteInBatches(
    () => db.drop.findMany({ where: { status: 'EXPIRED', updatedAt: { lt: cut.expiredDrops } }, select: { id: true }, take: BATCH }),
    (ids) => db.drop.deleteMany({ where: { id: { in: ids } } })
  )
  const resolvedReports = await deleteInBatches(
    () => db.report.findMany({ where: { status: { in: ['RESOLVED', 'DISMISSED'] }, OR: [{ resolvedAt: { lt: cut.resolvedReports } }, { resolvedAt: null, updatedAt: { lt: cut.resolvedReports } }] }, select: { id: true }, take: BATCH }),
    (ids) => db.report.deleteMany({ where: { id: { in: ids } } })
  )
  const deliveryLog = await deleteInBatches(
    () => db.notificationDelivery.findMany({ where: { createdAt: { lt: cut.deliveryLog } }, select: { id: true }, take: BATCH }),
    (ids) => db.notificationDelivery.deleteMany({ where: { id: { in: ids } } })
  )
  let exportFiles = 0
  const due = await db.dataExport.findMany({ where: { status: 'READY', expiresAt: { lte: cut.exportFiles } }, select: { id: true, storageKey: true }, take: BATCH })
  for (const row of due) {
    try {
      if (row.storageKey) await storage.remove(row.storageKey)
      await db.dataExport.update({ where: { id: row.id }, data: { status: 'EXPIRED', storageKey: null } })
      exportFiles += 1
    } catch (error) {
      log.warn('could not remove an expired export file', { error, exportId: row.id })
    }
  }
  const activityDays = (await db.activityDay.deleteMany({ where: { day: { lt: cut.activityDays } } })).count
  const campusVerifications = await sweepVerifications(db, now)
  const romanceInterest = (await db.romanceInterest.deleteMany({ where: { notifiedAt: { lt: cut.romanceInterest } } })).count
  const result = { productEvents, expiredDrops, resolvedReports, exportFiles, deliveryLog, activityDays, campusVerifications, romanceInterest }
  log.info('retention finished', result)
  return result
}

export async function runRetentionJob(): Promise<unknown> {
  const { prisma } = await import('@/lib/prisma')
  return runRetention(prisma)
}
