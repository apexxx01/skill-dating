import { describe, it, expect, vi } from 'vitest'
import { runHealthChecks, healthStatusCode, type HealthDeps } from './health'
import { MemoryCache } from './infra/cache.memory'
import { MemoryRealtime } from './infra/realtime.memory'
import { MemoryJobQueue } from './infra/jobs.memory'
import { jobs } from './infra/jobs'

function deps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    pingDatabase: async () => undefined,
    cache: () => new MemoryCache(),
    jobs: () => new MemoryJobQueue(jobs),
    realtime: () => new MemoryRealtime(),
    ...overrides,
  }
}

const now = () => new Date('2026-01-02T03:04:05.000Z')

describe('runHealthChecks', () => {
  it('is ok when everything answers, and names the implementations', async () => {
    const report = await runHealthChecks(deps(), { now })
    expect(report.status).toBe('ok')
    expect(report.time).toBe('2026-01-02T03:04:05.000Z')
    expect(report.checks.database).toMatchObject({ status: 'ok', provider: 'postgres' })
    expect(report.checks.cache).toMatchObject({ status: 'ok', provider: 'memory' })
    expect(report.checks.jobs).toEqual({ status: 'ok', provider: 'memory' })
    expect(report.checks.realtime).toMatchObject({ status: 'ok', provider: 'memory' })
    expect(typeof report.checks.database.latencyMs).toBe('number')
    expect(healthStatusCode(report)).toBe(200)
  })

  it('is degraded in production while an optional provider is missing, with the names and nothing else', async () => {
    const report = await runHealthChecks(deps({ missingProviders: () => ['email', 'media-scanning'] }), { now })
    expect(report.status).toBe('degraded')
    expect(report.missingProviders).toEqual(['email', 'media-scanning'])
    expect(healthStatusCode(report)).toBe(200)
    // Every check itself still answers: the degradation is the missing providers, not a dependency being down.
    for (const check of Object.values(report.checks)) expect(check.status).toBe('ok')
    expect(JSON.stringify(report)).not.toMatch(/RESEND|VAPID|STORAGE|SENTRY|MODERATION|https?:\/\//)
  })

  it('is ok with no missing providers, and always carries the list', async () => {
    expect((await runHealthChecks(deps({ missingProviders: () => [] }), { now })).missingProviders).toEqual([])
    const without = await runHealthChecks(deps(), { now })
    expect(without.status).toBe('ok')
    expect(without.missingProviders).toEqual([])
  })

  it('stays down, and 503, when the database is down even with providers missing', async () => {
    const report = await runHealthChecks(deps({ pingDatabase: async () => { throw new Error('refused') }, missingProviders: () => ['push'] }), { now })
    expect(report.status).toBe('down')
    expect(healthStatusCode(report)).toBe(503)
  })

  it('survives a failure while working out the missing providers', async () => {
    const report = await runHealthChecks(deps({ missingProviders: () => { throw new Error('boom') } }), { now })
    expect(report.status).toBe('ok')
    expect(report.missingProviders).toEqual([])
  })

  it('is down, and answers 503, when the database does not answer', async () => {
    const report = await runHealthChecks(deps({ pingDatabase: async () => Promise.reject(new Error('connection refused')) }), { now })
    expect(report.status).toBe('down')
    expect(report.checks.database.status).toBe('down')
    expect(healthStatusCode(report)).toBe(503)
  })

  it('is down when the database hangs, after the timeout', async () => {
    const report = await runHealthChecks(deps({ pingDatabase: () => new Promise(() => undefined) }), { timeoutMs: 20, now })
    expect(report.checks.database.status).toBe('down')
    expect(report.status).toBe('down')
  })

  it.each([
    ['cache', { cache: () => Object.assign(new MemoryCache(), { ping: () => Promise.reject(new Error('redis down')) }) }],
    ['realtime', { realtime: () => Object.assign(new MemoryRealtime(), { issueToken: () => Promise.reject(new Error('bad key')) }) }],
  ] as const)('is degraded, and still answers 200, when only the %s is down', async (name, override) => {
    const report = await runHealthChecks(deps(override as Partial<HealthDeps>), { now })
    expect(report.status).toBe('degraded')
    expect(report.checks[name].status).toBe('down')
    expect(report.checks.database.status).toBe('ok')
    expect(healthStatusCode(report)).toBe(200)
  })

  it('treats a provider that cannot be created as a failed check instead of throwing', async () => {
    const report = await runHealthChecks(
      deps({
        cache: () => {
          throw new Error('bad configuration')
        },
        jobs: () => {
          throw new Error('bad configuration')
        },
      }),
      { now }
    )
    expect(report.status).toBe('degraded')
    expect(report.checks.cache).toEqual({ status: 'down', provider: 'unknown' })
    expect(report.checks.jobs).toEqual({ status: 'down', provider: 'unknown' })
  })

  it('runs the checks together, so one slow dependency does not add to the others', async () => {
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 60))
    const started = Date.now()
    await runHealthChecks(deps({ pingDatabase: slow, cache: () => Object.assign(new MemoryCache(), { ping: slow }) }), { now })
    expect(Date.now() - started).toBeLessThan(110)
  })

  it('calls each dependency once', async () => {
    const pingDatabase = vi.fn().mockResolvedValue(undefined)
    await runHealthChecks(deps({ pingDatabase }), { now })
    expect(pingDatabase).toHaveBeenCalledTimes(1)
  })

  it('reports nothing that looks like a secret, host or address', async () => {
    const text = JSON.stringify(await runHealthChecks(deps(), { now }))
    expect(text).not.toMatch(/https?:|@|:\/\/|key|token|secret|password|postgres(ql)?:/i)
  })
})
