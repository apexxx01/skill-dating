import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { INVITE_WINDOW_DAYS, redeemInvite } from '@/lib/invites/invites'

// POST /api/invites/redeem { code }: joins with an invite code, once, in the first 14 days of the account. (A sign-up that carries the code in the Clerk user's unsafeMetadata.inviteCode
// is attributed automatically; this is for the pages that cannot.) The answer does not say whether the invite will count: that is decided when the invitee has got started.
const bodySchema = z.object({ code: z.string().trim().min(4).max(40) }).strict()

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const outcome = await redeemInvite(prisma, user.id, body.data.code)
  if (!outcome.ok) return createApiError(outcome.code, outcome.code === 'INVITE_WINDOW_CLOSED' ? { params: { days: INVITE_WINDOW_DAYS } } : undefined)
  return createApiResponse({ redeemed: true, campusId: outcome.campusId })
}, { rateLimit: { windowMs: 3_600_000, maxRequests: 10, keyPrefix: 'invites:redeem' } })
