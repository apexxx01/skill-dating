import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { reviewFraudSignal } from '@/lib/integrity/collusion-job'

// PATCH /api/admin/fraud-signals/{id} { status: CONFIRMED|DISMISSED, note? }: a person's decision on a flagged group. DISMISSED restores every weight the
// signal lowered and keeps the group from being flagged again; CONFIRMED keeps the down-weighting. Audited. Staff only. Nobody is banned by either.
const bodySchema = z.object({ status: z.enum(['CONFIRMED', 'DISMISSED']), note: z.string().trim().max(1000).optional() }).strict()

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop()
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'signalId' } })
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const signal = await reviewFraudSignal(prisma, { id, status: body.data.status, reviewerId: user.id, note: body.data.note })
  if (!signal) return createApiError('FRAUD_SIGNAL_NOT_FOUND')
  return createApiResponse({ id: signal.id, status: signal.status, reviewedAt: signal.reviewedAt })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:fraud-signal-review' } })
