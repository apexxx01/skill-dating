import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { canManageTeam } from '@/lib/squads/access'
import { chooseIdea } from '@/lib/squads/space'

// POST /api/teams/{id}/ideas/{ideaId}/choose: whoever runs the team marks the idea the squad goes with (one at a time). It names the project when
// the squad keeps building.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const parts = new URL(request.url).pathname.split('/')
  const teamId = parts.slice(-4)[0]
  const ideaId = parts.slice(-2)[0]
  if (!teamId || !ideaId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId, ideaId' } })
  if (!(await canManageTeam(prisma, user, teamId))) return createApiError('FORBIDDEN')
  if (!(await chooseIdea(prisma, { teamId, ideaId }))) return createApiError('IDEA_NOT_FOUND')
  return createApiResponse({ ideaId, chosen: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:idea-choose' } })
