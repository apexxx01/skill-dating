import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { appealSchema, fileAppeal } from '@/lib/moderation/appeals'

// POST /api/appeals { actionId, body }: the person an action is about asks for it to be looked at again (once, within 30 days; not a warning). Works for
// a suspended or banned account. GET: the caller's appeals, newest first.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(appealSchema)(request)
  if (body instanceof Response) return body
  const result = await fileAppeal(prisma, user.id, body.data)
  if (!result.ok) return createApiError(result.code)
  return createApiResponse({ appeal: result.appeal }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60 * 60 * 1000, maxRequests: 10, keyPrefix: 'appeals:create' } })

export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const appeals = await prisma.appeal.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, actionId: true, body: true, status: true, decisionNote: true, decidedAt: true, createdAt: true },
  })
  return createApiResponse({ appeals })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'appeals:list' } })
