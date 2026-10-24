import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { isTeamMember } from '@/lib/squads/access'
import { loadTeamStrength } from '@/lib/squads/team-strength'

// GET /api/teams/{id}/strength: the squad strength of a team (docs/SQUADS.md), for its members and platform admins. It reads reliability, so it is
// never shown to anyone outside the team.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })

  const exists = await prisma.team.findUnique({ where: { id }, select: { id: true } })
  if (!exists) return createApiError('TEAM_NOT_FOUND')
  if (!(await isTeamMember(prisma, user, id, { adminToo: true }))) return createApiError('FORBIDDEN')

  const strength = await loadTeamStrength(prisma, id)
  if (!strength) return createApiError('TEAM_NOT_FOUND')
  return createApiResponse(strength)
}, { cache: { maxAge: 30 }, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'teams:strength' } })
