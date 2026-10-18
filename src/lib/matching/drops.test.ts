import { describe, it, expect, vi } from 'vitest'
import { expireDrops, shuffledForDay } from './drops'

describe('shuffledForDay', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `user-${i}`)

  it('keeps everybody, once', () => {
    const shuffled = shuffledForDay(ids, new Date('2026-10-16T09:00:00Z'))
    expect([...shuffled].sort()).toEqual([...ids].sort())
  })

  it('is the same order all day and for any input order, and a different order on another day', () => {
    const morning = shuffledForDay(ids, new Date('2026-10-16T01:00:00Z'))
    expect(shuffledForDay(ids, new Date('2026-10-16T23:00:00Z'))).toEqual(morning)
    expect(shuffledForDay([...ids].reverse(), new Date('2026-10-16T12:00:00Z'))).toEqual(morning)
    expect(shuffledForDay(ids, new Date('2026-10-17T01:00:00Z'))).not.toEqual(morning)
  })

  it('is not simply the sorted order, so nobody is always first', () => {
    expect(shuffledForDay(ids, new Date('2026-10-16T09:00:00Z'))).not.toEqual([...ids].sort())
  })

  it('handles none and one', () => {
    expect(shuffledForDay([], new Date())).toEqual([])
    expect(shuffledForDay(['a'], new Date())).toEqual(['a'])
  })
})

describe('expireDrops', () => {
  it('moves only NEW drops past their time to EXPIRED, and says how many', async () => {
    const updateMany = vi.fn(async () => ({ count: 4 }))
    const now = new Date('2026-10-16T12:00:00Z')
    expect(await expireDrops({ drop: { updateMany } } as never, now)).toEqual({ expired: 4 })
    expect(updateMany).toHaveBeenCalledWith({ where: { status: 'NEW', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } })
  })
})
