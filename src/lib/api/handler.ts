import { NextRequest, NextResponse } from 'next/server'
import { authenticate } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { clientIp, consumeSafely, enforceRateLimit, tooManyRequests, type RateLimitConfig } from '@/lib/rate-limiter'
import { errorResponse, type ErrorCode, type ErrorOptions } from '@/lib/api/errors'

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

export function withAuth(
  handler: ApiHandler,
  options: { requiredRole?: string[]; rateLimit?: RateLimitConfig } = {}
): RouteHandler {
  return async (request: NextRequest) => {
    // The session token is verified here, per request; see session.ts.
    const outcome = await authenticate(request.headers)

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
    }

    const { user } = outcome

    // Keyed on the LOCAL user id: it cannot be forged or shared, unlike an IP.
    if (options.rateLimit) {
      const rateLimitResponse = await rateLimit(options.rateLimit)(request, user.id)
      if (rateLimitResponse) return rateLimitResponse
    }

    if (options.requiredRole && !options.requiredRole.includes(user.role)) {
      return errorResponse('FORBIDDEN')
    }

    const context: ApiContext = {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        image: user.image,
        role: user.role
      },
      prisma
    }

    return handler(request, context)
  }
}

export function validateBody<T>(schema: z.ZodSchema<T>) {
  return async (request: NextRequest): Promise<{ data: T } | NextResponse> => {
    try {
      const body = await request.json()
      const result = schema.safeParse(body)
      
      if (!result.success) {
        return errorResponse('VALIDATION_FAILED', { details: result.error.flatten().fieldErrors })
      }

      return { data: result.data }
    } catch {
      return errorResponse('INVALID_JSON')
    }
  }
}

export function validateQuery<T>(schema: z.ZodSchema<T>) {
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