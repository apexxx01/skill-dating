import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { requireRecentAuth } from '@/lib/api/recent-auth'
import { bodySchema } from './schema'

export const PUT = withAuth(async (request: NextRequest, { prisma, user, session }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const reauth = await requireRecentAuth(session)
  if (reauth) return reauth
  if (!(await prisma.user.findUnique({ where: { id }, select: { id: true } }))) return createApiError('USER_NOT_FOUND')
  const before = await prisma.subscription.findUnique({ where: { userId: id }, select: { plan: true, status: true, currentPeriodEnd: true, provider: true } })
  const data = { plan: body.data.plan, status: 'ACTIVE' as const, currentPeriodEnd: body.data.until ? new Date(body.data.until) : null, provider: 'admin', providerRef: user.id }
  const after = await prisma.subscription.upsert({ where: { userId: id }, create: { userId: id, ...data }, update: data, select: { plan: true, status: true, currentPeriodEnd: true, provider: true } })
  await prisma.auditEvent.create({ data: { userId: user.id, action: 'ENTITLEMENT_OVERRIDDEN', targetType: 'USER', targetId: id, oldValue: before ?? undefined, newValue: { ...after, reason: body.data.reason } } })
  return createApiResponse({ userId: id, ...after })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'admin:plan' } })
