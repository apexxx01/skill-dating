import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { reviewFraudSignal } from '@/lib/integrity/collusion-job'
import { bodySchema } from './schema'

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop()
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'signalId' } })
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const signal = await reviewFraudSignal(prisma, { id, status: body.data.status, reviewerId: user.id, note: body.data.note })
  if (!signal) return createApiError('FRAUD_SIGNAL_NOT_FOUND')
  return createApiResponse({ id: signal.id, status: signal.status, reviewedAt: signal.reviewedAt })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:fraud-signal-review' } })
