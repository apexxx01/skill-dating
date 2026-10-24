import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { loadReceivedSparks } from '@/lib/matching/matches'
import { querySchema } from './schema'

// The sparks the caller has been sent and not answered. With the SEE_WHO_SPARKED entitlement: the list, newest first. Without it: only the number.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const result = await loadReceivedSparks(prisma, user.id, { cursor: query.data.cursor, limit: query.data.limit ?? 20 })
  if (result === 'INVALID_CURSOR') return createApiError('INVALID_CURSOR')
  return createApiResponse(result)
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'sparks:received' } })
