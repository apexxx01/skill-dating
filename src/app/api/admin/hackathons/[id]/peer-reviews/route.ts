import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { cursorParam, decodeKeysetCursor, encodeKeysetCursor, keysetOrderBy, keysetWhere } from '@/lib/api/pagination'

// GET /api/admin/hackathons/{id}/peer-reviews: every peer review of a hackathon with its private note, for admins (moderation), newest first.
const querySchema = z.object({ cursor: cursorParam, limit: z.coerce.number().int().min(1).max(100).default(50) })

export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const position = query.data.cursor ? decodeKeysetCursor(query.data.cursor) : null
  if (query.data.cursor && !position) return createApiError('INVALID_CURSOR')

  const rows = await prisma.peerReview.findMany({
    where: { hackathonId: id, ...(position ? keysetWhere('createdAt', 'desc', position) : {}) },
    orderBy: keysetOrderBy('createdAt', 'desc'),
    take: query.data.limit + 1,
    select: { id: true, teamId: true, reviewerId: true, revieweeId: true, showedUp: true, wouldBuildAgain: true, note: true, counted: true, createdAt: true },
  })
  const page = rows.slice(0, query.data.limit)
  const last = page[page.length - 1]
  return createApiResponse({ reviews: page, nextCursor: rows.length > query.data.limit && last ? encodeKeysetCursor(last.createdAt, last.id) : null })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:peer-reviews' } })
