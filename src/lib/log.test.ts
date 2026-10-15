import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createLogger,
  createSentryReporter,
  parseSentryDsn,
  redactFields,
  REDACTED,
  requestIdFrom,
  runWithRequestId,
  currentRequestId,
  setErrorReporter,
  serializeError,
} from './log'

function capture(minLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent' = 'info') {
  const lines: { level: string; entry: Record<string, unknown> }[] = []
  const logger = createLogger({
    write: (level, line) => lines.push({ level, entry: JSON.parse(line) }),
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    minLevel: () => minLevel,
  })
  return { lines, logger }
}

afterEach(() => setErrorReporter(undefined))

describe('logger output', () => {
  it('writes one JSON object per call with a UTC timestamp, level and message', () => {
    const { lines, logger } = capture()
    logger.info('project created', { projectId: 'p1' })
    expect(lines).toEqual([{ level: 'info', entry: { ts: '2026-01-02T03:04:05.000Z', level: 'info', msg: 'project created', projectId: 'p1' } }])
  })

  it('drops lines below the minimum level', () => {
    const { lines, logger } = capture('warn')
    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d')
    expect(lines.map((line) => line.entry.msg)).toEqual(['c', 'd'])
  })

  it('writes nothing when silent', () => {
    const { lines, logger } = capture('silent')
    logger.error('x')
    expect(lines).toEqual([])
  })

  it('adds the request id to every line written inside a request, and only there', () => {
    const { lines, logger } = capture()
    logger.info('outside')
    runWithRequestId('req-12345678', () => {
      logger.info('inside')
      return Promise.resolve().then(() => logger.info('after an await'))
    })
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(lines[0].entry.requestId).toBeUndefined()
        expect(lines[1].entry.requestId).toBe('req-12345678')
        expect(lines[2].entry.requestId).toBe('req-12345678')
        expect(currentRequestId()).toBeUndefined()
        resolve()
      }, 0)
    )
  })
})

describe('redaction', () => {
  it('replaces fields whose names look sensitive, at any depth', () => {
    const out = redactFields({
      userId: 'u1',
      email: 'a@b.dev',
      nested: { Authorization: 'Bearer x', ok: 1, deeper: { password: 'p', keep: true } },
      list: [{ token: 't', id: 3 }],
      ip: '1.2.3.4',
      clientSecret: 's',
    })
    expect(out).toEqual({
      userId: 'u1',
      email: REDACTED,
      nested: { Authorization: REDACTED, ok: 1, deeper: { password: REDACTED, keep: true } },
      list: [{ token: REDACTED, id: 3 }],
      ip: REDACTED,
      clientSecret: REDACTED,
    })
  })

  it('does not redact innocent fields that merely contain a short word', () => {
    expect(redactFields({ projectId: 'p', shipped: true, tipCount: 2 })).toEqual({ projectId: 'p', shipped: true, tipCount: 2 })
  })

  it('serialises errors and tolerates cycles and bigints', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    const out = redactFields({ error: new Error('boom'), big: BigInt(5), cyclic })
    expect((out.error as { message: string }).message).toBe('boom')
    expect(out.big).toBe('5')
    expect(JSON.stringify(out)).toContain('[truncated]')
  })

  it('names non-Error throwables without echoing them', () => {
    expect(serializeError({ secret: 'x' })).toEqual({ name: 'NonError', message: 'a non-error value was thrown' })
    expect(serializeError('plain')).toEqual({ name: 'NonError', message: 'plain' })
  })
})

describe('requestIdFrom', () => {
  it('keeps a plausible id from the caller', () => {
    expect(requestIdFrom(new Headers({ 'x-request-id': 'abc-12345.def' }))).toBe('abc-12345.def')
  })

  it('replaces an id that is too short, too long or has odd characters', () => {
    for (const bad of ['short', 'x'.repeat(65), 'has space in it', '<script>alert(1)</script>']) {
      const id = requestIdFrom(new Headers({ 'x-request-id': bad }))
      expect(id).not.toBe(bad)
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('makes a fresh id when none was sent', () => {
    expect(requestIdFrom(new Headers())).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('error reporting', () => {
  it('hands error-level logs to the reporter with the request id and the error', () => {
    const reported = vi.fn()
    setErrorReporter(reported)
    const { logger } = capture()
    const error = new Error('db down')
    runWithRequestId('req-abcdefgh', () => logger.error('could not save', { error, projectId: 'p1' }))
    expect(reported).toHaveBeenCalledTimes(1)
    expect(reported.mock.calls[0][0]).toBe(error)
    expect(reported.mock.calls[0][1]).toMatchObject({ requestId: 'req-abcdefgh', projectId: 'p1' })
  })

  it('does not report below error level, and survives a reporter that throws', () => {
    const reported = vi.fn(() => {
      throw new Error('reporter broke')
    })
    setErrorReporter(reported)
    const { lines, logger } = capture()
    logger.warn('careful')
    expect(reported).not.toHaveBeenCalled()
    expect(() => logger.error('bad')).not.toThrow()
    expect(lines.some((line) => line.entry.msg === 'bad')).toBe(true)
  })
})

describe('Sentry reporter', () => {
  it('parses a DSN into the envelope endpoint and key', () => {
    expect(parseSentryDsn('https://abc123@o1.ingest.sentry.io/4507')).toEqual({
      endpoint: 'https://o1.ingest.sentry.io/api/4507/envelope/',
      publicKey: 'abc123',
    })
    expect(parseSentryDsn('https://abc@sentry.example.com/relay/9')?.endpoint).toBe('https://sentry.example.com/relay/api/9/envelope/')
    expect(parseSentryDsn('https://no-key.example.com/1')).toBeNull()
    expect(createSentryReporter('nonsense')).toBeNull()
  })

  it('posts an envelope with the error and redacted extras, and never throws on a failed send', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const report = createSentryReporter('https://abc123@o1.ingest.sentry.io/4507', fetchImpl as unknown as typeof fetch, 'test')!
    report(new TypeError('bad thing'), { requestId: 'req-1', projectId: 'p1', email: 'a@b.dev' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://o1.ingest.sentry.io/api/4507/envelope/')
    expect(init.headers['X-Sentry-Auth']).toContain('sentry_key=abc123')
    const [header, itemHeader, event] = (init.body as string).split('\n').map((line) => JSON.parse(line))
    expect(header.event_id).toMatch(/^[0-9a-f]{32}$/)
    expect(itemHeader).toEqual({ type: 'event' })
    expect(event.exception.values[0]).toEqual({ type: 'TypeError', value: 'bad thing' })
    expect(event.tags).toEqual({ requestId: 'req-1' })
    expect(event.extra).toEqual({ projectId: 'p1', email: REDACTED })

    const failing = createSentryReporter('https://abc@o1.ingest.sentry.io/1', vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch)!
    expect(() => failing(new Error('x'), {})).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
