import { contentRejection, recordFlag, screenText } from '@/lib/safety/screen'
import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { decodeOffsetCursor, encodeOffsetCursor } from '@/lib/api/pagination'
import { createLfgPost, lfgCreateSchema, lfgPostView, lfgQuerySchema, listLfg } from '@/lib/squads/lfg'

// The looking-for-group board of a hackathon (docs/SQUADS.md). GET: the active posts, filtered by role, stack tag, time zone and kind, ranked by
// how well each author fits the viewer (the pairwise score) and then by recency, with blocked people left out both ways. POST: the caller's post,
// one active one per person per hackathon.

const hackathonIdOf = (request: NextRequest) => new URL(request.url).pathname.split('/').slice(-2)[0]

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = hackathonIdOf(request)
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  const query = validateQuery(lfgQuerySchema)(request)
  if (query instanceof Response) return query
  const offset = query.data.cursor ? decodeOffsetCursor(query.data.cursor) : 0
  if (offset === null) return createApiError('INVALID_CURSOR')

  const hackathon = await prisma.hackathon.findUnique({ where: { id }, select: { id: true } })
  if (!hackathon) return createApiError('HACKATHON_NOT_FOUND')

  const { posts, total } = await listLfg(prisma, { hackathonId: id, viewerId: user.id, role: query.data.role, stack: query.data.stack, tz: query.data.tz, kind: query.data.kind, offset, limit: query.data.limit })
  const next = offset + query.data.limit
  return createApiResponse({ posts, nextCursor: next < total ? encodeOffsetCursor(next) : null })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'hackathons:lfg-list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = hackathonIdOf(request)
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  const body = await validateBody(lfgCreateSchema)(request)
  if (body instanceof Response) return body
  const verdict = await screenText(user.id, body.data.note ?? '', 'LFG')
  if (verdict.verdict === 'REJECT') return contentRejection(verdict)

  const hackathon = await prisma.hackathon.findUnique({ where: { id }, select: { id: true, status: true, endDate: true, submissionDeadline: true } })
  if (!hackathon) return createApiError('HACKATHON_NOT_FOUND')
  if (hackathon.status !== 'UPCOMING' && hackathon.status !== 'ACTIVE') return createApiError('HACKATHON_TEAM_REGISTRATION_CLOSED')

  const result = await createLfgPost(prisma, { hackathon, authorId: user.id, body: body.data })
  if (!result.ok) {
    switch (result.reason) {
      case 'ACTIVE_POST_EXISTS':
        return createApiError('LFG_ACTIVE_POST_EXISTS', { details: { postId: result.existingId } })
      case 'TEAM_NOT_MANAGED':
        return createApiError('FORBIDDEN')
      case 'NOT_REGISTERED':
        return createApiError('HACKATHON_REGISTRATION_REQUIRED')
      case 'IN_A_SQUAD':
        return createApiError('ALREADY_IN_HACKATHON_TEAM')
      case 'LOCKED':
        return createApiError('TEAM_LOCKED')
      default:
        return createApiError('VALIDATION_FAILED', { details: { expiresAt: ['Must be in the future and no later than when the teams lock'] } })
    }
  }
  await recordFlag(prisma, verdict, user.id, { type: 'LFG_POST', id: result.postId })
  return createApiResponse(await lfgPostView(prisma, result.postId, user.id), 201)
}, { idempotent: true, rateLimit: { windowMs: 60 * 60 * 1000, maxRequests: 20, keyPrefix: 'hackathons:lfg-create' } })
