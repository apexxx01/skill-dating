import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { requireRecentAuth } from '@/lib/api/recent-auth'
import { setAdminMarks } from '@/lib/admin-verification'
import { bodySchema } from './schema'

export const PATCH = withAuth(async (request: NextRequest, { prisma, user, session }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const reauth = await requireRecentAuth(session)
  if (reauth) return reauth
  const { reason, ...marks } = body.data
  const updated = await setAdminMarks(prisma, { userId: id, adminId: user.id, marks, reason })
  if (!updated) return createApiError('USER_NOT_FOUND')
  return createApiResponse({ userId: id, ...updated })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'admin:verification' } })
