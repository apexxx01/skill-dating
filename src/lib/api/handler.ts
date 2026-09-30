import { NextRequest, NextResponse } from 'next/server'
import { authenticate } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { clientIp, consumeSafely, enforceRateLimit, tooManyRequests, type RateLimitConfig } from '@/lib/rate-limiter'

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

export function withAuth(
  handler: ApiHandler,
  options: { requiredRole?: string[]; rateLimit?: RateLimitConfig } = {}
): ApiHandler {
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
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      case 'deleted':
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      case 'conflict':
        return NextResponse.json({ error: 'This email belongs to a different account' }, { status: 409 })
      case 'limited':
        return tooManyRequests(outcome.decision)
      case 'unavailable':
        return NextResponse.json({ error: 'Authentication is temporarily unavailable' }, { status: 503 })
    }

    const { user } = outcome

    // Keyed on the LOCAL user id: it cannot be forged or shared, unlike an IP.
    if (options.rateLimit) {
      const rateLimitResponse = await rateLimit(options.rateLimit)(request, user.id)
      if (rateLimitResponse) return rateLimitResponse
    }

    if (options.requiredRole && !options.requiredRole.includes(user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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
        return NextResponse.json(
          { error: 'Validation failed', details: result.error.flatten().fieldErrors },
          { status: 400 }
        )
      }
      
      return { data: result.data }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
  }
}

export function validateQuery<T>(schema: z.ZodSchema<T>) {
  return (request: NextRequest): { data: T } | NextResponse => {
    const url = new URL(request.url)
    const params = Object.fromEntries(url.searchParams.entries())
    const result = schema.safeParse(params)
    
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: result.error.flatten().fieldErrors },
        { status: 400 }
      )
    }
    
    return { data: result.data }
  }
}

export function createApiResponse<T>(data: T, status = 200) {
  return NextResponse.json(data, { status })
}

export function createApiError(message: string, status = 500, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status })
}

// Permission checks live in permissions.ts (no next-auth/next import there,
// so they're mockable under Vitest without pulling in the Next runtime).
// Re-exported here so existing `from '@/lib/api/handler'` imports keep working.
export { checkOwnership, checkMembership, authorize } from './permissions'