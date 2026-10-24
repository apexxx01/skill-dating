import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { myProposals } from '@/lib/squads/pool'
import { querySchema } from './schema'

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  if (query.data.cursor && !(await prisma.squadProposalMember.findFirst({ where: { id: query.data.cursor, userId: user.id }, select: { id: true } }))) {
    return createApiError('INVALID_CURSOR')
  }
  return createApiResponse(await myProposals(prisma, user.id, { cursor: query.data.cursor, limit: query.data.limit }))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'squad-proposals:list' } })
