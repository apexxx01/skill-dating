import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'notificationId' } })
  }

  const notification = await prisma.notification.findUnique({ where: { id } })
  if (!notification || notification.userId !== user.id) {
    return createApiError('NOTIFICATION_NOT_FOUND')
  }

  const updated = await prisma.notification.update({
    where: { id },
    data: { isRead: true }
  })

  return createApiResponse(updated)
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'notifications:read' } })
