import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { reportMatch } from '@/lib/matching/matches'
import { bodySchema } from './schema'

// Unmatch and report in one call: the match ends exactly as for DELETE /api/matches/{id}, and a report against the other person goes into the
// same queue as POST /api/reports. A pending report from the caller against them is kept rather than duplicated.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const result = await reportMatch(prisma, user.id, id, body.data)
  if (result.kind === 'NOT_FOUND') return createApiError('MATCH_NOT_FOUND')
  return createApiResponse({ matchId: id, endedAt: result.match.endedAt?.toISOString() ?? null, report: { id: result.reportId }, alreadyReported: result.alreadyReported }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'matches:report' } })
