import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { decideAppeal, decideAppealSchema } from '@/lib/moderation/appeals'

// POST /api/admin/appeals/{id}/decide { decision: UPHELD|OVERTURNED, note? }: a moderator other than the one who acted decides an appeal. OVERTURNED
// reverses the action. Audited; the person is told. Staff only.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  const body = await validateBody(decideAppealSchema)(request)
  if (body instanceof Response) return body
  const result = await decideAppeal(prisma, { appealId: id, deciderId: user.id, decision: body.data.decision, note: body.data.note })
  if (!result.ok) return createApiError(result.code)
  return createApiResponse({ appeal: result.appeal })
}, { requiredRole: ['ADMIN', 'MODERATOR'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:appeal-decide' } })
