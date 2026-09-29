import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { getDashboardData } from '@/lib/dashboard'

// Everything the dashboard needs in one round trip, for the signed-in user
// only. Recommendations respect blocks.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await getDashboardData(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'dashboard:get' } })
