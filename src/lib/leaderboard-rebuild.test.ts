import { describe, it, expect, vi } from 'vitest'
import { MemoryCache } from './infra/cache.memory'
import { boardKey, periodsAt, type PeriodRef } from './leaderboard-boards'
import { rebuildBoards, type LogReader, type RebuildOptions, type ScoreRow, type Standing } from './leaderboard-rebuild'
import { BOARDS_READY_KEY } from './leaderboard-write'

const now = new Date('2026-10-16T12:00:00Z')
const season = { id: 'season-1', endsAt: new Date('2026-12-11T00:00:00Z') }
const [weekly, monthly, seasonal, allTime] = periodsAt(now, season)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

interface Person {
  id: string
  alive?: boolean
  hidden?: boolean
  countryCode?: string
  cityKey?: string
  campusKey?: string
}
interface Event {
  userId: string
  amount: number
  at: number
  seasonId?: string | null
}

/**
 * The XPEvent log and the users, in memory, answering a rebuild's questions the way the SQL does. Tests add events
 * to it (as the application would, with the time they happened) from inside a rebuild.
 */
class FakeLog implements LogReader {
  readonly events: Event[] = []
  readonly people = new Map<string, Person>()
  readonly batchSizes: number[] = []
  failOnPeriod: string | null = null

  person(person: Person) {
    this.people.set(person.id, person)
    return this
  }
  earn(userId: string, amount: number, at: number, seasonId: string | null = 'season-1') {
    if (!this.people.has(userId)) this.person({ id: userId })
    this.events.push({ userId, amount, at, seasonId })
  }

  private inPeriod(event: Event, period: PeriodRef) {
    if (period.seasonId) return event.seasonId === period.seasonId
    if (period.start && period.end) return event.at >= period.start.getTime() && event.at < period.end.getTime()
    return true
  }
  private total(userId: string, period: PeriodRef) {
    return this.events.filter((event) => event.userId === userId && this.inPeriod(event, period)).reduce((sum, event) => sum + event.amount, 0)
  }

  async scoresUpTo(period: PeriodRef, cutoff: Date, after: string, size: number): Promise<ScoreRow[]> {
    if (this.failOnPeriod === period.key) throw new Error('the database went away')
    this.batchSizes.push(size)
    const ids = [...new Set(this.events.filter((event) => this.inPeriod(event, period) && event.at <= cutoff.getTime()).map((event) => event.userId))]
    return ids
      .filter((id) => id > after)
      .sort()
      .flatMap((id) => {
        const person = this.people.get(id)!
        const score = this.events.filter((event) => event.userId === id && event.at <= cutoff.getTime() && this.inPeriod(event, period)).reduce((sum, event) => sum + event.amount, 0)
        if (person.alive === false || person.hidden || score <= 0) return []
        return [{ userId: id, score, countryCode: person.countryCode ?? null, cityKey: person.cityKey ?? null, campusKey: person.campusKey ?? null }]
      })
      .slice(0, size)
  }
  async touchedSince(period: PeriodRef, since: Date, after: string, size: number) {
    const ids = new Set(this.events.filter((event) => this.inPeriod(event, period) && event.at > since.getTime()).map((event) => event.userId))
    return [...ids].filter((id) => id > after).sort().slice(0, size)
  }
  async standings(period: PeriodRef, userIds: string[]): Promise<Standing[]> {
    return userIds.flatMap((userId) => {
      const person = this.people.get(userId)
      if (!person) return []
      return [
        {
          userId,
          score: this.total(userId, period),
          alive: person.alive !== false,
          hidden: person.hidden ?? false,
          countryCode: person.countryCode ?? null,
          cityKey: person.cityKey ?? null,
          campusKey: person.campusKey ?? null,
        },
      ]
    })
  }
}

const season1 = { id: 'season-1', endsAt: season.endsAt }
function fakeDb(withSeason: typeof season1 | null = season1) {
  return {
    profile: { findUnique: vi.fn() },
    season: { findFirst: vi.fn(async () => withSeason) },
    $queryRaw: vi.fn(async () => {
      throw new Error('the rebuild must read the log through its reader')
    }),
  }
}

// The wall clock the rebuild takes its cutoff from: fixed, so "a minute before" is exact.
const NOW = now.getTime()
const score = (cache: MemoryCache, period: { key: string }, scope: string, member: string) => cache.zscore(boardKey(period.key, scope), member)

async function rebuild(log: FakeLog, cache: MemoryCache, options: RebuildOptions = {}, db = fakeDb()) {
  return rebuildBoards(db as never, cache, now, { reader: log, clock: () => NOW, ...options })
}

describe('rebuildBoards: from the log', () => {
  it('writes every board of every period and marks the boards as built', async () => {
    const log = new FakeLog()
    log.person({ id: 'a', countryCode: 'IN', cityKey: 'pune' }).person({ id: 'b', countryCode: 'IN' }).person({ id: 'c' })
    log.earn('a', 90, NOW - HOUR)
    log.earn('b', 40, NOW - HOUR)
    log.earn('c', 10, NOW - HOUR)
    const cache = new MemoryCache()
    const result = await rebuild(log, cache)
    expect(result.periods).toBe(4)
    expect(await score(cache, allTime, 'g', 'a')).toBe(90)
    expect(await score(cache, allTime, 'c:IN', 'b')).toBe(40)
    expect(await score(cache, allTime, 'c:IN', 'c')).toBeNull()
    expect(await score(cache, allTime, 'y:IN:pune', 'a')).toBe(90)
    expect(await score(cache, allTime, 'y:IN:pune', 'b')).toBeNull()
    expect(await cache.zcard(boardKey(allTime, 'g'))).toBe(3)
    expect(await cache.get(BOARDS_READY_KEY)).toBe(now.toISOString())
  })

  it('counts each period’s own XP: last week’s is on the all-time board and not on this week’s; the season board takes the stamped season', async () => {
    const log = new FakeLog()
    log.earn('a', 100, NOW - 20 * 24 * HOUR, null)
    log.earn('a', 7, NOW - HOUR, 'season-1')
    log.earn('b', 5, NOW - HOUR, 'some-other-season')
    const cache = new MemoryCache()
    await rebuild(log, cache)
    expect(await score(cache, allTime, 'g', 'a')).toBe(107)
    expect(await score(cache, monthly, 'g', 'a')).toBe(7)
    expect(await score(cache, weekly, 'g', 'a')).toBe(7)
    expect(await score(cache, seasonal, 'g', 'a')).toBe(7)
    expect(await score(cache, seasonal, 'g', 'b')).toBeNull()
    expect(await score(cache, allTime, 'g', 'b')).toBe(5)
  })

  it('replaces a board whole: what was in the cache and is not in the log goes', async () => {
    const log = new FakeLog()
    log.earn('a', 50, NOW - HOUR)
    const cache = new MemoryCache()
    await cache.zadd(boardKey(allTime, 'g'), 'stale', 999)
    await cache.zadd(boardKey(allTime, 'g'), 'a', 1)
    await rebuild(log, cache)
    expect(await score(cache, allTime, 'g', 'stale')).toBeNull()
    expect(await score(cache, allTime, 'g', 'a')).toBe(50)
  })

  it('empties a global board when nobody has earned in the period', async () => {
    const cache = new MemoryCache()
    await cache.zadd(boardKey(weekly, 'g'), 'old', 5)
    await rebuild(new FakeLog(), cache)
    expect(await cache.zcard(boardKey(weekly, 'g'))).toBe(0)
  })

  it('leaves out people who opted out, whose account is gone, or whose total is not positive', async () => {
    const log = new FakeLog()
    log.person({ id: 'hidden', hidden: true }).person({ id: 'gone', alive: false })
    log.earn('hidden', 10, NOW - HOUR)
    log.earn('gone', 10, NOW - HOUR)
    log.earn('broke', 10, NOW - HOUR)
    log.earn('broke', -10, NOW - HOUR)
    log.earn('ok', 1, NOW - HOUR)
    const cache = new MemoryCache()
    await rebuild(log, cache)
    expect((await cache.ztop(boardKey(allTime, 'g'), 10)).map((entry) => entry.member)).toEqual(['ok'])
  })

  it('skips the season board between seasons', async () => {
    const result = await rebuild(new FakeLog(), new MemoryCache(), {}, fakeDb(null))
    expect(result.periods).toBe(3)
  })

  it('gives each period its own expiry', async () => {
    const log = new FakeLog()
    log.earn('a', 1, NOW - HOUR)
    const clock = { now: NOW }
    const cache = new MemoryCache(1000, () => clock.now)
    await rebuild(log, cache)
    clock.now += 100 * 24 * HOUR
    expect(await score(cache, weekly, 'g', 'a')).toBeNull()
    expect(await score(cache, allTime, 'g', 'a')).toBe(1)
  })

  it('reads the log in batches of people, never all at once, and misses nobody at a batch boundary', async () => {
    const log = new FakeLog()
    for (let index = 0; index < 11; index++) log.earn(`u${String(index).padStart(2, '0')}`, index + 1, NOW - HOUR)
    const cache = new MemoryCache()
    await rebuild(log, cache, { batchSize: 4 })
    expect(Math.max(...log.batchSizes)).toBe(4)
    expect(log.batchSizes.length).toBeGreaterThan(4)
    expect(await cache.zcard(boardKey(allTime, 'g'))).toBe(11)
    for (let index = 0; index < 11; index++) expect(await score(cache, allTime, 'g', `u${String(index).padStart(2, '0')}`)).toBe(index + 1)
  })

  it('finishes a batch that is exactly full with one more read, which finds nobody', async () => {
    const log = new FakeLog()
    for (let index = 0; index < 4; index++) log.earn(`u${index}`, 1, NOW - HOUR)
    await rebuild(log, new MemoryCache(), { batchSize: 4 })
    // 4 periods, each reading a full batch and then an empty one.
    expect(log.batchSizes).toHaveLength(8)
  })
})

describe('rebuildBoards: XP that lands while it runs', () => {
  // The cutoff is a minute before NOW. "Landing" means the application commits an event and, right after, moves the
  // live board, as recordBoardXp does; the rebuild must end with the log's total for the person: once each, no more, no less.
  const land = async (log: FakeLog, cache: MemoryCache, userId: string, amount: number, at: number) => {
    log.earn(userId, amount, at)
    for (const period of [weekly, monthly, seasonal, allTime]) await cache.zincr(boardKey(period.key, 'g'), userId, amount)
  }

  it('counts an award that lands after the aggregate and before the swap exactly once', async () => {
    const log = new FakeLog()
    log.earn('a', 100, NOW - HOUR)
    log.earn('b', 50, NOW - HOUR)
    const cache = new MemoryCache()
    await rebuild(log, cache)
    expect(await score(cache, allTime, 'g', 'a')).toBe(100)

    let landed = false
    await rebuild(log, cache, {
      onStep: async ({ name, period }) => {
        if (name === 'aggregated' && period.key === allTime.key && !landed) {
          landed = true
          await land(log, cache, 'a', 25, NOW - 5 * 1000)
        }
      },
    })
    expect(landed).toBe(true)
    expect(await score(cache, allTime, 'g', 'a')).toBe(125)
    expect(await score(cache, allTime, 'g', 'b')).toBe(50)
  })

  it('counts an award once whichever step of the last period it lands in, including during the swap', async () => {
    for (const moment of ['cutoff', 'aggregated', 'replaying', 'swapping', 'settling'] as const) {
      const log = new FakeLog()
      log.earn('a', 100, NOW - HOUR)
      const cache = new MemoryCache()
      let landed = false
      await rebuild(log, cache, {
        onStep: async ({ name, period }) => {
          if (name === moment && period.key === allTime.key && !landed) {
            landed = true
            await land(log, cache, 'a', 25, NOW - 1000)
          }
        },
      })
      expect(landed, moment).toBe(true)
      // Landing during the swap moves the old board, which the rename replaces: the final pass puts it back.
      for (const period of [weekly, monthly, seasonal, allTime]) expect(await score(cache, period, 'g', 'a'), `${moment} / ${period.key}`).toBe(125)
    }
  })

  it('puts back an award that landed on the old board during the swap, and says it corrected one person', async () => {
    const log = new FakeLog()
    log.earn('a', 100, NOW - HOUR)
    const cache = new MemoryCache()
    let landed = false
    const result = await rebuild(log, cache, {
      onStep: async ({ name, period }) => {
        if (name === 'swapping' && period.key === allTime.key && !landed) {
          landed = true
          await land(log, cache, 'a', 25, NOW - 1000)
        }
      },
    })
    expect(result.settled).toBe(1)
    expect(await score(cache, allTime, 'g', 'a')).toBe(125)
  })

  it('settles someone who earned for the first time during the swap, on the boards of their place', async () => {
    const log = new FakeLog().person({ id: 'new', countryCode: 'IN', cityKey: 'pune' })
    log.earn('a', 100, NOW - HOUR)
    const cache = new MemoryCache()
    let landed = false
    await rebuild(log, cache, {
      onStep: async ({ name, period }) => {
        if (name === 'swapping' && period.key === allTime.key && !landed) {
          landed = true
          log.earn('new', 40, NOW - 1000)
          await cache.zincr(boardKey(allTime.key, 'g'), 'new', 40)
        }
      },
    })
    expect(await score(cache, allTime, 'g', 'new')).toBe(40)
    expect(await score(cache, allTime, 'c:IN', 'new')).toBe(40)
  })

  it('takes someone off the live boards who opted out during the swap', async () => {
    const log = new FakeLog().person({ id: 'a', countryCode: 'IN' })
    log.earn('a', 100, NOW - HOUR)
    const cache = new MemoryCache()
    await rebuild(log, cache)
    let landed = false
    await rebuild(log, cache, {
      onStep: async ({ name, period }) => {
        if (name === 'swapping' && period.key === allTime.key && !landed) {
          landed = true
          log.person({ id: 'a', countryCode: 'IN', hidden: true })
          log.earn('a', 1, NOW - 1000)
        }
      },
    })
    expect(await score(cache, allTime, 'g', 'a')).toBeNull()
    expect(await score(cache, allTime, 'c:IN', 'a')).toBeNull()
  })

  it('settles nobody on a quiet log, and twice in a row changes nothing', async () => {
    const log = new FakeLog()
    log.earn('a', 100, NOW - HOUR)
    const cache = new MemoryCache()
    expect((await rebuild(log, cache)).settled).toBe(0)
    expect((await rebuild(log, cache)).settled).toBe(0)
    expect(await score(cache, allTime, 'g', 'a')).toBe(100)
  })

  it('does not count an award twice that the aggregate already took and the replay sees again', async () => {
    // An event stamped a few seconds before the cutoff is in the aggregate; the replay (everything after the cutoff) never sees it.
    const log = new FakeLog()
    log.earn('a', 10, NOW - 2 * MINUTE)
    log.earn('a', 5, NOW - 30 * 1000)
    const cache = new MemoryCache()
    await rebuild(log, cache)
    expect(await score(cache, allTime, 'g', 'a')).toBe(15)
  })

  it('counts an award that landed in the lag window once: not in the aggregate, in the replay', async () => {
    const log = new FakeLog()
    log.earn('a', 10, NOW - HOUR)
    // Stamped 30 seconds before "now": after the cutoff (a minute back), so only the replay can take it.
    log.earn('a', 5, NOW - 30 * 1000)
    const reader = vi.spyOn(log, 'scoresUpTo')
    const cache = new MemoryCache()
    const result = await rebuild(log, cache)
    expect(reader.mock.calls[0][1].getTime()).toBe(NOW - MINUTE)
    expect(await score(cache, allTime, 'g', 'a')).toBe(15)
    expect(result.replayed).toBeGreaterThan(0)
  })

  it('puts a person who earned for the first time mid-rebuild on the boards of their place, with their score', async () => {
    const log = new FakeLog().person({ id: 'new', countryCode: 'BR', cityKey: 'sao-paulo' })
    log.earn('a', 100, NOW - HOUR)
    const cache = new MemoryCache()
    let landed = false
    await rebuild(log, cache, {
      onStep: async ({ name }) => {
        if (name === 'aggregated' && !landed) {
          landed = true
          log.earn('new', 30, NOW - 1000)
        }
      },
    })
    for (const scope of ['g', 'c:BR', 'y:BR:sao-paulo']) expect(await score(cache, allTime, scope, 'new'), scope).toBe(30)
  })

  it('takes a second wave that arrives during the replay: it repeats until a pass finds nothing new', async () => {
    const log = new FakeLog()
    log.earn('a', 100, NOW - HOUR)
    const cache = new MemoryCache()
    const waves = [{ at: 'aggregated', pass: undefined, amount: 10 }, { at: 'replaying', pass: 2, amount: 20 }]
    const passes: number[] = []
    await rebuild(log, cache, {
      onStep: async ({ name, period, pass }) => {
        if (period.key !== allTime.key) return
        if (name === 'replaying') passes.push(pass!)
        const wave = waves.find((candidate) => candidate.at === name && candidate.pass === pass)
        if (wave) {
          waves.splice(waves.indexOf(wave), 1)
          log.earn('a', wave.amount, NOW - 1000)
        }
      },
    })
    expect(await score(cache, allTime, 'g', 'a')).toBe(130)
    expect(passes.length).toBeGreaterThanOrEqual(3)
  })

  it('removes somebody from the staged boards when they opted out after the aggregate', async () => {
    const log = new FakeLog().person({ id: 'a', countryCode: 'IN' })
    log.earn('a', 100, NOW - HOUR)
    log.earn('b', 50, NOW - HOUR)
    const cache = new MemoryCache()
    await rebuild(log, cache, {
      onStep: async ({ name }) => {
        if (name === 'aggregated' && log.people.get('a')!.hidden !== true) {
          log.people.get('a')!.hidden = true
          log.earn('a', 1, NOW - 1000)
        }
      },
    })
    expect(await score(cache, allTime, 'g', 'a')).toBeNull()
    expect(await score(cache, allTime, 'c:IN', 'a')).toBeNull()
    expect(await score(cache, allTime, 'g', 'b')).toBe(50)
  })

  it('keeps the live boards as they were until the swap', async () => {
    const log = new FakeLog()
    log.earn('a', 100, NOW - HOUR)
    const cache = new MemoryCache()
    await cache.zadd(boardKey(allTime, 'g'), 'a', 1)
    const seen: (number | null)[] = []
    await rebuild(log, cache, {
      onStep: async ({ name, period }) => {
        if (period.key === allTime.key && (name === 'aggregated' || name === 'replaying')) seen.push(await score(cache, allTime, 'g', 'a'))
      },
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((value) => value === 1)).toBe(true)
    expect(await score(cache, allTime, 'g', 'a')).toBe(100)
  })

  it('swaps anyway, and says so, when the log never goes quiet', async () => {
    const log = new FakeLog()
    log.earn('a', 100, NOW - HOUR)
    const cache = new MemoryCache()
    let extra = 0
    const result = await rebuild(log, cache, {
      onStep: async ({ name, period }) => {
        if (name === 'replaying' && period.key === allTime.key) {
          extra += 1
          log.earn('a', 1, NOW - 1000)
        }
      },
    })
    expect(extra).toBe(6)
    expect(result.periods).toBe(4)
    // Every wave landed before a pass read the log, so every one is counted, once.
    expect(await score(cache, allTime, 'g', 'a')).toBe(100 + extra)
  })

  it('changes nothing when run twice with no new XP, and makes no replay for a quiet log', async () => {
    const log = new FakeLog()
    log.earn('a', 100, NOW - HOUR)
    const cache = new MemoryCache()
    const first = await rebuild(log, cache)
    const second = await rebuild(log, cache)
    expect(first.replayed).toBe(0)
    expect(second.replayed).toBe(0)
    expect(await score(cache, allTime, 'g', 'a')).toBe(100)
  })
})

describe('rebuildBoards: when it fails', () => {
  it('leaves every live board as it was and throws, and the next run starts clean', async () => {
    const log = new FakeLog()
    log.earn('a', 100, NOW - HOUR)
    const cache = new MemoryCache()
    await rebuild(log, cache)
    log.earn('a', 5, NOW - HOUR)
    log.failOnPeriod = allTime.key
    await expect(rebuild(log, cache)).rejects.toThrow('went away')
    // The weekly, monthly and season boards were swapped before the all-time period failed; the one that failed is untouched.
    expect(await score(cache, allTime, 'g', 'a')).toBe(100)
    log.failOnPeriod = null
    await rebuild(log, cache)
    expect(await score(cache, allTime, 'g', 'a')).toBe(105)
  })
})
