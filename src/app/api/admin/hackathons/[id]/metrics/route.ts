import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { squadMetrics } from '@/lib/squads/organizer'

// GET /api/admin/hackathons/{id}/metrics: how the squads of a hackathon are going: the share of registrants who ended in a team, the median time it
// took them, and how many squads the builder and the pool made.
export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  if (!(await prisma.hackathon.findUnique({ where: { id }, select: { id: true } }))) return createApiError('HACKATHON_NOT_FOUND')
  return createApiResponse(await squadMetrics(prisma, id))
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:hackathon-metrics' } })
