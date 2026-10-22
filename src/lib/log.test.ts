import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createLogger,
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
  it('hands the error to the SDK with the request id as a tag and the extras redacted, and never throws', async () => {
    const scope = { setTag: vi.fn(), setExtras: vi.fn() }
    const sdk = { withScope: vi.fn((callback: (scope: unknown) => void) => callback(scope)), captureException: vi.fn() }
    vi.doMock('@sentry/nextjs', () => sdk)
    vi.resetModules()
    const { createSentryReporter: fresh } = await import('./log')
    const report = fresh()
    const error = new TypeError('bad thing')
    report(error, { requestId: 'req-1', projectId: 'p1', email: 'a@b.dev' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sdk.captureException).toHaveBeenCalledWith(error)
    expect(scope.setTag).toHaveBeenCalledWith('requestId', 'req-1')
    expect(scope.setExtras).toHaveBeenCalledWith({ projectId: 'p1', email: REDACTED })

    // A thing that is not an Error still becomes one, with a message that does not quote the value.
    report('just a string', {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    const sent = sdk.captureException.mock.calls[1][0] as Error
    expect(sent).toBeInstanceOf(Error)

    vi.doMock('@sentry/nextjs', () => {
      throw new Error('not installed')
    })
    vi.resetModules()
    const { createSentryReporter: broken } = await import('./log')
    expect(() => broken()(new Error('x'), {})).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    vi.doUnmock('@sentry/nextjs')
  })
})
