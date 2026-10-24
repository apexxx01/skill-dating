import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { reverseModerationAction } from '@/lib/moderation/actions'
import { bodySchema } from './schema'

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const result = await reverseModerationAction(prisma, { actionId: id, actorId: user.id, reason: body.data.reason })
  if (result === 'NOT_FOUND') return createApiError('MODERATION_ACTION_NOT_FOUND')
  if (result === 'ALREADY') return createApiError('VALIDATION_FAILED', { details: { action: ['Already reversed'] } })
  return createApiResponse({ action: result })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:action-reverse' } })
