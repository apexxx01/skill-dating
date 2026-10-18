import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { follow, unfollow } from '@/lib/posts/social'

const userIdOf = (request: NextRequest) => new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''

// Follows a person: their FOLLOWERS posts reach you and their public posts rank higher in your feed. Following twice answers the same. Not yourself; not with a block either way.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const result = await follow(prisma, user.id, userIdOf(request))
  if (!result.ok) return createApiError(result.code)
  return createApiResponse({ following: true }, result.changed ? 201 : 200)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'users:follow' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  await unfollow(prisma, user.id, userIdOf(request))
  return createApiResponse({ following: false })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'users:unfollow' } })
