import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { flagsFor } from '@/lib/flags'

// Every flag with its answer for the signed-in user, for the interface to read once
// and keep. Only keys and booleans are exposed: rollout percentages and allowlists
// are the admins' business.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse({ flags: await flagsFor(prisma, user.id) })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'flags:mine' } })
