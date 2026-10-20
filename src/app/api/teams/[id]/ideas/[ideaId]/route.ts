import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { canManageTeam } from '@/lib/squads/access'

// DELETE /api/teams/{id}/ideas/{ideaId}: its author, or whoever runs the team, takes an idea off the board.
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const parts = new URL(request.url).pathname.split('/')
  const teamId = parts.slice(-3)[0]
  const ideaId = parts.slice(-1)[0]
  if (!teamId || !ideaId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId, ideaId' } })
  const idea = await prisma.teamIdea.findUnique({ where: { id: ideaId }, select: { teamId: true, authorId: true } })
  if (!idea || idea.teamId !== teamId) return createApiError('IDEA_NOT_FOUND')
  if (idea.authorId !== user.id && !(await canManageTeam(prisma, user, teamId))) return createApiError('FORBIDDEN')
  await prisma.teamIdea.delete({ where: { id: ideaId } })
  return createApiResponse({ deleted: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:idea-delete' } })
