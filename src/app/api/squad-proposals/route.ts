import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { cursorParam } from '@/lib/api/pagination'
import { myProposals } from '@/lib/squads/pool'

// GET /api/squad-proposals: the squads proposed to the caller (the solo pool's) and the ones they asked the builder for, newest first.
const querySchema = z.object({ cursor: cursorParam, limit: z.coerce.number().int().min(1).max(50).default(20) })

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  if (query.data.cursor && !(await prisma.squadProposalMember.findFirst({ where: { id: query.data.cursor, userId: user.id }, select: { id: true } }))) {
    return createApiError('INVALID_CURSOR')
  }
  return createApiResponse(await myProposals(prisma, user.id, { cursor: query.data.cursor, limit: query.data.limit }))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'squad-proposals:list' } })
