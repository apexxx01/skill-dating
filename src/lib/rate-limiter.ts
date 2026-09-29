import { NextResponse } from 'next/server'

// Rate limiting behind a small interface so the in-memory implementation can
// be swapped for a shared store (Redis, etc.) without touching any route:
// implement RateLimiter and call setRateLimiter() once at startup.

export interface RateLimitOptions {
  windowMs: number
  maxRequests: number
}

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

export interface RateLimiter {
  consume(key: string, options: RateLimitOptions): Promise<RateLimitDecision>
}

interface Bucket {
  count: number
  resetAt: number
}

const SWEEP_INTERVAL_MS = 30_000
const DEFAULT_MAX_KEYS = 50_000

// Fixed-window counter held in process memory. Two properties matter for
// safety: expired buckets are swept periodically, and the total key count is
// hard-capped (oldest evicted first), so a client that fabricates many
// distinct keys cannot grow memory without bound. State is per-process: with
// several instances the effective limit multiplies, which is exactly the case
// a shared-store implementation of RateLimiter exists for.
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private lastSweep = 0

  constructor(private readonly maxKeys: number = DEFAULT_MAX_KEYS) {}

  get size(): number {
    return this.buckets.size
  }

  async consume(key: string, { windowMs, maxRequests }: RateLimitOptions): Promise<RateLimitDecision> {
    const now = Date.now()
    this.sweep(now)

    const bucket = this.buckets.get(key)
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.delete(key)
      this.buckets.set(key, { count: 1, resetAt: now + windowMs })
      this.enforceCap()
      return { allowed: true, remaining: Math.max(0, maxRequests - 1), retryAfterSeconds: 0 }
    }

    if (bucket.count >= maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      }
    }

    bucket.count += 1
    return { allowed: true, remaining: Math.max(0, maxRequests - bucket.count), retryAfterSeconds: 0 }
  }

  private sweep(now: number) {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return
    this.lastSweep = now
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key)
    }
  }

  private enforceCap() {
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value
      if (oldest === undefined) break
      this.buckets.delete(oldest)
    }
  }
}

// Survives dev-server module reloads so limits are not silently reset by HMR.
const globalForLimiter = globalThis as unknown as { __rateLimiter?: RateLimiter }

export function getRateLimiter(): RateLimiter {
  if (!globalForLimiter.__rateLimiter) globalForLimiter.__rateLimiter = new MemoryRateLimiter()
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
  const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '0', 10)
  if (!Number.isFinite(hops) || hops < 1) return null

  const forwarded = request.headers.get('x-forwarded-for')
  if (!forwarded) return null
  const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean)
  const index = parts.length - hops
  if (index < 0) return null
  return parts[index] || null
}

export function tooManyRequests(decision: RateLimitDecision): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests', retryAfter: decision.retryAfterSeconds },
    {
      status: 429,
      headers: {
        'Retry-After': String(decision.retryAfterSeconds),
        'X-RateLimit-Remaining': String(decision.remaining),
      },
    }
  )
}
