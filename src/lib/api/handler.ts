import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'

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

export interface RateLimitConfig {
  windowMs: number
  maxRequests: number
  keyPrefix: string
}

const rateLimitStore = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(config: RateLimitConfig) {
  return async (request: NextRequest): Promise<NextResponse | null> => {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
               request.headers.get('x-real-ip') ||
               'unknown'
    const key = `${config.keyPrefix}:${ip}`
    const now = Date.now()
    
    const record = rateLimitStore.get(key)
    if (!record || now > record.resetAt) {
      rateLimitStore.set(key, { count: 1, resetAt: now + config.windowMs })
      return null
    }
    
    if (record.count >= config.maxRequests) {
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: Math.ceil((record.resetAt - now) / 1000) },
        { status: 429, headers: { 'Retry-After': Math.ceil((record.resetAt - now) / 1000).toString() } }
      )
    }
    
    record.count++
    return null
  }
}

export function withAuth(
  handler: ApiHandler,
  options: { requiredRole?: string[]; rateLimit?: RateLimitConfig } = {}
): ApiHandler {
  return async (request: NextRequest) => {
    if (options.rateLimit) {
      const rateLimitResponse = await rateLimit(options.rateLimit)(request)
      if (rateLimitResponse) return rateLimitResponse
    }

    const session = await auth()
    
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, email: true, name: true, username: true, image: true, role: true }
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 401 })
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