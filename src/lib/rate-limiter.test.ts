import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  MemoryRateLimiter,
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

describe('MemoryRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows up to the limit then blocks with a positive retry-after', async () => {
    const limiter = new MemoryRateLimiter()
    for (let i = 0; i < 3; i++) {
      expect((await limiter.consume('k', opts)).allowed).toBe(true)
    }
    const blocked = await limiter.consume('k', opts)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it('tracks keys independently', async () => {
    const limiter = new MemoryRateLimiter()
    for (let i = 0; i < 3; i++) await limiter.consume('a', opts)
    expect((await limiter.consume('a', opts)).allowed).toBe(false)
    expect((await limiter.consume('b', opts)).allowed).toBe(true)
  })

  it('opens a fresh window after the old one expires', async () => {
    vi.useFakeTimers()
    const limiter = new MemoryRateLimiter()
    for (let i = 0; i < 3; i++) await limiter.consume('k', opts)
    expect((await limiter.consume('k', opts)).allowed).toBe(false)
    vi.advanceTimersByTime(1001)
    expect((await limiter.consume('k', opts)).allowed).toBe(true)
  })

  it('sweeps expired buckets so memory does not grow forever', async () => {
    vi.useFakeTimers()
    const limiter = new MemoryRateLimiter()
    for (let i = 0; i < 100; i++) await limiter.consume(`k${i}`, opts)
    expect(limiter.size).toBe(100)
    vi.advanceTimersByTime(60_000)
    await limiter.consume('trigger-sweep', opts)
    expect(limiter.size).toBe(1)
  })

  it('hard-caps the number of tracked keys, evicting the oldest', async () => {
    const limiter = new MemoryRateLimiter(10)
    for (let i = 0; i < 50; i++) await limiter.consume(`attacker-${i}`, { windowMs: 60_000, maxRequests: 3 })
    expect(limiter.size).toBeLessThanOrEqual(10)
  })
})

describe('clientIp', () => {
  const withEnv = (hops: string | undefined) => {
    if (hops === undefined) delete process.env.TRUSTED_PROXY_HOPS
    else process.env.TRUSTED_PROXY_HOPS = hops
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
    setRateLimiter(new MemoryRateLimiter())
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
