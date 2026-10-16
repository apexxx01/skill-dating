import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryCache } from './infra/cache.memory'
import { BOARDS_READY_KEY } from './leaderboard-write'
import { boardKey, periodsAt } from './leaderboard-boards'
import { decodeRankCursor, encodeRankCursor } from './api/pagination'
import { listRanked, readLeaderboard, readWindow, redisRanked, standing, startOf, type LeaderboardQuery } from './leaderboard-read'

// Ten people, best first: p1 has 100, p2 90, ... p10 10.
const people = Array.from({ length: 10 }, (_, index) => ({ member: `p${index + 1}`, score: 100 - index * 10 }))

const none = new Set<string>()
const hide = (...members: string[]) => new Set(members)

describe('readWindow', () => {
  it('reads a page of ranks', async () => {
    const window = await readWindow(listRanked(people), none, 0, 3)
    expect(window.rows).toEqual([
      { member: 'p1', score: 100, rank: 1 },
      { member: 'p2', score: 90, rank: 2 },
      { member: 'p3', score: 80, rank: 3 },
    ])
  })

  it('leaves out hidden people and does not renumber the rest: ranks have gaps', async () => {
    const window = await readWindow(listRanked(people), hide('p2', 'p4'), 0, 4)
    expect(window.rows.map((row) => [row.member, row.rank])).toEqual([['p1', 1], ['p3', 3]])
    // The window still covers four places; the cursor needs to know that.
    expect(window.scanned).toHaveLength(4)
  })

  it('gives the same person the same rank whoever is looking', async () => {
    const source = listRanked(people)
    const plain = await readWindow(source, none, 4, 3)
    const withBlocks = await readWindow(source, hide('p1', 'p2', 'p3'), 4, 3)
    expect(withBlocks.rows).toEqual(plain.rows)
    expect(plain.rows.map((row) => row.rank)).toEqual([5, 6, 7])
  })

  it('pages across hidden people without repeating or skipping anyone, and every rank is the absolute one', async () => {
    const source = listRanked(people)
    const blocked = hide('p2', 'p3', 'p6')
    const seen: [string, number][] = []
    for (let start = 0; start < 10; start += 2) {
      for (const row of (await readWindow(source, blocked, start, 2)).rows) seen.push([row.member, row.rank])
    }
    expect(seen).toEqual([['p1', 1], ['p4', 4], ['p5', 5], ['p7', 7], ['p8', 8], ['p9', 9], ['p10', 10]])
  })

  it('ignores hidden people who are not on the board', async () => {
    const window = await readWindow(listRanked(people), hide('somebody-else'), 0, 2)
    expect(window.rows.map((row) => row.member)).toEqual(['p1', 'p2'])
  })

  it('is empty past the end, and for an empty board', async () => {
    expect((await readWindow(listRanked(people), none, 10, 5)).rows).toEqual([])
    expect((await readWindow(listRanked([]), none, 0, 5)).rows).toEqual([])
  })

  it('reads a Redis board the same way a list is read', async () => {
    const cache = new MemoryCache()
    for (const { member, score } of people) await cache.zadd('board', member, score)
    const fromCache = await readWindow(redisRanked(cache, 'board'), hide('p2'), 1, 3)
    const fromList = await readWindow(listRanked(people), hide('p2'), 1, 3)
    expect(fromCache).toEqual(fromList)
  })

  it('breaks a tie by member, descending, in a list as in Redis', async () => {
    const tied = [{ member: 'a', score: 5 }, { member: 'c', score: 5 }, { member: 'b', score: 5 }, { member: 'z', score: 9 }]
    const cache = new MemoryCache()
    for (const { member, score } of tied) await cache.zadd('t', member, score)
    expect((await readWindow(listRanked(tied), none, 0, 4)).rows.map((row) => row.member)).toEqual(['z', 'c', 'b', 'a'])
    expect((await readWindow(redisRanked(cache, 't'), none, 0, 4)).rows.map((row) => row.member)).toEqual(['z', 'c', 'b', 'a'])
  })
})

describe('standing', () => {
  it('is the absolute rank and the score', async () => {
    expect(await standing(listRanked(people), 'p5')).toEqual({ rank: 5, score: 60 })
  })

  it('is null for somebody who is not on the board', async () => {
    expect(await standing(listRanked(people), 'nobody')).toBeNull()
  })
})

describe('startOf: where a page begins', () => {
  const source = listRanked(people)

  it('is the page number when there is no cursor', async () => {
    expect(await startOf(source, null, 1, 20)).toBe(0)
    expect(await startOf(source, null, 3, 20)).toBe(40)
  })

  it('is right after the last rank when the member of the cursor is gone', async () => {
    expect(await startOf(source, { rank: 4, member: 'departed' }, 1, 2)).toBe(4)
    expect(await startOf(source, { rank: 4 }, 1, 2)).toBe(4)
  })

  it('follows the member of the cursor if they have moved, so nobody is shown twice', async () => {
    // The last row of the previous page was p4 at rank 4; since then p4 was overtaken and is 6th.
    const moved = listRanked([...people.slice(0, 3), { member: 'p5', score: 55 }, { member: 'p6', score: 54 }, { member: 'p4', score: 53 }, ...people.slice(6)])
    expect(await startOf(moved, { rank: 4, member: 'p4' }, 1, 2)).toBe(6)
  })
})

describe('readLeaderboard', () => {
  const now = new Date('2026-10-16T12:00:00Z')
  const week = periodsAt(now, { id: 'season-1', endsAt: new Date('2026-12-11T00:00:00Z') })

  interface Setup {
    boards?: Record<string, { member: string; score: number }[]>
    me?: { hide?: boolean; countryCode?: string | null; cityKey?: string | null; campusKey?: string | null }
    users?: string[]
    teams?: string[]
    crewRows?: { userId: string; score: number }[]
  }

  let cache: MemoryCache
  beforeEach(async () => {
    cache = new MemoryCache()
    await cache.set(BOARDS_READY_KEY, 'x')
  })

  async function run(setup: Setup, query: Partial<LeaderboardQuery> = {}) {
    for (const [key, entries] of Object.entries(setup.boards ?? {})) for (const { member, score } of entries) await cache.zadd(key, member, score)
    const known = new Set(setup.users ?? [...new Set([...(Object.values(setup.boards ?? {}).flat().map((entry) => entry.member)), 'me'])])
    const db = {
      $queryRaw: vi.fn(async () => setup.crewRows ?? []),
      profile: { findUnique: vi.fn(async () => (setup.me ? { hideFromLeaderboards: setup.me.hide ?? false, countryCode: setup.me.countryCode ?? null, cityKey: setup.me.cityKey ?? null, campusKey: setup.me.campusKey ?? null } : null)) },
      season: { findFirst: vi.fn(async () => ({ id: 'season-1', number: 1, name: 'Season 1', startsAt: new Date('2026-10-01T00:00:00Z'), endsAt: new Date('2026-12-11T00:00:00Z') })) },
      user: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.filter((id) => known.has(id)).map((id) => ({ id, name: id, username: id, image: null, headline: null, builderRole: null, xp: 0 }))
        ),
      },
      team: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ((setup.teams ?? []).includes(where.id) ? { id: where.id } : null)) },
    }
    const outcome = await readLeaderboard(db as never, { viewerId: 'me', period: 'weekly', scope: 'global', scopeId: null, cursor: undefined, page: 1, limit: 3, blocked: [], now, ...query }, cache)
    return { outcome, db }
  }
  const globalWeek = boardKey(week[0], 'g')
  const board = (...entries: [string, number][]) => entries.map(([member, score]) => ({ member, score }))

  it('answers with the page, the viewer’s standing and the people around them', async () => {
    const { outcome } = await run({ boards: { [globalWeek]: board(['a', 90], ['b', 80], ['c', 70], ['d', 60], ['me', 50], ['e', 40], ['f', 30], ['g', 20]) } })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    const data = outcome.data
    expect(data.period).toBe('weekly')
    expect(data.scope).toEqual({ type: 'global', id: null })
    expect(data.entries.map((entry) => [entry.rank, entry.user.id, entry.score])).toEqual([[1, 'a', 90], [2, 'b', 80], [3, 'c', 70]])
    expect(data.entries[0].xp).toBe(90)
    expect(data.me).toEqual({ rank: 5, score: 50, xp: 50, hidden: false })
    expect(data.around.map((entry) => entry.rank)).toEqual([3, 4, 5, 6, 7])
    expect(data.around.map((entry) => entry.user.id)).toEqual(['c', 'd', 'me', 'e', 'f'])
    expect(data.pagination).toEqual({ page: 1, limit: 3, total: 8, totalPages: 3 })
    expect(decodeRankCursor(data.nextCursor!)).toEqual({ rank: 3, member: 'c' })
  })

  it('has fewer people around the viewer at the edges', async () => {
    const top = await run({ boards: { [globalWeek]: board(['me', 90], ['a', 80], ['b', 70], ['c', 60]) } })
    if (top.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(top.outcome.data.around.map((entry) => entry.user.id)).toEqual(['me', 'a', 'b'])
    const bottom = await run({ boards: { [globalWeek]: board(['a', 90], ['b', 80], ['c', 70], ['me', 60]) } })
    if (bottom.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(bottom.outcome.data.around.map((entry) => entry.user.id)).toEqual(['b', 'c', 'me'])
  })

  it('continues from a cursor, runs no count for it, and ends with a null cursor', async () => {
    const boards = { [globalWeek]: board(['a', 90], ['b', 80], ['c', 70], ['d', 60], ['e', 50]) }
    const first = await run({ boards, users: ['a', 'b', 'c', 'd', 'e', 'me'] }, { limit: 2 })
    if (first.outcome.kind !== 'ok') throw new Error('expected ok')
    const everyone = ['a', 'b', 'c', 'd', 'e', 'me']
    const second = await run({ users: everyone }, { limit: 2, cursor: first.outcome.data.nextCursor! })
    if (second.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(second.outcome.data.entries.map((entry) => entry.user.id)).toEqual(['c', 'd'])
    expect(second.outcome.data.entries.map((entry) => entry.rank)).toEqual([3, 4])
    expect(second.outcome.data.pagination).toBeUndefined()
    const third = await run({ users: everyone }, { limit: 2, cursor: second.outcome.data.nextCursor! })
    if (third.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(third.outcome.data.entries.map((entry) => entry.user.id)).toEqual(['e'])
    expect(third.outcome.data.nextCursor).toBeNull()
  })

  it('refuses a cursor that is not a rank cursor', async () => {
    expect((await run({}, { cursor: 'nope' })).outcome).toEqual({ kind: 'invalid-cursor' })
    expect((await run({}, { cursor: encodeRankCursor({ rank: 1 }).slice(0, -3) })).outcome).toEqual({ kind: 'invalid-cursor' })
  })

  it('leaves out blocked people and keeps every rank where it is, so the viewer’s list has gaps', async () => {
    const boards = { [globalWeek]: board(['a', 90], ['b', 80], ['c', 70], ['me', 60], ['d', 50]) }
    const { outcome } = await run({ boards }, { blocked: ['b'], limit: 10 })
    if (outcome.kind !== 'ok') throw new Error('expected ok')
    expect(outcome.data.entries.map((entry) => [entry.rank, entry.user.id])).toEqual([[1, 'a'], [3, 'c'], [4, 'me'], [5, 'd']])
    expect(outcome.data.me.rank).toBe(4)
    expect(outcome.data.around.map((entry) => [entry.rank, entry.user.id])).toEqual([[3, 'c'], [4, 'me'], [5, 'd']])
    expect(outcome.data.pagination?.total).toBe(5)
    // Somebody who blocked nobody sees the same ranks for the same people.
    const open = await run({ boards }, { limit: 10 })
    if (open.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(open.outcome.data.entries.filter((entry) => entry.user.id !== 'b').map((entry) => [entry.user.id, entry.rank])).toEqual(outcome.data.entries.map((entry) => [entry.user.id, entry.rank]))
    expect(open.outcome.data.me.rank).toBe(outcome.data.me.rank)
  })

  it('pages through a board with blocked people in the way: each page covers its own ranks, and the cursor passes a blocked last place', async () => {
    const boards = { [globalWeek]: board(['a', 90], ['b', 80], ['c', 70], ['d', 60], ['e', 50], ['f', 40]) }
    const users = ['a', 'b', 'c', 'd', 'e', 'f', 'me']
    const first = await run({ boards, users }, { limit: 2, blocked: ['b', 'c'] })
    if (first.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(first.outcome.data.entries.map((entry) => [entry.rank, entry.user.id])).toEqual([[1, 'a']])
    // The page ended on a blocked person: the cursor holds the rank, not their id.
    expect(decodeRankCursor(first.outcome.data.nextCursor!)).toEqual({ rank: 2 })
    const second = await run({ boards, users }, { limit: 2, blocked: ['b', 'c'], cursor: first.outcome.data.nextCursor! })
    if (second.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(second.outcome.data.entries.map((entry) => [entry.rank, entry.user.id])).toEqual([[4, 'd']])
    const third = await run({ boards, users }, { limit: 2, blocked: ['b', 'c'], cursor: second.outcome.data.nextCursor! })
    if (third.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(third.outcome.data.entries.map((entry) => [entry.rank, entry.user.id])).toEqual([[5, 'e'], [6, 'f']])
    expect(third.outcome.data.nextCursor).toBeNull()
  })

  it('takes a member whose account is gone off the board, so there is no hole in the ranks', async () => {
    const { outcome } = await run({ boards: { [globalWeek]: board(['a', 90], ['gone', 80], ['me', 70], ['b', 60]) }, users: ['a', 'me', 'b'] }, { limit: 10 })
    if (outcome.kind !== 'ok') throw new Error('expected ok')
    expect(outcome.data.entries.map((entry) => [entry.rank, entry.user.id])).toEqual([[1, 'a'], [2, 'me'], [3, 'b']])
    expect(outcome.data.me.rank).toBe(2)
    expect(await cache.zscore(globalWeek, 'gone')).toBeNull()
    expect(outcome.data.pagination?.total).toBe(3)
  })

  it('gives up cleaning after a few rounds rather than looping on a board that keeps producing ghosts', async () => {
    const ghosts = Array.from({ length: 30 }, (_, index) => [`ghost-${index}`, 1000 - index] as [string, number])
    const { outcome, db } = await run({ boards: { [globalWeek]: board(...ghosts, ['a', 1]) }, users: ['a', 'me'] }, { limit: 5 })
    expect(outcome.kind).toBe('ok')
    expect(db.user.findMany.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('has no standing for somebody who opted out, and says so', async () => {
    const { outcome } = await run({ boards: { [globalWeek]: board(['a', 90], ['me', 50]) }, me: { hide: true } })
    if (outcome.kind !== 'ok') throw new Error('expected ok')
    expect(outcome.data.me).toEqual({ rank: null, score: 0, xp: 0, hidden: true })
    expect(outcome.data.around).toEqual([])
  })

  it('has no standing for somebody with no XP in the period', async () => {
    const { outcome } = await run({ boards: { [globalWeek]: board(['a', 90]) }, users: ['a', 'me'] })
    if (outcome.kind !== 'ok') throw new Error('expected ok')
    expect(outcome.data.me).toEqual({ rank: null, score: 0, xp: 0, hidden: false })
  })

  it('reads the board of the viewer’s own country when none is named, and a named one when it is', async () => {
    const india = boardKey(week[0], 'c:IN')
    const brazil = boardKey(week[0], 'c:BR')
    const boards = { [india]: board(['a', 50], ['me', 40]), [brazil]: board(['b', 99]) }
    const own = await run({ boards, me: { countryCode: 'IN' } }, { scope: 'country' })
    if (own.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(own.outcome.data.scope).toEqual({ type: 'country', id: 'IN' })
    expect(own.outcome.data.entries.map((entry) => entry.user.id)).toEqual(['a', 'me'])
    expect(own.outcome.data.myScopes).toEqual({ country: 'IN', city: null, campus: null })

    const named = await run({ boards, me: { countryCode: 'IN' } }, { scope: 'country', scopeId: 'BR' })
    if (named.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(named.outcome.data.entries.map((entry) => entry.user.id)).toEqual(['b'])
    // The viewer is not on the Brazil board.
    expect(named.outcome.data.me.rank).toBeNull()
  })

  it('reads a city and a campus board', async () => {
    const boards = { [boardKey(week[0], 'y:IN:pune')]: board(['a', 5]), [boardKey(week[0], 'u:coep')]: board(['b', 6]) }
    const city = await run({ boards, me: { countryCode: 'IN', cityKey: 'pune' } }, { scope: 'city' })
    const campus = await run({ boards, me: { campusKey: 'coep' } }, { scope: 'campus' })
    if (city.outcome.kind !== 'ok' || campus.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(city.outcome.data.entries.map((entry) => entry.user.id)).toEqual(['a'])
    expect(city.outcome.data.scope.id).toBe('IN:pune')
    expect(campus.outcome.data.entries.map((entry) => entry.user.id)).toEqual(['b'])
  })

  it('asks the viewer to say which place when they have not set one', async () => {
    expect((await run({ me: { countryCode: null } }, { scope: 'country' })).outcome).toEqual({ kind: 'scope-missing', scope: 'country' })
    expect((await run({ me: { countryCode: 'IN' } }, { scope: 'city' })).outcome).toEqual({ kind: 'scope-missing', scope: 'city' })
    expect((await run({}, { scope: 'campus' })).outcome).toEqual({ kind: 'scope-missing', scope: 'campus' })
    expect((await run({}, { scope: 'crew' })).outcome).toEqual({ kind: 'scope-missing', scope: 'crew' })
  })

  it('sums a crew from the log, ranks it like any board, and reports a crew that does not exist', async () => {
    const crew = await run({ teams: ['t1'], crewRows: [{ userId: 'a', score: 30 }, { userId: 'me', score: 50 }, { userId: 'b', score: 10 }], users: ['a', 'b', 'me'] }, { scope: 'crew', scopeId: 't1' })
    if (crew.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(crew.outcome.data.entries.map((entry) => [entry.rank, entry.user.id, entry.score])).toEqual([[1, 'me', 50], [2, 'a', 30], [3, 'b', 10]])
    expect(crew.outcome.data.me.rank).toBe(1)
    expect((await run({ teams: [] }, { scope: 'crew', scopeId: 'nope' })).outcome).toEqual({ kind: 'crew-not-found' })
  })

  it('names the season on the season board, and reads the stamped season', async () => {
    const seasonBoard = boardKey(week[2], 'g')
    const { outcome } = await run({ boards: { [seasonBoard]: board(['a', 12]) } }, { period: 'season' })
    if (outcome.kind !== 'ok') throw new Error('expected ok')
    expect(outcome.data.season).toMatchObject({ id: 'season-1', number: 1, name: 'Season 1' })
    expect(outcome.data.entries.map((entry) => entry.user.id)).toEqual(['a'])
    const weekly = await run({}, { period: 'weekly' })
    if (weekly.outcome.kind !== 'ok') throw new Error('expected ok')
    expect(weekly.outcome.data.season).toBeNull()
  })

  it('builds boards that were never built, with the in-process cache, before answering', async () => {
    const cold = new MemoryCache()
    const db = {
      // The rebuild asks the log three things: totals up to a cutoff, who earned since, and where they stand now.
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        const text = strings.join('?')
        if (text.includes('"cityKey"') && text.includes('GROUP BY')) return [{ userId: 'a', score: 40, countryCode: null, cityKey: null, campusKey: null }]
        return []
      }),
      profile: { findUnique: vi.fn(async () => null) },
      season: { findFirst: vi.fn(async () => null) },
      user: { findMany: vi.fn(async () => [{ id: 'a', name: 'a', username: 'a', image: null, headline: null, builderRole: null, xp: 0 }]) },
      team: { findUnique: vi.fn() },
    }
    const outcome = await readLeaderboard(db as never, { viewerId: 'me', period: 'all-time', scope: 'global', scopeId: null, cursor: undefined, page: 1, limit: 5, blocked: [], now }, cold)
    if (outcome.kind !== 'ok') throw new Error('expected ok')
    expect(outcome.data.entries.map((entry) => entry.user.id)).toEqual(['a'])
    expect(await cold.get(BOARDS_READY_KEY)).not.toBeNull()
  })
})
