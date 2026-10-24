import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { parseTypes } from '@/lib/search/query'
import { runSearch } from '@/lib/search'
import { querySchema } from './schema'

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const types = parseTypes(query.data.types)
  if (!types) return createApiError('VALIDATION_FAILED', { details: { types: ['Use any of users, projects, crews, hackathons, posts, separated by commas'] } })

  const outcome = await runSearch(prisma, user.id, { q: query.data.q, types, limit: query.data.limit, cursor: query.data.cursor })
  if (outcome.kind === 'invalid-cursor') return createApiError('INVALID_CURSOR')
  return createApiResponse(outcome.data)
}, { cache: { maxAge: 5 }, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'search:universal' } })
