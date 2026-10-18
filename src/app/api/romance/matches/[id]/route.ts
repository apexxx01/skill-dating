import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { getRomanceMatch } from '@/lib/romance/matches'

// One of the caller's open romance matches. Anyone else's, one that has ended and one that is not a romance match are all "not found".
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop() ?? ''
  const match = await getRomanceMatch(prisma, user.id, id)
  if (!match) return createApiError('MATCH_NOT_FOUND')
  return createApiResponse(match)
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'romance:match-get' } })
