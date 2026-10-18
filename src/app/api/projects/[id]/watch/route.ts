import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { unwatch, watch } from '@/lib/posts/social'

const projectIdOf = (request: NextRequest) => new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''

// Watches a project: its new posts reach you as a notification (batched per hour). Watching twice answers the same. A private project can only be watched by its members.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const result = await watch(prisma, user.id, projectIdOf(request))
  if (!result.ok) return createApiError(result.code)
  return createApiResponse({ watching: true }, result.changed ? 201 : 200)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'projects:watch' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  await unwatch(prisma, user.id, projectIdOf(request))
  return createApiResponse({ watching: false })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'projects:unwatch' } })
