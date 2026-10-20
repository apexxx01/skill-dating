import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { isTeamMember } from '@/lib/squads/access'
import { loadTeamSpace } from '@/lib/squads/space'

// GET /api/teams/{id}/space: a squad's private space, for its members (and platform admins): roles and pledges, the countdown to the lock, open
// slots, the checklist and the idea board (docs/SQUADS.md, "Team space").
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  if (!(await prisma.team.findUnique({ where: { id }, select: { id: true } }))) return createApiError('TEAM_NOT_FOUND')
  if (!(await isTeamMember(prisma, user, id, { adminToo: true }))) return createApiError('FORBIDDEN')
  return createApiResponse(await loadTeamSpace(prisma, id, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'teams:space' } })
