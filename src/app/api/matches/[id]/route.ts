import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { unmatch } from '@/lib/matching/matches'

// Unmatches. Final: the conversation is closed for both people and the pair can never be matched or sparked again. Either person can do it;
// doing it twice answers the same. Anyone else gets 404.
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop() ?? ''
  const result = await unmatch(prisma, user.id, id)
  if (result.kind === 'NOT_FOUND') return createApiError('MATCH_NOT_FOUND')
  return createApiResponse({ id, endedAt: result.match.endedAt?.toISOString() ?? null })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'matches:unmatch' } })
