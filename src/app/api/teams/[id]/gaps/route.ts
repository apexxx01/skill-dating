import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { loadTeamGaps } from '@/lib/matching/team-gaps'

// What a team is missing and who could fill it: its declared needs and its project's stack set against what the members can do, and the five best
// candidates by the matching engine's pool and score. Only the team's owner or an admin of the team (or a platform admin) may ask: it surfaces
// people, so it is for those who can invite them. Inviting reuses POST /api/teams/{id}/invitations.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })

  const team = await prisma.team.findUnique({ where: { id }, select: { id: true } })
  if (!team) return createApiError('TEAM_NOT_FOUND')

  if (user.role !== 'ADMIN') {
    const membership = await prisma.teamMember.findUnique({ where: { userId_teamId: { userId: user.id, teamId: id } }, select: { role: true } })
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) return createApiError('FORBIDDEN')
  }

  const gaps = await loadTeamGaps(prisma, id, user.id)
  if (!gaps) return createApiError('TEAM_NOT_FOUND')
  return createApiResponse(gaps)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:gaps' } })
