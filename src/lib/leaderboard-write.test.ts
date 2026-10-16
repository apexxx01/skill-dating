import { describe, it, expect, vi } from 'vitest'
import { MemoryCache } from './infra/cache.memory'
import { BOARDS_READY_KEY, loadMembership, rebuildBoards, recordBoardXp, refreshUserBoards } from './leaderboard-write'
import { boardKey, periodsAt } from './leaderboard-boards'

const now = new Date('2026-10-16T12:00:00Z')
const season = { id: 'season-1', endsAt: new Date('2026-12-11T00:00:00Z') }
const [weekly, monthly, seasonal, allTime] = periodsAt(now, season)

interface Setup {
  profile?: { hideFromLeaderboards?: boolean; countryCode?: string | null; cityKey?: string | null; campusKey?: string | null } | null
  season?: typeof season | null
  rows?: unknown[][]
  scores?: Record<string, number>[]
}

function fakeDb(setup: Setup = {}) {
  const queue = [...(setup.rows ?? [])]
  return {
    profile: {
      findUnique: vi.fn(async () =>
        setup.profile === null || setup.profile === undefined
          ? null
          : { hideFromLeaderboards: setup.profile.hideFromLeaderboards ?? false, countryCode: setup.profile.countryCode ?? null, cityKey: setup.profile.cityKey ?? null, campusKey: setup.profile.campusKey ?? null }
      ),
    },
    season: { findFirst: vi.fn(async () => (setup.season === undefined ? season : setup.season)) },
    $queryRaw: vi.fn(async () => queue.shift() ?? []),
  }
}

const score = async (cache: MemoryCache, period: { key: string }, scope: string, member: string) => cache.zscore(boardKey(period.key, scope), member)

describe('loadMembership', () => {
  it('reads a person’s place and privacy, with defaults for somebody with no profile', async () => {
    expect(await loadMembership(fakeDb({ profile: null }) as never, 'u1')).toEqual({ hidden: false, countryCode: null, cityKey: null, campusKey: null })
    expect(await loadMembership(fakeDb({ profile: { hideFromLeaderboards: true, countryCode: 'IN', cityKey: 'pune', campusKey: 'coep' } }) as never, 'u1')).toEqual({
      hidden: true,
      countryCode: 'IN',
      cityKey: 'pune',
      campusKey: 'coep',
    })
  })
})

describe('recordBoardXp', () => {
  it('adds an award to the global board of every period', async () => {
    const cache = new MemoryCache()
    await recordBoardXp(fakeDb() as never, cache, { userId: 'u1', amount: 50, at: now, seasonId: 'season-1' })
    for (const period of [weekly, monthly, seasonal, allTime]) expect(await score(cache, period, 'g', 'u1'), period.key).toBe(50)
  })

  it('keeps adding: scores are totals of the awards', async () => {
    const cache = new MemoryCache()
    const db = fakeDb() as never
    await recordBoardXp(db, cache, { userId: 'u1', amount: 50, at: now, seasonId: 'season-1' })
    await recordBoardXp(db, cache, { userId: 'u1', amount: 25, at: now, seasonId: 'season-1' })
    expect(await score(cache, weekly, 'g', 'u1')).toBe(75)
  })

  it('also adds to the boards of the person’s country, city and campus', async () => {
    const cache = new MemoryCache()
    const db = fakeDb({ profile: { countryCode: 'IN', cityKey: 'pune', campusKey: 'coep' } }) as never
    await recordBoardXp(db, cache, { userId: 'u1', amount: 30, at: now, seasonId: 'season-1' })
    for (const scope of ['g', 'c:IN', 'y:IN:pune', 'u:coep']) expect(await score(cache, allTime, scope, 'u1'), scope).toBe(30)
    expect(await score(cache, allTime, 'c:BR', 'u1')).toBeNull()
  })

  it('adds nothing for somebody who opted out of leaderboards', async () => {
    const cache = new MemoryCache()
    await recordBoardXp(fakeDb({ profile: { hideFromLeaderboards: true, countryCode: 'IN' } }) as never, cache, { userId: 'u1', amount: 50, at: now, seasonId: 'season-1' })
    expect(await score(cache, allTime, 'g', 'u1')).toBeNull()
    expect(await score(cache, allTime, 'c:IN', 'u1')).toBeNull()
  })

  it('adds nothing for an award of nothing', async () => {
    const cache = new MemoryCache()
    await recordBoardXp(fakeDb() as never, cache, { userId: 'u1', amount: 0, at: now, seasonId: null })
    expect(await score(cache, allTime, 'g', 'u1')).toBeNull()
  })

  it('puts an award on the season board it was stamped with, and on none for XP from before seasons', async () => {
    const cache = new MemoryCache()
    const db = fakeDb() as never
    await recordBoardXp(db, cache, { userId: 'u1', amount: 10, at: now, seasonId: 'season-1' })
    await recordBoardXp(db, cache, { userId: 'u2', amount: 10, at: now, seasonId: 'some-other-season' })
    await recordBoardXp(db, cache, { userId: 'u3', amount: 10, at: now, seasonId: null })
    expect(await score(cache, seasonal, 'g', 'u1')).toBe(10)
    expect(await score(cache, seasonal, 'g', 'u2')).toBeNull()
    expect(await score(cache, seasonal, 'g', 'u3')).toBeNull()
    // The other periods take all three.
    expect(await score(cache, allTime, 'g', 'u2')).toBe(10)
    expect(await score(cache, allTime, 'g', 'u3')).toBe(10)
  })

  it('has no season board between seasons', async () => {
    const cache = new MemoryCache()
    await recordBoardXp(fakeDb({ season: null }) as never, cache, { userId: 'u1', amount: 10, at: now, seasonId: null })
    expect(await score(cache, weekly, 'g', 'u1')).toBe(10)
    expect(await cache.zcard(boardKey(seasonal, 'g'))).toBe(0)
  })

  it('lets this week’s and this month’s boards expire, and not the all-time one', async () => {
    const clock = { now: now.getTime() }
    const cache = new MemoryCache(1000, () => clock.now)
    await recordBoardXp(fakeDb() as never, cache, { userId: 'u1', amount: 10, at: now, seasonId: 'season-1' })
    clock.now += 100 * 24 * 60 * 60 * 1000
    expect(await score(cache, weekly, 'g', 'u1')).toBeNull()
    expect(await score(cache, monthly, 'g', 'u1')).toBeNull()
    expect(await score(cache, allTime, 'g', 'u1')).toBe(10)
  })

  it('makes one call to the cache for the whole award, however many boards', async () => {
    const cache = new MemoryCache()
    const spy = vi.spyOn(cache, 'zincrMany')
    await recordBoardXp(fakeDb({ profile: { countryCode: 'IN', cityKey: 'pune', campusKey: 'coep' } }) as never, cache, { userId: 'u1', amount: 10, at: now, seasonId: 'season-1' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toHaveLength(4 * 4)
  })
})

describe('rebuildBoards', () => {
  const row = (userId: string, score: number, place: { countryCode?: string; cityKey?: string; campusKey?: string } = {}) => ({
    userId,
    score,
    countryCode: place.countryCode ?? null,
    cityKey: place.cityKey ?? null,
    campusKey: place.campusKey ?? null,
  })

  it('writes every board of every period from the log and marks the boards as built', async () => {
    const cache = new MemoryCache()
    const same = [row('a', 90, { countryCode: 'IN', cityKey: 'pune' }), row('b', 40, { countryCode: 'IN' }), row('c', 10)]
    const db = fakeDb({ rows: [same, same, same, same] })
    const result = await rebuildBoards(db as never, cache, now)
    expect(result.periods).toBe(4)
    expect(await score(cache, allTime, 'g', 'a')).toBe(90)
    expect(await score(cache, allTime, 'c:IN', 'b')).toBe(40)
    expect(await score(cache, allTime, 'c:IN', 'c')).toBeNull()
    expect(await score(cache, allTime, 'y:IN:pune', 'a')).toBe(90)
    expect(await score(cache, allTime, 'y:IN:pune', 'b')).toBeNull()
    expect(await cache.zcard(boardKey(allTime, 'g'))).toBe(3)
    expect(await cache.get(BOARDS_READY_KEY)).toBe(now.toISOString())
  })

  it('replaces a board whole: what was in the cache and is not in the log goes', async () => {
    const cache = new MemoryCache()
    await cache.zadd(boardKey(allTime, 'g'), 'stale', 999)
    await cache.zadd(boardKey(allTime, 'g'), 'a', 1)
    await rebuildBoards(fakeDb({ rows: [[], [], [], [row('a', 50)]] }) as never, cache, now)
    expect(await score(cache, allTime, 'g', 'stale')).toBeNull()
    expect(await score(cache, allTime, 'g', 'a')).toBe(50)
  })

  it('empties a global board when nobody has earned in the period', async () => {
    const cache = new MemoryCache()
    await cache.zadd(boardKey(weekly, 'g'), 'old', 5)
    await rebuildBoards(fakeDb({ rows: [[], [], [], []] }) as never, cache, now)
    expect(await cache.zcard(boardKey(weekly, 'g'))).toBe(0)
  })

  it('skips the season board between seasons', async () => {
    const cache = new MemoryCache()
    const result = await rebuildBoards(fakeDb({ season: null, rows: [[], [], []] }) as never, cache, now)
    expect(result.periods).toBe(3)
  })

  it('gives each period its own expiry', async () => {
    const clock = { now: now.getTime() }
    const cache = new MemoryCache(1000, () => clock.now)
    await rebuildBoards(fakeDb({ rows: [[row('a', 1)], [row('a', 1)], [row('a', 1)], [row('a', 1)]] }) as never, cache, now)
    clock.now += 100 * 24 * 60 * 60 * 1000
    expect(await score(cache, weekly, 'g', 'a')).toBeNull()
    expect(await score(cache, allTime, 'g', 'a')).toBe(1)
  })
})

describe('refreshUserBoards', () => {
  const placed = { hidden: false, countryCode: 'IN', cityKey: 'pune', campusKey: 'coep' }

  it('moves a person to the boards of their new place and off the old ones', async () => {
    const cache = new MemoryCache()
    for (const scope of ['g', 'c:IN', 'y:IN:pune', 'u:coep']) await cache.zadd(boardKey(allTime, scope), 'u1', 100)
    // They now live in Brazil, in Sao Paulo, with no campus.
    const db = fakeDb({ profile: { countryCode: 'BR', cityKey: 'sao-paulo' }, rows: [[{ score: 20 }], [{ score: 40 }], [{ score: 60 }], [{ score: 100 }]] })
    const result = await refreshUserBoards(db as never, cache, 'u1', placed, now)
    expect(result.added).toBeGreaterThan(0)
    expect(await score(cache, allTime, 'c:IN', 'u1')).toBeNull()
    expect(await score(cache, allTime, 'y:IN:pune', 'u1')).toBeNull()
    expect(await score(cache, allTime, 'u:coep', 'u1')).toBeNull()
    expect(await score(cache, allTime, 'c:BR', 'u1')).toBe(100)
    expect(await score(cache, allTime, 'y:BR:sao-paulo', 'u1')).toBe(100)
    expect(await score(cache, weekly, 'c:BR', 'u1')).toBe(20)
    expect(await score(cache, allTime, 'g', 'u1')).toBe(100)
  })

  it('takes a person who opted out off every board', async () => {
    const cache = new MemoryCache()
    for (const period of [weekly, monthly, seasonal, allTime]) for (const scope of ['g', 'c:IN']) await cache.zadd(boardKey(period, scope), 'u1', 5)
    const db = fakeDb({ profile: { hideFromLeaderboards: true, countryCode: 'IN' }, rows: [[{ score: 5 }], [{ score: 5 }], [{ score: 5 }], [{ score: 5 }]] })
    const result = await refreshUserBoards(db as never, cache, 'u1', { ...placed, cityKey: null, campusKey: null }, now)
    expect(result.removed).toBe(8)
    for (const period of [weekly, monthly, seasonal, allTime]) {
      expect(await score(cache, period, 'g', 'u1')).toBeNull()
      expect(await score(cache, period, 'c:IN', 'u1')).toBeNull()
    }
  })

  it('puts a person back on the boards, with their real scores, when they opt in again', async () => {
    const cache = new MemoryCache()
    const db = fakeDb({ profile: { countryCode: 'IN' }, rows: [[{ score: 10 }], [{ score: 30 }], [{ score: 70 }], [{ score: 500 }]] })
    await refreshUserBoards(db as never, cache, 'u1', { hidden: true, countryCode: 'IN', cityKey: null, campusKey: null }, now)
    expect(await score(cache, allTime, 'g', 'u1')).toBe(500)
    expect(await score(cache, allTime, 'c:IN', 'u1')).toBe(500)
    expect(await score(cache, weekly, 'g', 'u1')).toBe(10)
    expect(await score(cache, monthly, 'g', 'u1')).toBe(30)
    expect(await score(cache, seasonal, 'g', 'u1')).toBe(70)
  })

  it('sets a score, not adds to one: running it twice changes nothing', async () => {
    const cache = new MemoryCache()
    const rows = () => [[{ score: 7 }], [{ score: 7 }], [{ score: 7 }], [{ score: 7 }]]
    await refreshUserBoards(fakeDb({ rows: rows() }) as never, cache, 'u1', null, now)
    await refreshUserBoards(fakeDb({ rows: rows() }) as never, cache, 'u1', null, now)
    expect(await score(cache, allTime, 'g', 'u1')).toBe(7)
  })

  it('keeps nobody on a board for a period they earned nothing in', async () => {
    const cache = new MemoryCache()
    await cache.zadd(boardKey(weekly, 'g'), 'u1', 3)
    await refreshUserBoards(fakeDb({ rows: [[{ score: null }], [{ score: 0 }], [{ score: 0 }], [{ score: 40 }]] }) as never, cache, 'u1', null, now)
    expect(await score(cache, weekly, 'g', 'u1')).toBeNull()
    expect(await score(cache, allTime, 'g', 'u1')).toBe(40)
  })
})
