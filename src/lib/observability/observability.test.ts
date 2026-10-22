import { describe, it, expect } from 'vitest'
import { REDACTED, scrubBreadcrumb, scrubData, scrubEvent, scrubText, scrubUrl } from './scrub'
import { DEFAULT_TRACES_SAMPLE_RATE, parseSampleRate, sentryOptions } from './config'

// Assembled here so that no key-shaped literal sits in the source.
const FAKE_SERVICE_KEY = ['sk', 'test', 'abcdefghijklmnopqrstuvwx'].join('_')

describe('scrubText', () => {
  it('removes e-mail addresses, bearer tokens, JWTs, service keys, long hex and base64 secrets, IP addresses and phone numbers', () => {
    const text = [
      'failed for ada@example.com',
      'Authorization: Bearer abcdefghijklmnop123456',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk0',
      `key ${FAKE_SERVICE_KEY} and re_abcdefghijkl`,
      'hash 0123456789abcdef0123456789abcdef0123',
      'from 203.0.113.42 call +91 98765 43210',
    ].join(' | ')
    const clean = scrubText(text)
    for (const secret of ['ada@example.com', 'abcdefghijklmnop123456', 'eyJhbGciOiJIUzI1NiJ9', FAKE_SERVICE_KEY, 're_abcdefghijkl', '0123456789abcdef0123456789abcdef0123', '203.0.113.42', '98765 43210']) {
      expect(clean, secret).not.toContain(secret)
    }
    expect(clean).toContain(REDACTED)
  })

  it('leaves ordinary text, ids and short numbers alone', () => {
    const text = 'Could not load project cmvj5x3gu000bcnzqja9qjnvw after 3 retries (status 503) at /api/projects'
    expect(scrubText(text)).toBe(text)
  })
})

describe('scrubUrl', () => {
  it('drops the query and the fragment, where tokens and search text travel', () => {
    expect(scrubUrl('https://app.example.com/api/search?q=ada%40example.com&token=abc#frag')).toBe('https://app.example.com/api/search')
    expect(scrubUrl('/settings?next=/x')).toBe('/settings')
  })
})

describe('scrubData', () => {
  it('redacts by field name, to any depth, and scrubs the strings that remain', () => {
    const clean = scrubData({ projectId: 'p1', email: 'a@b.dev', nested: { Authorization: 'x', note: 'mail me at a@b.dev', list: [{ password: 'x', ok: 1 }] }, bio: 'long text' }) as Record<string, any>
    expect(clean.projectId).toBe('p1')
    expect(clean.email).toBe(REDACTED)
    expect(clean.bio).toBe(REDACTED)
    expect(clean.nested.Authorization).toBe(REDACTED)
    expect(clean.nested.note).toBe(`mail me at ${REDACTED}`)
    expect(clean.nested.list[0]).toEqual({ password: REDACTED, ok: 1 })
  })

  it('is bounded: deep, long and wide data is cut', () => {
    let deep: unknown = 'x'
    for (let i = 0; i < 10; i++) deep = { n: deep }
    expect(JSON.stringify(scrubData(deep))).toContain('[truncated]')
    expect((scrubData('a'.repeat(5000)) as string).length).toBeLessThanOrEqual(2000)
    expect((scrubData(Array.from({ length: 500 }, (_, i) => i)) as unknown[]).length).toBe(50)
  })
})

describe('scrubEvent', () => {
  const event = {
    event_id: 'abc',
    release: 'sha1',
    environment: 'production',
    server_name: 'host-1.internal',
    message: 'failed for ada@example.com',
    request: {
      url: 'https://app.example.com/api/search?q=secret',
      method: 'GET',
      query_string: 'q=secret',
      cookies: { __session: 'jwt' },
      data: { password: 'x' },
      env: { REMOTE_ADDR: '203.0.113.42' },
      headers: { Authorization: 'Bearer abcdefghijklmnop123456', Cookie: '__session=abc', 'User-Agent': 'Mozilla/5.0', 'X-Request-Id': 'req-12345678', 'X-Forwarded-For': '203.0.113.42' },
    },
    user: { id: 'cmvj5x3gu000bcnzqja9qjnvw', email: 'ada@example.com', ip_address: '203.0.113.42', username: 'ada' },
    exception: { values: [{ type: 'Error', value: 'cannot send to grace@example.com' }] },
    extra: { projectId: 'p1', email: 'a@b.dev' },
    tags: { requestId: 'req-1', token: 'abc' },
    contexts: { os: { name: 'macOS' }, culture: { locale: 'en-IN', timezone: 'Asia/Kolkata' } },
    breadcrumbs: [
      { category: 'console', message: 'user ada@example.com logged in' },
      { category: 'fetch', data: { url: 'https://app.example.com/api/users?email=a@b.dev', method: 'GET', status_code: 200 } },
    ],
    transaction: 'GET /api/search?q=secret',
  }

  it('keeps what helps and removes what identifies', () => {
    const clean = scrubEvent(event) as Record<string, any>
    expect(clean).toMatchObject({ event_id: 'abc', release: 'sha1', environment: 'production' })
    expect(clean.request).toEqual({ url: 'https://app.example.com/api/search', method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'X-Request-Id': 'req-12345678' } })
    expect(clean.user).toEqual({ id: 'cmvj5x3gu000bcnzqja9qjnvw' })
    expect(clean.message).toBe(`failed for ${REDACTED}`)
    expect(clean.exception.values[0].value).toBe(`cannot send to ${REDACTED}`)
    expect(clean.extra).toEqual({ projectId: 'p1', email: REDACTED })
    expect(clean.tags).toEqual({ requestId: 'req-1', token: REDACTED })
    expect(clean.contexts).toEqual({ os: { name: 'macOS' } })
    expect(clean.transaction).toBe('GET /api/search')
    expect(clean.server_name).toBeUndefined()
    expect(clean.breadcrumbs).toHaveLength(1)
    expect(clean.breadcrumbs[0].data.url).toBe('https://app.example.com/api/users')
    expect(JSON.stringify(clean)).not.toMatch(/ada@example\.com|grace@example\.com|203\.0\.113\.42|abcdefghijklmnop123456|__session|secret/)
  })

  it('does not change the event it was given', () => {
    const before = JSON.stringify(event)
    scrubEvent(event)
    expect(JSON.stringify(event)).toBe(before)
  })

  it('drops a user with no id, and leaves an event with nothing to scrub as it is', () => {
    expect((scrubEvent({ user: { email: 'a@b.dev' } }) as Record<string, unknown>).user).toBeUndefined()
    expect(scrubEvent({ level: 'error' })).toEqual({ level: 'error' })
  })

  it('never lets an unscrubbed event through when scrubbing itself fails', () => {
    const hostile = { message: 'ada@example.com', request: { url: 'x' } } as Record<string, unknown>
    Object.defineProperty(hostile, 'extra', { enumerable: true, get() { throw new Error('boom') } })
    const clean = scrubEvent(hostile) as Record<string, unknown>
    expect(clean.message).toBe('[scrubbing failed]')
    expect(clean.request).toBeUndefined()
  })

  it('scrubs the spans of a transaction', () => {
    const clean = scrubEvent({ type: 'transaction', spans: [{ description: 'GET https://x.example.com/a?token=abc', data: { 'http.query': '?token=abc', url: 'https://x.example.com/a?email=a@b.dev' } }] }) as Record<string, any>
    expect(clean.spans[0].description).toBe('GET https://x.example.com/a')
    expect(JSON.stringify(clean)).not.toMatch(/token=abc|a@b\.dev/)
  })
})

describe('scrubBreadcrumb', () => {
  it('drops console breadcrumbs and strips the query from navigation ones', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'hello' })).toBeNull()
    expect(scrubBreadcrumb({ category: 'navigation', data: { from: '/a?x=1', to: '/b?token=2' } })).toEqual({ category: 'navigation', data: { from: '/a', to: '/b' } })
  })
})

describe('sentryOptions', () => {
  const server = { SENTRY_DSN: 'https://abc@o1.ingest.sentry.io/4507', NODE_ENV: 'production', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'a1b2c3d' }

  it('is off without a DSN, so nothing is started or imported', () => {
    expect(sentryOptions({}, 'server')).toBeNull()
    expect(sentryOptions({ SENTRY_DSN: '' }, 'edge')).toBeNull()
    expect(sentryOptions({ SENTRY_DSN: server.SENTRY_DSN }, 'client')).toBeNull()
  })

  it('tags the release (the commit by default) and the environment (the deployment kind, else NODE_ENV), samples traces at a low rate and collects no personal data by default', () => {
    const options = sentryOptions(server, 'server')!
    expect(options).toMatchObject({ dsn: server.SENTRY_DSN, release: 'a1b2c3d', environment: 'preview', tracesSampleRate: DEFAULT_TRACES_SAMPLE_RATE, sendDefaultPii: false, traceLifecycle: 'static' })
    expect(sentryOptions({ ...server, SENTRY_RELEASE: 'v1.2.3' }, 'edge')!.release).toBe('v1.2.3')
    expect(sentryOptions({ SENTRY_DSN: server.SENTRY_DSN, NODE_ENV: 'production' }, 'server')!.environment).toBe('production')
    expect(sentryOptions({ SENTRY_DSN: server.SENTRY_DSN }, 'server')!.release).toBeUndefined()
  })

  it('reads the browser’s settings from the NEXT_PUBLIC_ copies', () => {
    const options = sentryOptions({ NEXT_PUBLIC_SENTRY_DSN: server.SENTRY_DSN, NEXT_PUBLIC_SENTRY_RELEASE: 'a1b2c3d', NEXT_PUBLIC_SENTRY_ENVIRONMENT: 'production', NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: '0.2' }, 'client')!
    expect(options).toMatchObject({ release: 'a1b2c3d', environment: 'production', tracesSampleRate: 0.2 })
  })

  it('wires the scrubbers into the three hooks', () => {
    const options = sentryOptions(server, 'server')!
    expect(JSON.stringify(options.beforeSend({ message: 'ada@example.com' }))).not.toContain('ada@example.com')
    expect(JSON.stringify(options.beforeSendTransaction({ transaction: '/a?token=1' }))).not.toContain('token')
    expect(options.beforeBreadcrumb({ category: 'console', message: 'x' })).toBeNull()
  })

  it('takes a sample rate between 0 and 1 and falls back to the default for anything else', () => {
    expect(parseSampleRate('0.25')).toBe(0.25)
    expect(parseSampleRate('0')).toBe(0)
    expect(parseSampleRate('1')).toBe(1)
    for (const bad of [undefined, '', 'abc', '2', '-1', 'NaN']) expect(parseSampleRate(bad)).toBe(DEFAULT_TRACES_SAMPLE_RATE)
  })
})
