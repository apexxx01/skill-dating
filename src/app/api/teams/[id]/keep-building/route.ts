import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { canManageTeam } from '@/lib/squads/access'
import { keepBuilding } from '@/lib/squads/space'
import { bodySchema } from './schema'

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  if (!(await prisma.team.findUnique({ where: { id }, select: { id: true } }))) return createApiError('TEAM_NOT_FOUND')
  if (!(await canManageTeam(prisma, user, id))) return createApiError('FORBIDDEN')
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const result = await keepBuilding(prisma, { teamId: id, userId: user.id, projectName: body.data.projectName })
  if (!result.ok) {
    if (result.reason === 'NOT_A_HACKATHON_TEAM') return createApiError('NOT_A_HACKATHON_TEAM')
    if (result.reason === 'TOO_EARLY') return createApiError('KEEP_BUILDING_TOO_EARLY')
    return createApiError('KEEP_BUILDING_DONE')
  }
  return createApiResponse(result)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'teams:keep-building' } })
