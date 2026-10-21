import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

vi.mock('@/lib/session', () => ({ authenticate: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: {}, default: {} }))
vi.mock('@/lib/api/gate', () => ({ gateRequest: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/integrity/risk-job', () => ({ recordThrottleHit: vi.fn() }))
vi.mock('@/lib/rate-limiter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limiter')>()),
  enforceRateLimit: vi.fn().mockResolvedValue(null),
  consumeSafely: vi.fn().mockResolvedValue({ allowed: true }),
}))

import { authenticate } from '@/lib/session'
import { consumeSafely, enforceRateLimit } from '@/lib/rate-limiter'
import { withAuth } from './handler'
import { gateRequest } from './gate'
import { errorResponse } from './errors'
import { setCache } from '@/lib/infra/cache'
import { MemoryCache } from '@/lib/infra/cache.memory'
import { resetEnvCache } from '@/lib/env'
import { setErrorReporter } from '@/lib/log'

const signedIn = (role = 'USER') =>
  vi.mocked(authenticate).mockResolvedValue({
    kind: 'ok',
    user: { id: 'u1', email: 'a@b.dev', name: 'A', username: 'a', image: null, role },
  } as never)

const request = (method = 'GET', headers: Record<string, string> = {}, body?: unknown) =>
  new NextRequest('http://localhost/api/things', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

let lines: Record<string, unknown>[] = []

beforeEach(() => {
  vi.mocked(authenticate).mockReset()
  vi.mocked(enforceRateLimit).mockResolvedValue(null)
  vi.mocked(consumeSafely).mockResolvedValue({ allowed: true } as never)
  setCache(new MemoryCache())
  lines = []
  process.env.LOG_LEVEL = 'debug'
  resetEnvCache()
  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(JSON.parse(line)))
  vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(JSON.parse(line)))
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.LOG_LEVEL
  resetEnvCache()
  setCache(undefined)
  setErrorReporter(undefined)
})

describe('request ids', () => {
  it('puts a fresh id on every response', async () => {
    signedIn()
    const route = withAuth(async () => NextResponse.json({ ok: true }))
    const first = await route(request())
    const second = await route(request())
    expect(first.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(second.headers.get('X-Request-Id')).not.toBe(first.headers.get('X-Request-Id'))
  })

  it('keeps a plausible id sent by the caller or a gateway, and replaces a bad one', async () => {
    signedIn()
    const route = withAuth(async () => NextResponse.json({ ok: true }))
    expect((await route(request('GET', { 'x-request-id': 'gateway-id-12345' }))).headers.get('X-Request-Id')).toBe('gateway-id-12345')
    expect((await route(request('GET', { 'x-request-id': 'bad id!' }))).headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('is on error responses too', async () => {
    vi.mocked(authenticate).mockResolvedValue({ kind: 'anonymous' } as never)
    const response = await withAuth(async () => NextResponse.json({}))(request())
    expect(response.status).toBe(401)
    expect(response.headers.get('X-Request-Id')).toBeTruthy()
  })

  it('is on every log line the handler writes, and on the access line', async () => {
    signedIn()
    const route = withAuth(async () => {
      const { log } = await import('@/lib/log')
      log.info('inside the handler', { thing: 1 })
      return NextResponse.json({ ok: true })
    })
    const response = await route(request('GET', { 'x-request-id': 'trace-me-12345' }))
    expect(response.headers.get('X-Request-Id')).toBe('trace-me-12345')
    const inside = lines.find((line) => line.msg === 'inside the handler')
    const access = lines.find((line) => line.msg === 'request')
    expect(inside).toMatchObject({ requestId: 'trace-me-12345', thing: 1 })
    expect(access).toMatchObject({ requestId: 'trace-me-12345', method: 'GET', path: '/api/things', status: 200, userId: 'u1' })
    expect(typeof access!.durationMs).toBe('number')
  })

  it('keeps the query string, headers and body out of the access line', async () => {
    signedIn()
    const route = withAuth(async () => NextResponse.json({}))
    await route(new NextRequest('http://localhost/api/things?email=a@b.dev&q=secret', { headers: { authorization: 'Bearer tok', cookie: 'c=1' } }))
    const text = JSON.stringify(lines.find((line) => line.msg === 'request'))
    for (const leak of ['a@b.dev', 'secret', 'Bearer', 'tok', 'cookie']) expect(text).not.toContain(leak)
  })
})

describe('unhandled errors', () => {
  it('answers with the error contract instead of a bare 500, and logs it with the request id', async () => {
    signedIn()
    const reported = vi.fn()
    setErrorReporter(reported)
    const route = withAuth(async () => {
      throw new Error('database exploded')
    })
    const response = await route(request('GET', { 'x-request-id': 'boom-request-1' }))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } })
    expect(response.headers.get('X-Request-Id')).toBe('boom-request-1')
    expect(lines.find((line) => line.msg === 'unhandled error in route')).toMatchObject({ level: 'error', requestId: 'boom-request-1', userId: 'u1' })
    expect(reported).toHaveBeenCalledTimes(1)
    expect((reported.mock.calls[0][0] as Error).message).toBe('database exploded')
  })

  it('does not put the error message in the response', async () => {
    signedIn()
    setErrorReporter(vi.fn())
    const response = await withAuth(async () => Promise.reject(new Error('secret connection string')))(request())
    expect(JSON.stringify(await response.json())).not.toContain('secret connection string')
  })
})

describe('role check', () => {
  it('refuses a caller without the role, and lets one with it through', async () => {
    const route = withAuth(async () => NextResponse.json({ ok: true }), { requiredRole: ['ADMIN'] })
    signedIn('USER')
    expect((await route(request())).status).toBe(403)
    signedIn('ADMIN')
    expect((await route(request())).status).toBe(200)
  })
})

describe('idempotent option', () => {
  it('runs a creating POST once for a repeated Idempotency-Key and replays the response', async () => {
    signedIn()
    const handler = vi.fn(async () => NextResponse.json({ id: 'p1' }, { status: 201 }))
    const route = withAuth(handler, { idempotent: true })
    const headers = { 'Idempotency-Key': 'create-project-0001' }
    const first = await route(request('POST', headers, { name: 'a' }))
    const second = await route(request('POST', headers, { name: 'a' }))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.headers.get('Idempotent-Replayed')).toBe('true')
    expect(await second.json()).toEqual({ id: 'p1' })
  })

  it('refuses the same key with a different body', async () => {
    signedIn()
    const route = withAuth(async () => NextResponse.json({ id: 'p1' }, { status: 201 }), { idempotent: true })
    const headers = { 'Idempotency-Key': 'create-project-0002' }
    await route(request('POST', headers, { name: 'a' }))
    const clash = await route(request('POST', headers, { name: 'b' }))
    expect(clash.status).toBe(409)
    expect((await clash.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('ignores the header on a route that did not ask for it, and on other methods', async () => {
    signedIn()
    const handler = vi.fn(async () => NextResponse.json({}, { status: 201 }))
    const headers = { 'Idempotency-Key': 'create-project-0003' }
    const plain = withAuth(handler)
    await plain(request('POST', headers, {}))
    await plain(request('POST', headers, {}))
    const optedIn = withAuth(handler, { idempotent: true })
    await optedIn(request('PATCH', headers, {}))
    await optedIn(request('PATCH', headers, {}))
    expect(handler).toHaveBeenCalledTimes(4)
  })

  it('does nothing without a key', async () => {
    signedIn()
    const handler = vi.fn(async () => NextResponse.json({}, { status: 201 }))
    const route = withAuth(handler, { idempotent: true })
    await route(request('POST', {}, {}))
    await route(request('POST', {}, {}))
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('scopes a key to the signed-in user', async () => {
    const handler = vi.fn(async () => NextResponse.json({}, { status: 201 }))
    const route = withAuth(handler, { idempotent: true })
    const headers = { 'Idempotency-Key': 'shared-between-users' }
    signedIn()
    await route(request('POST', headers, { a: 1 }))
    vi.mocked(authenticate).mockResolvedValue({ kind: 'ok', user: { id: 'u2', email: 'b@b.dev', name: 'B', username: 'b', image: null, role: 'USER' } } as never)
    const other = await route(request('POST', headers, { a: 1 }))
    expect(other.headers.get('Idempotent-Replayed')).toBeNull()
    expect(handler).toHaveBeenCalledTimes(2)
  })
})

describe('request gate', () => {
  it('answers with what the gate refuses, after the role check and before the handler', async () => {
    signedIn()
    vi.mocked(gateRequest).mockResolvedValueOnce(errorResponse('ACCOUNT_SUSPENDED'))
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const res = await withAuth(handler)(request('POST', {}, {}))
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('ACCOUNT_SUSPENDED')
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets the request through when the gate has nothing to say', async () => {
    signedIn()
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    expect((await withAuth(handler)(request())).status).toBe(200)
    expect(handler).toHaveBeenCalled()
  })
})
