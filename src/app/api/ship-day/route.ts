import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { loadShipDay } from '@/lib/posts/ship-day'

// Ship Day is Friday in the caller's own time zone. Answers whether it is today, when it ends, how many posts it has so far, the caller's own ships and the best posts of the day.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await loadShipDay(prisma, user.id))
}, { cache: { maxAge: 15 }, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'ship-day' } })
