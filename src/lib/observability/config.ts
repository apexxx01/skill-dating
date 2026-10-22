import { scrubBreadcrumb, scrubEvent } from './scrub'

// The options every Sentry runtime is started with (sentry.server.config.ts, sentry.edge.config.ts, src/instrumentation-client.ts). One function, so the server, the edge and
// the browser agree. It reads plain environment values, not src/lib/env.ts: the edge and the browser cannot load the application's validated configuration.
// Without a DSN it returns null and nothing is started: the SDK is not even imported.

export type SentryRuntime = 'server' | 'edge' | 'client'

export const DEFAULT_TRACES_SAMPLE_RATE = 0.05

export interface SentryOptions {
  dsn: string
  environment: string
  release?: string
  tracesSampleRate: number
  sendDefaultPii: false
  /** Whole transactions are sent, so beforeSendTransaction (and with it the scrubbing of every span) applies. The SDK's default, streaming spans one by one, would skip it. */
  traceLifecycle: 'static'
  maxBreadcrumbs: number
  ignoreErrors: (string | RegExp)[]
  beforeSend: (event: Record<string, unknown>) => Record<string, unknown>
  beforeSendTransaction: (event: Record<string, unknown>) => Record<string, unknown>
  beforeBreadcrumb: (crumb: Record<string, unknown>) => Record<string, unknown> | null
}

type Source = Record<string, string | undefined>

/** A rate from the environment, 0 to 1; anything else is the default. */
export function parseSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRACES_SAMPLE_RATE
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_TRACES_SAMPLE_RATE
}

/** Noise that is not a defect: a navigation that was cancelled, the browser's own resize loop, an extension's script. */
const IGNORED: (string | RegExp)[] = ['AbortError', 'ResizeObserver loop limit exceeded', 'ResizeObserver loop completed with undelivered notifications.', /^Non-Error promise rejection captured/, /extension:\/\//]

/**
 * The options for a runtime, or null when no DSN is configured (reporting is off). The browser reads the NEXT_PUBLIC_ copies, which next.config.js fills in from the server
 * ones at build time, so one DSN, one release and one sample rate configure all three.
 */
export function sentryOptions(source: Source, runtime: SentryRuntime): SentryOptions | null {
  const client = runtime === 'client'
  const dsn = client ? source.NEXT_PUBLIC_SENTRY_DSN : source.SENTRY_DSN
  if (!dsn) return null
  const release = client ? source.NEXT_PUBLIC_SENTRY_RELEASE : source.SENTRY_RELEASE || source.VERCEL_GIT_COMMIT_SHA
  return {
    dsn,
    // A preview deployment runs with NODE_ENV=production too; VERCEL_ENV is what tells it from the real thing.
    environment: (client ? source.NEXT_PUBLIC_SENTRY_ENVIRONMENT : source.VERCEL_ENV) || source.NODE_ENV || 'development',
    ...(release ? { release } : {}),
    tracesSampleRate: parseSampleRate(client ? source.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE : source.SENTRY_TRACES_SAMPLE_RATE),
    sendDefaultPii: false,
    traceLifecycle: 'static',
    maxBreadcrumbs: 30,
    ignoreErrors: IGNORED,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  }
}
