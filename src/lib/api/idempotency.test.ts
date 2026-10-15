import { describe, it, expect, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { withIdempotency, parseIdempotencyKey, requestFingerprint, IDEMPOTENCY_TTL_MS, MAX_STORED_BODY_BYTES } from './idempotency'
import { MemoryCache } from '../infra/cache.memory'

const post = (body: unknown, key?: string, path = '/api/projects') =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  })

const created = (id: string) => () => Promise.resolve(NextResponse.json({ id }, { status: 201 }))

describe('parseIdempotencyKey', () => {
  it('accepts 8 to 128 plain characters', () => {
    expect(parseIdempotencyKey('abcdefgh')).toEqual({ key: 'abcdefgh' })
    expect(parseIdempotencyKey('3f1c9b1e-6d1c-4c3e-9b52-1f0f5f5e9a77')).toEqual({ key: '3f1c9b1e-6d1c-4c3e-9b52-1f0f5f5e9a77' })
    expect(parseIdempotencyKey('a'.repeat(128))).toEqual({ key: 'a'.repeat(128) })
  })

  it('rejects the rest, and treats a missing header as no key', () => {
    expect(parseIdempotencyKey(null)).toBeNull()
    for (const bad of ['', 'short', 'a'.repeat(129), 'has space here', 'new\nline-key', '<script>', 'ключ-ключ-ключ']) {
      expect(parseIdempotencyKey(bad)).toEqual({ invalid: true })
    }
  })
})

describe('requestFingerprint', () => {
  it('differs by method, path, query and body', () => {
    const base = requestFingerprint('POST', '/a', '{}')
    expect(requestFingerprint('PUT', '/a', '{}')).not.toBe(base)
    expect(requestFingerprint('POST', '/b', '{}')).not.toBe(base)
    expect(requestFingerprint('POST', '/a?x=1', '{}')).not.toBe(base)
    expect(requestFingerprint('POST', '/a', '{"a":1}')).not.toBe(base)
    expect(requestFingerprint('POST', '/a', '{}')).toBe(base)
  })

  it('cannot be confused by moving text between the parts', () => {
    expect(requestFingerprint('POST', '/a', 'b')).not.toBe(requestFingerprint('POST', '/ab', ''))
  })
})

describe('withIdempotency', () => {
  it('does nothing without the header', async () => {
    const cache = new MemoryCache()
    const run = vi.fn(created('p1'))
    await withIdempotency(post({ name: 'a' }), 'u1', cache, run)
    await withIdempotency(post({ name: 'a' }), 'u1', cache, run)
    expect(run).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(0)
  })

  it('rejects a malformed key before running anything', async () => {
    const run = vi.fn(created('p1'))
    const response = await withIdempotency(post({}, 'bad key!!'), 'u1', new MemoryCache(), run)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('IDEMPOTENCY_KEY_INVALID')
    expect(run).not.toHaveBeenCalled()
  })

  it('runs once and replays the same status and body for the same key and request', async () => {
    const cache = new MemoryCache()
    const run = vi.fn(created('p1'))
    const first = await withIdempotency(post({ name: 'a' }, 'key-000001'), 'u1', cache, run)
    const second = await withIdempotency(post({ name: 'a' }, 'key-000001'), 'u1', cache, run)
    const third = await withIdempotency(post({ name: 'a' }, 'key-000001'), 'u1', cache, run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(first.status).toBe(201)
    expect(first.headers.get('Idempotent-Replayed')).toBeNull()
    for (const replayed of [second, third]) {
      expect(replayed.status).toBe(201)
      expect(await replayed.json()).toEqual({ id: 'p1' })
      expect(replayed.headers.get('Idempotent-Replayed')).toBe('true')
      expect(replayed.headers.get('content-type')).toContain('application/json')
    }
  })

  it('still lets the handler read the body after the fingerprint was taken', async () => {
    const request = post({ name: 'readable' }, 'key-000002')
    await withIdempotency(request, 'u1', new MemoryCache(), async () => {
      expect(await request.json()).toEqual({ name: 'readable' })
      return NextResponse.json({}, { status: 201 })
    })
  })

  it('answers 409 when the key comes back with a different body', async () => {
    const cache = new MemoryCache()
    const run = vi.fn(created('p1'))
    await withIdempotency(post({ name: 'a' }, 'key-000003'), 'u1', cache, run)
    const response = await withIdempotency(post({ name: 'DIFFERENT' }, 'key-000003'), 'u1', cache, run)
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('answers 409 when the key comes back on a different path', async () => {
    const cache = new MemoryCache()
    await withIdempotency(post({ name: 'a' }, 'key-000004', '/api/projects'), 'u1', cache, created('p1'))
    const response = await withIdempotency(post({ name: 'a' }, 'key-000004', '/api/teams'), 'u1', cache, created('t1'))
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('keeps keys apart between users', async () => {
    const cache = new MemoryCache()
    const runA = vi.fn(created('a'))
    const runB = vi.fn(created('b'))
    await withIdempotency(post({ name: 'x' }, 'shared-key-1'), 'userA', cache, runA)
    const forB = await withIdempotency(post({ name: 'x' }, 'shared-key-1'), 'userB', cache, runB)
    expect(runB).toHaveBeenCalledTimes(1)
    expect(await forB.json()).toEqual({ id: 'b' })
    expect(forB.headers.get('Idempotent-Replayed')).toBeNull()
  })

  it('runs the handler once when the same request arrives twice at the same time', async () => {
    const cache = new MemoryCache()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const run = vi.fn(async () => {
      await gate
      return NextResponse.json({ id: 'p1' }, { status: 201 })
    })
    const first = withIdempotency(post({ name: 'a' }, 'key-000005'), 'u1', cache, run)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await withIdempotency(post({ name: 'a' }, 'key-000005'), 'u1', cache, run)
    expect(second.status).toBe(409)
    expect((await second.json()).error.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS')
    expect(second.headers.get('Retry-After')).toBe('1')
    release()
    expect((await first).status).toBe(201)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('lets exactly one of many simultaneous identical requests run', async () => {
    const cache = new MemoryCache()
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return NextResponse.json({ id: 'p1' }, { status: 201 })
    })
    const responses = await Promise.all(Array.from({ length: 10 }, () => withIdempotency(post({ name: 'a' }, 'key-000006'), 'u1', cache, run)))
    expect(run).toHaveBeenCalledTimes(1)
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1)
    expect(responses.filter((response) => response.status === 409)).toHaveLength(9)
  })

  it('releases the key after a failure, so the client can fix the request and retry', async () => {
    const cache = new MemoryCache()
    const failing = vi.fn(async () => NextResponse.json({ error: { code: 'VALIDATION_FAILED' } }, { status: 400 }))
    const bad = await withIdempotency(post({ name: '' }, 'key-000007'), 'u1', cache, failing)
    expect(bad.status).toBe(400)
    const run = vi.fn(created('p1'))
    const good = await withIdempotency(post({ name: 'fixed' }, 'key-000007'), 'u1', cache, run)
    expect(good.status).toBe(201)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('releases the key when the handler throws', async () => {
    const cache = new MemoryCache()
    await expect(withIdempotency(post({ name: 'a' }, 'key-000008'), 'u1', cache, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    const run = vi.fn(created('p1'))
    expect((await withIdempotency(post({ name: 'a' }, 'key-000008'), 'u1', cache, run)).status).toBe(201)
  })

  it('does not replay a rate-limit or server error', async () => {
    const cache = new MemoryCache()
    for (const status of [429, 500, 503]) {
      const key = `key-status-${status}`
      await withIdempotency(post({ a: 1 }, key), 'u1', cache, async () => NextResponse.json({}, { status }))
      const run = vi.fn(created('p1'))
      expect((await withIdempotency(post({ a: 1 }, key), 'u1', cache, run)).status).toBe(201)
    }
  })

  it('does not store a response that is too large, and does not fail the request', async () => {
    const cache = new MemoryCache()
    const big = 'x'.repeat(MAX_STORED_BODY_BYTES + 1)
    const run = vi.fn(async () => NextResponse.json({ big }, { status: 201 }))
    const first = await withIdempotency(post({ a: 1 }, 'key-000009'), 'u1', cache, run)
    expect(first.status).toBe(201)
    await withIdempotency(post({ a: 1 }, 'key-000009'), 'u1', cache, run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keeps a response for 24 hours and no longer', async () => {
    expect(IDEMPOTENCY_TTL_MS).toBe(24 * 60 * 60 * 1000)
    let now = 0
    const cache = new MemoryCache(1000, () => now)
    const run = vi.fn(created('p1'))
    await withIdempotency(post({ a: 1 }, 'key-000010'), 'u1', cache, run)
    now += IDEMPOTENCY_TTL_MS - 1000
    await withIdempotency(post({ a: 1 }, 'key-000010'), 'u1', cache, run)
    expect(run).toHaveBeenCalledTimes(1)
    now += 2000
    await withIdempotency(post({ a: 1 }, 'key-000010'), 'u1', cache, run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('recovers when the first request died: the claim expires and the retry runs', async () => {
    let now = 0
    const cache = new MemoryCache(1000, () => now)
    // A request that claimed the key and never finished (the process was killed).
    await cache.incr(`idem:u1:${(await import('node:crypto')).createHash('sha256').update('key-000011').digest('hex')}:claim`, { ttlMs: 60_000 })
    const stalled = await withIdempotency(post({ a: 1 }, 'key-000011'), 'u1', cache, created('p1'))
    expect(stalled.status).toBe(409)
    now += 61_000
    const run = vi.fn(created('p1'))
    expect((await withIdempotency(post({ a: 1 }, 'key-000011'), 'u1', cache, run)).status).toBe(201)
  })

  it('processes the request normally when the store is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cache = new MemoryCache()
    cache.get = vi.fn().mockRejectedValue(new Error('redis down'))
    const run = vi.fn(created('p1'))
    expect((await withIdempotency(post({ a: 1 }, 'key-000012'), 'u1', cache, run)).status).toBe(201)
    expect(run).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
