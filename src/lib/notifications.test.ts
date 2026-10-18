import { describe, it, expect, vi } from 'vitest'
import { coalesceNotification, COALESCE_WINDOW_MS } from './notifications'

function fakeTx(muted = false) {
  const rows: Record<string, unknown>[] = []
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    notificationPreference: { findUnique: vi.fn(async () => (muted ? { enabled: false } : null)) },
    notification: {
      findUnique: vi.fn(async ({ where }: { where: { userId_coalesceKey: { userId: string; coalesceKey: string } } }) => rows.find((r) => r.userId === where.userId_coalesceKey.userId && r.coalesceKey === where.userId_coalesceKey.coalesceKey) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `n${rows.length + 1}`, isRead: false, ...data }
        rows.push(row)
        return row
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
    },
  }
  return { tx: tx as never, rows }
}
const input = (over: Record<string, unknown> = {}) => ({ userId: 'author', kind: 'PROPS' as const, title: 'Props', subject: 'props:p1', message: (n: number) => `${n} ${n === 1 ? 'person' : 'people'} gave Props to "Post"`, ...over })

describe('coalesceNotification', () => {
  const at = new Date('2026-10-18T10:05:00Z')

  it('makes one notification for the first event and counts the next ones in the same window into it', async () => {
    const { tx, rows } = fakeTx()
    await coalesceNotification(tx, { ...input(), now: at })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ count: 1, message: '1 person gave Props to "Post"', type: 'PROPS' })
    for (let i = 0; i < 11; i++) await coalesceNotification(tx, { ...input(), now: new Date(at.getTime() + (i + 1) * 60_000) })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ count: 12, message: '12 people gave Props to "Post"', isRead: false })
  })

  it('makes a read notification unread again and moves it to the present', async () => {
    const { tx, rows } = fakeTx()
    await coalesceNotification(tx, { ...input(), now: at })
    rows[0].isRead = true
    const later = new Date(at.getTime() + 600_000)
    await coalesceNotification(tx, { ...input(), now: later })
    expect(rows[0]).toMatchObject({ isRead: false, createdAt: later })
  })

  it('starts a new notification in the next window, and for another subject', async () => {
    const { tx, rows } = fakeTx()
    await coalesceNotification(tx, { ...input(), now: at })
    await coalesceNotification(tx, { ...input(), now: new Date(at.getTime() + COALESCE_WINDOW_MS) })
    await coalesceNotification(tx, { ...input({ subject: 'props:p2' }), now: at })
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.coalesceKey)).size).toBe(3)
  })

  it('writes nothing for a person who switched the kind off', async () => {
    const { tx, rows } = fakeTx(true)
    expect(await coalesceNotification(tx, { ...input(), now: at })).toBeNull()
    expect(rows).toEqual([])
  })

  it('takes the lock for its key before it reads', async () => {
    const { tx } = fakeTx()
    await coalesceNotification(tx, { ...input(), now: at })
    expect((tx as unknown as { $executeRaw: ReturnType<typeof vi.fn> }).$executeRaw).toHaveBeenCalledTimes(1)
  })
})
