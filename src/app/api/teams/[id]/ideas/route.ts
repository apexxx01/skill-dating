import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { isTeamMember } from '@/lib/squads/access'
import { ideaCreateSchema, SPACE_LIMITS } from '@/lib/squads/space'

// POST /api/teams/{id}/ideas: an idea on the squad's idea board. Members only; the board itself is part of GET /api/teams/{id}/space.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  if (!(await prisma.team.findUnique({ where: { id }, select: { id: true } }))) return createApiError('TEAM_NOT_FOUND')
  if (!(await isTeamMember(prisma, user, id))) return createApiError('FORBIDDEN')
  const body = await validateBody(ideaCreateSchema)(request)
  if (body instanceof Response) return body

  const idea = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${id} FOR UPDATE`
    if ((await tx.teamIdea.count({ where: { teamId: id } })) >= SPACE_LIMITS.ideas) return null
    return tx.teamIdea.create({ data: { teamId: id, authorId: user.id, title: body.data.title, description: body.data.description ?? null } })
  })
  if (!idea) return createApiError('TEAM_SPACE_LIMIT', { params: { max: SPACE_LIMITS.ideas, what: 'ideas' } })
  return createApiResponse(idea, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:idea-create' } })
