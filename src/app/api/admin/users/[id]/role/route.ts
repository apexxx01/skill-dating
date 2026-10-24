import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { requireRecentAuth } from '@/lib/api/recent-auth'
import { bodySchema } from './schema'

export const PATCH = withAuth(async (request: NextRequest, { prisma, user, session }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  if (id === user.id) return createApiError('FORBIDDEN')
  const reauth = await requireRecentAuth(session)
  if (reauth) return reauth
  const before = await prisma.user.findUnique({ where: { id }, select: { role: true } })
  if (!before) return createApiError('USER_NOT_FOUND')
  const after = await prisma.user.update({ where: { id }, data: { role: body.data.role }, select: { id: true, role: true } })
  await prisma.auditEvent.create({ data: { userId: user.id, action: 'ROLE_CHANGED', targetType: 'USER', targetId: id, oldValue: { role: before.role }, newValue: { role: after.role, reason: body.data.reason } } })
  return createApiResponse(after)
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'admin:role' } })
