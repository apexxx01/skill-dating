import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'

// The nightly rebuild of the leaderboards against the real XPEvent table and the real SQL: totals up to a cutoff,
// batches, and XP that lands while the rebuild runs, which must be counted exactly once. The rebuild is called
// directly (with a cache of its own) so the test can make awards land between its steps.
describe('leaderboard rebuild against the database', () => {
  const suffix = uniqueSuffix().toLowerCase()
  let n = 0
  let rebuildBoards: typeof import('@/lib/leaderboard-rebuild').rebuildBoards
  let MemoryCache: typeof import('@/lib/infra/cache.memory').MemoryCache
  let boardKey: typeof import('@/lib/leaderboard-boards').boardKey
  let currentPeriods: typeof import('@/lib/leaderboard-write').currentPeriods

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    ;({ rebuildBoards } = await import('@/lib/leaderboard-rebuild'))
    ;({ MemoryCache } = await import('@/lib/infra/cache.memory'))
    ;({ boardKey } = await import('@/lib/leaderboard-boards'))
    ;({ currentPeriods } = await import('@/lib/leaderboard-write'))
  })
  afterAll(() => cleanupTestUsers(suffix), 300_000)

  const user = async (): Promise<TestUser> => {
    const name = `rb${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }
  const earn = async (userId: string, amount: number, over: { ago?: number; seasonId?: string | null } = {}) =>
    testPrisma.xPEvent.create({
      data: {
        userId,
        type: 'PROJECT_CREATED',
        amount,
        description: 'seed',
        sourceType: 'TEST',
        sourceId: `${n++}`,
        dedupeKey: `rb:${n}:${Math.random()}`,
        seasonId: over.seasonId ?? null,
        createdAt: new Date(Date.now() - (over.ago ?? 0)),
      },
    })
  const HOUR = 60 * 60 * 1000
  const sumFor = async (userId: string, seasonId?: string) =>
    (await testPrisma.xPEvent.aggregate({ where: { userId, ...(seasonId ? { seasonId } : {}) }, _sum: { amount: true } }))._sum.amount ?? 0
  const scoreOn = async (cache: InstanceType<typeof MemoryCache>, periodKey: string, userId: string, scope = 'g') => cache.zscore(boardKey(periodKey, scope), userId)

  it('builds every board from the log: the same totals the table holds, per period, with opted-out people left out', async () => {
    const [a, b, hidden] = [await user(), await user(), await user()]
    const season = await testPrisma.season.findFirstOrThrow({ where: { active: true } })
    await earn(a.userId, 70_000_000, { ago: 2 * HOUR, seasonId: season.id })
    await earn(a.userId, 5, { ago: 90 * 24 * HOUR })
    await earn(b.userId, 60_000_000, { ago: 3 * HOUR })
    await earn(hidden.userId, 80_000_000, { ago: HOUR })
    await testPrisma.profile.upsert({ where: { userId: hidden.userId }, update: { hideFromLeaderboards: true }, create: { userId: hidden.userId, hideFromLeaderboards: true } })

    const cache = new MemoryCache()
    await rebuildBoards(testPrisma, cache)
    const periods = await currentPeriods(testPrisma)
    const all = periods.find((period) => period.period === 'all-time')!
    const seasonal = periods.find((period) => period.period === 'season')!
    expect(await scoreOn(cache, all.key, a.userId)).toBe(await sumFor(a.userId))
    expect(await scoreOn(cache, all.key, a.userId)).toBe(70_000_005)
    expect(await scoreOn(cache, all.key, b.userId)).toBe(60_000_000)
    expect(await scoreOn(cache, seasonal.key, a.userId)).toBe(70_000_000)
    expect(await scoreOn(cache, seasonal.key, b.userId)).toBeNull()
    expect(await scoreOn(cache, all.key, hidden.userId)).toBeNull()
    // Most XP first.
    const top = await cache.ztop(boardKey(all.key, 'g'), 2)
    expect(top.map((entry) => entry.member)).toEqual([a.userId, b.userId])
  }, 120_000)

  it('reads the log in small batches without missing or repeating anybody at the boundaries', async () => {
    const people = await Promise.all([user(), user(), user(), user(), user()])
    for (const [index, person] of people.entries()) await earn(person.userId, 90_000_000 + index, { ago: 2 * HOUR })
    const cache = new MemoryCache()
    await rebuildBoards(testPrisma, cache, new Date(), { batchSize: 2 })
    const all = (await currentPeriods(testPrisma)).find((period) => period.period === 'all-time')!
    for (const [index, person] of people.entries()) expect(await scoreOn(cache, all.key, person.userId), `person ${index}`).toBe(90_000_000 + index)
    const top = await cache.ztop(boardKey(all.key, 'g'), 5)
    expect(top.map((entry) => entry.member)).toEqual([...people].reverse().map((person) => person.userId))
  }, 120_000)

  it('counts XP that lands while the rebuild runs exactly once, whichever step it lands in', async () => {
    const person = await user()
    await earn(person.userId, 100_000_000, { ago: 2 * HOUR })
    for (const moment of ['cutoff', 'aggregated', 'replaying'] as const) {
      const cache = new MemoryCache()
      let landed = 0
      await rebuildBoards(testPrisma, cache, new Date(), {
        onStep: async ({ name, period }) => {
          if (name === moment && period.period === 'all-time' && landed === 0) {
            landed += 1
            // The application commits the award and then moves the live board, as recordBoardXp does.
            await earn(person.userId, 1_000)
            await cache.zincr(boardKey(period, 'g'), person.userId, 1_000)
          }
        },
      })
      expect(landed, moment).toBe(1)
      // Everything is in the log once, and the board says the same: not 100_001_000 + 1_000 (twice), not 100_000_000 (missed).
      const all = (await currentPeriods(testPrisma)).find((period) => period.period === 'all-time')!
      const total = await sumFor(person.userId)
      expect(await scoreOn(cache, all.key, person.userId), moment).toBe(total)
      await testPrisma.xPEvent.deleteMany({ where: { userId: person.userId, amount: 1_000 } })
    }
  }, 180_000)

  it('counts several awards in several waves, and a person who first earns during the rebuild', async () => {
    const [veteran, newcomer] = [await user(), await user()]
    await earn(veteran.userId, 110_000_000, { ago: 2 * HOUR })
    const cache = new MemoryCache()
    const waves: (() => Promise<unknown>)[] = [
      () => earn(veteran.userId, 7),
      () => earn(newcomer.userId, 500),
      () => earn(veteran.userId, 11),
    ]
    let step = 0
    await rebuildBoards(testPrisma, cache, new Date(), {
      onStep: async ({ name, period }) => {
        if (period.period === 'all-time' && (name === 'aggregated' || name === 'replaying') && waves[step]) await waves[step++]()
      },
    })
    expect(step).toBe(3)
    const all = (await currentPeriods(testPrisma)).find((period) => period.period === 'all-time')!
    expect(await scoreOn(cache, all.key, veteran.userId)).toBe(110_000_018)
    expect(await scoreOn(cache, all.key, newcomer.userId)).toBe(500)
  }, 120_000)

  it('takes somebody off the boards who opted out while the rebuild ran', async () => {
    const [stays, leaves] = [await user(), await user()]
    await earn(stays.userId, 120_000_000, { ago: 2 * HOUR })
    await earn(leaves.userId, 119_000_000, { ago: 2 * HOUR })
    const cache = new MemoryCache()
    let done = false
    await rebuildBoards(testPrisma, cache, new Date(), {
      onStep: async ({ name, period }) => {
        if (name === 'aggregated' && period.period === 'all-time' && !done) {
          done = true
          await testPrisma.profile.upsert({ where: { userId: leaves.userId }, update: { hideFromLeaderboards: true }, create: { userId: leaves.userId, hideFromLeaderboards: true } })
          await earn(leaves.userId, 1)
        }
      },
    })
    const all = (await currentPeriods(testPrisma)).find((period) => period.period === 'all-time')!
    expect(await scoreOn(cache, all.key, leaves.userId)).toBeNull()
    expect(await scoreOn(cache, all.key, stays.userId)).toBe(120_000_000)
  }, 120_000)
})
