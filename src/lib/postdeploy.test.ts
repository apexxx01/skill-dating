import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryCache } from './infra/cache.memory'
import { BOARDS_READY_KEY } from './leaderboard-write'

const ensureActiveSeason = vi.fn()
vi.mock('@/lib/seasons', () => ({ ensureActiveSeason: (...args: unknown[]) => ensureActiveSeason(...args) }))

import { checkEnvironment, PostdeployError, runPostdeploy, type PostdeployDeps } from './postdeploy'

const SECRET_URL = 'https://secret-host.example.upstash.io'
const SECRET_TOKEN = 'tok_super_secret_value'
const upstash = { UPSTASH_REDIS_REST_URL: SECRET_URL, UPSTASH_REDIS_REST_TOKEN: SECRET_TOKEN }
const production = { NODE_ENV: 'production', ...upstash }

const season = { id: 's1', number: 1, name: 'Season 1', startsAt: new Date('2026-10-01T00:00:00Z'), endsAt: new Date('2026-11-26T00:00:00Z') }

/** A cache that says it is Upstash (and can be made to fail its ping), over the in-process one. */
function upstashLike(over: { pingFails?: boolean } = {}) {
  const cache = new MemoryCache()
  return Object.assign(cache, { kind: 'upstash' as const, ping: async () => { if (over.pingFails) throw new Error('unreachable') } })
}

function deps(over: Partial<PostdeployDeps> = {}) {
  const lines: string[] = []
  const prisma = { $queryRaw: vi.fn(async () => [{ '?column?': 1 }]), season: { findFirst: vi.fn(async () => season) } }
  const runJob = vi.fn(async (name: string, data: unknown) => {
    if (name === 'leaderboards/reconcile') {
      await (over.cache ?? cache).set(BOARDS_READY_KEY, 'x')
      return { periods: 4, boards: 9, members: 120, replayed: 0 }
    }
    const after = (data as { after?: string }).after
    return after ? { users: 3, granted: 2, next: null } : { users: 500, granted: 40, next: 'u-500' }
  })
  const cache = upstashLike()
  const all = { env: production, cache, prisma: prisma as never, runJob, say: (line: string) => lines.push(line), now: () => new Date('2026-10-16T12:00:00Z'), ...over } as PostdeployDeps
  return { all, lines, prisma, runJob }
}

beforeEach(() => {
  ensureActiveSeason.mockReset().mockResolvedValue({ action: 'kept', season })
})

describe('checkEnvironment', () => {
  it('refuses production without Upstash, naming what is missing', () => {
    expect(() => checkEnvironment({ NODE_ENV: 'production' })).toThrow(PostdeployError)
    expect(() => checkEnvironment({ NODE_ENV: 'production' })).toThrow(/UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set/)
    expect(() => checkEnvironment({ NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: SECRET_URL })).toThrow(/UPSTASH_REDIS_REST_TOKEN is not set/)
    expect(() => checkEnvironment({ NODE_ENV: 'production', UPSTASH_REDIS_REST_TOKEN: SECRET_TOKEN })).toThrow(/UPSTASH_REDIS_REST_URL is not set/)
  })

  it('treats empty settings as missing, the way the app does', () => {
    expect(() => checkEnvironment({ NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: '  ', UPSTASH_REDIS_REST_TOKEN: '' })).toThrow(PostdeployError)
  })

  it('never prints a value, in the error or anywhere else', () => {
    for (const env of [{ NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: SECRET_URL }, { NODE_ENV: 'production', UPSTASH_REDIS_REST_TOKEN: SECRET_TOKEN }]) {
      try {
        checkEnvironment(env)
        throw new Error('expected a refusal')
      } catch (error) {
        expect(String(error)).not.toContain(SECRET_URL)
        expect(String(error)).not.toContain(SECRET_TOKEN)
      }
    }
  })

  it('knows a Vercel production deployment from a preview, as the app does', () => {
    expect(() => checkEnvironment({ NODE_ENV: 'production', VERCEL_ENV: 'production' })).toThrow(PostdeployError)
    expect(checkEnvironment({ NODE_ENV: 'production', VERCEL_ENV: 'preview' }).production).toBe(false)
  })

  it('can be told it is production when the environment does not say so', () => {
    expect(() => checkEnvironment({}, undefined, { forceProduction: true })).toThrow(PostdeployError)
    expect(checkEnvironment({ ...upstash }, undefined, { forceProduction: true }).production).toBe(true)
  })

  it('accepts production with Upstash, and refuses it if the app is not using Upstash for its cache', () => {
    expect(checkEnvironment(production, { kind: 'upstash' })).toMatchObject({ production: true, upstash: true, warnings: [] })
    expect(() => checkEnvironment(production, { kind: 'memory' })).toThrow(/not using Upstash/)
  })

  it('lets a development environment go on without Upstash, with a warning that says what is not built', () => {
    const result = checkEnvironment({}, { kind: 'memory' })
    expect(result).toMatchObject({ production: false, upstash: false })
    expect(result.warnings[0]).toMatch(/leaderboards are not rebuilt here/)
  })
})

describe('runPostdeploy', () => {
  it('stops production without Upstash before touching the database or running anything', async () => {
    const { all, prisma, runJob } = deps({ env: { NODE_ENV: 'production' } })
    await expect(runPostdeploy(all)).rejects.toThrow(/REFUSING TO RUN/)
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
    expect(ensureActiveSeason).not.toHaveBeenCalled()
    expect(runJob).not.toHaveBeenCalled()
  })

  it('stops production when Upstash does not answer', async () => {
    const { all, runJob } = deps({ cache: upstashLike({ pingFails: true }) })
    await expect(runPostdeploy(all)).rejects.toThrow(/did not answer a ping/)
    expect(runJob).not.toHaveBeenCalled()
  })

  it('runs the steps in order: environment, database, season, leaderboards, cosmetics', async () => {
    const { all, runJob } = deps()
    const reports = await runPostdeploy(all)
    expect(reports.map((report) => [report.step, report.status])).toEqual([['environment', 'done'], ['database', 'done'], ['season', 'done'], ['leaderboards', 'done'], ['cosmetics', 'done']])
    expect(ensureActiveSeason).toHaveBeenCalledWith(all.prisma, new Date('2026-10-16T12:00:00Z'))
    expect(runJob.mock.calls[0]).toEqual(['leaderboards/reconcile', {}])
    expect(ensureActiveSeason.mock.invocationCallOrder[0]).toBeLessThan(runJob.mock.invocationCallOrder[0])
  })

  it('pages the cosmetics backfill with the cursor it hands back until it is done', async () => {
    const { all, runJob, lines } = deps()
    const reports = await runPostdeploy(all)
    expect(runJob.mock.calls.slice(1)).toEqual([['cosmetics/backfill', {}], ['cosmetics/backfill', { after: 'u-500' }]])
    expect(reports.find((report) => report.step === 'cosmetics')!.detail).toBe('503 people checked in 2 pages, 42 cosmetics granted')
    expect(lines.some((line) => line.startsWith('[done] cosmetics'))).toBe(true)
  })

  it('says what it did to the season', async () => {
    ensureActiveSeason.mockResolvedValue({ action: 'created', season })
    const reports = await runPostdeploy(deps().all)
    expect(reports.find((report) => report.step === 'season')!.detail).toMatch(/Season 1 none was running: opened/)
  })

  it('does everything but the leaderboards outside production without Upstash, and warns', async () => {
    const { all, runJob, lines } = deps({ env: {}, cache: new MemoryCache() })
    const reports = await runPostdeploy(all)
    expect(reports.find((report) => report.step === 'leaderboards')!.status).toBe('skipped')
    expect(runJob.mock.calls.map((call) => call[0])).toEqual(['cosmetics/backfill', 'cosmetics/backfill'])
    expect(ensureActiveSeason).toHaveBeenCalled()
    expect(lines.some((line) => line.startsWith('WARNING:'))).toBe(true)
  })

  it('changes nothing in a dry run, and says what it would do', async () => {
    const { all, runJob } = deps()
    const reports = await runPostdeploy(all, { dryRun: true })
    expect(ensureActiveSeason).not.toHaveBeenCalled()
    expect(runJob).not.toHaveBeenCalled()
    expect(reports.filter((report) => report.status === 'planned').map((report) => report.step)).toEqual(['season', 'leaderboards', 'cosmetics'])
    expect(reports.find((report) => report.step === 'season')!.detail).toMatch(/Season 1 is running until/)
  })

  it('still refuses production without Upstash in a dry run', async () => {
    await expect(runPostdeploy(deps({ env: { NODE_ENV: 'production' } }).all, { dryRun: true })).rejects.toThrow(/REFUSING TO RUN/)
  })

  it('notices a season that is over in a dry run', async () => {
    const { all, prisma } = deps()
    prisma.season.findFirst.mockResolvedValue({ ...season, endsAt: new Date('2026-10-01T00:00:00Z') })
    const reports = await runPostdeploy(all, { dryRun: true })
    expect(reports.find((report) => report.step === 'season')!.detail).toMatch(/is over: it would be closed/)
  })

  it('fails loudly when a step fails, and runs nothing after it', async () => {
    const { all, runJob, lines } = deps()
    runJob.mockRejectedValueOnce(new Error('redis went away'))
    await expect(runPostdeploy(all)).rejects.toThrow('redis went away')
    expect(runJob).toHaveBeenCalledTimes(1)
    expect(lines.some((line) => line.startsWith('[FAILED] leaderboards'))).toBe(true)
  })

  it('fails when the database cannot be reached, before the season', async () => {
    const { all, prisma } = deps()
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'))
    await expect(runPostdeploy(all)).rejects.toThrow('connection refused')
    expect(ensureActiveSeason).not.toHaveBeenCalled()
  })

  it('fails when the rebuild finished but the cache did not keep it', async () => {
    const { all, runJob } = deps()
    runJob.mockImplementation(async () => ({ periods: 4, boards: 9, members: 1, replayed: 0 }))
    await expect(runPostdeploy(all)).rejects.toThrow(/not marked as built/)
  })

  it('is safe to run twice: the second run reports the same steps', async () => {
    const { all } = deps()
    const first = await runPostdeploy(all)
    const second = await runPostdeploy(all)
    expect(second.map((report) => [report.step, report.status])).toEqual(first.map((report) => [report.step, report.status]))
  })

  it('never prints a secret', async () => {
    const { all, lines } = deps()
    await runPostdeploy(all)
    expect(lines.join('\n')).not.toContain(SECRET_URL)
    expect(lines.join('\n')).not.toContain(SECRET_TOKEN)
  })
})
