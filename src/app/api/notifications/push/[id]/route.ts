import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'

// Removes one of the caller's own devices from their list in settings (the other one, DELETE /api/notifications/push, is the browser unsubscribing itself).
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop() ?? ''
  const removed = await prisma.pushSubscription.deleteMany({ where: { id, userId: user.id } })
  if (removed.count === 0) return createApiError('PUSH_DEVICE_NOT_FOUND')
  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'notifications:push-remove' } })
