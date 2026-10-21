import type { PrismaClient } from '@prisma/client'
import { getStorage, type Storage } from '@/lib/infra/storage'
import { IDEMPOTENCY_TTL_MS } from '@/lib/api/idempotency'
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

export const RETENTION = {
  productEventsMonths: 13,
  idempotencyKeysMs: IDEMPOTENCY_TTL_MS,
  expiredDropsDays: 90,
  resolvedReportsYears: 2,
  exportFilesHours: 24,
} as const

const BATCH = 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Pure: the moment before which each kind of record is old enough to delete. */
export function retentionCutoffs(now: Date) {
  const months = new Date(now)
  months.setUTCMonth(months.getUTCMonth() - RETENTION.productEventsMonths)
  const years = new Date(now)
  years.setUTCFullYear(years.getUTCFullYear() - RETENTION.resolvedReportsYears)
  return { productEvents: months, expiredDrops: new Date(now.getTime() - RETENTION.expiredDropsDays * DAY_MS), resolvedReports: years, exportFiles: now }
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
  const result = { productEvents, expiredDrops, resolvedReports, exportFiles }
  log.info('retention finished', result)
  return result
}

export async function runRetentionJob(): Promise<unknown> {
  const { prisma } = await import('@/lib/prisma')
  return runRetention(prisma)
}
