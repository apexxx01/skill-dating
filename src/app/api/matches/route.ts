import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { cursorParam } from '@/lib/api/pagination'
import { listMatches } from '@/lib/matching/matches'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: cursorParam,
})

// The caller's open matches, newest first. A match ended by either person, or with someone blocked either way, is not listed.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const result = await listMatches(prisma, user.id, { cursor: query.data.cursor, limit: query.data.limit ?? 20 })
  if (result === 'INVALID_CURSOR') return createApiError('INVALID_CURSOR')
  return createApiResponse(result)
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'matches:list' } })
