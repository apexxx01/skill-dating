import { NextRequest, NextResponse } from 'next/server'
import { authenticate } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { clientIp, consumeSafely, enforceRateLimit, tooManyRequests, type RateLimitConfig } from '@/lib/rate-limiter'
import { errorResponse, type ErrorCode, type ErrorOptions } from '@/lib/api/errors'
import { withIdempotency } from '@/lib/api/idempotency'
import { getCache } from '@/lib/infra/cache'
import { log, requestIdFrom, runWithRequestId } from '@/lib/log'
import { MIN_PLATFORM_AGE } from '@/lib/age-policy'
import { MAX_BODY_BYTES } from '@/lib/api/limits'
import { gateRequest } from '@/lib/api/gate'
import type { SessionInfo } from '@/lib/api/recent-auth'
import { recordThrottleHit } from '@/lib/integrity/risk-job'

/**
 * What a person refused for being under the platform's minimum age (User.birthDateRefusedAt) can still do: see who they are, ask for a correction of
 * their date of birth through the report flow, and the rest of the plumbing a client needs to show that. Everything else answers AGE_BELOW_MINIMUM.
 */
export function ageRefusalAllows(method: string, pathname: string): boolean {
  if (method === 'GET') return pathname === '/api/users/me' || pathname === '/api/users/me/profile' || pathname === '/api/auth/session' || pathname === '/api/health'
  return method === 'POST' && pathname === '/api/reports'
}

export interface AuthenticatedUser {
  id: string
  email: string
  name: string | null
  username: string | null
  image: string | null
  role: string
}

export interface ApiContext {
  user: AuthenticatedUser
  prisma: typeof prisma
  /** The session the request came with, for routes that need a recent sign-in (src/lib/api/recent-auth.ts). */
  session: SessionInfo
}

export type ApiHandler<T = unknown> = (
  request: NextRequest,
  context: ApiContext
) => Promise<NextResponse<T>>

export type { RateLimitConfig }

// Keyed on the authenticated user id when there is one - that cannot be
// forged or shared, unlike an IP. Only pre-auth callers (register) fall back
// to a trusted-proxy IP, or to one shared flood-guard bucket.
export function rateLimit(config: RateLimitConfig) {
  return (request: NextRequest, userId?: string): Promise<NextResponse | null> =>
    enforceRateLimit(request, config, userId)
}

// What withAuth returns is the route handler Next calls: it takes only the request
// (Next 15 rejects a route export whose second argument is not its own route
// context), and builds the ApiContext that `handler` receives itself.
export type RouteHandler = (request: NextRequest) => Promise<NextResponse>

export interface WithAuthOptions {
  requiredRole?: string[]
  rateLimit?: RateLimitConfig
  /**
   * For POST routes that create something: honour an `Idempotency-Key` header, so
   * a repeated request returns the first response instead of creating twice
   * (src/lib/api/idempotency.ts). Ignored for other methods and when no key is sent.
   */
  idempotent?: boolean
}

export function withAuth(handler: ApiHandler, options: WithAuthOptions = {}): RouteHandler {
  return async (request: NextRequest) => {
    // One id per request: on every log line written while it runs, and on the
    // response, so a report from a user can be matched to the logs.
    const requestId = requestIdFrom(request.headers)
    return runWithRequestId(requestId, async () => {
      const started = Date.now()
      let userId: string | undefined
      let response: NextResponse
      try {
        response = await handleAuthenticated(request, handler, options, (id) => (userId = id))
      } catch (error) {
        log.error('unhandled error in route', { error, method: request.method, path: new URL(request.url).pathname, userId })
        response = errorResponse('INTERNAL_ERROR')
      }
      response.headers.set('X-Request-Id', requestId)
      log.info('request', {
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        durationMs: Date.now() - started,
        userId,
      })
      return response
    })
  }
}

async function handleAuthenticated(
  request: NextRequest,
  handler: ApiHandler,
  options: WithAuthOptions,
  onUser: (userId: string) => void
): Promise<NextResponse> {
  // The session token is verified here, per request; see session.ts.
  const outcome = await authenticate(request.headers, { ip: clientIp(request) })

  switch (outcome.kind) {
    case 'anonymous': {
      // Bound unauthenticated traffic too, so a flood of anonymous calls
      // cannot be used to hammer the auth layer for free.
      const anonymous = await consumeSafely(`anon:ip:${clientIp(request) ?? 'untrusted'}`, {
        windowMs: 60_000,
        maxRequests: 120,
      })
      if (!anonymous.allowed) return tooManyRequests(anonymous)
      return errorResponse('UNAUTHORIZED')
    }
    case 'deleted':
      return errorResponse('UNAUTHORIZED')
    case 'conflict':
      return errorResponse('ACCOUNT_CONFLICT')
    case 'limited':
      return tooManyRequests(outcome.decision)
    case 'unavailable':
      return errorResponse('AUTH_UNAVAILABLE')
    case 'refused':
      return errorResponse(outcome.code)
  }

  const { user } = outcome
  onUser(user.id)

  if (user.birthDateRefusedAt && !ageRefusalAllows(request.method, new URL(request.url).pathname)) {
    return errorResponse('AGE_BELOW_MINIMUM', { params: { minAge: MIN_PLATFORM_AGE } })
  }

  // Keyed on the LOCAL user id: it cannot be forged or shared, unlike an IP.
  if (options.rateLimit) {
    const rateLimitResponse = await rateLimit(options.rateLimit)(request, user.id)
    if (rateLimitResponse) {
      // Running into limits is one of the signals of the risk score (src/lib/integrity/risk.ts).
      if (rateLimitResponse.status === 429) await recordThrottleHit(prisma, user.id, options.rateLimit.keyPrefix)
      return rateLimitResponse
    }
  }

  if (options.requiredRole && !options.requiredRole.includes(user.role)) {
    return errorResponse('FORBIDDEN')
  }

  // Suspensions, bans, kill switches, feature restrictions, re-consent and the tighter limits of a HIGH risk account (gate.ts).
  const gated = await gateRequest(prisma, user, request.method, new URL(request.url).pathname)
  if (gated) return gated

  const context: ApiContext = {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      image: user.image,
      role: user.role
    },
    prisma,
    session: { id: outcome.identity?.sessionId ?? null, factorAgeMinutes: outcome.identity?.factorAgeMinutes ?? null },
  }

  if (options.idempotent && request.method === 'POST') {
    return withIdempotency(request, user.id, getCache(), () => handler(request, context))
  }
  return handler(request, context)
}

/**
 * The request body as text, refused with 413 PAYLOAD_TOO_LARGE above `maxBytes` (MAX_BODY_BYTES by default): by the declared length before anything
 * is read, and by what actually arrived. Every route reads its body through here, directly or through validateBody.
 */
export async function readBodyText(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<string | NextResponse> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) return errorResponse('PAYLOAD_TOO_LARGE')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return errorResponse('PAYLOAD_TOO_LARGE')
  return text
}

// `I` is what the client sends and `T` what the route gets: they differ for a schema with defaults or transforms.
export function validateBody<T, I = T>(schema: z.ZodType<T, z.ZodTypeDef, I>) {
  return async (request: NextRequest): Promise<{ data: T } | NextResponse> => {
    const raw = await readBodyText(request)
    if (raw instanceof NextResponse) return raw
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return errorResponse('INVALID_JSON')
    }
    const result = schema.safeParse(body)
    if (!result.success) {
      return errorResponse('VALIDATION_FAILED', { details: result.error.flatten().fieldErrors })
    }
    return { data: result.data }
  }
}

export function validateQuery<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
  return (request: NextRequest): { data: T } | NextResponse => {
    const url = new URL(request.url)
    const params = Object.fromEntries(url.searchParams.entries())
    const result = schema.safeParse(params)
    
    if (!result.success) {
      return errorResponse('VALIDATION_FAILED', { details: result.error.flatten().fieldErrors })
    }

    return { data: result.data }
  }
}

export function createApiResponse<T>(data: T, status = 200) {
  return NextResponse.json(data, { status })
}

/** An error response for a code from src/lib/api/errors.ts; the status comes from the catalog. */
export function createApiError(code: ErrorCode, options?: ErrorOptions) {
  return errorResponse(code, options)
}

// Permission checks live in permissions.ts (no Next import there,
// so they're mockable under Vitest without pulling in the Next runtime).
// Re-exported here so existing `from '@/lib/api/handler'` imports keep working.
export { checkOwnership, checkMembership, authorize } from './permissions'