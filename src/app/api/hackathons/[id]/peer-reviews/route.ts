import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { blockGuard } from '@/lib/blocks'
import { peerReviewSchema, reviewTodo, writePeerReview } from '@/lib/squads/peer-review'

// Private peer reviews of a hackathon squad (docs/SQUADS.md, "Reliability and peer review"). GET: the caller's teammates, which of them they have
// reviewed and what they said, and the window; never what anyone said about the caller. POST: one review of one teammate, once, inside the week
// after the results or the end.

const idOf = (request: NextRequest) => new URL(request.url).pathname.split('/').slice(-2)[0]

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = idOf(request)
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  const hackathon = await prisma.hackathon.findUnique({ where: { id }, select: { id: true, endDate: true, resultsAt: true } })
  if (!hackathon) return createApiError('HACKATHON_NOT_FOUND')
  const todo = await reviewTodo(prisma, hackathon, user.id)
  if (!todo) return createApiError('NOT_TEAMMATES')
  return createApiResponse(todo)
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'hackathons:peer-reviews' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = idOf(request)
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  const body = await validateBody(peerReviewSchema)(request)
  if (body instanceof Response) return body
  const hackathon = await prisma.hackathon.findUnique({ where: { id }, select: { id: true, endDate: true, resultsAt: true } })
  if (!hackathon) return createApiError('HACKATHON_NOT_FOUND')

  // A user-to-user surface: refused while either has blocked the other.
  const blocked = await blockGuard(prisma, user.id, body.data.revieweeId, 'NOT_TEAMMATES')
  if (blocked) return blocked

  const result = await writePeerReview(prisma, { hackathon, reviewerId: user.id, body: body.data })
  if (!result.ok) {
    if (result.reason === 'WINDOW_CLOSED') return createApiError('PEER_REVIEW_WINDOW_CLOSED')
    if (result.reason === 'ALREADY_REVIEWED') return createApiError('PEER_REVIEW_EXISTS')
    return createApiError('NOT_TEAMMATES')
  }
  // `counted` is not returned: whether the trust gate counted a review is not something to tell its author.
  return createApiResponse({ id: result.reviewId, revieweeId: body.data.revieweeId, showedUp: body.data.showedUp, wouldBuildAgain: body.data.wouldBuildAgain }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'hackathons:peer-review' } })
