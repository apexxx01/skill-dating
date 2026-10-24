import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { parseTypes } from '@/lib/search/query'
import { runSearch, SEARCH_LIMITS } from '@/lib/search'

// GET /api/search?q=&types=users,projects,crews,hackathons,posts&limit=&cursor=: the command palette's search (docs/SEARCH.md). One ranked list over people,
// projects, crews, hackathons and posts, with typo and prefix matching, that never returns anything the caller may not see.

const querySchema = z.object({
  q: z.string().max(SEARCH_LIMITS.maxQueryLength * 2).default(''),
  types: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMITS.maxLimit).default(SEARCH_LIMITS.defaultLimit),
  cursor: z.string().min(1).max(300).optional(),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const types = parseTypes(query.data.types)
  if (!types) return createApiError('VALIDATION_FAILED', { details: { types: ['Use any of users, projects, crews, hackathons, posts, separated by commas'] } })

  const outcome = await runSearch(prisma, user.id, { q: query.data.q, types, limit: query.data.limit, cursor: query.data.cursor })
  if (outcome.kind === 'invalid-cursor') return createApiError('INVALID_CURSOR')
  return createApiResponse(outcome.data)
}, { cache: { maxAge: 5 }, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'search:universal' } })
