import { describe, it, expect } from 'vitest'
import { lfgCreateSchema, normalizeStack, rankLfgPosts } from './lfg'

const now = new Date('2026-10-20T12:00:00Z')
const post = (id: string, authorId: string, minutesAgo: number, timezone: string | null = null) => ({ id, authorId, timezone, createdAt: new Date(now.getTime() - minutesAgo * 60_000) })

describe('rankLfgPosts', () => {
  it('puts the best fit first, then the newer post, then the id', () => {
    const posts = [post('a', 'u1', 10), post('b', 'u2', 5), post('c', 'u3', 1), post('d', 'u4', 1)]
    const fit = new Map([['u1', 80], ['u2', 80], ['u3', 40]])
    expect(rankLfgPosts(posts, fit, { now }).map((p) => p.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('keeps posts within three hours of the zone asked for, and posts that named no zone', () => {
    const posts = [post('berlin', 'u1', 1, 'Europe/Berlin'), post('ny', 'u2', 2, 'America/New_York'), post('none', 'u3', 3), post('lisbon', 'u4', 4, 'Europe/Lisbon')]
    // Asked for UTC+1: Berlin (UTC+2 in October) and Lisbon (UTC+1) are near, New York (UTC-4) is five hours away.
    const kept = rankLfgPosts(posts, new Map(), { now, tzOffsetMinutes: 60 }).map((p) => p.id)
    expect(kept).toEqual(['berlin', 'none', 'lisbon'])
  })

  it('wraps around the date line', () => {
    const posts = [post('auckland', 'u1', 1, 'Pacific/Auckland'), post('samoa', 'u2', 2, 'Pacific/Pago_Pago')]
    // Auckland is UTC+13 in October and Pago Pago UTC-11: two hours apart across the date line.
    expect(rankLfgPosts(posts, new Map(), { now, tzOffsetMinutes: 13 * 60 }).map((p) => p.id)).toEqual(['auckland', 'samoa'])
  })
})

describe('the LFG post shape', () => {
  it('lower-cases the stack and keeps each tag once', () => {
    expect(normalizeStack([' React ', 'react', 'Go', ''])).toEqual(['react', 'go'])
  })

  it('needs a team for a TEAM post and none for a PERSON post, and at least one role', () => {
    expect(lfgCreateSchema.safeParse({ kind: 'TEAM', roles: ['FRONTEND'], note: 'hi' }).success).toBe(false)
    expect(lfgCreateSchema.safeParse({ kind: 'PERSON', teamId: 't', roles: ['FRONTEND'], note: 'hi' }).success).toBe(false)
    expect(lfgCreateSchema.safeParse({ kind: 'PERSON', roles: [], note: 'hi' }).success).toBe(false)
    expect(lfgCreateSchema.safeParse({ kind: 'PERSON', roles: ['FRONTEND'], note: 'hi', timezone: 'Mars/Olympus' }).success).toBe(false)
    expect(lfgCreateSchema.safeParse({ kind: 'PERSON', roles: ['FRONTEND'], note: 'hi', timezone: 'Asia/Kolkata' }).success).toBe(true)
  })
})
