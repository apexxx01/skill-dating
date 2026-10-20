import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { isTeamMember, teamRoleOf } from '@/lib/squads/access'
import { checklistCreateSchema, SPACE_LIMITS } from '@/lib/squads/space'

// POST /api/teams/{id}/checklist: a shared to-do for the squad, optionally assigned to a member. Members only.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  if (!(await prisma.team.findUnique({ where: { id }, select: { id: true } }))) return createApiError('TEAM_NOT_FOUND')
  if (!(await isTeamMember(prisma, user, id))) return createApiError('FORBIDDEN')

  const body = await validateBody(checklistCreateSchema)(request)
  if (body instanceof Response) return body
  if (body.data.assigneeId && !(await teamRoleOf(prisma, body.data.assigneeId, id))) {
    return createApiError('VALIDATION_FAILED', { details: { assigneeId: ['The assignee must be a member of the team'] } })
  }

  const item = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${id} FOR UPDATE`
    const count = await tx.teamChecklistItem.count({ where: { teamId: id } })
    if (count >= SPACE_LIMITS.checklistItems) return null
    return tx.teamChecklistItem.create({ data: { teamId: id, title: body.data.title, assigneeId: body.data.assigneeId ?? null, createdById: user.id, position: count } })
  })
  if (!item) return createApiError('TEAM_SPACE_LIMIT', { params: { max: SPACE_LIMITS.checklistItems, what: 'checklist items' } })
  return createApiResponse(item, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'teams:checklist-create' } })
