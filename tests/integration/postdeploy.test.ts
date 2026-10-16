import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'

const DAY_MS = 24 * 60 * 60 * 1000

// `npm run postdeploy` (src/lib/postdeploy.ts) against the real database and the real jobs: it can be run twice, and
// the second run changes nothing; it opens a season when there is none and closes one that is over.
describe('post-deploy', () => {
  const suffix = uniqueSuffix()
  let n = 0
  let postdeploy: typeof import('@/lib/postdeploy')
  let seasons: typeof import('@/lib/seasons')
  let jobs: typeof import('@/lib/infra/jobs')
  let cacheModule: typeof import('@/lib/infra/cache')
  let MemoryCache: typeof import('@/lib/infra/cache.memory').MemoryCache
  let boardKey: typeof import('@/lib/leaderboard-boards').boardKey
  let currentPeriods: typeof import('@/lib/leaderboard-write').currentPeriods

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    postdeploy = await import('@/lib/postdeploy')
    seasons = await import('@/lib/seasons')
    jobs = await import('@/lib/infra/jobs')
    cacheModule = await import('@/lib/infra/cache')
    ;({ MemoryCache } = await import('@/lib/infra/cache.memory'))
    ;({ boardKey } = await import('@/lib/leaderboard-boards'))
    ;({ currentPeriods } = await import('@/lib/leaderboard-write'))
  })
  afterAll(async () => {
    cacheModule?.setCache(undefined)
    await cleanupTestUsers(suffix)
  }, 180_000)

  const user = async (): Promise<TestUser> => {
    const name = `pd${suffix}${n++}`
    return registerAndLogin(`${name}@test.dev`, name)
  }

  /** The cache the jobs write to and the script checks, behaving as Upstash does (shared, answers a ping). */
  function sharedCache(): import('@/lib/infra/cache').Cache {
    const cache = new MemoryCache()
    Object.defineProperty(cache, 'kind', { value: 'upstash' })
    cacheModule.setCache(cache)
    return cache
  }
  const upstashEnv = { NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://example.invalid', UPSTASH_REDIS_REST_TOKEN: 'placeholder' }
  const run = (cache: import('@/lib/infra/cache').Cache, options: { dryRun?: boolean } = {}) =>
    postdeploy.runPostdeploy(
      { env: upstashEnv, cache, prisma: testPrisma as never, runJob: (name, data) => jobs.runJob(jobs.jobs, name, data) },
      options
    )

  it('runs end to end, and a second run changes nothing', async () => {
    const earner = await user()
    const veteran = await user()
    await testPrisma.xPEvent.create({ data: { userId: earner.userId, type: 'TEST', amount: 150_000_000, description: 'seed', dedupeKey: `pd:${n++}:${Math.random()}`, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } })
    // Somebody who earned a tier before cosmetics existed.
    await testPrisma.user.update({ where: { id: veteran.userId }, data: { xp: 60_000 } })

    const cache = sharedCache()
    const first = await run(cache)
    expect(first.map((report) => [report.step, report.status])).toEqual([['environment', 'done'], ['database', 'done'], ['season', 'done'], ['leaderboards', 'done'], ['cosmetics', 'done']])
    const all = (await currentPeriods(testPrisma)).find((period) => period.period === 'all-time')!
    expect(await cache.zscore(boardKey(all, 'g'), earner.userId)).toBe(150_000_000)
    expect(await testPrisma.userCosmetic.count({ where: { userId: veteran.userId } })).toBeGreaterThan(0)
    const owned = await testPrisma.userCosmetic.count({ where: { userId: veteran.userId } })
    const season = await testPrisma.season.findFirstOrThrow({ where: { active: true } })
    const seasonRows = await testPrisma.season.count()

    const second = await run(cache)
    expect(second.map((report) => [report.step, report.status])).toEqual(first.map((report) => [report.step, report.status]))
    expect(await cache.zscore(boardKey(all, 'g'), earner.userId)).toBe(150_000_000)
    expect(await testPrisma.userCosmetic.count({ where: { userId: veteran.userId } })).toBe(owned)
    expect((await testPrisma.season.findFirstOrThrow({ where: { active: true } })).id).toBe(season.id)
    expect(await testPrisma.season.count()).toBe(seasonRows)
    expect(second.find((report) => report.step === 'cosmetics')!.detail).toMatch(/, 0 cosmetics granted$/)
  }, 180_000)

  it('changes nothing in a dry run', async () => {
    const cache = sharedCache()
    const before = { seasons: await testPrisma.season.count(), cosmetics: await testPrisma.userCosmetic.count() }
    const reports = await run(cache, { dryRun: true })
    expect(reports.filter((report) => report.status === 'planned').map((report) => report.step)).toEqual(['season', 'leaderboards', 'cosmetics'])
    expect({ seasons: await testPrisma.season.count(), cosmetics: await testPrisma.userCosmetic.count() }).toEqual(before)
    expect(await cache.get('lb:ready')).toBeNull()
  })

  it('refuses production without Upstash and touches nothing', async () => {
    const cache = sharedCache()
    const before = await testPrisma.season.count()
    await expect(postdeploy.runPostdeploy({ env: { NODE_ENV: 'production' }, cache, prisma: testPrisma as never, runJob: async () => ({}) })).rejects.toThrow(/REFUSING TO RUN/)
    expect(await testPrisma.season.count()).toBe(before)
  })

  describe('ensureActiveSeason', () => {
    it('keeps a season that is running', async () => {
      const running = await testPrisma.season.findFirstOrThrow({ where: { active: true }, orderBy: { number: 'desc' } })
      await testPrisma.season.update({ where: { id: running.id }, data: { endsAt: new Date(Date.now() + 5 * DAY_MS) } })
      const result = await seasons.ensureActiveSeason(testPrisma as never)
      expect(result).toMatchObject({ action: 'kept', season: { id: running.id } })
    })

    it('closes a season that is over, writes its standings and opens the next', async () => {
      const running = await testPrisma.season.findFirstOrThrow({ where: { active: true }, orderBy: { number: 'desc' } })
      await testPrisma.season.update({ where: { id: running.id }, data: { endsAt: new Date(Date.now() - 60 * 60 * 1000) } })
      const result = await seasons.ensureActiveSeason(testPrisma as never)
      expect(result.action).toBe('rolled-over')
      expect(result.season.number).toBe(running.number + 1)
      expect((await testPrisma.season.findUniqueOrThrow({ where: { id: running.id } })).active).toBe(false)
      expect(await testPrisma.season.count({ where: { active: true } })).toBe(1)
    })

    it('opens the next season when none is running and none is due, following on from the last', async () => {
      const last = await testPrisma.season.findFirstOrThrow({ orderBy: { number: 'desc' } })
      await testPrisma.season.updateMany({ data: { active: false } })
      const result = await seasons.ensureActiveSeason(testPrisma as never)
      expect(result.action).toBe('created')
      expect(result.season.number).toBe(last.number + 1)
      expect(result.season.name).toBe(`Season ${last.number + 1}`)
      expect(await testPrisma.season.count({ where: { active: true } })).toBe(1)
      // And asking again does not open another.
      expect((await seasons.ensureActiveSeason(testPrisma as never)).action).toBe('kept')
      expect(await testPrisma.season.count({ where: { active: true } })).toBe(1)
    })

    it('opens two at once only once: parallel runs share one lock', async () => {
      await testPrisma.season.updateMany({ data: { active: false } })
      const results = await Promise.all([1, 2, 3].map(() => seasons.ensureActiveSeason(testPrisma as never)))
      expect(results.filter((result) => result.action === 'created')).toHaveLength(1)
      expect(await testPrisma.season.count({ where: { active: true } })).toBe(1)
    })
  })
})
