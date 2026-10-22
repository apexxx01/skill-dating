import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { env } from '@/lib/env'

// Structured logging: one JSON object per line, so a log platform can index the
// fields. Every line written while a request is being handled carries that
// request's id (see withAuth, which opens the request context), and the same id
// is returned to the caller in the X-Request-Id response header, so a user report
// can be matched to its log lines.
//
// No personal data: log ids, never names, emails or message text. As a backstop,
// fields whose NAME looks sensitive are replaced before anything is written; that
// cannot catch a value hiding under an innocent name, so the rule is on callers.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

const ORDER: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

const SENSITIVE_KEY = /e-?mail|password|passwd|secret|token|authorization|cookie|phone|^ip$|address|session|signature|credential/i

export const REDACTED = '[redacted]'

function redactValue(value: unknown, depth: number): unknown {
  if (value instanceof Error) return serializeError(value)
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value
  if (depth >= 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(inner, depth + 1)
  }
  return out
}

export function redactFields(fields: LogFields): LogFields {
  return redactValue(fields, 0) as LogFields
}

export function serializeError(error: unknown): { name: string; message: string; code?: string; stack?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      // Stacks are long; they are only kept outside production, where a reporter has them anyway.
      ...(process.env.NODE_ENV === 'production' ? {} : { stack: error.stack }),
    }
  }
  return { name: 'NonError', message: typeof error === 'string' ? error : 'a non-error value was thrown' }
}

// --- Request context --------------------------------------------------------

const requestContext = new AsyncLocalStorage<{ requestId: string }>()

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/

/** The caller's X-Request-Id when it is a plausible id (so a gateway's id is kept), otherwise a fresh one. */
export function requestIdFrom(headers: Headers): string {
  const supplied = headers.get('x-request-id')
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID()
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn)
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId
}

// --- Error reporting ---------------------------------------------------------

export type ErrorReporter = (error: unknown, fields: LogFields & { requestId?: string }) => void

let reporter: ErrorReporter | undefined
let reporterResolved = false

/** Replaces the reporter (tests). `undefined` goes back to the default. */
export function setErrorReporter(next: ErrorReporter | undefined) {
  reporter = next
  reporterResolved = next !== undefined
}

/**
 * Reports an error through the Sentry SDK, which is started by src/instrumentation.ts when SENTRY_DSN is set (so before that, or without a DSN, this does nothing). The SDK is
 * imported on first use, so a process without a DSN never loads it. The extra fields are redacted by name here and scrubbed again by the SDK's own hooks
 * (src/lib/observability/scrub.ts). Never throws.
 */
export function createSentryReporter(): ErrorReporter {
  return (error, fields) => {
    const { requestId, ...extra } = fields
    void import('@sentry/nextjs')
      .then((Sentry) => {
        Sentry.withScope((scope) => {
          if (requestId) scope.setTag('requestId', requestId)
          scope.setExtras(redactFields(extra))
          Sentry.captureException(error instanceof Error ? error : new Error(serializeError(error).message))
        })
      })
      .catch(() => undefined)
  }
}

function activeReporter(): ErrorReporter | undefined {
  if (!reporterResolved) {
    reporterResolved = true
    try {
      if (env.SENTRY_DSN) reporter = createSentryReporter()
    } catch {
      reporter = undefined
    }
  }
  return reporter
}

// --- Logger ------------------------------------------------------------------

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  /** Logs at error level and hands the error to the reporter (Sentry when SENTRY_DSN is set). */
  error(message: string, fields?: LogFields & { error?: unknown }): void
}

export interface LoggerOptions {
  write?: (level: LogLevel, line: string) => void
  now?: () => Date
  minLevel?: () => LogLevel | 'silent'
}

function defaultWrite(level: LogLevel, line: string) {
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

function defaultMinLevel(): LogLevel | 'silent' {
  try {
    return env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'warn' : 'info')
  } catch {
    return 'info'
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? defaultWrite
  const now = options.now ?? (() => new Date())
  const minLevel = options.minLevel ?? defaultMinLevel

  const emit = (level: LogLevel, message: string, fields: LogFields = {}) => {
    if (ORDER[level] < ORDER[minLevel()]) return
    const requestId = currentRequestId()
    const line = JSON.stringify({
      ts: now().toISOString(),
      level,
      msg: message,
      ...(requestId ? { requestId } : {}),
      ...redactFields(fields),
    })
    write(level, line)
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields = {}) => {
      emit('error', message, fields)
      try {
        const { error, ...rest } = fields
        activeReporter()?.(error ?? new Error(message), { ...rest, requestId: currentRequestId(), message })
      } catch {
        // Reporting must never turn a handled error into a second one.
      }
    },
  }
}

export const log = createLogger()
