import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { agreeToReveal, withdrawReveal } from '@/lib/romance/reveal'

// The photo reveal of a romance match (docs/ROMANCE.md). Photos are blurred for the other person until BOTH have agreed, and either can take it back at any time.
//
//   POST    agree: asks the other person, or accepts when they have already asked. `{ status }` from the caller's side: PENDING_MINE, or ACCEPTED.
//   DELETE  withdraw: cancels your ask, declines theirs, or revokes an accepted reveal, at once, for both. `{ status }`.
// Both are safe to repeat. Anyone who is not in the match, and a match that has ended, gets `404 MATCH_NOT_FOUND`.
const idOf = (request: NextRequest) => new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const result = await agreeToReveal(prisma, user.id, idOf(request))
  if (result.kind === 'NOT_FOUND') return createApiError('MATCH_NOT_FOUND')
  return createApiResponse({ matchId: idOf(request), status: result.status })
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'romance:reveal-agree' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const result = await withdrawReveal(prisma, user.id, idOf(request))
  if (result.kind === 'NOT_FOUND') return createApiError('MATCH_NOT_FOUND')
  return createApiResponse({ matchId: idOf(request), status: result.status })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'romance:reveal-withdraw' } })
