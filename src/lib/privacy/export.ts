import type { DataExport, PrismaClient } from '@prisma/client'
import { getStorage, StorageUnavailableError, type Storage } from '@/lib/infra/storage'
import { log } from '@/lib/log'
import { DATA_INVENTORY } from './inventory'

// The data export (GDPR Art. 15 and 20; DPDP Act s.11): everything the platform holds about a person, as one JSON file. A request makes a PENDING row
// and queues the job `privacy/export`; the job reads every table in the data inventory (inventory.ts) through each column that points at the person,
// leaves out what the inventory redacts (other people's identity, private notes, internal scores, secrets), writes the file to the bucket under
// exports/<user>/<export>.json and marks the row READY. The download link is a signed URL that lasts until the file expires, 24 hours after it was made;
// the retention job deletes the file then. One export at a time per person.

type Db = PrismaClient

export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000
/** Rows exported per table and column. A person over it gets the newest rows and a note saying so. */
export const EXPORT_ROWS_PER_TABLE = 10_000

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1)

export async function buildExport(db: Db, userId: string, now: Date = new Date()): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {}
  const truncated: string[] = []
  for (const [name, entry] of Object.entries(DATA_INVENTORY)) {
    if (entry.export === 'NONE') continue
    const model = name.split('_')[0]
    const delegate = (db as unknown as Record<string, { findMany(args: unknown): Promise<Record<string, unknown>[]> }>)[lowerFirst(model)]
    const via = model === 'User' ? ['id'] : (entry.exportVia ?? Object.keys(entry.fields))
    const rows: Record<string, unknown>[] = []
    for (const field of via) {
      const isList = field.endsWith('Ids')
      const found = await delegate.findMany({ where: isList ? { [field]: { has: userId } } : { [field]: userId }, take: EXPORT_ROWS_PER_TABLE })
      if (found.length === EXPORT_ROWS_PER_TABLE) truncated.push(`${model}.${field}`)
      for (const row of found) {
        // A row that points at the person twice (a connection to themselves cannot exist, but a match row has two sides) is listed once.
        if (rows.some((r) => r.id === row.id)) continue
        const copy = { ...row }
        for (const column of entry.redact ?? []) delete copy[column]
        rows.push(copy)
      }
    }
    if (rows.length > 0) data[model] = model === 'User' ? rows[0] : rows
  }
  return { format: 'skill-dating-export', version: 1, userId, generatedAt: now.toISOString(), truncated, data }
}

export async function requestExport(db: Db, userId: string, now: Date = new Date()): Promise<{ export: DataExport; created: boolean }> {
  const open = await db.dataExport.findFirst({ where: { userId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } })
  if (open) return { export: open, created: false }
  return { export: await db.dataExport.create({ data: { userId, createdAt: now } }), created: true }
}

/** The job: builds and stores one export. Safe to run twice (a READY export is left alone). */
export async function runExport(db: Db, exportId: string, storage: Storage = getStorage(), now: Date = new Date()): Promise<{ status: string }> {
  const row = await db.dataExport.findUnique({ where: { id: exportId } })
  if (!row || row.status !== 'PENDING') return { status: row?.status ?? 'MISSING' }
  try {
    const json = JSON.stringify(await buildExport(db, row.userId, now), null, 2)
    const key = `exports/${row.userId}/${row.id}.json`
    await storage.put(key, json, 'application/json')
    await db.dataExport.update({ where: { id: row.id }, data: { status: 'READY', storageKey: key, bytes: Buffer.byteLength(json), completedAt: now, expiresAt: new Date(now.getTime() + EXPORT_TTL_MS) } })
    await db.notification.create({ data: { userId: row.userId, type: 'SYSTEM', title: 'Your data export is ready', message: 'Download it within 24 hours from your privacy settings.', link: '/settings/privacy', metadata: { kind: 'DATA_EXPORT', exportId: row.id } } })
    await db.auditEvent.create({ data: { userId: row.userId, action: 'DATA_EXPORT_READY', targetType: 'DATA_EXPORT', targetId: row.id } })
    return { status: 'READY' }
  } catch (error) {
    log.error('data export failed', { error: error instanceof StorageUnavailableError ? 'storage unavailable' : error, exportId })
    await db.dataExport.update({ where: { id: row.id }, data: { status: 'FAILED' } })
    return { status: 'FAILED' }
  }
}

export async function runExportJob(data: { exportId: string }): Promise<unknown> {
  const { prisma } = await import('@/lib/prisma')
  return runExport(prisma, data.exportId)
}
