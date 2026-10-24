import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { track } from '@/lib/infra/analytics'
import { bodySchema } from './schema'

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })

  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const participant = await prisma.hackathonParticipant.findUnique({ where: { userId_hackathonId: { userId: user.id, hackathonId: id } } })
  if (!participant) return createApiError('HACKATHON_REGISTRATION_REQUIRED')

  const data = { ...body.data, ...(body.data.preferredRoles ? { preferredRoles: [...new Set(body.data.preferredRoles)] } : {}) }
  // Being open to an automatic squad means looking for one.
  if (data.openToAutoTeam === true) data.lookingForTeam = true
  if (data.lookingForTeam === false) data.openToAutoTeam = false
  const updated = await prisma.hackathonParticipant.update({ where: { id: participant.id }, data })

  if (updated.lookingForTeam && !participant.lookingForTeam) await track(user.id, 'solo_pool_joined', { hackathonId: id, auto: updated.openToAutoTeam })
  return createApiResponse({
    hackathonId: id,
    teamId: updated.teamId,
    status: updated.status,
    lookingForTeam: updated.lookingForTeam,
    preferredRoles: updated.preferredRoles,
    openToAutoTeam: updated.openToAutoTeam,
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'hackathons:participation' } })
