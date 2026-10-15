import type { PrismaClient } from '@prisma/client'
import { env } from '@/lib/env'
import { log } from '@/lib/log'

// Product analytics. Every event is stored in our own database (ProductEvent), so
// the numbers exist with no third party at all; with POSTHOG_KEY set the same
// event is also forwarded to PostHog. Callers depend on `track()` only.
//
// No personal data: the user is identified by our internal id, and props are
// filtered down to plain values under names that are safe to keep (counts, ids,
// levels, slugs). Names, emails, free text and the like are dropped, whoever
// passes them.

export const ANALYTICS_EVENTS = [
  'signup',
  'onboarding_completed',
  'project_created',
  'project_shipped',
  'level_up',
  'tier_up',
  'achievement_earned',
] as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number]
export type AnalyticsProps = Record<string, string | number | boolean | null>

const MAX_PROPS = 20
const MAX_STRING = 100

// Names that may hold personal data or user-written text.
const PERSONAL_KEY = /e-?mail|phone|name|^ip$|address|password|token|secret|bio|headline|location|message|content|description|title|url|text/i

/** Keeps primitive values under safe names; drops the rest. Never throws. */
export function sanitizeProps(props: Record<string, unknown> | undefined): AnalyticsProps {
  const out: AnalyticsProps = {}
  if (!props) return out
  for (const [key, value] of Object.entries(props)) {
    if (Object.keys(out).length >= MAX_PROPS) break
    if (PERSONAL_KEY.test(key)) continue
    if (value === null || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = value
    } else if (typeof value === 'string') {
      // A value that looks like an email address or is long enough to be prose is not kept either.
      if (!value.includes('@') && value.length <= MAX_STRING) out[key] = value
    }
  }
  return out
}

export interface AnalyticsRecord {
  name: AnalyticsEventName
  userId: string | null
  props: AnalyticsProps
  at: Date
}

export interface AnalyticsStore {
  write(record: AnalyticsRecord): Promise<void>
}

export interface AnalyticsForwarder {
  forward(record: AnalyticsRecord): Promise<void>
}

export class Analytics {
  constructor(
    private readonly store: AnalyticsStore,
    private readonly forwarder?: AnalyticsForwarder
  ) {}

  get forwarding(): boolean {
    return this.forwarder !== undefined
  }

  /** Records an event. Analytics must never break the action it describes, so this does not throw. */
  async track(userId: string | null, name: AnalyticsEventName, props?: Record<string, unknown>): Promise<void> {
    const record: AnalyticsRecord = { name, userId, props: sanitizeProps(props), at: new Date() }
    try {
      await this.store.write(record)
    } catch (error) {
      log.warn('analytics event was not stored', { event: name, error })
    }
    if (this.forwarder) {
      try {
        await this.forwarder.forward(record)
      } catch (error) {
        log.warn('analytics event was not forwarded', { event: name, error })
      }
    }
  }
}

export function prismaAnalyticsStore(client: PrismaClient): AnalyticsStore {
  return {
    async write({ name, userId, props, at }) {
      await client.productEvent.create({ data: { name, userId, props, createdAt: at } })
    },
  }
}

export function posthogForwarder(apiKey: string, host: string, fetchImpl: typeof fetch = fetch): AnalyticsForwarder {
  const endpoint = `${host.replace(/\/+$/, '')}/capture/`
  return {
    async forward({ name, userId, props, at }) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          event: name,
          distinct_id: userId ?? 'anonymous',
          properties: props,
          timestamp: at.toISOString(),
        }),
        signal: AbortSignal.timeout(3_000),
      })
      if (!response.ok) throw new Error(`PostHog answered ${response.status}`)
    },
  }
}

/** The database store, plus PostHog when it is configured. */
export function createAnalytics(client: PrismaClient): Analytics {
  return new Analytics(prismaAnalyticsStore(client), env.POSTHOG_KEY ? posthogForwarder(env.POSTHOG_KEY, env.POSTHOG_HOST) : undefined)
}

const globalForAnalytics = globalThis as unknown as { __analytics?: Analytics }

export async function getAnalytics(): Promise<Analytics> {
  if (!globalForAnalytics.__analytics) {
    const { prisma } = await import('@/lib/prisma')
    globalForAnalytics.__analytics = createAnalytics(prisma)
  }
  return globalForAnalytics.__analytics
}

/** Replaces the process-wide instance (tests). */
export function setAnalytics(analytics: Analytics | undefined) {
  globalForAnalytics.__analytics = analytics
}

export async function track(userId: string | null, name: AnalyticsEventName, props?: Record<string, unknown>): Promise<void> {
  try {
    await (await getAnalytics()).track(userId, name, props)
  } catch (error) {
    log.warn('analytics is unavailable', { event: name, error })
  }
}
