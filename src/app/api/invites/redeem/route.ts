import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { INVITE_WINDOW_DAYS, redeemInvite } from '@/lib/invites/invites'
import { bodySchema } from './schema'

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const outcome = await redeemInvite(prisma, user.id, body.data.code)
  if (!outcome.ok) return createApiError(outcome.code, outcome.code === 'INVITE_WINDOW_CLOSED' ? { params: { days: INVITE_WINDOW_DAYS } } : undefined)
  return createApiResponse({ redeemed: true, campusId: outcome.campusId })
}, { rateLimit: { windowMs: 3_600_000, maxRequests: 10, keyPrefix: 'invites:redeem' } })
