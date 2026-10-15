import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { FLAG_KEY_PATTERN, invalidateFlags } from '@/lib/flags'
import { flagResponse, updateFlagSchema } from '@/lib/flags-admin'

const keyFrom = (request: NextRequest): string | null => {
  const key = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '')
  return FLAG_KEY_PATTERN.test(key) ? key : null
}

// Admin only. The key is the flag's identity in the URL.
export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const key = keyFrom(request)
  const flag = key ? await prisma.featureFlag.findUnique({ where: { key } }) : null
  if (!flag) return createApiError('FLAG_NOT_FOUND')
  return createApiResponse(flagResponse(flag))
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:flags-get' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const key = keyFrom(request)
  if (!key) return createApiError('FLAG_NOT_FOUND')

  const body = await validateBody(updateFlagSchema)(request)
  if (body instanceof Response) return body

  const before = await prisma.featureFlag.findUnique({ where: { key } })
  if (!before) return createApiError('FLAG_NOT_FOUND')

  const flag = await prisma.featureFlag.update({ where: { key }, data: { ...body.data, updatedById: user.id } })

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: 'FEATURE_FLAG_UPDATED',
      targetType: 'FEATURE_FLAG',
      targetId: key,
      oldValue: flagResponse(before) as unknown as Prisma.InputJsonValue,
      newValue: flagResponse(flag) as unknown as Prisma.InputJsonValue,
    },
  })
  // Drop the cached set so the change shows on the next request, on every instance.
  await invalidateFlags()

  return createApiResponse(flagResponse(flag))
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:flags-update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const key = keyFrom(request)
  if (!key) return createApiError('FLAG_NOT_FOUND')

  const before = await prisma.featureFlag.findUnique({ where: { key } })
  if (!before) return createApiError('FLAG_NOT_FOUND')

  await prisma.featureFlag.delete({ where: { key } })
  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'FEATURE_FLAG_DELETED', targetType: 'FEATURE_FLAG', targetId: key, oldValue: flagResponse(before) as unknown as Prisma.InputJsonValue },
  })
  await invalidateFlags()

  return createApiResponse({ success: true })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:flags-delete' } })
