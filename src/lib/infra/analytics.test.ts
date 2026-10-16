import { describe, it, expect, vi } from 'vitest'
import { Analytics, ANALYTICS_EVENTS, posthogForwarder, sanitizeProps, type AnalyticsRecord } from './analytics'

const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)

describe('sanitizeProps', () => {
  it('keeps plain values under safe names', () => {
    expect(sanitizeProps({ level: 4, tier: 'GOLD', leveledUp: true, parent: null, slug: 'first-ship' })).toEqual({
      level: 4,
      tier: 'GOLD',
      leveledUp: true,
      parent: null,
      slug: 'first-ship',
    })
  })

  it('drops names that can hold personal data or free text', () => {
    expect(
      sanitizeProps({
        email: 'a@b.dev',
        userEmail: 'a@b.dev',
        name: 'Ada',
        projectName: 'Secret',
        username: 'ada',
        phone: '1',
        ip: '1.2.3.4',
        bio: 'x',
        headline: 'x',
        message: 'x',
        title: 'x',
        url: 'https://x',
        content: 'x',
        level: 2,
      })
    ).toEqual({ level: 2 })
  })

  it('drops values that look like an email address, are long, or are not plain', () => {
    expect(
      sanitizeProps({
        ref: 'someone@example.com',
        long: 'x'.repeat(101),
        nested: { a: 1 },
        list: [1, 2],
        fn: () => 1,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        undef: undefined,
        ok: 'fine',
      })
    ).toEqual({ ok: 'fine' })
  })

  it('caps the number of props and tolerates nothing at all', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]))
    expect(Object.keys(sanitizeProps(many))).toHaveLength(20)
    expect(sanitizeProps(undefined)).toEqual({})
  })
})

describe('Analytics', () => {
  it('stores each event with the user, sanitised props and a timestamp', async () => {
    const written: AnalyticsRecord[] = []
    const analytics = new Analytics({ write: async (record) => void written.push(record) })
    await analytics.track('u1', 'project_created', { projectId: 'p1', projectName: 'Secret' })
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ name: 'project_created', userId: 'u1', props: { projectId: 'p1' } })
    expect(written[0].at).toBeInstanceOf(Date)
  })

  it('forwards stored events when a forwarder is configured, and reports that it does', async () => {
    const forwarded = vi.fn().mockResolvedValue(undefined)
    const analytics = new Analytics({ write: async () => undefined }, { forward: forwarded })
    expect(analytics.forwarding).toBe(true)
    await analytics.track('u1', 'level_up', { level: 3 })
    expect(forwarded).toHaveBeenCalledWith(expect.objectContaining({ name: 'level_up', userId: 'u1', props: { level: 3 } }))
    expect(new Analytics({ write: async () => undefined }).forwarding).toBe(false)
  })

  it('does not throw when the store fails, and still forwards', async () => {
    const warn = quiet()
    const forwarded = vi.fn().mockResolvedValue(undefined)
    const analytics = new Analytics({ write: async () => Promise.reject(new Error('db down')) }, { forward: forwarded })
    await expect(analytics.track('u1', 'signup')).resolves.toBeUndefined()
    expect(forwarded).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not throw when forwarding fails', async () => {
    const warn = quiet()
    const analytics = new Analytics({ write: async () => undefined }, { forward: async () => Promise.reject(new Error('offline')) })
    await expect(analytics.track('u1', 'signup')).resolves.toBeUndefined()
    warn.mockRestore()
  })

  it('accepts an event with no user', async () => {
    const written: AnalyticsRecord[] = []
    await new Analytics({ write: async (record) => void written.push(record) }).track(null, 'signup')
    expect(written[0].userId).toBeNull()
  })

  it('names every event the platform tracks', () => {
    expect([...ANALYTICS_EVENTS]).toEqual(['signup', 'onboarding_completed', 'project_created', 'project_shipped', 'level_up', 'tier_up', 'achievement_earned', 'quest_completed', 'streak_extended'])
  })
})

describe('posthogForwarder', () => {
  const record: AnalyticsRecord = { name: 'tier_up', userId: 'u1', props: { tier: 'SILVER' }, at: new Date('2026-01-02T03:04:05.000Z') }

  it('posts the capture payload with our id as the distinct id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await posthogForwarder('phc_key', 'https://eu.posthog.example/', fetchImpl as unknown as typeof fetch).forward(record)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://eu.posthog.example/capture/')
    expect(JSON.parse(init.body)).toEqual({
      api_key: 'phc_key',
      event: 'tier_up',
      distinct_id: 'u1',
      properties: { tier: 'SILVER' },
      timestamp: '2026-01-02T03:04:05.000Z',
    })
  })

  it('uses a placeholder id for an event without a user', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await posthogForwarder('k', 'https://h.example', fetchImpl as unknown as typeof fetch).forward({ ...record, userId: null })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).distinct_id).toBe('anonymous')
  })

  it('fails when PostHog refuses, so the caller can log it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    await expect(posthogForwarder('k', 'https://h.example', fetchImpl as unknown as typeof fetch).forward(record)).rejects.toThrow('401')
  })
})

describe('createAnalytics', () => {
  it('still stores events when the application configuration is not valid', async () => {
    const { createAnalytics } = await import('./analytics')
    const { resetEnvCache } = await import('../env')
    const saved = { ...process.env }
    delete process.env.DATABASE_URL
    resetEnvCache()
    try {
      const created: unknown[] = []
      const analytics = createAnalytics({ productEvent: { create: async (args: unknown) => void created.push(args) } } as never)
      expect(analytics.forwarding).toBe(false)
      await analytics.track('u1', 'signup')
      expect(created).toHaveLength(1)
    } finally {
      Object.assign(process.env, saved)
      resetEnvCache()
    }
  })
})
