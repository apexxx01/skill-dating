import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { listRomanceMatches } from '@/lib/romance/matches'
import { querySchema } from './schema'

// The caller's open romance matches, newest first. To leave one: DELETE /api/matches/{id}; to report and leave: POST /api/matches/{id}/report (both work on any match the caller is in).
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const result = await listRomanceMatches(prisma, user.id, { cursor: query.data.cursor, limit: query.data.limit ?? 20 })
  if (result === 'INVALID_CURSOR') return createApiError('INVALID_CURSOR')
  return createApiResponse(result)
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'romance:matches-list' } })
