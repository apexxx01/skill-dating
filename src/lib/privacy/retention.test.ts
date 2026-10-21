import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { RETENTION, retentionCutoffs, runRetention } from './retention'
import { MemoryStorage } from '@/lib/infra/storage.memory'

const now = new Date('2026-10-20T05:15:00Z')

describe('retention', () => {
  it('keeps what the policy says: 13 months, 24 hours, 90 days, 2 years, 24 hours', () => {
    expect(RETENTION).toEqual({ productEventsMonths: 13, idempotencyKeysMs: 86_400_000, expiredDropsDays: 90, resolvedReportsYears: 2, exportFilesHours: 24 })
  })

  it('computes the cutoffs', () => {
    const cut = retentionCutoffs(now)
    expect(cut.productEvents.toISOString()).toBe('2025-09-20T05:15:00.000Z')
    expect(cut.expiredDrops.toISOString()).toBe('2026-07-22T05:15:00.000Z')
    expect(cut.resolvedReports.toISOString()).toBe('2024-10-20T05:15:00.000Z')
    expect(cut.exportFiles).toEqual(now)
  })

  it('deletes in batches, removes export files and marks them expired', async () => {
    const storage = new MemoryStorage()
    await storage.put('exports/u1/e1.json', '{}', 'application/json')
    let eventPages = [[{ id: 'p1' }, { id: 'p2' }]]
    const db = {
      productEvent: { findMany: vi.fn(async () => eventPages.shift() ?? []), deleteMany: vi.fn(async () => ({ count: 2 })) },
      drop: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
      report: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
      dataExport: { findMany: vi.fn(async () => [{ id: 'e1', storageKey: 'exports/u1/e1.json' }]), update: vi.fn(async () => ({})) },
    }
    const result = await runRetention(db as never, storage, now)
    expect(result).toEqual({ productEvents: 2, expiredDrops: 0, resolvedReports: 0, exportFiles: 1 })
    expect(db.productEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { createdAt: { lt: retentionCutoffs(now).productEvents } } }))
    expect(storage.contents.has('exports/u1/e1.json')).toBe(false)
    expect(db.dataExport.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { status: 'EXPIRED', storageKey: null } })
    eventPages = []
  })
})
