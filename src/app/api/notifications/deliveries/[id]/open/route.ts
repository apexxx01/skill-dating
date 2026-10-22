import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'

// The service worker reports a tap on a push (the payload carries `deliveryId`), which is how the push open rate is measured (docs/METRICS.md). Only the person the
// delivery was for can report it; the first report counts and the rest change nothing.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''
  const delivery = await prisma.notificationDelivery.findFirst({ where: { id, userId: user.id, status: 'SENT' }, select: { id: true } })
  if (!delivery) return createApiError('DELIVERY_NOT_FOUND')
  await prisma.notificationDelivery.updateMany({ where: { id, openedAt: null }, data: { openedAt: new Date() } })
  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'notifications:delivery-open' } })
