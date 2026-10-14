import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getCache, type Cache } from '@/lib/infra/cache'
import { errorResponse } from '@/lib/api/errors'

// Rate limiting behind a small interface so no route depends on where the
// counters live: implement RateLimiter and call setRateLimiter() to replace it.

export interface RateLimitOptions {
  windowMs: number
  maxRequests: number
}

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
  // True when the decision is a stand-in because the limiter itself failed.
  unavailable?: boolean
}

export interface RateLimiter {
  consume(key: string, options: RateLimitOptions): Promise<RateLimitDecision>
}

// Fixed-window counter on the shared Cache (src/lib/infra/cache.ts): Redis in
// production, so the limit holds across instances, and the in-process cache in
// tests and development. The window starts on a key's first hit and is not
// extended by later ones. Safety properties (expired entries swept, key count
// hard-capped so fabricated keys cannot grow memory) belong to the cache.
export class CacheRateLimiter implements RateLimiter {
  // A function, so a cache replaced with setCache() is picked up.
  constructor(private readonly cache: () => Cache = getCache) {}

  async consume(key: string, { windowMs, maxRequests }: RateLimitOptions): Promise<RateLimitDecision> {
    const { count, ttlMs } = await this.cache().hit(`ratelimit:${key}`, windowMs)
    if (count > maxRequests) {
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) }
    }
    return { allowed: true, remaining: Math.max(0, maxRequests - count), retryAfterSeconds: 0 }
  }
}

// Survives dev-server module reloads so limits are not silently reset by HMR.
const globalForLimiter = globalThis as unknown as { __rateLimiter?: RateLimiter }

export function getRateLimiter(): RateLimiter {
  if (!globalForLimiter.__rateLimiter) globalForLimiter.__rateLimiter = new CacheRateLimiter()
  return globalForLimiter.__rateLimiter
}

export function setRateLimiter(limiter: RateLimiter) {
  globalForLimiter.__rateLimiter = limiter
}

// The client IP is only knowable through a proxy header, and a client can put
// anything it likes in X-Forwarded-For. Each trusted proxy hop APPENDS the
// address it saw, so the only entry a client cannot forge is the one appended
// by our own proxy: TRUSTED_PROXY_HOPS=N means "take the Nth entry from the
// right". With no trusted proxy configured (the default) headers are ignored
// entirely and null is returned - callers must then fall back to something
// that does not depend on the IP (a user id, an account name, or one shared
// bucket).
export function clientIp(request: Request): string | null {
  const hops = env.TRUSTED_PROXY_HOPS
  if (hops < 1) return null

  const forwarded = request.headers.get('x-forwarded-for')
  if (!forwarded) return null
  const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean)
  const index = parts.length - hops
  if (index < 0) return null
  return parts[index] || null
}

// A limiter backed by a shared store can fail. That must not take the whole
// API down, so by default a failure lets the request through (and is logged).
// Callers guarding something an attacker profits from bypassing, such as
// password guessing, pass failClosed: the request is refused with a 503
// instead of being waved through unthrottled.
export async function consumeSafely(
  key: string,
  options: RateLimitOptions,
  { failClosed = false }: { failClosed?: boolean } = {}
): Promise<RateLimitDecision> {
  try {
    return await getRateLimiter().consume(key, options)
  } catch (error) {
    console.error('rate limiter unavailable:', error instanceof Error ? error.message : error)
    return failClosed
      ? { allowed: false, remaining: 0, retryAfterSeconds: 5, unavailable: true }
      : { allowed: true, remaining: options.maxRequests, retryAfterSeconds: 0, unavailable: true }
  }
}

// With no trusted proxy there is no per-client address, so every unauthenticated
// caller shares one bucket. A limit sized for one client would then let anyone
// exhaust it for everybody (for example to block all sign-ups), so the shared
// bucket is a flood guard, sized this many times larger than the per-client limit.
export const UNTRUSTED_SHARED_BUCKET_MULTIPLIER = 10

export interface RateLimitConfig extends RateLimitOptions {
  keyPrefix: string
}

/** Applies one named limit to a request; returns the refusal response or null. */
export async function enforceRateLimit(
  request: Request,
  config: RateLimitConfig,
  userId?: string
): Promise<NextResponse | null> {
  const ip = userId ? null : clientIp(request)
  const shared = !userId && !ip
  const decision = await consumeSafely(`${config.keyPrefix}:${userId ? `u:${userId}` : `ip:${ip ?? 'untrusted'}`}`, {
    windowMs: config.windowMs,
    maxRequests: shared ? config.maxRequests * UNTRUSTED_SHARED_BUCKET_MULTIPLIER : config.maxRequests,
  })
  return decision.allowed ? null : tooManyRequests(decision)
}

export function tooManyRequests(decision: RateLimitDecision): NextResponse {
  const headers: Record<string, string> = { 'Retry-After': String(decision.retryAfterSeconds) }
  if (decision.unavailable) return errorResponse('SERVICE_UNAVAILABLE', { headers })
  return errorResponse('RATE_LIMITED', {
    params: { retryAfter: decision.retryAfterSeconds },
    headers: { ...headers, 'X-RateLimit-Remaining': String(decision.remaining) },
  })
}
