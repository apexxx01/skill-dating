import { describe, it, expect, afterEach, vi } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import { setCache } from '@/lib/infra/cache'
import { MemoryCache } from '@/lib/infra/cache.memory'
import {
  CacheRateLimiter,
  UNTRUSTED_SHARED_BUCKET_MULTIPLIER,
  clientIp,
  consumeSafely,
  enforceRateLimit,
  getRateLimiter,
  setRateLimiter,
  tooManyRequests,
  type RateLimiter,
  type RateLimitOptions,
} from './rate-limiter'

const opts = { windowMs: 1000, maxRequests: 3 }

describe('CacheRateLimiter', () => {
  // The limiter holds no state of its own: a clock-controlled in-memory cache stands in for Redis.
  function setup() {
    const clock = { now: 1_000_000 }
    const cache = new MemoryCache(1000, () => clock.now)
    return { clock, cache, limiter: new CacheRateLimiter(() => cache) }
  }

  it('allows up to the limit then blocks with a positive retry-after', async () => {
    const { limiter } = setup()
    for (let i = 0; i < 3; i++) {
      expect((await limiter.consume('k', opts)).allowed).toBe(true)
    }
    const blocked = await limiter.consume('k', opts)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it('reports how many requests are left', async () => {
    const { limiter } = setup()
    expect((await limiter.consume('k', opts)).remaining).toBe(2)
    expect((await limiter.consume('k', opts)).remaining).toBe(1)
    expect((await limiter.consume('k', opts)).remaining).toBe(0)
    expect((await limiter.consume('k', opts)).remaining).toBe(0)
  })

  it('tracks keys independently', async () => {
    const { limiter } = setup()
    for (let i = 0; i < 3; i++) await limiter.consume('a', opts)
    expect((await limiter.consume('a', opts)).allowed).toBe(false)
    expect((await limiter.consume('b', opts)).allowed).toBe(true)
  })

  it('opens a fresh window after the old one expires', async () => {
    const { limiter, clock } = setup()
    for (let i = 0; i < 3; i++) await limiter.consume('k', opts)
    expect((await limiter.consume('k', opts)).allowed).toBe(false)
    clock.now += 1001
    expect((await limiter.consume('k', opts)).allowed).toBe(true)
  })

  it('does not extend the window when a blocked caller keeps trying', async () => {
    const { limiter, clock } = setup()
    for (let i = 0; i < 3; i++) await limiter.consume('k', opts)
    clock.now += 600
    expect((await limiter.consume('k', opts)).allowed).toBe(false)
    clock.now += 450
    expect((await limiter.consume('k', opts)).allowed).toBe(true)
  })

  it('counts a shared cache across limiter instances, as separate app instances would', async () => {
    const { cache } = setup()
    const one = new CacheRateLimiter(() => cache)
    const two = new CacheRateLimiter(() => cache)
    for (let i = 0; i < 3; i++) await one.consume('k', opts)
    expect((await two.consume('k', opts)).allowed).toBe(false)
  })

  it('uses the process-wide cache by default', async () => {
    const cache = new MemoryCache()
    setCache(cache)
    try {
      await new CacheRateLimiter().consume('shared', opts)
      expect(await cache.get('ratelimit:shared')).toBe('1')
    } finally {
      setCache(undefined)
    }
  })
})

describe('clientIp', () => {
  const withEnv = (hops: string | undefined) => {
    if (hops === undefined) delete process.env.TRUSTED_PROXY_HOPS
    else process.env.TRUSTED_PROXY_HOPS = hops
    resetEnvCache()
  }
  afterEach(() => withEnv(undefined))

  const req = (xff?: string) =>
    new Request('http://localhost/x', { headers: xff ? { 'x-forwarded-for': xff } : {} })

  it('ignores forwarding headers entirely when no proxy is trusted', () => {
    withEnv(undefined)
    expect(clientIp(req('1.2.3.4'))).toBeNull()
  })

  it('takes the entry appended by the trusted proxy, not the forgeable leftmost one', () => {
    withEnv('1')
    expect(clientIp(req('6.6.6.6, 203.0.113.7'))).toBe('203.0.113.7')
    expect(clientIp(req('anything, at, all, 203.0.113.7'))).toBe('203.0.113.7')
  })

  it('counts N hops from the right when N proxies are trusted', () => {
    withEnv('2')
    expect(clientIp(req('6.6.6.6, 198.51.100.4, 10.0.0.1'))).toBe('198.51.100.4')
  })

  it('returns null when the header has fewer entries than trusted hops', () => {
    withEnv('2')
    expect(clientIp(req('203.0.113.7'))).toBeNull()
  })

  it('returns null when the header is absent', () => {
    withEnv('1')
    expect(clientIp(req())).toBeNull()
  })
})

describe('enforceRateLimit', () => {
  const original = getRateLimiter()
  afterEach(() => {
    setRateLimiter(original)
    delete process.env.TRUSTED_PROXY_HOPS
    resetEnvCache()
  })

  function capture() {
    const calls: { key: string; options: RateLimitOptions }[] = []
    const limiter: RateLimiter = {
      async consume(key, options) {
        calls.push({ key, options })
        return { allowed: true, remaining: 1, retryAfterSeconds: 0 }
      },
    }
    setRateLimiter(limiter)
    return calls
  }
  const config = { windowMs: 60_000, maxRequests: 10, keyPrefix: 'auth:register' }
  const request = (xff?: string) => new Request('http://localhost/x', { headers: xff ? { 'x-forwarded-for': xff } : {} })

  it('keys authenticated calls on the user id at the configured limit', async () => {
    const calls = capture()
    await enforceRateLimit(request('1.2.3.4'), config, 'user-1')
    expect(calls[0]).toEqual({ key: 'auth:register:u:user-1', options: { windowMs: 60_000, maxRequests: 10 } })
  })

  it('keys on the trusted proxy address at the configured limit', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1'
    resetEnvCache()
    const calls = capture()
    await enforceRateLimit(request('6.6.6.6, 203.0.113.9'), config)
    expect(calls[0]).toEqual({ key: 'auth:register:ip:203.0.113.9', options: { windowMs: 60_000, maxRequests: 10 } })
  })

  it('sizes the shared no-proxy bucket as a flood guard so one caller cannot exhaust it for everyone', async () => {
    const calls = capture()
    await enforceRateLimit(request('1.2.3.4'), config)
    expect(calls[0].key).toBe('auth:register:ip:untrusted')
    expect(calls[0].options.maxRequests).toBe(10 * UNTRUSTED_SHARED_BUCKET_MULTIPLIER)

    // Ten sign-ups from one caller no longer lock everyone else out.
    setRateLimiter(new CacheRateLimiter(() => new MemoryCache()))
    for (let i = 0; i < 10; i++) expect(await enforceRateLimit(request(), config)).toBeNull()
    expect(await enforceRateLimit(request(), config)).toBeNull()
  })
})

describe('limiter failure handling', () => {
  const original = getRateLimiter()
  const failing: RateLimiter = {
    async consume() {
      throw new Error('store down')
    },
  }
  afterEach(() => {
    setRateLimiter(original)
    vi.restoreAllMocks()
  })

  it('lets ordinary requests through when the limiter fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setRateLimiter(failing)
    const decision = await consumeSafely('k', opts)
    expect(decision.allowed).toBe(true)
    expect(decision.unavailable).toBe(true)
  })

  it('refuses protected requests (login) with a 503 rather than waving them through', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setRateLimiter(failing)
    const decision = await consumeSafely('k', opts, { failClosed: true })
    expect(decision.allowed).toBe(false)
    const response = tooManyRequests(decision)
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
  })

  it('still answers a normal refusal with 429 and Retry-After', () => {
    const response = tooManyRequests({ allowed: false, remaining: 0, retryAfterSeconds: 42 })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('42')
  })
})
