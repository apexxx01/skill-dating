import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { buildExport, runExport } from './export'
import { MemoryStorage } from '@/lib/infra/storage.memory'

const now = new Date('2026-10-20T00:00:00Z')

/** A database where every table answers with what `rows` holds for it, filtered by the column asked about. */
function fakeDb(rows: Record<string, Record<string, unknown>[]>) {
  const calls: { model: string; where: Record<string, unknown> }[] = []
  return new Proxy({ calls } as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          calls.push({ model: prop, where })
          const [[column, value]] = Object.entries(where)
          return (rows[prop] ?? []).filter((row) => (typeof value === 'object' && value !== null && 'has' in value ? (row[column] as string[]).includes((value as { has: string }).has) : row[column] === value))
        },
      }
    },
  })
}

describe('buildExport', () => {
  it('takes the person’s rows, drops redacted columns, and never reads the other side of a one-sided relation', async () => {
    const db = fakeDb({
      user: [{ id: 'u1', email: 'a@b.dev', passwordHash: 'secret' }],
      report: [{ id: 'r1', reporterId: 'u2', reportedId: 'u1', reason: 'SPAM', priority: 300, metadata: {}, snapshot: {} }],
      block: [{ id: 'b1', blockerId: 'u1', blockedId: 'u3' }, { id: 'b2', blockerId: 'u4', blockedId: 'u1' }],
      spark: [{ id: 's1', fromId: 'u1', toId: 'u5', openerHash: 'h' }, { id: 's2', fromId: 'u6', toId: 'u1', openerHash: 'h' }],
      shipPost: [{ id: 'p1', authorId: 'u7', coAuthorIds: ['u1'] }],
    })
    const file = (await buildExport(db as never, 'u1', now)) as { data: Record<string, any> }
    expect(file.data.User).toEqual({ id: 'u1', email: 'a@b.dev' })
    expect(file.data.Report).toEqual([{ id: 'r1', reportedId: 'u1', reason: 'SPAM' }])
    expect(file.data.Block.map((b: any) => b.id)).toEqual(['b1'])
    expect(file.data.Spark).toEqual([{ id: 's1', fromId: 'u1', toId: 'u5' }])
    expect(file.data.ShipPost.map((p: any) => p.id)).toEqual(['p1'])
    // Tables that are never exported are never read.
    const read = new Set((db as any).calls.map((c: any) => c.model))
    for (const model of ['auditEvent', 'userRisk', 'userReliability', 'session']) expect(read.has(model)).toBe(false)
  })
})

describe('runExport', () => {
  it('writes the file, marks the export READY for 24 hours, and tells the person', async () => {
    const storage = new MemoryStorage()
    const updates: Record<string, unknown>[] = []
    const db = Object.assign(fakeDb({ user: [{ id: 'u1' }] }), {
      dataExport: { findUnique: async () => ({ id: 'e1', userId: 'u1', status: 'PENDING' }), update: async ({ data }: { data: Record<string, unknown> }) => updates.push(data) },
      notification: { create: vi.fn(async () => ({})), findMany: async () => [] },
      auditEvent: { create: vi.fn(async () => ({})) },
    })
    expect(await runExport(db as never, 'e1', storage, now)).toEqual({ status: 'READY' })
    expect(updates[0]).toMatchObject({ status: 'READY', storageKey: 'exports/u1/e1.json', expiresAt: new Date('2026-10-21T00:00:00Z') })
    expect(JSON.parse(new TextDecoder().decode(storage.contents.get('exports/u1/e1.json')))).toMatchObject({ format: 'skill-dating-export', userId: 'u1' })
    expect(db.notification.create).toHaveBeenCalled()
  })
})
