import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { isTeamMember, teamRoleOf } from '@/lib/squads/access'
import { checklistUpdateSchema } from '@/lib/squads/space'

// One checklist item: any member edits, ticks, reassigns or deletes it.

function idsOf(request: NextRequest) {
  const parts = new URL(request.url).pathname.split('/')
  return { teamId: parts.slice(-3)[0], itemId: parts.slice(-1)[0] }
}

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const { teamId, itemId } = idsOf(request)
  if (!teamId || !itemId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId, itemId' } })
  const body = await validateBody(checklistUpdateSchema)(request)
  if (body instanceof Response) return body

  const item = await prisma.teamChecklistItem.findUnique({ where: { id: itemId }, select: { teamId: true, done: true } })
  if (!item || item.teamId !== teamId) return createApiError('CHECKLIST_ITEM_NOT_FOUND')
  if (!(await isTeamMember(prisma, user, teamId))) return createApiError('FORBIDDEN')
  if (body.data.assigneeId && !(await teamRoleOf(prisma, body.data.assigneeId, teamId))) {
    return createApiError('VALIDATION_FAILED', { details: { assigneeId: ['The assignee must be a member of the team'] } })
  }
  const doneAt = body.data.done === undefined || body.data.done === item.done ? {} : { doneAt: body.data.done ? new Date() : null }
  return createApiResponse(await prisma.teamChecklistItem.update({ where: { id: itemId }, data: { ...body.data, ...doneAt } }))
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'teams:checklist-update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const { teamId, itemId } = idsOf(request)
  if (!teamId || !itemId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId, itemId' } })
  const item = await prisma.teamChecklistItem.findUnique({ where: { id: itemId }, select: { teamId: true } })
  if (!item || item.teamId !== teamId) return createApiError('CHECKLIST_ITEM_NOT_FOUND')
  if (!(await isTeamMember(prisma, user, teamId))) return createApiError('FORBIDDEN')
  await prisma.teamChecklistItem.delete({ where: { id: itemId } })
  return createApiResponse({ deleted: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'teams:checklist-delete' } })
