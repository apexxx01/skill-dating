import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { getPush, isPushEndpoint } from '@/lib/infra/push'
import { MAX_PUSH_DEVICES } from '@/lib/notify/policy'
import { subscribeSchema, unsubscribeSchema } from './schema'

const view = (device: { id: string; label: string | null; createdAt: Date; lastUsedAt: Date | null }) => ({ id: device.id, label: device.label, createdAt: device.createdAt, lastUsedAt: device.lastUsedAt })

export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const devices = await prisma.pushSubscription.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, select: { id: true, label: true, createdAt: true, lastUsedAt: true } })
  const sender = getPush()
  return createApiResponse({ publicKey: sender.publicKey, configured: sender.kind === 'webpush', devices: devices.map(view), maxDevices: MAX_PUSH_DEVICES })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'notifications:push-list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(subscribeSchema)(request)
  if (body instanceof Response) return body
  const { endpoint, keys, label } = body.data
  if (!isPushEndpoint(endpoint, getPush().kind === 'webpush')) return createApiError('PUSH_ENDPOINT_NOT_ALLOWED')

  const existing = await prisma.pushSubscription.findUnique({ where: { endpoint }, select: { id: true, userId: true } })
  // Counted before the write; an endpoint already on this account is a refresh and never over the limit.
  if (existing?.userId !== user.id && (await prisma.pushSubscription.count({ where: { userId: user.id } })) >= MAX_PUSH_DEVICES) {
    return createApiError('PUSH_DEVICE_LIMIT', { params: { max: MAX_PUSH_DEVICES } })
  }
  // The same browser signed in as somebody else moves to this account: an endpoint is one browser, and pushes for the previous person must stop reaching it.
  const device = await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, label: label?.trim() || null },
    update: { userId: user.id, p256dh: keys.p256dh, auth: keys.auth, failures: 0, ...(label?.trim() ? { label: label.trim() } : {}) },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true },
  })
  return createApiResponse({ device: view(device) }, existing ? 200 : 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'notifications:push-subscribe' } })

/** The browser unsubscribing itself: it knows its endpoint, not our id. */
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(unsubscribeSchema)(request)
  if (body instanceof Response) return body
  const removed = await prisma.pushSubscription.deleteMany({ where: { userId: user.id, endpoint: body.data.endpoint } })
  if (removed.count === 0) return createApiError('PUSH_DEVICE_NOT_FOUND')
  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'notifications:push-unsubscribe' } })
