import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { loadTodayDrops } from '@/lib/matching/drop-view'

// Today's drops for the caller, in their own calendar day: the people picked for them, how well each fits and why. Reading marks the
// new ones as seen (and counts a drop_viewed for each, once). People who have since been blocked either way, or whose account is gone, are left out.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await loadTodayDrops(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'drops:today' } })
